import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import type { EnvConfig } from "../config.js";
import { DshRunner } from "../agents/dsh-runner.js";
import { buildAgentTask, buildStageContext, namespaceForEnv } from "../agents/roles.js";
import type { Notifier } from "../notify/notifier.js";
import { SOURCE_LABEL } from "../forms/index.js";
import { PipelineStore } from "./store.js";
import { ev, isTerminal, transition } from "./state-machine.js";
import { BUILTIN_STAGES, type PipelineTemplate, type TemplateStage, type TemplateRegistry } from "./template.js";
import { type AgentRegistry, verdictOf } from "../agents/registry.js";
import type { AppLogger } from "../logger.js";
import type {
  AgentResult,
  DeployInfo,
  FormSubmission,
  Pipeline,
  PipelineExecution,
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
  /** 模板注册表（平台多模板，流水线各自绑定互不干扰） */
  registry: TemplateRegistry;
  /** Agent 定义注册表（内置 + 用户自定义扩展） */
  agentRegistry: AgentRegistry;
  /** 默认模板名（触发未指定时使用） */
  defaultTemplate: string;
  logger?: AppLogger;
}

/** 多 Agent 并行阶段的结果 */
interface MultiRunResult {
  ok: boolean;
  agentResult?: AgentResult;
  error?: string;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private get log(): AppLogger | undefined {
    return this.deps.logger;
  }

  /**
   * 流水线绑定的流程模板：优先使用触发时的模板快照（模板后续修改不影响已触发流水线），
   * 旧数据（无快照）回退按名从注册表取。
   */
  private templateOf(p: Pipeline): PipelineTemplate {
    if (p.templateSnapshot && typeof p.templateSnapshot === "object") {
      return p.templateSnapshot as PipelineTemplate;
    }
    return this.deps.registry.get(p.templateName);
  }

  /** 解析触发使用的模板名：触发级 policy.template > 默认模板 */
  private resolveTemplateName(sub: FormSubmission): string {
    const name = sub.policy?.template ?? this.deps.defaultTemplate;
    if (!this.deps.registry.has(name)) {
      throw new Error(`流程模板不存在：${name}（可用：${this.deps.registry.names().join(", ")}）`);
    }
    return name;
  }

  // ── 模板平台管理（供 Web 控制台/CLI 调用） ─────────────────────────────────

  /** 动态注册/更新 Agent 定义（立即生效） */
  registerAgent(def: import("../agents/registry.js").AgentDefinition): import("../agents/registry.js").AgentDefinition {
    return this.deps.agentRegistry.save(def);
  }

  /** 删除 Agent 定义（内置不可删） */
  removeAgent(name: string): void {
    this.deps.agentRegistry.remove(name);
  }

  hasAgent(name: string): boolean {
    return this.deps.agentRegistry.has(name);
  }

  /** 动态注册/更新模板（立即生效） */
  registerTemplate(name: string, stages: unknown): PipelineTemplate {
    return this.deps.registry.save(name, stages);
  }

  /** 删除模板（default 不可删） */
  removeTemplate(name: string): void {
    this.deps.registry.remove(name);
  }

  hasTemplate(name: string): boolean {
    return this.deps.registry.has(name);
  }

  listTemplates(): string[] {
    return this.deps.registry.names();
  }

  /** 流水线模板中的阶段定义 */
  private stageDefOf(p: Pipeline, stage: string): TemplateStage | undefined {
    return this.templateOf(p).stages.find((s) => s.id === stage);
  }

  /** 模板允许的所有状态（阶段 + 终态），作为迁移合法性来源 */
  private allowedStagesOf(p: Pipeline): string[] {
    return [...this.templateOf(p).stages.map((s) => s.id), "submitted", "rejected", "failed", "done"];
  }

  /** 打回目标：模板 reworkTarget 缺省回到开发阶段 */
  private reworkTargetOf(p: Pipeline, stage: string): string {
    return this.stageDefOf(p, stage)?.reworkTarget ?? "dev_in_progress";
  }

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

