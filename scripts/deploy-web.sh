#!/usr/bin/env bash
# web-console 单源同步（#237 W-DEPLOYSSOT，2026-10-23 用户拍板「入」=调研方案③+②组合）：
# 一条命令把唯一编辑点 web-console/ 刷到全部部署面，并逐面机器验证锚收尾——
# 任何一步失败响亮报错非零退出（禁静默半截，第一纪律基建本体）。
#
# 六面一源版图（调研 ~/.cc-deck/artifacts/w-wcssot.md §0.1，本脚本管 ②③④⑤ 四面）：
#   源  web-console/  唯一编辑点（人写 feature 批）
#   ⑤ cc-plugins/plugins/cc-deck/web-console/  插件分发链副本——S1 单口刷新，
#      纯构建产物禁手工编辑（双写口是三次同族漂移的根因）
#   ② /Applications/CC Deck Nova.app/Contents/Resources/web-console/  桌面壳网页 UI
#   ③ ~/.cc-deck/relay-service/  relay 部署位（launchd 已退役/CCR_WEB_ROOT 形态，
#      按拍板保留在同步清单）
#   ④ CF Worker 资产（cc.humumu.online 云端网页版，[assets] directory=../web-console）
#   ① tauri 编译内嵌 ⑥ CI 安装包：打包时自根源取（desktop.yml），不归本脚本管
#
# 用法：scripts/deploy-web.sh [--skip-app] [--skip-cf] [--force]
#   --skip-app  跳过面②（Nova 未装机/CI 场景）
#   --skip-cf   跳过面④（不出外网；出包链 release-test.sh 默认带此开关，CF 显式放开）
#   --force     跳过「git 工作区干净」前置（应急；正常流程别用）
#
# 陷阱备忘：
#   · CF 部署代理必须小写 https_proxy——wrangler/undici 只读小写，大写 HTTPS_PROXY
#     不通（2026-10-23 三跑实证）；wrangler 用本机 npx 缓存固定 bin，免网络解析。
#   · 文件同步 ≠ 进程换新：面②③同步后必须重启对应进程运行面才换新（10-11 P0 的
#     另一半），脚本收尾会再提醒。
#   · 对照口径：版本烙印 CONSOLE_VERSION 四面全等 VERSION + js/session-domain.js
#     （最高频改动哨兵文件）sha256 全等；CF 面走线上 curl 对比。
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_APP=0 SKIP_CF=0 FORCE=0
for a in "$@"; do case "$a" in
  --skip-app) SKIP_APP=1 ;;
  --skip-cf)  SKIP_CF=1 ;;
  --force)    FORCE=1 ;;
  *) echo "❌ 未知参数: ${a}（支持 --skip-app --skip-cf --force）"; exit 1 ;;
esac; done

VER="$(cat VERSION)"
SRC=web-console
COPY=cc-plugins/plugins/cc-deck/web-console
COPY_BUNDLE=cc-plugins/plugins/cc-deck/scripts
NOVA_WC='/Applications/CC Deck Nova.app/Contents/Resources/web-console'
RS_DIR="$HOME/.cc-deck/relay-service"
WRANGLER_BIN="$HOME/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
CF_URL="https://cc.humumu.online"
PROXY="http://127.0.0.1:7890"
FAIL=0
ok()  { echo "✅ $*"; }
bad() { echo "❌ $*"; FAIL=1; }
H()   { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || echo MISSING; }
# rsync 全量镜像排除项：preview/（A/B 对比临时物，gitignored 两处）、site/（营销站，
# 只随 S4 CF 整目录上传，不属于插件/app/relay 面）、.wrangler/（CF 本地缓存）、.DS_Store。
# 注意别加 --delete-excluded：排除项在接收端要受保护，不是要删
RSYNC_EX=(--exclude 'preview/' --exclude 'site/' --exclude '.wrangler/' --exclude '.DS_Store')

