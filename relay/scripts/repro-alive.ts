// #276 P0 复现实证：relay 重启后活进程外部会话是否重接管（任务书排查③）。
// 子进程真 relay（test.71 代码）× 杀掉重启 × hook 事件驱动，全链复现生产形态：
//   ① 活会话（live pid）：boot 接管 → Stop 断开 → 重启 → 再发 hook 事件 → 卡应翻 WORKING + updated_at 前进 + cli_pid 在册
//   ② 死会话（dead pid）：重启后不误接（不翻活）
//   ③ 转录兜底 vs 真管道：hook 事件处理过的卡 cli_pid 必须在册（兜底扫描不得掩盖断管）
// 直跑：cd relay && env -u CCR_ORG_DIR npx tsx scripts/repro-alive.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const PORT = process.env.REPRO_PORT || String(18820 + Math.floor(Math.random() * 400));
const SB = join(root, "relay", "data", "alive-repro");
// 预清残孩（上次崩溃泄漏的沙盒 relay：命令行不含 alive-repro 字样——按本 worktree
// 的 loader 路径匹配才杀得中；残留进程占端口+持旧 token，是新轮 token mismatch /
// bridge.json 漂移的祸源，实测 5+ 残留互踩）。端口随机化双保险
{
  // standin 残留也要清：`exec -a claude sleep 600` 的进程 cwd 指向沙盒 wd（跨轮固定
  // 路径），残留者会被本轮 cwd 兜底抢配（11ok/2FAIL 轮实锤 22812=上轮残留）。
  // 匹配特征收窄到 argv0=claude 且 $3=600（sleep standin 专属形态），不碰真 CLI
  const r = spawnSync("/bin/sh", ["-c", `ps aux | grep "cc-deck-alivereclaim/relay/node_modules/tsx/dist/loader.mjs" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null; ps axo pid=,command= | awk '$2=="claude" && $3=="600" {print $1}' | xargs -r kill -9 2>/dev/null; sleep 0.5`]);
  void r;
}
for (const d of [join(SB, "org"), join(SB, "data"), join(SB, "wd"), join(SB, "wd-dead"), join(SB, "wd2"), join(SB, "projects")]) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
const ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  CCR_PORT: PORT,
  CCR_ORG_DIR: join(SB, "org"),
  CCR_DATA_DIR: join(SB, "data"),
  CCR_PROJECTS_ROOT: join(SB, "projects"),
  CCR_SESSIONS_ROOT: join(SB, "projects", "sessions"),
  CCR_CLOUD_URL: "",
  CCR_NO_TITLE_GEN: "1",
  CCR_NO_BRIDGE_MIRROR: "1",
  CCR_NO_MDNS: "1",
};
delete ENV.CC_DECK_PLUGIN;
delete ENV.CCR_PARENT_PID;
delete ENV.CCR_RELAY_CHILD;
delete ENV.CCR_EMPLOYEE_CONFIG_DIR;
delete ENV.CCR_NO_LEADER; // 值守面默认开也行——本实证只看卡态
ENV.CCR_PM_DUTY = "0"; // W-DUTY-CHAIN 反转后缺省开——沙盒实证显式关（保持旧隔离语义）

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "｜" + extra : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- pid 道具 ----
// #276 道具升级：argv[0]=claude（ps 词级匹配可命中）+ cwd=SB/wd（cwd 兜底定位可命中）
// ——/bin/sleep 原形态 command 无 claude 词且 cwd 不在 wd，件一/件三的自愈链在旧
// 道具下根本不触发，Phase 2.5 断言无从谈起
const live = spawn("/bin/sh", ["-c", `exec -a claude /bin/sleep 600`], { stdio: "ignore", cwd: join(SB, "wd") }); live.unref();
const livePid = live.pid!;
let deadPid = 0;
for (let i = 0; i < 5 && !deadPid; i++) {
  const r = spawnSync("/bin/sleep", ["0"]);
  if (r.pid) { try { process.kill(r.pid, 0); } catch { deadPid = r.pid; } }
}

