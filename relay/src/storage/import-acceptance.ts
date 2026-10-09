// ---------- 验收域导入器（M11-F1，照 C1/E1/D1 范式五要点） ----------
// 消费面：data/acceptances/<32hex>.json（sheet 登记单）+ <32hex>.results.json（提交历史账）
//   → acceptance_sheet + acceptance_item + acceptance_result（B1 冻结 DDL 三表；「history」非
//   独立表=results 文件的 history[] 数组，展开为 result 多行）。
//
// 映射口径（冻结件 §4 loss list + acceptance.ts 读侧语义对表）：
//   · sheet：id=文件原生 32hex 业务键直用（非 32hex 拒入——线上 listAcceptances 同词表，:162
//     ACCEPTANCE_ID_RE 对表）；task_id 恒 NULL（源无 task 关联事实，rows[].task 是人类可读
//     任务号串，非外键）；group_id←cwd 精确匹配 group.anchor_dir（D1 同款归因链）；cwd 缺失/
//     匹配不上→NULL+missing-attribution 落账（Leader 派单口径：缺归因落账）；sheet_key 保留
//     原值（冻结件：不进公开表单正文——线上下发侧自有 32hex 校验，导入层不裁）；preface/notes
//     DDL 无列丢弃（payload 无处安放，备案）；内容 id 重复（两文件声明同 doc.id）→duplicate-id
//     首文件赢+后者整单拒入（P2-2 案 A）。
//   · item：rows[] 数组序→item_index（1-based，冻结件「数组顺序成为 item_index」）；id 确定性
//     `itm-${sha12(sheetId/index)}`；task/item/criteria 三串必填（异常行拒入+loss，同冻结件）。
//   · result：history[] 逐条×逐 row 展开——**重复 history 不折叠**（见下区分）；同 history 内
//     同 (h,i) 二见→duplicate-key 保首（P2-2 案 B，跨 history 条目不受影响）；id 确定性
//     `res-${sha12(sheetId/h序/row.i+1)}`；verdict 词表 pass|fail|NULL（词表外拒行）；actor←ua
//     （缺失→'import-migration' 迁移批 actor，冻结件「原提交元数据缺失由 NULL/迁移批 actor」，
//     列 NOT NULL 故取后者）；created_at←at；row.i(0-based)→item_index=i+1 定位 item，越界
//     悬空拒行+loss。counts/ck 字段 DDL 无列丢弃（counts 可由 result 聚合重建；ck 是 KV 侧
//     消费 nonce，备案）。
//
// **history 不折叠 vs E1「最新批次账」的区分**（派单点名，备案）：
//   E1 的 notifications.json 是同一实体的重复投影（同 key=同通知，折叠成一行+duplicate-key 账
//   ——当前态语义）；results.json 的 history[] 是 append-only 判定事实流（saveResult 每次 push，
//   用户可改判重提）——每条历史都是独立事实，折叠即销毁审计面。线上读侧（listAcceptances
//   :169）取 history[末位] 做「最新批次」投影——**折叠发生在读投影，不在存储**；SQLite 存
//   全量批次，投影归视图层。故同 item 多条 verdict 历史全保留为多行 result，不落账不折叠。
//
// 范式五要点（C1 定稿）：port 显式传入+事务内聚；目录级 checkpoint 虚拟源（mtime=树内最大、
// lineCount=文件数，命中=域快进，失效=域清重灌 result→item→sheet 子先父）；失效即域重扫+
// 按源清旧 loss；坏 sheet/坏行 loss 不阻断其余 sheet；确定性 id 幂等。observe 定序 stat 先于
// read（M11-REVIEW P2-1）。sha12/statThenRead 消费 import-util 共享件（M11-UTIL/UTIL2 已回迁，
// 无私有副本）。同 id/同 (h,i) 病态面去重保首落账见 P2-2 两案（FIX-A）。
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { sha12, statThenRead, type ObservedFile } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级 bump→源失效强制重扫（与 DB user_version 正交）。 */
export const ACCEPTANCE_IMPORT_SCHEMA_VERSION = 1;

/** 迁移批 actor（history 条目 ua 缺失时的兜底，冻结件「迁移批 actor」口径）。 */
export const IMPORT_ACTOR = "import-migration";

const SHEET_ID_RE = /^[0-9a-f]{32}$/;
const VERDICTS = new Set(["pass", "fail"]);

export interface AcceptanceImportCounts {
  sheet: number;
  item: number;
  result: number;
}

export interface AcceptanceImportResult {
  /** true=checkpoint 命中，域零写入快进。 */
  skipped: boolean;
  counts: AcceptanceImportCounts;
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  /** 实际重扫的源（快进为空数组）。 */
  rescanned: string[];
}

