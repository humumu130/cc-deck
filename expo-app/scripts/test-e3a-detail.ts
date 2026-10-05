// E3a 详情屏只读投影直跑测试（worker H / #018-E3a）。
//
// 直跑入口（tsx 装在 relay/node_modules，--import 解析以 cwd 为基准）：
//   relay 目录：node --import tsx ../expo-app/scripts/test-e3a-detail.ts
//
// 原理：DetailScreen.tsx 是 RN 组件模块，node 无法直接加载（react-native index.js
// 是 Flow 语法、expo 系原生包、.png 资产 require）。本测试先用 module.registerHooks
// 注册模块桩——全部原生/图形依赖指到万能 magic proxy、.png/.ttf 返回空模块——再动态
// import 纯投影函数段（dedupeWaitingBars / dockModelOf / closingBarOf /
// artExistenceOf / artifactRowsOf，零 RN 运行时依赖）。被测路径不触任何桩值。
//
// 注意：store.ts 顶层 new RelayStore() 起 5s 巡检 interval，末尾必须 process.exit。

// expo tsconfig 不含 node types（@types/node 未进 types 字段）——仅本测试脚本
// 用 node:module；运行时 node ≥22.15 自带 registerHooks。钩子形参手工标型
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
  "expo", // 含 expo/fetch、expo-file-system/legacy 子路径
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

