#!/bin/bash
# cc-deck 独立巡检哨兵 v3（P0-3 / DEV-43，2026-11-28 通电批）
#
# 定位：relay 外存活体，专看「relay 自己看不到的病」——relay 一死，relay 内置巡检
# （relay/src/patrol.ts）陪葬，必须有一个不依赖 relay 的哨兵。launchd/定时器每 30min 一拍。
#
# v1（~/.cc-deck/bin/patrol.sh）三宗罪（本次事故实锤，详 DEV-19 回执）：
#   ① worker 帧新鲜度探针硬编码 9 个 10 月夜班 worker 会话前缀 × grep events.ndjson
#     ——events.ndjson 是**压缩存储**（relay 每次 boot 压到最近活跃 30 会话，MAX_SESSIONS_KEPT），
#     旧 worker 事件必然老化出窗 → 「无帧(999m)」是存储语义不是链路病，却被误读成
#     「注入链全灭」；且无帧永不告警（⚠️ 只判 WORKING 停滞），信号变成噪声。
#   ② 告警通道走 /api/notify = 路由经 relay 本体——relay 死亡（正是最该叫的时候）
#     告警进黑洞，P0-A >24h 无人知晓的直接根因。
#   ③ 报告 tail-200 截断，故障 onset 无法回溯（「11-23 14:13 起」实为保留边界）。
#
# v2（DEV-19）职责（做减法：worker 帧新鲜度归 relay 内置巡检——它读内存活快照，语义才对）：
#   ① relay 活性：连续 2 拍失败 → osascript 本机通知（不经 relay 的独立通道）+ 报告
#   ② hook 上报腿：relay 活着但 hook-post-fail.json 显示持续失败 → 独立通道告警
#   ③ 磁盘余量 <5GB → 告警（episode 一次性，恢复写 RECOVERED）
#   ④ 任务表对账漂移（直读板文件，不经 relay）
#   ⑤ 报告 tail-400 保留（v1 的 200 行太短，onset 回溯需要更长窗）
#
# v3（DEV-43 / P0-3 实弹）两刀：
#   ⑥ 断档必达手机推送（云桥直连）：relay 死亡告警不再只靠本机 osascript（只救
#     「人在电脑前」）——POST 云桥 /alert 定向推已配对手机（桥 CF 侧在线，与
#     本机 relay/app 存活无关——「独立」的定义）。回执落报告行（delivered 真值）。
#   ⑦ 哨自身心跳可见位：每拍写 patrol-heartbeat.json（ts/relay/disk/beat）——
#     「哨也静默死」（plist 被卸/脚本连败）从不可见变可观测；relay 内置巡检轻探针
#     互补读此文件（sentinel-stale 键，relay 活着恰是能看出哨死的唯一时刻）。
#
# 部署（leader 清单项）：本文件安装为 ~/.cc-deck/bin/patrol.sh，launchd
# 标签/周期不变。测试通路：全路径 env 可覆盖（PATROL_*），见 scripts/test-patrol-standalone.sh。

REPORT="${PATROL_REPORT:-$HOME/.cc-deck/patrol-report.md}"
DATA_DIR="${PATROL_DATA_DIR:-$HOME/.cc-deck/data}"
RELAY_URL="${PATROL_RELAY_URL:-http://127.0.0.1:8787/}"
STATE_FILE="${PATROL_STATE:-$DATA_DIR/patrol-relay-state.json}"
HEARTBEAT_FILE="${PATROL_HEARTBEAT:-$DATA_DIR/patrol-heartbeat.json}"
DISK_MIN_GB="${PATROL_DISK_MIN_GB:-5}"
CONFIRM_ROUNDS="${PATROL_CONFIRM_ROUNDS:-2}"

# 云桥直连推送（⑥）：PATROL_PUSH=0 应急停。桥端点/token/目标三级解析：
#   URL   PATROL_BRIDGE_URL（完整 /alert 端点）→ 缺省 cc.humumu.online 公共桥
#   token PATROL_BRIDGE_TOKEN → $DATA_DIR/cloud-token 文件 → 公共桥公开 token
#   目标  PATROL_PUSH_TO（逗号分隔）→ cloud-peers.json 的 ph-* 条目（最近活跃优先）
BRIDGE_ALERT_URL="${PATROL_BRIDGE_URL:-https://cc.humumu.online/alert}"
BRIDGE_TOKEN_RESOLVED="$( [ -n "$PATROL_BRIDGE_TOKEN" ] && printf '%s' "$PATROL_BRIDGE_TOKEN" || { [ -s "$DATA_DIR/cloud-token" ] && head -c 200 "$DATA_DIR/cloud-token" | tr -d '[:space:]' || printf 'ccdeck-public-9f3k2m7v'; } )"

