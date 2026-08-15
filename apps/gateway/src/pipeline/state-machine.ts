import type { Pipeline, PipelineEvent, PipelineStatus, StageKey } from "../types.js";

/** 合法状态迁移表：from -> to[] */
export const TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
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

/** 阶段在“进行中”时的状态名（用于 stage_started 事件） */
export function stageToStatus(stage: StageKey): PipelineStatus {
  return stage;
}

export function isTerminal(status: PipelineStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: PipelineStatus, to: PipelineStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 迁移校验；非法迁移抛错 */
export function transition(pipeline: Pipeline, to: PipelineStatus, event: PipelineEvent): Pipeline {
  if (!canTransition(pipeline.status, to)) {
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

/** 从 failed 状态重试：回到失败阶段的进行中状态 */
export function retryTarget(failedStage: string): StageKey {
  const stage = failedStage as StageKey;
  // 若失败阶段本身合法，直接回到该阶段
  return stage;
}
