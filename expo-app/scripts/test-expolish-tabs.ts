// W-EXPOLISH 打磨批直跑测试：件一（会话卡高度钳制）+ 件二（通知升 tab）+ 件三（三域内容化）。
//
// 断言面：
//   ① foldMeta 纯函数（徽标行收敛 +N，件一的行数钳制面）——边界/顺序/防御全查；
//   ② 五域表 + 通知 badge 计数口径（notifActionableOf 与通知页同源，badge=内容）；
//   ③ 模块面：OrgZone/OrgTabs/NotifCenterPage/SettingsPage 迁出件导出齐全，
//      ListScreen 的 org-commands re-export 面不变（NewSessionModal 依赖）；
//   ④ 源码字面锚：卡片等高几何（lineHeight 钉值 + ActivityBlock 退役）、铃铛/
//      占位域/抽屉退役、五域接线（App badges 双挂）。
//
// 运行（tsx 装在 relay/node_modules）：
//   relay 目录：   node --import tsx ../expo-app/scripts/test-expolish-tabs.ts
//   expo-app 目录：node --import tsx scripts/test-expolish-tabs.ts
// 桩层同 test-e2a-list.ts；末尾 process.exit（无长驻 interval 也统一收口）。

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

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};
const eq = (a: unknown, b: unknown, msg: string): void => {
  check(a === b, `${msg}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`);
};
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  // @ts-expect-error The direct test runner loads TypeScript through tsx.
  const list = await import("../src/screens/ListScreen.tsx");
  // @ts-expect-error 同上（桩层下直载）
  const org = await import("../src/screens/OrgZone.tsx");
  // @ts-expect-error 同上
  const orgTabs = await import("../src/screens/OrgTabs.tsx");
  // @ts-expect-error 同上
  const notifPage = await import("../src/screens/NotifCenterPage.tsx");
  // @ts-expect-error 同上
  const settingsPage = await import("../src/screens/SettingsPage.tsx");
  // @ts-expect-error 同上
  const tabs = await import("../src/bottom-tabs.tsx");
  // @ts-expect-error 同上
  const { notifActionableOf } = await import("../src/notify-jump.ts");

  // ---------- ① foldMeta（件一：徽标行收敛，行数钳制纯函数面） ----------
  const fold = list.foldMeta as (m: string[], max?: number) => { shown: string[]; hidden: number };
  const r1 = fold(["📁 a", "◈ b", "已保存", "历史"], 3);
  eq(r1.shown.length, 3, "foldMeta 超额只显前 3");
  eq(r1.hidden, 1, "foldMeta 隐没计数=+N");
  eq(r1.shown.join("|"), "📁 a|◈ b|已保存", "foldMeta 保序（先到先显）");
  const r2 = fold(["📁 a", "◈ b"], 3);
  eq(r2.shown.length, 2, "foldMeta 未超额全显");
  eq(r2.hidden, 0, "foldMeta 未超额 hidden=0");
  const r3 = fold([], 3);
  eq(r3.shown.length, 0, "foldMeta 空表安全");
  const r4 = fold(["a", "b", "c"], 3);
  eq(r4.hidden, 0, "foldMeta 恰等于 max 不折叠");
  const r5 = fold(["a", "b", "c", "d", "e"], 3);
  eq(r5.hidden, 2, "foldMeta 超两个折 +2");
  eq(fold(["a"], 0).hidden, 0, "foldMeta max≤0 防御不折叠");

  // ---------- ② 五域 + 通知 badge 计数口径（件二） ----------
  const TABS = tabs.TABS as { key: string; label: string }[];
  eq(TABS.length, 5, "五域表");
  eq(TABS[3].key, "notifications", "第四域=通知");
  const pool = [
    { key: "n1", actionable: true, title: "a" },
    { key: "n2", actionable: true, resolved_at: 123, title: "b" },
    { key: "n3", actionable: true, handled_at: 5, title: "c" },
    { key: "n4", actionable: false, title: "d" },
    { key: "n5", actionable: true, dismissed_at: 7, title: "e" },
    { key: "n6", actionable: true, title: "f" },
  ];
  // badge 与通知页 rows 同源同函数：未决 = actionable 且三戳全空（n1/n6）
  eq(notifActionableOf(pool).length, 2, "通知 badge 口径：actionable 且三戳全空");
  eq(notifActionableOf(null).length, 0, "旧 relay null 池 → badge 0（降级不崩）");

  // ---------- ③ 模块面（件二/件三迁出件导出齐全） ----------
  check(typeof org.OrgZone === "function", "OrgZone 导出（团队 tab 宿主）");
  check(typeof org.GroupModal === "function", "GroupModal 导出（组详情，三 tab 复用）");
  check(typeof org.useOrgData === "function", "useOrgData 导出（组织数据面）");
  check(typeof org.useOrgDecide === "function", "useOrgDecide 导出（决议 ACK 门）");
  check(typeof org.orgStColor === "function", "orgStColor 导出");
  check(org.ORG_ST_ZH && org.ORG_ST_ZH.pending === "待确认", "ORG_ST_ZH 词表随迁");
  check(typeof orgTabs.TeamTab === "function", "TeamTab 导出");
  check(typeof orgTabs.ProjectsTab === "function", "ProjectsTab 导出");
  check(typeof notifPage.default === "function", "NotifCenterPage 默认导出（通知 tab 宿主）");
  check(typeof settingsPage.default === "function", "SettingsPage 默认导出（设置 tab 宿主）");
  // ListScreen re-export 面（NewSessionModal/test-e-permission-summary 依赖）
  check(typeof (list as Record<string, unknown>).ackVerdict === "function", "ListScreen re-export ackVerdict");
  check(typeof (list as Record<string, unknown>).orgConfirmPayload === "function", "ListScreen re-export orgConfirmPayload");
  check(typeof (list as Record<string, unknown>).ackTapGuard === "function", "ListScreen re-export ackTapGuard");
  check(typeof (list as Record<string, unknown>).cmdCapRecoverOnSnapshot === "function", "ListScreen re-export cmdCapRecoverOnSnapshot");
  check(typeof (list as Record<string, unknown>).activityMetricsOf === "function", "activityMetricsOf 保留（test-e2a 断言面）");
  check(typeof (list as Record<string, unknown>).splitPending === "function", "splitPending 保留（会话 badge 口径红线）");

  // ---------- ④ 源码字面锚 ----------
  const listSrc = srcOf("../src/screens/ListScreen.tsx");
  // 件一：等高几何锚——行盒 lineHeight 钉值（同密度卡等高的保障）+ 活动块退役
  check(/srowTitle: \{[^}]*lineHeight: 19/.test(listSrc),
    "r1 标题行盒钉 19（font 度量浮动消除）");
  check(/srowMeta: \{[^}]*lineHeight: 14/.test(listSrc), "r3 元信息行盒钉 14");
  check(/srowTagT: \{[^}]*lineHeight: 14/.test(listSrc), "状态 tag 行盒钉 14");
  check(/titleC: \{[^}]*lineHeight: 19/.test(listSrc), "紧凑档标题行盒钉 19");
  check(/sumC: \{[^}]*lineHeight: 14/.test(listSrc), "紧凑档摘要行盒钉 14");
  check(!listSrc.includes("ActivityBlock s={s}"), "活动指标块不再上卡（0~4 行伸缩=卡高方差主源）");
  // 件一精确化（2026-10-11 用户澄清）：「状态/动作/审批」键值行整体删除——状态由
  // 徽标行胶囊+状态灯承载、动作=摘要行、审批归详情页；样式面 act* 一并清零
  check(!listSrc.includes("actBlock") && !listSrc.includes("actKey"), "键值行渲染与样式面已清零");
  check(listSrc.includes("<StatusTag s={s} />"), "状态→徽标行状态胶囊承载");
  check(listSrc.includes("<CtxMini s={s} />"), "进度→徽标行水位 mini 承载");
  check(listSrc.includes("foldMeta(["), "r3 元信息走 foldMeta 收敛");
  // 件一红线：摘要行 numberOfLines 钳制保持单行
  check(listSrc.includes("numberOfLines={1}>{s.action_summary"), "摘要行 numberOfLines=1 钳制保持");
  // 件二：铃铛/通知弹层退役 + splitPending 口径不动
  check(!listSrc.includes("NotifCenterModal"), "通知中心弹层已迁出");
  check(!listSrc.includes("bellBtn"), "铃铛入口已退役（通知升 tab 单入口）");
  check(listSrc.includes("未决计数改挂通知 tab badge"), "通知 badge 迁移注记在场");
  // 件三：组织区/抽屉/边缘手势退役 + logo 落点改 tab
  check(!listSrc.includes("SettingsDrawer"), "设置抽屉消费面已迁出");
  check(!listSrc.includes("OrgZone"), "组织区已迁出列表屏");
  check(!listSrc.includes("edgePan"), "左缘手势条已随抽屉退役");
  check(listSrc.includes("onOpenSettings"), "logo 落点改设置 tab 回调");

  const appSrc = srcOf("../App.tsx");
  check(appSrc.includes("notifications: notifPendingCount"), "通知 tab badge 接线（App 层）");
  check(appSrc.includes("sessions: pendingCount"), "会话 tab badge 口径不变（红线）");
  check(appSrc.includes("notifActionableOf(snap.sources.flatMap"), "badge 与通知页同源同函数");
  check(appSrc.includes("<NotifCenterPage"), "通知域宿主接线");
  check(appSrc.includes("<TeamTab") && appSrc.includes("<ProjectsTab"), "团队/项目域宿主接线");
  check(appSrc.includes("<SettingsPage"), "设置域宿主接线");
  check(!appSrc.includes("DomainPlaceholder"), "占位域已退役");

  const tabsSrc = srcOf("../src/bottom-tabs.tsx");
  check(!tabsSrc.includes("DomainPlaceholder"), "bottom-tabs 占位域框架已删");
  check(tabsSrc.includes("notifications"), "bottom-tabs 五域键在场");

  const pageSrc = srcOf("../src/screens/SettingsPage.tsx");
  check(pageSrc.includes("export default function SettingsPage"), "设置页导出名（抽屉形态退役）");
  check(!pageSrc.includes("PanResponder"), "抽屉侧滑手势已退役");
  check(pageSrc.includes("permissionSummariesOf(s.sourceCapabilities?.permission)"), "权限节随迁完好（test-e-permission 锚同款）");

  const notifSrc = srcOf("../src/screens/NotifCenterPage.tsx");
  check(notifSrc.includes("store.ackNotification"), "通知动作真链路（E3b）随迁");
  check(notifSrc.includes("splitResolvedRows"), "已处理折叠分区随迁");
  check(notifSrc.includes("jumpTargetOf"), "验收回跳判定随迁");
  check(notifSrc.includes("GroupModal"), "task 落点宿主组详情（迁 tab 后仍可达）");

  const orgTabsSrc = srcOf("../src/screens/OrgTabs.tsx");
  check(orgTabsSrc.includes("useOrgDecide"), "团队 tab 决议 ACK 门接线");
  check(orgTabsSrc.includes("电脑端"), "深交互指引（去电脑端）在场");

  // ---------- ⑤ 件四：活动舱迁输入区上沿（单行制，对齐桌面 #dockActivityRow） ----------
  const detailSrc = srcOf("../src/screens/DetailScreen.tsx");
  check(!detailSrc.includes("化头部活动舱"), "header 两行制活动舱已退役");
  check(detailSrc.includes("活动舱从 header 迁输入区上沿"), "迁移注记在场");
  check(detailSrc.indexOf("d.dockLine") > -1 && detailSrc.indexOf("d.dockLine") < detailSrc.indexOf("{bannerVisible ? ("),
    "dock 落位输入区上沿（审批横幅之上，源序锚）");
  check(/dockLine: \{[^}]*borderLeftWidth: 2/.test(detailSrc), "单行舱保留 005 左缘状态色语言");
  check(/dockLineAct: \{[^}]*flex: 1/.test(detailSrc), "动作文本 flex 收缩单行截断");
  check(detailSrc.includes("#dockActivityRow"), "桌面 composer 前状态坞单行参照锚");
  check(detailSrc.includes("WORKING\" || dock.state === \"WAITING\""), "终态不入舱口径保持（StatusStrip 收口）");
  check(!/d\.dock\b|d\.dockRow|d\.dockTask|d\.dockAct\b/.test(detailSrc), "旧两行制样式消费面清零");

  // ---------- ⑥ 件五：经验库入口迁设置分节（脱离组织区/团队页） ----------
  check(typeof org.ExpLibraryModal === "function", "ExpLibraryModal 导出（经验库只读弹层宿主）");
  const orgZoneSrc = srcOf("../src/screens/OrgZone.tsx");
  check(!/function OrgZone\(\{ confirms, groups, exps/.test(orgZoneSrc), "组织区不再内嵌经验分节（列表/团队页空间让位）");
  check(!/"exps",/.test(orgZoneSrc) && !/useOrgData[\s\S]*?exps/.test(orgZoneSrc.slice(orgZoneSrc.indexOf("useOrgData"), orgZoneSrc.indexOf("useOrgData") + 400)),
    "useOrgData 不再透出经验域（数据面随入口迁设置）");
  check((orgZoneSrc.match(/经验库总开关已关闭/g) ?? []).length === 1, "总开关说明唯一（随列表迁弹层）");
  check(orgZoneSrc.includes("不设 6 条截断"), "弹层全量列表（原内嵌 6 条截断退役）");
  check(orgTabsSrc.includes("经验域随入口迁设置 tab"), "团队页迁移注记在场");
  check(!/\bexps\b/.test(orgTabsSrc), "团队 tab 无经验域残留");
  const expPageSrc = srcOf("../src/screens/SettingsPage.tsx");
  check(expPageSrc.includes(">经验库"), "设置页经验库分节在场");
  check(expPageSrc.includes("手机只读 · 管理请用电脑端"), "分节电脑端说明锚");
  check(expPageSrc.includes("<ExpLibraryModal"), "弹层接线（入口行 → 只读列表）");
  check(expPageSrc.includes("experiences) continue"), "旧 relay null 源不进（整节隐藏降级范式）");

  console.log(`ok - ${tests} assertions passed（W-EXPOLISH：卡高钳制 + 通知升 tab + 三域内容化）`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
