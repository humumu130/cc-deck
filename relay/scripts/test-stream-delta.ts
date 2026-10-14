// W-STREAMDELTA（#94）断言：deriveStreamFrame 纯函数四态 + 开关 + 链路静态锚
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-stream-delta.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStreamFrame, STREAM_DELTA_ENV } from "../src/bridge.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const web = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");
const store = readFileSync(join(root, "expo-app", "src", "store.ts"), "utf-8");
const mgr = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log("  ok " + n); } else { fail++; console.log("  FAIL " + n); } };

console.log("== W-STREAMDELTA: 外部会话终端流帧 ==");
// ① 纯尾部追加：stable，新行并入
const a = deriveStreamFrame(["A", "B"], ["A", "B", "C"]);
ok(a.stable && a.lines.join() === "A,B,C", "① 纯尾部追加 stable 并入");
// ② 行数收缩（清屏/重绘）：unstable 保持旧帧
const b = deriveStreamFrame(["A", "B", "C"], ["X"]);
ok(!b.stable && b.lines.length === 3, "② 行数收缩 unstable 跳帧");
// ③ 前缀漂移：unstable
const c = deriveStreamFrame(["A", "B"], ["A2", "B", "C"]);
ok(!c.stable, "③ 前缀漂移 unstable 跳帧");
// ④ 首捕（prev null）：全量 stable
const d = deriveStreamFrame(null, ["A"]);
ok(d.stable && d.lines.length === 1, "④ 首捕全量 stable");
// ⑤ 开关：缺省开 / =0 关
process.env.CCR_STREAM_DELTA = undefined;
const on1 = STREAM_DELTA_ENV();
process.env.CCR_STREAM_DELTA = "0";
ok(on1 && !STREAM_DELTA_ENV(), "⑤ CCR_STREAM_DELTA 缺省开、=0 关");
// ⑥ 链路静态锚：PATCH 帧 relay 发+双端消费+同 id 流帧
ok(mgr.includes('"SESSION_LOG_PATCH"') && mgr.includes("removeExternalLog"), "⑥ relay PATCH 帧与撤块口");
ok(web.includes('case "SESSION_LOG_PATCH": onLogRemove'), "⑥ web PATCH 消费（timelines 删+DOM 移除）");
ok(store.includes('case "SESSION_LOG_PATCH"'), "⑥ expo PATCH 消费");
ok(mgr.includes("streaming?: boolean"), "⑥ pushExternalLog meta.streaming 透传");
console.log(fail ? `stream-delta: ${fail} FAILED` : `stream-delta: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
