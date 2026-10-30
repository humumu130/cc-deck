// ---------- 板卡域导入器（W-BOARD-FATE-A）：boards/<gid>.json entries → task 表 origin='board' 分区 ----------
// 消费面：org/boards/<gid>.json 的 entries 分区（板卡实体唯一事实源，json 权威不变——本件
//   纯只读，绝不写板文件/不触发 migrateBoardStatuses 落盘）+ org/boards-journal.ndjson
//   （W-BJOURNAL 落的板写审计 delta 日，5MB 滚动、text 截 60——**审计线索非数据源**，
//   本件只把它当「变化指针」用：行指向 (gid, entry_id) 变了，条目真身从板文件重读）。
//
// 与冻结件的对齐（docs/v2-m10-freeze.md §4 loss list：「task | boards.entries[]→task |
// todo/doing/done 一次性映射；缺 task_ref 用稳定迁移 id；旧 board 分区/颜色丢弃」——D 线
// 遗留断层，本件补齐）：
//   · 状态映射：五态词表直落（BoardEntryStatus 与 task CHECK 五态逐字同域）；旧三态
//     todo→backlog、doing→claimed 就地映射（migrateBoardStatuses 同款，本件只在内存映射
//     不落盘）；词表外拒入+loss。
//   · 稳定迁移 id：task_ref=`board/<gid>/<entry_id>`（复合串全局唯一，缺 task_ref 的板卡
//     用此稳定迁移键）；行 id=`board-`+sha12(task_ref)（与 CLI 域 `task-`+sha12 同构）。
//   · 有损备案：description 恒 ''（卡文本即 title）；parent_task_id/priority 无表列不投影
//     （板卡父子链/优先级是板面 UI 语义）；**scope_json 载条目 raw 快照**（读投影
//     boardTaskEntriesFromDb 的逐字段还原面——transitions/note/owner_session/dispatch_id/
//     updated_at 等无列字段的保真载体，读切库的忠实性依据）。
//
// importer 范式（沿用 D1/D2 五要点，本件特化）：
//   1. 双源各持 checkpoint 五元组（含 #292-B2 mtimeNs 纳秒腿）：journalFile 行级语义
//      （offset=前 offset 行已处理）；boardsDir 目录级虚拟源（mtime=板文件最大 mtime、
//      lineCount=板文件数，D2 lesson 段同款）。
//   2. 失效三分路：
//      · 双源全命中且 journal 已跑完 → skipped（零写入快进——重复跑零重写）。
//      · boards 失效（任意板文件 mtime/数量/schema 变）OR journal 滚动检测（checkpoint
//        行 line_count > 当前观测——>5MB 滚动改名后行数骤缩）→ 板分区全量重灌：单事务
//        「DELETE task WHERE origin='board' + 清两源旧 loss → 全文件重投影 → 回写双源
//        checkpoint（journal 拨到尾行=全量已反映）」。
//      · 仅 journal 增长（板文件未变——写侧「journal 追加成功+板写失败」窗口）→ journal
//        重放追赶：从 fromLine 起逐行收集 touch 集（gid+entry_id），逐条从**当前板文件**
//        重读条目真身：在场→upsert、缺席→DELETE（remove 语义）。不清板分区（域快照
//        不动，只追赶增量）。touch 语义不看行内 prev/next（那是截 60 摘要，不是数据）。
//   3. 分区契约：task 表双写者分区——本件只动 origin='board' 行，CLI 域
//      （import-session-task）只动 origin='user' 行；任一域重灌不碾对方分区。
//      org 重扫联动（read-mode importAllForShadow）的下游全清仍整表 DELETE，随后两域
//      各自按（已被作废的）checkpoint 全量重灌，链路自洽。
//   4. 归因（悬空两分法同 D2）：group_id ← gid 查 group 表，悬空→NULL+dangling-ref
//      （照导卡体，不丢事实）；session_id ← owner_session 查 session 表，非空悬空→NULL+
//      dangling-ref、缺省→NULL 不落账；assignee_id ← owner_session→session.member_id 链
//      （断链 NULL 不落账，归因缺位是常态）。绝不造关联（冻结件 §1）。
//   5. 坏行只进 loss 不阻断：bad-json（journal 坏行/板文件坏 JSON）/missing-field（卡
//      id/text/status/ts 缺或类型坏）/bad-field（状态越词表/depends_on 非数组/gate 坏形/
//      review_required 非布尔）/dangling-ref/duplicate-id（同板同 entry_id 二遇，文件序
//      保首行）。板文件坏 JSON 的增量路径保守不动该板行（无法判缺席=删除 vs 文件半态），
//      全量路径按「可观测事实为零」清该板行（D2 lesson 坏板同口径），两径差异备案。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha12, statThenRead } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, type LossRecord } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级时 bump→双源全部失效强制重放（与 DB user_version 正交）。 */
export const BOARD_TASK_IMPORT_SCHEMA_VERSION = 1;

