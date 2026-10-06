// ---------- 派单与经验导入器（M11-D2）：dispatch-log.ndjson + boards/<gid>.json → dispatch/lesson 双表 ----------
// 消费面：dispatch-log.ndjson（org.ts append-only 派单台账，行级快账——「何时派了什么、结果如何」）
//   + boards/<gid>.json 的 lessons 分区（#087 经验回流，append-only；板文件是组内事实源，lessons
//   是其分区，目录级虚拟源同 D1 tasks/accept 口径）。
//
// importer 范式（沿用 D1 import-session-task.ts，D2 特化三点）：
//   1. 两源各持 B2 checkpoint 五元组：ndjson 行级语义（offset=前 offset 行已处理，续跑从
//      offset+1 起）；boardsDir 目录级语义（mtime=板文件最大 mtime、lineCount=板文件数，
//      命中=域快进，失效=域重灌——JSON 树无逐行续跑面）。
//   2. 失效 vs 中断（D1 调和的 D2 版）：
//      · cp 有效+offset<lineCount = 纯中断续跑——不清域，从 offset+1 增量续行；重投链状态
//        （当前段号/是否终态）从 dispatch 表恢复（dispatch 域仅由本源灌入，全表回溯即全量状态）。
//      · cp 失效 = 从 0 重放——dispatch 段首批事务清 lesson+dispatch 两域（倒序：lesson 的
//        source_dispatch_id FK 引用 dispatch）+本源旧 loss。联动规则：dispatch 失效 ⇒ lesson
//        必重灌（source_dispatch_id 悬空面随 dispatch 集变化，防陈旧归因）；boards 失效 ⇒ 仅
//        lesson 重灌。文件缺失（lines=null）=源不可观测，不动作不清域（D1 events 同口径）。
//   3. dispatch 一行状态机（schema.ts 头注：重投新建一行、attempt_no+1、parent 指父、旧终态行
//      永不删除）的 ndjson 落法：同 id 多行=单段状态轨迹（dispatched→running→done/failed），
//      收敛一行——status=末行、created_at=首行 ts、updated_at=末行 ts、receipt=末个非空。
//      终态行（done/failed）后再现行 = 重投事件——前段固化（终态保留），新段 id=`<id>#r<N>`、
//      attempt_no=N+1、parent_dispatch_id 指前段（段 1 attempt=1、id 原样、parent=NULL）。
//      源无 attempt/parent 字段，段链由行序终态切分推导（唯一可辩护读法；写侧重投本就独立
//      成 id 行，天然满足「重投新建行」，此链只为同 id 重投轨迹兜底——fixture 断言在件）。
//   4. 归因（悬空 NULL+loss 绝不造关联；「不匹配=常态」NULL 不落账，D1 悬空两分法同款）：
//      · group_id ← project_anchor → group.anchor_dir 映射；无 anchor（咨询档行常态）→NULL
//        不落账；有 anchor 悬空 →NULL+dangling-ref。
//      · source_session_id ← session_id → session.id 直查；空/缺（旧数据常态，org.ts「缺省不
//        降级」）→NULL 不落账；非空悬空 →NULL+dangling-ref。
//      · target_member_id ← target → session.id → member_id 链（veteran 承接=会话=成员，
//        pickVeteran 返回 relay session id 同域）；占位符（"org-leader"/"spawn-pending"）非
//        会话 id →NULL 不落账（承接描述常态）。
//      · actor 直落（NOT NULL 列）；缺失/非串 →'' 落行+missing-field（读侧「缺省不降级」
//        口径——行不拒，账要留痕）。
//      · task_id / command_id：源无对应概念 →NULL 恒（ndjson 无 task 维度）。
//   5. 坏行只进 loss 不阻断（D1 六场景风格）：bad-json（行级）/missing-field（id/status/ts/tier
//      缺或类型坏）/bad-field（status 越四态 CHECK 词表——拒行；lessons 非数组——整板账）/
//      dangling-ref（悬空引用）/duplicate-id（lesson 同 id 二遇，文件序=时间序保首行）。
//   6. lesson 直落口径：id/text/ts 直落；tags 洗刷同 projects.ts addLesson（滤非串空串+去重）；
//      gid=板文件名 →group 悬空 →NULL+dangling-ref（照导文本——组归因缺失不丢经验事实）；
//      source_dispatch_id 非空悬空 →NULL+dangling-ref；task_id 源无 →NULL 恒。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { statThenRead } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, type LossRecord } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级时 bump→两源全部失效强制重放（与 DB user_version 正交）。 */
export const DISPATCH_LESSON_IMPORT_SCHEMA_VERSION = 1;

