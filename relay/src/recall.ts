// ---------- chainrecall MVP（1104 用户令「1、2 都要」，架构升级期二）：链式召回 ----------
// 语义移植自 DS「context as cache」：上下文当缓存管——任务书/回执不贴全文，写「见
// recall:<id>」，worker 端按 id 取回摘要+关联链（链式取回代替复制）。
//
// 【只读铁律】本模块全链零写路径（只读系 fs 调用，无任何写型 fs API）——
// 回归以静态锁钉死（test-chainrecall G 族）。关联关系只用既有账面事实，不新建关系库：
//   板卡.dispatch_id ↔ 派单（projects.ts BoardEntry 字段）
//   派单.session_id  ↔ 会话（org.ts DispatchEntry 字段）
//   派单.title → 回执文件名约定（w-<slug>.md，slug 派生规则与 leader-dispatch 同源，
//   见 receiptSlugOfTitle 锚注释）——显式 --slug 派的单文件名不可推导，该关联缺省
//   为空（关系可选，缺=不编）。
//
// 【单点注册表（验收点 6）】四类对象 = RECALL_KINDS + RESOLVERS 一张表：新增对象
// 类型只在两处各加一行（kind + resolver），路由/检测/测试零改动。
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { orgDir, readDispatchLogFile, type DispatchEntry } from "./org.js";
import { artifactsDir } from "./artifacts.js";

export type RecallKind = "session" | "card" | "dispatch" | "receipt";
export const RECALL_KINDS: readonly RecallKind[] = ["session", "card", "dispatch", "receipt"];

/** R1-P1/P2-2：台账读取用**文件直读**变体（不走 viaReadMode——sqlite 档下每请求触发
 * 全七域 importAllForShadow 影子同步，实测 1.1s/请求 vs json 档 6.5ms，含 2375 文件
 * 任务树扫描=relay 单线程自伤放大器；文件=真相源，读穿投影不归属取回路径）。max
 * 显式给大窗：缺省 500 已越窗（生产 2987 行实测，R1-P2-2）——50k=现网 16 倍余量，
 * 量级爬升再议（每行 ~200B，50k 行全读 ~10ms 级）。 */
const RECALL_DISPATCH_MAX = 50_000;

/** 会话最小结构面（SessionState 结构子集——生产 mgr.snapshot() 直接适配，测试喂 fixture） */
export interface RecallSessionLike {
  session_id: string;
  title?: string;
  status?: string;
  action_summary?: string;
  updated_at?: number;
}

export interface RecallRef {
  id: string;
  kind: RecallKind;
  /** 关联对象摘要 ≤40 字 */
  summary: string;
  /** hop=2 时第二跳关联（仅 id/kind/摘要，不再下钻） */
  related?: RecallRef[];
}

export interface RecallNode {
  id: string;
  kind: RecallKind;
  /** 主对象摘要 ≤80 字 */
  summary: string;
  related: RecallRef[];
}

/** CJK 安全截断（码点计数，不切代理对） */
function clip(s: string, n: number): string {
  const a = Array.from(s);
  return a.length <= n ? s : a.slice(0, n - 1).join("") + "…";
}

/**
 * 派单标题 → 回执 slug。**与 cc-plugins/plugins/cc-deck/bin/leader-dispatch:96-98
 * 的 python 派生同源**（ASCII 连串小写、"-" 连接、24 字符封顶、去首尾短横线）——两处
 * 规则必须同步改（本函数是 relay 侧唯一副本；改前先改 leader-dispatch 再对齐此处）。
 * 纯 CJK 标题无 ASCII 串 → 空串（leader-dispatch 走时间戳兜底，不可推导=无关联）。
 */
export function receiptSlugOfTitle(title: string | undefined): string {
  if (!title) return "";
  const runs = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return runs.join("-").slice(0, 24).replace(/^-+|-+$/g, "");
}

