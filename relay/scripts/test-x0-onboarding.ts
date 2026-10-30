// X0 建队完善批（PRD v0.3 §4.6/§4.7）——七件全链测试：
//   件1 装配探测：被动观测缓存（external subagent kinds ∪ managed 活动工具名并集，
//        1h TTL）+ 无数据明确报错拒单（不静默降级）+ skills 零命中降级跳席+台账记因
//        + CCR_X0_PROBE=0 逃生门 + TTL 过期归 null。
//   件2 org join：自荐入编 → member-join 待确认卡（不直接入编，防任意混入）→
//        用户 ✓ → seatGate 同口径入编；无 cwd 命中/未知组拒收。
//   件3 可发现性三件套：org CLAUDE.md 入队指引段（幂等种子+旧文件升级追加）+
//        用户家广播段沙盒不触碰 + 面板复制入队指令键静态锚（HTML/JS/CSS）。
//   件4 AGENT_TEAMS 协助：check 探测（含 env 开启态）+ on 一键写入（沙盒镜像
//        agent-teams-settings.json，绝不碰用户家）。
//   件5 log-append：台账 manual done 行 + cwd 组锚归属（project-detail receipts
//        即团队域活动 tab 数据源——归属行可见、无归属行不误挂）。
//   件6 PM claim+自动迁移：leader 模式拒收 + no-leader claim 接管（dutyTargetId
//        override 消费）+ 死 pid 自动清档回落（自动转活 PM）+ 全空置空。
//   件7 dispatch.md 预检节 R3 三问（静态锚）。
// 隔离口径：CCR_ORG_DIR/CCR_STORAGE_READ_MODE=json/CCR_NO_TITLE_GEN 三钉
//（test-dispatch 同缝）；全程不触生产 ~/.cc-deck 与用户家。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog, ensureOrgClaudeMd, ORG_CLAUDE_MD_X0_MARKER, readPmOverride, setPmOverride } from "../src/org.js";
import { createGroup, listGroups, listPendingConfirms, setLightConfirmTrusted, setGroupStatus } from "../src/projects.js";
import { routingFor } from "../src/routing.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", ".."); // relay/scripts → 仓根（静态锚读 web-console/.claude）
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// fake agent 工厂（test-dispatch 同款）：init 20ms / prompt 回合 10ms 收口
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          cb.onTurnEnd(true, "success", 10);
        }, 10);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume });
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 20);
    return a;
  };

// 环境保存/恢复（进程级全局面，尾部统一还原）
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_STORAGE_READ_MODE", "CCR_NO_TITLE_GEN", "CCR_DATA_DIR", "CCR_X0_PROBE", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_EXPERAMENTAL_AGENT_TEAMS", "CCR_CWD"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];

