// 通知中心 tab 页（W-EXPOLISH 件二：通知升独立 tab，五域第四域）。
// 原 NotifCenterModal（ListScreen 底部弹层）整体迁宿主：池+分组+已处理折叠数据面
// 原样保留，呈现从弹层改 tab 页常驻。会话页铃铛入口同步退役（单入口纪律）——badge
//（未处理数）挂通知 tab，由 App.tsx 以同一 notifActionableOf 口径计算。
// 硬条款原样保持：
//   不清零（B3a）：打开/浏览/切 tab/重连/动作失败回滚零删行——本组件无任何清池
//   state；badge 与行动行只随 handled/dismissed 权威账收缩。池只读自 store 快照。
//   动作经 ACK 严格判定门（org-commands）：失败行内错误可重试，飞行中按钮转「…」；
//   旧 relay notifications null/缺失 → 池空自然降级空态，不崩不伪造。
//   M13-6E resolved 分离：已处理行拆入「已处理 N」折叠分区（默认收起），main/resolved
//   两区各保池序不重排；切走 tab 重挂载即回默认折叠（同原「关闭即回默认」语义）。
//   M13-6E 验收回跳：task 落点 = 本页宿主 GroupModal 定位台账卡（原弹层落在
//   ListScreen 的同款行为）；session 落点 = onOpenSession 打开原会话（App 层
//   openDetail，详情层盖过 tab 栏，返回回本 tab）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { fmtLastActive, displaySrcName } from "../fmt";
import { splitResolvedRows, notifActionableOf, notifDoneAt, jumpTargetOf, type NotifJumpTarget } from "../notify-jump";
import { ackTapGuard, ackVerdict, unknownCommandError } from "../org-commands";
import { store, useRelay } from "../store";
import type { NotificationItem } from "../protocol";
import { GroupModal } from "./OrgZone";

