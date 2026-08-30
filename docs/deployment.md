# 部署文档

本文档描述「agent-pipeline 多 Agent 研发交付流水线」网关的部署方式与运维要点。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | 网关运行环境 |
| corepack | ≥ 0.34 | 提供 pnpm |
| OpenCode 或 Codex CLI | 当前可用版本 | Agent 运行时；至少安装并认证一个 |
| 模型凭证 | — | 由所选 CLI 的标准认证方式管理 |
| kubectl（可选） | 任意 | 存在时运维 Agent 走真实部署；否则自动模拟 |
| Kubernetes 集群（可选） | 任意 | `OPS_MODE=kubectl` 时使用 |

> 网关通过子进程调用所选 Agent CLI。服务账户必须能执行该 CLI、访问其认证配置，并对配置的工作区拥有与沙箱策略匹配的权限。

## 2. 安装

```bash
# 1) 克隆代码后安装依赖
cd agent-pipeline
corepack pnpm install

# 2) 按 OpenCode 或 Codex 官方方式安装 CLI 并完成认证
opencode --version   # AGENT_RUNTIME=opencode
codex --version      # AGENT_RUNTIME=codex

# 3) 配置（只需启用其中一个运行时）
cp .env.example .env
```

## 3. 配置项

见 `.env.example` 完整注释。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3081 | 监听端口 |
| `PIPELINE_DATA_DIR` | data | 流水线数据（pipelines/artifacts/logs）目录，相对仓库根 |
| `AGENT_RUNTIME` | opencode | `opencode` / `codex` |
| `AGENT_CLI` | 与运行时同名 | CLI 路径；不在 PATH 时填绝对路径 |
| `AGENT_MODEL` | 运行时默认 | 可选模型参数 |
| `AGENT_TIMEOUT_MS` | 600000 | 单次 CLI 调用超时（毫秒） |
| `CODEX_SANDBOX` | workspace-write | Codex：read-only/workspace-write/danger-full-access |
| `AUTO_ACCEPT` | true | 验收预检通过后是否自动放行 |
| `ACCEPTANCE_FAILURE_POLICY` | rollback | 验收失败策略：rollback/rework/reject |
| `MAX_REWORK` | 3 | 打回开发上限 |
| `PIPELINE_TEMPLATE` | 内置 default | 流程模板 JSON 路径（相对仓库根），见 §4 |
| `PIPELINE_MODE` | simulation | simulation/real |
| `OPS_MODE` | auto | auto/kubectl/simulated |
| `LOG_LEVEL` | info | trace/debug/info/warn/error |
| `NOTIFY_CHANNELS` | console | console/feishu/dingtalk（逗号分隔） |
| `FEISHU_*` / `DINGTALK_*` | — | 表单平台凭证（无则仅 mock/API 触发） |

## 4. 流程模板

默认内置 `default` 模板；如需定制（增删 agent 节点、改角色、改打回目标）：

```bash
# 使用示例模板
PIPELINE_TEMPLATE=config/pipelines/with-code-review.json   # 增加评审节点
PIPELINE_TEMPLATE=config/pipelines/multi-dev.json          # 多开发 Agent 联调

# 或自建模板：复制 default.json 修改后引用
cp config/pipelines/default.json config/pipelines/my-pipeline.json
PIPELINE_TEMPLATE=config/pipelines/my-pipeline.json
```

模板加载时校验：阶段 id 唯一、agent 角色合法、onSuccess/reworkTarget 引用存在。非法模板启动即报错。

## 5. 启动与守护

### 前台
```bash
corepack pnpm gateway serve
```

### systemd（推荐生产）
```ini
# /etc/systemd/system/pipeline-gateway.service
[Unit]
Description=Agent-Pipeline Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/agent-pipeline
EnvironmentFile=/opt/agent-pipeline/.env
ExecStart=/usr/local/bin/corepack pnpm gateway serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### pm2
```bash
npm i -g pm2
pm2 start "corepack pnpm gateway serve" --name agent-pipeline-gateway --cwd /opt/agent-pipeline
pm2 save && pm2 startup
```

### 反向代理（暴露 webhook 给公网）
```nginx
# /etc/nginx/conf.d/pipeline.conf
server {
  listen 443 ssl;
  server_name pipeline.example.com;
  ssl_certificate     /etc/nginx/ssl/fullchain.pem;
  ssl_certificate_key /etc/nginx/ssl/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3081;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```
钉钉/飞书回调地址填 `https://pipeline.example.com/webhooks/dingtalk` 等。

## 6. 容器化（可选）

镜像必须包含所选 Agent CLI。认证配置与工作区应按最小权限挂载；不要把长期凭证写进镜像层。

```dockerfile
FROM node:22-slim
RUN npm i -g corepack && corepack enable
# 在此按所选运行时的官方方式安装并锁定 OpenCode 或 Codex CLI 版本。
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile
EXPOSE 3081
CMD ["corepack", "pnpm", "gateway", "serve"]
```

```bash
docker build -t pipeline-gateway .
docker run -d --name agent-pipeline-gateway \
  -p 3081:3081 \
  -v /opt/agent-pipeline/.env:/app/.env:ro \
  -v /opt/agent-auth:/root/.agent-auth:ro \
  -v /opt/workspaces:/workspaces \
  -v pipeline-data:/app/data \
  pipeline-gateway
```

认证目录的实际容器路径取决于所选 CLI。`AGENT_CLI` 必须指向容器内可执行文件。Codex 生产环境建议从 `workspace-write` 起步；只有明确需要且容器边界足够强时才使用 `danger-full-access`。

## 7. 数据与日志

- 数据目录 `data/`：
  - `pipelines/<id>.json`：流水线快照（状态、事件、执行历史、Agent/阶段/流水线用量、产物清单）
  - `artifacts/<id>/<stage>/`：各阶段 agent 工作目录与产物
  - `logs/pipeline.log`：结构化日志（pino JSON 行）
- 备份：定期归档 `data/pipelines/` 与 `data/artifacts/` 即可；日志可按需轮转（外部 logrotate）。

## 8. 健康检查与监控

- `GET /healthz`：进程存活
- `GET /api/logs?lines=200`：最近日志（支持 `pipelineId`、`level` 过滤）
- 建议监控：`/healthz` 探活；日志中 `level=error` 告警；流水线长时间卡在非终态告警。

## 9. 升级

```bash
git pull
corepack pnpm install --frozen-lockfile
opencode --version  # 或 codex --version，确认部署主机上的 CLI 仍可用
corepack pnpm gateway serve   # 重启
```
数据目录向下兼容（JSON 快照结构只增字段，不破坏旧文件）。
