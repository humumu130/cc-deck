// 设置抽屉：首页左上角图标呼出，也支持左缘右滑呼出 / 面板上左滑收起；
// 分区收纳连接（状态卡+服务器列表）、配对、显示与关于
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Animated, Linking, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { setProcessFont, useProcessFont, setVoiceInput, useVoiceInput, setAggregate as persistAggregate, useAggregate, type ProcessFont } from "../display-settings";
import { checkUpdate, announceUpdate, VERSION_NOTES } from "../updates";
import { store, useRelay, type ServerEntry, type SourceStatus, isLanUrl } from "../store";
import { withA, type ThemeColors } from "../theme";
import ScanScreen, { routeScanResult, type ScanResult } from "./ScanScreen";
import ImportPicker, { type ImportTarget } from "./ImportPicker";

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
// 亮边框表达。#356 哈希取色会撞色（我的电脑/Mac 同黄）——改同网页 srcColorByKey：
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
  // #37 同行化后拨杆整体缩小：174→118 宽、34→24 高（与「过程消息」标题同一行，
  // 侧边栏纵向空间紧张——用户点单）
  const [w] = useState(118);
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

// 扫描框角标（ScanScreen 取景框同语言 mini 版）：四角 L 亮角 + 中部扫描横线，
// 纯 View 线条绘制（App 无 svg 依赖，与既有图形语言一致）
function ScanGlyph({ color }: { color: string }) {
  const corner = { position: "absolute", width: 5, height: 5, borderColor: color } as const;
  return (
    <View style={{ width: 16, height: 16 }}>
      <View style={[corner, { top: 0, left: 0, borderTopWidth: 1.6, borderLeftWidth: 1.6 }]} />
      <View style={[corner, { top: 0, right: 0, borderTopWidth: 1.6, borderRightWidth: 1.6 }]} />
      <View style={[corner, { bottom: 0, left: 0, borderBottomWidth: 1.6, borderLeftWidth: 1.6 }]} />
      <View style={[corner, { bottom: 0, right: 0, borderBottomWidth: 1.6, borderRightWidth: 1.6 }]} />
      <View style={{ position: "absolute", left: 2, right: 2, top: 7, height: 2, borderRadius: 1, backgroundColor: color }} />
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
  // 全局扫码（直连/登录/导入三码统一入口）：头部右上扫码钮呼出，与设置页共用
  // ScanScreen.routeScanResult 同一条链路；错误走 Alert（抽屉无表单 err 行），
  // import 码在抽屉内弹 ImportPicker 选条目回发
  const [scanOpen, setScanOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  const applyScan = (r: ScanResult) => {
    void routeScanResult(r, {
      onError: (msg) => Alert.alert("扫码未完成", msg),
      onDone: () => {
        void store.loadServers().then(setServers);
        void store.activeServerId().then(setActiveId);
      },
      onImport: (t) => {
        setImportTarget(t);
        setImportOpen(true);
      },
    });
  };
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

  // #46 长按删除：条目长按亮出「删除」按钮（替原常驻 ✕），3.5s 无操作自动收回
  const [delArm, setDelArm] = useState<string | null>(null);
  // #53 图例弹窗开关
  const [legendOpen, setLegendOpen] = useState(false);
  const delArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDelete = (id: string) => {
    if (delArmTimer.current) clearTimeout(delArmTimer.current);
    setDelArm(id);
    delArmTimer.current = setTimeout(() => setDelArm((cur) => (cur === id ? null : cur)), 3500);
  };

  // #46 云桥连不上弹窗：点灰图标触发连接后 8s 仍未连上、failNote 指向云桥不可达
  // → Alert 提示（不在条目上堆状态文案）。snap 闭包防旧：ref 持最新快照
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const triggerConnect = (e: ServerEntry) => {
    pick(e);
    store.connect();
    if (!e.cloud) return;
    setTimeout(() => {
      const st = snapRef.current.sources.find((x) => x.id === e.id);
      const fn = snapRef.current.failNote;
      if (st && st.state !== "online" && fn && fn.includes("云桥")) {
        Alert.alert("云桥连不上", `${fn}。可检查网络后重试，或改用局域网直连。`);
      }
    }, 8000);
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
  // 抽屉打开即领码；开着期间码到期（pairLeft 归零）自动续领。importOpen 时暂停：
  // ImportPicker 正按用户选定的源领码（认快照里新出现的 pairCode），抽屉若同时为
  // 活动源续领会抢出另一个码、有串到别的 relay 的风险
  useEffect(() => {
    if (!visible || !snap.connected || importOpen) return;
    if (pc && pc.expiresAt - Date.now() > 2000) return;
    if (pairing.current) return;
    pairing.current = true;
    void store
      .requestPairCode()
      .catch(() => {})
      .finally(() => {
        pairing.current = false;
      });
  }, [visible, snap.connected, pc, pairLeft === 0, importOpen]);

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
  // （#36 状态卡已删：connDotColor/connSubText 随之退役）


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
          </View>
          {/* 全局扫码入口（直连/登录/导入统一扫）：头部右侧角标钮，与设置页同一链路 */}
          <Pressable
            style={d.scanBtn}
            hitSlop={8}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
            onPress={() => setScanOpen(true)}
            accessibilityLabel="扫码（直连 / 登录 / 导入）"
          >
            <ScanGlyph color={c.brandA} />
          </Pressable>
        </View>

        <ScrollView style={d.body} nestedScrollEnabled showsVerticalScrollIndicator={false}>
        {/* 连接区（对齐设置原型）：区头（可折叠收起服务器列表）+ 状态卡 + 列表/添加入口 */}
        <View style={d.secHead}>
          {/* #51 问号左靠：紧跟「连接」标题成左组（原 space-between 三元素被推中） */}
          <View style={d.secTitleRow}>
            <Text style={d.secTitleT}><Text style={d.secIconT}>◫ </Text>连接{srvCollapsed && servers.length ? ` · ${servers.length}` : ""}</Text>
            {/* #48/#53 通道含义问号：自绘图例弹窗（AboutModal 同款 sheet + 图标行） */}
            <Pressable
              hitSlop={8}
              onPress={() => setLegendOpen(true)}
              accessibilityLabel="连接图标含义说明"
            >
              <Text style={d.secHelpT}>?</Text>
            </Pressable>
          </View>
          <Pressable style={d.secToggle} hitSlop={10} onPress={toggleSrv} android_ripple={{ color: c.tintSoft, borderless: true, radius: 12 }}>
            <Text style={d.secToggleT}>{srvCollapsed ? "▸" : "▾"}</Text>
          </Pressable>
        </View>
        {/* 状态卡已删（#36 用户点单）：常驻首行撤销——状态与重连并入下方各连接行。
            未配置任何源时仍需一个入口（否则空态无路可走），保留仅此场景的引导行 */}
        {!srvCollapsed && servers.length === 0 ? (
          <Pressable style={d.connCard} android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }} onPress={() => { onClose(); onSetup(); }}>
            <View style={[d.connDot, { backgroundColor: c.faint }]} />
            <View style={d.connMain}>
              <Text style={d.connNameT}>未配置</Text>
              <Text style={d.connSubT}>点此添加第一台电脑</Text>
            </View>
          </Pressable>
        ) : null}
        {!srvCollapsed ? (
        <ScrollView style={d.srvScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {servers.map((e) => {
            const active = e.id === activeId;
            const st = snap.sources.find((x) => x.id === e.id);
            const online = st?.state === "online";
            const connecting = st?.state === "connecting" || st?.state === "reconnecting";
            // #46 通道标记（用户定稿）：云桥条目 ☁️ / LAN 源 LAN / 手动直连不显示
            // #53 通道标记：云桥 ☁️ / LAN 源 LanGlyph 胶囊（与插头/云同风格统一）/ 直连不显示
            const chanTag = e.cloud ? "cloud" : isLanUrl(e.wsUrl) ? "lan" : "";
            return (
              <View key={e.id} style={[d.srvRow, active && d.srvRowOn]}>
                <Pressable
                  style={d.srvMain}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onLongPress={() => armDelete(e.id)}
                  delayLongPress={400}
                  onPress={() => {
                    if (delArm === e.id) setDelArm(null);
                    pick(e);
                  }}
                >
                  <View style={d.srvHead}>
                    {/* #337 身份色点（登记后固定，与状态解耦）+ #46 双元素：
                        通道标记 + 连接状态插头（绿=已连/灰=可点触发/黄闪=连接中），
                        状态文案类元素全撤（云桥在线/↻ 重连等）——失败原因走弹窗 */}
                    <View style={[d.srvDot, { backgroundColor: srvColorMap.get(e.id) ?? c.faint }]} />
                    <Text style={d.srvName} numberOfLines={1}>{e.name}</Text>
                    {/* #81+#96 通道=动态属性，仅已连接显示真实通道（上报 channel 优先、
                        配置推断兜底）；#96 起不独立占位——缩成插头右下角小角标 */}
                    {(() => {
                      const chan = online ? (st?.channel ?? chanTag) : "";
                      const badge = chan === "cloud" ? "☁" : chan === "lan" ? "LAN" : "";
                      const body = connecting ? (
                        (() => {
                          ensurePlugBlink();
                          return (
                            <Animated.View style={{ opacity: plugBlink }}>
                              <PlugGlyph size={13} color={c.working} />
                            </Animated.View>
                          );
                        })()
                      ) : (
                        <Pressable
                          hitSlop={8}
                          onPress={() => { if (!online) triggerConnect(e); }}
                          accessibilityLabel={`${e.name} ${online ? "已连接" : "点击连接"}${badge ? `（${badge === "LAN" ? "局域网直连" : "云桥中转"}）` : ""}`}
                        >
                          <PlugGlyph size={13} color={online ? c.done : c.faint} />
                        </Pressable>
                      );
                      return (
                        <View style={d.plugWrap}>
                          {body}
                          {badge ? (
                            <Text style={badge === "LAN" ? d.plugBadgeLan : d.plugBadgeCloud}>{badge}</Text>
                          ) : null}
                        </View>
                      );
                    })()}
                  </View>
                  <Text style={d.srvUrl} numberOfLines={1}>{e.cloud ? e.cloud.url : e.wsUrl}</Text>
                </Pressable>
                {delArm === e.id ? (
                  /* #46 长按亮删除（替常驻 ✕）：确认按钮 3.5s 自动收回 */
                  <Pressable style={d.srvDelArm} android_ripple={{ color: withA(c.waiting, 0.15), borderless: false, radius: 13 }} onPress={() => { setDelArm(null); remove(e); }}>
                    <Text style={d.srvDelArmT}>删除</Text>
                  </Pressable>
                ) : (
                  <Pressable style={d.srvEdit} android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }} onPress={() => edit(e)}>
                    <Text style={d.srvEditT}>✎</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
          {/* 新增入口（#276/#36）：仅手动添加——扫码入口在顶栏 APP 名旁已有，此处删除重复按钮 */}
          <View style={d.addRowWrap}>
            <Pressable style={d.addRow} hitSlop={{ top: 6, bottom: 6 }} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => { onClose(); onSetup(); }}>
              <Text style={d.addT}>＋ 手动添加</Text>
            </Pressable>
          </View>
          {/* #308 云桥引导已删（#36 用户点单）：提示框啰嗦+太阳云图标无意义——
              配对入口在连接详情（点行进去）已有，此引导框整块移除 */}
        </ScrollView>
        ) : null}
        {!srvCollapsed && servers.length === 0 ? <Text style={d.srvEmpty}>还没有服务器，点下方新增</Text> : null}

        {/* L6 段头统一：纯段头（不可折叠）与可折叠段头（secHead+▾/▸）同结构同规格——
            同字号字重字色、同 18/6 上下节奏、同 24×24 右占位（行高一致）但不渲染箭头 */}
        <View style={d.secHead}>
          <Text style={d.secTitleT}><Text style={d.secIconT}>⇄ </Text>配对</Text>
          <View style={{ width: 1 }} />
        </View>
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
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}><Text style={d.rowIconT}>▤ </Text>过程消息</Text>
          {/* #37 同行化：缩小版拨杆（118×24）与标题同行（原两行占位） */}
          <Lever options={FONT_OPTS} value={processFont} onChange={setProcessFont} />
        </View>
        {/* 多源聚合（#294 批4）：持久化（display-settings）+ 连接行为（store.setAggregate：
            开 = 连全部已配置源；关 = 拆非活动源、保留缓存再开无感恢复） */}
        <View style={[d.setItem, d.setRow]}>
          <Text style={d.setLabel}><Text style={d.rowIconT}>⧉ </Text>聚合显示</Text>
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
        <View style={d.secHead}>
          <Text style={d.secTitleT}><Text style={d.secIconT}>ⓘ </Text>关于</Text>
          <View style={d.secToggle} />
        </View>
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

        </ScrollView>
      </Animated.View>
      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
      <ScanScreen visible={scanOpen} onClose={() => setScanOpen(false)} onResult={applyScan} />
      {/* #53 连接图标图例（问号入口）：AboutModal 同款底部 sheet */}
      <ConnLegendModal visible={legendOpen} onClose={() => setLegendOpen(false)} />
      <ImportPicker visible={importOpen} target={importTarget} onClose={() => setImportOpen(false)} />
    </View>
  );
}

// #53 LAN 通道标记图标化（用户点单）：描边小胶囊内写 LAN——与插头/☁️ 同风格统一，
// 列表条目与图例弹窗共用
export function LanGlyph({ color, fontSize = 8.5 }: { color: string; fontSize?: number }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 4, paddingHorizontal: 3.5, paddingVertical: 1 }}>
      <Text style={{ color, fontSize, fontWeight: "700", letterSpacing: 0.4, lineHeight: fontSize + 2 }}>LAN</Text>
    </View>
  );
}

