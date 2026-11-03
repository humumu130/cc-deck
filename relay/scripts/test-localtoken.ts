// [W-LOCALTOKEN]（1103 双机 P0）App 连不上本机 relay——token 失配自愈链断裂修复钉死。
// R2（双审需修补收口）：A4 升负形（connectLan 必须在 try 块外——brace 级）/A5 升位置锁
// （回调起+await 后两处守卫，删复查行必红）/A3 改真（healTimer 三重自限如实）/新增
// A8 浏览器探针回环限定+A9 每轮无门控形状锁（B 审 M2/M3 变异全锁死）。
// 文本锚范式（test-005-leaderhide 同款：005 壳 JS 闭包内嵌不可直跑，锚代码形态）：
//   A1 重连链探针先行（scheduleReconnect：probe→apply→connect 序列在场）
//   A2 applyLocalProbe 刷新面完整（cfg.wsUrl/cfg.token/localStorage/window 活读点）
//   A3 定罪叙事如实（healTimer 真存在+三重自限；「只是注释」失实短语退役）
//   A4 探针失败不弃连（connectLan 在 try 块 brace 外——挪进块内必红）
//   A5 停止守卫双闸（回调起+await 探针后各一处——删 await 后复查行必红）
//   A6 本机链 token 消费点=cfg.token（connectLan URL 构造）——定罪报告「候选①不成立」
//      的代码证据面（本机源无 ccd_servers 条目存储，源切换器本机行=纯视图）
//   A7 壳探针面健康（main.rs probe_local=/local-info 1.5s 超时 reqwest 无 Origin——
//      PM 实测回环接口健在，非断点）
//   A8 浏览器探针回环限定（非回环 served 页面不探——跨机形态防别机 token 投毒）
//   A9 每轮无门控（回调起点到探针 await 之间零条件形状锁——加任何门控必红）
// 直跑：cd relay && node --import tsx/esm scripts/test-localtoken.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
const mainrs = readFileSync(join(root, "desktop-tauri", "src-tauri", "src", "main.rs"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}
function blockAt(needle: string): string {
  const i = sd.indexOf(needle);
  if (i < 0) return "";
  const j = sd.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < sd.length; k++) {
    if (sd[k] === "{") depth++;
    else if (sd[k] === "}") { depth--; if (depth === 0) return sd.slice(j, k + 1); }
  }
  return "";
}
// brace 级匹配：openIdx 处「{」的配对闭合位置（A4 负形用——try 块内/外真分界）
function braceClose(src: string, openIdx: number): number {
  let depth = 0;
  for (let k = openIdx; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return k; }
  }
  return -1;
}

