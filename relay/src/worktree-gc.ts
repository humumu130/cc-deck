// W-TREEGC（1104 夜双事故，t-25402636）：worktree GC 单口——治理系统内**唯一**合法
// 的树处置入口。事故链定罪（chain-audit 3096/3098）：relay 重启→在途单断档补记
// status=done（receipt=「relay 重启，回合中断」，worker 空/零提交静默关单）→
// notifyDispatchClosed→scanClearWorktreeLocks 清树锁→树裸奔→22:1x 被外部清理物理删除
// （bin 三脚本 grep 全无真删=删除发生在治理系统之外，零防线零留痕）。
//
// 本模块纪律（任务书改动①）：
//   - **永不物理删除**：处置上限=移隔离区（/private/tmp/cc-deck-quarantine-<ts>-<name>/，
//     保留 48h 人工可救）——吃稿事故的根治口径是「删错也救得回」；
//   - 脏树/活树一律不处置：判活三证据=活锁（.cc-deck-lock 未过期）/git 脏
//     （status --porcelain 非空）/近期活跃（最近文件 mtime <24h）——任一命中即跳过；
//   - 每次处置落审计账 org/worktree-gc-audit.jsonl（ts/树/判死理由/去向）——堵
//     「清理零留痕」缺口；跳过也记（skip 行，观测面）。
// 纯 fs/git 子进程底座（org.ts 同范式）：不 import session-manager（无环）。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorktreeLock } from "./dispatch-lock.js";
import { orgDir } from "./org.js";

export interface WorktreeGcAuditEntry {
  ts: number;
  tree: string;
  verdict: "quarantined" | "skipped-alive" | "prunable-healed";
  reason: string;
  /** quarantined 时的去向目录 */
  movedTo?: string;
}

const GC_AUDIT_NAME = "worktree-gc-audit.jsonl";
export const WT_ACTIVE_MTIME_MS = 24 * 3600_000; // 近期活跃窗（任务书口径 <24h）

function auditPath(): string {
  return join(orgDir(), GC_AUDIT_NAME);
}

function appendAudit(entry: WorktreeGcAuditEntry): void {
  try {
    appendFileSync(auditPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* 审计尽力而为：不阻断处置主路径 */ }
}

/** 树内最近文件 mtime（浅扫两层，够判活；.git 目录跳过——worktree 的 .git 是文件） */
export function newestMtimeWithin(dir: string, depth = 2): number {
  let newest = 0;
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = join(dir, ent.name);
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (ent.isDirectory() && depth > 1) {
          const inner = newestMtimeWithin(p, depth - 1);
          if (inner > newest) newest = inner;
        }
      } catch { /* 单项失败跳过 */ }
    }
  } catch { /* 目录不可读=0 */ }
  return newest;
}

/** git 脏判定（status --porcelain 非空=脏）。非 git 目录=干净（无未提交概念）。 */
export function worktreeDirty(dir: string): boolean {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf-8", timeout: 10_000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface WorktreeVerdict {
  alive: boolean;
  reasons: string[]; // 判活证据（alive=true）/判死理由（alive=false）
}

