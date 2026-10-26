// #271 重启洗活——断言套件。三层：§R 真对象行为（SessionManager 沙盒直调 + 二次
// 重启回放不洗）/ §U 前端直跑（idleDimmed 判定恢复 + saved 排序豁免）/ §A 静态锚。
// 覆盖（任务书口径断言 ≥3）：
//   R1 重启不刷 updated_at：boot 引擎扫描摘要失配校正（adoptEngineProfiles）用转录
//      真实活动时刻——回放态旧时间戳保持原值（「全员 14:25」根修）
//   R2 journaled 帧恒带 updated_at：setExternalStatus/emit 帧载荷显式携带——二次重启
//      回放不回落信封 ts（洗活固化根修）
//   R3 ensureExternal 新卡带 updatedAt：boot 收编久休会话显示转录最后活动（非启动时刻）
//   R4 setExternalCliPid 补水帧带既有 updated_at（定位补水≠活动，重放/客户端双不洗）
//   U1 idle 判定恢复：idleDimmed 直跑——洗活时间戳（=now）不置灰 vs 诚实旧值置灰
//   U2 saved 休眠卡不置顶：web 排序 pinRank 豁免直跑
//   A  静态锚：双端 fallback 不伪造 / 排序豁免 / 载荷完整性抽样
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:bootts
import { readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { loadEvents, reduceHistory } from "../src/history.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---- 沙盒（test-ws 铁律：org/data/projects 钉仓库沙盒防生产渗入） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-bootts-org/", "../data/test-bootts-data/", "../data/test-bootts-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-bootts-org/");
process.env.CCR_DATA_DIR = SB("../data/test-bootts-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-bootts-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";
process.env.CCR_SESSIONS_ROOT = SB("../data/test-bootts-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });

const DATA = process.env.CCR_DATA_DIR;
const OLD = Date.now() - 3 * 24 * 3600_000; // 三天前：久未活跃基准
const cfg = loadConfig();
cfg.token = "t";
const eventsPath = join(DATA, "events.ndjson");
const bus = new EventBus({ persistPath: eventsPath });
const mgr = new SessionManager(bus, cfg);
type Card = { state: { session_id: string; external: boolean; status: string; action_summary: string; updated_at: number; cli_pid?: number; saved?: boolean; pinned?: boolean; started_at: number; historical?: boolean } };
const cards = (mgr as unknown as { sessions: Map<string, Card> }).sessions;

console.log("§R relay 行为面：");
// R3 ensureExternal 新卡带真实活动时刻（boot 收编不洗）
{
  const st = mgr.ensureExternal("ext-codex-old", "/tmp/x", "久休会话", "cli-1", OLD - 1000, { engine: "codex", updatedAt: OLD });
  ok(st.updated_at === OLD, "R3 ensureExternal 新卡带 updatedAt（转录最后活动，非启动时刻）");
  const st2 = mgr.ensureExternal("ext-codex-now", "/tmp/y", "新会话", "cli-2", 0, {});
  ok(Math.abs(st2.updated_at - Date.now()) < 5000, "R3' 无 updatedAt 缺省 now（新接入语义不变）");
}
// R1 boot 扫描摘要失配校正不刷时间戳（adoptEngineProfiles 原型直调，真实 mgr）
{
  const card = cards.get("ext-codex-old")!;
  card.state.status = "DONE";
  card.state.action_summary = "回放态摘要（与扫描算出的常态不等）";
  card.state.updated_at = OLD;
  const spec = { engine: "codex", label: "Codex" } as never;
  const profile = { sessionId: "old", cwd: "/tmp/x", prompt: "久休会话", title: "", startedAt: OLD - 1000, updatedAt: OLD, model: "", provider: "", status: "DONE", terminal: true, activity: "Codex 已完成" } as never;
  const proto = (Bridge.prototype as unknown as { adoptEngineProfiles(spec: unknown, profiles: unknown[], processes: unknown[] | null): void });
  proto.adoptEngineProfiles.call({ mgr, streamDeltaStop: () => {} }, spec, [profile], null); // 快照不可用形态（processes=null）
  ok(card.state.status === "DONE", "R1a 扫描到达：状态/摘要照常收敛");
  ok(card.state.action_summary === "Codex 已完成", "R1b 摘要失配校正照常生效（触发面在）");
  ok(card.state.updated_at === OLD, "R1c 摘要失配校正不刷 updated_at（转录真实活动，#271 根修——原 Date.now() 即「全员 14:25」）");
}
// R2 journaled 帧恒带 updated_at + 二次重启回放不洗
{
  const OLD2 = Date.now() - 2 * 24 * 3600_000;
  mgr.setExternalStatus("ext-codex-old", "DONE", "校正后的摘要", undefined, OLD2);
  const lines = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: { updated_at?: number } });
  const upd = lines.filter((l) => l.type === "SESSION_UPDATED");
  ok(upd.length > 0 && upd.every((l) => typeof l.payload?.updated_at === "number" && (l.payload?.updated_at ?? 0) > 0), "R2a setExternalStatus journaled 帧恒带 updated_at（重放不回落信封 ts）");
  ok(upd[upd.length - 1].payload?.updated_at === OLD2, "R2b at 参显式落帧（=真实活动时刻）");
  // R4 pid 补水帧带既有 updated_at
  cards.get("ext-codex-old")!.state.updated_at = OLD2;
  mgr.setExternalCliPid("ext-codex-old", process.pid);
  const pidLine = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: { cli_pid?: number; updated_at?: number } }).filter((l) => l.type === "SESSION_UPDATED" && l.payload?.cli_pid === process.pid);
  ok(pidLine.length === 1 && pidLine[0].payload?.updated_at === OLD2, "R4 setExternalCliPid 补水帧带既有 updated_at（定位补水≠活动）");
  // 二次重启：同 dataDir 重建（EventBus 预载 + adopt）→ 回放态 updated_at 不洗
  const bus2 = new EventBus({ preload: loadEvents(eventsPath), persistPath: eventsPath });
  const mgr2 = new SessionManager(bus2, cfg);
  const replayed = reduceHistory(loadEvents(eventsPath));
  mgr2.adopt(replayed);
  const st2 = (mgr2 as unknown as { getExternal(id: string): { updated_at: number } | undefined }).getExternal("ext-codex-old");
  ok(st2?.updated_at === OLD2, "R2c 二次重启回放：updated_at 保持真实活动时刻（洗活固化根修——原缺载帧回落信封 ts=逐次重启爬升）");
}

