export type AgentRuntime = "opencode" | "codex";

export interface AgentRequestUsage {
  runtime: AgentRuntime;
  sessionId?: string;
  model: string;
  /** 不含缓存读取的输入 Token */
  inputTokens: number;
  /** 不含推理的输出 Token */
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider 明确返回的美元费用；缺失表示未知 */
  costUsd?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  requestCount: number;
  sessionIds: string[];
  models: string[];
  /** 至少一个 Provider 返回费用时为合计，否则为 null */
  costUsd: number | null;
}

export const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheHitRate: 0,
  requestCount: 0,
  sessionIds: [],
  models: [],
  costUsd: null,
};

type UsageSource = AgentUsage | AgentRequestUsage | undefined;

function count(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function identifiers(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** 合并请求或既有汇总；命中率始终从合计 Token 重算。 */
export function mergeUsage(...sources: UsageSource[]): AgentUsage {
  const merged: AgentUsage = structuredClone(EMPTY_USAGE);
  let hasReportedCost = false;

  for (const source of sources) {
    if (!source) continue;
    merged.inputTokens += count(source.inputTokens);
    merged.outputTokens += count(source.outputTokens);
    merged.reasoningTokens += count(source.reasoningTokens);
    merged.cacheReadTokens += count(source.cacheReadTokens);
    merged.cacheWriteTokens += count(source.cacheWriteTokens);

    if ("requestCount" in source) {
      merged.requestCount += count(source.requestCount);
      merged.sessionIds.push(...identifiers(source.sessionIds));
      merged.models.push(...identifiers(source.models));
      if (source.costUsd !== null && Number.isFinite(source.costUsd)) {
        hasReportedCost = true;
        merged.costUsd = (merged.costUsd ?? 0) + source.costUsd;
      }
    } else {
      merged.requestCount += 1;
      if (source.sessionId) merged.sessionIds.push(source.sessionId);
      if (source.model) merged.models.push(source.model);
      if (source.costUsd !== undefined && Number.isFinite(source.costUsd)) {
        hasReportedCost = true;
        merged.costUsd = (merged.costUsd ?? 0) + source.costUsd;
      }
    }
  }

  merged.sessionIds = [...new Set(merged.sessionIds)];
  merged.models = [...new Set(merged.models)];
  const cacheableInput = merged.inputTokens + merged.cacheReadTokens;
  merged.cacheHitRate = cacheableInput > 0 ? merged.cacheReadTokens / cacheableInput : 0;
  if (!hasReportedCost) merged.costUsd = null;
  return merged;
}
