// P81-1 权限策略核心测试锁（直跑范式）——specs/081-multi-engine-permission.md §4/§5。
// 七组断言：①四档映射全谱（claude confirmed：normalized/effective/native 三轴+wire 兼容值
// 归一）；②降级只向保守（JSONL unverified 逐级降+unsupported 降 ask——保守序单向不升）；
// ③伪装审批阻断（unverified 请求 bypassPermissions→native_mode=null+effective≠full-auto）；
// ④ZCode 恒 fail-closed（任何档任何角色任何 capability 都 forbidden）；⑤越上限 forbidden
//（显式越权不静默降）+混编默认越 tier 裁决降级；⑥缺省求值（mixed_team_default 物化/
// review_pm 例外/tier_default 矩阵）；⑦fail-closed 全谱（未知引擎/档位/角色/矩阵外 tier/
// capability 缺失/未知 source）+幂等纯函数+审计八字段齐。
// 纪律：纯内存直跑（无 IO 无端口），env 五清；生产零触达。
import { evaluatePermission } from "../src/permission-policy.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`PASS ${msg}`);
  } else {
    fail++;
    console.error(`FAIL ${msg}`);
  }
}

const BASE = { engine: "claude", role: "worker", tier: "正经立项", capability_state: "confirmed", policy_source: "explicit" } as const;

