import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Animated, Easing, FlatList, PanResponder, Pressable, RefreshControl, StyleSheet, Text, Vibration, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { statusColor, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { LogoMark } from "../brand";
import { sessionElapsed, fmtElapsed, fmtTok, contextPct, contextLevel, CONTEXT_LIMIT_FALLBACK, displaySrcName } from "../fmt";
import { setListDensity, useListDensity, setAggregate as persistAggregate, type ListDensity } from "../display-settings";
import { store, useRelay } from "../store";
import { FadeIn, PressScale } from "../motion";
import type { SessionState } from "../protocol";
import RenameModal from "./RenameModal";
import SettingsDrawer from "./SettingsDrawer";

// 硬件返回句柄（#282）：返回键收敛为 App.tsx 顶层单订阅统一分发，抽屉/图例浮层
// 是否开着只有本组件知道——经 ref 暴露 requestBack 供父级分发时调用
export interface ListBackHandle {
  requestBack: () => boolean; // 关掉一个开着的浮层返回 true；无可关返回 false
}

interface Props {
  sessions: SessionState[];
  connected: boolean;
  connText: string;
  onOpen: (sid: string) => void; // 待确认悬浮清单（#306）的直达跳转由 App.tsx 层直接走 openDetail(sid, "todos")
  onNew: () => void;
  onSetup: () => void;
  onScanServer: () => void; // 抽屉「扫码添加」（#276）：开设置页直接拉起扫码
  onEditServer: (id: string) => void;
  ref?: Ref<ListBackHandle>;
}

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

// 沉寂会话判定（列表降噪）：DONE 且最近更新不在今天——名称色降一档，
// 让活跃/当日会话在长列表中先跳出来；详情页信息不受影响
function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// 源配色（#294 批2 + 审查修复，信息层级重设计后由源分组头沿用）：色板/哈希与
// 网页端 SRC_COLORS/srcColor 逐字节对齐；哈希键用跨端稳定身份（store
// SourceStatus.colorKey：云源 relay 设备 id、LAN 源 wsUrl），同一台服务器在两端
// 取到同色——本地 uuid 两端各异不可用
const SRC_COLORS = ["#D97757", "#5B9DFF", "#2BD98F", "#FFC53D", "#C792EA", "#F06292", "#4DD0E1", "#7E57C2"];
function srcColor(id: string): string {
  let h = 0;
  for (const ch of String(id)) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  return SRC_COLORS[h % SRC_COLORS.length];
}

// 列表密度三档循环胶囊（统计行，原抽屉「列表布局」拨杆迁入）：标准→紧凑→极简→标准；
// 存储仍走 display-settings（cc.display.listCompact 三档不动），仅入口换位置
const DENSITY_ORDER: ListDensity[] = ["std", "compact", "minimal"];
const DENSITY_LABEL: Record<ListDensity, string> = { std: "标准", compact: "紧凑", minimal: "极简" };

// 源分组头（信息层级重设计）：聚合多源时列表按源分区——源色竖条 + 源名 + 在线
// 状态点 + 会话计数，下衬 hairline（对齐设置页「标记+标题+细线」的分区语言）；
// 组内卡不再逐卡带源角标（分组头已交代归属，避免重复）。取代 #294 批2 逐卡角标。
// memo：props 全原始值，快照刷新重建行包装对象时属性未变的组头不重渲
const GroupHeader = memo(function GroupHeader({ name, color, online, count }: {
  name: string;
  color: string;
  online: boolean;
  count: number;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  return (
    <View
      style={styles.grpHead}
      accessibilityLabel={`${name}，${online ? "在线" : "离线"}，${count} 个会话`}
    >
      <View style={[styles.grpBar, { backgroundColor: color }]} />
      <Text style={styles.grpName} numberOfLines={1}>{name}</Text>
      <View style={[styles.grpDot, { backgroundColor: online ? c.done : withA(c.dim, 0.45) }]} />
      <View style={{ flex: 1 }} />
      <Text style={styles.grpCount}>{count} 会话</Text>
    </View>
  );
});

// 新增会话 ＋：圆头细条十字，与品牌星芒同线条语言
function PlusMark({ size = 20, color = "#D97757" }: { size?: number; color?: string }) {
  const w = 2.8;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: "absolute", width: w, height: size, left: (size - w) / 2, borderRadius: w / 2, backgroundColor: color }} />
      <View style={{ position: "absolute", height: w, width: size, top: (size - w) / 2, borderRadius: w / 2, backgroundColor: color }} />
    </View>
  );
}

const ACT_W = 78;    // 单个操作按钮宽
const FULL_W = 156;  // 操作面板总宽（重命名 + 删除）

// 列表行模型（信息层级重设计）：聚合多源时插源分组头行，会话行原样引用
// SessionState 对象（分组/包装不改写会话，行级 memo 依赖引用不变）
type ListRow =
  | { h: true; key: string; name: string; color: string; online: boolean; count: number }
  | { h: false; key: string; s: SessionState };

// cc light 风格：运行中黄灯呼吸（亮度+缩放联动，2.4s 一拍，对齐网页端呼吸灯）
// #77 返工（用户反馈「对齐桌面端」）：太阳补齐 8 向射线（桌面 sun 图形是圆+八方
// 射线，此前只有四向不像）；形制改裸图标（去底色块，见 themeBtn 样式）。深色显
// 太阳（点击切浅）、浅色显月牙；月牙=描边圆+偏移实心圆（按钮底色遮出弯月），
// 全 View 绘制（项目无 svg 库），1.4px 描边与插头/云/电脑图标同语言
// #80 连接 chip 电脑图标：桌面端 DESK_SVG 同款（16x13 viewBox，rect+底座横线），
// View 绘制 1.4 描边，颜色随连接态（绿/黄/红）
function DeskGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 14, height: 12, marginRight: 4 }}>
      <View style={{ position: "absolute", left: 1.2, top: 0.8, width: 11.6, height: 8, borderRadius: 1.6, borderWidth: 1.4, borderColor: color }} />
      <View style={{ position: "absolute", left: 5, top: 10, width: 4, height: 1.4, borderRadius: 0.7, backgroundColor: color }} />
    </View>
  );
}

