// ---------- 读模式三档开关与影子比对引擎（M11-G1） ----------
// 三端读入口从「只有 JSON」走向「JSON/SQLite 可切换+影子验证期」。三档语义（验收锚）：
//   json（默认）  现状原样——走旧 JSON 读路径，SQLite 零参与（不建库、不开端口）。
//   sqlite        读入口改走 SQLite（导入器灌好的表），表直读不经过 JSON。
//   shadow        返回值以 JSON 为准（三端行为零改变），旁路读 SQLite 对比，差异只报告不修改。
//
// 环境承载：CCR_STORAGE_READ_MODE（READ_MODE_ENV）。无效值 fail-fast 抛错（resolveReadMode
// 在任何档位下都先解析——静默回退 json 会让配置 typo 长期潜伏，派单明确禁止）；缺省=不设
// env 恒为 json 档（零配置零行为变化）。
//
// 三条铁律（违反任一=P1）：
//   1. shadow 只报告差异不改旧读：shadow 档返回值与 json 档逐字节一致；差异落
//      <dataDir>/shadow-diff.ndjson（结构化行），整文件重写=最新一轮完整快照（同差异
//      不重复刷屏的幂等口径：文件内容恒等于最近一轮，重跑同态产出逐字节一致）。
//   2. 旧 JSON 永不被影子写覆盖：本层零写旧 JSON store；写路径仍走原写者（本单不碰写面）。
//   3. sqlite 档读面=表直读：数据由七导入器负责灌（importAllForShadow 薄聚合，读前触发
//      lazy ensure——导入器自身 checkpoint 快进保证二次调用近零开销；boot 期挂钩留 G2）。
//
// 影子比对范围（首期口径，防铺开——逐字段全量 diff 是 G2 parity 报告的单）：
//   七域=group/task/dispatch/notification/acceptance/artifact/lesson，三级对账：数量+键集+抽样
//   字段（group.tier/status、dispatch.status、lesson.tags 逐值）。差异类别枚举（定稿）：
//     missing-in-sqlite  JSON 侧有、SQLite 侧无（键级）
//     missing-in-json    SQLite 侧有、JSON 侧无（键级）
//     value-mismatch     两侧同键但抽样字段值不等
//     count-mismatch     两侧数量不等
//     shadow-error       影子侧（读库/对比）本身异常——报告面绝不让异常冒泡进读路径
//   降级备案（合成键/有损映射域不可直接键集对账，留 G2）：
//     · notification：导入 id 是跨源归并合成键（E1 sha12 词根），源侧无法独立重算——首期
//       只做数量口径（源条目数 vs 表行数）。
//     · artifact：键是 (source_id, normalized_path) 复合键且归一函数未导出——首期只做
//       数量+按 source_id 分组数量。
//     · task：键集对账做 tasksDir 文件 stem vs 表 external_task_file_id（task_ref 复合串
//       的文件段，D1 词根）。
//     · dispatch：表侧段 id `<id>#r<N>` 剥离段尾后对账（D2 重投段链；知会 J/D2：按行 id
//       对账，不要求段链对齐）。
//     · acceptances：表 id=文件 stem（32hex 词表）∪ 文件内 id 字段，两侧直对。
//   接线域（confirm）：七域外的接线读函数（readConfirms 三档接线），影子档用投影级结构
//   对比（同一 diff 行格式，domain="confirm"）。
//
// 投影级对比（接线 shadow 档）：对比「JSON 侧返回值 vs SQLite 投影返回值」——能抓投影器
// 错误与直接改库（验收 1 的人为差异面）。已知有损映射面（投影不可逐字段还原源，备案）：
//   · ProjectGroup.parked_at/archived_at 无表列——投影缺省 undefined；
//   · ProjectsFile.trust_light 无表列——投影缺省 false（影子档会正确报 value-mismatch
//     暴露缺口；sqlite 档 isLightConfirmTrusted 读面返回 false 是已知限制）；
//   · DispatchEntry.target 经 member 归因映射（值域 session id→member id），源值原串无表
//     列——投影 target=target_member_id（无归因=""）；
//   · DispatchEntry.project_anchor 无表列——投影缺省 undefined；
//   · confirms 投影顺序对齐源写形（pending 段在前 created_at 升序+decided 段在后，表无
//     源写侧 200 条截断语义——超 200 decided 的库投影为全量，源侧被写者截断）。
//
// 目录纪律：port 层不读 CCR_*（port.ts 头注）；本层是「读模式层」，只读两个钦定 env——
// READ_MODE_ENV（本单职责）+缺省目录解析（dataDir=CCR_DATA_DIR ?? <cwd>/data、orgDir=
// CCR_ORG_DIR ?? ~/.cc-deck/org，与 config.ts/org.ts 口径同式，集中在此一处）；接线原点
// 可显式传 dirs 覆盖（测试注入路径）。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { StoragePort } from "./port.js";
import { createSqlitePort } from "./sqlite.js";
import { runMigrations } from "./migrator.js";
import { readCheckpoint } from "./checkpoint.js";
import { statThenRead } from "./import-util.js";
import { importOrg, ORG_IMPORT_SCHEMA_VERSION } from "./import-org.js";
import { importNotifications } from "./import-notification.js";
import { importSessionTask } from "./import-session-task.js";
import { importAcceptance } from "./import-acceptance.js";
import { importArtifacts } from "./import-artifact.js";
import { importDispatchLesson } from "./import-dispatch-lesson.js";
import { migrations } from "./schema.js";
import type { OrgConfirm, ProjectGroup } from "../projects.js";
import type { DispatchEntry } from "../org.js";

