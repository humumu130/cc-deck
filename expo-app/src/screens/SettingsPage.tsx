// 设置域 tab 页（W-EXPOLISH 件三：三域占位页内容化；原 SettingsDrawer 抽屉整体
// 迁宿主退役，git mv 保历史）。分区收纳连接（服务器列表）、配对、记住的规则、
// 权限、显示与关于——内容几何零改动，抽屉壳（scrim/侧滑/动画/225px 窄板）退役：
// 设置升独立 tab 后单入口（会话页左上角 logo = 切设置 tab），原「左缘右滑呼出」
// 手势随抽屉退役（设置已有常驻 tab 入口）。左上角 logo 呼出语义不变，落点改 tab。
//
// W-MSETSIG 整体重设计（2026-10-12，用户判「丑陋·旧侧边栏直搬」）：移动优先信息
// 架构——五分组卡（连接管理/显示与字号/Agent 引擎/通用/关于，任务书拍板），常用
// 置顶（连接管理+显示）、低频沉底（关于/反馈）；视觉对齐 0.7 壳语言（web-console
// index-005.html + specs/005-prototype-a.html 手机设置节）：域标题头部（005
// mobile-head）、005 settings-row 行语言（IconTile 图标方格 28×28 + 双行文字 +
// 右槽）、GroupCard 圆角卡节（panel+hairline 行分隔）、行高 ≥48（44px+ 触达）。
// 交互升级：服务器删除两步确认（arm 语言，规则删除/设备踢出同款）；显示组默认
// 展开（定位常用组）。所有既有设置项全保留（重组织+重视觉，不砍功能）：服务器
// 管理/扫码/配对码/设备管理/规则/权限/过程消息三档/空闲变灰/回车发送/雇员独立家
// /经验库/版本/反馈/保活豁免/图例弹窗——分组归位：保活+回车发送入通用，雇员独立
// 家+经验库入 Agent 引擎（条件组，旧 relay 无字段整组不显）。
//
// W-MSET3 正经立项深度重设计（2026-10-13，[正经立项] 批）：三路思考（A 极简/B 信
// 息丰富/C 任务流）定案 = C 骨架 × A 收敛——「连接为王，偏好归边」。六件：
// ① 头部副题实时化：静态目录文案 → 实时连接摘要（N 台电脑 · M 在线 / 未连接）；
// ② 新增活动连接状态卡（页面首卡）：当前活动源 + 四态灯 + 通道词，在线静态展示
//    /离线点按即连/未配置点按进 setup（吸收原「未配置」引导行与 connCard 样式）；
// ③ 偏好组合并：原「显示与字号」+「通用」两组 → 「偏好」一组四行（过程消息/空
//    闲置灰/回车发送/后台保活），dispCollapsed 折叠机制退役（偏好恒展开，组头折
//    叠钮删除）；「显示与字号」名不符实组名随之消解；
// ④ 配对码按需化：常驻自动领码 + 1Hz 常驻时钟 → 行点击展开才领码/展示/续领/跑钟，
//    收起态零流量零定时器（原 pairGenMini「生成配对码」钮退役，行点击即领）；
// ⑤ 图标语言统一 SVG：?（图例）/▾▸（折叠）/ⓘ（帮助）/＋（添加）/↻（刷新）字符
//    图标全数退役，换 stroke 1.8 线图标（与 IconTile/PencilIcon 同语言）；
// ⑥ 组头计数明确化：连接管理折叠态「· N」→「· N 台」。
// 不动面（R7 口径继承）：服务器行视觉几何、六弹层（关于/图例/设备/经验库/扫码/
// 导入）、规则/权限子节、Agent 引擎条件组、删码逻辑（store/protocol 零触碰）。
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Animated, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark, PencilIcon } from "../brand";
import { setProcessFont, useProcessFont, getIdleDimMin, setIdleDimMin, setEnterSend, useEnterSend, type ProcessFont } from "../display-settings";
import { checkUpdate, announceUpdate, VERSION_NOTES, VERSION_DATE, releasePageUrl, type VersionNote } from "../updates";
import { store, useRelay, type ServerEntry, type SourceStatus, isLanUrl } from "../store";
import type { AllowRule, ExperienceEntry, PairedDeviceInfo } from "../protocol";
import { ExpLibraryModal } from "./OrgZone";
import { PageHead, useBellBadge } from "./page-head";
import { SourceSwitch } from "./source-switch";
import { setListDensity, useListDensity, type ListDensity } from "../display-settings";
import { connStateNote, connStateTone, pairErrNote, peerKindLabel, peerRelTime } from "../protocol";
import { PERM_CAP_STATE_LABEL, permissionModesText, permissionSummariesOf, type PermCapState } from "../permission";
import { fgSupported } from "../notify";
import KeepAliveCard from "../KeepAliveCard";
import Svg, { Path, Rect } from "react-native-svg";
import { withA, type ThemeColors } from "../theme";
import ScanScreen, { routeScanResult, type ScanResult } from "./ScanScreen";
import ImportPicker, { type ImportTarget } from "./ImportPicker";

// #100 默认名口径（与 store 建连时一致）：host 部分——e.name 等于它=用户没改过名
function defaultHostName(e: { wsUrl: string }): string {
  try { return new URL(e.wsUrl).host; } catch { return e.wsUrl; }
}
const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

// 版本号读原生 versionName（build.gradle），杜绝手写硬编码再漏更
const APP_VER = "v" + (Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "-");
// 通道标识（三通道全覆盖）：版本号后缀即通道来源——
//   snap → 快照版（CI 对 -snap tag 烙 tag 名进 versionName，如 0.4.23-snap.3）
//   test → 测试版（本地打包测试惯例：版本号带 -test 后缀）
//   其他后缀（beta/alpha/rc 等）→ 预发布兜底；干净版本号 = 正式版，无角标
const VER_SUFFIX = (Constants.nativeApplicationVersion ?? "").replace(/^v?[\d.]+/, "");
const CHANNEL_TAG: string | null = /snap/i.test(VER_SUFFIX)
  ? "快照版"
  : /test/i.test(VER_SUFFIX)
    ? "测试版"
    : VER_SUFFIX
      ? "预发布"
      : null;

// #313 反馈入口：关于弹窗「✎ 反馈」跳 GitHub Issues
const FEEDBACK_URL = "https://github.com/humumu130/cc-deck/issues";

// 连接状态卡副行的源状态文案（store connState → 中文）
const SRC_STATE_TEXT: Record<SourceStatus["state"], string> = {
  idle: "未连接",
  connecting: "连接中",
  online: "在线",
  reconnecting: "重连中",
  offline: "已断开",
  unpaired: "未配对",
};

const FONT_OPTS: { k: ProcessFont; label: string }[] = [
  { k: "normal", label: "标准" },
  { k: "compact", label: "紧凑" },
  { k: "hidden", label: "隐藏" },
];

// #337 服务器色点=身份色：登记后固定，不随选中/连接状态变——选中由 srvRowOn 外侧
// 亮边框表达。#356 哈希取色会撞色（我的电脑/Mac 同黄）——改同网页 srcColorByKey：
// 按当前服务器 id 集合稳定排序分配色板序号。
// #102 治理⑦：旧 7 色池含 #D97757（占品牌橙）、#2BD98F（撞 DONE 绿）、#FBBF24
// （撞 WORKING 黄），违反 #98 三条拍板——对齐 SRC_COLORS 五色池（web 侧同概念池
// 已按 #98 清过），源数 >5 取模循环复用（现实源数 ≤5 必不重）
const SRV_COLORS = ["#2FBEDA", "#5C94F5", "#665AD8", "#B886DF", "#CD51C8"] as const;
let srvColorOrder: string[] = [];
let srvColorMap = new Map<string, string>();
const rebuildSrvColors = (ids: string[]) => {
  const sorted = [...ids].sort();
  if (sorted.length === srvColorOrder.length && sorted.every((v, i) => v === srvColorOrder[i])) return;
  srvColorOrder = sorted;
  srvColorMap = new Map(sorted.map((id, i) => [id, SRV_COLORS[i % SRV_COLORS.length]]));
};

