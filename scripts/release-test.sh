#!/usr/bin/env bash
# 一键 test 包出链（2026-10-11：手工顺序三次犯错后的机械保证——
# bump → --write → build-plugin → 提交 → 部署面同步 → 守卫 → tag → push，
# 守卫不绿绝不 tag；顺序锁死在脚本里不再靠人记）
# 用法：scripts/release-test.sh <版本号，如 0.7.0-test.15> [--with-cf]
#   --with-cf  出包时点同时部署 CF 资产面（默认 --skip-cf 不出外网，#237）
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:?用法: release-test.sh <版本号>}"
case "$V" in *-test.*) ;; *) echo "ERR: 版本号须带 -test 后缀（本脚本只出 test 包）"; exit 1;; esac
case "${2:-}" in ""|--with-cf) ;; *) echo "ERR: 未知参数 $2（仅支持 --with-cf）"; exit 1;; esac
# W-P2BATCH4 件1（1106 晚发版事故根因）：出包必须站在 dev——当晚 checkout dev 被残留
# worktree 挡住静默失败，bump+tag 落在 docs/org-msr-18265972 古分支（tag 不含 dev 22 笔，
# PM 手工止损）。原 push 行 CURRENT_BRANCH:-HEAD 缺省对非 dev 分支零拦截——分支守卫前置。
CUR_BR="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CUR_BR" != "dev" ]; then
  echo "ERR: 必须在 dev 分支出包（当前: ${CUR_BR}）——先 git checkout dev 并确认工作区干净再跑；非 dev 出包=发版事故（1106 实锤）"
  exit 1
fi
git diff --quiet || { echo "ERR: 工作区有未提交改动，先收口"; exit 1; }
# W-BOARDTRUTH5 刀四（1109 五现治本）：CLI 分发源同步步——repo cc-plugins → 部署位
# ~/.cc-deck/bin/。部署位有未回流热改=拒发（先回流再出包）；这是五现直接病因的双位
# 漂移在发版链上的闸（此前发版链零 CLI 同步步——漂移静默累积）。
echo "[0.5/7] CLI 分发源同步（leader-dispatch）"
bash scripts/sync-leader-cli.sh || { echo "ERR: leader-dispatch 分发未过（部署位有未回流热改？回流清单见 W-BOARDTRUTH5 回执）——先回流再出包"; exit 1; }

# DL-P2-1（DEV-22 批 B，2026-11-28）：feedback-ledger 对账闸——「唯一闭环账本」结构违规
# 拦出包（缺列/状态非枚举=账失真）；「已修待验/真机待验」滞留>7 天只打印追问清单交
# PM 晨报（军规「不许沉默搁置」的机器提醒，不拦出包——追问是人的动作不是闸的动作）。
echo "[0.6/7] feedback-ledger 对账闸"
bash scripts/feedback-ledger-check.sh || { echo "ERR: feedback-ledger 结构违规——修 docs/operations/feedback-ledger.md 再出包"; exit 1; }

echo "[1/7] VERSION → $V"
echo "$V" > VERSION
echo "[2/7] version.mjs --write 七落点"
node scripts/version.mjs --write | tail -1
echo "[3/7] build-plugin 重建 bundle+副本"
node relay/scripts/build-plugin.mjs | tail -1
git add -A
git commit -m "chore: bump $V

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" | tail -1
echo "[3.5/7] web 面单源同步（deploy-web.sh：S1-S3 + 逐面验证锚；--with-cf 时含 S4 CF）"
if [ "${2:-}" = "--with-cf" ]; then
  bash scripts/deploy-web.sh
else
  bash scripts/deploy-web.sh --skip-cf
fi
# 幂等显式闸（审查 P1）：[3/7] 已跑 build-plugin，[3.5] 重跑 S1 应零 diff——出现
# diff = esbuild 环境漂移产出了异源产物，带着它 tag 会烙错版本，必须停。R2①（DEV-44）
# 后产物副本不入 git，本 diff 面收窄为 tracked 源（版本落点等）；产物面幂等由
# [4/7] check-bundle-sync 的重建对比闸承担
git diff --quiet || { echo "ERR: [3.5/7] deploy-web 后工作区出现新 diff（S1 产物非幂等，esbuild 环境漂移？）："; git status --short | head -5; exit 1; }
echo "[4/7] 发布期自检（R2① 语义：[3/7] 已先 build 刷新，此处不绿即停，绝不 tag）"
bash scripts/check-bundle-sync.sh | tail -2
bash scripts/check-bundle-sync.sh | grep -q "✅ bundle 同步自检通过" || { echo "ERR: 守卫未过，已停止（可 git reset --soft HEAD~1 回退 bump 后修）"; exit 1; }
echo "[5/7] tag v$V-nova"
git tag "v$V-nova"
echo "[6/7] push 分支+tag"
git push origin "HEAD:${CURRENT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}" "v$V-nova" | tail -2
echo "[7/7] 完成——CI 构建中，gh run list 盯 run；web 面（副本/Nova/relay-service）已在 [3.5/7] 同步并逐面锚验证"
echo "提醒：文件同步≠进程换新——重启 CC Deck Nova / relay 进程运行面才换新（deploy-web.sh 尾注同）；别忘验收单。"
