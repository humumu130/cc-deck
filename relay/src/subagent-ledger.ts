// W-PMRESOURCE-V1（#106 编排资源调派模型·件1）：PM 子代理任务轻账——「PM 发过哪些
// 子代理任务、结论在哪」的单源（现状：结论散盘 artifacts 无人知、父进程死任务蒸发）。
//
// 定性（调研 w-pmresource.md）：子代理任务（PM 会话内 spawn 的调研/审查）此前是进程
// 私产，不是编排系统的资源对象。本账给它产品身份的**最小面**：append-only 台账一行
// 一态（register/done/fail 同 id 末行收敛——dispatch-log 读侧同款），不进 dispatch
// 台账一族（冻结状态机/S3 锚锁/trigger_key/tier 词表四不沾——调研 Q1 定案）。
//
// 物理布局：<dataDir>/subagent-log.ndjson append-only（fs-safe appendJournal 5MB 滚动
// ——events.ndjson/cli-pids.json 同目录；命名对齐既有 *-log 账族）。纯 fs 模块
//（org.ts 同纪律）：不 import session-manager/EventBus（无环）、坏行容忍跳过。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJournal } from "./fs-safe.js";

export type SubagentKind = "research" | "review" | "analyze" | "other";
export type SubagentStatus = "running" | "done" | "failed" | "pending_dispose";

export const SUBAGENT_KINDS: readonly SubagentKind[] = ["research", "review", "analyze", "other"];

/** V1 行形状（任务书定档）：id/kind/title/parent_sid/artifact_path?/summary?/status/
 *  registered_at/done_at?；append 行自带 ts。gid 为可选归属（在则 done 边可回流该组
 *  lesson——件5 门控三条件之一）。 */
export interface SubagentRow {
  ts: number;
  id: string;
  kind: SubagentKind;
  title: string;
  /** 发起会话（PM 席 sid——孤儿判定锚：parent 不在活会话即断档候选） */
  parent_sid: string;
  status: SubagentStatus;
  registered_at: number;
  done_at?: number;
  /** 结论产物落盘路径（artifacts 纪律——账即索引的核心字段） */
  artifact_path?: string;
  /** 一句话结论（done 必带语义上；无产物也落「无结论」——本身是结论） */
  summary?: string;
  /** 归属项目组（可选——在则 done 回流 lesson） */
  gid?: string;
  /** fail 原因 / pending_dispose 时的断档说明 */
  reason?: string;
}

export function subagentLogPath(dataDir: string): string {
  return join(dataDir, "subagent-log.ndjson");
}

/** 追加一行（append-only；同 id 生命周期=多行，读侧末行收敛）。 */
export function appendSubagentRow(row: SubagentRow, dataDir: string): void {
  appendJournal(subagentLogPath(dataDir), { ...row });
}

/** 全量行（原始逐行——审计/调试面）；坏行容忍跳过。 */
export function readSubagentRowsRaw(dataDir: string): SubagentRow[] {
  try {
    const raw = readFileSync(subagentLogPath(dataDir), "utf-8");
    const out: SubagentRow[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t) as Partial<SubagentRow>;
        if (j && typeof j.id === "string" && typeof j.status === "string" && typeof j.ts === "number") {
          out.push(j as SubagentRow);
        }
      } catch { /* 坏行跳过（appendJournal 家族纪律） */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 末行收敛读（readDispatchLog 同款语义：同 id 多行，末行赢=当前态）。 */
export function readSubagentLedger(dataDir: string): SubagentRow[] {
  const byId = new Map<string, SubagentRow>();
  for (const r of readSubagentRowsRaw(dataDir)) byId.set(r.id, r); // 后行覆盖前行=末行赢
  return [...byId.values()];
}

/** 当前在途数（running 态——并发帽消费面，leader-subagent 工具）。 */
export function countRunningSubagents(dataDir: string): number {
  return readSubagentLedger(dataDir).filter((r) => r.status === "running").length;
}

export interface OrphanCandidate {
  row: SubagentRow;
  /** 距 register 的毫秒数（超阈证据） */
  ageMs: number;
}

/** 孤儿扫描纯函数（件3 消费面）：registered 无 done 且超阈（status=running）的行。
 *  pending_dispose 不重复扫出（处置卡已推——幂等由调用侧 appendSubagentRow
 *  pending_dispose 行闭环，本函数只做无态判定）。阈值缺省 10 分钟
 *  （CCR_SUBAGENT_ORPHAN_MS 可调——分钟级调研任务的断档判定窗）。 */
export function scanOrphanSubagents(dataDir: string, now: number, thresholdMs = Number(process.env.CCR_SUBAGENT_ORPHAN_MS) > 0 ? Number(process.env.CCR_SUBAGENT_ORPHAN_MS) : 10 * 60_000): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const r of readSubagentLedger(dataDir)) {
    if (r.status !== "running") continue;
    const ageMs = now - r.registered_at;
    if (ageMs >= thresholdMs) out.push({ row: r, ageMs });
  }
  return out;
}

/** 断档处置标记（件3：处置卡已推的幂等位——append pending_dispose 行，后续扫描跳过）。 */
export function markPendingDispose(id: string, dataDir: string, note: string): SubagentRow | null {
  const cur = readSubagentLedger(dataDir).find((r) => r.id === id);
  if (!cur || cur.status !== "running") return null; // 已收口/已标记——幂等不动
  const row: SubagentRow = { ...cur, ts: Date.now(), status: "pending_dispose", reason: note };
  appendSubagentRow(row, dataDir);
  return row;
}

/** done 边 lesson 回流门控（件5 单点）：kind∈{research,review} 且 summary 非空 且 gid
 *  在场——analyze 类中间步骤不进记忆（防垃圾账）；无归属组不回流（账行已带索引字段）。 */
export function shouldLessonBackfill(row: SubagentRow): boolean {
  return (row.kind === "research" || row.kind === "review") && typeof row.summary === "string" && row.summary.trim().length > 0 && typeof row.gid === "string" && row.gid.length > 0;
}
