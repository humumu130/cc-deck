#!/bin/bash
# swap-nova.sh —— CC Deck Nova 安全换装（W-RELDEATH / DEV-18 P0-A 治根）
#
# 为什么必须有这个脚本（2026-11-24 生产事故复盘，60h+ 全链死寂）：
#   当晚 PM 会话手搓换装收尾：`nohup sh -c 'sleep 1; kill <app> <relay>; sleep 3;
#   open -a 新App; sleep 6; curl /health'`。kill 落下的瞬间，App 壳退出连带
#   SIGKILL 整个进程组——nohup 只挡 SIGHUP 挡不住组杀（tool 回执 Exit code 137），
#   复活段（open -a + health 检查）从未执行，/tmp 健康日志从未落盘。App 一死，
#   内嵌 relay 无人孵化（#66 监督只在壳活着时有效），8787 死寂到次日深夜人工介入。
#   教训铁律：**绝不在被杀进程树内部署「杀完树之后才跑」的复活动作。**
#
# 本脚本的治法：
#   1) 顺序反转安全面：换文件（mv+ditto）先行——运行中的 App 换 bundle 无害；
#   2) 复活段（kill 旧进程 → open -a 新 App → health 轮询）在 python3 setsid
#      双叉脱组的独立会话里跑——杀树杀不到它，脚本调用方死了它也照跑完；
#   3) 全程落日志 ~/.cc-deck/data/swap-nova.log + 判定文件（exit code 语义化），
#      事后可审计（旧版事故连「curl 跑没跑」都无法回放）。
#
# 用法：
#   scripts/swap-nova.sh <产物路径>            # .dmg 或解包后的 .app 目录
#   scripts/swap-nova.sh <产物路径> --no-open  # 换装后不自动拉起（人工接管窗口）
#   scripts/swap-nova.sh <产物路径> --dry-run  # 只打印计划不执行
# 环境CCR_PORT（缺省读 ~/.cc-deck/data/bridge.json 的 port，再缺省 8787）。
# 退出码：0=换装+复活全绿；3=换装成功但 health 未在窗内转绿；4=换装阶段失败；
#   2=参数/前置检查失败。调用方（PM 会话）按码决定是否人工跟进，不许吞。

set -uo pipefail

APP_DST="${CCR_APP_PATH:-/Applications/CC Deck Nova.app}"
APP_PROC="${CCR_APP_PROC:-cc-deck-nova}"   # M2 变体换名/沙盒演练用
DATA_DIR="${CCR_DATA_DIR:-$HOME/.cc-deck/data}"
LOG="$DATA_DIR/swap-nova.log"
HEALTH_TIMEOUT="${CCR_SWAP_HEALTH_TIMEOUT:-90}"   # 复活 health 轮询窗（秒）
KILL_SETTLE="${CCR_SWAP_KILL_SETTLE:-10}"          # kill 后等端口释放（秒）

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG" >&2; }
die() { local code="$1"; shift; log "EXIT($code) $*"; exit "$code"; }

# ── 参数 ──
SRC=""; OPEN_APP=1; DRY=0
for a in "$@"; do
  case "$a" in
    --no-open) OPEN_APP=0 ;;
    --dry-run) DRY=1 ;;
    -*) die 2 "未知参数: $a" ;;
    *) [ -n "$SRC" ] && die 2 "产物路径只收一个（多余: $a）"; SRC="$a" ;;
  esac
done
[ -n "$SRC" ] || die 2 "用法: swap-nova.sh <dmg|app路径> [--no-open] [--dry-run]"
[ -e "$SRC" ] || die 2 "产物不存在: $SRC"

PORT="${CCR_PORT:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8787))' "$DATA_DIR/bridge.json" 2>/dev/null || echo 8787)}"

# ── 前置快照（换装前抓：版本/指纹/活进程——审计与 kill 目标都以这个为准）──
cur_ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo '?'; }
OLD_VER="$(cur_ver "$APP_DST")"
APP_PID="$(pgrep -x "$APP_PROC" | head -1 || true)"
RELAY_PID="$(cat "$DATA_DIR/relay.lock" 2>/dev/null || true)"
[ -n "$RELAY_PID" ] && ! kill -0 "$RELAY_PID" 2>/dev/null && RELAY_PID=""

