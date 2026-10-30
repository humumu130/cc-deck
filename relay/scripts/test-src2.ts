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
const mj = readFileSync(join(WEB_ROOT, "web-console", "js", "mobile.js"), "utf-8");
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

// ---- E. W-SRCLABEL #134：relay 源显示名缺省回落主机名（1022 用户实锤根因之一：
//         relay-name 文件从未设置 → 空名 → withRelaySource 零注入 → 全链无源身份） ----
console.log("-- E. relayNameOf 缺省回落（W-SRCLABEL） --");
{
  // W-SRC2 本批锚迁：relayNameOf 已收编 settings.ts effectiveRelayName（index.ts :502 单行
  // 委托）——行为断言改提取 settings.ts 实现（RELAY_NAME_FILE 常量内联化喂 eval）
  const idx = readFileSync(join(RELAY_ROOT, "src", "index.ts"), "utf-8");
  const st = readFileSync(join(RELAY_ROOT, "src", "settings.ts"), "utf-8");
  const m = st.match(/export function effectiveRelayName[\s\S]*?\n}/)?.[0] ?? "";
  ok(m.includes("hostname()"), "E1 effectiveRelayName 在场且回落 hostname（index.ts 委托单点）");
  ok(idx.includes("relayNameOf") && st.includes(`"relay-name"`), "E2 自定义名文件优先（#100 语义保留——RELAY_NAME_FILE 字面量在 settings.ts）");
  const js = m
    .replace("export function effectiveRelayName", "function effectiveRelayName")
    .replace(/\(dataDir: string\): string/, "(dataDir)")
    .replace(/\bRELAY_NAME_FILE\b/g, `"relay-name"`)
    .replace(/\bhostname\(\)/g, "__hn()")
    .replace(/\bjoin\(/g, "__j(")
    .replace(/\breadFileSync/g, "__rf");
  const mk = (rf: (p: string) => string, hn: () => string) =>
    eval("(function (__rf, __hn, __j) {" + js + " return effectiveRelayName;})")(
      rf, hn, (a: string, b: string) => a + "/" + b,
    );
  const missing = mk((_p: string) => { throw new Error("ENOENT"); }, () => "MacBook-Pro-Local");
  ok(missing("/d/x") === "MacBook-Pro-Local", "E3 文件缺失→回落主机名（注入不再被空名清零）");
  const custom = mk((_p: string) => "  自定义源名 \n", () => "MacBook-Pro-Local");
  ok(custom("/d/x") === "自定义源名", "E4 文件在场→自定义名优先并 trim（#100 语义）");
  const blank = mk((_p: string) => "   \n", () => "MacBook-Pro-Local");
  ok(blank("/d/x") === "MacBook-Pro-Local", "E5 空名文件→视同缺失回落主机名");
  const trunc = mk((_p: string) => Array.from({ length: 60 }, (_, i) => String(i % 10)).join(""), () => "H");
  ok(trunc("/d/x").length === 40, "E6 超 40 截断（原口径保留）");
  // 双出口接线：ws-server 与 cloud-client opts 都指 relayNameOf 单点，无残留旧 inline lambda
  ok((idx.match(/relayName: \(\) => relayNameOf\(cfg\.dataDir\)/g) ?? []).length === 2, "E7 双出口（LAN+云）同指 relayNameOf 单点");
  ok(!idx.includes("relayName: () => {"), "E8 无残留旧 inline lambda（单点收口防漂移）");
}

// ---- F. W-SRCLABEL #134：web 通道兜底修活（evSource.relayName 死路 → 通道标签） ----
console.log("-- F. web 通道兜底（W-SRCLABEL） --");
ok(sd.includes('(evSource === "cloud" ? "云桥" : "本机")'), "F1 SNAPSHOT 打标通道兜底在场（relay 无名时两源恒可辨）");
ok(!sd.includes("(evSource && evSource.relayName)"), "F2 死兜底表达式已移除（字符串源标无属性=恒 undefined）");
ok(sd.includes("if (s && !s.relay_source) s.relay_source = srcName"), "F3 首标守卫保留（relay 自报字段让位语义不回退）");
ok(sd.includes("(x.relay_source || x.source)"), "F4 srcSet 门消费 relay_source（聚合 >1 显形链在位）");

