// W-REVIEWSEAT（1105 用户拍板「落实到 cc-deck 产品里」）：评审席产品化——全局评审池
// 配置 store + 池组 ensure + SNAPSHOT 帧数据组装。
// 设计口径（PM 裁定已获认可）：全局池为底座 + 团队专属配额 override + 设置面动态调整。
// 池语义=org 组编制复用：固定 gid 的「评审池」组（headcount=评审员席，role=reviewer），
// 编制/路由/审计/org CLI 成员管理全套既有机制零新造；本模块只管「配置 + 组生命周期 +
// 只读数据组装」。store=<orgDir>/review-seat.json（rules.json/experience.json 同款纯 fs，
// 无环不 import session-manager）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir } from "./org.js";
import { findGroup, listGroups, setGroupHeadcountCap, createGroup, setGroupStatus, decideConfirm } from "./projects.js";

// 池组 gid 非字面量固定（org 组 id 由 createGroup 生成不可指定）——**权威=store.pool_gid**
//（首建组时写入；REVIEW_POOL_GID 仅作「未初始化」哨兵）。三面（路由/配置/看板）统一经
// reviewPoolGid() 取值，勿直接消费常量。
export const REVIEW_POOL_SENTINEL = ""; // 未初始化哨兵（空串）
export const REVIEWER_ROLE = "reviewer"; // 岗位 role 键（bizRole 词表 review 通道在 session-manager 侧；此处=编制席位标注）

export interface ReviewSeatConfig {
  enabled: boolean; // 总闸：false=路由跳过池层（互审直接落 PM 兜底）
  default_size: number; // 池缺省大小（池组 headcount_cap 同步源；1..8 钳位）
  team_override: Record<string, number>; // 团队专属配额（gid→本组专属评审席目标数；组内 role=reviewer 席位数由 PM 用 member-add 配置，此值=配置声明+路由参考）
  pool_gid: string; // 池组 gid（首建写入；空=未初始化——ensureReviewPoolGroup 建组后回写）
  updated_at: number;
}

interface ReviewSeatFile {
  schema_version: 1;
  config: ReviewSeatConfig;
}

function seatPath(dir?: string): string {
  return join(dir ?? orgDir(), "review-seat.json");
}

export function defaultReviewSeatConfig(): ReviewSeatConfig {
  return { enabled: true, default_size: 2, team_override: {}, pool_gid: REVIEW_POOL_SENTINEL, updated_at: Date.now() };
}

/** 读配置：坏档/缺省 → 缺省值（fail-open——评审池是路由增强层不是权限轴，坏档不锁路由）。 */
export function readReviewSeatConfig(dir?: string): ReviewSeatConfig {
  try {
    const raw = JSON.parse(readFileSync(seatPath(dir), "utf-8")) as Partial<ReviewSeatFile>;
    const c = raw && typeof raw === "object" ? raw.config : null;
    if (!c || typeof c !== "object") return defaultReviewSeatConfig();
    const size = Number(c.default_size);
    const ov: Record<string, number> = {};
    if (c.team_override && typeof c.team_override === "object") {
      for (const [k, v] of Object.entries(c.team_override)) {
        const n = Number(v);
        if (typeof k === "string" && k.startsWith("pg-") && Number.isFinite(n) && n >= 0) ov[k] = Math.min(8, Math.floor(n)); // >8 钳位（与 size 同语义，不弃值）
      }
    }
    return {
      enabled: c.enabled !== false,
      default_size: Number.isFinite(size) ? Math.max(1, Math.min(8, Math.floor(size))) : 2,
      team_override: ov,
      pool_gid: typeof c.pool_gid === "string" && c.pool_gid.startsWith("pg-") ? c.pool_gid : REVIEW_POOL_SENTINEL,
      updated_at: Number(c.updated_at) || Date.now(),
    };
  } catch {
    return defaultReviewSeatConfig();
  }
}

/** 写配置（原子写 tmp+rename，rules.json 同款）。写后池组 headcount_cap 同步=default_size
 * （池大小的权威落点=组编制面——设置面改大小即改组 cap，成员增删走 org member-add/remove）。 */
export function writeReviewSeatConfig(patch: Partial<Pick<ReviewSeatConfig, "enabled" | "default_size" | "team_override">> & { pool_gid?: string }, dir?: string): ReviewSeatConfig {
  const cur = readReviewSeatConfig(dir);
  const next: ReviewSeatConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    default_size: typeof patch.default_size === "number" ? Math.max(1, Math.min(8, Math.floor(patch.default_size))) : cur.default_size,
    team_override: (() => {
      if (!patch.team_override || typeof patch.team_override !== "object") return cur.team_override;
      const ov: Record<string, number> = {};
      for (const [k, v] of Object.entries(patch.team_override)) {
        const n = Number(v);
        if (typeof k === "string" && k.startsWith("pg-") && Number.isFinite(n) && n >= 0) ov[k] = Math.min(8, Math.floor(n));
      }
      return ov;
    })(),
    pool_gid: typeof patch.pool_gid === "string" && patch.pool_gid.startsWith("pg-") ? patch.pool_gid : cur.pool_gid,
    updated_at: Date.now(),
  };
  const d = dir ?? orgDir();
  try {
    mkdirSync(d, { recursive: true });
    const body: ReviewSeatFile = { schema_version: 1, config: next };
    const p = seatPath(d);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch { /* 写失败抛给调用方 orgAction 报错（配置面要响亮） */ }
  syncPoolCap(next, d, next.pool_gid);
  return next;
}

