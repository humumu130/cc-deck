// ---------- artifact 复合键导入器（M11-F2，照 M11-C1/E1 范式五要点） ----------
// 消费面：产物清单源（deliverables.json 形 {sid,path,ts} / ArtifactItem 形 {path,op,exists,...}）
// → artifact 表，复合主键 (source_id, normalized_path)。
//
// F2 特化（对 C1/E1 快照域清的演进）：artifact 表自带 source_id 列——删除面**可精确清**：
// 重扫按「本源解析键集」正向差集删（现存-保留=应删集，JS 侧算差后按 ARTIFACT_DELETE_CHUNK
// 一块 DELETE ... WHERE source_id=? AND normalized_path IN (...)；M11-FIX-C P3-6：NOT IN
// 直删占位符数=保留键数，超 SQLite 变量上限 32766 即炸，分块 NOT IN 又语义错位——每块只
// 排除本块会误删他块保留行；正向删与保留集规模无关，各规模语义一致），只动本源行不误伤
// 他源；同键写入走 UPSERT（ON CONFLICT DO UPDATE 全列覆盖）——
// 「同键新状态覆盖」= exists→missing 演进面（验收 2 核心）。幂等三层=checkpoint 快进×2
// + UPSERT 不增行 + 差集删残留。
//
// 归一口径对齐（抄语义不抄私有实现，参照 artifacts.ts/artifact-view.ts 只读）：
//   source_id：String()+trim+空回退 "local"，记录级 source_id/sourceId 优先、source 级兜底
//     （=artifacts.ts sourceIdOf 的 item→opts→"local" 链语义）。
//   normalized_path：normalize(path||".")+反斜杠转正斜杠+去尾斜杠（=artifacts.ts normalizedPath）。
//   existence_state 三态（=artifact-view.ts evidence 口径 #72A0 P2-3C/#72A0FIX2）：显式
//     boolean exists 才可判（true→exists/false→missing）；unverified=true 记录证据不可采信
//     → 抑制判定；字段缺失/非 boolean → unknown 不猜。读侧门禁（view :377-378）只有
//     existence_state==="exists" 才开 open/download——unknown 行天然禁 open/download。
//   delivery_group_key：只收显式字段不猜（=artifact-view.ts explicitDeliveryGroup 口径）。
//
// 范式五要点（C1 定稿）：port 显式传入+事务内聚；逐源 checkpoint（file 源五元组 stat 先于
// read；内联 records 源用内容指纹替代 mtime——无文件面，同内容即快进）；失效即精确重扫
// （差集删→UPSERT→按源清旧 loss→落新账→回写 checkpoint，单事务）；坏行 loss 不阻断
// （整文件坏 JSON=单条 loss+该源差集清空，源间不阻断）；确定性复合键幂等。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { normalize } from "node:path";
import { sha12, statThenRead } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, listLoss } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级 bump→全源失效强制重扫。 */
export const ARTIFACT_IMPORT_SCHEMA_VERSION = 1;

/** 正向差集删单块大小：分块 IN 删避开 SQLite 变量上限（32766）；测试经 opts.deleteChunkSize 注入小值。 */
export const ARTIFACT_DELETE_CHUNK = 500;

export interface ArtifactImportAttribution {
  project_id?: string | null;
  group_id?: string | null;
  session_id?: string | null;
  task_id?: string | null;
}

export interface ArtifactImportSource {
  /** 显式 source_id（sourceId 别名同收）；缺省经归一回退 "local"。 */
  id?: string;
  sourceId?: string;
  /** 清单 JSON 文件（数组根）——checkpoint 文件级消费。 */
  file?: string;
  /** 内联记录（无文件面，内容指纹 checkpoint）。 */
  records?: readonly unknown[];
  /** source 级归因（记录级 session_id/sid 优先）；悬空 id 落 NULL+dangling-ref 账。 */
  attribution?: ArtifactImportAttribution;
}

export interface ArtifactImportResult {
  /** true=全部源 checkpoint 命中，零写入快进。 */
  skipped: boolean;
  counts: { artifact: number; upserted: number };
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  rescanned: string[];
}

interface ObservedSource {
  key: string;              // loss/checkpoint 标识：file 源=绝对路径，内联源=inline:<idx>
  file: string | null;
  mtimeMs: number;
  lineCount: number;
  records: readonly unknown[] | null; // null=文件缺失/坏 JSON
  badJson: string | null;
}

type ExistenceState = "exists" | "missing" | "unknown";

interface ArtifactRow {
  sourceId: string;
  normalizedPath: string;
  projectId: string | null;
  groupId: string | null;
  sessionId: string | null;
  taskId: string | null;
  deliveryGroupKey: string | null;
  size: number | null;
  kind: string;
  existenceState: ExistenceState;
  createdAt: number;
  updatedAt: number;
}

