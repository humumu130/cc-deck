// 品牌 Deck 标：底两张描边卡错位 + 顶一张实心卡（卡片=会话，呼应 CC Deck），纯 View 组合免 SVG 依赖
import { View } from "react-native";
import { withA } from "./theme";

export function LogoMark({ size = 19, color = "#D97757" }: { size?: number; color?: string }) {
  const w = Math.round(size * 0.56);
  const h = Math.round(size * 0.7);
  const r = Math.round(w * 0.26);
  const stroke = Math.max(Math.round(size * 0.055), 1.2);
  const lineH = Math.max(Math.round(size * 0.055), 1.6);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute", width: w, height: h, borderRadius: r,
          left: (size - w) / 2 - size * 0.13, top: (size - h) / 2 + size * 0.11,
          borderWidth: stroke, borderColor: withA(color, 0.4), transform: [{ rotate: "-12deg" }],
        }}
      />
      <View
        style={{
          position: "absolute", width: w, height: h, borderRadius: r,
          left: (size - w) / 2 + size * 0.13, top: (size - h) / 2 + size * 0.07,
          borderWidth: stroke, borderColor: withA(color, 0.78), transform: [{ rotate: "9deg" }],
        }}
      />
      <View
        style={{
          position: "absolute", width: w, height: h, borderRadius: r,
          left: (size - w) / 2, top: (size - h) / 2 - size * 0.04,
          backgroundColor: color, alignItems: "center", justifyContent: "center", gap: lineH * 1.7,
        }}
      >
        {size >= 22 ? (
          <>
            <View style={{ width: w * 0.5, height: lineH, borderRadius: lineH / 2, backgroundColor: "#1D1726" }} />
            <View style={{ width: w * 0.34, height: lineH, borderRadius: lineH / 2, backgroundColor: withA("#1D1726", 0.55) }} />
          </>
        ) : null}
      </View>
    </View>
  );
}