/** 板卡域在 task 表的分区标记（分区契约见头注 3；CLI 域=origin 'user'）。 */
export const BOARD_TASK_ORIGIN = "board";

/** boardsDir 的 checkpoint 分键后缀（D1 ACC_DIR_CP_SUFFIX 同款问题同款解）：boards 目录被
 * 本件与 import-dispatch-lesson.ts（lesson 段）两导入器共用，同一 path 键互写五元组互使
 * 对方失效→每轮两域恒重写。分键口径：checkpoint path = 目录路径 + 域视图后缀；loss/
 * rescanned 的 source_path 保持目录原样（账标识语义，非 checkpoint key）。连带口径：两域
 * 都会清 bare boardsDir 的 loss 账（D1 对 accDir 的既定容忍），聚合步骤序把本件排在
 * dispatch-lesson **之后**——本件重灌落账在后，板卡 loss 不被 D2 重灌清掉。 */
export const BOARDS_DIR_CP_SUFFIX = "#board-task-view";

/** 板卡行 task_ref 前缀（稳定迁移 id 形态 `board/<gid>/<entry_id>`；读投影按键集消费）。 */
export function boardTaskRef(gid: string, entryId: string): string {
  return `board/${gid}/${entryId}`;
}

/** task.status 五态词表（DDL CHECK；与 BoardEntryStatus 逐字同域直落）。 */
const TASK_STATUS = new Set(["backlog", "claimed", "submitted", "ready_to_install", "done"]);
/** 旧三态→五态就近映射（D18 冻结件 §1.2 逐字；migrateBoardStatuses 同款，本件内存映射不落盘）。 */
const LEGACY_STATUS_MAP: Record<string, string> = { todo: "backlog", doing: "claimed" };

// ---------- 源观测 ----------
interface ObservedJournal {
  mtimeMs: number;
  mtimeNs: string;
  lineCount: number;
  lines: string[]; // 文件缺失=空数组（journal 是写侧例行产物，缺席=稳定空态非不可观测——与 D1 events「缺失不动」的差异备案于头注 2）
}

function observeJournal(file: string): ObservedJournal {
  if (!existsSync(file)) return { mtimeMs: 0, mtimeNs: "", lineCount: 0, lines: [] };
  const obs = statThenRead(file); // stat 先于 read 定稿序（import-util 头注）
  // 大源（>2MB）双未变短路（#292-cutover-P1，D1 observeNdjson 同款承接）：journal 5MB 滚动
  // 上限内必然跨 2MB 阈——短路态 text 为空串，不承接会把 lineCount 误读为 0：轻则写错位
  // checkpoint，重则滚动检测（cp 行数>观测行数）恒真=每轮误判全量重灌。此处映射 lines=[]
  // （内容未变，checkpoint 比较走 lineCount 不变=快进），真变更不命中短路→正常全文读。
  if (obs.unchanged === true) {
    return { mtimeMs: obs.mtimeMs, mtimeNs: obs.mtimeNs, lineCount: obs.lineCount ?? 0, lines: [] };
  }
  const lines = obs.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { mtimeMs: obs.mtimeMs, mtimeNs: obs.mtimeNs, lineCount: lines.length, lines };
}

interface BoardFileRef {
  gid: string;
  file: string;
  mtimeMs: number;
  mtimeNs: string;
  /** entries 数组原样（宽松 unknown——逐条校验归 parseBoardEntry）；null=坏 JSON/读失败 */
  entries: unknown[] | null;
}

