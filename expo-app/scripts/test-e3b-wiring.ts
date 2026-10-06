// E3b detail 真命令/审批/artifact/通知接线直跑测试（worker H / #018-E3b）。
//
// 直跑入口（tsx 装在 relay/node_modules，--import 解析以 cwd 为基准）：
//   relay 目录：node --import tsx ../expo-app/scripts/test-e3b-wiring.ts
//
// 原理：store.ts / DetailScreen.tsx 都是 RN 依赖模块，node 无法直接加载。先用
// module.registerHooks 注册模块桩（同 E2a/E3a 桩法），再动态 import store 单例与
// DetailScreen 纯函数段；用假 SourceConn 注入 store 私有 conns/sidIndex，从私有
// onMessage/onEvent 驱动 COMMAND_ACK 与数据帧——测的是**真实 store 代码路径**
//（send→pendingCmds→onAck→onCmdTimeout 全链），不是复刻实现的影子断言。
//
// 注意①：store.ts 顶层 new RelayStore() 起 5s 巡检 interval，末尾必须 process.exit。
// 注意②：store 的 send() 比较 `conn.ws.readyState !== WebSocket.OPEN`——WebSocket 是
// RN 全局（非 import），node 下即内置全局 WebSocket，OPEN=1；假 ws readyState 取同值
//
// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}

// ---------- RN/原生依赖桩层（与 test-e3a-detail.ts 同集） ----------
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

