import { createHmac } from "node:crypto";
import type { FormSubmission } from "../types.js";
import { extractPolicy, FormParseError, type FormSource } from "./types.js";

/**
 * 钉钉适配器。
 *
 * 支持的接入形态：
 * 1. 企业应用事件订阅/机器人回调：请求头带 timestamp + sign，
 *    sign = base64(HMAC-SHA256(timestamp + "\n" + appSecret, appSecret))。
 * 2. 智能填表/宜搭表单提交（formValues / formData / fields 字段）。
 *
 * 归一化采用启发式字段映射（见 DEFAULT_FIELD_KEYS），
 * 真实接入时按自家收集单字段调整即可。
 */

const DEFAULT_FIELD_KEYS = {
  title: ["title", "标题", "需求", "name", "事项", "任务", "topic"],
  description: ["description", "desc", "描述", "详情", "说明", "内容", "body", "remark"],
  submitter: ["submitter", "提交人", "creator", "创建人", "user_name", "username", "发起人", "staffId"],
};

function pick(obj: Record<string, unknown>, keys: string[]): string {
  // 1) 精确匹配
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== "") {
      return stringify(v);
    }
  }
  // 2) 子串匹配（字段标签如“需求标题”命中键“标题/需求”）
  for (const key of keys) {
    for (const [label, v] of Object.entries(obj)) {
      if (v !== undefined && v !== null && v !== "" && label.includes(key)) {
        return stringify(v);
      }
    }
  }
  return "";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (Array.isArray(v)) return v.map(stringify).join(", ");
    const asRecord = v as Record<string, unknown>;
    for (const inner of ["text", "value", "name", "title", "content", "label"]) {
      if (typeof asRecord[inner] === "string") return asRecord[inner] as string;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

export class DingTalkFormSource implements FormSource {
  readonly kind = "dingtalk" as const;

  constructor(
    private readonly opts: {
      appKey?: string;
      appSecret?: string;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.opts.appSecret);
  }

  /** 校验钉钉签名，返回解析后的负载 */
  verify(headers: Record<string, string | string[] | undefined>, rawBody: string): unknown {
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const timestamp = h("timestamp");
    const sign = h("sign");
    if (!timestamp || !sign) throw new FormParseError("钉钉请求缺少 timestamp/sign");
    if (!this.opts.appSecret) throw new FormParseError("未配置 DINGTALK_APP_SECRET，无法验签");
    const expected = createHmac("sha256", this.opts.appSecret)
      .update(`${timestamp}\n${this.opts.appSecret}`)
      .digest("base64");
    if (expected !== sign) throw new FormParseError("钉钉签名校验失败");
    return JSON.parse(rawBody) as unknown;
  }

  parse(raw: unknown): FormSubmission {
    const body = raw as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new FormParseError("钉钉负载必须是对象");

    // 群机器人文本消息：text.content
    const text = body.text as Record<string, unknown> | undefined;
    const content = typeof text?.content === "string" ? (text.content as string) : "";

    const fields = extractFields(body);
    const title = pick(fields, DEFAULT_FIELD_KEYS.title) || pick({ content }, ["content"]) || "钉钉表单提交";
    const description = pick(fields, DEFAULT_FIELD_KEYS.description) || content;
    const submitter =
      pick(fields, DEFAULT_FIELD_KEYS.submitter) ||
      String(fields.staffId ?? body.staffId ?? fields.userid ?? body.userid ?? fields.openId ?? body.openId ?? "钉钉用户");

    return {
      source: "dingtalk",
      sourceFormId: String(
        fields.formId ?? body.formId ?? fields.form_id ?? body.form_id ?? fields.formInstanceId ?? body.formInstanceId ?? body.EventType ?? "dingtalk-form",
      ),
      submissionId: String(
        fields.formInstanceId ?? body.formInstanceId ?? fields.instanceId ?? body.instanceId ?? fields.msgId ?? body.msgId ?? Math.random().toString(36).slice(2),
      ),
      submitter,
      submitterId: String(fields.staffId ?? fields.userid ?? "") || undefined,
      title,
      description,
      fields,
      submittedAt: String(fields.createTime ?? fields.create_time ?? new Date().toISOString()),
      meta: { triggerType: "form", detail: String(body.EventType ?? "dingtalk") },
      policy: extractPolicy(fields),
      raw,
    };
  }
}

function extractFields(body: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["formValues", "formData", "form_value", "fields", "data", "formComponentValues"]) {
    const v = body[key];
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        const out: Record<string, unknown> = {};
        for (const item of v as unknown[]) {
          const it = item as Record<string, unknown>;
          if (it && typeof it === "object") {
            const label = it.label ?? it.name ?? it.key ?? it.title;
            if (label !== undefined) out[String(label)] = it.value ?? it.content ?? "";
          }
        }
        if (Object.keys(out).length > 0) return out;
      } else {
        return v as Record<string, unknown>;
      }
    }
  }
  return { ...body };
}
