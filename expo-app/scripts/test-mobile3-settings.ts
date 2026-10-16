// W-MOBILE3 #122 设置二级页结构锚（防回退）：#121 PageHead 统一 + #122 一级目录/
// 二级详情条件骨架静态断言。行为验证走 tsc+装机（RN 模拟器装包链本批未执行，见回执）。
//
// 直跑（tsx 装在 relay/node_modules）：
//   cd expo-app && node --import tsx scripts/test-mobile3-settings.ts

// @ts-expect-error node:fs 未进 expo tsconfig types 字段
import { readFileSync } from "node:fs";
// @ts-expect-error 同上
import { fileURLToPath } from "node:url";
// @ts-expect-error 同上
import { dirname, join } from "node:path";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const here = dirname(fileURLToPath(import.meta.url));
const sp = readFileSync(join(here, "../src/screens/SettingsPage.tsx"), "utf-8");
const head = readFileSync(join(here, "../src/screens/page-head.tsx"), "utf-8");
const orgTabs = readFileSync(join(here, "../src/screens/OrgTabs.tsx"), "utf-8");
const list = readFileSync(join(here, "../src/screens/ListScreen.tsx"), "utf8");
const app = readFileSync(join(here, "../App.tsx"), "utf8");

console.log("== W-MOBILE3 #121/#122：PageHead 统一 + 设置二级页结构 ==");

// ---- A. PageHead 组件（v3 .appbar 规格） ----
ok(head.includes("export function PageHead"), "A1 PageHead 组件导出");
ok(head.includes("fontSize: 16, fontWeight: \"600\"") && head.includes("fontSize: 11, color: c.dim, marginTop: 2"), "A2 v3 appbar 两行式规格（标题 16/600 + 副题 11/dim 上距 2）");
ok(head.includes("paddingHorizontal: 14") && head.includes("paddingBottom: 10") && head.includes("borderBottomWidth: 1"), "A3 容器 14 水平/10 底+分隔线（v3 padding 40 14 10 顶由 SafeArea 承担）");
ok(head.includes("width: 44, height: 44") && head.includes("ChevronLeft"), "A4 返回钮 44 触区 chev（v3 .back）");

// ---- B. 四页接入 ----
ok(orgTabs.includes("<PageHead") && orgTabs.includes('from "./page-head"'), "B1 团队/项目页（OrgPageShell）接 PageHead");
ok(!orgTabs.includes("headT:") && !orgTabs.includes("headSub:"), "B2 OrgTabs 旧页头样式键零残留（headT/headSub 退役）");
ok(list.includes("paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10") && list.includes("backgroundColor: c.headBg"), "B3 会话页 topbar 容器规格对齐（14/10/10+headBg）");

// ---- C. #122 设置二级页骨架 ----
ok(sp.includes("const [subPage, setSubPage]"), "C1 subPage 二级页状态");
ok(sp.includes("const SET_NAV") && ["conn", "prefs", "engines", "about"].every((k) => sp.includes(`key: "${k}"`)), "C2 一级导航四分区（连接与设备/通用与偏好/Agent 引擎/关于）");
ok(sp.includes("SET_NAV.map((n, i) =>"), "C3 一级目录渲染导航卡");
ok(sp.includes('{subPage === null ? (<>'), "C4 一级（活动连接卡+导航卡）条件块");
for (const k of ["conn", "prefs", "engines", "about"]) {
  ok(sp.includes(`{subPage === "${k}" ? (<>`), `C5 二级条件块 ${k}（原分区 JSX 原地包装——零搬移）`);
}
ok(sp.includes('sub={`设置 · ${SET_NAV.find((n) => n.key === subPage)!.sub}`}') && sp.includes("onBack={() => setSubPage(null)}"), "C6 二级 PageHead=返回+分区标题+「设置 · X」副题（v3 appbar 二级形态）");
ok((sp.match(/<PageHead/g) || []).length === 2, "C7 设置页 PageHead 两态（一级/二级）");

// ---- D. 功能面保留（平移不丢件） ----
for (const anchor of ["W-MSET3 ② 活动连接状态卡", "连接管理组（W-MSETSIG", "偏好组（W-MSET3 ③ 合并", "Agent 引擎组（任务书分组③", "关于组（任务书分组⑤"]) {
  ok(sp.includes(anchor), `D 保留 ${anchor.slice(0, 12)}…`);
}
ok(sp.includes("<AboutModal") && sp.includes("<DevicesModal"), "D6 弹层族原样（About/Devices/图例/导入）");

// ---- E. W-BACKFIX 返回键链路（1016 test.31 用户实锤修复） ----
{
  // E1 句柄导出+同源：requestBack 与 PageHead onBack 同一 setSubPage(null)（同一状态源）
  ok(sp.includes("export type SettingsBackHandle = { requestBack: () => boolean }"), "E1 SettingsBackHandle 句柄类型导出");
  const hIdx = sp.indexOf("useImperativeHandle(ref");
  const handleSeg = hIdx >= 0 ? sp.slice(hIdx, hIdx + 600) : "";
  ok(handleSeg.includes("if (subPage !== null)") && handleSeg.includes("setSubPage(null)") && handleSeg.includes("return true"), "E2 requestBack：二级页开→清 subPage 消费（与 onBack 同一 setSubPage）");
  ok(handleSeg.includes("return false"), "E3 目录页 false 不拦截（落 tab 层/系统默认）");
  // E4 App 单点分发：消费层在 tab 层之前（顺序错=二级页被拽回会话域，实锤病灶）
  const appRef = app.indexOf("settingsBackRef.current?.requestBack()");
  const appTab = app.indexOf('if (tab !== "sessions")');
  ok(appRef > 0 && appTab > appRef, "E4 App 单点分发：settingsBackRef 消费层在 tab 层之前");
  // E5 全 App 唯一 BackHandler 订阅不变（#282 架构未被破坏——SettingsPage 不自建订阅）
  ok((app.match(/BackHandler\.addEventListener/g) || []).length === 1, "E5 App 单点 BackHandler 订阅唯一（#282）");
  const rnImport = sp.slice(Math.max(0, sp.indexOf('"react-native"') - 200), sp.indexOf('"react-native"'));
  ok(!sp.includes("BackHandler.addEventListener") && !rnImport.includes("BackHandler"), "E6 SettingsPage 零自建订阅（经 ref 句柄承接，不 import/不订阅 BackHandler）");
}

console.log(`\nmobile3-settings: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
