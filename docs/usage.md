# 使用文档

## 1. 三种触发方式

所有触发方式都归一化为同一标准结构进入流水线。

### 1.1 标准接口触发（推荐）

```bash
curl -X POST http://127.0.0.1:3081/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "管理后台报表导出",
    "description": "订单列表页增加导出按钮，支持 CSV/Excel，上限 10 万行。",
    "submitter": "产品-张三",
    "priority": "P1",
    "fields": { "期望上线": "下周五" },
    "policy": { "acceptanceFailure": "rework", "maxRework": 5 }
  }'
```

返回 `202 {"pipelineId": "...", "status": "submitted"}`，流水线后台执行。

### 1.2 模拟表单（开发/演示）

```bash
node scripts/simulate-submit.mjs --title "..." --description "..."
# 或
curl -X POST http://127.0.0.1:3081/api/mock/submit -H 'Content-Type: application/json' \
  -d '{"title": "...", "description": "...", "submitter": "产品"}'
```

### 1.3 钉钉 / 飞书收集单

| 平台 | 回调地址 | 必填配置 |
| --- | --- | --- |
| 飞书 | `POST /webhooks/feishu` | `FEISHU_ENCRYPT_KEY` 或 `FEISHU_VERIFICATION_TOKEN` |
| 钉钉 | `POST /webhooks/dingtalk` | `DINGTALK_APP_KEY` + `DINGTALK_APP_SECRET` |

- 字段归一化：适配器按 `DEFAULT_FIELD_KEYS`（标题/描述/提交人）启发式匹配，真实收集单字段不同时修改 `apps/gateway/src/forms/feishu.ts` / `dingtalk.ts` 的键表。
- 触发级策略：收集单里加一个 `_policy` 字段即可（见 §3）。

## 2. 跟踪流水线

```bash
# 列表（摘要）
curl http://127.0.0.1:3081/api/pipelines

# 详情（状态、事件、各阶段 agent 输出、产物）
curl http://127.0.0.1:3081/api/pipelines/<id>

# 历史执行信息（推荐）：触发信息 + 当前状态 + executions + events + 统计
curl http://127.0.0.1:3081/api/pipelines/<id>/history

# 事件流
curl http://127.0.0.1:3081/api/pipelines/<id>/events
```

CLI 等价命令：`corepack pnpm gateway pipelines list|show <id>|history <id>`。

### history 输出要点

```jsonc
{
  "status": "awaiting_acceptance",        // 当前状态
  "template": "multi-dev",                 // 使用的流程模板
  "trigger": { "type": "api", "source": "api" },
  "executions": [                          // 每次阶段执行（打回重跑不覆盖，round 递增）
    { "stage": "testing", "round": 1, "status": "fail", "durationMs": 58600, "output": {...} },
    { "stage": "testing", "round": 2, "status": "ok", "durationMs": 100600, "output": {...} }
  ],
  "events": [ ... ],
  "stats": { "totalExecutions": 8, "stages": { "testing": { "runs": 2, "failures": 1, ... } } }
}
```

## 3. 触发级策略（per-submission 覆盖环境变量）

| 字段 | 取值 | 效果 |
| --- | --- | --- |
| `policy.acceptanceFailure` | `rollback` / `rework` / `reject` | 覆盖 `ACCEPTANCE_FAILURE_POLICY` |
| `policy.autoAccept` | `true` / `false` | 覆盖 `AUTO_ACCEPT` |
| `policy.maxRework` | 数字 | 覆盖 `MAX_REWORK` |

表单触发：在收集单字段中放置 `_policy`：

```json
{ "需求标题": "...", "_policy": { "acceptanceFailure": "rework" } }
```

## 4. 模板平台：定制研发流程（多模板并存）

平台支持**多个流程模板同时使用、互不干扰**：注册目录 `config/pipelines/*.json` 中的模板启动时全量注册（内置 `default` 恒可用），触发时按需求选择模板，每条流水线独立绑定（`pipeline.templateName`）。

- **选择模板**：API 触发顶层 `template` 字段或 `policy.template`；Web 控制台触发页下拉选择；不指定则用默认模板。
- **动态注册**：Web 控制台保存/编辑模板立即生效（写入 `config/pipelines/<name>.json`），无需重启；同名保存=更新；内置 default 不可覆盖/删除。
- **互不干扰**：不同模板的流水线并行运行，各自按自己的阶段序列/角色/流转执行，数据按 pipelineId 隔离。

模板定义"阶段序列 + 每阶段的 agent 角色 + 流转关系"，改模板即可增删 agent 节点，无需改代码。

```jsonc
// config/pipelines/my.json
{
  "name": "my",
  "stages": [
    { "id": "evaluating", "agent": "evaluator", "onSuccess": "dev_in_progress" },
    { "id": "dev_in_progress", "agent": "developer", "onSuccess": "code_review" },   // 改：开发后先评审
    { "id": "code_review", "agent": "reviewer", "onSuccess": "testing", "reworkTarget": "dev_in_progress" }, // 新增节点
    { "id": "testing", "agent": "tester", "onSuccess": "test_deploying", "reworkTarget": "dev_in_progress" },
    { "id": "test_deploying", "agent": "ops", "onSuccess": "awaiting_acceptance", "ops": { "action": "deploy", "env": "test" } },
    { "id": "awaiting_acceptance", "agent": "acceptance", "onSuccess": "prod_deploying", "reworkTarget": "dev_in_progress" },
    { "id": "test_rollback", "agent": "ops", "onSuccess": "dev_in_progress", "ops": { "action": "rollback", "env": "test" } },
    { "id": "prod_deploying", "agent": "ops", "onSuccess": "done", "ops": { "action": "deploy", "env": "prod" } }
  ]
}
```