// #353 拨杆档位选择器（通用）：一条胶囊轨道 + 带阴影滑块，spring 弹拨到选中档；
// 点任意档位标签即拨过去（现仅过程消息使用；列表布局三档已迁列表页统计行胶囊）
function Lever<T extends string>({ options, value, onChange }: {
  options: { k: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const idx = Math.max(0, options.findIndex((o) => o.k === value));
  // #37 同行化后拨杆整体缩小：174→118 宽、34→24 高（与「过程消息」标题同一行，
  // 侧边栏纵向空间紧张——用户点单）
  const [w] = useState(118);
  const seg = w / options.length;
  const x = useRef(new Animated.Value(idx * seg)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: idx * seg, velocity: 4, friction: 9, useNativeDriver: true }).start();
  }, [idx, x, seg]);
  return (
    <View style={[d.leverTrack, { width: w }]} onLayout={(e) => { const nw = e.nativeEvent.layout.width; if (nw > 0 && Math.abs(nw - w) < 1) return; }}>
      <Animated.View style={[d.leverThumb, { width: seg - 6, transform: [{ translateX: x.interpolate({ inputRange: [0, seg * (options.length - 1)], outputRange: [3, seg * (options.length - 1) + 3] }) }] }]} />
      {options.map((o, i) => (
        <Pressable key={o.k} style={d.leverOpt} onPress={() => onChange(o.k)} hitSlop={{ top: 4, bottom: 4 }}>
          <Text style={[d.leverT, i === idx && d.leverTOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// #130 行前缀 12px 线性图标 → W-MSETSIG 升级为 IconTile 图标方格（28×28 软底
// + 15px stroke 1.8 线图标），LineIcon 裸图标组件随之退役
const ICON_MSG = "M4 5h16v10H9l-4 4z"; // 消息泡（过程消息）
const ICON_GRID = "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"; /* W-HEAD6 C：密度行图标 */
const ICON_MOON = "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"; // 半月（空闲变灰）
const ICON_ENTER = "M20 4v6a3 3 0 0 1-3 3H5m4-4-4 4 4 4"; // 回车箭头（回车发送）
const ICON_BOX = "M6 6h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 6V4h6v2M12 10v4"; // 收纳箱（版本/关于）
const ICON_HOME = "M3 11 12 4l9 7M5 10v10h14V10"; // 小屋（#17 第二批 雇员独立家）
const ICON_PHONE = "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10.5 18.5h3"; // 手机（0.7 批 2 设备列表入口）
const ICON_BOOK = "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"; // 书本（W-EXPOLISH 件五 经验库入口）
// W-MSETSIG 重设计增补图标（连接管理/规则/权限组）
const ICON_QR = "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 14H20v2.5h-2.5zM14 17.5h2.5V20H14zM17.5 17.5H20V20h-2.5z"; // 二维码（网页端配对）
const ICON_SHIELD = "M12 3l7 3v5c0 4.6-3 7.7-7 9.2C8 18.7 5 15.6 5 11V6z"; // 盾（记住的规则）
const ICON_LOCK = "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z"; // 锁（权限）
const ICON_PENCIL = "M17 3l4 4L8 20l-5 1 1-5z"; // 铅笔（反馈，PencilIcon 同语义线稿）
// W-MSET3 ⑤ 字符图标退役：?/▾▸/ⓘ/＋/↻ 换 stroke 线图标（与 IconTile 同语言）
const ICON_HELP = "M9.4 9.1a2.7 2.7 0 1 1 4 2.4c-.85.44-1.4 1-1.4 2M12 16.9h.01"; // 问号（图例入口）
const ICON_CHEVRON = "M6 9.5l6 5.5 6-5.5"; // 下折角（组折叠，收起态旋转 -90°）
const ICON_INFO = "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9zM12 11.2v4.6M12 7.9v.2"; // ⓘ（行内帮助）
const ICON_PLUS = "M12 5.5v13M5.5 12h13"; // ＋（手动添加）
const ICON_REFRESH = "M19.5 12a7.5 7.5 0 1 1-2.1-5.2M19.5 3.8v3.4h-3.4"; // ↻（配对码刷新）
// W-MOBILE3 #122 一级目录页导航卡（v3 pset hcard 分区 → expo Row 行语言）：
// icon 复用各组既有线稿；sub 即二级页 PageHead 副题
const SET_NAV: { key: "conn" | "prefs" | "engines" | "about"; title: string; sub: string; note: string; icon: string }[] = [
  { key: "conn", title: "连接与设备", sub: "连接", note: "服务器 · 已配设备 · 规则与权限", icon: ICON_PHONE },
  { key: "prefs", title: "通用与偏好", sub: "偏好", note: "主题 · 空闲置灰 · 输入习惯 · 保活", icon: ICON_MOON },
  { key: "engines", title: "Agent 引擎", sub: "引擎", note: "引擎目录 · 经验库", icon: ICON_BOOK },
  { key: "about", title: "关于", sub: "关于", note: "版本 · 检查更新 · 反馈", icon: ICON_BOX },
];

// W-MSET3 ⑤ 裸线图标（无方格底）：小尺寸 stroke 图标统一出口（问号/折角/ⓘ/＋/↻），
// 参数与 IconTile 内 Svg 同参（strokeWidth 1.8 / round），rotate 用于折叠两态
function LineGlyph({ path, size = 14, color, rotate }: { path: string; size?: number; color: string; rotate?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={rotate ? { transform: [{ rotate }] } : undefined}>
      <Path d={path} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// W-MSETSIG 重设计：行图标升级为「图标方格」——005 settings-row 的标志语言
// （setting-icon：28×28 圆角 9 软底方格 + 15px 线图标 stroke 1.8），对齐桌面新壳
// 设置面板与 v2 原型 A 节手机方案；替换原 12px 裸线图标
function IconTile({ path, color, badge }: { path: string; color?: string; badge?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line }}>
      <Svg width={15} height={15} viewBox="0 0 24 24">
        <Path d={path} stroke={color ?? c.dim} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      {badge ? (
        <View style={{ position: "absolute", top: -4, right: -5, minWidth: 14, height: 14, borderRadius: 7, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", backgroundColor: c.brandA }}>
          <Text style={{ color: c.onBrand, fontSize: 8.5, fontWeight: "700", lineHeight: 10 }}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

// W-MSETSIG 分组卡：圆角卡节容器（panel 底 + hairline 行分隔由 Row 自理）。
// 行间分隔用 Row 的 borderBottom——容器 overflow hidden 收圆角
function GroupCard({ children, style }: { children: ReactNode; style?: object }) {
  const d = useThemeStyles(makeStyles);
  return <View style={[d.groupCard, style]}>{children}</View>;
}

// W-MSETSIG 设置行（005 settings-row 直译）：图标方格 + 双行文字（标题+说明）+
// 右侧槽（值+› / Switch / 拨杆 / 自定义）；行高 ≥48（44 触达 + 说明行余量），
// hairline 分隔（last 不画）。onPress 为空 = 静态行（无 ripple）
function Row({ icon, title, note, right, onPress, last, a11y, children }: {
  icon: string;
  title: string;
  note?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  a11y?: string;
  children?: ReactNode;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const body = (
    <>
      <IconTile path={icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={d.rowTitleT} numberOfLines={1}>{title}</Text>
        {note ? <Text style={d.rowNoteT} numberOfLines={1}>{note}</Text> : null}
      </View>
      {right}
      {onPress ? <Text style={d.rowChevT}>›</Text> : null}
    </>
  );
  // children（行内嵌块，如配对码）存在时行盒转 column：上半 = 标准行（rowBody），
  // 下半 = 内嵌块（自带左缘缩进对齐标题文字）——不依赖 row 收缩巧合，几何确定
  if (children != null) {
    const wrap = [d.rowWrap, !last && d.rowDiv];
    const inner = (
      <>
        <View style={d.row}>{body}</View>
        {children}
      </>
    );
    if (onPress) {
      return (
        <Pressable style={wrap} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onPress} accessibilityLabel={a11y ?? title}>
          {inner}
        </Pressable>
      );
    }
    return <View style={wrap}>{inner}</View>;
  }
  if (onPress) {
    return (
      <Pressable
        style={[d.row, !last && d.rowDiv]}
        android_ripple={{ color: c.tintSoft, borderless: false }}
        onPress={onPress}
        accessibilityLabel={a11y ?? title}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={[d.row, !last && d.rowDiv]}>{body}</View>;
}

// 扫描框角标（ScanScreen 取景框同语言 mini 版）：四角 L 亮角 + 中部扫描横线，
// 纯 View 线条绘制（App 无 svg 依赖，与既有图形语言一致）
function ScanGlyph({ color }: { color: string }) {
  const corner = { position: "absolute", width: 5, height: 5, borderColor: color } as const;
  return (
    <View style={{ width: 16, height: 16 }}>
      <View style={[corner, { top: 0, left: 0, borderTopWidth: 1.6, borderLeftWidth: 1.6 }]} />
      <View style={[corner, { top: 0, right: 0, borderTopWidth: 1.6, borderRightWidth: 1.6 }]} />
      <View style={[corner, { bottom: 0, left: 0, borderBottomWidth: 1.6, borderLeftWidth: 1.6 }]} />
      <View style={[corner, { bottom: 0, right: 0, borderBottomWidth: 1.6, borderRightWidth: 1.6 }]} />
      <View style={{ position: "absolute", left: 2, right: 2, top: 7, height: 2, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

// #313 关于弹窗：底部滑上卡片（NewSessionModal 同款视觉语言——全宽贴底、只上圆角）。
// 版本信息（LogoMark + 版本号·日期·通道角标）+ 本版特性（更新说明军规分组渲染，
// 2026-09-21：新增/优化/修复三组 + 超限折叠 + 「查看完整变更」外链——原 13 条
// 平铺文字墙被用户否决）+ 检查更新（原 #312 抽屉行迁入：结果行内反馈，有新版经
// announceUpdate 弹 App 层 UpdateBanner）+ 反馈入口（GitHub Issues）
// 手动检查更新（关于弹窗按钮与抽屉关于区行共用）：loading 态防抖；无新版"已是最新 ✓"，
// 有新版行内提示 + announceUpdate 弹 App 层 UpdateBanner
function useUpdateCheck() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const checkNow = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("检查中…");
    const info = await checkUpdate();
    setBusy(false);
    // "miss" ≠ 已是最新：清单双源都不可达（典型：公司网），谎报会掩盖「其实有新版
    // 只是查不到」——2026-09-20 用户在公司网检查更新被报「已是最新 ✓ test.3」
    if (info === "miss") {
      setMsg("检查失败 · 网络不通？稍后再试");
    } else if (info) {
      setMsg(`发现新版 v${info.version} ↗`);
      announceUpdate(info);
    } else {
      setMsg(`已是最新 ✓ ${APP_VER}`);
    }
  };
  return { busy, msg, checkNow };
}

// 军规分组头（全局 CLAUDE.md「更新说明军规」）：新增/优化/修复三组，只渲染有内容的组
const NOTE_GROUPS: { k: VersionNote["group"]; label: string }[] = [
  { k: "new", label: "新增" },
  { k: "improved", label: "优化" },
  { k: "fixed", label: "修复" },
];
// 军规条数上限：总数超此值折叠「展开全部 (N)」（当前版本 8 条全直出，机制留兜底）
const MAX_NOTES = 8;

function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const { busy, msg, checkNow } = useUpdateCheck();
  const [notesOpen, setNotesOpen] = useState(false);
  const total = VERSION_NOTES.length;
  const shown = notesOpen || total <= MAX_NOTES ? VERSION_NOTES : VERSION_NOTES.slice(0, MAX_NOTES);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.abMask} onPress={onClose}>
        {/* 2026-09-22 用户真机反馈：条目多展示不完全——sheet 上限 86% 屏高，超出由
            条目区 ScrollView 整段滚动（原写死 maxHeight 320 把 8 条两行内容裁掉了） */}
        <View style={{ width: "100%", maxHeight: "86%" }}>
          <Pressable style={m.abSheet} onPress={(e) => e.stopPropagation()}>
            <View style={m.abHead}>
              <View style={m.abLogo}>
                <LogoMark size={26} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={m.abNameT}>CC Deck</Text>
                <View style={m.abVerRow}>
                  {/* 军规头行：版本号 · 发布日期 · 通道角标（日期 = 用户判断落后多久的锚点） */}
                  <Text style={m.abVerT}>{APP_VER} · {VERSION_DATE}</Text>
                  {CHANNEL_TAG != null && <Text style={m.abChanT}>{CHANNEL_TAG}</Text>}
                </View>
              </View>
              <Pressable style={m.abClose} hitSlop={8} onPress={onClose} accessibilityLabel="关闭关于">
                <Text style={m.abCloseT}>✕</Text>
              </Pressable>
            </View>
            <ScrollView style={m.abNotes} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              {NOTE_GROUPS.map(({ k, label }, gi) => {
                const items = shown.filter((n) => n.group === k);
                if (!items.length) return null;
                return (
                  <View key={k} style={gi > 0 ? m.abGroup : null}>
                    <Text style={m.abSecT}>{label}</Text>
                    {items.map((n, i) => (
                      <View key={i} style={m.abNoteRow}>
                        <View style={m.abNoteDot} />
                        <View style={{ flex: 1 }}>
                          <Text style={m.abNoteT}>{n.text}</Text>
                          {n.note ? <Text style={m.abNoteSubT}>{n.note}</Text> : null}
                        </View>
                      </View>
                    ))}
                  </View>
                );
              })}
              {total > MAX_NOTES && !notesOpen ? (
                <Pressable hitSlop={6} onPress={() => setNotesOpen(true)} accessibilityLabel="展开全部更新说明">
                  <Text style={m.abMoreT}>展开全部（{total}）</Text>
                </Pressable>
              ) : null}
            </ScrollView>
            {/* 军规：全量细节不进弹窗——Release 页/提交历史外链承载 */}
            <Pressable hitSlop={6} onPress={() => void Linking.openURL(releasePageUrl()).catch(() => {})}>
              <Text style={m.abFullT}>查看完整变更 ↗</Text>
            </Pressable>
            <View style={m.abBtnRow}>
              <Pressable
                style={[m.abBtn, busy && m.abBtnOff]}
                disabled={busy}
                android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 13 }}
                onPress={() => void checkNow()}
              >
                <Text style={m.abBtnT}>{busy ? "检查中…" : "↻ 检查更新"}</Text>
              </Pressable>
              <Pressable
                style={[m.abBtn, m.abBtnGhost]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
                onPress={() => void Linking.openURL(FEEDBACK_URL).catch(() => {})}
              >
                <Text style={[m.abBtnT, m.abBtnGhostT]}>✎ 反馈</Text>
              </Pressable>
            </View>
            {msg ? <Text style={m.abMsgT} numberOfLines={1}>{msg}</Text> : null}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// W-BACKFIX（1016 test.31 用户实锤）：设置二级页的硬件返回/侧滑句柄——App.tsx
// 单点 BackHandler 分发（#282 全 App 唯一订阅）经 ref 问询本页：二级页开 → 消费
// 并清 subPage（与 PageHead onBack 同一 setState 同一状态源）；目录页 → false
// 不拦截（走 tab 层回会话域/系统默认）。ListScreen ListBackHandle 同款先例。
export type SettingsBackHandle = { requestBack: () => boolean };

function SettingsPageBase({
  onSetup,
  onEdit,
  onGoSessions,
  ref,
}: {
  onSetup: () => void;
  onEdit: (e: ServerEntry) => void;
  ref?: React.Ref<SettingsBackHandle>;
  /** W-HEAD4 ③④：源胶囊/铃铛点击回会话页 */
  onGoSessions?: () => void;
}) {
  const { c } = useTheme();
  const bellN = useBellBadge();
  const listDensityCur = useListDensity(); // W-HEAD6 C：密度三档管理迁入设置页
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const processFont = useProcessFont();
  // #129 回车发送开关（会话输入框回车键行为）
  const enterSend = useEnterSend();
  // #121 空闲变灰阈值：本地编辑串，失回/提交时解析（空/非法回落 30），负数 = 永不变灰
  const [idleDimText, setIdleDimText] = useState(String(getIdleDimMin()));
  const commitIdleDim = () => {
    const raw = idleDimText.trim();
    let v = raw === "" ? 30 : Math.trunc(Number(raw));
    if (!Number.isFinite(v)) v = 30;
    setIdleDimMin(v);
    setIdleDimText(String(v));
  };
  // #130 标签旁 ⓘ：原次行注脚「负数 = 永不变灰」收进弹窗（行高与上下设置行对齐）
  const idleDimHelp = () => {
    Alert.alert(
      "空闲变灰",
      "会话停止活动超过设定分钟数后，列表里显示为灰色。\n\n填负数 = 永不变灰；留空或非法值回落默认 30 分钟。",
    );
  };
  const snap = useRelay();
  // #17 第二批 雇员独立家 ⓘ 弹窗（渲染闭包 snap 即最新——抽屉随 emit 重渲）：
  // 语义 + 两条边界（只影响新会话 / 新装默认开）+ env 锁定附注
  const empHomeHelp = () => {
    Alert.alert(
      "雇员独立家",
      "开启后，系统拉起的雇员（自动干活的会话）使用独立目录保存配置与任务，不再读写你本机的 Claude 目录；关闭则共用。\n\n· 改动只影响之后新建的会话，已有会话保持原处\n· 新装默认开启，升级前已部署的默认关闭"
        + (snap.empHome?.source === "env" ? "\n· 本台服务器由部署环境锁定，开关不可更改" : ""),
    );
  };
  const [servers, setServers] = useState<ServerEntry[]>([]);
  rebuildSrvColors(servers.map((s) => s.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  // 全局扫码（直连/登录/导入三码统一入口）：头部右上扫码钮呼出，与设置页共用
  // ScanScreen.routeScanResult 同一条链路；错误走 Alert（抽屉无表单 err 行），
  // import 码在抽屉内弹 ImportPicker 选条目回发
  // W-MOBILE3 #122 设置二级页：null=一级目录页；conn/prefs/engines/about=二级详情
  const [subPage, setSubPage] = useState<"conn" | "prefs" | "engines" | "about" | null>(null);
  // W-BACKFIX：返回键句柄（与 PageHead onBack 同一 setSubPage(null)——同一状态源）
  useImperativeHandle(ref, () => ({
    requestBack: () => {
      if (subPage !== null) {
        setSubPage(null);
        return true;
      }
      return false;
    },
  }), [subPage]);
  const [scanOpen, setScanOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  // 0.7 批 2 已配对设备弹层（连接区入口行呼出）
  const [devicesOpen, setDevicesOpen] = useState(false);
  // 0.7 批 2 择路提示：智能码探测/择路结果的浮动反馈（探测 2.5s 原本是无反馈黑窗）
  const [routeHint, setRouteHint] = useState<string | null>(null);
  const routeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showRouteHint = (t: string) => {
    if (routeTimer.current) clearTimeout(routeTimer.current);
    setRouteHint(t);
    routeTimer.current = setTimeout(() => setRouteHint(null), 3000);
  };
  const applyScan = (r: ScanResult) => {
    void routeScanResult(r, {
      onError: (msg) => Alert.alert("扫码未完成", msg),
      onDone: () => {
        void store.loadServers().then(setServers);
        void store.activeServerId().then(setActiveId);
      },
      onImport: (t) => {
        setImportTarget(t);
        setImportOpen(true);
      },
      onRoute: (stage) =>
        showRouteHint(
          stage === "probing" ? "正在检测同网直连…"
            : stage === "lan" ? "同一局域网 · 直连中"
              : "跨网 · 走云桥接入",
        ),
    });
  };
  // 服务器列表折叠：多服务器时腾出空间（记忆上次选择）
  const [srvCollapsed, setSrvCollapsed] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("cc.drawer.srvCollapsed").then((v) => setSrvCollapsed(v === "1"));
  }, []);
  const toggleSrv = () => {
    setSrvCollapsed((v) => {
      void AsyncStorage.setItem("cc.drawer.srvCollapsed", v ? "0" : "1");
      return !v;
    });
  };

  // 页面挂载即刷新（配对完成后 cloudMsg 变化也会触发条目更新）——tab 页按需挂载，
  // 切走即卸载，回来重挂载等价原「每次展开时刷新」
  useEffect(() => {
    void store.loadServers().then(setServers);
    void store.activeServerId().then(setActiveId);
  }, [snap.cloudMsg]);

  const pick = (e: ServerEntry) => {
    // 2026-09-16 二稿回退：行点击恢复「切换选中光标」（连接/切面板）；进编辑走行尾铅笔。
    // 抽屉时代的 onClose() 收板随抽屉退役：tab 页连接后原地停留
    if (!e.token && !e.cloud) {
      onEdit(e);
      return;
    }
    void store.connectServer(e).then(() => setActiveId(e.id));
  };

  const edit = (e: ServerEntry) => {
    onEdit(e);
  };

  const remove = (e: ServerEntry) => {
    void store.deleteServer(e.id).then(() => {
      void store.loadServers().then(setServers);
      void store.activeServerId().then(setActiveId);
    });
  };

  // #46 长按删除 + W-MSETSIG 两步确认流（任务书「危险操作确认」）：长按亮「删除」
  //（waiting 色）→ 点按进入确认态「确认删除?」（error 色）→ 再点执行；任一步 3.5s
  // 无操作自动整体收回（规则删除/设备踢出同款 arm 语言）
  const [delArm, setDelArm] = useState<{ id: string; sure: boolean } | null>(null);
  // #53 图例弹窗开关
  const [legendOpen, setLegendOpen] = useState(false);
  const delArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDelete = (id: string, sure = false) => {
    if (delArmTimer.current) clearTimeout(delArmTimer.current);
    setDelArm({ id, sure });
    delArmTimer.current = setTimeout(() => setDelArm((cur) => (cur?.id === id ? null : cur)), 3500);
  };

  // #46 云桥连不上弹窗：点灰图标触发连接后 8s 仍未连上、failNote 指向云桥不可达
  // → Alert 提示（不在条目上堆状态文案）。snap 闭包防旧：ref 持最新快照
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const triggerConnect = (e: ServerEntry) => {
    pick(e);
    store.connect();
    if (!e.cloud) return;
    setTimeout(() => {
      const st = snapRef.current.sources.find((x) => x.id === e.id);
      const fn = snapRef.current.failNote;
      if (st && st.state !== "online" && fn && fn.includes("云桥")) {
        Alert.alert("云桥连不上", `${fn}。可检查网络后重试，或改用局域网直连。`);
      }
    }, 8000);
  };

  // 新设备配对码：信任设备向 relay 领一次性码，供网页端新浏览器输入。
  // W-MSET3 ④ 按需化：行点击展开才领码/展示/续领/跑钟——收起态零流量零定时器
  //（原「挂载即领 + 常驻 1Hz 时钟」退役；relay 侧多码并存互不作废，按领按用）
  const [pairOpen, setPairOpen] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const pc = snap.pairCode;
  const pairLeft = pc ? Math.max(0, Math.floor((pc.expiresAt - now) / 1000)) : 0;
  // 倒计时 1Hz 时钟：仅在展开态且码未到期时运行，到期即停表（避免常驻耗电）
  useEffect(() => {
    if (!pairOpen || !pc || pc.expiresAt <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (pc.expiresAt - Date.now() <= 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [pairOpen, pc, pc?.code]);
  const genPairCode = async () => {
    if (pairing.current || pairBusy) return;
    pairing.current = true;
    setPairBusy(true);
    try {
      setPairErr(await store.requestPairCode());
    } finally {
      pairing.current = false;
      setPairBusy(false);
    }
  };
  // W-MSET3 ④ 展开开关：展开即领（无码/将过期）；收起即静默
  const togglePair = () => {
    const nv = !pairOpen;
    setPairOpen(nv);
    if (nv && snap.connected && (!pc || pc.expiresAt - Date.now() <= 2000)) void genPairCode();
  };
  // 点码即复制：粘到网页端配对框省一程手输
  const [copied, setCopied] = useState(false);
  const copyCode = async () => {
    if (!pc) return;
    try {
      await Clipboard.setStringAsync(pc.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const pairing = useRef(false);
  // 码到期（pairLeft 归零）自动续领——W-MSET3 ④ 仅展开态续领（收起不领不耗流）。
  // importOpen 时暂停：ImportPicker 正按用户选定的源领码（认快照里新出现的
  // pairCode），页面若同时为活动源续领会抢出另一个码、有串到别的 relay 的风险
  useEffect(() => {
    if (!snap.connected || importOpen || !pairOpen) return;
    if (pc && pc.expiresAt - Date.now() > 2000) return;
    if (pairing.current) return;
    pairing.current = true;
    void store
      .requestPairCode()
      .catch(() => {})
      .finally(() => {
        pairing.current = false;
      });
  }, [snap.connected, pc, pairLeft === 0, importOpen, pairOpen]);

  // #313 关于弹窗：「关于」行呼出；检查更新从抽屉行迁入弹窗。tab 页卸载即整体收弹窗
  const [aboutOpen, setAboutOpen] = useState(false);

  // W-MSET3 ③ 偏好组恒展开：原「显示与字号」折叠记忆（cc_display_collapsed）退役
  // ——偏好合并后仅四行一卡，折叠收益低于组头噪音；存过偏好的老用户键值留在
  // storage 无副作用（不再读取），连接组折叠记忆（cc.drawer.srvCollapsed）保留

  // 连接状态卡（对齐设置原型）：活动源 = activeSourceId 命中项 → 缺失退第一个在线源 →
  // 再退任一源；无源显示"未配置"。状态点按源 state 取色，副行 = 通道（cloud=云桥/LAN）
  // + 状态文案
  const activeSrc =
    snap.sources.find((s) => s.id === snap.activeSourceId) ??
    snap.sources.find((s) => s.state === "online") ??
    snap.sources[0] ??
    null;
  // W-MSET3 ① 头部副题实时化：静态目录文案 → 实时连接摘要
  const onlineCount = snap.sources.filter((s) => s.state === "online").length;
  const headSub =
    servers.length === 0 ? "未连接 · 点下方添加电脑" : `${servers.length} 台电脑 · ${onlineCount} 台在线`;
  // W-MSET3 ② 活动连接卡派生：登记项（triggerConnect 需 wsUrl/cloud）+ 通道词
  //（在线时上报 channel 优先，退配置推断）+ 展示名（relayName 覆盖默认 host 名）
  const activeEntry = activeSrc ? (servers.find((x) => x.id === activeSrc.id) ?? null) : null;
  const activeChanWord = (() => {
    if (!activeSrc || !activeEntry) return "";
    const inferred = activeEntry.cloud ? "cloud" : isLanUrl(activeEntry.wsUrl) ? "lan" : "";
    const chan = activeSrc.state === "online" ? (activeSrc.channel ?? inferred) : inferred;
    return chan === "cloud" ? "云桥中转" : chan === "lan" ? "局域网直连" : chan ? "直连" : "";
  })();
  const activeTone = activeSrc ? connStateTone(activeSrc.state) : "off";
  const activeToneColor =
    activeTone === "online" ? c.done : activeTone === "busy" ? c.working : activeTone === "bad" ? c.error : c.faint;
  const activeName =
    activeSrc && activeEntry
      ? activeSrc.relayName && activeEntry.name === defaultHostName(activeEntry)
        ? activeSrc.relayName
        : activeEntry.name
      : "";

  // #212 记住规则（设置抽屉「记住的规则」区数据）：各在线源合并展示；
  // legacy 计数支持分态——全部在线源都是旧 relay（allowRules 为 null）时显示
  // 「升级后可用」。数据在 SourceStatus 上（connStatusPatch 透出），删除/事件
  // 到达都经快照发布自动重渲，无需手动刷新
  const ruleRows: { src: SourceStatus; r: AllowRule }[] = [];
  let ruleOnline = 0;
  let ruleLegacy = 0;
  for (const s of snap.sources) {
    if (s.state !== "online") continue;
    ruleOnline++;
    if (!Array.isArray(s.allowRules)) { ruleLegacy++; continue; }
    for (const r of s.allowRules) ruleRows.push({ src: s, r });
  }
  const ruleMultiSrc = new Set(ruleRows.map((x) => x.src.id)).size > 1;
  // P81-8E 源权限摘要（只读呈现，端上零求值零 policy 复制——求值权威在 relay
  // P81-3/5，这里只做 SNAPSHOT source_capabilities.permission[] 的人话映射）。
  // 在线源且 permission[] 有有效条目才入列；旧 relay 无该字段（undefined→[]）→
  // 整节隐藏（E 线 artpool 同款降级范式），不白屏不占位
  const permSections = snap.sources
    .filter((s) => s.state === "online" && permissionSummariesOf(s.sourceCapabilities?.permission).length > 0)
    .map((s) => ({ src: s, sums: permissionSummariesOf(s.sourceCapabilities?.permission) }));
  const permMultiSrc = permSections.length > 1;

  // W-EXPOLISH 件五 经验库数据面（原组织区内嵌分节口径原样：旧 relay experiences=null
  // 不进 → 整节隐藏；总开关关的源照进，弹层里置灰说明；条目只出 active）
  const expSections = useMemo(() => {
    const out: { src: SourceStatus; entries: ExperienceEntry[]; enabled: boolean }[] = [];
    for (const src of snap.sources) {
      if (!src.experiences) continue;
      out.push({ src, entries: src.experiences, enabled: src.experienceEnabled !== false });
    }
    return out;
  }, [snap.sources]);
  const expTotal = useMemo(
    () => expSections.reduce((n, x) => n + x.entries.filter((e) => e.status === "active").length, 0),
    [expSections],
  );
  // 经验库只读弹层开关（入口行呼出）
  const [expOpen, setExpOpen] = useState(false);
  // P81-8EFIX：unverified 用 c.working（#FFD60A 琥珀，与 web --working 同值同义）——
  // 原误用 c.waiting（expo 主题里 waiting=#F0524F 是红！跨端 token 同名异色陷阱，
  // 三态梯度坍缩成两红）。#95 Leader 亲审甄别
  const PERM_CAP_STATE_COLOR: Record<PermCapState, string> = { confirmed: c.done, unverified: c.working, unsupported: c.error };
  // 删除两次点按确认（web 端同款 arm 模式，3s 超时复位）
  const [ruleArm, setRuleArm] = useState<string | null>(null);
  const ruleArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // （#36 状态卡已删：connDotColor/connSubText 随之退役）

  // 关于区检查更新行已删（#130 收敛进关于弹窗），upd 不再需要

  return (
    <View style={[d.page, { paddingTop: insets.top }]}>
      <View style={d.content}>
        {/* W-MOBILE3 #121/#122：头部换 PageHead 统一组件（v3 .appbar 规格）；#122 二级页化
            ——一级=「设置」域标题+扫码钮；二级=返回+分区标题+「设置 · X」副题（v3 appbar 二级形态）。
            原 W-MSETSIG 品牌头（nameT/verT/scanBtn 三键）退役，扫码钮视觉保留进 right 槽 */}
        {subPage === null ? (
          <PageHead
            title="设置"
            sub={`${CHANNEL_TAG ? CHANNEL_TAG + " · " : ""}${headSub}`}
            sourcePill={<SourceSwitch />}
            bell={onGoSessions ? { badge: bellN, onPress: onGoSessions } : undefined}
            right={
              <>
                <Pressable
                  style={d.scanBtn}
                  hitSlop={8}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
                  onPress={() => setScanOpen(true)}
                  accessibilityLabel="扫码（直连 / 登录 / 导入）"
                >
                  <ScanGlyph color={c.brandA} />
                </Pressable>
              </>
            }
          />
        ) : (
          <PageHead
            title={SET_NAV.find((n) => n.key === subPage)!.title}
            sub={`设置 · ${SET_NAV.find((n) => n.key === subPage)!.sub}`}
            onBack={() => setSubPage(null)}
            backLabel="返回设置目录"
          />
        )}
        {/* #130 底部补安全距离：contentContainerStyle 撑出手势条空间（原 Build 行贴底） */}
        <ScrollView style={d.body} nestedScrollEnabled showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 + insets.bottom }}>
        {/* W-MOBILE3 #122 一级目录：活动连接卡（保留信息面）+ 四分区导航卡 → 点卡进二级页 */}
        {subPage === null ? (<>
        {/* W-MSET3 ② 活动连接状态卡（页面首卡，「连接为王」）：当前活动源升维——四态
            灯（busy 黄闪）+ 名称 + 状态词·通道词，打开设置即知「连着谁、走哪条通道」
            （原 #36 删状态卡后此信息只藏在服务器列表选中行里，多源时需逐行扫视）。
            在线=静态展示；配对失效（云桥）=点按进编辑重配；其余非在线=点按触发连接
            （triggerConnect 含 8s 云桥不通弹窗）；无任何源=点按进 setup（吸收原引导行） */}
        {activeSrc ? (
          <Pressable
            style={d.activeCard}
            android_ripple={
              activeSrc.state !== "online" && activeEntry
                ? { color: c.tintSoft, borderless: false, radius: 12 }
                : undefined
            }
            onPress={
              activeSrc.state === "online" || !activeEntry
                ? undefined
                : activeSrc.state === "unpaired" && activeEntry.cloud
                  ? () => edit(activeEntry)
                  : () => triggerConnect(activeEntry)
            }
            accessibilityLabel={`当前连接 ${activeName || activeSrc.name}，${connStateNote(activeSrc.state)}${activeChanWord ? `，${activeChanWord}` : ""}`}
          >
            <View style={[d.activeBar, { backgroundColor: activeToneColor }]} />
            {activeTone === "busy" ? (
              (() => {
                ensurePlugBlink();
                return (
                  <Animated.View style={{ opacity: plugBlink }}>
                    <PlugGlyph size={15} color={activeToneColor} />
                  </Animated.View>
                );
              })()
            ) : (
              <PlugGlyph size={15} color={activeToneColor} />
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={d.activeNameT} numberOfLines={1}>{activeName || activeSrc.name}</Text>
              <Text style={[d.activeSubT, activeSrc.state === "unpaired" && d.activeSubBadT]} numberOfLines={1}>
                {connStateNote(activeSrc.state)}{activeChanWord ? ` · ${activeChanWord}` : ""}
              </Text>
            </View>
            {activeSrc.state !== "online" && activeEntry ? <Text style={d.activeGoT}>›</Text> : null}
          </Pressable>
        ) : (
          <Pressable
            style={d.activeCard}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
            onPress={onSetup}
            accessibilityLabel="未配置电脑，点此添加第一台"
          >
            <View style={[d.activeBar, { backgroundColor: c.faint }]} />
            <PlugGlyph size={15} color={c.faint} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={d.activeNameT}>未配置电脑</Text>
              <Text style={d.activeSubT}>点此扫码或手动添加第一台</Text>
            </View>
            <Text style={d.activeGoT}>›</Text>
          </Pressable>
        )}

        {SET_NAV.map((n, i) => (
          <Row
            key={n.key}
            icon={n.icon}
            title={n.title}
            note={n.note}
            onPress={() => setSubPage(n.key)}
            last={i === SET_NAV.length - 1}
            a11y={`${n.title}，点按进入`}
          />
        ))}
        </>) : null}
        {subPage === "conn" ? (<>
        {/* 连接管理组（W-MSETSIG 任务书分组①，置顶）：区头（可折叠收起服务器列表，
            记忆上次选择）+ 服务器卡流 + 添加入口 + 设备/配对行组卡 + 规则/权限子节 */}
        <View style={d.secHead}>
          {/* #51 问号左靠：紧跟组标题成左组（原 space-between 三元素被推中）。
              W-MSET3 ⑤ ? 字符图标退役 → SVG 线图标（secHelpT 文字样式随样式键退役）；
              ⑥ 折叠态计数带单位「台」（原裸数字 N 与组内行数/源数歧义） */}
          <View style={d.secTitleRow}>
            <Text style={d.secTitleT}>连接管理{srvCollapsed && servers.length ? ` · ${servers.length} 台` : ""}</Text>
            {/* #48/#53 通道含义问号：自绘图例弹窗（AboutModal 同款 sheet + 图标行） */}
            <Pressable
              hitSlop={8}
              onPress={() => setLegendOpen(true)}
              accessibilityLabel="连接图标含义说明"
            >
              <View style={d.secHelpBtn}>
                <LineGlyph path={ICON_HELP} size={11} color={c.dim} />
              </View>
            </Pressable>
          </View>
          <Pressable style={d.secToggle} hitSlop={10} onPress={toggleSrv} android_ripple={{ color: c.tintSoft, borderless: true, radius: 12 }}>
            <LineGlyph path={ICON_CHEVRON} size={13} color={c.dim} rotate={srvCollapsed ? "-90deg" : "0deg"} />
          </Pressable>
        </View>
        {/* 原「未配置」引导行已删（W-MSET3 ② 活动连接卡未配置态吸收：页面首卡即
            入口，不再在组内重复一块）；srvEmpty 空文案双行同理退役 */}
        {!srvCollapsed ? (
        <ScrollView style={d.srvScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {servers.map((e) => {
            const active = e.id === activeId;
            const st = snap.sources.find((x) => x.id === e.id);
            const online = st?.state === "online";
            const unpaired = st?.state === "unpaired";
            const delArmed = delArm?.id === e.id;
            // 0.7 批 2 状态灯四态（对齐桌面 conn 图标语义）：绿=在线 / 黄=连接中
            // （含重连，闪烁）/ 红=配对失效（唯一不能自愈须人工重配的态）/ 灰=未连接
            const tone = connStateTone(st?.state);
            const toneColor = tone === "online" ? c.done : tone === "busy" ? c.working : tone === "bad" ? c.error : c.faint;
            const busy = tone === "busy";
            // #46/#53 通道标记：云桥 ☁️ / LAN 源 LAN 胶囊 / 手动直连不显示。
            // 0.7 批 2 徽章恒显（类型徽章=配置属性，离线也可见；在线时上报 channel
            // 优先——真实通道与配置推断可能不同）
            const chanTag = e.cloud ? "cloud" : isLanUrl(e.wsUrl) ? "lan" : "";
            const chan = online ? (st?.channel ?? chanTag) : chanTag;
            const badge = chan === "cloud" ? "☁" : chan === "lan" ? "LAN" : "";
            const displayName = st?.relayName && e.name === defaultHostName(e) ? st.relayName : e.name;
            return (
              <View key={e.id} style={[d.srvRow, active && d.srvRowOn]}>
                {/* #337 身份色（登记后固定，与状态解耦）#130 从 7dp 圆点改为卡片
                    左缘 3dp 色条——名称不再被点隔断、右侧不再显空 */}
                <View style={[d.srvBar, { backgroundColor: srvColorMap.get(e.id) ?? c.faint }]} />
                <Pressable
                  style={d.srvMain}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onLongPress={() => armDelete(e.id)}
                  delayLongPress={400}
                  onPress={() => {
                    if (delArmed) { setDelArm(null); return; }
                    // 配对失效：连接重试只会反复吃 nack（unpaired 不自动重试），
                    // 点按直接进编辑页重新配对（配对码在那儿输）
                    if (unpaired && e.cloud) { edit(e); return; }
                    pick(e);
                  }}
                >
                  <View style={d.srvHead}>
                    <Text style={d.srvName} numberOfLines={1}>{displayName}</Text>
                    {/* 状态灯（四态）+ 通道角标：busy 黄闪复用共享节拍，bad 红/常显 */}
                    {(() => {
                      const body = busy ? (
                        (() => {
                          ensurePlugBlink();
                          return (
                            <Animated.View style={{ opacity: plugBlink }}>
                              <PlugGlyph size={13} color={toneColor} />
                            </Animated.View>
                          );
                        })()
                      ) : (
                        <Pressable
                          hitSlop={8}
                          onPress={() => { if (!online) triggerConnect(e); }}
                          accessibilityLabel={`${displayName} ${online ? "已连接" : unpaired ? "配对失效，点按重新配对" : "点击连接"}${badge ? `（${badge === "LAN" ? "局域网直连" : "云桥中转"}）` : ""}`}
                        >
                          <PlugGlyph size={13} color={toneColor} />
                        </Pressable>
                      );
                      return (
                        <View style={d.plugWrap}>
                          {body}
                          {badge ? (
                            <Text style={badge === "LAN" ? d.plugBadgeLan : d.plugBadgeCloud}>{badge}</Text>
                          ) : null}
                        </View>
                      );
                    })()}
                  </View>
                  {/* 0.7 批 2 副行状态词：状态灯的文本回声（unpaired 染红点明须人工重配） */}
                  <Text style={[d.srvNoteT, unpaired && d.srvNoteBadT]} numberOfLines={1}>
                    {connStateNote(st?.state)}
                  </Text>
                </Pressable>
                {delArmed ? (
                  /* 两步确认：第一点「删除」（waiting）→「确认删除?」（error）→ 执行；
                     3.5s 自动收回（armDelete 每次重置计时） */
                  <Pressable
                    style={d.srvDelArm}
                    android_ripple={{ color: withA(delArm?.sure ? c.error : c.waiting, 0.15), borderless: false, radius: 13 }}
                    onPress={() => {
                      if (delArm?.sure) { setDelArm(null); remove(e); }
                      else armDelete(e.id, true);
                    }}
                  >
                    <Text style={[d.srvDelArmT, delArm?.sure && d.srvDelArmSureT]}>
                      {delArm?.sure ? "确认删除?" : "删除"}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable style={d.srvEdit} android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }} onPress={() => edit(e)}>
                    <PencilIcon size={12} color={c.faint} />
                  </Pressable>
                )}
              </View>
            );
          })}
          {/* 新增入口（#276/#36）：仅手动添加——扫码入口在顶栏 APP 名旁已有。
              #130 改虚线幽灵卡（与服务器卡同宽占位卡，「可添加」语义更直观，
              少一处游离强调蓝）；dashed 圆角用 SVG 画——RN Android 虚线边框
              配 borderRadius 会缺角 */}
          <View style={d.ghostWrap}>
            <Pressable
              style={d.ghostBtn}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
              onPress={onSetup}
            >
              <Svg style={d.ghostBorder} pointerEvents="none">
                <Rect x="1" y="1" width="98%" height="38" rx="11" stroke={withA(c.dim, 0.35)} strokeWidth={1} strokeDasharray="4 4" fill="none" />
              </Svg>
              {/* W-MSET3 ⑤ ＋ 字符图标退役 → SVG 线图标（与行图标同语言） */}
              <View style={d.ghostInner}>
                <LineGlyph path={ICON_PLUS} size={13} color={c.dim} />
                <Text style={d.ghostT}>手动添加</Text>
              </View>
            </Pressable>
          </View>
          {/* #308 云桥引导已删（#36 用户点单）：提示框啰嗦+太阳云图标无意义——
              配对入口在连接详情（点行进去）已有，此引导框整块移除 */}
        </ScrollView>
        ) : null}

        {/* 折叠区内：连接管理全量内容（设备/配对组卡 + 规则/权限子节）——
            折叠=整组收起只留组头（多源场景腾空间，记忆上次选择） */}
        {!srvCollapsed ? (
        <>
        {/* 连接管理行组卡（W-MSETSIG）：已配对设备 + 网页端配对——005 settings-row
            行语言（图标方格+双行+右槽），配对码作卡内嵌块（码+倒计时+刷新/复制） */}
        <GroupCard>
          {/* 0.7 批 2 已配对设备入口（议题①消费面）：弹层列已配对设备（名称/平台/
              版本/最后活跃），本机标识 + 踢出（两步确认） */}
          <Row
            icon={ICON_PHONE}
            title="已配对设备"
            note="浏览器与手机 · 查看与踢出"
            onPress={() => setDevicesOpen(true)}
            a11y="已配对设备"
          />
          {/* 网页端配对（W-MSET3 ④ 按需化）：行点击展开——展开才领码/展示/续领/跑
              钟，收起态零流量零定时器（原「挂载即领 + 常驻倒计时 + 生成钮」退役）；
              展开态码点按复制、到期自动续领（ImportPicker 互斥语义保留）。
              到期 0:00 到续领回包之间不闪「已过期」（每 TTL 一次的窗口） */}
          <Row
            icon={ICON_QR}
            title="网页端配对"
            note={pairOpen && pc ? "点码复制 · 供新浏览器输入" : "一次性配对码 · 供新浏览器接入"}
            last
            onPress={togglePair}
            a11y={pairOpen ? "收起配对码" : "展开配对码"}
          >
            {pairOpen ? (
              pc ? (
                <View style={d.pairEmbed}>
                  <Pressable onPress={() => void copyCode()} hitSlop={4} accessibilityLabel="配对码，点击复制">
                    <Text style={d.pairCodeT}>{pc.code.slice(0, 3)} {pc.code.slice(3)}</Text>
                  </Pressable>
                  <View style={d.pairSide}>
                    <Text style={d.pairExpT}>
                      {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, "0")}
                    </Text>
                    <Pressable
                      style={d.pairRefresh}
                      android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
                      hitSlop={6}
                      onPress={() => void genPairCode()}
                      accessibilityLabel="刷新配对码"
                    >
                      <LineGlyph path={ICON_REFRESH} size={13} color={c.dim} />
                    </Pressable>
                  </View>
                  {copied ? <Text style={d.pairHintT}>已复制 ✓</Text> : null}
                </View>
              ) : pairBusy ? (
                <Text style={d.pairPendingT}>领取中…</Text>
              ) : (
                <Text style={d.pairPendingT}>{pairErr ?? "未连接电脑 · 连上后自动领码"}</Text>
              )
            ) : null}
          </Row>
        </GroupCard>

        {/* #212 记住的规则（连接管理子节）：审批卡「允许并记住」落的规则（各在线源
            合并展示），删除按条目所属源路由发命令。分态：无在线源 / 全旧 relay
            （不支持）/ 空表 / 列表。两次点按确认删除（对齐 web 端） */}
        <View style={d.subHead}>
          <Text style={d.subTitleT}>记住的规则{ruleRows.length ? ` · ${ruleRows.length}` : ""}</Text>
        </View>
        {ruleOnline === 0 ? (
          <Text style={d.srvEmpty}>连接电脑后可查看</Text>
        ) : ruleLegacy === ruleOnline ? (
          <Text style={d.srvEmpty}>此电脑版本不支持，升级后可用</Text>
        ) : ruleRows.length === 0 ? (
          <Text style={d.srvEmpty}>暂无记住的规则</Text>
        ) : (
          <View>
            {ruleRows.map(({ src, r }) => {
              const key = `${src.id}|${r.id}`;
              const armed = ruleArm === key;
              return (
                <View key={key} style={d.ruleRow}>
                  <View style={d.ruleHead}>
                    <Text style={d.ruleTool}>{r.tool}</Text>
                    <View style={d.ruleScope}>
                      <Text style={d.ruleScopeT}>{r.scope === "session" ? "本会话" : "全局"}</Text>
                    </View>
                    {ruleMultiSrc ? (
                      <Text style={d.ruleSrc} numberOfLines={1}>{src.relayName || src.name}</Text>
                    ) : null}
                    <Pressable
                      hitSlop={6}
                      onPress={() => {
                        if (!armed) {
                          setRuleArm(key);
                          if (ruleArmTimer.current) clearTimeout(ruleArmTimer.current);
                          ruleArmTimer.current = setTimeout(() => setRuleArm(null), 3000);
                          return;
                        }
                        setRuleArm(null);
                        if (ruleArmTimer.current) clearTimeout(ruleArmTimer.current);
                        // 删除按源路由（rule id 只在所属 relay 存储里有效）
                        store.send("COMMAND_ALLOW_RULE_REMOVE", { id: r.id }, src.id, (ack) => {
                          if (ack.ok) store.dropAllowRuleLocal(src.id, r.id);
                          else Alert.alert("删除失败", ack.err || "服务器未找到此规则");
                        });
                      }}
                      accessibilityLabel={`删除规则 ${r.tool} ${r.pattern === "*" ? "全部操作" : r.pattern}`}
                    >
                      <Text style={armed ? d.ruleDelArmT : d.ruleDelT}>{armed ? "确认删除？" : "删除"}</Text>
                    </Pressable>
                  </View>
                  <Text style={d.rulePat} numberOfLines={2}>{r.pattern === "*" ? "全部操作" : r.pattern}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* P81-8E 源权限摘要：每在线源每引擎一行——引擎名 + capability_state 三态词
            （confirmed 绿/unverified 黄/unsupported 红）+ confirmed/unverified 附档集。
            只读呈现（档位切换面在会话详情权限胶囊，归 #36 既有交互）；unsupported
            不显档集只显态词。全部在线源无 permission[]（旧 relay）→ 整节隐藏 */}
        {permSections.length ? (
          <>
            <View style={d.subHead}>
              <Text style={d.subTitleT}>权限</Text>
            </View>
            {permSections.map(({ src, sums }) => (
              <View key={src.id}>
                {permMultiSrc ? (
                  <Text style={[d.ruleSrc, { marginBottom: 4 }]} numberOfLines={1}>{src.relayName || src.name}</Text>
                ) : null}
                {sums.map((s) => (
                  <View key={s.engine} style={d.ruleRow}>
                    <View style={d.ruleHead}>
                      <Text style={d.ruleTool}>{s.engine}</Text>
                      <View style={d.ruleScope}>
                        <Text style={[d.ruleScopeT, { color: PERM_CAP_STATE_COLOR[s.capability_state] }]}>
                          {PERM_CAP_STATE_LABEL[s.capability_state]}
                        </Text>
                      </View>
                    </View>
                    {s.capability_state !== "unsupported" && s.modes.length ? (
                      <Text style={d.rulePat} numberOfLines={2}>{permissionModesText(s.modes)}</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ))}
          </>
        ) : null}

        </>
        ) : null}

        </>) : null}
        {subPage === "prefs" ? (<>
        {/* 偏好组（W-MSET3 ③ 合并：原「显示与字号」+「通用」两组 → 一组四行）。
            「显示与字号」组名与内容不符（过程消息档/空闲置灰皆非全局字号）早已
            该正名；通用组仅两行撑不起独立组——合并后少一层组头一处分折叠（原
            显示组折叠记忆 cc_display_collapsed 退役，偏好恒展开）。行序：显示类
            （过程消息/空闲置灰）→ 输入类（回车发送）→ 系统类（后台保活收尾） */}
        <View style={d.secHead}>
          <Text style={d.secTitleT}>偏好</Text>
          <View style={d.secToggle} />
        </View>
        <GroupCard>
          {/* #37 同行化：缩小版拨杆（118×24）与标题同行；三档 = 标准三档字距 */}
          <Row
            icon={ICON_MSG}
            title="过程消息"
            note="详情页过程消息展示 · 三档"
            right={<Lever options={FONT_OPTS} value={processFont} onChange={setProcessFont} />}
          />
          {/* W-HEAD6 C：卡片密度三档迁入（原会话页 statRow 循环胶囊退役——设置页统一管理） */}
          <Row
            icon={ICON_GRID}
            title="卡片密度"
            note="会话列表信息密度 · 三档"
            right={<Lever options={[{ k: "std", label: "标准" }, { k: "compact", label: "紧凑" }, { k: "minimal", label: "极简" }] as { k: ListDensity; label: string }[]} value={listDensityCur} onChange={setListDensity} />}
          />
          {/* #121 空闲变灰阈值（分钟）：数字输入（不锁数字键盘——要能输负号），失回
              提交；「负数 = 永不变灰」语义收进标签旁 ⓘ 弹窗（W-MSET3 ⑤ ⓘ 字符图
              标退役 → SVG 线图标，helpMark 文字样式键随之退役） */}
          <Row
            icon={ICON_MOON}
            title="空闲变灰"
            note="会话静止后列表置灰"
            right={
              <View style={d.numRow}>
                <Pressable hitSlop={8} onPress={idleDimHelp} accessibilityLabel="空闲变灰说明">
                  <LineGlyph path={ICON_INFO} size={13} color={c.faint} />
                </Pressable>
                <TextInput
                  style={d.numInput}
                  value={idleDimText}
                  onChangeText={setIdleDimText}
                  onEndEditing={commitIdleDim}
                  onSubmitEditing={commitIdleDim}
                  returnKeyType="done"
                  placeholder="30"
                  placeholderTextColor={c.faint}
                  selectTextOnFocus
                />
                <Text style={d.numUnit}>分钟</Text>
              </View>
            }
          />
          {/* #129 回车发送（输入习惯类，W-MSET3 ③ 从通用组并入偏好） */}
          <Row
            icon={ICON_ENTER}
            title="回车发送"
            note="开 = 回车即发送 · 关 = 换行"
            last={!fgSupported()}
            right={
              <Switch
                value={enterSend}
                onValueChange={setEnterSend}
                trackColor={{ false: withA(c.dim, 0.3), true: c.brandA }}
                thumbColor="#EDEDF2"
              />
            }
          />
          {/* #85 后台保活（W-MSET3 ③ 从通用组并入偏好收尾；kaRow 行形态与组卡行
              同构，KeepAliveCard 共享组件零改动——SetupScreen 消费面不受影响） */}
          {fgSupported() ? <KeepAliveCard /> : null}
        </GroupCard>

        </>) : null}
        {subPage === "engines" ? (<>
        {/* Agent 引擎组（任务书分组③，条件渲染：两项都是 relay 能力探测驱动——
            旧 relay 无字段整组不显）。#17 雇员独立家（relay 级设置）：活动源
            SNAPSHOT.settings 携带才渲染；source=env = 部署环境锁定只读；切换走
            COMMAND_SETTINGS_UPDATE，成功由 SETTINGS_UPDATED 广播收敛（不本地乐观
            更新，开关回弹即失败/未生效），失败 Alert 原文提示 */}
        {snap.empHome || expSections.length ? (
        <>
        <View style={d.secHead}>
          <Text style={d.secTitleT}>Agent 引擎</Text>
          <View style={d.secToggle} />
        </View>
        <GroupCard>
          {snap.empHome ? (
            <Row
              icon={ICON_HOME}
              title="雇员独立家"
              note={snap.empHome.source === "env" ? "由部署环境锁定" : "雇员会话用独立目录与配置"}
              right={
                <Switch
                  value={snap.empHome.employee_home}
                  disabled={snap.empHome.source === "env"}
                  onValueChange={(v) => {
                    if (snap.empHome?.source === "env") return;
                    store.empHomeSet(v, (r) => {
                      if (!r.ok) Alert.alert("雇员独立家", r.err || "设置未生效，请稍后重试");
                    });
                  }}
                  trackColor={{ false: withA(c.dim, 0.3), true: c.brandA }}
                  thumbColor="#EDEDF2"
                />
              }
            />
          ) : null}
          {/* W-EXPOLISH 件五 经验库：只读入口行（N 条计数），点开走只读弹层。
              旧 relay（experiences=null）行不显 */}
          {expSections.length ? (
            <Row
              icon={ICON_BOOK}
              title="经验库"
              note="手机只读 · 管理请用电脑端"
              last
              onPress={() => setExpOpen(true)}
              right={<Text style={d.rowValT}>{expTotal} 条</Text>}
              a11y={`查看经验库（只读），${expTotal} 条`}
            />
          ) : null}
        </GroupCard>
        </>
        ) : null}

        </>) : null}
        {subPage === "about" ? (<>
        {/* 通用组已删（W-MSET3 ③ 并入偏好组）：后台保活+回车发送两行上移，多源聚
            合开关早在 2026-09-14 移除（与会话列表「单源/聚合」胶囊重复，单一入口） */}
        {/* 关于组（任务书分组⑤，低频沉底）：#313 版本行（呼出弹窗——本版特性/检查
            更新/反馈都在里面）+ 反馈行；Build 尾行收组卡下（面板元信息收尾） */}
        <View style={d.secHead}>
          <Text style={d.secTitleT}>关于</Text>
          <View style={d.secToggle} />
        </View>
        <GroupCard>
          <Row
            icon={ICON_BOX}
            title="版本"
            note="本版特性 · 检查更新"
            onPress={() => setAboutOpen(true)}
            right={<Text style={d.rowValT}>{APP_VER}</Text>}
            a11y="版本与本版特性"
          />
          <Row
            icon={ICON_PENCIL}
            title="反馈"
            note="GitHub Issues"
            last
            onPress={() => void Linking.openURL(FEEDBACK_URL).catch(() => {})}
            a11y="反馈"
          />
        </GroupCard>
        <Text style={d.aboutBuildT}>CC Deck · Build {APP_VER.replace(/^v/, "")}</Text>        </>) : null}

        </ScrollView>
      </View>
      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
      <ScanScreen visible={scanOpen} onClose={() => setScanOpen(false)} onResult={applyScan} />
      {/* #53 连接图标图例（问号入口）：AboutModal 同款底部 sheet */}
      <ConnLegendModal visible={legendOpen} onClose={() => setLegendOpen(false)} />
      <ImportPicker visible={importOpen} target={importTarget} onClose={() => setImportOpen(false)} />
      {/* 0.7 批 2 已配对设备（议题①消费面）：清单 + 本机标识 + 踢出两步确认 */}
      <DevicesModal visible={devicesOpen} onClose={() => setDevicesOpen(false)} />
      {/* W-EXPOLISH 件五 经验库只读弹层（分节入口行呼出；原组织区行语言，不设截断） */}
      <ExpLibraryModal visible={expOpen} onClose={() => setExpOpen(false)} exps={expSections} />
      {/* 0.7 批 2 择路提示：面板顶部浮动胶囊（探测/择路结果 3s 自清） */}
      {routeHint ? (
        <View style={[d.routeToast, { top: 70 + insets.top }]} pointerEvents="none">
          <Text style={d.routeToastT}>{routeHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

// #53 LAN 通道标记图标化（用户点单）：描边小胶囊内写 LAN——与插头/☁️ 同风格统一，
// 列表条目与图例弹窗共用
export function LanGlyph({ color, fontSize = 8.5 }: { color: string; fontSize?: number }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 4, paddingHorizontal: 3.5, paddingVertical: 1 }}>
      <Text style={{ color, fontSize, fontWeight: "700", letterSpacing: 0.4, lineHeight: fontSize + 2 }}>LAN</Text>
    </View>
  );
}

// #53 连接图标图例弹窗（替代 Alert）：AboutModal 同款底部 sheet + 图标行自解释
// （不写「黄色/绿色」字样——直接画对应颜色的插头/标记），通道组与状态组分块
function ConnLegendModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const row = (icon: ReactNode, text: string) => (
    <View style={m.legRow}>
      <View style={m.legIcon}>{icon}</View>
      <Text style={m.legT}>{text}</Text>
    </View>
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.abMask} onPress={onClose}>
        <View style={{ width: "100%" }}>
          <Pressable style={m.abSheet} onPress={(e) => e.stopPropagation()}>
            <View style={m.legHead}>
              <Text style={m.legHeadT}>图标含义</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
                <Text style={m.legCloseT}>✕</Text>
              </Pressable>
            </View>
            {row(<Text style={{ fontSize: 13, lineHeight: 16 }}>☁️</Text>, "云桥中转 · 跨网络可用")}
            {row(<LanGlyph color={c.dim} fontSize={9} />, "局域网直连")}
            <View style={m.legSep} />
            {row(<PlugGlyph size={15} color={c.done} />, "已连接")}
            {row(<PlugGlyph size={15} color={c.working} />, "连接中")}
            {row(<PlugGlyph size={15} color={c.faint} />, "未连接 · 点击可连接")}
            {/* 0.7 批 2 第四态：配对失效（红灯）——唯一须人工重新配对的态 */}
            {row(<PlugGlyph size={15} color={c.error} />, "配对失效 · 点按重新配对")}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// 0.7 批 2 已配对设备弹层（议题①消费面）：AboutModal 同款贴底 sheet。
// 数据 = COMMAND_PEERS 按源拉取（在线源 chips 切换，默认活动源∩在线）；本机行
// 高亮禁踢（localPeerId 比对派生 dev）；踢出两步确认（3.5s arm，规则删除同款）；
// peersRev 变化（任一端配对/踢出经 PAIRED_DEVICE 广播）自动重拉，双端即时收敛。
// 旧 relay / 云桥未启用：relay 回 ok:false「云桥未启用」→ err 行如实显示
function DevicesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const snap = useRelay();
  // 发命令的前提是源在线（离线源 send 直接拒绝）——候选源只列在线源
  const liveSources = snap.sources.filter((s) => s.state === "online");
  const [srcId, setSrcId] = useState<string | null>(null);
  const [peers, setPeers] = useState<PairedDeviceInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState<{ dev: string; name: string } | null>(null);
  const [kickArm, setKickArm] = useState<string | null>(null);
  const kickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 选中源：手动选择优先（失效自动回落）；缺省活动源∩在线，再退第一个在线源
  const effId =
    (srcId && liveSources.some((s) => s.id === srcId) ? srcId : null) ??
    (snap.activeSourceId && liveSources.some((s) => s.id === snap.activeSourceId)
      ? snap.activeSourceId
      : liveSources[0]?.id) ??
    null;

  useEffect(() => {
    if (!visible) return;
    if (!effId) {
      setPeers(null);
      setErr(null);
      setLocal(null);
      return;
    }
    setPeers(null);
    setErr(null);
    setLocal(store.localPeerId(effId));
    store.send("COMMAND_PEERS", {}, effId, (r) => {
      if (r.ok) setPeers(Array.isArray(r.peers) ? r.peers : []);
      else setErr(r.err || "读取失败，请稍后重试");
    });
    // snap.peersRev：设备增删（本端或另一端发起）广播到达即重拉——弹层开着时自动收敛
  }, [visible, effId, snap.peersRev]);

  const kick = (dev: string) => {
    if (!effId) return;
    store.send("COMMAND_PEER_KICK", { dev }, effId, (r) => {
      if (!r.ok) Alert.alert("踢出失败", r.err || "请稍后重试");
      // ok：relay 广播 PAIRED_DEVICE kick → peersRev 自增 → 上方 useEffect 自动重拉
    });
  };
  const armKick = (dev: string) => {
    if (kickArm === dev) {
      setKickArm(null);
      if (kickTimer.current) clearTimeout(kickTimer.current);
      kick(dev);
      return;
    }
    setKickArm(dev);
    if (kickTimer.current) clearTimeout(kickTimer.current);
    kickTimer.current = setTimeout(() => setKickArm((cur) => (cur === dev ? null : cur)), 3500);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.abMask} onPress={onClose}>
        <View style={{ width: "100%", maxHeight: "82%" }}>
          <Pressable style={m.abSheet} onPress={(e) => e.stopPropagation()}>
            <View style={m.legHead}>
              <Text style={m.legHeadT}>已配对设备</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
                <Text style={m.legCloseT}>✕</Text>
              </Pressable>
            </View>
            {liveSources.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={m.devSrcRow}>
                {liveSources.map((s) => (
                  <Pressable
                    key={s.id}
                    style={[m.devSrcChip, s.id === effId && m.devSrcChipOn]}
                    onPress={() => setSrcId(s.id)}
                    accessibilityLabel={`查看 ${s.relayName || s.name} 的设备`}
                  >
                    <Text style={[m.devSrcChipT, s.id === effId && m.devSrcChipTOn]} numberOfLines={1}>
                      {s.relayName || s.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {liveSources.length === 0 ? (
              <Text style={m.srvEmpty}>连接电脑后可查看</Text>
            ) : err ? (
              <Text style={m.pairErrT}>{err}</Text>
            ) : peers === null ? (
              <Text style={m.srvEmpty}>读取中…</Text>
            ) : peers.length === 0 ? (
              <Text style={m.srvEmpty}>该服务器尚未配对任何设备</Text>
            ) : (
              <ScrollView style={m.devList} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                {peers.map((p) => {
                  const isLocal = !!local && p.dev === local.dev;
                  const armed = kickArm === p.dev;
                  return (
                    <View key={p.dev} style={[m.devCard, isLocal && m.devCardLocal]}>
                      <View style={m.devHead}>
                        <View style={m.devKindBadge}>
                          <Text style={m.devKindT}>{peerKindLabel(p.kind)}</Text>
                        </View>
                        <Text style={m.devName} numberOfLines={1}>{p.meta?.name || p.name}</Text>
                        {isLocal ? (
                          <View style={m.devLocalBadge}>
                            <Text style={m.devLocalT}>本机</Text>
                          </View>
                        ) : (
                          <Pressable
                            style={m.devKick}
                            hitSlop={6}
                            onPress={() => armKick(p.dev)}
                            accessibilityLabel={`踢出设备 ${p.meta?.name || p.name}`}
                          >
                            <Text style={armed ? m.devKickArmT : m.devKickT}>{armed ? "确认踢出？" : "踢出"}</Text>
                          </Pressable>
                        )}
                      </View>
                      <Text style={m.devSub} numberOfLines={1}>
                        {[p.meta?.platform, p.meta?.app].filter(Boolean).join(" · ") || "未知设备"}
                      </Text>
                      <Text style={m.devTime}>
                        最后活跃 {peerRelTime(p.last_seen)} · 配对于 {peerRelTime(p.paired_at)}
                      </Text>
                    </View>
                  );
                })}
                <Text style={m.devFootNote}>踢出后设备立即断开，需重新配对才能接入。</Text>
              </ScrollView>
            )}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// #46 连接状态图标（用户定稿素材：线缆+插头体+两插脚，描边风）。三态由调用方
// 染色：绿=已连接 / 灰=未连接（可点触发连接）/ 黄+外层 opacity 闪烁=连接中
function PlugGlyph({ size = 13, color }: { size?: number; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: size * 0.72 }}>
      <View style={{ width: size * 0.42, height: 1.4, backgroundColor: color }} />
      <View style={{ width: size * 0.32, height: size * 0.72, borderWidth: 1.4, borderColor: color, borderRadius: 2.5 }} />
      <View style={{ marginLeft: -0.5, height: size * 0.72, justifyContent: "space-evenly", paddingVertical: size * 0.13 }}>
        <View style={{ width: size * 0.26, height: 1.4, backgroundColor: color }} />
        <View style={{ width: size * 0.26, height: 1.4, backgroundColor: color }} />
      </View>
    </View>
  );
}

// 连接中黄闪节拍（共享一个 loop，bridgeless 下 JS 驱动，低频 450ms 往返）
const plugBlink = new Animated.Value(1);
let plugBlinkStarted = false;
function ensurePlugBlink() {
  if (plugBlinkStarted) return;
  plugBlinkStarted = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(plugBlink, { toValue: 0.25, duration: 450, useNativeDriver: false }),
      Animated.timing(plugBlink, { toValue: 1, duration: 450, useNativeDriver: false }),
    ]),
  ).start();
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  // tab 页容器（原抽屉 root/scrim/panel 退役）：全宽 + 顶安全区（JSX 注入 insets）
  page: { flex: 1, backgroundColor: c.bg },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  // W-MSETSIG 头部重设计：005 mobile-head 域标题（h2 设置 15-17px + small 副题
  // 10.5px）——原「logo + CC Deck」品牌头部退役（品牌识别收敛到关于弹窗 abLogo）
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: c.line },
  nameT: { color: c.textStrong, fontSize: 16.5, fontWeight: "700" },
  verT: { color: c.faint, fontSize: 10.5, marginTop: 2 },
  // 头部右上全局扫码钮：tintSoft 圆角方（#130 去描边），角标式扫描图标
  scanBtn: {
    width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, overflow: "hidden",
  },
  // ---------- W-MSETSIG 重设计键 ----------
  // 分组卡（005 卡节语言）：panel 底 + line 边 + radius 12 + overflow hidden
  //（行间 hairline 由 Row 的 rowDiv 收在卡内）；组卡 marginBottom 与内容流呼吸
  groupCard: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 14, overflow: "hidden", marginBottom: 10,
  },
  // 设置行（005 settings-row 直译）：图标方格 + 双行文字 + 右槽；
  // padding 12 + minHeight 48 = 44px+ 触达。带 children（内嵌块）时行盒转
  // rowWrap（column）：paddingHorizontal 12 + row（内层行）自适应
  row: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 13, paddingVertical: 14, minHeight: 50 }, // 1013 用户反馈「行高太低」：上下 padding 回调一档（12→13，minHeight 48 热区底线不动）
  rowWrap: { paddingHorizontal: 12, paddingVertical: 7 },
  rowDiv: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  rowTitleT: { color: c.text, fontSize: 13.5, fontWeight: "600" },
  rowNoteT: { color: c.faint, fontSize: 10.5, marginTop: 2 },
  rowChevT: { color: c.faint, fontSize: 12, marginLeft: 2 },
  // 行右值（版本号 / 经验库条数）：弱一档小字
  rowValT: { color: c.dim, fontSize: 11, flexShrink: 1 },
  // 连接管理子节头（记住的规则/权限）：比组头弱一档（更小更近）
  subHead: { marginTop: 14, marginBottom: 7 },
  subTitleT: { color: c.faint, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  // 配对码内嵌区（「网页端配对」行 children）：左缘对齐行标题文字（IconTile 28+gap 9）
  pairEmbed: {
    paddingLeft: 37, paddingTop: 3, paddingBottom: 2,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  // W-MSET3 ④ 配对码展开态非码文案（领取中/失败/未连接提示）：左缘对齐行标题
  //文字（pairEmbed 同缩进）；pairGenMini/pairGenMiniT 生成钮样式键随按需化退役
  pairPendingT: { color: c.faint, fontSize: 11.5, paddingLeft: 37, paddingVertical: 3 },
  // 服务器删除两步确认态（第二点「确认删除?」红）：与首点「删除」waiting 黄区分
  srvDelArmSureT: { color: c.error },
  // #130 区头：去字符图标（◫⇄≡ⓘ 胖瘦不一）纯文字 + 字距放宽 + 节奏 20/8
  secHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 20, marginBottom: 8 },
  // #51 标题左组：标题+问号同行靠左（原问号被 space-between 推中）
  secTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  secTitleT: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  secToggle: { width: 24, height: 24, alignItems: "center", justifyContent: "center", marginVertical: -6 },
  // W-MSET3 ⑤ 问号钮：tintSoft 软底小方格（#130 语言沿用），内嵌 SVG 线图标
  //（原 ? 字符图标退役，secToggleT/secHelpT 文字样式键随之退役）
  secHelpBtn: { width: 18, height: 18, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: c.tintSoft, overflow: "hidden" },
  // 服务器列表滚动容器：P0 加固③恢复有界帽（320）——嵌套 ScrollView 无界展开在
  // Fabric 触发 Yoga owner 断言崩（YogaLayoutableShadowNode.cpp:709，崩栈
  // ScrollViewShadowNode::layout；连接 SNAPSHOT 大渲染期必崩实测实锤），有界滚动
  // 视口恢复原抽屉时代的稳定布局语义
  srvScroll: { maxHeight: 320 },
  srvRow: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.line,
    borderRadius: 14, backgroundColor: c.panel2, marginBottom: 9, overflow: "hidden",
  },
  // #130 选中改品牌蓝（原绿框绿底——绿色从此只表示「在线插头」），与全 App 选中语言统一
  srvRowOn: { borderColor: withA(c.brandA, 0.45), backgroundColor: c.tintStrong },
  // #130 身份色条：卡片左缘 3dp（原 7dp 圆点）
  srvBar: { position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2 },
  srvMain: { flex: 1, paddingVertical: 9, paddingLeft: 12, paddingRight: 4 },
  // #51 行头：名称占满剩余空间（flex:1）——通道标记+插头图标恒右对齐（原 flexShrink
  // 随名称长短漂移：短名靠左长名靠右不齐）；图标间距收小 6→4
  srvHead: { flexDirection: "row", alignItems: "center", gap: 4 },
  srvName: { color: c.textStrong, fontSize: 13.5, fontWeight: "600", flex: 1 },
  // 0.7 批 2 服务器卡副行状态词（状态灯的文本回声；unpaired 染红点明须人工重配）
  srvNoteT: { color: c.faint, fontSize: 10, marginTop: 2 },
  srvNoteBadT: { color: c.error },
  // #96 插头角标几何（#130 follow-up 恢复）：云/LAN 是连接图标的右下角**角标**——
  // 锚 right + bottom、下沉出底，明显小于插头且低于其中心线（用户重申：不与插头
  // 平级并排；#130 曾误改为 left + top 垂直居中，角标变等高并排，越界回退）。
  // wrap 18→24 保留少量右侧余量防角标贴名称挤排
  plugWrap: { position: "relative", width: 24, height: 16, alignItems: "center", justifyContent: "center" },
  plugBadgeCloud: { position: "absolute", right: 0, bottom: -3, fontSize: 7.5, lineHeight: 9 },
  plugBadgeLan: { position: "absolute", right: -3, bottom: -4, fontSize: 6.5, lineHeight: 8, color: "#5B9DFF", fontWeight: "700", letterSpacing: 0.2 },
  // #96 插头右下角通道角标：不独立占位，缩到 7px 级（云=☁ 字符 / LAN=微字）
  // #53 图例弹窗：图标列固定宽左对齐 + 文字；组间距（legSep）大于行距
  legHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  legHeadT: { color: c.text, fontSize: 15, fontWeight: "700" },
  legCloseT: { color: c.dim, fontSize: 15 },
  legRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 9 },
  legIcon: { width: 30, alignItems: "center", justifyContent: "center" },
  legT: { color: c.text, fontSize: 13.5, flex: 1 },
  legSep: { height: 14 },
  // #130 编辑热区收窄（34×42→30×40）+ 图标降为 faint 12px（更安静的次级动作）
  srvEdit: { width: 30, height: 40, alignItems: "center", justifyContent: "center" },
  // #46 长按亮出的删除按钮（替常驻 ✕）
  srvDelArm: { paddingHorizontal: 10, height: 40, alignItems: "center", justifyContent: "center" },
  srvDelArmT: { color: c.waiting, fontSize: 12.5, fontWeight: "700" },
  // #130 添加入口改虚线幽灵卡（原右下角孤悬蓝字链接）：与服务器卡同宽的占位卡。
  // 虚线描边由 JSX 内 SVG Rect 绘制（RN Android dashed+borderRadius 缺角）
  ghostWrap: { marginBottom: 8 },
  ghostBtn: { height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  ghostBorder: { ...FILL },
  // W-MSET3 ⑤ ＋ 字符退役：SVG 线图标 + 文字横排
  ghostInner: { flexDirection: "row", alignItems: "center", gap: 6 },
  ghostT: { color: c.dim, fontSize: 12.5 },
  // #130 保活卡与上方列表的呼吸距（0.7 批 2 起卡形态自带 marginBottom，占位样式退役）
  // 择路浮动胶囊 + 设备弹层（原 devEntry 行已并入连接管理组卡 Row）
  routeToast: {
    position: "absolute", left: 16, right: 16, alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: withA(c.panel2, 0.96), borderWidth: 1, borderColor: c.lineStrong,
  },
  routeToastT: { color: "#EDEDF2", fontSize: 12, fontWeight: "600" },
  devSrcRow: { marginBottom: 10 },
  devSrcChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
    backgroundColor: c.tintSoft, marginRight: 6, maxWidth: 150,
  },
  devSrcChipOn: { backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45) },
  devSrcChipT: { color: c.dim, fontSize: 11.5, fontWeight: "600" },
  devSrcChipTOn: { color: c.brandA },
  devList: { flex: 1 },
  devCard: {
    borderWidth: 1, borderColor: c.line, borderRadius: 14, backgroundColor: c.panel2,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 9,
  },
  devCardLocal: { borderColor: withA(c.brandA, 0.45), backgroundColor: c.tintStrong },
  devHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  devKindBadge: {
    borderWidth: 1, borderColor: c.line, borderRadius: 5,
    paddingHorizontal: 4, paddingVertical: 1, backgroundColor: c.tintSoft,
  },
  devKindT: { color: c.dim, fontSize: 9, fontWeight: "600", lineHeight: 11 },
  devName: { color: c.text, fontSize: 13, fontWeight: "700", flex: 1, minWidth: 0 },
  devLocalBadge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1.5, backgroundColor: withA(c.brandA, 0.16) },
  devLocalT: { color: c.brandA, fontSize: 9, fontWeight: "700" },
  devKick: { marginLeft: 2 },
  devKickT: { color: c.faint, fontSize: 11 },
  devKickArmT: { color: c.error, fontSize: 11, fontWeight: "700" },
  devSub: { color: c.dim, fontSize: 10.5, marginTop: 3 },
  devTime: { color: c.faint, fontSize: 9.5, marginTop: 2 },
  devFootNote: { color: c.faint, fontSize: 10, textAlign: "center", paddingVertical: 6 },
  srvEmpty: { color: c.faint, fontSize: 11, marginTop: 2 },
  body: { flex: 1 },
  // W-MSET3 ② 活动连接状态卡（页面首卡）：服务器卡同族语言（左缘 3dp 状态色条 =
  // srvBar 同构 + panel 底 + line 边 + radius 12），但更大更重（首卡地位）：行高
  // 更足、名称 textStrong 14.5/700、副行状态词+通道词；在线静态、非在线可点
  activeCard: {
    flexDirection: "row", alignItems: "center", gap: 11,
    paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.lineStrong,
    marginBottom: 12, overflow: "hidden",
  },
  activeBar: { position: "absolute", left: 0, top: 12, bottom: 12, width: 3, borderRadius: 2 },
  activeNameT: { color: c.textStrong, fontSize: 14.5, fontWeight: "700" },
  activeSubT: { color: c.faint, fontSize: 10.5, marginTop: 2 },
  // unpaired 染红（与服务器行 srvNoteBadT 同语义：唯一须人工重配的态）
  activeSubBadT: { color: c.error },
  activeGoT: { color: c.faint, fontSize: 13, marginLeft: 2 },
  // #378 配对码平铺去框（W-MSETSIG 内嵌进「网页端配对」行 children）：大字码 +
  // 右侧倒计时/刷新（pairBox/pairTop 容器键随分节退役）
  pairSide: { flexDirection: "row", alignItems: "center", gap: 8 },
  // #130 配对码降权：19→15（层级靠字重+等宽+字距，不靠尺寸）
  pairCodeT: { color: c.brandA, fontSize: 16, fontWeight: "800", letterSpacing: 2.2, fontVariant: ["tabular-nums"] },
  pairExpT: { color: c.dim, fontSize: 11, fontVariant: ["tabular-nums"] },
  // #130 刷新钮与扫码钮同形制：tintSoft 圆底去描边，26×26
  pairRefresh: {
    width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, overflow: "hidden",
  },
  // pairRefreshT 已删（W-MSET3 ⑤ ↻ 字符图标退役 → ICON_REFRESH 线图标）
  pairHintT: { color: c.faint, fontSize: 10, marginTop: 6, textAlign: "center" },
  pairErrT: { color: c.waiting, fontSize: 11.5, marginBottom: 8 },
  // #212 记住规则行：首行 tool（等宽粗体）+ scope 徽章 + [源名] + 删除，次行
  // pattern 等宽小字（命令前缀/目录路径）；卡形态与服务器行同语言
  ruleRow: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginBottom: 8,
  },
  ruleHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  ruleTool: { color: c.text, fontSize: 12, fontWeight: "700", fontFamily: "monospace" },
  ruleScope: {
    borderWidth: 1, borderColor: c.line, borderRadius: 5,
    paddingHorizontal: 4, paddingVertical: 1, backgroundColor: c.tintSoft,
  },
  ruleScopeT: { color: c.dim, fontSize: 9, fontWeight: "600", lineHeight: 11 },
  ruleSrc: { flex: 1, color: c.faint, fontSize: 9.5, textAlign: "right" },
  ruleDelT: { color: c.faint, fontSize: 11, marginLeft: "auto" },
  ruleDelArmT: { color: c.waiting, fontSize: 11, fontWeight: "700", marginLeft: "auto" },
  rulePat: { color: c.dim, fontSize: 10, fontFamily: "monospace", lineHeight: 13.5, marginTop: 3 },
  // #121 空闲变灰数字输入：窄框右锚（lever 同位），单位注脚。
  // #130 反馈（2026-09-21 用户真机）：输入框 30 高偏肥——降 26；负数说明已收进
  // ⓘ 弹窗，numNote 次行删除（行高与其他设置行对齐）
  numRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  numInput: {
    width: 52, height: 26, borderRadius: 8, borderWidth: 1, borderColor: c.line,
    backgroundColor: c.panel2, paddingHorizontal: 6, paddingVertical: 0,
    color: c.text, fontSize: 13, textAlign: "center", includeFontPadding: false,
  },
  numUnit: { color: c.dim, fontSize: 11 },
  // helpMark 已删（W-MSET3 ⑤ ⓘ 字符图标退役 → ICON_INFO 线图标）
  // #353 拨杆：胶囊轨道 + 浮起滑块（阴影），标签盖在轨道上层。
  // #37 同行缩小版：24 高（原 34）。#130 轨道去描边（原 tintSoft 底 + 细边双边缘）
  leverTrack: {
    flexDirection: "row", height: 24, borderRadius: 12,
    backgroundColor: c.tintSoft, overflow: "hidden",
  },
  leverThumb: {
    position: "absolute", top: 2, left: 0, bottom: 2, borderRadius: 10,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: withA(c.brandA, 0.4),
    // 勿加 elevation：Android 上 elevation 压过后续兄弟的 zIndex，会把选中档
    // 标签整个盖住（标签须渲染在滑块上层，靠 JSX 顺序即可）
  },
  leverOpt: { flex: 1, alignItems: "center", justifyContent: "center", zIndex: 1 },
  leverT: { color: c.dim, fontSize: 11 },
  leverTOn: { color: c.text, fontWeight: "600" },
  // 关于区底部弱化 Build 行（面板元信息收尾，最暗一档）
  aboutBuildT: { color: c.faint, fontSize: 10, marginTop: 16 },
  // #313 关于弹窗（ab = about）：NewSessionModal 同款贴底卡片视觉语言
  abMask: { flex: 1, backgroundColor: withA(c.bg, 0.72), justifyContent: "flex-end" },
  abSheet: {
    backgroundColor: c.panel2, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 16,
    paddingTop: 18, paddingBottom: 30,
  },
  abHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  abLogo: {
    width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.lineStrong,
  },
  abNameT: { color: c.text, fontSize: 16.5, fontWeight: "700" },
  abVerT: { color: c.faint, fontSize: 11.5, marginTop: 1 },
  abVerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  // 通道角标（快照版/预发布）：细边框小胶囊，与版本号同行
  abChanT: {
    color: c.dim, fontSize: 9.5, fontWeight: "700", letterSpacing: 1,
    paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 5,
    borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  abClose: {
    width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  abCloseT: { color: c.dim, fontSize: 13 },
  abSecT: { color: c.faint, fontSize: 11, fontWeight: "700", marginBottom: 8, letterSpacing: 1 },
  // 军规分组容器间距：首个组贴头部（abHead 自带 marginBottom），后续组隔开
  abGroup: { marginTop: 12 },
  // 军规条目双行结构（主句 + note 灰字次行）：dot 顶对齐首行主句
  abNoteRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 3.5 },
  abNoteDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.brandA, marginTop: 6.5 },
  abNoteT: { color: c.dim, fontSize: 12.5, lineHeight: 18 },
  // note 次行：灰字小一档（默认值/开启方式等次要说明，军规②）
  abNoteSubT: { color: c.faint, fontSize: 10.5, lineHeight: 14, marginTop: 2 },
  // 军规排版：条目区弹性占满 sheet 剩余空间——内容少自适应，多则随 sheet 86% 屏高
  // 上限整段滚动（flex:1 是关键：sheet 被外层 maxHeight 压缩时本区收缩成滚动视口）
  abNotes: { flex: 1 },
  // 折叠态「展开全部 (N)」：居中弱化次级动作
  abMoreT: { color: c.dim, fontSize: 11.5, textAlign: "center", paddingVertical: 8 },
  // 「查看完整变更 ↗」：外链居中，与按钮区隔开
  abFullT: { color: c.dim, fontSize: 12, textAlign: "center", marginTop: 10 },
  abBtnRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  abBtn: {
    flex: 1, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
    overflow: "hidden",
  },
  abBtnOff: { opacity: 0.55 },
  abBtnT: { color: c.brandA, fontSize: 13.5, fontWeight: "700" },
  abBtnGhost: { backgroundColor: c.tintSoft, borderColor: c.line },
  abBtnGhostT: { color: c.dim },
  abMsgT: { color: c.dim, fontSize: 12, marginTop: 10, textAlign: "center" },
});

export default SettingsPageBase;
