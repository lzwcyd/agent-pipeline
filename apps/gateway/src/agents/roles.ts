import type { AgentTask, Pipeline, StageKey } from "../types.js";
import type { AgentRole } from "../pipeline/template.js";
import { COMMON_RULES_TEXT, ROLE_PROMPTS } from "./prompts.js";

/** 构建某阶段的 Agent 任务（role 由流程模板指定） */
export function buildAgentTask(
  pipeline: Pipeline,
  stage: string,
  role: AgentRole,
  context: Record<string, unknown>,
  artifactsDir: string,
): AgentTask {
  const prompt = ROLE_PROMPTS[role];
  const modeNote = modeNoteFor(role, context);
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

/** 按流水线模式与多服务联调阶段给角色补充行为说明 */
function modeNoteFor(role: AgentRole, context: Record<string, unknown>): string {
  const real = context.pipelineMode === "real";
  const phase = context.phase;
  switch (role) {
    case "acceptance":
      return real
        ? "当前为「真实交付模式」：开发产出为真实代码、测试已执行、部署为真实 Kubernetes 操作，请按真实生产标准严格验收。"
        : "当前为「模拟流水线模式」：开发产出为方案/变更文档（artifactsDir 下）、测试为计划、部署为模拟执行（有部署计划与证据）。验收标准调整为：①需求覆盖度；②方案与测试计划完整性；③部署证据充分性。若上述齐备且无关键缺口，应判定 accepted=true；如有真实缺口可给 warn 但不要仅因『未真实开发/未真实部署』判失败。";
    case "developer":
      return real
        ? "当前为「真实交付模式」：请在指定代码仓库完成真实实现并执行测试。"
        : `当前为「模拟开发模式」：不需要修改真实代码仓库，请在 artifactsDir 产出具体的开发计划、变更说明与测试计划文档，要求具体、可评审、字段齐全。${
            phase === "contract"
              ? "【多服务联调·契约轮】你是该服务的开发负责人。完整契约必须作为 JSON 对象输出到 stdout（含 basePath、endpoints、请求/响应结构、依赖的其他服务接口）；可以额外写文件辅助说明，但 stdout 的 JSON 才是契约本体，不要只在文件里。"
              : phase === "implement"
                ? "【多服务联调·实现轮】其他服务的契约已通过 context.teamContracts 提供，请基于这些契约完成本服务的开发方案，确保接口相互匹配（可指出需要其他团队配合的点）。"
                : ""
          }${context.reworkFeedback ? `\n注意：上一轮打回意见：${JSON.stringify(context.reworkFeedback)}` : ""}`;
    case "tester":
      return real
        ? "当前为「真实测试模式」：请基于真实代码执行测试命令并附真实结果与证据。"
        : "当前为「模拟测试模式」：开发产出为方案文档，测试基于方案与测试计划评审执行（用例结果可声明 planned/passed），但必须：①覆盖全部需求验收点；②给出明确的 pass/fail 结论；③fail 时附可执行的问题清单，供开发修复。";
    case "reviewer":
      return real
        ? "当前为「真实评审模式」：请基于真实代码仓库与 diff 评审。"
        : "当前为「模拟评审模式」：请基于开发产出文档评审设计合理性、需求覆盖与潜在风险，给出明确 approved/不通过结论与问题清单。";
    case "ops":
      return real
        ? "当前为「真实部署模式」：请按给定 mode 与 action 执行真实 kubectl 操作并给出真实证据。"
        : "当前为「模拟部署模式」：不执行真实命令，给出完整部署/回滚计划与模拟证据（命令、预期输出、namespace/版本/访问地址），deployed 应反映计划是否可执行。";
    case "evaluator":
      return "评估对象为需求本身，与流水线模式无关。";
  }
}

/** 环境 → namespace 映射 */
export function namespaceForEnv(env: string): string {
  return env === "prod" ? "demo-prod" : "demo-test";
}

/** 各阶段需要的上下文（传给 agent）。extra 中可含 ops 配置（来自流程模板） */
export function buildStageContext(
  pipeline: Pipeline,
  stage: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const ops = (extra.ops ?? {}) as Record<string, unknown>;
  const env = String(ops.env ?? "test");
  const base: Record<string, unknown> = {
    pipelineId: pipeline.id,
    submission: pipeline.submission,
    previousAgentResults: pipeline.agents,
    evaluation: pipeline.evaluation,
    templateStage: extra.templateStage,
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
        environment: env,
        namespace: namespaceForEnv(env),
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
        environment: env,
        namespace: namespaceForEnv(env),
        version: pipeline.agents.dev_in_progress?.output?.version ?? "latest",
      };
      base["testDeployInfo"] = pipeline.deploy?.test;
      base["acceptance"] = pipeline.acceptance;
      break;
    default:
      // 自定义阶段：透传上一阶段产出
      base["stageOutput"] = pipeline.agents[stage]?.output;
      break;
  }
  const merged: Record<string, unknown> = { ...base, ...extra };
  if (stage === "test_rollback") {
    // extra 的 ops 不含 action，这里显式补上回滚动作
    merged.ops = { ...ops, action: "rollback" };
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
  for (let i = pipeline.events.length - 1; i >= 0; i -= 1) {
    const e = pipeline.events[i];
    if (e && e.type === "product_decision" && !e.accepted) return e.note || `产品验收未通过（${e.by}）`;
  }
  const issues = pipeline.acceptance?.issues;
  if (issues && issues.length > 0) return issues.join("；");
  const acc = pipeline.agents.awaiting_acceptance?.output;
  if (acc && Array.isArray(acc.issues) && (acc.issues as string[]).length > 0) {
    return (acc.issues as string[]).join("；");
  }
  return "验收未通过";
}

export type { AgentRole, StageKey };
