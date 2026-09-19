// #75 无人值守自动拉起专项（纯单元）：relay 重启收养后，任务存储里有未完成
// 待办（pending/in_progress）的托管会话被 resume 拉起并注入续跑指令；无待办/
// 外部会话/无 resume 锚点/开关关闭的都不拉。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { ReplayedSession } from "../src/history.js";
import type { AgentLike } from "../src/agent-adapter.js";

const ROOT = fileURLToPath(new URL("../data/test-autorevive/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };

// 任务存储夹具（真实 ~/.claude/tasks/<sid>/，测试专用假 sid，用完即删）
const TASKS = join(homedir(), ".claude", "tasks");
const SID_BUSY = "autorevive-test-busy-cli";
const SID_IDLE = "autorevive-test-idle-cli";
function putTodo(cliSid: string, file: string, todo: Record<string, unknown>): void {
  const d = join(TASKS, cliSid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), JSON.stringify(todo));
}
putTodo(SID_BUSY, "1.json", { id: 1, subject: "在干活", status: "in_progress" });
putTodo(SID_BUSY, "2.json", { id: 2, subject: "排队中", status: "pending" });
putTodo(SID_IDLE, "1.json", { id: 1, subject: "已完结", status: "completed" });

const mgr = new SessionManager(new EventBus(), loadConfig());
const resumes: { resume?: string; text: string }[] = [];
mgr.setAgentFactory((_cwd, _model, _cb, initialPrompt, opts) => {
  resumes.push({ resume: opts?.resume, text: initialPrompt ?? "" });
  const agent: AgentLike = {
    id: `fake-${resumes.length}`, startedAt: Date.now(), ended: false,
    sendMessage() {}, allow: () => false, deny: () => false, answer: () => false,
    stop: async () => {}, setPermissionMode: async () => {},
  };
  return agent;
});

const mk = (sid: string, cliSid: string, external: boolean, updated: number): [string, ReplayedSession] => [
  sid,
  {
    state: {
      session_id: sid, relay_session_id: cliSid, cwd: "/tmp/p", initial_prompt: "x",
      title: sid, model: "glm-5.3", status: "DONE", action_summary: "（历史）",
      started_at: updated, updated_at: updated,
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      ...(external ? { external: true } : {}),
    },
    logs: [],
  } as ReplayedSession,
];
mgr.adopt(new Map([
  mk("m-busy", SID_BUSY, false, Date.now()),
  mk("m-idle", SID_IDLE, false, Date.now() - 1000),
  mk("ext-1", SID_BUSY, true, Date.now()),  // 外部会话：即使任务存储有待办也不拉
  mk("m-noanchor", "", false, Date.now()),  // 无 resume 锚点（首回合未完成即断）
]));

const n = mgr.autoReviveManaged();
assert(n === 1, `只拉起有未完成待办的托管会话 got=${n}`);
assert(resumes.length === 1 && resumes[0]!.resume === SID_BUSY, `resume 指向任务存储命中的 cli_sid got=${JSON.stringify(resumes.map((r) => r.resume))}`);
assert(resumes[0]!.text.includes("自动恢复"), "注入续跑指令");
{
  const st = mgr.snapshot().find((s) => s.session_id === "m-busy")!;
  assert(st.status === "WORKING" && !st.historical, "被拉起会话翻 WORKING、摘 historical");
}
process.env.CCR_NO_AUTOREVIVE = "1";
assert(mgr.autoReviveManaged() === 0, "CCR_NO_AUTOREVIVE=1 逃生阀生效");
process.env.CCR_NO_AUTOREVIVE = "";

rmSync(join(TASKS, SID_BUSY), { recursive: true, force: true });
rmSync(join(TASKS, SID_IDLE), { recursive: true, force: true });
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nAUTOREVIVE TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
