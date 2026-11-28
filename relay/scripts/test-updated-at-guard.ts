// DL-P1-7（DEV-22 批 B）：updated_at 单点守卫回归套件——空闲跳序四现 saga 的结构性
// 防线锁死。断言组：
//   Z0 语法闸（两触点文件 node --check）
//   A1 单点守卫在位（session-domain + bridge-core 双 IIFE 各一定义）
//   A2 裸赋值清零（\.updated_at = 全仓只剩守卫函数体内 1 处/文件——新写手绕口即红）
//   A3-A8 洗点接线锚（六洗点全走守卫口+心跳不洗双面+建卡初始化路径不受影响）
//   B1-B7 守卫行为断言（提取函数体 eval 直跑：缺载/同值/回拨不推进，真值/force 推进）
//   X1-X6 expo 面（DEV-40·R4 立即件——store.ts SESSION_UPDATED 守卫收编，三端同答案）
// 范式：test-ui-followup 源码锚（web-console 是 IIFE 脚本无法 import，行为面走提取
// eval——守卫函数体自包含无外部依赖，可安全隔离求值）。
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR npx tsx scripts/test-updated-at-guard.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const root = join(import.meta.dirname, "..", "..");
const rf = (...p: string[]) => readFileSync(join(root, ...p), "utf-8");
const ssd = rf("web-console", "js", "session-domain.js");
const bc = rf("web-console", "js", "bridge-core.js");

console.log("Z0 语法闸（两触点文件 node --check）：");
for (const f of ["session-domain", "bridge-core"]) {
  const r = spawnSync("node", ["--check", join(root, "web-console", "js", f + ".js")], { encoding: "utf-8" });
  ok(r.status === 0, `Z0-${f} 语法可解析`);
}

console.log("A1 单点守卫在位（DL-P1-7）：");
const GUARD_SIG = "function touchUpdatedAt(sess, ts, force)";
ok(ssd.includes(GUARD_SIG), "A1-1 session-domain 定义守卫（含语义注释=写手契约可读）");
ok(ssd.includes("DL-P1-7（DEV-22 批 B"), "A1-2 session-domain 守卫带 saga 溯源注释");
ok(bc.includes(GUARD_SIG), "A1-3 bridge-core 定义守卫（桥持副本同法，IIFE 各自持份）");
ok(bc.includes("DL-P1-7"), "A1-4 bridge-core 守卫带溯源注释");

console.log("A2 裸赋值清零（绕口新写手即红）：");
const bareWrites = (src: string) => (src.match(/\.updated_at\s*=(?![=>])/g) || []).length;
ok(bareWrites(ssd) === 1, `A2-1 session-domain 裸赋值仅守卫体内 1 处（实得 ${bareWrites(ssd)}）`);
ok(bareWrites(bc) === 1, `A2-2 bridge-core 裸赋值仅守卫体内 1 处（实得 ${bareWrites(bc)}）`);

console.log("A3 洗点接线锚（六洗点+心跳双面+建卡不受影响）：");
ok(ssd.includes("touchUpdatedAt(s, p.updated_at)"), "A3-1 onSessionUpdated：载荷显式携带才推进（缺载保持，#271 口径）");
ok(ssd.includes("touchUpdatedAt(s, entry.ts || Date.now())"), "A3-2 onLog：真日志活动推进、乱序旧 ts 不回拨");
const forced = (ssd.match(/touchUpdatedAt\(s, Date\.now\(\), true\)/g) || []).length;
ok(forced === 4, `A3-3 真态变四洗点全走 force 口（onWaiting/onWaitingResolved/onErrorEvt/onDoneEvt，实得 ${forced}）`);
ok(bc.includes('frame.type !== "SESSION_HEARTBEAT") touchUpdatedAt'), "A3-4 桥副本合并：心跳帧不洗 updated_at（三现同法——PM 常驻保活每拍信封 ts=第五写手，本口收编）");
ok(bc.includes("(frame.payload && frame.payload.updated_at) || frame.ts"), "A3-5 桥副本合并：载荷时刻优先、信封 ts 兜底");
ok(bc.includes("const { updated_at: _stripTs, ...rest } = frame.payload") && bc.includes("Object.assign(session, rest, { session_id: frame.session_id })"), "A3-8 桥副本合并 assign 前剥 updated_at（DEV-30 ④ / DEV-22 审查 P3-1：载荷旧键随 assign 先落盘→守卫同值放行=回拨既成，必须剥键先行）");
ok(ssd.includes("updated_at: Date.now(), todos: [], artifacts: []"), "A3-6 SESSION_CREATED 建卡初始化不受影响（新对象非洗点）");
ok(bc.includes("started_at: frame.ts, updated_at: frame.ts"), "A3-7 桥副本新建卡初始化不受影响");

