// #226（W-CARDTAGS）双端断言：置顶图钉化/源竖条化/引擎胶囊独占 r3/灯显眼度（追加）。
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm tests/test-cardtags.ts
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

// ── A. expo：置顶图钉（W-MOBFUSION 件① 行内化——CardShell pinned prop 退役，r1 时间戳左侧 Svg）──
ok(!ls.includes("pinned?: boolean") && ls.includes("s.pinned === true ? ("), "A1 图钉 r1 行内条件渲染（非置顶不显；W-MOBFUSION 件① 起 CardShell prop 退役）");
ok(ls.includes('width={11} height={11}') && ls.includes('stroke="#9AA3AF"'), "A2 灰线条 Pin 11px（W-FB66ALL ⑩ 用户 1025：单色描边替代彩色 📌，双主题同档灰阶）");
ok(ls.includes("const pinnedNow = all.filter((s) => s.pinned === true);"), "A3 置顶区恒在列表前部（pinnedNow/unpinned 分列）");

// ── B. expo：源竖条（CardShell srcBar 左缘贯穿）──
ok(!ls.includes("srcBar?: string | null"), "B1(#227) 竖条退役：srcBar prop 移除");
ok(!ls.includes("left: 0, top: 2, bottom: 2, width: 3.5"), "B2(#227) 竖条渲染移除");
ok(!ls.includes("srcBar={"), "B3(#227) 竖条挂载点移除");
ok(!ls.includes("{srcBadge ? <SrcBadge {...srcBadge} /> : null}"), "B4 SrcBadge 老胶囊撤（#227 新形态=b2SrcCap 双胶囊）");

// ── C. expo：引擎胶囊=r3 唯一徽章成员 ──
ok(ls.includes('engineBadgeable(effEngine ?? undefined) ? <EngineBadge engine={effEngine ?? undefined} size="sm" /> : null'), "C1(#227) 引擎胶囊 r3 右端（effEngine 条件渲染——源胶囊/团队 chip 同排）");

// ── D. expo：灯显眼度（#226 追加）──
ok(ls.includes("width: 21, height: 21, borderRadius: 11"), "D1 WORKING 光环层 21px（dot 9px 外扩）");
ok(ls.includes("0.28 * BLINK_PHASES[ph]"), "D2 光环随 BLINK_PHASES 呼吸（与 dot 同步）");
ok(ls.includes("{breathe ? ("), "D3 仅 WORKING（breathe）态加环——空闲绿低调不加");

// ── E. web：置顶图钉 ──
ok(sd.includes('class="srow-pin\' + (item.pinned ? " on" : "")'), "E1 r1 时间戳左侧 srow-pin 图钉钮（icon-pin svg use + on 态类）");
ok(css.includes(".srow-pin {") && css.includes("opacity: 0;") && css.includes(".queue-card:hover .srow-pin"), "E2 非置顶 hover 才显（opacity:0 恒占位——置顶/未置顶时间位置逐像素恒定，1123 四轮口径）");
ok(css.includes(".srow-pin.on { opacity: 1;"), "E3 置顶态常显（.on opacity 1）");
ok(!sd.includes('<span class="tag pin-flag">置顶</span>'), "E4 pin-flag 文字胶囊退役");

// ── F. web：源竖条 ──
ok(sd.includes("b2SrcCap") && !sd.includes("b2SrcBar"), "F1(#227) b2SrcBar 退役→b2SrcCap");
ok(!sd.includes("b2SrcBar(item)"), "F2(#227) 开标签竖条挂载退役");
ok(!sd.includes("b2SourceBadge") && sd.includes("b2SrcCap"), "F3 b2SrcCap 新源胶囊（电脑图标+源名）");
ok(!css.includes("--src-bar"), "F4(#227) web 竖条规则退役");
ok(css.includes(".src-cap"), "F5(#227) web src-cap 源胶囊样式");

// ── G. web：r3 唯一成员+行条件 ──
ok(!sd.includes("item.source || item.pinned ? '<span class=\"srow-r3\""), "G1 r3 条件去 source/pinned（引擎+团队为准）");
ok(sd.includes("avaBrandHtmlOf(item)") && sd.includes("ENGINE_BRAND_SVG[item.engineClass] ??"), "G2 引擎品牌标随头像（ava-brand 单口 engineBrandSvgOf——#227 双端同构；r3 尾=团队 chip，跨域徽章走 __ccDeck005EngineBadgeHtml 单口）");

