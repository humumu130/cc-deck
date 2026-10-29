// #26 矩阵式团队 M1 —— 组织（org）底座：org 目录约定 / Leader 常驻锚 / 组织记忆种子 / 派单台账。
// 设计稿 docs/v8-team-matrix.html v3.1：常驻组织 = 唯一 Leader + 两本账（组织记忆=CLAUDE.md 慢账，
// 派单台账=dispatch-log.ndjson 快账）。本模块是纯 fs 读写底座，不 import session-manager/EventBus（无环）。
//
// 三个物理事实（选址与形态依据，勿改）：
// - org 目录固定 ~/.cc-deck/org（CCR_ORG_DIR 覆盖，逐次求值仿 artifactsDir）：用户可见资产，
//   与 data/（relay 运行数据）分层；绝不能放 artifacts/（写进去=自动收录交付物）。
// - 锚（org.json）必须独立于 events.ndjson（compactEvents 只留 30 会话，Leader 的 CREATED 会被
//   挤掉）与 pinned-sessions.json（applyPinned 双向静默清理失联条目）——锚是常驻身份的唯一权威。
// - 台账必须独立文件同步追加（复刻 history.appendLine）：EventBus 持久化路径在启动时被
//   compactEvents+rewriteFile 整文件重写，走事件流会破坏 append-only 审计语义。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDataDirIsolated } from "./config.js";
import { viaReadMode, dispatchEntriesFromDb } from "./storage/read-mode.js";
import { writeDispatchToDb } from "./storage/write-dispatch.js"; // #292 cutover 批1 v2：append 后同步落库
import { atomicWriteJson } from "./fs-safe.js";
import { applyOrgChange } from "./org-schema.js";
import type { SessionEngine } from "./types.js";

export type CommandRole = "owner" | "operator" | "viewer";
export type CommandCapability = "org:write" | "profile:write" | "artifact:read" | "artifact:batch";

export const COMMAND_CAPABILITY_MATRIX: Record<CommandRole, readonly CommandCapability[]> = {
  owner: ["org:write", "profile:write", "artifact:read"],
  operator: ["org:write", "profile:write", "artifact:read"],
  viewer: ["artifact:read"],
};

export const ZCODE_DEFAULT_CAPABILITY = {
  engine: "zcode" as const,
  enabled: false,
  unsupported: true,
  capabilities: [] as const,
};

export interface ForbiddenCommandAck {
  command_id: string;
  ok: false;
  error: "forbidden";
  actor_role: CommandRole;
}

export interface CommandPermissionResult {
  allowed: boolean;
  actor_role: CommandRole;
  capability: string;
  ack?: ForbiddenCommandAck;
  reason?: string;
}

export interface CommandPermissionOptions {
  command_id?: string;
  capabilities?: readonly string[];
  engine?: SessionEngine;
}

/** 纯权限判定；调用方仍需从真实连接身份解析 actor，不信任客户端自报角色。 */
export function evaluateCommandPermission(
  actorRole: CommandRole,
  capability: string,
  options: CommandPermissionOptions | string = {},
): CommandPermissionResult {
  const normalized = typeof options === "string" ? { command_id: options } : options;
  const roleCapabilities = COMMAND_CAPABILITY_MATRIX[actorRole];
  const explicit = normalized.capabilities ?? [];
  const zcodeDenied = normalized.engine === "zcode";
  const allowed = !zcodeDenied && (
    roleCapabilities?.includes(capability as CommandCapability) === true ||
    (capability === "artifact:batch" && (actorRole === "owner" || actorRole === "operator") && explicit.includes("artifact:batch"))
  );
  if (allowed) return { allowed: true, actor_role: actorRole, capability };
  return {
    allowed: false,
    actor_role: actorRole,
    capability,
    reason: zcodeDenied ? "zcode_unsupported" : "missing_capability",
    ack: {
      command_id: normalized.command_id ?? "",
      ok: false,
      error: "forbidden",
      actor_role: actorRole,
    },
  };
}

export interface EngineCapabilityPermission {
  allowed: boolean;
  engine: SessionEngine;
  capability: string;
  reason: string;
}

export function evaluateEngineCapability(engine: SessionEngine, capability: string): EngineCapabilityPermission {
  if (engine === "zcode") return { allowed: false, engine, capability, reason: "unsupported" };
  return { allowed: true, engine, capability, reason: "registered" };
}

// 用户 2026-09-27 拍板：淡化「组织」概念（设计稿内部术语不进用户面）——卡片直名 Leader，
// 用户可见文案一律「团队」。代码标识符（ORG_ 前缀/org 目录名）不动（架构层）。
export const ORG_LEADER_TITLE = "Leader";

// 首建上岗引导消息：fresh parked CLI（空 prompt）在真实链路不回 init——SDK 会话 id
// 只在 CLI 收到首条输入后才产生（#49 既有实证；M1 真链路复现：parked 2 分钟零输出，
// 进程存活 CPU 闲置）。首建必须带这条上岗消息：① 拿到 sdkId（锚从此可 resume）；
// ② 执行 CLAUDE.md 种子的「上岗读档自检」。只此一回，之后常驻全走 resume 零新回合。
// 注意：走 create 的 initialPrompt（非 COMMAND_MESSAGE），C3 派单台账不会把它记成咨询。
export const ORG_LEADER_BOOTSTRAP_PROMPT =
  "（Leader 上岗引导，系统消息）你已被创建为常驻团队的 Leader。请只做一件事：阅读本目录的 CLAUDE.md（团队记忆与分诊通道），然后用一两句话确认上岗——复述你的五响应分诊（咨询/随手办/轻立项/正经立项/建议暂缓）即可。不要执行其他操作、不要改动任何文件。";

