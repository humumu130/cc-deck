import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Easing, FlatList, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { STATUS_ZH, statusColor, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { sessionElapsed, fmtElapsed, fmtTok } from "../fmt";
import { useListCompact } from "../display-settings";
import { store } from "../store";
import type { SessionState } from "../protocol";
import RenameModal from "./RenameModal";
import SettingsDrawer from "./SettingsDrawer";

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string) => void;
  onNew: () => void;
  onSetup: () => void;
  onEditServer: (id: string) => void;
}

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
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
    <View style={styles.swipeWrap}>
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
          style={compact ? styles.cardC : styles.card}
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

function SessionCard({
  s, onOpen, onRename, revealSid, onReveal, compact,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onRename: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  compact?: boolean;
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
      onRename={onRename}
      onDelete={() => store.send("COMMAND_DELETE", { session_id: s.session_id })}
      revealSid={revealSid}
      onReveal={onReveal}
      compact={compact}
    >
      <View style={[styles.row1, compact && { marginBottom: 3 }]}>
        {s.status === "WORKING" ? (
          <BlinkDot color={color} />
        ) : (
          <View style={[styles.dot, { backgroundColor: color, borderColor: color }]} />
        )}
        {!compact && s.status === "WORKING" ? <LiveStat s={s} /> : <View style={{ flex: 1 }} />}
        <Text style={styles.elapsed}>{fmtElapsed(sessionElapsed(s))}</Text>
      </View>
      <Text style={[styles.title, compact && { marginBottom: 0, fontSize: 14 }]} numberOfLines={1}>
        {s.title || "未命名会话"}
      </Text>
      {!compact && s.status !== "WORKING" ? <Text style={styles.sum} numberOfLines={1}>{s.action_summary || "…"}</Text> : null}
      {!compact && (
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
        </View>
      )}
    </SwipeRow>
  );
}

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onSetup, onEditServer }: Props) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const compact = useListCompact();
  const [revealSid, setRevealSid] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 抽屉打开时硬件返回先关抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setDrawerOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [drawerOpen]);

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
    // 新完成的会话紧跟活跃段，不再"闪现后跳到 20 个会话底部"像消失
    const rank = (s: SessionState) =>
      s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR" ? 0 : 1;
    return [...sessions].sort(
      (a, b) => rank(a) - rank(b) || (b.updated_at ?? b.started_at) - (a.updated_at ?? a.started_at),
    );
  }, [sessions]);

  const counts: Record<string, number> = {};
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  const statusItems = (["WORKING", "WAITING", "ERROR", "DONE"] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ k, n: counts[k], color: statusColor(k, c) }));

  const connColor = connected ? c.working : connText.includes("连接中") || connText.includes("重连") ? c.waiting : c.error;

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
    () => (collapseIdle ? sorted.filter((s) => s.status !== "DONE") : sorted),
    [sorted, collapseIdle],
  );

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
        <View style={[styles.connChip, { borderColor: withA(connColor, 0.33) }]}>
          <View style={[styles.connDot, { backgroundColor: connColor }]} />
          <Text style={[styles.connText, { color: connColor }]}>{connText}</Text>
        </View>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statTotal}>{sessions.length > 0 ? `共 ${sessions.length} 个会话` : "暂无会话"}</Text>
        <View style={styles.statChips}>
          {statusItems.map(({ k, n, color }) => (
            <View key={k} style={styles.statChip}>
              <View style={[styles.statDot, { backgroundColor: color }]} />
              <Text style={[styles.statChipT, { color }]}>{n} {STATUS_ZH[k]}</Text>
            </View>
          ))}
        </View>
        {idleCount > 0 ? (
          <Pressable
            style={[styles.collapseBtn, collapseIdle && styles.collapseBtnOn]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
            onPress={toggleCollapse}
          >
            <Text style={[styles.collapseT, collapseIdle && styles.collapseTOn]}>
              {collapseIdle ? `展开空闲 ${idleCount}` : "折叠空闲 ▾"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(x) => x.session_id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 14, paddingTop: 6 }}
        renderItem={({ item }) => (
          <SessionCard s={item} onOpen={onOpen} onRename={() => setRenameTarget(item)} revealSid={revealSid} onReveal={setRevealSid} compact={compact} />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>{collapseIdle && idleCount > 0 ? "空闲会话已折叠" : "还没有会话"}</Text>
            <Text style={styles.emptyS}>
              {collapseIdle && idleCount > 0 ? "点上方「展开空闲」查看" : "点右下角 ＋ 启动新会话\n或在 PC 上打开 claude 接入外部会话"}
            </Text>
          </View>
        }
      />

      <View style={styles.edgeZone} {...edgePan.panHandlers} />

      <Pressable
        style={styles.fab}
        android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false, radius: 30 }}
        onPress={onNew}
      >
        <View style={styles.fabGrad}>
          <PlusMark size={20} />
        </View>
      </Pressable>

      <RenameModal
        visible={!!renameTarget}
        initial={renameTarget?.title ?? ""}
        onCancel={() => setRenameTarget(null)}
        onSubmit={(title) => {
          if (renameTarget) store.send("COMMAND_RENAME", { session_id: renameTarget.session_id, title });
          setRenameTarget(null);
        }}
      />

      <SettingsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSetup={onSetup}
        onEdit={(e) => onEditServer(e.id)}
      />
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
  statRow: {
    flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6,
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4,
  },
  statTotal: { color: c.dim, fontSize: 12.5, fontWeight: "600", marginRight: 4 },
  statChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  statChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  statDot: { width: 7, height: 7, borderRadius: 4 },
  statChipT: { fontSize: 11.5 },
  folderTag: { fontSize: 10, color: c.dim, maxWidth: 130 },
  collapseBtn: {
    borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  collapseBtnOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  collapseT: { fontSize: 11, color: c.dim },
  collapseTOn: { color: c.brandA },
  swipeWrap: { marginBottom: 11, borderRadius: 16, overflow: "hidden" },
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
  cardC: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 13, padding: 9,
  },
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
  stats: { fontSize: 12, fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 42, marginBottom: 12, opacity: 0.5 },
  emptyT: { color: c.faint, fontSize: 14, marginBottom: 6 },
  emptyS: { color: c.faint, fontSize: 12, textAlign: "center", lineHeight: 20 },
  edgeZone: { position: "absolute", left: 0, top: 0, bottom: 0, width: 22, zIndex: 5 },
  fab: { position: "absolute", right: 30, bottom: 56, borderRadius: 16, elevation: 8 },
  fabGrad: {
    width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
});
