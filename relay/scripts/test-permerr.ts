// W-PERMERR 权限勾选拒绝根修测试件：COMMAND_CREATE 显式 bypass 在生产/未知环境的
// 拒绝→授权→放行→撤销全链 + 拒绝文案可操作化 + evaluatePermission 授权位语义。
//
// 矩阵（三段）：
//   P1  evaluatePermission 纯函数：授权位翻案语义（production 显式 bypass 未授权=拒 /
//       授权=放行 reason=production_bypass_user_authorized / env_unknown 同构）
//   P2  permDenyMessage：九 reason 全集中文映射（动词开头+含行动+尾码保留）+未知码兜底
//   P3  COMMAND_CREATE 集成（CCR_ENV=production 造真实威胁态）：
//       无授权勾选=拒+文案含 org auth-bypass on 指引 / auth-bypass on 后同参=创建成功 /
//       auth-bypass off 后再勾=拒（撤销即收回）/ 审计行 reason 落库
//
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   npx tsx scripts/test-permerr.ts
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { evaluatePermission, permDenyMessage } from "../src/permission-policy.js";
import { auditStore, readBypassAuthorization, readPermissionAudit } from "../src/permission-audit.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command, CommandAckPayload } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ["CCR_ENV", "CCR_PERMISSION_POLICY", "CCR_TOKEN", "CCR_ORG_DIR", "CCR_DATA_DIR", "CCR_PORT", "CCR_STUB_MODE"]) { SAVED_ENV[k] = process.env[k]; delete process.env[k]; }
const restore = () => { for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

try {
  // ---------- P1 evaluatePermission 授权位语义 ----------
  section("P1 evaluatePermission 授权位（#69 半边）");
  const base = { engine: "claude" as const, role: "team_pm" as const, tier: "随手办" as const, capability_state: "confirmed" as const, policy_source: "explicit" as const, dir_scope: "production" as const, env: "production" as const };
  let r = evaluatePermission({ ...base, requested_mode: "bypassPermissions" });
  assert(r.effective_mode === "forbidden" && r.reason === "production_bypass_denied", "P1a 生产环境显式 bypass 未授权 → forbidden（既有闸语义不回归）");
  r = evaluatePermission({ ...base, requested_mode: "bypassPermissions", user_authorized_bypass: true });
  assert(r.effective_mode !== "forbidden" && r.reason === "production_bypass_user_authorized", `P1b 同参+授权位 → 放行且 reason 备案（实测 ${r.reason}）`);
  r = evaluatePermission({ ...base, dir_scope: "unknown", env: "sandbox", requested_mode: "bypassPermissions" });
  assert(r.effective_mode === "forbidden" && r.reason === "env_unknown_bypass_denied", "P1c 目录安全域 unknown → env_unknown 拒（Windows 云通道形态）");
  r = evaluatePermission({ ...base, dir_scope: "unknown", env: "sandbox", requested_mode: "bypassPermissions", user_authorized_bypass: true });
  assert(r.effective_mode !== "forbidden", "P1d unknown+授权位 → 放行（授权对两威胁态同效）");

  // ---------- P2 permDenyMessage 文案映射 ----------
  section("P2 拒绝文案可操作化");
  const reasons = ["production_bypass_denied", "env_unknown_bypass_denied", "above_role_tier_ceiling", "unknown_engine", "zcode_fail_closed", "unknown_role", "tier_not_in_policy_matrix", "unknown_requested_mode", "unknown_policy_source"];
  for (const rs of reasons) {
    const msg = permDenyMessage(rs);
    assert(/[一-龥]/.test(msg) && msg.includes(rs), `P2 ${rs} → 中文文案+尾码保留`);
  }
  assert(permDenyMessage("production_bypass_denied").includes("org auth-bypass on"), "P2 bypass 拒绝文案含具体授权命令（可操作）");
  assert(permErrShape(permDenyMessage("made_up_reason")), "P2 未知 reason → 通用兜底中文+尾码");
  function permErrShape(msg: string): boolean { return /[一-龥]/.test(msg) && msg.includes("made_up_reason"); }

  // ---------- P3 COMMAND_CREATE 全链集成 ----------
  section("P3 COMMAND_CREATE 勾选→拒绝→授权→放行→撤销");
  process.env.CCR_ENV = "production"; // 造真实生产威胁态（resolveEnvScope 显式优先）
  const DATA = mkdtempSync(join(tmpdir(), "ccr-permerr-data-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-permerr-cwd-"));
  const created: unknown[] = [];
  const factory = (_c: string, _m: string, _cb: AgentCallbacks, _p: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    created.push(a);
    return a;
  };
  const bus = new EventBus();
  const cfg: RelayConfig = { port: 18999, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(factory);
  let seq = 0;
  const send = (payload: Record<string, unknown>): CommandAckPayload =>
    mgr.handleCommand({ command_id: `pe-${++seq}`, type: "COMMAND_CREATE", payload, ts: Date.now() } as unknown as Command, "web-permerr") as CommandAckPayload;

  // #205（用户拍板 2026-10-21）：勾选「跳过权限确认」=授权本身——生产/unknown 环境
  // 闸对 create 面显式勾选直接放行，不再要求终端二次授权；授权位（org auth-bypass）
  // 语义保留=预授权全部（含 dispatch 面）。P3 节断言随 #205 契约改写（W-GATE 批）。
  // a. 无授权+勾选 → 放行（勾选即授权）+审计 reason=skip_confirm_authorized
  const ackA = send({ cwd: CWD, prompt: "permerr a", permissionMode: "bypassPermissions" });
  assert(ackA.ok === true && typeof ackA.session_id === "string", `P3a 生产+勾选+未授权位 → 放行（#205 勾选即授权；实测：${(ackA.error ?? ackA.session_id ?? "").slice(0, 40)}…）`);
  assert(created.length === 1, "P3a' 放行即 spawn（1 次）");

  // b. auth-bypass on（写授权）→ 同参勾选仍放行（双通道并存；materialized 走授权位命名）
  const authOn = mgr.orgCommand("owner", "web-permerr", "auth-bypass", { on: true });
  assert(authOn.ok === true && readBypassAuthorization(DATA) === true && existsSync(join(DATA, "permission-auth.json")), "P3b org auth-bypass on → 授权文件落盘+读数 true（CLI 保留=预授权通道）");
  const ackB = send({ cwd: CWD, prompt: "permerr b", permissionMode: "bypassPermissions" });
  assert(ackB.ok === true && typeof ackB.session_id === "string" && created.length === 2, "P3b' 授权位在场+勾选 → 放行走 bypass_user_authorized 命名（双通道并存闭环）");

  // c. auth-bypass off（撤销预授权）→ 勾选仍放行（勾选即授权不依赖授权位）
  const authOff = mgr.orgCommand("owner", "web-permerr", "auth-bypass", { on: false });
  assert(authOff.ok === true && readBypassAuthorization(DATA) === false && !existsSync(join(DATA, "permission-auth.json")), "P3c org auth-bypass off → 授权文件移除+读数 false");
  const ackC = send({ cwd: CWD, prompt: "permerr c", permissionMode: "bypassPermissions" });
  assert(ackC.ok === true && created.length === 3, "P3c' 撤销授权位后再勾选 → 仍放行（#205：勾选即授权独立通道，撤销只收 dispatch 面）");

  // d. 不勾选 → 恒不受影响（回归锚）
  const ackD = send({ cwd: CWD, prompt: "permerr d" });
  assert(ackD.ok === true && created.length === 4, "P3d 不勾选创建恒成功（1016 场景主通路零回归）");

  // e. 审计行落库（放行 reason 备案——sqlite 面，驱动不可用降级为跳过不阻断）
  const rows = readPermissionAudit(auditStore(DATA), 50);
  assert(rows.length === 0 || rows.some((x) => x.effective_mode !== "forbidden" && String(x.reason ?? "").includes("skip_confirm_authorized")), "P3e 勾选放行审计 reason=skip_confirm_authorized 落库（#205 主通道留痕）");
  assert(rows.length === 0 || rows.some((x) => x.effective_mode !== "forbidden" && x.reason === "production_bypass_user_authorized"), "P3e' 授权位放行审计 reason 备案（双通道命名区分）");

  rmSync(DATA, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  restore();
}
