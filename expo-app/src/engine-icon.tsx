// W-MSGUI 件二：Agent 引擎品牌图标（用户 1019 拍板——彩点/文字胶囊换品牌图标）。
// 形制：16-20px 圆角 4 方块，SVG 内联零外部资源（永不联网约束）。
//   claude：像素小螃蟹（Anthropic 吉祥物风几何简笔，橙棕底）
//   codex：OpenAI 风环结简形（弧环+内核）
//   trae / qwen-code / codebuddy / zcode：品牌色首字母方块（任务书口径：无现成
//   品牌图标的用品牌色首字母方块）；未接入（dim=true）一律灰调同款+「?」
// 接入点：NewSessionModal 引擎选项行（原 engDot 彩点）、EngineBadge（详情 head
// 引擎 chip 与各域复用件——一处替换全端生效）。
import { Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type EngineId = string;

// 品牌主色（方块底色）；letter 空 = 有专属图形（claude/codex）
const BRANDS: Record<string, { bg: string; letter: string }> = {
  claude: { bg: "#D97757", letter: "" },
  codex: { bg: "#101828", letter: "" },
  trae: { bg: "#4C6EF5", letter: "T" },
  "qwen-code": { bg: "#6236FF", letter: "Q" },
  codebuddy: { bg: "#0052D9", letter: "C" },
  zcode: { bg: "#546784", letter: "Z" },
};
const DIM_BG = "#3A4657";
const DIM_FG = "#9AA7B8";

// 图形内芯（svg viewBox 20×20 固定坐标，随 size 缩放）
function Glyph({ engine, fg }: { engine: string; fg: string }) {
  if (engine === "claude") {
    // 像素小螃蟹：两钳上举 + 圆身 + 三足（几何矩形，吉祥物风简笔）
    return (
      <>
        <Rect x={1.5} y={2.5} width={3.4} height={3} rx={1} fill={fg} />
        <Rect x={15.1} y={2.5} width={3.4} height={3} rx={1} fill={fg} />
        <Rect x={0.8} y={5.2} width={2.2} height={3.2} rx={1} fill={fg} />
        <Rect x={17} y={5.2} width={2.2} height={3.2} rx={1} fill={fg} />
        <Rect x={5.6} y={5.4} width={8.8} height={7} rx={2.4} fill={fg} />
        <Rect x={5} y={12.2} width={2} height={4.4} rx={1} fill={fg} />
        <Rect x={9} y={12.6} width={2} height={4.4} rx={1} fill={fg} />
        <Rect x={13} y={12.2} width={2} height={4.4} rx={1} fill={fg} />
      </>
    );
  }
  // codex：OpenAI 风环结（弧环缺口 + 内核圆）
  return (
    <>
      <Circle cx={10} cy={10} r={5.6} stroke={fg} strokeWidth={1.7} fill="none" />
      <Path d="M 10 4.4 A 5.6 5.6 0 0 1 15.6 10" stroke="#10A37F" strokeWidth={1.7} fill="none" />
      <Circle cx={10} cy={10} r={2} fill={fg} />
    </>
  );
}

// 统一瓦片：方块底 + 图形/字母；dim=未接入灰调
export function EngineBrandTile({ engine, size = 18, dim = false }: { engine: EngineId; size?: number; dim?: boolean }) {
  const known = engine === "claude" || engine === "codex";
  const b = BRANDS[engine] ?? { bg: "#546784", letter: (engine[0] ?? "?").toUpperCase() };
  const bg = dim ? DIM_BG : b.bg;
  const fg = dim ? DIM_FG : "#FFFFFF";
  const letter = dim ? "?" : b.letter || (engine[0] ?? "?").toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: bg, alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
      {known ? (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Glyph engine={engine} fg={fg} />
        </Svg>
      ) : (
        <Text style={{ color: fg, fontSize: Math.round(size * 0.56), fontWeight: "800", lineHeight: size }} allowFontScaling={false}>
          {letter}
        </Text>
      )}
    </View>
  );
}
