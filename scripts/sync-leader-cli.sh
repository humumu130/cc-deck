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
# W-HARVESTGATE：双 CLI 单一分发源——leader-harvest 同步纳管（此前单文件，harvest 双位
# 漂移 375 行未被闸拦=W-BOARDTRUTH5 回执「harvest 同病」预警实锤；回流完成后零 diff 通过）
SRC2="$REPO_ROOT/cc-plugins/plugins/cc-deck/bin/leader-harvest"
DST2="$DST_DIR/leader-harvest"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

for _s in "$SRC" "$SRC2"; do
  [ -f "$_s" ] || { echo "ERR: repo 源不存在：$_s"; exit 1; }
  bash -n "$_s" || { echo "ERR: repo 源语法不过（bash -n）：$_s——拒绝分发坏脚本"; exit 1; }
done

mkdir -p "$DST_DIR"
check_pair () { # $1=repo 源 $2=部署位 $3=显示名
  if [ -f "$2" ] && ! cmp -s "$1" "$2"; then
    echo "── 部署位与 repo 源有 diff（$2 vs $1）："
    diff -u "$2" "$1" | head -80 || true
    echo "── diff 结束（截断至 80 行，全量：diff -u '$2' '$1'）"
    if [ -n "$(diff "$2" "$1" | grep '^<' | head -1)" ] && [ "$FORCE" = 0 ]; then
      echo "ERR: [$3] 部署位含 repo 没有的内容（上方 < 行=未回流热改）——先回流 repo 再分发（直接覆盖=丢热改=五现重演）；确认丢弃用 --force"
      exit 1
    fi
  fi
}
check_pair "$SRC" "$DST" leader-dispatch
check_pair "$SRC2" "$DST2" leader-harvest

cp "$SRC" "$DST"; chmod +x "$DST"
cp "$SRC2" "$DST2"; chmod +x "$DST2"
for _d in "$DST" "$DST2"; do bash -n "$_d" || { echo "ERR: 部署位拷贝后语法不过（不应发生——回滚检查）：$_d"; exit 1; }; done
md5_of() { if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi; }
echo "OK: leader-dispatch + leader-harvest 已分发 repo → $DST_DIR（单向：repo=唯一分发源）"
echo "  leader-dispatch md5(src)=$(md5_of "$SRC") / md5(dst)=$(md5_of "$DST")"
echo "  leader-harvest  md5(src)=$(md5_of "$SRC2") / md5(dst)=$(md5_of "$DST2")"