/** 回执 id 归一：接受 w-xxx.md / w-xxx / xxx → 文件名 w-xxx.md；非法字符（路径面）拒收 */
export function receiptFileNameOf(id: string): string | null {
  let f = id.trim();
  if (!f) return null;
  if (!f.endsWith(".md")) f += ".md";
  if (!f.startsWith("w-")) f = "w-" + f;
  return /^w-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(f) ? f : null;
}

/** 只读文件头（回执摘要提取用，防超大文件整读） */
function readHead(path: string, cap = 262_144): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(size, cap));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 板卡最小结构面（BoardEntry 子集——直接 JSON.parse 读 boards/*.json，不走
 * loadBoardFile 的 journal 回放机械（读侧可能触发写回），只读铁律优先） */
interface RecallCardLike {
  id: string;
  text?: string;
  status?: string;
  owner_session?: string;
  dispatch_id?: string;
}
interface RecallCtx {
  orgDir: string;
  dispatches: DispatchEntry[];
  boards: { gid: string; entries: RecallCardLike[] }[];
  sessions: RecallSessionLike[];
}

function buildCtx(sessions: () => RecallSessionLike[]): RecallCtx {
  const dir = orgDir();
  const boards: { gid: string; entries: RecallCardLike[] }[] = [];
  try {
    for (const f of readdirSync(join(dir, "boards"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, "boards", f), "utf-8")) as { entries?: unknown };
        if (Array.isArray(raw.entries)) {
          boards.push({ gid: f.replace(/\.json$/, ""), entries: raw.entries as RecallCardLike[] });
        }
      } catch { /* 坏板文件跳过（其余板照常召回） */ }
    }
  } catch { /* boards 目录缺 = 无板卡面 */ }
  let sess: RecallSessionLike[] = [];
  try { sess = sessions() ?? []; } catch { /* 快照失败 = 无会话面 */ }
  // R1-P1/P2-2：文件直读+大窗（见 RECALL_DISPATCH_MAX 注释）
  const dispatches = readDispatchLogFile(dir, RECALL_DISPATCH_MAX);
  // R1-B1：title 回填——收敛视图同 id 末行覆盖会抹掉首行 title（appendDispatch 只在
  // dispatched 首行写 title，生产 1709 条非 manual 派单收敛后仅 1 条含 title=摘要退化
  // 裸 UUID+派单→回执 slug 关联生产≈0%）。这里按「首行 title 直读」口径回填（审方
  // 给的修法）：单独立一轮轻量行扫，不复刻收敛逻辑（收敛单源在 org.ts）。
  try {
    const byId = new Map(dispatches.map((d) => [d.id, d] as const));
    const raw = readFileSync(join(dir, "dispatch-log.ndjson"), "utf-8");
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as { id?: unknown; title?: unknown };
        if (typeof e.id !== "string" || !e.id || typeof e.title !== "string" || !e.title || seen.has(e.id)) continue;
        seen.add(e.id);
        const hit = byId.get(e.id);
        if (hit && !hit.title) hit.title = e.title;
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 台账文件缺 = 无派单面 */ }
  return { orgDir: dir, dispatches, boards, sessions: sess };
}

// ---------- 摘要（纯机械抽取，零模型调用） ----------

function summaryOfSession(s: RecallSessionLike): string {
  const inner = [s.status || "??", s.action_summary].filter(Boolean).join("，");
  return clip(`${s.title || s.session_id.slice(0, 8)}（${inner}）`, 80);
}

function summaryOfCard(gid: string, e: RecallCardLike): string {
  return clip(`${gid}：${e.text || e.id}（${e.status || "??"}）`, 80);
}

function summaryOfDispatch(d: DispatchEntry): string {
  return clip(`${d.title || d.id}（${d.status}，承接 ${String(d.session_id).slice(0, 8)}）`, 80);
}

