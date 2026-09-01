# 通用 Agent 运行框架设计

## 目标

将网关从 DSH 专用运行时改造成通用 Agent 运行框架。编排器仅依赖统一的 `AgentRunner` 接口，通过 `AGENT_RUNTIME=opencode|codex` 在 OpenCode 与 Codex 间切换，并在所有成功、失败、并行与重试路径上完整统计实际模型请求用量。

## 范围

- 支持 `opencode run --format json` 与 `codex exec --json`。
- 统一配置运行时、CLI 路径、模型、调用超时和 Codex 沙箱权限。
- 归一化输入、输出、推理、缓存读取、缓存写入 Token，请求次数、会话 ID、模型、缓存命中率与 Provider 返回费用。
- 将用量写入 Agent 结果、阶段执行历史和流水线汇总，并在 Web 控制台展示。
- 多 Agent 契约轮、实现轮、坏输出自动重试、失败重试和恢复重跑均累计实际发生的请求。
- 删除 DSH 运行时、headless profile、profile 安装脚本及旧配置。
- 统一测试执行器为 `scripts/mock-agent.mjs`，补充两种 JSONL 协议及用量解析测试。
- 更新 README、架构、部署、使用、真实工程和测试文档。

## 运行时架构

编排器依赖以下统一接口，不导入任何具体 Provider：

```ts
export interface AgentRunner {
  readonly runtime: AgentRuntime;
  run(task: AgentTask, cwd: string): Promise<AgentRunResult>;
}
```

文件边界：

- `src/agents/runner.ts`：`AgentRunner`、`AgentRunResult`、运行时与错误状态类型。
- `src/agents/process.ts`：子进程启动、输出收集、超时终止和结构化进程结果。
- `src/agents/opencode-runner.ts`：OpenCode 参数组装、JSONL 解析和结果归一化。
- `src/agents/codex-runner.ts`：Codex 参数组装、JSONL 解析和结果归一化。
- `src/agents/provider.ts`：根据统一配置创建 Provider adapter。
- `src/agents/usage.ts`：请求级用量类型、空值、合并和缓存命中率计算。

`process.ts` 只负责进程生命周期，不理解 Agent 事件。Provider runner 负责将 stdout JSONL 转成最终文本、结构化 JSON 和用量。解析逻辑使用导出的纯函数，便于通过固定 JSONL fixture 测试。

## 配置

统一环境变量如下：

```dotenv
AGENT_RUNTIME=opencode
AGENT_CLI=opencode
AGENT_MODEL=
AGENT_TIMEOUT_MS=600000
CODEX_SANDBOX=workspace-write
```

- `AGENT_RUNTIME` 必须为 `opencode` 或 `codex`，默认 `opencode`。
- `AGENT_CLI` 为空时按运行时默认取 `opencode` 或 `codex`，支持绝对路径。
- `AGENT_MODEL` 为空时不传模型参数，沿用 CLI 自身配置。
- `AGENT_TIMEOUT_MS` 是单次 CLI 调用超时。
- `CODEX_SANDBOX` 允许 `read-only`、`workspace-write`、`danger-full-access`，默认 `workspace-write`，仅影响 Codex。

Web 配置接口展示运行时、CLI、模型、超时与 Codex 沙箱；不展示凭证。旧 `DSH_CLI`、`DSH_AGENT_TIMEOUT_MS` 不提供兼容别名，配置错误应在启动时显式失败。

## Provider 命令与输出

OpenCode runner 执行：

```text
<AGENT_CLI> run --format json --dir <cwd> [--model <AGENT_MODEL>] <AgentTask JSON>
```

它拼接所有 `text` 事件的 `part.text` 作为最终响应，并为每个 `step_finish` 生成一条请求用量。会话 ID 来自事件的 `sessionID`。模型事件缺失时使用配置模型，配置也为空则为 `unknown`。

Codex runner 执行：

```text
<AGENT_CLI> exec --json -C <cwd> --sandbox <CODEX_SANDBOX> [--model <AGENT_MODEL>] <AgentTask JSON>
```

它使用最后一个已完成 `agent_message` 的 `item.text` 作为最终响应，为每个 `turn.completed` 生成一条请求用量，并从 `thread.started.thread_id` 取得会话 ID。模型同样回退到配置模型或 `unknown`。

两种 runner 都对最终文本调用已有的宽容 JSON 提取逻辑，支持纯 JSON、围栏 JSON 和前后带说明的 JSON。

## 用量数据模型

每个实际模型完成事件生成一条明细：

```ts
export interface AgentRequestUsage {
  runtime: "opencode" | "codex";
  sessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}
```

`inputTokens` 是非缓存输入，`outputTokens` 不含推理 Token。归一化规则：

- OpenCode：直接映射 `part.tokens.input/output/reasoning/cache.read/cache.write` 与 `part.cost`。
- Codex：`inputTokens = max(input_tokens - cached_input_tokens, 0)`；`outputTokens = max(output_tokens - reasoning_output_tokens, 0)`；其余字段直接映射并将缺失值视为 0。

