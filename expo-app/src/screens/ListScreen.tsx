import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Animated, Easing, FlatList, PanResponder, Pressable, RefreshControl, StyleSheet, Text, Vibration, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { statusColor, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { sessionElapsed, fmtElapsed, fmtTok, contextPct, contextLevel, CONTEXT_LIMIT_FALLBACK, isConfirmTodo } from "../fmt";
import { useListCompact } from "../display-settings";
import { store, useRelay } from "../store";
import { FadeIn, PressScale } from "../motion";
import type { SessionState } from "../protocol";
import RenameModal from "./RenameModal";
import SettingsDrawer from "./SettingsDrawer";
import type { ViewKind } from "./DetailScreen";

// 硬件返回句柄（#282）：返回键收敛为 App.tsx 顶层单订阅统一分发，抽屉/图例浮层
// 是否开着只有本组件知道——经 ref 暴露 requestBack 供父级分发时调用
export interface ListBackHandle {
  requestBack: () => boolean; // 关掉一个开着的浮层返回 true；无可关返回 false
}

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string, view?: ViewKind) => void; // view（#300）：待确认横幅跳转带 "todos" 直达任务 tab
  onNew: () => void;
  onSetup: () => void;
  onScanServer: () => void; // 抽屉「扫码添加」（#276）：开设置页直接拉起扫码
  onEditServer: (id: string) => void;
  ref?: Ref<ListBackHandle>;
}

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

// 源角标配色（#294 批2 + 审查修复）：色板/哈希与网页端 SRC_COLORS/srcColor 逐字节
// 对齐；哈希键用跨端稳定身份（store SourceStatus.colorKey：云源 relay 设备 id、
// LAN 源 wsUrl），同一台服务器在两端取到同色——本地 uuid 两端各异不可用
const SRC_COLORS = ["#D97757", "#5B9DFF", "#2BD98F", "#FFC53D", "#C792EA", "#F06292", "#4DD0E1", "#7E57C2"];
function srcColor(id: string): string {
  let h = 0;
  for (const ch of String(id)) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  return SRC_COLORS[h % SRC_COLORS.length];
}

// 源显示名（用户规则 2026-09-06，与网页端 srcDisplayName 同款）：
// 自定义名优先；缺省名（hostOf 的 IP:port 样式）显示"源+末段数字"；本机回环显示"本机"
function displaySrcName(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(n)) return "本机";
  const m = n.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$/);
  if (m) return `源${m[4]}`;
  return n;
}

// 源角标（#294 批2）：聚合且多源时区分会话归属——色点 + 源名胶囊（tag/tagExt 形态：
// 描边 + 轻染底，染底/描边按源色）；单源模式不渲染（ListScreen 侧把关）。
// #302：独立成行放卡片最底部左对齐，不与时长/±行数/ctx% 挤同行。
// id 即 colorKey（调用方传入，见 srcKeys）
function SrcBadge({ id, name }: { id: string; name: string }) {
  const styles = useThemeStyles(makeStyles);
  const color = srcColor(id);
  return (
    <View style={[styles.srcTag, { borderColor: withA(color, 0.28), backgroundColor: withA(color, 0.1) }]}>
      <View style={[styles.srcDot, { backgroundColor: color }]} />
      <Text style={styles.srcTagT} numberOfLines={1}>{name}</Text>
    </View>
  );
}

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

// cc light 风格：运行中黄灯呼吸（亮度+缩放联动，2.4s 一拍，对齐网页端呼吸灯）
function BlinkDot({ color }: { color: string }) {
  const op = useRef(new Animated.Value(1)).current;
  const sc = useRef(new Animated.Value(1)).current;
  const styles = useThemeStyles(makeStyles);
  useEffect(() => {
    const ease = Easing.inOut(Easing.quad);
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(op, { toValue: 0.45, duration: 1200, easing: ease, useNativeDriver: true }),
          Animated.timing(op, { toValue: 1, duration: 1200, easing: ease, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(sc, { toValue: 0.8, duration: 1200, easing: ease, useNativeDriver: true }),
          Animated.timing(sc, { toValue: 1, duration: 1200, easing: ease, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op, sc]);
  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: color, opacity: op, transform: [{ scale: sc }] }]}
    />
  );
}

