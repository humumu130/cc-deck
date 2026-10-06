// P81-2 权限策略接线测试锁（直跑范式）——specs/081 §4/§5/§6.1。
// 五组断言：①SNAPSHOT 摘要形状锁（六注册引擎/claude confirmed 四档/JSONL unverified
// 两档/zcode 空集）；②接线映射层锁（COMMAND_CREATE→team_pm×随手办×explicit、组织派单
// →岗位名映射×tier_default+bypass 事实——与 session-manager 接线点同构造，漂移即红）；
// ③forbidden ACK 统一拒绝面（COMMAND_CREATE×zcode、dispatchWorker×review_pm 越上限——
// 闸拒均在 spawn/落账前=直跑安全）；④零台账证据（forbidden 拒单 dispatch-log 恒空）；
// ⑤硬断言（effective ≤ ceiling 全谱+摘要 modes 上限自洽）。
// 成功路径（闸过后 spawn）不在直跑范围（spawn 面归 smoke-e2e/test-bridge e2e 层，与
// m12-commands 同口径）——回执字段形状由 tsc（CommandAckPayload.permission）+②映射锁覆盖。
// 隔离：mkdtemp 临时目录、env 五清、无端口；生产 8787 与 ~/.cc-deck 零触达。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { engineCapabilityState, evaluatePermission, permissionCapabilitiesSummary } from "../src/permission-policy.js";
import { readDispatchLog } from "../src/org.js";
import type { CommandAckPayload, Command, SessionEngine } from "../src/types.js";
import { setLightConfirmTrusted } from "../src/projects.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-p81-wiring-"));
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

