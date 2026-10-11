// 团队 / 项目两域 tab 页（W-EXPOLISH 件三：三域占位页内容化·快赢版）。
// 团队 tab = OrgZone 组织区宿主（确认卡 ✓✗ + 团队 chips + 经验分节，原列表页头部
// 条件区整体迁入）；项目 tab = 项目组列表（跨源分组行：状态/档位/编制，点行开组详情）。
// 深交互（派单发起/建团/升降级/结项提案）留后续批——页内「去电脑端」指引；组详情
// GroupModal 为只读消费面（熟手池点开=打开会话），已可用。
// 数据面/决议 ACK 门 = OrgZone 模块 useOrgData/useOrgDecide（原 ListScreen 口径）。
// 手机只读边界（W-EXPP2 口径）不变：退役/恢复/改归组走电脑端经验库。
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { displaySrcName } from "../fmt";
import type { ProjectGroup } from "../protocol";
import type { SourceStatus } from "../store";
import { GroupModal, ORG_ST_ZH, OrgZone, orgStColor, useOrgData, useOrgDecide } from "./OrgZone";

// 页面骨架共享：SafeArea 顶 + 标题行（右上角 ＋ 钮，W-EXPOLISH 件七统一新增入口——
// 对齐桌面 list-header 同语言；现状无端侧建团/立项能力，点按给电脑端指引）+ 滚动内容
function OrgPageShell({ title, sub, onAdd, children }: { title: string; sub: string; onAdd: () => void; children: React.ReactNode }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.headT}>{title}</Text>
        <Text style={styles.headSub}>{sub}</Text>
        <Pressable
          style={styles.plusBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
          onPress={onAdd}
          hitSlop={4}
          accessibilityLabel={`新建（${title}）`}
        >
          <Text style={styles.plusT}>＋</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 28 }}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

// 建团/立项深交互指引（件三边界：发起面在电脑端；＋ 钮点按反馈）
const addOnDesk = () => Alert.alert("建团 / 立项", "请在电脑端操作——手机端发起入口后续版本开放");

// 深交互指引（快赢批边界声明）：派单/建团等发起面在电脑端，手机只读+决议
function DeskHint({ lines }: { lines: string[] }) {
  const styles = useThemeStyles(makeStyles);
  return (
    <View style={styles.hint}>
      {lines.map((l, i) => (
        <Text key={i} style={styles.hintT} accessibilityLabel={l}>{l}</Text>
      ))}
    </View>
  );
}