phone_devs() {
  if [ -n "$PATROL_PUSH_TO" ]; then printf '%s' "$PATROL_PUSH_TO"; return; fi
  python3 - "$DATA_DIR/cloud-peers.json" <<'PYEOF' 2>/dev/null || true
import json, sys
try: peers = json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
rows = sorted(((v.get("last_seen") or 0, k) for k, v in peers.items() if k.startswith("ph-")), reverse=True)
print(",".join(k for _, k in rows))
PYEOF
}

# 手机推送（尽力而为，绝不阻巡检主流程）。回执落报告行：push:ok / push:offline /
# push:fail(原因)——delivered 真值可对账（演练验收证据位）。任一目标 delivered
# 即回 0（「必达」语义=到达任一在线手机；全失败回 1 供上层重试位记账）。
push_phone() { # $1=title $2=body $3=level(缺省 critical)
  [ "${PATROL_PUSH:-1}" = "0" ] && return 0
  local DEVS; DEVS="$(phone_devs)"
  [ -z "$DEVS" ] && { line "push:skip（无已配对手机）"; return 0; }
  local TITLE="$1" BODY="$2" LEVEL="${3:-critical}" ANY_OK=0
  local OLDIFS="$IFS"; IFS=','
  for DEV in $DEVS; do
    [ -z "$DEV" ] && continue
    local RESP
    RESP=$(python3 - "$BRIDGE_ALERT_URL" "$BRIDGE_TOKEN_RESOLVED" "$DEV" "$TITLE" "$BODY" "$LEVEL" <<'PYEOF' 2>/dev/null
import json, sys, urllib.request
url, token, dev, title, body, level = sys.argv[1:7]
# UA 必须自报：python-urllib 缺省 UA 被 CF Bot Fight Mode 拦（error 1010，实弹演练
# 2026-11-28 实锤）——自报产品 UA 过 Browser Integrity Check
req = urllib.request.Request(url, data=json.dumps({"to": dev, "title": title, "body": body, "level": level}).encode(),
                             headers={"content-type": "application/json", "authorization": "Bearer " + token,
                                      "user-agent": "cc-deck-sentinel/1.0 (patrol-standalone)"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        d = json.loads(r.read() or b"{}")
        print("ok" if r.status == 200 and d.get("ok") else "fail:" + str(r.status))
except urllib.error.HTTPError as e:
    detail = ""
    try: detail = (e.read() or b"{}").decode()[:120]
    except Exception: pass
    print("fail:%d:%s" % (e.code, detail))
except Exception as e:
    print("fail:" + str(e)[:120])
PYEOF
) || true
    line "push[$DEV]:${RESP:-fail:no-response}"
    [ "${RESP%%:*}" = "ok" ] && ANY_OK=1
  done
  IFS="$OLDIFS"
  return $((1-ANY_OK))
}

# 独立告警通道：不经 relay。PATROL_NOTIFY 可整体替换（测试钩子），缺省 osascript
# 本机通知（macOS 通知中心——relay 死了它也活着；失败尽力而为不阻流程）
notify() { # $1=title $2=body
  if [ -n "$PATROL_NOTIFY" ]; then
    eval "$PATROL_NOTIFY"
  else
    osascript -e "display notification \"${2//\"/\\\"}\" with title \"${1//\"/\\\"}\"" >/dev/null 2>&1 || true
  fi
}

NOW=$(date '+%m-%d %H:%M')
STAMP=$(date +%s)
line() { echo "[$NOW] $*" >> "$REPORT"; }
mkdir -p "$(dirname "$REPORT")" "$(dirname "$STATE_FILE")" 2>/dev/null || true

# ---------- 状态账（episode 去重：同类告警一次episode只叫一次，恢复写行） ----------
# relay_push_ok：断档推送「必达」位——告警拍推送全部失败（手机离线）时保持 0，
# 后续每拍重试直到任一目标 delivered；成功即置 1（同 episode 不再重推防刷屏）。
read_state() { python3 -c "
import json
try: d=json.load(open('$STATE_FILE'))
except Exception: d={}
print(json.dumps({k: (d.get(k) or 0) for k in ('relay_down','relay_first_down','relay_alerted','relay_push_ok','disk_alerted','hook_alerted')}))
" 2>/dev/null || echo '{}'; }
write_state() { printf '%s' "$1" > "$STATE_FILE" 2>/dev/null || true; }
STATE=$(read_state)

# ---------- ① relay 活性（双拍确认 + 独立通道） ----------
RELAY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RELAY_URL" 2>/dev/null)
RELAY_DOWN=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('relay_down',0))" 2>/dev/null || echo 0)
RELAY_ALERTED=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('relay_alerted',0))" 2>/dev/null || echo 0)
RELAY_FIRST_DOWN=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('relay_first_down',0))" 2>/dev/null || echo 0)
RELAY_PUSH_OK=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('relay_push_ok',0))" 2>/dev/null || echo 0)
if [ "$RELAY" != "200" ]; then
  RELAY_DOWN=$((RELAY_DOWN + 1))
  [ "$RELAY_DOWN" -eq 1 ] && RELAY_FIRST_DOWN=$STAMP
  if [ "$RELAY_DOWN" -ge "$CONFIRM_ROUNDS" ] && [ "$RELAY_ALERTED" -ne 1 ]; then
    RELAY_ALERTED=1
    SPAN_MIN=$(( (STAMP - RELAY_FIRST_DOWN) / 60 ))
    notify "⚠️ cc-deck relay 无响应" "已连续 ${RELAY_DOWN} 拍（首拍起约 ${SPAN_MIN}min）HTTP=${RELAY:-无}——注入/派单/通知链全停，需人工恢复（P0 级）"
    if push_phone "⚠️ cc-deck relay 无响应" "已连续 ${RELAY_DOWN} 拍（首拍起约 ${SPAN_MIN}min）HTTP=${RELAY:-无}——注入/派单/通知链全停，需人工恢复（P0 级）" critical; then
      RELAY_PUSH_OK=1
    fi
    line "ALERT [relay] 连续 ${RELAY_DOWN} 拍无响应（HTTP=${RELAY:-无}，首拍 $(date -r "$RELAY_FIRST_DOWN" '+%m-%d %H:%M' 2>/dev/null)）——已本机通知+手机推送"
  elif [ "$RELAY_ALERTED" -eq 1 ] && [ "$RELAY_PUSH_OK" -ne 1 ]; then
    # 必达重试：告警已发但推送全败（手机当时离线）——每拍重试直到任一目标 delivered
    #（本机通知不重弹；成功即置位，同 episode 不再推防刷屏）
    if push_phone "⚠️ cc-deck relay 无响应（重试）" "已连续 ${RELAY_DOWN} 拍 HTTP=${RELAY:-无}——前次推送未达，重试中（P0 级）" critical; then
      RELAY_PUSH_OK=1
      line "push-retry [relay] 重试投达——必达位闭合"
    else
      line "relay:$RELAY（连续失败 ${RELAY_DOWN} 拍，推送仍未达——下拍续试）"
    fi
  else
    line "relay:$RELAY（连续失败 ${RELAY_DOWN} 拍）"
  fi
