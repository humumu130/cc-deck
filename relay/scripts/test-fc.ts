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
  const fz = readFileSync(join(root, "web-console", "js", "fzone.js"), "utf-8"); // W-FZONE-B1
  const fzCss = css; // W-UIB1 审查 P0 教训：CSS max-width 独立于 JS clamp——内联 width 突不破类规则，探针只锚 JS 面=放档假绿（800 截死三套探针全漏）；复审 P3：复用既有 css 读口免重复 IO
  const html = readFileSync(join(root, "web-console", "index-005.html"), "utf-8"); // W-FZONE-B1

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
  ok(web.includes('item.status === "working" && item.standby ? "working-standby" : item.status') && web.includes('title="已接单未开工或挂起——无近期工具活动，不占在跑计数（#291 待命）"') && !web.includes('">待开工</span>') && web.includes('item.status === "working" && !item.standby ?'), "A10 web 卡待命渲染三件（灰呼吸点+dot title 承载语义+秒数隐藏；W-STATUSCHIP 1109：『待开工』tag 退役负断言——灯表意不占词）");
  ok(web.includes('item.pmStandby ? \' title="值守 PM 常驻待命（空闲自动保活 · #287）"\'') && !web.includes('>待命</span>') && !web.includes('tag mini') && web.includes('pmStandby: session.pm_standby === true'), "A10b pmStandby『待命』tag 退役（W-STANDBYKILL 1110 二轮：一轮降档仍嫌大整段杀——#287 语义并入 dot title；负断言锁 tag 文本+类名双零+派生不动锚）");
  ok(css.includes(".status-dot.working-standby") && css.includes("st-standby-breathe"), "A11 CSS 待命灰呼吸（2.4s 慢频——与工作中黄闪 1.5s 双编码区分）");
  ok(css.includes(".lamp-dot.standby") && css.includes(".lamp-dot.working"), "A12 roster lamp-dot 补全套状态色（原仅 flex 无色=灯不可见，随批修复）");
  ok(mobile.includes("const isRealW = (s) => (window.__ccDeck005IsRealWorking") && (mobile.match(/WORKING" && isRealW\(s\)/g) ?? []).length >= 3 && mobile.includes('? "待开工" :'), "A13 mobile.js 第四面（组头计数×2+看板泳道+状态标签——审查 A-P2②/B-P2-3）");
  ok(team.includes('window.__ccDeck005IsRealWorking && !window.__ccDeck005IsRealWorking(session) ? "working-standby"'), "A14 team-domain 成员卡灯接真判定（审查 B-P2-4：挂而未接根除）");

  // expo
  ok(store.includes('msg.payload.kind === "tool_use" || msg.payload.kind === "tool_result"') && store.includes("conn.sessions.set(sid, { ...s, last_tool_use_at:"), "A15 expo store 工具帧刷新+对象替换（审查 B-P2-2：memo 卡翻转不再等 SESSION_UPDATED）");
  ok(/x && x\.status === "WORKING" && isRealWorking\(x\) \? 1 : 0\); \/\* #291：待命不占在跑计数/.test(list), "A16 expo 团队入口卡在跑计数过真判定");
  ok(list.includes("const standby = s.status === \"WORKING\" && !isRealWorking(s);") && list.includes('accessibilityLabel={"待开工，"') && !list.includes("待开工 · "), "A17 expo 会话卡待命态（灰呼吸点#a11y 承载词；W-STATUSCHIP 1109：行内词冠退役负断言——摘要回 srowSum 原生档）");
  ok(detail.includes("isRealWorking(r.s)).length") && detail.includes('standby ? "待开工"'), "A18 expo 详情 roster 计数+行词（待命不占在跑）");
  ok(web.includes("已接单未开工或挂起（无近期工具活动）") && web.includes('"待命 · 可接单"') /* W-DOCKFIX 语义等价迁移：dock 待命文案随方案 A 一行流改（isRealWorking 同判定不动） */ && mobile.includes("待开工</b><span>已接单未开工或挂起") && detail.includes('"⏸ 待开工 · "'), "A19 详情/dock/mobile 同屏一致（审查 B-P2-2：卡待开工而详情运行中走秒的矛盾根除——四面同一判定）");
  ok(detail.includes("isRealWorking(s) && s.turn_started_at ? fmtElapsed"), "A19b expo 详情 turnRun 待命不走秒");

  // ============ F. W-FZONE-B1 文件工作区批一（1111 拍板 B：tab 骨架+三格式+点击链路） ============
  // W-FZONE-R4：F1/F7/F9 锚随第四轮迁移改版（session-shell 行容器+fzone=会话面板整列的兄弟+冷启必收起+窄窗禁浮层）
  ok(html.includes('class="session-shell"') && html.includes('id="fzone"') && html.includes('js/fzone.js'), "F1 容器骨架（R4 session-shell 行容器+#fzone 面板+fzone.js 挂载——工作区=app 内容区级右列）");
  ok(fz.includes("data-fz-tab") && fz.includes("data-fz-close") && fz.includes("const hit = state.tabs.find((t) => t.id === id);") && fz.includes("return; } // 聚焦已有 tab"), "F2 tab 系统（切换/关闭/同文件重开=聚焦不重复——任务书铁则）");
  ok(fz.includes("auxclick") && fz.includes("ccd_fzone_w") && !fz.includes("ccd_fzone_open") && !fz.includes("setItem(OPEN_KEY") && fz.includes('localStorage.getItem(W_KEY)'), "F3 中键关闭+拖宽 localStorage 宽度记忆（R3 口径 440/clamp[340,800]；P2 批五：OPEN_KEY 全退役负向锚——常量/写点零残留防回潮）");
  ok(web.includes("window.__ccDeck005FzoneLoad = loadFzoneContent") && web.includes("fz-code-n") && web.includes("fz-md") && web.includes("fz-img") && web.includes("2 * 1048576") && web.includes("data-fz-retry") && web.includes("if (!el.isConnected) return;"), "F4 三格式加载器（md=mdHtml 同款/代码=行号槽+synHtml/图片=blob+点击原尺寸；>2MB 头部截断；重试钮；关 tab 弃置回包守卫）");
  ok(web.includes("SHEET_TEXT_EXT.has(ext)") && web.includes('new Set(["csv", "tsv", "json", "jsonl", "jsonc", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties"])') && !web.includes('AV_TEXT_EXTRA.has(ext) || kind === "sheet"'), "F4b sheet 桶二进制守卫（xlsx/xls/numbers/plist/db/sqlite 不进文本渲染落兜底卡——文本安全子集放行，W-P2TAIL 修 fzone-b1-review-a P2；负向锚=整桶放行旧串不得回归）");
  ok(web.includes('.tabpage-pane .art-row, #session-body .art-row') && web.includes("openFzoneTab(String(artRow.dataset.path") && web.includes("openFzoneTab(afView.dataset.afView") && web.includes('const fp = ev.target.closest(".fpath")') && web.includes("frefResolvePath(String(fp.dataset.p)") && web.includes("if (fzReg) { openFzoneTab(fzReg); return; }"), "F5 点击入口三轨（输出物行整行/眼睛钮/消息文本路径 token 改道先行于复制兜底——批一自 av 模态改道；原死代码口已除；W-TABPAGE-R1：行选择器双形态=tabpage 迁移后 #session-body 恒 NULL 断链修）");
  ok(web.includes('p.endsWith("/" + t)') && web.includes("p.split(/[\\\\/]/).pop() === base"), "F6 登记面对齐守卫（basename/尾段命中才开——未登记路径零动作防探测）");
  ok(css.includes(".fzone .wtab.on::after") && css.includes(".fz-code") && css.includes(".fz-sash") && css.includes(".session-shell"), "F7 CSS（R4：brand 顶条/行号双列/4px col-resize sash/session-shell 行容器）");
  ok(web.includes("function loadAvContent") && web.includes("av-md"), "F8 av 模态管线保留（批一改道不拆——下载/定位钮链不破，批二处置）；md 渲染消息同款复用零分叉");
  ok(html.includes("data-fzone-toggle") && fz.includes('document.addEventListener("click"') && fz.includes("[data-fzone-toggle]") && fz.includes("classList.toggle(\"on\", on)") && !css.includes("max-width: 1199px") && !css.includes(".session-split > .fzone") && fz.includes("空 · 点消息里的文件") && fz.includes("NARROW_W"), "F9 常驻开关钮（收起后唯一再展开入口+on 态回显）+R4 窄窗禁浮层（<1200 覆盖媒体查询负向锚+极窄收起改由 fzone.js NARROW_W 单向承载）+空态提示卡");
  // W-FZONE-R4（1112 用户四轮打回·第四轮定谳「在外面，在右侧」）：fzone=app 内容区级右列——不在会话面板（session-detail）内的层级锚
  {
    const iShell = html.indexOf('class="session-shell"'), iShellEnd = html.indexOf("</div><!-- /.session-shell -->"),
      iDetail = html.indexOf('class="session-detail"'), iDetailEnd = html.indexOf("</div><!-- /.session-detail -->"),
      iSash = html.indexOf('class="fz-sash"'), iFz = html.indexOf('<aside class="fzone"');
    ok(iDetail >= 0 && iDetailEnd >= 0 && iDetailEnd < iSash && iSash < iFz, "R4-1 fz/sash 不在 session-detail 内（会话面板闭标签在 sash/fzone 之前——用户口径①②④「工作区不在会话面板里面」字符串序锚）");
    ok(iShell >= 0 && iShell < iDetail && iDetail < iShellEnd && iFz < iShellEnd, "R4-2 sash 与 session-detail 同为 session-shell 子级（#d-session 网格第二列 occupant=session-shell——工作区整列独立于会话面板，如会话列表是左列）");
    ok(!html.includes('class="session-split"'), "R4-2b session-split 行容器退役负向锚（R3 形态不得回归）");
    ok(!html.includes("workspace-main"), "R4-3 旧 workspace-main 行容器退役（分栏藏在会话详情容器内的病灶结构不得回归）");
    ok(fz.includes('Math.max(340, Math.min(1200, availMax(), Math.round(window.innerWidth * 0.85)') && fzCss.includes(".fzone { position: relative; display: flex; flex-direction: column; flex-shrink: 0; height: 100%; width: 440px; min-width: 340px; max-width: 1200px;") && fz.includes(": 440; // 缺省 440") && fz.includes('document.querySelector("#d-session .fz-sash[data-fz-resize]")') && fz.includes('document.body.style.userSelect = "none";') && fz.includes("sash.hidden = !on;"), "R4-4 拖拽/宽度同构保留（W-UIB0 批零规格：clamp[340,1200]+0.85vw+availMax 三钳+CSS max-width 同值双面锚+默认 440+sash 查询迁移后仍中+拖拽 body cursor/userSelect 锁+sash 随开合联动）");
    ok(css.includes("width: 4px") && css.includes("cursor: col-resize") && css.includes(".fz-sash[hidden] { display: none; }") && css.includes("width: 440px") && css.includes(".session-shell > .session-detail"), "R4-5 CSS 锚（__detail-sash 4px col-resize+hidden 互斥+__detail-panel 定宽 440+session-shell>session-detail 会话列 flex 让位）");
    // R4-6：会话头只在会话列（用户口径④「head 压工作区」根治）——head 在 session-detail 内、会话体之上
    {
      const iHead = html.indexOf('<header class="workspace-head"'), iHeadEnd = html.indexOf("</header>", iHead), iWsOpen = html.indexOf('<section class="workspace"');
      ok(iDetail < iHead && iHeadEnd >= 0 && iHeadEnd < iDetailEnd && iHeadEnd < iWsOpen, "R4-6 会话头只在会话列：head 在 session-detail 内、会话体之上（head.right≤session-detail.right 不横跨工作区；workspace 只包消息/状态条/输入框）");
    }
    ok(!css.includes("max-width: 1199px") && !css.includes(".session-split > .fzone") && !css.includes("top: 0; right: 0; bottom: 0; z-index: 7"), "R4-7 窄窗禁浮层负向锚（<1200 覆盖媒体查询+fzone absolute 浮层规则不得回归——任何宽度都是真实列，用户口径④「tab 内容跑到对话面板来了」病灶）");
    // W-UIP2（1115 test.18 用户 #169/#170/#171 三件）专项锚
    const nbSrc = readFileSync(join(root, "web-console", "js", "navbar.js"), "utf-8");
    ok(nbSrc.includes("1 + 2.2 * Math.exp(-(d * d) / 3200)") && !nbSrc.includes("1 + 0.9 *"), "UIP2-1 fisheye 强化（峰值 1.9→3.2×/σ 46→40——命中 tick 12×3.2≈38px ≥36；旧 0.9 因子负向锚）");
    ok(css.includes("height: 16px; padding: 0 12px 0 14px") && css.includes("padding: 4px 0; scrollbar-width: none") && css.includes("right: 8px") && css.includes("calc(22% + 26% * (var(--fz, 1) - 1) / 2.2)"), "UIP2-2 导航条四修（行高 26→22→16 NAVR5 密度档+行距 6→4+贴边 right 34→8+亮度随 --fz 插值 22→48%）");
    ok(css.includes("#d-session .workspace-body { padding-right: 66px; }") && css.includes("#d-session .queue.fz-yield"), "UIP2-3 让位双面（消息区右距 22→66px=轨道独立带重叠根治+会话列表 fz-yield 收起类）");
    ok(fz.includes("autoYielded") && fz.includes('data-fz-recall-queue') && fz.includes("窄屏：会话列表已自动收起给工作区让位") && fz.includes("if (!narrow && wasNarrow && autoYielded) yieldQueue(false, false)"), "UIP2-4 小屏让位链（fzone 开+<1200→列表 yield+toast；收起→autoYielded 记账还原；跨阈值 resize 同链；「☰ 列表」呼出钮清记账）");
    ok(web.includes('外部路径已复制') && web.includes("raw.startsWith(\"/\") ? raw") && web.includes('S.homedir.replace'), "UIP2-5 .fpath 直开工作区（绝对路径 / 直开+~/ homedir 展开→openFzoneTab 同链；外部引用复制 toast 文案差异化）");
    ok(!fz.includes("if (remembered) setOpen(true") && fz.includes("const NARROW_W = 1200") && fz.includes("narrow && !wasNarrow && !root.hidden"), "R4-8 冷启必收起（OPEN_KEY 自动展开不得回潮——用户口径④「切不掉」病灶）+窄域 <1200 单向自动收起（R4-R1 刀二 1000→1200——审二第五轮直答①「细条可用」带；窄域内 resize 不抢用户手动再开）");
    ok(fz.includes("const CHAT_FIT = 442") && fz.includes("function availMax") && fz.includes("Math.min(1200, availMax(), Math.round(window.innerWidth * 0.85)") && fz.includes("if (on) applyW(readW())") && fz.includes("if (!root.hidden) applyW(readW())") && !fz.includes('toast("窗口过窄，文件工作区已收起') && fz.includes('function yieldQueue') && fz.includes("classList.toggle(\"fz-yield\", on)"), "R4-9 极窄再开自洽+R4-R1 刀二/刀三合流：clampW 并入可用空间上限 availMax（视口−queue 右缘含 rail−sash−CHAT_FIT 442=审 B CHAT_MIN 360 列保底+列内 chrome≈68 实测超集）+setOpen 展开与 resize 双口重钳（变宽回弹记忆宽）+窄域让位 toast 示众（W-UIP2 件二反转：旧「收 fzone」toast 负向锚不得回潮——窄窗让位列表新链 yieldQueue/fz-yield 在场）");
  }

  // ============ F10/F11：W-FZONE-B1-R1 双审 P2×3 返修（1111 PM 终检 P2-① 升级必修；P2-③ sheet 已由 W-P2TAIL 修=F4b） ============
  ok(fz.includes("function tabId(sid, path)") && fz.includes('state.tabs.push({ id, path: p, sid: String(sid) })') && fz.includes("load(t.id, pane, t.sid, t.path)") && !fz.includes("state.sid = sid"), "F10 tab 会话作用域（P2-①：复合 id sid+path 跨会话同名路径不串台/tab 自带 sid/retry 取 tab sid 真路径——负向锚=全局 state.sid 覆写旧串不得回归）");
  // W-FZONE-R2（1111 用户实锤「按 WorkBuddy」）：F10b 语义升格——切会话从「清空」到「per-sid 暂存恢复」
  //（右侧分栏常驻：切走快照（pane detach 保活）切回原样恢复；防串台不降级=tab 各带原 sid）。
  ok(fz.includes("function resetForSession") && fz.includes("if (s === state.lastSid) return;") && fz.includes("resetForSession,") && web.includes("ccDeckFzone.resetForSession(sid)") && web.includes("ccDeckFzone.resetForSession(s.session_id)") && web.split("resetForSession(").length >= 3, "F10b 切会话挂点双挂（选中链 MO+slimOpenSession 成员卡直开——lastSid 幂等守卫，开合态不动）");
  ok(fz.includes("const stash = new Map()") && fz.includes("detachPanes") && fz.includes("restorePanes") && fz.includes("STASH_MAX = 8") && fz.includes("stashEvict"), "F10c R2 暂存恢复链（stash Map+pane detach 保活+LRU 淘汰 8 会话——切回原样恢复零重载）");
  {
    // W-FZONE-R2-R1（双审 P2 返修防复发锚）：restorePanes 函数体零释放——释放必经 unloadPane
    //（closeTab/stashEvict 两路独占）。原「尾清理循环」裸 panes.delete 绕过 unloadPane（blob
    // 泄漏）+误删他 sid pane（保活名存实亡）——负向锚锁死不得回归。
    const rpStart = fz.indexOf("function restorePanes");
    const rpBody = fz.slice(rpStart, fz.indexOf("function stashEvict"));
    ok(rpStart >= 0 && rpBody.includes("appendChild") && !rpBody.includes("panes.delete("), "F10c-bis restorePanes 零释放（他 sid pane 留池保活——释放归 closeTab/stashEvict 双路独占必经 unloadPane；裸 panes.delete( 调用负向锚防复发，注释提及不误伤）");
  }
  ok(web.includes("el.dataset.fzUrl") && web.includes("window.__ccDeck005FzoneUnload") && fz.includes("window.__ccDeck005FzoneUnload") && !web.includes('let fzObjUrl = ""'), "F11 图片 blob per-tab 槽（P2-②：双图并存互不 revoke，关 tab/切会话经 unload 挂口回收——负向锚=单槽旧串不得回归）");

  // ============ F-B2. W-FZONE-B2 文件工作区批二（格式矩阵+自动推 tab+空间树+P3 随批） ============
  ok(web.includes('const FZ_AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"])') && web.includes('const FZ_VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"])') && web.includes('const asPdf = ext === "pdf"') && web.includes('fzSetUrl(el, new Blob([bytes], { type: res.mime || "application/pdf" }))'), "F12 格式矩阵：pdf=blob 原生 viewer 零依赖（iframe）+音频 6 扩展+视频 4 扩展（audio/video controls）——fzSetUrl per-tab 单槽泛化（重载先回收旧）", );
  ok(web.includes('office/数据库档暂不支持（下载查看）') && !web.includes("pdf/office/数据库/媒体为批二"), "F13 降级卡文案更新（批二后 pdf/媒体已支持——负向锚=批一占位文案不得回归）");
  ok(web.includes("fzAutoTabOnUpdate") && web.includes("const fzAutoTabBase = new Map()") && web.includes("if (!prev.working || s.status === \"WORKING\") return;") && web.includes("if (sid !== S.selected) return;") && web.includes("for (const p of paths) if (!prev.set.has(p)) fz.autoOpen(sid, p);"), "F14 产物自动推 tab（件②）：per-sid 基线 Map+首见建基不推+仅收口沿（WORKING→非 WORKING）+仅当前选中会话（不打扰）+差分新路径调 autoOpen");
  ok(fz.includes("function autoOpen") && fz.includes('state.tabs.push({ id, path: p, sid: String(sid), fresh: true });') && fz.includes("if (!state.active) state.active = id;") && !fz.includes("autoOpen(sid, p); setOpen(true"), "F15 autoOpen 不抢焦点（active 不动+仅空态首 tab 自然成 active+负向锚=不得 setOpen 强展开）+fresh 角标");
  ok(fz.includes('class="fz-badge"') && fz.includes("hit.fresh = false") && fz.includes("if (cur && cur.fresh) cur.fresh = false;") && css.includes(".fz-badge"), "F16 「新」角标（渲染+聚焦/点击/⌘直达三路清除+CSS）");
  ok(fz.includes('data-fz-tree-btn') && fz.includes("function renderTree") && fz.includes("data-fz-tree-open") && web.includes("window.__ccDeck005FzoneArts") && fz.includes("fz-tree-note"), "F17 工作空间树抽屉（件③降级形态：树钮+目录分组渲染+__ccDeck005FzoneArts 数据挂口+降级说明条——relay 无列目录通道声明）");
  ok(fz.includes("(ev.metaKey || ev.ctrlKey)") && fz.includes("parseInt(ev.key, 10)") && fz.includes("n >= 1 && n <= 8"), "F18 ⌘/Ctrl+1..8 直达第 N tab（件⑤批一 P3——Nova 壳内生效口径）");
  ok(web.includes('img.addEventListener("error"') && web.includes("浏览器不支持解码该图片格式"), "F19 heic/tiff 破图兜底（onerror→降级卡+回收 blob url——件⑤批一 P3）");

  // ============ F-R5. W-FZONE-R5 真第四列（1115 用户五轮定谳 #167+#168）：壳内呼出=窗口外扩不压缩 chat+底色融合+顶栏分割线退役 ============
  {
    const caps = readFileSync(join(root, "desktop-tauri", "src-tauri", "capabilities", "default.json"), "utf-8");
    ok(fz.includes("W-FZONE-R5") && fz.includes("function shellWin") && fz.includes("function shellOpenGrow") && fz.includes("function shellShrink") && fz.includes("const winOp = (fn)"), "F-R5-1 壳外扩机制（shellWin 门=setSize/outerSize/outerPosition 三在才认壳；R6：grow 改名 shellOpenGrow=混合外扩；winOp 串行链=开合 setSize 竞态收口）");
    ok(fz.includes("await win.isMaximized() || await win.isFullscreen()") && fz.includes("return false;") && fz.includes("applyW(readW())"), "F-R5-2 不可外扩回落（最大化/全屏/无壳/通道断→R4 页内挤压护栏 availMax/CHAT_FIT 老路径保留=浏览器现行形态零回归；护栏语义=chat≥442 下限而非被挤目标）");
    ok(fz.includes('if (on && !wasOpen && shellWin()) {') && fz.includes("const w0 = readWShell();") && fz.includes("shellOpenGrow(w0, chat0).then((grew) => { if (!grew) applyW(readW()); })") && fz.includes("shellShrink(openFromW != null ? Math.max(0, Math.round(window.innerWidth) - openFromW) : 0)") && fz.includes("!wasOpen 门"), "F-R5-3 setOpen 壳分支接线（R6-R1：呼出=shellOpenGrow(w0, chat0) 混合外扩——chat0 必 hidden 期同步量入参（反方审 P0：winOp 异步期自量=面板已占位账锚失真）+.then 回落 applyW 接线（P1-b 最大化态挤压护栏合同兑现）；收合缩量=现宽−开前快照 openFromW（P1-a：手动改窄→0 保持用户态；无账→0 最保守——旧「4+面板宽」回落在 R6 下必超缩不得回归）；!wasOpen 门=重复 setOpen(true) 不二次外扩）");
    ok(fz.includes("function clampShellW(w)") && fz.includes("function readWShell()") && fz.includes("const SHELL_MIN_WIN = 1200"), "F-R5-4 壳模式宽钳独立（clampShellW 只受 [340,800] 档位界——屏缘由外扩梯子消化不受视口 avail 钳；SHELL_MIN_WIN=tauri.conf minWidth 缩窗下限）");
    ok(fz.includes("const monOf = async (t)") && fz.includes("t.window.currentMonitor") && !fz.includes("win.currentMonitor"), "F-R5-R1-1 P0 currentMonitor 模块级（实例法负向锚=win.currentMonitor 不得出现——真壳 Window 实例无此方法=外扩哑火+净缩窗主根，review2 实锤）");
    ok(fz.includes("function shellShrink") && fz.indexOf("if (await win.isMaximized() || await win.isFullscreen()) {", fz.indexOf("function shellShrink")) > 0 && fz.indexOf("lastGrowShift = null; chatBase = null; openFromW = null; // W-P3SWEEP N1 同源", fz.indexOf("function shellShrink")) > 0, "F-R5-R1-2 P1-a shrink 最大化/全屏门（tao set_inner_size 会拉出最大化——C12 实测 2560→2116）+早退清账（R6-R1：门内 lastGrowShift+chatBase/openFromW 三账显式终结——悬挂跨会话收口）");
    ok(fz.includes("const iw = await win.innerSize();") && fz.includes("lsize(t, winT, iw.height / scale)") && fz.includes("(iw.width - Math.round(pxL * scale)) / scale"), "F-R5-R1-3 P1-b 宽账读 inner 写 inner 对称（Windows decorations 外框 +2b/循环膨胀链根除；R6：winT=inner 派生目标宽同源）");
    ok(fz.includes("lastGrowShift") && fz.includes("p.x > (mon ? mon.position.x : 0)") && !fz.includes("drag.ready") && fz.includes("mac conf minWidth（Windows conf=960"), "F-R5-R1-4 P2×3+P3（grow 左移量记账收合回移=贴右缘收敛/负坐标门 p.x>mon.position.x（R6 mon 可缺省化）/R6 负向锚=drag.ready 外扩拖动旧机制不得回归（拖动已改纯占比）/SHELL_MIN_WIN 注释 960 对齐）");
    ok(fz.includes("const CHAT_COMFORT = 640") && fz.includes("Math.min(1200, Math.round(w0 + Math.max(0, chat0 - CHAT_COMFORT)))") && fz.includes("Math.max(winL, mon ? Math.floor(mon.size.width / scale) : winL)") && fz.includes("const wtMax = Math.round(winT - other - 4 - CHAT_FIT)") && fz.includes("const overPhys") && fz.includes("winT > winL && p.x > (mon ? mon.position.x : 0)") && fz.includes("win.setPosition(ppos(t, p.x - shift, p.y))") && !fz.includes("growPhys - room"), "F-R6-1 开区混合外扩（1116 用户「适当压缩消息面板」：wt=w0+chat 超阅读列 640（W-UIB0 批零压缩目标）的空白富余让给工作区，wt 钳 [340,1200]；winT≤屏内可容纳最大窗宽=max(窗宽,屏宽)——永不溢出屏（R5「允许溢出+拖回」负向锚 growPhys-room 不得回归）；外扩不足压 chat（下限 CHAT_FIT 互钳 wtMax）再不够砍 wt≥340；winT>winL 左移门=跨屏零增长不白瞬移（反方审场景5））");
    ok(fz.includes("const move = (e2) => { applyW(startW + (startX - e2.clientX)); };") && fz.includes("localStorage.setItem(W_KEY, String(clampW(") && fz.includes('rz.addEventListener("pointercancel", up)') && !fz.includes("drag.maxGrow") && !fz.includes("baseWinW"), "F-R6-2 sash 拖动=纯占比（1116 用户「分隔线拖动调整占比」：窗口尺寸不动，拖宽压 chat/拖窄还 chat——clampW availMax 护栏承载互钳，壳/无壳合一；负向锚=R5 外扩拖动 drag.maxGrow/baseWinW 整段不得回归；记忆=clampW 口径存 W_KEY；pointercancel 同口清理（反方审 P2：document 挂摘后手势抢断悬挂=全局拖拽失控））");
    ok(fz.includes("let chatBase = null") && fz.includes("let openFromW = null") && fz.includes("let expectedW = null") && fz.includes("let winOpUntil = 0") && fz.includes("Math.abs(Math.round(window.innerWidth) - expectedW) > 2") && !fz.includes("let openDelta"), "F-R6-3 收合账本+resize 双闸清账（openFromW=开前窗宽快照（反方审 P1-a：缩量=max(0,现宽−快照)，openDelta 增量版负向锚退役）；expectedW echo 对账（resize 偏差>2 才清——时间窗 4s 盲区内的真改窗也抓到）+winOpUntil 时间窗双保险）");
    ok(caps.includes('"core:window:allow-set-size"') && caps.includes('"core:window:allow-set-position"'), "F-R5-7 壳权限双增（set-size/set-position——读口 outer-size/outer-position/current-monitor 等已在 core:window:default，未重复授）");
    ok(css.includes("background: linear-gradient(180deg, var(--workspace-top), var(--bg1)); border-left: 1px solid var(--line-soft); overflow: hidden;") && !css.includes("max-width: 800px; background: var(--surface1)"), "F-R5-8 fzone 底色融合（--surface1 列表列档退役→主面板同源面 workspace-top→bg1 梯度=与 .workspace 逐 token 同构+左缘 1px line-soft 列界同 .queue 节奏；负向锚=surface1 主规则形态不得回归）");
    ok(css.includes(".fzone .fz-md { font-size: var(--fs-A)") && css.includes(".fzone .fz-code { display: grid; grid-template-columns: 3.2em 1fr; font-family: var(--mono); font-size: var(--fs-D)") && css.includes(".tabpage-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px max(22px, calc((100% - max(900px, min(1180px, 68vw))) / 2)); }"), "F-R6-4 工作区字号+tabpage 入阅读列（1116 用户：fz-md --fs-B→--fs-A=消息正文同级 12→14px、fz-code --fs-C→--fs-D=11→12.5px 代码阅读档；任务/输出物/更多三页左右 padding=centercol v2 同表达式入阅读列（窄窗 calc 负值地板回 22px=零回归连续无断点））");
    ok(css.includes("#d-session .workspace-head { border-bottom: 0; }") && css.includes("#d-session .workspace-head, #d-team .workspace-head { border-bottom-color:"), "F-R5-9 #168 顶栏分割线退役（#d-session head border-bottom 归零=纯颜色分割，后位覆盖继承边；团队域边线族原样在——仅会话域收口）");
  }

  // ============ NAV. W-NAVBAR 期一（1112 用户拍板）：历史提问索引轨（WorkBuddy 逆向规格 §三直用） ============
  {
    const nav = readFileSync(join(root, "web-console", "js", "navbar.js"), "utf-8");
    ok(nav.includes("panelEl.addEventListener(\"wheel\"") && nav.includes("ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY") && nav.includes("if (!canScroll || (ev.deltaY < 0 && atTop) || (ev.deltaY > 0 && atEnd)) return;") && css.includes(".msg-navbar.open .msg-navbar__item { height: 26px; }") && css.includes("msg-navbar__item { display: flex; align-items: center; justify-content: flex-end; gap: 10px; box-sizing: border-box; flex: none;") && css.includes(".msg-navbar.open .msg-navbar__item:hover .txt { font-size: calc(var(--fs-B) + 2px); }") && nav.includes("+ 44 : 172") && css.includes(".inspector-expand { top: 32%; }"), "NAVR7 导航条七修+呼出钮避让（1116 用户：①展开卡行高 26px 态分档+行 flex:none 根治 flex-shrink 压扁（「字拥挤」真根因——探针实锤 26→18.6px）②hover 行 +2 号带 font-size 过渡③wheel 显式滚动兜底+方向感知守卫（无溢出/到头放行原生链——折叠态 44px 线轨 wheel 不成死区，反方审 P2）④lift 基线 +16→+44/fallback 172⑤inspector-expand 呼出钮 top 50%→32% 避让消息滚动条）");
    ok(html.includes("js/navbar.js") && nav.includes('"use strict"') && nav.includes("msg-user-row[data-x]"), "NAV1 组件骨架（index-005 挂载+自治组件+数据源=.msg-user-row[data-x] 用户消息行）");
    ok(nav.includes("MIN_ITEMS = 5") && nav.includes("MIN_VW = 880") && nav.includes("TEXT_MAX = 160") && nav.includes("MAX_H = 400"), "NAV2 门槛与尺寸参数照抄规格 §三（≥5 条用户消息∧≥880px/截 160/高上限 400）");
    ok(nav.includes('scrollIntoView({ behavior: "smooth", block: "start" })') && !nav.includes("ensureLoaded(") && !nav.includes("ensureRequestLoaded("), "NAV3 点击跳转=scrollIntoView smooth（非虚拟化全挂载——调研定谳砍 WorkBuddy 虚拟加载链，负向锚=虚拟加载调用形态不得出现；注释提及设计依据放行）");
    ok(nav.includes('addEventListener("scroll", syncActive, { passive: true })') && nav.includes("requestAnimationFrame") && css.includes(".msg-navbar__item--active"), "NAV4 滚动同步（passive 监听+rAF 节流+active 样式类——可视区顶部用户消息高亮）");
    ok(nav.includes('"历史提问"') && nav.includes('aria-expanded') && nav.includes('"option"') && nav.includes('ev.key === "Escape"'), "NAV5 a11y（aria-label 历史提问+aria-expanded+展开 listbox/option+Escape 关）");
    ok(nav.includes("ENTER_MS = 60") && nav.includes("LEAVE_MS = 180") && nav.includes("MutationObserver") && nav.includes("msg-echo"), "NAV6 交互参数与自治重建（enter 60ms 防抖/leave 180ms 延迟/MutationObserver 切会话重建/排除 .msg-echo 待发占位）");
    ok(css.includes("clip-path: inset(24px 0 24px calc(100% - 44px) round 12px)") && css.includes("clip-path .543s cubic-bezier(.16, 1, .3, 1)") && css.includes("clip-path .343s cubic-bezier(.45, 0, .3, 1)") && css.includes("background-color: var(--surface1)") && css.includes("prefers-reduced-motion") && css.includes("@media (max-width: 879px)") && css.includes(".msg-navbar[hidden] { display: none; }"), "NAV7 CSS 期二同构（clip-path 裁剪展开原版机制+呼出 .543s/收起 .343s 原参数+surface1 实底 token 融合+reduced-motion 降级+窄窗 879 零占位双保险+门槛 hidden 零占位）");
    ok(nav.includes("MAX_LINES = 28") && nav.includes("function sample(") && nav.includes("active") && css.includes("height: 26px"), "NAV8 期二加高与采样（行高 26px 单套 DOM+>28 条均匀采样 28+采样必含 active——WorkBuddy V=min(len,28) 同款）");
    ok(css.includes("right: 34px") && nav.includes("MAX_LINES"), "NAV9 期二避让（right 10→34px 让开 inspector-expand 抽屉钮带——CDP 归零数字在探针）");
  }

  // ============ TAB. W-TABPAGE（1112 用户拍板 A·cc-deck 自设计）：任务/输出物/更多三 tab 独立整页 ============
  {
    ok(web.includes('p.classList.add("tabpage-pane")') && web.includes('scroll.className = "tabpage-scroll"') && web.includes("p.replaceChildren(scroll)") && web.includes("tabpageBody(1)") && web.includes("tabpageBody(2)") && web.includes("tabpageBody(3)") && web.includes('function tabpageBody(i)'), "TAB1 三 pane 迁出 #session-body（ready 收编段：tabpage 类+滚动体常驻子；三渲染器写点走 tabpageBody 单口=.tabpage-scroll——#165 页头退役后 pane 直挂滚动体）");
    {
      // 字符串序锚：panes 收编（body.children）必须先于迁移（insertBefore(p, body)）——
      // 且迁移落点=workspace 在 body 之前（CSS ~ 兄弟选择器让位前提）
      const iGrab = web.indexOf("const panes = [...body.children]");
      const iMove = web.indexOf("workspace.insertBefore(p, body)");
      ok(iGrab >= 0 && iMove > iGrab, "TAB2 迁移时序与落点（panes 先从 #session-body 收编再前插 .workspace——DOM 序=三 pane 在 #session-body 之前）");
    }
    ok(!web.includes('back.setAttribute("data-tabpage-back", "1")') && !web.includes('back.textContent = "⟵ 返回对话"') && web.includes('const tabBack = ev.target.closest("[data-tabpage-back]");') && web.includes("if (UI.tabs && UI.tabs[0]) UI.tabs[0].click(); return;"), "TAB3 页头「⟵ 返回对话」钮退役（#165 用户令：页头整行移除——负向锚=生产码不得再建钮；委托分支存续=防御性死码（head 删除后 closest 恒 null 穿透），返回走 segment-bar tab0 同链不变）");
    ok(css.includes("#d-session .workspace > .tabpage-pane.active { display: flex; flex-direction: column; flex: 1 1 0; }") && css.includes("#d-session .workspace > .tabpage-pane.active ~ #session-body { display: none; }") && css.includes(".tabpage-scroll { flex: 1 1 auto; min-height: 0; overflow: auto;"), "TAB4 独立整页 CSS（激活=flex 列占满 head 之下整幅+own scroll 滚动体+非对话页 #session-body 兄弟选择器整列让位——零 JS 切换钩）");
    ok(css.includes(".tabpage-head { flex: 0 0 auto;") && css.includes(".tabpage-head .tabpage-back") && !html.includes("tabpage"), "TAB5 页头行样式（轻量页名+回锚钮）+静态 HTML 零 tabpage 标记负向锚（页面结构纯 JS 装配——index-005 的 workspace 四件套 body/dock/agbox/footer 骨架不动）");
    ok(web.includes('section.querySelector(".segment-bar")?.addEventListener("click"') && web.includes("S.tabChatMemo = { sid: S.selected, top: el.scrollTop"), "TAB6 #124 往返滚动 memo 原样（捕获段记账+回对话恢复链零改——#session-body 让位后的 scrollTop clamp 正是该 memo 护的场景）");
    ok(readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8").includes('bar.closest(".workspace, .mobile-screen, .session-detail")'), "TAB7 R4 断链修复（setupStubTabs host 解析补 .session-detail——#128 R4 将会话 head 迁出 .workspace 后 closest 落空，包摄+wireSegmentTabs 整体跳过=四 tab 死钮+内容内联堆进消息流的既有断点；负向锚=裸 .workspace/.mobile-screen 双选旧串不得独存）");
  }

}

console.log(`\n§P-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#291 帧分类判活（心跳≠工作·帧分类单判据 15min 窗+turn 生命周期状态机收口）");
process.exit(fail > 0 ? 1 : 0);
