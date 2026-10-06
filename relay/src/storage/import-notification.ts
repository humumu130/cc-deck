// ---------- notification 双层导入器（M11-E1，照 M11-C1 范式五要点） ----------
// 消费面：data/notifications.json（R1c 结构化投影账）+ data/decision-notifications.json
// （019 ledger 文本推送通道）→ notification（实体层）+ notification_client_state（per-client 层）。
// 两源同 key 体系（R1c 投影即从 ledger 体系来）：同 key 合并为同一实体行（确定性 id=sha1(key)）；
// 跨源归并规则=非空优先、双方都有取较早、投影源字段优先（确定性，同源重复才落 duplicate-key 账）。
//
// 双层映射（冻结件 §4 loss list 口径，回单列明）：
//   实体层：level←severity（仅 ledger 条目按投影同向推导：!actionable||system→info:resolved?done:waiting）、
//     category←kind、condition_key←key、handled_at←handled_at ?? 全局 dismissed_at（isHandled 语义：
//     无 client 归属的全局 dismiss 算已处理下沉实体，不推断 per-device）、resolved_at、
//     session_id←sourceContext.sessionId ?? source_session_id（有值写值，缺 NULL 不 loss——system/
//     activity 类通知合法无归因，loss 记了是噪声；三归因列无 FK 为冻结件有意设计）。
//     payload_json 收编两源全部剩余字段（title/body/actionable/group/sourceContext/ledger 专有
//     first_sent_at·reminded_at·revision）——数据零丢失。
//   client 层：notifications.json 条目级 client_states[]（per-device 读态字段，旧 JSON 无=空，
//     冻结件「端侧历史若无则空」）→ notification_client_state；缺 client_id 记 loss（冻结件原文）。
//   loss 备注：return_path 无对应实体列→每条非空 returnPath 落 unmapped-field 备注账（excerpt 记
//     key+return_path），payload_json 双保险不丢。
// 范式五要点（C1 定稿）：port 显式传入+事务内聚；JSON 全量源文件级 checkpoint（skip/重扫，offset 恒
// =lineCount）；失效即域清重灌（两表子先父+按源清旧 loss）；坏行 loss 不阻断；确定性 id 幂等。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha12, statThenRead } from "./import-util.js";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, listLoss } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级 bump→全源失效强制重扫。 */
export const NOTIFICATION_IMPORT_SCHEMA_VERSION = 1;

export interface NotificationImportCounts {
  notification: number;
  clientState: number;
}

export interface NotificationImportResult {
  /** true=两源 checkpoint 全命中，域零写入快进。 */
  skipped: boolean;
  counts: NotificationImportCounts;
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  rescanned: string[];
}

interface ObservedSource {
  name: string;
  file: string;
  mtimeMs: number;
  lineCount: number;
  text: string | null;
}

interface ClientStateRaw { clientId: string | null; readAt: number | null; dismissedAt: number | null }

interface SourceCtxRaw { domain?: unknown; entityId?: unknown; sessionId?: unknown; segment?: unknown; alertId?: unknown; returnPath?: unknown }

interface MergedNotification {
  // origin：来源源（proj/ledger）；跨源归并发生时翻 "merged"——防「已归并行再遇第三条同源
  // 条目」被误判为可归并（纯中间模型状态，不落库）。
  id: string; key: string; origin: "proj" | "ledger" | "merged"; category: string; level: string;
  sessionId: string | null; payload: Record<string, unknown>;
  handledAt: number | null; resolvedAt: number | null; conditionKey: string;
  createdAt: number;
  clientStates: ClientStateRaw[];
}

function observe(file: string, name: string): ObservedSource {
  if (!existsSync(file)) return { name, file, mtimeMs: 0, lineCount: 0, text: null };
  const obs = statThenRead(file); // stat 先于 read 定稿序（权威注释见 import-util.ts）
  const lines = obs.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { name, file, mtimeMs: obs.mtimeMs, lineCount: lines.length, text: obs.text };
}

