#!/usr/bin/env bash
# W-SPLIT-S0 行为 parity 网（docs/design-split-plan.md §3 阶段 0 拍板产物）
# 用法：
#   首次固化基线：scripts/check-behavior-parity.sh --record      （逐件跑全量，输出存 artifacts/split-baseline/）
#   拆分后比对：  scripts/check-behavior-parity.sh                （重跑全量，与基线 diff 通过/失败集合）
#   单域快查：    scripts/check-behavior-parity.sh relay          （只跑 relay 域；expo 同理）
# 输出：每套件一个输出文件（<域>-<件名>.txt，含 PASS/FAIL 行与 PASS 计数）；parity 报告到 stdout。
# flaky 豁免：FLAKY 清单内套件失败不计 parity 破坏（输出仍记录，标注 [flaky-skip]）。
# 退出码：0=parity 一致（或仅 flaky 差异）；1=通过/失败集合发生实质变化（禁止合并拆分批）。
# 已知慢件：test-bridge（~4-8min）走全量时包含——单域快查可跳（relay-fast 模式维护另批）。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="artifacts/split-baseline"
MODE="check"; [ "${1:-}" = "--record" ] && MODE="record"
DOMAIN="${1:-}"; case "$DOMAIN" in relay|expo) ;; *) DOMAIN="" ;; esac

# flaky 豁免清单（基线固化期两跑不一致者进此；保持空=全部稳定）
FLAKY="${FLAKY:-}"

# GNU timeout 兜底（DEV-49）：macOS 无 timeout/gtimeout——2026-10-20 基线即因此全体
# exit=127「command not found」，录进的全是噪声（详见 DEV-49 回执）。有则 600s 防挂件，
# 无则裸跑退化（仅失去超时保护，不阻断执行面）。
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
texec() {
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" 600 "$@"; else "$@"; fi
}

run_domain() {
  local dir="$1" prefix="$2" runner="$3" glob="$4"
  for f in $glob; do
    [ -e "$f" ] || continue   # glob 零命中时不把字面量当件跑
    local name="$(basename "$f" .ts)"
    local out="$BASE/${prefix}-${name}.txt"
    local marker=""
    if echo "$FLAKY" | grep -q "\b${name}\b"; then marker="[flaky-skip] "; fi
    echo "  ${marker}run ${prefix}/${name} …" >&2
    # 执行路径跟随 glob 实际位置（DEV-38 迁址后 relay=tests/、expo 仍在 scripts/），
    # 不再硬编码 scripts/——枚举面与执行面同源，杜绝迁址类三面漂移
    local rel="${f#"$dir"/}"
    ( cd "$dir" && texec $runner "$rel" ) > /tmp/parity-run.txt 2>&1
    local rc=$?
    { echo "# exit=$rc $(date +%s)"; cat /tmp/parity-run.txt; } > "$out"
  done
}

if [ "$MODE" = "record" ]; then
  mkdir -p "$BASE"
  [ -z "$DOMAIN" ] || [ "$DOMAIN" = "relay" ] && run_domain relay relay "./node_modules/.bin/tsx" "relay/tests/test-*.ts"
  [ -z "$DOMAIN" ] || [ "$DOMAIN" = "expo" ]  && run_domain expo-app expo "./node_modules/.bin/tsx" "expo-app/scripts/test-*.ts"
  echo "基线已固化到 ${BASE}（$(ls $BASE | wc -l | tr -d ' ') 件）"
  exit 0
fi

# check 模式：重跑 → 与基线 diff 通过/失败集合
FAIL_CHANGES=0; TOTAL=0; SAME=0
for f in $BASE/*.txt; do
  name="$(basename "$f" .txt)"
  prefix="${name%%-*}"; tname="${name#*-}"
  [ -n "$DOMAIN" ] && [ "$prefix" != "$DOMAIN" ] && continue
  dir="$prefix"; [ "$prefix" = "expo" ] && dir="expo-app"
  TOTAL=$((TOTAL+1))
  # 件位置按实际存在面解析（DEV-38 迁址后 relay=tests/、expo 仍在 scripts/）；
  # 基线名只存 <域>-<件名>，两面皆无=孤儿基线，点名计破坏——不再静默 ENOENT 断路
  sub=""
  for c in tests scripts; do [ -f "${dir}/${c}/${tname}.ts" ] && sub="$c" && break; done
  if [ -z "$sub" ]; then
    echo "  ❌ ${name}：${dir}/tests|scripts/ 均无 ${tname}.ts（孤儿基线）"
    FAIL_CHANGES=$((FAIL_CHANGES+1)); continue
  fi
  ( cd "$dir" && texec ./node_modules/.bin/tsx "${sub}/${tname}.ts" ) > /tmp/parity-new.txt 2>&1
  rc=$?
  base_pass=$(grep -cE '(PASS|✓|ok )' "$f" || true)
  base_fail=$(grep -cE '(FAIL|✗)' "$f" || true)
  new_pass=$(grep -cE '(PASS|✓|ok )' /tmp/parity-new.txt || true)
  new_fail=$(grep -cE '(FAIL|✗)' /tmp/parity-new.txt || true)
  if echo "$FLAKY" | grep -q "\b${tname}\b"; then
    echo "  [flaky-skip] $name"
    continue
  fi
  if [ "$base_fail" = "0" ] && [ "$new_fail" != "0" ]; then
    echo "  ❌ ${name}：基线全绿 → 出现 $new_fail 失败（parity 破坏）"; FAIL_CHANGES=$((FAIL_CHANGES+1))
  elif [ "$base_fail" != "0" ] && [ "$rc" = "0" ]; then
    echo "  ⚠️  ${name}：基线含失败 → 现转绿（改善，但需人工确认非误报）"
  else
    SAME=$((SAME+1))
  fi
done
echo "—— parity：$TOTAL 件比对，$SAME 一致，$FAIL_CHANGES 实质破坏"
[ "$FAIL_CHANGES" = "0" ] || exit 1
exit 0
