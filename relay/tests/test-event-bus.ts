import { EventBus } from "../src/event-bus.js";
import type { Envelope } from "../src/types.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const bus = new EventBus({ capacity: 50 });

// 1. 实时订阅收到全部事件
const live: Envelope[] = [];
bus.subscribe((e) => live.push(e));

// 2. 发 120 条（容量 50，最老 70 条被裁掉）
for (let i = 0; i < 120; i++) {
  bus.emit("s1", "SESSION_UPDATED", { i });
}

assert(live.length === 120, `live listener got all 120 (got ${live.length})`);
assert(bus.lastSeq() === 120, `seq == 120 (got ${bus.lastSeq()})`);

// 3. 补发：last_seq=0 已在缓冲外 → 只能拿到最近 50 条，调用方应走快照
const fromZero = bus.replayAfter(0);
assert(fromZero.length === 50, `replayAfter(0) evicted to 50 (got ${fromZero.length})`);
assert(bus.isBeyondBuffer(0), "last_seq=0 detected as beyond buffer");
assert(!bus.isBeyondBuffer(100), "last_seq=100 within buffer");

// 4. 补发：last_seq=100 → 101..120 共 20 条，不丢不重
const from100 = bus.replayAfter(100);
assert(from100.length === 20, `replayAfter(100) == 20 (got ${from100.length})`);
assert(
  from100.every((e, idx) => e.seq === 101 + idx),
  "replayed seqs contiguous 101..120, no loss/dup/gap",
);

// 5. last_seq 最新 → 空补发
assert(bus.replayAfter(120).length === 0, "replayAfter(latest) empty");

// 6. seq 全程单调
const seqs = fromZero.map((e) => e.seq);
assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "seq strictly increasing in buffer");

console.log("\nEVENT-BUS TESTS PASSED");
