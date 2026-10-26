#!/usr/bin/env bash
# #262 发版链防断供闸表测+集成测（跑法：bash scripts/test-release-supply.sh）
# 表测：ver_cmp 函数组 + 指针版本提取函数，awk 抽取自 check-release-supply.sh 正本
#（锚定函数区——源改测试随动，对齐 test-deploygate.sh 先例）。
# 集成测：假 git repo（tag 择最大）+ 假 KV server（python3 动态读状态目录）跑正本
# 四态：全绿 / test-kv 断供 / 快照指针漂移 / apk 指针回落稳定名。
# bash 3.2（macOS）语义下绿（#253 军规：禁 `$name<多字节>` 邻接）。
set -uo pipefail
RS="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$RS/scripts/check-release-supply.sh"

# ---------- 抽取正本函数区（版本比较 + 指针提取，七函数）----------
FUNCS="$(mktemp /tmp/rs-funcs.XXXXXX)"
for fn in ver_shape_ok shape_of ver_core_cmp ver_pre_cmp ver_cmp disp_ver_of loc_ver_of; do
  awk -v f="$fn" '$0 ~ "^"f"\\(\\)"{p=1} p{print} p&&/^}/{p=0}' "$SRC"
done > "$FUNCS"
source "$FUNCS"

pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok $1"; else fail=$((fail+1)); echo "  FAIL $1（want=$3 got=$2）"; fi; }

# ---------- 表测：ver_cmp 方向 ----------
ok "相等 0.7.0-test.67-nova"        "$(ver_cmp 0.7.0-test.67-nova 0.7.0-test.67-nova)" 0
ok "断供态 0.7.0-test.56 < .67"     "$(ver_cmp 0.7.0-test.56 0.7.0-test.67)" -1
ok "超前 0.7.0-test.68 > .67"       "$(ver_cmp 0.7.0-test.68 0.7.0-test.67)" 1
ok "nova 后缀 test.67 < test.67-nova" "$(ver_cmp 0.7.0-test.67 0.7.0-test.67-nova)" -1
ok "数值序 test.9 < test.70"        "$(ver_cmp 0.7.0-test.9 0.7.0-test.70)" -1
ok "跨大版本 0.6.3 < 0.7.0-test.1"  "$(ver_cmp 0.6.3 0.7.0-test.1)" -1
ok "主版本段 0.10.0 > 0.9.0"        "$(ver_cmp 0.10.0 0.9.0)" 1
ok "形状闸拒垃圾串"                 "$(ver_shape_ok '0.7.0-test.67!!' && echo yes || echo no)" no
ok "形状闸（nova 感知）过 nova 串"   "$(shape_of '0.7.0-test.67-nova' && echo yes || echo no)" yes
ok "形状闸（nova 感知）拒嵌套 nova"  "$(shape_of '0.7.0-a-nova-nova' && echo yes || echo no)" no

# ---------- 表测：KV 指针版本提取 ----------
ok "exe disposition 提取（%20 编码头）" \
  "$(disp_ver_of 'attachment; filename="CC%20Deck_0.6.0-snap.2_x64-setup.exe"; filename*=UTF-8'"'"'CC%20Deck_0.6.0-snap.2_x64-setup.exe')" \
  "0.6.0-snap.2"
ok "exe disposition 非匹配→空"      "$(disp_ver_of 'attachment; filename="other.bin"')" ""
ok "exe 无头→空"                    "$(disp_ver_of "")" ""
ok "apk 302 location 提取"          "$(loc_ver_of 'http://8.133.211.170:8888/cc-deck-0.6.0-snap.9.apk')" "0.6.0-snap.9"
ok "apk 回落稳定名→snap-latest"     "$(loc_ver_of 'http://8.133.211.170:8888/cc-deck-snap-latest.apk')" "snap-latest"
ok "apk 非匹配→空"                 "$(loc_ver_of 'http://x/whatever')" ""

