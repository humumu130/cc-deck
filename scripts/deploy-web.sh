#!/usr/bin/env bash
# deploy-web.sh —— web-console 单源同步单命令（#237 W-DEPLOYSSOT4，调研 w-wcssot.md §二规格落地）
# ============================================================
# 单源版图（六面一源，调研 §0.1）：唯一编辑点=web-console/（仓根）；本脚本把构建产物
# 与部署面一次刷齐，消灭「手工 cp 两个竞争写口」（三起同族事故根因：闸只锁 2 html、
# 写口双轨、闸只在出包跑）。
#   S1 build-plugin 单口刷新（cc-plugins 副本=纯构建产物，禁手工编辑——唯一合法写法）
#   S2 Nova App 面 rsync（/Applications/CC Deck Nova.app/Contents/Resources/web-console/）
#   S3 relay-service 面 rsync（~/.cc-deck/relay-service/web-console/）
#   S4 CF 资产面（cloudflare/wrangler.toml [assets] → cc.humumu.online）
#   V1 逐面机器验证锚（CONSOLE_VERSION 四面全等 VERSION + js/session-domain.js sha256
#      根源 vs 各面全等；CF 面 curl 线上对比）
#   V2 收尾 check-deploy-complete.sh + 「文件同步≠进程换新」提示
# 用法：
#   scripts/deploy-web.sh [--skip-cf] [--skip-app] [--force]
#     --skip-cf   跳过 S4（不部署线上资产——出包链默认带，CF 单独时点再跑）
#     --skip-app  跳过 S2（不碰 /Applications 里的 Nova——CI/远端场景）
#     --force     跳过 git 前置检查（默认要求 web-console/ 源目录无未提交改动：
#                 源脏=同步源头不确定；cc-plugins 残缺副本不算——那是待刷产物）
# 环境陷阱（三跑实证，2026-10-23）：
#   · CF 代理必须**小写** https_proxy——wrangler/undici 只读小写，大写 HTTPS_PROXY 不通
#   · wrangler 固定用 npx 缓存 bin（~/.npm/_npx/32026684e21afda6/...）——免网络解析
#   · S2/S3 改的是磁盘文件，**运行面要进程重启才换新**（V2 提示，10-11 P0 的另一半）
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_CF=0; SKIP_APP=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --skip-cf) SKIP_CF=1 ;;
    --skip-app) SKIP_APP=1 ;;
    --force) FORCE=1 ;;
    *) echo "ERR: 未知参数 ${a}（支持 --skip-cf/--skip-app/--force）"; exit 1 ;;
  esac
done

SRC="web-console"
CCPLUG="cc-plugins/plugins/cc-deck/web-console"
NOVA_WC="/Applications/CC Deck Nova.app/Contents/Resources/web-console"
RSVC="$HOME/.cc-deck/relay-service/web-console"
CF_BIN="$HOME/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || echo "MISSING"; }
FAIL=0
say() { echo "$@"; }
bad() { echo "❌ $*"; FAIL=1; }
skip() { echo "⏭️  $*"; }

# ---------- 前置 ----------
if [ "$FORCE" != "1" ]; then
  DIRTY=$(git status --porcelain -- "$SRC" 2>/dev/null || true)
  [ -z "$DIRTY" ] || bad "web-console/ 源目录有未提交改动（同步源头不确定）：
$DIRTY
  ——先收口源目录再同步，或 --force 明示跳过"
fi
if [ -f scripts/version.mjs ] && ! node scripts/version.mjs --check >/dev/null 2>&1; then
  bad "版本号落点与 VERSION 不一致（node scripts/version.mjs --check 详细）——先 --write 修正"
fi
VER=$(cat VERSION 2>/dev/null || echo "")
[ -n "$VER" ] || bad "VERSION 文件缺失"
[ "$FAIL" = "0" ] || { echo "——前置未过，终止（未做任何同步动作）"; exit 1; }
say "== deploy-web：源=$SRC 版本=${VER}（skip-cf=$SKIP_CF skip-app=${SKIP_APP}）=="

# ---------- S1 构建产物单口刷新 ----------
say "[S1] build-plugin 单口刷新（cc-plugins 副本+bundle；副本=纯构建产物，禁手工编辑）"
node relay/scripts/build-plugin.mjs > /tmp/deploy-web-s1.log 2>&1 || { bad "build-plugin.mjs 失败："; tail -5 /tmp/deploy-web-s1.log; exit 1; }
tail -1 /tmp/deploy-web-s1.log

# ---------- S2 Nova App 面 ----------
if [ "$SKIP_APP" = "1" ]; then
  skip "S2 Nova App 面（--skip-app）"
elif [ ! -d "$(dirname "$NOVA_WC")" ]; then
  skip "S2 Nova App 未安装（$(dirname "$NOVA_WC") 不存在）"
else
  say "[S2] Nova App 面 rsync → $NOVA_WC"
  rsync -a --delete --exclude 'preview/' --exclude 'site/' "$SRC/" "$NOVA_WC/"
fi

