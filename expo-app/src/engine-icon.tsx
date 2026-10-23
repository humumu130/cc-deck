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

// ---------- #226 件B（W-CARDTAGS 追加）：引擎品牌裸图标（胶囊前缀 12-14px 用） ----------
// 与 EngineBrandTile（方块瓦片，选项行 18px）互补：本件为「无底框裸图标」形态，供
// r3 引擎胶囊前缀/头像角标位使用。来源与取色（回执「图标体系」节同口径）：
//   claude   像素小螃蟹复刻 V2（用户 1023 截图——橘 #E8815A 系非上版橙棕；16×12 网格）
//   codex    圆形花边+>_ 终端符（用户截图 2 Codex CLI 官方形——替代上版 OpenAI 环结）
//   qwen-code simple-icons siQwen path 内嵌（品牌紫 #6950EF）
//   trae     simple-icons siTrae path 内嵌（品牌绿 #32F08C）
//   glm/codebuddy/zcode：simple-icons 无收录且无公开官方 SVG——保持现状（回执标注）
export function hasEngineIcon(engine: string | undefined | null): boolean {
  // #227 件四：全引擎覆盖（codebuddy=simple-icons 官方；zcode/glm=像素风品牌色占位；
  // 任意未知引擎=fallback 首字母占位——EngineIcon 内建，恒有图标）
  return !!engine;
}

export function EngineIcon({ engine, size = 13, color }: { engine: string | undefined | null; size?: number; color?: string }) {
  if (engine === "claude") {
    const h = (size * 12) / 16;
    return (
      <Svg width={size} height={h} viewBox="0 0 16 12">
        <Rect x={0} y={1} width={2} height={1} fill="#E8815A" /><Rect x={0} y={2} width={1} height={2} fill="#E8815A" />
        <Rect x={14} y={1} width={2} height={1} fill="#E8815A" /><Rect x={15} y={2} width={1} height={2} fill="#E8815A" />
        <Rect x={2} y={3} width={1} height={1} fill="#E8815A" /><Rect x={13} y={3} width={1} height={1} fill="#E8815A" />
        <Rect x={4} y={4} width={8} height={1} fill="#E8815A" /><Rect x={3} y={5} width={10} height={1} fill="#E8815A" />
        <Rect x={3} y={6} width={10} height={1} fill="#E8815A" /><Rect x={3} y={7} width={10} height={1} fill="#E8815A" />
        <Rect x={4} y={8} width={8} height={1} fill="#E8815A" />
        <Rect x={2} y={8} width={1} height={2} fill="#E8815A" /><Rect x={1} y={10} width={1} height={1} fill="#E8815A" /><Rect x={4} y={9} width={1} height={2} fill="#E8815A" />
        <Rect x={13} y={8} width={1} height={2} fill="#E8815A" /><Rect x={14} y={10} width={1} height={1} fill="#E8815A" /><Rect x={11} y={9} width={1} height={2} fill="#E8815A" />
        <Rect x={5} y={5} width={1} height={1} fill="#5A2E1F" /><Rect x={10} y={5} width={1} height={1} fill="#5A2E1F" />
      </Svg>
    );
  }
  if (engine === "codex") {
    const c = color ?? "#666";
    const dots: Array<[number, number]> = [[12, 1.6], [16.2, 2.7], [19.3, 4.7], [21.3, 7.8], [22.4, 12], [21.3, 16.2], [19.3, 19.3], [16.2, 21.3], [12, 22.4], [7.8, 21.3], [4.7, 19.3], [2.7, 16.2], [1.6, 12], [2.7, 7.8], [4.7, 4.7], [7.8, 2.7]];
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {dots.map(([cx, cy], i) => <Circle key={i} cx={cx} cy={cy} r={0.9} fill={c} />)}
        <Path d="M8.2 9.2l3.4 2.8-3.4 2.8" stroke={c} strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <Rect x={13} y={14.2} width={4.2} height={1.7} rx={0.6} fill={c} />
      </Svg>
    );
  }
  if (engine === "qwen-code") {
    return <Svg width={size} height={size} viewBox="0 0 24 24"><Path fill="#6950EF" d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" /></Svg>;
  }
  if (engine === "trae") {
    return <Svg width={size} height={size} viewBox="0 0 24 24"><Path fill="#32F08C" d="M24 20.5H3.5V17H0V3.5h24ZM3.5 17h17V7h-17Zm8.5-5-2.5 2.5L7 12l2.5-2.5Zm7 0-2.5 2.5L14 12l2.5-2.5z" /></Svg>;
  }
  if (engine === "codebuddy") {
    // simple-icons siCodebuddy（品牌紫 #6C4DFF 官方 path 内嵌）
    return <Svg width={size} height={size} viewBox="0 0 24 24"><Path fill="#6C4DFF" d="M18.636.289a1 1 0 0 0-.11 0c-.18.01-.195.02-.442.24-.716.636-1.722 2.546-2.703 5.137l-.274.72-.499.16c-1.554.498-2.934 1.128-4.157 1.893-1.174.73-1.81 1.207-2.768 2.056l-.578.51-.262-.045c-2.528-.447-4.63-.37-6.255.23-1.676.62-2.695 1.67-3.046 3.13-.383 1.595.135 3.29 1.54 5.037 1.203 1.494 2.904 2.787 5.092 3.876 1.885.94 3.74 1.482 5.567 1.625l.65.051.486-.318c1.234-.81 2.51-1.883 3.826-3.219l.618-.627-.055-.866-.056-.866.78-.363c2.035-.946 3.636-2.19 4.8-3.733 1.057-1.402 1.422-2.79 1.095-4.166-.234-.984-.833-1.835-1.795-2.554-.844-.628-1.906-1.128-3.187-1.5l-.646-.187-.383-.555c-.863-1.24-1.555-2.29-2.076-3.147a16 16 0 0 1-.728-1.243c-.043-.082-.08-.145-.11-.19a1 1 0 0 0-.076-.093Zm-5.32 8.65c1.23 0 2.427.18 3.591.538l.508.158.345.39c1.472 1.666 2.686 3.286 3.643 4.862l.32.528-.096.546c-.16.914-.628 1.6-1.404 2.057-.983.579-2.376.868-4.18.868-1.456 0-2.98-.205-4.574-.614l-.475-.122-.362-.335c-1.797-1.66-3.204-3.524-4.222-5.591l-.28-.568.072-.532c.147-1.083.742-1.798 1.785-2.146 1.003-.33 2.2-.443 3.591-.34l.356.027.322.273c.634.54 1.254 1.053 1.86 1.54l.512.414.663-.152c.4-.092.797-.165 1.19-.22Z" /></Svg>;
  }
  // #227 件四：无官方 SVG 的引擎=像素风品牌色首字母占位（与螃蟹同风格族谱；24×24
  // currentColor 单色可着色）。zcode=#546784（EngineBrandTile 同源）/glm=#3E8EF7 智谱蓝系
  const PLACEHOLDER: Record<string, { bg: string; letter: string }> = {
    zcode: { bg: "#546784", letter: "Z" },
    glm: { bg: "#3E8EF7", letter: "G" },
  };
  const ph = PLACEHOLDER[engine ?? ""] ?? { bg: color ?? "#546784", letter: (engine ?? "?").charAt(0).toUpperCase() };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={1} y={1} width={22} height={22} rx={5} fill={ph.bg} />
      <Text selectable={false} style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "700", textAlign: "center", lineHeight: 22 }}>{ph.letter}</Text>
    </Svg>
  );
}
