// W-SPLIT-S2（design-split-plan §3 阶段 2 ①）：决策通知账投影外迁。
// 只搬不改：排序投影纯函数逐字未动——this.notifications 改显式 Iterable 参数
// （消费面 wrapper 传 this.notifications.values()）。projectNotifications 留核
// （双 this 字段+bus 写面，非纯只读域——域稿 1.2 表「低 this 依赖」判定为仅投影段）。
import type { NotificationItem } from "./types.js";

export function notificationsListOf(items: Iterable<NotificationItem>): NotificationItem[] {
    return [...items]
      .sort((a, b) => a.created_at - b.created_at || (a.key < b.key ? -1 : 1));
  }
