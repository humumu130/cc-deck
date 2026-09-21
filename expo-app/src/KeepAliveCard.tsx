// #60/#85 后台保活豁免卡（2026-09-21 从 SetupScreen 抽出共享，SettingsDrawer 同显）：
// 一键拉起系统「忽略电池优化」对话框（允许即写入 doze 白名单——ColorOS freezer
// 冻结 FGS 的实证有效豁免）。不做已优化/受限两态显示：ColorOS 的
// isIgnoringBatteryOptimizations 被定制语义污染（实测白名单已清空仍返回 true），
// 两态在国产 ROM 上必然误导，恒显入口最诚实（系统对话框本身幂等）。
// #85 文案升级（2026-09-21 用户实测反馈）：手机管家的「允许后台活动/自启动」是
// 厂商层白名单，管不住 Android 系统层的进程冻结——把「设了还断」的层差讲清楚。
// #130 纵向两行重排（设计稿拍板）：修黑边 bug（原写了 borderWidth 没写 borderColor，
// RN 默认纯黑——截图里刺眼黑框的根因）；抽屉紧凑态 56dp——标题行右端「去优化 ›」
// 文字链 + 副行一句话；detail 态保完整教育文案 + 整宽 32h 按钮（pairGen 同语言）
import { Alert, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { withA, type ThemeColors } from "./theme";
import { useTheme, useThemeStyles } from "./theme-context";
import { requestBatteryExempt } from "./notify";

// #85 兜底落点引导（2026-09-21 用户实测 ColorOS 点「去优化」无反应：缺 AOSP 主
// 对话框 activity，旧实现静默）。原生三级兜底返回实际打开的页面，非主路径给一句
// 话指引——用户知道跳到了哪、接下来点什么
function onExemptPress(): void {
  const r = requestBatteryExempt();
  if (r === "dialog") return; // 标准确认对话框已弹出，系统自己引导
  if (r === "list") {
    Alert.alert("已打开电池优化设置", "在列表中找到 CC Deck（不常见时看「全部应用」），设为「不允许优化」。");
    return;
  }
  if (r === "details") {
    Alert.alert("已打开应用详情", "请进入「电池 / 耗电管理」，选择「允许完全后台行为 / 不优化」。");
    return;
  }
  Alert.alert("未能打开系统设置", "可连电脑执行一次授权（此后永久生效）：\nadb shell dumpsys deviceidle whitelist +com.humumu.ccwatch");
}

// #130 紧凑态 ⓘ 弹窗：原 detail 态副行教育文案收进这里（不占常驻空间）
function kaHelp(): void {
  Alert.alert(
    "关于后台保活",
    "手机系统会冻结后台应用（连接断开、通知延迟）。手机管家里的「允许后台活动/自启动」是厂商层白名单，管不住系统层的进程冻结，需再授予系统级「忽略电池优化」才彻底。\n\n若系统弹窗不生效，可连电脑执行一次（此后永久生效）：\nadb shell dumpsys deviceidle whitelist +com.humumu.ccwatch",
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // #130 反馈（2026-09-21 用户真机）：紧凑卡 56dp 太大太显眼——抽屉态降为单行
    //（与设置行同构：paddingVertical 11 + hairline 底线），教育文案收进 ⓘ 弹窗
    kaRow: {
      flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line,
    },
    // detail 态（SetupScreen 添加连接页）保留完整卡片：box + 副行 + 整宽按钮
    kaBox: {
      borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.panel,
      paddingVertical: 9, paddingHorizontal: 12,
    },
    kaRow1: { flexDirection: "row", alignItems: "center", gap: 6 },
    kaDot: { width: 7, height: 7, borderRadius: 4 },
    kaTitle: { color: c.text, fontSize: 13.5, fontWeight: "600" },
    // 紧凑态小问号（faint 不抢焦点）：点弹教育文案 + adb 命令
    kaHelp: { color: c.faint, fontSize: 12.5, fontWeight: "700" },
    // 紧凑态动作位：标题行右端品牌蓝文字链（与全 App 文字链同语言）
    kaLink: { marginLeft: "auto", color: c.brandA, fontSize: 12.5, fontWeight: "600" },
    kaSub: { color: c.faint, fontSize: 11, lineHeight: 15, marginTop: 3 },
    // detail 态整宽按钮（pairGen 同语言：tintStrong 底 + 品牌蓝描边）
    kaBtn: {
      marginTop: 9, height: 32, borderRadius: 12, alignItems: "center", justifyContent: "center",
      backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45), overflow: "hidden",
    },
    kaBtnT: { color: c.brandA, fontSize: 12.5, fontWeight: "700" },
  });

// detail=true 完整说明（SetupScreen 添加连接场景）；false 单行（设置抽屉常驻，教育
// 文案收进 ⓘ）。style 透传外层定位（限宽/边距由使用方布局决定）
export default function KeepAliveCard({ detail = false, style }: { detail?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const s = useThemeStyles(makeStyles);
  if (!detail) {
    return (
      <View style={[s.kaRow, style]}>
        <View style={[s.kaDot, { backgroundColor: c.working }]} />
        <Text style={s.kaTitle}>后台保活</Text>
        <Pressable hitSlop={8} onPress={kaHelp} accessibilityLabel="后台保活说明">
          <Text style={s.kaHelp}>ⓘ</Text>
        </Pressable>
        <Pressable hitSlop={8} onPress={onExemptPress} accessibilityLabel="去系统优化后台保活">
          <Text style={s.kaLink}>去优化 ›</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[s.kaBox, style]}>
      <View style={s.kaRow1}>
        <View style={[s.kaDot, { backgroundColor: c.working }]} />
        <Text style={s.kaTitle}>后台保活</Text>
      </View>
      <Text style={s.kaSub} numberOfLines={4}>
        手机系统会冻结后台应用（连接断开、通知延迟）。手机管家里的「允许后台活动/自启动」管不住这一层，需再授予系统级「忽略电池优化」才彻底。OPPO/一加系统弹窗可能不生效，可连电脑执行：adb shell dumpsys deviceidle whitelist +com.humumu.ccwatch
      </Text>
      <Pressable
        style={s.kaBtn}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
        onPress={onExemptPress}
        accessibilityLabel="去系统优化后台保活"
      >
        <Text style={s.kaBtnT}>去优化</Text>
      </Pressable>
    </View>
  );
}
