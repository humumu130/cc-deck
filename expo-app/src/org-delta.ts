// M13-4 delta 投影消费纯函数（#115 M13-2 定案的 expo 端消费面 + M13-4ADD 锚定纪律）。
// 零依赖纯 TS（只 import type）——store.ts 的 UPDATED case 调用 + scripts/test-delta-merge.ts
// 直跑断言共用同一条判定/merge 路径，保证「测的就是跑的」。
//
// 消费门（三重，缺一回落覆盖式或丢弃）：
// ① 帧级：payload.delta != null（M13-2 帧级判定口径）
// ② 能力级：source_capabilities.projection_v2 === true（SNAPSHOT 透传；缺席=旧 relay
//    口径，不认 delta——relay_status 无版本位，这是唯一的 v2 信号）
// ③ 锚定级（M13-4ADD，M13-REV P1 裁定）：delta 流无缺口检测（瞬态帧 seq:0 不补发），
//    未锚定（该 gid 从未消费过覆盖式全量基线）收到 delta = 差分应用在错误基线，静默
//    错乱不自愈——未锚定 delta 一律丢弃；板域触发 COMMAND_PROJECT_DETAIL 重拉重锚定；
//    projects 域由 SNAPSHOT.projects 天然锚定（无重拉面，等下一快照）。
//    禁止路径：基线缺失→空板起底 merge。
// 覆盖式分支 = 旧字段消费（groups/board），与 M13-2 前行为逐字节一致。
//
// 幂等铁律（relay types.ts:620 镜像）：upserts=完整条目按 id 整条替换（原位保序，
// 新 id 追加尾）、removes 剔除（未知 id=no-op）——同帧重放二次应用零变化。
import type {
  BoardDelta,
  BoardEntry,
  EntityDelta,
  LessonEntry,
  ProjectBoard,
  ProjectGroup,
} from "./protocol";

// ---------- 条目防御尺（覆盖式消费同款口径，畸形条目不进缓存） ----------

export function isProjectGroup(x: unknown): x is ProjectGroup {
  const g = x as ProjectGroup | undefined;
  return !!g && typeof g.id === "string" && !!g.id && typeof g.name === "string" && !!g.name;
}

// status 只查 string 不锁值域——D18 五态迁移（独立单）前后都透传，前向兼容不出假泳道
export function isBoardEntry(x: unknown): x is BoardEntry {
  const e = x as BoardEntry | undefined;
  return !!e && typeof e.id === "string" && !!e.id && typeof e.text === "string" && typeof e.status === "string";
}

export function isLessonEntry(x: unknown): x is LessonEntry {
  const l = x as LessonEntry | undefined;
  return !!l && typeof l.id === "string" && !!l.id && typeof l.text === "string" && typeof l.ts === "number";
}

// ---------- delta 形状校验（畸形 delta 回落覆盖式，不认半截帧） ----------

export function isEntityDelta<T extends { id: string }>(
  v: unknown,
  validItem: (x: unknown) => x is T,
): v is EntityDelta<T> {
  const d = v as EntityDelta<T> | undefined;
  return (
    !!d &&
    typeof d === "object" &&
    Array.isArray(d.upserts) &&
    Array.isArray(d.removes) &&
    d.upserts.every(validItem)
  );
}

export function isBoardDelta(v: unknown): v is BoardDelta {
  const d = v as BoardDelta | undefined;
  return !!d && typeof d === "object" && isEntityDelta<BoardEntry>(d.entries, isBoardEntry);
}

// ---------- merge 核心（幂等：同帧重放二次应用零变化） ----------

/** upserts 原位整条替换（保序）、新 id 追加尾、removes 挖除（未知 id=no-op） */
export function mergeById<T extends { id: string }>(
  list: T[],
  delta: EntityDelta<T>,
  validItem: (x: unknown) => x is T,
): T[] {
  const upserts = delta.upserts.filter(validItem);
  const removes = new Set(delta.removes.filter((id) => typeof id === "string"));
  const patched = new Map<string, T>();
  for (const u of upserts) patched.set(u.id, u);
  const out: T[] = [];
  const replaced = new Set<string>();
  for (const item of list) {
    if (removes.has(item.id)) continue; // 挖除；removes 里的未知 id 天然 no-op（幂等）
    const hit = patched.get(item.id);
    if (hit) {
      out.push(hit); // 原位整条替换（保序）
      replaced.add(hit.id);
      continue;
    }
    out.push(item);
  }
  for (const u of upserts) {
    if (!replaced.has(u.id)) out.push(u); // 新 id 追加尾（原位不可知——组内新条目落尾，UI 按 status 分组不受影响）
  }
  return out;
}

