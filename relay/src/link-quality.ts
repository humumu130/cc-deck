// [W-LINKQUALITY]（1104 用户实锤×N：公司连家 Mac 断连频繁+重连慢）链路分段遥测账本。
// 分段法：段①端↔CF 边缘（web/RN 客户端本地记、重连成功后批量补报 POST /api/telemetry/link）
//        段②家 Mac↔CF（cloud-client 生命周期直记——connect/drop/reconnect/retry-fail）
// 账本 dataDir/link-quality.ndjson：append-only（超 5MB 滚动 .1 同 boards-journal 口径）；
// summary 聚合纯函数（24h 窗默认）：drop 计数/分源计数/reconnect P50/P95（线性插值分位，
// 单样本=唯一真值）/avgAttempts/末次断连——诊断面与回执定罪共用单口。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LinkEventSrc = "bridge" | "web-lan" | "web-cloud" | "rn";
export type LinkEventKind = "drop" | "reconnect" | "connect" | "retry-fail";

export interface LinkEventRow {
  ts: number;
  src: LinkEventSrc;
  kind: LinkEventKind;
  /** 断因（close code/heartbeat-timeout/boot-guard/construct-throw 等） */
  reason?: string;
  /** ws close code（drop 形态） */
  code?: number;
  /** 断连→恢复耗时（reconnect 形态） */
  downtimeMs?: number;
  /** 该次恢复的尝试次数（端侧补报带） */
  attempts?: number;
  /** 本次掉线前连接存活时长（drop 形态） */
  connectedMs?: number;
  /** [R1·P1-2] 端侧通道（rn 源 LAN/云分键；web 源已由 src 区分，缺省=旧端兼容） */
  channel?: "lan" | "cloud";
}

/** [W-LINKQUALITY-R1]（A审 P0/P1-1/P1-3）补报单口：校验+事件指纹去重+落账——
 * ws 帧命令（主链）与 HTTP /api/telemetry/link（调试口）共用。指纹=src|kind|ts
 *（任务书口径），近窗去重（进程内 2000 条/30min 窗）——补报 at-least-once 重发
 * （响应丢失/ACK 丢）不双记账；P1-3 断言：同批重放 N 次落账数不变。 */
export const LINK_SRC_OK = new Set<LinkEventSrc>(["web-lan", "web-cloud", "rn"]); // bridge 段不经补报（cloud-client 直记）
const LINK_KIND_OK = new Set<LinkEventKind>(["drop", "reconnect", "connect", "retry-fail"]);
const LINK_SEEN = new Map<string, number>();
const LINK_SEEN_MAX = 2000;
const LINK_SEEN_WINDOW_MS = 30 * 60_000;

export interface LinkIngestResult { accepted: number; deduped: number; rejected: number; }

function num(v: unknown, min: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined;
}

export function ingestLinkEvents(dataDir: string, events: unknown, now = Date.now()): LinkIngestResult {
  const out: LinkIngestResult = { accepted: 0, deduped: 0, rejected: 0 };
  if (!Array.isArray(events)) return out;
  for (const e of events.slice(0, 200)) { // 单批 200 截（原 HTTP 口径随批保留）
    if (!e || typeof e !== "object") { out.rejected++; continue; }
    const r = e as Partial<LinkEventRow> & { channel?: unknown };
    const src = r.src as LinkEventSrc, kind = r.kind as LinkEventKind;
    if (typeof r.ts !== "number" || !LINK_SRC_OK.has(src) || !LINK_KIND_OK.has(kind)) { out.rejected++; continue; }
    if (r.ts > now + 60_000 || r.ts < now - 7 * 86_400_000) { out.rejected++; continue; } // 未来 60s / 7d 界（原 HTTP 口径单口化）
    const fp = `${src}|${kind}|${r.ts}`;
    if (LINK_SEEN.has(fp)) { out.deduped++; continue; }
    LINK_SEEN.set(fp, r.ts);
    appendLinkEvent(dataDir, {
      ts: r.ts,
      src,
      kind,
      ...(typeof r.reason === "string" && r.reason ? { reason: r.reason.slice(0, 100) } : {}),
      ...(num(r.code, 0) !== undefined ? { code: r.code as number } : {}),
      ...(num(r.downtimeMs, 0) !== undefined ? { downtimeMs: r.downtimeMs as number } : {}),
      ...(num(r.attempts, 1) !== undefined ? { attempts: r.attempts as number } : {}),
      ...(num(r.connectedMs, 0) !== undefined ? { connectedMs: r.connectedMs as number } : {}),
      ...(r.channel === "lan" || r.channel === "cloud" ? { channel: r.channel } : {}),
    });
    out.accepted++;
  }
  if (LINK_SEEN.size > LINK_SEEN_MAX) { // 近窗清理：按记录 ts 淘汰过期+超量截尾（值=事件 ts）
    const cutoff = now - LINK_SEEN_WINDOW_MS;
    for (const [k, ts] of [...LINK_SEEN.entries()]) { if (ts < cutoff) LINK_SEEN.delete(k); }
    if (LINK_SEEN.size > LINK_SEEN_MAX) {
      const keep = [...LINK_SEEN.entries()].sort((a, b) => b[1] - a[1]).slice(0, LINK_SEEN_MAX);
      LINK_SEEN.clear();
      for (const [k, ts] of keep) LINK_SEEN.set(k, ts);
    }
  }
  return out;
}

