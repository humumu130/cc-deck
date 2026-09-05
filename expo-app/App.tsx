import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, AppState, BackHandler, Dimensions, Easing, Pressable, ScrollView, StyleSheet, Text, View, Vibration } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { store, useRelay } from "./src/store";
import type { TaskDoneReport } from "./src/store";
import { ensureNotifPermission, fgSupported, notifyAlert, startForegroundService } from "./src/notify";
import { startWatchGateway } from "./src/watch";
import { ThemeProvider, useTheme, useThemeStyles } from "./src/theme-context";
import { loadDisplaySettings } from "./src/display-settings";
import { withA, type ThemeColors } from "./src/theme";
import ListScreen from "./src/screens/ListScreen";
import DetailScreen from "./src/screens/DetailScreen";
import SetupScreen from "./src/screens/SetupScreen";
import NewSessionModal from "./src/screens/NewSessionModal";

// 全局错误 Toast：弹簧上滑入场 + 到期下滑退场（入场/退场动画，#242）
function Toast() {
  const snap = useRelay();
  const st = useThemeStyles(makeStyles);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const op = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    if (!snap.lastErrorCmd) return;
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    op.setValue(0);
    y.setValue(16);
    Animated.parallel([
      Animated.spring(y, { toValue: 0, useNativeDriver: true, speed: 30, bounciness: 6 }),
      Animated.timing(op, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
    timer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(op, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.timing(y, { toValue: 16, duration: 140, useNativeDriver: true }),
      ]).start(() => {
        setShow(false);
        store.clearCmdError();
      });
    }, 2600);
  }, [snap.lastErrorCmd]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!show || !snap.lastErrorCmd) return null;
  // 完整句子的文案（本地未发送 / ACK 超时结论）不再套"命令失败:"前缀，避免语义叠加误导排查方向
  const raw = snap.lastErrorCmd;
  const msg = raw === "未连接，命令未发送" || raw.endsWith("可能未送达") ? raw : `命令失败: ${raw}`;
  return (
    <View style={st.toastWrap} pointerEvents="none">
      <Animated.View style={[st.toast, { opacity: op, transform: [{ translateY: y }] }]}>
        <Text style={st.toastT}>{msg}</Text>
      </Animated.View>
    </View>
  );
}

