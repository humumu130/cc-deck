import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View, Vibration } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { store, useRelay } from "./src/store";
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
    return () => {
      store.onWaiting = null;
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
});
