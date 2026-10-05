// #018-E2b expo root 真命令/通知/组织接线直跑测试（worker G）。
//
// 直跑入口（relay 目录）：env -u CCR_ORG_DIR node --import tsx scripts/test-e2b-root.ts
//
// 范式 = test-e3b-wiring.ts（真 store 代码路径：假 SourceConn 注入私有 conns/
// sidIndex，从 onMessage/onCmdTimeout 驱动 COMMAND_ACK/超时——send→pendingCmds→
// onAck→收摊全链，不是复刻实现的影子断言）+ test-e2a-queue.ts（RN 桩+动态 import
// ListScreen.tsx 锚点段导出）。import 路径用计算拼接串——relay tsc 不顺图谱
// type-check expo 侧 TS（e2a-queue 同法，运行时 tsx 正常解析）。
//
// 注意①：store.ts / ListScreen.tsx 顶层副作用（RelayStore 5s 巡检 interval），末尾
// 必须 process.exit。注意②：store 的 send() 比较 conn.ws.readyState !== WebSocket.OPEN
//（RN 全局）——node 下即内置全局 WebSocket，OPEN=1；假 ws readyState 取同值。

// @ts-expect-error node:module 未进 expo tsconfig types 字段（relay tsconfig 不含本文件亦可）
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}

// ---------- RN/原生依赖桩层（与 test-e3b-wiring.ts 同集） ----------
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

// ---------- 断言器 ----------
let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

// ---------- 被测模块（计算拼接串：relay tsc 不顺图谱查 expo 侧 TS） ----------
const STORE_TS = "../../expo-app/" + "src/store.ts";
const LIST_TSX = "../../expo-app/" + "src/screens/ListScreen.tsx";
const LIST_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "expo-app", "src", "screens", "ListScreen.tsx");

