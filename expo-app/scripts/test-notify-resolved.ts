// M13-6E 通知 resolved 分离 + 验收回跳断言锁。
// 跑法：npx tsx scripts/test-notify-resolved.ts（notify-jump 零依赖纯 TS，直跑）
// 覆盖：S1 done 判定与处理时刻（三戳口径+优先序+畸形防御）/ S2 分区（不丢行+
// 保池序+空区面）/ S3 未决口径（notifActionableOf 迁入回归）/ S4 回跳判定
// （acceptance 域双口径+session 归因命中+同源约束+降级面）/ S5 与 badge 口径互补
// （main 区全覆盖 pending——badge 面不回退）。
// 断言器内置（不依赖 node:assert/@types/node——脚本与主代码同一 tsconfig 严检）。
import {
  jumpTargetOf,
  notifActionableOf,
  notifDoneAt,
  splitResolvedRows,
} from "../src/notify-jump";
import type { NotificationItem } from "../src/protocol";

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
// dismissed_at = relay 侧 lifecycle 扩展字段，protocol.ts 冻结面 NotificationItem 暂无
//（store.ts ackNotification 协议缺口备案同款）——fixture 参数面按运行时形状放宽 cast
type NotifFixture = Partial<NotificationItem> & { key: string; dismissed_at?: number };
const n = (over: NotifFixture): NotificationItem =>
  ({
    kind: "dispatch",
    group: "action",
    severity: "waiting",
    title: `通知${over.key}`,
    body: "",
    sourceContext: { domain: "session", entityId: "e", alertId: "a", returnPath: "" },
    actionable: true,
    created_at: 100,
    ...over,
  }) as NotificationItem;

// ---------- S1 done 判定与处理时刻（notifDoneAt） ----------
console.log("S1 done 判定与处理时刻（三戳口径 / 优先序 / 畸形防御）");

ok("S1.1 三戳全空/缺席 → null（未处理）", () => {
  check(notifDoneAt(n({ key: "a" })) === null, "全缺应 null");
  check(notifDoneAt(n({ key: "a", resolved_at: undefined, handled_at: undefined })) === null, "显式 undefined 应 null");
});

ok("S1.2 仅 resolved_at / 仅 handled_at / 仅 dismissed_at → 各取其值", () => {
  check(notifDoneAt(n({ key: "a", resolved_at: 300 })) === 300, "resolved 应取 300");
  check(notifDoneAt(n({ key: "a", handled_at: 200 })) === 200, "handled 应取 200");
  check(notifDoneAt(n({ key: "a", dismissed_at: 150 })) === 150, "dismissed 应取 150");
});

ok("S1.3 三戳全在 → resolved_at 优先（生命周期结束时刻）", () => {
  check(notifDoneAt(n({ key: "a", resolved_at: 300, handled_at: 200, dismissed_at: 150 })) === 300, "应优先 resolved_at");
});

ok("S1.4 dismissed 双填形态（relay transitionNotification dismissed 同填 handled）→ 取 handled（>dismissed 优先序）", () => {
  check(notifDoneAt(n({ key: "a", handled_at: 200, dismissed_at: 200 })) === 200, "双填应取 handled_at");
});

ok("S1.5 畸形时间戳（字符串/0/负数/Infinity/NaN）→ 视为空", () => {
  check(notifDoneAt(n({ key: "a", handled_at: "200" as unknown as number })) === null, "字符串应视为空");
  check(notifDoneAt(n({ key: "a", handled_at: 0 })) === null, "0 应视为空");
  check(notifDoneAt(n({ key: "a", handled_at: -5 })) === null, "负数应视为空");
  check(notifDoneAt(n({ key: "a", handled_at: Infinity })) === null, "Infinity 应视为空");
  check(notifDoneAt(n({ key: "a", handled_at: NaN })) === null, "NaN 应视为空");
});

ok("S1.6 条目畸形（null/非对象）→ null 不炸", () => {
  check(notifDoneAt(null) === null, "null 应 null");
  check(notifDoneAt("junk") === null, "字符串应 null");
  check(notifDoneAt(42) === null, "数字应 null");
});

// ---------- S2 分区（splitResolvedRows） ----------
console.log("S2 分区（done 拆入 resolved / 不丢行 / 保池序 / 空区面）");

