import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Agent 判定规则：阶段输出如何判定 pass/fail */
export interface AgentVerdict {
  /** 通过条件字段 */
  passWhen: "approved" | "status-ok" | "status-pass" | "deployed" | "accepted";
  /** 不通过时的处理：reject（终止为 rejected）| rework（打回开发） */
  onFail: "reject" | "rework";
}

/** Agent 定义（内置 + 用户自定义，均可被流程模板引用） */
export interface AgentDefinition {
  /** 角色名（模板 agent 字段引用，如 evaluator / security-reviewer） */
  name: string;
  /** 展示名（可选） */
  label?: string;
  /** 描述（可选） */
  description?: string;
  /** 角色定位 persona（拼入 agent 指令） */
  persona: string;
  /** 输出 JSON schema 描述 */
  outputSchema: string;
  /** 输出判定规则 */
  verdict: AgentVerdict;
  /** 内置 agent 不可删除/覆盖 */
  builtin?: boolean;
}

/** 内置 Agent 定义 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "evaluator",
    label: "需求评估 Agent",
    description: "评估需求清晰度/可行性/优先级，决定是否进入研发流水线",
    persona: `你是「需求评估 Agent」。负责评估一条来自收集单（钉钉/飞书）的需求是否值得进入研发流水线：
- 检查需求描述是否清晰、完整、可执行；
- 评估可行性、影响范围与优先级；
- 明确给出通过/不通过的决定与理由。`,
    outputSchema: `{
  "approved": boolean,            // 是否通过评估
  "score": number,                // 0-100 分
  "reasons": string[],            // 决定理由（2-4 条）
  "missingInfo": string[],        // 缺失的关键信息（可为空数组）
  "suggestedPriority": "P0"|"P1"|"P2"   // 建议优先级
}`,
    verdict: { passWhen: "approved", onFail: "reject" },
    builtin: true,
  },
  {
    name: "developer",
    label: "开发 Agent",
    description: "把需求转化为开发方案/实现（支持多 Agent 并行联调）",
    persona: `你是「开发 Agent」。负责把已通过评估的需求转化为可落地的开发方案：
- 把需求拆解为具体的开发任务与变更清单；
- 在 artifactsDir 下产出开发产物（开发计划 dev-plan.md、变更说明 change-notes.md、测试计划 tests.md）；
- 当前为模拟开发模式：不要求修改真实代码仓库，但产出必须具体、可评审。`,
    outputSchema: `{
  "status": "ok"|"skipped",
  "plan": string,                 // 开发计划摘要
  "changes": [{"file": string, "summary": string}],   // 变更清单
  "tests": [{"name": string, "type": "unit"|"integration"|"e2e"|"manual", "command": string, "result": "passed"|"planned"}],
  "version": string,              // 建议的版本号，如 v1.2.0
  "notes": string                 // 备注（可为空字符串）
}`,
    verdict: { passWhen: "status-ok", onFail: "rework" },
    builtin: true,
  },
  {
    name: "tester",
    label: "测试 Agent",
    description: "独立于开发，执行测试并给出 pass/fail 门禁结论",
    persona: `你是「测试 Agent」。独立于开发 Agent，负责对开发交付执行测试：
- 结合需求、开发产出（artifactsDir 下的方案文档）与测试计划，设计并执行测试；
- 给出明确的测试结论：通过（pass）或打回（fail，附问题清单）；
- 测试是产品验收的前置门禁：测试不通过不进入部署与验收。`,
    outputSchema: `{
  "status": "pass"|"fail",        // 测试结论
  "summary": string,              // 测试总结
  "testCases": [{"name": string, "type": "unit"|"integration"|"e2e"|"manual", "result": "passed"|"failed"|"planned"}],
  "coverage": string,             // 覆盖说明（需求验收点覆盖情况）
  "issues": string[],             // 失败项/问题清单（可为空数组）
  "evidence": string[]            // 测试证据（可为空数组）
}`,
    verdict: { passWhen: "status-pass", onFail: "rework" },
    builtin: true,
  },
  {
    name: "reviewer",
    label: "代码评审 Agent",
    description: "对开发产出做设计/质量评审（独立于开发与测试）",
    persona: `你是「代码评审 Agent」。负责对开发产出进行质量评审（独立于开发与测试）：
- 结合需求与开发产出（artifactsDir 下的方案/变更说明）评审设计合理性、变更完整性、潜在风险；
- 给出明确评审结论：通过（approved）或打回（不通过，附问题清单）。`,
    outputSchema: `{
  "approved": boolean,            // 评审是否通过
  "summary": string,              // 评审总结
  "issues": string[],             // 问题清单（可为空数组）
  "suggestions": string[]         // 改进建议（可为空数组）
}`,
    verdict: { passWhen: "approved", onFail: "rework" },
    builtin: true,
  },
  {
    name: "ops",
    label: "运维 Agent",
    description: "部署/回滚（Kubernetes kubectl 或 SSH 到 KVM/传统服务器）",
    persona: `你是「运维 Agent」。负责把应用部署到目标环境或执行回滚：
- 依据部署目标（context.ops.target）与动作（context.ops.action = deploy|rollback）执行；
- 目标 k8s（Kubernetes）：按清单部署（manifestsDir + overlayDir），kubectl apply / rollout / undo；
- 目标 ssh（KVM/传统服务器）：把构建产物（context.ops.ssh.artifact，相对开发产物目录）通过 scp 上传到
  context.ops.ssh.deployDir，然后 systemctl restart context.ops.ssh.service 重启，并用 curl 健康检查；
  回滚 = 恢复上一份产物并重启服务；
- 模式（context.ops.mode）：kubectl/ssh 为真实执行，simulated 为输出完整计划与模拟证据；
- 输出结果：deployed、namespace/主机、revision（版本）、url、evidence（命令与输出）、warnings。`,
    outputSchema: `{
  "deployed": boolean,            // 部署/回滚是否成功
  "mode": "kubectl"|"simulated",
  "namespace": string,
  "revision": string,             // 部署版本或回滚到的版本
  "url": string,
  "evidence": string[],          // 部署/回滚证据（命令/输出/说明）
  "warnings": string[]           // 警告（可为空数组）
}`,
    verdict: { passWhen: "deployed", onFail: "rework" },
    builtin: true,
  },
  {
    name: "acceptance",
    label: "产品验收 Agent",
    description: "站在产品/QA 角度对测试环境交付做验收预检",
    persona: `你是「产品验收 Agent」。站在产品/QA 角度对测试环境中的交付进行验收：
- 结合需求描述、开发产出与测试环境部署信息逐项核对；
- 给出每个验收项的结论与整体验收决定；
- 验收不通过时给出明确问题清单，便于打回。`,
    outputSchema: `{
  "accepted": boolean,
  "verdicts": [{"item": string, "result": "pass"|"fail"|"warn"}],
  "issues": string[],            // 不通过项/问题（可为空数组）
  "note": string                 // 总体说明（可为空字符串）
}`,
    verdict: { passWhen: "accepted", onFail: "rework" },
    builtin: true,
  },
];

/**
 * Agent 注册表（平台）：管理 Agent 定义（内置 + 用户自定义扩展）。
 * - 启动扫描 agentsDir 下的 *.json 注册自定义 agent；
 * - 内置 6 个 agent 始终可用，不可删除/覆盖；
 * - save() 动态注册/更新（立即生效），remove() 删除。
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly dir?: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir;
    for (const a of BUILTIN_AGENTS) this.agents.set(a.name, { ...a, builtin: true });
    this.scanDir();
  }

  private scanDir(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as AgentDefinition;
        if (parsed.name && !this.agents.has(parsed.name)) {
          this.agents.set(parsed.name, { ...parsed, builtin: false });
        }
      } catch {
        // 忽略非法文件
      }
    }
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) =>
      a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1,
    );
  }

  names(): string[] {
    return [...this.agents.keys()];
  }

  get(name: string): AgentDefinition {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Agent 定义不存在：${name}（可用：${this.names().join(", ")}）`);
    return a;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  /** 动态注册/更新自定义 agent（内置不可覆盖） */
  save(def: AgentDefinition): AgentDefinition {
    const { name } = def;
    if (!name) throw new Error("Agent 定义缺少 name");
    if (this.agents.get(name)?.builtin) {
      throw new Error(`不允许覆盖内置 Agent：${name}，请使用新的 agent 名`);
    }
    if (!VALID_PASS_WHEN.includes(def.verdict?.passWhen)) {
      throw new Error(`Agent ${name} 的 verdict.passWhen 非法：${def.verdict?.passWhen}（可选：${VALID_PASS_WHEN.join("/")}）`);
    }
    if (def.verdict?.onFail !== "reject" && def.verdict?.onFail !== "rework") {
      throw new Error(`Agent ${name} 的 verdict.onFail 非法（可选：reject/rework）`);
    }
    const cleaned: AgentDefinition = {
      name,
      label: def.label,
      description: def.description,
      persona: def.persona,
      outputSchema: def.outputSchema,
      verdict: def.verdict,
      builtin: false,
    };
    if (this.dir) {
      writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(cleaned, null, 2), "utf8");
    }
    this.agents.set(name, cleaned);
    return cleaned;
  }

  remove(name: string): void {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Agent 定义不存在：${name}`);
    if (a.builtin) throw new Error(`不允许删除内置 Agent：${name}`);
    this.agents.delete(name);
    if (this.dir) {
      const file = join(this.dir, `${name}.json`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
}

const VALID_PASS_WHEN: AgentVerdict["passWhen"][] = ["approved", "status-ok", "status-pass", "deployed", "accepted"];

/** 按 Agent 判定规则解析阶段输出 → pass / fail / reject */
export function verdictOf(def: AgentDefinition, out: Record<string, unknown>): "pass" | "fail" | "reject" {
  let pass = false;
  switch (def.verdict.passWhen) {
    case "approved":
    case "deployed":
    case "accepted":
      pass = out[def.verdict.passWhen] === true;
      break;
    case "status-ok":
      pass = out.status === "ok" || out.status === "skipped";
      break;
    case "status-pass":
      pass = out.status === "pass";
      break;
  }
  return pass ? "pass" : (def.verdict.onFail === "reject" ? "reject" : "fail");
}
