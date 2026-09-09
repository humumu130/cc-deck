// 防抢发（type guard）：排队消息滞留看门狗在补发回车前，先快照 CLI 输入框，
// 确认框内没有"非我们注入的内容"（= 真人正在打字 / 已敲未发的半截输入）才补发；
// 检测到人工输入则暂缓回车，等输入框静止（停手）后再补。纯逻辑模块：快照函数与
// 配置由调用方注入，便于单测；快照不可用一律 fail-open（回到旧的直接补发行为）。
//
// 快照格式（injector.captureConsoleBottom）：屏幕可见区末尾若干行，每行一行。
// CLI 输入框识别（Claude CLI TUI，实测 2.1.x Windows/macOS 同构）：
//   ───────────────      ← 框顶边框（全宽 ─ 行）
//   ❯ 手机排队消息：…     ← 输入内容行（❯ 提示符开头，长文折行到下方）
//     叠长文本续行…       ← 续行（2 空格缩进）
//   ───────────────      ← 框底边框
// 边框对之外的行（spinner/状态栏）不看——它们在 CLI 运行中持续跳动，纳入会误判"有人打字"。
import { captureConsoleBottom } from "./injector.js";

export interface GuardConfig {
  enabled: boolean; // CCR_TYPE_GUARD=off/0/false 整体关闭
  pollMs: number;   // 轮询间隔（检测到打字后多久再看一次）
  stableMs: number; // 输入框静止多久视作"停手"
  maxMs: number;    // 最多等多久（持续打字则放弃本轮，下轮看门狗再试）
}

export function guardConfig(): GuardConfig {
  const num = (v: string | undefined, def: number) => (Number(v) > 0 ? Number(v) : def);
  return {
    enabled: !/^(off|0|false)$/i.test(process.env.CCR_TYPE_GUARD ?? ""),
    pollMs: num(process.env.CCR_TYPE_GUARD_POLL_MS, 500),
    stableMs: num(process.env.CCR_TYPE_GUARD_STABLE_MS, 1000),
    maxMs: num(process.env.CCR_TYPE_GUARD_MAX_MS, 30_000),
  };
}

const isBorderRow = (l: string): boolean => {
  const t = l.trim();
  return t.length >= 20 && /^[─━═]{6,}$/.test(t);
};

// 从快照行提取输入框内容行（最后一对全宽边框之间的行，且含 ❯ 提示符）。
// 识别不到（权限弹窗盖住 / 异版 UI / 框被截断）返回 null → 调用方 fail-open。
export function extractInputBox(lines: string[]): string[] | null {
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBorderRow(lines[i]!)) { bottom = i; break; }
  }
  if (bottom === -1) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (isBorderRow(lines[i]!)) { top = i; break; }
  }
  if (top === -1) return null;
  const inner = lines.slice(top + 1, bottom);
  if (!inner.length || !inner.some((l) => l.includes("❯"))) return null;
  return inner;
}

// 滞留消息是否还出现在输入框：全文（去空白）包含任一滞留文本即真；
// 框内滚动只露头/尾时退化到首尾 8 字片段匹配（片段太短的短消息只走全文匹配）
export function anyKnownPresent(box: string[], knownTexts: string[]): boolean {
  const flat = box.join("").replace(/\s+/g, "");
  return knownTexts.some((t) => {
    const k = t.replace(/\s+/g, "");
    if (!k) return false;
    if (flat.includes(k)) return true;
    if (k.length < 12) return false;
    return flat.includes(k.slice(0, 8)) || flat.includes(k.slice(-8));
  });
}

// 渲染噪音：块光标/进度块、❯、右侧 n/m 计数、回车提示键位符号
function maskNoise(s: string): string {
  return s
    .replace(/[▌█░⏎⇥❯]/g, " ")
    .replace(/\d+\s*\/\s*\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeKnownTexts(s: string, known: string[]): string {
  let out = s;
  for (const t of known) {
    for (const v of new Set([t, t.replace(/\s+/g, "")])) {
      if (!v) continue;
      let prev = "";
      while (prev !== out) {
        prev = out;
        out = out.split(v).join(" ");
      }
    }
  }
  return out;
}

// 输入框内容去掉我们注入的已知文本后剩余的"外来内容"（疑似人工输入）。
// 空串 = 框内只有我们的消息（可安全补发）；非空 = 有外来内容（暂缓）。
// 折行拼接有 CJK（无空格断行）与西文（空格断行，去空白变体兜底）两种形态，
// 任一拼接形态能完整解释框内内容即视为干净——两种形态都解释不掉的才是外来内容。
export function foreignResidual(box: string[], knownTexts: string[]): string {
  const stripped = box.map((l, i) => (i === 0 ? l.replace(/^\s*❯\s*/, "") : l.replace(/^\s+/, "")));
  const residuals = ["", " "].map((sep) => maskNoise(removeKnownTexts(stripped.join(sep), knownTexts)));
  return residuals.every((r) => r) ? (residuals[0] ?? "") : "";
}

export type GuardCapture = () => Promise<string[] | null>;

export type GuardVerdict =
  | { kind: "enter" }                                    // 框内只有滞留消息 → 立即补发
  | { kind: "enter-after-wait"; waitedMs: number }       // 有人打过字，停手后补发
  | { kind: "skip-absent" }                              // 框内已无滞留消息（人工提交/清空）→ 不补发
  | { kind: "timeout"; waitedMs: number }                // 持续输入未停手 → 放弃本轮
  | { kind: "aborted" }                                  // 等待期间会话状态变化 → 静默退出
  | { kind: "unknown" };                                 // 快照不可用/识别失败 → fail-open

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 补发回车前的守门：见文件头注。abort() 由调用方每轮询检查（状态翻 WAITING /
// flush 进行中等场景下回车有副作用，直接放弃本轮）。
export async function guardCompensateEnter(
  knownTexts: string[],
  capture: GuardCapture,
  opts: { cfg?: GuardConfig; abort?: () => boolean } = {},
): Promise<GuardVerdict> {
  const cfg = opts.cfg ?? guardConfig();
  const abort = opts.abort ?? (() => false);
  const t0 = Date.now();
  let lastKey = "";
  let stableSince = 0;
  let held = false;
  while (true) {
    const lines = await capture();
    const box = lines ? extractInputBox(lines) : null;
    if (!box) return { kind: "unknown" };
    if (!anyKnownPresent(box, knownTexts)) return { kind: "skip-absent" };
    if (!foreignResidual(box, knownTexts)) return held ? { kind: "enter-after-wait", waitedMs: Date.now() - t0 } : { kind: "enter" };
    // 检测到人工输入：暂缓，等输入框静止 stableMs 视作停手再补
    held = true;
    const key = JSON.stringify(box);
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    } else if (stableSince && Date.now() - stableSince >= cfg.stableMs) {
      return { kind: "enter-after-wait", waitedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 >= cfg.maxMs) return { kind: "timeout", waitedMs: Date.now() - t0 };
    if (abort()) return { kind: "aborted" };
    await sleep(cfg.pollMs);
  }
}

// 便捷封装：用真实注入器的快照通道守门（bridge 用）
export function guardWithConsole(knownTexts: string[], pid: number, opts: { cfg?: GuardConfig; abort?: () => boolean } = {}) {
  return guardCompensateEnter(knownTexts, () => captureConsoleBottom(pid), opts);
}