// #53 连接图标图例弹窗（替代 Alert）：AboutModal 同款底部 sheet + 图标行自解释
// （不写「黄色/绿色」字样——直接画对应颜色的插头/标记），通道组与状态组分块
function ConnLegendModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const row = (icon: ReactNode, text: string) => (
    <View style={m.legRow}>
      <View style={m.legIcon}>{icon}</View>
      <Text style={m.legT}>{text}</Text>
    </View>
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.abMask} onPress={onClose}>
        <View style={{ width: "100%" }}>
          <Pressable style={m.abSheet} onPress={(e) => e.stopPropagation()}>
            <View style={m.legHead}>
              <Text style={m.legHeadT}>图标含义</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
                <Text style={m.legCloseT}>✕</Text>
              </Pressable>
            </View>
            {row(<Text style={{ fontSize: 13, lineHeight: 16 }}>☁️</Text>, "云桥中转 · 跨网络可用")}
            {row(<LanGlyph color={c.dim} fontSize={9} />, "局域网直连")}
            <View style={m.legSep} />
            {row(<PlugGlyph size={15} color={c.done} />, "已连接")}
            {row(<PlugGlyph size={15} color={c.working} />, "连接中")}
            {row(<PlugGlyph size={15} color={c.faint} />, "未连接 · 点击可连接")}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// #46 连接状态图标（用户定稿素材：线缆+插头体+两插脚，描边风）。三态由调用方
