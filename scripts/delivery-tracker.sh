#!/bin/bash
# 交付追踪器：扫全部 worker worktree 进度+超时催办
# 15 分钟一轮（crontab），超 40 分钟无帧自动催办
LOG=/Users/xdd/.cc-deck/data/delivery-tracker.log
CCOPS=/Users/xdd/.cc-deck/bin/ccops.mjs
BASE=6396eb4
NOW=$(date +%s)
echo "[$(date '+%H:%M:%S')] delivery-tracker run" >> "$LOG"

for wt in /private/tmp/cc-deck-w-*; do
  [ -d "$wt" ] || continue
  w=$(basename "$wt" | sed 's/cc-deck-w-//')
  [ "$w" = "mv8b" ] || [ "$w" = "mv8a" ] && continue  # A/B 轨归档线跳过
  n=$(git -C "$wt" status --short 2>/dev/null | wc -l | tr -d ' ')
  c=$(git -C "$wt" log --oneline $BASE..HEAD 2>/dev/null | wc -l | tr -d ' ')
  r=$(ls /Users/xdd/.cc-deck/artifacts/w-$w.md 2>/dev/null | wc -l | tr -d ' ')
  # 查最近帧时间
  SID=$(grep -r "\"cc-deck-w-$w\"" /Users/xdd/.cc-deck/data/events.ndjson 2>/dev/null | tail -1 | grep -o '"session_id":"[a-f0-9-]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$SID" ]; then
    LAST_TS=$(grep "\"session_id\":\"$SID\"" /Users/xdd/.cc-deck/data/events.ndjson 2>/dev/null | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.readline()).get('ts',0))" 2>/dev/null)
    AGE=$(( ( $(date +%s) * 1000 - ${LAST_TS:-0} ) / 60000 ))
  else
    AGE="?"; LAST_TS=0
  fi
  LINE="$w: 改动=$n 提交=$c 回执=$r 帧龄=${AGE}min"
  echo "[$(date '+%H:%M:%S')] $LINE" >> "$LOG"
  # 超 40 分钟无帧且无回执→催办
  if [ "$r" = "0" ] && [ "$AGE" != "?" ] && [ "$AGE" -gt 40 ] 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] ⚠️ $w 超 ${AGE}min 无帧——催办" >> "$LOG"
    if [ -n "$SID" ]; then
      unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY 2>/dev/null
      node "$CCOPS" send "$SID" "PM 催办：你的任务超 40 分钟无进展帧，请回报当前状态或交付。" 2>/dev/null
    fi
  fi
done
echo "[$(date '+%H:%M:%S')] delivery-tracker done" >> "$LOG"
