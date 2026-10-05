// #018-E2a-up：Expo 第二列单流投影富版 fixture 直跑测试（worker G）。
// 被测对象 = expo-app/src/screens/ListScreen.tsx 的 E2A-QUEUE 纯函数段
//（queueFlagsOf 五标志 / QUEUE_REASON_ORDER / splitPending 单流两组）+
// buildListProjection 集成面（段头计数=过滤后渲染卡数）。
// fixture 语义与 W1a Web 同套（018 §2.1.1/:130：queuePartition 非共享代码层，
// Web/Expo 各自实现但使用相同 fixture）：互斥 / 组头计数 / needs_action 五型 /
// 旧 relay 降级 / 通知 grounding / 结构闸。断言时间无 Date.now 跨取时点比对
//（fixture 全定值 updated_at）；本测试零文件写入（模块直跑，无 mkdtemp 面）。
// 直跑入口（relay 目录，E 线惯例）：
//   env -u CCR_ORG_DIR node --import tsx scripts/test-e2a-queue.ts
//
// 原理：ListScreen.tsx 是 RN 组件模块，node 无法直接加载（react-native index.js
// 是 Flow 语法、expo 系原生包、.png 资产 require）。registerHooks 注册模块桩——
// 原生/图形依赖指万能 magic proxy、.png 返回空模块——再动态 import 取纯投影段
//（expo-app/scripts/test-e2a-list.ts 同套路）。spec 用计算拼接串：relay tsc 不
// 顺 import 图谱去查 expo 侧 TSX（RN 类型在 expo node_modules，relay tsconfig
// 无 jsx 配置会误报），运行时 tsx 按相对路径正常解析。
//
// 注意：store.ts 顶层 new RelayStore() 起 5s 巡检 interval，末尾必须 process.exit。

// node:module registerHooks 形参类型随 node 版本浮动（LoadHookSync 签名差异）——
// hooks 以对象字面量直传 registerHooks 走上下文推断，不手写形参类型防签名漂移
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------- RN/原生依赖桩层（test-e2a-list.ts 同套） ----------
const STUB_BASES = new Set([
  "react-native",
  "@react-native-async-storage",
  "react-native-safe-area-context",
  "react-native-svg",
  "react-native-webview",
  "expo",
  "expo-constants",
  "expo-crypto",
  "expo-clipboard",
  "expo-file-system",
  "expo-intent-launcher",
  "expo-sharing",
  "expo-linear-gradient",
  "expo-image-picker",
  "expo-image-manipulator",
  "expo-document-picker",
  "expo-camera",
]);

const STUB_NAMES = [
  "Alert", "Animated", "AppState", "DeviceEventEmitter", "Dimensions", "FlatList",
  "Fragment", "Image", "Keyboard", "Linking", "Modal", "PanResponder",
  "PermissionsAndroid", "Platform", "Pressable", "RefreshControl", "SafeAreaView",
  "ScrollView", "Share", "StyleSheet", "Switch", "Text", "TextInput", "Vibration",
  "View", "useSafeAreaInsets", "requireOptionalNativeModule", "fetch",
  "getRandomBytes", "getStringAsync", "setStringAsync", "CameraView",
  "BarcodeScanningResult", "LinearGradient", "WebView", "Svg", "Circle", "Rect",
];

// 万能 magic proxy：可调用/可 new/可取任意属性；then 永不定案（顶层异步链挂起
// 不阻塞加载）；可迭代（立即结束）
const MAGIC_SRC = `
const magic = (() => {
  let m;
  const fn = function () { return m; };
  m = new Proxy(fn, {
    get(_t, p) {
      if (p === "then") return () => new Promise(() => {});
      if (p === "catch" || p === "finally") return () => new Promise(() => {});
      if (p === "prototype") return fn.prototype;
      if (p === "length") return 0;
      if (p === "name") return "stub";
      if (p === Symbol.toPrimitive || p === "toString") return () => "";
      if (p === Symbol.toStringTag) return "Stub";
      if (p === Symbol.iterator) return () => ({ next: () => ({ done: true, value: undefined }) });
      return m;
    },
    apply() { return m; },
    construct() { return {}; },
  });
  return m;
})();
export default magic;
${STUB_NAMES.map((n) => `export const ${n} = magic;`).join("\n")}
`;

