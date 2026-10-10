// W-EXPP2 —— 经验库广播面全链测试：SNAPSHOT 锚定帧 + EXPERIENCE_UPDATED 瞬态 delta 帧
// （exp-* 动作/申报入库/GC 轮后端上 ≤60s 可见）+ GC 轮摘要通知（D1-4）+ 新经验通知 +
// exp-regroup 组合动作（D1-6）+ orgCommand 面板通道透传 + 瞬态语义（seq=0 不落 ndjson）。
// 隔离口径：CCR_ORG_DIR/CCR_CONFIG_FILE/CCR_STORAGE_READ_MODE=json 三钉（test-experience
// 同缝），绝不触生产 ~/.cc-deck。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendExperience, listExperience, runExperienceGc, setExperienceGcSummaryHook,
  resetExperienceRuntimeForTests, experiencePath,
  type ExperienceEntry, type ExperienceGcSummary,
} from "../src/experience.js";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import { createGroup, setLightConfirmTrusted } from "../src/projects.js";
import { readPluginConfig, pluginConfigPath } from "../src/plugin-config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mustOk = (r: { ok: boolean; entry?: ExperienceEntry; error?: string }): ExperienceEntry => {
  if (!r.ok || !r.entry) throw new Error(`测试前置失败: ${"error" in r ? r.error : "not ok"}`);
  return r.entry;
};
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-expbc-${tag}-`));
const DAY = 86_400_000;
const USER_SRC = { actor: "user" as const, session_id: "test" };

// 环境保存/恢复（进程级 env 是全局面，测试尾部统一还原）
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE", "CCR_EXP_ARCHIVE_AT"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];
process.env.CCR_STORAGE_READ_MODE = "json";

interface ExpFrame { type: string; seq: number; payload: { entries?: ExperienceEntry[]; entity_refs?: string[]; delta?: { upserts: ExperienceEntry[]; removes: string[] } } }

/** manager + 帧捕获标准装（每 section 独立 data/org 目录，manager 构造即注册 GC hook） */
function mkManager(tag: string) {
  const DATA = mkDir(`${tag}-data`);
  const ORG = mkDir(`${tag}-org`);
  const CFG = mkDir(`${tag}-cfg`);
  dirs.push(DATA, ORG, CFG);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n"); // 缺省全开
  resetExperienceRuntimeForTests();
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const frames: ExpFrame[] = [];
  bus.subscribe((env) => frames.push({ type: env.type as string, seq: env.seq, payload: env.payload as ExpFrame["payload"] }));
  const mgr = new SessionManager(bus, cfg);
  const expFrames = (from = 0): ExpFrame[] => frames.slice(from).filter((f) => f.type === "EXPERIENCE_UPDATED");
  return { DATA, ORG, CFG, mgr, frames, expFrames };
}

// ---------- S1 store 级 GC 轮摘要钩子 ----------
section("\nS1 GC 轮摘要钩子（experience.ts 单槽回调）");
{
  const { ORG } = (() => {
    const DATA = mkDir("s1-data"); const ORG = mkDir("s1-org"); const CFG = mkDir("s1-cfg");
    dirs.push(DATA, ORG, CFG);
    process.env.CCR_ORG_DIR = ORG;
    process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
    writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n");
    resetExperienceRuntimeForTests();
    return { ORG };
  })();
  process.env.CCR_EXP_ARCHIVE_AT = "999"; // 本节不归档
  const summaries: ExperienceGcSummary[] = [];
  setExperienceGcSummaryHook((s) => summaries.push(s)); // 直注册（无 manager 场景）
  const now = Date.now();
  const neverOld = mustOk(appendExperience({ text: "从未命中超九十天整", kind: "practice", source: USER_SRC }, ORG));
  const dupA = mustOk(appendExperience({ text: "跨 kind 去重乙", kind: "pitfall", source: USER_SRC }, ORG));
  const dupB = mustOk(appendExperience({ text: "跨 kind 去重乙！", kind: "practice", source: USER_SRC }, ORG));
  const back = (id: string, patch: Partial<ExperienceEntry>) => {
    const f = JSON.parse(readFileSync(experiencePath(ORG), "utf-8")) as { entries: ExperienceEntry[] };
    Object.assign(f.entries.find((x) => x.id === id)!, patch);
    writeFileSync(experiencePath(ORG), JSON.stringify(f, null, 2), "utf-8");
  };
  back(neverOld.id, { created_at: now - 91 * DAY });
  back(dupA.id, { use_count: 3, last_used_at: now - DAY });
  back(dupB.id, { use_count: 5, last_used_at: now - 2 * DAY });
  const res = runExperienceGc("scheduled", now, ORG);
  assert(res.ran && res.actions.length >= 2, `GC 执行（${res.actions.map((a) => a.type).join("/")}）`);
  assert(summaries.length === 1, "钩子恰回调一次（有动作轮）");
  assert(summaries[0]!.retired === 1 && summaries[0]!.merged === 1, `摘要计数吻合（retired=${summaries[0]!.retired} merged=${summaries[0]!.merged}）`);
  assert(summaries[0]!.ts === now, "摘要 ts=轮次时刻（stableKey 一轮一行依据）");
  // 饱和空轮不回调
  summaries.length = 0;
  runExperienceGc("threshold", Date.now(), ORG);
  assert(summaries.length === 0, "饱和空轮（动作集空）不回调");
  delete process.env.CCR_EXP_ARCHIVE_AT;
}

// ---------- S2 manager 广播帧形状（锚定帧 + delta 帧） ----------
section("\nS2 广播帧形状：锚定/delta/动作可见性");
{
  const { ORG, mgr, frames, expFrames } = mkManager("s2");
  // ① 无基线首帧 = 覆盖式锚定帧（entries 全量，无 delta）
  mustOk(appendExperience({ text: "广播锚定测试条", kind: "fact", source: USER_SRC }, ORG));
  mgr.emitExperience();
  const f1 = expFrames()[0]!;
  assert(f1.seq === 0, "EXPERIENCE_UPDATED 瞬态（seq=0）");
  assert(Array.isArray(f1.payload.entries) && f1.payload.entries.length === 1, "锚定帧带 entries 全量");
  assert(f1.payload.delta === undefined, "重启后首帧无 delta（端上覆盖式锚定口径）");
  // ② exp-append → delta.upserts 带新条（动作后端上 ≤60s 可见的形状面）
  let from = frames.length;
  const ra = mgr.orgAction("exp-append", { text: "动作广播测试条", kind: "practice", role_scope: "worker", project_scope: "global" });
  assert(ra.ok, "orgAction exp-append ok");
  const added = (ra as { ok: true; data: { entry: ExperienceEntry } }).data.entry;
  const f2 = expFrames(from)[0]!;
  assert(f2.payload.delta !== undefined && f2.payload.delta.upserts.length === 1 && f2.payload.delta.upserts[0]!.id === added.id, "exp-append 后 delta.upserts=新条");
  assert(Array.isArray(f2.payload.entries) && f2.payload.entries.length === 2, "帧双载：entries 恒全量（旧形消费不破）");
  assert(Array.isArray(f2.payload.entity_refs) && f2.payload.entity_refs!.includes(added.id), "entity_refs 定位索引随 delta 出");
  // ③ exp-retire → 状态翻转走 upsert（带稳定 id 完整条目差分铁律）
  from = frames.length;
  assert(mgr.orgAction("exp-retire", { id: added.id }).ok, "exp-retire ok");
  const f3 = expFrames(from)[0]!;
  assert(f3.payload.delta!.upserts.length === 1 && f3.payload.delta!.upserts[0]!.id === added.id && f3.payload.delta!.upserts[0]!.status === "retired", "retire 后 delta.upserts=[条(status=retired)]");
  assert(f3.payload.delta!.removes.length === 0, "retired 不 removes（永不物理删，面板折叠区可见）");
  // ④ exp-restore → 回 active
  from = frames.length;
  assert(mgr.orgAction("exp-restore", { id: added.id }).ok, "exp-restore ok");
  const f4 = expFrames(from)[0]!;
  assert(f4.payload.delta!.upserts[0]!.status === "active", "restore 后 delta.upserts=[条(status=active)]");
  // ⑤ 失败动作不广播（校验拒收零变化零帧）
  from = frames.length;
  const rej = mgr.orgAction("exp-append", { text: "", kind: "fact" });
  assert(!rej.ok && expFrames(from).length === 0, "拒收动作零帧（diff 无变化不发）");
  void ORG;
}

// ---------- S3 exp-regroup 组合动作（D1-6） ----------
section("\nS3 exp-regroup：append+retire+merged_from 一漏斗");
{
  const { ORG, mgr, frames, expFrames } = mkManager("s3");
  const r0 = mgr.orgAction("exp-append", { text: "改归组旧条（role 挂错）", kind: "practice", role_scope: "worker", project_scope: "global" });
  assert(r0.ok, "造旧条 ok");
  const old1 = (r0 as { ok: true; data: { entry: ExperienceEntry } }).data.entry;
  // 缺 old_id 拒
  assert(!mgr.orgAction("exp-regroup", { text: "x", kind: "fact" }).ok, "缺 old_id 拒收");
  assert(!mgr.orgAction("exp-regroup", { old_id: "exp-nonexist", text: "x", kind: "fact" }).ok, "旧条不存在拒收");
  // 正常改归组：worker/global → reviewer/global（role 轴修正）
  let from = frames.length;
  const rr = mgr.orgAction("exp-regroup", { old_id: old1.id, role_scope: "reviewer" });
  assert(rr.ok, "exp-regroup ok");
  const data = (rr as { ok: true; data: { entry: ExperienceEntry; retired: string } }).data;
  assert(data.entry.role_scope === "reviewer" && data.entry.text === old1.text, "新条继承正文、落新 role_scope");
  assert((data.entry.merged_from ?? []).includes(old1.id), "新条 merged_from 溯源旧条");
  const oldAfter = listExperience(undefined, ORG).find((x) => x.id === old1.id)!;
  assert(oldAfter.status === "retired", "旧条已退役（append-only 不物理删）");
  const fr = expFrames(from)[0]!;
  assert(fr.payload.delta !== undefined && fr.payload.delta.upserts.length === 2, "单帧带双条变化（新+旧同帧 diff）");
  // 同 scope 同文护栏（改归组须至少换轴）
  assert(!mgr.orgAction("exp-regroup", { old_id: data.entry.id }).ok, "同 scope 同文拒收（防无意义复制）");
}

// ---------- S4 GC 轮 → 广播 + D1-4 通知（manager 注册链全通） ----------
section("\nS4 GC 轮收口：EXPERIENCE_UPDATED + 经验整理通知");
{
  const { ORG, mgr, frames, expFrames } = mkManager("s4");
  process.env.CCR_EXP_ARCHIVE_AT = "999";
  const now = Date.now();
  mustOk(appendExperience({ text: "GC 轮广播用从未命中条", kind: "practice", source: USER_SRC }, ORG));
  const back = (id: string, patch: Partial<ExperienceEntry>) => {
    const f = JSON.parse(readFileSync(experiencePath(ORG), "utf-8")) as { entries: ExperienceEntry[] };
    Object.assign(f.entries.find((x) => x.id === id)!, patch);
    writeFileSync(experiencePath(ORG), JSON.stringify(f, null, 2), "utf-8");
  };
  back(listExperience(undefined, ORG)[0]!.id, { created_at: now - 91 * DAY });
  const from = frames.length;
  const res = runExperienceGc("scheduled", now, ORG); // manager 构造已注册 hook → onExperienceGcRound
  assert(res.ran && res.actions.length > 0, "GC 有动作轮");
  assert(expFrames(from).length > 0, "GC 轮后 EXPERIENCE_UPDATED 发出");
  const notifs = mgr.notificationsList();
  const gcN = notifs.find((n) => n.title === "经验整理");
  assert(!!gcN, "GC 轮摘要通知入账（D1-4）");
  assert(!!gcN && gcN.body.includes("淘汰 1") && gcN.body.includes("合并 0") && gcN.body.includes("均可恢复"), "通知文案=淘汰 N、合并 M，均可恢复");
  assert(!!gcN && gcN.sourceContext.domain === "experience" && gcN.actionable === false, "通知形状：domain=experience/非 actionable（操作入口在面板）");
  assert(!!gcN && gcN.kind === "system" && gcN.group === "activity", "通知形状：kind=system/group=activity");
  delete process.env.CCR_EXP_ARCHIVE_AT;
}

// ---------- S5 agent 申报捕获 → 广播 + 新经验通知 ----------
section("\nS5 申报捕获：入库广播 + 经验入库通知");
{
  const { ORG, mgr, expFrames, frames } = mkManager("s5");
  const ANCHOR = mkDir("s5-anchor");
  dirs.push(ANCHOR);
  setLightConfirmTrusted(true);
  assert(createGroup({ name: "s5 组", anchor_dir: ANCHOR, tier: "轻立项" }).ok, "立项（锚点在册）");
  const created: { prompt: string | undefined; cb: AgentCallbacks }[] = [];
  mgr.setAgentFactory((_cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    return a;
  });
  const d1 = mgr.dispatchWorker({ anchor: ANCHOR, prompt: "干活" });
  assert(d1.ok, "派单成功");
  const from = frames.length;
  created[0]!.cb.onInit?.(`sdk-${randomUUID().slice(0, 6)}`, "test-model");
  created[0]!.cb.onLog?.("assistant_text", "干完了。\n结果：完成\n经验：申报捕获要广播（#pitfall）");
  created[0]!.cb.onTurnEnd?.(true, "success", 100);
  const cap = listExperience({ project: ANCHOR }, ORG).find((e) => e.text.includes("申报捕获要广播"));
  assert(!!cap, "申报入库");
  const capFrame = expFrames(from)[0]!;
  const visible = capFrame && (capFrame.payload.delta === undefined
    ? (capFrame.payload.entries ?? []).some((e) => e.id === cap!.id) // mgr 首发无基线=锚定帧（entries 全量）
    : capFrame.payload.delta.upserts.some((e) => e.id === cap!.id));
  assert(!!visible, "申报入库后端上可见（锚定帧含条/delta.upserts 含条二形之一）");
  const n = mgr.notificationsList().find((x) => x.sourceContext.entityId === cap!.id);
  assert(!!n && n.title.includes("经验入库") && n.body.includes("申报捕获要广播"), "新经验通知一行入账（用户否决通道「变更可见」新增面）");
  // 同条重复申报（拒收/复活）不重复通知（stableKey 幂等）
  const nCount = mgr.notificationsList().filter((x) => x.sourceContext.entityId === cap!.id).length;
  assert(nCount === 1, "同条目通知 stableKey 去重（一条一行）");
  void d1;
}

// ---------- S6 orgCommand 面板通道透传 + 瞬态不落盘 ----------
section("\nS6 orgCommand exp-* 透传 + 瞬态语义");
{
  const { DATA, ORG, mgr, expFrames } = mkManager("s6");
  const e1 = mustOk(appendExperience({ text: "面板通道测试条", kind: "fact", source: USER_SRC }, ORG));
  // COMMAND_ORG_ACTION {action:"exp-retire"} → 咽喉透传 orgAction（鉴权 owner 恒过）
  const ack = mgr.handleCommand({ command_id: "c1", type: "COMMAND_ORG_ACTION", payload: { action: "exp-retire", id: e1.id } } as never, "web-1");
  assert(ack.ok === true, "COMMAND_ORG_ACTION exp-retire 透传 ok");
  assert(listExperience(undefined, ORG).find((x) => x.id === e1.id)!.status === "retired", "透传执行生效（retired 落库）");
  assert(expFrames().length > 0, "透传路径同样广播（漏斗内单点 emit）");
  // 未知 exp 动作 → orgAction default 拒（不静默）
  const ack2 = mgr.handleCommand({ command_id: "c2", type: "COMMAND_ORG_ACTION", payload: { action: "exp-frobnicate" } } as never, "web-1");
  assert(ack2.ok === false, "未知 exp-* 动作拒收");
  // 瞬态语义：EXPERIENCE_UPDATED 不落 events.ndjson
  const ndjson = existsSync(join(DATA, "events.ndjson")) ? readFileSync(join(DATA, "events.ndjson"), "utf-8") : "";
  assert(!ndjson.includes("EXPERIENCE_UPDATED"), "瞬态帧不落 events.ndjson（重连不补发，SNAPSHOT 兜底）");
}

// ---------- 收尾 ----------
process.env.CCR_ORG_DIR = savedEnv.CCR_ORG_DIR;
process.env.CCR_CONFIG_FILE = savedEnv.CCR_CONFIG_FILE;
process.env.CCR_STORAGE_READ_MODE = savedEnv.CCR_STORAGE_READ_MODE;
process.env.CCR_EXP_ARCHIVE_AT = savedEnv.CCR_EXP_ARCHIVE_AT;
setExperienceGcSummaryHook(null);
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理尽力 */ } }
console.log(`\nexperience-broadcast: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
