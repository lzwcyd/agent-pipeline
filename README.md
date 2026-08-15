# 表单驱动的多 Agent 研发流水线

监听 **钉钉 / 飞书收集单** 的提交事件，自动驱动一条完整的研发流水线：

```
收集单提交（钉钉/飞书/模拟）
   │  （webhook 验签 → 归一化为 FormSubmission）
   ▼
┌──────────────┐  评估通过   ┌──────────────┐  开发完成   ┌──────────────┐  测试通过
│ 需求评估 Agent │ ─────────▶ │   开发 Agent   │ ─────────▶ │   测试 Agent   │ ────────┐
└──────────────┘            └──────────────┘            └──────────────┘         │
   │ 不通过（拒绝）                 ▲                            │ 不通过（打回开发）      │
   ▼                              │                            ▼                       ▼
 rejected（终态）      测试/验收未通过─┼──┐          ┌────────────────┐        ┌────────────────┐
                       打回开发（≤MAX_REWORK）      │ 运维 Agent（测试）│        │ 运维 Agent（测试）│
                                    │              └────────────────┘        └────────────────┘
                                    └───────────── 回滚测试环境（验收不通过时先回滚再打回）
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

- **Agent 运行时**：DeepSeek Harness（DSH）`headless` profile —— 每个角色一次 `dsh --profile headless "<task>"` 调用，输出严格 JSON 驱动状态机。
- **表单接入**：可插拔适配器。`mock`（模拟器）随时可用；`feishu`/`dingtalk` 适配器已实现验签与字段归一化，配好凭证即可直连。
- **部署**：Kubernetes（kubectl 模式），无集群时自动降级为 simulated 模式（输出完整部署计划与证据）。
- **开发模式**：`PIPELINE_MODE=simulation`（默认）产出方案文档；`real` 模式要求真实代码与真实部署。

## 目录结构

```
├── apps/gateway/            # Node.js/TypeScript 网关（Express）
│   └── src/
│       ├── forms/           # 触发源：mock / feishu / dingtalk / api（统一归一化 + 验签）
│       ├── pipeline/        # 状态机、JSON 持久化、编排器、历史视图
│       ├── agents/          # DSH runner、角色 prompt、任务组装
│       ├── notify/          # 通知器：console / 飞书机器人 / 钉钉机器人
│       └── http/ cli/       # webhook+API、命令行
├── profiles/headless/       # DSH headless profile（agent 运行时，需安装到 ~/.dsh）
├── k8s/demo-app/            # 示例应用清单（base + test/prod overlay，kustomize）
├── scripts/                 # 安装、模拟提交、一键演示
└── docs/architecture.md     # 详细设计
```

## 快速开始

**前置**：Node ≥ 22、corepack、已安装 dsh 且 `~/.dsh/.credentials.yaml` 有 `DEEPSEEK_API_KEY`（Web GUI 能跑即满足）。

```bash
# 1. 安装依赖
corepack pnpm install

# 2. 安装 DSH headless profile（一次性）
bash scripts/install-headless-profile.sh
dsh --profile headless "Reply with exactly: PONG"   # 应输出 PONG

# 3. 配置（可选，默认值即可跑）
cp .env.example .env   # 按需修改，至少确认 DSH_CLI 能找到 dsh

# 4. 启动网关
corepack pnpm gateway serve
#    http://127.0.0.1:3081

# 5. 提交模拟需求（或直接 POST /api/mock/submit）
node scripts/simulate-submit.mjs --title "管理后台增加报表导出功能" \
  --description "订单列表页增加导出按钮，支持 CSV/Excel，上限 10 万行，完成后消息中心通知下载。"

# 也可以走标准接口触发（POST /api/pipelines），见下节
```

一键演示（安装+启动+提交+实时日志）：

```bash
bash scripts/demo-run.sh
```

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
- **历史执行**：每次阶段执行都会追加到 `executions[]`（含打回后的多轮执行：`stage/round/status/耗时/output`），不因重跑而丢失
- **结构化历史**：`GET /api/pipelines/:id/history` 返回 触发信息 + 当前状态摘要 + `executions` + `events` + 各阶段统计（执行次数/失败次数/最近结果/累计耗时）

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
corepack pnpm test        # 38 个用例：状态机、验签、字段映射、策略、历史、端到端（mock DSH runner）
corepack pnpm typecheck
```

端到端测试使用 `scripts/mock-dsh.mjs`（无 LLM 成本）模拟 agent，覆盖：全链路成功、评估拒绝、**测试不通过打回开发**、**打回超限终止**、**验收失败三策略（rollback/rework/reject）**、**触发级 policy 覆盖环境变量**、**标准接口触发**、**历史执行记录**、人工验收闸门、失败重试。

## 关键设计

- **Agent 任务契约**：每个角色接收统一 `AgentTask`（需求 + 上下文 + 指令 + 输出 schema），只允许输出一个 JSON 对象；网关解析后驱动状态机。
- **模拟 vs 真实**：`PIPELINE_MODE=simulation` 时验收 Agent 按“完整性核对”（需求覆盖/方案/测试计划/部署证据）评审；`real` 时严格按真实交付验收。
- **异步驱动**：webhook 秒回 202，流水线后台执行，每个阶段结果持久化为 `data/pipelines/<id>.json` + `data/artifacts/<id>/<stage>/` 产物。
- **部署模式**：`OPS_MODE=auto` 探测 kubectl，无集群时运维 Agent 输出模拟部署计划与证据（rendered-manifests.yaml 等），K8s 就绪后改 `OPS_MODE=kubectl` 即为真实部署。

详细设计见 [docs/architecture.md](docs/architecture.md)。
