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

// ---------- domstep1（域图 Report 六态·§三第一步）：回执状态枚举位 ----------
// DS 域概念 #7：Report 六态 progress/waiting/ready/blocked/failed/dropped——「从自由
// 文本推断等待人」被 DS 001 明文拒绝，我们正踩着（「等用户」散在回执文本里）。第一步
// 纯记账：deliver-callbacks 行加 report_status 枚举；waiting 只认结构化卡
// （waiting_request/组织确认——confirm_ref 记卡引用），散文本 waiting 记 progress+
// 备注缺卡。读侧宽容（旧行无字段照旧解析，零迁移）。
export type ReportStatus = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

/** 回执六态分类单点（结构化优先）：waitingCard 在场=waiting（卡引用随行，文本让位）；
 *  散文本 waiting 无卡=progress+备注（不认 waiting——反恒真面的根）；blocked/失败按
 *  文本/终态词识别；缺省 ready（交付回调边=已交付待收割）。
 *  domstep1r1（P2-A③ 审 A 3b）：failed 原生产无源（classify 调用点不传 dispatchFailed）
 *  且无失败词——「任务失败：无法修复」类回执误落 ready（第二/三步读侧会拿 ready 当
 *  可收割凭据，错误的枚举比缺枚举更伤）。补窄失败词识别（任务失败/无法完成/行首
 *  「失败：」——刻意窄防「0 failed tests/失败分析文档已交付」误伤）；结构化源
 *  dispatchFailed 仍最高优，收口判 failed 的修正行见 amendFailedReport。 */
export function classifyReportStatus(input: { receipt: string; waitingCardRef?: string | null; dispatchFailed?: boolean }): { status: ReportStatus; note?: string; confirm_ref?: string } {
  if (input.dispatchFailed) return { status: "failed" };
  if (input.waitingCardRef) return { status: "waiting", confirm_ref: input.waitingCardRef }; // 结构化卡压倒文本——即使回执没写等待字样
  const t = input.receipt || "";
  if (/已放弃|放弃处理|dropped/.test(t)) return { status: "dropped" };
  if (/阻塞|blocked/i.test(t)) return { status: "blocked" };
  if (/任务失败|执行失败|无法完成|无法修复|无法继续|(?:^|\n)\s*(?:失败|failed)[:：]/i.test(t)) return { status: "failed", note: "失败词识别（窄词表——结构化源缺位时的文本兜底）" };
  if (/等待|waiting|待确认|待回答|待验收/.test(t)) return { status: "progress", note: "waiting 无结构化确认卡（散文本不认——域图 Report 六态口径）" };
  return { status: "ready" };
}

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
  /** domstep1：回执六态枚举位（classifyReportStatus 单点分类；旧行缺省=未分类，读侧
   *  宽容不降级——零迁移） */
  report_status?: ReportStatus;
  /** 六态备注（如「waiting 无结构化确认卡」——散文本不认的留痕） */
  report_note?: string;
  /** waiting 态的结构化卡引用（wait-card:<tool> 或 confirm:<id8>——验收对账键） */
  confirm_ref?: string;
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

/** domstep1r1（P2-A③ 审 A 3b）：failed 六态修正行单点——收口判 failed 时对已有交付
 *  回执行补记 failed（deliverCallbackSeen 末行赢口径：读侧随后即见 failed）。修「failed
 *  生产无源+失败回执误分 ready」：stop-hook 先投形态（收工即报先落 ready/progress，
 *  随后零产出闸判 failed）此前无任何路径改写六态。原始行的投递位（delivered/skipped/
 *  target/tier/confirm_ref）原样携带——补扫面（undeliveredCallbacks 末行 delivered
 *  判定）不被修正行洗掉。无既有行/已 failed=no-op（无回执的单不造行、不重复修正）。 */
export function amendFailedReport(dispatchId: string, dir?: string): boolean {
  const seen = deliverCallbackSeen(dispatchId, dir);
  if (!seen || seen.report_status === "failed") return false;
  appendDeliverCallback({
    ts: Date.now(),
    dispatch_id: dispatchId,
    session_id: seen.session_id,
    via: seen.via,
    ...(seen.target ? { target: seen.target } : {}),
    ...(seen.skipped ? { skipped: seen.skipped } : {}),
    ...(seen.delivered === false ? { delivered: false } : {}),
    ...(seen.tier ? { tier: seen.tier } : {}),
    report_status: "failed",
    report_note: "收口判 failed（dispatchFailed 结构化源）——修正先行回执行六态",
    ...(seen.confirm_ref ? { confirm_ref: seen.confirm_ref } : {}),
  }, dir);
  return true;
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
