// 团队详情页（W-EXPODOMAIN v2 件一主体，design-expo-mobile-v2 B2/A1）：GroupModal 弹窗
// 形态升级的全屏页，七节纵排——
//   ① 待你确认（本组确认卡置顶，决议钮内联+状态徽三态）
//   ② 看板纵向五态（claimed 节按成员分区+运行中卡置顶；backlog 尾「未指派」小节）
//   ③ 看板卡三行制+owner 行+点卡展开浮层（全文/执行者/时间/流转时间线）
//   ④ 编制折叠组（成员卡=nick 别名/角色/状态灯同源/水位真比例 85/60——UPOLISH3 口径）
//   ⑤ 活动流（回执时间线，状态词中文化）
//   ⑥ 经验节（只读，project_scope=组锚点+全局）
//   ⑦ 铁律节（只读，受众/范围徽章+图例；rule-append 实时决议走确认卡队列）
// 数据面全现成：COMMAND_PROJECT_DETAIL 按需拉（group/board/receipts/pool）+ SNAPSHOT
// 增量（PROJECTS_UPDATED/BOARD_UPDATED/experience/rules/org_confirms）。板数据 live
// 优先（conn.boards[gid] 由 BOARD_UPDATED delta 维护，M13-4 锚定纪律），detail 拉取
// 结果兜底。对话不设 tab（A1-13）——经成员卡/看板 owner 点开成员会话即达。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { ENGINE_ACCENT, statusColor, withA, type ThemeColors } from "../theme";
import { displaySrcName, fmtLastActive } from "../fmt";
import {
  type BoardEntry,
  type DispatchReceipt,
  type ExperienceEntry,
  type ProjectBoard,
  type ProjectGroup,
  type RoutingPoolEntry,
  type RuleEntry,
  type SessionState,
} from "../protocol";
import { store, useRelay } from "../store";
import { BOARD_LANES, ConfirmCard, normDir, ORG_ST_ZH, orgStColor, tierZh, useOrgDecide } from "./OrgZone";

