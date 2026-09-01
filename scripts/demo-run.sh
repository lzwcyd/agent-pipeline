#!/usr/bin/env bash
# 一键演示：校验所选 Agent CLI → 启动网关 → 提交需求 → 实时输出通知
# 要求：已安装 AGENT_RUNTIME 对应的 OpenCode 或 Codex CLI 并完成认证。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

AGENT_RUNTIME="${AGENT_RUNTIME:-opencode}"
case "$AGENT_RUNTIME" in
  opencode|codex) ;;
  *) echo "AGENT_RUNTIME 必须是 opencode 或 codex（当前：$AGENT_RUNTIME）"; exit 1 ;;
esac
AGENT_CLI="${AGENT_CLI:-$AGENT_RUNTIME}"

echo "==> 1/3 校验 Agent CLI（$AGENT_RUNTIME）"
command -v "$AGENT_CLI" >/dev/null 2>&1 || {
  echo "找不到 Agent CLI：$AGENT_CLI。请安装 $AGENT_RUNTIME 或设置 AGENT_CLI 绝对路径。"
  exit 1
}
"$AGENT_CLI" --version

echo "==> 2/3 启动网关（后台，端口 3081，日志 /tmp/pipeline-demo.log）"
lsof -ti :3081 >/dev/null 2>&1 && { echo "端口 3081 已被占用，请先停掉旧进程"; exit 1; }
corepack pnpm gateway serve > /tmp/pipeline-demo.log 2>&1 &
GATEWAY_PID=$!
trap 'kill $GATEWAY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:3081/healthz >/dev/null 2>&1 && break
  sleep 1
done
echo "   网关已就绪（PID $GATEWAY_PID）"

echo "==> 3/3 提交演示需求（$AGENT_RUNTIME 依次执行：评估→开发→测试→部署→验收→生产）"
node scripts/simulate-submit.mjs \
  --title "管理后台增加报表导出功能" \
  --description "在管理后台的订单列表页增加「导出报表」按钮，支持 CSV 和 Excel 两种格式，导出数据量上限 10 万行，导出完成后通过消息中心通知用户下载。"

echo
echo "==> 流水线后台执行中，实时通知见上方日志；也可随时查看："
echo "    GET  http://127.0.0.1:3081/api/pipelines"
echo "    完整演示预计 3~8 分钟。Ctrl+C 停止网关。"
wait "$GATEWAY_PID"
