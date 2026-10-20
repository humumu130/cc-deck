// W-SPLIT-S1（docs/design-split-plan.md §3 阶段 1）：自 DetailScreen.tsx 机械抽离的自包含展示组件。
// 铁律「只搬不改」：函数体逐字未动，仅 import 接线。makeStyles 系组件（DiffBlock/
// StatRow/WaitCard 等）依赖 DetailScreen 私有样式工厂——深纠缠留原文件（见回执清单）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import { useThemeStyles } from "../theme-context";
<<<<<<< HEAD
=======
import { useProcessFont } from "../display-settings";
import { MdText } from "../md";
import { Collapse } from "../motion";
import { fmtHM } from "../fmt";
import type { LogEntry } from "../protocol";
import { Animated, Dimensions, Image, Linking, Modal, PanResponder, Pressable, TextInput } from "react-native";
import { withA } from "../theme";
import type { WaitingPayload } from "../protocol";
import { store, useRelay } from "../store";
import { fromB64, toB64 } from "../e2e";
>>>>>>> 0e5c287 (refactor: 拆分阶段 1D-②——AskBanner props 化（send/answer/snap 三回调注入，唯一批准改边界例外；DetailScreen -245 行）)
import { isLiveLine, stripLiveMark } from "../fmt";
import type { GestureResponderEvent } from "react-native";
const PEND_PHASES = [0.35, 0.5, 0.65, 0.85, 0.65, 0.5];
const WAITBOX_READONLY = false; // W-SPLIT-S1C：WaitCard 只读口径随件（值原样——语义注释见 S1 首批回执）
// W-SPLIT-S1D：过期治理 helper 随 AskBanner 迁入（值原样）
const WAITBOX_STALE_MS = 10 * 60 * 1000;
const isWaitStale = (wr?: { received_at?: number } | null): boolean =>
  !!wr?.received_at && Date.now() - wr.received_at > WAITBOX_STALE_MS;
import { makeStyles } from "./detail-styles";
import { View } from "react-native";
import { useTheme } from "../theme-context";

const DOCK_PHASES = [1, 0.72, 0.45, 0.72];

export function MicIcon({ color }: { color: string }) {
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

export function DockDot({ color, breathe }: { color: string; breathe?: boolean }) {
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!breathe) return;
    const t = setInterval(() => setPh((n) => (n + 1) % DOCK_PHASES.length), 480);
    return () => clearInterval(t);
  }, [breathe]);
  return (
    <View
      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: breathe ? DOCK_PHASES[ph] : 1 }}
      accessibilityLabel={breathe ? "运行中" : undefined}
    />
  );
}

export function CtxSegMeter({ pct, tone, cells = 20, small }: { pct: number; tone: string; cells?: number; small?: boolean }) {
  const { c } = useTheme();
  const on = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
  // W-UIFIX 件二：small 档（标题行右端用）——段 2×5/gap 1，比副题行旧档小一号
  return (
    <View style={{ flexDirection: "row", gap: small ? 1 : 1.5, alignItems: "center" }}>
      {Array.from({ length: cells }, (_, i) => (
        <View key={i} style={{ width: small ? 2 : 3, height: small ? 5 : 6, borderRadius: 1, backgroundColor: i < on ? tone : c.ctxTrack }} />
      ))}
    </View>
  );
}

// ---- W-SPLIT-S1C 二批（六件，样式经 detail-styles 解锁——只搬不改）----
// 随件工具：tpPt（触点取坐标）+SPIN_FRAMES（状态行走帧）——原文件剪切原样
const tpPt = (e: GestureResponderEvent): { x: number; y: number } | undefined => {
  const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
  return t ? { x: t.pageX, y: t.pageY } : undefined;
};

export const SPIN_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✸"];