/** 板目录观测（扁平一层 <gid>.json；排除一切备份/非板件；虚拟源 mtime=ms/ns 双精最大、lineCount=文件数）。
 * 备份排除口径：板文件名恒为 `<gid>.json`（gid 词表 pg-<hex>，stem 无点）——**stem 含点的
 * 一律排除**（覆盖 `<gid>.json.pre-d18.json`（migrateBoardStatuses 冷备份，尾带 .json 会
 * 骗过 endsWith 过滤=同板双文件双倍投影，测试实锤）与 `<gid>.json.pre-board2` 等历史备份形）。 */
function observeBoardsDir(dir: string): { mtimeMs: number; mtimeNs: string; count: number; files: BoardFileRef[] } {
  if (!existsSync(dir)) return { mtimeMs: 0, mtimeNs: "", count: 0, files: [] };
  const files: BoardFileRef[] = [];
  let maxMs = 0;
  let maxNs = "";
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const stem = name.slice(0, -5);
    if (stem === "" || stem.includes(".")) continue; // 备份/异形件排除（头注口径）
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const stNs = statSync(file, { bigint: true }).mtimeNs.toString();
    const m = Math.round(st.mtimeMs);
    if (m > maxMs || (m === maxMs && stNs > maxNs)) { maxMs = m; maxNs = stNs; }
    let entries: unknown[] | null = null;
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
      entries = Array.isArray(doc.entries) ? doc.entries : [];
    } catch {
      entries = null; // 坏板文件：loss 落账（bad-json），不阻断
    }
    files.push({ gid: name.slice(0, -5), file, mtimeMs: m, mtimeNs: stNs, entries });
  }
  if (maxNs === "") maxNs = statSync(dir, { bigint: true }).mtimeNs.toString(); // 空目录：ns 腿退目录自身（稳定可比对即合法）
  return { mtimeMs: maxMs, mtimeNs: maxNs, count: files.length, files };
}

// ---------- 中间行模型 ----------
interface PendingLoss {
  sourcePath: string;
  lineNo: number;
  reason: string;
  excerpt: string;
}

interface BoardTaskRow {
  id: string;
  projectId: string | null;
  groupId: string | null;
  sessionId: string | null;
  assigneeId: string | null;
  taskRef: string;
  title: string;
  scopeJson: string;
  dependsOnJson: string;
  gateReason: string | null;
  gateOpenedAt: number | null;
  reviewRequired: number;
  reviewStatus: string;
  status: string;
  ts: number;
}

/**
 * 幂等落账（D1/D2 同款）：行级重放可能重遇断点前已落账的坏行——重复落账是对账噪音。
 * 失效重放路径先 DELETE 旧账再落，与守卫正交。
 */
function appendLossOnce(port: StoragePort, record: LossRecord): void {
  const dup = port.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM import_loss WHERE source_path = ? AND line_no = ? AND reason = ?",
    [record.sourcePath, record.lineNo, record.reason],
  )[0]?.n ?? 0;
  if (dup === 0) appendLoss(port, record);
}

/**
 * 单条板卡 → BoardTaskRow（null=拒入，loss 已记）。
 * 必需字段：id/text/status/ts（缺失或类型坏=missing-field 拒行）；状态映射见头注；
 * 可选消费字段类型坏（owner_session/depends_on/gate/review_required）→ bad-field 落账，
 * 列取保守缺省（NULL/[]/0），raw 原样进 scope_json（保真不丢）。
 */
