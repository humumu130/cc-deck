// 设置抽屉：首页左上角图标呼出，也支持左缘右滑呼出 / 面板上左滑收起；收纳服务器列表、快捷短语与显示设置
import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { setProcessFont, useProcessFont, setListCompact, useListCompact, setVoiceInput, useVoiceInput, setAggregate as persistAggregate, useAggregate, type ProcessFont } from "../display-settings";
import { store, useRelay, type ServerEntry } from "../store";
import { withA, type ThemeColors } from "../theme";

const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

// 版本号读原生 versionName（build.gradle），杜绝手写硬编码再漏更
const APP_VER = "v" + (Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "-");

const FONT_OPTS: { k: ProcessFont; label: string }[] = [
  { k: "normal", label: "标准" },
  { k: "compact", label: "紧凑" },
  { k: "hidden", label: "隐藏" },
];

export default function SettingsDrawer({
  visible,
  onClose,
  onSetup,
  onScan,
  onEdit,
}: {
  visible: boolean;
  onClose: () => void;
  onSetup: () => void;
  onScan: () => void; // 扫码添加服务器（#276）：开设置页并直接拉起扫码
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
  const aggregate = useAggregate();
  const voiceInput = useVoiceInput();
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 服务器列表折叠：多服务器时腾出空间（记忆上次选择）
  const [srvCollapsed, setSrvCollapsed] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("cc.drawer.srvCollapsed").then((v) => setSrvCollapsed(v === "1"));
  }, []);
  const toggleSrv = () => {
    setSrvCollapsed((v) => {
      void AsyncStorage.setItem("cc.drawer.srvCollapsed", v ? "0" : "1");
      return !v;
    });
  };

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

  // 新设备配对码：信任设备向 relay 领一次性码，供网页端新浏览器输入。
  // 抽屉打开即自动领码（relay 侧多码并存互不作废），常驻展示 + 倒计时 + 刷新
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const pc = snap.pairCode;
  const pairLeft = pc ? Math.max(0, Math.floor((pc.expiresAt - now) / 1000)) : 0;
  // 倒计时 1Hz 时钟：仅抽屉可见且码未到期时运行，到期即停表（避免常驻耗电）
  useEffect(() => {
    if (!visible || !pc || pc.expiresAt <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (pc.expiresAt - Date.now() <= 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [visible, pc, pc?.code]);
  const genPairCode = async () => {
    setPairErr(await store.requestPairCode());
  };
  // 点码即复制：粘到网页端配对框省一程手输
  const [copied, setCopied] = useState(false);
  const copyCode = async () => {
    if (!pc) return;
    try {
      await Clipboard.setStringAsync(pc.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const pairing = useRef(false);
  // 抽屉打开即领码；开着期间码到期（pairLeft 归零）自动续领
  useEffect(() => {
    if (!visible || !snap.connected) return;
    if (pc && pc.expiresAt - Date.now() > 2000) return;
    if (pairing.current) return;
    pairing.current = true;
    void store
      .requestPairCode()
      .catch(() => {})
      .finally(() => {
        pairing.current = false;
      });
  }, [visible, snap.connected, pc, pairLeft === 0]);

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
            <Text style={d.verT}>{APP_VER}</Text>
          </View>
        </View>

        <ScrollView style={d.body} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <Pressable
          style={d.connRow}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
          onPress={() => store.connect()}
          accessibilityLabel={`连接状态 ${snap.connText}，点击立即重连`}
        >
          <View
            style={[
              d.connDot,
              { backgroundColor: snap.connState === "online" ? c.done : snap.connState === "offline" ? c.waiting : c.dim },
            ]}
          />
          <Text style={d.connT} numberOfLines={1}>{snap.connText}</Text>
          <Text style={d.connReT}>↻ 重连</Text>
        </Pressable>
        <View style={d.secHead}>
          <Text style={d.secTitleT}>服务器列表{srvCollapsed && servers.length ? ` · ${servers.length}` : ""}</Text>
          <Pressable style={d.secToggle} hitSlop={10} onPress={toggleSrv} android_ripple={{ color: c.tintSoft, borderless: true, radius: 12 }}>
            <Text style={d.secToggleT}>{srvCollapsed ? "▸" : "▾"}</Text>
          </Pressable>
        </View>
        {!srvCollapsed ? (
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
          {/* 新增入口两格（#276）：手动添表单 / 扫 PC 终端码一步填——同一虚线风格并排 */}
          <View style={d.addRowWrap}>
            <Pressable style={d.addRow} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => { onClose(); onSetup(); }}>
              <Text style={d.addT}>＋ 手动添加</Text>
            </Pressable>
            <Pressable style={d.addRow} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => { onClose(); onScan(); }}>
              <Text style={d.addT}>▣ 扫码添加</Text>
            </Pressable>
          </View>
        </ScrollView>
        ) : null}
        {!srvCollapsed && servers.length === 0 ? <Text style={d.srvEmpty}>还没有服务器，点下方新增</Text> : null}

        <Text style={d.secT}>新设备配对</Text>
        {pc ? (
          // pc 存在即显示码框：到期 0:00 到续领回包之间不闪「已过期」按钮（抽屉常开时每 TTL 闪一次）
          <View style={d.pairBox}>
            <View style={d.pairTop}>
              <Pressable onPress={() => void copyCode()} hitSlop={4} accessibilityLabel="配对码，点击复制">
                <Text style={d.pairCodeT}>{pc.code.slice(0, 3)} {pc.code.slice(3)}</Text>
              </Pressable>
              <View style={d.pairSide}>
                <Text style={d.pairExpT}>
                  {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, "0")}
                </Text>
                <Pressable
                  style={d.pairRefresh}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
                  hitSlop={6}
                  onPress={() => void genPairCode()}
                >
                  <Text style={d.pairRefreshT}>↻</Text>
                </Pressable>
              </View>
            </View>
            {copied ? <Text style={d.pairHintT}>已复制</Text> : null}
          </View>
        ) : (
          <Pressable style={d.pairGen} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => void genPairCode()}>
            <Text style={d.pairGenT}>{pc ? "已过期 · 重新生成" : "生成配对码"}</Text>
          </Pressable>
        )}
        {pairErr ? <Text style={d.pairErrT}>{pairErr}</Text> : null}

        <Text style={d.secT}>显示</Text>
        <View style={d.setItem}>
          <Text style={d.setLabel}>过程消息</Text>
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
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}>深色模式</Text>
          <Switch
            style={d.sw}
            value={mode === "dark"}
            onValueChange={() => toggle()}
            trackColor={{ false: c.tintSoft, true: c.brandA }}
            thumbColor="#fff"
          />
        </View>
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}>简洁列表</Text>
          <Switch
            style={d.sw}
            value={listCompact}
            onValueChange={setListCompact}
            trackColor={{ false: c.tintSoft, true: c.brandA }}
            thumbColor="#fff"
          />
        </View>
        {/* 多源聚合（#294 批4）：持久化（display-settings）+ 连接行为（store.setAggregate：
            开 = 连全部已配置源；关 = 拆非活动源、保留缓存再开无感恢复） */}
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}>多源聚合</Text>
          <Switch
            style={d.sw}
            value={aggregate}
            onValueChange={(v) => {
              persistAggregate(v);
              store.setAggregate(v);
            }}
            trackColor={{ false: c.tintSoft, true: c.brandA }}
            thumbColor="#fff"
          />
        </View>
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}>语音输入</Text>
          <Switch
            style={d.sw}
            value={voiceInput}
            onValueChange={setVoiceInput}
            trackColor={{ false: c.tintSoft, true: c.brandA }}
            thumbColor="#fff"
          />
        </View>
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
  secHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 20, marginBottom: 6 },
  secTitleT: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  secToggle: { width: 24, height: 24, alignItems: "center", justifyContent: "center", marginVertical: -6 },
  secToggleT: { color: c.dim, fontSize: 11 },
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
  addRowWrap: { flexDirection: "row", gap: 8, marginBottom: 8 },
  addRow: {
    flex: 1, borderWidth: 1, borderColor: withA(c.brandA, 0.45), borderStyle: "dashed", borderRadius: 12,
    alignItems: "center", justifyContent: "center", paddingVertical: 10, overflow: "hidden",
  },
  addT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  srvEmpty: { color: c.faint, fontSize: 11, marginTop: 2 },
  body: { flex: 1 },
  // 连接状态行（抽屉顶）：状态点 + 文案 + 手动重连；点击整行重连
  connRow: {
    flexDirection: "row", alignItems: "center", gap: 7,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
  },
  connDot: { width: 7, height: 7, borderRadius: 4 },
  connT: { flex: 1, color: c.dim, fontSize: 12.5 },
  connReT: { color: c.brandA, fontSize: 12, fontWeight: "600" },
  pairGen: {
    alignItems: "center", paddingVertical: 10, borderRadius: 12, marginBottom: 8,
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
  },
  pairGenT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  pairBox: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8,
  },
  pairTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pairSide: { flexDirection: "row", alignItems: "center", gap: 6 },
  pairCodeT: { color: c.text, fontSize: 19, fontWeight: "800", letterSpacing: 3 },
  pairExpT: { color: c.dim, fontSize: 11, fontVariant: ["tabular-nums"] },
  pairRefresh: {
    width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  pairRefreshT: { color: c.dim, fontSize: 12.5 },
  pairHintT: { color: c.faint, fontSize: 10, marginTop: 6, textAlign: "center" },
  pairErrT: { color: c.waiting, fontSize: 11.5, marginBottom: 8 },
  setItem: {
    paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.line,
  },
  setRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  setLabel: { color: c.text, fontSize: 13.5, fontWeight: "600" },
  sw: { transform: [{ scale: 0.85 }] },
  segFull: { flexDirection: "row", gap: 6, marginTop: 8 },
  segOptF: {
    flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  segOptOn: { backgroundColor: c.tintStrong, borderColor: c.brandA },
  segT: { color: c.dim, fontSize: 12, fontWeight: "600" },
  segTOn: { color: c.brandA },
});
