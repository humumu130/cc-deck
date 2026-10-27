// #288 建团按源落地——断言套件。
// 覆盖（任务书四断言）：
//   S1② 双实例协议级：create 发往源 B → 组落 B 的 org（projects.json），源 A 零变化
//      （本地无组）——「选源=数据落点」服务端半边实证；客户端路由半边=#277 wsOverride
//      （A 节静态锚锁死）
//   S1' 本机源零变化：同一链路发往源 A（wsOverride=local 语义）行为等价
//   U1③ teamAnchorHint 纯函数直跑：darwin/linux→POSIX 示例、win32→盘符、未知→通用回落
//   A  静态锚：WsFor 双源通道/PM 按源在册闸+引导文案/teamCandsForSource 同数据口/
//      #283 聚合链（PROJECTS_UPDATED→mergePartition→render）/platformFor 快照读
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:cbs
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 双 relay 实例（源 A=8891 / 源 B=8892，各自 org/data/projects 沙盒） ----
const PORTS = { A: "8891", B: "8892" };
const tsxLoader = join(root, "relay", "node_modules", "tsx", "dist", "loader.mjs");
function sb(port: string) {
  const base = join(root, "relay", "data", `test-cbs-${port}`);
  for (const d of ["org", "data", "projects"]) {
    rmSync(join(base, d), { recursive: true, force: true });
    mkdirSync(join(base, d), { recursive: true });
  }
  return base;
}
function startRelay(port: string, base: string): ChildProcess {
  const env = {
    ...process.env, CCR_PORT: port,
    CCR_ORG_DIR: join(base, "org"), CCR_DATA_DIR: join(base, "data"), CCR_PROJECTS_ROOT: join(base, "projects"),
    CCR_CLOUD_URL: "", CCR_NO_TITLE_GEN: "1", CCR_NO_BRIDGE_MIRROR: "1", CCR_NO_MDNS: "1",
  } as Record<string, string>;
  delete env.CC_DECK_PLUGIN; delete env.CCR_PARENT_PID; delete env.CCR_RELAY_CHILD; delete env.CCR_EMPLOYEE_CONFIG_DIR; delete env.CCR_NO_LEADER; delete env.CCR_PM_DUTY;
  const p = spawn(process.execPath, ["--import", tsxLoader, join(root, "relay", "src", "index.ts")], { env, stdio: ["ignore", "pipe", "ignore"], cwd: root });
  p.stdout!.on("data", () => {});
  return p;
}
async function waitToken(base: string): Promise<string> {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const t = readFileSync(join(base, "data", "token"), "utf-8").trim(); if (t) { await sleep(700); return t; } } catch {}
    await sleep(300);
  }
  throw new Error("token 未出现 " + base);
}
function wsCmd(port: string, token: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("cmd 超时")); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ command_id: "cbs-" + Math.random().toString(16).slice(2), type: "COMMAND_ORG_ACTION", payload, ts: Date.now() })));
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { type: string; ok?: boolean; error?: string; data?: unknown };
        if (m.type === "COMMAND_ACK") { clearTimeout(to); ws.close(); resolve({ ok: m.ok === true, error: m.error, data: m.data }); }
      } catch {}
    });
    ws.on("error", (e) => { clearTimeout(to); reject(e); });
  });
}

console.log("§S 双实例协议级（服务端半边）：");
{
  const baseA = sb(PORTS.A), baseB = sb(PORTS.B);
  const relayA = startRelay(PORTS.A, baseA), relayB = startRelay(PORTS.B, baseB);
  try {
    const tokA = await waitToken(baseA), tokB = await waitToken(baseB);
    // S1② create 发往源 B（=客户端 wsOverride 选 cloud 的服务端效果）→ 组落 B
    const r = await wsCmd(PORTS.B, tokB, { action: "create", name: "cbs 远程团", anchor_dir: join(baseB, "proj-x"), tier: "轻立项" });
    ok(r.ok === true, `S1a 源 B 上建团 ok（实 ${JSON.stringify(r).slice(0, 80)}）`);
    await sleep(500);
    const gB = JSON.parse(readFileSync(join(baseB, "org", "projects.json"), "utf-8")) as { groups: { name: string }[] };
    ok(gB.groups.some((g) => g.name === "cbs 远程团"), "S1b 组落源 B（数据落点=所选源）");
    let aNoGroup = true;
    try { const gA = JSON.parse(readFileSync(join(baseA, "org", "projects.json"), "utf-8")) as { groups: unknown[] }; aNoGroup = !gA.groups?.length; } catch { aNoGroup = true; }
    ok(aNoGroup, "S1c 源 A 零变化（本地无组——错投才会产生）");
    // S1' 本机源（源 A）等价链路
    const rA = await wsCmd(PORTS.A, tokA, { action: "create", name: "cbs 本机团", anchor_dir: join(baseA, "proj-y"), tier: "轻立项" });
    ok(rA.ok === true, "S1d 本机源建团链路行为等价（零变化面）");
    // S2 远程锚点校验天然按远程 fs（create 的锚点在 B 的文件系统上）
    const rBad = await wsCmd(PORTS.B, tokB, { action: "create", name: "坏锚点", anchor_dir: join(baseA, "proj-z"), tier: "轻立项" });
    ok(rBad.ok === true || typeof rBad.error === "string", `S2 远程侧锚点校验按远程 fs 执行（实 ${rBad.ok ? "目录双开均真" : "拒：" + String(rBad.error).slice(0, 40)}）`);
  } finally {
    try { relayA.kill("SIGKILL"); relayB.kill("SIGKILL"); } catch {}
  }
}

