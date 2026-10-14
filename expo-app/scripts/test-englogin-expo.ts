// #102 批 B（expo 手机域）直跑测试：AUTH_REQUIRED 消费链 + 登录卡。
// 断言面：
//   ① 纯函数：normalizeAuthFlow（合法形状透出/畸形帧 null 防御/mode 词表兜底）、
//      engineSelectable needs_auth 拦截（auth_hint 透传）；
//   ② 源码字面锚：store AUTH_REQUIRED case（覆盖式+ready 本地 catalog patch+SNAPSHOT 清）、
//      EngineLoginModal（QR 矩阵 react-native-svg 渲染/verify/cancel/终态重开/browser 文案/
//      「扫不了自己的屏」引导）、NewSessionModal（needs_auth 行可点登录/创建拦截自动拉卡/
//      ACK 未登录兜底）、App 挂载；
//   ③ qr.ts vendor 与 web-console/qr.js 同源（QRCode 类可跑真码）。
// 运行：expo-app 目录 ../relay/node_modules/.bin/tsx scripts/test-englogin-expo.ts

// @ts-expect-error node:module 未进 expo tsconfig types 字段
import { registerHooks } from "node:module";
// @ts-expect-error node:fs 同上
import { readFileSync } from "node:fs";
// @ts-expect-error node:path 同上
import { dirname, join } from "node:path";
// @ts-expect-error node:url 同上
import { fileURLToPath } from "node:url";

