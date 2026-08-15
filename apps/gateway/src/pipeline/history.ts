import type { Pipeline } from "../types.js";

/**
 * 流水线历史/状态视图。
 * - 当前状态：status / acceptancePending / failure / deploy…
 * - 历史执行：executions（每次阶段执行，含打回轮次）+ events（事件流）
 * - 统计：各阶段执行次数/失败次数/最近结果/累计耗时
 */
export function buildHistory(p: Pipeline) {
  const stageStats: Record<string, { runs: number; failures: number; lastResult: string; totalDurationMs: number }> = {};
  for (const ex of p.executions) {
    const s = (stageStats[ex.stage] ??= { runs: 0, failures: 0, lastResult: "", totalDurationMs: 0 });
    s.runs += 1;
    s.totalDurationMs += ex.durationMs;
    s.lastResult = ex.status;
    if (ex.status === "error") s.failures += 1;
  }
  return {
    id: p.id,
    status: p.status,
    template: p.templateName,
    trigger: {
      type: p.submission.meta.triggerType,
      source: p.submission.source,
      detail: p.submission.meta.detail,
      submittedAt: p.submission.submittedAt,
      submitter: p.submission.submitter,
    },
    policy: p.submission.policy ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    summary: {
      title: p.submission.title,
      source: p.submission.source,
      priority: p.submission.priority,
      evaluation: p.evaluation,
      acceptance: p.acceptance,
      acceptancePending: p.acceptancePending ?? false,
      deploy: p.deploy,
      failure: p.failure,
      reworkCount: p.reworkCount ?? 0,
    },
    executions: p.executions,
    events: p.events,
    artifacts: p.artifacts,
    stats: {
      totalExecutions: p.executions.length,
      reworkCount: p.reworkCount ?? 0,
      stages: stageStats,
    },
  };
}