function parseBoardEntry(
  gid: string,
  rawEntry: unknown,
  lineNo: number,
  srcDir: string,
  attribution: BoardAttribution,
  losses: PendingLoss[],
): BoardTaskRow | null {
  const excerpt = JSON.stringify({ gid, entry: rawEntry }).slice(0, 200);
  if (typeof rawEntry !== "object" || rawEntry === null) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "missing-field", excerpt });
    return null;
  }
  const e = rawEntry as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id || typeof e.text !== "string" || !e.text) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "missing-field", excerpt });
    return null;
  }
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "missing-field", excerpt });
    return null;
  }
  let status: string | null = null;
  if (typeof e.status === "string") {
    status = TASK_STATUS.has(e.status) ? e.status : LEGACY_STATUS_MAP[e.status] ?? null;
  }
  if (status === null) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
    return null;
  }

  // 归因（悬空两分法：常态 NULL 不落账；显式悬空 NULL+落账）
  const groupId = attribution.groupIds.has(gid) ? gid : null;
  if (groupId === null) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "dangling-ref", excerpt });
  }
  const projectId = groupId !== null ? attribution.groupProject.get(groupId) ?? null : null;
  const owner = typeof e.owner_session === "string" ? e.owner_session : "";
  let sessionId: string | null = null;
  if (owner !== "") {
    if (attribution.sessionMember.has(owner)) sessionId = owner;
    else losses.push({ sourcePath: srcDir, lineNo, reason: "dangling-ref", excerpt });
  } else if (e.owner_session !== undefined && typeof e.owner_session !== "string") {
    losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
  }
  const assigneeId = sessionId !== null ? attribution.sessionMember.get(sessionId) ?? null : null;

  // 可选消费字段（类型坏=bad-field 落账+保守缺省；raw 保真不丢）
  let deps: string[] = [];
  if (Array.isArray(e.depends_on)) {
    deps = (e.depends_on as unknown[]).filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .map((d) => boardTaskRef(gid, d)); // 依赖引用统一升格全局键（跨板/跨域可比）
  } else if (e.depends_on !== undefined) {
    losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
  }
  let gateReason: string | null = null;
  let gateOpenedAt: number | null = null;
  if (e.gate !== undefined && e.gate !== null) {
    const g = e.gate as { reason?: unknown; opened_at?: unknown };
    if (typeof g === "object" && typeof g.reason === "string" && g.reason) {
      gateReason = g.reason;
      gateOpenedAt = typeof g.opened_at === "number" && Number.isFinite(g.opened_at) ? g.opened_at : null;
    } else {
      losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
    }
  }
  if (e.review_required !== undefined && typeof e.review_required !== "boolean") {
    losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
  }
  const reviewRequired = e.review_required === true ? 1 : 0;

  // scope_json 载**规范化快照**（非逐字节 raw）：status 就地映射为五态（json 读路径
  // migrateBoardStatuses 同款内存映射——投影还原值=json 路径返回值，两侧等价）；
  // updated_at 缺失/类型坏兜底为 ts（板文件必有字段的历史数据兼容），其余字段原样。
  const snapshot: Record<string, unknown> = { ...e, status };
  if (typeof e.updated_at !== "number" || !Number.isFinite(e.updated_at)) snapshot.updated_at = e.ts;

  return {
    id: `board-${sha12(boardTaskRef(gid, e.id))}`,
    projectId,
    groupId,
    sessionId,
    assigneeId,
    taskRef: boardTaskRef(gid, e.id),
    title: e.text,
    scopeJson: JSON.stringify({ board_entry: snapshot }),
    dependsOnJson: JSON.stringify(deps),
    gateReason,
    gateOpenedAt,
    reviewRequired,
    reviewStatus: reviewRequired === 1 ? "pending" : "not_required",
    status,
    ts: e.ts,
  };
}

/** 归因锚预载（group→project 链 + session→member 链；导入器对 org/session 域只读不写）。 */
interface BoardAttribution {
  groupIds: Set<string>;
  groupProject: Map<string, string>;
  sessionMember: Map<string, string | null>;
}

function loadAttribution(port: StoragePort): BoardAttribution {
  return {
    groupIds: new Set(port.query<{ id: string }>(`SELECT id FROM "group"`).map((r) => r.id)),
    groupProject: new Map<string, string>(
      port.query<{ id: string; project_id: string | null }>(`SELECT id, project_id FROM "group"`).map((r) => [r.id, r.project_id ?? ""]),
    ),
    sessionMember: new Map<string, string | null>(
      port.query<{ id: string; member_id: string | null }>("SELECT id, member_id FROM session").map((r) => [r.id, r.member_id]),
    ),
  };
}

