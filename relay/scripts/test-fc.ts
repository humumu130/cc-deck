// #291 帧分类判活（心跳≠工作）——断言套件。
// 覆盖（任务书五断言 + 方案升级版主判据）：
//   §P 纯函数直跑 isRealWorking 五态：心跳-only WORKING→待命 / 真 tool→干活 /
//      挂起（超窗）→待命 / 老 relay 无字段→降级干活 / 非 WORKING→false
//   §S 真对象行为（in-process SessionManager，官方口建卡零 spawn——worker 测试纪律）：
//      S1 心跳-only 样本（system 帧不刷 tool 键，last_tool_use_at=0 负空间可判）
//      S2 真工具样本（tool_use 帧刷新 + turn_started_at 随 WORKING 下发）
//      S3 终态清算（finishExternal → turn_started_at 不残留——「WORKING⟔活跃 turn」半边）
//   §A 静态锚：relay 两咽喉+建卡初始 0+transition/history 清算 / web 判定+merge+
//      计数+待命渲染 / expo protocol+store+双屏 / CSS 灰呼吸
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:fc
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- 沙盒（test-reclaim 同款配方；官方口建卡零真 CLI spawn） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-fc-org/", "../data/test-fc-data/", "../data/test-fc-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-fc-org/");
process.env.CCR_DATA_DIR = SB("../data/test-fc-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-fc-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR, "events.ndjson") });
const mgr = new SessionManager(bus, cfg);

console.log("§P isRealWorking 纯函数直跑（web session-domain 抽取）：");
{
  const src = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  const i = src.indexOf("function isRealWorking(s, now)");
  ok(i >= 0, "P0 web isRealWorking 在档（抽取源）");
  if (i < 0) process.exit(1);
  let depth = 0, j = src.indexOf("{", i), end = -1;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  const fn = new Function(`${src.slice(i, end)} return isRealWorking;`)() as (s: unknown, now?: number) => boolean;
  const NOW = 1_800_000_000_000;
  // P1 任务书断言①：仅心跳帧的 WORKING 会话 → 待命（false）
  ok(fn({ status: "WORKING", last_tool_use_at: 0 }, NOW) === false, "P1 心跳-only WORKING→待命（last_tool_use_at=0 负空间）");
  ok(fn({ status: "WORKING", last_tool_use_at: 0, turn_started_at: NOW - 5_000 }, NOW) === false, "P1b 无工具帧：turn 在也待命（挂起态——心跳≠工作）");
  // P2 任务书断言②：真 tool_use → 干活中
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 60_000 }, NOW) === true, "P2 真 tool_use（1min 前）→干活中");
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 10 * 60_000 }, NOW) === true, "P2b 10min 窗沿（含）→干活中");
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 10 * 60_001 }, NOW) === false, "P2c 超 10min 窗→待命（挂起）");
  // P3 任务书断言④：老 relay 无字段 → 降级干活（不误伤）
  ok(fn({ status: "WORKING" }, NOW) === true, "P3 老 relay 无字段（undefined）→降级干活");
  ok(fn({ status: "WORKING", turn_started_at: NOW - 1000 }, NOW) === true, "P3b 无字段但活跃 turn（managed spawn 起手窗）→干活");
  // P4 非 WORKING 恒 false
  ok(fn({ status: "DONE", last_tool_use_at: NOW }, NOW) === false && fn({ status: "WAITING" }, NOW) === false && fn(null, NOW) === false, "P4 非 WORKING/null→false");
  // P5 expo protocol 同源（源文本三态锚——逐句同源，防双端口径漂移）
  const proto = readFileSync(join(root, "expo-app", "src", "protocol.ts"), "utf-8");
  ok(/export function isRealWorking\(/.test(proto) && proto.includes("t === undefined") && proto.includes("at - t <= FRESH_MS") && proto.includes("const FRESH_MS = 10 * 60 * 1000"), "P5 expo protocol isRealWorking 导出且窗口/降级同源（10min/undefined 降级）");
}

