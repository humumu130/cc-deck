// W-SPLIT-S2（design-split-plan §3 阶段 2 ③）：快照日志预算装配外迁。
// 只搬不改：算法体逐字未动——class 方法改模块导出函数，this.sessions 改显式参数
// （唯一 this 依赖）。四预算常量随迁。#70 两级保护语义见函数内注释（原样保留）。
import type { LogEntry } from "./types.js";

export const SNAPSHOT_LOGS_BUDGET_BYTES = 512 * 1024;
export const SNAPSHOT_LOGS_PER_SESSION = 50;
export const SNAPSHOT_LOGS_BUDGET_BYTES_LAN = 4 * 1024 * 1024;
export const SNAPSHOT_LOGS_PER_SESSION_LAN = 1200;

export function buildSnapshotLogs(
    sessions: Map<string, { logs: LogEntry[] }>,
  budgetBytes: number = SNAPSHOT_LOGS_BUDGET_BYTES,
  perSessionCap: number = SNAPSHOT_LOGS_PER_SESSION,
  ): { logs: Record<string, LogEntry[]>; logs_truncated: Record<string, number> } {
    // 消息类条目判定（与客户端「消息」视图的 kind 口径一致）
    const isMsg = (e: LogEntry): boolean => e.kind === "user_message" || e.kind === "assistant_text";
    const logs: Record<string, LogEntry[]> = {};
    const logsTruncated: Record<string, number> = {};
    // 每条字节量先算一次，预算裁剪纯算术推进，不反复整体序列化
    const kept: { id: string; entries: { e: LogEntry; b: number }[] }[] = [];
    let total = 0;
    for (const [id, s] of sessions) {
      // 取证窗口 2×cap：长会话（内存上限 500 条）里消息稀疏，窗口不放宽的话
      // 保护逻辑根本采不到窗口外的正文
      const wide = s.logs.length > perSessionCap * 2 ? s.logs.slice(s.logs.length - perSessionCap * 2) : s.logs;
      let pick: LogEntry[];
      if (wide.length <= perSessionCap) {
        pick = wide;
      } else {
        const msgIdx = wide.reduce<number[]>((acc, e, i) => (isMsg(e) ? (acc.push(i), acc) : acc), []);
        // 消息全保（极端刷屏超 cap 时仍裁最旧的消息），剩余名额给最新的非消息条目
        const keepMsg = msgIdx.length > perSessionCap ? new Set(msgIdx.slice(msgIdx.length - perSessionCap)) : new Set(msgIdx);
        const restIdx = wide.map((_, i) => i).filter((i) => !keepMsg.has(i));
        const room = Math.max(0, perSessionCap - keepMsg.size);
        const keepRest = new Set(restIdx.slice(Math.max(0, restIdx.length - room)));
        pick = wide.filter((_, i) => keepMsg.has(i) || keepRest.has(i));
      }
      if (pick.length < s.logs.length) logsTruncated[id] = s.logs.length - pick.length;
      const entries = pick.map((e) => ({ e, b: Buffer.byteLength(JSON.stringify(e)) + 1 }));
      if (entries.length) {
        kept.push({ id, entries });
        total += entries.reduce((acc, x) => acc + x.b, 0);
      }
    }
    while (total > budgetBytes) {
      // 条目最多的会话先裁：活跃会话（条目已被 K 帽截到同量级）相对公平；
      // 会话内先丢最旧的非消息条目，全是消息才丢最旧一条消息（保底 1 条不变）
      let big: (typeof kept)[number] | null = null;
      for (const k of kept) if (k.entries.length > 1 && (!big || k.entries.length > big.entries.length)) big = k;
      if (!big) break; // 每会话只剩 1 条：物理下限（MAX_SESSIONS 条单条日志远小于预算）
      let dropAt = big.entries.findIndex((x) => !isMsg(x.e));
      if (dropAt < 0) dropAt = 0;
      const dropped = big.entries.splice(dropAt, 1)[0];
      if (!dropped) break;
      total -= dropped.b;
      logsTruncated[big.id] = (logsTruncated[big.id] ?? 0) + 1;
    }
    for (const k of kept) logs[k.id] = k.entries.map((x) => x.e);
    return { logs, logs_truncated: logsTruncated };
  }
