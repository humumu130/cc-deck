// #75-R 引擎目录协议测试件（relay 半）：catalog 投影契约 + COMMAND_CREATE 选择上下文/降级面
// 规格锚：PM-75 提案 §4.3（JSON 形状契约，与 75-W web 半两端对齐——H 侧测试件
// scripts/test-75w-eng-selector.ts 按 Array 消费+词表字面锚定，本件是源头侧镜像锁）
//
// 矩阵（九段）：
//   S1  形状与六枚举全覆盖（id 集/七键/词表值域/无重复）
//   S2  claude confirmed：ready+preflight pass+capabilities 全 true+models 与
//       listModels 同参同源（不冒充红线 claude 侧）
//   S3  codex 可控缝：CCR_CODEX_PATH 钉 /bin/echo→ready、钉不存在路径→unavailable
//      +fail reason 非空（确定性两态；本机装没装 codex 不影响判定）+catalogReadyEngines 联动
//   S4  registry 三注册（trae/qwen-code/codebuddy）：形态断言（ready|unavailable 不锁死
//       本机装没装；fail 时 reason 非空；models 恒 []）
//   S5  zcode unsupported：灰显数据精确断言（提案 §6.1「可盘点不可选」）
//   S6  default_for_roles 反查：fixture 组 role_defaults → 引擎角色集（跨组去重保序）
//   S7  COMMAND_CREATE 六场景：旧行为零感知/预置不可用降级（ACK 无 engine+degraded
//       显式）/CCR_CODEX_PATH 造 ready 预置生效（ACK.engine+SESSION_CREATED.engine 一致）/
//       显式优先零改动/非法 selection_source 拒/合法值透传
//   S8  JSON round-trip 无损+条目键集恰七（旧客户端未知字段忽略零感知）
//   S9  三出口同源静态锚（ws-server/cloud-client 两处同参 engineCatalogSummary；
//       src 全目录 engine_catalog 命中文件集恰五——CANAL 无第三出口）
//
// fixture：mkdtemp org（projects.json 两组带 role_defaults）+CCR_ORG_DIR 注入
//+READ_MODE 显式钉 json（fixture 是 json 形态；SQLITE-FLIP 后缺省=sqlite 会读空库）。
// 全程零生产触达（env 五清由跑法命令保证，测试件内部再保存/恢复自己碰的键）。
//
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-75r-engine-catalog.ts
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogReadyEngines, engineCatalogSummary } from "../src/engine-catalog.js";
import { listModels } from "../src/models.js";
import { setLightConfirmTrusted } from "../src/projects.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command, CommandAckPayload, EngineCatalogEntry, Envelope, SessionEngine } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) {
  console.log(`${name}`);
}

const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIX: readonly SessionEngine[] = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"];
const STATES = ["ready", "unavailable", "unsupported", "unknown"];
const PF_STATES = ["pass", "fail", "unknown"];
const byId = (cat: EngineCatalogEntry[], id: SessionEngine): EngineCatalogEntry => cat.find((e) => e.id === id)!;