// ---------- A1 重连链探针先行 ----------
console.log("A1 重连链探针先行（scheduleReconnect）:");
{
  const blk = blockAt("function scheduleReconnect");
  ok(blk.length > 0, "scheduleReconnect 在场");
  ok(/setTimeout\(async/.test(blk), "重连回调 async 化（探针 await 挂点）");
  const pi = blk.indexOf("probeLocalRelay()");
  const ai = blk.indexOf("applyLocalProbe(probed)");
  const ci = blk.indexOf("connectLan(context)");
  ok(pi >= 0 && ai > pi && ci > ai, "探针→应用→连接 序列（probe→apply→connect 顺序钉死）");
  ok(/context === ctx/.test(blk), "仅本机 ctx 应用探针（云 ctx 防御性判同）");
  ok(/context\.reconnectDelay = Math\.min\(context\.reconnectDelay \* 2, 30000\)/.test(blk), "退避曲线原样（探针叠加不破坏 #40web 退避）");
}

// ---------- A2 applyLocalProbe 刷新面 ----------
console.log("A2 applyLocalProbe 刷新面完整:");
{
  const blk = blockAt("function applyLocalProbe");
  ok(blk.length > 0, "applyLocalProbe 在场");
  ok(/ctx\.cfg\.wsUrl = "ws:\/\/127\.0\.0\.1:" \+ probed\.port/.test(blk), "cfg.wsUrl 刷新（壳形态回环端口）");
  ok(/ctx\.cfg\.token = relayToken/.test(blk) && /relayToken = probed\.token/.test(blk), "cfg.token 刷新（连接消费点直达）");
  ok(/localStorage\.setItem\("cc-deck-005-token", relayToken\)/.test(blk), "localStorage 持久刷新（下次 boot 兜底源同步）");
  ok(/window\.__ccDeck005Token = relayToken/.test(blk), "域脚本活读点同步（W-NOVAFIX B2）");
}

// ---------- A3 定罪叙事如实（R2-P1-2：改口——healTimer 真存在但三重自限）----------
console.log("A3 定罪叙事如实:");
{
  ok(!sd.includes("其后交给 6s 周期自愈"), "旧 :1688 不完整注释维持退役（R1 已改真，R2 复核）");
  ok(!sd.includes("只是注释"), "「周期自愈只是注释」失实定罪短语退役（R2-P1-2——基线 healTimer 实存）");
  ok(sd.includes("三重自限") && sd.includes("healTimer"), "改口为真：healTimer 真实存在+三重自限（壳限定/15 次 90s 停表/online-connecting 自清）如实入注");
  ok(sd.includes("每轮重连都探") || sd.includes("每轮重连前探针先行"), "真实自愈描述在场（无封顶重连链每轮探针）");
  ok(sd.includes("[W-LOCALTOKEN]"), "修复批标记在场（考古锚）");
}

// ---------- A4 探针失败不弃连（R2-P2①：负形升格——brace 级 try 块外）----------
console.log("A4 探针失败不弃连:");
{
  const blk = blockAt("function scheduleReconnect");
  const ti = blk.indexOf("try {");
  const ci = blk.indexOf("connectLan(context)");
  const tc = ti >= 0 ? braceClose(blk, blk.indexOf("{", ti)) : -1; // try 块配对闭合位置
  ok(ti >= 0 && tc >= 0 && ci > tc, "connectLan 在 try 块 brace 外（挪进块内=throw 被 catch 吞连接，必红）");
  ok(/探针失败不弃连/.test(blk), "catch 语义注释（transport 故障照连）");
}

// ---------- A5 停止守卫双闸（R2-P1-1：位置锁——回调起+await 后两处，删复查行必红）----------
console.log("A5 停止守卫双闸:");
{
  const blk = blockAt("function scheduleReconnect");
  const guards = [...blk.matchAll(/if \(context\.stopped\) return;/g)].map((m) => m.index ?? -1);
  const ai = blk.indexOf("await probeLocalRelay()");
  ok(guards.length >= 2, "守卫 ≥2 处（实际 " + guards.length + "）");
  ok(ai >= 0 && guards.filter((g) => g < ai).length >= 1, "守卫①位置：回调起点（await 探针之前）");
  ok(ai >= 0 && guards.filter((g) => g > ai).length >= 1, "守卫②位置：await 探针之后（复查行——删此行本断言必红，R2-P1-1 变异级）");
}

// ---------- A6 本机链 token 消费点（定罪证据面） ----------
console.log("A6 本机链 token 消费=cfg.token（候选①不成立证据）:");
{
  const blk = blockAt("function connectLan");
  ok(/const url = cfg\.wsUrl \+ "\?token=" \+ encodeURIComponent\(cfg\.token\)/.test(blk), "本机 WS URL 构造只用 cfg.token（无条目旁路）");
  ok(!/ccd_servers/.test(blk), "connectLan 零 ccd_servers 消费（本机源≠保存条目——云源条目在云链域）");
}

// ---------- A7 壳探针面 ----------
console.log("A7 壳探针面健康（main.rs probe_local 非断点）:");
{
  ok(mainrs.includes('format!("http://127.0.0.1:{}/local-info", relay_port())'), "probe_local 直探 /local-info（回环无 Origin——PM 实测健在）");
  ok(/from_millis\(1500\)/.test(mainrs), "1.5s 超时窗原样");
  ok(!/Origin/.test(mainrs.slice(mainrs.indexOf("async fn probe_local"), mainrs.indexOf("async fn probe_local") + 900)), "reqwest 不带 Origin（白名单兼容——非断点实证）");
}

// ---------- A8 浏览器探针回环限定（R2-P2③：跨机形态防别机 token 投毒）----------
console.log("A8 浏览器探针回环限定:");
{
  const blk = blockAt("async function probeLocalRelay");
  const gi = blk.indexOf('location.hostname !== "127.0.0.1"');
  const fi = blk.indexOf("fetch(");
  ok(gi > 0 && fi > gi, "非回环 served 页面零探针（守卫在 fetch 之前——浏览器把 127.0.0.1 解析到访问者本机，跨机形态探到的是别机）");
  ok(/location\.hostname !== "localhost"/.test(blk), "localhost 同权放行（本机名访问形态）");
  const si = blk.indexOf("if (shellProbe)");
  ok(si >= 0 && si < gi, "壳形态走 shellProbe 不受限（Rust 直探本机回环，无跨机歧义）");
}

// ---------- A9 每轮无门控形状锁（R2-P2②：B 审 M3 变异锁——探针加频率/条件门控必红）----------
console.log("A9 每轮重连都探（无门控形状锁）:");
{
  const blk = blockAt("function scheduleReconnect");
  const cb = blk.indexOf("setTimeout(async");
  const ai = blk.indexOf("await probeLocalRelay()");
  ok(cb >= 0 && ai > cb, "回调内探针挂点在场");
  // 回调起点→探针 await 之间的形状必须恰为「守卫+try 开括号」（任何 if/三元/计数门控插入即破坏形状）
  const shape = blk.slice(cb, ai).replace(/\s+/g, "");
  ok(shape === 'setTimeout(async()=>{if(context.stopped)return;try{constprobed=', "回调起点→探针零门控形状锁（实形「" + shape.slice(-40) + "」——M3 加门控必红）");
}

console.log(`\nlocaltoken: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
