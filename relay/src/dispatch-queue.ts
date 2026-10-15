// P0 编制上限配套（2026-10-15 用户实锤「编制膨胀」）——派单排队底座。
// 语义：编制触顶（泛 worker 达 headcountCapOf）且组内无 idle worker 可复用时，新派单
// 不新建（不自动扩编）转排队；组内出现空闲名额（worker 回合收口/成员除名）时按 FIFO
// 接续派发。持久化 <orgDir>/dispatch-queue.json——relay 重启队列不丢（台账 "queued"
// 行只承载审计视图，重启断档补记 closeHungDispatchRows 白名单 running|dispatched
// 天然不碰 queued 行，两套账各管各的）。
// 本模块纯 fs 读写底座，projects.ts/routing.ts 同范式：坏 JSON 容忍为空态（读侧防御，
// 绝不抛）、写穿全量、不 import session-manager（无环）。drain 编排（重派/收口联动）
// 在 session-manager——本文件只管队列这份事实源。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir } from "./org.js";

/** 排队单条目：input 原样保存（dispatchWorker 入参），drain 时带 queue_replay 原单 id
 * 重入 dispatchWorker（台账同 id 收敛：queued → dispatched/failed，读侧末行赢）。 */
export interface QueuedDispatch {
  dispatch_id: string;
  enqueued_at: number;
  /** dispatchWorker 入参快照（gid/prompt/title/skills/role/engine/...原样） */
  input: Record<string, unknown>;
}

interface QueueFile {
  items: QueuedDispatch[];
}

function queuePath(dir?: string): string {
  return join(dir ?? orgDir(), "dispatch-queue.json");
}

export function loadDispatchQueue(dir?: string): QueuedDispatch[] {
  try {
    const raw = JSON.parse(readFileSync(queuePath(dir), "utf-8")) as Partial<QueueFile>;
    return Array.isArray(raw.items) ? (raw.items as QueuedDispatch[]) : [];
  } catch {
    return []; // 无文件/坏 JSON：空态（读侧防御，写穿全量会把下一笔落盘修复回来）
  }
}

export function saveDispatchQueue(items: QueuedDispatch[], dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(queuePath(d), JSON.stringify({ items }, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[dispatch-queue] 写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 入队（FIFO 尾插）。上限护栏 200：防病态堆积（触顶全忙长期不解时给人看的问题，
 * 不是无限蓄水池）；超限拒收由调用方转 failed 收口。 */
export const DISPATCH_QUEUE_MAX = 200;

export function enqueueDispatch(item: QueuedDispatch, dir?: string): { ok: true; items: QueuedDispatch[] } | { ok: false; error: string } {
  const items = loadDispatchQueue(dir);
  if (items.length >= DISPATCH_QUEUE_MAX) {
    return { ok: false, error: `派单队列已满（${DISPATCH_QUEUE_MAX}）——编制触顶且长期全忙，请先清理编制或调 headcount_cap` };
  }
  items.push(item);
  return saveDispatchQueue(items, dir) ? { ok: true, items } : { ok: false, error: "队列写入失败" };
}

/** 出队：移除指定 dispatch_id（drain 成功/失败收口后调）。返回移除后的全量（写穿）。 */
export function dequeueDispatch(dispatchId: string, dir?: string): QueuedDispatch[] {
  const items = loadDispatchQueue(dir).filter((x) => x.dispatch_id !== dispatchId);
  saveDispatchQueue(items, dir);
  return items;
}

/** 某组当前排队数（派单闸/审计面展示用）。 */
export function queueDepthFor(gid: string, dir?: string): number {
  return loadDispatchQueue(dir).filter((x) => (x.input as { gid?: string }).gid === gid).length;
}