function countAll(port: StoragePort): NotificationImportCounts {
  return {
    notification: port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification")[0]?.n ?? -1,
    clientState: port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification_client_state")[0]?.n ?? -1,
  };
}

/** severity 推导（仅 ledger 条目；与 decision-notify.projectLedgerNotifications 投影同向）。 */
function deriveLevel(actionable: boolean, kind: string, resolvedAt: number | null): string {
  if (!actionable || kind === "system") return "info";
  return resolvedAt !== null ? "done" : "waiting";
}

/**
 * notification 双层导入：两源 JSON 快照同步进 notification + notification_client_state。
 * 幂等/失效重扫/事务语义同 importOrg（C1 模板）。
 */
export function importNotifications(port: StoragePort, dataDir: string, opts?: { schemaVersion?: number }): NotificationImportResult {
  const schemaVersion = opts?.schemaVersion ?? NOTIFICATION_IMPORT_SCHEMA_VERSION;
  const sources = [
    observe(join(dataDir, "notifications.json"), "notifications.json"),
    observe(join(dataDir, "decision-notifications.json"), "decision-notifications.json"),
  ];
  const current = (s: ObservedSource) => ({ mtimeMs: s.mtimeMs, lineCount: s.lineCount, schemaVersion });
  const allValid = sources.every((s) => readCheckpoint(port, s.file, current(s)) !== null);
  if (allValid) {
    return { skipped: true, counts: countAll(port), loss: listLoss(port).filter((l) => sources.some((s) => s.file === l.sourcePath)).length, rescanned: [] };
  }

  // ---------- 解析（纯函数段）：按 key 归并两源 + loss 待落账 ----------
  const losses: { source: ObservedSource; lineNo: number; reason: string; excerpt: string }[] = [];
  const byKey = new Map<string, MergedNotification>();
  // 投影源条目形状（notifications.json）
  interface ProjRaw {
    key?: unknown; kind?: unknown; group?: unknown; severity?: unknown; title?: unknown; body?: unknown;
    actionable?: unknown; created_at?: unknown; resolved_at?: unknown; handled_at?: unknown; dismissed_at?: unknown;
    sourceContext?: SourceCtxRaw; // session-manager 序列化是 camelCase（NotificationItem.sourceContext）
    client_states?: unknown;
  }
  const projSrc = sources[0];
  if (projSrc.text !== null) {
    try {
      const pf = JSON.parse(projSrc.text) as { notifications?: unknown };
      if (!Array.isArray(pf.notifications)) throw new Error("notifications 非数组");
      (pf.notifications as unknown[]).forEach((raw, idx) => {
        const lineNo = idx + 1;
        const x = raw as ProjRaw;
        if (typeof x.key !== "string" || !x.key || typeof x.kind !== "string" || typeof x.created_at !== "number") {
          losses.push({ source: projSrc, lineNo, reason: "missing-field", excerpt: JSON.stringify(x).slice(0, 200) });
          return;
        }
        if (byKey.has(x.key)) {
          losses.push({ source: projSrc, lineNo, reason: "duplicate-key", excerpt: JSON.stringify({ key: x.key }).slice(0, 200) });
          return;
        }
        const resolvedAt = typeof x.resolved_at === "number" ? x.resolved_at : null;
        const handledAt = typeof x.handled_at === "number" ? x.handled_at : (typeof x.dismissed_at === "number" ? x.dismissed_at : null);
        const actionable = x.actionable === true;
        const sc = x.sourceContext ?? {};
        // per-device 读态（冻结件：read/dismiss 下沉 client state；缺 client_id 记 loss）
        const clientStates: ClientStateRaw[] = [];
        if (Array.isArray(x.client_states)) {
          (x.client_states as unknown[]).forEach((cs) => {
            const c = cs as Record<string, unknown>;
            if (typeof c.client_id !== "string" || !c.client_id) {
              losses.push({ source: projSrc, lineNo, reason: "missing-attribution", excerpt: JSON.stringify({ key: x.key, client_state: c }).slice(0, 200) });
              return;
            }
            clientStates.push({
              clientId: c.client_id,
              readAt: typeof c.read_at === "number" ? c.read_at : null,
              dismissedAt: typeof c.dismissed_at === "number" ? c.dismissed_at : null,
            });
          });
        }
        // return_path 无对应实体列→loss 备注不丢（payload_json 双保险）
        const returnPath = typeof sc.returnPath === "string" ? sc.returnPath : "";
        if (returnPath) losses.push({ source: projSrc, lineNo, reason: "unmapped-field", excerpt: JSON.stringify({ key: x.key, return_path: returnPath }).slice(0, 300) });
        byKey.set(x.key, {
          id: `ntf-${sha12(x.key)}`, key: x.key, origin: "proj", category: x.kind,
          level: typeof x.severity === "string" ? x.severity : deriveLevel(actionable, x.kind, resolvedAt),
          sessionId: typeof sc.sessionId === "string" && sc.sessionId ? sc.sessionId : null,
          payload: {
            title: x.title ?? "", body: x.body ?? "", actionable, group: x.group ?? null, source_context: sc,
          },
          handledAt, resolvedAt, conditionKey: x.key, createdAt: x.created_at, clientStates,
        });
      });
    } catch {
      losses.push({ source: projSrc, lineNo: 1, reason: "bad-json", excerpt: projSrc.text.slice(0, 200) });
    }
  }
  // ledger 源条目形状（decision-notifications.json，snake_case）：同 key 跨源归并、同源重复落账
  interface LedgerRaw {
    key?: unknown; kind?: unknown; source_session_id?: unknown; created_at?: unknown;
    first_sent_at?: unknown; reminded_at?: unknown; resolved_at?: unknown; handled_at?: unknown;
    dismissed_at?: unknown; group?: unknown; actionable?: unknown; revision?: unknown;
    source_context?: SourceCtxRaw;
  }
  const ledgerSrc = sources[1];
  if (ledgerSrc.text !== null) {
    try {
      const lf = JSON.parse(ledgerSrc.text) as unknown;
      if (!Array.isArray(lf)) throw new Error("根非数组");
      (lf as unknown[]).forEach((raw, idx) => {
        const lineNo = idx + 1;
        const d = raw as LedgerRaw;
        if (typeof d.key !== "string" || !d.key || typeof d.kind !== "string" || typeof d.created_at !== "number") {
          losses.push({ source: ledgerSrc, lineNo, reason: "missing-field", excerpt: JSON.stringify(d).slice(0, 200) });
          return;
        }
        const resolvedAt = typeof d.resolved_at === "number" ? d.resolved_at : null;
        const handledAt = typeof d.handled_at === "number" ? d.handled_at : (typeof d.dismissed_at === "number" ? d.dismissed_at : null);
        const actionable = d.actionable === true;
        const sc = d.source_context ?? null;
        const sessionId = typeof sc?.sessionId === "string" && sc.sessionId ? sc.sessionId : (typeof d.source_session_id === "string" && d.source_session_id ? d.source_session_id : null);
        const returnPath = typeof sc?.returnPath === "string" ? sc.returnPath : "";
        const ledgerExtra: Record<string, unknown> = {
          ...(typeof d.first_sent_at === "number" ? { first_sent_at: d.first_sent_at } : {}),
          ...(typeof d.reminded_at === "number" ? { reminded_at: d.reminded_at } : {}),
          ...(typeof d.revision === "string" ? { revision: d.revision } : {}),
        };
        const existing = byKey.get(d.key);
        if (existing !== undefined) {
          if (existing.origin !== "proj") {
            // 同源重复 key（含已归并行再遇同源条目）：保留首条，后续落账
            losses.push({ source: ledgerSrc, lineNo, reason: "duplicate-key", excerpt: JSON.stringify({ key: d.key }).slice(0, 200) });
            return;
          }
          // 跨源同 key 归并（确定性：非空优先、双方都有取较早；投影源字段优先）；翻 origin
          // 防「已归并行再遇第三条 ledger 条目」被误判为可归并
          if (returnPath) losses.push({ source: ledgerSrc, lineNo, reason: "unmapped-field", excerpt: JSON.stringify({ key: d.key, return_path: returnPath }).slice(0, 300) });
          existing.sessionId = existing.sessionId ?? sessionId;
          existing.createdAt = Math.min(existing.createdAt, d.created_at);
          existing.handledAt = existing.handledAt !== null && handledAt !== null ? Math.min(existing.handledAt, handledAt) : (existing.handledAt ?? handledAt);
          existing.resolvedAt = existing.resolvedAt !== null && resolvedAt !== null ? Math.min(existing.resolvedAt, resolvedAt) : (existing.resolvedAt ?? resolvedAt);
          if (Object.keys(ledgerExtra).length > 0) existing.payload.ledger = ledgerExtra;
          existing.origin = "merged";
          return;
        }
        if (returnPath) losses.push({ source: ledgerSrc, lineNo, reason: "unmapped-field", excerpt: JSON.stringify({ key: d.key, return_path: returnPath }).slice(0, 300) });
        byKey.set(d.key, {
          id: `ntf-${sha12(d.key)}`, key: d.key, origin: "ledger", category: d.kind,
          level: deriveLevel(actionable, d.kind, resolvedAt),
          sessionId,
          payload: {
            title: "", body: "", actionable, group: d.group ?? null,
            source_context: sc ?? { domain: d.kind, entityId: d.key, alertId: d.key, returnPath: "" },
            ...(Object.keys(ledgerExtra).length > 0 ? { ledger: ledgerExtra } : {}),
          },
          handledAt, resolvedAt, conditionKey: d.key, createdAt: d.created_at, clientStates: [],
        });
      });
    } catch {
      losses.push({ source: ledgerSrc, lineNo: 1, reason: "bad-json", excerpt: ledgerSrc.text.slice(0, 200) });
    }
  }

  // ---------- 落库（单事务：域清→重灌→loss→checkpoint） ----------
  port.begin();
  try {
    port.exec("DELETE FROM notification_client_state");
    port.exec("DELETE FROM notification");
    port.exec("DELETE FROM import_loss WHERE source_path IN (?, ?)", [projSrc.file, ledgerSrc.file]);
    for (const n of byKey.values()) {
      port.exec(
        "INSERT INTO notification (id, project_id, group_id, session_id, level, category, payload_json, handled_at, resolved_at, condition_key, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
        [n.id, n.sessionId, n.level, n.category, JSON.stringify(n.payload), n.handledAt, n.resolvedAt, n.conditionKey, n.createdAt],
      );
      for (const cs of n.clientStates) {
        port.exec(
          "INSERT INTO notification_client_state (notification_id, client_id, read_at, dismissed_at) VALUES (?, ?, ?, ?)",
          [n.id, cs.clientId, cs.readAt, cs.dismissedAt],
        );
      }
    }
    for (const l of losses) appendLoss(port, { sourcePath: l.source.file, lineNo: l.lineNo, reason: l.reason, excerpt: l.excerpt });
    for (const s of sources) writeCheckpoint(port, { path: s.file, mtimeMs: s.mtimeMs, lineCount: s.lineCount, offset: s.lineCount, schemaVersion });
    port.commit();
  } catch (err) {
    port.rollback();
    throw new Error(`import-notification: 通知域导入失败已回滚（保留旧快照）——${err instanceof Error ? err.message : String(err)}`);
  }

  return { skipped: false, counts: countAll(port), loss: losses.length, rescanned: sources.filter((s) => s.text !== null).map((s) => s.file) };
}
