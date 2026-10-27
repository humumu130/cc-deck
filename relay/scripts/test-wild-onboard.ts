// #279 野生会话纳管——三层断言：
// ① SessionStart 广播文案（触发内容/分层指引措辞/PM 值守口径/组清单与 cwd 命中★）
// ② org status pm 块（dutyTargetId 口径；无在岗 PM hint 单源）+ RULES.md 镜像（写库即刷/退役即除/boot 自愈）
// ③ Bridge.onSessionStart 只读契约（decision=pass+context；不建卡；.tmp- 沙盒早退无 context）
// ④ hook 真链子进程（stub relay 回 context → stdout additionalContext；无 context/连不上 → 零输出 exit 0 静默降级）
// 隔离：CCR_ORG_DIR/CCR_CONFIG_FILE/CCR_STORAGE_READ_MODE 三钉（test-rules-broadcast 同缝）
// + hook 子进程用临时 HOME 防打生产 ~/.cc-deck/data，绝不触生产 relay。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import { Bridge } from "../src/bridge.js";
import { appendRule, retireRule, writeRulesMirror, rulesMirrorPath } from "../src/team-rules.js";
import { pluginConfigPath } from "../src/plugin-config.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-wild-${tag}-`));

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE", "HOME", "CCR_PROJECTS_ROOT", "CCR_SESSIONS_ROOT"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];
// 孤儿收养隔离：Bridge 事件链会扫 ~/.claude/projects 收养真会话（本测试进程若是
// relay 托管会话更会继承 CCR_RELAY_CHILD）——两根都钉进空目录，测试态零外溢
const EMPTY_ROOT = mkDir("empty-roots");
dirs.push(EMPTY_ROOT);
process.env.CCR_PROJECTS_ROOT = EMPTY_ROOT;
process.env.CCR_SESSIONS_ROOT = EMPTY_ROOT;

function mkManager(tag: string) {
  // 三目录同基座：RULES.md 镜像落 org 父层（=基座），各 section 天然隔离不互踩
  const BASE = mkDir(tag);
  const DATA = join(BASE, "data");
  const ORG = join(BASE, "org");
  const CFG = join(BASE, "cfg");
  mkdirSync(DATA); mkdirSync(ORG); mkdirSync(CFG);
  dirs.push(BASE);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  process.env.CCR_STORAGE_READ_MODE = "json";
  writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n");
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  return { DATA, ORG, cfg, bus, mgr };
}

// ---------- S1 广播文案：无组无 PM 的在场声明 ----------
section("\nS1 sessionStartBroadcast 基线（无组/无在岗 PM）");
{
  const { ORG, mgr } = mkManager("s1");
  const text = mgr.sessionStartBroadcast("/definitely/not/matched");
  assert(text.includes("[cc-deck]"), "带 [cc-deck] 在场标头");
  assert(text.includes("PM 值守"), "PM 值守口径（修正A：不用 Leader 表述）");
  assert(text.includes("当前无在岗 PM"), "无在岗 PM 如实声明");
  assert(text.includes("subagent") && text.includes("org 分诊"), "分层指引（修正B：共存不禁止——subagent 自理 + org 分诊并存）");
  assert(!text.includes("勿自建团队"), "不含一刀切禁令（修正B：旧文案作废）");
  assert(text.includes(rulesMirrorPath(ORG)), "引用 RULES.md 镜像真实路径");
  assert(text.includes(join(ORG, "CLAUDE.md")), "引用 org CLAUDE.md 路径");
  assert(text.split("\n").length <= 5, "≤5 行（轻量纪律）");
}

