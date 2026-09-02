import { Fragment, useEffect, useRef, useState } from "react";
import { Animated, BackHandler, Image, PermissionsAndroid, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { fmtElapsed, sessionElapsed, fmtHM, dayKey } from "../fmt";
import { store, useRelay } from "../store";
import type { LogEntry, SessionState, TodoItem, WaitingPayload } from "../protocol";
import { useKbHeight } from "../kb";
import { useProcessFont } from "../display-settings";
import { usePhraseState } from "../phrases";
import { voice } from "../voice";
import { MdText } from "../md";
import RenameModal from "./RenameModal";
import StatsModal from "./StatsModal";

const LOG_FILTERS = [
  { k: "all", label: "全部" },
  { k: "tool", label: "工具" },
  { k: "msg", label: "消息" },
  { k: "sys", label: "系统" },
] as const;
type LogFilter = (typeof LOG_FILTERS)[number]["k"];

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

// 权限模式循环切换（与 relay 的 ManagedPermissionMode 对齐）
const PERM_CYCLE = ["default", "acceptEdits", "plan"] as const;
const PERM_LABEL: Record<(typeof PERM_CYCLE)[number], string> = {
  default: "标准",
  acceptEdits: "自动编辑",
  plan: "规划",
};

function matchFilter(kind: string, f: LogFilter): boolean {
  if (f === "all") return true;
  if (f === "tool") return kind === "tool_use" || kind === "tool_result";
  if (f === "msg") return kind === "assistant_text" || kind === "user_message" || kind === "thinking";
  return kind === "system";
}

// 思考过程显示开关：app 生命周期内记忆（跨页面切换，不落盘）
let thinkShown = false;

// 详情页工具区折叠开关：同样 app 生命周期内记忆
let ctrlCollapsed = false;

// 转录行：user=右气泡 / assistant=正文流式 / tool=紧凑卡片 / system=居中弱化
// 转录字号分级：过程消息（工具/结果/系统/思考）比消息（用户/assistant）小一档，可在设置抽屉调。
// 紧凑档双维度拉开差距：字号小 3px + 整体降不透明度（procOp），保证档位切换一眼可辨
const PROC_FONT = {
  compact: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
  normal: { tool: 11.5, sys: 11, result: 11.5, thinkHead: 11.5, think: 12.5, thinkLH: 18, op: 1 },
  // 隐藏档：工具/结果/系统行整行不渲染，思考沿用紧凑小字号
  hidden: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
} as const;

function TranscriptRow({ e, open, onToggle }: { e: LogEntry; open: boolean; onToggle: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const pf = PROC_FONT[useProcessFont()];
  const cursor = e.streaming ? <Text style={{ color: c.working }}>▌</Text> : null;
  if (e.kind === "user_message") {
    return (
      <View style={d.trUser}>
        <Text style={d.trUserText}>{e.full ?? e.text}</Text>
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
        {open ? <MdText src={src} style={{ ...d.trThinkT, fontSize: pf.think, lineHeight: pf.thinkLH }} /> : null}
      </Pressable>
    );
  }
  if (e.kind === "assistant_text") {
    return (
      <View style={d.trMsg}>
        {e.ts ? <Text style={d.trMsgTime}>{fmtHM(e.ts)}</Text> : null}
        <MdText src={open ? (e.full ?? e.text) : e.text} />
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
        <Pressable style={[d.trTool, { opacity: pf.op }]} onPress={onToggle} android_ripple={{ color: c.tintSoft, borderless: false }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
              <Text style={[d.trToolName, { fontSize: pf.tool }]}>⚙ {e.tool || "tool"}</Text>
              <Text style={[d.trToolText, { fontSize: pf.tool }]} numberOfLines={1}>{e.text}</Text>
            </View>
            {open ? <Text style={d.trDetail} selectable>{e.detail}</Text> : null}
          </View>
          <Text style={d.tlExpand}>{open ? "▴" : "▾"}</Text>
        </Pressable>
      );
    }
    return (
      <View style={[d.trTool, { opacity: pf.op }]}>
        <Text style={[d.trToolName, { fontSize: pf.tool }]}>⚙ {e.tool || "tool"}</Text>
        <Text style={[d.trToolText, { fontSize: pf.tool }]} numberOfLines={2}>{e.text}</Text>
      </View>
    );
  }
  if (e.kind === "tool_result") {
    if (e.diff && e.diff.length > 0) {
      return (
        <Pressable style={[d.trDiffWrap, { opacity: pf.op }]} onPress={onToggle} android_ripple={{ color: c.tintSoft, borderless: false }}>
          <Text style={[d.trResult, { fontSize: pf.result }]} numberOfLines={open ? undefined : 1}>
            ↳ {open ? "收起变更 ▴" : `变更 · ${e.diff.filter((l) => l.startsWith("+")).length}+ ${e.diff.filter((l) => l.startsWith("-")).length}− ▾`}
          </Text>
          {open ? <DiffBlock lines={e.diff} /> : null}
        </Pressable>
      );
    }
    if (e.detail) {
      return (
        <Pressable onPress={onToggle} hitSlop={4} style={{ opacity: pf.op }}>
          <Text style={[d.trResult, { fontSize: pf.result }]} numberOfLines={open ? undefined : 2}>
            ↳ {e.text} <Text style={d.tlExpand}>{open ? "收起 ▴" : "展开 ▾"}</Text>
          </Text>
          {open ? <Text style={d.trDetail} selectable>{e.detail}</Text> : null}
        </Pressable>
      );
    }
    return <Text style={[d.trResult, { fontSize: pf.result, opacity: pf.op }]} numberOfLines={2}>↳ {e.text}</Text>;
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

const SPIN_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✸"];

// 类 Claude Code 状态行：✶ 摘要 · Ns（每秒走帧）。无边框，嵌入状态条内。
function LiveStatusLine({ summary, startedAt, color }: { summary: string; startedAt?: number; color: string }) {
  const d = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const secs = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const frame = SPIN_FRAMES[Math.floor(Date.now() / 500) % SPIN_FRAMES.length];
  const m = Math.floor(secs / 60);
  const timeText = m > 0 ? `${m}m${secs % 60}s` : `${secs}s`;
  return (
    <View style={d.statusLine}>
      <Text style={[d.statusSpin, { color }]}>{frame}</Text>
      <Text style={[d.statusText, { color }]} numberOfLines={1}>{summary || "思考中…"}</Text>
      {startedAt ? <Text style={d.statusTime}>· {timeText}</Text> : null}
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

export default function DetailScreen({ sid, onBack }: { sid: string; onBack: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [input, setInput] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [filter, setFilter] = useState<LogFilter>("msg");
  const [showThink, setShowThink] = useState(thinkShown);
  const [collapsed, setCollapsed] = useState(ctrlCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [todoOpen, setTodoOpen] = useState(false);
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
  const [queuedHint, setQueuedHint] = useState<string | null>(null);
  const flashQueuedHint = () => {
    setQueuedHint("已排队，确认/回合结束后自动发送");
    setTimeout(() => setQueuedHint(null), 4000);
  };
  const [picking, setPicking] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
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
  const todoRank = (t: TodoItem) => (t.status === "completed" ? 0 : t.status === "in_progress" ? 1 : 2);
  const allTodos = (s?.todos ?? []).filter((t) => !todoHidden.includes(t.content));
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
  const sortedTodos = [...doneList, ...allTodos.filter((t) => t.status !== "completed")].sort(
    (a, b) => todoRank(a) - todoRank(b),
  );
  const todoGroups = [
    { status: "completed", label: `已完成 ${doneList.length}/${doneAll.length}${doneNote}` },
    { status: "in_progress", label: `进行中 ${allTodos.filter((t) => t.status === "in_progress").length}` },
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

  const renderTodo = (t: TodoItem, i: number, grouped: boolean) => (
    <View style={[d.todoRow, grouped && { borderTopWidth: 0, marginTop: 0 }]}>
      <Text
        style={[
          d.todoMark,
          t.status === "completed" && { color: c.done },
          t.status === "in_progress" && { color: c.working },
        ]}
      >
        {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}
      </Text>
      <Text
        style={[
          d.todoT,
          t.status === "pending" && { color: c.faint },
          t.status === "in_progress" && { color: c.text, fontWeight: "700" },
          t.status === "completed" && { color: c.dim },
        ]}
        numberOfLines={2}
      >
        {t.status === "in_progress" && t.active_form ? t.active_form : t.content}
      </Text>
      <Pressable
        style={d.todoDel}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
        onPress={() => hideTodo(t.content)}
      >
        <Text style={d.todoDelT}>✕</Text>
      </Pressable>
    </View>
  );

  // 转录跟随：直接 filter 不做 useMemo（logs 引用每次更新都变）；仅当用户停在底部时自动滚
  const logs = s ? store.timelineOf(sid) : [];
  const procFont = useProcessFont();
  const shown = logs.filter(
    (e) =>
      matchFilter(e.kind, filter) &&
      (e.kind !== "thinking" || showThink) &&
      !(procFont === "hidden" && (e.kind === "tool_use" || e.kind === "tool_result" || e.kind === "system")),
  );
  const lastEntry = shown.length ? shown[shown.length - 1] : null;
  const lastLen = lastEntry ? (lastEntry.full ?? lastEntry.text).length : 0;
  useEffect(() => {
    if (atBottom.current && !touching.current && scrollRef.current) scrollRef.current.scrollToEnd({ animated: false });
  }, [shown.length, lastLen, s?.pending_inputs?.length ?? 0, s?.status === "WORKING"]);
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));
  // 跨天分隔线的游标：每次渲染从空开始，随 map 推进
  let lastDay = "";

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  // 语音输入状态与事件订阅（钩子须在下方早退 return 之前）
  const phrases = usePhraseState().list;
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  // partial 只进独立的单行字幕条，不动输入框内容（避免高度跳变）
  const [voiceText, setVoiceText] = useState("");
  const voiceRef = useRef({ partial: "", final: "", resolved: false });
  useEffect(() => {
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
  }, []);

  if (!s) {
    return (
      <SafeAreaView style={d.safe} edges={["top"]}>
        <View style={d.head}>
          <Pressable style={d.back} onPress={onBack}><Text style={d.backText}>‹</Text></Pressable>
          <Text style={d.hintText}>会话已消失</Text>
        </View>
      </SafeAreaView>
    );
  }

  const external = !!s.external;
  // 历史托管会话：有 SDK 会话 id 就能 resume 复活（发消息即恢复），否则只读
  const resumable = !external && !!s.relay_session_id;
  const canCmd = snap.connected && (!s.historical || external || resumable);
  const wr = s.waiting_request;
  const bannerVisible = !!wr && wr.decidable !== false;
  // 状态条只保留"需要注意"的状态：出错/等待确认（横幅未兜底时）。
  // WORKING 状态行移入对话流（类 CLI），不再占顶栏
  const showStrip = s.status === "ERROR" || (s.status === "WAITING" && !bannerVisible);

  const send = (override?: string) => {
    const text = (override ?? input).trim();
    if (!text && images.length === 0) return;
    const willQueue = external && s.status === "WAITING";
    const ok = store.send(
      external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE",
      external
        ? { session_id: sid, text }
        : { session_id: sid, text, ...(images.length > 0 ? { images } : {}) },
    );
    if (ok) {
      setInput("");
      setImages([]);
      if (willQueue) flashQueuedHint();
    }
  };

  // 语音输入：按住说话，partial 实时上字幕条，松手 stopListening 等 final 发送（超时兜底用 partial）
  const setVoiceHintOnce = (t: string) => {
    setVoiceHint(t);
    setTimeout(() => setVoiceHint(null), 3500);
  };
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
  const decide = (allow: boolean) => {
    if (!wr) return;
    store.send(allow ? "COMMAND_CONTINUE" : "COMMAND_REJECT", { session_id: sid, request_id: wr.request_id });
  };

  return (
    <SafeAreaView style={d.safe} edges={["top"]}>
      {/* 点任务面板外任意处自动折起（任务框内 stopPropagation 防误触） */}
      <View style={{ flex: 1 }} onTouchStart={() => { if (todoOpen) setTodoOpen(false); }}>
      {/* 头部：标题 + 状态副行 + 统计/重命名 */}
      <View style={d.head}>
        <Pressable style={[d.back, d.opRipple]} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onBack} hitSlop={8}>
          <Text style={d.backText}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={d.title} numberOfLines={1}>{s.title || "未命名会话"}</Text>
          <Text style={d.sub}>
            {(external ? "外部 CLI" : "托管") + (s.historical && !external ? " · 历史" : "") + " · " + fmtElapsed(sessionElapsed(s))}
          </Text>
        </View>
        <Pressable
          style={[d.foldBtn, d.opRipple]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => {
            ctrlCollapsed = !ctrlCollapsed;
            setCollapsed(ctrlCollapsed);
          }}
          hitSlop={4}
        >
          <Text style={d.foldT}>{collapsed ? "▼" : "▲"}</Text>
        </Pressable>
        <Pressable
          style={[d.statsBtn, d.opRipple]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => setStatsOpen(true)}
          hitSlop={4}
        >
          <Text style={d.statsT}>统计</Text>
        </Pressable>
        <Pressable
          style={[d.editBtn, d.opRipple]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => setRenaming(true)}
          hitSlop={8}
        >
          <Text style={d.editT}>✎</Text>
        </Pressable>
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
                  summary={wr ? (wr.questions?.length ? `等待作答：${wr.questions[0]?.header ?? ""}` : `等待确认：${wr.tool_name}`) : "等待 CLI 输入"}
                  startedAt={wr?.received_at}
                  color={c.waiting}
                />
              )}
            </View>
          ) : null}
          <View style={d.filterRow}>
            {LOG_FILTERS.map((f) => (
              <Pressable
                key={f.k}
                style={[d.filterChip, filter === f.k && d.filterChipOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                onPress={() => setFilter(f.k)}
              >
                <Text style={[d.filterT, filter === f.k && d.filterTOn]}>{f.label}</Text>
              </Pressable>
            ))}
            <Pressable
              style={[d.filterChip, d.thinkChip, showThink && d.filterChipOn]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
              onPress={() => {
                thinkShown = !thinkShown;
                setShowThink(thinkShown);
              }}
            >
              <Text style={[d.filterT, showThink && d.filterTOn]}>思考{showThink ? " ·开" : " ·关"}</Text>
            </Pressable>
            {!external && canCmd && !s.historical ? (
              <Pressable
                style={[d.filterChip, d.thinkChip, (s.permission_mode ?? "default") !== "default" && d.filterChipOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                onPress={() => {
                  const cur = s.permission_mode ?? "default";
                  const next = PERM_CYCLE[(PERM_CYCLE.indexOf(cur) + 1) % PERM_CYCLE.length];
                  store.send("COMMAND_PERM", { session_id: sid, mode: next });
                }}
              >
                <Text style={[d.filterT, (s.permission_mode ?? "default") !== "default" && d.filterTOn]}>权限·{PERM_LABEL[s.permission_mode ?? "default"]}</Text>
              </Pressable>
            ) : null}
          </View>
          {(s.todos?.length ?? 0) > 0 ? (
            <View style={d.todoBox} onTouchStart={(e) => e.stopPropagation()}>
              <Pressable
                style={d.todoHead}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                onPress={() => { todoAtBottom.current = true; setTodoOpen((v) => !v); }}
              >
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
                <Text style={d.todoCaret}>{todoOpen ? "▾" : "▸"}</Text>
              </Pressable>
              {todoOpen ? (
                <View style={d.todoScrollWrap}>
                <ScrollView
                  ref={todoScrollRef}
                  style={d.todoScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  scrollEventThrottle={16}
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
                    const g = todoGroups.find((x) => x.status === t.status)!;
                    const head = i === 0 || sortedTodos[i - 1].status !== t.status ? g : null;
                    return (
                      <Fragment key={i}>
                        {head ? (
                          <View style={d.todoSec}>
                            <View style={d.todoSecLine} />
                            <Text
                              style={[
                                d.todoSecT,
                                t.status === "completed" && { color: c.done },
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
              ) : null}
            </View>
          ) : null}
      </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 14, paddingBottom: 14 + (bannerVisible ? 200 : canCmd ? 96 : 60) + insets.bottom }}
        onTouchStart={() => { touching.current = true; }}
        onTouchEnd={() => { touching.current = false; }}
        onTouchCancel={() => { touching.current = false; }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        }}
        scrollEventThrottle={120}
      >
        {s.historical && !external ? (
          <Text style={d.histnote}>{resumable ? "历史会话 · 发送消息将恢复继续（SDK resume）" : "Relay 重启前的历史会话，仅可查看"}</Text>
        ) : null}

        {shown.length === 0 ? (
          <Text style={d.empty}>{logs.length === 0 ? "暂无对话" : "该类型暂无内容"}</Text>
        ) : (
          shown.map((e) => {
            const key = e.id ?? `${e.ts}|${e.kind}|${e.text}`;
            const nodes = [];
            // 跨天分隔线：与上一条可见消息不同日时插入（首条也插，标注起始日期）
            const day = e.ts ? dayKey(e.ts) : "";
            if (day && day !== lastDay) {
              nodes.push(<Text key={`day-${key}`} style={d.daySep}>── {day} ──</Text>);
            }
            if (day) lastDay = day;
            nodes.push(<TranscriptRow key={key} e={e} open={!!expanded[key]} onToggle={() => toggle(key)} />);
            return nodes;
          })
        )}

        {/* 工作状态行：类 CLI 放对话流内（顶栏不再显示工作状态）；排队注入消息在其下方，
            CLI 处理（UserPromptSubmit）/回合结束时上浮为正式消息 */}
        {s.status === "WORKING" ? (
          <View style={d.liveRow}>
            <LiveStatusLine summary={s.action_summary} startedAt={s.turn_started_at ?? s.updated_at} color={c.working} />
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

      {/* 底部栈：审批横幅（常驻可见，类似 CLI 权限提示）> 模板行 > 命令栏；整体随键盘抬升 */}
      <View pointerEvents="box-none" style={{ paddingBottom: kb > 0 ? 0 : insets.bottom, transform: [{ translateY: kb > 0 ? -kb : 0 }] }}>
        {bannerVisible ? (
          wr!.questions?.length ? (
            <AskBanner wr={wr!} sid={sid} />
          ) : (
          <View style={d.waitBanner}>
            <Text style={d.waitT}>◐ 等待你的确认</Text>
            <Text style={d.waitTool}>工具 <Text style={d.waitToolName}>{wr!.tool_name}</Text></Text>
            <Text style={d.waitDesc} numberOfLines={6}>{wr!.input_summary}</Text>
            <View style={d.wbtns}>
              <Pressable style={[d.btnAllow, d.opRipple]} android_ripple={{ color: withA(c.done, 0.18), borderless: false }} onPress={() => decide(true)}>
                <Text style={d.btnAllowT}>✓ 允许</Text>
              </Pressable>
              <Pressable style={[d.btnReject, d.opRipple]} android_ripple={{ color: withA(c.waiting, 0.18), borderless: false }} onPress={() => decide(false)}>
                <Text style={d.btnRejectT}>✕ 拒绝</Text>
              </Pressable>
            </View>
          </View>
          )
        ) : canCmd && phrases.length > 0 ? (
          <View style={d.tplRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
              {phrases.map((t) => (
                <Pressable
                  key={t}
                  style={d.tplChip}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
                  onPress={() => setInput(t)}
                >
                  <Text style={d.tplT}>{t}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
        {images.length > 0 ? (
          <View style={d.imgRow}>
            {images.map((b, i) => (
              <View key={i} style={d.imgCell}>
                <Image style={d.imgThumb} source={{ uri: `data:image/jpeg;base64,${b}` }} />
                <Pressable style={d.imgDel} android_ripple={{ color: "rgba(0,0,0,0.3)", borderless: false, radius: 10 }} onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                  <Text style={d.imgDelT}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {queuedHint ? (
          <Text style={d.queuedHint}>{queuedHint}</Text>
        ) : null}
        {voiceHint ? (
          <Text style={d.queuedHint}>{voiceHint}</Text>
        ) : null}
        {listening ? (
          <Text style={d.voiceLive} numberOfLines={1}>
            {voiceText || "正在听，松开发送…"}
          </Text>
        ) : null}
        <View style={d.cmdbar}>
          {!external && !s.historical ? (
            <Pressable
              style={[d.imgBtn, d.opRipple, (!canCmd || images.length >= 4) && { opacity: 0.4 }]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
              onPress={pickImages}
              disabled={!canCmd || images.length >= 4}
            >
              <Text style={d.imgBtnT}>📷</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={d.input}
            value={input}
            onChangeText={setInput}
            placeholder={external ? "CLI忙时自动排队" : s.historical ? "继续对话（恢复会话）…" : "发送消息…"}
            placeholderTextColor={c.faint}
            editable={canCmd}
            multiline
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => send()}
          />
          <Pressable
            style={[d.imgBtn, listening && d.micOn, !canCmd && { opacity: 0.4 }]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
            onPressIn={() => void startVoice()}
            onPressOut={endVoice}
            disabled={!canCmd}
          >
            <MicIcon color={listening ? c.brandA : c.dim} />
          </Pressable>
          <Pressable style={[d.sendBtn, (!canCmd || (!input.trim() && images.length === 0)) && { opacity: 0.4 }]} android_ripple={{ color: "rgba(255,255,255,0.2)", borderless: false }} onPress={() => send()} disabled={!canCmd}>
            <Text style={d.sendT}>➤</Text>
          </Pressable>
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
      <StatsModal visible={statsOpen} s={s} onCancel={() => setStatsOpen(false)} />
      </View>
    </SafeAreaView>
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
  head: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line,
  },
  back: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.tintSoft, alignItems: "center", justifyContent: "center" },
  backText: { color: c.dim, fontSize: 20, marginTop: -2 },
  hintText: { color: c.faint },
  title: { color: c.text, fontSize: 15, fontWeight: "600" },
  sub: { color: c.dim, fontSize: 11, marginTop: 1 },
  statsBtn: {
    height: 26, borderRadius: 8, paddingHorizontal: 9, backgroundColor: c.tintSoft,
    borderWidth: 1, borderColor: c.line, alignItems: "center", justifyContent: "center", marginLeft: 6,
  },
  statsT: { color: c.dim, fontSize: 11, fontWeight: "600" },
  editBtn: {
    width: 30, height: 30, borderRadius: 9, backgroundColor: c.tintSoft,
    borderWidth: 1, borderColor: c.line, alignItems: "center", justifyContent: "center",
  },
  editT: { color: c.dim, fontSize: 14, marginTop: -1 },
  // 折叠开关：用选中态视觉（品牌色）——它切换的是整个工具区，比 ✎ 更该被看见
  foldBtn: {
    width: 30, height: 30, borderRadius: 9, backgroundColor: c.tintStrong,
    borderWidth: 1, borderColor: withA(c.brandA, 0.4), alignItems: "center", justifyContent: "center",
  },
  foldT: { color: c.brandA, fontSize: 11, marginTop: -1 },
  // 固定工具区：跟随头部、不随转录滚动，底部一条分隔线与头部呼应
  fixedBar: { paddingHorizontal: 14, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: c.line },
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
  filterRow: { flexDirection: "row", gap: 7, marginBottom: 10 },
  filterChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  filterChipOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  thinkChip: { marginLeft: "auto", borderStyle: "dashed" },
  filterT: { fontSize: 11, color: c.dim },
  filterTOn: { color: c.brandA, fontWeight: "600" },
  // todo 面板：折叠只占一行（标题+进度条），展开列任务清单
  todoBox: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 6, marginBottom: 10,
  },
  todoHead: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 4 },
  todoHeadT: { color: c.dim, fontSize: 11.5, fontWeight: "600" },
  todoBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: c.tintSoft, overflow: "hidden" },
  todoBarFill: { height: 4, borderRadius: 2, backgroundColor: c.done },
  todoRefresh: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  todoRefreshT: { color: c.dim, fontSize: 14, lineHeight: 16 },
  todoCaret: { color: c.faint, fontSize: 11, width: 14, textAlign: "center" },
  todoScrollWrap: { position: "relative" },
  todoThumb: { position: "absolute", right: 1, top: 2, width: 3, borderRadius: 2, backgroundColor: withA(c.text, 0.28) },
  todoSec: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 9, marginBottom: 1 },
  todoSecLine: { flex: 1, height: 1, backgroundColor: c.line },
  todoSecT: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.5 },
  todoRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 5, borderTopWidth: 1, borderTopColor: c.line, marginTop: 5 },
  todoScroll: { maxHeight: 400, flexGrow: 0 },
  todoMark: { color: c.faint, fontSize: 12, width: 16, textAlign: "center", lineHeight: 17 },
  todoT: { flex: 1, color: c.text, fontSize: 12.5, lineHeight: 17 },
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
  tplRow: {
    flexDirection: "row", backgroundColor: c.overlay,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 10, paddingTop: 7,
  },
  tplChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 13,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
  },
  tplT: { fontSize: 12, color: c.dim },
  // 待发图片：缩略图行（可删除）+ 相册按钮
  imgRow: {
    flexDirection: "row", gap: 8, backgroundColor: c.overlay,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 12, paddingTop: 9,
  },
  imgCell: { width: 52, height: 52 },
  imgThumb: { width: 52, height: 52, borderRadius: 10 },
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
  input: {
    flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 13,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    paddingHorizontal: 14, paddingVertical: 11, color: c.text, fontSize: 15,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 13, backgroundColor: c.brandA,
    alignItems: "center", justifyContent: "center",
  },
  sendT: { color: "#fff", fontSize: 17 },
});
