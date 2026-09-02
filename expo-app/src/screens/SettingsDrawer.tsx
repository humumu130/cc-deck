// 设置抽屉：首页左上角图标呼出（侧滑），收纳服务器列表、快捷短语与显示设置
import { useEffect, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme, useThemeStyles } from "../theme-context";
import { setProcessFont, useProcessFont, type ProcessFont } from "../display-settings";
import { resetPhrases, setPhrases, usePhraseState } from "../phrases";
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
  const processFont = useProcessFont();
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

  // 快捷短语管理（详情页 chips 数据源）
  const ph = usePhraseState();
  const [newPh, setNewPh] = useState("");
  const addPh = () => {
    const t = newPh.trim().slice(0, 40);
    if (!t) return;
    setPhrases([...ph.list, t]);
    setNewPh("");
  };

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
            <Text style={d.verT}>移动工作台 · v0.2.22</Text>
          </View>
        </View>

        <ScrollView style={d.body} nestedScrollEnabled>
        <Text style={d.secT}>服务器列表</Text>
        <ScrollView style={d.srvScroll} nestedScrollEnabled>
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

        <Text style={d.secT}>快捷短语</Text>
        <View style={d.phBox}>
          {ph.list.map((p, i) => (
            <View key={i} style={d.phRow}>
              <Text style={d.phT} numberOfLines={1}>{p}</Text>
              <Pressable
                style={d.phDel}
                android_ripple={{ color: withA(c.waiting, 0.15), borderless: false, radius: 12 }}
                onPress={() => setPhrases(ph.list.filter((_, j) => j !== i))}
              >
                <Text style={d.phDelT}>✕</Text>
              </Pressable>
            </View>
          ))}
          {ph.list.length === 0 ? <Text style={d.srvEmpty}>已清空：详情页将不再显示短语条</Text> : null}
          <View style={d.phAddRow}>
            <TextInput
              style={d.phInput}
              value={newPh}
              onChangeText={setNewPh}
              placeholder="新短语"
              placeholderTextColor={c.faint}
              returnKeyType="done"
              onSubmitEditing={addPh}
            />
            <Pressable
              style={[d.phAddBtn, !newPh.trim() && { opacity: 0.4 }]}
              android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
              onPress={addPh}
              disabled={!newPh.trim()}
            >
              <Text style={d.phAddT}>＋</Text>
            </Pressable>
          </View>
          {ph.customized ? (
            <Pressable style={d.phReset} android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }} onPress={resetPhrases}>
              <Text style={d.phResetT}>恢复默认</Text>
            </Pressable>
          ) : null}
        </View>

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
        <Text style={d.tipT}>过程消息 = 工具调用 / 结果 / 系统提示；紧凑小一号+淡化，隐藏则整行不显示（思考内容保留）。</Text>
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
  logo: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  logoT: { color: "#fff", fontSize: 17, fontWeight: "800" },
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
  phBox: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5,
  },
  phRow: { flexDirection: "row", alignItems: "center", minHeight: 32 },
  phT: { color: c.text, fontSize: 13, flex: 1 },
  phDel: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  phDelT: { color: c.faint, fontSize: 13 },
  phAddRow: { flexDirection: "row", gap: 6, marginTop: 5 },
  phInput: {
    flex: 1, minHeight: 34, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
    paddingHorizontal: 10, paddingVertical: 7, color: c.text, fontSize: 13,
  },
  phAddBtn: {
    width: 44, borderRadius: 10, backgroundColor: c.tintStrong,
    borderWidth: 1, borderColor: withA(c.brandA, 0.45), alignItems: "center", justifyContent: "center",
  },
  phAddT: { color: c.brandA, fontSize: 16, fontWeight: "700" },
  phReset: {
    alignItems: "center", paddingVertical: 7, marginTop: 8, borderRadius: 10,
    borderWidth: 1, borderColor: c.line, borderStyle: "dashed",
  },
  phResetT: { color: c.dim, fontSize: 12, fontWeight: "600" },
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
