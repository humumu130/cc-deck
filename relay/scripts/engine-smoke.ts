// DL-P1-8（DEV-22 批 B）：引擎适配器冒烟机——docs/operations/engine-adapters-smoke-checklist.md
// 的机器化本地脚本（词表/探针组合/CLI 在场三类）。设计口径：
//   - 本脚本不进 CI matrix（relay.yml 面归 DEV-25/leader）：基线未清零前挂 CI=恒红噪音；
//     基线绿后由 leader 把 `smoke:engines` 加进 matrix 即成 CI 冒烟闸（本文件 --soft 供过渡）。
//   - 三档输出：✓ 过 / ✗ 漂移（CLI 词表与实况/文案失配——开修复单，relay/src 面归批 A 改派）
//     / SKIP（本机未装该 CLI，装机项人工跑，见 checklist 记录规则）。
//   - 缺省 ✗ 即 exit 1（诊断工具语义：漂移要响亮）；--soft 只报告不拦（CI 过渡/晨报采集用）。
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR npx tsx scripts/engine-smoke.ts [--soft]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CODEBUDDY_MODELS, CODEBUDDY_EFFORTS, CODEBUDDY_EFFORT_ALIASES } from "../src/agent-codebuddy.js";

const SOFT = process.argv.includes("--soft");
const srcDir = join(import.meta.dirname, "..", "src");
let pass = 0, drift = 0, skip = 0;
const ok = (name: string) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name: string, action: string) => { drift++; console.log(`  ✗ ${name}\n      → ${action}`); };
const skipped = (name: string) => { skip++; console.log(`  - SKIP ${name}`); };

console.log("S1 词表卫生（codebuddy，源数据 import 直跑）：");
{
  const models = [...CODEBUDDY_MODELS];
  const dup = models.filter((m, i) => models.indexOf(m) !== i);
  if (dup.length === 0) ok(`模型词表 ${models.length} 项无重复`);
  else bad(`模型词表重复项：${dup.join(",")}`, "去重（词表幽灵键=白名单 fail-fast 误拒真键放行幽灵键，ENGCB 教训）");
  if (models.every((m) => typeof m === "string" && /^[a-z0-9][\w.-]*$/i.test(m))) ok("模型名形态合法（非空、无空白）");
  else bad("模型名形态异常（空串/含空白）", "修词表");
  const efforts = [...CODEBUDDY_EFFORTS];
  if (efforts.length > 0 && new Set(efforts).size === efforts.length) ok(`档位词表 ${efforts.length} 项无重复`);
  else bad("档位词表空/重复", "修 CODEBUDDY_EFFORTS");
  const aliasTargets = Object.values(CODEBUDDY_EFFORT_ALIASES);
  const stray = aliasTargets.filter((t) => !efforts.includes(t));
  if (stray.length === 0) ok(`中文别名 ${aliasTargets.length} 项目标全在档位表内`);
  else bad(`中文别名目标越界：${stray.join(",")}`, "别名目标必须在 CODEBUDDY_EFFORTS 内（越界=运行时必拒）");

  // A-13 类：报错文案里的「内置 N 个」数值声明 vs 词表实长——词表漂移的机器哨兵。
  const src = readFileSync(join(srcDir, "agent-codebuddy.ts"), "utf-8");
  const claims = [...src.matchAll(/内置\s*(\d+)\s*个/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(claims)];
  if (uniq.length === 0) ok("无「内置 N 个」数值声明（无漂移面）");
  else if (uniq.length === 1 && uniq[0] === models.length) ok(`文案计数声明 ${uniq[0]} 与词表实长一致`);
  else bad(`文案计数声明 [${uniq.join(",")}] ≠ 词表实长 ${models.length}（A-13 同族）`, `改 agent-codebuddy.ts 文案为「内置 ${models.length} 个」或去数值化（relay/src 面——批 A/leader 改派）`);
}

console.log("S2 engine-auth 探针组合覆盖（源码审计）：");
{
  // 期望表来源：DL-P1-8 artifacts 深挖②（w-review-enginefix-a-pr-15.md P2-1）——qwen 的
  // vertex-ai 通道两组合此前零命中。新引擎/新供应商接入时在此补行（表驱动）。
  const expectedCombos: Array<[string, string[], string]> = [
    ["qwen vertex-ai 组合①（API Key 路）", ["GOOGLE_API_KEY", "GOOGLE_MODEL"], "engine-auth.ts 探针矩阵补组合（relay/src 面——批 A/leader 改派）"],
    ["qwen vertex-ai 组合②（ADC 项目路）", ["GOOGLE_CLOUD_PROJECT", "GOOGLE_MODEL"], "同上"],
  ];
  const ea = readFileSync(join(srcDir, "engine-auth.ts"), "utf-8");
  for (const [name, envs, action] of expectedCombos) {
    const hit = envs.filter((e) => ea.includes(e)).length;
    if (hit === envs.length) ok(`${name}：${envs.join("+")} 探针在`);
    else bad(`${name}：${envs.join("+")} 仅 ${hit}/${envs.length} 键命中`, action);
  }
}

console.log("S3 装机在场探测（checklist T1/Q1/C1 前置——在场才谈参数对版）：");
{
  const clis: Array<[string, string]> = [
    ["trae-agent", "T1"],
    ["qwen", "Q1"],
    ["codebuddy", "C1"],
    ["codebuddy-code", "C1"],
    ["codex", "codex 正文"],
  ];
  for (const [cli, item] of clis) {
    const w = spawnSync("which", [cli], { encoding: "utf-8" });
    if (w.status === 0 && w.stdout.trim()) {
      const h = spawnSync(cli, ["--help"], { encoding: "utf-8", timeout: 15000 });
      ok(`${cli} 在场（${item}）：--help exit=${h.status}${h.status === 0 ? "" : "（非零——对版 checklist 人工核）"}`);
    } else {
      skipped(`${cli} 未装（${item} 装机项，人工按 checklist 跑）`);
    }
  }
}

console.log(`\n冒烟汇总：${pass} ✓ / ${drift} ✗ / ${skip} SKIP`);
if (drift > 0) {
  console.log(SOFT ? "（--soft：漂移只报告不拦——CI 过渡/晨报采集口径）" : "存在漂移：按 ✗ 行动列开修复单（relay/src 面走改派）；修后重跑本脚本归零再考虑挂 CI matrix");
  if (!SOFT) process.exit(1);
}
process.exit(0);
