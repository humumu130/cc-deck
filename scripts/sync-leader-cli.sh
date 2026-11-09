#!/usr/bin/env bash
# W-BOARDTRUTH5 刀四（1109 五现治本·CLI 单一分发源）：repo cc-plugins 源 → 部署位
# ~/.cc-deck/bin/ 单向分发。五现直接病因=双位漂移——repo 与部署位各自演化、发版链无
# 同步步（部署位热改 PR 链全家桶 repo 无，repo 守卫 --recall/slug 兜底部署位无）。
# 用法：scripts/sync-leader-cli.sh [--force]
#   挂发版链（release-test.sh 出包段）+ 手工可跑。--force=确认丢弃部署位未回流热改
#   后强覆盖（默认拒——防「repo 同步冲掉部署位热改」，REVEXCL-REVIEW 在途审项）。
# 正确顺序铁律：**先回流（部署位热改收编进 repo 并提交）再分发**——本脚本检测到部署位
# 含 repo 没有的内容即拒发并打印 diff 清单，回流后零 diff 通过。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/cc-plugins/plugins/cc-deck/bin/leader-dispatch"
DST_DIR="${CC_DECK_BIN_DIR:-$HOME/.cc-deck/bin}"
DST="$DST_DIR/leader-dispatch"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

[ -f "$SRC" ] || { echo "ERR: repo 源不存在：$SRC"; exit 1; }
bash -n "$SRC" || { echo "ERR: repo 源语法检查不过（bash -n）——拒绝分发坏脚本"; exit 1; }

mkdir -p "$DST_DIR"
if [ -f "$DST" ] && ! cmp -s "$SRC" "$DST"; then
  echo "── 部署位与 repo 源有 diff（$DST vs $SRC）："
  diff -u "$DST" "$SRC" | head -80 || true
  echo "── diff 结束（截断至 80 行，全量：diff -u '$DST' '$SRC'）"
  # 方向判定：部署位独有内容（diff < 侧非空）=未回流热改——覆盖即丢，拒发
  if [ -n "$(diff "$DST" "$SRC" | grep '^<' | head -1)" ] && [ "$FORCE" = 0 ]; then
    echo "ERR: 部署位含 repo 没有的内容（上方 < 行=未回流热改）——先回流 repo 再分发（直接覆盖=丢热改=五现重演）；确认丢弃用 --force"
    exit 1
  fi
fi

cp "$SRC" "$DST"
chmod +x "$DST"
bash -n "$DST" || { echo "ERR: 部署位拷贝后语法不过（不应发生——回滚检查）"; exit 1; }
md5_of() { if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi; }
echo "OK: leader-dispatch 已分发 repo → $DST（单向：repo=唯一分发源）"
echo "  md5(src)=$(md5_of "$SRC")"
echo "  md5(dst)=$(md5_of "$DST")"
