// #291 帧分类判活（心跳≠工作）——断言套件。
// 覆盖（任务书五断言 + 审查 291-A/B 修复批锚）：
//   §P 纯函数直跑 isRealWorking 五态：心跳-only WORKING→待命 / 真 tool→干活 /
//      挂起（超窗）→待命 / 老 relay 无字段→降级干活 / 非 WORKING→false
//      （帧分类单判据·15min 窗——审查 291-A 终版裁决：turn 生命周期由 relay 状态机
//       承担，端上不加 turn 分支防 spawn 挂起误判复活）
//   §S 真对象行为（in-process SessionManager，官方口建卡零 spawn——worker 测试纪律）：
//      S1 心跳-only 样本（system 帧不刷 tool 键，last_tool_use_at=0 负空间可判）
//      S2 真工具样本（tool_use 帧刷新 + turn_started_at 随 WORKING 下发）
//      S3 终态清算（finishExternal → turn_started_at 不残留）
//      S5 CREATED 增量帧带 last_tool_use_at:0（审查 B-P1-1：长连接面板建卡不降级）
//      S6 WAITING 不清算（权限问询=turn 内挂起，回 WORKING 秒表续跑）
//   §R 回放行为断言（reduceHistory 直跑——审查 A-P2③：终态清算/工具帧恢复/建卡归一）
//   §A 静态锚：relay 两咽喉+CREATED 帧+transition/history 清算+翻活补锚 /
//      web 判定+merge+计数+待命渲染+mobile.js 第四面+team-domain 成员卡 / expo 三屏
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:fc
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { reduceHistory } from "../src/history.js";
import type { Envelope } from "../src/types.js";

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
const journal = join(process.env.CCR_DATA_DIR, "events.ndjson");
const bus = new EventBus({ persistPath: journal });
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
  ok(fn({ status: "WORKING", last_tool_use_at: 0, turn_started_at: NOW - 5_000 }, NOW) === false, "P1b 起手窗（t=0+turn 新）→待命（帧分类单判据——审查 291-A 终版：turn 窗会复活 spawn 挂起误判；首个工具帧分钟级自纠）");
  // P2 任务书断言②：真 tool_use → 干活中
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 60_000 }, NOW) === true, "P2 真 tool_use（1min 前）→干活中");
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 15 * 60_000 }, NOW) === true, "P2b 15min 窗沿（含）→干活中（对齐 relay sweep hooked 窗 900s——审查 A-P2-1）");
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 15 * 60_001 }, NOW) === false, "P2c 超 15min 窗→待命（挂起）");
  ok(fn({ status: "WORKING", last_tool_use_at: NOW - 12 * 60_000 }, NOW) === true, "P2d 长工具段（12min——本仓自测链常态）→干活中（10min 窗会误判的形态）");
  // P3 任务书断言④：老 relay 无字段 → 降级干活（不误伤）
  ok(fn({ status: "WORKING" }, NOW) === true, "P3 老 relay 无字段（undefined）→降级干活");
  // P4 非 WORKING 恒 false
  ok(fn({ status: "DONE", last_tool_use_at: NOW }, NOW) === false && fn({ status: "WAITING" }, NOW) === false && fn(null, NOW) === false, "P4 非 WORKING/null→false");
  // P5 expo protocol 同源（源文本三态锚——逐句同源，防双端口径漂移）
  const proto = readFileSync(join(root, "expo-app", "src", "protocol.ts"), "utf-8");
  ok(/export function isRealWorking\(/.test(proto) && proto.includes("t === undefined") && proto.includes("at - t <= FRESH_MS") && proto.includes("const FRESH_MS = 15 * 60 * 1000") && !proto.includes("turn_started_at?: number } | null", 0), "P5 expo protocol isRealWorking 同源（15min 窗/undefined 降级/无 turn 分支）");
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
  ok(typeof snapB?.turn_started_at === "number", "S2b turn_started_at 随快照下发（计时显示数据面）");

  // S3 终态清算：turn 结束（finishExternal→transition DONE）→ turn_started_at 不残留
  mgr.finishExternal("ext-fc-b", "completed", 5000, Date.now());
  const snapB2 = mgr.snapshot().find((x) => x.session_id === "ext-fc-b");
  ok(snapB2?.status === "DONE" && snapB2?.turn_started_at === undefined, "S3 终态清算（DONE 后 turn_started_at 不残留——旧值被无 turn 翻活复用=误判根源）");

  // S5 CREATED 增量帧带键（审查 B-P1-1）：建卡帧落 journal，末条 CREATED 应带 last_tool_use_at:0
  mgr.ensureExternal("ext-fc-c", "/tmp/proj-c", "增量建卡样本", "fc-sid-c");
  const createdFrames = readFileSync(journal, "utf-8").trim().split("\n")
    .map((l) => JSON.parse(l) as { type: string; session_id: string; payload?: Record<string, unknown> })
    .filter((e) => e.type === "SESSION_CREATED");
  const lastC = createdFrames[createdFrames.length - 1];
  ok(lastC?.session_id === "ext-fc-c" && lastC?.payload?.last_tool_use_at === 0, "S5 CREATED 增量帧带 last_tool_use_at:0（长连接面板建卡即判活——老 relay 降级档不再渗入新卡）");

  // S6 WAITING 不清算（权限问询=turn 内挂起——回来继续跑，秒表不归零）
  mgr.setExternalWaiting("ext-fc-c", { request_id: "fc-w1", tool_name: "Bash", input_summary: "npm test", suggestions: [], decidable: true, received_at: Date.now() });
  const snapC = mgr.snapshot().find((x) => x.session_id === "ext-fc-c");
  ok(snapC?.status === "WAITING", "S6a WAITING 到位");
  const snapD = mgr.snapshot().find((x) => x.session_id === "ext-fc-b");
  ok(snapD?.status === "DONE" && snapD?.turn_started_at === undefined, "S6b 回归确认：终态仍清（S3 不受 S6 路径影响）");
}

