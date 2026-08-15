import type { AgentTask, Pipeline, StageKey } from "../types.js";
import { COMMON_RULES_TEXT, ROLE_PROMPTS } from "./prompts.js";

/** 构建某阶段的 Agent 任务 */
export function buildAgentTask(
  pipeline: Pipeline,
  stage: StageKey,
  context: Record<string, unknown>,
  artifactsDir: string,
): AgentTask {
  const role = roleForStage(stage);
  const prompt = ROLE_PROMPTS[role];
  const modeNote = modeNoteFor(role, context.pipelineMode);
  return {
    pipelineId: pipeline.id,
    role,
    stage,
    requirement: {
      title: pipeline.submission.title,
      description: pipeline.submission.description,
      submitter: pipeline.submission.submitter,
      priority: pipeline.submission.priority,
      fields: pipeline.submission.fields,
    },
    context,
    instructions: `${prompt.persona}

${modeNote}

输出 schema：
${prompt.outputSchema}

${COMMON_RULES_TEXT}`,
    outputSchema: prompt.outputSchema,
    artifactsDir,
  };
}

/** 按流水线模式给角色补充行为说明（模拟 vs 真实） */
function modeNoteFor(role: AgentTask["role"], pipelineMode: unknown): string {
  const real = pipelineMode === "real";
  switch (role) {
    case "acceptance":
      return real
        ? "当前为「真实交付模式」：开发产出为真实代码、测试已执行、部署为真实 Kubernetes 操作，请按真实生产标准严格验收。"
        : "当前为「模拟流水线模式」：开发产出为方案/变更文档（artifactsDir 下）、测试为计划、部署为模拟执行（有部署计划与证据）。验收标准调整为：①需求覆盖度；②方案与测试计划完整性；③部署证据充分性。若上述齐备且无关键缺口，应判定 accepted=true；如有真实缺口可给 warn 但不要仅因『未真实开发/未真实部署』判失败。";
    case "developer":
      return real
        ? "当前为「真实交付模式」：请在指定代码仓库完成真实实现并执行测试。"
        : "当前为「模拟开发模式」：不需要修改真实代码仓库，请在 artifactsDir 产出具体的开发计划、变更说明与测试计划文档，要求具体、可评审、字段齐全。注意：若有 context.reworkFeedback（上一轮测试/验收未通过的打回意见），必须针对其问题逐条给出修复方案，并在产出中体现。";
    case "tester":
      return real
        ? "当前为「真实测试模式」：请基于真实代码执行测试命令并附真实结果与证据。"
        : "当前为「模拟测试模式」：开发产出为方案文档，测试基于方案与测试计划评审执行（用例结果可声明 planned/passed），但必须：①覆盖全部需求验收点；②给出明确的 pass/fail 结论；③fail 时附可执行的问题清单，供开发修复。";
    case "ops":
      return real
        ? "当前为「真实部署模式」：请按给定 mode 与 action 执行真实 kubectl 操作并给出真实证据。"
        : "当前为「模拟部署模式」：不执行真实命令，给出完整部署/回滚计划与模拟证据（命令、预期输出、namespace/版本/访问地址），deployed 应反映计划是否可执行。";
    case "evaluator":
      return "评估对象为需求本身，与流水线模式无关。";
  }
}

export function roleForStage(stage: StageKey): AgentTask["role"] {
  switch (stage) {
    case "evaluating":
      return "evaluator";
    case "dev_in_progress":
      return "developer";
    case "testing":
      return "tester";
    case "test_deploying":
    case "test_rollback":
    case "prod_deploying":
      return "ops";
    case "awaiting_acceptance":
      return "acceptance";
  }
}

/** 各阶段需要的上下文（传给 agent） */
export function buildStageContext(
  pipeline: Pipeline,
  stage: StageKey,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    pipelineId: pipeline.id,
    submission: pipeline.submission,
    previousAgentResults: pipeline.agents,
    evaluation: pipeline.evaluation,
  };
  switch (stage) {
    case "evaluating":
      break;
    case "dev_in_progress":
      base["developmentPlan"] = pipeline.evaluation;
      base["reworkCount"] = pipeline.reworkCount ?? 0;
      if (pipeline.reworkCount && pipeline.reworkCount > 0) {
        const fb = lastRework(pipeline);
        if (fb) base["reworkFeedback"] = { count: pipeline.reworkCount, from: fb.from, reason: fb.reason };
      }
      break;
    case "testing":
      base["devOutput"] = pipeline.agents.dev_in_progress?.output;
      base["testDeployInfo"] = pipeline.deploy?.test;
      break;
    case "test_deploying":
      base["deployTarget"] = {
        environment: "test",
        namespace: "demo-test",
        version: pipeline.agents.dev_in_progress?.output?.version ?? "latest",
      };
      break;
    case "test_rollback":
      base["rollback"] = {
        reason: lastRejectReason(pipeline),
        deployInfo: pipeline.deploy?.test,
      };
      break;
    case "awaiting_acceptance":
      base["deployTarget"] = { environment: "test" };
      base["deployInfo"] = pipeline.deploy?.test;
      base["devOutput"] = pipeline.agents.dev_in_progress?.output;
      base["testOutput"] = pipeline.agents.testing?.output;
      break;
    case "prod_deploying":
      base["deployTarget"] = {
        environment: "prod",
        namespace: "demo-prod",
        version: pipeline.agents.dev_in_progress?.output?.version ?? "latest",
      };
      base["testDeployInfo"] = pipeline.deploy?.test;
      base["acceptance"] = pipeline.acceptance;
      break;
  }
  const merged: Record<string, unknown> = { ...base, ...extra };
  if (stage === "test_rollback") {
    // extra 的 ops 不含 action，这里显式补上回滚动作
    merged.ops = { ...(extra.ops as Record<string, unknown> | undefined), action: "rollback" };
  }
  return merged;
}

/** 最近一次打回开发的事件（供开发 Agent 修复参考） */
function lastRework(pipeline: Pipeline): { from: string; reason: string } | undefined {
  for (let i = pipeline.events.length - 1; i >= 0; i -= 1) {
    const e = pipeline.events[i];
    if (e && e.type === "rework") return { from: e.from, reason: e.reason };
  }
  return undefined;
}

/** 最近一次验收拒绝的原因（供回滚任务说明） */
function lastRejectReason(pipeline: Pipeline): string {
  // 产品人工拒绝的备注优先
  for (let i = pipeline.events.length - 1; i >= 0; i -= 1) {
    const e = pipeline.events[i];
    if (e && e.type === "product_decision" && !e.accepted) return e.note || `产品验收未通过（${e.by}）`;
  }
  // 验收 Agent 的问题清单
  const issues = pipeline.acceptance?.issues;
  if (issues && issues.length > 0) return issues.join("；");
  const acc = pipeline.agents.awaiting_acceptance?.output;
  if (acc && Array.isArray(acc.issues) && (acc.issues as string[]).length > 0) {
    return (acc.issues as string[]).join("；");
  }
  return "验收未通过";
}