# ---------- 集成测：假 git repo + 假 KV server 四态 ----------
FAKE_GIT="$(mktemp -d /tmp/rs-git.XXXXXX)"
STATE="$(mktemp -d /tmp/rs-state.XXXXXX)"
REPORT="$(mktemp /tmp/rs-report.XXXXXX)"
SRV="$(mktemp /tmp/rs-srv.XXXXXX)"
PORT=$(( (RANDOM % 2000) + 18000 ))
cleanup(){ kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; rm -rf "$FAKE_GIT" "$STATE" "$FUNCS" "$SRV" "$REPORT"; }
trap cleanup EXIT

git -C "$FAKE_GIT" init -q
git -C "$FAKE_GIT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# 干扰 tag test.9 证明择最大走数值序（字典序会错选 test.9）
for t in v0.7.0-test.9 v0.7.0-test.70-nova v0.6.0-snap.9; do git -C "$FAKE_GIT" tag "$t"; done
GIT_TEST_MAX="$( { source "$FUNCS"; REPO_DIR="$FAKE_GIT"
  max() { local best="" t v; while IFS= read -r t; do [ -n "$t" ] || continue; v="${t#v}"
    shape_of "$v" || continue
    if [ -z "$best" ] || [ "$(ver_cmp "$v" "$best")" = "1" ]; then best="$v"; fi
  done < <(git -C "$REPO_DIR" tag -l "$1" 2>/dev/null); echo "$best"; }
  max 'v*-test*'; } )"
ok "集成·假仓择最大 test tag（数值序越过 test.9）" "$GIT_TEST_MAX" "0.7.0-test.70-nova"

# 假 KV server：路径→动态读状态目录（切态=改文件）；起服前先写态1 状态（探活请求
# 早于状态文件会 FileNotFoundError 崩 handler——server 是单线程的，崩一个连接即死）
printf '{"version":"0.7.0-test.70-nova","pub_date":"t","platforms":{}}' > "$STATE/manifest.json"
echo "0.6.0-snap.9" > "$STATE/snap-exe-ver.txt"
echo "0.6.0-snap.9" > "$STATE/snap-apk-ver.txt"
cat > "$SRV" <<PYEOF
import http.server, os
STATE = "$STATE"
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _snap_exe(self):
        ver = open(os.path.join(STATE, "snap-exe-ver.txt")).read().strip()
        fn = ("CC Deck_%s_x64-setup.exe" % ver).replace(" ", "%20")
        return ("attachment; filename=\"%s\"" % fn).encode()
    def _route(self):
        p = self.path
        if p == "/download/tauri-latest-test.json":
            body = open(os.path.join(STATE, "manifest.json"), "rb").read()
            return 200, [("content-type", "application/json")], body
        if p == "/dl/cc-deck-snap-latest-setup.exe":
            return 200, [("content-disposition", self._snap_exe())], b""
        if p == "/dl/cc-deck-snap-latest.apk":
            ver = open(os.path.join(STATE, "snap-apk-ver.txt")).read().strip()
            return 302, [("location", "http://8.133.211.170:8888/cc-deck-%s.apk" % ver)], b""
        return 404, [], b"nf"
    def do_HEAD(self):
        code, heads, _ = self._route()
        self.send_response(code)
        for k, v in heads: self.send_header(k, v)
        self.end_headers()
    def do_GET(self):
        code, heads, body = self._route()
        self.send_response(code)
        for k, v in heads: self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", $PORT), H).serve_forever()
PYEOF
/usr/bin/python3 "$SRV" & SRV_PID=$!
for i in $(seq 1 20); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/download/tauri-latest-test.json" 2>/dev/null && break
  sleep 0.2
done

run_check(){ # 跑正本 → 输出捕获全局 OUT/RC
  OUT="$(CCR_SUPPLY_NOTIFY=0 CCR_SUPPLY_KV_BASE="http://127.0.0.1:$PORT" \
    CCR_SUPPLY_REPO_DIR="$FAKE_GIT" CCR_SUPPLY_REPORT="$REPORT" bash "$SRC" 2>&1)"; RC=$?
}