console.log("§R 回放行为断言（reduceHistory 直跑——审查 A-P2③）：");
{
  const mk = (session_id: string, ts: number, type: string, payload: unknown): Envelope => ({ session_id, ts, type, payload }) as Envelope;
  // R1 新 relay 完整链：CREATED(带 0)→工具帧→DONE——终态清算+工具帧恢复
  const ev1: Envelope[] = [
    mk("rp-a", 1000, "SESSION_CREATED", { cwd: "/tmp", initial_prompt: "p", model: "m", last_tool_use_at: 0 }),
    mk("rp-a", 2000, "SESSION_LOG", { ts: 2000, kind: "tool_use", text: "Bash" }),
    mk("rp-a", 3000, "SESSION_UPDATED", { status: "WORKING", action_summary: "s", stats: {}, turn_started_at: 1500 }),
    mk("rp-a", 4000, "SESSION_DONE", { terminal_reason: "completed", duration_ms: 3000, stats: {} }),
  ];
  const r1 = reduceHistory(ev1).get("rp-a")?.state;
  ok(r1?.status === "DONE" && r1?.turn_started_at === undefined, "R1a 回放终态清算（DONE 后 turn_started_at 不残留）");
  ok(r1?.last_tool_use_at === 2000, `R1b 回放工具帧恢复（last_tool_use_at=2000，实 ${r1?.last_tool_use_at}）`);
  ok(typeof r1?.last_tool_use_at === "number", "R1c 回放建卡归一（CREATED 带 0 → 键在档，非 undefined 降级档）");
  // R2 老 relay 帧（CREATED 无键）：回放 undefined——端上降级档（首个工具帧起算）
  const ev2: Envelope[] = [
    mk("rp-b", 1000, "SESSION_CREATED", { cwd: "/tmp", initial_prompt: "p", model: "m" }),
    mk("rp-b", 5000, "SESSION_LOG", { ts: 5000, kind: "tool_use", text: "Edit" }),
  ];
  const r2 = reduceHistory(ev2).get("rp-b")?.state;
  ok(r2?.last_tool_use_at === 5000, "R2 老帧缺键回放：工具帧仍起算（undefined→5000）");
  const ev3: Envelope[] = [
    mk("rp-c", 1000, "SESSION_CREATED", { cwd: "/tmp", initial_prompt: "p", model: "m" }),
    mk("rp-c", 5000, "SESSION_LOG", { ts: 5000, kind: "system", text: "心跳" }),
  ];
  const r3 = reduceHistory(ev3).get("rp-c")?.state;
  ok(r3?.last_tool_use_at === undefined, "R3 老帧无工具帧回放：undefined（端上降级档——审查 A-P2-2 已知代价，SNAPSHOT 面新卡带 0 收敛）");
}

