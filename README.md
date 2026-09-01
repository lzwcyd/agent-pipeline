# agent-pipeline：多 Agent 研发交付流水线

从需求触发到生产交付的多 Agent 研发流水线：监听 **钉钉/飞书收集单**（或标准接口）提交的需求，自动编排 **需求评估 → 开发（可多 Agent 并行联调）→ 测试 → 测试环境部署 → 产品验收 → 生产部署** 等 Agent 阶段：

```
触发（钉钉/飞书表单 · 标准接口 · 模拟器）
   │  （验签 → 归一化为标准结构 FormSubmission）
   ▼
┌──────────────┐  评估通过   ┌──────────────────┐  开发完成   ┌──────────────┐  测试通过
│ 需求评估 Agent │ ─────────▶ │ 开发 Agent（可多个，│ ─────────▶ │   测试 Agent   │ ────────┐
└──────────────┘            │ 契约联调并行开发）  │            └──────────────┘         │
   │ 不通过（拒绝）                 ▲            │               │ 不通过（打回开发）      │
   ▼                              │            │               ▼                       ▼
 rejected（终态）      测试/验收/评审未通过─┼───┐    ┌────────────────┐        ┌────────────────┐
                        打回开发（≤MAX_REWORK）  │    │ 运维 Agent（测试）│        │ 运维 Agent（测试）│
                                    │           │    └────────────────┘        └────────────────┘
                                    └───────────┴── 回滚测试环境（验收失败按策略）       │
                                                             │ 部署到测试环境
                                                             ▼
                                                   ┌────────────────┐
                                                   │ 产品验收（Agent 预检+人工确认）│
                                                   └────────────────┘
                                                         │ 通过
                                                         ▼
                                                ┌────────────────┐
                                                │ 运维 Agent（生产）│ ──▶ done
                                                └────────────────┘
```

