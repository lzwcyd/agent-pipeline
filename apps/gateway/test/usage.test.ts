import { describe, expect, it } from "vitest";
import { EMPTY_USAGE, mergeUsage } from "../src/agents/usage.js";

describe("mergeUsage", () => {
  it("sums every request and recomputes the aggregate cache hit rate", () => {
    const usage = mergeUsage(
      {
        runtime: "opencode",
        sessionId: "session-1",
        model: "provider/model",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 300,
        cacheWriteTokens: 10,
        costUsd: 0.01,
      },
      {
        runtime: "opencode",
        sessionId: "session-1",
        model: "provider/model",
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.02,
      },
    );

    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
      cacheHitRate: 0.6,
      requestCount: 2,
      sessionIds: ["session-1"],
      models: ["provider/model"],
      costUsd: 0.03,
    });
  });

  it("keeps provider cost unknown until at least one request reports it", () => {
    const unknown = mergeUsage({
      runtime: "codex",
      model: "unknown",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const reportedZero = mergeUsage(unknown, {
      runtime: "opencode",
      model: "free-model",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });

    expect(unknown.costUsd).toBeNull();
    expect(reportedZero.costUsd).toBe(0);
  });

  it("does not mutate the reusable empty usage value", () => {
    mergeUsage(EMPTY_USAGE, {
      runtime: "codex",
      sessionId: "thread-1",
      model: "gpt-5",
      inputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 2,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    });

    expect(EMPTY_USAGE).toEqual({
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
    });
  });
});