const BOARD_TASK_UPSERT = `INSERT INTO task (id, project_id, group_id, session_id, parent_task_id, origin, external_sid, external_task_file_id,
    task_ref, title, description, scope_json, handoff, assignee_id, branch, artifact_id, depends_on_json,
    gate_reason, gate_opened_at, review_required, review_status, workflow_profile, status, deleted_at, ts)
  VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, '', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
  ON CONFLICT(id) DO UPDATE SET
    project_id = excluded.project_id, group_id = excluded.group_id, session_id = excluded.session_id,
    task_ref = excluded.task_ref, title = excluded.title, scope_json = excluded.scope_json,
    assignee_id = excluded.assignee_id, depends_on_json = excluded.depends_on_json,
    gate_reason = excluded.gate_reason, gate_opened_at = excluded.gate_opened_at,
    review_required = excluded.review_required, review_status = excluded.review_status,
    status = excluded.status, ts = excluded.ts`;

function upsertBoardTaskRow(port: StoragePort, r: BoardTaskRow): void {
  port.exec(BOARD_TASK_UPSERT, [
    r.id, r.projectId, r.groupId, r.sessionId, BOARD_TASK_ORIGIN, r.taskRef, r.title, r.scopeJson,
    r.assigneeId, r.dependsOnJson, r.gateReason, r.gateOpenedAt, r.reviewRequired, r.reviewStatus, r.status, r.ts,
  ]);
}

// ---------- 主入口 ----------
export interface BoardTaskSources {
  /** 板写审计 delta 日绝对路径（org/boards-journal.ndjson；变化指针面，非数据源）。 */
  journalFile: string;
  /** 板目录（org/boards；entries 实体唯一事实源）。 */
  boardsDir: string;
}

export interface BoardTaskImportResult {
  /** true=双源 checkpoint 全命中，域零写入快进（重复跑零重写）。 */
  skipped: boolean;
  /** 本次落库后板分区行数（快进时为实数 COUNT）。 */
  count: number;
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  /** 实际重扫/续跑的源（快进为空数组）。 */
  rescanned: string[];
  /** 全量重灌标志（板分区清重灌）。 */
  regranted: boolean;
  /** 本次实际处理的 journal 行数（快进=0）。 */
  journalProcessed: number;
}

/**
 * 板卡域导入（task 表 origin='board' 分区）。幂等三分路见头注 2：
 * 快进（零写入）/ 板分区全量重灌（boards 失效 or journal 滚动）/ journal 重放追赶
 * （仅 journal 增长——touch 集从当前板文件重读条目真身 upsert/缺席 DELETE）。
 */