/** 默认批事务行数（批尾写 checkpoint；批间中断=已完成批已提交，续跑零重复零丢失）。 */
export const DEFAULT_BATCH_SIZE = 500;

/** dispatch.status 四态词表（DDL CHECK；org.ts DispatchStatus 同域直落）。 */
const DISPATCH_STATUS = new Set(["dispatched", "running", "done", "failed"]);
/** 终态集合（一行状态机的段切分锚：终态行后再现行=重投）。 */
const TERMINAL_STATUS = new Set(["done", "failed"]);

// ---------- 源行模型（自持宽松行型——坏行字段宽松，校验后落库） ----------
interface DispatchLine {
  ts: number;
  id: string;
  tier: string;
  target?: string;
  project_anchor?: string;
  status: string;
  receipt?: string;
  session_id?: string;
  actor?: string;
}

interface LessonEntryRaw {
  id?: unknown;
  text?: unknown;
  tags?: unknown;
  ts?: unknown;
  source_dispatch_id?: unknown;
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

interface BoardFileRef {
  gid: string;
  file: string;
  mtimeMs: number;
  doc: { lessons?: unknown } | null; // null=读失败/坏 JSON（落账不阻断）
}

/** 板目录观测（扁平一层 <gid>.json；虚拟源：mtime=最大、lineCount=文件数）。 */
function observeBoardsDir(dir: string): { mtimeMs: number; count: number; files: BoardFileRef[] } {
  if (!existsSync(dir)) return { mtimeMs: 0, count: 0, files: [] };
  const files: BoardFileRef[] = [];
  let maxMtime = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const m = Math.round(st.mtimeMs);
    if (m > maxMtime) maxMtime = m;
    let doc: { lessons?: unknown } | null = null;
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as { lessons?: unknown };
    } catch {
      doc = null; // 坏板文件：段 2 落账（bad-json），不阻断
    }
    files.push({ gid: name.slice(0, -5), file, mtimeMs: m, doc });
  }
  return { mtimeMs: maxMtime, count: files.length, files };
}

// ---------- 中间行模型 ----------
interface PendingLoss {
  sourcePath: string;
  lineNo: number;
  reason: string;
  excerpt: string;
}

/** 重投链状态：同 root id 的当前段（段 1=原 id；段 N=`<id>#rN`）。 */
interface DispatchSeg {
  segId: string;
  attemptNo: number;
  terminal: boolean;
}

/**
 * 幂等落账：同 source_path+line_no+reason 已有账则跳过（D1 同款——行级续跑可能重遇断点前
 * 已落账的坏行；失效重放路径先 DELETE 旧账再落，与守卫正交）。
 */
function appendLossOnce(port: StoragePort, record: LossRecord): void {
  const dup = port.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM import_loss WHERE source_path = ? AND line_no = ? AND reason = ?",
    [record.sourcePath, record.lineNo, record.reason],
  )[0]?.n ?? 0;
  if (dup === 0) appendLoss(port, record);
}

