#!/usr/bin/env bash
# W-DEPLOYGATE 表测：ver_cmp 方向比较 + face_ver_check 集成三态（跑法：bash scripts/test-deploygate.sh）
# 函数抽取自 deploy-web.sh 正本（锚定 ver_shape_ok..face_ver_check 五函数区）——源改测试随动
# W-DEPLOYFIX #253：本套件须在 /bin/bash（macOS 3.2）语义下绿，禁止依赖 bash≥4 行为——
# 脚本内禁止 `$name<多字节>` 邻接（bash 3.2 UTF-8 locale 会把多字节首字节吸进变量名，
# set -u 下 unbound 炸死；需邻接一律 `${name}字`，正本 deploy-web.sh 同规）
set -uo pipefail
DG="$(cd "$(dirname "$0")/.." && pwd)"
awk '/^ver_shape_ok\(\)|^ver_core_cmp\(\)|^ver_pre_cmp\(\)|^ver_cmp\(\)|^face_ver_check\(\)|^cv_html\(\)/{p=1} p{print} p&&/^}/{p=0}' "$DG/scripts/deploy-web.sh" > /tmp/dg-funcs.$$.sh
FUNCS=/tmp/dg-funcs.$$.sh; trap 'rm -f "$FUNCS" /tmp/dg-face.$$.html /tmp/dg-out.$$.txt' EXIT
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok $1"; else fail=$((fail+1)); echo "  FAIL $1（want=$3 got=$2）"; fi; }
source "$FUNCS"
ok "相等 0.7.0-test.66"                  "$(ver_cmp 0.7.0-test.66 0.7.0-test.66)" 0
ok "陈旧 0.7.0-test.50 < .66"            "$(ver_cmp 0.7.0-test.50 0.7.0-test.66)" -1
ok "真超前 .67 > .66"                    "$(ver_cmp 0.7.0-test.67 0.7.0-test.66)" 1
ok "release > pre（0.7.0>0.7.0-test.66）" "$(ver_cmp 0.7.0 0.7.0-test.66)" 1
ok "跨大版本 0.6.3 < 0.7.0"              "$(ver_cmp 0.6.3 0.7.0)" -1
ok "跨大版本超前 0.8.0 > 0.7.0-test.66"  "$(ver_cmp 0.8.0 0.7.0-test.66)" 1
ok "test.9 < test.10（数值非字典序）"     "$(ver_cmp 0.7.0-test.9 0.7.0-test.10)" -1
ok "pre 字母序 alpha<beta"               "$(ver_cmp 0.7.0-alpha 0.7.0-beta)" -1
ok "前缀小 test.66 < test.66.a"          "$(ver_cmp 0.7.0-test.66 0.7.0-test.66.a)" -1
ok "主版本段数值 0.10.0 > 0.9.0"         "$(ver_cmp 0.10.0 0.9.0)" 1
mkface(){ printf '<script>const CONSOLE_VERSION = "%s"</script>\n' "$1" > /tmp/dg-face.$$.html; }
gate_rc(){ local v="$1" f="${2:-0}"; ( source "$FUNCS"; VER="$v" FORCE="$f" face_ver_check "②" /tmp/dg-face.$$.html >/tmp/dg-out.$$.txt 2>&1 ); echo $?; }
mkface "0.7.0-test.66-nova";  ok "集成·nova 相等→放行"        "$(gate_rc 0.7.0-test.66)" 0
mkface "0.7.0-test.50";       ok "集成·陈旧面→放行"           "$(gate_rc 0.7.0-test.66)" 0
mkface "0.7.0-test.67";       ok "集成·真超前→拦截"           "$(gate_rc 0.7.0-test.66)" 1
grep -q "0.7.0-test.67 > 本地 VERSION(0.7.0-test.66)" /tmp/dg-out.$$.txt && ok "集成·拦截文案含面烙印与VERSION" 0 0 || ok "集成·拦截文案含面烙印与VERSION" 1 0
mkface "garbage!!";           ok "集成·非法串→fail-closed 拦" "$(gate_rc 0.7.0-test.66)" 1
mkface "garbage!!";           ok "集成·非法串+force→放行"      "$(gate_rc 0.7.0-test.66 1)" 0
# W-DEPLOYFIX #253：rc=0 之外锁警告行真执行——bash 3.2 UTF-8 locale 下 `$fv（` 邻接曾把
# --force 逃生口炸死（127），rc 碰巧 0 ≠ 警告行跑了；grep 断言防复发
grep -q -- "--force 越过面新鲜度闸" /tmp/dg-out.$$.txt && ok "集成·force 越闸警告行真执行（非碰巧 rc=0）" 0 0 || ok "集成·force 越闸警告行真执行（非碰巧 rc=0）" 1 0
mkface "0.7.0-test.99-nova";  ok "集成·nova 超前→拦截"        "$(gate_rc 0.7.0-test.66)" 1
printf 'no version here\n' > /tmp/dg-face.$$.html; ok "集成·MISSING→放行" "$(gate_rc 0.7.0-test.66)" 0
echo; echo "DEPLOYGATE 表测: $pass passed, $fail failed"; [ "$fail" = 0 ]
