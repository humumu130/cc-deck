import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, BackHandler, Dimensions, Easing, Pressable, ScrollView, StyleSheet, Text, View, Vibration } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { store, useRelay } from "./src/store";
import type { TaskDoneReport } from "./src/store";
import { isConfirmTodo, displaySrcName } from "./src/fmt";
import type { DetailBackHandle } from "./src/screens/DetailScreen";
import type { SessionState } from "./src/protocol";
import { ensureNotifPermission, fgSupported, notifyAlert, startForegroundService, updateForeground } from "./src/notify";
import { startWatchGateway } from "./src/watch";
import { ThemeProvider, useTheme, useThemeStyles } from "./src/theme-context";
import { useKbHeight } from "./src/kb";
import { loadDisplaySettings } from "./src/display-settings";
import { withA, type ThemeColors } from "./src/theme";
import ListScreen, { type ListBackHandle } from "./src/screens/ListScreen";
import DetailScreen, { type ViewKind } from "./src/screens/DetailScreen";
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
// 列表页抬高让开 FAB。展开态由 Shell 持有（#282）：硬件返回统一在顶层分发先收卡
function TaskDoneFloat({
  isDetail,
  onOpenSession,
  expanded,
  setExpanded,
}: {
  isDetail: boolean;
  onOpenSession: (sid: string) => void;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
}) {
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
  // 键盘跟随（#270）：详情页点输入框弹键盘时 FAB 随之上移，避免被键盘整块遮住。
  // RN Keyboard 事件在 bridgeless+edge-to-edge 下不触发，走原生 kbInsets 通道（src/kb.ts）
  const kbH = useKbHeight();
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
  }, [hasQ, setExpanded]);

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
  // 键盘弹出时贴键盘上沿（详情页垫在命令栏上方），收起回落原位
  const bottom = kbH > 0 ? kbH + (isDetail ? 80 : 10) : insets.bottom + (isDetail ? 74 : 124);
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
                    <Text style={st.tdItem} numberOfLines={4}>{row.text}</Text>
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
        <Animated.View style={[st.tdFab, isDetail ? st.tdFabDetail : st.tdFabList, { transform: [{ scale: pop }], bottom }]}>
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

// 待确认条目摘要（#306）：#NNN 任务号品牌色高亮——形态同详情页 TaskRefText（#264），
// 悬浮清单内不接点击（整行点击直达会话"任务" tab）
function ConfirmText({ text }: { text: string }) {
  const st = useThemeStyles(makeStyles);
  if (!/#\d{1,3}\b/.test(text)) {
    return <Text style={st.cfItem} numberOfLines={4}>{text}</Text>;
  }
  return (
    <Text style={st.cfItem} numberOfLines={4}>
      {text.split(/#(\d{1,3})\b/g).map((p, i) =>
        i % 2 === 1 ? <Text key={i} style={st.cfRef}>#{p}</Text> : <Text key={i}>{p}</Text>,
      )}
    </Text>
  );
}

// #306 已读指纹分隔符：内容里不可能出现的控制字符，sid/status 本身不含分隔符
const CF_SEP = "\u0001";
const CF_JOIN = ""; //  与 fp 内部的  不同，join/split 才不成碎片

