// #259 Windows 桌面壳云桥通道静默死 + 配对身份丢失专项（fix/desktop-cloud-dead）：
// 静态锚 + 纯函数/行为直跑（test-005-servers blockFrom 范式；靶子 W-SPLIT 后的
// web-console/js/settings-domain.js + desktop-tauri/src-tauri/src/main.rs）。
//
// 病灶与修复面（四路）：
// ① 身份持久化：loadCloudIdentity 只查键在不验内容（坏 base64 被采信 → devId/seal 同步抛
//    = 通道启动层静默死）；写入全静默 try{}catch{}（WebView2 存储写不进无人知晓 → 重启丢
//    身重配对）。修复=读校验 + 影子补种（__CCDECK_SHADOW 单键）+ 写后读回验证 + 壳层
//    storage_shadow_write 直写兜底。
// ② 通道启动：connectCloudFor ws 构造段同步异常穿透（状态恒卡「连接中」无看门狗）。
//    修复=全包裹 catch → offline+transport 归因 + 退避重试 + ws→poll 通道降级。
// ③ hello 发出：sendCloud false（ws 未就绪/刚死）被静默吞 → relay 侧配对成功后零通道活动。
//    修复=sendCloudHello 收口（四个发出点统一）+ ws.send try/catch。
// ④ 通道看门狗：hello 后 13s 无任何回包帧 → console+UI 显形并重连（poll POST 被吞兜底）。
// ⑤ 壳层 INIT_SCRIPT dumpLS：影子补救键不被 15s 巡拍全量 dump 冲掉。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-clouddead.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
const mainRs = readFileSync(join(root, "desktop-tauri", "src-tauri", "src", "main.rs"), "utf-8");
const tauriConf = JSON.parse(readFileSync(join(root, "desktop-tauri", "src-tauri", "tauri.conf.json"), "utf-8"));

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string, host = sd): string {
  const i = host.indexOf(needle);
  if (i < 0) return "";
  const j = host.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < host.length; k++) {
    if (host[k] === "{") depth++;
    else if (host[k] === "}") { depth--; if (depth === 0) return host.slice(i, k + 1); }
  }
  return "";
}

console.log("== #259 clouddead: 身份持久化加固 + 通道启动自愈 + hello 收口/看门狗 ==");
console.log("-- A. 静态锚：settings-domain.js / main.rs / tauri.conf.json --");

// A1 通道启动全包裹：wrapper 存在且 catch 链齐（offline 归因 + 重试 + ws→poll 降级）
{
  const wrapper = blockFrom("function connectCloudFor(ctx, manual) {");
  ok(wrapper.includes("connectCloudForInner(ctx, manual)"), "A1 connectCloudFor 包裹 Inner（改名锚）");
  ok(/catch \(e\)/.test(wrapper) && wrapper.includes("通道启动失败："), "A1 同步异常显形为 offline（文案锚）");
  ok(wrapper.includes("scheduleCloudReconnect(ctx)"), "A1 异常后按退避重试（不再恒「连接中」）");
  ok(wrapper.includes('ctx.transport = "poll"'), "A1 ws 传输构造失败 → 下次重试降级 poll 通道");
  ok(sd.includes("function connectCloudForInner(ctx, manual) {"), "A1 Inner 主体在场");
}

