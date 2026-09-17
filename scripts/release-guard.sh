#!/usr/bin/env bash
# ===== 发版硬约束守卫（2026-09-17）=====
# 合并 check-bundle-sync + version 一致性 + 烙印检查 + 产物验证
# 用法：./scripts/release-guard.sh <版本号>
# 任何一步 FAIL → 非零退出，禁止发版
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?用法: release-guard.sh <版本号>}"
FAIL=0
fail() { echo "❌ $1"; FAIL=1; }
ok() { echo "✅ $1"; }

# ===== 0. cwd 必须是仓库根 =====
if [ "$(basename "$PWD")" = "relay" ] || [ "$(basename "$PWD")" = "expo-app" ] || [ "$(basename "$PWD")" = "cloudflare" ]; then
  fail "cwd 在子目录里，必须在仓库根执行"
  exit 1
fi
ok "cwd = 仓库根"

# ===== 1. VERSION 文件 = 权威源 =====
CANON=$(cat VERSION | tr -d '[:space:]')
if [ "$CANON" != "$VER" ]; then
  fail "VERSION 文件 ($CANON) ≠ 参数 ($VER)——先改 VERSION 再跑"
  exit 1
fi
ok "VERSION = $CANON"

# ===== 2. 版本一致性（五处落点） =====
if ! node scripts/version.mjs --check >/dev/null 2>&1; then
  fail "版本落点漂移：node scripts/version.mjs --write 修正"
  node scripts/version.mjs --check
  FAIL=1
else
  ok "五处落点版本一致"
fi

# ===== 3. 烙印不入库：build.gradle/app.json 不得含 -test/-snap =====
for f in expo-app/android/app/build.gradle expo-app/app.json; do
  if grep -qE 'test\.[0-9]|snap\.[0-9]' "$f" 2>/dev/null; then
    fail "$f 含 test/snap 烙印——git checkout -- $f 回正"
    FAIL=1
  fi
done
[ $FAIL -eq 0 ] && ok "无烙印污染"

# ===== 4. bundle 同步 + 语法 =====
if [ -f scripts/check-bundle-sync.sh ]; then
  if ! ./scripts/check-bundle-sync.sh >/dev/null 2>&1; then
    ./scripts/check-bundle-sync.sh
    FAIL=1
  else
    ok "bundle 三处一致 + 语法通过"
  fi
fi

# ===== 5. git 工作区干净 =====
if [ -n "$(git status --porcelain)" ]; then
  fail "git 工作区不干净："
  git status --short | head -5
  FAIL=1
else
  ok "git 工作区干净"
fi

# ===== 6. bridge 测试套件 =====
if [ -f relay/package.json ]; then
  if (cd relay && npm run test:bridge >/dev/null 2>&1); then
    ok "bridge 测试通过"
  else
    fail "bridge 测试失败——先修再发"
    FAIL=1
  fi
fi

# ===== 总结 =====
if [ $FAIL -ne 0 ]; then
  echo ""
  echo "========== ❌ 发版守卫未通过，禁止发版 =========="
  exit 1
fi
echo ""
echo "========== ✅ 发版守卫全部通过 =========="
