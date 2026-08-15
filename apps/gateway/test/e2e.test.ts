import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DshRunner } from "../src/agents/dsh-runner.js";
import { PipelineStore } from "../src/pipeline/store.js";
import { Orchestrator } from "../src/pipeline/orchestrator.js";
import { CompositeNotifier } from "../src/notify/notifier.js";
import type { EnvConfig } from "../src/config.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MOCK_DSH = join(REPO_ROOT, "scripts", "mock-dsh.mjs");

interface Harness {
  cfg: EnvConfig;
  store: PipelineStore;
  orchestrator: Orchestrator;
  cleanup: () => void;
}

function makeHarness(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-e2e-"));
  const prev = { ...process.env };
  Object.assign(process.env, {
    DSH_CLI: MOCK_DSH,
    DSH_AGENT_TIMEOUT_MS: "60000",
    AUTO_ACCEPT: "true",
    MAX_REWORK: "3",
    PIPELINE_DATA_DIR: dir,
    NOTIFY_CHANNELS: "console",
    ...env,
  });
  const cfg = loadConfig();
  const store = new PipelineStore(cfg.pipelinesDir);
  const notifier = new CompositeNotifier(cfg);
  const runner = new DshRunner({ cli: cfg.DSH_CLI, timeoutMs: cfg.DSH_AGENT_TIMEOUT_MS });
  const orchestrator = new Orchestrator({ cfg, store, runner, notifier });
  return {
    cfg,
    store,
    orchestrator,
    cleanup: () => {
      process.env = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sampleSubmission = {
  source: "mock" as const,
  sourceFormId: "form-demo",
  submissionId: "sub-1",
  submitter: "产品-张三",
  title: "报表导出功能",
  description: "管理后台增加报表导出，支持 CSV/Excel，上限 10 万行。",
  fields: { 优先级: "P1" },
  submittedAt: new Date().toISOString(),
  meta: { triggerType: "form" as const, detail: "mock" },
  raw: {},
};

describe("端到端：完整流水线（mock DSH runner）", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it("全链路成功：submitted → …（含独立测试阶段）→ done，且记录历史执行", async () => {
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("done");
    expect(p.evaluation?.approved).toBe(true);
    // 测试 Agent 阶段存在且通过
    expect(p.agents.testing?.output?.status).toBe("pass");
    expect(p.agents.testing?.output?.testCases).toBeTruthy();
    expect(p.acceptance?.accepted).toBe(true);
    expect(p.deploy?.test?.namespace).toBe("demo-test");
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
    // 开发 agent 产物文件被记录
    const devFiles = p.artifacts.filter((a) => a.stage === "dev_in_progress");
    expect(devFiles.some((f) => f.path.endsWith("dev-plan.md"))).toBe(true);
    // 事件序列
    const types = p.events.map((e) => e.type);
    expect(types).toContain("stage_started");
    expect(types).toContain("stage_succeeded");
    expect(types).toContain("done");
    expect(types).not.toContain("rework");
    expect(p.events[0]?.type).toBe("submitted");
    // 历史执行：6 个阶段各 1 次，全部 ok
    expect(p.executions).toHaveLength(6);
    expect(p.executions.every((e) => e.status === "ok")).toBe(true);
    const stages = p.executions.map((e) => e.stage);
    expect(stages).toEqual(["evaluating", "dev_in_progress", "testing", "test_deploying", "awaiting_acceptance", "prod_deploying"]);
  });

  it("历史查询：buildHistory 提供状态/执行/事件/统计", async () => {
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    const { buildHistory } = await import("../src/pipeline/history.js");
    const hist = buildHistory(p);
    expect(hist.status).toBe("done");
    expect(hist.trigger.type).toBe("form");
    expect(hist.executions.length).toBe(6);
    expect(hist.events.length).toBeGreaterThan(0);
    expect(hist.stats.stages.evaluating?.runs).toBe(1);
    expect(hist.stats.totalExecutions).toBe(6);
    expect(hist.summary.reworkCount).toBe(0);
  });

  it("评估不通过：rejected 终态", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_REJECT: "1" });
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("rejected");
    expect(p.evaluation?.approved).toBe(false);
  });

  it("测试不通过 → 打回开发 → 修复后再测通过 → done（历史含多轮执行）", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_TEST_FAIL_ONCE: "1" });
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("done");
    expect(p.reworkCount).toBe(1);
    expect(p.events.some((e) => e.type === "rework" && e.from === "testing")).toBe(true);
    // 打回后重新开发，最终测试通过
    expect(p.agents.testing?.output?.status).toBe("pass");
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
    // 历史执行：testing 执行了 2 次（round 1 fail + round 2 pass），dev 也是 2 次
    const testingRuns = p.executions.filter((e) => e.stage === "testing");
    expect(testingRuns).toHaveLength(2);
    expect(testingRuns.map((e) => e.round)).toEqual([1, 2]);
    expect(testingRuns[0]?.output?.status).toBe("fail");
    expect(testingRuns[1]?.output?.status).toBe("pass");
  });

  it("验收失败（触发级 policy=rework）：不回滚，直接打回开发", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_ACCEPT_REJECT_ONCE: "1" });
    const withPolicy = { ...sampleSubmission, policy: { acceptanceFailure: "rework" as const } };
    const p = await h.orchestrator.handleSubmission(withPolicy);
    expect(p.status).toBe("done");
    expect(p.reworkCount).toBe(1);
    // 未触发回滚：无 test_rollback 执行
    expect(p.executions.some((e) => e.stage === "test_rollback")).toBe(false);
    expect(p.agents.test_rollback).toBeUndefined();
    expect(p.events.some((e) => e.type === "rework" && e.from === "awaiting_acceptance")).toBe(true);
    expect(p.acceptance?.accepted).toBe(true);
  });

  it("验收失败（触发级 policy=reject）：直接终止", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_ACCEPT_REJECT: "1" });
    const withPolicy = { ...sampleSubmission, policy: { acceptanceFailure: "reject" as const } };
    const p = await h.orchestrator.handleSubmission(withPolicy);
    expect(p.status).toBe("failed");
    expect(p.failure?.stage).toBe("awaiting_acceptance");
    expect(p.executions.some((e) => e.stage === "test_rollback")).toBe(false);
    expect(p.reworkCount ?? 0).toBe(0);
  });

  it("验收失败（触发级 policy 覆盖 env）：policy=rollback 覆盖 env=reject", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_ACCEPT_REJECT_ONCE: "1", ACCEPTANCE_FAILURE_POLICY: "reject" });
    const withPolicy = { ...sampleSubmission, policy: { acceptanceFailure: "rollback" as const } };
    const p = await h.orchestrator.handleSubmission(withPolicy);
    expect(p.status).toBe("done");
    expect(p.reworkCount).toBe(1);
    // 回滚阶段执行过（stage_succeeded test_rollback）且回滚证据记录在案
    const rollbackAgent = p.agents.test_rollback;
    expect(rollbackAgent?.output?.deployed).toBe(true);
    expect(rollbackAgent?.output?.revision).toContain("回滚");
    expect(p.events.some((e) => e.type === "rework" && e.from === "test_rollback")).toBe(true);
    expect(p.acceptance?.accepted).toBe(true);
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
  });

  it("标准接口触发：ApiTriggerSource → 全链路 done，meta.triggerType=api", async () => {
    const { ApiTriggerSource } = await import("../src/forms/api.js");
    const sub = new ApiTriggerSource().parse({
      title: "接口触发需求",
      description: "通过 POST /api/pipelines 触发。",
      submitter: "接口调用方",
      priority: "P2",
      fields: { 来源: "自动化" },
    });
    expect(sub.source).toBe("api");
    expect(sub.meta.triggerType).toBe("api");
    const p = await h.orchestrator.handleSubmission(sub);
    expect(p.status).toBe("done");
    expect(p.submission.meta.triggerType).toBe("api");
    expect(p.submission.priority).toBe("P2");
  });

  it("测试持续不通过：打回次数超限 → failed", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_TEST_FAIL: "1", MAX_REWORK: "1" });
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("failed");
    expect(p.reworkCount).toBe(2); // 首次打回（1）+ 再次失败（2）超限
    expect(p.failure?.stage).toBe("testing");
    expect(p.failure?.message).toContain("上限");
  });

  it("验收不通过 → 回滚测试环境 → 打回开发 → 修复后验收通过 → done", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_ACCEPT_REJECT_ONCE: "1" });
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("done");
    expect(p.reworkCount).toBe(1);
    // 回滚阶段执行过（stage_succeeded test_rollback）且回滚证据记录在案
    const rollbackAgent = p.agents.test_rollback;
    expect(rollbackAgent?.output?.deployed).toBe(true);
    expect(rollbackAgent?.output?.revision).toContain("回滚");
    expect(p.events.some((e) => e.type === "rework" && e.from === "test_rollback")).toBe(true);
    // 最终验收通过并完成生产部署
    expect(p.acceptance?.accepted).toBe(true);
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
  });

  it("回滚失败：failed 终态", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_ACCEPT_REJECT: "1", MOCK_ROLLBACK_FAIL: "1" });
    const p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("failed");
    expect(p.failure?.stage).toBe("test_rollback");
  });

  it("AUTO_ACCEPT=false：停在验收等待，产品确认后进入生产", async () => {
    h.cleanup();
    h = makeHarness({ AUTO_ACCEPT: "false" });
    let p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("awaiting_acceptance");
    expect(p.acceptancePending).toBe(true);

    p = await h.orchestrator.productDecision(p.id, true, "产品-李四", "确认无误");
    expect(p.status).toBe("done");
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
  });

  it("产品拒绝验收：回滚 → 打回 → 重新验收通过 → done", async () => {
    h.cleanup();
    h = makeHarness({ AUTO_ACCEPT: "false" });
    let p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("awaiting_acceptance");
    p = await h.orchestrator.productDecision(p.id, false, "产品-李四", "交互不达标");
    // 拒绝 → 回滚 → 打回开发 → 重新走到验收等待
    expect(p.status).toBe("awaiting_acceptance");
    expect(p.reworkCount).toBe(1);
    expect(p.acceptancePending).toBe(true);
    expect(p.agents.test_rollback?.output?.deployed).toBe(true);

    p = await h.orchestrator.productDecision(p.id, true, "产品-李四", "本次确认通过");
    expect(p.status).toBe("done");
    expect(p.deploy?.prod?.namespace).toBe("demo-prod");
  });

  it("运维部署失败 → 修复后 retry 走通", async () => {
    h.cleanup();
    h = makeHarness({ MOCK_OPS_FAIL: "1" });
    let p = await h.orchestrator.handleSubmission(sampleSubmission);
    expect(p.status).toBe("failed");
    expect(p.failure?.stage).toBe("test_deploying");

    // “修复”后重试同一流水线
    process.env.MOCK_OPS_FAIL = undefined;
    p = await h.orchestrator.retry(p.id);
    expect(p.status).toBe("done");
    expect(p.events.some((e) => e.type === "retried")).toBe(true);
  });
});
