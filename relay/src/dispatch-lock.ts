// W-ORG-DEFECTS 件2（2026-11-01 用户 1101 定性产品缺陷 P0）——worktree 互斥锁底座。
// 事故回链：w-uifollowup-rebase.md「rebase 过程」节——外部会话与 worker 双双进入同一
// worktree（/private/tmp/cc-deck-w-uifollowup-rebase）并发 rebase，靠 mtime 取证+90s
// 停手观察土法互斥。本模块把互斥机制化：锁文件=worktree 根 .cc-deck-lock（.gitignore
// 已收录，不污染 worker 的 git status 认领纪律）。
//
// 语义（与 leader-dispatch/leader-harvest bash 侧约定同一 JSON 形态）：
//   持有 = 文件存在 && now < expires_at（缺省 2h 窗，OVERRIDE env 可调测试用）——
//   过期/坏 JSON = 陈锁，视为无人持有（惰性覆写，不报错）；
//   归属 = dispatch_id 在场时锁随单走（新单可覆写他人陈锁，但不得清他人活锁——
//   clearWorktreeLock(dispatchId) 只清自己单的锁，防误删后继单的新锁）。
//
// 本模块纯 fs 读写底座（org.ts/projects.ts 同范式）：绝不抛、不 import
// session-manager（无环）。写者=leader-dispatch 预建；读者=relay dispatchWorker
// 派单预检（他人活锁→拒派+audit worktree-busy）；清者=leader-harvest 收尾（随
// worktree remove 自然消失，显式清兜底）+relay dispatch 收口边 scanClear（按
// CCR_WT_ROOT 扫 .cc-deck-lock 的 dispatch_id 匹配收口单）。

import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface WorktreeLock {
  slug: string;
  /** 持有派单 id（bash 侧预建时尚未生成——空串=派单前哨锁，dispatchWorker 认领时补写） */
  dispatch_id?: string;
  session_id?: string;
  /** W-SESSIONMUTEX：持锁进程 pid（sid+pid 级细粒度）——认领边 pid 就绪时回写；
   * 同 sid 异 pid 进树=换代/接管语义（读侧 pid 差异可见，供孪生裁决——显式接管
   * 流在 treegc 域 wt-gc takeover 口，本层只做身份可见不做自动接管） */
  cli_pid?: number;
  created_at: number;
  expires_at: number;
}

export const WORKTREE_LOCK_FILE = ".cc-deck-lock";

// ── 返工② P0-②（B 档攻防 review-w-orgdefects-b-1101）：锁获取原子化 ──
// 病灶：check（worktreeHeldByOther/readWorktreeLock）与 write（writeWorktreeLock 覆写）
// 两步非原子——双 leader 同刻并发同 slug 时双双过预检、双双落锁、双双放行（B 档实测
// 直推 dispatch POST 零拒派）；坏锁半写态读侧 JSON.parse 失败=null=fail-open。
// 修法：O_EXCL（openSync 'wx'）独占建锁，EEXIST 即他人先到；陈锁接管走「临时文件+
// rename 原子替换+回读校验 created_at」——双竞争者同刻接管陈锁时 rename 后只有一人
// 的 created_at 留在盘上，回读不符者判负：任何竞态下恰一胜。
export type LockAcquireResult = { ok: true; lock: WorktreeLock } | { ok: false; held: WorktreeLock | null };

function buildLockBody(lock: Omit<WorktreeLock, "created_at" | "expires_at"> & { created_at?: number; expires_at?: number }): WorktreeLock {
  const now = lock.created_at ?? Date.now();
  return {
    slug: lock.slug,
    ...(lock.dispatch_id ? { dispatch_id: lock.dispatch_id } : {}),
    ...(lock.session_id ? { session_id: lock.session_id } : {}),
    ...(typeof lock.cli_pid === "number" && lock.cli_pid > 0 ? { cli_pid: lock.cli_pid } : {}),
    created_at: now,
    expires_at: lock.expires_at ?? now + worktreeLockWindowMs(),
  };
}

