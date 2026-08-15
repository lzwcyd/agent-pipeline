# 测试文档

## 运行测试

```bash
cd apps/gateway
corepack pnpm typecheck   # TypeScript 严格检查
corepack pnpm test        # 全部测试（vitest）
```

## 测试分层（共 51 个用例）

| 层级 | 文件 | 用例数 | 覆盖 |
| --- | --- | --- | --- |
| 单元·状态机 | `test/state-machine.test.ts` | 4 | 完整链路迁移、打回/回滚迁移、非法迁移拦截、终态隔离 |
| 单元·验签 | `test/signature.test.ts` | 8 | 飞书加密模式（验签+解密）、签名篡改拒绝、URL 验证、钉钉 HMAC 验签 |
| 单元·映射/解析 | `test/payload.test.ts` | 12 | 三源归一化、API 触发解析、`_policy` 提取、agent 输出 JSON 抽取（围栏/混合文本） |
| 集成·HTTP API | `test/http.test.ts` | 7 | 标准接口触发、模拟表单触发、history/events/templates/logs 查询、飞书 challenge、非法负载 400、accept 接口、错误状态防护 |
| 集成·端到端 | `test/e2e.test.ts` | 20 | 全链路成功、评估拒绝、测试打回/超限、验收三策略（rollback/rework/reject）、触发级 policy 覆盖、回滚/回滚失败、产品拒绝、历史执行、**流程模板定制**（插评审节点/删测试节点/非法模板）、**多开发 Agent 契约联调**、坏输出自动重试、人工验收闸门、retry |

## 测试设计要点

- **Agent 运行时全部 mock**：`scripts/mock-dsh.mjs` 模拟 DSH headless，通过环境变量注入故障（`MOCK_REJECT`/`MOCK_TEST_FAIL`/`MOCK_ACCEPT_REJECT`/`MOCK_OPS_FAIL`/`MOCK_ROLLBACK_FAIL`/`MOCK_REVIEW_REJECT_ONCE`/`MOCK_BAD_JSON_FIRST` 等），`*_ONCE` 类开关按流水线计数模拟"修复后通过"。
- **真实执行隔离**：每个测试用临时数据目录（`PIPELINE_DATA_DIR`），不污染仓库 `data/`。
- **HTTP 层真监听**：`http.test.ts` 用 `app.listen(0)` 随机端口 + `fetch` 走真实请求路径（含异步 202 驱动）。

## 真实冒烟（可选）

mock 全绿后，可对运行中的网关发起真实 DSH agent 流水线：

```bash
curl -X POST http://127.0.0.1:3081/api/pipelines -H 'Content-Type: application/json' \
  -d '{"title": "冒烟需求", "description": "描述", "submitter": "测试"}'
# 轮询：
curl http://127.0.0.1:3081/api/pipelines/<id>/history
```

真实冒烟依赖模型质量与网络，耗时为 mock 的数十倍（每个 agent 调用 1~8 分钟），可能因 LLM 输出不可解析/超时而失败——这正是 `retry`、子任务自动重试、`MAX_REWORK` 存在的意义。

## 新增测试指引

1. 新阶段/角色：mock-dsh.mjs 增加对应输出 → e2e 用自定义模板断言阶段顺序与产物。
2. 新 API：在 `http.test.ts` 增加端点用例（走真实 HTTP）。
3. 新故障注入：mock-dsh.mjs 增加 `MOCK_*` 开关 + e2e 断言编排行为。
