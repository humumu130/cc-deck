// X1 双机沙盒 e2e（PRD v0.3 验收 1-6 的 X1 批切片）：真 Node 云桥（租户开）+ 三台子进程
// relay（A/B 同租户 CCR_XMSG=1；D 同租户但 CCR_XMSG off 回归锚）。覆盖：
//   ① 密封 xmsg 注入成功+来源标注渲染+xack injected 可见（fake 注入器断言全文）
//   ② 明文 xmsg/错租户/互信外 → rejected+审计；发送方轮询可见（ccops 阻塞回显同链）
//   ③ 设备级 first-contact：首条弹卡一次（消息悬置）→ 确认后持久（第二条免卡直投）
//   ④ 幂等 24h 同窗：同 msg_id 重发零重投（补发腿的安全性锚）+ outbox 落盘往返
//   ⑤ 回程口：省略 session → 对端值班位（dutyTarget 解析）+ no-duty-target 拒绝面
//   ⑥ CCR_XMSG off：帧静默回落（零 xmsg 审计/零卡）+ org CLI 模板 bash 语法闸
// 端口：桥 8796，子机 8871/8872/8873（8891 被他仓 harness 常驻占用——1029 实测；与 8797-8799 沙盒错开）。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { FileStore } from "../../cloud-bridge/src/store-file.js";
import { generateKeyPair, devId, seal, unseal } from "../src/e2e.js";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
    process.exitCode = 1;
  } else console.log(`ok - ${msg}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 12_000, every = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}
function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return fallback; }
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 8796;
const TOKEN = "xmsg-e2e-token";
const ADMIN_KEY = "xmsg-e2e-admin-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "cc-xmsg-e2e-"));
const HERE = process.cwd();
process.chdir(dir);
// 会话 cwd 必须在 TMPDIR 外（bridge isSandboxCwd 闸：TMPDIR 前缀 cwd 的 hook 事件
// 直接 pass 不建会话——1026 ccr- 收编事故的闸，测试目录全在 TMPDIR 下会踩）
const SESSION_CWD = join(homedir(), ".cc-xmsg-e2e-cwd");
mkdirSync(SESSION_CWD, { recursive: true });

interface Peer {
  name: string;
  dataDir: string;
  orgDir: string;
  devfile: string;
  dev: string;
  pid: number;
  port: number;
  proc: ReturnType<typeof spawn> | null;
  injectLog: string;
}

function bootPeer(name: string, port: number, invite: string, xmsg: boolean): Peer {
  const dataDir = join(dir, `${name}-data`);
  const orgDir = join(dir, `${name}-org`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(orgDir, { recursive: true });
  // no-leader 模式：dutyTargetId 走「最近活跃 external」链（值班位解析的前提）
  writeFileSync(join(dataDir, "collab-mode.json"), JSON.stringify({ mode: "no-leader" }), "utf-8");
  const ccfg = join(dir, `${name}-claude-cfg`);
  mkdirSync(ccfg, { recursive: true });
  const injectLog = join(dir, `${name}-inject.log`);
  const devfile = join(dir, `${name}.dev.json`);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CCR_DATA_DIR: dataDir,
    CCR_ORG_DIR: orgDir,
    CLAUDE_CONFIG_DIR: ccfg,
    CCR_PORT: String(port),
    CCR_TOKEN: `tok-${name}-xmsg-e2e`, // loadConfig 要求 ≥8 字符（"tok-A" 5 字符被弃用→随机 token→401）
    CCR_BRIDGE_TOKEN: `btok-${name}-xmsg-e2e`,
    CCR_CLOUD_URL: `ws://127.0.0.1:${BRIDGE_PORT}/cloud`,
    CCR_CLOUD_TOKEN: TOKEN,
    CCR_TENANT: "1",
    CCR_TENANT_INVITE: invite,
    CCR_NO_LEADER: "1",
    CCR_NO_TITLE_GEN: "1",
    CCR_DEAD_SWEEP: "0",
    CCR_PROJECTS_ROOT: join(dir, `${name}-projects`),
    CCR_INJECT_CMD: fileURLToPath(new URL("./fake-injector.mjs", import.meta.url)),
    CCR_INJECT_LOG: injectLog,
    XMSG_E2E_DEVFILE: devfile,
  };
  if (xmsg) env.CCR_XMSG = "1";
  const proc = spawn("npx", ["tsx", join(ROOT, "xmsg-e2e-peer.ts")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d: Buffer) => { const s = String(d).trim(); if (s) console.log(`[${name}] ${s.slice(0, 160)}`); });
  proc.stderr!.on("data", (d: Buffer) => { const s = String(d).trim(); if (s && !/ExperimentalWarning|--trace/.test(s)) console.log(`[${name}!] ${s.slice(0, 160)}`); });
  return { name, dataDir, orgDir, devfile, dev: "", pid: 0, port, proc, injectLog };
}

