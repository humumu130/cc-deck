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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORG_LEADER_TITLE = "组织 Leader";

// 首建上岗引导消息：fresh parked CLI（空 prompt）在真实链路不回 init——SDK 会话 id
// 只在 CLI 收到首条输入后才产生（#49 既有实证；M1 真链路复现：parked 2 分钟零输出，
// 进程存活 CPU 闲置）。首建必须带这条上岗消息：① 拿到 sdkId（锚从此可 resume）；
// ② 执行 CLAUDE.md 种子的「上岗读档自检」。只此一回，之后常驻全走 resume 零新回合。
// 注意：走 create 的 initialPrompt（非 COMMAND_MESSAGE），C3 派单台账不会把它记成咨询。
export const ORG_LEADER_BOOTSTRAP_PROMPT =
  "（组织 Leader 上岗引导，系统消息）你已被创建为常驻组织的 Leader。请只做一件事：阅读本目录的 CLAUDE.md（组织记忆），然后用一两句话确认上岗——复述你在过渡期（M1）承接的两类事即可。不要执行其他操作、不要改动任何文件。";

export function orgDir(): string {
  return process.env.CCR_ORG_DIR || join(homedir(), ".cc-deck", "org");
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

export const ORG_CLAUDE_MD_SEED = `# 组织 CLAUDE.md —— 常驻组织的记忆与纪律

> 你在 org 目录工作（组织的家，不属于任何项目），本文件随会话自动加载。
> 个人层（用户手写的全局 CLAUDE.md / memory）优先——冲突时以个人层为准。

## 你的角色：组织 Leader

- 你是用户的技术合伙人：常驻、唯一、不隶属任何项目。
- 你持有两本账：
  1. 组织记忆 = 本文件（慢账：经验、偏好、方法论、坑）。
  2. 派单台账 = 同目录 dispatch-log.ndjson（快账：何时派了什么、结果如何；系统自动记录，勿手改）。
- 换壳不换档：你会被更换模型或重建会话，账是文件不是记忆。每次上岗先读本文件自检——能复述关键偏好即通过。

## 过渡期纪律（M1，直至 M2 收敛）

- 你只承接两类事：
  1. 咨询：技术判断、方案评审、答疑——直接回答，不立项、不动项目文件。
  2. 随手办分诊：几分钟内能闭环的小事可直接办；需要开团的明确转项目侧。
- 项目事务一律走对应项目的项目 Leader（N+1）：不越权指挥项目会话、不代管项目工作区。
- 此期间沟通线为 N+1（M2 收敛为 1）：不在项目内代替用户做组织层决策。

## 组织记忆写入纪律（宁缺毋滥）

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

## 组织信息

- 组织目录：本文件所在目录。
- 派单台账 / 会话锚：同目录 dispatch-log.ndjson / org.json（均系统维护，勿手改）。
`;

// 幂等种子：只首建、永不覆盖——Leader 上岗后会持续在本文件沉淀组织记忆，重启重播种子会
// 抹掉积累。existsSync 为准（内容不比对，存在即认）。
export function ensureOrgClaudeMd(dir?: string): "created" | "exists" {
  const p = orgFilePath("CLAUDE.md", dir);
  if (existsSync(p)) return "exists";
  writeFileSync(p, ORG_CLAUDE_MD_SEED, "utf-8");
  return "created";
}

// ---------- Leader 常驻锚（org.json） ----------

export interface OrgAnchor {
  version: 1;
  /** relay 会话 id（SessionManager.sessions 的 key / 端上卡片 id） */
  leader_session_id: string;
  /** 最新 CLI/SDK session id（resume 锚点；首建到 init 之间为空串，onInit 回填） */
  leader_sdk_id: string;
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
      created_at: typeof raw.created_at === "number" ? raw.created_at : 0,
      updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    };
  } catch {
    // 无锚 / 坏 JSON：等同未建组织
    return null;
  }
}

export function writeOrgAnchor(a: OrgAnchor, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(orgFilePath("org.json", d), JSON.stringify(a, null, 2) + "\n", "utf-8");
    return true;
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

export type DispatchTier = "咨询" | "随手办" | "轻立项" | "正经立项" | "暂缓";
export type DispatchStatus = "dispatched" | "running" | "done" | "failed";

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
}

export function dispatchLogPath(dir?: string): string {
  return orgFilePath("dispatch-log.ndjson", dir);
}

// 尽力而为：写失败只 warn 不抛——台账是审计面，绝不阻断消息投递/回合状态主路径。
// 无容量上限（append-only 审计语义，设计稿 §6.1 org_memory/dispatch_log 同口径）；
// M1 量级 = 每次咨询 2 行，无需轮转。
export function appendDispatch(e: DispatchEntry, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(dispatchLogPath(d), JSON.stringify(e) + "\n", { flag: "a" });
    return true;
  } catch (e2) {
    console.warn(`[org] 台账写入失败: ${e2 instanceof Error ? e2.message : String(e2)}`);
    return false;
  }
}

// 回读：逐行 parse 坏行跳过（仿 loadEvents——追加写被中断的半行不炸读侧）；
// 同 id 去重留最后（append-only 状态机的收敛视图）；返回最后 max 条分单。
export function readDispatchLog(dir?: string, max = 500): DispatchEntry[] {
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
}
