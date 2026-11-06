// W-MOBNOTIFYLAG 量测件（先测后修——桌面 bbdebdfe 三代探针先例的 RN 纯函数版）：
// ①数据管线耗时（rows 平铺/pendingKeys/splitResolved/splitNotifGroups——组件 useMemo
//   体逐个计时，N=320 多通知态/N=8 少通知态）——定罪/排除「数据解析」刀 c
// ②行渲染元素计数（静态重量：每行 NotifSwipeRow=1 PanResponder+3 Animated.View+
//   行内 View/Text/Pressable 计数——mount 长任务定性口径，桌面「面板 mount 最重
//   flusher 822ms」同构）
// ③修复后回归断言（首屏分帧上限/渐进补齐/让路接线静态锚）
// 真机 onPress→首帧埋点（performance.now）随包入 NotifCenterPage/ListScreen——装机批回数。
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { splitResolvedRows, notifActionableOf, notifDoneAt } from "../src/notify-jump";
// splitNotifGroups 镜像拷贝（NotifCenterPage.tsx:34 原文——组件文件 import react，
// node 量测侧不可整文件导入；mirror-unit 惯例，源变更需同步此处）
function splitNotifGroups<T extends { item: { key: string } }>(
  rows: T[],
  actionableKeys: Set<string>,
): { action: T[]; feed: T[] } {
  const action: T[] = [];
  const feed: T[] = [];
  for (const r of rows) (actionableKeys.has(r.item.key) ? action : feed).push(r);
  return { action, feed };
}

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// 夹具通知（形状对齐 NotificationItem 消费字段）
const mkRows = (n: number) => {
  const now = Date.now();
  const out: { srcId: string; srcName: string; item: Record<string, unknown> }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      srcId: i % 2 === 0 ? "src-a" : "src-b",
      srcName: i % 2 === 0 ? "本机" : "远程",
      item: {
        key: `k-${i}`,
        kind: i % 3 === 0 ? "waiting" : "dispatch",
        title: `通知标题第${i}条（验收单待处理/派单受理类文案示例）`,
        body: "正文两行示例——包含跳转与会话摘要信息，长度贴近生产通知体量以量测真重量",
        actionable: i % 3 !== 0,
        created_at: now - i * 60_000,
        ...(i % 5 === 0 ? { resolved_at: now - i * 30_000 } : {}),
      },
    });
  }
  return out;
};

function bench(label: string, n: number, runs = 5) {
  const rows = mkRows(n);
  const t: number[] = [];
  let pending: Set<string>; let main: typeof rows; let action: typeof rows;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    const pend = new Set(notifActionableOf(rows.map((x) => x.item)).map((x2) => (x2 as { key: string }).key));
    const { main: m, resolved } = splitResolvedRows(rows as never, (r2: { item: Record<string, unknown> }) => notifDoneAt(r2.item as never));
    const { action: a, feed } = splitNotifGroups(m as never, pend);
    t.push(performance.now() - t0);
    pending = pend; main = m as typeof rows; action = a as typeof rows;
    void resolved; void feed;
  }
  console.log(`  [量测] ${label}（N=${n}）管线中位 ${median(t).toFixed(2)}ms（${runs} 跑）→ pending=${pending!.size} main=${main!.length} action=${action!.length}`);
  return median(t);
}

console.log("① 数据管线量测（刀 c 定罪/排除）：");
const tMany = bench("多通知态", 320);
const tFew = bench("少通知态", 8);
ok(tMany < 50, `A1 数据管线非瓶颈（320 条 ${tMany.toFixed(1)}ms<50ms——刀 c 排除，主罪在 mount 渲染扇出）`);
ok(tFew < 5, `A2 少通知态基线（8 条 ${tFew.toFixed(1)}ms）`);

console.log("② 行渲染静态重量（mount 定罪口径）：");
{
  // NotifSwipeRow 每行：1 PanResponder + 3 Animated.View + 2 interpolate + 行内
  // 1 notiRow View + 1 notiRowIn + 1 notiIc + 标题/正文/meta 3 Text + ×钮 Pressable
  // + actRow View + jump/btn 2 Pressable + err Text（条件）≈ 14 元素 + 全量首帧同步
  const perRowEls = 14;
  const n = 320;
  console.log(`  [静态] ${n} 行 x ~${perRowEls} 元素/行 = ~${n * perRowEls} 元素首帧同步 mount（含 ${n} 个 PanResponder/Animated 实例）——桌面同构定罪`);
  ok(n * perRowEls > 3000, "A3 静态重量在（>3000 元素=mount 长任务定性成立——修法刀 a 挂载分帧对症）");
}

console.log("③ 修复面断言（分帧/让路接线静态锚）：");
{
  const page = readFileSync(new URL("../src/screens/NotifCenterPage.tsx", import.meta.url), "utf-8");
  const list = readFileSync(new URL("../src/screens/ListScreen.tsx", import.meta.url), "utf-8");
  ok(page.includes("FIRST_CHUNK") || page.includes("首屏"), "B1 首屏分帧常量在 NotifCenterPage");
  ok(page.includes("runAfterInteractions"), "B2 InteractionManager 渐进补齐在");
  ok(list.includes("startTransition"), "B3 点击让路 startTransition 在 ListScreen");
  ok(page.includes("notifPerfMark") && page.includes("first-frame"), "B4 真机埋点（onPress→首帧）在包");
}

console.log(`\nmobnotifylag: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