// ---------- 被测模块与 fixture ----------
import type { SessionState, WaitingPayload, NotificationItem, ArtifactItem, ActivityCapabilities } from "../src/protocol.ts";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const { store } = await import("../src/store.ts");
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const detail = await import("../src/screens/DetailScreen.tsx");
  const { dedupeWaitingBars, artExistenceOf, decisionStillPending } = detail as {
    dedupeWaitingBars: (w: (WaitingPayload | null)[]) => WaitingPayload[];
    artExistenceOf: (a: ArtifactItem) => "exists" | "missing" | "unknown";
    decisionStillPending: (w: WaitingPayload | null | undefined, rid: string) => boolean;
  };

  // WebSocket 是 RN 全局（store 内无 import）：node 下=内置全局，OPEN=1；
  // 假 ws readyState 用同值过开路判定（断线态用 3=CLOSED，与 magic 值比较恒不等=拒发）
  const WS_OPEN = 1;

  // store 私有内部（测试驱动面：conns/sidIndex/activeId/onMessage/onEvent/onCmdTimeout）
  interface ConnLike {
    id: string;
    notifications: NotificationItem[] | null;
    sessions: Map<string, SessionState>;
    timelines: Map<string, unknown[]>;
    pendingCmds: Map<string, unknown>;
    ws: { readyState: unknown; send: (s: string) => void };
    [k: string]: unknown;
  }
  interface SentCmd { command_id: string; type: string; payload: Record<string, unknown> }
  const iv = store as unknown as {
    conns: Map<string, ConnLike>;
    sidIndex: Map<string, ConnLike>;
    activeId: string;
    snap: { lastErrorCmd: string | null; notifications: NotificationItem[] | null; notificationsLegacy: boolean };
    artFetches: Map<string, unknown>;
    onMessage: (c: ConnLike, m: unknown) => void;
    onEvent: (c: ConnLike, m: unknown) => void;
    onCmdTimeout: (c: ConnLike, id: string) => void;
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

  const note = (key: string, over: Partial<NotificationItem> = {}): NotificationItem => ({
    key,
    kind: "approval",
    group: "g1",
    severity: "warn",
    title: "待审批 " + key,
    body: "rm -rf /tmp/x",
    sourceContext: { domain: "session", entityId: "s1", alertId: "a1", returnPath: "detail" },
    actionable: true,
    created_at: 1000,
    ...over,
  });

  // 假 SourceConn：SourceConn 接口全字段在场（emit/connStatusPatch/SNAPSHOT 装配都会摸）
  const makeConn = (id: string): { conn: ConnLike; sent: SentCmd[] } => {
    const sent: SentCmd[] = [];
    const conn = {
      id,
      name: "源-" + id,
      entry: { id, name: id, wsUrl: "ws://lan/" + id } as never,
      cfg: null,
      cloudCfg: null,
      ws: { readyState: WS_OPEN, send: (raw: string) => { sent.push(JSON.parse(raw)); } },
      channel: "lan",
      state: "online",
      stateText: null,
      failNote: null,
      lastSeq: 0,
      activitySeq: new Map<string, number>(),
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
    iv.conns.set(id, conn);
    return { conn, sent };
  };

  const envelope = (type: string, payload: unknown, sid: string, seq = 0): unknown =>
    ({ type, session_id: sid, payload, seq, ts: 1000 });
  // 信封帧入口（含 emit 全链）；ACK 走同入口（onMessage 按 type 分流）
  const fire = (conn: ConnLike, type: string, payload: unknown, sid: string, seq = 0): void =>
    iv.onMessage(conn, envelope(type, payload, sid, seq));
  const ack = (conn: ConnLike, command_id: string, ok: boolean, extra: Record<string, unknown> = {}): void =>
    iv.onMessage(conn, { type: "COMMAND_ACK", command_id, ok, ...extra });

  const sentOf = (sent: SentCmd[], type: string): SentCmd[] => sent.filter((c) => c.type === type);

  // ═══════════ ① WAITING 审批真链路 ═══════════
  {
    const { conn: ca, sent: sentA } = makeConn("srcA");
    iv.activeId = "srcA";
    ca.sessions.set("s1", baseSession());
    ca.timelines.set("s1", []);
    iv.sidIndex.set("s1", ca); // send() 按 session_id 路由查 sidIndex

    // WAITING 帧 → 挂起 + 渲染层等待条在
    fire(ca, "SESSION_WAITING", { request_id: "r1", tool_name: "Bash", input_summary: "rm -rf /tmp/x", suggestions: [] }, "s1");
    const s1 = ca.sessions.get("s1")!;
    check(s1.status === "WAITING" && s1.waiting_request?.request_id === "r1", "① WAITING 帧置挂起 r1");
    check(dedupeWaitingBars([s1.waiting_request ?? null]).length === 1, "① 渲染层等待条 1 条");

    // 决议发出：COMMAND_CONTINUE 按 session_id 路由、payload 带 request_id（定向）
    const acks1: { ok: boolean; err: string | null }[] = [];
    const sentOk = store.send("COMMAND_CONTINUE", { session_id: "s1", request_id: "r1" }, undefined, (r) => acks1.push(r));
    check(sentOk === true, "① send 在线成功");
    const c1 = sentOf(sentA, "COMMAND_CONTINUE");
    check(c1.length === 1 && c1[0].payload.request_id === "r1" && c1[0].payload.session_id === "s1", "① 决议 payload 按 request_id 定向");

    // ACK ok 才翻态：本地不预清，等权威帧收敛（relay 执行后推 SESSION_UPDATED）
    ack(ca, c1[0].command_id, true);
    check(acks1.length === 1 && acks1[0].ok === true, "① ACK ok 回调 ok");
    check(s1.waiting_request?.request_id === "r1", "① ACK ok 本地不预清（等权威帧）");
    fire(ca, "SESSION_UPDATED", { status: "WORKING", waiting_request: null }, "s1");
    check(ca.sessions.get("s1")!.waiting_request === null && ca.sessions.get("s1")!.status === "WORKING", "① 权威帧翻态（等待条清）");
    check(dedupeWaitingBars([ca.sessions.get("s1")!.waiting_request ?? null]).length === 0, "① 翻态后渲染层 0 条");

    // 孤儿决议帧定向守卫（store 既有逻辑回归）：新请求 r2 挂起后，旧 r1 的 RESOLVED 不打掉新横幅
    fire(ca, "SESSION_WAITING", { request_id: "r2", tool_name: "Bash", input_summary: "ls /", suggestions: [] }, "s1");
    fire(ca, "SESSION_WAITING_RESOLVED", { request_id: "r1", decision: "superseded", by: "cli" }, "s1");
    check(ca.sessions.get("s1")!.waiting_request?.request_id === "r2", "① 孤儿 RESOLVED 不误清新请求（定向）");

    // 失败回退：ACK error → onAck 带错误、等待条保留、无全局 toast（回调接管不叠报）
    const acks2: { ok: boolean; err: string | null }[] = [];
    iv.snap.lastErrorCmd = null;
    store.send("COMMAND_REJECT", { session_id: "s1", request_id: "r2" }, undefined, (r) => acks2.push(r));
    const c2 = sentOf(sentA, "COMMAND_REJECT");
    ack(ca, c2[0].command_id, false, { error: "unsupported command" });
    check(acks2[0].ok === false && acks2[0].err === "unsupported command", "② 失败回执带错误");
    check(ca.sessions.get("s1")!.status === "WAITING" && ca.sessions.get("s1")!.waiting_request?.request_id === "r2", "① 失败回退=等待条保留");
    check(iv.snap.lastErrorCmd === null, "① onAck 命令不叠全局 toast");
    store.notifyCmdError("决议未生效（unsupported command），等待条保留，可重点按钮重试");
    check(iv.snap.lastErrorCmd !== null, "① notifyCmdError 走全局 toast 通道");

    // 超时收摊：首发+4s 重发一次+6s 收摊一次（不重试风暴）——直接驱动 onCmdTimeout
    const acks3: { ok: boolean; err: string | null }[] = [];
    store.send("COMMAND_CONTINUE", { session_id: "s1", request_id: "r2" }, undefined, (r) => acks3.push(r));
    const c3 = sentOf(sentA, "COMMAND_CONTINUE")[1];
    const before = sentOf(sentA, "COMMAND_CONTINUE").length;
    iv.onCmdTimeout(ca, c3.command_id); // 4s：重发一次
    check(sentOf(sentA, "COMMAND_CONTINUE").length === before + 1, "① 超时重发一次");
    check(ca.pendingCmds.has(c3.command_id) && sentOf(sentA, "COMMAND_CONTINUE")[before].command_id === c3.command_id, "① 重发同 command_id");
    iv.onCmdTimeout(ca, c3.command_id); // 6s：收摊回调
    check(acks3.length === 1 && acks3[0].ok === false && acks3[0].err === "服务器未确认，可能未送达", "① 二次超时收摊报错");
    check(!ca.pendingCmds.has(c3.command_id), "① 收摊后清 pendingCmds");
    check(sentOf(sentA, "COMMAND_CONTINUE").length === before + 1, "① 不重试风暴（恰好 2 次上线）");

    // 回执侧定向守卫（DetailScreen decisionStillPending）：晚到失败只在同请求仍挂起时提示
    const wrR1 = { request_id: "r1", tool_name: "Bash", input_summary: "x", suggestions: [] } as WaitingPayload;
    const wrR2 = { request_id: "r2", tool_name: "Bash", input_summary: "y", suggestions: [] } as WaitingPayload;
    check(decisionStillPending(wrR1, "r1") === true, "① 同请求挂起 → 应提示");
    check(decisionStillPending(null, "r1") === false, "① 已翻态（null）→ 不提示");
    check(decisionStillPending(wrR2, "r1") === false, "① 换请求 → 不误报");
  }

  // ═══════════ ② artifact 真拉取 ═══════════
  {
    const { conn: ca, sent: sentA } = makeConn("srcB");
    iv.activeId = "srcB";
    const arts: ArtifactItem[] = [
      { path: "/p/report.md", size: 5 } as ArtifactItem, // 旧 relay：exists 缺省 → exists
      { path: "/p/old.md", size: 0, exists: false } as ArtifactItem,
      { path: "/p/new.md", size: 0, existence_state: "unknown" } as unknown as ArtifactItem,
    ];
    ca.sessions.set("s1", baseSession({ artifacts: arts }));
    iv.sidIndex.set("s1", ca);
    const beforeRef = (ca.sessions.get("s1") as { artifacts: ArtifactItem[] }).artifacts;
    const triBefore = arts.map(artExistenceOf).join(",");

    // 成功链路：数据帧+done 先到、ACK 后到（relay 时序），双条件齐了才收口
    const p1 = store.fetchArtifact("s1", "/p/report.md");
    const cmd1 = sentOf(sentA, "COMMAND_ARTIFACT_FETCH").at(-1)!;
    check(cmd1.payload.session_id === "s1" && cmd1.payload.path === "/p/report.md", "② fetch 命令定向 path/session");
    fire(ca, "ARTIFACT_CHUNK", { ref: cmd1.command_id, seq: 0, total: 1, b64: "aGVsbG8=", done: true }, "s1");
    ack(ca, cmd1.command_id, true, { artifact: { size: 5, mime: "text/markdown" } });
    const r1 = await p1;
    check(r1.b64s.length === 1 && r1.b64s[0] === "aGVsbG8=" && r1.mime === "text/markdown" && r1.size === 5, "② 成功收口 b64/mime/size");
    check(iv.artFetches.size === 0, "② 成功后清等待器");

    // 失败回退：ACK error → reject；三态行定格不动、列表不清空
    const p2 = store.fetchArtifact("s1", "/p/old.md");
    const cmd2 = sentOf(sentA, "COMMAND_ARTIFACT_FETCH").at(-1)!;
    ack(ca, cmd2.command_id, false, { error: "文件不存在" });
    const err2 = await p2.then(() => null, (e: Error) => e.message);
    check(err2 === "文件不存在", "② ACK 失败可见错误");
    check((ca.sessions.get("s1") as { artifacts: ArtifactItem[] }).artifacts === beforeRef, "② 失败不清空列表（引用未动）");
    check(arts.map(artExistenceOf).join(",") === triBefore && triBefore === "exists,missing,unknown", "② 三态定格保持");

    // 数据帧 error → reject
    const p3 = store.fetchArtifact("s1", "/p/new.md");
    const cmd3 = sentOf(sentA, "COMMAND_ARTIFACT_FETCH").at(-1)!;
    fire(ca, "ARTIFACT_CHUNK", { ref: cmd3.command_id, error: "读取失败" }, "s1");
    check(await p3.then(() => null, (e: Error) => e.message) === "读取失败", "② CHUNK error 可见错误");

    // 会话不存在 → send 同步失败收口（不挂死）
    check(await store.fetchArtifact("ghost", "/x").then(() => null, (e: Error) => e.message) === "未连接，命令未发送", "② 会话不存在快速失败");

    // ws 关闭 → 同上（行保留三态，用户可重点按钮=新 command_id）
    ca.ws.readyState = 3;
    check(await store.fetchArtifact("s1", "/p/report.md").then(() => null, (e: Error) => e.message) === "未连接，命令未发送", "② 断连快速失败");
    ca.ws.readyState = WS_OPEN;
    check(iv.artFetches.size === 0, "② 失败路径不残留等待器");
  }

  // ═══════════ ③ 通知消费 ═══════════
  {
    const { conn: cb, sent: sentB } = makeConn("srcC");
    iv.activeId = "srcC";

    // SNAPSHOT.notifications 进 store（值装载）
    const n1 = note("k1");
    const n2 = note("k2");
    fire(cb, "SNAPSHOT", { sessions: [], notifications: [n1, n2], schema_version: 1, deliverables: true }, "", 1);
    check(cb.notifications?.length === 2 && cb.notifications[0].key === "k1", "③ 快照通知进 store");
    check(iv.snap.notifications === cb.notifications && iv.snap.lastErrorCmd !== "x", "③ 快照口径透出活动源");

    // 帧值替换（NOTIFICATIONS_UPDATED items 全量覆盖）
    fire(cb, "NOTIFICATIONS_UPDATED", { items: [note("k1", { title: "改题" })] }, "", 2);
    check(cb.notifications?.length === 1 && cb.notifications[0].title === "改题", "③ 帧值替换");
    // 畸形帧不覆盖
    const keepRef = cb.notifications;
    fire(cb, "NOTIFICATIONS_UPDATED", { items: "oops" }, "", 3);
    fire(cb, "NOTIFICATIONS_UPDATED", {}, "", 4);
    check(cb.notifications === keepRef && cb.notifications?.length === 1, "③ 畸形帧不覆盖");

    // legacy 快照（无 notifications 字段）→ null = 旧 relay（emit 前切活动源，口径即时透出）
    const { conn: cc } = makeConn("srcD");
    iv.activeId = "srcD";
    fire(cc, "SNAPSHOT", { sessions: [] }, "", 1);
    check(cc.notifications === null, "③ legacy 快照 → notifications null");
    check(iv.snap.notificationsLegacy === true, "③ legacy 口径 notificationsLegacy true");
    // 新 relay 零通知 ≠ 旧 relay 无能力
    const { conn: cd } = makeConn("srcE");
    iv.activeId = "srcE";
    fire(cd, "SNAPSHOT", { sessions: [], notifications: [] }, "", 1);
    check(cd.notifications?.length === 0, "③ 空数组=新 relay 零通知（非 legacy）");
    iv.activeId = "srcC";

    // ACK 乐观：不等帧本地即 Handled；命令按持账源路由（跨源不串扰）
    cb.notifications = [note("k1"), note("k2")];
    const dones: { ok: boolean; err: string | null }[] = [];
    const sentOk = store.ackNotification("k1", "handled", (r) => dones.push(r));
    check(sentOk === true, "③ ackNotification 在线 true");
    check(cb.notifications[0].handled_at !== undefined && cb.notifications[1].handled_at === undefined, "③ ACK 前乐观点亮 handled（不等帧）");
    const ackCmdB = sentOf(sentB, "COMMAND_NOTIFICATION_ACK");
    check(ackCmdB.length === 1 && ackCmdB[0].payload.notification_key === "k1" && ackCmdB[0].payload.action === "handled", "③ 命令词表 notification_key/action");
    // 相邻源 srcA 在场：该命令不串扰
    const { conn: ca2, sent: sentA2 } = makeConn("srcF");
    ca2.notifications = [note("kA")];
    store.ackNotification("kA", "handled");
    check(sentOf(sentA2, "COMMAND_NOTIFICATION_ACK").length === 1, "③ 按持账源路由 kA→srcF");
    check(sentOf(sentB, "COMMAND_NOTIFICATION_ACK").length === 1, "③ 跨源不串扰（srcC 未多收）");
    // ok 对账：权威帧覆盖乐观账
    ack(cb, ackCmdB[0].command_id, true);
    check(dones[0].ok === true && dones[0].err === null, "③ ACK ok onDone");
    fire(cb, "NOTIFICATIONS_UPDATED", { items: [note("k1", { handled_at: 999 }), note("k2")] }, "", 5);
    check(cb.notifications[0].handled_at === 999, "③ 帧到对账（权威覆盖乐观）");

    // 失败回滚：旧 relay unsupported → 乐观账回滚 + onDone 报错 + 恰好 1 次命令
    const sentCountBefore = sentOf(sentB, "COMMAND_NOTIFICATION_ACK").length;
    const dones2: { ok: boolean; err: string | null }[] = [];
    store.ackNotification("k2", "dismissed", (r) => dones2.push(r));
    check(cb.notifications[1].handled_at !== undefined, "③ dismissed 乐观点亮");
    ack(cb, sentOf(sentB, "COMMAND_NOTIFICATION_ACK")[sentCountBefore].command_id, false, { error: "unsupported command" });
    check(dones2[0].ok === false && dones2[0].err === "unsupported command", "③ 命令被拒 onDone 报错");
    check(cb.notifications[1].handled_at === undefined, "③ 回滚：handled 撤销");
    check((cb.notifications[1] as NotificationItem & { dismissed_at?: number }).dismissed_at === undefined, "③ 回滚：dismissed 撤销");
    check(sentOf(sentB, "COMMAND_NOTIFICATION_ACK").length === sentCountBefore + 1, "③ 不重试风暴（恰好 1 次命令）");

    // 回滚引用守卫：乐观后、ACK 前权威帧到达 → 不回滚权威账
    const dones3: { ok: boolean; err: string | null }[] = [];
    store.ackNotification("k2", "handled", (r) => dones3.push(r));
    fire(cb, "NOTIFICATIONS_UPDATED", { items: [note("k1", { handled_at: 999 }), note("k2", { title: "帧先到" })] }, "", 6);
    ack(cb, sentOf(sentB, "COMMAND_NOTIFICATION_ACK").at(-1)!.command_id, false, { error: "late" });
    check(cb.notifications[1].title === "帧先到" && cb.notifications[1].handled_at === undefined, "③ 帧已覆盖则以帧为准（不回滚权威账）");

    // 已 resolved 不做乐观（relay 幂等 ok 照发）
    cb.notifications = [note("k9", { resolved_at: 5000 })];
    const dones4: { ok: boolean; err: string | null }[] = [];
    check(store.ackNotification("k9", "handled", (r) => dones4.push(r)) === true, "③ resolved 也照发（幂等）");
    check(cb.notifications[0].handled_at === undefined, "③ resolved 不做乐观突变");
    ack(cb, sentOf(sentB, "COMMAND_NOTIFICATION_ACK").at(-1)!.command_id, true);
    check(dones4[0].ok === true, "③ resolved ACK ok");

    // 未知 key：优雅 false 不发命令
    const dones5: { ok: boolean; err: string | null }[] = [];
    const cnt = sentOf(sentB, "COMMAND_NOTIFICATION_ACK").length;
    check(store.ackNotification("nope", "handled", (r) => dones5.push(r)) === false, "③ 未知 key false");
    check(dones5[0].err === "通知不存在或已同步" && sentOf(sentB, "COMMAND_NOTIFICATION_ACK").length === cnt, "③ 未知 key 不发命令");

    // 断线 send-false：回滚乐观账 + 报错
    cb.notifications = [note("k1"), note("k2")];
    cb.ws.readyState = 3;
    const dones6: { ok: boolean; err: string | null }[] = [];
    check(store.ackNotification("k1", "handled", (r) => dones6.push(r)) === false, "③ 断线 false");
    check(cb.notifications[0].handled_at === undefined && dones6[0].ok === false, "③ 断线回滚+报错");
    cb.ws.readyState = WS_OPEN;

    // 重连不清零铁律：未决通知经快照合并不丢（relay 持账重放，端侧 authoritative replace）
    cb.notifications = [note("k1"), note("k2")];
    fire(cb, "SNAPSHOT", { sessions: [], notifications: [note("k1"), note("k2")] }, "", 10);
    check(cb.notifications.length === 2 && cb.notifications.every((n) => n.resolved_at === undefined && n.handled_at === undefined), "③ 重连快照未决不清零");
    fire(cb, "SNAPSHOT", { sessions: [], notifications: [note("k1", { resolved_at: 8000 }), note("k2")] }, "", 11);
    check(cb.notifications.length === 2 && cb.notifications[0].resolved_at === 8000 && cb.notifications[1].resolved_at === undefined, "③ 快照对账：resolved 收敛、未决保留");
  }

  // ═══════════ ④ 旧 relay 降级三型 ═══════════
  {
    // 型① 无 notifications 字段：null → 面不渲染口径（notificationsLegacy），不报错
    const { conn: ce, sent: sentE } = makeConn("srcG");
    iv.activeId = "srcG";
    fire(ce, "SNAPSHOT", { sessions: [] }, "", 1);
    check(ce.notifications === null && iv.snap.notificationsLegacy === true, "④ 型① 无字段 → null/legacy 口径");
    // 型② 命令被拒 unsupported：优雅回执不崩、不重试（key 源域稳定键：fixture 用
    // 本源独有 key，防误路由到仍持同名 key 的前源——路由按首个持账源命中）
    const dones7: { ok: boolean; err: string | null }[] = [];
    ce.notifications = [note("kG1")];
    store.ackNotification("kG1", "handled", (r) => dones7.push(r));
    ack(ce, sentOf(sentE, "COMMAND_NOTIFICATION_ACK")[0].command_id, false, { error: "unsupported command" });
    check(dones7[0].ok === false && dones7[0].err === "unsupported command", "④ 型② 命令被拒不崩");
    check(ce.notifications.length === 1 && ce.notifications[0].handled_at === undefined, "④ 型② 回滚后列表完好");
    // 型③ 帧缺失：legacy relay 永不发帧——null 账保持 null（误收畸形帧也不炸不翻账，
    // 面不渲染）；有账源畸形帧不覆盖既有账
    const { conn: cz } = makeConn("srcH");
    fire(cz, "SNAPSHOT", { sessions: [] }, "", 1);
    fire(cz, "NOTIFICATIONS_UPDATED", {}, "", 2);
    check(cz.notifications === null, "④ 型③ null 账 + 畸形帧 → 仍 null（面不渲染）");
    fire(ce, "NOTIFICATIONS_UPDATED", { items: "oops" }, "", 3);
    check(ce.notifications.length === 1 && ce.notifications[0].key === "kG1", "④ 有账畸形帧不覆盖");
    const dones8: { ok: boolean; err: string | null }[] = [];
    check(store.ackNotification("k-none", "handled", (r) => dones8.push(r)) === false && dones8[0].ok === false, "④ null 账 ACK 优雅 false");
  }

  console.log(`E3b wiring tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 5s 巡检 interval（原生桩 AppState 不触发卸载），显式退出防挂
  .finally(() => process.exit(0));