# 态1 全绿（状态已在起服前写入）
run_check
ok "集成·态1 全绿 rc=0" "$RC" 0
echo "$OUT" | grep -q "test 桌面清单 = 最新 tag（0.7.0-test.70-nova）" \
  && ok "集成·态1 test-kv 绿行" 0 0 || ok "集成·态1 test-kv 绿行" 1 0
grep -q "supply: test-kv=0.7.0-test.70-nova snap=0.6.0-snap.9/0.6.0-snap.9" "$REPORT" \
  && ok "集成·态1 patrol-report 行格式" 0 0 || { ok "集成·态1 patrol-report 行格式" 1 0; tail -2 "$REPORT"; }

# 态2 test-kv 断供（KV 停旧版）
printf '{"version":"0.7.0-test.67-nova","pub_date":"t","platforms":{}}' > "$STATE/manifest.json"
run_check
ok "集成·态2 断供 rc=1" "$RC" 1
echo "$OUT" | grep -q "断供：KV 清单停 0.7.0-test.67-nova，最新 tag 0.7.0-test.70-nova" \
  && ok "集成·态2 断供文案含差值对" 0 0 || ok "集成·态2 断供文案含差值对" 1 0
echo "$OUT" | grep -q "行动：scripts/build-test-desktop.sh 0.7.0-test.70-nova" \
  && ok "集成·态2 行动出口=build-test-desktop.sh <ver>" 0 0 || ok "集成·态2 行动出口=build-test-desktop.sh <ver>" 1 0

# 态3 快照 exe 指针漂移（manifest 恢复一致）
printf '{"version":"0.7.0-test.70-nova","pub_date":"t","platforms":{}}' > "$STATE/manifest.json"
echo "0.6.0-snap.2" > "$STATE/snap-exe-ver.txt"
run_check
ok "集成·态3 快照漂移 rc=1" "$RC" 1
echo "$OUT" | grep -q "快照exe指针漂移：指向 0.6.0-snap.2，最新 snapshot tag 0.6.0-snap.9" \
  && ok "集成·态3 漂移文案含两版本" 0 0 || ok "集成·态3 漂移文案含两版本" 1 0
echo "$OUT" | grep -q "行动：scripts/update-snap-dist.sh v0.6.0-snap.9" \
  && ok "集成·态3 行动出口=update-snap-dist.sh v<ver>" 0 0 || ok "集成·态3 行动出口=update-snap-dist.sh v<ver>" 1 0

# 态4 apk 302 回落稳定名（snap-latest-version 指针缺失）
echo "0.6.0-snap.9" > "$STATE/snap-exe-ver.txt"
echo "snap-latest" > "$STATE/snap-apk-ver.txt"
run_check
ok "集成·态4 指针回落 rc=1" "$RC" 1
echo "$OUT" | grep -q "仍指旧稳定名（snap-latest-version 指针缺失，302 回落）" \
  && ok "集成·态4 回落识别文案" 0 0 || ok "集成·态4 回落识别文案" 1 0

# 态5 KV 不可达（fail-closed 不静默吞）
run_unreachable(){ OUT="$(CCR_SUPPLY_NOTIFY=0 CCR_SUPPLY_KV_BASE="http://127.0.0.1:1" \
  CCR_SUPPLY_REPO_DIR="$FAKE_GIT" CCR_SUPPLY_REPORT="$REPORT" bash "$SRC" 2>&1)"; RC=$?; }
run_unreachable
ok "集成·态5 KV 不可达 rc=1（fail-closed）" "$RC" 1
echo "$OUT" | grep -q "读不到/无 version 字段" \
  && ok "集成·态5 不可达告警非静默" 0 0 || ok "集成·态5 不可达告警非静默" 1 0

echo; echo "RELEASE-SUPPLY 测试: $pass passed, $fail failed"; [ "$fail" = 0 ]
