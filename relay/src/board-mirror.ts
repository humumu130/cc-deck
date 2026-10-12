// W-TASKFLOW（2026-10-12，用户拍板②「唯一事实源强制」）：看板 → PM 会话任务清单
// 单向同步器——org 看板（<orgDir>/boards/<gid>.json，relay 持久化）= 团队任务唯一
// 事实源；PM（Leader）会话任务清单降级为**镜像视图**：从看板单向投影渲染，禁止
// 反向写（本模块全部函数只读看板、只产 TodoItem 形状的内存镜像，无任何看板写路径
// ——「会话清单改动不回写看板」由模块边界保证，测试件锁死）。
//
// 设计文档：docs/design/task-lifecycle.md（生命周期状态机/责任者/超时升级/渐进迁移）。
//
// 与既有件的关系（不重建双源）：
// - 派单联动（ccops 锁死 org dispatch → 自动建卡 claimed → 收口搬卡）是看板自身的
//   写路径，本模块不碰；镜像只是读侧投影。
// - pollTaskStore（#206 权威任务清单轮询）仍是 PM 自建任务的读路径；setTodos 咽喉
//   （session-manager）对 Leader 会话调本模块 mergeBoardMirror 合成「磁盘自建 + 看板
//   镜像」。lastStoreTodos 缓存/diff/TASK_DONE 完成汇报全部基于磁盘可见集——镜像
//   不污染既有判定。
// - 完结回收：done 是终态（D14 卡态不回转），done 卡不进镜像 = 镜像视图里即刻回收。
import { listGroupsByStatus, loadBoard } from "./projects.js";
import type { BoardEntry, BoardEntryStatus } from "./projects.js";
import type { TodoItem } from "./types.js";

/** 镜像条目扩展标记（TodoItem 可选字段，磁盘 CLI 任务存储无此字段——天然区隔） */
export interface BoardMirrorTodo extends TodoItem {
  source: "board";
  board_ref: { gid: string; entry_id: string };
}

// 板态 → 三态渲染映射 + content 徽标词（五态语义不动，仅渲染投影；区分靠徽标词）：
// backlog=待认领（pending 档）；claimed/submitted/ready_to_install 都是「流程中」
// （in_progress 档）；done 不进镜像（完结回收）。 parked/archived 组板冻结——
// listGroupsByStatus().active 只投在办组，挂起组的卡随组冻结退出镜像（恢复在办
// 自动回来），与「板冻结只读」语义（projects.ts §2.2）同源。
const BOARD_STATUS_PROJECTION: Record<Exclude<BoardEntryStatus, "done">, { status: "pending" | "in_progress"; label: string }> = {
  backlog: { status: "pending", label: "待认领" },
  claimed: { status: "in_progress", label: "进行中" },
  submitted: { status: "in_progress", label: "待复核" },
  ready_to_install: { status: "in_progress", label: "待装机" },
};

export function isBoardMirror(t: TodoItem): t is BoardMirrorTodo {
  return (t as Partial<BoardMirrorTodo>).source === "board"
    && !!t.board_ref
    && typeof t.board_ref.gid === "string" && typeof t.board_ref.entry_id === "string";
}

/** 剥离判定（宽松）：source 标记在场即剥——board_ref 缺失的畸形镜像无法对账，
 * 重合成时按坏数据处理剥掉（宁剥勿留：留驻=对账恒 extra 噪音）。合并/剥离专用；
 * isBoardMirror（严格版）用于 diff 键定位。 */
export function isMirrorMarked(t: TodoItem): boolean {
  return (t as Partial<BoardMirrorTodo>).source === "board";
}