log "──── swap 开始：src=$SRC port=$PORT old_ver=$OLD_VER app_pid=${APP_PID:-无} relay_pid=${RELAY_PID:-无} open=$OPEN_APP dry=$DRY"

# ── 产物形态归一：.dmg → 挂载取卷内 .app；.app 目录直用 ──
SRC_APP=""
MOUNT_POINT=""
if [ -d "$SRC" ]; then
  SRC_APP="$SRC"
elif [[ "$SRC" == *.dmg ]]; then
  # -plist + plistlib 解析：人读格式是空白对齐（「CC Deck Nova」带空格卷名会被 awk
  # 按空白切碎——2026-11-24 手搓换装当夜的真实形态），结构化解析不受卷名影响
  MOUNT_POINT="$(hdiutil attach "$SRC" -nobrowse -readonly -plist 2>/dev/null | python3 -c 'import plistlib,sys
d=plistlib.loads(sys.stdin.buffer.read())
mps=[e.get("mount-point") for e in d.get("system-entities",[]) if e.get("mount-point")]
print(mps[0] if mps else "")')"
  [ -d "$MOUNT_POINT" ] || die 4 "dmg 挂载失败: $SRC（mount=$MOUNT_POINT）"
  SRC_APP="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' | head -1)"
  [ -d "$SRC_APP" ] || { hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1; die 4 "卷内未找到 .app: $MOUNT_POINT"; }
else
  die 2 "产物既非 .dmg 也非 .app 目录: $SRC"
fi
NEW_VER="$(cur_ver "$SRC_APP")"
log "产物就绪：$SRC_APP（版本 $NEW_VER）"

if [ "$DRY" = 1 ]; then
  log "dry-run 计划：bak 旧($OLD_VER) → ditto 新($NEW_VER) → detach → 脱组复活段(kill ${APP_PID:-无}/${RELAY_PID:-无} → open=$OPEN_APP → health ${HEALTH_TIMEOUT}s)"
  [ -n "$MOUNT_POINT" ] && hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1
  exit 0
fi

# ── 换文件（对运行中的 App 无害——先做）──
BAK="${APP_DST%.app}-bak-$(date '+%Y%m%d-%H%M%S').app"
if [ -d "$APP_DST" ]; then
  mv "$APP_DST" "$BAK" || die 4 "旧 App 移走失败（$BAK）"
fi
# 拷贝引擎：macOS 用 ditto（保元数据/时戳，生产行为字节不变）；非 mac（Linux CI
# 跑 test:swapguard 全链沙盒）回落 cp -a——swap-nova 生产面是 mac 换装，回落只为
# 测试链路可跑（CI runner 实测 ditto 缺席 exit 4 根因，2026-11-28 P1-1 返修随批）
if command -v ditto >/dev/null 2>&1; then
  ditto "$SRC_APP" "$APP_DST" || die 4 "ditto 拷贝失败（$SRC_APP → $APP_DST）"
else
  cp -a "$SRC_APP" "$APP_DST" || die 4 "cp -a 拷贝失败（$SRC_APP → $APP_DST，非 mac 无 ditto）"
fi
INSTALLED_VER="$(cur_ver "$APP_DST")"
[ "$INSTALLED_VER" = "$NEW_VER" ] || log "⚠️ 装后版本($INSTALLED_VER)与产物($NEW_VER)不一致（ditto -p 保时戳的已知面，人工核）"
[ -n "$MOUNT_POINT" ] && hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1
log "换装完成：$OLD_VER → $INSTALLED_VER（备份 $BAK）"

