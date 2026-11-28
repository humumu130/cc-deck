#!/usr/bin/env node
// ci.json 三层闸（DEV-53，2026-11-28）：matrix / quarantine / watch 的结构与「迁出=入 watch」机械校验。
//
// 前史：DEV-38/R5① 矩阵单源化时这套校验内联在 .github/workflows/relay.yml matrix-guard
// job 的 node -e 里（拼写向/结构向两查）。DEV-53 加 watch 层时整体迁出为本文件——
// 校验逻辑可在本地以与 CI 完全相同的方式运行/测试，relay.yml 只保留薄调用。
//
// 用法：
//   node relay/scripts/check-ci-layers.mjs                 # 结构校验（三层注册/互斥/矩阵形态/
//                                                           # 反向注册/minMatrix 地板）
//   node relay/scripts/check-ci-layers.mjs --base origin/dev   # ＋三层出层规则（三向）：
//                                                           # ①quarantine 出层键必须 a)入 watch
//                                                           # b)晋 matrix c)连 npm 注册一并退役
//                                                           # （三居其一，否则 exit 1）
//                                                           # ②watch 出层键必须 a)晋 matrix
//                                                           # b)回 quarantine c)连 npm 注册一并
//                                                           # 退役（三居其一，否则 exit 1——
//                                                           # watch→void 对称闸，DEV-42 补：
//                                                           # 原闸只守 quarantine 方向，watch
//                                                           # 层可被静默清空）
//                                                           # ③matrix 出层键必须 a)入 quarantine
//                                                           # （降级定罪）b)入 watch（降级盯守）
//                                                           # c)连 npm 注册一并退役（三居其一，
//                                                           # 否则 exit 1——matrix→void 反向差集，
//                                                           # DEV-55 补：DEV-38 审查 P3.3
//                                                           # 「matrix 键被删无机械校验」缺口）
//   --emit-matrix  附带把 matrix JSON 写入 $GITHUB_OUTPUT 的 scripts= 行（CI matrix-guard 用）
//
// 「迁出=入 watch」语义边界（与 ci.json $comment 同口径）：
//   - 晋 matrix 是更强的盯守，视同满足；
//   - 连 package.json 注册一并删除＝整键退役（无测试可红），放行但在闸日志点名可见；
//   - 其余任何形态（留在原地消失/只删台账行/npm 注册还在却三层皆无）一律 exit 1。
// 「watch→void 对称」语义边界：watch 键被摘除＝「矩阵外必须有人盯」的第二段失守——
// 只有晋 matrix（更强盯守）/回 quarantine（重返定罪台账，红绿有账）/整键退役三条合法路。
// 「matrix→void 反向差集」语义边界（DEV-55）：matrix 键被摘除＝CI 盯守面静默缩水——只有
// 降级 quarantine（重返定罪台账）/降级 watch（本地盯守腿仍在）/整键退役三条合法路；合法
// 降级仍须同步显式下调 ci.json minMatrix 地板（否则结构面地板红——降地板是 reviewed diff
// 可见的显式动作，不可静默）。
// 反向注册（DEV-55，结构面常开）：package.json 每个 test:* 键必须三层居其一——堵「注册了
// 却三层皆无」的盲区（DEV-38 单源化前历史遗留 80 键的成因类）。新键从创建起就必须登记。
// minMatrix 地板（DEV-55，结构面常开）：ci.json 显式 minMatrix 值，matrix 键数不得低于它——
// 删键/漏键即使躲过差集（无 --base 的本地裸跑）也过不了地板。
// 基线取 merge-base(HEAD, --base)，PR 分支上即「分支点 vs HEAD」的净差异；--base 不可
// 解析时干净红面退出（不裸栈崩——本地裸用口径，DEV-42 P3）。

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

  // 反向注册（DEV-55）：package.json 每个 test:* 键必须三层居其一——「注册却三层皆无」
  // 即裸奔（80 键盲区的成因类），常开结构面堵死。
  const orphans = [...pkgScripts].filter((k) => k.startsWith("test")).filter((k) => !(matrix || []).includes(k) && !qKeys.includes(k) && !wKeys.includes(k));
  if (orphans.length) err(`package.json test:* 键未入任何层（三层皆无——新键须登记 ci.json，历史裸奔键见 docs/night-audit/ci-key-audit-2026-11-28.md）: [${orphans.join(", ")}]`);

  // minMatrix 地板（DEV-55）：matrix 键数不得低于 ci.json 显式地板——matrix 被静默删键/
  // 漏键，即使无 --base 差集可比（本地裸跑），地板也红。降地板＝reviewed diff 显式动作。
  const minMatrix = ci.minMatrix;
  if (!Number.isInteger(minMatrix) || minMatrix <= 0) {
    err(`ci.json minMatrix 缺失或非正整数（DEV-55 起为必需字段——matrix 键数地板）`);
  } else if (Array.isArray(matrix) && matrix.length < minMatrix) {
    err(`ci.json matrix 键数 ${matrix.length} 低于地板 minMatrix ${minMatrix}（键被删或 ci.json 未随迁——合法降级须同步显式下调地板）`);
  }

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
  let mb;
  try {
    mb = git(["merge-base", "HEAD", `${baseRef}^{commit}`]);
  } catch (e) {
    // P3（DEV-42）：--base 坏 ref/不可解析——干净红面（fail-closed 方向不变，不裸栈崩；relay.yml 有 cat-file 前置防御，此为本地裸用口径）
    const why = e instanceof Error ? (e.message || "").split("\n")[0] : String(e);
    err(`迁出规则：--base ${baseRef} 不可解析（merge-base 失败：${why}）`);
    return { exits: 0, violations: 1, watchExits: 0, watchViolations: 0, matrixExits: 0, matrixViolations: 0 };
  }
  let baseCi;
  try {
    baseCi = ciJsonAt(mb);
  } catch (e) {
    // 基线无 ci.json（史前提交，git show 退出非零）或 JSON 坏（SyntaxError）——无基线可比对时规则空转，但必须点名说明
    const missing = e && typeof e.status === "number" && e.status !== 0;
    note(`迁出规则：基线 ${mb.slice(0, 8)} 无可解析 ci.json（${missing ? "文件不存在" : "解析失败"}），差集空转`);
    return { exits: 0, violations: 0, watchExits: 0, watchViolations: 0, matrixExits: 0, matrixViolations: 0 };
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

  // ---------- watch→void 对称闸（DEV-42，DEV-53 审查 P2 补）：键离开 watch 须三居其一 ----------
  // 原闸只守 quarantine 出层方向——watch 层可被静默清空（空 {} 过结构闸），「矩阵外必有人
  // 盯」的第二段保障此前只靠 reviewed diff 可见性。对称规则：摘除 watch 键的三条合法路 =
  // 晋 matrix（更强盯守）/回 quarantine（重返定罪台账）/连 npm 注册退役（无测试可红）。
  const baseW = baseCi.watch && typeof baseCi.watch === "object" ? Object.keys(baseCi.watch) : [];
  const headW = ci.watch && typeof ci.watch === "object" ? Object.keys(ci.watch) : [];
  const watchExits = baseW.filter((k) => !headW.includes(k));

  let watchViolations = 0;
  for (const k of watchExits) {
    if ((ci.matrix || []).includes(k)) { note(`watch 迁出→晋矩阵（更强盯守，放行）: ${k}`); continue; } // ①晋 matrix
    if ((ci.quarantine || {})[k]) { note(`watch 迁出→回 quarantine（重返定罪台账，红绿有账，放行）: ${k}`); continue; } // ②回 quarantine
    if (!pkgScripts.has(k)) { note(`watch 迁出→整键退役（npm 注册一并删，放行但点名可见）: ${k}`); continue; } // ③退役
    watchViolations += 1;
    err(`watch 迁出规则违背：${k} 已离开 watch，但既未晋 matrix、未回 quarantine、npm 注册仍在（watch→void 对称闸，DEV-42）`);
  }

  // ---------- matrix→void 反向差集（DEV-55，DEV-38 审查 P3.3 补）：键离开 matrix 须三居其一 ----------
  // 原闸只守 quarantine/watch 出层方向——matrix 键被删（CI 盯守面静默缩水）无机械校验，
  // 只剩结构面 minMatrix 地板兜底（本地裸跑可见）。差集规则补齐带基线方向的同类守卫：
  // 摘除 matrix 键的三条合法路 = 降级 quarantine（重返定罪台账）/降级 watch（本地盯守腿）/
  // 连 npm 注册退役（无测试可红）。合法降级仍须显式下调 minMatrix（结构面拦截静默缩水）。
  const baseM = Array.isArray(baseCi.matrix) ? baseCi.matrix : [];
  const matrixExits = baseM.filter((k) => !(ci.matrix || []).includes(k));

  let matrixViolations = 0;
  for (const k of matrixExits) {
    if ((ci.quarantine || {})[k]) { note(`matrix 迁出→降级 quarantine（重返定罪台账，红绿有账——注意同步下调 minMatrix 地板）: ${k}`); continue; } // ①降级 quarantine
    if ((ci.watch || {})[k]) { note(`matrix 迁出→降级 watch（本地盯守腿仍在——注意同步下调 minMatrix 地板）: ${k}`); continue; } // ②降级 watch
    if (!pkgScripts.has(k)) { note(`matrix 迁出→整键退役（npm 注册一并删，放行但点名可见）: ${k}`); continue; } // ③退役
    matrixViolations += 1;
    err(`matrix 迁出规则违背：${k} 已离开 matrix，但既未入 quarantine、未入 watch、npm 注册仍在（matrix→void 反向差集，DEV-55——CI 盯守面不可静默缩水）`);
  }
  return { exits: exits.length, violations, watchExits: watchExits.length, watchViolations, matrixExits: matrixExits.length, matrixViolations };
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
const orphanN = [...pkgScripts].filter((k) => k.startsWith("test")).filter((k) => !(ci.matrix || []).includes(k) && !Object.keys(ci.quarantine || {}).includes(k) && !Object.keys(ci.watch || {}).includes(k)).length;
console.log(
  `OK: 矩阵 ${ci.matrix.length} 键（地板 ${ci.minMatrix}）/ quarantine ${qn} 键 / watch ${wn} 键 / 三层皆无 ${orphanN} 键，三层全注册两两互斥＋test:* 反向注册全落位` +
    (exitInfo ? `；出层规则（三向）：quarantine 差集 ${exitInfo.exits} 键、watch 差集 ${exitInfo.watchExits} 键、matrix 差集 ${exitInfo.matrixExits} 键全数合规（三居其一）` : ""),
);
