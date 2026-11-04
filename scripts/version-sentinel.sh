#!/bin/bash
# version-sentinel —— 版本回退捕获哨（W-VERSIONREVERT，1105；bootfast 移交§五独立微单）
# 背景：1104 晚 test.97（tag 20:32:45）装机被 PM 20:57 验证在位后 21:0x 神秘变回
# test.96 中午原件（mtime 12:22 非新下载）——三锚（tauri updater/App 自愈/缓存还原）
# 全部取证排除（见 ~/.cc-deck/artifacts/w-versionrevert.md），结论=碰撞窗人为/会话级
# mv 交换（bad-97-2 备份名=热换家族手笔）。mv 操作者身份无日志可回放（FSEvents 未预
# 启用）→ 本哨下次再犯自动抓现场。
#
# 机制：launchd WatchPaths 盯 /Applications/CC Deck Nova.app/Contents/Info.plist
#（任何 .app 整体交换必 touch 该文件，比盯整个 .app 目录噪音小）+RunAtLoad（机器/
# 会话启动即检一次=启动自检哨的部署态实现；tauritrust /health 三指纹面的衔接见回执）。
# 触发时：①读当前版本+指纹（bin md5 前 8+Info.plist mtime）②与上一快照比对
#（~/.cc-deck/data/version-sentinel.json）③变化即写告警账（version-revert-log.ndjson
# append-only）+ps 快照抓 mv/cp/ditto/rsync 活动进程全 argv（捕凶手的现场证据）
# ④经 /api/notify mode=confirm 黄框推手机。版本低于记录=「回退」标签，高于=「升级」。
#
# 用法：version-sentinel.sh [--dry]（--dry 只打印不发通知——测试用）
# 环境：CCR_DATA_DIR（缺省 ~/.cc-deck/data）/CCR_TOKEN（缺省读 $CCR_DATA_DIR/token）
#  /CCR_PORT（缺省 bridge.json port）；SENTINEL_SKIP_PS=1 跳过 ps 快照（调试）。
# 幂等：无变化零写零通知；首次跑只建快照基线不告警。
set -uo pipefail

APP="/Applications/CC Deck Nova.app"
PLIST="$APP/Contents/Info.plist"
DATA="${CCR_DATA_DIR:-$HOME/.cc-deck/data}"
STATE="$DATA/version-sentinel.json"
LEDGER="$DATA/version-revert-log.ndjson"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
die() { echo "version-sentinel: $2" >&2; exit "$1"; }

[ -f "$PLIST" ] || die 2 "目标 App 不存在: $APP（WatchPaths 触发但 App 缺失=本身即异常，人工核）"

ver="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null)" || die 2 "读版本失败（plist 损坏？）"
bin="$APP/Contents/MacOS/cc-deck-nova"
fp="no-bin"; [ -f "$bin" ] && fp="$(md5 -q "$bin" 2>/dev/null | cut -c1-8)"
plist_m=$(stat -f %m "$PLIST" 2>/dev/null || echo 0)
ts=$(now_ms)

# 与上一快照比对（读侧容错：坏/非单行 STATE 视为无基线重建——哨绝不因状态文件脏而炸）
prev=""
if [ -f "$STATE" ]; then
  prev="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({"version":str(d.get("version","")),"fingerprint":str(d.get("fingerprint","")),"plist_mtime":int(d.get("plist_mtime",0))}))' "$STATE" 2>/dev/null || true)"
fi
# 比较与存态都用无 ts 投影（ts 每跑必变——含进去=恒变化，幂等破——实测坑②）
cur_json="$(python3 -c 'import json,sys;print(json.dumps({"version":sys.argv[1],"fingerprint":sys.argv[2],"plist_mtime":int(sys.argv[3])}))' "$ver" "$fp" "$plist_m")"

if [ -z "$prev" ] || [ "$prev" = "$cur_json" ]; then
  # 无基线=首跑建基线；内容同（plist_mtime 含秒级粒度，WatchPaths 误触也零告警）
  echo "$cur_json" > "$STATE"
  echo "version-sentinel: 基线就绪/无变化 version=$ver fp=$fp"
  exit 0
fi

