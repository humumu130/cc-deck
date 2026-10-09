// P81-7 权限线集中回归矩阵（直跑范式，仿 test-p81-wiring）——specs/081 §4.4/§5/§6.1/§6.3。
// 四断言束（P81-1~6 单面测试的跨维集中锁，不重复单面已锁细节）：
//   束① fail-closed 全谱：无 capability（引擎未确认）/未知 native 档/unsupported 引擎
//        三路径×六引擎枚举（claude/codex/trae/qwen-code/codebuddy/zcode）——全落保守档或
//        forbidden，无一路径产生升权（含引擎×角色×环境 72 格矩阵扫描，覆盖表见回单）；
//   束② forbidden ACK 统一形状：unknown_role_mapping/越 tier/生产目录/非法环境四类拒绝
//        ACK 形状一致（ok:false+forbidden: 前缀+reason 定位+无 session_id 无 permission），
//        审计行 actor/reason/环境字段可观测，拒绝即无会话无 dispatch 创建；
//   束③ 失败路径无半状态：审计写失败（appendPermissionAudit 尽力而为，fake port 模拟
//        throw）——不抛、真库无半行、主路径存活（审计失败不阻断开卡）；
//   束④ 重放/重试幂等：同 command_id 重发重放首回执（processedCommands 幂等键 #65）——
//        审计不重复灌行、无二次 spawn、effective 档恒等。看门狗重试走 MESSAGE 重放账
//        （:2157/:3112）不经权限闸；dispatchWorker 重试每次新 dispatchId 各落一行=
//        append-only 审计语义（非重复灌行）——本件 CCR_WATCHDOG_DISABLE=1 不造看门狗场景。
// 隔离：mkdtemp、env 五清、端口 8796（避 8787 生产与 8792/8793/8795/8798/8799 测试段）；
// 生产 8787 与 ~/.cc-deck 零触达（束②「生产目录」类用 ~/.cc-deck 路径字符串作 cwd——
// resolveDirScope 纯字符串判定零 IO，拒面在 create 之前 return，无 mkdir/spawn 触达）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventBus } from "../src/event-bus.js";
import type { RelayConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { engineCapabilityState, evaluatePermission, type PolicyResult } from "../src/permission-policy.js";
import { appendPermissionAudit, auditStore, readPermissionAudit } from "../src/permission-audit.js";
import { readDispatchLog } from "../src/org.js";
import { setLightConfirmTrusted } from "../src/projects.js";
import type { CommandAckPayload } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-p817-"));
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
const ENGINES = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"] as const;
const CONSERV: Record<string, number> = { ask: 0, plan: 1, "edit-auto": 2, "full-auto": 3, forbidden: -1 };

try {
  process.env.CCR_DATA_DIR = join(root, "data");
  process.env.CCR_ORG_DIR = join(root, "org");
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE", "CCR_ENV"]) delete process.env[k];
  setLightConfirmTrusted(true);

  // ---------- 束① fail-closed 全谱（六引擎枚举，纯函数面） ----------
  console.log("S1 fail-closed 三路径×六引擎");
  {
    // 路径 A：无 capability（capability_state 缺失/null/词表外值——引擎未确认 confirmed 的
    // 一切形态）×六引擎+词表外引擎 ×bypass 请求：可用引擎降 ask、zcode/未知引擎 forbidden
    let noCapScanned = 0;
    let noCapUp = 0;
    for (const eng of [...ENGINES, "gpt-9"]) {
      for (const cap of [null, undefined, "half-confirmed"]) {
        const r = evaluatePermission({ requested_mode: "bypassPermissions", engine: eng, role: "worker", tier: "随手办", capability_state: cap, policy_source: "explicit" });
        noCapScanned++;
        if (eng === "zcode") {
          if (!(r.effective_mode === "forbidden" && r.reason === "zcode_fail_closed")) noCapUp++;
        } else if (eng === "gpt-9") {
          if (!(r.effective_mode === "forbidden" && r.reason === "unknown_engine")) noCapUp++;
        } else {
          if (!(r.effective_mode === "ask" && r.native_mode === null && r.reason === "capability_state_missing" && r.capability_state === null)) noCapUp++;
        }
      }
    }
    assert(noCapScanned === 21 && noCapUp === 0, `路径 A 无 capability×7 引擎×3 形态全谱 ${noCapScanned} 组合：可用引擎恒降 ask+native null、zcode/未知引擎恒 forbidden——零升权`);

    // 路径 B：未知 native 档（requested 词表外——客户端错/攻击面）×六引擎：恒 forbidden
    //（zcode 的 fail-closed 先于档位归一——reason=zcode_fail_closed 也是拒，更早拒同效）
    let unkModeUp = 0;
    let unkModeN = 0;
    for (const eng of ENGINES) {
      for (const m of ["turbo-hyper", "yolo", "sudo", "AUTO"]) {
        const r = evaluatePermission({ requested_mode: m, engine: eng, role: "worker", tier: "随手办", capability_state: engineCapabilityState(eng), policy_source: "explicit" });
        unkModeN++;
        const expectedReason = eng === "zcode" ? "zcode_fail_closed" : "unknown_requested_mode";
        if (!(r.effective_mode === "forbidden" && r.reason === expectedReason && r.native_mode === null)) unkModeUp++;
      }
    }
    assert(unkModeN === 24 && unkModeUp === 0, `路径 B 未知 native 档×6 引擎×4 攻击值全谱 ${unkModeN} 组合：恒 forbidden+native null——不猜不升权（zcode 词表闸先于档位归一）`);

    // 路径 C：unsupported 引擎（zcode 词表内 unsupported 恒 fail-closed+词表外同拒）
    // +engineCapabilityState 静态事实与求值行为交叉一致
    let unsupUp = 0;
    for (const role of ["worker", "team_pm", "review_pm"] as const) {
      for (const m of ["ask", "plan", "edit-auto", "full-auto", "bypassPermissions"]) {
        const r = evaluatePermission({ requested_mode: m, engine: "zcode", role, tier: "正经立项", capability_state: "unsupported", policy_source: "explicit" });
        if (!(r.effective_mode === "forbidden" && r.reason === "zcode_fail_closed")) unsupUp++;
      }
    }
    const gz = evaluatePermission({ requested_mode: "ask", engine: "gpt-9", role: "worker", tier: "随手办", capability_state: "unsupported", policy_source: "explicit" });
    assert(unsupUp === 0 && gz.effective_mode === "forbidden" && gz.reason === "unknown_engine", "路径 C unsupported 引擎：zcode 15 组合恒 forbidden+词表外 gpt-9 unknown_engine——capability 静态标注与拒面行为一致");
    assert(engineCapabilityState("zcode") === "unsupported" && engineCapabilityState("gpt-9") === "unsupported" && engineCapabilityState("claude") === "confirmed" && engineCapabilityState("codex") === "unverified", "capability 静态事实表交叉：zcode/词表外=unsupported、claude=confirmed、JSONL=unverified（§3.1 表不漂）");
  }

  // ---------- 束① 矩阵扫描：引擎×角色×环境 72 格（覆盖矩阵执行面，回单附表） ----------
  console.log("S2 矩阵 72 格扫描（引擎×角色×环境）");
  {
    let n = 0;
    let up = 0; // 升权违例
    let shapeBad = 0; // 结果形状违例
    for (const eng of ENGINES) {
      for (const role of ["worker", "team_pm", "review_pm", "intern"] as const) {
        for (const env of ["production", "sandbox", "unknown"] as const) {
          const r = evaluatePermission({
            requested_mode: "bypassPermissions", engine: eng, role, tier: "随手办",
            capability_state: engineCapabilityState(eng), policy_source: "explicit", env,
          });
          n++;
          // 形状不变量（全格）：八字段齐+effective 合法值
          const keys = Object.keys(r).sort();
          if (keys.length !== 8 || r.effective_mode === undefined) shapeBad++;
          // 分支序=求值序（engine 词表闸→role 词表→ceiling→环境闸——zcode 格连
          // unknown_role 都不落，reason 恒 zcode_fail_closed；ceiling 先于环境闸）：
          if (eng === "zcode") {
            if (!(r.effective_mode === "forbidden" && r.reason === "zcode_fail_closed")) up++;
          } else if (role === "intern") {
            // 词表外角色：全 18 格 forbidden（B3 债 fail-closed）
            if (!(r.effective_mode === "forbidden" && r.reason === "unknown_role")) up++;
          } else if (role === "review_pm") {
            // review_pm ceiling=edit-auto < bypass 归一 full-auto：先撞 ceiling 闸（任意 env）
            if (!(r.effective_mode === "forbidden" && r.reason === "above_role_tier_ceiling")) up++;
          } else if (env === "production" || env === "unknown") {
            // 环境禁列（worker/team_pm 格）：bypass 显式请求恒拒
            const expected = `${env === "production" ? "production" : "env_unknown"}_bypass_denied`;
            if (!(r.effective_mode === "forbidden" && r.reason === expected)) up++;
          } else {
            // sandbox 开放格：claude×worker/team_pm 保真 full-auto；JSONL unverified 降 edit-auto
            if (eng === "claude") {
              if (!(r.effective_mode === "full-auto" && r.native_mode === "bypassPermissions")) up++;
            } else if (!(r.effective_mode === "edit-auto" && r.native_mode === null && r.reason === "native_permission_not_confirmed")) up++;
          }
          // 保守序不变量（全格）：effective ≤ normalized 或 forbidden（零静默升权）
          if (r.effective_mode !== "forbidden" && r.normalized_mode !== null && CONSERV[r.effective_mode] > CONSERV[r.normalized_mode]) up++;
        }
      }
    }
    assert(n === 72 && up === 0 && shapeBad === 0, `矩阵 ${n} 格（6 引擎×4 角色×3 环境）：格格不变量成立——禁列无 bypass 保真、开放格按 capability 分型、词表外角色恒拒、保守序零违例`);
  }

  // ---------- 集成面工位（假 factory 拦 spawn+真审计库） ----------
  const cfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: join(root, "data"),
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const spawned: { cwd: string; permissionMode: string | undefined; engine?: string }[] = [];
  const mgr = new SessionManager(new EventBus(), cfg);
  mgr.setAgentFactory((cwd: string, _model: string, _cb: AgentCallbacks, _prompt: string | undefined, opts?: { permissionMode?: string; engine?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    spawned.push({ cwd, permissionMode: opts?.permissionMode, ...(opts?.engine ? { engine: opts.engine } : {}) });
    return a;
  });
  const auditPort = () => auditStore(cfg.dataDir);
  const auditCount = () => readPermissionAudit(auditPort()).length;

  // 派单拒面需要组 fixture（一锚一组；锚独立目录；组级 tier 词表=轻立项|正经立项，
  // 「随手办」仅是 dispatch 侧运行时兜底非 create 词表——轻立项×worker ceiling=full-auto
  // 对齐随手办行，语义等价）
  const anchor = join(root, "anchor-p817");
  mkdirSync(anchor, { recursive: true });
  const ackG = mgr.handleCommand(
    { command_id: "p817-g1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "P81-7 矩阵组", anchor_dir: anchor, tier: "轻立项" }, ts: Date.now() },
    "web-d",
  ) as { ok: boolean; data?: { group?: { id: string } } };
  const gid = ackG.data?.group?.id ?? "";
  assert(ackG.ok === true && gid !== "", "前置：轻立项组 fixture 建成（组级 tier 词表=轻立项|正经立项）");

  // ---------- 束② forbidden ACK 统一形状（四类拒绝集成面） ----------
  console.log("S3 forbidden ACK 四类统一形状");
  {
    const forbiddenShape = (ack: { ok?: boolean; error?: string; session_id?: string; permission?: unknown }, reason: string, label: string): boolean =>
      ack.ok === false && (ack.error ?? "").startsWith("forbidden: ") && (ack.error ?? "").includes(reason) &&
      ack.session_id === undefined && ack.permission === undefined && label.length > 0;

    // 类 1：unknown_role_mapping（岗位词表外——dispatchWorker 闸收紧面；actor 显式传值）
    const before1 = auditCount();
    const logBefore1 = readDispatchLog().length;
    const d1 = mgr.dispatchWorker({ anchor, prompt: "矩阵：词表外岗位", gid, role: "intern", actor: "web-d" });
    const rows1 = readPermissionAudit(auditPort());
    const r1 = rows1[0];
    assert(forbiddenShape(d1, "unknown_role_mapping", "dispatchWorker") && rows1.length === before1 + 1, "类 1 unknown_role_mapping：forbidden ACK 形状+审计落一行");
    assert(r1.actor === "web-d" && r1.reason === "unknown_role_mapping" && r1.environment === "sandbox" && r1.dir_scope === "sandbox" && r1.session_id === null, "类 1 审计可观测：actor/reason/environment/dir_scope 落值+session_id null（拒绝面无会话）");
    assert(readDispatchLog().length === logBefore1 && spawned.length === 0, "类 1 拒即无副作用：零台账+零 spawn");

    // 类 2：above_role_tier_ceiling（越 tier——review_pm ceiling edit-auto < bypass full-auto）
    const before2 = auditCount();
    const d2 = mgr.dispatchWorker({ anchor, prompt: "矩阵：越 tier", gid, role: "review_pm", actor: "web-d" });
    assert(forbiddenShape(d2, "above_role_tier_ceiling", "dispatchWorker") && auditCount() === before2 + 1, "类 2 above_role_tier_ceiling：forbidden ACK 形状+审计落一行");

    // 类 3：production_bypass_denied（生产目录维——cwd 传 ~/.cc-deck 路径字符串：
    // resolveDirScope 纯字符串判定零 IO，拒面在 create 前 return，无 mkdir/spawn 触达）
    const before3 = auditCount();
    const a3 = mgr.handleCommand(
      { command_id: "p817-c3", type: "COMMAND_CREATE", payload: { cwd: join(homedir(), ".cc-deck", "data"), prompt: "矩阵：生产目录 bypass", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(forbiddenShape(a3, "production_bypass_denied", "COMMAND_CREATE") && auditCount() === before3 + 1, "类 3 production_bypass_denied：forbidden ACK 形状+审计落一行（目录维 production）");
    const r3 = readPermissionAudit(auditPort())[0];
    assert(r3.dir_scope === "production" && r3.environment === "sandbox" && r3.actor === "web-d" && r3.command_id === "p817-c3", "类 3 审计可观测：dir_scope=production+environment=sandbox+actor/command_id 落值（两维分立可查）");
    assert(spawned.length === 0, "类 3 拒即无会话：零 spawn（生产目录无任何触达）");

    // 类 4：env_unknown_bypass_denied（非法环境——CCR_ENV=unknown 显式 fail-closed）
    const prevEnv = process.env.CCR_ENV;
    process.env.CCR_ENV = "unknown";
    const before4 = auditCount();
    const a4 = mgr.handleCommand(
      { command_id: "p817-c4", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "矩阵：非法环境 bypass", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(forbiddenShape(a4, "env_unknown_bypass_denied", "COMMAND_CREATE") && auditCount() === before4 + 1, "类 4 env_unknown_bypass_denied：forbidden ACK 形状+审计落一行（环境维 unknown）");
    if (prevEnv === undefined) delete process.env.CCR_ENV;
    else process.env.CCR_ENV = prevEnv;

    // 形状统一性：四类 ACK 投影同构（ok:false + forbidden: 前缀 + 无 session_id 无 permission）
    const wide = (x: unknown) => x as { ok?: boolean; error?: string; session_id?: string; permission?: unknown };
    const shapes = [d1, d2, a3, a4].map((x) => {
      const w = wide(x);
      return { ok: w.ok, forbiddenPrefix: (w.error ?? "").startsWith("forbidden: "), hasSession: w.session_id !== undefined, hasPerm: w.permission !== undefined };
    });
    assert(shapes.every((s) => s.ok === false && s.forbiddenPrefix && !s.hasSession && !s.hasPerm), "四类 ACK 形状统一：ok:false+forbidden: 前缀同构+拒绝面一律不带 session_id/permission（§6.1 统一拒绝面）");
    assert(spawned.length === 0 && readPermissionAudit(auditPort()).every((r) => r.effective_mode !== null && r.effective_mode !== ""), "全程零 spawn+审计表无空 effective 行（无半状态行）");
  }

  // ---------- 束③ 失败路径无半状态（审计写失败尽力而为） ----------
  console.log("S4 审计写失败无半状态");
  {
    const realRow = {
      requested_mode: "bypassPermissions", normalized_mode: null, effective_mode: "forbidden", native_mode: null,
      capability_state: "confirmed", engine: "claude", reason: "production_bypass_denied", policy_source: "explicit",
      environment: "sandbox" as const, dir_scope: "sandbox" as const, tier: "随手办", actor: "web-d",
      session_id: null, command_id: "p817-fake", created_at: Date.now(),
    };
    const before = auditCount();
    const throwingPort = { exec: () => { throw new Error("disk full（模拟审计写失败）"); }, query: () => [] };
    let threw = false;
    try {
      appendPermissionAudit(throwingPort as unknown as Parameters<typeof appendPermissionAudit>[0], realRow);
    } catch {
      threw = true;
    }
    assert(threw === false, "审计写失败不抛（尽力而为纪律——fake port 模拟 throw，appendPermissionAudit 吞错只 warn）");
    const rows = readPermissionAudit(auditPort());
    assert(rows.length === before && !rows.some((r) => r.command_id === "p817-fake"), "审计写失败无半行：真库行数不变+无 p817-fake 残行（写失败=不落，绝无半态行）");
    assert(rows.every((r) => typeof r.effective_mode === "string" && r.effective_mode !== ""), "全表扫描无空 effective_mode（无半行佐证）");

    // 主路径存活：审计写失败后紧接正常开卡——审计失败绝不阻断开卡主路径
    const aOk = mgr.handleCommand(
      { command_id: "p817-ok1", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "审计失败后主路径存活", permissionMode: "plan" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(aOk.ok === true && typeof aOk.session_id === "string" && auditCount() === before + 1, "主路径存活：审计写失败后正常开卡 ok:true+spawn+审计恢复落行（尽力而为不阻断）");
  }

  // ---------- 束④ 重放/重试幂等（processedCommands 幂等键） ----------
  console.log("S5 重放/重试幂等");
  {
    // a. forbidden 命令同 id 重发：重放首回执（duplicate 标记）+审计不重复灌行+无二次 spawn
    const dFailId = "p817-r1";
    mgr.handleCommand(
      { command_id: dFailId, type: "COMMAND_CREATE", payload: { cwd: join(homedir(), ".cc-deck", "data"), prompt: "幂等：生产目录拒首发", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    );
    const afterFirst = auditCount();
    const spawnBeforeReplay = spawned.length;
    const replay1 = mgr.handleCommand(
      { command_id: dFailId, type: "COMMAND_CREATE", payload: { cwd: join(homedir(), ".cc-deck", "data"), prompt: "幂等：生产目录拒重发", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload & { duplicate?: boolean };
    assert(replay1.duplicate === true && replay1.ok === false && (replay1.error ?? "").startsWith("forbidden: ") && replay1.session_id === undefined, "forbidden 重发：duplicate=true+首回执原样重放（防失败后同 id 重试假成功 #65）");
    assert(auditCount() === afterFirst && readPermissionAudit(auditPort()).filter((r) => r.command_id === dFailId).length === 1, "forbidden 重发审计不重复灌行：行数不变+同 command_id 恰一行（幂等键）");
    assert(spawned.length === spawnBeforeReplay, "forbidden 重发零新增 spawn（重放不重执行）");

    // b. 成功命令同 id 重发：重放首回执+session_id 恒等+permission 深等（effective 档恒等）+审计恰一行
    const okId = "p817-r2";
    const firstAck = mgr.handleCommand(
      { command_id: okId, type: "COMMAND_CREATE", payload: { cwd: root, prompt: "幂等：成功首发", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    const spawnAfterFirst = spawned.length;
    const auditAfterFirst = auditCount();
    const replay2 = mgr.handleCommand(
      { command_id: okId, type: "COMMAND_CREATE", payload: { cwd: root, prompt: "幂等：成功重发", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload & { duplicate?: boolean };
    assert(
      replay2.duplicate === true && replay2.ok === true && replay2.session_id === firstAck.session_id &&
      JSON.stringify(replay2.permission) === JSON.stringify(firstAck.permission) && replay2.permission?.effective === "full-auto",
      "成功重发：duplicate=true+session_id 恒等+permission 深等（effective=full-auto 档恒等——重放不改判）",
    );
    assert(spawned.length === spawnAfterFirst && auditCount() === auditAfterFirst, "成功重发无二次效应：零二次 spawn+审计不重复灌行（processedCommands 幂等键）");

    // c. 求值纯函数幂等（集成语义复锁：同参含两维两次深等——重放背后的判等基础）
    const e1: PolicyResult = evaluatePermission({ requested_mode: "bypassPermissions", engine: "claude", role: "team_pm", tier: "随手办", capability_state: "confirmed", policy_source: "explicit", dir_scope: "sandbox", env: "sandbox" });
    const e2 = evaluatePermission({ requested_mode: "bypassPermissions", engine: "claude", role: "team_pm", tier: "随手办", capability_state: "confirmed", policy_source: "explicit", dir_scope: "sandbox", env: "sandbox" });
    assert(JSON.stringify(e1) === JSON.stringify(e2) && e1.effective_mode === "full-auto", "求值幂等：同参含环境两维两次深等（纯函数零副作用——重放判等基础）");

    // d. dispatchWorker 成功面（岗位映射 pm→team_pm 触达+审计 session_id 落承接会话）——
    //    与 COMMAND_CREATE 闸互补：岗位词表 worker/pm/review+intern 四值集成触达全
    const dPm = mgr.dispatchWorker({ anchor, prompt: "矩阵：pm 岗位映射成功面", gid, role: "pm" });
    const rowsPm = readPermissionAudit(auditPort());
    const rPm = rowsPm[0];
    assert(dPm.ok === true && "session_id" in dPm && rPm.reason === "ok" && rPm.policy_source === "tier_default" && rPm.session_id === (dPm as { session_id: string }).session_id, "pm 岗位映射成功面：映射 team_pm×随手办 ceiling 内放行+审计 session_id=承接会话（与 COMMAND_CREATE 对称）");
  }

  console.log(`P81-7 permission compat matrix: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}
