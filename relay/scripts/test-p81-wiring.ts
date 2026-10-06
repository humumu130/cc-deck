// P81-2/P81-5/P81-6 权限接线测试锁（直跑范式）——specs/081 §4/§5/§6.1/§6.3。
// 十一组断言：①SNAPSHOT 摘要形状锁；②接线映射层锁（与 session-manager 闸同构造，漂移即红）；
// ③forbidden ACK 统一拒绝面（闸拒均在 spawn/落账前）；④派单闸与零台账（dispatch-log 口径）；
// ⑤硬断言（effective ≤ ceiling 全谱+摘要 modes 自洽）；
// 【P81-5】⑥真实判定三值（resolveDirScope/resolveEnvScope——production/sandbox/unknown
// 全谱+CCR_ENV 显式压倒）；⑦审计行形状锁（十字段+运维列亲读——成功与拒绝都落 §6.3）；
// ⑧spawn 传值收口（假 factory 拦截直证实参：claude sandbox bypass 恒等/JSONL 降级
// acceptEdits 实参变化点/state 继承源）；⑨混编分支（mixed_engine 组→mixed_team_default
// 物化）；⑩岗位收紧（未知岗位 forbidden unknown_role_mapping——B3 债 fail-closed）。
// 【P81-6】⑪旧值规范化（normalizeLegacy 纯函数矩阵+resume 三面：claude bypass 保留/
// JSONL 降档+legacy_state_normalized 审计/缺字段 default 零审计/identity 恒等+回写收敛单次性）。
// 隔离：mkdtemp 临时目录、env 五清、端口 8795（避 8787 生产与 8792/8793/8798/8799 禁用段）；
// 生产 8787 与 ~/.cc-deck 零触达。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventBus } from "../src/event-bus.js";
import type { RelayConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { engineCapabilityState, evaluatePermission, normalizeLegacyPermissionMode, permissionCapabilitiesSummary } from "../src/permission-policy.js";
import { auditStore, readPermissionAudit, resolveDirScope, resolveEnvScope } from "../src/permission-audit.js";
import { readDispatchLog } from "../src/org.js";
import type { CommandAckPayload, Command, SessionEngine } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
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
  let gidAudit = ""; // 审计/对照组 id（S7 建，S9/S10 复用——块间提升）

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

  // 显式 cfg（port 8795=sandbox 判定；loadConfig 缺省 8787=production 不合测试语境）+
  // 假 agentFactory 拦 spawn（成功路径实参直测——P81-5 升级，m12-commands 同范式）
  const mgrCfg: RelayConfig = {
    port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: join(root, "data"),
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const spawned: { cwd: string; prompt: string | undefined; permissionMode: string | undefined; engine?: string; cb?: AgentCallbacks; agent?: AgentLike }[] = [];
  const makeFakeFactory = () =>
    (cwd: string, _model: string, _cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; engine?: string }): AgentLike => {
      const a: AgentLike = {
        id: randomUUID(),
        startedAt: Date.now(),
        ended: false,
        sendMessage: () => {},
        allow: () => false,
        deny: () => false,
        answer: () => false,
        stop: async () => {
          a.ended = true;
        },
        setPermissionMode: async () => {},
      };
      spawned.push({ cwd, prompt, permissionMode: opts?.permissionMode, ...(opts?.engine ? { engine: opts.engine } : {}), cb: _cb, agent: a });
      return a;
    };
  const bus = new EventBus();
  const mgr = new SessionManager(bus, mgrCfg);
  mgr.setAgentFactory(makeFakeFactory());
  const auditPort = () => auditStore(mgrCfg.dataDir);

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

  // ---------- ⑥ 真实判定三值（P81-5 判定函数直调） ----------
  console.log("S6 真实判定");
  {
    assert(resolveDirScope(root) === "sandbox", "判定×tmp 临时目录→sandbox（用户项目目录语义）");
    assert(resolveDirScope(join(root, "sub")) === "sandbox", "判定×tmp 子目录→sandbox 同款");
    const home = homedir();
    assert(resolveDirScope(join(home, ".cc-deck")) === "production", "判定×~/.cc-deck→production（组织数据域，§6.1 隔离铁律）");
    assert(resolveDirScope(join(home, ".cc-deck", "data")) === "production", "判定×~/.cc-deck 深层→production 同款");
    assert(resolveDirScope(home) === "production", "判定×家目录本体→production（敏感面保守）");
    assert(resolveDirScope("") === "unknown" && resolveDirScope(null) === "unknown" && resolveDirScope("rel/path") === "unknown", "判定×空/null/相对路径→unknown（判不出显式回 unknown——P81-3/4 纪律，绝不缺席）");
    assert(resolveEnvScope(8787) === "production", "环境判定×8787→production（生产 relay 缺省端口识别）");
    assert(resolveEnvScope(8795) === "sandbox", "环境判定×8795→sandbox（测试/开发端口）");
    assert(resolveEnvScope(null) === "unknown", "环境判定×null→unknown（fail-closed）");
    const prevEnv = process.env.CCR_ENV;
    process.env.CCR_ENV = "production";
    assert(resolveEnvScope(8795) === "production", "CCR_ENV=production 显式压倒 port（测试/演练可控开关）");
    process.env.CCR_ENV = "sandbox";
    assert(resolveEnvScope(8787) === "sandbox", "CCR_ENV=sandbox 显式压倒 8787 同款");
    if (prevEnv === undefined) delete process.env.CCR_ENV;
    else process.env.CCR_ENV = prevEnv;
  }

  // ---------- ⑦ 审计行形状锁（成功与拒绝都落，§6.3；十字段+运维列亲读） ----------
  console.log("S7 审计形状");
  {
    const before = readPermissionAudit(auditPort()).length;
    // production 拒面集成（CCR_ENV 显式——判定函数已直测，闸集成走显式开关最可控）
    const prevEnv = process.env.CCR_ENV;
    process.env.CCR_ENV = "production";
    const ackP = mgr.handleCommand(
      { command_id: "p81-a1", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "生产 bypass 拒", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackP.ok === false && (ackP.error ?? "").includes("production_bypass_denied"), "环境闸集成×production×bypass 勾选→forbidden（旧行为=放行——P81-5 新拒面）");
    const rowsP = readPermissionAudit(auditPort());
    assert(rowsP.length === before + 1, "production 拒面审计行落库（拒绝也写审计 §6.3）");
    const r = rowsP[0];
    assert(
      r.requested_mode === "bypassPermissions" && r.normalized_mode === null && r.effective_mode === "forbidden" && r.native_mode === null &&
      r.capability_state === "confirmed" && r.engine === "claude" && r.reason === "production_bypass_denied" && r.policy_source === "explicit" &&
      r.environment === "production" && r.dir_scope === "sandbox" && r.tier === "随手办" && r.session_id === null && r.command_id === "p81-a1",
      "审计行十字段+运维列逐字段亲读（requested/normalized/effective/native/capability_state/engine/reason/policy_source/environment/dir_scope 全对位）",
    );
    process.env.CCR_ENV = prevEnv === undefined ? undefined : prevEnv;
    if (prevEnv === undefined) delete process.env.CCR_ENV;

    // zcode 拒面审计（B8 修正：拒单并入）
    const beforeZ = readPermissionAudit(auditPort()).length;
    mgr.handleCommand(
      { command_id: "p81-a2", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "zcode 审计", permissionMode: "bypassPermissions", engine: "zcode" }, ts: Date.now() },
      "web-d",
    );
    const rowsZ = readPermissionAudit(auditPort());
    assert(rowsZ.length === beforeZ + 1 && rowsZ[0].reason === "zcode_fail_closed" && rowsZ[0].effective_mode === "forbidden", "zcode 拒面审计行（reason=zcode_fail_closed）——拒绝面审计全覆盖");

    // 未知引擎拒面审计
    mgr.handleCommand(
      { command_id: "p81-a3", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "未知引擎审计", engine: "gpt-9" as SessionEngine }, ts: Date.now() },
      "web-d",
    );
    const rowsU = readPermissionAudit(auditPort());
    assert(rowsU.length === beforeZ + 2 && rowsU[0].reason === "unknown_engine" && rowsU[0].engine === "gpt-9", "未知引擎拒面审计行（词表外 engine 值留审计）");

    // 未知岗位收紧拒面审计（dispatchWorker）——组锚独立目录（一锚一组护栏，root 已被 S4 组占用）
    const anchorAudit = join(root, "anchor-audit");
    mkdirSync(anchorAudit, { recursive: true });
    const ackG = mgr.handleCommand(
      { command_id: "p81-g2", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "审计组", anchor_dir: anchorAudit, tier: "轻立项" }, ts: Date.now() },
      "web-d",
    ) as { ok: boolean; data?: { group?: { id: string } } };
    gidAudit = ackG.data?.group?.id ?? "";
    assert(ackG.ok === true && gidAudit !== "", "前置：审计组建锚独立（一锚一组护栏下建成）");
    const beforeR = readPermissionAudit(auditPort()).length;
    const dR = mgr.dispatchWorker({ anchor: root, prompt: "未知岗位收紧", gid: gidAudit, role: "intern" });
    assert(dR.ok === false && "error" in dR && dR.error.startsWith("forbidden:") && dR.error.includes("unknown_role_mapping"), "岗位收紧集成×intern→forbidden unknown_role_mapping（B3 债：fail-closed 不猜）");
    const rowsR = readPermissionAudit(auditPort());
    assert(rowsR.length === beforeR + 1 && rowsR[0].reason === "unknown_role_mapping" && rowsR[0].policy_source === null && rowsR[0].effective_mode === "forbidden", "收紧拒面审计行（policy_source=null——未达 source 裁决步）");
  }

  // ---------- ⑧ spawn 传值收口（假 factory 直证实参——P81-5 行为面核心） ----------
  console.log("S8 spawn 收口");
  {
    const ackC = mgr.handleCommand(
      { command_id: "p81-s1", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "claude 沙盒 bypass 收口", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackC.ok === true && typeof ackC.session_id === "string" && ackC.permission?.effective === "full-auto" && ackC.permission.native_mode === "bypassPermissions", "claude×sandbox×bypass 勾选：成功 ACK+回执 full-auto 恒等（多数路径行为零变）");
    const lastC = spawned[spawned.length - 1];
    assert(lastC.permissionMode === "bypassPermissions", "spawn 实参直证×claude sandbox：bypassPermissions 恒等（收口不改变合法放行）");
    assert(lastC.cwd === root, "spawn cwd=请求 cwd（锚定不漂）");

    const ackJ = mgr.handleCommand(
      { command_id: "p81-s2", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "JSONL 降级收口", permissionMode: "bypassPermissions", engine: "codex" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackJ.ok === true && ackJ.permission?.effective === "edit-auto" && ackJ.permission.native_mode === null && ackJ.permission.reason === "native_permission_not_confirmed", "JSONL×codex×bypass：降级回执 effective=edit-auto+native null（caller 可见）");
    const lastJ = spawned[spawned.length - 1];
    assert(lastJ.permissionMode === "acceptEdits" && lastJ.engine === "codex", "spawn 实参直证×JSONL：acceptEdits（实参变化点——旧=bypassPermissions 伪装审批绕过，收口后 CLI 收降级档）");

    const rowsC = readPermissionAudit(auditPort());
    const rc = rowsC.find((x) => x.command_id === "p81-s1");
    const rj = rowsC.find((x) => x.command_id === "p81-s2");
    assert(rc !== undefined && rc.effective_mode === "full-auto" && rc.session_id === ackC.session_id && rc.environment === "sandbox" && rc.actor === "web-d", "成功路径审计行：session_id 落新会话+environment=sandbox+actor 落值");
    assert(rj !== undefined && rj.effective_mode === "edit-auto" && rj.native_mode === null, "成功降级审计行：effective=edit-auto 落库（不伪装 bypass）");
  }

  // ---------- ⑨ 混编分支（mixed_engine 组→mixed_team_default 物化，B4 债） ----------
  console.log("S9 混编分支");
  {
    const anchorMixed = join(root, "anchor-mixed");
    mkdirSync(anchorMixed, { recursive: true });
    const ackM = mgr.handleCommand(
      { command_id: "p81-m1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "混编组", anchor_dir: anchorMixed, tier: "轻立项", mixed_engine: true }, ts: Date.now() } as unknown as Command,
      "web-d",
    ) as { ok: boolean; data?: { group?: { id: string; mixed_engine?: boolean } } };
    const gidM = ackM.data?.group?.id ?? "";
    assert(ackM.ok === true && gidM !== "" && ackM.data?.group?.mixed_engine === true, "混编标记组 fixture 建成（mixed_engine 落库面）");

    const dM = mgr.dispatchWorker({ anchor: root, prompt: "混编派单", gid: gidM });
    assert(dM.ok === true && "permission" in dM && dM.permission !== undefined, "混编组 worker 派单成功（物化 bypass→sandbox ceiling 内放行）");
    const rowsM = readPermissionAudit(auditPort());
    const rm = rowsM.find((x) => x.policy_source === "mixed_team_default");
    assert(rm !== undefined && rm.reason === "ok" && rm.requested_mode === "bypassPermissions" && rm.effective_mode === "full-auto" && rm.session_id !== null, "混编审计行：policy_source=mixed_team_default（物化由 requested+source 双字段承载 §5.3.1——reason=ok 即降级/拒绝事实优先下的正解）+承接会话 id 落库");

    // 对照：普通组（S7 fixture 审计组）同 worker 派单→tier_default
    const dT = mgr.dispatchWorker({ anchor: root, prompt: "普通组对照", gid: gidAudit });
    assert(dT.ok === true && "permission" in dT, "普通组 worker 派单成功（对照面）");
    const rowsT = readPermissionAudit(auditPort());
    const rt = rowsT.find((x) => x.policy_source === "tier_default" && x.session_id !== null);
    assert(rt !== undefined && rt.effective_mode === "full-auto", "普通组审计行：policy_source=tier_default（混编/普通两路分立可查）");
  }

  // ---------- ⑩ 收紧面已在 S7 集成（unknown_role_mapping）——本节锁 ACK 形状+零台账 ----------
  console.log("S10 收紧面 ACK");
  {
    const before = readDispatchLog().length;
    const d = mgr.dispatchWorker({ anchor: root, prompt: "收紧 ACK 形状", gid: gidAudit, role: "cto" });
    assert(d.ok === false && "error" in d && d.error.startsWith("forbidden: unknown_role_mapping"), "收紧 ACK：ok:false+forbidden: unknown_role_mapping 前缀统一拒绝面");
    assert(readDispatchLog().length === before, "收紧拒单零台账（dispatch-log 不变——权限拒面唯一落点=audit 表）");
  }

  // ---------- ⑪ 旧值规范化（P81-6：§5.3.2 旧值映射+§6.3 不声称 bypass——只降不升） ----------
  console.log("S11 旧值规范化");
  {
    // 纯函数矩阵直测：四旧值+缺字段+未知值全谱（不升权铁断言：未知值绝不映射 bypass）
    assert(normalizeLegacyPermissionMode("default").mode === "default" && normalizeLegacyPermissionMode("default").kind === "identity", "纯函数×default→恒等 identity");
    assert(normalizeLegacyPermissionMode("acceptEdits").mode === "acceptEdits" && normalizeLegacyPermissionMode("plan").mode === "plan" && normalizeLegacyPermissionMode("plan").kind === "identity", "纯函数×acceptEdits/plan→恒等 identity");
    const nb = normalizeLegacyPermissionMode("bypassPermissions");
    assert(nb.mode === "acceptEdits" && nb.kind === "bypass_demoted", "纯函数×bypass→acceptEdits 降档（只降不升——ceiling 内保守档，与 §5.3.2/环境闸降档全库同档）");
    assert(normalizeLegacyPermissionMode(null).mode === "default" && normalizeLegacyPermissionMode(null).kind === "missing_default" && normalizeLegacyPermissionMode(undefined).kind === "missing_default" && normalizeLegacyPermissionMode("").mode === "default", "纯函数×缺字段/null/空串→default 安全回退（native 不设 bypass）");
    for (const unknown of ["auto", "manual", "skip", "gibberish"]) {
      const nu = normalizeLegacyPermissionMode(unknown);
      assert(nu.mode === "default" && nu.kind === "unknown_reset", `纯函数×未知值 "${unknown}"→default fail-closed（绝不 bypass）`);
    }

    const legacyBefore = () => readPermissionAudit(auditPort()).filter((r) => r.reason === "legacy_state_normalized").length;

    // a. claude×bypass 保留面（native 真实生效过=「当时真实生效档」§5.3.2——P81-5 后
    //    create 求值恒等放行的合法卡，resume 不得误伤降级——:111 用户实踩教训同构）
    const ackA = mgr.handleCommand(
      { command_id: "p81-r1", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "claude bypass 保留面", permissionMode: "bypassPermissions" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackA.ok === true && typeof ackA.session_id === "string", "前置：claude×bypass 卡建成（state=bypass 合法路径）");
    // state.pm 镜像入口=onInit 第三参（CLI init 回报镜像 :2964——真 CLI 行为模拟）
    spawned[spawned.length - 1]?.cb?.onInit("sdk-p81r1", "test-model", "bypassPermissions");
    if (spawned[spawned.length - 1]?.agent) spawned[spawned.length - 1].agent!.ended = true; // 流死→MESSAGE 走 resumeAgent 真路径
    const lgB = legacyBefore();
    mgr.handleCommand({ command_id: "p81-r1m", type: "COMMAND_MESSAGE", payload: { session_id: ackA.session_id!, text: "resume 触发" }, ts: Date.now() } as unknown as Command, "web-d");
    const lastA = spawned[spawned.length - 1];
    assert(lastA.permissionMode === "bypassPermissions", "claude×bypass resume：spawn 实参保持 bypassPermissions（confirmed 族保留——零误伤）");
    assert(legacyBefore() === lgB, "claude×bypass resume 零审计（保留面非规范化事件）");

    // b. JSONL 降档面（codex 卡 state=bypass——onInit 镜像=P81-5 前直传时代的残留等价
    //    制造：state 声称 bypass 而 unverified 下 CLI 从未真实生效）
    const ackB = mgr.handleCommand(
      { command_id: "p81-r2", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "codex 旧值卡", engine: "codex" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    assert(ackB.ok === true && typeof ackB.session_id === "string", `前置：codex 旧值卡建成（ok=${ackB.ok} err=${"error" in ackB ? ackB.error : "-"}）`);
    spawned[spawned.length - 1]?.cb?.onInit("sdk-p81r2", "test-model", "bypassPermissions"); // CLI 回报 bypass=伪装时代镜像（unverified 下 CLI 从未真实生效）
    if (spawned[spawned.length - 1]?.agent) spawned[spawned.length - 1].agent!.ended = true; // 流死→resumeAgent（codex 非 reinjection 族走主读点）
    const lgB2 = legacyBefore();
    mgr.handleCommand({ command_id: "p81-r2m", type: "COMMAND_MESSAGE", payload: { session_id: ackB.session_id!, text: "resume 触发降档" }, ts: Date.now() } as unknown as Command, "web-d");
    const lastB = spawned[spawned.length - 1];
    assert(lastB.permissionMode === "acceptEdits" && lastB.engine === "codex", "JSONL×state bypass resume：spawn 实参 acceptEdits（声称从未真实生效——§6.3 降档对齐）");
    const rowsL = readPermissionAudit(auditPort());
    const rl = rowsL.find((r) => r.reason === "legacy_state_normalized");
    assert(rl !== undefined && rl.requested_mode === "bypassPermissions" && rl.effective_mode === "acceptEdits" && rl.normalized_mode === "edit-auto", "降档审计行：requested=bypass/effective=acceptEdits/normalized=edit-auto（旧值留档+新值落位）");
    assert(rl !== undefined && rl.session_id === ackB.session_id && rl.command_id === null && rl.policy_source === null && rl.native_mode === null, "降档审计行形状：session_id=被规范化会话+command_id/policy_source/native 全 null（状态迁移非策略裁决——§6.3 保守）");

    // c. 缺字段面（COMMAND_CREATE 无 permissionMode→state 无键）：default 零审计零变
    const ackC = mgr.handleCommand(
      { command_id: "p81-r3", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "缺字段卡" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    spawned[spawned.length - 1]?.cb?.onInit("sdk-p81r3", "test-model");
    if (spawned[spawned.length - 1]?.agent) spawned[spawned.length - 1].agent!.ended = true;
    const lgB3 = legacyBefore();
    mgr.handleCommand({ command_id: "p81-r3m", type: "COMMAND_MESSAGE", payload: { session_id: ackC.session_id!, text: "resume 触发缺字段" }, ts: Date.now() } as unknown as Command, "web-d");
    assert(spawned[spawned.length - 1].permissionMode === "default" && legacyBefore() === lgB3, "缺字段卡 resume：spawn default（安全回退与既有 ?? default 逐字节一致）+零审计");

    // d. identity 恒等（plan 卡）：resume 恒等零审计
    const ackD = mgr.handleCommand(
      { command_id: "p81-r4", type: "COMMAND_CREATE", payload: { cwd: root, prompt: "plan 卡", permissionMode: "plan" }, ts: Date.now() },
      "web-d",
    ) as CommandAckPayload;
    spawned[spawned.length - 1]?.cb?.onInit("sdk-p81r4", "test-model", "plan");
    if (spawned[spawned.length - 1]?.agent) spawned[spawned.length - 1].agent!.ended = true;
    const lgB4 = legacyBefore();
    mgr.handleCommand({ command_id: "p81-r4m", type: "COMMAND_MESSAGE", payload: { session_id: ackD.session_id!, text: "resume 触发 identity" }, ts: Date.now() } as unknown as Command, "web-d");
    assert(spawned[spawned.length - 1].permissionMode === "plan" && legacyBefore() === lgB4, "plan 卡 resume：恒等 identity+零审计");

    // e. 降档收敛单次性：b 卡再次 resume（置死复活流）——state 已回写 acceptEdits→
    //    读点 identity 恒等，审计不再重复落（一次规范化终身收敛）
    const after1 = legacyBefore();
    if (lastB.agent) lastB.agent.ended = true; // 置死 b 卡 resume 流（lastB=其 spawn 记录引用）
    mgr.handleCommand({ command_id: "p81-r2m2", type: "COMMAND_MESSAGE", payload: { session_id: ackB.session_id!, text: "二次 resume 收敛" }, ts: Date.now() } as unknown as Command, "web-d");
    const lastB2 = spawned[spawned.length - 1];
    assert(lastB2.permissionMode === "acceptEdits" && lastB2 !== lastB && legacyBefore() === after1, "二次 resume：回写收敛恒等 acceptEdits（真再读 state）+审计只落一次");
  }

  console.log(`P81-2/P81-5 permission wiring: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}
