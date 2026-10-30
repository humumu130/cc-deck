// #240 W-LEADERHIDE web 半结构断言：会话列表 Leader 卡移除（双端 web 面）。
// 范式=test-005-dispvis-web.ts（源文本在场 + blockFrom 提函数 eval 直跑）。
//
// 覆盖面：
//  A. 桌面 renderMyList：isLeaderSession 双口径（锚 id + 编制 role 词表）+ liveSessions
//     排除 + filterHidden 记账含 leader（FB17 防「缺卡→重渲→仍缺」死循环）
//  B. isLeaderSession 直跑：锚 id 命中 / role=leader 命中 / role=pm 不命中（PM 会话照常）
//  C. onCollabMode：leader 分支锚卡 upsert 退役（no-leader 回收保留）
//  D. mobile.js 手机壳：mobileLeaderIds 直跑 + renderInbox 过滤调用在场
//  E. relay SNAPSHOT：ws-server / cloud-client 对称携带 leader_session_id +
//     session-manager.leaderSessionId() 在场（锚不在编制 headcount——2026-10-23 生产
//     projects.json 实锤，headcount 反查滤不到锚，锚 id 是唯一可靠识别）
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-leaderhide-web.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sessionDomain = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const mobileJs = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");
const wsServer = readFileSync(join(root, "relay", "src", "ws-server.ts"), "utf-8");
const cloudClient = readFileSync(join(root, "relay", "src", "cloud-client.ts"), "utf-8");
const sessionManager = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string, haystack: string): string {
  const i = haystack.indexOf(needle);
  if (i < 0) return "";
  const j = haystack.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < haystack.length; k++) {
    if (haystack[k] === "{") depth++;
    else if (haystack[k] === "}") { depth--; if (depth === 0) return haystack.slice(i, k + 1); }
  }
  return "";
}

console.log("== #240 W-LEADERHIDE web: 会话列表 Leader 卡移除 ==");

// ---- A. 桌面 renderMyList 过滤链 ----
console.log("-- A. renderMyList 双口径 + 记账 --");
{
  const fn = blockFrom("const isLeaderSession = (x) => {", sessionDomain);
  ok(fn.length > 0, "A1 isLeaderSession 谓词在场（renderMyList 闭包内）");
  ok(fn.includes("S.leaderSessionId") && fn.includes("x.session_id === S.leaderSessionId"), "A2 口径①锚 id 判定在场");
  ok(/leader\|领队/.test(fn), "A3 口径②编制 role 词表（leader|领队）在场");
  ok(!/pm\|/.test(fn.split("/^")[1] || ""), "A4 词表不含 pm（PM 会话卡照常直列，禁猜删口径）");
  ok(/\[\.\.\.S\.sessions\.values\(\)\]\s*\.filter\(\(x\) => !isLeaderSession\(x\)\)/.test(sessionDomain.replace(/\s+/g, " ")), "A5 liveSessions 排除 leader 在场");
  ok(sessionDomain.includes("isLeaderSession(x) || !((pinnedKeep(x)"), "A6 filterHidden 记账含 leader（FB17 防死循环）");
  ok(/\[\.\.\.liveSessions\]\s*\.filter\(\(x\) => filterDef\.test\(x\) && !slimVisible\(x\)\)/.test(sessionDomain.replace(/\s+/g, " ")), "A7 slimHiddenIds 记账走 liveSessions（leader 不重复入 slim 账）");
  ok(sessionDomain.includes("S.leaderSessionId = typeof p.leader_session_id === \"string\""), "A8 SNAPSHOT.leader_session_id 读取接线在场");
  // ---- B. isLeaderSession 直跑（mock S + slimRoster 闭包自由变量） ----
  console.log("-- B. isLeaderSession 直跑 --");
  if (fn.length > 0) {
    const mk = (leaderId: string, roster: Map<string, { role?: string }>) => {
      const S = { leaderSessionId: leaderId };
      const slimRoster = { bySid: roster };
      return eval(fn.replace("const isLeaderSession = ", "(") + ")");
    };
    ok(mk("lead-1", new Map())({ session_id: "lead-1" }) === true, "B1 锚 id 命中 → leader");
    ok(mk("", new Map([["w1", { role: "leader" }]]))({ session_id: "w1" }) === true, "B2 词表 role=leader 命中 → leader");
    ok(mk("", new Map([["w2", { role: "领队" }]]))({ session_id: "w2" }) === true, "B3 词表 role=领队（中文）命中 → leader");
    ok(mk("", new Map([["w3", { role: "pm" }]]))({ session_id: "w3" }) === false, "B4 role=pm 不命中（PM 会话照常直列）");
    ok(mk("lead-1", new Map())({ session_id: "w4" }) === false, "B5 普通会话不命中");
    ok(mk("", new Map())({ session_id: "lead-1" }) === false, "B6 旧 relay（无锚 id 无词表）不命中=不滤（行为回退旧样）");
  } else {
    ok(false, "B0 isLeaderSession 提取失败，直跑跳过");
  }
}