// W-SANDBOXFIX P1-1（2026-10-16）：旧缺省恒指 ~/.cc-deck/org，与 CCR_DATA_DIR 不联动
// ——沙盒 relay（CCR_DATA_DIR=tmp）建团直写生产 projects.json（W-TESTSYS 实锤）。
// 现口径：显式 CCR_ORG_DIR 最高优先；CCR_DATA_DIR 隔离态（isDataDirIsolated，值≠
// 生产缺省）org 目录随 data 走（<CCR_DATA_DIR>/org）；其余（未设/生产缺省值/开发态）
// 维持 ~/.cc-deck/org 原样。横幅 once 备案（orgDir 是热路径，防刷屏）
let orgDirBannerShown = false;
export function orgDir(): string {
  if (process.env.CCR_ORG_DIR) return process.env.CCR_ORG_DIR;
  if (isDataDirIsolated()) {
    const dir = join(process.env.CCR_DATA_DIR as string, "org");
    if (!orgDirBannerShown) {
      orgDirBannerShown = true;
      console.log(`[org] CCR_DATA_DIR 隔离：org 目录随 data 目录走 → ${dir}（显式 CCR_ORG_DIR 可覆盖）`);
    }
    return dir;
  }
  return join(homedir(), ".cc-deck", "org");
}

export function ensureOrgDir(dir?: string): string {
  const d = dir ?? orgDir();
  mkdirSync(d, { recursive: true });
  return d;
}

function orgFilePath(name: string, dir?: string): string {
  return join(dir ?? orgDir(), name);
}

// ---------- 组织记忆种子（CLAUDE.md） ----------

export const ORG_CLAUDE_MD_SEED = `# 团队 CLAUDE.md —— 常驻团队的记忆与纪律

> 你在 org 目录工作（团队的家，不属于任何项目），本文件随会话自动加载。
> 个人层（用户手写的全局 CLAUDE.md / memory）优先——冲突时以个人层为准。

## 你的角色：Leader

- 你是用户的技术合伙人：常驻、唯一、不隶属任何项目。
- 你持有两本账：
  1. 团队记忆 = 本文件（慢账：经验、偏好、方法论、坑）。
  2. 派单台账 = 同目录 dispatch-log.ndjson（快账：何时派了什么、结果如何；系统自动记录，勿手改）。
- 换壳不换档：你会被更换模型或重建会话，账是文件不是记忆。每次上岗先读本文件自检——能复述关键偏好即通过。

## 团队记忆写入纪律（宁缺毋滥）

写入门槛——三条同时满足才写：
- 跨项目可复用（只对单个项目有效的经验写该项目自己的 CLAUDE.md）；
- 再遇到时你希望直接想起（忘了会重复劳动或重复踩坑）；
- 个人层没有（用户全局 CLAUDE.md 已有的偏好不抄写进来）。

优先记这几类：
- 用户明说「记住这个」「以后都这样」的偏好与决定；
- 被验证有效的工作方法与流程；
- 踩过的坑与排查路径（含绕过方案、环境特异性）。

写法约束：
- 增量追加或原地小改，不重排不删既有条目；每条带日期前缀（如「2026-09-26 」）；
- 一条一事，能一句话说清的不写三句；
- 过时条目标注「已过时」而非删除（保留审计线索）。

## 团队信息

- 团队目录：本文件所在目录。
- 派单台账 / 会话锚：同目录 dispatch-log.ndjson / org.json（均系统维护，勿手改）。
`;

// M2 分诊通道增量（v3.1 §4 响应四档 + 第五态 + 词表迁移）：按标记幂等追加——
// M1 期间已落地的 org CLAUDE.md 有 Leader 沉淀的记忆，不能整文件重播（防漂移同款
// 纪律：增量追加，不重排不删既有条目）；过渡期段落以「已过时」标注而非删除。
export const ORG_CLAUDE_MD_M2_MARKER = "## M2 分诊通道";
export const ORG_CLAUDE_MD_M2_SECTION = `${ORG_CLAUDE_MD_M2_MARKER}（2026-09-27 起，v3.1 §4）

- 上方若还有「过渡期纪律（M1）」段：整段已过时——项目 Leader 退役，你是唯一分诊出口，沟通线收敛为 1（新装文件无此段，读下文即可）。
- 用户的一切来意先分诊，五响应（响应四档 + 第五态）：
  1. 咨询：问题/分析，不改代码——对话内直接答；发现 spec 勘误顺手修（转随手办零确认）。
  2. 随手办：30 秒~几分钟小改——\`~/.cc-deck/bin/org dispatch <项目目录> "<任务>"\` 派 worker（不建组、不建 worktree）。
  3. 轻立项（客户端显示为「轻量项目」）：几小时~几天小功能——\`org create <名> <目录> 轻立项\`（首次须用户确认，同类免确认信任累积）。
  4. 正经立项（客户端显示为「正式项目」）：复杂项目——\`org create <名> <目录> 正经立项\`（每次须用户确认，防误判档烧钱）。
  5. 建议暂缓：依赖未就绪/时机不对——\`org hold <组id|-> "<理由>" "<解除条件>"\`（用户点头才挂起）。
- 其他指令：\`org status\`（全景）/ \`org set <id> active|parked|archived\`（状态迁移，你说先放放=挂起）/ \`org tier <id> <档> "<理由>"\`（升降级）/ \`org board ...\`（任务板维护）/ \`org detail <id>\`（编制/板/回执流）。
- 确认卡：正经立项/升降级/有悬账结项会出确认单，等用户在客户端 ✓/✗——你只提案不决议，不代用户决定。
- 随手办 worker 的纪律（回执一行/commit 前缀）由派单系统自动注入，无需你转述；台账系统自动记，勿手改。
`;