function ThemeGlyph({ dark }: { dark: boolean }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  if (dark) {
    return (
      <View style={styles.tgWrap}>
        <View style={[styles.tgSun, { borderColor: c.dim }]} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((r) => (
          <View
            key={r}
            style={{
              position: "absolute", width: 1.4, height: 3.5,
              left: 16 / 2 - 0.7, top: 0.5, backgroundColor: c.dim,
              transform: [{ rotate: `${r}deg` }, { translateY: -6.2 }],
            }}
          />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.tgWrap}>
      <View style={[styles.tgMoon, { borderColor: c.dim }]} />
      {/* #77 裸图标形制后按钮无底色，遮罩圆改用页面底色（c.bg）才隐形遮出弯月 */}
      <View style={[styles.tgMoonMask, { backgroundColor: c.bg }]} />
    </View>
  );
}

function BlinkDot({ color }: { color: string }) {
  const op = useRef(new Animated.Value(1)).current;
  const sc = useRef(new Animated.Value(1)).current;
  const styles = useThemeStyles(makeStyles);
  useEffect(() => {
    const ease = Easing.inOut(Easing.quad);
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(op, { toValue: 0.45, duration: 1200, easing: ease, useNativeDriver: true }),
          Animated.timing(op, { toValue: 1, duration: 1200, easing: ease, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(sc, { toValue: 0.8, duration: 1200, easing: ease, useNativeDriver: true }),
          Animated.timing(sc, { toValue: 1, duration: 1200, easing: ease, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op, sc]);
  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: color, opacity: op, transform: [{ scale: sc }] }]}
    />
  );
}

// 黄灯旁的实时工作状态：回合耗时 · ↓输出tokens · 当前动作（每秒走秒）；
// #363 压缩中：⟳ 明示（CLI "Compacting conversation..."），不显示旧摘要防误判卡死
function LiveStat({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - (s.turn_started_at ?? s.updated_at)) / 1000));
  const tok = s.usage?.output_tokens ?? 0;
  const head = (s.compacting ? "⟳ 压缩上下文 · " : "") + (tok > 0 ? `${secs}s · ↓ ${fmtTok(tok)}` : `${secs}s`);
  return (
    <Text style={styles.liveStat} numberOfLines={1}>
      <Text style={{ color: c.working }}>{head}</Text>
      {s.action_summary && !s.compacting ? ` · ${s.action_summary}` : ""}
    </Text>
  );
}

// 会话耗时：WORKING 时自带每秒 tick（简洁模式没有 LiveStat，耗时也要走秒）
function Elapsed({ s }: { s: SessionState }) {
  const styles = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  const live = s.status === "WORKING";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  return <Text style={styles.elapsed}>{fmtElapsed(sessionElapsed(s))}</Text>;
}

