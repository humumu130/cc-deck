// W-RESTARTDESIGN 案一 A（已拍板）：重启窗账面持久化——unacked 重放账+熔断计数/冷却
// 的全量镜像落盘（dispatch-queue.json 写穿同构）。纯 fs 无环（org.ts 同纪律）。
// v2 拍板口径：分层过期（renewable 过期丢/用户消息永不过期+终态落未投递通知——终态
// 判定与通知在 session-manager 回灌侧消费，本模块只管存取与 TTL 过滤 renewable）；
// 原子写 tmp+rename+失败指数退避重试+error 高噪（dispatch-queue 静默弱化前科不可再现）；
// boot 清残留 tmp。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RestartLedgerUnacked {
  id: string;
  text: string;
  images?: string[];
  ts: number;
  refs?: string[];
  hold?: "init" | "turn";
  renewable?: boolean;
}

export interface RestartLedgerEntry {
  session_id: string;
  unacked: RestartLedgerUnacked[];
  resumeFailStreak?: number;
  resumeCooldownUntil?: number;
}

export interface RestartLedgerFile {
  version: 1;
  savedAt: number;
  entries: RestartLedgerEntry[];
}

// 10min TTL 仅辖 renewable 类（用户消息永不过期——#7 必达语义，终态处理在回灌侧）
export function restartLedgerTtlMs(): number {
  const v = Number(process.env.CCR_RESTART_LEDGER_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000;
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, "restart-ledger.json");
}

let retryState: { attempt: number; timer?: NodeJS.Timeout } | null = null;

/**
 * 原子写（tmp+rename）+ 指数退避重试（1s/4s/16s）+ 三次失败 error 高噪。
 * 返回 true=落盘成功；false=已排队重试（调用方无需再管——内存账仍是权威）。
 */
export function saveRestartLedger(dataDir: string, entries: RestartLedgerEntry[]): boolean {
  const file: RestartLedgerFile = { version: 1, savedAt: Date.now(), entries };
  const target = ledgerPath(dataDir);
  const tmp = target + ".tmp";
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, target);
    if (retryState) {
      if (retryState.timer) clearTimeout(retryState.timer);
      retryState = null;
    }
    return true;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const attempt = (retryState?.attempt ?? 0) + 1;
    if (retryState?.timer) clearTimeout(retryState.timer);
    retryState = { attempt };
    if (attempt >= 3) {
      console.error(`[restart-ledger] 写穿失败 x${attempt}（磁盘满/权限？）——内存账权威但重启将丢：${why}`);
      return false;
    }
    const delay = attempt === 1 ? 1_000 : attempt === 2 ? 4_000 : 16_000;
    console.warn(`[restart-ledger] 写穿失败（第 ${attempt} 次，${delay}ms 后重试）：${why}`);
    retryState.timer = setTimeout(() => { void saveRestartLedger(dataDir, entries); }, delay);
    retryState.timer.unref?.();
    return false;
  }
}

/**
 * boot 回灌读取：过期只作用于 renewable 条目（用户消息全带回——终态判定在
 * session-manager 回灌侧做「未投递」通知分流）；顺带清残留 tmp。
 * 回灌 TTL 测试缝：now 可注入。
 */
export function loadRestartLedger(dataDir: string, now: number = Date.now()): { entries: RestartLedgerEntry[]; droppedRenewable: number; orphans: string[] } {
  const target = ledgerPath(dataDir);
  const tmp = target + ".tmp";
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清残留尽力而为 */ }
  if (!existsSync(target)) return { entries: [], droppedRenewable: 0, orphans: [] };
  let droppedRenewable = 0;
  try {
    const raw = JSON.parse(readFileSync(target, "utf-8")) as Partial<RestartLedgerFile>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter((x) => x && typeof x.session_id === "string" && Array.isArray(x.unacked)) : [];
    const ttl = restartLedgerTtlMs();
    for (const e of entries) {
      const before = e.unacked.length;
      // 分层过期：renewable 且超 TTL 丢（duty 重推导再注）；非 renewable（用户消息）永不过期
      e.unacked = e.unacked.filter((m) => !(m && m.renewable && now - (m.ts || 0) > ttl));
      droppedRenewable += before - e.unacked.length;
    }
    return { entries, droppedRenewable, orphans: [] };
  } catch (e) {
    console.error(`[restart-ledger] 读取失败（坏档跳回灌）：${e instanceof Error ? e.message : String(e)}`);
    return { entries: [], droppedRenewable: 0, orphans: [] };
  }
}

/** 测试缝：清退避状态（resetForTests 同款纪律） */
export function resetRestartLedgerForTests(): void {
  if (retryState?.timer) clearTimeout(retryState.timer);
  retryState = null;
  try { rmSync("/tmp/ccr-restart-ledger-test", { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

// 测试直接跑时（tsx scripts/test-...）自建沙盒
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  // 占位：纯函数模块无 main
}
