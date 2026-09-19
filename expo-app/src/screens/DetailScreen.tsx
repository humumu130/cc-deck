import { Fragment, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Animated, Dimensions, Image, Linking, Modal, PanResponder, PermissionsAndroid, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, Vibration, View, type GestureResponderEvent, type NativeScrollEvent, type NativeSyntheticEvent, type NativeTouchEvent, type StyleProp, type TextStyle } from "react-native";
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
import * as Clipboard from "expo-clipboard";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { fmtElapsed, sessionElapsed, fmtHM, dayKey, fmtClock, fmtTok, contextPct, contextLevel, CONTEXT_LIMIT_FALLBACK, isVerifyTodo, isLiveLine, stripLiveMark } from "../fmt";
import { store, useRelay } from "../store";
import { fromB64, toB64 } from "../e2e";
import type { ArtifactItem, CronTask, LogEntry, SessionState, TodoItem, WaitingPayload } from "../protocol";
import { useKbHeight } from "../kb";
import { useProcessFont, useVoiceInput } from "../display-settings";
import { voice } from "../voice";
import { BUILTIN_COMMANDS, fetchSlashCommands, httpBaseOf, matchSlash, type SlashCommand } from "../slash";
import { MdText } from "../md";
import { Collapse, FadeIn, PressScale } from "../motion";
import RenameModal from "./RenameModal";

