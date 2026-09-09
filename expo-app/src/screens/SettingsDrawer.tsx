// 设置抽屉：首页左上角图标呼出，也支持左缘右滑呼出 / 面板上左滑收起；
// 分区收纳连接（状态卡+服务器列表）、配对、显示与关于
import { useEffect, useRef, useState } from "react";
import { Animated, Linking, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { setProcessFont, useProcessFont, setVoiceInput, useVoiceInput, setAggregate as persistAggregate, useAggregate, type ProcessFont } from "../display-settings";
import { checkUpdate, announceUpdate, VERSION_NOTES } from "../updates";
import { store, useRelay, type ServerEntry, type SourceStatus } from "../store";
import { withA, type ThemeColors } from "../theme";

const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

// 版本号读原生 versionName（build.gradle），杜绝手写硬编码再漏更
const APP_VER = "v" + (Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "-");

// #313 反馈入口：关于弹窗「✎ 反馈」跳 GitHub Issues
const FEEDBACK_URL = "https://github.com/humumu130/cc-deck/issues";

// 连接状态卡副行的源状态文案（store connState → 中文）
const SRC_STATE_TEXT: Record<SourceStatus["state"], string> = {
  idle: "未连接",
  connecting: "连接中",
  online: "在线",
  reconnecting: "重连中",
  offline: "已断开",
  unpaired: "未配对",
};

const FONT_OPTS: { k: ProcessFont; label: string }[] = [
  { k: "normal", label: "标准" },
  { k: "compact", label: "紧凑" },
  { k: "hidden", label: "隐藏" },
];

// #337 服务器色点=身份色：登记后固定，不随选中/连接状态变——选中由 srvRowOn 外侧
// 亮边框表达。#356 哈希取色会撞色（书房电脑/Mac 同黄）——改同网页 srcColorByKey：
// 按当前服务器 id 集合稳定排序分配色板序号，源数≤7 必不重
const SRV_COLORS = ["#D97757", "#4D9FFF", "#2BD98F", "#A78BFA", "#22D3EE", "#F472B6", "#FBBF24"] as const;
let srvColorOrder: string[] = [];
let srvColorMap = new Map<string, string>();
const rebuildSrvColors = (ids: string[]) => {
  const sorted = [...ids].sort();
  if (sorted.length === srvColorOrder.length && sorted.every((v, i) => v === srvColorOrder[i])) return;
  srvColorOrder = sorted;
  srvColorMap = new Map(sorted.map((id, i) => [id, SRV_COLORS[i % SRV_COLORS.length]]));
};

// #353 拨杆档位选择器（通用）：一条胶囊轨道 + 带阴影滑块，spring 弹拨到选中档；
// 点任意档位标签即拨过去（现仅过程消息使用；列表布局三档已迁列表页统计行胶囊）
function Lever<T extends string>({ options, value, onChange }: {
  options: { k: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const idx = Math.max(0, options.findIndex((o) => o.k === value));
  const [w] = useState(174);
  const seg = w / options.length;
  const x = useRef(new Animated.Value(idx * seg)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: idx * seg, velocity: 4, friction: 9, useNativeDriver: true }).start();
  }, [idx, x, seg]);
  return (
    <View style={[d.leverTrack, { width: w }]} onLayout={(e) => { const nw = e.nativeEvent.layout.width; if (nw > 0 && Math.abs(nw - w) < 1) return; }}>
      <Animated.View style={[d.leverThumb, { width: seg - 6, transform: [{ translateX: x.interpolate({ inputRange: [0, seg * (options.length - 1)], outputRange: [3, seg * (options.length - 1) + 3] }) }] }]} />
      {options.map((o, i) => (
        <Pressable key={o.k} style={d.leverOpt} onPress={() => onChange(o.k)} hitSlop={{ top: 4, bottom: 4 }}>
          <Text style={[d.leverT, i === idx && d.leverTOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// #313 关于弹窗：底部滑上卡片（NewSessionModal 同款视觉语言——全宽贴底、只上圆角）。
// 版本信息（LogoMark + 版本号）+ 本版特性摘要（VERSION_NOTES 逐条）+ 检查更新
// （原 #312 抽屉行迁入：结果行内反馈，有新版经 announceUpdate 弹 App 层 UpdateBanner）
// + 反馈入口（GitHub Issues）
// 手动检查更新（关于弹窗按钮与抽屉关于区行共用）：loading 态防抖；无新版"已是最新 ✓"，
// 有新版行内提示 + announceUpdate 弹 App 层 UpdateBanner
function useUpdateCheck() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const checkNow = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("检查中…");
    const info = await checkUpdate();
    setBusy(false);
    if (info) {
      setMsg(`发现新版 v${info.version} ↗`);
      announceUpdate(info);
    } else {
      setMsg(`已是最新 ✓ ${APP_VER}`);
    }
  };
  return { busy, msg, checkNow };
}

function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const { busy, msg, checkNow } = useUpdateCheck();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.abMask} onPress={onClose}>
        <View style={{ width: "100%" }}>
          <Pressable style={m.abSheet} onPress={(e) => e.stopPropagation()}>
            <View style={m.abHead}>
              <View style={m.abLogo}>
                <LogoMark size={26} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={m.abNameT}>CC Deck</Text>
                <Text style={m.abVerT}>{APP_VER}</Text>
              </View>
              <Pressable style={m.abClose} hitSlop={8} onPress={onClose} accessibilityLabel="关闭关于">
                <Text style={m.abCloseT}>✕</Text>
              </Pressable>
            </View>
            <Text style={m.abSecT}>本版特性</Text>
            {VERSION_NOTES.map((n, i) => (
              <View key={i} style={m.abNoteRow}>
                <View style={m.abNoteDot} />
                <Text style={m.abNoteT}>{n}</Text>
              </View>
            ))}
            <View style={m.abBtnRow}>
              <Pressable
                style={[m.abBtn, busy && m.abBtnOff]}
                disabled={busy}
                android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 13 }}
                onPress={() => void checkNow()}
              >
                <Text style={m.abBtnT}>{busy ? "检查中…" : "↻ 检查更新"}</Text>
              </Pressable>
              <Pressable
                style={[m.abBtn, m.abBtnGhost]}
                android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
                onPress={() => void Linking.openURL(FEEDBACK_URL).catch(() => {})}
              >
                <Text style={[m.abBtnT, m.abBtnGhostT]}>✎ 反馈</Text>
              </Pressable>
            </View>
            {msg ? <Text style={m.abMsgT} numberOfLines={1}>{msg}</Text> : null}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

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
  const aggregate = useAggregate();
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  rebuildSrvColors(servers.map((s) => s.id));
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

  // #313 关于弹窗：抽屉「ⓘ 关于」行呼出；检查更新从抽屉行迁入弹窗。抽屉收起时一并收弹窗
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    if (!visible) setAboutOpen(false);
  }, [visible]);

  // #313 显示设置区折叠：低频项收纳腾空间（记忆上次选择，默认展开），折叠态标题示"常用"
  const [dispCollapsed, setDispCollapsed] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("cc_display_collapsed").then((v) => setDispCollapsed(v === "1"));
  }, []);
  const toggleDisp = () => {
    setDispCollapsed((v) => {
      void AsyncStorage.setItem("cc_display_collapsed", v ? "0" : "1");
      return !v;
    });
  };

  // 连接状态卡（对齐设置原型）：活动源 = activeSourceId 命中项 → 缺失退第一个在线源 →
  // 再退任一源；无源显示"未配置"。状态点按源 state 取色，副行 = 通道（cloud=云桥/LAN）
  // + 状态文案
  const activeSrc =
    snap.sources.find((s) => s.id === snap.activeSourceId) ??
    snap.sources.find((s) => s.state === "online") ??
    snap.sources[0] ??
    null;
  const connDotColor = !activeSrc
    ? c.faint
    : activeSrc.state === "online"
      ? c.done
      : activeSrc.state === "connecting" || activeSrc.state === "reconnecting"
        ? c.waiting
        : activeSrc.state === "offline" || activeSrc.state === "unpaired"
          ? c.error
          : c.faint;
  const connSubText = activeSrc
    ? [
        activeSrc.channel === "cloud" ? "云桥" : activeSrc.channel === "lan" ? "LAN" : null,
        SRC_STATE_TEXT[activeSrc.state],
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // 关于区检查更新行：与关于弹窗共用同一套检查逻辑（行内反馈）
  const upd = useUpdateCheck();

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
        {/* 连接区（对齐设置原型）：区头（可折叠收起服务器列表）+ 状态卡 + 列表/添加入口 */}
        <View style={d.secHead}>
          <Text style={d.secTitleT}><Text style={d.secIconT}>◫ </Text>连接{srvCollapsed && servers.length ? ` · ${servers.length}` : ""}</Text>
          <Pressable style={d.secToggle} hitSlop={10} onPress={toggleSrv} android_ripple={{ color: c.tintSoft, borderless: true, radius: 12 }}>
            <Text style={d.secToggleT}>{srvCollapsed ? "▸" : "▾"}</Text>
          </Pressable>
        </View>
        {/* 状态卡：活动源状态点 + 名称粗体 + 通道/状态副行；整卡点击重连（原顶部连接行迁入） */}
        <Pressable
          style={d.connCard}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
          onPress={() => store.connect()}
          accessibilityLabel={`连接状态${activeSrc ? ` ${activeSrc.name} ${connSubText}` : " 未配置"}，点击立即重连`}
        >
          <View style={[d.connDot, { backgroundColor: connDotColor }]} />
          <View style={d.connMain}>
            <Text style={d.connNameT} numberOfLines={1}>{activeSrc ? activeSrc.name : "未配置"}</Text>
            {connSubText ? <Text style={d.connSubT} numberOfLines={1}>{connSubText}</Text> : null}
          </View>
          <Text style={d.connReT}>↻ 重连</Text>
        </Pressable>
        {!srvCollapsed ? (
        <ScrollView style={d.srvScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {servers.map((e) => {
            const active = e.id === activeId;
            return (
              <View key={e.id} style={[d.srvRow, active && d.srvRowOn]}>
                <Pressable style={d.srvMain} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => pick(e)}>
                  <View style={d.srvHead}>
                    {/* #337 身份色点：登记后固定（id 哈希取色板），与选中/在线状态解耦；
                        当前选中由 srvRowOn 外侧亮边框表达 */}
                    <View style={[d.srvDot, { backgroundColor: srvColorMap.get(e.id) ?? c.faint }]} />
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
          {/* #308：活动源是局域网地址且未配云桥——离家即断线，温和引导去编辑页配对 */}
          {(() => {
            const cur = servers.find((e) => e.id === activeId) ?? servers[0];
            const lanOnly = cur && /^ws:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(cur.wsUrl) && !cur.cloud;
            if (!lanOnly || srvCollapsed) return null;
            return (
              <Pressable
                style={d.cloudHint}
                android_ripple={{ color: c.tintSoft, borderless: false }}
                onPress={() => edit(cur)}
              >
                <Text style={d.cloudHintT}>🌤 离家也能用：为此源配对云桥 ›</Text>
              </Pressable>
            );
          })()}
        </ScrollView>
        ) : null}
        {!srvCollapsed && servers.length === 0 ? <Text style={d.srvEmpty}>还没有服务器，点下方新增</Text> : null}

        <Text style={d.secT}><Text style={d.secIconT}>⇄ </Text>配对</Text>
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

        {/* #313 显示区可折叠：服务器列表同款 secHead + ▾/▸，AsyncStorage 记忆（默认展开） */}
        <View style={d.secHead}>
          <Text style={d.secTitleT}><Text style={d.secIconT}>≡ </Text>显示{dispCollapsed ? " · 常用" : ""}</Text>
          <Pressable style={d.secToggle} hitSlop={10} onPress={toggleDisp} android_ripple={{ color: c.tintSoft, borderless: true, radius: 12 }}>
            <Text style={d.secToggleT}>{dispCollapsed ? "▸" : "▾"}</Text>
          </Pressable>
        </View>
        {!dispCollapsed ? (
        <>
        <View style={d.setItem}>
          <Text style={d.setLabel}><Text style={d.rowIconT}>▤ </Text>过程消息</Text>
          {/* #353 拨杆档位选择器：整条轨道一个胶囊，滑块弹拨到选中档（替代三框点选） */}
          <Lever options={FONT_OPTS} value={processFont} onChange={setProcessFont} />
        </View>
        {/* 多源聚合（#294 批4）：持久化（display-settings）+ 连接行为（store.setAggregate：
            开 = 连全部已配置源；关 = 拆非活动源、保留缓存再开无感恢复） */}
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}><Text style={d.rowIconT}>⧉ </Text>多源聚合</Text>
          <Switch
            style={d.sw}
            value={aggregate}
            onValueChange={(v) => {
              persistAggregate(v);
              store.setAggregate(v);
            }}
            trackColor={{ false: "rgba(128,134,140,0.55)", true: c.brandA }}
            thumbColor="#fff"
          />
        </View>
        </>
        ) : null}
        {/* #313 关于区（对齐设置原型）：版本（呼出弹窗看本版特性/检查更新/反馈）、检查更新
            （行内反馈，与弹窗共用 useUpdateCheck）、反馈三行列表 + 底部弱化 Build 行 */}
        <Text style={d.secT}><Text style={d.secIconT}>ⓘ </Text>关于</Text>
        <Pressable
          style={[d.setItem, d.setRow]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => setAboutOpen(true)}
          accessibilityLabel="版本与本版特性"
        >
          <Text style={d.setLabel}><Text style={d.rowIconT}>◈ </Text>版本</Text>
          <Text style={d.aboutVerT}>{APP_VER} ›</Text>
        </Pressable>
        <Pressable
          style={[d.setItem, d.setRow]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          disabled={upd.busy}
          onPress={() => void upd.checkNow()}
          accessibilityLabel="检查更新"
        >
          <Text style={d.setLabel}><Text style={d.rowIconT}>↻ </Text>检查更新</Text>
          <Text style={d.aboutVerT} numberOfLines={1}>{upd.busy ? "检查中…" : (upd.msg ?? "›")}</Text>
        </Pressable>
        <Pressable
          style={[d.setItem, d.setRow]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => void Linking.openURL(FEEDBACK_URL).catch(() => {})}
          accessibilityLabel="反馈"
        >
          <Text style={d.setLabel}><Text style={d.rowIconT}>✎ </Text>反馈</Text>
          <Text style={d.aboutT}>›</Text>
        </Pressable>
        <Text style={d.aboutBuildT}>CC Deck · Build {APP_VER.replace(/^v/, "")}</Text>
        </ScrollView>
      </Animated.View>
      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
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
  secT: { color: c.faint, fontSize: 11, fontWeight: "700", marginTop: 18, marginBottom: 6, letterSpacing: 1 },
  secHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18, marginBottom: 6 },
  secTitleT: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  // #346 分区/行前缀小图标（与网页设置面板 gi 同语言）：色弱一档、字号小一档
  secIconT: { color: c.dim, fontSize: 10.5 },
  secToggle: { width: 24, height: 24, alignItems: "center", justifyContent: "center", marginVertical: -6 },
  secToggleT: { color: c.dim, fontSize: 11 },
  srvScroll: { maxHeight: 236 },
  srvRow: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.line,
    borderRadius: 12, backgroundColor: c.panel, marginBottom: 8, overflow: "hidden",
  },
  srvRowOn: { borderColor: withA(c.done, 0.45), backgroundColor: withA(c.done, 0.08) },
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
  // #378 去框化二期：添加入口去虚线框，纯文字链接式（品牌色 + 可点热区）
  addRow: {
    flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 10,
  },
  addT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  cloudHint: {
    marginTop: 8, alignItems: "center", paddingVertical: 7, borderRadius: 10,
    borderWidth: 1, borderColor: withA(c.working, 0.35), backgroundColor: withA(c.working, 0.07),
  },
  cloudHintT: { color: c.working, fontSize: 11.5, fontWeight: "600" },
  srvEmpty: { color: c.faint, fontSize: 11, marginTop: 2 },
  body: { flex: 1 },
  // 连接状态卡（连接区顶，对齐设置原型）：状态点 + 源名称粗体 + 通道/状态副行小字；
  // 与服务器行同语言（圆角 12 / 细边框 / panel 底）；整卡点击重连
  connCard: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 10, paddingHorizontal: 11, borderRadius: 12,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  connDot: { width: 7, height: 7, borderRadius: 4 },
  connMain: { flex: 1, minWidth: 0 },
  connNameT: { color: c.text, fontSize: 13.5, fontWeight: "700" },
  connSubT: { color: c.faint, fontSize: 10.5, marginTop: 1.5 },
  connReT: { color: c.brandA, fontSize: 12, fontWeight: "600" },
  pairGen: {
    alignItems: "center", paddingVertical: 10, borderRadius: 12, marginBottom: 8,
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
  },
  pairGenT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  // #378 配对码平铺去框（对齐网页 #352）：大字码 + 右侧倒计时/刷新，无外框
  pairBox: {
    paddingVertical: 10, paddingHorizontal: 2, marginBottom: 8,
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
  rowIconT: { color: c.dim, fontSize: 12, fontWeight: "400" },
  // #353 拨杆：胶囊轨道 + 浮起滑块（阴影），标签盖在轨道上层
  leverTrack: {
    flexDirection: "row", alignSelf: "stretch", marginTop: 9, height: 34, borderRadius: 17,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  leverThumb: {
    position: "absolute", top: 3, left: 0, bottom: 3, borderRadius: 14,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: withA(c.brandA, 0.4),
    // 勿加 elevation：Android 上 elevation 压过后续兄弟的 zIndex，会把选中档
    // 标签整个盖住（标签须渲染在滑块上层，靠 JSX 顺序即可）
  },
  leverOpt: { flex: 1, alignItems: "center", justifyContent: "center", zIndex: 1 },
  leverT: { color: c.dim, fontSize: 12 },
  leverTOn: { color: c.text, fontWeight: "600" },
  sw: {},
  segFull: { flexDirection: "row", gap: 6, marginTop: 8 },
  segOptF: {
    flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  segOptOn: { backgroundColor: c.tintStrong, borderColor: c.brandA },
  segT: { color: c.dim, fontSize: 12, fontWeight: "600" },
  segTOn: { color: c.brandA },
  // #313 关于行右侧箭头
  aboutT: { color: c.faint, fontSize: 14 },
  // 关于区行右值（版本号/检查结果，弱一档小字）
  aboutVerT: { color: c.dim, fontSize: 11.5, flexShrink: 1, paddingLeft: 8 },
  // 关于区底部弱化 Build 行（面板元信息收尾，最暗一档）
  aboutBuildT: { color: c.faint, fontSize: 10, marginTop: 14 },
  // #313 关于弹窗（ab = about）：NewSessionModal 同款贴底卡片视觉语言
  abMask: { flex: 1, backgroundColor: withA("#02050A", 0.65), justifyContent: "flex-end" },
  abSheet: {
    backgroundColor: c.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 16,
    paddingTop: 18, paddingBottom: 30,
  },
  abHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  abLogo: {
    width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
  abNameT: { color: c.text, fontSize: 16.5, fontWeight: "700" },
  abVerT: { color: c.faint, fontSize: 11.5, marginTop: 1 },
  abClose: {
    width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  abCloseT: { color: c.dim, fontSize: 13 },
  abSecT: { color: c.faint, fontSize: 11, fontWeight: "700", marginBottom: 8, letterSpacing: 1 },
  abNoteRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3.5 },
  abNoteDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.brandA },
  abNoteT: { flex: 1, color: c.dim, fontSize: 12.5, lineHeight: 18 },
  abBtnRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  abBtn: {
    flex: 1, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
    overflow: "hidden",
  },
  abBtnOff: { opacity: 0.55 },
  abBtnT: { color: c.brandA, fontSize: 13.5, fontWeight: "700" },
  abBtnGhost: { backgroundColor: c.tintSoft, borderColor: c.line },
  abBtnGhostT: { color: c.dim },
  abMsgT: { color: c.dim, fontSize: 12, marginTop: 10, textAlign: "center" },
});