// ---- G. W-SRCLABEL #134：打标块逻辑直跑（blockFrom 提取 + eval，四场景） ----
console.log("-- G. 打标块逻辑直跑（W-SRCLABEL） --");
{
  const needle = "const srcName = String((m.payload && m.payload.relay_name)";
  const i = sd.indexOf(needle);
  ok(i >= 0, "G1 打标块锚点在场");
  if (i >= 0) {
    const open = sd.lastIndexOf("{", sd.lastIndexOf("//", i)); // 块首注释前的 {
    let depth = 0, end = -1;
    for (let k = open; k < sd.length; k++) {
      if (sd[k] === "{") depth++;
      else if (sd[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    const block = sd.slice(open, end + 1).replace(/\bArray\.isArray\b/g, "Array.isArray");
    const run = (payload: unknown, evSource: string, pre: [string, Record<string, unknown>][] = []) => {
      const S = { sessions: new Map<string, Record<string, unknown>>(pre) };
      eval("(function (m, evSource, S) {" + block + "})")({ payload }, evSource, S);
      return S.sessions;
    };
    // 场景①：LAN 无名 relay（旧 bundle）→ store 存量卡全盖「本机」
    const s1 = run({ sessions: [{ session_id: "a" }, { session_id: "b" }] }, "lan",
      [["a", { session_id: "a" }], ["b", { session_id: "b" }]]);
    ok(s1.get("a")!.relay_source === "本机" && s1.get("b")!.relay_source === "本机", "G2 LAN 无名→通道兜底「本机」");
    // 场景②：云无名 relay → 盖「云桥」（聚合两源恒两可辨名）
    const s2 = run({ sessions: [{ session_id: "c" }] }, "cloud", [["c", { session_id: "c" }]]);
    ok(s2.get("c")!.relay_source === "云桥", "G3 cloud 无名→通道兜底「云桥」");
    // 场景③：relay_name 在场（W-SRCLABEL 缺省名/自定义名）→ 真名优先
    const s3 = run({ relay_name: "MacBook-Pro", sessions: [{ session_id: "d" }] }, "lan", [["d", { session_id: "d" }]]);
    ok(s3.get("d")!.relay_source === "MacBook-Pro", "G4 relay_name 在场→真名优先");
    // 场景④：relay 自带 relay_source（W-SRC2 注入）→ 首标守卫让位不覆盖
    const s4 = run({ relay_name: "X", sessions: [{ session_id: "e" }] }, "cloud", [["e", { session_id: "e", relay_source: "自带源" }]]);
    ok(s4.get("e")!.relay_source === "自带源", "G5 已带字段不覆盖（首标守卫）");
    // 场景⑤：畸形 payload（无 sessions/坏条目）不抛不误伤；payload 有 store 无的 id 不建卡
    const s5 = run({ sessions: [null, {}, { session_id: 42 }, { session_id: "f" }] }, "lan", [["f", { session_id: "f", relay_source: "存量" }]]);
    ok(s5.get("f")!.relay_source === "存量" && s5.size === 1, "G6 畸形条目跳过、存量卡不受扰");
  }
}

// ---- H. W-SRC2 本批（t-c2109d08 四路收口）：wan resume 面 + web MERGE_KEYS + mobile per-session ----
console.log("-- H. wan 面注入/web 增量透传/mobile per-session（本批） --");
ok((cc.match(/withRelaySource\(this\.mgr\.snapshot\(\)/g) ?? []).length === 6, "H1 wan resume 面三处（probe×2+实发）全包 withRelaySource（phone 3+wan 3）");
ok((cc.match(/\.\.\.\(this\.extra\?\.relayName\?\.\(\) \? \{ relay_name: this\.extra\.relayName\(\) \} : \{\}\)/g) ?? []).length === 2, "H2 relay_name 双面下发（phone 密封面+wan resume 面——#117 键补齐 wan）");
ok((cc.match(/\.\.\.\(this\.extra\?\.lanHint\?\.\(\) \? \{ lan_hint: this\.extra\.lanHint\(\) \} : \{\}\)/g) ?? []).length === 2, "H3 lan_hint 双面下发（同 H2 口径）");
ok(sd.includes('"relay_source"]; // W-SRC2 #134（本批①）'), "H4 web MERGE_KEYS 补 relay_source（SESSION_UPDATED 增量面透传/自愈）");
ok(mj.includes("const sourceBadge = (s)") && mj.includes("s.relay_source"), "H5 mobile 源徽章 per-session 化（relay_source 优先，回落本源名）");
ok((mj.match(/sourceBadge\(s\)/g) ?? []).length >= 3, "H6 mobile 逐卡/详情/任务行三调用点穿参（组织确认卡/引擎分组无会话上下文走回落）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
