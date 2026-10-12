#!/usr/bin/env node
// W-P0-FIX P0-2 工具件②：六闸状态检查（docs/v2-dual-read-cutover.md §4 口径的机器可判面）。
// 切换（生产 json→sqlite 部署）前跑一次出闸门报告——全绿才呈用户拍板（生产变更铁律：
// 本脚本只读不改，切换动作永远不在本脚本内）。
// 闸门映射：闸1 shadow 长清零（读 shadow-diff.ndjson 近 7 天新增类差异）/ 闸2 parity
// （提示跑 test-m1-foundation + parity 套件，不在本脚本内跑）/ 闸3 写者收口（M1-3 状态
// 静态备案）/ 闸4 冷备份（找 pre-cutover-*.tar.gz + .sha256 对）/ 闸5 回退演练（提示
// rehearse:rollback）/ 闸6 性能（提示 bench 口径）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA = process.env.CCR_DATA_DIR || join(homedir(), ".cc-deck", "data");
const lines = [];
let red = 0;
const gate = (ok, label, detail = "") => {
  lines.push(`${ok ? "✅" : "🔴"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) red++;
};
console.log(`DB cutover 六闸检查（${new Date().toISOString()}）\n数据目录：${DATA}\n`);

// 闸1 shadow 长清零：shadow-diff.ndjson 近 7 天差异行（排除已备案有损映射面关键词）
const sd = join(DATA, "shadow-diff.ndjson");
if (!existsSync(sd)) {
  gate(false, "闸1 shadow 观察", "shadow-diff.ndjson 不存在（shadow 档未在生产开跑——七天空窗无从谈起）");
} else {
  const week = Date.now() - 7 * 86400e3;
  const BACKED = /trust_light|parked_at|archived_at|dispatch\.target|session_id.*投影/i;
  let fresh = 0, backed = 0;
  for (const line of readFileSync(sd, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = Number(row.ts || row.at || 0);
      if (ts >= week) (BACKED.test(line) ? backed++ : fresh++);
    } catch { fresh++; } // 坏行按新增类计（保守）
  }
  gate(fresh === 0, "闸1 shadow 长清零", `近 7 天：新增类差异 ${fresh} 行 / 已备案有损面 ${backed} 行`);
}

// 闸2 parity：提示跑套件（机器不代跑——套件需要干净基线 commit）
lines.push("⚠️  闸2 parity — 请在切换前 commit 上跑：npm run test:m1-foundation（H1 七轴）+ 六域 parity 套件");

// 闸3 写者收口（M1-3 StoragePort 写切换）：静态备案——写面未切前「旧 JSON 零新写」不成立
lines.push("🔴 闸3 写者收口 — M1-3 StoragePort 写切换未实施（DB-only 的本质项，系列工程另派单）");
red++;

// 闸4 冷备份：pre-cutover-*.tar.gz + 同名 .sha256 成对存在
const backups = existsSync(DATA) ? readdirSync(DATA).filter((f) => /^pre-cutover-.*\.tar\.gz$/.test(f)) : [];
const paired = backups.filter((f) => existsSync(join(DATA, f + ".sha256")));
if (backups.length === 0) {
  gate(false, "闸4 冷备份", "未找到 pre-cutover-*.tar.gz（跑 scripts/backup-pre-cutover.mjs）");
} else {
  const latest = String(backups.sort().at(-1) || "");
  const age = (Date.now() - statSync(join(DATA, latest)).mtimeMs) / 86400e3;
  gate(paired.includes(latest) && age <= 30, "闸4 冷备份", `最新 ${latest}（${age.toFixed(1)} 天前，sha256${paired.includes(latest) ? "成对" : "缺失"}）`);
}

// 闸5 回退演练：rehearse:rollback 已有脚本——提示最近一次跑（脚本自身 PASS 才算）
lines.push("⚠️  闸5 回退演练 — 跑 npm run rehearse:rollback（CUT-1 已绿；切换前再演一次）");

// 闸6 性能：提示 bench 口径（CUT-1 终裁 A+B 判据已备案）
lines.push("⚠️  闸6 性能 — 真实数据量级 bench（四读函数×1000 取样；CUT-1 终裁：绝对差≤50μs 或相对差≤20% 取宽者）");

console.log(lines.join("\n"));
console.log(`\n${red === 0 ? "机器可判闸全绿（人工闸见 ⚠️ 行）" : red + " 闸红——不满足切换条件"}`);
process.exit(red === 0 ? 0 : 1);