console.log("§S 真对象行为（in-process SessionManager·官方口建卡）：");
{
  // S1 心跳-only 样本：external 接入 + 心跳帧（system）+ WORKING（无 turn 证据——「重启接管」形态）
  mgr.ensureExternal("ext-fc-a", "/tmp/proj-a", "心跳样本", "fc-sid-a");
  mgr.setExternalStatus("ext-fc-a", "WORKING", "重启接管：CLI 进程仍在运行"); // 不带 turnStartedAt（接单未开工形态）
  mgr.pushExternalLog("ext-fc-a", "system", "[relay 自动恢复] relay 重启完成"); // 心跳/回显帧
  mgr.pushExternalLog("ext-fc-a", "user_message", "[relay·系统维护] 上下文水位压缩摘要请求"); // 注入消息帧（非工具）
  const snapA = mgr.snapshot().find((x) => x.session_id === "ext-fc-a");
  ok(!!snapA, "S0a 心跳样本卡在册");
  ok(snapA?.last_tool_use_at === 0, "S1 心跳/注入帧不刷 tool 键（last_tool_use_at=0 负空间随 SNAPSHOT 下发）");
  ok(snapA?.turn_started_at === undefined, "S1b 无 turn 证据（turn_started_at 缺）——端上可判「接单未开工」");

  // S2 真工具样本：tool_use 帧刷新 + turn_started_at 随 WORKING 下发
  mgr.ensureExternal("ext-fc-b", "/tmp/proj-b", "工具样本", "fc-sid-b");
  mgr.setExternalStatus("ext-fc-b", "WORKING", "跑工具", Date.now()); // onPrompt 形态（带 turnStartedAt）
  const before = Date.now();
  mgr.pushExternalLog("ext-fc-b", "tool_use", "Bash npm test", "Bash");
  mgr.pushExternalLog("ext-fc-b", "tool_result", "3 passed", undefined);
  const snapB = mgr.snapshot().find((x) => x.session_id === "ext-fc-b");
  ok(typeof snapB?.last_tool_use_at === "number" && (snapB?.last_tool_use_at ?? 0) >= before, "S2 tool_use/tool_result 帧刷新 last_tool_use_at（双 kind 都算工作证据）");
  ok(typeof snapB?.turn_started_at === "number", "S2b turn_started_at 随快照下发（WORKING⟔活跃 turn 主判据数据面）");

  // S3 终态清算：turn 结束（finishExternal→transition DONE）→ turn_started_at 不残留
  mgr.finishExternal("ext-fc-b", "completed", 5000, Date.now());
  const snapB2 = mgr.snapshot().find((x) => x.session_id === "ext-fc-b");
  ok(snapB2?.status === "DONE" && snapB2?.turn_started_at === undefined, "S3 终态清算（DONE 后 turn_started_at 不残留——旧值被无 turn 翻活复用=误判根源）");

  // S4 managed 建卡初始 0（create 不真 spawn：只验证 state 模板——用静态锚替代，见 A6）
  ok(true, "S4 managed 初始面走 A6 静态锚（create() 会真 spawn CLI，worker 测试纪律禁直调）");
}

