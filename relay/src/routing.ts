// #26 矩阵式团队 M3 —— 路由表（routing_table）：熟手底账，工作路由的查表事实源。
// 设计稿 docs/v8-team-matrix.html v3.1 §5（工作路由）：路由表 = 项目×技能×负荷三维
//（次数/上次/评价/在忙/失败记录）；熟手 = 会话 id + 档案，退休后只剩路由表记录。
// §6.1：routing_table json 起步，量大迁 sqlite——本模块即 json 形态，API 面向
// sqlite 迁移收敛（键查询/整组读，不做关系 join）。
//
// 记账纪律（对齐台账口径）：
// - 只记项目组派单（gid 必有）：随手办无组不入表——路由是 agent×项目维度
// - 断档补记（relay 重启，回合中断）不入账：断在 relay 不是 worker 干砸/干完，
//   对熟手评价无信息量；该路径不经 closeOpenDispatches 天然豁免
// - 写穿全量 + 坏 JSON 容忍为空态（projects.ts 同款读侧防御）
// - 记录永久保留：结项/挂起不删（退休熟手的档案就是它——§6.1「退休后只剩路由表记录」）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir } from "./org.js";

export interface RoutingEntry {
  /** 项目组 id（路由键之一） */
  gid: string;
  /** worker 会话 id = relay session id（路由键之二；resume 亲和的物理句柄） */
  session_id: string;
  /** 完成次数（负荷/熟练维度） */
  count: number;
  /** 失败次数（干砸记录，§5 调度「搞砸→避开」依据之一） */
  failed: number;
  /** 上次派单收口时刻（ms；「上次」维度 + 退休冷判定数据面） */
  last_ts: number;
  /** 最近一次回执摘要（≤80 字，leader 评鉴参考） */
  last_receipt?: string;
  /** Leader 评价（手动，org rate）：bad = 下次派单避开 */
  rating?: "good" | "bad";
  /** 技能标签（手动，org tag；整组替换） */
  tags: string[];
}

interface RoutingStore {
  entries: RoutingEntry[];
}

function routingPath(dir?: string): string {
  return join(dir ?? orgDir(), "routing.json");
}

function load(dir?: string): RoutingStore {
  const p = routingPath(dir);
  if (!existsSync(p)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as RoutingStore;
    if (Array.isArray(raw?.entries)) return raw;
  } catch {
    // 坏 JSON 容忍为空态（写穿全量会把下一笔落盘修复回来）
  }
  return { entries: [] };
}

// 尽力而为：写失败 warn 不抛（记账面，不阻断派单收口主路径）
function save(s: RoutingStore, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(routingPath(d), JSON.stringify(s, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[routing] 路由表写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- 派单收口记账（dispatch done/failed 的钩子入口） ----------

export function recordRoutingResult(
  gid: string,
  sessionId: string,
  status: "done" | "failed",
  receipt?: string,
  dir?: string,
): RoutingEntry | null {
  if (!gid || !sessionId) return null;
  const s = load(dir);
  let e = s.entries.find((x) => x.gid === gid && x.session_id === sessionId);
  if (!e) {
    e = { gid, session_id: sessionId, count: 0, failed: 0, last_ts: 0, tags: [] };
    s.entries.push(e);
  }
  if (status === "done") e.count++;
  else e.failed++;
  e.last_ts = Date.now();
  const r = (receipt ?? "").trim();
  if (r) e.last_receipt = r.length > 80 ? r.slice(0, 80) : r;
  save(s, dir);
  return e;
}

// ---------- 查询（调度侧） ----------

// 项目组的熟手清单，按调度偏好序：bad 沉底 → 熟练（count）降序 → 最近上手降序。
// 「在忙/空闲」是运行态不落盘——由 session-manager 派单时现场 join（§5 三维的
// 负荷维=运行态 + 本表历史维）
export function routingFor(gid: string, dir?: string): RoutingEntry[] {
  if (!gid) return [];
  const s = load(dir);
  const bad = (e: RoutingEntry) => (e.rating === "bad" ? 1 : 0);
  return s.entries
    .filter((e) => e.gid === gid)
    .sort((a, b) => bad(a) - bad(b) || b.count - a.count || b.last_ts - a.last_ts);
}

export function listRouting(dir?: string): RoutingEntry[] {
  return load(dir).entries;
}

// ---------- 评鉴/标签（Leader 手动，org rate / org tag） ----------

export function rateRouting(
  gid: string,
  sessionId: string,
  rating: "good" | "bad",
  dir?: string,
): { ok: true; entry: RoutingEntry } | { ok: false; error: string } {
  const s = load(dir);
  const e = s.entries.find((x) => x.gid === gid && x.session_id === sessionId);
  if (!e) return { ok: false, error: `无该熟手记录（gid=${gid} sid=${sessionId}）——评价跟着合作记录走` };
  e.rating = rating;
  save(s, dir);
  return { ok: true, entry: e };
}

export function tagRouting(
  gid: string,
  sessionId: string,
  tags: string[],
  dir?: string,
): { ok: true; entry: RoutingEntry } | { ok: false; error: string } {
  const s = load(dir);
  const e = s.entries.find((x) => x.gid === gid && x.session_id === sessionId);
  if (!e) return { ok: false, error: `无该熟手记录（gid=${gid} sid=${sessionId}）——标签跟着合作记录走` };
  // 整组替换（§6.1 技能标签是快照不是流水）：去空去重，≤8 个防滥用；统一小写
  // 归一（审查修正：skills 查询侧已 lowercase，写侧不归一时任何自然书写标签
  //（Rust/TypeScript）永不被命中——技能臂静默失效退化为纯熟练序）
  e.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  save(s, dir);
  return { ok: true, entry: e };
}
