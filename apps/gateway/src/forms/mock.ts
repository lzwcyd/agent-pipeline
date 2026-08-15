import { randomUUID } from "node:crypto";
import type { FormSubmission } from "../types.js";
import { extractPolicy, FormParseError, type FormSource } from "./types.js";

export interface MockSubmissionInput {
  sourceFormId?: string;
  submitter?: string;
  submitterId?: string;
  title: string;
  description: string;
  fields?: Record<string, unknown>;
  submittedAt?: string;
  policy?: Record<string, unknown>;
}

/** 模拟表单源：用于开发、演示与测试，payload 直接映射 */
export class MockFormSource implements FormSource {
  readonly kind = "mock" as const;

  isConfigured(): boolean {
    return true;
  }

  parse(raw: unknown): FormSubmission {
    const input = raw as Partial<MockSubmissionInput>;
    if (!input || typeof input !== "object") throw new FormParseError("mock payload 必须是对象");
    const title = input.title?.trim();
    const description = input.description?.trim();
    if (!title) throw new FormParseError("mock payload 缺少 title");
    const fields = input.fields ?? {};
    // 兼容顶层 policy 与字段内 _policy 两种写法
    const policy = extractPolicy({ ...fields, ...(input.policy ? { _policy: input.policy } : {}) });
    return {
      source: "mock",
      sourceFormId: input.sourceFormId ?? "mock-form-demo",
      submissionId: randomUUID(),
      submitter: input.submitter ?? "模拟提交人",
      submitterId: input.submitterId,
      title,
      description: description ?? "",
      fields,
      submittedAt: input.submittedAt ?? new Date().toISOString(),
      meta: { triggerType: "form", detail: "mock" },
      policy,
      raw,
    };
  }
}