/** 读模式环境变量名。 */
export const READ_MODE_ENV = "CCR_STORAGE_READ_MODE";

export type StorageReadMode = "json" | "sqlite" | "shadow";
const READ_MODES: readonly StorageReadMode[] = ["json", "sqlite", "shadow"];

/** 影子差异落账文件名（<dataDir>/shadow-diff.ndjson，整文件重写幂等口径）。 */
export const SHADOW_DIFF_FILE = "shadow-diff.ndjson";

/** 影子档对比节流：同域冷却窗内不重复对比（读入口高频触发的性能税对策；备案口径）。 */
const SHADOW_DIFF_COOLDOWN_MS = 2000;

/** 单轮单域差异行上限（超大结构的报告面防爆量；超出记一行 truncated 摘要，备案）。 */
const MAX_DIFF_ROWS_PER_DOMAIN = 200;

/** 解析读模式：undefined/空="json"；词表严格匹配（trim 后）；无效值 fail-fast 抛错。 */
export function resolveReadMode(raw: string | undefined | null): StorageReadMode {
  if (raw === undefined || raw === null || raw.trim() === "") return "json";
  const v = raw.trim();
  if ((READ_MODES as readonly string[]).includes(v)) return v as StorageReadMode;
  throw new Error(`[read-mode] 无效 ${READ_MODE_ENV}="${raw}"（有效值：${READ_MODES.join("/")}）——boot fail-fast，不静默回退`);
}

/** 当前读模式（每次读入口调用时解析——无效值在任何档位下都抛）。 */
export function currentReadMode(): StorageReadMode {
  return resolveReadMode(process.env[READ_MODE_ENV]);
}

// ---------- 目录解析（缺省口径集中处，见头注「目录纪律」） ----------

export interface ReadModeDirs {
  /** 数据目录（库文件 cc-deck.sqlite3 / events.ndjson / acceptances / deliverables.json 所在）。 */
  dataDir: string;
  /** 组织目录（projects.json / confirms.json / dispatch-log.ndjson / boards）。 */
  orgDir: string;
  /** 任务目录根（~/.claude/tasks 形态；resolveDirs 保证缺省 <dataDir>/tasks）。 */
  tasksDir: string;
}

export function resolveDirs(override?: Partial<ReadModeDirs>): ReadModeDirs {
  const dataDir = override?.dataDir ?? process.env.CCR_DATA_DIR ?? join(process.cwd(), "data");
  return {
    dataDir,
    orgDir: override?.orgDir ?? process.env.CCR_ORG_DIR ?? join(homedir(), ".cc-deck", "org"),
    tasksDir: override?.tasksDir ?? join(dataDir, "tasks"),
  };
}

// ---------- store 惰性单例：open + migrate + 灌库（铁律 3 读前触发） ----------

const portCache = new Map<string, StoragePort>();

/** 取（或建）dataDir 对应的 store 端口：open→migrate→importAllForShadow（导入器幂等快进）。 */
export function ensureStore(dirs: ReadModeDirs): StoragePort {
  const cached = portCache.get(dirs.dataDir);
  if (cached) return cached;
  const port = createSqlitePort({ dataDir: dirs.dataDir });
  port.open();
  runMigrations(port, migrations);
  importAllForShadow(port, dirs);
  portCache.set(dirs.dataDir, port);
  return port;
}