// ---------- dispatch 段：重投链状态恢复（续跑） ----------
/** 从 dispatch 表恢复重投链状态（域仅由本源灌入，全表回溯=全量状态；行数 M1 量级）。 */
function restoreSegs(port: StoragePort): Map<string, DispatchSeg> {
  const rows = port.query<{ id: string; attempt_no: number; status: string; parent_dispatch_id: string | null }>(
    "SELECT id, attempt_no, status, parent_dispatch_id FROM dispatch",
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const segs = new Map<string, DispatchSeg>();
  for (const r of rows) {
    // root=沿 parent 链回溯至 NULL（不猜 id 尾缀——源 id 恰带 "#rN" 尾也正确归位）
    let root = r.id;
    let guard = 0;
    while (guard++ < 1000) {
      const parent = byId.get(root)?.parent_dispatch_id ?? null;
      if (parent === null) break;
      root = parent;
    }
    const prev = segs.get(root);
    if (!prev || r.attempt_no > prev.attemptNo) {
      segs.set(root, { segId: r.id, attemptNo: r.attempt_no, terminal: TERMINAL_STATUS.has(r.status) });
    }
  }
  return segs;
}

// ---------- dispatch 段：单行应用（一行状态机） ----------
function applyDispatchLine(
  port: StoragePort,
  e: DispatchLine,
  lineNo: number,
  srcPath: string,
  segs: Map<string, DispatchSeg>,
  groupByAnchor: Map<string, string>,
  sessionMember: Map<string, string | null>,
  dispatchIds: Set<string>,
  losses: PendingLoss[],
): void {
  const src = srcPath;
  const excerpt = JSON.stringify(e).slice(0, 200);
  if (typeof e.id !== "string" || !e.id) {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
    return;
  }
  if (typeof e.status !== "string" || !DISPATCH_STATUS.has(e.status)) {
    losses.push({ sourcePath: src, lineNo, reason: e.status === undefined ? "missing-field" : "bad-field", excerpt });
    return;
  }
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
    return;
  }
  if (typeof e.tier !== "string" || e.tier === "") {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt });
    return;
  }

  // 归因映射（悬空两分法：常态 NULL 不落账；显式悬空 NULL+落账）
  const anchor = typeof e.project_anchor === "string" ? e.project_anchor : "";
  const groupId = anchor === "" ? null : (groupByAnchor.get(anchor) ?? null);
  if (anchor !== "" && groupId === null) {
    losses.push({ sourcePath: src, lineNo, reason: "dangling-ref", excerpt });
  }
  const sid = typeof e.session_id === "string" ? e.session_id : "";
  const sourceSessionId = sid === "" ? null : (sessionMember.has(sid) ? sid : null);
  if (sid !== "" && sourceSessionId === null) {
    losses.push({ sourcePath: src, lineNo, reason: "dangling-ref", excerpt });
  }
  const target = typeof e.target === "string" ? e.target : "";
  // target→session→member 链：占位符（"org-leader"/"spawn-pending"）非会话 id，NULL 不落账
  const targetMemberId = target !== "" && sessionMember.has(target) ? (sessionMember.get(target) ?? null) : null;
  const actor = typeof e.actor === "string" ? e.actor : "";
  if (e.actor !== undefined && typeof e.actor !== "string") {
    losses.push({ sourcePath: src, lineNo, reason: "missing-field", excerpt }); // 账要留痕，行不拒（actor='' 落行）
  }
  const receipt = typeof e.receipt === "string" ? e.receipt : "";

  const seg = segs.get(e.id);
  if (!seg) {
    // 开段 1：id 原样、attempt=1、parent=NULL、created_at=本行 ts
    port.exec(
      `INSERT INTO dispatch (id, task_id, group_id, tier, target_member_id, source_session_id, actor, command_id,
         status, receipt, attempt_no, parent_dispatch_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULLIF(?, ''), 1, NULL, ?, ?)`,
      [e.id, groupId, e.tier, targetMemberId, sourceSessionId, actor, e.status, receipt, e.ts, e.ts],
    );
    segs.set(e.id, { segId: e.id, attemptNo: 1, terminal: TERMINAL_STATUS.has(e.status) });
    dispatchIds.add(e.id);
    return;
  }
  if (seg.terminal) {
    // 重投：前段固化（终态保留不删），新段 id 派生、attempt+1、parent 指前段
    const nextAttempt = seg.attemptNo + 1;
    const segId = `${e.id}#r${nextAttempt}`;
    if (dispatchIds.has(segId)) {
      // 派生 id 撞既有行（源 id 恰带 "#rN" 尾与重投派生撞名）：拒行落账不 INSERT——段状态保持，
      // 后续同 root 行仍按当前段终态处理；范式「坏行 loss 不阻断」（M11-REVIEW3 P2-1 修复）
      losses.push({ sourcePath: src, lineNo, reason: "duplicate-id", excerpt });
      return;
    }
    port.exec(
      `INSERT INTO dispatch (id, task_id, group_id, tier, target_member_id, source_session_id, actor, command_id,
         status, receipt, attempt_no, parent_dispatch_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULLIF(?, ''), ?, ?, ?, ?)`,
      [segId, groupId, e.tier, targetMemberId, sourceSessionId, actor, e.status, receipt, nextAttempt, seg.segId, e.ts, e.ts],
    );
    segs.set(e.id, { segId, attemptNo: nextAttempt, terminal: TERMINAL_STATUS.has(e.status) });
    dispatchIds.add(segId);
    return;
  }
  // 当前段推进：status/归因列末行覆盖；created_at 不动（=首行 ts）；receipt 只被非空覆盖
  port.exec(
    `UPDATE dispatch SET status = ?, tier = ?, group_id = ?, target_member_id = ?, source_session_id = ?,
       actor = ?, receipt = COALESCE(NULLIF(?, ''), receipt), updated_at = ? WHERE id = ?`,
    [e.status, e.tier, groupId, targetMemberId, sourceSessionId, actor, receipt, e.ts, seg.segId],
  );
  segs.get(e.id)!.terminal = TERMINAL_STATUS.has(e.status);
}