interface PendingLoss { sourceKey: string; lineNo: number; reason: string; excerpt: string }

/** observe：stat 先于 read 定稿序（权威注释见 import-util.ts）——竞态落「多扫一次」安全侧。 */
function observeFile(file: string, key: string): ObservedSource {
  if (!existsSync(file)) return { key, file, mtimeMs: 0, lineCount: 0, records: null, badJson: null };
  const obs = statThenRead(file);
  const lines = obs.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let records: readonly unknown[] | null = null;
  let badJson: string | null = null;
  try {
    const parsed = JSON.parse(obs.text) as unknown;
    if (Array.isArray(parsed)) records = parsed;
    else if (parsed && typeof parsed === "object") {
      // #183 keyed 账本形态 {sid: [{path,name,size,delivered_at},...]}：拍平成记录
      // 流，sid 从组键注入（条目自带 session_id/sid 时记录级优先，parseRecord 口径）
      const flat: unknown[] = [];
      for (const [sid, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (e && typeof e === "object" && !Array.isArray(e)) flat.push({ sid, ...e });
        }
      }
      records = flat;
    } else badJson = "根非数组/对象";
  } catch {
    badJson = obs.text.slice(0, 200);
  }
  return { key, file, mtimeMs: obs.mtimeMs, lineCount: lines.length, records, badJson };
}

/** 内联源观测：内容指纹（sha1 前 8 hex 作 mtime 位）替代文件 mtime——同内容即快进。 */
function observeInline(records: readonly unknown[], key: string): ObservedSource {
  const fingerprint = parseInt(createHash("sha1").update(JSON.stringify(records)).digest("hex").slice(0, 8), 16);
  return { key, file: null, mtimeMs: fingerprint, lineCount: records.length, records, badJson: null };
}

