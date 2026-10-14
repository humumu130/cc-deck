// ---------- #102 批 B：引擎登录 pane（把饭喂到嘴里——用户 1014 定调） ----------
// 批 A（5d404c2）已把「装了未登录」探成 needs_auth 并 fail-fast 拦创建，但指引是
// 「终端运行 xxx 登录」——对不碰终端的用户门槛太高。本件让 relay 自己 spawn 一个
// 登录专用进程（tmux 托管真 PTY，TUI/交互式 CLI 均可跑），抓面板输出提取授权 URL
// /二维码，推 AUTH_REQUIRED 瞬态事件——端上引导卡直接渲染二维码，扫码即登录，
// 全程零终端操作。
//
// 实测锚定（2026-10-14 本机 tmux 探查，各引擎只跑一次记录输出，证据存回执）：
//   codebuddy  `codebuddy-code` 进 TUI：首屏 trust folder 四选一（选 1）；完全未
//              登录时随后自动弹登录——面板打印
//              https://copilot.tencent.com/login?platform=CLI&state=… +
//              「Waiting for auth… (Press ESC to cancel)」（device-flow，任意设备
//              扫码授权即可完成 → QR 卡）。注意：批 A 注释「进 TUI 停在登录提示」
//              与实测不符——trust 对话框先于登录出现。
//   codex      `codex login` 直接打印
//              https://auth.openai.com/oauth/authorize?…（本地回调 localhost:1455，
//              CLI 自己开浏览器）→ browser 卡（URL 兜底显示，授权需在本机完成）。
//   trae       `trae-cli`（v2，官方 install_v2.sh 主线；1.0 已 limited maintenance）
//              进 TUI 输入框，`?` 弹三选一 Sign in（1=Email）→ 打印
//              https://console.enterprise.trae.cn/authorization?…（回调
//              127.0.0.1:<port> + Callback URL 粘贴框）→ QR 卡（URL 可扫，授权页
//              任意设备打开，完成需回到本机/粘贴回调）。
//   qwen-code  本机未装未实测：按 gemini-cli fork 惯例 TUI 内 /auth 触发（备案——
//              提取走通用 URL 兜底，识别不到就透 hint 降级，不阻塞主链）。
//
// 设计要点：
//   1. tmux 托管：tmux new-session -d 起登录进程（真 PTY，TUI 渲染可靠），轮询
//      capture-pane 抓屏（复用 injector.ts tmux 基建同款命令形态；登录 pane 自持
//      session 名，无需 pid→target 解析，故本件自带最小 tmux helper 不动 injector）。
//      tmux 注入缝：CCR_TMUX_CMD 指假脚本（测试），缺省 "tmux"。
//   2. 幂等：同引擎已有活流程（starting/pending）→ 复用推最新事件，不重复 spawn
//      （反复点「立即登录」/重复被拦截不会起一排 pane）。
//   3. 探针联动（任务书钉死）：登录 pane 存活期该引擎探针不吃 45s TTL——轮验走
//      probeEngineAuth(opts) 直探旁路 + 每轮 resetEngineAuthCache()（清全部引擎
//      缓存：Map 无单键失效面，登录流程是低频事件、catalog 组装频率低，代价可
//      接受），登录完成 catalog/拦截面立即自愈。
//   4. 生命周期：ready（探针转绿）→ 收 pane 推 ready 事件（端上卡片转绿 + 本地
//      catalog patch）；timeout 5min → 收 pane 推 timeout 态；终态流程对象保留
//      5min 供 status 查询后删。
//   5. 事件 AUTH_REQUIRED 走 emitTransient（瞬态：seq:0 不落 events.ndjson 不补发
//      ——离线端重连后发 COMMAND_ENGINE_LOGIN status 拿当前态兜底，同
//      ACCEPTANCES_UPDATED 收敛模型）。
import { spawn } from "node:child_process";
import type { SessionEngine } from "./types.js";
import { probeEngineAuthAsync, resetEngineAuthCache, staticAuthHint } from "./engine-auth.js";

// ---------- 最小 tmux helper（登录 pane 自持 session，不动 injector 既有链路） ----------