/** 判活单点：三证据任一命中=活（不处置）。 */
export function inspectWorktree(dir: string, now = Date.now()): WorktreeVerdict {
  const reasons: string[] = [];
  if (!existsSync(dir)) return { alive: false, reasons: ["目录不存在"] };
  const lock = readWorktreeLock(dir, now);
  if (lock) reasons.push(`活锁在（slug=${lock.slug}${lock.dispatch_id ? ` 单#${lock.dispatch_id.slice(0, 8)}` : ""}，${Math.round((lock.expires_at - now) / 60_000)}min 后过期）`);
  if (worktreeDirty(dir)) reasons.push("git 脏（未提交改动在树）");
  const mtime = newestMtimeWithin(dir);
  if (mtime > 0 && now - mtime < WT_ACTIVE_MTIME_MS) reasons.push(`近期活跃（最近 mtime ${Math.round((now - mtime) / 60_000)}min 前 <24h）`);
  return { alive: reasons.length > 0, reasons };
}

/** 隔离处置：mv 到 /private/tmp/cc-deck-quarantine-<ts>-<name>/（保留 48h）。活树拒收。 */
export function quarantineWorktree(dir: string, actor = "sweep", now = Date.now()): { ok: boolean; movedTo?: string; verdict: WorktreeVerdict } {
  const verdict = inspectWorktree(dir, now);
  if (verdict.alive) {
    appendAudit({ ts: now, tree: dir, verdict: "skipped-alive", reason: verdict.reasons.join("；") });
    return { ok: false, verdict };
  }
  const name = dir.split("/").pop() || "worktree";
  const dest = join("/private/tmp", `cc-deck-quarantine-${Math.floor(now / 1000)}-${name}`);
  try {
    mkdirSync("/private/tmp", { recursive: true });
    renameSync(dir, dest); // mv 同盘原子（/private/tmp 内）
    appendAudit({ ts: now, tree: dir, verdict: "quarantined", reason: `${verdict.reasons.join("；") || "全证据判死"}；by=${actor}；保留 48h`, movedTo: dest });
    return { ok: true, movedTo: dest, verdict };
  } catch (e) {
    appendAudit({ ts: now, tree: dir, verdict: "skipped-alive", reason: `隔离失败（fs 异常）：${e instanceof Error ? e.message : String(e)}` });
    return { ok: false, verdict };
  }
}

/** 批量清扫：CCR_WT_ROOT（缺省 /private/tmp）下 cc-deck-w-* 逐树处置（活树跳过也留痕）。 */
export function sweepStaleWorktrees(root?: string, actor = "sweep", now = Date.now()): WorktreeGcAuditEntry[] {
  const wtRoot = root ?? process.env.CCR_WT_ROOT ?? "/private/tmp";
  const results: WorktreeGcAuditEntry[] = [];
  try {
    for (const name of readdirSync(wtRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || !name.name.includes("cc-deck-w")) continue;
      const dir = join(wtRoot, name.name);
      // 排除本模块隔离区与树锁临时目录
      if (name.name.includes("cc-deck-quarantine-")) continue;
      const r = quarantineWorktree(dir, actor, now);
      results.push(r.ok
        ? { ts: now, tree: dir, verdict: "quarantined", reason: r.verdict.reasons.join("；"), movedTo: r.movedTo }
        : { ts: now, tree: dir, verdict: "skipped-alive", reason: r.verdict.reasons.join("；") });
    }
  } catch { /* 根不可读：无事可做 */ }
  return results;
}

/** prunable 残留自愈（任务书改动③）：worktree list 与磁盘对账——登记在册但磁盘
 * 缺失（git worktree list 标 prunable/目录不存在）→ git worktree prune + 审计留痕。
 * 只清「目录确实没了」的登记（保守：磁盘在的一律不动，哪怕 git 标 prunable）。 */
export function healPrunableWorktrees(repo: string, now = Date.now()): string[] {
  const healed: string[] = [];
  try {
    const out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8", timeout: 10_000 });
    for (const block of out.split("\n\n")) {
      const m = block.match(/^worktree (.+)$/m);
      if (!m) continue;
      const wt = m[1];
      if (wt === repo) continue; // 主检出不动
      if (existsSync(wt)) continue; // 磁盘在=不碰（哪怕 prunable 标记——目录活着可能正被用）
      execFileSync("git", ["-C", repo, "worktree", "prune"], { timeout: 10_000 });
      healed.push(wt);
      appendAudit({ ts: now, tree: wt, verdict: "prunable-healed", reason: "目录已物理消失，git worktree prune 清登记" });
    }
  } catch { /* 尽力而为 */ }
  return healed;
}

/** 测试缝：审计账读取 */
export function readGcAudit(dir?: string): WorktreeGcAuditEntry[] {
  try {
    return readFileSync(join(dir ?? orgDir(), GC_AUDIT_NAME), "utf-8").split("\n")
      .filter(Boolean).map((l) => JSON.parse(l) as WorktreeGcAuditEntry);
  } catch {
    return [];
  }
}
