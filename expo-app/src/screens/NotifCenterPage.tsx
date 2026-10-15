// 通知中心二级页（W-MV8A：v8.5 v3 手机壳 ph-pnotif 形态——全屏页 + ‹ 返回 + 三分区，
// 贴底 sheet 形态退役；文件名留 NotifCenterPage 记录形态变迁史）。数据面自原
// NotifCenterSheet 逐字迁移，硬条款原样保持：
//   不清零（B3a）：打开/浏览/关闭/重连/动作失败回滚零删行——本组件无任何清池
//   state；badge 与行动行只随 handled/dismissed 权威账收缩。池只读自 store 快照。
//   动作经 ACK 严格判定门（org-commands）：失败行内错误可重试，飞行中按钮转「…」；
//   旧 relay notifications null/缺失 → 池空自然降级空态，不崩不伪造。
//   M13-6E resolved 分离：已处理行拆入「已处理 N」折叠分区（默认收起），main/resolved
//   两区各保池序不重排；关闭即回默认折叠（原规格①语义）。
//   M13-6E 验收回跳：task 落点 = 本页宿主 TeamDetailPage 定位台账卡；session 落点 =
//   onOpenSession 打开原会话（ListScreen onOpen → App openDetail）。
// W-MV8A v3 视觉层：main 区按 actionable 拆「需你行动」（红点组——常驻手动关）与
// 「动态」（灰点组）两组（v3 ngrp/ndot 语言；「注意」黄组无数据域支撑不虚构）；
// 行语言 = v3 nrow（severity 图标 + 标题加粗 + 摘要 dim + 行内动作钮）。
//   通知 badge（未处理数）挂 ListScreen 顶栏铃铛（v3 appbar bell + bbadge）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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

