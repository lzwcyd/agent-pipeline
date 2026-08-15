import type { FormSubmission, FormSourceKind, SubmissionPolicy } from "../types.js";

/** 表单/触发源接口：把“平台事件”归一化为标准 FormSubmission */
export interface FormSource {
  readonly kind: string;
  /** 该源是否已配置可用 */
  isConfigured(): boolean;
  /** 解析平台 webhook/事件负载；无法识别时抛 FormParseError */
  parse(raw: unknown): FormSubmission;
  /** （可选）平台专用：验签/解密原始请求，返回内部负载 */
  verifyAndDecrypt?(headers: Record<string, string | string[] | undefined>, rawBody: string): unknown;
  /** （可选）平台专用：仅验签 */
  verify?(headers: Record<string, string | string[] | undefined>, rawBody: string): unknown;
}

export class FormParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormParseError";
  }
}

/** 平台名称（用于展示） */
export const SOURCE_LABEL: Record<string, string> = {
  mock: "模拟表单",
  feishu: "飞书收集单",
  dingtalk: "钉钉收集单",
  api: "标准接口",
  cli: "命令行",
};

/**
 * 从 fields 的 `_policy` 键提取触发级流水线策略。
 * 表单字段里可写：{"_policy": {"acceptanceFailure": "rework", "autoAccept": true, "maxRework": 5}}
 */
export function extractPolicy(fields: Record<string, unknown>): SubmissionPolicy | undefined {
  const raw = fields["_policy"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const out: SubmissionPolicy = {};
  if (p.acceptanceFailure === "rollback" || p.acceptanceFailure === "rework" || p.acceptanceFailure === "reject") {
    out.acceptanceFailure = p.acceptanceFailure;
  }
  if (typeof p.autoAccept === "boolean") out.autoAccept = p.autoAccept;
  if (typeof p.maxRework === "number" && Number.isFinite(p.maxRework) && p.maxRework > 0) {
    out.maxRework = Math.floor(p.maxRework as number);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type { FormSubmission, FormSourceKind, SubmissionPolicy };