// ---------- LAN ws 命令驱动（ccops 同链） ----------
function wsCmd(peer: Peer, type: string, payload: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${peer.port}/ws?token=tok-${peer.name}-xmsg-e2e`);
    const cid = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const t = setTimeout(() => { ws.close(); reject(new Error("ws 命令超时")); }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ command_id: cid, type, payload, ts: Date.now() })));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "COMMAND_ACK" && m.command_id === cid) { clearTimeout(t); ws.close(); resolve(m); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function xmsgSendCmd(peer: Peer, dev: string, text: string, session?: string): Promise<string> {
  const ack = await wsCmd(peer, "COMMAND_XMSG", { op: "send", dev, ...(session ? { session } : {}), text });
  if (!ack.ok) throw new Error(`xmsg send 拒: ${ack.error}`);
  return ack.data.msg_id as string;
}
async function xmsgStatus(peer: Peer, msgId: string): Promise<{ state: string; detail?: string }> {
  const ack = await wsCmd(peer, "COMMAND_XMSG", { op: "status", msg_id: msgId });
  return ack.ok ? { state: ack.data.state, detail: ack.data.detail } : { state: "?", detail: ack.error };
}
async function waitTerminal(peer: Peer, msgId: string, ms = 15_000): Promise<{ state: string; detail?: string }> {
  const end = Date.now() + ms;
  let last: { state: string; detail?: string } = { state: "?" };
  while (Date.now() < end) {
    try { last = await xmsgStatus(peer, msgId); } catch { /* 子机轮询间隙 */ }
    if (/injected|rejected|failed/.test(last.state)) return last;
    await wait(400);
  }
  return last;
}

const injectLines = (p: Peer): string[] => {
  try { return readFileSync(p.injectLog, "utf-8").split("\n").filter((l) => l.trim()); } catch { return []; }
};

console.log("== 桥与租户 ==");
const srv = startCloudServer(BRIDGE_PORT, TOKEN, [], { adminKey: ADMIN_KEY, store: new FileStore(join(dir, "tenants.json")) });
await srv.tenant!.ready;
const adm = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${TOKEN}&dev=adm-xmsg`);
await new Promise((r) => adm.once("open", r));
const mkTenant = (): Promise<{ tid: string; invite: string }> => new Promise((resolve) => {
  adm.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: "tenant-create", args: { name: "xmsg-e2e 租户" }, auth: { admin: ADMIN_KEY } } }));
  const on = (m: unknown) => {
    const f = JSON.parse(String(m)) as { type?: string; op?: string; invite?: string; tid?: string };
    if (f.type === "tenant_op_ok" && f.op === "tenant-create" && f.invite && f.tid) { adm.off("message", on); resolve({ tid: f.tid, invite: f.invite }); }
  };
  adm.on("message", on);
});
// 单租户三机：tenant-create 首码给 A，再直发一张 budget=3 的码给 B/D（同租户——
// xmsg 的租户边界断言前提：A/B/D 必须同租户，跨租户路由被桥直接 ROUTE_MISS）
const t1 = await mkTenant();
const invMore = await srv.tenant!.createInvite(t1.tid, "e2e-boot", 3);
assert("code" in invMore && !!invMore.code, "桥主直发 budget=3 邀请码（同租户）");
const invA = t1.invite;
const invCode = ("code" in invMore && invMore.code) ? invMore.code : "";
const invB = invCode;
const invD = invCode;

