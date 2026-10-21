#!/usr/bin/env node
// W-CHAIN2 #199 A：Stop 外报钩子——会话每回合收口即时上报 relay /api/turn-report。
// 动机（#199 链路强化）：PM 停帧唤醒此前依赖 relay 侧 feedPM 边沿（托管 onTurnEnd /
// external finishExternal），relay 重启窗/帧丢失窗=PM 感知盲区；Stop 钩子在 CLI 本体
// 收口时刻直报（转录为证），是「CLI 说自己停了」的第一方信号。
// 设计：
//   - CCR_RELAY_CHILD=1 跳过（relay 自养孙进程/嵌套 spawn 防自环）
//   - 幂等：transcript 尾部最后 uuid（无 uuid 退化 mtime+size 指纹）——同一回合尾多次
//     Stop（拦截重试/60s 二次停止）不重报；relay 侧还有 sid+60s 去重双保险
//   - 失败静默 + 落 spool ~/.cc-deck/data/turn-spool/<sid>.jsonl（append-only，relay
//     启动 drain——C 组），绝不阻断 Stop 主路径（钩子超时/报错=收工体验受损）
//   - 与 task-stop.mjs 的关系：settings.json Stop 数组 turn-report 在前（每次必报）；
//     task-stop 自身也在 3min 豁免判定前调用 reportTurn（P0-1：豁免只豁拦截不豁外报）
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RELAY = process.env.CCR_RELAY_URL || "http://127.0.0.1:8787";
const SPOOL_DIR = join(homedir(), ".cc-deck", "data", "turn-spool");
const STATE_DIR = join(homedir(), ".claude", "hooks", ".state");

/** 读 stdin JSON（hook 输入契约） */
export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

/** transcript 尾窗（8KB）提取最后 uuid（幂等键）；无 uuid 退化 mtime+size 指纹 */
function transcriptKey(transcriptPath) {
  try {
    const st = statSync(transcriptPath);
    const size = Math.min(8192, st.size);
    const fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    const tail = buf.toString("utf-8");
    const uuids = tail.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    return { key: uuids && uuids.length ? uuids[uuids.length - 1].toLowerCase() : `fp-${st.size}-${st.mtimeMs}`, size: st.size };
  } catch { return null; }
}

/**
 * 外报主函数（task-stop.mjs 复用同入口——P0-1）。
 * fire-and-forget 语义：本函数从不 throw；调用方无需 await（返回 promise 自吞）。
 */
export function reportTurn(input) {
  if (process.env.CCR_RELAY_CHILD === "1") return Promise.resolve(false);
  const sid = String(input?.session_id ?? "");
  const tr = String(input?.transcript_path ?? "");
  if (!sid || !tr || !existsSync(tr)) return Promise.resolve(false);
  const k = transcriptKey(tr);
  if (!k) return Promise.resolve(false);
  // 钩子侧幂等：同 sid 同 key 60s 内已报过即跳（STATE 记账）
  const stamp = join(STATE_DIR, `turn-report-${sid.replace(/[^a-zA-Z0-9-]/g, "")}.json`);
  try {
    const prev = JSON.parse(readFileSync(stamp, "utf-8"));
    if (prev.key === k.key && Date.now() - prev.at < 60_000) return Promise.resolve(false);
  } catch {}
  const payload = JSON.stringify({ sid, key: k.key, transcript_size: k.size, at: Date.now() });
  const spoolOne = () => { try { mkdirSync(SPOOL_DIR, { recursive: true }); appendFileSync(join(SPOOL_DIR, `${sid.replace(/[^a-zA-Z0-9-]/g, "")}.jsonl`), payload + "\n"); } catch {} };
  return fetch(`${RELAY}/api/turn-report`, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(2500) })
    .then(async (r) => {
      if (!r.ok) spoolOne();
      else { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(stamp, JSON.stringify({ key: k.key, at: Date.now() })); } catch {} }
      return r.ok;
    })
    .catch(() => { spoolOne(); return false; });
}

// 独立直跑（settings.json Stop 挂载形态）：读 stdin → 外报 → exit 0（永不 block）
if (process.argv[1] && process.argv[1].endsWith("turn-report.mjs")) {
  const input = await readStdin();
  await reportTurn(input);
  process.exit(0);
}
