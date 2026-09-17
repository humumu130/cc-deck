#!/usr/bin/env bash
# bundle 同步护栏：发版/构建前必跑——校验三处 relay.mjs 一致 + git 工作区干净
# 不一致立即 exit 1（2026-09-14 版本链断裂事故的防再犯护栏）
set -euo pipefail
cd "$(dirname "$0")/.."

B1=$(md5 -q cc-plugins/plugins/cc-deck/scripts/relay.mjs 2>/dev/null || echo MISSING)
B2=$(md5 -q desktop-tauri/src-tauri/resources/relay.mjs 2>/dev/null || echo MISSING)
B3=$(md5 -q '/Applications/CC Deck.app/Contents/Resources/resources/relay.mjs' 2>/dev/null || echo "not-installed")

FAIL=0
[ "$B1" = "$B2" ] || { echo "❌ cc-plugins bundle ≠ desktop-tauri resources（git 里的产物过期）"; FAIL=1; }
[ "$B2" = "$B3" ] || { echo "⚠️  desktop-tauri resources ≠ /Applications 已装（Mac app 未热替换最新，构建前可接受，发版前必须替换）"; [ "${1:-}" = "--strict" ] && FAIL=1; }
[ "$B1" = "MISSING" ] && { echo "❌ cc-plugins bundle 不存在（先跑 build-plugin.mjs）"; FAIL=1; }

# git 工作区必须干净（发版前未提交改动 = 产物与仓库不一致的风险源）
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ git 工作区有未提交改动："
  git status --short | head -5
  FAIL=1
fi

# 诊断桩特征（最新 bundle 必含——版本链断裂时期的旧 bundle 无此串）
if [ -f cc-plugins/plugins/cc-deck/scripts/relay.mjs ] && ! grep -q 'no cli_pid sid' cc-plugins/plugins/cc-deck/scripts/relay.mjs; then
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
