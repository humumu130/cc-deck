// E2b root 写链路纯函数（自 ListScreen.tsx E2B-COMMANDS 段原样迁出，W-EXPOLISH）。
// 迁出动机：组织域组件（OrgZone/GroupModal/团队·项目 tab）与通知 tab 页从 ListScreen
// 拆为独立模块后仍需同一套 ACK 严格判定门——反向 import 列表屏会拉进整个 RN 屏模块，
// 纯函数落独立零依赖文件才是干净依赖向。消费面：
//   ListScreen.tsx   —— re-export（NewSessionModal/test-e-permission-summary 等既有
//                       import 面不变，E2b 语义锚仍从原路径可达）
//   OrgZone.tsx      —— useOrgDecide（确认卡决议）
//   NotifCenterPage.tsx —— useNotifAck（通知动作）
// §5.4 硬条款：ACK 必须核 ok === true，HTTP 200/已发送/退出 0 都不算成功；无自动
// 重试风暴（重试=用户重点；store 全局纪律已封顶：4s 超时重发同 command_id 一次 →
// 6s 收摊回调一次，调用方只呈现不自动重发）。

export interface AckLike { ok?: unknown; error?: unknown; err?: unknown }
export interface AckVerdict { ok: boolean; error: string | null; kind: "ok" | "rejected" | "unconfirmed" }

// ACK 严格判定三态：ack 缺失（发送失败/超时收摊）→ unconfirmed（可重试文案）；
// ok === true 才成功；其余一律 rejected（error/err 字符串透传，非串兜底文案）
export function ackVerdict(ack: AckLike | null | undefined): AckVerdict {
  if (ack == null || typeof ack !== "object") {
    return { ok: false, error: "命令未确认（超时或源未连接），可重试", kind: "unconfirmed" };
  }
  if (ack.ok === true) return { ok: true, error: null, kind: "ok" };
  const msg = typeof ack.error === "string" && ack.error ? ack.error
    : typeof ack.err === "string" && ack.err ? ack.err : null;
  return { ok: false, error: msg ?? "命令被拒绝", kind: "rejected" };
}

// 旧 relay 未知命令错误三签名（ws 白名单拒发 "invalid command shape" / 旧
// handleCommand default "unsupported command" / org 咽喉 "unsupported org action: x"）。
// 命中 = 该源 relay 版本没有这条命令（非暂时性故障）→ 能力位记忆，静默降级防弹窗轰炸
export function unknownCommandError(err: unknown): boolean {
  return typeof err === "string" && /invalid command shape|^unsupported command|unsupported org action/.test(err);
}

export type CmdCaps = Record<string, boolean>;
// 能力位记忆（纯对象进出）：未知命令错误后记住「此源不再发该命令」
export function cmdCapRemember(caps: unknown, cmd: string): CmdCaps {
  const next: CmdCaps = { ...((caps && typeof caps === "object" ? caps : {}) as CmdCaps) };
  next[cmd] = false;
  return next;
}
export function cmdCapBlocked(caps: unknown, cmd: string): boolean {
  return !!(caps && typeof caps === "object" && (caps as CmdCaps)[cmd] === false);
}
// 恢复条件：①relay 身份变更（同一连接换指另一台 relay 实例）②快照 schema_version>=1
//（relay 升级新命令面上线）。旧 relay 恒 legacy（version 0）→ 记忆稳定不被快照冲掉
export function cmdCapRecoverOnSnapshot(caps: unknown, snapshotLike: unknown, identityChanged: boolean): CmdCaps {
  const p = (snapshotLike && typeof snapshotLike === "object" ? snapshotLike : {}) as Record<string, unknown>;
  const v = typeof p.schema_version === "number" && Number.isFinite(p.schema_version) ? p.schema_version : 0;
  if (identityChanged !== true && v < 1) return (caps && typeof caps === "object" ? caps : {}) as CmdCaps;
  return {};
}

// 双击闸：飞行中同键再点 → skip（expo/W1b 同语义同 fixture，不共享代码）
export function ackTapGuard(inFlight: Set<string> | null | undefined, flightKey: string): "go" | "skip" {
  return inFlight && inFlight.has(flightKey) ? "skip" : "go";
}
// 组织确认复合飞行键：confirm_id 是源域命名空间，跨源可能撞名
export function orgFlightKey(srcId: string, confirmId: string): string {
  return String(srcId) + "/" + String(confirmId);
}

// 组织确认 payload 组装（relay 咽喉 confirm-decide：approve 必须真布尔——
// `payload.approve === true` 严格判，字符串 "1"/数字 1 会判否决）；confirm_id 空串/null 拒发
export function orgConfirmPayload(confirmId: unknown, approve: unknown): { confirm_id: string; approve: boolean } | null {
  if (typeof confirmId !== "string" || !confirmId.trim()) return null;
  return { confirm_id: confirmId, approve: approve === true };
}