// 对象字面量直传：resolve/load 形参类型由 registerHooks 参数位上下文推断
registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (STUB_BASES.has(base)) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: MAGIC_SRC, shortCircuit: true };
    if (url.endsWith(".png") || url.endsWith(".ttf")) return { format: "module", source: "export default null;", shortCircuit: true };
    return nextLoad(url, context);
  },
});

// ---------- 断言器（throw-on-first-fail，E2a 套同款） ----------
let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

// ---------- fixture 类型（结构性局部类型；被测函数经 any 面取回） ----------
type Sess = {
  session_id: string;
  status?: string;
  waiting_request?: unknown;
  last_task_done?: unknown;
  activity?: unknown;
  updated_at?: number;
  started_at?: number;
  src?: string;
  title?: string;
};
type QueueFlagsT = {
  needs_action: boolean; is_working: boolean; needs_acceptance: boolean; is_other: boolean; reason: string;
};
type Row = { kind: string; key: string; label?: string; count?: number; s?: Sess };
interface ListApi {
  QUEUE_REASON_ORDER: Record<string, number>;
  queueFlagsOf(s: unknown, notifActionable?: boolean): QueueFlagsT;
  splitPending(sessions: unknown, opts?: unknown): { pending: Sess[]; others: Sess[]; flags: Map<string, QueueFlagsT> };
  buildListProjection(p: unknown): Row[];
}

const LIST_TSX = "../../expo-app/" + "src/screens/ListScreen.tsx"; // 计算拼接：relay tsc 不查 expo 侧 TSX
const LIST_SRC_PATH = fileURLToPath(new URL(LIST_TSX, import.meta.url));

const sess = (id: string, status: string, over: Partial<Sess> = {}): Sess =>
  ({ session_id: id, status, updated_at: 100, ...over });

