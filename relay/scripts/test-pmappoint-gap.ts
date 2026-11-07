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
  //    ——旧判据（pid>0 恒 kill 探活/pid=0 15min 窗）此处必消=1107 消卡循环形态
  //   （R1 时间线修正：R0 注释 11:29 有误——实锤 cf-aa1cfbb9 1107 18:29:25 被 auto:pm-dead
  //    消，帧龄 19.3min；cf-dc925349 再提名=19:37:34）
  mkCard("pm-a2-gap", deadPid);
  seedFrame("pm-a2-gap", Date.now() - 20 * 60_000);
  propose();
  ok(cardAlive("pm-a2-gap"), "A2 between-turns 不消（pid>0：20min 帧龄+卡 pid 死——回合间隙=守位，旧判据必消的复现形态）");

  // A2b【R1 反转·A 审 P1 主刀】：pid=0 卡（managed 会话形态——SDK spawn 恒无 CLI pid，
  //    实锤 5e4f4963·cli-pids.json 无条目）帧龄 20min（>15min 活跃窗、<30min TTL）
  //    → **不消**。R0 断言「仍消」把病理锁成 spec（A 审证伪：managed 有 cron 周期
  //    回合退出/唤醒形态，回合间歇中位 18.0min 常态超 15min 窗——「活跃提、间歇消」
  //    循环三整轮）；R1 活跃度分支三态化后 between-turns 对 pid=0 可达。
  mkCard("pm-a2b-sdk", 0);
  seedFrame("pm-a2b-sdk", Date.now() - 20 * 60_000);
  propose();
  ok(cardAlive("pm-a2b-sdk"), "A2b(R1 反转) pid=0 卡帧龄 20min 不消——between-turns 辖区对 managed 可达（实锤卡 cf-aa1cfbb9 死法=此形态，R0 锁病断言已反转）");
  // A2b-2 循环根治论证（验收点 2）：cron 23min 周期一轮内帧龄上界 ≈23min（间歇中位
  //    18min/最大 26.3min 实测）<30min TTL——整周期内任意采样时刻消卡检查都判
  //    between-turns=卡稳定存活待用户批，「间歇消、活跃提」时序差消失
  mkCard("pm-a2b2-cron", 0);
  seedFrame("pm-a2b2-cron", Date.now() - 23 * 60_000);
  propose();
  ok(cardAlive("pm-a2b2-cron"), "A2b-2 cron 周期帧龄上界 23min 仍不消（<30min TTL——整周期稳定存活，循环根治推演锁定为断言）");
  // A2b-3 窗内 alive：pid=0 卡帧龄 5min（<15min 活跃窗）——三态之 alive
  mkCard("pm-a2b3-live", 0);
  seedFrame("pm-a2b3-live", Date.now() - 5 * 60_000);
  propose();
  ok(cardAlive("pm-a2b3-live"), "A2b-3 pid=0 卡帧龄 5min（活跃窗内）不消——alive 态");

  // A3 dead：pid 死+帧龄 45min（超 30min TTL）→ 消；pid=0 同径（影响面①：外部 SDK
  //    常驻真死消卡延迟 15→30min——45min 必消，迟消一拍无实害）
  mkCard("pm-a3-dead", deadPid);
  seedFrame("pm-a3-dead", Date.now() - 45 * 60_000);
  propose();
  ok(cardAlive("pm-a3-dead") === false, "A3 dead（pid>0 超回合 TTL）消卡——真死不滞留");
  mkCard("pm-a3b-dead0", 0);
  seedFrame("pm-a3b-dead0", Date.now() - 45 * 60_000);
  propose();
  ok(cardAlive("pm-a3b-dead0") === false, "A3b(R1) pid=0 卡帧龄 45min 消（超 30min TTL——外部 SDK 真死迟消 15→30min，用例覆盖影响面①）");
  // A3c pid=0 无帧：dead
  mkCard("pm-a3c-noframe", 0);
  propose();
  ok(cardAlive("pm-a3c-noframe") === false, "A3c pid=0 卡无任何帧→dead 消（新装会话无帧不滞留卡）");

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
  // C1（R1 更新锚）：R0 断言「未触函数体」的旧注释串已随 R1 三态化重写——枚举四态
  // 语义零变化（alive/stale/between-turns/dead），变化仅 between-turns 可达性扩达 pid=0。
  // 新锚=R1 doc 注释关键句（删失/回退即红）。
  ok(smSrc.includes('"between-turns"=pid 死**或 pid=0 帧龄超活跃窗**但回合活跃 TTL 内'), "C1(R1) pmOverrideLiveness 四态注释锚在（枚举语义零变化，between-turns 辖区扩达 pid=0——A 审裁决主刀面）");
  ok(smSrc.includes("auto:pm-dead **不入否决档**"), "C2 auto:pm-dead 不入否决档（R1-A-P1② 保持）");
  ok(smSrc.includes("if (stillPending.length > 0) return; // 他人卡在决：一次一张，不抢提"), "C3 提名一次一张节流保持");
  ok(smSrc.includes("this.pmOverrideLiveness({ cli_pid: pid, session_id: sid })"), "C4 消卡走四态单点（复用 CCR_SEAT_TURN_GAP_MIN——零新窗常量）");

  console.log(`\n== test-pmappoint-gap：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

void main();
