#!/usr/bin/env bash
# A-4 + A-10 工具硬化回归（DEV-22 批 B，台账 §四A）——三段：
#   Z0 语法闸：sync-leader-cli.sh / leader-harvest bash -n
#   A4 沙盒行为：CC_DECK_BIN_DIR 覆盖位跑真 sync——①零 diff 路径不产备份噪音
#     ②覆盖路径产 .bak 且留 10 代 ③拷贝后 cmp 实证行 ④--force 丢热改仍先备份
#   A10 源码锚：leader-harvest 配对守卫三件（begin 记账/end 补 begin/end 幂等跳过）
#     + review_brief 反方视角条目
# 直跑：bash scripts/test-cli-tools.sh（零网络零生产位触碰——沙盒 DST_DIR=mkdtemp）
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

echo "Z0 语法闸："
for f in scripts/sync-leader-cli.sh cc-plugins/plugins/cc-deck/bin/leader-dispatch cc-plugins/plugins/cc-deck/bin/leader-harvest; do
  bash -n "$f" && ok "Z0 $f 语法可解析" || bad "Z0 $f bash -n 不过"
done

echo "A4 sync-leader-cli 沙盒行为："
SBX="$(mktemp -d)"
export CC_DECK_BIN_DIR="$SBX/bin"
mkdir -p "$CC_DECK_BIN_DIR"
# ①首跑：部署位空——分发+实证，无备份（无旧件）
OUT1="$(bash scripts/sync-leader-cli.sh 2>&1)"; RC1=$?
[ $RC1 -eq 0 ] && ok "A4-1 首跑 rc=0" || { bad "A4-1 首跑 rc=$RC1"; echo "$OUT1"; }
echo "$OUT1" | grep -q "逐字节实证 ✓" && ok "A4-2 拷贝后 cmp 实证行在（探针消费面）" || bad "A4-2 实证行缺"
[ ! -d "$CC_DECK_BIN_DIR/backup" ] && ok "A4-3 零旧件路径不产备份噪音" || bad "A4-3 首跑不应有 backup/"
cmp -s cc-plugins/plugins/cc-deck/bin/leader-dispatch "$CC_DECK_BIN_DIR/leader-dispatch" && ok "A4-4 部署件=repo 源（分发真到位）" || bad "A4-4 部署件与源不一致"
# ②部署位热改（模拟未回流）——默认拒发
echo "# 热改标记 $(date +%s)" >> "$CC_DECK_BIN_DIR/leader-dispatch"
OUT2="$(bash scripts/sync-leader-cli.sh 2>&1)"; RC2=$?
[ $RC2 -ne 0 ] && ok "A4-5 部署位含未回流热改默认拒（rc=$RC2）" || bad "A4-5 应拒未拒"
# ③--force 覆盖——先备份再覆盖，热改副本可回滚
OUT3="$(bash scripts/sync-leader-cli.sh --force 2>&1)"; RC3=$?
[ $RC3 -eq 0 ] && ok "A4-6 --force rc=0" || { bad "A4-6 --force rc=$RC3"; echo "$OUT3"; }
BK="$(ls "$CC_DECK_BIN_DIR"/backup/leader-dispatch.*.bak 2>/dev/null | head -1)"
[ -n "$BK" ] && ok "A4-7 --force 覆盖前备份在位（$(basename "$BK")）" || bad "A4-7 --force 无备份=热改永久丢（A-4 主诉形态）"
grep -q "热改标记" "$BK" 2>/dev/null && ok "A4-8 备份内容含被覆盖热改（回滚有据）" || bad "A4-8 备份不含热改内容"
# ④备份留 10 代（造 12 个旧代，重跑 force 后应只剩 10）
for i in $(seq 1 12); do
  echo "gen$i" > "$CC_DECK_BIN_DIR/leader-dispatch"
  bash scripts/sync-leader-cli.sh --force >/dev/null 2>&1
done
NB="$(ls "$CC_DECK_BIN_DIR"/backup/leader-dispatch.*.bak 2>/dev/null | wc -l | tr -d ' ')"
[ "$NB" -le 10 ] && ok "A4-9 备份滚动留 ≤10 代（实得 $NB）" || bad "A4-9 备份代数失控（$NB）"
# ⑤同秒双覆盖（秒级时戳撞名回落 pid 后缀）——两次不同热改同秒 force，备份应两份不互覆
rm -f "$CC_DECK_BIN_DIR"/backup/leader-dispatch.*.bak
echo "hotmod-A" > "$CC_DECK_BIN_DIR/leader-dispatch"
bash scripts/sync-leader-cli.sh --force >/dev/null 2>&1
echo "hotmod-B" > "$CC_DECK_BIN_DIR/leader-dispatch"
bash scripts/sync-leader-cli.sh --force >/dev/null 2>&1
NB2="$(ls "$CC_DECK_BIN_DIR"/backup/leader-dispatch.*.bak 2>/dev/null | wc -l | tr -d ' ')"
[ "$NB2" -ge 2 ] && ok "A4-10 同秒双覆盖备份不互覆（pid 后缀，实得 $NB2 份）" || bad "A4-10 同秒覆盖互覆（$NB2 份——撞名回落失效）"
rm -rf "$SBX"; unset CC_DECK_BIN_DIR

echo "A10 leader-harvest 源码锚："
LH=cc-plugins/plugins/cc-deck/bin/leader-harvest
grep -q 'rpair="$data/review-pairs.ndjson"' $LH && ok "A10-1 配对账文件锚（review-pairs.ndjson）" || bad "A10-1 配对账锚缺"
grep -q "rl_seen .*\$did. begin || rl_note" $LH && ok "A10-2 begin 成功即记账（重试幂等基线）" || bad "A10-2 begin 记账锚缺"
grep -q "补记：--merge 收口时未见互审 begin" $LH && ok "A10-3 end 前补 begin（直收形态时序链不缺头）" || bad "A10-3 补记 begin 锚缺"
grep -q "end 段行已记（幂等跳过，A-10②）" $LH && ok "A10-4 end 幂等跳过（重跑不重复写段行）" || bad "A10-4 end 幂等锚缺"
grep -q "反方视角轮（A-10③" $LH && ok "A10-5 review_brief 反方视角条目在" || bad "A10-5 反方视角条目缺"
grep -q "反方轮未" $LH && ok "A10-6 反方轮「找不出要明说」防略过" || bad "A10-6 防略过措辞缺"

echo
echo "PASS: $pass passed, $fail failed"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