# ---------- 前置闸：git 干净 + 版本落点一致 ----------
# 起点不干净，跑完后「哪些 diff 属于本次刷新」就说不清（S1 会改 cc-plugins 产物）
if [ "$FORCE" != "1" ] && [ -n "$(git status --porcelain)" ]; then
  echo "❌ git 工作区有未提交改动——先收口再同步（应急可用 --force）："
  git status --short | head -8
  exit 1
fi
if ! node scripts/version.mjs --check >/dev/null 2>&1; then
  echo "❌ 版本号落点与 VERSION 不一致：node scripts/version.mjs --write 修正后再来"
  node scripts/version.mjs --check
  exit 1
fi
echo "== deploy-web 单源同步 ==（版本 ${VER}，$(git branch --show-current) 线）"

# ---------- S1 刷新产物单口 ----------
echo "—— S1 build-plugin.mjs（cc-plugins 副本+bundle 唯一合法写口）——"
node relay/scripts/build-plugin.mjs >/tmp/deploy-web-s1.log 2>&1 \
  || { echo "❌ build-plugin 失败："; tail -15 /tmp/deploy-web-s1.log; exit 1; }
tail -1 /tmp/deploy-web-s1.log
ok "S1 产物刷新完成（$COPY + bundle）"

# ---------- S2 Nova App 面 ----------
if [ "$SKIP_APP" != "1" ]; then
  echo "—— S2 Nova App 面（${NOVA_WC}）——"
  if [ ! -d "$(dirname "$NOVA_WC")" ]; then
    echo "❌ Nova App 未安装（$NOVA_WC 不存在）——确认装位，或加 --skip-app"
    exit 1
  fi
  # 面 rsync 前预剪除排除项（macOS 自带 rsync 2.6.9 实证：--checksum 与 --delete+
  # --exclude 同用会整体破坏排除语义并错基 stat 报 IO error；且 --delete 对接收端
  # 既有排除目录只保护不清——规格「除 preview/site」= 面上不该有，先剪后同步）
  rm -rf "$NOVA_WC/preview" "$NOVA_WC/site" "$NOVA_WC/.wrangler"
  rsync -a --delete "${RSYNC_EX[@]}" "$SRC/" "$NOVA_WC/"
  ok "面② rsync 完成（重启 Nova 进程后运行面才换新）"
else
  echo "⏭️  S2 跳过（--skip-app）"
fi

# ---------- S3 relay-service 面（全量镜像：web-console + mobile + relay.mjs + 运行闭包） ----------
echo "—— S3 relay-service 面（${RS_DIR}）——"
mkdir -p "$RS_DIR"
rm -rf "$RS_DIR/web-console/preview" "$RS_DIR/web-console/site" "$RS_DIR/web-console/.wrangler"
rsync -a --delete "${RSYNC_EX[@]}" "$SRC/" "$RS_DIR/web-console/"
rsync -a --delete --exclude '.DS_Store' mobile/ "$RS_DIR/mobile/"
cp "$COPY_BUNDLE/relay.mjs" "$RS_DIR/relay.mjs"
# relay.mjs 运行闭包（better-sqlite3 三件，见 build-plugin.mjs 2b 节）：与 bundle 同源
# 全量镜像，relay-service 是自足部署位。原生件仅当前平台（darwin）——跨平台部署走 CI
rsync -a --delete "$COPY_BUNDLE/node_modules/" "$RS_DIR/node_modules/"
rsync -a --delete --exclude '.DS_Store' "$COPY_BUNDLE/../bin/" "$RS_DIR/bin/"
ok "面③ 镜像完成（重启对应 relay 进程后运行面才换新）"

# ---------- S4 CF 资产面 ----------
if [ "$SKIP_CF" != "1" ]; then
  echo "—— S4 CF 资产面（cloudflare/ wrangler deploy）——"
  if [ -x "$WRANGLER_BIN" ]; then
    WR="\"$WRANGLER_BIN\""
  else
    echo "⚠️  固定 wrangler bin 不在（${WRANGLER_BIN}，npx 缓存被清？）——回落 npx 现解析（需网络）"
    WR="npx --yes wrangler"
  fi
  # 代理大小写都设：undici 只读小写（大写单独设不通），别处工具读大写不吃亏
  ( cd cloudflare && eval "https_proxy=\"$PROXY\" HTTPS_PROXY=\"$PROXY\" $WR deploy" ) \
    || { echo "❌ wrangler deploy 失败（检查 Clash 7890 在线/CF 登录态）"; exit 1; }
  ok "面④ CF 部署完成"
