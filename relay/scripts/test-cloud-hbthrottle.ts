// DL-P1-6 云桥心跳阈值+route-miss 退避专项（2026-11-27 夜间缺陷台账）：
// ①协议层判死从单窗 24s 无回包改连续 N 窗（缺省 2≈48s）——生产实证 heartbeat
//   timeout 每 15-20min 一次的节律性断连（CF 边缘延迟尖峰被当链路死，terminate-
//   reconnect downtime ~4.8s/次且触发设备 auto-resume 与恢复死循环互为放大器）；
// ②route miss 补发退避——反复三振出局（park）设备补发延迟指数退避（8s→128s 封顶），
//   防 miss→park→unpark→miss 乒乓（wb-c896f2f3699b9e94 全天 ≥6 轮实证）。
// 纯函数面直测 + 判死条件/退避接线源码锚（行为级哑链路判死由 test-cloud 用例 24
// 覆盖——本批未动应用层 3 轮 hb 语义）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pongMissLimit, routeRetryDelayMs } from "../src/cloud-client.js";

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };

// ---------- ① pongMissLimit：协议层判死连续窗数 ----------
{
  delete process.env.CCR_CLOUD_PONG_MISS_N;
  assert(pongMissLimit() === 2, "缺省 N=2（~48s 无回包才断——单窗尖峰容忍）");
  process.env.CCR_CLOUD_PONG_MISS_N = "1";
  assert(pongMissLimit() === 1, "env=1 → 旧单窗行为（逃生门）");
  process.env.CCR_CLOUD_PONG_MISS_N = "3";
  assert(pongMissLimit() === 3, "env=3 → 三窗容忍（慢桥环境调宽）");
  process.env.CCR_CLOUD_PONG_MISS_N = "abc";
  assert(pongMissLimit() === 2, "非法值回落缺省 2");
  process.env.CCR_CLOUD_PONG_MISS_N = "0";
  assert(pongMissLimit() === 2, "0/负值不收（下限 1——0 会永不判死，半开 TCP 永挂）");
  delete process.env.CCR_CLOUD_PONG_MISS_N;
}

// ---------- ② routeRetryDelayMs：三振史厚退避 ----------
{
  assert(routeRetryDelayMs(0) === 8_000, "无前科：8s 照旧（首犯零惩罚）");
  assert(routeRetryDelayMs(1) === 16_000, "1 次三振史：16s");
  assert(routeRetryDelayMs(2) === 32_000, "2 次：32s");
  assert(routeRetryDelayMs(3) === 64_000, "3 次：64s");
  assert(routeRetryDelayMs(4) === 128_000, "4 次：128s 封顶");
  assert(routeRetryDelayMs(9) === 128_000, "超 4 次：128s 封顶（指数不失控）");
  assert(routeRetryDelayMs(-1) === 8_000, "负值钳 0（8s）");
}

// ---------- ③ 接线源码锚（判死条件消费 missN/退避消费 park 史） ----------
{
  const src = readFileSync(join(process.cwd(), "src", "cloud-client.ts"), "utf8");
  assert(src.includes("silenceMs > 24_000 * missN"), "判死阈值=24s×N（连续窗语义接线）");
  assert(src.includes("routeRetryDelayMs(parks.length)"), "补发延迟消费 30min 滑窗 park 史");
  assert(src.includes("deviceParkAt.set(to,"), "park 时刻入账（滑窗退避依据）");
  assert(!src.includes("> 24_000 && Date.now() - this.lastRecv > 24_000) {"), "旧单窗判死条件退役（无裸 24s 直断残留）");
}

console.log(`\n== test-cloud-hbthrottle 汇总：${pass} ok / ${fail} FAIL ==`);
if (fail > 0) process.exit(1);