export function TaskRefText({ text, style, numberOfLines, suffix, suffixStyle, onTaskRef, onTaskRefOut }: { text: string; style: StyleProp<TextStyle>; numberOfLines?: number; suffix?: string; suffixStyle?: StyleProp<TextStyle>; onTaskRef?: (n: number, hold?: boolean, anchor?: { x: number; y: number }) => void; onTaskRefOut?: () => void }) {
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

export function DiffBlock({ lines }: { lines: string[] }) {
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

export function LiveStatusLine({ summary, startedAt, color, tok }: { summary: string; startedAt?: number; color: string; tok?: string }) {
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

export function PendingRow({ text }: { text: string }) {
  const d = useThemeStyles(makeStyles);
  const [ph, setPh] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPh((n) => (n + 1) % PEND_PHASES.length), 600);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={[d.pendRow, { opacity: PEND_PHASES[ph] }]}>
      <Text style={d.pendT} numberOfLines={3}>{text}</Text>
    </View>
  );
}

export function WaitCard({ isAsk, children }: { isAsk: boolean; children: ReactNode }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={[d.waitBanner, isAsk ? d.waitCardAsk : d.waitCardApprove]}>
      {children}
      {WAITBOX_READONLY ? (
        <View style={d.waitRO}>
          <Text style={d.waitROT}>请在电脑上处理</Text>
        </View>
      ) : null}
    </View>
  );
}

export function StatRow({ k, v, vc, copy }: { k: string; v: string; vc?: string; copy?: boolean }) {
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  return (
    <View style={d.statRow}>
      {/* W-EXPO 005 kv-row 形制：值左（粗体 text-strong，flexShrink 截断）、标签右（dim 10px） */}
      <Text
        style={[d.statRowV, vc ? { color: vc } : null]}
        numberOfLines={1}
        onLongPress={copy ? () => {
          void Clipboard.setStringAsync(v).then(() => {
            setCopied(true);
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          });
        } : undefined}
      >{copied ? "已复制 ✓" : v}</Text>
      <Text style={d.statRowK}>{k}</Text>
    </View>
  );
}

<<<<<<< HEAD
=======
// ---- W-SPLIT-S1D（TranscriptRow 直搬——纯 props 五回调，只搬不改）----

