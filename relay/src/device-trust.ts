// X1 多机编排（PRD v0.3 §4.4/§4.5）：设备互信表写面——经 StoragePort 单写者落 device_trust
// 表（schema v7），范式循 permission-audit.ts（append + 少量状态拍，坏库/驱动缺失返回 null
// 容忍，调用方 fail-closed）。四态生命周期：
//   pending（first_seen，confirmed_at NULL）→ confirmed（确认卡 ✓）→ revoked（✗ 或事后吊销）。
// pubkey 钉扎：已确认/在档行换 pubkey = 冒名，upsertFirstSeen 拒绝（返回 mismatch），绝不覆盖。
// 本文件是 device_trust 域唯一写者；xmsg 接收链（session-manager）按本表裁决信任。
import { join } from "node:path";
import { ensureStore } from "./storage/read-mode.js";
import { loadSqliteDriver } from "./storage/sqlite.js";
import { orgDir } from "./org.js";
import type { StoragePort } from "./storage/port.js";

export interface DeviceTrustRow {
  dev: string;
  pubkey: string;
  tenant: string | null;
  first_seen_at: number;
  confirmed_at: number | null;
  confirmed_by: string | null;
  revoked_at: number | null;
  first_msg_id: string | null;
  note: string | null;
}

/** 驱动不可用一次性告警（审计尽力而为面同款纪律）。 */
let trustSkipNotified = false;
function warnTrustSkipped(reason: string): void {
  if (trustSkipNotified) return;
  trustSkipNotified = true;
  console.warn(`[device-trust] ⚠️ sqlite 不可用，设备互信表跳过（xmsg 接收将 fail-closed 拒绝）。原因: ${reason}；平台 ${process.platform}-${process.arch}`);
}

/** 端口（ensureStore 缓存复用；与 permission-audit 同款降级口径）。 */
export function trustStore(dataDir: string): StoragePort | null {
  const driver = loadSqliteDriver();
  if (!driver.ok) {
    warnTrustSkipped(`${driver.code ?? "无错误码"}: ${driver.error ?? "unknown"}`);
    return null;
  }
  try {
    return ensureStore({ dataDir, orgDir: orgDir(), tasksDir: join(dataDir, "tasks") });
  } catch (e) {
    warnTrustSkipped(e instanceof Error ? e.message : String(e));
    return null;
  }
}

function rowOf(r: Record<string, unknown>): DeviceTrustRow {
  return {
    dev: r.dev as string,
    pubkey: r.pubkey as string,
    tenant: (r.tenant as string | null) ?? null,
    first_seen_at: r.first_seen_at as number,
    confirmed_at: (r.confirmed_at as number | null) ?? null,
    confirmed_by: (r.confirmed_by as string | null) ?? null,
    revoked_at: (r.revoked_at as number | null) ?? null,
    first_msg_id: (r.first_msg_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

export function getDeviceTrust(port: StoragePort | null, dev: string): DeviceTrustRow | null {
  if (port === null) return null;
  try {
    const r = port.query<Record<string, unknown>>("SELECT * FROM device_trust WHERE dev = ?", [dev]);
    return r.length ? rowOf(r[0]!) : null;
  } catch {
    return null;
  }
}

export function listDeviceTrust(port: StoragePort | null): DeviceTrustRow[] {
  if (port === null) return [];
  try {
    return port.query<Record<string, unknown>>("SELECT * FROM device_trust ORDER BY first_seen_at DESC").map(rowOf);
  } catch {
    return [];
  }
}

export type TrustVerdict =
  | { state: "confirmed"; row: DeviceTrustRow }
  | { state: "pending"; row: DeviceTrustRow }
  | { state: "revoked"; row: DeviceTrustRow }
  | { state: "none" }
  | { state: "mismatch"; row: DeviceTrustRow } // 同 dev 换 pubkey：冒名/换钥，拒（钉扎）
  | { state: "unavailable" }; // sqlite 不可用：fail-closed

/** 信任裁决（读面单点）：xmsg 接收链唯一消费口。 */
export function trustVerdict(port: StoragePort | null, dev: string, pubkey: string): TrustVerdict {
  if (port === null) return { state: "unavailable" };
  const row = getDeviceTrust(port, dev);
  if (!row) return { state: "none" };
  if (row.pubkey !== pubkey) return { state: "mismatch", row };
  if (row.revoked_at !== null) return { state: "revoked", row };
  if (row.confirmed_at !== null) return { state: "confirmed", row };
  return { state: "pending", row };
}

export type UpsertResult = "created" | "exists" | "mismatch" | "unavailable";

/** 首见登记（pending 行）：幂等；同 dev 换 pubkey 拒（钉扎）；已被吊销的 dev 不复活。 */
export function upsertFirstSeen(port: StoragePort | null, dev: string, pubkey: string, tenant: string | null, firstMsgId?: string): UpsertResult {
  if (port === null) return "unavailable";
  try {
    const cur = getDeviceTrust(port, dev);
    if (cur) {
      if (cur.pubkey !== pubkey) return "mismatch";
      return "exists";
    }
    port.exec(
      "INSERT INTO device_trust (dev, pubkey, tenant, first_seen_at, first_msg_id) VALUES (?,?,?,?,?)",
      [dev, pubkey, tenant, Date.now(), firstMsgId ?? null],
    );
    return "created";
  } catch (e) {
    console.warn(`[device-trust] 首见登记失败: ${e instanceof Error ? e.message : String(e)}`);
    return "unavailable";
  }
}

/** 确认（首联卡 ✓）：pending → confirmed。已确认幂等；已吊销拒（重新信任需先清吊销——运维动作）。 */
export function confirmDevice(port: StoragePort | null, dev: string, by: string): { ok: boolean; error?: string } {
  if (port === null) return { ok: false, error: "互信表不可用" };
  const cur = getDeviceTrust(port, dev);
  if (!cur) return { ok: false, error: `设备不在互信表: ${dev}` };
  if (cur.revoked_at !== null) return { ok: false, error: "设备已吊销，不可直接确认（需运维清吊销标记）" };
  if (cur.confirmed_at !== null) return { ok: true };
  try {
    port.exec("UPDATE device_trust SET confirmed_at = ?, confirmed_by = ? WHERE dev = ?", [Date.now(), by, dev]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 吊销（首联卡 ✗ / 事后踢出）：终态，同 dev 同钥重连仍拒。幂等。 */
export function revokeDevice(port: StoragePort | null, dev: string, note?: string): { ok: boolean; error?: string } {
  if (port === null) return { ok: false, error: "互信表不可用" };
  const cur = getDeviceTrust(port, dev);
  if (!cur) return { ok: false, error: `设备不在互信表: ${dev}` };
  if (cur.revoked_at !== null) return { ok: true };
  try {
    port.exec("UPDATE device_trust SET revoked_at = ?, note = ? WHERE dev = ?", [Date.now(), note ?? cur.note ?? null, dev]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
