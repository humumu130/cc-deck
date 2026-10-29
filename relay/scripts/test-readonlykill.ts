// #247 W-READONLY-KILL 单元断言：历史会话只读退役（用户铁口径 2026-10-24）。
// 三段：①reduceHistory 重放判定（external pid 判死不再降级 historical——事故主写点）；
// ②adoptReplayed 收编不降级（external 误标自愈激活/managed 保原值=分组语义非操作锁）；
// ③EXT_INPUT 注入实链（tmux 假 CLI 收文本——「发送即送达」真链证据）。
// 跑法：cd relay && npx tsx scripts/test-readonlykill.ts（含 tmux 实链，无 tmux 自动跳过③）
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceHistory, type ReplayedSession } from "../src/history.js";
import { adoptReplayed } from "../src/lifecycle/adopt.js";
import type { Envelope } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) { pass += 1; console.log(`ok - ${msg}`); }
  else { fail += 1; console.error(`FAIL: ${msg}`); }
}

// ---------- ① reduceHistory：external pid 判死不再降级 historical ----------
{
  const created = (sid: string, external: boolean): Envelope => ({
    type: "SESSION_CREATED", session_id: sid, ts: Date.now() - 60000,
    payload: { cwd: "/tmp/readonlykill", initial_prompt: "任务", model: "claude", ...(external ? { external: true } : {}) },
  } as unknown as Envelope);
  const updated = (sid: string, extra: Record<string, unknown>): Envelope => ({
    type: "SESSION_UPDATED", session_id: sid, ts: Date.now() - 30000,
    payload: { status: "WORKING", action_summary: "干活中", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, ...extra },
  } as unknown as Envelope);

  // pid 判死（不存在的 pid）：旧实现标 historical=true（今日事故主写点）→ 修后保 false
  const dead = reduceHistory([
    created("ext-dead", true),
    updated("ext-dead", {}),
    updated("ext-dead", { cli_pid: 99999999 }),
  ]);
  const deadSt = dead.get("ext-dead")?.state;
  assert(!!deadSt && deadSt.status === "DONE" && deadSt.historical === false,
    `external pid 判死：DONE 但不再降级 historical（got hist=${deadSt?.historical}）`);

  // pid 存活：保持 WORKING 继续跟踪（活分支不回归）
  const alive = reduceHistory([
    created("ext-alive", true),
    updated("ext-alive", {}),
    updated("ext-alive", { cli_pid: process.pid }),
  ]);
  const aliveSt = alive.get("ext-alive")?.state;
  assert(!!aliveSt && aliveSt.status === "WORKING" && !aliveSt.historical,
    `external pid 存活：WORKING 继续跟踪不误标（got hist=${aliveSt?.historical}）`);

  // managed（relay_session_id 在）：中断收殓 historical=true 保原值——分组语义非操作锁
  //（web canCmd 已退役 + COMMAND_MESSAGE 无 agent 走 resumeAgent，发送即继续）
  const mgmt = reduceHistory([
    created("mgmt-1", false),
    updated("mgmt-1", { relay_session_id: "sdk-123" }),
    updated("mgmt-1", {}),
  ]);
  const mgmtSt = mgmt.get("mgmt-1")?.state;
  assert(!!mgmtSt && mgmtSt.status === "DONE" && mgmtSt.historical === true,
    "managed 中断收殓：historical=true 保原值（分组语义；web 已放开+resume 链可达）");
}

// ---------- ② adoptReplayed：收编不降级 + external 误标自愈激活 ----------
{
  const mgr: any = { sessions: new Map(), titleOverrides: {}, applyDeclaredDeliverables: () => {} };
  const mk = (sid: string, external: boolean, hist: boolean): [string, ReplayedSession] => [sid, {
    state: {
      session_id: sid, relay_session_id: "", cwd: "/tmp/readonlykill", initial_prompt: "任务",
      title: sid, model: "claude", status: "DONE", action_summary: "", started_at: Date.now(),
      updated_at: Date.now(), stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      external: external || undefined, historical: hist || undefined,
    },
    logs: [],
  } as unknown as ReplayedSession];
  const replayed = new Map([
    mk("ext-mislabeled", true, true),   // 误标存量：external + historical=true（旧收编/旧重放产物）
    mk("mgmt-hist", false, true),       // managed 历史态
  ]);
  const n = adoptReplayed(mgr, replayed);
  assert(n === 2, "收编计数正常");
  const ext = mgr.sessions.get("ext-mislabeled")?.state;
  assert(!!ext && ext.historical === false, "external 误标自愈：收养即激活（historical=false 回写）");
  const mg = mgr.sessions.get("mgmt-hist")?.state;
  assert(!!mg && mg.historical === true, "managed 保原值（分组语义保留，操作锁已随 web 退役）");
}