console.log("§A 静态锚（relay/web/expo 四面）：");
{
  const sm = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
  const hist = readFileSync(join(root, "relay", "src", "history.ts"), "utf-8");
  const web = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  const mobile = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");
  const team = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
  const store = readFileSync(join(root, "expo-app", "src", "store.ts"), "utf-8");
  const list = readFileSync(join(root, "expo-app", "src", "screens", "ListScreen.tsx"), "utf-8");
  const detail = readFileSync(join(root, "expo-app", "src", "screens", "DetailScreen.tsx"), "utf-8");
  const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

  // relay
  ok(sm.includes('if (next === "DONE" || next === "ERROR") s.state.turn_started_at = undefined;'), "A1 transition 终态清算（turn_started_at——relay 状态机「WORKING⟔活跃 turn」半边）");
  ok(sm.includes('kind === "tool_use" || kind === "tool_result") s.state.last_tool_use_at = meta?.occurred_at ?? entry.ts;'), "A2 external 咽喉（pushExternalLog）工具帧写入·occurred_at 优先（审查 A-P2①：与端上同口径，scan 回灌不虚胖）");
  ok(sm.includes("managed.state.last_tool_use_at = metaOccurredAt ?? entry.ts;"), "A2b managed 咽喉（onLog）工具帧写入·同口径");
  ok(/last_tool_use_at: 0, \/\/ #291[^\n]*\n(\s*)updated_at: Date\.now\(\),/.test(sm), "A3 managed create 初始 0（0=从未有工具的负空间）");
  ok(sm.includes("last_tool_use_at: 0, // #291：0=从未有工具活动——hook 心跳"), "A3b ensureExternal 建卡初始 0");
  ok((sm.match(/last_tool_use_at: 0, \/\/ #291 审查 B-P1-1/g) ?? []).length === 2, "A3c CREATED 增量帧双发射点带键（external+managed——长连接面板建卡即判活）");
  ok(hist.includes('s.turn_started_at = undefined; // #291：终态清算与 transition 同口径（回放面）') && hist.includes('if (p.kind === "tool_use" || p.kind === "tool_result") s.last_tool_use_at = e.ts;'), "A4 history 回放双恢复（终态清算+工具帧恢复）");
  ok(hist.includes("...(p.last_tool_use_at !== undefined ? { last_tool_use_at: p.last_tool_use_at } : {})"), "A4b 回放建卡归一（CREATED 帧带键则落——R1c 行为面对应）");
  ok(readFileSync(join(root, "relay", "src", "types.ts"), "utf-8").includes("last_tool_use_at?: number; // #291：新 relay 建卡帧恒带 0"), "A5 types.ts 双字段在档（SessionState+SessionCreatedPayload）");
  ok((sm.match(/turn_started_at = Date\.now\(\); \/\/ #291 审查 A-P3-1/g) ?? []).length === 3, "A5b 翻活三处补 turn 锚（resume fresh/积压补投/恢复中——秒表起点，审查 A-P3-1）");

  // web 主面
  ok(web.includes("window.__ccDeck005IsRealWorking = isRealWorking;"), "A6 web 判定挂 window（跨文件共享）");
  ok(web.includes('"turn_started_at", "last_tool_use_at", "usage"'), "A7 web MERGE_KEYS 增补（增量帧 merge 面）");
  ok(/entry\.kind === "tool_use" \|\| entry\.kind === "tool_result"\)\) s\.last_tool_use_at = entry\.occurred_at \|\| entry\.ts/.test(web), "A8 web onLog 工具帧本地刷新·occurred_at 优先（与 relay 咽喉同口径）");
  ok(/x\.status === "WORKING" && isRealWorking\(x\) && !\/\^\(pm\|leader/.test(web), "A9 web 团队 chip 在跑计数过真判定（任务书断言③：计数只算干活中）");
  ok(/roster\.filter\(\(r\) => r\.status === "WORKING" && \(\(\) => \{ const rs = S\.sessions\.get\(r\.sid\); return rs \? isRealWorking\(rs\) : true; \}\)\(\)\)/.test(web), "A9b 抽屉 roster 计数过真判定（审查 B-P1-2：同屏灯灰计数+1 自相矛盾根除；rs 未同步保守按干活）");
  ok(web.includes('item.status === "working" && item.standby ? "working-standby" : item.status') && web.includes('">待开工</span>') && web.includes('item.status === "working" && !item.standby ?'), "A10 web 卡待命渲染三件（灰呼吸点+待开工标+秒数隐藏）");
  ok(css.includes(".status-dot.working-standby") && css.includes("st-standby-breathe"), "A11 CSS 待命灰呼吸（2.4s 慢频——与工作中黄闪 1.5s 双编码区分）");
  ok(css.includes(".lamp-dot.standby") && css.includes(".lamp-dot.working"), "A12 roster lamp-dot 补全套状态色（原仅 flex 无色=灯不可见，随批修复）");
  ok(mobile.includes("const isRealW = (s) => (window.__ccDeck005IsRealWorking") && (mobile.match(/WORKING" && isRealW\(s\)/g) ?? []).length >= 3 && mobile.includes('? "待开工" :'), "A13 mobile.js 第四面（组头计数×2+看板泳道+状态标签——审查 A-P2②/B-P2-3）");
  ok(team.includes('window.__ccDeck005IsRealWorking && !window.__ccDeck005IsRealWorking(session) ? "working-standby"'), "A14 team-domain 成员卡灯接真判定（审查 B-P2-4：挂而未接根除）");

  // expo
  ok(store.includes('msg.payload.kind === "tool_use" || msg.payload.kind === "tool_result"') && store.includes("conn.sessions.set(sid, { ...s, last_tool_use_at:"), "A15 expo store 工具帧刷新+对象替换（审查 B-P2-2：memo 卡翻转不再等 SESSION_UPDATED）");
  ok(/x && x\.status === "WORKING" && isRealWorking\(x\) \? 1 : 0\); \/\* #291：待命不占在跑计数/.test(list), "A16 expo 团队入口卡在跑计数过真判定");
  ok(list.includes("const standby = s.status === \"WORKING\" && !isRealWorking(s);") && list.includes("待开工 · "), "A17 expo 会话卡待命态（灰呼吸点+待开工文案）");
  ok(detail.includes("isRealWorking(r.s)).length") && detail.includes('standby ? "待开工"'), "A18 expo 详情 roster 计数+行词（待命不占在跑）");
  ok(web.includes("已接单未开工或挂起（无近期工具活动）") && web.includes('"⏸ 待开工 "') && mobile.includes("待开工</b><span>已接单未开工或挂起") && detail.includes('"⏸ 待开工 · "'), "A19 详情/dock/mobile 同屏一致（审查 B-P2-2：卡待开工而详情运行中走秒的矛盾根除——四面同一判定）");
  ok(detail.includes("isRealWorking(s) && s.turn_started_at ? fmtElapsed"), "A19b expo 详情 turnRun 待命不走秒");
}

console.log(`\n§P-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#291 帧分类判活（心跳≠工作·帧分类单判据 15min 窗+turn 生命周期状态机收口）");
process.exit(fail > 0 ? 1 : 0);