```bash
# 触发时选择模板（API）
curl -X POST http://127.0.0.1:3081/api/pipelines -H 'Content-Type: application/json' \
  -d '{"title": "...", "template": "with-code-review"}'
# 或 policy.template 与策略一起
# 查看全部模板
curl http://127.0.0.1:3081/api/templates
corepack pnpm gateway templates   # CLI 列表
corepack pnpm gateway template <name>   # CLI 查看详情
# 默认模板（未指定时使用）：启动环境变量 PIPELINE_TEMPLATE=<name> 或 PIPELINE_TEMPLATE=<文件路径>（兼容旧配置）
```

**要点**：
- **增加节点**：在合适位置加 `{id, agent, onSuccess, reworkTarget?}`；agent 可选 `evaluator/developer/tester/reviewer/ops/acceptance`。
- **减少节点**：删除阶段并把它前驱的 `onSuccess` 指到下一阶段（示例：删除 testing 后 dev 直连 test_deploying）。
- **打回目标**：阶段失败默认打回 `reworkTarget`（缺省 `dev_in_progress`）。
- **自定义 agent 角色**：在 `apps/gateway/src/agents/prompts.ts` 增加 persona + schema，并在 `genericVerdict`（`orchestrator.ts`）登记判定规则即可。

## 5. 多开发 Agent 并行联调（分布式系统）

模板中给阶段加 `multi` 配置，即可把一个阶段拆成多个 agent 实例并行执行：

```jsonc
{
  "id": "dev_in_progress",
  "agent": "developer",
  "onSuccess": "testing",
  "multi": { "services": ["order-service", "payment-service", "notification-service"] }
}
```

执行机制（模拟团队联调）：
1. **契约轮**：每个服务一个开发 Agent 并行输出接口契约（`{service, contract}`）；
2. **汇总广播**：网关收集全部契约，注入每个 Agent 的 `context.teamContracts`；
3. **实现轮**：每个服务基于团队契约并行产出实现方案（确保接口相互匹配）。

产物：`agents.dev_in_progress.output.services.<service>` 按服务聚合，`contracts` 为契约汇总；每个服务有独立产物目录 `data/artifacts/<id>/dev_in_progress/<service>/`。

> 真实场景：开发 Agent 的"通信"通过网关中介完成——契约即接口协议。真实代码模式下可在实现轮注入仓库路径，各服务开发 Agent 独立工作于自己的目录。

## 6. Agent 定义管理与自定义扩展

Agent 定义 = 角色名 + persona（角色定位）+ 输出 schema + 判定规则（verdict）。内置 6 个（evaluator/developer/tester/reviewer/ops/acceptance）；用户可在 `config/agents/*.json` 或 Web 控制台定义自定义 Agent，保存后**立即生效**，模板的 `agent` 字段即可引用。

```jsonc
// config/agents/security-reviewer.json
{
  "name": "security-reviewer",
  "label": "安全评审 Agent",
  "description": "对交付做安全评审",
  "persona": "你是「安全评审 Agent」，评审交付物的安全性、权限模型与数据保护。",
  "outputSchema": "{ \"approved\": boolean, \"issues\": string[], \"summary\": string }",
  "verdict": { "passWhen": "approved", "onFail": "rework" }
}
```

- `verdict.passWhen`：`approved`（布尔通过）/ `status-ok` / `status-pass` / `deployed` / `accepted`；
- `verdict.onFail`：`rework`（打回开发）/ `reject`（终止流水线）；
- 内置 Agent 不可删除/覆盖；自定义 Agent 可更新、删除。

**平台韧性**：
- **崩溃恢复**：网关重启自动扫描非终态流水线续跑（`recovered` 事件），从断点阶段重跑；人工验收等待中的流水线不被打扰。
- **模板快照**：每条流水线触发时深拷贝所用模板，后续修改/删除该模板不影响已触发流水线。

## 6. 人工验收与重试

```bash
# 验收（AUTO_ACCEPT=false 时必需；也用于拒绝）
curl -X POST http://127.0.0.1:3081/api/pipelines/<id>/accept \
  -H 'Content-Type: application/json' \
  -d '{"accepted": true, "by": "产品-李四", "note": "确认无误"}'

# 失败后重试失败阶段
curl -X POST http://127.0.0.1:3081/api/pipelines/<id>/retry

# CLI
corepack pnpm gateway pipelines accept <id> --by 产品
corepack pnpm gateway pipelines reject <id> --note "..."
corepack pnpm gateway pipelines retry <id>
```

## 8. 日志

- 实时：`tail -f data/logs/pipeline.log`（pino JSON 行，含 `pipelineId/stage/role/durationMs` 字段）
- HTTP 查询：
  ```bash
  curl 'http://127.0.0.1:3081/api/logs?lines=200'
  curl 'http://127.0.0.1:3081/api/logs?pipelineId=<id>&level=error'
  ```
- 级别由 `LOG_LEVEL` 控制。

## 9. 常见问题

| 问题 | 排查 |
| --- | --- |
| 启动报 `流程模板阶段 ... 引用未定义阶段` | 模板 onSuccess/reworkTarget 写错，对照 §4 |
| agent 一直失败、输出不可解析 | 查看该阶段 `rawOutput`；确认模型可用（`dsh --profile headless "PONG"`） |
| 飞书回调 401 | 验签失败：核对 `FEISHU_ENCRYPT_KEY` 与回调配置 |
| 钉钉回调 401 | `DINGTALK_APP_SECRET` 与平台配置不一致 |
| 验收失败却直接终止 | `ACCEPTANCE_FAILURE_POLICY=reject`（或触发级 policy），改为 rollback/rework |
| 想跳过测试节点 | 模板删除 `testing` 阶段并把 dev 的 `onSuccess` 指向 `test_deploying` |
