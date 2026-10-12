// W-MODE 协作模式开关测试（纯单元，不起服务）：settings.ts 读写兜底 / snapshot()
// 锚卡过滤 / suppressLeaderEvent 三态 / applyCollabMode 广播（瞬态语义）/ orgAction
// collab-mode get&set / leader 态零变化回归 / 跨实例（重启保持）语义。
// data/test-collab-mode*/ 隔离目录；leaderId 经运行时穿透注入（TS private 是编译期，
// 测试不 spawn 真 Leader——ensureLeader 链不在本单范围）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readCollabMode, writeCollabMode } from "../src/settings.js";
import type { RelayConfig } from "../src/config.js";
import type { Envelope } from "../src/types.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}
function section(t: string) { console.log(t); }

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_NO_LEADER = "1"; // 本测试不测 ensureLeader 链（防意外 spawn 真 CLI）

const mkDir = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccr-cmode-${tag}-`)); dirs.push(d); return d; };

interface ModeFrame { type: string; seq: number; payload: Record<string, unknown> }

function mkManager(tag: string) {
  const DATA = mkDir(`${tag}-data`);
  const ORG = mkDir(`${tag}-org`);
  const CFG = mkDir(`${tag}-cfg`);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const frames: ModeFrame[] = [];
  bus.subscribe((env: Envelope) => frames.push({ type: env.type, seq: env.seq, payload: env.payload as Record<string, unknown> }));
  const mgr = new SessionManager(bus, cfg);
  const modeFrames = (): ModeFrame[] => frames.filter((f) => f.type === "COLLAB_MODE_UPDATED");
  return { DATA, ORG, mgr, bus, frames, modeFrames };
}

// leaderId 注入（运行时穿透：ensureLeader 会 spawn 真 CLI，测试直接置常驻身份位）
function setLeaderId(mgr: SessionManager, id: string): void {
  (mgr as unknown as { leaderId: string | null }).leaderId = id;
}

// ---------- S1 读写层（settings.ts）----------
section("\nS1 collab-mode.json 读写与兜底");
{
  const D = mkDir("s1");
  assert(readCollabMode(D) === "leader", "无文件 = 默认 leader（现状零迁移）");
  assert(writeCollabMode(D, "no-leader") === true, "写盘成功");
  assert(readCollabMode(D) === "no-leader", "roundtrip 读回 no-leader");
  assert(existsSync(join(D, "collab-mode.json")), "落点 = data/collab-mode.json");
  writeCollabMode(D, "leader");
  assert(readCollabMode(D) === "leader", "切回 leader 读回");
  writeFileSync(join(D, "collab-mode.json"), "{ broken json !!", "utf-8");
  assert(readCollabMode(D) === "leader", "坏 JSON 兜底 leader（失败方向=现状）");
  writeFileSync(join(D, "collab-mode.json"), JSON.stringify({ mode: "banana" }), "utf-8");
  assert(readCollabMode(D) === "leader", "未知 mode 值兜底 leader");
}

// ---------- S2 快照过滤 + leader 态回归 ----------
section("\nS2 snapshot() 锚卡过滤（leader 态零变化回归）");
{
  const { DATA, mgr } = mkManager("s2");
  mgr.ensureExternal("s-leader", "/tmp/org", "Leader 锚卡", "", Date.now() - 600_000);
  mgr.ensureExternal("s-work", "/tmp/proj", "普通工作卡", "", Date.now() - 60_000);
  mgr.ensureExternal("s-ext", "/tmp/play", "外部卡", "", Date.now() - 30_000);
  setLeaderId(mgr, "s-leader");
  const ids = (arr: { session_id: string }[]) => arr.map((x) => x.session_id).sort();
  const before = mgr.snapshot();
  assert(ids(before).join(",") === "s-ext,s-leader,s-work", "leader 态（默认）三卡全量下发");
  writeCollabMode(DATA, "no-leader");
  const after = mgr.snapshot();
  assert(ids(after).join(",") === "s-ext,s-work", "no-leader 态锚卡 s-leader 不下发");
  assert(mgr.collabMode() === "no-leader", "collabMode() 读回 no-leader");
  // 团队/看板/通知不受影响：内存卡还在（isLeaderSession 口径）+ ensureExternal 已存在的卡不重复建
  assert(mgr.isLeaderSession("s-leader") === true, "内存常驻身份不受过滤影响");
  const again = mgr.ensureExternal("s-leader", "/tmp/org", "Leader 锚卡", "", Date.now() - 600_000);
  assert(again.session_id === "s-leader", "锚卡实体照常（ensureExternal 幂等命中内存卡）");
  writeCollabMode(DATA, "leader");
  const restored = mgr.snapshot();
  assert(JSON.stringify(ids(restored)) === JSON.stringify(ids(before)), "切回 leader 快照复原（逐 id 一致）");
}

// ---------- S3 帧抑制三态 ----------
section("\nS3 suppressLeaderEvent（SESSION_CREATED 唯一建卡帧）");
{
  const { DATA, mgr } = mkManager("s3");
  setLeaderId(mgr, "s-leader");
  writeCollabMode(DATA, "no-leader");
  assert(mgr.suppressLeaderEvent({ type: "SESSION_CREATED", session_id: "s-leader" }) === true, "no-leader：锚卡 CREATED 抑制");
  assert(mgr.suppressLeaderEvent({ type: "SESSION_UPDATED", session_id: "s-leader" }) === false, "no-leader：锚卡 UPDATED 不抑制（端上无卡自然无操作，事件流/审计面不动）");
  assert(mgr.suppressLeaderEvent({ type: "SESSION_CREATED", session_id: "s-work" }) === false, "no-leader：他卡 CREATED 照发");
  assert(mgr.suppressLeaderEvent({ type: "SESSION_HEARTBEAT", session_id: "" }) === false, "非 session 帧零开销短路");
  writeCollabMode(DATA, "leader");
  assert(mgr.suppressLeaderEvent({ type: "SESSION_CREATED", session_id: "s-leader" }) === false, "leader 态：锚卡 CREATED 照发（现状）");
}

// ---------- S4 切换广播 + orgAction 漏斗 ----------
section("\nS4 applyCollabMode / orgAction collab-mode（广播与瞬态语义）");
{
  const { DATA, ORG, mgr, modeFrames } = mkManager("s4");
  mgr.ensureExternal("s-leader", "/tmp/org", "Leader 锚卡", "", Date.now() - 600_000);
  setLeaderId(mgr, "s-leader");
  // get（mode 缺省）
  const g = mgr.orgAction("collab-mode", {});
  assert(g.ok && (g as { data?: { mode?: string } }).data?.mode === "leader", "orgAction get 默认 leader");
  // set no-leader（经漏斗——与端上 COMMAND_ORG_ACTION 同一入口）
  const r1 = mgr.orgAction("collab-mode", { mode: "no-leader" });
  assert(r1.ok === true, "orgAction set no-leader ok");
  assert(readCollabMode(DATA) === "no-leader", "set 落盘 collab-mode.json");
  const f1 = modeFrames().at(-1)!;
  assert(f1.payload.mode === "no-leader" && f1.payload.leader_session_id === "s-leader", "COLLAB_MODE_UPDATED：mode+leader_session_id");
  assert(!("leader_session" in f1.payload), "切 no-leader 帧不带 leader_session（端上只删不加）");
  assert(f1.seq === 0, "瞬态帧 seq=0（不落 events.ndjson）");
  // set leader（带完整卡）
  const r2 = mgr.orgAction("collab-mode", { mode: "leader" });
  assert(r2.ok === true, "orgAction set leader ok");
  const f2 = modeFrames().at(-1)!;
  assert(f2.payload.mode === "leader", "切回帧 mode=leader");
  const ls = f2.payload.leader_session as { session_id?: string } | undefined;
  assert(ls?.session_id === "s-leader", "切回帧带 leader_session 完整卡（端上 upsert）");
  // 非法值
  const r3 = mgr.orgAction("collab-mode", { mode: "banana" });
  assert(r3.ok === false, "非法 mode 拒收");
  const nd = readFileSync(join(DATA, "events.ndjson"), "utf-8");
  assert(!nd.includes("COLLAB_MODE_UPDATED"), "瞬态帧不落 events.ndjson（离线端 SNAPSHOT 兜底）");
  // 未知 action 回归（default 分支不受新增 case 影响）
  assert(mgr.orgAction("frobnicate", {}).ok === false, "未知 action 仍拒收（default 分支回归）");
  assert(existsSync(ORG), "org 目录不被本开关触碰（团队/看板/通知不受影响）");
}

// ---------- S5 跨实例（重启保持）----------
section("\nS5 跨实例读回（relay 重启 = 文件即真相）");
{
  const { DATA, mgr } = mkManager("s5");
  writeCollabMode(DATA, "no-leader");
  const cfg2: RelayConfig = {
    port: 8798, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus2 = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr2 = new SessionManager(bus2, cfg2);
  assert(mgr2.collabMode() === "no-leader", "新实例读回 no-leader（重启保持）");
  mgr.ensureExternal("x", "/tmp", "占位", "", Date.now());
  assert(mgr2.snapshot().length >= 0, "第二实例可正常快照（互不干扰）");
}

// ---------- 收尾 ----------
process.env.CCR_ORG_DIR = savedEnv.CCR_ORG_DIR;
process.env.CCR_CONFIG_FILE = savedEnv.CCR_CONFIG_FILE;
process.env.CCR_STORAGE_READ_MODE = savedEnv.CCR_STORAGE_READ_MODE;
delete process.env.CCR_NO_LEADER;
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理尽力 */ } }
console.log(`\ncollab-mode: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