/** 归一 source_id（对齐 artifacts.ts sourceIdOf：String+trim+空回退 "local"，记录级优先）。 */
function normalizedSourceId(...values: unknown[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "local";
}

/** 归一路径（对齐 artifacts.ts normalizedPath：normalize+反斜杠转正斜杠+去尾斜杠）。 */
function normalizedArtifactPath(path: string): string {
  const value = normalize(path || ".").replaceAll("\\", "/");
  if (value.length > 1) return value.replace(/\/+$/, "");
  return value;
}

/** 三态判定（对齐 artifact-view.ts evidence 口径）：unverified 抑制证据、非 boolean 不猜。 */
function existenceStateOf(rec: Record<string, unknown>): ExistenceState {
  if (rec.unverified === true) return "unknown"; // #72A0FIX2：标记记录的存在证据不可采信
  if (typeof rec.exists === "boolean") return rec.exists ? "exists" : "missing";
  return "unknown"; // 缺证据不默认存在（#72A0 P2-3C）
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function tableHas(port: StoragePort, table: string, id: string): boolean {
  return (port.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [id])[0]?.n ?? 0) > 0;
}

/**
 * 解析单条记录 → artifact 行（解析段纯函数；归因悬空查库判定，悬空写 NULL 不造关联）。
 * 返回 null=坏行拒入（已落 loss 待账）。
 */
function parseRecord(
  port: StoragePort,
  raw: unknown,
  sourceIdResolved: string,
  attribution: ArtifactImportAttribution | undefined,
  lineNo: number,
  sourceKey: string,
  losses: PendingLoss[],
): ArtifactRow | null {
  const bad = (reason: string, excerpt: string): null => {
    losses.push({ sourceKey, lineNo, reason, excerpt: excerpt.slice(0, 200) });
    return null;
  };
  if (typeof raw !== "object" || raw === null) return bad("missing-field", JSON.stringify(raw));
  const rec = raw as Record<string, unknown>;
  const rawPath = typeof rec.path === "string" ? rec.path : (typeof rec.normalized_path === "string" ? rec.normalized_path : null);
  if (!rawPath) return bad("missing-field", JSON.stringify(rec));
  // createdAt 链：ArtifactItem 形 first_at / keyed 账本 delivered_at（#183）/ 旧扁平 ts
  const createdAt = typeof rec.first_at === "number" ? rec.first_at : (typeof rec.delivered_at === "number" ? rec.delivered_at : (typeof rec.ts === "number" ? rec.ts : null));
  if (createdAt === null) return bad("missing-field", JSON.stringify(rec));
  // 归因：记录级 session_id/sid 优先，source 级兜底；悬空查库写 NULL 不造关联
  const sessionId = firstString(rec.session_id, rec.sid, attribution?.session_id);
  if (sessionId === null && rec.sid !== undefined && typeof rec.sid !== "string") {
    return bad("missing-attribution", JSON.stringify(rec)); // sid 字段在但类型非法（readDeliverables 拒收口径）
  }
  if (sessionId === null && typeof rec.ts === "number" && rec.session_id === undefined && attribution?.session_id === undefined) {
    // deliverable 形（ts 计时）却全程无 sid——登记账不收无主条目（readDeliverables 过滤口径）
    return bad("missing-attribution", JSON.stringify(rec));
  }
  const attr = (id: string | null | undefined, table: string): string | null => {
    if (typeof id !== "string" || !id) return null;
    if (!tableHas(port, table, id)) {
      losses.push({ sourceKey, lineNo, reason: "dangling-ref", excerpt: JSON.stringify({ path: rawPath, [table]: id }).slice(0, 200) });
      return null;
    }
    return id;
  };
  const projectId = attr(firstString(attribution?.project_id), "project");
  const groupId = attr(firstString(attribution?.group_id), `"group"`);
  const sessionIdOk = sessionId === null ? null : attr(sessionId, "session");
  const taskId = attr(firstString(attribution?.task_id), "task");
  const updatedAt = typeof rec.last_at === "number" ? rec.last_at : createdAt;
  const sourceId = normalizedSourceId(rec.source_id, rec.sourceId, sourceIdResolved);
  // kind：显式 kind/op 优先；deliverable 形登记（带 sid 字段）缺省 "deliverable"、其余 "artifact"
  const kind = firstString(rec.kind, rec.op) ?? (rec.sid !== undefined || rec.session_id !== undefined ? "deliverable" : "artifact");
  return {
    sourceId,
    normalizedPath: normalizedArtifactPath(rawPath),
    projectId,
    groupId,
    sessionId: sessionIdOk,
    taskId,
    deliveryGroupKey: firstString(rec.delivery_group_key, rec.deliveryGroupKey),
    size: typeof rec.size === "number" ? rec.size : null,
    kind,
    existenceState: existenceStateOf(rec),
    createdAt,
    updatedAt,
  };
}

/**
 * artifact 复合键导入：产物清单源 → artifact 表（复合主键 (source_id, normalized_path)）。
 * 幂等/失效精确重扫/事务语义沿 C1 范式；删除面为按源差集删（F2 特化，见头注）。
 */
export function importArtifacts(
  port: StoragePort,
  sources: readonly ArtifactImportSource[],
  opts?: { schemaVersion?: number; deleteChunkSize?: number },
): ArtifactImportResult {
  const schemaVersion = opts?.schemaVersion ?? ARTIFACT_IMPORT_SCHEMA_VERSION;
  const deleteChunk = Math.max(1, opts?.deleteChunkSize ?? ARTIFACT_DELETE_CHUNK);
  // ---------- 观测（stat 先于 read；内联源内容指纹） ----------
  const observed = sources.map((s, idx) => {
    const resolvedId = normalizedSourceId(s.id, s.sourceId);
    if (s.file !== undefined) return { src: s, obs: observeFile(s.file, s.file), resolvedId };
    return { src: s, obs: observeInline(s.records ?? [], `inline:${idx}`), resolvedId };
  });
  const current = (o: ObservedSource) => ({ mtimeMs: o.mtimeMs, lineCount: o.lineCount, schemaVersion });
  const allValid = observed.length > 0 && observed.every(({ obs }) => readCheckpoint(port, obs.key, current(obs)) !== null);
  const sourceKeys = observed.map(({ obs }) => obs.key);
  if (allValid) {
    return {
      skipped: true,
      counts: { artifact: port.query<{ n: number }>("SELECT COUNT(*) AS n FROM artifact")[0]?.n ?? -1, upserted: 0 },
      loss: listLoss(port).filter((l) => sourceKeys.includes(l.sourcePath)).length,
      rescanned: [],
    };
  }

  // ---------- 解析段（纯函数+归因查库）：行集+loss 待账 ----------
  const losses: PendingLoss[] = [];
  const rowsBySource: { obs: ObservedSource; resolvedId: string; rows: ArtifactRow[] }[] = [];
  for (const { obs, resolvedId, src } of observed) {
    // 同源内同键去重：后写赢（UPSERT 演进语义），重复发生落 duplicate-key 账留痕
    const rows: ArtifactRow[] = [];
    const seen = new Map<string, ArtifactRow>();
    if (obs.records !== null) {
      obs.records.forEach((raw, idx) => {
        const row = parseRecord(port, raw, resolvedId, src.attribution, idx + 1, obs.key, losses);
        if (row === null) return;
        // 去重键=JSON.stringify([source_id, path])（M11-FIX-C P3-5）：两段均可含空格
        // （source_id 仅 trim 不禁内嵌、path 原样保留），朴素分隔符拼接会错位撞键——
        // ("a b","c") 与 ("a","b c") 同键→duplicate 误判+后写赢吃行；JSON 编码无歧义免转义。
        const key = JSON.stringify([row.sourceId, row.normalizedPath]);
        if (seen.has(key)) {
          losses.push({ sourceKey: obs.key, lineNo: idx + 1, reason: "duplicate-key", excerpt: JSON.stringify({ source_id: row.sourceId, path: row.normalizedPath }).slice(0, 200) });
          seen.delete(key);
        }
        seen.set(key, row);
      });
    }
    rows.push(...seen.values());
    if (obs.badJson !== null) losses.push({ sourceKey: obs.key, lineNo: 1, reason: "bad-json", excerpt: obs.badJson });
    rowsBySource.push({ obs, resolvedId, rows });
  }

  // 删除计划（调用级并集）：按最终 source_id 聚合本次调用全部源要保留的键——记录级
  // source_id 覆盖/多源共写同一命名空间时并集保留互不误删。语义=快照式「本次 sources
  // 即所涉命名空间的全量真源」（备案：跨调用部分传源不得与缺席源共享命名空间）。
  const planMap = new Map<string, Set<string>>();
  for (const { rows, resolvedId } of rowsBySource) {
    if (!planMap.has(resolvedId)) planMap.set(resolvedId, new Set());
    for (const r of rows) {
      let keep = planMap.get(r.sourceId);
      if (keep === undefined) { keep = new Set(); planMap.set(r.sourceId, keep); }
      keep.add(r.normalizedPath);
    }
  }

  // ---------- 落库段（单事务：差集删→UPSERT→loss→checkpoint） ----------
  port.begin();
  try {
    for (const [sourceId, keep] of planMap) {
      // 正向差集删（M11-FIX-C P3-6）：现存-保留=应删集，JS 侧算差后分块 IN 删——NOT IN
      // 直删占位符数=保留键数（超 SQLite 变量上限 32766 即炸），分块 NOT IN 则语义错位
      // （每块只排除本块，误删他块保留行）。正向删与保留集规模无关，各规模语义一致
      // =精确删「本源名下不在保留集的行」。键集空=全清该 id（单语句，坏 JSON 源路径）。
      if (keep.size === 0) {
        port.exec("DELETE FROM artifact WHERE source_id = ?", [sourceId]);
      } else {
        const stale = port
          .query<{ normalized_path: string }>("SELECT normalized_path FROM artifact WHERE source_id = ?", [sourceId])
          .map((r) => r.normalized_path)
          .filter((p) => !keep.has(p));
        for (let i = 0; i < stale.length; i += deleteChunk) {
          const chunk = stale.slice(i, i + deleteChunk);
          port.exec(
            `DELETE FROM artifact WHERE source_id = ? AND normalized_path IN (${chunk.map(() => "?").join(",")})`,
            [sourceId, ...chunk],
          );
        }
      }
    }
    for (const { rows } of rowsBySource) {
      for (const r of rows) {
        port.exec(
          `INSERT INTO artifact (source_id, normalized_path, project_id, group_id, session_id, task_id, delivery_group_key, size, kind, existence_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id, normalized_path) DO UPDATE SET
             project_id=excluded.project_id, group_id=excluded.group_id, session_id=excluded.session_id,
             task_id=excluded.task_id, delivery_group_key=excluded.delivery_group_key, size=excluded.size,
             kind=excluded.kind, existence_state=excluded.existence_state, created_at=excluded.created_at,
             updated_at=excluded.updated_at`,
          [r.sourceId, r.normalizedPath, r.projectId, r.groupId, r.sessionId, r.taskId, r.deliveryGroupKey, r.size, r.kind, r.existenceState, r.createdAt, r.updatedAt],
        );
      }
    }
    if (sourceKeys.length > 0) {
      port.exec(`DELETE FROM import_loss WHERE source_path IN (${sourceKeys.map(() => "?").join(",")})`, sourceKeys);
    }
    for (const l of losses) appendLoss(port, { sourcePath: l.sourceKey, lineNo: l.lineNo, reason: l.reason, excerpt: l.excerpt });
    for (const { obs } of rowsBySource) writeCheckpoint(port, { path: obs.key, mtimeMs: obs.mtimeMs, lineCount: obs.lineCount, offset: obs.lineCount, schemaVersion });
    port.commit();
  } catch (err) {
    port.rollback();
    throw new Error(`import-artifact: 产物导入失败已回滚（保留旧快照）——${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    skipped: false,
    counts: { artifact: port.query<{ n: number }>("SELECT COUNT(*) AS n FROM artifact")[0]?.n ?? -1, upserted: rowsBySource.reduce((n, x) => n + x.rows.length, 0) },
    loss: losses.length,
    rescanned: sourceKeys,
  };
}
