// 终端按键注入：Windows 走 bin/inject.cs 产物（SendInput/AttachConsole，不抢焦点）；
// macOS 走 osascript + System Events keystroke（#305，需辅助功能一次性授权）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import path, { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 插件/EXE 形态：bin 目录跟随 CCR_DATA_DIR；inject.cs 源可用 CCR_INJECT_CS 指定（打包时带出）
const dataDir = process.env.CCR_DATA_DIR ?? path.join(here, "..", "data");
const binDir = path.join(dataDir, "bin");
const injectCs = process.env.CCR_INJECT_CS ?? path.join(here, "..", "bin", "inject.cs");
const exe = path.join(binDir, "inject.exe");
const CSC = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";

// 平台判定：CCR_TEST_PLATFORM=darwin 强制走 macOS 分支——Windows 上也能单测 osascript
// 命令串组装（运行时读取，兼容测试先 import 后设 env）
function isDarwin(): boolean {
  return process.env.CCR_TEST_PLATFORM === "darwin" || process.platform === "darwin";
}
// CCR_INJECT_CMD（测试假注入器）显式指定时优先于平台分支（平台无关，CI 用）
function useAppleInjector(): boolean {
  return !process.env.CCR_INJECT_CMD && isDarwin();
}

// 测试用：CCR_INJECT_CMD=node 脚本路径 时改走假注入器（记录参数）；运行时读取以兼容测试先 import 后设 env
let ready = existsSync(exe);

// inject.exe 只在 Windows 存在（csc 编译 + AttachConsole）；macOS 用系统自带 osascript 无需准备；
// CCR_INJECT_CMD 假注入器平台无关（CI 在 Linux 跑测试用）
export function ensureInjector(): boolean {
  if (process.env.CCR_INJECT_CMD) return true;
  if (isDarwin()) return true;
  if (process.platform !== "win32") return false;
  if (ready) return true;
  try {
    mkdirSync(binDir, { recursive: true });
    execFileSync(CSC, ["-nologo", `-out:${exe}`, injectCs], { timeout: 30_000, windowsHide: true });
    ready = true;
  } catch (e) {
    console.warn("[injector] compile failed:", e instanceof Error ? e.message : e);
  }
  return ready;
}

export type InjectResult = { ok: boolean; error?: string };

// PID 复用防护：cli-pids.json / ~/.claude/sessions 残留的 pid 跨重启存活，Windows
// pid 回收快，可能已指向无关进程——AttachConsole 对任何有控制台的进程都会成功，
// 按键会打进无辜终端。注入前校验目标映像仍是 CLI 宿主（claude.exe / node.exe）。
// 假注入器（CCR_INJECT_CMD，测试）用任意 pid，跳过校验。
// 调用方已做平台门控（injectSupported），这里只需 Windows tasklist 路径。
const VALID_TARGET = /^(claude|node)(\.exe)?$/i;

function targetIsCliHost(pid: number): boolean {
  if (process.env.CCR_INJECT_CMD) return true;
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    const m = /^"([^"]+?\.exe)"/.exec(out.trim());
    return !!m && VALID_TARGET.test(m[1]);
  } catch {
    return false;
  }
}

// inject.cs 只用退出码表达结果（它做过控制台切换后不能碰 Console，见 bin/inject.cs 头注）
const ERR_BY_CODE: Record<number, string> = {
  1: "process-gone",
  2: "write-fail",
  3: "bad-args",
  4: "conin-fail",
  5: "internal-error",
};

function run(args: string[]): Promise<InjectResult> {
  return new Promise((resolve) => {
    const fake = process.env.CCR_INJECT_CMD;
    // windowsHide：控制台子进程默认弹出新控制台窗口（用户看到终端一闪而过）。
    // inject.exe 自带 FreeConsole+AttachConsole(目标)，初始控制台藏起来不影响注入
    const child = fake
      ? spawn(process.execPath, [fake, ...args], { windowsHide: true })
      : spawn(exe, args, { windowsHide: true });
    let err = "";
    child.stderr?.on("data", (c) => (err += c));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "timeout" });
    }, 10_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: ERR_BY_CODE[code ?? -1] ?? (err.trim() || `exit ${code}`) });
    });
  });
}