export function importBoardTask(
  port: StoragePort,
  sources: BoardTaskSources,
  opts?: { schemaVersion?: number },
): BoardTaskImportResult {
  const schemaVersion = opts?.schemaVersion ?? BOARD_TASK_IMPORT_SCHEMA_VERSION;

  const obsJournal = observeJournal(sources.journalFile);
  const obsBoards = observeBoardsDir(sources.boardsDir);

  const current = { schemaVersion };
  // boards checkpoint 分键读写（BOARDS_DIR_CP_SUFFIX 头注；journalFile 键本件独占免分键）
  const boardsCpKey = `${sources.boardsDir}${BOARDS_DIR_CP_SUFFIX}`;
  const cpJournal = readCheckpoint(port, sources.journalFile, {
    ...current, mtimeMs: obsJournal.mtimeMs,
    ...(obsJournal.mtimeNs !== "" ? { mtimeNs: obsJournal.mtimeNs } : {}),
    lineCount: obsJournal.lineCount,
  });
  const cpBoards = readCheckpoint(port, boardsCpKey, {
    ...current, mtimeMs: obsBoards.mtimeMs,
    ...(obsBoards.mtimeNs !== "" ? { mtimeNs: obsBoards.mtimeNs } : {}),
    lineCount: obsBoards.count,
  });
  // journal 滚动检测：checkpoint 行（无论五元组是否全等）记的行数 > 当前观测 = 滚动改名
  // 丢了尾窗——增量不可续，强制全量重灌兜底。行缺失/行数不增=常规失效，走默认分路。
  const rawCpRow = port.query<{ line_count: number }>(
    "SELECT line_count FROM import_checkpoint WHERE path = ?", [sources.journalFile],
  )[0];
  const rolled = rawCpRow !== undefined && rawCpRow.line_count > obsJournal.lineCount;
  // 大源短路不透明态兜底：journal>2MB 且双未变（lines=[] lineCount=基线）时若还有待处理面
  //（cp 失效/中断窗 offset<lineCount），增量段拿不到行内容——降级全量重灌（板文件全量
  // 投影不依赖 journal 内容）。快进条件已在上方排除「cp 有效且到尾」的正常短路态。
  const journalOpaque = obsJournal.lineCount > 0 && obsJournal.lines.length === 0
    && (cpJournal === null || cpJournal.offset < obsJournal.lineCount);

  // 快进条件：未滚动 + 双源全命中 + journal 已跑完（offset=lineCount；offset<lineCount=
  // 中断待续态，不得快进——从 offset 续行追赶）。
  if (!rolled && cpJournal !== null && cpJournal.offset >= obsJournal.lineCount && cpBoards !== null) {
    const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
    return {
      skipped: true,
      count: n("SELECT COUNT(*) AS n FROM task WHERE origin = 'board'"),
      loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?)", sources.journalFile, sources.boardsDir),
      rescanned: [],
      regranted: false,
      journalProcessed: 0,
    };
  }

  const losses: PendingLoss[] = [];
  const rescanned: string[] = [];
  let journalProcessed = 0;

  // ---- 段 A：板分区全量重灌（boards 失效 OR journal 滚动 OR 短路不透明态有待处理面）----
  if (cpBoards === null || rolled || journalOpaque) {
    const attribution = loadAttribution(port);
    port.begin();
    try {
      port.exec("DELETE FROM task WHERE origin = 'board'"); // 分区契约：只清板域，CLI 域（origin='user'）不动
      port.exec("DELETE FROM import_loss WHERE source_path IN (?, ?)", [sources.journalFile, sources.boardsDir]);
      const seenTaskRefs = new Set<string>();
      for (const ref of obsBoards.files) {
        if (ref.entries === null) {
          losses.push({ sourcePath: sources.boardsDir, lineNo: 1, reason: "bad-json", excerpt: JSON.stringify({ gid: ref.gid }).slice(0, 200) });
          continue;
        }
        for (let i = 0; i < ref.entries.length; i++) {
          const row = parseBoardEntry(ref.gid, ref.entries[i], i + 1, sources.boardsDir, attribution, losses); // 数组序=行号（板文件无物理行概念，D2 lesson 同口径）
          if (row === null) continue;
          if (seenTaskRefs.has(row.taskRef)) {
            losses.push({ sourcePath: sources.boardsDir, lineNo: i + 1, reason: "duplicate-id", excerpt: JSON.stringify({ gid: ref.gid, entry_id: (ref.entries[i] as { id?: unknown }).id }).slice(0, 200) }); // 文件序=时间序保首行
            continue;
          }
          seenTaskRefs.add(row.taskRef);
          upsertBoardTaskRow(port, row);
        }
      }
      for (const l of losses.splice(0)) appendLossOnce(port, l);
      writeCheckpoint(port, {
        path: boardsCpKey, mtimeMs: obsBoards.mtimeMs,
        ...(obsBoards.mtimeNs !== "" ? { mtimeNs: obsBoards.mtimeNs } : {}),
        lineCount: obsBoards.count, offset: obsBoards.count, schemaVersion,
      });
      // journal 拨到尾行：全量重投影已覆盖现存全部行的效果（板文件 ≥ journal 态），
      // 旧行无需再追赶。文件缺席=稳定空态照落（0,0,0）——下次文件出现自然失效续赶。
      writeCheckpoint(port, {
        path: sources.journalFile, mtimeMs: obsJournal.mtimeMs,
        ...(obsJournal.mtimeNs !== "" ? { mtimeNs: obsJournal.mtimeNs } : {}),
        lineCount: obsJournal.lineCount, offset: obsJournal.lineCount, schemaVersion,
      });
      port.commit();
    } catch (err) {
      port.rollback();
      throw new Error(`import-board-task: 板分区重灌失败已回滚（保留旧板分区快照）——${err instanceof Error ? err.message : String(err)}`);
    }
    rescanned.push(sources.boardsDir, sources.journalFile);
    journalProcessed = obsJournal.lineCount;
  } else if (cpJournal === null || cpJournal.offset < obsJournal.lineCount) {
    // ---- 段 B：journal 重放追赶（仅 journal 增长；板分区快照不动，只追 touch 集）----
    const fromLine = cpJournal !== null ? cpJournal.offset : 0; // 失效（append=五元组破坏）→0 重放；有效→offset 续行
    const badBoardGids = new Set<string>();
    for (const ref of obsBoards.files) {
      if (ref.entries === null) badBoardGids.add(ref.gid);
    }
    // touch 集收集：任何带 gid+entry_id 的行都视为「该条目变了」（不看 prev/next 摘要）；
    // 坏行落账跳过；板级行（freeze/unfreeze/save/migrate 等，无 entry_id）只推 offset。
    const touched = new Map<string, { gid: string; entryId: string }>();
    for (let i = fromLine; i < obsJournal.lines.length; i++) {
      const lineNo = i + 1;
      const line = obsJournal.lines[i];
      journalProcessed++;
      let j: Record<string, unknown>;
      try {
        const v = JSON.parse(line) as unknown;
        if (typeof v !== "object" || v === null) throw new Error("non-object");
        j = v as Record<string, unknown>;
      } catch {
        losses.push({ sourcePath: sources.journalFile, lineNo, reason: "bad-json", excerpt: line.slice(0, 200) });
        continue;
      }
      if (typeof j.gid !== "string" || !j.gid || typeof j.action !== "string" || !j.action) {
        losses.push({ sourcePath: sources.journalFile, lineNo, reason: "missing-field", excerpt: line.slice(0, 200) });
        continue;
      }
      if (typeof j.entry_id === "string" && j.entry_id) {
        touched.set(`${j.gid} ${j.entry_id}`, { gid: j.gid, entryId: j.entry_id });
      }
    }
    const attribution = loadAttribution(port);
    const boardByGid = new Map(obsBoards.files.map((f) => [f.gid, f]));
    port.begin();
    try {
      if (fromLine === 0) {
        port.exec("DELETE FROM import_loss WHERE source_path = ?", [sources.journalFile]); // 重放路径清旧账一次（D1 events 段同款；续跑路径不清）
      }
      for (const { gid, entryId } of touched.values()) {
        const ref = boardByGid.get(gid);
        if (ref === undefined || ref.entries === null) {
          if (ref === undefined) {
            // 板文件不存在（组连板一起消失）：条目权威缺席=行删除
            port.exec("DELETE FROM task WHERE origin = 'board' AND task_ref = ?", [boardTaskRef(gid, entryId)]);
          } else {
            // 坏板文件半态：无法判「缺席=删除」vs「文件坏」——保守不动行（与全量路径差异备案于头注 5）
            if (!badBoardGids.has(gid)) {
              losses.push({ sourcePath: sources.boardsDir, lineNo: 1, reason: "bad-json", excerpt: JSON.stringify({ gid }).slice(0, 200) });
              badBoardGids.add(gid);
            }
          }
          continue;
        }
        const idx = ref.entries.findIndex((x) => typeof x === "object" && x !== null && (x as { id?: unknown }).id === entryId);
        if (idx === -1) {
          // 条目已从板移除（remove 行到达）：投影行随之删除
          port.exec("DELETE FROM task WHERE origin = 'board' AND task_ref = ?", [boardTaskRef(gid, entryId)]);
          continue;
        }
        const row = parseBoardEntry(gid, ref.entries[idx], idx + 1, sources.boardsDir, attribution, losses);
        if (row !== null) upsertBoardTaskRow(port, row);
      }
      for (const l of losses.splice(0)) appendLossOnce(port, l);
      writeCheckpoint(port, {
        path: sources.journalFile, mtimeMs: obsJournal.mtimeMs,
        ...(obsJournal.mtimeNs !== "" ? { mtimeNs: obsJournal.mtimeNs } : {}),
        lineCount: obsJournal.lineCount, offset: obsJournal.lineCount, schemaVersion,
      });
      port.commit();
    } catch (err) {
      port.rollback();
      throw new Error(`import-board-task: journal 追赶批处理失败已回滚（offset 停留追赶前）——${err instanceof Error ? err.message : String(err)}`);
    }
    if (journalProcessed > 0) rescanned.push(sources.journalFile);
  }

  const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
  return {
    skipped: false,
    count: n("SELECT COUNT(*) AS n FROM task WHERE origin = 'board'"),
    loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?)", sources.journalFile, sources.boardsDir),
    rescanned,
    regranted: cpBoards === null || rolled || journalOpaque,
    journalProcessed,
  };
}
