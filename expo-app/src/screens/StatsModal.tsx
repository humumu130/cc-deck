import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { fmtClock, fmtElapsed, fmtTok, sessionElapsed } from "../fmt";
import type { SessionState } from "../protocol";

interface Props {
  visible: boolean;
  s: SessionState;
  onCancel: () => void;
}

function Row({ k, v, vc }: { k: string; v: string; vc?: string }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={d.row}>
      <Text style={d.rowK}>{k}</Text>
      <Text style={[d.rowV, vc ? { color: vc } : null]}>{v}</Text>
    </View>
  );
}

export default function StatsModal({ visible, s, onCancel }: Props) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={d.mask} onPress={onCancel}>
        <Pressable style={d.card} onPress={() => {}}>
          <Text style={d.h}>会话信息</Text>
          <ScrollView style={d.scroll} contentContainerStyle={{ paddingBottom: 4 }}>
            <Row k="耗时" v={fmtElapsed(sessionElapsed(s))} />
            {s.todos?.length ? (
              <Row k="任务进度" v={`${s.todos.filter((t) => t.status === "completed").length}/${s.todos.length}`} />
            ) : null}
            <Row k="改动文件" v={String(s.stats?.files_changed ?? 0)} />
            <Row k="新增行" v={"+" + (s.stats?.lines_added ?? 0)} vc={c.working} />
            <Row k="删除行" v={"-" + (s.stats?.lines_deleted ?? 0)} vc={c.error} />
            <Row k="输入 tokens" v={fmtTok(s.usage?.input_tokens)} />
            <Row k="输出 tokens" v={fmtTok(s.usage?.output_tokens)} />
            <Row k="缓存读取" v={fmtTok(s.usage?.cache_read_input_tokens)} />
            <Row k="缓存写入" v={fmtTok(s.usage?.cache_creation_input_tokens)} />
            <Row k="模型" v={s.model || "—"} />
            <Row k="开始时间" v={fmtClock(s.started_at)} />
            <Row k="最近活动" v={fmtClock(s.updated_at)} />
            <Row k="工作目录" v={s.cwd || "—"} />
            {s.cli_pid ? <Row k="CLI PID" v={String(s.cli_pid)} /> : null}
          </ScrollView>
          <Pressable style={d.close} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onCancel}>
            <Text style={d.closeT}>关闭</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  mask: { flex: 1, backgroundColor: c.overlay, alignItems: "center", justifyContent: "center", padding: 28 },
  card: {
    width: "100%", borderRadius: 16, backgroundColor: c.panel,
    borderWidth: 1, borderColor: c.line, padding: 18,
  },
  h: { color: c.text, fontSize: 15.5, fontWeight: "700", marginBottom: 8 },
  scroll: { maxHeight: 440 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: withA(c.dim, 0.12) },
  rowK: { color: c.dim, fontSize: 13 },
  rowV: { color: c.text, fontSize: 13, fontVariant: ["tabular-nums"], textAlign: "right", flex: 1 },
  close: {
    marginTop: 14, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  closeT: { color: c.dim, fontSize: 14, fontWeight: "600" },
});
