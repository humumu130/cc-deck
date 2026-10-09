import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// 模板 = cc-plugins/plugins/cc-deck/bin/deliver 逐字节同源（test-orphan-deliver 有
// 恒等断言锁同步——改插件 bin 必须同步重生成这里，反之亦然。转义由
// /tmp/worph/gen-deliver-bin.mjs 处理，模板段请勿手改）
export const DELIVER_BIN_TEMPLATE = `#!/bin/bash
# 交付物原地登记（2026-09-19 意图声明制，#71 起随插件分发）：文件写在本该在的地方，
# 本脚本只把路径登记到 cc-deck 看板（POST /api/deliver）。
# 用法：deliver [--session <id>] <文件路径>（相对路径按当前目录补全）
#   --session 显式会话归因，优先于 env 三级链（跨会话代登记/修正归因用）
# guard-context 开关开启时自动同步到 ~/.cc-deck/bin/。
#
# 环境注入链（#018-C1 文档化，与 bin/dispatch 同一口径）：M2 会话由 relay spawn 时
# 继承注入 CCR_DATA_DIR/CCR_TOKEN/CCR_PORT 三件套（relay/src/org.ts F-09 CLI 模板
# 同源）；手动终端无注入时逐级回落生产默认：
#   CCR_DATA_DIR  relay 数据目录（默认 ~/.cc-deck/data）
#   CCR_TOKEN     relay 令牌（缺省读 $CCR_DATA_DIR/token）
#   CCR_PORT      relay 端口（缺省读 $CCR_DATA_DIR/bridge.json 的 port，再缺省 8787）
#   CCR_TIMEOUT   curl 单请求秒数（默认 15）
# 会话归因（#227 根治挂错会话）：--session 显式参数 > CC_DECK_SESSION_ID（hook/
# deliver-guard 透传）> CLAUDE_CODE_SESSION_ID（Claude Code Bash 子进程注入）>
# CLAUDE_SESSION_ID；全缺时 stderr 警告（relay 回落 cwd 启发式，同仓库并行会话
# 可能挂错卡），不静默空值归因。
# 三 ID 对账日志（#018 :653 DoD）：每拍 stderr 单行 JSON（phase=send/ack/final，
# 恒含 session_id/dispatch_id/command_id——HTTP 直投无命令信封，command_id 恒 null），
# grep '"dispatch_id":"<id>"' 可对账；权威账 $CCR_DATA_DIR/cli-dispatches.ndjson。
set -uo pipefail
usage() {
  echo "用法: deliver [--session <id>] <文件路径>" >&2
  exit 1
}
sid_arg=""
f=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      [ $# -ge 2 ] || usage
      sid_arg="$2"; shift 2 ;;
    --session=*)
      sid_arg="\${1#--session=}"; shift ;;
    -h|--help) usage ;;
    --*) echo "deliver：未知参数 $1" >&2; usage ;;
    *)
      [ -z "$f" ] || { echo "deliver：多余参数 $1" >&2; usage; }
      f="$1"; shift ;;
  esac
done
[ -z "$f" ] && usage
# 相对路径 → 绝对
case "$f" in /*) ;; *) f="$PWD/$f";; esac
# 会话身份：显式 --session 优先，env 三级链兜底（见头注归因链）
sid="\${sid_arg:-\${CC_DECK_SESSION_ID:-\${CLAUDE_CODE_SESSION_ID:-\${CLAUDE_SESSION_ID:-}}}}"
[ -n "$sid" ] || echo "警告：session_id 全缺（--session 未给且 CC_DECK_SESSION_ID/CLAUDE_CODE_SESSION_ID/CLAUDE_SESSION_ID 均空）——本次登记不携带会话归因，relay 回落 cwd 启发式，同仓库并行会话可能挂错卡" >&2
# 寻址 env 优先序（#36 M2 并行版，2026-10-03，F-09 org CLI 同款）：CCR_DATA_DIR/
# CCR_TOKEN/CCR_PORT 缺省回落生产路径。M2 会话由 relay spawn 继承 env 自动路由到
# 8788 实例；生产无 env 时逐字节同行为
data="\${CCR_DATA_DIR:-$HOME/.cc-deck/data}"
token="\${CCR_TOKEN:-$(cat "$data/token" 2>/dev/null || true)}"
# 端口以 relay 自报为准（bridge.json），缺省回落默认 8787
port="\${CCR_PORT:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$data/bridge.json" 2>/dev/null || true)}"
: "\${port:=8787}"
# 单请求超时秒数（CCR_TIMEOUT 可调，默认 15；非数字/过小收敛）
timeout="\${CCR_TIMEOUT:-15}"
case "$timeout" in ""|*[!0-9]*) timeout=15 ;; esac
[ "$timeout" -ge 1 ] || timeout=15
body="$(python3 - "$f" "$PWD" "$sid" <<'PY'
import json, sys
sid = sys.argv[3].strip() if len(sys.argv) > 3 else ""
d = {"path": sys.argv[1], "cwd": sys.argv[2]}
if sid:
    d["session_id"] = sid
print(json.dumps(d, ensure_ascii=False))
PY
)"

dispatch_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
log="$data/cli-dispatches.ndjson"
# phase 过程账（#018-C2）：与 dispatch 同账同构，与终态台账分账（台账不变量
# 「append-only 终态一行」不被中间拍污染）；dispatch-report --phase 消费
phase_log_file="$data/cli-phase.ndjson"
mkdir -p "$data"
# 三 ID 每拍日志（stderr 单行 JSON）：HTTP 直投无命令信封，command_id 恒 null——
# 字段位保留与 dispatch 日志同构，PM 侧对账 grep 一套键。同行落盘 phase 过程账
phase_log() { # $1=phase $2=ok(true|false|null) $3=error（须已消毒）
  local line
  line="$(python3 - "$sid" "$dispatch_id" "$1" "$2" "$3" <<'PY'
import json, sys
from datetime import datetime, timezone
sid, did, phase, ok, error = sys.argv[1:6]
print(json.dumps({
    "tool": "deliver", "phase": phase,
    "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "session_id": sid, "dispatch_id": did, "command_id": None,
    "attempt": 1,
    "ok": None if ok == "null" else ok == "true",
    "error": error or None,
}, ensure_ascii=False, separators=(",", ":")))
PY
)" || return 0
  printf '%s\\n' "$line" >&2
  printf '%s\\n' "$line" >> "$phase_log_file" 2>/dev/null \\
    || echo "deliver：phase 过程账写入失败（$phase_log_file），stderr 日志仍可 grep 对账" >&2
}
append_log() {
  python3 - "$log" "$sid" "$dispatch_id" "$1" "$2" "$3" <<'PY'
import json, sys
from datetime import datetime, timezone
path, sid, dispatch_id, command_id, ok, error = sys.argv[1:]
record = {
    "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "session_id": sid,
    "dispatch_id": dispatch_id,
    "command_id": command_id or None,
    "type": "DELIVER",
    "ok": ok == "true",
    "error": error or None,
}
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\\n")
PY
}
fail() {
  msg="$1"
  echo "deliver 失败：$msg；请确认 relay 在线后重试，未静默丢单。" >&2
  phase_log final false "$msg"
  append_log "" "false" "$msg" || echo "deliver 审计写入失败：$log" >&2
  exit 1
}
[ -n "$token" ] || fail "未找到 relay token（$data/token，relay 未初始化？）"

tmp="$(mktemp "\${TMPDIR:-/tmp}/cc-deck-deliver.XXXXXX")"
errfile="\${tmp}.err"
trap 'rm -f "$tmp" "$errfile"' EXIT
phase_log send null ""
curl_rc=0
curl -sS --max-time "$timeout" -X POST "http://127.0.0.1:\${port}/api/deliver?token=\${token}" \\
  -H 'content-type: application/json' --data-binary "$body" -o "$tmp" -w '%{http_code}' >"\${tmp}.status" 2>"$errfile" || curl_rc=$?
if [ "$curl_rc" -ne 0 ]; then
  rm -f "\${tmp}.status"
  # 可判定错误文案（curl 退出码映射）：7=连接拒绝 / 28=超时 / 其余=网络错误——
  # 三类都保留「无法连接 relay」前缀，与对账 TIMEOUT_CLASS 子串咬合
  case "$curl_rc" in
    7) fail "无法连接 relay（连接拒绝：127.0.0.1:\${port} 无监听）" ;;
    28) fail "无法连接 relay（超时：\${timeout}s 无响应，CCR_TIMEOUT 可调）" ;;
    *) fail "无法连接 relay（网络错误：curl exit $curl_rc）" ;;
  esac
fi
status="$(cat "\${tmp}.status")"
rm -f "\${tmp}.status"
[ "$status" = "200" ] || fail "relay 返回 HTTP $status"
# ACK ok:true 严判两分：ok:false=relay 明确拒收（error 透传）vs body 无效（非 JSON/
# 缺 ok）——两类都非零退出，文案可判定不混淆
ack_class="$(python3 - "$tmp" "$token" <<'PY'
import json, sys
token = sys.argv[2]
try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("invalid")
    raise SystemExit
if value.get("ok") is True:
    print("ok")
elif value.get("ok") is False:
    print("reject")
    print(str(value.get("error") or "ACK ok 非 true").replace(token, "[redacted]"))
else:
    print("invalid")
PY
)"
ack="$(printf '%s\\n' "$ack_class" | head -1)"
case "$ack" in
  ok) ;;
  reject)
    ack_err="$(printf '%s\\n' "$ack_class" | tail -1)"
    phase_log ack false "$ack_err"
    fail "relay ACK body 拒收（ok:false）：$ack_err"
    ;;
  *)
    phase_log ack false "relay ACK body 无效（非 JSON/缺 ok 布尔）"
    fail "relay ACK body 无效（非 JSON/缺 ok 布尔）"
    ;;
esac
phase_log ack true ""
cat "$tmp"
phase_log final true ""
append_log "" "true" "" || echo "deliver 审计写入失败：$log" >&2
`;
// 仅缺失时创建（bootstrap 语义，非 ensureOrgCli 的内容比对升级）：deliver 脚本有
// 两个写入方——插件的 guard-context hook（deliverables 开时读比较覆盖，升级归它管）
// 与本兜底。relay 永不覆盖已存在文件：插件新版/用户自改一律尊重；无插件机器上
// 旧模板继续可用（脚本职责就是一次 POST，老版本不失效）。CCR_DELIVER_BIN_DIR 显式
// 改落点（测试隔离）。失败静默返回 failed——丢了可重启补，不影响启动
export function ensureDeliverBin(): "written" | "exists" | "foreign" | "failed" {
  const target = process.env.CCR_DELIVER_BIN_DIR ?? join(homedir(), ".cc-deck", "bin", "deliver");
  try {
    if (existsSync(target)) {
      return readFileSync(target, "utf-8") === DELIVER_BIN_TEMPLATE ? "exists" : "foreign";
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, DELIVER_BIN_TEMPLATE, "utf-8");
    chmodSync(target, 0o755);
    return "written";
  } catch (e) {
    console.warn(`[deliver-bin] 落位失败: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
