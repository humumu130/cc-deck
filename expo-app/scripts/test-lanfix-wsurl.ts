// W-LANFIX（1016 夜班 P1）：LAN 直连裸 host 条目重连死循环修复直跑测试。
//
// 生产实锤：Mac 换 IP（.105→.103）后手机新条目 ws://192.168.0.103:8787（手输裸
// host 无路径）→ probeLan 拼 ?token 后 upgrade path=/ 被 relay 拒（只认 /ws）
// → 每 5s 死循环「重连中」。
//
// 覆盖面：
//   1. withWsPath 纯函数——裸 host/根路径补 /ws、已有路径（/ws、桥路径）原样、
//      query/hash 保留、非 ws 形态原样；
//   2. 消费锚——probeLan / probeLanIdentity 两拼接点过 withWsPath（静态）；
//   3. 归并吸收——connectServer 同 host:port 合并时 wsUrl 吸收带路径写法（静态），
//      dedupeServers 裸↔/ws 等价归并回归（迁移保留路径的行为基础）；
//   4. 写入根修——SetupScreen add/saveEdit LAN 形态补路径、submitCloud 云桥不动（静态）。
//
// 桩层同 test-401c-clouddev.ts。直跑（tsx 装在 relay/node_modules）：
//   cd expo-app && node --import tsx scripts/test-lanfix-wsurl.ts
// store.ts 顶层 new RelayStore() 起 5s 巡检 interval——末尾必须 process.exit。

// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";
// @ts-expect-error 同上（node:* 未进 types 字段）
import { readFileSync } from "node:fs";
// @ts-expect-error 同上
import { fileURLToPath } from "node:url";
// @ts-expect-error 同上
import { dirname, join } from "node:path";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, context: unknown) => LoadResult): LoadResult;
}

