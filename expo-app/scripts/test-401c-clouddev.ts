// 0.7 批 1 件 3 云桥互踢残留修复直跑测试（W-EXPO1）。
//
// 实际直跑入口（两处均可，任选其一；tsx 装在 relay/node_modules）：
//   relay 目录：   node --import tsx ../expo-app/scripts/test-401c-clouddev.ts
//   expo-app 目录：node --import tsx scripts/test-401c-clouddev.ts
//
// 覆盖面：
//   1. cloudDevFor——per-(设备,relay) 派生身份的格式/确定性/跨 relay·跨设备唯一性/
//      与旧全设备共用口径（devId(pubkey,"ph")）相异；
//   2. resolveCloudDev——显式登记优先、空/缺回落派生；
//   3. mergeByIdentity 回归（#401b 同源身份归并不因本批改动劣化）；
//   4. dedupeServers 回归（同目标多写法归并：ws/wss、尾斜杠、大小写）。
//
// 桩层同 test-e2a-list.ts：RN/原生依赖指 magic proxy。注意 store.ts 顶层
// new RelayStore() 起 5s 巡检 interval——末尾必须 process.exit。

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
  // @ts-expect-error 同上（e2e 直载无桩依赖）
  const e2e = await import("../src/e2e.ts");
  const { cloudDevFor, resolveCloudDev, mergeByIdentity, dedupeServers, identityOf } = mod;
  const { devId } = e2e;

  // ---------- fixture：公钥形态不参与校验（按 ASCII 直入哈希），固定字面量即可 ----------
  const pkA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const pkB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
  const rdHome = "rl-1a2b3c4d5e6f7788";
  const rdWork = "rl-9f8e7d6c5b4a3210";

  // 1. cloudDevFor 基性
  const d1 = cloudDevFor(rdHome, pkA);
  check(/^ph-[0-9a-f]{16}$/.test(d1), `格式 ph-+16hex，实得 ${d1}`);
  check(d1.length <= 64, "桥侧 MAX_DEV=64 约束内");
  check(cloudDevFor(rdHome, pkA) === d1, "确定性：同入参恒同值");
  check(cloudDevFor(rdHome, pkA) !== devId(pkA, "ph"), "相异于旧全设备共用口径");

  // 2. 唯一性：跨 relay 必不同（互踢根除的前提）、跨设备必不同（防手机间互踢）
  check(cloudDevFor(rdWork, pkA) !== d1, "跨 relay 派生 dev 不同");
  check(cloudDevFor(rdHome, pkB) !== d1, "跨设备派生 dev 不同");
  const many = new Set(Array.from({ length: 40 }, (_, i) => cloudDevFor(`rl-${i}`, pkA)));
  check(many.size === 40, "40 个不同 relay 派生 40 个互异 dev（无碰撞）");

  // 3. resolveCloudDev：显式登记优先，空/缺回落派生
  check(resolveCloudDev({ dev: "ph-stamped", url: "", token: "", relayDev: rdHome, relayPubkey: "rk" }, pkA) === "ph-stamped", "显式 dev 优先");
  check(resolveCloudDev({ dev: "", url: "", token: "", relayDev: rdHome, relayPubkey: "rk" }, pkA) === d1, "空串 dev 回落派生");
  check(resolveCloudDev({ url: "", token: "", relayDev: rdHome, relayPubkey: "rk" }, pkA) === d1, "缺 dev 字段回落派生");
  check(resolveCloudDev(undefined, pkA) === cloudDevFor("", pkA), "无 cloud 回落不崩（防御面）");

  // 4. mergeByIdentity 回归（#401b 同源身份归并：云+LAN 双条目合一，LAN 写法胜出）
  const lanEntry = { id: "a", name: "192.168.1.9", wsUrl: "ws://192.168.1.9:8787/ws", token: "lantoken", relayDev: rdHome };
  const cloudEntry = {
    id: "b", name: "bridge.example", wsUrl: "wss://bridge.example", token: "bt",
    cloud: { url: "wss://bridge.example", token: "bt", relayDev: rdHome, relayPubkey: "rk", dev: d1 },
  };
  const m1 = mergeByIdentity([lanEntry, cloudEntry]);
  check(m1.list.length === 1 && m1.list[0].id === "b", "同 relayDev 双条目归并为一条（已配对云桥者优先幸存）");
  check(m1.list[0].wsUrl === lanEntry.wsUrl, "幸存者 wsUrl 取 LAN 直连写法");
  check(!!m1.list[0].cloud && m1.list[0].cloud.dev === d1, "幸存者保留 cloud 全量身份（含本批派生 dev）");
  check(m1.remap.get("a") === "b", "remap 记录被并条目指向幸存者");
  const m2 = mergeByIdentity([lanEntry, cloudEntry], "a");
  check(m2.list.length === 1 && m2.list[0].id === "a", "preferId（在线方）命中即幸存");
  // 异 relay 不归并
  const otherCloud = { ...cloudEntry, id: "c", cloud: { ...cloudEntry.cloud!, relayDev: rdWork } };
  check(mergeByIdentity([lanEntry, otherCloud]).list.length === 2, "异 relayDev 不归并");

  // 5. identityOf 口径回归
  check(identityOf(cloudEntry) === rdHome, "identityOf 云桥配对 id 优先");
  check(identityOf(lanEntry) === rdHome, "identityOf LAN 标记次之");

  // 6. dedupeServers 回归（同目标多写法：ws/wss、尾斜杠、host 大小写、缺省端口）
  const dd = dedupeServers([
    { id: "x1", name: "n1", wsUrl: "ws://192.168.1.9:8787/ws", token: "t" },
    { id: "x2", name: "n2", wsUrl: "ws://192.168.1.9:8787/", token: "t" },
    { id: "x3", name: "n3", wsUrl: "ws://192.168.1.9:8787", token: "t" },
    { id: "x4", name: "n4", wsUrl: "ws://192.168.1.9:8787/ws", token: "t2" },
  ]);
  check(dd.list.length === 1 && dd.list[0].id === "x1", "同目标四写法归并为一条（先出现者幸存）");
  check(dd.remap.size === 3, "remap 记录三条被并");

  console.log(`ok - ${tests} assertions passed（0.7 批 1 件 3：cloudDevFor/resolveCloudDev/mergeByIdentity/dedupeServers）`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
