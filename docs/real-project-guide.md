# 真实工程接入指南：用 agent-pipeline 开发你的工程

本指南说明如何把 agent-pipeline 从"模拟演示"切换为**真实工程开发**：开发 Agent 在你的真实仓库中实现并提交代码，运维 Agent 按你的清单部署到真实环境。

## 1. 总体流程

```
PIPELINE_MODE=real
   │
   ├─ 开发 Agent → 在 data/workspace/<project>/（你的真实仓库）实现代码、跑测试、git commit/push
   ├─ 测试 Agent → 基于真实代码与测试结果给出门禁结论
   ├─ 运维 Agent → 按 OPS_MANIFESTS_DIR 的 kustomize 清单部署（kubectl 或模拟）
   └─ 验收 Agent → 基于真实交付严格验收
```

## 2. 工程目录设置

```bash
# 1) 在网关工作区创建工程目录
cd <agent-pipeline 仓库根>
mkdir -p data/workspace

# 2) 把你的工程 clone 进来（或复制现有工程）
cd data/workspace
git clone <你的工程远程地址> my-project     # 或 cp -r /path/to/my-project .

# 3) 配置 .env
PIPELINE_MODE=real
DEV_PROJECT_DIR=my-project
```

**沙箱说明**：网关会把 `PIPELINE_WORKSPACE_ROOT`（= data 根）注入 headless profile，Agent 的文件/命令沙箱覆盖整个 `data/`——开发 Agent 可以读写 `data/workspace/my-project/`，但不能越出工作区（安全边界）。修改 profile 后需**重启网关**（无需重装 profile，patch 已在仓库与 `~/.dsh/profiles/headless/` 同步）。

**git 提交**：开发 Agent 会用本机 git 凭证执行 `git checkout -b feature/...`、`git add/commit`、`git push`（`context.repoDir` 注入，persona 已含真实开发指令）。

## 3. 配置部署行为

### 3.1 清单目录（kustomize）

运维 Agent 按 `OPS_MANIFESTS_DIR`（相对仓库根）部署，期望 kustomize 结构：

```
<OPS_MANIFESTS_DIR>/
├── base/                    # Deployment / Service / ConfigMap…
│   └── kustomization.yaml
└── overlays/
    ├── test/                # namespace=demo-test（或 OPS_TEST_NAMESPACE）
    │   └── kustomization.yaml
    └── prod/                # namespace=demo-prod（或 OPS_PROD_NAMESPACE）
        └── kustomization.yaml
```

```bash
# 如果你已有 kustomize 清单：
OPS_MANIFESTS_DIR=deploy/manifests          # 相对 agent-pipeline 仓库根

# 没有清单？参考 k8s/demo-app 搭一个 base+overlays 骨架
```

> 目前运维 Agent 支持 **kustomize apply**。若你用 Helm，可在模板中新增一个 `agent: ops` 的阶段并扩展 persona，或预先在 CI 渲染 Helm → 清单目录。

### 3.2 环境与命名空间

```bash
OPS_TEST_NAMESPACE=dev-myapp
OPS_PROD_NAMESPACE=prod-myapp
```

### 3.3 部署模式

```bash
# 有 kubectl + 集群（真实部署）：
OPS_MODE=kubectl        # 或 auto（自动探测 kubectl）

# 暂时没有集群（输出部署计划与证据，先跑通流程）：
OPS_MODE=simulated
```

### 3.4 镜像

真实部署前需要**先构建镜像并推送**（agent-pipeline 不负责构建；建议在 CI 或本地预构建）：

```bash
docker build -t <registry>/my-app:v1.2.0 data/workspace/my-project
docker push <registry>/my-app:v1.2.0
```

开发 Agent 输出的 `version`（如 v1.2.0）会传给运维 Agent；kustomize 清单中把镜像 tag 参数化（例如 `images: - name: <image> newTag: v1.2.0`），运维 Agent 会用该版本 apply。需要时可在流程模板中插入一个"构建"阶段（自定义 Agent，负责 `docker build && push`），再接运维阶段。

### 3.5 部署到 KVM / 传统服务器（SSH）

不只支持 K8s：运维 Agent 也支持通过 **SSH 部署到 KVM/传统服务器**（scp 产物 + systemctl 重启 + 健康检查）。