console.log("§U 前端直跑：");
{
  const sessionSrc = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  // U1 idleDimmed 判定（fnBody 抽取直跑）
  function fnBody(name: string): string {
    const i = sessionSrc.indexOf(`function ${name}(`);
    if (i < 0) return "";
    const j = sessionSrc.indexOf("{", i);
    let depth = 0;
    for (let k = j; k < sessionSrc.length; k++) {
      if (sessionSrc[k] === "{") depth++;
      else if (sessionSrc[k] === "}") { depth--; if (depth === 0) return sessionSrc.slice(i, k + 1); }
    }
    return "";
  }
  const bgRunning = "(s) => (s.subagents ?? []).some((a) => !a.ended_at)";
  const idleDimmed = new Function("bgRunning", "idleDimMs", `${fnBody("idleDimmed")} return idleDimmed;`)((s: never) => false, () => 30 * 60000);
  ok(idleDimmed({ status: "DONE", updated_at: Date.now() }) === false, "U1a 洗活时间戳（=now）不置灰——污染实况复现（判定输入=updated_at）");
  ok(idleDimmed({ status: "DONE", updated_at: OLD }) === true, "U1b 诚实旧值恢复置灰（#271 修复后判定随时间戳恢复）");
  ok(idleDimmed({ status: "WORKING", updated_at: OLD }) === false, "U1c WORKING 不置灰（语义保持）");
  // U2 saved 排序豁免（pinRank 内联定义，锚抽取直跑）
  const i = sessionSrc.indexOf("const pinRank = (x) =>");
  ok(i > 0, "U2a pinRank 豁免在档");
  const line = sessionSrc.slice(i, sessionSrc.indexOf("\n", i));
  const pinRank = new Function(`${line} return pinRank;`)() as (x: { pinned?: boolean; saved?: boolean }) => number;
  ok(pinRank({ pinned: true }) === 1 && pinRank({ pinned: true, saved: true }) === 0 && pinRank({}) === 0, "U2b saved 休眠卡不享 pinned 置顶浮置（活卡 pin 照常）");
}

console.log("§A 静态锚：");
{
  const sessionSrc = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  const storeSrc = readFileSync(join(root, "expo-app", "src", "store.ts"), "utf-8");
  const smSrc = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
  const bridgeSrc = readFileSync(join(root, "relay", "src", "bridge.ts"), "utf-8");
  ok(sessionSrc.includes("s.updated_at = p.updated_at || s.updated_at;"), "A1 web onSessionUpdated 缺载不伪造（保旧值）");
  ok(/#271 收紧：缺载回落\*\*既有值\*\*/.test(storeSrc) && /if \(typeof pu === "number" && pu > 0\) s\.updated_at = pu;/.test(storeSrc), "A2 expo UPDATED 缺载保旧值（不再 msg.ts 伪造）");
  ok(/setExternalStatus\(id: string, status: SessionState\["status"\], summary: string, turnStartedAt\?: number, at\?: number\)/.test(smSrc) && /s\.state\.updated_at = at \?\? Date\.now\(\);[\s\S]{0,400}updated_at: s\.state\.updated_at,/.test(smSrc), "A3 setExternalStatus at 参+载荷恒带");
  ok(/updatedAt\?: number/.test(smSrc) && /updated_at: opts\?\.updatedAt \|\| Date\.now\(\)/.test(smSrc), "A4 ensureExternal updatedAt 透传");
  ok(/provider: profile\.provider, updatedAt: profile\.updatedAt \},/.test(bridgeSrc) && /setExternalStatus\(id, desiredStatus, summary, desiredStatus === "WORKING" \? profile\.startedAt : undefined, profile\.updatedAt\);/.test(bridgeSrc), "A5 引擎收编两路（新卡+校正）都传转录真实活动");
  ok(/#271：定位补水≠会话活动[\s\S]{0,120}updated_at: s\.state\.updated_at,/.test(smSrc), "A6 pid 补水帧带既有时刻");
  ok(smSrc.includes("updated_at: s.state.updated_at, // #271：帧完整性（缺载帧重放/客户端 fallback 双洗面）"), "A7 compacting 帧带时刻");
  // 载荷完整性抽样（改名/pin 徽标帧）
  ok(readFileSync(join(root, "relay", "src", "commands", "session-commands.ts"), "utf-8").includes("updated_at: s.state.updated_at, // #271：帧完整性（改名≠活动）"), "A8 COMMAND_RENAME 帧带时刻");
  ok(readFileSync(join(root, "relay", "src", "commands", "board-commands.ts"), "utf-8").includes("updated_at: s.state.updated_at, // #271：帧完整性（pin 是 UI 态≠活动）"), "A9 pin 帧带时刻");
}

console.log(`§R-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条断言未过`); process.exit(1); }
console.log(`\n全部通过：#271 重启洗活根修（boot 不刷 updated_at / 帧恒带 / 双端不伪造 / saved 沉底）`);
process.exit(fail > 0 ? 1 : 0);
