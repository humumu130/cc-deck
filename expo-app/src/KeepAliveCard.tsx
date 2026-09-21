// #60/#85 后台保活豁免卡（2026-09-21 从 SetupScreen 抽出共享，SettingsDrawer 同显）：
// 一键拉起系统「忽略电池优化」对话框（允许即写入 doze 白名单——ColorOS freezer
// 冻结 FGS 的实证有效豁免）。不做已优化/受限两态显示：ColorOS 的
// isIgnoringBatteryOptimizations 被定制语义污染（实测白名单已清空仍返回 true），
// 两态在国产 ROM 上必然误导，恒显入口最诚实（系统对话框本身幂等）。
// #85 文案升级（2026-09-21 用户实测反馈）：手机管家的「允许后台活动/自启动」是
// 厂商层白名单，管不住 Android 系统层的进程冻结——把「设了还断」的层差讲清楚。
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { withA, type ThemeColors } from "./theme";
import { useTheme, useThemeStyles } from "./theme-context";
import { requestBatteryExempt } from "./notify";

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    kaBox: {
      borderWidth: 1, borderRadius: 13, backgroundColor: c.panel,
      paddingVertical: 10, paddingHorizontal: 12, flexDirection: "row",
      alignItems: "center", gap: 10,
    },
    kaMain: { flex: 1 },
    kaHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    kaDot: { width: 7, height: 7, borderRadius: 4 },
    kaTitle: { color: c.text, fontSize: 13.5, fontWeight: "600" },
    kaSub: { color: c.faint, fontSize: 11, marginTop: 2, lineHeight: 15 },
    kaBtn: {
      paddingHorizontal: 13, paddingVertical: 7, borderRadius: 15, borderWidth: 1,
      borderColor: withA(c.working, 0.5), backgroundColor: withA(c.working, 0.08), overflow: "hidden",
    },
    kaBtnT: { color: c.working, fontSize: 12.5, fontWeight: "600" },
  });

// detail=true 完整说明（SetupScreen 添加连接场景）；false 紧凑一行提示（设置抽屉常驻）。
// style 透传外层定位（限宽/边距由使用方布局决定）
export default function KeepAliveCard({ detail = false, style }: { detail?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const s = useThemeStyles(makeStyles);
  return (
    <View style={[s.kaBox, style]}>
      <View style={s.kaMain}>
        <View style={s.kaHead}>
          <View style={[s.kaDot, { backgroundColor: c.working }]} />
          <Text style={s.kaTitle}>后台保活</Text>
        </View>
        <Text style={s.kaSub} numberOfLines={detail ? 4 : 2}>
          {detail
            ? "手机系统会冻结后台应用（连接断开、通知延迟）。手机管家里的「允许后台活动/自启动」管不住这一层，需再授予系统级「忽略电池优化」才彻底。OPPO/一加系统弹窗可能不生效，可连电脑执行：adb shell dumpsys deviceidle whitelist +com.humumu.ccwatch"
            : "后台频繁断线时点右侧授权系统级「忽略电池优化」（手机管家的「允许后台活动」管不住系统冻结层）"}
        </Text>
      </View>
      <Pressable
        style={s.kaBtn}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
        onPress={requestBatteryExempt}
        accessibilityLabel="去系统优化后台保活"
      >
        <Text style={s.kaBtnT}>去优化</Text>
      </Pressable>
    </View>
  );
}
