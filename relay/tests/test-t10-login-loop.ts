// T10 扫码登录闭环全链断言（#106 残余断点排查）：创建被拦→登录 pane→URL→扫码 ready
// →恢复通知→重试创建→新会话发消息——闭环每一步的 ACK/帧面断言，重点：
//   a) 全链任何报错出口不得为「会话不存在」；
//   b) 会话 id 全链全长一致（ACK.session_id ↔ SESSION_CREATED 帧 ↔ 消息命令——
//      「id 残缺」症状的机器面：任何截断/键位错配在此显形）；
//   c) COMMAND_ENGINE_LOGIN status/verify 受理形状（离线端重连兜底链）。
// Mock 配方沿用 test-engine-login.ts（假 tmux capture 序列 + 探针状态文件）与
// test-engine-auth-watch.ts（SessionManager 集成 harness）。⚠ 值 import 全动态化
//（engine-login/auth-watch 模块体读 env——静态 import 提升坑，批 B/C 实测教训）。
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLike } from "../src/agent-adapter.js";
type CommandT = import("../src/types.js").Command;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c: unknown, name: string, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " | " + detail : ""}`); }
};
const section = (n: string) => console.log(n);
const waitFor = async (f: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (f()) return true; await sleep(60); }
  return f();
};

const T = mkdtempSync(join(tmpdir(), "ccr-t10loop-"));
// 时间压缩（engine-login ×50 / auth-watch 100ms 基）
process.env.CCR_LOGIN_TIMESCALE = "50";
process.env.CCR_LOGIN_FLOW_TIMEOUT_MS = "40000";
process.env.CCR_AUTH_WATCH_BASE_MS = "100";
process.env.CCR_AUTH_WATCH_MAX_MS = "400";

// ---------- 假 tmux（capture 序列驱动） ----------
const STATE = join(T, "tmux-state");
const CAPTURE_SEQ = join(T, "capture-seq.txt");
const KEYS_LOG = join(STATE, "keys.log");
const tmuxFake = join(T, "tmux-fake");
writeFileSync(tmuxFake, [
  "#!/bin/sh",
  `S="${STATE}"`,
  `SEQ="${CAPTURE_SEQ}"`,
  'mkdir -p "$S"',
  'case "$1" in',
  '  new-session) echo "$@" >> "$S/new.log"; exit 0 ;;',
  '  kill-session) echo "$@" >> "$S/kill.log"; exit 0 ;;',
  '  send-keys) printf "%s\\n" "$*" >> "$S/keys.log"; exit 0 ;;',
  '  capture-pane)',
  '    n=0; [ -f "$S/cap-n" ] && n=$(cat "$S/cap-n")',
  '    n=$((n+1)); echo "$n" > "$S/cap-n"',
  '    total=$(wc -l < "$SEQ" 2>/dev/null || echo 0)',
  '    if [ "$n" -le "$total" ]; then sed -n "${n}p" "$SEQ" | sed "s/\\\\t/\\n/g"; fi',
  '    exit 0 ;;',
  'esac',
  'exit 0',
].join("\n"));
chmodSync(tmuxFake, 0o755);
process.env.CCR_TMUX_CMD = tmuxFake;

// ---------- 假探针（codebuddy）：输出=状态文件 ----------
const CB_STATE = join(T, "cb-state");
const cbProbe = join(T, "cb-probe");
writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
writeFileSync(cbProbe, `#!/bin/sh\ncat "${CB_STATE}"\n`);
chmodSync(cbProbe, 0o755);
process.env.CCR_CODEBUDDY_PATH = cbProbe;
process.env.CODEX_HOME = join(T, "empty-codex-home");

// capture 序列：①trust 对话框 ②trust 等待 ③登录 URL 面板 ④同 URL（幂等）
writeFileSync(CAPTURE_SEQ, [
  "Do you trust the files in this folder?\t/Users/xdd/dev/cc-deck\t1. Trust folder only (cc-deck)\t4. No, exit (escape)",
  "Do you trust the files in this folder?\tstill waiting",
  "Browser didn't open? Use the url below to sign in:\thttps://copilot.tencent.com/login?platform=CLI&state=t10loop\tWaiting for auth... (Press ESC to cancel)",
  "Browser didn't open? Use the url below to sign in:\thttps://copilot.tencent.com/login?platform=CLI&state=t10loop\tWaiting for auth... (Press ESC to cancel)",
].join("\n") + "\n");

