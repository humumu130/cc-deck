// 组织域共享件（W-EXPOLISH 自 ListScreen.tsx 迁出）：OrgZone 组织区（确认卡 ✓✗ +
// 项目组 chips + 经验分节）+ GroupModal 组详情弹窗 + useOrgData/useOrgDecide 数据面。
// 迁出动机（0.7 打磨批件三）：团队/项目两 tab 从占位卡内容化——OrgZone 宿主从列表页
// 头部迁团队 tab、组列表进项目 tab，列表屏不再渲染组织区；NotifCenterPage 的验收
// 回跳 task 落点也复用 GroupModal。数据面/决议 ACK 门原样保持：
//   数据 = snap.sources 只读平铺（orgConfirms/projects/experiences，W-EXPP2 口径）
//   决议 = store.orgConfirm → org-commands ACK 严格判定门（成功等 ORG_CONFIRM_UPDATED
//          权威帧，不本地造状态）；unknownCommandError 记能力位静默降级
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { fmtLastActive, displaySrcName } from "../fmt";
import {
  type BoardEntry,
  type DispatchReceipt,
  type ExperienceEntry,
  type OrgConfirm,
  type ProjectBoard,
  type ProjectGroup,
  type RoutingPoolEntry,
} from "../protocol";
import type { SourceStatus } from "../store";
import {
  ackTapGuard,
  ackVerdict,
  cmdCapBlocked,
  cmdCapRemember,
  orgConfirmPayload,
  orgFlightKey,
  unknownCommandError,
  type AckVerdict,
  type CmdCaps,
} from "../org-commands";
import { store, useRelay } from "../store";

// ---------- #26 M2 组织区（v3.1 矩阵式）----------
// 与 web-console 组织域同口径：确认卡（Leader 只提案 → 用户 ✓/✗ 决议，§4「用户是
// 指挥/验收者」）、项目组三态 chips（结项=archived 单向终态不占常驻位）、组详情弹窗
// （编制/任务板/回执流）。旧 relay 快照无 projects 字段（null）→ 整区不渲染，兼容
export const ORG_ST_ZH: Record<string, string> = { pending: "待确认", active: "在办", parked: "已挂起", archived: "已结项" };
export const ORG_CF_KIND_ZH: Record<string, string> = {
  "project-create": "立项", "tier-change": "升降级", "suggest-hold": "建议暂缓", archive: "结项", revive: "复活",
};
// chips 排序：待确认 → 在办 → 已挂起（同 web 端 org zone 顺序契约）
const ORG_ST_ORD: Record<string, number> = { pending: 0, active: 1, parked: 2 };
export function orgStColor(st: string, c: ThemeColors): string {
  return st === "active" ? c.done : st === "pending" ? c.waiting : c.faint;
}

// 组织数据面（自 ListScreen 三处 useMemo 迁入，口径逐字节不变）：确认卡/项目组
//（结项不占常驻位）跨源平铺（src+item 对）——旧 relay（null）源不进。
// W-EXPOLISH 件五：经验域数据面随入口迁设置分节（SettingsPage 自算，此处不再透出）
export function useOrgData(): {
  confirms: { src: SourceStatus; cf: OrgConfirm }[];
  groups: { src: SourceStatus; g: ProjectGroup }[];
} {
  const snap = useRelay();
  const confirms = useMemo(() => {
    const out: { src: SourceStatus; cf: OrgConfirm }[] = [];
    for (const src of snap.sources) for (const cf of src.orgConfirms ?? []) out.push({ src, cf });
    return out;
  }, [snap.sources]);
  const groups = useMemo(() => {
    const out: { src: SourceStatus; g: ProjectGroup }[] = [];
    for (const src of snap.sources)
      for (const g of src.projects ?? []) if (g.status !== "archived") out.push({ src, g });
    return out;
  }, [snap.sources]);
  return { confirms, groups };
}

