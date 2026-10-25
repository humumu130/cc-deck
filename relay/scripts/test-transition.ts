// [W-SMIMPL ③] 转移断言层单测（W-SMDESIGN 候选 3 第一步）——合法性表 v1 全边穷举
// + by 词表类别 + 收口完整性锚（25 处直写零残留）。纯函数直测，不起 relay。
//
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-transition.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transitionLegal, classOfBy, type SessionStatus } from "../src/lifecycle/transition.js";

const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sm = readFileSync(join(RELAY_ROOT, "src", "session-manager.ts"), "utf-8");
const tv = readFileSync(join(RELAY_ROOT, "src", "lifecycle", "transition.ts"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const STATES: SessionStatus[] = ["WORKING", "WAITING", "ERROR", "DONE"];

// ---------- §A v1 表全边穷举：唯一硬规则 DONE→WORKING 非 spawn ----------
for (const cur of STATES) {
  for (const next of STATES) {
    if (cur === next) continue;
    const isDoneRevive = cur === "DONE" && next === "WORKING";
    // spawn 系 by（词表内 resume/revive/dispatch + spawn: 前缀兜底）
    ok(transitionLegal(cur, next, "resume") === true, `spawn(resume) ${cur}→${next} 放行`);
    ok(transitionLegal(cur, next, "spawn:future-hook") === true, `spawn:(兜底) ${cur}→${next} 放行`);
    if (isDoneRevive) {
      ok(transitionLegal(cur, next, "turn-end") === false, `finalize(turn-end) ${cur}→${next} 拒（DONE 翻活仅 spawn）`);
      ok(transitionLegal(cur, next, "wd-stall") === false, `finalize(wd-stall) ${cur}→${next} 拒`);
    } else {
      ok(transitionLegal(cur, next, "turn-end") === true, `finalize(turn-end) ${cur}→${next} 放行（v1 表外全放）`);
    }
  }
}

// ---------- §B by 词表类别 ----------
for (const by of ["ext-waiting", "wd-selfheal", "tool-wait", "tool-resolve", "resume", "revive", "dispatch", "wait-resolve"]) {
  ok(classOfBy(by) === "spawn", `classOfBy(${by})=spawn`);
}
for (const by of ["ext-finish", "stream-idle", "turn-end", "stream-close", "stream-error", "revive-fail", "boot-dim", "boot-timeout", "retire", "wd-stall", "wd-fail"]) {
  ok(classOfBy(by) === "finalize", `classOfBy(${by})=finalize`);
}
ok(classOfBy("spawn:new-entry") === "spawn" && classOfBy("anything-else") === "finalize", "词表外兜底：spawn: 前缀=spawn，其余=finalize");

// ---------- §C 收口完整性锚（行为零变化的机器证据面） ----------
ok(!/\.state\.status = "/.test(sm), "session-manager 零 status 直写残留（25 处全收口 transition）");
ok((sm.match(/this\.transition\(/g) || []).length === 25, `transition 调用点恰 25 处（got ${(sm.match(/this\.transition\(/g) || []).length}）`);
ok(sm.includes('emitChainAudit("transition-illegal"'), "非法转移经 emitChainAudit 记账（transition-illegal 词表已扩）");
ok(tv.includes("transitionLegal"), "合法性表落点 lifecycle/transition.ts（纯函数可直测）");

console.log(`\ntransition: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
