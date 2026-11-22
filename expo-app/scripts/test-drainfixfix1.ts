// drainfix 返修 fix1（#192 审查挡项 §P1）专项：expo waiting_request 自愈不误清。
//
// 病灶：store.ts SESSION_UPDATED 合并里 waiting_request 自愈 else-if 用
// `payload.status !== "WAITING"` 假值比较——drainfix 后 UPDATE 帧 PATCH 化
//（diff 闸丢同值键），等待期置顶/改名等帧整帧不含 status 键 → undefined !==
// "WAITING" 为真 → 误清审批条；relay 不重发 SESSION_WAITING，误清=手机审批
// 断到下一轮状态转移。修法=同款 `!== undefined` 在场守卫：缺 status 键不触发
// 自愈，仅显式非 WAITING（或权威 waiting_request:null）才清。
//
// 直跑（tsx 装在 relay/node_modules，e3b/lanfix 同款）：
//   cd relay && node --import tsx ../expo-app/scripts/test-drainfixfix1.ts
// 桩层自含（react/tweetnacl/async-storage 一并桩化）——裸 worktree 无
// expo-app/node_modules 也可跑（e3b/lanfix 全量 import 形态在裸环境会
// Cannot find module，本套不依赖真实依赖安装）。
//
// 注意：store.ts 顶层 new RelayStore() 起 5s 巡检 interval，末尾 process.exit。
//
// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}

