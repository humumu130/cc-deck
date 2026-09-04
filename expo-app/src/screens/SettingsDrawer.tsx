// 设置抽屉：首页左上角图标呼出，也支持左缘右滑呼出 / 面板上左滑收起；收纳服务器列表、快捷短语与显示设置
import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { setProcessFont, useProcessFont, setListCompact, useListCompact, setVoiceInput, useVoiceInput, type ProcessFont } from "../display-settings";
import { store, useRelay, type ServerEntry } from "../store";
import { withA, type ThemeColors } from "../theme";

const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

const FONT_OPTS: { k: ProcessFont; label: string }[] = [
  { k: "normal", label: "标准" },
  { k: "compact", label: "紧凑" },
  { k: "hidden", label: "隐藏" },
];

export default function SettingsDrawer({
  visible,
  onClose,
  onSetup,
  onEdit,
}: {
  visible: boolean;
  onClose: () => void;
  onSetup: () => void;
  onEdit: (e: ServerEntry) => void;
}) {
  const { c, mode, toggle } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [x] = useState(new Animated.Value(0));
  const visRef = useRef(visible);
  visRef.current = visible;
  // 面板上左滑收起：面板跟手拖动（x: 0 关 / 1 开），松手按位移/速度决定收起或弹回
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => visRef.current && g.dx < -12 && Math.abs(g.dy) < 14,
      onPanResponderMove: (_, g) => x.setValue(Math.min(1, Math.max(0, 1 + g.dx / 240))),
      onPanResponderRelease: (_, g) => {
        if (g.dx < -60 || g.vx < -0.4) onClose();
        else Animated.timing(x, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => {
        if (visRef.current) Animated.timing(x, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      },
    }),
  ).current;
  const processFont = useProcessFont();
  const listCompact = useListCompact();
  const voiceInput = useVoiceInput();
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    Animated.timing(x, { toValue: visible ? 1 : 0, duration: 210, useNativeDriver: true }).start();
  }, [visible, x]);

  // 每次展开时刷新（配对完成后 cloudMsg 变化也会触发条目更新）
  useEffect(() => {
    if (!visible) return;
    void store.loadServers().then(setServers);
    void store.activeServerId().then(setActiveId);
  }, [visible, snap.cloudMsg]);

  const pick = (e: ServerEntry) => {
    if (!e.token) {
      // 没存令牌：跳编辑页补输（预填地址/名称）
      onClose();
      onEdit(e);
      return;
    }
    void store.connectServer(e).then(() => setActiveId(e.id));
    onClose();
  };

  const edit = (e: ServerEntry) => {
    onClose();
    onEdit(e);
  };

  const remove = (e: ServerEntry) => {
    void store.deleteServer(e.id).then(() => {
      void store.loadServers().then(setServers);
      void store.activeServerId().then(setActiveId);
    });
  };

  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-240, 0] });
  const scrimOp = x.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });

  // 新设备配对码：信任设备向 relay 领一次性码，供网页端新浏览器输入
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const pc = snap.pairCode;
  useEffect(() => {
    if (!pc) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pc?.code]);
  const pairLeft = pc ? Math.max(0, Math.floor((pc.expiresAt - now) / 1000)) : 0;
  const genPairCode = async () => {
    setPairErr(await store.requestPairCode());
  };

  return (
    <View style={d.root} pointerEvents={visible ? "auto" : "none"}>
      <Animated.View style={[d.scrim, { opacity: scrimOp }]}>
        <Pressable style={FILL} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[d.panel, { transform: [{ translateX }], paddingTop: 18 + insets.top }]} {...pan.panHandlers}>
        <View style={d.head}>
          <View style={d.logo}>
            <LogoMark size={24} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={d.nameT}>CC Deck</Text>
            <Text style={d.verT}>v0.2.33</Text>
          </View>
        </View>

        <ScrollView style={d.body} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <Text style={d.secT}>服务器列表</Text>
        <ScrollView style={d.srvScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {servers.map((e) => {
            const active = e.id === activeId;
            return (
              <View key={e.id} style={[d.srvRow, active && d.srvRowOn]}>
                <Pressable style={d.srvMain} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => pick(e)}>
                  <View style={d.srvHead}>
                    {active ? <View style={[d.srvDot, { backgroundColor: c.done }]} /> : null}
                    <Text style={d.srvName} numberOfLines={1}>{e.name}</Text>
                    {e.cloud ? <Text style={d.srvCloud}>☁</Text> : null}
                  </View>
                  <Text style={d.srvUrl} numberOfLines={1}>{e.wsUrl}</Text>
                </Pressable>
                <Pressable style={d.srvEdit} android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }} onPress={() => edit(e)}>
                  <Text style={d.srvEditT}>✎</Text>
                </Pressable>
                <Pressable style={d.srvDel} android_ripple={{ color: withA(c.waiting, 0.15), borderless: false, radius: 13 }} onPress={() => remove(e)}>
                  <Text style={d.srvDelT}>✕</Text>
                </Pressable>
              </View>
            );
          })}
          <Pressable style={d.addRow} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => { onClose(); onSetup(); }}>
            <Text style={d.addT}>＋ 新增服务器</Text>
          </Pressable>
        </ScrollView>
        {servers.length === 0 ? <Text style={d.srvEmpty}>还没有服务器，点下方新增</Text> : null}

        <Text style={d.secT}>新设备配对</Text>
        <Pressable style={d.pairGen} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => void genPairCode()}>
          <Text style={d.pairGenT}>生成网页端配对码</Text>
        </Pressable>
        {pc ? (
          <View style={d.pairBox}>
            <Text style={d.pairCodeT}>{pc.code.slice(0, 3)} {pc.code.slice(3)}</Text>
            <Text style={[d.pairExpT, pairLeft === 0 && { color: c.waiting }]}>
              {pairLeft > 0 ? `剩余 ${pairLeft} 秒 · 一次性` : "已过期，请重新生成"}
            </Text>
            <Text style={d.pairHintT}>新设备打开网页端，选"云桥"连接后输入此码</Text>
          </View>
        ) : null}
        {pairErr ? <Text style={d.pairErrT}>{pairErr}</Text> : null}

        <Text style={d.secT}>显示</Text>
        <View style={d.rowCol}>
          <Text style={d.rowT}>过程消息</Text>
          <View style={d.segFull}>
            {FONT_OPTS.map((o) => (
              <Pressable
                key={o.k}
                style={[d.segOptF, processFont === o.k && d.segOptOn]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
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
        <View style={d.rowStatic}>
          <Text style={d.rowT}>简洁列表</Text>
          <View style={d.seg}>
            <Pressable style={[d.segOpt, listCompact && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => !listCompact && setListCompact(true)}>
              <Text style={[d.segT, listCompact && d.segTOn]}>开</Text>
            </Pressable>
            <Pressable style={[d.segOpt, !listCompact && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => listCompact && setListCompact(false)}>
              <Text style={[d.segT, !listCompact && d.segTOn]}>关</Text>
            </Pressable>
          </View>
        </View>
        <View style={d.rowStatic}>
          <Text style={d.rowT}>语音输入</Text>
          <View style={d.seg}>
            <Pressable style={[d.segOpt, voiceInput && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => !voiceInput && setVoiceInput(true)}>
              <Text style={[d.segT, voiceInput && d.segTOn]}>开</Text>
            </Pressable>
            <Pressable style={[d.segOpt, !voiceInput && d.segOptOn]} android_ripple={{ color: c.tintSoft, borderless: false, radius: 11 }} onPress={() => voiceInput && setVoiceInput(false)}>
              <Text style={[d.segT, !voiceInput && d.segTOn]}>关</Text>
            </Pressable>
          </View>
        </View>
        <Text style={d.tipT}>过程消息 = 工具调用 / 结果 / 系统提示；紧凑小一号+淡化，隐藏则整行不显示（思考内容保留）。简洁列表 = 会话卡只留状态、耗时与名称，一屏显示更多。语音输入 = 输入栏按住说话（部分机型识别服务不可用，默认关闭）。</Text>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { ...FILL, zIndex: 60, flexDirection: "row" },
  scrim: { ...FILL, backgroundColor: "#000" },
  panel: {
    width: 225, height: "100%", backgroundColor: c.bg,
    borderRightWidth: 1, borderColor: c.line, paddingTop: 18, paddingHorizontal: 16,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: c.line },
  logo: {
    width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
  nameT: { color: c.text, fontSize: 16, fontWeight: "700" },
  verT: { color: c.faint, fontSize: 11.5, marginTop: 1 },
  secT: { color: c.faint, fontSize: 11, fontWeight: "700", marginTop: 20, marginBottom: 6, letterSpacing: 1 },
  srvScroll: { maxHeight: 236 },
  srvRow: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.line,
    borderRadius: 12, backgroundColor: c.panel, marginBottom: 8, overflow: "hidden",
  },
  srvRowOn: { borderColor: withA(c.done, 0.45), backgroundColor: withA(c.done, 0.05) },
  srvMain: { flex: 1, paddingVertical: 9, paddingLeft: 11, paddingRight: 4 },
  srvHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  srvDot: { width: 7, height: 7, borderRadius: 4 },
  srvName: { color: c.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  srvUrl: { color: c.faint, fontSize: 10.5, marginTop: 1.5 },
  srvCloud: { color: c.done, fontSize: 11.5 },
  srvEdit: { width: 34, height: 42, alignItems: "center", justifyContent: "center" },
  srvEditT: { color: c.dim, fontSize: 13.5 },
  srvDel: { width: 36, height: 42, alignItems: "center", justifyContent: "center" },
  srvDelT: { color: c.faint, fontSize: 14 },
  addRow: {
    borderWidth: 1, borderColor: withA(c.brandA, 0.45), borderStyle: "dashed", borderRadius: 12,
    alignItems: "center", justifyContent: "center", paddingVertical: 10, marginBottom: 8,
  },
  addT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  srvEmpty: { color: c.faint, fontSize: 11, marginTop: 2 },
  body: { flex: 1 },
  pairGen: {
    alignItems: "center", paddingVertical: 10, borderRadius: 12, marginBottom: 8,
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
  },
  pairGenT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  pairBox: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
    borderRadius: 12, alignItems: "center", paddingVertical: 12, paddingHorizontal: 10, marginBottom: 8,
  },
  pairCodeT: { color: c.text, fontSize: 26, fontWeight: "800", letterSpacing: 4 },
  pairExpT: { color: c.dim, fontSize: 11.5, marginTop: 2 },
  pairHintT: { color: c.faint, fontSize: 10.5, marginTop: 6, textAlign: "center", lineHeight: 15 },
  pairErrT: { color: c.waiting, fontSize: 11.5, marginBottom: 8 },
  rowStatic: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8,
  },
  rowCol: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8,
  },
  rowT: { color: c.text, fontSize: 14, fontWeight: "600" },
  segFull: { flexDirection: "row", gap: 6, marginTop: 8 },
  segOptF: {
    flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
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