// 染色：绿=已连接 / 灰=未连接（可点触发连接）/ 黄+外层 opacity 闪烁=连接中
function PlugGlyph({ size = 13, color }: { size?: number; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: size * 0.72 }}>
      <View style={{ width: size * 0.42, height: 1.4, backgroundColor: color }} />
      <View style={{ width: size * 0.32, height: size * 0.72, borderWidth: 1.4, borderColor: color, borderRadius: 2.5 }} />
      <View style={{ marginLeft: -0.5, height: size * 0.72, justifyContent: "space-evenly", paddingVertical: size * 0.13 }}>
        <View style={{ width: size * 0.26, height: 1.4, backgroundColor: color }} />
        <View style={{ width: size * 0.26, height: 1.4, backgroundColor: color }} />
      </View>
    </View>
  );
}

// 连接中黄闪节拍（共享一个 loop，bridgeless 下 JS 驱动，低频 450ms 往返）
const plugBlink = new Animated.Value(1);
let plugBlinkStarted = false;
function ensurePlugBlink() {
  if (plugBlinkStarted) return;
  plugBlinkStarted = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(plugBlink, { toValue: 0.25, duration: 450, useNativeDriver: false }),
      Animated.timing(plugBlink, { toValue: 1, duration: 450, useNativeDriver: false }),
    ]),
  ).start();
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
  // 头部右上全局扫码钮：abClose 同形制（tintSoft 圆角方 + 细边框），角标式扫描图标
  scanBtn: {
    width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  // L6 四个段头统一走 secHead 行结构：可折叠段加 ▾/▸，配对/关于等纯段头只渲染
  // 同规格空占位（secToggle 形状）不渲染箭头——18/6 节奏与行高完全一致
  secHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16, marginBottom: 1 },
  // #51 标题左组：标题+问号同行靠左（原问号被 space-between 推中）
  secTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  secTitleT: { color: c.faint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  // #346 分区/行前缀小图标（与网页设置面板 gi 同语言）：色弱一档、字号小一档
  secIconT: { color: c.dim, fontSize: 10.5 },
  secToggle: { width: 24, height: 24, alignItems: "center", justifyContent: "center", marginVertical: -6 },
  secToggleT: { color: c.dim, fontSize: 11 },
  // #48 通道含义问号（连接区标题旁，点击弹解释）
  secHelpT: { color: c.dim, fontSize: 11, borderWidth: 1, borderColor: withA(c.dim, 0.4), borderRadius: 8, width: 16, height: 16, textAlign: "center", lineHeight: 14, overflow: "hidden" },
  srvScroll: { maxHeight: 236 },
  srvRow: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.line,
    borderRadius: 12, backgroundColor: c.panel, marginBottom: 8, overflow: "hidden",
  },
  srvRowOn: { borderColor: withA(c.done, 0.45), backgroundColor: withA(c.done, 0.08) },
  srvMain: { flex: 1, paddingVertical: 9, paddingLeft: 11, paddingRight: 4 },
  // #51 行头：名称占满剩余空间（flex:1）——通道标记+插头图标恒右对齐（原 flexShrink
  // 随名称长短漂移：短名靠左长名靠右不齐）；图标间距收小 6→4
  srvHead: { flexDirection: "row", alignItems: "center", gap: 4 },
  srvDot: { width: 7, height: 7, borderRadius: 4 },
  srvName: { color: c.text, fontSize: 13.5, fontWeight: "600", flex: 1 },
  srvUrl: { color: c.faint, fontSize: 10.5, marginTop: 1.5 },
  // #46/#53 通道标记：☁️ emoji 与 LanGlyph 胶囊两态
  chanCloudT: { fontSize: 10.5, lineHeight: 14 },
  // #96 返工（用户几何定稿）：角标垂直中线=插头底边、水平在插头右缘之外（不重叠）。
  // 插头 13px 在 wrap(18x16) 居中：右缘 x≈15.5 / 底 y≈14.5 → 角标 left 17 起、
  // top = 14.5 − 行高/2（云 9/2 → 10；LAN 8/2 → 10.5）
  plugWrap: { position: "relative", width: 18, height: 16, alignItems: "center", justifyContent: "center" },
  plugBadgeCloud: { position: "absolute", left: 17, top: 10, fontSize: 7.5, lineHeight: 9 },
  plugBadgeLan: { position: "absolute", left: 17, top: 10.5, fontSize: 6.5, lineHeight: 8, color: "#5B9DFF", fontWeight: "700", letterSpacing: 0.2 },
  // #53 图例弹窗：图标列固定宽左对齐 + 文字；组间距（legSep）大于行距
  legHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  legHeadT: { color: c.text, fontSize: 15, fontWeight: "700" },
  legCloseT: { color: c.dim, fontSize: 15 },
  legRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 9 },
  legIcon: { width: 30, alignItems: "center", justifyContent: "center" },
  legT: { color: c.text, fontSize: 13.5, flex: 1 },
  legSep: { height: 14 },
  srvEdit: { width: 34, height: 42, alignItems: "center", justifyContent: "center" },
  srvEditT: { color: c.dim, fontSize: 13.5 },
  // #46 长按亮出的删除按钮（替常驻 ✕）
  srvDelArm: { paddingHorizontal: 10, height: 42, alignItems: "center", justifyContent: "center" },
  srvDelArmT: { color: c.waiting, fontSize: 12.5, fontWeight: "700" },
  // L6 手动添加→配对空档收紧：原 10(padBottom)+8(wrap margin)+18(secHead margin)
  // 尾距 ≈36dp、加 8+10 头距整段空 ≈72dp 显空。改 6+0 后尾距 24dp、头距 14dp，
  // 与段间 18dp 节奏衔接（tap 面积由 hitSlop 6 补回）
  addRowWrap: { flexDirection: "row", justifyContent: "flex-end" },
  // #378 去框化二期：添加入口纯文字链接式；#46 移右下角（原居中）
  addRow: {
    alignItems: "center", justifyContent: "center", paddingVertical: 6, paddingHorizontal: 8,
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
  // #92 重做：配对码容器化（#378 裸平铺在窄抽屉里漂浮感强、下方空档大）——
  // 同款卡片语言（面板底+描边+圆角），padding 收紧段内垂直节奏
  pairBox: {
    paddingVertical: 8, paddingHorizontal: 12, marginBottom: 2,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 12,
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
  // #353 拨杆：胶囊轨道 + 浮起滑块（阴影），标签盖在轨道上层。
  // #37 同行缩小版：24 高（原 34），拨杆随行尾布局（setRow 已有 space-between）
  leverTrack: {
    flexDirection: "row", height: 24, borderRadius: 12,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  leverThumb: {
    position: "absolute", top: 2, left: 0, bottom: 2, borderRadius: 10,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: withA(c.brandA, 0.4),
    // 勿加 elevation：Android 上 elevation 压过后续兄弟的 zIndex，会把选中档
    // 标签整个盖住（标签须渲染在滑块上层，靠 JSX 顺序即可）
  },
  leverOpt: { flex: 1, alignItems: "center", justifyContent: "center", zIndex: 1 },
  leverT: { color: c.dim, fontSize: 11 },
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
