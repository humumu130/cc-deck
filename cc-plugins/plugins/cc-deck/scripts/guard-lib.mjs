#!/usr/bin/env node
// CC Deck 插件 · 任务调度守卫公共库（guard-stop / guard-context 共用）。
// 三类共享能力：
//  1) 配置：~/.cc-deck/config.json 的 taskGuard/qNotify/restorePoint 三键
//     （relay /api/plugin-config 同源读写，设置「插件」页是 UI 面）
//  2) 桥接登记：bridge-hook 每次上报定位到 CLI 进程时把 session_id 缓存进
//     ~/.cc-deck/data/cli-pids.json（dev/插件 relay 都写这里，见 bridge-hook dataDirs）。
//     会话 id 在册 = 本会话事件已被桥接给 relay = 守卫的作用域；未登记一律 exit 0 静默
//  3) 回合忙碌状态机（qNotify 判「忙碌中插入提问」用）：UserPromptSubmit 置忙、
//     放行的 Stop 置闲（被拦截的 Stop 保持忙碌），CLI 进程死亡可检出（防崩溃残留误判）
// 任何异常都静默吞掉——hook 绝不因自身故障干扰 CLI。
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_KEYS = ["taskGuard", "qNotify", "restorePoint"];
export const CONFIG_DEFAULTS = { taskGuard: false, qNotify: true, restorePoint: false };

const home = homedir();
const deckDir = join(home, ".cc-deck");
const dataDir = join(deckDir, "data");

// ---------- 配置 ----------
export function readConfig() {
  const out = { ...CONFIG_DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(join(deckDir, "config.json"), "utf-8"));
    for (const k of CONFIG_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  } catch {}
  return out;
}

// ---------- 桥接登记 ----------
export function readCliPid(sid) {
  try {
    const cache = JSON.parse(readFileSync(join(dataDir, "cli-pids.json"), "utf-8"));
    const pid = cache[sid];
    return typeof pid === "number" && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

export function isPidAlive(pid) {
  if (!pid) return true; // pid 未知：不据此否定忙碌标记（保持宽进）
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // 无权限 = 进程存在；ESRCH = 已死
  }
}

// ---------- 任务清单（~/.claude/tasks/<sid>/，同全局蓝本的读取与豁免口径） ----------
const EXEMPT_RE = /^[〔\[【]\s*(搁置|常驻)\s*[〕\]】]/;

// 可执行待办：pending/in_progress，[搁置]/[常驻]/parked 行首豁免，
// blockedBy 仍指向未完成任务的不算（引用已删/已完成任务的失效依赖忽略）
export function readTasks(sid) {
  const dir = join(home, ".claude", "tasks", sid);
  const all = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        all.push({ ...t, id: t.id ?? f.replace(/\.json$/, "") });
      } catch {}
    }
  } catch {}
  const openIds = new Set(
    all.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => String(t.id)),
  );
  return all
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .filter((t) => {
      const subj = String(t.subject || "").trim();
      const desc = String(t.description || "").trim();
      if (EXEMPT_RE.test(subj) || EXEMPT_RE.test(desc)) return false;
      if (/\bparked\b/i.test(subj + " " + desc)) return false;
      const blk = Array.isArray(t.blockedBy) ? t.blockedBy : [];
      return !blk.some((b) => openIds.has(String(b)));
    })
    .map((t) => ({ id: t.id, subject: String(t.subject || "") || "(无标题)", status: t.status }));
}

// ---------- 回合忙碌状态机 ----------
const TURN_FILE = join(dataDir, "guard-turn.json");

export function readTurn(sid) {
  try {
    const m = JSON.parse(readFileSync(TURN_FILE, "utf-8"));
    const e = m[sid];
    if (!e) return { busy: false, ts: 0, pid: 0 };
    return { busy: !!e.w, ts: Number(e.t) || 0, pid: Number(e.p) || 0 };
  } catch {
    return { busy: false, ts: 0, pid: 0 };
  }
}

export function writeTurn(sid, busy, pid) {
  try {
    let m = {};
    try {
      m = JSON.parse(readFileSync(TURN_FILE, "utf-8"));
    } catch {}
    m[sid] = { w: !!busy, t: Date.now(), p: pid || 0 };
    const keys = Object.keys(m);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete m[k];
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(TURN_FILE, JSON.stringify(m));
  } catch {}
}

// ---------- 恢复点（项目目录 .cc-deck/state.md） ----------
export const RESTORE_REL = join(".cc-deck", "state.md");
const RESTORE_FRESH_MS = 24 * 3600_000; // 只认 24h 内写入的恢复点

// 读恢复点：首行机器标记 <!-- cc-deck:restore sid=.. ts=.. -->，正文含任务行
export function readRestore(cwd) {
  try {
    const p = join(cwd, RESTORE_REL);
    const txt = readFileSync(p, "utf-8");
    const m = /^<!-- cc-deck:restore sid=([^ ]+) ts=(\d+) -->/.exec(txt.split(/\r?\n/, 1)[0] || "");
    if (!m) return null;
    return { path: p, sid: m[1], ts: Number(m[2]) || 0, text: txt };
  } catch {
    return null;
  }
}

export function writeRestore(cwd, sid, tasks) {
  try {
    const lines = tasks
      .slice(0, 20)
      .map((t) => `- #${t.id} ${t.subject}${t.status === "in_progress" ? "（进行中）" : ""}`);
    const more = tasks.length > 20 ? `\n…另有 ${tasks.length - 20} 条` : "";
    const body =
      `<!-- cc-deck:restore sid=${sid} ts=${Date.now()} -->\n` +
      `# CC Deck 恢复点\n\n` +
      `${new Date().toLocaleString()} 收工时仍有 ${tasks.length} 条未完成任务：\n\n` +
      `${lines.join("\n")}${more}\n\n` +
      `接续提示：下次会话开工前把上述条目 TaskCreate 重建进任务清单（或让模型读本文件）。\n`;
    mkdirSync(join(cwd, ".cc-deck"), { recursive: true });
    writeFileSync(join(cwd, RESTORE_REL), body, "utf-8");
  } catch {}
}

// 恢复点是否值得注入：非本会话写入、24h 内、仍新鲜
export function restoreInjectable(st, sid) {
  return !!st && st.sid !== sid && Date.now() - st.ts < RESTORE_FRESH_MS;
}

export function removeRestore(cwd) {
  try {
    const p = join(cwd, RESTORE_REL);
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

// ---------- 60s 二次放行窗口（Stop 拦截用，同全局蓝本；存数据目录不动 ~/.claude） ----------
const PASS_DIR = join(dataDir, "guard-pass");
const PASS_WINDOW_MS = 60_000;

// 返回 true = 60s 窗口内的第二次停止，应放行（并清掉时间戳）
export function consumePassWindow(sid) {
  try {
    const f = join(PASS_DIR, sid + ".ts");
    if (existsSync(f)) {
      const age = Date.now() - statSync(f).mtimeMs;
      if (age < PASS_WINDOW_MS) {
        unlinkSync(f);
        return true;
      }
    }
    mkdirSync(PASS_DIR, { recursive: true });
    writeFileSync(f, String(Date.now()));
    return false;
  } catch {
    return true; // 写不进时 fail-open：宁可漏拦一次，不能把会话永久卡死
  }
}

// 无可执行待办时清残留时间戳，防下次 60s 窗口误放行一次
export function clearPassWindow(sid) {
  try {
    const f = join(PASS_DIR, sid + ".ts");
    if (existsSync(f)) unlinkSync(f);
  } catch {}
}
