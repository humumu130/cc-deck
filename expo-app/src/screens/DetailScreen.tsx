import { useEffect, useRef, useState } from "react";
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { C, STATUS_ZH, statusColor } from "../theme";
import { fmtClock, fmtElapsed, sessionElapsed } from "../fmt";
import { store, useRelay } from "../store";
import type { LogEntry, SessionState } from "../protocol";

type Tab = "activity" | "logs" | "stats";

function Row({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <View style={d.row}>
      <Text style={d.rowK}>{k}</Text>
      <Text style={[d.rowV, vc ? { color: vc } : null]}>{v}</Text>
    </View>
  );
}

function LogsView({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollToEnd({ animated: false });
  }, [logs.length]);
  if (logs.length === 0) return <Text style={d.empty}>暂无日志</Text>;
  return (
    <ScrollView ref={ref} style={{ maxHeight: 420 }}>
      {logs.map((e, i) => (
        <View key={i} style={d.tlItem}>
          <Text style={d.tlTime}>{fmtClock(e.ts).slice(0, 5)}</Text>
          <View style={{ flex: 1 }}>
            {e.tool ? <Text style={d.tlTool}>{e.tool}</Text> : null}
            <Text style={[d.tlText, { color: logColor(e.kind) }]}>{e.text}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function logColor(kind: string): string {
  switch (kind) {
    case "tool_use": return "#9FC4F0";
    case "tool_result": return C.dim;
    case "system": return "#A99CF5";
    case "user_message": return C.working;
    default: return C.text;
  }
}

const SPIN_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✸"];

// 类 Claude Code 状态行：✶ 摘要 · Ns（每秒走帧）
function LiveStatusLine({ summary, startedAt, color }: { summary: string; startedAt?: number; color: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const base = startedAt ?? Date.now();
  const secs = Math.max(0, Math.floor((Date.now() - base) / 1000));
  const frame = SPIN_FRAMES[Math.floor(Date.now() / 500) % SPIN_FRAMES.length];
  const m = Math.floor(secs / 60);
  const timeText = m > 0 ? `${m}m${secs % 60}s` : `${secs}s`;
  return (
    <View style={d.statusLine}>
      <Text style={[d.statusSpin, { color }]}>{frame}</Text>
      <Text style={[d.statusText, { color }]} numberOfLines={2}>{summary || "思考中…"}</Text>
      <Text style={d.statusTime}>· {timeText}</Text>
    </View>
  );
}

export default function DetailScreen({ sid, onBack }: { sid: string; onBack: () => void }) {
  const snap = useRelay();
  const [tab, setTab] = useState<Tab>("activity");
  const [input, setInput] = useState("");
  const s: SessionState | undefined = snap.sessions.find((x) => x.session_id === sid);

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

  const color = statusColor(s.status);
  const external = !!s.external;
  const canCmd = snap.connected && !(s.historical && !external);
  const wr = s.waiting_request;

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
    <SafeAreaView style={d.safe} edges={["top", "bottom"]}>
      {/* 头部 */}
      <View style={d.head}>
        <Pressable style={[d.back, d.opRipple]} android_ripple={{ color: "rgba(125,165,220,0.16)", borderless: false }} onPress={onBack} hitSlop={8}>
          <Text style={d.backText}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={d.title} numberOfLines={1}>{s.title || "未命名会话"}</Text>
          <Text style={d.sub}>
            <Text style={{ color }}>{STATUS_ZH[s.status] ?? s.status}</Text>
            {" · " + (external ? "外部 CLI" : "托管") + (s.historical && !external ? " · 历史" : "") + " · " + fmtElapsed(sessionElapsed(s))}
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 130 }}>
        {/* 审批横幅 */}
        {wr && wr.decidable !== false ? (
          <View style={d.waitBanner}>
            <Text style={d.waitT}>◐ 等待你的确认</Text>
            <Text style={d.waitTool}>工具 <Text style={d.waitToolName}>{wr.tool_name}</Text></Text>
            <Text style={d.waitDesc} numberOfLines={6}>{wr.input_summary}</Text>
            <View style={d.wbtns}>
              <Pressable style={[d.btnAllow, d.opRipple]} android_ripple={{ color: "rgba(43,217,143,0.18)", borderless: false }} onPress={() => decide(true)}>
                <Text style={d.btnAllowT}>✓ 允许</Text>
              </Pressable>
              <Pressable style={[d.btnReject, d.opRipple]} android_ripple={{ color: "rgba(240,82,79,0.18)", borderless: false }} onPress={() => decide(false)}>
                <Text style={d.btnRejectT}>✕ 拒绝</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {s.historical && !external ? <Text style={d.histnote}>Relay 重启前的历史会话，仅可查看</Text> : null}

        {/* Tab */}
        <View style={d.tabs}>
          {(["activity", "logs", "stats"] as Tab[]).map((t) => (
            <Pressable
              key={t}
              style={[d.tab, tab === t && d.tabOn]}
              android_ripple={{ color: "rgba(125,165,220,0.14)", borderless: false, radius: 14 }}
              onPress={() => setTab(t)}
            >
              <Text style={[d.tabT, tab === t && d.tabTOn]}>{t === "activity" ? "活动" : t === "logs" ? "日志" : "统计"}</Text>
            </Pressable>
          ))}
        </View>

        {/* Tab 内容 */}
        {tab === "activity" ? (
          <View>
            <View style={d.ovcard}>
              <View style={d.ovtop}>
                <View style={[d.ovDot, { backgroundColor: color }]} />
                <Text style={[d.ovSt, { color }]}>{STATUS_ZH[s.status] ?? s.status}</Text>
              </View>
              {s.status === "WORKING" ? (
                <LiveStatusLine summary={s.action_summary} startedAt={s.turn_started_at ?? s.updated_at} color={C.working} />
              ) : s.status === "WAITING" && s.waiting_request ? (
                <LiveStatusLine summary={`等待确认：${s.waiting_request.tool_name}`} startedAt={s.waiting_request.received_at} color={C.waiting} />
              ) : null}
              <Row k="当前动作" v={s.action_summary || "—"} />
              {s.status === "ERROR" && s.last_error ? <Row k="错误" v={s.last_error} vc={C.error} /> : null}
              {s.status === "DONE" ? <Row k="结束原因" v={s.done_reason || "—"} /> : null}
            </View>
            <View style={d.ops}>
              {!external && s.status === "WORKING" ? (
                <Pressable style={[d.opWarn, d.opRipple]} android_ripple={{ color: "rgba(240,82,79,0.15)", borderless: false }} onPress={() => store.send("COMMAND_STOP", { session_id: sid })}>
                  <Text style={d.opWarnT}>■ 停止</Text>
                </Pressable>
              ) : null}
              {external && s.status === "WORKING" ? (
                <Pressable style={[d.opWarn, d.opRipple]} android_ripple={{ color: "rgba(240,82,79,0.15)", borderless: false }} onPress={() => store.send("COMMAND_EXT_STOP", { session_id: sid })}>
                  <Text style={d.opWarnT}>■ 打断</Text>
                </Pressable>
              ) : null}
              {external ? (
                <Pressable style={[d.op, d.opRipple]} android_ripple={{ color: "rgba(125,165,220,0.14)", borderless: false }} onPress={() => store.send("COMMAND_EXT_MODE", { session_id: sid, enabled: !s.remote_mode })}>
                  <Text style={d.opT}>{s.remote_mode ? "关闭远程审批" : "开启远程审批"}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : tab === "logs" ? (
          <View style={d.ovcard}>
            <LogsView logs={store.timelineOf(sid)} />
          </View>
        ) : (
          <View style={d.ovcard}>
            <Row k="耗时" v={fmtElapsed(sessionElapsed(s))} />
            <Row k="改动文件" v={String(s.stats?.files_changed ?? 0)} />
            <Row k="新增行" v={"+" + (s.stats?.lines_added ?? 0)} vc={C.working} />
            <Row k="删除行" v={"-" + (s.stats?.lines_deleted ?? 0)} vc={C.error} />
            <Row k="模型" v={s.model || "—"} />
            <Row k="开始时间" v={fmtClock(s.started_at)} />
            <Row k="最近活动" v={fmtClock(s.updated_at)} />
            <Row k="工作目录" v={s.cwd || "—"} />
            {s.cli_pid ? <Row k="CLI PID" v={String(s.cli_pid)} /> : null}
          </View>
        )}
      </ScrollView>

      {/* 底部命令栏（键盘弹起时抬升到键盘上方） */}
      <KeyboardAvoidingView behavior="padding" pointerEvents="box-none">
        <View style={d.cmdbar}>
        <TextInput
          style={d.input}
          value={input}
          onChangeText={setInput}
          placeholder={external ? "注入到终端（空闲时自动发送）" : "发送消息…"}
          placeholderTextColor={C.faint}
          editable={canCmd}
          multiline
        />
        <Pressable style={[d.sendBtn, (!canCmd || !input.trim()) && { opacity: 0.4 }]} android_ripple={{ color: "rgba(255,255,255,0.2)", borderless: false }} onPress={send} disabled={!canCmd}>
          <Text style={d.sendT}>➤</Text>
        </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const d = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  back: { width: 36, height: 36, borderRadius: 11, backgroundColor: "rgba(125,165,220,0.08)", alignItems: "center", justifyContent: "center" },
  backText: { color: C.dim, fontSize: 20, marginTop: -2 },
  hintText: { color: C.faint },
  title: { color: C.text, fontSize: 15, fontWeight: "600" },
  sub: { color: C.dim, fontSize: 11, marginTop: 1 },
  waitBanner: {
    borderRadius: 16, borderWidth: 1, borderColor: "rgba(245,184,65,0.4)",
    backgroundColor: "rgba(245,184,65,0.07)", padding: 14, marginBottom: 12,
  },
  waitT: { color: C.waiting, fontWeight: "700", fontSize: 13, marginBottom: 6 },
  waitTool: { color: C.text, fontSize: 13, marginBottom: 4 },
  waitToolName: { color: C.waiting, fontWeight: "700" },
  waitDesc: { color: C.dim, fontSize: 13, marginBottom: 12 },
  wbtns: { flexDirection: "row", gap: 10 },
  btnAllow: {
    flex: 1, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(43,217,143,0.14)", borderWidth: 1, borderColor: "rgba(43,217,143,0.35)",
  },
  btnAllowT: { color: C.working, fontWeight: "600", fontSize: 14.5 },
  btnReject: {
    flex: 1, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(240,82,79,0.10)", borderWidth: 1, borderColor: "rgba(240,82,79,0.3)",
  },
  btnRejectT: { color: C.error, fontWeight: "600", fontSize: 14.5 },
  histnote: { color: C.faint, fontSize: 11, textAlign: "center", marginBottom: 10 },
  statusLine: {
    flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 12,
    backgroundColor: "rgba(125,165,220,0.05)", borderRadius: 11, paddingHorizontal: 11, paddingVertical: 9,
  },
  statusSpin: { fontSize: 15, fontWeight: "700" },
  statusText: { flex: 1, fontSize: 13.5, fontWeight: "600" },
  statusTime: { color: C.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
  tabs: { flexDirection: "row", gap: 7, marginBottom: 12 },
  tab: { flex: 1, height: 36, borderRadius: 11, backgroundColor: "rgba(125,165,220,0.06)", alignItems: "center", justifyContent: "center" },
  tabOn: { backgroundColor: "rgba(93,134,245,0.16)", borderWidth: 1, borderColor: "rgba(93,134,245,0.4)" },
  tabT: { color: C.dim, fontSize: 13, fontWeight: "600" },
  tabTOn: { color: "#fff" },
  ovcard: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 16, padding: 15, marginBottom: 12 },
  ovtop: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  ovDot: { width: 12, height: 12, borderRadius: 6 },
  ovSt: { fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 7, borderTopWidth: 1, borderTopColor: "rgba(125,165,220,0.06)", gap: 14 },
  rowK: { color: C.dim, fontSize: 13 },
  rowV: { color: C.text, fontSize: 13, fontVariant: ["tabular-nums"], textAlign: "right", flex: 1 },
  ops: { flexDirection: "row", gap: 10 },
  opRipple: { borderRadius: 13, overflow: "hidden" },
  op: { flex: 1, height: 42, borderRadius: 13, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center" },
  opT: { color: C.text, fontSize: 13.5, fontWeight: "600" },
  opWarn: { flex: 1, height: 42, borderRadius: 13, backgroundColor: C.panel2, borderWidth: 1, borderColor: "rgba(240,82,79,0.3)", alignItems: "center", justifyContent: "center" },
  opWarnT: { color: C.error, fontSize: 13.5, fontWeight: "600" },
  empty: { color: C.faint, textAlign: "center", paddingVertical: 40, fontSize: 13 },
  tlItem: { flexDirection: "row", gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "rgba(125,165,220,0.06)" },
  tlTime: { color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"], paddingTop: 2, width: 36 },
  tlTool: { color: C.faint, fontSize: 11, marginBottom: 2 },
  tlText: { fontSize: 13, flex: 1 },
  cmdbar: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: "rgba(8,15,26,0.97)", borderTopWidth: 1, borderTopColor: C.line,
    flexDirection: "row", gap: 9, alignItems: "flex-end",
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 13,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line,
    paddingHorizontal: 14, paddingVertical: 11, color: C.text, fontSize: 15,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 13, backgroundColor: C.brandA,
    alignItems: "center", justifyContent: "center",
  },
  sendT: { color: "#fff", fontSize: 17 },
});