// ---------- S2 组清单 + cwd 命中★ + PM 在岗 ----------
section("\nS2 组清单与在岗 PM（dutyTargetId 口径）");
{
  const { DATA, cfg, bus, mgr } = mkManager("s2");
  const anchor = mkDir("s2-anchor");
  const r = mgr.orgAction("project-create", { name: "野测项目", anchor, tier: "轻立项" }) as { ok: boolean; error?: string };
  assert(r.ok === true, `建组 ok${r.ok ? "" : `（${r.error}）`}`);
  const text0 = mgr.sessionStartBroadcast("/elsewhere");
  assert(text0.includes("野测项目"), "组名入广播（pending 组也可见）");
  const text1 = mgr.sessionStartBroadcast(join(anchor, "sub"));
  assert(text1.includes("★野测项目"), "cwd 命中组带 ★ 前置");

  // no-leader 模式 + 活 external（本测试进程 pid 即活进程）→ 在岗
  const cm = mgr.orgAction("collab-mode", { mode: "no-leader" }) as { ok: boolean };
  assert(cm.ok === true, "切 no-leader ok");
  const bridge = new Bridge(bus, mgr, { gateTools: new Set(), hasClients: () => false, dataDir: DATA });
  const up = await bridge.handleEvent({ event: "UserPromptSubmit", session_id: "cli-pm", prompt: "野测 PM 上岗", cwd: DATA, cli_pid: process.pid, permission_mode: "default" } as never);
  assert(up.decision === "pass", "PM 会话首事件放行");
  const pm = mgr.pmDutyStatus();
  assert(pm.mode === "no-leader", `pm.mode=no-leader（实得 ${pm.mode}）`);
  assert(pm.alive === true && pm.session_id === "ext-cli-pm", `在岗=最近活跃 external（实得 ${pm.session_id}）`);
  assert(pm.hint === undefined, "在岗无 hint");
  const text2 = mgr.sessionStartBroadcast("/elsewhere");
  assert(text2.includes("在岗"), "广播报在岗");
  void cfg;
}

// ---------- S3 org status pm 块（hint 单源）+ RULES.md 镜像 ----------
section("\nS3 org status pm 块与 RULES.md 镜像");
{
  const { ORG, mgr } = mkManager("s3");
  const st = mgr.orgAction("status", {}) as { ok: boolean; data?: { pm?: { alive: boolean; hint?: string; mode: string; session_id: string } } };
  assert(st.ok === true && !!st.data?.pm, "status 带 pm 块");
  assert(st.data!.pm!.alive === false, "无在岗 PM alive=false");
  assert(st.data!.pm!.hint === "当前无在岗 PM，分诊暂缓或走接管流程", "死 PM 提示语单源（#261 同族口径）");

  const mirror = rulesMirrorPath(ORG);
  assert(existsSync(mirror), "boot 即生成镜像（SessionManager 构造器自愈刷新）");
  const a = appendRule({ text: "PM 不直接编码", audience: "all", scope: "team", created_by: "user" }, ORG);
  const aEntry = a.ok && a.entry ? a.entry : null;
  assert(!!aEntry, "规则入库 ok");
  assert(existsSync(mirror), "写库即刷镜像（saveRules 挂钩）");
  const m1 = readFileSync(mirror, "utf-8");
  assert(m1.includes("机器生成") && m1.includes("PM 不直接编码") && m1.includes(aEntry!.id), "镜像含头部/文本/id");
  retireRule(aEntry!.id, ORG);
  const m2 = readFileSync(mirror, "utf-8");
  assert(!m2.includes("PM 不直接编码"), "退役即从镜像移除");
  rmSync(mirror);
  assert(writeRulesMirror(ORG) === true && existsSync(mirror), "boot 自愈：手动刷新重建镜像");
  // ENOENT 边界（test-bridge 实锤形态）：org 目录父层整条不存在时 boot 刷新不炸
  {
    const deep = join(mkDir("s3b"), "never", "created");
    assert(writeRulesMirror(deep) === true && existsSync(join(deep, "..", "RULES.md")), "org 目录未建时镜像刷新自建父层（boot 前置安全）");
  }
}

