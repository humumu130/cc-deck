// 把 stdin 同时写到文件和 stdout（窗口可见 + 留档排查）
import { createWriteStream } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tee-log.mjs <file>");
  process.exit(1);
}
const out = createWriteStream(file, { flags: "a" });
process.stdin.on("data", (chunk) => {
  out.write(chunk);
  process.stdout.write(chunk);
});
process.stdin.on("end", () => out.end());
