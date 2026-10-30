import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Animated, Dimensions, Image, InteractionManager, Linking, Modal, PanResponder, PermissionsAndroid, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, Vibration, View, type GestureResponderEvent, type NativeScrollEvent, type NativeSyntheticEvent, type NativeTouchEvent, type StyleProp, type TextStyle } from "react-native"
import { HEAD_BASE } from "../head-unify";
import { EngineIcon } from "../engine-icon"; // #239 W-DETAILAVATAR：详情 head 头像=列表卡同款品牌图标
import { inferEngine } from "../engine-infer"; // W-MOBLIST：engine 缺失按 model 推断（灭「?」）
import { MicIcon, DockDot, CtxSegMeter, SPIN_FRAMES, TranscriptRow, AskBanner, DiffBlock, StatRow, WaitCard, PendingRow, LiveStatusLine, TaskRefText } from "../components/detail-parts";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as DocumentPicker from "expo-document-picker";
// #79 拉取的输出物复杂格式（pdf/office 等）交系统应用打开——与 updates.ts 安装器
// 同款链路（getContentUriAsync + ACTION_VIEW + FLAG_GRANT_READ_URI_PERMISSION）
import * as IntentLauncher from "expo-intent-launcher";
// #62 真修：SDK 57 起 expo-file-system 主入口是新 API，readAsStringAsync 只是
// "will throw in runtime" 的弃用占位——此前主力机实测选任何文件都报「未添加」
// 就是它 unconditional throw（旧提示又把锅甩给大小限制）。legacy 子模块仍是
// 完整实现（Base64 编码 + Android content:// 都支持），选它直到新 API 有对等能力
import * as FileSystem from "expo-file-system/legacy";
// #79 晨间反馈：①HTML 报告内嵌渲染（WebView source html——夜间报告是 HTML，看源码
// 没意义）②文件本体分享（RN Share 只能发文本，系统分享面板要 expo-sharing）
import { WebView } from "react-native-webview";
import * as Sharing from "expo-sharing";
import * as Clipboard from "expo-clipboard";
import { withA, STATUS_ZH, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { fmtElapsed, sessionElapsed, fmtHM, dayKey, dayLabel, fmtLastActive, fmtClock, fmtTok, contextPct, contextLevel, CONTEXT_LIMIT_FALLBACK, isVerifyTodo, isLiveLine, stripLiveMark } from "../fmt";
import { store, useRelay } from "../store";
import { artPoolGate } from "../artpool";
import { markEchoState, pushPending, reconcilePending, type PendingEcho } from "../pending-echo";
import { fromB64, toB64 } from "../e2e";
// E3a：hasActivityCapability 为值导入（E1 落库面，只消费不修改）；其余仍纯类型
import { hasActivityCapability, type ArtifactItem, type CronTask, type LogEntry, type ProjectGroup, type SessionState, type SessionStatus, type TodoItem, type WaitingPayload } from "../protocol";
import { useKbHeight } from "../kb";
import { useEnterSend, useProcessFont, useVoiceInput } from "../display-settings";
import { voice } from "../voice";
import { BUILTIN_COMMANDS, fetchSlashCommands, httpBaseOf, matchSlash, type SlashCommand } from "../slash";
import { MdText } from "../md";
import { Collapse, FadeIn, PressScale } from "../motion";
import RenameModal from "./RenameModal";

// W-MOBFUSION 件④：PM/Leader 角色词表（桌面 SLIM_KEEP_ROLE 逐字同源，列表屏同款）
const SLIM_KEEP_ROLE_RE = /^(pm|leader|产品经理|项目经理|领队)$/i;

// W-MOBFUSION 件④：详情页 PM「团队」tab（桌面第四列团队抽屉四区同构 tab 化——
// Leader 拍板 tab 方案、弃边缘侧滑防与 tab 左右滑手势冲突）：
//   ① 在办概览=任务板五泳道计数（SNAPSHOT.boards + BOARD_UPDATED 缓存；板缺席=
//      「板未同步」降级不伪造 0/0/0）②成员 roster=角色徽+状态灯+水位+输出物数
//      （行点按直开成员会话，桌面 data-slim-open 同职能）③输出物计数汇总
//      ④跳团队域钮。泳道词表与桌面 TEAM_DRAWER_LANES 同源（legacy 归并）
const TEAM_LANES: { k: string; label: string }[] = [
  { k: "backlog", label: "待认领" },
  { k: "claimed", label: "进行中" },
  { k: "submitted", label: "待审查" },
  { k: "ready_to_install", label: "待收单" },
  { k: "done", label: "完成" },
];
const TEAM_LANE_LEGACY: Record<string, string> = { todo: "backlog", doing: "claimed" };
const PM_STATUS_ZH: Record<string, string> = { WORKING: "在跑", WAITING: "待确认", ERROR: "异常", DONE: "空闲" };

function TeamPane({ team, sessions, boards, onOpenSession, onOpenTeam }: {
  team: ProjectGroup;
  sessions: SessionState[];
  boards?: Record<string, { entries?: { status?: string }[] }>;
  onOpenSession?: (sid: string) => void;
  onOpenTeam?: () => void;
}) {
  const { c } = useTheme();
  const board = team.id ? boards?.[team.id] : undefined;
  const entries = Array.isArray(board?.entries) ? board!.entries : null;
  const laneOf = (st?: string) => (st ? TEAM_LANE_LEGACY[st] ?? st : "");
  const lanes = entries ? TEAM_LANES.map((l) => ({ ...l, n: entries.filter((e) => laneOf(e?.status) === l.k).length })) : null;
  const activeN = lanes ? lanes.slice(0, 4).reduce((n, l) => n + l.n, 0) : null;
  const sessionsById = useMemo(() => new Map(sessions.map((x) => [x.session_id, x] as const)), [sessions]);
  // W-MOBFUSION R2（审查 B P2）：headcount 条目判空（wire 脏数据 null 成员防红屏，桌面 slimRosterOf 同滤）
  const roster = (team.headcount ?? []).filter((m) => m && typeof m.session_id === "string").map((m) => {
    const s = sessionsById.get(m.session_id) ?? undefined;
    const role = String(m.role || "");
    const pct = s && Number(s.context_limit) ? Math.min(100, Math.round((Number(s.context_usage) || 0) / (Number(s.context_limit) || 1) * 100)) : null;
    const arts = s && Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path).length : 0;
    return { sid: m.session_id, role, nick: String(m.nick || ""), pm: SLIM_KEEP_ROLE_RE.test(role), s, pct, arts };
  });
  const running = roster.filter((r) => r.s?.status === "WORKING" && isRealWorking(r.s)).length; /* #291：待命不占在跑计数 */
  const artsTotal = roster.reduce((n, r) => n + r.arts, 0);
  const artsPeople = roster.filter((r) => r.arts > 0).length;
  const roleBadge = (role: string, pm: boolean) => (pm ? "✦" : /^(qa|reviewer|验收)$/i.test(role) ? "QA" : "W");
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
      {/* ① 在办概览（板五泳道） */}
      <View style={{ marginBottom: 16 }}>
        <Text style={{ color: c.faint, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6 }}>在办概览{activeN != null ? ` · ${activeN} 在办` : ""}</Text>
        {lanes ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {lanes.map((l) => (
              <View key={l.k} style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: withA(c.line, 0.9), backgroundColor: c.panel }}>
                <Text style={{ color: c.dim, fontSize: 10.5 }}>{l.label} <Text style={{ color: l.k === "done" ? c.faint : c.textStrong, fontWeight: "700" }}>{l.n}</Text></Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={{ color: c.faint, fontSize: 11.5 }}>板未同步 · 深度实时去团队域</Text>
        )}
      </View>
      {/* ② 成员 roster（行点按直开成员会话） */}
      <View style={{ marginBottom: 16 }}>
        <Text style={{ color: c.faint, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6 }}>成员编制 · {roster.length} 席 · {running} 在跑</Text>
        {roster.map((r) => {
          const st = r.s?.status;
          const standby = st === "WORKING" && !isRealWorking(r.s); /* #291 待命：灰灯+「待开工」 */
          const lamp = standby ? c.faint : st === "WORKING" ? c.working : st === "ERROR" ? c.error : st === "WAITING" ? c.working : c.faint;
          const name = r.nick || r.s?.title || r.sid.slice(0, 8);
          return (
            <Pressable
              key={r.sid}
              onPress={r.s ? () => onOpenSession?.(r.sid) : undefined}
              disabled={!r.s}
              android_ripple={{ color: c.tintSoft, borderless: false }}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, opacity: r.s ? 1 : 0.55 }}
            >
              <Text style={{ color: r.pm ? c.brandA : c.faint, fontSize: 10, fontWeight: "700", width: 16 }}>{roleBadge(r.role, r.pm)}</Text>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: lamp, opacity: st === "WORKING" ? 1 : 0.55 }} />
              <Text style={{ flex: 1, minWidth: 0, color: c.text, fontSize: 12.5 }} numberOfLines={1}>{name}</Text>
              {r.pct != null ? <Text style={{ color: c.faint, fontSize: 10.5, fontVariant: ["tabular-nums"] }}>{r.pct}%</Text> : null}
              {r.arts > 0 ? <Text style={{ color: c.faint, fontSize: 10.5 }}>◈{r.arts}</Text> : null}
              <Text style={{ color: c.faint, fontSize: 10, width: 34, textAlign: "right" }}>{standby ? "待开工" : st ? PM_STATUS_ZH[st] ?? st : "未同步"}</Text>
            </Pressable>
          );
        })}
      </View>
      {/* ③ 输出物计数汇总 */}
      <View style={{ marginBottom: 16 }}>
        <Text style={{ color: c.faint, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6 }}>输出物</Text>
        <Text style={{ color: c.dim, fontSize: 12 }}>{artsTotal > 0 ? `共 ${artsTotal} 件 · ${artsPeople} 人有产出` : "暂无产出"}</Text>
      </View>
      {/* ④ 跳团队域 */}
      <Pressable
        onPress={() => onOpenTeam?.()}
        android_ripple={{ color: c.tintSoft, borderless: false }}
        style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: withA(c.brandA, 0.4), backgroundColor: withA(c.brandA, 0.1) }}
      >
        <Text style={{ color: c.brandA, fontSize: 12.5, fontWeight: "600" }}>去团队域 ›</Text>
      </Pressable>
    </ScrollView>
  );
}

// 详情页视图 tab（W-EXPO 005 化：对齐 index-005 四 tab 制——对话/任务/输出物/
// 更多）。更多 = 水位计（context-meter）+ 统计键值行 + 定时任务收编（原
// 全部/定时/统计三 tab 退役；「全部」过滤视图差异备案后续阶段）。
// #26 M2 词表迁移（v3.1 §2.4）：「消息」→「对话」。
const VIEWS = [
  { k: "msg", label: "对话" },
  { k: "todos", label: "任务" },
  { k: "arts", label: "输出物" },
  { k: "more", label: "更多" },
  // W-MOBFUSION 件④：PM 会话第 5 tab（Leader 拍板 tab 方案、弃边缘侧滑——与
  // tab 左右滑手势冲突）；非 PM 会话运行时从 VS 滤除不显（VIEWS 静态全集同 arts 口径）
  { k: "team", label: "团队" },
] as const;
// tab 指示条几何参数：tabWrap 左边距与 tab 间隙（JS 几何计算与 makeStyles 共用）

export type ViewKind = (typeof VIEWS)[number]["k"];

// SpeechRecognizer 错误码人话（反馈排查用；1/2/4 多为云识别服务连不上）
const VOICE_ERR_NAMES: Record<number, string> = {
  1: "网络超时",
  2: "网络",
  3: "麦克风",
  4: "识别服务",
  5: "客户端",
  8: "忙",
  9: "权限",
};

// 权限模式循环切换（与 relay 的 ManagedPermissionMode 对齐）。四档含"跳过"：
// skip 会话被误切后能切回来；skip = 免审全部命令与编辑，勾选信任本机环境再用
const PERM_CYCLE = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
// 005 #166 手机 waitbox 仅浏览口径（s2 定档）——已被 #159（AskUser 应答链路 P0，
// 2026-10-19 用户令）推翻：开关翻开，手机恢复决议。COMMAND_ANSWER/REJECT 全链在
// relay（ws-server/cloud 白名单 + session-manager COMMAND_ANSWER 路由 + 托管
// agent.answer()/外部 bridge.answerPending()），手表端早有发送面（watch.ts），本端
// 解锁即闭环。decide/#212 remember 范围等真决议链路原样保留
const WAITBOX_READONLY = false;
// 审批卡永不过期（1029 用户铁令①，fix/approval-timeout 批）：#159 件③ 的 10min
// 客户端猜测性置灰已删——「CLI 已越过」的真失效由 relay sweepStalePending 发
// WAITING_RESOLVED(superseded) 真实收卡；worker 托管卡 relay 侧本无 TTL，客户端
// 置灰只会把还活着的卡杀成「点不了」（用户云回流 worker 卡 10min 失效实锤）。
// received_at 保留（喂「已等待 Xs」显示），不再参与任何禁点判定
type PermMode = (typeof PERM_CYCLE)[number];
// P81-8W 权限摘要三端统一词表（specs/081 钉死段；与 web-console PERM_MODE_ZH /
// 桌面端同表逐字一致，勿改字面——三端单一词表源，本表取代旧局部 PERM_LABEL 四键表）：
// 双键同表——托管词表（session permission_mode 四值 + forbidden 拒绝决策位）与归一词表
// （SNAPSHOT permission[].modes 的 ask/plan/edit-auto/full-auto）一套人话。四选一面板
// 数据源恒 PERM_CYCLE 四键（forbidden 结构性不可达，端上不产该决策位）；归一键仅外部
// 会话/摘要路径只读展示命中。面板行名（「说明书」）与无障碍朗读用全称；PERM_SHORT
// 两字短标签（#36 状态灯定案）不受影响
const PERM_MODE_ZH: Record<string, string> = {
  default: "每次询问",
  acceptEdits: "自动接受编辑",
  plan: "计划模式",
  bypassPermissions: "完全自动",
  forbidden: "已拒绝",
  ask: "每次询问",
  "edit-auto": "自动接受编辑",
  "full-auto": "完全自动",
};
// 胶囊短标签（#36 设计定案）：胶囊是"状态灯"只显两字短标签，全称与描述句只在
// 四选一面板出现（面板是"说明书"）——「自动」替「自动编辑」为 R2 最坏档省 18px
const PERM_SHORT: Record<PermMode, string> = {
  default: "标准",
  acceptEdits: "自动",
  plan: "规划",
  bypassPermissions: "跳过",
};
const PERM_DESC: Record<PermMode, string> = {
  default: "每个命令与文件编辑都需确认",
  acceptEdits: "文件编辑免审，命令仍需确认",
  plan: "只读规划，先出方案再执行",
  bypassPermissions: "所有命令与编辑免审直接执行",
};

function matchFilter(kind: string, f: ViewKind, tool?: string): boolean {
  if (f !== "msg") return true;
  if (kind === "assistant_text" || kind === "user_message" || kind === "thinking") return true;
  // #41 任务操作（TaskCreate/TaskUpdate/TodoWrite）在消息面板可见：只放行任务类
  // 工具行，其余工具噪声仍留「全部」视图；字号随过程消息档（procVisible 咽喉）
  return kind === "tool_use" && !!tool && /^(TaskCreate|TaskUpdate|TodoWrite)$/.test(tool);
}

// 思考过程显示开关：app 生命周期内记忆（跨页面切换，不落盘）
let thinkShown = false;

// 详情页工具区折叠开关：同样 app 生命周期内记忆
let ctrlCollapsed = false;

// #142 子 Agent 面板折叠开关：app 生命周期内记忆（跨页面/会话切换，1s tick 重渲不丢态）
let agCollapsed = false;

// 输入草稿跨进出保留：按 session_id 暂存（app 生命周期内，发送即清）
const drafts = new Map<string, string>();

// #216 防误派守卫/探针机制（三~六段修 + lastFocusAt/lastLinkAt）随 0.6.1 发版
// 整体摘除（dev 6fef1e3 拆四道围挡 + 7076c9c 探针摘除）：围挡在真机上误伤
// 正常点胶囊，最终定案=无守卫直连（错派根因由 RN/ColorOS 层消化）

