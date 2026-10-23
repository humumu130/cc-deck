// #226（W-CARDTAGS）双端断言：置顶图钉化/源竖条化/引擎胶囊独占 r3/灯显眼度（追加）。
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-cardtags.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ls = readFileSync(join(ROOT, "expo-app/src/screens/ListScreen.tsx"), "utf-8");
const sd = readFileSync(join(ROOT, "web-console/js/session-domain.js"), "utf-8");
const css = readFileSync(join(ROOT, "web-console/css/base.css"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== #226 W-CARDTAGS：标签重排+灯显眼度 ==");

// ── A. expo：置顶图钉（CardShell pinned prop 右上角）──
ok(ls.includes("pinned?: boolean; // #226"), "A1 expo CardShell pinned prop");
ok(ls.includes("right: 10, top: 6"), "A2 图钉右上角绝对定位");
ok(ls.includes("s.pinned === true") && ls.includes("pinned={s.pinned === true}"), "A3 SessionCard 传 pinned（非置顶不显）");

// ── B. expo：源竖条（CardShell srcBar 左缘贯穿）──
ok(!ls.includes("srcBar?: string | null"), "B1(#227) 竖条退役：srcBar prop 移除");
ok(!ls.includes("left: 0, top: 2, bottom: 2, width: 3.5"), "B2(#227) 竖条渲染移除");
ok(!ls.includes("srcBar={"), "B3(#227) 竖条挂载点移除");
ok(!ls.includes("{srcBadge ? <SrcBadge {...srcBadge} /> : null}"), "B4 SrcBadge 老胶囊撤（#227 新形态=b2SrcCap 双胶囊）");

// ── C. expo：引擎胶囊=r3 唯一徽章成员 ──
ok(ls.includes("engineBadgeable(s.engine) ? <EngineBadge engine={s.engine} size=\"sm\" /> : null"), "C1(#227) 引擎胶囊 r3 右端（条件渲染含 srcBadge 双胶囊）");

// ── D. expo：灯显眼度（#226 追加）──
ok(ls.includes("width: 21, height: 21, borderRadius: 11"), "D1 WORKING 光环层 21px（dot 9px 外扩）");
ok(ls.includes("0.28 * BLINK_PHASES[ph]"), "D2 光环随 BLINK_PHASES 呼吸（与 dot 同步）");
ok(ls.includes("{breathe ? ("), "D3 仅 WORKING（breathe）态加环——空闲绿低调不加");

// ── E. web：置顶图钉 ──
ok(sd.includes('class="icon-inline srow-pinned"'), "E1 r1 时间戳左侧 srow-pinned 图钉 svg");
ok(sd.includes("(item.pinned ? '<svg"), "E2 非置顶不显（条件渲染）");
ok(css.includes(".srow-pinned {"), "E3 图钉 CSS");
ok(!sd.includes('<span class="tag pin-flag">置顶</span>'), "E4 pin-flag 文字胶囊退役");

// ── F. web：源竖条 ──
ok(sd.includes("b2SrcCap") && !sd.includes("b2SrcBar"), "F1(#227) b2SrcBar 退役→b2SrcCap");
ok(!sd.includes("b2SrcBar(item)"), "F2(#227) 开标签竖条挂载退役");
ok(!sd.includes("b2SourceBadge") && sd.includes("b2SrcCap"), "F3 b2SrcCap 新源胶囊（电脑图标+源名）");
ok(!css.includes("--src-bar"), "F4(#227) web 竖条规则退役");
ok(css.includes(".src-cap"), "F5(#227) web src-cap 源胶囊样式");

// ── G. web：r3 唯一成员+行条件 ──
ok(!sd.includes("item.source || item.pinned ? '<span class=\"srow-r3\""), "G1 r3 条件去 source/pinned（引擎+团队为准）");
ok(sd.includes("b2EngineBadge(item) + \"</span>\""), "G2 引擎胶囊保留 r3 尾位");

// ── H. web：灯显眼度 ──
ok(css.includes("width: 9px; height: 9px"), "H1 status-dot 7→9px");
ok(css.includes("st-glow-pulse 1.5s"), "H2 WORKING glow 提速 1.5s");
ok(css.includes("8px 3px color-mix(in srgb, var(--st-working) 85%"), "H3 glow 峰值 8px/85%（跑不跑一眼可辨）");

// ── I. 工作灯原位不动 ──
ok(ls.includes("right: -3, bottom: -3, width: 9, height: 9"), "I1 expo dot 原位（头像左下）9px");
ok(css.includes(".srow-ava"), "I2 web 灯仍随 srow-ava（原位）");

  // ── J/K. #226 追加件二：源标电脑图标 + 引擎品牌图标体系 ──
  {
    console.log("== #226 件二：源标图标+引擎品牌体系 ==");
    const ei = readFileSync(join(ROOT, "expo-app/src/engine-icon.tsx"), "utf-8");
    const ss = readFileSync(join(ROOT, "expo-app/src/screens/source-switch.tsx"), "utf-8");
    const tdp = readFileSync(join(ROOT, "expo-app/src/screens/TeamDetailPage.tsx"), "utf-8");
    // 件A
    ok(ss.includes("Rect x=\"2\" y=\"3.5\" width=\"20\" height=\"13.5\" rx=\"2\"") && ss.includes("M8 21h8"), "J1 expo 源行色点→显示器 SVG（屏体+底座）");
    ok(ss.includes('fill={stc}'), "J2 显示器随源色填充（在线色/离线灰语义并入色值）");
    ok(css.includes("clip-path: polygon(0 0, 100% 0, 100% 72%, 62% 72%"), "J3 web source-dot 显示器 clip-path（菜单/云桥行）");
    // 件B
    ok(ei.includes("#E8815A") && ei.includes('engine === "claude"') && ei.includes("16 12"), "K1 claude 像素螃蟹（#E8815A 橘系 16×12 网格复刻）");
    ok(ei.includes("M8.2 9.2l3.4 2.8-3.4 2.8") && ei.includes("22.4"), "K2 codex 圆形花边 16 点+>_ 终端符");
    ok(ei.includes("#6950EF") && ei.includes("#32F08C"), "K3 qwen/trae simple-icons 官方 path 内嵌（品牌色）");
    ok(ei.includes("export function EngineIcon") && ei.includes("export function hasEngineIcon"), "K4 EngineIcon/hasEngineIcon 组件导出");
    ok(tdp.includes("hasEngineIcon(engine) ? (") && tdp.includes("<EngineIcon engine={engine}"), "K5 EngineBadge 胶囊前缀接线（四引擎裸图标，其余瓦片不劣化）");
    ok(sd.includes("ENGINE_BRAND_SVG") && sd.includes('ENGINE_BRAND_SVG[item.engineClass] ??'), "K6 web 引擎胶囊品牌 SVG 前缀（无图标回落 sprite）");
    ok(ei.includes("glm/codebuddy/zcode：simple-icons 无收录"), "K7 无官方 SVG 引擎标注备案（占位不劣化）");
    ok(tdp.includes('import { EngineBrandTile, EngineIcon, hasEngineIcon }'), "K8 EngineBrandTile 原件保留（选项行瓦片不受影响）");
  }

  // ── L. #227 三排定稿：双胶囊+品牌化头像+竖条退役+全引擎覆盖 ──
  {
    console.log("== #227 三排定稿 ==");
    const ei2 = readFileSync(join(ROOT, "expo-app/src/engine-icon.tsx"), "utf-8");
    ok(ls.includes("srcBadge ? (") && ls.includes('fill={srcBadge.color}') && ls.includes('clipSrcName(srcBadge.name)'), "L1 expo r3 源胶囊居左（电脑图标+源名，源色）");
    ok(ls.includes('<View style={{ flex: 1 }} />') && ls.includes("engineBadgeable(s.engine) ? <EngineBadge"), "L2 引擎胶囊居右（r3-spring 两端分布）");
    ok(ls.includes("brandIcon={pmMember ? null : hasEngineIcon(s.engine) ? s.engine : null}"), "L3 品牌化头像（PM 豁免字母保留）");
    ok(ls.includes("pmMember={pmSessionIds.has(item.s.session_id)}"), "L4 PM 判定接线（headcount role 词表）");
    ok(sd.includes("b2SrcCap(item)") && sd.includes('class="r3-spring"'), "L5 web r3 双胶囊（src-cap 左+engine 右）");
    ok(sd.includes('class="ava-brand"'), "L6 web 品牌化头像");
    ok(ei2.includes("codebuddy") && ei2.includes("#6C4DFF"), "L7 codebuddy simple-icons 官方");
    ok(ei2.includes('zcode: { bg: "#546784"') && ei2.includes('glm: { bg: "#3E8EF7"'), "L8 zcode/glm 品牌色占位（像素风族谱）");
    ok(ei2.includes("return !!engine;"), "L9 hasEngineIcon 全引擎恒真（fallback 首字母兜底）");
    ok(sd.includes("engineBrandSvgOf"), "L10 web engineBrandSvgOf fallback getter");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