/** 镜像键（对账/幂等剥离共用）：组 id + 卡 id 唯一定位一张板卡 */
export function mirrorKey(ref: { gid: string; entry_id: string }): string {
  return `${ref.gid}:${ref.entry_id}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 看板 → 镜像条目投影（纯读，无写路径）。全部 active 组的板，非 done 卡逐张产出：
 * content = `[组名·板态] 卡文本`（组名 8 字、卡文本 80 字截断——对齐 dutySnapshot
 * truncate 口径）；updated_at 取卡 updated_at（端上「近 1 天」完成窗口等既有消费
 * 天然兼容）；无数字 id（#NNN 跳转面自然跳过镜像条目）。排序：组创建序 → 卡 ts。
 */
export function boardMirrorTodos(dir?: string): BoardMirrorTodo[] {
  const out: BoardMirrorTodo[] = [];
  const groups = listGroupsByStatus(dir).active;
  for (const g of groups) {
    const board = loadBoard(g.id, dir);
    for (const e of board.entries) {
      if (e.status === "done") continue; // 完结回收：终态卡不进镜像
      const proj = BOARD_STATUS_PROJECTION[e.status];
      if (!proj) continue; // 词表外未知值（migrateBoardStatuses 保留态）不投影不炸
      out.push({
        content: `[${clip(g.name, 8)}·${proj.label}] ${clip(e.text, 80)}`,
        status: proj.status,
        updated_at: e.updated_at,
        source: "board",
        board_ref: { gid: g.id, entry_id: e.id },
      });
    }
  }
  return out;
}

/**
 * 合成：磁盘自建任务 + 看板镜像（幂等——先剥旧镜像再拼新投影，重复调用稳定；
 * 磁盘侧混入 source 污染值防御性剔除：CLI 任务存储不产该字段，出现即脏数据）。
 * 单向性：本函数只读看板（boardMirrorTodos）只产合并数组——不写任何看板文件。
 */
export function mergeBoardMirror(diskTodos: readonly TodoItem[], dir?: string): TodoItem[] {
  const disk = diskTodos.filter((t) => !isMirrorMarked(t));
  return [...disk, ...boardMirrorTodos(dir)];
}

// ---------- 对账看门 v2（W-TASKFLOW：v1 只报告不搬 → v2 强制以看板为准回写+报警） ----------

export interface MirrorDiff {
  /** 看板有、镜像缺（同步漏推/被外部洗掉） */
  missing: BoardMirrorTodo[];
  /** 都在但内容/状态过期（板已搬泳道，镜像还是旧态） */
  stale: BoardMirrorTodo[];
  /** 镜像有、看板无（卡被删/组挂起冻结/done 后未回收——镜像残留） */
  extra: BoardMirrorTodo[];
  /** 期望与实际全部一致（健康态——看门零动作） */
  clean: boolean;
}

/** 对账纯函数：期望镜像（看板投影）vs 实际镜像（会话清单里的 source=board 条目） */
export function mirrorDiff(actual: readonly TodoItem[], dir?: string): MirrorDiff {
  const expected = boardMirrorTodos(dir);
  const expByKey = new Map(expected.map((m) => [mirrorKey(m.board_ref), m]));
  const actByKey = new Map(
    actual.filter(isBoardMirror).map((m) => [mirrorKey(m.board_ref), m] as const),
  );
  const missing: BoardMirrorTodo[] = [];
  const stale: BoardMirrorTodo[] = [];
  for (const [k, exp] of expByKey) {
    const act = actByKey.get(k);
    if (!act) missing.push(exp);
    else if (act.content !== exp.content || act.status !== exp.status) stale.push(exp);
  }
  const extra = [...actByKey.values()].filter((m) => !expByKey.has(mirrorKey(m.board_ref)));
  return { missing, stale, extra, clean: missing.length === 0 && stale.length === 0 && extra.length === 0 };
}

// ---------- 超时升级（生命周期定案：claimed > 48h 无进展 → 升级用户可见） ----------

/** 升级窗口缺省 48h（任务生命周期定案）；env 可调（测试缝，同 dutyStaleMs 范式） */
export function boardEscalateMs(): number {
  const v = Number(process.env.CCR_BOARD_ESCALATE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 48 * 3600_000;
}

export interface EscalatedCard {
  gid: string;
  group_name: string;
  entry_id: string;
  text: string;
  age_ms: number;
}

/**
 * claimed 超窗扫描（纯读）：claimed 卡龄（板 updated_at 距今）超窗即升级候选。
 * 与 dutyStaleMs（90min stale_doing 喂 PM，019 §5.1）分工：那个是「值守催办」，
 * 本函数是「生命周期硬升级」——PM 催了两 天仍无进展，捅到用户通知面。
 * 无进展口径 = 卡 updated_at（任何泳道迁移/编辑都刷新它；派单收口联动搬卡也走
 * upsertBoardEntry/moveBoardEntry 刷它）。
 */
export function escalateClaimed(now: number, dir?: string): EscalatedCard[] {
  const window = boardEscalateMs();
  const out: EscalatedCard[] = [];
  for (const g of listGroupsByStatus(dir).active) {
    const board = loadBoard(g.id, dir);
    for (const e of board.entries as BoardEntry[]) {
      if (e.status !== "claimed") continue;
      const age = now - e.updated_at;
      if (age >= window) out.push({ gid: g.id, group_name: g.name, entry_id: e.id, text: clip(e.text, 60), age_ms: age });
    }
  }
  return out;
}

