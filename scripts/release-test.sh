#!/usr/bin/env bash
# 一键 test 包出链（2026-10-11：手工顺序三次犯错后的机械保证——
# bump → --write → build-plugin → 提交 → 守卫 → tag → push，
# 守卫不绿绝不 tag；顺序锁死在脚本里不再靠人记）
# 用法：scripts/release-test.sh <版本号，如 0.7.0-test.15>
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:?用法: release-test.sh <版本号>}"
case "$V" in *-test.*) ;; *) echo "ERR: 版本号须带 -test 后缀（本脚本只出 test 包）"; exit 1;; esac
git diff --quiet || { echo "ERR: 工作区有未提交改动，先收口"; exit 1; }

echo "[1/7] VERSION → $V"
echo "$V" > VERSION
echo "[2/7] version.mjs --write 七落点"
node scripts/version.mjs --write | tail -1
echo "[3/7] build-plugin 重建 bundle+副本"
node relay/scripts/build-plugin.mjs | tail -1
git add -A
git commit -m "chore: bump $V

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" | tail -1
echo "[3.5/7] relay-service 静态面同步（桌面壳页面来源，S1/S2 闸前置）"
cp web-console/index.html web-console/index-005.html ~/.cc-deck/relay-service/web-console/
echo "[4/7] 守卫（不绿即停，绝不 tag）"
bash scripts/check-bundle-sync.sh | tail -2
bash scripts/check-bundle-sync.sh | grep -q "✅ bundle 同步检查通过" || { echo "ERR: 守卫未过，已停止（可 git reset --soft HEAD~1 回退 bump 后修）"; exit 1; }
echo "[5/7] tag v$V-nova"
git tag "v$V-nova"
echo "[6/7] push 分支+tag"
git push origin "HEAD:${CURRENT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}" "v$V-nova" | tail -2
echo "[7/7] 完成——CI 构建中，gh run list 盯 run；出包后部署面 cp web-console + relay.mjs 同步另走 check-deploy-complete.sh"
echo "提醒：部署位同步（relay.mjs+web-console → relay-service）+ 重启壳 = 用户可见；别忘验收单。"
