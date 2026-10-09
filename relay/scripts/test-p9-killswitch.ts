// P81-9 kill-switch 三态兼容矩阵测试锁（直跑范式）——specs/081 §8 回退与迁移。
// 断言组：S0 开关词表纯函数（on/off+宽容值+未知值 fail-safe 当 off）；S1 off 态开卡旧
// 直通（四闸跳过/forbidden 缺席/ACK 旧 relay wire 形态/审计零新增/未知引擎校验保留但
// 不落审计）；S2 三态矩阵×新开卡（旧客户端四档 wire 两态零拒=「旧客户端×新 relay」与
// 「新客户端×旧 relay」wire 基准；on 有 permission 键 off 无=「新×新」全链；codex 同输入
// 两态分叉直证开关生效）；S3 resume 旧卡续跑两态（off 原值直读不降档不审计不回写/
// 缺字段 default 为 P81 前既有惯例保留）；S4 派单两态（off 硬传 bypass+未知岗位不拒，
// on 对照面）；S5 SNAPSHOT 摘要停发静态锚（两出口 conditional spread 字面量+off 语义
// 同构造直测——端上半由 P81-8W expo 侧既有锚锁，relay 半=本组停发键）；S6 生产零触达
// （env 全程 tmp）；S7 版本锚（plugin.json 0.2.39 字面量+marketplace 同源回写+bundle
// 双产物 SHA 相等）。
// 隔离：mkdtemp、env 五清+CCR_PERMISSION_POLICY 自碰自恢复、端口 8796（避生产 8787 与
// 8792/8793/8795/8798/8799）；生产 ~/.cc-deck 零触达。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventBus } from "../src/event-bus.js";
import type { RelayConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { permissionCapabilitiesSummary, permissionPolicyEnabled } from "../src/permission-policy.js";
import { auditStore, readPermissionAudit } from "../src/permission-audit.js";
import { createHash } from "node:crypto";
import type { CommandAckPayload, Command } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import { setLightConfirmTrusted } from "../src/projects.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-p9-killswitch-"));
const savedSwitch = process.env.CCR_PERMISSION_POLICY; // 自碰键保存（finally 恢复——try 外声明作用域可见）
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
function setSwitch(v: string | undefined): void {
  if (v === undefined) delete process.env.CCR_PERMISSION_POLICY;
  else process.env.CCR_PERMISSION_POLICY = v;
}

