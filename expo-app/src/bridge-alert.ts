// P0-3（DEV-43）桥直推告警帧解析——纯函数（无 react-native import，node 直测面可导）。
// 云桥 POST /alert 注入的明文帧 {type:"bridge_alert",title,body,level,ts}：relay/壳
// 全死时这是唯一触达腿（哨兵/wakeup 外发 → 桥 → 本帧）。store.ts 云帧环在 unseal
// 之前识别本帧并弹系统通知——「与面板无关的推送」的产品验收口径。
export interface BridgeAlert {
  title: string;
  body: string;
  level: string;
}

/** 识别+归一桥直推帧；非本形态返回 null（调用方按原流程继续）。 */
export function parseBridgeAlert(frame: unknown): BridgeAlert | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as { type?: unknown; title?: unknown; body?: unknown; level?: unknown };
  if (f.type !== "bridge_alert") return null;
  const title = typeof f.title === "string" ? f.title.trim() : "";
  const body = typeof f.body === "string" ? f.body.trim() : "";
  if (!title || !body) return null;
  return { title: title.slice(0, 120), body: body.slice(0, 500), level: typeof f.level === "string" ? f.level.slice(0, 16) : "warn" };
}
