import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Animated, FlatList, Image, Linking, Modal, PanResponder, Pressable, RefreshControl, ScrollView, StyleSheet, Text, Vibration, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { STATUS_ZH, statusColor, withA, mix, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark, PencilIcon } from "../brand";
import { fmtLastActive, fmtTok, fmtElapsed, contextPct, contextLevel, CONTEXT_LIMIT_FALLBACK, displaySrcName, isLiveLine, stripLiveMark } from "../fmt";
import { setListDensity, useListDensity, setAggregate as persistAggregate, useIdleDimMin, isIdleSession, type ListDensity } from "../display-settings";
import { store, useRelay, type AcceptanceSummary, type SourceStatus } from "../store";
import { artPoolGate } from "../artpool";
import { FadeIn, PressScale } from "../motion";
import { hasActivityCapability, type BoardEntry, type DispatchReceipt, type NotificationItem, type OrgConfirm, type ProjectBoard, type ProjectGroup, type RoutingPoolEntry, type SessionState, type SessionStatus } from "../protocol";
import { notifActionableOf, notifDoneAt, splitResolvedRows, jumpTargetOf, type NotifJumpTarget } from "../notify-jump";
import RenameModal from "./RenameModal";
import SettingsDrawer from "./SettingsDrawer";

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
  onSetup: () => void;
  onScanServer: () => void; // 抽屉「扫码添加」（#276）：开设置页直接拉起扫码
  onEditServer: (id: string) => void;
  onOpenArtPool: () => void; // #72 E 线 入口①：产物池常驻胶囊（三重门显隐），App.tsx 开 ArtPoolModal
  ref?: Ref<ListBackHandle>;
}

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

// 段头（E2a 只读投影）：「待处理」/「其他会话」小节标题 + 实际渲染卡数；与源
// 分组头同族形制（色条换粗体小标，无源属性）。吸顶行自带底色，滚动叠加不透字
const SectionHeader = memo(function SectionHeader({ label, count }: { label: string; count: number }) {
  const styles = useThemeStyles(makeStyles);
  return (
    <View style={styles.secHead} accessibilityLabel={`${label}，${count} 个会话`}>
      <Text style={styles.secHeadT}>{label}</Text>
      <Text style={styles.secCount}>{count}</Text>
    </View>
  );
});

// 新增会话 ＋：圆头细条十字，与品牌星芒同线条语言
function PlusMark({ size = 20, color = "#D97757" }: { size?: number; color?: string }) {
  const w = 2.8;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: "absolute", width: w, height: size, left: (size - w) / 2, borderRadius: w / 2, backgroundColor: color }} />
      <View style={{ position: "absolute", height: w, width: size, top: (size - w) / 2, borderRadius: w / 2, backgroundColor: color }} />
    </View>
  );
}

const ACT_W = 78;    // 单个操作按钮宽
const FULL_W = 156;  // 操作面板总宽（重命名 + 删除）

// 列表行模型（E2a 只读投影）：三行型——段头（待处理/其他会话）、源分组头、
// 会话卡；卡行原样引用 SessionState 对象（分组/包装不改写会话，行级 memo 依赖
// 引用不变）。行序与 key 由 buildListProjection 纯函数产出
type ListRow =
  | { h: "sec"; key: string; label: string; count: number }
  | { h: "src"; key: string; name: string; color: string; online: boolean; count: number }
  | { h: false; key: string; s: SessionState };

// #102 源胶囊限长：按视觉宽度截断（英文/数字 1、中文等全角 2），上限 6 英文宽
function clipSrcName(name: string): string {
  let w = 0;
  for (let i = 0; i < name.length; i++) {
    w += name.charCodeAt(i) > 0xff ? 2 : 1;
    if (w > 6) return name.slice(0, i > 0 ? i : 1).trimEnd() + "…";
  }
  return name;
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
export const QUEUE_REASON_ORDER: Record<string, number> = { waiting: 0, acceptance: 1, notification: 2, working: 3 };

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
  const inPending = needsAction || (working && observableWork);
  const reason: QueueReason = waitingDecidable ? "waiting"
    : acceptance ? "acceptance"
    : notif ? "notification"
    : working && observableWork ? "working"
    : "other";
  return { needs_action: needsAction, is_working: working, needs_acceptance: acceptance, is_other: !inPending, reason };
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

// E2B-COMMANDS-START
// #018-E2b root 写链路纯函数段（自包含零 RN 依赖；W1b 347768d W1B-COMMANDS 同构
// 参照——两端同语义不共享代码）。§5.4 硬条款：ACK 必须核 ok === true，HTTP 200/
// 已发送/退出 0 都不算成功；无自动重试风暴（重试=用户重点；store 全局纪律已封顶：
// 4s 超时重发同 command_id 一次 → 6s 收摊回调一次，调用方只呈现不自动重发）。
// payload 口径对齐 relay 实况：
//   COMMAND_NOTIFICATION_ACK {notification_key, action:"handled"|"dismissed"}（B0 冻结词表）
//   COMMAND_ORG_CONFIRM      {confirm_id, approve:boolean}（relay 咽喉 ===true 严判）
// 通知不清零（B3a 口径）：本段与消费组件均无清池操作——打开/浏览/重连/动作失败
// 回滚零删行；badge 收缩只随 handled/dismissed 权威账。
export interface AckLike { ok?: unknown; error?: unknown; err?: unknown }
export interface AckVerdict { ok: boolean; error: string | null; kind: "ok" | "rejected" | "unconfirmed" }

// ACK 严格判定三态：ack 缺失（发送失败/超时收摊）→ unconfirmed（可重试文案）；
// ok === true 才成功；其余一律 rejected（error/err 字符串透传，非串兜底文案）
export function ackVerdict(ack: AckLike | null | undefined): AckVerdict {
  if (ack == null || typeof ack !== "object") {
    return { ok: false, error: "命令未确认（超时或源未连接），可重试", kind: "unconfirmed" };
  }
  if (ack.ok === true) return { ok: true, error: null, kind: "ok" };
  const msg = typeof ack.error === "string" && ack.error ? ack.error
    : typeof ack.err === "string" && ack.err ? ack.err : null;
  return { ok: false, error: msg ?? "命令被拒绝", kind: "rejected" };
}

// 旧 relay 未知命令错误三签名（ws 白名单拒发 "invalid command shape" / 旧
// handleCommand default "unsupported command" / org 咽喉 "unsupported org action: x"）。
// 命中 = 该源 relay 版本没有这条命令（非暂时性故障）→ 能力位记忆，静默降级防弹窗轰炸
export function unknownCommandError(err: unknown): boolean {
  return typeof err === "string" && /invalid command shape|^unsupported command|unsupported org action/.test(err);
}

export type CmdCaps = Record<string, boolean>;
// 能力位记忆（纯对象进出）：未知命令错误后记住「此源不再发该命令」
export function cmdCapRemember(caps: unknown, cmd: string): CmdCaps {
  const next: CmdCaps = { ...((caps && typeof caps === "object" ? caps : {}) as CmdCaps) };
  next[cmd] = false;
  return next;
}
export function cmdCapBlocked(caps: unknown, cmd: string): boolean {
  return !!(caps && typeof caps === "object" && (caps as CmdCaps)[cmd] === false);
}
// 恢复条件：①relay 身份变更（同一连接换指另一台 relay 实例）②快照 schema_version>=1
//（relay 升级新命令面上线）。旧 relay 恒 legacy（version 0）→ 记忆稳定不被快照冲掉
export function cmdCapRecoverOnSnapshot(caps: unknown, snapshotLike: unknown, identityChanged: boolean): CmdCaps {
  const p = (snapshotLike && typeof snapshotLike === "object" ? snapshotLike : {}) as Record<string, unknown>;
  const v = typeof p.schema_version === "number" && Number.isFinite(p.schema_version) ? p.schema_version : 0;
  if (identityChanged !== true && v < 1) return (caps && typeof caps === "object" ? caps : {}) as CmdCaps;
  return {};
}

// 双击闸：飞行中同键再点 → skip（expo/W1b 同语义同 fixture，不共享代码）
export function ackTapGuard(inFlight: Set<string> | null | undefined, flightKey: string): "go" | "skip" {
  return inFlight && inFlight.has(flightKey) ? "skip" : "go";
}
// 组织确认复合飞行键：confirm_id 是源域命名空间，跨源可能撞名
export function orgFlightKey(srcId: string, confirmId: string): string {
  return String(srcId) + "/" + String(confirmId);
}

// 组织确认 payload 组装（relay 咽喉 confirm-decide：approve 必须真布尔——
// `payload.approve === true` 严格判，字符串 "1"/数字 1 会判否决）；confirm_id 空串/null 拒发
export function orgConfirmPayload(confirmId: unknown, approve: unknown): { confirm_id: string; approve: boolean } | null {
  if (typeof confirmId !== "string" || !confirmId.trim()) return null;
  return { confirm_id: confirmId, approve: approve === true };
}

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

// 投影行模型：section（待处理/其他会话段头）· source（源分组头，srcId=null =
// 「—」降级占位组）· card（会话卡，pending 标记置顶组归属）。组头 count 一律
// = 该组实际渲染卡数（去重后），不是原始数组长度
export type ProjectionRow =
  | { kind: "section"; key: string; label: string; count: number }
  | { kind: "source"; key: string; srcId: string | null; name: string; color: string; online: boolean; count: number }
  | { kind: "card"; key: string; s: SessionState; pending: boolean };

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
}

