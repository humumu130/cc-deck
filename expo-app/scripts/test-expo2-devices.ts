// 0.7 批 2 直跑测试（W-EXPO2）——连接与设备面：
//   ① connStateTone：store 六态 → 状态灯四色（绿在线/黄连接中含重连/红配对失效/灰未连）
//   ② connStateNote：服务器卡副行状态词（unpaired 点明人工重配引导）
//   ③ peerKindLabel：COMMAND_PEERS 下发 kind 的人话映射
//   ④ peerRelTime：设备卡相对时间（0=未知不显示假数据；分/时/天/日期边界）
//   ⑤ pairErrNote：配对码错误分层（过期→重领引导 / 无效→核对引导 / 连错≥3 追加
//      锁定预警 / 网络类错误原文透传 / 空串）
//   ⑥ ScanScreen.parseScanPayload 回归：批 2 改动（onRoute 挂接）不破坏五格式解析
//
// 运行（tsx 装在 expo-app/node_modules）：
//   expo-app 目录：node --import tsx scripts/test-expo2-devices.ts
// 桩层同 test-expo1-nav-scan.ts；末尾 process.exit 收口。

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

registerHooks({
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
} as ModuleHooks);

import { connStateTone, connStateNote, peerKindLabel, peerRelTime, pairErrNote } from "../src/protocol";
// parseScanPayload 依赖 react-native（stub hook 须先注册）——与批 1 同款动态 import
//（main() 内；tsx cjs 转译不支持顶层 await）

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual: unknown, expected: unknown, label: string) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`);
}

async function main() {
// @ts-expect-error The direct test runner loads TypeScript through tsx.
const { parseScanPayload } = await import("../src/screens/ScanScreen.tsx");

// ── ① connStateTone：六态归四色 ──
eq(connStateTone("online"), "online", "tone: online→绿");
eq(connStateTone("connecting"), "busy", "tone: connecting→黄");
eq(connStateTone("reconnecting"), "busy", "tone: reconnecting→黄（重连同属 busy，闪烁）");
eq(connStateTone("unpaired"), "bad", "tone: unpaired→红（唯一须人工重配态）");
eq(connStateTone("offline"), "off", "tone: offline→灰");
eq(connStateTone("idle"), "off", "tone: idle→灰");
eq(connStateTone(undefined), "off", "tone: undefined→灰（无快照兜底）");
eq(connStateTone(null), "off", "tone: null→灰");
eq(connStateTone("junk"), "off", "tone: 未知串→灰（fail-closed）");

// ── ② connStateNote：副行状态词 ──
eq(connStateNote("online"), "在线", "note: online");
eq(connStateNote("connecting"), "连接中…", "note: connecting");
eq(connStateNote("reconnecting"), "重连中…", "note: reconnecting");
eq(connStateNote("offline"), "已断开 · 点按重连", "note: offline 带行动引导");
eq(connStateNote("unpaired"), "配对失效 · 点按重新配对", "note: unpaired 点明人工重配");
eq(connStateNote("idle"), "点按连接", "note: idle 行动语义");
eq(connStateNote(undefined), "点按连接", "note: undefined 兜底");

// ── ③ peerKindLabel ──
eq(peerKindLabel("phone"), "手机", "kind: phone");
eq(peerKindLabel("web"), "网页", "kind: web");
eq(peerKindLabel("watch"), "手表", "kind: watch");
eq(peerKindLabel("other"), "设备", "kind: other 兜底");
eq(peerKindLabel("junk"), "设备", "kind: 未知串兜底");

// ── ④ peerRelTime ──
const NOW = 1_800_000_000_000;
eq(peerRelTime(0, NOW), "—", "rel: 0=未知显示 —（relay 重启清零，不显假数据）");
eq(peerRelTime(-5, NOW), "—", "rel: 负值=未知");
eq(peerRelTime(NaN, NOW), "—", "rel: NaN=未知");
eq(peerRelTime(NOW - 30_000, NOW), "刚刚", "rel: <1min");
eq(peerRelTime(NOW - 5 * 60_000, NOW), "5 分钟前", "rel: 分钟档");
eq(peerRelTime(NOW - 3 * 3_600_000, NOW), "3 小时前", "rel: 小时档");
eq(peerRelTime(NOW - 2 * 86_400_000, NOW), "2 天前", "rel: 天档");
const old = NOW - 45 * 86_400_000;
eq(peerRelTime(old, NOW), new Date(old).toLocaleDateString(), "rel: >30 天回落日期");
ok(peerRelTime(NOW + 60_000, NOW) === "刚刚", "rel: 未来时间不崩溃（钟差夹 0）");

// ── ⑤ pairErrNote：配对码错误分层 ──
eq(pairErrNote("配对失败：配对码无效或已过期", 0), "配对码已过期 · 请在电脑端重新领取新码再试", "pair: 过期→重领引导");
eq(pairErrNote("配对失败：配对码无效", 1), "配对码无效 · 请核对电脑端弹出的 8 位码", "pair: 无效→核对引导");
eq(
  pairErrNote("配对失败：配对码无效", 3),
  "配对码无效 · 请核对电脑端弹出的 8 位码\n已连续输错 3 次 · 连续 5 次将暂停配对 10 分钟",
  "pair: 连错≥3 追加锁定预警",
);
eq(pairErrNote("配对失败：配对码无效", 2), "配对码无效 · 请核对电脑端弹出的 8 位码", "pair: 连错<3 不预警");
eq(pairErrNote("连不上云桥（检查网络与云桥令牌）", 2), "连不上云桥（检查网络与云桥令牌）", "pair: 网络类原文透传不包装");
eq(pairErrNote("目标 relay 不在线（配对码未消耗），确认电脑端 CC Deck 已连上云桥后再试", 1), "目标 relay 不在线（配对码未消耗），确认电脑端 CC Deck 已连上云桥后再试", "pair: 不在线类原文透传");
eq(pairErrNote(null, 5), "", "pair: null→空串");
eq(pairErrNote("", 5), "", "pair: 空串→空串");

// ── ⑥ parseScanPayload 回归（批 2 ScanScreen 改动不破坏解析）──
// v2 智能码双路
const smartBoth = JSON.stringify({
  t: "ccdeck-add", v: 2,
  lan: { url: "ws://192.168.1.8:8787/ws", token: "lan-tok" },
  cloud: { bridge: "wss://bridge.example", bt: "bt", rd: "rl-abcdef12", rk: "rk-key", code: "12345678" },
});
const sb = parseScanPayload(smartBoth);
ok(!!sb?.smart && !!sb.smart.lan && !!sb.smart.cloud, "scan: v2 双路→smart.lan+cloud");
// v2 单云路
const smartCloudOnly = JSON.stringify({
  t: "ccdeck-add", v: 2, lan: null,
  cloud: { bridge: "wss://bridge.example", bt: "bt", rd: "rl-abcdef12", rk: "rk-key", code: "12345678" },
});
const sc = parseScanPayload(smartCloudOnly);
ok(!!sc?.smart && sc.smart.lan === null && !!sc.smart.cloud, "scan: v2 单云路→lan=null");
// v1 直连
const v1 = JSON.stringify({ url: "ws://192.168.1.8:8787/ws", token: "tok" });
ok(parseScanPayload(v1)?.wsUrl === "ws://192.168.1.8:8787/ws", "scan: v1 直连不回归");
// ccdeck-login
const login = JSON.stringify({ t: "ccdeck-login", dev: "wb-abcdef12", pk: "AAAA" + "k".repeat(44), name: "Chrome" });
ok(parseScanPayload(login)?.login?.dev === "wb-abcdef12", "scan: ccdeck-login 不回归");
// ccdeck-import
const imp = JSON.stringify({ t: "ccdeck-import", rt: { url: "ws://192.168.1.8:9000/rt", token: "t" } });
const impR = parseScanPayload(imp);
ok(!!impR?.import && "url" in impR.import && impR.import.url === "ws://192.168.1.8:9000/rt", "scan: ccdeck-import 不回归");
// 裸 ws 链接
ok(parseScanPayload("ws://10.0.0.2:8787/ws?token=abc")?.token === "abc", "scan: 裸 ws 不回归");
// 非连接码
eq(parseScanPayload("https://example.com/app2?token=x"), null, "scan: app2 网页链接仍拒（真因文档化）");

console.log(`\ntest-expo2-devices: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
if (fails.length) process.exit(1);
process.exit(0);
}

void main();
