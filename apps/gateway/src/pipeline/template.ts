import { readFileSync } from "node:fs";

/** 可用的 Agent 角色（内置 + 可扩展） */
export type AgentRole = "evaluator" | "developer" | "tester" | "reviewer" | "ops" | "acceptance";

/** 多 Agent 并行配置（如多开发 Agent 联调） */
export interface MultiStageConfig {
  /** 服务/模块列表，每个服务跑一个 agent 实例 */
  services: string[];
}

/** 流程模板中的单个阶段 */
export interface TemplateStage {
  /** 阶段 ID（内置：evaluating/dev_in_progress/testing/test_deploying/awaiting_acceptance/test_rollback/prod_deploying；也可自定义） */
  id: string;
  /** 该阶段使用的 Agent 角色 */
  agent: AgentRole;
  /** 成功后的下一阶段（终态：done/rejected/failed） */
  onSuccess: string;
  /** 失败后打回的目标阶段（缺省直接 failed；testing/验收等默认打回开发） */
  reworkTarget?: string;
  /** 运维阶段配置（action: deploy|rollback；env: test|prod） */
  ops?: { action: "deploy" | "rollback"; env: "test" | "prod" };
  /** 多 Agent 并行配置 */
  multi?: MultiStageConfig;
}

/** 流程模板：定义流水线的阶段序列与每个阶段的行为 */
export interface PipelineTemplate {
  name: string;
  stages: TemplateStage[];
}

/** 内置阶段集合（有专属编排逻辑） */
export const BUILTIN_STAGES = [
  "evaluating",
  "dev_in_progress",
  "testing",
  "test_deploying",
  "awaiting_acceptance",
  "test_rollback",
  "prod_deploying",
] as const;

/** 默认流程模板（与内置硬编码行为一致） */
export const DEFAULT_TEMPLATE: PipelineTemplate = {
  name: "default",
  stages: [
    { id: "evaluating", agent: "evaluator", onSuccess: "dev_in_progress" },
    { id: "dev_in_progress", agent: "developer", onSuccess: "testing" },
    { id: "testing", agent: "tester", onSuccess: "test_deploying", reworkTarget: "dev_in_progress" },
    { id: "test_deploying", agent: "ops", onSuccess: "awaiting_acceptance", ops: { action: "deploy", env: "test" } },
    { id: "awaiting_acceptance", agent: "acceptance", onSuccess: "prod_deploying", reworkTarget: "dev_in_progress" },
    { id: "test_rollback", agent: "ops", onSuccess: "dev_in_progress", ops: { action: "rollback", env: "test" } },
    { id: "prod_deploying", agent: "ops", onSuccess: "done", ops: { action: "deploy", env: "prod" } },
  ],
};

const VALID_AGENTS: AgentRole[] = ["evaluator", "developer", "tester", "reviewer", "ops", "acceptance"];
const TERMINALS = ["done", "rejected", "failed"];

/** 从对象构造并校验模板（供文件加载与 Web 控制台复用） */
export function parseTemplate(name: string, stages: unknown): PipelineTemplate {
  if (!name || typeof name !== "string") throw new Error("流程模板缺少 name");
  if (!Array.isArray(stages) || stages.length === 0) throw new Error("流程模板需要非空 stages 数组");
  const rawStages = stages as Array<Partial<TemplateStage>>;
  const ids = new Set<string>();
  for (const s of rawStages) {
    if (!s.id || !s.agent) throw new Error(`流程模板阶段缺少 id/agent：${JSON.stringify(s)}`);
    if (ids.has(s.id)) throw new Error(`流程模板阶段 id 重复：${s.id}`);
    ids.add(s.id);
  }
  for (const s of rawStages) {
    const agent = s.agent as AgentRole | undefined;
    if (!agent || !VALID_AGENTS.includes(agent)) {
      throw new Error(`流程模板阶段 ${s.id} 的 agent 非法：${s.agent}（可选：${VALID_AGENTS.join("/")}）`);
    }
    if (s.onSuccess && !ids.has(s.onSuccess) && !TERMINALS.includes(s.onSuccess)) {
      throw new Error(`流程模板阶段 ${s.id} 的 onSuccess 引用未定义阶段：${s.onSuccess}`);
    }
    if (s.reworkTarget && !ids.has(s.reworkTarget)) {
      throw new Error(`流程模板阶段 ${s.id} 的 reworkTarget 引用未定义阶段：${s.reworkTarget}`);
    }
  }
  return { name, stages: rawStages as TemplateStage[] };
}

/** 加载流程模板：缺省内置；PIPELINE_TEMPLATE 指向 JSON 文件时加载并校验 */
export function loadTemplate(filePath?: string): PipelineTemplate {
  if (!filePath) return DEFAULT_TEMPLATE;
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PipelineTemplate>;
  return parseTemplate(parsed.name ?? "", parsed.stages);
}