// #306 待确认悬浮按钮：TaskDoneFloat 同款形态（右下 44dp 小方钮 + 数字角标 +
// spring 弹入、展开卡 fade+上滑收放），换品牌色系区分语义（任务完成=绿 /
// 待确认=品牌色）。位置与其错开：TaskDoneFloat 在场时垫其上方 +52，不在场时
// 落其标准位（FAB/命令栏之上）。展开卡按会话分组逐条列出 [待确认] 事项：
// 会话名（displaySrcName 源名规则缩写）+ 内容摘要，点条目直达该会话"任务"
// tab；✕ 逐条已读、底部全部已读——已读指纹记 store.confirmDismissedKey
// （内存级，#300 语义：内容变化指纹不匹配自动重现）。展开态由 Shell 持有（#282）
function ConfirmFloat({
  isDetail,
  hasTaskDone,
  expanded,
  setExpanded,
  onOpen,
}: {
  isDetail: boolean;
  hasTaskDone: boolean;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  onOpen: (sid: string) => void;
}) {
  const { c } = useTheme();
  const snap = useRelay();
  const st = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // 键盘跟随：与 TaskDoneFloat 同款落位公式（原生 kbInsets 通道，src/kb.ts）
  const kbH = useKbHeight();
  const pop = useRef(new Animated.Value(0)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  const cardOp = useRef(new Animated.Value(0)).current;
  const cardY = useRef(new Animated.Value(10)).current;
  const prevTotal = useRef(0);

  // 已读指纹集合：fp = sid + status + encodeURIComponent(content)，CF_SEP 拼接存
  // confirmDismissedKey（内存级）——内容一变指纹不匹配条目自动重现
  const readSet = useMemo(
    () => new Set((snap.confirmDismissedKey ?? "").split(CF_JOIN).filter(Boolean)),
    [snap.confirmDismissedKey],
  );
  // 待确认条目按会话分组（会话按更新时间倒序，#300 横幅同口径），滤掉已读
  const groups = useMemo(() => {
    const out: { sid: string; name: string; at: number; items: { fp: string; text: string }[] }[] = [];
    for (const s of snap.sessions) {
      const items = (s.todos ?? [])
        .filter(isConfirmTodo)
        .map((t) => ({ fp: `${s.session_id}${CF_SEP}${t.status}${CF_SEP}${encodeURIComponent(t.content)}`, text: t.content }))
        .filter((it) => !readSet.has(it.fp));
      if (items.length) {
        out.push({ sid: s.session_id, name: displaySrcName(s.title || "未命名会话"), at: s.updated_at ?? s.started_at, items });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [snap.sessions, readSet]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  // 出现（0→有）弹入；又进新事项角标弹一下；全部已读收卡
  useEffect(() => {
    if (!total) {
      prevTotal.current = 0;
      setExpanded(false);
      return;
    }
    if (!prevTotal.current) {
      pop.setValue(0.4);
      Animated.spring(pop, { toValue: 1, useNativeDriver: true, bounciness: 6, speed: 12 }).start();
    } else if (total > prevTotal.current) {
      badgePulse.setValue(0.6);
      Animated.spring(badgePulse, { toValue: 1, useNativeDriver: true, bounciness: 7, speed: 14 }).start();
    }
    prevTotal.current = total;
  }, [total, setExpanded]);

  useEffect(() => {
    if (!expanded) return;
    cardOp.setValue(0);
    cardY.setValue(10);
    Animated.parallel([
      Animated.timing(cardOp, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.timing(cardY, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [expanded]);

  // ✕ 逐条已读 / 全部已读：指纹并回 store（dismissConfirm），集合变化自动重现
  const markRead = (fps: string[]) => {
    if (!fps.length) return;
    const next = new Set(readSet);
    for (const fp of fps) next.add(fp);
    store.dismissConfirm([...next].join(CF_JOIN));
  };

  if (!total) return null;
  // TaskDoneFloat 同款落位：键盘弹出贴键盘上沿；其在场时本钮垫其上方 +52 错开
  const base = kbH > 0 ? kbH + (isDetail ? 80 : 10) : insets.bottom + (isDetail ? 74 : 124);
  const bottom = base + (hasTaskDone ? 52 : 0);
  // 展示上限 8 条（与汇报卡同量级），余量折进 overflow 行
  const cap = 8;
  let budget = cap;
  const shownGroups: typeof groups = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const items = g.items.slice(0, budget);
    budget -= items.length;
    shownGroups.push({ ...g, items });
  }
  const overflow = total - shownGroups.reduce((n, g) => n + g.items.length, 0);

  return (
    <View style={st.cfWrap} pointerEvents="box-none">
      {expanded ? (
        <>
          <Pressable style={st.cfScrim} onPress={() => setExpanded(false)} />
          <Animated.View style={[st.cfCard, { opacity: cardOp, transform: [{ translateY: cardY }], bottom: bottom + 52 }]}>
            <ScrollView nestedScrollEnabled>
              {shownGroups.map((g, gi) => (
                <View key={g.sid}>
                  <Text style={[st.cfSrc, gi === 0 && st.cfSrc0]} numberOfLines={1}>
                    {g.name}{g.items.length > 1 ? ` · ${g.items.length} 项` : ""}
                  </Text>
                  {g.items.map((it) => (
                    <View key={it.fp} style={st.cfItemRow}>
                      <Pressable
                        style={st.cfItemHit}
                        android_ripple={{ color: withA(c.brandA, 0.12), borderless: false, radius: 9 }}
                        onPress={() => onOpen(g.sid)}
                      >
                        <Text style={st.cfItemMark}>?</Text>
                        <ConfirmText text={it.text} />
                      </Pressable>
                      <Pressable
                        style={st.cfX}
                        hitSlop={6}
                        accessibilityLabel="该条已读"
                        onPress={() => markRead([it.fp])}
                      >
                        <Text style={st.cfXT}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              ))}
              {overflow > 0 ? <Text style={st.cfMore}>… 还有 {overflow} 项待确认</Text> : null}
            </ScrollView>
            <View style={st.cfBtnRow}>
              <Pressable
                style={st.cfAll}
                android_ripple={{ color: withA(c.brandA, 0.18), borderless: false, radius: 9 }}
                onPress={() => markRead(groups.flatMap((g) => g.items.map((it) => it.fp)))}
              >
                <Text style={st.cfAllT}>全部已读</Text>
              </Pressable>
            </View>
          </Animated.View>
        </>
      ) : (
        <Animated.View style={[st.cfFab, isDetail ? st.cfFabDetail : st.cfFabList, { transform: [{ scale: pop }], bottom }]}>
          <Pressable
            style={st.cfFabHit}
            android_ripple={{ color: withA(c.brandA, 0.2), borderless: false, radius: 14 }}
            accessibilityLabel={`${total} 项待你确认，展开清单`}
            onPress={() => {
              try { Vibration.vibrate(10); } catch {}
              setExpanded(true);
            }}
          >
            <Text style={st.cfFabT}>?</Text>
          </Pressable>
          <Animated.View style={[st.cfBadge, { transform: [{ scale: badgePulse }] }]}>
            <Text style={st.cfBadgeT}>{total > 99 ? "99+" : total}</Text>
          </Animated.View>
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
  // 详情初始视图（#300/#306）：待确认悬浮清单跳转带 "todos" 直达任务 tab；普通打开缺省消息页
  const [detailView, setDetailView] = useState<ViewKind>("msg");
  // 列表⇄详情过渡（#259）：entering=详情从右滑入（列表垫底，落定卸载列表）；
  // closing=详情右滑出（列表先挂回垫底，滑完卸载详情）。仅 transform+native 驱动
  const [navPhase, setNavPhase] = useState<"idle" | "entering" | "closing">("idle");
  const navX = useRef(new Animated.Value(0)).current;
  // 宽度调用时取（分屏/折叠屏变化后首帧窗口已换宽，冻结值会让滑入起点露边/滑出残留）
  const openDetail = useCallback((sid: string, view?: ViewKind): boolean => {
    if (navPhase !== "idle") return false;
    setDetailView(view ?? "msg");
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
  // 关详情：仅在空闲相位且详情确实开着时启动关闭动画，返回是否实际执行（#282 条件消费
  // 的依据——分发层据此决定 return true / false，不再无条件吞键）
  const closeDetail = useCallback((): boolean => {
    if (navPhase !== "idle" || !detail) return false;
    setNavPhase("closing");
    Animated.timing(navX, { toValue: Dimensions.get("window").width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setDetail(null);
        setNavPhase("idle");
      }
    });
    return true;
  }, [navPhase, detail, navX]);
  // navPhase 卡相位兜底（#282）：动画 finished 回调可能因 JS 线程繁忙被打断/丢失，
  // entering/closing 永不回 idle 会让 openDetail/closeDetail 永久拒绝——正是详情页
  // 返回键静默失灵的守卫源头。500ms > 滑入 230ms/滑出 200ms，超时按应然结果收场放行
  useEffect(() => {
    if (navPhase === "idle") return;
    const t = setTimeout(() => {
      if (navPhase === "closing") setDetail(null);
      setNavPhase("idle");
    }, 500);
    return () => clearTimeout(t);
  }, [navPhase]);
  const [sheet, setSheet] = useState(false);
  // null=关闭；"new"=新增服务器；其余字符串=编辑该 id 的服务器
  const [setup, setSetup] = useState<string | null>(null);
  // 设置页进页即扫码（#276 抽屉「扫码添加」入口）：SetupScreen 每次开页重挂载，
  // 该标记只在打开瞬间消费；各打开路径都显式置值，杜绝上次残留误拉起
  const [setupScan, setSetupScan] = useState(false);
  // 任务汇报卡展开态提到 Shell（#282）：硬件返回要在顶层先收卡；列表抽屉/图例开闭
  // 只有 ListScreen 知道，经 ref 句柄承接分发
  const [tdExpanded, setTdExpanded] = useState(false);
  // #306 待确认悬浮卡展开态同款持有（硬件返回顶层先收卡）。两张卡都锚 right:12，
  // 同时展开会叠卡——开一张收另一张（互斥）
  const [cfExpanded, setCfExpanded] = useState(false);
  const openTd = useCallback((v: boolean) => {
    setTdExpanded(v);
    if (v) setCfExpanded(false);
  }, []);
  const openCf = useCallback((v: boolean) => {
    setCfExpanded(v);
    if (v) setTdExpanded(false);
  }, []);
  const listBackRef = useRef<ListBackHandle | null>(null);
  const detailBackRef = useRef<DetailBackHandle>(null);

  // 硬件返回统一分发（#282）：全 App 唯一 BackHandler 订阅（原 DetailScreen/
  // ListScreen 抽屉+图例/TaskDoneFloat/SetupScreen 各自订阅全部并入）。按
  // 设置页 → 汇报卡 → 详情 → 列表浮层 的优先级消费；仅实际执行了返回动作才
  // return true，无路可退 return false 走系统默认退出语义——废除「无条件消费 +
  // 守卫拒绝」的静默吞键组合
  const onHardwareBack = useCallback((): boolean => {
    // 设置页（从 ⚙ 进入，可退）→ 回主界面；首次配置无路可退不消费
    if (setup !== null) {
      if (hasCfg) {
        setSetup(null);
        return true;
      }
      return false;
    }
    // 任务汇报卡/待确认卡展开：先收卡（不拽走底下的详情/列表）
    if (tdExpanded || cfExpanded) {
      setTdExpanded(false);
      setCfExpanded(false);
      return true;
    }
    // 详情开 → 关详情（动画窗口期被相位守卫拒绝时不消费，500ms 兜底放行后恢复）
    if (detail) return (detailBackRef.current?.requestBack() ?? false) || closeDetail();
    // 列表抽屉/图例浮窗开 → 关浮层（列表页挂载时才可能）
    if (listBackRef.current?.requestBack()) return true;
    // 根路由列表：不消费，交给系统默认
    return false;
  }, [setup, hasCfg, tdExpanded, cfExpanded, detail, closeDetail]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", onHardwareBack);
    return () => sub.remove();
  }, [onHardwareBack]);

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
  // fgStarted：服务一旦起过就置位（stop 从不调用），后续文案刷新不再受连接态门控
  const fgStarted = useRef(false);
  useEffect(() => {
    if (!snap.connected) return;
    void ensureNotifPermission();
    if (fgSupported()) {
      startForegroundService();
      fgStarted.current = true;
    }
  }, [snap.connected]);

  // #301 前台服务通知正文随会话/连接态刷新：格式「N 会话 · X 运行 · Y 等待 · Z 错误」
  // （仅计非零项）。快照每秒都换引用，故按文案 key 比对——状态分布/连接态没变不重发
  const fgText = useRef("");
  useEffect(() => {
    if (!fgStarted.current) return;
    let text: string;
    if (!snap.connected) {
      text = snap.connState === "idle" ? "未连接 · 未配置" : "未连接 · 重连中";
    } else if (!snap.sessions.length) {
      text = "已连接 · 暂无会话";
    } else {
      const dist: Partial<Record<SessionState["status"], number>> = { WORKING: 0, WAITING: 0, ERROR: 0 };
      for (const s of snap.sessions) if (s.status in dist) dist[s.status] = (dist[s.status] ?? 0) + 1;
      const parts = [`${snap.sessions.length} 会话`];
      if (dist.WORKING) parts.push(`${dist.WORKING} 运行`);
      if (dist.WAITING) parts.push(`${dist.WAITING} 等待`);
      if (dist.ERROR) parts.push(`${dist.ERROR} 错误`);
      text = parts.join(" · ");
    }
    if (text === fgText.current) return;
    fgText.current = text;
    updateForeground(text);
  }, [snap.sessions, snap.connected, snap.connState]);

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
              ref={listBackRef}
              sessions={snap.sessions}
              connected={snap.connected}
              connText={snap.connText}
              onOpen={openDetail}
              onNew={() => setSheet(true)}
              onSetup={() => { setSetupScan(false); setSetup("new"); }}
              onScanServer={() => { setSetupScan(true); setSetup("new"); }}
              onEditServer={(id) => { setSetupScan(false); setSetup(id); }}
            />
          )}
          {detail ? (
            <Animated.View
              style={[st.navLayer, { transform: [{ translateX: navX }] }]}
            >
              <DetailScreen
          ref={detailBackRef} sid={detail} initialView={detailView} onBack={closeDetail} />
            </Animated.View>
          ) : null}
          <NewSessionModal visible={sheet} onClose={() => setSheet(false)} />
          <Toast />
          <TaskDoneFloat
            isDetail={!!detail && navPhase !== "closing"}
            expanded={tdExpanded}
            setExpanded={openTd}
            onOpenSession={(sid) => {
              // 动画窗口期 openDetail 拒跳转：此时不得清汇报，否则既没进会话又丢了通知
              if (openDetail(sid)) store.clearTaskDone(sid);
            }}
          />
          <ConfirmFloat
            isDetail={!!detail && navPhase !== "closing"}
            hasTaskDone={snap.taskDoneQueue.length > 0}
            expanded={cfExpanded}
            setExpanded={openCf}
            onOpen={(sid) => {
              // 动画窗口期 openDetail 拒跳转时保持卡开着（既没跳成又不丢清单）
              if (openDetail(sid, "todos")) openCf(false);
            }}
          />
        </>
      ) : (
        <SetupScreen
          onClose={hasCfg ? () => setSetup(null) : undefined}
          editId={setup && setup !== "new" ? setup : null}
          initialScan={setupScan}
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
  // 汇报小方钮基础形（位置/尺寸/圆角），两种表面形态：详情页沿用 done 轻染底；
  // 列表页盖在会话卡上，轻染底会透出卡面文字——改实底 panel + 描边 + 高一点的 elevation
  tdFab: {
    position: "absolute", right: 12, width: 44, height: 44, borderRadius: 14,
    overflow: "visible",
  },
  tdFabDetail: {
    backgroundColor: withA(c.done, 0.10), borderWidth: 1, borderColor: withA(c.done, 0.45), elevation: 4,
  },
  tdFabList: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.done, 0.5), elevation: 6,
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
  // #306 待确认悬浮（cf = confirm float）：形制与 td* 同款，品牌色系换语义。
  // 悬浮层根：全屏 box-none，按钮/卡片/scrim 各自绝对定位
  cfWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 80 },
  cfScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  // 小方钮：与 tdFab 同尺寸同圆角；落位（right/上偏）由 JSX 按 TaskDoneFloat 在场与否注入
  cfFab: {
    position: "absolute", right: 12, width: 44, height: 44, borderRadius: 14,
    overflow: "visible",
  },
  cfFabDetail: {
    backgroundColor: withA(c.brandA, 0.10), borderWidth: 1, borderColor: withA(c.brandA, 0.45), elevation: 4,
  },
  cfFabList: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.brandA, 0.5), elevation: 6,
  },
  cfFabHit: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 14, overflow: "hidden" },
  cfFabT: { color: c.brandA, fontSize: 17, fontWeight: "800" },
  cfBadge: {
    position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5, backgroundColor: c.brandA, alignItems: "center", justifyContent: "center",
    elevation: 5,
  },
  // 品牌蓝底上的深色徽标字（同 tdBadgeT 的深底浅字反向配色逻辑）
  cfBadgeT: { color: "#06182E", fontSize: 11, fontWeight: "800" },
  // 展开卡：同 tdCard 形制；按会话分组——组头会话名（displaySrcName 缩写）+ 条目行
  cfCard: {
    position: "absolute", left: 12, right: 12, maxHeight: "78%",
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.brandA, 0.28),
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, elevation: 8,
  },
  cfSrc: { color: c.faint, fontSize: 11.5, marginTop: 9 },
  cfSrc0: { marginTop: 0 },
  cfItemRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 5 },
  cfItemHit: {
    flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8,
    borderRadius: 9, overflow: "hidden", paddingRight: 2, paddingVertical: 2,
  },
  cfItemMark: { color: c.brandA, fontSize: 12.5, fontWeight: "700", lineHeight: 18 },
  cfItem: { flex: 1, color: c.text, fontSize: 12.5, lineHeight: 18 },
  cfRef: { color: c.brandA, fontWeight: "700" },
  cfX: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  cfXT: { color: c.dim, fontSize: 12 },
  cfMore: { color: c.faint, fontSize: 11.5, marginTop: 7 },
  cfBtnRow: { flexDirection: "row", gap: 8, marginTop: 9 },
  cfAll: {
    height: 28, paddingHorizontal: 10, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: withA(c.brandA, 0.14), borderWidth: 1, borderColor: withA(c.brandA, 0.35),
  },
  cfAllT: { color: c.brandA, fontSize: 11.5, fontWeight: "600" },
});
