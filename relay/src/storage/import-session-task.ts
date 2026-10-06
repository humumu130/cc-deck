// ---------- 会话与任务导入器（M11-D1）：events.ndjson + ~/.claude/tasks → session/task 双表 ----------
// 消费面：events.ndjson（session 当前态唯一 durable 源，事件重放终态）+ tasks/<sid>/<tid>.json
//   （task 唯一事实源）+ acceptances/*.json（review_required 存在性推断，cwd 匹配口径）。
// transcript 不在本单直接消费：SESSION_CREATED 首帧 payload 已承载所需元数据（cwd/title/model/
// relay_session_id），正文（SESSION_LOG）一律不入库（冻结件 §1：transcript 是消息正文真相）。
//
// importer 范式（沿用 C1 import-org.ts 五要点，D1 特化两点）：
//   1. 入口 importSessionTask(port, sources, opts)——port 显式传入；段内事务（见 3）。
//   2. 三源各持 B2 checkpoint 五元组：eventsFile 行级语义（offset=前 offset 行已处理，中断续跑
//      从 offset+1 起）；tasksDir/acceptDir 目录级语义（虚拟源：mtime=树内最大 mtime、
//      lineCount=条目数，命中=域快进，失效=域重灌——JSON 树无逐行续跑面，同 C1 文件级）。
//   3. 失效 vs 中断的区分（行级断点的核心语义，与 C1「失效即域重扫」调和）：
//      · checkpoint 有效+offset<lineCount = 纯中断续跑——不清域，从 offset+1 增量续行（零重复，
//        零丢失；ndjson append-only，session 域靠 upsert 幂等自愈，永不 DELETE）。
//      · checkpoint 失效（mtime/lineCount/schemaVersion 任一不符）= 源变/逻辑升级——session 域
//        从 0 重放（upsert 覆盖），task 域清重灌（tasks 目录有真实删文件面，必须 DELETE 防残留）。
//      · task 域重灌触发 = 任一源失效（task 归因链 task→session.cwd→group 依赖 session 全量，
//        review_required 依赖 accept 集——任一上游变化即联动重算，防陈旧归因）。
//   4. 坏行走 B2 loss writer：坏 JSON 行/缺字段/状态词表外→拒入+落账不阻断；悬空引用（task 的
//      session 目录名在 session 表无行）→归因写 NULL+落账；绝不造关联。
//   5. 行 id 确定性：session.id=事件 session_id 直落（Leader 拍板）；task.id=`task-`+sha12(task_ref)，
//      task_ref=`<session-uuid>/<task-id>` 复合串（per-session 内 tid 不唯一，复合才是稳定迁移 id）。
//   D1 特化——状态映射口径（Leader 拍板 + 冻结件 §1/§2 注记）：
//      · task 双词表：todo|pending→backlog、doing|in_progress→claimed、done|completed→done；
//        completed 且 review_required=1（验收单存在性推断）→submitted。
//      · blocked 不入 status：tasks 源无 blocked 态，词表外一律拒入+loss（含 blocked）。
//      · session.status=SessionState 内存枚举词表 WORKING|WAITING|ERROR|DONE 直落（types.ts
//        SessionStatus，不新造词表）；SESSION_DELETED 落 deleted_at 不删行。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha12, statThenRead } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, type LossRecord } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级时 bump→三源全部失效强制重放（与 DB user_version 正交）。 */
export const SESSION_TASK_IMPORT_SCHEMA_VERSION = 1;

/** 默认批事务行数（批尾写 checkpoint；批间中断=已完成批已提交，续跑零重复零丢失）。 */
export const DEFAULT_BATCH_SIZE = 500;

/** task.status 五态词表（DDL CHECK；映射目标面）。 */
const TASK_STATUS = new Set(["backlog", "claimed", "submitted", "ready_to_install", "done"]);
/** task 源状态双词表 → 五态映射（todo/doing/done=看板旧词；pending/in_progress/completed=tasks 文件实测词）。 */
const TASK_STATUS_MAP: Record<string, string> = {
  todo: "backlog",
  pending: "backlog",
  doing: "claimed",
  in_progress: "claimed",
  done: "done",
  completed: "done",
};
/** session.status 词表（SessionState 内存枚举直落，types.ts SessionStatus）。 */
const SESSION_STATUS = new Set(["WORKING", "WAITING", "ERROR", "DONE"]);