// ---------- 源观测（stat 先于 read） ----------
interface SheetDoc {
  id: string;
  title: unknown;
  created_at: unknown;
  cwd: unknown;
  sheet_key: unknown;
  rows: unknown[];
  raw: string;
}

interface ResultsDoc {
  id: string;
  history: { at: unknown; ua: unknown; rows: Record<string, unknown>[] }[];
  raw: string;
}

interface ObservedDir {
  mtimeMs: number;
  fileCount: number;
  sheets: { file: string; doc: SheetDoc | null }[];
  results: { file: string; doc: ResultsDoc | null }[];
}

function observeAcceptanceDir(dir: string): ObservedDir {
  const out: ObservedDir = { mtimeMs: 0, fileCount: 0, sheets: [], results: [] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let obs: ObservedFile;
    try {
      obs = statThenRead(file); // stat 先于 read 定稿序（权威注释见 import-util.ts）；目录遍历容错 continue
    } catch {
      continue;
    }
    const raw = obs.text;
    if (obs.mtimeMs > out.mtimeMs) out.mtimeMs = obs.mtimeMs;
    out.fileCount++;
    if (name.endsWith(".results.json")) {
      const id = name.slice(0, -13); // ".results.json" 恰 13 字符
      let doc: ResultsDoc | null = null;
      try {
        const p = JSON.parse(raw) as Record<string, unknown>;
        const history = Array.isArray(p.history) ? (p.history as Record<string, unknown>[]) : null;
        if (history !== null) {
          doc = {
            id,
            raw,
            history: history.map((h) => ({
              at: h.at,
              ua: h.ua,
              rows: Array.isArray(h.rows) ? (h.rows as Record<string, unknown>[]) : [],
            })),
          };
        }
      } catch {
        doc = null;
      }
      out.results.push({ file, doc });
    } else {
      const id = name.slice(0, -5);
      let doc: SheetDoc | null = null;
      try {
        const p = JSON.parse(raw) as Record<string, unknown>;
        doc = {
          id: typeof p.id === "string" && p.id ? p.id : id,
          title: p.title,
          created_at: p.created_at,
          cwd: p.cwd,
          sheet_key: p.sheet_key,
          rows: Array.isArray(p.rows) ? (p.rows as unknown[]) : [],
          raw,
        };
      } catch {
        doc = null;
      }
      out.sheets.push({ file, doc });
    }
  }
  return out;
}

// ---------- 中间行模型 ----------
interface PendingLoss {
  sourcePath: string;
  lineNo: number;
  reason: string;
  excerpt: string;
}

interface SheetRow {
  id: string;
  groupId: string | null;
  title: string;
  createdAt: number;
  sheetKey: string | null;
}

interface ItemRow {
  id: string;
  sheetId: string;
  itemIndex: number;
  task: string;
  item: string;
  criteria: string;
}

interface ResultRow {
  id: string;
  itemId: string;
  verdict: string | null;
  note: string;
  actor: string;
  createdAt: number;
}

/**
 * 验收域导入：acceptances 目录快照同步进 sheet/item/result 三表。幂等（同源同版本重跑快进）；
 * 任一变化→域清重灌（acceptDir 是三表唯一生产者，域清=防 sheet/results 删文件残留）。port
 * 事务边界内聚本函数。
 */
