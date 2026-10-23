#!/usr/bin/env bash
# 部署完整性闸（W-FLOW 环 4/环 8 硬闸，2026-10-11）
# ============================================================
# 背景（用户实锤 P0，2026-10-11）：桌面壳页面从 relay HTTP 加载=
# ~/.cc-deck/relay-service/web-console/，部署链只更 relay.mjs 漏了它——
# 用户看一整天 test.4-dev 旧界面，15 件修复「全没解决」实为幻象。
# check-bundle-sync.sh 的 S1/S2 补了 web-console 两件，但部署面还有盲区：
#   · relay.mjs 部署位本身无对比闸（B1/B2/B3 只锁 cc-plugins/tauri/已装 app）
#   · mobile/ PWA 面五件无守卫（当前碰巧同步，机制上裸奔）
#   · web-console/web-console/ 嵌套脏副本（误部署产物）无人发现
#   · 文件同步了但 relay 进程没重启 = 运行面仍旧界面（同案例另一半）
#
# 用法：scripts/check-deploy-complete.sh
#   CCR_DEPLOY_DIR 可覆盖部署位（默认 ~/.cc-deck/relay-service，沙盒测试用）
# 时点：每次部署动作之后必跑（worker 收尾 / Leader 出包前）；发版闸另跑
# check-bundle-sync.sh（产物↔仓库一致性），两闸互补不互代——CI 无部署位，
# 故本脚本独立不并入 bundle-sync（评估结论，详见 docs/operations/flow-hardening.md §5）。
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_DIR="${CCR_DEPLOY_DIR:-$HOME/.cc-deck/relay-service}"
H() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || echo "MISSING"; }
FAIL=0
say() { echo "$@"; }
bad() { echo "❌ $*"; FAIL=1; }

[ -d "$DEPLOY_DIR" ] || { echo "❌ 部署位不存在: ${DEPLOY_DIR}（relay-service 未部署？）"; exit 1; }

say "== 部署完整性检查 ==（部署位: $DEPLOY_DIR）"

# ---------- 1. relay.mjs 部署位 vs 构建产物 ----------
SRC_BUNDLE="cc-plugins/plugins/cc-deck/scripts/relay.mjs"
DEP_RELAY="$DEPLOY_DIR/relay.mjs"
if [ ! -f "$SRC_BUNDLE" ]; then
  bad "构建产物缺失: ${SRC_BUNDLE}（先跑 relay/scripts/build-plugin.mjs）"
elif [ "$(H "$SRC_BUNDLE")" != "$(H "$DEP_RELAY")" ]; then
  bad "relay.mjs 部署位 ≠ 构建产物（部署位过期/异源）"
  say "    同步: cp $SRC_BUNDLE $DEP_RELAY && 重启 relay 服务"
else
  say "✅ relay.mjs 部署位 = 构建产物"
fi

# ---------- 2. web-console 双壳（S1/S2 同口径，部署闸自含） ----------
for f in index.html index-005.html; do
  SRC="web-console/$f"
  DEP="$DEPLOY_DIR/web-console/$f"
  if [ "$(H "$SRC")" = "$(H "$DEP")" ]; then
    say "✅ web-console/$f 部署位 = 源"
  else
    bad "web-console/$f 部署位 ≠ 源（桌面壳/网页端看到旧界面的直接原因）"
    say "    同步: cp $SRC $DEPLOY_DIR/web-console/ && 重启 relay 服务"
  fi
done

# ---------- 3. mobile PWA 面（五件，此前零守卫） ----------
MOBILE_FILES="index.html manifest.webmanifest sw.js icon-192.png icon-512.png"
M_OK=1
for f in $MOBILE_FILES; do
  if [ "$(H "mobile/$f")" != "$(H "$DEPLOY_DIR/mobile/$f")" ]; then M_OK=0; break; fi
done
if [ "$M_OK" = "1" ]; then
  say "✅ mobile/ PWA 面（5 件）部署位 = 源"
else
  bad "mobile/ PWA 面漂移（手机浏览器/PWA 访问 relay 时看到旧版）"
  say "    同步: cp mobile/{index.html,manifest.webmanifest,sw.js,icon-192.png,icon-512.png} $DEPLOY_DIR/mobile/"
fi
# 插件 mobile 副本同口径（build-plugin.mjs 会拷，无守卫同理——有才查，无则提示）
PLUGIN_MOBILE="cc-plugins/plugins/cc-deck/mobile/index.html"
if [ -f "$PLUGIN_MOBILE" ] && [ "$(H "$PLUGIN_MOBILE")" != "$(H "mobile/index.html")" ]; then
  bad "插件 mobile 副本 ≠ mobile/index.html 源（重跑 build-plugin.mjs 刷新）"
fi

# ---------- 4. 部署面脏副本（误部署产物检测） ----------
if [ -d "$DEPLOY_DIR/web-console/web-console" ]; then
  bad "部署面脏副本: $DEPLOY_DIR/web-console/web-console/（嵌套目录，误 cp 产物）"
  say "    处置: 确认无引用后删除: rm -rf $DEPLOY_DIR/web-console/web-console"
fi
for f in "$DEPLOY_DIR"/relay.mjs.bak-* "$DEPLOY_DIR"/relay.mjs.old; do
  [ -e "$f" ] && say "ℹ️  部署位备份残留: ${f}（不拦，介意可清）"
done

# ---------- 5. 进程新鲜度（文件同步了但没重启 = 运行面仍旧代码） ----------
# 仅默认部署位检查：CCR_DEPLOY_DIR 覆盖（沙盒/测试位）与生产进程无关，检查必误报
if [ -f "$DEP_RELAY" ] && [ "$DEPLOY_DIR" = "$HOME/.cc-deck/relay-service" ]; then
  # ps+grep 而非 pgrep：pgrep 的进程枚举在部分沙盒环境下受限（2026-10-11 实测
  # 同机 ps 可见、pgrep 找不到），ps ax 全量列表两环境一致
  PID=$(ps ax -o pid=,command= 2>/dev/null | grep "relay-service/relay\.mjs" | grep -v grep | awk '{print $1}' | head -1 || true)
  if [ -n "$PID" ]; then
    FILE_MTIME=$(stat -f %m "$DEP_RELAY" 2>/dev/null || echo 0)
    # lstart → epoch（BSD ps 无 %m 等价，用 to_epoch 换算；Linux date -d 语法差异按 mac 主力机口径）
    PROC_START=$(ps -o lstart= -p "$PID" 2>/dev/null | xargs -I{} date -j -f "%a %b %d %H:%M:%S %Y" "{}" +%s 2>/dev/null || echo 0)
    if [ "$PROC_START" != "0" ] && [ "$FILE_MTIME" -gt "$PROC_START" ]; then
      bad "relay 进程(pid $PID)启动早于 relay.mjs 修改时间——文件已同步但进程还是旧代码，重启才生效"
      say "    重启: launchctl kickstart -k gui/\$(id -u)/online.humumu.ccdeck.relay"
    else
      say "✅ relay 进程(pid $PID)晚于部署位文件修改（运行面是新的）"
    fi
  else
    say "ℹ️  未发现运行中的 relay 进程（relay-service/relay.mjs）——部署后记得启动"
  fi
fi

# ---------- 汇总 ----------
if [ "$FAIL" = "1" ]; then
  say "——部署不完整，用户将看到新旧混杂的界面（2026-10-11 P0 幻象事故的根源），同步+重启后重跑本脚本"
  exit 1
fi
say "✅ 部署完整性通过（relay.mjs + web-console 双壳 + mobile 面 + 进程新鲜度）"