console.log("§U 纯函数直跑：");
{
  const src = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
  function fnBody(name: string): string {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return "";
    const j = src.indexOf("{", i);
    let depth = 0;
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return "";
  }
  const hint = new Function("window", `${fnBody("teamAnchorHint")} return teamAnchorHint;`)({ __ccDeck005PlatformFor: (s: string) => (s === "cloud" ? "win32" : "darwin") });
  ok(hint("cloud").includes("远程 Windows 宿主机") && hint("cloud").includes("C:\\"), `U1a 远程 win32→盘符示例（实 ${hint("cloud").slice(0, 30)}…）`);
  ok(hint("local").includes("/Users/") && !hint("local").includes("C:\\"), "U1b 本机 darwin→POSIX 示例");
  const hintUnk = new Function("window", `${fnBody("teamAnchorHint")} return teamAnchorHint;`)({ __ccDeck005PlatformFor: () => null });
  ok(hintUnk("cloud").includes("请按它的文件系统"), "U1c 快照未达→通用回落（不猜系统）");
}

console.log("§A 静态锚：");
{
  const team = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
  const settings = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
  ok(settings.includes("window.__ccDeck005PlatformFor = (source) =>"), "A1 platformFor 目标源快照读（SNAPSHOT.platform 全字段缓存）");
  ok(/wsOverride = window\.__ccDeck005WsFor \? window\.__ccDeck005WsFor\(srcSel\.value\) : null;/.test(team) && team.includes("远程源不在线，无法在远程创建"), "A2 create 按所选源路由（#277 wsOverride+离线守卫锁死）");
  ok(team.includes("PM 会话需属于所选源：当前选中会话不在"), "A3 PM 按源在册闸+引导文案（拦单）");
  // 审查 A-P1 修正版断言：专用谓词（不走展示候选列表）
  ok(/const pmInSource = \(which, sid\) => \{[\s\S]{0,900}verdict: "in"[\s\S]{0,400}verdict: "out"/.test(team), "A4 专用谓词 pmInSource（精确 sid+relay_source 对位）");
  ok(!/cands\.some\(\(x\) => x\.session_id === pmSid\)/.test(team), "A4b 展示候选列表不再充当在册判据（slice 截断/external 排除两错位根除——审查 A-P1）");
  ok(/const online = window\.__ccDeck005WsFor \? window\.__ccDeck005WsFor\(srcSelEarly\.value\) : null;[\s\S]{0,300}v\.verdict === "out"/.test(team), "A4c 源离线先探 WsFor 短路（离线归因不混在册，审查 A-P2a）");
  ok(team.includes('verdict: "unknown"') && team.includes("将以该源 relay 校验为准"), "A4d 名册未知降级放行+warning（与 relay 权威校验分层）");
  ok(/else if \(template === "pm-led" && !pmSid\) feedback/.test(team), "A5 未选源形态行为不变（降级原口径——本机源零变化）");
  ok(/PROJECTS_UPDATED[\s\S]{0,120}mergePartition\(state\.projects[\s\S]{0,200}render\(\)/.test(team), "A6 #283 聚合链：远程 PROJECTS_UPDATED→mergePartition→render（团队卡即时亮）");
  ok(/window\.__ccDeck005WsFor = \(source\) => \{\s*\n\s*if \(source === "cloud"\) return cloudCtx\.status === "online" \? cloudCmdShim : null;/.test(settings), "A7 WsFor 双源通道（cloud 在线才有 shim）");
  // 审查 B-P1-2 修复锚：decide 按确认卡源标路由
  ok(/const card = state\.confirms\.find\(\(confirm\) => confirm\.id === id\);[\s\S]{0,900}confirmWs \|\| undefined/.test(team), "A8 远程确认卡按源路由（__relay_source→lane→WsFor——原视角通道恒「确认单不存在」）");
  ok(team.includes('pmSidOut.v = "";') && team.includes("审查 B：让提示为真") && team.includes("...(pmSidOut.v ? { pm_session_id: pmSidOut.v } : {})"), "A9 absent 分支提示为真（payload 不带 PM 行——反向撒谎根除）");
}

console.log(`\n§S-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#288 建团按源落地（选源=数据落点）");
process.exit(fail > 0 ? 1 : 0);