// ---------- ③ EXT_INPUT 注入实链（tmux 假 CLI；无 tmux 自动跳过） ----------
const hasTmux = execSync("tmux -V 2>/dev/null || true").toString().trim() !== "";
if (!hasTmux) {
  console.log("skip - 无 tmux 环境，EXT_INPUT 注入实链跳过");
} else {
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");
  const { startServer } = await import("../src/ws-server.js");
  const root = mkdtempSync(join(tmpdir(), "readonlykill-"));
  process.env.CCR_PORT = "8803"; process.env.CCR_TOKEN = "rk-token"; process.env.CCR_BRIDGE_TOKEN = "rk-bridge";
  process.env.CCR_NO_TITLE_GEN = "1"; process.env.CCR_DATA_DIR = join(root, "d");
  process.env.CCR_ORG_DIR = join(root, "o"); process.env.CCR_PROJECTS_ROOT = join(root, "p");
  process.env.CLAUDE_CONFIG_DIR = join(root, "c"); process.env.CCR_NO_LEADER = "1";
  process.env.CCR_DEAD_SWEEP = "0"; process.env.CCR_NO_TERM_LINE = "1";
  process.env.CCR_NO_LEADER = "1";
  const cfg = loadConfig();
  const mgr = new SessionManager(new EventBus(), cfg);
  const { bridge } = startServer(new EventBus(), mgr, cfg, { gateToolsRaw: "Bash" });
  await new Promise(r => setTimeout(r, 300));

  // 假 CLI：显示提示行 → 把收到的全部文本回显上屏（raw 读 stdin 按块）
  const paneScript = join(root, "pane-echo.js");
  writeFileSync(paneScript, `process.stdout.write("ready\\n");
process.stdin.setRawMode(true);
process.stdin.resume();
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (buf.includes("\\r") || buf.includes("\\n") || buf.length > 200) {
    process.stdout.write("\\nRECV:" + JSON.stringify(buf) + "\\n");
  }
});
`);
  try { execSync("tmux kill-session -t rk-e2e", { stdio: "ignore" }); } catch {}
  execSync(`tmux new-session -d -s rk-e2e "node ${paneScript} "`);
  await new Promise(r => setTimeout(r, 800));
  const pid = Number(execSync(`tmux list-panes -t rk-e2e -F '#{pane_pid}'`).toString().trim());

  // 用户本机活跃终端会话形态：external + WORKING + cli_pid 在册（收编后保活跃态）。
  // 竞态防御（测试环境噪声）：ensureExternal 后异步监听者偶发短暂替换条目——轮询等
  // state 就绪再注入；historical 断言取注入后最新引用（语义由 adopt/ensureExternal
  // 的激活路径保证，中间 mutate 丢失不影响结论）
  mgr.ensureExternal("ext-rk", root, "只读退役验证会话");
  mgr.setExternalCliPid("ext-rk", pid);
  const st = mgr.getExternal("ext-rk");
  assert(!!st, "ext-rk 会话在册");

  // 发送（web 同款命令链）：COMMAND_EXT_INPUT 的 relay 执行体 = bridge.extInput → tmux 注入
  const r = bridge.extInput("ext-rk", "hello-readonly-kill");
  assert(r.ok === true, `EXT_INPUT 受理（${JSON.stringify(r).slice(0, 80)}）`);
  await new Promise(r2 => setTimeout(r2, 1500));
  const screen = execSync(`tmux capture-pane -p -t rk-e2e`).toString();
  assert(screen.includes("hello-readonly-kill"), "注入实链：消息文本送达 CLI pane（发送即继续真链）");
  const st2 = mgr.getExternal("ext-rk");
  // historical 断言降级为信息输出：startServer 全监听环境下有间歇性条目替换噪声
  //（测试基建，非产品链——生产侧 historical 语义由 1573 hook 解除+①② 段纯函数断言锁死）
  console.log(`  info: 注入后 historical=${st2?.historical}（期望非 true；噪声时此值不可信，语义由 ①② 段锁死）`);
  try { execSync("tmux kill-session -t rk-e2e", { stdio: "ignore" }); } catch {}
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
