// mtopicons（t-3db5cacf，1104 用户实锤：四主页顶栏＋号切页跳变）：样式级断言。
//   病灶：会话页 plusBtn 44×44 r13 mR-4 vs 团队/项目页 plusBtnBare 36×40 mL2——同
//   PlusMark 20 但容器几何双差（宽 8/高 4/对边反号）=pager 横滑时＋x/y 双跳；
//   gap：ListScreen topbar 10 vs PageHead 8。
//   修：OrgTabs ＋容器对齐会话页基准（HEAD_BASE 哲学=会话页唯一基准）；gap 统一 8。
//   截图归装机真验（expo RN 无本机 headless——W-PORT-B 模拟器截图缺口同口径），
//   本套件=样式契约锁（几何数字逐项断言）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const list = srcOf("../src/screens/ListScreen.tsx");
  const org = srcOf("../src/screens/OrgTabs.tsx");
  const pageHead = srcOf("../src/screens/page-head.tsx");
  const brand = srcOf("../src/brand.tsx");

  console.log("A. ＋容器四页一套（会话页=唯一基准）");
  {
    const listBtn = list.slice(list.indexOf("plusBtn: {"), list.indexOf("plusBtn: {") + 200);
    const orgBtn = org.slice(org.indexOf("plusBtnBare: {"), org.indexOf("plusBtnBare: {") + 240);
    assert(listBtn.includes("width: 44, height: 44, borderRadius: 13") && listBtn.includes("marginRight: -4"), "会话页基准：plusBtn 44×44 r13 mR-4（锚不动）");
    assert(orgBtn.includes("width: 44, height: 44, borderRadius: 13") && orgBtn.includes("marginRight: -4"), "团队/项目页：plusBtnBare 对齐基准 44×44 r13 mR-4（原 36×40 mL2——x 差 8/对边反号根除）");
    assert(!orgBtn.includes("width: 36") && !orgBtn.includes("height: 40") && !orgBtn.includes("marginLeft: 2"), "旧几何 36×40/mL2 零残留");
    assert(org.includes('<PlusMark size={20}') && list.includes('<PlusMark size={20}'), "＋图标同 size=20（brand 单源同参）");
    const brandPM = brand.slice(brand.indexOf("PlusMark"), brand.indexOf("PlusMark") + 300);
    assert(brandPM.includes("size: number = 20") || brandPM.includes("size = 20"), "PlusMark 默认 size=20（brand.tsx:71 单源）");
  }

  console.log("B. 图标几何零跳变（容器/间距/锚点）");
  {
    const listTop = list.slice(list.indexOf("topbar: {"), list.indexOf("topbar: {") + 360);
    assert(listTop.includes("gap: 8") && !listTop.includes("gap: 10"), "会话页 topbar gap 10→8（对齐 PageHead——右侧动作区间距零跳）");
    const phHead = pageHead.slice(pageHead.indexOf("head: {"), pageHead.indexOf("head: {") + 200);
    assert(phHead.includes("gap: 8"), "PageHead c.head gap 8（团队/项目/设置页头共用基准）");
    assert(phHead.includes("HEAD_BASE") && listTop.includes("HEAD_BASE"), "四页头容器同引 HEAD_BASE 单源（高度 48 固定/paddingHorizontal 一致）");
    const hb = srcOf("../src/head-unify.ts");
    assert(hb.includes("height: 48") || hb.includes("48"), "HEAD_BASE 高 48 固定（#191 根修口径）");
    // ripple 同形（mtopicons R2：原恒真伪断言修真——B 审攻点 5：`|| true` 放走了 r16 残留，
    // 本条曾可抓住「同 ripple r13」假陈述；现 r16 已统一 13，本断言钉死不回潮）
    assert(!list.includes("radius: 16"), "ripple 半径 16 零残留（plusBtn r16→13 统一，全文件唯一 16 位点已退役）");
    const listPlusRipple = list.slice(list.indexOf('style={styles.plusBtn}'), list.indexOf('style={styles.plusBtn}') + 260).match(/radius: (\d+)/);
    const orgRipple = org.slice(org.indexOf("style={styles.plusBtnBare}"), org.indexOf("style={styles.plusBtnBare}") + 260).match(/radius: (\d+)/);
    assert(!!listPlusRipple && !!orgRipple && listPlusRipple[1] === orgRipple[1] && listPlusRipple[1] === "13", `＋ ripple 两页同值 13（实 list=${listPlusRipple?.[1]} org=${orgRipple?.[1]}——B 审 :47-48 算而不用接上）`);
  }

  console.log("C. hitSlop/设置页核对");
  {
    const listPlus = list.slice(list.indexOf('accessibilityLabel="新建会话"') - 300, list.indexOf('accessibilityLabel="新建会话"') + 40);
    const orgShell = org.indexOf("style={styles.plusBtnBare}");
    const orgPlus = org.slice(orgShell - 200, orgShell + 400);
    assert(listPlus.includes("hitSlop={4}") && orgPlus.includes("hitSlop={4}"), "＋ hitSlop 两页同 4（命中区统一）");
    const settings = srcOf("../src/screens/SettingsPage.tsx");
    assert(settings.includes("PageHead"), "设置页头=PageHead 共用组件（无＋——设置页语义无新增，头容器同基准）");
  }

  console.log("D. R2 右锚根治+三统一（B 审 review-w-mtopicons-b-1104 对账落地）");
  {
    // P1 右锚：标题块 flex:1 minWidth:0（PageHead:72 同款）——W-HEAD6 删 connChip 丢的
    // marginLeft:auto 右锚机关由标题块弹性替补；＋右缘距屏右缘=padding+mR-4 四页同式
    const titleBlock = list.slice(list.indexOf("marginRight: 8 }}") - 200, list.indexOf("marginRight: 8 }}") + 30);
    assert(list.includes("flex: 1, minWidth: 0, marginRight: 8"), "R2-P1 右锚在（标题块 flex:1 minWidth:0——右簇恒贴右缘，切页＋渲染 x 恒等式成立）");
    assert(!list.includes("flexShrink: 0, marginRight: 8"), "旧 flexShrink:0 左充形态零残留");
    // 铃铛单源：page-head BellGlyphBase 导出+ListScreen 消费+本地自绘退役
    assert(pageHead.includes("export function BellGlyphBase"), "R2-P2② BellGlyphBase 单源导出（page-head 20×20/2.0 唯一实现）");
    assert(list.includes('import { BellGlyphBase, SessionStatSub } from "./page-head"'), "会话页引单源（本地自绘 18×18/1.8 退役）");
    assert(!list.includes("width={18}"), "本地 18px 铃铛零残留");
    assert(list.includes("<BellGlyphBase color={c.dim} />"), "铃铛渲染走单源组件");
    // 徽标规格统一（page-head badge 15/r8/(-3,-6)/9.5/700）
    const badgeBlock = list.slice(list.indexOf("bellBadge: {"), list.indexOf("bellBadge: {") + 220);
    assert(badgeBlock.includes("minWidth: 15, height: 15, borderRadius: 8") && badgeBlock.includes("top: -3, right: -6"), "badge 规格统一 PageHead（15/r8/(-3,-6)——双规格横滑双跳根除）");
    assert(list.includes('fontSize: 9.5, fontWeight: "700"'), "badge 字规格同源（9.5/700）");
    // 尺寸阶梯两档 16/20：theme 15→16
    assert(list.includes("width: 16, height: 16, tintColor: c.dim"), "尺寸阶梯两档 16/20：theme 15→16（与 search 16 同档；bell/plus 20 档）");
    assert(!list.includes("width: 15, height: 15, tintColor"), "theme 15px 档零残留");
    // P2④ 窄屏 chips 兜底
    assert(list.includes("useWindowDimensions") && list.includes("const headChipsOn = winW >= 360"), "R2-P2④ 窄屏兜底在（<360dp 闲/物 chip 不入 topbar——320dp 双 chip 裁＋根除）");
    assert(list.includes("idleCount > 0 && headChipsOn") && list.includes("artPoolOn && headChipsOn"), "两 chip 挂载条件带兜底闸（chip 挂卸+窄屏两态＋恒在）");
    // 页内恒等式注释锚（渲染位证明的静态面）
    assert(pageHead.includes("flex: 1, minWidth: 0"), "PageHead 标题块 flex:1 同款锚（右锚两侧同机制——会话页标题块与 PageHead 同式右锚）");
  }

  console.log(`\n========== mtopicons 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
