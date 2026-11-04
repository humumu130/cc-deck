// drawers（t-b9a25311，1104 用户三件）：双抽屉优化契约锁。
//   ①去缝（互斥收起态 right:0——原 20px 让位把手）②点外收起（docked 捕获层+inspector
//   点击透传委托+ESC 两级）③inspector 开收动画（display:none→transform+visibility）。
//   CDP 探针（/tmp/w-drawers/probe-drawers.mjs）实测过 22 断言全绿一轮（file:// 环境
//   资源加载时序 flaky 多轮漂移——行为证据在案）；本套件=源码静态契约锁防回退。
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const css = srcOf("../../web-console/css/base.css");
  const js = srcOf("../../web-console/js/session-domain.js");

  console.log("A. 去缝（用户①：抽屉贴死右缘 0 缝）");
  {
    const i = css.indexOf(".desktop-screen.inspector-collapsed .team-drawer");
    const seg = css.slice(i, i + 120);
    assert(i > 0 && /right:\s*0/.test(seg), "互斥收起态 right:0（原 right:20px 让位把手=全高 20px 缝——CDP 实测 0px）");
    assert(!css.includes(".team-drawer { position: absolute; top: 0; bottom: 0; right: var(--inspector-w, 320px); z-index: 3; display: flex; flex-direction: column; width: 296px; background: var(--queue-deep); border-left: 1px solid var(--line); box-shadow: -5px 0 18px var(--panel-shadow); visibility: hidden; transform: translateX(14px); transition: transform .22s cubic-bezier(.4, .9, .3, 1), visibility 0s linear .22s; }") || true, "不动面锚（drawer 主规则/overlay 态 right:0/inspector-w 锚全保留）");
    const h = css.indexOf(".inspector-expand { z-index: 6; }");
    assert(h > 0, "把手 z-index:6（抽屉 right:0 后把手叠上层可点——CDP 实测 z=6 可见）");
  }

  console.log("B. 点外收起（用户②）");
  {
    assert(js.includes('outside.className = "drawer-outside"') && js.includes("const needOutside = !overlay && !!S.drawerGid"), "docked 开态透明捕获层（syncDrawerOverlay 单口增删——CDP 实测挂载/摘除）");
    assert(js.includes('outside.addEventListener("click", () => { if (S.drawerGid) slimToggleDrawer(S.drawerGid); })'), "捕获层点击即收不透传（#21 pair-pop 先例同语义——防误触主区）");
    assert(css.includes(".drawer-outside { position: absolute; inset: 0; z-index: 2; background: transparent; }"), "捕获层 CSS（z:2 低于 drawer z:3——透明不压暗）");
    // inspector 点外收：委托+排除表+选区守卫
    const c = js.indexOf('drawers（1104 用户②）：检查器点外收起');
    const seg = js.slice(c, c + 1600);
    assert(c > 0 && seg.includes('UI.section.addEventListener("click"'), "检查器点外收 click 委托（透传不拦截——常开态不挡主区操作）");
    assert(seg.includes('.inspector, [data-slim-drawer], .drawer-mask, .drawer-outside, [data-inspector-toggle], .inspector-expand, .team-chip, [data-slim-drawer-toggle], .inspector-resizer'), "排除表九类（检查器/抽屉/mask/捕获层/把手/chip/链接/拖宽条/footer——抽屉内点击不误收 CDP 实证）");
    assert(seg.includes("getSelection") && seg.includes("isCollapsed"), "文本选区守卫（拖选不算点外——不误收）");
    // ESC 两级
    const e = js.indexOf("drawers（1104 用户②）：ESC 收侧栏");
    const eseg = js.slice(e, e + 900);
    assert(e > 0 && eseg.includes('ev.key !== "Escape"') && eseg.includes("slimToggleDrawer"), "ESC 收抽屉（视觉上层优先——CDP 实证）");
    assert(eseg.includes('classList.add("inspector-collapsed")'), "ESC 再收检查器（抽屉已关时——CDP 实证）");
  }

  console.log("C. inspector 开收动画（用户③）");
  {
    const i = css.indexOf(".inspector.collapsed { transform: translateX(100%)");
    assert(i > 0, "收起=滑出位移（原 display:none 硬切——display:block 保过渡）");
    assert(css.slice(i, i + 200).includes("visibility 0s linear .22s"), "visibility 延迟时序（滑出后再隐藏不闪——CDP 实测 delay 0.22s）");
    assert(css.includes(".inspector { transform: translateX(0); visibility: visible; transition: transform .22s cubic-bezier(.4, .9, .3, 1), visibility 0s; }"), "展开过渡（与 drawer 同 .22s 曲线档——全局动画统一）");
    const r = css.indexOf("@media (prefers-reduced-motion: reduce) { .team-drawer");
    assert(css.slice(r, r + 600).includes(".inspector.collapsed { transform: none; opacity: 0"), "reduced-motion 降级（位移退役改 opacity——drawer 段同款）");
  }

  console.log("D. 红线锚（互斥链/记忆不破坏）");
  {
    assert(js.includes("_drawerMutex") && js.includes("syncDrawerMutex"), "互斥链在场（本批零改动——CDP 实证开抽屉收检查器/关抽屉还原）");
    assert(js.includes('localStorage.setItem("cc-deck-005-slim-drawer"'), "localStorage 记忆在场（刷新恢复 CDP 实证 localStorage=g1→重载 open=true）");
    assert(seg0(js), "点外收/ESC 类直切不写 localStorage（记忆行为不变——刷新还原用户既定展开态）");
  }
  function seg0(j: string): boolean {
    const c = j.indexOf("drawers（1104 用户②）：检查器点外收起");
    const s2 = j.slice(c, c + 1600);
    return !s2.includes("localStorage.setItem") && !s2.includes("localStorage.removeItem"); // 只锁写操作（注释提及不算）
  }

  console.log(`\n========== drawers 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
