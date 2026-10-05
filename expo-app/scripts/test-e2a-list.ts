// E2a 列表只读投影直跑测试（worker H / #018-E2a）。
//
// 实际直跑入口（两处均可，任选其一）：
//   relay 目录：   node --import tsx ../expo-app/scripts/test-e2a-list.ts
//   expo-app 目录：node --import tsx scripts/test-e2a-list.ts
// （tsx 装在 relay/node_modules，--import 的解析以 cwd 为基准，故 relay 目录跑最稳）
//
// 原理：ListScreen.tsx 是 RN 组件模块，node 无法直接加载（react-native index.js
// 是 Flow 语法、expo 系原生包、.png 资产 require）。本测试先用 module.registerHooks
// 注册模块桩——全部原生/图形依赖指到万能 magic proxy、.png 返回空模块——再动态
// import 纯投影函数段（splitPending / activityMetricsOf / buildListProjection /
// sourcePalette，零 RN 运行时依赖）。被测路径不触任何桩值。
//
// 注意：store.ts 顶层 new RelayStore() 起 5s 巡检 interval，末尾必须 process.exit。

// expo tsconfig 不含 node types（@types/node 未进 types 字段）——仅本测试脚本
// 用 node:module；运行时 node ≥22.15 自带 registerHooks。钩子形参手工标型
//（模块解析失败时绑定退化为 any，显式类型兜住 implicit-any 报错）
// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}

