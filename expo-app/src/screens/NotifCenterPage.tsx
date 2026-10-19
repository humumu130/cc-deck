// 通知抽屉（W-NOTIFY2 件一：用户 1018 拍板——全屏覆盖形态退役，改 bottom-sheet）。
// 数据面自 W-MV8A 版逐字保留，硬条款原样保持：
//   不清零（B3a）：打开/浏览/关闭/重连/动作失败回滚零删行——本组件无任何清池
//   state；badge 与行动行只随 handled/dismissed 权威账收缩。池只读自 store 快照。
//   动作经 ACK 严格判定门（org-commands）：失败行内错误可重试，飞行中按钮转「…」；
//   旧 relay notifications null/缺失 → 池空自然降级空态，不崩不伪造。
//   M13-6E resolved 分离：「已处理 N」折叠分区（默认收起），关闭即回默认折叠。
//   验收回跳：task 落点 = 本页宿主 TeamDetailPage 定位台账卡；session 落点 =
//   onOpenSession 打开原会话。
// W-MV8A v3 视觉层保留：main 区「需你行动（红点组·常驻手动关）/动态（灰点组）」
//   两组、v3 nrow 行语言、severity 图标。
// 抽屉形态（本批新增交互）：
//   · 高 72% 屏（2/3~3/4 间），圆角顶+居中 grabber；上拉动效（240ms out-cubic）
//   · 抽屉头：grabber 下行 = 标题+行动计数 | 右「清除全部」（对全部未处理行批量
//     dismissed ACK——走权威账不违 B3a）
//   · 下拉抽屉头 >60px 关闭；点压暗区关闭；硬件返回关闭
//   · 行左/右滑删（NotifSwipeRow：横滑跟手位移，|dx|≥72 判删触发 dismissed ACK
//     +滑出动画，未过阈 spring 回弹；纵滑放行给列表滚动——横占优判定同 Shell 域滑切）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { fmtLastActive, displaySrcName } from "../fmt";
import { splitResolvedRows, notifActionableOf, notifDoneAt, jumpTargetOf, type NotifJumpTarget } from "../notify-jump";
import { ackTapGuard, ackVerdict, unknownCommandError } from "../org-commands";
import { store, useRelay } from "../store";
import type { NotificationItem } from "../protocol";
import { TeamDetailPage } from "./TeamDetailPage";

// main 区三分组投影（纯函数——scripts/test-mv8a.ts 断言面）：actionable 拆
// 「需你行动」，其余未处理归「动态」。两组合计 = main 全集（不丢行），各保池序
export function splitNotifGroups<T extends { item: NotificationItem }>(
  rows: T[],
  actionableKeys: Set<string>,
): { action: T[]; feed: T[] } {
  const action: T[] = [];
  const feed: T[] = [];
  for (const r of rows) (actionableKeys.has(r.item.key) ? action : feed).push(r);
  return { action, feed };
}

// 行首 severity 图标（v3 nrow .ic）：需行动=zap（红）、动态=inbox（灰）、已处理=check（绿）
function NotifIcon({ kind, color }: { kind: "action" | "feed" | "done"; color: string }) {
  const common = {
    fill: "none" as const,
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <Svg width={15} height={15} viewBox="0 0 24 24">
      {kind === "action" ? (
        // zap（闪电=需你行动，v3 #i-zap）
        <Path {...common} d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      ) : kind === "done" ? (
        // check
        <Path {...common} d="M20 6 9 17l-5-5" />
      ) : (
        // inbox
        <>
          <Path {...common} d="M22 12h-6l-2 3h-4l-2-3H2" />
          <Path {...common} d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </>
      )}
    </Svg>
  );
}

// 滑删阈值（|dx|≥此值松手判删；滑动中跟手位移）
const SWIPE_DELETE_PX = 72;

