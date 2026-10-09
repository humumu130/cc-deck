// M13-3 Web 消费 delta 投影：形状分叉/旧 relay 降级/幂等收敛/板泳道前向兼容位。
// 靶子 web-console/index.html：SNAPSHOT 能力位（projectionV2）+ 帧分发器两 UPDATED case 分叉 +
// mergeEntityDelta/applyBoardDelta 纯函数 + 板分区按值分组。协议权威 relay/src/types.ts:615-646
// （M13-2 定案：帧级 payload.delta!==undefined → 增量 merge；缺席 → 覆盖式旧字段，零行为变化）。
// 手法 = W 线先例（test-w2b-artifacts.ts）：静态锚 + 正则提取纯函数/case 块 new Function 直跑，
// 注入新旧形状帧比对终态（Leader 验收口径：形状分叉/降级/幂等三断言，同 M13-4 三端一致性）。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-m13-web-delta.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console");
const html = readFileSync(join(webDir, "index.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function blockOf(startMark: string, endMark: string): string {
  const a = html.indexOf(startMark);
  if (a < 0) return "";
  const b = html.indexOf(endMark, a);
  return b < 0 ? "" : html.slice(a, b);
}
function fnSrc(name: string, args: string): string {
  return html.match(new RegExp(`function ${name}\\(${args}\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}
const j = (x: unknown) => JSON.stringify(x);

// ---- 提取被测件 ----
const mergeSrc = fnSrc("mergeEntityDelta", "arr, delta");
const boardSrc = fnSrc("applyBoardDelta", "board, delta");
const projCase = blockOf('case "PROJECTS_UPDATED": {', 'case "ORG_CONFIRM_UPDATED"');
const boardCase = blockOf('case "BOARD_UPDATED": {', 'case "SESSION_ERROR"');
const laneSrc = blockOf("const lanes = [], laneIdx = new Map();", 'boardHtml = \'<div class="od-cols3">\'');
const reanchorSetSrc = html.match(/const boardReanchorInFlight = new Set\(\);/)?.[0] ?? "";
const reanchorSrc = fnSrc("reanchorBoard", "ctx, gid");

console.log("== M13-3 web delta projection: static anchors ==");
ok(mergeSrc !== "", "behavior: mergeEntityDelta extractable");
ok(boardSrc !== "", "behavior: applyBoardDelta extractable");
ok(projCase.includes("mergeEntityDelta"), "behavior: PROJECTS case wired to mergeEntityDelta");
ok(boardCase.includes("applyBoardDelta"), "behavior: BOARD case wired to applyBoardDelta");
ok(laneSrc.includes("BOARD_LANE"), "behavior: lane grouping block extractable");

// ---- ① 静态锚：能力位挂法/分叉守卫/覆盖式原样/无部分基线/前向兼容位 ----
ok(html.includes("ctx.projectionV2 = msg.payload.source_capabilities?.projection_v2 === true;"),
  "SNAPSHOT consumes source_capabilities.projection_v2 (=== true strict)");
ok(html.includes("projectionV2: false, // M13-3"), "ctx init defaults projectionV2=false (old relay)");
ok(projCase.includes("p.delta !== undefined && ctx.projectionV2"),
  "PROJECTS fork: frame-level delta shape AND capability gate");
ok(projCase.includes("if (Array.isArray(p && p.groups)) ctx.projects = p.groups;"),
  "PROJECTS legacy overwrite path intact (groups full array)");
ok(boardCase.includes('typeof p.gid === "string" && p.delta !== undefined && ctx.projectionV2'),
  "BOARD fork: gid + frame-level delta shape AND capability gate");
ok(boardCase.includes("if (base) ctx.boards.set(p.gid, applyBoardDelta(base, p.delta));") &&
  boardCase.includes("else reanchorBoard(ctx, p.gid);"),
  "BOARD delta: anchored=>merge / unanchored=>discard + reanchor pull (M13-3ADD)");
ok(projCase.includes("if (!Array.isArray(ctx.projects)) break;"),
  "PROJECTS delta: unanchored (null baseline) => discard, no empty-baseline merge (M13-3ADD)");
ok(reanchorSetSrc !== "" && reanchorSrc.includes("boardReanchorInFlight") &&
  reanchorSrc.includes("COMMAND_PROJECT_DETAIL"),
  "reanchorBoard: in-flight dedup + full-board re-pull present (M13-3ADD)");
ok(html.includes("if (ack.data.board) ctx.boards.set(gid, ack.data.board);"),
  "drawer pull ack caches full board => anchors the gid (M13-3ADD)");
ok(boardCase.includes("applyBoardDelta(orgDrawer.data.board, p.delta)") &&
  boardCase.includes("orgRenderDrawer();"),
  "BOARD delta: open drawer re-based on pulled full board + rerender");
ok(boardCase.includes("ctx.boards.set(p.gid, p.board);"),
  "BOARD legacy overwrite path intact (full board frame)");
ok(count(html, "function mergeEntityDelta(") === 1 && count(html, "function applyBoardDelta(") === 1,
  "merge fns single definition");
ok(html.includes("backlog: \"待认领\"") && html.includes("claimed: \"进行中\"") &&
  html.includes("submitted: \"待复核\"") && html.includes("ready_to_install: \"待装机\"") &&
  html.includes("done: \"完成\"") && html.includes("BOARD_LANE_ORD"),
  "board lane vocab/order consts present (D18 five-state, forward-compat by-value grouping)");
ok(count(html, 'ents.filter((e) => e.status === st)') === 0,
  "old fixed-key lane filter fully replaced (unknown statuses no longer dropped)");
ok(!blockOf('case "ORG_CONFIRM_UPDATED": {', 'case "BOARD_UPDATED"').includes("delta"),
  "ORG_CONFIRM_UPDATED untouched (M13-2: no delta in confirm domain)");
ok(html.includes("ctx.legacyMode"), "legacyMode consumption untouched (sanity)");

// ---- ② PROJECTS_UPDATED case 直跑：注入帧比终态 ----
{
  const g1 = { id: "g1", name: "Alpha", status: "active", tier: "正式立项", updated_at: 1 };
  const g2 = { id: "g2", name: "Beta", status: "pending", tier: "轻立项", updated_at: 2 };
  const g2v2 = { id: "g2", name: "Beta2", status: "active", tier: "轻立项", updated_at: 9, hold_suggested_at: 42 };
  const g3 = { id: "g3", name: "Gamma", status: "active", tier: "正式立项", updated_at: 3 };
  const run = new Function(
    "ctx", "msg", "mergeEntityDelta",
    `switch (msg.type) { ${projCase} }`,
  ) as (ctx: unknown, msg: unknown, merge: unknown) => void;
  const mk = (projects: unknown, payload: unknown, projectionV2: boolean) => {
    const ctx: { projects: unknown; projectionV2: boolean } = { projects, projectionV2 };
    run(ctx, { type: "PROJECTS_UPDATED", payload }, mergeSrc ? new Function(`${mergeSrc}\nreturn mergeEntityDelta;`)() : null);
    return ctx.projects;
  };
  // 形状分叉：v2 + delta 帧 → 增量 merge（upsert 整条替换/removes 剔除）
  const merged = mk([g1, g2], { groups: [g1, g2, g3], delta: { upserts: [g2v2, g3], removes: [] } }, true);
  const mArr = merged as Array<Record<string, unknown>>;
  ok(Array.isArray(merged) && mArr.length === 3 &&
    mArr.some((x) => x.id === "g2" && x.name === "Beta2" && x.hold_suggested_at === 42),
    "delta frame: upsert replaces whole entry by id (new fields win, not field-merged)");
  // 帧级判定：delta={} 空对象也是增量帧 → 零变化副本
  const empty = mk([g1], { groups: [g1], delta: {} }, true);
  ok(j(empty) === j([g1]), "delta={} frame: valid incremental, terminal unchanged");
  // 降级：能力位缺省 + delta 形状帧 → 覆盖式旧字段（同引用，零 merge 行为）
  const groupsFull = [g1, g2, g3];
  const degraded = mk([g1], { groups: groupsFull, delta: { upserts: [g2v2], removes: [] } }, false);
  ok(degraded === groupsFull, "degraded (no projection_v2): delta frame consumed via legacy overwrite (same ref)");
  // 旧形状帧（无 delta 字段）：覆盖式，含 v2 在册（形状判定优先）
  const legacyRef = [g3];
  ok(mk([g1], { groups: legacyRef }, true) === legacyRef && mk([g1], { groups: legacyRef }, false) === legacyRef,
    "legacy full frame: overwrite both with and without v2 signal");
  // M13-3ADD：基线 null = 未锚定 → delta 帧丢弃，store 不变（禁空基线起底——M13-REV P1）
  const cold = mk(null, { delta: { upserts: [g1, g2], removes: [] } }, true);
  ok(cold === null, "null baseline + delta frame: discarded, store unchanged (anchoring discipline)");
}

// ---- ③ BOARD_UPDATED case 直跑：缓存/抽屉/降级 ----
{
  const e1 = { id: "e1", text: "调研", status: "todo", ts: 1, updated_at: 1 };
  const e2 = { id: "e2", text: "实现", status: "doing", ts: 2, updated_at: 2 };
  const e3 = { id: "e3", text: "验收", status: "done", ts: 3, updated_at: 3 };
  const l1 = { id: "l1", text: "教训一", tags: [], ts: 1 };
  const F0 = { gid: "gb", entries: [e1, e2], lessons: [l1], frozen: false, updated_at: 100 };
  const d1 = { entries: { upserts: [{ ...e1, status: "doing", updated_at: 9 }, e3], removes: ["e2"] }, lessons: { upserts: [], removes: [] }, meta: { frozen: true, updated_at: 200 } };

  let rendered = 0;
  const renderDrawer = () => { rendered++; };
  const reanchorCalls: string[] = [];
  const reanchorStub = (_ctx: unknown, gid: string) => { reanchorCalls.push(gid); };
  const applyBoardDelta = new Function(`${mergeSrc}\n${boardSrc}\nreturn applyBoardDelta;`)() as (b: unknown, d: unknown) => Record<string, unknown>;
  const run = new Function(
    "ctx", "msg", "orgDrawer", "orgRenderDrawer", "applyBoardDelta", "reanchorBoard",
    `switch (msg.type) { ${boardCase} }`,
  ) as (ctx: unknown, msg: unknown, drawer: unknown, render: () => void, abd: typeof applyBoardDelta, re: typeof reanchorStub) => void;
  const mk = (boards: Map<string, unknown>, payload: unknown, projectionV2: boolean, drawer?: { open: boolean; gid: string; data: { board: unknown } | null }) => {
    const d = drawer ?? { open: false, gid: "", data: null };
    const ctx = { boards, projectionV2 };
    run(ctx, { type: "BOARD_UPDATED", payload }, d, renderDrawer, applyBoardDelta, reanchorStub);
    return { ctx, drawer: d };
  };

  // 形状分叉：v2 + delta + 在册板 → merge 终态（entries 替换/剔除 + meta 推进）
  const b0 = new Map([["gb", F0]]);
  const { ctx: c1 } = mk(b0, { gid: "gb", board: F0, delta: d1 }, true);
  const got = c1.boards.get("gb") as typeof F0;
  ok(got.frozen === true && got.updated_at === 200, "delta frame: meta {frozen,updated_at} advances");
  ok(j(got.entries) === j([{ ...e1, status: "doing", updated_at: 9 }, e3]),
    "delta frame: entries upsert-by-id + remove (terminal compare)");
  ok(j(got.lessons) === j([l1]), "delta frame: lessons untouched by empty lessons delta");
  // M13-3ADD：无在册板（未锚定）→ store 不变 + 重拉调用发生
  const b1 = new Map<string, unknown>();
  const { ctx: c2 } = mk(b1, { gid: "gb", delta: d1 }, true);
  ok(c2.boards.size === 0 && reanchorCalls.length === 1 && reanchorCalls[0] === "gb",
    "delta frame + unanchored gid: store unchanged + reanchor re-pull triggered (M13-3ADD)");
  // 抽屉打开：拉取全量为基线应用 delta + 重渲染
  const drawerBoard = { gid: "gb", entries: [e1, e2], lessons: [l1], frozen: false, updated_at: 100 };
  const b2 = new Map([["gb", F0]]);
  const before = rendered;
  const { drawer } = mk(b2, { gid: "gb", board: F0, delta: d1 }, true,
    { open: true, gid: "gb", data: { board: drawerBoard } });
  ok(j((drawer.data as { board: typeof F0 }).board) === j(applyBoardDelta(F0, d1)) && rendered === before + 1,
    "delta frame + open drawer: drawer board merged from pulled baseline + rerendered");
  // 降级：能力位缺省 + delta 形状帧 + p.board 在 → 覆盖式
  const full = { gid: "gb", entries: [e3], lessons: [], frozen: false, updated_at: 999 };
  const b3 = new Map([["gb", F0]]);
  const { ctx: c3 } = mk(b3, { gid: "gb", board: full, delta: d1 }, false);
  ok(c3.boards.get("gb") === full, "degraded: delta frame falls through to legacy overwrite (same ref)");
  // 降级 + 纯 delta 帧（v2 relay 发、端上无信号）：p.board 缺 → 零动作不崩
  const b4 = new Map([["gb", F0]]);
  const { ctx: c4 } = mk(b4, { gid: "gb", delta: d1 }, false);
  ok(c4.boards.get("gb") === F0, "degraded + pure delta payload: no crash, cache untouched");
  // 旧形状帧：现状行为（覆盖 set + 抽屉同引用同步）
  const b5 = new Map([["gb", F0]]);
  const drawer2 = { open: true, gid: "gb", data: { board: drawerBoard } };
  mk(b5, { gid: "gb", board: full }, true, drawer2);
  ok(b5.get("gb") === full && (drawer2.data as { board: unknown }).board === full,
    "legacy frame: overwrite semantics intact (cache + drawer same ref)");
}

// ---- ③b reanchorBoard 直跑：并发去重防风暴 + 回包全量入缓存即锚定（M13-3ADD） ----
{
  const full = { gid: "gb", entries: [], lessons: [], frozen: false, updated_at: 7 };
  let calls = 0;
  let resolveAck: (v: unknown) => void = () => {};
  const ackPromise = new Promise((r) => { resolveAck = r; });
  const reanchor = new Function("commandAck", `${reanchorSetSrc}\n${reanchorSrc}\nreturn reanchorBoard;`)(
    () => { calls++; return ackPromise; },
  ) as (ctx: unknown, gid: string) => void;
  const boards = new Map<string, unknown>();
  const ctx = { boards };
  reanchor(ctx, "gb"); reanchor(ctx, "gb"); // delta 连发两帧 → 同 gid 并发去重
  ok(calls === 1, "reanchor: concurrent re-pulls deduped (one COMMAND_PROJECT_DETAIL in flight)");
  resolveAck({ ok: true, data: { group: {}, board: full, receipts: [] } });
  await new Promise((r) => setTimeout(r, 0));
  ok(boards.get("gb") === full, "reanchor: ack full board cached => gid anchored (delta applicable after)");
  reanchor(ctx, "gb");
  ok(calls === 2, "reanchor: in-flight slot freed after ack");
  // 失败回包：不缓存（不造部分基线）、槽位释放可重试
  const boards2 = new Map<string, unknown>();
  let calls2 = 0;
  const reanchor2 = new Function("commandAck", `${reanchorSetSrc}\n${reanchorSrc}\nreturn reanchorBoard;`)(
    () => { calls2++; return Promise.resolve(null); },
  ) as (ctx: unknown, gid: string) => void;
  reanchor2({ boards: boards2 }, "gx");
  await new Promise((r) => setTimeout(r, 0));
  ok(boards2.size === 0 && calls2 === 1, "reanchor: failed ack => no cache write (no partial baseline)");
  reanchor2({ boards: boards2 }, "gx");
  ok(calls2 === 2, "reanchor: failure frees in-flight slot (retry allowed)");
}

// ---- ④ 幂等与两链收敛（M13-2 三锁之 2/3，端侧口径） ----
{
  const mergeEntityDelta = new Function(`${mergeSrc}\nreturn mergeEntityDelta;`)() as (a: unknown, d: unknown) => unknown[];
  const applyBoardDelta = new Function(`${mergeSrc}\n${boardSrc}\nreturn applyBoardDelta;`)() as (b: unknown, d: unknown) => Record<string, unknown>;
  // 幂等：同一 delta 二次应用零变化
  const g1 = { id: "g1", name: "A", status: "active" };
  const g2 = { id: "g2", name: "B", status: "pending" };
  const dG = { upserts: [{ ...g1, name: "A2" }], removes: ["g2"] };
  const once = mergeEntityDelta([g1, g2], dG);
  ok(j(mergeEntityDelta(once, dG)) === j(once), "projects delta: second application is zero-change (idempotent)");
  const e1 = { id: "e1", text: "t", status: "todo", ts: 1, updated_at: 1 };
  const dB = { entries: { upserts: [{ ...e1, status: "done" }], removes: [] }, lessons: { upserts: [], removes: [] }, meta: { frozen: true, updated_at: 5 } };
  const B0 = { gid: "x", entries: [e1], lessons: [], frozen: false, updated_at: 1 };
  const bOnce = applyBoardDelta(B0, dB);
  ok(j(applyBoardDelta(bOnce, dB)) === j(bOnce), "board delta: second application is zero-change (idempotent)");
  // 两链收敛：F0 --D1,D2--> X  vs  F0 --F1,F2--> Y，merge链==覆盖链==终态
  const diff = (prev: { id: string }[], next: { id: string }[]) => {
    const p = new Map(prev.map((x) => [x.id, j(x)]));
    const n = new Map(next.map((x) => [x.id, j(x)]));
    return {
      upserts: next.filter((x) => p.get(x.id) !== j(x)),
      removes: prev.filter((x) => !n.has(x.id)).map((x) => x.id),
    };
  };
  const F0e = [e1, { id: "e2", text: "s", status: "doing", ts: 2, updated_at: 2 }];
  const F1e = [{ ...e1, status: "doing", updated_at: 3 }, { id: "e3", text: "u", status: "done", ts: 3, updated_at: 3 }];
  const F2e = [F1e[0], { ...F1e[1], text: "u2", updated_at: 4 }];
  const mX = mergeEntityDelta(mergeEntityDelta(F0e, diff(F0e, F1e)), diff(F1e, F2e));
  const mY = F2e;
  ok(j(mX) === j(mY), "projects convergence: merge chain == overwrite chain == final state");
  const mkF = (entries: typeof F0e, updated_at: number, frozen = false) => ({ gid: "x", entries, lessons: [], frozen, updated_at });
  const F0b = mkF(F0e, 100);
  const F1b = mkF(F1e, 200);
  const F2b = mkF(F2e, 300, true);
  const bX = applyBoardDelta(applyBoardDelta(F0b, { entries: diff(F0e, F1e), lessons: { upserts: [], removes: [] }, meta: { frozen: false, updated_at: 200 } }),
    { entries: diff(F1e, F2e), lessons: { upserts: [], removes: [] }, meta: { frozen: true, updated_at: 300 } });
  ok(j(bX) === j(F2b), "board convergence: merge chain == overwrite chain == board current value");
}

// ---- ⑤ 板泳道按值分组直跑（D18 五态已落：词表升级，机制锁不变） ----
{
  const run = new Function("ents", "BOARD_LANE", "BOARD_LANE_ORD", laneSrc + "\nreturn lanes;") as
    (ents: Array<{ status?: string; [k: string]: unknown }>, lane: Record<string, string>, ord: Record<string, number>) => { st: string; lb: string; list: unknown[] }[];
  const L = { backlog: "待认领", claimed: "进行中", submitted: "待复核", ready_to_install: "待装机", done: "完成" };
  const O = { backlog: 0, claimed: 1, submitted: 2, ready_to_install: 3, done: 4 };
  const e = (s: string, n: number) => ({ status: s, n });
  // 五态：序/标/非空（backlog→done 定序，freeze §1.2 词表）
  const lanes5 = run([e("done", 1), e("backlog", 2), e("submitted", 3), e("backlog", 4), e("ready_to_install", 5), e("claimed", 6)], L, O);
  ok(j(lanes5.map((c) => [c.st, c.lb, c.list.length])) === j([["backlog", "待认领", 2], ["claimed", "进行中", 1], ["submitted", "待复核", 1], ["ready_to_install", "待装机", 1], ["done", "完成", 1]]),
    "lanes: five-state order/labels/non-empty (D18 vocab, freeze §1.2)");
  // 前向兼容：未知状态值原样成列排最后（不丢弃——旧实现 filter 直接吃掉）
  const lanesX = run([e("backlog", 1), e("blocked", 2), e("claimed", 3)], L, O);
  ok(j(lanesX.map((c) => [c.st, c.lb, c.list.length])) === j([["backlog", "待认领", 1], ["claimed", "进行中", 1], ["blocked", "blocked", 1]]),
    "lanes: unknown status value renders as its own column after known five (forward-compat)");
  // 无 status 归 backlog；无空列产出
  const lanesN = run([e("backlog", 1), { n: 9 }, e("done", 2)], L, O);
  ok(j(lanesN.map((c) => [c.st, c.list.length])) === j([["backlog", 2], ["done", 1]]) &&
    lanesN.every((c) => c.list.length > 0),
    "lanes: missing status falls into backlog; no empty lanes constructed");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