// 黄灯旁的实时工作状态：回合耗时 · ↓输出tokens · 当前动作（每秒走秒）
function LiveStat({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - (s.turn_started_at ?? s.updated_at)) / 1000));
  const tok = s.usage?.output_tokens ?? 0;
  const head = tok > 0 ? `${secs}s · ↓ ${fmtTok(tok)}` : `${secs}s`;
  return (
    <Text style={styles.liveStat} numberOfLines={1}>
      <Text style={{ color: c.working }}>{head}</Text>
      {s.action_summary ? ` · ${s.action_summary}` : ""}
    </Text>
  );
}

// 会话耗时：WORKING 时自带每秒 tick（简洁模式没有 LiveStat，耗时也要走秒）
function Elapsed({ s }: { s: SessionState }) {
  const styles = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  const live = s.status === "WORKING";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  return <Text style={styles.elapsed}>{fmtElapsed(sessionElapsed(s))}</Text>;
}

// 左滑露出操作面板（重命名 + 删除；DONE/ERROR 才可删）。
// 面板做成独立圆角小胶囊（上下留 3px），从卡片后面滑出，避免直角贴圆角的接缝
function SwipeRow({
  sid, deletable, onPress, onRename, onDelete, revealSid, onReveal, compact, children,
}: {
  sid: string;
  deletable: boolean;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  compact?: boolean;
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
    <View style={[styles.swipeWrap, compact && styles.swipeWrapC]}>
      <View style={styles.actPanel}>
        <Pressable
          style={[styles.actBtn, styles.actRen]}
          android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }}
          onPress={() => {
            onRename();
            close();
          }}
        >
          <Text style={styles.actT}>✎</Text>
          <Text style={styles.actT2}>重命名</Text>
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
          <Text style={styles.actT2}>{deletable ? "删除" : "运行中"}</Text>
        </Pressable>
      </View>
      <Animated.View style={[styles.swipeCard, { transform: [{ translateX: x }] }]} {...pan.panHandlers}>
        <Pressable
          style={[styles.card, compact && styles.cardC]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => {
            if (open.current) close();
            else onPress();
          }}
        >
          {children}
        </Pressable>
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

