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
import { statusColor, withA, type ThemeColors } from "../theme";
import { displaySrcName, fmtLastActive } from "../fmt";
import type { ProjectGroup, SessionState } from "../protocol";
import { useRelay, type SourceStatus } from "../store";
import { PlusMark } from "../brand";
import { FadeIn, useLayoutPulse } from "../motion";
import { ConfirmCard, normDir, ORG_ST_ZH, orgStColor, tierZh, useOrgData, useOrgDecide } from "./OrgZone";
import { EngineBadge, TeamDetailPage } from "./TeamDetailPage";
import TeamCreateWizard from "./TeamCreateWizard";
import { PageHead, useBellBadge } from "./page-head";
import { SourceSwitch } from "./source-switch";

// 未立项折叠组展开态持久键（折叠态独立记账：默认折叠，用户展开过的桶记展开——与桌面
// expandedTeams「集合=展开过的」同语义，防 collapsed 语义互染）
const UNFILED_KEY = "ccdeck_proj_unfiled_open";

// 页面骨架共享：SafeArea 顶 + 标题行（右上角 ＋ 钮）+ 滚动内容
function OrgPageShell({ title, sub, onAdd, addLabel, onGoSessions, children }: { title: string; sub: string; onAdd: () => void; addLabel: string; onGoSessions?: () => void; children: React.ReactNode }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const bellN = useBellBadge();
  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      {/* W-MOBILE3 #121 三域 Header 统一：团队/项目页头换 PageHead（v3 .appbar 两行式
          规格——标题 16/600 上、副题 11/dim 下；容器 padding 14/10/10+底边框）。原
          baseline 单行式（headT+headSub 同行）退役；＋ 钮视觉保留 W-POLISH-MOBILE A2
          拍板的品牌色底 36 圆角（v3 裸图标 dim 钮不采用——expo 侧两轮拍板终态） */}
      {/* W-HEAD6 B：源切换统一组件（icon+计数+浮窗）——W-HEAD4 的只读胶囊退役；
          ④ 铃铛保留（回会话页开通知）。＋钮去边框裸形制（D 件，对齐会话页） */}
      <PageHead
        title={title}
        sub={sub}
        sourcePill={<SourceSwitch onOpenSettings={onGoSessions} />}
        bell={onGoSessions ? { badge: bellN, onPress: onGoSessions } : undefined}
        right={
          <>
            <Pressable
              style={styles.plusBtnBare}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
              onPress={onAdd}
              hitSlop={4}
              accessibilityLabel={addLabel}
            >
              <PlusMark size={20} color={c.brandA} />
            </Pressable>
          </>
        }
      />
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 28 }}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------- 团队 tab：确认卡队列置顶 + 团队列表卡 ----------
// W-MV8A（v8.5 v3 手机壳 ph-pteam 对齐）：团队卡改 hcard team 语言——首字头像 +
// 名 + 右缘健康灯（orgStColor），计数行「编制 N · 进行中 N · 待确认 N · 最近活跃」，
// 可展开成员迷你行（任务书点名；headcount × sessions join：名+状态灯+引擎徽）。
// 品牌渐变边框形态对齐 v3 .hcard.team（brand line + soft 渐变底）；归档组不占常驻位
// （useOrgData 已滤）。
export function TeamTab({ onOpenSession, onGoSessions }: { onOpenSession: (sid: string) => void; onGoSessions?: () => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const { confirms, groups } = useOrgData();
  const snap = useRelay();
  const { decide, err, clearErr, flights, accepted } = useOrgDecide();
  const [detailOpen, setDetailOpen] = useState<{ srcId: string; gid: string; name: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // 成员迷你行展开集（本地内存级——进详情/切 tab 即回默认收起，轻浏览态不持久）
  const [openGids, setOpenGids] = useState<Set<string>>(new Set());
  const pendingN = confirms.length;
  const multiSrc = useMemo(() => new Set(confirms.map((x) => x.src.id)).size > 1, [confirms]);
  // 团队卡统计行（A1-8 图标化 + A1-11 待确认数）：席位=编制数+1（Leader 兼管）
  const pendingOf = (gid: string) => confirms.filter((x) => (x.cf.payload as { gid?: unknown } | undefined)?.gid === gid).length;
  // W-MOTION：团队/项目卡增删与确认卡进出 → 列表布局补间（key 指纹：同集合内容更新不触发）
  const teamKeySeq = useMemo(() => groups.map((g) => g.g.id).join("|"), [groups]);
  const confirmKeySeq = useMemo(() => confirms.map((x) => x.cf.id).join("|"), [confirms]);
  useLayoutPulse(teamKeySeq);
  useLayoutPulse(confirmKeySeq);
  return (
    <OrgPageShell
      title="团队"
      sub={pendingN > 0 ? `${pendingN} 张确认卡待决议` : groups.length > 0 ? `${groups.filter((x) => x.g.status === "active").length} 个活跃` : "还没有团队"} /* W-HEAD4 ② 活跃口径 */
      onAdd={() => setWizardOpen(true)}
      addLabel="新建团队（分步向导）"
      onGoSessions={onGoSessions}
    >
      {/* ① 确认卡队列置顶（A9 节头 + v3 pcfq 语言：红计数徽——「手机置顶」是 v3 修订②
          拍板（确认卡队列=现网第一 citizen）；跨源平铺；多源时逐卡标源名防歧义） */}
      {confirms.length ? (
        <FadeIn dy={6}>
        <View style={styles.cfQueue}>
          <View style={styles.cfHRow}>
            <Text style={styles.cfH}>待你确认</Text>
            <View style={styles.cfCount}>
              <Text style={styles.cfCountT}>{confirms.length > 99 ? "99+" : confirms.length}</Text>
            </View>
          </View>
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
        </FadeIn>
      ) : null}
      {/* ② 团队列表卡（v3 hcard team 语言） */}
      {groups.length ? (
        groups.map(({ src, g }) => {
          const stColor = orgStColor(g.status, c);
          const pend = pendingOf(g.id);
          const members = (Array.isArray(g.headcount) ? g.headcount : []).filter((m) => m && typeof m.session_id === "string");
          // 进行中计数：live 板缓存（src.boards[gid]，BOARD_UPDATED delta 维护）；
          // 无板数据不显（宁缺毋滥——UPOLISH3 水位同哲学，不伪造 0）
          const ents = src.boards?.[g.id]?.entries;
          const running = ents ? ents.filter((e) => e.status === "claimed").length : null;
          // 最近活跃：成员会话 max(updated_at)（无会话数据回落「—」）
          const lastTs = members.reduce(
            (mx, m) => Math.max(mx, snap.sessions.find((s) => s.session_id === m.session_id)?.updated_at ?? 0),
            0,
          );
          const open = openGids.has(g.id);
          return (
            <View key={g.id} style={styles.teamCard}>
              <Pressable
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                accessibilityLabel={`团队 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${tierZh(g.tier)}，${members.length + 1} 人，点按查看详情`}
                onPress={() => setDetailOpen({ srcId: src.id, gid: g.id, name: g.name })}
              >
                <View style={styles.teamR1}>
                  <View style={styles.teamAva}>
                    <Text style={styles.teamAvaT}>{(g.name || "T").trim().slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.teamNameRow}>
                      <Text style={styles.teamName} numberOfLines={1}>{g.name}</Text>
                      {pend ? (
                        <View style={styles.teamPendBadge}>
                          <Text style={styles.teamPendBadgeT}>{pend}</Text>
                        </View>
                      ) : null}
                      {/* 健康灯（v3 .dot）：状态色 7px 右缘锚 */}
                      <View style={[styles.teamDot, { backgroundColor: stColor }]} />
                    </View>
                    <Text style={styles.teamMeta} numberOfLines={1}>
                      <Text style={styles.teamMetaStrong}>{members.length + 1} 人</Text>
                      {running != null ? <Text>{" · 进行中 "}{running}</Text> : ""}
                      {pend ? <Text style={styles.teamMetaPend}> · 待确认 {pend}</Text> : ""}
                      {lastTs > 0 ? <Text>{" · "}{fmtLastActive(lastTs)}活跃</Text> : ""}
                    </Text>
                  </View>
                </View>
              </Pressable>
              {/* 成员迷你行（任务书点名）：展开=编制成员 名+状态灯+引擎徽，一行一人；
                  点行进成员会话（详情页 memberCard 同链） */}
              <Pressable
                style={styles.teamExpRow}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                accessibilityLabel={`团队 ${g.name} 成员 ${members.length} 人，点按${open ? "收起" : "展开"}成员迷你行`}
                onPress={() => setOpenGids((prev) => {
                  const n = new Set(prev);
                  if (n.has(g.id)) n.delete(g.id);
                  else n.add(g.id);
                  return n;
                })}
              >
                <Text style={styles.teamExpT}>成员 {members.length}</Text>
                <Text style={styles.teamExpChev}>{open ? "▾" : "▸"}</Text>
              </Pressable>
              {open ? (
                members.length ? (
                  <View style={styles.teamMiniList}>
                    {members.map((m) => {
                      const ses = snap.sessions.find((s) => s.session_id === m.session_id);
                      const name = m.nick || ses?.title || m.session_id.slice(0, 8);
                      const dot = ses ? statusColor(ses.status, c) : c.done; // W-STATLIGHT2：无会话回落灯灰→绿（#162 用户定版补全）
                      return (
                        <Pressable
                          key={m.session_id}
                          style={styles.teamMiniRow}
                          android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
                          accessibilityLabel={`成员 ${name}，${m.role || "角色未标注"}，点按打开成员会话`}
                          onPress={() => onOpenSession(m.session_id)}
                        >
                          <View style={[styles.teamMiniDot, { backgroundColor: dot }]} />
                          <Text style={styles.teamMiniName} numberOfLines={1}>{name}</Text>
                          <Text style={styles.teamMiniRole} numberOfLines={1}>{m.role || ""}</Text>
                          <EngineBadge engine={m.engine || ses?.engine} />
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={styles.teamMiniEmpty}>暂无编制数据（建团成员或电脑端派单入编后出现）</Text>
                )
              ) : null}
            </View>
          );
        })
      ) : !confirms.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>◎</Text>
          <Text style={styles.emptyT}>还没有团队</Text>
          <Text style={styles.emptyS}>点右上角 ＋ 新建团队，或在电脑端建团后到这里决议确认卡</Text>
        </View>
      ) : null}
      <View style={styles.hint}>
        <Text style={styles.hintT}>派单发起、任务板操作、经验与铁律管理请用电脑端</Text>
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
export function ProjectsTab({ onOpenSession, onNewInDir, onViewSessionsInDir, onGoTeam, onGoSessions }: {
  onOpenSession: (sid: string) => void;
  onNewInDir: (dir: string) => void;
  onViewSessionsInDir: (dir: string) => void;
  onGoTeam: () => void;
  onGoSessions?: () => void;
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
            <View style={styles.projectIcon}><Text style={styles.projectIconT}>P</Text></View>
            <Text style={styles.teamName} numberOfLines={1}>{g.name}</Text>
            <View style={[styles.stPill, { borderColor: withA(stColor, 0.5), backgroundColor: withA(stColor, 0.1) }]}>
              <View style={[styles.stPillDot, { backgroundColor: stColor }]} />
              <Text style={[styles.stPillT, { color: stColor }]}>{ORG_ST_ZH[g.status] ?? g.status}</Text>
            </View>
          </View>
          <Text style={[styles.teamMeta, styles.projMeta]} numberOfLines={1}>
            <Text style={styles.teamMetaStrong}>{n} 会话</Text>
            {" · "}{shortDirOf(g.anchor_dir)} · {displaySrcName(src.relayName || src.name)}
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
      onGoSessions={onGoSessions}
    >
      {/* ① 项目卡（三行制：名称+状态胶囊 / 路径·会话数 / 动作行） */}
      {groups.length ? (
        groups.map((pair) => projCard(pair))
      ) : !unfiledN ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>◈</Text>
          <Text style={styles.emptyT}>还没有项目</Text>
          <Text style={styles.emptyS}>点右上角 ＋ 立项（与建团同流程）；已结项不占列表</Text>
        </View>
      ) : null}
      {/* ② 未立项折叠组（置底，默认折叠+持久；组序=桶内最新会话倒序） */}
      {unfiledN ? (
        <View>
          <Pressable
            style={styles.unfiledHead}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
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
                      <View style={styles.projectIcon}><Text style={styles.projectIconT}>P</Text></View>
                      <Text style={styles.teamName} numberOfLines={1}>{shortDirOf(b.native || b.dir)}</Text>
                      <Text style={styles.unfiledTag}>未立项</Text>
                    </View>
                    <Text style={[styles.teamMeta, styles.projMeta]} numberOfLines={1}>
                      <Text style={styles.teamMetaStrong}>{b.items.length} 会话</Text>
                      {" · "}{b.dir} · 最近 {displayLastAt(b.items)}
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
    // W-MOBILE3 #121：head/headT/headSub 退役（页头上收 PageHead 统一组件——
    // v3 .appbar 两行式规格；样式键删除防残留回退）
    plusBtn: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", marginLeft: 6, backgroundColor: withA(c.brandA, 0.12), borderWidth: 1, borderColor: withA(c.brandA, 0.38), overflow: "hidden" },
    plusBtnBare: { width: 36, height: 40, alignItems: "center", justifyContent: "center", marginLeft: 2, overflow: "hidden" }, /* W-HEAD6 D：＋裸形制（去边框去底，对齐会话页） */
    plusT: { color: c.brandA, fontSize: 20, fontWeight: "600", lineHeight: 24, marginTop: -2 },
    list: { flex: 1, paddingHorizontal: 14, paddingTop: 12 },
    // 确认卡队列（A9 节头 + v3 pcfq 语言：标题行 + 红计数徽 cfcount）
    // dda6490 并集合并残留收口：上方 A2 块（dim 副语/36＋钮）为终态，旧块（brandA/44×44 件七）重复键删除——JS 对象字面量后者静默覆盖前者，残留即回退
    cfQueue: { gap: 9, marginBottom: 14 },
    cfHRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    cfH: { color: c.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
    // v3 .cfcount：红底白字计数徽（团队域行动队列的视觉锚——区别于底栏琥珀 badge）
    cfCount: {
      minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 4,
      backgroundColor: c.error, alignItems: "center", justifyContent: "center",
    },
    cfCountT: { color: "#FFFFFF", fontSize: 9.5, fontWeight: "800" },
    cfSrc: { color: c.dim, fontSize: 10.5, fontWeight: "700", marginBottom: -3 },
    errRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      borderRadius: 10, borderWidth: 1, borderColor: withA(c.error, 0.45),
      backgroundColor: c.panel, paddingHorizontal: 10, paddingVertical: 8,
    },
    errT: { color: c.error, fontSize: 11.5, lineHeight: 16, flex: 1 },
    errX: { color: c.faint, fontSize: 15, fontWeight: "600" },
    // 团队卡（W-MV8A v3 .hcard.team）：brand 线框 + soft 渐变底观感（RN 无 CSS 渐变，
    // 用 tintSoft 实底近似 v3 linear-gradient(135deg, soft, panel 55%) 的前段）；
    // 首字头像 + 健康灯 + 计数行 + 可展开成员迷你行
    teamCard: {
      borderRadius: 14, borderWidth: 1, backgroundColor: c.panel, borderColor: withA(c.brandA, 0.4),
      paddingHorizontal: 12, paddingVertical: 11, marginBottom: 9, gap: 4, overflow: "hidden",
    },
    teamAva: {
      width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center",
      backgroundColor: withA(c.brandA, 0.14), borderWidth: 1, borderColor: withA(c.brandA, 0.32),
    },
    teamAvaT: { color: c.brandA, fontSize: 16, fontWeight: "800" },
    teamNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    // v3 .pbadge：待确认琥珀徽（卡位级——与队列红徽分工：红=队列总量，琥珀=本组）
    teamPendBadge: {
      minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 4, flexShrink: 0,
      backgroundColor: c.working, alignItems: "center", justifyContent: "center",
    },
    teamPendBadgeT: { color: "#2B2100", fontSize: 9.5, fontWeight: "800" },
    teamDot: { width: 7, height: 7, borderRadius: 4, marginLeft: "auto", flexShrink: 0 },
    projCard: {
      borderRadius: 14, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
      paddingHorizontal: 12, paddingVertical: 12, marginBottom: 9, gap: 8, overflow: "hidden",
    },
    teamR1: { flexDirection: "row", alignItems: "center", gap: 10 },
    projectIcon: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: withA(c.brandB, 0.14), borderWidth: 1, borderColor: withA(c.brandB, 0.32) },
    projectIconT: { color: c.brandB, fontSize: 13, fontWeight: "800" },
    teamName: { color: c.textStrong, fontSize: 13.5, fontWeight: "700", flexShrink: 1 },
    stPill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
    stPillDot: { width: 6, height: 6, borderRadius: 3 },
    stPillT: { fontSize: 10, fontWeight: "700" },
    teamMeta: { color: c.dim, fontSize: 10.5, marginTop: 2, fontVariant: ["tabular-nums"] },
    // 项目卡平铺结构的 meta 缩进（projectIcon 30 + gap 8 对齐——teamMeta 已被团队卡
    // 嵌套结构占用无缩进，项目卡两处叠加本键）
    projMeta: { paddingLeft: 38 },
    teamMetaStrong: { color: c.text, fontWeight: "700", fontVariant: ["tabular-nums"] },
    teamMetaPend: { color: c.brandA, fontWeight: "700", fontVariant: ["tabular-nums"] },
    // 成员迷你行（W-MV8A 任务书点名）：展开钮行 + 迷你行列表
    teamExpRow: {
      flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 48,
      paddingVertical: 5, borderRadius: 8, marginTop: 1,
    },
    teamExpT: { color: c.faint, fontSize: 10.5, fontWeight: "600", flex: 1 },
    teamExpChev: { color: c.faint, fontSize: 11 },
    teamMiniList: { gap: 2, paddingLeft: 48 },
    teamMiniRow: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 4, borderRadius: 8 },
    teamMiniDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    teamMiniName: { color: c.text, fontSize: 11.5, fontWeight: "600", flexShrink: 1 },
    teamMiniRole: { color: c.faint, fontSize: 10, flexShrink: 1 },
    teamMiniEmpty: { color: c.faint, fontSize: 10.5, paddingLeft: 48, paddingVertical: 4 },
    // 项目卡动作行（A4：触达 36+主钮字重 700）
    actRow: { flexDirection: "row", gap: 8, marginTop: 6 },
    actBtn: {
      flex: 1, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
      backgroundColor: withA(c.brandA, 0.12), borderWidth: 1, borderColor: withA(c.brandA, 0.35), overflow: "hidden",
    },
    actBtnSub: { backgroundColor: c.tintSoft, borderColor: c.line },
    actBtnT: { color: c.brandA, fontSize: 11.5, fontWeight: "700" },
    actBtnTSub: { color: c.dim, fontWeight: "600" },
    // 未立项折叠组（A5：触达加高+chev 提号）
    unfiledHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 11, paddingHorizontal: 4, marginTop: 4, borderRadius: 9, overflow: "hidden" },
    unfiledChev: { color: c.faint, fontSize: 13 },
    unfiledT: { color: c.dim, fontSize: 11.5, fontWeight: "700" },
    unfiledTag: { color: c.faint, fontSize: 10, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: c.line, flexShrink: 0 },
    unfiledNote: { gap: 6 },
    unfiledNoteT: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
    // 空态卡（A3：图标锚+标题提亮——「不是白板」）
    emptyCard: {
      alignItems: "center", paddingVertical: 42, paddingHorizontal: 22,
      borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, gap: 8,
    },
    emptyIcon: { color: withA(c.faint, 0.5), fontSize: 30, fontWeight: "600", lineHeight: 34 },
    emptyT: { color: c.dim, fontSize: 14, fontWeight: "700" },
    emptyS: { color: c.faint, fontSize: 11.5, lineHeight: 17, textAlign: "center" },
    // A6：hint callout 化（左竖线语言，与卡片区隔）
    hint: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: c.tintSoft, gap: 3, marginTop: 4, borderLeftWidth: 2, borderLeftColor: withA(c.brandA, 0.55) },
    hintT: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
  });
