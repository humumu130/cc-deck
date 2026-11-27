// DL-P1-7（DEV-22 批 B）：updated_at 单点守卫回归套件——空闲跳序四现 saga 的结构性
// 防线锁死。断言组：
//   Z0 语法闸（两触点文件 node --check）
//   A1 单点守卫在位（session-domain + bridge-core 双 IIFE 各一定义）
//   A2 裸赋值清零（\.updated_at = 全仓只剩守卫函数体内 1 处/文件——新写手绕口即红）
//   A3-A8 洗点接线锚（六洗点全走守卫口+心跳不洗双面+建卡初始化路径不受影响）
//   B1-B7 守卫行为断言（提取函数体 eval 直跑：缺载/同值/回拨不推进，真值/force 推进）
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
  const m = src.slice(i).match(new RegExp(`^function ${fname}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}`));
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

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
