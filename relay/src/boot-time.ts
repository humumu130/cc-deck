// W-BOOTFAST（#45 升格，1104 用户点名）：boot 阶段计时打点——「不取证不优化」的
// 取证基建兼回归基线（验收点⑥）。CCR_BOOT_TIME=0 可关（默认开）；mark() 累计分段，
// bootDone() 出 stdout 一行汇总（给后续冷启动回归对账）。零依赖纯函数，测试/生产
// 共用；进程起点取模块加载时刻（index.ts 首行 import 即锚定，node 启动开销含在内）。
const t0 = Date.now();
const marks: { at: number; label: string }[] = [];
let enabled = process.env.CCR_BOOT_TIME !== "0";

export function bootMark(label: string): void {
  if (!enabled) return;
  marks.push({ at: Date.now(), label });
}

/** boot 结束汇总（首份 SNAPSHOT 就绪/boot 全链收口时调一次）。返回总耗时 ms。 */
export function bootDone(): number {
  const total = Date.now() - t0;
  if (!enabled) return total;
  const parts: string[] = [];
  let prev = t0;
  for (const m of marks) {
    if (m.at > prev) parts.push(`${m.label}=${m.at - prev}ms`);
    prev = m.at;
  }
  parts.push(`tail=${Date.now() - prev}ms`);
  console.log(`[boot-time] 总 ${total}ms｜${parts.join(" ")}`);
  return total;
}

export function bootElapsed(): number {
  return Date.now() - t0;
}
