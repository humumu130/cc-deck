// 页头统一组件（W-MOBILE3 #121，2026-10-15 拍板三域 Header 统一）。
// 规格直译 v8-ui-interactive-v3.html 手机壳 .appbar（行 645-656）：
//   padding 40px 14px 10px（顶 40 由 SafeArea 承担，组件只做 14 水平/10 底）、
//   bg --p-panel 系（expo headBg）、border-bottom 1px --p-line、
//   标题 15.5px/600（RN 取整 16）textStrong、副题 10.5px（11）dim 上距 2、
//   动作钮 44×44 触区 dim 色（v3 .menu/.bell/.plus 同语言）、返回 chev 同 44 触区。
// 结构：[返回?] 标题+副题(flex:1) [右槽动作序列]——v3 一级页（tt+铃+＋/⋯）与
// 二级页（back+tt+⋯）同骨架。会话页例外：源胶囊主导（件八拍板品牌行移除的
// 延续，无大标题），只对齐容器规格——见 ListScreen topbar 注释。
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme, useThemeStyles } from "../theme-context";
import type { ThemeColors } from "../theme";

export function ChevronLeft({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M15 18l-6-6 6-6" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function PageHead({
  title,
  sub,
  onBack,
  backLabel,
  right,
}: {
  title: string;
  sub?: string;
  onBack?: () => void;
  backLabel?: string;
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
        {sub ? <Text style={c.sub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    head: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      backgroundColor: c.headBg,
      borderBottomWidth: 1,
      borderBottomColor: c.line,
    },
    backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -8, flexShrink: 0 },
    title: { fontSize: 16, fontWeight: "600", color: c.textStrong, lineHeight: 22 },
    sub: { fontSize: 11, color: c.dim, marginTop: 2, lineHeight: 15 },
  });