function tmuxCmd(): string {
  return process.env.CCR_TMUX_CMD || "tmux";
}

function runTmux(args: string[], timeoutMs = 5000): Promise<{ ok: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(tmuxCmd(), args);
    let out = "";
    let err = "";
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (err += c));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: "", error: "timeout" });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: "", error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, text: out, error: code === 0 ? undefined : (err.trim() || `exit ${code}`) });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 引擎登录 profile（首屏状态机 + URL 白名单；实测锚定见文件头） ----------

interface LoginStep {
  /** capture 文本命中此 pattern = 该步在场（未发过键则发送） */
  match: RegExp;
  /** 命中后发送的键（tmux send-keys -l 字面量；"Enter" 特判为回车键名） */
  keys?: string[];
  /** 发送后额外等待 ms（TUI 渲染节流） */
  settleMs?: number;
}

interface LoginProfile {
  /** tmux new-session 跑的命令行 */
  command: () => string[];
  /** 引导卡形态：qr=URL 可扫（device-flow）；browser=本机浏览器回调型；hint=纯指引 */
  mode: "qr" | "browser" | "hint";
  /** 屏幕驱动状态机（按序探测，每步只发一次键） */
  steps: LoginStep[];
  /** 授权 URL 白名单（命中优先于通用兜底） */
  urlPattern?: RegExp;
  /** 就绪等待（TUI 冷启动到可交互的毫秒数，首个 step 探测前等） */
  bootMs: number;
}

