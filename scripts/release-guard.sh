#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:?usage: release-guard.sh <version>}"
FAIL=0
node scripts/version.mjs --check >/dev/null 2>&1 || { echo "❌ 版本落点漂移"; node scripts/version.mjs --check; exit 1; }
echo "✅ 版本一致 ($VER)"
grep -qE 'test\.[0-9]|snap\.[0-9]' expo-app/android/app/build.gradle expo-app/app.json 2>/dev/null && { echo "❌ 烙印污染"; exit 1; }
echo "✅ 无烙印"
./scripts/check-bundle-sync.sh >/dev/null 2>&1 || { echo "❌ bundle 同步失败"; exit 1; }
echo "✅ bundle 同步"
[ -z "$(git status --porcelain)" ] || { echo "❌ 工作区不干净"; exit 1; }
echo "✅ 工作区干净"
(cd relay && npm run test:bridge >/dev/null 2>&1) || { echo "❌ bridge 测试失败"; exit 1; }
echo "✅ bridge 测试通过"
echo "✅ 发版守卫全部通过"