console.log("A4 onHeartbeat 三现修复未被回退：");
const hbSeg = ssd.slice(ssd.indexOf("function onHeartbeat"), ssd.indexOf("function onWaiting"));
ok(hbSeg.includes("s.last_heartbeat_at = Date.now();"), "A4-1 心跳新鲜度记专用键 last_heartbeat_at");
ok(!/\.updated_at\s*=/.test(hbSeg), "A4-2 onHeartbeat 块内零 updated_at 写（心跳不洗=三现 t31 实锤修复在位）");

console.log("B 守卫行为断言（提取函数体隔离求值）：");
const extract = (src: string, fname: string): string => {
  const i = src.indexOf(`function ${fname}(`);
  if (i < 0) return "";
  // TS 签名容差（DEV-40 X 组）：`) : boolean {` 的返回注解可选段——web 两份无注解不受扰
  const m = src.slice(i).match(new RegExp(`^function ${fname}\\([^)]*\\)\\s*(:\\s*\\S+\\s*)?\\{[\\s\\S]*?\\n\\s*\\}`));
  return m ? m[0] : "";
};
const fnText = extract(ssd, "touchUpdatedAt");
const fnTextBc = extract(bc, "touchUpdatedAt");
ok(!!fnText && !!fnTextBc, "B0 两文件守卫函数体均可提取（提取失败=格式漂移，锚需同步）");
if (fnText && fnTextBc) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${fnText});`)() as (sess: { updated_at?: number } | null, ts: unknown, force?: boolean) => boolean;
  // eslint-disable-next-line no-new-func
  const fnBc = new Function(`return (${fnTextBc});`)() as typeof fn;
  for (const [label, f] of [["ssd", fn], ["bc", fnBc]] as const) {
    const mk = () => ({ updated_at: 1700000000000 });
    let s: { updated_at?: number } | null;
    s = null;
    ok(f(s, 1700000001000) === false, `B1-${label} null 会话安全返回 false`);
    s = mk();
    ok(f(s, undefined) === false && s.updated_at === 1700000000000, `B2-${label} 缺载不伪造不推进`);
    ok(f(s, 0) === false && f(s, NaN) === false && f(s, "abc") === false && s.updated_at === 1700000000000, `B2b-${label} 非数 ts 不推进`);
    ok(f(s, 1700000000000) === false && s.updated_at === 1700000000000, `B3-${label} 同值不洗（空闲跳序根因形态）`);
    ok(f(s, 1699999999000) === false && s.updated_at === 1700000000000, `B4-${label} 回拨不洗（乱序帧不回退排序面）`);
    ok(f(s, 1700000002000) === true && s.updated_at === 1700000002000, `B5-${label} 真新值推进`);
    ok(f(s, 1700000001000, true) === true && s.updated_at === 1700000001000, `B6-${label} force 真态变必推进（即便回拨）`);
    const s2 = mk();
    ok(f(s2, "1700000005000") === true && s2.updated_at === 1700000005000, `B7-${label} 数字字符串 ts 归一推进`);
  }
}

console.log("B8 合并块行为断言（剥键+守卫真码直跑，DEV-30 ④）：");
{
  // 从 bridge-core 抽真实合并三行（strip/assign/touch）组函数体隔离求值——不是复制品，
  // 源码漂移（剥键被拆/守卫被绕）即取不到块或断言翻红。
  const start = bc.indexOf("const { updated_at: _stripTs");
  const end = bc.indexOf("changed = true;", start);
  ok(start >= 0 && end > start, "B8-0 桥合并块可定位（剥键行丢失=源码漂移）");
  if (start >= 0 && end > start && fnTextBc) {
    const guard = new Function(`return (${fnTextBc});`)() as (sess: { updated_at?: number } | null, ts: unknown, force?: boolean) => boolean;
    const body = bc.slice(start, end); // 含注释原样，语句序列可直接作函数体
    // eslint-disable-next-line no-new-func
    const merge = new Function("session", "frame", "touchUpdatedAt", `"use strict";\n${body}\nreturn session;`) as (s: Record<string, unknown>, f: { type: string; session_id: string; ts: number; payload: Record<string, unknown> }, touch: (sess: { updated_at?: number } | null, ts: unknown, force?: boolean) => boolean) => Record<string, unknown>;
    // 场景一（DEV-22 审查 P3-1 本体）：载荷自带旧 updated_at（100）< 现值 200——剥键后
    // assign 不落旧键、守卫同值/回拨放行 → 排序面不回拨（修复前：assign 洗成 100，守卫
    // 视为同值放行=回拨既成）。
    const s1: Record<string, unknown> = { session_id: "s1", title: "旧题", updated_at: 200 };
    merge(s1, { type: "SESSION_UPDATED", session_id: "s1", ts: 150, payload: { title: "新题", updated_at: 100 } }, guard);
    ok(s1.updated_at === 200 && s1.title === "新题", `B8-1 载荷旧 updated_at 不回拨（业务键已并、时刻保持 200；实得 ${s1.updated_at}）`);
    // 场景二：载荷新时刻（300）正常经守卫推进。
    const s2m: Record<string, unknown> = { session_id: "s2", updated_at: 200 };
    merge(s2m, { type: "SESSION_UPDATED", session_id: "s2", ts: 250, payload: { updated_at: 300 } }, guard);
    ok(s2m.updated_at === 300, `B8-2 载荷新时刻经守卫推进（实得 ${s2m.updated_at}）`);
    // 场景三：心跳帧不推进（信封 ts 350 > 现值 300 也不洗）。
    const s3: Record<string, unknown> = { session_id: "s3", updated_at: 300 };
    merge(s3, { type: "SESSION_HEARTBEAT", session_id: "s3", ts: 350, payload: { beat: 1 } }, guard);
    ok(s3.updated_at === 300, `B8-3 心跳帧不洗 updated_at（实得 ${s3.updated_at}）`);
  }
}

console.log("R relay 面单点守卫（DEV-31 清件③——session-manager touchIfChanged 收编）：");
{
  const sm = rf("relay", "src", "session-manager.ts");
  const cl = rf("relay", "src", "lifecycle", "context-link.ts");
  ok(sm.includes("private touchIfChanged(state: SessionState, at?: number, force = false): boolean"), "R0-1 session-manager 定义单点 touchIfChanged（与端上 touchUpdatedAt 同语义三律）");
  ok(sm.includes("DL-P1-7 relay 面（DEV-31 清件③）"), "R0-2 单点带 saga 溯源注释（契约可读=docs/night-audit/updated-at-writers.md）");
  // 裸赋值计数：session-manager 只许守卫体内 1 处；context-link（setExternalUsage 搬运体）0 处。
  // 注意 history.ts 的回放 reducer（s.updated_at = e.ts / 载荷覆盖）不在本锚范围——它是
  // 读面收敛器非写手，事件序单调无「同值重报洗」形态。
  ok(bareWrites(sm) === 1, `R1-1 session-manager 裸赋值仅守卫体内 1 处（实得 ${bareWrites(sm)}）`);
  ok(bareWrites(cl) === 0, `R1-2 lifecycle/context-link 零裸赋值（实得 ${bareWrites(cl)}）`);
  // 洗点接线锚：代表性写手各至少一次过口（分 force/非 force 两类语义）。
  const touchCalls = (sm.match(/this\.touchIfChanged\(/g) || []).length + (cl.match(/mgr\.touchIfChanged\(/g) || []).length;
  ok(touchCalls === 30, `R2-1 写手收编计数恰 30（session-manager 29 处直写全过口+context-link 1 处；松锚可漏放回退如 28＋1，复审 P3-2 收紧；实得 ${touchCalls}）`);
  ok(sm.includes("this.touchIfChanged(s.state, at, true); // DEV-31 清件③：过单点；force=at 是权威时刻"), "R2-2 setExternalStatus 过口（force=boot 采纳转录真实时刻可回拨校正，#271 面）");
  ok(sm.includes("this.touchIfChanged(s.state, at); // DEV-31 清件③：过单点（1123 二现门后，非 force"), "R2-3 setTodos/setExternalSubagents 过口（非 force——乱序旧转录 ts 不回拨）");
  ok(sm.includes("this.touchIfChanged(s.state, at ?? now, true); // DEV-31 清件③"), "R2-4 emitUpdated 枢纽过口（force=水合/回放真实活动时刻，#157 语义原样）");
  ok(sm.includes("this.touchIfChanged(managed.state, at, true); // DEV-31 清件③：过单点（WAITING 真态变，force）"), "R2-5 SDK 面 onWaiting（tool-wait）过口（真态变 force）");
  ok(cl.includes("mgr.touchIfChanged(s.state, at); // DEV-31 清件③"), "R2-6 setExternalUsage（context-link 搬运体）过口（非 force）");
  // 心跳载荷锚（DEV-22 审查 :13129 实锤 + leader 提升注记）：载荷带既有 updated_at（#157
  // 帧完整性——防缺载兜底消费面回落信封 ts），但心跳本身永不推进它（三端消费面均不据它洗）。
  const hbAt = sm.indexOf('"SESSION_HEARTBEAT"');
  const hbSeg = sm.slice(hbAt, hbAt + 700);
  ok(hbSeg.includes("updated_at: s.state.updated_at"), "R3-1 心跳载荷带既有 updated_at（DEV-31 补键）");
  ok(!/\.updated_at\s*=(?![=>])/.test(hbSeg), "R3-2 心跳块内零 updated_at 直写（带既有值≠推进——三现口径不回退）");
}

console.log("R4 relay 行为断言（真实例：空闲 60s 不变/回拨不洗/force 校正）：");
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const prevData = process.env.CCR_DATA_DIR;
  const prevPlugin = process.env.CC_DECK_PLUGIN;
  const dd = mkdtempSync(join(tmpdir(), "ccr-uag-relay-"));
  process.env.CCR_DATA_DIR = dd;
  delete process.env.CC_DECK_PLUGIN;
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  try {
    const { EventBus } = await import("../src/event-bus.js");
    const { SessionManager } = await import("../src/session-manager.js");
    const { loadConfig } = await import("../src/config.js");
    const mgr = new SessionManager(new EventBus(), loadConfig());
    const id = "ext-uag-probe";
    const st = mgr.ensureExternal(id, "/virtual/uag", "守卫行为探针");
    // 先对齐（建卡 summary=prompt 派生值，首轮调用本身是真变化）再取基线。
    mgr.setExternalStatus(id, "WORKING", "接入中");
    const before = st.updated_at;
    // R4-1 空闲 60s 等价：12 轮同值 status/summary 重报（外部引擎周期回放帧形态，5s×12）
    // ——同值不洗（首现/二现根因形态），全程 updated_at 纹丝不动。
    for (let i = 0; i < 12; i++) mgr.setExternalStatus(id, "WORKING", "接入中");
    ok(st.updated_at === before, `R4-1 同值重报 ×12（60s 等价）updated_at 不变（前 ${before} 后 ${st.updated_at}）`);
    // R4-2 同值 todos 重报（清单零变化）——1123 二现门：不洗不发帧。
    mgr.setTodos(id, [{ content: "t0", status: "pending", active_form: "" }], before + 5000);
    const before2 = st.updated_at;
    mgr.setTodos(id, [{ content: "t0", status: "pending", active_form: "" }], before2 + 5000);
    ok(st.updated_at === before2, `R4-2 同值 todos 重报不洗（前 ${before2} 后 ${st.updated_at}）`);
    // R4-2b 内容真变+旧 at：收敛到权威旧时刻（emitUpdated force 的 #157 水合校正语义——
    // 回拨到真相是校正不是洗；与收编前行为逐字等价，回归锚防语义漂移）。
    mgr.setTodos(id, [{ content: "t1", status: "pending", active_form: "" }], before2 - 1000);
    ok(st.updated_at === before2 - 1000, `R4-2b 内容变+旧 at 收敛到权威时刻（实得 ${st.updated_at}，期 ${before2 - 1000}）`);
    // R4-3 真态变+旧 at（status 翻转+权威旧时刻）——force 必推进（#271 boot 采纳/收殓
    // 校正语义保留：回拨到真相是校正不是洗）。
    mgr.setExternalStatus(id, "DONE", "已完成", undefined, before - 2000);
    ok(st.updated_at === before - 2000, `R4-3 真态变 force 推进到权威旧时刻（实得 ${st.updated_at}，期 ${before - 2000}）`);
    // R4-4 坏 ts 不伪造：显式 NaN/0 at 不推进（律①——不拿接收时刻冒充活动时刻）。
    const before4 = st.updated_at;
    mgr.setTodos(id, [{ content: "t2", status: "pending", active_form: "" }], NaN);
    mgr.setTodos(id, [{ content: "t3", status: "pending", active_form: "" }], 0);
    ok(st.updated_at === before4, `R4-4 非数/非正 at 不推进不伪造（前 ${before4} 后 ${st.updated_at}）`);
    // R4-5 律②隔离面（复审 P3-1）：setExternalUsage 是唯一「非 force 且无 emitUpdated
    // force 跟进」的 at 写手（context-link 搬运体，直发 SESSION_UPDATED）——usage 内容
    // 真变 + 旧 at（转录扫描乱序形态）仍拒回拨。删掉律②此处即回拨即红（R4-2 被同值
    // 守卫早退、R4-2b/3 被 force 主导，均隔离不出律②）。
    mgr.setExternalUsage(id, { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, undefined, undefined, before4 - 5000);
    ok(st.usage?.input_tokens === 120 && st.updated_at === before4, `R4-5 setExternalUsage 内容变+旧 at 不回拨（律②唯一无 force 跟进路径；usage 已写 ${st.usage?.input_tokens}、时刻保持 ${st.updated_at}）`);
  } finally {
    if (prevData === undefined) delete process.env.CCR_DATA_DIR; else process.env.CCR_DATA_DIR = prevData;
    if (prevPlugin === undefined) delete process.env.CC_DECK_PLUGIN; else process.env.CC_DECK_PLUGIN = prevPlugin;
    rmSync(dd, { recursive: true, force: true });
  }
}

console.log("X expo 面（DEV-40·R4 立即件——store.ts SESSION_UPDATED 守卫收编，三端同答案）：");
{
  const st = rf("expo-app", "src", "store.ts");
  console.log("X1 单点守卫在位：");
  ok(st.includes("export function touchUpdatedAt(sess"), "X1-1 store.ts 模块级定义守卫（含语义注释=写手契约可读）");
  ok(st.includes("DL-P1-7（DEV-40·R4 立即件）"), "X1-2 守卫带 saga 溯源注释（谱系=updated-at-writers.md）");
  console.log("X2 裸赋值清零（绕口新写手即红）：");
  ok(bareWrites(st) === 1, `X2-1 store.ts 裸赋值仅守卫体内 1 处（实得 ${bareWrites(st)}）`);
  console.log("X3 洗点接线锚（载荷消费+心跳不洗+建卡不受影响）：");
  ok(st.includes("touchUpdatedAt(s, (msg.payload as { updated_at?: number }).updated_at);"), "X3-1 SESSION_UPDATED 洗点经守卫口（载荷显式携带才推进，缺载保持既有值——#271 口径）");
  const updSeg = st.slice(st.indexOf("case \"SESSION_UPDATED\""), st.indexOf("case \"SESSION_HEARTBEAT\""));
  ok(!/,\s*true\)/.test(updSeg), "X3-2 SESSION_UPDATED 洗点不带 force（载荷时刻是唯一推进源——与 web onSessionUpdated 同款非 force 口）");
  ok(updSeg.includes("DEV-40 补律②"), "X3-3 洗点带律②溯源注释（同值/回拨不洗——本单补齐面可读）");
  const hbAt = st.indexOf("case \"SESSION_HEARTBEAT\"");
  const hbSeg = st.slice(hbAt, st.indexOf("case \"SESSION_WAITING\"", hbAt));
  ok(hbSeg.includes("s.elapsed_hint = msg.payload.elapsed_ms;") && !/\.updated_at\s*=(?![=>])/.test(hbSeg), "X3-4 心跳块零 updated_at 写（expo 只读 elapsed_ms——三现口径不回退）");
  ok(st.includes("started_at: msg.ts,\n          updated_at: msg.ts,"), "X3-5 SESSION_CREATED 建卡初始化不受影响（新对象非洗点）");
  console.log("X4 守卫行为断言（提取函数体隔离求值，TS 签名剥注）：");
  const fnTextExpo = extract(st, "touchUpdatedAt");
  ok(!!fnTextExpo, "X4-0 store.ts 守卫函数体可提取（提取失败=格式漂移，锚需同步；内层 if 须单行无花括号——与 web 两份同约束）");
  if (fnTextExpo) {
    // expo 守卫带 TS 注解（strict 模式必需），剥离后与 web 两份同法隔离求值
    const jsText = fnTextExpo.replace(/function touchUpdatedAt\([\s\S]*?\)\s*:\s*boolean \{/, "function touchUpdatedAt(sess, ts, force) {");
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${jsText});`)() as (sess: { updated_at?: number } | null, ts: unknown, force?: boolean) => boolean;
    let s: { updated_at?: number } | null;
    s = null;
    ok(fn(s, 1700000001000) === false, "X4-1 null 会话安全返回 false");
    s = { updated_at: 1700000000000 };
    ok(fn(s, undefined) === false && s.updated_at === 1700000000000, "X4-2 缺载不伪造不推进");
    ok(fn(s, 0) === false && fn(s, NaN) === false && fn(s, "abc") === false && s.updated_at === 1700000000000, "X4-2b 非数 ts 不推进");
    ok(fn(s, 1700000000000) === false && s.updated_at === 1700000000000, "X4-3 同值不洗（空闲跳序根因形态——DEV-40 补齐的律②）");
    ok(fn(s, 1699999999000) === false && s.updated_at === 1700000000000, "X4-4 回拨不洗（乱序旧转录 ts 不回退排序面——修前实勘红形态）");
    ok(fn(s, 1700000002000) === true && s.updated_at === 1700000002000, "X4-5 真新值推进");
    ok(fn(s, 1700000001000, true) === true && s.updated_at === 1700000001000, "X4-6 force 真态变必推进（即便回拨——三律③与 web 同签）");
    const s2 = { updated_at: 1700000000000 };
    ok(fn(s2, "1700000005000") === true && s2.updated_at === 1700000005000, "X4-7 数字字符串 ts 归一推进");
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