export function TranscriptRow({ e, sid, open, onToggle, onContentMenu, onTaskRef, onTaskRefOut }: { e: LogEntry; sid?: string; open: boolean; onToggle: () => void; onContentMenu?: (text: string) => void; onTaskRef?: (n: number, hold?: boolean, anchor?: { x: number; y: number }) => void; onTaskRefOut?: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const pf = PROC_FONT[useProcessFont()];
  const cursor = e.streaming ? <Text style={{ color: c.working }}>▌</Text> : null;
  if (e.kind === "user_message") {
    // #149 长消息折叠：3 行 + tail 省略号，展开即全文（与 assistant_text 同款交互）；
    // 短消息（无 full，≤200 字 3 行内）不折叠不出现展开钮
    // W-MSGFIX（1016 实锤 20/29 字也显「展开全文」）：relay 对所有 user_message 都带
    // full（text=截断版/full=全文）——!!e.full 恒真=假折叠。改为「full 比 text 长才折叠」
    //（未截断时 text==full，长度相等即短消息不折叠不显钮）
    const long = !!e.full && e.full.length > e.text.length;
    // FB14：随消息发送的图片在气泡内缩略呈现（点按放大），不再只发不显。
    // 引用形态 img-* basename，经 COMMAND_ARTIFACT_FETCH 按需拉取（≤4 张与 relay 同口径）
    const imgs = Array.isArray(e.images) ? e.images.filter((x) => typeof x === "string" && x).slice(0, 4) : [];
    return (
      <View style={d.trUser}>
        {/* URL 链接化：拆段渲染，链接段品牌色+可点开系统浏览器（2026-09-14 用户提） */}
        <Text style={d.trUserText} selectable numberOfLines={long && !open ? 3 : undefined} ellipsizeMode="tail">
          {(open ? e.full ?? e.text : e.text).split(/(https?:\/\/[^\s<>"')\]]+)/g).map((seg, i) =>
            /^https?:\/\//.test(seg) ? (
              <Text key={i} style={{ color: c.brandA }} onPress={() => { try { Linking.openURL(seg); } catch {} }}>{seg}</Text>
            ) : (
              <Text key={i}>{seg}</Text>
            ),
          )}
        </Text>
        {imgs.length > 0 && sid ? (
          <View style={d.ubImgs}>
            {imgs.map((ref, i) => <BubbleImage key={`${i}-${ref}`} sid={sid} imgref={ref} />)}
          </View>
        ) : null}
        {long ? (
          <Pressable onPress={onToggle} hitSlop={6}>
            <Text style={d.tlExpand}>{open ? "收起 ▴" : `展开全文 ${e.full!.length} 字 ▾`}</Text>
          </Pressable>
        ) : null}
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
        {e.full && e.full.length > e.text.length ? ( /* W-MSGFIX：同 user_message——未截断（text==full）不显展开钮 */
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

// 随件：BubbleImage（TranscriptRow 子组件）
function BubbleImage({ sid, imgref }: { sid: string; imgref: string }) {
  const d = useThemeStyles(makeStyles);
  const rl = useRelay();
  const online = rl.connState === "online";
  const key = `${sid}/${imgref}`;
  const [st, setSt] = useState<BubbleImgState>(() => bubbleImgCache.get(key) ?? { state: "loading" });
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const hit = bubbleImgCache.get(key);
    if (hit) { setSt(hit); return; }
    if (!online) return; // 离线不排拉取；重连后 connState 变更重跑本 effect 自然补
    let alive = true;
    fetchBubbleImg(sid, imgref).then((s2) => { if (alive && s2.state !== "loading") setSt(s2); });
    return () => { alive = false; };
  }, [key, sid, imgref, online]);
  if (st.state === "failed") return null; // 过期/拉取失败：不占位（气泡正文 [+N 图] 有交代）
  if (st.state !== "ready" || !st.uri) return <View style={d.ubImgWait} />;
  return (
    <>
      <Pressable onPress={() => setZoom(true)} accessibilityLabel="随消息发送的图片，点按放大">
        <Image source={{ uri: st.uri }} style={d.ubImg} resizeMode="cover" />
      </Pressable>
      <Modal visible={zoom} transparent animationType="fade" onRequestClose={() => setZoom(false)}>
        <Pressable style={d.ubPreviewWrap} onPress={() => setZoom(false)} accessibilityLabel="图片放大预览，点按关闭">
          <Image source={{ uri: st.uri }} style={d.ubPreviewImg} resizeMode="contain" />
        </Pressable>
      </Modal>
    </>
  );
}
const PROC_FONT = {
  compact: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
  normal: { tool: 11.5, sys: 11, result: 11.5, thinkHead: 11.5, think: 12.5, thinkLH: 18, op: 1 },
  // 隐藏档：工具/结果/系统行整行不渲染，思考沿用紧凑小字号
  hidden: { tool: 8.5, sys: 8, result: 8.5, thinkHead: 8.5, think: 10, thinkLH: 14, op: 0.75 },
} as const;

type BubbleImgState = { state: "loading" | "ready" | "failed"; uri?: string };
const bubbleImgCache = new Map<string, BubbleImgState>();
const bubbleImgInflight = new Map<string, Promise<BubbleImgState>>();
const BUBBLE_IMG_TRANSIENT_RE = /未连接|超时/;

async function fetchBubbleImg(sid: string, ref: string): Promise<BubbleImgState> {
  const key = `${sid}/${ref}`;
  const done = bubbleImgCache.get(key);
  if (done) return done;
  const run = bubbleImgInflight.get(key);
  if (run) return run;
  const p = (async (): Promise<BubbleImgState> => {
    let st: BubbleImgState;
    try {
      const r = await store.fetchArtifact(sid, ref);
      // 分块重组：chunk 边界不保证 base64 对齐，按字节拼回再统一编码（同 fetchArtView 口径）
      const chunks = r.b64s.map(fromB64);
      let n = 0;
      for (const cc of chunks) n += cc.length;
      const u8 = new Uint8Array(n);
      let o = 0;
      for (const cc of chunks) { u8.set(cc, o); o += cc.length; }
      st = { state: "ready", uri: `data:${r.mime || "image/jpeg"};base64,${toB64(u8)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      st = BUBBLE_IMG_TRANSIENT_RE.test(msg) ? { state: "loading" } : { state: "failed" };
    }
    if (st.state !== "loading") bubbleImgCache.set(key, st);
    bubbleImgInflight.delete(key);
    return st;
  })();
  bubbleImgInflight.set(key, p);
  return p;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable); // W-SWIPEASK 圆点插值载体（随 AskBanner 迁入）

// ---- W-SPLIT-S1D-②（AskBanner props 化——唯一批准改边界：store.send 两处改
// send prop 注入，调用面原样转调；其余逐字未动）----

export function AskBanner({ wr, sid, send }: { wr: WaitingPayload; sid: string; send: (type: string, payload: Record<string, unknown>) => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  // W-ASKFIX ③：TTL 置灰——下发 90s 后 CLI 已放行本地选择器（relay QUESTION_HOLD_MS），
  // 晚答仍走 askFallback 注入可达，但 CLI 已死/终态时是死卡——置灰禁点防「点了没反应」
  const [ttlTick, setTtlTick] = useState(0);
  const askExpired = !!wr.received_at && Date.now() - wr.received_at > 90_000;
  useEffect(() => {
    if (!wr.received_at || Date.now() - wr.received_at > 90_000) return;
    const t = setTimeout(() => setTtlTick((n) => n + 1), Math.max(1000, wr.received_at! + 90_000 - Date.now()));
    return () => clearTimeout(t);
  }, [wr.request_id, wr.received_at]);
  const qs = wr.questions ?? [];
  const stale = isWaitStale(wr);
  const ro = WAITBOX_READONLY || stale;
  const single = qs.length === 1 && !qs[0].multi;
  const stepped = qs.length > 1;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [free, setFree] = useState<Record<number, string>>({});
  const [cur, setCur] = useState(0);
  // W-SWIPEASK（#157 后半）：多问题左右滑切换（微信式跟手）。swipeTo=跟手目标题索引
  // （null=非跟手态）；swipeX=进度 0..W；锁定时定方向：dx<0=看下一题（dir=1）。
  // 松手「进度过半或 vx≥0.55」spring 落位 setCur(to)，否则回弹。横占优 ≥24px 判定
  // 与域滑切/行滑删同款——纵滑（列表滚动/输入框）零冲突；单问题（!stepped）不启手势。
  const [swipeTo, setSwipeTo] = useState<number | null>(null);
  const swipeAskX = useRef(new Animated.Value(0)).current;
  const askW = () => Dimensions.get("window").width;
  const swipeRef = useRef<{ to: number; grabbed: boolean } | null>(null);
  const curQi = stepped ? Math.min(cur, qs.length - 1) : 0;
  const swipeAskPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        if (!stepped || swipeRef.current?.grabbed) return !!swipeRef.current?.grabbed;
        if (Math.abs(g.dx) < 24 || Math.abs(g.dx) <= Math.abs(g.dy) * 2) return false;
        const dir = g.dx < 0 ? 1 : -1;
        const to = curQi + dir;
        if (to < 0 || to >= qs.length) return false; // 边界 no-op
        swipeRef.current = { to, grabbed: true };
        swipeAskX.setValue(0);
        setSwipeTo(to);
        return true;
      },
      onPanResponderMove: (_e, g) => {
        const s = swipeRef.current;
        if (!s?.grabbed) return;
        const dir = s.to > curQi ? 1 : -1;
        const prog = dir === 1 ? -g.dx : g.dx; // 反向拖=回退进度
        swipeAskX.setValue(Math.max(0, Math.min(askW(), prog)));
      },
      onPanResponderRelease: (_e, g) => {
        const s = swipeRef.current;
        if (!s?.grabbed) return;
        s.grabbed = false;
        const dir = s.to > curQi ? 1 : -1;
        const prog = dir === 1 ? -g.dx : g.dx;
        const settle = prog >= askW() / 2 || (dir === 1 ? g.vx : -g.vx) <= -0.55;
        if (settle) {
          Animated.spring(swipeAskX, { toValue: askW(), speed: 20, bounciness: 6, useNativeDriver: true }).start(({ finished }) => {
            if (!finished) return;
            setCur(s.to);
            setSwipeTo(null);
            swipeRef.current = null;
            swipeAskX.setValue(0);
          });
        } else {
          Animated.spring(swipeAskX, { toValue: 0, speed: 20, bounciness: 6, useNativeDriver: true }).start(({ finished }) => {
            if (!finished) return;
            setSwipeTo(null);
            swipeRef.current = null;
          });
        }
      },
      onPanResponderTerminate: () => {
        const s = swipeRef.current;
        if (!s?.grabbed) return;
        s.grabbed = false;
        Animated.spring(swipeAskX, { toValue: 0, speed: 20, bounciness: 6, useNativeDriver: true }).start(() => {
          setSwipeTo(null);
          swipeRef.current = null;
        });
      },
    }),
  ).current;
  // 双面位移插值：当前题视差 0.35 退；目标题全跟手从侧缘进（dir 由 swipeTo 推出）
  const askDir = swipeTo === null ? 1 : swipeTo > curQi ? 1 : -1;
  const askPaneX = swipeAskX.interpolate({ inputRange: [0, 500], outputRange: [0, -askDir * 500 * 0.35], extrapolate: "clamp" });
  const askToX = swipeAskX.interpolate({ inputRange: [0, 500], outputRange: [askDir * 500, 0], extrapolate: "clamp" });
  const advTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setPicked({});
    setFree({});
    setCur(0);
    return () => { if (advTimer.current) clearTimeout(advTimer.current); };
  }, [wr.request_id]);

  const qi = stepped ? Math.min(cur, qs.length - 1) : 0;
  const q = qs[qi];
  const answered = (i: number) => (picked[i]?.length ?? 0) > 0 || !!(free[i] ?? "").trim();

  const answer = (answers: string[]) => {
    send("COMMAND_ANSWER", { session_id: sid, request_id: wr.request_id, answers });
  };
  const toggle = (tq: number, label: string) => {
    setPicked((p) => {
      const curP = p[tq] ?? [];
      const has = curP.includes(label);
      const next = qs[tq].multi
        ? has ? curP.filter((x) => x !== label) : [...curP, label]
        : has ? [] : [label];
      return { ...p, [tq]: next };
    });
  };
  // stepper 单选：选中并自动进下一题（260ms 停留让选中态可见）；末题留步等提交
  const pickSingle = (tq: number, label: string) => {
    toggle(tq, label);
    if (stepped && tq < qs.length - 1) {
      if (advTimer.current) clearTimeout(advTimer.current);
      advTimer.current = setTimeout(() => setCur(tq + 1), 260);
    }
  };
  const allAnswered = qs.every((_, i) => answered(i));
  const submit = () => {
    if (askExpired) return; // W-ASKFIX ③：过期禁点（晚答已达不了已死 CLI）
    answer(qs.map((_, i) => free[i]?.trim() || (picked[i] ?? []).join("、")));
  };
  const freeText = free[qi] ?? "";

  return (
    <WaitCard isAsk>
        {stale ? <Text style={{ color: c.faint, fontSize: 10.5, marginBottom: 4 }}>该提问已超过 10 分钟未处理，视为已失效（CLI 多已继续）</Text> : null}
      <Text style={d.waitT}>◉ Claude 在提问</Text>
      {stepped ? (
        <View style={d.askSteps}>
          <Text style={d.askCount}>{qi + 1} / {qs.length}</Text>
          {qs.map((_, i) => {
            // W-SWIPEASK：圆点跟手同步——当前点随进度淡出、目标点淡入（插值连续，
            // 落位 setCur 后 askDotCur 正常接管）
            const curFade = swipeAskX.interpolate({ inputRange: [0, 500], outputRange: [1, 0.15], extrapolate: "clamp" });
            const toFade = swipeAskX.interpolate({ inputRange: [0, 500], outputRange: [0.15, 1], extrapolate: "clamp" });
            const dynOpacity = swipeTo === null ? undefined : i === curQi ? curFade : i === swipeTo ? toFade : undefined;
            return (
              <AnimatedPressable key={i} hitSlop={7} onPress={() => setCur(i)} style={[d.askDot, answered(i) && d.askDotDone, i === qi && d.askDotCur, dynOpacity ? { opacity: dynOpacity } : null]} />
            );
          })}
        </View>
      ) : null}
      {q ? (
        <View style={{ position: "relative" }}>
          {/* W-SWIPEASK：当前题面——跟手视差退（stepped 挂手势；single 无手势） */}
          <Animated.View style={{ transform: [{ translateX: askPaneX }] }} {...(stepped ? swipeAskPan.panHandlers : {})}>
          <Text style={d.askQ}>{q.question}</Text>
          <View style={[d.askOpts, ro && d.roDim]}>
            {q.options.map((o) => {
              const on = (picked[qi] ?? []).includes(o.label);
              return (
                <Pressable
                  key={o.label}
                  style={[d.askChip, on && d.askChipOn]}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
                  disabled={ro}
                  onPress={() => (single ? answer([o.label]) : q.multi ? toggle(qi, o.label) : pickSingle(qi, o.label))}
                >
                  <Text style={[d.askChipT, on && d.askChipOnT]}>{(q.multi && on ? "✓ " : "") + o.label}</Text>
                </Pressable>
              );
            })}
          </View>
          </Animated.View>
          {/* 目标题面（跟手期）：简版（题文+选项灰显），落位后由上方正式渲染接管 */}
          {stepped && swipeTo !== null ? (
            <Animated.View style={{ position: "absolute", left: 0, right: 0, top: 0, backgroundColor: c.panel2, borderRadius: 8, padding: 6, transform: [{ translateX: askToX }] }} pointerEvents="none">
              <Text style={d.askQ}>{qs[swipeTo]?.question}</Text>
              <View style={[d.askOpts, { opacity: 0.5 }]}>
                {(qs[swipeTo]?.options ?? []).map((o) => (
                  <View key={o.label} style={d.askChip}><Text style={d.askChipT}>{o.label}</Text></View>
                ))}
              </View>
            </Animated.View>
          ) : null}
          {stepped ? (
            <TextInput
              style={[d.askFree, { marginBottom: 4 }, ro && d.roDim]}
              value={freeText}
              onChangeText={(t) => setFree((f) => ({ ...f, [qi]: t }))}
              editable={!ro}
              placeholder="或输入自定义回答…"
              placeholderTextColor={c.faint}
              returnKeyType="send"
              onSubmitEditing={() => {
                if (!freeText.trim()) return;
                if (allAnswered) submit();
                else {
                  const miss = qs.findIndex((_, i) => !answered(i));
                  if (miss >= 0) setCur(miss);
                }
              }}
            />
          ) : null}
        </View>
      ) : null}
      {!single ? (
        <Pressable
          style={[d.askSubmit, (ro || !allAnswered) && { opacity: ro ? 0.5 : 0.4 }]}
          android_ripple={{ color: withA(c.done, 0.18), borderless: false }}
          disabled={!allAnswered || ro || askExpired}
          onPress={submit}
        >
          <Text style={d.askSubmitT}>{askExpired ? "已失效（超时）" : "提交回答"}</Text>
        </Pressable>
      ) : null}
      {single ? (
        <View style={[d.askFreeRow, ro && d.roDim]}>
          <TextInput
            style={d.askFree}
            value={free[0] ?? ""}
            onChangeText={(t) => setFree((f) => ({ ...f, 0: t }))}
            editable={!ro}
            placeholder="或输入自定义回答…"
            placeholderTextColor={c.faint}
            returnKeyType="send"
            onSubmitEditing={() => {
              if ((free[0] ?? "").trim()) answer([(free[0] ?? "").trim()]);
            }}
          />
          <Pressable
            style={[d.askFreeBtn, !(free[0] ?? "").trim() && { opacity: 0.4 }]}
            android_ripple={{ color: withA(c.brandA, 0.2), borderless: false }}
            disabled={!(free[0] ?? "").trim() || ro}
            onPress={() => (free[0] ?? "").trim() && answer([(free[0] ?? "").trim()])}
          >
            <Text style={d.askFreeBtnT}>作答</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable hitSlop={8} disabled={ro} onPress={() => send("COMMAND_REJECT", { session_id: sid, request_id: wr.request_id })}>
        <Text style={d.askSkip}>取消作答（视为拒绝回答）</Text>
      </Pressable>
    </WaitCard>
  );
}
>>>>>>> 0e5c287 (refactor: 拆分阶段 1D-②——AskBanner props 化（send/answer/snap 三回调注入，唯一批准改边界例外；DetailScreen -245 行）)