const CHUNK = 400;

// ---------- macOS（#305 第七轮）：Terminal `do script ... in tab` ----------
// 前六轮 System Events keystroke 全链路 code=0 但键不落 claude 终端（TUI 拒收合成键盘
// 事件 / key window 命不中双假设未破）。本轮换原生通道：按 pid 反查 tty → 遍历 Terminal
// 窗口命中 tty 的标签页 → `do script "text" in selected tab`。do script 的语义是
// "往该标签页打字并回车"——字节经 tty 行规范进入前台程序（claude 读的是真实输入流，
// 与真人敲键盘同路径），不经合成事件、不需要辅助功能权限、不抢焦点。
// 注意：do script 一定追加 Return（整段文本一次调用正好=提交）；relay 需在 Terminal.app
// 内运行（自己 tell 自己免 TCC；sshd/nohup 上下文会吃 Automation 拒绝）。

// AppleScript 字符串字面量转义：反斜杠、双引号（do script 的 command 参数是字面量）
function escapeApple(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// 组装 do-script 脚本（导出供测试断言结构，Windows 上不真跑 osascript）。
// 文本走 buildDoScript（字面量转义）；ESC 等 ctrl 字符走 buildDoScriptExpr（传 AppleScript
// 表达式，如 "ASCII character 27"——字面量里写  会被当五个字符打出来）
export function buildDoScript(pid: number, command: string): string {
  return buildDoScriptExpr(pid, `"${escapeApple(command)}"`);
}

export function buildDoScriptExpr(pid: number, expr: string): string {
  return [
    "tell application \"Terminal\"",
    `	set targetTty to do shell script "ps -o tty= -p ${pid}"`,
    "	repeat with w in windows",
    "		try",
    "			if tty of selected tab of w ends with targetTty then",
    `				do script (${expr}) in selected tab of w`,
    "				exit repeat",
    "			end if",
    "		end try",
    "	end repeat",
    "end tell",
  ].join("\n");
}

// Automation 权限拒绝（-25211/-1743）：relay 跑在 sshd/nohup 上下文时 tell Terminal
// 会被 TCC 拦——翻译成人话（导出供测试）。辅助功能（-1719）已不再需要，保留映射兜底旧错。
export function mapAppleError(stderr: string): string | undefined {
  return /-25211\b|-1743\b/.test(stderr)
    ? "Mac relay 需在 Terminal 窗口内运行（sshd/nohup 上下文无权自动化 Terminal；或给对应进程授 Terminal 自动化权限）"
    : /-1719\b/.test(stderr)
      ? "需要在 Mac 系统设置→隐私与安全性→辅助功能中授权（旧 keystroke 路径遗留，do script 理论上不再需要）"
      : undefined;
}

function runAppleScript(script: string): Promise<InjectResult> {
  return new Promise((resolve) => {
    // CCR_OSASCRIPT_CMD：测试用假 osascript（node 脚本记录 argv）；生产恒为系统 osascript
    const fake = process.env.CCR_OSASCRIPT_CMD;
    const child = fake
      ? spawn(process.execPath, [fake, "-e", script], { windowsHide: true })
      : spawn("osascript", ["-e", script]);
    let err = "";
    child.stderr?.on("data", (c) => (err += c));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "timeout" });
    }, 10_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 权限/进程类失败重试无益（与 Windows 控制台竞态不同），直接把 osascript 报错带回
      if (code === 0) return resolve({ ok: true });
      // #305 诊断：relay 宿主（Terminal）内 osascript 的真实报错落盘——ssh 上下文无法复现
      try { appendFileSync(join(homedir(), "inject-debug.log"), `[${new Date().toISOString()}] code=${code} err=${err} |n`); } catch {}
      resolve({ ok: false, error: mapAppleError(err) ?? (err.trim() || `exit ${code}`) });
    });
  });
}

