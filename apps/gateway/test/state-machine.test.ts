import { describe, expect, it } from "vitest";
import { canTransition, ev, transition, type StageKey } from "../src/pipeline/state-machine.js";
import type { Pipeline } from "../src/types.js";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "submitted",
    submission: {
      source: "mock",
      sourceFormId: "f",
      submissionId: "s",
      submitter: "tester",
      title: "t",
      description: "d",
      fields: {},
      submittedAt: new Date().toISOString(),
      raw: {},
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    agents: {},
    artifacts: [],
    ...over,
  };
}

describe("状态机", () => {
  it("完整合法链路：submitted → evaluating → dev → testing → deploy → acceptance → prod → done", () => {
    const chain: StageKey[] = [
      "evaluating",
      "dev_in_progress",
      "testing",
      "test_deploying",
      "awaiting_acceptance",
      "prod_deploying",
    ];
    let p = makePipeline();
    for (const stage of chain) {
      expect(canTransition(p.status, stage)).toBe(true);
      p = transition(p, stage, ev("stage_started", { stage }));
    }
    expect(canTransition(p.status, "done")).toBe(true);
  });

  it("打回链路：testing → dev_in_progress、awaiting_acceptance → dev_in_progress / test_rollback → dev_in_progress", () => {
    const p = makePipeline({ status: "testing" });
    expect(canTransition("testing", "dev_in_progress")).toBe(true);
    const reworked = transition(p, "dev_in_progress", ev("rework", { from: "testing", reason: "用例失败" }));
    expect(reworked.status).toBe("dev_in_progress");

    const acc = makePipeline({ status: "awaiting_acceptance" });
    // policy=rework：直接打回开发
    expect(canTransition("awaiting_acceptance", "dev_in_progress")).toBe(true);
    // policy=rollback：先进回滚
    expect(canTransition("awaiting_acceptance", "test_rollback")).toBe(true);
    const rolling = transition(acc, "test_rollback", ev("stage_failed", { stage: "awaiting_acceptance", message: "验收未通过" }));
    expect(rolling.status).toBe("test_rollback");
    expect(canTransition("test_rollback", "dev_in_progress")).toBe(true);
  });

  it("拒绝非法迁移", () => {
    const p = makePipeline();
    expect(() => transition(p, "done", ev("done"))).toThrow(/非法状态迁移/);
  });

  it("终态不可再迁移", () => {
    const p = makePipeline({ status: "done" });
    for (const to of ["evaluating", "failed", "rejected", "testing"] as const) {
      expect(canTransition(p.status, to)).toBe(false);
    }
  });
});
