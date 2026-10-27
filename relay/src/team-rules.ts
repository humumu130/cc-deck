// W-RULES1（2026-10-11）团队规则库 P1 —— org/rules.json 结构化 store + 注入纯函数 + 升格复制。
// 设计：~/.cc-deck/artifacts/design-team-project-rules-A.md（§10 交叉讨论修订版）+
// design-rules-knowledge-spectrum.md（C 路）+ 拍板表 verdict-rules-20261011.md（10 项全按）。
//
// 定位（谱系）：规则库 = 用户审定的团队/项目红线（约束/铁律），与经验库（软参考）分库分治
// ——写入信任面不同（规则永不自动收，agent 文本必须经确认卡；经验格式门自动收）、生命周期
// 不同（规则零 GC，retire/supersede 只走显式动作；经验 GC 梯度）、注入语义不同（规则写侧
// 硬闸+每单重注无 memo；经验读侧预算竞争+session memo）。schema 是拍板表 #1-#6 的直接落地：
// audience 三档（all/leader/role:xxx，role 词表对齐 P81 bizRole，写入 fail-closed）、
// scope 双值（team | project:<anchor>，全局层维持用户 CLAUDE.md 不另立第三存储——拍板 #2）、
// status 三态（active/retired/superseded + superseded_by 替代链——拍板 #6）、升格=复制非
// 搬移（promoted_from 正向溯源，源经验条目不 retire 照常 GC——拍板 #5）。
//
// ⚠ 并发安全前提（experience.ts 同款，REL 建-6）：全部写路径走同步 read-modify-write，
// 禁止 async 化。存储硬约束照抄经验库两条（REL 必-1）：① save 一律 tmp+rename 原子写；
// ② load 遇坏 JSON 改名 rules.json.corrupt-<ts> 留证 + 拒绝一切写操作（readdir 前缀扫描
// 持久拒绝态）。实现批复制模式不抽公共基类（一次一批纪律，C 路 §7.2；两库跑稳一版后再议）。
//
// 数值纪律（拍板 #4，C 路 §5.3 数值，「真实团队的铁律就是个位数」）：
//   单条 ≤120 字 / 团队 active ≤6 / 单项目 ≤4 / 单角色 ≤4 / 注入预算 600 字符——
//   超限拒收报清晰错误（写侧 fail-closed，绝不裁剪注入）。另加一条同源闸：团队×全员桶
//   （每个派单必命中的最坏情况）格式化总量 ≤ 注入预算，超限拒新——「团队规则注入零截断」
//   是单测可锁定的硬性质（C 路 §5.3 必达性口径）；窄域桶（项目/角色）写入时刻无法预知
//   未来派单的 role×project 组合，读侧按 created_at 序装填、装不下截除 + warn（尽力达）。
//
// 总开关 = plugin-config 第八键 rules（缺省 true，#107 决策反转先例）：关 = 注入停零残留；
// 用户 CLI 直写不拦（显式人为意图，experience 键同款口径）。
//
// 安全面（拍板 #7）：text 入注入前过 sanitizeExperienceText（去结构化防 prompt injection，
// 从 experience.ts 只 import 此函数——红线约定）；入库 text 即存 sanitize 后形态（注入侧
// 不再二次变形，长度闸量的是真实注入成本）。agent 文本永不直入权威通道：orgAction
// rule-append 缺省走确认卡（OrgConfirm kind=rule-append，用户 ✓ 才入库），CLI 直写显式
// 带 direct 标记（用户主权面）。本模块不含审批流——审批在 session-manager 漏斗 +
// projects.ts OrgConfirm，store 层只认已批准的写入。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { orgDir } from "./org.js";
import { listGroups } from "./projects.js";
import { readPluginConfig } from "./plugin-config.js";
import { sanitizeExperienceText } from "./experience.js";
import { BIZ_ROLE_VOCAB } from "./role-templates.js";

// ---------- 类型（schema 按拍板表 #1-#6） ----------

export type RuleStatus = "active" | "retired" | "superseded";

