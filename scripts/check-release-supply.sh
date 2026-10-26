#!/usr/bin/env bash
# 发版链防断供闸（#262）：test 桌面包 KV 同步告警 + 快照指针检查
# ============================================================
# 背景（1026 用户公司装机实锤）：desktop CI 出 tag 即出包（57→66 共 11 版 run
# success），但 build-test-desktop.sh 是手动脚本未跑 → CF KV tauri-latest-test.json
# 停 test.56，公司网用户（仅 KV 通道可达）断供 11 版被掩盖（家庭通道正常）。同类：
# cc-deck-snap-latest-setup.exe 快照指针停 0.6.0-snap.2 长期漂移。
#
# 两项检查（全程只读——curl 公开下载 URL，不碰 KV 写、不动 ECS）：
#   ① test-kv 断供闸：git 最新 v*-test* tag vs KV tauri-latest-test.json 的
#      version，落后即断供告警（行动出口=跑 build-test-desktop.sh <ver>）
#   ② snap-ptr 指针闸：git 最新 v*-snap.* tag vs KV 两指针面
#      （snap-latest-setup.exe 的 content-disposition 版本化文件名 +
#       snap-latest.apk 302 location 指向的版本化文件名），漂移即告警
#      （行动出口=跑 update-snap-dist.sh v<ver>）
# 输出面：stdout（✅/❌ + 汇总，rc 0/1 可当发版检查闸）+ patrol-report.md 追加行
# （对齐 ~/.cc-deck/bin/patrol.sh 手工巡检格式）+ 告警时 /api/notify 推手机。
# 告警必须带行动出口（exp-3721561e）：每条 ❌ 都给修复命令。
#
# 用法：scripts/check-release-supply.sh
#   CCR_SUPPLY_KV_BASE     KV/CF 基址（默认 https://cc.humumu.online；测试指向本地假 server）
#   CCR_SUPPLY_REPO_DIR    git 仓库位（默认脚本仓库根；测试指向假 git repo）
#   CCR_SUPPLY_REPORT      patrol-report 路径（默认 ~/.cc-deck/patrol-report.md；/dev/null 禁写）
#   CCR_SUPPLY_NOTIFY=0    禁手机推送（测试用；默认告警即推）
#   CCR_SUPPLY_TOKEN_FILE  notify token 文件（默认 ~/.cc-deck/data/token）
#   CCR_SUPPLY_PATROL_URL  notify 端点（默认 http://127.0.0.1:8787/api/notify）
# git 侧说明：用本地 tag（发版 tag 必从本机推，本地即最新），不 fetch——巡检频繁
# fetch 会骚扰网络且 github 直连超时需代理；跨机跑时先 git fetch --tags。
# bash 3.2（macOS）兼容，#253 军规：禁止 `$name<多字节>` 邻接，需邻接一律 ${name}字。
set -uo pipefail
REPO_DIR="${CCR_SUPPLY_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
KV_BASE="${CCR_SUPPLY_KV_BASE:-https://cc.humumu.online}"
REPORT="${CCR_SUPPLY_REPORT:-$HOME/.cc-deck/patrol-report.md}"
TOKEN_FILE="${CCR_SUPPLY_TOKEN_FILE:-$HOME/.cc-deck/data/token}"
PATROL_URL="${CCR_SUPPLY_PATROL_URL:-http://127.0.0.1:8787/api/notify}"
FAIL=0
ALERTS=""

