#!/usr/bin/env bash
# DEV-43 / P0-3：patrol-standalone v3 回归——四段（hermetic：真生产零触碰）：
#   Z0 语法闸 + v3 关键面在位（push_phone/心跳/云桥三级解析）
#   H1 心跳可见位：真跑一拍（沙盒 DATA_DIR）→ patrol-heartbeat.json 落盘且 ts 新鲜
#   P1 云桥推送腿：PATROL_BRIDGE_URL 指本地桩 HTTP 服务 → 断档路径（RELAY_URL 死端口
#      × CONFIRM_ROUNDS=1）→ 桩收到 POST /alert（Authorization/目标 dev/载荷四断言）
#      + 报告行 push[dev]:ok 落账
#   R1 断档双拍确认语义不变：CONFIRM_ROUNDS=2 时首拍只记不打（桩零请求）
# 直跑：bash scripts/test-patrol-standalone.sh
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
PS=scripts/patrol-standalone.sh
SB="$(mktemp -d /tmp/patrol-v3-test.XXXXXX)"
trap 'rm -rf "$SB"' EXIT

echo "Z0 语法闸："
bash -n $PS && ok "Z0-1 bash -n 过" || bad "Z0-1 语法错"
grep -q "push_phone()" $PS && ok "Z0-2 v3 云桥推送腿在位" || bad "Z0-2 push_phone 缺"
grep -q "patrol-heartbeat.json" $PS && ok "Z0-3 心跳可见位在位" || bad "Z0-3 心跳写缺"
grep -q "PATROL_PUSH_TO" $PS && ok "Z0-4 推送目标 env 覆盖口在位" || bad "Z0-4 PATROL_PUSH_TO 缺"

echo "H1 心跳可见位（真跑一拍，沙盒）："
env -i PATH=/usr/bin:/bin HOME="$SB/home" \
  PATROL_DATA_DIR="$SB/data" PATROL_REPORT="$SB/report.md" \
  bash $PS >/dev/null 2>&1
HB="$SB/data/patrol-heartbeat.json"
if [ -s "$HB" ]; then
  python3 -c "
import json,sys,time
hb=json.load(open('$HB'))
assert isinstance(hb.get('ts'),int) and abs(time.time()-hb['ts'])<60, 'ts 不新鲜: %r'%hb
assert 'relay' in hb and 'disk' in hb and 'interval_ms' in hb
" && ok "H1-1 心跳落盘且 ts 新鲜（含 relay/disk/interval_ms）" || bad "H1-1 心跳文件缺失或字段不对：$(cat "$HB" 2>/dev/null || echo 无)"
else
  bad "H1-1 心跳文件未落盘（$HB）"
fi

echo "P1 云桥推送腿（本地桩桥 + 断档路径）："
# 桩桥：收 POST /alert → 断言头/载荷 → 回 {ok:true,delivered:true}
cat > "$SB/stub-bridge.py" <<'PYEOF'
import json, http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        auth = self.headers.get("authorization") or ""
        rec = {"path": self.path, "auth": auth, "body": body}
        with open(sys.argv[2], "a") as f: f.write(json.dumps(rec) + "\n")
        out = json.dumps({"ok": True, "delivered": True}).encode()
        self.send_response(200); self.send_header("content-type","application/json")
        self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYEOF
RECEIVED="$SB/received.ndjson"
python3 "$SB/stub-bridge.py" 18731 "$RECEIVED" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
mkdir -p "$SB/data"
printf '{"ph-deadbeef0011":{"pubkey":"x","last_seen":9},"wb-ignored":{"pubkey":"y"}}' > "$SB/data/cloud-peers.json"
echo "test-token-xyz" > "$SB/data/cloud-token"

env -i PATH=/usr/bin:/bin HOME="$SB/home" \
  PATROL_DATA_DIR="$SB/data" PATROL_REPORT="$SB/report2.md" \
  PATROL_RELAY_URL="http://127.0.0.1:9/" PATROL_CONFIRM_ROUNDS=1 \
  PATROL_BRIDGE_URL="http://127.0.0.1:18731/alert" \
  PATROL_NOTIFY="true" \
  bash $PS >/dev/null 2>&1

sleep 0.3
if [ -s "$RECEIVED" ]; then
  python3 - "$RECEIVED" <<'PYEOF'
import json, sys
rec = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
assert rec["path"] == "/alert", rec["path"]
assert rec["auth"] == "Bearer test-token-xyz", rec["auth"]
b = rec["body"]
assert b["to"] == "ph-deadbeef0011", b
assert b["level"] == "critical" and "relay" in b["title"] and b["title"], b
assert "HTTP=" in b["body"], b
PYEOF
  [ $? -eq 0 ] && ok "P1-1 桩桥收到 /alert：Bearer token/cloud-token 文件解析/目标=ph-*（wb-* 排除）/载荷含断档详情" || bad "P1-1 桩桥请求断言失败：$(cat "$RECEIVED")"
  grep -q "push\[ph-deadbeef0011\]:ok" "$SB/report2.md" && ok "P1-2 报告行落回执 push[dev]:ok" || bad "P1-2 报告缺 push 回执行：$(tail -5 "$SB/report2.md" 2>/dev/null)"
else
  bad "P1-1 桩桥未收到任何请求（推送腿未走通）"
fi
kill $STUB_PID 2>/dev/null || true

echo "R1 双拍确认语义（CONFIRM_ROUNDS=2 首拍不打；独立 DATA_DIR 防 P1 状态串场）："
RECEIVED2="$SB/received2.ndjson"
python3 "$SB/stub-bridge.py" 18732 "$RECEIVED2" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
mkdir -p "$SB/data-r1"
env -i PATH=/usr/bin:/bin HOME="$SB/home" \
  PATROL_DATA_DIR="$SB/data-r1" PATROL_REPORT="$SB/report3.md" \
  PATROL_RELAY_URL="http://127.0.0.1:9/" PATROL_CONFIRM_ROUNDS=2 \
  PATROL_BRIDGE_URL="http://127.0.0.1:18732/alert" \
  PATROL_NOTIFY="true" \
  bash $PS >/dev/null 2>&1
sleep 0.3
if [ -s "$RECEIVED2" ]; then bad "R1-1 双拍确认被破（首拍即推送）"; else ok "R1-1 首拍只记账不推送（桩零请求）"; fi
grep -qE "连续失败 [0-9]+ 拍" "$SB/report3.md" && ok "R1-2 报告记连续失败拍数" || bad "R1-2 报告缺连续失败行"
kill $STUB_PID 2>/dev/null || true

echo ""
echo "patrol-standalone v3: $pass ok / $fail FAIL"
[ $fail -eq 0 ]