/** 原子接管陈锁：临时文件+rename+回读校验（双竞争者恰一胜——败者回读到赢者锁）。 */
function takeOverStale(worktree: string, full: WorktreeLock): LockAcquireResult {
  const p = lockPath(worktree);
  const body = JSON.stringify(full, null, 2) + "\n";
  let tmp = "";
  try {
    tmp = join(mkdtempSync(join(tmpdir(), "wtlock-")), WORKTREE_LOCK_FILE);
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, p); // 原子替换（盘上只剩最后 rename 者）
    const back = readWorktreeLock(worktree);
    if (back && back.dispatch_id === full.dispatch_id && back.session_id === full.session_id && back.created_at === full.created_at) {
      return { ok: true, lock: full }; // 回读=自己 → 我是最后 rename 者，持锁
    }
    return { ok: false, held: back }; // 回读=他人 → 输锁
  } catch {
    return { ok: false, held: readWorktreeLock(worktree) }; // fs 异常一律 fail-closed（B 档坏锁 fail-open 教训）
  } finally {
    if (tmp) { try { rmSync(tmp, { force: true, recursive: true }); } catch { /* 尽力而为 */ } }
  }
}

/** 原子获取（无主创建优先）：内容先行+link 原子上位——目标路径要么不存在、要么是
 * 完整 JSON（杜绝「O_EXCL 建空文件→写内容」窗口被并发读者读成半写态误判陈锁——
 * 8 进程并发实测 3 胜的病灶，与 B 档半写态 fail-open 同源）；EEXIST→活锁判负/陈锁接管。 */
export function acquireWorktreeLock(worktree: string, lock: Omit<WorktreeLock, "created_at" | "expires_at"> & { created_at?: number; expires_at?: number }): LockAcquireResult {
  const full = buildLockBody(lock);
  const p = lockPath(worktree);
  let tmpDir = "";
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "wtlock-"));
    const tmp = join(tmpDir, WORKTREE_LOCK_FILE);
    writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n", "utf-8"); // 先写满临时文件
    try {
      linkSync(tmp, p); // link 原子上位：目标已存在即 EEXIST；成功即内容完整
      return { ok: true, lock: full };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    const cur = readWorktreeLock(worktree);
    if (cur) return { ok: false, held: cur }; // 他人活锁：判负（含同 id——幂等续派走 claim）
    return takeOverStale(worktree, full); // 陈锁/坏锁：原子接管
  } catch {
    return { ok: false, held: readWorktreeLock(worktree) }; // fs 异常一律 fail-closed
  } finally {
    if (tmpDir) { try { rmSync(tmpDir, { force: true, recursive: true }); } catch { /* 尽力而为 */ } }
  }
}

/** 原子认领（relay 认领边）：无锁/陈锁→建；同 slug 哨兵锁（无 dispatch_id）→接管补写
 * 归属；自己 id 活锁→幂等重写；他人 id 活锁/异 slug 哨兵锁→判负（fail-closed）。 */
export function claimWorktreeLock(worktree: string, claim: { slug: string; dispatch_id: string; session_id?: string; created_at?: number; expires_at?: number }): LockAcquireResult {
  const cur = readWorktreeLock(worktree);
  if (!cur) return acquireWorktreeLock(worktree, claim);
  if (cur.dispatch_id) {
    if (cur.dispatch_id === claim.dispatch_id) {
      // 幂等重写自己锁（同 id：认领重放/续派）——覆写无竞害（归属不变）
      return { ok: true, lock: writeWorktreeLock(worktree, claim) };
    }
    return { ok: false, held: cur }; // 他人 id 活锁
  }
  if (cur.slug !== claim.slug) return { ok: false, held: cur }; // 异 slug 哨兵锁（别单在途）
  return takeOverStale(worktree, buildLockBody(claim)); // 同 slug 哨兵锁：原子接管补写归属
}

/** 锁窗缺省 2h（任务书口径：存在且未过期（<2h）拒新会话进入）。env 覆盖仅测试用。 */
export function worktreeLockWindowMs(): number {
  const v = Number(process.env.CCR_WT_LOCK_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 2 * 3600_000;
}

function lockPath(worktree: string): string {
  return join(worktree, WORKTREE_LOCK_FILE);
}

/** 读锁：损坏/不存在/已过期 → null（陈锁一律视为无人持有，不抛）。 */
export function readWorktreeLock(worktree: string, now = Date.now()): WorktreeLock | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath(worktree), "utf-8")) as Partial<WorktreeLock>;
    if (typeof raw !== "object" || raw === null) return null;
    if (typeof raw.expires_at !== "number" || typeof raw.created_at !== "number") return null;
    if (raw.expires_at <= now) return null; // 过期=陈锁（文件留存由覆写/收割清）
    if (typeof raw.slug !== "string" || !raw.slug) return null;
    return { slug: raw.slug, ...(raw.dispatch_id ? { dispatch_id: raw.dispatch_id } : {}), ...(raw.session_id ? { session_id: raw.session_id } : {}), ...(typeof raw.cli_pid === "number" && raw.cli_pid > 0 ? { cli_pid: raw.cli_pid } : {}), created_at: raw.created_at, expires_at: raw.expires_at };
  } catch {
    return null;
  }
}

