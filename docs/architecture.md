# 架构设计：agent-pipeline 多 Agent 研发交付流水线

## 1. 总览

```
┌────────────────────────── 外部（钉钉/飞书） ──────────────────────────┐
│ 收集单提交事件                                                       │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         pipeline-gateway（Node/TS）                    │
│  ┌────────────┐  ┌─────────────────┐  ┌───────────────────────────┐  │
│  │ FormSource │  │   Orchestrator   │  │       Notifier            │  │
│  │ mock/feishu│→ │ 状态机+持久化     │→ │ console/飞书/钉钉机器人      │  │
│  │ /dingtalk  │  │ 后台驱动流水线     │  │                           │  │
│  └────────────┘  └───────┬─────────┘  └───────────────────────────┘  │
│                          │                                           │
│                  AgentRunner（统一接口）                                │
└──────────────────────────┼───────────────────────────────────────────┘
                           ▼
             Provider Factory（AGENT_RUNTIME）
                 ┌─────────┴─────────┐
                 ▼                   ▼
        OpenCodeRunner          CodexRunner
        opencode run            codex exec --json
                           │
              ┌────────────┼─────────────┬──────────────┬───────────┐
              ▼            ▼             ▼              ▼           ▼
        需求评估 Agent  开发 Agent   测试 Agent    运维 Agent    验收 Agent    运维 Agent
                                    （门禁）     （部署/回滚）               （部署/回滚）
```

## 2. 核心概念

### 2.1 触发源（FormSource）与标准结构

所有触发源产出**同一标准结构** `FormSubmission`（含 `meta.triggerType` 与可选的 `policy`），进入同一条流水线：

| 触发源 | 验签 | 触发方式 |
| --- | --- | --- |
| `mock` | 无 | `POST /api/mock/submit`（开发/演示） |
| `feishu` | `X-Lark-Signature`（SHA256(timestamp+nonce+encryptKey+body)）+ AES-256-CBC 解密，或明文 token | `POST /webhooks/feishu` |
| `dingtalk` | `sign`（HMAC-SHA256(timestamp+"\n"+secret)） | `POST /webhooks/dingtalk` |
| `api` | 无（标准结构） | `POST /api/pipelines` |

触发级策略 `SubmissionPolicy`（覆盖环境变量）：`acceptanceFailure`（rollback/rework/reject）、`autoAccept`、`maxRework`。表单触发在字段 `_policy` 中携带，API 触发在 `policy` 字段中携带。

字段归一化采用**启发式键匹配**（精确优先、子串兜底），标题/描述/提交人的候选键见各适配器 `DEFAULT_FIELD_KEYS`，真实接入时按自家收集单字段调整。

### 2.2 Agent 任务契约

每个角色接收同一个 `AgentTask` JSON；编排器不关心所选 CLI：

```jsonc
{
  "pipelineId": "...",
  "role": "evaluator | developer | tester | ops | acceptance",
  "stage": "evaluating | dev_in_progress | testing | test_deploying | awaiting_acceptance | test_rollback | prod_deploying",
  "requirement": { "title": "...", "description": "...", "submitter": "...", "fields": {} },
  "context": { "pipelineMode": "simulation|real", "ops": {...}, "deployTarget": {...}, "previousAgentResults": {...} },
  "instructions": "<角色 persona + 模式说明 + 输出 schema + 规则>",
  "artifactsDir": "data/artifacts/<pipelineId>/<stage>/"
}
```

输出契约：agent 的 stdout **只包含一个 JSON 对象**（允许围栏代码块/前文，网关 `extractJson` 兜底解析）。schema：

- evaluator → `{approved, score, reasons[], missingInfo[], suggestedPriority}`
- developer → `{status, plan, changes[], tests[], version, notes}`
- tester → `{status: pass|fail, summary, testCases[], coverage, issues[], evidence[]}`
- ops → `{deployed, mode, namespace, revision, url, evidence[], warnings[]}`（部署与回滚共用，`context.ops.action` 区分）
- acceptance → `{accepted, verdicts[], issues[], note}`