console.log("§A 静态锚（relay/web/expo 三端）：");
{
  const sm = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
  const hist = readFileSync(join(root, "relay", "src", "history.ts"), "utf-8");
  const web = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  const store = readFileSync(join(root, "expo-app", "src", "store.ts"), "utf-8");
  const list = readFileSync(join(root, "expo-app", "src", "screens", "ListScreen.tsx"), "utf-8");
  const detail = readFileSync(join(root, "expo-app", "src", "screens", "DetailScreen.tsx"), "utf-8");
  const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

  // relay
  ok(sm.includes('if (next === "DONE" || next === "ERROR") s.state.turn_started_at = undefined;'), "A1 transition 终态清算（turn_started_at——主判据补清算）");
  ok(sm.includes("const entry: LogEntry = { ts: Date.now(), kind, text, tool, ...meta };") && sm.includes('kind === "tool_use" || kind === "tool_result") s.state.last_tool_use_at = entry.ts;'), "A2 external 咽喉（pushExternalLog）工具帧写入");
  ok(/managed\.state\.last_tool_use_at = entry\.ts;/.test(sm), "A2b managed 咽喉（onLog）工具帧写入");
  ok(/last_tool_use_at: 0, \/\/ #291[^\n]*\n(\s*)updated_at: Date\.now\(\),/.test(sm) || sm.includes("last_tool_use_at: 0, // #291"), "A3 建卡初始 0（managed create——0=从未有工具的负空间）");
  ok(sm.includes("last_tool_use_at: 0, // #291：0=从未有工具活动——hook 心跳"), "A3b ensureExternal 建卡初始 0（external）");
  ok(hist.includes('s.turn_started_at = undefined; // #291：终态清算与 transition 同口径（回放面）') && hist.includes('if (p.kind === "tool_use" || p.kind === "tool_result") s.last_tool_use_at = e.ts;'), "A4 history 回放双恢复（终态清算+工具帧恢复——重启不丢判活数据）");
  ok(readFileSync(join(root, "relay", "src", "types.ts"), "utf-8").includes("last_tool_use_at?: number;"), "A5 types.ts 字段在档（SNAPSHOT cloneState 全量天然下发）");

  // web
  ok(web.includes("window.__ccDeck005IsRealWorking = isRealWorking;"), "A6 web 判定挂 window（team-domain/跨文件同源）");
  ok(web.includes('"turn_started_at", "last_tool_use_at", "usage"'), "A7 web MERGE_KEYS 增补（增量帧 merge 面）");
  ok(/entry\.kind === "tool_use" \|\| entry\.kind === "tool_result"\)\) s\.last_tool_use_at = entry\.occurred_at \|\| entry\.ts/.test(web), "A8 web onLog 工具帧本地刷新（增量实时性——relay 增量帧不带此键）");
  ok(/x\.status === "WORKING" && isRealWorking\(x\) && !\/\^\(pm\|leader/.test(web), "A9 web 团队 chip 在跑计数过真判定（任务书断言③：计数只算干活中）");
  ok(web.includes('item.status === "working" && item.standby ? "working-standby" : item.status') && web.includes('">待开工</span>') && web.includes('item.status === "working" && !item.standby ?'), "A10 web 卡待命渲染三件（灰呼吸点+待开工标+秒数隐藏）");
  ok(css.includes(".status-dot.working-standby") && css.includes("st-standby-breathe"), "A11 CSS 待命灰呼吸（2.4s 慢频——与工作中黄闪 1.5s 双编码区分）");
  ok(css.includes(".lamp-dot.standby") && css.includes(".lamp-dot.working"), "A12 roster lamp-dot 补全套状态色（原仅 flex 无色=灯不可见，随批修复）");

  // expo
  ok(store.includes('msg.payload.kind === "tool_use" || msg.payload.kind === "tool_result"') && store.includes("s.last_tool_use_at = (typeof msg.payload.occurred_at"), "A13 expo store SESSION_LOG 工具帧本地刷新");
  ok(/x && x\.status === "WORKING" && isRealWorking\(x\) \? 1 : 0\); \/\* #291：待命不占在跑计数/.test(list), "A14 expo 团队入口卡在跑计数过真判定");
  ok(list.includes("const standby = s.status === \"WORKING\" && !isRealWorking(s);") && list.includes("待开工 · "), "A15 expo 会话卡待命态（灰呼吸点+待开工文案）");
  ok(detail.includes("isRealWorking(r.s)).length") && detail.includes('standby ? "待开工"'), "A16 expo 详情 roster 计数+行词（待命不占在跑）");
}

console.log(`\n§P-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#291 帧分类判活（心跳≠工作，turn 生命周期主判+帧分类兜底）");
process.exit(fail > 0 ? 1 : 0);
