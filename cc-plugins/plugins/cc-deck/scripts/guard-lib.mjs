#!/usr/bin/env node
// CC Deck 插件 · 任务调度守卫公共库（guard-stop / guard-context 共用）。
// 三类共享能力：
//  1) 配置：~/.cc-deck/config.json 的 taskGuard/qNotify/restorePoint/deliverables 四键
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

// #71 第四键 deliverables（输出物看板开关，#107 默认改开——与 relay 侧 ws-server
// readPluginConfig 同步反转；已显式写 false 的用户不受影响，readConfig 的 typeof 守卫
// 只在键存在时覆盖）：开=guard-context 注入投递约定
// + deliver 脚本落位 ~/.cc-deck/bin/；三键集合须与 ws-server PLUGIN_CFG_KEYS 同步
export const CONFIG_KEYS = ["taskGuard", "qNotify", "restorePoint", "deliverables"];
export const CONFIG_DEFAULTS = { taskGuard: false, qNotify: true, restorePoint: false, deliverables: true };

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

// 全量任务（含已完成/豁免/blocked，原始字段）：生命周期守卫要算"完成后解锁了谁"、
// 检测多任务并行悬挂等，需要比 readTasks 更宽的视图；过滤逻辑由调用方自定
export function readAllTasks(sid) {
  const dir = join(home, ".claude", "tasks", sid);
  const all = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (t.status === "deleted") continue;
        all.push({ ...t, id: t.id ?? f.replace(/\.json$/, "") });
      } catch {}
    }
  } catch {}
  return all;
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

// ---------- #203 输出物兜底账本（deliver-guard 记账 / deliver-stop 收工对账） ----------
// 会话级「写过哪些文档类文件」清单：deliver-guard 在 PostToolUse(Write|Edit) 随手
// 记，deliver-stop 在 Stop 时对账（写过 × 看板零登记 → 拦一次提醒自查）。p=已记
// 路径，a=已提醒过且 AI 判定非交付物（二停放行时盖章）——同批文件只提醒一轮，
// 后续轮次只追新增文件，防每轮 Stop 反复唠叨。旧版纯数组格式读入兼容。
export const DELIVER_WATCH_DIR = join(dataDir, "deliver-watch");
const WATCH_STALE_MS = 7 * 24 * 3600_000; // 账本兜底清理（会话崩溃/未走 Stop 的残留）
const WATCH_CAP = 40;

function watchFile(sid) { return join(DELIVER_WATCH_DIR, sid + ".json"); }

function readWatchObj(sid) {
  try {
    const raw = JSON.parse(readFileSync(watchFile(sid), "utf-8"));
    const strs = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "string") : []);
    if (Array.isArray(raw)) return { p: strs(raw), a: [] };
    return { p: strs(raw?.p), a: strs(raw?.a) };
  } catch {
    return { p: [], a: [] };
  }
}

// 记一笔文档类写入（deliver-guard 调）：去重、封顶 WATCH_CAP、顺手清 >7 天陈旧
// 账本。排除三类路径：~/.cc-deck 树（产物目录自动收录 + 内部数据）、node_modules/
// .git 段、隐藏目录段（.claude 等配置形态，非交付物）。任何异常静默。
export function recordDeliverWatch(sid, p) {
  try {
    if (!sid || typeof p !== "string" || p === "") return;
    const seg = p.split(/[\\/]/);
    if (seg.includes("node_modules") || seg.includes(".git")) return;
    const deckPrefix = deckDir + "/";
    if (p === deckDir || p.startsWith(deckPrefix) || p.startsWith(deckDir + "\\")) return;
    if (seg.slice(0, -1).some((s) => s.length > 1 && s.startsWith("."))) return;
    mkdirSync(DELIVER_WATCH_DIR, { recursive: true });
    // 陈旧账本兜底清理（崩溃会话残留；目录内 = 近期会话数，量小）
    try {
      for (const f of readdirSync(DELIVER_WATCH_DIR)) {
        const fp = join(DELIVER_WATCH_DIR, f);
        if (Date.now() - statSync(fp).mtimeMs > WATCH_STALE_MS) unlinkSync(fp);
      }
    } catch {}
    const o = readWatchObj(sid);
    if (!o.p.includes(p)) {
      o.p.push(p);
      if (o.p.length > WATCH_CAP) o.p = o.p.slice(-WATCH_CAP);
      writeFileSync(watchFile(sid), JSON.stringify(o));
    }
  } catch {}
}

// 待提醒文件（已记 − 已盖章；存在性过滤由调用方做）
export function pendingDeliverWatch(sid) {
  const o = readWatchObj(sid);
  const acked = new Set(o.a);
  return o.p.filter((p) => !acked.has(p));
}

// 二停放行时盖章：这批文件本轮已提醒过、AI 判非交付物，后续不再唠叨
export function ackDeliverWatch(sid, paths) {
  try {
    const o = readWatchObj(sid);
    o.a = [...new Set([...o.a, ...paths])];
    if (o.a.length > WATCH_CAP) o.a = o.a.slice(-WATCH_CAP);
    writeFileSync(watchFile(sid), JSON.stringify(o));
  } catch {}
}

// 会话收 clean：看板已有登记/账本清空时整本删除（连同 pass 窗口残留）
export function clearDeliverWatch(sid) {
  try {
    const f = watchFile(sid);
    if (existsSync(f)) unlinkSync(f);
    const pf = join(DELIVER_WATCH_DIR, sid + ".pass");
    if (existsSync(pf)) unlinkSync(pf);
  } catch {}
}

// deliver-stop 专属 60s 二次放行窗口（独立于 guard-pass：两个 Stop hook 并挂时
// 共享同一窗口文件会互删误拦——各自消费各自的）。写不进时 fail-open 放行。
const DELIVER_PASS_MS = 60_000;
export function consumeDeliverPassWindow(sid) {
  try {
    const f = join(DELIVER_WATCH_DIR, sid + ".pass");
    if (existsSync(f)) {
      const age = Date.now() - statSync(f).mtimeMs;
      if (age < DELIVER_PASS_MS) {
        unlinkSync(f);
        return true;
      }
    }
    mkdirSync(DELIVER_WATCH_DIR, { recursive: true });
    writeFileSync(f, String(Date.now()));
    return false;
  } catch {
    return true;
  }
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