// 滑删行（W-NOTIFY2 件一③）：横滑跟手位移，松手过阈→onSwipeDismiss（walk 权威账
// dismissed）；未过阈 spring 回 0。纵滑让位（横占优 |dx|>|dy|*2 判定同 Shell 域
// 滑切——列表竖滚零冲突）。已处理区行不可滑（归档语义）。
function NotifSwipeRow({ swipeable, onSwipeDismiss, children, styles, c }: {
  swipeable: boolean;
  onSwipeDismiss: () => void;
  children: React.ReactNode;
  styles: { swipeHint: number; swipeHintBg: { backgroundColor: string } };
  c: ThemeColors;
}) {
  const x = useRef(new Animated.Value(0)).current;
  // 锁定态（capture 判定后横占优才接管；once 防重复 release）
  const grabbed = useRef(false);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        swipeable && Math.abs(g.dx) >= 16 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderGrant: () => { grabbed.current = true; x.stopAnimation(() => undefined); x.setValue(0); },
      onPanResponderMove: (_e, g) => { if (grabbed.current) x.setValue(g.dx); },
      onPanResponderRelease: (_e, g) => {
        if (!grabbed.current) return;
        grabbed.current = false;
        if (Math.abs(g.dx) >= SWIPE_DELETE_PX || Math.abs(g.vx) >= 2.2) {
          // 判删：向滑动方向滑出（260ms）→ 权威账 dismissed
          Animated.timing(x, { toValue: g.dx >= 0 ? 360 : -360, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => onSwipeDismiss());
        } else {
          // 未过阈：spring 回弹
          Animated.spring(x, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        grabbed.current = false;
        Animated.spring(x, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }).start();
      },
    }),
  ).current;
  if (!swipeable) return <>{children}</>;
  return (
    <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
      {children}
      {/* 滑动提示层：左滑露右缘「删除」色带（translateX 联动——简化实现：行下滑出即删，
          色带为视觉暗示，x<0 时右缘淡入）。低耦合实现：absolute 右缘条 + x 插值 opacity */}
      <Animated.View
        pointerEvents="none"
        style={[styles.swipeHintBg, { position: "absolute", right: 0, top: 6, bottom: 11, width: 54, borderTopLeftRadius: 8, borderBottomLeftRadius: 8, alignItems: "center", justifyContent: "center", opacity: x.interpolate({ inputRange: [-SWIPE_DELETE_PX, -16], outputRange: [1, 0], extrapolate: "clamp" }) }]}
      >
        <Text style={{ color: "#fff", fontSize: 10.5, fontWeight: "700" }}>删除</Text>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", left: 0, top: 6, bottom: 11, width: 54, borderTopRightRadius: 8, borderBottomRightRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: withA(c.error, 0.85) }, { opacity: x.interpolate({ inputRange: [16, SWIPE_DELETE_PX], outputRange: [0, 1], extrapolate: "clamp" }) }]}
      >
        <Text style={{ color: "#fff", fontSize: 10.5, fontWeight: "700" }}>删除</Text>
      </Animated.View>
    </Animated.View>
  );
}

