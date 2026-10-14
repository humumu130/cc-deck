// ---------- #102 批 C：登录就绪兜底重探 + 恢复触发（探/登/通 三层之「通」） ----------
// 批 A（5d404c2）把「装了未登录」探成 needs_auth 并在创建/派单面 fail-fast；批 B
//（57b1fe4）登录 pane 存活期每 ~2.4s 短轮询真探（不吃 45s TTL）。本件补「pane 关闭
// 后的兜底」：needs_auth 引擎挂一个低频重探循环（60s 起、指数退避 ×2、5min 帽），
// 探针 ready → 清 watch + 失效同步缓存 + 调恢复钩子（SessionManager 注入——恢复
// 三面：会话自动 resume / 创建拦截通知回显 / 派单拦截通知）。
//
// 与批 B 的协同（双探并存不互斥）：pane 存活期批 B 高频轮探先到 ready（settleReady
// 收 pane+推 AUTH_REQUIRED ready 帧），本件循环最迟 60s 后也探到 ready——两边都收敛
// 到同一恢复入口（SessionManager.recoverEngineAfterAuth 幂等窗去重），无需互斥锁。
//
// 被拦意图登记（创建/派单）：创建被拦无会话实体可恢复，登记 intent 快照（anchor/
// task 摘要），ready 后由恢复钩子消费发通知回显；每引擎 cap 5 条（反复被拦不积压
// 成通知风暴——旧意图挤掉，登录后最多收 5 条）。
//
// 测试缝：CCR_AUTH_WATCH_BASE_MS（缺省 60000）/ CCR_AUTH_WATCH_MAX_MS（缺省
// 300000）——测试压到百 ms 级验证退避与触发。探针 mock 同批 B：CCR_*_PATH 假脚本
// 输出由状态文件切换。
import type { SessionEngine } from "./types.js";
import { probeEngineAuthAsync, resetEngineAuthCache } from "./engine-auth.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 首探延迟（挂 watch 后先等一个周期再探——pane 刚起流时批 B 高频轮探在前） */
const WATCH_BASE_MS = Number(process.env.CCR_AUTH_WATCH_BASE_MS) > 0 ? Number(process.env.CCR_AUTH_WATCH_BASE_MS) : 60_000;
/** 退避帽（持续 needs_auth 时逐次 ×2 到此封顶） */
const WATCH_MAX_MS = Number(process.env.CCR_AUTH_WATCH_MAX_MS) > 0 ? Number(process.env.CCR_AUTH_WATCH_MAX_MS) : 300_000;
/** 每引擎被拦意图上限（创建/派单各计——登录后最多各回显 5 条） */
const INTENT_CAP = 5;

/** 创建被拦时的意图快照（无会话实体——ready 后只能通知回显，不能自动重建） */
export interface BlockedCreateIntent {
  engine: SessionEngine;
  /** 创建目录（anchor 语义） */
  cwd?: string;
  /** 任务摘要（prompt 首段截断——通知回显用） */
  prompt_summary: string;
  ts: number;
}

/** 派单被拦时的意图快照（派单重发是用户动作不自动重放——失败重放有副作用风险） */
export interface BlockedDispatchIntent {
  engine: SessionEngine;
  /** 派单标题（缺省取 anchor） */
  title?: string;
  anchor: string;
  ts: number;
}

/** 恢复钩子（SessionManager 注入——单槽后注册覆盖，同 setConfirmCreatedHook 惯例） */
type AuthReadyHook = (engine: SessionEngine) => void | Promise<void>;
let readyHook: AuthReadyHook | null = null;

const watches = new Map<SessionEngine, true>();
const blockedCreates = new Map<SessionEngine, BlockedCreateIntent[]>();
const blockedDispatches = new Map<SessionEngine, BlockedDispatchIntent[]>();

export function setAuthWatchReadyHook(hook: AuthReadyHook | null): void {
  readyHook = hook;
}

/** 查询：该引擎是否有活 watch（测试/诊断面） */
export function authWatchActive(engine: SessionEngine): boolean {
  return watches.has(engine);
}

/** 挂兜底重探（幂等：已有活 watch 直接返回）。三个登记面（会话 needs_auth/创建
 * 拦截/派单拦截）共用；watch 一经挂上持续到探针 ready，期间新登记只进意图队列
 * 不重起循环。 */
export function ensureAuthWatch(engine: SessionEngine): void {
  if (watches.has(engine)) return;
  watches.set(engine, true);
  void watchLoop(engine);
}

async function watchLoop(engine: SessionEngine): Promise<void> {
  let delay = WATCH_BASE_MS;
  for (;;) {
    await sleep(delay);
    if (!watches.get(engine)) return; // 被测试 reset 清掉
    // 异步探针不阻塞 relay 主线程（批 B 同款防线——spawnSync 0.8~5s 会打停事件流）；
    // probeEngineAuthAsync 不进 45s 缓存（批 B 语义：调用方掌控缓存）
    const probe = await probeEngineAuthAsync(engine, { timeoutMs: 8000 });
    if (probe.state === "ready") break;
    delay = Math.min(Math.round(delay * 2), WATCH_MAX_MS); // 指数退避到 5min 帽
  }
  watches.delete(engine);
  // 同步探针面立即自愈（catalog 黄点/创建拦截最迟本刻转绿——批 B settleReady 同口径）
  resetEngineAuthCache();
  try {
    await readyHook?.(engine);
  } catch (e) {
    console.warn(`[auth-watch] ${engine} 恢复钩子异常: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pushCapped<T>(list: T[] | undefined, item: T): T[] {
  const next = [...(list ?? []), item];
  return next.length > INTENT_CAP ? next.slice(next.length - INTENT_CAP) : next;
}

/** 登记创建被拦意图（挂 watch——ready 后通知「已登录，可以创建了」+快照回显） */
export function recordBlockedCreate(intent: BlockedCreateIntent): void {
  blockedCreates.set(intent.engine, pushCapped(blockedCreates.get(intent.engine), intent));
  ensureAuthWatch(intent.engine);
}

/** 登记派单被拦意图（挂 watch——ready 后通知「已登录，可以重新派单」，不自动重放） */
export function recordBlockedDispatch(intent: BlockedDispatchIntent): void {
  blockedDispatches.set(intent.engine, pushCapped(blockedDispatches.get(intent.engine), intent));
  ensureAuthWatch(intent.engine);
}

/** 消费该引擎全部创建拦截意图（恢复钩子专用——取出即清，二次 ready 不重复通知） */
export function takeBlockedCreates(engine: SessionEngine): BlockedCreateIntent[] {
  const list = blockedCreates.get(engine) ?? [];
  blockedCreates.delete(engine);
  return list;
}

/** 消费该引擎全部派单拦截意图 */
export function takeBlockedDispatches(engine: SessionEngine): BlockedDispatchIntent[] {
  const list = blockedDispatches.get(engine) ?? [];
  blockedDispatches.delete(engine);
  return list;
}

/** 测试缝：清全部 watch 与意图队列（活循环由下一轮 sleep 后的 watches 检查自终） */
export function resetAuthWatchForTest(): void {
  watches.clear();
  blockedCreates.clear();
  blockedDispatches.clear();
  readyHook = null;
}
