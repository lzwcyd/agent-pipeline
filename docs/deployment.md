# 部署文档

本文档描述「表单驱动的多 Agent 研发流水线」网关的部署方式与运维要点。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | 网关运行环境 |
| corepack | ≥ 0.34 | 提供 pnpm |
| dsh（DeepSeek Harness CLI） | 与 Web GUI 同版本 | Agent 运行时（`dsh --profile headless`） |
| 模型凭证 | — | `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，或环境变量 |
| kubectl（可选） | 任意 | 存在时运维 Agent 走真实部署；否则自动模拟 |
| Kubernetes 集群（可选） | 任意 | `OPS_MODE=kubectl` 时使用 |

> 网关本体是一个 Node.js 服务；Agent 执行依赖宿主机上的 dsh，因此**不建议**把网关放进无 dsh 的隔离容器（见 §6 容器化说明）。

## 2. 安装

```bash
# 1) 克隆代码后安装依赖
cd form-driven-pipeline
corepack pnpm install

# 2) 安装 DSH headless profile（一次性，所有用户/机器都需要）
bash scripts/install-headless-profile.sh
# 验证：
dsh --profile headless "Reply with exactly: PONG"   # 应输出 PONG

# 3) 配置
cp .env.example .env
```

## 3. 配置项

见 `.env.example` 完整注释。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3081 | 监听端口 |
| `PIPELINE_DATA_DIR` | data | 流水线数据（pipelines/artifacts/logs）目录，相对仓库根 |
| `DSH_CLI` | dsh | dsh 可执行文件路径（不在 PATH 时填绝对路径） |
| `DSH_AGENT_TIMEOUT_MS` | 900000 | 单个 agent 调用超时 |
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
Description=Form-Driven Multi-Agent Pipeline Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/form-driven-pipeline
EnvironmentFile=/opt/form-driven-pipeline/.env
ExecStart=/usr/local/bin/corepack pnpm gateway serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### pm2
```bash
npm i -g pm2
pm2 start "corepack pnpm gateway serve" --name pipeline-gateway --cwd /opt/form-driven-pipeline
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

网关需要调用宿主机 dsh，容器方案：挂载 DSH 家目录 + 在镜像内安装 dsh。

```dockerfile
FROM node:22-slim
RUN npm i -g corepack && corepack enable
# 安装 dsh（与宿主机同版本）：
RUN npm i -g @deepseek-ai/dsh
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile
EXPOSE 3081
CMD ["corepack", "pnpm", "gateway", "serve"]
```

```bash
docker build -t pipeline-gateway .
docker run -d --name pipeline-gateway \
  -p 3081:3081 \
  -v /opt/form-driven-pipeline/.env:/app/.env:ro \
  -v ~/.dsh:/root/.dsh:ro \
  -v pipeline-data:/app/data \
  pipeline-gateway
```
> 容器内 dsh 版本须与宿主机 profile 兼容；headless profile 由 `install-headless-profile.sh` 安装到挂载的 `~/.dsh`。

## 7. 数据与日志

- 数据目录 `data/`：
  - `pipelines/<id>.json`：流水线快照（状态、事件、执行历史、产物清单）
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
# 若 DSH 升级：重新执行 scripts/install-headless-profile.sh --force
corepack pnpm gateway serve   # 重启
```
数据目录向下兼容（JSON 快照结构只增字段，不破坏旧文件）。
