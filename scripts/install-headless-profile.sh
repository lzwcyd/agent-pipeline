#!/usr/bin/env bash
# 把仓库内的 headless profile 安装到 $DSH_HOME/profiles/headless，
# 使 `dsh --profile headless "<task>"` 可用（网关调用 DSH agent 的前提）。
#
# 说明：
#   - profile 目录只有 4 个小配置文件；DSH 的共享依赖在 $DSH_HOME/profiles/node_modules
#     （由 web profile 的 pnpm workspace 提升安装），因此无需重新安装依赖。
#   - 若目标已存在则原样保留（不覆盖），除非传入 --force。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/profiles/headless"
DST_ROOT="${DSH_HOME:-$HOME/.dsh}/profiles"
DST="$DST_ROOT/headless"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ -e "$DST" && "$FORCE" != 1 ]]; then
  echo "已存在 $DST （跳过；如需覆盖请加 --force）"
  exit 0
fi

mkdir -p "$DST_ROOT"
if [[ -e "$DST" ]]; then
  rm -rf "$DST"
fi
cp -R "$SRC" "$DST"
echo "已安装 headless profile → $DST"
echo "验证：dsh --profile headless \"Reply with exactly: PONG\""