// 列表投影主入口：
// - 待处理段恒置顶（跨源汇总，段头计数=实际卡数）；
// - 非聚合或仅单源 → 「其他会话」平铺直列；
// - 聚合多源 + 能力在 → 按源分组（组序=store 源序，组头带源名/配色/在线/计数）；
// - 聚合多源 + 能力缺失（legacy）→ 降级为单一「—」占位组平铺，不隐藏结构；
// - 聚合分组下无 src / 源已不在列表的会话落「—」占位组殿后（降级不丢卡）
export function buildListProjection(p: ProjectionParams): ProjectionRow[] {
  // E2a-up 富版分区：needs_action 四型/不占位四则/互斥/组内序全在 splitPending
  //（018 §2.1.1）；段头/组头 count 全部取自本函数输出的过滤后卡数，绝不用源总数
  const { pending, others } = splitPending(p.sessions, { notifications: p.notifications });
  const rows: ProjectionRow[] = [];
  if (pending.length) {
    rows.push({ kind: "section", key: "sec-pending", label: "待处理", count: pending.length });
    for (const s of pending) rows.push({ kind: "card", key: s.session_id, s, pending: true });
  }
  if (!others.length) return rows;
  const useGroups = p.aggregate && p.sources.length > 1;
  if (!useGroups) {
    rows.push({ kind: "section", key: "sec-others", label: "其他会话", count: others.length });
    for (const s of others) rows.push({ kind: "card", key: s.session_id, s, pending: false });
    return rows;
  }
  if (!p.sourceActivityCap) {
    // legacy relay：源能力缺失，分组依据不可信 → 「—」占位组平铺（结构保留）
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
  const rest = [...bySrc.values()].flat();
  if (rest.length) {
    rows.push({ kind: "source", key: "src-unknown", srcId: null, name: "—", color: "", online: false, count: rest.length });
    for (const s of rest) rows.push({ kind: "card", key: s.session_id, s, pending: false });
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
function DeskGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 14, height: 12, marginRight: 4 }}>
      <View style={{ position: "absolute", left: 1.2, top: 0.8, width: 11.6, height: 8, borderRadius: 1.6, borderWidth: 1.4, borderColor: color }} />
      <View style={{ position: "absolute", left: 5, top: 10, width: 4, height: 1.4, borderRadius: 0.7, backgroundColor: color }} />
    </View>
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

// W-EXPO 005 srow 头像（.srow-ava 等价）：34px 圆角 9 方块，源色 16% 淡染底 +
// 首字母；右下角状态灯叠角（2px 页底光圈遮接缝，.status-dot 同口径四色）
function AvaBadge({ letter, srcColor, dotColor, breathe }: { letter: string; srcColor: string | null; dotColor: string; breathe: boolean }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const bg = srcColor ? mix(srcColor, c.panel2, 0.84) : c.panel2;
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!breathe) return;
    const t = setInterval(() => setPh((n) => (n + 1) % BLINK_PHASES.length), 480);
    return () => clearInterval(t);
  }, [breathe]);
  return (
    <View style={[styles.ava, { backgroundColor: bg }]}>
      <Text style={[styles.avaT, { color: srcColor ?? c.textStrong }]}>{letter}</Text>
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

// r3 状态 tag 胶囊（005 STATUS_TAG 口径：待处理=action 橙 / 错误=danger / 完成=done /
// 运行中=info；tint 底 + 同色描边 + 同色字）
const TAG_TINT: Record<string, keyof ThemeColors> = {
  WAITING: "brandA", ERROR: "error", DONE: "done", WORKING: "info",
};
function StatusTag({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const key = TAG_TINT[s.status] ?? "info";
  const tint = c[key];
  return (
    <View style={[styles.srowTag, { borderColor: withA(tint, 0.42), backgroundColor: withA(tint, 0.12) }]}>
      <Text style={[styles.srowTagT, { color: tint }]}>{STATUS_ZH[s.status] ?? s.status}</Text>
    </View>
  );
}

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
// 面板做成独立圆角小胶囊（上下留 3px），从卡片后面滑出，避免直角贴圆角的接缝。
// minimal（极简单行卡）：面板只留图标不出文字标签（行高太矮叠不下两行字）
function SwipeRow({
  sid, deletable, onPress, onRename, onDelete, revealSid, onReveal, compact, minimal, dim, children,
}: {
  sid: string;
  deletable: boolean;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  compact?: boolean;
  minimal?: boolean;
  dim?: boolean; // #32 离线源降权（缓存会话与在线视觉区分）
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const close = () => {
    open.current = false;
    onReveal(null);
    Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
  };
  // 同时只保留一行展开
  useEffect(() => {
    if (open.current && revealSid !== null && revealSid !== sid) {
      open.current = false;
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    }
  }, [revealSid]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dy) < 12,
      onPanResponderMove: (_, g) => {
        const base = open.current ? -FULL_W : 0;
        x.setValue(Math.min(0, Math.max(-FULL_W - 36, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        // 已展开：明显右移或右甩即收起；未展开：左移过半或左甩即展开
        const shouldOpen = open.current ? !(g.dx > 24 || g.vx > 0.3) : g.dx < -ACT_W / 2 || g.vx < -0.5;
        open.current = shouldOpen;
        onReveal(shouldOpen ? sid : null);
        Animated.spring(x, { toValue: shouldOpen ? -FULL_W : 0, useNativeDriver: true, bounciness: 5, speed: 18 }).start();
      },
      onPanResponderTerminate: () => {
        open.current = false;
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;
  return (
    <View style={[styles.swipeWrap, compact && styles.swipeWrapC, minimal && styles.swipeWrapM]}>
      <View style={[styles.actPanel, minimal && styles.actPanelM]}>
        <Pressable
          style={[styles.actBtn, styles.actRen]}
          android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }}
          onPress={() => {
            onRename();
            close();
          }}
        >
          <View style={{ marginBottom: 2 }}><PencilIcon size={14} color="#fff" /></View>
          {!minimal ? <Text style={styles.actT2}>重命名</Text> : null}
        </Pressable>
        <Pressable
          style={[styles.actBtn, !deletable && styles.actOff]}
          android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }}
          onPress={() => {
            if (deletable) onDelete();
            close();
          }}
        >
          <Text style={styles.actT}>✕</Text>
          {!minimal ? <Text style={styles.actT2}>{deletable ? "删除" : "运行中"}</Text> : null}
        </Pressable>
      </View>
      <Animated.View style={[styles.swipeCard, { transform: [{ translateX: x }] }]} {...pan.panHandlers}>
        <Pressable
          style={[styles.card, compact && styles.cardC, minimal && styles.cardM]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => {
            if (open.current) close();
            else onPress();
          }}
        >
          {children}
        </Pressable>
        {/* 置灰蒙层替代整卡降透明度（2026-09-17）：dimRow opacity 曾让常驻底层的
            重命名/删除动作排透出（所有 DONE 卡同时"开盖"的假象）；蒙层盖在
            swipeCard 内（overflow:hidden 自带圆角裁切），正面保持不透明 */}
        {dim ? <View pointerEvents="none" style={styles.dimCover} /> : null}
      </Animated.View>
    </View>
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

// 上下文占用 mini 指示：30px 微型条 + 百分比（与详情页头部 ctx 行、网页端同口径同分级）
function CtxMini({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const used = s.context_usage ?? 0;
  if (!used) return null;
  const limit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const pct = contextPct(used, limit);
  const lv = contextLevel(used, limit);
  return (
    <View style={styles.ctxMini}>
      <View style={styles.ctxMiniBar}>
        <View style={{ width: `${pct}%`, height: 3, borderRadius: 1.5, backgroundColor: c[lv] }} />
      </View>
      <Text style={[styles.ctxMiniT, { color: c[lv] }]}>{pct}%</Text>
    </View>
  );
}

// 上下文水位区（极简行专用，常显）：右端固定 64px 区 = 3px 细条（宽按水位比例、
// contextLevel 分级色）+ 下方 9px tabular 百分比；无数据出灰色 "–" 占位——右缘不空缺不跳位
function CtxCell({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const used = s.context_usage ?? 0;
  const has = used > 0;
  const limit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const pct = contextPct(used, limit);
  const lv = contextLevel(used, limit);
  return (
    <View style={styles.ctxCell}>
      <View style={styles.ctxCellBar}>
        {has ? <View style={{ width: `${pct}%`, height: 3, borderRadius: 1.5, backgroundColor: c[lv] }} /> : null}
      </View>
      <Text style={[styles.ctxCellT, has && { color: c[lv] }]}>{has ? `${pct}%` : "–"}</Text>
    </View>
  );
}

// memo：流式刷新只重渲变化的那一行（onRename/onReveal/onDelete 均为稳定引用；
// 源归属改由分组头承担，卡片不再带源角标 props——会话对象引用不变即不重渲）
// #59 聚合源归属角标：源身份色点+源名（各密度档通用，行内右端）
function SrcBadge({ name, color }: { name: string; color: string }) {
  // #98 桌面版同款胶囊：源色底+白字圆角（原为色点+灰字）
  return (
    <View style={{ backgroundColor: color + "E6", borderRadius: 4.5, paddingHorizontal: 5.5, paddingVertical: 1.5 }}>
      {/* #102 源胶囊限长：≤6 英文字符宽（中文 1 字≈2 英文宽），超长截断省略 */}
      <Text style={{ color: "#fff", fontSize: 8.5, fontWeight: "700", letterSpacing: 0.3 }} numberOfLines={1}>{clipSrcName(name)}</Text>
    </View>
  );
}

// E2a 活动指标块：store activity 最后值的只读投影——状态/动作/耗时/审批四行，
// 各自按 activity_capabilities 门控显隐；activity 缺失=整块不渲染（不显示假
// 「空闲」），capability 全关（legacy 归一化产物）= 空块同效不渲染。行高恒定
//（lineHeight 定值）+ 单行 ellipsis 截断 + tabular 数字，390 宽小屏不抖卡高
function ActivityBlock({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const m = activityMetricsOf(s);
  if (!m) return null;
  const lines: [string, string, string][] = [];
  if (m.state !== undefined) lines.push(["状态", STATUS_ZH[m.state] ?? m.state, statusColor(m.state, c)]);
  if (m.summary !== undefined) lines.push(["动作", m.summary || "—", c.dim]);
  if (m.elapsedMs !== undefined) lines.push(["耗时", fmtElapsed(m.elapsedMs), c.dim]);
  if (m.approvalPending !== undefined) lines.push(["审批", m.approvalPending ? "待审批" : "—", m.approvalPending ? c.waiting : c.faint]);
  if (!lines.length) return null;
  return (
    <View style={styles.actBlock}>
      {lines.map(([k, v, vc]) => (
        <Text key={k} style={styles.actLine} numberOfLines={1}>
          <Text style={styles.actKey}>{k} </Text>
          <Text style={[styles.actVal, { color: vc }]}>{v}</Text>
        </Text>
      ))}
    </View>
  );
}

const SessionCard = memo(function SessionCard({
  s, onOpen, onResume, onRename, onDelete, revealSid, onReveal, density, dim, srcBadge, orgTag,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onResume: (sid: string) => void; // #49/#139 休眠卡点按恢复
  onRename: (sid: string) => void;
  onDelete: (sid: string) => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  density: ListDensity;
  dim?: boolean; // #32 离线源降权
  srcBadge?: { name: string; color: string } | null; // #59 聚合模式源归属角标
  orgTag?: string | null; // #26 M2 组织归属（项目组名/派单档位）：标准档缀元信息行、紧凑档占目录位、极简档无位不显
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const idleDimMin = useIdleDimMin();
  const compact = density === "compact";
  const minimal = density === "minimal";
  const color = statusColor(s.status, c);
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
  // 也按正常卡处理（本来就没停，无从恢复）。休眠卡降透明度 + 点按发恢复命令
  const dormant =
    s.pinned === true && s.saved === true && s.status !== "WORKING" && s.status !== "WAITING";
  return (
    <SwipeRow
      sid={s.session_id}
      deletable={deletable}
      onPress={() => (dormant ? onResume(s.session_id) : onOpen(s.session_id))}
      onRename={() => onRename(s.session_id)}
      onDelete={() => onDelete(s.session_id)}
      revealSid={revealSid}
      onReveal={onReveal}
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
          {srcBadge ? <SrcBadge {...srcBadge} /> : null}
          <CtxCell s={s} />
        </View>
      ) : compact ? (
        // 紧凑卡：状态点+标题+时长一行、动作摘要一行、目录/改动/水位一行——省高度但不丢信息
        <>
          <View style={styles.rowC}>
            {s.status === "WORKING" || bgLive ? (
              <BlinkDot color={dotColor} />
            ) : (
              <View style={[styles.dot, { backgroundColor: color }]} />
            )}
            <Text style={[styles.titleC, idle && styles.titleIdle]} numberOfLines={1}>{s.title || "未命名会话"}</Text>
            {bgCount > 0 ? <BgBadge n={bgCount} color={c.working} /> : null}
            <View style={{ flex: 1 }} />
            {srcBadge ? <SrcBadge {...srcBadge} /> : null}
            <Elapsed s={s} />
          </View>
          {s.status === "WAITING" && s.waiting_request ? (
            <Text style={[styles.sumC, styles.sumWaiting]} numberOfLines={1}>需要确认 · {s.action_summary || ""}</Text>
          ) : (
            <Text style={styles.sumC} numberOfLines={1}>{s.action_summary || "…"}</Text>
          )}
          {/* E2a 活动指标块（紧凑档）：activity 缺失/能力全关时自返回 null */}
          <ActivityBlock s={s} />
          <View style={styles.footC}>
            {orgTag ? <Text style={styles.folderC} numberOfLines={1}>◈ {orgTag}</Text> : null}
            {s.cwd ? <Text style={styles.folderC} numberOfLines={1}>📁 {folderOf(s.cwd)}</Text> : null}
            <View style={{ flex: 1 }} />
            {/* #145 卡片去改动统计行（详情页统计保留全量）；目录已上卡 */}
            <CtxMini s={s} />
          </View>
        </>
      ) : (
        <>
          {/* W-EXPO 005 srow 通栏行（.srow-* 等价，index-005 手机模式参照）：ava（源色
              淡化头像+状态灯叠角）+ 三行制——r1 标题全宽+行尾时间；r2 摘要+行尾走秒·
              ⑂N（warn 呼吸点+tag 形制，#bg-live 口径）；r3 徽章行 footnote 级（状态 tag/
              源胶囊/目录/外部·历史，全空整行不渲染）。无框无底无圆角，间距分行（军规①②） */}
          <View style={styles.srow}>
            <AvaBadge
              letter={(s.title || "未").trim().slice(0, 1) || "未"}
              srcColor={srcBadge ? srcBadge.color : null}
              dotColor={dotColor}
              breathe={s.status === "WORKING" || bgLive}
            />
            <View style={styles.srowMain}>
              <View style={styles.srowR1}>
                <Text style={[styles.srowTitle, idle && styles.titleIdle]} numberOfLines={1}>
                  {s.title || "未命名会话"}
                </Text>
                <Elapsed s={s} />
              </View>
              <View style={styles.srowR2}>
                {bgCount > 0 ? (
                  <>
                    <R2LiveDot />
                    <Text style={styles.srowBgTag}>⑂{bgCount}</Text>
                  </>
                ) : null}
                {s.status === "WORKING" ? (
                  <LiveStat s={s} />
                ) : s.status === "WAITING" && s.waiting_request ? (
                  <Text style={[styles.srowSum, styles.sumWaiting]} numberOfLines={1}>需要确认 · {s.action_summary || ""}</Text>
                ) : (
                  <Text style={styles.srowSum} numberOfLines={1}>{s.action_summary || "…"}</Text>
                )}
              </View>
              {/* E2a 活动指标块：activity 缺失/能力全关时自返回 null */}
              <ActivityBlock s={s} />
              {/* r3 徽章行：状态 tag + 源胶囊 + 组织/目录/外部·历史 + 水位 mini */}
              <View style={styles.srowR3}>
                <StatusTag s={s} />
                {srcBadge ? <SrcBadge {...srcBadge} /> : null}
                {s.cwd ? <Text style={styles.srowMeta} numberOfLines={1}>📁 {folderOf(s.cwd)}</Text> : null}
                {orgTag ? <Text style={styles.srowMeta} numberOfLines={1}>◈ {orgTag}</Text> : null}
                {dormant ? <Text style={styles.srowMeta}>已保存</Text> : null}
                {s.historical && !s.external ? <Text style={styles.srowMeta}>历史</Text> : null}
                <View style={{ flex: 1 }} />
                <CtxMini s={s} />
              </View>
            </View>
          </View>
        </>
      )}
    </SwipeRow>
  );
});

// ---------- #26 M2 组织区（v3.1 矩阵式）----------
// 与 web-console 组织域同口径：确认卡（Leader 只提案 → 用户 ✓/✗ 决议，§4「用户是
// 指挥/验收者」）、项目组三态 chips（结项=archived 单向终态不占常驻位）、组详情弹窗
// （编制/任务板/回执流）。旧 relay 快照无 projects 字段（null）→ 整区不渲染，兼容
const ORG_ST_ZH: Record<string, string> = { pending: "待确认", active: "在办", parked: "已挂起", archived: "已结项" };
const ORG_CF_KIND_ZH: Record<string, string> = {
  "project-create": "立项", "tier-change": "升降级", "suggest-hold": "建议暂缓", archive: "结项", revive: "复活",
};
// chips 排序：待确认 → 在办 → 已挂起（同 web 端 org zone 顺序契约）
const ORG_ST_ORD: Record<string, number> = { pending: 0, active: 1, parked: 2 };
function orgStColor(st: string, c: ThemeColors): string {
  return st === "active" ? c.done : st === "pending" ? c.waiting : c.faint;
}

// 组织区（列表顶条件区，随待填验收单卡同位）：确认卡行 + 项目组 chips
function OrgZone({ confirms, groups, onDecide, onOpenGroup }: {
  confirms: { src: SourceStatus; cf: OrgConfirm }[];
  groups: { src: SourceStatus; g: ProjectGroup }[];
  onDecide: (srcId: string, confirmId: string, approve: boolean) => void;
  onOpenGroup: (src: SourceStatus, g: ProjectGroup) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  if (!confirms.length && !groups.length) return null;
  const sorted = [...groups].sort((a, b) => (ORG_ST_ORD[a.g.status] ?? 9) - (ORG_ST_ORD[b.g.status] ?? 9));
  return (
    <View style={styles.orgZone}>
      {confirms.map(({ src, cf }) => (
        <View key={cf.id} style={styles.orgCf}>
          <Text style={styles.orgCfKind}>{ORG_CF_KIND_ZH[cf.kind] ?? cf.kind}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.orgCfTitle} numberOfLines={1}>{cf.title}</Text>
            {cf.reason ? <Text style={styles.orgCfReason} numberOfLines={1}>{cf.reason}</Text> : null}
          </View>
          <Pressable
            style={[styles.orgCfBtn, { backgroundColor: c.done }]}
            hitSlop={8}
            accessibilityLabel={`同意确认卡：${cf.title}`}
            onPress={() => onDecide(src.id, cf.id, true)}
          >
            <Text style={[styles.orgCfBtnT, { color: c.onDone }]}>✓</Text>
          </Pressable>
          <Pressable
            style={[styles.orgCfBtn, styles.orgCfBtnR, { borderColor: withA(c.error, 0.5) }]}
            hitSlop={8}
            accessibilityLabel={`否决确认卡：${cf.title}`}
            onPress={() => onDecide(src.id, cf.id, false)}
          >
            <Text style={[styles.orgCfBtnT, { color: c.error }]}>✗</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.orgChips}>
        {sorted.map(({ src, g }) => (
          <Pressable
            key={g.id}
            style={[
              styles.orgChip,
              g.status === "active" && { borderColor: withA(c.done, 0.5), backgroundColor: withA(c.done, 0.08) },
              g.status === "pending" && { borderColor: withA(c.waiting, 0.5), backgroundColor: withA(c.waiting, 0.08) },
            ]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityLabel={`项目组 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${(g.headcount ?? []).length + 1} 人，点按查看详情`}
            onPress={() => onOpenGroup(src, g)}
          >
            <Text style={[styles.orgChipT, { color: orgStColor(g.status, c) }]} numberOfLines={1}>{g.name}</Text>
            <Text style={styles.orgChipSt}>·{ORG_ST_ZH[g.status] ?? g.status}·{(g.headcount ?? []).length + 1}人</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// 组详情弹窗（对齐 web 端 org drawer）：状态/档位 → 编制（组内会话可点入）→ 任务板
//（轻立项单列简化态 / 正经立项三段；挂起=冻结只读）→ 最近派单回执流（§3.5 过程不
// 回灌只收回执一行）。板不随快照（帧预算纪律）——COMMAND_PROJECT_DETAIL 按需拉取；
// 状态行优先取源快照实时值（PROJECTS_UPDATED 即时反映），拉取结果兜底
function GroupModal({ srcId, target, onClose, onOpenSession, highlightEntryId }: {
  srcId: string;
  target: { gid: string; name: string };
  onClose: () => void;
  onOpenSession: (sid: string) => void;
  highlightEntryId?: string; // M13-6E 验收回跳：命中台账卡高亮定位（orgDetail 现拉板内查无=不高亮，防御）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  // undefined=加载中 / null=失败 / 对象=详情
  const [detail, setDetail] = useState<{ group?: ProjectGroup; board?: ProjectBoard; receipts?: DispatchReceipt[]; pool?: RoutingPoolEntry[] } | null | undefined>(undefined);
  useEffect(() => {
    setDetail(undefined);
    // send 当即失败（未连接/源不在）没有 ACK 回调，直接落失败态
    if (!store.orgDetail(srcId, target.gid, setDetail)) setDetail(null);
  }, [srcId, target.gid]);
  const g = detail?.group;
  const board = detail?.board;
  const ents = board?.entries ?? [];
  // #26 M3 熟手池（§5 成员卡进化）：路由表档案 join 运行态，服务端拼好（detail.pool）；
  // 旧版 relay 无 pool 字段 → 空数组回落（编制快照仍在 group.headcount，不丢信息）
  const pool = useMemo(() => detail?.pool ?? [], [detail]);
  const liveG = useMemo(() => {
    for (const src of snap.sources) {
      const hit = (src.projects ?? []).find((x) => x.id === target.gid);
      if (hit) return hit;
    }
    return g;
  }, [snap.sources, target.gid, g]);
  const entRow = (e: BoardEntry) => (
    <View key={e.id} style={[styles.gmEnt, e.id === highlightEntryId && styles.gmEntHi]}>
      <Text style={styles.gmEntT} numberOfLines={2}>{e.text}</Text>
      {e.note ? <Text style={styles.gmEntNote} numberOfLines={1}>{e.note}</Text> : null}
    </View>
  );
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.gmWrap}>
        <View style={styles.gmHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.gmTitle} numberOfLines={1}>{target.name}</Text>
            <View style={styles.gmTags}>
              <Text style={[styles.gmTag, { color: orgStColor(liveG?.status ?? "", c) }]}>
                {ORG_ST_ZH[liveG?.status ?? ""] ?? liveG?.status ?? "…"}
              </Text>
              <Text style={styles.gmTag}>{liveG?.tier ?? g?.tier ?? ""}</Text>
            </View>
          </View>
          <Pressable hitSlop={10} onPress={onClose} accessibilityLabel="关闭项目组详情">
            <Text style={styles.gmClose}>✕</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.gmBody} showsVerticalScrollIndicator={false}>
          {detail === undefined ? (
            <Text style={styles.gmEmpty}>加载中…</Text>
          ) : detail === null ? (
            <Text style={styles.gmEmpty}>详情拉取失败（源可能已断开或 relay 版本过旧）</Text>
          ) : (
            <>
              {/* 熟手池：经验 N 次 · 上次 · 在忙/空闲/随组挂起/已退休（退休=只剩路由表档案，
                  不可点）；空闲/随组挂起可点开（消息/派单即拉起）；Leader 兼管不占行 */}
              <Text style={styles.gmSec}>熟手池 · {pool.length} 人（Leader 兼管）</Text>
              {pool.length ? pool.map((p) => {
                const st = p.busy ? "在忙" : p.parked ? "随组挂起" : p.resumable ? "空闲" : "已退休（档案）";
                const stColor = p.busy ? c.waiting : p.parked || !p.resumable ? c.faint : c.done;
                const body = (
                  <View style={[styles.gmSess, !p.resumable ? { opacity: 0.62 } : null]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.gmSessT} numberOfLines={1}>
                        {p.title || p.session_id.slice(0, 8)}{p.rating === "bad" ? "（差评·避开）" : ""}
                      </Text>
                      <Text style={styles.gmSessSt} numberOfLines={1}>
                        {`${p.count} 次 · 上次 ${fmtLastActive(p.last_ts)}`}
                        {p.tags?.length ? ` · ${p.tags.map((t) => "#" + t).join(" ")}` : ""}
                      </Text>
                    </View>
                    <Text style={[styles.gmSessSt, { color: stColor }]}>{st}</Text>
                  </View>
                );
                return p.resumable ? (
                  <Pressable
                    key={p.session_id}
                    android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                    onPress={() => { onClose(); onOpenSession(p.session_id); }}
                  >
                    {body}
                  </Pressable>
                ) : (
                  <View key={p.session_id}>{body}</View>
                );
              }) : <Text style={styles.gmEmpty}>熟手池为空（首次派单后积累）</Text>}
              {/* 任务板：轻立项=单列简化态（渲染降级）；正经立项=D18 五态段（freeze §1.2） */}
              <Text style={styles.gmSec}>任务板{board?.frozen ? "（已挂起 · 冻结只读）" : ""}</Text>
              {ents.length === 0 ? (
                <Text style={styles.gmEmpty}>板为空</Text>
              ) : g?.tier === "轻立项" ? (
                <View style={styles.gmCol}>{ents.map(entRow)}</View>
              ) : (
                ([["backlog", "待认领"], ["claimed", "进行中"], ["submitted", "待复核"], ["ready_to_install", "待装机"], ["done", "完成"]] as const).map(([st, lb]) => (
                  <View key={st} style={styles.gmColGroup}>
                    <Text style={styles.gmColH}>{lb} {ents.filter((e) => e.status === st).length}</Text>
                    <View style={styles.gmCol}>{ents.filter((e) => e.status === st).map(entRow)}</View>
                  </View>
                ))
              )}
              {/* 回执流：readDispatchLog 按 project_anchor 过滤，最近 30 条新在前 */}
              <Text style={styles.gmSec}>最近派单回执</Text>
              {(detail.receipts ?? []).length ? detail.receipts!.map((r) => (
                <View key={r.id + r.ts} style={[styles.gmRec, { borderLeftColor: r.status === "failed" ? c.error : c.line }]}>
                  <Text style={styles.gmRecB}>[{r.tier}] {r.status}</Text>
                  {r.receipt ? <Text style={styles.gmRecT} numberOfLines={5}>{r.receipt}</Text> : null}
                  {/* 对齐 web（index.html 回执流）：target 归 meta 行、过滤 org-leader、
                      截 8 位——整段 UUID 上屏既占行又不可辨 */}
                  <Text style={styles.gmRecMeta}>{r.ts ? new Date(r.ts).toLocaleString() : ""}{r.target && r.target !== "org-leader" ? ` · ${r.target.slice(0, 8)}` : ""}</Text>
                </View>
              )) : <Text style={styles.gmEmpty}>暂无派单回执</Text>}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onSetup, onScanServer, onEditServer, onOpenArtPool, ref }: Props) {
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
  const [revealSid, setRevealSid] = useState<string | null>(null);
  const [renameSid, setRenameSid] = useState<string | null>(null);
  const renameTarget = useMemo(
    () => sessions.find((s) => s.session_id === renameSid) ?? null,
    [sessions, renameSid],
  );
  const handleRename = useCallback((sid: string) => setRenameSid(sid), []);

  // #49/#139 休眠卡点按 = 按需恢复（对齐桌面端）：此前手机端没有实现保存恢复，
  // relay 下发的「已保存，点击恢复」摘要在手机上成了死文案——点卡只打开详情，
  // 恢复从未发生。恢复失败走 SESSION_ERROR（卡片转「恢复失败」可重点重试），
  // 未连接等前置错误由全局 Toast 负责（与删除路径同口径）
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 状态图例浮窗（统计行 ？ 呼出）
  const [legendOpen, setLegendOpen] = useState(false);
  // E2b 通知中心开关（声明前置：requestBack 返回栈句柄在其上方引用）
  const [notifOpen, setNotifOpen] = useState(false);
  // 顶栏品牌区副标题：当前连接的服务器名（多源场景区分不同来源）。
  // 抽屉关上时重读——切服务器不重挂载本页，副标题要跟着换
  const [activeName, setActiveName] = useState("");
  useEffect(() => {
    if (drawerOpen) return;
    void Promise.all([store.loadServers(), store.activeServerId()])
      .then(([list, id]) => {
        const active = list.find((e) => e.id === id) ?? list[0];
        setActiveName(active?.name?.trim() ?? "");
      })
      .catch(() => {});
  }, [drawerOpen]);

  // 硬件返回（#282）：抽屉/图例开着时先关浮层而不是退出 App（列表页是根路由）。
  // 原两处局部 BackHandler 订阅已并入 App.tsx 顶层单订阅，这里经 ref 句柄承接分发。
  // E2b：通知中心 Modal 纳入返回栈最前位——返回键只关浮层，列表分组/滚动位/
  // 未决计数零触碰（通知中心打开不清零，返回也不重置）
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
      if (drawerOpen) {
        setDrawerOpen(false);
        return true;
      }
      return false;
    },
  }), [notifOpen, drawerOpen, legendOpen]);

  // 左缘手势条：从屏幕左缘右滑呼出侧边栏（透明覆盖条，只认横向滑动，不拦点击/竖向滚动）
  const edgePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 14,
      onPanResponderRelease: (_, g) => {
        if (g.dx > 36 || g.vx > 0.35) setDrawerOpen(true);
      },
    }),
  ).current;
  const sorted = useMemo(() => {
    // 活跃（等待/运行/错误）置顶，其余按最近更新倒序：
    // 新完成的会话紧跟活跃段，不再"闪现后跳到 20 个会话底部"像消失。
    // #294 批2：聚合时 sessions 已是全源平铺，同一比较器作用于合并列表；
    // 分组态在下方 rows memo 里按 src 分区（组间按组内最近活动排序），组内沿用本排序
    // #100 后台在跑（子 Agent 未收尾）视同活跃置顶——派了任务却沉底像消失
    const rank = (s: SessionState) =>
      s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR" ||
      (s.subagents ?? []).some((a) => !a.ended_at) ? 0 : 1;
    return [...sessions].sort(
      (a, b) => rank(a) - rank(b) || (b.updated_at ?? b.started_at) - (a.updated_at ?? a.started_at),
    );
  }, [sessions]);

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
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  const statusItems = (["WORKING", "WAITING", "ERROR", "DONE"] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ k, n: counts[k], color: statusColor(k, c) }));

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
  // #137 待填验收单 badge：跨源汇总未完成且未点开过的单，列表顶部条件卡。
  // seen 本地记（AsyncStorage，per 单 id）——浏览器填完后 relay 侧 done 已置，
  // 但 SNAPSHOT 只在重连时下发，只看 done 的话 badge 会在快照刷新前多挂一阵；
  // 点开即视为已知，先行收起（下一张未 seen 的单自动顶上）
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
      // #195 消失条件改「提交过即消」（submitted；留空行也算提交）——旧判定
      // !done 要求全行判完，实际填单常留「未测」空行 → 卡永久滞留。旧 relay 无
      // submitted 字段（undefined）回退 done 判定
      for (const a of src.acceptances ?? [])
        if (!(a.submitted || a.done) && !accSeen.has(a.id)) out.push({ src, a });
    out.sort((x, y) => y.a.created_at - x.a.created_at); // 新单在前，卡显示最新一张
    return out;
  }, [snap.sources, accSeen]);
  const seenAcc = (id: string) => {
    setAccSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      void AsyncStorage.setItem("ccr_acc_seen", JSON.stringify([...next]));
      return next;
    });
  };
  const openAcc = (item: { src: SourceStatus; a: AcceptanceSummary }) => {
    // 链接按源当前通道择路（同出单工具双发口径）：LAN 通道 = 同网直连表单页；
    // 云通道/未知 = CF Worker /view KV 页面。#28 起云链接需带 per-sheet 密钥
    // fragment（…html#<key>，SNAPSHOT key 字段；新 Worker 缺 key 提交 403）——
    // 旧 relay 无 key 字段（undefined）退回无后缀链接（旧 Worker 本就不验）
    const url = item.src.channel === "lan" && item.src.lanHint
      ? `http://${item.src.lanHint}/acceptance/${item.a.id}`
      : `https://cc.humumu.online/view/acceptance-${item.a.id}.html${item.a.key ? `#${item.a.key}` : ""}`;
    void Linking.openURL(url).catch(() => undefined);
    seenAcc(item.a.id);
  };
  // #195 手动删除通知：不点开表单直接收卡（本地 seen 隐藏，不动 relay 侧单子与
  // 填报数据——「删通知」而非「删单」；下张待填单自动顶上）
  const dismissAcc = (id: string) => seenAcc(id);
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
      .filter((s) => s.session_id !== pendingDel && !deleting.includes(s.session_id)),
    [sorted, collapseIdle, idleDimMin, pendingDel, deleting],
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
    }),
    [visible, snap.aggregate, snap.sources, snap.sourceCapabilities],
  );
  const rows = useMemo<ListRow[]>(() => projection.map((r) =>
    r.kind === "section"
      ? { h: "sec" as const, key: r.key, label: r.label, count: r.count }
      : r.kind === "source"
        ? { h: "src" as const, key: r.key, name: r.name, color: r.color, online: r.online, count: r.count }
        : { h: false as const, key: r.key, s: r.s },
  ), [projection]);
  // 段头/组头吸顶（E2a 390 宽稳定口径）：头行定高+自带底色，滚动叠加不跳动
  const stickyIndices = useMemo(
    () => rows.reduce<number[]>((acc, r, i) => { if (r.h !== false) acc.push(i); return acc; }, []),
    [rows],
  );

  // #59 逐卡源归属角标（用户点单：聚合模式卡片要能分辨哪台电脑）：聚合开启且未
  // 走分组头（降级/单在线源混排）时恒显；配色与分组头共用 sourcePalette，同屏稳定
  const srcBadgeMap = useMemo(() => {
    if (!badgeOn || grouped) return null;
    const nameOf = new Map(snap.sources.map((x) => [x.id, displaySrcName(x.name)] as const));
    const colorOf = sourcePalette(snap.sources);
    return (src: string | undefined): { name: string; color: string } | null => {
      if (!src) return null;
      return { name: nameOf.get(src) ?? "其他", color: colorOf.get(src) ?? srcColor(src) };
    };
  }, [badgeOn, grouped, snap.sources]);
  const srcBadgeOf = srcBadgeMap ?? (() => null);

  // #26 M2 组织域：待决议确认卡 + 项目组 chips（结项不占常驻位）——跨源平铺
  // （src+item 对），组名映射供卡片组织徽标（project_gid → 组名，无组回落档位）
  const orgConfirms = useMemo(() => {
    const out: { src: SourceStatus; cf: OrgConfirm }[] = [];
    for (const src of snap.sources) for (const cf of src.orgConfirms ?? []) out.push({ src, cf });
    return out;
  }, [snap.sources]);
  const orgGroups = useMemo(() => {
    const out: { src: SourceStatus; g: ProjectGroup }[] = [];
    for (const src of snap.sources)
      for (const g of src.projects ?? []) if (g.status !== "archived") out.push({ src, g });
    return out;
  }, [snap.sources]);
  const projNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const src of snap.sources) for (const g of src.projects ?? []) m.set(g.id, g.name);
    return m;
  }, [snap.sources]);
  const orgTagOf = useCallback(
    (s: SessionState) => (s.project_gid ? projNameById.get(s.project_gid) ?? "项目组" : s.dispatch_tier ?? null),
    [projNameById],
  );
  // 组详情弹窗：点 chip 打开 → COMMAND_PROJECT_DETAIL 按需拉取
  const [orgOpen, setOrgOpen] = useState<{ srcId: string; gid: string; name: string; entryId?: string } | null>(null);
  // E2b：确认卡决议走 ACK 严格判定门（W1b 同构）——approve 经 orgConfirmPayload
  // 强转真布尔（relay 咽喉 ===true 严判）、双击闸、失败可见态；unknownCommandError
  // 记能力位后该源决议降级禁用（不再弹错轰炸）；成功不本地造状态，等
  // ORG_CONFIRM_UPDATED 权威帧收敛（与 store orgConfirm 注释同口径）。无自动重试
  //（重试=用户重点；store 全局 4s 重发一次+6s 收摊封顶）
  const [orgFlight, setOrgFlight] = useState<Set<string>>(new Set());
  const [orgErr, setOrgErr] = useState<{ key: string; msg: string } | null>(null);
  const [orgCaps, setOrgCaps] = useState<CmdCaps>({});
  const ORG_CMD = "COMMAND_ORG_CONFIRM";
  const ORG_CAP_MSG = "该源 relay 版本不支持确认卡决议，升级 relay 后可用";
  const orgDecide = useCallback((srcId: string, confirmId: string, approve: boolean) => {
    const fk = orgFlightKey(srcId, confirmId);
    if (ackTapGuard(orgFlight, fk) === "skip") return;
    const payload = orgConfirmPayload(confirmId, approve);
    if (!payload) return;
    if (cmdCapBlocked(orgCaps, ORG_CMD)) {
      setOrgErr({ key: fk, msg: ORG_CAP_MSG });
      return;
    }
    setOrgFlight((prev) => new Set(prev).add(fk));
    setOrgErr(null);
    const settle = (v: AckVerdict): void => {
      setOrgFlight((prev) => {
        const n = new Set(prev);
        n.delete(fk);
        return n;
      });
      if (v.ok) return; // 成功等权威帧，不本地造状态
      if (unknownCommandError(v.error)) {
        setOrgCaps((prev) => cmdCapRemember(prev, ORG_CMD));
        setOrgErr({ key: fk, msg: ORG_CAP_MSG });
        return;
      }
      setOrgErr({ key: fk, msg: v.error ?? "决议未生效，可重试" });
    };
    const sent = store.orgConfirm(srcId, confirmId, payload.approve, (r) => settle(ackVerdict(r)));
    if (!sent) settle(ackVerdict(null)); // 未连接：同 unconfirmed 口径可见可重试
  }, [orgFlight, orgCaps]);

  // E2b：通知中心（root 通知动作宿主）。池=全源 notifications 只读平铺——
  // **不清零硬条款**（B3a 口径）：打开/浏览/关闭/重连/动作失败回滚零删行（本组件
  // 无任何清池 state；badge 与行动行只随 handled/dismissed 权威账收缩）。
  // 动作走 store.ackNotification（E3b 真链路：乐观+失败回滚+onDone），本层 ACK
  // 严格判定后呈现行内错误；无自动重试（重试=重点按钮），双击闸防重复 ACK
  const notifRows = useMemo(() => {
    const out: { srcId: string; srcName: string; item: NotificationItem }[] = [];
    for (const src of snap.sources)
      for (const n of src.notifications ?? [])
        out.push({ srcId: src.id, srcName: displaySrcName(src.name), item: n });
    return out;
  }, [snap.sources]);
  const notifPending = useMemo(() => notifActionableOf(notifRows.map((r) => r.item)), [notifRows]);
  const [notifFlight, setNotifFlight] = useState<Set<string>>(new Set());
  const [notifErr, setNotifErr] = useState<Map<string, string>>(new Map());
  const notifAct = useCallback((key: string, action: "handled" | "dismissed") => {
    if (ackTapGuard(notifFlight, key) === "skip") return;
    setNotifFlight((prev) => new Set(prev).add(key));
    const settle = (msg: string | null): void => {
      setNotifFlight((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      setNotifErr((prev) => {
        const n = new Map(prev);
        if (msg) n.set(key, msg);
        else n.delete(key);
        return n;
      });
    };
    const sent = store.ackNotification(key, action, (r) => {
      const v = ackVerdict({ ok: r.ok, error: r.err });
      if (v.ok) {
        settle(null);
        return;
      }
      // 乐观回滚由 store 负责（E3b 行回来）；本层只呈现行内错误，不自动重试
      settle(unknownCommandError(v.error) ? "该源 relay 版本不支持通知动作" : v.error ?? "未生效，可重试");
    });
    if (!sent) settle(ackVerdict(null).error); // 未连接：unconfirmed 文案
  }, [notifFlight]);

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
        <Pressable
          style={styles.logoBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
          onPress={() => setDrawerOpen(true)}
          hitSlop={6}
        >
          <View style={styles.logo}>
            <LogoMark size={19} />
          </View>
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.titleT}>CC Deck</Text>
          {snap.aggregate && snap.sources.length > 1 ? (
            // #53 副标题与聚合胶囊去重：数量/聚合态信息归统计行胶囊独占，副标题
            // 统一点名当前活动源（命令默认去向）；无活动源时回退唯一在线源点名
            (activeName || soloName) ? (
              <Text style={styles.titleSub} numberOfLines={1}>{activeName || soloName}</Text>
            ) : null
          ) : activeName ? (
            <Text style={styles.titleSub} numberOfLines={1}>{activeName}</Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.connChip, { borderColor: withA(connColor, 0.33) }]}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
          hitSlop={6}
          accessibilityLabel={`连接状态 ${connText}，点击${snap.connState === "unpaired" ? "去设置重新配对" : "立即重连"}`}
          onPress={() => {
            // 方案 A（2026-09-16）：设备图标=源切换入口——点击展开源列表切换活动面板，
            // 切换只动视图不拆连接（store #27 单源=视图过滤）。原三态分流（重试/去设置）
            // 收进菜单：离线行点选即连接（connectServer 幂等）、菜单底部保留管理入口
            setSrcMenu((v) => !v);
          }}
        >
          {/* #52 chip 精简：去状态色点与通道后缀（多源混合通道无法单一展示），
              文案颜色仍承载连接状态（绿/黄/红） */}
          {/* #80 统计前配电脑图标（桌面端同款），颜色随连接态 */}
          <DeskGlyph color={connColor} />
          <Text style={[styles.connText, { color: connColor }]}>{connText}</Text>
          {(snap.connState === "connecting" || snap.connState === "reconnecting") ? <ConnDots color={connColor} /> : null}
        </Pressable>
        {srcMenu ? (
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSrcMenu(false)} />
        ) : null}
        {srcMenu ? (
          <View style={styles.srcMenu}>
            {[...snap.sources].sort((a, b) => (b.id === snap.activeSourceId ? 1 : 0) - (a.id === snap.activeSourceId ? 1 : 0)).map((src) => {
              const stc = src.state === "online" ? c.done : src.state === "offline" ? c.error : c.working;
              const entry = srvEntries.find((e) => e.id === src.id);
              const isActive = src.id === snap.activeSourceId;
              return (
                <Pressable
                  key={src.id}
                  style={[styles.srcRow, isActive && styles.srcRowOn]}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onPress={() => {
                    setSrcMenu(false);
                    if (entry) void store.connectServer(entry);
                    else setDrawerOpen(true); // 快照有/落库无（异常态）：引导去设置看
                  }}
                >
                  <View style={[styles.srcMenuDot, { backgroundColor: stc }]} />
                  <Text style={styles.srcMenuName} numberOfLines={1}>{src.name}</Text>
                  <Text style={styles.srcMenuChan}>{src.channel === "cloud" ? "云桥" : src.channel === "lan" ? "直连" : ""}</Text>
                </Pressable>
              );
            })}
            <Pressable
              style={styles.srcMenuManage}
              android_ripple={{ color: c.tintSoft, borderless: false }}
              onPress={() => { setSrcMenu(false); setDrawerOpen(true); }}
            >
              <Text style={styles.srcMenuManageT}>管理连接（编辑 / 删除）…</Text>
            </Pressable>
          </View>
        ) : null}
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
      </View>
      <View style={styles.statRow}>
        {/* #52 聚合胶囊（替代 #26 电脑图标）：开关与数量合一——聚合开=「聚合 · N」
            品牌色高亮可点切回；关=「单源」中性色。即当前面板展示范围的自述 */}
        <Pressable
          style={{ paddingHorizontal: 7, paddingVertical: 6, borderRadius: 9 }}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
          hitSlop={6}
          accessibilityLabel={snap.aggregate ? `聚合模式，展示 ${snap.sources.length} 台电脑，点击切回单源` : "单源模式，点击开启聚合"}
          onPress={toggleAggregate}
        >
          {/* 2026-09-14 纯图标版（用户反馈：用图标就不配汉字、去外框）——单源=单台灰
              电脑；聚合=品牌色主电脑 + 右后灰副电脑半叠放 */}
          <View style={{ width: 20, height: 14, justifyContent: "flex-end", position: "relative" }}>
            <View style={{ width: 17, height: 12.5, borderRadius: 3, borderWidth: 2, borderColor: snap.aggregate ? c.brandA : c.dim, justifyContent: "flex-end", alignItems: "center", paddingBottom: 2.5 }}>
              <View style={{ width: 9, height: 2, borderRadius: 1, backgroundColor: snap.aggregate ? c.brandA : c.dim }} />
            </View>
            {snap.aggregate && (
              <View style={{ position: "absolute", top: -2, right: -3, width: 12, height: 9, borderRadius: 2.4, borderWidth: 1.7, borderColor: c.dim, opacity: 0.55 }} />
            )}
          </View>
        </Pressable>
        <View style={styles.statChips}>
          {statusItems.map(({ k, n, color }) => (
            <View key={k} style={styles.statChip}>
              <View style={[styles.statDot, { backgroundColor: color }]} />
              <Text style={[styles.statChipT, { color }]}>{n}</Text>
            </View>
          ))}
          {statusItems.length > 0 ? (
            <Pressable style={styles.helpBtn} onPress={() => setLegendOpen(true)} hitSlop={8}>
              <Text style={styles.helpT}>?</Text>
            </Pressable>
          ) : null}
        </View>
        {/* 布局三档循环胶囊（原抽屉「列表布局」拨杆迁入）：折叠空闲同款形制，随手切密度 */}
        <Pressable
          style={styles.densityBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
          onPress={cycleDensity}
          hitSlop={4}
          accessibilityLabel={`列表布局${DENSITY_LABEL[density]}，点击切换`}
        >
          <Text style={styles.densityT} numberOfLines={1}>{DENSITY_LABEL[density]}</Text>
        </Pressable>
        {idleCount > 0 ? (
          <Pressable
            style={[styles.collapseBtn, collapseIdle && styles.collapseBtnOn]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
            onPress={toggleCollapse}
          >
            <Text style={[styles.collapseT, collapseIdle && styles.collapseTOn]} numberOfLines={1}>
              {collapseIdle ? `展开空闲 ${idleCount}` : "折叠空闲 ▾"}
            </Text>
          </Pressable>
        ) : null}
        {notifPending.length > 0 ? (
          // E2b 通知中心入口：badge=未决行动项计数（只随权威账收缩，打开不清零）
          <Pressable
            style={styles.bellBtn}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
            onPress={() => setNotifOpen(true)}
            hitSlop={4}
            accessibilityLabel={`通知中心，${notifPending.length} 项需行动`}
          >
            <Text style={styles.bellT} numberOfLines={1}>通知 · {notifPending.length > 99 ? "99+" : notifPending.length}</Text>
          </Pressable>
        ) : null}
        {snap.sources.some(artPoolGate) ? (
          /* #72 E 线 入口①（常驻钮）：产物池=全局目录视图（与会话账正交的单源），
             三重门（探测 yes && deliverables && online）任一源过即显——降级=下线不
             灰置（探测 no/未探明的源整体隐藏，W 线同口径）。bellBtn 同款形制=
             统计行胶囊既有常驻钮语言 */
          <Pressable
            style={styles.bellBtn}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
            onPress={onOpenArtPool}
            hitSlop={4}
            accessibilityLabel="打开全局输出物目录"
          >
            <Text style={styles.bellT} numberOfLines={1}>输出物</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        // 密度切换强制重挂载：行高在极简(~40px)↔标准(~90px)间剧变时，
        // VirtualizedList 复用旧 cell 的陈旧布局度量导致整列空白（#392 回归，
        // 冷启动正常、仅切换路径复现）。key 换代即整体重建，窗口/度量全新
        key={density}
        data={rows}
        keyExtractor={(r) => r.key}
        stickyHeaderIndices={stickyIndices}
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
        // G5（冲刺审查）：任务完成汇报悬浮钮（列表页抬高让开 FAB，bottom=insets+124）
        // 非空时末卡右缘被遮——条件让位 +52（浮钮形态用户拍板 #17 勿改，只让内容让路）
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 + (snap.taskDoneQueue.length > 0 ? 52 : 0), paddingHorizontal: 0, paddingTop: 6 }}
        // #137 待填验收单条件卡：统计行下方、会话列表顶部（有待填单才出现）
        // #26 M2 组织区（确认卡 + 项目组 chips）与之同位平铺；OrgZone 空数据自返回 null
        ListHeaderComponent={
          <>
            {accPending.length > 0 ? (
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
            ) : null}
            <OrgZone
              confirms={orgConfirms}
              groups={orgGroups}
              onDecide={orgDecide}
              onOpenGroup={(src, g) => setOrgOpen({ srcId: src.id, gid: g.id, name: g.name })}
            />
            {orgErr ? (
              // E2b：决议失败可见态（ACK 判定门产出）——行内错误可关闭，无自动重试
              <View style={styles.orgErrRow}>
                <Text style={styles.orgErrT} numberOfLines={2}>{orgErr.msg}</Text>
                <Pressable hitSlop={8} accessibilityLabel="关闭决议错误提示" onPress={() => setOrgErr(null)}>
                  <Text style={styles.orgErrClose}>×</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        }
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
        renderItem={({ item }) =>
          item.h === "sec" ? (
            <SectionHeader label={item.label} count={item.count} />
          ) : item.h === "src" ? (
            <GroupHeader name={item.name} color={item.color || c.faint} online={item.online} count={item.count} />
          ) : (
            <SessionCard
              s={item.s}
              onOpen={onOpen}
              onResume={handleResumeSaved}
              onRename={handleRename}
              onDelete={requestDelete}
              revealSid={revealSid}
              onReveal={setRevealSid}
              density={density}
              srcBadge={srcBadgeOf(item.s.src)}
              orgTag={orgTagOf(item.s)}
            />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>{collapseIdle && idleCount > 0 ? "空闲会话已折叠" : "还没有会话"}</Text>
            {/* 空态文案规范：一句状态 + 一句指引，各 ≤15 字 */}
            <Text style={styles.emptyS}>
              {collapseIdle && idleCount > 0
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

      <View style={styles.edgeZone} {...edgePan.panHandlers} />

      <PressScale style={[styles.fab, { bottom: insets.bottom + 24 }]} ripple="rgba(255,255,255,0.18)" haptic onPress={onNew}>
        <View style={styles.fabGrad}>
          <PlusMark size={20} color={c.fabPlus} />
        </View>
      </PressScale>

      {/* 删除撤销条（#247）：4s 窗口，撤销即恢复卡片；抽屉/图例打开时收起（层级 60 之下防穿模） */}
      <UndoBar shown={!!pendingDel && !drawerOpen && !legendOpen} title={pendingTitle} onUndo={undoDelete} />

      <RenameModal
        visible={!!renameTarget}
        initial={renameTarget?.title ?? ""}
        onCancel={() => setRenameSid(null)}
        onSubmit={(title) => {
          if (renameTarget) store.send("COMMAND_RENAME", { session_id: renameTarget.session_id, title });
          setRenameSid(null);
        }}
      />

      <SettingsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSetup={onSetup}
        onScan={onScanServer}
        onEdit={(e) => onEditServer(e.id)}
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

      {/* #26 M2 项目组详情弹窗（点组织区 chip 呼出） */}
      {orgOpen ? (
        <GroupModal
          srcId={orgOpen.srcId}
          target={{ gid: orgOpen.gid, name: orgOpen.name }}
          highlightEntryId={orgOpen.entryId}
          onClose={() => setOrgOpen(null)}
          onOpenSession={onOpen}
        />
      ) : null}

      {/* E2b 通知中心（铃铛/返回键呼出；打开/关闭零清零，池只读自快照）。
          M13-6E onJump：回跳前先收通知中心（返回键分发面恢复），再 onOpen 打开
          归因会话（导航聚焦）；target 仅 session 落点（jumpTargetOf 已把关） */}
      <NotifCenterModal
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        rows={notifRows}
        flight={notifFlight}
        errs={notifErr}
        onAct={notifAct}
        onJump={(t, srcId) => {
          setNotifOpen(false);
          if (t.type === "session") { onOpen(t.sid); return; }
          // task 落点：组详情打开后高亮定位台账卡（orgDetail 现拉全量为准）；组不在
          // 该源 projects 在册（缓存悬空）=不跳不假造（M12-7 unknown-target 同哲学）
          const g = (snap.sources.find((x) => x.id === srcId)?.projects ?? []).find((pg) => pg.id === t.gid);
          if (!g) return;
          setOrgOpen({ srcId, gid: t.gid, name: g.name, entryId: t.entryId });
        }}
      />
    </SafeAreaView>
  );
}

// E2b 通知中心 Modal：全源通知池只读列表 + actionable 未决行「知道了/忽略」动作。
// 池只读自 store 快照——本组件无任何清池路径（打开/浏览/关闭/重连不清零）；
// 动作经 ACK 严格判定门（notifAct）：失败行内错误可重试，飞行中按钮转「…」；
// 旧 relay notifications null/缺失 → 池空自然降级空态，不崩不伪造。
// M13-6E resolved 分离：已处理行（三时间戳任一）拆入「已处理 N」折叠分区（默认
// 收起防长跑堆积），灰态+处理时刻（fmtLastActive 行语言）；main/resolved 两区各保
// 池序不重排。M13-6E 验收回跳：acceptance 域未处理行经 jumpTargetOf 归因命中时
// 显示「定位来源 ›」点击面（关中心→onJump 打开原会话）；归因缺失=无点击面降级。
function NotifCenterModal({ open, onClose, rows, flight, errs, onAct, onJump }: {
  open: boolean;
  onClose: () => void;
  rows: { srcId: string; srcName: string; item: NotificationItem }[];
  flight: Set<string>;
  errs: Map<string, string>;
  onAct: (key: string, action: "handled" | "dismissed") => void;
  onJump: (target: NotifJumpTarget, srcId: string) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  const pendingKeys = useMemo(
    () => new Set(notifActionableOf(rows.map((r) => r.item)).map((n) => n.key)),
    [rows],
  );
  // M13-6E 分区：done 行拆入「已处理 N」折叠区（默认收起；展开态组件本地内存级，
  // 关闭即回默认——同 confirmDismissedKey 不落盘哲学）
  const { main, resolved } = useMemo(() => splitResolvedRows(rows, (r) => notifDoneAt(r.item)), [rows]);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  // 关闭即回默认收起：再开通知中心永远「默认折叠」（规格①口径；展开态不跨开合保留）
  useEffect(() => {
    if (!open) setResolvedOpen(false);
  }, [open]);
  const renderRow = (row: { srcId: string; srcName: string; item: NotificationItem }) => {
    const { srcId, srcName, item } = row;
    const actionable = pendingKeys.has(item.key);
    const busy = flight.has(item.key);
    const err = errs.get(item.key);
    const doneAt = notifDoneAt(item);
    // 回跳点击面口径对齐 web（canJmp=actionable 且未收口；已处理区=归档语义纯展示）。
    // 落点解析与 web notifJumpTarget 同链：dispatch 域板缓存反查→task；降级 sessionId
    // →session；解析不出=null 无按钮（不假造）。源板缓存取自该行 srcId 对应源
    const jump = actionable && doneAt === null
      ? jumpTargetOf(item, { sessions: snap.sessions, srcId, boards: snap.sources.find((x) => x.id === srcId)?.boards })
      : null;
    return (
      <View key={`${srcId}/${item.key}`} style={styles.notiRow}>
        <View style={styles.notiRowHead}>
          {actionable ? <View style={styles.notiDot} /> : null}
          <Text style={[styles.notiRowTitle, !actionable && { color: c.dim }]} numberOfLines={1}>{item.title}</Text>
          {doneAt !== null ? <Text style={styles.notiDoneAt}>{fmtLastActive(doneAt)}</Text> : null}
          <Text style={styles.notiSrc} numberOfLines={1}>{srcName}</Text>
        </View>
        {item.body ? <Text style={styles.notiBody} numberOfLines={2}>{item.body}</Text> : null}
        {err ? <Text style={styles.notiErrT} numberOfLines={2}>{err}</Text> : null}
        {jump ? (
          // M13-6E 验收回跳（规格②，web nr-jmp 行同语义）：点击关通知中心→导航聚焦
          //（task=组详情定位台账卡 / session=打开原会话）；降级路径无此按钮不假造
          <Pressable
            style={styles.notiJumpBtn}
            hitSlop={6}
            accessibilityLabel={`定位来源：${item.title}`}
            onPress={() => onJump(jump, srcId)}
          >
            <Text style={styles.notiJumpT}>定位来源 ›</Text>
          </Pressable>
        ) : null}
        {actionable ? (
          <View style={styles.notiActRow}>
            <Pressable
              style={[styles.notiBtn, { backgroundColor: c.done, opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              accessibilityLabel={`知道了：${item.title}`}
              onPress={() => onAct(item.key, "handled")}
            >
              <Text style={[styles.notiBtnT, { color: c.onDone }]}>{busy ? "…" : "知道了"}</Text>
            </Pressable>
            <Pressable
              style={[styles.notiBtn, styles.notiBtnGhost, { borderColor: withA(c.dim, 0.5), opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              accessibilityLabel={`忽略：${item.title}`}
              onPress={() => onAct(item.key, "dismissed")}
            >
              <Text style={[styles.notiBtnT, { color: c.dim }]}>{busy ? "…" : "忽略"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.notiMask} onPress={onClose}>
        <Pressable style={styles.notiSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.notiHead}>
            <Text style={styles.notiTitle}>通知中心</Text>
            <Text style={styles.notiSub}>{pendingKeys.size > 0 ? `${pendingKeys.size} 项需行动` : "暂无待行动项"}</Text>
            <Pressable hitSlop={10} accessibilityLabel="关闭通知中心" onPress={onClose}>
              <Text style={styles.notiClose}>×</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.notiList} contentContainerStyle={{ paddingBottom: 24 }}>
            {rows.length === 0 ? (
              <Text style={styles.notiEmpty}>暂无通知</Text>
            ) : (
              <>
                {main.map(renderRow)}
                {resolved.length > 0 ? (
                  // M13-6E「已处理 N」折叠分区（规格①）：默认收起防长跑堆积；
                  // 行不删除（不清零硬条款不破——拆区≠删行，池仍只读自快照）
                  <View>
                    <Pressable
                      style={styles.notiResolvedHead}
                      hitSlop={8}
                      accessibilityLabel={resolvedOpen ? "收起已处理通知" : `展开已处理通知 ${resolved.length} 条`}
                      onPress={() => setResolvedOpen((v) => !v)}
                    >
                      <Text style={styles.notiResolvedT}>已处理 {resolved.length} {resolvedOpen ? "▴" : "▾"}</Text>
                    </Pressable>
                    {resolvedOpen ? resolved.map(renderRow) : null}
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  // ═══════ E2b：通知中心入口/Modal + 决议错误行 ═══════
  bellBtn: {
    backgroundColor: c.tintSoft, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6,
  },
  bellT: { color: c.brandA, fontSize: 11, fontWeight: "700" },
  notiMask: { flex: 1, backgroundColor: "rgba(0,0,0,.45)", justifyContent: "flex-end" },
  notiSheet: {
    backgroundColor: c.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderWidth: 1, borderColor: c.line, maxHeight: "78%",
  },
  notiHead: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line,
  },
  notiTitle: { color: c.text, fontSize: 15, fontWeight: "700", flex: 1 },
  notiSub: { color: c.brandA, fontSize: 11, fontWeight: "600" },
  notiClose: { color: c.faint, fontSize: 20, fontWeight: "600", paddingLeft: 6 },
  notiList: { paddingHorizontal: 14 },
  notiEmpty: { color: c.faint, fontSize: 12, textAlign: "center", paddingVertical: 32 },
  notiRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 4 },
  notiRowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  notiDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.working },
  notiRowTitle: { color: c.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  notiSrc: { color: c.faint, fontSize: 10, marginLeft: "auto" },
  notiBody: { color: c.dim, fontSize: 12, lineHeight: 17 },
  notiActRow: { flexDirection: "row", gap: 8, marginTop: 2 },
  notiBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  notiBtnGhost: { backgroundColor: "transparent", borderWidth: 1 },
  notiBtnT: { fontSize: 12, fontWeight: "600" },
  notiErrT: { color: c.error, fontSize: 11, lineHeight: 15 },
  // M13-6E：已处理行时间戳（复用 notiSrc 灰态小字语言）+「已处理 N」折叠分区头
  notiDoneAt: { color: c.faint, fontSize: 10 },
  notiResolvedHead: { paddingVertical: 10, alignItems: "center" },
  notiResolvedT: { color: c.faint, fontSize: 11, fontWeight: "600" },
  // M13-6E：acceptance 域回跳按钮（未处理行「定位来源 ›」——ghost 同款形制小号化）
  notiJumpBtn: { alignSelf: "flex-start", borderRadius: 8, borderWidth: 1, borderColor: withA(c.dim, 0.5), paddingHorizontal: 10, paddingVertical: 4, marginTop: 2 },
  notiJumpT: { color: c.dim, fontSize: 11, fontWeight: "600" },
  orgErrRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 10, borderWidth: 1, borderColor: withA(c.error, 0.45),
    backgroundColor: c.panel, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
  },
  orgErrT: { color: c.error, fontSize: 11.5, lineHeight: 16, flex: 1 },
  orgErrClose: { color: c.faint, fontSize: 15, fontWeight: "600" },
  // #137 待填验收单卡（列表顶部条件卡）：卡片形制对齐会话卡（panel 底/line 边/
  // 12 圆角），品牌色只点「验收单」标签与「去填写」动作（#102 品牌色克制）
  accCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 12, borderWidth: 1, marginBottom: 8, overflow: "hidden",
    backgroundColor: c.panel, borderColor: c.line,
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
    backgroundColor: c.panel, borderRadius: 12, borderWidth: 1, borderColor: c.line,
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
    // #198 横线与详情页 head 对齐：padding 10/8→9/6 + 标题列 lineHeight 显式化
    //（titleT 20 / titleSub 13，与详情页 d.title/d.sub 同档）——两页 head 构造等高
    //（详情=6+20+3+14+6，列表=9+max(logo34,20+0.5+13)+6），分隔线 Y 一致
    paddingHorizontal: 16, paddingTop: 9, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: c.line,
  },
  logoBtn: { borderRadius: 12 },
  logo: {
    width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
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
  titleWrap: { flexShrink: 1, marginRight: "auto" },
  titleT: { color: c.text, fontSize: 16, fontWeight: "700", letterSpacing: 0.2, lineHeight: 20 }, // #198 lineHeight 显式（原字体度量浮动）
  titleSub: { color: c.faint, fontSize: 11, lineHeight: 13, marginTop: 0.5 },
  statRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4,
    height: 34,
  },
  statSrc: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  statTotal: { color: c.dim, fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  statChips: { flexDirection: "row", gap: 9 },
  statChip: { flexDirection: "row", alignItems: "center", gap: 3.5 },
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
    position: "absolute", top: 90, left: 18, minWidth: 128,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 12,
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
  secHead: {
    flexDirection: "row", alignItems: "baseline", gap: 6,
    marginTop: 14, marginBottom: 5, paddingHorizontal: 14,
    backgroundColor: c.bg,
  },
  secHeadT: { color: c.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  secCount: { color: c.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  // E2a 活动指标块：四行定高小字（行距 gap 3、lineHeight 定值、单行 ellipsis），
  // 键淡值常——activity 缺失/能力全关时整块不渲染
  actBlock: { marginTop: 4, marginBottom: 1, paddingLeft: 6, gap: 3 },
  actLine: { fontSize: 11, lineHeight: 14 },
  actKey: { color: c.faint, fontSize: 10 },
  actVal: { fontSize: 11, fontVariant: ["tabular-nums"] },
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
  swipeWrap: { marginBottom: 2, borderRadius: 0, overflow: "hidden" },
  swipeWrapC: { marginBottom: 2 },
  swipeWrapM: { marginBottom: 1 },
  swipeCard: { borderRadius: 0, overflow: "hidden", backgroundColor: c.bg },
  // #32 离线源降权 + 空闲置灰：向页面背景渐隐的蒙层（不用 opacity——会让底层
  // 动作排透出，2026-09-17 测试机截图实锤）
  dimCover: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: withA(c.bg, 0.45) },
  actPanel: {
    position: "absolute", top: 3, bottom: 3, right: 0, width: FULL_W,
    flexDirection: "row", borderRadius: 10, overflow: "hidden",
  },
  actPanelM: { top: 2, bottom: 2, borderRadius: 10 },
  actBtn: { width: ACT_W, alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: withA(c.waiting, 0.9) },
  actRen: { backgroundColor: c.brandB },
  actOff: { backgroundColor: withA(c.dim, 0.3) },
  actT: { color: "#fff", fontSize: 17, fontWeight: "600" },
  actT2: { color: "#fff", fontSize: 11.5, fontWeight: "600" },
  card: {
    backgroundColor: "transparent", borderWidth: 0,
    borderRadius: 0, paddingVertical: 8, paddingHorizontal: 14,
  },
  cardC: { borderRadius: 0, paddingVertical: 6, paddingHorizontal: 14 },
  // 极简平铺行：同通栏语言，行高最矮
  cardM: { borderRadius: 0, borderWidth: 0, paddingVertical: 7, paddingHorizontal: 14 },
  rowC: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowM: { flexDirection: "row", alignItems: "center", gap: 7 },
  titleM: { color: c.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  // 极简行水位区（常显）：固定 64px 右对齐 = 细条轨道（44px）+ 9px 百分比/占位，
  // 有无水位各行右缘恒定不跳
  ctxCell: { width: 64, alignItems: "flex-end", gap: 2.5 },
  ctxCellBar: { width: 44, height: 3, borderRadius: 1.5, backgroundColor: c.tintSoft, overflow: "hidden" },
  ctxCellT: { fontSize: 9, lineHeight: 11, fontVariant: ["tabular-nums"], color: c.faint },
  // #362 WORKING 实时工作行独立成第二行（标题让位第一行），与 sum 同底距
  liveRow: { flexDirection: "row", alignItems: "center", marginBottom: 5, paddingLeft: 6 }, /* #83 二/三行缩进对齐标题文字（灯 11+gap 7） */
  titleC: { color: c.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  sumC: { color: c.faint, fontSize: 11, marginTop: 2 },
  footC: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  folderC: { fontSize: 10, color: c.dim, flexShrink: 1, maxWidth: 120 },
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
  ava: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  avaT: { fontSize: 15, fontWeight: "700" },
  srowMain: { flex: 1, minWidth: 0, gap: 3 },
  srowR1: { flexDirection: "row", alignItems: "center", gap: 6 },
  srowTitle: { flex: 1, color: c.textStrong, fontSize: 13.5, fontWeight: "600" },
  srowR2: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 16 },
  srowSum: { flex: 1, color: c.dim, fontSize: 12, lineHeight: 16 },
  srowBgTag: { color: c.working, fontSize: 10.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  srowR3: { flexDirection: "row", alignItems: "center", gap: 5 },
  srowTag: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  srowTagT: { fontSize: 10, fontWeight: "600" },
  srowMeta: { color: c.faint, fontSize: 10 },
  // 沉寂会话（DONE 非今日更新）名称降档：覆盖 title/titleC 的 color
  titleIdle: { color: c.dim },
  sum: { color: c.dim, fontSize: 13, marginBottom: 5, paddingLeft: 6 }, /* #83 同缩进 */
  /* #192 WAITING 卡摘要报警（对齐桌面 .card-summary.waiting；dangerFg 双主题保 AA） */
  sumWaiting: { color: c.dangerFg, fontWeight: "600" },
  foot: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 6 }, /* #83 同缩进 */
  // 次要信息合并行（降噪）：托管/外部 · 目录 · 历史 一行 faint 小字，替代原 tag 胶囊
  meta: { fontSize: 10, color: c.faint, flexShrink: 1 },
  // 上下文占用 mini（foot 最右）：30px 微型条 + 百分比
  ctxMini: { flexDirection: "row", alignItems: "center", gap: 4 },
  ctxMiniBar: { width: 30, height: 3, borderRadius: 1.5, backgroundColor: c.tintSoft, overflow: "hidden" },
  ctxMiniT: { fontSize: 10, fontVariant: ["tabular-nums"], minWidth: 24, textAlign: "right" },
  empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 42, marginBottom: 12, opacity: 0.5 },
  emptyT: { color: c.faint, fontSize: 14, marginBottom: 6 },
  emptyS: { color: c.faint, fontSize: 12, textAlign: "center", lineHeight: 20 },
  edgeZone: { position: "absolute", left: 0, top: 0, bottom: 0, width: 22, zIndex: 5 },
  // 列表底部上拉刷新提示行（#255）：滚到底自动触发，也可点按
  footHint: { alignItems: "center", paddingVertical: 10 },
  footHintT: { color: c.faint, fontSize: 12 },
  fab: { position: "absolute", right: 30, borderRadius: 16, elevation: 8 },
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
  // FAB 底/描边/十字色随主题（theme.ts fabBg/fabLine/fabPlus）：深色维持原近黑观感，
  // 浅色改品牌蓝主操作口径（2026-09-18 亮色黑底突兀反馈）
  fabGrad: {
    width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center",
    backgroundColor: c.fabBg, borderWidth: 1, borderColor: c.fabLine,
  },
  // #26 M2 组织区（v3.1 矩阵式）：确认卡 + 项目组 chips——确认卡形制对齐验收单卡
  // （panel 底/line 边/12 圆角），动作色沿用审批按钮（done ✓ / error ✗）；chips 沿
  // 折叠空闲胶囊形制，状态只到描边+tint（pending 黄 / active 绿 / parked 中性）
  orgZone: { gap: 6, marginBottom: 8 },
  orgCf: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 9, paddingHorizontal: 12,
    borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
  },
  orgCfKind: { color: c.brandA, fontSize: 10, fontWeight: "700", flexShrink: 0 },
  orgCfTitle: { color: c.text, fontSize: 12.5, fontWeight: "600" },
  orgCfReason: { color: c.faint, fontSize: 10.5, marginTop: 1 },
  orgCfBtn: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  orgCfBtnR: { borderWidth: 1, backgroundColor: "transparent" },
  orgCfBtnT: { fontSize: 15, fontWeight: "700" },
  orgChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  orgChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft, maxWidth: 210, overflow: "hidden",
  },
  orgChipT: { fontSize: 11.5, fontWeight: "600", maxWidth: 120 },
  orgChipSt: { color: c.faint, fontSize: 9.5 },
  // 组详情弹窗（gm*）：头部（名称+状态/档位 tags）→ 编制行 → 板段 → 回执流
  gmWrap: { flex: 1, backgroundColor: c.bg },
  gmHead: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line,
  },
  gmTitle: { color: c.text, fontSize: 15, fontWeight: "700" },
  gmTags: { flexDirection: "row", gap: 6, marginTop: 4 },
  gmTag: { color: c.dim, fontSize: 10.5, paddingHorizontal: 8, paddingVertical: 1.5, borderRadius: 999, borderWidth: 1, borderColor: c.line },
  gmClose: { color: c.dim, fontSize: 17, padding: 4 },
  gmBody: { padding: 16, paddingBottom: 40 },
  gmSec: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginTop: 16, marginBottom: 7 },
  gmSess: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 6, borderRadius: 9 },
  gmDot: { width: 8, height: 8, borderRadius: 4 },
  gmSessT: { flex: 1, minWidth: 0, color: c.text, fontSize: 12.5 },
  gmSessSt: { color: c.faint, fontSize: 10 },
  gmCol: { gap: 5 },
  gmColGroup: { marginBottom: 8 },
  gmColH: { color: c.faint, fontSize: 10.5, fontWeight: "700", marginBottom: 4 },
  gmEnt: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: c.panel },
  // M13-6E 验收回跳定位高亮（web jump-flash 闪烁的 expo 静态对等——动画差异备案）
  gmEntHi: { borderWidth: 1.5, borderColor: c.brandA, backgroundColor: c.tintSoft },
  gmEntT: { color: c.text, fontSize: 12 },
  gmEntNote: { color: c.faint, fontSize: 10.5, marginTop: 2 },
  gmRec: { borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: 8, paddingVertical: 3, marginBottom: 6 },
  gmRecB: { color: c.text, fontSize: 11.5, fontWeight: "600" },
  gmRecT: { color: c.dim, fontSize: 11, marginTop: 1 },
  gmRecMeta: { color: c.faint, fontSize: 10, marginTop: 1 },
  gmEmpty: { color: c.faint, fontSize: 11.5, paddingVertical: 4 },
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