  // ── 对外入口 ────────────────────────────────────────────────────────────────

  /** 表单提交入口：建流水线 → 异步驱动评估与后续阶段，立即返回 */
  startSubmission(sub: FormSubmission): Pipeline {
    const templateName = this.resolveTemplateName(sub);
    const template = this.deps.registry.get(templateName);
    const pipeline = this.deps.store.create(sub, templateName, structuredClone(template));
    this.log?.info({ pipelineId: pipeline.id, trigger: sub.meta.triggerType, source: sub.source, title: sub.title, template: templateName }, "pipeline created");
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

  /**
   * 平台中断恢复：扫描非终态流水线自动续跑。
   * - submitted → 从起始阶段开始；
   * - 进行中阶段（evaluating/…/prod_deploying）→ 从该阶段重跑（幂等，executions 记录新轮次）；
   * - awaiting_acceptance 且等待人工确认 → 跳过（不打扰人工闸门）；
   * - 使用触发时的模板快照执行，模板修改不影响恢复。
   */
  async resumePending(): Promise<number> {
    const pending = this.deps.store
      .list()
      .filter(
        (p) =>
          !isTerminal(p.status) &&
          !(p.status === "awaiting_acceptance" && p.acceptancePending),
      );
    for (const p of pending) {
      this.log?.info({ pipelineId: p.id, status: p.status }, "resume pending pipeline");
      let next: Pipeline = {
        ...p,
        events: [...p.events, ev("recovered", { stage: p.status })],
        updatedAt: new Date().toISOString(),
      };
      this.deps.store.save(next);
      void this.driveRecovered(next);
    }
    return pending.length;
  }

  /** 恢复驱动：submitted 从起始阶段起跑；阶段态直接续跑该阶段 */
  private async driveRecovered(p: Pipeline): Promise<void> {
    try {
      if (p.status === "submitted") {
        const startStage = this.stageDefOf(p, "evaluating") ? "evaluating" : this.templateOf(p).stages[0]!.id;
        await this.runStage(p, startStage);
      } else {
        await this.runStage(p, p.status);
      }
    } catch (err) {
      const current = this.deps.store.get(p.id);
      if (current && !isTerminal(current.status)) {
        const message = err instanceof Error ? err.message : String(err);
        const next: Pipeline = {
          ...current,
          status: "failed",
          failure: { stage: "recovery", message },
          events: [...current.events, ev("stage_failed", { stage: "recovery", message })],
          updatedAt: new Date().toISOString(),
        };
        this.deps.store.save(next);
      }
    }
  }

  /** 后台驱动：从起始阶段执行整条流水线 */
  private async drive(pipeline: Pipeline): Promise<void> {
    try {
      const sub = pipeline.submission;
      await this.notify(
        pipeline,
        "📥 收到新的需求提交",
        `来源：${SOURCE_LABEL[sub.source]}（表单 ${sub.sourceFormId}）\n标题：${sub.title}\n提交人：${sub.submitter}\n描述：${sub.description.slice(0, 200)}`,
      );
      const startStage = this.stageDefOf(pipeline, "evaluating") ? "evaluating" : this.templateOf(pipeline).stages[0]!.id;
      await this.runStage(pipeline, startStage);
    } catch (err) {
      // 编排器自身异常（非阶段失败）：兜底标记 failed
      const current = this.deps.store.get(pipeline.id);
      if (current && !isTerminal(current.status)) {
        const message = err instanceof Error ? err.message : String(err);
        this.log?.error({ pipelineId: pipeline.id, err: message }, "pipeline crashed");
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
    this.log?.info({ pipelineId, accepted, by }, "product decision");
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
    const next = this.stageDefOf(p, "awaiting_acceptance")!.onSuccess;
    p = transition(p, next, ev("stage_succeeded", { stage: "awaiting_acceptance" }), this.allowedStagesOf(p));
    this.deps.store.save(p);
    return this.runStage(p, next);
  }

  /** 失败后重试：回到失败阶段重新执行 */
  async retry(pipelineId: string): Promise<Pipeline> {
    let p = this.require(pipelineId);
    const failedStage = p.failure?.stage;
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

  // ── 阶段执行 ────────────────────────────────────────────────────────────────

  private async runStage(p: Pipeline, stage: string): Promise<Pipeline> {
    const def = this.stageDefOf(p, stage);
    if (!def) throw new Error(`流程模板未定义阶段：${stage}`);
    let current: Pipeline;
    if (p.status === stage) {
      current = p;
    } else {
      current = transition(p, stage, ev("stage_started", { stage }), this.allowedStagesOf(p));
      this.deps.store.save(current);
    }
    this.log?.info({ pipelineId: current.id, stage, agent: def.agent, round: this.stageRound(current, stage) }, "stage started");

    const artifactsDir = join(this.deps.cfg.artifactsRoot, current.id, stage);
    const startedAt = new Date().toISOString();

    let agentResult: AgentResult;
    if (def.multi) {
      const multi = await this.runMultiStage(current, def, artifactsDir, startedAt);
      if (!multi.ok || !multi.agentResult) {
        return this.fail(current, stage, multi.error ?? "多 Agent 阶段执行失败");
      }
      agentResult = multi.agentResult;
    } else {
      const context = this.buildContext(current, stage, def);
      const agentDef = this.deps.agentRegistry.get(def.agent);
      const task = buildAgentTask(current, stage, def.agent, agentDef, context, artifactsDir);
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
    this.log?.info({ pipelineId: current.id, stage }, "stage completed");

    return this.dispatch(current, stage, agentResult);
  }

  /** 阶段完成后的推进：内置阶段走专属逻辑，自定义阶段走通用逻辑 */
  private async dispatch(p: Pipeline, stage: string, result: AgentResult): Promise<Pipeline> {
    if ((BUILTIN_STAGES as readonly string[]).includes(stage)) {
      switch (stage) {
        case "evaluating":
          return this.afterEvaluation(p, result);
        case "dev_in_progress":
          return this.afterDevelopment(p);
        case "testing":
          return this.afterTesting(p, result);
        case "test_deploying":
          return this.afterTestDeploy(p, result);
        case "test_rollback":
          return this.afterTestRollback(p, result);
        case "awaiting_acceptance":
          return this.afterAcceptance(p, result);
        case "prod_deploying":
          return this.afterProdDeploy(p, result);
      }
    }
    return this.afterGenericStage(p, this.stageDefOf(p, stage)!, result);
  }

  /** 通用自定义阶段：按角色判定 pass/fail/reject，按模板推进或打回 */
  private async afterGenericStage(p: Pipeline, def: TemplateStage, result: AgentResult): Promise<Pipeline> {
    const verdict = verdictOf(this.deps.agentRegistry.get(def.agent), result.output ?? {});
    this.log?.info({ pipelineId: p.id, stage: def.id, agent: def.agent, verdict }, "generic stage verdict");
    if (verdict === "reject") {
      const reason = String((result.output?.reasons ?? result.output?.issues ?? ["未通过"]) as string[] | string).slice(0, 300);
      let next = transition(p, "rejected", ev("rejected", { reason }), this.allowedStagesOf(p));
      this.deps.store.save(next);
      await this.notify(next, "❌ 阶段未通过（拒绝）", `阶段 ${def.id}：${reason}`, "warning");
      return next;
    }
    if (verdict === "pass") {
      return this.advance(p, def.id);
    }
    const issues = result.output?.issues as string[] | undefined;
    const reason = (issues && issues.length > 0 ? issues.join("；") : `阶段 ${def.id} 未通过`).slice(0, 300);
    return this.reworkToDev(p, def.id, reason);
  }

  /** 按模板推进到下一阶段 */
  private async advance(p: Pipeline, fromStage: string): Promise<Pipeline> {
    const def = this.stageDefOf(p, fromStage)!;
    const next = def.onSuccess;
    const nextPipeline = transition(
      p,
      next,
      next === "done" ? ev("done") : ev("stage_succeeded", { stage: fromStage }),
      this.allowedStagesOf(p),
    );
    this.deps.store.save(nextPipeline);
    if (next === "done" || next === "rejected" || next === "failed") {
      return nextPipeline;
    }
    return this.runStage(nextPipeline, next);
  }

  // ── 多 Agent 并行（多开发 Agent 联调） ───────────────────────────────────────

  /**
   * 多 Agent 阶段：
   * 1) 契约轮：每个服务一个 agent 实例并行输出接口契约；
   * 2) 汇总契约并广播给全部实例（agent 间“通信/联调”）；
   * 3) 实现轮：每个服务基于团队契约并行产出实现方案。
   */
  private async runMultiStage(p: Pipeline, def: TemplateStage, artifactsDir: string, startedAt: string): Promise<MultiRunResult> {
    const services = def.multi!.services;
    const baseCtx = this.buildContext(p, def.id, def);
    this.log?.info({ pipelineId: p.id, stage: def.id, services }, "multi-agent stage: contract round");

    const runSubTask = async (
      svc: string,
      ctx: Record<string, unknown>,
    ): Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string }> => {
      const dir = join(artifactsDir, svc);
      const agentDef = this.deps.agentRegistry.get(def.agent);
      const task = buildAgentTask(p, def.id, def.agent, agentDef, ctx, dir);
      try {
        const run = await this.deps.runner.run(task, dir);
        if (run.exitCode === 0 && run.parsed) return { ok: true, output: run.parsed };
        // 输出不可解析或异常退出：带提示重试一次（真实 agent 偶尔把 JSON 写进文件/围栏外）
        const reason = run.exitCode !== 0 ? `退出码 ${run.exitCode}` : "输出无法解析为 JSON";
        const retryTask = {
          ...task,
          instructions: `${task.instructions}\n\n注意：上一次输出未通过校验（${reason}）。请把结果作为【唯一的 JSON 对象】输出到 stdout，不要围栏、不要解释、不要只写文件。`,
        };
        this.log?.warn({ pipelineId: p.id, stage: def.id, svc, reason }, "multi-agent sub-task retry");
        const retry = await this.deps.runner.run(retryTask, dir);
        if (retry.exitCode === 0 && retry.parsed) return { ok: true, output: retry.parsed };
        const tail = (retry.stdout || retry.stderr).slice(-400) || (run.stdout || run.stderr).slice(-400);
        return { ok: false, error: `输出不可解析（${reason}）：${tail}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    const contractRound = await Promise.all(
      services.map(async (svc) => {
        const r = await runSubTask(svc, { ...baseCtx, phase: "contract", service: { name: svc } });
        return { svc, ...r };
      }),
    );
    const contractFailed = contractRound.find((r) => !r.ok);
    if (contractFailed) {
      return { ok: false, error: `服务 ${contractFailed.svc} 契约声明失败：${contractFailed.error}` };
    }
    const contracts: Record<string, unknown> = Object.fromEntries(
      contractRound.map((r) => [r.svc, r.output]),
    );
    this.log?.info({ pipelineId: p.id, stage: def.id, contracts: Object.keys(contracts) }, "multi-agent stage: contracts collected, implement round");

    const implementRound = await Promise.all(
      services.map(async (svc) => {
        const r = await runSubTask(svc, { ...baseCtx, phase: "implement", service: { name: svc }, teamContracts: contracts });
        return { svc, ...r };
      }),
    );
    const implementFailed = implementRound.find((r) => !r.ok);
    if (implementFailed) {
      return { ok: false, error: `服务 ${implementFailed.svc} 实现产出失败：${implementFailed.error}` };
    }
    const servicesOut: Record<string, Record<string, unknown>> = Object.fromEntries(
      implementRound.map((r) => [r.svc, r.output as Record<string, unknown>]),
    );
    const first = Object.values(servicesOut)[0] ?? {};
    return {
      ok: true,
      agentResult: {
        stage: def.id,
        status: "ok",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: {
          multi: true,
          services: servicesOut,
          contracts,
          summary: first.summary ?? "",
          version: first.version ?? "v1.0.0",
        },
        rawOutput: JSON.stringify({ contracts, services: servicesOut }).slice(0, 4000),
      },
    };
  }

  // ── 内置阶段推进逻辑 ─────────────────────────────────────────────────────────

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
      let next: Pipeline = transition(p, "rejected", ev("rejected", { reason: evaluation.reasons.join("；") || "评估未通过" }), this.allowedStagesOf(p));
      next = { ...next, evaluation };
      this.deps.store.save(next);
      await this.notify(next, "❌ 需求评估未通过", `评分 ${evaluation.score ?? "-"}。理由：${evaluation.reasons.join("；")}`, "warning");
      return next;
    }
    let next: Pipeline = { ...p, evaluation };
    next = transition(next, this.stageDefOf(p, "evaluating")!.onSuccess, ev("stage_succeeded", { stage: "evaluating" }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    await this.notify(next, "✅ 需求评估通过", `评分 ${evaluation.score ?? "-"}（建议优先级 ${evaluation.suggestedPriority ?? "-"}）。进入开发。`);
    return this.runStage(next, this.stageDefOf(p, "evaluating")!.onSuccess);
  }

  private async afterDevelopment(p: Pipeline): Promise<Pipeline> {
    const nextStage = this.stageDefOf(p, "dev_in_progress")!.onSuccess;
    const next = transition(p, nextStage, ev("stage_succeeded", { stage: "dev_in_progress" }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    const dev = next.agents.dev_in_progress?.output ?? {};
    const isMulti = dev.multi === true;
    await this.notify(
      next,
      isMulti ? "🧑💻 多服务开发完成（联调）" : "🧑💻 开发完成",
      isMulti
        ? `服务数：${Object.keys(dev.services ?? {}).length}\n契约数：${Object.keys(dev.contracts ?? {}).length}\n版本：${String(dev.version ?? "-")}\n${next.reworkCount ? `（第 ${next.reworkCount} 轮修复开发）` : ""}`
        : `计划：${String(dev.plan ?? "-")}\n版本：${String(dev.version ?? "-")}\n变更数：${Array.isArray(dev.changes) ? dev.changes.length : 0}\n${next.reworkCount ? `（第 ${next.reworkCount} 轮修复开发）` : ""}`,
    );
    return this.runStage(next, nextStage);
  }

  /** 测试阶段：通过 → 下一阶段；不通过 → 打回开发 */
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
    const nextStage = this.stageDefOf(p, "testing")!.onSuccess;
    const next = transition(p, nextStage, ev("stage_succeeded", { stage: "testing" }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    await this.notify(next, "✅ 测试通过", `${summary || "全部用例通过"}，进入测试环境部署。`);
    return this.runStage(next, nextStage);
  }

  /** 验收 Agent 预检 */
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
    const nextStage = this.stageDefOf(p, "awaiting_acceptance")!.onSuccess;
    next = transition(next, nextStage, ev("stage_succeeded", { stage: "awaiting_acceptance" }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    return this.runStage(next, nextStage);
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
    const env = this.stageDefOf(p, "test_deploying")?.ops?.env ?? "test";
    const info = toDeployInfo(result, namespaceForEnv(env));
    let next: Pipeline = { ...p, deploy: { ...p.deploy, test: info } };
    const nextStage = this.stageDefOf(p, "test_deploying")!.onSuccess;
    next = transition(next, nextStage, ev("stage_succeeded", { stage: "test_deploying" }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    await this.notify(
      next,
      "🚀 测试环境已部署",
      `命名空间：${info.namespace}\n版本：${info.revision}\n访问地址：${info.url}\n模式：${info.mode === "kubectl" ? "kubectl 真实部署" : "模拟部署"}`,
    );
    await this.notify(next, "📋 请产品验收", `流水线 ${next.id}\n验收通过后自动进入生产部署。\n验收接口：POST /api/pipelines/${next.id}/accept {"accepted":true}`);
    return this.runStage(next, nextStage);
  }

  private async afterProdDeploy(p: Pipeline, result: AgentResult): Promise<Pipeline> {
    if (result.output?.deployed !== true) {
      return this.fail(p, "prod_deploying", "运维 Agent 报告生产部署未成功：" + summarizeDeployFailure(result));
    }
    const env = this.stageDefOf(p, "prod_deploying")?.ops?.env ?? "prod";
    const info = toDeployInfo(result, namespaceForEnv(env));
    const nextStage = this.stageDefOf(p, "prod_deploying")!.onSuccess;
    let next: Pipeline = transition(
      p,
      nextStage,
      nextStage === "done" ? ev("done") : ev("stage_succeeded", { stage: "prod_deploying" }),
      this.allowedStagesOf(p),
    );
    next = { ...next, deploy: { ...next.deploy, prod: info } };
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
      let next = transition(p, "failed", ev("stage_failed", { stage: sourceStage, message }), this.allowedStagesOf(p));
      next = { ...next, failure: { stage: sourceStage, message } };
      this.deps.store.save(next);
      await this.notify(next, "⛔ 验收未通过，流水线终止（policy=reject）", message, "error");
      return next;
    }
    // rollback：模板需定义 test_rollback 阶段，否则降级为直接打回
    if (!this.stageDefOf(p, "test_rollback")) {
      this.log?.warn({ pipelineId: p.id }, "policy=rollback 但模板未定义 test_rollback 阶段，降级为 rework");
      await this.notify(p, "🔁 模板未定义回滚阶段，直接打回开发", `原因：${reason}`, "warning");
      return this.reworkToDev(p, sourceStage, reason);
    }
    let next = transition(p, "test_rollback", ev("stage_failed", { stage: sourceStage, message: reason }), this.allowedStagesOf(p));
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
      let next = transition(p, "failed", ev("stage_failed", { stage: fromStage, message }), this.allowedStagesOf(p));
      next = { ...next, failure: { stage: fromStage, message }, reworkCount: count };
      this.deps.store.save(next);
      await this.notify(next, "🚫 打回次数超限，流水线终止", message, "error");
      return next;
    }
    const target = this.reworkTargetOf(p, fromStage);
    let next: Pipeline = { ...p, reworkCount: count };
    next = transition(next, target, ev("rework", { from: fromStage, reason }), this.allowedStagesOf(p));
    this.deps.store.save(next);
    await this.notify(next, `🔁 打回开发（第 ${count} 轮）`, `来源：${fromStage}\n原因：${reason}`);
    return this.runStage(next, target);
  }

  private async fail(p: Pipeline, stage: string, message: string): Promise<Pipeline> {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    this.log?.error({ pipelineId: p.id, stage, message }, "stage failed");
    let next = transition(p, "failed", ev("stage_failed", { stage, message }), this.allowedStagesOf(p));
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

  // ── 上下文与工具 ─────────────────────────────────────────────────────────────

  /** 每阶段追加的上下文（流水线模式、模板阶段配置、部署模式探测等） */
  private buildContext(p: Pipeline, stage: string, def: TemplateStage): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      pipelineMode: this.deps.cfg.PIPELINE_MODE,
      templateStage: def.id,
    };
    if (def.agent === "ops") {
      const mode = this.deps.cfg.OPS_MODE === "auto" ? (this.hasKubectl() ? "kubectl" : "simulated") : this.deps.cfg.OPS_MODE;
      const env = def.ops?.env ?? "test";
      ctx.ops = {
        mode,
        manifestsDir: this.deps.cfg.k8sManifestsDir,
        overlayDir: env === "prod" ? "overlays/prod" : "overlays/test",
        action: def.ops?.action ?? "deploy",
        env,
      };
    }
    return buildStageContext(p, stage, ctx);
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

/** 通用角色判定：阶段输出 → pass / fail / reject（reject 仅评估类） */
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