else
  echo "⏭️  S4 跳过（--skip-cf）"
fi

# ---------- V1 逐面机器验证锚 ----------
echo "—— V1 逐面验证锚 ——"
# V1-a 版本烙印：CONSOLE_VERSION 与 VERSION 全等（源 + 已同步各面双壳）。
# 落点分壳（W-SPLIT-S4b 后，version.mjs 是口径权威）：旧壳=index.html 内联；
# 005 新壳=js/settings-domain.js 外置 const。cv_* 内嵌 || true 防 pipefail 杀——
# 无匹配（文件缺失/格式漂移）必须走 MISSING 报红而不是 set -e 静默死（005 实测：
# index-005.html 根本没有版本串，裸 grep exit 1 经 pipefail 让赋值非零炸脚本）
cv_html() { # 旧壳内联格式
  local m; m="$(grep -m1 -o 'CONSOLE_VERSION = "[^"]*"' "$1" 2>/dev/null || true)"
  if [ -n "$m" ]; then printf '%s\n' "$m" | cut -d'"' -f2; else echo MISSING; fi
}
cv_js() { # 005 新壳外置格式
  local m; m="$(grep -m1 -o 'const CONSOLE_VERSION = "[^"]*"' "$1" 2>/dev/null || true)"
  if [ -n "$m" ]; then printf '%s\n' "$m" | cut -d'"' -f2; else echo MISSING; fi
}
check_ver() { # $1=面名 $2=取到的值 $3=文件路径（报红定位用）
  if [ "$2" = "$VER" ]; then ok "V1-a $1 版本烙印 = $VER"
  else bad "V1-a $1 版本烙印 '$2' ≠ VERSION '$VER'（$3）"; fi
}
check_ver "源"             "$(cv_html "$SRC/index.html")"                   "$SRC/index.html"
check_ver "源(005)"        "$(cv_js "$SRC/js/settings-domain.js")"          "$SRC/js/settings-domain.js"
check_ver "cc-plugins 副本" "$(cv_html "$COPY/index.html")"                  "$COPY/index.html"
check_ver "副本(005)"      "$(cv_js "$COPY/js/settings-domain.js")"         "$COPY/js/settings-domain.js"
[ "$SKIP_APP" != "1" ] && check_ver "Nova 面"    "$(cv_html "$NOVA_WC/index.html")"          "$NOVA_WC/index.html" && check_ver "Nova 面(005)" "$(cv_js "$NOVA_WC/js/settings-domain.js")" "$NOVA_WC/js/settings-domain.js"
check_ver "relay-service 面"      "$(cv_html "$RS_DIR/web-console/index.html")"          "$RS_DIR/web-console/index.html"
check_ver "relay-service 面(005)" "$(cv_js "$RS_DIR/web-console/js/settings-domain.js")"  "$RS_DIR/web-console/js/settings-domain.js"

# V1-b/V1-c 全量 byte 闸：git ls-files 动态清单（防新增文件漏锁）逐文件 sha256，
# 源 vs cc-plugins 副本 + 各已同步面。site/（只随 CF 整目录上传）与 wrangler.jsonc
# （旧杂件待 Leader 清）不进副本/部署面对照口径，与 build-plugin.mjs 拷贝清单一致
WC_LIST=$(git ls-files "$SRC" | grep -v '^web-console/site/' | grep -v '^web-console/wrangler\.jsonc$' | sed 's|^web-console/||')
if [ -z "$WC_LIST" ]; then echo "❌ git ls-files web-console 为空（仓库异常？）"; exit 1; fi
DRIFT=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  s="$(H "$SRC/$f")"
  if [ "$s" = "MISSING" ]; then bad "V1-c 源文件缺失: $SRC/$f"; continue; fi
  # 源 vs cc-plugins 副本（build-plugin 拷贝清单漂移在此现形）
  d="$(H "$COPY/$f")"
  if [ "$d" != "$s" ]; then
    bad "V1-c cc-plugins 副本漂移: ${f}（build-plugin.mjs 拷贝清单需核对/重跑 S1）"; DRIFT=1
  fi
  if [ "$SKIP_APP" != "1" ]; then
    d="$(H "$NOVA_WC/$f")"
    [ "$d" != "$s" ] && { bad "V1-c Nova 面漂移: $f"; DRIFT=1; }
  fi
  d="$(H "$RS_DIR/web-console/$f")"
  [ "$d" != "$s" ] && { bad "V1-c relay-service 面漂移: $f"; DRIFT=1; }
done <<< "$WC_LIST"
[ "$DRIFT" = "0" ] && ok "V1-c 全量清单 hash：源=副本=$( [ "$SKIP_APP" != "1" ] && echo '=Nova面' )=relay-service面（$(echo "$WC_LIST" | wc -l | tr -d ' ') 件全等）"

# 副本陈旧件检测（源已无、副本还有 = 手工件/上一代产物残留；preview/ 为 gitignored A/B 物不查）
EXTRA=$(find "$COPY" -type f -not -path '*/preview/*' -not -path '*/.wrangler/*' -not -name '.DS_Store' \
        | sed "s|^$COPY/||" | sort)
STALE=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in site/*|wrangler.jsonc) continue ;; esac
  grep -qxF "$f" <<< "$WC_LIST" || { bad "V1-c 副本陈旧件（源已无）: $f"; STALE=1; }
done <<< "$EXTRA"
[ "$STALE" = "0" ] && ok "V1-c 副本无陈旧件"

# V1-d CF 面线上锚：js/session-domain.js sha256 与根源全等（js/ 不在 run_worker_first，
# 直接出 assets；CONSOLE_VERSION 线上不可靠 grep——/ 走 Worker 先行，故只用此锚）。
# 落临时文件再 hash：管道/命令替换会动尾部换行，字节级对比必须对文件本体
if [ "$SKIP_CF" != "1" ]; then
  CF_TMP=/tmp/deploy-web-cf-session-domain.js
  if https_proxy="$PROXY" HTTPS_PROXY="$PROXY" curl -fsS --max-time 30 -o "$CF_TMP" "$CF_URL/js/session-domain.js"; then
    if [ "$(H "$CF_TMP")" = "$(H "$SRC/js/session-domain.js")" ]; then
      ok "V1-d CF 线上 session-domain.js = 源（$(H "$CF_TMP")）"
    else
      bad "V1-d CF 线上 session-domain.js ≠ 源（线上 $(H "$CF_TMP") vs 源 $(H "$SRC/js/session-domain.js")）"
    fi
  else
    bad "V1-d CF 线上拉取失败（检查 Clash $PROXY 在线/线上可用）"
  fi
fi

# ---------- V2 后置闸 + 进程换新提醒 ----------
echo "—— V2 后置闸（check-deploy-complete.sh）——"
bash scripts/check-deploy-complete.sh || {
  echo "—— deploy-web 验证锚有红（V2 部署完整性未过），禁止当作同步完成——修完重跑"
  exit 1
}

if [ "$FAIL" = "1" ]; then
  echo "—— deploy-web 验证锚有红，禁止当作同步完成——修完重跑"
  exit 1
fi
echo ""
echo "✅ deploy-web 完成：版本 $VER 已刷至 $( [ "$SKIP_APP" = 1 ] && echo '副本+relay-service' || echo '副本+Nova+relay-service' )$( [ "$SKIP_CF" = 1 ] || echo '+CF' ) 面，逐面锚全绿"
echo "⚠️  文件同步≠进程换新：面②须重启 CC Deck Nova 进程；面③须重启对应 relay 进程，运行面才换新"
echo "出包前另跑 check-bundle-sync.sh（发版闸：bundle 重建对比+冒烟+版本闸，与本脚本互补不互代）"
