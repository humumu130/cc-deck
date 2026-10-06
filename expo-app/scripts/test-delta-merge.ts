// M13-4 delta 消费断言锁（Leader 探针三断言 + M13-4ADD 锚定纪律断言 + M13-2 幂等三锁端上侧）。
// 跑法：npx tsx scripts/test-delta-merge.ts（org-delta/protocol 零依赖纯 TS，直跑）
// 覆盖：S1 形状分叉（delta 帧 merge / 旧形状覆盖式）/ S2 降级（v2 缺省=覆盖式，
// 终态与 M13-2 前现状一致）/ S3 幂等（同帧重放零变化）/ S4 两链收敛（merge 链==
// 覆盖链语义等价）/ S5 帧无效防御 / S6 锚定纪律（M13-4ADD：未锚定 delta 丢弃+重拉
// 指令、覆盖式帧锚定、锚定后 merge、禁空板起底）。
// 断言器内置（不依赖 node:assert/@types/node——脚本与主代码同一 tsconfig 严检）。
import {
  applyBoardFrame,
  applyProjectsFrame,
  isBoardDelta,
  isEntityDelta,
  isProjectGroup,
  mergeBoard,
  mergeById,
} from "../src/org-delta";
import type { BoardEntry, LessonEntry, ProjectBoard, ProjectGroup } from "../src/protocol";