export function importAcceptance(port: StoragePort, acceptanceDir: string, opts?: { schemaVersion?: number }): AcceptanceImportResult {
  const schemaVersion = opts?.schemaVersion ?? ACCEPTANCE_IMPORT_SCHEMA_VERSION;
  const obs = observeAcceptanceDir(acceptanceDir);
  const cp = readCheckpoint(port, acceptanceDir, { mtimeMs: obs.mtimeMs, lineCount: obs.fileCount, schemaVersion });
  if (cp !== null) {
    const n = (sql: string, ...params: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
    return {
      skipped: true,
      counts: {
        sheet: n("SELECT COUNT(*) AS n FROM acceptance_sheet"),
        item: n("SELECT COUNT(*) AS n FROM acceptance_item"),
        result: n("SELECT COUNT(*) AS n FROM acceptance_result"),
      },
      loss: n("SELECT COUNT(*) AS n FROM import_loss WHERE source_path = ?", acceptanceDir), // COUNT 下推（STAT-SHORTCUT，缘由同 import-org.ts skipped 分支）
      rescanned: [],
    };
  }

  // ---------- 解析（纯函数段） ----------
  const losses: PendingLoss[] = [];
  const sheets: SheetRow[] = [];
  const items: ItemRow[] = [];
  const results: ResultRow[] = [];
  const sheetById = new Map<string, { items: ItemRow[] }>();

  const groupByAnchor = new Map<string, string>();
  for (const r of port.query<{ id: string; anchor_dir: string }>(`SELECT id, anchor_dir FROM "group"`)) {
    groupByAnchor.set(r.anchor_dir, r.id);
  }

  // -- sheet 文件：id 校验（线上 ACCEPTANCE_ID_RE 对表）→归因→行模型
  const sheetIdSeen = new Map<string, string>(); // 内容 id → 首见文件（P2-2 案 A：同 id 双文件去重保首）
  for (const s of obs.sheets) {
    if (s.doc === null) {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "bad-json", excerpt: `sheet 文件解析失败：${s.file}`.slice(0, 200) });
      continue;
    }
    const d = s.doc;
    const excerpt = JSON.stringify({ id: d.id, title: d.title }).slice(0, 200);
    if (!SHEET_ID_RE.test(d.id)) {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "bad-field", excerpt: JSON.stringify({ id: d.id, why: "非 32hex（线上 ACCEPTANCE_ID_RE 同词表拒入）" }).slice(0, 200) });
      continue;
    }
    if (typeof d.title !== "string" || !d.title || typeof d.created_at !== "number") {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "missing-field", excerpt });
      continue;
    }
    // 内容 id 重复（doc.id 权威取内容 ：131，两文件可声明同 id）：裸 INSERT 撞 acceptance_sheet.id
    // UNIQUE 整域硬失败（M11-REVIEW2 P2-2 案 A 实测）——首文件赢（readdir 序确定性），后者连同
    // 其 items 整单拒入落账（先于归因判重：整单已拒，不再叠 missing-attribution 噪音账）
    const firstSeen = sheetIdSeen.get(d.id);
    if (firstSeen !== undefined) {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "duplicate-id", excerpt: JSON.stringify({ id: d.id, first: basename(firstSeen), dup: basename(s.file) }).slice(0, 200) });
      continue;
    }
    sheetIdSeen.set(d.id, s.file);
    // 归因：cwd→group.anchor_dir 精确匹配；缺失/匹配不上→NULL+missing-attribution（零造关联）
    const cwd = typeof d.cwd === "string" && d.cwd ? d.cwd : null;
    const groupId = cwd !== null ? groupByAnchor.get(cwd) ?? null : null;
    if (groupId === null) {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "missing-attribution", excerpt: JSON.stringify({ id: d.id, cwd }).slice(0, 200) });
    }
    const row: SheetRow = {
      id: d.id,
      groupId,
      title: d.title,
      createdAt: d.created_at,
      sheetKey: typeof d.sheet_key === "string" && d.sheet_key ? d.sheet_key : null,
    };
    // rows[] → item（数组序=item_index 1-based；三串必填，异常行拒入不阻断）
    const sheetItems: ItemRow[] = [];
    d.rows.forEach((raw, idx) => {
      const itemIndex = idx + 1;
      const r = raw as Record<string, unknown>;
      const iExcerpt = JSON.stringify({ id: d.id, item_index: itemIndex, task: r.task }).slice(0, 200);
      if (typeof r.task !== "string" || !r.task || typeof r.item !== "string" || typeof r.criteria !== "string") {
        losses.push({ sourcePath: acceptanceDir, lineNo: itemIndex, reason: "missing-field", excerpt: iExcerpt });
        return;
      }
      const item: ItemRow = {
        id: `itm-${sha12(`${d.id}/${itemIndex}`)}`,
        sheetId: d.id,
        itemIndex,
        task: r.task,
        item: r.item,
        criteria: r.criteria,
      };
      sheetItems.push(item);
    });
    sheets.push(row);
    items.push(...sheetItems);
    sheetById.set(d.id, { items: sheetItems });
  }

  // -- results 文件：按 id 配对 sheet；history 逐条×逐 row 展开（不折叠）
  for (const r of obs.results) {
    if (r.doc === null) {
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "bad-json", excerpt: `results 文件解析失败：${r.file}`.slice(0, 200) });
      continue;
    }
    const d = r.doc;
    const sheetEntry = sheetById.get(d.id);
    if (sheetEntry === undefined) {
      // 孤儿 results（sheet 未登记/被拒入）：无处挂靠，整文件落账跳过——不造 sheet
      losses.push({ sourcePath: acceptanceDir, lineNo: 1, reason: "dangling-ref", excerpt: JSON.stringify({ results_id: d.id, why: "无对应 sheet" }).slice(0, 200) });
      continue;
    }
    const itemByIndex = new Map(sheetEntry.items.map((it) => [it.itemIndex, it]));
    const seenResults = new Set<string>(); // (h序,item_index) 去重保首（P2-2 案 B）——跨 history 条目不折叠（事实流语义）
    d.history.forEach((h, hIdx) => {
      const hExcerpt = JSON.stringify({ results_id: d.id, h: hIdx }).slice(0, 200);
      if (typeof h.at !== "number") {
        losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "missing-field", excerpt: hExcerpt });
        return;
      }
      const actor = typeof h.ua === "string" && h.ua ? h.ua : IMPORT_ACTOR;
      for (const row of h.rows) {
        if (typeof row.i !== "number" || !Number.isInteger(row.i) || row.i < 0) {
          losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "bad-field", excerpt: JSON.stringify({ results_id: d.id, row }).slice(0, 200) });
          continue;
        }
        const itemIndex = row.i + 1;
        const item = itemByIndex.get(itemIndex);
        if (item === undefined) {
          // 越界/该行已被拒入：悬空引用拒行，不造 item
          losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "dangling-ref", excerpt: JSON.stringify({ results_id: d.id, item_index: itemIndex }).slice(0, 200) });
          continue;
        }
        let verdict: string | null = null;
        if (typeof row.verdict === "string") {
          if (!VERDICTS.has(row.verdict)) {
            losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "bad-field", excerpt: JSON.stringify({ results_id: d.id, verdict: row.verdict }).slice(0, 200) });
            continue;
          }
          verdict = row.verdict;
        } else if (row.verdict !== null && row.verdict !== undefined) {
          losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "bad-field", excerpt: JSON.stringify({ results_id: d.id, verdict: row.verdict }).slice(0, 200) });
          continue;
        }
        // 同 history 同 i 二见（同批次对同 item 双判定的病态源）：res- 确定性 id 同键→裸 INSERT
        // 撞 acceptance_result.id UNIQUE 整域硬失败（M11-REVIEW2 P2-2 案 B 实测）——保首落行，
        // 后者 duplicate-key 落账。跨 history 条目（h 序不同）id 天然不同，不折叠
        const resultKey = `${hIdx}/${itemIndex}`;
        if (seenResults.has(resultKey)) {
          losses.push({ sourcePath: acceptanceDir, lineNo: hIdx + 1, reason: "duplicate-key", excerpt: JSON.stringify({ results_id: d.id, h: hIdx, item_index: itemIndex, why: "同批次重复判定保首" }).slice(0, 200) });
          continue;
        }
        seenResults.add(resultKey);
        results.push({
          id: `res-${sha12(`${d.id}/h${hIdx}/i${itemIndex}`)}`,
          itemId: item.id,
          verdict,
          note: typeof row.note === "string" ? row.note : "",
          actor,
          createdAt: h.at,
        });
      }
    });
  }

  // ---------- 落库（单事务：域清→重灌→loss→checkpoint） ----------
  port.begin();
  try {
    port.exec("DELETE FROM acceptance_result");
    port.exec("DELETE FROM acceptance_item");
    port.exec("DELETE FROM acceptance_sheet");
    port.exec("DELETE FROM import_loss WHERE source_path = ?", [acceptanceDir]);
    for (const s of sheets) {
      port.exec(
        "INSERT INTO acceptance_sheet (id, task_id, group_id, title, created_at, sheet_key) VALUES (?, NULL, ?, ?, ?, ?)",
        [s.id, s.groupId, s.title, s.createdAt, s.sheetKey],
      );
    }
    for (const it of items) {
      port.exec(
        "INSERT INTO acceptance_item (id, sheet_id, item_index, task, item, criteria) VALUES (?, ?, ?, ?, ?, ?)",
        [it.id, it.sheetId, it.itemIndex, it.task, it.item, it.criteria],
      );
    }
    for (const r of results) {
      port.exec(
        "INSERT INTO acceptance_result (id, item_id, verdict, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [r.id, r.itemId, r.verdict, r.note, r.actor, r.createdAt],
      );
    }
    for (const l of losses) appendLoss(port, l);
    writeCheckpoint(port, { path: acceptanceDir, mtimeMs: obs.mtimeMs, lineCount: obs.fileCount, offset: obs.fileCount, schemaVersion });
    port.commit();
  } catch (err) {
    port.rollback();
    throw new Error(`import-acceptance: 验收域导入失败已回滚（保留旧快照）——${err instanceof Error ? err.message : String(err)}`);
  }

  const n2 = (sql: string): number => port.query<{ n: number }>(sql)[0]?.n ?? -1;
  return {
    skipped: false,
    counts: {
      sheet: n2("SELECT COUNT(*) AS n FROM acceptance_sheet"),
      item: n2("SELECT COUNT(*) AS n FROM acceptance_item"),
      result: n2("SELECT COUNT(*) AS n FROM acceptance_result"),
    },
    loss: losses.length,
    rescanned: obs.fileCount > 0 ? [acceptanceDir] : [],
  };
}