console.log("== 三机自举（A/B xmsg 开，D 关） ==");
const A = bootPeer("A", 8871, invA, true);
const B = bootPeer("B", 8872, invB, true);
const D = bootPeer("D", 8873, invD, false);
const peers = [A, B, D];
for (const p of peers) {
  const ok = await waitFor(() => existsSync(p.devfile), 20_000, 150);
  if (!ok) throw new Error(`${p.name} devfile 未出现`);
  const meta = readJson<{ dev: string; pid: number }>(p.devfile, { dev: "", pid: 0 });
  p.dev = meta.dev; p.pid = meta.pid;
  assert(p.dev.startsWith("rl-"), `${p.name} 自举完成 dev=${p.dev}`);
}
// 租户登录完成锚（cloud-tenant.json 落盘）
for (const p of peers) {
  const ok = await waitFor(() => existsSync(join(p.dataDir, "cloud-tenant.json")), 15_000, 150);
  assert(ok, `${p.name} 租户登录完成（凭证落盘）`);
}
// 互通锚：A 能发现 B（disc→RELAYS 租户过滤内）
await wait(1500);

console.log("== ③ first-contact：首条弹卡一次+悬置 ==");
const body1 = "首联测试：你好 B，这是 A 的值班位消息";
const mid1 = await xmsgSendCmd(A, B.dev, body1);
let st1 = await waitTerminal(A, mid1, 15_000);
// 首联未决：outbox 收到 queued（悬置）回执——非终态，随后确认后转终态
const heldFile = join(B.dataDir, "xmsg-held.json");
const confirmsFile = join(B.orgDir, "confirms.json");
assert(await waitFor(() => readJson<{ [k: string]: unknown[] }>(heldFile, {})[A.dev]?.length === 1, 6000), "B 悬置首条消息（xmsg-held.json）");
assert(await waitFor(() => {
  const cs = readJson<{ confirms?: { kind: string; payload: { dev?: string }; status: string }[] }>(confirmsFile, {});
  return (cs.confirms ?? []).some((c) => c.kind === "device-trust" && c.payload?.dev === A.dev && c.status === "pending");
}, 6000), "B 出 device-trust 首联卡（pending）");
const auditB = () => { try { return readFileSync(join(B.dataDir, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } };
assert(auditB().includes("xmsg-first-contact"), "B 审计：xmsg-first-contact 入 chain-audit");

console.log("== ⑤ no-duty-target：确认放行但 B 无会话 ==");
const cs1 = readJson<{ confirms?: { id: string; kind: string; payload: { dev?: string }; status: string }[] }>(confirmsFile, {});
const card1 = (cs1.confirms ?? []).find((c) => c.kind === "device-trust" && c.payload?.dev === A.dev && c.status === "pending");
assert(!!card1, "拿到首联卡 id");
const approveAck = await wsCmd(B, "COMMAND_ORG_CONFIRM", { confirm_id: card1!.id, approve: true });
assert(approveAck.ok === true, "首联卡 ✓ 决议通过");
st1 = await waitTerminal(A, mid1, 12_000);
assert(st1.state === "rejected" && (st1.detail ?? "").includes("no-duty-target"), `A 侧可见 rejected:no-duty-target（ccops 阻塞回显链）实测=${st1.state}/${st1.detail}`);
assert(auditB().includes("no-duty-target"), "B 审计：no-duty-target 拒绝入账");

console.log("== B 建外部会话（fake pid + 假注入器） ==");
async function hook(peer: Peer, ev: Record<string, unknown>): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${peer.port}/bridge/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": `btok-${peer.name}-xmsg-e2e` },
    body: JSON.stringify({ session_id: "cli-xmsg", cwd: SESSION_CWD, ...ev }),
  });
  if (!r.ok) throw new Error(`hook ${ev.event} -> ${r.status}`);
}
await hook(B, { event: "UserPromptSubmit", prompt: "xmsg e2e 值班会话", cli_pid: B.pid });
await hook(B, { event: "Stop" });
await wait(400);

