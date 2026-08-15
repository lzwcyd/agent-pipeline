import { createDecipheriv, createHash } from "node:crypto";
import type { FormSubmission } from "../types.js";
import { extractPolicy, FormParseError, type FormSource } from "./types.js";

/**
 * 飞书（Lark）事件订阅适配器。
 *
 * 支持的接入形态（二选一）：
 * 1. 加密模式：配置 FEISHU_ENCRYPT_KEY，请求体为 { encrypt }，验签用
 *    X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature。
 * 2. 明文模式：配置 FEISHU_VERIFICATION_TOKEN，校验 header.token。
 *
 * 表单事件归一化（启发式 + 可扩展）：优先支持多维表格记录创建
 * （app.table.record.created），并尝试从任意 event 中提取
 * title/description/submitter 字段（见 DEFAULT_FIELD_KEYS）。
 */

const DEFAULT_FIELD_KEYS = {
  title: ["title", "标题", "需求", "name", "事项", "任务"],
  description: ["description", "desc", "描述", "详情", "说明", "内容", "body"],
  submitter: ["submitter", "提交人", "creator", "创建人", "user_name", "username", "发起人"],
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
    for (const inner of ["text", "value", "name", "title", "content"]) {
      if (typeof asRecord[inner] === "string") return asRecord[inner] as string;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

export class FeishuFormSource implements FormSource {
  readonly kind = "feishu" as const;

  constructor(
    private readonly opts: {
      encryptKey?: string;
      verificationToken?: string;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.opts.encryptKey || this.opts.verificationToken);
  }

  /** 验证并解密原始请求，返回内部事件负载 */
  verifyAndDecrypt(headers: Record<string, string | string[] | undefined>, rawBody: string): unknown {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    // URL 验证
    if (body.challenge !== undefined && body.token !== undefined) {
      if (this.opts.verificationToken && body.token !== this.opts.verificationToken) {
        throw new FormParseError("飞书 URL 验证 token 不匹配");
      }
      return body;
    }

    if (this.opts.encryptKey) {
      const h = (k: string) => {
        const v = headers[k];
        return Array.isArray(v) ? v[0] : v;
      };
      const timestamp = h("x-lark-request-timestamp");
      const nonce = h("x-lark-request-nonce");
      const signature = h("x-lark-signature");
      if (!timestamp || !nonce || !signature) {
        throw new FormParseError("飞书加密模式缺少验签请求头");
      }
      const expected = createHash("sha256")
        .update(`${timestamp}${nonce}${this.opts.encryptKey}${rawBody}`)
        .digest("base64");
      if (expected !== signature) throw new FormParseError("飞书签名校验失败");
      const encrypted = body.encrypt;
      if (typeof encrypted !== "string") throw new FormParseError("飞书请求缺少 encrypt 字段");
      return JSON.parse(decryptAesCbc(this.opts.encryptKey, encrypted)) as unknown;
    }

    // 明文模式
    if (this.opts.verificationToken) {
      const token = body.header && typeof body.header === "object"
        ? (body.header as Record<string, unknown>).token
        : undefined;
      if (typeof token === "string" && token !== this.opts.verificationToken) {
        throw new FormParseError("飞书事件 token 不匹配");
      }
    }
    return body;
  }

  parse(raw: unknown): FormSubmission {
    const body = raw as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new FormParseError("飞书负载必须是对象");
    // URL 验证请求不是表单事件
    if (body.challenge !== undefined) throw new FormParseError("飞书 URL 验证请求，非表单提交");

    const header = (body.header ?? {}) as Record<string, unknown>;
    const eventType = String(header.event_type ?? body.event_type ?? "");
    const event = (body.event ?? {}) as Record<string, unknown>;
    const fields = extractFields(event);

    const title = pick(fields, DEFAULT_FIELD_KEYS.title) || `飞书表单提交 ${header.event_id ?? "?"}`;
    const description = pick(fields, DEFAULT_FIELD_KEYS.description);
    const submitter = pick(fields, DEFAULT_FIELD_KEYS.submitter) || String(fields.user_id ?? event.operator_id ?? "飞书用户");

    return {
      source: "feishu",
      sourceFormId: String(event.table_id ?? fields.table_id ?? fields.form_id ?? header.app_id ?? "feishu-form"),
      submissionId: String(event.record_id ?? fields.record_id ?? header.event_id ?? Math.random().toString(36).slice(2)),
      submitter,
      submitterId: String(fields.user_id ?? event.operator_id ?? "") || undefined,
      title,
      description,
      fields,
      submittedAt: String(header.create_time ?? new Date().toISOString()),
      meta: { triggerType: "form", detail: eventType },
      policy: extractPolicy(fields),
      raw,
    };
  }
}

/** 从事件负载中提取字段表（多维表格 fields / 表单 formValues / 原样兜底） */
function extractFields(event: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["fields", "formValues", "formData", "form_value", "answers", "data"]) {
    const v = event[key];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (v && typeof v === "object" && Array.isArray(v)) {
      // 可能是 [{label, value}, ...]
      const out: Record<string, unknown> = {};
      for (const item of v as unknown[]) {
        const it = item as Record<string, unknown>;
        if (it && typeof it === "object") {
          const label = it.label ?? it.key ?? it.name ?? it.title;
          if (label !== undefined) out[String(label)] = it.value ?? it.content ?? "";
        }
      }
      if (Object.keys(out).length > 0) return out;
    }
  }
  return { ...event };
}

/** AES-256-CBC 解密（encrypt_key 的 base64 解码后取前 16 字节作 IV，PKCS7） */
function decryptAesCbc(encryptKey: string, encryptedBase64: string): string {
  const key = Buffer.from(encryptKey, "base64");
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const buf = Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()]);
  return buf.toString("utf8");
}

export { decryptAesCbc };
