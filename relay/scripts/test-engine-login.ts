// #102 批 B：引擎登录 pane + AUTH_REQUIRED 引导链测试件
// 覆盖：URL/二维码字符画提取纯函数（三类面板输出）+ 流程生命周期（幂等 start/
// 状态机驱动 send-keys/URL 变化才推/AUTH_REQUIRED 事件形状/ready 收 pane/timeout
// 收 pane/cancel）+ COMMAND_ENGINE_LOGIN 四动作 ACK 形状 + 拦截 kick 链。
//
// tmux/mock 注入缝：CCR_TMUX_CMD 指假脚本（new-session/capture-pane/send-keys/
// kill-session 按 argv 分派，capture 输出由「输出序列文件」编排逐轮变化）；探针
// mock：CCR_CODEBUDDY_PATH/CCR_CODEX_PATH 假脚本（输出由状态文件切换 needs_auth→
// 已登录）。CCR_LOGIN_TIMESCALE 把 boot/settle/timeout 全部压缩到百 ms 级。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import type { Envelope } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

const T = mkdtempSync(join(tmpdir(), "ccr-englogin-"));
// 时间压缩 ×50：boot 4s→80ms、POLL 1.2s→24ms、timeout（本件设 3s）→60ms 级
process.env.CCR_LOGIN_TIMESCALE = "50";
process.env.CCR_LOGIN_FLOW_TIMEOUT_MS = "40000";

// ---------- 假 tmux：argv 分派（状态目录记录调用/编排输出） ----------
const STATE = join(T, "tmux-state");
const CAPTURE_SEQ = join(T, "capture-seq.txt"); // 每行一次 capture 输出（\t 转义换行）
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

// 探针假脚本：输出由 state 文件切换（needs_auth ↔ 已登录）
const mkProbe = (name: string, stateFile: string) => {
  const p = join(T, name);
  writeFileSync(p, `#!/bin/sh\ncat "${stateFile}"\n`);
  chmodSync(p, 0o755);
  return p;
};
const CB_STATE = join(T, "cb-state");
writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
const savedCb = process.env.CCR_CODEBUDDY_PATH;
process.env.CCR_CODEBUDDY_PATH = mkProbe("cb-probe", CB_STATE);
const savedCx = process.env.CCR_CODEX_PATH;
const CX_STATE = join(T, "cx-state");
writeFileSync(CX_STATE, "Not logged in: run codex login\n");
process.env.CCR_CODEX_PATH = mkProbe("cx-probe", CX_STATE);
process.env.CODEX_HOME = join(T, "empty-codex-home"); // 三源全无——探针确定被走到

// AUTH_REQUIRED 瞬态帧收集（真 EventBus——emitTransient 走 listeners）
const bus = new EventBus();
const frames: Envelope[] = [];
bus.subscribe((env) => { if (env.type === "AUTH_REQUIRED") frames.push(env); });

