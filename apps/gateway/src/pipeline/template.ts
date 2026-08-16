import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Agent 角色名（由 AgentRegistry 管理，内置 + 用户自定义扩展） */
export type AgentRole = string;

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

const TERMINALS = ["done", "rejected", "failed"];

/** 从对象构造并校验模板（供文件加载与 Web 控制台复用）。validAgents 缺省不校验 agent 存在性 */
export function parseTemplate(name: string, stages: unknown, validAgents?: string[]): PipelineTemplate {
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
    if (!agent) {
      throw new Error(`流程模板阶段 ${s.id} 缺少 agent`);
    }
    if (validAgents && !validAgents.includes(agent)) {
      throw new Error(`流程模板阶段 ${s.id} 的 agent 不存在：${s.agent}（可用：${validAgents.join(", ")}）`);
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

/** 加载流程模板文件（缺省内置） */
export function loadTemplate(filePath?: string): PipelineTemplate {
  if (!filePath) return DEFAULT_TEMPLATE;
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PipelineTemplate>;
  return parseTemplate(parsed.name ?? "", parsed.stages);
}

/** 内置模板名 */
export const BUILTIN_TEMPLATE_NAME = "default";

/**
 * 模板注册表（平台）：管理多个流程模板，可同时被不同流水线使用。
 * - 启动时扫描 registryDir 下的 *.json 全量注册；
 * - 内置 default 始终可用，不可删除；
 * - save() 动态注册/更新（写文件 + 内存生效），remove() 删除（写盘同步）；
 * - get(name) 按名取模板，流水线各自绑定互不干扰。
 */
export class TemplateRegistry {
  private readonly templates = new Map<string, PipelineTemplate>();
  private readonly dir?: string;
  private readonly validAgents?: string[];

  constructor(opts: { dir?: string; initial?: PipelineTemplate[]; validAgents?: string[] } = {}) {
    this.dir = opts.dir;
    this.validAgents = opts.validAgents;
    this.templates.set(BUILTIN_TEMPLATE_NAME, DEFAULT_TEMPLATE);
    for (const t of opts.initial ?? []) {
      if (t.name !== BUILTIN_TEMPLATE_NAME) this.templates.set(t.name, t);
    }
    this.scanDir();
  }

  /** 扫描注册目录：config/pipelines/*.json */
  private scanDir(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = loadTemplate(join(this.dir, file));
        if (parsed.name && parsed.name !== BUILTIN_TEMPLATE_NAME) {
          this.templates.set(parsed.name, parsed);
        }
      } catch {
        // 忽略非法模板文件（启动不阻塞，错误由 save 校验提示）
      }
    }
  }

  /** 全部模板（按名称排序，default 优先） */
  list(): PipelineTemplate[] {
    return [...this.templates.entries()]
      .sort(([a], [b]) => (a === BUILTIN_TEMPLATE_NAME ? -1 : b === BUILTIN_TEMPLATE_NAME ? 1 : a.localeCompare(b)))
      .map(([, t]) => t);
  }

  names(): string[] {
    return this.list().map((t) => t.name);
  }

  /** 按名取模板；不存在抛错 */
  get(name: string): PipelineTemplate {
    const t = this.templates.get(name);
    if (!t) throw new Error(`流程模板不存在：${name}（可用：${this.names().join(", ")}）`);
    return t;
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  /** 动态注册/更新模板（校验后写盘，立即生效）。内置 default 不可覆盖。 */
  save(name: string, stages: unknown): PipelineTemplate {
    if (name === BUILTIN_TEMPLATE_NAME) {
      throw new Error(`不允许覆盖内置模板 ${BUILTIN_TEMPLATE_NAME}，请换一个模板名`);
    }
    const parsed = parseTemplate(name, stages, this.validAgents);
    if (this.dir) {
      writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(parsed, null, 2), "utf8");
    }
    this.templates.set(name, parsed);
    return parsed;
  }

  /** 删除模板（default 不可删） */
  remove(name: string): void {
    if (name === BUILTIN_TEMPLATE_NAME) throw new Error(`不允许删除内置模板 ${BUILTIN_TEMPLATE_NAME}`);
    if (!this.templates.has(name)) throw new Error(`流程模板不存在：${name}`);
    this.templates.delete(name);
    if (this.dir) {
      const file = join(this.dir, `${name}.json`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
}