let pass = 0;
const fail: string[] = [];
function ok(label: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok ${label}`);
  } catch (e) {
    fail.push(label);
    console.log(`FAIL ${label}: ${e instanceof Error ? e.message : e}`);
  }
}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** 深等断言（JSON 序列化比对——用例数据均为纯 JSON 值，键序无关） */
function deepEq(a: unknown, b: unknown, msg = "deepEqual mismatch") {
  const ka = JSON.stringify(a);
  const kb = JSON.stringify(b);
  check(ka === kb, `${msg}\n    actual:   ${ka}\n    expected: ${kb}`);
}

// ---------- fixtures ----------
const g = (id: string, name: string): ProjectGroup =>
  ({ id, name, anchor_dir: `/d/${id}`, tier: "轻立项", status: "active", created_at: 1, updated_at: 1 }) as ProjectGroup;
const e = (id: string, text: string, status: BoardEntry["status"] = "todo"): BoardEntry =>
  ({ id, text, status, created_at: 1, updated_at: 1 });
const l = (id: string, text: string): LessonEntry => ({ id, text, tags: [], ts: 1 });

const groups3 = [g("g1", "甲组"), g("g2", "乙组"), g("g3", "丙组")];
const boardPrev: ProjectBoard = { gid: "G1", frozen: false, entries: [e("e1", "甲"), e("e2", "乙", "doing"), e("e3", "丙", "done")], updated_at: 100 };
const boardDelta = {
  entries: { upserts: [e("e2", "乙改", "doing"), e("e4", "丁")], removes: ["e1", "nope"] },
  lessons: { upserts: [l("l1", "经验一")], removes: [] },
  meta: { frozen: true, updated_at: 200 },
};
const projectsDelta = { upserts: [g("g2", "乙改"), g("g4", "丁组")], removes: ["g1", "unknown-x"] };

// ---------- S1 形状分叉：delta 帧 merge ----------
console.log("S1 形状分叉（delta 帧 merge / 旧形状覆盖式）");

ok("S1.1 projects merge：upsert 原位替换 + 新 id 尾追加 + removes 挖除 + 未知 id 忽略", () => {
  const out = applyProjectsFrame(groups3, { groups: groups3, delta: projectsDelta }, true);
  check(out.projects, "应产出 projects");
  deepEq(out.projects.map((x) => x.id), ["g2", "g3", "g4"]);
  check(out.projects[0]!.name === "乙改", "g2 应被整条替换");
});

ok("S1.2 projects merge 是整条替换（不做字段级合并）", () => {
  const g2full = { ...g("g2", "乙改"), note: "新备注", status: "parked" } as ProjectGroup;
  const out = applyProjectsFrame(groups3, { delta: { upserts: [g2full], removes: [] } }, true);
  check(out.projects, "应产出 projects");
  check(out.projects[1]!.name === "乙改", "name 应更新");
  check((out.projects[1] as unknown as { note?: string }).note === "新备注", "完整条目应整条进缓存");
});

ok("S1.3 board merge（锚定后）：entries 同语义 + meta.frozen 翻转 + updated_at 推进 + 锚定态维持", () => {
  const out = applyBoardFrame(boardPrev, true, { gid: "G1", board: boardPrev, delta: boardDelta }, true);
  check(out.board, "应产出 board");
  check(out.anchor === undefined && out.resyncGid === undefined, "merge 不改锚定态、无重拉");
  deepEq(out.board.entries.map((x) => x.id), ["e2", "e3", "e4"]);
  check(out.board.entries[0]!.text === "乙改", "e2 应被整条替换");
  check(out.board.frozen === true, "meta.frozen 应翻转");
  check(out.board.updated_at === 200, "meta.updated_at 应推进");
  deepEq(out.board.lessons, [l("l1", "经验一")]);
});

ok("S1.5 v2 帧但 delta 缺席（首发/mgr 重启首帧形状）→ 覆盖式消费 groups/board 且锚定", () => {
  const groupsNext = [g("g9", "新全量")];
  const outP = applyProjectsFrame(groups3, { groups: groupsNext }, true);
  deepEq(outP.projects, groupsNext);
  const bNext: ProjectBoard = { gid: "G1", frozen: true, entries: [e("e5", "全量")], updated_at: 9 };
  const outB = applyBoardFrame(boardPrev, true, { gid: "G1", board: bNext }, true);
  check(outB.board === bNext, "覆盖式应原样透传（同引用，现状口径）");
  check(outB.anchor === true, "覆盖式帧即锚定帧");
});

ok("S1.6 畸形 delta（upserts 非数组/条目缺 id）→ 回落覆盖式兜底（同帧全量）+ 板域锚定", () => {
  const outP = applyProjectsFrame(groups3, { groups: groups3, delta: { upserts: "junk", removes: [] } }, true);
  deepEq(outP.projects, groups3);
  const bad = applyProjectsFrame(groups3, { groups: groups3, delta: { upserts: [{ name: "无id" }], removes: [] } }, true);
  deepEq(bad.projects, groups3);
  const outB = applyBoardFrame(boardPrev, true, { gid: "G1", board: boardPrev, delta: { entries: "junk" } }, true);
  check(outB.board === boardPrev && outB.anchor === true, "畸形 delta 回落覆盖式并锚定");
});

// ---------- S2 降级：v2 信号缺省=覆盖式，终态与现状一致 ----------
console.log("S2 降级（projection_v2 缺省帧=覆盖式，终态与 M13-2 前现状一致）");

ok("S2.1 projects：v2 缺省 + delta 帧 → delta 被忽略，输出与现状 filter 表达式逐字节一致", () => {
  const payload = { groups: [g("g1", "甲"), { id: "g5", name: "戊" }, "junk", null], delta: { upserts: [g("gz", "假")], removes: ["g1"] } };
  const out = applyProjectsFrame(groups3, payload, false);
  // 现状表达式（M13-2 前 store.ts 原样）：
  const gs = (payload as { groups: unknown[] }).groups;
  const legacy = gs.filter((x): x is ProjectGroup => !!x && typeof (x as ProjectGroup).id === "string" && !!(x as ProjectGroup).name);
  deepEq(out.projects, legacy);
  check(out.projects!.length === 2, "junk/null 被现状口径滤除，delta 未被消费（gz 不在）");
});

ok("S2.2 board：v2 缺省 + delta 帧 → board 原样透传（覆盖式），delta 被忽略且锚定", () => {
  const bFull: ProjectBoard = { gid: "G1", frozen: true, entries: [e("e7", "全量")], updated_at: 7 };
  const payload = { gid: "G1", board: bFull, delta: { entries: { upserts: [e("e8", "假")], removes: [] }, lessons: { upserts: [], removes: [] }, meta: { frozen: false, updated_at: 0 } } };
  const out = applyBoardFrame(boardPrev, false, payload, false);
  check(out.board === bFull, "v2 缺省应原样透传 board（delta 忽略）");
  check(out.anchor === true, "覆盖式帧即锚定帧");
});

ok("S2.3 projection_v2 非严格 true（undefined/false/字符串/数字）一律不认 delta", () => {
  const payload = { groups: groups3, delta: { upserts: [g("gz", "假")], removes: [] } };
  for (const cap of [undefined, false, "true", 1]) {
    const out = applyProjectsFrame(groups3, payload, cap as boolean);
    check(!!out.projects && !out.projects.some((x) => x.id === "gz"), `cap=${String(cap)} 不应消费 delta`);
  }
});

// ---------- S3 幂等：同帧重放二次应用零变化 ----------
console.log("S3 幂等（同 delta 帧重放，终态零变化）");

ok("S3.1 projects 同帧重放深等零变化", () => {
  const once = applyProjectsFrame(groups3, { delta: projectsDelta }, true).projects!;
  const twice = applyProjectsFrame(once, { delta: projectsDelta }, true).projects!;
  deepEq(twice, once);
  check(twice.length === once.length, "无重复追加");
});

ok("S3.2 board 同帧重放深等零变化（entries/lessons/meta 全域）", () => {
  const once = applyBoardFrame(boardPrev, true, { gid: "G1", delta: boardDelta }, true).board!;
  const twice = applyBoardFrame(once, true, { gid: "G1", delta: boardDelta }, true).board!;
  deepEq(twice, once);
});

ok("S3.3 mergeBoard 纯函数级幂等（merge(merge(x,d),d) 深等 merge(x,d)）", () => {
  const once = mergeBoard(boardPrev, boardDelta);
  const twice = mergeBoard(once, boardDelta);
  deepEq(twice, once);
});

ok("S3.4 mergeById 纯函数级幂等", () => {
  const once = mergeById(groups3, projectsDelta, isProjectGroup);
  const twice = mergeById(once, projectsDelta, isProjectGroup);
  deepEq(twice, once);
});

// ---------- S4 两链收敛：merge 链 == 覆盖链（语义等价，按 id 集合+内容） ----------
console.log("S4 两链收敛（merge 链==覆盖链==板现值语义）");

ok("S4.1 board：relay 同帧 board 全量与 delta 的收敛结果语义等价", () => {
  // relay 现值（覆盖链目标）：e1 删、e2 改、e4 增、frozen 翻转
  const boardNow: ProjectBoard = { gid: "G1", frozen: true, entries: [e("e2", "乙改", "doing"), e("e3", "丙", "done"), e("e4", "丁")], updated_at: 200 };
  const mergeChain = applyBoardFrame(boardPrev, true, { gid: "G1", board: boardNow, delta: boardDelta }, true).board!;
  const coverChain = applyBoardFrame(boardPrev, true, { gid: "G1", board: boardNow }, true).board!;
  const key = (b: ProjectBoard) =>
    JSON.stringify([b.frozen, b.updated_at, [...b.entries].sort((a, z) => a.id.localeCompare(z.id))]);
  check(key(mergeChain) === key(coverChain), "两链应语义收敛（数组序不锁：merge 新条目落尾）");
});

ok("S4.2 projects：merge 链与覆盖链 id 集合+内容收敛", () => {
  const groupsNow = [g("g2", "乙改"), g("g3", "丙组"), g("g4", "丁组")];
  const mergeChain = applyProjectsFrame(groups3, { groups: groupsNow, delta: projectsDelta }, true).projects!;
  const coverChain = applyProjectsFrame(groups3, { groups: groupsNow }, true).projects!;
  const key = (xs: ProjectGroup[]) => JSON.stringify([...xs].sort((a, z) => a.id.localeCompare(z.id)));
  check(key(mergeChain) === key(coverChain), "两链应语义收敛");
});

// ---------- S5 帧无效防御（效果空对象=store 不变） ----------
console.log("S5 帧无效防御");

ok("S5.1 projects：groups 非数组且无合法 delta → 空效果（现状不动口径）", () => {
  deepEq(applyProjectsFrame(groups3, { groups: "junk" }, true), {});
  // v2 门开 + 合法空 delta（relay diffById 空差分形态）→ 帧有效，merge 零变化返回 prev
  const noChange = applyProjectsFrame(groups3, { delta: { upserts: [], removes: [] } }, true);
  deepEq(noChange.projects, groups3);
  deepEq(applyProjectsFrame(groups3, {}, false), {});
  deepEq(applyProjectsFrame(groups3, "junk", true), {});
});

ok("S5.2 board：gid 非字符串/board 缺 entries 且无合法 delta → 空效果（现状不动口径）", () => {
  deepEq(applyBoardFrame(boardPrev, true, { gid: 42, board: boardPrev }, true), {});
  deepEq(applyBoardFrame(boardPrev, true, { gid: "G1" }, true), {});
  deepEq(applyBoardFrame(boardPrev, true, { gid: "G1", board: { gid: "G1", frozen: false, entries: "junk" } }, false), {});
});

ok("S5.3 形状校验器：isEntityDelta/isBoardDelta/isProjectGroup 边界", () => {
  check(isEntityDelta(null, isProjectGroup) === false, "null 应 false");
  check(isEntityDelta({ upserts: [], removes: "x" }, isProjectGroup) === false, "removes 非数组应 false");
  check(isEntityDelta({ upserts: [g("a", "甲")], removes: [] }, isProjectGroup) === true, "合法 delta 应 true");
  check(isBoardDelta(null) === false, "null 应 false");
  check(isBoardDelta({ entries: { upserts: [], removes: [] } }) === true, "lessons/meta 缺席容忍（mergeBoard 兜底）");
  check(isBoardDelta({ entries: "junk" }) === false, "entries 非法应 false");
  check(isProjectGroup({ id: "a" }) === false, "缺 name 应 false");
  check(isProjectGroup(g("a", "甲")) === true, "合法组应 true");
});

// ---------- S6 锚定纪律（M13-4ADD） ----------
console.log("S6 锚定纪律（未锚定 delta 丢弃+重拉 / 覆盖式帧锚定 / 禁空板起底）");

ok("S6.1 板域未锚定 delta → 丢弃（无 board=store 不变）+ resyncGid 重拉指令", () => {
  // 完全未锚定（prev undefined）
  const out = applyBoardFrame(undefined, false, { gid: "G1", delta: boardDelta }, true);
  check(out.board === undefined, "未锚定 delta 不得产出 board（store 不变）");
  check(out.resyncGid === "G1", "应产出重拉指令");
  // 防御形态：prev 有值但未锚定（锚定集被 SNAPSHOT 清除后的陈旧缓存）——同样丢弃+重拉
  const stale = applyBoardFrame(boardPrev, false, { gid: "G1", delta: boardDelta }, true);
  check(stale.board === undefined && stale.resyncGid === "G1", "prev 有值未锚定同样丢弃（禁未锚 merge）");
});

ok("S6.2 板域锚定后 delta → 正常 merge（无重拉）", () => {
  const out = applyBoardFrame(boardPrev, true, { gid: "G1", delta: boardDelta }, true);
  check(out.board !== undefined && out.resyncGid === undefined, "锚定后应 merge 且无重拉");
  deepEq(out.board!.entries.map((x) => x.id), ["e2", "e3", "e4"]);
});

ok("S6.3 板域覆盖式帧消费成功即锚定（anchor:true）——锚定唯一确立路径", () => {
  const bFull: ProjectBoard = { gid: "G1", frozen: false, entries: [e("e1", "甲")], updated_at: 1 };
  const out = applyBoardFrame(undefined, false, { gid: "G1", board: bFull }, true);
  check(out.board === bFull && out.anchor === true, "覆盖式帧应产出 board+anchor");
  // 锚定确立后同 gid delta 即可 merge（链路串联验证）
  const after = applyBoardFrame(out.board, true, { gid: "G1", delta: boardDelta }, true);
  check(after.board !== undefined && after.resyncGid === undefined, "覆盖式锚定后 delta 可 merge");
});

ok("S6.4 projects 域未锚定 delta → 丢弃且无重拉面（SNAPSHOT.projects 天然锚定）", () => {
  const out = applyProjectsFrame(null, { delta: projectsDelta }, true); // prev null = 从未收到快照/覆盖式
  check(out.projects === undefined, "未锚定 projects delta 应丢弃");
  deepEq(out, {}, "projects 域 drop 不带重拉指令（效果对象无其他字段）");
});

ok("S6.5 projects 域锚定含空数组（快照 projects:[] 亦为锚定态）→ delta 可 merge", () => {
  const out = applyProjectsFrame([], { delta: projectsDelta }, true);
  check(out.projects !== undefined, "空数组 prev 是合法锚定基线");
  deepEq(out.projects!.map((x) => x.id), ["g2", "g4"]);
});

ok("S6.6 v2 门关的 delta 帧 = 覆盖式消费 board 全量（锚定帧语义）", () => {
  const bFull: ProjectBoard = { gid: "G1", frozen: true, entries: [e("e7", "全量")], updated_at: 7 };
  const payload = { gid: "G1", board: bFull, delta: boardDelta };
  const out = applyBoardFrame(boardPrev, false, payload, false);
  check(out.board === bFull && out.anchor === true, "v2 门关消费的是 board 全量——实质覆盖式，应锚定");
});

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  console.log(`failed: ${fail.join(" | ")}`);
  process.exit(1);
}
