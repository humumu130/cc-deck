// W-EXPP1 —— 团队经验库（experience.ts）全链测试：store 原子写/坏 JSON 拒写/去重/复活环/
// 软上限/归档 + 注入纯函数（权重排序/预算裁剪性质/去结构化/memo）+ 申报解析 + GC 机械档
// （梯度淘汰/跨 kind 去重/write-ahead 快照/饱和）+ 旧域迁移幂等 + 读侧退役 + 端到端
// （造条目→派单看到注入块→回执申报→收口入库→bump→retire→复活环）+ 总开关关闭路径。
// 隔离口径：CCR_ORG_DIR/CCR_CONFIG_FILE/CCR_STORAGE_READ_MODE=json 三钉（pm-duty 同缝），
// store 面直接传 dir 参数，绝不触生产 ~/.cc-deck。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendExperience, bumpExperiences, retireExperience, restoreExperience, listExperience,
  buildExperienceInjection, parseExperienceDeclaration, selectForInjection, formatExperienceLine,
  sanitizeExperienceText, normExpKey, runExperienceGc, lastGcLogTs, migrateLessonsToExperience,
  experiencePath, expGcLogPath, resetExperienceRuntimeForTests,
  exportExperience, importExperience,
  type ExperienceEntry,
} from "../src/experience.js";
import { wrapDispatchPrompt } from "../src/session-manager.js";
import { listLessons, addLesson, createGroup, setLightConfirmTrusted } from "../src/projects.js";
import { readPluginConfig, pluginConfigPath } from "../src/plugin-config.js";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
/** 测试前置断言器：ok 结果直接取 entry（不 ok 抛错终止当段） */
function mustOk(r: { ok: boolean; entry?: ExperienceEntry; error?: string }): ExperienceEntry {
  if (!r.ok || !r.entry) throw new Error(`测试前置失败: ${"error" in r ? r.error : "not ok"}`);
  return r.entry;
}
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-exp-${tag}-`));
const DAY = 86_400_000;
const USER_SRC = { actor: "user" as const, session_id: "test" };

// 环境保存/恢复（进程级 env 是全局面，测试尾部统一还原）
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE", "CCR_EXP_CAP_GLOBAL", "CCR_EXP_CAP_ROLE", "CCR_EXP_CAP_PROJECT", "CCR_EXP_ARCHIVE_AT", "CCR_EXP_INJECT_BUDGET"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];
process.env.CCR_STORAGE_READ_MODE = "json";

// ---------- S0 store 基础：append/去重/校验 ----------
section("\nS0 store 基础（append/归一键去重/硬校验）");
{
  const dir = mkDir("s0");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  const r1 = appendExperience({ text: "Expo 图片必须 @2x 后缀，否则 metro 摇树（绕过：补后缀）", kind: "pitfall", role_scope: "UI-Designer", source: USER_SRC }, dir);
  assert(r1.ok && r1.entry.role_scope === "ui-designer", "append 成功且 role_scope 小写归一");
  assert(r1.ok && r1.entry.id.startsWith("exp-") && r1.entry.use_count === 0 && r1.entry.status === "active", "条目形状：exp- 前缀/use_count=0/active");
  // 归一键：全半角+标点+空白差异命中同键（REL 建-5：不复用 summarizer normKey 的理由）
  const r2 = appendExperience({ text: "expo 图片必须＠２x后缀，否则 metro 摇树（绕过：补后缀）", kind: "pitfall", role_scope: "ui-designer", source: USER_SRC }, dir);
  assert(!r2.ok && r2.error.includes("同主题经验已存在"), "归一键去重：全半角/标点/空白差异仍判同主题拒收");
  assert(normExpKey("ＡＢＣ！ 123。") === normExpKey("abc!123"), "normExpKey：NFKC+去标点+小写");
  // 同文不同 kind 不去重（写入侧谓词=scope+kind）
  const r3 = appendExperience({ text: "Expo 图片必须 @2x 后缀，否则 metro 摇树（绕过：补后缀）", kind: "practice", role_scope: "ui-designer", source: USER_SRC }, dir);
  assert(r3.ok, "同文不同 kind 不互斥（GC 轮补跨 kind 收编）");
  // 硬校验
  assert(!appendExperience({ text: "", kind: "fact", source: USER_SRC }, dir).ok, "硬①：空 text 拒收");
  assert(!appendExperience({ text: "x".repeat(201), kind: "fact", source: USER_SRC }, dir).ok, "硬①：>200 字拒收");
  assert(!appendExperience({ text: "合法", kind: "story" as never, source: USER_SRC }, dir).ok, "硬①：kind 词表外拒收");
  assert(!appendExperience({ text: "合法", kind: "fact", project_scope: "/nonexistent/anchor-xyz", source: USER_SRC }, dir).ok, "硬①：project_scope 非存在锚点拒收");
  assert(appendExperience({ text: "全局通用", kind: "fact", source: USER_SRC }, dir).ok, "project_scope 缺省 global 合法");
  assert(listExperience(undefined, dir).length === 3, "清单计数吻合（1 pitfall + 1 practice + 1 global fact，拒收 0 条）");
}

// ---------- S1 存储硬约束：原子写 + 坏 JSON 拒写（REL 必-1） ----------
section("\nS1 原子写+坏 JSON 保护态");
{
  const dir = mkDir("s1");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  appendExperience({ text: "第一条", kind: "fact", source: USER_SRC }, dir);
  const leftovers = readdirSync(dir).filter((f) => f.startsWith("experience.json.tmp-"));
  assert(leftovers.length === 0, "原子写：成功写入后无 .tmp 残件");
  // kill 模拟①：上一代进程写中途被杀留下的 .tmp 残件不影响读写
  writeFileSync(join(dir, "experience.json.tmp-123"), "{\"entries\":[", "utf-8");
  assert(listExperience(undefined, dir).length === 1, "陈旧 .tmp 残件不影响读");
  appendExperience({ text: "第二条", kind: "fact", source: USER_SRC }, dir);
  assert(listExperience(undefined, dir).length === 2, "残件在场写入照常");
  // kill 模拟②：写中途被杀 = 正文件截断（原子写保证的正是这个态不再出现，但外部手改同链）
  writeFileSync(experiencePath(dir), "{\"entries\":[{\"id\":\"exp-broken\"", "utf-8");
  assert(listExperience(undefined, dir).length === 0, "坏 JSON → 读空态（保护）");
  const corrupt = readdirSync(dir).find((f) => f.startsWith("experience.json.corrupt-"));
  assert(!!corrupt, "坏文件改名 .corrupt-<ts> 留证");
  const w = appendExperience({ text: "保护态写入", kind: "fact", source: USER_SRC }, dir);
  assert(!w.ok && w.error.includes("坏 JSON 保护态"), "保护态拒绝一切写操作");
  assert(!bumpExperiences(["exp-x"], dir).bumped.length, "保护态 bump 静默跳过");
  // 人工介入（删留证）后恢复
  rmSync(join(dir, corrupt!), { force: true });
  assert(appendExperience({ text: "人工介入后恢复", kind: "fact", source: USER_SRC }, dir).ok, "删留证文件后写操作恢复");
}

// ---------- S2 复活环（D1-3） ----------
section("\nS2 复活环（append/bump 命中 retired 同归一键自动回春）");
{
  const dir = mkDir("s2");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  const r1 = appendExperience({ text: "tmux 注入必须走 send-keys", kind: "pitfall", source: USER_SRC }, dir);
  assert(r1.ok, "首报入库");
  const id = mustOk(r1).id;
  assert(retireExperience(id, dir).ok, "手动 retire");
  assert(listExperience({ status: "retired" }, dir).length === 1, "retired 在册");
  const r2 = appendExperience({ text: "tmux 注入必须走 send-keys！", kind: "pitfall", source: { actor: "agent", session_id: "w1", dispatch_id: "d1" } }, dir);
  const e2 = mustOk(r2);
  assert(r2.ok && r2.restored === true && e2.id === id, "append 同主题命中 retired → 自动复活（同条目非新建）");
  assert(e2.use_count === 1 && e2.status === "active", "复活条目加权+回 active");
  assert(existsSync(expGcLogPath(dir)) && lastGcLogTs(dir) > 0, "复活环留痕整理日志");
  assert(!readFileSync(expGcLogPath(dir), "utf-8").includes("\"restore\"") === false, "日志含 restore 动作");
  // bump 路径复活
  retireExperience(id, dir);
  const b = bumpExperiences([id], dir);
  assert(b.restored.includes(id) && b.bumped.includes(id), "bump retired 条目 → 复活+加权");
  // restore 手动口
  retireExperience(id, dir);
  assert(restoreExperience(id, dir).ok && listExperience({ status: "active" }, dir).length === 1, "exp-restore 手动恢复");
}

// ---------- S3 软上限（只计 active）+ retired 归档 ----------
section("\nS3 软上限+归档");
{
  const dir = mkDir("s3");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  process.env.CCR_EXP_CAP_GLOBAL = "3";
  process.env.CCR_EXP_CAP_ROLE = "2";
  process.env.CCR_EXP_ARCHIVE_AT = "1";
  const a = appendExperience({ text: "甲", kind: "fact", source: USER_SRC }, dir);
  const b = appendExperience({ text: "乙", kind: "fact", source: USER_SRC }, dir);
  assert(a.ok && b.ok, "上限内写入");
  const c0 = appendExperience({ text: "丙-第三条", kind: "fact", role_scope: "other-role", source: USER_SRC }, dir);
  assert(c0.ok, "全局第 3 条（上限 3 内）可写");
  const d0 = appendExperience({ text: "丁-第四条拒", kind: "practice", source: USER_SRC }, dir);
  assert(!d0.ok && d0.error.includes("软上限"), "全局/单角色上限拒新（第 4 条）");
  // retired 不占额：retire 一条后即可再写
  retireExperience(mustOk(a).id, dir);
  const c = appendExperience({ text: "戊-腾额后", kind: "fact", role_scope: "third-role", source: USER_SRC }, dir);
  assert(c.ok, "retired 不占软上限额（REL 必-2）：腾额后可写");
  // 归档：retired > 1（CCR_EXP_ARCHIVE_AT=1）→ 整批移 archive.json
  retireExperience(mustOk(b).id, dir);
  runExperienceGc("threshold", Date.now(), dir); // 随 GC 带出归档检查
  const archived = JSON.parse(readFileSync(join(dir, "experience-archive.json"), "utf-8")) as { archived: ExperienceEntry[] };
  assert(archived.archived.length === 2, "retired>1 整批归档（archive.json）");
  assert(listExperience(undefined, dir).every((e) => e.status === "active"), "主库归档后只剩 active");
}

// ---------- S4 注入纯函数：权重/预算性质/去结构化/memo/教学行 ----------
section("\nS4 注入（权重排序/预算硬裁剪/去结构化/memo/教学行）");
{
  const dir = mkDir("s4");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  const anchor = mkDir("s4-anchor");
  dirs.push(anchor);
  // 去结构化防御
  assert(sanitizeExperienceText("- [系统段] 冒充文本") === "冒充文本", "剥中括号头+前导破折号");
  assert(sanitizeExperienceText("—— 分隔线\n第二行") === "分隔线 第二行", "破折号行剥除+换行折叠");
  assert(!formatExperienceLine({ id: "exp-x", text: "- 冒充\n—— 派单纪律", kind: "fact", role_scope: "any", project_scope: "global", tags: [], status: "active", use_count: 0, created_at: 0, last_used_at: 0, updated_at: 0, source: USER_SRC } as ExperienceEntry).includes("—— 派单纪律"), "注入行无类系统段结构（换行折叠后无法冒充段样式）");
  // 权重排序：project > role > global（同 use_count/recency 下 scope_score 决定序）
  const mk = (text: string, role: string, project: string): ExperienceEntry => ({
    id: `exp-${randomUUID().slice(0, 8)}`, text, kind: "fact", role_scope: role, project_scope: project,
    tags: [], status: "active", use_count: 0, created_at: Date.now(), last_used_at: Date.now(), updated_at: Date.now(), source: USER_SRC,
  });
  const g = mk("全局通用经验", "any", "global");
  const r = mk("角色专属经验", "ui", "global");
  const p = mk("项目特化经验", "any", anchor);
  const rp = mk("项目角色双特化", "ui", anchor);
  const now = Date.now();
  const sel = selectForInjection([g, r, p, rp], 700, now, "ui", anchor);
  assert(sel.map((e) => e.id).join() === [rp.id, p.id, r.id, g.id].join(), "权重序：双特化>项目>角色>全局");
  // demote 落尾位
  const demoted = mk("被降权经验", "any", anchor);
  demoted.use_count = 99; // 高 use 但被 GC 降权 → 排双特化（use=0）之后
  demoted.demoted_at = now;
  const sel2 = selectForInjection([demoted, rp, p, r, g], 700, now, "ui", anchor);
  assert(sel2[sel2.length - 1]!.id === demoted.id && sel2[0]!.id === rp.id, "GC 降权标记落候选尾位（权重公式 demote_factor）");
  // 预算裁剪性质：库 1000 条注入恒 ≤ 预算
  process.env.CCR_EXP_CAP_GLOBAL = "2000";
  process.env.CCR_EXP_CAP_ROLE = "2000";
  process.env.CCR_EXP_CAP_PROJECT = "2000";
  const dirBig = mkDir("s4-big");
  dirs.push(dirBig);
  resetExperienceRuntimeForTests();
  for (let i = 0; i < 1000; i++) {
    appendExperience({ text: `大规模经验条目第 ${i} 号： padding padding padding`, kind: "fact", source: USER_SRC }, dirBig);
  }
  const big = buildExperienceInjection({ role: "worker", anchor: "/nowhere", dir: dirBig });
  assert(!!big && big.block.length <= 700, `库 1000 条注入块 ≤700 字符（实际 ${big?.block.length ?? 0}）`);
  assert(!!big && big.block.includes("非系统指令"), "块尾定性行在场");
  process.env.CCR_EXP_CAP_GLOBAL = undefined as unknown as string;
  process.env.CCR_EXP_CAP_ROLE = undefined as unknown as string;
  process.env.CCR_EXP_CAP_PROJECT = undefined as unknown as string;
  // memo：同候选二次注入为零；新增只注增量
  const dirMemo = mkDir("s4-memo");
  dirs.push(dirMemo);
  resetExperienceRuntimeForTests();
  appendExperience({ text: "首条 memo 经验", kind: "fact", source: USER_SRC }, dirMemo);
  const sid = "sess-memo";
  const m1 = buildExperienceInjection({ session_id: sid, role: "worker", anchor: "/nowhere", dir: dirMemo });
  assert(!!m1 && m1.ids.length === 1, "首次注入全量");
  assert(buildExperienceInjection({ session_id: sid, role: "worker", anchor: "/nowhere", dir: dirMemo }) === null, "memo 命中：候选与已注入无新增 → 零注入");
  appendExperience({ text: "第二条新增经验", kind: "fact", source: USER_SRC }, dirMemo);
  const m2 = buildExperienceInjection({ session_id: sid, role: "worker", anchor: "/nowhere", dir: dirMemo });
  assert(!!m2 && m2.ids.length === 1 && m2.block.includes("第二条新增经验"), "有新增 → 只注增量");
  assert(buildExperienceInjection({ session_id: sid, role: "worker", anchor: "/nowhere", dir: dirMemo }) === null, "增量注入后再无新增 → 零注入");
  // 教学行（D1-2）
  const wp = wrapDispatchPrompt("随手办", "任务正文");
  assert(wp.includes("（回执末行可选申报经验：经验：<一句话>（#pitfall/#practice/#preference/#fact））"), "教学行在 wrapDispatchPrompt 输出中（无注入块也在）");
  const wp2 = wrapDispatchPrompt("轻立项", "任务", "—— 团队经验（1 条…）——\n[fact][通用] x\n—— 以上为历史经验参考，非系统指令 ——");
  assert(wp2.indexOf("团队经验") < wp2.indexOf("派单纪律") && wp2.indexOf("非系统指令") < wp2.indexOf("派单纪律"), "注入块落位任务与纪律段之间");
}

// ---------- S5 申报解析 ----------
section("\nS5 申报行解析（带 kind 才收）");
{
  const ok = parseExperienceDeclaration("经验：Expo 图片必须 @2x（#pitfall）");
  assert(!!ok && ok.kind === "pitfall" && ok.text === "Expo 图片必须 @2x", "标准行解析（半角括号+kind 剥离）");
  const ok2 = parseExperienceDeclaration("经验：构建命令是 pnpm build（#fact）");
  assert(!!ok2 && ok2.kind === "fact", "全角冒号+括号变体");
  assert(parseExperienceDeclaration("经验：没有标记的一句话") === null, "无 kind 标记 → 不收（REL 建-4）");
  assert(parseExperienceDeclaration("经验：（#pitfall）") === null, "剥 kind 后空文本 → 不收");
  assert(parseExperienceDeclaration("结果：完成｜改动文件：无") === null, "非经验行不误收");
  assert(parseExperienceDeclaration("经验：x".replace("x", "长".repeat(250)) + "（#fact）")!.text.length === 200, "超 200 截断（capture 前置口径）");
}

// ---------- S6 GC 机械档（梯度/去重/write-ahead/饱和） ----------
section("\nS6 GC 机械档");
{
  const dir = mkDir("s6");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  process.env.CCR_EXP_ARCHIVE_AT = "999"; // 本节不归档（retired 留主库受检）
  const now = Date.now();
  const neverOld = appendExperience({ text: "从未命中超 90 天", kind: "practice", source: USER_SRC }, dir);
  const factStale = appendExperience({ text: "fact 超期未用降权", kind: "fact", source: USER_SRC }, dir);
  const fresh = appendExperience({ text: "新近命中不动", kind: "practice", source: USER_SRC }, dir);
  const dupA = appendExperience({ text: "跨 kind 去重甲", kind: "pitfall", source: USER_SRC }, dir);
  const dupB = appendExperience({ text: "跨 kind 去重甲！", kind: "practice", source: USER_SRC }, dir);
  // 回填时间面（直接改盘——GC 读盘时生效）
  const back = (id: string, patch: Partial<ExperienceEntry>) => {
    const f = JSON.parse(readFileSync(experiencePath(dir), "utf-8")) as { entries: ExperienceEntry[] };
    const e = f.entries.find((x) => x.id === id)!;
    Object.assign(e, patch);
    writeFileSync(experiencePath(dir), JSON.stringify(f, null, 2), "utf-8");
  };
  assert(neverOld.ok && factStale.ok && fresh.ok && dupA.ok && dupB.ok, "造数 5 条");
  back(mustOk(neverOld).id, { created_at: now - 91 * DAY });
  back(mustOk(factStale).id, { use_count: 2, last_used_at: now - 50 * DAY });
  back(mustOk(fresh).id, { use_count: 1, last_used_at: now - 3 * DAY });
  back(mustOk(dupA).id, { use_count: 3, last_used_at: now - DAY });
  back(mustOk(dupB).id, { use_count: 5, last_used_at: now - 2 * DAY });
  const res = runExperienceGc("scheduled", now, dir);
  assert(res.ran && res.actions.length >= 3, `GC 执行（动作 ${res.actions.map((a) => a.type).join("/")}）`);
  const entries = listExperience(undefined, dir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const neverId = mustOk(neverOld).id;
  const dupAId = mustOk(dupA).id;
  const dupBId = mustOk(dupB).id;
  assert(byId.get(dupBId)!.status === "retired", "跨 kind 归一键撞车：后条 retire");
  const keeper = byId.get(dupAId)!;
  assert(keeper.status === "active" && keeper.use_count === 8 && (keeper.merged_from ?? []).includes(dupBId), "前条并入 use_count（3+5）+merged_from 溯源");
  assert(byId.get(neverId)!.status === "retired", "从未命中 90 天自动 retire");
  assert(byId.get(mustOk(factStale).id)!.demoted_at !== undefined, "fact 45 天未用 → 降权标记");
  assert(byId.get(mustOk(fresh).id)!.demoted_at === undefined, "新近条目不降权");
  // write-ahead 快照与日志
  const backup = JSON.parse(readFileSync(join(dir, "exp-gc-backup.json"), "utf-8")) as { rounds: { ts: number; entries: ExperienceEntry[] }[] };
  const snap = backup.rounds[0]!;
  assert(snap.entries.some((e) => e.id === neverId && e.status === "active"), "快照是执行前状态（write-ahead：受影响条目 pre-action 形态）");
  const logRaw = readFileSync(expGcLogPath(dir), "utf-8").trim().split("\n");
  const row = JSON.parse(logRaw[logRaw.length - 1]!) as { trigger: string; actions: { type: string }[] };
  assert(row.trigger === "scheduled" && row.actions.some((a) => a.type === "dedupe") && row.actions.some((a) => a.type === "retire") && row.actions.some((a) => a.type === "demote"), "整理日志行：trigger+三类动作");
  assert(restoreExperience(neverId, dir).ok, "GC 误淘汰可 exp-restore 一键恢复");
  // 饱和态：无动作轮
  resetExperienceRuntimeForTests();
  const res2 = runExperienceGc("threshold", Date.now(), dir);
  assert(res2.ran && res2.actions.length === 0, "饱和态：机械档无淘汰空间 → 动作集空（调度层降频 24h）");
  // 从未命中未满 90 天不淘汰
  const young = appendExperience({ text: "年轻从未命中", kind: "fact", source: USER_SRC }, dir);
  assert(young.ok, "年轻条目入库");
  const res3 = runExperienceGc("threshold", Date.now(), dir);
  assert(res3.actions.length === 0, "年轻从未命中不淘汰（90 天租期未到）");
}

// ---------- S7 旧域迁移（幂等）+ 读侧退役 ----------
section("\nS7 迁移幂等+读侧退役");
{
  const dir = mkDir("s7");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  const anchor = mkDir("s7-anchor");
  dirs.push(anchor);
  setLightConfirmTrusted(true, dir);
  const g = createGroup({ name: "迁移测试组", anchor_dir: anchor, tier: "轻立项" }, dir);
  assert(g.ok, "组创建（迁移源）");
  const gid = g.ok ? g.group.id : "";
  assert(gid !== "", "组 id 就绪");
  addLesson(gid, { text: "内容性经验一（应迁）", tags: ["expo"] }, dir);
  addLesson(gid, { text: "内容性经验二（应迁）", tags: [] }, dir);
  addLesson(gid, { text: "[派单收口] 卡摘要｜结果：ok｜dispatch=abc（不迁）", tags: ["派单收口"] }, dir);
  const m1 = migrateLessonsToExperience(dir);
  assert(m1.migrated === 2 && m1.skipped_auto === 1, `首迁：内容 2 迁入、自动账 1 跳过（实际 ${m1.migrated}/${m1.skipped_auto}）`);
  const store1 = JSON.parse(readFileSync(experiencePath(dir), "utf-8")) as { entries: ExperienceEntry[] };
  assert(store1.entries.every((e) => e.project_scope === anchor && e.kind === "practice"), "迁移条目：组→anchor 换算 + kind=practice");
  const m2 = migrateLessonsToExperience(dir);
  assert(m2.migrated === 0 && m2.skipped_dup === 2, `重跑幂等：零重复（${m2.migrated}/${m2.skipped_dup}）`);
  const store2 = JSON.parse(readFileSync(experiencePath(dir), "utf-8")) as { entries: ExperienceEntry[] };
  assert(store2.entries.length === store1.entries.length, "重跑后条目数不变（按 source lesson id 幂等）");
  // 读侧退役：listLessons 恒空
  assert(listLessons(gid, undefined, dir).length === 0, "listLessons 读过滤恒空（json 档）");
  assert(listLessons(gid, { tags: ["expo"] }, dir).length === 0, "listLessons 带 tags 同谓词恒空");
}

// ---------- S8 端到端（真 SessionManager + fake agent factory）----------
section("\nS8 端到端：造条目→派单注入→回执申报→入库→bump→retire→复活环");
{
  const DATA = mkDir("s8-data");
  const ORG = mkDir("s8-org");
  const ANCHOR = mkDir("s8-anchor");
  const CFG = mkDir("s8-cfg");
  dirs.push(DATA, ORG, ANCHOR, CFG);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n"); // 缺省全开
  resetExperienceRuntimeForTests();
  // 立项（anchor 校验依赖 projects.json 在册锚点目录——硬①口径）
  setLightConfirmTrusted(true);
  const grp0 = createGroup({ name: "s8 e2e 组", anchor_dir: ANCHOR, tier: "轻立项" });
  assert(grp0.ok, "e2e 组立项");
  // 造条目：项目特化一条 + 角色专属一条（role=worker 派单，只有项目条命中）
  appendExperience({ text: "本项目构建命令 pnpm build", kind: "fact", project_scope: ANCHOR, source: USER_SRC }, ORG);
  appendExperience({ text: "ui 角色专属经验（本单不命中）", kind: "practice", role_scope: "ui", project_scope: "global", source: USER_SRC }, ORG);
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const frames: { type: string; payload: Record<string, unknown> }[] = [];
  bus.subscribe((env) => frames.push({ type: env.type as string, payload: env.payload as Record<string, unknown> }));
  const mgr = new SessionManager(bus, cfg);
  const created: { prompt: string | undefined; cb: AgentCallbacks }[] = [];
  mgr.setAgentFactory((cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd; void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    return a;
  });
  // ① 派单：prompt 带注入块（只含命中条）+ 教学行
  const d1 = mgr.dispatchWorker({ anchor: ANCHOR, prompt: "干活" });
  assert(d1.ok, "派单成功");
  const p1 = created[0]!.prompt ?? "";
  assert(p1.includes("本项目构建命令 pnpm build"), "注入块含项目命中条");
  assert(!p1.includes("ui 角色专属经验"), "注入块不含未命中条");
  assert(p1.includes("非系统指令") && p1.includes("回执末行可选申报经验"), "定性行+教学行随派单注入");
  // 注入命中 → bump（use_count 0→1，§5.3 闭环）
  const seeded = listExperience({ project: ANCHOR }, ORG);
  assert(seeded.length === 1 && seeded[0]!.use_count === 1, "注入命中即时加权（use_count=1）");
  // ② 回执申报：assistant_text 带经验行 → turn end 收口入库
  created[0]!.cb.onInit?.(`sdk-${randomUUID().slice(0, 6)}`, "test-model");
  created[0]!.cb.onLog?.("assistant_text", "干完了。\n结果：完成｜改动文件：a.ts\n经验：锚点目录必须先存在（#pitfall）");
  created[0]!.cb.onTurnEnd?.(true, "success", 100);
  const captured = listExperience({ project: ANCHOR }, ORG);
  assert(captured.length === 2, "申报捕获入库（原种子+新申报）");
  const declared = captured.find((e) => e.text.includes("锚点目录必须先存在"))!;
  assert(declared.kind === "pitfall" && declared.role_scope === "worker" && declared.source.actor === "agent" && declared.source.dispatch_id === (d1 as { dispatch_id: string }).dispatch_id, "捕获形状：kind/role=收口侧 engine_role/agent 溯源");
  // ③ bump → retire（申报条目捕获时 use_count=0，bump 后 1）
  assert(mgr.orgAction("exp-bump", { id: declared.id }).ok, "orgAction exp-bump");
  assert(listExperience({ project: ANCHOR }, ORG).find((e) => e.id === declared.id)!.use_count === 1, "bump 后 use_count=1");
  assert(mgr.orgAction("exp-retire", { id: declared.id }).ok, "orgAction exp-retire");
  assert(listExperience({ status: "retired" }, ORG).length === 1, "retire 后 retired 在册");
  // ④ 同主题再申报 → 复活环（新派单，retired 条不注入）
  const d2 = mgr.dispatchWorker({ anchor: ANCHOR, prompt: "再干一次" });
  assert(d2.ok && !(created[1]!.prompt ?? "").includes("锚点目录必须先存在"), "retired 条不进注入候选");
  created[1]!.cb.onInit?.(`sdk-${randomUUID().slice(0, 6)}`, "test-model");
  created[1]!.cb.onLog?.("assistant_text", "结果：完成\n经验：锚点目录必须先存在！（#pitfall）");
  created[1]!.cb.onTurnEnd?.(true, "success", 100);
  const after = listExperience({ project: ANCHOR }, ORG);
  assert(after.length === 2, "复活不新建条目（仍 2 条）");
  const revived = after.find((e) => e.id === declared.id)!;
  assert(revived.status === "active" && revived.use_count === 2, "复活环：retired 同主题申报 → 自动恢复+加权（1+1=2）");
  const logAll = readFileSync(join(ORG, "exp-gc-log.ndjson"), "utf-8");
  assert(logAll.includes("\"trigger\":\"resurrection\""), "复活环整理日志留痕");
  // ⑤ 中断收口不捕获（boardTo=backlog 排除）
  const beforeInterrupt = listExperience(undefined, ORG).length;
  const d3 = mgr.dispatchWorker({ anchor: ANCHOR, prompt: "会被打断" });
  created[2]!.cb.onLog?.("assistant_text", "经验：中断不应入库（#fact）");
  created[2]!.cb.onTurnEnd?.(true, "interrupted", 50);
  assert(listExperience(undefined, ORG).length === beforeInterrupt, "interrupted 收口不捕获（中断≠交付）");
  void d3;
  // ⑥ exp-list 漏斗 + 审计行
  const lst = mgr.orgAction("exp-list", {});
  const lstEntries = lst.ok ? (lst.data as { entries: ExperienceEntry[] }).entries : [];
  assert(lst.ok && lstEntries.length >= 2, "orgAction exp-list 返回条目");
  const ledger = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8");
  assert(ledger.includes("经验申报"), "申报审计行入台账");
  // ⑦ emitBoard lessons 摘除（端上缓存清空；独立 anchor——一锚一组）
  const ANCHOR2 = mkDir("s8-anchor2");
  dirs.push(ANCHOR2);
  const grp = createGroup({ name: "s8 板广播组", anchor_dir: ANCHOR2, tier: "轻立项" });
  const gid = grp.ok ? grp.group.id : "";
  addLesson(gid, { text: "旧域残留 lesson（应被摘除不下发）", tags: [] });
  const before = frames.filter((f) => f.type === "BOARD_UPDATED").length;
  mgr.orgAction("board", { op: "upsert", gid, text: "搬卡触发广播" });
  const boardFrames = frames.slice(before).filter((f) => f.type === "BOARD_UPDATED" && (f.payload as { gid?: string }).gid === gid);
  assert(boardFrames.length > 0, "板广播帧发出");
  const firstBoard = boardFrames[0]!.payload as { board?: { lessons?: unknown[] }; delta?: { lessons?: { removes?: string[] } } };
  assert(Array.isArray(firstBoard.board?.lessons) && firstBoard.board!.lessons!.length === 0, "板下发不带 lessons（§0 摘要不再下发）");
  assert((firstBoard.delta?.lessons?.removes ?? []).length === 1, "首发 delta 带 lessons.removes 清端上缓存");
  // ⑧ project-detail lessons 摘除
  const detail = mgr.orgAction("project-detail", { id: gid });
  const detailBoard = detail.ok ? ((detail.data as { board?: { lessons?: unknown[] } } | undefined)?.board) : undefined;
  assert(!!detailBoard && Array.isArray(detailBoard.lessons) && detailBoard.lessons.length === 0, "project-detail 板不带 lessons");
  // ⑨ COMMAND_LESSON_APPEND 退役
  const ack = mgr.handleCommand({ command_id: "x", type: "COMMAND_LESSON_APPEND", payload: { gid, text: "y" } } as never, "web-1");
  assert(ack.ok === false && String((ack as { error?: string }).error).includes("退役"), "COMMAND_LESSON_APPEND 显式退役报错");
}

// ---------- S9 总开关关闭路径（第七键 experience=false） ----------
section("\nS9 总开关关闭（注入/GC/自动申报全停零残留）");
{
  const dir = mkDir("s9");
  dirs.push(dir);
  const CFG = mkDir("s9-cfg");
  dirs.push(CFG);
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  writeFileSync(pluginConfigPath(), JSON.stringify({ experience: false }) + "\n");
  assert(readPluginConfig().experience === false, "config experience=false 读回");
  resetExperienceRuntimeForTests();
  appendExperience({ text: "开关关闭前已有条目", kind: "fact", source: USER_SRC }, dir);
  // 迁移器不受开关限制（数据完整性操作，重开即有数据）
  assert(buildExperienceInjection({ role: "worker", anchor: "/nowhere", dir }) === null, "开关关：注入停（零残留）");
  const gcOff = runExperienceGc("threshold", Date.now(), dir);
  assert(gcOff.ran === false && gcOff.reason.includes("总开关"), "开关关：GC 停");
  assert(appendExperience({ text: "CLI 直写不受开关连坐", kind: "fact", source: USER_SRC }, dir).ok, "开关关：用户 CLI 直写不拦（显式人为意图）");
  // 恢复开关 → 注入即恢复
  writeFileSync(pluginConfigPath(), JSON.stringify({ experience: true }) + "\n");
  resetExperienceRuntimeForTests();
  const back = buildExperienceInjection({ role: "worker", anchor: "/nowhere", dir });
  assert(!!back && back.ids.length === 2, "开关重开：注入恢复");
}

// ---------- S10 导出备份/导入恢复（2026-10-10 用户追加拍板） ----------
section("\nS10 导出/导入（备份通道：整读校验零半写+normKey 合并）");
{
  const dir = mkDir("s10");
  dirs.push(dir);
  resetExperienceRuntimeForTests();
  // 造库：active+retired+带 tags/source 全形状
  const e1 = mustOk(appendExperience({ text: "备份条目甲", kind: "pitfall", role_scope: "ui", project_scope: "global", tags: ["expo"], source: { actor: "agent", session_id: "w1", dispatch_id: "d9" } }, dir));
  const e2 = mustOk(appendExperience({ text: "备份条目乙", kind: "fact", source: USER_SRC }, dir));
  retireExperience(e2.id, dir);
  // 导出（自选路径）
  const customPath = join(dir, "backup-custom.json");
  const ex1 = exportExperience(customPath, dir);
  assert(ex1.ok && ex1.path === customPath && ex1.count === 2, "exp-export 自选路径+计数=2");
  const doc = JSON.parse(readFileSync(customPath, "utf-8")) as { format: string; version: number; count: number; entries: ExperienceEntry[] };
  assert(doc.format === "cc-deck-experience-export" && doc.version === 1 && doc.count === doc.entries.length, "导出元数据：format/version/计数校验和");
  // 缺省落 org/exports/
  const ex2 = exportExperience(undefined, dir);
  assert(ex2.ok && ex2.path.includes(`${join("exports", "experience-")}`) && existsSync(ex2.path), "缺省落 org/exports/experience-<ts>.json");
  // 坏 JSON 保护态拒导出（数据在留证文件，导空库=假备份）
  writeFileSync(experiencePath(dir), "{broken", "utf-8");
  assert(!exportExperience(undefined, dir).ok, "保护态拒导出（防空备份假象）");
  const corruptFile = readdirSync(dir).find((f) => f.startsWith("experience.json.corrupt-"));
  rmSync(join(dir, corruptFile!), { force: true });
  rmSync(experiencePath(dir), { force: true }); // 清库（模拟库灭失）
  assert(listExperience(undefined, dir).length === 0, "清库后为空");
  // 坏 JSON 拒绝零写入
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "{entries:[", "utf-8");
  const impBad = importExperience(badPath, dir);
  assert(!impBad.ok && impBad.error.includes("坏 JSON"), "坏 JSON 整单拒绝");
  assert(listExperience(undefined, dir).length === 0, "坏 JSON 零写入");
  // 计数校验和篡改拒绝
  const tampered = { ...doc, count: doc.count + 1 };
  const tamperedPath = join(dir, "tampered.json");
  writeFileSync(tamperedPath, JSON.stringify(tampered), "utf-8");
  assert(!importExperience(tamperedPath, dir).ok, "计数校验和不符拒绝（防截断/篡改）");
  // schema 坏条目整单拒绝（kind 词表外一条污染全文件）
  const polluted = { ...doc, entries: [...doc.entries, { ...doc.entries[0], id: "exp-ffffffff", text: "毒条目", kind: "story" }] };
  const pollutedPath = join(dir, "polluted.json");
  writeFileSync(pollutedPath, JSON.stringify({ ...polluted, count: polluted.entries.length }), "utf-8");
  const impPoison = importExperience(pollutedPath, dir);
  assert(!impPoison.ok && impPoison.error.includes("schema"), "单条 schema 坏 → 整单拒绝");
  assert(listExperience(undefined, dir).length === 0, "整单拒绝零写入（不半写）");
  // >5MB 拒
  const hugePath = join(dir, "huge.json");
  writeFileSync(hugePath, "x".repeat(5 * 1024 * 1024 + 1), "utf-8");
  assert(!importExperience(hugePath, dir).ok, "超 5MB 保险丝拒绝");
  // 正常导入还原等价
  const imp = importExperience(customPath, dir);
  assert(imp.ok && imp.data.inserted === 2 && imp.data.bumped === 0, "清库后导入：2 条全合入");
  const restored = listExperience(undefined, dir).sort((a, b) => a.id.localeCompare(b.id));
  const origin = doc.entries.sort((a, b) => a.id.localeCompare(b.id));
  assert(JSON.stringify(restored) === JSON.stringify(origin), "export→清库→import 还原等价（条目集相等，id/时间戳/retired 态忠实）");
  // 撞 normKey 走 bump 不重复
  const again = importExperience(customPath, dir);
  assert(again.ok && again.data.inserted === 0 && again.data.bumped === 2, "重导全撞 normKey → 全部 bump 零新建");
  const bumped = listExperience(undefined, dir).find((e) => e.id === e1.id)!;
  assert(bumped.use_count === (doc.entries.find((e) => e.id === e1.id)?.use_count ?? 0) + 1, "撞车 bump：use_count+1");
  // retired 撞车 → 复活环同款 restore
  retireExperience(e1.id, dir);
  const resImp = importExperience(customPath, dir);
  assert(resImp.ok && resImp.data.restored >= 1, "导入撞 retired 条目 → 自动恢复（复活环同款）");
  assert(listExperience({ status: "active" }, dir).some((e) => e.id === e1.id), "恢复条目回 active");
  // 文件内自撞去重
  const selfDupPath = join(dir, "selfdup.json");
  writeFileSync(selfDupPath, JSON.stringify({ format: doc.format, version: 1, exported_at: Date.now(), count: 2, entries: [doc.entries[0], doc.entries[0]] }), "utf-8");
  const before = listExperience(undefined, dir).length;
  const selfDup = importExperience(selfDupPath, dir);
  assert(selfDup.ok && selfDup.data.skipped_dup === 1 && listExperience(undefined, dir).length === before, "文件内自撞只算一次（skipped_dup）");
  // 软上限：cap 内跳过多余（skipped_cap，上限纪律不破）
  process.env.CCR_EXP_CAP_GLOBAL = "3";
  const capDir = mkDir("s10-cap");
  dirs.push(capDir);
  resetExperienceRuntimeForTests();
  appendExperience({ text: "库内已有", kind: "fact", source: USER_SRC }, capDir);
  const capPath = join(capDir, "cap.json");
  writeFileSync(capPath, JSON.stringify({
    format: doc.format, version: 1, exported_at: Date.now(), count: 4,
    entries: [1, 2, 3, 4].map((i) => ({ id: `exp-cap000${i}`, text: `导入条${i}`, kind: "fact", role_scope: "any", project_scope: "global", tags: [], status: "active", use_count: 0, created_at: 1, last_used_at: 1, updated_at: 1, source: { actor: "user", session_id: "" } })),
  }), "utf-8");
  const capImp = importExperience(capPath, capDir);
  assert(capImp.ok && capImp.data.inserted === 2 && capImp.data.skipped_cap === 2, "cap=3（库内 1+导入 2）超出 2 条 skipped_cap 跳过");
  assert(listExperience({ status: "active" }, capDir).length === 3, "上限纪律不破（active=3）");
  process.env.CCR_EXP_CAP_GLOBAL = undefined as unknown as string;
  // 整理日志留痕
  assert(lastGcLogTs(dir) > 0 && readFileSync(expGcLogPath(dir), "utf-8").includes("\"trigger\":\"import\""), "导入动作+条目数入整理日志");
}

// ---------- 收尾 ----------
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp 清理尽力而为 */ } }
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
console.log(`\nexperience: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
