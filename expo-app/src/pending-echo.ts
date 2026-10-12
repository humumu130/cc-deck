// 发送乐观回显纯函数（W-EXPODOMAIN 件五，用户实测痛点：手机发出后消息立刻消失、
// ~5s 后才在排队区出现——发送端自己看不到，以为消息丢了）。
// 机制：composer 发送瞬间本地注入 pending 气泡（同步 setState = 「发送→0.5s 内本地
// 可见」的判定面），随后三路对账收敛：
//   ① relay 广播回声（SESSION_LOG user_message）到达 → 气泡替换为正式转录行（删除）
//   ② 会话忙 → pending_inputs 出现同文本 → 气泡转「已排队」态（保持可见，不丢）
//   ③ ack 失败/未确认（4s 重发+6s 收摊）→ 气泡转「失败」态（点按重发）
// 兜底：STALE_MS 上限自动清（防 relay 永不回声的挂起气泡）。零依赖纯 TS——
// scripts/test-expodomain.ts 直跑断言共用同一条路径（测的就是跑的）。
import type { LogEntry, PendingInput } from "./protocol";

export type PendingEchoState = "sending" | "queued" | "failed";

export interface PendingEcho {
  /** 稳定键（uuid）——失败重发/逐条删除的句柄 */
  key: string;
  sid: string;
  text: string;
  ts: number;
  state: PendingEchoState;
}

/** 乐观注入上限（连发刷屏保护：超限丢最旧——气泡是临时态，正式转录才是事实源） */
export const ECHO_CAP = 20;
/** 无回声自动清理上限（ack ok 后 echo 迟到/丢失的安全阀） */
export const ECHO_STALE_MS = 120_000;
/** 回声时间窗容差（端云时钟偏移 + 排队后处理延迟：回声 occurred_at 可能早于发送时刻） */
const ECHO_SKEW_MS = 10_000;

/** 发送瞬间同步注入（0.5s 内本地可见的入口——纯同步无异步竞态） */
export function pushPending(list: PendingEcho[], entry: PendingEcho): PendingEcho[] {
  const next = [...list, entry];
  return next.length > ECHO_CAP ? next.slice(next.length - ECHO_CAP) : next;
}

/** 逐条改态（失败标记；键不存在=已被对账收走，幂等 no-op） */
export function markEchoState(list: PendingEcho[], key: string, state: PendingEchoState): PendingEcho[] {
  if (!list.some((p) => p.key === key && p.state !== state)) return list;
  return list.map((p) => (p.key === key ? { ...p, state } : p));
}

const norm = (t: string) => t.trim().replace(/\s+/g, " ");

export interface ReconcileInput {
  sid: string;
  /** 本会话当前转录（msg 视图口径的 logs 全量也行——按 kind 过滤在本函数内做） */
  logs: LogEntry[];
  /** 会话 pending_inputs（忙时排队表；null/undefined = 未排队） */
  pendingInputs?: PendingInput[] | null;
  now: number;
}

/**
 * 对账收敛（每渲染相关变化跑一次，纯函数进出）：
 * - 回声匹配：user_message 文本相等（空白归一）且时间 ≥ 发送时刻-容差 → 按同文本
 *   回声数消耗最旧的等文本气泡（连发同文案多次不误删新条）
 * - 排队匹配：pending_inputs 有同文本 → 气泡转 queued（可见性保持）
 * - 过期清理：STALE_MS 上限 → 丢弃（安全阀，防永久挂起）
 */
export function reconcilePending(list: PendingEcho[], input: ReconcileInput): PendingEcho[] {
  if (!list.length) return list;
  const mine = list.filter((p) => p.sid === input.sid);
  if (!mine.length) return list;
  const echoes = input.logs.filter(
    (e) => e.kind === "user_message" && !!e.ts && norm(e.text ?? "") !== "",
  );
  const echoCount = new Map<string, number>();
  for (const p of mine) {
    const key = norm(p.text);
    if (!key || echoCount.has(key)) continue;
    echoCount.set(
      key,
      echoes.filter((e) => norm(e.text ?? "") === key && e.ts >= p.ts - ECHO_SKEW_MS).length,
    );
  }
  const queuedKeys = new Set((input.pendingInputs ?? []).map((p) => norm(p.text ?? "")).filter(Boolean));
  const eaten = new Map<string, number>(); // 同文本回声消耗计数（FIFO：旧条先消）
  const out: PendingEcho[] = [];
  let changed = false;
  for (const p of mine) {
    const key = norm(p.text);
    const want = echoCount.get(key) ?? 0;
    const used = eaten.get(key) ?? 0;
    if (key && used < want) {
      eaten.set(key, used + 1);
      changed = true;
      continue; // 回声已落转录——pending 气融掉
    }
    if (input.now - p.ts > ECHO_STALE_MS) {
      changed = true;
      continue; // 安全阀
    }
    if (key && queuedKeys.has(key)) {
      if (p.state !== "queued") changed = true;
      out.push({ ...p, state: "queued" });
      continue;
    }
    if (p.state === "queued") {
      // 排队已被 CLI 消费（pending_inputs 移除）但转录回声未到——回 sending 态等回声
      changed = true;
      out.push({ ...p, state: "sending" });
      continue;
    }
    out.push(p);
  }
  if (!changed && out.length === mine.length) return list;
  // 其他会话的条目原样保留（DetailScreen 跨会话常驻，键控隔离）
  return [...list.filter((p) => p.sid !== input.sid), ...out];
}
