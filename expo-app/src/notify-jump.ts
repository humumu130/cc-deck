// M13-6E 通知 resolved 分离 + 验收链接回跳纯函数（expo 域）。
// 零依赖纯 TS（不 import react/react-native）——NotifCenterModal（ListScreen.tsx）
// 消费 + scripts/test-notify-resolved.ts 直跑断言共用同一条判定路径（M13-4 的
// org-delta.ts 同范式：测的就是跑的）。
//
// 规格①（与 M13-6W web 同构）：通知动作不清零 resolved——动作后行不消失（池只读
// 不清零 B3a 口径已在 ListScreen 承载），本模块提供 done 判定 + 处理时刻提取 +
// main/resolved 分区（「已处理 N」折叠归档）。
// 规格②：验收链接回原 task/group——通知点击 → sourceContext 归因映射定位原 task
// 卡 → 导航聚焦；归因缺失 = null 降级（不跳不报错不假造）。零协议改动：只消费
// protocol.ts:55-67 NotificationItem 既有七字段。
//
// 归因映射（与 M13-6W web 端 notifJumpTarget 同构镜像，「验收链接」=派单通知携带
// 的验收单链接，M12-7 板卡级归因映射）：
// - dispatch 域（entityId=dispatch_id）→ 本地板缓存反查 dispatch_id → task 落点
//   （gid+entryId）→ 组详情定位台账卡。数据面=SourceStatus.boards（M13-6E 透出，
//   与 web ctx.boards 同构；M13-4 锚定纪律语义，反查只出线索、呈现以 orgDetail
//   现拉全量为准）；
// - 降级链：sessionId → 同源会话表命中 → session 落点（web「解析失败=保持原会话
//   跳转」同款）；
// - web 端 org 域（entityId=confirm_id → 确认卡 flash）落点：expo OrgZone 无定位
//   机制，v1 不落（org 域走 session 降级）——偏差备案于回单。

// ---------- 未决行动项（E2b 口径，自 ListScreen.tsx 迁入原样） ----------

// 可行动项（badge 计数/「知道了」按钮位口径）：actionable===true 且 resolved_at/
// handled_at/dismissed_at 全空且 key 为字符串。池非数组/条目畸形一律安全空——
// 不清零不伪造（通知不清零的收缩面只由权威账驱动）
export function notifActionableOf(items: unknown): { key: string }[] {
  if (!Array.isArray(items)) return [];
  return items.filter((n): n is { key: string } => {
    if (!n || typeof n !== "object") return false;
    const o = n as Record<string, unknown>;
    return o.actionable === true && o.resolved_at == null && o.handled_at == null
      && o.dismissed_at == null && typeof o.key === "string";
  });
}

// ---------- 规格①：done 判定 + 处理时刻 + 分区 ----------