ok("S2.1 done 行拆入 resolved，未处理留 main", () => {
  const rows = [n({ key: "p1" }), n({ key: "d1", handled_at: 200 }), n({ key: "p2" }), n({ key: "d2", resolved_at: 300 })];
  const { main, resolved } = splitResolvedRows(rows, notifDoneAt);
  deepEq(main.map((r) => r.key), ["p1", "p2"]);
  deepEq(resolved.map((r) => r.key), ["d1", "d2"]);
});

ok("S2.2 不丢行：main ∪ resolved = rows 全集", () => {
  const rows = [n({ key: "a" }), n({ key: "b", handled_at: 1 }), n({ key: "c" }), n({ key: "d", dismissed_at: 2 }), n({ key: "e" })];
  const { main, resolved } = splitResolvedRows(rows, notifDoneAt);
  check(main.length + resolved.length === rows.length, "长度和应等于全集");
  const keys = new Set([...main, ...resolved].map((r) => r.key));
  for (const r of rows) check(keys.has(r.key), `行 ${r.key} 不应丢失`);
});

ok("S2.3 两区各保池序（不重排防行跳位）", () => {
  const rows = [n({ key: "d1", handled_at: 9 }), n({ key: "p1" }), n({ key: "d2", resolved_at: 3 }), n({ key: "p2" })];
  const { main, resolved } = splitResolvedRows(rows, notifDoneAt);
  deepEq(main.map((r) => r.key), ["p1", "p2"], "main 应保池序");
  deepEq(resolved.map((r) => r.key), ["d1", "d2"], "resolved 应保池序");
});

ok("S2.4 无 done 行 → resolved 空（UI 不渲染折叠分区头的条件面）", () => {
  const { resolved } = splitResolvedRows([n({ key: "p1" }), n({ key: "p2" })], notifDoneAt);
  check(resolved.length === 0, "应空区");
});

ok("S2.5 全 done → main 空（全部归档）", () => {
  const { main, resolved } = splitResolvedRows([n({ key: "d1", handled_at: 1 }), n({ key: "d2", handled_at: 2 })], notifDoneAt);
  check(main.length === 0 && resolved.length === 2, "main 应空、resolved 应 2");
});

ok("S2.6 畸形行（null 混入池）→ doneAt null 落 main 不炸", () => {
  const rows = [null, n({ key: "p1" }), undefined] as unknown as NotificationItem[];
  const { main, resolved } = splitResolvedRows(rows, notifDoneAt);
  check(main.length === 3 && resolved.length === 0, "畸形行应落 main");
});

// ---------- S3 未决口径（notifActionableOf 自 ListScreen 迁入回归） ----------
console.log("S3 未决口径（迁入回归：badge/按钮位判定原样）");

ok("S3.1 actionable+三戳全空 → 命中；任一戳非空 → 不命中", () => {
  deepEq(notifActionableOf([n({ key: "k1" })]).map((x) => x.key), ["k1"]);
  check(notifActionableOf([n({ key: "k2", handled_at: 1 })]).length === 0, "handled 后不命中");
  check(notifActionableOf([n({ key: "k3", resolved_at: 1 })]).length === 0, "resolved 后不命中");
  check(notifActionableOf([n({ key: "k4", dismissed_at: 1 })]).length === 0, "dismissed 后不命中");
});

ok("S3.2 非 actionable → 不命中（activity 只读通知不进 badge）", () => {
  check(notifActionableOf([n({ key: "k1", actionable: false })]).length === 0, "应不命中");
});

ok("S3.3 池非数组/条目畸形 → 安全空（不清零不伪造）", () => {
  deepEq(notifActionableOf(null), []);
  deepEq(notifActionableOf("junk"), []);
  deepEq(notifActionableOf([null, 42, { key: 1 }, { actionable: true }]), []);
});

ok("S3.4 done 判定与未决判定互补一致（同一行不可能既 pending 又 resolved）", () => {
  const rows = [n({ key: "p1" }), n({ key: "d1", handled_at: 1 }), n({ key: "p2", actionable: false })];
  const pending = new Set(notifActionableOf(rows).map((x) => x.key));
  const { resolved } = splitResolvedRows(rows, notifDoneAt);
  for (const r of resolved) check(!pending.has(r.key), `${r.key} 不应同时 pending 与 resolved`);
});

// ---------- S4 回跳判定（jumpTargetOf：dispatch 反查→task / 降级 session） ----------
console.log("S4 回跳判定（dispatch 域板缓存反查 / sessionId 降级链 / 同源约束 / 降级）");

