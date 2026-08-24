import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, FlatList, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { STATUS_ZH, statusColor, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { sessionElapsed, fmtElapsed } from "../fmt";
import { store } from "../store";
import type { SessionState } from "../protocol";
import RenameModal from "./RenameModal";

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string) => void;
  onNew: () => void;
  onSetup: () => void;
}

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const ACT_W = 78;    // 单个操作按钮宽
const FULL_W = 156;  // 操作面板总宽（重命名 + 删除）

// cc light 风格：运行中黄灯闪烁
function BlinkDot({ color }: { color: string }) {
  const op = useRef(new Animated.Value(1)).current;
  const styles = useThemeStyles(makeStyles);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0.25, duration: 550, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op]);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: op }]} />;
}

// 左滑露出操作面板（重命名 + 删除；DONE/ERROR 才可删）。
// 面板做成独立圆角小胶囊（上下留 3px），从卡片后面滑出，避免直角贴圆角的接缝
function SwipeRow({
  sid, deletable, onPress, onRename, onDelete, revealSid, onReveal, children,
}: {
  sid: string;
  deletable: boolean;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
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
          style={styles.card}
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
  s, onOpen, onRename, revealSid, onReveal,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onRename: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
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
    >
      <View style={styles.row1}>
        {s.status === "WORKING" ? (
          <BlinkDot color={color} />
        ) : (
          <View style={[styles.dot, { backgroundColor: color, borderColor: color }]} />
        )}
        <View style={{ flex: 1 }} />
        <Text style={styles.elapsed}>{fmtElapsed(sessionElapsed(s))}</Text>
      </View>
      <Text style={styles.title} numberOfLines={1}>{s.title || "未命名会话"}</Text>
      <Text style={styles.sum} numberOfLines={1}>{s.action_summary || "…"}</Text>
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
    </SwipeRow>
  );
}

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onSetup }: Props) {
  const { c, mode, toggle } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [revealSid, setRevealSid] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionState | null>(null);
  const sorted = useMemo(() => {
    const order: Record<string, number> = { WAITING: 0, WORKING: 1, ERROR: 2, DONE: 3 };
    return [...sessions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.started_at - a.started_at);
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
        <LinearGradient colors={[c.brandA, c.brandB]} style={styles.logo}>
          <Text style={styles.logoText}>CC</Text>
        </LinearGradient>
        <Text style={styles.h1}>Cloud Code</Text>
        <Pressable
          style={styles.themeBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
          onPress={toggle}
        >
          <Text style={styles.themeT}>{mode === "dark" ? "☀️" : "🌙"}</Text>
        </Pressable>
        <Pressable
          style={styles.srvBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
          onPress={onSetup}
        >
          <Text style={styles.srvT}>服务器</Text>
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
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 14, paddingTop: 6 }}
        renderItem={({ item }) => (
          <SessionCard s={item} onOpen={onOpen} onRename={() => setRenameTarget(item)} revealSid={revealSid} onReveal={setRevealSid} />
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

      <Pressable
        style={styles.fab}
        android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false, radius: 30 }}
        onPress={onNew}
      >
        <LinearGradient colors={[c.brandA, c.brandB]} style={styles.fabGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          <Text style={styles.fabText}>＋</Text>
        </LinearGradient>
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
  logo: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  h1: { color: c.text, fontSize: 17, fontWeight: "700", flex: 1 },
  themeBtn: {
    width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  themeT: { fontSize: 14 },
  srvBtn: {
    height: 28, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, alignItems: "center", justifyContent: "center",
  },
  srvT: { fontSize: 11, color: c.dim },
  connChip: {
    flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1,
    borderRadius: 999, height: 28, paddingHorizontal: 10,
    backgroundColor: c.tintSoft,
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
  row1: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  dot: {
    width: 10, height: 10, borderRadius: 5, opacity: 1,
    alignItems: "center", justifyContent: "center",
  },
  elapsed: { fontSize: 12, color: c.faint, fontVariant: ["tabular-nums"] },
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
  fab: { position: "absolute", right: 30, bottom: 56, borderRadius: 16, elevation: 8 },
  fabGrad: { width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  fabText: { color: "#fff", fontSize: 30, fontWeight: "300", marginTop: -4 },
});