// ---- C. onCollabMode leader 分支退役 ----
console.log("-- C. onCollabMode upsert 退役 --");
{
  // UI 反馈批 1029 件B：签名带 evSource（切态帧同快照口径维护每源锚 id 记账）
  const fn = blockFrom("function onCollabMode(p, evSource) {", sessionDomain);
  ok(fn.length > 0, "C1 onCollabMode 在场");
  ok(fn.includes("onDeleted(lid)"), "C2 no-leader 锚卡回收分支保留");
  ok(!fn.includes("S.sessions.set(p.leader_session"), "C3 leader 分支锚卡 upsert 退役（用户口径：列表不放 Leader 卡）");
  ok(fn.includes("S.collabMode = p.mode"), "C4 模式位照常更新（开关回显不受影响）");
}

// ---- D. mobile.js 手机壳过滤 ----
console.log("-- D. mobile.js renderInbox 过滤 --");
{
  const fn = blockFrom("const mobileLeaderIds = () => {", mobileJs);
  ok(fn.length > 0, "D1 mobileLeaderIds 帮手在场");
  ok(mobileJs.includes("allSessions().filter((s) => !leaderIds.has(s.session_id))"), "D2 renderInbox 主列表过滤调用在场");
  ok(/leader\|领队/.test(fn), "D3 词表同口径（leader|领队）");
  if (fn.length > 0) {
    const mk = (S: any) => {
      const b2Api = () => ({ S });
      return eval(fn.replace("const mobileLeaderIds = ", "(") + ")");
    };
    ok(mk({ leaderSessionId: "lead-9", projects: [] })().has("lead-9"), "D4 锚 id 入集合");
    ok(mk({ leaderSessionId: "", projects: [{ headcount: [{ session_id: "w9", role: "leader" }] }] })().has("w9"), "D5 词表成员入集合");
    ok(mk({ leaderSessionId: "", projects: [{ headcount: [{ session_id: "w8", role: "pm" }] }] })().size === 0, "D6 pm 不入集合（PM 卡照常）");
    ok(mk(undefined)().size === 0, "D7 b2Api 缺席（api.S undefined）不炸、零集合");
  } else {
    ok(false, "D0 mobileLeaderIds 提取失败，直跑跳过");
  }
}

// ---- E. relay SNAPSHOT 对称 ----
console.log("-- E. relay SNAPSHOT 字段对称 --");
ok(wsServer.includes("leader_session_id: mgr.leaderSessionId()"), "E1 ws-server SNAPSHOT 携带 leader_session_id");
ok(cloudClient.includes("leader_session_id: this.mgr.leaderSessionId()"), "E2 cloud-client 云通道快照同源携带（#117 教训）");
ok(sessionManager.includes("leaderSessionId(): string {"), "E3 session-manager.leaderSessionId() 读取器在场");
ok(sessionManager.includes("return this.leaderId ?? \"\";"), "E4 锚 id 空值回退空串（无锚/旧 relay）");
ok(cloudClient.includes("collab_mode: this.mgr.collabMode()") && wsServer.includes("collab_mode: mgr.collabMode()"), "E5 与 collab_mode 同区下发（W-MODE 同源锚）");

console.log(`\n#240 W-LEADERHIDE web 断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
