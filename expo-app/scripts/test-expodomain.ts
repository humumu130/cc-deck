// W-EXPODOMAIN v2（design-expo-mobile-v2）直跑测试：件一团队详情页七节 + 件二建团
// 分步向导 + 件三项目域对齐 + 件四 OrgZone/GroupModal 退役 + 顺带查漏组。
//
// 断言面：
//   ① 纯函数：normDir / tierZh / BOARD_LANES 词表 / taskOwnerResolve（owner 直绑 +
//      前缀唯一命中 + 歧义不绑）/ memberInfoOf（nick 优先、provider 只从席位取）；
//   ② 铁律域防御尺：isRuleEntry（畸形条目不进缓存）；
//   ③ 源码字面锚：TeamDetailPage 七节与 claimed 分区/backlog 未指派/展开浮层时间线、
//      store rules 域五挂点（conn/快照/帧/透出/缺省）、建团向导载荷口径（旧词）与
//      8 席闸、项目卡动作与未立项折叠组、NotifCenter 回跳落点、A3-5/A3-7/A4-4/A4-6
//      查漏组、App badges team 挂载。
//
// 运行：expo-app 目录 node --import tsx scripts/test-expodomain.ts
// 桩层同 test-expolish-tabs.ts（直拷，零共享文件——套件自包含可单跑）。

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
  const org = await import("../src/screens/OrgZone.tsx");
  // @ts-expect-error 同上
  const teamDetail = await import("../src/screens/TeamDetailPage.tsx");
  // @ts-expect-error 同上
  const orgDelta = await import("../src/org-delta.ts");
  // @ts-expect-error 同上
  const protocol = await import("../src/protocol.ts");

  console.log("A. 纯函数（normDir / tierZh / 词表 / owner 解析 / 成员卡信息模型）");
  eq(org.normDir("/a/b/"), "/a/b", "normDir 尾斜杠剥除");
  eq(org.normDir("\\a\\b\\"), "/a/b", "normDir 反斜杠归正斜杠（Windows 数据）");
  eq(org.normDir(""), "", "normDir 空串防御");
  eq(org.normDir(undefined), "", "normDir undefined 防御");
  eq(org.tierZh("正经立项"), "正式项目", "tierZh 口语化：正经立项→正式项目（件十）");
  eq(org.tierZh("轻立项"), "轻量项目", "tierZh 口语化：轻立项→轻量项目");
  eq(org.tierZh("其他"), "其他", "tierZh 词表外原样透传（不吞不造）");
  eq(org.tierZh(undefined), "", "tierZh 空值防御");
  eq(org.BOARD_LANES.length, 5, "看板五态");
  eq(org.BOARD_LANES.map((l: [string, string]) => l[1]).join(","), "待认领,进行中,待审查,待收单,完成",
    "五态词表逐字对齐桌面 lanes（v1 草案「待复核/待装机」作废）");
  eq(org.ORG_CF_KIND_ZH["rule-append"], "铁律", "确认卡 kind 词表含 rule-append（W-RULES1）");

  // taskOwnerResolve：owner_session 直绑 / 前缀唯一命中绑 / 歧义零命中不绑
  const members = [
    { session_id: "s1", role: "worker", nick: "阿甲" },
    { session_id: "s2", role: "worker", nick: "" },
    { session_id: "s3", role: "reviewer" },
  ];
  const sessions = [
    { session_id: "s1", title: "会话一", status: "WORKING" },
    { session_id: "s2", title: "会话二", status: "DONE" },
    { session_id: "s3", title: "会话三", status: "WAITING" },
  ] as never[];
  const e0 = { id: "e0", text: "直绑卡", status: "claimed" as const, created_at: 1, updated_at: 1, owner_session: "s3" };
  const r0 = teamDetail.taskOwnerResolve(e0, members, sessions);
  check(r0.resolved && r0.member?.session_id === "s3", "owner_session 直绑命中编制");
  const e1 = { id: "e1", text: "[worker] 前缀卡", status: "backlog" as const, created_at: 1, updated_at: 1 };
  const r1 = teamDetail.taskOwnerResolve(e1, members, sessions);
  check(!r1.resolved, "前缀多命中（两个 worker）不绑——歧义保持未指派（⑦a 口径）");
  const e2 = { id: "e2", text: "[阿甲] 别名前缀卡", status: "backlog" as const, created_at: 1, updated_at: 1 };
  const r2 = teamDetail.taskOwnerResolve(e2, members, sessions);
  check(r2.resolved && r2.member?.session_id === "s1" && r2.text === "别名前缀卡", "别名前缀唯一命中绑+剥前缀（件十⑤）");
  const e3 = { id: "e3", text: "[reviewer] 角色前缀卡", status: "backlog" as const, created_at: 1, updated_at: 1 };
  const r3 = teamDetail.taskOwnerResolve(e3, members, sessions);
  check(r3.resolved && r3.member?.session_id === "s3", "角色前缀唯一命中绑");
  const r4 = teamDetail.taskOwnerResolve({ ...e0, owner_session: "sX" }, members, sessions);
  check(!r4.resolved, "owner 指向离编会话=不绑（离编口径）");

  // memberInfoOf：nick 优先 / 会话名兜底 / provider 只从席位取（expo SessionState 无此键）
  const mi1 = teamDetail.memberInfoOf(members[0], sessions[0]);
  eq(mi1.name, "阿甲", "成员卡显示名 nick 优先（件十⑤）");
  eq(mi1.role, "worker", "席位角色");
  check(!("provider" in mi1) || mi1.provider === undefined || typeof mi1.provider === "string", "provider 字段类型稳定");
  const mi2 = teamDetail.memberInfoOf({ session_id: "s2", role: "" }, sessions[1]);
  eq(mi2.name, "会话二", "无 nick 回落会话名");
  eq(mi2.role, "角色未标注", "角色缺省词（桌面同款）");
  const mi3 = teamDetail.memberInfoOf({ session_id: "sX", role: "worker" }, undefined);
  eq(mi3.name, "sX", "查无会话回落 session_id（不崩不造名）");
  eq(mi3.status, undefined, "查无会话=无状态灯数据（缺省灰口径）");

  console.log("B. 铁律域防御尺（isRuleEntry——畸形条目不进缓存）");
  check(orgDelta.isRuleEntry({ id: "r1", text: "x", audience: "all", scope: "team", status: "active", created_at: 1, updated_at: 1 }), "合法条目过尺");
  check(!orgDelta.isRuleEntry(null) && !orgDelta.isRuleEntry({}), "空对象拒收");
  check(!orgDelta.isRuleEntry({ id: "r1", audience: "all", status: "active" }), "缺 text 拒收");
  check(!orgDelta.isRuleEntry({ id: "r1", text: "x", status: "active" }), "缺 audience 拒收");
  check(orgDelta.isRuleEntry({ id: "r1", text: "x", audience: "role:worker", scope: "project:/a/b", status: "superseded", superseded_by: "r2", created_at: 1, updated_at: 1 }),
    "superseded 终态条目透传（append-only 审计面）");
  // mergeById 与铁律条目联用（RULES_UPDATED delta 路径的 merge 核心）
  const merged = orgDelta.mergeById(
    [{ id: "r1", text: "旧", audience: "all", scope: "team", status: "active", created_by: "user", created_at: 1, updated_at: 1 }],
    { upserts: [{ id: "r2", text: "新", audience: "all", scope: "team", status: "active", created_by: "user", created_at: 2, updated_at: 2 }], removes: ["r1"] },
    orgDelta.isRuleEntry,
  );
  eq(merged.length, 1, "rules delta merge：removes 挖除+新条目追加");
  eq(merged[0].id, "r2", "rules delta merge：upsert 落位");

  console.log("C. 协议类型面（五态 + RuleEntry + headcount.nick）");
  const protoSrc = srcOf("../src/protocol.ts");
  check(protoSrc.includes('"backlog" | "claimed" | "submitted" | "ready_to_install" | "done"'), "BoardEntryStatus 五态联合（D18 对齐）");
  check(protoSrc.includes("transitions?: { status: BoardEntryStatus; ts: number }[]"), "transitions 时间线字段（件十九消费面）");
  check(protoSrc.includes("interface RuleEntry"), "RuleEntry 端侧镜像");
  check(protoSrc.includes("rules?: RuleEntry[]"), "SNAPSHOT.rules 覆盖式锚定声明");
  check(protoSrc.includes("nick?: string }[]"), "headcount 席位别名（UIPOLISH3 件十⑤）");
  check(protoSrc.includes('"rule-append"'), "OrgConfirm kind 含 rule-append");

  console.log("D. store rules 域五挂点（relay 零改动红线下的端侧消费）");
  const storeSrc = srcOf("../src/store.ts");
  check(storeSrc.includes("rules: RuleEntry[] | null;"), "conn.rules 字段");
  check(storeSrc.includes('case "RULES_UPDATED"'), "RULES_UPDATED 帧消费 case");
  check(storeSrc.includes("conn.rules = Array.isArray(rls) ? rls.filter(isRuleEntry) : null;"), "SNAPSHOT rules 覆盖式锚定");
  check(storeSrc.includes("rules: c.rules,"), "快照透出 rules");
  check(storeSrc.includes("rulesEnabled"), "总开关透出（置灰说明口径）");

  console.log("E. TeamDetailPage 七节（源码字面锚）");
  const tdpSrc = srcOf("../src/screens/TeamDetailPage.tsx");
  for (const anchor of [
    ["待你确认 ·", "① 待你确认块置顶"],
    ["任务板", "② 看板节"],
    ["backlog", "② backlog 泳道"],
    ["未指派 ·", "② backlog 尾未指派小节（⑦b）"],
    ["离编 / 未指派", "② claimed 离编/无主尾节"],
    ["claimGrp", "② claimed 按成员分区（件八）"],
    ["dispatchStatus", "② 运行中判定（回执 join）"],
    ["编制 ·", "④ 编制折叠组"],
    ["hcOpen", "④ 默认折叠态"],
    ["memberInfoOf", "④ 成员卡信息模型（UPOLISH3 规则）"],
    ["活动 · 派单回执", "⑤ 活动流"],
    ["RECEIPT_ST_ZH", "⑤ 回执状态词中文化"],
    [">经验<", "⑥ 经验节"],
    [">铁律<", "⑦ 铁律节"],
    ["Leader 徽章条目仅注入 Leader 会话", "⑦ Leader 受众图例（管理面全量可见不隐藏）"],
    ["src?.boards?.[gid] ?? detail?.board", "板 live 优先（BOARD_UPDATED 增量）"],
    ["轻立项", "轻立项单列简化态降级保持"],
    ["transitions", "③ 点卡展开：流转时间线（件十九）"],
    ["taskOwnerResolve", "③ owner 解析（前缀映射 headcount）"],
  ] as const) {
    check(tdpSrc.includes(anchor[0]), anchor[1]);
  }
  // 水位真比例断言修正：锚实际写法
  check(tdpSrc.includes("Math.max(1, Math.min(100, Math.round((used / limit) * 100)))"), "④ 水位真比例 clamp（件十六防护）");
  check(tdpSrc.includes("pct >= 85 ? c.error : pct >= 60 ? c.working : c.done"), "④ 水位 85/60 两档色（桌面 memberCtxMeter 同阈值）");
  check(!/>对话</.test(tdpSrc) && !/对话 tab/.test(tdpSrc), "对话不设 tab（A1-13：桌面也是占位；成员卡/owner 点开即达）");

  console.log("F. 建团向导（件二）");
  const wizSrc = srcOf("../src/screens/TeamCreateWizard.tsx");
  check(wizSrc.includes('"COMMAND_ORG_ACTION"'), "走 COMMAND_ORG_ACTION 现役通路");
  check(wizSrc.includes('action: "create"'), "action=create（relay 单漏斗）");
  check(wizSrc.includes('v: "轻立项"') && wizSrc.includes('v: "正经立项"'), "载荷发旧词（tier 存储值不动）");
  check(wizSrc.includes("轻量项目") && wizSrc.includes("正式项目"), "显示层口语化（tierZh 口径）");
  check(wizSrc.includes("统一 worker") && wizSrc.includes("统一 PM") && wizSrc.includes("自由编制"), "角色模板三选（桌面同款）");
  check(wizSrc.includes("ROLE_PRESETS") && wizSrc.includes("reviewer") && wizSrc.includes("qa"), "自由编制词表 worker/PM/reviewer/qa");
  check(wizSrc.includes("n.size >= 8"), "8 席上限闸（relay sanitizeHeadcount 同闸）");
  check(wizSrc.includes("recentDirs"), "目录步最近项目快捷选");
  check(wizSrc.includes("needsConfirm"), "提交反馈区分 needsConfirm（确认卡决议提示）");
  check(wizSrc.includes("ackTapGuard") && wizSrc.includes("ackVerdict"), "ACK 严格判定门（E2b 口径）");
  check(!wizSrc.includes("手动席") || wizSrc.includes("不搬"), "手动席不搬（C-6）");

  console.log("G. 项目域（件三）");
  const orgTabsSrc = srcOf("../src/screens/OrgTabs.tsx");
  check(orgTabsSrc.includes("新建会话于此目录"), "动作①新建会话于此目录");
  check(orgTabsSrc.includes("查看项目会话"), "动作②查看项目会话");
  check(orgTabsSrc.includes("UNFILED_KEY"), "未立项折叠组持久键（AsyncStorage）");
  check(orgTabsSrc.includes("unfiledOpen"), "未立项默认折叠态");
  check(orgTabsSrc.includes("该目录未立项"), "未立项只读说明（不产生第二写面）");
  check(orgTabsSrc.includes("去团队域"), "去团队域按钮");
  check(orgTabsSrc.includes("startsWith(anchor + \"/\")"), "cwd 前缀匹配（桌面 getSessionProject 口径）");
  check(orgTabsSrc.includes("project_gid"), "project_gid 服务端真值优先");
  const listSrc = srcOf("../src/screens/ListScreen.tsx");
  check(listSrc.includes("dirFilter"), "ListScreen 目录过滤接收");
  check(listSrc.includes("dirBar"), "可清除过滤条");
  check(listSrc.includes("d === f || d.startsWith(f + \"/\")"), "过滤归一匹配（含子目录）");
  const nsmSrc = srcOf("../src/screens/NewSessionModal.tsx");
  check(nsmSrc.includes("presetCwd"), "NewSessionModal presetCwd 入参");
  check(nsmSrc.includes("覆盖 ccr_cwd"), "预设目录覆盖记忆一次（口径注记）");

  console.log("H. 件四退役 + 回跳落点 + 查漏组");
  const notifSrc = srcOf("../src/screens/NotifCenterPage.tsx");
  check(notifSrc.includes("<TeamDetailPage") && !notifSrc.includes('from "./OrgZone"'), "验收回跳落点 = TeamDetailPage（GroupModal import 面清零）");
  const appSrc = srcOf("../App.tsx");
  check(appSrc.includes("badges={{ sessions: pendingCount, team: teamBadge }}"), "团队 tab badge=确认卡数（A1-11）");
  check(appSrc.includes("onNewInDir") && appSrc.includes("onViewSessionsInDir"), "App 接线项目卡两动作");
  // A3-5：状态 tag 退役 + r3 条件渲染
  check(!/function StatusTag/.test(listSrc) && !/<StatusTag/.test(listSrc), "A3-5 状态 tag 退役");
  check(listSrc.includes("r3Meta.shown.length > 0 || r3Meta.hidden > 0 || engineBadgeable(s.engine) ? ("), "A3-5 r3 全空整行不渲染（r3Meta 重构形态锚——预存红跟改：W-ASKFIX b657569 同款，未进本基线）");
  // A3-7：头像引擎淡彩
  check(listSrc.includes('ENGINE_ACCENT[s.engine ?? "claude"]'), "A3-7 头像底色=引擎品牌色淡彩");
  // A4-4：信息行序 目录→水位→活跃时间
  const detailSrc = srcOf("../src/screens/DetailScreen.tsx");
  check(detailSrc.includes("A4-4 查漏"), "A4-4 信息行序注记");
  check(/s\.cwd.*ctxPct.*fmtLastActive/s.test(detailSrc), "A4-4 序=目录→水位→活跃时间");
  // A4-6→件六①演进：长按位改为操作菜单（复制 ID 并入菜单行；Clipboard 直写保持）
  check(listSrc.includes("onLongPress"), "长按入口在场（件六①）");
  check(listSrc.includes("Clipboard.setStringAsync"), "A4-6 剪贴板直写");

  console.log("I. 件五：发消息乐观回显（0.5s 内本地可见 + 三路对账）");
  // @ts-expect-error 桩层同上
  const pe = await import("../src/pending-echo.ts");
  const peNow = 1_000_000;
  const peMk = (key: string, text: string, ts = peNow, state: "sending" | "queued" | "failed" = "sending") => ({ key, sid: "s1", text, ts, state });
  // ① 发送→同步注入（「0.5s 内本地可见」的判定面：pushPending 是纯同步——无异步
  //    竞态、无网络依赖，渲染同帧见气泡）
  const l1 = pe.pushPending([], peMk("k1", "你好"));
  check(l1.length === 1 && l1[0].state === "sending", "pushPending 同步注入 sending 态");
  let l2 = pe.pushPending(l1, peMk("k2", "第二条"));
  check(l2.length === 2 && l2[1].key === "k2", "连发追加保序");
  // cap：超 20 丢最旧
  let peBig: ReturnType<typeof pe.pushPending> = [];
  for (let i = 0; i < 25; i++) peBig = pe.pushPending(peBig, peMk(`b${i}`, `m${i}`));
  check(peBig.length === pe.ECHO_CAP && peBig[0].key === "b5", `注入上限 ${pe.ECHO_CAP}（丢最旧）`);
  // ② 失败标记（幂等：不存在的键 no-op）
  const lf = pe.markEchoState(l2, "k1", "failed");
  check(lf[0].state === "failed" && lf[1].state === "sending", "markEchoState 逐条改态");
  check(pe.markEchoState(lf, "nope", "failed") === lf, "markEchoState 未知键幂等 no-op");
  check(pe.markEchoState(lf, "k1", "failed") === lf, "markEchoState 同态幂等 no-op");
  // ③ 回声对账：user_message 文本匹配（空白串归一：多空格↔单空格等价）→ 气泡融掉
  const l2w = pe.pushPending(pe.pushPending([], peMk("k1", "你  好")), peMk("k2", "第二条")); // 发送文本含连续空格
  const echoLog = [{ kind: "user_message", text: "你 好", ts: peNow + 500 }] as never[]; // 回声单空格
  const lr = pe.reconcilePending(l2w, { sid: "s1", logs: echoLog, pendingInputs: null, now: peNow + 600 });
  check(lr.length === 1 && lr[0].key === "k2", "回声到达→同文本气泡融掉（空白串归一匹配）");
  const oldEcho = [{ kind: "user_message", text: "你  好", ts: peNow - 60_000 }] as never[];
  check(pe.reconcilePending(l2w, { sid: "s1", logs: oldEcho, pendingInputs: null, now: peNow + 600 }).length === 2,
    "发送前 60s 的旧回声不消气泡（时间窗）");
  // 时间窗外的旧回声不匹配（防历史消息误消）
  const oldEcho2 = [{ kind: "user_message", text: "你好", ts: peNow - 60_000 }] as never[];
  check(pe.reconcilePending(l2, { sid: "s1", logs: oldEcho2, pendingInputs: null, now: peNow + 600 }).length === 2,
    "时间窗原用例（单空格文本）不消气泡");
  // 连发同文本×2：两回声消两条；一回声只消最旧
  const peDup = [peMk("d1", "同文案", peNow), peMk("d2", "同文案", peNow + 10)];
  const oneEcho = [{ kind: "user_message", text: "同文案", ts: peNow + 500 }] as never[];
  const peR1 = pe.reconcilePending(peDup, { sid: "s1", logs: oneEcho, pendingInputs: null, now: peNow + 600 });
  check(peR1.length === 1 && peR1[0].key === "d2", "同文本连发：一回声 FIFO 消最旧");
  const twoEcho = [...oneEcho, { kind: "user_message", text: "同文案", ts: peNow + 510 }] as never[];
  check(pe.reconcilePending(peDup, { sid: "s1", logs: twoEcho, pendingInputs: null, now: peNow + 600 }).length === 0,
    "同文本连发：两回声消两条");
  // ④ 排队对账：pending_inputs 同文本 → queued 态（可见性保持）
  const lq = pe.reconcilePending(l2, { sid: "s1", logs: [], pendingInputs: [{ text: "你好", ts: peNow + 100 }], now: peNow + 200 });
  check(lq.find((x) => x.key === "k1")?.state === "queued", "会话忙排队→气泡转 queued（不消失）");
  // 排队被消费（pending_inputs 移除）→ 回 sending 等回声
  const lq2 = pe.reconcilePending(lq, { sid: "s1", logs: [], pendingInputs: [], now: peNow + 300 });
  check(lq2.find((x) => x.key === "k1")?.state === "sending", "排队被消费→回 sending 等回声");
  // ⑤ 安全阀：无回声超时清理
  check(pe.reconcilePending(l2, { sid: "s1", logs: [], pendingInputs: null, now: peNow + pe.ECHO_STALE_MS + 1 }).length === 0,
    "STALE_MS 安全阀清理");
  // ⑥ 跨会话隔离：别的 sid 条目不动
  const peMixed = [peMk("o1", "别家", peNow), { ...peMk("m1", "本家", peNow), sid: "s2" }];
  const lm = pe.reconcilePending(peMixed, { sid: "s1", logs: [], pendingInputs: null, now: peNow + 100 });
  check(lm.find((x) => x.key === "m1") !== undefined && lm.find((x) => x.key === "o1") !== undefined,
    "跨会话条目键控隔离（别家 sid 不被本会话对账动）");
  // ⑥b W-MSGFIX（1016 实锤「发送中」滞留）：relay 回声 text=3 行截断版/full=全文——
  // 严格相等对长文恒失配气泡挂到安全阀。截断兼容：text 或 full 任一相等即命中
  const longText = "这是一条超过三行显示会被 relay 截断的长消息".repeat(12);
  const truncEcho = [{ kind: "user_message", text: longText.slice(0, 80) + "…", full: longText, ts: peNow + 400 }] as never[];
  const peLong = [peMk("L1", longText, peNow)];
  check(pe.reconcilePending(peLong, { sid: "s1", logs: truncEcho, pendingInputs: null, now: peNow + 500 }).length === 0,
    "W-MSGFIX：截断回声（text≠原文/full=原文）正确消气泡（滞留根修）");
  const plainEcho = [{ kind: "user_message", text: "你好", ts: peNow + 400 }] as never[];
  const peM2 = pe.reconcilePending(l2, { sid: "s1", logs: plainEcho, pendingInputs: null, now: peNow + 500 });
  check(peM2.find((x) => x.key === "k1") === undefined && peM2.find((x) => x.key === "k2") !== undefined,
    "W-MSGFIX 回归：无 full 的全等回声照常消气泡（k1 消、k2 留——既有行为不回归）");
  // W-HEADUNI：全页 head 高度单一基准锚（用户 1020 口径——会话列表页为唯一基准）
  {
    const hu = srcOf("../src/head-unify.ts");
    const ls = srcOf("../src/screens/ListScreen.tsx");
    const ph = srcOf("../src/screens/page-head.tsx");
    const ds = srcOf("../src/screens/DetailScreen.tsx");
    const td = srcOf("../src/screens/TeamDetailPage.tsx");
    const sp = srcOf("../src/screens/SettingsPage.tsx");
    check(hu.includes("height: 48,") && !/minHeight\s*:/.test(hu), "HEADUNI-1 head-unify 基准常量固定 height 48（#191 根修：minHeight→height——三档漂移根因；注释提及不算，查代码面无 minHeight: 键）");
    check(ls.includes("...HEAD_BASE") && !ls.includes("minHeight: 48,"), "HEADUNI-2 ListScreen 基准页引常量（无字面回退）");
    check(ph.includes("...HEAD_BASE") && td.includes("...HEAD_BASE") && sp.includes("...HEAD_BASE") && srcOf("../src/components/detail-styles.ts").includes("...HEAD_BASE"), "HEADUNI-3 四消费页全部 spread HEAD_BASE（detail 的 head 键随工厂外迁 detail-styles.ts——S1B 锚跟改）");
    check(!td.includes("paddingTop: 12, paddingBottom: 10") && !sp.includes("paddingBottom: 13,"), "HEADUNI-4 漂移源清除（团队详情 14/12/10、设置 paddingBottom 13 均退役）");
  }
  // ⑦ 源码接线锚：发送注入/ack 失败/渲染挂点/重发/滚动跟随
  // W-SPLIT-S1C：TranscriptRow 迁 components/detail-parts.tsx，折叠判定锚随迁
  const partsSrc = srcOf("../src/components/detail-parts.tsx");
  check(partsSrc.includes("const long = !!e.full && e.full.length > e.text.length"), "W-MSGFIX：折叠判定=full 比 text 长才折叠（20/29 字假折叠根修；S1C 随组件迁 detail-parts）");
  check(String(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8")).includes("String(msg.payload.full || msg.payload.text || \"\")"), "W-MSGFIX：兜底对账 key full 优先（store 消费面）");
  check(detailSrc.includes("setPendingEcho((prev) =>\n      pushPending(prev,"), "send() 发送瞬间同步注入（乐观回显入口）");
  check(detailSrc.includes('markEchoState(prev, echoKey, "failed")'), "ack 失败→失败态（onAck 接线）");
  check(detailSrc.includes("<PendingEchoBubble"), "pending 气泡挂转录尾部");
  check(detailSrc.includes("发送失败 · 点按重试"), "失败态文案（点按重试）");
  check(detailSrc.includes("const retryEcho"), "失败重发链");
  check(detailSrc.includes("reconcilePending(prev, { sid, logs, pendingInputs"), "渲染层对账 effect 接线");
  check(/myEcho\.length\]\);/.test(detailSrc), "滚动跟随含气泡数（发完即滚到底）");

  console.log("J. 件六：长按菜单/左滑退役/滑切 tab");
  // @ts-expect-error 桩层同上
  const list = await import("../src/screens/ListScreen.tsx");
  // ① 长按菜单：400ms + 贴底 sheet 四操作（置顶/重命名/复制 ID/删除）+ 删除拦截
  check(listSrc.includes("delayLongPress={400}"), "长按 400ms 触发（用户指定）");
  check(listSrc.includes("function CardMenuSheet"), "CardMenuSheet 贴底菜单组件");
  check(listSrc.includes("置顶区恒在列表前部"), "菜单行：置顶（含落位说明）");
  check(listSrc.includes('"重命名"') || listSrc.includes('row("重命名"'), "菜单行：重命名");
  check(listSrc.includes('"复制 ID"') || listSrc.includes('row("复制 ID"'), "菜单行：复制 ID");
  check(listSrc.includes('"删除"') || listSrc.includes('row("删除"'), "菜单行：删除");
  check(listSrc.includes("运行中/后台在跑不可删"), "删除行运行中拦截（禁用态）");
  check(listSrc.includes("COMMAND_PIN_SESSION"), "置顶走 COMMAND_PIN_SESSION（桌面同链）");
  check(listSrc.includes("4 秒内可撤销"), "删除行撤销提示（#247 舞步保持）");
  // ② 左滑退役：SwipeRow 组件/操作面板/reveal 机制零残留（结构性断言——注释提及不算）
  check(!/function SwipeRow/.test(listSrc) && !/<SwipeRow/.test(listSrc), "SwipeRow 组件退役（件六②）");
  check(!/actPanel/.test(listSrc) && !/actBtn/.test(listSrc), "左滑操作面板样式零残留（件六②）");
  check(!/onReveal/.test(listSrc), "滑出 reveal 机制零残留");
  // ③ 投影（纯函数，回归②新结构）：置顶无头平铺 → 团队收纳组（grp=team）→
  // 「进行中」组（grp=active）→ 闲置平铺；「待处理」段退役（badge 仍计数真行动项）
  const proj = list.buildListProjection as (p: unknown) => { kind: string; key: string; label?: string; grp?: string; count?: number; s?: { session_id: string; pinned?: boolean } }[];
  const mkS = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    session_id: id, relay_session_id: id, cwd: "/d/x", initial_prompt: "", title: id, model: "m",
    status: "DONE", action_summary: "", started_at: 1, updated_at: 1, stats: {}, ...over,
  });
  const rowsP = proj({
    sessions: [
      mkS("pin1", { pinned: true, updated_at: 60 }),
      mkS("t1", { status: "WORKING", updated_at: 55, project_gid: "gA" }),
      mkS("t2", { status: "DONE", updated_at: 50, project_gid: "gA" }),
      mkS("act1", { status: "WORKING", updated_at: 45 }),
      mkS("wait1", { status: "WAITING", waiting_request: { request_id: "r1", tool_name: "Bash" }, updated_at: 42 }),
      mkS("idle1", { updated_at: 30 }),
    ],
    aggregate: false, sources: [], notifications: [],
    projects: [{ id: "gA", name: "甲团", anchor_dir: "/d/a", tier: "轻立项", status: "active", created_at: 1, updated_at: 1, headcount: [{ session_id: "t1", role: "worker" }, { session_id: "t2", role: "worker" }] }],
  });
  const keysP = rowsP.map((r) => r.key);
  check(keysP[0] === "pin1", "投影：置顶无头平铺恒首（跨组钉选）");
  check(!keysP.includes("sec-pending") && !keysP.includes("sec-pinned"), "投影：「待处理/置顶」段头退役（回归②新结构）");
  const teamIdx = keysP.indexOf("team-gA");
  check(teamIdx > 0 && rowsP[keysP.indexOf("team-gA")].label === "甲团" && rowsP[teamIdx].grp === "team", "投影：团队收纳组（在办编制成员）");
  check(keysP.indexOf("t1") > teamIdx && keysP.indexOf("t2") > teamIdx, "投影：团队卡收纳组内");
  // 件九：「进行中」组取消——非编制卡（WORKING/WAITING/闲置）全部平铺
  check(!keysP.includes("sec-active"), "投影：「进行中」组已取消（件九，状态过滤交筛选档）");
  check(keysP.indexOf("act1") > teamIdx && keysP.indexOf("wait1") > teamIdx && keysP.indexOf("idle1") > teamIdx, "投影：非编制卡平铺（行动前置+recency）");
  // badge 语义：WORKING 有活动证据不再计 pending（真行动=可决策 WAITING/验收单/通知）
  const spNew = list.splitPending([mkS("w1", { status: "WAITING", waiting_request: { request_id: "r2", tool_name: "Bash" } }), mkS("wk1", { status: "WORKING", activity: { state: "WORKING", capabilities: {}, activity: { kind: "tool", text: "npm test", observed_at: 1 }, updated_at: 1 } })] as never[]) as { pending: { session_id: string }[]; others: { session_id: string }[] };
  check(spNew.pending.length === 1 && spNew.pending[0].session_id === "w1", "badge 语义：WORKING 有活动≠待处理（真行动才计）");
  // 休眠语义拆分（C-3 跟进）：saved 单字段判定
  check(listSrc.includes("s.saved === true && s.status !== \"WORKING\" && s.status !== \"WAITING\""), "休眠判定 saved 单字段（pinned=纯置顶，C-3 拆分落地）");
  // ③ App 滑切 tab：panHandlers 挂 tabPane + 横占优判定 + tabRef 防陈旧
  // W-NOTIFY2 件二跟改：滑切升级为跟手过渡（判定改排除式语义同前：横不占优即放行）
  check(appSrc.includes("{...swipeTabs.panHandlers}"), "滑切手势挂 tabPane（件六③）");
  check(appSrc.includes("TAB_ORDER") && appSrc.includes('["sessions", "team", "projects", "settings"]'), "滑切序=底栏序");
  check(appSrc.includes("Math.abs(g.dx) <= Math.abs(g.dy) * 2"), "横占优判定（排除式——垂直滚动零冲突，W-NOTIFY2 跟手版）");
  check(appSrc.includes("tabRef.current"), "tabRef 镜像防闭包陈旧");
  check(appSrc.includes("swipePageX.toX") && appSrc.includes("swipePageX.curX"), "双页同相位位移（目标页+当前页视差 0.35）");
  check(appSrc.includes("prog >= w / 2 || (s.dir === 1 ? g.vx : -g.vx) <= -0.55"), "松手过半/速度判定落位（spring 收尾）");
  check(appSrc.includes("swipeOver"), "目标页覆盖层（落位 setTab 接管+清态卸载——保挂载纪律）");

  console.log("K. 回归双修（铃铛恒显/分组对齐）+ 件七/件八");
  // 🔧回归①：铃铛恒显（0=无计数态，不再整钮消失）
  check(/notifPending\.length > 0 \? null/.test(listSrc) === false, "铃铛不再条件消失（0 也显示）");
  check(listSrc.includes("notifPending.length > 99 ? \"99+\" : notifPending.length") && listSrc.includes("bellBadgeOff: { display: \"none\" }"), "铃铛计数 badge 化（W-MV8A：胶囊退役、顶栏 bbadge 红底计数 99+ 封顶，0=display 隐藏态常挂）");
  // 🔧回归②：分组结构断言（投影纯函数面已覆盖；此处锚渲染层折叠/持久）
  check(listSrc.includes("TEAM_EXPANDED_KEY"), "团队组折叠态持久键（件九：进行中组键随组退役）");
  check(!listSrc.includes("sec-active"), "「进行中」组渲染层退役（件九：状态过滤交筛选档）");
  check(listSrc.includes("toggleSection"), "组头折叠交互");
  // 件七：三域 ＋ 统一
  const brandSrc = srcOf("../src/brand.tsx");
  check(brandSrc.includes("export function PlusMark"), "PlusMark 单源导出（brand.tsx）");
  check(listSrc.includes('from "../brand"') && !/function PlusMark/.test(listSrc), "会话页复用 brand.PlusMark（本地定义移除）");
  check(orgTabsSrc.includes("<PlusMark size={20} color={c.brandA} />"), "团队/项目页 PlusMark 接线");
  // W-MOBILE3 #121 口径对齐：触区统一 44（ListScreen 视觉 44 / OrgTabs A2 终态视觉 36
  // + hitSlop 4 ≈ 44 触区）——dda6490 收编删旧 44 块后本断言基线红，按现拍板终态改写
  check(/plusBtn: \{\s*width: 44, height: 44/.test(listSrc) && /plusBtn: \{ width: 36, height: 36/.test(orgTabsSrc), "三域 plusBtn 统一触区（ListScreen 44 视觉 / OrgTabs 36 视觉+hitSlop≈44）");
  // 件八：品牌行移除
  check(!listSrc.includes("CC Deck</Text>") && !/titleT/.test(listSrc), "「CC Deck」标题行移除（件八）");
  check(!/logoBtn/.test(listSrc), "logo 钮退役（件八；设置入口=底栏设置域）");

  console.log("L. 件十：组间分隔线 + 团队色竖条（#85 波次2 重做跟改：间距 20→8 压缩，组间节奏交还 divider）");
  check(listSrc.includes("secDivider"), "组间 hairline 分隔线样式");
  check(/marginTop: 8, marginBottom: 3/.test(listSrc), "组头垂直占位压缩（44→27px：marginTop 8/marginBottom 3——#85 用户截图反馈拍板）");
  check(listSrc.includes("secCountPill"), "计数胶囊（桌面 .tag 语汇移动化——#85 现代化可见变化）");
  check(listSrc.includes("secTeamBar"), "团队色竖条样式（2px 细线，桌面 grpBar 同语言）");
  check(listSrc.includes("teamColor: srcColor(t.gid)"), "团队组头带 gid 哈希色（SRC_COLORS 环）");
  check(listSrc.includes("divided={idx > 0}"), "首组不出线（idx>0 才分隔）");

  console.log("M. 🔥P0：前台即时重连+重连提速");
  check(srcOf("../src/store.ts").includes("}, 800);"), "探测超时 2.5s→800ms（前台语境，PONG 即时/<1s）");
  check((srcOf("../src/store.ts").match(/this\.connDead\(conn, ws\);\n\s+(?:\/\/[^\n]*\n\s*)*this\.connConnect\(conn\);/g) ?? []).length >= 2, "探测判死三路（超时/send 异常/readyState）→ connDead 后零延迟 connConnect");
  check(srcOf("../src/store.ts").includes("重连速度=最高频痛点"), "P0 注记在场（用户提级口径）");
  check(srcOf("../src/store.ts").includes("startForegroundService()"), "后台保活：connConnect 收口 FGS（既有 #85 面）");
  check(srcOf("../src/store.ts").includes("resetBackoff();"), "回前台清退避（#114 既有面保持）");

  console.log(`OK ${tests} assertions（W-EXPODOMAIN v2：件一~件十 + P0 重连 + 回归双修 + 查漏组）`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
