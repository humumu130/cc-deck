// [W-BOARDTRUTH] 真机 dry-run（验收 3）：读生产板仓+台账+gh PR 真值→三判定处置清单（只读不写）
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
const orgDir = join(homedir(), ".cc-deck", "org");
const prRaw = execFileSync("gh", ["pr", "list", "--state", "all", "--json", "number,state,url,headRefName,title", "--limit", "100"], { encoding: "utf-8", timeout: 15000, env: { ...process.env, https_proxy: process.env.https_proxy || "http://127.0.0.1:7890", HTTPS_PROXY: process.env.HTTPS_PROXY || "http://127.0.0.1:7890" } });
const prs = JSON.parse(prRaw);
const openPrs = prs.filter((p) => p.state === "open");
console.log(`gh 真值：全态 ${prs.length} 个 PR（open ${openPrs.length}）`);
// 判定内联（与 board-truth.ts 同口径——mjs 不 import ts）
const branchBaseOf = (b) => String(b || "").replace(/-?r\d+$/, "");
const superseded = (open, mergedBranch, mergedNumber) => {
  const base = branchBaseOf(mergedBranch); const slug = base.split("/").pop();
  return open.filter((pr) => pr.number !== mergedNumber && branchBaseOf(pr.headRefName) === base && (pr.headRefName === mergedBranch || String(pr.title || "").toLowerCase().includes(slug.toLowerCase())));
};
// 板仓扫：审查中带 pr_url 的卡 × PR 真值
const boardsDir = join(orgDir, "boards");
let reviewCards = 0, mergedMissed = [], closedStale = [];
for (const f of readdirSync(boardsDir).filter((x) => x.endsWith(".json"))) {
  const b = JSON.parse(readFileSync(join(boardsDir, f), "utf-8"));
  for (const e of b.entries || []) {
    if (e.status !== "submitted" && e.status !== "ready_to_install") continue;
    if (!String(e.pr_url || "").startsWith("https://")) continue;
    reviewCards += 1;
    const pr = prs.find((p) => p.url === e.pr_url);
    if (!pr) continue;
    if (pr.state === "merged") mergedMissed.push(`${e.id}(${e.dispatch_id || "?"}) ← PR#${pr.number}`);
    if (pr.state === "closed") closedStale.push(`${e.id}(${e.dispatch_id || "?"}) ← PR#${pr.number}`);
  }
}
console.log(`审查中带 PR 卡：${reviewCards} 张`);
console.log(`刀3 处置清单：merged 补翻 ${mergedMissed.length} 张${mergedMissed.length ? "（" + mergedMissed.join("、") + "）" : ""}｜closed 退回 ${closedStale.length} 张${closedStale.length ? "（" + closedStale.join("、") + "）" : ""}`);
// 刀2：台账未认领超阈
const log = readFileSync(join(orgDir, "dispatch-log.ndjson"), "utf-8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const last = new Map();
for (const r of log) if (r.id) last.set(r.id, r);
const now = Date.now();
const staleDispatch = [...last.values()].filter((r) => (r.status === "queued" || r.status === "dispatched") && r.ts && now - r.ts > 6 * 3600_000);
console.log(`刀2 处置清单：未认领超 6h 撤单 ${staleDispatch.length} 单${staleDispatch.length ? "（" + staleDispatch.slice(0, 5).map((x) => x.id.slice(0, 8) + "@" + x.status).join("、") + "）" : ""}`);
// 刀1：最近 merged PR 的同链残留（演示面——真实闭在 merged 事件时）
const recentMerged = prs.filter((p) => p.state === "merged").slice(0, 3);
for (const m of recentMerged) {
  const hits = superseded(openPrs, m.headRefName, m.number);
  if (hits.length) console.log(`刀1 演示：#${m.number}(${m.headRefName}) 若再收 merged→将闭 ${hits.map((x) => "#" + x.number).join(",")}`);
}
console.log("dry-run 完（只读零写——生产处置随 relay 新代码上线自动跑）");
