// CONNV4C1 批C-件一（t-49e6102c，1117 用户令「模块三：本机管理连入设备」）：
// 设备管理命令面数据层——kick 冷却（wb-/wt- 账号类 24h 静默）+ ignore 忽略（常驻拉黑）。
//
// 与 device_trust 的分工（两表解耦，同库同域清单 DEVICE_TRUST_TABLES）：
//   - trust=信任生命周期（first_seen→confirmed→revoked，pubkey 钉扎）——吊销是重语义
//     （同 dev 同钥重连仍拒，恢复需重走配对/首联确认）；
//   - admin_state=运维静默层——冷却是轻语义（**不动 trust**，期满自动回正常）；忽略是
//     常驻语义（写 trust 吊销+本表留痕，unignore 双清但**不自动复活信任**——恢复需重走
//     配对/首联确认，任务书 R2 定案口径）。
// 本文件是 device_admin_state 域唯一写者（device-trust.ts 同范式：StoragePort 单写者、
// 坏库容忍 null、幂等 upsert、无 DELETE）。
import type { StoragePort } from "./storage/port.js";

export interface DeviceAdminRow {
  dev: string;
  cooldown_until: number | null;
  ignored_at: number | null;
  note: string | null;
}

/** kick 冷却时长：wb-/wt- 账号类 24h（评审 R2 写死——账号类自动重连的静默期）。 */
export const KICK_COOLDOWN_MS = 24 * 3600_000;

function rowOf(r: Record<string, unknown>): DeviceAdminRow {
  return {
    dev: r.dev as string,
    cooldown_until: (r.cooldown_until as number | null) ?? null,
    ignored_at: (r.ignored_at as number | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

export function getAdminState(port: StoragePort | null, dev: string): DeviceAdminRow | null {
  if (port === null) return null;
  try {
    const rows = port.query<Record<string, unknown>>("SELECT * FROM device_admin_state WHERE dev = ?", [dev]);
    return rows.length ? rowOf(rows[0]) : null;
  } catch {
    return null;
  }
}

export function listAdminState(port: StoragePort | null): DeviceAdminRow[] {
  if (port === null) return [];
  try {
    return port.query<Record<string, unknown>>("SELECT * FROM device_admin_state").map(rowOf);
  } catch {
    return [];
  }
}

/** upsert 单字段（保另一字段与 note——冷却与忽略可并存于一行：先 kick 后 ignore 形态）。 */
function upsertField(port: StoragePort | null, dev: string, field: "cooldown_until" | "ignored_at", value: number | null, note: string | null): boolean {
  if (port === null) return false;
  try {
    const cur = getAdminState(port, dev);
    const row = {
      cooldown_until: field === "cooldown_until" ? value : cur?.cooldown_until ?? null,
      ignored_at: field === "ignored_at" ? value : cur?.ignored_at ?? null,
      note: note ?? cur?.note ?? null,
    };
    if (cur) {
      port.exec("UPDATE device_admin_state SET cooldown_until = ?, ignored_at = ?, note = ? WHERE dev = ?", [row.cooldown_until, row.ignored_at, row.note, dev]);
    } else {
      port.exec("INSERT INTO device_admin_state (dev, cooldown_until, ignored_at, note) VALUES (?,?,?,?)", [dev, row.cooldown_until, row.ignored_at, row.note]);
    }
    return true;
  } catch (e) {
    console.warn(`[device-admin] 写管理态失败 dev=${dev}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** kick 账号类（wb-/wt-）：写冷却（now+24h；until 传 null=清冷却——unignore 联动清理用）。 */
export function setCooldown(port: StoragePort | null, dev: string, until: number | null, note?: string): boolean {
  return upsertField(port, dev, "cooldown_until", until, note ?? null);
}

/** ignore：写忽略清单（常驻——直到 unignore；ignored_at 为置位时刻）。 */
export function setIgnored(port: StoragePort | null, dev: string, note?: string): boolean {
  return upsertField(port, dev, "ignored_at", Date.now(), note ?? "ignored");
}

/** unignore 联动：全清管理标记（忽略+冷却，note 留痕）。无行=幂等直过，不落空行。 */
export function clearAdminMarks(port: StoragePort | null, dev: string): boolean {
  if (port === null) return false;
  try {
    if (!getAdminState(port, dev)) return true;
    port.exec("UPDATE device_admin_state SET cooldown_until = NULL, ignored_at = NULL WHERE dev = ?", [dev]);
    return true;
  } catch (e) {
    console.warn(`[device-admin] 清管理态失败 dev=${dev}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 设备是否被管理态静默拒（拒入口消费）：ignored 恒拒；cooldown 仅 until 内拒。
 *  返回 null=放行（无管理态或冷却已过）。 */
export function adminVerdict(port: StoragePort | null, dev: string, now = Date.now()): { barred: "cooldown" | "ignored"; until?: number } | null {
  const row = getAdminState(port, dev);
  if (!row) return null;
  if (row.ignored_at !== null) return { barred: "ignored" };
  if (row.cooldown_until !== null && now < row.cooldown_until) return { barred: "cooldown", until: row.cooldown_until };
  return null;
}
