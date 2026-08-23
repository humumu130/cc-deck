import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { C, STATUS_ZH, statusColor } from "../theme";
import { sessionElapsed, fmtElapsed } from "../fmt";
import type { SessionState } from "../protocol";

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string) => void;
  onNew: () => void;
}

function SessionCard({ s, onOpen }: { s: SessionState; onOpen: (sid: string) => void }) {
  const color = statusColor(s.status);
  return (
    <Pressable style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: 0.985 }] }]} onPress={() => onOpen(s.session_id)}>
      <View style={styles.row1}>
        <View style={[styles.dot, { backgroundColor: color, borderColor: color }]}>
          {s.status === "WORKING" && <View style={styles.dotCore} />}
        </View>
        <Text style={[styles.st, { color }]}>{STATUS_ZH[s.status] ?? s.status}</Text>
        <Text style={styles.elapsed}>{fmtElapsed(sessionElapsed(s))}</Text>
      </View>
      <Text style={styles.title} numberOfLines={1}>{s.title || "未命名会话"}</Text>
      <Text style={styles.sum} numberOfLines={1}>{s.action_summary || "…"}</Text>
      <View style={styles.foot}>
        <Text style={[styles.tag, s.external ? styles.tagExt : null]}>{s.external ? "外部 CLI" : "托管"}</Text>
        {s.historical && !s.external ? <Text style={styles.tag}>历史</Text> : null}
        <View style={{ flex: 1 }} />
        {s.stats && s.stats.files_changed > 0 ? (
          <Text style={styles.stats}>
            <Text style={{ color: C.working }}>+{s.stats.lines_added}</Text>
            {" "}
            <Text style={{ color: C.error }}>-{s.stats.lines_deleted}</Text>
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ListScreen({ sessions, connected, connText, onOpen, onNew }: Props) {
  const sorted = useMemo(() => {
    const order: Record<string, number> = { WAITING: 0, WORKING: 1, ERROR: 2, DONE: 3 };
    return [...sessions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.started_at - a.started_at);
  }, [sessions]);

  let waiting = 0, running = 0;
  for (const s of sessions) {
    if (s.status === "WAITING") waiting++;
    else if (s.status === "WORKING") running++;
  }
  const hint = waiting > 0 ? `⚠ ${waiting} 个会话等待确认` : running > 0 ? `${running} 个会话运行中` : sessions.length > 0 ? `共 ${sessions.length} 个会话` : "暂无会话";

  const connColor = connected ? C.working : connText.includes("连接中") || connText.includes("重连") ? C.waiting : C.error;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.topbar}>
        <LinearGradient colors={[C.brandA, C.brandB]} style={styles.logo}>
          <Text style={styles.logoText}>CC</Text>
        </LinearGradient>
        <Text style={styles.h1}>Cloud Code</Text>
        <View style={[styles.connChip, { borderColor: connColor + "55" }]}>
          <View style={[styles.connDot, { backgroundColor: connColor }]} />
          <Text style={[styles.connText, { color: connColor }]}>{connText}</Text>
        </View>
      </View>
      <Text style={styles.runhint}>{hint}</Text>

      <FlatList
        data={sorted}
        keyExtractor={(x) => x.session_id}
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 14, paddingTop: 6 }}
        renderItem={({ item }) => <SessionCard s={item} onOpen={onOpen} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>还没有会话</Text>
            <Text style={styles.emptyS}>点右下角 ＋ 启动新会话{"\n"}或在 PC 上打开 claude 接入外部会话</Text>
          </View>
        }
      />

      <Pressable style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.92 }] }]} onPress={onNew}>
        <LinearGradient colors={[C.brandA, C.brandB]} style={styles.fabGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          <Text style={styles.fabText}>＋</Text>
        </LinearGradient>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  logo: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  h1: { color: C.text, fontSize: 17, fontWeight: "700", flex: 1 },
  connChip: {
    flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1,
    borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4,
    backgroundColor: "rgba(125,165,220,0.08)",
  },
  connDot: { width: 6, height: 6, borderRadius: 3 },
  connText: { fontSize: 11 },
  runhint: { color: C.dim, fontSize: 12, paddingHorizontal: 18, paddingTop: 7, paddingBottom: 4 },
  card: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.line,
    borderRadius: 16, padding: 14, marginBottom: 11,
  },
  row1: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  dot: {
    width: 10, height: 10, borderRadius: 5, opacity: 1,
    alignItems: "center", justifyContent: "center",
  },
  dotCore: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.bg },
  st: { fontSize: 12, fontWeight: "600", flex: 1 },
  elapsed: { fontSize: 12, color: C.faint, fontVariant: ["tabular-nums"] },
  title: { color: C.text, fontSize: 15, fontWeight: "600", marginBottom: 5 },
  sum: { color: C.dim, fontSize: 13, marginBottom: 8 },
  foot: { flexDirection: "row", alignItems: "center", gap: 8 },
  tag: {
    fontSize: 10, color: C.dim, backgroundColor: "rgba(125,165,220,0.08)",
    borderWidth: 1, borderColor: C.line, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden",
  },
  tagExt: { color: "#A99CF5", backgroundColor: "rgba(124,108,242,0.12)", borderColor: "rgba(124,108,242,0.25)" },
  stats: { fontSize: 12, fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 42, marginBottom: 12, opacity: 0.5 },
  emptyT: { color: C.faint, fontSize: 14, marginBottom: 6 },
  emptyS: { color: C.faint, fontSize: 12, textAlign: "center", lineHeight: 20 },
  fab: { position: "absolute", right: 18, bottom: 28, borderRadius: 18, elevation: 8 },
  fabGrad: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  fabText: { color: "#fff", fontSize: 30, fontWeight: "300", marginTop: -4 },
});