# ── 复活段：python3 setsid 双叉脱组——杀树（killpg）杀不到本段 ──
VERDICT="$DATA_DIR/swap-nova.verdict"
# DEV-18 审查 P2（2026-11-27 移交本批）：发射 payload 前清陈旧 verdict——上一轮若在
# 「payload 落 verdict 后、本脚本收尸 rm 前」被杀（或超时窗遗留），本轮等待循环首拍
# 即见旧文件：读到的 exit code 属于上一轮（可能 0）→ 假绿收割。发射前 rm = 等待窗内
# 出现的 verdict 必属本轮 payload。
rm -f "$VERDICT"
# mktemp 模板 X 串必须在尾部：`.XXXXXX.sh` 中缀形态会被 BSD mktemp 当字面文件名，
# 第二次换装即 O_EXCL 撞死（沙盒复跑实锤）→ payload 空 → 复活段无声丢失
PAYLOAD="$(mktemp /tmp/swap-nova-payload.XXXXXX)"
[ -n "$PAYLOAD" ] || die 4 "mktemp 失败（payload 无法生成）"
cat > "$PAYLOAD" <<EOF
#!/bin/bash
# 脱组复活段（由 swap-nova.sh 生成，ts $(date '+%F %T')）——独立会话运行，调用方死活不影响
LOG="$LOG"; VERDICT="$VERDICT"; APP="$APP_DST"; PORT="$PORT"
OPEN_APP=$OPEN_APP; APP_PID="${APP_PID:-}"; RELAY_PID="${RELAY_PID:-}"
KILL_SETTLE=$KILL_SETTLE; HEALTH_TIMEOUT=$HEALTH_TIMEOUT
log(){ echo "[\$(date '+%Y-%m-%d %H:%M:%S')] [revive] \$*" >> "\$LOG"; }
[ -n "\$APP_PID" ] && kill "\$APP_PID" 2>/dev/null && log "kill app pid=\$APP_PID"
[ -n "\$RELAY_PID" ] && kill "\$RELAY_PID" 2>/dev/null && log "kill relay pid=\$RELAY_PID"
for i in \$(seq 1 \$KILL_SETTLE); do
  lsof -nP -iTCP:\$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
if lsof -nP -iTCP:\$PORT -sTCP:LISTEN >/dev/null 2>&1; then log "⚠️ 端口 \$PORT \$KILL_SETTLE s 后仍被占（外部 relay？让位不抢）"; fi
if [ "\$OPEN_APP" = "1" ]; then
  open -a "\$APP" && log "open -a 已发（\$(basename "\$APP")）" || log "⚠️ open -a 失败"
else
  log "--no-open：不自动拉起，人工接管窗口"; echo 0 > "\$VERDICT"; exit 0
fi
for i in \$(seq 1 \$HEALTH_TIMEOUT); do
  if curl -fsS -m 3 "http://127.0.0.1:\$PORT/health" >/dev/null 2>&1; then
    log "✅ health 转绿（\${i}s）——换装+复活全链绿"
    echo 0 > "\$VERDICT"; exit 0
  fi
  sleep 1
done
log "❌ health ${HEALTH_TIMEOUT}s 未转绿——App 拉起失败或 relay 启动异常，人工跟进"
echo 3 > "\$VERDICT"; exit 3
EOF
chmod +x "$PAYLOAD"
python3 - "$PAYLOAD" <<'PY' >/dev/null 2>&1 &
import os, sys
payload = sys.argv[1]
# 先 fork 后 setsid（次序是铁的）：setsid 要求调用方非组长——调用方若已是组长
# （shell 作业控制形态）直接 setsid 会 EPERM 静默死，复活动作无声丢失（沙盒演练
# 实锤）。先叉出的子体必非组长，setsid 必成；父体即刻退，payload 托孤新会话。
if os.fork() != 0:
    os._exit(0)
os.setsid()
os.execv("/bin/sh", ["sh", payload])
PY
log "复活段已脱组发射（payload $PAYLOAD）——等待判定（至多 $((HEALTH_TIMEOUT + KILL_SETTLE + 15))s）"

# ── 等判定：调用方若在此窗内被杀（本就在树内），脱组段仍会跑完并落 verdict ──
WAIT=$((HEALTH_TIMEOUT + KILL_SETTLE + 15)); ELAPSED=0
while [ "$ELAPSED" -lt "$WAIT" ]; do
  [ -f "$VERDICT" ] && break
  sleep 2; ELAPSED=$((ELAPSED + 2))
done
if [ -f "$VERDICT" ]; then
  CODE="$(cat "$VERDICT")"; rm -f "$VERDICT"
  [ "$CODE" = "0" ] && log "EXIT(0) 换装+复活闭环" || log "EXIT($CODE) 复活段报告异常（明细见上）"
  exit "$CODE"
fi
die 3 "判定文件超时未落（脱组段疑被外因终止）——人工查 $LOG"