type ResolveResult = { url: string; shortCircuit?: boolean };
type LoadResult = { format: string; source?: string; shortCircuit?: boolean };
interface ModuleHooks {
  resolve?(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => ResolveResult): ResolveResult;
  load?(url: string, context: unknown, nextLoad: (u: string, c: unknown) => LoadResult): LoadResult;
}
const RN_STUB = "const noop = () => {}; module.exports = new Proxy({}, { get: (t, k) => (k === '__esModule') ? true : noop });";
const hooks: ModuleHooks = {
  resolve(specifier, context, nextResolve) {
    if (specifier === "react" || specifier === "react-native" || specifier === "react-native-svg"
      || specifier.startsWith("@react-native-async-storage") || specifier.startsWith("expo-")) {
      return { url: `data:text/javascript,rn-stub-${specifier.replace(/[^a-z]/gi, "")}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("data:text/javascript,rn-stub-")) return { format: "module", source: `export default new Proxy({}, { get: () => () => null }); export const useTheme = () => ({ c: {} }); export const useThemeStyles = () => ({}); export const Modal = () => null; export const Pressable = () => null; export const View = () => null; export const Text = () => null; export const Linking = { openURL: async () => true }; export const Svg = () => null; export const Rect = () => null; export const default as Async = {};`, shortCircuit: true };
    return nextLoad(url, context);
  },
};
registerHooks(hooks);

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function section(s: string) { console.log(s); }

async function main() {
  const { normalizeAuthFlow, engineSelectable, ENGINE_STATE_LABEL } = await import("../src/protocol");
  const { QRCode, QRErrorCorrectLevel } = await import("../src/qr");

  // ---------- A. normalizeAuthFlow 纯函数 ----------
  section("A. normalizeAuthFlow（畸形帧防御）");
  const good = normalizeAuthFlow({ flow_id: "f1", engine: "codebuddy", state: "pending", mode: "qr", url: "https://copilot.tencent.com/login?x=1", hint: "扫码登录", ts: 1 });
  ok(good?.url === "https://copilot.tencent.com/login?x=1" && good?.mode === "qr" && good?.state === "pending", "A1 合法形状全字段透出");
  ok(normalizeAuthFlow(null) === null && normalizeAuthFlow("x") === null, "A2 非对象 → null");
  ok(normalizeAuthFlow({ engine: "codex", state: "pending" }) === null, "A3 缺 flow_id → null（relay 侧必发，防御而已）");
  ok(normalizeAuthFlow({ flow_id: "f", engine: "trae", state: "weird", mode: "qr", hint: "" }) === null, "A4 state 词表外 → null");
  ok(normalizeAuthFlow({ flow_id: "f", engine: "trae", state: "ready", mode: "banana", hint: "x" })?.mode === "hint", "A5 mode 词表外兜底 hint");
  ok(normalizeAuthFlow({ flow_id: "f", engine: "codex", state: "pending", mode: "browser", url: "https://auth.openai.com/x", hint: "h" })?.url === "https://auth.openai.com/x", "A6 browser 模式带 URL 透出（手动打开授权页 fallback）");

  // ---------- B. engineSelectable needs_auth ----------
  section("B. engineSelectable needs_auth 拦截");
  const block = engineSelectable({ id: "codebuddy", state: "needs_auth", auth_hint: "终端运行 codebuddy-code" });
  ok(block === "终端运行 codebuddy-code", "B1 needs_auth → auth_hint 拦截文案（行内提示+可点登录）");
  ok(engineSelectable({ id: "codebuddy", state: "needs_auth" }) === ENGINE_STATE_LABEL.needs_auth, "B2 无 hint → 词表兜底「未登录 · 点此扫码登录」");
  ok(engineSelectable({ id: "codex", state: "ready" }) === null, "B3 ready 不拦（零回归）");

  // ---------- C. store AUTH_REQUIRED case ----------
  section("C. store 消费链锚");
  const store = read("../src/store.ts");
  ok(store.includes('case "AUTH_REQUIRED"') && store.includes("normalizeAuthFlow(msg.payload)"), "C1 AUTH_REQUIRED case → normalizeAuthFlow（畸形帧不覆盖）");
  ok(store.includes("conn.authFlow = flow") && store.includes('hit.state = "ready"'), "C2 覆盖式存 flow + ready 本地 catalog patch（黄点转绿不等重连）");
  ok(store.includes("conn.authFlow = null;"), "C3 重连快照清卡（瞬态帧不补发——authFlow 语义收口）");
  ok(store.includes("authFlow: c.authFlow"), "C4 单源投影透出（聚合取任一活流程）");
  ok(store.includes('this.send("COMMAND_ENGINE_LOGIN"'), "C5 engineLogin 命令面（start/status/verify/cancel 四动作经 send 活动源路由）");

  // ---------- D. EngineLoginModal ----------
  section("D. EngineLoginModal 锚");
  const modal = read("../src/screens/EngineLoginModal.tsx");
  ok(modal.includes("getModuleCount") && modal.includes("isDark") && modal.includes("react-native-svg"), "D1 QR 矩阵 → react-native-svg Rect 网格（qr.ts vendor）");
  ok(modal.includes('"verify"') && modal.includes('"cancel"'), "D2 我已完成登录/取消双钮");
  ok(modal.includes("重新发起"), "D3 终态重开（timeout/error/cancelled）");
  ok(modal.includes("回到这台电脑") || modal.includes("Mac"), "D4 browser 模式文案（codex 本机浏览器回调——手机端提示回电脑）");
  ok(modal.includes("扫不了自己的屏") || modal.includes("扫一扫"), "D5 手机扫自己屏引导（截图识别/跳浏览器）");
  const appTsx = read("../App.tsx");
  ok(appTsx.includes("<EngineLoginModal />"), "D6 App 根挂载（watchPair 同层全局弹窗）");

  // ---------- E. NewSessionModal 接线 ----------
  section("E. NewSessionModal 接线锚");
  const nsm = read("../src/screens/NewSessionModal.tsx");
  ok(nsm.includes('loginRow') && nsm.includes("store.engineLogin(e.id, \"start\""), "E1 引擎选择器 needs_auth 行可点 → 拉起登录卡");
  ok(nsm.includes("未登录——已拉起登录引导"), "E2 创建提交拦截升级（needs_auth 自动拉卡——把饭喂到嘴里）");
  ok(nsm.includes("登录引导已弹出") && nsm.includes("v.error.includes(\"未登录\")"), "E3 ACK fail-fast needs_auth → 行内指引+幂等再拉卡");
  ok(nsm.includes("点此拉起登录二维码"), "E4 行内登录引导文案");

  // ---------- F. qr.ts vendor 真码 ----------
  section("F. qr.ts vendor（与 web-console/qr.js 同源）");
  const q = new (QRCode as unknown as new (n: number, l: number) => { addData(v: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean })(0, QRErrorCorrectLevel.M);
  q.addData("https://copilot.tencent.com/login?platform=CLI&state=abc");
  q.make();
  const n = q.getModuleCount();
  ok(n >= 29 && q.isDark(0, 0) === true, `F1 授权 URL 真码可生成（${n}×${n} 模块，定位图案角点亮）`);
  const webQr = read("../../web-console/qr.js");
  ok(webQr.includes("Kazuhiko Arase") && read("../src/qr.ts").includes("Kazuhiko Arase"), "F2 双端同源 vendor（MIT 头注释同在）");

  console.log(`\nOK ${pass} assertions${fail ? `（FAIL ${fail}）` : ""}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