try {
  // ---------- ① 四档映射全谱（claude confirmed） ----------
  console.log("S1 四档映射全谱");
  {
    const r = evaluatePermission({ ...BASE, requested_mode: "ask" });
    assert(r.normalized_mode === "ask" && r.effective_mode === "ask" && r.native_mode === "default" && r.reason === "ok", "claude ask→ask/default（四档全谱 1/4）");
    const p = evaluatePermission({ ...BASE, requested_mode: "plan" });
    assert(p.normalized_mode === "plan" && p.effective_mode === "plan" && p.native_mode === "plan" && p.reason === "ok", "claude plan→plan/plan（2/4）");
    const e = evaluatePermission({ ...BASE, requested_mode: "edit-auto" });
    assert(e.normalized_mode === "edit-auto" && e.effective_mode === "edit-auto" && e.native_mode === "acceptEdits" && e.reason === "ok", "claude edit-auto→edit-auto/acceptEdits（3/4）");
    const f = evaluatePermission({ ...BASE, requested_mode: "full-auto" });
    assert(f.normalized_mode === "full-auto" && f.effective_mode === "full-auto" && f.native_mode === "bypassPermissions" && f.reason === "ok", "claude full-auto→full-auto/bypassPermissions（4/4）");
    // wire 兼容值归一（§5.3.1 物化形同路径）
    const w = evaluatePermission({ ...BASE, requested_mode: "bypassPermissions" });
    assert(w.normalized_mode === "full-auto" && w.effective_mode === "full-auto" && w.native_mode === "bypassPermissions", "wire 兼容：bypassPermissions→归一 full-auto（§5.3.1 物化形）");
    const a = evaluatePermission({ ...BASE, requested_mode: "acceptEdits" });
    assert(a.normalized_mode === "edit-auto" && a.native_mode === "acceptEdits", "wire 兼容：acceptEdits→归一 edit-auto");
    const d = evaluatePermission({ ...BASE, requested_mode: "default" });
    assert(d.normalized_mode === "ask" && d.native_mode === "default", "wire 兼容：default→归一 ask");
    // ceiling 内确认：claude+confirmed 正经立项 worker 上限 full-auto——本批角色+tier 两维通过即
    // native=bypassPermissions（中间态备案：目录/环境维 P81-3/4 补，接线批前不得投产，见模块头注）
    assert(f.native_mode === "bypassPermissions", "claude bypass 双维通过放行（目录/环境维留 P81-3/4——中间态头注备案）");
  }

  // ---------- ② 降级只向保守（JSONL unverified 逐级+unsupported 降 ask） ----------
  console.log("S2 降级只向保守");
  {
    const jbase = { engine: "qwen-code", role: "worker", tier: "正经立项", policy_source: "explicit" } as const;
    const fu = evaluatePermission({ ...jbase, requested_mode: "full-auto", capability_state: "unverified" });
    assert(fu.normalized_mode === "full-auto" && fu.effective_mode === "edit-auto" && fu.native_mode === null && fu.reason === "native_permission_not_confirmed", "JSONL unverified full-auto→降 edit-auto+native null（081 :84-95 落库例同形）");
    const ea = evaluatePermission({ ...jbase, requested_mode: "edit-auto", capability_state: "unverified" });
    assert(ea.effective_mode === "ask" && ea.reason === "native_permission_not_confirmed", "JSONL unverified edit-auto→降 ask（逐级只向保守）");
    const pl = evaluatePermission({ ...jbase, requested_mode: "plan", capability_state: "unverified" });
    assert(pl.effective_mode === "plan" && pl.reason === "ok", "JSONL unverified plan 不受累（只读面无审批问题）");
    const us = evaluatePermission({ ...jbase, requested_mode: "full-auto", capability_state: "unsupported" });
    assert(us.effective_mode === "ask" && us.reason === "engine_permission_unsupported", "JSONL unsupported auto 档→降 ask（§6.2 引擎无 capability 行）");
    const us2 = evaluatePermission({ ...jbase, requested_mode: "ask", capability_state: "unsupported" });
    assert(us2.effective_mode === "ask" && us2.reason === "ok", "JSONL unsupported ask 保持（最保守档恒可用）");
    // 保守序单向：unverified 链任一降级结果 ≤ 原 normalized（不出现升权）
    const seq: Record<string, number> = { ask: 0, plan: 1, "edit-auto": 2, "full-auto": 3 };
    const cases = (["ask", "plan", "edit-auto", "full-auto"] as const).map((m) => evaluatePermission({ ...jbase, requested_mode: m, capability_state: "unverified" }));
    assert(cases.every((r) => r.normalized_mode !== null && seq[r.effective_mode as string] <= seq[r.normalized_mode]), "降级方向锁：effective ≤ normalized 全谱成立（只向保守单向）");
  }

  // ---------- ③ 伪装审批阻断（081 :97-99） ----------
  console.log("S3 伪装审批阻断");
  {
    for (const eng of ["codex", "trae", "qwen-code", "codebuddy"]) {
      const r = evaluatePermission({ engine: eng, role: "worker", tier: "正经立项", requested_mode: "bypassPermissions", capability_state: "unverified", policy_source: "explicit" });
      assert(r.native_mode === null && r.effective_mode !== "full-auto" && r.reason === "native_permission_not_confirmed", `${eng} unverified 请求 bypassPermissions：native=null+effective≠full-auto（不伪装审批绕过）`);
    }
    // approval=false 等价面：JSONL 四引擎 confirmed 也无 native 词表（§7.1 native_modes:[]）——native 恒 null
    const c = evaluatePermission({ engine: "codex", role: "worker", tier: "正经立项", requested_mode: "full-auto", capability_state: "confirmed", policy_source: "explicit" });
    assert(c.effective_mode === "full-auto" && c.native_mode === null, "JSONL confirmed：effective=normalized 但 native_mode 恒 null（适配器未确认不填——§4.4）");
  }

  // ---------- ④ ZCode 恒 fail-closed（081 :100） ----------
  console.log("S4 ZCode fail-closed");
  {
    for (const m of ["ask", "plan", "edit-auto", "full-auto", "bypassPermissions"]) {
      const r = evaluatePermission({ engine: "zcode", role: "worker", tier: "正经立项", requested_mode: m, capability_state: "confirmed", policy_source: "explicit" });
      assert(r.effective_mode === "forbidden" && r.reason === "zcode_fail_closed", `zcode 请求 ${m}：恒 forbidden（不映射 ask 后继续执行）`);
    }
    const rz = evaluatePermission({ engine: "zcode", role: "team_pm", tier: "暂缓", requested_mode: null, capability_state: "unsupported", policy_source: "mixed_team_default" });
    assert(rz.effective_mode === "forbidden", "zcode 缺省路径同样 forbidden（capability/角色/tier 任何组合不豁免）");
  }

  // ---------- ⑤ 越上限 forbidden + 混编默认裁决降级 ----------
  console.log("S5 越上限与混编裁决");
  {
    const x1 = evaluatePermission({ ...BASE, requested_mode: "full-auto" }); // worker×暂缓? 否——BASE tier=正经立项 ceiling=full-auto
    assert(x1.effective_mode === "full-auto", "前置：正经立项 worker full-auto 在 ceiling 内");
    const x2 = evaluatePermission({ engine: "claude", role: "worker", tier: "暂缓", requested_mode: "full-auto", capability_state: "confirmed", policy_source: "explicit" });
    assert(x2.effective_mode === "forbidden" && x2.reason === "above_role_tier_ceiling", "worker×暂缓×full-auto 显式越上限→forbidden（不静默降，§5.3.2）");
    const x3 = evaluatePermission({ engine: "claude", role: "review_pm", tier: "正经立项", requested_mode: "full-auto", capability_state: "confirmed", policy_source: "explicit" });
    assert(x3.effective_mode === "forbidden" && x3.reason === "above_role_tier_ceiling", "review_pm×正经立项×full-auto 越上限→forbidden（review_pm 上限 edit-auto）");
    const x4 = evaluatePermission({ engine: "claude", role: "team_pm", tier: "咨询", requested_mode: "full-auto", capability_state: "confirmed", policy_source: "explicit" });
    assert(x4.effective_mode === "forbidden", "team_pm×咨询×full-auto 越上限→forbidden（咨询 bypass 默认禁止）");
    // 混编默认越 tier：服务端裁决降级到 ceiling（§5.3.2 安全降级分支），非 forbidden
    const x5 = evaluatePermission({ engine: "claude", role: "worker", tier: "咨询", requested_mode: null, capability_state: "confirmed", policy_source: "mixed_team_default" });
    assert(x5.requested_mode === "bypassPermissions" && x5.normalized_mode === "edit-auto" && x5.effective_mode === "edit-auto" && x5.reason === "mixed_team_default_demoted_to_ceiling", "混编默认×咨询 worker：物化 bypass 后服务端裁决降级到 ceiling edit-auto（降级面≠越权面）");
  }

  // ---------- ⑥ 缺省求值（§5.3） ----------
  console.log("S6 缺省求值");
  {
    const m1 = evaluatePermission({ engine: "claude", role: "worker", tier: "正经立项", requested_mode: null, capability_state: "confirmed", policy_source: "mixed_team_default" });
    assert(m1.requested_mode === "bypassPermissions" && m1.normalized_mode === "full-auto" && m1.effective_mode === "full-auto" && m1.native_mode === "bypassPermissions" && m1.reason === "mixed_team_default_materialized", "混编新卡 worker：服务端物化 requested=bypassPermissions（2026-10-06 拍板）写审计 reason");
    const m2 = evaluatePermission({ engine: "claude", role: "team_pm", tier: "正经立项", requested_mode: null, capability_state: "confirmed", policy_source: "mixed_team_default" });
    assert(m2.requested_mode === "bypassPermissions" && m2.effective_mode === "full-auto", "混编新卡 PM：同物化（§5.2 混编行 PM/worker 两列）");
    const m3 = evaluatePermission({ engine: "claude", role: "review_pm", tier: "正经立项", requested_mode: null, capability_state: "confirmed", policy_source: "mixed_team_default" });
    assert(m3.requested_mode === "plan" && m3.normalized_mode === "plan" && m3.effective_mode === "plan" && m3.reason === "mixed_team_default_review_pm_excluded", "混编新卡 review_pm 例外：不继承 bypass 默认→plan（§5.3.3）");
    const t1 = evaluatePermission({ engine: "claude", role: "worker", tier: "随手办", requested_mode: null, capability_state: "confirmed", policy_source: "tier_default" });
    assert(t1.requested_mode === "edit-auto" && t1.effective_mode === "edit-auto", "tier_default worker×随手办→默认 edit-auto（§5.2 默认列）");
    const t2 = evaluatePermission({ engine: "claude", role: "team_pm", tier: "咨询", requested_mode: null, capability_state: "confirmed", policy_source: "tier_default" });
    assert(t2.requested_mode === "plan" && t2.effective_mode === "plan", "tier_default PM×咨询→默认 plan");
    const t3 = evaluatePermission({ engine: "claude", role: "review_pm", tier: "随手办", requested_mode: null, capability_state: "confirmed", policy_source: "tier_default" });
    assert(t3.requested_mode === "plan" && t3.effective_mode === "plan", "tier_default review_pm×随手办→默认 plan");
    // unverified JSONL 混编默认：物化+降级 reason 优先级（降级事实 > 物化备案）
    const m4 = evaluatePermission({ engine: "qwen-code", role: "worker", tier: "正经立项", requested_mode: null, capability_state: "unverified", policy_source: "mixed_team_default" });
    assert(m4.requested_mode === "bypassPermissions" && m4.effective_mode === "edit-auto" && m4.reason === "native_permission_not_confirmed", "混编默认+unverified：物化后仍被降级（reason 降级事实优先于物化备案——默认值不绕护栏 §5.2 拍板注）");
    // policy_source 缺省=explicit 语义
    const d1 = evaluatePermission({ engine: "claude", role: "worker", tier: "正经立项", requested_mode: "plan", capability_state: "confirmed" });
    assert(d1.effective_mode === "plan" && d1.policy_source === "explicit", "policy_source 缺席→explicit 语义（wire 既有路径）");
  }

  // ---------- ⑦ fail-closed 全谱+幂等+审计字段 ----------
  console.log("S7 fail-closed/幂等/审计");
  {
    const u1 = evaluatePermission({ ...BASE, requested_mode: "turbo-hyper" });
    assert(u1.effective_mode === "forbidden" && u1.reason === "unknown_requested_mode", "未知档位→forbidden（客户端错/攻击面不猜）");
    const u2 = evaluatePermission({ ...BASE, engine: "gpt-9" as string, requested_mode: "ask" });
    assert(u2.effective_mode === "forbidden" && u2.reason === "unknown_engine", "未知引擎→forbidden");
    const u3 = evaluatePermission({ ...BASE, role: "intern" as string, requested_mode: "ask" });
    assert(u3.effective_mode === "forbidden" && u3.reason === "unknown_role", "未知角色→forbidden");
    const u4 = evaluatePermission({ ...BASE, tier: "未知tier" as string, requested_mode: "full-auto" });
    assert(u4.effective_mode === "forbidden" && u4.reason === "tier_not_in_policy_matrix", "真矩阵外 tier（未知值）→forbidden（fail-closed 覆盖保持——P81-2 矩阵增补后轻立项/看门狗已有行，拒面改用词表外值锁）");
    const u5 = evaluatePermission({ ...BASE, tier: "" as string, requested_mode: "ask" });
    assert(u5.effective_mode === "forbidden" && u5.reason === "tier_not_in_policy_matrix", "空串 tier→forbidden 同款（矩阵查表 miss 统一拒）");
    // P81-2 矩阵增补行（轻立项=随手办值/看门狗=暂缓值，Leader 裁定落地）
    const n1 = evaluatePermission({ ...BASE, tier: "轻立项", requested_mode: "full-auto" });
    assert(n1.effective_mode === "full-auto" && n1.reason === "ok", "轻立项×worker×full-auto：上限对齐随手办（full-auto）恒过——矩阵增补行生效");
    const n2 = evaluatePermission({ engine: "claude", role: "team_pm", tier: "轻立项", requested_mode: null, capability_state: "confirmed", policy_source: "tier_default" });
    assert(n2.requested_mode === "edit-auto" && n2.effective_mode === "edit-auto", "轻立项×PM tier_default→默认 edit-auto（=随手办行）");
    const n3 = evaluatePermission({ engine: "claude", role: "worker", tier: "看门狗", requested_mode: null, capability_state: "confirmed", policy_source: "tier_default" });
    assert(n3.requested_mode === "ask" && n3.effective_mode === "ask", "看门狗×worker tier_default→默认 ask（=暂缓行）");
    const n4 = evaluatePermission({ engine: "claude", role: "worker", tier: "看门狗", requested_mode: "edit-auto", capability_state: "confirmed", policy_source: "explicit" });
    assert(n4.effective_mode === "forbidden" && n4.reason === "above_role_tier_ceiling", "看门狗×worker×edit-auto 显式越上限（ceiling=ask）→forbidden——看门狗最保守面");
    const u6 = evaluatePermission({ ...BASE, requested_mode: "ask", capability_state: null });
    assert(u6.effective_mode === "ask" && u6.capability_state === null && u6.reason === "capability_state_missing" && u6.native_mode === null, "capability 缺失→ask 保守+native 恒 null（不猜）");
    const u7 = evaluatePermission({ ...BASE, requested_mode: "ask", capability_state: "half-confirmed" as string });
    assert(u7.effective_mode === "ask" && u7.reason === "capability_state_missing", "未知 capability 值→同款保守（词表外当缺失）");
    const u8 = evaluatePermission({ ...BASE, requested_mode: null, policy_source: "secret_override" as string });
    assert(u8.effective_mode === "ask" && u8.reason === "unknown_policy_source", "未知 policy_source+requested 缺席→ask 保守（不猜不升权）");
    const e1 = evaluatePermission({ ...BASE, requested_mode: "ask", policy_source: "nonsense" as string });
    assert(e1.effective_mode === "ask" && e1.reason === "unknown_policy_source", "未知 policy_source+requested 在场→仍保守 ask（source 词表严格）");
    const x = evaluatePermission({ ...BASE, requested_mode: "ask" });
    assert(e1.requested_mode === "ask" && e1.normalized_mode === "ask", "未知 source 出口仍归一 requested 留审计（事实保留）");

    // 幂等纯函数：同输入两次调用 JSON 深等
    const i1 = evaluatePermission({ ...BASE, requested_mode: "bypassPermissions" });
    const i2 = evaluatePermission({ ...BASE, requested_mode: "bypassPermissions" });
    assert(JSON.stringify(i1) === JSON.stringify(i2), "幂等：同输入两次调用输出 JSON 深等（纯函数零副作用）");

    // 审计八字段齐（081 :84-95 落库最小结构）
    const keys = Object.keys(i1).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(["capability_state", "effective_mode", "engine", "native_mode", "normalized_mode", "policy_source", "reason", "requested_mode"]),
      "审计八字段全齐（requested/normalized/effective/native/capability_state/engine/reason/policy_source——081 :84-95 形）",
    );
    // 审计可读性：降级链每帧 requested 保留原值（wire 事实不丢）
    const aud = evaluatePermission({ engine: "qwen-code", role: "worker", tier: "正经立项", requested_mode: "bypassPermissions", capability_state: "unverified", policy_source: "explicit" });
    assert(aud.requested_mode === "bypassPermissions" && aud.normalized_mode === "full-auto" && aud.effective_mode === "edit-auto", "审计链完整：requested(wire 事实)/normalized(意图)/effective(实际) 三轴分立可查询（§4.3 审计主轴）");
  }

  console.log(`P81-1 permission-policy: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
}
