import type { Pipeline, PipelineEvent, PipelineStatus } from "../types.js";

/**
 * 内置阶段迁移表：from -> to[]。
 * 自定义阶段（流程模板新增）不在此表中，由模板声明的
 * onSuccess / reworkTarget 提供合法流转（见 transition 的 allowed 参数）。
 */
export const TRANSITIONS: Record<string, PipelineStatus[]> = {
  submitted: ["evaluating"],
  evaluating: ["dev_in_progress", "rejected", "failed"],
  dev_in_progress: ["testing", "failed"],
  testing: ["test_deploying", "dev_in_progress", "failed"],
  test_deploying: ["awaiting_acceptance", "failed"],
  awaiting_acceptance: ["prod_deploying", "test_rollback", "dev_in_progress", "failed"],
  test_rollback: ["dev_in_progress", "failed"],
  prod_deploying: ["done", "failed"],
  // 终态
  rejected: [],
  failed: [],
  done: [],
};

export const TERMINAL_STATUSES: PipelineStatus[] = ["rejected", "failed", "done"];

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as PipelineStatus);
}

export function canTransition(from: string, to: string, allowed?: readonly string[]): boolean {
  const targets = allowed ?? TRANSITIONS[from] ?? [];
  return targets.includes(to as PipelineStatus);
}

/**
 * 迁移校验；非法迁移抛错。
 * @param allowed 自定义阶段的合法目标列表（来自流程模板）；缺省使用内置迁移表
 */
export function transition(pipeline: Pipeline, to: string, event: PipelineEvent, allowed?: readonly string[]): Pipeline {
  if (!canTransition(pipeline.status, to, allowed)) {
    throw new Error(
      `非法状态迁移：${pipeline.status} -> ${to}（流水线 ${pipeline.id}）`,
    );
  }
  return {
    ...pipeline,
    status: to,
    updatedAt: new Date().toISOString(),
    events: [...pipeline.events, event],
  };
}

/** 简单工厂：创建各事件 */
export function ev(type: PipelineEvent["type"], extra: Partial<PipelineEvent> = {}): PipelineEvent {
  return { type, at: new Date().toISOString(), ...extra } as PipelineEvent;
}