### 2.2.1 Provider Adapter 与进程边界

`AgentRunner.run(task, cwd)` 返回统一的 `AgentRunResult`：`status`、退出码、stdout/stderr、结构化输出、错误和 `AgentUsage`。`Orchestrator` 只依赖此接口。

- `provider.ts` 按 `AGENT_RUNTIME=opencode|codex` 创建 Provider。
- `OpenCodeRunner` 执行 `opencode run --format json --dir <cwd> [--model ...] <task>`，拼接 `text` 事件并按每个 `step_finish` 统计请求。
- `CodexRunner` 执行 `codex exec --json -C <cwd> --sandbox <mode> [--model ...] <task>`，读取最后一个 `agent_message` 并按每个 `turn.completed` 统计请求。
- 所有单 Agent、并行子任务和重试的 `cwd` 均为配置的工作区根（指定工程时为工程根，否则为数据目录）；`task.artifactsDir` 仍按流水线、阶段和服务隔离，避免 Codex 沙箱被误限制在产物子目录。
- `process.ts` 只负责启动、超时终止和收集输出；超时后等待 `close` 排空管道，最多额外等待 1 秒。协议解析完全留在 Provider。
- 单行损坏的 JSONL 被跳过；CLI 失败或最终业务 JSON 不可解析时仍保留已经收到的用量。

### 2.2.2 可定制编排（流程模板）

流程由 `PipelineTemplate`（JSON）定义：阶段序列 + 每阶段 agent 角色 + 流转（onSuccess/reworkTarget/ops/multi）。默认模板与内置行为一致；`PIPELINE_TEMPLATE` 指向自定义模板即可增删 agent 节点。模板加载时校验引用完整性；自定义阶段（非内置）走通用判定 `genericVerdict(role, output)` 并按其角色语义推进/打回/拒绝。多 Agent 并行（`multi.services`）见 §2.5。

### 2.3 状态机、持久化与历史

状态与迁移见 README。内置阶段迁移由 TRANSITIONS 约束，自定义阶段由模板声明流转（transition 的 allowed 参数）。持久化两处：

- `data/pipelines/<id>.json`：流水线全量快照（事件、Agent 结果、**executions 历史与用量**、流水线用量汇总、产物清单），原子写（tmp+rename）。
- `data/artifacts/<id>/<stage>/`：阶段产物目录（不是 CLI 工作目录），产出文件（dev-plan.md、rendered-manifests.yaml 等）由网关登记进流水线。

**历史执行信息**：每次阶段执行追加 `PipelineExecution {stage, round, status, startedAt, finishedAt, durationMs, output?, error?, usage?}`。打回、自动重试和人工 retry 不覆盖历史。`buildHistory()` 从执行记录派生 `stats.usage`，旧快照缺少用量时按零处理。

成功调用的 Agent 结果、执行历史和用量在阶段推进前立即持久化；若之后中断，恢复重跑会追加新轮次并保留已有请求。旧快照中缺失或无效的会话/模型数组按空数组处理。

### 2.3.1 统一用量模型

请求级 `AgentRequestUsage` 归一化为非缓存输入、可见输出、推理、缓存读写 Token、会话、模型与可选 Provider 费用。聚合后的 `AgentUsage` 还包含请求数和缓存命中率。

- Codex 输入扣除 `cached_input_tokens`，输出扣除 `reasoning_output_tokens`；计数不一致时下限为零。
- 缓存命中率 = `cacheReadTokens / (inputTokens + cacheReadTokens)`，每次合并后重算而非平均。
- Token、请求和费用累加；会话 ID、模型仅去重展示；没有 Provider 费用时为 `null`，不自行估价。
- 普通阶段写入一次 runner 用量；多 Agent 阶段合并契约轮、实现轮和所有重试；失败、超时以及重试调用抛错时也保留已收集用量。
- `Pipeline.usage` 只从 `executions[].usage` 派生，是持久化与 Web/API 展示的单一汇总来源。

### 2.4 日志

