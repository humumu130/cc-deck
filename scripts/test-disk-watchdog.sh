#!/usr/bin/env bash
# DL-P2-3 disk-watchdog 回归（DEV-22 批 B）——四段：
#   Z0 语法闸 + usage 行含 prefetch
#   P1 prefetch 子命令：真 glob 命中可数（report 零删除）+ 沙盒假目录被 clean 路径真删
#   W1 WARN 消费账（hermetic 副本：stub curl/osascript + 沙盒 HOME）：首越线起算、
#     节流 1h 内不重发、持续 ≥6h 升级直发、水位回落清账
#   G1 白名单含 prefetch glob（ACT 路径覆盖泄漏根因）
# 直跑：bash scripts/test-disk-watchdog.sh（真生产零触碰——报告只读 du；clean 仅删
#   自建测试目录；WARN 逻辑跑 hermetic 副本，curl/osascript 全 stub）
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
DW=scripts/disk-watchdog.sh

echo "Z0 语法闸："
bash -n $DW && ok "Z0-1 bash -n 过" || bad "Z0-1 语法错"
grep -q "prefetch \[report|clean\]" $DW && ok "Z0-2 usage 行含 prefetch" || bad "Z0-2 usage 缺 prefetch"

echo "G1 白名单锚："
grep -q '"/private/var/folders/\*/\*/T/cbc-update-prefetch-\*"' $DW && ok "G1-1 CLEAN_GLOBS 含 prefetch 泄漏 glob" || bad "G1-1 白名单缺 prefetch"

echo "P1 prefetch 子命令（真机只读盘点 + 定向 clean）："
RPT="$(bash $DW prefetch report 2>&1)"
echo "$RPT" | grep -q "^total: " && ok "P1-1 report 出 total 行（$(echo "$RPT" | tail -1)）" || bad "P1-1 report 无 total"
# 定向 clean 证据：在本用户真实 T 根（泄漏目录的规范层级——TMPDIR 可能嵌套更深，取其 T 根）
# 造一个撞 glob 的假目录（仅此目录属本测试），clean 后应消失
# T 根甄别（备案池 P3-3，2026-11-28）：CLEAN_GLOBS 只认 /private/var/folders/*/*/T/ 层级，
# 沙盒假 TMPDIR（Multica 11/2 实锤）不撞 glob → P1-2/P1-3 假红。非规范时 Darwin 强指
# getconf DARWIN_USER_TEMP_DIR（真机 T 根）；仍不撞 glob 则 SKIP 该两项（非 FAIL——
# glob 层级在真机必在，缺的只是本环境的可达性）
TROOT="$(printf '%s' "${TMPDIR:-/private/tmp/}" | sed 's#\(/T/\).*#\1#')"
case "$TROOT" in
  /private/var/folders/*/*/T/|/var/folders/*/*/T/) ;;
  *) if [ "$(uname -s)" = "Darwin" ]; then
       GT="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"
       [ -n "$GT" ] && TROOT="${GT%/}/"
     fi ;;
esac
case "$TROOT" in
  /private/var/folders/*/*/T/|/var/folders/*/*/T/)
    FAKE="${TROOT}cbc-update-prefetch-dev22-selftest"
    mkdir -p "$FAKE" && echo probe > "$FAKE/f"
    FAKE_HIT="$(bash $DW prefetch report 2>/dev/null | grep -c "$FAKE")"
    [ "$FAKE_HIT" -ge 1 ] && ok "P1-2 假目录被 glob 命中（可见即可清）" || bad "P1-2 glob 未命中假目录（$FAKE）"
    bash $DW prefetch >/dev/null 2>&1
    [ ! -e "$FAKE" ] && ok "P1-3 clean 路径真删（泄漏目录形态对证）" || { bad "P1-3 clean 未删假目录"; rm -rf "$FAKE"; }
    ;;
  *) echo "  skip P1-2/P1-3（TMPDIR 非规范且无 getconf 源：$TROOT——备案池 P3-3）" ;;
esac

