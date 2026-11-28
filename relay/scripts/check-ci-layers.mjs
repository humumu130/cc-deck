#!/usr/bin/env node
// ci.json 三层闸（DEV-53，2026-11-28）：matrix / quarantine / watch 的结构与「迁出=入 watch」机械校验。
//
// 前史：DEV-38/R5① 矩阵单源化时这套校验内联在 .github/workflows/relay.yml matrix-guard
// job 的 node -e 里（拼写向/结构向两查）。DEV-53 加 watch 层时整体迁出为本文件——
// 校验逻辑可在本地以与 CI 完全相同的方式运行/测试，relay.yml 只保留薄调用。
//
// 用法：
//   node relay/scripts/check-ci-layers.mjs                 # 结构校验（三层注册/互斥/矩阵形态）
//   node relay/scripts/check-ci-layers.mjs --base origin/dev   # ＋迁出规则：基线 quarantine 与
//                                                           # 当前差集里的每个迁出键，必须
//                                                           # ①入 watch ②晋 matrix ③连 npm 注册
//                                                           # 一并退役（三居其一，否则 exit 1）
//   --emit-matrix  附带把 matrix JSON 写入 $GITHUB_OUTPUT 的 scripts= 行（CI matrix-guard 用）
//
// 「迁出=入 watch」语义边界（与 ci.json $comment 同口径）：
//   - 晋 matrix 是更强的盯守，视同满足；
//   - 连 package.json 注册一并删除＝整键退役（无测试可红），放行但在闸日志点名可见；
//   - 其余任何形态（留在原地消失/只删台账行/npm 注册还在却三层皆无）一律 exit 1。
// 基线取 merge-base(HEAD, --base)，PR 分支上即「分支点 vs HEAD」的净差异。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_JSON = path.join(REPO_ROOT, "relay", "tests", "ci.json");
const RELAY_PKG = path.join(REPO_ROOT, "relay", "package.json");
const RELAY_YML = path.join(REPO_ROOT, ".github", "workflows", "relay.yml");

const errors = [];
const notes = [];
const err = (msg) => errors.push(msg);
const note = (msg) => notes.push(msg);

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// ---------- 结构校验（等价承接原 matrix-guard 内联校验，新增 watch 面） ----------

function structuralChecks(ci, pkgScripts) {
  const matrix = ci.matrix;
  const quarantine = ci.quarantine;
  const watch = ci.watch;

  if (!Array.isArray(matrix) || matrix.length === 0) err("ci.json matrix 必须为非空数组");
  if (Array.isArray(matrix) && matrix.some((k) => typeof k !== "string")) err("ci.json matrix 含非字符串键");
  if (Array.isArray(matrix) && new Set(matrix).size !== matrix.length) err("ci.json matrix 含重复键");

  for (const [name, layer] of [["quarantine", quarantine], ["watch", watch]]) {
    if (layer === undefined || layer === null || typeof layer !== "object" || Array.isArray(layer)) {
      err(`ci.json ${name} 层缺失或非对象（DEV-53 起 watch 为必需节）`);
      continue;
    }
    const badValue = Object.entries(layer).filter(([, v]) => typeof v !== "string" || v.trim() === "");
    if (badValue.length) err(`ci.json ${name} 层含空/非字符串理由: [${badValue.map(([k]) => k).join(", ")}]`);
  }

  const qKeys = quarantine && typeof quarantine === "object" ? Object.keys(quarantine) : [];
  const wKeys = watch && typeof watch === "object" ? Object.keys(watch) : [];
  const overlapMQ = (matrix || []).filter((k) => qKeys.includes(k));
  if (overlapMQ.length) err(`键同时出现在 matrix 与 quarantine: [${overlapMQ.join(", ")}]`);
  const overlapMW = (matrix || []).filter((k) => wKeys.includes(k));
  if (overlapMW.length) err(`键同时出现在 matrix 与 watch（晋矩阵应从 watch 摘除）: [${overlapMW.join(", ")}]`);
  const overlapQW = qKeys.filter((k) => wKeys.includes(k));
  if (overlapQW.length) err(`键同时出现在 quarantine 与 watch: [${overlapQW.join(", ")}]`);

  // 拼写向（三层键都必须在 package.json 注册——quarantine/watch 键本地仍可跑）
  const bad = [...(matrix || []), ...qKeys, ...wKeys].filter((k) => !pkgScripts.has(k));
  if (bad.length) err(`ci.json 键未在 package.json 注册（拼写错/漂移）: [${bad.join(", ")}]`);

  // 结构向：防止手抄矩阵行回归（单源化前的旧形态）
  const yml = fs.readFileSync(RELAY_YML, "utf8");
  if (/script: *\[[^\]]/.test(yml)) err("relay.yml 检出内联矩阵清单（旧手抄形态回归）——矩阵只能由 relay/tests/ci.json 生成");
}