// 全 src 依赖图的命名导入并集（type 导入已被擦除不列；DetailScreen 比 ListScreen
// 多 react-native-svg 的 Path 与 expo-constants 的 Constants）；多给无害，漏给会在
// 链接期报 "does not provide an export named" 直观补
const STUB_NAMES = [
  "Alert", "Animated", "AppState", "Constants", "DeviceEventEmitter", "Dimensions", "FlatList",
  "Fragment", "Image", "Keyboard", "Linking", "Modal", "PanResponder", "Path",
  "PermissionsAndroid", "Platform", "Pressable", "RefreshControl", "SafeAreaView",
  "ScrollView", "Share", "StyleSheet", "Switch", "Text", "TextInput", "Vibration",
  "View", "useSafeAreaInsets", "requireOptionalNativeModule", "fetch",
  "getRandomBytes", "getStringAsync", "setStringAsync", "CameraView",
  "BarcodeScanningResult", "LinearGradient", "WebView", "Svg", "Circle", "Rect",
  // DetailScreen 命名空间成员并集（* as X 的成员不查链接期、但顶层触点会运行期炸）：
  // expo-file-system/legacy 顶层启动恢复索引读 EncodingType.UTF8 + readAsStringAsync；
  // 其余为函数体内触点，一并补全免逐个撞
  "EncodingType", "cacheDirectory", "copyAsync", "deleteAsync", "getContentUriAsync",
  "makeDirectoryAsync", "readAsStringAsync", "writeAsStringAsync",
  "getDocumentAsync", "SaveFormat", "manipulateAsync", "launchImageLibraryAsync",
  "startActivityAsync", "isAvailableAsync", "shareAsync",
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
import type { SessionState, WaitingPayload, ArtifactItem, ActivityCapabilities } from "../src/protocol.ts";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const mod = await import("../src/screens/DetailScreen.tsx");
  const { dedupeWaitingBars, dockModelOf, closingBarOf, DONE_TAIL_MS, artExistenceOf, artifactRowsOf } = mod;

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

const wp = (over: Partial<WaitingPayload> = {}): WaitingPayload => ({
  request_id: "r1",
  tool_name: "Bash",
  input_summary: "rm -rf /tmp/x",
  suggestions: [],
  ...over,
});

const withDock = (capability: ActivityCapabilities, over: Partial<SessionState> = {}): SessionState =>
  baseSession({
    activity_capabilities: capability,
    activity: {
      state: "WORKING",
      task_summary: { text: "修 390 宽抖动", source: "todo", updated_at: 400 },
      activity: { kind: "tool_use", text: "npm test", tool: "Bash", observed_at: 500 },
      elapsed_ms: 65000,
      capabilities: capability,
      updated_at: 500,
    },
    ...over,
  });

const art = (path: string, over: Partial<ArtifactItem> = {}): ArtifactItem => ({
  path, op: "create", tools: ["Write"], adds: 1, dels: 0, first_at: 100, last_at: 100, ...over,
});

// B4a 分组扩展字段（协议缺口本地备案，relay 落库前 fixture 同款防御注入）
type B4 = { group_key?: string | null; directory_label?: string | null; existence_state?: "exists" | "missing" | "unknown" | null };
const withB4 = (t: ArtifactItem, b4: B4): ArtifactItem => ({ ...t, ...b4 } as ArtifactItem);

// #222 同款父目录派生（artDirOf 未导出，测试内同口径复刻；兼容 \ 与根散件空串）
const dirOf = (t: ArtifactItem): string => {
  const i = Math.max(t.path.lastIndexOf("/"), t.path.lastIndexOf("\\"));
  return i > 0 ? t.path.slice(0, i) : "";
};

// ---------- ① WAITING 去重：同 request 只一条 ----------
{
  const a = wp();
  const aDup = wp({ input_summary: "重投事件，内容已变" }); // 同 request_id 不同内容
  const b = wp({ request_id: "r2", tool_name: "ExitPlanMode", input_summary: "计划确认" });
  const out = dedupeWaitingBars([a, aDup, b]);
  check(out.length === 2, "① 同 id 两次只一条（2 请求 → 2 条）");
  check(out[0].request_id === "r1" && out[0].input_summary === "rm -rf /tmp/x", "① 首见优先（重投不覆盖首条）");
  check(out[1].request_id === "r2", "① 不同 id 各自保留");
  check(dedupeWaitingBars([null, undefined, a]).length === 1, "① 空值过滤");
  check(dedupeWaitingBars([]).length === 0, "① 空入参 → 空出（不渲染等待条）");
  // 缺 id 防御回退：received_at|tool 派生键同键去重、异键保留
  const noId = wp({ request_id: "" as never, received_at: 900 });
  const noIdDup = wp({ request_id: "" as never, received_at: 900, input_summary: "同键" });
  const noId2 = wp({ request_id: "" as never, received_at: 901 });
  const out2 = dedupeWaitingBars([noId, noIdDup, noId2]);
  check(out2.length === 2, "① 缺 id 走 received_at|tool 派生键去重");
  check(dedupeWaitingBars([a, undefined, null, aDup, a]).length === 1, "① 混合重投/空值序列稳定（同 id 三现只一条）");
}

// ---------- ② dock 四态 + 能力门控矩阵 + activity 缺失不渲染 ----------
{
  check(dockModelOf(baseSession()) === null, "② activity 缺失 → null（整舱不渲染，无假「空闲」）");
  check(dockModelOf(null) === null && dockModelOf(undefined) === null, "② 会话缺失 → null");
  check(dockModelOf(withDock(caps())) === null, "② legacy 能力全关 → 整舱不渲染");
  check(dockModelOf(withDock(caps(), { activity: { state: "IDLE" as never, capabilities: caps({ native_status: true }), updated_at: 1 } })) === null, "② 未知态（非四态）→ 不渲染");

  // 四态视觉区分：state + 图标两两可辨（渲染层再配色双通道）
  const four = (["WORKING", "WAITING", "DONE", "ERROR"] as const).map((st) =>
    dockModelOf(withDock(caps({ native_status: true }), { activity: { state: st, capabilities: caps({ native_status: true }), updated_at: 1 } }))!,
  );
  check(four.every((m) => m !== null), "② 四态均出舱（native_status 开）");
  check(new Set(four.map((m) => m.icon)).size === 4, "② 四态图标两两不同");
  check(four.map((m) => m.state).join(",") === "WORKING,WAITING,DONE,ERROR", "② 四态 state 透传");

  // 全能力开：状态行 + 任务摘要 + 当前活动 + 耗时全在
  const full = dockModelOf(withDock(caps({ native_status: true, operation_summary: true, native_elapsed: true })))!;
  check(full.state === "WORKING" && !!full.icon, "② 全能力：state/icon 在");
  check(full.summary === "修 390 宽抖动", "② operation_summary 开 → 任务摘要（task_summary.text）在");
  check(full.actText === "npm test" && full.actTool === "Bash" && full.actKind === "tool_use", "② 当前活动 kind/text/tool 全在");
  check(full.elapsedMs === 65000, "② native_elapsed 开 → 耗时在");

  // 门控矩阵：单能力逐项验证
  const onlyStatus = dockModelOf(withDock(caps({ native_status: true })))!;
  check(onlyStatus.summary === undefined && onlyStatus.actText === undefined && onlyStatus.elapsedMs === undefined, "② 仅 status：摘要/活动/耗时三行缺省");
  const noTs = dockModelOf(withDock(caps({ native_status: true, operation_summary: true }), {
    activity: { state: "WORKING", activity: { kind: "assistant_text", text: "说话", observed_at: 1 }, capabilities: caps(), updated_at: 1 },
  }))!;
  check(noTs.summary === undefined && noTs.actText === "说话" && noTs.actTool === undefined, "② 无 task_summary 不出假摘要；活动无 tool 不出假工具");
  const noElapsed = dockModelOf(withDock(caps({ native_status: true, native_elapsed: true }), {
    activity: { state: "WORKING", capabilities: caps(), updated_at: 1 },
  }))!;
  check(noElapsed.elapsedMs === undefined, "② 能力开但 elapsed_ms 缺数 → 不出行（不出假 0）");
  check(dockModelOf(withDock(caps({ operation_summary: true }))) === null, "② 核心能力（native_status）关 → 整舱不渲染（operation_summary 开也不出舱）");
}

// ---------- ③ artifact 分组：不透明 key 分桶 / label 展示 / 三态 open 开关 / 空态 ----------
{
  // 空态：无产物 → 零行（渲染层出「当前会话还没有文档产出」）
  check(artifactRowsOf([], dirOf).length === 0, "③ 空产物 → 零行（空态文案路径）");

  // B4a 不透明 key 分桶：g1 两文件、g2 单文件（relay 权威分组，单文件也照组渲染）
  const b4Rows = artifactRowsOf([
    withB4(art("/p/a/docs/r1.md", { last_at: 500 }), { group_key: "g1", directory_label: "报告目录" }),
    withB4(art("/p/elsewhere/r2.md", { last_at: 700 }), { group_key: "g1", directory_label: "报告目录" }),
    withB4(art("/p/single.md", { last_at: 300 }), { group_key: "g2" }),
  ], dirOf);
  const g = b4Rows.filter((r) => r.kind === "group") as Extract<typeof b4Rows[number], { kind: "group" }>[];
  check(g.length === 2, "③ B4a 按不透明 key 分两桶（与路径无关）");
  const g1 = g.find((x) => x.group.key === "g1")!;
  const g2 = g.find((x) => x.group.key === "g2")!;
  check(g1.group.files.length === 2 && g2.group.files.length === 1, "③ 组摘要计数=桶内文件数（单文件组保留）");
  check(g1.group.label === "报告目录" && g1.group.leaf === "报告目录", "③ directory_label 展示名生效");
  check(g2.group.label === "g2", "③ label 缺省回退不透明 key（不猜路径）");
  check(g1.at === 700 && g1.group.size === 0, "③ 组 at=组内最新（跨路径取 max）");
  check(g1.group.files[0].item.path === "/p/elsewhere/r2.md", "③ 组内按最近活跃降序");

  // 三态：unknown 不给打开按钮；missing 可开（sheet 内定格）；exists 可开
  const tri = artifactRowsOf([
    withB4(art("/x/a.md"), { group_key: "k", existence_state: "exists" }),
    withB4(art("/x/b.md"), { group_key: "k", existence_state: "missing" }),
    withB4(art("/x/c.md"), { group_key: "k", existence_state: "unknown" }),
    withB4(art("/x/d.md"), { group_key: "k", existence_state: null }),
  ], dirOf);
  const triGroup = tri.find((r) => r.kind === "group") as Extract<typeof tri[number], { kind: "group" }>;
  const ex = triGroup.group.files.map((f) => f.existence);
  const op = triGroup.group.files.map((f) => f.openable);
  check(ex.join(",") === "exists,missing,unknown,exists", "③ 三态归一（null → exists）");
  check(op.join(",") === "true,true,false,true", "③ open 开关：unknown=false，missing/exists=true（null 归一 exists 可开）");
  check(artExistenceOf(art("/x/e.md", { exists: false })) === "missing", "③ 旧 relay exists=false → missing（可开 sheet 看已删除）");
  check(artExistenceOf(art("/x/f.md")) === "exists", "③ 旧 relay 无字段 → exists（零回归）");
  check(artExistenceOf(art("/x/g.md", { exists: true })) === "exists", "③ exists=true → exists");
  check(artExistenceOf(withB4(art("/x/h.md"), { existence_state: "unknown" })) === "unknown", "③ unknown 只来自 B4a 显式下发");

  // 旧 relay 回退 #222：同目录 ≥2 聚组（lowercase 归一），单文件目录与根散件保持散行
  const legacy = artifactRowsOf([
    art("/p/proj/a.md", { last_at: 900 }),
    art("/p/proj/b.md", { last_at: 100 }),
    art("/p/lonely/c.md", { last_at: 800 }),
    art("/p/root.md", { last_at: 950 }),
  ], dirOf);
  const lg = legacy.filter((r) => r.kind === "group") as Extract<typeof legacy[number], { kind: "group" }>[];
  const lf = legacy.filter((r) => r.kind === "file");
  check(lg.length === 1 && lg[0].group.files.length === 2, "③ 旧口径：同目录 ≥2 才聚组");
  check(lg[0].group.label === "/p/proj" && lg[0].group.leaf === "proj", "③ 旧口径 label=父目录、leaf=末段");
  check(lg[0].group.key === "/p/proj", "③ 旧口径 key=目录路径（lowercase 归一前的首写）");
  check(lf.length === 2 && lf.map((r) => r.art.item.path).join(",") === "/p/root.md,/p/lonely/c.md", "③ 散文件按 at 降序混排（根散件+单文件目录）");
  check(legacy[0].kind === "file" && legacy[0].art.item.path === "/p/root.md", "③ 组与散件按 at 全局降序（最新在顶）");

  // 混合：B4a 组与旧口径散行共存（逐条路由，互不污染）
  const mixed = artifactRowsOf([
    withB4(art("/p/x1.md", { last_at: 600 }), { group_key: "g9", directory_label: "交付" }),
    art("/p/solo/x2.md", { last_at: 500 }),
  ], dirOf);
  check(mixed.length === 2 && mixed[0].kind === "group" && mixed[1].kind === "file", "③ 混合路由：B4a 组 + 旧口径散行按 at 降序");
}

// ---------- ④ done/error 收口条 ----------
{
  check(closingBarOf(baseSession({ status: "ERROR", last_error: "boom" }), 10_000)!.kind === "error", "④ ERROR → error 收口条");
  check(closingBarOf(baseSession({ status: "ERROR" }), 10_000)!.text === "出错了", "④ ERROR 无 last_error → 兜底文案");
  const doneSess = baseSession({ status: "DONE", activity: { state: "DONE", capabilities: caps(), updated_at: 9_990 } });
  const doneBar = closingBarOf(doneSess, 10_000);
  check(doneBar?.kind === "done" && doneBar.text === "本轮已完成", "④ DONE 尾窗内（<8s）→ done 收口条");
  check(closingBarOf(doneSess, 9_990 + DONE_TAIL_MS) !== null, "④ 尾窗边界（落定+8s 整）仍显示");
  check(closingBarOf(doneSess, 9_990 + DONE_TAIL_MS + 1) === null, "④ 过尾窗自隐（历史 DONE 不糊条）");
  check(closingBarOf(baseSession({ status: "DONE" }), 10_000) === null, "④ DONE 无 activity 不出收口（不猜）");
  check(closingBarOf(baseSession({ status: "DONE", activity: { state: "DONE", capabilities: caps(), updated_at: 20_000 } }), 10_000) === null, "④ 时间倒挂（age<0）不出条");
  check(closingBarOf(baseSession({ status: "WORKING" }), 10_000) === null && closingBarOf(baseSession({ status: "WAITING" }), 10_000) === null, "④ WORKING/WAITING 不出收口条（活动舱/等待条承载）");
  check(closingBarOf(null, 10_000) === null, "④ 会话缺失 → null");
}

  console.log(`E3a detail projection tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 起了 5s 巡检 interval（原生桩的 AppState 也不触发卸载），
  // 显式退出防挂
  .finally(() => process.exit(0));