else
  if [ "$RELAY_ALERTED" -eq 1 ] || [ "$RELAY_DOWN" -ge "$CONFIRM_ROUNDS" ]; then
    line "RECOVERED [relay] 恢复 200（前述停机窗已结束，push_ok=${RELAY_PUSH_OK}）"
  fi
  RELAY_DOWN=0; RELAY_ALERTED=0; RELAY_FIRST_DOWN=0; RELAY_PUSH_OK=0
fi

# ---------- ② hook 上报腿（relay 活着才判：relay 死时 hook 必然失败，①已覆盖） ----------
HOOK_STATUS=$(python3 -c "
import json,time,os
now=time.time()*1000
fresh_ms=float(os.environ.get('PATROL_HOOKFAIL_FRESH_MS','600000'))
sustain_ms=float(os.environ.get('PATROL_HOOKFAIL_SUSTAIN_MS','600000'))
try: d=json.load(open('$DATA_DIR/hook-post-fail.json'))
except Exception: print('noauth'); raise SystemExit
if int(d.get('streak') or 0)<=0: print('ok'); raise SystemExit
lf=float(d.get('lastFailAt') or 0); ff=float(d.get('firstFailAt') or 0)
if now-lf<fresh_ms and ff>0 and now-ff>=sustain_ms:
    print('failing|%d|%s' % (int((now-ff)/60000), str(d.get('lastErr') or '')[:80]))
else: print('stale-fail|%d' % int((now-lf)/60000))
" 2>/dev/null || echo "noauth")
HOOK_ALERTED=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hook_alerted',0))" 2>/dev/null || echo 0)
if [ "$RELAY" = "200" ] && [[ "$HOOK_STATUS" == failing* ]]; then
  HOOK_MIN="${HOOK_STATUS#failing|}"; HOOK_MIN="${HOOK_MIN%%|*}"
  HOOK_ERR="${HOOK_STATUS##*|}"
  if [ "$HOOK_ALERTED" -ne 1 ]; then
    HOOK_ALERTED=1
    notify "⚠️ cc-deck hook 上报失败" "relay 在线但 hook 持续失败 ≥${HOOK_MIN}min（${HOOK_ERR}）——用户 CLI 事件进不了 relay，注入/审批链断"
    push_phone "⚠️ cc-deck hook 上报失败" "relay 在线但 hook 持续失败 ≥${HOOK_MIN}min（${HOOK_ERR}）——用户 CLI 事件进不了 relay，注入/审批链断" critical
    line "ALERT [hook-post-fail] relay 在线但 hook 持续失败 ≥${HOOK_MIN}min（${HOOK_ERR}）——已本机通知+手机推送"
  else
    line "hook-post-fail: 仍持续失败 ≥${HOOK_MIN}min（${HOOK_ERR}）"
  fi
else
  if [ "$HOOK_ALERTED" -eq 1 ]; then line "RECOVERED [hook-post-fail] hook 上报恢复"; fi
  HOOK_ALERTED=0
fi

# ---------- ③ 磁盘 ----------
DISK=$(df -h /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $4}')
DISK_NUM=$(echo "$DISK" | grep -oE '^[0-9]+' || echo 999)
DISK_ALERTED=$(printf '%s' "$STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('disk_alerted',0))" 2>/dev/null || echo 0)
if [ "$DISK_NUM" -lt "$DISK_MIN_GB" ] 2>/dev/null; then
  if [ "$DISK_ALERTED" -ne 1 ]; then
    DISK_ALERTED=1
    notify "⚠️ 磁盘余量 ${DISK}" "低于 ${DISK_MIN_GB}GB 红线——磁盘满会连锁杀 relay/CLI（历史反复发生）"
    push_phone "⚠️ 磁盘余量 ${DISK}" "低于 ${DISK_MIN_GB}GB 红线——磁盘满会连锁杀 relay/CLI（历史反复发生）" critical
  fi
  line "ALERT [disk] 余量 ${DISK}（红线 ${DISK_MIN_GB}GB）"
else
  [ "$DISK_ALERTED" -eq 1 ] && line "RECOVERED [disk] 余量回升 ${DISK}"
  DISK_ALERTED=0
fi

# ---------- ④ 任务表对账漂移（直读板文件，不经 relay；沿用 v1 口径） ----------
BOARD_PATROL=$(python3 -c "
import json,glob,time,os
now=time.time()*1000
alerts=[]
root=os.environ.get('PATROL_ORG_DIR') or os.path.expanduser('~/.cc-deck/org/boards')
for p in glob.glob(os.path.join(root,'*.json')):
    try: d=json.load(open(p))
    except Exception: continue
    for e in d.get('entries',[]):
        if e.get('status')=='claimed':
            age=(now-e.get('updated_at',now))/3600000
            if age>48: alerts.append('claimed停滞%.0fh:%s'%(age,str(e.get('text',''))[:20]))
        elif e.get('status')=='submitted':
            pass
    if any(e.get('status')=='submitted' for e in d.get('entries',[])):
        alerts.append('submitted待验收:%d条'%sum(1 for e in d.get('entries',[]) if e.get('status')=='submitted'))
print(' | '.join(alerts) if alerts else 'OK')
" 2>/dev/null || echo "巡检错误")
line "任务表: $BOARD_PATROL"

# ---------- 状态落盘 + 心跳可见位（⑦）+ 报告裁剪 ----------
write_state "{\"relay_down\":$RELAY_DOWN,\"relay_first_down\":$RELAY_FIRST_DOWN,\"relay_alerted\":$RELAY_ALERTED,\"relay_push_ok\":$RELAY_PUSH_OK,\"disk_alerted\":$DISK_ALERTED,\"hook_alerted\":$HOOK_ALERTED,\"ts\":$STAMP}"
# 心跳每拍必写（relay 死时恰是它最该活的时刻）：relay 内置巡检轻探针读 ts 判
# sentinel-stale（缺省 100min 阈），「哨也静默死」从不可见变可观测
printf '{"ts":%s,"relay":"%s","disk":"%s","interval_ms":%s,"pid":%s}\n' \
  "$STAMP" "$RELAY" "$DISK" "${PATROL_INTERVAL_MS:-1800000}" "$$" > "$HEARTBEAT_FILE" 2>/dev/null || true
line "哨兵: relay:$RELAY 磁盘:$DISK | hook腿:${HOOK_STATUS%%|*}"
tail -400 "$REPORT" > "$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"
