import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionNotificationWatcher } from "../src/decision-notify.js";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import type { OrgConfirm } from "../src/projects.js";
import type { SessionState } from "../src/types.js";

let pass = 0;
let fail = 0;
const assert = (condition: boolean, name: string): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
};

const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-decision-notify-"));
const ledgerPath = join(dataDir, "ledger.json");
const t0 = 1_800_000_000_000;
const source: SessionState = {
  session_id: "session-source",
  relay_session_id: "cli-source",
  cwd: dataDir,
  initial_prompt: "test",
  title: "cc-deck",
  model: "test",
  status: "WORKING",
  action_summary: "",
  started_at: t0,
  updated_at: t0,
  stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
};
const waiting: SessionState = {
  ...source,
  session_id: "session-waiting",
  status: "WAITING",
  waiting_started_at: t0,
  waiting_request: {
    request_id: "waiting-1",
    tool_name: "Bash",
    input_summary: "敏感命令不应进入通知正文",
    suggestions: [],
    decidable: true,
  },
};
const confirm = (id: string, status: OrgConfirm["status"] = "pending"): OrgConfirm => ({
  id,
  kind: "project-create",
  title: "cc-deck",
  reason: "需要人类确认项目立项",
  payload: { session_id: source.session_id },
  status,
  created_at: t0,
  ...(status !== "pending" ? { decided_at: t0 + 1 } : {}),
});

try {
  let confirms: OrgConfirm[] = [confirm("cf-1")];
  let sessions: SessionState[] = [source];
  const notes: { sessionId: string; text: string }[] = [];
  const options = {
    ledgerPath,
    listConfirms: () => confirms,
    snapshotSessions: () => sessions,
    leaderSessionId: () => source.session_id,
    notify: (sessionId: string, text: string) => { notes.push({ sessionId, text }); return true; },
    now: () => t0,
    remindHours: 1,
  };

  console.log("org confirm 首通知与去重:");
  const watcher = new DecisionNotificationWatcher(options);
  watcher.scan(t0);
  watcher.scan(t0 + 60_000);
  assert(notes.length === 1, "pending confirm 首通知一次，重复扫描不重推");
  assert(notes[0]?.text.startsWith("[拍板]"), "confirm 通知带拍板前缀");
  assert(!notes[0]?.text.includes("敏感命令"), "confirm 通知不带无关敏感内容");

  console.log("ledger 重启恢复与二次提醒:");
  const restarted = new DecisionNotificationWatcher(options);
  restarted.scan(t0 + 10 * 60_000);
  assert(notes.length === 1, "重启加载 ledger 后不重复首通知");
  restarted.scan(t0 + 3_600_001);
  restarted.scan(t0 + 7_200_001);
  assert(notes.length === 2, "24 小时配置换算为一次二次提醒");
  assert(restarted.snapshotLedger().filter((x) => x.reminded_at).length === 1, "二次提醒最多一条 ledger 记录");

  console.log("resolved 收口:");
  confirms = [confirm("cf-1", "approved")];
  restarted.scan(t0 + 8_000_000);
  const resolved = restarted.snapshotLedger().find((x) => x.key.startsWith("org-confirm:cf-1:"));
  assert(!!resolved?.resolved_at, "confirm 决议后写 resolved_at");
  restarted.scan(t0 + 100 * 3_600_000);
  assert(notes.length === 2, "resolved confirm 停止后续提醒");

  console.log("WAITING 超时与实例去重:");
  confirms = [];
  sessions = [waiting];
  const waitingWatcher = new DecisionNotificationWatcher({
    ...options,
    remindHours: 0,
  });
  waitingWatcher.scan(t0 + 9 * 60_000);
  assert(notes.length === 2, "10 分钟前 WAITING 不通知");
  waitingWatcher.scan(t0 + 10 * 60_000);
  assert(notes.length === 3 && notes.at(-1)?.sessionId === "session-waiting", "allow 型 WAITING 超时后通知归属当前会话");
  waitingWatcher.scan(t0 + 11 * 60_000);
  assert(notes.length === 3, "同一 waiting instance 不重复通知");
  sessions = [{ ...waiting, status: "WORKING", waiting_request: undefined, waiting_started_at: undefined }];
  waitingWatcher.scan(t0 + 12 * 60_000);
  assert(!!waitingWatcher.snapshotLedger().find((x) => x.key === "waiting:session-waiting:waiting-1")?.resolved_at, "WAITING 结束后收口 resolved_at");
  sessions = [{ ...waiting, waiting_request: { ...waiting.waiting_request!, request_id: "waiting-2" }, waiting_started_at: t0 + 20 * 60_000 }];
  waitingWatcher.scan(t0 + 29 * 60_000);
  assert(notes.length === 3, "新的 waiting instance 重新计时，不复用旧通知");
  waitingWatcher.scan(t0 + 30 * 60_000 + 1);
  assert(notes.length === 4, "新的 waiting instance 可独立触发");

  console.log("关闭自动 watcher 与手动通知:");
  const silent = new DecisionNotificationWatcher({ ...options, enabled: false });
  confirms = [confirm("cf-silent")];
  sessions = [source];
  silent.scan(t0);
  assert(!notes.some((n) => n.text.includes("cf-silent")), "CCR_DECISION_NOTIFY=0 语义下自动 watcher 静默");

  const prevData = process.env.CCR_DATA_DIR;
  const prevNotify = process.env.CCR_DECISION_NOTIFY;
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_DECISION_NOTIFY = "0";
  const bus = new EventBus();
  const mgr = new SessionManager(bus, loadConfig());
  mgr.ensureExternal("ext-manual", dataDir, "manual");
  const userNotes: unknown[] = [];
  bus.subscribe((event) => { if (event.type === "USER_NOTE") userNotes.push(event.payload); });
  assert(mgr.notifyConfirm("ext-manual", "手动 API 通知"), "手动通知入口仍可落卡");
  assert(userNotes.length === 1, "手动通知仍发送 USER_NOTE，不受自动开关影响");
  if (prevData === undefined) delete process.env.CCR_DATA_DIR; else process.env.CCR_DATA_DIR = prevData;
  if (prevNotify === undefined) delete process.env.CCR_DECISION_NOTIFY; else process.env.CCR_DECISION_NOTIFY = prevNotify;

  const persisted = JSON.parse(readFileSync(ledgerPath, "utf-8")) as unknown;
  assert(Array.isArray(persisted), "ledger 以全量数组写穿");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
