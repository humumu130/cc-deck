// W-RULES2 —— 团队规则库广播面全链测试：RULES_UPDATED 瞬态 delta 帧（rule-append direct /
// rule-retire / rule-supersede / exp-promote / 确认卡 ✓ 落库后广播；提案出卡不广播）+
// orgCommand WS rule-* 面板通道直通（P1 只有 HTTP 面，P2 补 WS）+ 瞬态语义（不落 ndjson）。
// 隔离口径：CCR_ORG_DIR/CCR_CONFIG_FILE/CCR_STORAGE_READ_MODE 三钉（test-experience-broadcast
// 同缝），绝不触生产 ~/.cc-deck。SNAPSHOT.rules 的 ws-server 组装面由 CDP 双壳断言真链覆盖
//（/tmp/wrules2/cdp-rules-test.mjs），本套件专注 manager 层。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExperience, listExperience,
  type ExperienceEntry,
} from "../src/experience.js";
import {
  appendRule, retireRule, listRules,
  type RuleEntry,
} from "../src/team-rules.js";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import { pluginConfigPath } from "../src/plugin-config.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mustOk = (r: { ok: boolean; entry?: RuleEntry; error?: string; duplicate_of?: string }): RuleEntry => {
  if (!r.ok || !r.entry) throw new Error(`测试前置失败: ${"error" in r ? r.error : "not ok"}`);
  return r.entry;
};
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-rulebc-${tag}-`));

// 环境保存/恢复（进程级 env 是全局面，测试尾部统一还原）
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];
process.env.CCR_STORAGE_READ_MODE = "json";

interface RuleFrame { type: string; seq: number; payload: { entries?: RuleEntry[]; entity_refs?: string[]; delta?: { upserts: RuleEntry[]; removes: string[] } } }

/** manager + 帧捕获标准装（每 section 独立 data/org 目录） */
function mkManager(tag: string) {
  const DATA = mkDir(`${tag}-data`);
  const ORG = mkDir(`${tag}-org`);
  const CFG = mkDir(`${tag}-cfg`);
  dirs.push(DATA, ORG, CFG);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n"); // 缺省全开（test-experience-broadcast 同款）
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const frames: RuleFrame[] = [];
  bus.subscribe((env) => frames.push({ type: env.type as string, seq: env.seq, payload: env.payload as RuleFrame["payload"] }));
  const mgr = new SessionManager(bus, cfg);
  const ruleFrames = (from = 0): RuleFrame[] => frames.slice(from).filter((f) => f.type === "RULES_UPDATED");
  return { DATA, ORG, mgr, frames, ruleFrames };
}

// ---------- S1 direct append 广播：首帧全量无 delta，次帧带 delta ----------
section("\nS1 rule-append direct 广播（首帧锚定/次帧 delta）");
{
  const { ORG, mgr, ruleFrames } = mkManager("s1");
  const r1 = mgr.orgAction("rule-append", { text: "全员红线第一条", audience: "all", scope: "team", direct: true, created_by: "user" });
  assert(r1.ok === true, "direct rule-append ok");
  const f1 = ruleFrames()[0];
  assert(!!f1, "落库即广播 RULES_UPDATED");
  assert(Array.isArray(f1?.payload.entries) && f1!.payload.entries!.length === 1, "首帧 entries 全量（重启后锚定帧语义）");
  assert(f1?.payload.delta === undefined, "首帧无 delta（无基线→覆盖式）");
  const r2 = mgr.orgAction("rule-append", { text: "全员红线第二条", audience: "all", scope: "team", direct: true, created_by: "user" });
  assert(r2.ok === true, "第二条 direct ok");
  const f2 = ruleFrames()[1];
  assert(f2?.payload.delta !== undefined && f2.payload.delta!.upserts.length === 1, "次帧 delta 带 1 upsert");
  assert(f2?.payload.entity_refs?.length === 1, "entity_refs 与 delta 同进出");
  // 写失败不广播
  const from = ruleFrames().length;
  mgr.orgAction("rule-append", { text: "", direct: true });
  assert(ruleFrames().length === from, "拒收（空 text）不广播");
}

// ---------- S2 retire/supersede/promote 广播 ----------
section("\nS2 rule-retire / rule-supersede / exp-promote 广播");
{
  const { ORG, mgr, ruleFrames } = mkManager("s2");
  const a = mustOk(appendRule({ text: "待退役红线", audience: "all", scope: "team", created_by: "user" }, ORG));
  const fromRetire = ruleFrames().length;
  mgr.orgAction("rule-retire", { id: a.id });
  assert(ruleFrames().length === fromRetire + 1, "rule-retire 成功广播");
  assert(listRules({ status: "retired" }, ORG).some((x) => x.id === a.id), "retire 落库");
  const b = mustOk(appendRule({ text: "待替代红线", audience: "all", scope: "team", created_by: "user" }, ORG));
  const fromSup = ruleFrames().length;
  const sup = mgr.orgAction("rule-supersede", { id: b.id, text: "替代后红线", created_by: "user" });
  assert(sup.ok === true, "rule-supersede ok");
  const fSup = ruleFrames()[fromSup];
  assert(!!fSup, "supersede 广播一次（两变一帧）");
  assert(fSup?.payload.entries?.length === 3, "帧 entries 含新旧共 3 条（全量）");
  assert(listRules({}, ORG).find((x) => x.id === b.id)?.superseded_by !== undefined, "旧条指新（superseded_by 落库）");
  // exp-promote：经验条复制为规则条
  const exp = (() => {
    try {
      return appendExperience({ text: "高频踩坑升格为红线", kind: "pitfall", source: { actor: "user", session_id: "t" } }, ORG);
    } catch {
      return { ok: false as const };
    }
  })();
  if (exp.ok && "entry" in exp && exp.entry) {
    const fromPromote = ruleFrames().length;
    const pr = mgr.orgAction("exp-promote", { id: (exp.entry as ExperienceEntry).id, created_by: "user" });
    assert(pr.ok === true, "exp-promote ok");
    assert(ruleFrames().length === fromPromote + 1, "exp-promote 成功广播");
  } else {
    console.log("  （跳过 exp-promote：经验 append 前置不可用）");
  }
}

// ---------- S3 提案出卡不广播；确认卡 ✓ 落库广播 ----------
section("\nS3 确认卡 rule-append 链路（提案零写入/✓ 落库广播）");
{
  const { DATA, ORG, mgr, ruleFrames } = mkManager("s3");
  const from = ruleFrames().length;
  const prop = mgr.orgAction("rule-append", { text: "agent 提案红线", audience: "all", scope: "team", created_by: "agent" });
  assert(prop.ok === true, "提案（无 direct）受理 ok");
  const confirmId = (prop.ok ? (prop.data as { confirm_id?: string } | undefined) : undefined)?.confirm_id;
  assert(typeof confirmId === "string" && confirmId.length > 0, "提案返回 confirm_id");
  assert(ruleFrames().length === from, "提案出卡不广播（零写入）");
  assert(listRules({}, ORG).length === 0, "提案零落库（无半态）");
  // 用户 ✓：COMMAND_ORG_CONFIRM → applyConfirmEffects → 入库 + 广播 + confirm_id 回链
  const ack = mgr.handleCommand({ command_id: "c1", type: "COMMAND_ORG_CONFIRM", payload: { confirm_id: confirmId, approve: true } } as never, "web-1");
  assert(ack.ok === true, "确认卡 ✓ 受理");
  const stored = listRules({}, ORG);
  assert(stored.length === 1 && stored[0]!.text === "agent 提案红线", "✓ 后落库（文本一致）");
  assert(stored[0]!.confirm_id === confirmId, "confirm_id 回链入库条目");
  assert(stored[0]!.created_by === "agent", "created_by=agent（卡载发起方）");
  const f = ruleFrames().slice(-1)[0];
  assert(ruleFrames().length > from && f?.payload.entries?.length === 1, "✓ 落库后广播 RULES_UPDATED");
  // 瞬态语义：RULES_UPDATED 不落 events.ndjson
  const ndjson = existsSync(join(DATA, "events.ndjson")) ? readFileSync(join(DATA, "events.ndjson"), "utf-8") : "";
  assert(!ndjson.includes("RULES_UPDATED"), "瞬态帧不落 events.ndjson（重连不补发，SNAPSHOT 兜底）");
}

// ---------- S4 orgCommand WS rule-* 直通（P2 补齐面） ----------
section("\nS4 orgCommand WS rule-* 直通");
{
  const { ORG, mgr, ruleFrames } = mkManager("s4");
  const a = mustOk(appendRule({ text: "WS 直通退役目标", audience: "all", scope: "team", created_by: "user" }, ORG));
  const ack = mgr.handleCommand({ command_id: "c1", type: "COMMAND_ORG_ACTION", payload: { action: "rule-retire", id: a.id } } as never, "web-1");
  assert(ack.ok === true, "COMMAND_ORG_ACTION rule-retire 直通 ok（P1 缺口补齐）");
  assert(listRules({}, ORG).find((x) => x.id === a.id)?.status === "retired", "直通执行生效（retired 落库）");
  assert(ruleFrames().length > 0, "直通路径同样广播（漏斗内单点 emit）");
  // WS direct append（面板新增同链）
  const ack2 = mgr.handleCommand({ command_id: "c2", type: "COMMAND_ORG_ACTION", payload: { action: "rule-append", text: "面板直写红线", audience: "all", scope: "team", direct: true, created_by: "user" } } as never, "web-1");
  assert(ack2.ok === true, "COMMAND_ORG_ACTION rule-append direct ok");
  assert(listRules({ status: "active" }, ORG).some((x) => x.text === "面板直写红线"), "面板直写落库");
  // 未知 rule-* 拒收
  const ack3 = mgr.handleCommand({ command_id: "c3", type: "COMMAND_ORG_ACTION", payload: { action: "rule-frobnicate" } } as never, "web-1");
  assert(ack3.ok === false, "未知 rule-* 动作拒收（不静默）");
}

// ---------- S5 总开关关：注入停但面板读写不受限（拍板口径：用户 CLI/面板直写不拦） ----------
section("\nS5 rules 总开关关：广播照发（面板可视即库真值）");
{
  const { ORG, mgr, ruleFrames } = mkManager("s5");
  writeFileSync(pluginConfigPath(), JSON.stringify({ rules: false }) + "\n");
  const from = ruleFrames().length;
  const r = mgr.orgAction("rule-append", { text: "开关关仍可管", audience: "all", scope: "team", direct: true, created_by: "user" });
  assert(r.ok === true, "总开关关不拦面板/CLI 直写（显式人为意图）");
  assert(ruleFrames().length === from + 1, "写动作广播照发（库真值可视）");
}

// ---------- 收尾 ----------
process.env.CCR_ORG_DIR = savedEnv.CCR_ORG_DIR;
process.env.CCR_CONFIG_FILE = savedEnv.CCR_CONFIG_FILE;
process.env.CCR_STORAGE_READ_MODE = savedEnv.CCR_STORAGE_READ_MODE;
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理尽力 */ } }
console.log(`\nrules-broadcast: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
