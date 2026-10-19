// 组织域共享件（W-EXPODOMAIN v2 重构，design-expo-mobile-v2 件四）：OrgZone 组织区
// （确认卡行+项目组 chips 平铺）与 GroupModal 组详情弹窗两旧形态退役——确认卡升级为
// ConfirmCard（决议钮内联+状态徽三态，UIPOLISH3 件四② 口径），组详情升级为
// TeamDetailPage 全屏页（./TeamDetailPage.tsx）。本文件保留组织域数据面与只读件：
//   数据 = snap.sources 只读平铺（orgConfirms/projects/experiences/rules，W-EXPP2/W-RULES2 口径）
//   决议 = store.orgConfirm → org-commands ACK 严格判定门（成功等 ORG_CONFIRM_UPDATED
//          权威帧，不本地造状态；「等待权威更新」态=ack ok 但权威帧未收敛的中间可见态）
//   ExpLibraryModal = 设置页经验库只读弹层（A2 判定保留）
import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FadeIn } from "../motion";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { displaySrcName } from "../fmt";
import {
  type ExperienceEntry,
  type OrgConfirm,
  type ProjectGroup,
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

// ---------- #26 M2 组织区词表（v3.1 矩阵式）----------
// 状态词表与 web 端 org 域同口径；rule-append=W-RULES1 新增（agent 规则提案走卡）
export const ORG_ST_ZH: Record<string, string> = { pending: "待确认", active: "在办", parked: "已挂起", archived: "已结项" };
export const ORG_CF_KIND_ZH: Record<string, string> = {
  "project-create": "立项", "tier-change": "升降级", "suggest-hold": "建议暂缓", archive: "结项", revive: "复活", "rule-append": "铁律",
};
// 件十（桌面同源）：tier 口语化显示映射——存储值/命令载荷保持旧词（正经立项/轻立项），
// 显示层一律走 tierZh()；新增显示点禁止直用存储值
export const TIER_ZH: Record<string, string> = { "正经立项": "正式项目", "轻立项": "轻量项目" };
export function tierZh(t: string | undefined | null): string {
  return (t && TIER_ZH[t]) || t || "";
}
// 看板五态词表（relay projects.ts D18 freeze §1.2 + 桌面 lanes 逐字对齐：
// submitted=待审查、ready_to_install=待收单——v1 草案「待复核/待装机」作废）
export const BOARD_LANES: readonly [string, string][] = [
  ["backlog", "待认领"],
  ["claimed", "进行中"],
  ["submitted", "待审查"],
  ["ready_to_install", "待收单"],
  ["done", "完成"],
];
// chips 排序：待确认 → 在办 → 已挂起（同 web 端 org zone 顺序契约）
const ORG_ST_ORD: Record<string, number> = { pending: 0, active: 1, parked: 2 };
// 目录归一（桌面 normDir 口径：\ → / 、尾斜杠剥除——项目轴/锚点匹配/未立项分桶共用一把尺）
export function normDir(v: string | undefined | null): string {
  return String(v || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
}
export function orgStColor(st: string, c: ThemeColors): string {
  return st === "active" ? c.done : st === "pending" ? c.waiting : c.faint;
}
// 状态胶囊底色（A1-9 整合口径：灯+文字单枚胶囊，点色随态）
export function orgStPillBg(st: string, c: ThemeColors): string {
  return withA(orgStColor(st, c), 0.12);
}

// 组织数据面（口径不变）：确认卡/项目组（结项不占常驻位）跨源平铺（src+item 对）
// ——旧 relay（null）源不进。W-EXPODOMAIN v2：经验/铁律数据不在此聚合（团队详情页
// 按组锚点自算，设置页经验库自算——各自过滤域不同，平铺无意义）
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

// 组织确认决议 ACK 门（E2b 语义不变 + v2 状态徽三态透出）：approve 经
// orgConfirmPayload 强转真布尔、双击闸、失败可见态；unknownCommandError 记能力位后
// 该源决议降级禁用。成功不本地造状态——flights/accepted 两个中间可见态（A1-1）：
//   flights：飞行中（提交中徽，钮 disabled）
//   accepted：ack ok 已收但权威帧（ORG_CONFIRM_UPDATED）未收敛（等待权威更新徽）
//             权威帧到达=确认卡从 pending 清单消失，accepted 残键由消费方按在场卡清理
export function useOrgDecide(): {
  decide: (srcId: string, confirmId: string, approve: boolean) => void;
  err: { key: string; msg: string } | null;
  clearErr: () => void;
  caps: CmdCaps;
  flights: Set<string>;
  accepted: Set<string>;
} {
  const [flight, setFlight] = useState<Set<string>>(new Set());
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
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
      if (v.ok) {
        // 成功等权威帧：进 accepted（等待权威更新徽），权威帧收敛后卡消失自然退场
        setAccepted((prev) => new Set(prev).add(fk));
        return;
      }
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
  return { decide, err, clearErr, caps, flights: flight, accepted };
}

// 确认卡（A1-1 升级形态，团队 tab 队列与团队详情页共用）：kind 徽+标题+状态徽三态
// （待你确认/提交中/等待权威更新）+ 理由行 + payload 展开块 + ✓/✗ 决议钮内联。
// rule-append 的 payload 是规则草稿（text/audience/scope）——逐字段人话呈现（用户
// 决议的就是这段文本）；其余 kind 的 payload 展开为 JSON 小字（对齐桌面「卡片本就
// 全量展示 payload」）
export function ConfirmCard({ srcId, cf, decide, flights, accepted }: {
  srcId: string;
  cf: OrgConfirm;
  decide: (srcId: string, confirmId: string, approve: boolean) => void;
  flights: Set<string>;
  accepted: Set<string>;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [openPayload, setOpenPayload] = useState(false);
  const fk = orgFlightKey(srcId, cf.id);
  const inFlight = flights.has(fk);
  const isAccepted = accepted.has(fk);
  const badge = inFlight ? "提交中" : isAccepted ? "等待权威更新" : "待你确认";
  const badgeColor = inFlight ? c.working : isAccepted ? c.done : c.waiting;
  const busy = inFlight || isAccepted;
  const draft = cf.kind === "rule-append" ? (cf.payload ?? null) : null;
  const payloadKeys = cf.payload && Object.keys(cf.payload).length ? Object.keys(cf.payload) : [];
  return (
    <View style={styles.orgCf}>
      <View style={styles.orgCfHead}>
        <Text style={styles.orgCfKind}>{ORG_CF_KIND_ZH[cf.kind] ?? cf.kind}</Text>
        <Text style={styles.orgCfTitle} numberOfLines={2}>{cf.title}</Text>
        <View style={[styles.orgCfBadge, { borderColor: withA(badgeColor, 0.45), backgroundColor: withA(badgeColor, 0.1) }]}>
          <Text style={[styles.orgCfBadgeT, { color: badgeColor }]}>{badge}</Text>
        </View>
      </View>
      {cf.reason ? <Text style={styles.orgCfReason} numberOfLines={2}>{cf.reason}</Text> : null}
      {draft && typeof (draft as { text?: unknown }).text === "string" ? (
        <View style={styles.orgCfDraft}>
          <Text style={styles.orgCfDraftT}>{String((draft as { text: string }).text)}</Text>
          <Text style={styles.orgCfDraftMeta} numberOfLines={1}>
            受众 {String((draft as { audience?: unknown }).audience ?? "?")} · 范围 {String((draft as { scope?: unknown }).scope ?? "?")}
          </Text>
        </View>
      ) : payloadKeys.length ? (
        <Pressable hitSlop={6} accessibilityLabel={openPayload ? "收起确认卡详情" : "展开确认卡详情"} onPress={() => setOpenPayload((v) => !v)}>
          <Text style={styles.orgCfMore}>{openPayload ? "▾ 收起详情" : "▸ 展开详情"}</Text>
        </Pressable>
      ) : null}
      {openPayload && payloadKeys.length ? (
        <FadeIn dy={4} dur={130}>
          <Text style={styles.orgCfPayload} selectable>{JSON.stringify(cf.payload, null, 2)}</Text>
        </FadeIn>
      ) : null}
      <View style={styles.orgCfBtns}>
        <Pressable
          style={[styles.orgCfBtn, styles.orgCfGo, busy && styles.orgCfBtnOff]}
          disabled={busy}
          android_ripple={{ color: withA(c.done, 0.2), borderless: false, radius: 11 }}
          accessibilityLabel={`同意确认卡：${cf.title}`}
          onPress={() => decide(srcId, cf.id, true)}
        >
          <Text style={[styles.orgCfBtnT, { color: c.done }]}>✓ 确认</Text>
        </Pressable>
        <Pressable
          style={[styles.orgCfBtn, styles.orgCfNo, busy && styles.orgCfBtnOff]}
          disabled={busy}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
          accessibilityLabel={`否决确认卡：${cf.title}`}
          onPress={() => decide(srcId, cf.id, false)}
        >
          <Text style={[styles.orgCfBtnT, { color: c.error }]}>✗ 否决</Text>
        </Pressable>
      </View>
    </View>
  );
}

// 经验库只读弹层（设置页「经验库」分节宿主，A2 判定保留）：全源 active 条目平铺
// （多源出源名节头），kind 徽标色；不设 6 条截断（弹层可滚动，原内嵌截断是空间
// 妥协）；总开关关闭的源照进置灰说明；手机只读边界注明。
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

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // 确认卡（v2 形态）：头行（kind 徽+标题+状态徽）→ 理由 → payload/草稿 → 决议钮
    orgCf: {
      borderRadius: 12, borderWidth: 1, backgroundColor: c.panel, borderColor: c.line,
      paddingHorizontal: 12, paddingVertical: 10, gap: 7,
    },
    orgCfHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    orgCfKind: { color: c.brandA, fontSize: 10, fontWeight: "700", flexShrink: 0, marginTop: 2 },
    orgCfTitle: { color: c.text, fontSize: 12.5, fontWeight: "600", flex: 1, minWidth: 0, lineHeight: 17 },
    orgCfBadge: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2, flexShrink: 0 },
    orgCfBadgeT: { fontSize: 9.5, fontWeight: "700" },
    orgCfReason: { color: c.faint, fontSize: 10.5, lineHeight: 15 },
    // rule-append 草稿块（用户决议的就是这段文本——人话呈现，不是 JSON）
    orgCfDraft: { borderRadius: 9, backgroundColor: c.tintSoft, paddingHorizontal: 9, paddingVertical: 7, gap: 3 },
    orgCfDraftT: { color: c.text, fontSize: 12, lineHeight: 17 },
    orgCfDraftMeta: { color: c.faint, fontSize: 10 },
    orgCfMore: { color: c.brandA, fontSize: 10.5, fontWeight: "600" },
    orgCfPayload: { color: c.dim, fontSize: 10, lineHeight: 14, fontFamily: "monospace" },
    orgCfBtns: { flexDirection: "row", gap: 8, marginTop: 2 },
    orgCfBtn: { flex: 1, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", overflow: "hidden" },
    orgCfGo: { backgroundColor: withA(c.done, 0.14), borderWidth: 1, borderColor: withA(c.done, 0.4) },
    orgCfNo: { backgroundColor: "transparent", borderWidth: 1, borderColor: withA(c.error, 0.5) },
    orgCfBtnOff: { opacity: 0.45 },
    orgCfBtnT: { fontSize: 12.5, fontWeight: "700" },
    // 经验库只读弹层（保留件）：AboutModal/DevicesModal 同款贴底 sheet 语言
    orgExpRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4 },
    orgExpKind: { fontSize: 10, fontWeight: "700", flexShrink: 0, marginTop: 1 },
    orgExpText: { color: c.text, fontSize: 12, lineHeight: 17 },
    orgExpMeta: { color: c.faint, fontSize: 10, marginTop: 1 },
    orgExpNote: { color: c.faint, fontSize: 10, marginTop: 2 },
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
