// 团队 / 项目两域 tab 页（W-EXPODOMAIN v2 重构，design-expo-mobile-v2 B2/B3）。
// 团队 tab = 确认卡队列置顶（ConfirmCard 决议钮内联+状态徽）+ 团队列表卡（状态胶囊+
// 图标化统计行，A1-8/9/10/11）→ tap 进 TeamDetailPage 全屏页（七节）；＋ = 建团分步
// 向导（TeamCreateWizard）。项目 tab = 项目卡三行制（名称/路径·会话数/状态胶囊）+
// 动作「新建会话于此目录」「查看项目会话」+ 未立项折叠组（默认折叠+AsyncStorage 持久，
// 桌面 W-PROJP1 P1-2 口径）。
// 数据面/决议 ACK 门 = OrgZone 模块 useOrgData/useOrgDecide（原口径）。手机只读边界
// 不变：派单发起/经验与铁律写面走电脑端；建团是本批新开的唯一深写面（org create 现役）。
import { useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { displaySrcName } from "../fmt";
import type { ProjectGroup, SessionState } from "../protocol";
import { useRelay, type SourceStatus } from "../store";
import { ConfirmCard, normDir, ORG_ST_ZH, orgStColor, tierZh, useOrgData, useOrgDecide } from "./OrgZone";
import { TeamDetailPage } from "./TeamDetailPage";
import TeamCreateWizard from "./TeamCreateWizard";

// 未立项折叠组展开态持久键（折叠态独立记账：默认折叠，用户展开过的桶记展开——与桌面
// expandedTeams「集合=展开过的」同语义，防 collapsed 语义互染）
const UNFILED_KEY = "ccdeck_proj_unfiled_open";

// 页面骨架共享：SafeArea 顶 + 标题行（右上角 ＋ 钮）+ 滚动内容
function OrgPageShell({ title, sub, onAdd, addLabel, children }: { title: string; sub: string; onAdd: () => void; addLabel: string; children: React.ReactNode }) {
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
          accessibilityLabel={addLabel}
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

// ---------- 团队 tab：确认卡队列置顶 + 团队列表卡 ----------
export function TeamTab({ onOpenSession }: { onOpenSession: (sid: string) => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const { confirms, groups } = useOrgData();
  const { decide, err, clearErr, flights, accepted } = useOrgDecide();
  const [detailOpen, setDetailOpen] = useState<{ srcId: string; gid: string; name: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const pendingN = confirms.length;
  const multiSrc = useMemo(() => new Set(confirms.map((x) => x.src.id)).size > 1, [confirms]);
  // 团队卡统计行（A1-8 图标化 + A1-11 待确认数）：席位=编制数+1（Leader 兼管）
  const pendingOf = (gid: string) => confirms.filter((x) => (x.cf.payload as { gid?: unknown } | undefined)?.gid === gid).length;
  return (
    <OrgPageShell
      title="团队"
      sub={pendingN > 0 ? `${pendingN} 张确认卡待决议` : groups.length > 0 ? `${groups.length} 个团队` : "还没有团队"}
      onAdd={() => setWizardOpen(true)}
      addLabel="新建团队（分步向导）"
    >
      {/* ① 确认卡队列置顶（跨源平铺；多源时逐卡标源名防歧义） */}
      {confirms.length ? (
        <View style={styles.cfQueue}>
          {confirms.map(({ src, cf }) => (
            <View key={cf.id}>
              {multiSrc ? <Text style={styles.cfSrc} numberOfLines={1}>{displaySrcName(src.relayName || src.name)}</Text> : null}
              <ConfirmCard srcId={src.id} cf={cf} decide={decide} flights={flights} accepted={accepted} />
            </View>
          ))}
          {err ? (
            <View style={styles.errRow}>
              <Text style={styles.errT} numberOfLines={2}>{err.msg}</Text>
              <Pressable hitSlop={8} accessibilityLabel="关闭决议错误提示" onPress={clearErr}>
                <Text style={styles.errX}>×</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
      {/* ② 团队列表卡 */}
      {groups.length ? (
        groups.map(({ src, g }) => {
          const stColor = orgStColor(g.status, c);
          const pend = pendingOf(g.id);
          return (
            <Pressable
              key={g.id}
              style={styles.teamCard}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
              accessibilityLabel={`团队 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${tierZh(g.tier)}，${(g.headcount ?? []).length + 1} 人，点按查看详情`}
              onPress={() => setDetailOpen({ srcId: src.id, gid: g.id, name: g.name })}
            >
              <View style={styles.teamR1}>
                <Text style={styles.teamName} numberOfLines={1}>{g.name}</Text>
                <View style={[styles.stPill, { borderColor: withA(stColor, 0.5), backgroundColor: withA(stColor, 0.1) }]}>
                  <View style={[styles.stPillDot, { backgroundColor: stColor }]} />
                  <Text style={[styles.stPillT, { color: stColor }]}>{ORG_ST_ZH[g.status] ?? g.status}</Text>
                </View>
              </View>
              <Text style={styles.teamMeta} numberOfLines={1}>
                👥 {(g.headcount ?? []).length + 1}{pend ? `   ⏳ 待确认 ${pend}` : ""} · {tierZh(g.tier)} · {displaySrcName(src.relayName || src.name)}
              </Text>
            </Pressable>
          );
        })
      ) : !confirms.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyT}>还没有团队</Text>
          <Text style={styles.emptyS}>点右上角 ＋ 新建团队，或在电脑端建团后到这里决议确认卡</Text>
        </View>
      ) : null}
      <View style={styles.hint}>
        <Text style={styles.hintT}>派单发起 / 任务板操作 / 经验与铁律管理请用电脑端</Text>
        <Text style={styles.hintT}>点团队卡看看板、编制、活动、经验与铁律</Text>
      </View>
      {detailOpen ? (
        <TeamDetailPage
          srcId={detailOpen.srcId}
          gid={detailOpen.gid}
          name={detailOpen.name}
          onClose={() => setDetailOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
      <TeamCreateWizard visible={wizardOpen} onClose={() => setWizardOpen(false)} />
    </OrgPageShell>
  );
}

// ---------- 项目 tab：项目卡三行制 + 未立项折叠组 ----------
export function ProjectsTab({ onOpenSession, onNewInDir, onViewSessionsInDir, onGoTeam }: {
  onOpenSession: (sid: string) => void;
  onNewInDir: (dir: string) => void;
  onViewSessionsInDir: (dir: string) => void;
  onGoTeam: () => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const { groups } = useOrgData();
  const [detailOpen, setDetailOpen] = useState<{ srcId: string; gid: string; name: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // 未立项折叠组展开态（默认折叠，AsyncStorage 持久）
  const [unfiledOpen, setUnfiledOpen] = useState(false);
  const [unfiledExpand, setUnfiledExpand] = useState<string | null>(null);
  useEffect(() => {
    void AsyncStorage.getItem(UNFILED_KEY).then((v) => setUnfiledOpen(v === "1"));
  }, []);
  const toggleUnfiled = () => {
    setUnfiledOpen((v) => {
      const next = !v;
      void AsyncStorage.setItem(UNFILED_KEY, next ? "1" : "0");
      return next;
    });
  };

  // 会话→项目归属（桌面 getSessionProject 口径 + project_gid 服务端真值优先）：
  // project_gid 命中在册组 → 归属；否则 cwd 前缀匹配锚点（含子目录）；都不中 → 未立项
  const projOf = useMemo(() => {
    const byGid = new Map<string, ProjectGroup>();
    const byAnchor: { anchor: string; g: ProjectGroup }[] = [];
    for (const { g } of groups) {
      byGid.set(g.id, g);
      byAnchor.push({ anchor: normDir(g.anchor_dir), g });
    }
    return (s: SessionState): ProjectGroup | null => {
      const gid = s.project_gid;
      if (gid && byGid.has(gid)) return byGid.get(gid)!;
      const cwd = normDir(s.cwd);
      if (!cwd) return null;
      const hit = byAnchor.find(({ anchor }) => anchor && (anchor === cwd || cwd.startsWith(anchor + "/")));
      return hit ? hit.g : null;
    };
  }, [groups]);

  // 全量分组数据面：snap.sessions 平铺跨源（useOrgData 不含会话——此处单独订阅）
  const snap = useRelay();
  const sessions = snap.sessions;
  const grouped = useMemo(() => {
    const byGroup = new Map<string, SessionState[]>();
    const unfiled = new Map<string, { dir: string; native: string; items: SessionState[] }>();
    for (const s of sessions) {
      const g = projOf(s);
      if (g) {
        const hit = byGroup.get(g.id);
        if (hit) hit.push(s);
        else byGroup.set(g.id, [s]);
        continue;
      }
      // 未立项分桶保留首个会话原始 cwd（nativeCwd——桌面口径：桶 key 是归一产物）
      const key = normDir(s.cwd) || "—";
      const bucket = unfiled.get(key);
      if (bucket) bucket.items.push(s);
      else unfiled.set(key, { dir: key, native: s.cwd || "", items: [s] });
    }
    return { byGroup, unfiled: [...unfiled.values()].sort((a, b) => Math.max(...b.items.map((x) => x.updated_at || 0)) - Math.max(...a.items.map((x) => x.updated_at || 0))) };
  }, [sessions, projOf]);
  const unfiledN = grouped.unfiled.reduce((n, b) => n + b.items.length, 0);

  const projCard = ({ src, g }: { src: SourceStatus; g: ProjectGroup }) => {
    const stColor = orgStColor(g.status, c);
    const n = grouped.byGroup.get(g.id)?.length ?? 0;
    return (
      <View key={g.id} style={styles.projCard}>
        <Pressable
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
          accessibilityLabel={`项目 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${n} 会话，点按查看团队详情`}
          onPress={() => setDetailOpen({ srcId: src.id, gid: g.id, name: g.name })}
        >
          <View style={styles.teamR1}>
            <Text style={styles.teamName} numberOfLines={1}>{g.name}</Text>
            <View style={[styles.stPill, { borderColor: withA(stColor, 0.5), backgroundColor: withA(stColor, 0.1) }]}>
              <View style={[styles.stPillDot, { backgroundColor: stColor }]} />
              <Text style={[styles.stPillT, { color: stColor }]}>{ORG_ST_ZH[g.status] ?? g.status}</Text>
            </View>
          </View>
          <Text style={styles.teamMeta} numberOfLines={1}>
            {shortDirOf(g.anchor_dir)} · {n} 会话 · 1 团队 · {displaySrcName(src.relayName || src.name)}
          </Text>
        </Pressable>
        <View style={styles.actRow}>
          <Pressable
            style={styles.actBtn}
            android_ripple={{ color: withA(c.brandA, 0.14), borderless: false, radius: 9 }}
            accessibilityLabel={`在 ${g.name} 目录新建会话`}
            onPress={() => onNewInDir(g.anchor_dir)}
          >
            <Text style={styles.actBtnT}>＋ 新建会话于此目录</Text>
          </Pressable>
          <Pressable
            style={[styles.actBtn, styles.actBtnSub]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
            accessibilityLabel={`查看 ${g.name} 的项目会话`}
            onPress={() => onViewSessionsInDir(g.anchor_dir)}
          >
            <Text style={[styles.actBtnT, styles.actBtnTSub]}>查看项目会话</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <OrgPageShell
      title="项目"
      sub={groups.length > 0 ? `${groups.length} 个项目${unfiledN ? ` · 未立项 ${unfiledN}` : ""}` : unfiledN ? `未立项 ${unfiledN}` : "尚未立项"}
      onAdd={() => setWizardOpen(true)}
      addLabel="新建项目（分步向导）"
    >
      {/* ① 项目卡（三行制：名称+状态胶囊 / 路径·会话数 / 动作行） */}
      {groups.length ? (
        groups.map((pair) => projCard(pair))
      ) : !unfiledN ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyT}>还没有项目</Text>
          <Text style={styles.emptyS}>点右上角 ＋ 立项（与建团同流程）；已结项不占列表</Text>
        </View>
      ) : null}
      {/* ② 未立项折叠组（置底，默认折叠+持久；组序=桶内最新会话倒序） */}
      {unfiledN ? (
        <View>
          <Pressable
            style={styles.unfiledHead}
            accessibilityLabel={`未立项 ${unfiledN} 个会话，点按${unfiledOpen ? "收起" : "展开"}`}
            onPress={toggleUnfiled}
          >
            <Text style={styles.unfiledChev}>{unfiledOpen ? "▾" : "▸"}</Text>
            <Text style={styles.unfiledT}>未立项 · {unfiledN}</Text>
          </Pressable>
          {unfiledOpen ? (
            grouped.unfiled.map((b) => {
              const open = unfiledExpand === b.dir;
              return (
                <View key={b.dir} style={styles.projCard}>
                  <Pressable
                    android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                    accessibilityLabel={`未立项目录 ${shortDirOf(b.dir)}，${b.items.length} 会话，点按${open ? "收起" : "展开"}说明`}
                    onPress={() => setUnfiledExpand(open ? null : b.dir)}
                  >
                    <View style={styles.teamR1}>
                      <Text style={styles.teamName} numberOfLines={1}>{shortDirOf(b.native || b.dir)}</Text>
                      <Text style={styles.unfiledTag}>未立项</Text>
                    </View>
                    <Text style={styles.teamMeta} numberOfLines={1}>
                      {b.dir} · {b.items.length} 会话 · 最近 {displayLastAt(b.items)}
                    </Text>
                  </Pressable>
                  {open ? (
                    <View style={styles.unfiledNote}>
                      <Text style={styles.unfiledNoteT}>该目录未立项。立项在团队域发起（组织命令），项目页不产生第二写面。</Text>
                      <View style={styles.actRow}>
                        <Pressable
                          style={[styles.actBtn, styles.actBtnSub]}
                          android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                          accessibilityLabel="去团队域立项"
                          onPress={onGoTeam}
                        >
                          <Text style={[styles.actBtnT, styles.actBtnTSub]}>去团队域</Text>
                        </Pressable>
                        <Pressable
                          style={styles.actBtn}
                          android_ripple={{ color: withA(c.brandA, 0.14), borderless: false, radius: 9 }}
                          accessibilityLabel={`在 ${shortDirOf(b.dir)} 目录新建会话`}
                          onPress={() => onNewInDir(b.native || b.dir)}
                        >
                          <Text style={styles.actBtnT}>＋ 新建会话</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.actBtn, styles.actBtnSub]}
                          android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                          accessibilityLabel={`查看 ${shortDirOf(b.dir)} 的会话`}
                          onPress={() => onViewSessionsInDir(b.native || b.dir)}
                        >
                          <Text style={[styles.actBtnT, styles.actBtnTSub]}>查看会话</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          ) : null}
        </View>
      ) : null}
      <View style={styles.hint}>
        <Text style={styles.hintT}>会话卡上的 ◈ 标签即项目组归属；未立项目录可快捷新建会话</Text>
      </View>
      {detailOpen ? (
        <TeamDetailPage
          srcId={detailOpen.srcId}
          gid={detailOpen.gid}
          name={detailOpen.name}
          onClose={() => setDetailOpen(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
      <TeamCreateWizard visible={wizardOpen} onClose={() => setWizardOpen(false)} />
    </OrgPageShell>
  );
}

function shortDirOf(v: string): string {
  const segs = normDir(v).split("/").filter(Boolean);
  return segs.length ? segs.slice(-2).join("/") : "—";
}
function displayLastAt(items: SessionState[]): string {
  const latest = Math.max(...items.map((x) => x.updated_at || 0));
  const d = new Date(latest);
  if (!Number.isFinite(d.getTime()) || latest <= 0) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
    plusBtn: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", marginLeft: 6, overflow: "hidden" },
    plusT: { color: c.brandA, fontSize: 20, fontWeight: "600", lineHeight: 24, marginTop: -2 },
    list: { flex: 1, paddingHorizontal: 14, paddingTop: 8 },
    // 确认卡队列
    cfQueue: { gap: 8, marginBottom: 12 },
    cfSrc: { color: c.dim, fontSize: 10.5, fontWeight: "700", marginBottom: -3 },
    errRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      borderRadius: 10, borderWidth: 1, borderColor: withA(c.error, 0.45),
      backgroundColor: c.panel, paddingHorizontal: 10, paddingVertical: 8,
    },
    errT: { color: c.error, fontSize: 11.5, lineHeight: 16, flex: 1 },
    errX: { color: c.faint, fontSize: 15, fontWeight: "600" },
    // 团队/项目卡（同形制）：r1 名称+状态胶囊 / r2 元信息行
    teamCard: {
      borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8, overflow: "hidden",
    },
    projCard: {
      borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8, gap: 8, overflow: "hidden",
    },
    teamR1: { flexDirection: "row", alignItems: "center", gap: 8 },
    teamName: { color: c.text, fontSize: 13.5, fontWeight: "700", flex: 1, minWidth: 0 },
    stPill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 1.5, flexShrink: 0 },
    stPillDot: { width: 6, height: 6, borderRadius: 3 },
    stPillT: { fontSize: 10, fontWeight: "700" },
    teamMeta: { color: c.faint, fontSize: 10.5, marginTop: 3 },
    // 项目卡动作行（件三：新建会话于此目录 / 查看项目会话）
    actRow: { flexDirection: "row", gap: 8, marginTop: 2 },
    actBtn: {
      flex: 1, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center",
      backgroundColor: withA(c.brandA, 0.12), borderWidth: 1, borderColor: withA(c.brandA, 0.35), overflow: "hidden",
    },
    actBtnSub: { backgroundColor: c.tintSoft, borderColor: c.line },
    actBtnT: { color: c.brandA, fontSize: 11.5, fontWeight: "600" },
    actBtnTSub: { color: c.dim },
    // 未立项折叠组
    unfiledHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 4, marginTop: 4 },
    unfiledChev: { color: c.faint, fontSize: 12 },
    unfiledT: { color: c.faint, fontSize: 11.5, fontWeight: "700" },
    unfiledTag: { color: c.faint, fontSize: 10, paddingHorizontal: 8, paddingVertical: 1.5, borderRadius: 999, borderWidth: 1, borderColor: c.line, flexShrink: 0 },
    unfiledNote: { gap: 6 },
    unfiledNoteT: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
    // 空态卡
    emptyCard: {
      alignItems: "center", paddingVertical: 34, paddingHorizontal: 22,
      borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
    },
    emptyT: { color: c.faint, fontSize: 14, fontWeight: "600", marginBottom: 6 },
    emptyS: { color: c.faint, fontSize: 11.5, lineHeight: 17, textAlign: "center" },
    hint: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: c.tintSoft, gap: 3, marginTop: 4 },
    hintT: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
  });