ok("S4.1 dispatch 域归因：板缓存反查 dispatch_id → task 落点（gid+entryId）", () => {
  const item = n({ key: "a", sourceContext: { domain: "dispatch", entityId: "dp-1", alertId: "a", returnPath: "" } });
  const boards = { G1: { gid: "G1", frozen: false, entries: [{ id: "e1", text: "甲", status: "todo" }, { id: "e2", text: "乙", status: "doing", dispatch_id: "dp-1" }] } };
  deepEq(jumpTargetOf(item, { boards, srcId: "src1", sessions: [] }), { type: "task", gid: "G1", entryId: "e2" });
});

ok("S4.2 dispatch 反查不中（归因未回写/板未同步）→ 落 sessionId 降级链（web 同款兜底）", () => {
  const item = n({ key: "a", sourceContext: { domain: "dispatch", entityId: "dp-none", sessionId: "s1", alertId: "a", returnPath: "" } });
  const boards = { G1: { gid: "G1", frozen: false, entries: [{ id: "e1", text: "甲", status: "todo" }] } };
  deepEq(jumpTargetOf(item, { boards, sessions: [{ session_id: "s1" }], srcId: "src1" }), { type: "session", sid: "s1" }, "反查不中应降级 session");
  deepEq(jumpTargetOf(item, { sessions: [{ session_id: "s1" }], srcId: "src1" }), { type: "session", sid: "s1" }, "boards 缺席同链降级");
});

ok("S4.3 非 dispatch 域走 sessionId 降级链；org 域 expo 无确认卡聚焦面 → 同降级（备案）", () => {
  const waiting = n({ key: "a", sourceContext: { domain: "session", entityId: "e", sessionId: "s1", alertId: "a", returnPath: "" } });
  deepEq(jumpTargetOf(waiting, { sessions: [{ session_id: "s1" }], srcId: "src1" }), { type: "session", sid: "s1" });
  const org = n({ key: "a", sourceContext: { domain: "org", entityId: "cf-1", sessionId: "s1", alertId: "a", returnPath: "" } });
  deepEq(jumpTargetOf(org, { sessions: [{ session_id: "s1" }], srcId: "src1" }), { type: "session", sid: "s1" }, "org 域应降级 session");
});

ok("S4.4 降级链同源约束：src 相等命中 / src 异源跳过 / src 缺失（单源形态）命中", () => {
  const mk = (sessionId: string) => n({ key: "a", sourceContext: { domain: "session", entityId: "e", sessionId, alertId: "a", returnPath: "" } });
  deepEq(jumpTargetOf(mk("s1"), { sessions: [{ session_id: "s1", src: "src1" }], srcId: "src1" }), { type: "session", sid: "s1" }, "src 相等应命中");
  check(jumpTargetOf(mk("s1"), { sessions: [{ session_id: "s1", src: "src2" }], srcId: "src1" }) === null, "src 异源应跳过");
  deepEq(jumpTargetOf(mk("s1"), { sessions: [{ session_id: "s1" }], srcId: "src1" }), { type: "session", sid: "s1" }, "src 缺失（单源）应命中");
});

ok("S4.5 归因全缺：sessionId 缺/非字符串且无 dispatch 归因 → null（不跳不报错不假造）", () => {
  const noSid = n({ key: "a" });
  check(jumpTargetOf(noSid, { sessions: [{ session_id: "s1" }], srcId: "src1" }) === null, "sessionId 缺应 null");
  const badSid = n({ key: "a", sourceContext: { domain: "session", entityId: "e", sessionId: 42 as unknown as string, alertId: "a", returnPath: "" } });
  check(jumpTargetOf(badSid, { sessions: [{ session_id: "s1" }], srcId: "src1" }) === null, "sessionId 非字符串应 null");
  check(jumpTargetOf(n({ key: "a", sourceContext: { domain: "session", entityId: "e", alertId: "a", returnPath: "" } }), { sessions: [], srcId: "x" }) === null, "无 sessionId 无归因应 null");
});

ok("S4.6 会话不在（已清场/跨源视图过滤）→ null 降级", () => {
  const item = n({ key: "a", sourceContext: { domain: "session", entityId: "e", sessionId: "s-gone", alertId: "a", returnPath: "" } });
  check(jumpTargetOf(item, { sessions: [{ session_id: "s-other" }], srcId: "src1" }) === null, "查无此会话应 null");
  check(jumpTargetOf(item, { sessions: [], srcId: "src1" }) === null, "空会话表应 null");
});

