// #66 排查：ndjson 重放后 ext-ffdc 时间线为何缺失。用法: npx tsx scripts/replay-test.ts [sid前缀]
import { loadEvents, compactEvents, reduceHistory } from "../src/history.js";

const prefix = process.argv[2] ?? "ext-ffdc";
const prior = loadEvents(new URL("../data/events.ndjson", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const kept = compactEvents(prior);
const r = reduceHistory(kept);
console.log("prior events:", prior.length, "kept:", kept.length, "replayed sessions:", r.size);
const sid = [...r.keys()].find((k) => k.startsWith(prefix));
if (!sid) {
  console.log(prefix, "NOT in replay output");
} else {
  const rs = r.get(sid)!;
  console.log(sid.slice(0, 12), "logs:", rs.logs.length, "status:", rs.state.status);
  const kinds: Record<string, number> = {};
  for (const l of rs.logs) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  console.log("kinds:", JSON.stringify(kinds));
  const um = rs.logs.filter((l) => l.kind === "user_message");
  console.log("user_message entries:", um.length, um.slice(-2).map((u) => u.text.slice(0, 30)));
}