/** 板 delta merge：entries/lessons 同语义；meta 承载 frozen 翻转与 updated_at 推进 */
export function mergeBoard(prev: ProjectBoard, delta: BoardDelta): ProjectBoard {
  const lessonsDelta: EntityDelta<LessonEntry> =
    delta.lessons && isEntityDelta<LessonEntry>(delta.lessons, isLessonEntry)
      ? delta.lessons
      : { upserts: [], removes: [] };
  const lessons = mergeById(prev.lessons ?? [], lessonsDelta, isLessonEntry);
  const updatedAt =
    typeof delta.meta?.updated_at === "number"
      ? delta.meta.updated_at
      : typeof prev.updated_at === "number"
        ? prev.updated_at
        : undefined;
  return {
    gid: prev.gid,
    frozen: typeof delta.meta?.frozen === "boolean" ? delta.meta.frozen : prev.frozen,
    entries: mergeById(prev.entries, delta.entries, isBoardEntry),
    ...(lessons.length ? { lessons } : {}), // 空分区不落字段（与 relay 旧文件板缺省形态对齐）
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
  };
}

// ---------- 帧消费入口（效果对象模式：纯函数输出指令，store case 薄应用+副作用） ----------

/** PROJECTS_UPDATED 帧效果：projects 有值 = 应用；无 = store 不变（drop/invalid） */
export interface ProjectsFrameEffect {
  projects?: ProjectGroup[];
}

/**
 * PROJECTS_UPDATED 帧消费。
 * - v2 门内 delta：锚定（prev 非 null = 快照或覆盖式消费过）→ merge；未锚定（prev
 *   为 null）→ drop（SNAPSHOT.projects 天然锚定兜底，无重拉面——M13-4ADD）
 * - 覆盖式（delta 缺席/畸形/v2 门关）：消费 groups（现状口径），覆盖式帧确立锚定
 *   （消费后 prev 非 null，由调用方状态自然承载，无需显式标记）
 */
export function applyProjectsFrame(
  prev: ProjectGroup[] | null,
  payload: unknown,
  projectionV2: boolean,
): ProjectsFrameEffect {
  const p = payload as { groups?: unknown; delta?: unknown } | undefined;
  const d = p?.delta;
  if (d != null && projectionV2 === true) {
    // 锚定前置：prev null = 从未收到快照/覆盖式（基线缺失）→ delta 丢弃
    if (isEntityDelta<ProjectGroup>(d, isProjectGroup) && prev !== null) {
      return { projects: mergeById(prev, d, isProjectGroup) };
    }
    // 未锚定 delta（或畸形 delta）→ 落到覆盖式分支：同帧 groups 全量可消费则消费
    //（畸形 delta 回落覆盖式 = 同帧全量兜底，好于整帧丢弃）；无 groups 则 drop
  }
  const gs = p?.groups;
  if (Array.isArray(gs)) {
    // 覆盖式分支与 M13-2 前现状逐字节一致（原 filter 表达式原样保留——降级断言基准）
    return {
      projects: gs.filter((g): g is ProjectGroup => !!g && typeof (g as ProjectGroup).id === "string" && !!(g as ProjectGroup).name),
    };
  }
  return {}; // 帧无效，store 不变
}

/** BOARD_UPDATED 帧效果：board 有值 = set 缓存（anchor=true 时同时锚定）；resyncGid 有值 = 未锚定 delta 已丢弃，需重拉重锚定 */
export interface BoardFrameEffect {
  board?: ProjectBoard;
  anchor?: boolean;
  resyncGid?: string;
}

/**
 * BOARD_UPDATED 帧消费（M13-4ADD 锚定纪律）。
 * - v2 门内合法 delta：锚定（anchored=true 且 prev 在）→ merge（board，锚定态不变）；
 *   未锚定 → **丢弃 + resyncGid**（store 不变，调用方触发 COMMAND_PROJECT_DETAIL 重拉，
 *   ack 回 board 全量消费后重新锚定）——禁止空板起底 merge
 * - 覆盖式（delta 缺席/v2 门关/畸形 delta 回落）：消费 board 全量 → board+anchor:true
 *   （覆盖式帧即锚定帧：基线来自全量）
 * - 帧无效 → {}（store 不变）
 */
export function applyBoardFrame(
  prevBoard: ProjectBoard | undefined,
  anchored: boolean,
  payload: unknown,
  projectionV2: boolean,
): BoardFrameEffect {
  const p = payload as { gid?: unknown; board?: unknown; delta?: unknown } | undefined;
  const gid = p?.gid;
  if (typeof gid !== "string") return {}; // 现状口径：只查 string，不查非空
  const cover = (): BoardFrameEffect | null => {
    const b = p?.board as ProjectBoard | undefined;
    if (b && Array.isArray(b.entries)) return { board: b, anchor: true };
    return null;
  };
  const d = p?.delta;
  if (d != null && projectionV2 === true) {
    if (isBoardDelta(d)) {
      // 锚定前置：未锚定（含 prev 缺失）一律丢弃 + 重拉——禁止空板起底 merge
      if (!anchored || !prevBoard) return { resyncGid: gid };
      return { board: mergeBoard(prevBoard, d) }; // 已锚定：锚定态维持，无需再标
    }
    // 畸形 delta → 回落覆盖式（同帧 board 全量兜底，好于整帧丢弃）
  }
  return cover() ?? {};
}