// ---------- 团队 tab：OrgZone 宿主（确认卡决议 + chips + 经验） ----------
export function TeamTab({ onOpenSession }: { onOpenSession: (sid: string) => void }) {
  const styles = useThemeStyles(makeStyles);
  // W-EXPOLISH 件五：经验域随入口迁设置 tab「经验库」分节，团队页只剩确认卡+chips
  const { confirms, groups } = useOrgData();
  const { decide, err, clearErr } = useOrgDecide();
  const [gmOpen, setGmOpen] = useState<{ srcId: string; gid: string; name: string } | null>(null);
  const empty = !confirms.length && !groups.length;
  const pendingN = confirms.length;
  return (
    <OrgPageShell
      title="团队"
      sub={pendingN > 0 ? `${pendingN} 张确认卡待决议` : `${groups.length} 个项目组`}
      onAdd={addOnDesk}
    >
      {empty ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyT}>还没有团队</Text>
          <Text style={styles.emptyS}>在电脑端建团 / 立项后，确认卡与项目组会出现在这里</Text>
        </View>
      ) : (
        <>
          <OrgZone
            confirms={confirms}
            groups={groups}
            onDecide={decide}
            onOpenGroup={(src, g) => setGmOpen({ srcId: src.id, gid: g.id, name: g.name })}
          />
          {err ? (
            // E2b：决议失败可见态（ACK 判定门产出）——行内错误可关闭，无自动重试
            <View style={styles.errRow}>
              <Text style={styles.errT} numberOfLines={2}>{err.msg}</Text>
              <Pressable hitSlop={8} accessibilityLabel="关闭决议错误提示" onPress={clearErr}>
                <Text style={styles.errClose}>×</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
      <DeskHint lines={["派单发起 / 建团 / 立项等操作请用电脑端", "点项目组可查看编制、任务板与派单回执"]} />
      {gmOpen ? (
        <GroupModal
          srcId={gmOpen.srcId}
          target={{ gid: gmOpen.gid, name: gmOpen.name }}
          onClose={() => setGmOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </OrgPageShell>
  );
}

// ---------- 项目 tab：项目组列表（跨源分节） ----------
export function ProjectsTab({ onOpenSession }: { onOpenSession: (sid: string) => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const { groups } = useOrgData();
  const [gmOpen, setGmOpen] = useState<{ srcId: string; gid: string; name: string } | null>(null);
  // 按源分节（组数 >1 源时出源名节头；单源不重复点名——与桌面 org 域同口径）
  const sections = useMemo(() => {
    const bySrc = new Map<string, { name: string; items: { src: SourceStatus; g: ProjectGroup }[] }>();
    for (const pair of groups) {
      const hit = bySrc.get(pair.src.id);
      if (hit) hit.items.push(pair);
      else bySrc.set(pair.src.id, { name: displaySrcName(pair.src.relayName || pair.src.name), items: [pair] });
    }
    return [...bySrc.values()];
  }, [groups]);
  return (
    <OrgPageShell title="项目" sub={groups.length > 0 ? `${groups.length} 个项目组` : "尚未立项"} onAdd={addOnDesk}>
      {sections.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyT}>还没有项目</Text>
          <Text style={styles.emptyS}>在电脑端立项后，项目组会出现在这里（已结项不占列表）</Text>
        </View>
      ) : (
        sections.map((sec, si) => (
          <View key={sec.name + si} style={si > 0 ? styles.secGap : null}>
            {sections.length > 1 ? <Text style={styles.secHead} numberOfLines={1}>{sec.name}</Text> : null}
            {sec.items.map(({ src, g }) => {
              const stColor = orgStColor(g.status, c);
              return (
                <Pressable
                  key={g.id}
                  style={styles.grpRow}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                  accessibilityLabel={`项目组 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${g.tier ?? ""}，${(g.headcount ?? []).length + 1} 人，点按查看详情`}
                  onPress={() => setGmOpen({ srcId: src.id, gid: g.id, name: g.name })}
                >
                  <View style={[styles.grpStDot, { backgroundColor: stColor }]} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.grpName} numberOfLines={1}>{g.name}</Text>
                    <Text style={styles.grpMeta} numberOfLines={1}>
                      {ORG_ST_ZH[g.status] ?? g.status} · {g.tier} · {(g.headcount ?? []).length + 1} 人
                    </Text>
                  </View>
                  <Text style={styles.grpGo}>›</Text>
                </Pressable>
              );
            })}
          </View>
        ))
      )}
      <DeskHint lines={["组内派单 / 任务板操作请用电脑端", "会话卡上的 ◈ 标签即项目组归属"]} />
      {gmOpen ? (
        <GroupModal
          srcId={gmOpen.srcId}
          target={{ gid: gmOpen.gid, name: gmOpen.name }}
          onClose={() => setGmOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </OrgPageShell>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    head: {
      flexDirection: "row", alignItems: "baseline", gap: 8,
      paddingHorizontal: 16, paddingTop: 9, paddingBottom: 6,
      borderBottomWidth: 1, borderBottomColor: c.line,
    },
    headT: { color: c.text, fontSize: 15, fontWeight: "700" },
    headSub: { color: c.brandA, fontSize: 11, fontWeight: "600", flex: 1 },
    // 件七：右上角 ＋（36px 触区 + hitSlop；head 行高内已居中）
    plusBtn: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", marginLeft: 6, overflow: "hidden" },
    plusT: { color: c.brandA, fontSize: 20, fontWeight: "600", lineHeight: 24, marginTop: -2 },
    list: { flex: 1, paddingHorizontal: 14, paddingTop: 8 },
    // 空态卡（原 DomainPlaceholder 语义弱化版：一句状态 + 一句指引）
    emptyCard: {
      alignItems: "center", paddingVertical: 34, paddingHorizontal: 22,
      borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
    },
    emptyT: { color: c.faint, fontSize: 14, fontWeight: "600", marginBottom: 6 },
    emptyS: { color: c.faint, fontSize: 11.5, lineHeight: 17, textAlign: "center" },
    // 决议失败可见态（原 ListScreen orgErrRow 迁入）
    errRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      borderRadius: 10, borderWidth: 1, borderColor: withA(c.error, 0.45),
      backgroundColor: c.panel, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
    },
    errT: { color: c.error, fontSize: 11.5, lineHeight: 16, flex: 1 },
    errClose: { color: c.faint, fontSize: 15, fontWeight: "600" },
    // 项目组列表行（卡片形制对齐确认卡/服务器行：panel 底 / line 边 / 12 圆角）
    grpRow: {
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
      marginBottom: 8, overflow: "hidden",
    },
    grpStDot: { width: 8, height: 8, borderRadius: 4 },
    grpName: { color: c.text, fontSize: 13, fontWeight: "600" },
    grpMeta: { color: c.faint, fontSize: 10.5, marginTop: 2 },
    grpGo: { color: c.faint, fontSize: 15 },
    secGap: { marginTop: 12 },
    secHead: { color: c.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 7 },
    // 深交互指引（快赢批边界）
    hint: {
      paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
      backgroundColor: c.tintSoft, gap: 3, marginTop: 4,
    },
    hintT: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
  });
