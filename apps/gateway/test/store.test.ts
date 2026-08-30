import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeUsage } from "../src/agents/usage.js";
import { PipelineStore } from "../src/pipeline/store.js";
import type { FormSubmission, Pipeline } from "../src/types.js";

const submission: FormSubmission = {
  source: "mock",
  sourceFormId: "legacy",
  submissionId: "legacy-1",
  submitter: "test",
  title: "legacy snapshot",
  description: "",
  fields: {},
  submittedAt: new Date().toISOString(),
  meta: { triggerType: "form" },
  raw: {},
};

describe("PipelineStore usage normalization", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("hydrates old snapshots without usage fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-store-"));
    dirs.push(dir);
    const store = new PipelineStore(dir);
    const created = store.create(submission);
    const legacy = { ...created, usage: undefined } as unknown as Pipeline;
    writeFileSync(join(dir, `${created.id}.json`), JSON.stringify(legacy), "utf8");

    expect(store.get(created.id)?.usage).toMatchObject({ requestCount: 0, costUsd: null });
  });

  it("derives saved pipeline usage from execution history", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-store-"));
    dirs.push(dir);
    const store = new PipelineStore(dir);
    const pipeline = store.create(submission);
    const now = new Date().toISOString();
    pipeline.executions.push({
      stage: "evaluating",
      round: 1,
      status: "ok",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      usage: mergeUsage({
        runtime: "opencode",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 1,
        cacheReadTokens: 20,
        cacheWriteTokens: 2,
      }),
    });
    store.save(pipeline);

    expect(store.get(pipeline.id)?.usage).toMatchObject({ requestCount: 1, inputTokens: 10 });
  });
});
