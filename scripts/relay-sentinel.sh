#!/bin/bash
# relay-sentinel.sh —— relay 复活哨（W-RELDEATH / DEV-18 P0-A「可复活」腿）
#
# 背景（2026-11-24 生产事故）：App 壳被换装流程杀死且未重启 → 内嵌 relay 无人孵化 →
# 8787 死寂 60h+，org/PM/通知/派单全瘫。App 的 #66 监督线程只在壳活着时有效；壳本身
# 没有监护者——本哨补的就是这个缺口。
#
# 职责边界（三条铁律，与「内嵌独占」拍板对齐）：
#   1) 绝不直接 spawn relay 进程（不与内嵌实例双跑——launchd 双作业退役的教训）；
#      复活手段只有一条：拉起桌面 App（open -a），relay 由壳孵化，单实例锁兜底。
#   2) App 活着时绝不动作（哪怕 8787 死——那是 App #66 监督的辖区，双管齐下会打架）。
#   3) 维护窗静默：touch ~/.cc-deck/data/relay-sentinel.pause 即停动作（只记账）。
#
# 安装（leader/用户拍板后执行，本脚本不自装）：
#   cp scripts/relay-sentinel.sh ~/.cc-deck/bin/ && chmod +x ~/.cc-deck/bin/relay-sentinel.sh
#   sed "s|__SENTINEL__|$HOME/.cc-deck/bin/relay-sentinel.sh|" scripts/relay-sentinel.plist.template \
#     > ~/Library/LaunchAgents/online.humumu.ccdeck.relay-sentinel.plist
#   launchctl load ~/Library/LaunchAgents/online.humumu.ccdeck.relay-sentinel.plist
# 卸载：launchctl unload + 删 plist（哨只是旁路，摘除零残留）。
#
# 退出码：0=健康或按规则不动作；5=试图复活但 health 未转绿（launchd 侧可见失败计数）。
# 日志：~/.cc-deck/data/relay-sentinel.log（自截尾 400 行防膨胀）。

set -uo pipefail

DATA_DIR="${CCR_DATA_DIR:-$HOME/.cc-deck/data}"
LOG="$DATA_DIR/relay-sentinel.log"
APP="${CCR_APP_PATH:-/Applications/CC Deck Nova.app}"   # M2 变体/沙盒演练可覆盖
PAUSE_FLAG="$DATA_DIR/relay-sentinel.pause"
PORT="${CCR_PORT:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8787))' "$DATA_DIR/bridge.json" 2>/dev/null || echo 8787)}"
HEALTH_TIMEOUT="${CCR_SENTINEL_HEALTH_TIMEOUT:-60}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
trim_log() { [ -f "$LOG" ] && tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"; }

healthy() { curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# 健康即退（常态零日志零写）
if healthy; then trim_log; exit 0; fi

# 维护窗：只记账不动作
if [ -f "$PAUSE_FLAG" ]; then log "8787 无响应但暂停旗在位（维护窗）——不动作"; exit 0; fi

# App 活着 → 辖区归 #66 监督（壳会重拉 relay），双管会打架
# pgrep -x 按进程名精确匹配（-f 全命令行会把带该字样的 grep/tail 误当 App）
if pgrep -x 'cc-deck-nova' >/dev/null 2>&1; then log "8787 无响应但 App 在跑（#66 监督辖区）——不动作"; exit 0; fi

# App 没跑：拉起 App（唯一复活手段，绝不直 spawn relay）
if [ ! -d "$APP" ]; then log "❌ App 不存在（$APP）——无法复活，人工跟进"; exit 5; fi
log "⚠️ 8787 无响应且 App 未运行——open -a 复活"
open -a "$APP" || { log "❌ open -a 失败"; exit 5; }

for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if healthy; then log "✅ 复活闭环（health ${i}s 转绿）"; trim_log; exit 0; fi
  sleep 1
done
log "❌ open -a 后 ${HEALTH_TIMEOUT}s health 仍未转绿——App 启动异常或 relay 启动失败，人工跟进"
trim_log
exit 5