// macOS pid 复用防护：ps 确认目标映像仍是 CLI 宿主（claude/node），与 Windows tasklist 路径同理；
// CCR_OSASCRIPT_CMD 假注入器（测试）用任意 pid，跳过校验
function macTargetIsCliHost(pid: number): boolean {
  if (process.env.CCR_OSASCRIPT_CMD) return true;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000 });
    const base = out.trim().split("/").pop() ?? "";
    return VALID_TARGET.test(base);
  } catch {
    return false;
  }
}

async function injectTextMac(pid: number, rawText: string): Promise<InjectResult> {
  if (!macTargetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  const text = rawText.replace(/[\r\n]+/g, " ").trim();
  if (!text) return { ok: false, error: "空消息" };
  // do script 单次整段注入（无 keystroke 的长度可靠性问题，不切分；自带 Return 提交）
  return runAppleScript(buildDoScript(pid, text));
}

// 运行时读 env（测试先 import 后设 CCR_INJECT_CMD）：非 Windows/macOS 明确报不支持，
// 外部会话注入功能降级，managed 会话不受影响。CCR_INJECT_CMD 覆盖逻辑保留（显式 env 优先）
export function injectSupported(): boolean {
  return process.platform === "win32" || isDarwin() || !!process.env.CCR_INJECT_CMD;
}
const ERR_UNSUPPORTED = "当前平台不支持按键注入（仅 Windows/macOS）";

export async function injectText(pid: number, rawText: string): Promise<InjectResult> {
  if (!injectSupported()) return { ok: false, error: ERR_UNSUPPORTED };
  if (!ensureInjector()) return { ok: false, error: "注入器不可用（编译失败，缺 .NET Framework csc？）" };
  if (useAppleInjector()) return injectTextMac(pid, rawText);
  if (!targetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  const text = rawText.replace(/[\r\n]+/g, " ").trim();
  if (!text) return { ok: false, error: "空消息" };
  for (let i = 0; i < text.length; i += CHUNK) {
    const last = i + CHUNK >= text.length;
    const args = [String(pid), text.slice(i, i + CHUNK), ...(last ? [] : ["noenter"])];
    let r = await run(args);
    // 瞬时失败（控制台状态竞态等）重试一次；进程已死/参数错不值得重试
    if (!r.ok && r.error !== "process-gone" && r.error !== "bad-args") {
      await new Promise((r2) => setTimeout(r2, 500));
      r = await run(args);
    }
    if (!r.ok) return r;
    if (!last) await new Promise((r2) => setTimeout(r2, 120));
  }
  return { ok: true };
}

export async function injectEsc(pid: number): Promise<InjectResult> {
  if (!injectSupported()) return { ok: false, error: ERR_UNSUPPORTED };
  if (!ensureInjector()) return { ok: false, error: "注入器不可用" };
  if (useAppleInjector()) {
    if (!macTargetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
    // do script 只能打"文本+Return"：ESC 用 ASCII 27 表达式注入，尾随 Return 对 claude
    // 是"打断后提交空输入"，实测无害
    return runAppleScript(buildDoScriptExpr(pid, "ASCII character 27"));
  }
  if (!targetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  return run([String(pid), "--esc"]);
}

// 只发一个回车（空文本 + 默认带回车；inject.cs 对空文本不拒绝——
// args=["pid",""] 通过长度检查，text="" 不产生字符记录，enter=true 只写 CR）：
// 用于冲出滞留在 CLI 输入框、回车被界面层吞掉的排队消息
export async function injectEnter(pid: number): Promise<InjectResult> {
  if (!injectSupported()) return { ok: false, error: ERR_UNSUPPORTED };
  if (!ensureInjector()) return { ok: false, error: "注入器不可用" };
  if (useAppleInjector()) {
    if (!macTargetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
    return runAppleScript(buildDoScriptExpr(pid, '""'));
  }
  if (!targetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  return run([String(pid), ""]);
}
