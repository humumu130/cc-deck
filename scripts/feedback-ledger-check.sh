#!/usr/bin/env bash
# feedback-ledger 对账闸（DL-P2-1，DEV-22 批 B，2026-11-28）——「唯一闭环账本」的
# 结构执法器，挂出包链（release-test.sh）与日常巡检：
#   结构违规（拦出包，exit 1）：反馈表数据行缺列 / 状态列不在枚举（处理中/已修待验/
#     用户已确认/真机待验/已否决）——表坏了=闭环账失真，先修账再出包。
#   滞留追问（只打印不拦，PM 晨报消费）：「已修待验/真机待验」行日期距今超过
#     STALE_DAYS（缺省 7≈一个发版周期冗余量）——台账军规「不许沉默搁置」的机器提醒。
# 用法：scripts/feedback-ledger-check.sh [--strict]   # --strict 滞留也拦（严检用）
# 只读零副作用；表定位=表头含全部六列名的 markdown 表（记录格式说明表自动跳过）。
set -u
cd "$(dirname "$0")/.."
LEDGER="docs/operations/feedback-ledger.md"
STALE_DAYS=7
[ "${1:-}" = "--strict" ] && STALE=1 || STALE=0

[ -f "$LEDGER" ] || { echo "ERR: 台账不存在：$LEDGER"; exit 1; }

STATUS_ENUM="处理中|已修待验|用户已确认|真机待验|已否决"
violate=0; stale_rows=0; total_rows=0
in_table=0

# 今天与滞留线（日期按本年 MM-DD 解析；台账 2026-10 立，跨年时需人工年检一次）
now_s=$(date +%s)
cutoff_s=$(( now_s - STALE_DAYS * 86400 ))

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    \|*)
      # 表头判定：六列名齐=反馈数据表；分隔行跳过；其余表（记录格式等）不进数据态
      if [ "$in_table" = 0 ]; then
        if printf '%s' "$line" | grep -q '日期' && printf '%s' "$line" | grep -q '原文摘要' \
           && printf '%s' "$line" | grep -q '任务号' && printf '%s' "$line" | grep -q '分支/提交' \
           && printf '%s' "$line" | grep -q '验证方式' && printf '%s' "$line" | grep -q '状态'; then
          in_table=1
        fi
        continue
      fi
      # 分隔行（|---|:---: 等）：剥掉 |/:/-/空格后为空即跳过
      [ -z "$(printf '%s' "$line" | tr -d '|-: ')" ] && continue
      # 数据行：六段单元格（行首行尾管道+5个内分隔）
      ncols=$(( $(printf '%s' "$line" | tr -d -c '|' | wc -c | tr -d ' ') - 1 ))
      total_rows=$((total_rows + 1))
      if [ "$ncols" -ne 6 ]; then
        echo "✗ 结构：列数 $ncols ≠ 6（缺列/串列）→ $line"
        violate=$((violate + 1)); continue
      fi
      # 状态归一：剥 markdown 装饰（**加粗** 等）与首尾空白——历史行带装饰不算结构违规
      status=$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/, "", $7); gsub(/^\*+|\*+$/, "", $7); print $7}')
      if ! printf '%s' "$status" | grep -qE "^($STATUS_ENUM)"; then
        echo "✗ 结构：状态「${status}」不在枚举（$STATUS_ENUM）→ $line"
        violate=$((violate + 1)); continue
      fi
      # 滞留追问：中间态行按首日期判龄
      case "$status" in
        已修待验*|真机待验*)
          d=$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/, "", $2); print $2}' | sed -n 's/^\([0-9]\{2\}\)-\([0-9]\{2\}\).*/\1 \2/p')
          if [ -n "$d" ]; then
            row_s=$(date -j -f "%m %d %H%M%S" "$d 000000" +%s 2>/dev/null || echo 0)
            if [ "$row_s" -gt 0 ] && [ "$row_s" -lt "$cutoff_s" ]; then
              age_days=$(( (now_s - row_s) / 86400 ))
              echo "⚠ 追问：[${status}] 已滞留 ${age_days} 天（>${STALE_DAYS} 天=军规主动追问）→ $line"
              stale_rows=$((stale_rows + 1))
            fi
          fi
          ;;
      esac
      ;;
    *)
      in_table=0
      ;;
  esac
done < "$LEDGER"

echo "对账：${total_rows} 行反馈，结构违规 ${violate}，滞留追问 ${stale_rows}（阈 ${STALE_DAYS} 天）"
if [ "$violate" -gt 0 ]; then
  echo "ERR: 表结构违规——闭环账失真，修 docs/operations/feedback-ledger.md 再出包"
  exit 1
fi
if [ "$stale_rows" -gt 0 ] && [ "$STALE" = 1 ]; then
  echo "ERR(--strict)：滞留 ${stale_rows} 行超期——先追问/收口再出包"
  exit 1
fi
exit 0
