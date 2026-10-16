// W-MSGFIX2（#144）源头收紧行为锁：fullText 三态语义 + bridge 投影源码锚
import { fullText } from "../src/summarizer.js";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };

const short = "二十字以内的短消息不会带全文";
const mid = "a".repeat(301);
const long = "b".repeat(11_000);
check(fullText(short, 300) === undefined, "S1 短消息（≤cap）full=undefined（external 链不再投影 full——假折叠源头根修）");
check(fullText(mid, 300) === "a".repeat(301), "S2 超阈值带全文（>300 原样，≤10000）");
check(fullText(long, 300) === "b".repeat(9_999) + "…", "S3 超大全文帽 10000 截断+省略号");

const bridge = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
check(!/full: truncate\(/.test(bridge) && (bridge.match(/full: fullText\(/g) ?? []).length >= 8, "S4 bridge 六处 user_message 投影全部换 fullText（truncate 恒原串的冗余 full 清零）");
console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
process.exit(fail ? 1 : 0);