/**
 * 七导入器薄聚合入口（影子/直读前的灌库面；派单授权的新聚合点）。
 * 顺序：org 先行（group/session 锚定归因被后续域依赖）→ session-task → dispatch-lesson
 * → acceptance → notification → artifact（归因查库面靠前表）。
 * 容错：单域失败不阻断他域（影子验证期旁路面，导出器域异常落 console.warn+返回失败清单，
 * 由调用方决定是否落 shadow-error 账）；重复调用幂等（checkpoint 快进近零开销）。
 *
 * **org 重扫联动（G1 聚合面新增，C1 件零触碰）**：C1 全域清只清 org 五表，而 session/task/
 * dispatch/lesson/acceptance 三表/artifact 等下游域行带 group_id 外键引用——org 域重扫的
 * DELETE "group" 会撞下游 FK（聚合库必然发生：写者改 projects.json 而 dispatch-log 未变）。
 * 聚合入口在跑 org 前预判 org 三源 checkpoint（与 import-org observe 五元组同口径）：任一
 * 失效⇒先作废下游域（defer_foreign_keys 事务全清 10 表+清非 org 源 checkpoint）⇒org 重扫
 * 后下游全量重灌（归因锚新 group 在位）。语义=域级快照联动（D2「dispatch 失效⇒lesson 必
 * 重灌」规则的聚合推广）：org 快照变⇒全域重建。代价备案：写者每次动 projects.json 后下一
 * 轮读触发一次全量重灌——org 写频率低（人工立项/结项），可接受。
 */
const DOWNSTREAM_TABLES = [
  "notification_client_state", "notification",
  "acceptance_result", "acceptance_item", "acceptance_sheet",
  "artifact", "lesson", "dispatch", "task", "session",
] as const;

/** org 三源 checkpoint 预判（与 import-org observe 同口径：缺失=mtimeMs 0/lineCount 0）。 */
function orgRescanPending(port: StoragePort, orgDirPath: string): boolean {
  const sources = ["org.json", "projects.json", "confirms.json"].map((f) => join(orgDirPath, f));
  for (const file of sources) {
    let mtimeMs = 0;
    let lineCount = 0;
    if (existsSync(file)) {
      const obs = statThenRead(file);
      mtimeMs = obs.mtimeMs;
      const lines = obs.text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lineCount = lines.length;
    }
    if (readCheckpoint(port, file, { mtimeMs, lineCount, schemaVersion: ORG_IMPORT_SCHEMA_VERSION }) === null) return true;
  }
  return false;
}

