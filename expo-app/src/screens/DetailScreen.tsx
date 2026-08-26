import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { STATUS_ZH, statusColor, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { fmtElapsed, sessionElapsed } from "../fmt";
import { store, useRelay } from "../store";
import type { LogEntry, SessionState, WaitingPayload } from "../protocol";
import { useKbHeight } from "../kb";
import { MdText } from "../md";
import RenameModal from "./RenameModal";
import StatsModal from "./StatsModal";

// 快捷指令模板：点击填入输入框（不自动发送）
const TEMPLATES = ["继续", "总结当前进展", "运行测试", "提交代码"];

const LOG_FILTERS = [
  { k: "all", label: "全部" },
  { k: "tool", label: "工具" },
  { k: "msg", label: "消息" },
  { k: "sys", label: "系统" },
] as const;
type LogFilter = (typeof LOG_FILTERS)[number]["k"];

function matchFilter(kind: string, f: LogFilter): boolean {
  if (f === "all") return true;
  if (f === "tool") return kind === "tool_use" || kind === "tool_result";
  if (f === "msg") return kind === "assistant_text" || kind === "user_message" || kind === "thinking";
  return kind === "system";
}

// 思考过程显示开关：app 生命周期内记忆（跨页面切换，不落盘）
let thinkShown = false;

// 转录行：user=右气泡 / assistant=正文流式 / tool=紧凑卡片 / system=居中弱化
function TranscriptRow({ e, open, onToggle }: { e: LogEntry; open: boolean; onToggle: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const cursor = e.streaming ? <Text style={{ color: c.working }}>▌</Text> : null;
  if (e.kind === "user_message") {
    return (
      <View style={d.trUser}>
        <Text style={d.trUserText}>{e.full ?? e.text}</Text>
      </View>
    );
  }
  if (e.kind === "thinking") {
    const src = e.full ?? e.text;
    return (
      <Pressable
        style={d.trThink}
        onPress={onToggle}
        android_ripple={{ color: c.tintSoft, borderless: false }}
      >
        <Text style={d.trThinkHead}>{open ? "▾ 思考过程" : `▸ 思考过程 · ${src.length} 字`}</Text>
        {open ? <MdText src={src} style={d.trThinkT} /> : null}
      </Pressable>
    );
  }
  if (e.kind === "assistant_text") {
    return (
      <View style={d.trMsg}>
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
    return (
      <View style={d.trTool}>
        <Text style={d.trToolName}>⚙ {e.tool || "tool"}</Text>
        <Text style={d.trToolText} numberOfLines={2}>{e.text}</Text>
      </View>
    );
  }
  if (e.kind === "tool_result") {
    return <Text style={d.trResult} numberOfLines={2}>↳ {e.text}</Text>;
  }
  return <Text style={d.trSystem}>{e.text}</Text>;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  // 手指按住期间暂停自动滚底：流式更新的 scrollToEnd 跳变会打断进行中的按压（chip/展开全文点不中）
  const touching = useRef(false);
  const kb = useKbHeight();
  const insets = useSafeAreaInsets();
  const s: SessionState | undefined = snap.sessions.find((x) => x.session_id === sid);

  // 转录跟随：直接 filter 不做 useMemo（logs 引用每次更新都变）；仅当用户停在底部时自动滚
  const logs = s ? store.timelineOf(sid) : [];
  const shown = logs.filter((e) => matchFilter(e.kind, filter) && (e.kind !== "thinking" || showThink));
  const lastEntry = shown.length ? shown[shown.length - 1] : null;
  const lastLen = lastEntry ? (lastEntry.full ?? lastEntry.text).length : 0;
  useEffect(() => {
    if (atBottom.current && !touching.current && scrollRef.current) scrollRef.current.scrollToEnd({ animated: false });
  }, [shown.length, lastLen]);
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

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

  const color = statusColor(s.status, c);
  const external = !!s.external;
  const canCmd = snap.connected && !(s.historical && !external);
  const wr = s.waiting_request;
  const bannerVisible = !!wr && wr.decidable !== false;
  // 状态条只在"有事发生"时出现：运行中/出错/等待确认（横幅未兜底时）；空闲会话靠头部状态行
  const showStrip =
    s.status === "WORKING" || s.status === "ERROR" ||
    (s.status === "WAITING" && !bannerVisible) || (external && canCmd);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    const ok = store.send(external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE", { session_id: sid, text });
    if (ok) setInput("");
  };
  const decide = (allow: boolean) => {
    if (!wr) return;
    store.send(allow ? "COMMAND_CONTINUE" : "COMMAND_REJECT", { session_id: sid, request_id: wr.request_id });
  };

  return (
    <SafeAreaView style={d.safe} edges={["top"]}>
      {/* 头部：标题 + 状态副行 + 统计/重命名 */}
      <View style={d.head}>
        <Pressable style={[d.back, d.opRipple]} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onBack} hitSlop={8}>
          <Text style={d.backText}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={d.title} numberOfLines={1}>{s.title || "未命名会话"}</Text>
          <Text style={d.sub}>
            <Text style={{ color }}>{STATUS_ZH[s.status] ?? s.status}</Text>
            {" · " + (external ? "外部 CLI" : "托管") + (s.historical && !external ? " · 历史" : "") + " · " + fmtElapsed(sessionElapsed(s))}
          </Text>
        </View>
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
          且运行中自动滚底的跳变会打断按压；固定区根本不经过滚动手势系统 */}
      <View style={d.fixedBar}>
        {showStrip ? (
            <View style={d.strip}>
              {s.status === "WORKING" ? (
                <LiveStatusLine summary={s.action_summary} startedAt={s.turn_started_at ?? s.updated_at} color={c.working} />
              ) : s.status === "ERROR" ? (
                <Text style={d.stripErr} numberOfLines={2}>⚠ {s.last_error || "出错了"}</Text>
              ) : s.status === "WAITING" ? (
                <LiveStatusLine
                  summary={wr ? (wr.questions?.length ? `等待作答：${wr.questions[0]?.header ?? ""}` : `等待确认：${wr.tool_name}`) : "等待 CLI 输入"}
                  startedAt={wr?.received_at}
                  color={c.waiting}
                />
              ) : (
                <Text style={d.stripIdle} numberOfLines={1}>外部 CLI 转录</Text>
              )}
              {!external && s.status === "WORKING" ? (
                <Pressable style={[d.stripBtnWarn, d.opRipple]} android_ripple={{ color: withA(c.waiting, 0.15), borderless: false }} onPress={() => store.send("COMMAND_STOP", { session_id: sid })}>
                  <Text style={d.stripBtnWarnT}>■ 停止</Text>
                </Pressable>
              ) : null}
              {external && s.status === "WORKING" ? (
                <Pressable style={[d.stripBtnWarn, d.opRipple]} android_ripple={{ color: withA(c.waiting, 0.15), borderless: false }} onPress={() => store.send("COMMAND_EXT_STOP", { session_id: sid })}>
                  <Text style={d.stripBtnWarnT}>■ 打断</Text>
                </Pressable>
              ) : null}
              {external && canCmd ? (
                <Pressable style={[d.stripBtn, d.opRipple]} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => store.send("COMMAND_EXT_MODE", { session_id: sid, enabled: !s.remote_mode })}>
                  <Text style={d.stripBtnT}>审批 {s.remote_mode ? "开" : "关"}</Text>
                </Pressable>
              ) : null}
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
          </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
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
        {s.historical && !external ? <Text style={d.histnote}>Relay 重启前的历史会话，仅可查看</Text> : null}

        {shown.length === 0 ? (
          <Text style={d.empty}>{logs.length === 0 ? "暂无对话" : "该类型暂无内容"}</Text>
        ) : (
          shown.map((e) => {
            const key = e.id ?? `${e.ts}|${e.kind}|${e.text}`;
            return <TranscriptRow key={key} e={e} open={!!expanded[key]} onToggle={() => toggle(key)} />;
          })
        )}
      </ScrollView>

      {/* 底部栈：审批横幅（常驻可见，类似 CLI 权限提示）> 模板行 > 命令栏；整体随键盘抬升 */}
      <View pointerEvents="box-none" style={{ paddingBottom: insets.bottom, transform: [{ translateY: kb > 0 ? -kb : 0 }] }}>
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
        ) : canCmd ? (
          <View style={d.tplRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
              {TEMPLATES.map((t) => (
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
        <View style={d.cmdbar}>
          <TextInput
            style={d.input}
            value={input}
            onChangeText={setInput}
            placeholder={external ? "注入到终端（空闲时自动发送）" : "发送消息…"}
            placeholderTextColor={c.faint}
            editable={canCmd}
            multiline
          />
          <Pressable style={[d.sendBtn, (!canCmd || !input.trim()) && { opacity: 0.4 }]} android_ripple={{ color: "rgba(255,255,255,0.2)", borderless: false }} onPress={send} disabled={!canCmd}>
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
    </SafeAreaView>
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
  // 固定工具区：跟随头部、不随转录滚动，底部一条分隔线与头部呼应
  fixedBar: { paddingHorizontal: 14, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: c.line },
  strip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, marginBottom: 8,
  },
  stripErr: { flex: 1, color: c.error, fontSize: 12.5, fontWeight: "600" },
  stripIdle: { flex: 1, color: c.dim, fontSize: 12.5 },
  stripBtn: {
    height: 26, borderRadius: 8, paddingHorizontal: 10, backgroundColor: c.panel2,
    borderWidth: 1, borderColor: c.line, alignItems: "center", justifyContent: "center",
  },
  stripBtnT: { color: c.text, fontSize: 11, fontWeight: "600" },
  stripBtnWarn: {
    height: 26, borderRadius: 8, paddingHorizontal: 10, backgroundColor: c.panel2,
    borderWidth: 1, borderColor: withA(c.waiting, 0.3), alignItems: "center", justifyContent: "center",
  },
  stripBtnWarnT: { color: c.error, fontSize: 11, fontWeight: "600" },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 },
  statusSpin: { fontSize: 14, fontWeight: "700" },
  statusText: { flex: 1, fontSize: 12.5, fontWeight: "600" },
  statusTime: { color: c.faint, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  filterRow: { flexDirection: "row", gap: 7, marginBottom: 10 },
  filterChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  filterChipOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  thinkChip: { marginLeft: "auto", borderStyle: "dashed" },
  filterT: { fontSize: 11, color: c.dim },
  filterTOn: { color: c.brandA, fontWeight: "600" },
  histnote: { color: c.faint, fontSize: 11, textAlign: "center", marginBottom: 10 },
  trUser: {
    alignSelf: "flex-end", maxWidth: "85%", marginBottom: 10,
    backgroundColor: withA(c.working, 0.10), borderWidth: 1, borderColor: withA(c.working, 0.25),
    borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8,
  },
  trUserText: { color: c.text, fontSize: 14, lineHeight: 20 },
  trMsg: { marginBottom: 10 },
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
  trResult: { color: c.faint, fontSize: 11.5, marginBottom: 8, paddingLeft: 12 },
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
