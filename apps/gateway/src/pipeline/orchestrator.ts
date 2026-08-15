import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import type { EnvConfig } from "../config.js";
import { DshRunner } from "../agents/dsh-runner.js";
import { buildAgentTask, buildStageContext } from "../agents/roles.js";
import type { Notifier } from "../notify/notifier.js";
import { SOURCE_LABEL } from "../forms/index.js";
import { PipelineStore } from "./store.js";
import { ev, isTerminal, transition } from "./state-machine.js";
import type {
  AgentResult,
  DeployInfo,
  FormSubmission,
  Pipeline,
  PipelineExecution,
  StageKey,
  SubmissionPolicy,
} from "../types.js";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith(".")) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export interface OrchestratorDeps {
  cfg: EnvConfig;
  store: PipelineStore;
  runner: DshRunner;
  notifier: Notifier;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** 触发生效的流水线策略：触发级覆盖 > 环境变量默认值 */
  private policyOf(p: Pipeline): Required<Pick<SubmissionPolicy, "acceptanceFailure" | "autoAccept" | "maxRework">> {
    const pol = p.submission.policy ?? {};
    return {
      acceptanceFailure: pol.acceptanceFailure ?? this.deps.cfg.ACCEPTANCE_FAILURE_POLICY,
      autoAccept: pol.autoAccept ?? this.deps.cfg.AUTO_ACCEPT,
      maxRework: pol.maxRework ?? this.deps.cfg.MAX_REWORK,
    };
  }

  /** 该阶段在当前流水线中已执行的次数（用于 round 编号） */
  private stageRound(p: Pipeline, stage: string): number {
    return p.executions.filter((e) => e.stage === stage).length + 1;
  }

  private execution(p: Pipeline, stage: string, status: "ok" | "error", startedAt: string, finishedAt: string, extra: Partial<PipelineExecution> = {}): PipelineExecution {
    return {
      stage,
      round: this.stageRound(p, stage),
      status,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      ...extra,
    };
  }

  /** 表单提交入口：建流水线 → 异步驱动评估与后续阶段，立即返回 */
  startSubmission(sub: FormSubmission): Pipeline {
    const pipeline = this.deps.store.create(sub);
    void this.drive(pipeline);
    return pipeline;
  }

  /** 同步跑完整条流水线（测试/CLI 用）：等所有阶段结束 */
  async handleSubmission(sub: FormSubmission): Promise<Pipeline> {
    const pipeline = this.startSubmission(sub);
    return this.awaitPipeline(pipeline.id, this.deps.cfg.DSH_AGENT_TIMEOUT_MS * 6);
  }

  /** 轮询等待流水线稳定（终态，或停在待人工验收确认） */
  async awaitPipeline(id: string, timeoutMs: number): Promise<Pipeline> {
    const start = Date.now();
    for (;;) {
      const p = this.require(id);
      if (isTerminal(p.status)) return p;
      if (p.status === "awaiting_acceptance" && p.acceptancePending) return p;
      if (Date.now() - start > timeoutMs) throw new Error(`等待流水线 ${id} 超时（${timeoutMs}ms）`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** 后台驱动：从 evaluating 开始执行整条流水线 */
  private async drive(pipeline: Pipeline): Promise<void> {
    try {
      const sub = pipeline.submission;
      await this.notify(
        pipeline,
        "📥 收到新的需求提交",
        `来源：${SOURCE_LABEL[sub.source]}（表单 ${sub.sourceFormId}）\n标题：${sub.title}\n提交人：${sub.submitter}\n描述：${sub.description.slice(0, 200)}`,
      );
      await this.runStage(pipeline, "evaluating");
    } catch (err) {
      // 编排器自身异常（非阶段失败）：兜底标记 failed
      const current = this.deps.store.get(pipeline.id);
      if (current && !isTerminal(current.status)) {
        const message = err instanceof Error ? err.message : String(err);
        const next: Pipeline = {
          ...current,
          status: "failed",
          failure: { stage: "orchestrator", message },
          events: [...current.events, ev("stage_failed", { stage: "orchestrator", message })],
          updatedAt: new Date().toISOString(),
        };
        this.deps.store.save(next);
        await this.notify(next, "❌ 流水线执行异常", message, "error");
      }
    }
  }

  /** 产品人工验收决策（AUTO_ACCEPT=false 时使用） */
  async productDecision(pipelineId: string, accepted: boolean, by: string, note?: string): Promise<Pipeline> {
    let p = this.require(pipelineId);
    if (p.status !== "awaiting_acceptance") {
      throw new Error(`流水线 ${pipelineId} 当前状态为 ${p.status}，不能执行验收决策`);
    }
    p = {
      ...p,
      acceptancePending: false,
      events: [...p.events, ev("product_decision", { accepted, by, note })],
      updatedAt: new Date().toISOString(),
    };
    if (!accepted) {
      const reason = note || `产品验收未通过（${by}）`;
      await this.notify(p, "❌ 产品验收未通过", `${by} 未通过验收${note ? `：${note}` : ""}（按流水线策略处理）。`, "error");
      return this.handleAcceptanceFailure(p, "awaiting_acceptance", reason);
    }
    await this.notify(p, "✅ 产品人工验收通过", `${by} 已确认验收通过，开始生产部署。`);
    p = transition(p, "prod_deploying", ev("stage_succeeded", { stage: "awaiting_acceptance" }));
    this.deps.store.save(p);
    return this.runStage(p, "prod_deploying");
  }

  /** 失败后重试：回到失败阶段重新执行 */
  async retry(pipelineId: string): Promise<Pipeline> {
    let p = this.require(pipelineId);
    const failedStage = p.failure?.stage as StageKey | undefined;
    if (!failedStage || p.status !== "failed") {
      throw new Error(`流水线 ${pipelineId} 不在 failed 状态，无法 retry`);
    }
    p = {
      ...p,
      status: failedStage,
      failure: undefined,
      events: [...p.events, ev("stage_started", { stage: failedStage }), ev("retried", { stage: failedStage })],
      updatedAt: new Date().toISOString(),
    };
    this.deps.store.save(p);
    await this.notify(p, `🔁 重试阶段 ${failedStage}`, `失败阶段 ${failedStage} 将重新执行。`);
    return this.runStage(p, failedStage);
  }

  // ── 内部：执行一个阶段 ─────────────────────────────────────────────────────

  private async runStage(p: Pipeline, stage: StageKey): Promise<Pipeline> {
    let current: Pipeline;
    if (p.status === stage) {
      current = p;
    } else {
      current = transition(p, stage, ev("stage_started", { stage }));
      this.deps.store.save(current);
    }

    const artifactsDir = join(this.deps.cfg.artifactsRoot, current.id, stage);
    const context = buildStageContext(current, stage, this.extraContext(current, stage));
    const task = buildAgentTask(current, stage, context, artifactsDir);
    const startedAt = new Date().toISOString();

    let agentResult: AgentResult;
    try {
      const run = await this.deps.runner.run(task, artifactsDir);
      if (run.exitCode !== 0 || !run.parsed) {
        const detail = (run.stderr || run.stdout).slice(-800);
        throw new Error(`agent 退出码 ${run.exitCode} 或输出不可解析：${detail}`);
      }
      agentResult = {
        stage,
        status: "ok",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: run.parsed,
        rawOutput: run.stdout.slice(-4000),
      };
    } catch (err) {
      return this.fail(current, stage, err instanceof Error ? err.message : String(err));
    }

    current = {
      ...current,
      agents: { ...current.agents, [stage]: agentResult },
      executions: [
        ...current.executions,
        this.execution(current, stage, "ok", startedAt, new Date().toISOString(), { output: agentResult.output }),
      ],
      artifacts: [
        ...current.artifacts,
        ...walkFiles(artifactsDir).map((f) => ({
          stage,
          path: relative(this.deps.cfg.dataDir, f),
        })),
      ],
      updatedAt: new Date().toISOString(),
    };

    switch (stage) {
      case "evaluating":
        return this.afterEvaluation(current, agentResult);
      case "dev_in_progress":
        return this.afterDevelopment(current);
      case "testing":
        return this.afterTesting(current, agentResult);
      case "test_deploying":
        return this.afterTestDeploy(current, agentResult);
      case "test_rollback":
        return this.afterTestRollback(current, agentResult);
      case "awaiting_acceptance":
        return this.afterAcceptance(current, agentResult);
      case "prod_deploying":
        return this.afterProdDeploy(current, agentResult);
    }
  }

  private async afterEvaluation(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    const out = result.output ?? {};
    const approved = out.approved === true;
    const evaluation = {
      approved,
      score: typeof out.score === "number" ? out.score : undefined,
      reasons: Array.isArray(out.reasons) ? (out.reasons as string[]) : [],
      suggestedPriority: typeof out.suggestedPriority === "string" ? out.suggestedPriority : undefined,
    };
    if (!approved) {
      let next: Pipeline = transition(p, "rejected", ev("rejected", { reason: evaluation.reasons.join("；") || "评估未通过" }));
      next = { ...next, evaluation };
      this.deps.store.save(next);
      await this.notify(next, "❌ 需求评估未通过", `评分 ${evaluation.score ?? "-"}。理由：${evaluation.reasons.join("；")}`, "warning");
      return next;
    }
    let next: Pipeline = { ...p, evaluation };
    next = transition(next, "dev_in_progress", ev("stage_succeeded", { stage: "evaluating" }));
    this.deps.store.save(next);
    await this.notify(next, "✅ 需求评估通过", `评分 ${evaluation.score ?? "-"}（建议优先级 ${evaluation.suggestedPriority ?? "-"}）。进入开发。`);
    return this.runStage(next, "dev_in_progress");
  }

  private async afterDevelopment(p: Pipeline): Promise<Pipeline> {
    const next = transition(p, "testing", ev("stage_succeeded", { stage: "dev_in_progress" }));
    this.deps.store.save(next);
    const dev = next.agents.dev_in_progress?.output ?? {};
    await this.notify(next, "🧑💻 开发完成", `计划：${String(dev.plan ?? "-")}\n版本：${String(dev.version ?? "-")}\n变更数：${Array.isArray(dev.changes) ? dev.changes.length : 0}\n${next.reworkCount ? `（第 ${next.reworkCount} 轮修复开发）` : ""}`);
    return this.runStage(next, "testing");
  }

  /** 测试阶段：通过 → 部署测试环境；不通过 → 打回开发 */
  private async afterTesting(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    const out = result.output ?? {};
    const passed = out.status === "pass";
    const summary = String(out.summary ?? "");
    const issues = Array.isArray(out.issues) ? (out.issues as string[]) : [];
    if (!passed) {
      const reason = issues.join("；") || summary || "测试未通过";
      await this.notify(p, "❌ 测试未通过", `问题清单：${reason}\n打回开发重新修复。`, "warning");
      return this.reworkToDev(p, "testing", reason);
    }
    const next = transition(p, "test_deploying", ev("stage_succeeded", { stage: "testing" }));
    this.deps.store.save(next);
    await this.notify(next, "✅ 测试通过", `${summary || "全部用例通过"}，进入测试环境部署。`);
    return this.runStage(next, "test_deploying");
  }

  /** 验收不通过：先回滚测试环境，回滚成功后再打回开发 */
  private async afterAcceptance(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    const out = result.output ?? {};
    const verdict = {
      accepted: out.accepted === true,
      verdicts: Array.isArray(out.verdicts) ? (out.verdicts as { item: string; result: "pass" | "fail" | "warn" }[]) : [],
      issues: Array.isArray(out.issues) ? (out.issues as string[]) : [],
      note: typeof out.note === "string" ? out.note : "",
      at: new Date().toISOString(),
    };
    let next: Pipeline = { ...p, acceptance: verdict };
    await this.notify(next, verdict.accepted ? "✅ 验收检查通过" : "⚠️ 验收检查未通过", `验收项：${verdict.verdicts.map((v) => `${v.item}=${v.result}`).join(", ")}\n问题：${verdict.issues.join("；") || "无"}\n说明：${verdict.note}`, verdict.accepted ? "info" : "warning");

    if (!verdict.accepted) {
      return this.handleAcceptanceFailure(next, "awaiting_acceptance", verdict.issues.join("；") || "验收检查未通过");
    }

    if (!this.policyOf(next).autoAccept) {
      next = { ...next, acceptancePending: true };
      this.deps.store.save(next);
      await this.notify(next, "⏳ 等待产品人工确认", "验收检查通过。AUTO_ACCEPT=false，请产品确认：\nPOST /api/pipelines/" + next.id + '/accept {"accepted":true,"by":"产品"}');
      return next;
    }
    await this.notify(next, "✅ 产品验收通过（自动）", "验收检查通过，开始生产部署。");
    next = transition(next, "prod_deploying", ev("stage_succeeded", { stage: "awaiting_acceptance" }));
    this.deps.store.save(next);
    return this.runStage(next, "prod_deploying");
  }

  /** 回滚阶段完成：回滚成功 → 打回开发；失败 → 终止 */
  private async afterTestRollback(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    if (result.output?.deployed !== true) {
      return this.fail(p, "test_rollback", "运维 Agent 报告回滚未成功：" + summarizeDeployFailure(result));
    }
    await this.notify(p, "↩️ 测试环境已回滚", `已回滚到 ${String(result.output?.revision ?? "上一稳定版本")}\n证据：${(Array.isArray(result.output?.evidence) ? result.output?.evidence : []).join("；")}`);
    return this.reworkToDev(p, "test_rollback", "验收未通过，已回滚测试环境，打回开发修复");
  }

  private async afterTestDeploy(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    if (result.output?.deployed !== true) {
      return this.fail(p, "test_deploying", "运维 Agent 报告部署未成功：" + summarizeDeployFailure(result));
    }
    const info = toDeployInfo(result, "demo-test");
    let next: Pipeline = { ...p, deploy: { ...p.deploy, test: info } };
    next = transition(next, "awaiting_acceptance", ev("stage_succeeded", { stage: "test_deploying" }));
    this.deps.store.save(next);
    await this.notify(
      next,
      "🚀 测试环境已部署",
      `命名空间：${info.namespace}\n版本：${info.revision}\n访问地址：${info.url}\n模式：${info.mode === "kubectl" ? "kubectl 真实部署" : "模拟部署"}`,
    );
    await this.notify(next, "📋 请产品验收", `流水线 ${next.id}\n验收通过后自动进入生产部署。\n验收接口：POST /api/pipelines/${next.id}/accept {"accepted":true}`);
    return this.runStage(next, "awaiting_acceptance");
  }

  private async afterProdDeploy(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    if (result.output?.deployed !== true) {
      return this.fail(p, "prod_deploying", "运维 Agent 报告生产部署未成功：" + summarizeDeployFailure(result));
    }
    const info = toDeployInfo(result, "demo-prod");
    let next: Pipeline = { ...p, deploy: { ...p.deploy, prod: info } };
    next = transition(next, "done", ev("done"));
    this.deps.store.save(next);
    await this.notify(next, "🎉 生产环境部署完成", `命名空间：${info.namespace}\n版本：${info.revision}\n访问地址：${info.url}\n模式：${info.mode === "kubectl" ? "kubectl 真实部署" : "模拟部署"}`);
    return next;
  }

  /**
   * 验收失败处理（策略可控，触发级 policy > 环境变量 ACCEPTANCE_FAILURE_POLICY）：
   * - rollback：先回滚测试环境（运维 Agent），回滚成功后再打回开发
   * - rework：直接打回开发（不回滚）
   * - reject：直接终止流水线（failed）
   */
  private async handleAcceptanceFailure(p: Pipeline, sourceStage: string, reason: string): Promise<Pipeline> {
    const policy = this.policyOf(p).acceptanceFailure;
    if (policy === "rework") {
      await this.notify(p, "🔁 验收未通过，直接打回开发（policy=rework）", `原因：${reason}`, "warning");
      return this.reworkToDev(p, sourceStage, reason);
    }
    if (policy === "reject") {
      const message = `验收未通过：${reason}`;
      let next = transition(p, "failed", ev("stage_failed", { stage: sourceStage, message }));
      next = { ...next, failure: { stage: sourceStage, message } };
      this.deps.store.save(next);
      await this.notify(next, "⛔ 验收未通过，流水线终止（policy=reject）", message, "error");
      return next;
    }
    // 默认 rollback：回滚测试环境后再打回开发
    let next = transition(p, "test_rollback", ev("stage_failed", { stage: sourceStage, message: reason }));
    this.deps.store.save(next);
    await this.notify(next, "↩️ 验收未通过，开始回滚测试环境", `原因：${reason}\n回滚完成后将打回开发重新修复。`, "warning");
    return this.runStage(next, "test_rollback");
  }

  /** 打回开发（受 MAX_REWORK 上限约束）；超限则终止 */
  private async reworkToDev(p: Pipeline, fromStage: string, reason: string): Promise<Pipeline> {
    const maxRework = this.policyOf(p).maxRework;
    const count = (p.reworkCount ?? 0) + 1;
    if (count > maxRework) {
      const message = `打回开发次数超过上限（${maxRework} 次）：${reason}`;
      let next = transition(p, "failed", ev("stage_failed", { stage: fromStage, message }));
      next = { ...next, failure: { stage: fromStage, message }, reworkCount: count };
      this.deps.store.save(next);
      await this.notify(next, "🚫 打回次数超限，流水线终止", message, "error");
      return next;
    }
    let next: Pipeline = { ...p, reworkCount: count };
    next = transition(next, "dev_in_progress", ev("rework", { from: fromStage, reason }));
    this.deps.store.save(next);
    await this.notify(next, `🔁 打回开发（第 ${count} 轮）`, `来源：${fromStage}\n原因：${reason}`);
    return this.runStage(next, "dev_in_progress");
  }

  private async fail(p: Pipeline, stage: StageKey, message: string): Promise<Pipeline> {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    let next = transition(p, "failed", ev("stage_failed", { stage, message }));
    next = {
      ...next,
      failure: { stage, message },
      executions: [...next.executions, this.execution(next, stage, "error", startedAt, finishedAt, { error: message })],
      agents: {
        ...next.agents,
        [stage]: {
          stage,
          status: "error",
          startedAt,
          finishedAt,
          error: message,
        },
      },
    };
    this.deps.store.save(next);
    await this.notify(next, `❌ 阶段失败：${stage}`, message, "error");
    return next;
  }

  /** 每阶段追加的上下文（部署模式探测等） */
  private extraContext(p: Pipeline, stage: StageKey): Record<string, unknown> {
    const ctx: Record<string, unknown> = { pipelineMode: this.deps.cfg.PIPELINE_MODE };
    if (stage === "test_deploying" || stage === "test_rollback" || stage === "prod_deploying") {
      const mode = this.deps.cfg.OPS_MODE === "auto" ? (this.hasKubectl() ? "kubectl" : "simulated") : this.deps.cfg.OPS_MODE;
      ctx.ops = {
        mode,
        manifestsDir: this.deps.cfg.k8sManifestsDir,
        overlayDir: stage === "prod_deploying" ? "overlays/prod" : "overlays/test",
      };
    }
    return ctx;
  }

  private hasKubectl(): boolean {
    try {
      const r = spawnSync("kubectl", ["version", "--client", "-o", "json"], { timeout: 5000, encoding: "utf8" });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  private require(id: string): Pipeline {
    const p = this.deps.store.get(id);
    if (!p) throw new Error(`流水线不存在：${id}`);
    return p;
  }

  private async notify(p: Pipeline, title: string, body: string, level: "info" | "success" | "warning" | "error" = "info") {
    await this.deps.notifier.notify(p, `[${p.id.slice(0, 8)}] ${title}`, body, level);
  }
}

function toDeployInfo(result: AgentResult, fallbackNs: string): DeployInfo {
  const out = result.output ?? {};
  return {
    mode: out.mode === "kubectl" ? "kubectl" : "simulated",
    namespace: String(out.namespace ?? fallbackNs),
    revision: String(out.revision ?? "unknown"),
    url: String(out.url ?? ""),
    evidence: Array.isArray(out.evidence) ? (out.evidence as string[]) : [],
    deployedAt: new Date().toISOString(),
  };
}

function summarizeDeployFailure(result: AgentResult): string {
  const out = result.output ?? {};
  const evidence = Array.isArray(out.evidence) ? (out.evidence as string[]).join("；") : "";
  const warnings = Array.isArray(out.warnings) ? (out.warnings as string[]).join("；") : "";
  return (evidence || warnings || "无详细原因").slice(0, 300);
}