// ---------- RN/原生依赖桩层（test-e3b-wiring 同集 + react/tweetnacl/async-storage） ----------
const STUB_BASES = new Set([
  "react", // useSyncExternalStore 仅组件 hook 路径调用，本套不触
  "react-native", // Flow 语法 index.js，esbuild/tsx 无法解析
  "@react-native-async-storage",
  // resolve 钩子对 @ 域取前两段=完整两段名——单列全名才命中（e3b/lanfix 的
  // 裸 scope 条目在无真实 node_modules 时永不命中，是它们跑不了的第二根因）
  "@react-native-async-storage/async-storage",
  "tweetnacl", // e2e.ts 模块顶层仅函数定义不调 nacl；本套不触 crypto 路径
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
  "Alert", "Animated", "AppState", "Constants", "DeviceEventEmitter", "Dimensions", "FlatList",
  "Fragment", "Image", "Keyboard", "Linking", "Modal", "PanResponder", "Path",
  "PermissionsAndroid", "Platform", "Pressable", "RefreshControl", "SafeAreaView",
  "ScrollView", "Share", "StyleSheet", "Switch", "Text", "TextInput", "Vibration",
  "View", "useSafeAreaInsets", "requireOptionalNativeModule", "fetch", "WebSocket",
  "getRandomBytes", "getStringAsync", "setStringAsync", "CameraView",
  "BarcodeScanningResult", "LinearGradient", "WebView", "Svg", "Circle", "Rect",
  "EncodingType", "cacheDirectory", "copyAsync", "deleteAsync", "getContentUriAsync",
  "makeDirectoryAsync", "readAsStringAsync", "writeAsStringAsync",
  "getDocumentAsync", "SaveFormat", "manipulateAsync", "launchImageLibraryAsync",
  "startActivityAsync", "isAvailableAsync", "shareAsync",
];

// 万能 magic proxy：可调用/可 new/可取任意属性；then 返回永不定案 promise
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

import type { SessionState } from "../src/protocol.ts";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const { store } = await import("../src/store.ts");

  interface ConnLike {
    id: string;
    sessions: Map<string, SessionState>;
    timelines: Map<string, unknown[]>;
    [k: string]: unknown;
  }
  const iv = store as unknown as {
    conns: Map<string, ConnLike>;
    sidIndex: Map<string, ConnLike>;
    onMessage: (c: ConnLike, m: unknown) => void;
  };

  const baseSession = (over: Partial<SessionState> = {}): SessionState => ({
    session_id: "s1",
    relay_session_id: "r1",
    cwd: "/tmp/project",
    initial_prompt: "",
    title: "任务会话",
    model: "claude",
    status: "WORKING",
    action_summary: "",
    started_at: 100,
    updated_at: 100,
    stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
    ...over,
  });

  // 假 SourceConn：e3b makeConn 同款（onMessage 摸到的字段全在场）
  const conn: ConnLike = {
    id: "srcFix1",
    name: "源-srcFix1",
    entry: { id: "srcFix1", name: "srcFix1", wsUrl: "ws://lan/srcFix1" } as never,
    cfg: null,
    cloudCfg: null,
    ws: { readyState: 1, send: () => {} },
    channel: "lan",
    state: "online",
    stateText: null,
    failNote: null,
    lastSeq: 0,
    activitySeq: new Map(),
    models: [],
    platform: "",
    deliverables: false,
    schemaVersion: undefined,
    sourceCapabilities: undefined,
    notifications: null,
    acceptances: [],
    allowRules: null,
    empHome: null,
    projects: null,
    orgConfirms: [],
    boards: new Map(),
    experiences: null,
    experienceEnabled: true,
    anchoredBoards: new Set(),
    boardResync: new Set(),
    artPool: "no",
    artPoolData: [],
    artPoolProbing: false,
    sessions: new Map<string, SessionState>(),
    timelines: new Map(),
    reconnectDelay: 0,
    reconnectTimer: null,
    countdownTimer: null,
    retryAt: 0,
    relayName: "",
    lanHint: "",
    lanToken: "",
    lanUpgrading: false,
    lanUpgradeCool: 0,
    lanProbeCool: 0,
    fastRetry: false,
    hbTimer: null,
    probeTimer: null,
    lastDownAt: 0,
    connectStartedAt: 0,
    epoch: 0,
    pendingCmds: new Map(),
    awaitWake: false,
    wakePings: 0,
    resumeCheck: false,
    wanDev: null,
  } as unknown as ConnLike;
  iv.conns.set("srcFix1", conn);

  const fire = (type: string, payload: unknown, sid = "s1", seq = 0): void => {
    iv.onMessage(conn, { type, session_id: sid, payload, seq, ts: 1000 });
  };

  conn.sessions.set("s1", baseSession());

  // 挂起起点：WAITING 帧（等待期置顶/改名等操作发生在此状态上）
  fire("SESSION_WAITING", { request_id: "rq1", tool_name: "Bash", input_summary: "rm -rf /tmp/x", suggestions: [] });
  const w0 = conn.sessions.get("s1")!;
  check(w0.status === "WAITING" && w0.waiting_request?.request_id === "rq1", "挂起起点 rq1");

  // ── 病灶回归：PATCH 帧缺 status 键（diff 闸丢同值键后的实发形态）──
  // 修前 `undefined !== "WAITING"` 为真 → 误清；修后缺键不触发自愈
  fire("SESSION_UPDATED", { todos: [], updated_at: 2000 });
  const p1 = conn.sessions.get("s1")!;
  check(p1.status === "WAITING" && p1.waiting_request?.request_id === "rq1", "PATCH 缺 status 键 → waiting_request 保持 rq1");

  // 审查点名触发面正例：等待期置顶（board-commands 载荷本不含 waiting_request、
  // status 同值被 diff 闸丢）——不得误清审批条，置顶本身要生效
  fire("SESSION_UPDATED", { pinned: true, updated_at: 2100 });
  const p2 = conn.sessions.get("s1")!;
  check(p2.waiting_request?.request_id === "rq1" && p2.status === "WAITING", "等待期置顶 PATCH（缺 status）→ 审批条仍在");
  check(p2.pinned === true, "置顶键本身正常合入（守卫不吞无关键）");

  // ── 显式清除三形态（旧语义不变）──
  // ① 权威 null（新 relay 恒携带通道；帧不带 status 也能清）
  fire("SESSION_UPDATED", { waiting_request: null, updated_at: 2200 });
  check(conn.sessions.get("s1")!.waiting_request === null, "显式 waiting_request:null → 清除");

  // ② 帧带显式非 WAITING status（旧 relay 整包/状态转移帧）→ 自愈清
  fire("SESSION_WAITING", { request_id: "rq2", tool_name: "Bash", input_summary: "ls /", suggestions: [] });
  check(conn.sessions.get("s1")!.waiting_request?.request_id === "rq2", "再挂 rq2（补起点）");
  fire("SESSION_UPDATED", { status: "WORKING", updated_at: 2300 });
  const p3 = conn.sessions.get("s1")!;
  check(p3.waiting_request === null && p3.status === "WORKING", "显式非 WAITING status → 自愈清除+status 采信");

  // ③ WAITING 同值 status 帧不触发自愈（显式在场但值=等待）
  fire("SESSION_WAITING", { request_id: "rq3", tool_name: "Bash", input_summary: "pwd", suggestions: [] });
  fire("SESSION_UPDATED", { status: "WAITING", updated_at: 2400 });
  check(conn.sessions.get("s1")!.waiting_request?.request_id === "rq3", "显式 WAITING status → 自愈不触发（审批条保持）");

  console.log(`drainfix fix1 tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 5s 巡检 interval（原生桩 AppState 不触发卸载），显式退出防挂
  .finally(() => process.exit(0));
