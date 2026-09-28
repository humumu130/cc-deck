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
// M3 扩展：在 mk 基础上附加团队态字段（org_parked/project_gid）
const mk2 = (sid: string, cliSid: string, external: boolean, updated: number, extra: Record<string, unknown>): [string, ReplayedSession] => [
  sid,
  { state: { ...mk(sid, cliSid, external, updated)[1].state, ...extra }, logs: [] } as unknown as ReplayedSession,
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

// #26 M3 审查修正：挂起退休成员不自动拉起（组挂起=编制退休释放；org_parked 内存
// 态 + project_gid 组状态双保险——重启后标记丢了也能按组状态兜住）
const ORG = join(ROOT, "orgdir");
mkdirSync(ORG, { recursive: true });
process.env.CCR_ORG_DIR = ORG;
const SID_PARKED = "autorevive-test-parked-cli";
const SID_GP = "autorevive-test-gp-cli";
const SID_AR = "autorevive-test-archived-cli";
putTodo(SID_PARKED, "1.json", { id: 1, subject: "挂起组在跑活", status: "in_progress" });
putTodo(SID_GP, "1.json", { id: 1, subject: "丢标成员在跑活", status: "in_progress" });
putTodo(SID_AR, "1.json", { id: 1, subject: "结项组残留待办", status: "in_progress" });
writeFileSync(
  join(ORG, "projects.json"),
  JSON.stringify({
    groups: [{
      id: "g-parked", name: "挂起组", anchor_dir: "/tmp/anchor-g", status: "parked", tier: "正经立项",
      headcount: [{ session_id: "m-gp", role: "worker" }], single_card: false,
      created_at: Date.now(), updated_at: Date.now(), parked_at: Date.now(),
    }, {
      // M1/M2 审查轮补：结项组（编制解散）成员同样不自动拉起——组状态非 active 双保险的另一臂
      id: "g-archived", name: "结项组", anchor_dir: "/tmp/anchor-ar", status: "archived", tier: "正经立项",
      headcount: [{ session_id: "m-ar", role: "worker" }], single_card: false,
      created_at: Date.now(), updated_at: Date.now(), archived_at: Date.now(),
    }],
    trust_light: false,
  }),
);
mgr.adopt(new Map([
  // ① org_parked 显式在册（挂起联动直接置标）② 重启丢标态：只有 project_gid，
  // 组状态在盘上是 parked（rehydrateParkedMembers 重建前的裸收养形态）
  mk2("m-parked", SID_PARKED, false, Date.now(), { org_parked: "g-parked" }),
  mk2("m-gp", SID_GP, false, Date.now(), { project_gid: "g-parked" }),
  mk2("m-ar", SID_AR, false, Date.now(), { project_gid: "g-archived" }),
]));
const n2 = mgr.autoReviveManaged();
assert(n2 === 0, `挂起退休成员不自动拉起（标记/组状态双保险）got=${n2}`);
assert(resumes.length === 1, "无新增 resume（挂起成员零拉起）");
assert(mgr.snapshot().find((s) => s.session_id === "m-ar")?.status !== "WORKING", "结项组成员同样不自动拉起（编制已解散）");
const rehy = mgr.rehydrateParkedMembers();
assert(rehy === 1 && mgr.snapshot().find((s) => s.session_id === "m-gp")?.org_parked === "g-parked",
  `重启重建挂起标记（按组状态反推补标）got=${rehy}`);
assert(mgr.snapshot().find((s) => s.session_id === "m-parked")?.org_parked === "g-parked", "已有标记不重复处理");
const n3 = mgr.autoReviveManaged();
assert(n3 === 0, `rehydrate 后仍不拉起（豁免闭环）got=${n3}`);

// #26 补章审查修正（A/B 双报）：退休成员（member-retire 编制除名，只剩路由档案）
// 不自动拉起——retired 档清了 org_parked/project_gid，上面双保险全绕过，须按
//「路由记录在册但不在该组编制」的除名痕迹独立判定；从甲组退休但仍是乙组现役的
// 不拦（跨组正交：他组在办成员的待办值得续）。沿用同一 org 盘（挂起/结项组态
// 保留，防换盘后旧成员守卫失据）
const SID_RET = "autorevive-test-retired-cli";
const SID_CUR = "autorevive-test-current-cli";
const SID_X2 = "autorevive-test-xgroup-cli";
putTodo(SID_RET, "1.json", { id: 1, subject: "退休时残留活", status: "in_progress" });
putTodo(SID_CUR, "1.json", { id: 1, subject: "现役成员在跑活", status: "in_progress" });
putTodo(SID_X2, "1.json", { id: 1, subject: "他组现役在跑活", status: "in_progress" });
writeFileSync(
  join(ORG, "projects.json"),
  JSON.stringify({
    groups: [{
      id: "g-parked", name: "挂起组", anchor_dir: "/tmp/anchor-g", status: "parked", tier: "正经立项",
      headcount: [{ session_id: "m-gp", role: "worker" }], single_card: false,
      created_at: 1, updated_at: 1, parked_at: 1,
    }, {
      id: "g-archived", name: "结项组", anchor_dir: "/tmp/anchor-ar", status: "archived", tier: "正经立项",
      headcount: [{ session_id: "m-ar", role: "worker" }], single_card: false,
      created_at: 1, updated_at: 1, archived_at: 1,
    }, {
      id: "g-a", name: "甲组", anchor_dir: "/tmp/anchor-a", status: "active", tier: "正经立项",
      headcount: [{ session_id: "m-cur", role: "worker" }], single_card: false, created_at: 1, updated_at: 1,
    }, {
      id: "g-b", name: "乙组", anchor_dir: "/tmp/anchor-b", status: "active", tier: "正经立项",
      headcount: [{ session_id: "m-x2", role: "worker" }], single_card: false, created_at: 1, updated_at: 1,
    }],
    trust_light: false,
  }),
);
writeFileSync(
  join(ORG, "routing.json"),
  JSON.stringify({
    // m-ret 曾为甲组干活后被 member-retire 除名（有档案无编制=退休痕迹）；m-x2 对
    // 甲组同形（从甲组退休）但仍是乙组现役
    entries: [
      { gid: "g-a", session_id: "m-ret", count: 2, failed: 0, last_ts: 1, tags: [] },
      { gid: "g-a", session_id: "m-cur", count: 1, failed: 0, last_ts: 1, tags: [] },
      { gid: "g-a", session_id: "m-x2", count: 1, failed: 0, last_ts: 1, tags: [] },
      { gid: "g-b", session_id: "m-x2", count: 1, failed: 0, last_ts: 1, tags: [] },
    ],
  }),
);
mgr.adopt(new Map([
  mk("m-ret", SID_RET, false, Date.now()),
  mk("m-cur", SID_CUR, false, Date.now()),
  mk("m-x2", SID_X2, false, Date.now()),
]));
const n4 = mgr.autoReviveManaged();
assert(n4 === 2, `退休成员不拉起、现役/他组现役照常拉起 got=${n4}`);
assert(mgr.snapshot().find((s) => s.session_id === "m-ret")?.status !== "WORKING", "退休成员保持 DONE（编制除名，档案留在路由表）");
assert(mgr.snapshot().find((s) => s.session_id === "m-cur")?.status === "WORKING", "现役成员照常拉起（判定不过宽）");
assert(mgr.snapshot().find((s) => s.session_id === "m-x2")?.status === "WORKING", "从甲组退休但乙组现役 → 照常拉起（跨组正交）");
delete process.env.CCR_ORG_DIR;

// #17 雇员独立家审查修正（P1-1 回归锁）：autoRevive 的任务存储读取必须按会话
// 家寻址——此口漏传 base 则开关开启后雇员（Leader/worker，带 pending 待办的
// 主力人群）重启后永不自动恢复；且拉起的 resume 须同样注入 configHome
{
  const EMP = join(ROOT, "emp-home");
  const cfg17 = loadConfig();
  cfg17.employeeConfigDir = EMP;
  const mgr17 = new SessionManager(new EventBus(), cfg17);
  const resumes17: { resume?: string; configHome?: string }[] = [];
  mgr17.setAgentFactory((_c, _m, _cb, _p, opts) => {
    resumes17.push({ resume: opts?.resume, configHome: opts?.configHome });
    return {
      id: "fake-ar17", startedAt: Date.now(), ended: false,
      sendMessage() {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => {}, setPermissionMode: async () => {},
    };
  });
  const SID_EMP = "autorevive-test-emp-cli";
  const SID_EMP2 = "autorevive-test-emp2-cli";
  // 雇员待办写独立家 tasks/；对照 sid 的待办只写默认家（换家前遗留形态）
  mkdirSync(join(EMP, "tasks", SID_EMP), { recursive: true });
  writeFileSync(join(EMP, "tasks", SID_EMP, "1.json"), JSON.stringify({ id: 1, subject: "雇员的活", status: "in_progress" }));
  putTodo(SID_EMP2, "1.json", { id: 1, subject: "默认家的遗留活", status: "in_progress" });
  mgr17.adopt(new Map([
    mk2("m-emp", SID_EMP, false, Date.now(), { employee: true }),
    mk2("m-emp2", SID_EMP2, false, Date.now(), { employee: true }),
  ]));
  const n17 = mgr17.autoReviveManaged();
  assert(n17 === 1 && resumes17.length === 1 && resumes17[0]!.resume === SID_EMP,
    `雇员待办在独立家 → 按家命中并拉起 got=${n17}/${JSON.stringify(resumes17.map((r) => r.resume))}`);
  assert(resumes17[0]!.configHome === EMP, "拉起的 resume 注入 configHome=独立家（spawn 口同规则）");
  assert(mgr17.snapshot().find((s) => s.session_id === "m-emp2")?.status !== "WORKING",
    "待办只在默认家的雇员不被误拉（读家按身份×开关，不回退默认家）");
  rmSync(join(TASKS, SID_EMP2), { recursive: true, force: true });
}

rmSync(join(TASKS, SID_BUSY), { recursive: true, force: true });
rmSync(join(TASKS, SID_IDLE), { recursive: true, force: true });
rmSync(join(TASKS, SID_PARKED), { recursive: true, force: true });
rmSync(join(TASKS, SID_GP), { recursive: true, force: true });
rmSync(join(TASKS, SID_AR), { recursive: true, force: true });
rmSync(join(TASKS, SID_RET), { recursive: true, force: true });
rmSync(join(TASKS, SID_CUR), { recursive: true, force: true });
rmSync(join(TASKS, SID_X2), { recursive: true, force: true });
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nAUTOREVIVE TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
