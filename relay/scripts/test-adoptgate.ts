// #275R boot 收编甄别 + auto-revive 复活甄别——四段断言：
// S1 纯函数闸 shouldAdoptEngineProfile（新鲜收/陈年拒/活进程豁免/沙盒 cwd 拒/0=关/无时间戳拒）
// S2 Bridge 真链 wiring 冒烟（伪造 codex rollout 新/老/沙盒三样本：仅新样本建卡）
// S3 reviveEligible 两闸（stale-todos 陈年待办 / codex-empty 尸体）+ 既有闸回归
// S4 autoReviveManaged 陈年待办聚合「需确认」通知（fresh 拉/stale 不拉+通知）
// 隔离：CCR_ORG_DIR/CCR_CONFIG_FILE/CCR_STORAGE_READ_MODE/CCR_PROJECTS_ROOT/
// CCR_SESSIONS_ROOT/CCR_CODEX_SESSIONS_ROOT 六钉 + HOME 防外溢，绝不触生产 ~/.cc-deck。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import { Bridge, shouldAdoptEngineProfile, adoptMaxAgeMs, isSandboxCwd } from "../src/bridge.js";
import type { EngineRolloutProfile } from "../src/engine-rollouts.js";
import { reviveEligible, autoReviveManaged } from "../src/lifecycle/revive.js";
import { pluginConfigPath } from "../src/plugin-config.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-adoptg-${tag}-`));
const DAY = 86_400_000;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE", "CCR_PROJECTS_ROOT", "CCR_SESSIONS_ROOT", "CCR_CODEX_SESSIONS_ROOT", "HOME", "CCR_ADOPT_MAX_AGE_DAYS", "CCR_REVIVE_TODO_STALE_DAYS", "CCR_NO_AUTOREVIVE"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];

// 孤儿/引擎扫描隔离根（空目录=扫无可扫，不外溢）
const EMPTY = mkDir("empty");
dirs.push(EMPTY);
process.env.CCR_PROJECTS_ROOT = EMPTY;
process.env.CCR_SESSIONS_ROOT = EMPTY;
delete process.env.CCR_NO_AUTOREVIVE;

