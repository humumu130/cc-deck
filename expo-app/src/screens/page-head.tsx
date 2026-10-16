// 页头统一组件 v2（W-HEAD4，2026-10-16 用户拍板四页 head 重做）。
// 规格（用户五点方向）：
//   ① 左侧页面标题（会话/团队/项目/设置）② 标题下统计副题（会话页=五色状态灯+计数行，
//      其余页=文字统计；设置页无）③ 源切换胶囊全页保留 ④ 通知铃铛全页保留
//   ⑤ ＋钮按页面语义走 right 槽（调用方自持）
// 紧凑约束：总高 ≤52px（垂直 padding 6/6 + 标题 16/600 lh22 + 副题 10.5 lh13）；
// 深浅双主题全 token；与底部导航同语言（44 触区/20 图标/底 1px 分隔线）。
// v1 兼容：onBack 返回钮语义不变（W-BACKFIX 二级页）；旧 sub 字符串入参继续可用。
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme, useThemeStyles } from "../theme-context";
import { useRelay } from "../store";
import { notifActionableOf } from "../notify-jump";
import type { ThemeColors } from "../theme";

export function ChevronLeft({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M15 18l-6-6 6-6" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function BellGlyph({ color, badge, c }: { color: string; badge: number; c: ReturnType<typeof makeStyles> }) {
  return (
    <View>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      {badge > 0 ? (
        <View style={c.badge}>
          <Text style={c.badgeT}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PillGlyph({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function PageHead({
  title,
  sub,
  onBack,
  backLabel,
  sourcePill,
  bell,
  right,
}: {
  title: string;
  sub?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  /** ③ 源胶囊（全页保留）：{label, onPress}——点名当前源，点击回会话页开菜单 */
  sourcePill?: { label: string; onPress: () => void };
  /** ④ 通知铃铛（全页保留）：{badge, onPress}——badge=需行动数 */
  bell?: { badge: number; onPress: () => void };
  right?: React.ReactNode;
}) {
  const c = useThemeStyles(makeStyles);
  const { c: tc } = useTheme();
  return (
    <View style={c.head}>
      {onBack ? (
        <Pressable
          style={c.backBtn}
          hitSlop={6}
          android_ripple={{ color: tc.tintSoft, borderless: false, radius: 16 }}
          onPress={onBack}
          accessibilityLabel={backLabel ?? `返回，当前页 ${title}`}
        >
          <ChevronLeft color={tc.dim} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={c.title} numberOfLines={1}>{title}</Text>
        {sub != null && sub !== false ? (
          <View style={c.subRow}>{typeof sub === "string" ? <Text style={c.sub} numberOfLines={1}>{sub}</Text> : sub}</View>
        ) : null}
      </View>
      {sourcePill ? (
        <Pressable style={c.pillBtn} hitSlop={6} onPress={sourcePill.onPress} accessibilityLabel={`数据源 ${sourcePill.label}，点击去会话页切换`}>
          <PillGlyph color={tc.dim} />
          <Text style={c.pillT} numberOfLines={1}>{sourcePill.label}</Text>
        </Pressable>
      ) : null}
      {bell ? (
        <Pressable style={c.bellBtn} hitSlop={6} onPress={bell.onPress} accessibilityLabel={`通知${bell.badge ? ` · ${bell.badge} 个需行动` : ""}`}>
          <BellGlyph color={tc.dim} badge={bell.badge} c={c} />
        </Pressable>
      ) : null}
      {right}
    </View>
  );
}

// 会话页统计副题（①② 五色状态灯+计数——V3 五色词表：working/waiting/done/error，
// 无计数的状态不显灯，全零显「暂无会话」）
export function SessionStatSub({ counts }: { counts: { working: number; waiting: number; done: number; error: number } }) {
  const c = useThemeStyles(makeStyles);
  const { c: tc } = useTheme();
  const dot = (n: number, color: string, label: string) =>
    n > 0 ? (
      <View key={label} style={c.statItem}>
        <View style={[c.statDot, { backgroundColor: color }]} />
        <Text style={c.statT}>{n}</Text>
      </View>
    ) : null;
  const any = counts.working + counts.waiting + counts.done + counts.error;
  if (!any) return <Text style={c.sub}>暂无会话</Text>;
  return (
    <View style={c.subRow}>
      {dot(counts.working, tc.done, "working")}
      {dot(counts.waiting, tc.working, "waiting")}
      {dot(counts.done, tc.faint, "done")}
      {dot(counts.error, tc.error, "error")}
    </View>
  );
}


// ③④ 全页复用 hook：当前源名（胶囊 label）与未行动通知数（铃 badge）
export function useSourceLabel(): string {
  const snap = useRelay();
  const active = snap.sources.find((x) => x.id === snap.activeSourceId);
  return active?.name || "本机";
}
export function useBellBadge(): number {
  const snap = useRelay();
  return notifActionableOf(snap.sources.flatMap((x) => x.notifications ?? [])).length;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    head: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 6,
      backgroundColor: c.headBg,
      borderBottomWidth: 1,
      borderBottomColor: c.line,
      minHeight: 44,
    },
    backBtn: { width: 36, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -6, flexShrink: 0 },
    title: { fontSize: 16, fontWeight: "600", color: c.textStrong, lineHeight: 20 },
    subRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 1 },
    sub: { fontSize: 10.5, color: c.dim, lineHeight: 13, fontWeight: "400" },
    pillBtn: {
      flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: 8,
      borderRadius: 13, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel2,
      marginRight: 8, maxWidth: 120, flexShrink: 0,
    },
    pillT: { fontSize: 10.5, color: c.dim, maxWidth: 88 },
    bellBtn: { width: 36, height: 44, alignItems: "center", justifyContent: "center", flexShrink: 0, marginRight: 2 },
    badge: {
      position: "absolute", top: -3, right: -6, minWidth: 15, height: 15, borderRadius: 8,
      backgroundColor: c.error, alignItems: "center", justifyContent: "center", paddingHorizontal: 3,
    },
    badgeT: { color: "#FFFFFF", fontSize: 9.5, fontWeight: "700" },
    statItem: { flexDirection: "row", alignItems: "center", gap: 3 },
    statDot: { width: 6, height: 6, borderRadius: 3 },
    statT: { fontSize: 10.5, color: c.dim, lineHeight: 13 },
  });
