// notify-overhaul（1101 用户令·三路审查合并单）断言：
//   B1 动效 token：--dur-*/--ease-*/--dist-* 入 :root + prefers-reduced-motion 降级段
//   A 组静态锚：计数单源（reconcile 分支不再跳 syncCounts——内容 bug 真根因）/时间
//     单轨（notifyRelTime 三档+window 共享）/kind badge 六类/行栅格 L1L2L3/去卡片化
//     行流（透明底+1px 分隔+左缘色条）/组头 sticky+组级清空/头 48 底 40/× hover 显
//   B 组静态锚：遮罩模态化+点外收起+ESC+Tab 锁/出入场 np-enter/np-exit 共享退场/
//     stagger（>6 封顶）/塌缩/pop/铃铛摆动/脉冲唯一位（面板开停）
//   三端：mobile rowOf kind badge+时间单轨同源
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

const js = readFileSync(join(repoRoot, "web-console/js/notify.js"), "utf-8");
const css = readFileSync(join(repoRoot, "web-console/css/base.css"), "utf-8");
const html = readFileSync(join(repoRoot, "web-console/index-005.html"), "utf-8");
const mob = readFileSync(join(repoRoot, "web-console/js/mobile.js"), "utf-8");

async function main() {
  // ---------- B1 token ----------
  section("\nB1 全局动效 token：");
  {
    for (const t of ["--dur-enter: 200ms", "--dur-exit: 130ms", "--dur-fast: 120ms", "--dur-move: 200ms", "--dist-s: 4px", "--dist-m: 8px"]) assert(css.includes(t), `token ${t.split(":")[0]} 落 :root`);
    assert(css.includes("--ease-out: cubic-bezier(.16, 1, .3, 1)"), "--ease-out 曲线");
    assert(css.includes("--ease-in: cubic-bezier(.4, 0, 1, 1)"), "--ease-in 曲线");
    assert(css.includes("--ease-spring: cubic-bezier(.34, 1.56, .64, 1)"), "--ease-spring 曲线");
    assert(css.includes("@media (prefers-reduced-motion: reduce)"), "reduced-motion 降级段在位");
    assert(css.includes("animation: none !important"), "降级=位移/脉冲/stagger 清零（仅留 opacity）");
  }

  // ---------- A1 计数单源（内容 bug 真根因） ----------
  section("\nA1 计数单源：");
  {
    assert(js.includes("syncCounts(actionRows.length);\n                      return;"), "reconcile 快路径 return 前调 syncCounts（旧版跳过=头部恒 0 与组头打脸的真根因）");
    const wi = js.indexOf("const waiting = bridge.waitingText()");
    const zc = js.indexOf("syncCounts(0)", wi);
    assert(wi >= 0 && zc > wi && zc < wi + 400, "waiting/降级分支计数归 0（头部与组头不打脸）");
    assert(js.includes("notify-badge-pop"), "计数变化 pop（220ms spring crossfade）");
  }

  // ---------- A2 时间单轨 ----------
  section("\nA2 时间单轨：");
  const fn = js.slice(js.indexOf("const notifyRelTime"), js.indexOf("const kindMetaOf"));
  const rel = eval("(" + fn.slice(fn.indexOf("("), fn.lastIndexOf("}") + 1).replace(/^const notifyRelTime[^=]*=/, "").trim() + ")");
  {
    assert(rel(Date.now() - 30_000) === "刚刚", "刚刚（<1min）");
    assert(rel(Date.now() - 5 * 60_000) === "5 分钟前", "分钟档（≤60min）");
    assert(rel(Date.now() - 3 * 3600_000) === "3 小时前", "小时档（<24h）");
    const d = new Date(Date.now() - 3 * 86400_000);
    assert(rel(d.getTime()) === (d.getMonth() + 1) + "月" + d.getDate() + "日", "更早=M月D日");
    assert(rel(0) === "" && rel(Date.now() + 60_000) === "", "空/未来时间静默");
    assert(js.includes("window.__ccDeck005NotifyRelTime"), "时间函数 window 共享（mobile 同源单点）");
    assert(!js.includes('relTime(row.ts)].filter(Boolean).join'), "正文内联时间退役（旧 sub 双轨清除）");
    assert(css.includes(".nrow .t .l1 .nrow-time") && css.includes("margin-left: auto"), "时间右贴 L1（11px tabular）");
  }

  // ---------- A3/A6 kind badge+行栅格 ----------
  section("\nA3/A6 kind badge 六色+行栅格：");
  {
    for (const k of ["waiting", "confirm", "dispatch", "acceptance", "system", "alarm"]) assert(css.includes(`.nbadge-${k} {`), `badge 类 nbadge-${k}`);
    assert(css.includes("height: 18px") && css.includes("border-radius: 4px"), "badge 规格（高 18/radius 4/11px 500）");
    assert(css.includes("rgba(245, 158, 11, .14)") && css.includes("rgba(167, 139, 250, .14)"), "badge bg=14% alpha（待办橙/确认紫）");
    assert(css.includes("html[data-theme=\"light\"] .nbadge-waiting"), "浅色 badge 亮色适配");
    assert(js.includes("nbadge nbadge-") && js.includes("+ km.badge +"), "行渲染带 kind badge（模板拼接）");
    assert(css.includes("-webkit-line-clamp: 2"), "标题 clamp2");
    assert(js.includes('title="' + escapeAttr() + '"') || js.includes("<b title="), "标题 tooltip 全文");
    assert(css.includes("grid-template-columns: 16px 1fr auto") && css.includes("gap: 10px"), "行栅格 16+gap10+尾列");
    assert(js.includes('↗</button>') === false, "»/↗ 引导符退役");
  }

  // ---------- A5 去卡片化行流 ----------
  section("\nA5 去卡片化行流：");
  {
    assert(css.includes("border-bottom: 1px solid color-mix") && css.includes("background: transparent"), "行透明底+1px 分隔（卡片退役）");
    assert(css.includes(".nrow:hover { background:"), "hover 提亮（120ms）");
    assert(css.includes("width: 2px; height: 16px"), "左缘语义色条 2×16");
    assert(css.includes(".nrow.alert::before") && css.includes(".nrow.warn::before"), "alert/warn 左缘色条");
    assert(!css.includes(".nrow.alert { border-color: var(--danger-line)"), "大面积红底 tint 退役");
    assert(css.includes("opacity: 0;") && css.includes(".nrow:hover .x"), "× 默认隐 hover 显（22×22 热区）");
  }

  // ---------- A7/A8 组头+头底栏 ----------
  section("\nA7/A8 组头 sticky+头底栏：");
  {
    assert(css.includes("position: sticky") && css.includes("backdrop-filter: blur(8px)"), "组头 sticky+blur 8");
    assert(css.includes("letter-spacing: .05em") && css.includes("font-size: 11px"), "组头 11px/600/.05em");
    assert(js.includes('data-notify-grp-clear'), "组级清空（hover 出现）");
    assert(html.includes('class="clr" type="button" data-notify-clear-soft') === false, "头部全局清空退役");
    assert(html.includes('class="np-head"') && css.includes("height: 48px"), "头部定高 48");
    assert(html.includes('class="np-foot"') && html.includes("查看全部通知") && css.includes("height: 40px"), "底栏 40 查看全部");
    assert(css.includes("mask-image: linear-gradient(180deg, transparent 0, #000 24px"), "滚动上下渐隐 mask 24px");
    assert(css.includes("::-webkit-scrollbar { width: 8px"), "主题滚动条宽 8");
  }

  // ---------- B2/B3 遮罩+出入场+ESC ----------
  section("\nB2/B3 遮罩点外收起+出入场+ESC：");
  {
    assert(css.includes("rgba(0, 0, 0, .42)") && css.includes("blur(6px) saturate(120%)"), "遮罩模态化（.42+blur+sat）");
    assert(js.includes("closePanel") && js.includes("keepVisual"), "三关闭路径共享退场（closePanel 单点）");
    assert(css.includes("@keyframes np-enter") && css.includes("@keyframes np-exit"), "出入场 keyframes（200ms out/130ms in）");
    assert(css.includes("transform-origin: 24px") && css.includes("calc(100% - 16px)"), "transform-origin 铃铛方向（左上）");
    assert(css.includes("pointer-events: none"), "退场期 pointer-events:none");
    assert(js.includes('ev.key === "Escape"'), "ESC 关闭（三路径之三）");
    assert(js.includes('ev.key === "Tab"') && js.includes("focusables"), "焦点 Tab 锁定（模态循环）");
    assert(js.includes("lastFocus") && js.includes("focus({ preventScroll: true })"), "焦点回落铃铛（关=还原触发钮）");
  }

  // ---------- B4/B5 stagger+微交互 ----------
  section("\nB4/B5 stagger+微交互：");
  {
    assert(css.includes(".np-body.np-stagger > .nrow") && css.includes("--st-i, 0) * 30ms"), "行 stagger +30ms（+50ms 起）");
    assert(css.includes('data-stagger-cap="1"]') && css.includes("np-fade 60ms"), ">6 张封顶 60ms 整体淡入");
    assert(js.includes("playStagger") && js.includes("Math.min(i, 12)"), "stagger 编排（面板开后播放）");
    assert(css.includes("nrow-collapse 160ms"), "单卡塌缩 160ms ease-in");
    assert(css.includes("bell-swing 420ms") && js.includes("bell-swing"), "铃铛摆动 420ms 一次性");
    assert(css.includes("ndot-pulse 2.4s") && css.includes("#d-notify.on .ngrp .ndot.r.np-pulse { animation: none"), "组级红点脉冲唯一位（面板开停）");
  }

  // ---------- 三端 ----------
  section("\nC 三端同语言：");
  {
    assert(mob.includes("nbadge-${km[1]}") && mob.includes("MB = { acceptance:"), "mobile kind badge 六色同源");
    assert(mob.includes("__ccDeck005NotifyRelTime"), "mobile 时间单轨共享桌面函数");
    assert(mob.includes('primary-btn" type="button" data-notify-mobile-jump') === false, "mobile primary-btn 大钮退役（轻钮统一）");
  }

  console.log(`\n========== notify-overhaul 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
function escapeAttr() { return "x"; }
void main();
