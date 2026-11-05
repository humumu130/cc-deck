// watchdogperm（t-a86739fd，1105 用户实锤「test98 已经有观察员了吗我怎么没看到」）：
// dispatch role=watchdog 被权限词表拒（unknown_role_mapping）——巡查员上岗端到端不通。
// 修=permission-policy 新增 watchdog 只读主体（全 tier 恒 plan）+session-manager 词表链接入
//（requested 特化 plan——bypass 对 plan ceiling 恒拒）。本套件锁三层：纯函数/词表锚/岗位注入。
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  const { evaluatePermission, EFFECTIVE_TO_MANAGED } = await import("../src/permission-policy.js");

  console.log("A. watchdog 只读主体纯函数（全 tier 恒 plan+越权面拒）");
  {
    // A1：plan 请求（dispatch 面特化后的请求）全 tier 过——上岗即只读档
    for (const tier of ["咨询", "随手办", "轻立项", "正经立项", "暂缓", "看门狗"]) {
      const r = evaluatePermission({ requested_mode: "plan", engine: "claude", role: "watchdog", tier, capability_state: "confirmed", policy_source: "explicit", dir_scope: "sandbox", env: "sandbox" });
      assert(r.effective_mode === "plan", `plan 请求过（${tier}→effective=plan——巡查员上岗档）`);
    }
    // A2：越权面——写档请求恒拒（巡查员派实施类单被权限层挡）
    for (const req of ["bypassPermissions", "acceptEdits"]) {
      const r = evaluatePermission({ requested_mode: req, engine: "claude", role: "watchdog", tier: "正经立项", capability_state: "confirmed", policy_source: "explicit", dir_scope: "sandbox", env: "sandbox" });
      assert(r.effective_mode === "forbidden" && r.reason === "above_role_tier_ceiling", `${req} 越权拒（forbidden/above_role_tier_ceiling——禁写产品码禁改配置的权限面）`);
    }
    // A3：混编物化例外——watchdog 不继承 bypass 物化（恒 plan）
    const m = evaluatePermission({ requested_mode: null, engine: "claude", role: "watchdog", tier: "正经立项", capability_state: "confirmed", policy_source: "mixed_team_default", dir_scope: "sandbox", env: "sandbox" });
    assert(m.effective_mode === "plan" && m.reason === "mixed_team_default_review_pm_excluded", `混编物化例外（effective=plan 非 bypass——只读主体不继承写档物化，reason=${m.reason}）`);
    // A4：spawn 实参链——plan→"plan"（EFFECTIVE_TO_MANAGED）
    assert(EFFECTIVE_TO_MANAGED["plan"] === "plan", "EFFECTIVE_TO_MANAGED plan→plan（spawn 收只读实参）");
  }

  console.log("B. dispatch 词表链接入（上岗链通）");
  {
    const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
    assert(sm.includes(`role === "watchdog" ? "watchdog"`), "bizRole 映射链含 watchdog（unknown_role_mapping 挡死根除）");
    assert(sm.includes(`bizRole === "watchdog" ? "plan" : "bypassPermissions"`), "求值请求特化（watchdog→plan，其余岗位 §5.3.1 物 bypass 零变）");
    assert(sm.includes("review/review_pm/watchdog"), "拒文案词表同步（新拒面可读）");
    const pp = readFileSync(new URL("../src/permission-policy.ts", import.meta.url), "utf8");
    assert(pp.includes(`"team_pm" | "worker" | "review_pm" | "watchdog"`), "PolicyRole 词表含 watchdog");
    assert(/watchdog: \{ 咨询: "plan", 随手办: "plan", 轻立项: "plan", 正经立项: "plan", 暂缓: "plan", 看门狗: "plan" \}/.test(pp), "CEILING/TIER_DEFAULT watchdog 行=全 tier 恒 plan（只读语义落矩阵）");
    assert(pp.includes(`input.role === "review_pm" || input.role === "watchdog"`), "混编物化例外覆盖 watchdog");
  }

  console.log("C. 岗位注入链（上岗 prompt 含 watchdog rows——端到端后半段）");
  {
    const { buildRoleInjection } = await import("../src/role-templates.js");
    const inj = buildRoleInjection({ role: "watchdog" });
    assert(!!inj && !!inj.block && inj.block.length > 50, `buildRoleInjection(watchdog) 命中模板（注入块 ${inj ? inj.block.length : 0} 字——上岗 prompt 带 watchdog 岗位 rows）`);
    const tpl = readFileSync(new URL("../presets/role-templates.json", import.meta.url), "utf8");
    assert(tpl.includes('"slug": "watchdog"'), "role-templates watchdog 模板在位（地基——22755740 已随 dev）");
  }

  console.log("D. review/review_pm 映射完整性核对（任务书③——记档不扩权）");
  {
    const pp = readFileSync(new URL("../src/permission-policy.ts", import.meta.url), "utf8");
    assert(/review_pm: \{ 咨询: "plan", 随手办: "edit-auto"/.test(pp), "review_pm CEILING 行在位（评审席地基完整——mapping 链 review→review_pm 在 B 组锚）");
    // 消费面枚举核对：dispatch bizRole 链与 PolicyRole 词表对齐（无孤儿键）
    const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
    for (const org of ["pm", "team_pm", "review", "review_pm", "worker", "watchdog"]) {
      assert(sm.includes(`role === "${org}"`), `org 岗位 ${org} 在 bizRole 链（无挡死键）`);
    }
  }

  console.log(`\n========== watchdogperm 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