// memo：流式刷新只重渲变化的那一行（onRename/onReveal/onDelete 均为稳定引用；
// srcName 为字符串原始值，浅比较按值相等，Map 重建不触发未变行重渲）
const SessionCard = memo(function SessionCard({
  s, onOpen, onRename, onDelete, revealSid, onReveal, compact, srcName, srcKey,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onRename: (sid: string) => void;
  onDelete: (sid: string) => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  compact?: boolean;
  srcName?: string | null; // 归属源名（聚合且多源时非空，#294 批2）
  srcKey?: string | null;  // 归属源跨端配色键（#294 审查修复，SrcBadge 用）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const color = statusColor(s.status, c);
  const deletable = s.status === "DONE" || s.status === "ERROR";
  return (
    <SwipeRow
      sid={s.session_id}
      deletable={deletable}
      onPress={() => onOpen(s.session_id)}
      onRename={() => onRename(s.session_id)}
      onDelete={() => onDelete(s.session_id)}
      revealSid={revealSid}
      onReveal={onReveal}
      compact={compact}
    >
      {compact ? (
        // 紧凑卡：状态点+标题+时长一行、动作摘要一行、目录/改动/水位一行——省高度但不丢信息
        <>
          <View style={styles.rowC}>
            {s.status === "WORKING" ? (
              <BlinkDot color={color} />
            ) : (
              <View style={[styles.dot, { backgroundColor: color }]} />
            )}
            <Text style={styles.titleC} numberOfLines={1}>{s.title || "未命名会话"}</Text>
            <View style={{ flex: 1 }} />
            <Elapsed s={s} />
          </View>
          <Text style={styles.sumC} numberOfLines={1}>{s.action_summary || "…"}</Text>
          <View style={styles.footC}>
            {s.cwd ? <Text style={styles.folderC} numberOfLines={1}>📁 {folderOf(s.cwd)}</Text> : null}
            <View style={{ flex: 1 }} />
            {s.stats && s.stats.files_changed > 0 ? (
              <Text style={styles.statsC}>
                <Text style={{ color: c.working }}>+{s.stats.lines_added}</Text>
                {" "}
                <Text style={{ color: c.error }}>-{s.stats.lines_deleted}</Text>
              </Text>
            ) : null}
            <CtxMini s={s} />
          </View>
          {/* #302 源角标独立成行：卡片最底部左对齐，永不与时长/±行数/ctx% 同行 */}
          {srcName && s.src ? (
            <View style={styles.srcRow}>
              <SrcBadge id={srcKey ?? s.src} name={srcName} />
            </View>
          ) : null}
        </>
      ) : (
        <>
          <View style={styles.row1}>
            {s.status === "WORKING" ? (
              <BlinkDot color={color} />
            ) : (
              <View style={[styles.dot, { backgroundColor: color }]} />
            )}
            {s.status === "WORKING" ? <LiveStat s={s} /> : <View style={{ flex: 1 }} />}
            <Elapsed s={s} />
          </View>
          <Text style={styles.title} numberOfLines={1}>
            {s.title || "未命名会话"}
          </Text>
          {s.status !== "WORKING" ? <Text style={styles.sum} numberOfLines={1}>{s.action_summary || "…"}</Text> : null}
          <View style={styles.foot}>
            <Text style={[styles.tag, s.external ? styles.tagExt : null]}>{s.external ? "外部 CLI" : "托管"}</Text>
            {s.cwd ? <Text style={styles.folderTag} numberOfLines={1}>📁 {folderOf(s.cwd)}</Text> : null}
            {s.historical && !s.external ? <Text style={styles.tag}>历史</Text> : null}
            <View style={{ flex: 1 }} />
            {s.stats && s.stats.files_changed > 0 ? (
              <Text style={styles.stats}>
                <Text style={{ color: c.working }}>+{s.stats.lines_added}</Text>
                {" "}
                <Text style={{ color: c.error }}>-{s.stats.lines_deleted}</Text>
              </Text>
            ) : null}
            <CtxMini s={s} />
          </View>
          {srcName && s.src ? (
            <View style={styles.srcRow}>
              <SrcBadge id={srcKey ?? s.src} name={srcName} />
            </View>
          ) : null}
        </>
      )}
    </SwipeRow>
  );
});

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onSetup, onScanServer, onEditServer, ref }: Props) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const snap = useRelay();
  const compact = useListCompact();
  const [revealSid, setRevealSid] = useState<string | null>(null);
  const [renameSid, setRenameSid] = useState<string | null>(null);
  const renameTarget = useMemo(
    () => sessions.find((s) => s.session_id === renameSid) ?? null,
    [sessions, renameSid],
  );
  const handleRename = useCallback((sid: string) => setRenameSid(sid), []);

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
  // 顶栏品牌区副标题：当前连接的服务器名（多源场景区分家里/公司）。
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
  // 原两处局部 BackHandler 订阅已并入 App.tsx 顶层单订阅，这里经 ref 句柄承接分发
  useImperativeHandle(ref, () => ({
    requestBack: () => {
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
  }), [drawerOpen, legendOpen]);

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
    // #294 批2：聚合时 sessions 已是全源平铺，同一比较器作用于合并列表 =
    // 源内规则保持（活跃置顶+updated_at 倒序）、源间按更新时间全局混排
    const rank = (s: SessionState) =>
      s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR" ? 0 : 1;
    return [...sessions].sort(
      (a, b) => rank(a) - rank(b) || (b.updated_at ?? b.started_at) - (a.updated_at ?? a.started_at),
    );
  }, [sessions]);

  // 聚合源角标（#294 批2）：仅聚合且源>1 时展示；id→名映射每渲染重建无妨——传入
  // SessionCard 的是查出的字符串（按值浅比较），不破坏 memo 行级重渲
  const badgeOn = snap.aggregate && snap.sources.length > 1;
  // 聚合源在线数（#294 批4）：统计行「N 源聚合」与空态「online/total 源」共用
  const onlineSrcs = snap.sources.filter((x) => x.state === "online").length;
  const srcNames = new Map(snap.sources.map((x) => [x.id, displaySrcName(x.name)] as const));
  // 源跨端配色键（#294 审查修复）：id→colorKey 同款按值传参，不破坏 memo
  const srcKeys = new Map(snap.sources.map((x) => [x.id, x.colorKey] as const));

  const counts: Record<string, number> = {};
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  const statusItems = (["WORKING", "WAITING", "ERROR", "DONE"] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ k, n: counts[k], color: statusColor(k, c) }));

  // #300 [待确认] 常驻横幅数据：pending + 含 [待确认] 标记的 todo 按会话汇总，
  // 按会话更新时间倒序（点横幅跳最新那个的详情任务 tab）。key=sid+条数拼接——
  // ✕ 已读只记当前集合，新增/完成/去标记任一变化 key 不匹配横幅自动重现
  const confirmEntries = useMemo(() => {
    const out: { sid: string; title: string; n: number; at: number }[] = [];
    for (const s of sessions) {
      const n = (s.todos ?? []).filter(isConfirmTodo).length;
      if (n > 0) out.push({ sid: s.session_id, title: s.title || "未命名会话", n, at: s.updated_at ?? s.started_at });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [sessions]);
  const confirmKey = confirmEntries.map((e) => `${e.sid}:${e.n}`).join("|");
  const confirmTotal = confirmEntries.reduce((acc, e) => acc + e.n, 0);
  // ✕ 已读（内存级 store）：集合不变不再弹；进程重启后重新提醒
  const confirmShown = confirmTotal > 0 && snap.confirmDismissedKey !== confirmKey;

  // 连接 chip 配色按 store 连接阶段：连接中/重连中 = 中性 dim（正常过程不着红色），断开才红
  const connColor =
    connected || snap.connState === "online"
      ? c.working
      : snap.connState === "connecting" || snap.connState === "reconnecting"
        ? c.dim
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
  const idleCount = counts["DONE"] ?? 0;
  const visible = useMemo(
    () => (collapseIdle ? sorted.filter((s) => s.status !== "DONE") : sorted)
      .filter((s) => s.session_id !== pendingDel && !deleting.includes(s.session_id)),
    [sorted, collapseIdle, pendingDel, deleting],
  );

  // 下拉刷新 = 断开重连一次（重走快照），在线即收起转圈；3s 兜底
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (refreshing && snap.connState === "online") setRefreshing(false);
  }, [refreshing, snap.connState]);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    store.disconnect();
    store.connect();
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
          {activeName ? <Text style={styles.titleSub} numberOfLines={1}>{activeName}</Text> : null}
        </View>
        <Pressable
          style={[styles.connChip, { borderColor: withA(connColor, 0.33) }]}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
          hitSlop={6}
          accessibilityLabel={`连接状态 ${connText}，点击立即重连`}
          onPress={() => { if (!connected) store.connect(); }}
        >
          <View style={[styles.connDot, { backgroundColor: connColor }]} />
          <Text style={[styles.connText, { color: connColor }]}>{connText}</Text>
        </Pressable>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statTotal} numberOfLines={1}>
          {sessions.length > 0 ? `${sessions.length} 会话` : "暂无会话"}
          {badgeOn ? ` · ${snap.sources.length} 源聚合` : ""}
        </Text>
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
      </View>

      {/* #300 [待确认] 常驻横幅：品牌色描边细条，点击直达最新会话详情"任务" tab；✕ 已读（内存级） */}
      {confirmShown ? (
        <FadeIn dy={4}>
          <View
            style={[
              styles.confirmBar,
              { borderColor: withA(c.brandA, 0.5), backgroundColor: withA(c.brandA, 0.1) },
            ]}
          >
            <Pressable
              style={styles.confirmHit}
              android_ripple={{ color: withA(c.brandA, 0.14), borderless: false, radius: 12 }}
              accessibilityLabel={`${confirmTotal} 项待你确认，打开任务清单`}
              onPress={() => onOpen(confirmEntries[0].sid, "todos")}
            >
              <View style={[styles.confirmBadge, { backgroundColor: withA(c.brandA, 0.22) }]}>
                <Text style={[styles.confirmBadgeT, { color: c.brandA }]}>{confirmTotal > 9 ? "9+" : confirmTotal}</Text>
              </View>
              <Text style={styles.confirmT} numberOfLines={1}>
                <Text style={{ color: c.brandA, fontWeight: "700" }}>{confirmTotal} 项待你确认</Text>
                <Text style={{ color: c.dim }}>
                  {confirmEntries.length > 1 ? ` · ${confirmEntries.length} 个会话` : ` · ${confirmEntries[0].title}`}
                </Text>
              </Text>
              <Text style={[styles.confirmGo, { color: c.brandA }]}>›</Text>
            </Pressable>
            <Pressable
              style={styles.confirmX}
              hitSlop={10}
              accessibilityLabel="关闭待确认横幅（已读）"
              onPress={() => store.dismissConfirm(confirmKey)}
            >
              <Text style={styles.confirmXT}>✕</Text>
            </Pressable>
          </View>
        </FadeIn>
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(x) => x.session_id}
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
        contentContainerStyle={{ paddingBottom: insets.bottom + 120, paddingHorizontal: 14, paddingTop: 6 }}
        onScrollBeginDrag={() => { scrollArmed.current = true; }}
        onEndReached={footRefresh}
        onEndReachedThreshold={0.2}
        ListFooterComponent={
          visible.length > 0 ? (
            <Pressable style={styles.footHint} disabled={refreshing} onPress={refresh} hitSlop={{ top: 10, bottom: 16 }}>
              <Text style={styles.footHintT}>{refreshing ? "刷新中…" : "↻ 上滑更新"}</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <SessionCard
            s={item}
            onOpen={onOpen}
            onRename={handleRename}
            onDelete={requestDelete}
            revealSid={revealSid}
            onReveal={setRevealSid}
            compact={compact}
            srcName={badgeOn && item.src ? srcNames.get(item.src) ?? null : null}
            srcKey={badgeOn && item.src ? srcKeys.get(item.src) ?? null : null}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>{collapseIdle && idleCount > 0 ? "空闲会话已折叠" : "还没有会话"}</Text>
            <Text style={styles.emptyS}>
              {collapseIdle && idleCount > 0
                ? "点上方「展开空闲」查看"
                : !connected
                  ? badgeOn
                    ? `${onlineSrcs}/${snap.sources.length} 源在线，等待自动重连\n也可点左上角图标打开设置检查配置`
                    : "未连接服务器，等待自动重连\n也可点左上角图标打开设置检查配置"
                  : badgeOn
                    ? onlineSrcs < snap.sources.length
                      ? `已连接 ${onlineSrcs}/${snap.sources.length} 源\n可在设置中检查离线服务器`
                      : `已聚合 ${snap.sources.length} 源\n点右下角 ＋ 启动新会话`
                    : "点右下角 ＋ 启动新会话\n或在 PC 上打开 claude 接入外部会话"}
            </Text>
          </View>
        }
      />

      <View style={styles.edgeZone} {...edgePan.panHandlers} />

      <PressScale style={[styles.fab, { bottom: insets.bottom + 24 }]} ripple="rgba(255,255,255,0.18)" haptic onPress={onNew}>
        <View style={styles.fabGrad}>
          <PlusMark size={20} />
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
            </View>
          </FadeIn>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: c.line,
  },
  logoBtn: { borderRadius: 12 },
  logo: {
    width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
  connChip: {
    flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1,
    borderRadius: 999, height: 28, paddingHorizontal: 10,
    backgroundColor: c.tintSoft, marginLeft: "auto",
  },
  connDot: { width: 6, height: 6, borderRadius: 3 },
  connText: { fontSize: 11 },
  titleWrap: { flexShrink: 1, marginRight: "auto" },
  titleT: { color: c.text, fontSize: 16, fontWeight: "700", letterSpacing: 0.2 },
  titleSub: { color: c.faint, fontSize: 11, marginTop: 0.5 },
  statRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4,
  },
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
  folderTag: { fontSize: 10, color: c.dim, maxWidth: 130 },
  collapseBtn: {
    marginLeft: "auto", flexShrink: 1, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  collapseBtnOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  collapseT: { fontSize: 11, color: c.dim },
  collapseTOn: { color: c.brandA },
  // #300 [待确认] 常驻横幅：统计行下细条（高 32 同 connChip 量级、圆角 12 同卡片语言），
  // 描边/染底品牌色由 JSX 注入；左徽标计数 + 主文案 + ✕ 已读
  confirmBar: {
    flexDirection: "row", alignItems: "stretch",
    marginHorizontal: 14, marginTop: 6, height: 32,
    borderWidth: 1, borderRadius: 12, overflow: "hidden",
  },
  confirmHit: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 10, paddingRight: 4 },
  confirmBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    alignItems: "center", justifyContent: "center",
  },
  confirmBadgeT: { fontSize: 10.5, fontWeight: "800", fontVariant: ["tabular-nums"] },
  confirmT: { flex: 1, fontSize: 12.5, flexShrink: 1 },
  confirmGo: { fontSize: 15, fontWeight: "700" },
  confirmX: {
    width: 34, alignItems: "center", justifyContent: "center",
    borderLeftWidth: 1, borderLeftColor: withA(c.brandA, 0.18),
  },
  confirmXT: { color: c.dim, fontSize: 12.5 },
  swipeWrap: { marginBottom: 11, borderRadius: 16, overflow: "hidden" },
  swipeWrapC: { marginBottom: 7 },
  swipeCard: { borderRadius: 16, overflow: "hidden", backgroundColor: c.panel },
  actPanel: {
    position: "absolute", top: 3, bottom: 3, right: 0, width: FULL_W,
    flexDirection: "row", borderRadius: 16, overflow: "hidden",
  },
  actBtn: { width: ACT_W, alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: withA(c.waiting, 0.9) },
  actRen: { backgroundColor: c.brandB },
  actOff: { backgroundColor: withA(c.dim, 0.3) },
  actT: { color: "#fff", fontSize: 17, fontWeight: "600" },
  actT2: { color: "#fff", fontSize: 11.5, fontWeight: "600" },
  card: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 16, padding: 14,
  },
  cardC: { borderRadius: 13, padding: 9 },
  rowC: { flexDirection: "row", alignItems: "center", gap: 7 },
  titleC: { color: c.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  sumC: { color: c.faint, fontSize: 11, marginTop: 2 },
  footC: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  folderC: { fontSize: 10, color: c.dim, flexShrink: 1, maxWidth: 120 },
  statsC: { fontSize: 10, color: c.faint, fontVariant: ["tabular-nums"] },
  row1: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  dot: {
    width: 11, height: 11, borderRadius: 6, opacity: 1,
    alignItems: "center", justifyContent: "center",
  },
  elapsed: { fontSize: 12, color: c.faint, fontVariant: ["tabular-nums"] },
  liveStat: { flex: 1, fontSize: 12, color: c.dim, fontVariant: ["tabular-nums"] },
  title: { color: c.text, fontSize: 15, fontWeight: "600", marginBottom: 5 },
  sum: { color: c.dim, fontSize: 13, marginBottom: 8 },
  foot: { flexDirection: "row", alignItems: "center", gap: 8 },
  tag: {
    fontSize: 10, color: c.dim, backgroundColor: c.tintSoft,
    borderWidth: 1, borderColor: c.line, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden",
  },
  tagExt: { color: c.brandB, backgroundColor: withA(c.brandB, 0.12), borderColor: withA(c.brandB, 0.25) },
  // 源角标（#294 批2）：tag 形态的胶囊版，染底/描边色由组件按源色注入；
  // #302 独立行容器：卡片最底部左对齐
  srcRow: { flexDirection: "row", marginTop: 4, justifyContent: "flex-end" },
  srcTag: {
    flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 96, flexShrink: 1,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden",
  },
  srcDot: { width: 6, height: 6, borderRadius: 3 },
  srcTagT: { fontSize: 10, color: c.dim, flexShrink: 1 },
  stats: { fontSize: 12, fontVariant: ["tabular-nums"] },
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
  fabGrad: {
    width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
});
