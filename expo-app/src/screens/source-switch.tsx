// 源切换统一组件（W-HEAD6 B 件，用户 1018 深夜拍板）：四页 head 唯一形态——
// 电脑图标 + 在线/总数计数（如 1/1），点击弹浮窗（右上锚定）：
//   · 各源行（色点+名称+通道+当前标）——切活动源（connectServer 幂等只动视图）
//   · 「多元聚合」开关行（sources>1 才显示；双写 cc.display.aggregate + store.setAggregate
//     ——与原 ListScreen 聚合胶囊/设置拨杆完全同链，语义键零改动）
//   · 「管理连接」行（跳设置）
// 单源（≤1）点击不弹（直连行为不变）。
// 参考实现=ListScreen 顶栏 srcMenu（同锚定/同行语言），本组件为其跨页化收敛。
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Path } from "react-native-svg";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay } from "../store";
import type { ThemeColors } from "../theme";
import type { ServerEntry } from "../store";

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
    <View style={c.wrap}>
      <Pressable
        style={c.trigger}
        hitSlop={6}
        android_ripple={{ color: tc.tintSoft, borderless: false, radius: 14 }}
        accessibilityLabel={`数据源 ${onlineN}/${sources.length} 在线${multi ? "，点击切换或聚合" : ""}`}
        onPress={() => {
          if (!multi) return; // 单源不弹（行为不变）
          setOpen((v) => !v);
        }}
      >
        <DeskGlyph color={connColor} />
        <Text style={[c.countT, { color: connColor }]}>{onlineN}/{sources.length}</Text>
      </Pressable>
      {open ? <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} /> : null}
      {open ? (
        <View style={c.menu}>
          {[...sources].sort((a, b) => (b.id === snap.activeSourceId ? 1 : 0) - (a.id === snap.activeSourceId ? 1 : 0)).map((src) => {
            const stc = src.state === "online" ? tc.done : src.state === "offline" ? tc.error : tc.working;
            const isActive = src.id === snap.activeSourceId;
            return (
              <Pressable key={src.id} style={[c.row, isActive && c.rowOn]} android_ripple={{ color: tc.tintSoft, borderless: false }} onPress={() => pick(src.id)}>
                <View style={[c.dot, { backgroundColor: stc }]} />
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
    trigger: { flexDirection: "row", alignItems: "center", gap: 4, height: 30, paddingHorizontal: 6, borderRadius: 15 },
    countT: { fontSize: 11, fontWeight: "600" },
    menu: {
      position: "absolute", top: 34, right: 0, minWidth: 208, zIndex: 100,
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
