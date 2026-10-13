// P0 板持久信道（夜审 B2-F1）：断连端零自愈根治——断连追平端到端。
// 链路：SNAPSHOT 携 boards 全量（listBoards）→ 断连窗口内改板 → 重连新客户端收快照
// = 最终盘态（收敛非中间态）。三条：单改追平 / 多改收敛 / 重连全量（新客户端）。
// 隔离：CCR_DATA_DIR+CCR_ORG_DIR+CCR_PORT 全显式错开（团队经验：worker 会话自带生产
// env，`||=` 缺省不覆盖已继承值）；直跑：
//   env -u CCR_ORG_DIR CCR_DATA_DIR=<tmp> CCR_ORG_DIR=<tmp> CCR_PORT=18901 node --import tsx/esm scripts/test-board-persist-channel.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { createGroup, upsertBoardEntry, moveBoardEntry, listBoards, setGroupStatus } from "../src/projects.js";

const PORT = Number(process.env.CCR_PORT || 18901);
const dataDir = mkdtempSync(join(tmpdir(), "cc-bpc-test-"));
const orgDir = mkdtempSync(join(tmpdir(), "cc-bpc-org-"));
process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_ORG_DIR = orgDir;
process.env.CCR_PORT = String(PORT); // 隔离端口（漏设则 loadConfig 默认 8787 直绑生产口——1013 实测拦截）
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => { if (cond) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " | " + detail : "")); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("== P0 board persist channel: 断连追平端到端 ==");
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const server = startServer(bus, mgr, cfg, {});

/** 连一次收首帧 SNAPSHOT（模拟客户端连接/重连）。 */
function fetchSnapshot(): Promise<{ boards?: unknown; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(cfg.token)}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("snapshot timeout")); }, 4000);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; payload?: Record<string, unknown> };
        if (m.type === "SNAPSHOT") { clearTimeout(timer); try { ws.close(); } catch {} resolve(m.payload!); }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

try {
  await sleep(250);
  // 建组+两卡（新 org trust_light=false → 轻立项落 pending，转 active 过写门）
  const r1 = createGroup({ name: "追平测试组", anchor_dir: "/tmp/bpc", tier: "轻立项" }, orgDir);
  if (!r1.ok) throw new Error("createGroup: " + r1.error);
  const gid = r1.group.id;
  setGroupStatus(gid, "active", undefined, orgDir);
  upsertBoardEntry(gid, { id: "t-1", text: "断连窗口前·卡一", status: "claimed" }, orgDir);
  upsertBoardEntry(gid, { id: "t-2", text: "断连窗口前·卡二", status: "backlog" }, orgDir);

  // ① 重连全量：全新客户端（无任何缓存=重启 App 语义）首连即全量
  const snap1 = await fetchSnapshot();
  const b1 = (snap1.boards as { gid: string; entries: { id: string; status?: string }[] }[] | undefined);
  ok(Array.isArray(b1), "① SNAPSHOT 携 boards 全量（能力位在场）", JSON.stringify(Object.keys(snap1)).slice(0, 120));
  ok(!!b1 && b1.some((x) => x.gid === gid && x.entries.length === 2), "① 新客户端首连即全量板（2 卡）");

  // ② 单改追平：断连 → 单改 → 重连快照反映
  moveBoardEntry(gid, "t-1", "done", orgDir);
  const snap2 = await fetchSnapshot();
  const b2 = snap2.boards as { gid: string; entries: { id: string; status?: string }[] }[];
  const s2 = b2?.find((x) => x.gid === gid)?.entries.find((e) => e.id === "t-1")?.status;
  ok(s2 === "done", "② 断连窗口单改（claimed→done）重连追平", `t-1.status=${s2}`);

  // ③ 多改收敛：断连窗口 3 连改（新卡+搬态+再搬态）→ 重连=最终态（非中间态）
  upsertBoardEntry(gid, { id: "t-3", text: "窗口内新卡", status: "backlog" }, orgDir);
  moveBoardEntry(gid, "t-3", "claimed", orgDir);
  upsertBoardEntry(gid, { id: "t-3", text: "窗口内新卡", review_required: true, status: "done" }, orgDir); // R2 完成候选→submitted（中间态 claimed 不残留）
  moveBoardEntry(gid, "t-2", "claimed", orgDir);
  const snap3 = await fetchSnapshot();
  const b3 = snap3.boards as { gid: string; entries: { id: string; status?: string }[] }[];
  const g3 = b3?.find((x) => x.gid === gid);
  const st = (id: string) => g3?.entries.find((e) => e.id === id)?.status;
  ok(st("t-3") === "submitted" && st("t-2") === "claimed" && g3?.entries.length === 3, "③ 多改收敛为最终态（3 卡/t-3=submitted/t-2=claimed）", JSON.stringify({ t2: st("t-2"), t3: st("t-3"), n: g3?.entries.length })); // 提交态走 R2 资格边（D18：submitted 仅完成候选生成）

  // ④ 形状纪律：lessons 摘除（存量板 lessons 不回流）+ 空组板（空数组也下发）+ 守卫 null 形状
  const lb = listBoards(orgDir);
  ok(Array.isArray(lb) && lb.every((x) => !(x as { lessons?: unknown[] }).lessons?.length), "④ listBoards lessons 摘除形态");
  const r2 = createGroup({ name: "空板组", anchor_dir: "/tmp/bpc2", tier: "轻立项" }, orgDir);
  const gid2 = r2.ok ? r2.group.id : "";
  const snap4 = await fetchSnapshot();
  const b4 = snap4.boards as { gid: string }[];
  ok(Array.isArray(b4) && b4.some((x) => x.gid === gid2), "④ 空组空板也随快照下发（空数组=能力位非守卫缺席）");
} finally {
  try { await server.close(); } catch {}
  await sleep(120);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(orgDir, { recursive: true, force: true });
}
console.log(fail ? `board-persist-channel: ${fail} FAILED (${pass} passed)` : `board-persist-channel: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