// 装配观测内部缝（private 成员测试观察口——test-dispatch internals 同款 cast 口径）
type MgrInternals = {
  assemblyObserve: (sid: string, patch: { tools?: string[]; kinds?: string[] }) => void;
  assemblyInventoryOf: (sid: string) => string[] | null;
  assemblyObserved: Map<string, { tools: Set<string>; kinds: Set<string>; lastAt: number }>;
};

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-x0-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-x0-"));
  dirs.push(ORG, DATA);
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_X0_PROBE;
  try {
    const cfg: RelayConfig = {
      port: 8799, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const created: SpawnRec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建，fake agent）");

    // ---------- 件3a：org CLAUDE.md 入队指引段（幂等种子） ----------
    section("\nX0-件3a org CLAUDE.md 入队指引段：");
    assert(ensureOrgClaudeMd() === "exists", "ensureLeader 已种子 → 二次 exists（幂等）");
    {
      const md = readFileSync(join(ORG, "CLAUDE.md"), "utf-8");
      assert(md.includes(ORG_CLAUDE_MD_X0_MARKER), "org CLAUDE.md 含「## 入队与值守」段");
      assert(md.includes("org join <组id>"), "指引段含 org join 指令");
      assert(md.includes("org log-append"), "指引段含 log-append 指令");
      assert(md.includes("org pm claim"), "指引段含 pm claim 指令");
    }
    { // 旧文件升级路径：只有旧段的 CLAUDE.md → upgraded + X0 段追加（不覆盖既有内容）
      const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-x0b-"));
      dirs.push(ORG2);
      const oldMd = "## 组织记忆（旧文件）\n旧内容不得被覆盖。\n";
      writeFileSync(join(ORG2, "CLAUDE.md"), oldMd, "utf-8");
      const up = ensureOrgClaudeMd(ORG2);
      const md2 = readFileSync(join(ORG2, "CLAUDE.md"), "utf-8");
      assert(up === "upgraded", "旧文件（无 X0 段）→ upgraded");
      assert(md2.startsWith(oldMd.trimEnd()) && md2.includes(ORG_CLAUDE_MD_X0_MARKER), "升级=尾部追加 X0 段，旧内容原样保留");
    }

    // ---------- 件3b：用户家广播段（沙盒不触碰） ----------
    section("\nX0-件3b 用户家 ~/.claude/CLAUDE.md 广播段（沙盒守卫）：");
    {
      const before = existsSync(join(homedir(), ".claude", "CLAUDE.md")) ? readFileSync(join(homedir(), ".claude", "CLAUDE.md"), "utf-8") : "";
      // CCR_ORG_DIR 在场（测试沙盒）→ 不碰用户家（ensureUserClaudeBroadcast 同口径守卫）
      // 经 ensureLeader 侧挂点已跑过；此处直接验证广播函数在沙盒态的返回语义
      const orgMod = await import("../src/org.js");
      const seeded = (orgMod as unknown as { ensureUserClaudeBroadcast(): boolean }).ensureUserClaudeBroadcast();
      const after = existsSync(join(homedir(), ".claude", "CLAUDE.md")) ? readFileSync(join(homedir(), ".claude", "CLAUDE.md"), "utf-8") : "";
      assert(seeded === false, "沙盒态（CCR_ORG_DIR 在场）广播返回 false（不写用户家）");
      assert(before === after, "用户家 ~/.claude/CLAUDE.md 零改动");
    }

    // ---------- 件3c：面板复制入队指令键（静态锚） ----------
    section("\nX0-件3c 面板复制入队指令键（web-console 静态锚）：");
    {
      const html = readFileSync(join(repoRoot, "web-console/index-005.html"), "utf-8");
      assert(html.includes("data-team-copy-join"), "index-005.html 含 ⧉ 复制入队指令键（data-team-copy-join）");
      assert(html.includes("team-x0-hint"), "index-005.html 团队侧栏含入队/AGENT_TEAMS 提示行");
      const js = readFileSync(join(repoRoot, "web-console/js/team-domain.js"), "utf-8");
      assert(js.includes("[data-team-copy-join]") && js.includes("org join "), "team-domain.js 含复制入队指令处理（org join <gid> 拼装+剪贴板降级）");
      const css = readFileSync(join(repoRoot, "web-console/css/base.css"), "utf-8");
      assert(css.includes(".team-x0-hint"), "base.css 含 .team-x0-hint 提示行样式");
    }

    // ---------- 立项 + 首单熟手 ----------
    section("\nX0-件1 装配探测（dispatch 路由段）：");
    const anchor = join(DATA, "proj-x0");
    mkdirSync(anchor, { recursive: true });
    setLightConfirmTrusted(true);
    const cg = createGroup({ name: "x0 组", anchor_dir: anchor, tier: "轻立项" });
    assert(cg.ok, "x0 组立项（轻立项+trusted）");
    const gidX = cg.ok ? cg.group.id : "";
    if (listGroups().find((g) => g.id === gidX)?.status !== "active") setGroupStatus(gidX, "active");
    assert(listGroups().find((g) => g.id === gidX)?.status === "active", "组 active");

    const internals = mgr as unknown as MgrInternals;

    // P1-0 首单无 skills：熟手 w1 诞生（路由 count=1）
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "x0 第一单（无 skills 免检）", gid: gidX }) as { ok: boolean; session_id?: string; dispatch_id?: string; error?: string };
    const w1 = d1.session_id ?? "";
    assert(d1.ok === true && !!w1, "首单（无 skills）→ 新会话承接");
    assert(await waitFor(() => (routingFor(gidX).find((x) => x.session_id === w1)?.count ?? 0) === 1), "首单收口 → 路由表 count=1");

    // P1-a 无观测数据 + 带 skills → 明确报错拒单（不静默降级）+ 台账 failed 行
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "x0 探测拒单单", gid: gidX, skills: ["bash"] }) as { ok: boolean; error?: string };
    assert(d2.ok === false && (d2.error ?? "").includes("装配探测无数据"), "无观测数据 + skills → 明确报错（含「装配探测无数据」指引）");
    {
      const rows = readDispatchLog().filter((e) => (e.receipt ?? "").includes("装配探测无数据"));
      assert(rows.length >= 1 && rows[rows.length - 1].status === "failed" && rows[rows.length - 1].target === w1, "台账留 failed 行（target=熟手，记因可见）");
    }
    // 连环重试仍明确报错（负缓存只去重通知面，不吞错误）
    const d2b = mgr.orgAction("dispatch", { anchor, prompt: "x0 探测拒单单（连环）", gid: gidX, skills: ["bash"] }) as { ok: boolean; error?: string };
    assert(d2b.ok === false && (d2b.error ?? "").includes("装配探测无数据"), "连环派单同样明确报错（负缓存不吞错误）");

    // P1-b 喂观测（tools=["Bash"]）→ skills 命中 → 熟手复用（缓存命中不重复探）
    internals.assemblyObserve(w1, { tools: ["Bash"] });
    const d3 = mgr.orgAction("dispatch", { anchor, prompt: "x0 探测命中单", gid: gidX, skills: ["bash"] }) as { ok: boolean; session_id?: string };
    assert(d3.ok === true && d3.session_id === w1, "观测命中 skills → 熟手原会话承接（缓存命中）");
    assert(await waitFor(() => (routingFor(gidX).find((x) => x.session_id === w1)?.count ?? 0) === 2), "命中单收口 → count=2");

    // P1-c skills 零命中 → 降级跳席（清熟手走新会话路由）+ 台账记因行
    const d4 = mgr.orgAction("dispatch", { anchor, prompt: "x0 探测降级单", gid: gidX, skills: ["python"] }) as { ok: boolean; session_id?: string; dispatch_id?: string };
    assert(d4.ok === true && d4.session_id !== w1 && !!d4.session_id, "零命中 → 降级路由新会话（不走缺装配熟手）");
    {
      const raw = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; target: string; receipt?: string });
      const mid = raw.find((x) => x.id === d4.dispatch_id && (x.receipt ?? "").includes("装配缺项降级"));
      assert(!!mid && mid.status === "failed" && mid.target === w1, "降级中间行留档（failed+target=熟手，receipt 记因）");
    }

    // P1-d 逃生门 CCR_X0_PROBE=0 → 旧路径原样（零命中 skills 仍复用熟手）
    process.env.CCR_X0_PROBE = "0";
    const d5 = mgr.orgAction("dispatch", { anchor, prompt: "x0 探测关门单", gid: gidX, skills: ["cobol-legacy"] }) as { ok: boolean; session_id?: string };
    delete process.env.CCR_X0_PROBE;
    assert(d5.ok === true && d5.session_id === w1, "CCR_X0_PROBE=0 → 探测关闭，零命中 skills 仍熟手复用（旧路径）");

    // P1-e TTL 过期 → 归 null（1h 新鲜窗）
    {
      const cur = internals.assemblyObserved.get(w1);
      assert(!!cur && (internals.assemblyInventoryOf(w1)?.includes("bash") ?? false), "TTL 内清单可读（bash 命中）");
      if (cur) cur.lastAt = Date.now() - 2 * 3_600_000;
      assert(internals.assemblyInventoryOf(w1) === null, "lastAt 回拨 2h → 清单过期归 null（TTL 1h）");
      internals.assemblyObserve(w1, { tools: ["Bash"] }); // 复原（后续 PM 段不再依赖）
    }
    // P1-f external subagent kinds 喂入路（被动观测另一写口）
    {
      const extSid = "x0-observe-ext";
      mgr.ensureExternal(extSid, anchor, "观测喂入路 external 会话");
      mgr.setExternalSubagents(extSid, [
        { id: "ag-1", desc: "探路", kind: "Explore", bg: false, started_at: Date.now() },
        { id: "ag-2", desc: "干活", kind: "general-purpose", bg: false, started_at: Date.now() },
      ]);
      const inv = internals.assemblyInventoryOf(extSid) ?? [];
      assert(inv.includes("explore") && inv.includes("general-purpose"), "setExternalSubagents kinds 并集入观测缓存（小写归一）");
    }

    // ---------- 件2 org join ----------
    section("\nX0-件2 org join 自荐入编（确认卡门）：");
    {
      // 非法面先拒：未知组 / 无 cwd 命中 / 外部会话入 worker 席（seatGate 轴④：外部仅 pm 词表身份行）
      const j0 = mgr.orgAction("join", { gid: "nope", role: "worker", cwd: anchor }) as { ok: boolean; error?: string };
      assert(j0.ok === false && (j0.error ?? "").includes("项目组不存在"), "未知组 join 拒收（可读报错）");
      const j0b = mgr.orgAction("join", { gid: gidX, role: "worker", cwd: "/nonexistent/x0-nowhere" }) as { ok: boolean; error?: string };
      assert(j0b.ok === false && (j0b.error ?? "").includes("定位到你的会话"), "cwd 无命中会话 join 拒收（防任意混入第一道）");
      // 自荐 external 会话（cwd=组锚，最近活跃=命中定位）
      const selfSid = "x0-self-join";
      mgr.ensureExternal(selfSid, anchor, "join 自荐会话");
      const jw = mgr.orgAction("join", { gid: gidX, role: "worker", cwd: anchor }) as { ok: boolean; error?: string };
      assert(jw.ok === false && (jw.error ?? "").includes("外部会话不可入"), "外部会话入 worker 席拒收（死席前置拦+可读指引 pm/claim）");
      // pm 身份行走通：待确认卡 → 用户 ✓ → seatGate（pm 词表放行外部）→ 入编
      const hcBefore = (listGroups().find((g) => g.id === gidX)?.headcount ?? []).length;
      const j1 = mgr.orgAction("join", { gid: gidX, role: "pm", cwd: anchor }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string; kind: string }; sid?: string } };
      assert(j1.ok === true && j1.data?.needsConfirm === true, "join pm 身份行 → 待确认卡（needsConfirm）");
      const cf = j1.data?.confirm;
      assert(cf?.kind === "member-join", "卡 kind=member-join");
      assert((listGroups().find((g) => g.id === gidX)?.headcount ?? []).length === hcBefore, "卡未放行前不入编（headcount 不变，确认卡拦混入）");
      assert(listPendingConfirms().some((c) => c.kind === "member-join"), "pending 确认单在册");
      // 用户 ✓ → seatGate 同口径入编
      const ack = mgr.handleCommand({ command_id: "x0-cmd-join", type: "COMMAND_ORG_CONFIRM", ts: Date.now(), payload: { confirm_id: cf?.id, approve: true } } as Command, "web-x0");
      assert(ack.ok === true, "确认卡 ✓ 决议通过");
      // 定位者=确认卡 payload.sid（cwd 同锚下最近活跃 external——P1f 的 subagents 帧会
      // 刷新 updated_at，写死 selfSid 会竞态；以卡为权威断言）
      const joinSid = j1.data?.sid ?? ((cf as unknown as { payload?: { sid?: string } })?.payload?.sid ?? "");
      const hcAfter = listGroups().find((g) => g.id === gidX)?.headcount ?? [];
      assert(hcAfter.some((h) => h.session_id === joinSid && h.role === "pm"), `✓ 后正式入编（headcount 含 pm 身份行 sid=${joinSid.slice(0, 8)}，板面/成员可见）`);
    }

    // ---------- 件4 AGENT_TEAMS 协助 ----------
    section("\nX0-件4 AGENT_TEAMS 协助（check/on）：");
    {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      delete process.env.CLAUDE_CODE_EXPERAMENTAL_AGENT_TEAMS;
      const c1 = mgr.orgAction("agent-teams", { mode: "check" }) as { ok: boolean; data?: { enabled: boolean; var_name: string; hint: string } };
      assert(c1.ok === true && c1.data?.enabled === false && c1.data?.var_name === "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "check：未开环境 → enabled=false + 官方变量名（拼写双检主名）");
      assert((c1.data?.hint ?? "").includes("org agent-teams on"), "check 提示含一键开启指令（含 Windows Terminal 新会话限制说明）");
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
      const c2 = mgr.orgAction("agent-teams", { mode: "check" }) as { ok: boolean; data?: { enabled: boolean } };
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      assert(c2.ok === true && c2.data?.enabled === true, "check：env 开 → enabled=true");
      // on：沙盒（CCR_ORG_DIR 在场）→ 写 org 目录镜像，绝不碰用户家
      const settingsHome = join(homedir(), ".claude", "settings.json");
      const homeBefore = existsSync(settingsHome) ? readFileSync(settingsHome, "utf-8") : "";
      const o1 = mgr.orgAction("agent-teams", { mode: "on" }) as { ok: boolean; data?: { written: string } };
      const mirror = join(ORG, "agent-teams-settings.json");
      assert(o1.ok === true && o1.data?.written === mirror, "on：写入沙盒镜像 agent-teams-settings.json（written 路径=org 目录）");
      assert(existsSync(mirror) && (JSON.parse(readFileSync(mirror, "utf-8")) as { env?: Record<string, string> }).env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1", "镜像文件 env 段含 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
      const homeAfter = existsSync(settingsHome) ? readFileSync(settingsHome, "utf-8") : "";
      assert(homeBefore === homeAfter, "用户家 settings.json 零改动（沙盒守卫）");
    }

    // ---------- 件5 log-append ----------
    section("\nX0-件5 log-append 台账补录（含组归属）：");
    {
      const l0 = mgr.orgAction("log-append", { text: "   " }) as { ok: boolean; error?: string };
      assert(l0.ok === false && (l0.error ?? "").includes("必须带补录文本"), "空文本拒收");
      const l1 = mgr.orgAction("log-append", { text: "x0 无归属补录行" }) as { ok: boolean; data?: { ledgered: boolean; id: string } };
      assert(l1.ok === true && l1.data?.ledgered === true, "log-append 入账 ok");
      const row1 = readDispatchLog().find((e) => e.id === (l1.data?.id ?? ""));
      assert(!!row1 && row1.status === "done" && row1.target === "manual" && row1.actor === "user" && (row1.receipt ?? "").includes("x0 无归属补录行"), "台账行形状齐（done/manual/user/receipt）");
      assert(!(row1 as { project_anchor?: string }).project_anchor, "无 cwd → 不误挂组锚");
      // 组锚归属（cwd 落组锚内）：行带 project_anchor → project-detail receipts 可见（=团队域活动 tab 数据源）
      const l2 = mgr.orgAction("log-append", { text: "x0 带归属补录行", cwd: join(anchor, "sub") }) as { ok: boolean; data?: { id: string; project_anchor?: string } };
      assert(l2.ok === true && l2.data?.project_anchor === anchor, "cwd 落组锚子目录 → 行带 project_anchor（锚归属）");
      const det = mgr.orgAction("project-detail", { id: gidX }) as { ok: boolean; data?: { receipts?: { target: string; receipt?: string }[] } };
      assert(det.ok === true && (det.data?.receipts ?? []).some((rr) => rr.target === "manual" && (rr.receipt ?? "").includes("x0 带归属补录行")), "组详情回执流含归属补录行（活动 tab 可见）");
      assert((det.data?.receipts ?? []).every((rr) => !(rr.target === "manual" && (rr.receipt ?? "").includes("x0 无归属补录行"))), "无归属行不误挂本组（锚过滤正确）");
      // 显式 gid 同样归属
      const l3 = mgr.orgAction("log-append", { text: "x0 gid 直挂补录行", gid: gidX }) as { ok: boolean; data?: { project_anchor?: string } };
      assert(l3.ok === true && l3.data?.project_anchor === anchor, "显式 gid → 行带 project_anchor");
    }

    // ---------- 件6 PM claim + 自动迁移 ----------
    section("\nX0-件6 PM claim + 自动迁移：");
    {
      // leader 模式（缺省）→ 拒收
      const c0 = mgr.orgAction("pm-claim", { cwd: anchor }) as { ok: boolean; error?: string };
      assert(c0.ok === false && (c0.error ?? "").includes("leader 协作模式"), "leader 模式 claim 拒收（值守由 Leader 承担）");
      // 切 no-leader → external 会话 claim 接管
      assert(mgr.applyCollabMode("no-leader").ok, "切 no-leader 模式");
      const pmSid = "x0-pm-live";
      mgr.ensureExternal(pmSid, anchor, "值守 PM 会话");
      mgr.setExternalCliPid(pmSid, process.pid); // 本测试进程 pid=活
      const c1 = mgr.orgAction("pm-claim", { cwd: anchor }) as { ok: boolean; data?: { pm_session_id: string }; error?: string };
      assert(c1.ok === true && c1.data?.pm_session_id === pmSid, "no-leader 模式 claim → 值守位接管（活会话）");
      assert(mgr.pmDutyStatus().session_id === pmSid && mgr.pmDutyStatus().alive === true, "pmDutyStatus 体现接管（override 消费，SNAPSHOT pm_duty 同源）");
      assert(readPmOverride()?.session_id === pmSid, "duty.json override 在档");
      // 死 pid（真拉子进程等退出）→ 自动清档 + 回落现算（自动转活 PM）
      const child = spawn("true");
      const deadPid = child.pid ?? 0;
      await new Promise<void>((res) => { if (child.exitCode !== null) res(); else child.on("exit", () => res()); });
      setPmOverride({ session_id: "x0-pm-dead", cli_pid: deadPid, cwd: anchor, claimed_at: Date.now() });
      const st2 = mgr.pmDutyStatus();
      assert(readPmOverride() === null, "死 pid override 自动清档（duty.json 删）");
      assert(st2.session_id === pmSid && st2.alive === true, "自动迁移：回落现算 → 活 PM 承接（最近活跃+pid 探活）");
      // 置空：无任何活 pid 会话 → 空值守位
      setPmOverride({ session_id: "x0-pm-dead2", cli_pid: deadPid, cwd: anchor, claimed_at: Date.now() });
      const bus2 = new EventBus({ persistPath: join(DATA, "events2.ndjson") });
      const mgr2 = new SessionManager(bus2, { ...cfg, dataDir: DATA }); // 同 dataDir（no-leader 已写盘）；零在册会话
      const st3 = mgr2.pmDutyStatus();
      assert(st3.alive === false && st3.session_id === "", "全空 → 置空值守（alive=false，可观测非静默）");
      assert(readPmOverride() === null, "置空场景 override 同步清档");
    }

    // ---------- 件7 dispatch.md 预检节 R3 三问 ----------
    section("\nX0-件7 dispatch.md 预检节 R3 三问（静态锚）：");
    {
      const tpl = readFileSync(join(repoRoot, ".claude/commands/dispatch.md"), "utf-8");
      assert(tpl.includes("持久文本自明自查"), "预检节含第 4 项「持久文本自明自查」");
      assert(tpl.includes("指代清零"), "问①指代清零在");
      assert(tpl.includes("上下文自足"), "问②上下文自足在");
      assert(tpl.includes("事实新鲜"), "问③事实新鲜在");
    }

    console.log(`\n========== X0 套件：${pass} 通过 / ${fail} 失败 ==========`);
  } finally {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
  }
  process.exit(fail > 0 ? 1 : 0);
}

void main();