/** 回执摘要：首个 # 标题 + 末个「结果：」行（截 80）。R1-P3：结果行反向取——长回执
 * 正文可引用「结果：」字样（样例任务书/引文），真值在文件末尾。 */
function summaryOfReceipt(fileName: string): string {
  const head = readHead(join(artifactsDir(), fileName));
  if (!head) return clip(fileName, 80);
  const lines = head.split("\n").map((l) => l.trim());
  const h = lines.find((l) => l.startsWith("# "))?.replace(/^#\s+/, "");
  let r: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith("结果：")) { r = lines[i]; break; }
  }
  const body = h ? (r ? `${h}｜${r}` : h) : r || fileName;
  return clip(body, 80);
}

// ---------- 关联（既有账面事实，不新建关系库） ----------

function refOfSession(s: RecallSessionLike): RecallRef {
  return { id: s.session_id, kind: "session", summary: clip(summaryOfSession(s), 40) };
}
function refOfCard(gid: string, e: RecallCardLike): RecallRef {
  return { id: e.id, kind: "card", summary: clip(summaryOfCard(gid, e), 40) };
}
function refOfDispatch(d: DispatchEntry): RecallRef {
  return { id: d.id, kind: "dispatch", summary: clip(summaryOfDispatch(d), 40) };
}
function refOfReceipt(fileName: string): RecallRef {
  return { id: fileName, kind: "receipt", summary: clip(summaryOfReceipt(fileName), 40) };
}

function cardsByDispatch(ctx: RecallCtx, dispatchId: string): { gid: string; entry: RecallCardLike }[] {
  const out: { gid: string; entry: RecallCardLike }[] = [];
  for (const b of ctx.boards) for (const e of b.entries) if (e.dispatch_id === dispatchId) out.push({ gid: b.gid, entry: e });
  return out;
}

// ---------- 四类 resolver（单点注册表） ----------

function resolveSession(id: string, ctx: RecallCtx): RecallNode | null {
  const s = ctx.sessions.find((x) => x.session_id === id);
  if (!s) return null;
  const related: RecallRef[] = [];
  for (const d of [...ctx.dispatches].sort((a, b) => b.ts - a.ts)) {
    if (d.session_id === id && !related.some((r) => r.id === d.id)) related.push(refOfDispatch(d));
    if (related.length >= 5) break;
  }
  for (const b of ctx.boards) {
    for (const e of b.entries) {
      if (e.owner_session === id && !related.some((r) => r.id === e.id)) related.push(refOfCard(b.gid, e));
      if (related.length >= 10) break;
    }
  }
  return { id, kind: "session", summary: summaryOfSession(s), related: related.slice(0, 10) };
}

function resolveCard(id: string, ctx: RecallCtx): RecallNode | null {
  let hit: { gid: string; entry: RecallCardLike } | null = null;
  for (const b of ctx.boards) {
    const e = b.entries.find((x) => x.id === id);
    if (e) { hit = { gid: b.gid, entry: e }; break; }
  }
  if (!hit) return null;
  const related: RecallRef[] = [];
  if (hit.entry.dispatch_id) {
    const d = ctx.dispatches.find((x) => x.id === hit!.entry!.dispatch_id);
    related.push(d ? refOfDispatch(d) : { id: hit.entry.dispatch_id, kind: "dispatch", summary: "台账无行（仅板卡引用）" });
  }
  if (hit.entry.owner_session) {
    const s = ctx.sessions.find((x) => x.session_id === hit!.entry!.owner_session);
    if (s) related.push(refOfSession(s));
  }
  return { id, kind: "card", summary: summaryOfCard(hit.gid, hit.entry), related };
}