# ---------- S3 relay-service 面 ----------
say "[S3] relay-service 面 rsync → $RSVC"
mkdir -p "$RSVC"
rsync -a --delete --exclude 'preview/' --exclude 'site/' "$SRC/" "$RSVC/"

# ---------- S4 CF 资产面 ----------
if [ "$SKIP_CF" = "1" ]; then
  skip "S4 CF 资产面（--skip-cf；线上资产保持原状）"
else
  say "[S4] CF 资产面 deploy（cc.humumu.online）"
  [ -x "$CF_BIN" ] || { bad "wrangler bin 不存在：${CF_BIN}（npx 缓存被清？先手动 npx wrangler deploy 一次重建缓存）"; }
  if [ "$FAIL" = "0" ]; then
    ( cd cloudflare && https_proxy=http://127.0.0.1:7890 "$CF_BIN" deploy ) || bad "wrangler deploy 失败（代理小写 https_proxy=127.0.0.1:7890 必需；CF 侧错误见上）"
  fi
fi

# ---------- V1 逐面机器验证锚 ----------
say "== V1 逐面验证锚 =="
ver_of() { grep -o 'CONSOLE_VERSION = "[^"]*"' "$1" 2>/dev/null | head -1 | cut -d'"' -f2; }
check_ver() { # $1=实测版本 $2=面:文件名——不等即 bad（计数不退出，逐面报完统一结算）
  local got="$1"
  [ "$got" = "$VER" ] || bad "CONSOLE_VERSION 锚 [$2] = ${got:-缺失} ≠ VERSION $VER"
}
# a) CONSOLE_VERSION：版本串双载体（index.html 主壳 + js/settings-domain.js 005 壳，
#    W-SPLIT-S4b 外置——index-005.html 本体无版本串）× 四面。任一面任一载体漂移即红
for f in index.html js/settings-domain.js; do
  check_ver "$(ver_of "$SRC/$f")" "根源 $f"
  check_ver "$(ver_of "$CCPLUG/$f")" "cc-plugins $f"
  check_ver "$(ver_of "$RSVC/$f")" "relay-service $f"
  if [ "$SKIP_APP" != "1" ] && [ -d "$(dirname "$NOVA_WC")" ]; then
    check_ver "$(ver_of "$NOVA_WC/$f")" "Nova App $f"
  fi
  if [ "$SKIP_CF" != "1" ]; then
    V_CF=$(curl -sS --max-time 20 "https://cc.humumu.online/$f" 2>/dev/null | grep -o 'CONSOLE_VERSION = "[^"]*"' | head -1 | cut -d'"' -f2)
    check_ver "$V_CF" "CF 线上 $f"
  fi
done
[ "$SKIP_APP" = "1" ] && skip "V1 CONSOLE_VERSION：Nova App 面（skip/未装）"
[ "$SKIP_CF" = "1" ] && skip "V1 CONSOLE_VERSION：CF 线上（--skip-cf）"
# b) js/session-domain.js sha256：根源 vs 各面全等（最高频改动文件=漂移金丝雀）
K_SRC=$(sha "$SRC/js/session-domain.js")
[ "$K_SRC" = "MISSING" ] && bad "根源 js/session-domain.js 缺失"
cmp_key() { # $1=面名 $2=文件路径
  local k="$2"
  [ "$k" = "MISSING" ] && { bad "sha256 锚 [$1] 文件缺失"; return; }
  [ "$k" = "$K_SRC" ] || bad "sha256 锚 [$1] ≠ 根源（$k vs ${K_SRC:0:12}…）"
}
cmp_key "cc-plugins 副本" "$(sha "$CCPLUG/js/session-domain.js")"
cmp_key "relay-service 面" "$(sha "$RSVC/js/session-domain.js")"
if [ "$SKIP_APP" != "1" ] && [ -d "$(dirname "$NOVA_WC")" ]; then
  cmp_key "Nova App 面" "$(sha "$NOVA_WC/js/session-domain.js")"
else
  skip "V1 sha256：Nova App 面（skip/未装）"
fi
if [ "$SKIP_CF" != "1" ]; then
  K_CF=$(curl -sS --max-time 20 https://cc.humumu.online/js/session-domain.js 2>/dev/null | shasum -a 256 | awk '{print $1}')
  cmp_key "CF 线上" "$K_CF"
else
  skip "V1 sha256：CF 线上（--skip-cf）"
fi

# ---------- V2 收尾 ----------
if [ "$FAIL" = "0" ]; then
  say "== V2 部署完整性后置闸 =="
  bash scripts/check-deploy-complete.sh || FAIL=1
fi

if [ "$FAIL" = "1" ]; then
  echo "—— deploy-web 有失败项（上方 ❌），逐项处置后重跑"
  exit 1
fi
say "✅ deploy-web 全绿：S1-S4 同步完成 + V1 锚全等（版本=${VER}）"
say "⚠️  文件同步 ≠ 进程换新：S2 需重启 Nova 进程、S3 需重启对应 relay 进程，运行面才换新（10-11 P0 的另一半）"
[ "$SKIP_CF" = "1" ] && say "ℹ️  CF 线上资产未动（--skip-cf）——上线时点单独跑不带该开关"
exit 0
