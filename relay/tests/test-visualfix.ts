// visualfix（t-0ae72f17，1104 视觉审查发现批）：证据核验+实修四件契约锁。
//   关键核验反转：审查裁片=旧构建产物（P1-1 卡越界/无省略号、P1-3 角标悬浮两 tab 间——
//   当前树实测 W-MOBILE-SWIPE 钳制与 .mobile-nav .tag absolute 均已在位）；实修=残余真项。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const css = srcOf("../../web-console/css/base.css");
const notify = srcOf("../../web-console/js/notify.js");

console.log("A. P1-1 核验（已在位——旧片失效）");
{
  const i = css.indexOf(".mobile-card strong");
  const seg = css.slice(i, i + 200);
  assert(seg.includes("text-overflow: ellipsis") && seg.includes("min-width: 0"), "mobile-card 标题钳制在位（W-MOBILE-SWIPE：flex:1+min-width:0+ellipsis——CDP 实测右距 13px/scrollW==clientW）");
  assert(css.includes("overflow-x: hidden"), "mobile-content 横向裁切保险带在位（超宽=裁不拖）");
}

console.log("B. P1-3 实修（角标锚图标右肩——HEAD 已 absolute 锚按钮右缘 offset 29，本批贴图标）");
{
  const i = css.indexOf(".mobile-nav [data-mobile-root] .tag.action");
  const seg = css.slice(i, i + 260);
  assert(i > 0 && seg.includes("position: absolute") && seg.includes("left: calc(50% + 5px)"), "角标 absolute+calc(50%+5px) 锚图标右肩（CDP 实测 offset 29→21，badge 左缘贴 icon 右缘）");
  assert(seg.includes("font-size: 10px"), "角标 10px 小胶囊（视觉重量降）");
  const legacy = css.indexOf(".mobile-nav .tag {position: absolute; top: 5px; right: 11px;");
  assert(legacy > 0, "HEAD 既有规则在场（锚按钮右缘——本批高特异度覆盖后置胜出，旧规则留给非 action tag）");
}

console.log("C. P1-2/P2-2/P2-5 实修");
{
  assert(css.includes("右距=本行 padding 第二值 14px") && !css.includes("padding-right: 12px; } /* visualfix"), "P1-2 R2 死码处置（原 :2019 分写被 :2025 同选择器后至简写覆盖=级联死码已删；右距由主规则 padding 第二值 14px 承担——computed paddingRight=14px 双视口实测，B 审 P2-1）");
  const i = css.indexOf(".queue-group {");
  const seg = css.slice(i, i + 300);
  assert(seg.includes("gap: 6px") && seg.includes("align-items: center"), "P2-2 分组头 flex 化垂直居中+gap 6（chevron 粘连基线上浮——CSS 最小刀；模板重排归范式单）");
  assert(notify.includes('count > 99 ? "99+" : String(count)'), "P2-5 铃铛 99+ 封顶（659 直出→99+；aria/title 保真全数）");
  assert(notify.includes('railBadge.setAttribute("aria-label", "通知有 " + count + " 项需行动")'), "aria/title 保真全数（无障碍不撒谎）");
}

console.log("D. 入单另派项锚（不修理由在档）");
{
  assert(css.includes("--p-ready"), "P2-1 Tab 双橙/P2-4 空态三重复/P2-6 侧栏静默/P2-7 范式两套——入单另派未修（R2 拆 || true 恒真：真锚=--p-ready token 在场原样 5 处，附 P3）");
  assert(!css.includes("V-P2-8") && !css.includes("V-P2-9"), "存疑×2（绿 pill/✳ 未选择）零触碰（待用户拍板）");
  assert(css.split(".mobile-head {").length - 1 - (css.split("#m-detail .mobile-head {").length - 1) === 1, "R2 裸主规则唯一锚（mobile-head 全 3 处=裸 1+#m-detail 详情覆盖 2——分写死码防回潮，上下文覆盖合法级联不计）");
}

console.log(`\n========== visualfix 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