// 已处理（收口）判定 + 处理时刻：resolved_at/handled_at/dismissed_at 任一非空 =
// 已收口（relay decision-notify.ts isHandled 同款三戳口径；dismissed 时 relay 双填
// dismissed_at+handled_at，乐观账 ackNotification 同构）。时刻取值优先序
// resolved_at > handled_at > dismissed_at（生命周期结束时刻：权威收口 > 动作 >
// 忽略落账）。全空/条目畸形 = null（未处理）。
export function notifDoneAt(item: unknown): number | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  for (const k of ["resolved_at", "handled_at", "dismissed_at"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// main/resolved 两分区：done 行（notifDoneAt 非 null）拆入 resolved 区，其余留
// main 区（含非 actionable 未处理的只读通知——现状平铺流灰显语义不变）。两区各保
// 池序不重排（防行跳位；排序属呈现面自由度，web 端对表时不锁序）。分区函数不丢行：
// main ∪ resolved = rows 全集。
export function splitResolvedRows<T>(rows: T[], doneAt: (item: T) => number | null): { main: T[]; resolved: T[] } {
  const main: T[] = [];
  const resolved: T[] = [];
  for (const r of rows) (doneAt(r) === null ? main : resolved).push(r);
  return { main, resolved };
}

// ---------- 规格②：验收链接回跳判定（与 M13-6W web 端 notifJumpTarget 同构镜像） ----------

// 回跳目标（与 web 端两落点对齐）：
// - task：dispatch 域通知（entityId=dispatch_id）经本地板缓存反查（M12-7 板卡级归因
//   映射，BOARD_UPDATED 广播面自然积累）→ gid+entryId → 组详情定位台账卡
// - session：降级/兜底落点（sourceContext.sessionId 归因原会话——web 端「解析失败=
//   保持原会话跳转交互」同款）
// web 端另有 org 域（entityId=confirm_id → 确认卡 flash 聚焦）落点：expo 的 OrgZone
// 无滚动定位/闪烁机制，v1 不落该分支（归因在册也无呈现面）——org 域通知走 session
// 降级，偏差备案于回单。
export type NotifJumpTarget =
  | { type: "task"; gid: string; entryId: string }
  | { type: "session"; sid: string };

// 回跳判定（web 端 notifJumpTarget + 原会话降级链同构，零协议改动纯消费）：
// ① dispatch 域归因优先：sourceContext.domain === "dispatch" 且 entityId 为非空串 →
//    扫 boards（gid → board）反查 entry.dispatch_id === entityId → task 落点
//    （扫不中=归因未回写或板缓存未同步 → 落降级链，与 web「板缓存无此卡=null」同款）
// ② 降级链：sourceContext.sessionId 命中同源会话表 → session 落点。同源约束：sessions
//    条目 src 字段有值时须与 srcId 相等（聚合模式跨源主键防串扰）；src 缺失 = 单源
//    模式 watch 网关直发（协议注释：单源不写 src），视为本源命中
// ③ 其余一律 null（不跳不报错不假造）。输入畸形安全 null 不炸。
export function jumpTargetOf(
  item: unknown,
  ctx: { sessions?: unknown; srcId?: unknown; boards?: unknown },
): NotifJumpTarget | null {
  if (!item || typeof item !== "object" || !ctx || typeof ctx !== "object") return null;
  const sc = (item as Record<string, unknown>).sourceContext;
  if (!sc || typeof sc !== "object") return null;
  const s = sc as Record<string, unknown>;
  const srcId = typeof ctx.srcId === "string" ? ctx.srcId : "";
  // ① dispatch 域板卡反查（验收链接=派单通知携带的验收单链接，M12-7 归因映射）
  if (s.domain === "dispatch" && typeof s.entityId === "string" && s.entityId) {
    if (ctx.boards && typeof ctx.boards === "object") {
      for (const [gid, board] of Object.entries(ctx.boards as Record<string, unknown>)) {
        const entries = (board as { entries?: unknown } | null)?.entries;
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (!e || typeof e !== "object") continue;
          const eo = e as Record<string, unknown>;
          if (eo.dispatch_id === s.entityId && typeof eo.id === "string" && eo.id && typeof gid === "string" && gid) {
            return { type: "task", gid, entryId: eo.id };
          }
        }
      }
    }
    // 反查不中不 return——落降级链（web 同款：dispatch 域 null 后仍有原会话兜底）
  }
  // ② 降级链：sessionId 归因原会话
  const sid = s.sessionId;
  if (typeof sid !== "string" || !sid) return null;
  if (!Array.isArray(ctx.sessions)) return null;
  for (const sess of ctx.sessions) {
    if (!sess || typeof sess !== "object") continue;
    const o = sess as Record<string, unknown>;
    if (o.session_id !== sid) continue;
    if (typeof o.src === "string" && srcId && o.src !== srcId) continue; // 跨源不串扰
    return { type: "session", sid };
  }
  return null; // 会话不在（已清场/跨源视图过滤）——降级
}
