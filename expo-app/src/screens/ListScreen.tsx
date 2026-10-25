import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";

// dda6490+6fb7180 并集合并残留收口：w63（TextInput/PanResponder）与 w54（Modal）两行 import 并存致重复标识符——合一行取并集
import { Alert, Animated, FlatList, Image, Linking, Modal, PanResponder, Pressable, RefreshControl, StyleSheet, Text, TextInput, Vibration, View } from "react-native"
import { HEAD_BASE } from "../head-unify";

import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { ENGINE_ACCENT, statusColor, withA, mix, type ThemeColors } from "../theme";
import { inferEngine } from "../engine-infer";
import { useTheme, useThemeStyles } from "../theme-context";
import { PlusMark } from "../brand";
import { SessionStatSub } from "./page-head";
import { SourceSwitch } from "./source-switch";
import { fmtLastActive, fmtTok, displaySrcName, isLiveLine, stripLiveMark } from "../fmt";
import { setListDensity, useListDensity, setAggregate as persistAggregate, useIdleDimMin, isIdleSession, type ListDensity } from "../display-settings";
import { store, useRelay, type AcceptanceSummary, type SourceStatus } from "../store";
import { artPoolGate } from "../artpool";
import { FadeIn, useLayoutPulse } from "../motion";
import { hasActivityCapability, type ProjectGroup, type SessionState, type SessionStatus } from "../protocol";
import { notifActionableOf } from "../notify-jump";
import NotifCenterSheet from "./NotifCenterPage";
import { EngineBadge, engineBadgeable } from "./TeamDetailPage";
import { EngineIcon, hasEngineIcon } from "../engine-icon";
import RenameModal from "./RenameModal";

// 硬件返回句柄（#282）：返回键收敛为 App.tsx 顶层单订阅统一分发，抽屉/图例浮层
// 是否开着只有本组件知道——经 ref 暴露 requestBack 供父级分发时调用
export interface ListBackHandle {
  requestBack: () => boolean; // 关掉一个开着的浮层返回 true；无可关返回 false
}

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string) => void; // 待确认悬浮清单（#306）的直达跳转由 App.tsx 层直接走 openDetail(sid, "todos")
  onNew: () => void;
  onOpenSettings: () => void; // 左上角 logo = 设置入口（W-EXPOLISH 件三：抽屉退役，落点改设置 tab）
  onOpenArtPool: () => void; // #72 E 线 入口①：产物池常驻胶囊（三重门显隐），App.tsx 开 ArtPoolModal
  // W-MOBFUSION 件②：团队入口卡点按 → 跳团队域（App setTab("team")）
  onOpenTeam?: () => void;
  // W-EXPODOMAIN 件三「查看项目会话」落点（C-7）：项目域跳入带目录过滤，顶部出
  // 可清除过滤条；null = 无过滤（常态）
  dirFilter?: string | null;
  onClearDirFilter?: () => void;
  ref?: Ref<ListBackHandle>;
}

// W-MOBFUSION 件③：PM 卡团队 chip 数据（桌面 pmTeamChipOf 同构）——编制 headcount
// 反查本会话 KEEP_ROLE 命中的在办团队；n=编制席全量、idle=编制内已同步 WORKING=0。
// W-ENGLM2 F（用户 1025 实锤）：running=编制内 WORKING 计数——chip 数字位显示活跃数
//（0 不显，working 色；idle 全闲自然无数字）。n 字段保留（编制数供 accessibility/后续）。
export interface PmTeamChip {
  gid: string;
  name: string;
  accent: string;
  idle: boolean;
  n: number;
  running: number;
}

// W-MOBFUSION R2（审查 A/B P1）：非 PM 卡 chips 空态共享常量——renderItem 每卡新建
// [] 会让 SessionCard memo 的 props 浅比较恒不等（全卡击穿）
const EMPTY_CHIPS: PmTeamChip[] = [];

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

// 沉寂会话判定（列表降噪）：DONE 且最近更新不在今天——名称色降一档，
// 让活跃/当日会话在长列表中先跳出来；详情页信息不受影响
function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// 源配色（#294 批2 + 审查修复，信息层级重设计后由源分组头沿用）：色板/哈希与
// 网页端 SRC_COLORS/srcColor 逐字节对齐；哈希键用跨端稳定身份（store
// SourceStatus.colorKey：云源 relay 设备 id、LAN 源 wsUrl），同一台服务器在两端
// 取到同色——本地 uuid 两端各异不可用
// #98 补充（用户三条）：①避开状态灯四色及接近色（红/橙/黄/绿全段让给 WAITING/
// ERROR/品牌橙/WORKING/DONE）；②池内两两也须 ≥25°（同屏可辨）；③不占品牌橙。
// 安全区 hue 190°-302°，5 色等距 28°：青 190/蓝 218/靛 246/紫 274/洋红 302，
// 明度交替拉开——120° 带内 25° 间距数学上限就是 ~5 色，源 >5 时取模循环复用
// （现实源数 ≤5）；与 web-console SRC_COLORS 逐字节同步。已过色距校验：
// 对状态色（含明暗双值）+品牌橙全部 ≥25°，池内两两 28°
const SRC_COLORS = ["#2FBEDA", "#5C94F5", "#665AD8", "#B886DF", "#CD51C8"];
function srcColor(id: string): string {
  let h = 0;
  for (const ch of String(id)) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  return SRC_COLORS[h % SRC_COLORS.length];
}

// 列表密度三档循环胶囊（统计行，原抽屉「列表布局」拨杆迁入）：标准→紧凑→极简→标准；
// 存储仍走 display-settings（cc.display.listCompact 三档不动），仅入口换位置
const DENSITY_ORDER: ListDensity[] = ["std", "compact", "minimal"];
// 件六回归②：折叠态持久键（桌面 expandedTeams「集合=用户展开过的组」同语义——默认
// 折叠，展开过的记键；「进行中」组默认展开记折叠态）
const TEAM_EXPANDED_KEY = "ccdeck_team_expanded";
const DENSITY_LABEL: Record<ListDensity, string> = { std: "标准", compact: "紧凑", minimal: "极简" };

// 源分组头（信息层级重设计）：聚合多源时列表按源分区——源色竖条 + 源名 + 在线
// 状态点 + 会话计数，下衬 hairline（对齐设置页「标记+标题+细线」的分区语言）；
// 组内卡不再逐卡带源角标（分组头已交代归属，避免重复）。取代 #294 批2 逐卡角标。
// memo：props 全原始值，快照刷新重建行包装对象时属性未变的组头不重渲
const GroupHeader = memo(function GroupHeader({ name, color, online, count }: {
  name: string;
  color: string;
  online: boolean;
  count: number;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  return (
    <View
      style={styles.grpHead}
      accessibilityLabel={`${name}，${online ? "在线" : "离线"}，${count} 个会话`}
    >
      <View style={[styles.grpBar, { backgroundColor: color }]} />
      <Text style={styles.grpName} numberOfLines={1}>{name}</Text>
      <View style={[styles.grpDot, { backgroundColor: online ? c.done : withA(c.dim, 0.45) }]} />
      <View style={{ flex: 1 }} />
      <Text style={styles.grpCount}>{count} 会话</Text>
    </View>
  );
});

// 段头（E2a 只读投影）：小节标题 + 实际渲染卡数；与源分组头同族形制。吸顶行自带
// 底色，滚动叠加不透字。件十：组间 20px 间距 + hairline 分隔线（组与组边界可见）；
// 团队收纳组头加团队色竖条（3px，桌面 grpBar 同语言——双端区分度规格一致）
const SectionHeader = memo(function SectionHeader({ label, count, collapsible, expanded, onToggle, teamColor }: {
  label: string;
  count: number;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  teamColor?: string; // 件十：团队色竖条（有=团队收纳组）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const body = (
    <View style={styles.secHead}>
      {teamColor ? <View style={[styles.secTeamBar, { backgroundColor: withA(teamColor, 0.55) }]} /> : null}
      <View style={styles.secHeadRow} accessibilityLabel={`${label}，${count} 个会话${collapsible ? `，点按${expanded ? "收起" : "展开"}` : ""}`}>
        {collapsible ? <Text style={styles.secChev}>{expanded ? "▾" : "▸"}</Text> : null}
        <Text style={styles.secHeadT}>{label}</Text>
        <View style={styles.secCountPill}><Text style={styles.secCount}>{count}</Text></View>
      </View>
    </View>
  );
  if (!collapsible || !onToggle) return body;
  return (
    <Pressable onPress={onToggle} hitSlop={{ top: 6, bottom: 6 }}>
      {body}
    </Pressable>
  );
});

// 列表行模型（E2a 只读投影）：三行型——段头（待处理/其他会话）、源分组头、
// 会话卡；卡行原样引用 SessionState 对象（分组/包装不改写会话，行级 memo 依赖
// 引用不变）。行序与 key 由 buildListProjection 纯函数产出
type ListRow =
  | { h: "sec"; key: string; label: string; count: number; grp?: "team" | "active"; collapsed?: boolean; teamColor?: string }
  | { h: "src"; key: string; name: string; color: string; online: boolean; count: number }
  // W-MOBFUSION 件②：团队入口卡行（桌面 dock team-entry 同语义）
  | { h: "team"; key: string; gid: string; name: string; teamColor?: string; rosterN: number; running: number; minis: { status: string }[]; hidden: number }
  | { h: false; key: string; s: SessionState };

// 卡间 hairline 分隔——#242 以桌面端为基准（用户 2026-10-23：手机分割线难看，参考
// 电脑端）：桌面会话行分隔=通栏 border-top（base.css:1926 件七定档，#193 微信风取代
// 原 line-soft 65%），1px、--line@60%、零缩进零专属上下距（行 padding-block 撑行高）。
// expo 同式：1px、line@0.6、通栏顶满宽（容器 paddingHorizontal 0 + 卡 borderRadius 0
// 本就是桌面满宽行语言，#218 的 59 文字列缩进退役）。组头下首卡不画（leadingItem=
// 组头时跳过）、末卡后 RN 分隔器天然无线；密度档通用（极简平铺行同线）。
function ListRowSeparator({ leadingItem }: { leadingItem?: ListRow | null }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  if (!leadingItem || leadingItem.h !== false) return null;
  /* #242 桌面基准：通栏（零缩进）+ 1px + line@.6——桌面 base.css:1926「件七」现行档
     （color-mix --line 60%），缩进/透明度双参数与桌面逐项对齐；色板用自家 line token
     （暗 #1A2942/亮 #E2E9F2，与桌面 --line #1C2A3E/#E0E0E0 近似同源，公式一致） */
  return <View style={[styles.rowSep, { backgroundColor: withA(c.line, 0.6) }]} />;
}

// #102 源胶囊限长：按视觉宽度截断（英文/数字 1、中文等全角 2），上限 6 英文宽
function clipSrcName(name: string): string {
  let w = 0;
  for (let i = 0; i < name.length; i++) {
    w += name.charCodeAt(i) > 0xff ? 2 : 1;
    if (w > 6) return name.slice(0, i > 0 ? i : 1).trimEnd() + "…";
  }
  return name;
}

// W-EXPOLISH 件一 徽标行收敛（纯函数，scripts/test-expolish-tabs.ts 断言）：
// 会话卡 r3 元信息（目录/组织/已保存/历史…）超 max 个折叠为「+N」——卡行数不再随
// 徽标数量膨胀（统一紧凑密度的行数钳制面）。顺序保持（先到先显），hidden 计数
// = 截掉条数；max ≤0 视为不限（防御）。
export function foldMeta(metas: string[], max = 3): { shown: string[]; hidden: number } {
  if (!Number.isFinite(max) || max <= 0 || metas.length <= max) {
    return { shown: metas, hidden: 0 };
  }
  return { shown: metas.slice(0, max), hidden: metas.length - max };
}


// ---------- E2a 列表只读投影（纯函数段，零 RN 依赖） ----------
// 数据源全部是 store 现有状态（activity / activity_capabilities / aggregate /
// sources / source_capabilities / notifications，#018-E1/E4 落库口径），只投影不
// 取数、不接真命令。expo-app/scripts/test-e2a-list.ts 与 relay/scripts/
// test-e2a-queue.ts（#018-E2a-up fixture）绕过 RN 桩直跑本段做断言。

/* E2A-QUEUE-START */
// #018-E2a-up 单流投影富版（018 §2.1.1 推荐分组规则；与 W1a Web queueFlagsOf /
// queuePartition 同语义——非共享代码层，Web/Expo 各自实现、fixture 同套）。E2a 简版
// （WAITING 全占待处理）与 W1a 的口径分叉就此对齐：
// - needs_action 三型入待处理 + working 一型：真实 WAITING 可决策（reason=waiting）/
//   待验收类持久行动（last_task_done，reason=acceptance）/ 会话级 actionable 未决
//   通知（reason=notification）/ 确有可观察工作状态的 WORKING（reason=working）；
// - 不占位四则：WAITING 无 waiting_request（脱钩帧）、decidable:false、已 resolved
//   通知、绑定他人 session 的通知；在线空转 WORKING（无活动证据）同样不占行动位；
// - 同键互斥首见优先（默认键 session_id，多源场景 opts.keyOf 注入复合键）；
// - 组内序：pending 按 reason 优先级（waiting>acceptance>notification>working）+
//   updated_at 倒序，others 按 updated_at 倒序；
// - 旧 relay 降级：无 status / waiting_request、last_task_done、activity 畸形 /
//   通知池非数组 / 条目非对象，一律安全落组不崩不伪造。
export type QueueReason = "waiting" | "acceptance" | "notification" | "working" | "other";

// queue_flags 五标志（018 §2.1.1 协议语义，客户端派生）
export interface QueueFlags {
  needs_action: boolean; // 行动位（waiting/acceptance/notification 三型任一）
  is_working: boolean; // WORKING 事实位（在线不占位——进不进待处理另看活动证据）
  needs_acceptance: boolean; // 待验收汇报在
  is_other: boolean; // 不入待处理组
  reason: QueueReason;
}

// 待处理组内排序优先级：可决策 > 待验收 > 通知要求 > 工作中
export const QUEUE_REASON_ORDER: Record<string, number> = { waiting: 0, acceptance: 1, notification: 2 };
// 🔧回归修②（test.21 用户实机）：「待处理」语义收窄——只有真需用户行动的才进
// pending（可决策 WAITING / 待填验收单 / 未决 actionable 通知）；原「WORKING 且有
// 活动证据也占待处理位」是把「在忙」当「待办」（用户实锤：待处理里的会话并不
// 需要用户处理）。WORKING 卡归「进行中」组（桌面 isActive 同口径），badge 计数
// 随之修正为纯行动数（与桌面 rail badge 只计需行动同源）

// 五标志判定（旧 relay 缺字段全形态降级：不崩、不伪造）
export function queueFlagsOf(s: SessionState, notifActionable?: boolean): QueueFlags {
  const o: Partial<SessionState> = s && typeof s === "object" ? s : {};
  const st = typeof o.status === "string" ? o.status : "";
  const wr = o.waiting_request;
  // 真实可决策 WAITING：waiting_request 在且为对象、decidable 非 false（缺省=可决策）
  const waitingDecidable = st === "WAITING" && !!wr && typeof wr === "object" && wr.decidable !== false;
  const ltd = o.last_task_done;
  const acceptance = !!ltd && typeof ltd === "object";
  const notif = notifActionable === true;
  const working = st === "WORKING";
  const act = o.activity?.activity;
  // 可观察工作状态：活动正文或工具名在场（仅 kind/时间戳不算——在线不占行动位）
  const observableWork = !!(act && ((typeof act.text === "string" && act.text !== "") || (typeof act.tool === "string" && act.tool !== "")));
  const needsAction = waitingDecidable || acceptance || notif;
  const reason: QueueReason = waitingDecidable ? "waiting"
    : acceptance ? "acceptance"
    : notif ? "notification"
    : "other";
  return { needs_action: needsAction, is_working: working, needs_acceptance: acceptance, is_other: !needsAction, reason };
}

// 单流分区主入口：pending（待处理，置顶）/ others（其他会话）两组互斥。同一会话
// 只出现一次（首见优先，重复 id 直接过滤）；opts.notifications = 全源归一通知池
//（判「通知明确要求动作」：actionable 且未 resolved 且 sourceContext.sessionId
// 绑定本会话）；畸形会话（非对象/无 id）跳过不入流、非数组入参 → 空两组（旧 relay
// 缺字段降级不崩）。flags 逐会话在账（键=keyOf）。调用方必须先做完筛选（折叠空闲/
// 删除舞步）再进来——组头计数只能来自过滤后实际渲染卡数，不能使用源总数（018
// §2.1.1 硬条款，buildListProjection 的段头 count 全部取自本函数输出）
export interface SplitOptions {
  keyOf?: (s: SessionState) => string;
  notifications?: unknown; // 归一化 NotificationItem[]；非数组 = 旧 relay 降级空池
}
export interface PendingSplit {
  pending: SessionState[];
  others: SessionState[];
  flags: Map<string, QueueFlags>;
}
export function splitPending(sessions: SessionState[], opts?: SplitOptions): PendingSplit {
  const keyOf = typeof opts?.keyOf === "function" ? opts.keyOf : (s: SessionState) => s.session_id;
  const notifSids = new Set<string>();
  const pool: unknown[] = Array.isArray(opts?.notifications) ? opts.notifications : [];
  for (const n of pool) {
    if (!n || typeof n !== "object") continue;
    const item = n as { actionable?: unknown; resolved_at?: unknown; sourceContext?: { sessionId?: unknown } };
    if (item.actionable !== true) continue;
    if (item.resolved_at !== undefined && item.resolved_at !== null) continue; // 已解决不再要求动作
    const sid = item.sourceContext && typeof item.sourceContext === "object" ? item.sourceContext.sessionId : undefined;
    if (typeof sid === "string" && sid) notifSids.add(sid); // 只认绑定本会话的未决通知
  }
  const pending: SessionState[] = [];
  const others: SessionState[] = [];
  const flags = new Map<string, QueueFlags>();
  const seen = new Set<string>();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== "object" || typeof s.session_id !== "string" || !s.session_id) continue;
    const k = String(keyOf(s));
    if (seen.has(k)) continue; // 首见优先，重复直接滤
    seen.add(k);
    const f = queueFlagsOf(s, notifSids.has(s.session_id));
    flags.set(k, f);
    (f.is_other ? others : pending).push(s);
  }
  const recency = (x: SessionState): number => (x && (x.updated_at || x.started_at)) || 0;
  pending.sort((a, b) => {
    const ra = QUEUE_REASON_ORDER[flags.get(String(keyOf(a)))?.reason ?? "other"] ?? 9;
    const rb = QUEUE_REASON_ORDER[flags.get(String(keyOf(b)))?.reason ?? "other"] ?? 9;
    return ra !== rb ? ra - rb : recency(b) - recency(a);
  });
  others.sort((a, b) => recency(b) - recency(a));
  return { pending, others, flags };
}
/* E2A-QUEUE-END */

