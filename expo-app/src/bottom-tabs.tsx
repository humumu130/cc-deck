// 底部导航骨架（expo 0.7 化批 1，设计 ~/.cc-deck/artifacts/design-expo-07.md §3）。
// 自研 TabBar + Shell 状态机（不引 react-navigation）：现壳浮层/保活/硬件返回链路
// 深度耦合手写壳（App.tsx 单点 BackHandler 分发 + navPhase 详情滑入），导航库迁移
// 风险大于收益；theme.ts navBg token 已备（005 --mobile-nav-bg 直译）。
//
// 批 1 四域（任务书口径；设计五域中的「通知」仍走会话页铃铛弹层，升 tab 留后续批）：
//   会话 = 现 ListScreen 宿主；团队/项目/设置 = 占位框架（后续批填充）。
// 规格对齐桌面 mobile-nav：高 62px 内容区 + 底缘安全区、图标 20px、44px 触区、
// 选中语义 = 图标本体染品牌色无底（微信式）、badge 15px 红底白字右上角。
// 四域视图由 Shell 保持挂载（display 切换）——各 tab 滚动位置记忆得以保留。
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
              {badge > 0 ? (
                <View style={st.badge}>
                  <Text style={st.badgeT}>{badge > 99 ? "99+" : badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[st.label, active && st.labelOn, { color }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// 占位域框架（批 1 骨架）：空态居中卡 + 域图标 +「后续版本开放」说明 + 现有等价
// 入口指引——骨架本身可出包可用，不做成突兀的空白页
export function DomainPlaceholder({ tab }: { tab: Exclude<TabKey, "sessions"> }) {
  const { c } = useTheme();
  const st = useThemeStyles(makeStyles);
  const meta = tab === "team"
    ? {
        title: "团队",
        note: "团队看板、建团与确认卡将在后续版本开放",
        hint: "当前可在会话页顶部组织区查看团队与项目",
      }
    : tab === "projects"
      ? {
          title: "项目",
          note: "项目视图与项目卡将在后续版本开放",
          hint: "当前可在会话页顶部组织区按项目分组查看会话",
        }
      : {
          title: "设置",
          note: "完整设置页将在后续版本开放",
          hint: "服务器与配对入口：会话页左上角 logo 呼出设置面板",
        };
  return (
    <View style={st.phRoot}>
      <View style={st.phCard}>
        <View style={st.phIcon}>
          <TabIcon tab={tab} color={c.faint} />
        </View>
        <Text style={st.phTitle}>{meta.title}</Text>
        <Text style={st.phNote}>{meta.note}</Text>
        <Text style={st.phHint}>{meta.hint}</Text>
      </View>
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
    badgeT: { color: "#FFFFFF", fontSize: 9, fontWeight: "800" },
    label: { fontSize: 10, fontWeight: "600" },
    labelOn: { fontWeight: "700" },
    // 占位域
    phRoot: { flex: 1, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", padding: 30 },
    phCard: {
      width: "100%",
      maxWidth: 320,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.line,
      borderRadius: 16,
      backgroundColor: c.panel,
      paddingVertical: 30,
      paddingHorizontal: 22,
    },
    phIcon: {
      width: 52,
      height: 52,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tintSoft,
    },
    phTitle: { color: c.textStrong, fontSize: 16, fontWeight: "800", marginTop: 14 },
    phNote: { color: c.dim, fontSize: 12.5, lineHeight: 19, marginTop: 8, textAlign: "center" },
    phHint: { color: c.faint, fontSize: 11.5, lineHeight: 17, marginTop: 10, textAlign: "center" },
  });