try {
  process.env.CCR_DATA_DIR = join(root, "data");
  process.env.CCR_ORG_DIR = join(root, "org");
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE"]) delete process.env[k];
  setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active（组 fixture 用）

  // ---------- ① SNAPSHOT 摘要形状锁 ----------
  console.log("S1 摘要形状");
  {
    const s = permissionCapabilitiesSummary();
    assert(s.length === 6, "摘要恰六注册引擎");
    assert(
      JSON.stringify(s.map((x) => x.engine)) === JSON.stringify(["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"]),
      "摘要引擎序=注册表序（claude/codex/trae/qwen-code/codebuddy/zcode）",
    );
    const claude = s.find((x) => x.engine === "claude")!;
    assert(claude.capability_state === "confirmed" && JSON.stringify(claude.modes) === JSON.stringify(["ask", "plan", "edit-auto", "full-auto"]), "claude confirmed：modes 四档全（SDK 内嵌事实）");
    const qwen = s.find((x) => x.engine === "qwen-code")!;
    assert(qwen.capability_state === "unverified" && JSON.stringify(qwen.modes) === JSON.stringify(["ask", "plan"]), "JSONL unverified：modes 两档（auto 档会降级不上榜）");
    const z = s.find((x) => x.engine === "zcode")!;
    assert(z.capability_state === "unsupported" && z.modes.length === 0, "zcode unsupported：modes 空集（恒 forbidden）");
    const keySet = JSON.stringify(Object.keys(claude).sort());
    assert(keySet === JSON.stringify(["capability_state", "engine", "modes"]), "摘要键集恰三（engine/capability_state/modes——只读投影零写面）");
  }

  // ---------- ② 接线映射层锁（与 session-manager 接线点同构造） ----------
  console.log("S2 接线映射");
  {
    // COMMAND_CREATE 映射：engine ?? claude + team_pm×随手办 + explicit（session-manager 闸同参）
    for (const eng of ["claude", "codex", "trae", "qwen-code", "codebuddy"] as const) {
      const pm = "bypassPermissions";
      const r = evaluatePermission({ requested_mode: pm, engine: eng, role: "team_pm", tier: "随手办", capability_state: engineCapabilityState(eng), policy_source: "explicit" });
      const ceilingFull = eng === "claude"; // team_pm×随手办 ceiling=full-auto：claude 全档恒过；JSONL unverified 降 edit-auto
      assert(
        (ceilingFull && r.effective_mode === "full-auto" && r.reason === "ok") || (!ceilingFull && r.effective_mode === "edit-auto" && r.reason === "native_permission_not_confirmed"),
        `COMMAND_CREATE 映射×${eng}×bypass 勾选：${ceilingFull ? "effective=full-auto 恒过（行为零变）" : "降 edit-auto（caller 可见）"}——effective ≤ ceiling`,
      );
    }
    // 组织派单映射：bypass 事实+岗位名→business role+tier_default（dispatchWorker 闸同参）
    const d1 = evaluatePermission({ requested_mode: "bypassPermissions", engine: "claude", role: "worker", tier: "轻立项", capability_state: "confirmed", policy_source: "tier_default" });
    assert(d1.effective_mode === "full-auto" && d1.reason === "ok", "派单映射×worker×轻立项：bypass 事实过 ceiling（full-auto）——现状行为保持");
    const d2 = evaluatePermission({ requested_mode: "bypassPermissions", engine: "claude", role: "review_pm", tier: "轻立项", capability_state: "confirmed", policy_source: "tier_default" });
    assert(d2.effective_mode === "forbidden" && d2.reason === "above_role_tier_ceiling", "派单映射×review_pm×轻立项：bypass 越上限（ceiling edit-auto）→forbidden");
    const d3 = evaluatePermission({ requested_mode: "bypassPermissions", engine: "trae", role: "worker", tier: "随手办", capability_state: "unverified", policy_source: "tier_default" });
    assert(d3.effective_mode === "edit-auto" && d3.reason === "native_permission_not_confirmed", "派单映射×JSONL：降级回执 caller 可见（spawn 传值现状维持，P81-5 收口）");
  }

  const bus = new EventBus();
  const mgr = new SessionManager(bus, loadConfig());

  // ---------- ③ forbidden ACK 统一拒绝面（真实命令面，闸拒在 spawn 前） ----------
  console.log("S3 forbidden ACK");
  {
    const ack = mgr.handleCommand(
      { command_id: "p81-c1", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "zcode 闸门测试", permissionMode: "bypassPermissions", engine: "zcode" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ack.ok === false && (ack.error ?? "").startsWith("forbidden:") && (ack.error ?? "").includes("zcode_fail_closed"), "COMMAND_CREATE×zcode×bypass：forbidden ACK ok:false+reason 定位（§6.1 统一拒绝面）");
    assert(ack.session_id === undefined && ack.permission === undefined, "forbidden ACK 无 session_id 无回执字段（拒绝面不带半成功残留）");

    const ackU = mgr.handleCommand(
      { command_id: "p81-c2", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "未知引擎前置", engine: "gpt-9" as SessionEngine }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackU.ok === false && (ackU.error ?? "").includes("未知引擎"), "未知引擎既有前置拒保持（闸外词表验，回归不退）");
  }

  // ---------- ④ dispatchWorker forbidden+零台账 ----------
  console.log("S4 派单闸与零台账");
  {
    const ackG = mgr.handleCommand(
      { command_id: "p81-g1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "P81-2 测试组", anchor_dir: root, tier: "轻立项" }, ts: Date.now() },
      "web-d",
    ) as { ok: boolean; data?: { group?: { id: string } } };
    const gid = ackG.data?.group?.id ?? "";
    assert(ackG.ok === true && gid !== "", "前置：轻立项组 fixture 建成");

    const before = readDispatchLog().length;
    const d1 = mgr.dispatchWorker({ anchor: root, prompt: "review_pm 越上限闸门测试", gid, role: "review_pm" });
    assert(d1.ok === false && "error" in d1 && d1.error.startsWith("forbidden:") && d1.error.includes("above_role_tier_ceiling"), "dispatchWorker×review_pm×轻立项×bypass：forbidden 拒绝（ceiling edit-auto < full-auto）");
    assert(readDispatchLog().length === before, "forbidden 拒单零台账（落账前拒与 preflight 同位——dispatch-log 行数不变）");

    const d2 = mgr.dispatchWorker({ anchor: root, prompt: "zcode 外层拒", gid, engine: "zcode" });
    assert(d2.ok === false && "error" in d2 && d2.error.includes("zcode"), "dispatchWorker×zcode：外层 preflight 先拒（unsupported engine——闸门双层防御外圈）");
    assert(readDispatchLog().length === before, "zcode 拒单同样零台账");
  }

  // ---------- ⑤ 硬断言：effective ≤ ceiling 全谱+摘要 modes 自洽 ----------
  console.log("S5 硬断言");
  {
    const seq: Record<string, number> = { ask: 0, plan: 1, "edit-auto": 2, "full-auto": 3, forbidden: -1 };
    // 接线面全组合扫描：六引擎×三角色×六 tier×显式 bypass——effective 恒 ≤ ceiling 或 forbidden
    let scanned = 0;
    let violated = 0;
    for (const eng of ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"] as const) {
      for (const role of ["team_pm", "worker", "review_pm"] as const) {
        for (const tier of ["咨询", "随手办", "轻立项", "正经立项", "暂缓", "看门狗"]) {
          const r = evaluatePermission({ requested_mode: "bypassPermissions", engine: eng, role, tier, capability_state: engineCapabilityState(eng), policy_source: "explicit" });
          scanned++;
          if (r.effective_mode === "forbidden") continue; // 拒面合法出口
          if (r.normalized_mode !== null && seq[r.effective_mode] > seq[r.normalized_mode]) violated++; // 降级方向
        }
      }
    }
    assert(scanned === 108 && violated === 0, `接线全谱 ${scanned} 组合：effective 恒 ≤ normalized（零静默升权，降级只向保守）`);
    // 摘要 modes 上限与求值自洽：confirmed 引擎 modes 全集=求值可保真档
    const s = permissionCapabilitiesSummary();
    const claudeModes = s.find((x) => x.engine === "claude")!.modes;
    const sample = evaluatePermission({ requested_mode: "full-auto", engine: "claude", role: "worker", tier: "正经立项", capability_state: "confirmed", policy_source: "explicit" });
    assert(claudeModes.includes(sample.effective_mode), "摘要 modes 与求值自洽：claude full-auto 求值结果在上榜档集内（P75 选择器读数可信）");
  }

  console.log(`P81-2 permission wiring: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}