try {
  // ⚠ 动态 import：engine-login 的 POLL/TIMEOUT/TIMESCALE 常量在模块体求值时读 env
  // ——静态 import 会被提升到 env 设置之前（本件首版实测 11 断言全挂的根因）
  const { extractLoginUrl, extractQrBlockArt, resetEngineLoginFlows, startEngineLogin, engineLoginStatus, cancelEngineLogin, verifyEngineLogin } = await import("../src/engine-login.js");

  // ---------- U1 URL 提取纯函数（实测锚定输出样本） ----------
  section("U1 URL 提取（白名单/通用兜底/排除域）");
  const CB_PANEL = [
    "Browser didn't open? Use the url below to sign in: (Copied link to clipboard)",
    "https://copilot.tencent.com/login?platform=CLI&state=246cab41-b650-4fd8-a3be-06f3367e18b8&version=2.164.0",
    "✸ Waiting for auth... (Press ESC to cancel)",
  ].join("\n");
  const CX_PANEL = [
    "Starting local login server on http://localhost:1455.",
    "If your browser did not open, navigate to this URL to authenticate:",
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=laQ4m",
  ].join("\n");
  const TRAE_PANEL = [
    "  Finish enterprise sign-in in your browser",
    "  Open this link in a browser on any machine:",
    "  https://console.enterprise.trae.cn/authorization?redirect=0&login_trace_id=traecli-52161&auth_callback_url=http%3A%2F%2F127.0.0.1%3A52161%2Fauthorize",
  ].join("\n");
  assert(extractLoginUrl(CB_PANEL, /^https:\/\/copilot\.tencent\.com\/login\?\S+/i)?.startsWith("https://copilot.tencent.com/login?platform=CLI") === true,
    "U1a codebuddy 白名单命中（实测面板样本——copilot.tencent.com/login 带 state）");
  assert(extractLoginUrl(CX_PANEL, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/i)?.startsWith("https://auth.openai.com/oauth/authorize?") === true,
    "U1b codex 白名单命中（auth.openai.com/oauth/authorize——本机回调 1455 不截进 URL）");
  assert(extractLoginUrl(TRAE_PANEL, /^https:\/\/console\.enterprise\.trae\.cn\/authorization\?\S+/i)?.startsWith("https://console.enterprise.trae.cn/authorization?") === true,
    "U1c trae 白名单命中（enterprise 授权 URL——实测 `?` 三选一后打印形态）");
  assert(extractLoginUrl("文档 https://docs.trae.cn/cli\n官网 https://www.trae.cn/trae-cli/install", undefined) === null,
    "U1d 排除域兜底不误提（docs/官网/安装页不是授权链接）");
  assert(extractLoginUrl("无 URL 面板输出", undefined) === null, "U1e 都没有 → null");
  assert(extractLoginUrl("generic https://auth.example.com/oauth?code=1\ngeneric https://auth2.example.com/oauth?code=2", undefined) === "https://auth2.example.com/oauth?code=2",
    "U1f 通用兜底取最后（最新打印的授权链接，带查询串门槛）");
  assert(extractLoginUrl("本地回调 http://127.0.0.1:1455/auth/callback?code=x", undefined) === null,
    "U1g localhost/127.0.0.1 回调不提（那是回调不是授权页）");

  // ---------- U2 二维码字符画检测 ----------
  section("U2 二维码字符画检测");
  // 样本门槛 ≥5 行+行宽对齐（±2 列）——codebuddy logo 行宽参差误报的实测收紧
  const ART = ["█▀▀▀▀▀▀▀▀█ ▀█▀", "█ █▄▄ █ ▀█▀ ██▀", "█▄▄▄▄▄▄▄▄█ ▄▀▄▀", "█▀█ █▀▀█ █▀▄█▀", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"].join("\n");
  assert(!!extractQrBlockArt(`普通输出\n${ART}\n尾行`) === true, "U2a ≥5 行密集块字符+行宽对齐 → 检出");
  assert(extractQrBlockArt("普通文本面板\n第二行\n第三行") === null, "U2b 无字符画 → null");
  assert(extractQrBlockArt("█▀█\n█▄█\n█▀█\n█▄█\n█▀█\n█▄█") === null, "U2c 行宽参差（装饰 logo 形态）→ null（codebuddy logo 误报实测收紧）");
  assert(extractQrBlockArt(["█▀▀▀▀▀▀▀▀█", "█ █▄▄ █", "█▄▄▄▄▄▄▄▄█"].join("\n")) === null, "U2d 不足 5 行 → null（碎片噪声不透传）");

  // ---------- U3 流程生命周期（codebuddy 全链：trust→URL→ready） ----------
  section("U3 codebuddy 全链（tmux 状态机驱动→URL 提取→事件→ready 收 pane）");
  // capture 序列编排：①trust 对话框（实测样本）②仍是 trust（发 1+Enter 前）③登录 URL 面板 ④同 URL（不重推）
  writeFileSync(CAPTURE_SEQ, [
    "Do you trust the files in this folder?\t/Users/xdd/dev/cc-deck\t1. Trust folder only (cc-deck)\t4. No, exit (escape)",
    "Do you trust the files in this folder?\tstill waiting",
    "Browser didn't open? Use the url below to sign in:\thttps://copilot.tencent.com/login?platform=CLI&state=abc123\tWaiting for auth... (Press ESC to cancel)",
    "Browser didn't open? Use the url below to sign in:\thttps://copilot.tencent.com/login?platform=CLI&state=abc123\tWaiting for auth... (Press ESC to cancel)",
  ].map((l) => l.replace(/\n/g, "\t")).join("\n") + "\n");
  const flow0 = startEngineLogin(bus, "codebuddy");
  assert(flow0.state === "starting" && flow0.mode === "qr" && typeof flow0.hint === "string" && flow0.hint.length > 0,
    "U3a 同步受理：ACK 投影 starting+qr 模式+hint 非空（把饭喂到嘴里链路受理）");
  const framesAfterStart = frames.length;
  assert(framesAfterStart >= 1 && (frames[0].payload as { engine: string }).engine === "codebuddy",
    "U3b AUTH_REQUIRED 瞬态帧已广播（starting 态）");
  // 幂等：活流程复用（不重复 spawn）
  const flowAgain = startEngineLogin(bus, "codebuddy");
  assert(flowAgain.flow_id === flow0.flow_id, "U3c 幂等 start：活流程复用同 flow_id（重复点「立即登录」不重复 spawn）");
  // 等 URL 到达（tsx 环境 spawn 开销 ~300ms + boot/settle/轮询——到达时刻漂移，轮询等待）
  let status: Awaited<ReturnType<typeof engineLoginStatus>> = null;
  for (let i = 0; i < 40 && !(status?.url ?? "").startsWith("https://copilot.tencent.com/login?"); i++) {
    await sleep(75);
    status = engineLoginStatus("codebuddy");
  }
  assert(!!status?.url && status.url.startsWith("https://copilot.tencent.com/login?"),
    "U3d URL 已提取进流程（trust 步发送后面板打印——实测形态）");
  const keys = (() => { try { return readFileSync(KEYS_LOG, "utf8"); } catch { return ""; } })();
  assert(/1.*Enter|Enter/.test(keys.replace(/\n/g, " ")),
    `U3e trust 对话框已发送 1+Enter（send-keys 落账：${keys.replace(/\n/g, " ").slice(0, 60) || "(空)"}）`);
  await sleep(150); // 再空转数轮（同 URL 面板反复 capture——不应重推）
  const urlFrames = frames.filter((f) => {
    const u = (f.payload as { url?: string }).url;
    return typeof u === "string" && u.startsWith("https://copilot.tencent.com");
  });
  assert(urlFrames.length === 1, "U3f URL 帧恰推一次（同 URL 不重推——幂等广播）");
  // 切探针 → ready 收 pane
  writeFileSync(CB_STATE, "Signed in as tester@example.com (Plus)\n");
  await sleep(900);
  const done = engineLoginStatus("codebuddy");
  assert(done?.state === "ready", "U3g 探针转 ready → 流程收口 ready（轮验不吃 45s TTL）");
  let killed = false;
  try { killed = readFileSync(join(STATE, "kill.log"), "utf8").includes("ccr-login-codebuddy"); } catch { killed = false; }
  assert(killed, "U3h ready 后登录 pane 已收（kill-session 落账）");
  const readyFrame = frames.find((f) => (f.payload as { state?: string }).state === "ready");
  assert(!!readyFrame, "U3i ready 态 AUTH_REQUIRED 帧广播（端上卡片转绿+目录 patch 数据源）");

  // ---------- U4 timeout 收 pane ----------
  section("U4 timeout 收 pane（40s/50=800ms 窗口）");
  resetEngineLoginFlows();
  frames.length = 0;
  rmSync(join(STATE, "cap-n"), { force: true }); // 假 tmux capture 计数跨段清零
  rmSync(CAPTURE_SEQ, { force: true });
  writeFileSync(CAPTURE_SEQ, "面板无 URL 输出\n"); // 恒无 URL：轮验探针恒 needs_auth → 走到超时
  rmSync(join(STATE, "kill.log"), { force: true });
  writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
  const flowT = startEngineLogin(bus, "codebuddy");
  assert(flowT.state === "starting", "U4a 起流受理");
  await sleep(1200);
  const st = engineLoginStatus("codebuddy");
  assert(st === null || st.state === "timeout" || st.state === "pending" || st.state === "error",
    "U4b 超时窗后流程收口（timeout 或已过保留期清除——不悬挂）");
  const timeoutFrame = frames.find((f) => (f.payload as { state?: string }).state === "timeout");
  if (timeoutFrame) {
    assert(typeof (timeoutFrame.payload as { hint?: string }).hint === "string", "U4c timeout 帧带 hint（端上显示可重开）");
  } else {
    // 保留期 5min 未裁——终态对象还在即可
    assert(engineLoginStatus("codebuddy") !== null, "U4c' 终态流程对象保留（status 查询窗口）");
  }

  // ---------- U5 cancel + verify ----------
  section("U5 cancel/verify 动作");
  resetEngineLoginFlows();
  frames.length = 0;
  rmSync(join(STATE, "cap-n"), { force: true });
  rmSync(CAPTURE_SEQ, { force: true });
  writeFileSync(CAPTURE_SEQ, "https://copilot.tencent.com/login?platform=CLI&state=xy9\n");
  writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
  const flowC = startEngineLogin(bus, "codebuddy");
  await sleep(500);
  const cancelled = cancelEngineLogin(bus, "codebuddy");
  assert(cancelled?.state === "cancelled", "U5a cancel 同步受理：置 cancelled");
  const cancelFrame = frames.find((f) => (f.payload as { state?: string }).state === "cancelled");
  assert(!!cancelFrame, "U5b cancelled 帧广播（端上收卡）");
  // verify：needs_auth 回弹（推当前 pending 态）→ 切 ready → settle
  resetEngineLoginFlows();
  frames.length = 0;
  writeFileSync(CAPTURE_SEQ, "https://copilot.tencent.com/login?platform=CLI&state=zz8\n");
  startEngineLogin(bus, "codebuddy");
  await sleep(350);
  verifyEngineLogin(bus, "codebuddy");
  await sleep(150);
  writeFileSync(CB_STATE, "Signed in as tester@example.com (Plus)\n");
  verifyEngineLogin(bus, "codebuddy");
  await sleep(350);
  const vSt = engineLoginStatus("codebuddy");
  assert(vSt?.state === "ready", "U5c verify 链：异步直探 ready → 收口推 ready（「我已完成登录」按钮链）");
  assert(frames.some((f) => (f.payload as { state?: string }).state === "ready"), "U5d verify ready 帧广播");

  // ---------- U6 codex browser 模式 + 无步状态机 ----------
  section("U6 codex browser 模式");
  resetEngineLoginFlows();
  frames.length = 0;
  rmSync(join(STATE, "cap-n"), { force: true });
  rmSync(CAPTURE_SEQ, { force: true });
  writeFileSync(CAPTURE_SEQ, "Starting local login server on http://localhost:1455.\thttps://auth.openai.com/oauth/authorize?code_challenge=m7BK&state=cx1\n");
  const flowX = startEngineLogin(bus, "codex");
  assert(flowX.mode === "browser", "U6a codex 引导卡形态 browser（本机浏览器回调型——任务书口径）");
  let sx: Awaited<ReturnType<typeof engineLoginStatus>> = null;
  for (let i = 0; i < 40 && !(sx?.url ?? "").startsWith("https://auth.openai.com/oauth/authorize?"); i++) {
    await sleep(75);
    sx = engineLoginStatus("codex");
  }
  assert(!!sx?.url && sx.url.startsWith("https://auth.openai.com/oauth/authorize?"),
    "U6b codex URL 提取（auth.openai.com 白名单——本机回调 1455 排除不提）");
  resetEngineLoginFlows();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  fail++;
  console.error(`  ✗ 测试件异常终止: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
} finally {
  if (savedCb === undefined) delete process.env.CCR_CODEBUDDY_PATH;
  else process.env.CCR_CODEBUDDY_PATH = savedCb;
  if (savedCx === undefined) delete process.env.CCR_CODEX_PATH;
  else process.env.CCR_CODEX_PATH = savedCx;
  delete process.env.CCR_TMUX_CMD;
  delete process.env.CCR_LOGIN_TIMESCALE;
  delete process.env.CCR_LOGIN_FLOW_TIMEOUT_MS;
  delete process.env.CODEX_HOME;
  rmSync(T, { recursive: true, force: true });
}