// E2B-COMMANDS-START（W-EXPOLISH 起为 re-export shim：实现迁 src/org-commands.ts——
// 组织域组件（组织区/组详情/团队·项目 tab）与通知 tab 页从本屏拆出后仍需同一套
// ACK 严格判定门，纯函数落独立零依赖文件避免反向 import 整个 RN 屏模块。
// 既有引用面（NewSessionModal/test-e-permission-summary 等）经此 re-export 保持不变。
// §5.4 硬条款：ACK 必须核 ok === true，HTTP 200/已发送/退出 0 都不算成功；无自动重试
// 风暴（重试=用户重点；store 全局纪律已封顶：4s 超时重发同 command_id 一次 → 6s 收摊
// 回调一次，调用方只呈现不自动重发）。
export {
  ackVerdict,
  unknownCommandError,
  cmdCapRemember,
  cmdCapBlocked,
  cmdCapRecoverOnSnapshot,
  ackTapGuard,
  orgFlightKey,
  orgConfirmPayload,
  type AckLike,
  type AckVerdict,
  type CmdCaps,
} from "../org-commands";

// notifActionableOf 迁入 ../notify-jump（M13-6E：与 done 判定/分区/回跳判定同模块，
// 断言脚本直跑同路径；本文件 re-export 保持既有引用面不变）
export { notifActionableOf } from "../notify-jump";
// E2B-COMMANDS-END

// 源配色映射（#294 审查修复口径）：按跨端稳定键 colorKey 排序等距分配调色板，
// 与输入顺序无关——分组头与逐卡角标共用同一映射，同屏同源必同色
export function sourcePalette(sources: { id: string; colorKey?: string }[]): Map<string, string> {
  const sorted = [...sources].sort((a, b) => (a.colorKey ?? a.id).localeCompare(b.colorKey ?? b.id));
  return new Map(sorted.map((x, i) => [x.id, SRC_COLORS[i % SRC_COLORS.length]]));
}

// 活动指标行模型：store activity 最后值的只读投影。四行（状态/动作/耗时/审批）
// 按各自 capability 门控——字段缺省 = 该行不渲染；activity 缺失 = 返回 null
//（整块不渲染，不显示假「空闲」）。activity 在而 capability 全关（旧 relay
// 归一化产物）→ 返回空对象，渲染层按空块处理
export interface ActivityMetrics {
  state?: SessionStatus;     // native_status 门控
  summary?: string;          // operation_summary 门控（activity.text）
  elapsedMs?: number;        // native_elapsed 门控（elapsed_ms；缺失不出行）
  approvalPending?: boolean; // approval 门控（waiting_request 存在 = 待审批）
}
export function activityMetricsOf(s: SessionState): ActivityMetrics | null {
  const a = s.activity;
  if (!a) return null;
  const out: ActivityMetrics = {};
  if (hasActivityCapability(s, "native_status")) out.state = a.state;
  if (hasActivityCapability(s, "operation_summary")) out.summary = a.activity?.text ?? "";
  if (hasActivityCapability(s, "native_elapsed") && typeof a.elapsed_ms === "number") out.elapsedMs = a.elapsed_ms;
  if (hasActivityCapability(s, "approval")) out.approvalPending = !!s.waiting_request;
  return out;
}

// W-PORT-B P0-2（桌面 UIPOLISH2 件九直移）：会话列表搜索——纯前端过滤，字段=
// 名称(title/initial_prompt)+摘要(action_summary)+目录(cwd)+会话 ID，多词 AND、
// 大小写不敏感；消息正文搜索需 relay 全量 timeline，成本大不擅扩（桌面同款开放
// 边界）。空 query 恒过（零行为变化）；过滤挂 visible 链末端，段头/组头计数与
// 待处理段自然跟随过滤后卡数（投影管线既有口径）
export function sessionSearchTest(s: SessionState, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [s.title, s.initial_prompt, s.action_summary, s.cwd, s.session_id].map((v) => String(v || "").toLowerCase());
  return q.split(/\s+/).filter(Boolean).every((t) => hay.some((h) => h.includes(t)));
}

// 投影行模型：section（待处理/其他会话段头）· source（源分组头，srcId=null =
// 「—」降级占位组）· card（会话卡，pending 标记置顶组归属）。组头 count 一律
// = 该组实际渲染卡数（去重后），不是原始数组长度
export type ProjectionRow =
  // grp：可折叠组标记（件六回归②对齐桌面）——"team"=团队收纳组（默认折叠）、
  // "active"=「进行中」组（默认展开）；无 grp 的段头（其他会话等）不可折叠
  | { kind: "section"; key: string; label: string; count: number; grp?: "team"; teamColor?: string }
  | { kind: "source"; key: string; srcId: string | null; name: string; color: string; online: boolean; count: number }
  | { kind: "card"; key: string; s: SessionState; pending: boolean; grp?: string }
  // W-MOBFUSION 件②：团队入口卡（桌面 dock team-entry 同语义）——worker 会话不再
  // 主列表直显（收纳进入口），入口卡承载 编制数/在跑数/成员 mini 灯，点按跳团队域
  | { kind: "team-entry"; key: string; gid: string; name: string; teamColor?: string; rosterN: number; running: number; minis: { status: string }[]; hidden: number };

// W-MOBFUSION 件②③：编制角色词表（桌面 SLIM_KEEP_ROLE 逐字同源，t25fix #11 口径）
// ——命中=PM/Leader 保留主列表直列；未命中编制成员=worker（收纳进团队入口卡）
const SLIM_KEEP_ROLE = /^(pm|leader|产品经理|项目经理|领队)$/i;

export interface ProjectionSource {
  id: string;
  name: string;
  state: string;
  colorKey?: string;
}

export interface ProjectionParams {
  sessions: SessionState[];
  aggregate: boolean;
  sources: ProjectionSource[];
  // 活动源 source_capabilities?.activity === true；旧 relay 缺省/false = legacy
  sourceActivityCap: boolean;
  // #018-E2a-up 全源归一通知池（snap.sources 各源 notifications 平铺）；缺省 =
  // 无通知域，旧 relay（notifications 为 null/缺字段）自然降级空池
  notifications?: unknown;
  // 🔧回归②：在办项目组（团队收纳分组的归属数据，snap.sources projects 平铺跨源）
  projects?: ProjectGroup[];
  // W-MOBFUSION R2（审查 B P1）：入口卡统计基准池（全量会话）——p.sessions 是搜索/
  // dirFilter 过滤后的可见集，统计吃它会在搜索态把在跑团队误显「全闲」；缺省回落
  // p.sessions（纯函数向后兼容）
  teamStatsSource?: SessionState[];
}

// 列表投影主入口：
// - 待处理段恒置顶（跨源汇总，段头计数=实际卡数）；
// - 非聚合或仅单源 → 「其他会话」平铺直列；
// - 聚合多源 + 能力在 → 按源分组（组序=store 源序，组头带源名/配色/在线/计数）；
// - 聚合多源 + 能力缺失（legacy）→ 降级为单一「—」占位组平铺，不隐藏结构；
// - 聚合分组下无 src / 源已不在列表的会话落「—」占位组殿后（降级不丢卡）
export function buildListProjection(p: ProjectionParams): ProjectionRow[] {
  // 🔧回归修②（test.21 用户实机）：分组策略对齐桌面（index-005 B18/UIPOLISH2 件五/
  // UIPOLISH3 件二）——「待处理」段退役（WORKING 在忙≠待办，用户实锤），四段结构：
  //   ① 置顶池平铺最顶（跨组、无组头——钉选不该被组折叠藏掉，桌面件五口径）
  //   ② 团队收纳组「组名 · N」（在办团队编制成员；组内活跃前置+recency；组序=团队
  //      创建序）grp="team" 默认折叠（渲染层滤行，展开态 AsyncStorage 持久）
  //   ③ 「进行中」组（非编制 WORKING/WAITING/ERROR——桌面 isActive 同口径）grp="active"
  //      默认展开可折叠
  //   ④ 闲置平铺（DONE 等，无组头 recency 序）
  // splitPending 仍产出 pending（真行动项）供会话 badge 计数（App 层），列表不再
  // 单列待处理段——行动卡就地进行中组（摘要行「需要确认 ·」前缀+badge 已表达）
  const { pending, others } = splitPending(p.sessions, { notifications: p.notifications });
  // 并集回全量（splitPending 兼做去重+recency 排序）：行动卡（真需处理的 WAITING/
  // 验收单/通知绑定）不再单列「待处理」段，就地进行中组——桌面 isActive 同口径
  const all = [...pending, ...others];
  void others;
  const rows: ProjectionRow[] = [];
  const pinnedNow = all.filter((s) => s.pinned === true);
  const unpinned = all.filter((s) => s.pinned !== true);
  if (pinnedNow.length) {
    for (const s of pinnedNow) rows.push({ kind: "card", key: s.session_id, s, pending: false });
  }
  const isActive = (x: SessionState) => x.status === "WORKING" || x.status === "WAITING" || x.status === "ERROR";
  const recency = (x: SessionState) => x.updated_at || x.started_at || 0;
  // W-MOBFUSION 件②：编制两分（桌面 slimRosterOf/slimIsHidden 同口径）——
  //   PM/Leader（KEEP_ROLE 命中）→ 保留主列表直列；worker（编制在、词表外）→
  //   不再直显，收进团队入口卡（桌面 dock team-entry 同语义）。置顶例外与桌面
  //   slimIsHidden 一致：用户显式关注优先于 IA 规则（pinned 池已在前，天然豁免）。
  //   无编制（直连）会话照旧直列。R2（审查 A P1）：归档门控对齐桌面 W-TS63FIX——
  //   只滤 archived（pending/parked 团队照常收纳，原 active 误滤=口径相反）。
  const rosterBySid = new Map<string, { gid: string; gname: string; role: string; created_at: number }>();
  const teamDefs = new Map<string, { gid: string; name: string; created_at: number; headcount: { session_id: string; role: string }[] }>();
  for (const g of p.projects ?? []) {
    if (g.status === "archived" || !Array.isArray(g.headcount) || !g.headcount.length) continue;
    teamDefs.set(g.id, { gid: g.id, name: g.name || g.id, created_at: g.created_at ?? 0, headcount: g.headcount });
    for (const h of g.headcount) {
      if (h && typeof h.session_id === "string" && !rosterBySid.has(h.session_id)) {
        rosterBySid.set(h.session_id, { gid: g.id, gname: g.name || g.id, role: String(h.role || ""), created_at: g.created_at ?? 0 });
      }
    }
  }
  // R2（审查 B P1）：入口卡统计吃全量会话池（visible 是搜索/dirFilter 过滤后集合，
  // 搜索词下在跑团队会误显「全闲」灰灯）；平铺卡仍吃 p.sessions（过滤语义不破）
  const sessionsById = new Map((p.teamStatsSource ?? p.sessions).map((s) => [s.session_id, s] as const));
  const topUnpinned: SessionState[] = [];
  for (const s of unpinned) {
    const m = rosterBySid.get(s.session_id);
    // PM/Leader 与无编制（直连）照旧直列；worker 落团队入口（不入平铺）
    if (!m || SLIM_KEEP_ROLE.test(m.role)) topUnpinned.push(s);
  }
  // 团队入口卡（桌面 slimTeamEntryMarkup 同语言）：编制在场即出卡（桌面 #99件5 口径，
  // 成员会话未同步不影响出卡）；rosterN=编制席全量、running=编制内已同步 WORKING 数、
  // mini 灯=每在岗成员一颗（在岗优先排序 cap5+N，桌面 1014 追加同款）。
  // 入口卡落列表底部（桌面 dock 同位）——先攒定义，平铺段发射完再入行
  const teamList = [...teamDefs.values()].sort((a, b) => a.created_at - b.created_at || a.name.localeCompare(b.name));
  // 件九（用户拍板 2026-10-12）：「进行中」状态分组取消——列表=置顶+平铺+团队入口，
  // 状态过滤交给筛选档（「最近活跃/进行中/已完成」，与桌面同款另行派发联动）；
  // 平铺序沿用 all（真行动卡前置 + recency），组头心智只剩「谁在团里」一类
  void isActive;
  for (const s of topUnpinned) rows.push({ kind: "card", key: s.session_id, s, pending: false });
  for (const t of teamList) {
    const synced = t.headcount.map((h) => sessionsById.get(h.session_id)).filter((x): x is SessionState => !!x);
    const running = synced.filter((x) => x.status === "WORKING").length;
    const lampOrder = synced.slice().sort((a, b) => Number(b.status === "WORKING") - Number(a.status === "WORKING"));
    const minis = lampOrder.slice(0, 5).map((x) => ({ status: x.status }));
    rows.push({
      kind: "team-entry", key: `team-${t.gid}`, gid: t.gid, name: t.name, teamColor: srcColor(t.gid),
      rosterN: t.headcount.length, running, minis, hidden: Math.max(0, synced.length - minis.length),
    });
  }
  if (!rows.length && !p.sessions.length) return rows;
  // 聚合多源：保留源分组结构（多 relay 场景桌面无对应，维持既有源分组+组内 recency）
  const useGroups = p.aggregate && p.sources.length > 1;
  if (useGroups && p.sourceActivityCap) {
    return buildSourceGroupedRows(p, all);
  }
  return rows;
}

// 聚合多源投影（原路径保持）：源分组头 + 组内 recency 平铺；置顶在组内原位
//（多源态罕见，不做团队收纳三段——真机单源场景才走桌面对齐结构）
function buildSourceGroupedRows(p: ProjectionParams, others: SessionState[]): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  if (!p.sourceActivityCap) {
    rows.push({ kind: "source", key: "src-degraded", srcId: null, name: "—", color: "", online: false, count: others.length });
    for (const s of others) rows.push({ kind: "card", key: s.session_id, s, pending: false });
    return rows;
  }
  const palette = sourcePalette(p.sources);
  const stateOf = new Map(p.sources.map((x) => [x.id, x.state] as const));
  const bySrc = new Map<string, SessionState[]>();
  for (const s of others) {
    const k = s.src ?? "";
    const list = bySrc.get(k);
    if (list) list.push(s);
    else bySrc.set(k, [s]);
  }
  for (const src of p.sources) {
    const cards = bySrc.get(src.id);
    if (!cards?.length) continue;
    bySrc.delete(src.id);
    rows.push({
      kind: "source",
      key: `src-${src.id}`,
      srcId: src.id,
      name: displaySrcName(src.name),
      color: palette.get(src.id) ?? srcColor(src.colorKey ?? src.id),
      online: stateOf.get(src.id) === "online",
      count: cards.length,
    });
    for (const s of cards) rows.push({ kind: "card", key: s.session_id, s, pending: false });
  }
  // 无归属（快照无 src / 源已删）→ 「—」占位组殿后
  const unowned = [...bySrc.values()].flat();
  if (unowned.length) {
    rows.push({ kind: "source", key: "src-unknown", srcId: null, name: "—", color: "", online: false, count: unowned.length });
    for (const s of unowned) rows.push({ kind: "card", key: s.session_id, s, pending: false });
  }
  return rows;
}