const PROFILES: Partial<Record<SessionEngine, LoginProfile>> = {
  codebuddy: {
    command: () => [process.env.CCR_CODEBUDDY_PATH || "codebuddy-code"],
    mode: "qr",
    bootMs: 4000,
    steps: [
      // 实测首屏 trust folder 四选一：选 1（仅信任当前目录）+ 回车
      { match: /do you trust the files in this folder/i, keys: ["1", "Enter"], settleMs: 3000 },
    ],
    urlPattern: /^https:\/\/copilot\.tencent\.com\/login\?\S+/i,
  },
  codex: {
    command: () => [process.env.CCR_CODEX_PATH || "codex", "login"],
    mode: "browser",
    bootMs: 3000,
    steps: [], // codex login 非交互首屏直接打印 URL，无需驱动
    urlPattern: /^https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/i,
  },
  trae: {
    command: () => [process.env.CCR_TRAE_PATH || "trae-cli"],
    mode: "qr",
    bootMs: 5000,
    steps: [
      // 实测：TUI 就绪后 `?` 弹 Sign in 三选一 → 选 1（Email，自动确认出 URL）
      { match: /ask trae cli to do anything|TRAE CLI \(v/i, keys: ["?"], settleMs: 2500 },
      { match: /sign in to use trae cli/i, keys: ["1"], settleMs: 3000 },
      { match: /login with email/i, keys: ["Enter"], settleMs: 2500 },
    ],
    urlPattern: /^https:\/\/console\.enterprise\.trae\.cn\/authorization\?\S+/i,
  },
  "qwen-code": {
    command: () => [process.env.CCR_QWEN_PATH || "qwen-code"],
    mode: "qr",
    bootMs: 5000,
    steps: [
      // 未实测备案：gemini-cli fork 惯例 TUI 内 /auth 触发设备授权流
      { match: /ask anything|qwen|gemini/i, keys: ["/auth", "Enter"], settleMs: 3000 },
    ],
  },
};

// ---------- URL / 二维码字符画提取（纯函数，导出供测试） ----------

/** 通用兜底排除域：文档/官网首页/本地回调不是授权链接（授权页的特征是带查询串的
 * login/auth/authorize 路径） */
const URL_EXCLUDE = /localhost|127\.0\.0\.1|docs\.trae\.cn|www\.trae\.cn|trae\.cn\/trae-cli|codebuddy\.ai\/docs|www\.codebuddy\.ai|openai\.com\/?$|npmjs\.org|github\.com\/?$/i;

/** 从面板文本提取授权 URL：profile 白名单命中优先（第一个匹配行）；否则通用兜底
 * （https + 排除域 + 带 ? 查询串，取最后一个 = 最新打印的授权链接）。
 * 命中白名单要求整行 URL（授权 URL 实测都是独立行）；通用兜底做行内截取。 */
export function extractLoginUrl(text: string, profileUrlPattern?: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  if (profileUrlPattern) {
    for (const line of lines) {
      const m = profileUrlPattern.exec(line.trim());
      if (m) return m[0];
    }
  }
  let fallback: string | null = null;
  for (const line of lines) {
    const m = /https:\/\/[^\s"'<>()]+/.exec(line);
    if (!m) continue;
    const url = m[0].replace(/[.,;:]+$/, "");
    if (URL_EXCLUDE.test(url)) continue;
    if (!url.includes("?")) continue; // 授权链接必带 state/code_challenge 等查询串
    fallback = url;
  }
  return fallback;
}

/** 终端二维码字符画检测：≥5 行连续、每行 ≥8 个 QR 块字符（█▄▀ 等）且行宽对齐
 * （±2 列内——真二维码行宽恒一致）→ 原样透传。对齐门槛是实测教训：codebuddy
 * 主界面 logo（████ 拼的字符图形）行宽参差也满足密度判定，被误当二维码透传
 * （真链实锤；无害但脏帧）。识别不了的场景通常也带 URL，本函数只是兜底通道 */
export function extractQrBlockArt(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let run: string[] = [];
  const flush = (): string | null => {
    if (run.length < 5) return null;
    const widths = run.map((l) => l.trimEnd().length);
    const max = Math.max(...widths);
    return widths.every((w) => Math.abs(w - max) <= 2) ? run.join("\n") : null;
  };
  for (const line of lines) {
    const dense = (line.match(/[█▄▀▌▐◆]/g) || []).length;
    if (dense >= 8) run.push(line);
    else {
      const art = flush();
      if (art) return art;
      run = [];
    }
  }
  return flush();
}

// ---------- 登录流程管理 ----------

export type LoginFlowState = "starting" | "pending" | "ready" | "timeout" | "error" | "cancelled";

export interface LoginFlow {
  flow_id: string;
  engine: SessionEngine;
  state: LoginFlowState;
  mode: "qr" | "browser" | "hint";
  url?: string;
  qr_text?: string;
  hint: string;
  started_at: number;
  /** 状态机每步是否已发送过键（steps 下标 → done） */
  stepFired: Set<number>;
  /** 已广播过的 URL（同 URL 不重推） */
  lastPushedUrl?: string;
}

/** 流程投影（事件/ACK 载荷形状——与 types.ts AuthRequiredPayload 字段同构） */
export function flowProjection(f: LoginFlow) {
  return {
    flow_id: f.flow_id,
    engine: f.engine,
    state: f.state,
    mode: f.mode,
    ...(f.url ? { url: f.url } : {}),
    ...(f.qr_text ? { qr_text: f.qr_text } : {}),
    hint: f.hint,
    ts: Date.now(),
  };
}

interface BusLike {
  emitTransient(type: string, payload: unknown): void;
}

const flows = new Map<SessionEngine, LoginFlow>();
/** 终态流程保留截止（status 查询窗口） */
const finishedAt = new Map<SessionEngine, number>();
const FLOW_RETAIN_MS = 5 * 60_000;
// 测试缝：CCR_LOGIN_FLOW_TIMEOUT_MS 可缩短超时窗（缺省 5min——真实扫码授权时长上限）；
// CCR_LOGIN_TIMESCALE 时间缩放除数（boot/settle 等待同除——测试把 4s boot 压到 40ms 级）
const TIMESCALE = Number(process.env.CCR_LOGIN_TIMESCALE) > 0 ? Number(process.env.CCR_LOGIN_TIMESCALE) : 1;
const FLOW_TIMEOUT_MS = (Number(process.env.CCR_LOGIN_FLOW_TIMEOUT_MS) > 0 ? Number(process.env.CCR_LOGIN_FLOW_TIMEOUT_MS) : 5 * 60_000) / TIMESCALE;
const POLL_MS = (Number(process.env.CCR_LOGIN_POLL_MS) > 40 ? Number(process.env.CCR_LOGIN_POLL_MS) : 1200) / TIMESCALE;
const scaleMs = (ms: number) => ms / TIMESCALE;
/** 每 N 轮 capture 做一次登录态直探（登录面板存活期不吃 45s TTL） */
const PROBE_EVERY_POLLS = 2;

function engineHint(engine: SessionEngine): string {
  // 静态文案（零 spawn）：流程因 needs_auth 才被发起，hint 只做降级显示；
  // 探针级精确 hint 在拦截 ACK 的 auth_hint 已带过，这里不重复探测阻塞主线程
  return staticAuthHint(engine);
}

function flowTmuxSession(engine: SessionEngine): string {
  return `ccr-login-${engine.replace(/[^a-z0-9-]/gi, "")}`;
}

function pushEvent(bus: BusLike | undefined, f: LoginFlow): void {
  if (!bus) return;
  try {
    bus.emitTransient("AUTH_REQUIRED", flowProjection(f));
  } catch {
    /* 广播失败不影响流程推进 */
  }
}

async function killPane(engine: SessionEngine): Promise<void> {
  await runTmux(["kill-session", "-t", flowTmuxSession(engine)]);
}

// ---------- 受理面（同步——handleCommand 是同步函数，ACK 立即回；pane 起流与
// 状态推进全部异步走 AUTH_REQUIRED 事件流，ACK 只是受理回执不是结果面） ----------

/** 发起/复用登录流程（幂等，同步受理）：活流程直接复用推最新事件；终态/无流程
 * 建新 flow（state=starting）+ 异步起 pane（tmux 不可用 → 异步转 error 推事件）。
 * 引擎无 profile（不该走到；防御面）→ hint-only 流程仅轮探。 */
export function startEngineLogin(bus: BusLike | undefined, engine: SessionEngine): ReturnType<typeof flowProjection> {
  const profile = PROFILES[engine];
  const existing = flows.get(engine);
  if (existing && (existing.state === "starting" || existing.state === "pending")) {
    pushEvent(bus, existing); // 幂等复用：重推最新态（端上丢过瞬态帧可自愈）
    return flowProjection(existing);
  }
  const f: LoginFlow = {
    flow_id: `englogin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    engine, state: "starting",
    mode: profile ? profile.mode : "hint",
    hint: engineHint(engine), started_at: Date.now(), stepFired: new Set(),
  };
  flows.set(engine, f);
  finishedAt.delete(engine);
  pushEvent(bus, f);
  if (!profile) {
    f.state = "pending";
    void watchHintOnly(bus, engine);
  } else {
    void spawnLoginPane(bus, engine, profile);
  }
  return flowProjection(f);
}

/** 异步起 pane：清孤儿 session → tmux new-session → 转.pending 进轮询循环；
 * tmux 失败 → error 终态推事件（端上卡片降级显 hint） */
async function spawnLoginPane(bus: BusLike | undefined, engine: SessionEngine, profile: LoginProfile): Promise<void> {
  const f = flows.get(engine);
  if (!f || (f.state !== "starting" && f.state !== "pending")) return;
  await killPane(engine); // 上次异常残留的同名 session
  const cmd = profile.command();
  const started = await runTmux(["new-session", "-d", "-x", "120", "-y", "36", "-s", flowTmuxSession(engine), ...cmd]);
  const cur = flows.get(engine);
  if (!cur || cur !== f) return; // 等待期间被取消/替换
  if (!started.ok) {
    f.state = "error";
    f.hint = `${f.hint}（自动拉起登录面板失败：${started.error || "tmux 不可用"}）`;
    finishedAt.set(engine, Date.now());
    pushEvent(bus, f);
    return;
  }
  f.state = "pending";
  void pollLoop(bus, engine);
}

/** hint-only 流程（无 pane 可抓）：仅轮探登录态，ready 即收（无 profile 引擎防御场景） */
async function watchHintOnly(bus: BusLike | undefined, engine: SessionEngine): Promise<void> {
  const f = flows.get(engine);
  if (!f) return;
  const deadline = Date.now() + FLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(PROBE_EVERY_POLLS * POLL_MS);
    const cur = flows.get(engine);
    if (!cur || cur !== f || (cur.state !== "pending" && cur.state !== "starting")) return;
    resetEngineAuthCache();
    const probe = await probeEngineAuthAsync(engine, { timeoutMs: 5000 });
    if (probe.state === "ready") return settleReady(bus, engine);
  }
  return settleTimeout(bus, engine);
}

async function settleReady(bus: BusLike | undefined, engine: SessionEngine): Promise<void> {
  const f = flows.get(engine);
  if (f) {
    f.state = "ready";
    finishedAt.set(engine, Date.now());
    pushEvent(bus, f);
  }
  await killPane(engine);
  resetEngineAuthCache();
}

async function settleTimeout(bus: BusLike | undefined, engine: SessionEngine): Promise<void> {
  const f = flows.get(engine);
  if (f) {
    f.state = "timeout";
    f.hint = `${f.hint}（等待登录超时，可重新发起）`;
    finishedAt.set(engine, Date.now());
    pushEvent(bus, f);
  }
  await killPane(engine);
}

async function pollLoop(bus: BusLike | undefined, engine: SessionEngine): Promise<void> {
  const profile = PROFILES[engine];
  const f = flows.get(engine);
  if (!profile || !f) return;
  const session = flowTmuxSession(engine);
  const deadline = Date.now() + FLOW_TIMEOUT_MS;
  let polls = 0;
  let bootWait = scaleMs(profile.bootMs);
  // 「回到输入框」检测（codebuddy 已 trust 但 token 过期不自动弹登录的兜底）：主界面
  // 在场且始终无 URL，20s 后补发 /login（一次性）
  let fallbackLoginAt: number | null = null;
  let fallbackFired = false;
  while (Date.now() < deadline) {
    const cur = flows.get(engine);
    if (!cur || cur !== f || (cur.state !== "pending" && cur.state !== "starting")) return; // 已被收口/替换
    if (bootWait > 0) {
      const w = Math.min(bootWait, POLL_MS);
      await sleep(w);
      bootWait -= w;
      continue;
    }
    const cap = await runTmux(["capture-pane", "-p", "-t", session]);
    if (!cap.ok) {
      // pane 消失（用户手滑关掉/CLI 退出）→ 探针再验一次决定收法
      await sleep(POLL_MS);
      const probe = await probeEngineAuthAsync(engine, { timeoutMs: 5000 });
      if (probe.state === "ready") return settleReady(bus, engine);
      const cap2 = await runTmux(["capture-pane", "-p", "-t", session]);
      if (!cap2.ok) {
        // 真没了：按当前登录态收口（未 ready 视为取消——面板不在了轮询无意义）
        const st = flows.get(engine);
        if (st && (st.state === "pending" || st.state === "starting")) {
          st.state = "cancelled";
          finishedAt.set(engine, Date.now());
          pushEvent(bus, st);
        }
        return;
      }
      continue;
    }
    const text = cap.text;
    // 状态机驱动（每步只发一次）
    for (let i = 0; i < profile.steps.length; i++) {
      if (f.stepFired.has(i)) continue;
      const step = profile.steps[i];
      if (step.match.test(text)) {
        f.stepFired.add(i);
        if (step.keys?.length) {
          // ⚠ tmux send-keys 的 -l 对后续所有参数生效——"1"+"Enter" 合一发会把
          // Enter 字面打进面板（真链实锤：trust 框选 1 后不确认；假 tmux 测试只
          // 记录参数不执行，headless 全绿也拦不住——L4 纪律案例）。字面与键名
          // 必须分次发送：连续字面归一组走 -l，Enter 走键名单发
          let literal = "";
          for (const k of step.keys) {
            if (k === "Enter") {
              if (literal) { await runTmux(["send-keys", "-t", session, "-l", literal]); literal = ""; }
              await runTmux(["send-keys", "-t", session, "Enter"]);
            } else literal += k;
          }
          if (literal) await runTmux(["send-keys", "-t", session, "-l", literal]);
        }
        if (step.settleMs) await sleep(scaleMs(step.settleMs));
        break; // 本轮只处理一步（下一步下轮探测）
      }
    }
    // URL 提取（变化才推）
    const url = extractLoginUrl(text, profile.urlPattern);
    if (url && url !== f.url) {
      f.url = url;
      pushEvent(bus, f);
    }
    // codebuddy /login 兜底：主界面在场 + 无 URL + 无等待提示 + 过 20s → 补发一次
    if (engine === "codebuddy" && !f.url && !/waiting for auth/i.test(text)) {
      if (fallbackLoginAt === null) fallbackLoginAt = Date.now() + scaleMs(20_000);
      else if (!fallbackFired && Date.now() > fallbackLoginAt && /ask anything|tips for getting started/i.test(text)) {
        fallbackFired = true;
        await runTmux(["send-keys", "-t", session, "-l", "/login"]);
        await runTmux(["send-keys", "-t", session, "Enter"]);
      }
    }
    // 二维码字符画兜底透传（一次性：出现过就带住）
    if (!f.qr_text) {
      const art = extractQrBlockArt(text);
      if (art) {
        f.qr_text = art;
        pushEvent(bus, f);
      }
    }
    // 探针轮验（不吃 45s TTL——任务书钉死；异步探针不阻塞 relay 主线程）
    polls++;
    if (polls % PROBE_EVERY_POLLS === 0) {
      resetEngineAuthCache();
      const probe = await probeEngineAuthAsync(engine, { timeoutMs: 5000 });
      if (probe.state === "ready") return settleReady(bus, engine);
    }
    await sleep(POLL_MS);
  }
  return settleTimeout(bus, engine);
}

/** 查询当前流程（无则 null；顺手清过期终态流程） */
export function engineLoginStatus(engine: SessionEngine): ReturnType<typeof flowProjection> | null {
  pruneFinishedFlows();
  const f = flows.get(engine);
  return f ? flowProjection(f) : null;
}

/** 取消登录流程（同步受理）：置 cancelled 推事件，pane 异步收 */
export function cancelEngineLogin(bus: BusLike | undefined, engine: SessionEngine): ReturnType<typeof flowProjection> | null {
  const f = flows.get(engine);
  if (!f) return null;
  if (f.state === "starting" || f.state === "pending") {
    f.state = "cancelled";
    finishedAt.set(engine, Date.now());
    pushEvent(bus, f);
  }
  void killPane(engine);
  return flowProjection(f);
}

/** 「我已完成登录」重验（异步推进，结果走 AUTH_REQUIRED 事件）：清缓存异步直探
 * ——spawnSync 会阻塞主线程（批 A CACHE_TTL 处同款防线），同步 ACK 只做受理。
 * ready 且有活流程 → settleReady（收 pane+推 ready 事件，端上卡片转绿+目录转绿）；
 * 仍 needs_auth → 推一帧当前 pending 态（端上解除「验证中」回弹继续引导）。 */
export function verifyEngineLogin(bus: BusLike | undefined, engine: SessionEngine): void {
  resetEngineAuthCache();
  void (async () => {
    const probe = await probeEngineAuthAsync(engine, { timeoutMs: 8000 });
    if (probe.state === "ready") {
      const f = flows.get(engine);
      if (f && (f.state === "starting" || f.state === "pending")) {
        await settleReady(bus, engine);
        return;
      }
      // 无活流程（用户没走引导卡直接验）：推一帧 ready 语义的合成事件（端上目录
      // 转绿）；state=ready mode=hint 无 url——端上按 engine patch catalog 即可
      pushEvent(bus, {
        flow_id: `englogin-verify-${Date.now().toString(36)}`,
        engine, state: "ready", mode: "hint",
        hint: probe.auth_hint ?? "", started_at: Date.now(), stepFired: new Set(),
      });
      return;
    }
    const f = flows.get(engine);
    if (f && (f.state === "pending" || f.state === "starting")) pushEvent(bus, f); // 仍需登录：回弹
  })();
}

/** 终态流程过期清理（status 查询时顺带；不做后台定时器——查询即清理足够） */
export function pruneFinishedFlows(): void {
  const now = Date.now();
  for (const [engine, at] of finishedAt) {
    if (now - at > FLOW_RETAIN_MS) {
      flows.delete(engine);
      finishedAt.delete(engine);
    }
  }
}

/** 测试缝：清全部流程状态 */
export function resetEngineLoginFlows(): void {
  flows.clear();
  finishedAt.clear();
}