interface AckVerdict { ok: boolean; error: string | null; kind: "ok" | "rejected" | "unconfirmed" }

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const storeMod = await import(STORE_TS);
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const list = await import(LIST_TSX);
  const { store } = storeMod as { store: Record<string, unknown> & { send: Function; orgConfirm: Function; ackNotification: Function } };
  const {
    ackVerdict, unknownCommandError, cmdCapRemember, cmdCapBlocked, cmdCapRecoverOnSnapshot,
    ackTapGuard, orgFlightKey, orgConfirmPayload, notifActionableOf,
  } = list as {
    ackVerdict: (a: unknown) => AckVerdict;
    unknownCommandError: (e: unknown) => boolean;
    cmdCapRemember: (c: unknown, cmd: string) => Record<string, boolean>;
    cmdCapBlocked: (c: unknown, cmd: string) => boolean;
    cmdCapRecoverOnSnapshot: (c: unknown, snap: unknown, identityChanged: boolean) => Record<string, boolean>;
    ackTapGuard: (f: Set<string> | null, k: string) => "go" | "skip";
    orgFlightKey: (s: string, c: string) => string;
    orgConfirmPayload: (id: unknown, approve: unknown) => { confirm_id: string; approve: boolean } | null;
    notifActionableOf: (items: unknown) => { key: string }[];
  };

  const WS_OPEN = 1;
  const WS_CLOSED = 3;

  // store 私有内部（测试驱动面，同 e3b）
  interface ConnLike {
    id: string;
    notifications: Array<Record<string, unknown>> | null;
    sessions: Map<string, unknown>;
    timelines: Map<string, unknown[]>;
    pendingCmds: Map<string, { tries: number; onAck?: (r: { ok: boolean; err: string | null }) => void }>;
    ws: { readyState: unknown; send: (s: string) => void };
    [k: string]: unknown;
  }
  interface SentCmd { command_id: string; type: string; payload: Record<string, unknown> }
  const iv = store as unknown as {
    conns: Map<string, ConnLike>;
    sidIndex: Map<string, ConnLike>;
    activeId: string;
    snap: { lastErrorCmd: string | null };
    onMessage: (c: ConnLike, m: unknown) => void;
    onCmdTimeout: (c: ConnLike, id: string) => void;
  };

  const note = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
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
      sessions: new Map<string, unknown>(),
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

  const ack = (conn: ConnLike, command_id: string, ok: boolean, extra: Record<string, unknown> = {}): void =>
    iv.onMessage(conn, { type: "COMMAND_ACK", command_id, ok, ...extra });
  const sentOf = (sent: SentCmd[], type: string): SentCmd[] => sent.filter((c) => c.type === type);

  // ═══════ ① ackVerdict ACK 严格判定三态（W1b 同构：===true 才成功） ═══════
  {
    const v1 = ackVerdict({ ok: true });
    check(v1.ok === true && v1.error === null && v1.kind === "ok", "① ok:true → ok");
    const v2 = ackVerdict({ ok: "yes" });
    check(v2.ok === false && v2.kind === "rejected", "① ok:\"yes\" 字符串成功不算（ACK 误读防护）");
    const v3 = ackVerdict({ ok: false, error: "项目不存在" });
    check(v3.ok === false && v3.kind === "rejected" && v3.error === "项目不存在", "① ok:false 透传 error");
    const v4 = ackVerdict(null);
    check(v4.ok === false && v4.kind === "unconfirmed" && (v4.error ?? "").includes("可重试"),
      "① null（超时/发送失败）→ unconfirmed 可重试文案");
    const v5 = ackVerdict({ ok: false });
    check(v5.kind === "rejected" && v5.error === "命令被拒绝", "① ok:false 无 error → 兜底文案");
    const v6 = ackVerdict({});
    check(v6.kind === "rejected", "① ok 缺省 → rejected");
    const v7 = ackVerdict({ ok: 1 });
    check(v7.kind === "rejected", "① ok:1 数字不算成功（严格布尔）");
  }

  // ═══════ ② unknownCommandError 旧 relay 三签名 ═══════
  {
    check(unknownCommandError("invalid command shape") === true, "② ws 白名单拒发签名命中");
    check(unknownCommandError("unsupported command") === true, "② 旧 handleCommand default 签名命中");
    check(unknownCommandError("unsupported org action: create") === true, "② org 咽喉未知 action 签名命中");
    check(unknownCommandError("网络抖动，请重试") === false && unknownCommandError(123) === false && unknownCommandError(null) === false,
      "② 暂时性故障/非串不命中（不误记能力位）");
  }

  // ═══════ ③ cmdCaps 能力位记忆与恢复 ═══════
  {
    const caps = cmdCapRemember({}, "COMMAND_ORG_CONFIRM");
    check(cmdCapBlocked(caps, "COMMAND_ORG_CONFIRM") === true && cmdCapBlocked(caps, "COMMAND_CREATE") === false,
      "③ 记忆后本命令拦截、他命令不受累");
    check(Object.keys(cmdCapRecoverOnSnapshot(caps, { schema_version: 1 }, false)).length === 0,
      "③ schema_version>=1 → 记忆清零（relay 升级恢复）");
    check(Object.keys(cmdCapRecoverOnSnapshot(caps, {}, true)).length === 0,
      "③ relay 身份变更 → 记忆清零");
    check(cmdCapBlocked(cmdCapRecoverOnSnapshot(caps, {}, false), "COMMAND_ORG_CONFIRM") === true,
      "③ 旧 relay（v0）+未换身份 → 记忆保留（legacy 恒静默降级）");
  }

  // ═══════ ④ 双击闸 + 复合飞行键 ═══════
  {
    check(ackTapGuard(new Set(), "a/c") === "go", "④ 空飞行表 → go");
    check(ackTapGuard(new Set(["a/c"]), "a/c") === "skip", "④ 飞行中同键 → skip");
    check(orgFlightKey("s1", "cf") === "s1/cf" && orgFlightKey("s1", "cf") !== orgFlightKey("s1c", "f"),
      "④ 复合键跨源 confirm_id 不撞名");
  }

  // ═══════ ⑤ orgConfirmPayload 强转真布尔（relay 咽喉 ===true 严判） ═══════
  {
    check(orgConfirmPayload("cf1", true)?.approve === true, "⑤ approve:true → 真布尔");
    check(orgConfirmPayload("cf1", "1")?.approve === false && orgConfirmPayload("cf1", 1)?.approve === false,
      "⑤ \"1\"/1 → false（字符串/数字判否决，W1b 同口径）");
    check(orgConfirmPayload("", true) === null && orgConfirmPayload("  ", true) === null && orgConfirmPayload(null, true) === null,
      "⑤ 空/空白/非串 confirm_id 拒发");
  }

  // ═══════ ⑥ notifActionableOf 可行动项口径 ═══════
  {
    check(notifActionableOf([note("k1")]).length === 1 && notifActionableOf([note("k1")])[0]?.key === "k1",
      "⑥ actionable 未决计入且 key 透出");
    check(notifActionableOf([note("k1", { resolved_at: 9 })]).length === 0
      && notifActionableOf([note("k1", { handled_at: 9 })]).length === 0
      && notifActionableOf([note("k1", { dismissed_at: 9 })]).length === 0,
      "⑥ resolved/handled/dismissed 任一在 → 不计");
    check(notifActionableOf([note("k1", { actionable: "true" })]).length === 0,
      "⑥ actionable:\"true\" 串不算（严格 ===true）");
    check(notifActionableOf(null).length === 0 && notifActionableOf([null, 3, {}]).length === 0,
      "⑥ 非数组/畸形条目安全空（不清零不伪造）");
  }

  // ═══════ ⑦ 真链路·组织确认（store.orgConfirm → ACK 判定 → 权威帧语义） ═══════
  {
    const { conn, sent } = makeConn("srcA");
    iv.activeId = "srcA";
    const acks: { ok: boolean; err: string | null }[] = [];
    const sentOk = store.orgConfirm("srcA", "cf1", true, (r) => acks.push(r));
    check(sentOk === true, "⑦ orgConfirm 在线发送成功");
    const c1 = sentOf(sent, "COMMAND_ORG_CONFIRM");
    check(c1.length === 1 && c1[0].payload.confirm_id === "cf1" && c1[0].payload.approve === true,
      "⑦ wire payload confirm_id/approve 真布尔");
    check(acks.length === 0, "⑦ ACK 未到不预回调（不伪造成功）");
    ack(conn, "wrong-id", true);
    check(acks.length === 0, "⑦ command_id 核对：错 id ACK 不认账");
    ack(conn, c1[0].command_id, true);
    check(acks.length === 1 && acks[0].ok === true && acks[0].err === null, "⑦ ACK ok:true → 判定成功");

    // 失败可见：ok:false + 旧 relay 签名 → 能力位判定门输入成立
    const acks2: { ok: boolean; err: string | null }[] = [];
    store.orgConfirm("srcA", "cf2", false, (r) => acks2.push(r));
    const c2 = sentOf(sent, "COMMAND_ORG_CONFIRM")[1];
    check(c2.payload.approve === false, "⑦ 否决 payload approve:false");
    ack(conn, c2.command_id, false, { error: "unsupported command" });
    check(acks2.length === 1 && acks2[0].ok === false && unknownCommandError(acks2[0].err) === true,
      "⑦ ok:false+旧 relay 签名 → 失败可见且判 unknownCommandError（静默降级输入）");

    // 重试封顶：第一次超时重发同 id 一次，第二次收摊回调一次（无自动重试风暴）
    const acks3: { ok: boolean; err: string | null }[] = [];
    store.orgConfirm("srcA", "cf3", true, (r) => acks3.push(r));
    const c3 = sentOf(sent, "COMMAND_ORG_CONFIRM")[2];
    const before = sentOf(sent, "COMMAND_ORG_CONFIRM").length;
    iv.onCmdTimeout(conn, c3.command_id);
    const afterRetry = sentOf(sent, "COMMAND_ORG_CONFIRM");
    check(afterRetry.length === before + 1 && afterRetry[afterRetry.length - 1].command_id === c3.command_id,
      "⑦ 首次超时重发同 command_id 一次");
    check(conn.pendingCmds.has(c3.command_id), "⑦ 重发后仍等 ACK（未收摊）");
    iv.onCmdTimeout(conn, c3.command_id);
    check(acks3.length === 1 && acks3[0].ok === false && conn.pendingCmds.has(c3.command_id) === false,
      "⑦ 二次超时收摊：onAck ok:false 一次 + pending 清（单次重试封顶）");

    // 未连接：sent=false 不静默丢单（调用方呈现可重试态）
    conn.ws.readyState = WS_CLOSED;
    const acks4: { ok: boolean; err: string | null }[] = [];
    const sentClosed = store.orgConfirm("srcA", "cf4", true, (r) => acks4.push(r));
    check(sentClosed === false && acks4.length === 0,
      "⑦ 断连源 orgConfirm 返回 false（不静默丢单，由调用方 unconfirmed 呈现）");
  }

  // ═══════ ⑧ 真链路·通知动作（store.ackNotification：乐观/回滚/不清零） ═══════
  {
    const { conn } = makeConn("srcB");
    conn.notifications = [note("k1"), note("k2")];
    const done1: { ok: boolean; err: string | null }[] = [];
    const sent1 = store.ackNotification("k1", "handled", (r) => done1.push(r));
    check(sent1 === true, "⑧ handled 动作在线发送");
    const opt1 = (conn.notifications?.[0] ?? {}) as Record<string, unknown>;
    check(typeof opt1.handled_at === "number", "⑧ 乐观置位 handled_at（不等帧）");
    ack(conn, (iv.conns.get("srcB")!.pendingCmds.keys().next().value ?? "") as string, true);
    check(done1.length === 1 && done1[0].ok === true, "⑧ ACK ok → onDone ok");
    check(notifActionableOf(conn.notifications).length === 1,
      "⑧ handled 后行动项收缩到 1（badge 随账收缩，池仍 2 行）");

    // dismissed + ACK ok:false → 回滚（引用还原）+ 行内错误
    const done2: { ok: boolean; err: string | null }[] = [];
    store.ackNotification("k2", "dismissed", (r) => done2.push(r));
    const pend2 = iv.conns.get("srcB")!.pendingCmds.keys().next().value as string;
    ack(conn, pend2, false, { error: "决议冲突，请刷新" });
    const opt2 = (conn.notifications?.[1] ?? {}) as Record<string, unknown>;
    check(opt2.dismissed_at === undefined && opt2.handled_at === undefined,
      "⑧ ACK 失败 → 乐观回滚（dismissed_at/handled_at 还原）");
    check(done2[0].ok === false && done2[0].err === "决议冲突，请刷新", "⑧ 失败经 onDone 行内呈现");
    check(conn.notifications?.length === 2, "⑧ 失败回滚后池行数不变（不清零）");

    // 旧 relay 签名失败 → unknownCommandError 判真（UI 静默降级输入）
    const done3: { ok: boolean; err: string | null }[] = [];
    store.ackNotification("k2", "handled", (r) => done3.push(r));
    const pend3 = iv.conns.get("srcB")!.pendingCmds.keys().next().value as string;
    ack(conn, pend3, false, { error: "unsupported command" });
    check(done3[0].ok === false && unknownCommandError(done3[0].err) === true,
      "⑧ 旧 relay 不支持通知动作 → 三签名判真（降级不轰炸）");

    // 旧 relay：null 池 conn 永不为 owner（owner 扫描 ?? [] 跳过），无主 key →
    // 拒发+onDone 报错不崩（降级语义；用独占 key 避免落到 srcB 池）
    const { conn: legacy } = makeConn("srcLegacy");
    const done4: { ok: boolean; err: string | null }[] = [];
    const sent4 = store.ackNotification("kNone", "handled", (r) => done4.push(r));
    check(sent4 === false && done4.length === 1 && done4[0].ok === false,
      "⑧ 无主 key（null 池）→ 拒发+onDone 报错不崩");
    check(iv.conns.get("srcLegacy")!.notifications === null,
      "⑧ 旧 relay null 池不被伪造（不动它人的账）");
  }

  // ═══════ ⑨ 真链路·新建会话（COMMAND_CREATE 走既有 ACK 纪律） ═══════
  {
    const { conn, sent } = makeConn("srcC");
    iv.activeId = "srcC";
    const acks: { ok: boolean; err: string | null }[] = [];
    const sentOk = store.send("COMMAND_CREATE", { cwd: "/tmp/proj", prompt: "做个功能" }, "srcC", (r) => acks.push(r));
    check(sentOk === true, "⑨ COMMAND_CREATE 在线发送");
    const c1 = sentOf(sent, "COMMAND_CREATE");
    check(c1.length === 1 && c1[0].payload.cwd === "/tmp/proj" && typeof c1[0].command_id === "string" && c1[0].command_id.length > 0,
      "⑨ wire payload cwd/prompt + command_id 预生成");
    ack(conn, c1[0].command_id, true);
    check(acks.length === 1 && acks[0].ok === true, "⑨ ACK ok:true → 判定成功（新会话等 SNAPSHOT 落表）");

    conn.ws.readyState = WS_CLOSED;
    iv.snap.lastErrorCmd = null;
    const sent2 = store.send("COMMAND_CREATE", { cwd: "/tmp/p2", prompt: "" }, "srcC");
    check(sent2 === false && (iv.snap.lastErrorCmd ?? "").includes("未连接"),
      "⑨ 断连新建 → 拒发+全局错误可见（不静默丢单）");
  }

  // ═══════ ⑩ 结构闸（e2a-queue 先例：源文本级） ═══════
  {
    const src = fs.readFileSync(LIST_PATH, "utf-8");
    check((src.match(/E2B-COMMANDS-START/g) ?? []).length === 1 && (src.match(/E2B-COMMANDS-END/g) ?? []).length === 1,
      "⑩ E2B-COMMANDS 锚点各恰一次");
    const seg = src.split("E2B-COMMANDS-START")[1]?.split("E2B-COMMANDS-END")[0] ?? "";
    check(!seg.includes("react-native") && !seg.includes("from \"../store\"") && !seg.includes("Date.now")
      && !seg.includes("useState"),
      "⑩ 锚点段零 RN/零 store 依赖/零时钟（纯函数可直跑）");
    check(!/\.notifications\s*=\s*(\[\]|null)/.test(src),
      "⑩ ListScreen 全文无通知池清空赋值（不清零硬条款的静态面）");
  }

  console.log(`E2b root wiring tests ${tests}/${tests} passed`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  // store 顶层 RelayStore 5s 巡检 interval（原生桩 AppState 不触发卸载），显式退出防挂
  .finally(() => process.exit(0));
