// 底部导航骨架（expo 0.7 化批 1，设计 ~/.cc-deck/artifacts/design-expo-07.md §3）。
// 自研 TabBar + Shell 状态机（不引 react-navigation）：现壳浮层/保活/硬件返回链路
// 深度耦合手写壳（App.tsx 单点 BackHandler 分发 + navPhase 详情滑入），导航库迁移
// 风险大于收益；theme.ts navBg token 已备（005 --mobile-nav-bg 直译）。
//
// 四域（W-EXPOLISH 件六用户拍板回四域：通知放底部太挤，主流做法右上角通知——
// 通知改挂 ListScreen 顶栏铃铛 + sheet 弹层，NotifCenterPage 组件保留复用）：
// 会话 = ListScreen 宿主；团队/项目/设置 = 内容化页（OrgTabs/SettingsPage 宿主，
// 件三保留）。规格对齐桌面 mobile-nav：高 62px 内容区 + 底缘安全区、图标 20px、
// 44px 触区、选中语义 = 图标本体染品牌色无底（微信式）、badge 15px 红底白字右上角。
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "./theme-context";
import type { ThemeColors } from "./theme";

export type TabKey = "sessions" | "team" | "projects" | "settings";

// 导出仅测试用途（scripts/test-expo1-nav-scan.ts 断言四域表完整性）
export const TABS: { key: TabKey; label: string }[] = [
  { key: "sessions", label: "会话" },
  { key: "team", label: "团队" },
  { key: "projects", label: "项目" },
  { key: "settings", label: "设置" },
];

// lucide 线性图标路径（24 viewBox，stroke 口径与桌面 rail 图标同源同形）
function TabIcon({ tab, color }: { tab: TabKey; color: string }) {
  const common = {
    fill: "none" as const,
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      {tab === "sessions" ? (
        // message-square
        <Path {...common} d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      ) : tab === "team" ? (
        // users
        <>
          <Path {...common} d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <Circle {...common} cx={9} cy={7} r={4} />
          <Path {...common} d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <Path {...common} d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      ) : tab === "projects" ? (
        // folder
        <Path {...common} d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      ) : (
        // settings（齿轮）
        <>
          <Path
            {...common}
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          />
          <Circle {...common} cx={12} cy={12} r={3} />
        </>
      )}
    </Svg>
  );
}

export default function BottomTabs({
  tab,
  onChange,
  badges,
}: {
  tab: TabKey;
  onChange: (t: TabKey) => void;
  badges?: Partial<Record<TabKey, number>>;
}) {
  const { c } = useTheme();
  const st = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.bar, { paddingBottom: insets.bottom }]}>
      {TABS.map((t) => {
        const active = tab === t.key;
        const color = active ? c.brandA : c.faint;
        const badge = badges?.[t.key] ?? 0;
        return (
          <Pressable
            key={t.key}
            style={st.slot}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t.label}
            onPress={() => onChange(t.key)}
          >
            <View style={st.iconWrap}>
              <TabIcon tab={t.key} color={color} />
              {/* P0 加固（Fabric addViewAt 闪退）：badge 常挂 display 切换，不再条件
                  插拔——连接成功 SNAPSHOT 一帧内多 sibling 条件插入是 Fabric re-parent
                  冲突高发面（真机+模拟器复现「连上即崩循环」）；badge 为 absolute 定位，
                  display:none 无布局副作用 */}
              <View style={[st.badge, badge <= 0 && st.badgeOff]} pointerEvents="none">
                <Text style={st.badgeT}>{badge > 99 ? "99+" : badge}</Text>
              </View>
            </View>
            <Text style={[st.label, active && st.labelOn, { color }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // 62px 内容区（对齐桌面 mobile-nav）+ 底缘安全区由组件按 insets 注入
    bar: {
      flexDirection: "row",
      height: 62,
      backgroundColor: c.navBg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    // 44px 触区：slot 全高 62px ≥ 44
    slot: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
    iconWrap: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
    // badge 15px 红底白字右上角（桌面 mobile-nav badge 同规格）
    badge: {
      position: "absolute",
      top: -4,
      right: -8,
      minWidth: 15,
      height: 15,
      borderRadius: 7.5,
      paddingHorizontal: 4,
      backgroundColor: c.error,
      alignItems: "center",
      justifyContent: "center",
    },
    // P0 加固：badge 隐藏态 = display 切换（不插拔节点）
    badgeOff: { display: "none" },
    badgeT: { color: "#FFFFFF", fontSize: 9, fontWeight: "800" },
    label: { fontSize: 10, fontWeight: "600" },
    labelOn: { fontWeight: "700" },
  });