console.log("== ① 密封注入+来源标注+xack injected ==");
const body2 = "值班位直投：请确认收到跨机消息";
const mid2 = await xmsgSendCmd(A, B.dev, body2);
const st2 = await waitTerminal(A, mid2, 15_000);
assert(st2.state === "injected", `A outbox 终态 injected（实测 ${st2.state}/${st2.detail}）`);
const inj = injectLines(B);
assert(inj.some((l) => l.includes(body2)), "B 假注入器收到正文（真敲链）");
assert(inj.some((l) => l.includes(`⇄跨机 · 来自 ${A.dev}（值班位）`)), "来源标注渲染（不可剥离前缀随注入全文）");
assert(auditB().includes("xmsg-inject"), "B 审计：xmsg-inject 入账");
assert(auditB().includes("xmsg-ack"), "B 审计：回执入账（双向审计）");

console.log("== ③ 续：确认后持久（第二条免卡直投） ==");
const cs2 = readJson<{ confirms?: unknown[] }>(confirmsFile, {});
const nCards = (cs2.confirms ?? []).filter((c) => (c as { kind: string }).kind === "device-trust").length;
assert(nCards === 1, `首联卡只出过一次（弹卡一次语义，实测 ${nCards}）`);
const body3 = "确认后第二条：应免卡直投";
const mid3 = await xmsgSendCmd(A, B.dev, body3);
const st3 = await waitTerminal(A, mid3, 15_000);
assert(st3.state === "injected" && injectLines(B).filter((l) => l.includes(body3)).length === 1, "确认后免卡直投+注入");

console.log("== ④ 幂等 24h 同窗：同 msg_id 重发零重投 ==");
// 攻陷测试替身：第三方密钥对直连桥，预信任入 B 的 device_trust（confirmed 行，直写库）
const kpX = generateKeyPair();
const devX = devId(kpX.publicKey, "rl");
const wsX = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${TOKEN}&dev=${devX}&rk=${encodeURIComponent(kpX.publicKey)}`);
wsX.on("error", () => undefined);
await new Promise((r) => wsX.once("open", r));
const dbB = join(B.dataDir, "cc-deck.sqlite3");
{
  const port = createSqlitePort({ dataDir: B.dataDir });
  port.open();
  runMigrations(port, migrations);
  port.exec("INSERT OR REPLACE INTO device_trust (dev, pubkey, tenant, first_seen_at, confirmed_at, confirmed_by) VALUES (?,?,?,?,?,?)", [devX, kpX.publicKey, null, Date.now(), Date.now(), "e2e-direct"]);
  port.close();
}
const kpB = readJson<{ publicKey: string; secretKey: string }>(join(B.dataDir, "cloud-keypair.json"), { publicKey: "", secretKey: "" });
assert(!!kpB.publicKey, "读到 B 公钥（密封目标）");
const bodyX = "幂等重发探针：只许注入一次";
const innerX = {
  t: "xmsg", v: 1, tenant: readJson<{ tenant: string }>(join(B.dataDir, "cloud-tenant.json"), { tenant: "" }).tenant || null,
  source: { dev: devX }, target: {}, msg_id: "xm-idemprobe0001", ts: Date.now(), ttl: 300_000, ack_req: true, body: bodyX,
};
const sendX = (): void => wsX.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", v: 1, spk: kpX.publicKey, env: seal(innerX, kpB.publicKey, kpX.secretKey) } }));
sendX();
await waitFor(() => injectLines(B).filter((l) => l.includes(bodyX)).length === 1, 8000);
sendX(); // 立即原样重发（同 msg_id）
await wait(1200);
assert(injectLines(B).filter((l) => l.includes(bodyX)).length === 1, "同 msg_id 重发零重投（seen 幂等）");
assert(auditB().includes("幂等重发"), "B 审计：幂等重发回缓存态");

console.log("== ② 错租户 → rejected:tenant ==");
const innerT = { ...innerX, msg_id: "xm-wrongtenant001", tenant: "t-别的租户", body: "错租户探针" };
// 先挂监听再发探针（回执先于审计断言到达的竞态）
let tenantXack = false;
{
  const p = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    wsX.on("message", function on(d) {
      const f = JSON.parse(String(d));
      if (f.from !== B.dev || f.data?.t !== "xack") return;
      try {
        const ack = unseal<{ t: string; msg_id: string; state: string }>(f.data.env, kpB.publicKey, kpX.secretKey);
        if (ack && ack.msg_id === "xm-wrongtenant001" && ack.state === "rejected:tenant") { clearTimeout(t); wsX.off("message", on); resolve(true); }
      } catch { /* 非本探针密文 */ }
    });
  });
  wsX.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", v: 1, spk: kpX.publicKey, env: seal(innerT, kpB.publicKey, kpX.secretKey) } }));
  tenantXack = await p;
}
assert(tenantXack, "发送方收到密封 xack rejected:tenant（可见性）");
assert(auditB().includes("reason=tenant"), "B 审计：rejected:tenant 入账");

console.log("== ② 明文 xmsg 即丢 ==");
const kpP = generateKeyPair();
const devP = devId(kpP.publicKey, "rl");
const wsP = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${TOKEN}&dev=${devP}&rk=${encodeURIComponent(kpP.publicKey)}`);
wsP.on("error", () => undefined); // 桥侧踢连等——不炸测试进程
await new Promise((r) => wsP.once("open", r));
let plaintextGotAny = false;
wsP.on("message", () => { plaintextGotAny = true; });
wsP.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", msg_id: "xm-plaintext0001", body: "明文探针" } }));
assert(await waitFor(() => auditB().includes("reason=plaintext"), 6000), "B 审计：明文 xmsg 即丢入账");
await wait(800);
assert(!plaintextGotAny, "未知明文来方零回执（防反射放大）");
// 已知设备（devX 已入 B 互信表）明文 → 回 rejected:plaintext
let plaintextXack = false;
{
  const p = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    wsX.on("message", function on(d) {
      const f = JSON.parse(String(d));
      if (f.from !== B.dev || f.data?.t !== "xack") return;
      try {
        const ack = unseal<{ msg_id: string; state: string }>(f.data.env, kpB.publicKey, kpX.secretKey);
        if (ack && ack.msg_id === "xm-plaintext0001" && ack.state === "rejected:plaintext") { clearTimeout(t); wsX.off("message", on); resolve(true); }
      } catch { /* 非本探针密文 */ }
    });
  });
  wsX.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", msg_id: "xm-plaintext0001", body: "已知设备明文探针" } }));
  plaintextXack = await p;
}
assert(plaintextXack, "已知设备明文 → rejected:plaintext 回执（发送方可见）");