export default function NotifCenterSheet({ open, onClose, onOpenSession }: {
  open: boolean;
  onClose: () => void;
  onOpenSession: (sid: string) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const snap = useRelay();
  // 池 = 全源 notifications 只读平铺（badge 与页面内容同源，App 层 tab badge 同函数）
  const rows = useMemo(() => {
    const out: { srcId: string; srcName: string; item: NotificationItem }[] = [];
    for (const src of snap.sources)
      for (const n of src.notifications ?? [])
        out.push({ srcId: src.id, srcName: displaySrcName(src.name), item: n });
    return out;
  }, [snap.sources]);
  const pendingKeys = useMemo(
    () => new Set(notifActionableOf(rows.map((r) => r.item)).map((n) => n.key)),
    [rows],
  );
  const { main, resolved } = useMemo(() => splitResolvedRows(rows, (r) => notifDoneAt(r.item)), [rows]);
  const { action, feed } = useMemo(() => splitNotifGroups(main, pendingKeys), [main, pendingKeys]);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  useEffect(() => {
    if (!open) setResolvedOpen(false);
  }, [open]);

  // 动作 ACK 门：双击闸防重复 ACK；乐观回滚由 store 负责（E3b 行回来），本层只呈现
  // 行内错误；无自动重试（重试=重点按钮）
  const [flight, setFlight] = useState<Set<string>>(new Set());
  const [errs, setErrs] = useState<Map<string, string>>(new Map());
  const act = useCallback((key: string, action: "handled" | "dismissed") => {
    if (ackTapGuard(flight, key) === "skip") return;
    setFlight((prev) => new Set(prev).add(key));
    const settle = (msg: string | null): void => {
      setFlight((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      setErrs((prev) => {
        const n = new Map(prev);
        if (msg) n.set(key, msg);
        else n.delete(key);
        return n;
      });
    };
    const sent = store.ackNotification(key, action, (r) => {
      const v = ackVerdict({ ok: r.ok, error: r.err });
      if (v.ok) {
        settle(null);
        return;
      }
      settle(unknownCommandError(v.error) ? "该源 relay 版本不支持通知动作" : v.error ?? "未生效，可重试");
    });
    if (!sent) settle(ackVerdict(null).error); // 未连接：unconfirmed 文案
  }, [flight]);

  // 清除全部（W-NOTIFY2 件一④）：对全部未处理行（需行动+动态）批量 dismissed——
  // 逐条走 ACK 权威账（B3a 不清零条款不违：dismissed=权威态迁移非本地删池）。
  // 「需行动」组的行常驻条款针对浏览不针对批量清除（用户显式动作）；已处理区不动。
  const [clearing, setClearing] = useState(false);
  const clearAll = useCallback(() => {
    if (clearing || main.length === 0) return;
    setClearing(true);
    for (const r of main) {
      if (ackTapGuard(flight, r.item.key) === "skip") continue;
      store.ackNotification(r.item.key, "dismissed", () => undefined);
    }
    // 本地 flight 即清（ACK 回包走权威账全局收缩）；按钮态 400ms 收口防连点
    setTimeout(() => setClearing(false), 400);
  }, [clearing, main, flight]);

  // 抽屉动效（件一①）：translateY 屏高→0；关闭反向。拉起 240ms out-cubic，收 200ms
  const sheetY = useRef(new Animated.Value(Dimensions.get("window").height)).current;
  const sheetH = Math.round(Dimensions.get("window").height * 0.72);
  const animating = useRef(false);
  useEffect(() => {
    if (open) {
      sheetY.setValue(sheetH + 40);
      Animated.timing(sheetY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    // 关闭动画由 closeSheet 显式驱动（下拉/压暗/返回三路同链）
  }, [open, sheetY, sheetH]);
  const closeSheet = useCallback(() => {
    if (animating.current) return;
    animating.current = true;
    Animated.timing(sheetY, { toValue: sheetH + 40, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
      animating.current = false;
      if (finished) onClose();
    });
  }, [sheetY, sheetH, onClose]);

  // 抽屉头下拉关闭（件一⑤）：竖下拉跟手（dy>0），松手 dy≥60 关闭否则回弹；
  // 未拉离位时横滑事件放行（不抢行滑删）
  const headY = useRef(new Animated.Value(0)).current;
  const headGrab = useRef(false);
  const headPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => g.dy >= 12 && g.dy > Math.abs(g.dx) * 2,
      onPanResponderGrant: () => { headGrab.current = true; headY.stopAnimation(() => undefined); },
      onPanResponderMove: (_e, g) => { if (headGrab.current && g.dy > 0) { headY.setValue(g.dy); sheetY.setValue(g.dy); } },
      onPanResponderRelease: (_e, g) => {
        if (!headGrab.current) return;
        headGrab.current = false;
        if (g.dy >= 60 || g.vy >= 1.2) { headY.setValue(0); closeSheet(); return; }
        Animated.parallel([
          Animated.spring(headY, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }),
          Animated.spring(sheetY, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        headGrab.current = false;
        Animated.parallel([
          Animated.spring(headY, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }),
          Animated.spring(sheetY, { toValue: 0, speed: 18, bounciness: 7, useNativeDriver: true }),
        ]).start();
      },
    }),
  ).current;

  // 验收回跳 task 落点（TeamDetailPage 宿主在本层）
  const [gmOpen, setGmOpen] = useState<{ srcId: string; gid: string; name: string; entryId?: string } | null>(null);
  const onJump = useCallback((target: NotifJumpTarget, srcId: string) => {
    if (target.type === "session") { closeSheet(); onOpenSession(target.sid); return; }
    const g = (snap.sources.find((x) => x.id === srcId)?.projects ?? []).find((pg) => pg.id === target.gid);
    if (!g) return;
    setGmOpen({ srcId, gid: target.gid, name: g.name, entryId: target.entryId });
  }, [snap.sources, onOpenSession, closeSheet]);

  const renderRow = (row: { srcId: string; srcName: string; item: NotificationItem }, zone: "action" | "feed" | "done") => {
    const { srcId, srcName, item } = row;
    const actionable = pendingKeys.has(item.key);
    const busy = flight.has(item.key);
    const err = errs.get(item.key);
    const doneAt = notifDoneAt(item);
    const jump = actionable && doneAt === null
      ? jumpTargetOf(item, { sessions: snap.sessions, srcId, boards: snap.sources.find((x) => x.id === srcId)?.boards })
      : null;
    const iconColor = zone === "action" ? c.error : zone === "done" ? c.done : c.faint;
    const inner = (
      <View style={[styles.notiRow, zone === "action" && styles.notiRowAlert]}>
        <View style={styles.notiRowIn}>
          <View style={styles.notiIc}><NotifIcon kind={zone} color={iconColor} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.notiRowTitle, zone !== "action" && { color: c.dim }]} numberOfLines={1}>{item.title}</Text>
            {item.body ? <Text style={styles.notiBody} numberOfLines={2}>{item.body}</Text> : null}
            <Text style={styles.notiMeta} numberOfLines={1}>
              {srcName}{doneAt !== null ? ` · ${fmtLastActive(doneAt)}` : item.created_at ? ` · ${fmtLastActive(item.created_at)}` : ""}
            </Text>
          </View>
          {actionable ? (
            <Pressable
              style={styles.notiXBtn}
              hitSlop={6}
              disabled={busy}
              accessibilityLabel={`忽略通知：${item.title}`}
              onPress={() => act(item.key, "dismissed")}
            >
              <Text style={styles.notiX}>{busy ? "…" : "×"}</Text>
            </Pressable>
          ) : null}
        </View>
        {err ? <Text style={styles.notiErrT} numberOfLines={2}>{err}</Text> : null}
        {actionable ? (
          <View style={styles.notiActRow}>
            {jump ? (
              <Pressable
                style={styles.notiJumpBtn}
                hitSlop={4}
                accessibilityLabel={`定位来源：${item.title}`}
                onPress={() => onJump(jump, srcId)}
              >
                <Text style={styles.notiJumpT}>定位来源 ↗</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.notiBtn, { backgroundColor: c.done, opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              accessibilityLabel={`知道了：${item.title}`}
              onPress={() => act(item.key, "handled")}
            >
              <Text style={[styles.notiBtnT, { color: c.onDone }]}>{busy ? "…" : "知道了"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
    // 未处理行（action/feed）可滑删（dismissed 权威账）；已处理区归档不可滑
    return (
      <NotifSwipeRow key={`${srcId}/${item.key}`} swipeable={zone !== "done"} onSwipeDismiss={() => act(item.key, "dismissed")} styles={{ swipeHint: 0, swipeHintBg: { backgroundColor: withA(c.error, 0.85) } }} c={c}>
        {inner}
      </NotifSwipeRow>
    );
  };

  // v3 ngrp 组头：色点 + 组名 + 计数
  const groupHead = (label: string, n: number, color: string, extra?: string) => (
    <View style={styles.ngrp}>
      <View style={[styles.ndot, { backgroundColor: color }]} />
      <Text style={styles.ngrpT}>{label}</Text>
      <Text style={styles.ngrpN}>{n}</Text>
      {extra ? <Text style={styles.ngrpExtra}>{extra}</Text> : null}
    </View>
  );

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={closeSheet} statusBarTranslucent>
      {/* 压暗区：点击关闭（件一①） */}
      <Pressable style={[styles.scrim, { paddingBottom: 0 }]} onPress={closeSheet} accessible={false} importantForAccessibility="no">
        <Animated.View />
      </Pressable>
      {/* 抽屉本体：72% 高+圆角顶+grabber；头下拉关闭区 */}
      <Animated.View style={[styles.sheet, { height: sheetH, paddingBottom: insets.bottom, transform: [{ translateY: sheetY }] }]}>
        <View style={styles.grabZone} {...headPan.panHandlers}>
          <View style={styles.grabber} />
          <View style={styles.sheetHeadRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.headT}>通知</Text>
              <Text style={styles.headSub} numberOfLines={1}>
                {pendingKeys.size > 0 ? `${pendingKeys.size} 项需你行动` : "暂无待行动项"}
              </Text>
            </View>
            {/* 清除全部（件一④）：批量 dismissed 走权威账；空池/飞行中禁用 */}
            <Pressable
              style={[styles.clearBtn, (main.length === 0 || clearing) && { opacity: 0.45 }]}
              disabled={main.length === 0 || clearing}
              accessibilityLabel="清除所有通知"
              onPress={clearAll}
            >
              <Text style={styles.clearT}>{clearing ? "清除中…" : "清除全部"}</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
          {rows.length === 0 ? (
            <Text style={styles.notiEmpty}>暂无通知</Text>
          ) : (
            <>
              {action.length ? (
                <View>
                  {groupHead("需你行动", action.length, c.error, "· 横滑删除 · 手动关")}
                  {action.map((r) => renderRow(r, "action"))}
                </View>
              ) : null}
              {feed.length ? (
                <View>
                  {groupHead("动态", feed.length, c.faint, "· 横滑删除")}
                  {feed.map((r) => renderRow(r, "feed"))}
                </View>
              ) : null}
              {resolved.length > 0 ? (
                <View>
                  <Pressable
                    style={styles.notiResolvedHead}
                    hitSlop={8}
                    accessibilityLabel={resolvedOpen ? "收起已处理通知" : `展开已处理通知 ${resolved.length} 条`}
                    onPress={() => setResolvedOpen((v) => !v)}
                  >
                    <View style={styles.ngrp}>
                      <View style={[styles.ndot, { backgroundColor: c.done }]} />
                      <Text style={styles.ngrpT}>已处理</Text>
                      <Text style={styles.ngrpN}>{resolved.length}</Text>
                      <Text style={styles.ngrpChev}>{resolvedOpen ? "▴" : "▾"}</Text>
                    </View>
                  </Pressable>
                  {resolvedOpen ? resolved.map((r) => renderRow(r, "done")) : null}
                </View>
              ) : null}
              <Text style={styles.footNote}>需你行动项常驻（手动关/横滑删）· 处理后归「已处理」· 计数只随权威账收缩</Text>
            </>
          )}
        </ScrollView>
      </Animated.View>
      {gmOpen ? (
        <TeamDetailPage
          srcId={gmOpen.srcId}
          gid={gmOpen.gid}
          name={gmOpen.name}
          highlightEntryId={gmOpen.entryId}
          onClose={() => setGmOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </Modal>
  );
}

// 样式：v3 ph-pnotif ngrp/nrow 语言保留；抽屉容器层新增（scrim/sheet/grabber/clear）
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    scrim: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(4,10,20,0.5)" },
    sheet: {
      position: "absolute", left: 0, right: 0, bottom: 0,
      borderTopLeftRadius: 16, borderTopRightRadius: 16,
      backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.line,
      overflow: "hidden",
    },
    grabZone: { paddingTop: 8, paddingHorizontal: 14, backgroundColor: c.panel, borderBottomWidth: 1, borderBottomColor: c.line },
    grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: c.faint, opacity: 0.7, marginBottom: 8 },
    sheetHeadRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 10 },
    headT: { color: c.textStrong, fontSize: 16, fontWeight: "700" },
    headSub: { color: c.working, fontSize: 10.5, fontWeight: "700", marginTop: 2 },
    clearBtn: {
      borderRadius: 8, borderWidth: 1, borderColor: withA(c.error, 0.45),
      paddingHorizontal: 11, paddingVertical: 6, backgroundColor: withA(c.error, 0.07),
    },
    clearT: { color: c.error, fontSize: 11.5, fontWeight: "700" },
    list: { flex: 1, paddingHorizontal: 12, paddingTop: 6 },
    notiEmpty: { color: c.faint, fontSize: 12, textAlign: "center", paddingVertical: 32 },
    // v3 .ngrp：分组头（色点 + 组名 + 计数）
    ngrp: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 4, paddingVertical: 8 },
    ndot: { width: 7, height: 7, borderRadius: 4 },
    ngrpT: { color: c.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
    ngrpN: { color: c.text, fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
    ngrpExtra: { color: c.faint, fontSize: 10 },
    ngrpChev: { color: c.faint, fontSize: 11, marginLeft: 2 },
    // v3 .nrow：行卡（alert 态=红边红底）
    notiRow: {
      borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel2,
      paddingHorizontal: 10, paddingVertical: 9, marginBottom: 5, gap: 6,
    },
    notiRowAlert: { borderColor: withA(c.error, 0.45), backgroundColor: withA(c.error, 0.06) },
    notiRowIn: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
    notiIc: { marginTop: 2, flexShrink: 0 },
    notiRowTitle: { color: c.textStrong, fontSize: 12.5, fontWeight: "600" },
    notiBody: { color: c.dim, fontSize: 11, lineHeight: 15, marginTop: 1 },
    notiMeta: { color: c.faint, fontSize: 10, marginTop: 2 },
    notiXBtn: { width: 24, height: 24, alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: -2 },
    notiX: { color: c.faint, fontSize: 14, fontWeight: "600" },
    notiActRow: { flexDirection: "row", gap: 8, paddingLeft: 24, alignItems: "center" },
    notiBtn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
    notiBtnT: { fontSize: 11.5, fontWeight: "700" },
    notiErrT: { color: c.error, fontSize: 11, lineHeight: 15, paddingLeft: 24 },
    notiJumpBtn: {
      borderRadius: 8, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
      paddingHorizontal: 10, paddingVertical: 6, backgroundColor: withA(c.brandA, 0.08),
    },
    notiJumpT: { color: c.brandA, fontSize: 11.5, fontWeight: "600" },
    notiResolvedHead: { marginTop: 4 },
    footNote: { color: c.faint, fontSize: 10, textAlign: "center", paddingVertical: 12, lineHeight: 15 },
  });
