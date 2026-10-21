// W-SRC2 #134 聚合源标签根修测试：relay SNAPSHOT per-session relay_source 下发
//（ws-server LAN 快照 + cloud-client 云快照两出口同键）+ web/expo 消费面守卫锚。
// 根修语义：relay 单点自报本源名——消灭客户端三处补丁拼标（t25fix/B4 桥/B2 建卡）
// 的存量卡漏标/时序竞态；旧端 `|| srcTag` / `if (!s.relay_source)` 守卫自动让位。
//
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-src2.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(RELAY_ROOT, "..");
const ws = readFileSync(join(RELAY_ROOT, "src", "ws-server.ts"), "utf-8");
const cc = readFileSync(join(RELAY_ROOT, "src", "cloud-client.ts"), "utf-8");
const sd = readFileSync(join(WEB_ROOT, "web-console", "js", "session-domain.js"), "utf-8");
const ls = readFileSync(join(WEB_ROOT, "expo-app", "src", "screens", "ListScreen.tsx"), "utf-8");
const pt = readFileSync(join(WEB_ROOT, "expo-app", "src", "protocol.ts"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== W-SRC2: relay per-session relay_source 根修 ==");

// ---- A. withRelaySource 直跑（两文件同构函数，从 ws-server 提取） ----
console.log("-- A. withRelaySource 直跑 --");
{
  const m = ws.match(/function withRelaySource[\s\S]*?\n\}/)?.[0] ?? "";
  ok(m.length > 0, "A1 ws-server helper 在场");
  const js = m.replace(/ReturnType<SessionManager\["snapshot"\]>/g, "any[]").replace("(sessions: any[], relayName: string | undefined): any[]", "(sessions, relayName)");
  const fn = eval("(function(){" + js + " return withRelaySource;})()");
  const rows = [{ session_id: "a" }, { session_id: "b", relay_source: "自带不覆盖" }];
  const out = fn(rows, "Mac-relay");
  ok(out[0].relay_source === "Mac-relay", "A2 无字段会话注入本源名");
  ok(out[1].relay_source === "自带不覆盖", "A3 已带字段不覆盖（?? 语义）");
  ok(fn(rows, undefined) === rows, "A4 空名=原数组引用返回（零注入零开销）");
  ok(rows[0].relay_source === undefined, "A5 原对象未被突变（map 浅拷贝）");
}

// ---- B. 双出口接线静态锚（#117 教训：两出口必须同键） ----
console.log("-- B. 双出口接线 --");
ok(ws.includes("sessions: withRelaySource(mgr.snapshot(), opts.relayName?.())"), "B1 ws-server LAN SNAPSHOT 注入（relay_name 同源 opts.relayName）");
ok(cc.includes("sessions: withRelaySource(this.mgr.snapshot(), this.extra?.relayName?.())"), "B2 cloud-client 云 SNAPSHOT payload 注入（#117 两出口同键）");
ok((cc.match(/withRelaySource\(this\.mgr\.snapshot\(\), this\.extra\?\.relayName\?\.\(\)\)/g) ?? []).length >= 3, "B3 cloud-client 三处（payload+size probe×2——夹紧探测与实发同形）");
{
  const idx = cc.indexOf("payload: {");
  const seg = cc.slice(idx, idx + 400);
  ok(seg.includes("withRelaySource(this.mgr.snapshot()"), "B4 SNAPSHOT payload 段无漏网裸 snapshot()（首 400 字内注入在场）");
}

// ---- C. web 消费面守卫（relay 下发自动优先，零改兼容的机制锚） ----
console.log("-- C. web 守卫锚 --");
ok(sd.includes("if (s && !s.relay_source) s.relay_source = srcName"), "C1 t25fix SNAPSHOT 打标守卫（relay 自带字段让位）");
ok(sd.includes("relay_source: session.relay_source || srcTag") || readFileSync(join(WEB_ROOT, "web-console", "js", "settings-domain.js"), "utf-8").includes("relay_source: session.relay_source || srcTag"), "C2 B4 桥打标 || srcTag 守卫");
ok(sd.includes("p 将来若携带 relay_source 以 p 为准") || sd.includes("Object.assign({ session_id"), "C3 B2 建卡 p 后置覆盖语义在位");
ok(sd.includes("(x.relay_source || x.source)"), "C4 srcSet 多源显形门消费 relay_source（聚合自动 >1 显标签）");

// ---- D. expo 消费面 ----
console.log("-- D. expo 消费面 --");
ok(ls.includes("srcBadgeOf(item.s.src, item.s.relay_source)"), "D1 调用点传 relay_source（第二参兜底）");
ok(ls.includes("relaySource ? displaySrcName(relaySource) : \"其他\""), "D2 nameOf miss 回落 relay_source（不再裸显「其他」）");
ok(pt.includes("relay_source?: string"), "D3 protocol.ts 类型字段（旧 relay 缺省兼容）");
ok(ls.includes("if (!src && !relaySource) return null"), "D4 双缺才 null（云源离线残留卡靠 relay_source 仍显标）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