/**
 * 幂等落账：同 source_path+line_no+reason 已有账则跳过。行级续跑可能重遇断点前已落账的坏行
 * （真实中断账与 offset 同事务不会重遇；回拨/边角态下守卫兜底）——台账是对账事实，重复落账
 * 即对账噪音。失效重放路径先 DELETE 旧账再落，与守卫正交。
 */
function appendLossOnce(port: StoragePort, record: LossRecord): void {
  const dup = port.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM import_loss WHERE source_path = ? AND line_no = ? AND reason = ?",
    [record.sourcePath, record.lineNo, record.reason],
  )[0]?.n ?? 0;
  if (dup === 0) appendLoss(port, record);
}

export interface SessionTaskSources {
  /** events.ndjson 绝对路径（append-only 事件流）。 */
  eventsFile: string;
  /** 任务目录根（~/.claude/tasks 形态：<session-uuid>/<task-id>.json）。 */
  tasksDir: string;
  /** 验收单目录（data/acceptances 形态：<32hex>.json；仅 cwd 参与 review_required 推断）。 */
  acceptanceDir: string;
}

export interface SessionTaskImportCounts {
  session: number;
  task: number;
}

export interface SessionTaskImportResult {
  /** true=三源 checkpoint 全命中，域零写入快进。 */
  skipped: boolean;
  /** 本次落库后两表行数（快进时为实数 COUNT）。 */
  counts: SessionTaskImportCounts;
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  /** 实际重扫/续跑的源（快进为空数组）。 */
  rescanned: string[];
  /** 本次实际处理的 events.ndjson 行数（快进=0；中断续跑=lineCount-offset；重放=lineCount）。 */
  eventsProcessed: number;
}

// ---------- 源观测 ----------
interface ObservedNdjson {
  mtimeMs: number;
  lineCount: number;
  lines: string[] | null; // null=文件缺失
}

function observeNdjson(file: string): ObservedNdjson {
  if (!existsSync(file)) return { mtimeMs: 0, lineCount: 0, lines: null };
  const obs = statThenRead(file); // stat 先于 read 定稿序（权威注释见 import-util.ts）
  const lines = obs.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { mtimeMs: obs.mtimeMs, lineCount: lines.length, lines };
}

interface TaskFileRef {
  sid: string;
  tid: string;
  file: string;
  mtimeMs: number;
}

/** 目录树观测（tasks 形态：<sid>/<tid>.json 一层嵌套；返回虚拟源观测+文件清单）。 */
function observeTasksDir(dir: string): { mtimeMs: number; count: number; files: TaskFileRef[] } {
  if (!existsSync(dir)) return { mtimeMs: 0, count: 0, files: [] };
  const files: TaskFileRef[] = [];
  let maxMtime = 0;
  for (const sid of readdirSync(dir).sort()) {
    const sub = join(dir, sid);
    let tids: string[];
    try {
      tids = readdirSync(sub).sort();
    } catch {
      continue; // 散文件（非目录）跳过——任务源只认 <sid>/<tid>.json 两层
    }
    for (const name of tids) {
      if (!name.endsWith(".json")) continue;
      const file = join(sub, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const m = Math.round(st.mtimeMs);
      if (m > maxMtime) maxMtime = m;
      files.push({ sid, tid: name.slice(0, -5), file, mtimeMs: m });
    }
  }
  return { mtimeMs: maxMtime, count: files.length, files };
}

interface SheetRef {
  file: string;
  doc: { cwd?: unknown } | null; // null=读失败（落账）
  raw: string;
}

/** 验收单目录观测（扁平一层 *.json；排除 *.results.json 提交历史件）。 */
function observeAcceptanceDir(dir: string): { mtimeMs: number; count: number; sheets: SheetRef[] } {
  if (!existsSync(dir)) return { mtimeMs: 0, count: 0, sheets: [] };
  const sheets: SheetRef[] = [];
  let maxMtime = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name.endsWith(".results.json")) continue;
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const m = Math.round(st.mtimeMs);
    if (m > maxMtime) maxMtime = m;
    let doc: { cwd?: unknown } | null = null;
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
      doc = JSON.parse(raw) as { cwd?: unknown };
    } catch {
      doc = null; // 坏 sheet：段 2 落账（bad-json），不阻断
    }
    sheets.push({ file, doc, raw });
  }
  return { mtimeMs: maxMtime, count: sheets.length, sheets };
}

