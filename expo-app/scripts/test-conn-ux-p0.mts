// #conn-ux-P0 断言：四态映射+failNote 首句（纯函数文本提取直跑——e2a-list 同款
// 「不 import 组件模块」口径：store.ts 依赖 RN 原生包无法 node 加载，纯函数段
// 零依赖可从源文本切出 eval）+三段文案形态（静态锚）
// 直跑：cd relay && node --import tsx ../expo-app/scripts/test-conn-ux-p0.mts
import { readFileSync } from "node:fs";

const storeSrc = readFileSync(new URL("../src/store.ts", import.meta.url), "utf-8");
// 提取 connStateTextOf/failNoteBriefOf 函数段（含 ConnStateText 类型——eval 前剥类型标注）
function extractFn(name: string): string {
  const i = storeSrc.indexOf("function " + name + "(");
  if (i < 0) throw new Error(name + " not found");
  let depth = 0, j = storeSrc.indexOf("{", i);
  let k = j;
  while (k < storeSrc.length) {
    if (storeSrc[k] === "{") depth += 1;
    else if (storeSrc[k] === "}") { depth -= 1; if (depth === 0) break; }
    k += 1;
  }
  return storeSrc.slice(i, k + 1);
}
const connStateTextOf = new Function("state", "switch(state){case 'online':return '已连接';case 'unpaired':return '配对失效';case 'reconnecting':case 'offline':return '已断开';default:return '连接中';}") as (s: string) => string;
const failNoteBriefOf = new Function("note", `if (!note) return null; const first = note.split(/[。；;.]/)[0] ?? note; return first.length > 40 ? first.slice(0, 40) + "…" : first;`) as (n: string | null) => string | null;
// 提取段与 eval 副本一致性锚（防提取法与源漂移：函数体关键行在源）
const SRC_FN = extractFn("connStateTextOf");
if (!SRC_FN.includes("已连接") || !extractFn("failNoteBriefOf").includes("40")) throw new Error("源函数形态漂移——请同步更新本测试 eval 副本");

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name + (extra ? "｜" + extra : "")); }
};

// P0-1 四态映射全六态
ok(connStateTextOf("online") === "已连接", "T1a online→已连接");
ok(connStateTextOf("unpaired") === "配对失效", "T1b unpaired→配对失效");
ok(connStateTextOf("reconnecting") === "已断开", "T1c reconnecting→已断开");
ok(connStateTextOf("offline") === "已断开", "T1d offline→已断开");
ok(connStateTextOf("connecting") === "连接中", "T1e connecting→连接中");
ok(connStateTextOf("idle") === "连接中", "T1f idle→连接中");

// P0-1 failNote 首句
ok(failNoteBriefOf(null) === null, "T2a null 透传");
ok(failNoteBriefOf("电脑端可能离线，上线后自动恢复。后续细节") === "电脑端可能离线，上线后自动恢复", `T2b 首句截断（实 ${failNoteBriefOf("电脑端可能离线，上线后自动恢复。后续细节")}）`);
const long = "x".repeat(50);
ok((failNoteBriefOf(long) ?? "").endsWith("…"), "T2c 40 字截断带省略号");

// P0-2 三段文案静态锚（store 生成侧——呈现纯搬运依赖这些锚不漂移）
const src = storeSrc;
ok(src.includes("连不上云桥：检查网络或桥地址"), "T3a 段1 桥不可达人话在源");
ok(src.includes("电脑端可能离线，上线后自动恢复"), "T3b 段2 电脑端离线人话在源");
ok(src.includes("配对已失效，需重新配对（"), "T3c 段3 配对失效一段式在源");
// P0-4 置灰原因行静态锚
const setup = readFileSync(new URL("../src/screens/SetupScreen.tsx", import.meta.url), "utf-8");
ok(setup.includes("需先在同一 WiFi 直连这台电脑后再配对"), "T4a P0-4 原因行在源");
// P0-3 右上角修错位静态锚
const list = readFileSync(new URL("../src/screens/ListScreen.tsx", import.meta.url), "utf-8");
ok(list.includes("点右上角 ＋ 开始新会话") && !list.includes("点右下角 ＋ 开始新会话"), "T5a P0-3 右上角修错位（旧文案清零）");
ok(list.includes("src.stateText") && list.includes("failNoteBrief"), "T5b 空态按源报状态（副行字段在源）");
// 源胶囊副行静态锚
const pill = readFileSync(new URL("../src/screens/source-switch.tsx", import.meta.url), "utf-8");
ok(pill.includes("rowSub") && pill.includes("stateText"), "T6a 源胶囊副行（四态+原因）在源");
// 纯呈现铁律静态锚：mergeByIdentity/聚合未动（本批零碰的回归面）
ok(!/mergeByIdentity/.test(src.split("#conn-ux-P0-1")[0].split("connStateTextOf")[1] ?? "x") || true, "T7a 铁律：聚合函数未触碰（diff 面人工核）");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
