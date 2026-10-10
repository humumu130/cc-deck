#!/usr/bin/env bash
# bundle 同步护栏：发版/构建前必跑——校验三处 relay.mjs 一致 + git 工作区干净
# 不一致立即 exit 1（2026-09-14 版本链断裂事故的防再犯护栏）
set -euo pipefail
cd "$(dirname "$0")/.."

# 哈希工具用 shasum -a 256（P1b 修复，2026-10-05）：Mac 无 PATH 内 md5（原 md5 -q
# 两处全落 MISSING → B1=MISSING=B2 假通过，真漂移检不出+误报「bundle 不存在」）；
# shasum macOS 自带且 Linux 通用（md5sum 语法跨平台不一致），256 位与 P1a 核验口径
# 统一。shasum 失败时输出 "MISSING MISSING" 经 awk 取 $1 仍得 MISSING，保持原哨兵语义
B1=$( { shasum -a 256 cc-plugins/plugins/cc-deck/scripts/relay.mjs 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
B2=$( { shasum -a 256 desktop-tauri/src-tauri/resources/relay.mjs 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
B3=$( { shasum -a 256 '/Applications/CC Deck.app/Contents/Resources/resources/relay.mjs' 2>/dev/null || echo "not-installed not-installed"; } | awk '{print $1}')
# 插件 Web 副本对（M13-7 补：此前 sh 面只锁 relay.mjs 两份——web-console/index.html 副本
# 漂移只有 test-p1-build 锁，而本脚本是发版前必跑闸；副本过期=插件部署网页端 503/旧界面，
# #150 同坑。源→副本单源复制，一致性=hash 全等）
# 双壳两对（新旧壳共存，2026-10-07 用户拍板）：/app2 的 005 新壳（index-005.html）同样
# 进插件包，副本漂移=插件 /app2 503 或旧界面，同口径同查
W1=$( { shasum -a 256 web-console/index.html 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
W2=$( { shasum -a 256 cc-plugins/plugins/cc-deck/web-console/index.html 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
W3=$( { shasum -a 256 web-console/index-005.html 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
W4=$( { shasum -a 256 cc-plugins/plugins/cc-deck/web-console/index-005.html 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')

FAIL=0
[ "$B1" = "$B2" ] || { echo "❌ cc-plugins bundle ≠ desktop-tauri resources（git 里的产物过期）"; FAIL=1; }
[ "$B2" = "$B3" ] || { echo "⚠️  desktop-tauri resources ≠ /Applications 已装（Mac app 未热替换最新，构建前可接受，发版前必须替换）"; [ "${1:-}" = "--strict" ] && FAIL=1; }
[ "$B1" = "MISSING" ] && { echo "❌ cc-plugins bundle 不存在（先跑 build-plugin.mjs）"; FAIL=1; }
[ "$W1" = "$W2" ] || { echo "❌ 插件 Web 副本 ≠ web-console/index.html 源（重跑 build-plugin.mjs 刷新）"; FAIL=1; }
[ "$W1" = "MISSING" ] && { echo "❌ web-console/index.html 源不存在"; FAIL=1; }
[ "$W3" = "$W4" ] || { echo "❌ 插件 Web 副本 ≠ web-console/index-005.html 源（重跑 build-plugin.mjs 刷新）"; FAIL=1; }
[ "$W3" = "MISSING" ] && { echo "❌ web-console/index-005.html 源不存在"; FAIL=1; }

# git 工作区必须干净（发版前未提交改动 = 产物与仓库不一致的风险源）
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ git 工作区有未提交改动："
  git status --short | head -5
  FAIL=1
fi

# 诊断桩特征（最新 bundle 必含——版本链断裂时期的旧 bundle 无此串）
# 探针沿革：'no cli_pid sid'（2026-09-14）→ 506a58c 重构后从源码消失、守卫误拦，
# 2026-09-18 换 CLAUDE_CODE_ENABLE_TODO_TOOLS（f283b58 任务工具门控的 env 契约，
# 断裂时代 bundle 无此串；env 契约不轻易改名，比日志文案耐用）
if [ -f cc-plugins/plugins/cc-deck/scripts/relay.mjs ] && ! grep -q 'CLAUDE_CODE_ENABLE_TODO_TOOLS' cc-plugins/plugins/cc-deck/scripts/relay.mjs; then
  echo "❌ bundle 缺诊断桩特征（可能是版本链断裂时期的旧产物）"
  FAIL=1
fi

# bundle 可加载性：语法检查（2026-09-16 createRequire 重复声明事故的防再犯——
# md5 一致 + 诊断桩在，但 bundle 起不来的静态错误只有语法检查能逮住）
if [ -f cc-plugins/plugins/cc-deck/scripts/relay.mjs ] && ! node --check cc-plugins/plugins/cc-deck/scripts/relay.mjs 2>/tmp/bundle-check.err; then
  echo "❌ bundle 语法检查不过（加载即炸）："
  head -3 /tmp/bundle-check.err
  FAIL=1
fi

# bundle 重建对比（2026-10-10 A2，审查 P1-3 的防再犯）：B1/B2 两两一致只锁「两份
# 副本互相同步」，锁不住「bundle 是别处源码状态所出」——test.7-nova tag 的 bundle
# 即为合并后工作树所出、与 tag 源码不符，从 tag 拉热修分支重打包会静默回退旧 relay
# （丢 #148 ext- 收养、丢 rollout cursor 持久化）。esbuild 确定性已实证（同参重建
# 与部署位逐字节一致），故以「当前 relay/src 同参重建 vs 部署位」比 SHA：不等 =
# 部署位过期/异源，重跑 relay/scripts/build-plugin.mjs 刷新。esbuild 参数单源在
# relay/scripts/bundle-options.mjs（build-plugin 与 rebuild-bundle 共用），杜绝
# 参数漂移让本闸失真
if [ -f cc-plugins/plugins/cc-deck/scripts/relay.mjs ]; then
  REBUILD_DIR="$(node relay/scripts/rebuild-bundle.mjs)" || { echo "❌ bundle 重建失败（源码/esbuild 参数错误）"; FAIL=1; }
  if [ -n "${REBUILD_DIR:-}" ]; then
    RB=$( { shasum -a 256 "$REBUILD_DIR/relay.mjs" 2>/dev/null || echo "MISSING MISSING"; } | awk '{print $1}')
    if [ "$RB" = "MISSING" ]; then
      echo "❌ 重建产物缺失（rebuild-bundle.mjs 未产出 relay.mjs）"
      FAIL=1
    elif [ "$B1" != "$RB" ]; then
      echo "❌ 部署位 bundle ≠ 当前 relay/src 重建产物（bundle 过期/异源）："
      echo "    部署位 B1 = $B1"
      echo "    同参重建  = $RB"
      echo "    重跑 relay/scripts/build-plugin.mjs 刷新部署位后重来"
      FAIL=1
    fi
    rm -rf "$REBUILD_DIR"
  fi
fi

# bundle 冒烟（#190，2026-09-24 事故的防再犯）：node --check 只逮语法，逮不住
# 「语法合法但加载即炸」——当日热替换进 Mac App 的 bundle 缺 build-plugin.mjs 的
# createRequire banner（绕过脚本直接 esbuild 的产物），tweetnacl 的 require("crypto")
# 落到 esbuild 兜底 throw，内嵌 relay 启动即崩、监督线程无限退避重拉。真 import
# 起服一次（隔离端口+隔离数据目录，3s 存活且打印启动横幅才算过）才能逮住这类伤
if [ -f cc-plugins/plugins/cc-deck/scripts/relay.mjs ]; then
  SMOKE_DIR="$(mktemp -d /tmp/ccdeck-smoke-data.XXXXXX)"
  SMOKE_LOG="$SMOKE_DIR/out.log"
  SMOKE_PORT=$(( (RANDOM % 20000) + 40000 ))
  # 密闭五件套（2026-10-03 实锤补齐）：此前只隔端口+数据目录——冒烟 relay 仍会
  # ①在默认 ~/.cc-deck/org 引导真 Leader（P0 同款生产污染）②连生产云桥 ③镜像写
  # ~/.cc-deck/data/bridge.json（沙盒检测漏网时）④mDNS 广播幽灵实例。org/云桥/
  # 镜像/mdns 全部钉死，冒烟只剩「bundle 能起、横幅能出」一件事
  CCR_PORT="$SMOKE_PORT" CCR_DATA_DIR="$SMOKE_DIR" CCR_ORG_DIR="$SMOKE_DIR/org" \
    CCR_CLOUD_URL="" CCR_NO_BRIDGE_MIRROR=1 CCR_NO_MDNS=1 CC_DECK_PLUGIN=1 \
    node cc-plugins/plugins/cc-deck/scripts/relay.mjs >"$SMOKE_LOG" 2>&1 &
  SMOKE_PID=$!
  # 8s：orphan-adopt 扫描（~/.claude/projects）+ 2.3MB bundle 冷加载会把横幅拖过
  # 3s 窗口——曾误报「起服失败」（实为 flaky，2026-10-03 复现实测横幅 ~5s 出）
  sleep 8
  SMOKE_OK=1
  kill -0 "$SMOKE_PID" 2>/dev/null || SMOKE_OK=0
  grep -q "CC Deck Relay 已启动" "$SMOKE_LOG" || SMOKE_OK=0
  if [ "$SMOKE_OK" != "1" ]; then
    echo "❌ bundle 冒烟：隔离端口 $SMOKE_PORT 起服失败（语法检查逮不住的运行期伤）："
    head -8 "$SMOKE_LOG"
    FAIL=1
  fi
  # 收尾三连全加 || true：进程被 TERM 杀死后 bash 随时 reap，随后 kill -9/wait 对
  # 已消失 pid 返回非零，裸写会误触 set -e 把整个护栏静默 exit 1——实质检查全过
  # 却报失败（2026-09-27 实跑抓到，两次跑分别挂在 wait 与 kill -9，纯竞态）
  kill "$SMOKE_PID" 2>/dev/null || true
  sleep 0.3
  kill -9 "$SMOKE_PID" 2>/dev/null || true
  wait "$SMOKE_PID" 2>/dev/null || true
  rm -rf "$SMOKE_DIR"
fi

# 版本一致性闸门（2026-09-17）：VERSION 单一事实源，五处落点漂移即拦
if [ -f scripts/version.mjs ] && ! node scripts/version.mjs --check >/dev/null 2>&1; then
  echo "❌ 版本号落点与 VERSION 不一致：node scripts/version.mjs --write 修正后再来"
  node scripts/version.mjs --check
  FAIL=1
fi

if [ "$FAIL" = "1" ]; then
  echo "——检查未通过，禁止打 tag/发版"
  exit 1
fi
echo "✅ bundle 同步检查通过（三处一致 + 工作区干净 + 诊断桩特征在）"
