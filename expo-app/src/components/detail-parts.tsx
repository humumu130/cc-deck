// W-SPLIT-S1（docs/design-split-plan.md §3 阶段 1）：自 DetailScreen.tsx 机械抽离的自包含展示组件。
// 铁律「只搬不改」：函数体逐字未动，仅 import 接线。makeStyles 系组件（DiffBlock/
// StatRow/WaitCard 等）依赖 DetailScreen 私有样式工厂——深纠缠留原文件（见回执清单）。
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTheme } from "../theme-context";

const DOCK_PHASES = [1, 0.72, 0.45, 0.72];

export function MicIcon({ color }: { color: string }) {
  return (
    <View style={{ width: 15, height: 21, alignItems: "center" }}>
      <View style={{ width: 8, height: 11, borderRadius: 4, backgroundColor: color }} />
      <View
        style={{
          position: "absolute", top: 0, width: 13, height: 12,
          borderRadius: 7.5, borderWidth: 1.5, borderBottomWidth: 0, borderColor: color,
        }}
      />
      <View style={{ width: 1.5, height: 3.5, backgroundColor: color, marginTop: 3.5 }} />
      <View style={{ width: 6, height: 1.5, borderRadius: 0.75, backgroundColor: color, marginTop: 1 }} />
    </View>
  );
}

export function DockDot({ color, breathe }: { color: string; breathe?: boolean }) {
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!breathe) return;
    const t = setInterval(() => setPh((n) => (n + 1) % DOCK_PHASES.length), 480);
    return () => clearInterval(t);
  }, [breathe]);
  return (
    <View
      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: breathe ? DOCK_PHASES[ph] : 1 }}
      accessibilityLabel={breathe ? "运行中" : undefined}
    />
  );
}

export function CtxSegMeter({ pct, tone, cells = 20, small }: { pct: number; tone: string; cells?: number; small?: boolean }) {
  const { c } = useTheme();
  const on = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
  // W-UIFIX 件二：small 档（标题行右端用）——段 2×5/gap 1，比副题行旧档小一号
  return (
    <View style={{ flexDirection: "row", gap: small ? 1 : 1.5, alignItems: "center" }}>
      {Array.from({ length: cells }, (_, i) => (
        <View key={i} style={{ width: small ? 2 : 3, height: small ? 5 : 6, borderRadius: 1, backgroundColor: i < on ? tone : c.ctxTrack }} />
      ))}
    </View>
  );
}