// ---------- 中间行模型 ----------
interface PendingLoss {
  sourcePath: string;
  lineNo: number;
  reason: string;
  excerpt: string;
}

interface SessionUpsert {
  id: string;
  relaySessionId: string | null;
  groupId: string | null;
  engine: string | null;
  provider: string | null;
  model: string | null;
  cwd: string;
  status: string;
  runtimeStateJson: string;
  startedAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

interface TaskRow {
  id: string;
  projectId: string | null;
  groupId: string | null;
  sessionId: string | null;
  origin: string;
  externalTaskFileId: string | null;
  taskRef: string;
  title: string;
  description: string;
  dependsOnJson: string;
  reviewRequired: number;
  reviewStatus: string;
  status: string;
  ts: number;
}

// ---------- events 事件解析/应用 ----------
interface NdjsonEvent {
  session_id?: unknown;
  ts?: unknown;
  type?: unknown;
  payload?: unknown;
}

/** session 表 upsert 列序（INSERT OR REPLACE 全列覆盖——重放幂等：同行同效果）。 */
const SESSION_INSERT = `INSERT OR REPLACE INTO session
  (id, relay_session_id, group_id, member_id, external_sid, engine, provider, model, cwd, status, runtime_state_json, started_at, updated_at, deleted_at)
  VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * events.ndjson 重放：session 当前态 = 顺序事件流终态。
 * · CREATED→建行（status=WORKING）；WAITING/RESOLVED/ERROR/DONE→status 推进；
 *   UPDATED→可变字段合并（payload.status 在词表内则采信）；LOG/ACTIVITY/HEARTBEAT→不碰实体
 *   （LOG 正文零入库）；DELETED→deleted_at 落（行不删，历史会话语义）。
 * · group_id 归因：cwd 精确匹配 group.anchor_dir（生产 C1 先导组）；匹配不上→NULL（会话不在
 *   组内是常态，非数据损失，不落 loss）。member_id：源无归因信息→NULL（同前）。
 * · runtime_state_json：ERROR/DONE 事件的 last_error/done_reason/duration_ms 增量收编（覆盖式，
 *   非累积——同源重放幂等）。
 */
function applyEvent(
  port: StoragePort,
  ev: NdjsonEvent,
  lineNo: number,
  srcPath: string,
  groupByAnchor: Map<string, string>,
  losses: PendingLoss[],
): void {
  const src = srcPath;
  const excerpt = JSON.stringify(ev).slice(0, 200);
  if (typeof ev.session_id !== "string" || !ev.session_id || typeof ev.type !== "string") {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
    return;
  }
  if (typeof ev.ts !== "number" || !Number.isFinite(ev.ts)) {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
    return;
  }
  const sid: string = ev.session_id;
  const ts: number = ev.ts;
  const type: string = ev.type;
  const payload = (typeof ev.payload === "object" && ev.payload !== null ? ev.payload : {}) as Record<string, unknown>;

  if (type === "SESSION_LOG" || type === "SESSION_ACTIVITY" || type === "SESSION_HEARTBEAT") {
    return; // 正文/活动/心跳：零实体写入（SESSION_LOG 正文不入库——验收点 1）
  }

  const existing = port.query<{ runtime_state_json: string; started_at: number; deleted_at: number | null }>(
    "SELECT runtime_state_json, started_at, deleted_at FROM session WHERE id = ?",
    [sid],
  )[0];

  if (type === "SESSION_DELETED") {
    if (existing) {
      port.exec("UPDATE session SET deleted_at = ?, updated_at = ? WHERE id = ?", [ts, ts, sid]);
    }
    return; // 未见 sid 的 DELETED（重放序保证下不可达）静默忽略
  }

  // status 推进映射（SessionStatus 词表外事件不碰 status）
  let nextStatus: string | null = null;
  if (type === "SESSION_CREATED") nextStatus = "WORKING";
  else if (type === "SESSION_WAITING") nextStatus = "WAITING";
  else if (type === "SESSION_WAITING_RESOLVED") nextStatus = "WORKING";
  else if (type === "SESSION_ERROR") nextStatus = "ERROR";
  else if (type === "SESSION_DONE") nextStatus = "DONE";
  else if (type === "SESSION_UPDATED") {
    const p = payload.status;
    if (typeof p === "string" && SESSION_STATUS.has(p)) nextStatus = p;
  }

  // runtime 增量（覆盖式收编）
  let runtimeJson = existing?.runtime_state_json ?? "{}";
  if (type === "SESSION_ERROR" && typeof payload.last_error === "string") {
    runtimeJson = JSON.stringify({ ...safeParse(runtimeJson), last_error: payload.last_error });
  } else if (type === "SESSION_DONE") {
    const patch: Record<string, unknown> = {};
    if (typeof payload.done_reason === "string") patch.done_reason = payload.done_reason;
    if (typeof payload.duration_ms === "number") patch.duration_ms = payload.duration_ms;
    if (Object.keys(patch).length > 0) runtimeJson = JSON.stringify({ ...safeParse(runtimeJson), ...patch });
  }

  if (!existing) {
    // 首见：必须 CREATED（UPDATED/WAITING 等对未见 sid 属流残缺——拒行落账，不造骨架行）
    if (type !== "SESSION_CREATED") {
      losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
      return;
    }
    const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : "";
    if (!cwd) {
      losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
      return;
    }
    const status = nextStatus ?? "WORKING";
    const row: SessionUpsert = {
      id: sid,
      relaySessionId: typeof payload.relay_session_id === "string" ? payload.relay_session_id : null,
      groupId: groupByAnchor.get(cwd) ?? null,
      engine: null,
      provider: null,
      model: typeof payload.model === "string" ? payload.model : null,
      cwd,
      status,
      runtimeStateJson: runtimeJson,
      startedAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    port.exec(SESSION_INSERT, [
      row.id, row.relaySessionId, row.groupId, row.model, row.cwd, row.status,
      row.runtimeStateJson, row.startedAt, row.updatedAt, row.deletedAt,
    ]);
    return;
  }

  // 已见 sid：仅推进 status/updated_at/runtime_state_json 三列（UPDATED payload 里的 title/model
  // 均不回写——title 无 DDL 列可落、model 列存在但取首帧 CREATED 值不随 UPDATED 变；status
  // 仅词表内采信）。非「宽松合并」，列面就这三列。
  if (nextStatus !== null) {
    port.exec("UPDATE session SET status = ?, updated_at = ?, runtime_state_json = ? WHERE id = ?", [
      nextStatus, ts, runtimeJson, sid,
    ]);
  } else {
    port.exec("UPDATE session SET updated_at = ?, runtime_state_json = ? WHERE id = ?", [ts, runtimeJson, sid]);
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- task 文件解析 ----------
/**
 * 单个任务文件 → TaskRow（null=拒入，loss 已记）。
 * · 状态映射双词表（TASK_STATUS_MAP）；词表外（含 blocked）拒入+loss。
 * · review_required=验收单存在性（accept cwd 集 ∋ 该 task 所属 session 的 cwd）；推断不出→0
 *   （保守缺省，非数据损失不落 loss——Leader 拍板）。
 * · status=done 映射且 review_required=1 → submitted（冻结件：review_required=1 的 done 候选）。
 * · review_status：required=1→'pending'（等验收）；0→'not_required'。
 * · 归因链：目录 sid→session 行（cwd）→group.anchor_dir→group→project；session 悬空→
 *   session_id/project_id/group_id 全 NULL+dangling-ref 落账；cwd 不匹配组→NULL 不落账
 *   （个人会话常态）。
 * · depends_on_json ← blockedBy（blockedBy=谁阻塞我=依赖谁）；blocks 是反向面不入库列。
 */
function parseTaskFile(
  ref: TaskFileRef,
  lossSource: string,
  reviewCwds: Set<string>,
  sessionCwd: Map<string, string>,
  groupByAnchor: Map<string, string>,
  groupProject: Map<string, string>,
  losses: PendingLoss[],
): TaskRow | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(ref.file, "utf8")) as Record<string, unknown>;
  } catch {
    losses.push({ sourcePath: lossSource, lineNo: 1, reason: "bad-json", excerpt: JSON.stringify({ file: ref.file }).slice(0, 200) });
    return null;
  }
  const excerpt = JSON.stringify({ sid: ref.sid, tid: ref.tid, subject: doc.subject, status: doc.status }).slice(0, 200);
  if (typeof doc.subject !== "string" || !doc.subject) {
    losses.push({ sourcePath: lossSource, lineNo: 1, reason: "missing-field", excerpt });
    return null;
  }
  if (typeof doc.status !== "string" || !(doc.status in TASK_STATUS_MAP)) {
    losses.push({ sourcePath: lossSource, lineNo: 1, reason: "bad-field", excerpt });
    return null;
  }
  const mapped = TASK_STATUS_MAP[doc.status];

  const taskRef = `${ref.sid}/${ref.tid}`;
  const cwd = sessionCwd.get(ref.sid);
  const reviewRequired = cwd !== undefined && reviewCwds.has(cwd) ? 1 : 0;
  const groupId = cwd !== undefined ? groupByAnchor.get(cwd) ?? null : null;
  if (cwd === undefined) {
    // 有目录 sid（归因线索）但 session 表无行：悬空归因——NULL+落账，绝不造关联
    losses.push({ sourcePath: lossSource, lineNo: 1, reason: "dangling-ref", excerpt });
  }
  const projectId = groupId !== null ? groupProject.get(groupId) ?? null : null;

  const dependsOn = Array.isArray(doc.blockedBy)
    ? (doc.blockedBy as unknown[]).filter((x): x is string => typeof x === "string").map((t) => `${ref.sid}/${t}`)
    : [];

  return {
    id: `task-${sha12(taskRef)}`,
    projectId,
    groupId,
    sessionId: cwd !== undefined ? ref.sid : null,
    origin: "user",
    externalTaskFileId: ref.tid,
    taskRef,
    title: doc.subject,
    description: typeof doc.description === "string" ? doc.description : "",
    dependsOnJson: JSON.stringify(dependsOn),
    reviewRequired,
    reviewStatus: reviewRequired === 1 ? "pending" : "not_required",
    status: mapped === "done" && reviewRequired === 1 ? "submitted" : mapped,
    ts: ref.mtimeMs,
  };
}

// ---------- 主入口 ----------
/**
 * 会话与任务域导入。三源 checkpoint 联动幂等：
 * · 三源全命中 → skipped（零写入）。
 * · events 段：行级批事务（DEFAULT_BATCH_SIZE 行/批，批尾写 checkpoint）——中断续跑从
 *   offset+1 增量续行；失效从 0 重放（upsert 覆盖；段 1 开始前一次性清 events 源旧 loss，
 *   不进批循环——每批清会误删前批已提交账，见 flushBatch 前注释）。
 * · task 域段（任一源失效才触发）：单事务「清 task 域+tasks/accept 源旧 loss→重灌→回写
 *   两源 checkpoint」——tasks 目录有真实删文件面，DELETE 防残留；accept 失效经重灌重推
 *   review_required。
 */
export function importSessionTask(
  port: StoragePort,
  sources: SessionTaskSources,
  opts?: { schemaVersion?: number; batchSize?: number },
): SessionTaskImportResult {
  const schemaVersion = opts?.schemaVersion ?? SESSION_TASK_IMPORT_SCHEMA_VERSION;
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;

  const obsEvents = observeNdjson(sources.eventsFile);
  const obsTasks = observeTasksDir(sources.tasksDir);
  const obsAccept = observeAcceptanceDir(sources.acceptanceDir);

  const current = { schemaVersion };
  const cpEvents = obsEvents.lines !== null
    ? readCheckpoint(port, sources.eventsFile, { ...current, mtimeMs: obsEvents.mtimeMs, lineCount: obsEvents.lineCount })
    : null;
  const cpTasks = readCheckpoint(port, sources.tasksDir, { ...current, mtimeMs: obsTasks.mtimeMs, lineCount: obsTasks.count });
  const cpAccept = readCheckpoint(port, sources.acceptanceDir, { ...current, mtimeMs: obsAccept.mtimeMs, lineCount: obsAccept.count });

  // 快进条件：三源全命中 **且 events 已跑完**（offset=lineCount）。offset<lineCount=中断待续态
  // （tasks/accept 账已在、仅 events 段余行）——不得快进，走段 1 从 offset+1 增量续跑。
  if (cpEvents !== null && cpEvents.offset >= obsEvents.lineCount && cpTasks !== null && cpAccept !== null) {
    const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
    return {
      skipped: true,
      counts: { session: n("SELECT COUNT(*) AS n FROM session"), task: n("SELECT COUNT(*) AS n FROM task") },
      loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?, ?)",
        sources.eventsFile, sources.tasksDir, sources.acceptanceDir),
      rescanned: [],
      eventsProcessed: 0,
    };
  }

  // ---- 段 1：events 行级重放/续跑（session 域；永不 DELETE——append-only upsert 自愈） ----
  const groupByAnchor = new Map<string, string>();
  for (const r of port.query<{ id: string; anchor_dir: string }>(`SELECT id, anchor_dir FROM "group"`)) {
    groupByAnchor.set(r.anchor_dir, r.id);
  }
  const losses: PendingLoss[] = [];
  let eventsProcessed = 0;
  if (obsEvents.lines !== null) {
    const fromLine = cpEvents !== null ? cpEvents.offset : 0; // 失效→0 重放；有效→offset+1 续
    if (fromLine === 0) {
      // 重放路径：events 源旧 loss 只在此清一次（段前单次，绝不进批循环）。若放进 flushBatch
      // 每批执行：批 1 落账 commit→批 2 事务先 DELETE（把批 1 已提交的账删了）→坏行已被
      // splice 出队永不重落→跨批时只有末批账存活的静默丢账（M11-REVIEW2 P1-1 实测）。
      // 参照 import-dispatch-lesson.ts 清域单次铁律（cleared 先例）：清域动作与批边界无关，
      // 段语义动作只做一次。清完即终（autocommit），后续批失败重试时 fromLine 仍为 0（checkpoint
      // 未推进）→重清重放，自愈无残留。
      port.exec("DELETE FROM import_loss WHERE source_path = ?", [sources.eventsFile]);
    }
    let batch: { ev: NdjsonEvent | null; lineNo: number }[] = [];
    const flushBatch = (): void => {
      if (batch.length === 0) return;
      port.begin();
      try {
        let lastLine = fromLine;
        for (const b of batch) {
          if (b.ev !== null) applyEvent(port, b.ev, b.lineNo, sources.eventsFile, groupByAnchor, losses);
          lastLine = b.lineNo;
        }
        for (const l of losses.splice(0)) appendLossOnce(port, l);
        writeCheckpoint(port, {
          path: sources.eventsFile, mtimeMs: obsEvents.mtimeMs, lineCount: obsEvents.lineCount,
          offset: lastLine, schemaVersion,
        });
        port.commit();
      } catch (err) {
        port.rollback();
        throw new Error(`import-session-task: events 批处理失败已回滚（offset 停留前批尾）——${err instanceof Error ? err.message : String(err)}`);
      }
      eventsProcessed += batch.length;
      batch = [];
    };
    for (let i = fromLine; i < obsEvents.lines.length; i++) {
      const line = obsEvents.lines[i];
      const lineNo = i + 1;
      let ev: NdjsonEvent | null = null;
      if (line.trim() !== "") {
        try {
          ev = JSON.parse(line) as NdjsonEvent;
        } catch {
          losses.push({ sourcePath: sources.eventsFile, lineNo, reason: "bad-json", excerpt: line.slice(0, 200) });
        }
      }
      batch.push({ ev, lineNo });
      if (batch.length >= batchSize) flushBatch();
    }
    flushBatch();
    if (obsEvents.lineCount === 0 && fromLine === 0) {
      // 空文件也要落 checkpoint（offset=0 全法有效），否则每次调用都失效重扫空转
      port.begin();
      try {
        port.exec("DELETE FROM import_loss WHERE source_path = ?", ["events"]);
        writeCheckpoint(port, { path: sources.eventsFile, mtimeMs: obsEvents.mtimeMs, lineCount: 0, offset: 0, schemaVersion });
        port.commit();
      } catch (err) {
        port.rollback();
        throw new Error(`import-session-task: 空 events checkpoint 写入失败——${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---- 段 2：task 域（任一源失效即联动重灌——归因链依赖 session 全量 + review 依赖 accept 集） ----
  if (cpEvents === null || cpTasks === null || cpAccept === null) {
    // accept cwd 集（坏 sheet 落账；cwd 非串忽略——推断不出=0，不 loss）
    const reviewCwds = new Set<string>();
    for (const s of obsAccept.sheets) {
      if (s.doc === null) {
        losses.push({ sourcePath: sources.acceptanceDir, lineNo: 1, reason: "bad-json", excerpt: s.raw.slice(0, 200) });
        continue;
      }
      if (typeof s.doc.cwd === "string" && s.doc.cwd) reviewCwds.add(s.doc.cwd);
    }
    const sessionCwd = new Map<string, string>(
      port.query<{ id: string; cwd: string }>("SELECT id, cwd FROM session").map((r) => [r.id, r.cwd]),
    );
    const groupProject = new Map<string, string>(
      port.query<{ id: string; project_id: string | null }>(`SELECT id, project_id FROM "group"`).map((r) => [r.id, r.project_id ?? ""]),
    );

    port.begin();
    try {
      port.exec("DELETE FROM task");
      port.exec("DELETE FROM import_loss WHERE source_path IN (?, ?)", [sources.tasksDir, sources.acceptanceDir]);
      const rows: TaskRow[] = [];
      for (const ref of obsTasks.files) {
        const row = parseTaskFile(ref, sources.tasksDir, reviewCwds, sessionCwd, groupByAnchor, groupProject, losses);
        if (row !== null) {
          if (!TASK_STATUS.has(row.status)) {
            // 防御面：映射产物必须落五态词表（ submitted 含内）；不可达即映射表坏了——炸
            throw new Error(`映射产物状态越词表（${row.taskRef} → ${row.status}）`);
          }
          rows.push(row);
        }
      }
      for (const r of rows) {
        port.exec(
          `INSERT INTO task (id, project_id, group_id, session_id, parent_task_id, origin, external_sid, external_task_file_id,
             task_ref, title, description, scope_json, handoff, assignee_id, branch, artifact_id, depends_on_json,
             gate_reason, gate_opened_at, review_required, review_status, workflow_profile, status, deleted_at, ts)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, '{}', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?)`,
          [r.id, r.projectId, r.groupId, r.sessionId, r.origin, r.externalTaskFileId, r.taskRef, r.title,
            r.description, r.dependsOnJson, r.reviewRequired, r.reviewStatus, r.status, r.ts],
        );
      }
      for (const l of losses.splice(0)) appendLossOnce(port, l);
      writeCheckpoint(port, { path: sources.tasksDir, mtimeMs: obsTasks.mtimeMs, lineCount: obsTasks.count, offset: obsTasks.count, schemaVersion });
      writeCheckpoint(port, { path: sources.acceptanceDir, mtimeMs: obsAccept.mtimeMs, lineCount: obsAccept.count, offset: obsAccept.count, schemaVersion });
      port.commit();
    } catch (err) {
      port.rollback();
      throw new Error(`import-session-task: task 域重灌失败已回滚（保留旧 task 快照）——${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
  return {
    skipped: false,
    counts: { session: n("SELECT COUNT(*) AS n FROM session"), task: n("SELECT COUNT(*) AS n FROM task") },
    loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?, ?)",
      sources.eventsFile, sources.tasksDir, sources.acceptanceDir),
    rescanned: [sources.eventsFile, sources.tasksDir, sources.acceptanceDir],
    eventsProcessed,
  };
}
