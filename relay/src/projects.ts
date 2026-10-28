// #26 矩阵式团队 M2 —— 项目组（project_group）底座：索引 / 跨会话任务板 / 确认单 / 三态状态机。
// 设计稿 docs/v8-team-matrix.html v3.1 §6.1 §6.2 §4：项目组 = 动态层编制单位（锚点目录 + 三态 +
// 编制快照 + 任务板引用）；板 store 为 M2 待建件——现有任务链路严格按 CLI 会话目录隔离
//（task-store.ts），团队协作需要一份所有人共用的项目组级板（单一事实源建 org 侧）。
// 本模块是纯 fs 读写底座，与 org.ts 同范式：不 import session-manager/EventBus（无环）、
// 不走 EventBus 持久化路径（启动时被 compactEvents 整文件重写，破坏审计语义——org.ts 三物理
// 事实同款红线）、坏 JSON 一律容忍为空态（读侧防御，绝不抛）。
//
// 物理布局（org 目录 = 组织资产家，projects 属组织资产）：
//   <orgDir>/projects.json           项目组索引（写穿全量，含分诊信任态）
//   <orgDir>/boards/<gid>.json       项目组任务板（一板一文件）
//   <orgDir>/confirms.json           组织确认单队列（正经立项/升降级/建议暂缓/结项/复活）
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, posix, win32 } from "node:path";
import { orgDir, readDispatchLog } from "./org.js";
import { appendJournal, atomicWriteJson, lastGoodJournalSnapshot } from "./fs-safe.js";
import { applyOrgChange } from "./org-schema.js";
// #26 M3 挂起自动化活度口径需要路由表（熟手最近收工）；routing 只 import org，无环
import { routingFor } from "./routing.js";
import { withOrgWriteTx } from "./storage/org-write-tx.js";
import { viaReadMode, projectGroupsFromDb, orgConfirmsFromDb } from "./storage/read-mode.js";
import type { DutyPolicy } from "./leader-duty.js";
import type { SessionEngine } from "./types.js";

// ---------- 类型 ----------

export type ProjectGroupStatus = "pending" | "active" | "parked" | "archived";
export type ProjectTier = "轻立项" | "正经立项";

export interface ProjectHeadcountEntry {
  session_id: string;
  role: string;
  /** W-UIPOLISH3 件十⑤（2026-10-11 用户拍板）：可选别名——成员卡显示名优先 nick
   * （名称与角色解耦：有别名=别名为主角色降小字，无别名=名称即会话题名现状）。
   * role 保持自由文本不建枚举；存量成员不迁移（缺省=无别名显示不回退）。 */
  nick?: string;
  engine?: SessionEngine;
  model?: string;
  provider?: string;
}

export interface ProjectRoleDefault {
  engine?: SessionEngine;
  model?: string;
  provider?: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  /** 项目锚点目录（cwd 硬规则的物理地基，绝对路径；worker spawn 与记忆归层都锚它） */
  anchor_dir: string;
  status: ProjectGroupStatus;
  tier: ProjectTier;
  /** 编制快照（M2 形态 = 1 worker + Leader 兼管；升降级只补不重建） */
  headcount: ProjectHeadcountEntry[];
  role_defaults?: Record<string, ProjectRoleDefault>;
  /** 轻立项 = 任务板单卡简化态（渲染降级标记，非独立模型） */
  single_card: boolean;
  created_at: number;
  updated_at: number;
  parked_at?: number;
  archived_at?: number;
  /** 结项一句话归档（零异常时）或被否决说明 */
  archive_note?: string;
  /** #26 M3 挂起自动化：上次出建议暂缓单的时刻（手动/触发器同戳）——否决冷却
   * 起算点，触发器在窗口期内不重复叨扰 */
  hold_suggested_at?: number;
  /** P71 组级值守策略（019 §6.3/§6.5 拍板）：enabled=false=该组不进值守 feed
   * （§6.1 层级语义「当前组不进入值守 feed，但普通 worker/事实源继续运行」）；
   * 缺省（键缺席/undefined）=开——与 evaluateDutyPolicy 的 enabled===false 才拦
   * 同语义，「已有显式 false 的组不被迁移覆盖」。其余字段（allowed_playbooks/
   * 预算/unknown_risk/auto_dispatch_enabled）存储先落，消费面属 D2 自动派活续批。
   * 全局总闸 plugin_config.duty（plugin-config.ts）关=压倒组级开（两级同开才生效）。 */
  duty_policy?: DutyPolicy;
  /** P81-5 混编标记（B4 债落库）：true=组内多引擎混编→派单 policy_source 走
   * mixed_team_default（§5.3.1 混编新卡缺省请求服务端物化 bypassPermissions）；
   * 缺省/false=普通组走 tier_default。立项入参可标；改标走组编辑面（后续单）。 */
  mixed_engine?: boolean;
  /** P0 编制上限（2026-10-15 用户实锤「编制膨胀」）：本组泛 worker 席位上限（组级
   * 覆盖；缺省走全局 maxHeadcountWorkers）。命名角色不计入。触顶后派单复用空闲
   * worker（idle 最久优先），全忙排队不自动扩编——见 session-manager dispatchWorker。
   * 缺席/undefined=用全局缺省；显式数字（>0）覆盖。 */
  headcount_cap?: number;
}

// 板状态五态词表（D18，freeze v2-m10-freeze §1.2 逐字）：backlog 待认领 / claimed
// 进行中 / submitted 完成候选待复核 / ready_to_install 待装机 / done 完成收口。
// 迁移一次完成三态→五态：todo→backlog、doing→claimed、done→done 就近映射，不保留
// 旧态（loadBoardFile 读入惰性迁移+冷备份 .pre-d18.json）。submitted 仅由完成候选
// 且 review_required=1 生成（upsert/move 双入口同规则，见两函数头注）；ready_to_install
// 无存量自动生成，只走显式搬卡。旧注「五段色属废弃 V5~V7 词表」口径由 2026-10-06
// 用户拍板⑤排期项推翻，本词表为新权威（旧三态 todo/doing 词表外值读入即迁移）。
export type BoardEntryStatus = "backlog" | "claimed" | "submitted" | "ready_to_install" | "done";

/** D18 词表运行时值（orgAction board 校验面/测试件静态锚共用单点，勿散写字面量）。
 *  W-CMDIMPL T0b：权威定义上移 org-schema.ts（reducer 校验层，依赖单向），此处
 *  re-export 兼容既有消费面——语义不变。 */
export { BOARD_ENTRY_STATUSES } from "./org-schema.js";
export { BOARD_PRIORITIES } from "./org-schema.js"; // #G3 优先级词表（权威 org-schema，re-export 兼容消费面）
import { BOARD_ENTRY_STATUSES } from "./org-schema.js";

export interface BoardEntry {
  id: string;
  text: string;
  status: BoardEntryStatus;
  /** 承接会话（派单联动条目 = worker relay session id） */
  owner_session?: string;
  /** 派单联动条目的台账 id（dispatch 收口时自动搬卡） */
  dispatch_id?: string;
  ts: number;
  updated_at: number;
  note?: string;
  /** D18：完成候选复核资格位（true=done 请求落 submitted 的唯一资格）。由显式
   * upsert 入参设置；submitted→done 复核闭环时清除；迁移无存量（五态迁移不产该位）。 */
  review_required?: boolean;
  /** #087 beads 思想采纳（009 §5 裁决，M1 字段）：依赖卡 id 引用——依赖全 done 才可派
   *（computeReady 判定；坏引用容错按未就绪处理不炸） */
  depends_on?: string[];
  /** W-UIPOLISH3 件十九（2026-10-11 用户追加）：泳道迁移时间线——每次状态落定追加一行
   * {status, ts}（新建含首道；append-only 不回改）。历史条目无此字段=时间线从当下起记。 */
  transitions?: { status: BoardEntryStatus; ts: number }[];
  /** beads gate 思想（009 §2/§5：CI/定时/外部等待映射 blocked）：字段在场=blocked 可判定。
   * 红线：无自动放行/关闭路径——清除只能由人显式 upsert（gate:null），确认卡仍是用户决策唯一写面 */
  gate?: { reason: string; opened_at: number };
  /** #G3 板卡富模型：优先级三档（P0/P1/P2，对标 multica）——缺省=未标注；词表权威
   *  org-schema BOARD_PRIORITIES（本文件 re-export），派单透传同源 */
  priority?: string;
  /** #G3 父子链：父卡 id 引用——子任务在 web 板面同泳道折叠挂靠（跨泳道/坏引用=
   *  孤儿容错平铺，depends_on 同口径不炸）。单父无环由调用侧保证（upsert 不查环） */
  parent_id?: string;
}

/** #087 经验回流（009 §4 M2）：board lessons 分区——收口回执写入，任务书按 tag 筛选
 * 注入的下一步消费留出口（本批只落存储+查询，注入接线不做）。语义对齐 009 §2：
 * lessons 语义由 cc-deck 定义，不把经验散落到外部 memory */
export interface LessonEntry {
  id: string;
  text: string;
  /** 项目/角色/引擎 tag（筛选键，AND 语义） */
  tags: string[];
  ts: number;
  /** 来源派单台账 id（可回溯到收口回执） */
  source_dispatch_id?: string;
}

export interface ProjectBoard {
  gid: string;
  entries: BoardEntry[];
  /** #087 lessons 分区（经验回流，append-only 语义：只增不删，量大了再议归档） */
  lessons?: LessonEntry[];
  /** 挂起/结项 = 冻结只读（active 才可写，§2.2 任务板冻结保留） */
  frozen: boolean;
  updated_at: number;
}