// #376 cron 表达式人话（常见模式；未识别返回 null 只显原文+下次时间兜底）
const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];
function cronDesc(s: string): string | null {
  const sch = (s || "").trim();
  if (sch === "@daily" || sch === "@midnight") return "每天 00:00";
  if (sch === "@hourly") return "每小时";
  if (sch === "@weekly") return "每周日";
  const m = /^(\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(sch);
  if (!m) return null;
  const [min, hour, dom, mon, dow] = [m[1], m[2], m[3], m[4], m[5]];
  const p2 = (x: string) => x.padStart(2, "0");
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `每 ${min.slice(2)} 分钟`;
  if (min === "*" && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") return `每 ${hour.slice(2)} 小时`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") return `每天 ${p2(hour)}:${p2(min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) return `每周${WEEK_CN[Number(dow) % 7]} ${p2(hour)}:${p2(min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `每月 ${dom} 日 ${p2(hour)}:${p2(min)}`;
  return null;
}

// 定时任务下次运行时间：MM-dd HH:mm（毫秒时间戳）
const fmtDT = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// #35 输出物辅助（与 web-console artifactsTabHtml 同口径）：扩展名类型派生 / cwd 相对
// 路径 / 体积 / 相对时间——列表行与详情 sheet 共用
const ART_EXT: Record<string, string[]> = {
  code: "ts tsx js jsx mjs cjs py rs go java kt kts swift c h cpp hpp cc cs rb php vue svelte sh zsh bash fish ps1 bat sql css scss less styl html htm xml astro lua dart nim zig ex exs erl hs ml scala tf proto graphql".split(" "),
  doc: "md markdown txt text rst adoc asciidoc pdf doc docx rtf pages key keynote ppt pptx xlsx numbers log".split(" "),
  data: "json jsonl jsonc ndjson csv tsv yaml yml toml ini cfg conf env properties plist db sqlite".split(" "),
  img: "png jpg jpeg gif svg webp bmp ico tiff tif heic avif".split(" "),
  zip: "zip tar gz tgz bz2 xz 7z rar dmg iso jar war apk".split(" "),
};
type ArtKind = "code" | "doc" | "data" | "img" | "zip" | "gen";
function artKindOf(name: string): ArtKind {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  const ext = m ? m[1].toLowerCase() : "";
  for (const k of ["code", "doc", "data", "img", "zip"] as const) if (ART_EXT[k].includes(ext)) return k;
  return "gen";
}
// 行首类型 chip 文案：扩展名本身（无扩展名回落 ·）——比抽象图标更省解释
function artExtOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].slice(0, 4) : "·";
}
// 相对 cwd 展示路径（origin=cwd 才有；分隔符保持 OS 原样）
function artRelOf(s: SessionState, t: ArtifactItem): string {
  if (t.origin !== "cwd" || !s.cwd) return "";
  return t.path.startsWith(s.cwd) ? t.path.slice(s.cwd.length).replace(/^[\\/]+/, "") : "";
}
// #222 文件夹分组取父目录（与 web-console artDirOf 同口径）：cwd 内按相对路径、外按
// 绝对路径；兼容 / 与 \（Windows 源）；根下文件（无父目录）返回空串 = 散文件，永不聚合
function artDirOf(s: SessionState, t: ArtifactItem): string {
  const p = artRelOf(s, t) || t.path;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}
// #72 E 线：fmtArtSize/fmtArtTime 迁 artpool.ts（产物池行与会话账行同语言共用），
// 此处 re-export 既有引用面不变
export { fmtArtSize, fmtArtTime } from "../artpool";
import { fmtArtSize, fmtArtTime } from "../artpool";
// #83 路径显示串断行：/ 与 - 后插零宽空格（U+200B）——Android ICU 断行不会在中文
// 词内给出断点，长中文路径会被从词中间拆开，ZWSP 提供合法断点。仅用于显示；复制走
// 按钮的原串（零宽空格进剪贴板=粘到终端的隐性坏路径），故路径 Text 不再开 selectable
const brkPath = (p: string) => p.replace(/([\\/])/g, "$1\u200B").replace(/-/g, "-\u200B");

// \u2500\u2500\u2500 E3a \u53EA\u8BFB\u6295\u5F71\u7EAF\u51FD\u6570\u6BB5\uFF08\u96F6 RN \u8FD0\u884C\u65F6\u4F9D\u8D56\uFF0Ctest-e3a-detail.ts \u76F4\u8DD1 import\uFF09\u2500\u2500\u2500\u2500
//
// #018-E3a\uFF1Adetail \u8BFB\u4FA7\u4E09\u9762\u6295\u5F71\u2014\u2014\u7B49\u5F85\u6761\u53BB\u91CD / dock \u6D3B\u52A8\u8231\u6A21\u578B / \u4EA7\u7269\u5206\u7EC4\u3002
// \u534F\u8BAE\u7F3A\u53E3\u5907\u6848\uFF1AB0/B4a \u7684 group_key\u3001directory_label\u3001existence_state \u4E09\u5B57\u6BB5\u5C1A\u672A\u8FDB
// protocol.ts \u7684 ArtifactItem\uFF08E1 \u53EA\u843D\u4E86 activity \u9762\uFF09\uFF0C\u6B64\u5904\u4EE5\u672C\u5730\u7ED3\u6784\u6269\u5C55\u9632\u5FA1\u6D88\u8D39
// \u2014\u2014\u5B57\u6BB5\u51FA\u73B0\u5373\u7528\uFF0C\u4E0D\u51FA\u73B0\u8D70 #222/\u65E7 relay \u56DE\u9000\uFF1B\u534F\u8BAE\u843D\u5E93\u540E\u628A B4aArtifact \u4E0A\u79FB\u5373\u53EF\u3002

/** B4a \u4EA7\u7269\u5206\u7EC4\u6269\u5C55\u5B57\u6BB5\uFF08\u534F\u8BAE\u7F3A\u53E3\u672C\u5730\u5907\u6848\uFF0C\u89C1\u4E0A\uFF1Brelay \u843D\u5E93\u540E\u4E0A\u79FB protocol.ts\uFF09 */
type B4aArtifact = ArtifactItem & {
  group_key?: string | null;       // \u4E0D\u900F\u660E\u5206\u7EC4 id\uFF08relay \u6743\u5A01\uFF0C\u975E\u8DEF\u5F84\u6D3E\u751F\uFF09
  directory_label?: string | null; // \u5206\u7EC4\u5C55\u793A\u540D
  existence_state?: "exists" | "missing" | "unknown" | null;
};

export type ArtExistence = "exists" | "missing" | "unknown";
export interface GroupedArtifact { item: ArtifactItem; existence: ArtExistence; openable: boolean }
export interface ArtifactGroup { key: string; label: string; leaf: string; files: GroupedArtifact[]; at: number; size: number }
export type ArtifactRow =
  | { kind: "group"; group: ArtifactGroup; at: number }
  | { kind: "file"; art: GroupedArtifact; at: number };

/** existence \u4E09\u6001\u5F52\u4E00\uFF1AB4a \u663E\u5F0F\u5B57\u6BB5\u4F18\u5148\uFF1B\u65E7 relay \u65E0\u5B57\u6BB5\u56DE\u9000 exists \u5E03\u5C14
 * \uFF08false\u2192missing \u53EF\u5F00 sheet \u770B\u300C\u5DF2\u5220\u9664\u300D\u5B9A\u683C CTA\uFF1B\u7F3A\u7701\u2192exists\uFF09\u3002unknown \u53EA\u6765\u81EA
 * B4a \u663E\u5F0F\u4E0B\u53D1\u2014\u2014\u4E0D\u731C\u3001\u4E0D\u7ED9\u65E7\u6570\u636E\u9020\u672A\u77E5\u6001\uFF08\u65E7\u884C\u4FDD\u6301\u53EF\u6253\u5F00\uFF0C\u96F6\u56DE\u5F52\uFF09 */
export function artExistenceOf(t: ArtifactItem): ArtExistence {
  const st = (t as B4aArtifact).existence_state;
  if (st === "exists" || st === "missing" || st === "unknown") return st;
  return t.exists === false ? "missing" : "exists";
}

const artRecOf = (t: ArtifactItem): number => t.last_at || t.first_at || 0;

/**
 * \u4EA7\u7269\u5206\u7EC4\u6295\u5F71\uFF08arts tab \u6570\u636E\u9762\uFF09\uFF1A
 * - B4a group_key \u5B58\u5728 \u2192 \u6309\u4E0D\u900F\u660E id \u5206\u6876\uFF0Clabel = directory_label ?? key\uFF08relay
 *   \u6743\u5A01\u5206\u7EC4\uFF0C\u5355\u6587\u4EF6\u7EC4\u4E5F\u7167\u7EC4\u6E32\u67D3\uFF09\uFF1Bleaf \u53D6\u5C55\u793A\u540D\u672B\u6BB5\uFF08\u8DEF\u5F84\u5F62\uFF09\u6216\u539F\u6837
 * - \u65E0 group_key \u2192 #222 \u65E7\u53E3\u5F84\u56DE\u9000\uFF1AdirOf \u6D3E\u751F\u7236\u76EE\u5F55\uFF0C\u540C\u76EE\u5F55\uFF08lowercase \u5F52\u4E00\uFF09\u22652
 *   \u4E2A\u6587\u4EF6\u624D\u805A\u5408\uFF0C\u5355\u6587\u4EF6\u76EE\u5F55\u4E0E\u6839\u6563\u4EF6\u4FDD\u6301\u6563\u884C
 * - \u7EC4\u5185\u6309\u6700\u8FD1\u6D3B\u8DC3\u964D\u5E8F\uFF1B\u7EC4 at=\u7EC4\u5185\u6700\u65B0\u3001size=\u6210\u5458\u5408\u8BA1\uFF1B\u7EC4\u4E0E\u6563\u6587\u4EF6\u6309 at \u964D\u5E8F\u6DF7\u6392
 *   \uFF08\u4E0E #222 \u6DF7\u6392\u540C\u5219\uFF0C\u300C\u6700\u65B0\u4EA4\u4ED8\u6C38\u8FDC\u5728\u9876\u300D\uFF09
 */
export function artifactRowsOf(items: ArtifactItem[], dirOf: (t: ArtifactItem) => string): ArtifactRow[] {
  const arts = items.map((item) => ({ item, existence: artExistenceOf(item) }));
  // \u65E7\u53E3\u5F84\u76EE\u5F55\u8BA1\u6570\uFF08lowercase \u5F52\u4E00\uFF0C\u4E0E web-console artDirOf \u540C\u5224\uFF09
  const dirN = new Map<string, number>();
  for (const { item } of arts) {
    const dir = (dirOf(item) || "").toLowerCase();
    if (dir) dirN.set(dir, (dirN.get(dir) ?? 0) + 1);
  }
  const groups = new Map<string, ArtifactGroup>();
  const loose: GroupedArtifact[] = [];
  const of = (item: ArtifactItem, existence: ArtExistence): GroupedArtifact =>
    ({ item, existence, openable: existence !== "unknown" });
  for (const { item, existence } of arts) {
    const gk = (item as B4aArtifact).group_key;
    if (typeof gk === "string" && gk) {
      let g = groups.get(gk);
      if (!g) {
        const label = (item as B4aArtifact).directory_label || gk;
        g = { key: gk, label, leaf: label.split(/[\\/]/).pop() || label, files: [], at: 0, size: 0 };
        groups.set(gk, g);
      }
      g.files.push(of(item, existence));
    } else {
      const dir = dirOf(item) || "";
      if (dir && (dirN.get(dir.toLowerCase()) ?? 0) >= 2) {
        const key = dir.toLowerCase();
        let g = groups.get(key);
        if (!g) {
          g = { key, label: dir, leaf: dir.split(/[\\/]/).pop() || dir, files: [], at: 0, size: 0 };
          groups.set(key, g);
        }
        g.files.push(of(item, existence));
      } else {
        loose.push(of(item, existence));
      }
    }
  }
  for (const g of groups.values()) {
    g.files.sort((a, b) => artRecOf(b.item) - artRecOf(a.item));
    for (const f of g.files) {
      const at = artRecOf(f.item);
      if (at > g.at) g.at = at;
      if (typeof f.item.size === "number") g.size += f.item.size;
    }
  }
  loose.sort((a, b) => artRecOf(b.item) - artRecOf(a.item));
  return [
    ...[...groups.values()].map((group) => ({ kind: "group" as const, group, at: group.at })),
    ...loose.map((art) => ({ kind: "file" as const, art, at: artRecOf(art.item) })),
  ].sort((a, b) => b.at - a.at);
}

/** \u7B49\u5F85\u6761\u53BB\u91CD\uFF1A\u540C request \u53EA\u6E32\u67D3\u4E00\u6761\uFF0C\u952E = waiting_request.request_id\uFF08\u4EFB\u52A1\u4E66\u6240\u79F0
 * waiting_request.id \u7684\u534F\u8BAE\u5B9E\u540D\uFF1B\u7F3A id \u624D\u56DE\u9000 received_at|tool \u6D3E\u751F\u952E\uFF09\u3002\u9996\u89C1\u4F18\u5148\u3001
 * \u8F93\u5165\u6B21\u5E8F\u5373\u6743\u5A01\u5E8F\u2014\u2014\u5FEB\u7167\u6062\u590D/\u4E8B\u4EF6\u91CD\u6295/R1 \u591A\u8BF7\u6C42\u5217\u8868\u5171\u7528\u6B64\u5F52\u4E00 */
export function dedupeWaitingBars(payloads: (WaitingPayload | null | undefined)[]): WaitingPayload[] {
  const seen = new Set<string>();
  const out: WaitingPayload[] = [];
  for (const p of payloads) {
    if (!p) continue;
    const key = p.request_id || `${p.received_at ?? ""}|${p.tool_name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** done/error \u6536\u53E3\u6761\uFF1AERROR \u26A0 \u5E38\u9A7B\uFF08\u5BF9\u9F50\u65E2\u6709\u72B6\u6001\u6761\u8BED\u4E49\uFF09\uFF1BDONE \u2713 \u53EA\u5728\u56DE\u5408\u6536\u5C3E
 * \u5C3E\u7A97\u5185\u663E\u793A\uFF08activity.state=DONE \u843D\u5B9A\u540E DONE_TAIL_MS \u5185\uFF09\u2014\u2014DONE \u662F\u4F1A\u8BDD\u9759\u606F\u6001\uFF0C
 * \u5E38\u9A7B\u6536\u53E3\u6761\u4F1A\u7ED9\u6BCF\u4E2A\u5386\u53F2\u4F1A\u8BDD\u90FD\u7CCA\u4E00\u6761\uFF1B\u5C3E\u7A97\u5373\u300C\u672C\u8F6E\u521A\u6536\u53E3\u300D\u8BED\u4E49\uFF0C\u8FC7\u7A97\u81EA\u9690 */
export const DONE_TAIL_MS = 8000;
export type ClosingBar = { kind: "done" | "error"; text: string };
export function closingBarOf(s: SessionState | null | undefined, now: number): ClosingBar | null {
  if (!s) return null;
  if (s.status === "ERROR") return { kind: "error", text: s.last_error || "\u51FA\u9519\u4E86" };
  if (s.status === "DONE" && s.activity?.state === "DONE" && typeof s.activity.updated_at === "number") {
    const age = now - s.activity.updated_at;
    if (age >= 0 && age <= DONE_TAIL_MS) return { kind: "done", text: "\u672C\u8F6E\u5DF2\u5B8C\u6210" };
  }
  return null;
}

// \u56DB\u6001\u56FE\u6807\uFF1A\u4E0E\u8272\u53CC\u901A\u9053\u533A\u5206\uFF08\u2736\u25C9\u2713\u26A0 + working/waiting/done/error \u56DB\u4E3B\u9898\u8272\uFF09\uFF0C\u4E0D\u5F15\u65B0\u4F9D\u8D56
const DOCK_ICONS: Record<string, string> = { WORKING: "\u2736", WAITING: "\u25C9", DONE: "\u2713", ERROR: "\u26A0" };

export interface DockModel {
  state: SessionStatus;
  icon: string;
  summary?: string;   // \u4EFB\u52A1\u6458\u8981\uFF08task_summary.text\uFF09
  actKind?: string;   // \u5F53\u524D\u6D3B\u52A8 kind
  actText?: string;
  actTool?: string;
  elapsedMs?: number;
}

/**
 * \u5934\u90E8\u6D3B\u52A8\u8231\u6295\u5F71\uFF08B0 StatusDockState \u53EA\u8BFB\u6D88\u8D39\uFF09\uFF1A
 * - activity \u7F3A\u5931 \u2192 null\uFF08\u6574\u8231\u4E0D\u6E32\u67D3\uFF0C\u65E0\u5047\u300C\u7A7A\u95F2\u300D\uFF09
 * - native_status \u80FD\u529B\u5173 \u2192 null\uFF08\u6838\u5FC3\u80FD\u529B\u4E0D\u5728\u6574\u8231\u4E0D\u6E32\u67D3\uFF1Blegacy \u5F52\u4E00\u5316\u80FD\u529B\u5168\u5173\u540C\u6B64\uFF09
 * - \u4EFB\u52A1\u6458\u8981/\u5F53\u524D\u6D3B\u52A8\u6309 operation_summary\u3001\u8017\u65F6\u6309 native_elapsed \u5404\u81EA\u95E8\u63A7\uFF0C\u5B57\u6BB5
 *   \u7F3A\u7701\u4E0D\u51FA\u884C\uFF08\u4E0D\u51FA\u5047 0 / \u5047\u7A7A\u4E32\uFF09
 * - approval \u4E0D\u5165\u8231\uFF1A\u5BA1\u6279\u7531\u6A2A\u5E45/\u72B6\u6001\u6761\u627F\u8F7D\uFF0C\u8231\u5185\u4E0D\u51FA\u7B2C\u56DB\u884C\u5047\u5360\u4F4D
 */
export function dockModelOf(s: SessionState | null | undefined): DockModel | null {
  const act = s?.activity;
  if (!act || !s) return null;
  if (!hasActivityCapability(s, "native_status")) return null;
  if (act.state !== "WORKING" && act.state !== "WAITING" && act.state !== "DONE" && act.state !== "ERROR") return null;
  const m: DockModel = { state: act.state, icon: DOCK_ICONS[act.state] ?? "\u00B7" };
  if (hasActivityCapability(s, "operation_summary")) {
    const ts = act.task_summary;
    const text = typeof ts?.text === "string" ? ts.text.trim() : "";
    if (text) m.summary = text;
    const a = act.activity;
    if (a && typeof a.text === "string" && a.text.trim()) {
      m.actText = a.text.trim();
      if (typeof a.kind === "string" && a.kind) m.actKind = a.kind;
      if (typeof a.tool === "string" && a.tool) m.actTool = a.tool;
    }
  }
  if (hasActivityCapability(s, "native_elapsed") && typeof act.elapsed_ms === "number") m.elapsedMs = act.elapsed_ms;
  return m;
}

/** E3b 决议定向守卫（纯）：晚到 ACK 失败是否仍应提示——仅当同一 request 仍挂起
 * （已翻态/换请求=帧已收敛，不误报「决议未生效」）。决议 payload 本就带 request_id
 * （relay 按 id 执行），此守卫管的是**回执侧**的定向 */
export function decisionStillPending(wr: WaitingPayload | null | undefined, requestId: string): boolean {
  return !!wr && wr.request_id === requestId;
}
// \u2500\u2500\u2500 E3a \u7EAF\u51FD\u6570\u6BB5\u6B62 \u2500\u2500\u2500

// 转录行：user=右气泡 / assistant=正文流式 / tool=紧凑卡片 / system=居中弱化
// 转录字号分级：过程消息（工具/结果/系统/思考）比消息（用户/assistant）小一档，可在设置抽屉调。
// 紧凑档双维度拉开差距：字号小 3px + 整体降不透明度（procOp），保证档位切换一眼可辨

// ---------- FB14 气泡附图：引用 → 缩略（按需拉取 + 内存缓存） ----------
// 引用拉取复用输出物 CHUNK 管线（COMMAND_ARTIFACT_FETCH 的 img 引用分支，relay 校验
// 引用形态+归属）：SNAPSHOT 里只有 basename 引用（体积恒小），首渲排队拉取，就位后
// 换图。拉取失败（含 relay tmp 7 天清扫过期）缓存 failed 态不再重试——占位收敛隐藏，
// 气泡正文仍在；未连接/超时属瞬态不缓存（重连后 connState 触发 effect 自然补，同
// 005 壳「离线不排拉取，重连全量重渲自然补」语义）。发送侧统一 JPEG 长边≤1568
// （≤4 张），内存 data URI 量级可控；缓存不设上界与 005 壳同口径（LRU 备案后续统一）



// 件五：乐观回显 pending 气泡（用户消息气泡同族视觉——右对齐圆角，降透明度区分
// 正式态；状态脚注三态：发送中/已排队/失败·点按重试）。挂转录尾部，回声对账后消失
function PendingEchoBubble({ p, onRetry }: { p: PendingEcho; onRetry: (p: PendingEcho) => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const failed = p.state === "failed";
  const body = (
    <View style={[d.peBubble, failed && d.peBubbleFail]}>
      <Text style={d.peText} numberOfLines={6}>{p.text}</Text>
      <Text style={[d.peState, { color: failed ? c.error : c.faint }]}>
        {p.state === "sending" ? "发送中…" : p.state === "queued" ? "已排队 · 确认/回合结束后自动发送" : "发送失败 · 点按重试"}
      </Text>
    </View>
  );
  if (!failed) return body;
  return (
    <Pressable onPress={() => onRetry(p)} accessibilityLabel={`重发失败消息：${p.text.slice(0, 30)}`}>
      {body}
    </Pressable>
  );
}


// diff 着色块：+/−/@@ 逐行着色（等宽），行数据由 relay 从 structuredPatch 提取

// #264：摘要文本里的 #NNN 任务号渲染成可点高亮段（1~3 位数字，避免误吞时间戳/长号），
// 点击跳任务 tab 并定位该条。找不到对应任务时仍切到任务 tab（无害回退）
// #340 触点即气泡锚点（#NNN 数字处）：短点/长按事件都带 changedTouches


// 内容长按菜单（#249/#260）：复制全文 / 系统分享，仅挂 detail/diff 摘要行——
// 正文（用户/assistant/思考）长按即原生选择手柄可拖选片段，不走此菜单
// #216 同构修：受控 visible 常驻渲染（text 空态=关，见 PermPanel 头注释，勿改回条件挂卸）
function ContentMenu({ text, onClose }: { text: string | null; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const open = !!text;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={open ? onClose : undefined}>
      {open ? (
      <Pressable style={d.menuScrim} onPress={onClose}>
        <Pressable style={d.menuCard} onPress={() => undefined}>
          <View style={d.menuBtns}>
            <Pressable
              style={d.menuBtn}
              android_ripple={{ color: withA(c.dim, 0.2), borderless: false, radius: 10 }}
              onPress={() => {
                void Clipboard.setStringAsync(text).then(() => {
                  setCopied(true);
                  copiedTimer.current = setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={d.menuBtnT}>{copied ? "已复制 ✓" : "复制全文"}</Text>
            </Pressable>
            <Pressable
              style={[d.menuBtn, d.menuBtnPri]}
              android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
              onPress={() => {
                onClose();
                // 防 Android binder 事务上限：超长 detail 截断分享
                void Share.share({ message: text.slice(0, 100_000) }).catch(() => undefined);
              }}
            >
              <Text style={d.menuBtnPriT}>分享</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      ) : null}
    </Modal>
  );
}

// #79 拉取产物落手机持久存储（documentDirectory/art-view/，重名覆盖；返回 file:// uri）。
// 2026-09-20 起从 cacheDirectory 迁来：Android 的 cache/ 系统低存储可整目录清空，
// files/ 只随卸载删除——「杀 App 重启又要重拉」的持久化前提
const ART_VIEW_DIR = `${FileSystem.documentDirectory ?? ""}art-view/`;
const ART_IDX_URI = `${FileSystem.documentDirectory ?? ""}art-view-index.json`;
async function writeArtUri(uri: string, u8: Uint8Array): Promise<void> {
  try { await FileSystem.makeDirectoryAsync(ART_VIEW_DIR, { intermediates: true }); } catch {}
  await FileSystem.writeAsStringAsync(uri, toB64(u8), { encoding: FileSystem.EncodingType.Base64 });
}
// 持久缓存文件名：键短哈希前缀 + 原名——不同会话/路径的同名文件（README.md 常见）
// 互相覆盖会张冠李戴；键含 last_at，电脑上文件更新自然落新名，旧文件由 LRU 淘汰清理
function artShortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const artCacheFile = (key: string, name: string) => `${artShortHash(key)}-${name.replace(/[\\/:*?"<>|]/g, "_").slice(-72) || "artifact"}`;
const artCacheUri = (key: string, name: string) => ART_VIEW_DIR + artCacheFile(key, name);
// #79 文本类（txt/md/html）分享/浏览器打开前落盘：expo-sharing 与 ACTION_VIEW 都
// 需要文件 uri，正文在内存里得先写进缓存目录（与二进制同目录，重名覆盖同语义）
async function saveArtText(name: string, text: string): Promise<string> {
  try { await FileSystem.makeDirectoryAsync(ART_VIEW_DIR, { intermediates: true }); } catch {}
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "artifact.txt";
  const uri = ART_VIEW_DIR + safe;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  return uri;
}
// content:// + 系统应用打开（flags:1 = FLAG_GRANT_READ_URI_PERMISSION，同 updates.ts 安装器）
async function openArtExternally(uri: string, mime: string): Promise<string | null> {
  try {
    const curi = await FileSystem.getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", { data: curi, type: mime, flags: 1 });
    return null;
  } catch {
    return "手机上没有能打开此格式的应用，文件已保存在应用缓存里";
  }
}
// #79 拉取结果分级：img=内嵌图片；html=WebView 渲染（报告类主格式，看源码没意义）；
// txt/md=内嵌文本（md 走 MdText）；sys=复杂格式（pdf/office/zip…）落盘后交系统应用打开
// #72 E 线：类型与分级路由（decodeUtf8/artDataOf）迁 artpool.ts 纯函数模块——会话账
// 拉取（本文件 fetchArtView）与产物池 HTTP 直取（ArtPoolModal）共用同一把分级尺，
// 防双口径漂移；此处 re-export 既有引用面不变
export { decodeUtf8, artDataOf, type ArtViewData } from "../artpool";
import { artDataOf } from "../artpool";
import type { ArtViewData } from "../artpool";

// #79 拉取缓存（晨间反馈：同一份输出物不应每次查看都重拉）：键 = sid|path|last_at，
// 电脑上文件更新（last_at 变化）键即失效、自动重拉最新——「在线预览的新鲜」与
// 「本地缓存的速度」两头都占。双层结构：
// ① artCache 内存表（本次运行秒开）；② artDisk 磁盘索引（documentDirectory/
//    art-view-index.json，2026-09-20 用户反馈「杀 App 重启又要重拉」加的持久层）——
//    文件以键哈希前缀名全部落盘（img/sys 二进制、html/md/txt 正文），索引记
//    cacheKey→{文件名, 显示名, kind, mime, size}；启动时读索引重建，命中即从盘
//    读回零网络。两层同序 LRU（容量 12）：淘汰时删内存 + 删盘文件 + 改写索引
const ART_CACHE_CAP = 12;
const artCache = new Map<string, ArtViewData>();
interface ArtDiskEntry { file: string; name: string; kind: ArtViewData["kind"]; mime?: string; size: number }
const artDisk = new Map<string, ArtDiskEntry>();
let artIdxTimer: ReturnType<typeof setTimeout> | null = null;
// 索引写回：防抖 1.5s 合并连续 put；失败静默（持久层坏了不影响内存层工作）
function artIdxFlush() {
  if (artIdxTimer) return;
  artIdxTimer = setTimeout(() => {
    artIdxTimer = null;
    void FileSystem.writeAsStringAsync(ART_IDX_URI, JSON.stringify([...artDisk.entries()]), {
      encoding: FileSystem.EncodingType.UTF8,
    }).catch(() => undefined);
  }, 1500);
}
// 启动恢复：读索引重建磁盘层（损坏即弃）；fire-and-forget 不挡首屏
void FileSystem.readAsStringAsync(ART_IDX_URI, { encoding: FileSystem.EncodingType.UTF8 })
  .then((raw) => {
    const arr = JSON.parse(raw) as [string, ArtDiskEntry][];
    if (!Array.isArray(arr)) return;
    for (const [k, e] of arr) {
      if (typeof k === "string" && e && typeof e.file === "string" && e.name && e.kind) artDisk.set(k, e);
    }
  })
  .catch(() => undefined);
function artDiskEvict() {
  while (artDisk.size > ART_CACHE_CAP) {
    const oldest = artDisk.keys().next().value;
    if (oldest === undefined) break;
    const e = artDisk.get(oldest);
    artDisk.delete(oldest);
    if (e) void FileSystem.deleteAsync(ART_VIEW_DIR + e.file, { idempotent: true }).catch(() => undefined);
  }
  artIdxFlush();
}
// 磁盘层读取：文本类读回正文，img/sys 直接引用盘 uri；文件缺失返回 null（走重拉）
async function artDiskLoad(k: string): Promise<ArtViewData | null> {
  const e = artDisk.get(k);
  if (!e) return null;
  const uri = ART_VIEW_DIR + e.file;
  try {
    if (e.kind === "img") return { kind: "img", name: e.name, uri, size: e.size };
    if (e.kind === "sys") return { kind: "sys", name: e.name, uri, mime: e.mime || "application/octet-stream", size: e.size };
    const text = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
    if (e.kind === "html") return { kind: "html", name: e.name, text, size: e.size };
    if (e.kind === "md") return { kind: "md", name: e.name, text, size: e.size };
    return { kind: "txt", name: e.name, text, size: e.size };
  } catch {
    return null; // 盘文件被外部清掉：弃条目，走重拉
  }
}
function artCacheGet(k: string): ArtViewData | undefined {
  const v = artCache.get(k);
  if (v) { artCache.delete(k); artCache.set(k, v); }
  return v;
}
// 查看与分享共用的异步取用：内存秒回；磁盘层命中读盘回填（含 LRU 触达），读不回
// 清索引防空转。doFetch/doShare 均走这里（持久层对调用方透明）
async function artCacheGetAsync(k: string): Promise<ArtViewData | null> {
  const mem = artCacheGet(k);
  if (mem) return mem;
  if (!artDisk.has(k)) return null;
  const e = artDisk.get(k)!;
  artDisk.delete(k);
  artDisk.set(k, e); // LRU 触达
  const fromDisk = await artDiskLoad(k);
  if (fromDisk) {
    artCachePut(k, fromDisk);
    return fromDisk;
  }
  artDisk.delete(k);
  artIdxFlush();
  return null;
}
function artCachePut(k: string, v: ArtViewData): void {
  artCache.delete(k);
  artCache.set(k, v);
  artDisk.delete(k);
  artDisk.set(k, { file: artCacheFile(k, v.name), name: v.name, kind: v.kind, ...(v.kind === "sys" ? { mime: v.mime } : {}), size: v.size });
  artDiskEvict();
  while (artCache.size > ART_CACHE_CAP) {
    const oldest = artCache.keys().next().value;
    if (oldest === undefined) break;
    artCache.delete(oldest);
  }
}

// #79 分享文件本体（ArtView 头部与 ArtSheet 共用）：文本类以干净名现落盘；img/sys
// 的缓存文件带键哈希前缀（防同名碰撞），分享前复制一份干净名——收到的文件名不带
// 前缀。mime 按分级映射——晨间反馈二轮：分享=文件本身不是路径
// #72 E 线：export 供 ArtPoolModal 产物池行分享复用（禁重写既有分享链）
export async function shareArtView(v: ArtViewData): Promise<void> {
  const mime =
    v.kind === "sys" ? v.mime
    : v.kind === "img" ? "image/*"
    : v.kind === "html" ? "text/html"
    : v.kind === "md" ? "text/markdown"
    : "text/plain";
  let uri: string;
  if (v.kind === "img" || v.kind === "sys") {
    uri = v.uri;
    if (uri.startsWith(ART_VIEW_DIR)) {
      // 分享副本落 cache 临时目录（干净名、系统自清不堆积持久层）
      const safe = v.name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "artifact";
      const dst = `${FileSystem.cacheDirectory ?? ""}share-${safe}`;
      try {
        await FileSystem.copyAsync({ from: uri, to: dst });
        uri = dst;
      } catch { /* 复制失败用原 uri 兜底（仅文件名带前缀，内容正确） */ }
    }
  } else {
    uri = await saveArtText(v.name, v.text);
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error("此设备不支持系统分享");
  await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: `分享 ${v.name}` });
}

// #79 输出物预览全屏层：图片/HTML/文本内嵌，复杂格式自动呼系统应用（头部按钮可重开）。
// 晨间反馈补齐：头部「分享」= 文件本体进系统分享面板（存云盘/发微信/存本地一板全收，
// 就是「下载到本地随用户处理」的系统出口）；HTML 另给「浏览器」按钮交系统浏览器渲染
// #216 同构修：受控 visible 常驻渲染（v 空态=关，见 PermPanel 头注释，勿改回条件挂卸）
// #72 E 线：export 供 ArtPoolModal 产物池预览复用（禁重写既有预览链）
export function ArtView({ v, onClose }: { v: ArtViewData | null; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  useEffect(() => {
    setOpenErr(null);
    setActErr(null);
    if (v?.kind === "sys") void openArtExternally(v.uri, v.mime).then(setOpenErr);
  }, [v]);
  // 分享文件本体（逻辑在模块级 shareArtView，与 ArtSheet 共用）
  const shareFile = async () => {
    if (!v) return;
    try {
      await shareArtView(v);
      setActErr(null);
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e));
    }
  };
  // HTML 交系统浏览器（App 内 WebView 渲不了的场景兜底，如外链资源/打印）
  const openInBrowser = async () => {
    if (!v || v.kind !== "html") return;
    try {
      setActErr(await openArtExternally(await saveArtText(v.name, v.text), "text/html"));
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e));
    }
  };
  const open = !!v;
  return (
    <Modal visible={open} animationType="fade" onRequestClose={open ? onClose : undefined}>
      {open && v ? (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={d.avHead}>
          <Text style={d.avName} numberOfLines={1}>{v.name}</Text>
          <Text style={d.avSize}>{fmtArtSize(v.size)}</Text>
          {v.kind === "html" ? (
            <Pressable hitSlop={6} onPress={() => { void openInBrowser(); }} accessibilityLabel="用浏览器打开">
              <Text style={d.avAct}>浏览器</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={6} onPress={() => { void shareFile(); }} accessibilityLabel="分享文件">
            <Text style={d.avAct}>分享</Text>
          </Pressable>
          <Pressable hitSlop={8} onPress={onClose} accessibilityLabel="关闭预览">
            <Text style={d.avClose}>✕</Text>
          </Pressable>
        </View>
        {openErr || actErr ? (
          <Text style={d.avErr} numberOfLines={2}>{actErr ?? openErr}</Text>
        ) : null}
        {v.kind === "img" ? (
          <Image source={{ uri: v.uri }} style={{ flex: 1, backgroundColor: c.panel2 }} resizeMode="contain" />
        ) : v.kind === "html" ? (
          // 晨间反馈：HTML 报告此前当纯文本显示源码——夜间报告等交付物都是 HTML，
          // 必须渲染。正文已在内存，source html 免文件权限；透明底让报告自带底色透出。
          // #29（C-P2-3）：交付物内容=外部会话/LLM 产出，属不可信源——渲染关 JS
          //（报告不需要脚本；web 端同功能已用无 allow-scripts 的 sandbox iframe 并注
          // 释「交付物不该带脚本」，此处对齐）、禁新窗口/文件访问，外链跳转交给系统
          // 浏览器（onShouldStartLoadWithRequest 只放行首帧 about:blank 载入，其余
          // http(s) 一律转出 App，防全屏 Modal 内任意导航钓鱼）
          <WebView
            source={{ html: v.text }}
            originWhitelist={["*"]}
            javaScriptEnabled={false}
            allowFileAccess={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(req) => {
              // 首帧（about:/data: 源内载入）放行；其余导航一律拦下，http(s) 转系统
              // 浏览器，非 http(s)（intent:/file:/自定义 scheme）直接丢弃
              if (/^(about|data):/i.test(req.url)) return true;
              if (/^https?:/i.test(req.url)) void Linking.openURL(req.url).catch(() => undefined);
              return false;
            }}
            style={{ flex: 1, backgroundColor: "transparent" }}
          />
        ) : v.kind === "md" ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
            <MdText src={v.text} selectable />
          </ScrollView>
        ) : v.kind === "txt" ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
            <Text style={d.avTxt} selectable>{v.text}</Text>
          </ScrollView>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <View style={d.avCard}>
              <Text style={{ color: c.done, fontSize: 30 }}>✓</Text>
              <Text style={{ color: c.text, fontSize: 14, fontWeight: "600", textAlign: "center" }}>
                已保存到手机（{fmtArtSize(v.size)}）
              </Text>
              <Pressable
                style={[d.menuBtn, d.menuBtnPri, { alignSelf: "stretch", marginTop: 4 }]}
                android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
                onPress={() => { void openArtExternally(v.uri, v.mime).then(setOpenErr); }}
              >
                <Text style={d.menuBtnPriT}>用其他应用打开</Text>
              </Pressable>
            </View>
            <Text style={d.avHint}>
              {openErr ?? "已尝试调起系统应用；若未弹出，请点上方按钮选择打开方式"}
            </Text>
          </View>
        )}
      </SafeAreaView>
      ) : null}
    </Modal>
  );
}

// #35 输出物详情 sheet（#79 起支持实时拉取；#83 重设计）：身份→动作→参考三段式
// ——标题行（类型 chip + 文件名 14px）→ CTA + caption → 路径盒 + 次级按钮；元信息
// 收编标题下中性一行（原徽章行 + 5 行键值表合并）。面板形态复用 #36 permSheet
// #216 同构修：受控 visible 常驻渲染（art 空态=关，见 PermPanel 头注释，勿改回条件挂卸）
function ArtSheet({ art, rel, sid, onClose }: { art: ArtifactItem | null; rel: string; sid: string; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const [busy, setBusy] = useState(false);
  const [ferr, setFerr] = useState<string | null>(null);
  const [view, setView] = useState<ArtViewData | null>(null);
  const open = !!art;
  // 常驻后关闭时复位内嵌预览/错误/忙碌态（防下次打开残留）
  useEffect(() => { if (!open) { setView(null); setFerr(null); setBusy(false); } }, [open]);
  const name = (rel || art?.path || "").split(/[\\/]/).pop() || art?.path || "";
  const dead = art?.exists === false;
  const outside = art?.origin === "outside" || (!!art && !rel && art.origin !== "cwd");
  const kind = artKindOf(name);
  const KC: Record<ArtKind, string> = { code: c.brandA, doc: c.done, data: c.working, img: c.waiting, zip: c.dim, gen: c.faint };
  // #79 拉取 + 分级路由：图片/HTML/文本直接内嵌预览，复杂格式落缓存后交系统应用。
  // 缓存命中（path+last_at 未变）秒开不重拉——文件在电脑上更新则键失效自动拉最新
  const cacheKey = art ? `${sid}|${art.path}|${art.last_at ?? art.first_at ?? 0}` : "";
  // 已缓存时主按钮变「查看」——用户不再疑惑"为什么又要拉取"（has 无 LRU 副作用；
  // 磁盘层同判：重启后盘缓存仍在，按钮照常显示已缓存）
  const cached = !!art && !dead && (artCache.has(cacheKey) || artDisk.has(cacheKey));
  // 拉取构建（查看与分享共用）：E2E 分块拉取 → 全量落盘（持久缓存，前缀名）→
  // mime 分级 → 入缓存。文本类盘文件=正文 utf8 bytes（读回按 UTF8 解码一致）
  const fetchArtView = async (): Promise<ArtViewData> => {
    if (!art) throw new Error("artifact unavailable");
    const r = await store.fetchArtifact(sid, art.path);
    const chunks = r.b64s.map(fromB64);
    let n = 0;
    for (const cc of chunks) n += cc.length;
    const u8 = new Uint8Array(n);
    let o = 0;
    for (const cc of chunks) { u8.set(cc, o); o += cc.length; }
    const mime = r.mime || "application/octet-stream";
    const uri = artCacheUri(cacheKey, name);
    await writeArtUri(uri, u8);
    // #72 E 线：分级路由统一走 artpool.artDataOf（与产物池 HTTP 直取单口径，防双尺漂移）
    const data = artDataOf(u8, mime, name, uri);
    artCachePut(cacheKey, data);
    return data;
  };
  const doFetch = async () => {
    // E3b 三态守卫：unknown（B4a 显式状态未知）不给拉取——行层已不开 sheet，此为
    // 双保险；失败回退由 ferr 可见错误承载（行/列表不清不动，三态定格）
    if (busy || dead || !art || artExistenceOf(art) === "unknown") return;
    setBusy(true);
    setFerr(null);
    try {
      const hit = await artCacheGetAsync(cacheKey);
      if (hit) { setView(hit); return; }
      setView(await fetchArtView());
    } catch (e) {
      setFerr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // 晨间反馈二轮：分享=文件本体（原「分享路径」是理解偏了）——未拉取先走同一
  // 拉取链（缓存命中秒出、顺带点亮主按钮「已缓存」），落盘后进系统分享面板
  const doShare = async () => {
    if (busy || dead || !art || artExistenceOf(art) === "unknown") return; // E3b 三态守卫同 doFetch
    setBusy(true);
    setFerr(null);
    try {
      await shareArtView((await artCacheGetAsync(cacheKey)) ?? (await fetchArtView()));
    } catch (e) {
      setFerr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={open ? onClose : undefined}>
      <ArtView v={view} onClose={() => setView(null)} />
      {art ? (
      <Pressable style={d.permScrim} onPress={onClose}>
        {/* #83：底部让位手势条（原 paddingBottom 14 在手势导航机型上贴边） */}
        <Pressable style={[d.permSheet, { paddingBottom: 14 + insets.bottom }]} onPress={() => undefined}>
          <View style={d.permGrab} />
          {/* 一眼：类型色 chip + 文件名（14px 全场最大，修标题↔主按钮字号倒挂）。
              已删除是唯一改变可用性的状态，红标签保留在头部（其余徽章降为中性文字） */}
          <View style={d.artTitleRow}>
            <View style={[d.artChip, { borderColor: withA(KC[kind], 0.45) }]}>
              <Text style={[d.artChipT, { color: KC[kind] }]}>{artExtOf(name)}</Text>
            </View>
            <Text style={d.artTitle} numberOfLines={2}>{name}</Text>
            {dead ? <Text style={[d.artTag, { color: c.error }]}>已删除</Text> : null}
          </View>
          {/* 元信息一行（原徽章行 + 5 行键值表收编为中性注脚）：零信息项不渲染、
              首次=最近只显一个；2026-09-21 行变更 +N −N 随 tab 页统计一并移除（交付物口径） */}
          <Text style={d.artMeta} numberOfLines={3}>
            {[
              art.op === "create" ? "新建" : "修改",
              outside ? "cwd 外" : "",
              fmtArtSize(art.size),
              fmtArtTime(art.last_at || art.first_at),
              art.tools?.length ? `工具 ${art.tools.join(" · ")}` : "",
              art.first_at && art.first_at !== art.last_at ? `首次 ${fmtArtTime(art.first_at)}` : "",
            ].filter(Boolean).join(" · ")}
          </Text>
          {/* 二眼：整宽 CTA（四态文案保留）；已删除=ghost 状态说明（红字短句），不再假 CTA */}
          <Pressable
            style={[d.artPri, dead && d.artPriDead]}
            disabled={busy || dead}
            android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
            onPress={() => { void doFetch(); }}
          >
            <Text style={[d.artPriT, dead && d.artPriDeadT]}>{busy ? "拉取中…" : dead ? "文件已删除" : cached ? "查看（已缓存）" : "拉取到手机查看"}</Text>
          </Pressable>
          {/* 脚注升为 CTA caption：它解释的是拉取动作（原沉底贴手势条处可读性最差） */}
          <Text style={d.artCap}>文件在电脑上 · 实时拉取预览（≤20MB，不落云存储）</Text>
          {ferr ? <Text style={d.artErr} numberOfLines={2}>{ferr}</Text> : null}
          {/* 三眼：路径参考盒——显示串经 brkPath 断行（中文词不拆腰）；复制走下方
              按钮的干净原串（selectable 移除：零宽空格会污染剪贴板） */}
          <View style={d.artPath}>
            <Text style={d.artPathT}>{brkPath(art.path)}</Text>
            {rel ? <Text style={d.artRel} numberOfLines={1}>相对 {brkPath(rel)}</Text> : null}
          </View>
          {/* 次级动作：panel2 底 + line 描边（对齐 permCancel 的次级按钮语言，替换近白隐形的 tintSoft） */}
          <View style={d.artSecRow}>
            <Pressable
              style={d.artSec}
              android_ripple={{ color: withA(c.dim, 0.15), borderless: false, radius: 10 }}
              onPress={() => {
                void Clipboard.setStringAsync(art.path).then(() => {
                  setCopied(true);
                  copiedTimer.current = setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={d.artSecT}>{copied ? "已复制 ✓" : "复制路径"}</Text>
            </Pressable>
            <Pressable
              style={[d.artSec, (busy || dead) && { opacity: 0.5 }]}
              disabled={busy || dead}
              android_ripple={{ color: withA(c.dim, 0.15), borderless: false, radius: 10 }}
              onPress={() => { void doShare(); }}
            >
              <Text style={d.artSecT}>{busy ? "拉取中…" : "分享文件"}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      ) : null}
    </Modal>
  );
}

// #222 文件夹 ⋯ sheet（手机端对齐桌面端 openFolderPop 菜单）：chrome 镜像
// ArtSheet（permScrim/permSheet/permGrab 底部面板）。身份行 = 文件夹 chip +
// 叶子名 + ×N 徽标；元信息 = 目录 · 总大小 · 最近时间；主 CTA = 展开/收起
// （写显式折叠记录后即关，sheet 让位看到列表变化）；次级 = 复制目录路径
// （「已复制 ✓」1.5s，同 ArtSheet 反馈形态）
function ArtFolSheet({ fol, onToggle, onClose }: { fol: { key: string; dir: string; leaf: string; count: number; size: number; at: number; open: boolean } | null; onToggle: () => void; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  return (
    <Modal visible={!!fol} transparent animationType="slide" onRequestClose={fol ? onClose : undefined}>
      {fol ? (
      <Pressable style={d.permScrim} onPress={onClose}>
        <Pressable style={[d.permSheet, { paddingBottom: 14 + insets.bottom }]} onPress={() => undefined}>
          <View style={d.permGrab} />
          <View style={d.artTitleRow}>
            <View style={[d.artChip, { borderColor: withA(c.brandB, 0.45) }]}>
              <Svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={c.brandB} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M3.5 7.2c0-1.3 1-2.3 2.3-2.3h3l2 2.2h6.4c1.3 0 2.3 1 2.3 2.3v7.3c0 1.3-1 2.3-2.3 2.3H5.8c-1.3 0-2.3-1-2.3-2.3z" />
              </Svg>
            </View>
            <Text style={d.artTitle} numberOfLines={2}>{fol.leaf}</Text>
            <Text style={[d.artTag, { color: c.brandB, borderColor: withA(c.brandB, 0.4) }]}>×{fol.count}</Text>
          </View>
          <Text style={d.artMeta} numberOfLines={3}>
            {[fol.dir, fmtArtSize(fol.size), fmtArtTime(fol.at)].filter(Boolean).join(" · ")}
          </Text>
          <Pressable
            style={d.artPri}
            android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
            onPress={() => { onToggle(); onClose(); }}
          >
            <Text style={d.artPriT}>{fol.open ? "收起文件夹" : "展开查看"}</Text>
          </Pressable>
          <Text style={d.artCap}>{fol.open ? `收起后 ${fol.count} 个文件折叠为文件夹行` : `展开列出 ${fol.count} 个文件`}</Text>
          <View style={d.artPath}>
            <Text style={d.artPathT}>{brkPath(fol.dir)}</Text>
          </View>
          <View style={d.artSecRow}>
            <Pressable
              style={d.artSec}
              android_ripple={{ color: withA(c.dim, 0.15), borderless: false, radius: 10 }}
              onPress={() => {
                void Clipboard.setStringAsync(fol.dir).then(() => {
                  setCopied(true);
                  copiedTimer.current = setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={d.artSecT}>{copied ? "已复制 ✓" : "复制目录路径"}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      ) : null}
    </Modal>
  );
}

// #36 权限模式四选一面板（设计定案 docs/perm-mode-design.md §4.2/4.3）：替代原
// 循环点击——恒定 2 击直达任意档、每档一句描述首次使用即懂；跳过档（bypassPermissions
// 免审执行一切命令与编辑）首击只展开底部确认区、再击「确认跳过」才发命令，误触不可达。
// 当前项选中靠整行 tintStrong 底 + 右缘 ✓（不靠游离符号）；已处于跳过档时该行直接收起
// （现状即该危险态，无需再确认一次"保持"）
// #216 受控 visible 常驻渲染（父级不再条件挂卸）：高频会话每秒多次 SESSION_UPDATED
// 逐帧重渲，卸载型写法在 fade dismiss 动画窗口被 re-render 打断时 Android Dialog 会
// 关了又 show（用户侧=「权限面板关不掉」）；受控 prop 显隐由 RN 原生侧保证幂等
function PermPanel({ open, cur, onPick, onClose }: { open: boolean; cur: PermMode; onPick: (m: PermMode) => void; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  // #83 同修：sheet 底部让位手势条（确认按钮原同样贴边）
  const insets = useSafeAreaInsets();
  const [arm, setArm] = useState(false);
  // 常驻后组件不再卸载，关闭时武装态必须随 open 落下复位（防下次打开残留「确认跳过」）
  useEffect(() => { if (!open) setArm(false); }, [open]);
  const pick = (m: PermMode) => {
    if (m === "bypassPermissions") {
      if (cur === "bypassPermissions") { onClose(); return; } // 已在此档：收起即可
      setArm(true); // 首击只武装，等底部「确认跳过」
      return;
    }
    onPick(m);
    onClose();
  };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={open ? onClose : undefined}>
      <Pressable style={d.permScrim} onPress={onClose}>
        <Pressable style={[d.permSheet, { paddingBottom: 14 + insets.bottom }]} onPress={() => undefined}>
          <View style={d.permGrab} />
          <View style={d.permTitleRow}>
            <Text style={d.permTitle}>权限模式</Text>
            <Pressable hitSlop={8} onPress={onClose} accessibilityLabel="关闭权限模式面板">
              <Text style={d.permX}>✕</Text>
            </Pressable>
          </View>
          {PERM_CYCLE.map((m) => {
            const danger = m === "bypassPermissions";
            return (
              <Pressable
                key={m}
                style={[d.permRow, cur === m && d.permRowCur, danger && arm && d.permRowArm]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
                onPress={() => pick(m)}
                accessibilityLabel={`${PERM_MODE_ZH[m]}：${PERM_DESC[m]}${cur === m ? "，当前" : ""}`}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={d.permNameRow}>
                    <Text style={[d.permName, danger && { color: c.waiting }]}>{PERM_MODE_ZH[m]}</Text>
                    {danger ? (
                      <View style={d.permBadge}>
                        <Text style={d.permBadgeT}>危险</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={d.permDesc}>{PERM_DESC[m]}</Text>
                </View>
                {cur === m ? <Text style={d.permCheck}>✓</Text> : null}
              </Pressable>
            );
          })}
          {arm ? (
            <View style={d.permConfirm}>
              <Text style={d.permConfirmT}>开启后所有命令与文件编辑将不经你确认直接执行，仅在你完全信任当前任务时使用</Text>
              <View style={d.permConfirmBtns}>
                <Pressable
                  style={d.permCancel}
                  android_ripple={{ color: withA(c.dim, 0.15), borderless: false, radius: 8 }}
                  onPress={onClose}
                >
                  <Text style={d.permCancelT}>取消</Text>
                </Pressable>
                <Pressable
                  style={d.permGo}
                  android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false, radius: 8 }}
                  onPress={() => { onPick("bypassPermissions"); onClose(); }}
                >
                  <Text style={d.permGoT}>确认跳过</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// W-PORT-B P0-1（桌面 B22 胶囊同能力·bottom-sheet 形态）：模型切换面板——模型列表
// （engine_catalog 按引擎取，当前 ✓ 高亮）+ 自定义模型名输入行 + 「下一回合生效」
// 说明。发送纪律与权限面板同款：ACK ok 静默，relay COMMAND_MODEL 成功即置
// state.model + emitUpdated 权威帧归位（chip 文案随 s.model 变化=可见反馈）；
// 失败走全局错误 toast。模型名校验前移（relay 同则 /^[\w.\/-]{1,80}$/）——非法
// 名本地拦下不白发
function ModelSheet({ open, cur, models, onPick, onClose }: {
  open: boolean;
  cur: string;
  models: string[];
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [custom, setCustom] = useState("");
  useEffect(() => { if (!open) setCustom(""); }, [open]);
  const applyCustom = () => {
    const v = custom.trim().replace(/\[1m\]$/, "");
    if (!v || !/^[\w.\/-]{1,80}$/.test(v)) return; // 非法名按钮置灰，双保险
    onPick(v);
  };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={open ? onClose : undefined}>
      <Pressable style={d.permScrim} onPress={onClose}>
        <Pressable style={[d.permSheet, { paddingBottom: 14 + insets.bottom }]} onPress={() => undefined}>
          <View style={d.permGrab} />
          <View style={d.permTitleRow}>
            <Text style={d.permTitle}>切换模型 · 下一回合生效</Text>
            <Pressable hitSlop={8} onPress={onClose} accessibilityLabel="关闭模型切换面板">
              <Text style={d.permX}>✕</Text>
            </Pressable>
          </View>
          {models.length ? models.map((m) => {
            const on = m === cur;
            return (
              <Pressable
                key={m}
                style={[d.permRow, on && d.permRowCur]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
                onPress={() => { if (!on) onPick(m); onClose(); }}
                accessibilityLabel={`模型 ${m}${on ? "，当前" : ""}`}
              >
                <Text style={d.modelRowT} numberOfLines={1}>{m}</Text>
                {on ? <Text style={d.permCheck}>✓</Text> : null}
              </Pressable>
            );
          }) : (
            <Text style={d.modelEmpty}>未收到该引擎的模型列表，可直接输入模型名</Text>
          )}
          {/* 自定义模型名（桌面同款：列表外的模型名手输直用） */}
          <View style={d.modelCustomRow}>
            <TextInput
              style={d.modelCustomInput}
              placeholder="自定义模型名…"
              placeholderTextColor={c.faint}
              value={custom}
              onChangeText={setCustom}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={applyCustom}
              accessibilityLabel="自定义模型名"
            />
            <Pressable
              style={[d.modelApplyBtn, !/^[\w.\/-]{1,80}$/.test(custom.trim().replace(/\[1m\]$/, "")) && { opacity: 0.45 }]}
              disabled={!/^[\w.\/-]{1,80}$/.test(custom.trim().replace(/\[1m\]$/, ""))}
              android_ripple={{ color: withA(c.brandA, 0.25), borderless: false, radius: 8 }}
              onPress={applyCustom}
            >
              <Text style={d.modelApplyT}>应用</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// #332 任务明细浮窗：转录 #NNN 点击弹出（方案二，替代 #264 直接跳转）——状态/内容/
// active_form 一屏速览，「查看任务列表」作次入口沿用跳转定位。数据取 s.todos 全量：
// 已完成列表的近 1 天窗口截断不影响查明细（旧跳转对窗口外任务只能切 tab 空落）。
// 生命周期（用户定）：3s 无操作自动淡出；点空白立即关；长按 #NNN 钉住不计时（hold），
// 松手（onPressOut → hold=false）重新计 3s。关闭统一走 doClose：先 visible=false 播
// Modal fade 出场动画、280ms 后才真卸载（直接卸载是瞬消，审查#4）。
// #340 气泡化：卡按触摸点（#NNN 处）锚定在其下方，尾巴小方块指向数字；弹出动画
// scale 0.6→1 + translateY(-10)→0 模拟"从数字头顶冒出来"（RN 无 transform-origin，
// 顶边锚定 + 上移起点近似）。卡高 onLayout 后 clamp：下方放不下翻数字上方
function TaskPop({ n, todo, goneSession, hold, anchor, onClose, onGoList }: { n: number; todo: TodoItem | undefined; goneSession: boolean; hold: boolean; anchor?: { x: number; y: number }; onClose: () => void; onGoList: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [vis, setVis] = useState(true);
  const [h, setH] = useState(0);
  const win = Dimensions.get("window");
  const cardW = Math.min(340, win.width - 24);
  const ax = anchor?.x ?? win.width / 2;
  const ay = anchor?.y ?? win.height / 2;
  const left = Math.min(Math.max(12, ax - cardW / 2), Math.max(12, win.width - cardW - 12));
  const below = ay + 18;
  const flip = h > 0 && below + h > win.height - 12;
  const top = h > 0 ? (flip ? Math.max(12, ay - h - 18) : Math.min(below, win.height - h - 12)) : below;
  const tailX = Math.min(cardW - 18, Math.max(18, ax - left)) - 6;
  const ap = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(ap, { toValue: 1, duration: 170, useNativeDriver: true }).start();
  }, [ap]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const byeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (byeTimer.current) clearTimeout(byeTimer.current); }, []);
  const doClose = () => {
    if (!vis) return;
    setVis(false);
    byeTimer.current = setTimeout(() => {
      byeTimer.current = null;
      closeRef.current();
    }, 280);
  };
  useEffect(() => {
    if (hold) return;
    const t = setTimeout(doClose, 3000);
    return () => clearTimeout(t);
  }, [n, hold]);
  const mark = todo ? (todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○") : "·";
  const markColor = !todo ? c.faint : todo.status === "completed" ? c.done : todo.status === "in_progress" ? c.working : c.faint;
  const statusText = todo ? (todo.status === "completed" ? "已完成" : todo.status === "in_progress" ? "进行中" : "待开始") : "不在当前清单";
  return (
    <Modal visible={vis} transparent animationType="fade" onRequestClose={doClose}>
      <Pressable style={d.menuScrim} onPress={doClose}>
        <Animated.View
          style={[
            d.tpWrap,
            {
              left, top, width: cardW,
              transform: [
                { translateY: ap.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) },
                { scale: ap.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
              ],
            },
          ]}
          onLayout={(e) => { const nh = e.nativeEvent.layout.height; if (nh !== h) setH(nh); }}
        >
          <View style={[d.tpTail, { left: tailX, top: flip ? undefined : -6, bottom: flip ? -6 : undefined, borderTopWidth: flip ? 0 : 1, borderLeftWidth: flip ? 0 : 1, borderBottomWidth: flip ? 1 : 0, borderRightWidth: flip ? 1 : 0 }]} />
          <Pressable style={d.menuCard} onPress={() => undefined}>
            <View style={d.tpHead}>
              {/* #410 同任务行：处理中用自绘等径圆圈，避免 ◐ 字形在真机偏小 */}
              {todo?.status === "in_progress" ? (
                <View style={d.tpMarkRun}>
                  <View style={d.tpMarkRunF} />
                </View>
              ) : (
                <Text style={[d.tpMark, { color: markColor }]}>{mark}</Text>
              )}
              <Text style={d.tpNo}>#{n}</Text>
              <Text style={[d.tpStatus, { color: markColor }]}>{statusText}</Text>
            </View>
            {todo ? (
              <>
                {/* #39a 浮窗同款拆尾缀：subAgent 标签化（与列表行一致）；
                    #56a 头部已有 #N 编号列，content 自带的同号前缀剥掉（「#54 #54」双显根治） */}
                <Text style={d.tpContent}>
                  {(() => {
                    let body = todo.content;
                    const own = new RegExp(`^#${n}\\s+`);
                    if (own.test(body)) body = body.replace(own, "");
                    const tag = "「subAgent」";
                    return body.endsWith(tag) ? (
                      <>{body.slice(0, -tag.length).trimEnd()}<Text style={d.todoSubTag}>subAgent</Text></>
                    ) : body;
                  })()}
                </Text>
                {todo.status === "in_progress" && todo.active_form ? (
                  <Text style={d.tpActive}>正在：{todo.active_form}</Text>
                ) : null}
                {typeof todo.updated_at === "number" && Number.isFinite(todo.updated_at) ? (
                  <Text style={d.tpTime}>{fmtElapsed(Math.max(0, Date.now() - todo.updated_at))} 前更新</Text>
                ) : null}
              </>
            ) : (
              <Text style={d.tpContent}>{goneSession ? "会话已不存在" : "该任务已不在本会话的当前清单中"}</Text>
            )}
            <View style={d.tpFoot}>
              <Text style={d.tpHint}>长按可固定</Text>
              <Pressable
                hitSlop={6}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                onPress={() => {
                  doClose();
                  onGoList();
                }}
              >
                <Text style={d.tpLink}>查看任务列表 →</Text>
              </Pressable>
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}


// 类 Claude Code 状态行：✶ 摘要 · Ns（每秒走帧）。无边框，嵌入状态条内。

// W-EXPO 005 dock 呼吸点（.session-state-dot 等价）：#148 铁律低频步进——480ms/步
// 四级三角波（≈1.9s 一拍，每秒仅 2 次提交），禁逐帧 Animated（RenderThread 风暴）

// E3a 状态/收口条（类 CLI，固定工具区内）：ERROR ⚠ 常驻 / DONE ✓ 尾窗收口（本轮
// 刚结束 8s 内，「本轮已完成」）/ WAITING 等待行（横幅不可见时的兜底行，原状态条
// 语义原样收编）。显隐与文案全部走 closingBarOf 纯投影；仅 DONE 尾窗激活期起 1s
// 低频步进自隐（#148 铁律不用 Animated/高频帧），其余态零计时器零多余渲染
function StatusStrip({ s, wr, bannerVisible }: { s: SessionState; wr: WaitingPayload | null; bannerVisible: boolean }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  const bar = closingBarOf(s, Date.now());
  const tailLive = bar?.kind === "done";
  useEffect(() => {
    if (!tailLive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [tailLive]);
  if (s.status === "ERROR" || bar) {
    // W-EXPO 005 终态收口动画等价（terminal-fade；#148 铁律低频步进不逐帧）：
    // DONE 尾窗最后 1s 降半档透明度预告收口，窗口关闭即卸载；ERROR ⚠ 常驻不收
    const age = Date.now() - (s.activity?.updated_at ?? 0);
    const fading = bar?.kind === "done" && DONE_TAIL_MS - age <= 1000;
    return (
      <View style={[d.strip, fading && { opacity: 0.45 }]}>
        {s.status === "ERROR" ? (
          <Text style={d.stripErr} numberOfLines={2}>⚠ {s.last_error || "出错了"}</Text>
        ) : (
          <Text style={d.stripDone} numberOfLines={1}>✓ {bar!.text}</Text>
        )}
      </View>
    );
  }
  if (s.status === "WAITING" && !bannerVisible) {
    return (
      <View style={d.strip}>
        <LiveStatusLine
          summary={wr ? (wr.questions?.length ? `等待作答：${wr.questions[0]?.header ?? ""}` : `等待确认：${wr.tool_name || (wr.input_summary ?? "").slice(0, 48)}`) : "等待 CLI 输入"}
          startedAt={wr?.received_at}
          color={c.waiting}
        />
      </View>
    );
  }
  return null;
}

// 排队注入消息：脉冲呼吸（类 CLI queued），CLI 处理/回合结束时上浮为正式消息。
// #148 同源降级：原 Animated 逐帧呼吸（native 驱动 900ms 往返）与列表呼吸灯同一
// 渲染风暴——改低频步进：六级三角波 600ms/步（3.6s 一拍），每秒 ~1.7 次提交

// 005 wait-card 容器（#166 双态）：isAsk 提问态=中性底+品牌描边（提问≠风险，不用
// 警示色）；审批态=黄 tint 警示。手机仅浏览口径下底部挂引导条

const AnimatedPressable = Animated.createAnimatedComponent(Pressable); // W-SWIPEASK：圆点跟手淡入淡出（插值 opacity 须挂 Animated 组件）

// AskUserQuestion 作答横幅：单问题单选 = 点选项即发；多问题/多选 = 勾选后提交；单问题支持自由输入
// #190 多问题 stepper（CLI 式，对齐桌面端）：一次只展示一题 + 题号指示器（可点击跳题）；
// 单选题选中自动进下一题、末题留步等「提交回答」——题多时 banner 不再撑爆底部栈

// initialView（#300/#306）：外部直达目标页（待确认悬浮清单跳"任务" tab）——挂载即落位，
// 不播 tab 切换动画；缺省 "msg" 与旧行为一致
// 返回句柄（#282 顶层分发的详情侧扩展）：非消息视图时返回键先回消息页而不是退出详情
export interface DetailBackHandle {
  requestBack: () => boolean;
}

// W-LIST2 件二②③：详情头颗粒水位计（电脑端 index-005 context-meter 分段形制移植）——
// 20 格颗粒（w3×h6 圆角1，尺寸按手机屏定）替代完整条状；亮格色=报警档分级（正常
// dim / 60-84 黄 / ≥85 红，与 ctxTone 同源同词表），暗格=ctxTrack；百分比文本保留在
// 组件尾侧（视觉干净：颗粒承形、数字承精确值，不双条不双字）。

export default function DetailScreen({ sid, onBack, initialView, onOpenArtPool, onOpenSession, onOpenTeam, ref }: { sid: string; onBack: () => void; initialView?: ViewKind; onOpenArtPool?: () => void; onOpenSession?: (sid: string) => void; onOpenTeam?: () => void; ref?: Ref<DetailBackHandle> }) {
  const { c, mode } = useTheme();
  const d = useThemeStyles(makeStyles);
  // #36 权限模式四选一面板：胶囊（Head R2）点开，替代循环切换。
  // #216 终态（dev 0.6.1/0.6.2 定稿）：三~五段修的守卫链全数拆除，胶囊
  // onPress 直连 setPermPanel——守卫在真机上误伤正常点击（六段修定案）
  const [permPanel, setPermPanel] = useState(false);
  // W-PORT-B P0-1：模型切换面板 state（桌面 B22 同能力）
  const [modelSheet, setModelSheet] = useState(false);
  const snap = useRelay();
  const [input, setInput] = useState(() => drafts.get(sid) ?? "");
  // 件五：发送乐观回显（用户实测痛点——手机发出后消息消失 ~5s 才在排队区出现，发送
  // 端自己看不到）。发送瞬间同步注入 pending 气泡（0.5s 内本地可见），relay 回声/
  // 排队/失败三路对账收敛（reconcilePending 纯函数，../pending-echo.ts）；跨会话条目
  // 键控隔离（DetailScreen 常驻复用，切会话不串气泡）
  const [pendingEcho, setPendingEcho] = useState<PendingEcho[]>([]);
  const echoSeq = useRef(0);
  // #68① 多行自动增高：Android 下纯 minHeight/maxHeight 的自适应不可靠（实测长文
  // 恒 1 行），改 onContentSizeChange 显式定高，夹在 [44,150]（晨间反馈 110→150：
  // 拉高后能看到更多已输入内容）；封顶后高度恒定、内部自然滚动（类微信）
  // #113 基线自校准：部分机型（测试机 OPPO density480 实锤）空输入的 contentSize
  // 虚高（含 padding/边框，≈64 而非净行高 ≈20），旧算法 h+24 把空输入夹成 ≈88
  // （两倍高）。改为：空输入时记下该设备基线、高度恒 44；有内容按 相对基线的增量
  // 定高——虚高机型与诚实机型统一归一，单行 44、每多一行 +lineHeight
  const [inputH, setInputH] = useState(44);
  const inputBaseRef = useRef<number | null>(null); // #113 设备单行基线（首次空输入事件校准）
  // #129 回车键行为：开 = 回车发送（恢复 #68 多行化之前的旧习惯）；关 = 回车换行
  const enterSend = useEnterSend();
  const inputRef = useRef<TextInput>(null);
  // #216 四段修的坐标守卫 ref（permPillRef/permPillCtr）随终态拆除（见上）
  const editInput = (v: string) => {
    if (v) drafts.set(sid, v);
    else drafts.delete(sid);
    setInput(v);
  };
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  const [renaming, setRenaming] = useState(false);
  const [view, setView] = useState<ViewKind>(initialView ?? "msg");
  // 回到底部浮钮（#322 第四轮定位，用户拍板）：对话区顶部居中小胶囊（ChatGPT 手机端
  // 样式，带下箭头），上滑离开底部即出现，吸顶浮动不占布局、不与 App 壳悬浮钮打架
  const [showJump, setShowJump] = useState(false);
  // W-MOTION：浮钮显隐走 opacity 过渡（常驻挂载+pointerEvents 门控——原条件渲染瞬跳）
  const jumpOp = useRef(new Animated.Value(0)).current;
  // 回到底部浮钮（第五轮）：滚动中隐藏、停止 ~300ms 后浮现；atBottom/jumpScrollable 由 onScroll 维护
  const jumpIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpScrollable = useRef(false);
  useEffect(() => () => { if (jumpIdleTimer.current) clearTimeout(jumpIdleTimer.current); }, []);
  useEffect(() => { setShowJump(false); }, [view]);
  // W-MOTION：showJump/view 变化 → 150ms opacity 过渡（原生驱动）
  useEffect(() => {
    Animated.timing(jumpOp, { toValue: showJump && view === "msg" ? 1 : 0, duration: 150, useNativeDriver: true }).start();
  }, [showJump, view, jumpOp]);
  const [showThink, setShowThink] = useState(thinkShown);
  const [collapsed, setCollapsed] = useState(ctrlCollapsed);
  // #142 子 Agent 面板展开态（初始同步模块级记忆，点按写回）
  const [agOpen, setAgOpen] = useState(!agCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // #376 定时任务条目展开态（按任务 id）
  const [cronOpen, setCronOpen] = useState<Record<string, boolean>>({});
  // #222 输出物文件夹折叠态（键 sid|dirLower；未记录 = 最近活跃的文件夹展开、其余折叠，
  // 用户点开/点折叠后以显式记录优先）
  const [artFold, setArtFold] = useState<Record<string, boolean>>({});
  // 内容长按菜单（#249）：非空即弹 ContentMenu
  const [menuText, setMenuText] = useState<string | null>(null);
  const todoScrollRef = useRef<ScrollView>(null);
  const todoAtBottom = useRef(true);
  // 任务面板常驻滑块：onScroll 里 setValue(contentOffset.y)（bridgeless 下 Animated.event
  // 原生驱动会崩，见 0.2.26），thumb 位移靠 interpolate 插值；尺寸来自 onLayout/onContentSizeChange，
  // 展开即渲染，不依赖首次滚动
  const todoScrollY = useRef(new Animated.Value(0)).current;
  const [todoMetrics, setTodoMetrics] = useState({ content: 0, layout: 0 });
  const todoThumbH = todoMetrics.content > 0
    ? Math.max(28, (todoMetrics.layout * todoMetrics.layout) / todoMetrics.content)
    : 28;
  const todoTravel = Math.max(1, todoMetrics.content - todoMetrics.layout);
  const thumbTravel = Math.max(0, todoMetrics.layout - todoThumbH - 4);
  const [images, setImages] = useState<string[]>([]);
  // #62 待发文件：原文 base64（≤2 个/单个 20MB；relay sanitize 28MB b64 兜底）
  const [files, setFiles] = useState<{ name: string; b64: string }[]>([]);
  const [queuedHint, setQueuedHint] = useState<string | null>(null);
  const flashHint = (t: string) => {
    setQueuedHint(t);
    setTimeout(() => setQueuedHint(null), 4000);
  };
  const flashQueuedHint = () => flashHint("已排队，确认/回合结束后自动发送");
  const [picking, setPicking] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const allScrollRef = useRef<ScrollView>(null); // W-EXPO 四 tab 化后仅对话页用滚动锚（保留 ref 防他处引用悬空）
  const pagerRef = useRef<ScrollView>(null);
  // E3b 决议定向守卫：晚到 ACK 失败只在同一请求仍挂起时提示（wr 每渲染同步进 ref，
  // 回调闭包读到的不是过期渲染帧）
  const wrRef = useRef<WaitingPayload | null>(null);
  // 六视图滑动指示条：由翻页滚动位置原生驱动（useNativeDriver 跟手，不走 JS 线程不掉帧）
  const scrollX = useRef(new Animated.Value(0)).current;
  const [tabRowW, setTabRowW] = useState(0);
  const atBottom = useRef(true);
  // 手指按住期间暂停自动滚底：流式更新的 scrollToEnd 跳变会打断进行中的按压（chip/展开全文点不中）
  const touching = useRef(false);
  const kb = useKbHeight();
  const insets = useSafeAreaInsets();
  const s: SessionState | undefined = snap.sessions.find((x) => x.session_id === sid);

  // #71 输出物开关：SNAPSHOT.deliverables（relay 插件配置）=== true 才显示「输出物」页
  // （旧 relay 无字段同样隐藏）。VIEWS 仍是静态全集（ViewKind 类型来源），运行时以
  // VS 驱动 tab 行/翻页/指示条；与网页端 renderDetail 同口径。
  // #146 修正（聚合模式）：deliverables 是 relay 侧 per-源 配置——跟「正在看的会话
  // 所属源」取数（s.src 聚合时盖章；1649 行 slashSrc / 源角标同款先例）。旧口径一律
  // 取活动源：活动源指向从未上线的离线源（deliverables=false）时，其他源的会话也被
  // 误藏 tab（用户实测：公司电脑关机+聚合，Mac 会话输出物栏消失）。单源模式 s.src
  // 未盖章（或源找不到）回落 snap.deliverables，行为不变
  const srcDeliverables = s?.src !== undefined
    ? snap.sources.find((x) => x.id === s.src)?.deliverables
    : undefined;
  const deliverables = srcDeliverables ?? snap.deliverables;
  // W-MOBFUSION 件④：PM 判定（桌面 SLIM_KEEP_ROLE 同词表）——编制 headcount 反查
  // 本会话 KEEP_ROLE 命中的在办团队（跨源平铺，gid 先建赢）；命中才出「团队」tab。
  // 四区数据面=桌面第四列抽屉同构：板（snap.boards BOARD_UPDATED 跟随缓存）/成员
  // roster/输出物计数/跳团队域
  const allProjects = useMemo(() => {
    const out: ProjectGroup[] = [];
    const seen = new Set<string>();
    for (const src of snap.sources) {
      for (const g of src.projects ?? []) if (g?.id && !seen.has(g.id)) { seen.add(g.id); out.push(g); }
    }
    return out;
  }, [snap.sources]);
  // 板缓存跨源聚合（per-source boards Record；同 gid 先建赢）——件四概览区数据面
  const boardsByGid = useMemo(() => {
    const out: Record<string, { entries?: { status?: string }[] }> = {};
    for (const src of snap.sources) {
      for (const [gid, b] of Object.entries(src.boards ?? {})) if (!out[gid]) out[gid] = b;
    }
    return out;
  }, [snap.sources]);
  const pmTeam = useMemo(() => {
    for (const g of allProjects) {
      if (g.status !== "active" || !Array.isArray(g.headcount)) continue;
      const hit = g.headcount.some((m) => m && m.session_id === sid && SLIM_KEEP_ROLE_RE.test(String(m.role || "")));
      if (hit) return g;
    }
    return null;
  }, [allProjects, sid]);
  // W-FB66REST ③：head 头像角色档判定——列表卡 pmRoleKindOf 同词表同优先级
  // （pm 档 /^(pm|产品经理|项目经理)$/i、leader 档 /^(leader|领队)$/i，两遍扫描
  // leader 压 pm=皇冠蟹优先）；本会话单条直查，语义同列表卡全 Map
  const headRoleKind = useMemo(() => {
    const hit = (re: RegExp) => allProjects.some((g) => Array.isArray(g.headcount) && g.headcount.some((m) => m && m.session_id === sid && re.test(String(m.role || ""))));
    return hit(/^(leader|领队)$/i) ? "leader" : hit(/^(pm|产品经理|项目经理)$/i) ? "pm" : null;
  }, [allProjects, sid]);
  const VS: readonly { k: ViewKind; label: string }[] = useMemo(() => {
    let base: readonly { k: ViewKind; label: string }[] = deliverables === true ? VIEWS : VIEWS.filter((v) => v.k !== "arts");
    if (!pmTeam) base = base.filter((v) => v.k !== "team");
    return base;
  }, [deliverables, pmTeam]);
  // #72 E 线 产物池入口②门（本会话所属源过三重门才显示「全局输出物目录」可达行）：
  // 与 deliverables 同款 per-源取数（s.src 盖章 → 源查找 → 回落活动源）。入口①常驻钮
  // 在列表页（ListScreen），此处是详情可达语义（web W 线两枚入口镜像）
  const srcForArt = s?.src ?? snap.activeSourceId;
  const artPoolSrc = srcForArt ? snap.sources.find((x) => x.id === srcForArt) : undefined;
  const poolOpenable = artPoolGate(artPoolSrc);
  // 停在被关掉的页（开着「输出物」时关开关/重连到关闭的 relay）→ 回落消息页，防 -1 白屏。
  // W-MOBFUSION R2（审查 A P1）：deps 补 pmTeam——团队 tab 是条件 tab，roster 行直开
  // worker 会话（页内换 sid）/团队转 archived 后 pmTeam 失效，view="team" 悬空停空白页
  useEffect(() => {
    if (!VS.some((v) => v.k === view)) setView("msg");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliverables, pmTeam, view]);

  // 手动刷新任务清单：↻ 发命令，等下一帧 todos 引用变化（或 2.5s 超时）结束等待态
  const [todoSpin, setTodoSpin] = useState(false);
  const todoSpinAt = useRef<unknown>(null);
  const todoSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTodos = () => {
    store.send("COMMAND_REFRESH_TODOS", { session_id: sid });
    todoSpinAt.current = s?.todos ?? null;
    setTodoSpin(true);
    if (todoSpinTimer.current) clearTimeout(todoSpinTimer.current);
    todoSpinTimer.current = setTimeout(() => setTodoSpin(false), 2500);
  };
  useEffect(() => {
    if (todoSpin && s?.todos && s.todos !== todoSpinAt.current) {
      if (todoSpinTimer.current) clearTimeout(todoSpinTimer.current);
      setTodoSpin(false);
    }
  }, [s?.todos, todoSpin]);

  // 底部上拉刷新（#257）：滚到底松手即触发同一 refreshTodos；冷却 8s。
  // 「拖拽装弹」守卫同 #255：stick-to-bottom 的 scrollToEnd 是程序滚动，不装弹，
  // 只有真实拖过列表（onScrollBeginDrag）才允许消费一次触发
  const todoFootArmed = useRef(false);
  const todoFootLast = useRef(0);
  // fromTouch=true 走 touch 位移兜底（#266）：列表已停在底部时继续上拉无滚动位移，
  // Android 不派发 onScrollBeginDrag → armed 永不置位，只能装弹一次后失效
  const todoFootRefresh = (fromTouch = false) => {
    if (!fromTouch && !todoFootArmed.current) return;
    todoFootArmed.current = false;
    if (todoSpin || Date.now() - todoFootLast.current < 8000) return;
    todoFootLast.current = Date.now();
    refreshTodos();
  };
  // touch 兜底判定：起止位移垂直占优、上拉 >40dp（pageX/pageY 为相对根视图 dp 坐标）
  // 且松手时仍在底部才触发——免疫程序 scrollToEnd（无 touch）、点按/长按 ✕（无位移）、
  // 横向翻页与下拉刷新（父容器/RefreshControl 接管后子端收 touchCancel 而非 touchEnd）
  const todoTouch = useRef<{ x: number; y: number } | null>(null);
  const todoTouchStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
    todoTouch.current = t ? { x: t.pageX, y: t.pageY } : null;
  };
  const todoTouchEnd = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const s = todoTouch.current;
    todoTouch.current = null;
    const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
    if (!s || !t) return;
    const dy = s.y - t.pageY;
    if (dy > 40 && dy > Math.abs(t.pageX - s.x) && todoAtBottom.current) todoFootRefresh(true);
  };

  // 任务条目 ✕ 隐藏：本地先过滤（立即消失），relay 记隐藏集过滤后续下发
  const [todoHidden, setTodoHidden] = useState<string[]>([]);
  const hideTodo = (content: string) => {
    console.log("[todo-hide]", content.slice(0, 30));
    setTodoHidden((h) => (h.includes(content) ? h : [...h, content]));
    store.send("COMMAND_TODO_HIDE", { session_id: sid, content });
  };

  // 任务存储是全会话历史。排序：已完成置顶、下面进行中、再待办；组内保持 relay 下发的
  // 任务号顺序（旧→新，稳定排序不动组内先后）——整列从上往下时间感单调。
  // 已完成历史不无限堆：带 mtime 只展示近 24h，再封顶最新 15 条（防马拉松日爆量）；
  // 无时间戳的旧数据直接取最新 15 条。进行中/待办是可操作项，全保留
  // #85 待验证档（in_progress 的第四态细分）：进行中 → 待验证 → 待办
  const todoRank = (t: TodoItem) => (t.status === "completed" ? 0 : isVerifyTodo(t) ? 2 : t.status === "in_progress" ? 1 : 3);
  const allTodos = (s?.todos ?? []).filter((t) => !todoHidden.includes(t.content));
  // #374 拖动排序：仅未完成区可调——openOrder 为空 = relay 原序；拖动后本地乐观重排，
  // 松手注入调序指令让 CLI 重新 TodoWrite（transcript 回流后三端一致）
  const [openOrder, setOpenOrder] = useState<string[]>([]);
  const pendKeyOf = (t: TodoItem) => String(t.id ?? t.content);
  let openTodos = allTodos.filter((t) => t.status !== "completed");
  if (openOrder.length) {
    const rank = new Map(openOrder.map((k, i) => [k, i] as const));
    openTodos = [...openTodos].sort((a, b) => (rank.get(pendKeyOf(a)) ?? 999) - (rank.get(pendKeyOf(b)) ?? 999));
  }
  const doneAll = allTodos.filter((t) => t.status === "completed");
  const doneHasTs = doneAll.length > 0 && doneAll.every((t) => typeof t.updated_at === "number");
  const doneWindow = doneHasTs
    ? doneAll.filter((t) => (t.updated_at ?? 0) >= Date.now() - 24 * 3600 * 1000)
    : doneAll;
  const doneList = doneWindow.slice(-15);
  const doneNote =
    doneList.length < doneAll.length
      ? doneHasTs
        ? ` · 近1天${doneWindow.length > 15 ? "·最新15" : ""}`
        : " · 最新15"
      : "";
  const sortedTodos = [...doneList, ...openTodos].sort(
    (a, b) => todoRank(a) - todoRank(b),
  );
  const todoGroups = [
    { status: "completed", label: `已完成 ${doneList.length}/${doneAll.length}${doneNote}` },
    { status: "in_progress", label: `进行中 ${allTodos.filter((t) => t.status === "in_progress" && !isVerifyTodo(t)).length}` },
    { status: "verify", label: `待验证 ${allTodos.filter((t) => isVerifyTodo(t)).length}` },
    { status: "pending", label: `待开始 ${allTodos.filter((t) => t.status === "pending").length}` },
  ] as const;
  // 子 Agent 运行中时本地走秒（relay 只在状态变化时推，秒数由端上自算）。
  // #142 防御：ended_at>0 才算结束——数据侧 ended_at:0（defined-but-falsy）会让
  // `?? Date.now()` 取 0 → 负时长冻结读秒，run 判定与取值同口径
  const agRunning = (s?.subagents ?? []).some((a) => !((a.ended_at ?? 0) > 0));
  const [, setAgTick] = useState(0);
  useEffect(() => {
    if (!agRunning) return;
    const t = setInterval(() => setAgTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [agRunning]);

  // #358 任务条目去 ✕：左滑 ≥50dp 移除（touch 位移判定，垂直滚动不受影响）
  // #374 拖动排序：长按 ≥350ms 且纵向占优 → PanResponder 捕获阶段抢过 ScrollView，
  // 跟手 translateY + 每 46dp 跨一行换位（本地乐观 openOrder），松手注入调序指令
  // （外部会话忙时自动排队）；与左滑互斥（拖动态吞掉滑删判定）
  const todoTouchX = useRef<number | null>(null);
  const touchStartAt = useRef(0);
  const dragFromIdx = useRef(0);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const commitReorder = () => {
    setDragKey(null);
    dragY.setValue(0);
    if (!openOrder.length) return;
    const list = openTodos.map((t) => (t.status === "in_progress" ? `[进行中] ${t.content}` : t.content));
    if (list.length < 2) return;
    const instruction =
      `【任务优先级已由用户手动调整】请立即用 TodoWrite 按新顺序重写未完成任务清单（已完成条目保持不动），` +
      `之后严格按此顺序执行——从第 1 条未完成任务开始。新顺序：\n` +
      list.map((x, n) => `${n + 1}. ${x}`).join("\n");
    store.send(external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE", { session_id: sid, text: instruction });
    flashQueuedHint();
  };
  const renderTodo = (t: TodoItem, i: number, grouped: boolean) => {
    const key = pendKeyOf(t);
    const dragging = dragKey === key;
    const rowPan = PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // 捕获阶段判定：按住超 350ms 且纵向占优才接管（快速竖滑仍是列表滚动）
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        t.status !== "completed" &&
        Date.now() - touchStartAt.current > 220 &&
        Math.abs(g.dy) > 5 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        try { Vibration.vibrate(15); } catch {}
        dragY.setValue(0);
        dragFromIdx.current = Math.max(0, openTodos.findIndex((x) => pendKeyOf(x) === key));
        if (!openOrder.length) setOpenOrder(openTodos.map(pendKeyOf));
        setDragKey(key);
      },
      onPanResponderMove: (_e, g) => {
        dragY.setValue(g.dy);
        const delta = Math.round(g.dy / 46) - dragFromIdx.current;
        if (delta !== 0 && openTodos.length > 1) {
          const from = Math.max(0, openTodos.findIndex((x) => pendKeyOf(x) === key));
          const to = Math.min(openTodos.length - 1, Math.max(0, from + delta));
          if (from !== to) {
            const next = openOrder.length ? [...openOrder] : openTodos.map(pendKeyOf);
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            setOpenOrder(next);
            dragFromIdx.current = to;
          }
        }
      },
      onPanResponderRelease: commitReorder,
      onPanResponderTerminate: commitReorder,
    });
    return (
    <Animated.View
      style={[d.todoRow, grouped && { borderTopWidth: 0, marginTop: 0 }, t.id != null && t.id === flashTodo && d.todoFlash, dragging && d.todoRowDrag, dragging && { transform: [{ translateY: dragY }] }]}
      onLayout={t.id != null ? (ev) => todoY.current.set(t.id!, ev.nativeEvent.layout.y) : undefined}
      onTouchStart={(e) => {
        const tc = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
        todoTouchX.current = tc ? tc.pageX : null;
        touchStartAt.current = Date.now();
      }}
      onTouchEnd={(e) => {
        const sx = todoTouchX.current;
        todoTouchX.current = null;
        if (dragKey) return;
        const tc = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
        if (sx == null || !tc) return;
        if (sx - tc.pageX > 50) hideTodo(t.content);
      }}
      {...rowPan.panHandlers}
    >
      {/* #410 处理中不再用 ◐ 字形：真机回退字体里它远小于 ○/✓（两字形走不同回退字体），
          改自绘等径圆环+左半填充，直径锁定=○ 的视觉直径，跨设备一致；颜色仍走 c.working token */}
      {t.status === "in_progress" ? (
        <View style={d.todoMarkRun}>
          <View style={d.todoMarkRunC}>
            <View style={d.todoMarkRunF} />
          </View>
        </View>
      ) : (
        <Text style={[d.todoMark, t.status === "completed" && { color: c.done }]}>
          {t.status === "completed" ? "✓" : "○"}
        </Text>
      )}
      <Text
        style={[
          d.todoT,
          t.status === "pending" && { color: c.dim },
          t.status === "in_progress" && { color: c.text, fontWeight: "700" },
          t.status === "completed" && { color: c.dim },
        ]}
        numberOfLines={2}
      >
        {/* #39a subject 尾缀「subAgent」拆出渲染成小标签（委托任务标注约定），
            主体文字不带引号串，视觉弱化为 chip 形态。任务编号 #N 前缀显示（对齐
            web 端 tp-num；权威任务存储的 id 由此可见，转录 #NNN 可点跳转的锚） */}
        {(() => {
          const body = t.status === "in_progress" && t.active_form ? t.active_form : t.content;
          const tag = "「subAgent」";
          const num = t.id != null ? `#${t.id} ` : "";
          return body.endsWith(tag) ? (
            <>
              {num}
              {body.slice(0, -tag.length).trimEnd()}
              <Text style={d.todoSubTag}>subAgent</Text>
            </>
          ) : (
            <>
              {num}
              {body}
            </>
          );
        })()}
      </Text>
      {t.status !== "completed" ? <Text style={d.todoDragT}>⠿</Text> : null}
    </Animated.View>
  );
  };

  // #264：转录 #NNN 点击 → 任务 tab 定位该条（行 y 由 onLayout 记账，落点闪高 1.5s；
  // 任务不在近 3 天窗口（未渲染）时只切 tab 不滚——y 无记录为无害回退）。
  // #332：点击先弹任务明细浮窗（方案二），jumpToTask 降级为浮窗内「查看任务列表」入口
  const todoY = useRef(new Map<number, number>());
  const [flashTodo, setFlashTodo] = useState<number | null>(null);
  const [taskPop, setTaskPop] = useState<number | null>(null);
  const [taskHold, setTaskHold] = useState(false);
  // #35 输出物详情 sheet：点行打开（artPop 为该条快照，rel 由挂载点按会话 cwd 现算）
  const [artPop, setArtPop] = useState<ArtifactItem | null>(null);
  // #222 文件夹 ⋯ sheet（2026-10-02 用户拍板「手机端也要一样处理」：行尾统一 ⋯，
  // 菜单内容按文件夹语义定制）：快照 = 分组摘要 + 开合态。folOpen 是输出物视图
  // IIFE 局部函数，组件根级挂载点不可达——开合态在行尾 Pressable 处（作用域内）
  // 随快照带出；onToggle 写显式 artFold 记录 + 同步翻转快照（sheet 是 Modal 单发
  // 交互，主 CTA 按下即关，快照无陈旧窗口）
  const [folPop, setFolPop] = useState<{ key: string; dir: string; leaf: string; count: number; size: number; at: number; open: boolean } | null>(null);
  const [taskAnchor, setTaskAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const openTaskRef = (n: number, hold = false, anchor?: { x: number; y: number }) => {
    setTaskPop(n);
    setTaskHold(hold);
    setTaskAnchor(anchor);
  };
  const outTaskRef = () => setTaskHold(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const jumpToTask = (n: number) => {
    const i = VS.findIndex((v) => v.k === "todos");
    if (i < 0) return;
    const needFly = i !== viewIdx;
    if (needFly) gotoView(i);
    setTimeout(() => {
      // y 要在飞行后读：跨页时任务页此刻才挂载、行 onLayout 才记账（审查必须修项）
      const y = todoY.current.get(n);
      if (y === undefined) return;
      todoScrollRef.current?.scrollTo({ y: Math.max(0, y - 110), animated: true });
      setFlashTodo(n);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashTodo(null), 2600);
    }, needFly ? 380 : 0);
  };

  // 转录跟随：直接 filter 不做 useMemo（logs 引用每次更新都变）；仅当用户停在底部时自动滚。
  // 六视图翻页（#250）：消息/全部两页各自过滤，当前页的滚动容器才跟随滚底
  const logs = s ? store.timelineOf(sid) : [];
  // W-PUSHPERF ①：渐进上屏——挂载首帧只渲染尾部 REVEAL_N 条（骨架即出转场跟手），
  // InteractionManager 空闲后放开全量（长转录分帧上屏，JS 不被首帧阻塞饿死动画）
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const h = InteractionManager.runAfterInteractions(() => setRevealed(true));
    return () => h.cancel();
  }, [sid]);
  const procFont = useProcessFont();
  const procVisible = logs.filter(
    (e) =>
      (e.kind !== "thinking" || showThink) &&
      !(procFont === "hidden" && (e.kind === "tool_use" || e.kind === "tool_result" || e.kind === "system")),
  );
  const shownMsg = procVisible.filter((e) => matchFilter(e.kind, "msg", e.tool));
  const pageShown = view === "msg" ? shownMsg : [];
  // 件五对账：回声（user_message）/排队（pending_inputs）到达即收敛 pending 气泡
  const myEcho = useMemo(() => pendingEcho.filter((p) => p.sid === sid), [pendingEcho, sid]);
  useEffect(() => {
    setPendingEcho((prev) => {
      const next = reconcilePending(prev, { sid, logs, pendingInputs: s?.pending_inputs, now: Date.now() });
      return next === prev ? prev : next;
    });
  }, [logs, s?.pending_inputs, sid, myEcho.length]);
  const lastEntry = pageShown.length ? pageShown[pageShown.length - 1] : null;
  const lastLen = lastEntry ? (lastEntry.full ?? lastEntry.text).length : 0;
  useEffect(() => {
    const ref = view === "msg" ? scrollRef.current : null;
    if (ref && atBottom.current && !touching.current) ref.scrollToEnd({ animated: false });
  }, [view, pageShown.length, lastLen, s?.pending_inputs?.length ?? 0, s?.status === "WORKING", myEcho.length]);
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));
  // 六视图横向翻页（#250/#252）：页宽=窗口宽（锁定竖屏）。tab 点击一律动画滚动；
  // 远跳（>1 页）飞行途中临时全渲染，防掠过的中间页闪空白

  const viewIdx = VS.findIndex((v) => v.k === view);
  const pagerW = Dimensions.get("window").width;
  const [flight, setFlight] = useState(false);
  // 程序化滚动期间挂起 onScroll 的 label 联动：tab 已即时高亮目标项，
  // 不能被飞行起点处"位置还在旧页"的回写打回。兜底定时器存 ref：连点
  // tab 时先清上一次的，防止旧定时提前复位打断本次飞行（momentum end 是权威清旗点）
  const progJump = useRef(false);
  const progTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (progTimer.current) clearTimeout(progTimer.current);
    if (flightTimer.current) clearTimeout(flightTimer.current);
  }, []);
  const gotoView = (i: number) => {
    if (i === viewIdx) return;
    try { Vibration.vibrate(10); } catch {}
    progJump.current = true;
    if (progTimer.current) clearTimeout(progTimer.current);
    progTimer.current = setTimeout(() => { progJump.current = false; }, 1200);
    setView(VS[i].k);
    if (Math.abs(i - viewIdx) > 1) {
      setFlight(true);
      if (flightTimer.current) clearTimeout(flightTimer.current);
      flightTimer.current = setTimeout(() => setFlight(false), 1200);
    }
    pagerRef.current?.scrollTo({ x: i * pagerW, animated: true });
  };
  useImperativeHandle(ref, () => ({
    // 非"消息"视图：返回=切回消息页；消息视图：交给 Shell 关详情
    requestBack: () => {
      if (viewIdx > 0) {
        gotoView(0);
        return true;
      }
      return false;
    },
  }), [viewIdx]);

  // 外部直达目标页（#300）：view 初值即 initialView，但 pager 原生滚动位置仍在 0——
  // 挂载后程序滚动落位（animated:false 不播切换动画）；宽度渲染时重读（分屏/旋转后
  // 首帧窗口已换宽）。仅在挂载时执行一次，后续 initialView 变化不追（组件随 sid 换不重挂）
  useEffect(() => {
    const i = VS.findIndex((v) => v.k === initialView);
    if (i > 0) pagerRef.current?.scrollTo({ x: i * Dimensions.get("window").width, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 指示条几何：tab 等宽分铺 tabWrap（TAB_PAD_L 左边距 + TAB_GAP 间隙），横杠宽 = 单 tab 宽，
  // 每滑一页平移 (tabW + gap)；滑到两页中间时轻微拉伸（1.3x）落位回缩，clamp 防 overscroll 过冲
  const tabW = tabRowW > 0 ? (tabRowW - TAB_PAD_L - TAB_GAP * (VS.length - 1)) / VS.length : 0;
  const indX = scrollX.interpolate({
    inputRange: VS.map((_, i) => i * pagerW),
    outputRange: VS.map((_, i) => i * (tabW + TAB_GAP)),
    extrapolate: "clamp",
  });
  const stretchIn: number[] = [0];
  const stretchOut: number[] = [1];
  for (let k = 0; k < VS.length - 1; k++) {
    for (const f of [0.25, 0.5, 0.75, 1]) {
      stretchIn.push((k + f) * pagerW);
      stretchOut.push(f === 1 ? 1 : f === 0.5 ? 1.3 : 1.16);
    }
  }
  const indS = scrollX.interpolate({ inputRange: stretchIn, outputRange: stretchOut, extrapolate: "clamp" });

  // 硬件返回已收敛到 App.tsx 顶层单订阅统一分发（#282）：本页不再自订
  // BackHandler（旧写法无条件 return true，动画窗口期被 closeDetail 守卫拒绝后
  // 按键被静默吞掉）；onBack 仅由顶层按条件调用

  // 语音输入状态与事件订阅（钩子须在下方早退 return 之前）；默认关，设置抽屉开启
  const voiceOn = useVoiceInput();
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  // partial 只进独立的单行字幕条，不动输入框内容（避免高度跳变）
  const [voiceText, setVoiceText] = useState("");
  const voiceRef = useRef({ partial: "", final: "", resolved: false });
  useEffect(() => {
    if (!voiceOn) return;
    const sub = voice.subscribe((ev) => {
      if (ev.type === "partial") {
        voiceRef.current.partial = ev.text;
        setVoiceText(ev.text);
      } else if (ev.type === "final") {
        voiceRef.current.final = ev.text;
        voiceRef.current.resolved = true;
      } else {
        setListening(false);
        setVoiceText("");
        voice.cancel();
        // 7=NO_MATCH 6=SPEECH_TIMEOUT：安静松手不算错误；-2/-3 无服务/服务全无响应给针对性提示
        if (ev.code === -2) setVoiceHintOnce("本机无语音识别服务，可用键盘自带的语音输入");
        else if (ev.code === -3) setVoiceHintOnce("内置识别服务均无响应，可用键盘自带的语音输入");
        else if (ev.code !== 7 && ev.code !== 6) {
          const name = VOICE_ERR_NAMES[ev.code] ?? "未知";
          setVoiceHintOnce(`语音识别出错（${ev.code}·${name}），请重试`);
        }
      }
    });
    return () => sub.remove();
  }, [voiceOn]);

  // Slash 联想：/ 开头且未到参数段（无空白）时弹出。仅会话所属源走 LAN 时 fetch
  // 该源 relay /api/commands（含用户/项目自定义命令），云通道 HTTP 到不了 relay、
  // 活动源口径会误伤"活动源走云而会话源在 LAN"的组合，故按 s.src 定位源
  //（fetchSlashCommands 失败也回落内置）。钩子必须位于下方 !s 早退之前。
  const slashQuery = input.startsWith("/") && !/\s/.test(input) ? input.slice(1) : null;
  const slashMatches = slashQuery !== null ? matchSlash(slashCommands, slashQuery) : [];
  const slashSrc = s ? store.sourceInfoOf(s.src ?? snap.activeSourceId ?? "") : null;
  useEffect(() => {
    if (slashQuery === null || !s || !slashSrc || slashSrc.channel !== "lan") return;
    let dead = false;
    void fetchSlashCommands(httpBaseOf(slashSrc.wsUrl), slashSrc.token, s.cwd ?? "")
      .then((list) => { if (!dead) setSlashCommands(list); });
    return () => { dead = true; };
    // 面板开合一次拉取（slash.ts 内 60s 缓存兜频）；cwd / 会话源或其通道变化重拉
  }, [slashQuery !== null, s?.cwd, slashSrc?.wsUrl, slashSrc?.token, slashSrc?.channel]);

  if (!s) {
    return (
      <SafeAreaView style={d.safe} edges={["top"]}>
        <View style={d.head}>
          {/* W-UIFIX 件七同款：会话已消失态返回钮同改 */}
          <Pressable style={d.backPlain} onPress={onBack} hitSlop={{ left: 14, right: 8, top: 10, bottom: 10 }} accessibilityLabel="返回会话列表">
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c.text} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M15 18l-6-6 6-6" />
            </Svg>
          </Pressable>
          <Text style={d.hintText}>会话已消失</Text>
        </View>
      </SafeAreaView>
    );
  }

  const external = !!s.external;
  // 源标注（#294 批3）：聚合且多源时头部副行附源名——与列表卡源角标同口径 gating。
  // 会话对象随快照携带 src（批2 平铺盖章），timelineOf 已按 sidIndex 跨源路由（批1），
  // 本页转录/命令零改动即达正确源
  const srcName =
    snap.aggregate && snap.sources.length > 1 && s.src
      ? snap.sources.find((x) => x.id === s.src)?.name
      : undefined;
  // 元信息次行左段（源标注·无则计时顶格，不空占位）
  const srcMeta = [external ? "" : s.engine === "codex" ? "Codex" : "托管", s.historical && !external ? "历史" : "", srcName].filter(Boolean).join(" · ");
  // 上下文水位：relay 下发的当回合占用 + 按模型上限（与列表卡 mini 条、网页端同口径）
  const ctxUsed = s.context_usage ?? 0;
  const ctxLimit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const ctxPct = contextPct(ctxUsed, ctxLimit);
  // #159 方案A：ctx 百分比只在报警档亮色（60-84 黄 / ≥85 红），正常档归入 dim——
  // 与源缝成一句单色元信息后，绿色常亮反而是唯一的高噪声源
  const ctxLevel = contextLevel(ctxUsed, ctxLimit);
  // W-FB66REST ⑤（用户 1026 test.66）：head 水位彩色分层——ctxLevel 本就是水位分级
  // （<60 done / <85 working / ≥85 waiting，阈值=桌面 60/85 同款），三档直映
  // ctxSafe 绿/ctxAttention 黄/ctxCritical 红（「更多」tab 统计区 gColor 同款链）。
  // 旧版误挂会话状态三态（waiting/working 琥珀、else dim）=低水位恒灰=「现在是灰色的」根因
  const ctxTone = ctxLevel === "waiting" ? c.ctxCritical : ctxLevel === "working" ? c.ctxAttention : c.ctxSafe;
  // 历史托管会话：有 SDK 会话 id 就能 resume 复活（发消息即恢复），否则只读
  const resumable = !external && !!s.relay_session_id;
  const canCmd = snap.connected && (!s.historical || external || resumable);
  // W-PORT-B P0-1：模型切换可用门与模型清单（桌面 capsuleSupported 同口径：external
  // 或 claude 系引擎放行——relay COMMAND_MODEL 对显式他引擎拒收，错误如实回显）。
  // 清单=engine_catalog 按会话引擎取（外部会话回退 claude 清单，桌面同款）；无目录
  // （旧 relay）空清单=面板只剩自定义输入行，不冒充清单
  const modelSupported = canCmd && !s.historical && (external || !s.engine || s.engine === "claude");
  const modelList = useMemo(() => {
    const eng = external ? "claude" : s.engine || "claude";
    const src = s.src ? snap.sources.find((x) => x.id === s.src) : undefined;
    const cat = (src ?? snap.sources.find((x) => x.id === snap.activeSourceId))?.sourceCapabilities?.engine_catalog;
    return cat?.find((e) => e.id === eng)?.models ?? [];
  }, [external, s.engine, s.src, snap.sources, snap.activeSourceId]);
  const pickModel = useCallback((model: string) => {
    store.send("COMMAND_MODEL", { session_id: sid, model }, undefined, (r) => {
      if (r.ok) return; // 成功静默：relay 置 state.model + emitUpdated 权威帧归位，chip 文案即变
      store.notifyCmdError(`模型切换未生效（${r.err || "命令未确认"}）`);
    });
  }, [sid]);
  // #36 权限模式：胶囊四态（幽灵/点亮/警示）+ 面板直选，替代 subFilterRow 循环 chip
  const perm = (s.permission_mode ?? "default") as PermMode;
  // E3a 等待条去重：渲染层只认 dedupeWaitingBars 产出（同 request 只一条，键=
  // waiting_request.request_id）。当前协议单请求挂起即 0/1 条；R1 冻结后多请求
  // 列表零改渲染层
  const wr = dedupeWaitingBars([s.waiting_request])[0] ?? null;
  // 审批卡永不过期（fix/approval-timeout）：wrStale 置灰判定整段退役——passive 卡
  // （W-APPROVE #232）与 worker 托管卡一律保持可点；真失效（CLI 已越过）由 relay
  // superseded 收卡帧驱动收起，客户端不再做时间猜测
  wrRef.current = wr; // E3b 决议定向守卫同步（见 wrRef 声明处）
  // 审批横幅对称化：必须同时处于 WAITING 态（与列表卡/网页端同口径）——脱钩帧
  //（waiting_request 残留 + status 已翻走）不再渲染横幅，防"以为在等审批"的假等待。
  // W-APPROVE #232：passive 权限卡（decidable=false，CLI 本地弹窗态）放开渲染——
  // 按钮点击走同一 decide() 链（COMMAND_CONTINUE/REJECT），relay 侧按键注入应答
  // CLI 弹窗；失败 ACK error → notifyCmdError「可重点按钮重试」，横幅保留。passive
  // 提问卡（有 questions）仍不在此渲染（本地选择器兜底+晚答作答另链，保持现状）
  const bannerVisible = !!wr && s.status === "WAITING" && (wr.decidable !== false || !wr.questions?.length);
  // E3a 头部活动舱投影：activity 缺失 / native_status 能力关 → null 整舱不渲染
  const dock = dockModelOf(s);
  // 舱态配色：四态各占主题色（图标+文字同色双通道）；其余态投影已滤不为 null
  // W-EXPO 005 化（session-state-dock 口径）：running=done 绿（呼吸点）、waiting=
  // working 黄；终态（closing/suspended）由 StatusStrip 承载（ERROR 常驻 / DONE ✓
  // 尾窗收口 8s），舱内只渲染 WORKING/WAITING 两活态
  const dockColor = !dock ? "" : dock.state === "WORKING" ? c.done : dock.state === "WAITING" ? c.working : dock.state === "DONE" ? c.brandHover : c.error;

  const send = (override?: string) => {
    const text = (override ?? input).trim();
    if (!text && images.length === 0 && files.length === 0) return;
    const willQueue = external && s.status === "WAITING";
    // 件五：发送瞬间同步注入 pending 气泡（乐观回显——0.5s 内本地可见）；ack 失败
    // （4s 重发+6s 收摊后的 unconfirmed/rejected）→ 转失败态可点重发；发送即拒
    // （未连接）→ 直接失败态。回声对账在渲染层 effect（reconcilePending）
    const echoKey = `pe-${Date.now().toString(36)}-${(echoSeq.current += 1)}`;
    const echoText = text || (images.length ? `[图片 ×${images.length}]` : `[文件 ×${files.length}]`);
    // #54/#62 外部会话同口径带附件：relay 落盘临时目录 + 注入「正文 + 路径指令」，
    // CLI 用 Read 看图/处理文件；托管会话图片走 SDK image blocks、文件走路径指令
    const ok = store.send(
      external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE",
      {
        session_id: sid, text,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
      undefined,
      (r) => {
        if (!r.ok) setPendingEcho((prev) => markEchoState(prev, echoKey, "failed"));
        // W-MSGUI 件一（#159 同族云桥版）：ack ok 即消气泡——relay 已受理=气泡使命
        // 完成（转录行由 SESSION_LOG 回声到达自然插入；回声对账 reconcile 保留，
        // 双路径消=no-op 幂等）。云桥下行 route miss 循环时（生产实锤：ph-* 推送
        // miss→resume 再 miss），回声/ACK 帧闷死在桥侧，旧逻辑「sending 挂到 120s
        // 安全阀」观感即「发送中滞留」——ACK 是唯一必达回执（命令通道原路回），
        // 以它为准收口。
        else setPendingEcho((prev) => prev.filter((p) => p.key !== echoKey));
      },
    );
    setPendingEcho((prev) =>
      pushPending(prev, { key: echoKey, sid, text: echoText, ts: Date.now(), state: ok ? "sending" : "failed" }),
    );
    if (ok) {
      editInput("");
      setImages([]);
      setFiles([]);
      if (willQueue) flashQueuedHint();
    }
  };

  // 件五失败重发：移除失败气泡 + 文本重发（附件不缓存重发——占位文案不进重发链）
  const retryEcho = (p: PendingEcho) => {
    setPendingEcho((prev) => prev.filter((x) => x.key !== p.key));
    if (p.text && !/^\[(图片|文件) ×\d+\]$/.test(p.text)) send(p.text);
  };

  // 语音输入：按住说话，partial 实时上字幕条，松手 stopListening 等 final 发送（超时兜底用 partial）
  const setVoiceHintOnce = (t: string) => {
    setVoiceHint(t);
    setTimeout(() => setVoiceHint(null), 3500);
  };
  // #62 通用短提示（附件选择超限等），与语音提示同一条展示位
  const hintOnce = setVoiceHintOnce;
  const startVoice = async () => {
    if (listening || !canCmd) return;
    try {
      const res = await PermissionsAndroid.request("android.permission.RECORD_AUDIO");
      if (res !== PermissionsAndroid.RESULTS.GRANTED) {
        setVoiceHintOnce("需要麦克风权限才能语音输入");
        return;
      }
    } catch {
      setVoiceHintOnce("无法申请麦克风权限");
      return;
    }
    if (!(await voice.available())) {
      setVoiceHintOnce("本机无语音识别服务，可用键盘自带的语音输入");
      return;
    }
    voiceRef.current = { partial: "", final: "", resolved: false };
    setVoiceText("");
    voice.start();
    setListening(true);
  };
  const endVoice = () => {
    if (!listening) return;
    setListening(false);
    voice.stop();
    const t0 = Date.now();
    const waitFinal = () => {
      const v = voiceRef.current;
      if (v.resolved) {
        const text = (v.final || v.partial).trim();
        if (text) send(text);
        else setVoiceHintOnce("没听到内容，请再试一次");
        return;
      }
      if (Date.now() - t0 > 1500) {
        voice.cancel();
        const text = v.partial.trim();
        if (text) send(text);
        else setVoiceHintOnce("没听到内容，请再试一次");
      } else {
        setTimeout(waitFinal, 60);
      }
    };
    waitFinal();
  };

  // 相册选图 → 统一转 JPEG/长边≤1568（base64 上送）
  const pickImages = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: 4,
        quality: 0.85,
        base64: true,
      });
      if (res.canceled) return;
      const out: string[] = [];
      for (const asset of res.assets) {
        const long = Math.max(asset.width, asset.height);
        const scale = long > 1568 ? 1568 / long : 1;
        if (scale < 1 || !asset.base64 || !asset.mimeType || asset.mimeType !== "image/jpeg") {
          const m = await ImageManipulator.manipulateAsync(
            asset.uri,
            scale < 1 ? [{ resize: { width: Math.round(asset.width * scale), height: Math.round(asset.height * scale) } }] : [],
            { format: ImageManipulator.SaveFormat.JPEG, compress: 0.82, base64: true },
          );
          if (m.base64) out.push(m.base64);
        } else if (asset.base64) {
          out.push(asset.base64);
        }
      }
      if (out.length > 0) setImages((prev) => [...prev, ...out].slice(0, 4));
    } catch {
      // 用户取消/读取失败：静默
    } finally {
      setPicking(false);
    }
  };

  // #62 文件选择：SAF picker 任意类型多选，读 base64 上送。上限 20MB/个（2026-09-19
  // 用户主力机实测 4.5MB 拦下常规文件后放宽；relay sanitize 28MB b64 兜底）。
  // 超限与读取失败分开提示且带文件名/实际大小——短提示消失后 chip 不在，用户要能
  // 知道为什么没加上
  const pickFiles = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
      if (res.canceled) return;
      const out: { name: string; b64: string }[] = [];
      const oversize: string[] = [];
      const unreadable: string[] = [];
      let readErr = "";
      for (const a of res.assets) {
        if (a.size != null && a.size > 20 * 1024 * 1024) {
          oversize.push(`${(a.size / 1048576).toFixed(0)}MB ${a.name || ""}`.trim());
          continue;
        }
        try {
          const b64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
          // 空读（provider 异常/拷贝失败 0 字节）也别静默上送——relay 会剔除空 b64，
          // 用户侧表现就是"带了文件却没落盘"
          if (!b64) throw new Error("读到 0 字节");
          out.push({ name: a.name || "文件", b64 });
        } catch (err) {
          unreadable.push(a.name || "文件");
          if (!readErr) readErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (oversize.length > 0) hintOnce(`${oversize.join("、")} 超过 20MB，未添加`);
      if (unreadable.length > 0) hintOnce(`${unreadable.join("、")} 读取失败${readErr ? "：" + readErr.slice(0, 60) : ""}`);
      const room = 2 - files.length;
      if (out.length > room) hintOnce("最多同时带 2 个文件");
      if (out.length > 0 && room > 0) setFiles((prev) => [...prev, ...out].slice(0, 2));
    } catch {
      // 用户取消/读取失败：静默
    } finally {
      setPicking(false);
    }
  };
  const decide = (allow: boolean, rememberScope?: "session" | "global") => {
    if (!wr) return;
    const rid = wr.request_id;
    // E3b 审批真链路：ACK ok 才翻本地态——本地零预清（等待条由 SESSION_UPDATED/
    // SESSION_WAITING 权威帧收敛，relay 执行后同步推帧）；失败回退=等待条保留 +
    // 全局错误 toast（notifyCmdError 走 App toast 通道）。request_id 定向：晚到失败
    // 只在同一请求仍挂起时提示（decisionStillPending 守卫）。不重试风暴：沿用全局
    // ACK 纪律（4s 重发一次、6s 收摊回调），重试=用户重点按钮；send false 路径
    //（未连接/会话不存在）已有全局 toast，不叠报
    // #212 remember_scope：allow 的同时落「允许并记住」规则（relay 侧判定危险形态不落）
    store.send(allow ? "COMMAND_CONTINUE" : "COMMAND_REJECT", {
      session_id: sid, request_id: rid,
      ...(allow && rememberScope ? { remember_scope: rememberScope } : {}),
    }, undefined, (r) => {
      if (r.ok) return;
      if (!decisionStillPending(wrRef.current, rid)) return;
      store.notifyCmdError(`决议未生效（${r.err || "命令未确认"}），等待条保留，可重点按钮重试`);
    });
    setRmOpen(false);
  };
  // #212 允许并记住：范围确认条展开态。按 request_id 复位——换请求/审批收口
  //（waiting_request 清空）自动回主按钮组，不残留上一次的展开
  const [rmOpen, setRmOpen] = useState(false);
  useEffect(() => { setRmOpen(false); }, [wr?.request_id]);

  return (
    <SafeAreaView style={d.safe} edges={["top"]}>
      {/* #108 键盘让位从「整面板上移」改为「收缩式」：#68③ 的 translateY 把 head+tab
          一起顶出屏（用户反馈完全被挤没）。edge-to-edge 下窗口不 resize，root 直接
          paddingBottom = kb 让 flex 布局只压缩 flex:1 的翻页列表区——head/状态条/tab 行
          位置稳定，列表收缩、输入栏贴键盘顶；贴底视图由转录 ScrollView 的 onLayout 兜底
          拉回底部（视口收缩旧 transform 方案没有的问题）。沿用 2026-09-16 调定的
          -2px 藏缝余量（键盘压住输入栏底 2px 不露缝） */}
      <View style={{ flex: 1, paddingBottom: kb > 0 ? kb - 2 : 0 }}>
      {/* 头部（用户 22:14/22:20 拍板口径，#155 收敛，#159 方案A再收敛）：R1 = ‹ + 标题主角；
          R2 = 元信息行——源·ctx 缝成一句单色元信息（·分隔，全 dim 10px 一档字号；ctx 百分比
          仅报警档亮色），设置簇右锚（原时长已删：消息时间戳已提供时间感，统计区保留耗时全量）。
          可点元素统一圆角 8/tintSoft 底无边框；#164 红线：标题可用宽度不动 */}
      <View style={d.head}>
        {/* W-UIFIX 件七：去 tintSoft 方块底，纯 chevron 放大到微信式 24px；触区 40 宽 */}
        <Pressable style={d.backPlain} onPress={onBack} hitSlop={{ left: 14, right: 8, top: 10, bottom: 10 }} accessibilityLabel="返回会话列表">
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c.text} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M15 18l-6-6 6-6" />
          </Svg>
        </Pressable>
        {/* #239 W-DETAILAVATAR：详情 head 头像品牌化——列表卡 AvaBadge 同款品牌图标。
            W-FB66REST ③（用户 1026 test.66）：「色块+问号」根修——engine/model 双缺时
            旧版落 EngineIcon 灰块+「?」字母占位。对齐列表卡完整口径：①PM/Leader 且
            claude 档（双缺视同 claude）=角色蟹（PM 举旗蟹/Leader 皇冠蟹，列表卡
            roleCrab 同判定）；②普通会话双缺兜底 claude 像素蟹（列表卡「engine 缺失
            视同 claude」同语义）；已知引擎品牌图标不变 */}
        {headRoleKind && (inferEngine(s.engine, s.model) ?? "claude") === "claude" ? (
          <Image
            source={headRoleKind === "leader" ? require("../assets/engines/crab-leader.png") : require("../assets/engines/crab-pm.png")}
            style={{ width: 18, height: 18 }}
          />
        ) : (
          <EngineIcon engine={inferEngine(s.engine, s.model) ?? "claude"} size={18} />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* W-UIFIX 件二：水位计挪标题行右端+整体调小一号——副题行还给元信息文字
              （目录/活跃时间不再被挤截断）；标题 flexShrink 保省略，水位 flexShrink:0 右锚 */}
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={[d.title, { flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="tail">{s.title || "未命名会话"}</Text>
            {ctxUsed > 0 ? (
              <View style={[d.headCtx, { marginLeft: "auto" }]}>
                <CtxSegMeter pct={ctxPct} tone={ctxTone} small />
                <Text style={[d.headCtxPct, { color: ctxTone }]}>{ctxPct}%</Text>
              </View>
            ) : null}
          </View>
          <View style={d.headMeta}>
            {/* A4-4 查漏（桌面件十六信息行序）：目录→水位→活跃时间。#159 方案A 的
                「一行一档字号一种形态」保持；W-LIST2 件二②③：水位从纯文本百分比升级
                颗粒水位计（20 格分段形制，正常 dim/60-84 黄/≥85 红）——颗粒承形、数字
                承精确值；目录=尾两段缩短（全长在「更多」tab 统计区） */}
            {srcMeta || s.cwd || ctxUsed > 0 ? (
              <>
                <Text style={[d.sub, { flexShrink: 1 }]} numberOfLines={1}>
                  {srcMeta}
                  {srcMeta && (s.cwd || ctxUsed > 0) ? " · " : ""}
                  {s.cwd ? `${s.cwd.replace(/[\\/]/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/")}` : ""}
                  {s.cwd && ctxUsed > 0 ? " · " : ""}
                </Text>
                <Text style={[d.sub, { flexShrink: 0 }]}>{" · "}{fmtLastActive(s.updated_at || s.started_at)}</Text>
              </>
            ) : null}
            {/* #36 设置簇（右锚）：权限胶囊 + 思考开关成组——同为会话级 14px 小胶囊，
                形态语言一致。权限胶囊是"状态灯"：标准=幽灵盾标（低噪声保锚点）、
                自动/规划=品牌蓝点亮+两字短标签、跳过=waiting 红警示+盾内感叹号
                （危险档必须 ambient 常显视口顶——读转录/切 tab 都看得见） */}
            <View style={d.permCluster}>
              {/* W-PORT-B P0-1：模型切换 chip（R2 元信息行右锚，权限胶囊旁）——中性幽灵
                  形态（模型是低频操作，视觉弱于权限状态灯）；文案=当前模型尾段或「默认模型」 */}
              {modelSupported ? (
                <Pressable
                  style={d.modelChip}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                  onPress={() => setModelSheet(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  accessibilityLabel={`模型 ${s.model || "默认模型"}，点按切换（下一回合生效）`}
                >
                  <Text style={d.modelChipT} numberOfLines={1}>
                    {s.model ? String(s.model).split(/[/:]/).pop() : "默认模型"}
                  </Text>
                </Pressable>
              ) : null}
              {/* #218 追加件：托管权限胶囊整颗退役（Leader 裁决 R1——用户指的「审批开关」
                  即这颗 bypassPermissions 循环切换胶囊；权限模式入口不挂 head，创建时勾选/
                  桌面端设置即可，P81 语义下无需常驻切换）。head 设置簇只留模型 chip+思考开关 */}
              {/* #218 追加件：外部只读胶囊（#191）同步退役——head 权限标识整族清（状态走
                  状态条/横幅与「更多」tab 统计区，relay permission_mode 数据面不动） */}
              {/* #218 件一：远程审批开关退役（用户点名 head 只留状态；审批横幅/状态条承载不变，
                  relay COMMAND_EXT_MODE 命令面与 SESSION_UPDATED remote_mode 数据面不动；
                  桌面对齐：W-COMPOSER ⑤ 同批已移桌面开关）。思考开关紧随模型 chip（共享
                  thinkToggle 形态不动） */}
              <Pressable
                style={[d.thinkToggle, showThink && d.thinkToggleOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                onPress={() => { thinkShown = !thinkShown; setShowThink(thinkShown); }}
                hitSlop={6}
                accessibilityLabel={showThink ? "思考过程显示，已开" : "思考过程显示，已关"}
              >
                <Text style={[d.thinkToggleT, showThink && d.thinkToggleTOn]}>思考</Text>
              </Pressable>
            </View>
          </View>
          {/* W-EXPOLISH 件四：头部活动舱已迁输入区上沿（单行制，见底部栈 dockLine）——
              header 只留标题+元信息+权限胶囊 */}
        </View>
      </View>

      {/* 固定工具区：状态条 + 过滤 chips。不放进 ScrollView——RN Android 吸顶头有触点丢失问题，
          且运行中自动滚底的跳变会打断按压；固定区根本不经过滚动手势系统。头部 ▴/▾ 可整体折叠 */}
      {!collapsed ? (
      <View style={d.fixedBar}>
        {/* E3a：状态/收口条收编 StatusStrip——ERROR ⚠ 常驻 / DONE ✓ 尾窗收口 / WAITING
            兜底行；投影与显隐判定内聚组件内（含尾窗自隐计时），WORKING 状态行仍居
            对话流（类 CLI），顶栏只留「需要注意」的态 */}
        <StatusStrip s={s} wr={wr} bannerVisible={bannerVisible} />
          {/* tab 行：模型 chip 已挪头部副信息行（#391 返工）；tabWrap 自测宽供指示条几何 */}
          <View style={d.filterRow}>
            <View style={d.tabWrap} onLayout={(e) => setTabRowW(e.nativeEvent.layout.width)}>
              {VS.map((v, i) => (
                <Pressable
                  key={v.k}
                  style={d.tabBtn}
                  onPress={() => gotoView(i)}
                  hitSlop={{ top: 6, bottom: 2 }}
                >
                  <Text style={[d.tabT, view === v.k && d.tabTOn]}>{v.label}</Text>
                </Pressable>
              ))}
              <Animated.View style={[d.tabInd, { width: tabW, transform: [{ translateX: indX }, { scaleX: indS }] }]} />
            </View>
          </View>
      </View>
      ) : null}

      {/* 六视图横向翻页（#250/#252）：面板上左右滑动切换，懒渲染相邻 ±1 页（远跳飞行中临时全渲染）；
          滚动位置原生驱动 tab 指示条逐像素跟手。任务视图：整屏列表（网页端"任务" tab 同构）。
          外包一层作回到底部浮钮的定位锚（吸顶于对话区顶部，不随头部高度变化） */}
      <View style={{ flex: 1 }}>
      <ScrollView
        ref={pagerRef}
        style={{ flex: 1 }}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          // bridgeless 下 Animated.event+useNativeDriver 会闪退（0.2.26，同任务面板滑块结论），
          // 退回 JS setValue：throttle 16 逐帧事件流，指示条仍跟手
          scrollX.setValue(e.nativeEvent.contentOffset.x);
          if (progJump.current) return;
          // 越过中线即换高亮（不等落定）：滑到一半停住时 label 与页面一致停在中间态
          const i = Math.round(e.nativeEvent.contentOffset.x / pagerW);
          if (i >= 0 && i < VS.length && VS[i].k !== view) setView(VS[i].k);
        }}
        onMomentumScrollEnd={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.x / pagerW);
          if (i >= 0 && i < VS.length && VS[i].k !== view) setView(VS[i].k);
          progJump.current = false;
          setFlight(false);
        }}
      >
      {VS.map((v, vi) => (
        <View key={v.k} style={{ width: pagerW }}>
        {Math.abs(vi - viewIdx) <= 1 || flight ? (v.k === "todos" ? (
        <View style={d.viewCol}>
          <View style={d.todoHead}>
            <Text style={d.todoHeadT}>☰ 任务 {doneList.length}/{sortedTodos.length}</Text>
            <View style={d.todoBar}>
              <View style={[d.todoBarFill, { width: `${Math.round((doneList.length / Math.max(1, sortedTodos.length)) * 100)}%` }]} />
            </View>
            <Pressable
              style={d.todoRefresh}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
              onPress={refreshTodos}
            >
              <Text style={[d.todoRefreshT, todoSpin && { color: c.brandA }]}>↻</Text>
            </Pressable>
          </View>
          {sortedTodos.length === 0 ? (
            // 空态垂直居中：父容器 viewCol(flex:1) 里头部之下剩余区域由文本撑满，
            // textAlignVertical 让文字在盒内垂直居中（paddingVertical 对称不偏移）
            // #49：空态文案不暴露内部机制，只留一句话
            <Text style={[d.empty, { flex: 1, textAlignVertical: "center" }]}>暂无任务清单</Text>
          ) : (
          <View style={d.todoScrollWrap}>
            <ScrollView
              ref={todoScrollRef}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 14 }}
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={16}
              nestedScrollEnabled
              onTouchStart={todoTouchStart}
              onTouchEnd={todoTouchEnd}
              onTouchCancel={() => { todoTouch.current = null; }}
              onScrollBeginDrag={() => { todoFootArmed.current = true; }}
              onScrollEndDrag={() => { if (todoAtBottom.current) todoFootRefresh(); }}
              onMomentumScrollEnd={() => { if (todoAtBottom.current) todoFootRefresh(); }}
              refreshControl={
                <RefreshControl
                  refreshing={todoSpin}
                  onRefresh={refreshTodos}
                  tintColor={c.working}
                  colors={[c.working]}
                  progressBackgroundColor={c.panel}
                />
              }
              onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                // bridgeless 下 Animated.event+useNativeDriver 不可用（0.2.26 闪退），
                // 退回 JS setValue：throttle 16 保证 60fps 事件流，thumb 仍逐帧跟手
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                todoAtBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
                todoScrollY.setValue(contentOffset.y);
              }}
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                setTodoMetrics((m) => (h !== m.layout ? { ...m, layout: h } : m));
              }}
              onContentSizeChange={(_w, h) => {
                setTodoMetrics((m) => (h !== m.content ? { ...m, content: h } : m));
                if (todoAtBottom.current) todoScrollRef.current?.scrollToEnd({ animated: false });
              }}
            >
              {sortedTodos.map((t, i) => {
                const grpOf = (x: TodoItem) => (isVerifyTodo(x) ? "verify" : x.status);
                const g = todoGroups.find((x) => x.status === grpOf(t))!;
                const head = i === 0 || grpOf(sortedTodos[i - 1]) !== grpOf(t) ? g : null;
                return (
                  /* #39b 拖动丝滑：key 索引→稳定 key——重排时 React 按内容对齐行、
                     不再整列重建闪烁（拖动跟手的前提） */
                  <Fragment key={pendKeyOf(t)}>
                    {head ? (
                      <View style={d.todoSec}>
                        <View style={d.todoSecLine} />
                        <Text
                          style={[
                            d.todoSecT,
                            t.status === "completed" && { color: c.done },
                            isVerifyTodo(t) && { color: "#5B9DFF" },
                            t.status === "in_progress" && { color: c.working },
                            t.status === "pending" && { color: c.faint },
                          ]}
                        >
                          {head.label}
                        </Text>
                        <View style={d.todoSecLine} />
                      </View>
                    ) : null}
                    {renderTodo(t, i, !!head)}
                  </Fragment>
                );
              })}
              <Pressable style={d.todoFootHint} disabled={todoSpin} onPress={refreshTodos} hitSlop={{ top: 10, bottom: 16 }}>
                <Text style={d.todoFootHintT}>{todoSpin ? "刷新中…" : "↻ 上滑更新 · 条目左滑移除"}</Text>
              </Pressable>
            </ScrollView>
            {/* 常驻自绘滑块：系统 scrollbar 在两端都不可见（VM/API28、真机/API16 实测） */}
            {todoMetrics.content > todoMetrics.layout + 8 ? (
              <Animated.View
                style={[
                  d.todoThumb,
                  {
                    height: todoThumbH,
                    transform: [
                      {
                        translateY: todoScrollY.interpolate({
                          inputRange: [0, todoTravel],
                          outputRange: [0, thumbTravel],
                          extrapolate: "clamp",
                        }),
                      },
                    ],
                  },
                ]}
              />
            ) : null}
          </View>
          )}
        </View>
      ) : v.k === "arts" ? (
        /* #35 输出物视图（网页端第 6 tab 同构）。#222 起支持文件夹颗粒度：同父目录
           ≥2 个文件聚成可折叠文件夹行（最近活跃的默认展开、其余折叠，点按开合有记忆），
           文件夹与散文件按时间降序混排——最新交付永远在顶；存在文件夹时「新建/修改」
           两组头降级为行内徽标，纯散文件会话保持两组头不变。行首扩展名 chip 按类型着色；
           手机端打不开电脑文件——点行弹详情 sheet（复制/分享/拉取预览） */
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 + insets.bottom, ...((s.artifacts?.length ?? 0) === 0 ? { flexGrow: 1, justifyContent: "center", paddingBottom: 14 + insets.bottom } : null) }} showsVerticalScrollIndicator={false}>
          {(s.artifacts?.length ?? 0) === 0 ? (
            /* #49：空态文案不暴露内部机制（原三分提示句移除），只留一句话（与网页端同口径）；
               #51：收录口径收窄为文档类交付物，空态措辞同步 */
            <>
              <Text style={d.empty}>当前会话还没有文档产出</Text>
              {poolOpenable && onOpenArtPool ? (
                /* #72 E 线 入口②（详情可达）：会话产物空 ≠ 池空——全局目录里可能有别的
                   会话/项目交付的文件（web W 线详情列第四态同语义镜像） */
                <Pressable hitSlop={6} onPress={onOpenArtPool} accessibilityLabel="查看全局输出物目录">
                  <Text style={[d.artFoot, { color: c.brandA, paddingVertical: 8, fontSize: 12, fontWeight: "600" }]}>查看全局输出物目录 ›</Text>
                </Pressable>
              ) : null}
            </>
          ) : (() => {
            const arts = s.artifacts!;
            const byRec = (a: ArtifactItem, b: ArtifactItem) => (b.last_at || b.first_at || 0) - (a.last_at || a.first_at || 0);
            const created = arts.filter((t) => t.op === "create").sort(byRec);
            const edited = arts.filter((t) => t.op !== "create").sort(byRec);
            const KC: Record<ArtKind, string> = { code: c.brandA, doc: c.done, data: c.working, img: c.waiting, zip: c.dim, gen: c.faint };
            // E3a 分组投影统一走 artifactRowsOf：B4a group_key/directory_label 优先
            //（不透明 id 分桶、relay 展示名、单文件组照组渲染），旧 relay 无 B4a 字段
            // 回退 #222 父目录口径（同键 ≥2 才聚合、单文件目录与根散件保持散行）；
            // existence 三态在此归一，行渲染按 openable 收打开按钮
            const rows = artifactRowsOf(arts, (t) => artDirOf(s, t));
            const folders = new Map<string, { key: string; dir: string; leaf: string; files: ArtifactItem[]; at: number; size: number }>();
            for (const r of rows) {
              if (r.kind === "group") {
                folders.set(r.group.key, { key: r.group.key, dir: r.group.label, leaf: r.group.leaf, files: r.group.files.map((f) => f.item), at: r.at, size: r.group.size });
              }
            }
            // 默认开合：最近活跃（组内最新时间最大）的文件夹展开、其余折叠；
            // 用户点过的以 artFold 显式记录优先
            let newestKey = "";
            let newestAt = -1;
            for (const g of folders.values()) if (g.at > newestAt) { newestAt = g.at; newestKey = g.key; }
            const folOpen = (k: string) => artFold[sid + "|" + k] ?? k === newestKey;
            // 混排：artifactRowsOf 已按 at 降序（组 at=组内最新、散件按各自时间），
            // 此处只换渲染形（文件夹行 / 散文件行同列竞争）
            const items = rows.map((r) =>
              r.kind === "group"
                ? { kind: "folder" as const, g: folders.get(r.group.key)! }
                : { kind: "file" as const, t: r.art.item },
            );
            const artRow = (t: ArtifactItem, i: number, opts?: { sub?: boolean; badge?: boolean }) => {
              const rel = artRelOf(s, t);
              const name = (rel || t.path).split(/[\\/]/).pop() || t.path;
              // 子行（文件夹展开列内）去目录前缀——目录信息由文件夹头行承载
              const dir = opts?.sub
                ? ""
                : rel
                  ? (rel.includes("/") || rel.includes("\\") ? rel.slice(0, Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1) : "")
                  : t.path.slice(0, t.path.length - name.length);
              // E3a existence 三态：missing 沿用「已删除」红标（sheet 内定格 CTA 仍可开）；
              // unknown=B4a 显式「状态未知」中性标且不给打开按钮（Pressable disabled +
              // 无 onPress，旧 relay 数据不猜 unknown 零回归）
              const existence = artExistenceOf(t);
              const dead = existence === "missing";
              const unknown = existence === "unknown";
              const outside = !rel && t.origin !== "cwd";
              const kc = KC[artKindOf(name)];
              return (
                <Pressable
                  key={t.path + "|" + i}
                  style={[d.cronRow, opts?.sub ? { borderTopWidth: 0, marginTop: 0, paddingVertical: 4 } : i === 0 ? { borderTopWidth: 0, marginTop: 0 } : null]}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  disabled={unknown}
                  onPress={unknown ? undefined : () => setArtPop(t)}
                  accessibilityLabel={unknown ? `输出物 ${name}，状态未知，不可打开` : `输出物 ${name}，点按查看路径详情`}
                >
                  <View style={[d.artChip, { borderColor: withA(kc, 0.45) }]}>
                    <Text style={[d.artChipT, { color: kc }]}>{artExtOf(name)}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={d.artNameRow}>
                      <Text style={[d.cronName, (dead || unknown) && { color: c.dim }]} numberOfLines={1}>{name}</Text>
                      {opts?.badge ? (
                        <Text style={[d.artTag, t.op === "create" ? { color: c.done } : { color: c.dim }]}>{t.op === "create" ? "新建" : "修改"}</Text>
                      ) : null}
                      {dead ? <Text style={[d.artTag, { color: c.error }]}>已删除</Text> : null}
                      {unknown ? <Text style={[d.artTag, { color: c.faint }]}>状态未知</Text> : null}
                      {outside ? <Text style={[d.artTag, { color: c.working }]}>cwd 外</Text> : null}
                    </View>
                    <Text style={d.cronMeta} numberOfLines={1}>
                      {/* 2026-09-21 用户：移除行变更 +N −N（交付物口径，与网页端同改） */}
                      {dir ? dir + " · " : ""}{fmtArtSize(t.size) ? fmtArtSize(t.size) + " · " : ""}{fmtArtTime(t.last_at || t.first_at)}
                    </Text>
                  </View>
                </Pressable>
              );
            };
            const artFolder = (g: { key: string; dir: string; leaf: string; files: ArtifactItem[]; at: number; size: number }, idx: number) => {
              const open = folOpen(g.key);
              return (
                <View key={"fol|" + g.key}>
                  <Pressable
                    style={[d.cronRow, idx === 0 && { borderTopWidth: 0, marginTop: 0 }, d.artFolRow]}
                    android_ripple={{ color: c.tintSoft, borderless: false }}
                    onPress={() => setArtFold((m) => ({ ...m, [sid + "|" + g.key]: !open }))}
                    accessibilityLabel={`文件夹 ${g.leaf}，${g.files.length} 个文件，点按${open ? "折叠" : "展开"}`}
                  >
                    <View style={[d.artChip, { borderColor: withA(c.brandB, 0.45) }]}>
                      <Svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={c.brandB} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <Path d="M3.5 7.2c0-1.3 1-2.3 2.3-2.3h3l2 2.2h6.4c1.3 0 2.3 1 2.3 2.3v7.3c0 1.3-1 2.3-2.3 2.3H5.8c-1.3 0-2.3-1-2.3-2.3z" />
                      </Svg>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={d.artNameRow}>
                        <Text style={[d.cronName, d.artFolName]} numberOfLines={1}>{g.leaf}</Text>
                        <Text style={[d.artTag, { color: c.brandB, borderColor: withA(c.brandB, 0.4) }]}>×{g.files.length}</Text>
                      </View>
                      <Text style={d.cronMeta} numberOfLines={1}>
                        {/* 用户反馈：不堆「N 新建 · M 修改」摘要——几个文件、哪个任务的
                            目录一目了然即可，op 细节看子行徽标 */}
                        {[g.dir, g.size > 0 ? fmtArtSize(g.size) : "", fmtArtTime(g.at)].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    {/* #222 行尾统一 ⋯（2026-10-02 用户拍板，两端同口径）：chevron 换
                        三点菜单钮弹文件夹 sheet（展开/收起 + 复制目录路径）；内层
                        Pressable 优先接管触点，点它不会触发行级折叠切换 */}
                    <Pressable
                      hitSlop={8}
                      onPress={() => setFolPop({ key: g.key, dir: g.dir, leaf: g.leaf, count: g.files.length, size: g.size, at: g.at, open })}
                      accessibilityLabel={`文件夹 ${g.leaf} 操作`}
                    >
                      <Text style={d.artDots}>⋯</Text>
                    </Pressable>
                  </Pressable>
                  {open ? (
                    <View style={d.artKids}>
                      {g.files.map((t, i) => artRow(t, i, { sub: true, badge: true }))}
                    </View>
                  ) : null}
                </View>
              );
            };
            return (
              <>
                <View style={d.artSum}>
                  {/* 2026-09-21 用户：移除「新建 N · 修改 N / +N −N」统计（#222 聚合形态下
                      两组头降级为行内徽标，计数由文件夹行「×N · N 新建」承载） */}
                  <Text style={d.artSumN}>{arts.length} 个文件{folders.size ? ` · ${folders.size} 个文件夹` : ""}</Text>
                </View>
                {s.artifacts_truncated ? <Text style={d.artTrunc}>已截断 · 保留最新 200 条</Text> : null}
                {folders.size ? (
                  /* #222 聚合形态：文件夹与散文件混排，「新建/修改」两组头消失 */
                  items.map((it, idx) => (it.kind === "folder" ? artFolder(it.g, idx) : artRow(it.t, idx, { badge: true })))
                ) : (
                  <>
                    {created.length ? <Text style={[d.artGt, { color: c.done }]}>新建 {created.length} · 本会话产出</Text> : null}
                    {created.map((t, i) => artRow(t, i))}
                    {edited.length ? <Text style={[d.artGt, { color: c.dim }]}>修改 {edited.length}</Text> : null}
                    {edited.map((t, i) => artRow(t, i))}
                  </>
                )}
                {/* #49：底部说明去掉"仅收录 Write/Edit…"工具清单（机制不外露）；
                    #51：补收录口径（文档类交付物），与网页端同句 */}
                <Text style={d.artFoot}>仅收录文档、表格等交付物 · 点文件可拉取到手机预览</Text>
                {poolOpenable && onOpenArtPool ? (
                  /* #72 E 线 入口②（详情可达）：会话账只记本会话交付，全局目录（产物池）
                     补全机扫描视图——web W 线详情列第四态同语义镜像 */
                  <Pressable hitSlop={6} onPress={onOpenArtPool} accessibilityLabel="查看全局输出物目录">
                    <Text style={[d.artFoot, { color: c.brandA, paddingVertical: 8, fontSize: 12, fontWeight: "600" }]}>查看全局输出物目录 ›</Text>
                  </Pressable>
                ) : null}
              </>
            );
          })()}
        </ScrollView>
      ) : v.k === "more" ? (
        /* 「更多」（W-EXPO 005 化，对齐 index-005 renderMore/mMoreHtml 信息架构）：
           水位计（12 段 band + 分级胶囊）+ 统计键值行（本回合/会话信息/用量统计/
           标识）+ 定时任务收编。军规②③：行级无常驻分隔线，分组只靠间距+小节标题 */
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 + insets.bottom }} showsVerticalScrollIndicator={false}>
          {(() => {
            const used = s.context_usage ?? 0;
            const limit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
            const pct = used > 0 ? contextPct(used, limit) : 0;
            const lv = contextLevel(used, limit);
            const grade = lv === "done" ? "安全" : lv === "working" ? "注意" : "紧张";
            const gColor = lv === "done" ? c.ctxSafe : lv === "working" ? c.ctxAttention : c.ctxCritical;
            const gFill = lv === "done" ? c.ctxSafeFill : lv === "working" ? c.ctxAttentionFill : c.ctxCriticalFill;
            const on = Math.round((pct / 100) * 12);
            const u = s.usage;
            const turnRun = s.status === "WORKING" && isRealWorking(s) && s.turn_started_at ? fmtElapsed(Math.max(0, Date.now() - s.turn_started_at)) : null; /* #291：待命不走秒 */
            const turnTok = u && (u.input_tokens || u.output_tokens) ? fmtTok((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) : null;
            return (
              <View>
                {/* 水位计（context-meter）：kicker+模型+分级胶囊 / 12 段 band / 用量+百分比 */}
                <View style={d.meterWrap}>
                  <View style={d.meterHead}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={d.meterKicker}>CONTEXT WINDOW</Text>
                      <Text style={d.meterModel} numberOfLines={1}>{s.model || "默认模型"} · {fmtTok(limit)} 上限</Text>
                    </View>
                    <View style={[d.meterGrade, { borderColor: withA(gColor, 0.42), backgroundColor: withA(gColor, 0.12) }]}>
                      <Text style={[d.meterGradeT, { color: gColor }]}>{grade}</Text>
                    </View>
                  </View>
                  <View style={d.meterBand}>
                    {Array.from({ length: 12 }, (_, i) => (
                      <View key={i} style={[d.meterCell, i < on ? { backgroundColor: gFill } : null]} />
                    ))}
                  </View>
                  <View style={d.meterStats}>
                    <Text style={d.meterStatsL} numberOfLines={1}>
                      <Text style={d.meterUsed}>{used > 0 ? fmtTok(used) : "—"}</Text>
                      <Text style={d.meterLimit}> / {fmtTok(limit)} tokens</Text>
                    </Text>
                    <Text style={[d.meterPct, { color: gColor }]}>{used > 0 ? `${pct}%` : "--"}</Text>
                  </View>
                </View>

                {turnRun || turnTok ? (
                  <View style={d.moreSec}>
                    <Text style={d.moreSecT}>本回合</Text>
                    {turnRun ? <StatRow k="已运行" v={turnRun} /> : null}
                    {turnTok ? <StatRow k={`tokens（入 ${fmtTok(u!.input_tokens ?? 0)} · 出 ${fmtTok(u!.output_tokens ?? 0)}）`} v={turnTok} /> : null}
                  </View>
                ) : null}

                <View style={d.moreSec}>
                  <Text style={d.moreSecT}>会话信息</Text>
                  <StatRow k="状态" v={STATUS_ZH[s.status] ?? s.status} />
                  <StatRow k="目录" v={s.cwd || "—"} />
                  <StatRow k="模型" v={s.model || "—"} />
                  <StatRow k="权限模式" v={(PERM_MODE_ZH as Record<string, string>)[s.permission_mode ?? "default"] ?? "—"} />
                  <StatRow k="开始时间" v={fmtClock(s.started_at)} />
                  <StatRow k="用时" v={fmtElapsed(sessionElapsed(s))} />
                  {s.historical ? <StatRow k="来源" v={s.external ? "外部 CLI" : "历史会话"} /> : null}
                </View>

                <View style={d.moreSec}>
                  <Text style={d.moreSecT}>用量统计</Text>
                  <StatRow k="修改文件" v={String(s.stats?.files_changed ?? 0)} />
                  <StatRow k="增删行数" v={`+${s.stats?.lines_added ?? 0} / −${s.stats?.lines_deleted ?? 0}`} />
                  {s.todos?.length ? (
                    <StatRow k="任务清单" v={`${s.todos.filter((t) => t.status === "completed").length}/${s.todos.length}`} />
                  ) : null}
                  <StatRow k="输入 / 输出" v={`${fmtTok(u?.input_tokens)} / ${fmtTok(u?.output_tokens)}`} />
                  <StatRow k="缓存读 / 写" v={`${fmtTok(u?.cache_read_input_tokens)} / ${fmtTok(u?.cache_creation_input_tokens)}`} />
                  {s.done_reason ? <StatRow k="结束原因" v={s.done_reason} /> : null}
                </View>

                <View style={d.moreSec}>
                  <Text style={d.moreSecT}>标识</Text>
                  {/* #205 长按复制整串（uuid 手动拖选繁琐），复制后「已复制 ✓」1.5s */}
                  <StatRow k="Session ID" v={s.session_id} copy />
                  {s.relay_session_id ? <StatRow k="SDK 会话" v={s.relay_session_id} copy /> : null}
                  {s.cli_pid ? <StatRow k="CLI PID" v={String(s.cli_pid)} /> : null}
                </View>

                {/* 定时任务（原独立 tab 收编；空清单整节不渲染） */}
                {(s.cron_tasks?.length ?? 0) > 0 ? (
                  <View style={d.moreSec}>
                    <Text style={d.moreSecT}>定时任务</Text>
                    {s.cron_tasks!.map((t, i) => {
                      const open = !!cronOpen[t.id];
                      const desc = cronDesc(t.schedule);
                      return (
                        <Pressable
                          key={t.id + "|" + i}
                          style={d.cronRow}
                          android_ripple={{ color: c.tintSoft, borderless: false }}
                          onPress={() => setCronOpen((m) => ({ ...m, [t.id]: !m[t.id] }))}
                        >
                          <Text style={[d.cronMark, t.paused && { color: c.faint }]}>{t.paused ? "⏸" : "⏰"}</Text>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[d.cronName, t.paused && { color: c.dim }]} numberOfLines={1}>{t.name}</Text>
                            <Text style={d.cronMeta} numberOfLines={open ? undefined : 1}>
                              {desc ?? t.schedule}
                              {t.recurring === false ? " · 一次性" : ""}
                              {t.next_run_at ? " · 下次 " + fmtDT(t.next_run_at) : ""}
                            </Text>
                            {open ? (
                              <>
                                {desc ? <Text style={d.cronRaw}>cron: {t.schedule}</Text> : null}
                                <Text style={d.cronPrompt} selectable>{t.prompt}</Text>
                              </>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })()}
        </ScrollView>
      ) : v.k === "team" && pmTeam ? (
        /* W-MOBFUSION 件④：PM 会话「团队」tab（桌面抽屉四区 tab 化） */
        <TeamPane
          team={pmTeam}
          sessions={snap.sessions}
          boards={boardsByGid}
          onOpenSession={onOpenSession}
          onOpenTeam={onOpenTeam}
        />
      ) : (() => {
        // 转录页（对话过滤视图）：list 取过滤结果，跨天分隔游标随本页 map 推进
        // W-PUSHPERF ①：渐进上屏——首帧只渲染尾部 REVEAL_N 条（转场顺滑），交互空闲后全量
        const REVEAL_N = 40;
        const list = revealed || shownMsg.length <= REVEAL_N ? shownMsg : shownMsg.slice(-REVEAL_N);
        let lastDay = "";
        return (
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        // 空态垂直居中（同定时视图手法）：仅 list 为空时容器撑满可视面板并居中提示组，
        // 底部大 padding（横幅/命令条的滚动余量）在空态收对称，否则中心会偏上一两百 px；
        // 非空分支样式零变化
        // G5（冲刺审查）：任务完成汇报悬浮钮（App.tsx TaskDoneFloat，详情页贴命令栏
        // 上方 right:12）非空时末条正文右下角被遮——滚动内容条件让位 +52（浮钮形态
        // 用户已拍板 #17 勿改，只让内容让路；空态居中提示不受浮钮影响不补）
        contentContainerStyle={{ padding: 14, paddingBottom: 14 + (bannerVisible ? 200 : canCmd ? 96 : 60) + insets.bottom + (snap.taskDoneQueue.length > 0 ? 52 : 0), ...(list.length === 0 ? { flexGrow: 1, justifyContent: "center", paddingBottom: 14 + insets.bottom } : null) }}
        onTouchStart={() => { touching.current = true; }}
        onTouchEnd={() => { touching.current = false; }}
        onTouchCancel={() => { touching.current = false; }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const near = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          atBottom.current = near;
          jumpScrollable.current = contentSize.height - layoutMeasurement.height > 300;
          // 用户拍板：滚动进行中立即隐藏，停止 ~300ms 后才浮现（防滚动期间闪现）
          setShowJump(false);
          if (jumpIdleTimer.current) clearTimeout(jumpIdleTimer.current);
          jumpIdleTimer.current = setTimeout(() => {
            if (!atBottom.current && jumpScrollable.current) setShowJump(true);
          }, 300);
        }}
        scrollEventThrottle={120}
        // #108 收缩式键盘让位后视口会随 kb 变小：贴底状态被顶掉时把列表拉回底部
        //（旧 translateY 方案视口不变无此问题；手法同任务页 todoAtBottom 的贴底保底，
        //  touching 守卫同 1535 行流式滚底——按住列表时不抢滚动）
        onLayout={() => {
          if (atBottom.current && !touching.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {s.historical && !external ? (
          // #49：提示不暴露内部机制（SDK resume、Relay 等字眼移除）
          <Text style={d.histnote}>{resumable ? "历史会话 · 发送消息将恢复继续" : "历史会话，仅可查看"}</Text>
        ) : null}

        {list.length === 0 ? (
          <Text style={d.empty}>{logs.length === 0 ? "暂无对话" : "该类型暂无内容"}</Text>
        ) : (
          list.map((e) => {
            const key = e.id ?? `${e.ts}|${e.kind}|${e.text}`;
            const nodes = [];
            // 跨天分隔线：与上一条可见消息不同日时插入（首条也插，标注起始日期）；
            // #162 标签套微信式分级（今天/昨天/M月d日/跨年带年份），同日判定仍走 dayKey
            const day = e.ts ? dayKey(e.ts) : "";
            if (day && day !== lastDay) {
              nodes.push(<Text key={`day-${key}`} style={d.daySep}>── {dayLabel(e.ts!)} ──</Text>);
            }
            if (day) lastDay = day;
            nodes.push(<TranscriptRow key={key} e={e} sid={sid} open={!!expanded[key]} onToggle={() => toggle(key)} onContentMenu={setMenuText} onTaskRef={openTaskRef} onTaskRefOut={outTaskRef} />);
            return nodes;
          })
        )}

        {/* 件五：乐观回显 pending 气泡（转录尾、工作状态盒前）——发送瞬间即见，
            回声/排队对账后收敛（reconcilePending）；失败态点按重发 */}
        {view === "msg"
          ? myEcho.map((p) => <PendingEchoBubble key={p.key} p={p} onRetry={retryEcho} />)
          : null}

        {/* 工作状态盒（类 CLI 放对话流内，顶栏不再显示工作状态）；#186 用户授权拍板：
            并行子 Agent 并入状态栏——子 Agent 是本回合工作的并行分支、与主状态同信息族，
            同一描边盒承载完整工作图景（信息密度集中），替代旧「盒内主状态 + 盒外裸行」的
            异质分离。渲染条件放宽为 WORKING 或有子 Agent 条目：非 WORKING 但后台仍在跑/
            刚收尾定格时，盒形态保持、仅渲染子 Agent 部分（回合结束后仍可展开查看 ✓ 定格）。
            排队注入消息在盒下方，CLI 处理（UserPromptSubmit）/回合结束时上浮为正式消息 */}
        {/* W-DETAIL2 件一：WORKING 主状态行（你在做什么…+计时）迁输入栏上方固定吸附
            （原在对话流内随内容滚动——用户 1018 实锤）；本盒只留并行子 Agent 展开块 */}
        {(s?.subagents?.length ?? 0) > 0 ? (
          <View style={d.liveRow}>
            {/* 并行子 Agent 状态（#142 三轮 + #186 并入/紧凑化）：标题行即折叠开关
                （「subAgent + 总数」+ 尾部箭头，总数保留、无「运行中」字样，走帧星只属于
                具体条目）；条目行相对标题行缩进形成层级；agCollapsed 模块级记忆；条目行首
                走帧星（SPIN_FRAMES 随 agTick 1s 重渲换帧，#148 铁律低频步进不用 Animated）、
                完成态换 ✓ 定格；ended_at>0 才算结束（防 ended_at:0 假运行冻结读秒）。
                #13 巡检：超 4 条溢出提示；#186 字号 12/11/11→11/10.5/10、行距收紧 */}
            {(s?.subagents?.length ?? 0) > 0 ? (
              <View style={d.agBox}>
                {(() => {
                  const all = s!.subagents!;
                  const shown = all.slice(-4);
                  const more = all.length - shown.length;
                  const frame = SPIN_FRAMES[Math.floor(Date.now() / 1000) % SPIN_FRAMES.length];
                  return (
                    <>
                      <Pressable
                        style={d.agHead}
                        hitSlop={{ top: 6, bottom: 4, left: 0, right: 0 }}
                        android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                        onPress={() => { agCollapsed = !agCollapsed; setAgOpen(!agCollapsed); }}
                        accessibilityLabel={`subAgent ${all.length} 个，点按${agOpen ? "折叠" : "展开"}`}
                      >
                        <Text style={d.agHeadT}>
                          subAgent {all.length} {agOpen ? "▾" : "▸"}
                        </Text>
                      </Pressable>
                      {agOpen ? (
                        <>
                          {shown.map((a) => {
                            const run = !((a.ended_at ?? 0) > 0);
                            const ms = a.started_at > 0 ? Math.max(0, ((a.ended_at ?? 0) > 0 ? a.ended_at! : Date.now()) - a.started_at) : 0;
                            const dur = !(a.started_at > 0) ? "" : ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
                            return (
                              <View key={a.id} style={d.agRow}>
                                {run ? (
                                  <Text style={[d.agSpin, { color: c.working }]}>{frame}</Text>
                                ) : (
                                  <Text style={d.agDone}>✓</Text>
                                )}
                                <Text style={[d.agT, { color: run ? c.working : c.dim }]} numberOfLines={1}>
                                  {a.desc}
                                </Text>
                                {a.act ? (
                                  <Text style={[d.agAct, { color: run ? c.dim : c.faint }]} numberOfLines={1}>
                                    {a.act}
                                  </Text>
                                ) : null}
                                <Text style={[d.agTime, { color: run ? c.working : c.faint }]}>{dur}</Text>
                              </View>
                            );
                          })}
                          {more > 0 ? <Text style={d.agMore}>… 更早 {more} 条已收起</Text> : null}
                        </>
                      ) : null}
                    </>
                  );
                })()}
              </View>
            ) : null}
          </View>
        ) : null}
        {(s.pending_inputs?.length ?? 0) > 0 ? (
          <View style={d.pendWrap}>
            {s.pending_inputs!.map((p, i) => (
              <PendingRow key={`${p.ts}|${i}`} text={p.text} />
            ))}
          </View>
        ) : null}
      </ScrollView>
        );
      })()
        ) : null}
        </View>
      ))}
      </ScrollView>

      {/* 回到底部浮钮（#322 第五轮，用户拍板）：对话区底部居中、输入框正上方，
          正圆形；滚动进行中隐藏、停止 ~300ms 才浮现——绝对定位不占布局 */}
      {/* W-MOTION：显隐 150ms opacity 过渡（常驻挂载，pointerEvents 随显隐——隐藏态不挡触达） */}
      <Animated.View pointerEvents={showJump && view === "msg" ? "auto" : "none"} style={[d.jumpFabHost, { opacity: jumpOp }]}>
        <Pressable
          style={d.jumpFab}
          android_ripple={{ color: withA(c.working, 0.2), borderless: false, radius: 17 }}
          onPress={() => {
            if (jumpIdleTimer.current) clearTimeout(jumpIdleTimer.current);
            scrollRef.current?.scrollToEnd({ animated: true });
            setShowJump(false);
          }}
        >
          <Text style={d.jumpFabT}>↓</Text>
        </Pressable>
      </Animated.View>
      </View>

      {/* 底部栈：审批横幅（常驻可见，类似 CLI 权限提示）> 模板行 > 命令栏。
           外层通铺命令栏同色底（2026-09-16）：底部手势条区域不再露页面底色——输入栏
           一气通到屏幕底边。#108 起键盘让位改 root paddingBottom 收缩式（祖先容器
           已按 kb 缩短），本容器只保留手势条让位。
           #114 主力机反馈「输入框下方到屏幕边缘的距离偏大」：完整 insets.bottom
           （手势导航机型 ≈30+）叠 cmdbar paddingVertical 10 显得空，让位量适度
           削减 12（保底 6：手势条仍不至于压输入区） */}
      <View pointerEvents="box-none" style={{ backgroundColor: c.overlay, paddingBottom: kb > 0 ? 0 : Math.max(6, insets.bottom - 12) }}>
        {/* W-EXPOLISH 件四：活动舱从 header 迁输入区上沿（对齐桌面 composer 前状态坞
            #dockActivityRow 单行制）——呼吸点·状态词·走秒·token 内联·当前操作一行流，
            单行截断；落位=审批横幅/模板行/附件行之上、消息流之下。header 只留标题+
            元信息+权限胶囊。终态（DONE/ERROR）不入舱（StatusStrip 收口不变）；终端
            实时行（零宽前缀）隐藏 token 防双计；呼吸点 #148 低频步进（原口径迁移） */}
        {/* W-DETAIL2 件一：WORKING 主状态行固定吸附（原对话流内随滚——用户实测拍板迁位）。
            键盘弹出/收起随底部栈整体让位（root paddingBottom kb 收缩式）自然移动 */}
        {s.status === "WORKING" ? (
          <View style={d.dockWork}>
            <LiveStatusLine
              summary={s.compacting ? "⟳ 正在压缩上下文…" : !isRealWorking(s) ? "⏸ 待开工 · " + (s.action_summary || "已接单未开工") : s.action_summary} /* #291 审查 B-P2-2：详情与卡同屏一致 */
              startedAt={s.turn_started_at ?? s.updated_at}
              color={c.working}
              tok={undefined}
            />
            <Pressable
              style={[d.stripBtnWarn, d.opRipple]}
              android_ripple={{ color: withA(c.waiting, 0.15), borderless: false }}
              onPress={() => store.send(external ? "COMMAND_EXT_STOP" : "COMMAND_STOP", { session_id: sid })}
            >
              <Text style={d.stripBtnWarnT}>{external ? "■ 打断" : "■ 停止"}</Text>
            </Pressable>
          </View>
        ) : null}
        {/* #218 件三：WORKING 态 dockLine 不再渲染——与 dockWork 黄行（执行摘要+走秒+停止钮）
            同屏双显（用户 1022 实拍实锤）；WORKING 只留信息更全的黄行，WAITING 等非工作态
            独立状态行保留 */}
        {dock && s.status !== "WORKING" ? (
          <View style={[d.dockLine, { borderLeftColor: dockColor }]}>
            <DockDot color={dockColor} breathe={dock.state === "WORKING"} />
            <Text style={[d.dockLineState, { color: dockColor }]}>{STATUS_ZH[dock.state] ?? dock.state}</Text>
            {dock.elapsedMs !== undefined ? <Text style={d.dockLineMeta}>· {fmtElapsed(dock.elapsedMs)}</Text> : null}
            {(() => {
              // token 内联：有水位且非终端实时行才显（实时行自带 ↓token，防双计）
              const used = s?.context_usage ?? 0;
              if (!used || isLiveLine(s?.action_summary)) return null;
              const limit = s?.context_limit ?? CONTEXT_LIMIT_FALLBACK;
              return <Text style={d.dockLineMeta}>· {fmtTok(used)}/{fmtTok(limit)}</Text>;
            })()}
            {(() => {
              // 一行流尾段：当前操作优先（工具动作 ⚙ tool · 文本），缺省回落当前任务/
              // 摘要（桌面 dar-t 同位；终端实时行去零宽前缀）
              const act = dock.actText
                ? `${dock.actKind === "tool_use" ? "⚙ " : ""}${dock.actTool ? `${dock.actTool} · ` : ""}${dock.actText}`
                : (() => {
                    const t = dock.summary || s?.action_summary || "";
                    return t ? (isLiveLine(t) ? t.slice(1) : t) : "";
                  })();
              if (!act) return null;
              return <Text style={d.dockLineAct} numberOfLines={1}>{act}</Text>;
            })()}
          </View>
        ) : null}
        {bannerVisible ? (
          wr!.questions?.length ? (
            <FadeIn><AskBanner wr={wr!} sid={sid} send={(t, p2) => store.send(t, p2)} /></FadeIn>
          ) : (
          <FadeIn>
          <WaitCard isAsk={false}>
            <View style={d.waitHead}>
              <View style={d.waitDot} />
              <Text style={d.waitTitle}>等待你的确认</Text>
              {wr!.tool_name ? <Text style={d.waitChip}>{wr!.tool_name}</Text> : null}
            </View>
            <Text style={d.waitCmd} numberOfLines={4}>
              <Text style={d.waitPs}>$ </Text>
              {wr!.input_summary}
            </Text>
            {rmOpen && wr!.remember ? (
              /* #212 范围确认条：主按钮组原地换成两选（对齐 web 端交互） */
              <View>
                <Text style={d.rmLabel} numberOfLines={2}>
                  将记住 <Text style={d.rmLabelB}>{wr!.remember.label}</Text>，之后同类请求不再逐条弹窗（危险命令除外）
                </Text>
                <View style={d.wbtns}>
                  <PressScale style={[d.btnAllow, d.opRipple]} ripple={withA(c.onDone, 0.15)} haptic onPress={() => decide(true, "session")}>
                    <Text style={d.btnAllowT}>本次会话</Text>
                  </PressScale>
                  <PressScale style={[d.btnAllow, d.opRipple]} ripple={withA(c.onDone, 0.15)} haptic onPress={() => decide(true, "global")}>
                    <Text style={d.btnAllowT}>所有会话</Text>
                  </PressScale>
                  <PressScale style={[d.btnReject, d.opRipple]} ripple={withA(c.waiting, 0.18)} haptic onPress={() => setRmOpen(false)}>
                    <Text style={d.btnRejectT}>✕ 返回</Text>
                  </PressScale>
                </View>
              </View>
            ) : (
              /* 005 #166 三级按钮：拒绝=次级描边、允许并记住=第三钮（同次级档次）、
                  允许=唯一实心主钮（done 色）；仅浏览口径下全 disabled 压灰 */
              <View style={[d.wbtns, WAITBOX_READONLY && d.roDim]}>
                <PressScale style={[d.btnReject, d.opRipple]} ripple={withA(c.waiting, 0.18)} haptic disabled={WAITBOX_READONLY} onPress={() => decide(false)}>
                  <Text style={d.btnRejectT}>✕ 拒绝</Text>
                </PressScale>
                {wr!.remember ? (
                  <PressScale style={[d.btnRemember, d.opRipple]} ripple={withA(c.waiting, 0.18)} haptic disabled={WAITBOX_READONLY} onPress={() => setRmOpen(true)}>
                    <Text style={d.btnRememberT}>允许并记住</Text>
                  </PressScale>
                ) : null}
                <PressScale style={[d.btnAllow, d.opRipple]} ripple={withA(c.onDone, 0.15)} haptic disabled={WAITBOX_READONLY} onPress={() => decide(true)}>
                  <Text style={d.btnAllowT}>✓ 允许</Text>
                </PressScale>
              </View>
            )}
          </WaitCard>
          </FadeIn>
          )
        ) : null}
        {images.length > 0 || files.length > 0 ? (
          <View style={[d.imgRow, (images.length > 0 || files.length > 1) && d.imgRowWrap]}>
            {images.map((b, i) => (
              <FadeIn key={`i${i}`} dy={4}>
                <View style={d.imgCell}>
                  <Image style={d.imgThumb} source={{ uri: `data:image/jpeg;base64,${b}` }} />
                  <Pressable style={d.imgDel} android_ripple={{ color: "rgba(0,0,0,0.3)", borderless: false, radius: 10 }} onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                    <Text style={d.imgDelT}>×</Text>
                  </Pressable>
                </View>
              </FadeIn>
            ))}
            {files.map((f, i) => (
              <FadeIn key={`f${i}`} dy={4}>
                <View style={d.fileChip}>
                  <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <Path d="M14 3v5h5" />
                  </Svg>
                  <Text style={d.fileName} numberOfLines={1}>{f.name}</Text>
                  <Pressable style={d.fileDel} hitSlop={6} android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }} onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))} accessibilityLabel={`移除文件 ${f.name}`}>
                    <Text style={d.fileDelT}>×</Text>
                  </Pressable>
                </View>
              </FadeIn>
            ))}
          </View>
        ) : null}
        {queuedHint ? (
          <FadeIn dy={4}><Text style={d.queuedHint}>{queuedHint}</Text></FadeIn>
        ) : null}
        {voiceHint ? (
          <FadeIn dy={4}><Text style={d.queuedHint}>{voiceHint}</Text></FadeIn>
        ) : null}
        {listening ? (
          <FadeIn dy={4}>
            <Text style={d.voiceLive} numberOfLines={1}>
              {voiceText || "正在听，松开发送…"}
            </Text>
          </FadeIn>
        ) : null}
        {slashQuery !== null ? (
          <FadeIn dy={10}>
          <View style={d.slashBox}>
            <ScrollView keyboardShouldPersistTaps="always" nestedScrollEnabled>
              {slashMatches.map((m) => (
                <Pressable
                  key={m.name}
                  style={d.slashRow}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onPress={() => editInput("/" + m.name + " ")}
                >
                  <Text style={d.slashName}>/{m.name}</Text>
                  <Text style={d.slashDesc} numberOfLines={1}>{m.desc}</Text>
                  {m.source !== "builtin" ? (
                    <Text style={d.slashSrc}>{m.source === "user" ? "用户" : "项目"}</Text>
                  ) : null}
                </Pressable>
              ))}
              {slashMatches.length === 0 ? (
                <Text style={d.slashEmpty}>无匹配命令，直接发送则原样注入</Text>
              ) : null}
            </ScrollView>
          </View>
          </FadeIn>
        ) : null}
        <View style={d.cmdbar}>
          {/* 可恢复的托管历史会话同样支持发图（SDK resume 支持图片，2026-09-16 反馈：
              测试客户端创建的会话闲置转 historical 后发图入口消失）；
              #54 外部 CLI 会话开放发图（relay 落盘+注入查看指令）；
              #62 文件同链路（relay 落盘原名+路径指令，托管/外部一致） */}
          {external || !s.historical || s.relay_session_id ? (
            <>
            {/* #68② 按钮瘦身：去底去边框纯线条图标，触达靠 hitSlop（晨间反馈 21→18 再收紧） */}
            <Pressable
              style={[d.imgBtn, (!canCmd || files.length >= 2) && { opacity: 0.4 }]}
              onPress={pickFiles}
              hitSlop={6}
              disabled={!canCmd || files.length >= 2}
              accessibilityLabel="附加文件"
            >
              {/* 线条回形针（与相机按钮同形制） */}
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Svg>
            </Pressable>
            <Pressable
              style={[d.imgBtn, (!canCmd || images.length >= 4) && { opacity: 0.4 }]}
              onPress={pickImages}
              hitSlop={6}
              disabled={!canCmd || images.length >= 4}
            >
              {/* 2026-09-18 与网页端统一为线条相机（原相框+山形图片图标两端不一致） */}
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M8.7 6.8l1.05-1.9a1.5 1.5 0 0 1 1.3-.75h1.9a1.5 1.5 0 0 1 1.3.75l1.05 1.9" />
                <Rect x={3.4} y={6.8} width={17.2} height={13} rx={3} />
                <Circle cx={12} cy={13.2} r={3.5} />
              </Svg>
            </Pressable>
            </>
          ) : null}
          <View style={{ flex: 1 }}>
            <TextInput
              // #87 键盘不弹排查：editable=false（未连接/会话不可恢复）在 Android 上点击
              // 完全无反应——用户表象就是「键盘弹不出来」。断连挂死（#85 connecting 卡死）
              // 期间曾长期处于此态且无任何视觉提示。现半透明弱化 + placeholder 说明原因，
              // 用户能自诊断「是断连不是键盘坏了」
              ref={inputRef}
              style={[d.input, { height: inputH }, !canCmd && { opacity: 0.5 }]}
              value={input}
              onChangeText={editInput}
              onContentSizeChange={(e) => {
                // #113 基线自校准：空输入的 contentSize = 该设备单行基线（虚高机型
                // 含 padding/边框）。空输入恒 44；有内容按 相对基线增量 定高，
                // 设备口径差异在减法里抵消
                const h = e.nativeEvent.contentSize.height;
                if (!input.trim()) {
                  inputBaseRef.current = h;
                  setInputH(44);
                  return;
                }
                const base = inputBaseRef.current ?? h;
                setInputH(Math.max(44, Math.min(150, 44 + Math.max(0, h - base))));
              }}
              placeholder={
                !snap.connected
                  ? "未连接 · 恢复连接后可输入"
                  : external
                    ? "CLI忙时自动排队"
                    : s.historical
                      ? (resumable ? "继续对话（恢复会话）…" : "历史会话，仅可查看")
                      : "发送消息…"
              }
              placeholderTextColor={c.faint}
              editable={canCmd}
              multiline
              // #129 回车键行为（设置抽屉「显示」区可切）：开 = 回车发送（键帽「发送」、
              // 不插换行，恢复 #68 多行化前的旧习惯）；关 = 回车换行、发送靠 ➤。
              // blurOnSubmit=true 才会让 Android multiline 的回车触发 onSubmitEditing
              returnKeyType={enterSend ? "send" : "default"}
              blurOnSubmit={enterSend}
              onSubmitEditing={() => {
                send();
                // 发送后夺回焦点：blurOnSubmit=true 的回车在 Android 上会顺带 blur 收起
                // 键盘，连续发消息不该每条都重弹（键盘未收时 focus 是无操作）。延后一拍
                // 躲开随 submit 到来的 blur
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
            />
          </View>
          {voiceOn ? (
            <Pressable
              style={[d.imgBtn, listening && d.micOn, !canCmd && { opacity: 0.4 }]}
              onPressIn={() => void startVoice()}
              onPressOut={endVoice}
              hitSlop={6}
              disabled={!canCmd}
            >
              <MicIcon color={listening ? c.brandA : c.dim} />
            </Pressable>
          ) : null}
          <PressScale
            style={[d.sendBtn, (!canCmd || (!input.trim() && images.length === 0 && files.length === 0)) && { opacity: 0.4 }]}
            ripple={withA(c.text, 0.14)}
            haptic
            onPress={() => send()}
            disabled={!canCmd}
          >
            <Text style={d.sendT}>➤</Text>
          </PressScale>
        </View>
      </View>

      <RenameModal
        visible={renaming}
        initial={s.title || ""}
        onCancel={() => setRenaming(false)}
        onSubmit={(title) => {
          store.send("COMMAND_RENAME", { session_id: sid, title });
          setRenaming(false);
        }}
      />

      {/* #216 常驻渲染：受控 visible 显隐（勿改回条件挂卸，见 PermPanel 头注释） */}
      <PermPanel
        open={permPanel}
        cur={perm}
        onPick={(m) => store.send("COMMAND_PERM", { session_id: sid, mode: m })}
        onClose={() => setPermPanel(false)}
      />
      {/* W-PORT-B P0-1：模型切换面板（PermPanel 同范式 bottom-sheet，受控显隐） */}
      <ModelSheet
        open={modelSheet}
        cur={s.model || ""}
        models={modelList}
        onPick={pickModel}
        onClose={() => setModelSheet(false)}
      />

      {/* #216 同构修：弹层改常驻受控（勿改回条件挂卸，见各组件头注释） */}
      <ContentMenu text={menuText} onClose={() => setMenuText(null)} />
      <ArtSheet art={artPop} rel={artPop ? artRelOf(s, artPop) : ""} sid={sid} onClose={() => setArtPop(null)} />
      {/* #222 文件夹 ⋯ sheet：开合态随 folPop 快照（folOpen 是输出物视图闭包局部，
          根级不可达）；onToggle 写显式 artFold 记录 + 同步翻转快照，主 CTA 单发即关 */}
      <ArtFolSheet
        fol={folPop}
        onToggle={() => {
          if (!folPop) return;
          setArtFold((m) => ({ ...m, [sid + "|" + folPop.key]: !folPop.open }));
          setFolPop((p) => (p ? { ...p, open: !p.open } : p));
        }}
        onClose={() => setFolPop(null)}
      />
      {taskPop != null ? (
        <TaskPop
          n={taskPop}
          todo={(s?.todos ?? []).find((t) => t.id === taskPop)}
          goneSession={!s}
          hold={taskHold}
          anchor={taskAnchor}
          onClose={() => setTaskPop(null)}
          onGoList={() => {
            if (taskPop != null) jumpToTask(taskPop);
          }}
        />
      ) : null}
      </View>
    </SafeAreaView>
  );
}

// 统计视图行（原 StatsModal 的 Row 平铺化）
// #205 统计行支持 copy：长按一键复制整串值（uuid 手动拖选太繁琐），复制后
// 值临时变「已复制 ✓」1.5s（同 ContentMenu 反馈形态）。当前仅 Session ID 用

// 输入法风格麦克风矢量图标：胶囊 + U 形支架 + 立柱 + 底座（替代 emoji）
import { makeStyles } from "../components/detail-styles";
import { TAB_PAD_L, TAB_GAP } from "../components/detail-consts";
import { isRealWorking } from "../protocol"; /* #291 帧分类判活（待命分层） */