pver="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("version","?"))' <<<"$prev" 2>/dev/null || echo '?')"
pfp="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("fingerprint","?"))' <<<"$prev" 2>/dev/null || echo '?')"

# 版本走向标签（同版本指纹变=热改；版本低=回退；版本高=升级）。key 解析容错取段：
# 「0.7.0-test.99-nova」→ [0,7,0,99]（-test.N 的 N 为第四序；非 test 版缺省 0 稳定可比）
kind="$(python3 -c '
import sys, re
def key(v):
    nums = re.findall(r"\d+", v)
    return [int(x) for x in nums[:4]] if nums else [0]
a, b = key(sys.argv[1]), key(sys.argv[2])
print("fingerprint-change" if a == b else ("revert" if b < a else "upgrade"))' "$pver" "$ver" 2>/dev/null || echo "unknown")"

# ps 现场快照：文件操作活动进程全 argv（抓 mv/cp/ditto/rsync 及其父链——凶手证据）。
# 注意：本脚本 set -o pipefail——grep 无命中 rc=1 会把管道整体判非零，**不可**再挂
# `|| echo "[]"` 兜底（python 无命中也必输出 "[]"，双写两行反炸 row 构造——实测坑）
ps_snap="[]"
if [ "${SENTINEL_SKIP_PS:-0}" != "1" ]; then
  ps_snap="$(ps -axo pid,ppid,user,lstart,command | grep -E "mv |cp |ditto |rsync |CPCopy|unzip |hdiutil " | grep -v grep | head -8 | python3 -c '
import sys, json
rows=[]
for ln in sys.stdin:
    parts=ln.strip().split(None,4)
    if len(parts)==5: rows.append({"pid":parts[0],"ppid":parts[1],"user":parts[2],"lstart":parts[3],"cmd":parts[4][:300]})
print(json.dumps(rows,ensure_ascii=False))' 2>/dev/null)"
  [ -n "$ps_snap" ] || ps_snap="[]"
fi

row="$(python3 -c 'import json,sys;print(json.dumps({"ts":int(sys.argv[1]),"kind":sys.argv[2],"prev_version":sys.argv[3],"prev_fingerprint":sys.argv[4],"version":sys.argv[5],"fingerprint":sys.argv[6],"plist_mtime":int(sys.argv[7]),"ps_snapshot":json.loads(sys.argv[8])},ensure_ascii=False))' "$ts" "$kind" "$pver" "$pfp" "$ver" "$fp" "$plist_m" "$ps_snap" 2>/dev/null || echo "{\"ts\":$ts,\"kind\":\"$kind\",\"prev_version\":\"$pver\",\"version\":\"$ver\",\"note\":\"row 构造降级（ps 快照丢失）\"}")"

if [ "$DRY" = "1" ]; then
  echo "version-sentinel[dry]: $kind $pver → $ver（fp $pfp → $fp）"
  echo "  告警账将写: $row"
  exit 0
fi

mkdir -p "$DATA"
echo "$cur_json" > "$STATE"                      # 快照推进（幂等：同变化不重报）
echo "$row" >> "$LEDGER"                          # append-only 告警账

# /api/notify 黄框推手机（mode=confirm=需用户处置语义；token 同 leader-dispatch 三段口径）
token="${CCR_TOKEN:-$(cat "$DATA/token" 2>/dev/null || true)}"
port="${CCR_PORT:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$DATA/bridge.json" 2>/dev/null || echo 8787)}"
text="⚠️ 版本哨[$kind]：CC Deck Nova $pver → $ver（fp $pfp→$fp）｜plist_mtime=$(date -r "$plist_m" '+%m-%d %H:%M:%S' 2>/dev/null)｜现场 ps 已入账 version-revert-log.ndjson"
if [ -n "$token" ]; then
  curl -sSf --max-time 5 -X POST "http://127.0.0.1:${port}/api/notify?token=${token}" \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"mode":"confirm","text":sys.argv[1][:200]},ensure_ascii=False))' "$text")" \
    >/dev/null 2>&1 || echo "version-sentinel: /api/notify 发送失败（relay 离线？告警账已落）" >&2
fi
echo "version-sentinel: [$kind] $pver → $ver 已记账+通知"