export type ConfirmKind =
  | "project-create" // 正经立项必须确认（防误判档烧钱）
  | "tier-change" // 升降级（一句理由 + 增量编制/验收点）
  | "suggest-hold" // 第五态建议暂缓（一句理由 + 触发条件，点头即挂起）
  | "archive" // 结项（附断言核对清单）
  | "revive" // 复活边（读档重建）
  // W-RULES1（2026-10-11）：团队规则提案（拍板 verdict-rules-20261011 #7 安全面——agent
  // 文本永不直入权威通道：orgAction rule-append 缺省出本卡，用户 ✓ 才真正入 rules.json；
  // payload 携带规则草稿 text/audience/scope/created_by，决议副作用在
  // applyConfirmEffects case "rule-append" 落库并回链 confirm_id
  | "rule-append";

export interface OrgConfirm {
  id: string;
  kind: ConfirmKind;
  title: string;
  /** 一句理由（分诊概率判断的矫正通道都走理由 + 确认） */
  reason: string;
  /** kind 专属载荷：gid / to_tier / increment / checklist 等 */
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  decided_at?: number;
  decided_by?: string;
}

interface ProjectsFile {
  groups: ProjectGroup[];
  /** 轻立项同类免确认的信任态（首次确认一次，信任累积——§4 确认门槛） */
  trust_light: boolean;
}

// ---------- 路径 ----------

function projectsFilePath(dir?: string): string {
  return join(dir ?? orgDir(), "projects.json");
}
function boardsDirPath(dir?: string): string {
  return join(dir ?? orgDir(), "boards");
}
function boardFilePath(gid: string, dir?: string): string {
  return join(boardsDirPath(dir), `${gid}.json`);
}
function confirmsFilePath(dir?: string): string {
  return join(dir ?? orgDir(), "confirms.json");
}

// ---------- 项目组索引 ----------

// W-CMDIMPL T0a（#216，设计 §5.3 案甲第三件）：坏 JSON 拒绝空态写回——只读模式。
// 原状：坏 JSON 静默返回空组表，下一个写操作就以空表+新组写回 = 整库物理丢失且不可
// 恢复（boards 有 journal 可回放，projects 三无）。现：坏文件 → 只读模式（写侧拒绝）
// + journal 回放自动恢复；恢复成功清除只读，失败保持只读等人工处置。
let projectsReadOnly = false;
export function isProjectsReadOnly(): boolean {
  return projectsReadOnly;
}


/** #292-B2 写口锁内直读（json 真相源，完整 T0a 语义）：withOrgWriteTx 的 fn 内**必须**
 * 走本函数——readProjectsFile（viaReadMode）在 sqlite 档触发 ensureStore→
 * importAllForShadow，org 重扫联动自持 begin 嵌套写锁事务=「cannot start a
 * transaction within a transaction」，且 viaReadMode 会把该错吞成失实的「sqlite
 * 不可用降级」横幅+degradationNotified 永久静音真实降级告警（A 路审查 P1-1 探针
 * 实证）。锁内文件=最新（锁外写口已串行化）。
 * 坏文件不裸抛（A 路审查 P1-2：裸异常穿透调用面+绕过 T0a 防线）——与 io.json 分支
 * 同语义：journal 回放重建，回放失败置只读闸返回空态（写侧 writeProjectsFile 的
 * 只读闸随后拒写，调用面收 {ok:false} 不收异常）。 */
function readProjectsFileJson(dir?: string): ProjectsFile {
  try {
    const raw = JSON.parse(readFileSync(projectsFilePath(dir), "utf-8")) as Partial<ProjectsFile>;
    projectsReadOnly = false;
    return {
      groups: Array.isArray(raw.groups) ? (raw.groups as ProjectGroup[]) : [],
      trust_light: raw.trust_light === true,
    };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ENOENT") return { groups: [], trust_light: false };
    console.error(`[projects] 索引文件损坏（写口直读），进入只读模式并尝试 journal 回放: ${e instanceof Error ? e.message : String(e)}`);
    const recovered = recoverProjectsFromJournal(dir);
    if (recovered) {
      console.error(`[projects] journal 回放成功，索引已重建（含 ${recovered.groups.length} 组），只读解除`);
      return recovered;
    }
    projectsReadOnly = true;
    console.error(`[projects] journal 回放失败——保持只读模式，写操作将拒绝（人工处置前不覆盖损坏文件）`);
    return { groups: [], trust_light: false };
  }
}
function readConfirmsJson(dir?: string): OrgConfirm[] {
  try {
    const raw = JSON.parse(readFileSync(confirmsFilePath(dir), "utf-8")) as { confirms?: OrgConfirm[] };
    return Array.isArray(raw.confirms) ? raw.confirms : [];
  } catch {
    return [];
  }
}
function readProjectsFile(dir?: string): ProjectsFile {
  // M11-G1 读入口接线（三档：json 原样 / sqlite 表投影 / shadow 返回值以 JSON 为准+旁路对比）
  return viaReadMode("group", {
    json: () => {
      try {
        const raw = JSON.parse(readFileSync(projectsFilePath(dir), "utf-8")) as Partial<ProjectsFile>;
        // T0a：读到好文件 = 人工已修复（或本轮回放已重建）——自动解除只读
        projectsReadOnly = false;
        return {
          groups: Array.isArray(raw.groups) ? (raw.groups as ProjectGroup[]) : [],
          trust_light: raw.trust_light === true,
        };
      } catch (e) {
        // W-CMDIMPL T0a：无文件=首建空态（正常）；坏 JSON（SyntaxError 类）=走进只读+
        // 回放，绝不静默空态（下一个写会把空表写回=整库丢失）
        const code = (e as { code?: string })?.code;
        if (code === "ENOENT") return { groups: [], trust_light: false };
        console.error(`[projects] 索引文件损坏，进入只读模式并尝试 journal 回放: ${e instanceof Error ? e.message : String(e)}`);
        const recovered = recoverProjectsFromJournal(dir);
        if (recovered) {
          console.error(`[projects] journal 回放成功，索引已重建（含 ${recovered.groups.length} 组），只读解除`);
          return recovered;
        }
        projectsReadOnly = true;
        console.error(`[projects] journal 回放失败——保持只读模式，写操作将拒绝（人工处置前不覆盖损坏文件）`);
        return { groups: [], trust_light: false };
      }
    },
    // trust_light 无表列——投影缺省 false（已知限制，备案 read-mode.ts 头注「有损映射面」）
    sqlite: (port) => ({ groups: projectGroupsFromDb(port), trust_light: false }),
    dirs: { orgDir: dir },
  });
}

/** T0a 第三件恢复面：坏 projects.json → 从 projects-journal.ndjson 最近好快照重建。
 *  重建走原子写（journal 最后好态 → projects.json），失败返回 null。 */