// cc light 风格：运行中黄灯呼吸（亮度呼吸，对齐网页端呼吸灯）
// #77 终版（用户三连反馈后）：桌面端 THEME_ICONS 同款 SVG 渲染成 PNG 资产
// （resvg 生成，黑色线条），Image tintColor 运行时染色适配深浅模式——像素级
// 同款，View 手绘近似已弃（比例/月牙弧度两次不像）。深色显太阳=点击切浅、
// 浅色显月牙
const THEME_SUN = require("../assets/theme/theme-sun.png");
const THEME_MOON = require("../assets/theme/theme-moon.png");

// #80 连接 chip 电脑图标：桌面端 DESK_SVG 同款（16x13 viewBox，rect+底座横线），
// View 绘制 1.4 描边，颜色随连接态（绿/黄/红）
// W-PORT-B P0-2：顶栏搜索钮 glyph（放大镜线稿，react-native-svg 同 DetailScreen 范式）
function SearchGlyph({ color, active }: { color: string; active: boolean }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={active ? color : "none"} strokeWidth={2.2} strokeLinecap="round">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} />
      <Path d="M15.5 15.5 L20.5 20.5" stroke={color} />
    </Svg>
  );
}

function DeskGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 14, height: 12, marginRight: 4 }}>
      <View style={{ position: "absolute", left: 1.2, top: 0.8, width: 11.6, height: 8, borderRadius: 1.6, borderWidth: 1.4, borderColor: color }} />
      <View style={{ position: "absolute", left: 5, top: 10, width: 4, height: 1.4, borderRadius: 0.7, backgroundColor: color }} />
    </View>
  );
}

// W-MV8A 顶栏铃铛 glyph（v3 #i-bell 同形 lucide bell 线稿——通知中心入口对齐 v3
// appbar bell + bbadge 语言）；badge 红底白字（v3 .bbadge：需你行动计数，与底栏
// 琥珀 badge 色轴分工——红=通知行动，琥珀=tab 待处理）
function BellGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Svg>
  );
}

function ThemeGlyph({ dark }: { dark: boolean }) {
  const { c } = useTheme();
  return (
    <Image
      source={dark ? THEME_SUN : THEME_MOON}
      style={{ width: 15, height: 15, tintColor: c.dim }}
    />
  );
}

// #148 根因修复：bridgeless 下 Animated 逐帧动画（native/JS 驱动判别实验实测皆同）
// 每帧提交拖满 RenderThread（71%+、输入事件饿死 → 整机冻结；禁动画对照帧数
// 数千→104 归零）。降级为低频步进明灭：1→0.72→0.45→0.72 四级三角波 480ms/步
//（≈1.9s 一拍，近原 2.4s 节奏），每秒仅 2 次提交，肉眼仍是柔和呼吸感
const BLINK_PHASES = [1, 0.72, 0.45, 0.72];
function BlinkDot({ color }: { color: string }) {
  const styles = useThemeStyles(makeStyles);
  const [ph, setPh] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPh((n) => (n + 1) % BLINK_PHASES.length), 480);
    return () => clearInterval(t);
  }, []);
  return <View style={[styles.dot, { backgroundColor: color, opacity: BLINK_PHASES[ph] }]} />;
}

// #100 后台任务徽标：主回合空闲但仍有子 Agent 在跑——⑂N 黄字小标（与灯同语义色）
function BgBadge({ n, color }: { n: number; color: string }) {
  return <Text style={{ color, fontSize: 9.5, fontWeight: "700" }}> ⑂{n}</Text>;
}

// W-EXPO 005 srow 头像（.srow-ava 等价）：34px **圆形**（双端对齐 2026-10-12 用户实锤：
// 桌面已 50% 圆、手机仍圆角方块），源色 16% 淡染底 +
// 首字母；右下角状态灯叠角（2px 页底光圈遮接缝，.status-dot 同口径四色）。
// W-MOBFUSION 件①：size 密度化（桌面 --srow-ava 34/26 同源）——标准 34、紧凑 26，
// 品牌图盒仍 26 满铺（紧凑档桌面 .ava-brand 26 !important 同口径），首字母字号随档
// W-CRABINTEGRATE：roleKind 角色蟹判定（pm=举旗蟹/leader=皇冠蟹；null=普通卡零变化）
function AvaBadge({ letter, srcColor, dotColor, breathe, brandIcon, size = 34, roleKind }: { letter: string; srcColor: string | null; dotColor: string; breathe: boolean; brandIcon?: string | null; size?: number; roleKind?: "pm" | "leader" | null }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const bg = srcColor ? mix(srcColor, c.panel2, 0.84) : c.panel2;
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!breathe) return;
    const t = setInterval(() => setPh((n) => (n + 1) % BLINK_PHASES.length), 480);
    return () => clearInterval(t);
  }, [breathe]);
  // W-CRABINTEGRATE：claude 档角色蟹变体（PM=举旗蟹/Leader=皇冠蟹，contain 防压扁；
  // 非 claude 档保本引擎字形+皇冠角标走外层叠角）；engine 缺失视同 claude（inferEngine 兜底同语义）
  const roleCrab = roleKind && (brandIcon ?? "claude") === "claude"
    ? roleKind === "leader"
      ? require("../assets/engines/crab-leader.png") as { uri: string }
      : require("../assets/engines/crab-pm.png") as { uri: string }
    : null;
  return (
    <View style={[styles.ava, { backgroundColor: bg, width: size, height: size, borderRadius: size / 2 }]}>
      {brandIcon || roleCrab ? (
        <View style={{ width: 26, height: 26, borderRadius: 6, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
          {/* W-AVA09：0.9x 统一——头像盒图标 29→26（桌面 .ava-brand 26 同口径）；外框
              26×26/radius 6 裁切同桌面 img/svg 6px 圆角（方 LOGO 引擎如 glm 角不炸出）。
              W-CODEX09（用户 1024 口径修正）：codex 字形头像面再 ×0.9=23.4（26×0.9，
              RN 支持小数与 TeamDetailPage 10.8 同例，桌面 svg.codex-brand 面级 scale(0.9)
              同口径；标签面 EngineBadge 不动保持 0.9 全局档）——外框 26 不缩仅图标内缩，
              EngineIcon 居中渲染天然等效。
              W-CRABINTEGRATE：claude+角色=变体蟹整头替换（26 contain，191×176 旗杆/冠
              高不压扁）；#227 字母豁免位由角色蟹接管（PM/Leader 不再回字母） */}
          {roleCrab ? (
            <Image source={roleCrab} style={{ width: 26, height: 26 }} resizeMode="contain" />
          ) : (
            <EngineIcon engine={brandIcon} size={brandIcon === "codex" ? 23.4 : 26} color={srcColor ?? c.textStrong} />
          )}
        </View>
      ) : (
        <Text style={[styles.avaT, { color: srcColor ?? c.textStrong, fontSize: size >= 34 ? 15 : 11.5 }]}>{letter}</Text>
      )}
      {/* W-CRABINTEGRATE：角色皇冠角标（非 claude 引擎的 PM/Leader——本引擎字形保 + 右上
          -15° 金冠叠角，桌面 .ava-crown 同规格 12px；claude 档已整头换角色蟹不叠角）。
          角标挂 frame 外层（frame overflow:hidden 会裁出界角） */}
      {roleKind && (brandIcon ?? "claude") !== "claude" ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute", top: -5, right: -6, width: 12, height: 12,
            transform: [{ rotate: "-15deg" }],
          }}
        >
          <Svg viewBox="0 0 24 24" width={12} height={12}>
            <Path
              d="M3 17.5 L4.8 8 L9.4 12.8 L12 6 L14.6 12.8 L19.2 8 L21 17.5 Q12 20.5 3 17.5 Z"
              fill="#D4AF37"
              stroke="#8B6914"
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
            <Circle cx={12} cy={4.6} r={1.4} fill="#D4AF37" />
            <Circle cx={5.2} cy={6.9} r={1.1} fill="#D4AF37" />
            <Circle cx={18.8} cy={6.9} r={1.1} fill="#D4AF37" />
          </Svg>
        </View>
      ) : null}
      {/* #226 追加（用户 1023 灯显眼度）：WORKING 态发光脉冲环——光环层（dot 外扩
          6px 的半透明 working 色圆）随 BLINK_PHASES 同步呼吸，跑不跑一眼可辨；与
          #211 团队卡裸点+发光语言统一、与 web st-glow-pulse 同构（1.5s 级明暗）。
          空闲/其他态不加环（绿保持低调可辨） */}
      {breathe ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute", right: -9, bottom: -9, width: 21, height: 21, borderRadius: 11,
            backgroundColor: dotColor, opacity: 0.28 * BLINK_PHASES[ph],
          }}
        />
      ) : null}
      <View
        style={{
          position: "absolute", right: -3, bottom: -3, width: 9, height: 9, borderRadius: 5,
          borderWidth: 2, borderColor: c.bg, backgroundColor: dotColor,
          opacity: breathe ? BLINK_PHASES[ph] : 1,
        }}
      />
    </View>
  );
}

// r2 走秒行⑂N 呼吸点（.srow-live-dot：6px working 色，低频步进明灭）
function R2LiveDot() {
  const { c } = useTheme();
  const [ph, setPh] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPh((n) => (n + 1) % BLINK_PHASES.length), 480);
    return () => clearInterval(t);
  }, []);
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.working, opacity: BLINK_PHASES[ph] }} />;
}

// W-MOBFUSION 件③：双人图标（桌面 dock t-count 的 icon-user 双枚同语义）——裸 Svg
// 免引图标集，chip 计数行/入口卡共用；副人 0.72 透明度分层（前后景语言）
function PeopleIcon({ color, size = 9 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="9" cy="7.6" r="3.6" fill={color} />
      <Path d="M2.6 19.4c.5-3.7 3-5.9 6.4-5.9s5.9 2.2 6.4 5.9z" fill={color} />
      <Circle cx="17.2" cy="8.4" r="2.8" fill={color} opacity={0.72} />
      <Path d="M16.4 13.6c2.9.3 5 2.3 5.5 5.8h-4.4c-.2-2.3-.6-4.2-1.1-5.8z" fill={color} opacity={0.72} />
    </Svg>
  );
}

// W-MOBFUSION 件③：PM 卡团队标签 chip（桌面 team-chip 同构：accent 色条+淡染底+
// 32% 描边胶囊；Leader 口径补双人图标+编制数）——点击语义留待团队域深链，本期纯展示
function TeamChip({ chip }: { chip: PmTeamChip }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  return (
    <View style={[styles.teamChip, { borderColor: withA(chip.accent, 0.32), backgroundColor: withA(chip.accent, 0.09) }]}>
      <View style={[styles.teamChipBar, { backgroundColor: chip.accent }]} />
      <PeopleIcon color={chip.accent} />
      <Text style={[styles.teamChipName, chip.idle && styles.teamChipIdle]} numberOfLines={1}>{chip.name}</Text>
      {chip.running > 0 ? <Text style={styles.teamChipRun}>{chip.running}</Text> : null}
    </View>
  );
}

