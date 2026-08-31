# 测试文档

## 运行测试

在仓库根执行：

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

只运行网关或单个文件：

```bash
corepack pnpm --filter @pipeline/gateway test
corepack pnpm --filter @pipeline/gateway exec vitest run test/runner.test.ts
```

## 测试分层

| 层级 | 文件 | 覆盖 |
| --- | --- | --- |
| 状态机 | `state-machine.test.ts` | 合法迁移、回滚/打回、非法迁移、终态隔离 |
| 触发与安全 | `payload.test.ts` / `signature.test.ts` | 多来源归一化、策略、JSON 抽取、飞书/钉钉验签 |
| 用量与持久化 | `usage.test.ts` / `store.test.ts` | Token/费用/请求聚合、命中率、去重、旧快照兼容 |
| Provider | `runner.test.ts` / `process.test.ts` | OpenCode/Codex JSONL、参数、Token 归一化、启动失败、超时管道排空与等待上限、工厂 |
| 统一测试执行器 | `mock-agent.test.ts` | 同一脚本输出 OpenCode 与 Codex 协议 |
| HTTP/Web | `http.test.ts` | API、异步驱动、历史/用量、运行时配置、Web 用量标记 |
| 端到端 | `e2e.test.ts` | 全链路、工作区边界、成功检查点与恢复、多 Agent 部分失败、非零退出、超时及重试用量 |

## 统一 mock Agent

`scripts/mock-agent.mjs` 不调用模型。它根据第一个命令识别协议：

- OpenCode：接收 `run ... <AgentTask JSON>`，输出 `text` 和 `step_finish` JSONL；
- Codex：接收 `exec --json ... <AgentTask JSON>`，输出 `thread.started`、`item.completed` 和 `turn.completed` JSONL。

业务输出与故障开关对两种协议一致。常用开关：

- `MOCK_REJECT`、`MOCK_TEST_FAIL`、`MOCK_ACCEPT_REJECT`；
- `MOCK_OPS_FAIL`、`MOCK_ROLLBACK_FAIL`；
- `MOCK_REVIEW_REJECT_ONCE`、`MOCK_BAD_JSON_FIRST`；
- `MOCK_BAD_JSON_ALWAYS_SERVICE=<服务名>`：指定并行服务持续返回无效契约，包含重试；
- `MOCK_EXIT_AFTER_USAGE=<角色>`、`MOCK_TIMEOUT_AFTER_USAGE=<角色>`：输出用量后非零退出或保持运行直到超时；
- 所有 `*_ONCE` 开关用 artifacts 目录中的状态文件模拟“第一次失败，后续通过”。

端到端 harness 默认设置 `AGENT_RUNTIME=opencode` 和 `AGENT_CLI=scripts/mock-agent.mjs`，并额外以 `codex` 跑完整成功链路。

## 用量测试原则

- OpenCode 每个 `step_finish`、Codex 每个 `turn.completed` 都是一次真实请求。
- 输入 Token 不含缓存读取，输出 Token 不含推理。
- 多 Agent 测试断言契约轮、实现轮和每个坏输出重试都被累计。
- 失败后 retry 测试先检查失败快照，再确认最终汇总保留前后请求。
- 非零退出、超时、并行部分失败及重试启动异常均检查 Agent 结果、阶段历史和流水线汇总，启动失败不得凭空增加请求数。
- 成功检查点测试在阶段推进时注入异常，再恢复重跑，确认原请求保留且新轮次继续累加。
- 工作区测试同时检查单 Agent 与并行子任务的 cwd 是工程根，产物依旧落在独立目录。
- 流水线用量必须等于 `executions[].usage` 的合并结果。
- Provider 未返回费用时必须保持 `null`，不能在测试或生产代码中估算。

## Web 展示冒烟

使用 `AGENT_CLI` 指向 `scripts/mock-agent.mjs` 启动控制台，提交一条模拟流水线后检查列表、详情和配置页。确认用量卡片完整显示、表头与数据对齐；详情包含较长 JSONL 原始输出时，网格不能被撑出页面宽度。窄窗口下用量卡片应切换为双列，会话 ID 可换行，未知费用显示 `—`。

## 真实冒烟（可选）

先让全部 mock 测试通过，再选择一个已认证的 CLI：

```bash
# OpenCode
AGENT_RUNTIME=opencode AGENT_CLI=opencode corepack pnpm gateway serve

# 或 Codex
AGENT_RUNTIME=codex AGENT_CLI=codex CODEX_SANDBOX=workspace-write corepack pnpm gateway serve
```

另一个终端提交并轮询：

```bash
curl -X POST http://127.0.0.1:3081/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{"title":"冒烟需求","description":"描述","submitter":"测试"}'
curl http://127.0.0.1:3081/api/pipelines/<id>/history
```

真实冒烟依赖网络、模型与 CLI 认证。OpenCode 版本必须支持 `run --format json` 并输出含 Token 的 `step_finish`；若 CLI 未输出用量事件，框架不会推算缺失请求或费用。失败时检查 `AgentResult.rawOutput`、`error`、结构化日志和已保留的部分用量。

## 新增测试指引

1. 新角色：扩展 `mock-agent.mjs` 的业务输出，并用模板端到端断言。
2. 新 Provider 事件字段：先给纯解析函数添加 JSONL fixture，再修改解析。
3. 新故障：增加 `MOCK_*` 开关，并断言业务状态和请求用量。
4. 新 API/Web 字段：在 `http.test.ts` 通过真实监听端口验证。