// 任务完成汇报悬浮按钮（#204/#240/#254）：右下角 44dp 小方钮 + 未读计数徽标
// （未点开的完成项总数持续累积），点击展开详情卡（fade+上滑）并清计数。
// 卡片无标题：直接列完成任务项，底部「清除 / 查看会话」。全局浮层：详情页贴命令栏上方，
// 列表页抬高让开 FAB
function TaskDoneFloat({ isDetail, onOpenSession }: { isDetail: boolean; onOpenSession: (sid: string) => void }) {
  const { c } = useTheme();
  const snap = useRelay();
  const st = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const q = snap.taskDoneQueue;
  const unviewed = q.reduce((n, r) => n + (r.viewed ? 0 : r.done.length), 0);
  // 跨会话汇报平铺、行带 sid：渲染时在不同会话交界插分隔线（多会话并行时区分来源）
  const rows = q.flatMap((r) => r.done.map((text) => ({ sid: r.sid, text })));
  const shown = rows.slice(0, 8);
  const overflow = rows.length - shown.length;
  const latestSid = q.length ? q[q.length - 1].sid : "";
  const multi = new Set(q.map((r) => r.sid)).size > 1;
  const [expanded, setExpanded] = useState(false);
  const pop = useRef(new Animated.Value(0)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  const cardOp = useRef(new Animated.Value(0)).current;
  const cardY = useRef(new Animated.Value(10)).current;
  const hasQ = q.length > 0;

  useEffect(() => {
    if (!hasQ) {
      setExpanded(false);
      return;
    }
    pop.setValue(0.4);
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, bounciness: 6, speed: 12 }).start();
  }, [hasQ]);

  // 卡片展开时硬件返回先收卡（否则详情页 BackHandler 抢走返回键，浮层开着却被拽回列表）
  useEffect(() => {
    if (!expanded) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setExpanded(false);
      return true;
    });
    return () => sub.remove();
  }, [expanded]);

  // 未读计数变化时徽标弹一下，提示又完成了新任务
  useEffect(() => {
    if (!unviewed) return;
    badgePulse.setValue(0.6);
    Animated.spring(badgePulse, { toValue: 1, useNativeDriver: true, bounciness: 7, speed: 14 }).start();
  }, [unviewed]);

  useEffect(() => {
    if (!expanded) return;
    cardOp.setValue(0);
    cardY.setValue(10);
    Animated.parallel([
      Animated.timing(cardOp, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.timing(cardY, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [expanded]);

  if (!q.length) return null;
  const bottom = insets.bottom + (isDetail ? 74 : 124);
  return (
    <View style={st.tdWrap} pointerEvents="box-none">
      {expanded ? (
        <>
          <Pressable style={st.tdScrim} onPress={() => setExpanded(false)} />
          <Animated.View style={[st.tdCard, { opacity: cardOp, transform: [{ translateY: cardY }], bottom: bottom + 52 }]}>
            <ScrollView nestedScrollEnabled>
              {shown.map((row, i) => (
                <View key={i}>
                  {i > 0 && row.sid !== shown[i - 1].sid ? <View style={st.tdDivider} /> : null}
                  <View style={st.tdItemRow}>
                    <Text style={st.tdItemMark}>✓</Text>
                    <Text style={st.tdItem} numberOfLines={2}>{row.text}</Text>
                  </View>
                </View>
              ))}
              {overflow > 0 ? <Text style={st.tdMore}>… 还有 {overflow} 项</Text> : null}
            </ScrollView>
            <View style={st.tdBtnRow}>
              <Pressable
                style={st.tdClear}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                onPress={() => store.clearTaskDone()}
              >
                <Text style={st.tdClearT}>清除</Text>
              </Pressable>
              <Pressable
                style={st.tdGo}
                android_ripple={{ color: withA(c.done, 0.18), borderless: false, radius: 9 }}
                onPress={() => onOpenSession(latestSid)}
              >
                <Text style={st.tdGoT}>{multi ? "查看最新会话 ›" : "查看会话 ›"}</Text>
              </Pressable>
            </View>
          </Animated.View>
        </>
      ) : (
        <Animated.View style={[st.tdFab, { transform: [{ scale: pop }], bottom }]}>
          <Pressable
            style={st.tdFabHit}
            android_ripple={{ color: withA(c.done, 0.2), borderless: false, radius: 14 }}
            accessibilityLabel={unviewed > 0 ? `${unviewed} 项任务完成待查看` : "任务完成汇报"}
            onPress={() => {
              try { Vibration.vibrate(10); } catch {}
              store.markTaskDoneViewed();
              setExpanded(true);
            }}
          >
            <Text style={st.tdFabT}>✓</Text>
          </Pressable>
          {unviewed > 0 ? (
            <Animated.View style={[st.tdBadge, { transform: [{ scale: badgePulse }] }]}>
              <Text style={st.tdBadgeT}>{unviewed > 99 ? "99+" : unviewed}</Text>
            </Animated.View>
          ) : null}
        </Animated.View>
      )}
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
  // 列表⇄详情过渡（#259）：entering=详情从右滑入（列表垫底，落定卸载列表）；
  // closing=详情右滑出（列表先挂回垫底，滑完卸载详情）。仅 transform+native 驱动
  const [navPhase, setNavPhase] = useState<"idle" | "entering" | "closing">("idle");
  const navX = useRef(new Animated.Value(0)).current;
  // 宽度调用时取（分屏/折叠屏变化后首帧窗口已换宽，冻结值会让滑入起点露边/滑出残留）
  const openDetail = useCallback((sid: string): boolean => {
    if (navPhase !== "idle") return false;
    if (detail) {
      setDetail(sid); // 详情页内直接换会话（FAB 查看最新）：无动画
      return true;
    }
    const w = Dimensions.get("window").width;
    setDetail(sid);
    setNavPhase("entering");
    navX.setValue(w);
    Animated.timing(navX, { toValue: 0, duration: 230, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (finished) setNavPhase("idle");
    });
    return true;
  }, [navPhase, detail, navX]);
  const closeDetail = useCallback(() => {
    if (navPhase !== "idle" || !detail) return;
    setNavPhase("closing");
    Animated.timing(navX, { toValue: Dimensions.get("window").width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setDetail(null);
        setNavPhase("idle");
      }
    });
  }, [navPhase, detail, navX]);
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
      if (st !== "active") return;
      // 半开连接即时体检（#258）：后台期间 socket 可能已死而 connected 仍真，
      // 先探测判死再走既有重连/恢复链；已断线则直接重连
      store.resumeProbe();
      if (hasCfg && !snap.connected) store.connect();
    });
    return () => sub.remove();
  }, [hasCfg, snap.connected]);

  if (!ready) {
    return (
      <View style={st.boot}>
        <Text style={st.bootT}>CC Deck</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      {hasCfg && !setup ? (
        <>
          {(!detail || navPhase !== "idle") && (
            <ListScreen
              sessions={snap.sessions}
              connected={snap.connected}
              connText={snap.connText}
              onOpen={openDetail}
              onNew={() => setSheet(true)}
              onSetup={() => setSetup("new")}
              onEditServer={(id) => setSetup(id)}
            />
          )}
          {detail ? (
            <Animated.View
              style={[st.navLayer, { transform: [{ translateX: navX }] }]}
            >
              <DetailScreen sid={detail} onBack={closeDetail} />
            </Animated.View>
          ) : null}
          <NewSessionModal visible={sheet} onClose={() => setSheet(false)} />
          <Toast />
          <TaskDoneFloat
            isDetail={!!detail}
            onOpenSession={(sid) => {
              openDetail(sid);
              store.clearTaskDone(sid);
            }}
          />
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
  // 详情层：盖在列表上，滑入/滑出只动 translateX（native 驱动）
  navLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.bg, elevation: 8 },
  toastWrap: { position: "absolute", left: 0, right: 0, bottom: 124, alignItems: "center", zIndex: 90 },
  toast: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, maxWidth: "86%",
  },
  toastT: { color: c.text, fontSize: 13.5, textAlign: "center" },
  // 悬浮层根：全屏 box-none，按钮/卡片/收起 scrim 各自绝对定位
  tdWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 80 },
  tdScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  tdFab: {
    position: "absolute", right: 12, width: 44, height: 44, borderRadius: 14,
    backgroundColor: withA(c.done, 0.10), borderWidth: 1, borderColor: withA(c.done, 0.45),
    elevation: 4, overflow: "visible",
  },
  tdFabHit: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 14, overflow: "hidden" },
  tdFabT: { color: c.done, fontSize: 17, fontWeight: "700" },
  tdBadge: {
    position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5, backgroundColor: c.done, alignItems: "center", justifyContent: "center",
    elevation: 5,
  },
  tdBadgeT: { color: "#06281A", fontSize: 11, fontWeight: "800" },
  // 展开卡：无标题，任务项两行封顶（大字体时 maxHeight 兜底内部滚动），底部 清除/查看会话 双钮
  tdCard: {
    position: "absolute", right: 12, maxWidth: "84%", maxHeight: "70%",
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.done, 0.28),
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, elevation: 8,
  },
  // 多会话汇报交界分隔线
  tdDivider: { height: 1, backgroundColor: c.line, marginTop: 9 },
  tdItemRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 7 },
  tdItemMark: { color: c.done, fontSize: 12.5, fontWeight: "700", lineHeight: 18 },
  tdItem: { flex: 1, color: c.text, fontSize: 12.5, lineHeight: 18 },
  tdMore: { color: c.faint, fontSize: 11.5, marginTop: 7 },
  tdBtnRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  tdClear: {
    height: 30, paddingHorizontal: 13, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  tdClearT: { color: c.faint, fontSize: 12, fontWeight: "600" },
  tdGo: {
    height: 30, paddingHorizontal: 13, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.done, 0.14), borderWidth: 1, borderColor: withA(c.done, 0.35),
  },
  tdGoT: { color: c.done, fontSize: 12, fontWeight: "600" },
});