// ---------- 迁出规则（DEV-53 机械闸） ----------

function ciJsonAt(rev) {
  const out = execFileSync("git", ["show", `${rev}:relay/tests/ci.json`], {
    cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}

function exitRule(ci, pkgScripts, baseRef) {
  const mb = git(["merge-base", "HEAD", `${baseRef}^{commit}`]);
  let baseCi;
  try {
    baseCi = ciJsonAt(mb);
  } catch (e) {
    // 基线无 ci.json（史前提交，git show 退出非零）或 JSON 坏（SyntaxError）——无基线可比对时规则空转，但必须点名说明
    const missing = e && typeof e.status === "number" && e.status !== 0;
    note(`迁出规则：基线 ${mb.slice(0, 8)} 无可解析 ci.json（${missing ? "文件不存在" : "解析失败"}），差集空转`);
    return { exits: 0, violations: 0 };
  }
  const baseQ = baseCi.quarantine && typeof baseCi.quarantine === "object" ? Object.keys(baseCi.quarantine) : [];
  const headQ = ci.quarantine && typeof ci.quarantine === "object" ? Object.keys(ci.quarantine) : [];
  const exits = baseQ.filter((k) => !headQ.includes(k));

  let violations = 0;
  for (const k of exits) {
    if ((ci.watch || {})[k]) continue; // ①入 watch——规则正身
    if ((ci.matrix || []).includes(k)) { note(`迁出→晋矩阵（更强盯守，放行）: ${k}`); continue; } // ②晋 matrix
    if (!pkgScripts.has(k)) { note(`迁出→整键退役（npm 注册一并删，放行但点名可见）: ${k}`); continue; } // ③退役
    violations += 1;
    err(`迁出规则违背：${k} 已离开 quarantine，但既未入 watch、未晋 matrix、npm 注册仍在（「迁出=入 watch」机械闸，DEV-53）`);
  }
  return { exits: exits.length, violations };
}

// ---------- main ----------

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const baseRef = baseIdx !== -1 ? args[baseIdx + 1] : null;
const emitMatrix = args.includes("--emit-matrix");

let ci;
try {
  ci = JSON.parse(fs.readFileSync(CI_JSON, "utf8"));
} catch (e) {
  console.error(`ERR: relay/tests/ci.json JSON 解析失败: ${e.message}`);
  process.exit(1);
}
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(RELAY_PKG, "utf8"));
} catch (e) {
  console.error(`ERR: relay/package.json JSON 解析失败: ${e.message}`);
  process.exit(1);
}
const pkgScripts = new Set(Object.keys(pkg.scripts || {}));

structuralChecks(ci, pkgScripts);

let exitInfo = null;
if (baseRef) {
  exitInfo = exitRule(ci, pkgScripts, baseRef);
} else {
  note("迁出规则未跑（无 --base 基线）——CI/发布面必须带 --base origin/<目标分支> 调用");
}

for (const n of notes) console.log(`NOTE: ${n}`);
if (errors.length) {
  for (const e of errors) console.error(`ERR: ${e}`);
  console.error(`FAIL: 分层闸红（${errors.length} 项）`);
  process.exit(1);
}

if (emitMatrix) {
  const out = JSON.stringify(ci.matrix);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `scripts=${out}\n`);
  else console.log("(GITHUB_OUTPUT 未设置，仅校验不产出 matrix)");
}

const qn = Object.keys(ci.quarantine || {}).length;
const wn = Object.keys(ci.watch || {}).length;
console.log(
  `OK: 矩阵 ${ci.matrix.length} 键 / quarantine ${qn} 键 / watch ${wn} 键，三层全注册两两互斥` +
    (exitInfo ? `；迁出规则：基线差集 ${exitInfo.exits} 键全数合规（入 watch/晋矩阵/退役）` : ""),
);