console.log("== ② 互信外（首联否决 → revoked 拒） ==");
const kpR = generateKeyPair();
const devR = devId(kpR.publicKey, "rl");
const wsR = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${TOKEN}&dev=${devR}&rk=${encodeURIComponent(kpR.publicKey)}`);
wsR.on("error", () => undefined);
await new Promise((r) => wsR.once("open", r));
const innerR = { t: "xmsg", v: 1, tenant: innerX.tenant, source: { dev: devR }, target: {}, msg_id: "xm-rejectprobe001", ts: Date.now(), ttl: 300_000, ack_req: true, body: "否决路径探针" };
const sendR = (): void => wsR.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", v: 1, spk: kpR.publicKey, env: seal(innerR, kpB.publicKey, kpR.secretKey) } }));
const ackR: string[] = [];
wsR.on("message", (d) => {
  const f = JSON.parse(String(d));
  if (f.from === B.dev && f.data?.t === "xack") {
    try {
      const a = unseal<{ msg_id: string; state: string; note?: string }>(f.data.env, kpB.publicKey, kpR.secretKey);
      if (a && (a.msg_id === "xm-rejectprobe001" || a.msg_id === "xm-revokedprobe002")) ackR.push(`${a.state}|${a.note ?? ""}`);
    } catch { /* 非本探针密文 */ }
  }
});
sendR();
await waitFor(() => ackR.some((x) => x.startsWith("queued|")), 6000);
const cs3 = readJson<{ confirms?: { id: string; kind: string; payload: { dev?: string }; status: string }[] }>(confirmsFile, {});
const cardR = (cs3.confirms ?? []).find((c) => c.kind === "device-trust" && c.payload?.dev === devR && c.status === "pending");
assert(!!cardR, "否决探针设备出首联卡");
const rejAck = await wsCmd(B, "COMMAND_ORG_CONFIRM", { confirm_id: cardR!.id, approve: false });
assert(rejAck.ok === true, "首联卡 ✗ 决议");
assert(await waitFor(() => ackR.some((x) => x.startsWith("rejected:first-contact")), 6000), "否决设备消息回 rejected:first-contact");
// 吊销后**新消息** → revoked（同 msg_id 重发会先撞 seen 幂等回缓存态——那是幂等语义
// 的正确行为，不是 revoked 面；revoked 面用新 msg_id 验证）
{
  const innerR2 = { ...innerR, msg_id: "xm-revokedprobe002", body: "吊销后新消息探针" };
  const seen2 = new Set(ackR);
  wsR.send(JSON.stringify({ to: B.dev, data: { t: "xmsg", v: 1, spk: kpR.publicKey, env: seal(innerR2, kpB.publicKey, kpR.secretKey) } }));
  const ok2 = await waitFor(() => ackR.filter((x) => !seen2.has(x)).some((x) => x.startsWith("rejected:revoked")), 6000);
  assert(ok2, "吊销后新消息 → rejected:revoked");
}

console.log("== ⑥ CCR_XMSG off：静默回落 ==");
const auditD0 = (() => { try { return readFileSync(join(D.dataDir, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
const body6 = "关开关探针：D 应静默丢";
const mid6 = await xmsgSendCmd(A, D.dev, body6);
await wait(3500);
const auditD1 = (() => { try { return readFileSync(join(D.dataDir, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
assert(!auditD1.split("\n").some((l) => l.includes("xmsg-") && !auditD0.split("\n").includes(l)), "D（off）零 xmsg 审计行（默认 off 零行为差异）");
const st6 = await xmsgStatus(A, mid6);
assert(st6.state === "sent" || st6.state === "pending", `A→D 无回执滞留（实测 ${st6.state}，ttl 后 failed:ttl-expired 收口）`);

console.log("== ⑤ org dispatch --remote（HTTP 面=CLI 同漏斗） ==");
const orgR = await fetch(`http://127.0.0.1:${A.port}/api/org?token=tok-A-xmsg-e2e`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "dispatch-remote", dev: B.dev, anchor: "/tmp/xmsg-e2e-anchor", prompt: "跨机派单任务书正文" }),
}).then((r) => r.json());
assert(orgR.ok === true && orgR.data?.msg_id, `dispatch-remote 入队（${JSON.stringify(orgR).slice(0, 80)}）`);
const midO = orgR.data.msg_id as string;
const stO = await waitTerminal(A, midO, 15_000);
assert(stO.state === "injected" && injectLines(B).some((l) => l.includes("跨机派单 · 对端权威消化")), `dispatch-remote 注入对端值班位（实测 ${stO.state}）`);

