// W-WAVE3IMPL 件1（#189）：项目详情二级页——只读聚合四分节（V3 屏 8 形态）。
// 设计基准 docs/design/wave3-scope-audit.md §②：
//   💬 会话（vrow 轻行+jump 开会话详情）/ 👥 团队摘要卡（jump 去团队详情——不复制
//   看板/活动/经验/铁律，联动不合并防双账）/ 📦 输出物（聚合 artifacts，jump 开会话
//   输出物 tab 语义=打开来源会话）/ ✅ 验收单（三态行——手机无独立验收页（设计豁免：
//   云端链接填写），此处只读呈现）。
// 返回：PageHead onBack + 局部 BackHandler（挂载订阅/卸载移除，仅详情开时消费——
// #132 教训：返回手势必须关详情而非拽走 tab；与 #282 App 层单订阅的取舍见
// useEffect 注释）。
// 数据面全现成零 relay 改动：sessions（projOf 同口径归属）+ groups + snap.acceptances
// （SNAPSHOT 下发的 AcceptanceSummary[]，protocol.ts:653）+ SessionState.artifacts。
import { useEffect, useMemo } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { fmtLastActive } from "../fmt";
import { normDir, orgStColor, ORG_ST_ZH } from "./OrgZone";
import { EngineBadge } from "./TeamDetailPage";
import { PageHead } from "./page-head";
import { useRelay } from "../store";
import type { ProjectGroup, SessionState } from "../protocol";
import type { Snapshot } from "../store";

interface AcceptanceSummaryLike {
  id: string;
  title: string;
  created_at: number;
  judged: number;
  total: number;
  submitted: boolean;
  gid?: string; // #198 W1：归因键（旧 relay/NULL 档无字段）
}

function makeStyles(c: ThemeColors): { [k: string]: TextStyle | ViewStyle | number | any } {
  return {
    page: { flex: 1, backgroundColor: c.bg },
    body: { flex: 1 },
    bodyContent: { padding: 14, paddingBottom: 40 },
    secGap: { marginBottom: 18 },
    secH: { fontSize: 13, fontWeight: "600", color: c.dim, marginBottom: 8, marginTop: 4 },
    vrow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: c.panel, marginBottom: 6 },
    vrowT: { flex: 1, minWidth: 0 },
    vrowTitle: { fontSize: 14, color: c.text, fontWeight: "600" },
    vrowSub: { fontSize: 11, color: c.dim, marginTop: 2 },
    vrowK: { fontSize: 11, color: c.dim, backgroundColor: withA(c.faint, 0.15), borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    vrowKRun: { color: c.working },
    vrowKWait: { color: c.working },
    vrowKErr: { color: c.error },
    teamCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, backgroundColor: c.panel },
    teamCardInfo: { flex: 1, minWidth: 0 },
    teamCardName: { fontSize: 14, color: c.text, fontWeight: "600" },
    teamCardSub: { fontSize: 11, color: c.dim, marginTop: 2 },
    jump: { fontSize: 12, color: c.brandA, fontWeight: "500" },
    artRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 10, backgroundColor: c.panel, marginBottom: 5 },
    artName: { flex: 1, minWidth: 0, fontSize: 13, color: c.text },
    artTime: { fontSize: 10, color: c.faint },
    accRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: c.panel, marginBottom: 6 },
    accT: { flex: 1, minWidth: 0 },
    accTitle: { fontSize: 13, color: c.text, fontWeight: "500" },
    accSub: { fontSize: 10.5, color: c.dim, marginTop: 2 },
    accK: { fontSize: 11, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" as const },
    empty: { fontSize: 12, color: c.faint, paddingVertical: 10 },
    footNote: { fontSize: 10.5, color: c.faint, textAlign: "center", paddingVertical: 12 },
  };
}

const VROW_K: Record<string, [string, string]> = {
  WORKING: ["运行中", "vrowKRun"],
  WAITING: ["待处理", "vrowKWait"],
  ERROR: ["错误", "vrowKErr"],
};