async function main(): Promise<void> {
  const api = (await import(LIST_TSX)) as ListApi;
  const { queueFlagsOf, splitPending, buildListProjection, QUEUE_REASON_ORDER } = api;
  check(typeof queueFlagsOf === "function" && typeof splitPending === "function"
    && typeof buildListProjection === "function",
    "锚点⓪ E2A-QUEUE 纯函数段可直跑（queueFlagsOf/splitPending/buildListProjection 导出在位）");
  check(QUEUE_REASON_ORDER.waiting === 0 && QUEUE_REASON_ORDER.acceptance === 1
    && QUEUE_REASON_ORDER.notification === 2 && QUEUE_REASON_ORDER.working === 3,
    "锚点⓪ QUEUE_REASON_ORDER 四级序与 W1a 同值（waiting>acceptance>notification>working）");

  // ---------- ① 单流互斥：同 id 首见优先 + 组内序（fixture 对齐 W1a ①） ----------
  {
    const mixed: Sess[] = [
      sess("w2", "WAITING", { waiting_request: { tool_name: "Bash" }, updated_at: 300 }),
      sess("dup", "WAITING", { waiting_request: { tool_name: "Edit" }, updated_at: 200 }),
      sess("dup", "DONE", { updated_at: 900 }), // 同 id 二次出现必须被滤（首见优先）
      sess("d1", "DONE", { updated_at: 100 }),
    ];
    const q = splitPending(mixed);
    check(q.pending.length === 2 && q.others.length === 1, "① 分区计数：待处理2+其他1（重复 id 先滤再计）");
    check(q.pending.every((s) => s.status === "WAITING"), "① 待处理组全为可决策 WAITING");
    const ids = [...q.pending, ...q.others].map((s) => s.session_id);
    check(new Set(ids).size === ids.length, "① 同一 session_id 全局只出现一次（两组互斥）");
    check(ids.filter((id) => id === "dup").length === 1 && q.pending[1]?.session_id === "dup",
      "① 重复 id 收敛一张卡且保首见（WAITING@200 胜后见 DONE@900）");
    check(q.pending[0]?.session_id === "w2", "① 待处理组内按 updated_at 倒序（w2@300 > dup@200）");
    // 多源复合键（对齐 W1a keyOf 注入语义）：跨源同 id 各自成卡
    const twoSrc: Sess[] = [sess("s9", "DONE", { updated_at: 100 }), sess("s9", "DONE", { updated_at: 200 })];
    const qm = splitPending(twoSrc, { keyOf: (s: object) => "src" + (s as Sess).updated_at + "/" + (s as Sess).session_id });
    check(qm.others.length === 2 && qm.pending.length === 0, "① 注入 keyOf：跨源同 id 各自成卡");
    check(splitPending(twoSrc).others.length === 1, "① 默认键 session_id：同 id 仍互斥");
    const o2 = splitPending([sess("o1", "DONE", { updated_at: 50 }), sess("o2", "ERROR", { updated_at: 70 })]);
    check(o2.others[0]?.session_id === "o2", "① 其他会话组按 updated_at 倒序");
    const qe = splitPending("junk" as unknown as Sess[]);
    check(qe.pending.length === 0 && qe.others.length === 0 && qe.flags.size === 0,
      "① 非数组入参 → 空两组空 flags（降级不崩）");
  }

  // ---------- ② 组头计数 = 过滤后实际渲染卡数（018 §2.1.1 硬条款，W1a ② 同套） ----------
  {
    const headerCountsMatch = (rows: Row[]): boolean => {
      let cur: { count: number; n: number } | null = null;
      for (const r of rows) {
        if (r.kind === "card") {
          if (!cur) return false;
          cur.n += 1;
        } else {
          if (cur && cur.n !== cur.count) return false;
          cur = { count: r.count ?? 0, n: 0 };
        }
      }
      return !cur || cur.n === cur.count;
    };
    // 调用方时序模拟：先筛选后进投影——段头计数随筛选收缩，绝不用源总数
    const full: Sess[] = [
      sess("w1", "WAITING", { waiting_request: {}, updated_at: 400 }),
      sess("w2", "WAITING", { waiting_request: {}, updated_at: 300 }),
      sess("k1", "DONE", { updated_at: 200 }),
      sess("k2", "DONE", { updated_at: 100 }),
    ];
    const flat = buildListProjection({ sessions: full, aggregate: false, sources: [], sourceActivityCap: false });
    check(headerCountsMatch(flat), "② 平铺态段头计数=实际渲染卡数（逐头核账）");
    const filtered = full.filter((s) => s.session_id !== "k2"); // 调用方先把筛选做完
    const qF = splitPending(filtered);
    check(qF.pending.length + qF.others.length === filtered.length && qF.others.length === 1,
      "② 过滤后：两组合计=过滤后集合（源总数 4 不出现）");
    // decidable:false 的 WAITING 是脱钩帧——不占待处理（真实可决策才计数）
    const mixedW: Sess[] = [
      sess("w1", "WAITING", { waiting_request: {} }),
      sess("w2", "WAITING", { waiting_request: { decidable: false } }),
      sess("d1", "DONE"),
      sess("d2", "ERROR"),
    ];
    const qW = splitPending(mixedW);
    check(qW.pending.length === 1 && qW.pending[0]?.session_id === "w1",
      "② 组头计数=真实待处理卡数（decidable:false 不计入待处理）");
    check(qW.flags.size === 4 && [...qW.flags.values()].every((f) => typeof f.reason === "string"),
      "② flags 逐会话在账（每组会话各有五标志判定）");
    const emptyRows = buildListProjection({ sessions: [], aggregate: false, sources: [], sourceActivityCap: false });
    check(emptyRows.length === 0, "② 空流：零行（调用方不出段头，走空态提示）");
  }

  // ---------- ③ needs_action 五型占位边界（018 §2.1.1 推荐分组规则，W1a ③ 同套） ----------
  {
    const q1 = queueFlagsOf(sess("a", "WAITING", { waiting_request: { tool_name: "Bash" } }));
    check(q1.needs_action && !q1.is_other && q1.reason === "waiting",
      "③ 真实 WAITING 可决策 → 待处理 reason=waiting");
    const q2 = queueFlagsOf(sess("b", "WAITING"));
    check(!q2.needs_action && q2.is_other && q2.reason === "other",
      "③ WAITING 但无 waiting_request（脱钩帧）→ 不占待处理");
    const q3 = queueFlagsOf(sess("c", "WAITING", { waiting_request: { decidable: false } }));
    check(!q3.needs_action && q3.is_other, "③ WAITING + decidable:false → 不可决策不占位");
    const q4 = queueFlagsOf(sess("d", "DONE", { last_task_done: { done: ["x"], remaining_count: 0, ts: 1 } }));
    check(q4.needs_action && q4.needs_acceptance && q4.reason === "acceptance",
      "③ 待验收类持久行动（last_task_done）→ 待处理 reason=acceptance");
    const q5 = queueFlagsOf(sess("n1", "DONE"), true);
    check(q5.needs_action && q5.reason === "notification" && !q5.needs_acceptance,
      "③ 会话级通知要求动作 → 待处理 reason=notification（分区侧 grounding 见⑤）");
    const q8 = queueFlagsOf(sess("g", "WORKING", { activity: { activity: { text: "npm test", tool: "Bash" } } }));
    check(!q8.needs_action && !q8.is_other && q8.is_working && q8.reason === "working",
      "③ WORKING 确有可观察工作状态 → 待处理 reason=working（needs_action 仍 false：信息位非行动位）");
    const q8t = queueFlagsOf(sess("h", "WORKING", { activity: { activity: { tool: "Read" } } }));
    check(!q8t.is_other, "③ WORKING 仅工具名在（无正文）→ 仍算可观察工作状态");
    const q9 = queueFlagsOf(sess("i", "WORKING"));
    check(q9.is_working && q9.is_other && q9.reason === "other",
      "③ 在线空转 WORKING（无活动证据）→ 其他会话（在线不占行动位）");
    const shape = queueFlagsOf(sess("j", "DONE"));
    check(shape.needs_action === false && shape.is_working === false && shape.needs_acceptance === false
      && shape.is_other === true && shape.reason === "other",
      "③ queue_flags 五标志齐（needs_action/is_working/needs_acceptance/is_other/reason）");
    // 同会话多型并存的 reason 优先级：可决策 WAITING 压过待验收/通知/工作
    const qmix = queueFlagsOf(sess("m", "WAITING", {
      waiting_request: { tool_name: "Bash" },
      last_task_done: { done: ["x"], remaining_count: 1, ts: 2 },
      activity: { activity: { text: "wait-ctx" } },
    }), true);
    check(qmix.reason === "waiting" && qmix.needs_acceptance,
      "③ 多型并存 reason 取高优先（waiting 压 acceptance/notification/working）");
    const p1 = splitPending([
      sess("pW", "WAITING", { waiting_request: {}, updated_at: 1 }),
      sess("pA", "DONE", { last_task_done: { done: [], remaining_count: 0, ts: 1 }, updated_at: 900 }),
      sess("pN", "DONE", { updated_at: 800 }),
      sess("pK", "WORKING", { activity: { activity: { text: "npm test" } }, updated_at: 700 }),
    ], { notifications: [{ actionable: true, sourceContext: { sessionId: "pN" } }] });
    check(JSON.stringify(p1.pending.map((s) => s.session_id)) === JSON.stringify(["pW", "pA", "pN", "pK"]),
      "③ 分区序=reason 优先级（waiting>acceptance>notification>working，非 updated_at 裸序）");
  }

  // ---------- ④ 旧 relay 缺字段降级（不崩、不伪造，W1a ④ 同套） ----------
  {
    const q1 = queueFlagsOf({ session_id: "x", updated_at: 1 } as Sess);
    check(q1.is_other && q1.reason === "other" && !q1.needs_action, "④ 降级① 无 status 字段 → 安全落其他会话");
    const q2 = queueFlagsOf(sess("y", "WORKING", { activity: "junk-string" }));
    check(q2.is_other && !q2.needs_action, "④ 降级② activity 畸形（非对象）→ 不伪造工作状态，落其他");
    const q3 = splitPending([sess("z", "DONE", { last_task_done: { ts: 9 } })], { notifications: "junk" });
    check(q3.pending.length === 1, "④ 降级③ 通知池非数组 → 按空池处理，其余判定不受牵连");
    const q4 = queueFlagsOf(sess("w", "DONE", { last_task_done: "junk" }));
    check(!q4.needs_acceptance && q4.is_other, "④ 降级④ last_task_done 畸形（非对象）→ 不判待验收");
    const q5 = queueFlagsOf(sess("v", "WAITING", { waiting_request: "junk" }));
    check(!q5.needs_action && q5.is_other, "④ 降级⑤ waiting_request 畸形（非对象）→ 不判可决策");
    const q6 = splitPending([sess("m", "WAITING", { waiting_request: {} }), null, undefined] as unknown as Sess[]);
    check(q6.pending.length === 1 && q6.others.length === 0, "④ null/undefined 条目混入 → 跳过不崩，正常会话照常分区");
    const q7 = queueFlagsOf(sess("u", "WORKING", { activity: { activity: { text: 42, tool: 7 } } }));
    check(q7.is_other, "④ 降级⑥ activity 内层 text/tool 类型畸形 → 不算可观察工作状态（不伪造）");
  }

  // ---------- ⑤ 通知 grounding（actionable × 未决 × 绑定本会话三条件，W1a ③通知面同套） ----------
  {
    const notif = [{ actionable: true, sourceContext: { sessionId: "n1" } }];
    const q5p = splitPending([sess("n1", "DONE")], { notifications: notif });
    check(q5p.pending.length === 1 && q5p.flags.get("n1")?.reason === "notification",
      "⑤ actionable 未决通知绑定本会话 → 提入待处理 reason=notification");
    const q6 = splitPending([sess("n1", "DONE")], { notifications: [{ actionable: true, resolved_at: 5, sourceContext: { sessionId: "n1" } }] });
    check(q6.pending.length === 0, "⑤ 已 resolved 通知不再要求动作（不占待处理）");
    const q7 = splitPending([sess("n2", "DONE")], { notifications: notif });
    check(q7.pending.length === 0, "⑤ 通知绑定他人 session → 本会话不占位");
    const q8 = splitPending([sess("n3", "DONE")], { notifications: [{ actionable: true, sourceContext: "junk" }] });
    check(q8.pending.length === 0, "⑤ sourceContext 畸形（无 sessionId）→ 不占位（grounding 三条件缺一不占）");
    const q9 = splitPending([sess("n1", "DONE")], { notifications: [{ actionable: false, sourceContext: { sessionId: "n1" } }, null, ...notif] });
    check(q9.pending.length === 1, "⑤ 池内非 actionable/畸形条目跳过，有效条目仍生效");
  }

  // ---------- ⑥ 结构闸：纯函数段零 RN 依赖 + 集成面（018 §2.1.1 计数纪律） ----------
  {
    const src = readFileSync(LIST_SRC_PATH, "utf8");
    const seg = /\/\* E2A-QUEUE-START \*\/([\s\S]*?)\/\* E2A-QUEUE-END \*\//.exec(src);
    check(!!seg && src.split("E2A-QUEUE-START").length === 2 && src.split("E2A-QUEUE-END").length === 2,
      "⑥ E2A-QUEUE 锚点段存在且 START/END 各只出现一次（提取无歧义）");
    const segCode = seg ? seg[1] : "";
    check(!/react-native|AsyncStorage|from "\.\.|require\(|Date\.now/i.test(segCode),
      "⑥ 投影段零 RN/store/时钟依赖（自包含纯函数可直跑）");
    // 集成面：buildListProjection 通知池接线 + 段头计数与 splitPending 输出一致
    const sessions: Sess[] = [
      sess("iw", "WAITING", { waiting_request: {}, src: "srcA", updated_at: 500 }),
      sess("in", "DONE", { src: "srcB", updated_at: 400 }),
      sess("id", "DONE", { src: "srcA", updated_at: 300 }),
    ];
    const pool = [{ actionable: true, sourceContext: { sessionId: "in" } }];
    const rows = buildListProjection({ sessions, aggregate: false, sources: [], sourceActivityCap: false, notifications: pool });
    const pendSec = rows.find((r) => r.kind === "section" && r.label === "待处理");
    const pendCards = rows.filter((r) => r.kind === "card" && r.key !== "id");
    check(!!pendSec && pendSec.count === 2 && pendCards.length === 2,
      "⑥ 集成：通知池经 buildListProjection 生效，待处理段头计数=实际渲染卡数（iw+in）");
    check(rows.some((r) => r.kind === "card" && r.key === "in" && r.s === sessions[1]),
      "⑥ 集成：通知提入卡原样引用会话对象（交互面/memo 引用不变前提保持）");
  }

  console.log(`E2a queue projection tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 起了 5s 巡检 interval（原生桩的 AppState 不触发卸载），
  // 显式退出防挂
  .finally(() => process.exit(0));
