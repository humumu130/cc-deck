// #79 输出物远程拉取 · ws 传输层 E2E（起真实 relay 子进程 + 真实 ws 客户端）：
// 单元测试（test-artifact-fetch.ts）覆盖 bus 层语义；这里补传输层——emitTransient
// 帧经 ws-server 广播、ACK 路由、帧序（数据+done 先于 ACK，客户端双条件收口的依据）。
// 断言：SNAPSHOT 会话可见 / 已登记路径拉取重组一致 / ack.artifact mime+size /
// 帧序 done 先于 ack / 未登记路径拒绝 / 跨会话登记拒绝 / 幂等重放不重发数据 /
// 分块定向投递（旁观连接零泄漏）。
// 运行：node scripts/e2e-artifact-ws.mjs（先 node /tmp/build-relay67.mjs 出 /tmp/relay67.mjs）
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = 18899;
const TOKEN = "e2e79tok";
const ROOT = "/tmp/ccr-e2e79";
const PROJ = `${ROOT}/proj`;
const RELAY = process.argv[2] ?? "/tmp/relay67.mjs";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };

// 夹具：两个会话目录、一份 1.3MB 登记产物（3 块）、一份他方会话机密、一份最小转录
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(PROJ, { recursive: true });
mkdirSync(`${ROOT}/proj2`, { recursive: true });
const BODY = "# 夜间报告\n\n端到端验证正文。".repeat(40_000); // ~1.3MB → 3 块
const ART = `${PROJ}/夜间报告.md`;
writeFileSync(ART, BODY, "utf-8");
const SECRET = `${ROOT}/proj2/机密.txt`;
writeFileSync(SECRET, "不该被跨会话拉取", "utf-8");
const TS = `${ROOT}/transcript.jsonl`;
writeFileSync(TS, JSON.stringify({ type: "user", message: { role: "user", content: "e2e" }, timestamp: new Date().toISOString() }) + "\n");

// 起 relay（云桥/自动恢复/标题生成全关，数据目录隔离）
const child = spawn(process.execPath, [RELAY], {
  env: {
    ...process.env,
    CCR_PORT: String(PORT),
    CCR_TOKEN: TOKEN,
    CCR_DATA_DIR: `${ROOT}/datadir`,
    CCR_CLOUD_URL: "",
    CCR_NO_AUTOREVIVE: "1",
    CCR_NO_TITLE_GEN: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
child.stdout.on("data", (d) => { relayLog += d; });
child.stderr.on("data", (d) => { relayLog += d; });
const shutdown = (code) => {
  child.kill("SIGKILL");
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nWS E2E ARTIFACT FETCH: ${pass} pass / ${fail} fail`);
  if (code && relayLog) console.log("---- relay log tail ----\n" + relayLog.slice(-1200));
  process.exit(code);
};
process.on("exit", () => child.kill("SIGKILL"));

// 等端口就绪
let up = false;
for (let i = 0; i < 60; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/nacl.js`); up = true; break; } catch { await sleep(250); }
}
if (!up) { console.log("relay 未就绪\n" + relayLog.slice(-1500)); shutdown(1); }

const bridgeToken = readFileSync(`${ROOT}/datadir/bridge-token`, "utf-8").trim();
const post = async (path, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// 两个外部会话（hooks 桥接建卡）+ 各自登记一份产物
const hook = (sid, cwd) => post("/bridge/hook", { event: "UserPromptSubmit", session_id: sid, cwd, prompt: "e2e", transcript_path: TS, cli_pid: process.pid }, { "x-bridge-token": bridgeToken });
ok((await hook("cli-e2e79a", PROJ)).status === 200, "bridge hook 建会话 a");
ok((await hook("cli-e2e79b", `${ROOT}/proj2`)).status === 200, "bridge hook 建会话 b");
ok((await post(`/api/deliver?token=${TOKEN}`, { path: ART, cwd: PROJ })).json?.ok === true, "deliver 登记产物 a");
ok((await post(`/api/deliver?token=${TOKEN}`, { path: SECRET, cwd: `${ROOT}/proj2` })).json?.ok === true, "deliver 登记产物 b");

// ws 客户端：收 SNAPSHOT 后发起拉取
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}&last_seq=0`);
const frames = [];
const acks = new Map();
const pending = [];
const nextFrame = (pred, ms = 8000) => new Promise((resolve) => {
  const hit = frames.find(pred);
  if (hit) return resolve(hit);
  const w = { pred, resolve, t: setTimeout(() => { const i = pending.indexOf(w); if (i >= 0) pending.splice(i, 1); resolve(null); }, ms) };
  pending.push(w);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "COMMAND_ACK") acks.set(m.command_id, m);
  frames.push(m);
  for (let i = pending.length - 1; i >= 0; i--) {
    const f = frames.find(pending[i].pred);
    if (f) {
      const { t, resolve } = pending[i];
      clearTimeout(t);
      pending.splice(i, 1);
      resolve(f);
    }
  }
});
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
await nextFrame((m) => m.type === "SNAPSHOT", 6000);
ok(frames.some((m) => m.type === "SNAPSHOT" && m.payload?.sessions?.some((s) => s.session_id === "ext-cli-e2e79a" && s.artifacts?.some((a) => a.path === ART))), "SNAPSHOT 含会话与已登记产物");

const send = (cmd) => ws.send(JSON.stringify(cmd));
const cmd = (command_id, sid, path) => ({ command_id, type: "COMMAND_ARTIFACT_FETCH", payload: { session_id: sid, path }, ts: Date.now() });

// 旁观者客户端（S6 定向投递取证）：同 relay 第二条 ws，全程不应收到任何 ARTIFACT_CHUNK
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}&last_seq=0`);
const frames2 = [];
ws2.on("message", (raw) => frames2.push(JSON.parse(raw.toString())));
await new Promise((r, j) => { ws2.once("open", r); ws2.once("error", j); });
// 等它的 SNAPSHOT 落地（连接即推；之后收到的任何 ARTIFACT_CHUNK 都是广播泄漏）
await new Promise((resolve) => {
  if (frames2.some((m) => m.type === "SNAPSHOT")) return resolve();
  const h = () => { if (frames2.some((m) => m.type === "SNAPSHOT")) { clearTimeout(t); ws2.off("message", h); resolve(); } };
  const t = setTimeout(() => { ws2.off("message", h); resolve(); }, 6000);
  ws2.on("message", h);
});

