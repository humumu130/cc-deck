// #26 矩阵式团队 M2 —— 项目组（project_group）底座：索引 / 跨会话任务板 / 确认单 / 三态状态机。
// 设计稿 docs/v8-team-matrix.html v3.1 §6.1 §6.2 §4：项目组 = 动态层编制单位（锚点目录 + 三态 +
// 编制快照 + 任务板引用）；板 store 为 M2 待建件——现有任务链路严格按 CLI 会话目录隔离
//（task-store.ts），团队协作需要一份所有人共用的项目组级板（单一事实源建 org 侧）。
// 本模块是纯 fs 读写底座，与 org.ts 同范式：不 import session-manager/EventBus（无环）、
// 不走 EventBus 持久化路径（启动时被 compactEvents 整文件重写，破坏审计语义——org.ts 三物理
// 事实同款红线）、坏 JSON 一律容忍为空态（读侧防御，绝不抛）。
//
// 物理布局（org 目录 = 组织资产家，projects 属组织资产）：
//   <orgDir>/projects.json           项目组索引（写穿全量，含分诊信任态）
//   <orgDir>/boards/<gid>.json       项目组任务板（一板一文件）
//   <orgDir>/confirms.json           组织确认单队列（正经立项/升降级/建议暂缓/结项/复活）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { orgDir, readDispatchLog } from "./org.js";

// ---------- 类型 ----------

export type ProjectGroupStatus = "pending" | "active" | "parked" | "archived";
export type ProjectTier = "轻立项" | "正经立项";

export interface ProjectHeadcountEntry {
  session_id: string;
  role: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  /** 项目锚点目录（cwd 硬规则的物理地基，绝对路径；worker spawn 与记忆归层都锚它） */
  anchor_dir: string;
  status: ProjectGroupStatus;
  tier: ProjectTier;
  /** 编制快照（M2 形态 = 1 worker + Leader 兼管；升降级只补不重建） */
  headcount: ProjectHeadcountEntry[];
  /** 轻立项 = 任务板单卡简化态（渲染降级标记，非独立模型） */
  single_card: boolean;
  created_at: number;
  updated_at: number;
  parked_at?: number;
  archived_at?: number;
  /** 结项一句话归档（零异常时）或被否决说明 */
  archive_note?: string;
}

export type BoardEntryStatus = "todo" | "doing" | "verify" | "ready" | "done";

export interface BoardEntry {
  id: string;
  text: string;
  /** 分区 = 渲染端按 status 分组（五段色语义对齐看板规范：灰待认领/绿进行/品牌待验收/琥珀待装机/深完成） */
  status: BoardEntryStatus;
  /** 承接会话（派单联动条目 = worker relay session id） */
  owner_session?: string;
  /** 派单联动条目的台账 id（dispatch 收口时自动搬卡） */
  dispatch_id?: string;
  ts: number;
  updated_at: number;
  note?: string;
}

export interface ProjectBoard {
  gid: string;
  entries: BoardEntry[];
  /** 挂起/结项 = 冻结只读（active 才可写，§2.2 任务板冻结保留） */
  frozen: boolean;
  updated_at: number;
}

export type ConfirmKind =
  | "project-create" // 正经立项必须确认（防误判档烧钱）
  | "tier-change" // 升降级（一句理由 + 增量编制/验收点）
  | "suggest-hold" // 第五态建议暂缓（一句理由 + 触发条件，点头即挂起）
  | "archive" // 结项（附断言核对清单）
  | "revive"; // 复活边（读档重建）

export interface OrgConfirm {
  id: string;
  kind: ConfirmKind;
  title: string;
  /** 一句理由（分诊概率判断的矫正通道都走理由 + 确认） */
  reason: string;
  /** kind 专属载荷：gid / to_tier / increment / checklist 等 */
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  decided_at?: number;
  decided_by?: string;
}

interface ProjectsFile {
  groups: ProjectGroup[];
  /** 轻立项同类免确认的信任态（首次确认一次，信任累积——§4 确认门槛） */
  trust_light: boolean;
}

// ---------- 路径 ----------

function projectsFilePath(dir?: string): string {
  return join(dir ?? orgDir(), "projects.json");
}
function boardsDirPath(dir?: string): string {
  return join(dir ?? orgDir(), "boards");
}
function boardFilePath(gid: string, dir?: string): string {
  return join(boardsDirPath(dir), `${gid}.json`);
}
function confirmsFilePath(dir?: string): string {
  return join(dir ?? orgDir(), "confirms.json");
}

