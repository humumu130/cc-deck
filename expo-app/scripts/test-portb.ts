// W-PORT-B（P0 池第二批·expo 手机域）直跑测试：P0-1 模型切换 UI / P0-2 会话列表搜索。
//
// 断言面：
//   ① 纯函数：sessionSearchTest（空 query 恒过 / 多词 AND / 大小写不敏感 /
//      title·initial_prompt·action_summary·cwd·session_id 五字段命中——桌面件九直移口径）；
//   ② 源码字面锚：ListScreen 过滤链挂点/搜索条/空态文案/顶栏钮；DetailScreen
//      COMMAND_MODEL 发送接线 / modelSupported 门 / engine_catalog 取法 / ModelSheet
//      挂载 / 模型名校验前移（与 relay session-manager 同则）；
//   ③ 双侧正则一致性：relay 校验则与端上前移则逐字相等。
//
// 运行：expo-app 目录 node --import tsx scripts/test-portb.ts
// 桩层同 test-expodomain.ts（直拷，零共享文件——套件自包含可单跑）。

// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";
// @ts-expect-error node:fs 同上
import { readFileSync } from "node:fs";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}

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
  "BarcodeScanningResult", "LinearGradient", "WebView", "Svg", "Circle", "Rect", "Path",
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

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 断言主体（async main：TLA 不进 cjs 输出，expodomain 同构） ----------
async function main(): Promise<void> {
// ---------- ① 纯函数：sessionSearchTest（桌面件九直移口径） ----------
console.log("P0-2 sessionSearchTest 纯函数:");
// @ts-expect-error The direct test runner loads TypeScript through tsx.
const { sessionSearchTest } = await import("../src/screens/ListScreen.tsx");
type SearchFields = "title" | "initial_prompt" | "action_summary" | "cwd" | "session_id";
const mkS = (o: Partial<Record<SearchFields, string>>) =>
  ({ title: "", initial_prompt: "", action_summary: "", cwd: "", session_id: "", ...o }) as unknown as Parameters<typeof sessionSearchTest>[0];
assert(sessionSearchTest(mkS({ title: "随便" }), "") === true, "空 query 恒过（零行为变化）");
assert(sessionSearchTest(mkS({ title: "W-BOARD2 看板修复" }), "看板") === true, "title 命中");
assert(sessionSearchTest(mkS({ initial_prompt: "修复注入链" }), "注入") === true, "initial_prompt 命中");
assert(sessionSearchTest(mkS({ action_summary: "正在跑测试" }), "测试") === true, "action_summary 命中");
assert(sessionSearchTest(mkS({ cwd: "/Users/xdd/dev/cc-deck" }), "cc-deck") === true, "cwd 命中");
assert(sessionSearchTest(mkS({ session_id: "abc-123-def" }), "abc-123") === true, "session_id 命中");
assert(sessionSearchTest(mkS({ title: "Alpha" }), "alpha") === true, "大小写不敏感");
assert(sessionSearchTest(mkS({ title: "看板修复", cwd: "/a/b" }), "看板 /a") === true, "多词 AND（跨字段同满足）");
assert(sessionSearchTest(mkS({ title: "看板修复" }), "看板 注入") === false, "多词 AND（一词不满足即滤除）");
assert(sessionSearchTest(mkS({ title: "看板" }), "  ") === true, "纯空白 query 视为空（trim 口径）");
assert(sessionSearchTest(mkS({ title: "看板修复" }), "看  板") === true, "词间多空格=按词切分（split(\\s+) 同款）");

// ---------- ② 源码字面锚 ----------
console.log("源码锚（P0-2 ListScreen / P0-1 DetailScreen）:");
const appRoot = new URL("../", import.meta.url).pathname; // expo-app/
const listSrc = readFileSync(appRoot + "src/screens/ListScreen.tsx", "utf-8");
const detailSrc = readFileSync(appRoot + "src/screens/DetailScreen.tsx", "utf-8");
const relaySm = readFileSync(appRoot + "../relay/src/session-manager.ts", "utf-8");

// P0-2
assert(listSrc.includes(".filter((s) => sessionSearchTest(s, searchQ))"), "过滤链挂 visible 末端（投影计数自然联动）");
assert(listSrc.includes("searchBar") && listSrc.includes("searchInput"), "搜索条与输入框样式在场");
assert(listSrc.includes('placeholder="搜索名称、摘要、目录"'), "placeholder 如实标注检索范围（桌面同文案）");
assert(listSrc.includes("下暂无会话") && listSrc.includes("清空搜索"), "搜索空态文案（一句状态+一句指引）");
assert(listSrc.includes("SearchGlyph") && listSrc.includes("setSearchOpen((v) => { if (v) setSearchQ(\"\"); return !v; })"), "顶栏搜索钮：收起即清空（过滤不留隐藏残留）");

// P0-1
assert(detailSrc.includes('store.send("COMMAND_MODEL", { session_id: sid, model }'), "COMMAND_MODEL 发送接线（协议栈既有）");
assert(detailSrc.includes("const modelSupported = canCmd && !s.historical && (external || !s.engine || s.engine === \"claude\")"), "可用门=桌面 capsuleSupported 同口径");
assert(detailSrc.includes("sourceCapabilities?.engine_catalog"), "模型清单=engine_catalog 按引擎取（不冒充 SNAPSHOT.models）");
assert(detailSrc.includes("external ? \"claude\" : s.engine || \"claude\""), "外部会话回退 claude 清单（桌面同款）");
assert(detailSrc.includes("<ModelSheet"), "ModelSheet 挂载（PermPanel 同范式受控显隐）");
assert(detailSrc.includes("切换模型 · 下一回合生效"), "面板标题带生效语义（用户预期管理）");
assert(detailSrc.includes("模型切换未生效"), "失败走全局错误 toast（notifyCmdError）");
assert(detailSrc.includes("applyCustom"), "自定义模型名输入行在场");

// ---------- ③ 双侧正则一致性 ----------
console.log("模型名校验双侧一致:");
const RE = "/^[\\w.\\/-]{1,80}$/";
const relayHas = relaySm.includes(RE);
const detailHas = detailSrc.includes(RE);
assert(relayHas && detailHas, "端上前移校验与 relay COMMAND_MODEL 校验同则（非法名本地拦下不白发）");
assert(detailSrc.includes(".replace(/\\[1m\\]$/, \"\")"), "端上剥 [1m] 后缀（relay 同款清洗）");

console.log(`\n${fail === 0 ? "OK" : "FAIL"} ${pass} assertions（W-PORT-B：P0-1 模型切换 / P0-2 会话搜索）`);
process.exit(fail === 0 ? 0 : 1);
}
void main();
