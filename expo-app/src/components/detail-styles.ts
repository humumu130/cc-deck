// W-SPLIT-S1B：DetailScreen makeStyles 样式工厂整体外迁（298 键原样——只搬不改）。
// 消费面：DetailScreen（useThemeStyles(makeStyles) 不变）+ 后续 1b 域切件在此文件内做。
import { StyleSheet } from "react-native";
import { withA, type ThemeColors } from "../theme";
import { HEAD_BASE } from "../head-unify";
import { TAB_GAP, TAB_PAD_L } from "./detail-consts";

export const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  // 回到底部浮钮（#322 第五轮，用户拍板）：对话区底部居中、输入框上方，正圆形
  // W-MOTION：宿主承接定位（absolute/bottom），内层钮去定位——opacity 过渡作用在宿主
  jumpFabHost: { position: "absolute", bottom: 10, left: 0, right: 0, alignItems: "center", pointerEvents: "box-none" },
  jumpFab: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, elevation: 4,
  },
  jumpFabT: { color: c.dim, fontSize: 16, fontWeight: "700", lineHeight: 18, marginTop: -1 },
  // 头部（用户拍板口径）：R1 = 返回+标题；R2 = 元信息行（源·ctx 一句话左聚 + 胶囊簇右锚）。
  // #159 方案A：标题↔元信息视觉间距 6→9pt（marginTop 3→6），head paddingVertical 6→4
  // 补偿——总高 49→48px 不增反减（#108 键盘顶升契约不受影响）
  head: {
    flexDirection: "row", alignItems: "center", gap: 8,
    ...HEAD_BASE, /* W-HEADUNI：#148 旧对齐源退役——统一会话列表页基准 */
    borderBottomWidth: 1.5, borderBottomColor: c.lineStrong, /* W-HEADFIX2：分割线统一基准页口径 */
  },
  // 返回钮：圆角 8 / tintSoft 底（与思考开关同语言）；SVG chevron 保笔画一致；overflow hidden 裁 ripple
  // W-UIFIX 件七：纯 chevron 背钮（去 tintSoft 方块底）——40px 触区、图标 24px 微信式
  backPlain: { width: 40, height: 40, alignItems: "center", justifyContent: "center", marginLeft: -6 },
  back: {
    width: 26, height: 26, borderRadius: 8, backgroundColor: c.tintSoft, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
  },
  hintText: { color: c.faint },
  title: { color: c.text, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  // R2 元信息行：源·ctx 一句话左聚（#159 缝合，原 ctx 标签/水位条/独立字号样式已废），
  // 设置簇 marginLeft:auto 右锚
  headMeta: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  // 副信息行（头部专用）：次级信息统一档 10px dim（#159：源与 ctx 同档同色，报警档才异色）
  sub: { color: c.dim, fontSize: 10, lineHeight: 13 },
  // 统计视图卡片（原 StatsModal 内容平铺）
  // W-EXPO 005「更多」键值行（kv-row）：行级无常驻分隔线（军规②），值左标签右
  statRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 6 },
  statRowK: { flexShrink: 0, color: c.dim, fontSize: 10 },
  statRowV: { color: c.textStrong, fontSize: 12.5, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 1 },
  // 「更多」小节（more-section）：分组只靠间距+小节标题（军规③）
  moreSec: { marginTop: 18 },
  moreSecT: { marginBottom: 4, color: c.faint, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  // 水位计（context-meter 005 形制）
  meterWrap: { paddingVertical: 4 },
  // W-LIST2 件二②：headMeta 行内颗粒水位组（颗粒带+%文本，行高 ~14 内贴合）
  headCtx: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0 },
  headCtxPct: { fontSize: 9.5, fontVariant: ["tabular-nums"] }, /* W-UIFIX 件二：随水位计调小一号 */
  meterHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  meterKicker: { color: c.faint, fontSize: 9, letterSpacing: 0.8 },
  meterModel: { color: c.textStrong, fontSize: 11, fontWeight: "700", marginTop: 2 },
  meterGrade: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  meterGradeT: { fontSize: 10, fontWeight: "700" },
  meterBand: { flexDirection: "row", gap: 3, marginVertical: 10 },
  meterCell: { flex: 1, height: 7, borderRadius: 3, backgroundColor: c.ctxTrack },
  meterStats: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  meterStatsL: { flexShrink: 1 },
  meterUsed: { color: c.textStrong, fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  meterLimit: { color: c.dim, fontSize: 10, fontVariant: ["tabular-nums"] },
  meterPct: { fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
  // 思考/审批开关（R2 设置簇）：#159 方案A 去迷你滑块，改与权限胶囊同形文字胶囊——
  // h14/r7/tintSoft 素底（off）+ 品牌蓝描边亮底（on），一行只剩一种胶囊形态；
  // 触达靠 hitSlop 补偿，圆角 8 语感与返回钮同
  thinkToggle: {
    height: 14, borderRadius: 7, paddingHorizontal: 6, backgroundColor: c.tintSoft,
    borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 4,
  },
  thinkToggleOn: { borderColor: withA(c.brandA, 0.4), backgroundColor: c.tintStrong },
  thinkToggleT: { fontSize: 9, lineHeight: 10, color: c.dim },
  thinkToggleTOn: { color: c.brandA, fontWeight: "600" },
  // 固定工具区：跟随头部、不随转录滚动，底部一条分隔线与头部呼应（paddingTop 收紧贴头部）
  /* W-DETAIL2 件二：去双线——fixedBar 底边框退役（tab 指示线承载选中态语义独占分隔）；
      tab 行收紧（paddingVertical 4→2、filterRow marginBottom 10→6） */
  fixedBar: { paddingHorizontal: 14, paddingTop: 4 },
  strip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginBottom: 8,
  },
  stripErr: { flex: 1, color: c.error, fontSize: 12.5, fontWeight: "600" },
  // E3a done 收口条（与 stripErr 同形同号级，色走 done）
  stripDone: { flex: 1, color: c.done, fontSize: 12.5, fontWeight: "600" },
  // W-EXPOLISH 件四：输入区上沿单行活动舱（对齐桌面 composer 前状态坞 #dockActivityRow
  // 单行制）：左缘 2px 状态色（005 session-state-dock 语言保留）+ 一行流（呼吸点·
  // 状态词·走秒·token·当前操作），行高恒定 15，动作文本 flex 收缩单行截断——
  // 原头部两行制（dock/dockRow/dockStateT/dockElapsed/dockTok/dockTask/dockAct）退役
  dockWork: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginBottom: 6, paddingLeft: 0, paddingVertical: 4 }, /* W-DETAIL2 件一：WORKING 主状态行（LiveStatusLine 自带转轮+计时） */
  dockLine: { flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 12, marginBottom: 6, borderLeftWidth: 2, paddingLeft: 8, paddingVertical: 5 },
  dockLineState: { fontSize: 11, fontWeight: "700", lineHeight: 15 },
  dockLineMeta: { fontSize: 10.5, color: c.dim, fontVariant: ["tabular-nums"], lineHeight: 15 },
  dockLineAct: { flex: 1, minWidth: 0, fontSize: 11, color: c.dim, lineHeight: 15 },
  stripBtnWarn: {
    height: 26, borderRadius: 8, paddingHorizontal: 10, backgroundColor: c.panel2,
    borderWidth: 1, borderColor: withA(c.waiting, 0.3), alignItems: "center", justifyContent: "center",
  },
  stripBtnWarnT: { color: c.error, fontSize: 11, fontWeight: "600" },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 },
  statusSpin: { fontSize: 14, fontWeight: "700" },
  statusText: { flex: 1, fontSize: 12.5, fontWeight: "600" },
  statusTime: { color: c.faint, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  /* #224 动作行（布局细则定稿 1023）：⚙ Running {命令} · {回合走秒}——mono 等宽+dim
     弱色小一档（CLI 原生小字味道）；单行截断+点按展开全量（组件侧 numberOfLines 切
     换），不折叠（暂态行常驻即「在跑什么」的存在感） */
  dockSub: { color: c.dim, fontSize: 10.5, fontFamily: "monospace", lineHeight: 14, marginTop: 3 },
  // 工作状态盒（对话流内，类 CLI）+ 其下方的排队注入消息。
  // #186 改 column：主状态行（liveMain）+ 并行子 Agent 块（agBox）同盒收拢；
  // marginBottom 10 承接原 agBox 的底部间距（与 pendWrap marginTop 8 叠加 18）。含子
  // Agent 的路径间距与旧版一致；「WORKING 无子 Agent + 排队消息」组合由旧 8 变 18——
  // 各路径底部节奏统一为 18，有意为之（审查确认非功能问题）
  liveRow: {
    flexDirection: "column",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginTop: 10, marginBottom: 10,
  },
  liveMain: { flexDirection: "row", alignItems: "center", gap: 8 },
  pendWrap: { flexDirection: "column", gap: 6, marginTop: 8, alignItems: "flex-end" },
  pendRow: {
    maxWidth: "86%", backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, borderTopRightRadius: 4, paddingHorizontal: 10, paddingVertical: 7,
  },
  pendT: { color: c.dim, fontSize: 12.5, lineHeight: 17 },
  // 视图 tab 行：下划线式（与网页端 tabs 同风格）；tabWrap 自测宽供指示条几何
  filterRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }, /* W-DETAIL2 件二 */
  tabWrap: { flex: 1, position: "relative", flexDirection: "row", gap: TAB_GAP, paddingLeft: TAB_PAD_L },
  tabBtn: { flex: 1, alignItems: "center", paddingVertical: 2, borderBottomWidth: 2, borderBottomColor: "transparent" }, /* W-DETAIL2 件二：降高 */
  // 005 mobile-detail-tabs：激活 text-strong 加粗 + brand 底杠（指示条动画保留）
  tabInd: { position: "absolute", left: TAB_PAD_L, bottom: 0, height: 2, borderRadius: 1, backgroundColor: c.brandA },
  tabT: { fontSize: 11.5, color: c.dim }, /* W-DETAIL2 件三裁决=A 纯汉字收紧（理由见回执） */
  tabTOn: { color: c.textStrong, fontWeight: "700" },
  // #36 权限胶囊（R2 设置簇左位，思考开关右侧成组）：h14/r7 与思考开关同形态语言
  permCluster: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  permPill: {
    height: 14, borderRadius: 7, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4,
  },
  // 幽灵态（标准）：盾标 + ⇄ 切换符（#117 起两图标，定宽 20 放不下改自适应，
  // 描边色按明暗在 JSX 注入——深色 line 太弱需提亮）
  permPillGhost: { paddingHorizontal: 6, backgroundColor: c.tintSoft },
  permPillLit: { paddingHorizontal: 6, backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  // 警示态（跳过）：红只到 tint+描边+文字，不用实底——14px 实底会变整行最重元素压过标题
  permPillWarn: { paddingHorizontal: 6, backgroundColor: withA(c.waiting, 0.1), borderColor: withA(c.waiting, 0.45) },
  permT: { fontSize: 9, lineHeight: 10, color: c.brandA, fontWeight: "600" },
  permTWarn: { color: c.waiting },
  // #36 四选一底部面板
  permScrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(8,12,18,0.38)" },
  permSheet: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 14,
  },
  permGrab: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: c.line, marginTop: 4, marginBottom: 8 },
  permTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  permTitle: { color: c.text, fontSize: 13, fontWeight: "600" },
  permX: { color: c.faint, fontSize: 14, lineHeight: 18 },
  permRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 9, paddingHorizontal: 8, borderRadius: 10, overflow: "hidden",
  },
  // 当前项：整行选中底 + 右缘 ✓（不靠游离符号——设计自审结论）
  permRowCur: { backgroundColor: c.tintStrong },
  // 跳过行武装态（首击待确认）：红 tint 选中，视觉从属底部确认区
  permRowArm: { backgroundColor: withA(c.waiting, 0.08) },
  permNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  permName: { color: c.text, fontSize: 13, fontWeight: "600", lineHeight: 17 },
  permBadge: {
    height: 15, paddingHorizontal: 4, borderRadius: 4, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.waiting, 0.1), borderWidth: 1, borderColor: withA(c.waiting, 0.45),
  },
  permBadgeT: { color: c.waiting, fontSize: 9, lineHeight: 11, fontWeight: "600" },
  permDesc: { color: c.dim, fontSize: 10, lineHeight: 13, marginTop: 1 },
  permCheck: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  // W-PORT-B P0-1：模型 chip（R2 右锚幽灵胶囊）与 ModelSheet 内部件
  // W-FB66REST ④（用户 1026 test.66「太高了有点突兀」）：22→18 降高——与 r3 chip
  // 18px 同族视觉档（桌面 FB66C ⑫ 定档；手机 r3 teamChip 同 ~17-18 撑高），横内距
  // 收 8→7、lineHeight 12→11 同步收；hitSlop 8 保留触达面积不缩
  modelChip: {
    height: 18, paddingHorizontal: 7, borderRadius: 9, justifyContent: "center",
    borderWidth: 1, borderColor: c.line,
    maxWidth: 120, marginRight: 3,
  },
  modelChipT: { color: c.dim, fontSize: 10, lineHeight: 11, fontWeight: "600" },
  modelRowT: { flex: 1, minWidth: 0, color: c.text, fontSize: 12.5, lineHeight: 16 },
  modelEmpty: { color: c.faint, fontSize: 10.5, lineHeight: 14, paddingVertical: 8 },
  modelCustomRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8,
    borderWidth: 1, borderColor: c.line, borderRadius: 10, backgroundColor: c.bg,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  modelCustomInput: { flex: 1, color: c.text, fontSize: 12.5, paddingVertical: 7, paddingHorizontal: 0 },
  modelApplyBtn: {
    backgroundColor: withA(c.brandA, 0.16), borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 6, alignItems: "center", justifyContent: "center",
  },
  modelApplyT: { color: c.brandA, fontSize: 11.5, fontWeight: "700" },
  // 危险确认区：左缘 3px 红从属条（视觉上从属跳过行）+ 整宽双按钮
  permConfirm: {
    backgroundColor: withA(c.waiting, 0.06), borderWidth: 1, borderColor: withA(c.waiting, 0.3),
    borderLeftWidth: 3, borderLeftColor: withA(c.waiting, 0.55),
    borderRadius: 10, padding: 10, marginTop: 6,
  },
  permConfirmT: { color: c.waiting, fontSize: 10.5, lineHeight: 14 },
  permConfirmBtns: { flexDirection: "row", gap: 8, marginTop: 8 },
  permCancel: {
    flex: 1, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  permCancelT: { color: c.dim, fontSize: 12, fontWeight: "600" },
  permGo: {
    flex: 1, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: c.waiting, overflow: "hidden",
  },
  permGoT: { color: "#fff", fontSize: 12, fontWeight: "600" },
  // 任务/定时/统计视图容器
  viewCol: { flex: 1 },
  // todo 视图头：标题 + 进度条 + 手动刷新（原折叠面板头部去 caret）
  todoHead: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 4, paddingHorizontal: 14 },
  todoHeadT: { color: c.dim, fontSize: 11.5, fontWeight: "600" },
  todoBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: c.tintSoft, overflow: "hidden" },
  todoBarFill: { height: 4, borderRadius: 2, backgroundColor: c.done },
  todoRefresh: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  todoRefreshT: { color: c.dim, fontSize: 14, lineHeight: 16 },
  todoScrollWrap: { position: "relative", flex: 1 },
  todoFootHint: { alignItems: "center", paddingVertical: 10 },
  todoFootHintT: { color: c.faint, fontSize: 12 },
  todoThumb: { position: "absolute", right: 1, top: 2, width: 3, borderRadius: 2, backgroundColor: withA(c.text, 0.28) },
  // #376 cron 展开态原文/prompt
  cronRaw: { color: c.faint, fontSize: 10.5, fontFamily: "monospace", marginTop: 2 },
  cronPrompt: { color: c.dim, fontSize: 12, lineHeight: 17, marginTop: 5 },
  // 定时任务视图行（原 cronScroll/cronBox 折叠面板平铺化）
  cronRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 6, marginTop: 4, paddingHorizontal: 6, borderRadius: 6 },
  cronMark: { color: c.working, fontSize: 12, width: 16, textAlign: "center", lineHeight: 17 },
  cronName: { color: c.text, fontSize: 12.5, lineHeight: 17 },
  cronMeta: { color: c.faint, fontSize: 11, lineHeight: 15, marginTop: 1, fontVariant: ["tabular-nums"] },
  // #35 输出物：汇总行 / 分组头 / 扩展名 chip / 角标 / 详情 sheet（视觉审查口径：
  // 辅助信息统一 ≥10.5px 且避开 --faint 级低对比；亮暗主题走 c.* 变量自适应）
  artSum: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2, paddingBottom: 8 },
  artSumN: { color: c.text, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  artTrunc: { color: c.working, fontSize: 11, marginTop: -4, marginBottom: 4 },
  artGt: { fontSize: 11, fontWeight: "700", marginTop: 10, marginBottom: 2 },
  artChip: { minWidth: 28, height: 20, borderRadius: 5, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, marginTop: 1 },
  artChipT: { fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  artNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  artTag: { fontSize: 10, lineHeight: 13, borderWidth: 1, borderColor: c.line, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  artFoot: { color: c.faint, fontSize: 10.5, textAlign: "center", paddingVertical: 16 },
  // #222 文件夹分组：文件夹头行（垂直居中 + 叶子名加粗）/ 行尾 ⋯ 菜单钮（与文件行
  // 同款，点按弹文件夹 sheet，2026-10-02 用户拍板统一）/ 展开子列（左缘引导线 +
  // 缩进，子行紧凑无分隔线）
  artFolRow: { alignItems: "center" },
  artFolName: { color: c.text, fontSize: 12.5, fontWeight: "700", lineHeight: 17 },
  artDots: { color: c.faint, fontSize: 15, lineHeight: 18, paddingHorizontal: 2 },
  artKids: { marginLeft: 13, borderLeftWidth: 1, borderLeftColor: c.line, paddingLeft: 8, marginVertical: 2 },
  // #83 sheet 重设计样式（仅 ArtSheet 使用，零共享）：字号阶梯 14 标题 > 13 CTA >
  // 12 次级按钮 > 11 元信息/路径 mono > 10 caption/相对路径 > 9 chip
  artTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  artTitle: { color: c.text, fontSize: 14, fontWeight: "600", lineHeight: 19, flex: 1 },
  artMeta: { color: c.dim, fontSize: 11, lineHeight: 15, marginTop: 6, fontVariant: ["tabular-nums"] },
  artPri: { height: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: c.brandA, overflow: "hidden", marginTop: 12 },
  artPriT: { color: "#fff", fontSize: 13, fontWeight: "600" },
  // 已删除态：ghost 状态说明（panel2 底 + error 描边 + 红字短句），不是可点 CTA
  artPriDead: { backgroundColor: c.panel2, borderWidth: 1, borderColor: withA(c.error, 0.3) },
  artPriDeadT: { color: c.error },
  artCap: { color: c.faint, fontSize: 10, lineHeight: 13, textAlign: "center", marginTop: 6 },
  artErr: { color: c.error, fontSize: 11, lineHeight: 14, textAlign: "center", marginTop: 6 },
  // 路径盒（容器）：panel2 内陷 + 细描边；内文 11px mono（显示串已经 brkPath 断词）
  artPath: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: c.panel2, marginTop: 12 },
  artPathT: { color: c.text, fontSize: 11, fontFamily: "monospace", lineHeight: 16 },
  artRel: { color: c.dim, fontSize: 10, fontFamily: "monospace", lineHeight: 14, marginTop: 4 },
  // 次级按钮行：panel2 底 + line 描边（permCancel 同语言），材质差让位 CTA
  artSecRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  artSec: { flex: 1, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
  artSecT: { color: c.dim, fontSize: 12, fontWeight: "600" },
  // #79 输出物预览全屏层（ArtView）
  avHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.line, gap: 10 },
  avName: { color: c.text, fontSize: 14, fontWeight: "600", flex: 1 },
  avSize: { color: c.faint, fontSize: 11 },
  avClose: { color: c.dim, fontSize: 18, paddingHorizontal: 6 },
  avAct: { color: c.dim, fontSize: 11.5, fontWeight: "600", paddingHorizontal: 4 },
  avErr: { color: c.error, fontSize: 11, lineHeight: 15, paddingHorizontal: 14, paddingVertical: 5, backgroundColor: withA(c.error, 0.06) },
  avTxt: { fontFamily: "monospace", fontSize: 11.5, lineHeight: 17.5, color: c.text },
  avCard: { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, borderRadius: 14, padding: 18, alignItems: "center", gap: 10, alignSelf: "stretch" },
  avHint: { color: c.faint, fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 14 },
  todoSec: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 9, marginBottom: 1 },
  todoSecLine: { flex: 1, height: 1, backgroundColor: c.line },
  todoSecT: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5 },
  todoRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 5, borderTopWidth: 1, borderTopColor: c.line, marginTop: 5 },
  // #374 拖动态：浮起阴影 + 品牌描边 + 压过同行
  todoRowDrag: {
    backgroundColor: c.panel, borderRadius: 10, borderWidth: 1, borderColor: withA(c.brandA, 0.5),
    paddingHorizontal: 8, elevation: 6, zIndex: 9,
  },
  todoDragT: { color: c.faint, fontSize: 12, lineHeight: 17, paddingLeft: 2 },
  todoFlash: { backgroundColor: withA(c.brandA, 0.32), borderRadius: 8, borderWidth: 1, borderColor: withA(c.brandA, 0.55) },
  todoScroll: { maxHeight: 400, flexGrow: 0 },
  todoMark: { color: c.faint, fontSize: 12, width: 16, textAlign: "center", lineHeight: 17 },
  // #410 处理中自绘 ◐（仅样式）：外径 11dp=○ 字形视觉直径，描边 1.5 同 ○ 笔画；
  // 占位仍 16dp 宽列居中、marginTop 3 在 17dp 行高里垂直居中，位置不变
  todoMarkRun: { width: 16, alignItems: "center", marginTop: 3 },
  todoMarkRunC: { width: 11, height: 11, borderRadius: 5.5, borderWidth: 1.5, borderColor: c.working, overflow: "hidden" },
  todoMarkRunF: { width: "50%", height: "100%", backgroundColor: c.working },
  todoT: { flex: 1, color: c.text, fontSize: 12.5, lineHeight: 17 },
  // #39a subAgent 标注 chip：小号弱色，浅底圆角贴行内（Text 行内嵌套，无独立边框）
  // #79 用户反馈：角标更像圆角矩形（纵 padding 提到 2）+ 与任务末字拉开（marginLeft 9）
  todoSubTag: {
    fontSize: 9, color: c.faint, backgroundColor: withA(c.dim, 0.13),
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 7, overflow: "hidden",
    marginLeft: 9, letterSpacing: 0.3, lineHeight: 14,
  },
  todoDel: { width: 24, height: 22, alignItems: "center", justifyContent: "center" },
  todoDelT: { color: c.faint, fontSize: 12 },
  // 子 Agent 状态块（#142 重设计 → #186 并入状态盒）：liveRow 盒内的续行块（无底无边，
  // 贴主状态行下方）；标题行即折叠开关（自包含触区）；#186 紧凑化——字号 agT 12→11、
  // agAct/agHeadT 11→10.5、agTime 11→10，条目行 paddingVertical 3→2、gap 7→6，
  // 标题行 paddingVertical 4→3；间距节奏统一 18（见 liveRow 注释的排队消息路径说明）
  agBox: { marginTop: 2 },
  agHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3, paddingLeft: 1, alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" },
  agHeadT: { color: c.faint, fontSize: 10.5, letterSpacing: 0.4 },
  // 运行中标记：走帧星（SPIN_FRAMES 随 agTick 1s 换帧，#148 低频步进）
  agSpin: { fontSize: 10.5, fontWeight: "700", lineHeight: 13 },
  agDone: { color: c.done, fontSize: 10.5, lineHeight: 13 },
  // 条目行相对标题缩进（09-24 二轮：标题与具体项要有缩进层级）：paddingLeft 13 对齐
  // 标题行 paddingLeft 1，有效视觉缩进 12
  agRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, paddingLeft: 13 },
  agT: { flex: 1, fontSize: 11 },
  agAct: { flex: 1, fontSize: 10.5 }, // #103 活性：与描述平分行宽，超长省略（HUD 风格当前动作）
  agTime: { fontSize: 10, fontVariant: ["tabular-nums"] },
  // #13 巡检：超 4 条的溢出提示（原 slice(-4) 静默截断）
  agMore: { color: c.faint, fontSize: 10.5, paddingVertical: 2, paddingLeft: 13 },
  histnote: { color: c.faint, fontSize: 11, textAlign: "center", marginBottom: 10 },
  trUser: {
    alignSelf: "flex-end", maxWidth: "85%", marginBottom: 10,
    backgroundColor: withA(c.working, 0.10), borderWidth: 1, borderColor: withA(c.working, 0.25),
    borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8,
  },
  // 件五 pending 气泡（trUser 同族：右对齐圆角右上台角；降透明度 + 虚线感描边区分
  // 正式态；失败态 error 描边可点重试）
  peBubble: {
    alignSelf: "flex-end", maxWidth: "85%", marginBottom: 10, opacity: 0.72,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: withA(c.working, 0.35),
    borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8, gap: 4,
  },
  peBubbleFail: { borderColor: withA(c.error, 0.5), opacity: 1 },
  peText: { color: c.text, fontSize: 14, lineHeight: 20 },
  peState: { fontSize: 10.5, textAlign: "right" },
  trUserText: { color: c.text, fontSize: 14, lineHeight: 20 },
  trUserTime: { color: c.faint, fontSize: 10, textAlign: "right", marginTop: 3, fontVariant: ["tabular-nums"] },
  // FB14 气泡附图缩略行：气泡内文字下方（64 方图，圆角同发送侧 imgThumb；加载占位
  // working tint 微光；点按全屏黑底 contain 预览，点任意处关闭）
  ubImgs: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  ubImg: { width: 64, height: 64, borderRadius: 10 },
  ubImgWait: {
    width: 64, height: 64, borderRadius: 10,
    backgroundColor: withA(c.working, 0.12), borderWidth: 1, borderColor: withA(c.working, 0.22),
  },
  ubPreviewWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  ubPreviewImg: { flex: 1 },
  trMsg: { marginBottom: 10 },
  trMsgTime: { color: c.faint, fontSize: 10, marginBottom: 2, fontVariant: ["tabular-nums"] },
  daySep: { color: c.faint, fontSize: 10.5, textAlign: "center", marginVertical: 8, fontVariant: ["tabular-nums"] },
  trThink: {
    marginBottom: 8, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, overflow: "hidden",
  },
  trThinkHead: { color: c.faint, fontSize: 11.5, fontWeight: "600" },
  trThinkT: { color: c.dim, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  // W-AUTOMSG #194 + 居中精修（Leader 追加件）：完全居中系统提示形态——收起=水平
  // 居中一行小灰字（无气泡无底色不占左右对齐位，视觉同微信时间戳行）；展开=居中
  // 无底色弱化块（限宽 85%、dim 色、无边框）。alignSelf stretch 让子级自身居中
  trAuto: { marginBottom: 6, alignItems: "center" },
  trAutoHead: { color: c.faint, fontSize: 11, lineHeight: 16, textAlign: "center" },
  trAutoText: { color: c.dim, fontSize: 11.5, lineHeight: 17, marginTop: 4, width: "85%", textAlign: "left" },
  trText: { color: c.text, fontSize: 14, lineHeight: 21 },
  trTool: {
    flexDirection: "row", gap: 8, alignItems: "flex-start", marginBottom: 8,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7,
  },
  trToolName: { color: c.brandA, fontSize: 11.5, fontWeight: "700" },
  trToolText: { color: c.dim, fontSize: 11.5, flex: 1 },
  trDetail: {
    fontFamily: "monospace", color: c.dim, fontSize: 10.5, lineHeight: 15.5,
    marginTop: 6,
  },
  trDiffWrap: { paddingLeft: 12 },
  diffBox: {
    marginTop: 4, borderRadius: 8, borderWidth: 1, borderColor: c.line,
    paddingVertical: 5, paddingHorizontal: 8, overflow: "hidden",
  },
  diffHunk: { fontFamily: "monospace", fontSize: 10, lineHeight: 15, color: c.working, backgroundColor: withA(c.working, 0.07) },
  diffAdd: { fontFamily: "monospace", fontSize: 10, lineHeight: 15, color: c.done, backgroundColor: withA(c.done, 0.08) },
  diffDel: { fontFamily: "monospace", fontSize: 10, lineHeight: 15, color: c.waiting, backgroundColor: withA(c.waiting, 0.07) },
  diffCtx: { fontFamily: "monospace", fontSize: 10, lineHeight: 15, color: c.faint },
  trResult: { color: c.faint, fontSize: 11.5, marginBottom: 8 },
  trSystem: { color: c.faint, fontSize: 11, textAlign: "center", marginBottom: 8 },
  tlExpand: { color: c.brandA, fontSize: 11, marginTop: 3 },
  empty: { color: c.faint, textAlign: "center", paddingVertical: 40, fontSize: 13 },
  waitBanner: {
    marginHorizontal: 8, marginBottom: 6,
    borderRadius: 14, borderWidth: 1, borderColor: c.line,
    backgroundColor: c.panel, padding: 12,
  },
  /* 005 #166 双态容器：提问态中性底+品牌描边（提问≠风险）；审批态黄 tint 警示
    （--wait-bg/--wait-line 双主题折中 alpha 直译） */
  waitCardAsk: { backgroundColor: c.panel, borderColor: c.brandA },
  waitCardApprove: { backgroundColor: withA(c.working, 0.09), borderColor: withA(c.working, 0.45) },
  /* 005 #166 手机仅浏览：作答/决议控件压灰 + 底部引导条（--surface2 底 dim 字） */
  roDim: { opacity: 0.5 },
  waitRO: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.panel2, alignItems: "center" },
  waitROT: { color: c.dim, fontSize: 11, textAlign: "center" },
  /* 提问态 AskBanner 专用（审批态标题已并入 waitHead 行；005 双态随卡转品牌色） */
  waitT: { color: c.brandA, fontWeight: "700", fontSize: 13, marginBottom: 6 },
  waitHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 9 },
  waitDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.working },
  waitTitle: { color: c.working, fontWeight: "700", fontSize: 13, flexShrink: 1 },
  waitChip: { marginLeft: "auto", fontFamily: "monospace", fontSize: 10.5, fontWeight: "700", color: c.working, backgroundColor: withA(c.working, 0.12), borderWidth: 1, borderColor: withA(c.working, 0.3), borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden" as const },
  waitPs: { color: c.done, fontWeight: "700" },
  waitCmd: { fontFamily: "monospace", fontSize: 12, lineHeight: 17, color: c.text, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 9, marginBottom: 11 },
  wbtns: { flexDirection: "row", gap: 8 },
  btnAllow: {
    flex: 1.25, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: c.done,
  },
  btnAllowT: { color: c.onDone, fontWeight: "700", fontSize: 14.5 },
  /* 005 #166 拒绝/允许并记住=次级描边档（中性 lineStrong 描边——允许是唯一高亮钮） */
  btnReject: {
    flex: 1, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: "transparent", borderWidth: 1, borderColor: c.lineStrong,
  },
  btnRejectT: { color: c.text, fontWeight: "600", fontSize: 13 },
  btnRemember: {
    flex: 1.15, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: "transparent", borderWidth: 1, borderColor: c.lineStrong,
  },
  btnRememberT: { color: c.text, fontWeight: "600", fontSize: 13 },
  /* #212 范围确认条说明行 */
  rmLabel: { color: c.faint, fontSize: 11.5, lineHeight: 16, marginBottom: 9 },
  rmLabelB: { color: c.dim, fontWeight: "600" },
  // AskUserQuestion 作答横幅（#190 stepper 指示器行）
  askSteps: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 },
  askCount: { color: c.dim, fontSize: 11, marginRight: 2 },
  askDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: c.faint },
  askDotDone: { backgroundColor: c.brandA, borderColor: c.brandA },
  askDotCur: { borderColor: c.brandA, borderWidth: 2, transform: [{ scale: 1.25 }] },
  askQ: { color: c.text, fontSize: 13, fontWeight: "600", marginBottom: 7 },
  askOpts: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginBottom: 11 },
  askChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
  },
  askChipOn: { backgroundColor: withA(c.brandA, 0.14), borderColor: withA(c.brandA, 0.55) },
  askChipT: { color: c.text, fontSize: 13 },
  askChipOnT: { color: c.brandA, fontWeight: "600" },
  askSubmit: {
    height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.done, 0.14), borderWidth: 1, borderColor: withA(c.done, 0.35),
    marginBottom: 8,
  },
  askSubmitT: { color: c.done, fontWeight: "600", fontSize: 14 },
  askFreeRow: { flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 8 },
  askFree: {
    flex: 1, minHeight: 40, borderRadius: 12,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    paddingHorizontal: 12, color: c.text, fontSize: 14, paddingVertical: 9,
  },
  askFreeBtn: {
    height: 40, borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.brandA, 0.16), borderWidth: 1, borderColor: withA(c.brandA, 0.45),
  },
  askFreeBtnT: { color: c.brandA, fontWeight: "600", fontSize: 13.5 },
  askSkip: { color: c.faint, fontSize: 11.5, textAlign: "center" },
  opRipple: { borderRadius: 13, overflow: "hidden" },
  // 待发附件（图片缩略图 + #62 文件 chip 同条）：可删除 + 相册/文件按钮
  imgRow: {
    flexDirection: "row", gap: 8, backgroundColor: c.overlay,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 12, paddingTop: 9,
  },
  // 多附件换行（chip 名字长，单行会溢出）
  imgRowWrap: { flexWrap: "wrap", rowGap: 8 },
  imgCell: { width: 52, height: 52 },
  imgThumb: { width: 52, height: 52, borderRadius: 10 },
  // #62 待发文件 chip：文档图标 + 文件名 + 删除，与缩略图同视觉语言
  fileChip: {
    flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 230, height: 52,
    borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.panel,
    paddingHorizontal: 10,
  },
  fileName: { color: c.dim, fontSize: 12, flexShrink: 1 },
  fileDel: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  fileDelT: { color: c.faint, fontSize: 14, lineHeight: 16, marginTop: -1 },
  imgDel: {
    position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    alignItems: "center", justifyContent: "center",
  },
  imgDelT: { color: c.dim, fontSize: 13, lineHeight: 15, marginTop: -1 },
  // #68② 图标按钮：无底无框纯线条（原 44 宽 panel2+边框盒），高保 44 对齐输入框。
  // 晨间反馈再收紧：38→30 宽（图标 21→18），富余宽度全让输入框，触达靠 hitSlop
  imgBtn: {
    width: 30, height: 44, alignItems: "center", justifyContent: "center",
  },
  imgBtnT: { fontSize: 17 },
  micOn: { borderRadius: 13, backgroundColor: c.tintStrong },
  voiceLive: {
    paddingHorizontal: 14, paddingVertical: 5,
    color: c.brandA, fontSize: 12, backgroundColor: c.overlay,
  },
  queuedHint: {
    paddingHorizontal: 14, paddingVertical: 5,
    color: c.dim, fontSize: 11, backgroundColor: c.overlay,
  },
  // #68② 输入区瘦身：图标按钮去底去框（38 宽纯线条，触达靠 hitSlop）、发送去框收窄、
  // 行距 9→7——富余宽度全部让给输入框
  cmdbar: {
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.overlay, borderTopWidth: 1, borderTopColor: c.line,
    flexDirection: "row", gap: 7, alignItems: "flex-end",
  },
  // Slash 联想面板：输入 / 时悬于命令条上方，限高可滚； marginBottom 0 贴合命令条不透字
  slashBox: {
    marginHorizontal: 12, marginBottom: 0, maxHeight: 224,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 13,
    overflow: "hidden",
  },
  slashRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 9,
  },
  slashName: { color: c.text, fontSize: 13, fontWeight: "600" },
  slashDesc: { flex: 1, color: c.faint, fontSize: 11.5 },
  slashSrc: {
    fontSize: 9.5, color: c.dim, borderWidth: 1, borderColor: c.line,
    borderRadius: 7, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden",
  },
  slashEmpty: { color: c.faint, fontSize: 12, paddingHorizontal: 12, paddingVertical: 10 },
  // #68 返工（test.7 装机反馈「多行仍不抬高」根因）：删 flex:1——套 <View flex:1>
  // 包裹层后它变成纵轴 flexGrow（flexBasis 0 压掉显式 height），wrap-content 容器
  // 无空间可长，高度恒钉在 minHeight 44（两种增高方案都失灵的公共原因）。宽度由
  // 包裹层默认 alignItems:stretch 拉满，无需自带 flex。maxHeight 110→150 对齐
  // inputH 钳制（cd7509c 只改了钳制漏了样式）
  input: {
    minHeight: 44, maxHeight: 150, borderRadius: 13,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    paddingHorizontal: 14, paddingVertical: 11, color: c.text, fontSize: 15,
    textAlignVertical: "top",
  },
  // 发送按钮：两主题同规则（#48）——theme.sendBg/sendFg 品牌橙 ➤；#68② 去边框
  // 收窄（44→40、字 17→18），桌面端 #sendBtn 同步对齐
  sendBtn: {
    width: 40, height: 44, borderRadius: 13, backgroundColor: c.sendBg,
    alignItems: "center", justifyContent: "center",
  },
  sendT: { color: c.sendFg, fontSize: 18, lineHeight: 21, marginLeft: 2 },
  // 内容长按菜单（#249）：与 md.tsx 链接浮窗同视觉语言
  menuScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 28 },
  menuCard: { width: "100%", maxWidth: 340, backgroundColor: c.panel, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 12 },
  menuBtns: { flexDirection: "row", gap: 10 },
  menuBtn: {
    flex: 1, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  menuBtnPri: { backgroundColor: c.brandA, borderColor: "transparent" },
  menuBtnT: { color: c.dim, fontSize: 14, fontWeight: "600" },
  menuBtnPriT: { color: "#fff", fontSize: 14, fontWeight: "600" },
  // #340 任务明细气泡：锚点定位容器 + 指向 #NNN 的尾巴（旋转小方块，边框与卡相接）
  tpWrap: { position: "absolute" },
  tpTail: {
    position: "absolute", width: 12, height: 12,
    backgroundColor: c.panel, borderColor: c.line,
    transform: [{ rotate: "45deg" }], borderRadius: 2,
  },
  tpHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  tpMark: { fontSize: 17, fontWeight: "700" },
  // #410 浮窗头部处理中自绘 ◐：外径 14dp=tpMark 17sp 下 ○ 的视觉直径（12sp 时 11dp 等比放大），描边 2
  tpMarkRun: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: c.working, overflow: "hidden" },
  tpMarkRunF: { width: "50%", height: "100%", backgroundColor: c.working },
  tpNo: { color: c.brandA, fontSize: 15, fontWeight: "700" },
  tpStatus: { fontSize: 12.5, flex: 1, textAlign: "right" },
  tpContent: { color: c.text, fontSize: 14, lineHeight: 21 },
  tpActive: { color: c.working, fontSize: 12.5, marginTop: 6 },
  tpTime: { color: c.faint, fontSize: 11.5, marginTop: 8, alignSelf: "flex-end" },
  tpFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  tpHint: { color: c.faint, fontSize: 11.5 },
  tpLink: { color: c.brandA, fontSize: 12.5, fontWeight: "600", paddingVertical: 4, paddingHorizontal: 8, borderRadius: 9 },
});