// 数据面隔离 + 标题生成关
process.env.CCR_DATA_DIR = join(T, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

try {
  const { EventBus } = await import("../src/event-bus.js");
  const { loadConfig } = await import("../src/config.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { engineLoginStatus, resetEngineLoginFlows } = await import("../src/engine-login.js");

  const bus = new EventBus();
  type Frame = { type: string; session_id?: string; payload?: Record<string, unknown> };
  const frames: Frame[] = [];
  bus.subscribe((env: unknown) => {
    const e = env as Frame;
    frames.push({ type: e.type, session_id: e.session_id, payload: e.payload });
  });

  const mgr = new SessionManager(bus, loadConfig());
  mgr.setAgentFactory((_cwd: string, _model: string, _cb: unknown, initialPrompt: string | undefined, opts: { engine?: string } | undefined) => {
    // 重试创建走的 claude 兜底路径才进 factory；codebuddy registry 引擎直接 spawn 假探针
    void initialPrompt; void opts;
    const agent: AgentLike = {
      id: `fake-t10-${Date.now()}`, startedAt: Date.now(), ended: false,
      sendMessage() {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => {}, setPermissionMode: async () => {},
    };
    return agent;
  });

  const mkCmd = (type: string, payload: Record<string, unknown>): CommandT =>
    ({ command_id: `t10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, payload, ts: Date.now() }) as unknown as CommandT;

  // ========== L1 创建被拦（fail-fast + 自动拉登录 + intent 登记） ==========
  section("L1 创建被拦（needs_auth ACK 形状——无预留 id=无幽灵会话）");
  const ack1 = mgr.handleCommand(mkCmd("COMMAND_CREATE", {
    cwd: T, prompt: "T10 闭环测试任务", engine: "codebuddy",
  }), "web-t10") as unknown as Record<string, unknown>;
  assert(ack1.ok === false && ack1.needs_auth === true,
    "L1a 未登录创建被拒：ok:false + needs_auth:true", JSON.stringify(ack1).slice(0, 140));
  assert(!("session_id" in ack1) || ack1.session_id === undefined,
    "L1b 拦截 ACK 不携带 session_id（不产幽灵 id——端上无从对不存在会话发命令）");
  assert(typeof ack1.auth_hint === "string" && (ack1.auth_hint as string).length > 0,
    "L1c auth_hint 非空（可操作指引）");

  // ========== L2 登录 pane 自动起流（拦截同时 startEngineLogin） ==========
  section("L2 拦截即拉登录 pane（URL 喂到嘴里）");
  const urlArrived = await waitFor(() =>
    frames.some((f) => f.type === "AUTH_REQUIRED"
      && typeof (f.payload as { url?: string } | undefined)?.url === "string"
      && String((f.payload as { url?: string }).url).startsWith("https://copilot.tencent.com/login?")), 4_000);
  assert(urlArrived, "L2a AUTH_REQUIRED 帧带授权 URL（trust 步自动发送后面板打印）");
  const urlFrames = frames.filter((f) => f.type === "AUTH_REQUIRED" && typeof (f.payload as { url?: string })?.url === "string");
  const statusMid = engineLoginStatus("codebuddy");
  assert(statusMid !== null && (statusMid.state === "pending" || statusMid.state === "starting"),
    "L2b 流程存活（pending=等扫码）", JSON.stringify(statusMid)?.slice(0, 80));

  // ========== L3 ENGINE_LOGIN status/verify 受理（离线端重连兜底链） ==========
  section("L3 COMMAND_ENGINE_LOGIN status/verify（重连兜底）");
  const ackS = mgr.handleCommand(mkCmd("COMMAND_ENGINE_LOGIN", { engine: "codebuddy", action: "status" }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackS.ok === true && ackS.data && typeof ackS.data === "object",
    "L3a status ACK ok+data=流程投影（断线端兜底查询）", JSON.stringify(ackS).slice(0, 100));
  const ackV = mgr.handleCommand(mkCmd("COMMAND_ENGINE_LOGIN", { engine: "codebuddy", action: "verify" }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackV.ok === true && (ackV.data as { accepted?: boolean })?.accepted === true,
    "L3b verify ACK 受理（结果走事件异步回推）");
  const ackB = mgr.handleCommand(mkCmd("COMMAND_ENGINE_LOGIN", { engine: "not-an-engine", action: "start" }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackB.ok === false, "L3c 未知引擎拒收（错误面不走 generic unsupported）");

  // ========== L4 扫码：探针转 ready → settle → ready 帧 + pane 收 ==========
  section("L4 扫码完成（ready 收口）");
  writeFileSync(CB_STATE, "Signed in as tester@example.com (Plus)\n");
  const readyArrived = await waitFor(() =>
    frames.some((f) => f.type === "AUTH_REQUIRED" && (f.payload as { state?: string })?.state === "ready"), 4_000);
  assert(readyArrived, "L4a 探针 ready → AUTH_REQUIRED ready 帧广播（卡片转绿数据源）");
  let killed = false;
  try { killed = readFileSync(join(STATE, "kill.log"), "utf8").includes("ccr-login-codebuddy"); } catch { killed = false; }
  assert(killed, "L4b 登录 pane 已收（kill-session 落账）");
  // ready 帧 URL 面收口（不再推 URL——扫码后不该还有授权链接）
  const readyIdx = frames.findIndex((f) => f.type === "AUTH_REQUIRED" && (f.payload as { state?: string })?.state === "ready");
  const urlAfterReady = frames.slice(readyIdx + 1).filter((f) => typeof (f.payload as { url?: string })?.url === "string");
  assert(urlAfterReady.length === 0, "L4c ready 后不再推授权 URL（流程收口干净）");

  // ========== L5 恢复通知（创建回显——无 ERROR 会话则只通知） ==========
  section("L5 登录后恢复面（通知回显，无幽灵恢复）");
  const noteArrived = await waitFor(() =>
    (mgr.notificationsList() as { title: string; body: string }[]).some((n) => n.title.includes("已登录")), 2_500);
  assert(noteArrived, "L5a 恢复通知到达（「已登录」面）");
  const notes5 = (mgr.notificationsList() as { title: string; body: string }[]).map((n) => `${n.title} ${n.body}`).join("\n");
  assert(notes5.includes("可以创建了") && notes5.includes("T10 闭环测试任务"),
    "L5b 创建拦截通知带 intent 快照回显（「可以创建了」+原任务摘要）", notes5.slice(0, 120));

  // ========== L6 重试创建：id 全长 + 帧一致（「id 残缺」专项） ==========
  section("L6 重试创建（id 全链全长一致——残缺专项断言）");
  await sleep(300); // 探针缓存 settle 已清（settle 链 resetEngineAuthCache）
  const ack2 = mgr.handleCommand(mkCmd("COMMAND_CREATE", {
    cwd: T, prompt: "T10 闭环测试任务（登录后重试）", engine: "codebuddy",
  }), "web-t10") as unknown as Record<string, unknown>;
  assert(ack2.ok === true, "L6a 登录后重试创建成功", JSON.stringify(ack2).slice(0, 160));
  const sid = ack2.session_id as string | undefined;
  assert(typeof sid === "string" && UUID_RE.test(sid),
    "L6b session_id 全长标准 UUID（36 位无截断）", String(sid));
  const createdFrame = await waitFor(() => frames.some((f) => f.type === "SESSION_CREATED" && f.session_id === sid), 2_000);
  assert(createdFrame, "L6c SESSION_CREATED 帧广播且 id 与 ACK 全等（无键位错配/变形）");
  const frameForSid = frames.find((f) => f.type === "SESSION_CREATED" && f.session_id === sid);
  assert((frameForSid?.payload as { engine?: string })?.engine === "codebuddy",
    "L6d 帧带 engine=codebuddy（端上引擎徽标数据源）");

  // ========== L7 对新会话发消息：受理面无「会话不存在」 ==========
  section("L7 新会话首条消息（误报专项——error 不得为会话不存在）");
  const ackM = mgr.handleCommand(mkCmd("COMMAND_MESSAGE", {
    session_id: sid, text: "登录闭环后的第一条消息",
  }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackM.ok === true || (typeof ackM.error === "string" && !ackM.error.includes("会话不存在")),
    "L7a 消息命令受理（或业务性拒绝——但绝非「会话不存在」）", JSON.stringify(ackM).slice(0, 140));
  // 对照：对随机完整 UUID 发消息——必须明确「会话不存在」而非静默（报错面本身要准）
  const ghost = "00000000-1111-4222-8333-444444444444";
  const ackG = mgr.handleCommand(mkCmd("COMMAND_MESSAGE", {
    session_id: ghost, text: "幽灵会话对照",
  }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackG.ok === false && typeof ackG.error === "string" && ackG.error.includes(ghost),
    "L7b 幽灵 id 报错带完整 36 位 id（报错面 id 全长——残缺显示的另一端防线）", JSON.stringify(ackG).slice(0, 140));
  // T10 残余收口回归锁：COMMAND_MODEL 裸「会话不存在」→ 带 id（原 2769 漏网面）
  const ackGM = mgr.handleCommand(mkCmd("COMMAND_MODEL", {
    session_id: ghost, model: "glm-5.3",
  }), "web-t10") as unknown as Record<string, unknown>;
  assert(ackGM.ok === false && typeof ackGM.error === "string" && ackGM.error.includes(ghost),
    "L7c COMMAND_MODEL 幽灵 id 报错带完整 id（T10 残余收口——原裸报不带 id 回归锁）", JSON.stringify(ackGM).slice(0, 140));

  // ========== L8 全链报错面清点 ==========
  section("L8 全链帧/ACK「会话不存在」清点");
  const frameMiss = frames.filter((f) => JSON.stringify(f).includes("会话不存在"));
  assert(frameMiss.length === 0, `L8a 全链事件帧零「会话不存在」（got=${frameMiss.length}）`);

  // 收尾
  resetEngineLoginFlows();
  console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
}