ok("S4.7 ctx/item 坏形状（非对象/sessions 非数组/boards 畸形/条目畸形）→ null 不炸", () => {
  const item = n({ key: "a", sourceContext: { domain: "session", entityId: "e", sessionId: "s1", alertId: "a", returnPath: "" } });
  check(jumpTargetOf(item, null as unknown as { sessions?: unknown; srcId?: unknown }) === null, "ctx null 应 null");
  check(jumpTargetOf(item, {}) === null, "sessions 缺应 null");
  check(jumpTargetOf(item, { sessions: "junk", srcId: "src1" }) === null, "sessions 非数组应 null");
  check(jumpTargetOf(item, { sessions: [null, 42, { title: "无 id" }], srcId: "src1" }) === null, "会话条目畸形应跳过");
  check(jumpTargetOf(null, { sessions: [], srcId: "x" }) === null, "item null 应 null");
  const dpBad = n({ key: "a", sourceContext: { domain: "dispatch", entityId: "dp-1", sessionId: "s1", alertId: "a", returnPath: "" } });
  deepEq(jumpTargetOf(dpBad, { sessions: [{ session_id: "s1" }], srcId: "x", boards: { G1: { entries: "junk" } } }), { type: "session", sid: "s1" }, "board entries 畸形应跳过反查落降级");
  deepEq(jumpTargetOf(dpBad, { sessions: [{ session_id: "s1" }], srcId: "x", boards: null }), { type: "session", sid: "s1" }, "boards null 应跳过反查落降级");
});

ok("S4.8 dispatch 反查键校验：dispatch_id 非字符串条目跳过 / entry 缺 id 跳过 / gid 空串跳过", () => {
  const item = n({ key: "a", sourceContext: { domain: "dispatch", entityId: "dp-1", sessionId: "s-fallback", alertId: "a", returnPath: "" } });
  const boards = {
    G1: { gid: "G1", frozen: false, entries: [{ id: "e1", text: "甲", status: "todo", dispatch_id: 42 }] }, // dispatch_id 非串不命中
    "": { gid: "", frozen: false, entries: [{ id: "e2", text: "乙", status: "todo", dispatch_id: "dp-1" }] }, // gid 空串不命中
    G2: { gid: "G2", frozen: false, entries: [{ text: "无id", status: "todo", dispatch_id: "dp-1" }] }, // entry 缺 id 不命中
  };
  deepEq(jumpTargetOf(item, { boards, sessions: [{ session_id: "s-fallback" }], srcId: "x" }), { type: "session", sid: "s-fallback" }, "全不命中应落降级");
});

ok("S4.9 幂等重放：同输入恒同输出（确定性判定）", () => {
  const item = n({ key: "a", sourceContext: { domain: "dispatch", entityId: "dp-1", sessionId: "s1", alertId: "a", returnPath: "" } });
  const ctx = { sessions: [{ session_id: "s1", src: "src1" }], srcId: "src1", boards: { G1: { gid: "G1", frozen: false, entries: [{ id: "e1", text: "甲", status: "todo", dispatch_id: "dp-1" }] } } };
  deepEq(jumpTargetOf(item, ctx), jumpTargetOf(item, ctx));
});

// ---------- S5 与 badge 口径互补（badge 面不回退） ----------
console.log("S5 与 badge 口径互补（pending 全在 main 区）");

ok("S5.1 pending 行全部落在 main 区（badge 计数面不因分区回退）", () => {
  const rows = [
    n({ key: "p1" }),
    n({ key: "d1", handled_at: 1 }),
    n({ key: "p2" }),
    n({ key: "p3", actionable: false }), // 只读未处理行：非 pending 但也在 main
    n({ key: "d2", resolved_at: 2 }),
  ];
  const { main, resolved } = splitResolvedRows(rows, notifDoneAt);
  const pending = notifActionableOf(rows).map((x) => x.key);
  const mainKeys = new Set(main.map((r) => r.key));
  for (const k of pending) check(mainKeys.has(k), `pending 行 ${k} 应在 main 区`);
  check(mainKeys.size >= pending.length, "main 区至少含全部 pending");
  check(resolved.every((r) => !mainKeys.has(r.key)), "resolved 行不得回流 main");
});

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  console.log(`failed: ${fail.join(" | ")}`);
  process.exit(1);
}