// 冲刺 F-11（J2 实测校准）：M1 过渡段「小事可直接办」（存量文件仅标过时未删）与 M2
// 「派 worker」打架，模型择易而行亲自动手——活不在台账、无审计。此补强段两条硬纪律
// 按标记幂等追加到存量文件（同 M2 机制：不重排不删既有条目）；种子侧 M1 段已删（新装
// 文件只靠本段立规矩）。
export const ORG_CLAUDE_MD_M2P1_MARKER = "## 分诊执行口径";
export const ORG_CLAUDE_MD_M2P1_SECTION = `${ORG_CLAUDE_MD_M2P1_MARKER}（2026-09-28 补强，实测校准，优先级高于上文措辞）

- 随手办一律派 worker：凡结论是「要改文件/跑命令交付点什么」的小事，必须走
  \`~/.cc-deck/bin/org dispatch <项目目录> "<任务>"\` 派单——即使你亲手做更快也不行。
  你亲自动手 = 活不在台账、无审计、无人接盘。你的双手只用于：读档查证、与用户对话、
  执行 org 分诊指令本身。
- 暂缓必须落台账：凡分诊结论是「时机未到/依赖未就绪/等用户发话」，无论有没有项目组，
  都要落 \`org hold <组id|-> "<理由>" "<解除条件>"\`。暂缓只记在会话任务清单里 =
  relay 重启即蒸发、org status 里看不见 = 等于没说。
`;

// W-RULES1（2026-10-11，拍板表 #8）：团队规则库 Leader 可见性主通道=本文件种子引用行
//（org CLAUDE.md 随 Leader 会话 cwd 自动加载，零注入链成本；memo 注入为可选增强 P2）。
// 按标记幂等追加（M2/M2P1 同机制：不重排不删既有条目）。
export const ORG_CLAUDE_MD_RULES_MARKER = "## 团队规则库";
export const ORG_CLAUDE_MD_RULES_SECTION = `${ORG_CLAUDE_MD_RULES_MARKER}（2026-10-11 起，W-RULES1）

- 同目录 rules.json 是用户审定的团队/项目红线（audience 三档 all/leader/role:xxx），
  每次派单自动注入对应 worker——规则是红线不是参考，worker 必须遵守。
- 查看：\`org rule list\`。立新规则：用户 CLI 直写 \`org rule append "<一句话>"\`；
  你（Leader）认为该立规时只提案不代立——规则变更优先请用户拍板，用户红线的主权在用户。
- 改规则用 \`org rule supersede <id> "<新文本>"\`（旧条停注留痕），退役用
  \`org rule retire <id>\`；经验库反复命中的条目可升格 \`org rule promote <经验id>\`
  （复制为规则，源经验保留）。
`;

// 幂等种子：只首建、永不覆盖——Leader 上岗后会持续在本文件沉淀组织记忆，重启重播种子会
// 抹掉积累。existsSync 为准（内容不比对，存在即认）。增量按标记追加（M2 → M2 补强，
// 缺哪个补哪个，已有内容零写入——同 id 收敛语义）。
export function ensureOrgClaudeMd(dir?: string): "created" | "exists" | "upgraded" {
  const p = orgFilePath("CLAUDE.md", dir);
  if (!existsSync(p)) {
    writeFileSync(p, ORG_CLAUDE_MD_SEED + "\n" + ORG_CLAUDE_MD_M2_SECTION + "\n" + ORG_CLAUDE_MD_M2P1_SECTION + "\n" + ORG_CLAUDE_MD_RULES_SECTION, "utf-8");
    return "created";
  }
  const cur = readFileSync(p, "utf-8");
  const hasM2 = cur.includes(ORG_CLAUDE_MD_M2_MARKER);
  const hasM2P1 = cur.includes(ORG_CLAUDE_MD_M2P1_MARKER);
  const hasRules = cur.includes(ORG_CLAUDE_MD_RULES_MARKER);
  if (hasM2 && hasM2P1 && hasRules) return "exists";
  const parts = [cur.trimEnd()];
  if (!hasM2) parts.push(ORG_CLAUDE_MD_M2_SECTION);
  if (!hasM2P1) parts.push(ORG_CLAUDE_MD_M2P1_SECTION);
  if (!hasRules) parts.push(ORG_CLAUDE_MD_RULES_SECTION);
  writeFileSync(p, parts.join("\n\n"), "utf-8");
  return "upgraded";
}

// ---------- Leader 常驻锚（org.json） ----------

export interface OrgAnchor {
  version: 1;
  /** relay 会话 id（SessionManager.sessions 的 key / 端上卡片 id） */
  leader_session_id: string;
  /** 最新 CLI/SDK session id（resume 锚点；首建到 init 之间为空串，onInit 回填） */
  leader_sdk_id: string;
  /** #17 Leader 创建时落定的雇员家（spawn 注入值）。缺省 = 关态/pre-#17 锚（默认家）；
   *  锚重建还原到休眠卡，resume/读取按「创建时的家」走——开关翻转对常驻 Leader 无损。
   *  降级链路注意（三角度审查 P3-3 备案）：新锚 → 旧版 relay 跑一次（旧版净化丢此
   *  字段 + onInit 回写）→ 记录被抹；再升级回来时仅当 Leader 首帧仍在 events 才能从
   *  回放还原，否则锚重建无记录 = 默认家 → 雇员 Leader resume 快速失败（可另派新单，
   *  transcript 无损）。复合边界，接受不做兼容，留档于此 */
  employee_home?: string;
  created_at: number;
  updated_at: number;
}