export interface RuleEntry {
  /** rule- 前缀 + 8 位（经验 exp- 同族命名） */
  id: string;
  /** ≤120 字祈使句；入库即 sanitize 形态（单行、无类系统段样式） */
  text: string;
  /** 三档：all | leader | role:<P81 词表>（词表外写入即拒，fail-closed——拍板 #3） */
  audience: string;
  /** 双值：team | project:<锚点目录绝对路径（尾斜杠归一）>——拍板 #2 */
  scope: string;
  status: RuleStatus;
  /** 替代链（拍板 #6）：被哪条新规则替代（替代=新条入库+旧条停注+指新） */
  superseded_by?: string;
  /** 升格溯源（拍板 #5）：由哪条经验复制而来（源条目照常 GC，不回链控制） */
  promoted_from?: string;
  /** 写入发起方：user（用户 CLI 直写）| agent（提案经确认卡 ✓ 入库时卡载发起方） */
  created_by: "user" | "agent";
  /** 确认卡回链（走卡入库时必有） */
  confirm_id?: string;
  created_at: number;
  updated_at: number;
}

interface RuleStore {
  version: 1;
  rules: RuleEntry[];
}

// ---------- 调参（env 可覆盖，沙盒测试调低即可触发全链——experience.ts envNum 同款手法） ----------

function envNum(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** 团队 scope active 上限（拍板 #4：≤6） */
export function ruleMaxTeam(): number { return envNum("CCR_RULE_MAX_TEAM", 6); }
/** 单项目（同锚点）active 上限（拍板 #4：≤4） */
export function ruleMaxProject(): number { return envNum("CCR_RULE_MAX_PROJECT", 4); }
/** 单角色（同 audience=role:x 值）active 上限（拍板 #4：≤4） */
export function ruleMaxRole(): number { return envNum("CCR_RULE_MAX_ROLE", 4); }
/** 单条正文上限（拍板 #4：≤120 字） */
export function ruleMaxText(): number { return envNum("CCR_RULE_MAX_TEXT", 120); }
/** 注入字符预算（拍板 #4：600 字符，env 可调；经验块 700 同量级） */
export function rulesInjectBudget(): number { return envNum("CCR_RULES_INJECT_BUDGET", 600, 50); }

/** 归一键保留字符数（与经验库 EXP_NORM_KEY_CHARS 同值；实现独立，见 normRuleKey 注释） */
const RULE_NORM_KEY_CHARS = 64;

// ---------- 路径与原子写 + 坏 JSON 拒写（REL 必-1 两条，experience.ts 同款） ----------

export function rulesPath(dir?: string): string {
  return join(dir ?? orgDir(), "rules.json");
}

/** tmp+rename 原子写（history.ts rewriteFile 先例）。调用方 catch 落 warn。 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/** 坏 JSON 留证文件扫描（持久拒绝态依据：文件在=拒绝写，删证=人工确认过才恢复） */
function findCorruptMarker(dir?: string): string | null {
  try {
    const d = dir ?? orgDir();
    const hit = readdirSync(d).find((f) => f.startsWith("rules.json.corrupt-"));
    return hit ? join(d, hit) : null;
  } catch {
    return null;
  }
}

interface LoadedStore {
  store: RuleStore;
  /** true = 处于坏 JSON 保护态：一切写操作必须拒绝 */
  corrupted: boolean;
}

function loadRules(dir?: string): LoadedStore {
  const marker = findCorruptMarker(dir);
  if (marker) {
    console.warn(`[team-rules] 规则库处于坏 JSON 保护态（留证：${marker}），拒绝一切写操作——请人工检查后删除留证文件`);
    return { store: { version: 1, rules: [] }, corrupted: true };
  }
  const p = rulesPath(dir);
  if (!existsSync(p)) return { store: { version: 1, rules: [] }, corrupted: false };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RuleStore>;
    if (Array.isArray(raw?.rules)) return { store: { version: 1, rules: raw.rules as RuleEntry[] }, corrupted: false };
    return corruptAndRefuse(p, dir, "结构非法（rules 非数组）");
  } catch (e) {
    return corruptAndRefuse(p, dir, e instanceof Error ? e.message : String(e));
  }
}