// ---------- RN/原生依赖桩层 ----------
const STUB_BASES = new Set([
  "react-native", // Flow 语法 index.js，esbuild/tsx 无法解析
  "@react-native-async-storage",
  "react-native-safe-area-context",
  "react-native-svg",
  "react-native-webview",
  "expo", // 含 expo/fetch 子路径
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

// 全 src 依赖图的命名导入并集（type 导入已被擦除不列）；多给无害，漏给会在
// 链接期报 "does not provide an export named" 直观补
const STUB_NAMES = [
  "Alert", "Animated", "AppState", "DeviceEventEmitter", "Dimensions", "FlatList",
  "Fragment", "Image", "Keyboard", "Linking", "Modal", "PanResponder",
  "PermissionsAndroid", "Platform", "Pressable", "RefreshControl", "SafeAreaView",
  "ScrollView", "Share", "StyleSheet", "Switch", "Text", "TextInput", "Vibration",
  "View", "useSafeAreaInsets", "requireOptionalNativeModule", "fetch",
  "getRandomBytes", "getStringAsync", "setStringAsync", "CameraView",
  "BarcodeScanningResult", "LinearGradient", "WebView", "Svg", "Circle", "Rect",
];

// 万能 magic proxy：可调用/可 new/可取任意属性；then 返回永不定案 promise
//（store 顶层 fire-and-forget 异步链静默挂起，不阻塞加载）；可迭代（立即结束）
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

const hooks: ModuleHooks = {
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
};
registerHooks(hooks);

// ---------- 被测模块（纯投影函数段） ----------
// tsx 把 .ts 按 CJS 变换（expo-app 无 "type": "module"），顶层 await 不可用——
// 动态 import 与全部断言收进 main()
import type { SessionState, ActivityCapabilities } from "../src/protocol.ts";
type ProjectionRow = import("../src/screens/ListScreen.tsx").ProjectionRow;

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const list = await import("../src/screens/ListScreen.tsx");
  const { splitPending, activityMetricsOf, buildListProjection, sourcePalette } = list;

// ---------- fixture ----------
const caps = (on: Partial<ActivityCapabilities> = {}): ActivityCapabilities => ({
  native_status: false,
  operation_summary: false,
  native_elapsed: false,
  approval: false,
  ...on,
});

const baseSession = (over: Partial<SessionState> = {}): SessionState => ({
  session_id: "s1",
  relay_session_id: "r1",
  cwd: "/tmp/project",
  initial_prompt: "",
  title: "任务会话",
  model: "claude",
  status: "DONE",
  action_summary: "",
  started_at: 100,
  updated_at: 100,
  stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
  ...over,
});

const sess = (id: string, status: SessionState["status"], src?: string, updated_at = 100): SessionState =>
  baseSession({
    session_id: id, status, src, updated_at,
    // #018-E2a-up 富版口径：裸 WAITING（无 waiting_request）= 脱钩帧不占待处理，
    // 本套 WAITING fixture 一律视作可决策卡——互斥/计数/分组断言语义不变；五型
    // 判定/降级/通知 grounding 细则归 relay/scripts/test-e2a-queue.ts fixture
    ...(status === "WAITING"
      ? { waiting_request: { request_id: `r-${id}`, tool_name: "Bash", input_summary: "", suggestions: [] } }
      : {}),
  });

const withActivity = (capability: ActivityCapabilities, over: Partial<SessionState> = {}): SessionState =>
  baseSession({
    activity_capabilities: capability,
    activity: {
      state: "WORKING",
      activity: { kind: "tool_use", text: "npm test", tool: "Bash", observed_at: 500 },
      elapsed_ms: 65000,
      capabilities: capability,
      updated_at: 500,
    },
    ...over,
  });

const SRC_FIX = [
  { id: "srcA", name: "公司 iMac", state: "online", colorKey: "ck-a" },
  { id: "srcB", name: "家里 Mac mini", state: "offline", colorKey: "ck-b" },
];

// ---------- ① 单流互斥：待处理置顶 + 重复 id 过滤 ----------
{
  const mixed = [
    sess("dup", "WAITING", undefined, 300),
    sess("w2", "WAITING", undefined, 200),
    sess("dup", "DONE", undefined, 900), // 重复 id：同 sid 第二次出现必须被滤
    sess("d1", "DONE", undefined, 100),
  ];
  const sp = splitPending(mixed);
  check(sp.pending.length === 2 && sp.others.length === 1, "① split 计数：待处理2+其他1");
  check(sp.pending.every((s) => s.status === "WAITING"), "① 待处理组全为 WAITING");
  const ids = [...sp.pending, ...sp.others].map((s) => s.session_id);
  check(new Set(ids).size === ids.length, "① 同一 sid 全局只出现一次（互斥）");
  check(ids.filter((id) => id === "dup").length === 1, "① 重复 id 过滤为一张卡");
  // 投影级行 key 唯一（FlatList keyExtractor 无碰撞）
  const proj = buildListProjection({ sessions: mixed, aggregate: false, sources: [], sourceActivityCap: false });
  const cardIds = proj.filter((r) => r.kind === "card").map((r) => r.key);
  check(new Set(cardIds).size === cardIds.length, "① 投影行 key 无重复");
  check(cardIds.length === 3, "① 投影卡数=去重后会话数");
}

// ---------- ② 组头计数 = 实际渲染卡数 ----------
{
  // 遍历行序：每个段头/组头之后紧跟的卡数必须等于头上的 count
  const headerCountsMatch = (rows: ProjectionRow[]): boolean => {
    let cur: { count: number; n: number } | null = null;
    for (const r of rows) {
      if (r.kind === "card") {
        if (!cur) return false;
        cur.n += 1;
      } else {
        if (cur && cur.n !== cur.count) return false;
        cur = { count: r.count, n: 0 };
      }
    }
    return !cur || cur.n === cur.count;
  };

  const flat = buildListProjection({
    sessions: [sess("w1", "WAITING"), sess("d1", "DONE"), sess("d2", "DONE"), sess("d3", "ERROR")],
    aggregate: false,
    sources: [],
    sourceActivityCap: false,
  });
  check(headerCountsMatch(flat), "② 平铺态组头计数=实际卡数");
  const isSec = (r: ProjectionRow, label: string): r is Extract<ProjectionRow, { kind: "section" }> =>
    r.kind === "section" && r.label === label;
  const pendSec = flat.find((r) => isSec(r, "待处理"));
  const othSec = flat.find((r) => isSec(r, "其他会话"));
  check(pendSec?.count === 1, "② 待处理段计数 1");
  check(othSec?.count === 3, "② 其他会话段计数 3（不是原始数组长度 4）");

  const grouped = buildListProjection({
    sessions: [sess("a1", "WAITING", "srcA"), sess("a2", "DONE", "srcA"), sess("b1", "DONE", "srcB"), sess("b2", "ERROR", "srcB")],
    aggregate: true,
    sources: SRC_FIX,
    sourceActivityCap: true,
  });
  check(headerCountsMatch(grouped), "② 分组态组头计数=实际卡数");
}

// ---------- ③ 活动行门控：四行按 capability 显隐，activity 缺失整块不渲染 ----------
{
  check(activityMetricsOf(baseSession()) === null, "③ activity 缺失 → null（整块不渲染）");

  const waitingReq = { request_id: "r1", tool_name: "Bash", input_summary: "rm -rf /", suggestions: [] };
  const full = activityMetricsOf(withActivity(caps({ native_status: true, operation_summary: true, native_elapsed: true, approval: true }), { waiting_request: waitingReq as never }))!;
  check(full.state === "WORKING", "③ native_status 开 → state 在");
  check(full.summary === "npm test", "③ operation_summary 开 → activity.text 在");
  check(full.elapsedMs === 65000, "③ native_elapsed 开 → elapsed_ms 在");
  check(full.approvalPending === true, "③ approval 开 + waiting_request → 待审批");

  const onlyStatus = activityMetricsOf(withActivity(caps({ native_status: true })))!;
  check(onlyStatus.state === "WORKING", "③ 单能力：status 在");
  check(onlyStatus.summary === undefined && onlyStatus.elapsedMs === undefined && onlyStatus.approvalPending === undefined, "③ 单能力：其余三行缺省（不渲染）");

  const legacyAllOff = activityMetricsOf(withActivity(caps()))!;
  check(
    legacyAllOff.state === undefined && legacyAllOff.summary === undefined && legacyAllOff.elapsedMs === undefined && legacyAllOff.approvalPending === undefined,
    "③ legacy 归一化能力全关 → 空块（渲染层不渲染）",
  );

  const noElapsed = activityMetricsOf(withActivity(caps({ native_elapsed: true }), {
    activity: { state: "DONE", capabilities: caps({ native_elapsed: true }), updated_at: 1 },
  }))!;
  check(noElapsed.elapsedMs === undefined, "③ 能力开但 elapsed_ms 缺失 → 不出行（不出假 0）");

  const approvalIdle = activityMetricsOf(withActivity(caps({ approval: true })))!;
  check(approvalIdle.approvalPending === false, "③ approval 开、无 waiting_request → 显「—」非待审批");
}

// ---------- ④ 源模式：单源直列 / 聚合分组 / legacy 降级「—」占位 ----------
{
  // 单源模式（aggregate=false）：直列，无源组
  const single = buildListProjection({
    sessions: [sess("s1", "WAITING", "srcA"), sess("s2", "DONE", "srcA")],
    aggregate: false,
    sources: [SRC_FIX[0]],
    sourceActivityCap: true,
  });
  check(single.every((r) => r.kind !== "source"), "④ 单源模式无源分组头");
  check(single.some((r) => r.kind === "section" && r.label === "待处理" && r.count === 1), "④ 单源待处理段");
  check(single.some((r) => r.kind === "section" && r.label === "其他会话" && r.count === 1), "④ 单源其他会话段");

  // 聚合单源（sources.length===1）：分组无意义 → 直列
  const soloAgg = buildListProjection({
    sessions: [sess("s1", "DONE", "srcA")],
    aggregate: true,
    sources: [SRC_FIX[0]],
    sourceActivityCap: true,
  });
  check(soloAgg.every((r) => r.kind !== "source"), "④ 聚合但仅单源 → 直列不分组");

  // 聚合多源 + 新 relay → 按源分组（组头=源名/在线/实际计数），待处理仍置顶
  const grouped = buildListProjection({
    sessions: [sess("a2", "DONE", "srcA"), sess("b1", "DONE", "srcB"), sess("a1", "WAITING", "srcA")],
    aggregate: true,
    sources: SRC_FIX,
    sourceActivityCap: true,
  });
  const heads = grouped.filter((r) => r.kind === "source") as Extract<ProjectionRow, { kind: "source" }>[];
  check(heads.length === 2, "④ 聚合分组两源两组头");
  check(heads[0].name === "公司 iMac" && heads[0].online === true && heads[0].count === 1, "④ srcA 组头：名/在线/计数");
  check(heads[1].name === "家里 Mac mini" && heads[1].online === false && heads[1].count === 1, "④ srcB 组头：名/离线/计数");
  check(grouped[0].kind === "section" && grouped[0].label === "待处理", "④ 待处理段仍置顶");
  const groupOf = (sid: string): string => {
    let cur = "";
    for (const r of grouped) {
      if (r.kind !== "card") cur = r.key; // 段头/组头都算「当前组」
      if (r.kind === "card" && r.key === sid) return cur;
    }
    return "";
  };
  check(groupOf("a1") === "sec-pending", "④ WAITING 卡在待处理段（不入源组）");
  check(groupOf("a2") === "src-srcA", "④ DONE 卡归 srcA 组");
  check(groupOf("b1") === "src-srcB", "④ DONE 卡归 srcB 组");

  // 聚合多源 + legacy（能力缺失）→ 单一「—」占位组平铺，不隐藏结构、卡不丢
  const legacy = buildListProjection({
    sessions: [sess("x1", "DONE", "srcA"), sess("x2", "ERROR", "srcB"), sess("x0", "WAITING", "srcA")],
    aggregate: true,
    sources: SRC_FIX,
    sourceActivityCap: false,
  });
  const legacyHeads = legacy.filter((r) => r.kind === "source") as Extract<ProjectionRow, { kind: "source" }>[];
  check(legacyHeads.length === 1 && legacyHeads[0].name === "—", "④ legacy 聚合 → 「—」占位组");
  check(legacyHeads[0].count === 2 && legacy.filter((r) => r.kind === "card").length === 3, "④ 降级不丢卡、计数照实（待处理不计入降级组）");
  check(!legacy.some((r) => r.kind === "section" && r.label === "其他会话"), "④ 降级组替代平铺段（结构保留）");
  check(legacy.some((r) => r.kind === "section" && r.label === "待处理"), "④ 降级态待处理段仍在");
  // sourceActivityCap 缺省语义同 legacy（undefined → false 传入），此处断言 false 显式等价
  const legacyToo = buildListProjection({
    sessions: [sess("x1", "DONE", "srcA")],
    aggregate: true,
    sources: SRC_FIX,
    sourceActivityCap: undefined as unknown as boolean,
  });
  check(legacyToo.some((r) => r.kind === "source" && r.name === "—"), "④ legacy 缺省（undefined）同降级");

  // 聚合分组下无 src / 源已不在列表 → 「—」占位组殿后
  const orphan = buildListProjection({
    sessions: [sess("k1", "DONE", "srcA"), sess("k2", "DONE"), sess("k3", "DONE", "gone")],
    aggregate: true,
    sources: SRC_FIX,
    sourceActivityCap: true,
  });
  const unknown = orphan.filter((r) => r.kind === "source" && r.srcId === null) as Extract<ProjectionRow, { kind: "source" }>[];
  check(unknown.length === 1 && unknown[0].name === "—" && unknown[0].count === 2, "④ 无 src/源已删 → 「—」组收容 2 卡");
  check(orphan[orphan.length - 1].kind === "card" && (orphan[orphan.length - 1] as { s?: SessionState }).s?.session_id === "k3", "④ 「—」组殿后");
}

// ---------- ⑤ 源配色稳定性（分组头与逐卡角标共用） ----------
{
  const p1 = sourcePalette(SRC_FIX);
  const p2 = sourcePalette([...SRC_FIX].reverse());
  check(p1.get("srcA") === p2.get("srcA") && p1.get("srcB") === p2.get("srcB"), "⑤ palette 与输入顺序无关");
  check(p1.get("srcA") !== p1.get("srcB"), "⑤ 同屏两源异色");
}

  console.log(`E2a list projection tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 起了 5s 巡检 interval（原生桩的 AppState 也不触发卸载），
  // 显式退出防挂
  .finally(() => process.exit(0));