/** 是否被他人活锁占用（self 锁不算占用——幂等续派/认领补写场景）。 */
export function worktreeHeldByOther(worktree: string, selfDispatchId?: string, now = Date.now()): WorktreeLock | null {
  const lock = readWorktreeLock(worktree, now);
  if (!lock) return null;
  if (selfDispatchId && lock.dispatch_id === selfDispatchId) return null;
  return lock;
}

/** 写锁（覆写式：新单覆写他人**陈锁**合法；活锁请先过 worktreeHeldByOther 预检）。
 * 返工②后生产路径一律走 acquire/claim（原子）；本函数保留给「已确知归属的自己锁」
 * 幂等重写与测试底座。 */
export function writeWorktreeLock(worktree: string, lock: Omit<WorktreeLock, "created_at" | "expires_at"> & { created_at?: number; expires_at?: number }): WorktreeLock {
  const now = lock.created_at ?? Date.now();
  const full: WorktreeLock = {
    slug: lock.slug,
    ...(lock.dispatch_id ? { dispatch_id: lock.dispatch_id } : {}),
    ...(lock.session_id ? { session_id: lock.session_id } : {}),
    ...(typeof lock.cli_pid === "number" && lock.cli_pid > 0 ? { cli_pid: lock.cli_pid } : {}),
    created_at: now,
    expires_at: lock.expires_at ?? now + worktreeLockWindowMs(),
  };
  writeFileSync(lockPath(worktree), JSON.stringify(full, null, 2) + "\n", "utf-8");
  return full;
}

/** 清锁：只清「自己单的锁或陈锁」——P1-1 返工收窄（审查A档 review-w-orgdefects-a-1101）：
 * dispatchId 在场时，活锁且非本单（他人 id 锁 **或无 id 哨兵锁**）一律不动——无 id 哨兵锁
 * = leader-dispatch 预建「派单在途」标记（归属未定），按收口清会让任何无关单的收口空转
 * 误清它单在途标记（撞车面回潮）；无 id 锁只按过期失效（readWorktreeLock 过期=null=陈锁，
 * 此处照清）。陈锁（无论有无 id）清理不受影响。 */
export function clearWorktreeLock(worktree: string, dispatchId?: string): boolean {
  const p = lockPath(worktree);
  if (!existsSync(p)) return true;
  if (dispatchId) {
    const lock = readWorktreeLock(worktree);
    if (lock && lock.dispatch_id !== dispatchId) return false; // 他人 id 活锁或无 id 哨兵锁：非本单不清
  }
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** dispatch 收口清锁扫描：CCR_WT_ROOT（缺省 /private/tmp，对齐 leader-dispatch CCR_WT_ROOT
 * 同名覆盖）下所有 *cc-deck-w* 目录的锁文件，dispatch_id 匹配收口单即清。O(目录数)——
 * worktree 数量个位数级，收口边调用可接受。坏目录/权限错误静默跳过（尽力而为，不炸收口）。
 * W-TREEGC guard 谓词：清锁前逐目录问询（true=守卫跳过，锁留守）——脏树不清锁
 * （1104 夜事故：relay 重启误关单→清锁→树裸奔被外部删除）。guarded 目录随 guardedOut 返回。 */
export function scanClearWorktreeLocks(dispatchId: string, root?: string, guard?: (dir: string) => boolean, guardedOut?: string[]): string[] {
  if (!dispatchId) return [];
  const wtRoot = root ?? process.env.CCR_WT_ROOT ?? "/private/tmp";
  const cleared: string[] = [];
  try {
    for (const name of readdirSync(wtRoot)) {
      if (!name.includes("cc-deck-w")) continue;
      const dir = join(wtRoot, name);
      const p = join(dir, WORKTREE_LOCK_FILE);
      if (!existsSync(p)) continue;
      // W-TREEGC：守卫谓词在清前拦截（锁留守=树占位牌）
      if (guard?.(dir)) {
        guardedOut?.push(dir);
        continue;
      }
      // P1-1：跳过即留痕（无 id 哨兵锁/他人锁被收窄保护——排障可见，不静默吞）
      if (clearWorktreeLock(dir, dispatchId)) cleared.push(dir);
      else console.log(`[dispatch-lock] 收口清锁跳过（非本单锁或无 id 哨兵锁，只按过期失效）: ${dir}`);
    }
  } catch {
    /* 根目录不可读：无锁可清 */
  }
  return cleared;
}