// A2 hello 收口：四个发出点统一走 sendCloudHello，无裸 sendCloud(ctx,{t:"hello"}) 漏网
{
  const sites = sd.split("sendCloudHello(ctx)").length - 1; // 定义 1 处 + 调用 4 处
  ok(sites === 5, `A2 sendCloudHello 定义+四发出点（现 ${sites} 处）`);
  const helper = blockFrom("function sendCloudHello(ctx) {");
  ok(helper.includes("startChannelWatchdog(ctx)"), "A2 hello 后武装通道看门狗");
  ok(helper.includes("hello 发送失败") && helper.includes("scheduleCloudReconnect(ctx)"), "A2 发送失败（false）显形+立即重连");
  const naked = sd.match(/sendCloud\(ctx, \{ t: "hello"/g) || [];
  ok(naked.length === 1, `A2 裸 sendCloud hello 仅剩 sendCloudHello 体内 1 处（现 ${naked.length}）`);
}

// A3 ws.send 同步异常（INVALID_STATE_ERR 等）不再穿透
{
  const raw = blockFrom("function sendCloudRaw(ctx, str) {");
  ok(/try \{ ctx\.ws\.send\(str\); \} catch/.test(raw) && raw.includes("return false;"), "A3 sendCloudRaw ws.send 包裹（异常→false 归入发送失败链）");
}

// A4 通道看门狗：常量+双函数+帧到达即退役+断链掐清
{
  ok(sd.includes("const CHANNEL_DEAD_MS = 13000;"), "A4 看门狗期限 13s（CHANNEL_DEAD_MS）");
  const wd = blockFrom("function startChannelWatchdog(ctx) {");
  ok(wd.includes("无任何回包") && wd.includes("判通道死并重连"), "A4 看门狗报错文案锚（console 显形）");
  ok(wd.includes("cloudSetConn(\"offline\"") || wd.includes('cloudSetConn("offline"'), "A4 看门狗 → UI 离线归因");
  const oct = blockFrom("function onCloudTextRaw(ctx, text) {");
  ok(oct.includes("ctx._lastFrameAt = Date.now();") && oct.includes("stopChannelWatchdog(ctx);"), "A4 任何可解析帧到达即退役看门狗");
  const disc = blockFrom("function cloudDisconnect() {");
  ok(disc.includes("stopChannelWatchdog(cloudCtx);"), "A4 cloudDisconnect 掐看门狗（定时器清单）");
  const inner = blockFrom("function connectCloudForInner(ctx, manual) {");
  ok(inner.includes("stopChannelWatchdog(ctx);"), "A4 每轮连接先清旧看门狗（hello 点重挂）");
}

// A5 身份持久化加固五件套 + 壳层直写
{
  ok(sd.includes("function cloudKpLooksValid(kp) {"), "A5 cloudKpLooksValid 在场");
  ok(sd.includes("function readStoredCloudKp() {") && sd.includes("function shadowSeedGet(key) {"), "A5 读校验/影子单键补种在场");
  const pc = blockFrom("function persistCloudIdentity() {");
  ok(pc.includes('localStorage.getItem("ccr_cloud_kp")'), "A5 写后读回验证（echo 校验）");
  ok(pc.includes('invoke("storage_shadow_write"'), "A5 写失败 → 壳层 storage_shadow_write 直写兜底");
  ok(pc.includes("写入未生效"), "A5 存储异常响亮报错（不再静默）");
  const lc = blockFrom("function loadCloudIdentity() {");
  ok(lc.includes("readStoredCloudKp()") && lc.includes('shadowSeedGet("ccr_cloud_kp")'), "A5 loadCloudIdentity 编排：读校验→影子补种→重建");
}

// A6 壳层 INIT_SCRIPT：巡拍 dump 保留影子补救键（防冲掉）
{
  const dump = blockFrom("const dumpLS = () => {", mainRs);
  ok(dump.includes("__CCDECK_SHADOW") && dump.includes("!(k in o)"), "A6 main.rs dumpLS 合并影子补救键（#259）");
  ok(mainRs.includes("storage_shadow_write"), "A6 壳层 storage_shadow_write 命令在场（直写兜底落点）");
}

// A7 Windows WebView2 通道前置（静态断言代真机）：CSP connect-src 放行 wss/https + 壳 origin 判定
{
  const csp = String((tauriConf.app && tauriConf.app.security && tauriConf.app.security.csp) || "");
  ok(/connect-src[^;]*wss:/.test(csp) && /connect-src[^;]*https:/.test(csp), "A7 tauri.conf CSP connect-src 放行 wss:/https:（云桥通道前置）");
  ok(/tauri\.localhost/i.test(sd), "A7 页面侧 tauri.localhost 壳判定锚在场（defaultCloudUrl 壳分支）");
}

console.log("-- B. 行为直跑：身份读校验 / 影子补种 / 写失败兜底（真 nacl + 沙盒存储） --");

// 抽取密封段（B64/fromB64/genKp/devId）+ 身份五件套 + lsSet/lsGet，沙盒直跑
const SEAL_START = "// ---------- 云桥 E2E 密封层（";
const SEAL_END = "// ---------- 云桥 E2E 密封层结束 ----------";
const sealStart = sd.indexOf(SEAL_START);
const sealEnd = sd.indexOf(SEAL_END, sealStart);
const sealCode = sealStart >= 0 && sealEnd > sealStart ? sd.slice(sealStart, sealEnd + SEAL_END.length) : "";
const fns = ["function cloudKpLooksValid(kp) {", "function readStoredCloudKp() {", "function shadowSeedGet(key) {", "function persistCloudIdentity() {", "function loadCloudIdentity() {", "function lsGet(k) {", "function lsSet(k, v) {"]
  .map((n) => blockFrom(n)).join("\n");
type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
function makeStorage(dropWrites = false): { store: Map<string, string>; obj: Storage } {
  const store = new Map<string, string>();
  const obj: Storage = {
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => { if (!dropWrites) store.set(k, v); }, // dropWrites=true 模拟 WebView2 写入静默失效
    removeItem: (k) => { store.delete(k); },
  };
  return { store, obj };
}
function makeFactory(ls: Storage, ss: Storage, win: unknown) {
  const preamble = "let ckp = null; let cloudStoreErrReported = false;";
  // eslint-disable-next-line no-new-func
  return new Function("localStorage", "sessionStorage", "window", "console", "nacl",
    `"use strict";\n${sealCode}\n${preamble}\n${fns}\n;return { cloudKpLooksValid, loadCloudIdentity, peekCkp: () => ckp };`)(ls, ss, win, console, nacl) as {
    cloudKpLooksValid: (kp: unknown) => boolean;
    loadCloudIdentity: () => void;
    peekCkp: () => { publicKey: string; secretKey: string } | null;
  };
}

// B1 cloudKpLooksValid 四态（真密钥/坏 base64/错长度/缺键）
{
  const { obj: ls } = makeStorage(); const { obj: ss } = makeStorage();
  const F = makeFactory(ls, ss, {});
  const gen = nacl.box.keyPair();
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const realKp = { publicKey: b64(gen.publicKey), secretKey: b64(gen.secretKey) };
  ok(F.cloudKpLooksValid(realKp) === true, "B1 真 32 字节密钥对 → 有效");
  ok(F.cloudKpLooksValid({ publicKey: "!!not-base64!!", secretKey: realKp.secretKey }) === false, "B1 坏 base64 → 拒收（旧实现会采信 → devId 抛异常静默死）");
  ok(F.cloudKpLooksValid({ publicKey: b64(gen.publicKey.slice(0, 16)), secretKey: realKp.secretKey }) === false, "B1 错长度（16 字节）→ 拒收");
  ok(F.cloudKpLooksValid(null) === false && F.cloudKpLooksValid({ publicKey: realKp.publicKey }) === false, "B1 null/缺键 → 拒收");
}

// B2 坏库弃用重建：存储残留坏密钥 → 重新生成有效身份（devId 可算不再抛）
{
  const { store: lsStore, obj: ls } = makeStorage(); const { obj: ss } = makeStorage();
  lsStore.set("ccr_cloud_kp", JSON.stringify({ publicKey: "!!corrupt!!", secretKey: "!!corrupt!!" }));
  const F = makeFactory(ls, ss, {});
  F.loadCloudIdentity();
  const kp = F.peekCkp();
  ok(!!kp && F.cloudKpLooksValid(kp), "B2 坏库弃用 → 新身份有效");
  ok(kp!.publicKey !== "!!corrupt!!", "B2 新身份确非坏值");
}

// B3 影子补种：localStorage 丢键（空）但壳层影子有有效身份 → 恢复同身份（dev 号不变，免重配对）
{
  const { obj: ls } = makeStorage(); const { obj: ss } = makeStorage();
  const gen = nacl.box.keyPair();
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const seedKp = { publicKey: b64(gen.publicKey), secretKey: b64(gen.secretKey) };
  const F = makeFactory(ls, ss, { __CCDECK_SHADOW: { ccr_cloud_kp: JSON.stringify(seedKp) } });
  F.loadCloudIdentity();
  ok(F.peekCkp()!.publicKey === seedKp.publicKey, "B3 影子补种命中（身份保持，重启不重配对）");
  ok(ls.getItem("ccr_cloud_kp") === JSON.stringify(seedKp), "B3 补种后回写 localStorage（下次直读）");
}

// B4 写失败兜底：localStorage 写入静默失效 → 直写壳层影子 + 报错留痕
{
  const { obj: ls } = makeStorage(true); // dropWrites：setItem 静默丢弃
  const { obj: ss } = makeStorage();
  const invokes: Array<{ cmd: string; args: Record<string, string> }> = [];
  const win = {
    __CCDECK_SHADOW: { some_user_pref: "1" },
    __TAURI__: { core: { invoke: (cmd: string, args: Record<string, string>) => { invokes.push({ cmd, args }); return Promise.resolve(); } } },
  };
  const F = makeFactory(ls, ss, win);
  F.loadCloudIdentity();
  const direct = invokes.find((i) => i.cmd === "storage_shadow_write");
  ok(!!direct, "B4 写失败 → invoke('storage_shadow_write') 直写壳层落盘");
  ok(!!direct && (() => { try { return !!JSON.parse(direct.args.payload)["ccr_cloud_kp"]; } catch { return false; } })(), "B4 直写 payload 含设备身份 ccr_cloud_kp");
  ok(!!direct && (() => { try { return JSON.parse(direct.args.payload)["some_user_pref"] === "1"; } catch { return false; } })(), "B4 直写合并既有影子键（不冲掉）");
}

console.log("-- C. 通道启动包裹直跑：Inner 同步异常 → offline+重试+通道降级 --");
{
  const wrapper = blockFrom("function connectCloudFor(ctx, manual) {");
  // eslint-disable-next-line no-new-func
  const mk = new Function("connectCloudForInner", "cloudSetConn", "scheduleCloudReconnect", "console",
    `"use strict";\n${wrapper}\n;return connectCloudFor;`);
  const calls: Array<{ status: string; text: string; kind: string }> = [];
  const retries: unknown[] = [];
  const cloudSetConn = (status: string, text: string, kind: string) => { calls.push({ status, text, kind }); };
  const scheduleCloudReconnect = (ctx: unknown) => { retries.push(ctx); };
  const inner = (): never => { throw new Error("WebSocket constructor boom"); };
  const ctx = { transport: "ws", cfg: { name: "云桥" } };
  const fn = mk(inner, cloudSetConn, scheduleCloudReconnect, console) as (c: unknown, m: boolean) => void;
  fn(ctx, false);
  ok(calls.length === 1 && calls[0].status === "offline" && calls[0].kind === "transport", "C1 同步异常 → cloudSetConn(offline, transport)");
  ok(calls[0].text.includes("通道启动失败") && calls[0].text.includes("WebSocket constructor boom"), "C1 报错文案携带病因（诊断显形）");
  ok(retries.length === 1, "C1 scheduleCloudReconnect 被调（自愈重试）");
  ok((ctx as { transport: string }).transport === "poll", "C1 ws 传输失败 → 降级 poll（下次重试走轮询通道）");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
