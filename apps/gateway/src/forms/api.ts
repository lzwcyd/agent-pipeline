import { randomUUID } from "node:crypto";
import type { FormSubmission } from "../types.js";
import { extractPolicy, FormParseError, type FormSource } from "./types.js";

/**
 * 标准接口触发器：`POST /api/pipelines`。
 * 直接提交需求，不经过任何平台。负载为标准结构：
 *
 * ```json
 * {
 *   "title": "需求标题",
 *   "description": "需求描述",
 *   "submitter": "提交人",
 *   "priority": "P1",
 *   "fields": { "自定义字段": "值" },
 *   "policy": { "acceptanceFailure": "rework", "autoAccept": false, "maxRework": 5 }
 * }
 * ```
 */
export interface ApiTriggerInput {
  title?: string;
  description?: string;
  submitter?: string;
  submitterId?: string;
  priority?: string;
  /** 使用的流程模板名（简写，等价于 policy.template） */
  template?: string;
  fields?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  sourceFormId?: string;
}

export class ApiTriggerSource implements FormSource {
  readonly kind = "api" as const;

  isConfigured(): boolean {
    return true;
  }

  parse(raw: unknown): FormSubmission {
    const input = raw as Partial<ApiTriggerInput>;
    if (!input || typeof input !== "object") throw new FormParseError("API 触发负载必须是对象");
    const title = input.title?.trim();
    if (!title) throw new FormParseError("API 触发负载缺少 title");
    const fields = input.fields ?? {};
    let policy = extractPolicy({ ...fields, ...(input.policy ? { _policy: input.policy } : {}) });
    if (input.template) {
      policy = { ...policy, template: input.template };
    }
    const priority = typeof input.priority === "string" ? input.priority : undefined;
    return {
      source: "api",
      sourceFormId: input.sourceFormId ?? "http-api",
      submissionId: randomUUID(),
      submitter: input.submitter?.trim() || "API 调用方",
      submitterId: input.submitterId,
      title,
      description: input.description?.trim() ?? "",
      priority,
      fields,
      submittedAt: new Date().toISOString(),
      meta: { triggerType: "api", detail: "http-api" },
      policy,
      raw,
    };
  }
}