export default function NotifCenterSheet({ open, onClose, onOpenSession }: {
  open: boolean;
  onClose: () => void;
  onOpenSession: (sid: string) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  // 池 = 全源 notifications 只读平铺（原 ListScreen notifRows 同口径——badge 与页面
  // 内容同源，App 层 tab badge 用同一函数计算，两处计数必一致）
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
  // M13-6E 分区：done 行拆入「已处理 N」折叠区（默认收起；展开态本地内存级——
  // 关闭即回默认收起，原规格①口径）
  const { main, resolved } = useMemo(() => splitResolvedRows(rows, (r) => notifDoneAt(r.item)), [rows]);
  // W-MV8A v3 三分组：main 拆「需你行动 / 动态」（splitNotifGroups 纯函数）
  const { action, feed } = useMemo(() => splitNotifGroups(main, pendingKeys), [main, pendingKeys]);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  useEffect(() => {
    if (!open) setResolvedOpen(false);
  }, [open]);

  // 动作 ACK 门（原 ListScreen notifAct 迁入）：双击闸防重复 ACK；乐观回滚由 store
  // 负责（E3b 行回来），本层只呈现行内错误；无自动重试（重试=重点按钮）
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

  // 验收回跳 task 落点：组详情页宿主在本页（session 落点先收本页再跳——Modal 在
  // 最上层，不收会盖住打开的详情页；原 NotifCenterModal 同款顺序）
  const [gmOpen, setGmOpen] = useState<{ srcId: string; gid: string; name: string; entryId?: string } | null>(null);
  const onJump = useCallback((target: NotifJumpTarget, srcId: string) => {
    if (target.type === "session") { onClose(); onOpenSession(target.sid); return; }
    // task 落点：组详情打开后高亮定位台账卡；组不在该源 projects 在册（缓存悬空）
    // =不跳不假造（M12-7 unknown-target 同哲学）
    const g = (snap.sources.find((x) => x.id === srcId)?.projects ?? []).find((pg) => pg.id === target.gid);
    if (!g) return;
    setGmOpen({ srcId, gid: target.gid, name: g.name, entryId: target.entryId });
  }, [snap.sources, onOpenSession, onClose]);

  const renderRow = (row: { srcId: string; srcName: string; item: NotificationItem }, zone: "action" | "feed" | "done") => {
    const { srcId, srcName, item } = row;
    const actionable = pendingKeys.has(item.key);
    const busy = flight.has(item.key);
    const err = errs.get(item.key);
    const doneAt = notifDoneAt(item);
    // 回跳点击面口径对齐 web（canJmp=actionable 且未收口；已处理区=归档语义纯展示）。
    // 落点解析与 web notifJumpTarget 同链：dispatch 域板缓存反查→task；降级 sessionId
    // →session；解析不出=null 无按钮（不假造）。源板缓存取自该行 srcId 对应源
    const jump = actionable && doneAt === null
      ? jumpTargetOf(item, { sessions: snap.sessions, srcId, boards: snap.sources.find((x) => x.id === srcId)?.boards })
      : null;
    const iconColor = zone === "action" ? c.error : zone === "done" ? c.done : c.faint;
    return (
      <View key={`${srcId}/${item.key}`} style={[styles.notiRow, zone === "action" && styles.notiRowAlert]}>
        <View style={styles.notiRowIn}>
          <View style={styles.notiIc}><NotifIcon kind={zone} color={iconColor} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.notiRowTitle, zone !== "action" && { color: c.dim }]} numberOfLines={1}>{item.title}</Text>
            {item.body ? <Text style={styles.notiBody} numberOfLines={2}>{item.body}</Text> : null}
            <Text style={styles.notiMeta} numberOfLines={1}>
              {srcName}{doneAt !== null ? ` · ${fmtLastActive(doneAt)}` : item.created_at ? ` · ${fmtLastActive(item.created_at)}` : ""}
            </Text>
          </View>
          {/* × 忽略（v3 .x：行缘关闭位；需行动区常驻手动关——B3a 不清零，dismissed 走权威账） */}
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
            {/* v3 .act 语言：定位来源 = brand 边框小钮（验收单 ↗ 同位） */}
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
  };

  // v3 ngrp 组头：色点 + 组名 + 计数（ndot r=需行动 / n=动态）
  const groupHead = (label: string, n: number, color: string, extra?: string) => (
    <View style={styles.ngrp}>
      <View style={[styles.ndot, { backgroundColor: color }]} />
      <Text style={styles.ngrpT}>{label}</Text>
      <Text style={styles.ngrpN}>{n}</Text>
      {extra ? <Text style={styles.ngrpExtra}>{extra}</Text> : null}
    </View>
  );

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.page} edges={["top"]}>
        {/* v3 appbar：‹ 返回 + 标题 + 副题「N 需你行动」 */}
        <View style={styles.head}>
          <Pressable android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }} hitSlop={8} accessibilityLabel="返回" onPress={onClose} style={styles.back}>
            <Text style={styles.backT}>‹</Text>
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.headT}>通知</Text>
            <Text style={styles.headSub} numberOfLines={1}>
              {pendingKeys.size > 0 ? `${pendingKeys.size} 项需你行动` : "暂无待行动项"}
            </Text>
          </View>
        </View>
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {rows.length === 0 ? (
            <Text style={styles.notiEmpty}>暂无通知</Text>
          ) : (
            <>
              {action.length ? (
                <View>
                  {groupHead("需你行动", action.length, c.error, "· 常驻 · 手动关")}
                  {action.map((r) => renderRow(r, "action"))}
                </View>
              ) : null}
              {feed.length ? (
                <View>
                  {groupHead("动态", feed.length, c.faint)}
                  {feed.map((r) => renderRow(r, "feed"))}
                </View>
              ) : null}
              {resolved.length > 0 ? (
                // M13-6E「已处理 N」折叠分区（规格①）：默认收起防长跑堆积；
                // 行不删除（不清零硬条款不破——拆区≠删行，池仍只读自快照）
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
              <Text style={styles.footNote}>需你行动项常驻（手动关）· 处理后归「已处理」· 计数只随权威账收缩</Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
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

// 样式：v3 ph-pnotif ngrp/nrow 语言；数据行族（noti*）自原 NotifCenterSheet 迁入改排
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    head: {
      flexDirection: "row", alignItems: "center", gap: 8,
      paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1,
      borderBottomColor: c.line, backgroundColor: c.panel,
    },
    back: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
    backT: { color: c.brandA, fontSize: 24, fontWeight: "600", marginTop: -2 },
    headT: { color: c.textStrong, fontSize: 16, fontWeight: "700" },
    headSub: { color: c.working, fontSize: 10.5, fontWeight: "700", marginTop: 2 },
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
