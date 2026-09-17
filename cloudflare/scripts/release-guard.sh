#!/usr/bin/env bash
# ===== 发版硬约束守卫 =====
# 合并 check-bundle-sync + version 一致性 + 烙印检查
# 用法：./scripts/release-guard.sh <版本号>
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?用法: release-guard.sh <版本号>}"
FAIL=0
fail() { echo "❌ $1"; FAIL=1; }

[ "$(basename "$PWD")" = "cc-deck" ] || { echo "❌ cwd 不在仓库根"; exit 1; }

CANON=$(cat VERSION | tr -d '[:space:]')
[ "$CANON" = "$VER" ] || { echo "❌ VERSION ($CANON) ≠ 参数 ($VER)"; exit 1; }
echo "✅ VERSION = $CANON"

node scripts/version.mjs --check >/dev/null 2>&1 || { echo "❌ 版本落点漂移"; node scripts/version.mjs --check; exit 1; }
echo "✅ 五处落点版本一致"

for f in expo-app/android/app/build.gradle expo-app/app.json; do
  grep -qE 'test\.[0-9]|snap\.[0-9]' "$f" && { echo "❌ $f 含烙印"; exit 1; }
done
echo "✅ 无烙印污染"

./scripts/check-bundle-sync.sh >/dev/null 2>&1 || { echo "❌ bundle 同步失败"; ./scripts/check-bundle-sync.sh; exit 1; }
echo "✅ bundle 同步"

[ -z "$(git status --porcelain)" ] || { echo "❌ 工作区不干净"; git status --short; exit 1; }
echo "✅ 工作区干净"

(cd relay && npm run test:bridge >/dev/null 2>&1) || { echo "❌ bridge 测试失败"; exit 1; }
echo "✅ bridge 测试通过"

echo "========== ✅ 发版守卫全部通过 =========="