// ---------- S4 Bridge.onSessionStart 只读契约 ----------
section("\nS4 onSessionStart：只读注入、不建卡、沙盒早退");
{
  const { DATA, bus, mgr } = mkManager("s4");
  const bridge = new Bridge(bus, mgr, { gateTools: new Set(), hasClients: () => false, dataDir: DATA });
  const d = await bridge.handleEvent({ event: "SessionStart", session_id: "cli-wild", cwd: "/definitely/real/dir" } as never);
  assert(d.decision === "pass", "decision=pass（不劫持）");
  assert(typeof d.context === "string" && d.context.length > 0, "携带广播 context");
  assert(mgr.getExternal("ext-cli-wild") === undefined || mgr.getExternal("ext-cli-wild") === null, "不建卡（外部卡仍由首条 UserPromptSubmit 建）");
  const sbx = await bridge.handleEvent({ event: "SessionStart", session_id: "cli-sbx", cwd: "/x/.tmp-sandbox/y" } as never);
  assert(sbx.decision === "pass" && sbx.context === undefined, ".tmp- 沙盒早退：无 context 纯 pass");
}

// ---------- S5 hook 真链子进程：注入回传与静默降级 ----------
section("\nS5 hook.mjs 真链（stub relay / 无 context / 连不上）");
{
  const fakeHome = mkDir("s5-home");
  const root = mkDir("s5-root");
  mkdirSync(join(root, "hooks"));
  mkdirSync(join(root, "data"));
  // 布局自足：script=hooks/、bridge.json=data/（hook 候选 selfDir/../data 命中；
  // HOME 指空目录 → 生产 ~/.cc-deck/data 候选缺席，绝不触生产 relay）
  writeFileSync(join(root, "hooks", "bridge-hook.mjs"), readFileSync(new URL("../hooks/bridge-hook.mjs", import.meta.url)));
  const HOOK = join(root, "hooks", "bridge-hook.mjs");
  const runHook = (payload: object, port: number): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      // 剥 CCR_RELAY_CHILD：本测试进程常是 relay 托管会话（worker 沙盒），子进程继承
      // 该标志会被 hook 的托管会话守卫（bridge-hook.mjs:14）直接 exit 0——那不是被测
      // 行为。剥掉后 hook 按「野生会话」身份走完整链路
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
      delete env.CCR_RELAY_CHILD;
      void port;
      const p = execFile("node", [HOOK], { env, timeout: 30_000 },
        (e, stdout) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(stdout ?? "") }));
      p.stdin!.end(JSON.stringify(payload));
    });
  const startStub = (respond: (body: string, headers: Record<string, string | string[] | undefined>) => string): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c));
        req.on("end", () => { res.end(respond(body, req.headers)); });
      });
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
    });

  // 5a stub 回 context → stdout additionalContext
  {
    const { server, port } = await startStub(() => JSON.stringify({ decision: "pass", context: "BROADCAST_OK_野测" }));
    writeFileSync(join(root, "data", "bridge.json"), JSON.stringify({ port, token: "bt" }));
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "wild-cli-1", cwd: "/definitely/real" }, port);
    assert(r.out.includes("BROADCAST_OK_野测") && r.out.includes("additionalContext") && r.out.includes("SessionStart"), "回传 context → additionalContext JSON");
    assert(r.out.includes("hookSpecificOutput"), "输出形状=hookSpecificOutput");
    server.close();
  }
  // 5b stub 不回 context（老 relay 形态）→ 零输出 exit 0
  {
    const { server, port } = await startStub(() => JSON.stringify({ decision: "pass" }));
    writeFileSync(join(root, "data", "bridge.json"), JSON.stringify({ port, token: "bt" }));
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "wild-cli-2", cwd: "/definitely/real" }, port);
    assert(r.code === 0 && r.out.trim() === "", "老 relay 无 context：零输出 exit 0（存量兼容）");
    server.close();
  }
  // 5c 端口死（relay 不在）→ 零输出 exit 0（SessionStart 单轮快速失败）
  {
    writeFileSync(join(root, "data", "bridge.json"), JSON.stringify({ port: 1, token: "bt" }));
    const t0 = Date.now();
    const r = await runHook({ hook_event_name: "SessionStart", session_id: "wild-cli-3", cwd: "/definitely/real" }, 1);
    assert(r.code === 0 && r.out.trim() === "", "relay 不在：零输出 exit 0（静默降级）");
    assert(Date.now() - t0 < 10_000, "快速失败不拖慢开局（单轮无退避）");
  }
}

// ---------- 收尾 ----------
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
setTimeout(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } }, 100).unref();
process.exit(fail > 0 ? 1 : 0);