- **通用 Agent 运行时**：编排器只依赖 `AgentRunner`；通过 `AGENT_RUNTIME=opencode|codex` 选择 `opencode run` 或 `codex exec --json`，Provider JSONL 输出统一为结构化结果与用量。
- **统一用量**：输入、输出、推理、缓存读写 Token、命中率、请求数、会话、模型与 Provider 费用写入阶段和流水线，并在 Web 展示；并行与重试按全部实际请求累计。
- **模板平台**：多个流程模板并存、同时使用、互不干扰——触发时按需求选择模板（`policy.template` 或页面下拉），Web 保存新模板**立即生效**（动态注册），可增删 Agent 节点；**模板快照**保证修改模板不影响已触发流水线。
- **Agent 定义管理**：内置 6 个 Agent + 用户自定义扩展（persona/schema/判定规则），新角色无需改代码，见 [docs/usage.md](docs/usage.md#6-agent-定义管理与自定义扩展)。
- **平台韧性**：进程重启后**自动恢复**未完成的流水线（从断点续跑，人工验收等待不受打扰）。
- **多开发 Agent 联调**：开发阶段支持 `multi` 配置，多服务并行开发，**契约轮 → 汇总广播 → 实现轮**模拟团队联调，见 [docs/usage.md](docs/usage.md#5-多开发-agent-并行联调分布式系统)。
- **表单接入**：可插拔适配器。`mock`（模拟器）随时可用；`feishu`/`dingtalk` 适配器已实现验签与字段归一化；另有**标准接口触发** `POST /api/pipelines`。
- **部署**：支持 **Kubernetes（kubectl）** 与 **KVM/传统服务器（SSH：scp + systemctl）** 两种目标，可模板按环境指定；无真实目标时自动降级 simulated（输出完整计划与证据）。
- **日志**：pino 结构化日志（console + `data/logs/pipeline.log`），支持 `GET /api/logs` 查询。
- **开发模式**：`PIPELINE_MODE=simulation`（默认）产出方案文档；`real` 模式要求真实代码与真实部署。

**文档**：[部署文档](docs/deployment.md) · [使用文档](docs/usage.md) · [真实工程接入指南](docs/real-project-guide.md) · [架构设计](docs/architecture.md)

## 目录结构

```
├── apps/gateway/            # Node.js/TypeScript 网关（Express）
│   └── src/
│       ├── forms/           # 触发源：mock / feishu / dingtalk / api（统一归一化 + 验签）
│       ├── pipeline/        # 状态机、流程模板、持久化、编排器、历史视图
│       ├── agents/          # AgentRunner、OpenCode/Codex Provider、用量、角色与任务
│       ├── notify/          # 通知器：console / 飞书机器人 / 钉钉机器人
│       ├── public/          # Web 控制台（触发/配置/进度与日志）
│       └── http/ cli/       # webhook+API、命令行
├── config/pipelines/        # 模板注册目录（*.json 全量注册，Web 动态保存/删除）
├── k8s/demo-app/            # 示例应用清单（base + test/prod overlay，kustomize）
├── scripts/                 # 统一 mock Agent、模拟提交、一键演示
└── docs/architecture.md     # 详细设计
```

## 快速开始

**前置**：Node ≥ 22、corepack，并安装且认证至少一个运行时 CLI：OpenCode 或 Codex。

```bash
# 1. 安装依赖
corepack pnpm install

# 2. 配置（默认 OpenCode；使用 Codex 时改 AGENT_RUNTIME=codex）
cp .env.example .env
# AGENT_RUNTIME=opencode  # 或 codex
# AGENT_CLI=/absolute/path/to/opencode
# AGENT_MODEL=provider/model

# 3. 启动网关
corepack pnpm gateway serve
#    http://127.0.0.1:3081

# 4. 提交模拟需求（或直接 POST /api/mock/submit）
node scripts/simulate-submit.mjs --title "管理后台增加报表导出功能" \
  --description "订单列表页增加导出按钮，支持 CSV/Excel，上限 10 万行，完成后消息中心通知下载。"

# 也可以走标准接口触发（POST /api/pipelines），见下节
```

一键演示（校验所选 CLI + 启动 + 提交 + 实时日志）：

```bash
bash scripts/demo-run.sh
```

## Agent 运行时与用量

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_RUNTIME` | `opencode` | `opencode` 或 `codex`，启动时选择一个 Provider |
| `AGENT_CLI` | 与运行时同名 | CLI 名称或绝对路径 |
| `AGENT_MODEL` | 运行时默认 | 可选模型参数 |
| `AGENT_TIMEOUT_MS` | `600000` | 每次 CLI 调用超时 |
| `CODEX_SANDBOX` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access`，仅 Codex 生效 |

OpenCode 实际命令为 `opencode run --format json --dir <cwd> ...`；Codex 为 `codex exec --json -C <cwd> --sandbox <mode> ...`。两者都接收统一 `AgentTask`，Provider 工厂由 `AGENT_RUNTIME` 选择实现。

用量口径：`inputTokens` 不含缓存读取，`outputTokens` 不含推理；缓存命中率为 `cacheReadTokens / (inputTokens + cacheReadTokens)`。费用只使用 Provider 明确返回的值，未知显示 `—`。每个 OpenCode `step_finish` 或 Codex `turn.completed` 计为一次实际模型请求；多 Agent、自动重试和失败后 retry 全部合并。

## 多开发 Agent 并行联调

分布式系统需求往往涉及多个服务，开发阶段支持 `multi` 配置：**一个阶段拆成多个 Agent 实例并行开发，并通过网关中介交换接口契约（模拟团队联调）**。

```jsonc
// config/pipelines/multi-dev.json（示例：order-service / payment-service 两个服务并行开发）
{
  "id": "dev_in_progress",
  "agent": "developer",
  "onSuccess": "testing",
  "multi": { "services": ["order-service", "payment-service"] }
}
```

执行机制（两轮并行）：
1. **契约轮**：每个服务一个开发 Agent 并行输出接口契约（`{service, contract}`）；
2. **汇总广播**：网关收集全部契约，注入每个 Agent 的 `context.teamContracts`（Agent 间"通信"载体）；
3. **实现轮**：每个服务基于团队契约并行产出实现方案，确保接口相互匹配。

- 结果按服务聚合：`agents.dev_in_progress.output.services.<service>`，`contracts` 为契约汇总；
- 产物按服务隔离：`data/artifacts/<id>/dev_in_progress/<service>/`；
- 子任务输出不可解析时自动带提示重试一次；
- 后续阶段（测试/验收）会基于多服务交付评审——测试 Agent 可发现跨服务契约矛盾并打回开发对齐。

> 真实验证：multi-dev 模板全链路跑通过一次真实需求——测试 Agent 第一轮发现两个服务契约矛盾（状态枚举/字段名不一致）→ 打回开发对齐 → 复审通过 → 部署 → 验收 → 生产。详细说明见 [docs/usage.md](docs/usage.md#5-多开发-agent-并行联调分布式系统)。

## 标准触发结构与接口触发

所有触发源（表单、API、CLI…）都归一化为同一标准结构，进入同一条流水线：

```ts
interface FormSubmission {          // 标准触发结构
  source: "mock" | "feishu" | "dingtalk" | "api";
  title: string; description: string; submitter: string;
  priority?: string;                // 建议优先级
  fields: Record<string, unknown>;  // 原始字段（可含 _policy）
  meta: { triggerType: "form" | "api" | "schedule" | "manual" | "cli"; detail?: string };
  policy?: SubmissionPolicy;        // 触发级流水线策略（覆盖环境变量）
  // …
}

interface SubmissionPolicy {
  acceptanceFailure?: "rollback" | "rework" | "reject"; // 验收失败处理
  autoAccept?: boolean;                                  // 覆盖 AUTO_ACCEPT
  maxRework?: number;                                    // 覆盖 MAX_REWORK
}
```

**标准接口触发**（不经过任何平台，直接调 HTTP）：

```bash
curl -X POST http://127.0.0.1:3081/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "接口触发需求",
    "description": "通过标准接口提交。",
    "submitter": "自动化平台",
    "priority": "P2",
    "fields": {"来源": "CI"},
    "policy": {"acceptanceFailure": "rework", "maxRework": 5}
  }'
```

表单触发同样支持触发级策略：在收集单字段里放 `_policy` 键即可（如 `{"_policy": {"acceptanceFailure": "rework"}}`）。

## Web 控制台

网关内置一个 Web 控制台（无需额外构建，浏览器访问即可）：

```
http://127.0.0.1:3081/
```

- **触发**：表单填写需求（标题/描述/提交人/优先级/fields/policy）→ 直接发起流水线；
- **配置**：查看运行时、CLI、模型、超时、Codex 沙箱及流程配置，管理模板与 Agent 定义；
- **进度与日志**：列表展示请求数/总 Token/费用；详情展示五类 Token、命中率、请求、会话、模型与费用，执行历史逐轮显示用量，同时保留事件、输出、日志和操作按钮。

## 流水线 API


| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/webhooks/feishu` | 飞书事件订阅（验签+解密，支持 URL 验证） |
| POST | `/webhooks/dingtalk` | 钉钉回调（验签） |
| POST | `/api/mock/submit` | 模拟表单提交（开发/演示） |
| POST | `/api/pipelines` | **标准接口触发**（标准结构 JSON） |
| GET | `/api/pipelines` | 流水线列表 |
| GET | `/api/pipelines/:id` | 流水线详情（事件、各阶段 agent 输出、产物） |
| GET | `/api/pipelines/:id/history` | **当前状态 + 历史执行信息**（executions/events/统计） |
| GET | `/api/pipelines/:id/events` | 事件流 |
| POST | `/api/pipelines/:id/accept` | 产品人工验收 `{"accepted":true,"by":"产品","note":"..."}` |
| POST | `/api/pipelines/:id/retry` | 失败后重试失败阶段 |
| GET | `/healthz` | 健康检查 |

CLI：`corepack pnpm gateway simulate --title "..."`、`... pipelines list|show|history|accept|reject|retry`。

## 状态与历史执行信息

- **当前状态**：`GET /api/pipelines/:id`（`status`、`acceptancePending`、`failure`、`deploy`…）
- **历史执行**：每次阶段执行都会追加到 `executions[]`（含 `stage/round/status/耗时/output/usage`），不因重跑而丢失
- **结构化历史**：`GET /api/pipelines/:id/history` 返回触发信息、状态、执行与事件；`stats.usage` 从执行历史派生

## 状态机

```
submitted → evaluating → dev_in_progress → testing → test_deploying → awaiting_acceptance → prod_deploying → done
              │ 不通过            │失败        │失败(打回开发)   │失败     │验收不通过(策略)        │失败
              ▼                 ▼           ▼              ▼                ▼                  ▼
           rejected          failed    dev_in_progress   failed   rollback/rework/reject      failed
                                            ▲                            │
                                            └────────── 打回开发 ──────────┘
                                            打回开发（reworkCount ≤ MAX_REWORK，超限 → failed）
```

- **测试门禁**：独立的测试 Agent 在部署前执行；测试不通过直接**打回开发**（附问题清单），开发 Agent 下一轮会收到 `reworkFeedback` 针对性修复。
- **验收失败策略（可控）**：默认 `rollback` —— 运维 Agent 先把**测试环境回滚到上一稳定版本**（`test_rollback` 阶段）→ 回滚成功后再打回开发，回滚失败直接终止；也可全局（`ACCEPTANCE_FAILURE_POLICY`）或按触发（`policy.acceptanceFailure`）设为 `rework`（不回滚直接打回）或 `reject`（直接终止）。
- **打回上限**：`MAX_REWORK`（默认 3）次仍不过 → 流水线终止为 failed，避免死循环。
- `awaiting_acceptance` 是人工闸门：验收 Agent 预检通过后，`AUTO_ACCEPT=true` 自动放行；`false` 时等待产品调用 accept 接口。

## 接入真实钉钉 / 飞书

1. **飞书**：开放平台创建事件订阅，配置 `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN`（加密或明文二选一），把网关 `/webhooks/feishu` 填到回调地址。支持多维表格记录创建（`app.table.record.created`）等事件；表单字段按 `DEFAULT_FIELD_KEYS` 启发式映射（title/描述/提交人），真实场景按自家收集单字段调整 `apps/gateway/src/forms/feishu.ts`。
2. **钉钉**：应用回调或机器人，配置 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`，回调地址 `/webhooks/dingtalk`。支持宜搭/智能填表 `formValues` 风格负载。
3. 通知：`NOTIFY_CHANNELS=console,feishu,dingtalk` + 各自机器人 webhook（可选）。

## 测试

```bash
corepack pnpm test        # 单元、Provider JSONL、用量、HTTP 与端到端测试
corepack pnpm typecheck
corepack pnpm build
```

端到端测试使用 `scripts/mock-agent.mjs`（无模型成本）同时模拟 OpenCode 与 Codex JSONL，并覆盖全链路、策略、模板、多 Agent、坏输出重试、失败 retry 和全部实际请求用量合并。

## 关键设计

- **Agent 任务契约**：每个角色接收统一 `AgentTask`（需求 + 上下文 + 指令 + 输出 schema），只允许输出一个 JSON 对象；网关解析后驱动状态机。
- **Provider Adapter**：`Orchestrator` 只依赖 `AgentRunner`；Provider 负责命令参数、进程与 JSONL 归一化。
- **用量单一来源**：流水线汇总始终从 `executions[].usage` 重新合并，避免恢复、并行和 retry 双计数。
- **模拟 vs 真实**：`PIPELINE_MODE=simulation` 时验收 Agent 按“完整性核对”（需求覆盖/方案/测试计划/部署证据）评审；`real` 时严格按真实交付验收。
- **异步驱动**：webhook 秒回 202，流水线后台执行，每个阶段结果持久化为 `data/pipelines/<id>.json` + `data/artifacts/<id>/<stage>/` 产物。
- **部署模式**：`OPS_MODE=auto` 探测 kubectl，无集群时运维 Agent 输出模拟部署计划与证据（rendered-manifests.yaml 等），K8s 就绪后改 `OPS_MODE=kubectl` 即为真实部署。
- **日志**：pino 结构化日志落盘 `data/logs/pipeline.log`，每条 agent 调用记录 pipelineId/stage/role/耗时/退出码，`GET /api/logs` 支持按流水线/级别过滤。

详细设计见 [docs/architecture.md](docs/architecture.md)。
