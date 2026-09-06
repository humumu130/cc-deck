// 终端按键注入：编译并调用 bin/inject.cs 产物（Windows；ConPTY/conhost 均可，不抢焦点）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 插件/EXE 形态：bin 目录跟随 CCR_DATA_DIR；inject.cs 源可用 CCR_INJECT_CS 指定（打包时带出）
const dataDir = process.env.CCR_DATA_DIR ?? path.join(here, "..", "data");
const binDir = path.join(dataDir, "bin");
const injectCs = process.env.CCR_INJECT_CS ?? path.join(here, "..", "bin", "inject.cs");
const exe = path.join(binDir, "inject.exe");
const CSC = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";

// 测试用：CCR_INJECT_CMD=node 脚本路径 时改走假注入器（记录参数）；运行时读取以兼容测试先 import 后设 env
let ready = existsSync(exe);

// inject.exe 只在 Windows 存在（csc 编译 + AttachConsole）；CCR_INJECT_CMD 假注入器平台无关（CI 在 Linux 跑测试用）
export function ensureInjector(): boolean {
  if (process.env.CCR_INJECT_CMD) return true;
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

// 运行时读 env（测试先 import 后设 CCR_INJECT_CMD）：非 Windows 明确报不支持，
// 外部会话注入功能降级，managed 会话不受影响
export function injectSupported(): boolean {
  return process.platform === "win32" || !!process.env.CCR_INJECT_CMD;
}
const ERR_UNSUPPORTED = "当前平台不支持按键注入（仅 Windows）";

export async function injectText(pid: number, rawText: string): Promise<InjectResult> {
  if (!injectSupported()) return { ok: false, error: ERR_UNSUPPORTED };
  if (!ensureInjector()) return { ok: false, error: "注入器不可用（编译失败，缺 .NET Framework csc？）" };
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
  if (!targetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  return run([String(pid), "--esc"]);
}

// 只发一个回车（空文本 + 默认带回车；inject.cs 对空文本不拒绝——
// args=["pid",""] 通过长度检查，text="" 不产生字符记录，enter=true 只写 CR）：
// 用于冲出滞留在 CLI 输入框、回车被界面层吞掉的排队消息
export async function injectEnter(pid: number): Promise<InjectResult> {
  if (!injectSupported()) return { ok: false, error: ERR_UNSUPPORTED };
  if (!ensureInjector()) return { ok: false, error: "注入器不可用" };
  if (!targetIsCliHost(pid)) return { ok: false, error: "pid-reuse" };
  return run([String(pid), ""]);
}