console.log("== outbox 落盘与限速 ==");
const outboxA = readJson<{ msg_id: string; state: string }[]>(join(A.dataDir, "xmsg-outbox.json"), []);
const mid2Row = outboxA.find((e) => e.msg_id === mid2);
assert(mid2Row?.state === "injected", "A outbox 落盘可见终态");
assert(existsSync(join(A.dataDir, "xmsg-peers.json")), "A peer 公钥缓存落盘（disc 发现）");
assert(existsSync(join(B.dataDir, "xmsg-seen.json")), "B seen 账本落盘（24h 窗）");

console.log("== org CLI 模板 bash 语法闸（${ 转义回归） ==");
{
  const src = readFileSync(join(ROOT, "../src/org.ts"), "utf-8");
  const m = src.match(/const ORG_CLI_TEMPLATE = `([\s\S]*?)`;\n/)!;
  assert(!!m, "ORG_CLI_TEMPLATE 可提取");
  const cli = join(dir, "org-syntax-check.sh");
  writeFileSync(cli, m[1]!.replace(/\\\$/g, "$"), "utf-8"); // TS 源级 \$ 转义还原为 bash $
  try {
    execFileSync("bash", ["-n", cli]);
    assert(true, "CLI 模板 bash -n 语法通过");
  } catch (e) {
    assert(false, `CLI 模板 bash 语法错误: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log("== 收尾 ==");
for (const p of peers) p.proc?.kill("SIGTERM");
wsX.close(); wsR.close(); wsP.close(); adm.close();
await wait(600);
try { await srv.close(); } catch { /* 尽力而为 */ }
await wait(400);
rmSync(dir, { recursive: true, force: true });
try { rmSync(SESSION_CWD, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
console.log(failures === 0 ? "XMSG E2E: ALL PASSED" : `XMSG E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