function corruptAndRefuse(p: string, dir: string | undefined, why: string): LoadedStore {
  const renamed = `${p}.corrupt-${Date.now()}`;
  try {
    renameSync(p, renamed);
  } catch (e) {
    console.warn(`[team-rules] 坏文件留证失败（${e instanceof Error ? e.message : String(e)}）——拒绝写操作仍生效`);
  }
  console.warn(`[team-rules] 规则库 JSON 损坏（${why}）→ 已改名 ${renamed} 留证；拒绝一切写操作，要求人工介入`);
  return { store: { version: 1, rules: [] }, corrupted: true };
}

function saveRules(s: RuleStore, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    atomicWrite(rulesPath(d), JSON.stringify(s, null, 2) + "\n");
    writeRulesMirror(dir); // #279 规则可发现性：随库刷新 RULES.md 镜像（失败不阻断入库）
    return true;
  } catch (e) {
    console.warn(`[team-rules] 规则库写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- #279 RULES.md 镜像（野生会话可发现性通道） ----------
// 规则真相唯一在 rules.json（org 命令面读写）；镜像落 org 目录旁（生产
// ~/.cc-deck/RULES.md），给「不经 org 体系的会话/人」一个纯文本可发现入口——
// SessionStart 广播（session-manager.sessionStartBroadcast）引用同一路径。
// 只镜像 active 条目；机器生成文件，手编会在下次写库/boot 刷新时被覆盖。
export function rulesMirrorPath(dir?: string): string {
  // org 目录的父层（生产 orgDir=~/.cc-deck/org → ~/.cc-deck/RULES.md，任务书指定的
  // 可发现位置；沙盒随 CCR_ORG_DIR 同层隔离）。注意不是 dirname(rules.json)=org 目录
  // 本身——埋进 org/ 里的文件野生会话照样发现不了（本批测试实锤纠偏）
  return join(dirname(dirname(rulesPath(dir))), "RULES.md");
}

export function writeRulesMirror(dir?: string): boolean {
  try {
    // 两道前置闸（审查 A-P2 收敛）：①org 目录未建（boot 早于 ensureOrgDir 的裸启）
    // 不递归建目录不落镜像——镜像只在 org 已初始化的机器出现，也避免测试沙盒把
    // RULES.md 写进共享 tmp 根；②坏 JSON 保护态跳过刷新——corrupted 时库内容不可
    // 信，覆写会抹掉最后一份有效镜像（排障时刻最需要它）
    if (!existsSync(dirname(rulesPath(dir)))) return false;
    const loaded = loadRules(dir);
    if (loaded.corrupted) return false;
    const active = loaded.store.rules.filter((e) => e.status === "active");
    const lines = [
      "# cc-deck 团队规则（RULES.md 镜像）",
      "",
      `> 机器生成，勿手编——真相在 ${rulesPath(dir)}，改动走 \`org rule append|retire|supersede\`。生成于 ${new Date().toISOString()}`,
      "",
      ...(active.length
        ? active.map((e) => `- [${e.id}] ${e.audience} · ${e.scope}：${e.text}`)
        : ["（当前无 active 规则）"]),
      "",
    ];
    atomicWrite(rulesMirrorPath(dir), lines.join("\n"));
    return true;
  } catch (e) {
    console.warn(`[team-rules] RULES.md 镜像刷新失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- 归一键与锚点归一（A 路开放问题 4：同 scope 同 audience 重复文本检测） ----------

/** trim + 小写 + NFKC 全半角归一 + 去标点空白 + 前 N 字符。与经验库 normExpKey 同算法
 * 但独立实现——红线约定本模块从 experience.ts 只 import sanitizeExperienceText（防两库
 * 实现互相缠绕；将来抽 orgStoreAtomic 小工具时一并收敛，C 路 §7.2 P4 备案）。 */
export function normRuleKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}]/gu, "")
    .slice(0, RULE_NORM_KEY_CHARS);
}

/** 锚点目录归一（尾斜杠，experience.ts normAnchor 同款） */
function normAnchor(p: string): string {
  return p.replace(/\/+$/, "");
}

/** project scope 锚点校验：必须是存在过的锚点目录（任意状态组——规则活过组生命周期，
 * 与经验库 anchorExists 同口径） */
function anchorExists(anchor: string, dir?: string): boolean {
  const a = normAnchor(anchor);
  if (!a.startsWith("/")) return false;
  for (const g of listGroups(dir)) if (normAnchor(g.anchor_dir) === a) return true;
  return false;
}

// ---------- audience / scope 解析与校验（写入 fail-closed，拍板 #3） ----------

export interface ParsedAudience {
  ok: true;
  value: string;
}
export interface Rejected {
  ok: false;
  error: string;
}
type AudienceParse = ParsedAudience | Rejected;

/** audience 解析：all | leader | role:<P81 词表>。词表外 role 拒收（P81-5
 * unknown_role_mapping 先例：一条永不注入但用户以为在管的规则，比显性报错危险得多） */
export function parseAudience(raw: string | undefined | null): AudienceParse {
  const t = (raw ?? "all").trim().toLowerCase() || "all";
  if (t === "all" || t === "leader") return { ok: true, value: t };
  if (t.startsWith("role:")) {
    const role = t.slice(5).trim();
    if (BIZ_ROLE_VOCAB.has(role)) return { ok: true, value: `role:${role}` };
    return { ok: false, error: `audience 非法（${t}）：role 词表为 ${[...BIZ_ROLE_VOCAB].join("/")}（fail-closed：词表外角色永不注入但会误以为在管）` };
  }
  return { ok: false, error: `audience 非法（${t}）：必须是 all | leader | role:<${[...BIZ_ROLE_VOCAB].join("/")}>` };
}

type ScopeParse = { ok: true; value: string } | Rejected;

/** scope 解析：team | project:<锚点目录>。入参容忍裸路径（自动补 project: 前缀并归一尾斜杠） */
export function parseScope(raw: string | undefined | null, dir?: string): ScopeParse {
  const t = (raw ?? "team").trim() || "team";
  if (t === "team") return { ok: true, value: "team" };
  const m = t.match(/^project:(.+)$/);
  const anchor = normAnchor(m ? m[1]! : t);
  if (!anchorExists(anchor, dir)) {
    return { ok: false, error: `scope 非法（${t}）：project 锚点必须是存在过的项目目录（绝对路径）` };
  }
  return { ok: true, value: `project:${anchor}` };
}

// ---------- 注入行格式（纯函数） ----------

/** 注入行：[徽标] text。徽标 = 受众·本项目（受众缺省显示，项目 scope 才补本项目）。 */
export function formatRuleLine(e: RuleEntry): string {
  const aud = e.audience === "all" ? "全员" : e.audience === "leader" ? "Leader" : `角色:${e.audience.slice(5)}`;
  const proj = e.scope.startsWith("project:") ? "本项目" : "";
  return `[${[aud, proj].filter(Boolean).join("·")}] ${sanitizeExperienceText(e.text)}`;
}

const RULE_BLOCK_HEADER = (n: number) => `—— 团队规则（${n} 条·用户审定红线，必须遵守）——`;
// 优先级定性行（拍板 #7/#9 + A 路 §10.3-6 单调收紧）：规则对经验/岗位参考恒优先（红线 vs
// 参考）；对派单纪律只可加严不可放宽（系统纪律是地板不是天花板，冲突择严执行）
const RULE_BLOCK_FOOTER = "—— 以上团队规则是用户红线：违反即任务失败；优先于下方经验与岗位参考，与派单纪律冲突时择严执行（规则只可加严不可放宽）——";
const RULE_BLOCK_OVERHEAD = RULE_BLOCK_HEADER(0).length + RULE_BLOCK_FOOTER.length + 3;

/** 写侧桶账：team∧audience=all 的格式化总量（每单必命中的最坏情况桶，C 路 §5.3） */
export function teamAllBucketChars(rules: RuleEntry[]): number {
  let total = RULE_BLOCK_OVERHEAD;
  for (const e of rules) {
    if (e.status === "active" && e.scope === "team" && e.audience === "all") total += formatRuleLine(e).length + 1;
  }
  return total;
}

// ---------- 写入口（append / retire / supersede / promote——全部显式动作，零 GC 零自动） ----------

export type RuleWriteResult =
  | { ok: true; entry: RuleEntry; superseded?: string }
  | { ok: false; error: string; duplicate_of?: string };

/** 单条校验+构造（append/supersede/promote 三口共用）：sanitize→长度→audience→scope。
 * 返回即用形态（text 已 sanitize，audience/scope 已归一）。 */
function buildEntry(
  input: { text: string; audience?: string; scope?: string; created_by: "user" | "agent"; promoted_from?: string; confirm_id?: string },
  now: number,
  dir?: string,
): { ok: true; entry: RuleEntry } | Rejected {
  const text = sanitizeExperienceText(typeof input.text === "string" ? input.text : "");
  if (!text) return { ok: false, error: "text 必填（sanitize 后为空）" };
  if (text.length > ruleMaxText()) {
    return { ok: false, error: `text 超 ${ruleMaxText()} 字（当前 ${text.length}）——规则是一句话红线，精简或拆条` };
  }
  const aud = parseAudience(input.audience);
  if (!aud.ok) return aud;
  const scope = parseScope(input.scope, dir);
  if (!scope.ok) return scope;
  return {
    ok: true,
    entry: {
      id: `rule-${randomUUID().slice(0, 8)}`,
      text,
      audience: aud.value,
      scope: scope.value,
      status: "active",
      ...(input.promoted_from ? { promoted_from: input.promoted_from } : {}),
      ...(input.confirm_id ? { confirm_id: input.confirm_id } : {}),
      created_by: input.created_by,
      created_at: now,
      updated_at: now,
    },
  };
}

/**
 * 追加一条规则（数值硬闸全在此，超限拒收报清晰错误——拍板 #4）：
 * - 硬① 形状：text sanitize 后必填 ≤120 字；audience 三档且 role 对齐 P81 词表（fail-closed）；
 *   scope=team 或存在过的项目锚点。
 * - 硬② 去重：同 scope+audience 下归一键命中 active 条目 → 拒收并带 duplicate_of
 *   （重复红线的正确动作是 retire 旧条重立，不是双活）。
 * - 硬③ 数值闸：团队 active ≤6 / 单项目 ≤4 / 单角色 ≤4（只计 active——retired/superseded
 *   是终态，计入则库必然永久饱和，经验库同口径）。
 * - 硬④ 必达闸（team∧all 桶追加时）：格式化总量 > 注入预算 → 拒新，提示先精简——
 *   保证「团队全员规则注入零截断」硬性质（C 路 §5.3）。
 */
export function appendRule(
  input: { text: string; audience?: string; scope?: string; created_by?: "user" | "agent"; promoted_from?: string; confirm_id?: string },
  dir?: string,
): RuleWriteResult {
  const { store, corrupted } = loadRules(dir);
  if (corrupted) return { ok: false, error: "规则库处于坏 JSON 保护态（留证文件在），拒绝写操作——请人工介入" };
  const now = Date.now();
  const built = buildEntry({ ...input, created_by: input.created_by ?? "user" }, now, dir);
  if (!built.ok) return built;
  const entry = built.entry;
  // 去重（同 scope+audience 谓词内，只查 active）
  const key = normRuleKey(entry.text);
  const dup = store.rules.find(
    (e) => e.status === "active" && e.scope === entry.scope && e.audience === entry.audience && normRuleKey(e.text) === key,
  );
  if (dup) return { ok: false, error: `同主题规则已存在（${dup.id}）——改规则用 supersede（替代链），重复红线先 retire 旧条`, duplicate_of: dup.id };
  // 数值闸（只计 active）
  const teamCount = store.rules.filter((e) => e.status === "active" && e.scope === "team").length;
  if (entry.scope === "team" && teamCount >= ruleMaxTeam()) {
    return { ok: false, error: `团队 active 规则已达上限 ${ruleMaxTeam()} 条——先 retire/supersede 精简再立新（铁律是稀缺品）` };
  }
  if (entry.scope.startsWith("project:")) {
    const projCount = store.rules.filter((e) => e.status === "active" && e.scope === entry.scope).length;
    if (projCount >= ruleMaxProject()) return { ok: false, error: `该项目 active 规则已达上限 ${ruleMaxProject()} 条——先精简再立新` };
  }
  if (entry.audience.startsWith("role:")) {
    const roleCount = store.rules.filter((e) => e.status === "active" && e.audience === entry.audience).length;
    if (roleCount >= ruleMaxRole()) return { ok: false, error: `角色 ${entry.audience.slice(5)} 的 active 规则已达上限 ${ruleMaxRole()} 条——先精简再立新` };
  }
  // 必达闸：team∧all 桶格式化总量 ≤ 注入预算（追加前含新条计账）
  if (entry.scope === "team" && entry.audience === "all") {
    const total = teamAllBucketChars(store.rules) + formatRuleLine(entry).length + 1;
    if (total > rulesInjectBudget()) {
      return { ok: false, error: `团队全员规则注入预算将超限（${total} > ${rulesInjectBudget()} 字符）——先精简（retire/supersede）再追加（规则注入零截断硬性质）` };
    }
  }
  store.rules.push(entry);
  if (!saveRules(store, dir)) return { ok: false, error: "规则库写入失败（见 relay 日志）" };
  return { ok: true, entry };
}

/** 退役（显式动作，幂等）：active → retired。retired 永不物理删（append-only 审计）。 */
export function retireRule(id: string, dir?: string): RuleWriteResult {
  const { store, corrupted } = loadRules(dir);
  if (corrupted) return { ok: false, error: "规则库处于坏 JSON 保护态，拒绝写操作——请人工介入" };
  const e = store.rules.find((x) => x.id === id);
  if (!e) return { ok: false, error: `规则不存在: ${id}` };
  if (e.status !== "active") return { ok: true, entry: e }; // 幂等
  e.status = "retired";
  e.updated_at = Date.now();
  if (!saveRules(store, dir)) return { ok: false, error: "规则库写入失败（见 relay 日志）" };
  return { ok: true, entry: e };
}

/**
 * 替代（拍板 #6 改规则=新条入库+旧条停注+旧条指新）：一次 RMW 原子落两变——新条全闸
 * 校验通过才动旧条（新条被拒则旧条原样，无半态）。新条 created_by/confirm_id 沿用调用方。
 */
export function supersedeRule(
  oldId: string,
  input: { text: string; audience?: string; scope?: string; created_by?: "user" | "agent"; confirm_id?: string },
  dir?: string,
): RuleWriteResult {
  const { store, corrupted } = loadRules(dir);
  if (corrupted) return { ok: false, error: "规则库处于坏 JSON 保护态，拒绝写操作——请人工介入" };
  const old = store.rules.find((x) => x.id === oldId);
  if (!old) return { ok: false, error: `规则不存在: ${oldId}` };
  if (old.status !== "active") return { ok: false, error: `规则 ${oldId} 已是 ${old.status}，只有 active 规则可被替代` };
  const now = Date.now();
  // 新条 scope/audience 缺省继承旧条（改字为主，改受众显式传参）
  const built = buildEntry(
    {
      text: input.text,
      audience: input.audience ?? old.audience,
      scope: input.scope ?? old.scope,
      created_by: input.created_by ?? "user",
      confirm_id: input.confirm_id,
    },
    now,
    dir,
  );
  if (!built.ok) return built;
  const entry = built.entry;
  // 数值闸：替代后该 scope/role 的 active 计数不变（-旧+新），但 team∧all 桶账会变——
  // 按追加同款校验桶账（旧条仍在账上，模拟替代后口径：账 = 现总量 - 旧行 + 新行）
  if (entry.scope === "team" && entry.audience === "all") {
    const others = store.rules.filter((e) => !(e.id === oldId));
    const total = teamAllBucketChars(others) + formatRuleLine(entry).length + 1;
    if (total > rulesInjectBudget()) {
      return { ok: false, error: `替代后团队全员规则注入预算将超限（${total} > ${rulesInjectBudget()} 字符）——新文本请更精简` };
    }
  }
  old.status = "superseded";
  old.superseded_by = entry.id;
  old.updated_at = now;
  store.rules.push(entry);
  if (!saveRules(store, dir)) return { ok: false, error: "规则库写入失败（见 relay 日志）" };
  return { ok: true, entry, superseded: oldId };
}

export interface PromoteInput {
  /** 源经验条目 id（promoted_from 溯源） */
  exp_id: string;
  /** 源经验正文（调用方从经验库读出传入——本模块不 import 经验库读面，红线约定） */
  exp_text: string;
  /** 源经验 role_scope（"any" → audience=all；词表外角色名 → 拒，提示显式改写） */
  exp_role_scope: string;
  /** 源经验 project_scope（"global" → scope=team；锚点 → scope=project:<锚>） */
  exp_project_scope: string;
  /** 显式改写正文（缺省用源文——超 120 字拒升格要求改写，不做截断：约束截断=坏约束） */
  text?: string;
  /** 显式改受众（缺省按源 role_scope 推导；推导值 fail-closed 词表外必须显式给） */
  audience?: string;
  /** 显式改 scope（缺省按源 project_scope 推导） */
  scope?: string;
  created_by?: "user" | "agent";
  confirm_id?: string;
}

/**
 * 经验 → 规则升格（拍板 #5：复制非搬移）。源条目由调用方经经验库通道自管（照常 GC，
 * 本函数零触碰）；本函数只造规则条：promoted_from 正向溯源，scope/audience 按源经验
 * 双轴推导（可显式覆盖）。文本 >120 字拒收要求显式改写（约束截断=坏约束，C 路 §4.2
 * 同口径；导入器拒超长、升格拒超长，全库一致）。
 */
export function promoteExperienceToRule(input: PromoteInput, dir?: string): RuleWriteResult {
  const derivedScope = input.exp_project_scope === "global" || !input.exp_project_scope ? "team" : `project:${normAnchor(input.exp_project_scope)}`;
  const derivedAudience = !input.exp_role_scope || input.exp_role_scope === "any" ? "all" : `role:${input.exp_role_scope.trim().toLowerCase()}`;
  // 推导受众 fail-closed 校验（显式覆盖走 appendRule 闸同款校验，此处先挡推导值）
  if (!input.audience && derivedAudience.startsWith("role:")) {
    const role = derivedAudience.slice(5);
    if (!BIZ_ROLE_VOCAB.has(role)) {
      return { ok: false, error: `源经验 role_scope「${role}」在规则受众词表外（${[...BIZ_ROLE_VOCAB].join("/")}）——升格须显式指定 audience（fail-closed：词表外角色的规则永不注入）` };
    }
  }
  return appendRule(
    {
      text: input.text ?? input.exp_text,
      audience: input.audience ?? derivedAudience,
      scope: input.scope ?? derivedScope,
      created_by: input.created_by ?? "user",
      promoted_from: input.exp_id,
      confirm_id: input.confirm_id,
    },
    dir,
  );
}

// ---------- 查询 ----------

export function listRules(filter?: { status?: RuleStatus; audience?: string; scope?: string }, dir?: string): RuleEntry[] {
  const { store } = loadRules(dir);
  let out = store.rules;
  if (filter?.status) out = out.filter((e) => e.status === filter.status);
  if (filter?.audience) out = out.filter((e) => e.audience === filter.audience);
  if (filter?.scope) out = out.filter((e) => e.scope === normAnchor(filter.scope!) || e.scope === filter.scope);
  return out;
}

// ---------- 注入（每单重注无 memo——约束不是参考，「注过」不等于「会守」，C 路 §5.2） ----------

/** 注入匹配谓词（纯函数）：status active + 受众三档 + scope 双值。 */
export function matchRule(e: RuleEntry, role: string, anchor: string, isLeader: boolean): boolean {
  if (e.status !== "active") return false;
  const r = role.trim().toLowerCase();
  if (e.audience === "all") {
    // 恒命中
  } else if (e.audience === "leader") {
    if (!isLeader) return false; // 仅 Leader 会话（拍板 #3 三档）
  } else if (e.audience.startsWith("role:")) {
    if (e.audience.slice(5).toLowerCase() !== r) return false;
  } else {
    return false; // 未知受众形态不命中（手编坏档容错）
  }
  if (e.scope === "team") {
    // 恒命中（团队级）
  } else if (e.scope.startsWith("project:")) {
    if (normAnchor(e.scope.slice(8)) !== normAnchor(anchor)) return false;
  } else {
    return false;
  }
  return true;
}

export interface RuleInjectionInput {
  /** 派单角色（与经验注入 expRole 同源取值） */
  role: string;
  /** 项目锚点目录（project scope 匹配轴） */
  anchor: string;
  /** Leader 会话注入面（P1 只传 false——worker 派单；Leader 侧可见性主通道=org
   * CLAUDE.md 种子引用行，memo 注入为可选增强 P2——拍板 #8） */
  isLeader?: boolean;
  dir?: string;
  budget?: number;
}

export interface RuleInjection {
  block: string;
  /** 实际装填条数 */
  count: number;
  /** 预算截除条数（>0 时已 warn——窄域桶尽力达口径，C 路 §5.3） */
  dropped: number;
}

/**
 * 构建团队规则注入块（dispatchWorker 消费，wrapDispatchPrompt 第五参）。整体降级契约
 * （experience 同款）：任何抛错 → warn + null（无规则块），派单照发。装填序 = created_at
 * 升序（拍板口径「status active 按 created_at 排序」；同毫秒按 id 稳定序），预算装不下
 * 截尾 + warn（写侧必达闸已保证 team∧all 桶——每单必命中集合——永不截除，截除只可能
 * 发生在项目/角色窄域桶）。
 */
export function buildRuleInjection(input: RuleInjectionInput): RuleInjection | null {
  try {
    if (!readPluginConfig().rules) return null; // 总开关：关=注入停零残留
    const { store, corrupted } = loadRules(input.dir);
    if (corrupted || store.rules.length === 0) return null;
    const matched = store.rules
      .filter((e) => matchRule(e, input.role, input.anchor, input.isLeader ?? false))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    if (matched.length === 0) return null;
    const budget = input.budget ?? rulesInjectBudget();
    const lines: string[] = [];
    let total = RULE_BLOCK_OVERHEAD;
    for (const e of matched) {
      const line = formatRuleLine(e);
      const cost = line.length + 1;
      if (total + cost > budget) break; // 装不下截尾（保序不跳条）
      total += cost;
      lines.push(line);
    }
    if (lines.length === 0) {
      console.warn(`[team-rules] 注入预算 ${budget} 内装不下任何规则行（头尾 ${RULE_BLOCK_OVERHEAD}），本单无规则块`);
      return null;
    }
    const dropped = matched.length - lines.length;
    if (dropped > 0) {
      const droppedIds = matched.slice(lines.length).map((e) => e.id).join(",");
      console.warn(`[team-rules] 注入预算截除 ${dropped} 条（${droppedIds}）——请精简规则集（retire/supersede），规则注入应零截断`);
    }
    return { block: [RULE_BLOCK_HEADER(lines.length), ...lines, RULE_BLOCK_FOOTER].join("\n"), count: lines.length, dropped };
  } catch (e) {
    console.warn(`[team-rules] 规则注入块构建失败（降级无规则块，派单照发）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------- #108 内置铁律种子（2026-10-15，PM 不编码角色边界产品化） ----------

/** 内置铁律正文（#108）：PM 会话收到实现类需求「忍不住自己写代码」是角色错位
 * （1015 用户实测实锤：交付慢/上下文浪费/职责混乱），固化为产品默认规则——新用户
 * 开团即得，主权仍归用户（retire/supersede 随意；退役后本种子永不复活）。 */
export const BUILTIN_RULE_PM_NO_CODE = "PM 不直接编码——实现类工作派发 worker";

/**
 * 幂等种子（ensureOrgClaudeMd 同纪律：存在即认、永不覆盖、永不复活）。归一键在
 * 全库任何状态（active/retired/superseded）命中即视为已种过——用户 retire 它是
 * 明确决定，重启重播=对抗用户主权。挂点在 ensureLeader org 初始化段（新用户开团
 * 即得）；内部自吞错（种子尽力而为，不阻断 Leader 创建——settings.ts 雇员家种子
 * 同口径）。created_by="user"：产品预置默认走用户主权面（词表只有 user|agent，
 * agent=确认卡提案链路语义不符；用户可改可退，主权面归属正确）。
 */
export function ensureBuiltinRulesSeed(dir?: string): "created" | "exists" | "failed" {
  try {
    const { store } = loadRules(dir);
    const key = normRuleKey(BUILTIN_RULE_PM_NO_CODE);
    if (store.rules.some((e) => normRuleKey(e.text) === key)) return "exists";
    const r = appendRule(
      { text: BUILTIN_RULE_PM_NO_CODE, audience: "role:pm", scope: "team", created_by: "user" },
      dir,
    );
    // 满库（数值闸拒收）/坏 JSON 保护态等 → failed 不抛：种子不挤用户的规则
    return r.ok ? "created" : "failed";
  } catch (e) {
    console.warn(`[team-rules] 内置铁律种子失败（忽略，不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
