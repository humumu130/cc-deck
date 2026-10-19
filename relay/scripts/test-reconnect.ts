// W-RECONNECT：resume 快路径帧数帽断言（用户实锤「重进重连很久」主因修复）
// 行为级：emit 300 帧（旧阈值 200 之外、新 460 之内）→ replayAfter 完整返回——
// 旧版此场景退 SNAPSHOT 全量重建；另锚三消费点共享常量。
import { readFileSync } from "node:fs";
import { EventBus, REPLAY_FAST_MAX } from "../src/event-bus.js";

let pass = 0, fail = 0;
const check = (c: unknown, n: string, d = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n + (d ? " | " + d : "")); } };

check(REPLAY_FAST_MAX === 460, `R1 常量=460（贴 buffer 500 帽，覆盖面较旧 200 ×2.3）`, String(REPLAY_FAST_MAX));
check(REPLAY_FAST_MAX <= 500, "R2 ≤ EventBus 默认容量 500（replay 空集自然无害的边界前提）");

// 行为：300 帧（旧 200 之外）在 buffer 内 → replayAfter 全量返回（快路径不退化）
const bus = new EventBus();
for (let i = 1; i <= 300; i++) bus.emit("s-fake" as never, { seq: i } as never);
const replay = bus.replayAfter(0);
check(replay.length === 300, `R3 300 帧场景走快路径（旧阈值 200 会退 SNAPSHOT 重建=「重进很久」；现 replay 全量 ${replay.length} 帧）`, String(replay.length));
check(bus.isBeyondBuffer(0) === false, "R4 seq=0 仍在 buffer（isBeyondBuffer 不单向失聪此场景）");

// 三消费点共享常量源码锚（防字面回退）
for (const [f, n] of [["../src/ws-server.ts", "R5 LAN ws-server resume"], ["../src/cloud-client.ts", "R6 云桥 sealed resume"], ["../src/cloud-client.ts", "R7 云桥 wan watch resume"]] as const) {
  const src = readFileSync(new URL(`${f}`, import.meta.url), "utf8");
  check(src.includes("replay.length <= REPLAY_FAST_MAX"), `${n} 消费共享常量（无字面 200 回退）`);
}
const smOld = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
check(!smOld.includes("replay.length <= 200"), "R8 session-manager 无残留字面 200");

console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
process.exit(fail ? 1 : 0);
