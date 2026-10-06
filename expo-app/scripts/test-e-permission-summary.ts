// P81-8E 权限摘要 expo 呈现直跑测试（worker L / P81-8E）。
//
// 实际直跑入口（expo-app 目录）：
//   npx tsx scripts/test-e-permission-summary.ts
//
// 四段被测面（任务书作业②：词表字面锚+undefined 降级锚+ACK 失败不建卡逻辑面）：
//   A-E. permission.ts 零依赖纯函数直 import（词表字面 deepEq 钉死、forbidden
//        人话通路、SNAPSHOT permission[] 鸭子收容、档集文案、开卡禁选判定、
//        ACK 成功降级提示）
//   G.   protocol.normalizeSnapshotPayload 的 source_capabilities.permission
//        收容链（畸形→不设键=旧 relay 降级隐藏；正常→数组透出）
//   H.   ListScreen.ackVerdict 三态判定门（RN 组件模块 → E2a 同款 registerHooks
//        桩层动态 import；「ACK 失败不建卡」的硬保证=ok 才放行，其余两态 settle
//        一律不造本地会话状态）
//   I.   三面源码字面锚（readFileSync）：NewSessionModal settle 的 forbidden
//        人话通路/降级提示/permission 透传；SettingsDrawer 权限节条件渲染整节
//        隐藏；DetailScreen PERM_LABEL 四档字面对齐三端统一词表
//
// 注意：桩层放行 store.ts（ListScreen 依赖链），其顶层 new RelayStore() 起
// 5s 巡检 interval——末尾必须 process.exit。

// expo tsconfig 不含 node types——仅本测试脚本用 node:module / node:fs
// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";
// @ts-expect-error node:fs 同上
import { readFileSync } from "node:fs";
import {
  PERM_CAP_STATE_LABEL,
  PERM_FORBIDDEN_REASON,
  PERM_MODE_LABEL,
  effectiveNoteOf,
  engineCreateBlock,
  forbiddenReasonOf,
  permissionModesText,
  permissionSummariesOf,
} from "../src/permission";
import { normalizeSnapshotPayload } from "../src/protocol";

// ---------- RN/原生依赖桩层（E2a 同款缩引：万能 magic proxy） ----------
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

const hooks = {
  resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url: string; shortCircuit?: boolean }): { url: string; shortCircuit?: boolean } {
    const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (STUB_BASES.has(base)) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => { format: string; source?: string; shortCircuit?: boolean }): { format: string; source?: string; shortCircuit?: boolean } {
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
const eq = (a: unknown, b: unknown, msg = "deep-equal failed"): void => {
  tests += 1;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`#${tests} ${msg}: got ${ja} want ${jb}`);
};
const SECTION = (name: string): void => console.log(`  ${name}`);

