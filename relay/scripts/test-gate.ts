// W-GATE #205：勾选「跳过权限确认」=授权本身——生产/unknown 环境闸放行语义三态断言。
// ①勾选（skip_confirm_checked）→放行（materialized=skip_confirm_authorized，非 forbidden）
// ②授权位（user_authorized_bypass）路径原语义保持（materialized=bypass_user_authorized）
// ③两者皆无（dispatch 面原路径）→仍 forbidden（*_bypass_denied）
// ④create 面接线锚（session-commands 传 skip_confirm_checked: pm === "bypassPermissions"）
// ⑤gate-release 审计行锚 ⑥文案词条保留（dispatch 拒绝面仍消费）
//
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-gate.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePermission } from "../src/permission-policy.js";

const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sc = readFileSync(join(RELAY_ROOT, "src", "commands", "session-commands.ts"), "utf-8");
const pp = readFileSync(join(RELAY_ROOT, "src", "permission-policy.ts"), "utf-8");
const sm = readFileSync(join(RELAY_ROOT, "src", "session-manager.ts"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const base = {
  requested_mode: "bypassPermissions",
  engine: "claude" as const,
  role: "team_pm",
  tier: "随手办",
  capability_state: "confirmed", /* engineCapabilityState 词表：claude=confirmed */
  policy_source: "explicit" as const,
  dir_scope: "production" as const,
  env: "production" as const,
};

console.log("== W-GATE #205: 勾选即授权 ==");

// ---- A. 求值三态 ----
console.log("-- A. 求值三态 --");
{
  const a1 = evaluatePermission({ ...base, skip_confirm_checked: true });
  ok(a1.effective_mode !== "forbidden", "A1 勾选（production+skip_confirm）→ 放行（不再 forbidden）");
  ok(String(a1.reason ?? "").includes("production_skip_confirm_authorized"), `A2 materialized 命名=production_skip_confirm_authorized（实测 reason=${a1.reason}）`);
  const a2 = evaluatePermission({ ...base, user_authorized_bypass: true });
  ok(a2.effective_mode !== "forbidden" && String(a2.reason ?? "").includes("bypass_user_authorized"), "A3 授权位路径原语义保持（bypass_user_authorized 命名区分）");
  const a3 = evaluatePermission({ ...base });
  ok(a3.effective_mode === "forbidden" && String(a3.reason ?? "").includes("production_bypass_denied"), "A4 两者皆无（dispatch 面原路径）→ 仍 forbidden");
  const a4 = evaluatePermission({ ...base, dir_scope: "unknown", env: "unknown", skip_confirm_checked: true });
  ok(a4.effective_mode !== "forbidden" && String(a4.reason ?? "").includes("env_unknown_skip_confirm_authorized"), "A5 env_unknown 同语义（勾选=放，命名区分 threat）");
  const a5 = evaluatePermission({ ...base, skip_confirm_checked: false });
  ok(a5.effective_mode === "forbidden", "A6 skip_confirm_checked: false=缺席等价（仍拒——显式 false 不放）");
  // 审查 P3-2 ①：物化降级面免疫（勾选不越权到 mixed_team_default 物化请求）
  const a7 = evaluatePermission({ ...base, requested_mode: null, policy_source: "mixed_team_default", role: "worker", tier: "正经立项", skip_confirm_checked: true });
  ok(a7.effective_mode === "edit-auto" && String(a7.reason ?? "").includes("demoted_from_full_auto"), "A7 物化面免疫：勾选对 mixed 默认降级面零波及（照旧 demote edit-auto）");
  // 审查 P3-2 ②：双真优先级（authorized 命名胜出——防未来调换三元静默改审计归因）
  const a8 = evaluatePermission({ ...base, skip_confirm_checked: true, user_authorized_bypass: true });
  ok(String(a8.reason ?? "").includes("bypass_user_authorized"), "A8 双真时授权位命名胜出（归因优先级锁）");
}

// ---- B. create 面接线 ----
console.log("-- B. create 面接线 --");
ok(sc.includes("skip_confirm_checked: pm === \"bypassPermissions\""), "B1 create 面 evaluate 传 skip_confirm_checked（勾选=pm bypassPermissions）");
ok(sc.includes("user_authorized_bypass: readBypassAuthorization"), "B2 授权位读数保留（双通道并存）");

// ---- C. gate-release 审计行 ----
console.log("-- C. 审计行 --");
ok(sc.includes('mgr.emitChainAudit("gate-release"'), "C1 create 成功面 gate-release 审计行（谁何时勾选放行）");
ok(sc.includes('pm === "bypassPermissions" && (envScope === "production" || envScope === "unknown"'), "C2 审计触发=本地事实推导（勾选+环境闸域——审查 P2-1：不依赖 reason 子串，unverified 引擎同触发）");
ok(sm.includes('"gate-release"'), "C3 emitChainAudit 联合类型扩展（session-manager——C3 原读错文件）");
ok(sc.includes("appendPermissionAudit(auditStore(mgr.cfg.dataDir), okRow)"), "C4 PermissionAudit 双账面保留（reason 同步可查）");

// ---- D. 不勾=逐条确认（原路径零变） ----
console.log("-- D. 不勾路径 --");
{
  const d1 = evaluatePermission({ ...base, requested_mode: null });
  ok(d1.effective_mode !== "forbidden", "D1 不勾（requested=null）→ 不进 bypass 拒面（正常创建走 CLI 默认逐条确认）");
  const d2 = evaluatePermission({ ...base, requested_mode: "default" });
  ok(d2.effective_mode !== "forbidden", "D2 请求 default 档同上不拒");
}

// ---- E. dispatch 面不动 ----
console.log("-- E. dispatch 面 --");
/* sm 已提顶部 */ const seg = sm.slice(sm.indexOf("const perm = policyOn ? evaluatePermission({"), sm.indexOf("const perm = policyOn ? evaluatePermission({") + 700);
ok(!seg.includes("skip_confirm_checked"), "E1 dispatch evaluate 不传 skip_confirm（授权位唯一通道，org auth-bypass=预授权全部）");
ok(pp.includes("production_bypass_denied") && pp.includes("env_unknown_bypass_denied"), "E2 拒绝文案词条保留（备 dispatch 面未来接 permDenyMessage——当前 create 面两 reason 已不可达，词条为死代码留存；审查 P3-1）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