echo "W1 WARN 消费账（hermetic 副本）："
SBX="$(mktemp -d)"
mkdir -p "$SBX/bin" "$SBX/home"
# stub curl（拒绝一切 → notify 回落）/ stub osascript（记录调用=外发证据）
cat > "$SBX/bin/curl" <<'EOF'
#!/bin/sh
exit 7
EOF
cat > "$SBX/bin/osascript" <<'EOF'
#!/bin/sh
echo "osascript: $*" >> "${NOTIFY_LEDGER:-/dev/null}"
exit 0
EOF
chmod +x "$SBX/bin/curl" "$SBX/bin/osascript"
# hermetic 副本：水位钉 90（假 df——杜绝真机 ACT 分支动手）/ WARN_PCT 压 1（必越线）/
# ACT_PCT 抬 99（双保险）/ curl 分支废掉（防真 relay 外发）；osascript 走 PATH stub 记账
sed -e 's/^WARN_PCT=85/WARN_PCT=1/' -e 's/^ACT_PCT=90/ACT_PCT=99/' \
    -e 's|^  df -k "$VOLUME".*|  echo 90; # pinned pct (hermetic)|' \
    -e 's|command -v curl >/dev/null 2>&1|command -v nosuchcurl >/dev/null 2>\&1|' $DW > "$SBX/dw.sh"
bash -n "$SBX/dw.sh" || { bad "W1-0 hermetic 副本语法不过（sed 补丁破坏）"; }
STUBBED_NOTIFY=$(grep -c "nosuchcurl" "$SBX/dw.sh")
PINNED=$(grep -c "pinned pct" "$SBX/dw.sh")
[ "$STUBBED_NOTIFY" -ge 1 ] && [ "$PINNED" -ge 1 ] && ok "W1-0 hermetic 双保险在位（curl 废+水位钉）" || bad "W1-0 hermetic 补丁未命中（中止后续防真外发/真动手）"
if [ "$STUBBED_NOTIFY" -ge 1 ]; then
  export PATH="$SBX/bin:$PATH" HOME="$SBX/home" NOTIFY_LEDGER="$SBX/notified.log"
  bash "$SBX/dw.sh" check >/dev/null 2>&1
  ST="$SBX/home/.cc-deck/data/disk-watchdog.state"
  [ -n "$(sed -n 's/^warn_since=//p' "$ST" 2>/dev/null)" ] && ok "W1-1 首越线起算 warn_since" || bad "W1-1 无 warn_since"
  [ -z "$(sed -n 's/^warn_escalated=//p' "$ST" 2>/dev/null)" ] && ok "W1-2 首越线不升级（<6h）" || bad "W1-2 过早升级"
  N1="$(grep -c osascript "$SBX/notified.log" 2>/dev/null || echo 0)"
  # 1h 节流：立即重跑——不应新增外发（stub notify 计数走 notify-ledger? notify 已 stub 为 return，
  # 外发只剩升级口 osascript；节流断言改查 WARN 分支日志行数）
  L1="$(wc -l < "$SBX/home/.cc-deck/data/disk-watchdog.log" 2>/dev/null | tr -d ' ')"
  bash "$SBX/dw.sh" check >/dev/null 2>&1
  L2="$(wc -l < "$SBX/home/.cc-deck/data/disk-watchdog.log" 2>/dev/null | tr -d ' ')"
  [ "$L2" -le $((L1 + 1)) ] && ok "W1-3 节流在位（1h 内重跑零重复告警行，$L1→$L2）" || bad "W1-3 节流失效（$L1→$L2 刷屏）"
  # 持续 ≥6h：把 warn_since 改到 7h 前，重跑应走升级口（stub osascript 记账）
  OLD=$(( $(date +%s) - 25200 ))
  sed -i '' "s/^warn_since=.*/warn_since=$OLD/" "$ST"
  bash "$SBX/dw.sh" check >/dev/null 2>&1
  grep -q "disk-watchdog 持续告警" "$SBX/notified.log" 2>/dev/null && ok "W1-4 持续 ≥6h 直发通知中心（独立于 relay 通道）" || bad "W1-4 升级口未发"
  grep -q "ESCALATE:" "$SBX/home/.cc-deck/data/disk-watchdog.log" 2>/dev/null && ok "W1-5 升级留痕 ESCALATE 日志行" || bad "W1-5 无 ESCALATE 日志"
  # 回落清账：水位改钉 50 且 WARN_PCT 复原 85（不再越线），重跑应清 warn_since
  sed -e 's/echo 90; # pinned pct (hermetic)/echo 50; # pinned pct (hermetic)/' \
      -e 's/^WARN_PCT=1/WARN_PCT=85/' "$SBX/dw.sh" > "$SBX/dw2.sh"
  bash "$SBX/dw2.sh" check >/dev/null 2>&1
  [ -z "$(sed -n 's/^warn_since=//p' "$ST" 2>/dev/null)" ] && ok "W1-6 水位回落清消费账" || bad "W1-6 回落未清账"
fi
rm -rf "$SBX"

echo
echo "PASS: $pass passed, $fail failed"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