聚合类型 `AgentUsage` 包含五类 Token 总和、`requestCount`、去重后的 `sessionIds` 与 `models`、`cacheHitRate` 和 `costUsd`。

- `cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens)`，分母为 0 时为 0。
- 不平均子级命中率，每次都从合并后的 Token 重算。
- `costUsd` 仅累加 Provider 明确返回的费用；所有请求都未返回费用时为 `null`，避免把未知显示为免费。
- Token、费用和请求数按实际事件累加；会话与模型只在展示字段中去重。

## 持久化与聚合

- `AgentResult.usage` 保存一次 Agent 阶段调用包含的全部请求。
- `PipelineExecution.usage` 保存该阶段本轮的全部请求。
- `Pipeline.usage` 从全部 `executions[].usage` 派生，保存到流水线快照供列表和详情直接读取。
- `buildHistory()` 对旧数据安全地补零，并返回同一套流水线汇总。

普通阶段的一次 runner 调用直接写入 Agent 结果和执行历史。多 Agent 阶段在契约轮、实现轮和坏 JSON 自动重试后合并所有子调用用量，再写入一个阶段结果与执行历史。阶段失败、超时或进程非零退出也必须写入错误 `AgentResult` 与错误 `PipelineExecution`；只要输出流已出现用量事件，就保留该部分用量。

流水线汇总以执行历史为唯一来源重新计算，避免进程恢复、重复保存或 retry 造成双计数。旧流水线没有 `usage` 字段时按空用量处理，无需批量迁移文件。

## 错误处理

Provider runner 返回结构化状态 `ok | error | timeout`。超时会终止子进程并解析已收集的 stdout；进程启动失败时返回零用量错误。编排器根据状态、退出码和结构化输出决定阶段是否成功，同时无条件接收 runner 的用量。

JSONL 中单行损坏不会丢弃其他有效事件；解析器跳过无法解析的行。CLI 成功退出但没有可解析 Agent JSON 时仍视为阶段失败，并保留已解析的请求用量。Provider 费用、缓存写入或推理字段缺失不视为运行失败。

## Web 控制台与 API

流水线列表增加紧凑用量列，显示请求次数、总 Token 与 Provider 费用。详情页增加用量汇总卡片，展示：

- 输入、输出、推理 Token；
- 缓存读取、缓存写入 Token；
- 缓存命中率；
- 请求次数；
- 会话 ID 与模型；
- Provider 返回费用，未知时显示 `—`。

执行历史表为每轮增加请求数、Token 和费用，便于识别重试成本。阶段 Agent JSON 继续保留原有展示。`GET /api/pipelines/:id/history` 的 `stats` 增加 `usage`；流水线详情与列表通过持久化的 `pipeline.usage` 返回汇总。

## 测试策略

统一执行器 `scripts/mock-agent.mjs` 同时识别 OpenCode 与 Codex 参数：

- OpenCode 模式输出 `text`、一个或多个 `step_finish` JSONL 事件。
- Codex 模式输出 `thread.started`、`item.completed(agent_message)`、`turn.completed` JSONL 事件。
- 两种模式输出相同的角色业务 JSON，并支持现有全部 `MOCK_*` 故障开关。

新增单元测试覆盖：

- OpenCode 多个 `step_finish` 的 Token、费用、会话和请求数合并。
- Codex 输入/输出去除缓存与推理后的归一化，以及缓存写入字段。
- 损坏 JSONL 行、缺失可选字段、未知费用和空输出。
- Provider 工厂选择、默认 CLI、模型参数、超时与 Codex 沙箱参数。
- 聚合函数不平均命中率且不重复会话/模型展示值。

端到端测试分别以 `AGENT_RUNTIME=opencode` 和 `codex` 跑核心成功链路；现有完整编排场景至少使用默认 mock runtime 保持覆盖。额外断言多 Agent 两轮与坏输出重试的 `requestCount` 和 Token 均包含所有实际请求，失败后 retry 也保留前后两次执行用量。

完成前运行 `corepack pnpm test`、`corepack pnpm typecheck` 和 `corepack pnpm build`。

## 删除与文档

删除：

- `src/agents/dsh-runner.ts`
- `scripts/mock-dsh.mjs`
- `scripts/install-headless-profile.sh`
- `profiles/headless/`
- README、环境示例、部署脚本和文档中的全部 DSH/profile 指引

`scripts/demo-run.sh` 改为检查当前 `AGENT_RUNTIME` 对应 CLI，不再安装 profile。README、`docs/architecture.md`、`docs/deployment.md`、`docs/usage.md`、`docs/real-project-guide.md` 和 `docs/testing.md` 描述统一接口、两种运行时配置、权限边界、用量口径、Web 展示和测试方式。

## 非目标

- 不增加第三种运行时。
- 不自行估算 Codex 或其他 Provider 未返回的费用。
- 不引入数据库或单独的用量账本。
- 不实现运行时热切换；环境变量在进程启动时选择一个 Provider。
- 不增加 OpenCode 权限配置抽象；OpenCode 继续遵循其自身配置。