export default function NotifCenterPage({ onOpenSession }: { onOpenSession: (sid: string) => void }) {
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
  // 切 tab 重挂载即回默认，同原弹层「关闭即回默认收起」口径）
  const { main, resolved } = useMemo(() => splitResolvedRows(rows, (r) => notifDoneAt(r.item)), [rows]);
  const [resolvedOpen, setResolvedOpen] = useState(false);

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

  // 验收回跳 task 落点：组详情弹窗宿主在本页（原弹层时代落在 ListScreen）
  const [gmOpen, setGmOpen] = useState<{ srcId: string; gid: string; name: string; entryId?: string } | null>(null);
  const onJump = useCallback((target: NotifJumpTarget, srcId: string) => {
    if (target.type === "session") { onOpenSession(target.sid); return; }
    // task 落点：组详情打开后高亮定位台账卡；组不在该源 projects 在册（缓存悬空）
    // =不跳不假造（M12-7 unknown-target 同哲学）
    const g = (snap.sources.find((x) => x.id === srcId)?.projects ?? []).find((pg) => pg.id === target.gid);
    if (!g) return;
    setGmOpen({ srcId, gid: target.gid, name: g.name, entryId: target.entryId });
  }, [snap.sources, onOpenSession]);

  const renderRow = (row: { srcId: string; srcName: string; item: NotificationItem }) => {
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
    return (
      <View key={`${srcId}/${item.key}`} style={styles.notiRow}>
        <View style={styles.notiRowHead}>
          {actionable ? <View style={styles.notiDot} /> : null}
          <Text style={[styles.notiRowTitle, !actionable && { color: c.dim }]} numberOfLines={1}>{item.title}</Text>
          {doneAt !== null ? <Text style={styles.notiDoneAt}>{fmtLastActive(doneAt)}</Text> : null}
          <Text style={styles.notiSrc} numberOfLines={1}>{srcName}</Text>
        </View>
        {item.body ? <Text style={styles.notiBody} numberOfLines={2}>{item.body}</Text> : null}
        {err ? <Text style={styles.notiErrT} numberOfLines={2}>{err}</Text> : null}
        {jump ? (
          // M13-6E 验收回跳（规格②，web nr-jmp 行同语义）：点击打开组详情定位台账卡 /
          // 打开原会话；降级路径无此按钮不假造
          <Pressable
            style={styles.notiJumpBtn}
            hitSlop={6}
            accessibilityLabel={`定位来源：${item.title}`}
            onPress={() => onJump(jump, srcId)}
          >
            <Text style={styles.notiJumpT}>定位来源 ›</Text>
          </Pressable>
        ) : null}
        {actionable ? (
          <View style={styles.notiActRow}>
            <Pressable
              style={[styles.notiBtn, { backgroundColor: c.done, opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              accessibilityLabel={`知道了：${item.title}`}
              onPress={() => act(item.key, "handled")}
            >
              <Text style={[styles.notiBtnT, { color: c.onDone }]}>{busy ? "…" : "知道了"}</Text>
            </Pressable>
            <Pressable
              style={[styles.notiBtn, styles.notiBtnGhost, { borderColor: withA(c.dim, 0.5), opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              accessibilityLabel={`忽略：${item.title}`}
              onPress={() => act(item.key, "dismissed")}
            >
              <Text style={[styles.notiBtnT, { color: c.dim }]}>{busy ? "…" : "忽略"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.headT}>通知中心</Text>
        <Text style={styles.headSub}>{pendingKeys.size > 0 ? `${pendingKeys.size} 项需行动` : "暂无待行动项"}</Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
        {rows.length === 0 ? (
          <Text style={styles.notiEmpty}>暂无通知</Text>
        ) : (
          <>
            {main.map(renderRow)}
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
                  <Text style={styles.notiResolvedT}>已处理 {resolved.length} {resolvedOpen ? "▴" : "▾"}</Text>
                </Pressable>
                {resolvedOpen ? resolved.map(renderRow) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      {gmOpen ? (
        <GroupModal
          srcId={gmOpen.srcId}
          target={{ gid: gmOpen.gid, name: gmOpen.name }}
          highlightEntryId={gmOpen.entryId}
          onClose={() => setGmOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </SafeAreaView>
  );
}

// 样式：noti* 自原 NotifCenterModal（ListScreen makeStyles）原样迁入；page/head 为
// tab 页容器新增（弹层 mask/sheet 形制退役）
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    head: {
      flexDirection: "row", alignItems: "baseline", gap: 8,
      paddingHorizontal: 16, paddingTop: 9, paddingBottom: 6,
      borderBottomWidth: 1, borderBottomColor: c.line,
    },
    headT: { color: c.text, fontSize: 15, fontWeight: "700" },
    headSub: { color: c.brandA, fontSize: 11, fontWeight: "600" },
    list: { flex: 1, paddingHorizontal: 14 },
    notiEmpty: { color: c.faint, fontSize: 12, textAlign: "center", paddingVertical: 32 },
    notiRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 4 },
    notiRowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    notiDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.working },
    notiRowTitle: { color: c.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    notiSrc: { color: c.faint, fontSize: 10, marginLeft: "auto" },
    notiBody: { color: c.dim, fontSize: 12, lineHeight: 17 },
    notiActRow: { flexDirection: "row", gap: 8, marginTop: 2 },
    notiBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
    notiBtnGhost: { backgroundColor: "transparent", borderWidth: 1 },
    notiBtnT: { fontSize: 12, fontWeight: "600" },
    notiErrT: { color: c.error, fontSize: 11, lineHeight: 15 },
    // M13-6E：已处理行时间戳（复用 notiSrc 灰态小字语言）+「已处理 N」折叠分区头
    notiDoneAt: { color: c.faint, fontSize: 10 },
    notiResolvedHead: { paddingVertical: 10, alignItems: "center" },
    notiResolvedT: { color: c.faint, fontSize: 11, fontWeight: "600" },
    // M13-6E：acceptance 域回跳按钮（未处理行「定位来源 ›」——ghost 同款形制小号化）
    notiJumpBtn: { alignSelf: "flex-start", borderRadius: 8, borderWidth: 1, borderColor: withA(c.dim, 0.5), paddingHorizontal: 10, paddingVertical: 4, marginTop: 2 },
    notiJumpT: { color: c.dim, fontSize: 11, fontWeight: "600" },
  });
