// E4b 通知 ACK 接线/权限拒绝可见/通知恢复/配对失败回退 直跑测试（worker H / #018-E4b）。
//
// 直跑入口（tsx 装在 relay/node_modules，--import 解析以 cwd 为基准）：
//   relay 目录：node --import tsx ../expo-app/scripts/test-e4b-notify.ts
//
// 被测面与桩法（仿 E3b）：
//   ① ACK 可见面模型（protocol.ts E4b 段 todoSurface/ackTapGuard）——纯函数；
//   ② 权限拒绝一次性提示闸（notify.ts permHintActive 会话去重）——纯函数 + 平台门
//      （node 桩环境 Platform.OS=magic≠"android" → 门直通，顺带锁 API 可调不炸）；
//   ③ 前台通知 S| 键与 title 组装（notify.ts fgStatsKey/fgStatsTitle，从 App effect
//      抽出的恢复链路直测面）——纯函数，同输入恒同输出=重放不闪跳；
//   ④ store 通知账重放（重连快照/值替换帧）——仿 E3b 假 SourceConn + 私有 onMessage
//      驱动，测**真实 store 代码路径**：同账重放计数不跳变不清零、权威帧单步收敛；
//   ⑤ 配对/云桥失败三型（store.addCloudManual→pairViaBridge 真链路）——假桥 WebSocket
//      （覆盖 node 全局 WebSocket，store 内为 RN 全局无 import）+ 看门狗定时器缩时
//      （6s/拍 → 12ms/拍），锁：错码/桥不可达/超时三类失败文案可见、结束后不自动
//      重试（无新 ws 无续发）、用户重试可用（第二次发起照常走完整链路）。
//
// 纪律：断言不比对两个独立取时点的 Date.now()（N1② 教训）——被测函数均无时间入参，
// 全部断言为确定性值；末尾 process.exit(0)（store 构造器起 5s 巡检 interval）。

// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";

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