export function ProjectDetailPage({
  srcId, gid, name, anchor, onClose, onOpenSession, onGoTeam,
}: {
  srcId: string;
  gid: string;
  name: string;
  anchor: string;
  onClose: () => void;
  onOpenSession: (sid: string) => void;
  /** jump 链：去团队详情看板/编制（联动不合并——本页只放摘要卡） */
  onGoTeam: () => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap: Snapshot = useRelay();

  // 硬件返回（#132 教训）：详情开 → 关详情。局部订阅（挂载加/卸载移除），仅在挂载
  // 期间消费 return true——#282 单订阅原则针对「无条件吞键」，此处生命周期清晰、
  // 条件唯一（开着就关），无静默吞键组合；App 层 tab 分发链零改动。
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  // 归属会话：project_gid 真值优先 + cwd 锚点前缀（OrgTabs projOf 同口径）
  // #198 W2：project_gid 命中**在册组**（任一源组表）时以 gid 为准——他组会话不因
  // cwd 前缀残留（组迁移/锚重叠）误入本项目；gid 缺省或所指组不在册（历史脏值）
  // 才回落 cwd 前缀链（对齐 OrgTabs byGid.has 语义，两页判定不再分叉）
  const sessions = useMemo(() => {
    const a = normDir(anchor);
    const roster = new Set(snap.sources.flatMap((x) => x.projects ?? []).map((g) => g.id));
    return snap.sessions.filter((s) => {
      if (s.project_gid && roster.has(s.project_gid)) return s.project_gid === gid;
      const cwd = normDir(s.cwd || "");
      return !!a && !!cwd && (cwd === a || cwd.startsWith(a + "/"));
    }).sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));
  }, [snap.sessions, snap.sources, gid, anchor]);

  // 组与验收单跨源聚合（store Snapshot 无顶层字段——sources[] 各带 projects/acceptances）
  const group: ProjectGroup | undefined = useMemo(
    () => snap.sources.flatMap((x) => x.projects ?? []).find((g) => g.id === gid),
    [snap.sources, gid],
  );
  const headcount = Array.isArray(group?.headcount) ? group!.headcount! : [];
  const working = sessions.filter((s) => s.status === "WORKING" || s.status === "WAITING").length;

  // 输出物聚合（按 last_at 降序，去重同路径）
  const artifacts = useMemo(() => {
    const seen = new Map<string, { name: string; lastAt: number; sid: string }>();
    for (const s of sessions) {
      for (const a of Array.isArray(s.artifacts) ? s.artifacts : []) {
        if (!a || typeof a.path !== "string" || a.exists === false) continue;
        const prev = seen.get(a.path);
        const lastAt = Number(a.last_at) || Number(a.first_at) || 0;
        if (!prev || lastAt > prev.lastAt) {
          seen.set(a.path, { name: normDir(a.path).split("/").filter(Boolean).pop() || a.path, lastAt, sid: s.session_id }); /* #198 W4：basename 前先 normDir（反斜杠/重复斜杠/尾斜杠归一——Windows 风格 path 不再整段当名） */
        }
      }
    }
    return [...seen.values()].sort((x, y) => y.lastAt - x.lastAt);
  }, [sessions]);

  // 验收单（#198 W1：按 gid 精确筛本项目——修「全局最近 5 张冒充本项目」误导。
  // 归因键=源头 Acceptance.gid（M12-7 出单方写入，NULL 档不猜不补）随 SNAPSHOT 汇总
  // 下发；无归因旧单不进项目分节（回落全局待填 badge 面，不在本项目冒充）。旧 relay
  // 无 gid 字段=全量筛空，分节显示空态（优于误导）
  const acceptances = useMemo(
    () => snap.sources.flatMap((x) => (Array.isArray(x.acceptances) ? (x.acceptances as AcceptanceSummaryLike[]) : [])).filter((a) => a.gid === gid).slice(0, 5),
    [snap.sources, gid],
  );

  const stColor = group ? orgStColor(group.status, c) : c.faint;

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <PageHead title={name} sub={`${sessions.length} 会话${headcount.length ? ` · ${headcount.length} 编制` : ""}${working ? ` · ${working} 在岗` : ""}`} onBack={onClose} backLabel={`返回项目列表`} />
      <ScrollView style={styles.body} showsVerticalScrollIndicator={false} contentContainerStyle={styles.bodyContent}>
        {/* ① 会话 */}
        <Text style={styles.secH}>💬 会话 · {sessions.length}</Text>
        {sessions.length ? sessions.slice(0, 8).map((s) => {
          const k = VROW_K[s.status] ?? ["完成", ""];
          const ctx = Number(s.context_limit) > 0
            ? ` · 上下文 ${Math.max(1, Math.min(999, Math.round((Number(s.context_usage) / Number(s.context_limit)) * 100)))}%` : "";
          return (
            <Pressable key={s.session_id} style={styles.vrow} android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
              accessibilityLabel={`会话 ${s.title || s.session_id}，点按打开详情`}
              onPress={() => onOpenSession(s.session_id)}>
              <View style={styles.vrowT}>
                <Text style={styles.vrowTitle} numberOfLines={1}>{s.title || s.session_id.slice(0, 8)}</Text>
                <Text style={styles.vrowSub} numberOfLines={1}>{fmtLastActive(s.updated_at || s.started_at)}{ctx}</Text>
              </View>
              {s.engine ? <EngineBadge engine={s.engine} size="sm" /> : null}
              <Text style={[styles.vrowK, k[1] ? styles[k[1]] as TextStyle : null]}>{k[0]}</Text>
            </Pressable>
          );
        }) : <Text style={styles.empty}>该项目目录暂无会话</Text>}
        {sessions.length > 8 ? <Text style={styles.empty}>还有 {sessions.length - 8} 个会话 · 在 💬 中查看</Text> : null}

        {/* ② 团队摘要卡（联动不合并：看板/编制详情去团队域） */}
        <Text style={styles.secH}>👥 团队</Text>
        {group ? (
          <Pressable style={styles.teamCard} android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
            accessibilityLabel={`团队 ${group.name}，点按去团队详情`}
            onPress={onGoTeam}>
            <View style={styles.teamCardInfo}>
              <Text style={styles.teamCardName} numberOfLines={1}>{group.name}</Text>
              <Text style={styles.teamCardSub} numberOfLines={1}>
                {headcount.length} 编制 · {working} 在岗 · {ORG_ST_ZH[group.status] ?? group.status}
              </Text>
            </View>
            <Text style={styles.jump}>在 👥 中查看 ↗</Text>
          </Pressable>
        ) : (
          <Text style={styles.empty}>未立项或团队数据未同步（编制在团队域维护）</Text>
        )}

        {/* ③ 输出物 */}
        <Text style={styles.secH}>📦 输出物 · {artifacts.length}</Text>
        {artifacts.length ? artifacts.slice(0, 6).map((a) => (
          <Pressable key={a.sid + a.name} style={styles.artRow} android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
            accessibilityLabel={`输出物 ${a.name}，点按打开来源会话`}
            onPress={() => onOpenSession(a.sid)}>
            <Text style={styles.artName} numberOfLines={1}>{a.name}</Text>
            <Text style={styles.artTime}>{fmtLastActive(a.lastAt)}</Text>
          </Pressable>
        )) : <Text style={styles.empty}>暂无输出物记录</Text>}
        {artifacts.length > 6 ? <Text style={styles.empty}>还有 {artifacts.length - 6} 个</Text> : null}

        {/* ④ 验收单（三态行，只读——手机填写走云端链接，设计豁免） */}
        <Text style={styles.secH}>✅ 验收单 · {acceptances.length}</Text>
        {acceptances.length ? acceptances.map((a) => {
          const judged = Number(a.judged) || 0;
          const total = Number(a.total) || 0;
          const allPass = a.submitted && judged >= total && total > 0;
          const hasFail = a.submitted && judged > 0 && judged < total;
          const [word, color] = allPass ? ["已收单", c.done] : hasFail ? ["回填中", c.error] /* #198 W3：回填语义（用户填单动作）非代码修复 */ : a.submitted ? ["已回填", c.working] : ["待填", c.working];
          return (
            <View key={a.id} style={styles.accRow}>
              <View style={styles.accT}>
                <Text style={styles.accTitle} numberOfLines={1}>{a.title || a.id.slice(0, 10)}</Text>
                <Text style={styles.accSub} numberOfLines={1}>已回填 {judged}/{total || "?"} · {fmtLastActive(a.created_at)}</Text>
              </View>
              <Text style={[styles.accK, { color, backgroundColor: withA(color, 0.12) }]}>{word}</Text>
            </View>
          );
        }) : <Text style={styles.empty}>暂无验收单（出单后随快照同步）</Text>}

        <Text style={styles.footNote}>只读聚合 · 联动不合并（写操作回原域）</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