function mkManager(tag: string) {
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

const profile = (over: Partial<EngineRolloutProfile>): EngineRolloutProfile => ({
  sessionId: "sid-test-0001", cwd: "/Users/x/real/proj", startedAt: Date.now() - DAY,
  updatedAt: Date.now() - 3600_000, status: "DONE", filePath: "/x/rollout-a.jsonl",
  model: "", provider: "", prompt: "", title: "", terminal: undefined, error: undefined,
  activity: undefined, activityKey: undefined, activityKind: undefined, activityTool: undefined,
  ...over,
} as EngineRolloutProfile);

// ---------- S1 纯函数闸 ----------
section("\nS1 shouldAdoptEngineProfile 纯函数闸");
{
  const now = Date.now();
  assert(shouldAdoptEngineProfile(profile({}), { hasLiveProcess: false, now }).adopt === true, "新鲜转录（<3 天）收编");
  const stale = shouldAdoptEngineProfile(profile({ updatedAt: now - 5 * DAY }), { hasLiveProcess: false, now });
  assert(stale.adopt === false && /^stale-/.test(stale.reason ?? ""), `陈年转录（>3 天）拒收（reason=${stale.reason}）`);
  assert(shouldAdoptEngineProfile(profile({ updatedAt: now - 5 * DAY }), { hasLiveProcess: true, now }).adopt === true, "陈年转录+活进程=在用豁免照收");
  const sbx = shouldAdoptEngineProfile(profile({ cwd: "/tmp/.tmp-sandbox/proj" }), { hasLiveProcess: false, now });
  assert(sbx.adopt === false && sbx.reason === "sandbox-cwd", "沙盒 cwd（.tmp- 段）拒收（新鲜也拒）");
  assert(shouldAdoptEngineProfile(profile({ updatedAt: now - 5 * DAY }), { hasLiveProcess: false, now, maxAgeMs: 0 }).adopt === true, "maxAgeMs=0 关闸（显式关闭豁免陈年）");
  const noTs = shouldAdoptEngineProfile(profile({ updatedAt: 0 }), { hasLiveProcess: false, now });
  assert(noTs.adopt === false, "无时间戳转录按陈年拒收（解析不出活动不建卡）");
  // env 缺省口径：未设=3 天；显式 0=关
  delete process.env.CCR_ADOPT_MAX_AGE_DAYS;
  assert(adoptMaxAgeMs() === 3 * DAY, "缺省 3 天");
  process.env.CCR_ADOPT_MAX_AGE_DAYS = "";
  assert(adoptMaxAgeMs() === 3 * DAY, "空串落缺省（launchd 设而空不静默关闸）");
  process.env.CCR_ADOPT_MAX_AGE_DAYS = "0";
  assert(adoptMaxAgeMs() === 0, "CCR_ADOPT_MAX_AGE_DAYS=0 关闸");
  process.env.CCR_ADOPT_MAX_AGE_DAYS = "7";
  assert(adoptMaxAgeMs() === 7 * DAY, "CCR_ADOPT_MAX_AGE_DAYS=7 生效");
  delete process.env.CCR_ADOPT_MAX_AGE_DAYS;
}

// ---------- S2 Bridge 真链 wiring ----------
section("\nS2 adoptEngineProfiles 真链（伪造 codex rollout 三样本）");
{
  const CODEX = mkDir("codex-root");
  dirs.push(CODEX);
  process.env.CCR_CODEX_SESSIONS_ROOT = CODEX;
  const line = (iso: string, id: string, cwd: string) =>
    JSON.stringify({ timestamp: iso, type: "session_meta", payload: { id, cwd } }) + "\n";
  const now = Date.now();
  const mk = (name: string, iso: string, id: string, cwd: string, ageMs: number) => {
    const p = join(CODEX, name);
    writeFileSync(p, line(iso, id, cwd));
    utimesSync(p, new Date(now - ageMs), new Date(now - ageMs)); // mtime 同步做旧
  };
  mk("rollout-fresh.jsonl", new Date(now - 3600_000).toISOString(), "fresh111111111", "/Users/x/real/proj", 3600_000);
  mk("rollout-old.jsonl", new Date(now - 6 * DAY).toISOString(), "old2222222222", "/Users/x/real/proj", 6 * DAY);
  mk("rollout-sbx.jsonl", new Date(now - 600_000).toISOString(), "sbx3333333333", "/tmp/.tmp-test/proj", 600_000);

  const { DATA, cfg, bus, mgr } = mkManager("s2");
  const bridge = new Bridge(bus, mgr, { gateTools: new Set(), hasClients: () => false, dataDir: DATA });
  void bridge;
  assert(mgr.getExternal("ext-codex-fresh111111111") !== undefined && mgr.getExternal("ext-codex-fresh111111111") !== null, "新转录（1h）建卡");
  assert(mgr.getExternal("ext-codex-old2222222222") === undefined, "老转录（6d）boot 不建卡（#275R 主闸）");
  assert(mgr.getExternal("ext-codex-sbx3333333333") === undefined, "沙盒转录（.tmp-）不建卡（新护栏）");
  // 二次扫描幂等：已建卡不受闸影响、被拒的仍拒（不闪建）
  bridge.scanExternalEngines();
  assert(mgr.getExternal("ext-codex-fresh111111111") !== undefined && mgr.getExternal("ext-codex-old2222222222") === undefined, "重扫幂等（闸只拦首次发现）");

  // S2b 置顶豁免（审查 B-P1-2）：events 压缩丢卡后重启=「首次发现」，置顶清单命中
  // → 照收（防置顶卡随压缩永久消失）；沙盒 cwd 不豁免
  {
    const CODEX2 = mkDir("codex-root2");
    dirs.push(CODEX2);
    process.env.CCR_CODEX_SESSIONS_ROOT = CODEX2;
    const mk2 = (name: string, iso: string, id: string, cwd: string) =>
      writeFileSync(join(CODEX2, name), JSON.stringify({ timestamp: iso, type: "session_meta", payload: { id, cwd } }) + "\n");
    const now2 = Date.now();
    mk2("rollout-pinned.jsonl", new Date(now2 - 6 * DAY).toISOString(), "pinned44444444", "/Users/x/real/old");
    mk2("rollout-pinsbx.jsonl", new Date(now2 - 600_000).toISOString(), "pinsbx5555555", "/tmp/.tmp-test/x");
    const { DATA: D2, cfg: c2, bus: b2, mgr: m2 } = mkManager("s2b");
    writeFileSync(join(D2, "pinned-sessions.json"), JSON.stringify(["ext-codex-pinned44444444", "ext-codex-pinsbx5555555"]));
    void new Bridge(b2, m2, { gateTools: new Set(), hasClients: () => false, dataDir: D2 });
    void c2;
    assert(m2.getExternal("ext-codex-pinned44444444") !== undefined && m2.getExternal("ext-codex-pinned44444444") !== null, "置顶豁免：老转录但置顶清单命中 → 照收（压缩丢卡可恢复）");
    assert(m2.getExternal("ext-codex-pinsbx5555555") === undefined, "沙盒 cwd 即使置顶也不豁免（.tmp- 绝对护栏）");
  }
}

// ---------- S3 reviveEligible 两闸 ----------
section("\nS3 reviveEligible：陈年待办闸 + codex 空会话闸");
{
  const HOME = mkDir("s3-home");
  dirs.push(HOME);
  const mkTodo = (cliSid: string, subject: string, ageMs: number) => {
    const dir = join(HOME, "tasks", cliSid);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "1.json");
    writeFileSync(p, JSON.stringify({ id: 1, subject, status: "pending" }));
    utimesSync(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  const mgr: any = { isRetiredMember: () => false, employeeHome: () => HOME, sessions: new Map() };
  const sess = (over: Record<string, unknown>) => ({
    state: {
      session_id: "m-xxxx", relay_session_id: "cli-sid-x", engine: "claude", external: false,
      status: "DONE", updated_at: Date.now() - 3600_000, started_at: Date.now() - 2 * 3600_000,
      // 真实形状（审查 A-P0-1 校准）：文件面 stats 无 token 字段，token 在 usage
      stats: { files_changed: 1, lines_added: 0, lines_deleted: 0 }, usage: { output_tokens: 100 },
      title: "野测会话",
      ...over,
    },
    agent: undefined, resumePending: undefined, resumeCooldownUntil: undefined,
  });

  // 陈年待办（5 天前）→ stale-todos；新鲜待办 → null
  mkTodo("cli-fresh", "新鲜活工作", 3600_000);
  mkTodo("cli-stale", "陈年愿望", 5 * DAY);
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-fresh" })) === null, "新鲜待办可拉（回归）");
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-stale" })) === "stale-todos", "陈年待办（>3 天）不自动拉");
  // 待办无时间面（mtime 全 0 不可构造——mtime 恒在）以 env 关闸回归兜底：
  process.env.CCR_REVIVE_TODO_STALE_DAYS = "0";
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-stale" })) === null, "CCR_REVIVE_TODO_STALE_DAYS=0 关闸（陈年照拉=显式选择）");
  delete process.env.CCR_REVIVE_TODO_STALE_DAYS;
  // 无未完成待办回归（任务存储里只有 completed 条目）
  {
    const dir = join(HOME, "tasks", "cli-done");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), JSON.stringify({ id: 1, subject: "已完成任务", status: "completed" }));
  }
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-done", status: "DONE" })) === "no-open-todos", "既有闸回归（无开放待办不拉）");
  // codex 空会话（ERROR+零产出+短命）→ codex-empty；有产出 ERROR → 可拉
  const cdx = (over: Record<string, unknown>) => sess({ engine: "codex", relay_session_id: "thread-x", ...over });
  assert(reviveEligible(mgr, cdx({ status: "ERROR", usage: { output_tokens: 0 }, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, updated_at: Date.now() - 120_000, started_at: Date.now() - 300_000 })) === "codex-empty", "Codex 尸体（ERROR+usage 零产出）不复活");
  assert(reviveEligible(mgr, cdx({ status: "ERROR", usage: { output_tokens: 5000 }, stats: { files_changed: 2, lines_added: 0, lines_deleted: 0 }, updated_at: Date.now() - 120_000, started_at: Date.now() - 3 * 3600_000 })) === null, "Codex 有产出断流照拉（usage.output_tokens 判据，不误伤真工作）");
  assert(reviveEligible(mgr, cdx({ status: "ERROR", usage: undefined, stats: { files_changed: 3, lines_added: 0, lines_deleted: 0 } })) === null, "usage 缺席但文件面有产出=非尸体（双保险次级判据）");
  assert(reviveEligible(mgr, cdx({ status: "WORKING", usage: undefined, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 } })) === null, "Codex WORKING 腰斩照拉（空会话闸只拦 ERROR）");
  assert(reviveEligible(mgr, cdx({ status: "DONE" })) === "codex-idle", "Codex DONE 不拉（回归）");
  // 48h 会话闸回归 + 归因顺序（审查 A-P3-3：>48h 会话归 stale-48h 不进陈年通知名单）
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-fresh", updated_at: Date.now() - 3 * DAY })) === "stale-48h", "48h 会话闸回归（陈年会话不拉）");
  assert(reviveEligible(mgr, sess({ relay_session_id: "cli-stale", updated_at: Date.now() - 3 * DAY })) === "stale-48h", "48h 内含陈年待办但会话>48h → 归因 stale-48h（不占陈年通知位）");
}

