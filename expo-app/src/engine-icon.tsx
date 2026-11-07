// Agent 引擎图标（W-ENGICONBRAND 1107 收敛为单一渲染口+单一表）：
//   表=engine-brand.ts（桌面 ENGINE_BRAND_SVG 全量移植，字节权威，7 引擎+别名+
//     回退链单点 engineBrandEntryOf——纯数据零 RN 依赖）。
//   渲染口（两消费面全走单表）：
//   EngineBrandTile——NewSessionModal 引擎选项行瓦片（18px）：表命中=真品牌标
//     contain 居中（同桌面 badge-brand 24px 方盒 contain 口径）；未命中（auto/
//     未知引擎）=字母瓦片兜底。W-MSGUI 件二手绘 Glyph（viewBox 20×20 手搓
//     Path/Circle/Rect 螃蟹/环结）随 W-ENGICONBRAND 退役——用户实锤「还是丑」
//     根因即此（手绘近似≠真品牌标）。
//   EngineIcon——卡片头像（AvaBadge brandIcon）/r3 引擎胶囊前缀
//     （TeamDetailPage EngineBadge）裸图标；#231 纠错（W-CARDTAGS2）后即点选源
//     渲染口，本批仅接线从 engine-icon-xml.ts 迁到 engine-brand.ts 单表
//     （表内容并移，engine-icon-xml.ts 退役删除）。
//   历史：#228 W-ICONHUNT 图集拍板 + #231 W-CLAUDECRAB 终稿（claude=像素螃蟹
//   原图/codex=SI OpenAI/glm=Z.ai logo/trae=官方 favicon/qwen=SI Qwen/
//   codebuddy=官网 logo/zcode=像素描边 Z）。
import { Image, Text, View } from "react-native";
import Svg, { Rect, SvgXml, Text as SvgText } from "react-native-svg";
import { engineBrandEntryOf } from "./engine-brand";

export type EngineId = string;

// 品牌主色（方块底色）；letter 空 = 有专属图形（claude/codex）
const BRANDS: Record<string, { bg: string; letter: string }> = {
  claude: { bg: "#D97757", letter: "" },
  codex: { bg: "#101828", letter: "" },
  trae: { bg: "#4C6EF5", letter: "T" },
  "qwen-code": { bg: "#6236FF", letter: "Q" },
  codebuddy: { bg: "#0052D9", letter: "C" },
  zcode: { bg: "#546784", letter: "Z" },
  // enginemobile（t-fe213f37）：「跟随预置（自动）」图标列同构条目——品牌色底+「自」，
  auto: { bg: "#3E8E7E", letter: "自" },
};
const DIM_BG = "#3A4657";
const DIM_FG = "#9AA7B8";

// 统一瓦片（W-ENGICONBRAND 真品牌化）：表命中=品牌标 contain 居中（勿拉伸变形——
// SVG viewBox 24/30/40 各异+crab PNG 191×150 宽图，一律方盒 contain 保纵横比；
// 同桌面 badge-brand img object-fit:contain 口径）；auto/未知引擎=字母瓦片兜底。
// dim=灰度化（enginemobile t-fe213f37 修：品牌 logo 原样+整体降透明，与复选框
// 视觉区分——enginemobile-R1 P3-2 收窄到禁用行）
export function EngineBrandTile({ engine, size = 18, dim = false }: { engine: EngineId; size?: number; dim?: boolean }) {
  const entry = engineBrandEntryOf(engine);
  if (entry) {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, opacity: dim ? 0.4 : 1 }}>
        {entry.kind === "svg" ? (
          <SvgXml xml={entry.xml} width={size} height={size} />
        ) : (
          <Image source={{ uri: `data:image/png;base64,${entry.b64}` }} style={{ width: size, height: size }} resizeMode="contain" />
        )}
      </View>
    );
  }
  const b = BRANDS[engine] ?? { bg: "#546784", letter: (engine[0] ?? "?").toUpperCase() };
  const fg = "#FFFFFF";
  const letter = b.letter || (engine[0] ?? "?").toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: 4, backgroundColor: b.bg, alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, opacity: dim ? 0.4 : 1 }}>
      <Text style={{ color: fg, fontSize: Math.round(size * 0.56), fontWeight: "800", lineHeight: size }} allowFontScaling={false}>
        {letter}
      </Text>
    </View>
  );
}

// ---------- 引擎裸图标（卡片头像 18px / r3 引擎胶囊前缀 12-14px） ----------
// 单表（engine-brand.ts）唯一渲染口：SVG 引擎 SvgXml 直渲（图标自带品牌 fill，
// 外层 color 不覆写）；trae=官方 favicon PNG（base64 Image）。未知引擎=圆角块+
// 首字母兜底（#231 C：RN <Text> 嵌 <Svg> 无效嵌套——字母恒不渲染只剩底块=用户
// 点名「灰色方块」；改 react-native-svg SvgText 正常出字）。
export function hasEngineIcon(engine: string | undefined | null): boolean {
  // 全引擎覆盖：七引擎已接单表；任意未知引擎=fallback 首字母占位（EngineIcon 内建）
  return !!engine;
}

export function EngineIcon({ engine, size = 13, color }: { engine: string | undefined | null; size?: number; color?: string }) {
  // #286① 双保险：engine 空（undefined/""）= relay「缺席即 claude」存量口径——
  // 兜底 claude 蟹而非「?」字母（旧 relay 快照未归一时的前端侧兜住）；未知非空
  // 引擎仍走首字母占位（设计不变）
  const key = engine || "claude";
  const entry = engineBrandEntryOf(key);
  if (entry?.kind === "svg") {
    return <SvgXml xml={entry.xml} width={size} height={size} />;
  }
  if (entry?.kind === "png") {
    // W-AVA09：圆角随桌面双档——26 头像盒 6px（.srow-ava .ava-brand radius 6）、
    // 10.8 徽章≈2px（badge img 内联 2px）；0.23 系数两头命中（26→5.98/10.8→2.48）
    return <Image source={{ uri: `data:image/png;base64,${entry.b64}` }} style={{ width: size, height: size, borderRadius: Math.max(2, size * 0.23) }} resizeMode="contain" />;
  }
  const letter = (engine ?? "?").charAt(0).toUpperCase();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={1} y={1} width={22} height={22} rx={5} fill={color ?? "#546784"} />
      <SvgText x={12} y={16.5} textAnchor="middle" fontSize={13} fontWeight={700} fill="#FFFFFF">{letter}</SvgText>
    </Svg>
  );
}
