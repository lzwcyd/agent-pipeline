#!/usr/bin/env bash
# 一键演示：安装 headless profile → 启动网关 → 提交模拟需求 → 实时输出通知
# 要求：本机已安装 dsh（见 README 快速开始）。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> 1/4 安装 DSH headless profile"
bash scripts/install-headless-profile.sh

echo "==> 2/4 校验 dsh 可用"
DSH_CLI="${DSH_CLI:-dsh}"
"$DSH_CLI" --profile headless "Reply with exactly: PONG" >/dev/null 2>&1 || {
  echo "dsh headless 校验失败，请检查 DSH_CLI（当前：$DSH_CLI）与模型凭证（~/.dsh/.credentials.yaml 或 DEEPSEEK_API_KEY）"
  exit 1
}

echo "==> 3/4 启动网关（后台，端口 3081，日志 /tmp/pipeline-demo.log）"
lsof -ti :3081 >/dev/null 2>&1 && { echo "端口 3081 已被占用，请先停掉旧进程"; exit 1; }
corepack pnpm gateway serve > /tmp/pipeline-demo.log 2>&1 &
GATEWAY_PID=$!
trap 'kill $GATEWAY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:3081/healthz >/dev/null 2>&1 && break
  sleep 1
done
echo "   网关已就绪（PID $GATEWAY_PID）"

echo "==> 4/4 提交演示需求（真实 DSH agent 依次执行：评估→开发→测试部署→验收→生产部署）"
node scripts/simulate-submit.mjs \
  --title "管理后台增加报表导出功能" \
  --description "在管理后台的订单列表页增加「导出报表」按钮，支持 CSV 和 Excel 两种格式，导出数据量上限 10 万行，导出完成后通过消息中心通知用户下载。"

echo
echo "==> 流水线后台执行中，实时通知见上方日志；也可随时查看："
echo "    GET  http://127.0.0.1:3081/api/pipelines"
echo "    完整演示预计 3~8 分钟。Ctrl+C 停止网关。"
wait "$GATEWAY_PID"