export function readOrgAnchor(dir?: string): OrgAnchor | null {
  try {
    const raw = JSON.parse(readFileSync(orgFilePath("org.json", dir), "utf-8")) as Partial<OrgAnchor>;
    if (raw.version !== 1 || typeof raw.leader_session_id !== "string" || !raw.leader_session_id) return null;
    return {
      version: 1,
      leader_session_id: raw.leader_session_id,
      // 旧锚/手写锚缺该字段容忍为空串（=首建窗口形态，ensureLeader 走废锚重建）
      leader_sdk_id: typeof raw.leader_sdk_id === "string" ? raw.leader_sdk_id : "",
      employee_home: typeof raw.employee_home === "string" && raw.employee_home ? raw.employee_home : undefined,
      created_at: typeof raw.created_at === "number" ? raw.created_at : 0,
      updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    };
  } catch {
    // 无锚 / 坏 JSON：等同未建组织
    return null;
  }
}

export function writeOrgAnchor(a: OrgAnchor, dir?: string): boolean {
  // W-CMDIMPL T0a（#216 设计 §5.3 附加条款）：org.json（Leader 锚）纳入原子写——
  // 换届/锚回写频率不低，同为直写全量面；tmp+rename 消除崩溃半写窗口
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    return atomicWriteJson(orgFilePath("org.json", d), JSON.stringify(a, null, 2) + "\n");
  } catch (e) {
    console.warn(`[org] 锚写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// 手动解散组织的途径（M1）：删锚后下次启动 ensureLeader 视为未建组织
export function clearOrgAnchor(dir?: string): void {
  try {
    rmSync(orgFilePath("org.json", dir), { force: true });
  } catch {}
}

// ---------- 派单台账（dispatch-log.ndjson） ----------

// "看门狗"（#25-P7）非派单档位：SDK 流中断看门狗的自愈动作记台账行专用——设计稿
// §2.5「watchdog 告警进台账」，WATCHDOG 瞬态帧三端零消费，动作此前用户完全不可见
export type DispatchTier = "咨询" | "随手办" | "轻立项" | "正经立项" | "暂缓" | "看门狗";
// "queued"（P0 编制上限 2026-10-15）：编制触顶且全忙时的排队态——单已受理未派发，
// 有 idle 名额/空闲 worker 时由 drainDispatchQueue 接续（不自动扩编）。消费面天然
// 兼容：closeHungDispatchRows/开放单过滤都白名单 running|dispatched，queued 不会被
// 重启断档补记误收口；端上未知状态原样显示（宽容惯例）
export type DispatchStatus = "dispatched" | "running" | "done" | "failed" | "queued";
// #G5 失败分类学：分类器在 dispatch-retry.ts（org.ts 无环依赖该模块只做类型+咽喉调用）
import { classifyDispatchFailure, DISPATCH_FAILURE_REASONS, type DispatchFailureReason } from "./dispatch-retry.js";
export { DISPATCH_FAILURE_REASONS };

export interface DispatchEntry {
  ts: number;
  /** 同一分单的多行共享 id（append-only 状态机，读侧同 id 取最后一行收敛） */
  id: string;
  tier: DispatchTier;
  /** M1 固定 "org-leader"（承接方）；M2 项目派单起为项目成员 */
  target: string;
  /** M2 预留（项目锚点目录），M1 不写 */
  project_anchor?: string;
  status: DispatchStatus;
  /** 收口回执 = terminal_reason（done/failed 时才有，截 200 字） */
  receipt?: string;
  /** 承接会话 = Leader 的 relay session id */
  session_id: string;
  /** #199 D：派单标题（任务 subject 同源，含 #NN 对账 join 键）——旧行缺省 undefined，对账侧容错 */
  title?: string;
  /** #40 M4 谁派活谁收通知："leader"=Leader CLI 派 / "user"=咨询档（用户消息）/
   *  缺省=旧数据或未标注——读侧缺省不降级（通知仍广播端上，仅不定向注入） */
  actor?: string;
  /** M12-5 引擎编排面：派单 resolved 引擎/供应商/模型（选择链三态落定值——显式
   *  覆盖>组角色配置 role_defaults>缺省 Claude；缺省 Claude 不写键=与旧行兼容）。
   *  同 id 全行共享（dispatched/running/终态行透传同值，读侧收敛末行不丢字段）；
   *  导入器不消费（未知字段宽容忽略），仅审计面对账用 */
  engine?: string;
  provider?: string;
  model?: string;
  /** W-CMDIMPL T6（§2.4）：链路演练标记——true=假任务行（不触真实任务/用户）；
   *  读侧宽容忽略（旧行/端上未知字段零影响），统计面对账面可按此排除。 */
  drill?: boolean;
  /** §1.5 阶段事件增量（T1-STAGE）：阶段名（词表=基表+custom. 前缀，拍板 #9）与明细 */
  stage?: string;
  stage_detail?: string;
  /** [W-SMIMPL ②] 回执契约可见化（W-SMDESIGN 候选 2）：done 收口但回执无「结果：」行
   *  （worker 静默收工——三次实锤：账面 done 内容空）时置 true。纯观测标记：读侧
   *  （web 看板卡「无回执」角标/通知账）消费，不改任何状态语义。仅 done 单标（failed
   *  本身即异常信号不双计）。旧行缺省 undefined=有回执口径（宽容惯例）。 */
  receipt_missing?: boolean;
  /** #G5 失败分类学：failed 行的失败枚举（network_error/timeout/tool_crash/
   *  model_overload/logic_error/cancelled）——appendDispatch 咽喉自动分类（receipt
   *  错误串→classifyDispatchFailure），调用方零改动单点收口。瞬态三类（network/
   *  timeout/model_overload）由 dispatchWorker spawn 失败出口自动重试一次。 */
  failure_reason?: DispatchFailureReason;
  /** #G5 瞬态自动重试标记：本行由自动重试产生（值=原单 id；重试走 queue_replay
   *  同 id 段链，此字段标记「该状态段由重试产生」+防循环证据）。链深恒 1。 */
  retry_of?: string;
  /** #G3 板卡富模型透传：派单 priority（P0/P1/P2）随全部台账行（与 engine 字段
   *  同层透传口径，审计面可对账）。缺省=未标注。 */
  priority?: string;
}

export function dispatchLogPath(dir?: string): string {
  return orgFilePath("dispatch-log.ndjson", dir);
}

// 尽力而为：写失败只 warn 不抛——台账是审计面，绝不阻断消息投递/回合状态主路径。
// 无容量上限（append-only 审计语义，设计稿 §6.1 org_memory/dispatch_log 同口径）；
// M1 量级 = 每次咨询 2 行，无需轮转。
export function appendDispatch(e: DispatchEntry, dir?: string): boolean {
  // #G5 失败分类学写侧单点：failed 行自动 failure_reason（receipt 错误串→分类器），
  // 调用方（spawn 失败/回合收口/看门狗等全部出口）零改动——全台账 failed 行带枚举
  if (e.status === "failed" && !e.failure_reason) e.failure_reason = classifyDispatchFailure(e.receipt ?? "");
  // W-CMDIMPL T0b：reducer 写严格（§5.6/拍板 #10）——派单台账 schema 校验拒写
  //（含 STAGE 词表：stage 基表+custom. 前缀，拍板 #9；drill 标记在 schema 内放行）
  const chk = applyOrgChange("dispatch-entry", e);
  if (!chk.ok) {
    console.error(`[org] ${chk.error}（id=${e.id}）`);
    return false;
  }
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(dispatchLogPath(d), JSON.stringify(e) + "\n", { flag: "a" });
    // #292 cutover 批1 v2：append 后立即触发 StoragePort 导入面——刚 append 的行同步落库
    // （段链语义由 importer 权威执行；不经直写 SQL，避免腐蚀重投段链的冻结终态根行）。
    // 文件保留为审计原始账；checkpoint 与 append 同步推进=库即写源。
    writeDispatchToDb(); // 内部自兜错（文件已写成功=降级安全）
    return true;
  } catch (e2) {
    console.warn(`[org] 台账写入失败: ${e2 instanceof Error ? e2.message : String(e2)}`);
    return false;
  }
}

// 回读：逐行 parse 坏行跳过（仿 loadEvents——追加写被中断的半行不炸读侧）；
// 同 id 去重留最后（append-only 状态机的收敛视图）；返回最后 max 条分单。
// M11-G1 读入口接线（三档；dispatch 域 sqlite 投影=D2 段链收敛行，target 经 member 归因
// 映射值域变化——已知有损映射面备案 read-mode.ts 头注；session-manager 三处消费全经此原点）。
export function readDispatchLog(dir?: string, max = 500): DispatchEntry[] {
  return viaReadMode("dispatch", {
    json: () => {
      const p = dispatchLogPath(dir);
      if (!existsSync(p)) return [];
      const byId = new Map<string, DispatchEntry>();
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t) as DispatchEntry;
          if (typeof e.id === "string" && e.id && typeof e.status === "string") byId.set(e.id, e);
        } catch {
          // 损坏行跳过
        }
      }
      const all = [...byId.values()];
      return all.length <= max ? all : all.slice(all.length - max);
    },
    sqlite: (port) => dispatchEntriesFromDb(port, max),
    dirs: { orgDir: dir },
  });
}

// ---------- #26 M2 分诊 CLI（~/.cc-deck/bin/org，Leader 的指令通道） ----------
// 为什么由 relay 物化而非插件分发：Leader 是 SDK 托管会话，不跑 CLI 插件 hook
//（guard-context 的 deliver 落位机制够不着它）；生产 relay 以独立 bundle 运行、
// 不保证旁边有插件检出——模板内嵌 relay 是唯一「跑到哪带到哪」的形态。单一规范源
// 在此（不再另存插件 bin 副本，防双源漂移）。
const ORG_CLI_TEMPLATE = `#!/bin/bash
# 矩阵式团队分诊 CLI（#26 M2，设计稿 docs/v8-team-matrix.html v3.1 §4）：
# Leader 会话内的分诊指令通道——POST /api/org（token 鉴权循 deliver 先例）。
# Leader 只提案不决议——确认卡 ✓/✗ 由用户在客户端点。
# 用法：
#   org status                                     团队全景：项目组索引/待决确认单/进行中派单
#   org auth-bypass <on|off>                       授权/撤销「跳过权限确认」（生产环境显式跳过放行条件，W-PERMERR）
#   org create <name> <anchor> <轻立项|正经立项>    立项（档位显示名：轻立项=轻量项目、正经立项=正式项目；正经/首次轻 → 用户确认卡；幂等种子防漂移 CLAUDE.md）
#   org set <id> <active|parked|archived> [note]   状态迁移（结项有悬账/未完 → 出确认卡附核对清单）
#   org tier <id> <轻立项|正经立项> <reason>        升降级（必须带一句理由；确认卡；参数为存储档位词）
#   org hold <id|-> <reason> [condition]           建议暂缓（id=- 无组暂缓仅台账；点头即挂起）
#   org dispatch <anchor> <task> [gid] [title] [skills] 派单 worker（无 gid=随手办；有 gid=项目组任务+板联动；skills=逗号分隔技能标签，优先派带标签熟手）
#   org board upsert <gid> <text> [todo|doing|done]
#   org board move <gid> <entry_id> <todo|doing|done>
#   org board del <gid> <entry_id>
#   org detail <id>                                项目组详情：状态/编制/任务板/最近派单回执流
#   org rate <gid> <sid> <good|bad>                熟手评价（M3 路由表；bad=下次派单避开）
#   org tag <gid> <sid> <tag>...                   技能标签（整组替换，空格分隔）
#   org member-retire <gid> <sid> [reason]         成员级退休（编制除名；本组悬账按中断收口，路由档案保留）
#   org member-add <gid> <sid> [role] [engine] [model] [provider]  复拉入编（可覆盖引擎选择）
#   org exp append <text> <kind> [role] [project]  经验申报（W-EXPP1 团队经验库；kind=pitfall|practice|preference|fact|term，role/project 缺省 any/global；term=术语解码条目免自动淘汰）
#   org exp list [status|kind|role|/path]          经验库查询（参数按形状识别：active/retired、五 kind、角色名、锚路径）
#   org exp bump <id>                              经验加权（use_count+1；retired 条目触发复活）
#   org exp retire <id>                            经验淘汰（可恢复，不物理删）
#   org exp restore <id>                           恢复淘汰条目
#   org exp export [path]                          导出经验库备份（全量+计数校验和；缺省 org/exports/experience-<时间戳>.json）
#   org exp import <path>                          导入备份（normKey 合并去重：撞车 bump 不覆盖；坏文件/超 5MB 整单拒绝零写入）
#   org role list                                  岗位模板库查看（内置+用户合并视图，W-KWP1；用户库同 slug 覆盖内置）
#   org role show <slug>                           单岗位模板详情（name/audience/rows 逐行）
#   org rule append <text> [audience] [scope]      立团队规则（W-RULES1；audience=all|leader|role:worker…，scope=team|项目路径，用户直写免卡）
#   org rule list [status] [audience|scope]        规则库查询（active/retired/superseded、all/leader/role:x、team/路径）
#   org rule retire <id>                           规则退役（停注可溯，不物理删）
#   org rule supersede <id> <text> [audience] [scope]  替代（新条入库+旧条停注指新）
#   org rule promote <exp_id> [text] [audience] [scope]  经验升格为规则（复制非搬移，promoted_from 溯源）
# 相对路径 anchor 以当前目录补全（deliver 同口径）。由 relay 物化与升级（ensureOrgCli）。
set -euo pipefail
# 【公司侧反馈 #2·1029】python 探测器：python3 → python → py（Windows Git Bash
# 通常只有 python/py 启动器，裸 python3=command not found）。探测一次全脚本复用。
PY="$(command -v python3 || command -v python || command -v py || true)"
if [ -z "$PY" ]; then
  echo "未找到 python（依次尝试过 python3 / python / py 都不在 PATH）——请安装 Python 3：https://www.python.org/downloads/（Windows 安装时勾选 Add python.exe to PATH）后重开终端重试" >&2
  exit 1
fi
# 【公司侧反馈 #1·1029】Git Bash/MSYS 环境检测——/d/code 形态的路径需转 D:/code
# 才能被 relay 侧 Node fs 识别（Node 不认 MSYS 虚拟根）。ORG_TEST_GITBASH=1 为
# 测试注入口（非 Windows 机器强制开转换分支验证）。
WIN_GITBASH=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WIN_GITBASH=1 ;; esac
[ "\${ORG_TEST_GITBASH:-0}" = "1" ] && WIN_GITBASH=1
# 冲刺 F-09：CCR_DATA_DIR/CCR_PORT/CCR_TOKEN 环境覆盖（沙盒/多实例隔离）。
# Leader 会话由 relay spawn，经 childEnv 继承 relay 的 CCR_* —— 沙盒 relay 拉起的
# Leader 调本 CLI 自动打到沙盒；生产无这些 env 时行为与旧版逐字节一致。
data="\${CCR_DATA_DIR:-\$HOME/.cc-deck/data}"
token="\${CCR_TOKEN:-\$(cat "\$data/token" 2>/dev/null || true)}"
[ -z "$token" ] && { echo "未找到 token（\$data/token 或环境变量 CCR_TOKEN，relay 未初始化？）" >&2; exit 1; }
port="\${CCR_PORT:-\$("$PY" -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "\$data/bridge.json" 2>/dev/null || true)}"
: "\${port:=8787}"

action="\${1:-}"
[ -z "$action" ] && { sed -n '3,33p' "$0" | sed 's/^# //' >&2; exit 1; }
shift || true

abs() {
  # 【公司侧反馈 #1·1029】anchor 三形态归一化：D:\\code\\x / D:/code/x 原样（Node
  # win32 直接可用）；Git Bash 的 /d/code/x → D:/code/x（MSYS 虚拟根 Node 不认，
  # 仅 WIN_GITBASH=1 时转——真 POSIX 机器 /d/... 是合法绝对路径零变化）；相对路径
  # 先补 $PWD（Git Bash 下 PWD 常为 /d/ 形态，补全后过同一转换）。
  local p="$1" d
  case "$p" in
    [A-Za-z]:[\\\\/]*) printf '%s' "$p"; return 0 ;;
    /*) : ;;
    *) p="$PWD/$p" ;;
  esac
  if [ "$WIN_GITBASH" = "1" ]; then
    case "$p" in
      /[A-Za-z]/*)
        d="\$(printf '%s' "\${p:1:1}" | tr 'a-z' 'A-Z')"
        printf '%s:/%s' "\$d" "\${p:3}"
        return 0
        ;;
    esac
  fi
  printf '%s' "$p"
}

case "$action" in
  status)
    body="$("$PY" -c 'import json;print(json.dumps({"action":"status"},ensure_ascii=False))')"
    ;;
  auth-bypass)
    # W-PERMERR：用户明示授权「跳过权限确认」写入口（on=授权/off=撤销；撤销即收回）
    [ $# -ge 1 ] || { echo "用法: org auth-bypass <on|off>   授权/撤销「跳过权限确认」（生产环境显式跳过的放行条件）" >&2; exit 1; }
    case "$1" in
      on|off) ;;
      *) echo "用法: org auth-bypass <on|off>" >&2; exit 1 ;;
    esac
    body="$("$PY" -c 'import json,sys;print(json.dumps({"action":"auth-bypass","on":sys.argv[1]=="on"},ensure_ascii=False))' "$1")"
    ;;
  create)
    [ $# -ge 3 ] || { echo "用法: org create <name> <anchor> <轻立项|正经立项>" >&2; exit 1; }
    a2="$(abs "$2")"
    body="$("$PY" - "$1" "$a2" "$3" <<'PY'
import json, sys
print(json.dumps({"action":"project-create","name":sys.argv[1],"anchor":sys.argv[2],"tier":sys.argv[3]},ensure_ascii=False))
PY
)"
    ;;
  set)
    [ $# -ge 2 ] || { echo "用法: org set <id> <active|parked|archived> [note]" >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
d={"action":"project-status","id":sys.argv[1],"to":sys.argv[2]}
if len(sys.argv)>3: d["note"]=sys.argv[3]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  tier)
    [ $# -ge 3 ] || { echo "用法: org tier <id> <轻立项|正经立项> <reason>" >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
print(json.dumps({"action":"project-tier","id":sys.argv[1],"to":sys.argv[2],"reason":sys.argv[3]},ensure_ascii=False))
PY
)"
    ;;
  hold)
    [ $# -ge 2 ] || { echo "用法: org hold <id|-> <reason> [condition]" >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
gid="" if sys.argv[1]=="-" else sys.argv[1]
d={"action":"suggest-hold","reason":sys.argv[2]}
if gid: d["id"]=gid
if len(sys.argv)>3: d["condition"]=sys.argv[3]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  dispatch)
    [ $# -ge 2 ] || { echo "用法: org dispatch <anchor> <task> [gid] [title] [skills]" >&2; exit 1; }
    anchor="$(abs "$1")"; shift
    task="$1"; shift || true
    gid=""; title=""; skills=""
    if [ $# -ge 1 ]; then gid="$1"; shift || true; fi
    if [ $# -ge 1 ]; then title="$1"; shift || true; fi
    if [ $# -ge 1 ]; then skills="$1"; shift || true; fi
    body="$("$PY" - "$anchor" "$task" "$gid" "$title" "$skills" <<'PY'
import json, sys
d={"action":"dispatch","anchor":sys.argv[1],"prompt":sys.argv[2]}
if sys.argv[3]: d["gid"]=sys.argv[3]
if sys.argv[4]: d["title"]=sys.argv[4]
if sys.argv[5]: d["skills"]=[t.strip() for t in sys.argv[5].split(",") if t.strip()]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  board)
    [ $# -ge 3 ] || { echo "用法: org board upsert|move|del <gid> <text|entry_id> [status]" >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
op, gid = sys.argv[1], sys.argv[2]
d={"action":"board","op":op,"gid":gid}
if op=="upsert":
    d["text"]=sys.argv[3]
    if len(sys.argv)>4: d["status"]=sys.argv[4]
else:
    d["entry_id"]=sys.argv[3]
    if len(sys.argv)>4: d["status"]=sys.argv[4]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  detail)
    [ $# -ge 1 ] || { echo "用法: org detail <id>" >&2; exit 1; }
    body="$("$PY" - "$1" <<'PY'
import json, sys
print(json.dumps({"action":"project-detail","id":sys.argv[1]},ensure_ascii=False))
PY
)"
    ;;
  rate)
    [ $# -ge 3 ] || { echo "用法: org rate <gid> <sid> <good|bad>" >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
print(json.dumps({"action":"rate","gid":sys.argv[1],"sid":sys.argv[2],"rating":sys.argv[3]},ensure_ascii=False))
PY
)"
    ;;
  tag)
    [ $# -ge 3 ] || { echo "用法: org tag <gid> <sid> <tag>..." >&2; exit 1; }
    body="$("$PY" - "$@" <<'PY'
import json, sys
print(json.dumps({"action":"tag","gid":sys.argv[1],"sid":sys.argv[2],"tags":sys.argv[3:]},ensure_ascii=False))
PY
)"
    ;;
  member-retire)
    [ $# -ge 2 ] || { echo "用法: org member-retire <gid> <sid> [reason]" >&2; exit 1; }
    reason="\${3:-}"
    body="$("$PY" - "$1" "$2" "$reason" <<'PY'
import json, sys
d={"action":"member-retire","gid":sys.argv[1],"sid":sys.argv[2]}
if sys.argv[3]: d["reason"]=sys.argv[3]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  member-add)
    [ $# -ge 2 ] || { echo "用法: org member-add <gid> <sid> [role] [engine] [model] [provider]" >&2; exit 1; }
    role="\${3:-worker}"
    engine="\${4:-}"
    model="\${5:-}"
    provider="\${6:-}"
    body="$("$PY" - "$1" "$2" "$role" "$engine" "$model" "$provider" <<'PY'
import json, sys
d={"action":"member-add","gid":sys.argv[1],"sid":sys.argv[2],"role":sys.argv[3]}
if sys.argv[4]: d["engine"]=sys.argv[4]
if sys.argv[5]: d["model"]=sys.argv[5]
if sys.argv[6]: d["provider"]=sys.argv[6]
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  exp)
    # W-EXPP1 团队经验库（~/.cc-deck/org/experience.json）：append/list/bump/retire/restore
    [ $# -ge 1 ] || { echo "用法: org exp append|list|bump|retire|restore ..." >&2; exit 1; }
    op="$1"; shift
    body="$("$PY" - "$op" "$@" <<'PY'
import json, sys
op = sys.argv[1]
args = sys.argv[2:]
if op == "append":
    if len(args) < 2:
        print("用法: org exp append <text> <kind> [role] [project]", file=sys.stderr); sys.exit(1)
    d={"action":"exp-append","text":args[0],"kind":args[1]}
    if len(args)>2 and args[2]: d["role_scope"]=args[2]
    if len(args)>3 and args[3]: d["project_scope"]=args[3]
elif op == "list":
    d={"action":"exp-list"}
    for a in args:
        if a in ("active","retired"): d["status"]=a
        elif a in ("pitfall","practice","preference","fact","term"): d["kind"]=a
        elif a.startswith("/"): d["project"]=a
        else: d["role"]=a
elif op == "export":
    d={"action":"exp-export"}
    if args and args[0]: d["path"]=args[0]
elif op == "import":
    if not args:
        print("用法: org exp import <导出文件路径>", file=sys.stderr); sys.exit(1)
    d={"action":"exp-import","path":args[0]}
elif op in ("bump","retire","restore"):
    if len(args) < 1:
        print("用法: org exp "+op+" <id>", file=sys.stderr); sys.exit(1)
    d={"action":"exp-"+op,"id":args[0]}
else:
    print("未知 exp 子命令: "+op, file=sys.stderr); sys.exit(1)
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  role)
    # W-KWP1 岗位模板库只读查看（写面 P2：模板编辑走手编 org/role-templates.json）
    [ $# -ge 1 ] || { echo "用法: org role list|show ..." >&2; exit 1; }
    op="$1"; shift
    body="$("$PY" - "$op" "$@" <<'PY'
import json, sys
op = sys.argv[1]
args = sys.argv[2:]
if op == "list":
    d={"action":"role-list"}
elif op == "show":
    if not args:
        print("用法: org role show <slug>", file=sys.stderr); sys.exit(1)
    d={"action":"role-show","slug":args[0]}
else:
    print("未知 role 子命令: "+op, file=sys.stderr); sys.exit(1)
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  rule)
    # W-RULES1 团队规则库（~/.cc-deck/org/rules.json）：append 直写带 direct 标记
    #（用户 CLI 主权面免卡；agent 提案走无 direct 的 HTTP 面出确认卡）。
    # audience: all|leader|role:worker|role:pm|role:team_pm|role:review|role:review_pm
    # scope: team | 项目目录路径（相对路径按当前目录补全）
    [ $# -ge 1 ] || { echo "用法: org rule append|list|retire|supersede|promote ..." >&2; exit 1; }
    op="$1"; shift
    body="$("$PY" - "$op" "$@" <<'PY'
import json, sys, os
op = sys.argv[1]
args = sys.argv[2:]
def aud(v):
    return v.lower() if v else ""
def scope(v):
    if not v:
        return ""
    if v == "team":
        return "team"
    if v.startswith("project:"):
        return v
    if v.startswith("/"):
        return "project:" + v.rstrip("/")
    return "project:" + os.path.abspath(v).rstrip("/")
if op == "append":
    if len(args) < 1:
        print("用法: org rule append <text> [audience] [scope]", file=sys.stderr); sys.exit(1)
    d={"action":"rule-append","text":args[0],"direct":True,"created_by":"user"}
    if len(args)>1 and args[1]: d["audience"]=aud(args[1])
    if len(args)>2 and args[2]: d["scope"]=scope(args[2])
elif op == "list":
    d={"action":"rule-list"}
    for a in args:
        if a in ("active","retired","superseded"): d["status"]=a
        elif a=="team" or a.startswith("project:") or a.startswith("/"): d["scope"]=scope(a)
        else: d["audience"]=aud(a)
elif op == "retire":
    if len(args) < 1:
        print("用法: org rule retire <id>", file=sys.stderr); sys.exit(1)
    d={"action":"rule-retire","id":args[0]}
elif op == "supersede":
    if len(args) < 2:
        print("用法: org rule supersede <旧id> <新text> [audience] [scope]", file=sys.stderr); sys.exit(1)
    d={"action":"rule-supersede","id":args[0],"text":args[1],"created_by":"user"}
    if len(args)>2 and args[2]: d["audience"]=aud(args[2])
    if len(args)>3 and args[3]: d["scope"]=scope(args[3])
elif op == "promote":
    if len(args) < 1:
        print("用法: org rule promote <经验id> [text] [audience] [scope]", file=sys.stderr); sys.exit(1)
    d={"action":"exp-promote","id":args[0],"created_by":"user"}
    if len(args)>1 and args[1]: d["text"]=args[1]
    if len(args)>2 and args[2]: d["audience"]=aud(args[2])
    if len(args)>3 and args[3]: d["scope"]=scope(args[3])
else:
    print("未知 rule 子命令: "+op, file=sys.stderr); sys.exit(1)
print(json.dumps(d,ensure_ascii=False))
PY
)"
    ;;
  *)
    echo "未知子命令: $action" >&2; exit 1
    ;;
esac

exec curl -sS -X POST "http://127.0.0.1:\${port}/api/org?token=\${token}" -H 'content-type: application/json' --data-binary "$body"
`;

// 物化 ~/.cc-deck/bin/org（内容比对幂等；CCR_ORG_BIN_DIR 显式改落点便于测试，
// CCR_ORG_DIR 覆盖态=测试沙盒，不碰用户家目录）。失败静默——CLI 丢了可重跑补。
export function ensureOrgCli(): string | null {
  const target =
    process.env.CCR_ORG_BIN_DIR ??
    (process.env.CCR_ORG_DIR ? null : join(homedir(), ".cc-deck", "bin", "org"));
  if (!target) return null;
  try {
    let cur = "";
    try {
      cur = readFileSync(target, "utf-8");
    } catch {}
    if (cur === ORG_CLI_TEMPLATE) return target;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, ORG_CLI_TEMPLATE, "utf-8");
    chmodSync(target, 0o755);
    return target;
  } catch (e) {
    console.warn(`[org] 分诊 CLI 物化失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
