// Agent 引擎图标（双轨）：
//   EngineBrandTile——W-MSGUI 件二遗留形制（圆角方块+手绘 Glyph/首字母），仅
//     NewSessionModal 引擎选项行在用；未随点选源更换（遗留，见 W-CARDTAGS2 回执）。
//   EngineIcon——用户点选图标源唯一渲染口（#228 W-ICONHUNT 图集 1023 拍板 + #231
//     W-CLAUDECRAB 1023 终稿：claude=像素螃蟹原图（用户提供样本，黑底转透明零加工）/
//     codex=SI OpenAI/glm=Z.ai logo/trae=官方 favicon PNG/
//     qwen=SI Qwen/codebuddy=官网 logo/zcode=像素描边 Z；字节权威=assets/engines/，
//     内嵌常量见 engine-icon-xml.ts）。消费位：卡片头像（AvaBadge brandIcon）、
//     r3 引擎胶囊前缀（TeamDetailPage EngineBadge）。
//   #231 纠错（W-CARDTAGS2）：89ad76f 接线时 SVG 分支漏写 return（`void color`
//     占位残留）——五引擎落到手绘/字母残支，「头像螃蟹不是点选素材」根因；手绘
//     分支（螃蟹复刻 V2/终端符/内嵌 SI 重复）随本修整体退役。
import { Image, Text, View } from "react-native";
import Svg, { Circle, Path, Rect, SvgXml, Text as SvgText } from "react-native-svg";
import { ENGINE_PNG_B64, ENGINE_SVG_XML } from "./engine-icon-xml";

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

// ---------- 引擎裸图标（卡片头像 18px / r3 引擎胶囊前缀 12-14px） ----------
// 用户点选源（engine-icon-xml.ts）唯一渲染口：SVG 引擎 SvgXml 直渲（图标自带品牌
// fill，外层 color 不覆写）；trae=官方 favicon PNG（base64 Image）。未知引擎=圆角
// 块+首字母兜底（#231 C：原此处 RN <Text> 嵌 <Svg> 无效嵌套——字母恒不渲染只剩
// 底块=用户点名「灰色方块」；改 react-native-svg SvgText 正常出字）。
export function hasEngineIcon(engine: string | undefined | null): boolean {
  // 全引擎覆盖：七引擎已接点选源；任意未知引擎=fallback 首字母占位（EngineIcon 内建）
  return !!engine;
}

export function EngineIcon({ engine, size = 13, color }: { engine: string | undefined | null; size?: number; color?: string }) {
  const key = engine ?? "";
  const xml = ENGINE_SVG_XML[key];
  if (xml) {
    return <SvgXml xml={xml} width={size} height={size} />;
  }
  const png = ENGINE_PNG_B64[key];
  if (png) {
    // W-AVA09：圆角随桌面双档——26 头像盒 6px（.srow-ava .ava-brand radius 6）、
    // 10.8 徽章≈2px（badge img 内联 2px）；0.23 系数两头命中（26→5.98/10.8→2.48）
    return <Image source={{ uri: `data:image/png;base64,${png}` }} style={{ width: size, height: size, borderRadius: Math.max(2, size * 0.23) }} resizeMode="contain" />;
  }
  const letter = (engine ?? "?").charAt(0).toUpperCase();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={1} y={1} width={22} height={22} rx={5} fill={color ?? "#546784"} />
      <SvgText x={12} y={16.5} textAnchor="middle" fontSize={13} fontWeight={700} fill="#FFFFFF">{letter}</SvgText>
    </Svg>
  );
}
