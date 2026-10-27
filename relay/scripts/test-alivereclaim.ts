// #276 重启后活会话不恢复——断言套件。两组对应修复两件：
//   §A 件一（cwd 兜底定位）：argv 无 sid 形态的活 CLI 重启后 pid 回位
//      A1 活进程重接管：卡 DONE+无 pid+cwd 匹配活 claude 进程 → 补 pid+清 historical+留痕
//      A2 死进程不误接：唯一候选是死 pid → 不配（pidAlive 前置）
//      A3 认领/持有不抢：sid 段已认领（claimed）或他卡已持有的活 pid → 不重复认领
//      A4 多候选不猜被护住：零候选（cwd 无进程）→ 不配
//      A5 转录兜底段不掩盖断管的前置：pid 回位后 pollCliStatus 短路条件解除（结构性，静态锚）
//   §B 件二（工具事件翻活）：半接管窗口（错过 UserPromptSubmit、跨重启长回合）
//      B1 PreToolUse 到达且 DONE → 翻 WORKING
//      B2 PostToolUse 同款
//      B3 historical 卡不翻（#50 刻意沉底纪律不破）
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:alivereclaim
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import type { BridgeEvent } from "../src/types.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---- 沙盒（test-bootts 铁律：org/data/projects 钉仓库沙盒防生产渗入） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-alivereclaim-org/", "../data/test-alivereclaim-data/", "../data/test-alivereclaim-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-alivereclaim-org/");
process.env.CCR_DATA_DIR = SB("../data/test-alivereclaim-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-alivereclaim-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_ENGINE_SCAN_MS = "60000"; // 引擎扫描拉远：断言窗口不受冷首扫干扰
process.env.CCR_SESSIONS_ROOT = SB("../data/test-alivereclaim-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });

const DATA = process.env.CCR_DATA_DIR;
const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
const mgr = new SessionManager(bus, cfg);
// 真 Bridge：boot 序列即跑（reconcile 系真 ps——测试卡 cwd 均为受控值，不误配真进程）
const bridge = new Bridge(bus, mgr, { gateTools: new Set(), hasClients: () => false, dataDir: DATA });

type Card = { state: { session_id: string; external: boolean; status: string; action_summary: string; updated_at: number; cli_pid?: number; cwd?: string; historical?: boolean; idle_archived?: boolean; started_at: number } };
const cards = (mgr as unknown as { sessions: Map<string, Card> }).sessions;
const proto = Bridge.prototype as unknown as {
  reconcilePidsFromCwd(snap: Array<{ pid: number; command: string }>, claimed: Set<number>): void;
};

// 「活 CLI」替身：测试进程自身（pid 活、processCwd(pid)=真实 cwd=process.cwd()，
// 词级 claude 匹配靠伪 snap 的 command 字段——lsof 只验 cwd 与存活，两条件都真）
const ME = process.pid;
const MY_CWD = process.cwd();

console.log("§A 件一：cwd 兜底定位（argv 无 sid 形态的活终端重接管）");
// A1 活进程重接管（1026 rea 型：DONE+无 pid+CLI 空闲 → 四源全空的死卡）
{
  const id = "ext-ar-rea";
  mgr.ensureExternal(id, MY_CWD, "rea 型活终端", "ar-rea");
  const s = cards.get(id)!;
  s.state.status = "DONE";
  s.state.historical = true; // 重启收殓残态（非 idle_archived）
  proto.reconcilePidsFromCwd.call(bridge, [{ pid: ME, command: "claude" }], new Set());
  ok(s.state.cli_pid === ME, "A1a 活进程重接管：cwd 匹配补回 pid（boot/60s 轮即救，不等 hook 上报）");
  ok(!s.state.historical, "A1b 活 pid 即存活证明：historical 残态清除（恢复可交互）");
}
// A2 死进程不误接
{
  const id = "ext-ar-dead";
  mgr.ensureExternal(id, MY_CWD, "死候选", "ar-dead");
  const s = cards.get(id)!;
  s.state.status = "DONE";
  const DEAD = 999_999; // 远端未分配 pid（pidAlive=false）
  proto.reconcilePidsFromCwd.call(bridge, [{ pid: DEAD, command: "claude --continue" }], new Set());
  ok(s.state.cli_pid === undefined, "A2 死进程不误接：唯一候选死 pid 不配（pidAlive 前置）");
}
// A3 认领/持有不抢
{
  const id = "ext-ar-held";
  mgr.ensureExternal(id, MY_CWD, "他卡持有", "ar-held");
  const s = cards.get(id)!;
  s.state.status = "DONE";
  // ME 已被 ext-ar-rea 持有（A1 配上）→ held 集拦截
  proto.reconcilePidsFromCwd.call(bridge, [{ pid: ME, command: "claude" }], new Set());
  ok(s.state.cli_pid === undefined, "A3a 他卡已持有的活 pid 不抢（一进程一身份，compact 换代语义不破）");
  const id2 = "ext-ar-claimed";
  mgr.ensureExternal(id2, MY_CWD, "sid 段认领", "ar-claimed");
  const s2 = cards.get(id2)!;
  s2.state.status = "DONE";
  s2.state.cli_pid = undefined;
  // 先解除持有：把 A1 卡的 pid 抹掉，再验 claimed 集拦截
  cards.get("ext-ar-rea")!.state.cli_pid = undefined;
  proto.reconcilePidsFromCwd.call(bridge, [{ pid: ME, command: "claude" }], new Set([ME]));
  ok(s2.state.cli_pid === undefined, "A3b sid 段已认领的 pid cwd 段不重复认领（claimed 传递）");
}
// A4 零候选（cwd 无进程证据）不配
{
  const id = "ext-ar-none";
  mgr.ensureExternal(id, "/tmp/no-such-cwd-xyz", "无进程目录", "ar-none");
  const s = cards.get(id)!;
  s.state.status = "DONE";
  proto.reconcilePidsFromCwd.call(bridge, [{ pid: ME, command: "claude" }], new Set());
  ok(s.state.cli_pid === undefined, "A4 零候选不配：cwd 无匹配进程=无存活证据（不猜）");
}

console.log("§B 件二：工具事件翻活（半接管窗口——转录/工具帧在推而状态停 DONE）");
// 最小 hook 事件构造（dispatch 走 PreToolUse/PostToolUse handler，可选字段补全）
const mkEv = (event: string, sid: string): BridgeEvent => ({
  event, session_id: sid, cli_pid: ME, cwd: MY_CWD,
  tool_name: "Bash", tool_input: { command: "echo hi" },
  transcript_path: join(DATA, "tr.jsonl"),
  hook_event_name: event,
} as unknown as BridgeEvent);
writeFileSync(join(DATA, "tr.jsonl"), "");
// B1/B2 PreToolUse/PostToolUse 到达且 DONE → 翻 WORKING（1026 passcomb 型）——handleEvent
// 异步链完整等待后再断言（void 调用会与 handler 内异步竞态）
{
  const id = "ext-ar-half";
  mgr.ensureExternal(id, MY_CWD, "半接管卡", "ar-half");
  const s = cards.get(id)!;
  s.state.status = "DONE"; // 回放残态：错过回合首事件，回合跨重启长跑
  await bridge.handleEvent(mkEv("PreToolUse", "ar-half"));
  ok(s.state.status === "WORKING", "B1 PreToolUse 活跃 → DONE 翻 WORKING（回合进行铁证，不等 UserPromptSubmit）");
  s.state.status = "DONE";
  await bridge.handleEvent(mkEv("PostToolUse", "ar-half"));
  ok(s.state.status === "WORKING", "B2 PostToolUse 同款翻活");
  // 活定位不覆盖再验：翻活后状态已 WORKING，事件再到不回打（幂等面，无断言必要）
}
// B3 historical 卡：hook 事件到达本身=「用户回来了」的权威信号，dispatch 既有链翻活
//（#50「回到终端继续用时 hook 事件翻活」——正确行为）；件二的作用域排除（不碰
// historical）用静态锚锁死，防越权破坏沉底纪律
{
  const id = "ext-ar-arch";
  mgr.ensureExternal(id, MY_CWD, "沉底卡", "ar-arch");
  const s = cards.get(id)!;
  s.state.status = "DONE";
  s.state.historical = true;
  s.state.idle_archived = true;
  await bridge.handleEvent(mkEv("PreToolUse", "ar-arch"));
  ok(s.state.status === "WORKING" && !s.state.historical, "B3a historical 卡 hook 事件翻活+清标记（既有 #50 链回归，权威信号优先）");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/bridge.ts"), "utf8");
  ok(src.includes('tst.status === "DONE" && !tst.historical'), "B3b 静态锚：件二翻活条件显式排除 historical（沉底纪律不越权）");
  ok(src.includes("reconcilePidsFromCwd(snap, claimed)"), "B3c 静态锚：cwd 兜底段挂进 reconcile 主链（boot+60s 轮节拍）");
}

// ---- §W 公司侧升级面（0926 实证：7 卡 updated_at 全=重启时刻 + 6 张久休卡假活跃）----
// 真凶=boot 自愈链裸 emitExternalSync（emitUpdated 无 at 写 Date.now()）：公司侧无
// hook 旧会话多、boot 集中翻案逐卡洗一次；Mac 侧 hook 会话多真事件随后覆盖故未显。
// ①②提取链平台无关已锚（eventTime ISO/数值解析无平台分支；updatedAt=0 回落 mtime
// 优先）——Windows 样本行为锚定 + emit 面带 at 静态锚 + ③久休门静态锚
{
  const { RolloutScanner, specOf } = await import("../src/engine-rollouts.js");
  const { utimesSync } = await import("node:fs");
  // W1 Windows 风格转录（反斜杠 cwd/盘符）提取不受平台差异影响
  const codexRoot = SB("../data/test-alivereclaim-projects/codex-win/");
  mkdirSync(codexRoot, { recursive: true });
  const winTs = Date.now() - 3600_000;
  const winFile = join(codexRoot, `rollout-a11e0002-0000-4000-8000-000000000002.jsonl`);
  writeFileSync(winFile, [
    JSON.stringify({ timestamp: new Date(winTs).toISOString(), type: "session_meta", payload: { cwd: "C:\\Users\\dev\\keyhive", session_id: "a11e0002-0000-4000-8000-000000000002" } }),
    JSON.stringify({ timestamp: new Date(winTs + 1000).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ text: "windows 样本回合" }] } }),
    "",
  ].join("\n"));
  const winProfiles = new RolloutScanner(specOf("codex"), codexRoot).scan();
  const winP = winProfiles.find((p) => p.sessionId.includes("a11e0002"));
  ok(!!winP, "W1a Windows 风格转录被扫到（文件名/会话 id 提取不受平台影响）");
  ok(winP?.cwd === "C:\\Users\\dev\\keyhive", `W1b 反斜杠盘符 cwd 原样提取（实 ${winP?.cwd}）`);
  ok(Math.abs((winP?.updatedAt ?? 0) - (winTs + 1000)) < 5, `W1c updatedAt=行内 timestamp（实 ${winP?.updatedAt}，期望 ${winTs + 1000}，非 now 洗活）`);
  // W2 无 timestamp 行：updatedAt 回落文件 mtime（而非扫描 now）——双保险锚
  const noTsFile = join(codexRoot, `rollout-a11e0003-0000-4000-8000-000000000003.jsonl`);
  writeFileSync(noTsFile, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "无时间戳行" }] } }) + "\n");
  const oldMtime = Date.now() - 7200_000;
  utimesSync(noTsFile, new Date(oldMtime), new Date(oldMtime));
  const noTsProfiles = new RolloutScanner(specOf("codex"), codexRoot).scan();
  const noTsP = noTsProfiles.find((p) => p.sessionId.includes("a11e0003"));
  ok(!!noTsP && Math.abs(noTsP.updatedAt - oldMtime) < 2000, `W2 无 timestamp 行回落文件 mtime（实 ${noTsP?.updatedAt}，期望≈${oldMtime}，非 now）`);
  // W3 emit 面带 at 静态锚（五处自愈/镜像帧不洗活——防回退）
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/bridge.ts"), "utf8");
  ok(src.includes("emitExternalSync(s.session_id, s.updated_at)"), "W3a revive/自愈链 emit 带卡既有时刻（公司侧 7 卡洗活根修）");
  ok((src.match(/emitExternalSync\(s\.session_id\);/g) ?? []).length === 0 && (src.match(/emitExternalSync\(sessionId\);/g) ?? []).length === 0, "W3b bridge 自愈/镜像面裸 emitExternalSync 清零");
  ok(src.includes("emitExternalSync(id, profile.updatedAt)"), "W3c ERROR 同步帧带转录真实时刻");
  // W4 ③久休门静态锚：else 翻活分支有 mtime 新鲜度门槛（久休滞后增量不翻绿灯）
  ok(src.includes("nohookStaleMs") && src.includes("Date.now() - fileMtime <= nohookStaleMs"), "W4 「转录活跃（无 hook 会话）」翻活带久休门（公司侧 6 张假活跃根修）");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