const STUB_BASES = new Set([
  "react",
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
  const mod = await import("../src/store.ts");
  const { withWsPath, isLanUrl, dedupeServers } = mod;

  // ---------- A. withWsPath 纯函数 ----------
  // A1 生产实锤形态：手输裸 host（换 IP 后新条目）→ 补 /ws
  check(withWsPath("ws://192.168.0.103:8787") === "ws://192.168.0.103:8787/ws", "A1 裸 host 补 /ws（生产死循环形态）");
  check(withWsPath("ws://10.0.0.5:9000") === "ws://10.0.0.5:9000/ws", "A1b 另一 RFC1918 段同补");
  // A2 已有 /ws 原样（不双斜杠不重写）
  check(withWsPath("ws://192.168.0.103:8787/ws") === "ws://192.168.0.103:8787/ws", "A2 已带 /ws 原样");
  // A3 根路径 → 补 /ws
  check(withWsPath("ws://h:1/") === "ws://h:1/ws", "A3 根路径补 /ws");
  // A4 桥路径原样（云桥地址路径语义自持，不受防御层波及）
  check(withWsPath("wss://cc.example.com/cloud") === "wss://cc.example.com/cloud", "A4 桥路径原样");
  // A5 裸 wss（公网 relay 直连同样只认 /ws）
  check(withWsPath("wss://relay.example.com") === "wss://relay.example.com/ws", "A5 裸 wss 直连补 /ws");
  // A6 query/hash 保留
  check(withWsPath("ws://h:1?x=1") === "ws://h:1/ws?x=1", "A6a query 保留");
  check(withWsPath("ws://h:1#a") === "ws://h:1/ws#a", "A6b hash 保留");
  // A7 非 ws 形态原样（不添乱）
  check(withWsPath("http://x/y") === "http://x/y", "A7a http 原样");
  check(withWsPath("garbage") === "garbage", "A7b 垃圾串原样");
  check(withWsPath("") === "", "A7c 空串原样");
  // A8 回环写法
  check(withWsPath("ws://localhost:8787") === "ws://localhost:8787/ws", "A8 localhost 补 /ws");
  check(isLanUrl("ws://localhost:8787/ws") === true, "A8b 补后仍判 LAN（isLanUrl 不受路径影响）");

  // ---------- B. 消费锚（store.ts 源码静态） ----------
  const here = dirname(fileURLToPath(import.meta.url));
  const storeSrc = readFileSync(join(here, "../src/store.ts"), "utf8");
  const probeLanIdx = storeSrc.indexOf("private probeLan(");
  check(probeLanIdx > 0, "B1 probeLan 在场");
  const probeSeg = storeSrc.slice(probeLanIdx, probeLanIdx + 800);
  check(probeSeg.includes("withWsPath(cfg.wsUrl) +"), "B2 probeLan 拼 URL 过 withWsPath（存量坏条目复活口）");
  const probeIdIdx = storeSrc.indexOf("private async probeLanIdentity(");
  check(probeIdIdx > 0, "B3 probeLanIdentity 在场");
  const probeIdSeg = storeSrc.slice(probeIdIdx, probeIdIdx + 800);
  check(probeIdSeg.includes("withWsPath(wsUrl) +"), "B4 probeLanIdentity 拼 URL 过 withWsPath");

  // ---------- C. 归并链路 ----------
  // C1 connectServer 归并吸收（静态）：同 host:port 合并时 wsUrl 取带路径写法
  const connIdx = storeSrc.indexOf("async connectServer(");
  check(connIdx > 0, "C1 connectServer 在场");
  const connSeg = storeSrc.slice(connIdx, connIdx + 2400);
  check(connSeg.includes("wsUrl: withWsPath(entry.wsUrl)"), "C2 同目标归并吸收 /ws 写法（存量裸条目在下次等价命中时自动升级）");
  // C3 readServers 老单条迁移补路径（静态）
  const readIdx = storeSrc.indexOf("旧单条配置迁移");
  const readSeg = storeSrc.slice(readIdx, readIdx + 800);
  check(readSeg.includes("withWsPath(cfg.wsUrl)"), "C3 老单条迁移落列表补 /ws");
  // C4 dedupeServers 回归：裸 ↔ /ws 同 host:port 仍等价归并（路径不参与身份判断——
  // 本批不破坏既有「同目标多写法归并」语义）
  const dd = dedupeServers([
    { id: "n1", name: "a", wsUrl: "ws://192.168.1.9:8787", token: "t" },
    { id: "n2", name: "b", wsUrl: "ws://192.168.1.9:8787/ws", token: "t2" },
  ]);
  check(dd.list.length === 1, "C4 裸↔/ws 等价归并不因本批劣化");
  // C5 mergeByIdentity 幸存者保留 LAN 写法（归并保留路径的行为基础——快照学身份路径）
  const { mergeByIdentity } = mod;
  const m = mergeByIdentity([
    { id: "c1", name: "cloud", wsUrl: "wss://bridge.example.com", token: "bt", cloud: { bridge: "wss://bridge.example.com", bt: "bt", relayDev: "rl-x", rk: "rk", code: "12345678" } as never },
    { id: "l1", name: "lan", wsUrl: "ws://192.168.1.9:8787/ws", token: "lt", relayDev: "rl-x" },
  ], "l1");
  check(m.list.length === 1 && m.list[0].wsUrl === "ws://192.168.1.9:8787/ws", "C5 身份归并幸存者保留带路径 LAN 写法");

  // ---------- D. 写入根修锚（SetupScreen 静态） ----------
  const setupSrc = readFileSync(join(here, "../src/screens/SetupScreen.tsx"), "utf8");
  const addCount = (setupSrc.match(/isLanUrl\(base0\) \? withWsPath\(base0\) : base0/g) || []).length;
  check(addCount === 2, `D1 add/saveEdit 两处 LAN 形态补路径（实际 ${addCount}）`);
  const cloudIdx = setupSrc.indexOf("const submitCloud = () => {");
  const cloudSeg = setupSrc.slice(cloudIdx, setupSrc.indexOf("const add = () => {"));
  check(!cloudSeg.includes("withWsPath"), "D2 submitCloud 云桥提交不掺路径补全（桥地址语义自持）");

  console.log(`ok - ${tests} assertions passed（W-LANFIX：withWsPath/消费锚/归并吸收/写入根修）`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
