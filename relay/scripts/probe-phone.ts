// #146 排查探针（临时，不提交）：完整模拟一台手机经云桥配对 + hello，
// 实测生产链路的 SNAPSHOT 到达情况（尺寸/时延/deliverables 字段）与连接存活性。
import { WebSocket } from "ws";
import { devId, generateKeyPair, seal, unseal, type SealedBox } from "../src/e2e.js";

const CONSOLE = "http://127.0.0.1:8787";
const RELAY_TOKEN = process.env.PROBE_RELAY_TOKEN ?? "";
const RELAY_PUBKEY = process.env.PROBE_RELAY_PUBKEY ?? "";
const BRIDGE = "wss://cc.humumu.online/cloud";
const BRIDGE_TOKEN = "ccdeck-public-9f3k2m7v";

const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

if (!RELAY_TOKEN) {
  console.error("需要 PROBE_RELAY_TOKEN");
  process.exit(1);
}

// 1) 领配对码（LAN console API）
const codeRes = await fetch(`${CONSOLE}/api/pair-code?token=${RELAY_TOKEN}`, { method: "POST" });
if (!codeRes.ok) {
  console.error(`pair-code 失败: ${codeRes.status}`);
  process.exit(1);
}
const { code } = (await codeRes.json()) as { code: string };
console.log(`${el()} 配对码: ${code}`);

// 2) 手机身份 + 连桥
const kp = generateKeyPair();
const dev = devId(kp.publicKey, "ph");
const ws = new WebSocket(`${BRIDGE}?token=${BRIDGE_TOKEN}&dev=${dev}`);
ws.on("error", (e) => console.log(`${el()} ws error: ${e.message}`));

const inbox: Record<string, unknown>[] = [];
// env 注入的 relay 公钥（~/.cc-deck/data/cloud-keypair.json 只取 publicKey 字段）：
// pair_ack 本身就是 relay 密封的帧，解封需要预知 relay 公钥——真实手机从配对链接
// fragment 获得，探针从生产密钥文件注入（鸡生蛋问题的唯一旁路）
let relayPubkey = RELAY_PUBKEY;
let snapFrameLen = 0;

ws.on("message", (raw) => {
  const text = String(raw);
  let f: { data?: SealedBox | Record<string, unknown>; type?: string };
  try {
    f = JSON.parse(text);
  } catch {
    console.log(`${el()} 非 JSON 帧: ${text.slice(0, 120)}`);
    return;
  }
  if (f.type) console.log(`${el()} 桥裸帧: ${text.slice(0, 120)}`);
  if (!f.data) return;
  // 明文帧（pair_nack / 桥提示）：无 n 字段直接入箱
  if (typeof f.data === "object" && (f.data as { n?: unknown }).n === undefined) {
    inbox.push(f.data as Record<string, unknown>);
    return;
  }
  if (!relayPubkey) {
    console.log(`${el()} 密文帧但 relay 公钥未知，跳过`);
    return;
  }
  let inner: Record<string, unknown> | null = null;
  try {
    inner = unseal<Record<string, unknown>>(f.data as SealedBox, relayPubkey, kp.secretKey);
  } catch (e) {
    console.log(`${el()} unseal 异常: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (!inner) return;
  if (inner.type === "SNAPSHOT") snapFrameLen = text.length;
  inbox.push(inner);
});

await new Promise<void>((r) => ws.on("open", r));
console.log(`${el()} 桥连接 open`);

// 3) pair_req（明文）
ws.send(JSON.stringify({ to: "*", data: { t: "pair_req", code, pubkey: kp.publicKey, name: "probe-146", client_type: "phone", bc: true } }));

const waitMsg = async (pred: (m: Record<string, unknown>) => boolean, ms: number, label: string): Promise<Record<string, unknown> | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

const ack = await waitMsg((m) => m.t === "pair_ack" || m.t === "pair_nack", 15000, "pair");
if (!ack || ack.t !== "pair_ack") {
  console.error(`${el()} 配对失败: ${JSON.stringify(ack).slice(0, 200)}`);
  process.exit(1);
}
relayPubkey = String((ack as { relay_pubkey?: string }).relay_pubkey);
const relayDev = String((ack as { relay_dev?: string }).relay_dev);
console.log(`${el()} pair_ack（relay=${relayDev.slice(0, 10)}…）`);

// 4) hello last_seq=0（与用户手机完全一致的路径）
ws.send(JSON.stringify({ to: relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPubkey, kp.secretKey) }));
console.log(`${el()} hello 已发（last_seq=0）`);

// 5) 等 SNAPSHOT
const snap = await waitMsg((m) => m.type === "SNAPSHOT", 20000, "snapshot");
if (!snap) {
  console.error(`${el()} ❌ 20s 未收到 SNAPSHOT`);
} else {
  const pl = snap.payload as {
    deliverables?: unknown;
    sessions?: unknown[];
    logs?: Record<string, unknown[]>;
    server_time?: number;
  };
  console.log(`${el()} ✅ SNAPSHOT 收到：密文帧 ${Math.round(snapFrameLen / 1024)}KB，sessions=${pl.sessions?.length ?? 0}，logs 会话数=${Object.keys(pl.logs ?? {}).length}，deliverables=${JSON.stringify(pl.deliverables)}`);
}

// 6) 存活观察 15s：连接是否被掐（对应手机端 hello→2s 死的嫌疑）
for (let i = 1; i <= 3; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`${el()} 存活检查 ${i}/3：readyState=${ws.readyState}（1=OPEN），累计收帧 ${inbox.length}`);
  if (i === 2 && ws.readyState === 1) {
    ws.send(JSON.stringify({ to: relayDev, data: seal({ t: "ping", last_seq: 0 }, relayPubkey, kp.secretKey) }));
  }
}
const pong = inbox.some((m) => m.t === "pong");
console.log(`${el()} ping→pong: ${pong ? "✅" : "❌"}`);

// 7) 清理：列出设备清单，踢除全部 probe-146（含自身；也顺带清掉此前崩溃运行残留的幽灵设备）
ws.send(
  JSON.stringify({
    to: relayDev,
    data: seal({ command_id: "probe-peers", type: "COMMAND_PEERS", payload: {}, ts: Date.now() }, relayPubkey, kp.secretKey),
  }),
);
const peersAck = await waitMsg((m) => m.type === "COMMAND_ACK" && m.command_id === "probe-peers", 10000, "peers");
const stale = (peersAck as { peers?: { dev: string; name?: string }[] } | null)?.peers
  ?.filter((p) => (p.name ?? "").startsWith("probe-146")) ?? [];
console.log(`${el()} 设备清单中 probe-146 共 ${stale.length} 台${stale.length ? "：" + stale.map((p) => p.dev.slice(0, 12)).join(",") : ""}`);
for (const p of stale) {
  ws.send(
    JSON.stringify({
      to: relayDev,
      data: seal({ command_id: "probe-kick-" + p.dev, type: "COMMAND_PEER_KICK", payload: { dev: p.dev }, ts: Date.now() }, relayPubkey, kp.secretKey),
    }),
  );
}
await new Promise((r) => setTimeout(r, 1500));
console.log(`${el()} 已发踢除命令 ×${stale.length}`);
ws.close();
process.exit(0);
