#!/bin/zsh
# M4 claim barrier 优雅热部署（multica T3 跟随替换，2026-10-29 批）——替代裸
# `launchctl kickstart -k`：换新前等在跑派单归零（默认 5min 窗，不硬杀），
# 新 bundle 起不来自动回滚旧版续服务。机制与退出码详见
# relay/scripts/graceful-restart.ts（主逻辑；本壳只定位仓内 tsx）。
# 用法：./graceful-restart.sh <新bundle路径> [--window 秒]
# env：CCR_GRACEFUL_WINDOW（等待窗秒）/CCR_PROBE_TIMEOUT/CCR_PORT/CCR_RELAY_LABEL/APP_RELAY
set -euo pipefail

# REPO_ROOT 定位：先绝对化脚本目录再上三级（相对路径调用时 dirname $0 需先落锚）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RELAY_DIR="$REPO_ROOT/relay"

if [[ ! -f "$RELAY_DIR/package.json" ]]; then
  echo "✗ 未找到仓内 relay（REPO_ROOT=$REPO_ROOT）——本脚本需开发仓在场（tsx 跑主逻辑）；纯生产机用 launchctl kickstart -k 自担风险" >&2
  exit 2
fi

cd "$RELAY_DIR"
exec npx tsx scripts/graceful-restart.ts "$@"