try {
  // ---------- fixture（org 两组带 role_defaults；env 注入零生产触达） ----------
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-75r-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-75r-"));
  const now = Date.now();
  const group = (id: string, name: string, role_defaults: Record<string, { engine: SessionEngine }>) => ({
    id, name, anchor_dir: mkdtempSync(join(tmpdir(), "ccr-anchor-75r-")), status: "active" as const,
    tier: "随手办" as const, headcount: [], role_defaults, single_card: false, created_at: now, updated_at: now,
  });
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({
    groups: [
      group("G-75r-1", "75R目录甲组", {
        worker: { engine: "trae" }, reviewer: { engine: "trae" },
        release: { engine: "codex" }, gray: { engine: "zcode" },
      }),
      group("G-75r-2", "75R目录乙组", { worker: { engine: "trae" } }),
    ],
    trust_light: true,
  }, null, 2) + "\n", "utf-8");

  const prevOrg = process.env.CCR_ORG_DIR;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  const prevCodexPath = process.env.CCR_CODEX_PATH;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json"; // fixture 是 json 形态（READ_MODE 语义见 SQLITE-FLIP：缺省已翻 sqlite，显式钉 json 读此 fixture）
  try {
    // ---------- S1 形状与六枚举全覆盖 ----------
    section("S1 形状与六枚举全覆盖");
    const cat = engineCatalogSummary("test-model");
    assert(Array.isArray(cat) && cat.length === 6, "S1① catalog 是数组且恰六条（§4.3 契约 Array 形状）");
    assert(JSON.stringify(cat.map((e) => e.id)) === JSON.stringify(SIX), "S1② id 集合与顺序恰六枚举（无多余无缺位）");
    assert(new Set(cat.map((e) => e.id)).size === 6, "S1③ id 无重复");
    const shapeOk = cat.every((e) =>
      typeof e.id === "string" && typeof e.label === "string" && e.label.length > 0
      && STATES.includes(e.state)
      && typeof e.capabilities === "object" && typeof e.capabilities.resume === "boolean"
      && typeof e.capabilities.approval === "boolean" && typeof e.capabilities.artifacts === "boolean"
      && typeof e.preflight === "object" && PF_STATES.includes(e.preflight.state)
      && typeof e.preflight.reason === "string"
      && Array.isArray(e.models) && Array.isArray(e.default_for_roles),
    );
    assert(shapeOk, "S1④ 逐条目七字段形状全对（state/preflight 词表值域+capabilities 三布尔+两数组）");
    const keysOk = cat.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(["capabilities", "default_for_roles", "id", "label", "models", "preflight", "state"]));
    assert(keysOk, "S1⑤ 条目键集恰七（无多余键——75-W 消费端按形状锚定，漂移即两端炸）");

    // ---------- S2 claude confirmed ----------
    section("S2 claude confirmed（自证可用+models 同源）");
    const cl = byId(cat, "claude");
    assert(cl.state === "ready" && cl.preflight.state === "pass" && cl.preflight.reason === "", "S2① claude state=ready+preflight pass（relay 进程即 claude SDK 自证）");
    assert(cl.capabilities.resume === true && cl.capabilities.approval === true && cl.capabilities.artifacts === true, "S2② claude capabilities 全 true（resume 锚/审批挂起/artifacts 实况）");
    assert(JSON.stringify(cl.models) === JSON.stringify(listModels("test-model")), "S2③ claude models 与 listModels 同参同源（SNAPSHOT.models 不冒充红线 claude 侧）");

    // ---------- S3 codex 可控缝 ----------
    section("S3 codex 可控缝（CCR_CODEX_PATH 钉两态）");
    const cxNative = byId(cat, "codex");
    assert(cxNative.state === "ready" || cxNative.state === "unavailable", "S3① codex 本机形态两态之一（不锁死装没装）");
    if (cxNative.state === "unavailable") {
      assert(cxNative.preflight.state === "fail" && cxNative.preflight.reason.length > 0, "S3② unavailable 时 preflight=fail+reason 非空（端上灰显有据）");
    }
    assert(cxNative.capabilities.resume === true && cxNative.capabilities.approval === false && cxNative.capabilities.artifacts === false, "S3③ codex capabilities {true,false,false}（thread_id 锚 resume 真；approval/artifacts 静态投影）");
    assert(cxNative.models.length === 0, "S3④ codex models 恒空（无源级清单——端上显示「使用引擎默认」，不冒充）");
    process.env.CCR_CODEX_PATH = "/bin/echo"; // 可控缝：绝对路径 accessSync X_OK 必过 → ready
    assert(byId(engineCatalogSummary(), "codex").state === "ready", "S3⑤ CCR_CODEX_PATH=/bin/echo → codex ready（探测缝确定性）");
    assert(catalogReadyEngines().has("codex"), "S3⑥ catalogReadyEngines 联动收 codex（降级判定数据源同源）");
    process.env.CCR_CODEX_PATH = "/nonexistent-75r-nope/bin/codex";
    const cxMissing = byId(engineCatalogSummary(), "codex");
    assert(cxMissing.state === "unavailable" && cxMissing.preflight.state === "fail" && cxMissing.preflight.reason.length > 0, "S3⑦ 不存在路径 → unavailable+fail+reason 非空（确定性 fail 造法）");
    assert(!catalogReadyEngines().has("codex"), "S3⑧ catalogReadyEngines 联动剔 codex");
    delete process.env.CCR_CODEX_PATH;

    // ---------- S4 registry 三注册形态 ----------
    section("S4 registry 三注册（trae/qwen-code/codebuddy 形态断言）");
    for (const id of ["trae", "qwen-code", "codebuddy"] as const) {
      const e = byId(cat, id);
      const twoState = e.state === "ready" || e.state === "unavailable";
      const failHasReason = e.state !== "unavailable" || (e.preflight.state === "fail" && e.preflight.reason.length > 0);
      assert(twoState && failHasReason && e.models.length === 0
        && typeof e.capabilities.resume === "boolean" && typeof e.capabilities.approval === "boolean" && typeof e.capabilities.artifacts === "boolean",
        `S4 ${id}：ready|unavailable 形态+fail 带 reason+models 空+capabilities 三布尔（registry 实况投影）`);
    }

    // ---------- S5 zcode unsupported ----------
    section("S5 zcode unsupported（可盘点不可选）");
    const zc = byId(cat, "zcode");
    assert(zc.state === "unsupported" && zc.label === "ZCode", "S5① zcode state=unsupported（提案 §6.1 灰显态）");
    assert(zc.capabilities.resume === false && zc.capabilities.approval === false && zc.capabilities.artifacts === false, "S5② capabilities 全 false");
    assert(zc.preflight.state === "unknown" && zc.preflight.reason === "枚举占位未接入编排（不可选）", "S5③ preflight unknown+固定灰显原因（75-W 词表字面锚对齐）");
    assert(zc.models.length === 0, "S5④ models 空");

    // ---------- S6 default_for_roles 反查 ----------
    section("S6 default_for_roles 反查（org role_defaults → 引擎角色集）");
    assert(JSON.stringify(byId(cat, "trae").default_for_roles) === JSON.stringify(["worker", "reviewer"]), "S6① trae=[worker,reviewer]（甲组两角色保序）");
    assert(JSON.stringify(byId(cat, "codex").default_for_roles) === JSON.stringify(["release"]), "S6② codex=[release]");
    assert(JSON.stringify(byId(cat, "zcode").default_for_roles) === JSON.stringify(["gray"]), "S6③ zcode=[gray]（unsupported 也可被反查到——盘点如实）");
    assert(byId(cat, "claude").default_for_roles.length === 0 && byId(cat, "qwen-code").default_for_roles.length === 0 && byId(cat, "codebuddy").default_for_roles.length === 0, "S6④ 无预置引擎角色集空");
    assert(JSON.stringify(byId(engineCatalogSummary("test-model"), "trae").default_for_roles) === JSON.stringify(["worker", "reviewer"]), "S6⑤ 乙组 worker→trae 跨组去重不增项（仍 [worker,reviewer] 保序）");

    // ---------- S7 COMMAND_CREATE 六场景 ----------
    section("S7 COMMAND_CREATE 选择上下文与降级面");
    const created: { prompt: string | undefined; cb: AgentCallbacks }[] = [];
    const makeFakeFactory = () =>
      (_cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined, _opts?: unknown): AgentLike => {
        created.push({ prompt, cb });
        const a: AgentLike = {
          id: randomUUID(), startedAt: Date.now(), ended: false,
          sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
          stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
        };
        return a;
      };
    const events: Envelope[] = [];
    const bus = new EventBus();
    bus.subscribe((env) => events.push(env));
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: mkdtempSync(join(tmpdir(), "ccr-data-75r-")),
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    setLightConfirmTrusted(true); // create 即 active（C12 既有范式，orchestration 先例）
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    let seq = 0;
    const send = (payload: Record<string, unknown>) =>
      mgr.handleCommand({ command_id: `75r-${++seq}`, type: "COMMAND_CREATE", payload, ts: Date.now() } as unknown as Command, "web-75r") as CommandAckPayload;
    const createdEmit = (ack: CommandAckPayload): Record<string, unknown> | undefined => {
      const sid = (ack as { session_id?: string }).session_id;
      if (!sid) return undefined;
      const hit = [...events].reverse().find((ev) => ev.type === "SESSION_CREATED" && ev.session_id === sid);
      return hit ? (hit.payload as Record<string, unknown>) : undefined;
    };

    // a. 旧行为零感知：显式 engine 零上下文
    const ackA = send({ cwd: CWD, prompt: "75R 旧行为", engine: "claude" });
    assert(ackA.ok === true && ackA.engine === "claude" && ackA.degraded === undefined, "S7a 显式 claude 零上下文：ok+engine 回显+无降级（#75 回显键旧客户端零感知）");

    // b. 预置不可用降级：zcode 预置（unsupported 恒非 ready——确定性，不赌本机 CLI）
    const ackB = send({ cwd: CWD, prompt: "75R 降级", selection_source: "role_default", gid: "G-75r-1", role: "gray" });
    assert(ackB.ok === true && ackB.engine === undefined && ackB.degraded === true && (ackB.degraded_reason ?? "").includes("zcode"), "S7b zcode 预置不可用：回退缺省（ACK 无 engine）+degraded=true+reason 定位引擎（§6.1 不静默换引擎）");
    const emitB = createdEmit(ackB);
    assert(emitB !== undefined && emitB.engine === undefined && emitB.degraded === true, "S7b' SESSION_CREATED 同步降级标记：engine 缺省（claude 旧语义）+degraded 显式");

    // c. ready 预置生效：CCR_CODEX_PATH=/bin/echo 造 codex ready → 预置 codex 直接生效
    process.env.CCR_CODEX_PATH = "/bin/echo";
    const ackC = send({ cwd: CWD, prompt: "75R 预置生效", selection_source: "role_default", gid: "G-75r-1", role: "release" });
    assert(ackC.ok === true && ackC.engine === "codex" && ackC.degraded === undefined, "S7c codex 预置 ready：role_default 生效 ACK.engine=codex 无降级（三层求值序中层）");
    const emitC = createdEmit(ackC);
    assert(emitC !== undefined && emitC.engine === "codex" && emitC.degraded === undefined, "S7c' SESSION_CREATED.engine=codex 与 ACK 一致（一致性全锁）");

    // d. 显式优先零改动：显式 claude + codex ready 预置在场 → claude 赢且无降级
    const ackD = send({ cwd: CWD, prompt: "75R 显式优先", engine: "claude", selection_source: "role_default", gid: "G-75r-1", role: "release" });
    assert(ackD.ok === true && ackD.engine === "claude" && ackD.degraded === undefined, "S7d 显式 engine 压过 gid/role 预置：claude 生效+不触发降级（显式输入优先既有语义零改动）");

    // e. 非法 selection_source 拒
    const ackE = send({ cwd: CWD, prompt: "75R 非法来源", selection_source: "bogus" });
    assert(ackE.ok === false && (ackE.error ?? "").includes("无效 selection_source"), "S7e 非法 selection_source 拒（词表 role_default/manual/relay_default 闸）");

    // f. 合法值透传零效应：manual 不触发预置求值
    const ackF = send({ cwd: CWD, prompt: "75R manual 透传", engine: "claude", selection_source: "manual" });
    assert(ackF.ok === true && ackF.engine === "claude" && ackF.degraded === undefined, "S7f 合法 selection_source 透传：manual 零效应照常建卡");
    delete process.env.CCR_CODEX_PATH;

    // ---------- S8 JSON round-trip（旧客户端零感知） ----------
    section("S8 JSON round-trip 与旧客户端零感知");
    const rt = JSON.parse(JSON.stringify(engineCatalogSummary("test-model"))) as EngineCatalogEntry[];
    assert(JSON.stringify(rt) === JSON.stringify(cat), "S8① JSON round-trip 无损（无 bigint/undefined 非法值——WS/云通道 JSON 序列化安全）");
    const sc = JSON.stringify({ projection_v2: true, engine_catalog: cat });
    assert(sc.includes("\"engine_catalog\":[") && sc.includes("\"state\":\"unsupported\""), "S8② source_capabilities 旁挂序列化形状（旧端不读 engine_catalog 键零影响——未知字段忽略）");

    // ---------- S9 三出口同源静态锚 ----------
    section("S9 三出口同源静态锚（#117 教训）");
    const wsSrc = readFileSync(join(RELAY_ROOT, "src", "ws-server.ts"), "utf-8");
    const cloudSrc = readFileSync(join(RELAY_ROOT, "src", "cloud-client.ts"), "utf-8");
    assert(wsSrc.includes("engine_catalog: engineCatalogSummary(mgr.cfg.model)"), "S9① ws-server 出口：engineCatalogSummary(mgr.cfg.model)（与 SNAPSHOT.models 同参）");
    assert(cloudSrc.includes("engine_catalog: engineCatalogSummary(this.mgr.cfg.model)"), "S9② cloud-client 出口：同参 this.mgr.cfg.model（两出口同源）");
    const srcDir = join(RELAY_ROOT, "src");
    const hit = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && readFileSync(join(srcDir, f), "utf-8").includes("engine_catalog")).sort();
    // session-manager 不在集内：它是 catalogReadyEngines（降级判定）消费面，不持
    // engine_catalog 字面量——下发出口恰两处（ws-server/cloud-client），出第三处即漏改同源锚
    assert(JSON.stringify(hit) === JSON.stringify(["cloud-client.ts", "engine-catalog.ts", "types.ts", "ws-server.ts"]), "S9③ src 全目录 engine_catalog 命中文件集恰四（下发出口恰两处+定义件两件——CANAL 无第三出口）");
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
    else process.env.CCR_ORG_DIR = prevOrg;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE;
    else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    if (prevCodexPath === undefined) delete process.env.CCR_CODEX_PATH;
    else process.env.CCR_CODEX_PATH = prevCodexPath;
    rmSync(ORG, { recursive: true, force: true });
  }
} catch (e) {
  fail++;
  console.error(`  ✗ 测试件异常终止: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
