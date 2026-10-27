// 源切换统一组件（W-HEAD6 B 件，用户 1018 深夜拍板）：四页 head 唯一形态——
// 电脑图标 + 在线/总数计数（如 1/1），点击弹浮窗（右上锚定）：
//   · 各源行（色点+名称+通道+当前标）——切活动源（connectServer 幂等只动视图）
//   · 「多元聚合」开关行（sources>1 才显示；双写 cc.display.aggregate + store.setAggregate
//     ——与原 ListScreen 聚合胶囊/设置拨杆完全同链，语义键零改动）
//   · 「管理连接」行（跳设置）
// 单源（≤1）点击不弹（直连行为不变）。
// 参考实现=ListScreen 顶栏 srcMenu（同锚定/同行语言），本组件为其跨页化收敛。
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Path, Rect } from "react-native-svg";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay } from "../store";
import type { ThemeColors } from "../theme";
import type { ServerEntry } from "../store";

/**
 * #290 弹窗左缘 clamp（用户 1028 截图 22 实锤）：W-HEAD6 把触发器内联进标题行
 * （屏幕左侧），菜单原 right:0 锚定触发器右缘、宽 ~208 向左展开——触发器 x≈60 时
 * 左缘 ≈ -148 出屏（左半切字）。本函数给出菜单相对 wrap 的 left 偏移：
 * 优先右对齐触发器（右缘对齐）；左溢出（<8）则改左对齐（向右展开）；右也溢出则
 * clamp 到屏右内边（宽自适应由调用方 maxWidth 兜）。
 * @param triggerX 触发器屏坐标 x（measureInWindow）
 * @param triggerW 触发器宽（右对齐锚）
 * @param menuW 菜单实宽（onLayout）
 * @param screenW 屏宽
 * @param wrapX wrap 屏坐标 x（换算回 wrap 相对坐标）
 */
export function clampMenuLeft(triggerX: number, triggerW: number, menuW: number, screenW: number, wrapX: number): number {
  const M = 8; // 屏内边距
  let leftScreen = triggerX + triggerW - menuW; // 优先：右缘对齐触发器
  if (leftScreen < M) leftScreen = Math.min(triggerX, M); // 左溢出→左对齐触发器（仍夹 ≥M）
  if (leftScreen + menuW > screenW - M) leftScreen = screenW - M - menuW; // 右溢出→夹屏内
  return leftScreen - wrapX; // wrap 相对坐标（菜单在 wrap 内绝对定位）
}