// 左滑露出操作面板（重命名 + 删除；DONE/ERROR 才可删）。
// 面板做成独立圆角小胶囊（上下留 3px），从卡片后面滑出，避免直角贴圆角的接缝。
// minimal（极简单行卡）：面板只留图标不出文字标签（行高太矮叠不下两行字）
function SwipeRow({
  sid, deletable, onPress, onRename, onDelete, revealSid, onReveal, compact, minimal, dim, children,
}: {
  sid: string;
  deletable: boolean;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  compact?: boolean;
  minimal?: boolean;
  dim?: boolean; // #32 离线源降权（缓存会话与在线视觉区分）
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const close = () => {
    open.current = false;
    onReveal(null);
    Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
  };
  // 同时只保留一行展开
  useEffect(() => {
    if (open.current && revealSid !== null && revealSid !== sid) {
      open.current = false;
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    }
  }, [revealSid]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dy) < 12,
      onPanResponderMove: (_, g) => {
        const base = open.current ? -FULL_W : 0;
        x.setValue(Math.min(0, Math.max(-FULL_W - 36, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        // 已展开：明显右移或右甩即收起；未展开：左移过半或左甩即展开
        const shouldOpen = open.current ? !(g.dx > 24 || g.vx > 0.3) : g.dx < -ACT_W / 2 || g.vx < -0.5;
        open.current = shouldOpen;
        onReveal(shouldOpen ? sid : null);
        Animated.spring(x, { toValue: shouldOpen ? -FULL_W : 0, useNativeDriver: true, bounciness: 5, speed: 18 }).start();
      },
      onPanResponderTerminate: () => {
        open.current = false;
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;
  return (
    <View style={[styles.swipeWrap, compact && styles.swipeWrapC, minimal && styles.swipeWrapM]}>
      <View style={[styles.actPanel, minimal && styles.actPanelM]}>
        <Pressable
          style={[styles.actBtn, styles.actRen]}
          android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }}
          onPress={() => {
            onRename();
            close();
          }}
        >
          <Text style={styles.actT}>✎</Text>
          {!minimal ? <Text style={styles.actT2}>重命名</Text> : null}
        </Pressable>
        <Pressable
          style={[styles.actBtn, !deletable && styles.actOff]}
          android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }}
          onPress={() => {
            if (deletable) onDelete();
            close();
          }}
        >
          <Text style={styles.actT}>✕</Text>
          {!minimal ? <Text style={styles.actT2}>{deletable ? "删除" : "运行中"}</Text> : null}
        </Pressable>
      </View>
      <Animated.View style={[styles.swipeCard, { transform: [{ translateX: x }] }, dim && styles.dimRow]} {...pan.panHandlers}>
        <Pressable
          style={[styles.card, compact && styles.cardC, minimal && styles.cardM, dim && styles.dimRow]}
          android_ripple={{ color: c.tintSoft, borderless: false }}
          onPress={() => {
            if (open.current) close();
            else onPress();
          }}
        >
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}

// 删除撤销浮条（#247）：入场 spring 上滑、退场 fade 下滑（对齐 App.tsx Toast 动效语言）；
// shown=false 先播退场再卸载。标题预截断——numberOfLines 省略号会吃掉收尾引号
function UndoBar({ shown, title, onUndo }: { shown: boolean; title: string; onUndo: () => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [live, setLive] = useState(shown);
  const op = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(10)).current;
  useEffect(() => {
    if (shown) {
      setLive(true);
      op.setValue(0);
      y.setValue(10);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, useNativeDriver: true, speed: 30, bounciness: 6 }),
        Animated.timing(op, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]).start();
    } else if (live) {
      Animated.parallel([
        Animated.timing(op, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.timing(y, { toValue: 10, duration: 140, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setLive(false);
      });
    }
  }, [shown]);
  if (!live) return null;
  const t = title.length > 16 ? `${title.slice(0, 16)}…` : title;
  return (
    <Animated.View style={[styles.undoBar, { bottom: insets.bottom + 92, opacity: op, transform: [{ translateY: y }] }]}>
      <Text style={styles.undoT} numberOfLines={1}>{t ? `已删除「${t}」` : "已删除会话"}</Text>
      <Pressable
        style={styles.undoBtn}
        android_ripple={{ color: c.tintSoft, borderless: false, radius: 8 }}
        onPress={onUndo}
        hitSlop={8}
      >
        <Text style={styles.undoBtnT}>撤销</Text>
      </Pressable>
    </Animated.View>
  );
}

// 上下文占用 mini 指示：30px 微型条 + 百分比（与详情页头部 ctx 行、网页端同口径同分级）
function CtxMini({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const used = s.context_usage ?? 0;
  if (!used) return null;
  const limit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const pct = contextPct(used, limit);
  const lv = contextLevel(used, limit);
  return (
    <View style={styles.ctxMini}>
      <View style={styles.ctxMiniBar}>
        <View style={{ width: `${pct}%`, height: 3, borderRadius: 1.5, backgroundColor: c[lv] }} />
      </View>
      <Text style={[styles.ctxMiniT, { color: c[lv] }]}>{pct}%</Text>
    </View>
  );
}

// 上下文水位区（极简行专用，常显）：右端固定 64px 区 = 3px 细条（宽按水位比例、
// contextLevel 分级色）+ 下方 9px tabular 百分比；无数据出灰色 "–" 占位——右缘不空缺不跳位
function CtxCell({ s }: { s: SessionState }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const used = s.context_usage ?? 0;
  const has = used > 0;
  const limit = s.context_limit ?? CONTEXT_LIMIT_FALLBACK;
  const pct = contextPct(used, limit);
  const lv = contextLevel(used, limit);
  return (
    <View style={styles.ctxCell}>
      <View style={styles.ctxCellBar}>
        {has ? <View style={{ width: `${pct}%`, height: 3, borderRadius: 1.5, backgroundColor: c[lv] }} /> : null}
      </View>
      <Text style={[styles.ctxCellT, has && { color: c[lv] }]}>{has ? `${pct}%` : "–"}</Text>
    </View>
  );
}

// memo：流式刷新只重渲变化的那一行（onRename/onReveal/onDelete 均为稳定引用；
// 源归属改由分组头承担，卡片不再带源角标 props——会话对象引用不变即不重渲）
// #59 聚合源归属角标：源身份色点+源名（各密度档通用，行内右端）
function SrcBadge({ name, color }: { name: string; color: string }) {
  const styles = useThemeStyles(makeStyles);
  return (
    <View style={styles.srcBadge}>
      <View style={[styles.srcBadgeDot, { backgroundColor: color }]} />
      <Text style={styles.srcBadgeT} numberOfLines={1}>{name}</Text>
    </View>
  );
}

const SessionCard = memo(function SessionCard({
  s, onOpen, onRename, onDelete, revealSid, onReveal, density, dim, srcBadge,
}: {
  s: SessionState;
  onOpen: (sid: string) => void;
  onRename: (sid: string) => void;
  onDelete: (sid: string) => void;
  revealSid: string | null;
  onReveal: (v: string | null) => void;
  density: ListDensity;
  dim?: boolean; // #32 离线源降权
  srcBadge?: { name: string; color: string } | null; // #59 聚合模式源归属角标
}) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const compact = density === "compact";
  const minimal = density === "minimal";
  const color = statusColor(s.status, c);
  const deletable = s.status === "DONE" || s.status === "ERROR";
  // 沉寂会话（DONE 且非今日更新）：名称色降一档，长列表里让位给活跃会话
  const idle = s.status === "DONE" && !isSameDay(s.updated_at ?? s.started_at, Date.now());
  return (
    <SwipeRow
      sid={s.session_id}
      deletable={deletable}
      onPress={() => onOpen(s.session_id)}
      onRename={() => onRename(s.session_id)}
      onDelete={() => onDelete(s.session_id)}
      revealSid={revealSid}
      onReveal={onReveal}
      compact={compact}
      minimal={minimal}
      dim={dim}
    >
      {minimal ? (
        // 极简行：状态灯 + 名称（单行）+ 右端常显水位区（细条+百分比，无数据 "–" 占位），
        // 其余全部隐藏；行间分隔由 swipeWrapM 的极淡 hairline 承担（平铺行，不再堆卡间距）；
        // 点击/左滑交互与其他档一致
        <View style={styles.rowM}>
          {s.status === "WORKING" ? (
            <BlinkDot color={color} />
          ) : (
            <View style={[styles.dot, { backgroundColor: color }]} />
          )}
          <Text style={[styles.titleM, idle && styles.titleIdle]} numberOfLines={1}>
            {s.title || "未命名会话"}
          </Text>
          <View style={{ flex: 1 }} />
          {srcBadge ? <SrcBadge {...srcBadge} /> : null}
          <CtxCell s={s} />
        </View>
      ) : compact ? (
        // 紧凑卡：状态点+标题+时长一行、动作摘要一行、目录/改动/水位一行——省高度但不丢信息
        <>
          <View style={styles.rowC}>
            {s.status === "WORKING" ? (
              <BlinkDot color={color} />
            ) : (
              <View style={[styles.dot, { backgroundColor: color }]} />
            )}
            <Text style={[styles.titleC, idle && styles.titleIdle]} numberOfLines={1}>{s.title || "未命名会话"}</Text>
            <View style={{ flex: 1 }} />
            {srcBadge ? <SrcBadge {...srcBadge} /> : null}
            <Elapsed s={s} />
          </View>
          <Text style={styles.sumC} numberOfLines={1}>{s.action_summary || "…"}</Text>
          <View style={styles.footC}>
            {s.cwd ? <Text style={styles.folderC} numberOfLines={1}>📁 {folderOf(s.cwd)}</Text> : null}
            <View style={{ flex: 1 }} />
            {s.stats && s.stats.files_changed > 0 ? (
              <Text style={styles.statsC}>
                <Text style={{ color: c.working }}>+{s.stats.lines_added}</Text>
                {" "}
                <Text style={{ color: c.error }}>-{s.stats.lines_deleted}</Text>
              </Text>
            ) : null}
            <CtxMini s={s} />
          </View>
        </>
      ) : (
        <>
          {/* #362 标题恒第一行（灯+名称+时长）：WORKING/空闲同构，状态切换不跳行；
              工作实时行/摘要 occupy 第二行可变位 */}
          <View style={styles.titleRow}>
            {s.status === "WORKING" ? (
              <BlinkDot color={color} />
            ) : (
              <View style={[styles.dot, { backgroundColor: color }]} />
            )}
            <Text style={[styles.title, idle && styles.titleIdle]} numberOfLines={1}>
              {s.title || "未命名会话"}
            </Text>
            <View style={{ flex: 1 }} />
            {srcBadge ? <SrcBadge {...srcBadge} /> : null}
            <Elapsed s={s} />
          </View>
          {s.status === "WORKING" ? (
            <View style={styles.liveRow}>
              <LiveStat s={s} />
            </View>
          ) : (
            <Text style={styles.sum} numberOfLines={1}>{s.action_summary || "…"}</Text>
          )}
          {/* 次要信息合并行（降噪）：托管/外部 · 目录 · 历史 一行小字（原 tag 胶囊 +
              目录/历史分散多段 → 单段 faint 尾截断），右侧 ±行数(降一档)与 ctx 水位 */}
          <View style={styles.foot}>
            <Text style={styles.meta} numberOfLines={1}>
              {s.external ? "外部 CLI" : "托管"}
              {s.cwd ? ` · 📁 ${folderOf(s.cwd)}` : ""}
              {s.historical && !s.external ? " · 历史" : ""}
            </Text>
            <View style={{ flex: 1 }} />
            {s.stats && s.stats.files_changed > 0 ? (
              <Text style={styles.stats}>
                <Text style={{ color: c.working }}>+{s.stats.lines_added}</Text>
                {" "}
                <Text style={{ color: c.error }}>-{s.stats.lines_deleted}</Text>
              </Text>
            ) : null}
            <CtxMini s={s} />
          </View>
        </>
      )}
    </SwipeRow>
  );
});

export default function ListScreen({ sessions, connected, connText, onOpen, onNew, onSetup, onScanServer, onEditServer, ref }: Props) {
  const { c } = useTheme();
  const { mode, toggle } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const snap = useRelay();
  const density = useListDensity();
  // 布局循环切换（统计行胶囊）：标准→紧凑→极简→标准，点击即写回 display-settings
  const cycleDensity = useCallback(() => {
    const i = DENSITY_ORDER.indexOf(density);
    setListDensity(DENSITY_ORDER[(i + 1) % DENSITY_ORDER.length]);
  }, [density]);
  // #52 聚合胶囊开关：与设置抽屉拨杆同款双写（持久化 + store 生效）
  const toggleAggregate = useCallback(() => {
    const next = !snap.aggregate;
    persistAggregate(next);
    store.setAggregate(next);
  }, [snap.aggregate]);
  const [revealSid, setRevealSid] = useState<string | null>(null);
  const [renameSid, setRenameSid] = useState<string | null>(null);
  const renameTarget = useMemo(
    () => sessions.find((s) => s.session_id === renameSid) ?? null,
    [sessions, renameSid],
  );
  const handleRename = useCallback((sid: string) => setRenameSid(sid), []);

  // 删除撤销（#247）：点删除只隐藏卡片 + 浮撤销条，4s 内可撤（纯客户端延迟提交），
  // 超时才真正发 COMMAND_DELETE——误触不丢会话。两次快速删除时前一条立即提交
  const [pendingDel, setPendingDel] = useState<string | null>(null);
  const pendingDelSid = useRef<string | null>(null);
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 离开列表页（进详情/设置）时挂起的删除视为确认：立即提交，静默丢弃反而反直觉
  useEffect(() => () => {
    if (delTimer.current) clearTimeout(delTimer.current);
    const cur = pendingDelSid.current;
    if (cur) store.send("COMMAND_DELETE", { session_id: cur });
  }, []);
  // 已提交待服务器确认的 sid：保持隐藏到 SESSION_DELETED 生效，防提交瞬间闪回；
  // 3s 兜底出列（发送失败/ACK 异常时卡片要能回来，错误提示由全局 Toast 负责）
  const [deleting, setDeleting] = useState<string[]>([]);
  const commitDelete = useCallback((sid: string) => {
    setDeleting((l) => (l.includes(sid) ? l : [...l, sid]));
    store.send("COMMAND_DELETE", { session_id: sid });
    setTimeout(() => setDeleting((l) => l.filter((x) => x !== sid)), 3000);
  }, []);
  // 服务器侧会话消失时：已提交项出列；挂起中的删除被别处删除终结——免得超时后
  // 对已不存在的会话发命令，弹"会话不存在"误报
  useEffect(() => {
    if (pendingDel && !sessions.some((s) => s.session_id === pendingDel)) {
      if (delTimer.current) {
        clearTimeout(delTimer.current);
        delTimer.current = null;
      }
      pendingDelSid.current = null;
      setPendingDel(null);
    }
    if (deleting.length) {
      const next = deleting.filter((sid) => sessions.some((s) => s.session_id === sid));
      if (next.length !== deleting.length) setDeleting(next);
    }
  }, [sessions, pendingDel, deleting]);
  const requestDelete = useCallback((sid: string) => {
    try { Vibration.vibrate(20); } catch {}
    if (delTimer.current) {
      clearTimeout(delTimer.current);
      delTimer.current = null;
      const prev = pendingDelSid.current;
      if (prev && prev !== sid) commitDelete(prev);
    }
    pendingDelSid.current = sid;
    setPendingDel(sid);
    delTimer.current = setTimeout(() => {
      delTimer.current = null;
      const cur = pendingDelSid.current;
      pendingDelSid.current = null;
      setPendingDel(null);
      if (cur) commitDelete(cur);
    }, 4000);
  }, [commitDelete]);
  const undoDelete = useCallback(() => {
    if (delTimer.current) {
      clearTimeout(delTimer.current);
      delTimer.current = null;
    }
    pendingDelSid.current = null;
    setPendingDel(null);
  }, []);
  const pendingTitle = useMemo(
    () => sessions.find((s) => s.session_id === pendingDel)?.title ?? "",
    [sessions, pendingDel],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 状态图例浮窗（统计行 ？ 呼出）
  const [legendOpen, setLegendOpen] = useState(false);
  // 顶栏品牌区副标题：当前连接的服务器名（多源场景区分不同来源）。
  // 抽屉关上时重读——切服务器不重挂载本页，副标题要跟着换
  const [activeName, setActiveName] = useState("");
  useEffect(() => {
    if (drawerOpen) return;
    void Promise.all([store.loadServers(), store.activeServerId()])
      .then(([list, id]) => {
        const active = list.find((e) => e.id === id) ?? list[0];
        setActiveName(active?.name?.trim() ?? "");
      })
      .catch(() => {});
  }, [drawerOpen]);

  // 硬件返回（#282）：抽屉/图例开着时先关浮层而不是退出 App（列表页是根路由）。
  // 原两处局部 BackHandler 订阅已并入 App.tsx 顶层单订阅，这里经 ref 句柄承接分发
  useImperativeHandle(ref, () => ({
    requestBack: () => {
      if (legendOpen) {
        setLegendOpen(false);
        return true;
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return true;
      }
      return false;
    },
  }), [drawerOpen, legendOpen]);

  // 左缘手势条：从屏幕左缘右滑呼出侧边栏（透明覆盖条，只认横向滑动，不拦点击/竖向滚动）
  const edgePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 14,
      onPanResponderRelease: (_, g) => {
        if (g.dx > 36 || g.vx > 0.35) setDrawerOpen(true);
      },
    }),
  ).current;
  const sorted = useMemo(() => {
    // 活跃（等待/运行/错误）置顶，其余按最近更新倒序：
    // 新完成的会话紧跟活跃段，不再"闪现后跳到 20 个会话底部"像消失。
    // #294 批2：聚合时 sessions 已是全源平铺，同一比较器作用于合并列表；
    // 分组态在下方 rows memo 里按 src 分区（组间按组内最近活动排序），组内沿用本排序
    const rank = (s: SessionState) =>
      s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR" ? 0 : 1;
    return [...sessions].sort(
      (a, b) => rank(a) - rank(b) || (b.updated_at ?? b.started_at) - (a.updated_at ?? a.started_at),
    );
  }, [sessions]);

  // 聚合多源 = 分组态（信息层级重设计：#294 批2 逐卡源角标改为分组头归属）；
  // 统计行「N 源聚合」/空态文案/顶栏副标题沿用同一开关
  const badgeOn = snap.aggregate && snap.sources.length > 1;
  // 聚合源在线数（#294 批4）：统计行「N 源聚合」与空态「online/total 源」共用
  const onlineSrcs = snap.sources.filter((x) => x.state === "online").length;
  // 唯一在线源（在线源=1 时列表平铺单源视图）：唯一在线源即"当前源"，顶栏副标题
  // 点名该源（「源：X」）替代「N 源聚合」概览——连接 chip 的「1/N 在线」仍交代聚合态
  const soloOnline = onlineSrcs === 1 ? snap.sources.find((x) => x.state === "online") ?? null : null;
  const soloName = soloOnline ? displaySrcName(soloOnline.name) : "";

  const counts: Record<string, number> = {};
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  const statusItems = (["WORKING", "WAITING", "ERROR", "DONE"] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ k, n: counts[k], color: statusColor(k, c) }));

  // #357 连接 chip 三态色（用户定）：已连接=绿 / 连接中·重连中=黄 / 连不上=红
  const connColor =
    connected || snap.connState === "online"
      ? c.done
      : snap.connState === "connecting" || snap.connState === "reconnecting"
        ? c.working
        : c.waiting;

  const [collapseIdle, setCollapseIdle] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("ccr_collapse_idle").then((v) => setCollapseIdle(v === "1"));
  }, []);
  const toggleCollapse = () => {
    setCollapseIdle((v) => {
      void AsyncStorage.setItem("ccr_collapse_idle", v ? "0" : "1");
      return !v;
    });
  };
  const idleCount = counts["DONE"] ?? 0;
  const visible = useMemo(
    () => (collapseIdle ? sorted.filter((s) => s.status !== "DONE") : sorted)
      .filter((s) => s.session_id !== pendingDel && !deleting.includes(s.session_id)),
    [sorted, collapseIdle, pendingDel, deleting],
  );

  // 分组态行模型：按源分区渲染（组头：源色条+源名+在线点+计数 → 组内会话卡）；
  // 组序按组内最近活动倒序，组内保持全局排序（活跃置顶+更新倒序）。非分组态
  // （单源/聚合单源）原样平铺，渲染不变。行包装对象每快照重建无妨——会话对象
  // 引用原样透传，SessionCard memo 的行级重渲不受影响；映射在 memo 内构建，
  // 依赖稳定（snap.sources 快照粒度变化）
  const rows = useMemo<ListRow[]>(() => {
    // 聚合开启但视图本质是单源时平铺渲染，不再渲染与内容冗余的源组头：
    // 1) 可见内容全来自单一源（如源筛选后只剩一家，对齐网页端 #26 源徽章隐藏逻辑）
    // 2) 在线源数=1（其余源离线）——唯一在线源即"当前源"，顶栏副标题已点名（「源：X」），
    //    再按源分区（含离线源缓存残组）对逐卡标注冗余
    const grouped = badgeOn && onlineSrcs > 1 && new Set(visible.map((s) => s.src ?? "")).size > 1;
    if (!grouped) return visible.map((s) => ({ h: false as const, key: s.session_id, s }));
    // 源跨端配色键（#294 审查修复）：同屏配色去重——按 colorKey 稳定排序分配调色板
    // 序号（哈希法双源 1/8 撞色，实测 PC/Mac 同紫）
    const sortedSrcs = [...snap.sources].sort((a, b) => (a.colorKey ?? a.id).localeCompare(b.colorKey ?? b.id));
    const nameOf = new Map(snap.sources.map((x) => [x.id, displaySrcName(x.name)] as const));
    const colorOf = new Map(sortedSrcs.map((x, i) => [x.id, SRC_COLORS[i % SRC_COLORS.length]] as const));
    const onlineOf = new Map(snap.sources.map((x) => [x.id, x.state === "online"] as const));
    const buckets = new Map<string, SessionState[]>();
    for (const s of visible) {
      const k = s.src ?? "";
      const b = buckets.get(k);
      if (b) b.push(s);
      else buckets.set(k, [s]);
    }
    // 组序 = 组内最近活动（活跃源在上，与列表全局"最近优先"同原则）
    const lastTs = (s: SessionState) => s.updated_at ?? s.started_at;
    const order = [...buckets.entries()].sort(
      (a, b) => Math.max(...b[1].map(lastTs)) - Math.max(...a[1].map(lastTs)),
    );
    const out: ListRow[] = [];
    for (const [src, list] of order) {
      // src 不在源表（源已移除但会话还在快照里）：兜底"其他"+哈希色
      out.push({
        h: true,
        key: `src:${src || "unknown"}`,
        name: nameOf.get(src) ?? "其他",
        color: colorOf.get(src) ?? srcColor(src),
        online: onlineOf.get(src) ?? false,
        count: list.length,
      });
      for (const s of list) out.push({ h: false, key: s.session_id, s });
    }
    return out;
  }, [badgeOn, visible, snap.sources, onlineSrcs]);

  // #59 逐卡源归属角标（用户点单：聚合模式卡片要能分辨哪台电脑）：聚合开启即恒显
  // （分组头只在多在线源时出现——单源在线/离线源缓存混排时卡片曾全裸奔）；
  // 配色与分组头同调色板，同屏稳定
  const srcBadgeMap = useMemo(() => {
    if (!badgeOn) return null;
    const sortedSrcs = [...snap.sources].sort((a, b) => (a.colorKey ?? a.id).localeCompare(b.colorKey ?? b.id));
    const nameOf = new Map(snap.sources.map((x) => [x.id, displaySrcName(x.name)] as const));
    const colorOf = new Map(sortedSrcs.map((x, i) => [x.id, SRC_COLORS[i % SRC_COLORS.length]] as const));
    return (src: string | undefined): { name: string; color: string } | null => {
      if (!src) return null;
      return { name: nameOf.get(src) ?? "其他", color: colorOf.get(src) ?? srcColor(src) };
    };
  }, [badgeOn, snap.sources]);
  const srcBadgeOf = srcBadgeMap ?? (() => null);

  // 下拉刷新 = 断开重连一次（重走快照），在线即收起转圈；3s 兜底
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (refreshing && snap.connState === "online") setRefreshing(false);
  }, [refreshing, snap.connState]);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    store.disconnect();
    store.connect();
    setTimeout(() => setRefreshing(false), 3000);
  };
  // 底部上拉刷新（#255）：滚到底即触发同一 refresh；冷却 8s 防连续滚动反复重连。
  // 列表上方堆满已完成会话时免滚回顶部下拉。
  // 守卫：onEndReached 在内容不满一屏时挂载即触发、用户停在底部时流式重渲也会反复触发
  // ——「拖拽装弹」：只有真实拖过一次列表，onEndReached 才允许消费一次触发（防止
  // 打开列表就断链重连、清掉在途命令 ACK 追踪）
  const lastFootRefresh = useRef(0);
  const scrollArmed = useRef(false);
  const footRefresh = () => {
    if (!scrollArmed.current) return;
    scrollArmed.current = false;
    if (refreshing || Date.now() - lastFootRefresh.current < 8000) return;
    lastFootRefresh.current = Date.now();
    refresh();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.topbar}>
        <Pressable
          style={styles.logoBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
          onPress={() => setDrawerOpen(true)}
          hitSlop={6}
        >
          <View style={styles.logo}>
            <LogoMark size={19} />
          </View>
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.titleT}>CC Deck</Text>
          {snap.aggregate && snap.sources.length > 1 ? (
            // #53 副标题与聚合胶囊去重：数量/聚合态信息归统计行胶囊独占，副标题
            // 统一点名当前活动源（命令默认去向）；无活动源时回退唯一在线源点名
            (activeName || soloName) ? (
              <Text style={styles.titleSub} numberOfLines={1}>{activeName || soloName}</Text>
            ) : null
          ) : activeName ? (
            <Text style={styles.titleSub} numberOfLines={1}>{activeName}</Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.connChip, { borderColor: withA(connColor, 0.33) }]}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
          hitSlop={6}
          accessibilityLabel={`连接状态 ${connText}，点击${snap.connState === "unpaired" ? "去设置重新配对" : "立即重连"}`}
          onPress={() => {
            // 三态分流：unpaired 是配对问题（重试无解），引导去设置重新配对；
            // 其余断连态点按 = 重置退避立即重试
            if (snap.connState === "unpaired") setDrawerOpen(true);
            else if (!connected) store.retryNow();
          }}
        >
          {/* #52 chip 精简：去状态色点与通道后缀（多源混合通道无法单一展示），
              文案颜色仍承载连接状态（绿/黄/红） */}
          {/* #80 统计前配电脑图标（桌面端同款），颜色随连接态 */}
          <DeskGlyph color={connColor} />
          <Text style={[styles.connText, { color: connColor }]}>{connText}</Text>
        </Pressable>
        {/* #350 主题切换从设置抽屉迁入主面板顶：连接 chip 旁，与状态信息同区 */}
        <Pressable
          style={styles.themeBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 13 }}
          hitSlop={4}
          accessibilityLabel={mode === "dark" ? "深色主题，点击切浅色" : "浅色主题，点击切深色"}
          onPress={toggle}
        >
          {/* #67漏项补：主题钮对齐桌面端——emoji → 线条 SVG（太阳/月牙 stroke 线稿，
              与 web THEME_ICONS 同款；深色显太阳=点击切浅、浅色显月牙） */}
          <ThemeGlyph dark={mode === "dark"} />
        </Pressable>
      </View>
      <View style={styles.statRow}>
        {/* #52 聚合胶囊（替代 #26 电脑图标）：开关与数量合一——聚合开=「聚合 · N」
            品牌色高亮可点切回；关=「单源」中性色。即当前面板展示范围的自述 */}
        <Pressable
          style={[styles.aggBtn, snap.aggregate && styles.aggBtnOn]}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 14 }}
          hitSlop={4}
          accessibilityLabel={snap.aggregate ? `聚合模式，展示 ${snap.sources.length} 台电脑，点击切回单源` : "单源模式，点击开启聚合"}
          onPress={toggleAggregate}
        >
          <Text style={[styles.aggT, snap.aggregate && styles.aggTOn]} numberOfLines={1}>
            {/* #80 去数量：右上角统计（x/n+电脑图标）已承载源数，聚合胶囊只报模式 */}
            {snap.aggregate ? "聚合" : "单源"}
          </Text>
        </Pressable>
        <View style={styles.statChips}>
          {statusItems.map(({ k, n, color }) => (
            <View key={k} style={styles.statChip}>
              <View style={[styles.statDot, { backgroundColor: color }]} />
              <Text style={[styles.statChipT, { color }]}>{n}</Text>
            </View>
          ))}
          {statusItems.length > 0 ? (
            <Pressable style={styles.helpBtn} onPress={() => setLegendOpen(true)} hitSlop={8}>
              <Text style={styles.helpT}>?</Text>
            </Pressable>
          ) : null}
        </View>
        {/* 布局三档循环胶囊（原抽屉「列表布局」拨杆迁入）：折叠空闲同款形制，随手切密度 */}
        <Pressable
          style={styles.densityBtn}
          android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
          onPress={cycleDensity}
          hitSlop={4}
          accessibilityLabel={`列表布局${DENSITY_LABEL[density]}，点击切换`}
        >
          <Text style={styles.densityT} numberOfLines={1}>{DENSITY_LABEL[density]}</Text>
        </Pressable>
        {idleCount > 0 ? (
          <Pressable
            style={[styles.collapseBtn, collapseIdle && styles.collapseBtnOn]}
            android_ripple={{ color: c.tintSoft, borderless: false, radius: 16 }}
            onPress={toggleCollapse}
          >
            <Text style={[styles.collapseT, collapseIdle && styles.collapseTOn]} numberOfLines={1}>
              {collapseIdle ? `展开空闲 ${idleCount}` : "折叠空闲 ▾"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        // 密度切换强制重挂载：行高在极简(~40px)↔标准(~90px)间剧变时，
        // VirtualizedList 复用旧 cell 的陈旧布局度量导致整列空白（#392 回归，
        // 冷启动正常、仅切换路径复现）。key 换代即整体重建，窗口/度量全新
        key={density}
        data={rows}
        keyExtractor={(r) => r.key}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={c.working}
            colors={[c.working]}
            progressBackgroundColor={c.panel}
          />
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 120, paddingHorizontal: 14, paddingTop: 6 }}
        onScrollBeginDrag={() => { scrollArmed.current = true; }}
        onEndReached={footRefresh}
        onEndReachedThreshold={0.2}
        ListFooterComponent={
          visible.length > 0 ? (
            <Pressable style={styles.footHint} disabled={refreshing} onPress={refresh} hitSlop={{ top: 10, bottom: 16 }}>
              <Text style={styles.footHintT}>{refreshing ? "刷新中…" : "↻ 下拉更新"}</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) =>
          item.h ? (
            <GroupHeader name={item.name} color={item.color} online={item.online} count={item.count} />
          ) : (
            <SessionCard
              s={item.s}
              onOpen={onOpen}
              onRename={handleRename}
              onDelete={requestDelete}
              revealSid={revealSid}
              onReveal={setRevealSid}
              density={density}
              srcBadge={srcBadgeOf(item.s.src)}
            />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyT}>{collapseIdle && idleCount > 0 ? "空闲会话已折叠" : "还没有会话"}</Text>
            <Text style={styles.emptyS}>
              {collapseIdle && idleCount > 0
                ? "点上方「展开空闲」查看"
                : !connected
                  ? snap.connState === "unpaired"
                    ? "配对已失效：点左上角图标打开设置\n在服务器列表中重新配对"
                    : badgeOn
                      ? `${onlineSrcs}/${snap.sources.length} 源在线，等待自动重连\n也可点左上角图标打开设置检查配置`
                      : "未连接服务器，等待自动重连\n也可点左上角图标打开设置检查配置"
                  : badgeOn
                    ? onlineSrcs < snap.sources.length
                      ? `已连接 ${onlineSrcs}/${snap.sources.length} 源\n可在设置中检查离线服务器`
                      : `已聚合 ${snap.sources.length} 源\n点右下角 ＋ 启动新会话`
                    : "点右下角 ＋ 启动新会话\n或在 PC 上打开 claude 接入外部会话"}
            </Text>
          </View>
        }
      />

      <View style={styles.edgeZone} {...edgePan.panHandlers} />

      <PressScale style={[styles.fab, { bottom: insets.bottom + 24 }]} ripple="rgba(255,255,255,0.18)" haptic onPress={onNew}>
        <View style={styles.fabGrad}>
          <PlusMark size={20} />
        </View>
      </PressScale>

      {/* 删除撤销条（#247）：4s 窗口，撤销即恢复卡片；抽屉/图例打开时收起（层级 60 之下防穿模） */}
      <UndoBar shown={!!pendingDel && !drawerOpen && !legendOpen} title={pendingTitle} onUndo={undoDelete} />

      <RenameModal
        visible={!!renameTarget}
        initial={renameTarget?.title ?? ""}
        onCancel={() => setRenameSid(null)}
        onSubmit={(title) => {
          if (renameTarget) store.send("COMMAND_RENAME", { session_id: renameTarget.session_id, title });
          setRenameSid(null);
        }}
      />

      <SettingsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSetup={onSetup}
        onScan={onScanServer}
        onEdit={(e) => onEditServer(e.id)}
      />

      {/* 状态图例浮窗：统计行 ？ 呼出，点任意处收起 */}
      {legendOpen ? (
        <Pressable style={styles.legendScrim} onPress={() => setLegendOpen(false)}>
          <FadeIn dy={5}>
            <View style={styles.legendCard}>
              {(["WORKING", "WAITING", "ERROR", "DONE"] as const).map((k) => (
                <View key={k} style={styles.legendRow}>
                  <View style={[styles.legendDot, { backgroundColor: statusColor(k, c) }]} />
                  <Text style={styles.legendT}>{k.toLowerCase()}</Text>
                </View>
              ))}
            </View>
          </FadeIn>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: c.line,
  },
  logoBtn: { borderRadius: 12 },
  logo: {
    width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
  // #381 去框化：连接 chip 纯"点+文字"，不套胶囊框（同抽屉去框语言）
  connChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    height: 28, paddingHorizontal: 4,
    marginLeft: "auto",
  },
  connDot: { width: 6, height: 6, borderRadius: 3 },
  connText: { fontSize: 11 },
  // #77 返工（用户反馈）：对齐桌面端裸图标形制——无底色无边框纯线条 glyph
  //（桌面 #themeBtn 无背景，hover 底是 web 特有交互；点击区 28 保留好按）
  themeBtn: {
    width: 28, height: 28, alignItems: "center", justifyContent: "center",
  },
  themeBtnT: { fontSize: 13 },
  // #67漏项补：线条太阳（View 圆环+四向射线，与插头/云同 1.4px 描边语言）
  tgWrap: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  tgSun: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.4 },
  // 线条月牙：描边圆 + 偏移实心圆（按钮底色 tintSoft 遮出弯月）
  tgMoon: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.4 },
  tgMoonMask: { position: "absolute", width: 10, height: 10, borderRadius: 5, left: 4.5, top: -2.5 },
  titleWrap: { flexShrink: 1, marginRight: "auto" },
  titleT: { color: c.text, fontSize: 16, fontWeight: "700", letterSpacing: 0.2 },
  titleSub: { color: c.faint, fontSize: 11, marginTop: 0.5 },
  statRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4,
  },
  statSrc: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  statTotal: { color: c.dim, fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  statChips: { flexDirection: "row", gap: 9 },
  statChip: { flexDirection: "row", alignItems: "center", gap: 3.5 },
  statDot: { width: 7, height: 7, borderRadius: 4 },
  statChipT: { fontSize: 11.5 },
  // ？ 图例按钮：淡色小圆圈问号
  helpBtn: {
    width: 15, height: 15, borderRadius: 8, borderWidth: 1, borderColor: c.line,
    alignItems: "center", justifyContent: "center", marginLeft: 2,
  },
  helpT: { fontSize: 10, color: c.faint, lineHeight: 12 },
  legendScrim: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.25)", zIndex: 60 },
  legendCard: {
    position: "absolute", top: 90, left: 18, minWidth: 128,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 14, gap: 8, elevation: 6,
  },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendT: { color: c.text, fontSize: 12.5 },
  // 源分组头：源色竖条+源名+在线点+会话计数，下衬 hairline 分区线（组间距 =
  // 头部上下留白 + 卡片自身 marginBottom，形成"区隔靠间距"的分区节奏）
  grpHead: {
    flexDirection: "row", alignItems: "center", gap: 7,
    marginTop: 10, marginBottom: 9, paddingBottom: 7,
    borderBottomWidth: 1, borderBottomColor: c.line,
  },
  grpBar: { width: 3, height: 13, borderRadius: 1.5 },
  grpName: { color: c.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.2, flexShrink: 1 },
  grpDot: { width: 6, height: 6, borderRadius: 3 },
  // #59 源归属角标：色点+源名小字（弱化色，行内右端、时长左侧）
  srcBadge: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, marginRight: 6 },
  srcBadgeDot: { width: 6, height: 6, borderRadius: 3 },
  srcBadgeT: { color: c.dim, fontSize: 10.5, fontWeight: "600", maxWidth: 84 },
  grpCount: { color: c.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  collapseBtn: {
    flexShrink: 1, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  collapseBtnOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  collapseT: { fontSize: 11, color: c.dim },
  collapseTOn: { color: c.brandA },
  // 布局循环胶囊：折叠空闲同款形制，负责把右侧按钮组推到行尾（collapseBtn 不再自带 auto）
  densityBtn: {
    marginLeft: "auto", flexShrink: 1, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.tintSoft,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  densityT: { fontSize: 11, color: c.dim },
  // #52 聚合胶囊（替代电脑图标）：densityBtn 同款形制；开=品牌色高亮
  aggBtn: {
    borderRadius: 999, borderWidth: 1, borderColor: withA(c.dim, 0.35),
    paddingHorizontal: 10, paddingVertical: 3, flexShrink: 1,
  },
  aggBtnOn: { borderColor: withA(c.brandA, 0.65), backgroundColor: withA(c.brandA, 0.1) },
  aggT: { fontSize: 11, color: c.dim },
  aggTOn: { color: c.brandA, fontWeight: "700" },
  swipeWrap: { marginBottom: 9, borderRadius: 16, overflow: "hidden" },
  swipeWrapC: { marginBottom: 7 },
  // 极简行（用户拍板圆角统一）：同标准/紧凑的圆角卡语言，仅行高更矮、间距更密
  swipeWrapM: { marginBottom: 5 },
  swipeCard: { borderRadius: 16, overflow: "hidden", backgroundColor: c.panel },
  // #32 离线源降权：整卡透明度 0.55（含左滑动作排，因为包在同 Animated.View）
  dimRow: { opacity: 0.55 },
  actPanel: {
    position: "absolute", top: 3, bottom: 3, right: 0, width: FULL_W,
    flexDirection: "row", borderRadius: 16, overflow: "hidden",
  },
  actPanelM: { top: 2, bottom: 2, borderRadius: 12 },
  actBtn: { width: ACT_W, alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: withA(c.waiting, 0.9) },
  actRen: { backgroundColor: c.brandB },
  actOff: { backgroundColor: withA(c.dim, 0.3) },
  actT: { color: "#fff", fontSize: 17, fontWeight: "600" },
  actT2: { color: "#fff", fontSize: 11.5, fontWeight: "600" },
  card: {
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
    borderRadius: 16, paddingVertical: 11, paddingHorizontal: 13,
  },
  cardC: { borderRadius: 13, padding: 9 },
  // 极简平铺行：去框（hairline 分隔接管分隔职责），纵向 8 呼吸感比 6 松一点，
  // 行高仍远低于紧凑卡（单行 vs 三行）
  cardM: { borderRadius: 13, borderWidth: 0, paddingVertical: 8, paddingHorizontal: 11 },
  rowC: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowM: { flexDirection: "row", alignItems: "center", gap: 7 },
  titleM: { color: c.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  // 极简行水位区（常显）：固定 64px 右对齐 = 细条轨道（44px）+ 9px 百分比/占位，
  // 有无水位各行右缘恒定不跳
  ctxCell: { width: 64, alignItems: "flex-end", gap: 2.5 },
  ctxCellBar: { width: 44, height: 3, borderRadius: 1.5, backgroundColor: c.tintSoft, overflow: "hidden" },
  ctxCellT: { fontSize: 9, lineHeight: 11, fontVariant: ["tabular-nums"], color: c.faint },
  // #362 WORKING 实时工作行独立成第二行（标题让位第一行），与 sum 同底距
  liveRow: { flexDirection: "row", alignItems: "center", marginBottom: 5 },
  titleC: { color: c.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  sumC: { color: c.faint, fontSize: 11, marginTop: 2 },
  footC: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  folderC: { fontSize: 10, color: c.dim, flexShrink: 1, maxWidth: 120 },
  statsC: { fontSize: 10, color: c.faint, fontVariant: ["tabular-nums"] },
  dot: {
    width: 11, height: 11, borderRadius: 6, opacity: 1,
    alignItems: "center", justifyContent: "center",
  },
  elapsed: { fontSize: 12, color: c.faint, fontVariant: ["tabular-nums"] },
  liveStat: { flex: 1, fontSize: 12, color: c.dim, fontVariant: ["tabular-nums"] },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { color: c.text, fontSize: 15, fontWeight: "600", marginBottom: 3, flexShrink: 1 },
  // 沉寂会话（DONE 非今日更新）名称降档：覆盖 title/titleC 的 color
  titleIdle: { color: c.dim },
  sum: { color: c.dim, fontSize: 13, marginBottom: 5 },
  foot: { flexDirection: "row", alignItems: "center", gap: 8 },
  // 次要信息合并行（降噪）：托管/外部 · 目录 · 历史 一行 faint 小字，替代原 tag 胶囊
  meta: { fontSize: 10, color: c.faint, flexShrink: 1 },
  stats: { fontSize: 10, fontVariant: ["tabular-nums"] },
  // 上下文占用 mini（foot 最右）：30px 微型条 + 百分比
  ctxMini: { flexDirection: "row", alignItems: "center", gap: 4 },
  ctxMiniBar: { width: 30, height: 3, borderRadius: 1.5, backgroundColor: c.tintSoft, overflow: "hidden" },
  ctxMiniT: { fontSize: 10, fontVariant: ["tabular-nums"], minWidth: 24, textAlign: "right" },
  empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 42, marginBottom: 12, opacity: 0.5 },
  emptyT: { color: c.faint, fontSize: 14, marginBottom: 6 },
  emptyS: { color: c.faint, fontSize: 12, textAlign: "center", lineHeight: 20 },
  edgeZone: { position: "absolute", left: 0, top: 0, bottom: 0, width: 22, zIndex: 5 },
  // 列表底部上拉刷新提示行（#255）：滚到底自动触发，也可点按
  footHint: { alignItems: "center", paddingVertical: 10 },
  footHintT: { color: c.faint, fontSize: 12 },
  fab: { position: "absolute", right: 30, borderRadius: 16, elevation: 8 },
  // 删除撤销条（#247）：底部浮条；右侧留出让任务汇报悬浮钮（44dp@right12）的空档。
  // zIndex 50：高于列表/边缘手势条（5），低于抽屉/图例（60）——配合打开时隐藏双保险
  undoBar: {
    position: "absolute", left: 20, right: 76, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 9, zIndex: 50, elevation: 6,
  },
  undoT: { flex: 1, color: c.dim, fontSize: 13 },
  undoBtn: {
    borderRadius: 8, backgroundColor: c.tintStrong, paddingHorizontal: 12, paddingVertical: 5,
  },
  undoBtnT: { color: c.brandA, fontSize: 12.5, fontWeight: "700" },
  fabGrad: {
    width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center",
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
});