// ---- relay 子进程管理 ----
function resetSandboxFiles(): void {
  // 起前删 bridge.json/token：waitBridgeJson 只认新文件（陈旧文件会把客户端导向
  // 上一次的漂移端口——phase1 占 8832 重启后回 8831 的误导源）
  for (const f of ["bridge.json", "token", "bridge-token"]) {
    try { rmSync(join(SB, "data", f), { force: true }); } catch {}
  }
}
function startRelay(): ChildProcess {
  // tsx loader 用绝对路径（worktree 的 node_modules 是符号链接，bare 解析不到根）
  const tsxLoader = join(root, "relay", "node_modules", "tsx", "dist", "loader.mjs"); // 直拼路径绕 exports 闸
  const p = spawn(process.execPath, ["--import", tsxLoader, join(root, "relay", "src", "index.ts")], {
    env: ENV, stdio: ["ignore", "pipe", "pipe"], cwd: root,
  });
  p.stdout!.on("data", (d: Buffer) => { const s = String(d); if (/alive-repro|error|Error|EADDR|ws-upgrade|已启动/.test(s)) process.stdout.write("[relay] " + s); });
  p.stderr!.on("data", (d: Buffer) => process.stdout.write("[relay-err] " + String(d)));
  return p;
}
async function waitBridgeJson(ms = 15000): Promise<{ port: number; token: string; bridgeToken: string }> {
  const f = join(SB, "data", "bridge.json");
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const j = JSON.parse(readFileSync(f, "utf-8")) as { port: number; token: string };
      let wsToken = "";
      try { wsToken = readFileSync(join(SB, "data", "token"), "utf-8").trim(); } catch {}
      if (j.port && j.token && wsToken) {
        await sleep(600); // 监听就绪余量
        return { port: j.port, token: wsToken, bridgeToken: j.token };
      }
    } catch {}
    await sleep(300);
  }
  throw new Error("bridge.json 未出现");
}
async function snapshot(port: number, token: string): Promise<{ sessions: Array<{ session_id: string; status: string; updated_at: number; cli_pid?: number; historical?: boolean }> }> {
  // boot 忙期（Leader 首建拉真 CLI/org 初始化）会阻塞 SNAPSHOT 构建——8s 单发 flaky
  //（同代码两跑一绿一超时实证），三连重试容忍
  for (let i = 0; i < 3; i++) {
    try { return await snapshotOnce(port, token); } catch (e) { if (i === 2) throw e; await sleep(1500); }
  }
  throw new Error("unreachable");
}
async function snapshotOnce(port: number, token: string): Promise<{ sessions: Array<{ session_id: string; status: string; updated_at: number; cli_pid?: number; historical?: boolean }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("snapshot 超时")); }, 8000);
    ws.on("open", () => process.stdout.write("  [ws] open\n"));
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { type: string; payload: { sessions: Array<{ session_id: string; status: string; updated_at: number; cli_pid?: number; historical?: boolean }> } };
        if (m.type === "SNAPSHOT") { clearTimeout(to); ws.close(); resolve(m.payload); }
      } catch {}
    });
    ws.on("error", (e) => { clearTimeout(to); reject(e); });
  });
}
async function hook(port: number, token: string, ev: Record<string, unknown>): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/bridge/hook`, {
    method: "POST", headers: { "content-type": "application/json", "x-bridge-token": token }, body: JSON.stringify(ev),
  });
  return r.status;
}
// #276：sid 十六进制化（adoptOrphans 的 sid 校验 /^[0-9a-f-]{8,64}$/）+ 转录落
// projects 沙盒根（重启后孤儿扫描补挂 transcriptPaths 的发现位——旧 wd/t.jsonl
// 位置重启后无人扫到，tail 兜底不复活，件三无触发面）
const ALIVE_SID = "a11e0001-0000-4000-8000-000000000001";
const DEAD_SID = "dead0001-0000-4000-8000-000000000001";
const transcript = join(SB, "projects", "sbx", `${ALIVE_SID}.jsonl`);
mkdirSync(join(SB, "projects", "sbx"), { recursive: true });
writeFileSync(transcript, "");

console.log("== Phase 1：boot 接管（活会话建档）==");
resetSandboxFiles();
let relay = startRelay();
let cfg1 = await waitBridgeJson();
const tr1 = transcript;
{
  const st = await hook(cfg1.port, cfg1.bridgeToken, {
    event: "UserPromptSubmit", session_id: ALIVE_SID, cwd: join(SB, "wd"), prompt: "复现实证回合",
    permission_mode: "default", transcript_path: tr1, cli_pid: livePid,
  });
  ok(st === 200, `P1① UserPromptSubmit hook 200（实 ${st}）`);
  await sleep(800);
  const snap = await snapshot(cfg1.port, cfg1.token);
  const card = snap.sessions.find((s) => s.session_id === `ext-${ALIVE_SID}`);
  ok(!!card && card.status === "WORKING", `P1② 活会话建档 WORKING（实 ${card?.status ?? "无卡"}）`);
  if (card?.cli_pid && card.cli_pid !== livePid) {
    console.log(`  [diag] 异 pid=${card.cli_pid}：`, spawnSync("/bin/ps", ["-p", String(card.cli_pid), "-o", "pid=,ppid=,comm="]).stdout.toString().trim() || "已死", `｜ livePid=${livePid}:`, spawnSync("/bin/ps", ["-p", String(livePid), "-o", "comm="]).stdout.toString().trim(), `｜ deadPid=${deadPid}｜ relay=${relay.pid}`);
    const j = readFileSync(join(SB, "data", "events.ndjson"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((d) => String(d.session_id).includes("alive-1"));
    for (const d of j) console.log("  [journal]", d.type, "pid=" + (d.payload?.cli_pid ?? "-"), "status=" + (d.payload?.status ?? "-"));
  }
  ok(card?.cli_pid === livePid, `P1③ cli_pid 在册（实 ${card?.cli_pid}，期望 ${livePid}）`);
  const t1 = card?.updated_at ?? 0;
  ok(t1 > 0, "P1④ updated_at 有值");
  // 死 pid 会话（不应被误接）——cwd 用独立目录（wd-dead：与活卡同 cwd 会让 cwd 兜底
  // 把活进程错配给死卡，那是「双向唯一」纪律的卡侧歧义域，另列 twin 断言）；
  // 转录也落 projects 根（与活卡同构，重启后同样被扫到）
  const deadTr = join(SB, "projects", "sbx", `${DEAD_SID}.jsonl`);
  writeFileSync(deadTr, "");
  await hook(cfg1.port, cfg1.bridgeToken, {
    event: "UserPromptSubmit", session_id: DEAD_SID, cwd: join(SB, "wd-dead"), prompt: "死进程会话",
    permission_mode: "default", transcript_path: deadTr, cli_pid: deadPid,
  });
  // twin 组（#276 卡侧歧义域）：wd2 独立目录 + 第二个活 claude 进程 + 两张无 pid 卡
  // ——双向唯一纪律下该 cwd 整组不配（两张待配卡无法判定谁是真身，宁可不猜）
  const TWIN_A = "7a110001-0000-4000-8000-000000000001";
  const TWIN_B = "7a110002-0000-4000-8000-000000000002";
  const live2 = spawn("/bin/sh", ["-c", `exec -a claude /bin/sleep 600`], { stdio: "ignore", cwd: join(SB, "wd2") }); live2.unref();
  for (const t of [TWIN_A, TWIN_B]) {
    const tp = join(SB, "projects", "sbx", `${t}.jsonl`);
    writeFileSync(tp, "");
    await hook(cfg1.port, cfg1.bridgeToken, {
      event: "UserPromptSubmit", session_id: t, cwd: join(SB, "wd2"), prompt: `歧义卡 ${t}`,
      permission_mode: "default", transcript_path: tp, cli_pid: 0,
    });
  }
  (globalThis as { __live2?: number }).__live2 = live2.pid;
  await sleep(500);
}

console.log("== Phase 2：杀 relay → 重启 ==");
{
  relay.kill("SIGTERM");
  await new Promise<void>((r) => { const iv = setInterval(() => { try { process.kill(relay.pid!, 0); } catch { clearInterval(iv); r(); } }, 150); setTimeout(() => { clearInterval(iv); r(); }, 5000); });
  await sleep(800);
  resetSandboxFiles();
  relay = startRelay();
  const cfg2 = await waitBridgeJson(20000);
  cfg1 = cfg2;
  await sleep(7000); // boot 自愈链（reconcile cwd 段/orphan 补挂）+ 5s tick 首轮 tail 水合穿孔
  const snap = await snapshot(cfg2.port, cfg2.token);
  const alive1 = snap.sessions.find((s) => s.session_id === `ext-${ALIVE_SID}`);
  console.log(`  [状态] 重启后活卡: status=${alive1?.status} cli_pid=${alive1?.cli_pid} historical=${alive1?.historical} updated_at=${alive1?.updated_at}`);
  const dead1 = snap.sessions.find((s) => s.session_id === `ext-${DEAD_SID}`);
  console.log(`  [状态] 重启后死卡: status=${dead1?.status} cli_pid=${dead1?.cli_pid} historical=${dead1?.historical}`);
  const twin1 = snap.sessions.find((s) => s.session_id === "ext-7a110001-0000-4000-8000-000000000001");
  console.log(`  [状态] 重启后 twin 卡: status=${twin1?.status} cli_pid=${twin1?.cli_pid}`);
  // Phase 3 的“重启后基准 updated_at”
  const beforeAt = alive1?.updated_at ?? 0;
  console.log("== Phase 2.5：重启后无 hook 事件的自愈接管（rea 形态：CLI 活着但不发事件）==");
  // 断言前先等 tail 增量节拍：写一行转录（模拟 CLI 在写）驱动 !firstRead 路径兜底；
  // 但件三的穿孔证据是「进程活」而非转录增量——两条路在此都应已翻活
  ok(alive1?.status === "WORKING", `P2.5① 活进程卡自发翻 WORKING（实 ${alive1?.status}）——rea 空闲形态（件三水合穿孔）`);
  ok(alive1?.cli_pid === livePid, `P2.5② cwd 兜底定位在册（实 ${alive1?.cli_pid}，期望 ${livePid}）——件一`);
  ok(dead1?.status !== "WORKING" && dead1?.cli_pid !== livePid, `P2.5③ 死进程不误接（实 status=${dead1?.status} pid=${dead1?.cli_pid}，回放态保留建卡死 pid 属诚实状态，要点=不抢活进程）`);
  ok(!!twin1 && twin1.cli_pid !== livePid, `P2.5④ 同 cwd 歧义卡不抢配（实 pid=${twin1?.cli_pid}）——卡侧双向唯一`);
  await sleep(1500);
  console.log("== Phase 3：重启后再发 hook 事件（用户回到终端干活）==");
  appendFileSync(transcript, `{"ts":"${Date.now()}","text":"post-restart line"}\n`);
  const st2 = await hook(cfg2.port, cfg2.bridgeToken, {
    event: "UserPromptSubmit", session_id: ALIVE_SID, cwd: join(SB, "wd"), prompt: "重启后新回合",
    permission_mode: "default", transcript_path: tr1, cli_pid: livePid,
  });
  ok(st2 === 200, `P3① 重启后 hook 200（实 ${st2}）`);
  await sleep(800);
  const snap3 = await snapshot(cfg2.port, cfg2.token);
  const a3 = snap3.sessions.find((s) => s.session_id === `ext-${ALIVE_SID}`);
  ok(a3?.status === "WORKING", `P3② 活会话重接管翻 WORKING（实 ${a3?.status}）`);
  ok(!!a3?.cli_pid && a3.cli_pid === livePid, `P3③ cli_pid 重新在册（实 ${a3?.cli_pid}，期望 ${livePid}）——passcomb 断管案`);
  ok((a3?.updated_at ?? 0) > beforeAt, `P3④ updated_at 前进（${beforeAt} → ${a3?.updated_at}）`);
  const d3 = snap3.sessions.find((s) => s.session_id === `ext-${DEAD_SID}`);
  ok(d3?.status !== "WORKING", `P3⑤ 死进程不误接（实 ${d3?.status}）`);
}

console.log(`\n复现结果：${pass} ok / ${fail} FAIL`);
try { relay.kill("SIGKILL"); live.kill(); } catch {}
try { const l2 = (globalThis as { __live2?: number }).__live2; if (l2) process.kill(l2, "SIGKILL"); } catch {}
process.exit(fail > 0 ? 1 : 0);