export interface LinkSummary {
  windowMs: number;
  drops: number;
  dropsBySrc: Partial<Record<LinkEventSrc, number>>;
  reconnects: number;
  /** 重连耗时 P50/P95（ms，线性插值分位；单样本=唯一真值） */
  reconnectP50Ms?: number;
  reconnectP95Ms?: number;
  reconnectAvgMs?: number;
  /** 端侧上报的平均尝试次数（web/rn 源） */
  avgAttempts?: number;
  lastDropAt?: number;
  lastEventAt?: number;
}

const LINK_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function linkLogPath(dataDir: string): string {
  return join(dataDir, "link-quality.ndjson");
}

export function appendLinkEvent(dataDir: string, row: LinkEventRow): void {
  const p = linkLogPath(dataDir);
  try {
    mkdirSync(dataDir, { recursive: true });
    try {
      if (existsSync(p) && statSync(p).size > LINK_LOG_MAX_BYTES) {
        try { rmSync(`${p}.1`, { force: true }); } catch { /* 旧档删除失败不阻断滚动 */ }
        renameSync(p, `${p}.1`);
      }
    } catch { /* 首写无文件直追 */ }
    appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");
  } catch (e) {
    console.error(`[link-quality] 记账失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 读全部事件（.1 旧档并入；坏行跳过；容量截尾）。 */
export function readLinkEvents(dataDir: string, maxRows = 20_000): LinkEventRow[] {
  const out: LinkEventRow[] = [];
  for (const p of [`${linkLogPath(dataDir)}.1`, linkLogPath(dataDir)]) {
    let raw = "";
    try { raw = readFileSync(p, "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LinkEventRow;
        if (r && typeof r.ts === "number" && typeof r.src === "string" && typeof r.kind === "string") out.push(r);
      } catch { /* 坏行跳过 */ }
    }
  }
  return out.length > maxRows ? out.slice(out.length - maxRows) : out;
}

/** 线性插值分位（单样本=唯一真值——恒真禁用批的对照面：不造 0） */
function percentile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

export function linkSummary(dataDir: string, windowMs = 86_400_000, now = Date.now()): LinkSummary {
  const rows = readLinkEvents(dataDir).filter((r) => now - r.ts <= windowMs);
  const drops = rows.filter((r) => r.kind === "drop");
  const recs = rows.filter((r) => r.kind === "reconnect" && typeof r.downtimeMs === "number");
  const dt = recs.map((r) => r.downtimeMs as number).sort((a, b) => a - b);
  const attRows = recs.filter((r) => typeof r.attempts === "number" && r.src !== "bridge");
  const dropsBySrc: Partial<Record<LinkEventSrc, number>> = {};
  for (const d of drops) dropsBySrc[d.src] = (dropsBySrc[d.src] ?? 0) + 1;
  const sum = dt.reduce((a, b) => a + b, 0);
  return {
    windowMs,
    drops: drops.length,
    dropsBySrc,
    reconnects: recs.length,
    ...(dt.length ? { reconnectP50Ms: percentile(dt, 0.5) } : {}),
    ...(dt.length ? { reconnectP95Ms: percentile(dt, 0.95) } : {}),
    ...(dt.length ? { reconnectAvgMs: Math.round(sum / dt.length) } : {}),
    ...(attRows.length ? { avgAttempts: Math.round((attRows.reduce((a, r) => a + (r.attempts as number), 0) / attRows.length) * 10) / 10 } : {}),
    ...(drops.length ? { lastDropAt: drops[drops.length - 1].ts } : {}),
    ...(rows.length ? { lastEventAt: rows[rows.length - 1].ts } : {}),
  };
}