// 详情页视图 tab（与网页端 tabs 对齐：消息/任务/全部/输出物/定时/统计，同序）。
// 消息/全部 = 转录过滤视图；任务/输出物/定时/统计 = 独占内容视图。
// 原"工具/系统"过滤 chips 与设置抽屉"过程消息·隐藏档"重叠，移除。
const VIEWS = [
  { k: "msg", label: "消息" },
  { k: "todos", label: "任务" },
  { k: "all", label: "全部" },
  { k: "arts", label: "输出物" },
  { k: "cron", label: "定时" },
  { k: "stats", label: "统计" },
] as const;
// tab 指示条几何参数：tabWrap 左边距与 tab 间隙（JS 几何计算与 makeStyles 共用）
const TAB_PAD_L = 4;
const TAB_GAP = 6;
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
type PermMode = (typeof PERM_CYCLE)[number];
const PERM_LABEL: Record<PermMode, string> = {
  default: "标准",
  acceptEdits: "自动编辑",
  plan: "规划",
  bypassPermissions: "跳过",
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

// 输入草稿跨进出保留：按 session_id 暂存（app 生命周期内，发送即清）
const drafts = new Map<string, string>();

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
function fmtArtSize(n: number | undefined): string {
  if (typeof n !== "number" || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
// 输出物时间：今天 HH:mm / 昨天 / 7 天内 周X / 更早 M/d（web-console 同款）
function fmtArtTime(ts: number): string {
  if (!ts) return "";
  const now = Date.now();
  if (dayKey(ts) === dayKey(now)) return fmtHM(ts);
  if (dayKey(ts) === dayKey(now - 86400000)) return "昨天";
  if (now - ts < 7 * 86400000) return "周" + "日一二三四五六"[new Date(ts).getDay()];
  const d = new Date(ts);
  return d.getMonth() + 1 + "/" + d.getDate();
}

// 转录行：user=右气泡 / assistant=正文流式 / tool=紧凑卡片 / system=居中弱化
// 转录字号分级：过程消息（工具/结果/系统/思考）比消息（用户/assistant）小一档，可在设置抽屉调。
// 紧凑档双维度拉开差距：字号小 3px + 整体降不透明度（procOp），保证档位切换一眼可辨
const PROC_FONT = {
  compact: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
  normal: { tool: 11.5, sys: 11, result: 11.5, thinkHead: 11.5, think: 12.5, thinkLH: 18, op: 1 },
  // 隐藏档：工具/结果/系统行整行不渲染，思考沿用紧凑小字号
  hidden: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
} as const;

function TranscriptRow({ e, open, onToggle, onContentMenu, onTaskRef, onTaskRefOut }: { e: LogEntry; open: boolean; onToggle: () => void; onContentMenu?: (text: string) => void; onTaskRef?: (n: number, hold?: boolean, anchor?: { x: number; y: number }) => void; onTaskRefOut?: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const pf = PROC_FONT[useProcessFont()];
  const cursor = e.streaming ? <Text style={{ color: c.working }}>▌</Text> : null;
  if (e.kind === "user_message") {
    return (
      <View style={d.trUser}>
        {/* URL 链接化：拆段渲染，链接段品牌色+可点开系统浏览器（2026-09-14 用户提） */}
        <Text style={d.trUserText} selectable>
          {(e.full ?? e.text).split(/(https?:\/\/[^\s<>"')\]]+)/g).map((seg, i) =>
            /^https?:\/\//.test(seg) ? (
              <Text key={i} style={{ color: c.brandA }} onPress={() => { try { Linking.openURL(seg); } catch {} }}>{seg}</Text>
            ) : (
              <Text key={i}>{seg}</Text>
            ),
          )}
        </Text>
        {e.ts ? <Text style={d.trUserTime}>{fmtHM(e.ts)}</Text> : null}
      </View>
    );
  }
  if (e.kind === "thinking") {
    const src = e.full ?? e.text;
    return (
      <Pressable
        style={[d.trThink, { opacity: pf.op }]}
        onPress={onToggle}
        android_ripple={{ color: c.tintSoft, borderless: false }}
      >
        <Text style={[d.trThinkHead, { fontSize: pf.thinkHead }]}>{open ? "▾ 思考过程" : `▸ 思考过程 · ${src.length} 字`}{e.ts ? ` · ${fmtHM(e.ts)}` : ""}</Text>
        <Collapse open={open}>
          <MdText src={src} selectable onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut} style={{ ...d.trThinkT, fontSize: pf.think, lineHeight: pf.thinkLH }} />
        </Collapse>
      </Pressable>
    );
  }
  if (e.kind === "assistant_text") {
    return (
      <View style={d.trMsg}>
        {e.ts ? <Text style={d.trMsgTime}>{fmtHM(e.ts)}</Text> : null}
        <MdText src={open ? (e.full ?? e.text) : e.text} selectable onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut} />
        {cursor}
        {e.full ? (
          <Pressable onPress={onToggle} hitSlop={6}>
            <Text style={d.tlExpand}>{open ? "收起 ▴" : `展开全文 ${e.full.length} 字 ▾`}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (e.kind === "tool_use") {
    if (e.detail) {
      return (
        <Pressable style={[d.trTool, { opacity: pf.op }]} onPress={onToggle} onLongPress={e.detail ? () => onContentMenu?.(e.detail!) : undefined} android_ripple={{ color: c.tintSoft, borderless: false }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
              <Text style={[d.trToolName, { fontSize: pf.tool }]}>⚙ {e.tool || "tool"}</Text>
              <TaskRefText style={[d.trToolText, { fontSize: pf.tool }]} numberOfLines={1} text={e.text} onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut} />
            </View>
            <Collapse open={open}>
              <Text style={d.trDetail} selectable>{e.detail}</Text>
            </Collapse>
          </View>
          <Text style={d.tlExpand}>{open ? "▴" : "▾"}</Text>
        </Pressable>
      );
    }
    return (
      <View style={[d.trTool, { opacity: pf.op }]}>
        <Text style={[d.trToolName, { fontSize: pf.tool }]}>⚙ {e.tool || "tool"}</Text>
        <TaskRefText style={[d.trToolText, { fontSize: pf.tool }]} numberOfLines={2} text={e.text} onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut} />
      </View>
    );
  }
  if (e.kind === "tool_result") {
    if (e.diff && e.diff.length > 0) {
      return (
        <Pressable style={[d.trDiffWrap, { opacity: pf.op }]} onPress={onToggle} onLongPress={() => onContentMenu?.(e.diff!.join("\n"))} android_ripple={{ color: c.tintSoft, borderless: false }}>
          <Text style={[d.trResult, { fontSize: pf.result }]} numberOfLines={open ? undefined : 1}>
            ↳ {open ? "收起变更 ▴" : `变更 · ${e.diff.filter((l) => l.startsWith("+")).length}+ ${e.diff.filter((l) => l.startsWith("-")).length}− ▾`}
          </Text>
          <Collapse open={open}>
            <DiffBlock lines={e.diff} />
          </Collapse>
        </Pressable>
      );
    }
    if (e.detail) {
      return (
        <Pressable onPress={onToggle} onLongPress={e.detail ? () => onContentMenu?.(e.detail!) : undefined} hitSlop={4} style={{ opacity: pf.op }}>
          <TaskRefText
            style={[d.trResult, { fontSize: pf.result }]}
            numberOfLines={open ? undefined : 2}
            text={`↳ ${e.text} `}
            suffix={open ? "收起 ▴" : "展开 ▾"}
            suffixStyle={d.tlExpand}
            onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut}
          />
          <Collapse open={open}>
            <Text style={d.trDetail} selectable>{e.detail}</Text>
          </Collapse>
        </Pressable>
      );
    }
    return <TaskRefText style={[d.trResult, { fontSize: pf.result, opacity: pf.op }]} numberOfLines={2} text={`↳ ${e.text}`} onTaskRef={onTaskRef} onTaskRefOut={onTaskRefOut} />;
  }
  return <Text style={[d.trSystem, { fontSize: pf.sys, opacity: pf.op }]}>{e.text}</Text>;
}

// diff 着色块：+/−/@@ 逐行着色（等宽），行数据由 relay 从 structuredPatch 提取
function DiffBlock({ lines }: { lines: string[] }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={d.diffBox}>
      {lines.map((l, i) => {
        const st = l.startsWith("@@")
          ? d.diffHunk
          : l.startsWith("+")
            ? d.diffAdd
            : l.startsWith("-")
              ? d.diffDel
              : d.diffCtx;
        return <Text key={i} style={st} selectable>{l || " "}</Text>;
      })}
    </View>
  );
}

// #264：摘要文本里的 #NNN 任务号渲染成可点高亮段（1~3 位数字，避免误吞时间戳/长号），
// 点击跳任务 tab 并定位该条。找不到对应任务时仍切到任务 tab（无害回退）
// #340 触点即气泡锚点（#NNN 数字处）：短点/长按事件都带 changedTouches
const tpPt = (e: GestureResponderEvent): { x: number; y: number } | undefined => {
  const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
  return t ? { x: t.pageX, y: t.pageY } : undefined;
};

function TaskRefText({ text, style, numberOfLines, suffix, suffixStyle, onTaskRef, onTaskRefOut }: { text: string; style: StyleProp<TextStyle>; numberOfLines?: number; suffix?: string; suffixStyle?: StyleProp<TextStyle>; onTaskRef?: (n: number, hold?: boolean, anchor?: { x: number; y: number }) => void; onTaskRefOut?: () => void }) {
  const { c } = useTheme();
  if (!onTaskRef || !/#\d{1,3}\b/.test(text)) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
        {suffix ? <Text style={suffixStyle}>{suffix}</Text> : null}
      </Text>
    );
  }
  const parts = text.split(/#(\d{1,3})\b/g);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text
            key={i}
            style={{ color: c.brandA, fontWeight: "700" }}
            onPress={(e) => onTaskRef(Number(p), false, tpPt(e))}
            onLongPress={(e) => onTaskRef(Number(p), true, tpPt(e))}
            onPressOut={onTaskRefOut}
          >
            #{p}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
      {suffix ? <Text style={suffixStyle}>{suffix}</Text> : null}
    </Text>
  );
}

// 内容长按菜单（#249/#260）：复制全文 / 系统分享，仅挂 detail/diff 摘要行——
// 正文（用户/assistant/思考）长按即原生选择手柄可拖选片段，不走此菜单
function ContentMenu({ text, onClose }: { text: string; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
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
    </Modal>
  );
}

// #79 拉取产物落手机缓存（cacheDirectory/art-view/，重名覆盖；返回 file:// uri）
const ART_VIEW_DIR = `${FileSystem.cacheDirectory ?? ""}art-view/`;
async function saveArtFile(name: string, u8: Uint8Array): Promise<string> {
  try { await FileSystem.makeDirectoryAsync(ART_VIEW_DIR, { intermediates: true }); } catch {}
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "artifact";
  const uri = ART_VIEW_DIR + safe;
  await FileSystem.writeAsStringAsync(uri, toB64(u8), { encoding: FileSystem.EncodingType.Base64 });
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
function decodeUtf8(u8: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(u8);
}

// #79 拉取结果分级：img=内嵌图片；txt/md=内嵌文本（md 走 MdText）；sys=复杂格式
//（pdf/office/zip…）落盘后交系统应用打开
type ArtViewData =
  | { kind: "img"; name: string; uri: string; size: number }
  | { kind: "txt"; name: string; text: string; size: number }
  | { kind: "md"; name: string; text: string; size: number }
  | { kind: "sys"; name: string; uri: string; mime: string; size: number };

// #79 输出物预览全屏层：图片/文本内嵌，复杂格式自动呼系统应用（头部按钮可重开）
function ArtView({ v, onClose }: { v: ArtViewData; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [openErr, setOpenErr] = useState<string | null>(null);
  useEffect(() => {
    setOpenErr(null);
    if (v.kind === "sys") void openArtExternally(v.uri, v.mime).then(setOpenErr);
  }, [v]);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={d.avHead}>
          <Text style={d.avName} numberOfLines={1}>{v.name}</Text>
          <Text style={d.avSize}>{fmtArtSize(v.size)}</Text>
          <Pressable hitSlop={8} onPress={onClose} accessibilityLabel="关闭预览">
            <Text style={d.avClose}>✕</Text>
          </Pressable>
        </View>
        {v.kind === "img" ? (
          <Image source={{ uri: v.uri }} style={{ flex: 1, backgroundColor: c.panel2 }} resizeMode="contain" />
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
    </Modal>
  );
}

// #35 输出物详情 sheet（#79 起支持实时拉取）：路径复制/分享保留；「拉取查看」把
// 文件经 E2E 实时分块传到手机（≤20MB，不落云存储）按格式分级预览。元信息速览复用
// 统计行。面板形态复用 #36 permSheet（底部 grab 条 + 标题行）
function ArtSheet({ art, rel, sid, onClose }: { art: ArtifactItem; rel: string; sid: string; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const [busy, setBusy] = useState(false);
  const [ferr, setFerr] = useState<string | null>(null);
  const [view, setView] = useState<ArtViewData | null>(null);
  const name = (rel || art.path).split(/[\\/]/).pop() || art.path;
  const dead = art.exists === false;
  const outside = art.origin === "outside" || (!rel && art.origin !== "cwd");
  const kind = artKindOf(name);
  const KC: Record<ArtKind, string> = { code: c.brandA, doc: c.done, data: c.working, img: c.waiting, zip: c.dim, gen: c.faint };
  // #79 拉取 + 分级路由：图片/文本直接内嵌预览，复杂格式落缓存后交系统应用
  const doFetch = async () => {
    if (busy || dead) return;
    setBusy(true);
    setFerr(null);
    try {
      const r = await store.fetchArtifact(sid, art.path);
      const chunks = r.b64s.map(fromB64);
      let n = 0;
      for (const cc of chunks) n += cc.length;
      const u8 = new Uint8Array(n);
      let o = 0;
      for (const cc of chunks) { u8.set(cc, o); o += cc.length; }
      const mime = r.mime || "application/octet-stream";
      if (mime.startsWith("image/")) {
        setView({ kind: "img", name, uri: await saveArtFile(name, u8), size: n });
      } else if (mime === "text/markdown") {
        setView({ kind: "md", name, text: decodeUtf8(u8), size: n });
      } else if (mime.startsWith("text/") || mime === "application/json") {
        setView({ kind: "txt", name, text: decodeUtf8(u8), size: n });
      } else {
        setView({ kind: "sys", name, uri: await saveArtFile(name, u8), mime, size: n });
      }
    } catch (e) {
      setFerr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {view ? <ArtView v={view} onClose={() => setView(null)} /> : null}
      <Pressable style={d.permScrim} onPress={onClose}>
        <Pressable style={d.permSheet} onPress={() => undefined}>
          <View style={d.permGrab} />
          <View style={d.permTitleRow}>
            <View style={[d.artChip, { borderColor: withA(KC[kind], 0.45) }]}>
              <Text style={[d.artChipT, { color: KC[kind] }]}>{artExtOf(name)}</Text>
            </View>
            <Text style={[d.permTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text>
            <Pressable hitSlop={8} onPress={onClose} accessibilityLabel="关闭输出物详情">
              <Text style={d.permX}>✕</Text>
            </Pressable>
          </View>
          <View style={d.artBadges}>
            <View style={[d.artBadge, art.op === "create" && { borderColor: withA(c.done, 0.5) }]}>
              <Text style={[d.artBadgeT, art.op === "create" && { color: c.done }]}>{art.op === "create" ? "新建" : "修改"}</Text>
            </View>
            {dead ? (
              <View style={d.artBadge}><Text style={[d.artBadgeT, { color: c.error }]}>已删除</Text></View>
            ) : null}
            {outside ? (
              <View style={d.artBadge}><Text style={[d.artBadgeT, { color: c.working }]}>cwd 外</Text></View>
            ) : null}
          </View>
          <View style={[d.menuBtns, { marginTop: 14 }]}>
            <Pressable
              style={[d.menuBtn, d.menuBtnPri, (busy || dead) && { opacity: 0.5 }]}
              disabled={busy || dead}
              android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
              onPress={() => { void doFetch(); }}
            >
              <Text style={d.menuBtnPriT}>{busy ? "拉取中…" : dead ? "文件已删除，无法拉取" : "拉取到手机查看"}</Text>
            </Pressable>
          </View>
          {ferr ? <Text style={{ color: c.error, fontSize: 11, marginTop: 8, textAlign: "center" }}>{ferr}</Text> : null}
          <Text style={d.artPathLabel}>绝对路径（长按可选中复制）</Text>
          <Text style={d.artPath} selectable>{art.path}</Text>
          {rel ? <Text style={d.artRel} numberOfLines={1}>相对会话目录：{rel}</Text> : null}
          <View style={d.menuBtns}>
            <Pressable
              style={d.menuBtn}
              android_ripple={{ color: withA(c.dim, 0.2), borderless: false, radius: 10 }}
              onPress={() => {
                void Clipboard.setStringAsync(art.path).then(() => {
                  setCopied(true);
                  copiedTimer.current = setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={d.menuBtnT}>{copied ? "已复制 ✓" : "复制路径"}</Text>
            </Pressable>
            <Pressable
              style={d.menuBtn}
              android_ripple={{ color: withA(c.dim, 0.2), borderless: false, radius: 10 }}
              onPress={() => {
                onClose();
                void Share.share({ message: art.path }).catch(() => undefined);
              }}
            >
              <Text style={d.menuBtnT}>分享</Text>
            </Pressable>
          </View>
          <View style={d.artInfo}>
            <StatRow k="工具" v={art.tools?.join(" · ") || "—"} />
            <StatRow k="行变更" v={`+${art.adds ?? 0} / −${art.dels ?? 0}`} />
            {fmtArtSize(art.size) ? <StatRow k="大小" v={fmtArtSize(art.size)} /> : null}
            {art.first_at ? <StatRow k="首次写入" v={fmtDT(art.first_at)} /> : null}
            {art.last_at ? <StatRow k="最近写入" v={fmtDT(art.last_at)} /> : null}
          </View>
          {/* #49：提示去掉"（会话主机）"内部术语；#79 起支持拉取预览 */}
          <Text style={d.artHint}>文件保存在电脑上 · 可实时拉取到手机预览（≤20MB，不落云存储）</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// #36 权限模式四选一面板（设计定案 docs/perm-mode-design.md §4.2/4.3）：替代原
// 循环点击——恒定 2 击直达任意档、每档一句描述首次使用即懂；跳过档（bypassPermissions
// 免审执行一切命令与编辑）首击只展开底部确认区、再击「确认跳过」才发命令，误触不可达。
// 当前项选中靠整行 tintStrong 底 + 右缘 ✓（不靠游离符号）；已处于跳过档时该行直接收起
// （现状即该危险态，无需再确认一次"保持"）
function PermPanel({ cur, onPick, onClose }: { cur: PermMode; onPick: (m: PermMode) => void; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [arm, setArm] = useState(false);
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
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={d.permScrim} onPress={onClose}>
        <Pressable style={d.permSheet} onPress={() => undefined}>
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
                accessibilityLabel={`${PERM_LABEL[m]}：${PERM_DESC[m]}${cur === m ? "，当前" : ""}`}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={d.permNameRow}>
                    <Text style={[d.permName, danger && { color: c.waiting }]}>{PERM_LABEL[m]}</Text>
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

const SPIN_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✸"];

// 类 Claude Code 状态行：✶ 摘要 · Ns（每秒走帧）。无边框，嵌入状态条内。
function LiveStatusLine({ summary, startedAt, color, tok }: { summary: string; startedAt?: number; color: string; tok?: string }) {
  const d = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const live = isLiveLine(summary);
  const text = stripLiveMark(summary);
  const secs = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  // 实时行照转动画星：CLI 行首星已在 relay 剥除，客户端星是唯一指示不重复；
  // 走秒保留（本回合时长与转轮行内活动时长语义不同）；ctx 已按反馈移除
  const frame = SPIN_FRAMES[Math.floor(Date.now() / 500) % SPIN_FRAMES.length];
  const m = Math.floor(secs / 60);
  const timeText = m > 0 ? `${m}m${secs % 60}s` : `${secs}s`;
  return (
    <View style={d.statusLine}>
      <Text style={[d.statusSpin, { color }]}>{frame}</Text>
      <Text style={[d.statusText, { color }]} numberOfLines={1}>{text || "思考中…"}</Text>
      {startedAt ? <Text style={d.statusTime}>· {timeText}</Text> : null}
      {tok && !live ? <Text style={d.statusTime}>· {tok}</Text> : null}
    </View>
  );
}

// 排队注入消息：脉冲呼吸（类 CLI queued），CLI 处理/回合结束时上浮为正式消息
function PendingRow({ text }: { text: string }) {
  const d = useThemeStyles(makeStyles);
  const op = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0.85, duration: 900, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.35, duration: 900, useNativeDriver: true }),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [op]);
  return (
    <Animated.View style={[d.pendRow, { opacity: op }]}>
      <Text style={d.pendT} numberOfLines={3}>{text}</Text>
    </Animated.View>
  );
}

// AskUserQuestion 作答横幅：单问题单选 = 点选项即发；多问题/多选 = 勾选后提交；单问题支持自由输入
function AskBanner({ wr, sid }: { wr: WaitingPayload; sid: string }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const qs = wr.questions ?? [];
  const single = qs.length === 1 && !qs[0].multi;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [free, setFree] = useState("");
  useEffect(() => {
    setPicked({});
    setFree("");
  }, [wr.request_id]);

  const answer = (answers: string[]) => {
    store.send("COMMAND_ANSWER", { session_id: sid, request_id: wr.request_id, answers });
  };
  const toggle = (qi: number, label: string) => {
    setPicked((p) => {
      const cur = p[qi] ?? [];
      const has = cur.includes(label);
      const next = qs[qi].multi
        ? has ? cur.filter((x) => x !== label) : [...cur, label]
        : has ? [] : [label];
      return { ...p, [qi]: next };
    });
  };
  const allAnswered = qs.every((_, i) => (picked[i]?.length ?? 0) > 0);
  const freeReady = single && free.trim().length > 0;

  return (
    <View style={d.waitBanner}>
      <Text style={d.waitT}>◉ Claude 在提问</Text>
      {qs.map((q, qi) => (
        <View key={qi}>
          <Text style={d.askQ}>{q.question}</Text>
          <View style={d.askOpts}>
            {q.options.map((o) => {
              const on = (picked[qi] ?? []).includes(o.label);
              return (
                <Pressable
                  key={o.label}
                  style={[d.askChip, on && d.askChipOn]}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
                  onPress={() => (single ? answer([o.label]) : toggle(qi, o.label))}
                >
                  <Text style={[d.askChipT, on && d.askChipOnT]}>{(q.multi && (picked[qi] ?? []).includes(o.label) ? "✓ " : "") + o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {!single ? (
        <Pressable
          style={[d.askSubmit, !allAnswered && { opacity: 0.4 }]}
          android_ripple={{ color: withA(c.done, 0.18), borderless: false }}
          disabled={!allAnswered}
          onPress={() => answer(qs.map((_, i) => (picked[i] ?? []).join("、")))}
        >
          <Text style={d.askSubmitT}>提交回答</Text>
        </Pressable>
      ) : null}
      {single ? (
        <View style={d.askFreeRow}>
          <TextInput
            style={d.askFree}
            value={free}
            onChangeText={setFree}
            placeholder="或输入自定义回答…"
            placeholderTextColor={c.faint}
            returnKeyType="send"
            onSubmitEditing={() => {
              if (free.trim()) answer([free.trim()]);
            }}
          />
          <Pressable
            style={[d.askFreeBtn, !freeReady && { opacity: 0.4 }]}
            android_ripple={{ color: withA(c.brandA, 0.2), borderless: false }}
            disabled={!freeReady}
            onPress={() => free.trim() && answer([free.trim()])}
          >
            <Text style={d.askFreeBtnT}>作答</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable hitSlop={8} onPress={() => store.send("COMMAND_REJECT", { session_id: sid, request_id: wr.request_id })}>
        <Text style={d.askSkip}>取消作答（视为拒绝回答）</Text>
      </Pressable>
    </View>
  );
}

// initialView（#300/#306）：外部直达目标页（待确认悬浮清单跳"任务" tab）——挂载即落位，
// 不播 tab 切换动画；缺省 "msg" 与旧行为一致
// 返回句柄（#282 顶层分发的详情侧扩展）：非消息视图时返回键先回消息页而不是退出详情
export interface DetailBackHandle {
  requestBack: () => boolean;
}

export default function DetailScreen({ sid, onBack, initialView, ref }: { sid: string; onBack: () => void; initialView?: ViewKind; ref?: Ref<DetailBackHandle> }) {
  const { c, mode } = useTheme();
  const d = useThemeStyles(makeStyles);
  // #36 权限模式四选一面板：胶囊（Head R2）点开，替代循环切换
  const [permPanel, setPermPanel] = useState(false);
  const snap = useRelay();
  const [input, setInput] = useState(() => drafts.get(sid) ?? "");
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
  // 回到底部浮钮（第五轮）：滚动中隐藏、停止 ~300ms 后浮现；atBottom/jumpScrollable 由 onScroll 维护
  const jumpIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpScrollable = useRef(false);
  useEffect(() => () => { if (jumpIdleTimer.current) clearTimeout(jumpIdleTimer.current); }, []);
  useEffect(() => { setShowJump(false); }, [view]);
  const [showThink, setShowThink] = useState(thinkShown);
  const [collapsed, setCollapsed] = useState(ctrlCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // #376 定时任务条目展开态（按任务 id）
  const [cronOpen, setCronOpen] = useState<Record<string, boolean>>({});
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
  const allScrollRef = useRef<ScrollView>(null);
  const pagerRef = useRef<ScrollView>(null);
  // 六视图滑动指示条：由翻页滚动位置原生驱动（useNativeDriver 跟手，不走 JS 线程不掉帧）
  const scrollX = useRef(new Animated.Value(0)).current;
  const [tabRowW, setTabRowW] = useState(0);
  const atBottom = useRef(true);
  // 手指按住期间暂停自动滚底：流式更新的 scrollToEnd 跳变会打断进行中的按压（chip/展开全文点不中）
  const touching = useRef(false);
  const kb = useKbHeight();
  const insets = useSafeAreaInsets();
  const s: SessionState | undefined = snap.sessions.find((x) => x.session_id === sid);

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
  // 子 Agent 运行中时本地走秒（relay 只在状态变化时推，秒数由端上自算）
  const agRunning = (s?.subagents ?? []).some((a) => !a.ended_at);
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
    const i = VIEWS.findIndex((v) => v.k === "todos");
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
  const procFont = useProcessFont();
  const procVisible = logs.filter(
    (e) =>
      (e.kind !== "thinking" || showThink) &&
      !(procFont === "hidden" && (e.kind === "tool_use" || e.kind === "tool_result" || e.kind === "system")),
  );
  const shownMsg = procVisible.filter((e) => matchFilter(e.kind, "msg", e.tool));
  const shownAll = procVisible;
  const pageShown = view === "msg" ? shownMsg : view === "all" ? shownAll : [];
  const lastEntry = pageShown.length ? pageShown[pageShown.length - 1] : null;
  const lastLen = lastEntry ? (lastEntry.full ?? lastEntry.text).length : 0;
  useEffect(() => {
    const ref = view === "msg" ? scrollRef.current : view === "all" ? allScrollRef.current : null;
    if (ref && atBottom.current && !touching.current) ref.scrollToEnd({ animated: false });
  }, [view, pageShown.length, lastLen, s?.pending_inputs?.length ?? 0, s?.status === "WORKING"]);
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));
  // 六视图横向翻页（#250/#252）：页宽=窗口宽（锁定竖屏）。tab 点击一律动画滚动；
  // 远跳（>1 页）飞行途中临时全渲染，防掠过的中间页闪空白

  const viewIdx = VIEWS.findIndex((v) => v.k === view);
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
    setView(VIEWS[i].k);
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
    const i = VIEWS.findIndex((v) => v.k === initialView);
    if (i > 0) pagerRef.current?.scrollTo({ x: i * Dimensions.get("window").width, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 指示条几何：tab 等宽分铺 tabWrap（TAB_PAD_L 左边距 + TAB_GAP 间隙），横杠宽 = 单 tab 宽，
  // 每滑一页平移 (tabW + gap)；滑到两页中间时轻微拉伸（1.3x）落位回缩，clamp 防 overscroll 过冲
  const tabW = tabRowW > 0 ? (tabRowW - TAB_PAD_L - TAB_GAP * (VIEWS.length - 1)) / VIEWS.length : 0;
  const indX = scrollX.interpolate({
    inputRange: VIEWS.map((_, i) => i * pagerW),
    outputRange: VIEWS.map((_, i) => i * (tabW + TAB_GAP)),
    extrapolate: "clamp",
  });
  const stretchIn: number[] = [0];
  const stretchOut: number[] = [1];
  for (let k = 0; k < VIEWS.length - 1; k++) {
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
          <Pressable style={d.back} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onBack} hitSlop={8}>
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
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
  const srcMeta = [external ? "" : "托管", s.historical && !external ? "历史" : "", srcName].filter(Boolean).join(" · ");
  // 上下文水位：relay 下发的当回合占用 + 按模型上限（与列表卡 mini 条、网页端同口径）
  const ctxUsed = s.context_usage ?? 0;
  const ctxLimit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const ctxPct = contextPct(ctxUsed, ctxLimit);
  // 历史托管会话：有 SDK 会话 id 就能 resume 复活（发消息即恢复），否则只读
  const resumable = !external && !!s.relay_session_id;
  const canCmd = snap.connected && (!s.historical || external || resumable);
  // #36 权限模式：胶囊四态（幽灵/点亮/警示）+ 面板直选，替代 subFilterRow 循环 chip
  const perm = (s.permission_mode ?? "default") as PermMode;
  const wr = s.waiting_request;
  // 审批横幅对称化：必须同时处于 WAITING 态（与列表卡/网页端同口径）——脱钩帧
  //（waiting_request 残留 + status 已翻走）不再渲染横幅，防"以为在等审批"的假等待
  const bannerVisible = !!wr && s.status === "WAITING" && wr.decidable !== false;
  // 状态条只保留"需要注意"的状态：出错/等待确认（横幅未兜底时）。
  // WORKING 状态行移入对话流（类 CLI），不再占顶栏
  const showStrip = s.status === "ERROR" || (s.status === "WAITING" && !bannerVisible);

  const send = (override?: string) => {
    const text = (override ?? input).trim();
    if (!text && images.length === 0 && files.length === 0) return;
    const willQueue = external && s.status === "WAITING";
    // #54/#62 外部会话同口径带附件：relay 落盘临时目录 + 注入「正文 + 路径指令」，
    // CLI 用 Read 看图/处理文件；托管会话图片走 SDK image blocks、文件走路径指令
    const ok = store.send(
      external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE",
      {
        session_id: sid, text,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
    );
    if (ok) {
      editInput("");
      setImages([]);
      setFiles([]);
      if (willQueue) flashQueuedHint();
    }
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
  const decide = (allow: boolean) => {
    if (!wr) return;
    store.send(allow ? "COMMAND_CONTINUE" : "COMMAND_REJECT", { session_id: sid, request_id: wr.request_id });
  };

  return (
    <SafeAreaView style={d.safe} edges={["top"]}>
      <View style={{ flex: 1 }}>
      {/* 头部（用户 22:14/22:20 拍板口径）：R1 = ‹ + 标题主角；R2 = 元信息行——源·时长·ctx 水位
          左聚顺排（时长在水位前），思考开关（半高）右锚最右；编辑按钮移除。
          可点元素统一圆角 8/tintSoft 底无边框 */}
      <View style={d.head}>
        <Pressable style={d.back} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onBack} hitSlop={8}>
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M15 18l-6-6 6-6" />
          </Svg>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[d.title, { flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="tail">{s.title || "未命名会话"}</Text>
          <View style={d.headMeta}>
            {srcMeta ? <Text style={[d.sub, { flexShrink: 1 }]} numberOfLines={1}>{srcMeta}</Text> : null}
            <Text style={[d.sub, { marginLeft: srcMeta ? 6 : 0, flexShrink: 0, fontVariant: ["tabular-nums"] }]}>{fmtElapsed(sessionElapsed(s))}</Text>
            {ctxUsed > 0 ? (
              <View style={d.ctxGroup}>
                <Text style={d.ctxLabel}>ctx</Text>
                <View style={d.ctxBar}>
                  <View style={{ width: `${ctxPct}%`, height: 3, borderRadius: 1.5, backgroundColor: c[contextLevel(ctxUsed, ctxLimit)] }} />
                </View>
                <Text style={[d.ctxPct, { color: c[contextLevel(ctxUsed, ctxLimit)] }]}>{ctxPct}%</Text>
              </View>
            ) : null}
            {/* #36 设置簇（右锚）：权限胶囊 + 思考开关成组——同为会话级 14px 小胶囊，
                形态语言一致。权限胶囊是"状态灯"：标准=幽灵盾标（低噪声保锚点）、
                自动/规划=品牌蓝点亮+两字短标签、跳过=waiting 红警示+盾内感叹号
                （危险档必须 ambient 常显视口顶——读转录/切 tab 都看得见） */}
            <View style={d.permCluster}>
              {!external && canCmd && !s.historical ? (
                <Pressable
                  style={[
                    d.permPill,
                    perm === "default"
                      ? [d.permPillGhost, { borderColor: mode === "dark" ? "rgba(125,165,220,0.22)" : c.line }]
                      : perm === "bypassPermissions" ? d.permPillWarn : d.permPillLit,
                  ]}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                  onPress={() => setPermPanel(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  accessibilityLabel={`权限模式：${PERM_LABEL[perm]}，点按选择`}
                >
                  <Svg
                    width={10}
                    height={10}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={perm === "default" ? c.dim : perm === "bypassPermissions" ? c.waiting : c.brandA}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <Path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
                    {perm === "bypassPermissions" ? (
                      <>
                        <Path d="M12 8.5v3.5" />
                        <Path d="M12 15.8h0.01" strokeWidth={2.6} />
                      </>
                    ) : null}
                  </Svg>
                  {perm !== "default" ? (
                    <Text style={[d.permT, perm === "bypassPermissions" && d.permTWarn]}>
                      {PERM_SHORT[perm]}
                    </Text>
                  ) : null}
                </Pressable>
              ) : null}
              {/* #56 外部会话远程审批开关：开=Bash/Edit 等门控工具的权限确认挂起到
                  手机/网页出按钮；手机离线 relay 自动回退终端本地弹框（hasClients 守卫）。
                  状态回显走 SESSION_UPDATED remote_mode（协议早已就绪，本任务只补 UI） */}
              {external && canCmd && !s.historical ? (
                <Pressable
                  style={[d.thinkToggle, s.remote_mode && d.thinkToggleOn]}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                  onPress={() => {
                    const next = !s.remote_mode;
                    if (store.send("COMMAND_EXT_MODE", { session_id: sid, enabled: next }) && next) {
                      flashHint("远程审批已开：权限确认将挂起到手机，离线自动回退终端");
                    }
                  }}
                  hitSlop={6}
                  accessibilityLabel={s.remote_mode ? "远程审批：已开，权限确认挂起到手机" : "远程审批：已关，权限确认在终端本地"}
                >
                  <Text style={[d.thinkToggleT, s.remote_mode && d.thinkToggleTOn]}>审批</Text>
                  <View style={[d.thinkSwitch, s.remote_mode && d.thinkSwitchOn]}>
                    <View style={[d.thinkSwitchKnob, s.remote_mode && { alignSelf: "flex-end" }]} />
                  </View>
                </Pressable>
              ) : null}
              <Pressable
                style={[d.thinkToggle, showThink && d.thinkToggleOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                onPress={() => { thinkShown = !thinkShown; setShowThink(thinkShown); }}
                hitSlop={6}
                accessibilityLabel={showThink ? "思考过程显示，已开" : "思考过程显示，已关"}
              >
                <Text style={[d.thinkToggleT, showThink && d.thinkToggleTOn]}>思考</Text>
                <View style={[d.thinkSwitch, showThink && d.thinkSwitchOn]}>
                  <View style={[d.thinkSwitchKnob, showThink && { alignSelf: "flex-end" }]} />
                </View>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {/* 固定工具区：状态条 + 过滤 chips。不放进 ScrollView——RN Android 吸顶头有触点丢失问题，
          且运行中自动滚底的跳变会打断按压；固定区根本不经过滚动手势系统。头部 ▴/▾ 可整体折叠 */}
      {!collapsed ? (
      <View style={d.fixedBar}>
        {showStrip ? (
            <View style={d.strip}>
              {s.status === "ERROR" ? (
                <Text style={d.stripErr} numberOfLines={2}>⚠ {s.last_error || "出错了"}</Text>
              ) : (
                <LiveStatusLine
                  summary={wr ? (wr.questions?.length ? `等待作答：${wr.questions[0]?.header ?? ""}` : `等待确认：${wr.tool_name || (wr.input_summary ?? "").slice(0, 48)}`) : "等待 CLI 输入"}
                  startedAt={wr?.received_at}
                  color={c.waiting}
                />
              )}
            </View>
          ) : null}
          {/* tab 行：模型 chip 已挪头部副信息行（#391 返工）；tabWrap 自测宽供指示条几何 */}
          <View style={d.filterRow}>
            <View style={d.tabWrap} onLayout={(e) => setTabRowW(e.nativeEvent.layout.width)}>
              {VIEWS.map((v, i) => (
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
          if (i >= 0 && i < VIEWS.length && VIEWS[i].k !== view) setView(VIEWS[i].k);
        }}
        onMomentumScrollEnd={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.x / pagerW);
          if (i >= 0 && i < VIEWS.length && VIEWS[i].k !== view) setView(VIEWS[i].k);
          progJump.current = false;
          setFlight(false);
        }}
      >
      {VIEWS.map((v, vi) => (
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
      ) : v.k === "cron" ? (
        /* 定时任务视图：会话目录 .claude/scheduled_tasks.json 快照（relay 30s 轮询下发）。
           #376 条目点击展开看 prompt 全文；cron 表达式配人话频率（未识别模式显原文） */
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 + insets.bottom, ...((s.cron_tasks?.length ?? 0) === 0 ? { flexGrow: 1, justifyContent: "center", paddingBottom: 14 + insets.bottom } : null) }} showsVerticalScrollIndicator={false}>
          {/* 空态垂直居中：内容容器 flexGrow 撑满可视面板 + justifyContent 居中提示组；
              底部 40+insets 的滚动余量在空态无意义，收成与顶部对称（14+insets）防中心偏上 */}
          {(s.cron_tasks?.length ?? 0) === 0 ? (
            <Text style={d.empty}>暂无定时任务</Text>
          ) : (
            s.cron_tasks!.map((t, i) => {
              const open = !!cronOpen[t.id];
              const desc = cronDesc(t.schedule);
              return (
                <Pressable
                  key={t.id + "|" + i}
                  style={[d.cronRow, i === 0 && { borderTopWidth: 0, marginTop: 0 }]}
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
            })
          )}
        </ScrollView>
      ) : v.k === "arts" ? (
        /* #35 输出物视图（网页端第 6 tab 同构）：新建/修改两组（组内按最后写入降序）+
           汇总行（N 个文件 · 新建 X · 修改 Y · +a −d）；行首扩展名 chip 按类型着色。
           手机端打不开电脑文件——点行弹详情 sheet 给完整路径（复制/分享），不在此行内展开 */
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 + insets.bottom, ...((s.artifacts?.length ?? 0) === 0 ? { flexGrow: 1, justifyContent: "center", paddingBottom: 14 + insets.bottom } : null) }} showsVerticalScrollIndicator={false}>
          {(s.artifacts?.length ?? 0) === 0 ? (
            /* #49：空态文案不暴露内部机制（原三分提示句移除），只留一句话（与网页端同口径）；
               #51：收录口径收窄为文档类交付物，空态措辞同步 */
            <Text style={d.empty}>当前会话还没有文档产出</Text>
          ) : (() => {
            const arts = s.artifacts!;
            const byRec = (a: ArtifactItem, b: ArtifactItem) => (b.last_at || b.first_at || 0) - (a.last_at || a.first_at || 0);
            const created = arts.filter((t) => t.op === "create").sort(byRec);
            const edited = arts.filter((t) => t.op !== "create").sort(byRec);
            const adds = arts.reduce((n, t) => n + (t.adds ?? 0), 0);
            const dels = arts.reduce((n, t) => n + (t.dels ?? 0), 0);
            const KC: Record<ArtKind, string> = { code: c.brandA, doc: c.done, data: c.working, img: c.waiting, zip: c.dim, gen: c.faint };
            const artRow = (t: ArtifactItem, i: number) => {
              const rel = artRelOf(s, t);
              const name = (rel || t.path).split(/[\\/]/).pop() || t.path;
              const dir = rel
                ? (rel.includes("/") || rel.includes("\\") ? rel.slice(0, Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1) : "")
                : t.path.slice(0, t.path.length - name.length);
              const dead = t.exists === false;
              const outside = !rel && t.origin !== "cwd";
              const kc = KC[artKindOf(name)];
              return (
                <Pressable
                  key={t.path + "|" + i}
                  style={[d.cronRow, i === 0 && { borderTopWidth: 0, marginTop: 0 }]}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onPress={() => setArtPop(t)}
                  accessibilityLabel={`输出物 ${name}，点按查看路径详情`}
                >
                  <View style={[d.artChip, { borderColor: withA(kc, 0.45) }]}>
                    <Text style={[d.artChipT, { color: kc }]}>{artExtOf(name)}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={d.artNameRow}>
                      <Text style={[d.cronName, dead && { color: c.dim }]} numberOfLines={1}>{name}</Text>
                      {dead ? <Text style={[d.artTag, { color: c.error }]}>已删除</Text> : null}
                      {outside ? <Text style={[d.artTag, { color: c.working }]}>cwd 外</Text> : null}
                    </View>
                    <Text style={d.cronMeta} numberOfLines={1}>
                      {dir ? dir + " · " : ""}+{t.adds ?? 0} −{t.dels ?? 0}{fmtArtSize(t.size) ? " · " + fmtArtSize(t.size) : ""} · {fmtArtTime(t.last_at || t.first_at)}
                    </Text>
                  </View>
                </Pressable>
              );
            };
            return (
              <>
                <View style={d.artSum}>
                  <Text style={d.artSumN}>{arts.length} 个文件</Text>
                  <Text style={d.artSumSeg}>
                    新建 <Text style={{ color: c.done, fontWeight: "700" }}>{created.length}</Text>
                    {"  ·  修改 "}
                    <Text style={{ color: c.dim, fontWeight: "700" }}>{edited.length}</Text>
                  </Text>
                  <Text style={d.artSumPm}>+{adds.toLocaleString()} −{dels.toLocaleString()}</Text>
                </View>
                {s.artifacts_truncated ? <Text style={d.artTrunc}>已截断 · 保留最新 200 条</Text> : null}
                {created.length ? <Text style={[d.artGt, { color: c.done }]}>新建 {created.length} · 本会话产出</Text> : null}
                {created.map(artRow)}
                {edited.length ? <Text style={[d.artGt, { color: c.dim }]}>修改 {edited.length}</Text> : null}
                {edited.map(artRow)}
                {/* #49：底部说明去掉"仅收录 Write/Edit…"工具清单（机制不外露）；
                    #51：补收录口径（文档类交付物），与网页端同句 */}
                <Text style={d.artFoot}>仅收录文档、表格等交付物 · 点文件可拉取到手机预览</Text>
              </>
            );
          })()}
        </ScrollView>
      ) : v.k === "stats" ? (
        /* 统计视图（原 StatsModal 内容平铺；字段与网页"统计" tab 呼应） */
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 + insets.bottom }} showsVerticalScrollIndicator={false}>
          <View style={d.statsCard}>
            <StatRow k="耗时" v={fmtElapsed(sessionElapsed(s))} />
            {s.todos?.length ? (
              <StatRow k="任务进度" v={`${s.todos.filter((t) => t.status === "completed").length}/${s.todos.length}`} />
            ) : null}
            <StatRow k="改动文件" v={String(s.stats?.files_changed ?? 0)} />
            <StatRow k="新增行" v={"+" + (s.stats?.lines_added ?? 0)} vc={c.working} />
            <StatRow k="删除行" v={"-" + (s.stats?.lines_deleted ?? 0)} vc={c.error} />
            <StatRow k="输入 tokens" v={fmtTok(s.usage?.input_tokens)} />
            <StatRow k="输出 tokens" v={fmtTok(s.usage?.output_tokens)} />
            <StatRow k="缓存读取" v={fmtTok(s.usage?.cache_read_input_tokens)} />
            <StatRow k="缓存写入" v={fmtTok(s.usage?.cache_creation_input_tokens)} />
            <StatRow k="模型" v={s.model || "—"} />
            <StatRow k="开始时间" v={fmtClock(s.started_at)} />
            <StatRow k="最近活动" v={fmtClock(s.updated_at)} />
            <StatRow k="工作目录" v={s.cwd || "—"} />
            {s.cli_pid ? <StatRow k="CLI PID" v={String(s.cli_pid)} /> : null}
          </View>
        </ScrollView>
      ) : (() => {
        // 转录页（消息/全部共用结构）：list 按页取过滤结果，跨天分隔游标随本页 map 推进
        const list = v.k === "msg" ? shownMsg : shownAll;
        let lastDay = "";
        return (
      <ScrollView
        ref={v.k === "msg" ? scrollRef : allScrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        // 空态垂直居中（同定时视图手法）：仅 list 为空时容器撑满可视面板并居中提示组，
        // 底部大 padding（横幅/命令条的滚动余量）在空态收对称，否则中心会偏上一两百 px；
        // 非空分支样式零变化
        contentContainerStyle={{ padding: 14, paddingBottom: 14 + (bannerVisible ? 200 : canCmd ? 96 : 60) + insets.bottom, ...(list.length === 0 ? { flexGrow: 1, justifyContent: "center", paddingBottom: 14 + insets.bottom } : null) }}
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
            // 跨天分隔线：与上一条可见消息不同日时插入（首条也插，标注起始日期）
            const day = e.ts ? dayKey(e.ts) : "";
            if (day && day !== lastDay) {
              nodes.push(<Text key={`day-${key}`} style={d.daySep}>── {day} ──</Text>);
            }
            if (day) lastDay = day;
            nodes.push(<TranscriptRow key={key} e={e} open={!!expanded[key]} onToggle={() => toggle(key)} onContentMenu={setMenuText} onTaskRef={openTaskRef} onTaskRefOut={outTaskRef} />);
            return nodes;
          })
        )}

        {/* 工作状态行：类 CLI 放对话流内（顶栏不再显示工作状态）；排队注入消息在其下方，
            CLI 处理（UserPromptSubmit）/回合结束时上浮为正式消息 */}
        {s.status === "WORKING" ? (
          <View style={d.liveRow}>
            <LiveStatusLine
              summary={s.compacting ? "⟳ 正在压缩上下文…" : s.action_summary}
              startedAt={s.turn_started_at ?? s.updated_at}
              color={c.working}
              // 手机屏窄：状态栏不显 ctx（2026-09-16 用户反馈）——终端转轮行长文案
              // 只挤得下几个字，ctx 占用让位（桌面端不受限照常显示）
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
        {/* 并行子 Agent 状态：主工作状态栏下方；⑂ 运行中走秒（本地计时，relay 只在变化时推）、✓ 刚结束带时长 */}
        {(s?.subagents?.length ?? 0) > 0 ? (
          <View style={[d.agBox, d.agBoxFlow]}>
            {(s!.subagents!).slice(-4).map((a) => {
              const run = !a.ended_at;
              const ms = (a.ended_at ?? Date.now()) - a.started_at;
              const dur = ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
              return (
                <View key={a.id} style={d.agRow}>
                  <Text style={[d.agT, { color: run ? c.working : c.dim }]} numberOfLines={1}>
                    {run ? "⑂" : "✓"} {a.desc}
                  </Text>
                  <Text style={[d.agTime, { color: run ? c.working : c.faint }]}>{dur}</Text>
                </View>
              );
            })}
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
      {showJump && (view === "msg" || view === "all") ? (
        <Pressable
          style={d.jumpFab}
          android_ripple={{ color: withA(c.working, 0.2), borderless: false, radius: 17 }}
          onPress={() => {
            if (jumpIdleTimer.current) clearTimeout(jumpIdleTimer.current);
            (view === "msg" ? scrollRef : allScrollRef).current?.scrollToEnd({ animated: true });
            setShowJump(false);
          }}
        >
          <Text style={d.jumpFabT}>↓</Text>
        </Pressable>
      ) : null}
      </View>

      {/* 底部栈：审批横幅（常驻可见，类似 CLI 权限提示）> 模板行 > 命令栏；整体随键盘抬升。
           外层通铺命令栏同色底（2026-09-16）：底部手势条区域不再露页面底色——输入栏
           一气通到屏幕底边；抬升=kb-2：多抬改欠抬 2px——栏下沿藏进键盘内 2px（是输入栏自己的 padding 区，
           不可见），透明缝彻底消失（2026-09-16 四测：此前多抬 P 恰好等于缝宽，方向反了） */}
      <View pointerEvents="box-none" style={{ backgroundColor: c.overlay, paddingBottom: kb > 0 ? 0 : insets.bottom, transform: [{ translateY: kb > 0 ? -(kb - 2) : 0 }] }}>
        {bannerVisible ? (
          wr!.questions?.length ? (
            <FadeIn><AskBanner wr={wr!} sid={sid} /></FadeIn>
          ) : (
          <FadeIn>
          <View style={d.waitBanner}>
            <Text style={d.waitT}>◐ 等待你的确认</Text>
            <Text style={d.waitTool}>工具 <Text style={d.waitToolName}>{wr!.tool_name}</Text></Text>
            <Text style={d.waitDesc} numberOfLines={6}>{wr!.input_summary}</Text>
            <View style={d.wbtns}>
              <PressScale style={[d.btnAllow, d.opRipple]} ripple={withA(c.done, 0.18)} haptic onPress={() => decide(true)}>
                <Text style={d.btnAllowT}>✓ 允许</Text>
              </PressScale>
              <PressScale style={[d.btnReject, d.opRipple]} ripple={withA(c.waiting, 0.18)} haptic onPress={() => decide(false)}>
                <Text style={d.btnRejectT}>✕ 拒绝</Text>
              </PressScale>
            </View>
          </View>
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
            <Pressable
              style={[d.imgBtn, d.opRipple, (!canCmd || files.length >= 2) && { opacity: 0.4 }]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
              onPress={pickFiles}
              disabled={!canCmd || files.length >= 2}
              accessibilityLabel="附加文件"
            >
              {/* 线条回形针（与相机按钮同形制） */}
              <Svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Svg>
            </Pressable>
            <Pressable
              style={[d.imgBtn, d.opRipple, (!canCmd || images.length >= 4) && { opacity: 0.4 }]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
              onPress={pickImages}
              disabled={!canCmd || images.length >= 4}
            >
              {/* 2026-09-18 与网页端统一为线条相机（原相框+山形图片图标两端不一致） */}
              <Svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke={c.dim} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M8.7 6.8l1.05-1.9a1.5 1.5 0 0 1 1.3-.75h1.9a1.5 1.5 0 0 1 1.3.75l1.05 1.9" />
                <Rect x={3.4} y={6.8} width={17.2} height={13} rx={3} />
                <Circle cx={12} cy={13.2} r={3.5} />
              </Svg>
            </Pressable>
            </>
          ) : null}
          <View style={{ flex: 1 }}>
            <TextInput
              style={d.input}
              value={input}
              onChangeText={editInput}
              placeholder={external ? "CLI忙时自动排队" : s.historical ? "继续对话（恢复会话）…" : "发送消息…"}
              placeholderTextColor={c.faint}
              editable={canCmd}
              multiline
              returnKeyType="send"
              blurOnSubmit={false}
              onSubmitEditing={() => send()}
            />
          </View>
          {voiceOn ? (
            <Pressable
              style={[d.imgBtn, listening && d.micOn, !canCmd && { opacity: 0.4 }]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
              onPressIn={() => void startVoice()}
              onPressOut={endVoice}
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

      {permPanel ? (
        <PermPanel
          cur={perm}
          onPick={(m) => store.send("COMMAND_PERM", { session_id: sid, mode: m })}
          onClose={() => setPermPanel(false)}
        />
      ) : null}

      {menuText ? <ContentMenu text={menuText} onClose={() => setMenuText(null)} /> : null}
      {artPop ? <ArtSheet art={artPop} rel={artRelOf(s, artPop)} sid={sid} onClose={() => setArtPop(null)} /> : null}
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
function StatRow({ k, v, vc }: { k: string; v: string; vc?: string }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={d.statRow}>
      <Text style={d.statRowK}>{k}</Text>
      <Text style={[d.statRowV, vc ? { color: vc } : null]}>{v}</Text>
    </View>
  );
}

// 输入法风格麦克风矢量图标：胶囊 + U 形支架 + 立柱 + 底座（替代 emoji）
function MicIcon({ color }: { color: string }) {
  return (
    <View style={{ width: 15, height: 21, alignItems: "center" }}>
      <View style={{ width: 8, height: 11, borderRadius: 4, backgroundColor: color }} />
      <View
        style={{
          position: "absolute", top: 0, width: 13, height: 12,
          borderRadius: 7.5, borderWidth: 1.5, borderBottomWidth: 0, borderColor: color,
        }}
      />
      <View style={{ width: 1.5, height: 3.5, backgroundColor: color, marginTop: 3.5 }} />
      <View style={{ width: 6, height: 1.5, borderRadius: 0.75, backgroundColor: color, marginTop: 1 }} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  // 回到底部浮钮（#322 第五轮，用户拍板）：对话区底部居中、输入框上方，正圆形
  jumpFab: {
    position: "absolute", bottom: 10, alignSelf: "center",
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, elevation: 4,
  },
  jumpFabT: { color: c.dim, fontSize: 16, fontWeight: "700", lineHeight: 18, marginTop: -1 },
  // 头部（用户拍板口径）：R1 = 返回+标题；R2 = 元信息行（源·时长·ctx 左聚 + 半高思考右锚），总高 ~60px
  head: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line,
  },
  // 返回钮：圆角 8 / tintSoft 底（与思考开关同语言）；SVG chevron 保笔画一致；overflow hidden 裁 ripple
  back: {
    width: 26, height: 26, borderRadius: 8, backgroundColor: c.tintSoft, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
  },
  hintText: { color: c.faint },
  title: { color: c.text, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  // R2 元信息行：源·时长·ctx 水位顺排左聚，思考开关 marginLeft:auto 右锚
  headMeta: { flexDirection: "row", alignItems: "center", marginTop: 3 },
  // 副信息行（头部专用）：次级信息统一档 10px dim
  sub: { color: c.dim, fontSize: 10, lineHeight: 13 },
  // 上下文占用（行内组）：标签 + 30px 细条 + 百分比，颜色按占用分级
  ctxGroup: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 8, flexShrink: 0 },
  ctxLabel: { color: c.faint, fontSize: 9.5, fontWeight: "600" },
  ctxBar: { width: 30, height: 3, borderRadius: 1.5, backgroundColor: c.tintSoft, overflow: "hidden" },
  ctxPct: { fontSize: 9.5, fontVariant: ["tabular-nums"] },
  // 统计视图卡片（原 StatsModal 内容平铺）
  statsCard: {
    borderRadius: 14, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 16,
  },
  statRow: { flexDirection: "row", justifyContent: "space-between", gap: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: withA(c.dim, 0.12) },
  statRowK: { color: c.dim, fontSize: 13 },
  statRowV: { color: c.text, fontSize: 13, fontVariant: ["tabular-nums"], textAlign: "right", flex: 1 },
  // 思考开关（R2 元信息行最右）：用户要求高度减半（26→14），文字 + 迷你滑块随档缩小；
  // 触达靠 hitSlop 补偿，圆角 8/tintSoft 底与返回钮同语言
  thinkToggle: {
    height: 14, borderRadius: 7, paddingHorizontal: 6, backgroundColor: c.tintSoft,
    borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 4,
  },
  thinkToggleOn: { borderColor: withA(c.brandA, 0.4), backgroundColor: c.tintStrong },
  thinkToggleT: { fontSize: 9, lineHeight: 10, color: c.dim },
  thinkToggleTOn: { color: c.brandA, fontWeight: "600" },
  // 开关条随 chip 减半同步缩（26x14 → 20x10）
  thinkSwitch: {
    width: 20, height: 10, borderRadius: 5, backgroundColor: c.line,
    alignItems: "flex-start", justifyContent: "center", paddingHorizontal: 1,
  },
  thinkSwitchOn: { backgroundColor: c.brandA, alignItems: "flex-end" },
  thinkSwitchKnob: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  // 固定工具区：跟随头部、不随转录滚动，底部一条分隔线与头部呼应（paddingTop 收紧贴头部）
  fixedBar: { paddingHorizontal: 14, paddingTop: 5, borderBottomWidth: 1, borderBottomColor: c.line },
  strip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginBottom: 8,
  },
  stripErr: { flex: 1, color: c.error, fontSize: 12.5, fontWeight: "600" },
  stripBtnWarn: {
    height: 26, borderRadius: 8, paddingHorizontal: 10, backgroundColor: c.panel2,
    borderWidth: 1, borderColor: withA(c.waiting, 0.3), alignItems: "center", justifyContent: "center",
  },
  stripBtnWarnT: { color: c.error, fontSize: 11, fontWeight: "600" },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 },
  statusSpin: { fontSize: 14, fontWeight: "700" },
  statusText: { flex: 1, fontSize: 12.5, fontWeight: "600" },
  statusTime: { color: c.faint, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  // 工作状态行（对话流内，类 CLI）+ 其下方的排队注入消息
  liveRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginTop: 10,
  },
  pendWrap: { flexDirection: "column", gap: 6, marginTop: 8, alignItems: "flex-end" },
  pendRow: {
    maxWidth: "86%", backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, borderTopRightRadius: 4, paddingHorizontal: 10, paddingVertical: 7,
  },
  pendT: { color: c.dim, fontSize: 12.5, lineHeight: 17 },
  // 视图 tab 行：下划线式（与网页端 tabs 同风格）；tabWrap 自测宽供指示条几何
  filterRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  tabWrap: { flex: 1, position: "relative", flexDirection: "row", gap: TAB_GAP, paddingLeft: TAB_PAD_L },
  tabBtn: { flex: 1, alignItems: "center", paddingVertical: 4, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabInd: { position: "absolute", left: TAB_PAD_L, bottom: 0, height: 2.5, borderRadius: 1.5, backgroundColor: c.brandA },
  tabT: { fontSize: 12, color: c.dim },
  tabTOn: { color: c.text, fontWeight: "600" },
  // #36 权限胶囊（R2 设置簇左位，思考开关右侧成组）：h14/r7 与思考开关同形态语言
  permCluster: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  permPill: {
    height: 14, borderRadius: 7, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4,
  },
  // 幽灵态（标准）：20px 定宽只放盾标（描边色按明暗在 JSX 注入——深色 line 太弱需提亮）
  permPillGhost: { width: 20, backgroundColor: c.tintSoft },
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
  cronRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line, marginTop: 4 },
  cronMark: { color: c.working, fontSize: 12, width: 16, textAlign: "center", lineHeight: 17 },
  cronName: { color: c.text, fontSize: 12.5, lineHeight: 17 },
  cronMeta: { color: c.faint, fontSize: 11, lineHeight: 15, marginTop: 1, fontVariant: ["tabular-nums"] },
  // #35 输出物：汇总行 / 分组头 / 扩展名 chip / 角标 / 详情 sheet（视觉审查口径：
  // 辅助信息统一 ≥10.5px 且避开 --faint 级低对比；亮暗主题走 c.* 变量自适应）
  artSum: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2, paddingBottom: 8 },
  artSumN: { color: c.text, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  artSumSeg: { color: c.dim, fontSize: 11.5 },
  artSumPm: { color: c.dim, fontSize: 11.5, fontVariant: ["tabular-nums"], marginLeft: "auto" },
  artTrunc: { color: c.working, fontSize: 11, marginTop: -4, marginBottom: 4 },
  artGt: { fontSize: 11, fontWeight: "700", marginTop: 10, marginBottom: 2 },
  artChip: { minWidth: 28, height: 20, borderRadius: 5, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, marginTop: 1 },
  artChipT: { fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  artNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  artTag: { fontSize: 10, lineHeight: 13, borderWidth: 1, borderColor: c.line, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  artFoot: { color: c.faint, fontSize: 10.5, textAlign: "center", paddingVertical: 16 },
  artBadges: { flexDirection: "row", gap: 6, marginBottom: 10 },
  artBadge: { borderWidth: 1, borderColor: c.line, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  artBadgeT: { fontSize: 10, lineHeight: 13 },
  artPathLabel: { color: c.faint, fontSize: 10.5, marginBottom: 4 },
  artPath: { color: c.text, fontSize: 12, fontFamily: "monospace", lineHeight: 17, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, backgroundColor: c.panel2 },
  artRel: { color: c.dim, fontSize: 10.5, fontFamily: "monospace", marginTop: 6 },
  artInfo: { marginTop: 12, borderTopWidth: 1, borderTopColor: c.line },
  artHint: { color: c.faint, fontSize: 10.5, textAlign: "center", marginTop: 12 },
  // #79 输出物预览全屏层（ArtView）
  avHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.line, gap: 10 },
  avName: { color: c.text, fontSize: 14, fontWeight: "600", flex: 1 },
  avSize: { color: c.faint, fontSize: 11 },
  avClose: { color: c.dim, fontSize: 18, paddingHorizontal: 6 },
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
  // 子 Agent 状态块：紧贴筛选行下方，与 todoBox 同宽同圆角
  agBox: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 2, marginBottom: 8,
  },
  agRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  agBoxFlow: { marginTop: 4, marginBottom: 10 },
  agT: { flex: 1, fontSize: 12 },
  agTime: { fontSize: 11, fontVariant: ["tabular-nums"] },
  histnote: { color: c.faint, fontSize: 11, textAlign: "center", marginBottom: 10 },
  trUser: {
    alignSelf: "flex-end", maxWidth: "85%", marginBottom: 10,
    backgroundColor: withA(c.working, 0.10), borderWidth: 1, borderColor: withA(c.working, 0.25),
    borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8,
  },
  trUserText: { color: c.text, fontSize: 14, lineHeight: 20 },
  trUserTime: { color: c.faint, fontSize: 10, textAlign: "right", marginTop: 3, fontVariant: ["tabular-nums"] },
  trMsg: { marginBottom: 10 },
  trMsgTime: { color: c.faint, fontSize: 10, marginBottom: 2, fontVariant: ["tabular-nums"] },
  daySep: { color: c.faint, fontSize: 10.5, textAlign: "center", marginVertical: 8, fontVariant: ["tabular-nums"] },
  trThink: {
    marginBottom: 8, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, overflow: "hidden",
  },
  trThinkHead: { color: c.faint, fontSize: 11.5, fontWeight: "600" },
  trThinkT: { color: c.dim, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
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
    borderRadius: 16, borderWidth: 1, borderColor: withA(c.working, 0.4),
    backgroundColor: c.panel, padding: 14,
  },
  waitT: { color: c.working, fontWeight: "700", fontSize: 13, marginBottom: 6 },
  waitTool: { color: c.text, fontSize: 13, marginBottom: 4 },
  waitToolName: { color: c.working, fontWeight: "700" },
  waitDesc: { color: c.dim, fontSize: 13, marginBottom: 12 },
  wbtns: { flexDirection: "row", gap: 10 },
  btnAllow: {
    flex: 1, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.done, 0.14), borderWidth: 1, borderColor: withA(c.done, 0.35),
  },
  btnAllowT: { color: c.done, fontWeight: "600", fontSize: 14 },
  btnReject: {
    flex: 1, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.waiting, 0.10), borderWidth: 1, borderColor: withA(c.waiting, 0.3),
  },
  btnRejectT: { color: c.waiting, fontWeight: "600", fontSize: 14 },
  // AskUserQuestion 作答横幅
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
  imgBtn: {
    width: 44, height: 44, borderRadius: 13, backgroundColor: c.panel2,
    borderWidth: 1, borderColor: c.line, alignItems: "center", justifyContent: "center",
  },
  imgBtnT: { fontSize: 17 },
  micOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.55) },
  voiceLive: {
    paddingHorizontal: 14, paddingVertical: 5,
    color: c.brandA, fontSize: 12, backgroundColor: c.overlay,
  },
  queuedHint: {
    paddingHorizontal: 14, paddingVertical: 5,
    color: c.dim, fontSize: 11, backgroundColor: c.overlay,
  },
  cmdbar: {
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.overlay, borderTopWidth: 1, borderTopColor: c.line,
    flexDirection: "row", gap: 9, alignItems: "flex-end",
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
  input: {
    flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 13,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    paddingHorizontal: 14, paddingVertical: 11, color: c.text, fontSize: 15,
  },
  // 发送按钮：两主题同规则（#48，2026-09-19）——theme.sendBg/sendLine/sendFg，
  // 与并排输入框同材质（panel2+line）+ 品牌橙 ➤（桌面端 #sendBtn 同步对齐）
  sendBtn: {
    width: 44, height: 44, borderRadius: 13, backgroundColor: c.sendBg,
    borderWidth: 1, borderColor: c.sendLine,
    alignItems: "center", justifyContent: "center",
  },
  sendT: { color: c.sendFg, fontSize: 17, lineHeight: 20, marginLeft: 2 },
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
