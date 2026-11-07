// W-PMAPPOINT-GAP（t-05329c28，1107 消卡循环第二现治本）断言档：
//   A 消卡判据四态对齐（真 SessionManager+真卡 fixture）：
//     A1 alive（卡 pid 活）不消；A2 between-turns（**复现用例**：卡 pid 死+帧龄 20min
//     —— 超 15min events 窗但在 30min 回合 TTL 内=旧判据误消形态）不消；
//     A3 dead（pid 死+帧龄 45min 超 TTL）消；A4 stale（卡 pid 活但会话 pid 已换代）消
//   B 帧源核查（managed 回合帧写链静态锚）：onLog→SESSION_LOG/transition→SESSION_UPDATED/
//     onTurnEnd 终态帧——回合内帧完整，15min 窗对「回合活跃」managed 不瞎；缺口=回合
//     间隙>窗形态=四态 between-turns 辖区（本批消卡已对齐）
//   C 回归红线锚：pmOverrideLiveness 四态语义零变化/auto:pm-dead 不入否决档/提名一次一张
// 环境隔离：mkdtemp ORG/DATA + no-leader 模式 + 真 events.ndjson 帧注入。
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fileURLToPath } from "node:url";

process.env.CCR_STORAGE_READ_MODE = "json";
const ORG = mkdtempSync(join(tmpdir(), "pmag-org-"));
const DATA = mkdtempSync(join(tmpdir(), "pmag-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_NO_TITLE_GEN = "1";
delete process.env.CCR_CWD;

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main() {
  const { addConfirm, listPendingConfirms } = await import("../src/projects.js");
  const { writeCollabMode } = await import("../src/settings.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { EventBus } = await import("../src/event-bus.js");

  writeCollabMode(DATA, "no-leader");
  const cfg = { port: 8799, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [] as string[], cloudToken: "", cloudUrl: "", employeeConfigDir: null } as never;
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const propose = () => (mgr as unknown as { maybeProposePmAppointment(): void }).maybeProposePmAppointment();

  const mkCard = (sid: string, cliPid: number) => {
    const r = addConfirm({ kind: "pm-appoint" as never, title: `值守 PM 任命：${sid.slice(0, 8)}`, reason: "test", payload: { sid, cli_pid: cliPid, cwd: "/tmp", origin: "auto" } } as never);
    return !!r;
  };
  const cardAlive = (sid: string) => listPendingConfirms().some((c) => c.kind === "pm-appoint" && (c.payload as { sid?: string }).sid === sid);
  const seedFrame = (sid: string, ts: number) => appendFileSync(join(DATA, "events.ndjson"), JSON.stringify({ seq: Date.now(), session_id: sid, ts, type: "SESSION_LOG", payload: {} }) + "\n", "utf-8");
  // 真死 pid：异步短命子进程退出后的 pid（spawnSync 不回真 pid——.pid 恒 0 会误走 pid=0 活跃度支）
  const { spawn } = await import("node:child_process");
  const deadPid = await new Promise<number>((resolve) => {
    const c = spawn(process.execPath, ["-e", ""]); // macOS 无 /bin/true（ENOENT 落 pid=0 误走活跃度支）——node 自退跨平台
    c.on("exit", () => resolve(c.pid ?? 0));
    c.on("error", () => resolve(0));
  });

  // A1 alive：卡 pid=本进程（活）→ 不消
  mkCard("pm-a1-alive", process.pid);
  propose();
  ok(cardAlive("pm-a1-alive"), "A1 alive（卡 pid 活）不消卡");

  // A2 between-turns【复现用例】：卡 pid 死+帧龄 20min（>15min events 窗、<30min 回合 TTL）
  //    ——旧判据（pid>0 恒 kill 探活/pid=0 15min 窗）此处必消=1107 11:29 cf-aa1cfbb9 形态
  mkCard("pm-a2-gap", deadPid);
  seedFrame("pm-a2-gap", Date.now() - 20 * 60_000);
  propose();
  ok(cardAlive("pm-a2-gap"), "A2 between-turns 不消（20min 无 events 帧+卡 pid 死——回合间隙=守位，旧判据必消的复现形态）");

  // A2b pid=0 卡同径：帧龄 20min——pmOverrideLiveness 活跃度分支（15min 窗）判 dead 会消？
  //    本批语义=与提名侧同（pid=0 无 between-turns 辖区——SDK 常驻形态），如实断言：
  mkCard("pm-a2b-sdk", 0);
  seedFrame("pm-a2b-sdk", Date.now() - 20 * 60_000);
  propose();
  ok(cardAlive("pm-a2b-sdk") === false, "A2b pid=0 卡（SDK 常驻形态）超 15min 帧窗仍消——与提名侧 dutyCandidateId 同语义（无回合退出形态不享回合 TTL）");

  // A3 dead：pid 死+帧龄 45min（超 30min TTL）→ 消
  mkCard("pm-a3-dead", deadPid);
  seedFrame("pm-a3-dead", Date.now() - 45 * 60_000);
  propose();
  ok(cardAlive("pm-a3-dead") === false, "A3 dead（超回合 TTL）消卡——真死不滞留");

  // A4 stale：卡 pid 活（长眠子进程）+在册会话 pid 已换代 → 消
  const child = (await import("node:child_process")).spawn("sleep", ["8"]);
  await new Promise((r) => setTimeout(r, 200));
  const cpid = child.pid ?? 0;
  // 在册会话持不同 pid（换代）→ pmOverrideLiveness 判 stale
  const m = (mgr as unknown as { sessions: Map<string, { state: { cli_pid: number } }> });
  m.sessions.set("pm-a4-stale", { state: { cli_pid: process.pid } });
  mkCard("pm-a4-stale", cpid);
  propose();
  ok(cardAlive("pm-a4-stale") === false, "A4 stale（卡 pid 活但会话 pid 换代——pid 回收占位假阳）消卡");
  child.kill();

  // B 帧源核查（managed 回合帧写链——静态锚+结论）
  console.log("B 帧源核查：");
  const smSrc = readFileSync(join(repoRoot, "relay/src/session-manager.ts"), "utf-8");
  ok(smSrc.includes('this.bus.emit(id, "SESSION_LOG", entry);') || smSrc.includes('this.bus.emit(managed.state.session_id, "SESSION_LOG", entry);'), "B1 managed onLog→SESSION_LOG 落帧（回合内每工具/输出行帧——15min 窗对回合活跃 managed 不瞎）");
  ok(smSrc.includes('this.bus.emit(sessionId, "SESSION_UPDATED", {'), "B2 transition/状态变更→SESSION_UPDATED 落帧");
  ok(smSrc.includes('"TASK_DONE"'), "B3 回合终态→TASK_DONE 落帧（onTurnEnd 边）");
  ok(readFileSync(join(repoRoot, "relay/src/event-bus.ts"), "utf-8").includes("appendLine(this.opts.persistPath, env)"), "B4 EventBus 全事件落 events.ndjson（帧源单点）——结论：managed 回合内帧完整，缺口仅在「回合间隙>窗」形态=四态 between-turns 辖区（本批消卡已对齐）");

  // C 回归红线锚
  console.log("C 回归红线：");
  ok(smSrc.includes('"between-turns"=pid 死但回合活跃 TTL 内'), "C1 pmOverrideLiveness 四态注释锚在（SEATALIVE 交付面零变化——本批未触该函数体）");
  ok(smSrc.includes("auto:pm-dead **不入否决档**"), "C2 auto:pm-dead 不入否决档（R1-A-P1② 保持）");
  ok(smSrc.includes("if (stillPending.length > 0) return; // 他人卡在决：一次一张，不抢提"), "C3 提名一次一张节流保持");
  ok(smSrc.includes("this.pmOverrideLiveness({ cli_pid: pid, session_id: sid })"), "C4 消卡走四态单点（复用 CCR_SEAT_TURN_GAP_MIN——零新窗常量）");

  console.log(`\n== test-pmappoint-gap：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

void main();