// ---------- S4 autoReviveManaged 聚合通知 ----------
section("\nS4 autoReviveManaged：陈年待办聚合「需确认」通知");
{
  const HOME = mkDir("s4-home");
  dirs.push(HOME);
  const mkTodo = (cliSid: string, subject: string, ageMs: number) => {
    const dir = join(HOME, "tasks", cliSid);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "1.json");
    writeFileSync(p, JSON.stringify({ id: 1, subject, status: "pending" }));
    utimesSync(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  mkTodo("cli-r-fresh", "活工作", 3600_000);
  mkTodo("cli-r-stale", "陈年任务A", 5 * DAY);
  const resumed: string[] = [];
  const notes: { title: string; body: string }[] = [];
  const mgr: any = {
    sessions: new Map([
      ["a", { state: { session_id: "a", relay_session_id: "cli-r-fresh", engine: "claude", external: false, status: "DONE", updated_at: Date.now() - 3600_000, started_at: 0, stats: {}, title: "活会话" }, agent: undefined }],
      ["b", { state: { session_id: "b", relay_session_id: "cli-r-stale", engine: "claude", external: false, status: "DONE", updated_at: Date.now() - 3600_000, started_at: 0, stats: {}, title: "陈年会话" }, agent: undefined }],
    ]),
    isRetiredMember: () => false,
    employeeHome: () => HOME,
    resumeAgent: (s: any) => { resumed.push(s.state.session_id); },
    upsertNotification: (_d: string, _k: string, _s: string, opts: { title: string; body: string }) => { notes.push({ title: opts.title, body: opts.body }); },
  };
  const n = autoReviveManaged(mgr);
  assert(n === 1 && resumed.length === 1 && resumed[0] === "a", "仅新鲜待办会话被拉起");
  assert(notes.length === 1 && notes[0].title.includes("陈年待办") && notes[0].body.includes("陈年会话") && notes[0].body.includes("手动恢复"), "陈年待办聚合出「需确认」通知（含会话名+手动恢复指引）");
}


// ---------- #275S：沙盒/临时目录判定扩展（ccr- 实锤收编口堵漏）----------
// 1026 实锤：ccr-273e2e-ans 三卡 = cwd 落 $TMPDIR/ccr-…（macOS mkdtemp 家族，
// /private/var/folders/*/T/ 下）的新鲜转录，.tmp- 护栏不匹配 → adoptOrphans
// 30min 窗收编。S 扩三族判据（.tmp- 段 / Unix 临时前缀 / TMPDIR 前缀）+四处判定口收口
{
  const savedTmp = process.env.TMPDIR;
  // S1 isSandboxCwd 正矩阵
  assert(isSandboxCwd("/private/var/folders/9m/xx/T/ccr-273e2e-answer-Vq1Id3") === false || process.env.TMPDIR !== undefined, "S0 前置：TMPDIR 判定依赖运行时 env（未设时仅段/前缀判据）");
  process.env.TMPDIR = "/private/var/folders/9m/abc/T/";
  assert(isSandboxCwd("/private/var/folders/9m/abc/T/ccr-273e2e-answer-Vq1Id3") === true, "S1a TMPDIR 前缀（macOS mkdtemp 家族，ccr- 实锤形态）命中");
  assert(isSandboxCwd("/tmp/probe-123/claude") === true, "S1b Unix /tmp 前缀命中");
  assert(isSandboxCwd("/private/tmp/sbx/session") === true, "S1c /private/tmp 命中");
  assert(isSandboxCwd("/var/tmp/tool-xyz") === true, "S1d /var/tmp 命中");
  assert(isSandboxCwd("/Users/x/dev/.tmp-test/w") === true, "S1e .tmp- 段既有判据保留（#269/#283 回归）");
  // S2 负矩阵（防误伤）
  assert(isSandboxCwd("/Users/xdd/dev/cc-deck") === false, "S2a 正常项目目录不命中");
  assert(isSandboxCwd("/Users/x/T/myproject") === false, "S2b 用户目录恰好含 T 段不命中（TMPDIR 前缀法零猜测）");
  assert(isSandboxCwd("/Users/x/dev/tmp-utils") === false, "S2c 名含 tmp 的普通目录不命中（仅前缀路径判据）");
  assert(isSandboxCwd("") === false && isSandboxCwd(undefined) === false, "S2d 空 cwd 不命中");
  // S3 shouldAdopt 拒收口径（TMPDIR 形态 fresh 转录也不收——护栏优先于年龄闸）
  const v = shouldAdoptEngineProfile(
    { filePath: "/x", sessionId: "s", cwd: "/private/var/folders/9m/abc/T/ccr-x", prompt: "p", title: "t", startedAt: Date.now(), updatedAt: Date.now(), status: "WORKING", terminal: false, activityKey: "" } as never,
    {} as never,
  );
  assert(v.adopt === false && v.reason === "sandbox-cwd", "S3 shouldAdopt：TMPDIR 沙盒 cwd 拒收优先于新鲜度（engine 侧同收口）");
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
}

// ---------- 收尾 ----------
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
process.exit(fail > 0 ? 1 : 0);