// W-MOBFUSION 件②：团队入口卡（桌面 dock slimTeamEntryMarkup 同语言）——队首字
// 头像+整队健康角灯（任一在跑=working 色/全闲=faint）、队名+编制/在跑计数（双人
// 图标）、成员 mini 灯行（在岗优先 cap5+N）；点按整卡跳团队域
function TeamEntryCard({ e, onPress }: {
  e: { name: string; teamColor?: string; rosterN: number; running: number; minis: { status: string }[]; hidden: number };
  onPress: () => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const accent = e.teamColor || c.brandA;
  const alive = e.running > 0;
  const lampColor = (st: string) => (st === "WORKING" ? c.working : st === "ERROR" ? c.error : st === "WAITING" ? c.working : c.faint);
  const letter = (e.name || "团").trim().charAt(0).toUpperCase() || "团";
  return (
    <Pressable
      style={styles.teamEntry}
      android_ripple={{ color: c.tintSoft, borderless: false }}
      onPress={onPress}
      accessibilityLabel={`${e.name} · ${e.rosterN} 席编制 · ${e.running} 个在跑，点按去团队域`}
    >
      <View style={[styles.teamEntryAva, { backgroundColor: withA(accent, 0.14) }]}>
        <Text style={[styles.teamEntryAvaT, { color: accent }]}>{letter}</Text>
        <View style={[styles.teamEntryLamp, { backgroundColor: alive ? c.working : c.faint, opacity: alive ? 1 : 0.55 }]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.teamEntryR1}>
          <Text style={styles.teamEntryName} numberOfLines={1}>{e.name}</Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.teamEntryArrow, { color: c.faint }]}>›</Text>
        </View>
        <View style={styles.teamEntryR2}>
          <PeopleIcon color={c.dim} />
          <Text style={styles.teamEntryCount}>{e.rosterN}</Text>
          <PeopleIcon color={alive ? c.working : c.faint} />
          <Text style={[styles.teamEntryCount, { color: alive ? c.working : c.faint }]}>{e.running}</Text>
          <View style={{ width: 4 }} />
          {e.minis.map((m, i) => (
            <View key={i} style={[styles.teamEntryMini, { backgroundColor: lampColor(m.status), opacity: m.status === "WORKING" ? 1 : 0.5 }]} />
          ))}
          {e.hidden > 0 ? <Text style={styles.teamEntryMore}>+{e.hidden}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

// r3 状态 tag 胶囊已退役（W-EXPODOMAIN v2 A3-5 查漏，桌面 #164 同口径）：AvaBadge
// 状态灯 + 待处理段置顶 + 摘要行（WAITING 前缀「需要确认 ·」）已表达状态，文字
// tag 是重复噪声——StatusTag/TAG_TINT/srowTag* 样式随之退役

// 黄灯旁的实时工作状态：回合耗时 · ↓输出tokens · 当前动作（每秒走秒）；
// #363 压缩中：⟳ 明示（CLI "Compacting conversation..."），不显示旧摘要防误判卡死
function LiveStat({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const live = !s.compacting && isLiveLine(s.action_summary);
  const summary = stripLiveMark(s.action_summary);
  const secs = Math.max(0, Math.floor((Date.now() - (s.turn_started_at ?? s.updated_at)) / 1000));
  const tok = s.usage?.output_tokens ?? 0;
  // 终端实时行自带活动时长/↓token：隐藏自家计时，避免同屏重复（2026-09-16 用户反馈）
  // 排版对齐 CLI 转轮行：状态文案在前，计时/↓token 收进后方括号；
  // 终端实时行自带括号信息，不重复叠加（2026-09-16 用户定稿）
  const meta = `${secs}s${tok > 0 ? ` · ↓ ${fmtTok(tok)}` : ""}`;
  return (
    <Text style={styles.liveStat} numberOfLines={1}>
      {s.compacting ? <Text style={{ color: c.working }}>⟳ 压缩上下文 · </Text> : null}
      {/* #98 黄字降级：摘要回中性灰（浅色旧值 #A16207 对米白 4.41:1 跌破 12px AA 且稀释
          WORKING 灯的黄色独占），只留计时/↓token/⟳ 压缩标记黄色——对齐桌面 .c-live
          层级（秒数黄、摘要中性，1162/1164 行；手机此前整行黄=抄漏了层级） */}
      {live ? (
        <Text style={{ color: c.dim }}>{summary}</Text>
      ) : (
        <>
          <Text style={{ color: c.dim }}>{summary || ""}</Text>
          <Text style={{ color: c.working }}>（{meta}）</Text>
        </>
      )}
    </Text>
  );
}

// #143 卡片右上角：会话计时 → 最后活跃时间（updated_at 随事件刷新，分钟粒度无需
// 每秒 tick——移除 WORKING 秒表重渲染；回合时长仍在 LiveStat。#155 格式收敛：
// 当天 HH:mm / 历史只显日期）
// 闲置置灰阈值（#121 可配置）：分钟数来自设置抽屉（display-settings.idleDimMin，
// 默认 30，负数 = 永不变灰），SessionCard 内经 useIdleDimMin 现算
function Elapsed({ s }: { s: SessionState }) {
  const styles = useThemeStyles(makeStyles);
  return <Text style={styles.elapsed}>{fmtLastActive(s.updated_at)}</Text>;
}

// 左滑露出操作面板（重命名 + 删除；DONE/ERROR 才可删）。
// 件六①②：左滑重命名/删除面板退役（SwipeRow 拆除）——功能并入长按菜单（桌面右键
// 菜单语义对齐）；长按 400ms 弹贴底 sheet（CardMenuSheet）。卡壳只保留点按+长按+
// 离线置灰蒙层；同时把整个横向手势位让给「左右滑切 tab」（App 层，件六③）
function CardShell({
  onPress, onLongPress, compact, minimal, dim, children,
}: {
  onPress: () => void;
  onLongPress: () => void;
  compact?: boolean;
  minimal?: boolean;
  dim?: boolean; // #32 离线源降权（缓存会话与在线视觉区分）
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  return (
    <View style={[styles.swipeWrap, compact && styles.swipeWrapC, minimal && styles.swipeWrapM]}>
      {/* W-MOBFUSION 件①：置顶图钉从卡壳右上角绝对定位迁入 r1 行内（时间戳左侧，
          桌面 srow-pinned 同位）——绝对定位版被摘要/r3 行压视觉、且与时间戳无关联 */}
      <Pressable
        style={[styles.card, compact && styles.cardC, minimal && styles.cardM]}
        android_ripple={{ color: c.tintSoft, borderless: false }}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={400}
      >
        {children}
      </Pressable>
      {/* 置灰蒙层替代整卡降透明度（2026-09-17）：蒙层盖在卡壳内（overflow:hidden
          自带圆角裁切），正面保持不透明 */}
      {dim ? <View pointerEvents="none" style={styles.dimCover} /> : null}
    </View>
  );
}

// 件六①：会话卡长按操作菜单（贴底 sheet，NotifCenterSheet/ExpLibraryModal 同语言）——
// 置顶/重命名/复制 ID/删除，桌面右键菜单语义对齐；删除带运行中/后台在跑拦截
function CardMenuSheet({ target, onClose, onPin, onRename, onCopyId, onDelete }: {
  target: SessionState | null;
  onClose: () => void;
  onPin: (s: SessionState) => void;
  onRename: (s: SessionState) => void;
  onCopyId: (s: SessionState) => void;
  onDelete: (s: SessionState) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  if (!target) return null;
  const bgLive = (target.subagents ?? []).some((a) => !a.ended_at) && target.status !== "WORKING";
  const deletable = (target.status === "DONE" || target.status === "ERROR") && !bgLive; // #100 后台在跑禁删
  const pinned = target.pinned === true;
  const row = (label: string, hint: string, press: () => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <Pressable
      key={label}
      style={[styles.menuRow, opts?.disabled && styles.menuRowOff]}
      disabled={opts?.disabled}
      android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
      accessibilityLabel={`${label}（${target.title || target.session_id.slice(0, 8)}）`}
      onPress={press}
    >
      <Text style={[styles.menuLabel, opts?.danger && { color: c.error }]}>{label}</Text>
      <Text style={styles.menuHint} numberOfLines={1}>{hint}</Text>
    </Pressable>
  );
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.menuMask} onPress={onClose}>
        <View style={{ width: "100%" }}>
          <Pressable style={styles.menuSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.menuTitle} numberOfLines={1}>{target.title || "未命名会话"}</Text>
            {row(pinned ? "取消置顶" : "置顶", pinned ? "从置顶区移回常规区" : "置顶区恒在列表前部（待处理段之下）", () => onPin(target))}
            {row("重命名", "回写服务器，跨端生效", () => onRename(target))}
            {row("复制 ID", "会话标识复制到剪贴板", () => onCopyId(target))}
            {row("删除", deletable ? "4 秒内可撤销" : "运行中/后台在跑不可删", () => onDelete(target), { danger: true, disabled: !deletable })}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// 删除撤销浮条（#247）：入场 spring 上滑、退场 fade 下滑（对齐 App.tsx Toast 动效语言）；
// shown=false 先播退场再卸载。标题预截断——numberOfLines 省略号会吃掉收尾引号
function UndoBar({ shown, title, onUndo }: { shown: boolean; title: string; onUndo: () => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [live, setLive] = useState(shown);
  const op = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(10)).current;
  useEffect(() => {
    if (shown) {
      setLive(true);
      op.setValue(0);
      y.setValue(10);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, useNativeDriver: true, speed: 30, bounciness: 6 }),
        Animated.timing(op, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]).start();
    } else if (live) {
      Animated.parallel([
        Animated.timing(op, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.timing(y, { toValue: 10, duration: 140, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setLive(false);
      });
    }
  }, [shown]);
  if (!live) return null;
  const t = title.length > 16 ? `${title.slice(0, 16)}…` : title;
  return (
    <Animated.View style={[styles.undoBar, { bottom: insets.bottom + 92, opacity: op, transform: [{ translateY: y }] }]}>
      <Text style={styles.undoT} numberOfLines={1}>{t ? `已删除「${t}」` : "已删除会话"}</Text>
      <Pressable
        style={styles.undoBtn}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
        onPress={onUndo}
        hitSlop={8}
      >
        <Text style={styles.undoBtnT}>撤销</Text>
      </Pressable>
    </Animated.View>
  );
}

// W-LIST2 件二①：列表卡水位组件（CtxMini 标准档/CtxCell 极简档）整链退役——上下文
// 水位迁移至详情页头部颗粒水位计（DetailScreen CtxSegMeter），列表卡不再承载水位。

// W-MOBFUSION R2（审查 A P2 随批清）：SrcBadge 组件退役——件①统一三排后 r3 源胶囊
// 内联渲染（W-CARDTAGS2 #233 形态），本组件自紧凑档拆除后零引用

// W-EXPOLISH 件一：卡片上的活动指标块（原 ActivityBlock，状态/动作/耗时/审批 0~4 行
// 门控伸缩）退役——它是「同密度卡高不一」的主源（4 行时卡高近翻倍，用户真机点单
// 「没必要这样搞」）。状态 tag（r3）/ 审批与摘要（r2）/ 耗时（r2 走秒）本就有等价
// 呈现位，逐项明细在详情页；activityMetricsOf 纯投影保留（test-e2a-list 断言面）。

const SessionCard = memo(function SessionCard({
  s, onOpen, onResume, onCardMenu, density, dim, srcBadge, orgTag, teamChips, roleKind,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onResume: (sid: string) => void; // #49/#139 休眠卡点按恢复
  onCardMenu: (s: SessionState) => void; // 件六①：长按 400ms 弹操作菜单（置顶/重命名/复制 ID/删除）
  density: ListDensity;
  dim?: boolean; // #32 离线源降权
  srcBadge?: { name: string; color: string } | null; // #59 聚合模式源归属角标
  orgTag?: string | null; // #26 M2 组织归属（项目组名/派单档位）：标准档缀元信息行、极简档无位不显
  teamChips?: PmTeamChip[]; // W-MOBFUSION 件③：PM 卡团队 chip（编制反查，非 PM 空）
  roleKind?: "pm" | "leader" | null; // W-CRABINTEGRATE：角色蟹变体判定（pm=举旗蟹/leader=皇冠蟹；null=普通卡零变化）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const idleDimMin = useIdleDimMin();
  const compact = density === "compact";
  const minimal = density === "minimal";
  const color = statusColor(s.status, c);
  // W-MOBLIST：engine 缺失兜底——PM/外部会话 engine 空时按 model 子串推断（util 双端同链，
  // web 侧 session-domain renderHeader 内联同规则）
  const effEngine = inferEngine(s.engine, s.model);
  // #100 后台任务态：主回合空闲但仍有子 Agent 在跑——灯转黄呼吸 + ⑂N 徽标 + 不置灰
  const bgCount = (s.subagents ?? []).filter((a) => !a.ended_at).length;
  const bgLive = bgCount > 0 && s.status !== "WORKING";
  const dotColor = bgLive ? c.working : color;
  const deletable = (s.status === "DONE" || s.status === "ERROR") && !bgLive; // #100 后台在跑禁删（删会话会杀后台任务）
  // 空闲超时置灰：isIdleSession 单一口径（#140 起与「折叠空闲」共用，防漂移）——
  // DONE/ERROR 且静默超阈值（#121 可配置，负数 = 永不）才蒙层，刚完成的保持鲜亮；
  // #100 后台子 Agent 在跑豁免（等孩子 ≠ 死会话）
  const isIdleCard = isIdleSession(s, idleDimMin);
  // 沉寂会话（DONE 且非今日更新）：名称色降一档，长列表里让位给活跃会话；#100 后台在跑同样豁免
  const idle = s.status === "DONE" && !bgLive && !isSameDay(s.updated_at ?? s.started_at, Date.now());
  // #49/#139 休眠卡（对齐桌面端 isDormant 口径）：已保存（saved）且会话不在跑——
  // 「点击恢复」入口只属于服务端已关掉的会话；运行中/等待输入的即使带 saved 残留
  // 也按正常卡处理（本来就没停，无从恢复）。休眠卡降透明度 + 点按发恢复命令。
  // 件六 C-3 语义拆分（v2 拍板跟进）：pinned=纯置顶（桌面 UIPOLISH3 件一同口径），
  // 休眠判定收窄到 saved 单字段——置顶的在跑会话不再被误判休眠
  const dormant =
    s.saved === true && s.status !== "WORKING" && s.status !== "WAITING";
  // W-EXPOLISH 件一 r3 文本元信息收敛：目录/组织/已保存/历史超 3 个折叠「+N」
  //（源胶囊/状态 tag/水位恒显不占折叠额）
  // W-FB66ALL ⑦+②：📁 工作目录 PM/Leader 卡不显（信息噪音；判定=roleKind 链与
  // 头像角色蟹同源），普通会话保留
  const r3Meta = foldMeta([
    ...(s.cwd && roleKind == null ? [`📁 ${folderOf(s.cwd)}`] : []),
    ...(orgTag ? [`◈ ${orgTag}`] : []),
    ...(dormant ? ["已保存"] : []),
    ...(s.historical && !s.external ? ["历史"] : []),
  ], 3);
  // W-MOBFUSION R2（审查 B P2）：紧凑档 footC 退役后目录不丢——r3 元信息紧凑档保 📁
  //（桌面 compact 只缩字号不删行；orgTag 由 PM chip/入口卡承载）
  const metaRow = compact ? foldMeta(s.cwd && roleKind == null ? [`📁 ${folderOf(s.cwd)}`] : [], 3) : r3Meta;
  return (
    <CardShell
      onPress={() => (dormant ? onResume(s.session_id) : onOpen(s.session_id))}
      onLongPress={() => onCardMenu(s)}
      compact={compact}
      minimal={minimal}
      dim={dim || isIdleCard || dormant}
    >
      {minimal ? (
        // 极简行：状态灯 + 名称（单行）+ 右端常显水位区（细条+百分比，无数据 "–" 占位），
        // 其余全部隐藏；行间分隔由 swipeWrapM 的极淡 hairline 承担（平铺行，不再堆卡间距）；
        // 点击/左滑交互与其他档一致
        <View style={styles.rowM}>
          {s.status === "WORKING" || bgLive ? (
            <BlinkDot color={dotColor} />
          ) : (
            <View style={[styles.dot, { backgroundColor: color }]} />
          )}
          <Text style={[styles.titleM, idle && styles.titleIdle]} numberOfLines={1}>
            {s.title || "未命名会话"}
          </Text>
          {bgCount > 0 ? <BgBadge n={bgCount} color={c.working} /> : null}
          <View style={{ flex: 1 }} />
        </View>
      ) : (
        <>
          {/* W-EXPO 005 srow 通栏行（.srow-* 等价）+ W-MOBFUSION 件①三排统一（用户
              1025「四行乱」实锤根治）：标准/紧凑两档同构三排制——ava 独立左列（密度化
              34/26，桌面 --srow-ava 同源）；r1 标题+图钉+行尾时间（图钉迁时间戳左侧=
              桌面 srow-pinned 同位）；r2 摘要与标题左对齐（⑂N 徽标迁行尾，bg-live 呼吸
              点随行尾不再缩进摘要）；r3=源胶囊+团队 chip+元信息+引擎徽统一排。紧凑档
              footC 第四行退役（org 息由 PM chip/入口卡承载、cwd 在详情页），原 compact
              独立分支拆除 */}
          <View style={styles.srow}>
            <AvaBadge
              letter={(s.title || "未").trim().slice(0, 1) || "未"}
              /* #227 三排定稿②：品牌化头像——非 PM 会话且有品牌图标时头像=引擎图标居中
                 （EngineIcon 裸标）；PM/Leader 保留字母头像（P/L 有特殊辨识意义） */
              brandIcon={effEngine}
              roleKind={roleKind}
              /* A3-7 查漏（桌面 UIPOLISH2 件一同口径）：头像底色=引擎品牌色淡彩（引擎
                 语义徽章/状态灯/身份头像三分离）；词表外引擎回落源色（不丢信息） */
              srcColor={ENGINE_ACCENT[effEngine ?? "claude"] ?? (srcBadge ? srcBadge.color : null)}
              dotColor={dotColor}
              breathe={s.status === "WORKING" || bgLive}
              size={compact ? 26 : 34}
            />
            <View style={styles.srowMain}>
              <View style={styles.srowR1}>
                <Text style={[styles.srowTitle, idle && styles.titleIdle]} numberOfLines={1}>
                  {s.title || "未命名会话"}
                </Text>
                {/* W-MOBFUSION 件①：图钉行内化（时间戳左侧，桌面同款；非置顶不显） */}
                {s.pinned === true ? <Text style={styles.pinIc}>📌</Text> : null}
                <Elapsed s={s} />
              </View>
              <View style={styles.srowR2}>
                {s.status === "WORKING" ? (
                  <LiveStat s={s} />
                ) : s.status === "WAITING" && s.waiting_request ? (
                  <Text style={[styles.srowSum, styles.sumWaiting]} numberOfLines={1}>需要确认 · {s.action_summary || ""}</Text>
                ) : (
                  <Text style={styles.srowSum} numberOfLines={1}>{s.action_summary || "…"}</Text>
                )}
                {/* 件①：⑂N 徽标迁行尾（原行首缩进摘要=「摘要与标题不对齐」根因之一） */}
                {bgCount > 0 ? (
                  <>
                    <R2LiveDot />
                    <Text style={styles.srowBgTag}>⑂{bgCount}</Text>
                  </>
                ) : null}
              </View>
              {/* r3 徽章行（W-MOBFUSION 件①统一排）：源胶囊 → 团队 chip → 元信息
                  （foldMeta 超 3 折叠 +N；紧凑档=仅 📁，R2 审查折衷）→ 弹性 → 引擎徽；
                  全空整行不渲染 */}
              {srcBadge || (teamChips && teamChips.length > 0) || metaRow.shown.length > 0 || metaRow.hidden > 0 || engineBadgeable(effEngine ?? undefined) ? (
                <View style={styles.srowR3}>
                  {/* #233 源标签标签化（W-CARDTAGS2）：桌面同款胶囊——源色底+E6、白字
                      8.5 粗、radius 4.5、padding 5.5/1.5、clipSrcName 限长；电脑图标入囊 */}
                  {srcBadge ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: srcBadge.color + "E6", borderRadius: 4.5, paddingHorizontal: 5.5, paddingVertical: 1.5 }}>
                      <Svg width={9} height={9} viewBox="0 0 24 24">
                        <Rect x="2" y="3.5" width="20" height="13.5" rx="2" fill="rgba(255,255,255,0.92)" />
                        <Path d="M8 21h8" stroke="rgba(255,255,255,0.92)" strokeWidth="2.4" strokeLinecap="round" />
                      </Svg>
                      <Text style={{ fontSize: 8.5, color: "#FFFFFF", fontWeight: "700", letterSpacing: 0.3 }} numberOfLines={1}>{clipSrcName(srcBadge.name)}</Text>
                    </View>
                  ) : null}
                  {/* W-FB66ALL ⑦（用户 1025：引擎左/目录右，双端统一）：r3 左=源胶囊+引擎徽，
                      右=📁 目录（PM/Leader 不显）→团队 chip 恒最右 */}
                  {engineBadgeable(effEngine ?? undefined) ? <EngineBadge engine={effEngine ?? undefined} size="sm" /> : null}
                  <View style={{ flex: 1 }} />
                  {metaRow.shown.map((m) => (
                    <Text key={m} style={styles.srowMeta} numberOfLines={1}>{m}</Text>
                  ))}
                  {metaRow.hidden > 0 ? <Text style={styles.srowMeta}>+{metaRow.hidden}</Text> : null}
                  {(teamChips ?? []).map((ch) => (
                    <TeamChip key={ch.gid} chip={ch} />
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        </>
      )}
    </CardShell>
  );
});

// W-EXPOLISH 迁出锚：组织域（组织区/组详情弹窗/决议 ACK 门）→ screens/ 组织模块与
// 团队·项目 tab 宿主；通知中心弹层（含 ACK 门）→
// ./NotifCenterPage.tsx（通知 tab 宿主，会话页铃铛入口同步退役）；设置抽屉 →
// ./SettingsPage.tsx（设置 tab 宿主，logo 落点改切 tab）。卡片组织徽标（orgTag）
// 仍需组名映射，projNameById 保留在本屏。

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onOpenSettings, onOpenArtPool, onOpenTeam, dirFilter, onClearDirFilter, ref }: Props) {
  const { c } = useTheme();
  const { mode, toggle } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const snap = useRelay();
  const density = useListDensity();
  // #140 折叠空闲与闲置变灰联动：列表级阈值（与卡片蒙层同源），折叠判定用
  const idleDimMin = useIdleDimMin();
  // 布局循环切换（统计行胶囊）：标准→紧凑→极简→标准，点击即写回 display-settings
  const cycleDensity = useCallback(() => {
    const i = DENSITY_ORDER.indexOf(density);
    setListDensity(DENSITY_ORDER[(i + 1) % DENSITY_ORDER.length]);
  }, [density]);
  // #52 聚合胶囊开关：与设置抽屉拨杆同款双写（持久化 + store 生效）
  const toggleAggregate = useCallback(() => {
    const next = !snap.aggregate;
    persistAggregate(next);
    store.setAggregate(next);
  }, [snap.aggregate]);
  // 件六①：长按菜单目标（null=关）；置顶/重命名/复制 ID/删除四操作贴底 sheet
  const [menuFor, setMenuFor] = useState<SessionState | null>(null);
  // 件六回归②：团队收纳组展开集（默认空=全折叠）+「进行中」组开态（默认展开）
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  useEffect(() => {
    void AsyncStorage.getItem(TEAM_EXPANDED_KEY).then((v) => {
      try {
        const arr = JSON.parse(v ?? "[]");
        if (Array.isArray(arr)) setExpandedTeams(new Set(arr.filter((x): x is string => typeof x === "string")));
      } catch {}
    });
  }, []);
  const [renameSid, setRenameSid] = useState<string | null>(null);
  // W-PORT-B P0-2：会话列表搜索——顶栏图标展开搜索条，输入即过滤（sessionSearchTest）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const renameTarget = useMemo(
    () => sessions.find((s) => s.session_id === renameSid) ?? null,
    [sessions, renameSid],
  );
  const handleRename = useCallback((sid: string) => setRenameSid(sid), []);
  // 件六①：置顶切换（桌面右键菜单同链）——COMMAND_PIN_SESSION 写穿 + SESSION_UPDATED
  // 权威回显收敛（LAN 往返快，不做本地乐观覆盖；unpin 休眠卡由 relay 联动摘 saved）
  const togglePin = useCallback((s: SessionState) => {
    store.send("COMMAND_PIN_SESSION", { session_id: s.session_id, pinned: s.pinned !== true });
  }, []);

  // #49/#139 休眠卡点按 = 按需恢复（对齐桌面端）：此前手机端没有实现保存恢复，
  // relay 下发的「已保存，点击恢复」摘要在手机上成了死文案——点卡只打开详情，
  // 恢复从未发生。恢复失败走 SESSION_ERROR（卡片转「恢复失败」可重点重试），
  // 未连接等前置错误由全局 Toast 负责（与删除路径同口径）
  // A4-6：长按复制会话 ID（桌面右键菜单「复制 ID」的手机等价）——剪贴板直写 + 轻
  // 震动 + Alert 回显（复制无可见反馈=死动作；回显用系统弹窗不占自绘浮层层级）
  const copySessionId = useCallback((sid: string) => {
    try { Vibration.vibrate(10); } catch {}
    void Clipboard.setStringAsync(sid);
    Alert.alert("会话 ID 已复制", sid);
  }, []);
  const handleResumeSaved = useCallback((sid: string) => {
    store.send("COMMAND_RESUME_SESSION", { session_id: sid });
  }, []);

  // 删除撤销（#247）：点删除只隐藏卡片 + 浮撤销条，4s 内可撤（纯客户端延迟提交），
  // 超时才真正发 COMMAND_DELETE——误触不丢会话。两次快速删除时前一条立即提交
  const [pendingDel, setPendingDel] = useState<string | null>(null);
  const pendingDelSid = useRef<string | null>(null);
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 离开列表页（进详情/设置）时挂起的删除视为确认：立即提交，静默丢弃反而反直觉
  useEffect(() => () => {
    if (delTimer.current) clearTimeout(delTimer.current);
    const cur = pendingDelSid.current;
    if (cur) store.send("COMMAND_DELETE", { session_id: cur });
  }, []);
  // 已提交待服务器确认的 sid：保持隐藏到 SESSION_DELETED 生效，防提交瞬间闪回；
  // 3s 兜底出列（发送失败/ACK 异常时卡片要能回来，错误提示由全局 Toast 负责）
  const [deleting, setDeleting] = useState<string[]>([]);
  const commitDelete = useCallback((sid: string) => {
    setDeleting((l) => (l.includes(sid) ? l : [...l, sid]));
    store.send("COMMAND_DELETE", { session_id: sid });
    setTimeout(() => setDeleting((l) => l.filter((x) => x !== sid)), 3000);
  }, []);
  // 服务器侧会话消失时：已提交项出列；挂起中的删除被别处删除终结——免得超时后
  // 对已不存在的会话发命令，弹"会话不存在"误报
  useEffect(() => {
    if (pendingDel && !sessions.some((s) => s.session_id === pendingDel)) {
      if (delTimer.current) {
        clearTimeout(delTimer.current);
        delTimer.current = null;
      }
      pendingDelSid.current = null;
      setPendingDel(null);
    }
    if (deleting.length) {
      const next = deleting.filter((sid) => sessions.some((s) => s.session_id === sid));
      if (next.length !== deleting.length) setDeleting(next);
    }
  }, [sessions, pendingDel, deleting]);
  const requestDelete = useCallback((sid: string) => {
    // #207 离线源拦截：会话数据在源机器上，源离线时删除命令必然送不达——旧版
    // 照走乐观舞步（隐藏 4s+3s 兜底）到期卡片静默回归＝「删除又复活」（实发：
    // 手机删关机的公司电脑上的历史会话）。滑删当下点名源拦下，不进舞步
    const block = store.deleteBlockReason(sid);
    if (block) {
      store.notifyCmdError(block);
      return;
    }
    try { Vibration.vibrate(20); } catch {}
    if (delTimer.current) {
      clearTimeout(delTimer.current);
      delTimer.current = null;
      const prev = pendingDelSid.current;
      if (prev && prev !== sid) commitDelete(prev);
    }
    pendingDelSid.current = sid;
    setPendingDel(sid);
    delTimer.current = setTimeout(() => {
      delTimer.current = null;
      const cur = pendingDelSid.current;
      pendingDelSid.current = null;
      setPendingDel(null);
      if (cur) commitDelete(cur);
    }, 4000);
  }, [commitDelete]);
  const undoDelete = useCallback(() => {
    if (delTimer.current) {
      clearTimeout(delTimer.current);
      delTimer.current = null;
    }
    pendingDelSid.current = null;
    setPendingDel(null);
  }, []);
  const pendingTitle = useMemo(
    () => sessions.find((s) => s.session_id === pendingDel)?.title ?? "",
    [sessions, pendingDel],
  );
  // 状态图例浮窗（统计行 ？ 呼出）
  const [legendOpen, setLegendOpen] = useState(false);
  // W-EXPOLISH 件六：通知中心入口回挂顶栏铃铛（用户拍板：通知放底部太挤，主流做法
  // 右上角通知——件二的通知 tab 撤销，弹层组件 NotifCenterSheet 保留复用）
  const [notifOpen, setNotifOpen] = useState(false);
  // 顶栏品牌区副标题：当前连接的服务器名（多源场景区分不同来源）。
  // 抽屉时代「关上时重读」；抽屉退役（W-EXPOLISH 件三）后改随活动源变化重读——
  // srcMenu 切源 / 设置页改连不重挂载本页，副标题要跟着换
  const [activeName, setActiveName] = useState("");
  useEffect(() => {
    void Promise.all([store.loadServers(), store.activeServerId()])
      .then(([list, id]) => {
        const active = list.find((e) => e.id === id) ?? list[0];
        setActiveName(active?.name?.trim() ?? "");
      })
      .catch(() => {});
  }, [snap.activeSourceId, snap.sources.length]);

  // 通知 badge（未处理数）：与弹层 rows 同源同口径（notifActionableOf，全源平铺，
  // 三戳全空才算未决）——铃铛胶囊「通知 · N」只随权威账收缩，打开不清零
  const notifPending = useMemo(
    () => notifActionableOf(snap.sources.flatMap((x) => x.notifications ?? [])),
    [snap.sources],
  );
  // W-HEAD4 ②：会话四态计数（副题状态灯数据——V3 五色词表：working/waiting/done/error）
  const sessionStatCounts = useMemo(() => {
    const c2 = { working: 0, waiting: 0, done: 0, error: 0 };
    for (const s of snap.sessions) {
      const st = s.status;
      if (st === "WORKING") c2.working++;
      else if (st === "WAITING") c2.waiting++;
      else if (st === "DONE") c2.done++;
      else if (st === "ERROR") c2.error++;
    }
    return c2;
  }, [snap.sessions]);

  // 硬件返回（#282）：浮层开着时先关浮层而不是退出 App（列表页是根路由）。
  // 原两处局部 BackHandler 订阅已并入 App.tsx 顶层单订阅，这里经 ref 句柄承接分发。
  // 通知中心弹层纳入返回栈最前位——返回键只关浮层，列表分组/滚动位/未决计数零触碰
  // （打开不清零，返回也不重置）；抽屉已随件三退役，返回栈=通知弹层+图例浮窗
  useImperativeHandle(ref, () => ({
    requestBack: () => {
      if (notifOpen) {
        setNotifOpen(false);
        return true;
      }
      if (legendOpen) {
        setLegendOpen(false);
        return true;
      }
      return false;
    },
  }), [notifOpen, legendOpen]);

  // 左缘手势条随抽屉退役（W-EXPOLISH 件三）：它的唯一用途是呼出设置抽屉，设置升
  // 独立 tab 后手势与常驻 tab 入口重复——移除，避免维护第二入口路径
  // #240 W-LEADERHIDE：Leader 会话识别集——组织锚 id（SNAPSHOT.leader_session_id，唯一
  // 可靠识别：锚不在任何团队编制 headcount，2026-10-23 生产 projects.json 实锤）+ 编制
  // role 词表（leader|领队）反查双口径。词表不含 pm：PM 会话照常出卡（桌面同口径，语义
  // 判别=删 Leader 形制卡非 PM 会话卡）。滤点收在 sorted 上游单口：状态 chip 计数/折叠
  // 空闲钮/可见列表三消费方自动同口径（卡面不出现而计数 +1 的漂移在源头消除）
  const leaderSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const src of snap.sources) {
      if (src.leaderSessionId) ids.add(src.leaderSessionId);
      for (const g of src.projects ?? []) {
        for (const m of g.headcount ?? []) {
          if (/^(leader|领队)$/i.test(String(m.role || ""))) ids.add(m.session_id);
        }
      }
    }
    return ids;
  }, [snap.sources]);
  const sorted = useMemo(() => {
    // 活跃（等待/运行/错误）置顶，其余按最近更新倒序：
    // 新完成的会话紧跟活跃段，不再"闪现后跳到 20 个会话底部"像消失。
    // #294 批2：聚合时 sessions 已是全源平铺，同一比较器作用于合并列表；
    // 分组态在下方 rows memo 里按 src 分区（组间按组内最近活动排序），组内沿用本排序
    // #100 后台在跑（子 Agent 未收尾）视同活跃置顶——派了任务却沉底像消失
    const rank = (s: SessionState) =>
      s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR" ||
      (s.subagents ?? []).some((a) => !a.ended_at) ? 0 : 1;
    // #240 W-LEADERHIDE：Leader 卡不进列表基准集（用户口径①；桌面 renderMyList 同批同口径）
    return [...sessions].filter((s) => !leaderSessionIds.has(s.session_id)).sort(
      (a, b) => rank(a) - rank(b) || (b.updated_at ?? b.started_at) - (a.updated_at ?? a.started_at),
    );
  }, [sessions, leaderSessionIds]);

  // 聚合多源 = 分组态（信息层级重设计：#294 批2 逐卡源角标改为分组头归属）；
  // 统计行「N 源聚合」/空态文案/顶栏副标题沿用同一开关
  const badgeOn = snap.aggregate && snap.sources.length > 1;
  // E2a 分组渲染条件：聚合 + 多源 + 源活动能力在（source_capabilities.activity，
  // 旧 relay legacy 缺省 = 降级「—」占位组，不逐源分组）。分组头已交代归属时
  // 逐卡源角标同步收起，避免同屏双份源标注
  const grouped = badgeOn && snap.sourceCapabilities?.activity === true;
  // 聚合源在线数（#294 批4）：统计行「N 源聚合」与空态「online/total 源」共用
  const onlineSrcs = snap.sources.filter((x) => x.state === "online").length;
  // 唯一在线源（在线源=1 时列表平铺单源视图）：唯一在线源即"当前源"，顶栏副标题
  // 点名该源（「源：X」）替代「N 源聚合」概览——连接 chip 的「1/N 在线」仍交代聚合态
  const soloOnline = onlineSrcs === 1 ? snap.sources.find((x) => x.state === "online") ?? null : null;
  const soloName = soloOnline ? displaySrcName(soloOnline.name) : "";

  const counts: Record<string, number> = {};
  for (const s of sorted) { // #240：吃 leader 滤后基准集——chip 计数与卡面同口径
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  // P0 加固（Fabric addViewAt 闪退）：统计 chip 从「过滤 0 值动态 map」改「定长四槽
  // 常挂 + display 切换」——连接成功 SNAPSHOT 一帧内 0→N 个 chip 连环插入是 re-parent
  // 冲突高发面（真机+模拟器复现连上即崩循环）。槽序=STATUS_ORDER，视觉零差异
  const statusItems = (["WORKING", "WAITING", "ERROR", "DONE"] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ k, n: counts[k], color: statusColor(k, c) }));
  const artPoolOn = useMemo(() => snap.sources.some(artPoolGate), [snap.sources]);

  // #357 连接 chip 三态色（用户定）：已连接=绿 / 连接中·重连中=黄 / 连不上=红
  const connColor =
    connected || snap.connState === "online"
      ? c.done
      : snap.connState === "connecting" || snap.connState === "reconnecting"
        ? c.working
        : c.waiting;

  const [collapseIdle, setCollapseIdle] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("ccr_collapse_idle").then((v) => setCollapseIdle(v === "1"));
  }, []);
  const toggleCollapse = () => {
    setCollapseIdle((v) => {
      void AsyncStorage.setItem("ccr_collapse_idle", v ? "0" : "1");
      return !v;
    });
  };
  // #140 折叠空闲与闲置变灰联动（用户拍板口径）：只折「已变灰」的真闲置卡——
  // isIdleSession 与卡片蒙层同一判定（DONE/ERROR 且静默超 idleDimMin，#100 后台
  // 在跑豁免）。刚收工的会话处在交流窗口期，点折叠也不从面板消失；idleDimMin<0
  // （永不变灰）→ 无可折叠卡，按钮隐藏。计数 = 闲置卡数（不再是全部 DONE 数）
  const idleCount = useMemo(
    () => sorted.filter((s) => isIdleSession(s, idleDimMin)).length,
    [sorted, idleDimMin],
  );
  const visible = useMemo(
    () => (collapseIdle ? sorted.filter((s) => !isIdleSession(s, idleDimMin)) : sorted)
      .filter((s) => s.session_id !== pendingDel && !deleting.includes(s.session_id))
      // 件三目录过滤（桌面 getSessionProject 归一口径：\ 归 / 、尾斜杠剥除、含子目录）
      .filter((s) => {
        if (!dirFilter) return true;
        const d = String(s.cwd || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
        const f = dirFilter.replace(/[\\/]/g, "/").replace(/\/+$/, "");
        return !!d && !!f && (d === f || d.startsWith(f + "/"));
      })
      // W-PORT-B P0-2：搜索过滤挂链末端（段头/组头计数与待处理段自然联动）
      .filter((s) => sessionSearchTest(s, searchQ)),
    [sorted, collapseIdle, idleDimMin, pendingDel, deleting, dirFilter, searchQ], // #240：leader 滤点收在 sorted 上游单口，此处不再重复滤
  );

  // E2a 行模型 = 纯函数投影（buildListProjection）：待处理段置顶（E2a-up 富版：
  // 可决策 WAITING/待验收/未决 actionable 通知/有活动证据的 WORKING，非 WAITING
  // 全占的简版）→ 其他会话按模式分流（单源平铺 / 聚合多源按源分组 / legacy 降级
  // 「—」占位组）。行包装对象每快照重建无妨——会话对象引用原样透传，SessionCard
  // memo 的行级重渲不受影响；组头/段头 count 一律=去重后实际卡数
  const projection = useMemo(
    () => buildListProjection({
      sessions: visible,
      aggregate: snap.aggregate,
      sources: snap.sources,
      sourceActivityCap: snap.sourceCapabilities?.activity === true,
      // E2a-up：全源归一通知池（各源 notifications 平铺；旧 relay null → 空池降级）
      notifications: snap.sources.flatMap((x) => x.notifications ?? []),
      // 件六回归②：跨源项目组平铺（团队收纳归属数据）
      projects: snap.sources.flatMap((x) => x.projects ?? []),
      // W-MOBFUSION R2（审查 B P1）：入口卡统计吃全量（过滤前），平铺卡仍吃 visible
      teamStatsSource: sessions,
    }),
    [visible, sessions, snap.aggregate, snap.sources, snap.sourceCapabilities],
  );
  // 件六回归②：折叠态滤行（桌面「折叠不进 DOM」同语义）——团队组默认折叠（展开态
  // AsyncStorage 持久 = 用户展开过的组），「进行中」默认展开；段头恒渲染（计数自投影）
  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (const r of projection) {
      if (r.kind === "section") {
        const collapsed = r.grp === "team" ? !expandedTeams.has(r.key) : false;
        out.push({ h: "sec", key: r.key, label: r.label, count: r.count, grp: r.grp, collapsed, ...(r.teamColor ? { teamColor: r.teamColor } : {}) });
        continue;
      }
      if (r.kind === "source") {
        out.push({ h: "src", key: r.key, name: r.name, color: r.color, online: r.online, count: r.count });
        continue;
      }
      if (r.kind === "team-entry") {
        out.push({ h: "team", key: r.key, gid: r.gid, name: r.name, ...(r.teamColor ? { teamColor: r.teamColor } : {}), rosterN: r.rosterN, running: r.running, minis: r.minis, hidden: r.hidden });
        continue;
      }
      if (!r.grp) {
        out.push({ h: false, key: r.key, s: r.s });
        continue;
      }
      const hidden = r.grp.startsWith("team-") ? !expandedTeams.has(r.grp) : false;
      if (!hidden) out.push({ h: false, key: r.key, s: r.s });
    }
    return out;
  }, [projection, expandedTeams]);
  // 折叠组头点按：团队组切换展开（AsyncStorage 持久展开集）；「进行中」组切换折叠
  const toggleSection = useCallback((key: string) => {
    if (key.startsWith("team-")) {
      setExpandedTeams((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        void AsyncStorage.setItem(TEAM_EXPANDED_KEY, JSON.stringify([...n]));
        return n;
      });
      return;
    }
  }, []);
  // #59 逐卡源归属角标（用户点单：聚合模式卡片要能分辨哪台电脑）：聚合开启且未
  // 走分组头（降级/单在线源混排）时恒显；配色与分组头共用 sourcePalette，同屏稳定
  // W-SRC2 #134：nameOf miss（src id 在 sources 列表失配——云源离线残留卡/清单竞态）
  // 回落会话自带的 relay_source（relay SNAPSHOT 现随每条会话下发本源显示名），不再
  // 裸显「其他」——聚合模式逐卡标签双保险
  const srcBadgeMap = useMemo(() => {
    if (!badgeOn || grouped) return null;
    const nameOf = new Map(snap.sources.map((x) => [x.id, displaySrcName(x.name)] as const));
    const colorOf = sourcePalette(snap.sources);
    return (src: string | undefined, relaySource?: string): { name: string; color: string } | null => {
      if (!src && !relaySource) return null;
      const name = nameOf.get(src ?? "") ?? (relaySource ? displaySrcName(relaySource) : "其他");
      return { name, color: colorOf.get(src ?? "") ?? srcColor(src ?? relaySource ?? "") };
    };
  }, [badgeOn, grouped, snap.sources]);
  const srcBadgeOf = srcBadgeMap ?? (() => null);

  // #26 M2 组织域（W-EXPOLISH 件三：组织区/决议/组详情迁团队·项目 tab——
  // 见文件头迁出锚）。本屏保留组名映射：会话卡的组织徽标（orgTag）依赖
  // project_gid → 组名（无组回落派单档位）
  const projNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const src of snap.sources) for (const g of src.projects ?? []) m.set(g.id, g.name);
    return m;
  }, [snap.sources]);
  // W-WAVE1 件②（#97）：PM/Leader 成员卡角色徽——从快照 projects[].headcount 反查本
  // 会话的编制角色（团队归属名 orgTag 已有 #26 M2，本件补「是 PM/Leader」维度：用户
  // 1014「PM 卡加团队归属标识」成员侧半边）。词表与桌面 SLIM_KEEP_ROLE 同源；非 PM
  // 零前缀零渲染（文本融合进 orgTag 单口——标准档元信息行/紧凑档目录位双形态自动继承）
  const pmSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const src of snap.sources) {
      for (const g of src.projects ?? []) {
        for (const m of g.headcount ?? []) {
          if (/^(pm|leader|产品经理|项目经理|领队)$/i.test(String(m.role || ""))) ids.add(m.session_id);
        }
      }
    }
    return ids;
  }, [snap.sources]);
  // W-CRABINTEGRATE（用户 1025 图集点选）：PM/Leader 角色种类图——头像变体判定源
  //（PM=举旗蟹 D2 / Leader=皇冠蟹 A1；两遍扫描保 leader 优先=皇冠压举旗；词表与
  // pmSessionIds/桌面 SLIM_KEEP_ROLE 同源）。worker 不入图=头像零变化
  const pmRoleKindOf = useMemo(() => {
    const m = new Map<string, "pm" | "leader">();
    for (const src of snap.sources) {
      for (const g of src.projects ?? []) {
        for (const mem of g.headcount ?? []) {
          const role = String(mem?.role || "");
          if (/^(pm|产品经理|项目经理)$/i.test(role) && mem?.session_id) m.set(mem.session_id, "pm");
        }
      }
    }
    for (const src of snap.sources) {
      for (const g of src.projects ?? []) {
        for (const mem of g.headcount ?? []) {
          const role = String(mem?.role || "");
          if (/^(leader|领队)$/i.test(role) && mem?.session_id) m.set(mem.session_id, "leader");
        }
      }
    }
    return m;
  }, [snap.sources]);
  const orgTagOf = useCallback(
    (s: SessionState) => {
      const base = s.project_gid ? projNameById.get(s.project_gid) ?? "项目组" : s.dispatch_tier ?? null;
      return base && pmSessionIds.has(s.session_id) ? `PM · ${base}` : base;
    },
    [projNameById, pmSessionIds],
  );

  // W-MOBFUSION 件③：PM 卡团队 chip 数据（桌面 pmTeamChipOf 同构）——编制 headcount
  // 反查 KEEP_ROLE 命中；gid 去重先建赢（聚合跨源平铺同团队不双 chip）；idle=编制内
  // 已同步 WORKING=0（桌面 E5 同判）。R2（审查 A/B P1-2）：预建 sid→chips Map + 空态
  // 模块常量——原 renderItem 每卡现调返回新数组（非 PM 恒新 []）→ SessionCard memo
  // 全卡击穿，流式每 tick 全列表重渲
  const chipsBySid = useMemo(() => {
    const sessionsBySid = new Map(snap.sessions.map((x) => [x.session_id, x] as const));
    const acc = new Map<string, PmTeamChip[]>();
    const seen = new Set<string>();
    for (const src of snap.sources) {
      for (const g of src.projects ?? []) {
        if (g.status === "archived" || seen.has(g.id) || !Array.isArray(g.headcount)) continue;
        seen.add(g.id);
        const running = g.headcount.reduce((n, m) => {
          const x = m && sessionsBySid.get(m.session_id);
          return n + (x && x.status === "WORKING" ? 1 : 0);
        }, 0);
        for (const m of g.headcount) {
          if (!m || !SLIM_KEEP_ROLE.test(String(m.role || ""))) continue;
          const list = acc.get(m.session_id) ?? [];
          list.push({ gid: g.id, name: g.name || g.id, accent: srcColor(g.id), idle: running === 0, n: g.headcount.length, running }); // W-ENGLM2 F：running=活跃数（数字位）
          acc.set(m.session_id, list);
        }
      }
    }
    return acc;
  }, [snap.sources, snap.sessions]);

  // W-MOTION：换源/过滤/聚合切换/增删卡 → 列表布局补间（key 序列指纹驱动：同集合
  // 内容微更新不触发——防 RecyclerView 复用幽灵动画；Android 实验开关+异常静默降级）
  const rowKeySeq = useMemo(() => rows.map((r) => r.key).join("|"), [rows]);
  useLayoutPulse(rowKeySeq);

  // 下拉刷新 = 断开重连一次（重走快照），在线即收起转圈；3s 兜底
  const [refreshing, setRefreshing] = useState(false);
  // 顶栏设备图标源切换菜单（方案 A）：snap.sources 只含运行态摘要，connectServer
  // 需要完整落库条目（token/cloud）——开菜单时载入一次
  const [srcMenu, setSrcMenu] = useState(false);
  const [srvEntries, setSrvEntries] = useState<import("../store").ServerEntry[]>([]);
  useEffect(() => {
    if (srcMenu) void store.loadServers().then(setSrvEntries);
  }, [srcMenu]);
  useEffect(() => {
    if (refreshing && snap.connState === "online") setRefreshing(false);
  }, [refreshing, snap.connState]);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    // 刷新 = 数据新鲜度，不是链路重启（2026-09-16 用户反馈：下拉把 2/2 在线全干断）。
    // resumeProbe：在线源 ping-resume（relay 按 last_seq 补发漏掉的事件）、死链判死重连、
    // 退避中的源立即重试——连接零扰动
    store.resumeProbe();
    setTimeout(() => setRefreshing(false), 3000);
  };
  // 底部上拉刷新（#255）：滚到底即触发同一 refresh；冷却 8s 防连续滚动反复重连。
  // 列表上方堆满已完成会话时免滚回顶部下拉。
  // 守卫：onEndReached 在内容不满一屏时挂载即触发、用户停在底部时流式重渲也会反复触发
  // ——「拖拽装弹」：只有真实拖过一次列表，onEndReached 才允许消费一次触发（防止
  // 打开列表就断链重连、清掉在途命令 ACK 追踪）
  const lastFootRefresh = useRef(0);
  const scrollArmed = useRef(false);
  const footRefresh = () => {
    if (!scrollArmed.current) return;
    scrollArmed.current = false;
    if (refreshing || Date.now() - lastFootRefresh.current < 8000) return;
    lastFootRefresh.current = Date.now();
    refresh();
  };


  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.topbar}>
        {/* W-HEAD4 ①②：会话页大标题+五色状态灯计数副题（用户 1016 拍板四页统一；
            源胶囊/铃铛本页原有③④天然满足）——状态计数直扫 snap.sessions 四态 */}
        <View style={{ flexShrink: 0, marginRight: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={styles.headTitleT}>会话</Text>
            {/* W-HEAD6 追加：源切换标题行内联（与 PageHead 同位——间隔 8px 垂直居中） */}
            <View style={{ marginLeft: 8 }}>
              <SourceSwitch onOpenSettings={onOpenSettings} />
            </View>
          </View>
          <SessionStatSub counts={sessionStatCounts} />
        </View>
        {/* 件八（用户拍板 2026-10-12）：品牌行移除——「CC Deck」名+图标是单卡时代
            遗物（团队/项目页均无此行，风格不统一）；顶栏只留功能元素，品牌身份交
            系统状态栏/启动器图标。设置入口=底部导航设置域（logo 旧快捷位随之退役） */}

        {/* W-PORT-B P0-2：会话搜索入口（桌面件九同能力）——点按展开/收起统计行下
            搜索条；搜索激活时图标点亮（品牌色）作过滤中的可视锚 */}
        <Pressable
          style={styles.searchBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
          hitSlop={4}
          accessibilityLabel={searchOpen ? (searchQ ? `搜索中：${searchQ}，点按收起搜索条` : "搜索会话已展开，点按收起") : "搜索会话（名称、摘要、目录）"}
          onPress={() => setSearchOpen((v) => { if (v) setSearchQ(""); return !v; })}
        >
          <SearchGlyph color={searchOpen && searchQ ? c.brandA : c.dim} active={false} />
        </Pressable>
        {/* #350 主题切换从设置抽屉迁入主面板顶：连接 chip 旁，与状态信息同区 */}
        <Pressable
          style={styles.themeBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
          hitSlop={4}
          accessibilityLabel={mode === "dark" ? "深色主题，点击切浅色" : "浅色主题，点击切深色"}
          onPress={toggle}
        >
          {/* #67漏项补：主题钮对齐桌面端——emoji → 线条 SVG（太阳/月牙 stroke 线稿，
              与 web THEME_ICONS 同款；深色显太阳=点击切浅、浅色显月牙） */}
          <ThemeGlyph dark={mode === "dark"} />
        </Pressable>
        {/* W-MV8A 顶栏铃铛（v3 appbar bell + bbadge）：通知中心唯一入口（统计行
            「通知 · N」胶囊随之退役——入口唯一化，badge 红底白字=需你行动计数，
            与铃铛内页面副题同源 notifActionableOf）。badge 常挂 display 切换
            （P0 加固口径：条件插拔是 Fabric re-parent 崩面） */}
        <Pressable
          style={styles.bellBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
          onPress={() => setNotifOpen(true)}
          hitSlop={4}
          accessibilityLabel={notifPending.length > 0 ? `通知中心，${notifPending.length} 项需行动` : "通知中心"}
        >
          <BellGlyph color={c.dim} />
          <View style={[styles.bellBadge, notifPending.length <= 0 && styles.bellBadgeOff]} pointerEvents="none">
            <Text style={styles.bellBadgeT}>{notifPending.length > 99 ? "99+" : notifPending.length}</Text>
          </View>
        </Pressable>
        {/* W-EXPOLISH 件七：新增按钮统一「每域列表右上角 ＋」（对齐桌面 list-header
            右上角加号同语言）——会话页右下 FAB 退役（少一个悬浮遮挡元素，跨端动作
            位置肌肉记忆统一）；44px 触区，行为=原 FAB（新建会话弹层） */}
        {/* W-HEAD6 C：折叠空闲收进 head（原 statRow chip 迁入；有空闲才显） */}
        {idleCount > 0 ? (
          <Pressable
            style={[styles.headCollapseBtn, collapseIdle && styles.headCollapseBtnOn]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
            onPress={toggleCollapse}
            hitSlop={4}
            accessibilityLabel={collapseIdle ? `展开空闲会话 ${idleCount} 个` : "折叠空闲会话"}
          >
            <Text style={[styles.headCollapseT, collapseIdle && styles.headCollapseTOn]} numberOfLines={1}>
              {collapseIdle ? `闲 ${idleCount}` : "折闲"}
            </Text>
          </Pressable>
        ) : null}
        {/* W-HEAD6 C：输出物入口收进 head（原 statRow chip 迁入；能力开才显） */}
        {artPoolOn ? (
          <Pressable
            style={styles.headCollapseBtn}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
            onPress={onOpenArtPool}
            hitSlop={4}
            accessibilityLabel="打开全局输出物目录"
          >
            <Text style={styles.headCollapseT} numberOfLines={1}>物</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.plusBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
          onPress={onNew}
          hitSlop={4}
          accessibilityLabel="新建会话"
        >
          <PlusMark size={20} color={c.brandA} />
        </Pressable>
      </View>
      {/* W-HEAD6 C：statRow 整行退役——统计已由 head 副题承载（SessionStatSub）；
        密度三档迁设置页通用面板；折叠空闲/输出物收进 head；聚合开关入源切换浮窗 */}

      {/* W-PORT-B P0-2：搜索条（顶栏图标展开；桌面件九同过滤口径）。✕=清空；
          收起随顶栏图标（收起即清空——过滤残留是隐藏态，用户看不见却改了列表） */}
      {searchOpen ? (
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="搜索名称、摘要、目录"
            placeholderTextColor={c.faint}
            value={searchQ}
            onChangeText={setSearchQ}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel="搜索会话名称、任务摘要或工作目录"
          />
          {searchQ ? (
            <Pressable hitSlop={8} accessibilityLabel="清空搜索词" onPress={() => setSearchQ("")}>
              <Text style={styles.searchX}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* 件三目录过滤条（项目域「查看项目会话」跳入态）：目录名 + ✕ 清除回全量 */}
      {dirFilter ? (
        <View style={styles.dirBar}>
          <Text style={styles.dirBarT} numberOfLines={1}>
            项目会话 · {dirFilter.replace(/[\\/]/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/")}
          </Text>
          <Pressable hitSlop={8} accessibilityLabel="清除目录过滤，返回全部会话" onPress={onClearDirFilter}>
            <Text style={styles.dirBarX}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        // P0 加固②：stickyHeaderIndices 退役——FlatList Android 吸顶的 re-parent
        // 在 Fabric 下触发 Yoga owner 断言崩（YogaLayoutableShadowNode.cpp:709
        // YGNodeGetOwner!=yogaNode，SIGABRT，连接后 ~100s SNAPSHOT 大渲染期必崩，
        // 真机侧同根因表现为 addViewAt: failed to insert view）。段头改随滚动走
        // 密度切换强制重挂载：行高在极简(~40px)↔标准(~90px)间剧变时，
        // VirtualizedList 复用旧 cell 的陈旧布局度量导致整列空白（#392 回归，
        // 冷启动正常、仅切换路径复现）。key 换代即整体重建，窗口/度量全新
        key={density}
        data={rows}
        keyExtractor={(r) => r.key}
        ItemSeparatorComponent={ListRowSeparator}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={c.working}
            colors={[c.working]}
            progressBackgroundColor={c.panel}
          />
        }
        // G5（冲刺审查）：任务完成汇报悬浮钮（列表页让位 +52，浮钮形态用户拍板 #17）；
        // W-EXPOLISH 件七 FAB 退役后底部余量 120→64（无悬浮钮遮挡，UndoBar 浮层除外）
        contentContainerStyle={{ paddingBottom: insets.bottom + 64 + (snap.taskDoneQueue.length > 0 ? 52 : 0), paddingHorizontal: 0, paddingTop: 6 }}
        // #137 待填验收单条件卡：统计行下方、会话列表顶部（AccHeader 组件形态，见上）
        // P0 定版：header 用「组件形态」（AccHeader 自取数据、身份恒定）——元素形态
        //（内联 JSX/useMemo 节点）在 Fabric 下与 cell clone 交互触发 Yoga owner 断言崩
        //（YogaLayoutableShadowNode.cpp:709，连接后大渲染期必现），组件形态为 RN 文档口径
        ListHeaderComponent={AccHeader}
        onScrollBeginDrag={() => { scrollArmed.current = true; }}
        onEndReached={footRefresh}
        onEndReachedThreshold={0.2}
        ListFooterComponent={
          visible.length > 0 ? (
            <Pressable style={styles.footHint} disabled={refreshing} onPress={refresh} hitSlop={{ top: 10, bottom: 16 }}>
              <Text style={styles.footHintT}>{refreshing ? "刷新中…" : "↻ 下拉更新"}</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item, index: idx }) =>
          item.h === "sec" ? (
            <SectionHeader
              label={item.label}
              count={item.count}
              collapsible={!!item.grp}
              expanded={!item.collapsed}
              onToggle={item.grp ? () => toggleSection(item.key) : undefined}
              teamColor={item.teamColor}
            />
          ) : item.h === "src" ? (
            <GroupHeader name={item.name} color={item.color || c.faint} online={item.online} count={item.count} />
          ) : item.h === "team" ? (
            // W-MOBFUSION 件②：团队入口卡（worker 收纳的落点）——整卡点按跳团队域
            <TeamEntryCard e={item} onPress={() => onOpenTeam?.()} />
          ) : (
            <SessionCard
              s={item.s}
              onOpen={onOpen}
              onResume={handleResumeSaved}
              onCardMenu={setMenuFor}
              density={density}
              srcBadge={srcBadgeOf(item.s.src, item.s.relay_source)}
              orgTag={orgTagOf(item.s)}
              teamChips={chipsBySid.get(item.s.session_id) ?? EMPTY_CHIPS}
              roleKind={pmRoleKindOf.get(item.s.session_id) ?? null}
            />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>{searchQ ? `搜索「${searchQ.slice(0, 12)}」下暂无会话` : collapseIdle && idleCount > 0 ? "空闲会话已折叠" : "还没有会话"}</Text>
            {/* 空态文案规范：一句状态 + 一句指引，各 ≤15 字 */}
            <Text style={styles.emptyS}>
              {searchQ
                ? "换个词或点 ✕ 清空搜索"
                : collapseIdle && idleCount > 0
                ? "点上方「展开空闲」查看"
                : !connected
                  ? snap.connState === "unpaired"
                    ? "配对已失效\n点左上角图标重新配对"
                    : badgeOn
                      ? `${onlineSrcs}/${snap.sources.length} 源在线 · 重连中`
                      : "未连接 · 等待自动重连"
                  : badgeOn
                    ? onlineSrcs < snap.sources.length
                      ? `${snap.sources.length - onlineSrcs} 个源离线\n点右下角 ＋ 开始新会话`
                      : "点右下角 ＋ 开始新会话"
                    : "点右下角 ＋ 开始新会话"}
            </Text>
            {/* #116 正中间提示下面的三个点：重连中在居中提示下补 wave 三点（与右上角
                chip 同组件同节拍），让"正在重连"在视觉正中也可被感知 */}
            {snap.connState === "connecting" || snap.connState === "reconnecting" ? (
              <View style={{ marginTop: 12 }}>
                <ConnDots color={connColor} big />
              </View>
            ) : null}
          </View>
        }
      />

      {/* 左缘手势条随抽屉退役（W-EXPOLISH 件三）：透明覆盖条已删 */}

      {/* 右下角悬浮 FAB 退役（W-EXPOLISH 件七）：新建入口统一到顶栏右上角 ＋ */}

      {/* 删除撤销条（#247）：4s 窗口，撤销即恢复卡片；图例打开时收起（层级 60 之下防穿模） */}
      <UndoBar shown={!!pendingDel && !legendOpen} title={pendingTitle} onUndo={undoDelete} />

      <RenameModal
        visible={!!renameTarget}
        initial={renameTarget?.title ?? ""}
        onCancel={() => setRenameSid(null)}
        onSubmit={(title) => {
          if (renameTarget) store.send("COMMAND_RENAME", { session_id: renameTarget.session_id, title });
          setRenameSid(null);
        }}
      />

      {/* 件六①：长按操作菜单（贴底 sheet）——置顶/重命名/复制 ID/删除，语义对齐
          桌面右键菜单（UIPOLISH3 件一置顶全量解锁：外部/CLI/历史会话同权）；删除保
          运行中拦截（deletable）与 #207 离线源拦截（requestDelete 内） */}
      <CardMenuSheet
        target={menuFor}
        onClose={() => setMenuFor(null)}
        onPin={(s) => { togglePin(s); setMenuFor(null); }}
        onRename={(s) => { handleRename(s.session_id); setMenuFor(null); }}
        onCopyId={(s) => { copySessionId(s.session_id); setMenuFor(null); }}
        onDelete={(s) => { requestDelete(s.session_id); setMenuFor(null); }}
      />

      {/* 状态图例浮窗：统计行 ？ 呼出，点任意处收起 */}
      {legendOpen ? (
        <Pressable style={styles.legendScrim} onPress={() => setLegendOpen(false)}>
          <FadeIn dy={5}>
            <View style={styles.legendCard}>
              {(["WORKING", "WAITING", "ERROR", "DONE"] as const).map((k) => (
                <View key={k} style={styles.legendRow}>
                  <View style={[styles.legendDot, { backgroundColor: statusColor(k, c) }]} />
                  <Text style={styles.legendT}>{k.toLowerCase()}</Text>
                </View>
              ))}
              {/* 图标化后补说明（2026-09-14 用户提）：左上电脑图标=单源/聚合切换 */}
              <View style={[styles.legendRow, { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, marginTop: 4 }]}>
                <Text style={styles.legendT}>左上电脑图标：切换单源 / 聚合展示</Text>
              </View>
            </View>
          </FadeIn>
        </Pressable>
      ) : null}

      {/* W-EXPOLISH 件六：通知中心 sheet 弹层（铃铛/返回键呼出；组件保留复用——
          原件二 tab 页改贴底弹层形态回挂。打开/关闭零清零，池只读自快照。
          onJump：session 落点 onOpen 打开归因会话（导航聚焦）；task 落点由弹层内
          宿主 GroupModal 定位台账卡（target 仅该落点，jumpTargetOf 已把关） */}
      {/* P0 加固④：弹层改条件挂载——常挂 `<Modal visible={false}>`（内层 useRelay
          每帧重渲）在 Fabric 0.86 是 Yoga owner 断言崩的触发面之一（上游
          facebook/react-native#52349 未修；test.15 时代同款常挂 Modal 同崩）。
          notifOpen 时才挂载，打开语义不变 */}
      {notifOpen ? (
        <NotifCenterSheet
          open
          onClose={() => setNotifOpen(false)}
          onOpenSession={onOpen}
        />
      ) : null}
    </SafeAreaView>
  );
}

// W-EXPOLISH：通知中心弹层整体迁 ./NotifCenterPage.tsx（通知 tab 宿主），数据面/
// 分区/回跳/动作 ACK 门原样保持，此处不再保留弹层形态。

// P0 定版：验收单条件卡（原 ListScreen 内联 header）独立组件化——ListHeaderComponent
// 用组件形态（身份恒定）；数据自取（snap.sources + AsyncStorage seen），与原实现
// 逐字节同口径（#195 submitted 消失条件 / #28 云链接择路 / AsyncStorage key 不变）
function AccHeader() {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [accSeen, setAccSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    void AsyncStorage.getItem("ccr_acc_seen").then((v) => {
      if (!v) return;
      try { setAccSeen(new Set(JSON.parse(v) as string[])); } catch {}
    });
  }, []);
  const accPending = useMemo(() => {
    const out: { src: SourceStatus; a: AcceptanceSummary }[] = [];
    for (const src of snap.sources)
      for (const a of src.acceptances ?? [])
        if (!(a.submitted || a.done) && !accSeen.has(a.id)) out.push({ src, a });
    out.sort((x, y) => y.a.created_at - x.a.created_at); // 新单在前，卡显示最新一张
    return out;
  }, [snap.sources, accSeen]);
  const seenAcc = useCallback((id: string) => {
    setAccSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      void AsyncStorage.setItem("ccr_acc_seen", JSON.stringify([...next]));
      return next;
    });
  }, []);
  const openAcc = useCallback((item: { src: SourceStatus; a: AcceptanceSummary }) => {
    // 链接按源当前通道择路（同出单工具双发口径）；#28 起云链接带 per-sheet 密钥
    const url = item.src.channel === "lan" && item.src.lanHint
      ? `http://${item.src.lanHint}/acceptance/${item.a.id}`
      : `https://cc.humumu.online/view/acceptance-${item.a.id}.html${item.a.key ? `#${item.a.key}` : ""}`;
    void Linking.openURL(url).catch(() => undefined);
    seenAcc(item.a.id);
  }, [seenAcc]);
  const dismissAcc = useCallback((id: string) => seenAcc(id), [seenAcc]);
  if (!accPending.length) return null;
  return (
    <Pressable
      style={styles.accCard}
      android_ripple={{ color: c.tintSoft, borderless: false }}
      accessibilityLabel={`验收单待填：${accPending[0].a.title}，点击打开填写页面`}
      onPress={() => openAcc(accPending[0])}
    >
      <View style={styles.accTag}>
        <Text style={styles.accTagT}>验收单</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.accTitle} numberOfLines={1}>{accPending[0].a.title}</Text>
        <Text style={styles.accSub} numberOfLines={1}>
          {`待填 ${accPending[0].a.judged}/${accPending[0].a.total}`}
          {accPending.length > 1 ? ` · 另有 ${accPending.length - 1} 张` : ""}
        </Text>
      </View>
      <Text style={styles.accGo}>去填写 ›</Text>
      <Pressable
        style={styles.accClose}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 6 }}
        accessibilityLabel="不再提示该验收单"
        onPress={() => dismissAcc(accPending[0].a.id)}
      >
        <Text style={styles.accCloseT}>×</Text>
      </Pressable>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  // 统计行常驻钮（输出物入口；原铃铛钮同形制，W-EXPOLISH 起中性命名）
  chipBtn: {
    backgroundColor: c.tintSoft, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6,
  },
  chipT: { color: c.brandA, fontSize: 11, fontWeight: "700" },
  // ═══════ E2b：通知中心入口/Modal + 决议错误行 ═══════
  // M13-6E：已处理行时间戳（复用 notiSrc 灰态小字语言）+「已处理 N」折叠分区头
  // M13-6E：acceptance 域回跳按钮（未处理行「定位来源 ›」——ghost 同款形制小号化）
  // #137 待填验收单卡（列表顶部条件卡）：卡片形制对齐会话卡（panel 底/line 边/
  // 12 圆角），品牌色只点「验收单」标签与「去填写」动作（#102 品牌色克制）
  accCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 14, borderWidth: 1, marginBottom: 9, overflow: "hidden",
    backgroundColor: c.panel2, borderColor: withA(c.working, 0.35),
  },
  accTag: { backgroundColor: c.tintSoft, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  accTagT: { color: c.brandA, fontSize: 10, fontWeight: "700" },
  accTitle: { color: c.text, fontSize: 13, fontWeight: "600" },
  accSub: { color: c.dim, fontSize: 11, marginTop: 2 },
  accGo: { color: c.brandA, fontSize: 12, fontWeight: "600" },
  // #195 收卡按钮：弱化色 ×（faint），不与「去填写」抢焦点；纯本地隐藏
  accClose: { paddingLeft: 2 },
  accCloseT: { color: c.faint, fontSize: 16, fontWeight: "600", lineHeight: 18 },
  // 顶栏设备图标源切换菜单（方案 A）：右上锚定小面板，行=色点+名称+通道+当前标
  srcMenu: {
    position: "absolute", top: 52, right: 12, zIndex: 30, minWidth: 208,
    backgroundColor: c.panel2, borderRadius: 13, borderWidth: 1, borderColor: c.lineStrong,
    overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  srcRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  srcRowOn: { backgroundColor: c.tintSoft },
  srcMenuDot: { width: 8, height: 8, borderRadius: 4 },
  srcMenuName: { color: c.text, fontSize: 13, flex: 1 },
  srcMenuChan: { color: c.faint, fontSize: 11 },
  srcMenuOn: { color: c.done, fontSize: 11, fontWeight: "600" },
  srcMenuManage: { borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 12, paddingVertical: 10, marginTop: 2 },
  srcMenuManageT: { color: c.dim, fontSize: 12 },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    // 件八：品牌行移除后顶栏=纯功能行（连接 chip / 主题 / ＋），净高由这三件承担。
    // W-HEAD5（#148 用户拍板）：对齐详情页 d.head——弃 headBg 特别底色（常规 bg）、
    // paddingVertical 4、总高≈48px；headTitleT 15/600 c.text（d.title 同款）
    ...HEAD_BASE, /* W-HEADUNI：本页=用户指定全页基准（原字面三值提常量自证一致） */
    backgroundColor: c.bg, borderBottomWidth: 1.5, borderBottomColor: c.lineStrong, /* W-UIFIX 件三：分隔线加深加粗一档（line→lineStrong+1.5px，双主题可见不喧宾） */
  },
  headTitleT: { fontSize: 15, fontWeight: "600", color: c.text, lineHeight: 20 }, /* W-HEAD5：d.title 同款 */
  // #381 去框化：连接 chip 纯"点+文字"，不套胶囊框（同抽屉去框语言）
  connChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    height: 28, paddingHorizontal: 4,
    marginLeft: "auto",
  },
  connDot: { width: 6, height: 6, borderRadius: 3 },
  connText: { fontSize: 11 },
  // #77 返工（用户反馈）：对齐桌面端裸图标形制——无底色无边框纯线条 glyph
  //（桌面 #themeBtn 无背景，hover 底是 web 特有交互；点击区 28 保留好按）
  themeBtn: {
    width: 28, height: 28, alignItems: "center", justifyContent: "center",
  },
  themeBtnT: { fontSize: 13 },
  // #67漏项补：线条太阳（View 圆环+四向射线，与插头/云同 1.4px 描边语言）
  tgWrap: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  tgSun: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.4 },
  // 线条月牙：描边圆 + 偏移实心圆（按钮底色 tintSoft 遮出弯月）
  tgMoon: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.4 },
  tgMoonMask: { position: "absolute", width: 10, height: 10, borderRadius: 5, left: 4.5, top: -2.5 },
  statRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 5,
    height: 38,
  },
  statSrc: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  statTotal: { color: c.dim, fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  statChips: { flexDirection: "row", gap: 9 },
  statChip: { flexDirection: "row", alignItems: "center", gap: 3.5 },
  // P0 加固：常挂件的隐藏态 = display 切换（不插拔节点；display:none 不占 flex 位）
  statChipOff: { display: "none" },
  statDot: { width: 7, height: 7, borderRadius: 4 },
  statChipT: { fontSize: 11.5 },
  // ？ 图例按钮：淡色小圆圈问号
  helpBtn: {
    width: 15, height: 15, borderRadius: 8, borderWidth: 1, borderColor: c.line,
    alignItems: "center", justifyContent: "center", marginLeft: 2,
  },
  helpT: { fontSize: 10, color: c.faint, lineHeight: 12 },
  legendScrim: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.25)", zIndex: 60 },
  legendCard: {
    position: "absolute", top: 96, left: 18, minWidth: 128,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.lineStrong, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 14, gap: 8, elevation: 6,
  },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendT: { color: c.text, fontSize: 12.5 },
  // 源分组头：源色竖条+源名+在线点+会话计数，下衬 hairline 分区线（组间距 =
  // 头部上下留白 + 卡片自身 marginBottom，形成"区隔靠间距"的分区节奏）；
  // E2a 起组头吸顶（stickyHeaderIndices），自带页面底色防滚动叠加透字
  grpHead: {
    flexDirection: "row", alignItems: "center", gap: 7,
    marginTop: 12, marginBottom: 5, paddingHorizontal: 14,
    backgroundColor: c.bg,
  },
  // E2a 段头（待处理/其他会话）：分组只靠间距+小节标题（005 军规③——去下衬线）；
  // 吸顶行定高 + 自带底色；左缘与行内容对齐（14）
  // 件十：组间分界——hairline（首组不出线；分隔线在组头容器顶部）
  // 1013 用户反馈（真机截图红框）：组头降级为轻盈小节头——非粗黑（700→600）、
  // 计数弱化、团队色条 3px→2px 细线且降透明、底距放大给呼吸
  // #85 再重做（1014/1015 用户截图反馈：还是太高）：垂直占位 44→27px（marginTop
  // 20→8 / marginBottom 8→3，组间节奏交还 divider）；计数裸数字→胶囊（桌面 .tag
  // 语汇移动化=现代化可见变化）；行对齐 baseline→center（胶囊非纯文本）；
  // 标题 11.5→11 收紧，团队色条/chev 语言不动（1013 刚定的区分度保留）
  secHead: {
    marginTop: 12, marginBottom: 5, paddingHorizontal: 14, /* #218 件二：组间线退役后留白撑呼吸（上 12/下 5） */
    backgroundColor: c.bg,
  },
  secHeadRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  /* #218 件二：组间贴邻线已退役——与上一卡的行分隔线贴成双线是用户点名
     最丑处；组间分界改留白承载（secHead 上下呼吸位），组内卡间保留缩进细线 */
  // 团队色细线（原 3px 竖条过重——2px×10px 细线 + 半透明，双端区分度语言保留）
  secTeamBar: { width: 2, height: 10, borderRadius: 1, position: "absolute", left: 4, top: 2 },
  secHeadT: { color: c.dim, fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  // #85 计数胶囊：faint 弱底小 pill（圆角 999），数字 10pt tabular
  secCountPill: {
    backgroundColor: withA(c.faint, 0.16), borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 1, minWidth: 18,
    alignItems: "center", justifyContent: "center",
  },
  secCount: { color: c.dim, fontSize: 10, lineHeight: 13, fontVariant: ["tabular-nums"] },
  // 件六回归②：可折叠组头（团队收纳/进行中）caret——与 OrgTabs 未立项折叠头同语言
  secChev: { color: c.faint, fontSize: 11, lineHeight: 14 },
  // E2a 活动指标块：四行定高小字（行距 gap 3、lineHeight 定值、单行 ellipsis），
  // 键淡值常——activity 缺失/能力全关时整块不渲染
  grpBar: { width: 3, height: 13, borderRadius: 1.5 },
  grpName: { color: c.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.2, flexShrink: 1 },
  grpDot: { width: 6, height: 6, borderRadius: 3 },
  // #59 源归属角标：色点+源名小字（弱化色，行内右端、时长左侧）
  srcBadge: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, marginRight: 6 },
  srcBadgeDot: { width: 6, height: 6, borderRadius: 3 },
  srcBadgeT: { color: c.dim, fontSize: 10.5, fontWeight: "600", maxWidth: 84 },
  grpCount: { color: c.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  collapseBtn: {
    flexShrink: 1, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  collapseBtnOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  collapseT: { fontSize: 11, color: c.dim },
  collapseTOn: { color: c.brandA },
  // 布局循环胶囊：折叠空闲同款形制，负责把右侧按钮组推到行尾（collapseBtn 不再自带 auto）
  densityBtn: {
    marginLeft: "auto", flexShrink: 1, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  densityT: { fontSize: 11, color: c.dim },
  // #52 聚合胶囊（替代电脑图标）：densityBtn 同款形制；开=品牌色高亮
  aggBtn: {
    borderRadius: 999, borderWidth: 1, borderColor: withA(c.dim, 0.35),
    paddingHorizontal: 10, paddingVertical: 3, flexShrink: 1,
  },
  aggBtnOn: { borderColor: withA(c.brandA, 0.65), backgroundColor: withA(c.brandA, 0.1) },
  aggT: { fontSize: 11, color: c.dim },
  aggTOn: { color: c.brandA, fontWeight: "700" },
  // W-EXPO 005 通栏行（军规①②）：无框无圆角、行间零分隔线（纯留白分行）；卡面用
  // 页面底色保持不透明（左滑动作排藏在卡后，透明底会提前露出）
  // 1015 回归修复：eaf5a15（W-MLR2 续作）误把定版直角通栏行改回 13 圆角描边卡，
  // 用户 test.25 实测打回——形态键（圆角/底色/描边/行距）回 c6d1691 定版；
  // 行高回调（paddingVertical）系用户行高反馈闭环成果，保留不回退
  swipeWrap: { marginBottom: 2, borderRadius: 0, overflow: "hidden" },
  // W-LIST2 件一：卡间 hairline（色由组件内 withA(c.line,.6) 动态注入——双主题一套）
  rowSep: { height: 1 }, /* #242 桌面基准：通栏零缩进（桌面 border-top 卡 margin 0 顶满宽），1px 线高本值 */
  swipeWrapC: { marginBottom: 2 },
  swipeWrapM: { marginBottom: 1 },
  swipeCard: { borderRadius: 0, overflow: "hidden", backgroundColor: c.bg },
  // #32 离线源降权 + 空闲置灰：向页面背景渐隐的蒙层（不用 opacity——会让底层
  // 动作排透出，2026-09-17 测试机截图实锤）
  dimCover: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: withA(c.bg, 0.45) },
  // 件六①：长按操作菜单（贴底 sheet）
  menuMask: { flex: 1, backgroundColor: withA(c.bg, 0.72), justifyContent: "flex-end" },
  menuSheet: {
    backgroundColor: c.panel2, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderWidth: 1, borderColor: c.lineStrong, paddingHorizontal: 16,
    paddingTop: 14, paddingBottom: 30,
  },
  menuTitle: { color: c.text, fontSize: 14, fontWeight: "700", marginBottom: 8 },
  menuRow: { paddingVertical: 11, borderRadius: 12, paddingHorizontal: 6, gap: 2 },
  menuRowOff: { opacity: 0.42 },
  menuLabel: { color: c.text, fontSize: 14, fontWeight: "600" },
  menuHint: { color: c.faint, fontSize: 10.5 },
  card: {
    backgroundColor: "transparent", borderWidth: 0,
    borderRadius: 0, paddingVertical: 12, paddingHorizontal: 14, /* W-UIFIX 件五：高度+2（10→12 纵距） */
  },
  cardC: { borderRadius: 0, paddingVertical: 11, paddingHorizontal: 14 }, /* W-UIFIX 件五：紧凑档同步 +2 */
  // 极简平铺行：同通栏语言，行高最矮
  // 1013 高度压缩批：单行内容 ~31px 低于 44px 触控底线（改前 ~33 同欠账）——
  // minHeight 44 兜底 + 内容垂直居中（设置行 minHeight 48 同语言），视觉仍为三档最矮
  cardM: { borderRadius: 0, borderWidth: 0, paddingVertical: 8, paddingHorizontal: 14, minHeight: 44, justifyContent: "center" },
  rowC: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowM: { flexDirection: "row", alignItems: "center", gap: 7 },
  titleM: { color: c.text, fontSize: 14.5, fontWeight: "600", flexShrink: 1 }, /* W-UIFIX 件四：极简档同步 13.5→14.5 */
  // 极简行水位区（常显）：固定 64px 右对齐 = 细条轨道（44px）+ 9px 百分比/占位，
  // 有无水位各行右缘恒定不跳
  liveRow: { flexDirection: "row", alignItems: "center", marginBottom: 4, paddingLeft: 6 }, /* #83 二/三行缩进对齐标题文字（灯 11+gap 7）；1013 行距压缩 -1 */
  // #362 WORKING 实时工作行独立成第二行（标题让位第一行），与 sum 同底距
  titleC: { lineHeight: 19, color: c.text, fontSize: 15, fontWeight: "600", flexShrink: 1 }, /* W-UIFIX 件四：标题 14→15 加大一档 */
  sumC: { lineHeight: 14, color: c.faint, fontSize: 11, marginTop: 1 },
  footC: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
  folderC: { lineHeight: 13, fontSize: 10, color: c.dim, flexShrink: 1, maxWidth: 120 },
  dot: {
    width: 11, height: 11, borderRadius: 6, opacity: 1,
    alignItems: "center", justifyContent: "center",
  },
  elapsed: { fontSize: 10, color: c.faint, fontVariant: ["tabular-nums"] },
  liveStat: { flex: 1, fontSize: 12, color: c.dim, fontVariant: ["tabular-nums"] },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { color: c.text, fontSize: 15, fontWeight: "600", marginBottom: 3, flexShrink: 1 },
  // ---------- W-EXPO 005 srow 通栏行 ----------
  srow: { flexDirection: "row", alignItems: "center", gap: 11 },
  ava: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" }, // 双端对齐：9 方块→17 圆（=34/2，桌面 .srow-ava 50% 同口径）
  avaT: { fontSize: 15, fontWeight: "700" },
  // 1013 高度压缩批（默认密度行距各收一档）：行间 gap 3→2、r1 19→18、r2 16→15——
  // 卡片 pitch ~73→~65px（-11%）；内容高 51 仍 > 头像地板 34，不触发塌陷
  srowMain: { flex: 1, minWidth: 0, gap: 2 },
  srowR1: { flexDirection: "row", alignItems: "center", gap: 6 },
  srowTitle: { lineHeight: 18, flex: 1, color: c.textStrong, fontSize: 13.5, fontWeight: "600" },
  srowR2: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 15 },
  srowSum: { flex: 1, color: c.dim, fontSize: 12, lineHeight: 15 },
  srowBgTag: { color: c.working, fontSize: 10.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  srowR3: { flexDirection: "row", alignItems: "center", gap: 5 },
  srowMeta: { lineHeight: 14, color: c.faint, fontSize: 10 },
  // 件三目录过滤条（统计行与列表之间）：品牌描边浅底一行 + ✕ 清除
  dirBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 14, marginTop: 4, marginBottom: 2,
    borderRadius: 10, borderWidth: 1, borderColor: withA(c.brandA, 0.4),
    backgroundColor: withA(c.brandA, 0.07), paddingHorizontal: 11, paddingVertical: 7,
  },
  // W-PORT-B P0-2：搜索条与顶栏搜索钮（dirBar 过滤条同族语言）
  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 14, marginTop: 4, marginBottom: 2,
    borderRadius: 10, borderWidth: 1, borderColor: c.line,
    backgroundColor: c.panel, paddingHorizontal: 11, paddingVertical: 4,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 12.5, paddingVertical: 6, paddingHorizontal: 0 },
  searchBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", marginRight: 2 },
  searchX: { color: c.faint, fontSize: 13, paddingHorizontal: 2 },
  dirBarT: { flex: 1, color: c.brandA, fontSize: 11.5, fontWeight: "600" },
  dirBarX: { color: c.faint, fontSize: 13, paddingHorizontal: 2 },
  // 沉寂会话（DONE 非今日更新）名称降档：覆盖 title/titleC 的 color
  titleIdle: { color: c.dim },
  // W-MOBFUSION 件①：置顶图钉（r1 行内、时间戳左侧；桌面 srow-pinned 同位）
  pinIc: { fontSize: 9.5, opacity: 0.75 },
  // W-MOBFUSION 件③：PM 团队 chip（桌面 team-chip 同构：accent 色条+9% 淡染底+
  // 32% 描边胶囊，补双人图标+编制数；idle 全闲置灰 0.58）
  teamChip: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, paddingLeft: 5, paddingRight: 7, paddingVertical: 1.5, borderRadius: 6, borderWidth: 1 },
  teamChipBar: { width: 3, height: 9, borderRadius: 2 },
  teamChipName: { flexShrink: 1, color: c.dim, fontSize: 10, lineHeight: 14 },
  teamChipRun: { color: c.working, fontSize: 9.5, fontWeight: "700", fontVariant: ["tabular-nums"], marginLeft: 4 }, // W-ENGLM2 F：活跃数（WORKING 计数；编制数 teamChipN 随语义返工退役）
  teamChipIdle: { opacity: 0.58 },
  // W-MOBFUSION 件②：团队入口卡（桌面 dock team-entry 同语言：首字头像+健康角灯、
  // 队名+双人计数行、成员 mini 灯行）
  teamEntry: {
    flexDirection: "row", alignItems: "center", gap: 10,
    marginHorizontal: 14, marginVertical: 3, paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
  },
  teamEntryAva: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  teamEntryAvaT: { fontSize: 13, fontWeight: "700" },
  teamEntryLamp: { position: "absolute", right: -2, bottom: -2, width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: c.bg },
  teamEntryR1: { flexDirection: "row", alignItems: "center", gap: 5 },
  teamEntryName: { flexShrink: 1, color: c.textStrong, fontSize: 13, fontWeight: "600", lineHeight: 17 },
  teamEntryArrow: { fontSize: 15, lineHeight: 18 },
  teamEntryR2: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  teamEntryCount: { color: c.dim, fontSize: 10.5, fontWeight: "700", fontVariant: ["tabular-nums"], marginRight: 3 },
  teamEntryMini: { width: 6, height: 6, borderRadius: 3, marginLeft: 1 },
  teamEntryMore: { color: c.faint, fontSize: 9.5, marginLeft: 2 },
  sum: { color: c.dim, fontSize: 13, marginBottom: 5, paddingLeft: 6 }, /* #83 同缩进 */
  /* #192 WAITING 卡摘要报警（对齐桌面 .card-summary.waiting；dangerFg 双主题保 AA） */
  sumWaiting: { color: c.dangerFg, fontWeight: "600" },
  foot: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 6 }, /* #83 同缩进 */
  // 次要信息合并行（降噪）：托管/外部 · 目录 · 历史 一行 faint 小字，替代原 tag 胶囊
  meta: { fontSize: 10, color: c.faint, flexShrink: 1 },
  // 上下文占用 mini（foot 最右）：30px 微型条 + 百分比
  empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 42, marginBottom: 12, opacity: 0.5 },
  emptyT: { color: c.faint, fontSize: 14, marginBottom: 6 },
  emptyS: { color: c.faint, fontSize: 12, textAlign: "center", lineHeight: 20 },
  // 列表底部上拉刷新提示行（#255）：滚到底自动触发，也可点按
  footHint: { alignItems: "center", paddingVertical: 10 },
  footHintT: { color: c.faint, fontSize: 12 },
  // W-EXPOLISH 件七：右下悬浮新增钮退役——新建统一顶栏右上角 ＋
  // 件七：三域 ＋ 统一规格——44×44 触区 + PlusMark 20px（brand.tsx 单源导出，三处同参）
  headCollapseBtn: { height: 26, paddingHorizontal: 7, borderRadius: 13, borderWidth: 1, borderColor: c.line, justifyContent: "center", marginRight: 2 }, /* W-HEAD6 C：head 内折叠空闲/输出物小 chip */
  headCollapseBtnOn: { borderColor: c.brandA, backgroundColor: c.tintSoft },
  headCollapseT: { fontSize: 10, color: c.dim, lineHeight: 13 },
  headCollapseTOn: { color: c.brandA },
  plusBtn: {
    width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
    marginRight: -4, overflow: "hidden",
  },
  // W-MV8A 顶栏铃铛（v3 appbar bell）：与 searchBtn/themeBtn 同 30px 触区族 +
  // 红底白字 bbadge（display 切换常挂——P0 加固口径）
  bellBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", marginRight: 2 },
  bellBadge: {
    position: "absolute", top: -1, right: -5, minWidth: 14, height: 14, borderRadius: 7,
    paddingHorizontal: 3, backgroundColor: c.error, alignItems: "center", justifyContent: "center",
  },
  bellBadgeOff: { display: "none" },
  bellBadgeT: { color: "#FFFFFF", fontSize: 9, fontWeight: "800" },
  // 删除撤销条（#247）：底部浮条；右侧留出让任务汇报悬浮钮（44dp@right12）的空档。
  // zIndex 50：高于列表/边缘手势条（5），低于抽屉/图例（60）——配合打开时隐藏双保险
  undoBar: {
    position: "absolute", left: 20, right: 76, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 9, zIndex: 50, elevation: 6,
  },
  undoT: { flex: 1, color: c.dim, fontSize: 13 },
  undoBtn: {
    borderRadius: 8, backgroundColor: c.tintStrong, paddingHorizontal: 12, paddingVertical: 5,
  },
  undoBtnT: { color: c.brandA, fontSize: 12.5, fontWeight: "700" },
  // #26 M2 组织区（v3.1 矩阵式）：确认卡 + 项目组 chips——确认卡形制对齐验收单卡
  // （panel 底/line 边/12 圆角），动作色沿用审批按钮（done ✓ / error ✗）；chips 沿
  // 折叠空闲胶囊形制，状态只到描边+tint（pending 黄 / active 绿 / parked 中性）
  // W-EXPP2 经验分节（orgZone 内只读列表）：行=kind 徽标+两行文本+meta 行；徽章色随
  // kind（坑 error/法 done/好 brandA/实 faint），对齐 web 壳 exp 行语言
  // 组详情弹窗（gm*）：头部（名称+状态/档位 tags）→ 编制行 → 板段 → 回执流
  // M13-6E 验收回跳定位高亮（web jump-flash 闪烁的 expo 静态对等——动画差异备案）
});

// 连接中三点（2026-09-16；#116 wave 式）。#148 同源降级：原 native 逐帧插值
//（1400ms 循环）与呼吸灯同一渲染风暴（重连期间整机卡顿感，#85 同症状嫌疑）——
// 改低频轮替：420ms/步点亮下一枚、其余 0.25 底亮（经典输入指示器形态），
// 每秒 ~2.4 次提交
function ConnDots({ color, big }: { color: string; big?: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v + 1) % 3), 420);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginRight: big ? 0 : -4 }}>
      {[0, 1, 2].map((i) => (
        <Text
          key={i}
          style={{ color, fontSize: big ? 16 : 12, lineHeight: big ? 20 : 14, letterSpacing: 2, opacity: i === n ? 1 : 0.25 }}
        >
          ·
        </Text>
      ))}
    </View>
  );
}