// 派单回执状态词中文化（桌面 activityMarkup statuses 同词表）
const RECEIPT_ST_ZH: Record<string, string> = { dispatched: "已派单", running: "运行中", done: "完成", failed: "失败" };
// MM-DD HH:mm（桌面 expFmtTime 同格式）
function fmtMdHm(ts: number | undefined): string {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 路径缩短显示（尾两段——锚点目录全长在 6 寸屏必截断，尾两段足够辨识）
function shortDir(v: string | undefined | null): string {
  const segs = normDir(v).split("/").filter(Boolean);
  return segs.length ? segs.slice(-2).join("/") : "—";
}

// ---------- 成员卡信息模型（桌面 memberInfo 口径，UPOLISH3 件十⑤/件十一/件十六）----------
export interface MemberInfo {
  sid: string;
  name: string;
  role: string;
  nick: string;
  engine?: string;
  model?: string;
  provider?: string;
  ctxUsed?: number;
  ctxLimit?: number;
  status?: SessionState["status"];
}
export function memberInfoOf(
  member: { session_id: string; role: string; engine?: string; model?: string; provider?: string; nick?: string },
  session: SessionState | undefined,
): MemberInfo {
  return {
    sid: member.session_id,
    name: member.nick || session?.title || member.session_id,
    role: member.role || "角色未标注",
    nick: member.nick || "",
    engine: member.engine || session?.engine,
    model: member.model || session?.model || "模型未标注",
    // provider 是 headcount 席位字段（relay 下发）；expo SessionState 无此键——不从会话 join
    provider: member.provider || "",
    ctxUsed: session?.context_usage,
    ctxLimit: session?.context_limit,
    status: session?.status,
  };
}

// ---------- 看板卡 owner 解析（桌面 taskOwnerResolve 口径：owner_session 直绑 +
// `[角色名]/[成员名]` 文本前缀唯一命中也绑；歧义/零命中不绑保持未指派）----------
export function taskOwnerResolve(
  e: BoardEntry,
  members: { session_id: string; role: string; nick?: string }[],
  sessions: SessionState[],
): { member: { session_id: string; role: string; nick?: string } | null; text: string; resolved: boolean } {
  const full = String(e.text || e.id);
  if (e.owner_session) {
    const m = members.find((x) => x.session_id === e.owner_session);
    return { member: m ?? null, text: full, resolved: !!m };
  }
  const pm = /^\[([^\[\]]{1,16})\]\s*/.exec(full);
  if (!pm) return { member: null, text: full, resolved: false };
  const key = pm[1].trim().toLowerCase();
  const hits = members.filter((m) => {
    const ses = sessions.find((s) => s.session_id === m.session_id);
    const info = memberInfoOf(m, ses);
    return (info.role || "").toLowerCase() === key || (info.name || "").toLowerCase() === key || (info.nick || "").toLowerCase() === key;
  });
  if (hits.length !== 1) return { member: null, text: full, resolved: false };
  return { member: hits[0], text: full.slice(pm[0].length), resolved: true };
}

// 引擎徽标（词表外/缺失不渲染——件六口径：兜底「引擎未知」上卡=噪音）
const ENGINE_ZH: Record<string, string> = {
  claude: "Claude", codex: "Codex", trae: "Trae", "qwen-code": "Qwen", codebuddy: "CodeBuddy", zcode: "ZCode",
};
function EngineBadge({ engine }: { engine?: string }) {
  const styles = useThemeStyles(makeStyles);
  if (!engine || !ENGINE_ZH[engine]) return null;
  return (
    <View style={styles.engBadge}>
      <View style={[styles.engDot, { backgroundColor: ENGINE_ACCENT[engine] }]} />
      <Text style={styles.engBadgeT}>{ENGINE_ZH[engine]}</Text>
    </View>
  );
}

export function TeamDetailPage({ srcId, gid, name, onClose, onOpenSession, highlightEntryId }: {
  srcId: string;
  gid: string;
  name: string;
  onClose: () => void;
  onOpenSession: (sid: string) => void;
  highlightEntryId?: string; // 验收回跳：命中台账卡高亮（orgDetail 现拉板内查无=不高亮，防御）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  // undefined=加载中 / null=失败 / 对象=详情（orgDetail ack 必达回调）
  const [detail, setDetail] = useState<{ group?: ProjectGroup; board?: ProjectBoard; receipts?: DispatchReceipt[]; pool?: RoutingPoolEntry[] } | null | undefined>(undefined);
  const fetchDetail = useCallback(() => {
    setDetail(undefined);
    if (!store.orgDetail(srcId, gid, setDetail)) setDetail(null);
  }, [srcId, gid]);
  useEffect(() => fetchDetail(), [fetchDetail]);

  const src = useMemo(() => snap.sources.find((x) => x.id === srcId), [snap.sources, srcId]);
  // 状态行优先取源快照实时值（PROJECTS_UPDATED 即时反映），拉取结果兜底
  const g = useMemo(
    () => (src?.projects ?? []).find((x) => x.id === gid) ?? detail?.group,
    [src, gid, detail],
  );
  // 板 live 优先：conn.boards[gid] 由 BOARD_UPDATED delta 维护（orgDetail ack 锚定），
  // 拉取结果兜底（旧 relay 无增量帧 = 永远走兜底，行为同旧 GroupModal）
  const board = useMemo(() => src?.boards?.[gid] ?? detail?.board, [src, gid, detail]);
  const ents = useMemo(() => board?.entries ?? [], [board]);
  const receipts = detail?.receipts ?? [];
  const pool = detail?.pool ?? [];
  const anchor = normDir(g?.anchor_dir);
  const members = useMemo(
    () => (Array.isArray(g?.headcount) ? g!.headcount! : []).filter((m) => m && typeof m.session_id === "string"),
    [g],
  );
  const headcountSessions = members.map((m) => ({
    m,
    s: snap.sessions.find((x) => x.session_id === m.session_id),
  }));
  // 本组确认卡（payload.gid 命中；rule-append 等团队级卡在团队 tab 队列决议，不进组页）
  const groupConfirms = useMemo(
    () => (src?.orgConfirms ?? []).filter((cf) => (cf.payload as { gid?: unknown } | undefined)?.gid === gid),
    [src, gid],
  );
  const { decide, err, clearErr, flights, accepted } = useOrgDecide();

  // 经验节（只读）：active 条目，范围=全局或本组锚点（桌面 expProjectName 匹配口径）
  const experiences = useMemo(() => {
    if (!src?.experiences) return null;
    return src.experiences.filter((e) => {
      if (e.status !== "active") return false;
      if (e.project_scope === "global") return true;
      return normDir(e.project_scope) === anchor;
    });
  }, [src, anchor]);
  // 铁律节（只读）：在役条目，范围=团队或本组锚点（scope 词表 team | project:<锚点>）
  const rules = useMemo(() => {
    if (!src?.rules) return null;
    return src.rules.filter((r) => {
      if (r.status !== "active") return false;
      if (r.scope === "team") return true;
      return normDir(r.scope.slice("project:".length)) === anchor;
    });
  }, [src, anchor]);
  const hasLeaderRule = !!(rules && rules.some((r) => r.audience === "leader"));
  const projNameOf = useCallback(
    (a: string) => (src?.projects ?? []).find((p) => normDir(p.anchor_dir) === normDir(a))?.name || shortDir(a),
    [src],
  );

  // 派单运行中判定（件八：claimed 分区内运行中卡置顶——回执同 id 取末行状态）
  const dispatchStatus = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of receipts) if (r.id) m.set(r.id, r.status);
    return m;
  }, [receipts]);

  // 编制折叠组（默认折叠）+ 看板卡展开集（id 键控——BOARD_UPDATED 增量不收回展开态）
  const [hcOpen, setHcOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const memberName = useCallback((sid: string) => {
    const hit = headcountSessions.find((x) => x.m.session_id === sid);
    return hit ? memberInfoOf(hit.m, hit.s).name : sid.slice(0, 8);
  }, [headcountSessions]);

  // ---------- 看板卡（精简三行制 + 点卡展开） ----------
  const boardCard = (e: BoardEntry) => {
    const r = taskOwnerResolve(e, members, snap.sessions);
    const ses = r.member ? snap.sessions.find((x) => x.session_id === r.member!.session_id) : undefined;
    const info = r.member ? memberInfoOf(r.member, ses) : null;
    const engKnown = !!(info?.engine && ENGINE_ZH[info.engine]);
    const running = !!(e.dispatch_id && dispatchStatus.get(e.dispatch_id) === "running");
    const open = expanded.has(e.id);
    const hi = e.id === highlightEntryId;
    return (
      <Pressable
        key={e.id}
        style={[styles.tCard, hi && styles.tCardHi]}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
        accessibilityLabel={`任务卡 ${r.text}，${r.resolved ? `执行者 ${info!.name}` : "未指派"}，点按${open ? "收起" : "展开"}详情`}
        onPress={() => toggleExpand(e.id)}
      >
        <Text style={styles.tCardT} numberOfLines={open ? 4 : 2}>{r.text}</Text>
        {e.note ? <Text style={styles.tCardNote} numberOfLines={open ? 4 : 1}>{e.note}</Text> : null}
        <View style={styles.tCardOwner}>
          {running ? <View style={styles.tRunDot} /> : null}
          {engKnown ? <EngineBadge engine={info!.engine} /> : null}
          {r.resolved && info ? (
            <Text style={styles.tCardOwnerT} numberOfLines={1}>
              <Text style={styles.tCardOwnerName}>{info.name}</Text>
              {info.role && info.role !== "角色未标注" ? ` · ${info.role}` : ""}
            </Text>
          ) : (
            <Text style={[styles.tCardOwnerT, styles.tCardUnass]}>未指派</Text>
          )}
        </View>
        {open ? (
          <View style={styles.tCardX}>
            <Text style={styles.tCardXL}>执行者：{r.resolved && info ? `${info.name} · ${info.role || "—"}` : "未指派"}</Text>
            <Text style={styles.tCardXL}>创建 {fmtMdHm(e.created_at)} · 更新 {fmtMdHm(e.updated_at)}</Text>
            {e.transitions?.length ? (
              <Text style={styles.tCardXL}>
                流转：{e.transitions
                  .map((tr) => `${BOARD_LANES.find(([k]) => k === tr.status)?.[1] ?? tr.status} ${fmtMdHm(tr.ts)}`)
                  .join(" → ")}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    );
  };

  // 泳道渲染：backlog=有主在前+「未指派」小节；claimed=按成员分区（组内 ts 升序=排队序，
  // 运行中置顶）+离编/无主尾节；其余态平铺。轻立项=单列简化态（渲染降级维持）
  const laneSection = (st: string, label: string) => {
    const items = ents.filter((e) => e.status === st);
    if (!items.length) return null;
    return (
      <View key={st} style={styles.lane}>
        <Text style={styles.laneH}>{label} · {items.length}</Text>
        {g?.tier === "轻立项" ? (
          <View style={styles.laneBody}>{items.map(boardCard)}</View>
        ) : st === "backlog" ? (() => {
          const assigned: BoardEntry[] = [];
          const unassigned: BoardEntry[] = [];
          for (const e of items) (taskOwnerResolve(e, members, snap.sessions).resolved ? assigned : unassigned).push(e);
          return (
            <View style={styles.laneBody}>
              {assigned.map(boardCard)}
              {unassigned.length ? (
                <>
                  <Text style={styles.laneSub}>未指派 · {unassigned.length}</Text>
                  {unassigned.map(boardCard)}
                </>
              ) : null}
            </View>
          );
        })() : st === "claimed" ? (() => {
          const groups = new Map<string, { name: string; cards: BoardEntry[] }>();
          const orphans: BoardEntry[] = [];
          const unassigned: BoardEntry[] = [];
          for (const e of items) {
            if (!e.owner_session) { unassigned.push(e); continue; }
            if (!members.some((m) => m.session_id === e.owner_session)) { orphans.push(e); continue; }
            const key = e.owner_session;
            if (!groups.has(key)) groups.set(key, { name: memberName(key), cards: [] });
            groups.get(key)!.cards.push(e);
          }
          return (
            <View style={styles.laneBody}>
              {[...groups.entries()].map(([sid, grp]) => {
                const ordered = grp.cards.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
                ordered.sort((a, b) =>
                  (dispatchStatus.get(b.dispatch_id ?? "") === "running" ? 1 : 0) - (dispatchStatus.get(a.dispatch_id ?? "") === "running" ? 1 : 0));
                return (
                  <View key={sid} style={styles.claimGrp}>
                    <Text style={styles.claimGrpH} numberOfLines={1}>{grp.name} · {grp.cards.length}</Text>
                    {ordered.map(boardCard)}
                  </View>
                );
              })}
              {orphans.length || unassigned.length ? (
                <>
                  <Text style={styles.laneSub}>离编 / 未指派 · {orphans.length + unassigned.length}</Text>
                  {[...orphans, ...unassigned].map(boardCard)}
                </>
              ) : null}
            </View>
          );
        })() : (
          <View style={styles.laneBody}>{items.map(boardCard)}</View>
        )}
      </View>
    );
  };

  // 看板空态分档（A1-16）：无组=引导 / 板空=任务板暂无任务 / 加载中 / 失败逐档
  const boardEmpty =
    !g ? "该团队不在最新快照中（可能已结项或源已断开）"
    : !board ? (detail === undefined ? "正在加载任务板…" : detail === null ? "详情拉取失败（源可能已断开或 relay 版本过旧），可点右上刷新重试" : "尚未取得任务板，点右上刷新重试")
    : !ents.length ? "任务板暂无任务" : null;

  // ---------- 成员卡（编制折叠组，UPOLISH3 显示规则全量） ----------
  const memberCard = ({ m, s }: { m: NonNullable<ProjectGroup["headcount"]>[number]; s: SessionState | undefined }) => {
    const info = memberInfoOf(m, s);
    const dot = info.status ? statusColor(info.status, c) : c.faint;
    const used = Number(info.ctxUsed) || 0;
    const limit = Number(info.ctxLimit) || 0;
    // 水位真比例（件十六防护：NaN/无数据不渲染——宁缺毋滥）
    const pct = used && limit && limit > 0 ? Math.max(1, Math.min(100, Math.round((used / limit) * 100))) : null;
    const tone = pct == null ? null : pct >= 85 ? c.error : pct >= 60 ? c.working : c.done;
    return (
      <Pressable
        key={m.session_id}
        style={styles.memCard}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
        accessibilityLabel={`成员 ${info.name}，${info.role}${info.status ? `，${info.status}` : "，不在册"}`}
        onPress={() => { onClose(); onOpenSession(m.session_id); }}
      >
        <View style={styles.memRow}>
          <View style={[styles.memAva, { backgroundColor: withA(c.faint, 0.16) }]}>
            <Text style={styles.memAvaT}>{(info.name || "?").trim().slice(0, 1).toUpperCase()}</Text>
            <View style={[styles.memDot, { backgroundColor: dot, borderColor: c.panel }]} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.memName} numberOfLines={1}>{info.name}</Text>
            <Text style={styles.memMeta} numberOfLines={1}>
              {info.role}{info.model && info.model !== "模型未标注" ? ` · ${info.model}` : ""}{info.provider ? ` · ${info.provider}` : ""}
            </Text>
          </View>
          <EngineBadge engine={info.engine} />
        </View>
        {pct != null && tone ? (
          <View style={styles.memCtx}>
            <View style={styles.memCtxBar}>
              <View style={{ width: `${pct}%`, height: 3, borderRadius: 1.5, backgroundColor: tone }} />
            </View>
            <Text style={[styles.memCtxT, { color: tone }]}>{pct}%</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  // ---------- 经验节行（ExpLibraryModal 行语言同源） ----------
  const expRow = (e: ExperienceEntry) => {
    const kindColor = e.kind === "pitfall" ? c.error : e.kind === "practice" ? c.done : e.kind === "preference" ? c.brandA : c.faint;
    const kindZh = e.kind === "pitfall" ? "坑" : e.kind === "practice" ? "法" : e.kind === "preference" ? "好" : "实";
    const scopeP = e.project_scope === "global" ? "全局" : projNameOf(e.project_scope);
    return (
      <View key={e.id} style={styles.legRow}>
        <Text style={[styles.legKind, { color: kindColor }]}>{kindZh}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.legText} numberOfLines={2}>{e.text}</Text>
          <Text style={styles.legMeta} numberOfLines={1}>
            {e.role_scope === "any" ? "通用" : e.role_scope} · {scopeP} · 用 {e.use_count ?? 0} 次
          </Text>
        </View>
      </View>
    );
  };

  // ---------- 铁律节行（受众/范围徽章 + 在役态） ----------
  const ruleAudZh = (a: string) => (a === "all" ? "全员" : a === "leader" ? "Leader" : a.startsWith("role:") ? `角色:${a.slice(5)}` : a);
  const ruleRow = (r: RuleEntry) => (
    <View key={r.id} style={styles.legRow}>
      <Text style={[styles.legKind, { color: c.brandA }]}>律</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.legText} numberOfLines={3}>{r.text}</Text>
        <Text style={styles.legMeta} numberOfLines={1}>
          {ruleAudZh(r.audience)} · {r.scope === "team" ? "团队" : projNameOf(r.scope.slice("project:".length))}
        </Text>
      </View>
    </View>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        {/* 头部：‹返回 + 组名 + 状态胶囊/档位 + 刷新（状态点色随态，件九/件十口径） */}
        <View style={styles.head}>
          <Pressable hitSlop={10} accessibilityLabel="返回团队列表" onPress={onClose} style={styles.back}>
            <Text style={styles.backT}>‹</Text>
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.headT} numberOfLines={1}>{name}</Text>
            <View style={styles.headTags}>
              <View style={[styles.stPill, { borderColor: withA(orgStColor(g?.status ?? "", c), 0.5), backgroundColor: withA(orgStColor(g?.status ?? "", c), 0.1) }]}>
                <View style={[styles.stPillDot, { backgroundColor: orgStColor(g?.status ?? "", c) }]} />
                <Text style={[styles.stPillT, { color: orgStColor(g?.status ?? "", c) }]}>{ORG_ST_ZH[g?.status ?? ""] ?? g?.status ?? "…"}</Text>
              </View>
              {g?.tier ? <Text style={styles.headTag}>{tierZh(g.tier)}</Text> : null}
              {src ? <Text style={styles.headTag} numberOfLines={1}>{displaySrcName(src.relayName || src.name)}</Text> : null}
            </View>
          </View>
          <Pressable hitSlop={8} accessibilityLabel="刷新团队详情" onPress={fetchDetail} style={styles.refresh}>
            <Text style={styles.refreshT}>⟳</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {detail === undefined && !g ? (
            <Text style={styles.empty}>加载中…</Text>
          ) : (
            <>
              {/* ① 待你确认（本组卡置顶；无卡整块不渲染——件四④空间优化口径） */}
              {groupConfirms.length ? (
                <View style={styles.sec}>
                  <Text style={styles.secH}>待你确认 · {groupConfirms.length}</Text>
                  <View style={styles.secGap}>
                    {groupConfirms.map((cf) => (
                      <ConfirmCard key={cf.id} srcId={srcId} cf={cf} decide={decide} flights={flights} accepted={accepted} />
                    ))}
                  </View>
                  {err && err.key.startsWith(srcId + "/") ? (
                    <View style={styles.errRow}>
                      <Text style={styles.errT} numberOfLines={2}>{err.msg}</Text>
                      <Pressable hitSlop={8} accessibilityLabel="关闭决议错误提示" onPress={clearErr}>
                        <Text style={styles.errX}>×</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {/* ②③ 看板（纵向五态；轻立项=单列简化态） */}
              <Text style={styles.secH}>任务板{board?.frozen ? "（已挂起 · 冻结只读）" : ""}</Text>
              {boardEmpty ? (
                <Text style={styles.empty}>{boardEmpty}</Text>
              ) : (
                <View style={styles.board}>
                  {g?.tier === "轻立项"
                    ? ents.length ? <View style={styles.laneBody}>{ents.map(boardCard)}</View> : null
                    : BOARD_LANES.map(([st, lb]) => laneSection(st, lb))}
                </View>
              )}

              {/* ④ 编制（折叠组，默认收起；含 Leader 兼管说明） */}
              <Pressable
                style={styles.secHeadRow}
                accessibilityLabel={`编制 ${members.length} 人，点按${hcOpen ? "收起" : "展开"}`}
                onPress={() => setHcOpen((v) => !v)}
              >
                <Text style={styles.secH}>编制 · {members.length} 人（Leader 兼管）</Text>
                <Text style={styles.secChev}>{hcOpen ? "▾" : "▸"}</Text>
              </Pressable>
              {hcOpen ? (
                members.length ? (
                  <View style={styles.secGap}>{headcountSessions.map(memberCard)}</View>
                ) : (
                  <Text style={styles.empty}>暂无编制数据（建团成员或电脑端派单入编后出现）</Text>
                )
              ) : null}

              {/* ⑤ 活动流（回执时间线） */}
              <Text style={styles.secH}>活动 · 派单回执</Text>
              {receipts.length ? (
                <View style={styles.secGap}>
                  {receipts.map((r) => (
                    <View key={r.id + r.ts} style={[styles.actRow, { borderLeftColor: r.status === "failed" ? c.error : c.line }]}>
                      <Text style={styles.actHead} numberOfLines={1}>
                        {fmtMdHm(r.ts)} · <Text style={{ color: r.status === "failed" ? c.error : c.text }}>{RECEIPT_ST_ZH[r.status] ?? r.status}</Text>
                        {r.target && r.target !== "org-leader" ? ` · ${r.target.slice(0, 8)}` : ""} · {tierZh(r.tier) || r.tier}
                      </Text>
                      {r.receipt ? <Text style={styles.actText} numberOfLines={6}>{r.receipt}</Text> : null}
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.empty}>{detail === undefined ? "加载中…" : "暂无派单回执"}</Text>
              )}

              {/* ⑥ 经验节（只读消费面；旧 relay null=不渲染说明，总开关关=置灰说明） */}
              <Text style={styles.secH}>经验</Text>
              {src && src.experienceEnabled === false ? (
                <Text style={styles.empty}>经验库总开关已关闭（relay 设置）</Text>
              ) : experiences === null ? (
                <Text style={styles.empty}>此 relay 无经验库数据（旧版本 relay 或经验域未随快照下发）</Text>
              ) : experiences.length ? (
                <View style={styles.secGap}>{experiences.map(expRow)}</View>
              ) : (
                <Text style={styles.empty}>本团队暂无在役经验（worker 回执申报入库）</Text>
              )}

              {/* ⑦ 铁律节（只读；写面在电脑端——新增/导入/替代，手机经确认卡决议 rule-append） */}
              <Text style={styles.secH}>铁律</Text>
              {src && src.rulesEnabled === false ? (
                <Text style={styles.empty}>团队规则总开关已关闭（relay 设置）</Text>
              ) : rules === null ? (
                <Text style={styles.empty}>此 relay 无规则库数据（旧版本 relay 或规则域未随快照下发）</Text>
              ) : rules.length ? (
                <View style={styles.secGap}>
                  {hasLeaderRule ? <Text style={styles.legNote}>Leader 徽章条目仅注入 Leader 会话，worker 派单不可见</Text> : null}
                  {rules.map(ruleRow)}
                </View>
              ) : (
                <Text style={styles.empty}>暂无在役铁律（电脑端团队域「铁律」tab 新增或批量导入）</Text>
              )}

              {/* 熟手池（routing pool 只读；M3 现状保留——派单履历档案 join 运行态） */}
              {pool.length ? (
                <>
                  <Text style={styles.secH}>熟手池 · {pool.length} 人</Text>
                  <View style={styles.secGap}>
                    {pool.map((p) => {
                      const st = p.busy ? "在忙" : p.parked ? "随组挂起" : p.resumable ? "空闲" : "已退休（档案）";
                      const stColor2 = p.busy ? c.working : p.parked || !p.resumable ? c.faint : c.done;
                      return (
                        <Pressable
                          key={p.session_id}
                          style={styles.poolRow}
                          disabled={!p.resumable}
                          android_ripple={p.resumable ? { color: c.tintSoft, borderless: false, radius: 9 } : undefined}
                          onPress={() => { onClose(); onOpenSession(p.session_id); }}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.poolT} numberOfLines={1}>
                              {p.title || p.session_id.slice(0, 8)}{p.rating === "bad" ? "（差评·避开）" : ""}
                            </Text>
                            <Text style={styles.poolM} numberOfLines={1}>
                              {p.count} 次 · 上次 {fmtLastActive(p.last_ts)}{p.tags?.length ? ` · ${p.tags.map((t) => "#" + t).join(" ")}` : ""}
                            </Text>
                          </View>
                          <Text style={[styles.poolM, { color: stColor2 }]}>{st}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              ) : null}
              <Text style={styles.footNote}>手机只读消费面 · 新增/导入/替代/退役走电脑端团队域</Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    head: {
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line,
    },
    back: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
    backT: { color: c.brandA, fontSize: 24, fontWeight: "600", marginTop: -2 },
    headT: { color: c.text, fontSize: 15.5, fontWeight: "700" },
    headTags: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" },
    stPill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 1.5 },
    stPillDot: { width: 6, height: 6, borderRadius: 3 },
    stPillT: { fontSize: 10, fontWeight: "700" },
    headTag: { color: c.dim, fontSize: 10, paddingHorizontal: 8, paddingVertical: 1.5, borderRadius: 999, borderWidth: 1, borderColor: c.line },
    refresh: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
    refreshT: { color: c.dim, fontSize: 19 },
    body: { padding: 14, paddingBottom: 44, gap: 7 },
    sec: { marginBottom: 6 },
    secH: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginTop: 10, marginBottom: 4 },
    secHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10, marginBottom: 4, paddingVertical: 2 },
    secChev: { color: c.faint, fontSize: 12 },
    secGap: { gap: 6 },
    empty: { color: c.faint, fontSize: 11.5, lineHeight: 16, paddingVertical: 4 },
    errRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      borderRadius: 10, borderWidth: 1, borderColor: withA(c.error, 0.45),
      backgroundColor: c.panel, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6,
    },
    errT: { color: c.error, fontSize: 11.5, lineHeight: 16, flex: 1 },
    errX: { color: c.faint, fontSize: 15, fontWeight: "600" },
    // 看板
    board: { gap: 4 },
    lane: { marginBottom: 4 },
    laneH: { color: c.text, fontSize: 12, fontWeight: "700", marginBottom: 5 },
    laneSub: { color: c.faint, fontSize: 10.5, fontWeight: "700", marginTop: 6, marginBottom: 4 },
    laneBody: { gap: 6 },
    claimGrp: { marginBottom: 6 },
    claimGrpH: { color: c.dim, fontSize: 11, fontWeight: "700", marginBottom: 4 },
    tCard: {
      borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
      paddingHorizontal: 10, paddingVertical: 8, gap: 4, overflow: "hidden",
    },
    tCardHi: { borderWidth: 1.5, borderColor: c.brandA, backgroundColor: c.tintSoft },
    tCardT: { color: c.text, fontSize: 12.5, lineHeight: 17, fontWeight: "600" },
    tCardNote: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
    tCardOwner: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
    tCardOwnerT: { color: c.faint, fontSize: 10.5, flexShrink: 1 },
    tCardOwnerName: { color: c.text, fontSize: 10.5, fontWeight: "600" },
    tCardUnass: { fontStyle: "italic" },
    tRunDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.working },
    tCardX: { marginTop: 4, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, gap: 2 },
    tCardXL: { color: c.faint, fontSize: 10, lineHeight: 14 },
    engBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
    engDot: { width: 7, height: 7, borderRadius: 4 },
    engBadgeT: { color: c.dim, fontSize: 10, fontWeight: "600" },
    // 成员卡
    memCard: {
      borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
      paddingHorizontal: 10, paddingVertical: 9, gap: 7, overflow: "hidden",
    },
    memRow: { flexDirection: "row", alignItems: "center", gap: 9 },
    memAva: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
    memAvaT: { color: c.text, fontSize: 14, fontWeight: "700" },
    memDot: { position: "absolute", right: -2, bottom: -2, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
    memName: { color: c.text, fontSize: 13, fontWeight: "600" },
    memMeta: { color: c.faint, fontSize: 10.5, marginTop: 1 },
    memCtx: { flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 41 },
    memCtxBar: { flex: 1, height: 3, borderRadius: 1.5, backgroundColor: withA(c.faint, 0.25), overflow: "hidden" },
    memCtxT: { fontSize: 9.5, fontWeight: "700", fontVariant: ["tabular-nums"] },
    // 活动流
    actRow: { borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: 8, paddingVertical: 3 },
    actHead: { color: c.text, fontSize: 11, fontWeight: "600" },
    actText: { color: c.dim, fontSize: 11, lineHeight: 15.5, marginTop: 2 },
    // 经验/铁律行（ExpLibraryModal 行语言同源）
    legRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4 },
    legKind: { fontSize: 10, fontWeight: "700", flexShrink: 0, marginTop: 1 },
    legText: { color: c.text, fontSize: 12, lineHeight: 17 },
    legMeta: { color: c.faint, fontSize: 10, marginTop: 1 },
    legNote: { color: c.faint, fontSize: 10, lineHeight: 14, marginBottom: 4 },
    // 熟手池
    poolRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 6, borderRadius: 9 },
    poolT: { color: c.text, fontSize: 12.5 },
    poolM: { color: c.faint, fontSize: 10 },
    footNote: { color: c.faint, fontSize: 10, marginTop: 14, textAlign: "center" },
  });