function recoverProjectsFromJournal(dir?: string): ProjectsFile | null {
  try {
    const d = dir ?? orgDir();
    const snap = lastGoodJournalSnapshot(join(d, "projects-journal.ndjson"));
    if (!snap || typeof snap !== "object") return null;
    const cand = snap as Partial<ProjectsFile>;
    if (!Array.isArray(cand.groups)) return null;
    const f: ProjectsFile = { groups: cand.groups as ProjectGroup[], trust_light: cand.trust_light === true };
    if (writeProjectsFile(f, dir)) return f; // 写成功才清除只读（writeProjectsFile 内部只读闸此时未触发——恢复路径直通原子写）
    return null;
  } catch (e) {
    console.error(`[projects] journal 回放异常: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function writeProjectsFile(f: ProjectsFile, dir?: string): boolean {
  // T0a：只读闸（坏文件未恢复期间拒绝一切写——防空态覆盖损坏文件）
  if (projectsReadOnly) {
    console.error(`[projects] 只读模式中，拒绝索引写入（坏文件人工处置或 journal 回放成功前不覆盖）`);
    return false;
  }
  const d = dir ?? orgDir();
  // T0a 第二件：变更进 journal（append-only，先于主写——主写失败 journal 也留痕）。
  // 行含全量快照（回放重建的最小充分数据）；首字段 ts/kind 供审计与未来分类。
  appendJournal(join(d, "projects-journal.ndjson"), {
    ts: Date.now(),
    kind: "projects",
    groups_n: Array.isArray(f.groups) ? f.groups.length : -1,
    trust_light: f.trust_light === true,
    snapshot: f,
  });
  // T0a 第一件：tmp+rename 原子写（消除崩溃半写窗口；同目录 rename = POSIX 原子）
  return atomicWriteJson(projectsFilePath(d), JSON.stringify(f, null, 2) + "\n");
}

export function listGroups(dir?: string): ProjectGroup[] {
  return readProjectsFile(dir).groups;
}

// P0 板持久信道（夜审 B2-F1，2026-10-14）：全部板当前盘态快照——随 SNAPSHOT 下发，
// 断连端重连即全量追平（BOARD_UPDATED 走 emitTransient 不补发，板此前不随快照 →
// 断连窗口板变更全丢、重连永久陈旧，唯一恢复=重启 App 的用户实证根除）。
// 口径：①lessons 摘除形态与 emitBoard outBoard 同款（W-EXPP1 域退役，防存量文件
// 回流）；②loadBoardFile null（读失败半态）跳过不进快照（P3-2 同口径：半态不得
// 经快照扩散）；③体积守卫：全量总字节超 512KB 时弃发（boards 缺省=旧 relay 形态，
// 端上自动回退 detail 按需拉；当前实测 3 板 42KB=LAN 快照 4MB 预算的 1%，千卡
// 级团队仍 <300KB，守卫为极端规模兜底）。
const SNAPSHOT_BOARDS_MAX_BYTES = 512 * 1024;
/** null=守卫弃发（端上 boards 键缺席=旧 relay 形态，回退 detail 按需拉）——与「真
 * 0 板」的空数组严格区分：空数组也下发是能力位语义（端上锚定空库），守卫弃发不
 * 得清端上已有缓存。 */
export function listBoards(dir?: string): ProjectBoard[] | null {
  const out: ProjectBoard[] = [];
  let total = 0;
  for (const g of listGroups(dir)) {
    const b = loadBoardFile(g.id, dir);
    if (!b) continue;
    const shaped = b.lessons?.length ? { ...b, lessons: [] } : b;
    total += JSON.stringify(shaped).length;
    if (total > SNAPSHOT_BOARDS_MAX_BYTES) {
      console.warn(`[board-persist] 板全量超 ${SNAPSHOT_BOARDS_MAX_BYTES}B 守卫，SNAPSHOT 不带 boards（端上回退按需拉）`);
      return null;
    }
    out.push(shaped);
  }
  return out;
}

export function listGroupsByStatus(dir?: string): { active: ProjectGroup[]; parked: ProjectGroup[]; archived: ProjectGroup[]; pending: ProjectGroup[] } {
  const g = listGroups(dir);
  const pick = (s: ProjectGroupStatus) => g.filter((x) => x.status === s);
  return { active: pick("active"), parked: pick("parked"), archived: pick("archived"), pending: pick("pending") };
}

export function findGroup(idOrName: string, dir?: string): ProjectGroup | null {
  const g = listGroups(dir);
  return g.find((x) => x.id === idOrName || x.name === idOrName) ?? null;
}

export function findGroupByAnchor(anchorDir: string, dir?: string): ProjectGroup | null {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return listGroups(dir).find((x) => norm(x.anchor_dir) === norm(anchorDir) && x.status !== "archived") ?? null;
}

export function isLightConfirmTrusted(dir?: string): boolean {
  return readProjectsFile(dir).trust_light;
}

/** 并行项目组上限护栏（活跃台账天然小表——§4 护栏；env 可覆盖便于测试） */
export function maxActiveGroups(): number {
  const n = Number(process.env.CCR_ORG_MAX_GROUPS);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// ---------- P0 编制上限与裁剪（2026-10-15 用户实锤「编制膨胀」） ----------
//
// 膨胀根源（1015 实况：CC Deck 组 69 席 = 4 命名 + 65 泛 worker）：gid 派单在
// pickVeteran 不中时恒新会话 + addMember 无闸追加，从不清退；且路由记录只在派单
// 收口（done/failed）时写——被中断/未收口的 worker 无路由记录，永久不在熟手复用池，
// 每单必新开。三件根修：①上限闸（本节）②触顶复用+排队（session-manager）③裁剪
// （planHeadcountTrim 纯函数 + session-manager 编排）。

/** 泛 worker 全局缺省席位上限：env CCR_ORG_HEADCOUNT_CAP 可覆盖（测试便利，与
 * maxActiveGroups 同范式）；缺省 15（2026-10-15 派单任务书建议值）。 */
export function maxHeadcountWorkers(): number {
  const n = Number(process.env.CCR_ORG_HEADCOUNT_CAP);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** 组生效席位上限：组级 headcount_cap 显式覆盖 > 全局缺省。单点（派单闸/addMember
 * 闸/审计面对账共用，勿散写）。 */
export function headcountCapOf(g: Pick<ProjectGroup, "headcount_cap">): number {
  if (typeof g.headcount_cap === "number" && g.headcount_cap > 0) return g.headcount_cap;
  return maxHeadcountWorkers();
}

/** 泛 worker 计数（cap 口径）：role === "worker"（泛称缺省）才计入——命名角色是显式
 * 任命（岗位语义），不占泛用席位、不受上限惩罚。 */
export function genericWorkerCount(headcount: ProjectHeadcountEntry[]): number {
  return headcount.filter((h) => (h.role || "worker") === "worker").length;
}

/** 裁剪计划纯函数（规则顺序即优先级，逐条可判）：
 * ①命名角色恒保（显式任命不自动裁）②会话存活中保（isLiveSession——编排侧口径=
 * 在册且忙碌/近期有动静，纯历史卡不算存活）③24h 内有活动保（lastActiveOf 由编排
 * 侧聚合 routing/台账/会话三路取最大）④其余裁（出编制不删会话：路由档案/历史卡
 * 原样保留，复拉走 member-add 再入编）。now/keepIdleMs 注入=单测同判定。 */
export interface HeadcountTrimPlan {
  keep: ProjectHeadcountEntry[];
  trimmed: { entry: ProjectHeadcountEntry; reason: string }[];
}

export function planHeadcountTrim(input: {
  headcount: ProjectHeadcountEntry[];
  isLiveSession: (sid: string) => boolean;
  lastActiveOf: (sid: string) => number;
  now: number;
  keepIdleMs?: number;
}): HeadcountTrimPlan {
  const keepMs = input.keepIdleMs ?? 24 * 3_600_000;
  const keep: ProjectHeadcountEntry[] = [];
  const trimmed: { entry: ProjectHeadcountEntry; reason: string }[] = [];
  for (const entry of input.headcount) {
    const role = entry.role || "worker";
    if (role !== "worker") { keep.push(entry); continue; } // ①命名角色
    if (input.isLiveSession(entry.session_id)) { keep.push(entry); continue; } // ②会话存活
    const last = input.lastActiveOf(entry.session_id);
    if (last > 0 && input.now - last < keepMs) { keep.push(entry); continue; } // ③近期有活动
    const days = last > 0 ? Math.max(1, Math.floor((input.now - last) / 86_400_000)) : 0;
    trimmed.push({ entry, reason: last > 0 ? `无活动 ${days} 天` : "无派单收口记录" });
  }
  return { keep, trimmed };
}

/** 组编制整体写面（裁剪收口用——removeMember 循环 N 次写穿不如一次；成员级单退仍走
 * removeMember）。headcount 原样替换 + updated_at 推进；组不存在/写失败照常报。 */
export function setGroupHeadcount(gid: string, headcount: ProjectHeadcountEntry[], dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  g.headcount = headcount;
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

/** 组级编制上限写面（P0 2026-10-15）：cap=数字（>0 取整）设覆盖；undefined 清除回
 * 全局缺省（maxHeadcountWorkers）。设后生效面=派单闸/addMember 闸/裁剪保留判定。 */
export function setGroupHeadcountCap(gid: string, cap: number | undefined, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  if (cap === undefined) delete g.headcount_cap;
  else g.headcount_cap = Math.floor(cap);
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

function saveGroup(g: ProjectGroup, dir?: string): boolean {
  // W-CMDIMPL T0b：reducer 写严格（§5.6/拍板 #10）——组记录 schema 校验拒写
  const chk = applyOrgChange("group", g);
  if (!chk.ok) {
    console.error(`[projects] ${chk.error}（gid=${g.id}）`);
    return false;
  }
  const f = readProjectsFileJson(dir); // #292-B2 A-P1-1：saveGroup 常在写口事务内被调（setGroupStatusInner 尾段），投影读会嵌套导入事务
  const i = f.groups.findIndex((x) => x.id === g.id);
  if (i >= 0) f.groups[i] = g;
  else f.groups.push(g);
  return writeProjectsFile(f, dir);
}

// 三态状态机（§6.2）：在办⇄挂起（双向）；在办/挂起→结项（单向终态）；结项→在办=复活边；
// pending = 正经立项/首次轻立项的确认前态（确认→active；否决→archived 留痕）。
const TRANSITIONS: Record<ProjectGroupStatus, ProjectGroupStatus[]> = {
  pending: ["active", "archived"],
  active: ["parked", "archived"],
  parked: ["active", "archived"],
  archived: ["active"],
};

export function canTransition(from: ProjectGroupStatus, to: ProjectGroupStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type CreateGroupResult =
  | { ok: true; group: ProjectGroup; needsConfirm: boolean; confirm: OrgConfirm | null }
  | { ok: false; error: string };

/**
 * 立项（分诊档 = 轻立项/正经立项）。确认门槛（§4）：
 * - 正经立项：必须确认（每次）→ 组建为 pending + project-create 确认单，用户 ✓ 才 active；
 * - 轻立项：同类免确认（首次确认一次，信任累积）——信任未建立同走 pending，之后直达 active。
 * 护栏：active 数量达上限拒绝（防止活跃台账失控）。锚点目录被在办/挂起组占用拒绝（一锚一组）。
 */
export function createGroup(
  input: { name: string; anchor_dir: string; tier: ProjectTier; headcount?: ProjectHeadcountEntry[]; role_defaults?: Record<string, ProjectRoleDefault>; mixed_engine?: boolean },
  dir?: string,
): CreateGroupResult {
  const f = readProjectsFile(dir);
  const activeCount = f.groups.filter((x) => x.status === "active").length;
  if (activeCount >= maxActiveGroups()) {
    return { ok: false, error: `并行项目组已达上限 ${maxActiveGroups()}（护栏），先结项或挂起再立项` };
  }
  const clash = findGroupByAnchor(input.anchor_dir, dir);
  if (clash) {
    return { ok: false, error: `锚点目录已被项目组「${clash.name}」占用（${clash.status}），一锚一组` };
  }
  const now = Date.now();
  const needsConfirm = input.tier === "正经立项" || !f.trust_light;
  const group: ProjectGroup = {
    id: `pg-${randomUUID().slice(0, 8)}`,
    name: input.name,
    anchor_dir: input.anchor_dir,
    status: needsConfirm ? "pending" : "active",
    tier: input.tier,
    headcount: input.headcount ?? [],
    ...(input.role_defaults ? { role_defaults: input.role_defaults } : {}),
    ...(input.mixed_engine === true ? { mixed_engine: true } : {}),
    single_card: input.tier === "轻立项",
    created_at: now,
    updated_at: now,
  };
  if (!saveGroup(group, dir)) return { ok: false, error: "索引写入失败" };
  let confirm: OrgConfirm | null = null;
  if (needsConfirm) {
    confirm = addConfirm(
      {
        kind: "project-create",
        title: `新建项目确认：${group.name}`, // W-WINPAIR-R9 文案件：「立项」口语词治理（显示层正式化）
        reason: input.tier === "正经立项" ? "正式项目必须确认（一次点击，防误判档烧钱）" : "轻量项目首次确认一次（同类免确认，信任累积）", // tier 存储值不变，理由文案走正式词
        payload: { gid: group.id, tier: group.tier, anchor_dir: group.anchor_dir },
      },
      dir,
    );
  }
  return { ok: true, group, needsConfirm, confirm };
}

export interface OrgActionCreatePayload {
  action: "create" | string;
  name: string;
  anchor_dir: string;
  tier: string;
  /** P81-5 混编标记（可选）：true=组内多引擎混编（派单 policy_source=mixed_team_default）。 */
  mixed_engine?: boolean;
  /** FB4 团队创建表单：随团种子编制（可选）。会话在册性/外部会话/Leader 排除在
   * session-manager orgCommand 咽喉校验（有 this.sessions 视野）；此处只做形状校验。 */
  headcount?: { session_id: string; role: string }[];
}

/** W-TS63FIX ①（review-tsync-relay P2-1 修法 b/c）：PM/Leader 身份行角色词表单源——
 * session-manager 建团门（hasPmRow 收窄/同 sid 分流/picker 反向排除）共用；与 web 端
 * session-domain.js SLIM_KEEP_ROLE 同词表镜像（pm/leader/产品经理/项目经理/领队，含
 * 中文 PM 角色实况——t25fix #11 词表口径）。命中=身份行语义：豁免外部门禁/不接派单/
 * trim 不裁。 */
export const PM_ROLE_RE = /^(pm|leader|产品经理|项目经理|领队)$/i;

/** W-TS63FIX ②（review-tsync-relay P2-1 修法 c）：随团编制会话门（防御纵深）——
 * 形状层保持会话盲（本文件分层口径不变），会话在册性/外部/Leader 判定经闭包注入，
 * 由持有 this.sessions 视野的调用方（session-manager）提供；返回 error 串=该席不合法
 * 整单拒。防未来新增 create 入口漏走 session-manager 前置门。 */
export type HeadcountGate = (sid: string, role: string) => string | null;

/** [W-SMIMPL ①]（W-SMDESIGN 候选 1，2026-10-25 Leader 拍板）席位门单源判据——
 * 「在册/外部/Leader/pm 词表」四轴唯一权威（此前 create 前置门 / HeadcountGate /
 * member-add / member-retire 四入口各写 90% 重叠的判据，P2-1 门序绕过与 P3-3
 * 不对称正是这个结构的产物）。纯函数读注入事实（goose applies() 纪律：判据=
 * 纯函数读状态，可直测、不在过程流里排 if 序）：
 *   轴④ pm 词表身份行（PM_ROLE_RE）→ ok（不接派单的身位标记，允许外部——
 *       W-TEAMSNC ① 三闸口径）
 *   轴① 会话不在册 → not_present
 *   轴② 外部会话作成员角色 → external（成员须是可派单的托管会话）
 *   轴③ Leader 会话 → leader（分诊者不接活）
 * 返回结构化 reason（不返回文案）：各入口按自己的用户面语境映射文案，判据单源、
 * 文案兼容（fb14 ⑤b/TS63FIX 反例断言不破）。 */
export type SeatDenyReason = "not_present" | "external" | "leader";
export type SeatGateResult = { ok: true } | { ok: false; reason: SeatDenyReason };

export interface SeatGateContext {
  /** 会话事实：不在册=undefined；在册返回外部性（session-manager 由
   *  this.sessions 视野提供——分层口径与 HeadcountGate 闭包注入同款） */
  seatInfo(sid: string): { external: boolean } | undefined;
  /** Leader 会话判定（this.isLeaderSession 直通） */
  isLeader(sid: string): boolean;
}

export function seatGate(sid: string, role: string, ctx: SeatGateContext): SeatGateResult {
  if (PM_ROLE_RE.test(role)) return { ok: true };
  const info = ctx.seatInfo(sid);
  if (!info) return { ok: false, reason: "not_present" };
  if (info.external) return { ok: false, reason: "external" };
  if (ctx.isLeader(sid)) return { ok: false, reason: "leader" };
  return { ok: true };
}

/** FB4：随团编制形状校验（≤8 席；role 缺省 worker；session_id 去重）。 */
function sanitizeHeadcount(raw: unknown, gate?: HeadcountGate): { ok: true; headcount?: ProjectHeadcountEntry[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: "headcount 必须是数组" };
  if (raw.length > 8) return { ok: false, error: "headcount 超上限（8 席）" };
  const out: ProjectHeadcountEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "headcount 条目必须是对象" };
    const sid = typeof (item as { session_id?: unknown }).session_id === "string" ? ((item as { session_id: string }).session_id).trim() : "";
    if (!sid) return { ok: false, error: "headcount 条目缺 session_id" };
    if (seen.has(sid)) continue; // 重复选择静默去重（幂等保首行——PM 行 unshift 在前胜出；同 sid 冲突由 session-manager 前置门整单拒，纵深层不再判）
    seen.add(sid);
    const roleRaw = (item as { role?: unknown }).role;
    const role = typeof roleRaw === "string" && roleRaw.trim() ? roleRaw.trim().slice(0, 24) : "worker";
    const nickRaw = (item as { nick?: unknown }).nick;
    const nick = typeof nickRaw === "string" && nickRaw.trim() ? nickRaw.trim().slice(0, 24) : undefined;
    if (gate) {
      const deny = gate(sid, role);
      if (deny) return { ok: false, error: deny };
    }
    out.push({ session_id: sid, role, ...(nick ? { nick } : {}) });
  }
  return { ok: true, ...(out.length ? { headcount: out } : {}) };
}

/** #260 锚点宿主判定单点：anchor 是 relay 宿主机上的物理路径，绝对性随宿主 OS 而
 * 定（win32：C:\ 或 \\ 开头；posix：/ 开头——node:path 平台命名空间即权威语义，
 * 勿手写 startsWith）。前端 web-console 只做宽松格式闸（/ 或盘符开头均放行，
 * anchorFormatOk 单点），严格合法性只在此判定；拒绝文案带宿主平台与期望形态
 * （网页操作端 OS 未必同宿主，1026 公司 Windows 网页版被拦实测），前端透传显示。
 * platform 供测试注入（"win32" 分支在 mac/linux 测试机可验），缺省真宿主。 */
export function anchorPathError(anchor: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = platform === "win32" ? win32.isAbsolute(anchor) : posix.isAbsolute(anchor);
  if (absolute) return "";
  const osName = platform === "win32" ? "Windows" : "macOS/Linux";
  const sample = platform === "win32" ? "C:\\Users\\you\\project" : "/Users/you/project";
  return `锚点目录必须是 relay 宿主机（${osName}）上的绝对路径（形如 ${sample}）；收到 "${anchor.slice(0, 80)}" 在宿主机上不是绝对路径`;
}

/** B2a adapter：只把 COMMAND_ORG_ACTION=create 收敛到既有 createGroup 单漏斗。 */
export function handleOrgActionCreate(payload: unknown, dir?: string, gate?: HeadcountGate): CreateGroupResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "org action payload 无效" };
  }
  const raw = payload as Partial<OrgActionCreatePayload>;
  if (raw.action !== "create") return { ok: false, error: `unsupported org action: ${String(raw.action ?? "")}` };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const anchor = typeof raw.anchor_dir === "string" ? raw.anchor_dir.trim() : "";
  const tier = typeof raw.tier === "string" ? raw.tier.trim() : "";
  if (!name || !anchor) return { ok: false, error: "name/anchor_dir 必填" };
  const anchorErr = anchorPathError(anchor);
  if (anchorErr) return { ok: false, error: anchorErr };
  if (tier !== "轻立项" && tier !== "正经立项") return { ok: false, error: "tier 必须是 轻立项|正经立项" };
  const hc = sanitizeHeadcount(raw.headcount, gate);
  if (!hc.ok) return { ok: false, error: hc.error };
  return createGroup({ name, anchor_dir: anchor, tier, ...(hc.headcount ? { headcount: hc.headcount } : {}), ...(raw.mixed_engine === true ? { mixed_engine: true } : {}) }, dir);
}

export const adaptOrgAction = handleOrgActionCreate;

export type TransitionResult = { ok: true; group: ProjectGroup } | { ok: false; error: string };

// #292-B2 三口事务外包：锁（BEGIN IMMEDIATE）+锁内文件直读+commit 后导入追赶（B 路审查
// 修正注释：新鲜度来自「直读+追赶」，不是锁本身——checkpoint 假有效态下投影恒陈旧，锁内禁投影）
export function setGroupStatus(id: string, to: ProjectGroupStatus, note?: string, dir?: string): TransitionResult {
  return withOrgWriteTx(dir, () => setGroupStatusInner(id, to, note, dir));
}
function setGroupStatusInner(id: string, to: ProjectGroupStatus, note?: string, dir?: string): TransitionResult {
  const f = readProjectsFileJson(dir); // #292-B2 锁内直读（投影读嵌套导入事务）
  const g = f.groups.find((x) => x.id === id || x.name === id);
  if (!g) return { ok: false, error: `项目组不存在: ${id}` };
  if (g.status === to) return { ok: true, group: g };
  if (!canTransition(g.status, to)) {
    return { ok: false, error: `非法转移 ${g.status} → ${to}（§6.2 状态机）` };
  }
  if (to === "active") {
    const activeCount = f.groups.filter((x) => x.status === "active").length;
    if (activeCount >= maxActiveGroups()) {
      return { ok: false, error: `并行项目组已达上限 ${maxActiveGroups()}（护栏）` };
    }
  }
  const now = Date.now();
  g.status = to;
  g.updated_at = now;
  if (to === "parked") g.parked_at = now;
  if (to === "archived") {
    g.archived_at = now;
    if (note) g.archive_note = note;
  }
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  freezeBoard(g.id, to !== "active", dir);
  return { ok: true, group: g };
}

/** 升降级（§4）：档间可迁移，任务卡与 worktree 原地继承、只补不重建（M2 无 worktree 供给线，语义=只改档位标记） */
export function setGroupTier(id: string, to: ProjectTier, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === id || x.name === id);
  if (!g) return { ok: false, error: `项目组不存在: ${id}` };
  if (g.tier === to) return { ok: true, group: g };
  g.tier = to;
  g.single_card = to === "轻立项";
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

export function addMember(
  gid: string,
  sessionId: string,
  role: string,
  selectionOrDir?: { engine?: SessionEngine; model?: string; provider?: string; nick?: string } | string,
  dir?: string,
  // P0 编制上限：缺省启闸（新席位受 headcountCapOf 管）；已在编席位走更新分支不触闸。
  // 复用/改档路径（dispatchWorker 复用、member-add 复拉已在编熟手）天然不受影响
  opts?: { enforceCap?: boolean },
): TransitionResult {
  const selection = typeof selectionOrDir === "string" ? undefined : selectionOrDir;
  const dataDir = typeof selectionOrDir === "string" ? selectionOrDir : dir;
  const f = readProjectsFile(dataDir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  const current = g.headcount.find((h) => h.session_id === sessionId);
  if (!current) {
    // 编制上限闸（2026-10-15）：新增泛 worker 席位前核 cap——命名角色不占泛用席位。
    // 触顶即拒（不静默）：派单面有触顶复用/排队前置闸（dispatchWorker），此处是
    // 并发兜底 + 手动 member-add 的显式拒绝位
    if ((opts?.enforceCap ?? true) && (role || "worker") === "worker" && genericWorkerCount(g.headcount) >= headcountCapOf(g)) {
      return { ok: false, error: `编制已达上限（泛 worker ${genericWorkerCount(g.headcount)}/${headcountCapOf(g)}）——上限内派单自动复用空闲 worker；确需扩编先调 headcount_cap 或清理编制` };
    }
    g.headcount.push({ session_id: sessionId, role, ...(selection?.nick ? { nick: selection.nick } : {}), ...selection });
    g.updated_at = Date.now();
    if (!saveGroup(g, dataDir)) return { ok: false, error: "索引写入失败" };
  } else if (selection || current.role !== role) {
    current.role = role;
    if (selection?.nick !== undefined) { if (selection.nick) current.nick = selection.nick; else delete current.nick; } // 空串=清除别名
    if (selection?.engine !== undefined) current.engine = selection.engine;
    if (selection?.model !== undefined) current.model = selection.model;
    if (selection?.provider !== undefined) current.provider = selection.provider;
    g.updated_at = Date.now();
    if (!saveGroup(g, dataDir)) return { ok: false, error: "索引写入失败" };
  }
  return { ok: true, group: g };
}

export function removeMember(gid: string, sessionId: string, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  g.headcount = g.headcount.filter((h) => h.session_id !== sessionId);
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

/** P71 组级值守策略写面（019 §6.3 duty_policy）：policy=undefined 清除策略（回缺省开）。
 * 命令面/设置 UI 接线属后续批；本批消费面=dutySnapshot 组级过滤（session-manager）+
 * 存储字段落 groups.json（schema owner 串行扩展惯例，与 depends_on/member_archive 同源）。 */
export function setGroupDutyPolicy(gid: string, policy: DutyPolicy | undefined, dir?: string): TransitionResult {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  if (policy === undefined) delete g.duty_policy;
  else g.duty_policy = policy;
  g.updated_at = Date.now();
  if (!saveGroup(g, dir)) return { ok: false, error: "索引写入失败" };
  return { ok: true, group: g };
}

// ---------- 任务板（跨会话项目组级，M2 待建件） ----------

/** D18 一次性迁移（freeze v2-m10-freeze §1.2 逐字）：三态→五态就近映射 todo→backlog、
 * doing→claimed、done→done，不保留旧态。读入惰性触发：有位移才落盘，落盘前冷备份
 * <board>.pre-d18.json（cutover 冷档案精神——迁移不删旧文件，写新态）；五态板重跑零
 * 位移零写（幂等）。备份/落盘失败不阻断读（内存态已五态，下次写盘自然收敛）。
 * 词表外未知值不迁移不丢弃（原样保留，渲染面 M13-3 按值分组兜底）。 */
function migrateBoardStatuses(gid: string, board: ProjectBoard, dir?: string): ProjectBoard {
  let moved = 0;
  for (const e of board.entries) {
    const st = e.status as string; // 旧文件运行时值可能是三态旧词（类型面已收五态，cast 读真值）
    if (st === "todo") { e.status = "backlog"; moved++; }
    else if (st === "doing") { e.status = "claimed"; moved++; }
  }
  if (moved === 0) return board;
  try {
    const p = boardFilePath(gid, dir);
    if (existsSync(p)) copyFileSync(p, `${p}.pre-d18.json`);
    saveBoardFile(board, dir, { action: "migrate", entry_id: "*", next: { status: `${moved} 条三态→五态` } });
  } catch { /* 冷备份/落盘失败不阻断读侧 */ }
  return board;
}

/** 板文件读取三态：成功=解析归一后的板；ENOENT=空板（板懒创建常态，未写过≠读失败）；
 * 其余失败（坏 JSON 半态/EACCES/磁盘抖动）=null——读失败≠空板（M13-REV P3-2 定案：catch
 * 兜底空板会让广播差分出「整板 removes」清板帧，UI 闪断+半态扩散）。消费面分两路：广播链
 * （session-manager emitBoard）判 null 跳帧，文件恢复后下帧照常差分；读/写消费点（本文件内）
 * 走 loadBoardOrEmpty 保持「当空板」既有语义（含 ENOENT）。 */
export function loadBoardFile(gid: string, dir?: string): ProjectBoard | null {
  try {
    const raw = JSON.parse(readFileSync(boardFilePath(gid, dir), "utf-8")) as Partial<ProjectBoard>;
    return migrateBoardStatuses(gid, {
      gid,
      entries: Array.isArray(raw.entries) ? (raw.entries as BoardEntry[]) : [],
      ...(Array.isArray(raw.lessons) ? { lessons: raw.lessons as LessonEntry[] } : {}),
      frozen: raw.frozen === true,
      updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    }, dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { gid, entries: [], frozen: false, updated_at: 0 }; // 板懒创建常态：未写过=空板（非读失败，emitBoard 照常发空板帧）
    }
    return null; // 文件在但读失败（坏 JSON 半态/EACCES/磁盘抖动）→ 广播链跳帧（P3-2）
  }
}

/** 读失败当空板——既有读/写消费点语义（P3-2 收口前 catch 兜底行为的搬家，行为零变）。 */
function loadBoardOrEmpty(gid: string, dir?: string): ProjectBoard {
  return loadBoardFile(gid, dir) ?? { gid, entries: [], frozen: false, updated_at: 0 };
}

// ---------- W-BJOURNAL 板文件 delta journal（SSOT 拍板点1，2026-10-13 用户批「立即落」） ----------
// boards/<gid>.json 是全量覆盖写、无版本化——一次误写=全灭。本 journal 在每次板落盘前
// 追加一行 append-only 审计（org/boards-journal.ndjson）：{ts, gid, entry_id, action,
// prev/next 摘要}。字段全部取自调用链内存态（改前快照+改后内存对象），零额外 IO 重查。
// 三条纪律：①写失败不阻断主写（journal 是保险不是闸，stderr 记录）②有界：超 5MB 滚动
// 改名保留一份旧档 .1（rm 旧 .1→rename，防无限增长）③不改变板 JSON 本体（零 schema 迁移）。
export interface BoardJournalSide {
  status?: string;
  text?: string; // 截 60（摘要非全文——journal 是审计线索不是备份）
}
export interface BoardJournalRecord {
  action: string; // create|update|move|remove|dispatch-move|freeze|unfreeze|migrate|save（save=无语义兜底行）
  entry_id?: string;
  prev?: BoardJournalSide;
  next?: BoardJournalSide;
}

const BOARD_JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

function appendBoardJournal(gid: string, rec: BoardJournalRecord, d: string): void {
  try {
    const p = join(d, "boards-journal.ndjson");
    try {
      if (statSync(p).size > BOARD_JOURNAL_MAX_BYTES) {
        try { rmSync(`${p}.1`, { force: true }); } catch { /* 旧档删除失败不阻断滚动 */ }
        renameSync(p, `${p}.1`);
      }
    } catch { /* 无文件=首写（ENOENT），直接追加 */ }
    appendFileSync(p, JSON.stringify({ ts: Date.now(), gid, ...rec }) + "\n", "utf-8");
  } catch (e) {
    // 纪律①：journal 失败绝不阻断板写（保险不是闸）——stderr 而非 warn（审计面静默降级不可接受）
    console.error(`[board-journal] 追加失败（不阻断板写）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sideOf(e: { status?: string; text?: string }): BoardJournalSide {
  return { status: e.status, ...(e.text ? { text: e.text.slice(0, 60) } : {}) };
}

function saveBoardFile(b: ProjectBoard, dir?: string, jr?: BoardJournalRecord): boolean {
  const d = dir ?? orgDir();
  // 写入前追加 journal（任何落盘都有行——无语义调用记 action:"save" 兜底行）
  appendBoardJournal(b.gid, jr ?? { action: "save" }, d);
  try {
    mkdirSync(boardsDirPath(d), { recursive: true });
    writeFileSync(boardFilePath(b.gid, d), JSON.stringify(b, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[projects] 板写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function loadBoard(gid: string, dir?: string): ProjectBoard {
  return loadBoardOrEmpty(gid, dir);
}

/** 板写入前置校验：组须存在且 active（挂起=冻结保留、结项=归档只读，§2.2） */
function writableBoard(gid: string, dir?: string): { ok: true; board: ProjectBoard } | { ok: false; error: string } {
  // #292-B2 锁内直读（upsertBoardEntry 事务段调用本函数——listGroups 投影读会嵌套导入事务）
  const g = readProjectsFileJson(dir).groups.find((x) => x.id === gid);
  if (!g) return { ok: false, error: `项目组不存在: ${gid}` };
  if (g.status !== "active") return { ok: false, error: `任务板已冻结（项目组 ${g.status}），恢复在办后可写` };
  const b = loadBoardOrEmpty(gid, dir);
  if (b.frozen) return { ok: false, error: "任务板已冻结（frozen 标记）" };
  return { ok: true, board: b };
}

function freezeBoard(gid: string, frozen: boolean, dir?: string): void {
  const b = loadBoardOrEmpty(gid, dir);
  if (b.frozen === frozen) return;
  b.frozen = frozen;
  b.updated_at = Date.now();
  saveBoardFile(b, dir, { action: frozen ? "freeze" : "unfreeze" });
}

/** D18 五态搬移规则内核（upsert/move 单点共用）：
 * R1 submitted 生成锁——submitted 仅由完成候选且 review_required=1 生成（freeze §1.2）：
 * 目标 submitted 仅当卡带资格（现值或本次入参显式 true），否则拒收；
 * R2 done 候选升级——done 请求且入参显式 review_required=true 且卡不在 submitted
 * （submitted→done 属复核确认非再生成）→ 落 submitted+设资格位；
 * R3 复核闭环/终态清位——落 done 恒清资格位（done 是终态无复核态，submitted→done
 * 确认与普通 done 同收）。
 * 返回 review_required：true=设位 / false=清位 / undefined=不动（非 done 搬移保现值）。 */
function resolveStatusTransition(
  e: Pick<BoardEntry, "status" | "review_required">,
  to: BoardEntryStatus,
  rrInput?: boolean,
): { ok: true; status: BoardEntryStatus; review_required?: boolean } | { ok: false; error: string } {
  if (to === "submitted") {
    if (e.review_required === true || rrInput === true) return { ok: true, status: "submitted", review_required: true };
    return { ok: false, error: "submitted 仅由完成候选且 review_required=1 生成（先为卡设 review_required）" };
  }
  if (to === "done") {
    if (e.status !== "submitted" && rrInput === true) return { ok: true, status: "submitted", review_required: true };
    return { ok: true, status: "done", review_required: false };
  }
  return { ok: true, status: to };
}

/** #292-B2 三口事务外包（同 setGroupStatus 口径） */
export type UpsertBoardEntryInput = {
  id?: string; text: string; status?: BoardEntryStatus;
  owner_session?: string; dispatch_id?: string; note?: string;
  review_required?: boolean;
  depends_on?: string[];
  gate?: { reason: string } | null;
  priority?: string | null;
  parent_id?: string | null;
};
export function upsertBoardEntry(
  gid: string,
  entry: UpsertBoardEntryInput,
  dir?: string,
): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
  return withOrgWriteTx(dir, () => upsertBoardEntryInner(gid, entry, dir));
}
function upsertBoardEntryInner(
  gid: string,
  entry: UpsertBoardEntryInput,
  dir?: string,
): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const now = Date.now();
  const deps = entry.depends_on === undefined
    ? undefined
    : [...new Set(entry.depends_on.filter((d): d is string => typeof d === "string" && d.trim() !== ""))];
  let e: BoardEntry | undefined = entry.id ? w.board.entries.find((x) => x.id === entry.id) : undefined;
  const jPrev = e ? sideOf(e) : undefined; // journal 前态快照（改前内存，零重查）
  if (e) {
    e.text = entry.text;
    if (entry.status) {
      const t = resolveStatusTransition(e, entry.status, entry.review_required);
      if (!t.ok) return { ok: false, error: t.error };
      e.status = t.status;
      // 件十九：迁移时间线追加（append-only；状态无变化不记重复行）
      if (!e.transitions) e.transitions = [];
      if (e.transitions[e.transitions.length - 1]?.status !== t.status) e.transitions.push({ status: t.status, ts: now });
      if (t.review_required === true) e.review_required = true;
      else if (t.review_required === false) delete e.review_required;
    } else if (entry.review_required !== undefined) {
      // D18 资格位独立维护（status 缺省时）：true=标记完成候选；false=撤销资格
      if (entry.review_required) e.review_required = true;
      else delete e.review_required;
    }
    if (entry.owner_session !== undefined) e.owner_session = entry.owner_session;
    if (entry.dispatch_id !== undefined) e.dispatch_id = entry.dispatch_id;
    if (entry.note !== undefined) e.note = entry.note;
    if (deps !== undefined) {
      if (deps.length === 0) delete e.depends_on;
      else e.depends_on = deps;
    }
    if (entry.gate !== undefined) {
      if (entry.gate === null) delete e.gate;
      else e.gate = { reason: entry.gate.reason, opened_at: now };
    }
    if (entry.priority !== undefined) { // #G3：null=清除回未标注
      if (entry.priority === null) delete e.priority;
      else e.priority = entry.priority;
    }
    if (entry.parent_id !== undefined) { // #G3：null/空串=解除挂靠置根卡
      if (entry.parent_id === null || entry.parent_id === "") delete e.parent_id;
      else e.parent_id = entry.parent_id;
    }
    e.updated_at = now;
  } else {
    // D18：新卡也过规则内核（建卡即完成候选=done+review_required → R2 落 submitted）
    const t = resolveStatusTransition({ status: "backlog" }, entry.status ?? "backlog", entry.review_required);
    if (!t.ok) return { ok: false, error: t.error };
    e = {
      id: entry.id ?? `t-${randomUUID().slice(0, 8)}`,
      text: entry.text,
      status: t.status,
      owner_session: entry.owner_session,
      dispatch_id: entry.dispatch_id,
      ts: now,
      updated_at: now,
      note: entry.note,
      transitions: [{ status: t.status, ts: now }], // 件十九：首道入线
      ...(t.review_required === true ? { review_required: true } : {}),
      ...(deps && deps.length > 0 ? { depends_on: deps } : {}),
      ...(entry.gate ? { gate: { reason: entry.gate.reason, opened_at: now } } : {}),
      ...(entry.priority ? { priority: entry.priority } : {}), // #G3：缺省不落键（旧行兼容）
      ...(entry.parent_id ? { parent_id: entry.parent_id } : {}),
    };
    w.board.entries.push(e);
  }
  w.board.updated_at = now;
  // W-CMDIMPL T0b：reducer 写严格——板卡 schema 校验拒写（建/改共用此口）
  const chk = applyOrgChange("board-entry", e);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!saveBoardFile(w.board, dir, { action: jPrev ? "update" : "create", entry_id: e.id, ...(jPrev ? { prev: jPrev } : {}), next: sideOf(e) })) return { ok: false, error: "板写入失败" };
  return { ok: true, entry: e };
}

export function moveBoardEntry(
  gid: string,
  entryId: string,
  to: BoardEntryStatus,
  dir?: string,
): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const e = w.board.entries.find((x) => x.id === entryId);
  if (!e) return { ok: false, error: `板条目不存在: ${entryId}` };
  const jPrev = sideOf(e); // journal 前态快照
  // D18：与 upsert 同规则内核（R1/R2/R3）——move 直 submitted 无资格拒、submitted→done
  // 清位、普通 done 收口清位
  const t = resolveStatusTransition(e, to);
  if (!t.ok) return { ok: false, error: t.error };
  e.status = t.status;
  // 件十九：迁移时间线追加（append-only；状态无变化不记重复行）
  if (!e.transitions) e.transitions = [];
  if (e.transitions[e.transitions.length - 1]?.status !== t.status) e.transitions.push({ status: t.status, ts: Date.now() });
  if (t.review_required === true) e.review_required = true;
  else if (t.review_required === false) delete e.review_required;
  e.updated_at = Date.now();
  w.board.updated_at = e.updated_at;
  // W-CMDIMPL T0b：reducer 写严格——搬卡改后态 schema 校验拒写
  const chk = applyOrgChange("board-entry", e);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!saveBoardFile(w.board, dir, { action: "move", entry_id: e.id, prev: jPrev, next: sideOf(e) })) return { ok: false, error: "板写入失败" };
  return { ok: true, entry: e };
}

export function removeBoardEntry(gid: string, entryId: string, dir?: string): { ok: true } | { ok: false; error: string } {
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const before = w.board.entries.length;
  const jPrevEntry = w.board.entries.find((x) => x.id === entryId);
  w.board.entries = w.board.entries.filter((x) => x.id !== entryId);
  if (w.board.entries.length === before) return { ok: false, error: `板条目不存在: ${entryId}` };
  w.board.updated_at = Date.now();
  if (!saveBoardFile(w.board, dir, { action: "remove", entry_id: entryId, ...(jPrevEntry ? { prev: sideOf(jPrevEntry) } : {}) })) return { ok: false, error: "板写入失败" };
  return { ok: true };
}

/** 派单联动搬卡：按台账 id 找条目改状态（dispatch 收口 onTurnEnd 调用；无对应条目 = no-op 不报错） */
export function moveEntryByDispatch(gid: string, dispatchId: string, to: BoardEntryStatus, dir?: string): void {
  const w = writableBoard(gid, dir);
  if (!w.ok) return;
  const e = w.board.entries.find((x) => x.dispatch_id === dispatchId);
  if (!e || e.status === to) return;
  const jPrev = sideOf(e);
  e.status = to;
  e.updated_at = Date.now();
  w.board.updated_at = e.updated_at;
  // W-CMDIMPL T0b：reducer 写严格——裸设置器同样过闸（第四写口不断链）；void 返回
  // 语义不变，拒写走 stderr 显式报（不静默吞）
  const chk = applyOrgChange("board-entry", e);
  if (!chk.ok) {
    console.error(`[projects] dispatch-move 拒写：${chk.error}（gid=${gid} dispatch=${dispatchId}）`);
    return;
  }
  saveBoardFile(w.board, dir, { action: "dispatch-move", entry_id: e.id, prev: jPrev, next: sideOf(e) });
}

// ---------- #236 D：台账终态 → 看板收敛扫（boot 一次性，W-TEAMVIS） ----------
// 缺口实证（用户 1023 口径③）：派单收口 done 边（session-manager closeOpenDispatches）
// 会把联动卡搬进 done，但历史断点让已完成单的卡长挂非 done 泳道——relay 重启
// closeHungDispatchRows 把中断单搬回 backlog（interrupted≠真交付）、跨组锚失配漏搬等；
// 10-11 时代 W-RELFIX/W-AUDIT-A/B/W-SCHEDFIX2 等收割任务至今挂板（1023 截图）。
// 收敛口径：卡带 dispatch_id、台账末行终态=done（且非中断补记）、卡不在 done → 搬 done
// （台账=派单生命周期 SSOT，收口事实已发生）。三道防碾：failed 不动（失败单留板待人
// 处置）；中断补记行（receipt 带「relay 重启」）不算收割（F-08 退 backlog 有意设计）；
// 卡 updated_at 严格晚于终态行 ts=收口后被人工/流程搬过，不碾——收敛只清断点残留，不碾压
// 人工板面操作。只扫 active 组（parked/archived 板冻结由 writableBoard 天然挡）。
export function convergeBoardsWithDispatchLog(dir?: string): number {
  // 读预算（#25-P3 同款教训：readDispatchLog 全文件读，循环内重读=每卡一遍全量）——
  // 一次读入，末行赢语义按追加序后写覆盖。max 显式放大（默认 500 行窗口装不下长史
  // 项目，10-11 时代旧单恰是本扫的目标面，漏读=白扫）。
  // 中断收口排除（F-08 口径「活没交付不能停 doing」）：closeHungDispatchRows 的补记行
  // receipt 恒带「relay 重启」前缀——那是「回合被打断」非「交付完成」，其退 backlog 是
  // 有意设计（待人重派），本扫不得把它当收割拽进 done。1023 实测教训：无此排除时
  // test-dispatch「断档补记板条退 todo」用例被本扫反向碾掉。
  const doneAtById = new Map<string, number>();
  for (const row of readDispatchLog(dir, 20_000)) {
    if (row.status !== "done" || !row.id) continue;
    if (String(row.receipt || "").startsWith("relay 重启")) continue;
    doneAtById.set(row.id, Number(row.ts) || 0);
  }
  if (!doneAtById.size) return 0;
  let moved = 0;
  for (const g of listGroupsByStatus(dir).active) {
    let board: ReturnType<typeof loadBoard>;
    try { board = loadBoard(g.id, dir); } catch { continue; }
    for (const entry of board.entries) {
      if (entry.status === "done" || !entry.dispatch_id) continue;
      const doneAt = doneAtById.get(entry.dispatch_id);
      if (doneAt === undefined) continue;
      // 严格晚于即不碾（无容差）：closeHungDispatchRows 的「补记 done(T1)→立即退 backlog
      // (T2>T1)」序列里 T2-T1<1s，60s 容差会放过它=把中断单拽进 done（1023 实测教训；
      // 同机时钟无抖动，容差无必要）
      if (Number(entry.updated_at || 0) > doneAt) continue;
      moveEntryByDispatch(g.id, entry.dispatch_id, "done", dir);
      moved++;
    }
  }
  return moved;
}

// ---------- #087 beads 思想采纳（009 §4 M1/M2 + §5 裁决；零外部依赖，不引 bd/Dolt） ----------
//
// 四件：depends_on 依赖字段 / ready 就绪集 / gate→blocked / lessons 回流。
// 红线（§5 裁决）：确认卡仍是用户决策唯一写面——gate 清除无自动路径，relay 不自动放行；
// `bd ready` 思想只在 relay 内实现（computeReady 纯函数，派单路径与 UI 共用，不绑 fs）。

export interface ReadyCheck {
  ready: boolean;
  /** 未就绪原因逐条可判定：缺哪些依赖/各自状态；坏引用单列（不炸不静默忽略） */
  reasons: string[];
  /** gate 阻塞原因（gate 未过时非 null；清除=人显式 upsert gate:null，无自动路径） */
  gate_reason: string | null;
}

/** 就绪判定纯函数（M2「派单前 ready 就绪集计算」的核心）：依赖卡全 done 且 gate 未设才
 * ready。坏引用（指向不存在卡）按未就绪处理——保守向：板被外部改过/引用丢了宁可拦下
 * 让人看，不静默放行。自引用/环不特判：自己依赖自己天然恒不就绪（可判定坏态，不炸）。 */
export function computeReady(
  card: Pick<BoardEntry, "id" | "depends_on" | "gate">,
  board: Pick<ProjectBoard, "entries">,
): ReadyCheck {
  const gate_reason = card.gate ? (card.gate.reason || "gate 未过（原因未注明）") : null;
  const reasons: string[] = [];
  for (const dep of card.depends_on ?? []) {
    const d = board.entries.find((x) => x.id === dep);
    if (!d) reasons.push(`依赖卡不存在: ${dep}（坏引用按未就绪处理，请核板）`);
    else if (d.status !== "done") reasons.push(`依赖卡 ${dep} 未完成（${d.status}）`);
  }
  return { ready: reasons.length === 0 && gate_reason === null, reasons, gate_reason };
}

/** 就绪集薄组合（bd ready 思想）：全板逐卡判定，UI 前沿视图与巡检共用；非破坏性纯函数 */
export function computeReadySet(board: Pick<ProjectBoard, "entries">): { id: string; check: ReadyCheck }[] {
  return board.entries
    .filter((e) => e.status !== "done")
    .map((e) => ({ id: e.id, check: computeReady(e, board) }));
}

// ---------- #087 lessons 回流（009 §4 M2：收口回执写 board lessons 分区，按 tag 筛选查询） ----------

/** 写入一条经验（板须 active 可写——冻结语义与卡写入同口径）。tags 洗刷去重，text 必填。 */
export function addLesson(
  gid: string,
  input: { text: string; tags?: string[]; source_dispatch_id?: string },
  dir?: string,
): { ok: true; lesson: LessonEntry } | { ok: false; error: string } {
  const text = input.text.trim();
  if (!text) return { ok: false, error: "lesson text 必填" };
  const w = writableBoard(gid, dir);
  if (!w.ok) return w;
  const lesson: LessonEntry = {
    id: `ls-${randomUUID().slice(0, 8)}`,
    text,
    tags: [...new Set((input.tags ?? []).filter((t): t is string => typeof t === "string" && t.trim() !== ""))],
    ts: Date.now(),
    ...(input.source_dispatch_id ? { source_dispatch_id: input.source_dispatch_id } : {}),
  };
  w.board.lessons = [...(w.board.lessons ?? []), lesson];
  w.board.updated_at = Date.now();
  if (!saveBoardFile(w.board, dir)) return { ok: false, error: "板写入失败" };
  return { ok: true, lesson };
}

/** 查询：无 filter 全量（文件序=时间序）；带 tags 为 AND 筛选。
 * **W-EXPP1 读侧退役（2026-10-10，设计 §8 P1 退役清单 / ARCH S6）**：经验域已被
 * experience.json 团队经验库接管（relay/src/experience.ts），lesson 域读过滤恒空——
 * 谓词一处两档共用（json/sqlite 分支同返 []），防 sqlite 读档下 BOARD_UPDATED 仍带
 * 旧 lessons 双源同屏。lesson 表停灌不删表（M11 导入器同步退役，见
 * storage/import-dispatch-lesson.ts）；板文件内旧数据原样冻结不删（append-only 审计
 * 美学 + 迁移器重跑依据）。新消费一律走 experience.ts 的 listExperience/matchPredicate。 */
export function listLessons(gid: string, filter?: { tags?: string[] }, dir?: string): LessonEntry[] {
  void gid;
  void filter;
  void dir;
  return []; // 退役谓词：恒空（两档读模式同返，单一事实源已切经验库）
}

// ---------- 确认单（人类决策队列，持久化；不复用 waiting_request——其生命周期与回合强耦合
// 且多处无条件清空，立项确认是分钟~小时级决策，§4 确认门槛） ----------

function readConfirms(dir?: string): OrgConfirm[] {
  // M11-G1 读入口接线（三档；确认单域=七域外接线域，投影级对账 domain="confirm"）
  return viaReadMode("confirm", {
    json: () => {
      try {
        const raw = JSON.parse(readFileSync(confirmsFilePath(dir), "utf-8")) as { confirms?: OrgConfirm[] };
        return Array.isArray(raw.confirms) ? raw.confirms : [];
      } catch {
        return [];
      }
    },
    sqlite: (port) => orgConfirmsFromDb(port),
    dirs: { orgDir: dir },
  });
}

function writeConfirms(list: OrgConfirm[], dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    // 只留最近 200 条已决 + 全部 pending（确认历史是审计面但不无限涨）
    const pending = list.filter((c) => c.status === "pending");
    const decided = list.filter((c) => c.status !== "pending").slice(-200);
    writeFileSync(confirmsFilePath(d), JSON.stringify({ confirms: [...pending, ...decided] }, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.warn(`[projects] 确认单写入失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function listConfirms(dir?: string): OrgConfirm[] {
  return readConfirms(dir);
}

export function listPendingConfirms(dir?: string): OrgConfirm[] {
  return readConfirms(dir).filter((c) => c.status === "pending");
}

// #018-R1FIX1 P1-1 确认单产生回调面：addConfirm 是全模块唯一确认单产生咽喉
//（立项/结项/档位/暂缓/自动暂缓全部经此落单），SessionManager 构造时注册回调，
// 把每张新卡同步进结构化通知账（recordOrgConfirmNotification）。单回调槽（后注册
// 覆盖）：生产单 manager 进程假设内成立；未注册（projects 独立使用/纯函数测试）
// = 零行为变化
type ConfirmCreatedHook = (confirm: OrgConfirm) => void;
let confirmCreatedHook: ConfirmCreatedHook | null = null;
export function setConfirmCreatedHook(hook: ConfirmCreatedHook | null): void {
  confirmCreatedHook = hook;
}

export function addConfirm(
  input: { kind: ConfirmKind; title: string; reason: string; payload?: Record<string, unknown> },
  dir?: string,
): OrgConfirm {
  const c: OrgConfirm = {
    id: `cf-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    payload: input.payload ?? {},
    status: "pending",
    created_at: Date.now(),
  };
  const list = readConfirms(dir);
  list.push(c);
  writeConfirms(list, dir);
  // 先事实源后通知（P1-2 dispatch 终态同口径）；回调异常不阻断落单主路径
  try {
    confirmCreatedHook?.(c);
  } catch (e) {
    console.warn(`[projects] 确认单产生回调失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return c;
}

export type DecideResult = { ok: true; confirm: OrgConfirm } | { ok: false; error: string };

/** 决议确认单（一次性的：已决不可再决）。副作用（组状态迁移/信任累积）由调用方执行——
 * 本函数只管决策记录，保证决议与执行分离可审计。 */
/** #292-B2 三口事务外包（同 setGroupStatus 口径） */
export function decideConfirm(id: string, approve: boolean, by: string, dir?: string): DecideResult {
  return withOrgWriteTx(dir, () => decideConfirmInner(id, approve, by, dir));
}
function decideConfirmInner(id: string, approve: boolean, by: string, dir?: string): DecideResult {
  const list = readConfirmsJson(dir); // #292-B2 锁内直读
  const c = list.find((x) => x.id === id);
  if (!c) return { ok: false, error: `确认单不存在: ${id}` };
  if (c.status !== "pending") return { ok: false, error: `确认单已决议（${c.status}），不可再决` };
  c.status = approve ? "approved" : "rejected";
  c.decided_at = Date.now();
  c.decided_by = by;
  if (!writeConfirms(list, dir)) return { ok: false, error: "确认单写入失败" };
  return { ok: true, confirm: c };
}

// ---------- 文档防漂移（§3.4：纪律载体 = 立项时生成项目 CLAUDE.md） ----------

export const PROJECT_CLAUDE_MD_SEED_PREFIX = "# 项目 CLAUDE.md —— 防漂移纪律";

export function projectClaudeMdSeed(name: string): string {
  return `${PROJECT_CLAUDE_MD_SEED_PREFIX}（${name}）

> 矩阵式团队立项时自动生成（幂等种子：已存在则不动）。本文件随会话自动加载，普通会话也覆盖。

## 防漂移条款（设计稿 §3.4）

- **spec 与代码同权走 git**：spec / prd / 决策记录的改动进同一 commit，回执「改动文件」自然体现——不设附带物、不加确认。
- **改一字亦须报**：动到本目录任何文档的改动，回执中必须列出改动文件。
- **结项归档前断言级核对**：先 \`git log --follow\` 机械清账无回执变更，再逐断言查代码；零异常一句话归档，有异常出漂移清单走验收单逐条裁决。
- **你本人直改天然合法**，不入核对异常。
- **红线**：不做段落级映射与覆盖率统计（防滑坡）。
`;
}

/** 幂等种子：只在无 CLAUDE.md 时写（用户或先前的立项可能已有内容，存在即认，绝不覆盖） */
export function ensureProjectClaudeMd(anchorDir: string, name: string): "created" | "exists" | "error" {
  try {
    const p = join(anchorDir, "CLAUDE.md");
    if (existsSync(p)) return "exists";
    mkdirSync(anchorDir, { recursive: true });
    writeFileSync(p, projectClaudeMdSeed(name), "utf-8");
    return "created";
  } catch (e) {
    console.warn(`[projects] 项目 CLAUDE.md 种子失败: ${e instanceof Error ? e.message : String(e)}`);
    return "error";
  }
}

// ---------- 结项断言核对清单（§3.4 结项归档前；清单生成，断言逐条核对由 Leader/人执行） ----------

export interface ArchiveChecklist {
  gid: string;
  name: string;
  /** 未收口派单（running/dispatched 悬账）——结项前应收口或知情放弃 */
  openDispatches: { id: string; tier: string; status: string; target: string; ts: number }[];
  /** 在编成员会话（结项=解散编制；M2 会话不删档，只解除归属） */
  headcount: ProjectHeadcountEntry[];
  /** 板上未完成条目数（D18 五态：done 以外全部计入——backlog/claimed/submitted/ready_to_install） */
  openBoardEntries: number;
  anchor_dir: string;
}

export function buildArchiveChecklist(gid: string, dir?: string): ArchiveChecklist | null {
  const g = listGroups(dir).find((x) => x.id === gid);
  if (!g) return null;
  const openDispatches = readDispatchLog(dir)
    .filter((e) => {
      const anchor = e.project_anchor ?? "";
      return anchor && anchor.replace(/\/+$/, "") === g.anchor_dir.replace(/\/+$/, "") && (e.status === "running" || e.status === "dispatched");
    })
    .map((e) => ({ id: e.id, tier: e.tier, status: e.status, target: e.target, ts: e.ts }));
  const b = loadBoardOrEmpty(gid, dir);
  const openBoardEntries = b.entries.filter((x) => x.status !== "done").length;
  return { gid: g.id, name: g.name, openDispatches, headcount: g.headcount, openBoardEntries, anchor_dir: g.anchor_dir };
}

// ---------- 信任累积（轻立项同类免确认） ----------

export function setLightConfirmTrusted(trusted: boolean, dir?: string): void {
  const f = readProjectsFile(dir);
  if (f.trust_light === trusted) return;
  f.trust_light = trusted;
  writeProjectsFile(f, dir);
}

// ---------- #26 M3 挂起自动化（§5 两周无活动建议暂缓） ----------

// 建议冷却戳：出单即戳（手动/触发器同口径）。不动 updated_at——「建议」不是活动，
// 戳了会自我续命让 stale 判定失真
export function markHoldSuggested(gid: string, at: number, dir?: string): void {
  const f = readProjectsFile(dir);
  const g = f.groups.find((x) => x.id === gid);
  if (!g) return;
  g.hold_suggested_at = at;
  saveGroup(g, dir);
}

export interface StaleGroupInfo {
  gid: string;
  name: string;
  /** 整数天（最后活动距今） */
  idleDays: number;
}

// 活度口径：组 updated_at ∨ 板 updated_at ∨ 该组派单台账最新 ts ∨ 路由表最新
// last_ts（熟手最近收工）——四路取最大即「最后活动」。纯函数（now 注入）：
// 扫描器与单测共用同一判定。staleDays<=0 直接空（触发器关闭态）。
export function findStaleGroups(
  now: number,
  staleDays: number,
  dir?: string,
  // #26 M3 审查修正（第五路活度）：组员会话 updated_at——用户直驱推进（COMMAND_MESSAGE）
  // 不动台账/板/组，前四路全静止；会话活动可见就不算闲置
  memberActivity?: Record<string, number>,
): StaleGroupInfo[] {
  if (staleDays <= 0) return [];
  const cutoff = now - staleDays * 86_400_000;
  const DAY = 86_400_000;
  const out: StaleGroupInfo[] = [];
  // #25-P3 出组循环：readDispatchLog 是全文件读+逐行 parse，此前在循环体内 = 每
  // active 组读一遍（每小时 stale 扫描 N 次 O(全文件)）——台账只增不减，长跑越读
  // 越贵。提到循环外读一次共用（行为不变：每组的判定字段只依赖台账内容与组锚点）
  const dispatchLog = readDispatchLog(dir);
  for (const g of listGroups(dir)) {
    if (g.status !== "active") continue;
    const board = loadBoard(g.id, dir);
    let last = Math.max(g.updated_at, board.updated_at);
    const anchor = g.anchor_dir.replace(/\/+$/, "");
    for (const e of dispatchLog) {
      const a = e.project_anchor ?? "";
      if (a && a.replace(/\/+$/, "") === anchor && e.ts > last) last = e.ts;
    }
    for (const r of routingFor(g.id, dir)) {
      if (r.last_ts > last) last = r.last_ts;
    }
    const ma = memberActivity?.[g.id] ?? 0;
    if (ma > last) last = ma;
    if (last < cutoff) out.push({ gid: g.id, name: g.name, idleDays: Math.max(1, Math.floor((now - last) / DAY)) });
  }
  return out;
}