// ---------- 被测模块与 fixture ----------
import type { NotificationItem, SessionState } from "../src/protocol.ts";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const note = (key: string, group: string, over: Partial<NotificationItem> = {}): NotificationItem => ({
  key,
  kind: "approval",
  group,
  severity: "warn",
  title: "待办 " + key,
  body: "正文",
  sourceContext: { domain: "session", entityId: "s1", alertId: "a1", returnPath: "detail" },
  actionable: true,
  created_at: 1000,
  ...over,
});

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const { todoSurface, ackTapGuard, projectNotifications, TODO_SURFACE_MAX } = await import("../src/protocol.ts");
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const notify = await import("../src/notify.ts");
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const { store } = await import("../src/store.ts");
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const e2e = await import("../src/e2e.ts");

  // store 私有内部（测试驱动面，同 E3b）
  interface ConnLike {
    id: string;
    notifications: NotificationItem[] | null;
    sessions: Map<string, SessionState>;
    timelines: Map<string, unknown[]>;
    pendingCmds: Map<string, unknown>;
    ws: { readyState: unknown; send: (s: string) => void };
    [k: string]: unknown;
  }
  const iv = store as unknown as {
    conns: Map<string, ConnLike>;
    sidIndex: Map<string, ConnLike>;
    activeId: string;
    snap: { notifications: NotificationItem[] | null; notificationsLegacy: boolean };
    onMessage: (c: ConnLike, m: unknown) => void;
    devKeys: { publicKey: string; secretKey: string } | null; // BoxKeyPair=b64 字符串对
  };
  const WS_OPEN = 1; // node 全局 WebSocket.OPEN=1（store 内 WebSocket 是 RN 全局，无 import）
  const envelope = (type: string, payload: unknown, sid: string, seq = 0): unknown =>
    ({ type, session_id: sid, payload, seq, ts: 1000 });
  const fire = (conn: ConnLike, type: string, payload: unknown, sid = "s1", seq = 0): void =>
    iv.onMessage(conn, envelope(type, payload, sid, seq));

  const baseSession = (): SessionState => ({
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
  });

  // 假 SourceConn：SourceConn 接口全字段在场（同 E3b 工厂）
  const makeConn = (id: string): ConnLike => {
    const conn = {
      id,
      name: "源-" + id,
      entry: { id, name: id, wsUrl: "ws://lan/" + id } as never,
      cfg: null,
      cloudCfg: null,
      ws: { readyState: WS_OPEN, send: () => {} },
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
    return conn;
  };

  // ═══════════ ① ACK 可见面模型：todoSurface + ackTapGuard ═══════════
  {
    // 旧 relay / 无未决 → 空面（整区隐藏）
    check(todoSurface(null).rows.length === 0 && todoSurface(null).overflow === 0, "① null（旧 relay）→ 空面整区隐藏");
    check(todoSurface(undefined).rows.length === 0, "① undefined → 空面");
    check(todoSurface([]).rows.length === 0, "① 空数组 → 空面");

    const items: NotificationItem[] = [
      note("a1", "action"), // 未决 actionable → 行
      note("a2", "action", { handled_at: 500 }), // 已处理 → 不出行
      note("a3", "action", { resolved_at: 600 }), // 已收敛 → 不出行
      note("a4", "action", { dismissed_at: 700 } as Partial<NotificationItem>), // dismissed（扩展字段）→ 不出行
      note("a5", "action", { actionable: false }), // 非 actionable → 不出行
      note("t1", "attention"), // attention 组 → 不出行（角标同口径只认 action）
      note("y1", "activity"), // activity 组 → 不出行
      note("z9", "weird"), // 未知分组 → 不出行
      note("a6", "action"), // 未决 actionable → 行
    ];
    const surf = todoSurface(items);
    check(surf.rows.length === 2 && surf.overflow === 0, "① 未决 actionable 行 2（handled/resolved/dismissed/非 actionable/他组/未知组全剔除）");
    check(surf.rows[0]!.key === "a1" && surf.rows[1]!.key === "a6", "① 行序=账序（不重排）");
    check(surf.rows.every((r) => r.title.length > 0), "① 行带 title（单行展示位）");
    // 角标口径一致性：todoSurface 与 projectNotifications 同一剔除语义
    check(surf.rows.length === projectNotifications(items).badgeCount, "① 行数=角标数（同一未决口径）");

    // 有界：390 宽不失控（>8 条 → 8 行 + 溢出计数）
    const many: NotificationItem[] = Array.from({ length: 10 }, (_, i) => note("m" + i, "action"));
    const capped = todoSurface(many);
    check(capped.rows.length === TODO_SURFACE_MAX && capped.overflow === 2, "① 行有界 ≤8，溢出计数 2");
    check(capped.rows.every((r) => r.key === "m" + many.findIndex((n) => n.key === r.key)), "① 截断保留账首 8 条");

    // 双击闸：飞行中同 key → skip（不双发）；出闸后 → go；他 key 不串扰
    const flight = new Set<string>(["a1"]);
    check(ackTapGuard(flight, "a1") === "skip", "① 飞行中同 key 重复点击 → skip 不双发");
    check(ackTapGuard(flight, "a6") === "go", "① 他 key 不串扰 → go");
    flight.delete("a1");
    check(ackTapGuard(flight, "a1") === "go", "① onDone 出闸后再点 → go（重试=重点按钮）");

    // 乐观消失/回滚重现场景（调用面语义）：handled_at 一落 → 行消失（无可再点位）；
    // 回滚（无 handled_at）→ 行回来
    const after = todoSurface([note("a1", "action", { handled_at: 900 })]);
    check(after.rows.length === 0, "① 乐观 handled_at 落账 → 行即刻消失（无再点位）");
    check(todoSurface([note("a1", "action")]).rows.length === 1, "① ACK 失败回滚 → 行回来（重试可见）");
  }

  // ═══════════ ② 权限拒绝可见：一次性提示闸 + 平台门 ═══════════
  {
    notify.resetPermHintForTests();
    check(notify.permHintActive(true, false) === false, "② 已授予 → 不提示");
    check(notify.permHintActive(null, false) === false, "② 未知（查询失败/异常）→ 不提示（不出假警报）");
    check(notify.permHintActive(false, false) === true, "② 确认被拒且未提示过 → 恰好出提示");
    notify.markPermHintShown();
    check(notify.permHintActive(false, false) === false, "② 会话去重：本会话第二次不再提示（重连周期反复请求不重弹）");
    notify.resetPermHintForTests();
    check(notify.permHintActive(false, true) === false, "② 用户关闭横幅 → 本会话静默");
    check(notify.permHintActive(false, false) === true, "② 复位后重新可提示（测试面）");

    // node 桩环境（Platform.OS≠android）权限门直通：请求/查询/深链三入口在场且不炸
    check((await notify.ensureNotifPermission()) === true, "② 非平台门 → ensure 直通 true（iOS/低版本无运行时权限）");
    check((await notify.notifPermissionState()) === true, "② 非平台门 → 查询直通 true");
    check(typeof notify.openNotifSettings === "function", "② 系统设置深链入口在场");
    notify.openNotifSettings(); // Linking.openSettings 桩上调用不抛（真机=本 App 系统设置页）
    check(typeof notify.fgStatsKey === "function" && typeof notify.fgStatsTitle === "function", "② 前台统计组装入口在场");
  }

  // ═══════════ ③ 通知恢复：S| 键与 title 同输入恒同输出（重放不闪跳直测面） ═══════════
  {
    check(notify.fgStatsKey(1, 2, 0, 3, 2) === "S|1|2|0|3|2", "③ S| 分布键格式（w|wa|e|dn|badge）");
    const k = notify.fgStatsKey(0, 1, 0, 2, 1);
    check(k === notify.fgStatsKey(0, 1, 0, 2, 1), "③ 同计数恒同键（fgText 去抖：重连/回前台同账重放 → 原生不重发）");
    check(notify.fgStatsKey(0, 1, 0, 2, 1) !== notify.fgStatsKey(0, 1, 0, 2, 2), "③ 角标变化 → 键变化（该重发才重发）");

    check(notify.fgStatsTitle(1, 2, 0, 3, 2) === "待办2 · 工作1 · 等待2｜共6会话", "③ 待办置顶，零值位不出（与 App 旧内联实现逐字节一致）");
    check(notify.fgStatsTitle(1, 2, 1, 3, 0) === "工作1 · 等待2 · 错误1｜共7会话", "③ badge=0 不出待办位（旧 relay 口径）");
    check(notify.fgStatsTitle(0, 0, 0, 5, 0) === "空闲｜5 会话", "③ 全空闲回落完成数");
    check(notify.fgStatsTitle(0, 0, 0, 0, 3) === "待办3｜共0会话", "③ 仅待办也成立");
    // 恢复语义：角标增减只动「待办」位，其余位不动（018 :643 计数不跳变）
    check(notify.fgStatsTitle(1, 1, 0, 2, 5) === "待办5 · 工作1 · 等待1｜共4会话", "③ 角标仅增减待办位");
  }

  // ═══════════ ④ store 通知账重放：重连快照/回前台值替换 → 计数不跳变不清零 ═══════════
  {
    const conn = makeConn("srcR");
    iv.activeId = "srcR"; // emit 只在 fire 时从活动源装配 snap（须先指活动源）
    conn.sessions.set("s1", baseSession());
    conn.timelines.set("s1", []);

    // 首帧快照：1 未决 + 1 已决 → 角标 1
    fire(conn, "SNAPSHOT", { notifications: [note("kR1", "action"), note("kR2", "action", { handled_at: 500 })] });
    check(iv.snap.notificationsLegacy === false, "④ 新 relay 通知账装载");
    check(projectNotifications(iv.snap.notifications).badgeCount === 1, "④ 首帧角标 1（未决 actionable）");
    check(todoSurface(iv.snap.notifications).rows.length === 1, "④ 首帧待办行 1");

    // 重连/回前台：同账重放（新数组新对象同值）→ 计数不跳变不清零、S| 键不变
    const keyBefore = notify.fgStatsKey(0, 0, 0, 1, projectNotifications(iv.snap.notifications).badgeCount);
    fire(conn, "SNAPSHOT", { notifications: [note("kR1", "action"), note("kR2", "action", { handled_at: 500 })] });
    const proj = projectNotifications(iv.snap.notifications);
    check(proj.badgeCount === 1 && proj.total === 2, "④ 重放后角标仍 1、总账仍 2（不清零不丢账）");
    check(notify.fgStatsKey(0, 0, 0, 1, proj.badgeCount) === keyBefore, "④ 重放前后 S| 键相同（原生不重发=通知不闪跳）");

    // 权威值替换帧：单步收敛 1 → 0（中间不经过 0→0 假清零再恢复）
    fire(conn, "NOTIFICATIONS_UPDATED", { items: [note("kR1", "action", { handled_at: 900 }), note("kR2", "action", { handled_at: 500 })] });
    check(projectNotifications(iv.snap.notifications).badgeCount === 0, "④ 权威帧后角标单步收敛 0（对账无翻转）");
    check(todoSurface(iv.snap.notifications).rows.length === 0, "④ 待办行同步清空（UI 面与账一致）");

    // 畸形帧不动既有账（防御，同 E3b 口径）
    fire(conn, "NOTIFICATIONS_UPDATED", { items: "garbage" });
    check(projectNotifications(iv.snap.notifications).total === 2, "④ 畸形帧不覆盖既有账");
  }

  // ═══════════ ⑤ 配对/云桥失败三型（真链路：addCloudManual → pairViaBridge） ═══════════
  {
    // 预置设备密钥：跳过 deviceKeys 的 AsyncStorage 持久化（magic 存储永不定案）
    iv.devKeys = e2e.generateKeyPair();
    const rlKp = e2e.generateKeyPair(); // 假桥上的「relay」身份（真实 nacl 派生，过 devId 自洽校验）

    // 假桥 WebSocket：覆盖 node 全局（store 内 WebSocket 为 RN 全局无 import）。
    // responder 在 send 时同步回帧（模拟桥回包）；failMode=error 时构造后即报错
    type FakeInst = {
      sent: string[];
      closed: boolean;
      onopen: (() => void) | null;
      onmessage: ((ev: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
    };
    const instances: FakeInst[] = [];
    let responder: ((inst: FakeInst, raw: string) => void) | null = null;
    let failMode: "none" | "error" = "none";
    class FakeBridgeWS {
      static OPEN = 1;
      readyState = 1;
      closed = false;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(_url: string) {
        instances.push(this as unknown as FakeInst);
        if (failMode === "error") queueMicrotask(() => this.onerror?.());
      }
      send(raw: string): void {
        this.sent.push(raw);
        responder?.(this as unknown as FakeInst, raw);
      }
      close(): void {
        this.closed = true;
        this.readyState = 3;
      }
    }
    const RealWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeBridgeWS as unknown as typeof WebSocket;

    // 看门狗缩时：pairViaBridge 6s/拍 → 12ms/拍（超时链路 24s → ~50ms，测试可跑）。
    // 仅缩本窗口内新建的 interval，已存在的 store 巡检 interval 不受影响
    const realSI = globalThis.setInterval.bind(globalThis);
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSI(fn, Math.min(ms ?? 0, 12), ...rest);

    // 桥回包剧本：disc → RELAYS（在线 relay 清单）；pair_req → 明文 pair_nack（码错）
    const wrongCodeScript = (inst: FakeInst, raw: string): void => {
      const f = JSON.parse(raw) as { data?: { t?: string } };
      if (f.data?.t === "disc") {
        // rk=b64(pubkey)（BoxKeyPair.publicKey 即 b64 串），dev=devId(b64,"rl")
        //（store 过自洽校验：devId(rk,"rl")===dev）
        inst.onmessage?.({ data: JSON.stringify({ type: "RELAYS", relays: [{ dev: e2e.devId(rlKp.publicKey, "rl"), rk: rlKp.publicKey }] }) });
      } else if (f.data?.t === "pair_req") {
        inst.onmessage?.({ data: JSON.stringify({ type: "m", data: { t: "pair_nack", error: "配对码错误" } }) });
      }
    };

    try {
      // ── 型 1：配对码错（明文 nack → relay 语义错误透传，码未消耗可改码重试） ──
      instances.length = 0;
      responder = wrongCodeScript;
      failMode = "none";
      const p1 = store.addCloudManual("wss://bridge.example/cloud", "tok", "12345678");
      await tick();
      check(instances.length === 1, "⑤ 错码型：恰好发起一条桥连接");
      instances[0]!.onopen?.();
      const r1 = (await p1) as unknown;
      check(r1 === "配对失败：配对码错误", `⑤ 错码型失败可见（got ${JSON.stringify(r1)}）`);
      check(instances[0]!.closed === true, "⑤ 错码型：定案即收线（close）");
      const sentAtSettle = instances[0]!.sent.length;
      await nap(40);
      check(instances.length === 1 && instances[0]!.sent.length === sentAtSettle, "⑤ 错码型：定案后无续发/无新连接（不自动重试风暴）");

      // 用户重试可用：第二次发起照常走完整链路（无锁死、无 busy 残留）
      const p1b = store.addCloudManual("wss://bridge.example/cloud", "tok", "12345678");
      await tick();
      check(instances.length === 2, "⑤ 用户重试：新起一条桥连接");
      instances[1]!.onopen?.();
      check((await p1b) === "配对失败：配对码错误", "⑤ 用户重试：链路完整可复跑");

      // ── 型 2：网桥不可达（ws error → 检查网络与令牌引导） ──
      instances.length = 0;
      responder = null;
      failMode = "error";
      const p2 = store.addCloudManual("wss://bridge.example/cloud", "tok", "12345678");
      await tick();
      const r2 = (await p2) as unknown;
      check(r2 === "连不上云桥（检查网络与云桥令牌）", `⑤ 桥不可达失败可见（got ${JSON.stringify(r2)}）`);
      check(instances[0]!.closed === true, "⑤ 桥不可达：定案即收线");
      failMode = "none";

      // ── 型 3：超时（桥在线但不回应 → 看门狗 4 拍定案，定位失败文案） ──
      instances.length = 0;
      responder = null;
      const p3 = store.addCloudManual("wss://bridge.example/cloud", "tok", "12345678");
      await tick();
      check(instances.length === 1, "⑤ 超时型：已发起桥连接");
      instances[0]!.onopen?.();
      const r3 = (await p3) as unknown;
      check(r3 === "未能定位电脑端的 relay，请重试", `⑤ 超时型失败可见（got ${JSON.stringify(r3)}）`);
      check(instances[0]!.closed === true, "⑤ 超时型：看门狗定案即收线（timer 清理）");
      const sent3 = instances[0]!.sent.length;
      await nap(40);
      check(instances.length === 1 && instances[0]!.sent.length === sent3, "⑤ 超时型：定案后不再拍发（无自动重试风暴）");
    } finally {
      globalThis.WebSocket = RealWS;
      globalThis.setInterval = realSI;
    }
  }

  console.log(`E4b notify/pairing tests ${tests}/${tests} passed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e && e.stack ? e.stack : e));
    process.exit(1);
  });