// ---------- 项目组索引 ----------

function readProjectsFile(dir?: string): ProjectsFile {
  try {
    const raw = JSON.parse(readFileSync(projectsFilePath(dir), "utf-8")) as Partial<ProjectsFile>;
    return {
      groups: Array.isArray(raw.groups) ? (raw.groups as ProjectGroup[]) : [],
      trust_light: raw.trust_light === true,
    };
  } catch {
    // 无文件 / 坏 JSON：空态（读侧防御，同 pinned-sessions 口径）
    return { groups: [], trust_light: false };
  }
}

function writeProjectsFile(f: ProjectsFile, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(projectsFilePath(d), JSON.stringify(f, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[projects] 索引写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function listGroups(dir?: string): ProjectGroup[] {
  return readProjectsFile(dir).groups;
}

export function listGroupsByStatus(dir?: string): { active: ProjectGroup[]; parked: ProjectGroup[]; archived: ProjectGroup[]; pending: ProjectGroup[] } {
  const g = listGroups(dir);
  const pick = (s: ProjectGroupStatus) => g.filter((x) => x.status === s);
  return { active: pick("active"), parked: pick("parked"), archived: pick("archived"), pending: pick("pending") };
}

export function findGroup(idOrName: string, dir?: string): ProjectGroup | null {
  const g = listGroups(dir);
  return g.find((x) => x.id === idOrName || x.name === idOrName) ?? null;
}

export function findGroupByAnchor(anchorDir: string, dir?: string): ProjectGroup | null {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return listGroups(dir).find((x) => norm(x.anchor_dir) === norm(anchorDir) && x.status !== "archived") ?? null;
}

export function isLightConfirmTrusted(dir?: string): boolean {
  return readProjectsFile(dir).trust_light;
}

/** 并行项目组上限护栏（活跃台账天然小表——§4 护栏；env 可覆盖便于测试） */
export function maxActiveGroups(): number {
  const n = Number(process.env.CCR_ORG_MAX_GROUPS);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function saveGroup(g: ProjectGroup, dir?: string): boolean {
  const f = readProjectsFile(dir);
  const i = f.groups.findIndex((x) => x.id === g.id);
  if (i >= 0) f.groups[i] = g;
  else f.groups.push(g);
  return writeProjectsFile(f, dir);
}

// 三态状态机（§6.2）：在办⇄挂起（双向）；在办/挂起→结项（单向终态）；结项→在办=复活边；
// pending = 正经立项/首次轻立项的确认前态（确认→active；否决→archived 留痕）。
const TRANSITIONS: Record<ProjectGroupStatus, ProjectGroupStatus[]> = {
  pending: ["active", "archived"],
  active: ["parked", "archived"],
  parked: ["active", "archived"],
  archived: ["active"],
};

export function canTransition(from: ProjectGroupStatus, to: ProjectGroupStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type CreateGroupResult =
  | { ok: true; group: ProjectGroup; needsConfirm: boolean; confirm: OrgConfirm | null }
  | { ok: false; error: string };

/**
 * 立项（分诊档 = 轻立项/正经立项）。确认门槛（§4）：
 * - 正经立项：必须确认（每次）→ 组建为 pending + project-create 确认单，用户 ✓ 才 active；
 * - 轻立项：同类免确认（首次确认一次，信任累积）——信任未建立同走 pending，之后直达 active。
 * 护栏：active 数量达上限拒绝（防止活跃台账失控）。锚点目录被在办/挂起组占用拒绝（一锚一组）。
 */
export function createGroup(
  input: { name: string; anchor_dir: string; tier: ProjectTier; headcount?: ProjectHeadcountEntry[] },
  dir?: string,
): CreateGroupResult {
  const f = readProjectsFile(dir);
  const activeCount = f.groups.filter((x) => x.status === "active").length;
  if (activeCount >= maxActiveGroups()) {
    return { ok: false, error: `并行项目组已达上限 ${maxActiveGroups()}（护栏），先结项或挂起再立项` };
  }
  const clash = findGroupByAnchor(input.anchor_dir, dir);
  if (clash) {
    return { ok: false, error: `锚点目录已被项目组「${clash.name}」占用（${clash.status}），一锚一组` };
  }
  const now = Date.now();
  const needsConfirm = input.tier === "正经立项" || !f.trust_light;
  const group: ProjectGroup = {
    id: `pg-${randomUUID().slice(0, 8)}`,
    name: input.name,
    anchor_dir: input.anchor_dir,
    status: needsConfirm ? "pending" : "active",
    tier: input.tier,
    headcount: input.headcount ?? [],
    single_card: input.tier === "轻立项",
    created_at: now,
    updated_at: now,
  };
  if (!saveGroup(group, dir)) return { ok: false, error: "索引写入失败" };
  let confirm: OrgConfirm | null = null;
  if (needsConfirm) {
    confirm = addConfirm(
      {
        kind: "project-create",
        title: `立项确认：${group.name}`,
        reason: input.tier === "正经立项" ? "正经立项必须确认（一次点击，防误判档烧钱）" : "轻立项首次确认一次（同类免确认，信任累积）",
        payload: { gid: group.id, tier: group.tier, anchor_dir: group.anchor_dir },
      },
      dir,
    );
  }
  return { ok: true, group, needsConfirm, confirm };
}

export type TransitionResult = { ok: true; group: ProjectGroup } | { ok: false; error: string };

export function setGroupStatus(id: string, to: ProjectGroupStatus, note?: string, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === id || x.name === id);
  if (!g) return { ok: false, error: `项目组不存在: ${id}` };
  if (g.status === to) return { ok: true, group: g };
  if (!canTransition(g.status, to)) {
    return { ok: false, error: `非法转移 ${g.status} → ${to}（§6.2 状态机）` };
  }
  if (to === "active") {
    const activeCount = f.groups.filter((x) => x.status === "active").length;
    if (activeCount >= maxActiveGroups()) {
      return { ok: false, error: `并行项目组已达上限 ${maxActiveGroups()}（护栏）` };
    }
  }
  const now = Date.now();
  g.status = to;
  g.updated_at = now;
  if (to === "parked") g.parked_at = now;
  if (to === "archived") {
    g.archived_at = now;
    if (note) g.archive_note = note;
  }
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  freezeBoard(g.id, to !== "active", dir);
  return { ok: true, group: g };
}

/** 升降级（§4）：档间可迁移，任务卡与 worktree 原地继承、只补不重建（M2 无 worktree 供给线，语义=只改档位标记） */
export function setGroupTier(id: string, to: ProjectTier, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === id || x.name === id);
  if (!g) return { ok: false, error: `项目组不存在: ${id}` };
  if (g.tier === to) return { ok: true, group: g };
  g.tier = to;
  g.single_card = to === "轻立项";
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

export function addMember(gid: string, sessionId: string, role: string, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  if (!g.headcount.some((h) => h.session_id === sessionId)) {
    g.headcount.push({ session_id: sessionId, role });
    g.updated_at = Date.now();
    if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  }
  return { ok: true, group: g };
}

export function removeMember(gid: string, sessionId: string, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  g.headcount = g.headcount.filter((h) => h.session_id !== sessionId);
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

// ---------- 任务板（跨会话项目组级，M2 待建件） ----------

function loadBoardFile(gid: string, dir?: string): ProjectBoard {
  try {
    const raw = JSON.parse(readFileSync(boardFilePath(gid, dir), "utf-8")) as Partial<ProjectBoard>;
    return {
      gid,
      entries: Array.isArray(raw.entries) ? (raw.entries as BoardEntry[]) : [],
      frozen: raw.frozen === true,
      updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    };
  } catch {
    return { gid, entries: [], frozen: false, updated_at: 0 };
  }
}

function saveBoardFile(b: ProjectBoard, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(boardsDirPath(d), { recursive: true });
    writeFileSync(boardFilePath(b.gid, d), JSON.stringify(b, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[projects] 板写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function loadBoard(gid: string, dir?: string): ProjectBoard {
  return loadBoardFile(gid, dir);
}

/** 板写入前置校验：组须存在且 active（挂起=冻结保留、结项=归档只读，§2.2） */
function writableBoard(gid: string, dir?: string): { ok: true; board: ProjectBoard } | { ok: false; error: string } {
  const g = listGroups(dir).find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  if (g.status !== "active") return { ok: false, error: `任务板已冻结（项目组 ${g.status}），恢复在办后可写` };
  const b = loadBoardFile(gid, dir);
  if (b.frozen) return { ok: false, error: "任务板已冻结（frozen 标记）" };
  return { ok: true, board: b };
}

function freezeBoard(gid: string, frozen: boolean, dir?: string): void {
  const b = loadBoardFile(gid, dir);
  if (b.frozen === frozen) return;
  b.frozen = frozen;
  b.updated_at = Date.now();
  saveBoardFile(b, dir);
}

export function upsertBoardEntry(
  gid: string,
  entry: { id?: string; text: string; status?: BoardEntryStatus; owner_session?: string; dispatch_id?: string; note?: string },
  dir?: string,
): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const now = Date.now();
  let e: BoardEntry | undefined = entry.id ? w.board.entries.find((x) => x.id === entry.id) : undefined;
  if (e) {
    e.text = entry.text;
    if (entry.status) e.status = entry.status;
    if (entry.owner_session !== undefined) e.owner_session = entry.owner_session;
    if (entry.dispatch_id !== undefined) e.dispatch_id = entry.dispatch_id;
    if (entry.note !== undefined) e.note = entry.note;
    e.updated_at = now;
  } else {
    e = {
      id: entry.id ?? `t-${randomUUID().slice(0, 8)}`,
      text: entry.text,
      status: entry.status ?? "todo",
      owner_session: entry.owner_session,
      dispatch_id: entry.dispatch_id,
      ts: now,
      updated_at: now,
      note: entry.note,
    };
    w.board.entries.push(e);
  }
  w.board.updated_at = now;
  if (!saveBoardFile(w.board, dir)) return { ok: false, error: "板写入失败" };
  return { ok: true, entry: e };
}

export function moveBoardEntry(
  gid: string,
  entryId: string,
  to: BoardEntryStatus,
  dir?: string,
): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const e = w.board.entries.find((x) => x.id === entryId);
  if (!e) return { ok: false, error: `板条目不存在: ${entryId}` };
  e.status = to;
  e.updated_at = Date.now();
  w.board.updated_at = e.updated_at;
  if (!saveBoardFile(w.board, dir)) return { ok: false, error: "板写入失败" };
  return { ok: true, entry: e };
}

export function removeBoardEntry(gid: string, entryId: string, dir?: string): { ok: true } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const before = w.board.entries.length;
  w.board.entries = w.board.entries.filter((x) => x.id !== entryId);
  if (w.board.entries.length === before) return { ok: false, error: `板条目不存在: ${entryId}` };
  w.board.updated_at = Date.now();
  if (!saveBoardFile(w.board, dir)) return { ok: false, error: "板写入失败" };
  return { ok: true };
}

/** 派单联动搬卡：按台账 id 找条目改状态（dispatch 收口 onTurnEnd 调用；无对应条目 = no-op 不报错） */
export function moveEntryByDispatch(gid: string, dispatchId: string, to: BoardEntryStatus, dir?: string): void {
  const w = writableBoard(gid, dir);
  if (!w.ok) return;
  const e = w.board.entries.find((x) => x.dispatch_id === dispatchId);
  if (!e || e.status === to) return;
  e.status = to;
  e.updated_at = Date.now();
  w.board.updated_at = e.updated_at;
  saveBoardFile(w.board, dir);
}

// ---------- 确认单（人类决策队列，持久化；不复用 waiting_request——其生命周期与回合强耦合
// 且多处无条件清空，立项确认是分钟~小时级决策，§4 确认门槛） ----------

function readConfirms(dir?: string): OrgConfirm[] {
  try {
    const raw = JSON.parse(readFileSync(confirmsFilePath(dir), "utf-8")) as { confirms?: OrgConfirm[] };
    return Array.isArray(raw.confirms) ? raw.confirms : [];
  } catch {
    return [];
  }
}

function writeConfirms(list: OrgConfirm[], dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    // 只留最近 200 条已决 + 全部 pending（确认历史是审计面但不无限涨）
    const pending = list.filter((c) => c.status === "pending");
    const decided = list.filter((c) => c.status !== "pending").slice(-200);
    writeFileSync(confirmsFilePath(d), JSON.stringify({ confirms: [...pending, ...decided] }, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[projects] 确认单写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function listConfirms(dir?: string): OrgConfirm[] {
  return readConfirms(dir);
}

export function listPendingConfirms(dir?: string): OrgConfirm[] {
  return readConfirms(dir).filter((c) => c.status === "pending");
}

export function addConfirm(
  input: { kind: ConfirmKind; title: string; reason: string; payload?: Record<string, unknown> },
  dir?: string,
): OrgConfirm {
  const c: OrgConfirm = {
    id: `cf-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    payload: input.payload ?? {},
    status: "pending",
    created_at: Date.now(),
  };
  const list = readConfirms(dir);
  list.push(c);
  writeConfirms(list, dir);
  return c;
}

export type DecideResult = { ok: true; confirm: OrgConfirm } | { ok: false; error: string };

/** 决议确认单（一次性的：已决不可再决）。副作用（组状态迁移/信任累积）由调用方执行——
 * 本函数只管决策记录，保证决议与执行分离可审计。 */
export function decideConfirm(id: string, approve: boolean, by: string, dir?: string): DecideResult {
  const list = readConfirms(dir);
  const c = list.find((x) => x.id === id);
  if (!c) return { ok: false, error: `确认单不存在: ${id}` };
  if (c.status !== "pending") return { ok: false, error: `确认单已决议（${c.status}），不可再决` };
  c.status = approve ? "approved" : "rejected";
  c.decided_at = Date.now();
  c.decided_by = by;
  if (!writeConfirms(list, dir)) return { ok: false, error: "确认单写入失败" };
  return { ok: true, confirm: c };
}

// ---------- 文档防漂移（§3.4：纪律载体 = 立项时生成项目 CLAUDE.md） ----------

export const PROJECT_CLAUDE_MD_SEED_PREFIX = "# 项目 CLAUDE.md —— 防漂移纪律";

export function projectClaudeMdSeed(name: string): string {
  return `${PROJECT_CLAUDE_MD_SEED_PREFIX}（${name}）

> 矩阵式组织立项时自动生成（幂等种子：已存在则不动）。本文件随会话自动加载，普通会话也覆盖。

## 防漂移条款（设计稿 §3.4）

- **spec 与代码同权走 git**：spec / prd / 决策记录的改动进同一 commit，回执「改动文件」自然体现——不设附带物、不加确认。
- **改一字亦须报**：动到本目录任何文档的改动，回执中必须列出改动文件。
- **结项归档前断言级核对**：先 \`git log --follow\` 机械清账无回执变更，再逐断言查代码；零异常一句话归档，有异常出漂移清单走验收单逐条裁决。
- **你本人直改天然合法**，不入核对异常。
- **红线**：不做段落级映射与覆盖率统计（防滑坡）。
`;
}

/** 幂等种子：只在无 CLAUDE.md 时写（用户或先前的立项可能已有内容，存在即认，绝不覆盖） */
export function ensureProjectClaudeMd(anchorDir: string, name: string): "created" | "exists" | "error" {
  try {
    const p = join(anchorDir, "CLAUDE.md");
    if (existsSync(p)) return "exists";
    mkdirSync(anchorDir, { recursive: true });
    writeFileSync(p, projectClaudeMdSeed(name), "utf-8");
    return "created";
  } catch (e) {
    console.warn(`[projects] 项目 CLAUDE.md 种子失败: ${e instanceof Error ? e.message : String(e)}`);
    return "error";
  }
}

// ---------- 结项断言核对清单（§3.4 结项归档前；清单生成，断言逐条核对由 Leader/人执行） ----------

export interface ArchiveChecklist {
  gid: string;
  name: string;
  /** 未收口派单（running/dispatched 悬账）——结项前应收口或知情放弃 */
  openDispatches: { id: string; tier: string; status: string; target: string; ts: number }[];
  /** 在编成员会话（结项=解散编制；M2 会话不删档，只解除归属） */
  headcount: ProjectHeadcountEntry[];
  /** 板上未完成条目数（todo/doing/verify/ready） */
  openBoardEntries: number;
  anchor_dir: string;
}

export function buildArchiveChecklist(gid: string, dir?: string): ArchiveChecklist | null {
  const g = listGroups(dir).find((x) => x.id === gid);
  if (!g) return null;
  const openDispatches = readDispatchLog(dir)
    .filter((e) => {
      const anchor = e.project_anchor ?? "";
      return anchor && anchor.replace(/\/+$/, "") === g.anchor_dir.replace(/\/+$/, "") && (e.status === "running" || e.status === "dispatched");
    })
    .map((e) => ({ id: e.id, tier: e.tier, status: e.status, target: e.target, ts: e.ts }));
  const b = loadBoardFile(gid, dir);
  const openBoardEntries = b.entries.filter((x) => x.status !== "done").length;
  return { gid: g.id, name: g.name, openDispatches, headcount: g.headcount, openBoardEntries, anchor_dir: g.anchor_dir };
}

// ---------- 信任累积（轻立项同类免确认） ----------

export function setLightConfirmTrusted(trusted: boolean, dir?: string): void {
  const f = readProjectsFile(dir);
  if (f.trust_light === trusted) return;
  f.trust_light = trusted;
  writeProjectsFile(f, dir);
}