async function main(): Promise<void> {
  const { ackVerdict } = (await import("../src/screens/ListScreen")) as typeof import("../src/screens/ListScreen");

  // ================= A. 词表字面锚（三端统一词表钉死——勿改字面） =================
  SECTION("A. 词表字面锚");
  eq(PERM_CAP_STATE_LABEL, { confirmed: "完整支持", unverified: "未验证 · 请求档可能降级", unsupported: "不支持 · 不可开卡" }, "capability_state 三态词");
  eq(PERM_MODE_LABEL, { default: "每次询问", acceptEdits: "自动接受编辑", plan: "计划模式", bypassPermissions: "完全自动", forbidden: "已拒绝" }, "档位五档词");
  eq(PERM_FORBIDDEN_REASON, {
    capability_state_missing: "引擎能力未确认，已降为每次询问",
    unknown_requested_mode: "未知权限档",
    unknown_engine: "未知引擎",
    zcode_fail_closed: "该引擎不支持权限控制",
    above_role_tier_ceiling: "超出岗位权限上限",
    production_bypass_denied: "生产环境禁止完全自动档",
    env_unknown_bypass_denied: "环境不明，禁止完全自动档",
    unknown_role_mapping: "岗位未映射，已拒绝",
    mixed_engine: "混编引擎，按保守档",
  }, "forbidden reason 码人话九条");

  // ================= B. forbiddenReasonOf 通路 =================
  SECTION("B. forbiddenReasonOf");
  // 九码逐条命中词表（与 A 同源双锚：A 锁表 B 锁通路）
  for (const [code, word] of Object.entries(PERM_FORBIDDEN_REASON)) {
    eq(forbiddenReasonOf(`forbidden: ${code}`), word, `码 ${code} → 人话`);
  }
  eq(forbiddenReasonOf("forbidden: brand_new_code"), "已拒绝（brand_new_code）", "词表外码兜底不吞不猜");
  eq(forbiddenReasonOf("  forbidden:   unknown_engine  "), "未知引擎", "容忍前后空白");
  eq(forbiddenReasonOf("forbidden:"), null, "无码不命中");
  eq(forbiddenReasonOf("forbidden: a b"), null, "码带空格不命中（非单 token）");
  eq(forbiddenReasonOf("timeout"), null, "非 forbidden 形透传 null");
  eq(forbiddenReasonOf("命令被拒绝"), null, "泛拒绝文案不是 forbidden 形");
  eq(forbiddenReasonOf(undefined), null, "非串 undefined → null");
  eq(forbiddenReasonOf(null), null, "非串 null → null");
  eq(forbiddenReasonOf({ error: "forbidden: mixed_engine" }), null, "对象不命中（调用方先剥 error 串）");

  // ================= C. permissionSummariesOf 收容（undefined 降级锚） =================
  SECTION("C. permissionSummariesOf");
  eq(permissionSummariesOf(undefined), [], "undefined（旧 relay 不发）→ [] 降级");
  eq(permissionSummariesOf(null), [], "null → []");
  eq(permissionSummariesOf("x"), [], "非数组串 → []");
  eq(permissionSummariesOf(42), [], "非数组数 → []");
  eq(permissionSummariesOf([]), [], "空数组 → []（无条目同降级语义）");
  eq(permissionSummariesOf([
    { engine: "codex", capability_state: "confirmed", modes: ["default", "acceptEdits"] },
  ]), [{ engine: "codex", capability_state: "confirmed", modes: ["default", "acceptEdits"] }], "正常条目透出");
  eq(permissionSummariesOf([
    null,
    42,
    "codex",
    {},
    { engine: "", capability_state: "confirmed", modes: [] },
    { engine: "codex", capability_state: "maybe", modes: [] },
    { engine: "codex", capability_state: "confirmed", modes: "all" },
    { engine: "codex", capability_state: "confirmed", modes: ["default", 7, null, ""] },
    { engine: "zcode", capability_state: "unsupported" },
  ]), [
    { engine: "codex", capability_state: "confirmed", modes: [] },
    { engine: "codex", capability_state: "confirmed", modes: ["default"] },
    { engine: "zcode", capability_state: "unsupported", modes: [] },
  ], "畸形条目剔除；核心字段合法 modes 畸形 → 条目保留档集降空（呈现层空档集不显行）");

  // ================= D. permissionModesText 档集文案 =================
  SECTION("D. permissionModesText");
  eq(permissionModesText(["default", "acceptEdits"]), "每次询问 / 自动接受编辑", "词表档映射+分隔");
  eq(permissionModesText(["plan", "bypassPermissions", "forbidden"]), "计划模式 / 完全自动 / 已拒绝", "三档连排");
  // relay 归一档载荷（P81-2 modes 实发值域）：别名表译到词表键再人话——对表 relay
  // NATIVE_CLAUDE（ask→default / edit-auto→acceptEdits / full-auto→bypassPermissions）
  eq(permissionModesText(["ask", "plan"]), "每次询问 / 计划模式", "归一档别名：confirmed 引擎档集");
  eq(permissionModesText(["edit-auto", "full-auto"]), "自动接受编辑 / 完全自动", "归一档别名：edit-auto/full-auto");
  eq(permissionModesText(["weird_mode"]), "weird_mode", "词表外档原样保留不吞");
  eq(permissionModesText([]), "", "空档集 → 空串（unsupported 行不显档集）");

  // ================= E. engineCreateBlock 开卡禁选判定 =================
  SECTION("E. engineCreateBlock");
  eq(engineCreateBlock(undefined, "codex"), null, "undefined（旧 relay）→ 不设防放行");
  eq(engineCreateBlock([], "codex"), null, "空摘要 → 放行");
  eq(engineCreateBlock([{ engine: "claude", capability_state: "unsupported", modes: [] }], "codex"), null, "该引擎无条目 → 放行（不越权代判）");
  eq(engineCreateBlock([{ engine: "codex", capability_state: "confirmed", modes: ["default"] }], "codex"), null, "confirmed → 可选");
  eq(engineCreateBlock([{ engine: "codex", capability_state: "unverified", modes: ["default"] }], "codex"), null, "unverified → 可选（请求档可能降级，不禁选）");
  eq(engineCreateBlock([{ engine: "codex", capability_state: "unsupported", modes: [] }], "codex"), "不支持 · 不可开卡", "unsupported → 词表态词禁选");

  // ================= F. effectiveNoteOf ACK 成功降级提示 =================
  SECTION("F. effectiveNoteOf");
  eq(effectiveNoteOf(null), null, "null → 无提示");
  eq(effectiveNoteOf(undefined), null, "undefined → 无提示（旧 relay ACK 无 permission）");
  eq(effectiveNoteOf("x" as unknown as { normalized?: unknown; effective?: unknown }), null, "非对象 → 无提示");
  eq(effectiveNoteOf({}), null, "字段缺失 → 无提示");
  eq(effectiveNoteOf({ normalized: "", effective: "default" }), null, "normalized 空串 → 无提示");
  eq(effectiveNoteOf({ normalized: "default", effective: "default" }), null, "无降级（相等）→ 无提示");
  eq(effectiveNoteOf({ normalized: "acceptEdits", effective: "default" }), "已按「每次询问」创建（请求档「自动接受编辑」被调整）", "降级 → 词表人话");
  // ACK 实发值域=归一档（relay :2095 normalized_mode/effective_mode）——别名表同样生效
  eq(effectiveNoteOf({ normalized: "full-auto", effective: "ask" }), "已按「每次询问」创建（请求档「完全自动」被调整）", "归一档降级 → 别名后人话");
  eq(effectiveNoteOf({ normalized: "edit-auto", effective: "plan" }), "已按「计划模式」创建（请求档「自动接受编辑」被调整）", "归一档同层调整提示");
  eq(effectiveNoteOf({ normalized: "full-auto", effective: "forbidden" }), "请求的权限档被拒绝（完全自动），会话未创建", "归一档 forbidden → 拒绝提示");
  eq(effectiveNoteOf({ normalized: "bypassPermissions", effective: "forbidden" }), "请求的权限档被拒绝（完全自动），会话未创建", "原生档 forbidden → 拒绝提示");
  eq(effectiveNoteOf({ normalized: "x_mode", effective: "y_mode" }), "已按「y_mode」创建（请求档「x_mode」被调整）", "词表外档原样保留");

  // ================= G. SNAPSHOT 收容链（normalizeSnapshotPayload） =================
  SECTION("G. SNAPSHOT source_capabilities.permission 收容链");
  const snapOf = (source_capabilities: unknown) =>
    normalizeSnapshotPayload({
      connected: true, conn_text: "", conn_state: "online", channel: "lan",
      sessions: [], sources: [{ id: "s1", name: "mac", state: "online", color_key: "k" }],
      active_source_id: "s1", aggregate: false, source_capabilities,
    }).sourceCapabilities;
  // 无 permission 键（旧 relay）→ undefined = 摘要隐藏
  eq(snapOf(undefined)?.permission, undefined, "旧 relay 无 permission → undefined");
  eq(snapOf({})?.permission, undefined, "空 source_capabilities → permission 不设键");
  // 畸形 permission → 不设键 = 降级隐藏（不白屏）
  eq(snapOf({ permission: "nope" })?.permission, undefined, "permission 非数组 → 不设键");
  eq(snapOf({ permission: [null, 42, {}] })?.permission, undefined, "permission 全畸形条目 → 不设键");
  // 正常 → 数组透出
  eq(snapOf({ permission: [{ engine: "codex", capability_state: "unverified", modes: ["default"] }] })?.permission,
    [{ engine: "codex", capability_state: "unverified", modes: ["default"] }], "正常 permission 收容透出");
  eq(snapOf({ permission: [{ engine: "codex", capability_state: "confirmed", modes: ["default"] }, "junk"] })?.permission,
    [{ engine: "codex", capability_state: "confirmed", modes: ["default"] }], "混入畸形条目剔除其余透出");

  // ================= H. ACK 失败不建卡逻辑面（ackVerdict 三态） =================
  SECTION("H. ackVerdict 三态判定门（ACK 失败绝不造本地成功状态）");
  const un = ackVerdict(null);
  check(un.ok === false && un.kind === "unconfirmed", "断连拒发 → unconfirmed（不造会话）");
  const okv = ackVerdict({ ok: true });
  check(okv.ok === true && okv.kind === "ok" && okv.error === null, "ok → 放行（会话状态等 SNAPSHOT 权威帧）");
  const rej = ackVerdict({ ok: false, error: "forbidden: zcode_fail_closed" });
  check(rej.ok === false && rej.kind === "rejected", "forbidden 拒绝 → rejected（不造会话）");
  eq(rej.error, "forbidden: zcode_fail_closed", "ackVerdict 原样透传错误串——人话映射归 settle 层（forbiddenReasonOf），两层分工");
  eq(ackVerdict({ ok: false }).error, "命令被拒绝", "无 error 的拒绝 → 兜底文案");
  eq(ackVerdict(undefined).kind, "unconfirmed", "undefined ACK → unconfirmed");
  // forbidden 人话两层全链：ACK error 串 → ackVerdict 透传 → forbiddenReasonOf 人话
  eq(forbiddenReasonOf(ackVerdict({ ok: false, error: "forbidden: production_bypass_denied" }).error),
    "生产环境禁止完全自动档", "全链：ACK forbidden → 透传 → 人话");

  // ================= I. 三面源码字面锚 =================
  SECTION("I. 三面源码字面锚");
  const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
  const modalSrc = srcOf("../src/screens/NewSessionModal.tsx");
  const drawerSrc = srcOf("../src/screens/SettingsDrawer.tsx");
  const detailSrc = srcOf("../src/screens/DetailScreen.tsx");
  // 面②：settle 的 forbidden 人话通路 + 成功降级提示 + permission 透传 + 断连收场
  check(modalSrc.includes("forbiddenReasonOf(v.error)"), "settle err 分支 forbidden 人话优先");
  check(modalSrc.includes("effectiveNoteOf(perm)"), "settle ok 分支降级提示通路");
  check(modalSrc.includes("settle(ackVerdict(r), r.permission)"), "ACK permission 原样透传 settle");
  check(modalSrc.includes("settle(ackVerdict(null))"), "断连拒发同口径收场（不静默丢单）");
  check(modalSrc.includes("不本地造会话状态"), "ok 分支不造本地会话状态锚（E2c 语义保持）");
  // 面①：权限节在线过滤 + 整节条件渲染（undefined 降级隐藏）
  check(drawerSrc.includes("permissionSummariesOf(s.sourceCapabilities?.permission)"), "权限节单口径收容+在线过滤");
  check(drawerSrc.includes("permSections.length ?"), "全空 → 整节隐藏条件渲染");
  // P81-8EFIX 三态色锚：unverified 必须 c.working（#FFD60A 琥珀，同 web --working）——
  // expo 主题 waiting=#F0524F 是红（跨端 token 同名异色），误用会把三态梯度坍缩成两红
  check(drawerSrc.includes("unverified: c.working"), "三态色 unverified=working（琥珀，跨端对齐）");
  check(!drawerSrc.includes("unverified: c.waiting"), "三态色禁用 waiting（expo waiting=红，非 web 语义）");
  // 面③：DetailScreen PERM_LABEL 四档字面对齐三端统一词表（词表钉死）
  for (const w of ["每次询问", "自动接受编辑", "计划模式", "完全自动"]) {
    check(detailSrc.includes(`"${w}"`), `DetailScreen PERM_LABEL 字面对齐词表：${w}`);
  }

  console.log(`\nOK ${tests} assertions`);
  process.exit(0); // 桩层放行的 store.ts 有 5s 巡检 interval，显式退
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
