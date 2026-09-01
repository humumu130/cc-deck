// 设置抽屉：首页左上角图标呼出（侧滑），收纳服务器配置与显示设置
import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme, useThemeStyles } from "../theme-context";
import { setProcessFont, useProcessFont, type ProcessFont } from "../display-settings";
import type { ThemeColors } from "../theme";

const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

const FONT_OPTS: { k: ProcessFont; label: string }[] = [
  { k: "compact", label: "紧凑" },
  { k: "normal", label: "标准" },
];

export default function SettingsDrawer({ visible, onClose, onSetup }: { visible: boolean; onClose: () => void; onSetup: () => void }) {
  const { c, mode, toggle } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [x] = useState(new Animated.Value(0));
  const processFont = useProcessFont();

  useEffect(() => {
    Animated.timing(x, { toValue: visible ? 1 : 0, duration: 210, useNativeDriver: true }).start();
  }, [visible, x]);

  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-320, 0] });
  const scrimOp = x.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });

  return (
    <View style={d.root} pointerEvents={visible ? "auto" : "none"}>
      <Animated.View style={[d.scrim, { opacity: scrimOp }]}>
        <Pressable style={FILL} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[d.panel, { transform: [{ translateX }], paddingTop: 18 + insets.top }]}>
        <View style={d.head}>
          <LinearGradient colors={[c.brandA, c.brandB]} style={d.logo}>
            <Text style={d.logoT}>CC</Text>
          </LinearGradient>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={d.nameT}>Claude Code</Text>
            <Text style={d.verT}>手机遥控 · v0.2.15</Text>
          </View>
        </View>

        <Text style={d.secT}>连接</Text>
        <Pressable style={d.row} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => { onClose(); onSetup(); }}>
          <Text style={d.rowT}>服务器配置</Text>
          <Text style={d.rowCaret}>›</Text>
        </Pressable>

        <Text style={d.secT}>显示</Text>
        <View style={d.rowStatic}>
          <Text style={d.rowT}>过程消息字号</Text>
          <View style={d.seg}>
            {FONT_OPTS.map((o) => (
              <Pressable
                key={o.k}
                style={[d.segOpt, processFont === o.k && d.segOptOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }}
                onPress={() => setProcessFont(o.k)}
              >
                <Text style={[d.segT, processFont === o.k && d.segTOn]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={d.rowStatic}>
          <Text style={d.rowT}>深色模式</Text>
          <View style={d.seg}>
            <Pressable style={[d.segOpt, mode === "dark" && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => mode !== "dark" && toggle()}>
              <Text style={[d.segT, mode === "dark" && d.segTOn]}>开</Text>
            </Pressable>
            <Pressable style={[d.segOpt, mode !== "dark" && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => mode === "dark" && toggle()}>
              <Text style={[d.segT, mode !== "dark" && d.segTOn]}>关</Text>
            </Pressable>
          </View>
        </View>
        <Text style={d.tipT}>过程消息 = 工具调用 / 结果 / 系统提示；紧凑即小一号显示。</Text>
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { ...FILL, zIndex: 60, flexDirection: "row" },
  scrim: { ...FILL, backgroundColor: "#000" },
  panel: {
    width: 300, height: "100%", backgroundColor: c.bg,
    borderRightWidth: 1, borderColor: c.line, paddingTop: 18, paddingHorizontal: 16,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: c.line },
  logo: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  logoT: { color: "#fff", fontSize: 17, fontWeight: "800" },
  nameT: { color: c.text, fontSize: 16, fontWeight: "700" },
  verT: { color: c.faint, fontSize: 11.5, marginTop: 1 },
  secT: { color: c.faint, fontSize: 11, fontWeight: "700", marginTop: 20, marginBottom: 6, letterSpacing: 1 },
  row: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 13,
  },
  rowStatic: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8,
  },
  rowT: { color: c.text, fontSize: 14, fontWeight: "600" },
  rowCaret: { color: c.faint, fontSize: 18, marginTop: -2 },
  seg: { flexDirection: "row", gap: 6 },
  segOpt: {
    paddingHorizontal: 13, paddingVertical: 6, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  segOptOn: { backgroundColor: c.tintStrong, borderColor: c.brandA },
  segT: { color: c.dim, fontSize: 12, fontWeight: "600" },
  segTOn: { color: c.brandA },
  tipT: { color: c.faint, fontSize: 11, lineHeight: 16, marginTop: 10 },
});