pino 结构化 JSON 日志：stdout + `data/logs/pipeline.log`。关键事件（流水线创建、阶段开始/完成、agent 调用开始/结束含耗时与退出码、失败/重试）都带 `pipelineId/stage/role` 字段；`GET /api/logs` 支持按 `pipelineId`/`level` 过滤尾部日志。

### 2.5 多 Agent 并行联调

模板阶段配置 `multi: {services: [...]}` 后，该阶段分两轮并行执行：
1. **契约轮**：每服务一个 agent 实例输出接口契约；
2. **汇总广播**：网关收集全部契约注入 `context.teamContracts`（agent 间"通信"）；
3. **实现轮**：每服务基于团队契约产出实现方案。

子任务输出不可解析时自动带提示重试一次；结果按服务聚合到 `agents[stage].output.services`，产物按服务子目录隔离。

### 2.6 编排器（Orchestrator）

- `startSubmission()`：建流水线，**异步驱动**（webhook 秒回 202）。
- `runStage()`：校验迁移 → 组装任务 → 调用统一 `AgentRunner` → 持久化结果/用量 → 按角色推进。
- **测试门禁**：`testing` 阶段由独立测试 Agent 把关，`status=pass` 才进入部署；否则 `reworkToDev()` 打回开发（附问题清单）。
- **验收失败策略**：`handleAcceptanceFailure()` 按 `policyOf(p).acceptanceFailure`（触发级 `policy` > 环境变量 `ACCEPTANCE_FAILURE_POLICY`）分派：
  - `rollback`：进入 `test_rollback`（运维 Agent 回滚测试环境），成功后再打回开发；回滚失败直接终止；
  - `rework`：直接打回开发（不回滚）；
  - `reject`：直接终止为 failed。
- **打回上限**：`reworkToDev()` 累计 `reworkCount`，超过 `maxRework`（触发级 > `MAX_REWORK`）终止为 failed（事件 `rework` 记录来源与原因）。
- `awaiting_acceptance` 人工闸门：验收 Agent 预检 → `autoAccept`（触发级 > `AUTO_ACCEPT`）自动放行 / false 等 `productDecision()`。
- `retry()`：failed 后回到失败阶段重跑（事件 `retried`）。
- 运维阶段校验 `deployed === true`，否则判阶段失败。
- 每次执行（成功/失败）都记录到 `executions[]`，并从实际 Provider 请求合并用量。

## 3. 角色 Agent 设计

| 角色 | 输入要点 | 判定逻辑 | 产物 |
| --- | --- | --- | --- |
| 需求评估 | 需求字段 | 清晰度/可行性/影响范围/优先级 → approved | 评分、理由、缺失信息 |
| 开发 | 评估结论、上下文（含 reworkFeedback） | 拆解任务、产出文档（模拟）/真实代码（real） | dev-plan / change-notes / tests |
| 测试 | 需求+开发产出+测试计划 | 覆盖需求验收点 → pass/fail（fail 附问题清单打回） | 用例结果、覆盖说明、证据 |
| 运维 | 部署/回滚目标、清单目录、模式、action | kubectl（真实）或 simulated（计划+证据） | deploy/rollback-plan、rendered-manifests |
| 验收 | 需求+开发+测试+部署信息 | 需求覆盖/方案完整/测试通过/部署证据（simulation）或真实验收（real） | verdicts / issues |

`PIPELINE_MODE` 通过 `modeNoteFor()` 注入各角色指令，避免模拟模式下验收 Agent 误判“无真实代码=不通过”。

## 4. 扩展点

- **新表单源**：实现 `FormSource`，注册进 `createFormSources()`，加 webhook 路由即可。
- **真实代码仓库**：`PIPELINE_MODE=real` + 给开发 Agent 注入仓库路径（context），并放开其写入权限。
- **真实集群**：安装 kubectl 后 `OPS_MODE=auto` 自动切 kubectl；`k8s/demo-app` 为示例应用，替换为真实服务。
- **通知渠道**：实现 `Notifier` 加入 `CompositeNotifier`。
- **人工验收**：对接企业 IM 的审批卡片（飞书消息卡片/钉钉互动卡片），点击回调 accept 接口。