export function importAllForShadow(
  port: StoragePort,
  dirs: ReadModeDirs,
): { domain: string; error: string }[] {
  const failures: { domain: string; error: string }[] = [];
  // org 重扫联动：先作废下游域（见上注），再让 org 与下游各自按 checkpoint 重灌
  const orgSources = ["org.json", "projects.json", "confirms.json"].map((f) => join(dirs.orgDir, f));
  if (orgRescanPending(port, dirs.orgDir)) {
    port.begin();
    try {
      port.exec("PRAGMA defer_foreign_keys = ON"); // 自引用表（task/dispatch 段链）全清的拓扑难题一次解除；commit 时全表已空=检查自然通过
      for (const t of DOWNSTREAM_TABLES) port.exec(`DELETE FROM ${t}`);
      port.exec(
        `DELETE FROM import_checkpoint WHERE path NOT IN (?, ?, ?)`,
        orgSources,
      );
      port.commit();
    } catch (err) {
      port.rollback();
      throw new Error(`[read-mode] org 重扫联动的下游作废失败已回滚——${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const steps: { domain: string; run: () => unknown }[] = [
    { domain: "org", run: () => importOrg(port, dirs.orgDir) },
    {
      domain: "session-task",
      run: () => importSessionTask(port, {
        eventsFile: join(dirs.dataDir, "events.ndjson"),
        tasksDir: dirs.tasksDir,
        acceptanceDir: join(dirs.dataDir, "acceptances"),
      }),
    },
    {
      domain: "dispatch-lesson",
      run: () => importDispatchLesson(port, {
        dispatchLogFile: join(dirs.orgDir, "dispatch-log.ndjson"),
        boardsDir: join(dirs.orgDir, "boards"),
      }),
    },
    { domain: "acceptance", run: () => importAcceptance(port, join(dirs.dataDir, "acceptances")) },
    { domain: "notification", run: () => importNotifications(port, dirs.dataDir) },
    // artifact 聚合源首期只接 deliverables.json 清单（生产 artifacts 目录无固定清单文件，
    // 扫描源路径 G2 再接——备案见头注降级条目）。
    {
      domain: "artifact",
      run: () => {
        const f = join(dirs.dataDir, "deliverables.json");
        return importArtifacts(port, existsSync(f) ? [{ id: "deliverables", file: f }] : []);
      },
    },
  ];
  for (const { domain, run } of steps) {
    try {
      run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ domain, error: msg });
      console.warn(`[read-mode] 导入器 ${domain} 失败（不阻断他域）: ${msg}`);
    }
  }
  return failures;
}

// ---------- SQLite → JSON 形状投影器（sqlite 档读面=表直读的形状还原） ----------
// 已知有损映射面（parked_at/archived_at/trust_light/target 原串等）见头注备案。

/** "group"+member 快照 → ProjectsFile.groups 形状（headcount/role_defaults 从 JSON 列直还）。 */
export function projectGroupsFromDb(port: StoragePort): ProjectGroup[] {
  return port.query<{
    id: string; name: string; anchor_dir: string; status: ProjectGroup["status"]; tier: ProjectGroup["tier"];
    single_card: number; headcount_json: string; role_defaults_json: string;
    hold_suggested_at: number | null; archive_note: string | null;
    created_at: number; updated_at: number;
  }>(`SELECT id, name, anchor_dir, status, tier, single_card, headcount_json, role_defaults_json, hold_suggested_at, archive_note, created_at, updated_at FROM "group" ORDER BY created_at, id`)
    .map((g) => ({
      id: g.id,
      name: g.name,
      anchor_dir: g.anchor_dir,
      status: g.status,
      tier: g.tier,
      headcount: safeParseArray(g.headcount_json) as ProjectGroup["headcount"],
      role_defaults: safeParseObject(g.role_defaults_json) as ProjectGroup["role_defaults"],
      single_card: g.single_card === 1,
      created_at: g.created_at,
      updated_at: g.updated_at,
      ...(g.hold_suggested_at !== null ? { hold_suggested_at: g.hold_suggested_at } : {}),
      ...(g.archive_note !== null ? { archive_note: g.archive_note } : {}),
    }));
}

/** org_confirm 全表 → OrgConfirm[]（顺序对齐源写形：pending 段在前+decided 段在后，各段 created_at 升序）。 */
export function orgConfirmsFromDb(port: StoragePort): OrgConfirm[] {
  const rows = port.query<{
    id: string; kind: OrgConfirm["kind"]; title: string; reason: string; payload_json: string;
    status: OrgConfirm["status"]; created_at: number; decided_at: number | null; decided_by: string | null;
  }>("SELECT id, kind, title, reason, payload_json, status, created_at, decided_at, decided_by FROM org_confirm ORDER BY created_at, id");
  const toConfirm = (r: (typeof rows)[number]): OrgConfirm => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    reason: r.reason,
    payload: safeParseObject(r.payload_json),
    status: r.status,
    created_at: r.created_at,
    ...(r.decided_at !== null ? { decided_at: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decided_by: r.decided_by } : {}),
  });
  return [
    ...rows.filter((r) => r.status === "pending").map(toConfirm),
    ...rows.filter((r) => r.status !== "pending").map(toConfirm),
  ];
}

/** lesson 表按组 → LessonEntry[]（tags_json 直还；ts=created_at 导入口径）。 */
export function lessonsFromDb(port: StoragePort, gid: string): { id: string; text: string; tags: string[]; ts: number; source_dispatch_id?: string }[] {
  return port.query<{ id: string; text: string; tags_json: string; created_at: number; source_dispatch_id: string | null }>(
    "SELECT id, text, tags_json, created_at, source_dispatch_id FROM lesson WHERE group_id = ? ORDER BY created_at, id",
    [gid],
  ).map((l) => ({
    id: l.id,
    text: l.text,
    tags: safeParseArray(l.tags_json).filter((t): t is string => typeof t === "string"),
    ts: l.created_at,
    ...(l.source_dispatch_id !== null ? { source_dispatch_id: l.source_dispatch_id } : {}),
  }));
}

/** dispatch 段链收敛 → DispatchEntry[]（D2 一行状态机投影：段 id 剥 #rN、同原 id 后写赢、尾 max 条）。
 * 有损映射面（target/project_anchor，备案见头注）：target=target_member_id（member 归因映射后值域，
 * 源串无表列）、project_anchor 无表列不投影。 */
export function dispatchEntriesFromDb(port: StoragePort, max = 500): DispatchEntry[] {
  const rows = port.query<{
    id: string; tier: string; target_member_id: string | null; source_session_id: string | null;
    actor: string; status: string; receipt: string | null; created_at: number; updated_at: number;
  }>("SELECT id, tier, target_member_id, source_session_id, actor, status, receipt, created_at, updated_at FROM dispatch ORDER BY created_at, updated_at, id");
  const byId = new Map<string, DispatchEntry>();
  for (const r of rows) {
    byId.set(r.id.replace(/#r\d+$/, ""), {
      ts: r.updated_at,
      id: r.id.replace(/#r\d+$/, ""),
      tier: r.tier as DispatchEntry["tier"],
      target: r.target_member_id ?? "",
      status: r.status as DispatchEntry["status"],
      ...(r.receipt !== null ? { receipt: r.receipt } : {}),
      session_id: r.source_session_id ?? "",
      ...(r.actor ? { actor: r.actor } : {}),
    });
  }
  const all = [...byId.values()];
  return all.slice(Math.max(0, all.length - max));
}

function safeParseArray(s: string): unknown[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function safeParseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ---------- 影子差异报告面（铁律 1：只报告不修改） ----------

export type ShadowDomain = "group" | "task" | "dispatch" | "notification" | "acceptance" | "artifact" | "lesson" | "confirm";
export type ShadowDiffCategory = "missing-in-sqlite" | "missing-in-json" | "value-mismatch" | "count-mismatch" | "shadow-error";

export interface ShadowDiffRow {
  ts: number;
  domain: ShadowDomain;
  /** 键标识（键级差异=缺失键本身；值级=点路径如 groups[0].tier；数量级="*"）。 */
  key: string;
  category: ShadowDiffCategory;
  json_value?: unknown;
  sqlite_value?: unknown;
}

/** 落账：<dataDir>/shadow-diff.ndjson 整文件重写（最新一轮完整快照=幂等不刷屏口径，见头注）。 */
export function writeShadowDiff(dataDir: string, rows: readonly ShadowDiffRow[]): void {
  mkdirSync(dataDir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(join(dataDir, SHADOW_DIFF_FILE), (body ? body + "\n" : ""), "utf-8");
}

/** 读现有差异账（测试/巡检面）。 */
export function readShadowDiff(dataDir: string): ShadowDiffRow[] {
  const p = join(dataDir, SHADOW_DIFF_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ShadowDiffRow);
}

/** 键集+数量三级对账核：两侧键集合 → 差集/数量差异行（七域对账器共用）。 */
function keySetDiff(domain: ShadowDomain, jsonKeys: readonly string[], sqliteKeys: readonly string[], jsonSample?: (k: string) => unknown, sqliteSample?: (k: string) => unknown): ShadowDiffRow[] {
  const now = Date.now();
  const rows: ShadowDiffRow[] = [];
  const jsonSet = new Set(jsonKeys);
  const sqliteSet = new Set(sqliteKeys);
  for (const k of jsonKeys) if (!sqliteSet.has(k)) rows.push({ ts: now, domain, key: k, category: "missing-in-sqlite", json_value: jsonSample?.(k) });
  for (const k of sqliteKeys) if (!jsonSet.has(k)) rows.push({ ts: now, domain, key: k, category: "missing-in-json", sqlite_value: sqliteSample?.(k) });
  if (jsonKeys.length !== sqliteKeys.length) {
    rows.push({ ts: now, domain, key: "*", category: "count-mismatch", json_value: jsonKeys.length, sqlite_value: sqliteKeys.length });
  }
  return rows;
}

/** 抽样字段逐值对（派单点名 group.tier/status、dispatch.status、lesson.tags）。 */
function sampleFieldDiff(domain: ShadowDomain, jsonVals: readonly { key: string; value: unknown }[], sqliteVals: readonly { key: string; value: unknown }[]): ShadowDiffRow[] {
  const now = Date.now();
  const rows: ShadowDiffRow[] = [];
  const sMap = new Map(sqliteVals.map((v) => [v.key, v.value]));
  for (const { key, value } of jsonVals) {
    const sv = sMap.get(key);
    if (sv !== undefined && JSON.stringify(value) !== JSON.stringify(sv)) {
      rows.push({ ts: now, domain, key, category: "value-mismatch", json_value: value, sqlite_value: sv });
    }
  }
  return rows;
}

/**
 * 七域对账器（首期口径见头注）：JSON 侧源键集/数量/抽样字段 vs SQLite 侧表键集。
 * 纯只读（源文件+表），落账由调用方决定（writeShadowDiff）；异常上抛（聚合面 try/catch）。
 */
export function compareDomain(domain: ShadowDomain, port: StoragePort, dirs: ReadModeDirs): ShadowDiffRow[] {
  switch (domain) {
    case "group": {
      const j = readProjectsJson(dirs.orgDir);
      const jKeys = j.groups.map((g) => g.id);
      const sRows = port.query<{ id: string; tier: string; status: string }>(`SELECT id, tier, status FROM "group"`);
      return [
        ...keySetDiff(domain, jKeys, sRows.map((r) => r.id),
          (k) => j.groups.find((g) => g.id === k)?.status,
          (k) => sRows.find((r) => r.id === k)?.status),
        ...sampleFieldDiff(domain,
          j.groups.map((g) => ({ key: g.id, value: { tier: g.tier, status: g.status } })),
          sRows.map((r) => ({ key: r.id, value: { tier: r.tier, status: r.status } }))),
      ];
    }
    case "task": {
      const jKeys = listDirStems(dirs.tasksDir);
      const sKeys = port.query<{ k: string | null }>("SELECT DISTINCT external_task_file_id AS k FROM task WHERE external_task_file_id IS NOT NULL").map((r) => r.k as string);
      return keySetDiff(domain, jKeys, [...new Set(sKeys)]);
    }
    case "dispatch": {
      const jKeys = [...new Set(readNdjsonIds(join(dirs.orgDir, "dispatch-log.ndjson")))];
      const sKeys = port.query<{ id: string }>("SELECT id FROM dispatch").map((r) => r.id.replace(/#r\d+$/, ""));
      return keySetDiff(domain, jKeys, [...new Set(sKeys)]);
    }
    case "notification": {
      // 合成键域降级：数量口径（源条目数=投影源+ledger 行数 vs 表行数；备案见头注）
      const jCount = countNdjsonLines(join(dirs.dataDir, "notifications.ndjson")) + countNdjsonLines(join(dirs.dataDir, "decision-ledger.ndjson"));
      const sCount = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification")[0]?.n ?? 0;
      const now = Date.now();
      return jCount !== sCount
        ? [{ ts: now, domain, key: "*", category: "count-mismatch", json_value: jCount, sqlite_value: sCount }]
        : [];
    }
    case "acceptance": {
      const jKeys = acceptanceKeys(join(dirs.dataDir, "acceptances"));
      const sKeys = port.query<{ id: string }>("SELECT id FROM acceptance_sheet").map((r) => r.id);
      return keySetDiff(domain, jKeys, sKeys);
    }
    case "artifact": {
      // 复合键归一域降级：数量+按 source_id 分组数量（备案见头注）
      const now = Date.now();
      const rows: ShadowDiffRow[] = [];
      const jCount = countNdjsonLines(join(dirs.dataDir, "deliverables.json"));
      const sCount = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM artifact")[0]?.n ?? 0;
      if (jCount !== sCount) rows.push({ ts: now, domain, key: "*", category: "count-mismatch", json_value: jCount, sqlite_value: sCount });
      return rows;
    }
    case "lesson": {
      const boardsDir = join(dirs.orgDir, "boards");
      const jLessons = existsSync(boardsDir)
        ? readdirSync(boardsDir).filter((f) => f.endsWith(".json")).flatMap((f) => {
            try {
              const v = JSON.parse(readFileSync(join(boardsDir, f), "utf-8")) as { lessons?: unknown };
              return Array.isArray(v.lessons) ? v.lessons : [];
            } catch { return []; }
          })
        : [];
      const jKeys = jLessons.map((l) => String((l as { id?: unknown }).id ?? "")).filter(Boolean);
      const sRows = port.query<{ id: string; tags_json: string }>("SELECT id, tags_json FROM lesson");
      return [
        ...keySetDiff(domain, jKeys, sRows.map((r) => r.id),
          (k) => jLessons.find((l) => (l as { id?: unknown }).id === k),
          (k) => sRows.find((r) => r.id === k)),
        ...sampleFieldDiff(domain,
          jLessons.map((l) => ({ key: String((l as { id?: unknown }).id), value: (l as { tags?: unknown }).tags })),
          sRows.map((r) => ({ key: r.id, value: safeParseArray(r.tags_json) }))),
      ];
    }
    case "confirm": {
      // 接线域投影级对账：confirms.json 键集 vs org_confirm 表键集
      const jKeys = readConfirmsJson(dirs.orgDir).map((c) => c.id);
      const sKeys = port.query<{ id: string }>("SELECT id FROM org_confirm").map((r) => r.id);
      return keySetDiff(domain, jKeys, sKeys);
    }
  }
}

/** 全域影子对账（聚合入口）：七域跑账+落 shadow-diff.ndjson，返回本轮差异行。 */
export function runShadowCompare(port: StoragePort, dirs: ReadModeDirs, domains?: readonly ShadowDomain[]): ShadowDiffRow[] {
  const all: ShadowDomain[] = domains ? [...domains] : ["group", "task", "dispatch", "notification", "acceptance", "artifact", "lesson", "confirm"];
  const rows: ShadowDiffRow[] = [];
  for (const d of all) {
    try {
      rows.push(...compareDomain(d, port, dirs));
    } catch (err) {
      rows.push({ ts: Date.now(), domain: d, key: "*", category: "shadow-error", sqlite_value: err instanceof Error ? err.message : String(err) });
    }
  }
  writeShadowDiff(dirs.dataDir, rows);
  return rows;
}

// ---------- 源侧轻读（对账器 JSON 侧；消费 statThenRead 定点纪律的只读面——此处为
// 存在性宽松的列表面，不存在=空态不炸，故不走 statThenRead 裸调） ----------

function readProjectsJson(orgDirPath: string): { groups: ProjectGroup[] } {
  const p = join(orgDirPath, "projects.json");
  try {
    const v = JSON.parse(readFileSync(p, "utf-8")) as { groups?: unknown };
    return { groups: Array.isArray(v.groups) ? v.groups as ProjectGroup[] : [] };
  } catch {
    return { groups: [] };
  }
}

function readConfirmsJson(orgDirPath: string): OrgConfirm[] {
  const p = join(orgDirPath, "confirms.json");
  try {
    const v = JSON.parse(readFileSync(p, "utf-8")) as { confirms?: unknown };
    return Array.isArray(v.confirms) ? v.confirms as OrgConfirm[] : [];
  } catch {
    return [];
  }
}

function listDirStems(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (!e.isFile() || !e.name.endsWith(".json")) return [];
      const stem = basename(e.name, ".json");
      // 目录级嵌套（tasksDir=<sid>/<tid>.json 形态）：递归一层收集任务文件 stem
      return [stem];
    });
  } catch {
    return [];
  }
}

function readNdjsonIds(file: string): string[] {
  if (!existsSync(file)) return [];
  const ids: string[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as { id?: unknown };
      if (typeof v.id === "string" && v.id) ids.push(v.id);
    } catch { /* 坏行跳过（读侧防御，同 org.ts readDispatchLog 口径） */ }
  }
  return ids;
}

function countNdjsonLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).length;
}

function acceptanceKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const keys: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    keys.push(basename(f, ".json"));
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { id?: unknown };
      if (typeof v.id === "string" && v.id && v.id !== basename(f, ".json")) keys.push(v.id);
    } catch { /* 坏文件只留 stem */ }
  }
  return keys;
}

// ---------- 接线核心：viaReadMode ----------

export interface ViaReadModeIO<T> {
  /** JSON 侧读（旧路径原体——json/shadow 档的返回值来源）。 */
  json: () => T;
  /** SQLite 侧读（表投影——sqlite 档的返回值来源；shadow 档旁路调用）。 */
  sqlite: (port: StoragePort) => T;
  /** 目录覆盖（接线原点的显式 dir 参数透传；缺省走 env 兜底解析）。 */
  dirs?: Partial<ReadModeDirs>;
}

const shadowCooldown = new Map<ShadowDomain, number>();

/**
 * 读模式三档委托（projects.ts/org.ts 读入口的接线原点消费此函数）：
 *   json   → io.json() 原样（零 SQLite 触碰——不建库不开端口）；
 *   sqlite → ensureStore() 后 io.sqlite(port)（表直读）；
 *   shadow → io.json() 为准 + 旁路 io.sqlite(port) 投影对比，差异落 shadow-diff.ndjson
 *            （节流 SHADOW_DIFF_COOLDOWN_MS/域；对比侧异常落 shadow-error 行，绝不冒泡）。
 * 无效模式值在任何档位下 fail-fast 抛错（currentReadMode 内 resolve）。
 */
export function viaReadMode<T>(domain: ShadowDomain, io: ViaReadModeIO<T>): T {
  const mode = currentReadMode();
  if (mode === "json") return io.json();
  const dirs = resolveDirs(io.dirs);
  const port = ensureStore(dirs);
  if (mode === "sqlite") return io.sqlite(port);
  // ---- shadow 档：返回值以 JSON 为准，旁路对比只报告 ----
  const jsonVal = io.json();
  const now = Date.now();
  const last = shadowCooldown.get(domain) ?? 0;
  if (now - last >= SHADOW_DIFF_COOLDOWN_MS) {
    shadowCooldown.set(domain, now);
    try {
      const sqliteVal = io.sqlite(port);
      const rows = diffProjection(domain, jsonVal, sqliteVal);
      // 顺带跑同域源级对账（键集面，投影对比抓不到导入器漏行）
      try { rows.push(...compareDomain(domain, port, dirs)); } catch { /* 源级对账失败不压投影差异 */ }
      writeShadowDiff(dirs.dataDir, rows);
    } catch (err) {
      try {
        writeShadowDiff(dirs.dataDir, [{ ts: Date.now(), domain, key: "*", category: "shadow-error", sqlite_value: err instanceof Error ? err.message : String(err) }]);
      } catch { /* 报告面自身失败静默——影子侧绝不影响读路径 */ }
    }
  }
  return jsonVal;
}

/**
 * 投影级结构对比：JSON 侧返回值 vs SQLite 投影返回值（同型 T）——键集差/数量差/值差，
 * 深递归但限额 MAX_DIFF_ROWS_PER_DOMAIN（超出截断+truncated 摘要行，备案）。
 */
export function diffProjection<T>(domain: ShadowDomain, jsonVal: T, sqliteVal: T): ShadowDiffRow[] {
  const rows: ShadowDiffRow[] = [];
  const collect = (path: string, j: unknown, s: unknown): void => {
    if (rows.length >= MAX_DIFF_ROWS_PER_DOMAIN) {
      if (rows.length === MAX_DIFF_ROWS_PER_DOMAIN) {
        rows.push({ ts: Date.now(), domain, key: "*", category: "count-mismatch", json_value: "truncated", sqlite_value: `差异超 ${MAX_DIFF_ROWS_PER_DOMAIN} 行截断` });
      }
      return;
    }
    if (JSON.stringify(j) === JSON.stringify(s)) return;
    if (Array.isArray(j) && Array.isArray(s)) {
      if (j.length !== s.length) {
        rows.push({ ts: Date.now(), domain, key: path || "*", category: "count-mismatch", json_value: j.length, sqlite_value: s.length });
      }
      const len = Math.max(j.length, s.length);
      for (let i = 0; i < len; i++) collect(`${path}[${i}]`, j[i], s[i]);
      return;
    }
    if (j !== null && s !== null && typeof j === "object" && typeof s === "object") {
      const jo = j as Record<string, unknown>;
      const so = s as Record<string, unknown>;
      for (const k of Object.keys(jo)) {
        if (!(k in so)) rows.push({ ts: Date.now(), domain, key: path ? `${path}.${k}` : k, category: "missing-in-sqlite", json_value: jo[k] });
        else collect(path ? `${path}.${k}` : k, jo[k], so[k]);
      }
      for (const k of Object.keys(so)) {
        if (!(k in jo)) rows.push({ ts: Date.now(), domain, key: path ? `${path}.${k}` : k, category: "missing-in-json", sqlite_value: so[k] });
      }
      return;
    }
    rows.push({ ts: Date.now(), domain, key: path || "*", category: "value-mismatch", json_value: j, sqlite_value: s });
  };
  collect("", jsonVal, sqliteVal);
  return rows;
}

/** 测试隔离：清 port 单例与节流缓存（关开库）。生产勿调。 */
export function resetReadModeForTest(): void {
  for (const port of portCache.values()) {
    try { if (port.isOpen) port.close(); } catch { /* 已关则跳过 */ }
  }
  portCache.clear();
  shadowCooldown.clear();
}