// 组织确认决议 ACK 门（自 ListScreen orgDecide 迁入，语义不变）：approve 经
// orgConfirmPayload 强转真布尔（relay 咽喉 ===true 严判）、双击闸、失败可见态；
// unknownCommandError 记能力位后该源决议降级禁用（不再弹错轰炸）；成功不本地造
// 状态，等 ORG_CONFIRM_UPDATED 权威帧收敛。无自动重试（重试=用户重点；store 全局
// 4s 重发一次+6s 收摊封顶）
export function useOrgDecide(): {
  decide: (srcId: string, confirmId: string, approve: boolean) => void;
  err: { key: string; msg: string } | null;
  clearErr: () => void;
  caps: CmdCaps;
} {
  const [flight, setFlight] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  const [caps, setCaps] = useState<CmdCaps>({});
  const ORG_CMD = "COMMAND_ORG_CONFIRM";
  const ORG_CAP_MSG = "该源 relay 版本不支持确认卡决议，升级 relay 后可用";
  const clearErr = useCallback(() => setErr(null), []);
  const decide = useCallback((srcId: string, confirmId: string, approve: boolean) => {
    const fk = orgFlightKey(srcId, confirmId);
    if (ackTapGuard(flight, fk) === "skip") return;
    const payload = orgConfirmPayload(confirmId, approve);
    if (!payload) return;
    if (cmdCapBlocked(caps, ORG_CMD)) {
      setErr({ key: fk, msg: ORG_CAP_MSG });
      return;
    }
    setFlight((prev) => new Set(prev).add(fk));
    setErr(null);
    const settle = (v: AckVerdict): void => {
      setFlight((prev) => {
        const n = new Set(prev);
        n.delete(fk);
        return n;
      });
      if (v.ok) return; // 成功等权威帧，不本地造状态
      if (unknownCommandError(v.error)) {
        setCaps((prev) => cmdCapRemember(prev, ORG_CMD));
        setErr({ key: fk, msg: ORG_CAP_MSG });
        return;
      }
      setErr({ key: fk, msg: v.error ?? "决议未生效，可重试" });
    };
    const sent = store.orgConfirm(srcId, confirmId, payload.approve, (r) => settle(ackVerdict(r)));
    if (!sent) settle(ackVerdict(null)); // 未连接：同 unconfirmed 口径可见可重试
  }, [flight, caps]);
  return { decide, err, clearErr, caps };
}