function DeskGlyph({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M3 5h18v10H3zM3 15l-1 4h20l-1-4M12 19v2" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const AGG_KEY = "cc.display.aggregate"; // 与 store 启动读取同键（#294 批4 口径）

export function SourceSwitch({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const snap = useRelay();
  const { c: tc } = useTheme();
  const c = useThemeStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ServerEntry[]>([]);
  // #290 锚定测量态：触发器/wrap 屏坐标（开弹时 measureInWindow）+ 菜单实宽（onLayout）
  const wrapRef = useRef<View>(null);
  const trigRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ tx: number; tw: number; wx: number } | null>(null);
  const [menuW, setMenuW] = useState(208);
  const { width: screenW } = useWindowDimensions();
  const measureAnchor = () => {
    trigRef.current?.measureInWindow((tx, _y, tw, _h) => {
      wrapRef.current?.measureInWindow((wx, _wy, _ww, _wh) => setAnchor({ tx, tw, wx }));
    });
  };

  useEffect(() => {
    if (open) void store.loadServers().then(setEntries).catch(() => {});
  }, [open]);

  const sources = snap.sources;
  const onlineN = sources.filter((x) => x.state === "online").length;
  const connColor = snap.connState === "online" ? tc.done : snap.connState === "connecting" || snap.connState === "reconnecting" ? tc.working : snap.connState === "unpaired" ? tc.error : tc.faint;
  const multi = sources.length > 1;

  const toggleAggregate = async () => {
    const next = !snap.aggregate;
    try { await AsyncStorage.setItem(AGG_KEY, next ? "1" : "0"); } catch {}
    store.setAggregate(next);
    setOpen(false);
  };

  const pick = (srcId: string) => {
    setOpen(false);
    const entry = entries.find((e) => e.id === srcId);
    if (entry) void store.connectServer(entry);
    else onOpenSettings?.(); // 快照有/落库无（异常态）：引导去设置
  };

  return (
    <View style={c.wrap} ref={wrapRef}>
      <Pressable
        ref={trigRef}
        style={c.trigger}
        hitSlop={6}
        android_ripple={{ color: tc.tintSoft, borderless: false, radius: 14 }}
        accessibilityLabel={`数据源 ${onlineN}/${sources.length} 在线，点击${multi ? "切换或聚合" : "查看或管理连接"}`}
        onPress={() => {
          measureAnchor(); // #290：开弹前测锚（measureInWindow 异步回调，首开未达时回落 right:0）
          // W-UIFIX 件六（用户 test.39 推翻「>1 源才弹」）：点击总弹——单源=自己行+
          // 管理连接（查看/管理入口常在）；聚合行/切源自然只在多源时有意义（菜单内
          // 聚合行对单源无操作对象，恒在场仅作状态展示）
          setOpen((v) => !v);
        }}
      >
        <DeskGlyph color={connColor} />
        <Text style={[c.countT, { color: connColor }]}>{onlineN}/{sources.length}</Text>
      </Pressable>
      {open ? <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} /> : null}
      {open ? (
        <View
          style={[c.menu, anchor ? { right: "auto", left: clampMenuLeft(anchor.tx, anchor.tw, menuW, screenW, anchor.wx) } : null]}
          onLayout={(e) => setMenuW(Math.max(208, e.nativeEvent.layout.width))} /* #290：实宽回测（自适应内容后 clamp 重算） */
        >
          {[...sources].sort((a, b) => (b.id === snap.activeSourceId ? 1 : 0) - (a.id === snap.activeSourceId ? 1 : 0)).map((src) => {
            const stc = src.state === "online" ? tc.done : src.state === "offline" ? tc.error : tc.working;
            const isActive = src.id === snap.activeSourceId;
            return (
              <Pressable key={src.id} style={[c.row, isActive && c.rowOn]} android_ripple={{ color: tc.tintSoft, borderless: false }} onPress={() => pick(src.id)}>
                {/* #226 件A：源标前缀换电脑图标（用户 1023 截图——⤷/色点升级）；
                    显示器形随源色填充，在线态语义并入色值本身（离线灰） */}
                <Svg width={11} height={11} viewBox="0 0 24 24">
                  <Rect x="2" y="3.5" width="20" height="13.5" rx="2" fill={stc} />
                  <Path d="M8 21h8" stroke={stc} strokeWidth="2.4" strokeLinecap="round" />
                </Svg>
                <Text style={c.rowT} numberOfLines={1}>{src.name}</Text>
                <Text style={c.rowChan}>{src.channel === "cloud" ? "云桥" : src.channel === "lan" ? "直连" : ""}</Text>
              </Pressable>
            );
          })}
          {/* W-HEAD6 B(c)：多元聚合开关入浮窗（原 head 下聚合胶囊+设置拨杆同链） */}
          <Pressable style={[c.row, snap.aggregate && c.rowOn]} android_ripple={{ color: tc.tintSoft, borderless: false }} onPress={() => void toggleAggregate()} accessibilityLabel={snap.aggregate ? "聚合模式，点击切回单源" : "单源模式，点击开启多元聚合"}>
            <View style={[c.dot, { backgroundColor: snap.aggregate ? tc.done : tc.faint }]} />
            <Text style={c.rowT}>多元聚合</Text>
            <Text style={c.rowChan}>{snap.aggregate ? "开" : "关"}</Text>
          </Pressable>
          <Pressable style={c.manageRow} android_ripple={{ color: tc.tintSoft, borderless: false }} onPress={() => { setOpen(false); onOpenSettings?.(); }}>
            <Text style={c.manageT}>管理连接（编辑 / 删除）…</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { position: "relative", flexShrink: 0 },
    trigger: { flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: 6, borderRadius: 13 }, /* W-UIFIX 件八：30→26——titleRow 内不撑高（设置页 51→48 与四页齐一） */
    countT: { fontSize: 11, fontWeight: "600" },
    menu: {
      /* #290：right:0 是首开未测到锚时的回落（右缘对齐触发器）；测到后 clampMenuLeft
       * 接管 left（右对齐优先/左溢出左对齐/双溢出夹屏内——标题行左侧形态不再出屏） */
      position: "absolute", top: 30, right: 0, minWidth: 208, zIndex: 100,
      backgroundColor: c.panel, borderRadius: 12, borderWidth: 1, borderColor: c.line,
      paddingVertical: 4, elevation: 6,
      shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    },
    row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
    rowOn: { backgroundColor: c.tintSoft },
    dot: { width: 7, height: 7, borderRadius: 4 },
    rowT: { flex: 1, minWidth: 0, color: c.text, fontSize: 12.5 },
    rowChan: { color: c.dim, fontSize: 10.5 },
    manageRow: { borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 12, paddingVertical: 9 },
    manageT: { color: c.dim, fontSize: 11.5 },
  });
