import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, TouchableOpacity, View, Vibration } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { store, useRelay } from "./src/store";
import type { TaskDoneReport } from "./src/store";
import { ensureNotifPermission, fgSupported, notifyAlert, startForegroundService } from "./src/notify";
import { startWatchGateway } from "./src/watch";
import { ThemeProvider, useTheme, useThemeStyles } from "./src/theme-context";
import { loadDisplaySettings } from "./src/display-settings";
import type { ThemeColors } from "./src/theme";
import ListScreen from "./src/screens/ListScreen";
import DetailScreen from "./src/screens/DetailScreen";
import SetupScreen from "./src/screens/SetupScreen";
import NewSessionModal from "./src/screens/NewSessionModal";

function Toast() {
  const snap = useRelay();
  const st = useThemeStyles(makeStyles);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!snap.lastErrorCmd) return;
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setShow(false);
      store.clearCmdError();
    }, 2600);
  }, [snap.lastErrorCmd]);

  if (!show || !snap.lastErrorCmd) return null;
  return (
    <View style={st.toastWrap} pointerEvents="none">
      <View style={st.toast}>
        <Text style={st.toastT}>命令失败: {snap.lastErrorCmd}</Text>
      </View>
    </View>
  );
}

// 任务完成汇报悬浮框（#204）：新报告展开列出完成项，10s 后自动折叠为
// 一行小条（点按再展开）；✕ 关闭。全局浮层，列表/详情页都可见
function TaskDoneFloat() {
  const snap = useRelay();
  const st = useThemeStyles(makeStyles);
  const r = snap.taskDone;
  const [expanded, setExpanded] = useState(true);
  const lastId = useRef(0);

  useEffect(() => {
    if (!r || r.id === lastId.current) return;
    lastId.current = r.id;
    setExpanded(true);
    const t = setTimeout(() => setExpanded(false), 10_000);
    return () => clearTimeout(t);
  }, [r?.id]);

  if (!r) return null;
  const n = r.done.length;
  return (
    <View style={st.tdWrap} pointerEvents="box-none">
      <View style={st.tdCard}>
        <View style={st.tdHead}>
          <Text style={st.tdTitle} numberOfLines={1}>
            ✓ {n} 项任务完成{r.title ? ` · ${r.title}` : ""}
          </Text>
          <TouchableOpacity
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => store.clearTaskDone()}
          >
            <Text style={st.tdClose}>✕</Text>
          </TouchableOpacity>
        </View>
        {expanded ? (
          <View>
            {r.done.map((d, i) => (
              <Text key={i} style={st.tdItem} numberOfLines={1}>
                ✓ {d}
              </Text>
            ))}
            <Text style={st.tdRemain}>
              {r.remaining > 0 ? `剩余 ${r.remaining} 项进行中` : "全部完成"}
            </Text>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setExpanded(true)}>
            <Text style={st.tdRemain}>
              {r.remaining > 0 ? `剩余 ${r.remaining} 项 · ` : ""}展开查看 ▾
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function Shell() {
  const { c, mode } = useTheme();
  const st = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [ready, setReady] = useState(false);
  const [hasCfg, setHasCfg] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // null=关闭；"new"=新增服务器；其余字符串=编辑该 id 的服务器
  const [setup, setSetup] = useState<string | null>(null);

  useEffect(() => {
    startWatchGateway();
    void (async () => {
      // 显示设置先于首帧加载完成，避免简洁模式/字号闪默认值
      await loadDisplaySettings();
      const cfg = await store.loadConfig();
      setHasCfg(!!cfg);
      if (cfg) store.connect();
      setReady(true);
    })();
  }, []);

  // 首次在设置页连接成功：自动进入主界面（hasCfg 只在启动时算过一次）
  useEffect(() => {
    if (snap.connected && !hasCfg) setHasCfg(true);
  }, [snap.connected, hasCfg]);

  const appState = useRef(AppState.currentState);

  useEffect(() => {
    store.onWaiting = (s) => {
      try {
        Vibration.vibrate([0, 90, 60, 90]);
      } catch {}
      // 后台时发高优先级通知（点了回到 App 审批）
      if (appState.current !== "active") {
        const tool = s.waiting_request?.tool_name || "";
        notifyAlert("等待你的确认", tool ? `工具 ${tool}` : "会话等待确认");
      }
    };
    store.onTaskDone = (r) => {
      if (appState.current === "active") {
        try {
          Vibration.vibrate(60);
        } catch {}
        return;
      }
      notifyAlert(`任务完成 · ${r.title}`, r.remaining > 0 ? `完成 ${r.done.length} 项，剩余 ${r.remaining} 项` : `全部完成（${r.done.length} 项）`);
    };
    return () => {
      store.onWaiting = null;
      store.onTaskDone = null;
    };
  }, []);

  // 连接成功后：请求通知权限 + 启动前台服务保活
  useEffect(() => {
    if (!snap.connected) return;
    void ensureNotifPermission();
    if (fgSupported()) startForegroundService();
  }, [snap.connected]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      appState.current = st;
      if (st === "active" && hasCfg && !snap.connected) store.connect();
    });
    return () => sub.remove();
  }, [hasCfg, snap.connected]);

  if (!ready) {
    return (
      <View style={st.boot}>
        <Text style={st.bootT}>Claude Code</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      {hasCfg && !setup ? (
        <>
          {detail ? (
            <DetailScreen sid={detail} onBack={() => setDetail(null)} />
          ) : (
            <ListScreen
              sessions={snap.sessions}
              connected={snap.connected}
              connText={snap.connText}
              onOpen={setDetail}
              onNew={() => setSheet(true)}
              onSetup={() => setSetup("new")}
              onEditServer={(id) => setSetup(id)}
            />
          )}
          <NewSessionModal visible={sheet} onClose={() => setSheet(false)} />
          <Toast />
          <TaskDoneFloat />
        </>
      ) : (
        <SetupScreen
          onClose={hasCfg ? () => setSetup(null) : undefined}
          editId={setup && setup !== "new" ? setup : null}
        />
      )}
    </SafeAreaProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  boot: { flex: 1, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" },
  bootT: { color: c.faint, fontSize: 16, fontWeight: "600" },
  toastWrap: { position: "absolute", left: 0, right: 0, bottom: 96, alignItems: "center", zIndex: 90 },
  toast: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, maxWidth: "86%",
  },
  toastT: { color: c.text, fontSize: 13.5, textAlign: "center" },
  tdWrap: { position: "absolute", left: 0, right: 0, bottom: 148, alignItems: "center", zIndex: 80 },
  tdCard: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "88%",
  },
  tdHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  tdTitle: { color: c.text, fontSize: 13.5, fontWeight: "600", flex: 1 },
  tdClose: { color: c.faint, fontSize: 15, paddingHorizontal: 4 },
  tdItem: { color: c.text, fontSize: 12.5, marginTop: 6, opacity: 0.9 },
  tdRemain: { color: c.faint, fontSize: 12, marginTop: 8 },
});