// S1 已登记路径：帧齐、重组一致、ack.artifact、帧序（done 先于 ack）
// 期望块数按 512KiB/块动态算（fixtures 改体积不必同步改断言）
send(cmd("e2e-1", "ext-cli-e2e79a", ART));
await nextFrame((m) => m.type === "COMMAND_ACK" && m.command_id === "e2e-1");
{
  const TOTAL = Math.ceil(Buffer.byteLength(BODY) / (512 * 1024));
  const data = frames.filter((m) => m.type === "ARTIFACT_CHUNK" && m.payload?.ref === "e2e-1" && typeof m.payload?.seq === "number");
  const tail = frames.find((m) => m.type === "ARTIFACT_CHUNK" && m.payload?.ref === "e2e-1" && m.payload?.done === true);
  const ack = acks.get("e2e-1");
  ok(data.length === TOTAL && data[0].payload.total === TOTAL, `S1 数据帧 ${TOTAL} 块 got=${data.length}`);
  ok(!!tail, "S1 done 尾帧到达");
  ok(ack?.ok === true && ack?.artifact?.size === Buffer.byteLength(BODY) && ack?.artifact?.mime === "text/markdown", `S1 ack.artifact size/mime got=${JSON.stringify(ack?.artifact)}`);
  const seqOrder = data.map((m) => m.payload.seq);
  const parts = [];
  data.forEach((m) => { parts[m.payload.seq] = m.payload.b64; });
  const body = Buffer.concat(parts.map((b) => Buffer.from(b, "base64")));
  ok(body.toString("utf-8") === BODY, `S1 按 seq 重组一致（${body.length}B，帧序 ${seqOrder}）`);
  // 帧序取证：done 与 ack 到达顺序（relay 先 emit 数据后回 ack——客户端双条件收口的依据）
  const doneAt = frames.indexOf(tail);
  const ackAt = frames.findIndex((m) => m === ack || (m.type === "COMMAND_ACK" && m.command_id === "e2e-1"));
  ok(doneAt >= 0 && ackAt >= 0 && doneAt < ackAt, `S1 帧序 done(${doneAt}) 先于 ack(${ackAt})`);
}

// S2 未登记路径拒绝（错误必须是授权语义——allowlist 漏登的 invalid shape 不许混过）
send(cmd("e2e-2", "ext-cli-e2e79a", `${PROJ}/未登记.md`));
await nextFrame((m) => m.type === "COMMAND_ACK" && m.command_id === "e2e-2");
ok(acks.get("e2e-2")?.ok === false && /无权拉取/.test(acks.get("e2e-2")?.error ?? ""), "S2 未登记路径拒绝");

// S3 跨会话登记拒绝（b 的机密不能从 a 拉；同样校验非 invalid shape）
send(cmd("e2e-3", "ext-cli-e2e79a", SECRET));
await nextFrame((m) => m.type === "COMMAND_ACK" && m.command_id === "e2e-3");
ok(acks.get("e2e-3")?.ok === false && /无权拉取/.test(acks.get("e2e-3")?.error ?? ""), "S3 跨会话登记路径拒绝");

// S4 幂等重放：同 command_id 重发 → duplicate ack、不重发数据帧
{
  const before = frames.filter((m) => m.type === "ARTIFACT_CHUNK" && m.payload?.ref === "e2e-1").length;
  send(cmd("e2e-1", "ext-cli-e2e79a", ART));
  await sleep(400);
  const after = frames.filter((m) => m.type === "ARTIFACT_CHUNK" && m.payload?.ref === "e2e-1").length;
  ok(acks.get("e2e-1")?.duplicate === true && before === after, `S4 幂等重放不重发（帧 ${before}→${after}，duplicate=${acks.get("e2e-1")?.duplicate}）`);
}

// S5 瞬态帧 seq=0（不挤事件缓冲序号）
ok(frames.filter((m) => m.type === "ARTIFACT_CHUNK").every((m) => m.seq === 0), "S5 ARTIFACT_CHUNK 帧 seq=0（瞬态）");

// S6 定向投递：旁观连接一条 ARTIFACT_CHUNK 都不该收到（to=请求方连接 id）；
// 但请求方自己收到了（S1 已断言）——两条件合证广播层按 to 过滤
await sleep(400);
const leaked = frames2.filter((m) => m.type === "ARTIFACT_CHUNK").length;
ok(leaked === 0 && frames.filter((m) => m.type === "ARTIFACT_CHUNK").length > 0, `S6 分块只发请求方（旁观 ${leaked} 帧，请求方 ${frames.filter((m) => m.type === "ARTIFACT_CHUNK").length} 帧）`);

ws2.close();
ws.close();
await sleep(150);
shutdown(fail ? 1 : 0);