# ---------- 版本比较（与 deploy-web.sh ver_cmp 函数组同款语义；改一处须查另一处）----------
ver_shape_ok() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; }
# 形状闸（nova 感知）：ver_shape_ok 字符类不含 `-`，而本闸要比较带 -nova 通道后缀的
# 全串（KV 清单/tag 都带）——对齐 deploy-web.sh face_ver_check 先例：形状校验剥一层
# 尾部 -nova 再做（嵌套 -nova-nova 剥一层仍含 `-` 即拒，fail-closed 保守正确）
shape_of() { local v="${1%-nova}"; ver_shape_ok "$v"; }
ver_core_cmp() { # $1/$2 点分数字 core → -1|0|1（数值逐段）
  local IFS=.
  local A=() B=()
  read -ra A <<< "$1"; read -ra B <<< "$2"
  local n=${#A[@]}
  if (( ${#B[@]} > n )); then n=${#B[@]}; fi
  local i x y
  for ((i=0; i<n; i++)); do
    x="${A[i]:-0}"; y="${B[i]:-0}"
    if ! [[ "$x" =~ ^[0-9]+$ ]]; then x=0; fi
    if ! [[ "$y" =~ ^[0-9]+$ ]]; then y=0; fi
    if (( x < y )); then echo -1; return; fi
    if (( x > y )); then echo 1; return; fi
  done
  echo 0
}
ver_pre_cmp() { # $1/$2 prerelease 段（.-分隔）→ -1|0|1（semver：数字段数值<字母段字典；短前缀小）
  local IFS='.-'
  local A=() B=()
  read -ra A <<< "$1"; read -ra B <<< "$2"
  local n=${#A[@]}
  if (( ${#B[@]} > n )); then n=${#B[@]}; fi
  local i x y xn yn
  for ((i=0; i<n; i++)); do
    x="${A[i]:-}"; y="${B[i]:-}"
    if [ -z "$x" ]; then echo -1; return; fi
    if [ -z "$y" ]; then echo 1; return; fi
    xn=0; yn=0
    if [[ "$x" =~ ^[0-9]+$ ]]; then xn=1; fi
    if [[ "$y" =~ ^[0-9]+$ ]]; then yn=1; fi
    if (( xn && yn )); then
      if (( x < y )); then echo -1; return; fi
      if (( x > y )); then echo 1; return; fi
    elif (( xn != yn )); then
      if (( xn )); then echo -1; else echo 1; fi
      return
    else
      if [[ "$x" < "$y" ]]; then echo -1; return; fi
      if [[ "$x" > "$y" ]]; then echo 1; return; fi
    fi
  done
  echo 0
}
ver_cmp() { # $1/$2 版本串（调用方已过形状闸）→ -1|0|1（semver 方向）
  local a="$1" b="$2" ac bc ap="" bp="" r
  ac="${a%%-*}"; bc="${b%%-*}"
  if [[ "$a" == *-* ]]; then ap="${a#*-}"; fi
  if [[ "$b" == *-* ]]; then bp="${b#*-}"; fi
  r="$(ver_core_cmp "$ac" "$bc")"
  if [ "$r" != "0" ]; then echo "$r"; return; fi
  if [ -z "$ap" ] && [ -z "$bp" ]; then echo 0; return; fi
  if [ -z "$ap" ]; then echo 1; return; fi
  if [ -z "$bp" ]; then echo -1; return; fi
  ver_pre_cmp "$ap" "$bp"
}

# ---------- git 侧：tag 列表里择最大版本（剥 v 前缀；形状非法剔除 fail-closed）----------
max_tag_ver() { # $1=tag glob → echo 最大版本串（空=无合法 tag）
  local best="" t v
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    v="${t#v}"
    shape_of "$v" || continue
    if [ -z "$best" ] || [ "$(ver_cmp "$v" "$best")" = "1" ]; then best="$v"; fi
  done < <(git -C "$REPO_DIR" tag -l "$1" 2>/dev/null)
  echo "$best"
}

# ---------- KV 侧：指针版本提取 ----------
disp_ver_of() { # $1=content-disposition 头值 → 版本串（提不出=空）
  # update-snap-dist.sh 写入 metadata.filename="CC Deck_<ver>_x64-setup.exe"；
  # 头里 percent-encode，版本字符集 [A-Za-z0-9.-] 中仅空格场景不出现，%20 兜底解码
  local fn="$1"
  fn="${fn#*filename=\"}"; fn="${fn%%\"*}"
  fn="${fn//%20/ }"
  [[ "$fn" =~ ^CC\ Deck_(.+)_x64-setup\.exe$ ]] || { echo ""; return; }
  echo "${BASH_REMATCH[1]}"
}
loc_ver_of() { # $1=302 location 头值 → 版本串；指针缺失回落稳定名 → "snap-latest"（调用方识别）
  local loc="${1##*/}"
  [[ "$loc" =~ ^cc-deck-(.+)\.apk$ ]] || { echo ""; return; }
  echo "${BASH_REMATCH[1]}"
}

# ---------- 输出面 ----------
say() { echo "$@"; }
bad() { echo "❌ $*"; FAIL=1; ALERTS="${ALERTS:+${ALERTS}；}$*"; }
report_line() { # $1=supply 行内容（对齐手工 patrol.sh 格式追加 + tail 200 防膨胀；落盘失败不影响巡检）
  [ "$REPORT" = "/dev/null" ] && return 0
  local now
  now="$(date '+%m-%d %H:%M')"
  { echo "[$now] $1" >> "$REPORT" 2>/dev/null &&
    tail -200 "$REPORT" > "$REPORT.tmp" 2>/dev/null && mv "$REPORT.tmp" "$REPORT"; } || true
  return 0
}
notify_alerts() { # 告警推手机（对齐手工 patrol.sh /api/notify 通道；失败不阻断）
  [ -z "$ALERTS" ] && return 0
  [ "${CCR_SUPPLY_NOTIFY:-1}" = "0" ] && return 0
  local tok=""
  tok="$(tr -d '\n ' < "$TOKEN_FILE" 2>/dev/null || true)"
  [ -n "$tok" ] || return 0
  curl -s --max-time 5 -X POST "$PATROL_URL?token=$tok" \
    -H 'content-type: application/json' \
    -d "{\"title\":\"⚠️ 发版链断供\",\"body\":\"$ALERTS\"}" >/dev/null 2>&1 || true
}

say "== 发版链供给检查 ==（KV: ${KV_BASE}，repo: ${REPO_DIR}）"

# ---------- ① test 桌面包 KV 断供闸 ----------
TEST_SUMMARY="?"
GIT_TEST="$(max_tag_ver 'v*-test*')"
KV_TEST="$(curl -sS --max-time 15 "$KV_BASE/download/tauri-latest-test.json" 2>/dev/null \
  | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin)["version"])
except Exception: print("")' 2>/dev/null || echo "")"
if [ -z "$GIT_TEST" ]; then
  bad "git 无合法 v*-test* tag（仓库状态异常？检查 ${REPO_DIR}）"
  TEST_SUMMARY="无tag"
elif [ -z "$KV_TEST" ]; then
  bad "KV tauri-latest-test.json 读不到/无 version 字段（CF 或网络故障）——检查 $KV_BASE 可达性后重跑；不可达期间公司网用户无法自查断供"
  TEST_SUMMARY="读不到"
elif ! shape_of "$KV_TEST"; then
  bad "KV test 清单 version 形状非法：${KV_TEST}（清单被写坏？重跑 scripts/build-test-desktop.sh $GIT_TEST 覆写）"
  TEST_SUMMARY="形状非法"
else
  case "$(ver_cmp "$KV_TEST" "$GIT_TEST")" in
    0) say "✅ test 桌面清单 = 最新 tag（${KV_TEST}）"; TEST_SUMMARY="$KV_TEST" ;;
    -1) bad "test 桌面断供：KV 清单停 ${KV_TEST}，最新 tag ${GIT_TEST}（公司网仅 KV 通道可达，用户已断供）——行动：scripts/build-test-desktop.sh $GIT_TEST"
        TEST_SUMMARY="${KV_TEST}→落后${GIT_TEST}" ;;
    1) bad "KV test 清单 ${KV_TEST} 超前最新 tag ${GIT_TEST}（tag 被删或清单传错版本）——核对后重跑 scripts/build-test-desktop.sh $GIT_TEST"
       TEST_SUMMARY="${KV_TEST}>超前" ;;
  esac
fi

# ---------- ② 快照指针闸（KV 两指针面）----------
SNAP_SUMMARY="?"
GIT_SNAP="$(max_tag_ver 'v*-snap.*')"
DISP_RAW="$(curl -sSI --max-time 15 "$KV_BASE/dl/cc-deck-snap-latest-setup.exe" 2>/dev/null \
  | tr -d '\r' | grep -i '^content-disposition' | head -1 || true)"
LOC_RAW="$(curl -sS -o /dev/null -D - --max-time 15 "$KV_BASE/dl/cc-deck-snap-latest.apk" 2>/dev/null \
  | tr -d '\r' | grep -i '^location' | head -1 || true)"
SNAP_EXE="$(disp_ver_of "$DISP_RAW")"
SNAP_APK="$(loc_ver_of "$LOC_RAW")"
if [ -z "$GIT_SNAP" ]; then
  bad "git 无合法 v*-snap.* tag（仓库状态异常？）"
  SNAP_SUMMARY="无tag"
else
  for spec in "exe指针:${SNAP_EXE}" "apk指针:${SNAP_APK}"; do
    face="${spec%%:*}"; ver="${spec#*:}"
    if [ -z "$ver" ]; then
      # exe 无 disposition=KV 对象缺席（302 ECS 兜底）；apk 提不出=302 都没拿到（网络/路由）
      bad "快照${face}版本提取失败（KV 对象/指针缺失，worker 已回落兜底）——行动：scripts/update-snap-dist.sh v$GIT_SNAP"
    elif [ "$ver" = "snap-latest" ]; then
      bad "快照${face}仍指旧稳定名（snap-latest-version 指针缺失，302 回落）——行动：scripts/update-snap-dist.sh v$GIT_SNAP"
    elif ! shape_of "$ver"; then
      bad "快照${face}版本形状非法：${ver}——行动：scripts/update-snap-dist.sh v$GIT_SNAP"
    elif [ "$(ver_cmp "$ver" "$GIT_SNAP")" != "0" ]; then
      bad "快照${face}漂移：指向 ${ver}，最新 snapshot tag ${GIT_SNAP}——行动：scripts/update-snap-dist.sh v$GIT_SNAP"
    else
      say "✅ 快照${face} = 最新 snapshot tag（${ver}）"
    fi
  done
  SNAP_SUMMARY="${SNAP_EXE:-缺}/${SNAP_APK:-缺}→${GIT_SNAP}"
fi

# ---------- 汇总 / patrol-report / notify ----------
report_line "supply: test-kv=${TEST_SUMMARY} snap=${SNAP_SUMMARY}${ALERTS:+ ALERT $ALERTS}"
if [ "$FAIL" = "1" ]; then
  say "——发版链供给异常（见上 ❌ 行动出口），处置后重跑本脚本"
  notify_alerts
  exit 1
fi
say "✅ 发版链供给正常（test 桌面清单 + 快照双指针均同步）"