// 组织区（团队 tab 主内容，原列表页顶条件区）：确认卡行 + 项目组 chips。
// W-EXPOLISH 件五：经验分节自此迁出（入口改设置 tab「经验库」分节——内嵌列表太侵占
// 团队页/原列表页空间，用户点单）；只读边界不变（退役/恢复/改归组走电脑端）
export function OrgZone({ confirms, groups, onDecide, onOpenGroup }: {
  confirms: { src: SourceStatus; cf: OrgConfirm }[];
  groups: { src: SourceStatus; g: ProjectGroup }[];
  onDecide: (srcId: string, confirmId: string, approve: boolean) => void;
  onOpenGroup: (src: SourceStatus, g: ProjectGroup) => void;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  if (!confirms.length && !groups.length) return null;
  const sorted = [...groups].sort((a, b) => (ORG_ST_ORD[a.g.status] ?? 9) - (ORG_ST_ORD[b.g.status] ?? 9));
  return (
    <View style={styles.orgZone}>
      {confirms.map(({ src, cf }) => (
        <View key={cf.id} style={styles.orgCf}>
          <Text style={styles.orgCfKind}>{ORG_CF_KIND_ZH[cf.kind] ?? cf.kind}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.orgCfTitle} numberOfLines={1}>{cf.title}</Text>
            {cf.reason ? <Text style={styles.orgCfReason} numberOfLines={1}>{cf.reason}</Text> : null}
          </View>
          <Pressable
            style={[styles.orgCfBtn, { backgroundColor: c.done }]}
            hitSlop={8}
            accessibilityLabel={`同意确认卡：${cf.title}`}
            onPress={() => onDecide(src.id, cf.id, true)}
          >
            <Text style={[styles.orgCfBtnT, { color: c.onDone }]}>✓</Text>
          </Pressable>
          <Pressable
            style={[styles.orgCfBtn, styles.orgCfBtnR, { borderColor: withA(c.error, 0.5) }]}
            hitSlop={8}
            accessibilityLabel={`否决确认卡：${cf.title}`}
            onPress={() => onDecide(src.id, cf.id, false)}
          >
            <Text style={[styles.orgCfBtnT, { color: c.error }]}>✗</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.orgChips}>
        {sorted.map(({ src, g }) => (
          <Pressable
            key={g.id}
            style={[
              styles.orgChip,
              g.status === "active" && { borderColor: withA(c.done, 0.5), backgroundColor: withA(c.done, 0.08) },
              g.status === "pending" && { borderColor: withA(c.waiting, 0.5), backgroundColor: withA(c.waiting, 0.08) },
            ]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityLabel={`项目组 ${g.name}，${ORG_ST_ZH[g.status] ?? g.status}，${(g.headcount ?? []).length + 1} 人，点按查看详情`}
            onPress={() => onOpenGroup(src, g)}
          >
            <Text style={[styles.orgChipT, { color: orgStColor(g.status, c) }]} numberOfLines={1}>{g.name}</Text>
            <Text style={styles.orgChipSt}>·{ORG_ST_ZH[g.status] ?? g.status}·{(g.headcount ?? []).length + 1}人</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// 经验库只读弹层（W-EXPOLISH 件五：入口自组织区内嵌分节迁设置 tab「经验库」分节后的
// 「原只读列表」新宿主）：全源 active 条目平铺（多源出源名节头），kind 徽标色/行语言
// 与原分节一致；**不设 6 条截断**（弹层可滚动，原截断是内嵌空间的妥协）；总开关关闭的
// 源照进置灰说明；手机只读边界注明。
export function ExpLibraryModal({ visible, onClose, exps }: {
  visible: boolean;
  onClose: () => void;
  exps: { src: SourceStatus; entries: ExperienceEntry[]; enabled: boolean }[];
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const total = useMemo(
    () => exps.reduce((n, x) => n + x.entries.filter((e) => e.status === "active").length, 0),
    [exps],
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.expMask} onPress={onClose}>
        <View style={{ width: "100%", maxHeight: "82%" }}>
          <Pressable style={styles.expSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.expHead}>
              <Text style={styles.expTitle}>经验库 · {total} 条</Text>
              <Pressable hitSlop={10} accessibilityLabel="关闭经验库" onPress={onClose}>
                <Text style={styles.expClose}>✕</Text>
              </Pressable>
            </View>
            <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
              {exps.length === 0 ? (
                <Text style={styles.orgExpNote}>经验库为空（worker 回执申报入库）</Text>
              ) : exps.map(({ src, entries, enabled }) => {
                const actives = entries.filter((e) => e.status === "active");
                return (
                  <View key={src.id}>
                    {exps.length > 1 ? (
                      <Text style={styles.expSrc} numberOfLines={1}>{displaySrcName(src.relayName || src.name)}</Text>
                    ) : null}
                    {!enabled ? (
                      <Text style={styles.orgExpNote}>经验库总开关已关闭（relay 设置）——注入与整理均已停</Text>
                    ) : actives.length === 0 ? (
                      <Text style={styles.orgExpNote}>经验库为空（worker 回执申报入库）</Text>
                    ) : (
                      actives.map((e) => {
                        const kindColor = e.kind === "pitfall" ? c.error : e.kind === "practice" ? c.done : e.kind === "preference" ? c.brandA : c.faint;
                        const kindZh = e.kind === "pitfall" ? "坑" : e.kind === "practice" ? "法" : e.kind === "preference" ? "好" : "实";
                        const scopeP = e.project_scope === "global" ? "全局" : (e.project_scope.split("/").filter(Boolean).pop() || "项目");
                        const scopeR = e.role_scope === "any" ? "通用" : e.role_scope;
                        return (
                          <View key={e.id} style={styles.orgExpRow}>
                            <Text style={[styles.orgExpKind, { color: kindColor }]}>{kindZh}</Text>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={styles.orgExpText} numberOfLines={2}>{e.text}</Text>
                              <Text style={styles.orgExpMeta} numberOfLines={1}>
                                {scopeR} · {scopeP} · 用 {e.use_count ?? 0} 次
                              </Text>
                            </View>
                          </View>
                        );
                      })
                    )}
                  </View>
                );
              })}
              <Text style={styles.orgExpNote}>手机只读 · 退役/恢复/改归组请用电脑端经验库</Text>
            </ScrollView>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// 组详情弹窗（对齐 web 端 org drawer）：状态/档位 → 熟手池（编制）→ 任务板
//（轻立项单列简化态 / 正经立项三段；挂起=冻结只读）→ 最近派单回执流（§3.5 过程不
// 回灌只收回执一行）。板不随快照（帧预算纪律）——COMMAND_PROJECT_DETAIL 按需拉取；
// 状态行优先取源快照实时值（PROJECTS_UPDATED 即时反映），拉取结果兜底。
// 宿主：团队 tab（chips）/ 项目 tab（列表行）/ 通知 tab（验收回跳 task 落点）
export function GroupModal({ srcId, target, onClose, onOpenSession, highlightEntryId }: {
  srcId: string;
  target: { gid: string; name: string };
  onClose: () => void;
  onOpenSession: (sid: string) => void;
  highlightEntryId?: string; // M13-6E 验收回跳：命中台账卡高亮定位（orgDetail 现拉板内查无=不高亮，防御）
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  // undefined=加载中 / null=失败 / 对象=详情
  const [detail, setDetail] = useState<{ group?: ProjectGroup; board?: ProjectBoard; receipts?: DispatchReceipt[]; pool?: RoutingPoolEntry[] } | null | undefined>(undefined);
  useEffect(() => {
    setDetail(undefined);
    // send 当即失败（未连接/源不在）没有 ACK 回调，直接落失败态
    if (!store.orgDetail(srcId, target.gid, setDetail)) setDetail(null);
  }, [srcId, target.gid]);
  const g = detail?.group;
  const board = detail?.board;
  const ents = board?.entries ?? [];
  // #26 M3 熟手池（§5 成员卡进化）：路由表档案 join 运行态，服务端拼好（detail.pool）；
  // 旧版 relay 无 pool 字段 → 空数组回落（编制快照仍在 group.headcount，不丢信息）
  const pool = useMemo(() => detail?.pool ?? [], [detail]);
  const liveG = useMemo(() => {
    for (const src of snap.sources) {
      const hit = (src.projects ?? []).find((x) => x.id === target.gid);
      if (hit) return hit;
    }
    return g;
  }, [snap.sources, target.gid, g]);
  const entRow = (e: BoardEntry) => (
    <View key={e.id} style={[styles.gmEnt, e.id === highlightEntryId && styles.gmEntHi]}>
      <Text style={styles.gmEntT} numberOfLines={2}>{e.text}</Text>
      {e.note ? <Text style={styles.gmEntNote} numberOfLines={1}>{e.note}</Text> : null}
    </View>
  );
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.gmWrap}>
        <View style={styles.gmHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.gmTitle} numberOfLines={1}>{target.name}</Text>
            <View style={styles.gmTags}>
              <Text style={[styles.gmTag, { color: orgStColor(liveG?.status ?? "", c) }]}>
                {ORG_ST_ZH[liveG?.status ?? ""] ?? liveG?.status ?? "…"}
              </Text>
              <Text style={styles.gmTag}>{liveG?.tier ?? g?.tier ?? ""}</Text>
            </View>
          </View>
          <Pressable hitSlop={10} onPress={onClose} accessibilityLabel="关闭项目组详情">
            <Text style={styles.gmClose}>✕</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.gmBody} showsVerticalScrollIndicator={false}>
          {detail === undefined ? (
            <Text style={styles.gmEmpty}>加载中…</Text>
          ) : detail === null ? (
            <Text style={styles.gmEmpty}>详情拉取失败（源可能已断开或 relay 版本过旧）</Text>
          ) : (
            <>
              {/* 熟手池：经验 N 次 · 上次 · 在忙/空闲/随组挂起/已退休（退休=只剩路由表档案，
                  不可点）；空闲/随组挂起可点开（消息/派单即拉起）；Leader 兼管不占行 */}
              <Text style={styles.gmSec}>熟手池 · {pool.length} 人（Leader 兼管）</Text>
              {pool.length ? pool.map((p) => {
                const st = p.busy ? "在忙" : p.parked ? "随组挂起" : p.resumable ? "空闲" : "已退休（档案）";
                const stColor = p.busy ? c.waiting : p.parked || !p.resumable ? c.faint : c.done;
                const body = (
                  <View style={[styles.gmSess, !p.resumable ? { opacity: 0.62 } : null]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.gmSessT} numberOfLines={1}>
                        {p.title || p.session_id.slice(0, 8)}{p.rating === "bad" ? "（差评·避开）" : ""}
                      </Text>
                      <Text style={styles.gmSessSt} numberOfLines={1}>
                        {`${p.count} 次 · 上次 ${fmtLastActive(p.last_ts)}`}
                        {p.tags?.length ? ` · ${p.tags.map((t) => "#" + t).join(" ")}` : ""}
                      </Text>
                    </View>
                    <Text style={[styles.gmSessSt, { color: stColor }]}>{st}</Text>
                  </View>
                );
                return p.resumable ? (
                  <Pressable
                    key={p.session_id}
                    android_ripple={{ color: c.tintSoft, borderless: false, radius: 9 }}
                    onPress={() => { onClose(); onOpenSession(p.session_id); }}
                  >
                    {body}
                  </Pressable>
                ) : (
                  <View key={p.session_id}>{body}</View>
                );
              }) : <Text style={styles.gmEmpty}>熟手池为空（首次派单后积累）</Text>}
              {/* 任务板：轻立项=单列简化态（渲染降级）；正经立项=D18 五态段（freeze §1.2） */}
              <Text style={styles.gmSec}>任务板{board?.frozen ? "（已挂起 · 冻结只读）" : ""}</Text>
              {ents.length === 0 ? (
                <Text style={styles.gmEmpty}>板为空</Text>
              ) : g?.tier === "轻立项" ? (
                <View style={styles.gmCol}>{ents.map(entRow)}</View>
              ) : (
                ([["backlog", "待认领"], ["claimed", "进行中"], ["submitted", "待复核"], ["ready_to_install", "待装机"], ["done", "完成"]] as const).map(([st, lb]) => (
                  <View key={st} style={styles.gmColGroup}>
                    <Text style={styles.gmColH}>{lb} {ents.filter((e) => e.status === st).length}</Text>
                    <View style={styles.gmCol}>{ents.filter((e) => e.status === st).map(entRow)}</View>
                  </View>
                ))
              )}
              {/* 回执流：readDispatchLog 按 project_anchor 过滤，最近 30 条新在前 */}
              <Text style={styles.gmSec}>最近派单回执</Text>
              {(detail.receipts ?? []).length ? detail.receipts!.map((r) => (
                <View key={r.id + r.ts} style={[styles.gmRec, { borderLeftColor: r.status === "failed" ? c.error : c.line }]}>
                  <Text style={styles.gmRecB}>[{r.tier}] {r.status}</Text>
                  {r.receipt ? <Text style={styles.gmRecT} numberOfLines={5}>{r.receipt}</Text> : null}
                  {/* 对齐 web（index.html 回执流）：target 归 meta 行、过滤 org-leader、
                      截 8 位——整段 UUID 上屏既占行又不可辨 */}
                  <Text style={styles.gmRecMeta}>{r.ts ? new Date(r.ts).toLocaleString() : ""}{r.target && r.target !== "org-leader" ? ` · ${r.target.slice(0, 8)}` : ""}</Text>
                </View>
              )) : <Text style={styles.gmEmpty}>暂无派单回执</Text>}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// 组织域样式（org*/gm* 自 ListScreen makeStyles 原样迁入，几何零改动）
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    orgZone: { gap: 6, marginBottom: 8 },
    orgCf: {
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingVertical: 9, paddingHorizontal: 12,
      borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
    },
    orgCfKind: { color: c.brandA, fontSize: 10, fontWeight: "700", flexShrink: 0 },
    orgCfTitle: { color: c.text, fontSize: 12.5, fontWeight: "600" },
    orgCfReason: { color: c.faint, fontSize: 10.5, marginTop: 1 },
    orgCfBtn: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", overflow: "hidden" },
    orgCfBtnR: { borderWidth: 1, backgroundColor: "transparent" },
    orgCfBtnT: { fontSize: 15, fontWeight: "700" },
    orgChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    orgChip: {
      flexDirection: "row", alignItems: "center", gap: 4,
      paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
      borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft, maxWidth: 210, overflow: "hidden",
    },
    orgChipT: { fontSize: 11.5, fontWeight: "600", maxWidth: 120 },
    orgChipSt: { color: c.faint, fontSize: 9.5 },
    // W-EXPP2 经验分节行语言（W-EXPOLISH 件五：行样式随列表迁 ExpLibraryModal 复用；
    // orgExp 卡盒原为内嵌分节底，弹层形态不再需要——保留行样式，卡盒样式退役）
    orgExpRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4 },
    orgExpKind: { fontSize: 10, fontWeight: "700", flexShrink: 0, marginTop: 1 },
    orgExpText: { color: c.text, fontSize: 12, lineHeight: 17 },
    orgExpMeta: { color: c.faint, fontSize: 10, marginTop: 1 },
    orgExpNote: { color: c.faint, fontSize: 10, marginTop: 2 },
    // 组详情弹窗（gm*）：头部（名称+状态/档位 tags）→ 编制行 → 板段 → 回执流
    gmWrap: { flex: 1, backgroundColor: c.bg },
    gmHead: {
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line,
    },
    gmTitle: { color: c.text, fontSize: 15, fontWeight: "700" },
    gmTags: { flexDirection: "row", gap: 6, marginTop: 4 },
    gmTag: { color: c.dim, fontSize: 10.5, paddingHorizontal: 8, paddingVertical: 1.5, borderRadius: 999, borderWidth: 1, borderColor: c.line },
    gmClose: { color: c.dim, fontSize: 17, padding: 4 },
    gmBody: { padding: 16, paddingBottom: 40 },
    gmSec: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginTop: 16, marginBottom: 7 },
    gmSess: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 6, borderRadius: 9 },
    gmDot: { width: 8, height: 8, borderRadius: 4 },
    gmSessT: { flex: 1, minWidth: 0, color: c.text, fontSize: 12.5 },
    gmSessSt: { color: c.faint, fontSize: 10 },
    gmCol: { gap: 5 },
    gmColGroup: { marginBottom: 8 },
    gmColH: { color: c.faint, fontSize: 10.5, fontWeight: "700", marginBottom: 4 },
    gmEnt: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: c.panel },
    // M13-6E 验收回跳定位高亮（web jump-flash 闪烁的 expo 静态对等——动画差异备案）
    gmEntHi: { borderWidth: 1.5, borderColor: c.brandA, backgroundColor: c.tintSoft },
    gmEntT: { color: c.text, fontSize: 12 },
    gmEntNote: { color: c.faint, fontSize: 10.5, marginTop: 2 },
    gmRec: { borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: 8, paddingVertical: 3, marginBottom: 6 },
    gmRecB: { color: c.text, fontSize: 11.5, fontWeight: "600" },
    gmRecT: { color: c.dim, fontSize: 11, marginTop: 1 },
    gmRecMeta: { color: c.faint, fontSize: 10, marginTop: 1 },
    gmEmpty: { color: c.faint, fontSize: 11.5, paddingVertical: 4 },
    // 经验库只读弹层（W-EXPOLISH 件五）：AboutModal/DevicesModal 同款贴底 sheet 语言
    expMask: { flex: 1, backgroundColor: "rgba(0,0,0,.45)", justifyContent: "flex-end" },
    expSheet: {
      backgroundColor: c.panel, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      borderWidth: 1, borderColor: c.line, paddingHorizontal: 16,
      paddingTop: 16, paddingBottom: 28,
    },
    expHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
    expTitle: { color: c.text, fontSize: 15, fontWeight: "700" },
    expClose: { color: c.dim, fontSize: 15 },
    expSrc: { color: c.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginTop: 12, marginBottom: 2 },
  });
