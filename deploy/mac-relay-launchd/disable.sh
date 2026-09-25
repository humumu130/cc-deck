#!/bin/zsh
# #76 relay 系统服务化：摘除 launchd 服务（不删数据/不动桌面壳的内嵌 relay 能力）。
# 停用后：下次启动 CC Deck 桌面端，壳照常自拉内嵌 relay（回到服务化前的模式）。
set -euo pipefail

LABEL="online.humumu.ccdeck.relay"
UID_N=$(id -u)
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || echo "（本就未注册）"
rm -f "$PLIST"
echo "✓ 已停用 relay 系统服务并清理 plist"
echo "  端口现在谁在听：lsof -i :${CCR_PORT:-8787} -sTCP:LISTEN"