```bash
OPS_TARGET=ssh             # 或 auto（配了 SSH 主机即 ssh）
OPS_SSH_HOST=10.20.30.40   # KVM 机器 IP/域名
OPS_SSH_USER=root
OPS_SSH_PORT=22
OPS_SSH_DEPLOY_DIR=/opt/my-app     # 产物上传目录
OPS_SSH_SERVICE=my-app             # systemd 服务名
OPS_SSH_ARTIFACT=dist              # 产物路径/glob（相对开发产物目录）
```

- 流程：`scp <artifact> → <deployDir>` → `systemctl restart <service>` → `curl 健康检查`；
- **回滚**：恢复上一份产物并重启服务（验收失败回滚同样生效）；
- 模板可按环境指定目标：测试环境走 K8s、生产走 KVM，或都走 SSH：

```jsonc
{ "id": "test_deploying", "agent": "ops", "onSuccess": "awaiting_acceptance",
  "ops": { "action": "deploy", "env": "test", "target": "ssh" } },
{ "id": "prod_deploying", "agent": "ops", "onSuccess": "done",
  "ops": { "action": "deploy", "env": "prod", "target": "ssh" } }
```

> 无目标机器时可先用 `OPS_MODE=simulated` 跑通流程（输出 scp/systemctl 计划与模拟证据）；
> 真实 SSH 使用本机 `~/.ssh` 凭证，需保证网关进程可免密登录目标机。

## 4. 流程模板建议（真实工程）

```jsonc
// config/pipelines/real-project.json —— 保存后 Web 触发页即可选择
{
  "name": "real-project",
  "stages": [
    { "id": "evaluating", "agent": "evaluator", "onSuccess": "dev_in_progress" },
    { "id": "dev_in_progress", "agent": "developer", "onSuccess": "code_review" },   // 真实交付建议加评审
    { "id": "code_review", "agent": "reviewer", "onSuccess": "testing", "reworkTarget": "dev_in_progress" },
    { "id": "testing", "agent": "tester", "onSuccess": "test_deploying", "reworkTarget": "dev_in_progress" },
    { "id": "test_deploying", "agent": "ops", "onSuccess": "awaiting_acceptance", "ops": { "action": "deploy", "env": "test" } },
    { "id": "awaiting_acceptance", "agent": "acceptance", "onSuccess": "prod_deploying", "reworkTarget": "dev_in_progress" },
    { "id": "test_rollback", "agent": "ops", "onSuccess": "dev_in_progress", "ops": { "action": "rollback", "env": "test" } },
    { "id": "prod_deploying", "agent": "ops", "onSuccess": "done", "ops": { "action": "deploy", "env": "prod" } }
  ]
}
```

多服务工程：给 dev 阶段加 `multi`（每服务一个开发 Agent 并行联调），见 [usage.md](usage.md#5-多开发-agent-并行联调分布式系统)。

## 5. 验收与人工闸门

```bash
# 测试环境部署后默认自动验收；建议真实工程开启人工验收：
AUTO_ACCEPT=false
# 产品在 Web 控制台或 API 确认：
# POST /api/pipelines/<id>/accept  {"accepted":true,"by":"产品"}
```

## 6. 端到端启动

```bash
cd <agent-pipeline 仓库根>
cp .env.example .env    # 按上文修改
corepack pnpm gateway serve

# Web 触发（选 real-project 模板）或：
curl -X POST http://127.0.0.1:3081/api/pipelines -H 'Content-Type: application/json' \
  -d '{"title": "我的第一个真实需求", "description": "...", "submitter": "产品", "template": "real-project"}'
```

## 7. 常见问题

| 问题 | 处理 |
| --- | --- |
| 开发 Agent 无法写入工程目录 | 确认 `PIPELINE_WORKSPACE_ROOT` 生效（重启网关）；工程必须在 `data/workspace/` 内 |
| 部署失败"找不到清单" | `OPS_MANIFESTS_DIR` 相对 agent-pipeline 仓库根；确认 base/overlays 结构 |
| 镜像版本不一致 | 预构建并推送 `version` 对应的镜像；kustomize 用 `images.newTag` 参数化 |
| git push 失败 | 本机 git 凭证需可 push 目标仓库（agent 使用本机凭证） |
| 想跳过测试/评审 | 在模板中删掉对应阶段并把前驱 `onSuccess` 指向下一阶段 |
