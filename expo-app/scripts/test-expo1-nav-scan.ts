// 0.7 批 1 件 1/件 2 直跑测试（W-EXPO1）：
//   件 1 断言——底部导航四域表完整性（键唯一、顺序、标签、占位域齐全）；
//   件 2 断言——ScanScreen.parseScanPayload 消费 index-005 新出码形状：
//     · ccdeck-add v2 智能码（lan+cloud 双路 / 单路）→ smart 落路由
//     · 旧 app2 网页链接（修复前的 QR 内容）→ null（真因文档化）
//     · 既有四格式不回归（v1 直连 / ccdeck-login / ccdeck-add v1 / ccdeck-import）
//
// 运行（tsx 装在 relay/node_modules）：
//   relay 目录：   node --import tsx ../expo-app/scripts/test-expo1-nav-scan.ts
//   expo-app 目录：node --import tsx scripts/test-expo1-nav-scan.ts
// 桩层同 test-e2a-list.ts；末尾 process.exit（无长驻 interval 也统一收口）。

// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";

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

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const tabs = await import("../src/bottom-tabs.tsx");
  // @ts-expect-error 同上（ScanScreen 全 RN 依赖走桩）
  const scan = await import("../src/screens/ScanScreen.tsx");
  const parse = scan.parseScanPayload;

  // ---------- 件 1：四域表完整性（W-EXPOLISH 件六回四域：通知改挂顶栏铃铛） ----------
  const TABS = tabs.TABS;
  check(Array.isArray(TABS) && TABS.length === 4, "四域 tab");
  check(
    JSON.stringify(TABS.map((t: { key: string }) => t.key)) === JSON.stringify(["sessions", "team", "projects", "settings"]),
    "域顺序：会话/团队/项目/设置",
  );
  check(new Set(TABS.map((t: { key: string }) => t.key)).size === 4, "tab 键唯一");
  check(TABS.every((t: { label: string }) => typeof t.label === "string" && t.label.length > 0), "每域有标签");
  check(!(tabs.TABS as { key: string }[]).some((t) => t.key === "notifications"), "通知不占底栏域（件六）");
  check((tabs as Record<string, unknown>).DomainPlaceholder === undefined, "占位域组件已退役（四域全内容化）");

  // ---------- 件 2：index-005 新出码形状 → parseScanPayload ----------
  // 双路智能码（index-005 drawSmartPairQr 的 JSON.stringify(Object.assign(...)) 形状逐字对齐）
  const smartBoth = JSON.stringify(Object.assign(
    { t: "ccdeck-add", v: 2 },
    { lan: { url: "ws://192.168.1.9:8787/ws", token: "lantoken" } },
    { cloud: { bridge: "wss://cc.example", bt: "bt", rd: "rl-1a2b3c4d", rk: "rkkey", code: "12345678" } },
  ));
  const rBoth = parse(smartBoth);
  check(!!rBoth && !!rBoth.smart, "双路智能码落 smart 分支");
  check(!!rBoth?.smart?.lan && !!rBoth?.smart?.cloud, "双路齐备（App 侧 probeLanWs 自主择路）");
  check(rBoth?.smart?.lan?.url === "ws://192.168.1.9:8787/ws", "LAN 路地址透传（尾斜杠归一）");
  // 单路：纯云（桌面未接 LAN / 公网域名出码）
  const smartCloudOnly = JSON.stringify({ t: "ccdeck-add", v: 2, cloud: { bridge: "wss://cc.example", bt: "bt", rd: "rl-1a2b3c4d", rk: "rkkey", code: "12345678" } });
  const rCloud = parse(smartCloudOnly);
  check(!!rCloud?.smart?.cloud && !rCloud?.smart?.lan, "纯云单路智能码可解析");
  // 单路：纯 LAN（relay 未接云桥）
  const smartLanOnly = JSON.stringify({ t: "ccdeck-add", v: 2, lan: { url: "ws://192.168.1.9:8787/ws", token: "lantoken" } });
  check(!!parse(smartLanOnly)?.smart?.lan, "纯 LAN 单路智能码可解析");
  // 云路校验硬化不回归：rd 前缀 / code 位数（纯云坏码 → 整体 null；双路坏云 → 云路置空 LAN 路保留）
  const badRd = JSON.stringify({ t: "ccdeck-add", v: 2, cloud: { bridge: "wss://cc.example", bt: "bt", rd: "xx-1a2b", rk: "rkkey", code: "12345678" } });
  check(parse(badRd) === null, "纯云坏 rd 码整体拒收");
  const mixedBadCloud = JSON.stringify({ t: "ccdeck-add", v: 2, lan: { url: "ws://192.168.1.9:8787/ws", token: "lantoken" }, cloud: { bridge: "wss://cc.example", bt: "bt", rd: "xx-1a2b", rk: "rkkey", code: "12345678" } });
  const rMixed = parse(mixedBadCloud);
  check(!!rMixed?.smart?.lan && rMixed?.smart?.cloud === null, "双路坏云：云路置空 LAN 路保留");

  // 真因文档化：修复前 QR 内容（app2 网页链接）App 解析为 null
  check(parse("http://192.168.1.9:8787/app2?token=lantoken") === null, "旧 app2 链接码不被 App 认（真因）");
  check(parse("https://cc.humumu.online/app2?token=x") === null, "云通道 app2 链接码同样不被认");

  // ---------- 既有四格式不回归 ----------
  const v1direct = JSON.stringify({ url: "ws://192.168.1.9:8787/ws", token: "t" });
  check(parse(v1direct)?.wsUrl === "ws://192.168.1.9:8787/ws", "v1 直连码不回归");
  const login = JSON.stringify({ t: "ccdeck-login", dev: "wb-abcdef1234", pk: "A".repeat(64), name: "web" });
  check(!!parse(login)?.login, "ccdeck-login 不回归");
  const inviteV1 = JSON.stringify({ t: "ccdeck-add", bridge: "wss://cc.example", bt: "bt", rd: "rl-1a2b3c4d", rk: "rkkey", code: "12345678" });
  check(!!parse(inviteV1)?.invite, "ccdeck-add v1 不回归");
  const imp = JSON.stringify({ t: "ccdeck-import", rt: { url: "ws://192.168.1.9:9999", token: "t" } });
  check(!!parse(imp)?.import, "ccdeck-import 不回归");
  check(parse("ws://192.168.1.9:8787/ws?token=t")?.wsUrl === "ws://192.168.1.9:8787/ws", "裸 ws 带参形式不回归");

  console.log(`ok - ${tests} assertions passed（底部导航四域表（件六通知回铃铛）+ 智能码五格式消费）`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