function resolveDispatch(id: string, ctx: RecallCtx): RecallNode | null {
  const d = ctx.dispatches.find((x) => x.id === id);
  if (!d) return null;
  const related: RecallRef[] = [];
  const s = ctx.sessions.find((x) => x.session_id === d.session_id);
  if (s) related.push(refOfSession(s));
  for (const c of cardsByDispatch(ctx, id).slice(0, 2)) related.push(refOfCard(c.gid, c.entry));
  const slug = receiptSlugOfTitle(d.title);
  if (slug) {
    const f = `w-${slug}.md`;
    try {
      statSync(join(artifactsDir(), f));
      related.push(refOfReceipt(f));
    } catch { /* 文件名约定未命中（显式 --slug 派单/未写回执）= 无此关联 */ }
  }
  return { id, kind: "dispatch", summary: summaryOfDispatch(d), related };
}

function resolveReceipt(id: string, ctx: RecallCtx): RecallNode | null {
  const f = receiptFileNameOf(id);
  if (!f) return null;
  try {
    statSync(join(artifactsDir(), f));
  } catch {
    return null;
  }
  const related: RecallRef[] = [];
  const slug = f.replace(/^w-/, "").replace(/\.md$/, "");
  const d = [...ctx.dispatches].sort((a, b) => b.ts - a.ts).find((x) => receiptSlugOfTitle(x.title) === slug);
  if (d) related.push(refOfDispatch(d));
  return { id: f, kind: "receipt", summary: summaryOfReceipt(f), related };
}

/** 单点注册表（验收点 6）：新增对象类型在此各加一行 */
const RESOLVERS: Record<RecallKind, (id: string, ctx: RecallCtx) => RecallNode | null> = {
  session: resolveSession,
  card: resolveCard,
  dispatch: resolveDispatch,
  receipt: resolveReceipt,
};

function detectKind(id: string, ctx: RecallCtx): RecallKind | null {
  if (id.startsWith("t-")) return "card";
  if (id.startsWith("w-") || id.endsWith(".md")) return "receipt";
  if (ctx.dispatches.some((x) => x.id === id)) return "dispatch";
  if (ctx.sessions.some((x) => x.session_id === id)) return "session";
  // 裸 slug（不带 w- 前缀）兜底：回执文件在即回执（「见 recall:chain-recall-fix」可直查）
  const f = receiptFileNameOf(id);
  if (f) {
    try {
      statSync(join(artifactsDir(), f));
      return "receipt";
    } catch { /* 未命中继续回落 */ }
  }
  return null;
}

export interface RecallOptions {
  /** 显式指定对象类型（缺省按 id 形状+账面命中自动检测） */
  kind?: string;
  /** 1=直接关联（缺省）；2=第二跳展开（related[].related） */
  hop?: 1 | 2;
  /** 会话快照提供者（生产传 () => mgr.snapshot()；测试喂 fixture） */
  sessions: () => RecallSessionLike[];
}

/**
 * 链式召回主入口（只读）：id → {kind, 摘要≤80, 关联[]}；未命中返回 null。
 * hop=2 时逐关联下钻一层（环防护：剔除回到主对象 id 的引用）。
 */
export function recallResolve(id: string, opts: RecallOptions): RecallNode | null {
  const clean = id.trim();
  if (!clean) return null;
  const ctx = buildCtx(opts.sessions);
  let kind: RecallKind | null = null;
  if (opts.kind) {
    kind = (RECALL_KINDS as readonly string[]).includes(opts.kind) ? (opts.kind as RecallKind) : null;
    if (!kind) return null;
  } else {
    kind = detectKind(clean, ctx);
    if (!kind) return null;
  }
  const node = RESOLVERS[kind](clean, ctx);
  if (!node) return null;
  if ((opts.hop ?? 1) === 2) {
    for (const ref of node.related.slice(0, 8)) {
      const child = RESOLVERS[ref.kind](ref.id, ctx);
      if (child) {
        ref.related = child.related.filter((r) => r.id !== node!.id).slice(0, 6).map(({ id: rid, kind: rk, summary: rs }) => ({ id: rid, kind: rk, summary: rs }));
      }
    }
  }
  return node;
}