// ---------- lesson 段：单板重灌 ----------
function importBoardLessons(
  port: StoragePort,
  ref: BoardFileRef,
  srcDir: string,
  groupIds: Set<string>,
  dispatchIds: Set<string>,
  seenLessonIds: Set<string>,
  losses: PendingLoss[],
): void {
  const excerptBase = JSON.stringify({ gid: ref.gid }).slice(0, 200);
  if (ref.doc === null) {
    losses.push({ sourcePath: srcDir, lineNo: 1, reason: "bad-json", excerpt: excerptBase });
    return;
  }
  if (!Array.isArray(ref.doc.lessons)) {
    // 读侧对非数组静默忽略（projects.ts:397）；导入面留痕：整板账一条，0 行
    losses.push({ sourcePath: srcDir, lineNo: 1, reason: "bad-field", excerpt: excerptBase });
    return;
  }
  const lessons = ref.doc.lessons as LessonEntryRaw[];
  for (let i = 0; i < lessons.length; i++) {
    const lineNo = i + 1; // lessons 数组序=行号（板文件无物理行概念，数组内序即时间序）
    const l = lessons[i]!;
    const excerpt = JSON.stringify({ gid: ref.gid, lesson: l }).slice(0, 200);
    if (typeof l !== "object" || l === null) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "missing-field", excerpt });
      continue;
    }
    if (typeof l.id !== "string" || !l.id || typeof l.text !== "string" || !l.text.trim()
      || typeof l.ts !== "number" || !Number.isFinite(l.ts)) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "missing-field", excerpt });
      continue;
    }
    if (seenLessonIds.has(l.id)) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "duplicate-id", excerpt }); // 文件序=时间序，保首行
      continue;
    }
    seenLessonIds.add(l.id);
    // tags 洗刷同 addLesson（projects.ts:587）：滤非串/空串+去重；非数组→bad-field+落 []
    let tags: string[] = [];
    if (Array.isArray(l.tags)) {
      tags = [...new Set(l.tags.filter((t): t is string => typeof t === "string" && t.trim() !== ""))];
    } else if (l.tags !== undefined) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "bad-field", excerpt });
    }
    // 组归因：gid 悬空（组未导入/被拒入）→NULL+dangling-ref，照导文本
    const groupId = groupIds.has(ref.gid) ? ref.gid : null;
    if (groupId === null) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "dangling-ref", excerpt });
    }
    // dispatch 归因：非空悬空→NULL+dangling-ref；空/缺→NULL 不落账
    const sdi = typeof l.source_dispatch_id === "string" ? l.source_dispatch_id : "";
    const sourceDispatchId = sdi === "" ? null : (dispatchIds.has(sdi) ? sdi : null);
    if (sdi !== "" && sourceDispatchId === null) {
      losses.push({ sourcePath: srcDir, lineNo, reason: "dangling-ref", excerpt });
    }
    port.exec(
      `INSERT INTO lesson (id, group_id, task_id, text, tags_json, source_dispatch_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [l.id, groupId, l.text, JSON.stringify(tags), sourceDispatchId, l.ts],
    );
  }
}

// ---------- 主入口 ----------
/**
 * 派单与经验域导入。两源 checkpoint 联动幂等：
 * · 两源全命中且 ndjson 已跑完 → skipped（零写入）。
 * · dispatch 段：行级批事务（batchSize 行/批，批尾写 checkpoint）——中断续跑从 offset+1 增量
 *   续行（重投链状态从 dispatch 表恢复）；失效从 0 重放（首批事务清 lesson+dispatch 两域+本源
 *   旧 loss，重投链从零重建）。
 * · lesson 段（boards 失效 OR dispatch 失效才触发——dispatch 集变化联动悬空面）：单事务
 *   「清 lesson 域+boards 源旧 loss→重灌→回写 checkpoint」。
 */
export function importDispatchLesson(
  port: StoragePort,
  sources: { dispatchLogFile: string; boardsDir: string },
  opts?: { schemaVersion?: number; batchSize?: number },
): {
  skipped: boolean;
  counts: { dispatch: number; lesson: number };
  loss: number;
  rescanned: string[];
  dispatchProcessed: number;
} {
  const schemaVersion = opts?.schemaVersion ?? DISPATCH_LESSON_IMPORT_SCHEMA_VERSION;
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;

  const obsLog = observeNdjson(sources.dispatchLogFile);
  const obsBoards = observeBoardsDir(sources.boardsDir);

  const current = { schemaVersion };
  const cpLog = obsLog.lines !== null
    ? readCheckpoint(port, sources.dispatchLogFile, { ...current, mtimeMs: obsLog.mtimeMs, lineCount: obsLog.lineCount })
    : null;
  const cpBoards = readCheckpoint(port, sources.boardsDir, { ...current, mtimeMs: obsBoards.mtimeMs, lineCount: obsBoards.count });

  // 快进条件：两源全命中 **且 ndjson 已跑完**（offset=lineCount）；offset<lineCount=中断待续态
  // （boards 账已在、仅 dispatch 段余行）——不得快进，走段 1 从 offset+1 增量续跑。
  if (cpLog !== null && cpLog.offset >= obsLog.lineCount && cpBoards !== null) {
    const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
    return {
      skipped: true,
      counts: { dispatch: n("SELECT COUNT(*) AS n FROM dispatch"), lesson: n("SELECT COUNT(*) AS n FROM lesson") },
      loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?)",
        sources.dispatchLogFile, sources.boardsDir),
      rescanned: [],
      dispatchProcessed: 0,
    };
  }

  const losses: PendingLoss[] = [];
  let dispatchProcessed = 0;
  const rescanned: string[] = [];

  // ---- 段 1：dispatch-log 行级重放/续跑（重投链状态机） ----
  if (obsLog.lines !== null) {
    const replay = cpLog === null; // 失效/首次→0 重放（首批事务清两域）；有效→offset+1 续跑
    const fromLine = replay ? 0 : cpLog!.offset;
    // 归因锚预载（段 1 与续跑路径共用；dispatch 重放场景 group/session 行不受本域清理影响）
    const groupByAnchor = new Map<string, string>(
      port.query<{ id: string; anchor_dir: string }>(`SELECT id, anchor_dir FROM "group"`).map((r) => [r.anchor_dir, r.id]),
    );
    const sessionMember = new Map<string, string | null>(
      port.query<{ id: string; member_id: string | null }>("SELECT id, member_id FROM session").map((r) => [r.id, r.member_id]),
    );
    // 重投链状态：重放从零重建（域将清）；续跑从 dispatch 表恢复（前批段已在库）
    const segs = replay ? new Map<string, DispatchSeg>() : restoreSegs(port);
    // 开段撞名预检集：续跑态从表预载（与 restoreSegs 同源）；重放态必须从空集自建——
    // 域将被首批 DELETE，预载旧 id 会残留在内存集里，重放中派生 id 撞「已删行」误报拒行
    const dispatchIds = replay ? new Set<string>() : new Set(port.query<{ id: string }>("SELECT id FROM dispatch").map((r) => r.id));

    let batch: { ev: DispatchLine | null; lineNo: number }[] = [];
    let cleared = false; // 清域单次：重放首修批清，后续批只增量（每批清会把前批灌的父行删掉，
    // 跨批段链 INSERT 时 parent 悬空炸 FK；且删了再灌=只留末批的静默丢行）
    const flushBatch = (): void => {
      if (batch.length === 0) return;
      port.begin();
      try {
        if (replay && !cleared) {
          // 倒序清域：lesson.source_dispatch_id FK 引用 dispatch（dispatch 失效 ⇒ lesson 段必重灌）
          port.exec("DELETE FROM lesson");
          port.exec("DELETE FROM dispatch");
          port.exec("DELETE FROM import_loss WHERE source_path = ?", [sources.dispatchLogFile]);
          cleared = true;
        }
        let lastLine = fromLine;
        for (const b of batch) {
          if (b.ev !== null) {
            applyDispatchLine(port, b.ev, b.lineNo, sources.dispatchLogFile, segs, groupByAnchor, sessionMember, dispatchIds, losses);
          }
          lastLine = b.lineNo;
        }
        for (const l of losses.splice(0)) appendLossOnce(port, l);
        writeCheckpoint(port, {
          path: sources.dispatchLogFile, mtimeMs: obsLog.mtimeMs, lineCount: obsLog.lineCount,
          offset: lastLine, schemaVersion,
        });
        port.commit();
      } catch (err) {
        port.rollback();
        throw new Error(`import-dispatch-lesson: dispatch 批处理失败已回滚（offset 停留前批尾）——${err instanceof Error ? err.message : String(err)}`);
      }
      dispatchProcessed += batch.length;
      batch = [];
    };
    for (let i = fromLine; i < obsLog.lines.length; i++) {
      const line = obsLog.lines[i]!;
      const lineNo = i + 1;
      let ev: DispatchLine | null = null;
      if (line.trim() !== "") {
        try {
          ev = JSON.parse(line) as DispatchLine;
        } catch {
          losses.push({ sourcePath: sources.dispatchLogFile, lineNo, reason: "bad-json", excerpt: line.slice(0, 200) });
        }
      }
      batch.push({ ev, lineNo });
      if (batch.length >= batchSize) flushBatch();
    }
    flushBatch();
    if (obsLog.lineCount === 0 && fromLine === 0) {
      // 空文件也要落 checkpoint（offset=0 全法有效），否则每次调用都失效重扫空转
      port.begin();
      try {
        port.exec("DELETE FROM lesson");
        port.exec("DELETE FROM dispatch");
        port.exec("DELETE FROM import_loss WHERE source_path = ?", [sources.dispatchLogFile]);
        writeCheckpoint(port, { path: sources.dispatchLogFile, mtimeMs: obsLog.mtimeMs, lineCount: 0, offset: 0, schemaVersion });
        port.commit();
      } catch (err) {
        port.rollback();
        throw new Error(`import-dispatch-lesson: 空 dispatch-log checkpoint 写入失败——${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 条件报扫：重放（域清重灌）或实际续跑处理了行才报——跑完态+他源失效时零处理不虚报
    // （M11-REVIEW3 P3-5：原无条件 push 在 boards 失效轮虚报 dispatch 重扫）
    if (replay || dispatchProcessed > 0) rescanned.push(sources.dispatchLogFile);
  }

  // ---- 段 2：lesson 域（boards 失效 OR dispatch 失效才触发——dispatch 集变化联动悬空面重算） ----
  if (cpBoards === null || cpLog === null) {
    const groupIds = new Set(port.query<{ id: string }>(`SELECT id FROM "group"`).map((r) => r.id));
    const dispatchIds = new Set(port.query<{ id: string }>("SELECT id FROM dispatch").map((r) => r.id));
    port.begin();
    try {
      port.exec("DELETE FROM lesson");
      port.exec("DELETE FROM import_loss WHERE source_path = ?", [sources.boardsDir]);
      const seenLessonIds = new Set<string>();
      for (const ref of obsBoards.files) {
        importBoardLessons(port, ref, sources.boardsDir, groupIds, dispatchIds, seenLessonIds, losses);
      }
      for (const l of losses.splice(0)) appendLossOnce(port, l);
      writeCheckpoint(port, { path: sources.boardsDir, mtimeMs: obsBoards.mtimeMs, lineCount: obsBoards.count, offset: obsBoards.count, schemaVersion });
      port.commit();
    } catch (err) {
      port.rollback();
      throw new Error(`import-dispatch-lesson: lesson 域重灌失败已回滚（保留旧 lesson 快照）——${err instanceof Error ? err.message : String(err)}`);
    }
    rescanned.push(sources.boardsDir);
  }

  const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
  return {
    skipped: false,
    counts: { dispatch: n("SELECT COUNT(*) AS n FROM dispatch"), lesson: n("SELECT COUNT(*) AS n FROM lesson") },
    loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path IN (?, ?)",
      sources.dispatchLogFile, sources.boardsDir),
    rescanned,
    dispatchProcessed,
  };
}