try {
  process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（SQLITE-FLIP 后缺省=sqlite，fixture 是 json 形态——75-R 回归发现的漏网连带面，九件钉档同口径）
  process.env.CCR_DATA_DIR = join(root, "data");
  process.env.CCR_ORG_DIR = join(root, "org");
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE"]) delete process.env[k];
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "org"), { recursive: true });
  setLightConfirmTrusted(true);

  // ---------- S0 开关词表纯函数 ----------
  console.log("S0 开关词表");
  {
    setSwitch(undefined);
    assert(permissionPolicyEnabled() === true, "未设→开（默认=新 policy 生效）");
    setSwitch("");
    assert(permissionPolicyEnabled() === true, "空串→开");
    for (const on of ["on", "ON", "1", "true", "True"]) {
      setSwitch(on);
      assert(permissionPolicyEnabled() === true, `词表 "${on}"→开`);
    }
    for (const off of ["off", "OFF", "0", "false", "False"]) {
      setSwitch(off);
      assert(permissionPolicyEnabled() === false, `词表 "${off}"→关`);
    }
    setSwitch("yes");
    assert(permissionPolicyEnabled() === false, "未知值 fail-safe→关（回退场景宁可多退，不可该退没退成）");
    setSwitch(undefined);
  }

  // fixture（p81-wiring 同范式：显式 cfg sandbox 端口+假 factory 拦 spawn 实参）
  const mgrCfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
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
  const auditRows = () => readPermissionAudit(auditPort()).length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 私有面直捅（state 回写断言；require/sessions 均 private 无公开读口）
  const sessionsMap = () => (mgr as unknown as { sessions: Map<string, { state: { permission_mode?: string } }> }).sessions;
  const mkCmd = (id: string, payload: Record<string, unknown>): Command =>
    ({ command_id: id, type: "COMMAND_CREATE", payload, ts: Date.now() }) as unknown as Command;
  const lastSpawn = () => spawned[spawned.length - 1];

  // ---------- S1 off 态开卡旧直通 ----------
  console.log("S1 off 态旧直通");
  {
    // 对照面：on 态 zcode×bypass 被 zcode_fail_closed 拒（闸在位证明）
    setSwitch("on");
    const ackOn = mgr.handleCommand(mkCmd("p9-on-z", { cwd: root, prompt: "on 态 zcode 闸", permissionMode: "bypassPermissions", engine: "zcode" }), "web-d") as CommandAckPayload;
    assert(ackOn.ok === false && typeof ackOn.error === "string" && ackOn.error.startsWith("forbidden:"), "对照：on 态 zcode×bypass→forbidden（新 policy 闸在位）");

    // off 态同输入：zcode 仍拒但拒因换层——create 内既有闸（「unsupported engine: zcode」
    // 不可选语义是 P81 前既有，非 P81 线；「完整回 P81 前」=该闸保留不因回退放开）
    setSwitch("off");
    const before = auditRows();
    const ackZ = mgr.handleCommand(mkCmd("p9-off-z", { cwd: root, prompt: "off 态 zcode 直通", permissionMode: "bypassPermissions", engine: "zcode" }), "web-d") as CommandAckPayload;
    assert(ackZ.ok === false && typeof ackZ.error === "string" && ackZ.error.includes("未注册引擎: zcode"), "off×zcode×bypass：仍拒于 create 既有闸（不可选语义非 P81 线——回退不变味）");

    // off×codex×bypass：on 态会降 acceptEdits，off 态直通 bypass（两态分叉直证在 S2 对照）
    const ackC = mgr.handleCommand(mkCmd("p9-off-c", { cwd: root, prompt: "off codex 直通", permissionMode: "bypassPermissions", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackC.ok === true && lastSpawn()?.permissionMode === "bypassPermissions", "off×codex×bypass：spawn 实参 bypassPermissions（直通）");

    // off×无 permissionMode：undefined 直通（P81 前 pm 计算形态）；ACK 键集恰三
    //（无 engine/degraded 附加的普通卡——P81 前 wire 形态「新客户端×旧 relay」基准）
    const ackU = mgr.handleCommand(mkCmd("p9-off-u", { cwd: root, prompt: "off 无勾选" }), "web-d") as CommandAckPayload;
    assert(ackU.ok === true && lastSpawn()?.permissionMode === undefined, "off×无勾选：spawn 实参 undefined（P81 前「勾选才 bypass」直通）");
    assert(JSON.stringify(Object.keys(ackU).sort()) === JSON.stringify(["command_id", "ok", "session_id"]), "off ACK 键集恰三（command_id/ok/session_id）=P81 前 wire 形态");

    // off 态全程审计零新增（对照 forbidden×1+zcode 既有闸拒×1 都不落新 P81 审计——「回退不删除
    // 任何事实源」=既有照旧，新面不写）
    assert(auditRows() === before, "off 态全程审计零新增（回退态不落新 P81 审计）");

    // 未知引擎校验保留（非 P81 线）但恢复 P81 前口径：拒不落审计
    const beforeX = auditRows();
    const ackX = mgr.handleCommand(mkCmd("p9-off-x", { cwd: root, prompt: "off 未知引擎", engine: "nosuch-engine" }), "web-d") as CommandAckPayload;
    assert(ackX.ok === false && typeof ackX.error === "string" && ackX.error.includes("未知引擎"), "off×未知引擎：仍拒（isSessionEngine 校验保留——非 P81 线）");
    assert(auditRows() === beforeX, "off×未知引擎拒：审计零新增（恢复 P81 前「拒不落审计」口径）");
  }

  // ---------- S2 三态矩阵×新开卡 ----------
  console.log("S2 三态矩阵");
  {
    // 「旧客户端×新 relay」：四档 wire 词表 on/off 两态全过（旧客户端发既有四档值
    // 不炸不拒——wire 契约保持，§8.2.4「保留现有四档 wire 契约」）
    const fourWire = ["default", "acceptEdits", "plan", "bypassPermissions"];
    setSwitch("on");
    let onAllOk = true;
    for (const wm of fourWire) {
      const a = mgr.handleCommand(mkCmd(`p9-wire-on-${wm}`, { cwd: root, prompt: `on wire ${wm}`, permissionMode: wm, engine: "claude" }), "web-d") as CommandAckPayload;
      if (!(a.ok === true && "permission" in a && (a.permission as { effective: string }).effective.length > 0)) onAllOk = false;
    }
    assert(onAllOk, "on×四档 wire 全过且 ACK 带 permission.effective（「旧客户端×新 relay」零变+「新×新」全链）");
    setSwitch("off");
    let offAllOk = true;
    for (const wm of fourWire) {
      const a = mgr.handleCommand(mkCmd(`p9-wire-off-${wm}`, { cwd: root, prompt: `off wire ${wm}`, permissionMode: wm, engine: "claude" }), "web-d") as CommandAckPayload;
      if (!(a.ok === true && !("permission" in a))) offAllOk = false;
    }
    assert(offAllOk, "off×四档 wire 全过且 ACK 无 permission 键（四档 wire 契约保持+ACK 旧形态）");

    // 同输入两态分叉直证：codex×bypass——on 降 edit-auto/acceptEdits，off 直通 bypass
    setSwitch("on");
    const ackOnC = mgr.handleCommand(mkCmd("p9-fork-on", { cwd: root, prompt: "分叉 on", permissionMode: "bypassPermissions", engine: "codex" }), "web-d") as CommandAckPayload;
    const permOn = (ackOnC as unknown as { permission?: { effective: string; reason: string } }).permission;
    assert(ackOnC.ok === true && permOn?.effective === "edit-auto" && permOn.reason === "native_permission_not_confirmed", "on×codex×bypass：effective=edit-auto 降级可见（caller 可见不静默）");
    assert(lastSpawn()?.permissionMode === "acceptEdits", "on×codex×bypass：spawn 实参 acceptEdits（P81-5 传值收口在位）");
    setSwitch("off");
    const ackOffC = mgr.handleCommand(mkCmd("p9-fork-off", { cwd: root, prompt: "分叉 off", permissionMode: "bypassPermissions", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackOffC.ok === true && lastSpawn()?.permissionMode === "bypassPermissions", "off×codex×bypass：spawn 实参 bypassPermissions（同输入两态分叉=开关生效直证）");
    // 不静默升权（on 态铁面）：off 直通的是「P81 前既有语义」（显式输入优先），on 态
    // ceiling/降级面恒在——分叉对照即证：on 降/off 直通，off 未绕过 on 的任何新拒绝面
    //（on 态同输入仍降）。此处落锚防未来把开关改成「on/off 均跳闸」的退化。
    setSwitch("on");
    const ackGuard = mgr.handleCommand(mkCmd("p9-guard", { cwd: root, prompt: "on 态闸复验", permissionMode: "bypassPermissions", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackGuard.ok === true && lastSpawn()?.permissionMode === "acceptEdits", "on 态闸复验：仍降 acceptEdits（开关只由 env 翻转，off 直通非闸失效）");
  }

  // ---------- S3 resume 旧卡续跑两态 ----------
  console.log("S3 resume 两态");
  {
    // 造「伪装时代残留」卡：codex onInit 镜像 bypass（state 声称 bypass 而从未真实生效）
    // a. on 态：降档+审计（现行行为锁——p81-wiring S11 同构对照组）
    const ackA = mgr.handleCommand(mkCmd("p9-res-a", { cwd: root, prompt: "on 态旧值卡", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackA.ok === true && typeof ackA.session_id === "string", "前置：codex 旧值卡建成（on 态）");
    lastSpawn()?.cb?.onInit("sdk-p9a", "test-model", "bypassPermissions");
    if (lastSpawn()?.agent) lastSpawn().agent!.ended = true;
    setSwitch("on");
    const b4A = auditRows();
    mgr.handleCommand({ command_id: "p9-res-am", type: "COMMAND_MESSAGE", payload: { session_id: ackA.session_id!, text: "resume on" }, ts: Date.now() } as unknown as Command, "web-d");
    assert(lastSpawn()?.permissionMode === "acceptEdits" && lastSpawn()?.engine === "codex", "on×state bypass resume：spawn 实参 acceptEdits（P81-6 降档现行行为）");
    assert(auditRows() === b4A + 1, "on×降档：审计恰一行 legacy_state_normalized（事实源在位）");
    const stateOn = sessionsMap().get(ackA.session_id!)?.state.permission_mode;
    assert(stateOn === "acceptEdits", "on×降档：state 回写收敛 acceptEdits");

    // b. off 态：原值直读——不降档、不审计、不回写（§8.1 存量原样保留/resume 继续用该值）
    const ackB = mgr.handleCommand(mkCmd("p9-res-b", { cwd: root, prompt: "off 态旧值卡", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackB.ok === true && typeof ackB.session_id === "string", "前置：codex 旧值卡二建成（off 态造）");
    lastSpawn()?.cb?.onInit("sdk-p9b", "test-model", "bypassPermissions");
    if (lastSpawn()?.agent) lastSpawn().agent!.ended = true;
    setSwitch("off");
    const b4B = auditRows();
    mgr.handleCommand({ command_id: "p9-res-bm", type: "COMMAND_MESSAGE", payload: { session_id: ackB.session_id!, text: "resume off" }, ts: Date.now() } as unknown as Command, "web-d");
    assert(lastSpawn()?.permissionMode === "bypassPermissions" && lastSpawn()?.engine === "codex", "off×state bypass resume：spawn 实参原值 bypassPermissions（原样直读不降档）");
    assert(auditRows() === b4B, "off×resume：审计零新增（不落规范化审计）");
    assert(sessionsMap().get(ackB.session_id!)?.state.permission_mode === "bypassPermissions", "off×resume：state 原值未回写（存量 permission_mode 原样保留）");

    // c. off×缺字段卡：default（P81 前 `?? "default"` 既有惯例——非 P81 引入不属回退面）。
    // onInit 两参=写 sdkSessionId 而 pm 不镜像（第三参缺省=CLI 从未回报 permissionMode）
    const ackC2 = mgr.handleCommand(mkCmd("p9-res-c", { cwd: root, prompt: "off 缺字段卡", engine: "codex" }), "web-d") as CommandAckPayload;
    assert(ackC2.ok === true, "前置：codex 缺字段卡建成（onInit 不镜像 permissionMode）");
    lastSpawn()?.cb?.onInit("sdk-p9c", "test-model");
    if (lastSpawn()?.agent) lastSpawn().agent!.ended = true;
    mgr.handleCommand({ command_id: "p9-res-cm", type: "COMMAND_MESSAGE", payload: { session_id: ackC2.session_id!, text: "resume 缺字段" }, ts: Date.now() } as unknown as Command, "web-d");
    assert(lastSpawn()?.permissionMode === "default", "off×缺字段 resume：default（P81 前 ?? 惯例保留——上方早退分支本就是它）");
  }

  // ---------- S4 派单两态（dispatchWorker） ----------
  console.log("S4 派单两态");
  {
    const ackG = mgr.handleCommand(
      { command_id: "p9-g1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "P81-9 回退组", anchor_dir: root, tier: "轻立项" }, ts: Date.now() },
      "web-d",
    ) as { ok: boolean; data?: { group?: { id: string } } };
    const gid = ackG.data?.group?.id ?? "";
    assert(ackG.ok === true && gid !== "", "前置：轻立项组 fixture 建成");

    // on 对照面：未知岗位收紧拒（p81-wiring S10 同构——在位证明）
    setSwitch("on");
    const beforeOn = auditRows();
    const dOn = mgr.dispatchWorker({ anchor: root, prompt: "on 未知岗位", gid, role: "cto", engine: "codex" });
    assert(dOn.ok === false && "error" in dOn && dOn.error.includes("unknown_role_mapping"), "on×未知岗位：forbidden unknown_role_mapping（收紧面在位）");
    assert(auditRows() === beforeOn + 1, "on×未知岗位拒：审计一行（§6.3）");

    // off：未知岗位不拒+硬传 bypass（完整回 P81 前两处硬传点原样）
    setSwitch("off");
    const beforeOff = auditRows();
    const dOffX = mgr.dispatchWorker({ anchor: root, prompt: "off 未知岗位", gid, role: "cto", engine: "codex" });
    assert(dOffX.ok === true && lastSpawn()?.permissionMode === "bypassPermissions", "off×未知岗位：ok 直通硬传 bypass（恢复 P81 前行为）");
    // off：普通岗（worker）同参硬传——on 态 codex×worker×轻立项 tier_default 会降 acceptEdits
    const dOff = mgr.dispatchWorker({ anchor: root, prompt: "off 普通派单", gid, engine: "codex" });
    assert(dOff.ok === true && lastSpawn()?.permissionMode === "bypassPermissions", "off×worker 派单：spawn 实参硬传 bypassPermissions");
    assert(auditRows() === beforeOff, "off 态派单全程审计零新增");
    // on 对照：同组同岗 codex——P81-5 传值收口（unverified 降）
    setSwitch("on");
    const dOnW = mgr.dispatchWorker({ anchor: root, prompt: "on 普通派单对照", gid, engine: "codex" });
    assert(dOnW.ok === true && lastSpawn()?.permissionMode === "acceptEdits", "on×worker×codex×轻立项：spawn 实参 acceptEdits（P81-5 收口在位——两态分叉对照）");
    // on ACK 带 permission 回显；off ACK 无（dispatchWorker return 面 wire 形态）
    assert("permission" in dOnW, "on×派单 ACK 带 permission 键（「新×新」回显）");
    assert(!("permission" in dOff) && !("permission" in dOffX), "off×派单 ACK 无 permission 键（旧 relay wire 形态）");
  }

  // ---------- S5 SNAPSHOT 摘要停发（静态锚+同构造直测） ----------
  console.log("S5 摘要停发");
  {
    // 两出口 conditional spread 字面量锚（75-R S9 同口径：下发出口恰两处各一处）
    const relayRoot = fileURLToPath(new URL("..", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const wsSrc = readFileSync(join(relayRoot, "src", "ws-server.ts"), "utf-8");
    const ccSrc = readFileSync(join(relayRoot, "src", "cloud-client.ts"), "utf-8");
    const spreadMark = "permissionPolicyEnabled() ? { permission: permissionCapabilitiesSummary() } : {}";
    const wsHits = wsSrc.split(spreadMark).length - 1;
    const ccHits = ccSrc.split(spreadMark).length - 1;
    assert(wsHits === 1 && ccHits === 1, "两出口各恰一处 conditional spread（ws-server/cloud-client——停发键同源同步 #117 教训）");
    assert((wsSrc.match(/source_capabilities:/g) ?? []).length === 1 && (ccSrc.match(/source_capabilities:/g) ?? []).length === 1, "两出口 source_capabilities 挂载各恰一处（无旁路漏挂）");
    // spread 只围 permission 不围 engine_catalog（#75 线不受开关影响）——锚定挂载行形状
    const wsLine = wsSrc.split("\n").find((l) => l.includes("source_capabilities:")) ?? "";
    assert(wsLine.includes("engine_catalog: engineCatalogSummary(") && !wsLine.includes("...(permissionPolicyEnabled() ? { ... engine_catalog"), "engine_catalog 在 spread 外（#75 线不受开关影响）");
    // off 语义同构造直测（与两出口同构造）：off 时 permission 键缺席
    setSwitch("off");
    const scOff = { projection_v2: true, ...(permissionPolicyEnabled() ? { permission: permissionCapabilitiesSummary() } : {}) };
    assert(!("permission" in scOff) && scOff.projection_v2 === true, "off 同构造：permission 键缺席（端上 P81-8 双端 undefined 降级面据此自动隐藏）");
    setSwitch("on");
    const scOn = { projection_v2: true, ...(permissionPolicyEnabled() ? { permission: permissionCapabilitiesSummary() } : {}) };
    assert("permission" in scOn && Array.isArray(scOn.permission) && scOn.permission.length === 6, "on 同构造：permission 六条（现行 SNAPSHOT 摘要在位）");
    void repoRoot;
  }

  // ---------- S6 生产零触达 ----------
  console.log("S6 生产零触达");
  {
    assert(process.env.CCR_DATA_DIR === join(root, "data") && process.env.CCR_ORG_DIR === join(root, "org"), "env 全程指 tmp（data/org 两域均在 mkdtemp 下）");
    // 审计可从 tmp dataDir 读出多行=写入全程发生在 tmp（auditStore 是 StoragePort 非路径，
    // 读写同源即零 ~/.cc-deck 触达）
    assert(auditRows() > 0 && process.env.CCR_DATA_DIR!.startsWith(root), `审计落 tmp（dataDir=${process.env.CCR_DATA_DIR}，读回 ${auditRows()} 行——生产 ~/.cc-deck 零写入）`);
  }

  // ---------- S7 版本锚（bundle 合入+版本同步） ----------
  console.log("S7 版本锚");
  {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const pluginJson = JSON.parse(readFileSync(join(repoRoot, "cc-plugins", "plugins", "cc-deck", ".claude-plugin", "plugin.json"), "utf-8")) as { name: string; version: string };
    assert(pluginJson.version === "0.2.39", `plugin.json 版本=0.2.39（P81-9 bump 字面量锚，实测 ${pluginJson.version}）`);
    const mkt = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf-8")) as { plugins: { name: string; version: string }[] };
    const mktEntry = mkt.plugins.find((p) => p.name === pluginJson.name);
    assert(mktEntry?.version === pluginJson.version, `marketplace.json 回写同源（${mktEntry?.version} ≡ plugin.json ${pluginJson.version}）`);
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const plugSha = sha(join(repoRoot, "cc-plugins", "plugins", "cc-deck", "scripts", "relay.mjs"));
    const deskSha = sha(join(repoRoot, "desktop-tauri", "src-tauri", "resources", "relay.mjs"));
    assert(plugSha === deskSha, "bundle 双产物 SHA 相等（插件/scripts/relay.mjs ≡ desktop-tauri resources——三产物同源铁律 #018）");
    const bundle = readFileSync(join(repoRoot, "cc-plugins", "plugins", "cc-deck", "scripts", "relay.mjs"), "utf-8");
    assert(bundle.includes("CCR_PERMISSION_POLICY") && bundle.includes("p81-kill-switch"), "bundle 含 kill-switch 特征串（P81-9 改动已合入产物）");
    console.log(`  bundle relay.mjs SHA-256: ${plugSha.slice(0, 16)}…（全量见回单）`);
  }

  console.log(`\np9-killswitch: ${pass} passed, ${fail} failed`);
} finally {
  if (savedSwitch === undefined) delete process.env.CCR_PERMISSION_POLICY;
  else process.env.CCR_PERMISSION_POLICY = savedSwitch;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* tmp 清理失败不掩红 */
  }
}
if (fail > 0) process.exit(1);
