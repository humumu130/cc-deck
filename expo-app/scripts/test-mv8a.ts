// W-MV8A（手机端 v8 还原·A 轨）直跑测试：v8.5 v3 手机壳段（docs/mockups/
// v8-ui-interactive-v3.html ph-* 屏）实装五项的纯函数 + 源码字面锚。
//
// 断言面：
//   A. 纯函数（TeamDetailPage 导出）：laneColorOf 五色双档 / LANE_RENDER_ORDER
//      渲染序（待收单置顶）/ laneSharesOf 总览比例（min 4% + 空板空数组）/
//      memberStatusOf 五色状态词映射 / EngineBadge 导出；
//   B. 纯函数（NotifCenterPage 导出）：splitNotifGroups 三分组投影（不丢行保池序）；
//   C. 源码字面锚：团队卡 hcard team 语言 + 成员迷你行 + 红计数徽 + live 板计数、
//      团队详情七节视觉重排（副题行/总览条/泳道折叠/go 置顶/徽章行/五色词）、
//      通知中心二级页形态（全屏 + 三分组）、ListScreen 顶栏铃铛 + r3 引擎徽章 +
//      「通知 · N」胶囊退役；
//   D. 回归锚：BOARD_LANES 词表序不动（数据面契约）、App 底栏 badge 口径不变
//      （sessions=待处理数 / team=确认卡数红线）。
//
// 运行：expo-app 目录 node --import tsx scripts/test-mv8a.ts
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
  const teamDetail = await import("../src/screens/TeamDetailPage.tsx");
  // @ts-expect-error 同上
  const notifPage = await import("../src/screens/NotifCenterPage.tsx");

  console.log("A. 泳道五色 + 渲染序 + 总览比例（TeamDetailPage 纯函数）");
  eq(teamDetail.laneColorOf("backlog", "dark"), "#55677F", "backlog 深色档 = v3 --p-b");
  eq(teamDetail.laneColorOf("claimed", "dark"), "#2FBF71", "claimed 深色档 = v3 --p-r");
  eq(teamDetail.laneColorOf("submitted", "dark"), "#E08A63", "submitted 深色档 = v3 --p-v");
  eq(teamDetail.laneColorOf("ready_to_install", "dark"), "#FFC53D", "待收单深色档 = v3 --p-ok");
  eq(teamDetail.laneColorOf("done", "dark"), "#2C3B52", "done 深色档 = v3 --p-d");
  eq(teamDetail.laneColorOf("backlog", "light"), "#C3CEDD", "backlog 浅色档 = v3 light --p-b");
  eq(teamDetail.laneColorOf("ready_to_install", "light"), "#E0A43C", "待收单浅色档 = v3 light --p-ok");
  eq(teamDetail.laneColorOf("unknown-lane", "dark"), "#55677F", "词表外 lane 回落中性色（不崩不造）");
  eq(teamDetail.LANE_RENDER_ORDER[0], "ready_to_install", "渲染序首位 = 待收单（行动队列置顶，v3 拍板）");
  eq(teamDetail.LANE_RENDER_ORDER.join(","), "ready_to_install,claimed,submitted,backlog,done",
    "渲染序五态齐 = v3 ph-pteamd plane 序");
  const shares = teamDetail.laneSharesOf({ claimed: 4, backlog: 2, ready_to_install: 0 });
  eq(shares.length, 2, "零计数 lane 不出段（待收单 0 不占总览）");
  const claimedShare = shares.find((s: { st: string }) => s.st === "claimed");
  const backlogShare = shares.find((s: { st: string }) => s.st === "backlog");
  eq(claimedShare?.pct, 67, "claimed 4/6 比例 67%");
  eq(backlogShare?.pct, 33, "backlog 2/6 比例 33%");
  eq(teamDetail.laneSharesOf({}).length, 0, "空板空数组（总览条整块不渲染）");
  const minShare = teamDetail.laneSharesOf({ claimed: 99, submitted: 1 }).find((s: { st: string }) => s.st === "submitted");
  eq(minShare?.pct, 4, "细段 min 4% 保底（可见可点）");

  console.log("B. 成员五色状态词（memberStatusOf）");
  eq(teamDetail.memberStatusOf("WORKING").zh, "工作中", "WORKING→工作中");
  eq(teamDetail.memberStatusOf("WORKING").tone, "y", "工作中=黄（1019 拍板：与列表卡状态灯同源，旧 v3 绿案退役）");
  eq(teamDetail.memberStatusOf("WAITING").zh, "阻塞", "WAITING→阻塞（等你输入=链路停摆）");
  eq(teamDetail.memberStatusOf("WAITING").tone, "y", "阻塞=琥珀");
  eq(teamDetail.memberStatusOf("ERROR").zh, "出错", "ERROR→出错");
  eq(teamDetail.memberStatusOf("ERROR").tone, "r", "出错=红");
  eq(teamDetail.memberStatusOf("DONE").zh, "空闲", "DONE→空闲");
  eq(teamDetail.memberStatusOf("DONE").tone, "g", "空闲=绿（1019 拍板：旧灰案退役）");
  eq(teamDetail.memberStatusOf(undefined).zh, "关闭", "不在册→关闭");
  eq(teamDetail.memberStatusOf("WHATEVER").zh, "关闭", "词表外→关闭（不造词）");
  eq(typeof teamDetail.EngineBadge, "function", "EngineBadge 导出（跨屏单源徽章）");

  console.log("C. 通知三分组投影（splitNotifGroups）");
  const mk = (key: string, actionable: boolean) => ({ item: { key, actionable } as never });
  const g1 = notifPage.splitNotifGroups([mk("a", true), mk("b", false), mk("c", true)], new Set(["a", "c"]));
  eq(g1.action.length, 2, "actionable 两行入「需你行动」");
  eq(g1.feed.length, 1, "非 actionable 入「动态」");
  eq(g1.action.map((r: { item: { key: string } }) => r.item.key).join(","), "a,c", "组内保池序不重排");
  const g2 = notifPage.splitNotifGroups([mk("x", true)], new Set<string>());
  eq(g2.action.length + g2.feed.length, 1, "actionableKeys 为判定源（item.actionable 字段不直接参与）——不丢行");

  const tdSrc = srcOf("../src/screens/TeamDetailPage.tsx");
  const orgSrc = srcOf("../src/screens/OrgTabs.tsx");
  const notifSrc = srcOf("../src/screens/NotifCenterPage.tsx");
  const detailSrc = srcOf("../src/screens/DetailScreen.tsx");
  const partsSrc = srcOf("../src/components/detail-parts.tsx"); // W-SPLIT-S1D 锚跟改：AskBanner 滑切面外迁 // W-SWIPEASK：AskBanner 滑切锚目标
  const listSrc = srcOf("../src/screens/ListScreen.tsx");
  const appSrc = srcOf("../App.tsx");

  console.log("D. 团队 tab（OrgTabs：hcard team 语言 + 成员迷你行 + 红计数徽）");
  check(orgSrc.includes("teamMiniRow"), "成员迷你行样式在场（任务书点名）");
  check(orgSrc.includes("teamMiniDot"), "迷你行状态灯");
  check(orgSrc.includes("EngineBadge engine={m.engine || ses?.engine}"), "迷你行引擎徽（词表外不渲染）");
  check(orgSrc.includes("cfCount"), "确认队列红计数徽（v3 pcfq cfcount 语言）");
  check(orgSrc.includes("待你确认"), "队列节头词面");
  check(orgSrc.includes("teamDot"), "团队卡健康灯（v3 .dot 右缘锚）");
  check(orgSrc.includes("teamPendBadge"), "团队卡琥珀待确认徽（v3 .pbadge）");
  check(orgSrc.includes("src.boards?.[g.id]?.entries"), "进行中计数取 live 板缓存（BOARD_UPDATED 维护面）");
  check(orgSrc.includes("fmtLastActive"), "最近活跃时间（成员会话 max updated_at）");
  check(orgSrc.includes("进行中"), "计数行「进行中 N」词面");

  console.log("E. 团队详情（TeamDetailPage：七节 v3 视觉重排）");
  check(tdSrc.includes("LANE_RENDER_ORDER.map"), "看板按渲染序渲染（待收单置顶）");
  check(tdSrc.includes("ovProg"), "五色总览条（v3 .prog 分段比例）");
  check(tdSrc.includes("ovChip"), "总览图例 chip（v3 .ovleg）");
  check(tdSrc.includes("scrollTo({ y: Math.max(0, boardYRef.current + y - 8)"), "点图例跳泳道锚（两级 onLayout 串联换算）");
  check(tdSrc.includes("lanePin"), "待收 lane 置顶 tag（v3 .pin-top）");
  check(tdSrc.includes("laneGo"), "待收 lane go 态高亮（v3 .plane.go）");
  check(tdSrc.includes("lanesOpen"), "泳道折叠组（v3 .planeh ▾）");
  check(tdSrc.includes("isActionLane || lanesOpen.has(st)"), "待收单恒显不折（行动队列语义）");
  check(tdSrc.includes("headLiveDot"), "头部副题 live 点（v3 appbar .s .live）");
  check(tdSrc.includes("编制 {members.length}"), "副题编制数（v3「● 运行中 · 编制 6」语言）");
  check(tdSrc.includes("tCardChip"), "看板卡执行者 chip（v3 pchip）");
  check(tdSrc.includes("tCardTime"), "看板卡右缘更新时间（v3 pcline）");
  check(tdSrc.includes("memPill"), "成员五色状态词胶囊（v3 .ppill 灯形统一）");
  check(tdSrc.includes("memberStatusOf(info.status)"), "成员词映射接线");
  check(tdSrc.includes("待你确认 · {groupConfirms.length}"), "节① 确认队列置顶保持（v3 修订②拍板）");

  console.log("F. 通知中心（W-NOTIFY2 抽屉形态 + 三分组）");
  // 形态断言随用户 1018 拍板跟改：全屏覆盖退役 → bottom-sheet 抽屉（transparent Modal
  // +压暗+上拉+grabber+滑删+清除全部；数据链/三分组/ACK 门硬条款全保持）
  check(notifSrc.includes('<Modal visible={open} transparent animationType="none" onRequestClose={closeSheet} statusBarTranslucent>'), "抽屉宿主=transparent Modal（硬件返回走 closeSheet 下滑动画）");
  check(notifSrc.includes("styles.grabber"), "grabber 把手（抽屉顶居中）");
  check(notifSrc.includes("height: sheetH"), "72% 屏高抽屉（2/3~3/4 拿捏）");
  check(notifSrc.includes("borderTopLeftRadius: 16"), "圆角顶");
  check(notifSrc.includes("清除全部"), "清除全部按钮（批量 dismissed 权威账）");
  check(notifSrc.includes("SWIPE_DELETE_PX = 72"), "行滑删阈值 72px（跟手+回弹）");
  check(notifSrc.includes("g.dy >= 60 || g.vy >= 1.2"), "抽屉头下拉关闭（60px/速度判定）");
  check(notifSrc.includes("需你行动"), "「需你行动」组（v3 ndot r）");
  check(notifSrc.includes("groupHead(\"动态\""), "「动态」组（v3 ndot n）");
  check(notifSrc.includes("已处理"), "「已处理」折叠区保持（M13-6E 规格①）");
  check(notifSrc.includes("splitNotifGroups(main, pendingKeys)"), "三分组投影接线");
  check(notifSrc.includes("NotifIcon"), "行首 severity 图标（v3 nrow .ic）");
  check(notifSrc.includes("notiRowAlert"), "行动行 alert 态（红边红底）");
  check(notifSrc.includes("定位来源 ↗"), "回跳钮 v3 act 语言");
  check(notifSrc.includes("act(item.key, \"dismissed\")"), "× 忽略/滑删走 dismissed 权威账（不清零硬条款）");
  check(notifSrc.includes("act(item.key, \"handled\")"), "知道了走 handled 权威账");
  // W-SWIPEASK（#157 后半）：多问题左右滑切换四锚
  check(partsSrc.includes("swipeAskPan"), "滑切手势 PanResponder（AskBanner 内）");
  check(partsSrc.includes("Math.abs(g.dx) < 24 || Math.abs(g.dx) <= Math.abs(g.dy) * 2"), "横占优 24px 锁定（纵滑零冲突）");
  check(partsSrc.includes("prog >= askW() / 2 || (dir === 1 ? g.vx : -g.vx) <= -0.55"), "松手过半/速度 0.55 spring 落位判定");
  check(partsSrc.includes("toFade") && partsSrc.includes("stepped ? swipeAskPan.panHandlers"), "圆点跟手淡入淡出 + 仅多问题挂手势（单问题不启）");

  console.log("G. 会话页（ListScreen：顶栏铃铛 + r3 引擎徽章）");
  check(listSrc.includes("function BellGlyph"), "铃铛 glyph（v3 #i-bell 同形线稿）");
  check(listSrc.includes("styles.bellBtn"), "顶栏铃铛钮");
  check(listSrc.includes("bellBadge"), "bbadge 红底白字计数（display 切换常挂）");
  check(listSrc.includes("bellBadgeOff: { display: \"none\" }"), "badge 隐藏态不插拔（P0 加固口径）");
  check(!listSrc.includes("通知{notifPending.length > 0 ?"), "统计行「通知 · N」胶囊退役（入口唯一化）");
  check(listSrc.includes('<EngineBadge engine={effEngine ?? undefined} size="sm" />'), "r3 徽章行引擎徽（任务书「引擎源徽章行」；W-MOBLIST 跟改：engine 兜底走 effEngine 推断链）");
  check(listSrc.includes("srowR3"), "r3 三行制结构保持（定版通栏行不回退）");
  check(!/borderRadius: 13, borderWidth: 1, backgroundColor: c\.panel, borderColor: c\.line,\s*paddingHorizontal: 14/.test(listSrc), "通栏行形态未回退描边卡（1015 定版锚）");

  console.log("H. 回归锚（不动的红线）");
  const orgZoneSrc = srcOf("../src/screens/OrgZone.tsx");
  check(orgZoneSrc.includes('["backlog", "待认领"]'), "BOARD_LANES 词表序不动（数据面契约）");
  check(appSrc.includes("badges={{ sessions: pendingCount, team: teamBadge }}"), "底栏 badge 口径不变（W-EXPOLISH 红线）");
  check(tdSrc.includes("BOARD_LANES.find(([k]) => k === st)?.[1]"), "词表→label 映射仍走 BOARD_LANES（渲染序只换遍历序，词面不复制）");

  console.log(`OK ${tests} assertions（W-MV8A：v8.5 v3 手机壳实装五项 + 回归锚）`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
