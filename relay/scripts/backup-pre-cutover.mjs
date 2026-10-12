#!/usr/bin/env node
// W-P0-FIX P0-2 工具件①：切换冷备份（docs/v2-dual-read-cutover.md §5 口径）。
// 生产 relay 实际切换（json→sqlite 读档部署）前一次性全量快照 <orgDir> 与 <dataDir>。
// 形态：tar 归档 + sha256 清单；命名 pre-cutover-<date>-<git-sha>.tar.gz；存数据目录旁路
// （不进 git）；保留 ≥30 天（删除需用户发话）。本脚本只做备份，不执行任何切换。
// 用法：node scripts/backup-pre-cutover.mjs [--org <dir>] [--data <dir>] [--out <dir>] [--dry]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = args.includes("--dry");
const ORG = argOf("--org", join(homedir(), ".cc-deck", "org"));
const DATA = argOf("--data", join(homedir(), ".cc-deck", "data"));
const OUT = argOf("--out", DATA);

for (const d of [ORG, DATA]) {
  if (!existsSync(d)) {
    console.error(`❌ 目录不存在: ${d}（--org/--data 指定）`);
    process.exit(1);
  }
}
let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
} catch { /* 仓外运行 */ }
const stamp = new Date().toISOString().slice(0, 10);
const name = `pre-cutover-${stamp}-${gitSha}.tar.gz`;
const outPath = join(OUT, name);

// 备份面（§5）：orgDir 全量 + dataDir 关键持久件（events/notifications/acceptances/boards/
// confirms/deliverables + 各 store json；排除临时与运行态：*.pid/lock/tmp/chrome 等）
const dataPicks = [
  "events.ndjson", "notifications", "acceptances", "boards", "confirms", "deliverables.json",
  "deliverables", "pinned-sessions.json", "title-overrides.json", "settings.json", "collab-mode.json",
  "artifacts-index.json", "shadow-diff.ndjson", "relay.pid",
].filter((f) => existsSync(join(DATA, f)));

const tarArgs = ["-czf", outPath, "-C", join(ORG, ".."), basename(ORG)];
for (const f of dataPicks) tarArgs.push("-C", DATA, f);
console.log(`[backup] org=${ORG} data=${DATA}（${dataPicks.length} 件）→ ${outPath}`);
if (DRY) {
  console.log("[dry] tar " + tarArgs.join(" "));
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
try {
  execFileSync("tar", tarArgs, { stdio: "inherit" });
} catch (e) {
  console.error("❌ tar 失败:", e.message);
  process.exit(1);
}
// sha256 清单（§5：归档+清单成对）
const sha = execFileSync("shasum", ["-a", "256", outPath], { encoding: "utf8" }).trim();
const manifestPath = outPath + ".sha256";
writeFileSync(manifestPath, sha + "\n" + `# org=${ORG}\n# data=${DATA}\n# picks=${dataPicks.join(",")}\n# created=${new Date().toISOString()}\n# 保留≥30天（删除需用户发话——cutover §5）\n`, "utf-8");
const size = (statSync(outPath).size / 1048576).toFixed(1);
console.log(`✅ 冷备份就位：${name}（${size}MB）\n   ${sha}\n   清单：${manifestPath}`);
