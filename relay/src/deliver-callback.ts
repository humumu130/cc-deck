// W-DELIVERCB（用户 1102 晚拍板）：沃克交付 Callback 去重账——「同一 dispatch 只投一次」
// 的单源。三线机制（hook 自报 / relay 观测 / 轮询兜底）在此收敛：线一线二都会写账，
// 先到者投递、后到者跳过（审计行留痕）；线三（轮询）不写账只消费通知面。
//
// 物理布局：<orgDir>/deliver-callbacks.ndjson append-only（fs-safe appendJournal 5MB 滚动
// ——dispatch-log/retired-entries 同范式）。行形状：
//   { ts, dispatch_id, session_id, via: "relay-observe" | "stop-hook", target, skipped?: string }
// skipped 行=判定后未投（no-pm-target 等）——同样占坑防重试风暴，审计可分辨。
//
// 纯 fs 模块（org.ts 同纪律）：不 import session-manager/EventBus（无环）、不走 EventBus
// 持久化路径、坏行容忍跳过。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir } from "./org.js";
import { appendJournal } from "./fs-safe.js";

export type DeliverCallbackVia = "relay-observe" | "stop-hook";

export interface DeliverCallbackRow {
  ts: number;
  dispatch_id: string;
  session_id: string;
  via: DeliverCallbackVia;
  target?: string;
  /** 未投原因（no-pm-target / dedup-win 等）——占坑防重试，审计分辨投/未投 */
  skipped?: string;
  /** W-DELIVERCB R2（B 审格①）：投递落点状态——true=已注入 PM 会话；false=占坑时 PM
   * 卡不在场（重挂即补扫，见 flushUndeliveredCallbacks）。缺省（旧行/已投）视为已投 */
  delivered?: boolean;
  /** 派单档（主投递行携带——PM 上线补扫聚合行文案消费） */
  tier?: string;
}

const FILE = "deliver-callbacks.ndjson";

export function deliverCallbackLogPath(dir?: string): string {
  return join(dir ?? orgDir(), FILE);
}

/** 记账（投递成功与 skip 占坑同口——一次判定终身有效，防轮询/双线重试风暴） */
export function appendDeliverCallback(row: DeliverCallbackRow, dir?: string): void {
  try {
    appendJournal(deliverCallbackLogPath(dir), { ...row });
  } catch { /* 记账失败不阻断投递主路径（最坏=双投一次，通知 stableKey 幂等兜底） */ }
}

/** 该 dispatch 是否已有 Callback 判定行（投或 skip 皆算——「只投一次」语义含 skip 占坑） */
export function deliverCallbackSeen(dispatchId: string, dir?: string): false | DeliverCallbackRow {
  try {
    const raw = readFileSync(deliverCallbackLogPath(dir), "utf-8");
    let hit: DeliverCallbackRow | null = null;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as DeliverCallbackRow;
        if (row && row.dispatch_id === dispatchId) hit = row; // 末行赢（append-only）
      } catch { /* 坏行跳过 */ }
    }
    return hit ?? false;
  } catch {
    return false; // 无文件=从未投
  }
}

/** 交付直达 prompt 文案（线一线二共用——已交付+回执路径+收割指引） */
export function buildDeliverCallbackPrompt(input: {
  dispatchId: string;
  tier: string;
  receiptPath?: string;
  receipt: string;
  via: DeliverCallbackVia;
}): string {
  const short = input.dispatchId.slice(0, 8);
  const path = input.receiptPath && String(input.receiptPath).trim() ? String(input.receiptPath).trim() : "（任务书未约定回执路径——按 slug 查 ~/.cc-deck/artifacts/）";
  return [
    `[worker 已交付] ${input.tier}单 ${short} · 回执 ${path}`,
    `回执摘要：${input.receipt.slice(0, 160)}`,
    `来源：${input.via === "stop-hook" ? "Stop 钩子自报（收工即报）" : "relay 观测（收口判定 done）"}——请收割核验（leader-harvest <slug>）或派发后续。`,
  ].join("\n");
}

/** W-DELIVERCB R2（丢注入①：PM 上线边补扫）——未投递占坑行读口：末行赢口径下，
 * dispatch 的最终状态=该 id 最后一条行；delivered===false 即「判定占坑但 PM 未收到」。
 * 返回按 ts 升序（补扫聚合注入保持时序）。 */
export function undeliveredCallbacks(maxAgeMs = 24 * 3600_000, dir?: string): DeliverCallbackRow[] {
  try {
    const raw = readFileSync(deliverCallbackLogPath(dir), "utf-8");
    const last = new Map<string, DeliverCallbackRow>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as DeliverCallbackRow;
        if (row && row.dispatch_id) last.set(row.dispatch_id, row); // 末行赢
      } catch { /* 坏行跳过 */ }
    }
    const now = Date.now();
    return [...last.values()]
      .filter((r) => r.delivered === false && !r.skipped && now - r.ts <= maxAgeMs)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}