/** 池组生命周期：无则建（name=评审池，headcount_cap=default_size）；有则 cap 对齐配置。
 * 幂等；组被人手动删=下次调用重建（gid 固定锚定）。 */
export function ensureReviewPoolGroup(dir?: string): void {
  let cfg = readReviewSeatConfig(dir);
  let g = cfg.pool_gid ? findGroup(cfg.pool_gid) : null;
  if (!g) {
    // 兼容：按 name 找既有「评审池」组（store 丢失但组建在的半初始化态）
    const legacy = listGroups().find((x) => x.name === "评审池" && x.anchor_dir.endsWith("review-pool"));
    if (legacy) g = legacy;
  }
  if (!g) {
    try {
      const anchor = join(orgDirDir(dir), "review-pool");
      try { mkdirSync(anchor, { recursive: true }); } catch { /* 已在 */ }
      const r = createGroup({ name: "评审池", anchor_dir: anchor, tier: "轻立项", headcount: [] });
      // 池组=系统组件非用户项目：轻立项首建走 pending+确认卡（信任未累积）——确认卡是
      // 用户对「项目」的主权面，评审池是产品自身的编制面，不走卡：直接 active + 卡撤
      //（decideConfirm ✗ 弃卡——组激活由 setGroupStatus 承担，副作用单口不双写）。
      if (r.ok && r.needsConfirm && r.confirm) { try { decideConfirm(r.confirm.id, false, "review-seat-system", dir); } catch { /* 卡残留无害 */ } } // 弃卡：系统组件不走用户确认面（防 pending 污染）
      void dir;
      const created = r.ok && r.group ? findGroup(r.group.id) : null;
      if (created) {
        if (created.status === "pending") { try { setGroupStatus(created.id, "active"); g = findGroup(created.id) ?? created; } catch { g = created; } }
        else g = created;
      }
    } catch { /* 校验拒/竞态——g 仍空则本次跳过（不炸调用方） */ }
    if (!g) return;
    if (g.id !== cfg.pool_gid) { cfg = writeReviewSeatConfig({ pool_gid: g.id }, dir); } // 首建/找回：gid 回写 store（权威）
  }
  syncPoolCap(cfg, dir, g.id);
}

/** 池组 gid 现取（路由/快照统一口——空=未初始化）。 */
export function reviewPoolGid(dir?: string): string {
  return readReviewSeatConfig(dir).pool_gid;
}

function orgDirDir(dir?: string): string {
  return dir ?? orgDir();
}

function syncPoolCap(cfg: ReviewSeatConfig, dir: string | undefined, gid: string): void {
  void dir;
  try {
    if (gid && findGroup(gid) && typeof cfg.default_size === "number") setGroupHeadcountCap(gid, cfg.default_size);
  } catch { /* cap 同步尽力而为（组不在/写失败——下次写再同步） */ }
}

/** 池组只读现状（SNAPSHOT/orgAction 共用）：席位（sid+role+engine+model）+在编数+模型分布。 */
export function reviewPoolSnapshot(): { gid: string; seats: { session_id: string; role: string; engine?: string; model?: string }[]; size: number; cap: number; engine_dist: Record<string, number> } {
  const gid = reviewPoolGid();
  const g = gid ? findGroup(gid) : null;
  const seats = (g?.headcount ?? []).map((h) => ({ session_id: h.session_id, role: h.role || "worker", ...(h.engine ? { engine: h.engine } : {}), ...(h.model ? { model: h.model } : {}) }));
  const engine_dist: Record<string, number> = {};
  for (const s of seats) { const k = s.engine || "claude"; engine_dist[k] = (engine_dist[k] || 0) + 1; }
  return { gid, seats, size: seats.length, cap: g?.headcount_cap ?? readReviewSeatConfig().default_size, engine_dist };
}

/** 团队专属评审席快照（路由第二跳+设置页展示）：本组 headcount 中 role=reviewer 的席。 */
export function teamReviewerSeats(gid: string): { session_id: string; engine?: string; model?: string }[] {
  const g = findGroup(gid);
  if (!g) return [];
  return (g.headcount ?? []).filter((h) => (h.role || "").toLowerCase() === REVIEWER_ROLE || (h.role || "") === "评审员")
    .map((h) => ({ session_id: h.session_id, ...(h.engine ? { engine: h.engine } : {}), ...(h.model ? { model: h.model } : {}) }));
}

/** SNAPSHOT.review_seat 帧数据（设置页数据源）：配置+池现状+各团队 override 生效值。 */
export function reviewSeatSnapshotPayload(): { enabled: boolean; default_size: number; pool: ReturnType<typeof reviewPoolSnapshot>; team_override: Record<string, number>; teams: { gid: string; name: string; declared: number; actual: number }[] } {
  const cfg = readReviewSeatConfig();
  const poolGid = reviewPoolGid();
  const teams = listGroups()
    .filter((g) => g.id !== poolGid)
    .map((g) => ({ gid: g.id, name: g.name, declared: cfg.team_override[g.id] ?? 0, actual: teamReviewerSeats(g.id).length }));
  return { enabled: cfg.enabled, default_size: cfg.default_size, pool: reviewPoolSnapshot(), team_override: cfg.team_override, teams };
}

export function reviewSeatPathForTest(dir: string): string { return seatPath(dir); }
export function reviewSeatStoreExists(dir?: string): boolean { return existsSync(seatPath(dir)); }