// ── H. web：灯显眼度 ──
ok(css.includes("width: 9px; height: 9px"), "H1 status-dot 7→9px");
ok(css.includes("st-glow-pulse 3s"), "H2 WORKING glow 3s（W-ANIMFAST 常驻动画耗电根治：1.5s 提速档降频 3s——峰值亮度不变）");
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
    // 件B（W-ENGICONBRAND 单表化：资产迁 engine-brand.ts——桌面 ENGINE_BRAND_SVG 全量移植字节权威，
    //     手绘 Glyph 视觉近似退役；渲染口 engine-icon.tsx 两消费面全走单表）
    const eb = readFileSync(join(ROOT, "expo-app/src/engine-brand.ts"), "utf-8");
    ok(eb.includes('"claude": { kind: "png"') && eb.includes("像素螃蟹原图"), "K1 claude 像素螃蟹原图（用户样本 PNG b64——W-ENGICONBRAND 单表）");
    ok(eb.includes('"codex": { kind: "svg"') && eb.includes("codex-brand") && eb.includes("#10A37F"), "K2 codex SI OpenAI 环结（桌面表字节同源）");
    ok(eb.includes('"qwen-code": { kind: "svg"') && eb.includes('"trae": { kind: "png"') && eb.includes("ENGINE_BRAND_ALIAS"), "K3 qwen(SI)/trae(官方 favicon) 入表+别名归一链");
    ok(ei.includes("export function EngineIcon") && ei.includes("export function hasEngineIcon"), "K4 EngineIcon/hasEngineIcon 组件导出");
    ok(tdp.includes("hasEngineIcon(engine) ? (") && tdp.includes("<EngineIcon engine={engine}"), "K5 EngineBadge 胶囊前缀接线（四引擎裸图标，其余瓦片不劣化）");
    ok(sd.includes("ENGINE_BRAND_SVG") && sd.includes('ENGINE_BRAND_SVG[item.engineClass] ??'), "K6 web 引擎胶囊品牌 SVG 前缀（无图标回落 sprite）");
    ok(eb.includes("engineBrandEntryOf") && eb.includes("回退链"), "K7 回退链单点备案（直查→别名→undefined 消费面字母瓦片兜底——占位不劣化）；W-ENGICONBRAND 后全引擎真品牌标在表，无收录备案位随旧资产退役");
    ok(tdp.includes('import { EngineBrandTile, EngineIcon, hasEngineIcon }'), "K8 EngineBrandTile 原件保留（选项行瓦片不受影响）");
  }

  // ── L. #227 三排定稿：双胶囊+品牌化头像+竖条退役+全引擎覆盖 ──
  {
    console.log("== #227 三排定稿 ==");
    const ei2 = readFileSync(join(ROOT, "expo-app/src/engine-icon.tsx"), "utf-8");
    ok(ls.includes('backgroundColor: srcBadge.color + "E6"') && ls.includes("clipSrcName(srcBadge.name)"), "L1 expo r3 源胶囊居左（#233 标签化：源色底 E6+白字 8.5 粗+显示器图标入囊）");
    ok(ls.includes('<View style={{ flex: 1 }} />') && ls.includes("engineBadgeable(effEngine ?? undefined) ? <EngineBadge"), "L2 引擎徽居源胶囊右侧（flex:1 弹性分隔——W-FB66ALL ⑦ 用户 1025：左=源+引擎，右=📁+团队 chip）");
    ok(ls.includes("brandIcon={effEngine}") && ls.includes('require("../assets/engines/crab-pm.png")'), "L3 品牌化头像（PM 豁免=W-CRABINTEGRATE 变体蟹整头替换——举旗蟹/皇冠蟹，PM/Leader 不再回字母）");
    ok(ls.includes("roleKind={pmRoleKindOf.get(item.s.session_id) ?? null}"), "L4 PM 判定接线（pmRoleKindOf 编制 headcount role 词表——roleKind 链与 📁 显隐同源）");
    ok(sd.includes("b2SrcCap(item)") && sd.includes('class="r3-spring"'), "L5 web r3 双胶囊（src-cap 左+engine 右）");
    ok(sd.includes('class="ava-brand"'), "L6 web 品牌化头像");
    ok(ei2.includes("codebuddy") || readFileSync(join(ROOT, "expo-app/src/engine-brand.ts"), "utf-8").includes("#6C4DFF"), "L7 codebuddy 官网 logo（单表 SVG——#6C4DFF 渐变底）");
    ok((() => { const b = readFileSync(join(ROOT, "expo-app/src/engine-brand.ts"), "utf-8"); return b.includes('"zcode": { kind: "svg"') && b.includes("像素描边 Z") && b.includes('"glm": { kind: "svg"') && b.includes("Z.ai / GLM logo"); })(), "L8 zcode 像素描边 Z/glm Z.ai logo（单表真品牌标——字母占位随旧资产退役）");
    ok(ei2.includes("return !!engine;"), "L9 hasEngineIcon 全引擎恒真（fallback 首字母兜底）");
    ok(sd.includes("engineBrandSvgOf"), "L10 web engineBrandSvgOf fallback getter");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
