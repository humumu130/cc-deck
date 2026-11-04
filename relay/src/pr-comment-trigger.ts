// W-PRBACKFLOW（期一末跳，1104 用户问「PR 审查评论这个东西，评论了之后会有对应的人去
// 处理吗」——现靠 PM 转发返修单无自动闭环；DS Subscription 末跳补全，w-dsagent-vscc.md
// 借鉴#1 完整形态）：**PR 评论=Trigger，订阅直达交付 worker**。
//
// 链路：relay 定时（独立 5min 档，挂 observe 三档 patrol 族——见 auto-tiers 挂档纪律：
// 本模块=无人触发/自主研判/自主投递的巡检语义腿）拉「in_review 单 + 终态窗内单」关联
// PR 的新评论（REST issues/<n>/comments，自 cursor 起）→ 经 subfanout 判定单点
//（subFanTarget：in_review/在途 → 直投交付会话；终态 → null 回落 PM）→ notifyConfirm
// 定向 [待确认]（=返修单语义，worker 侧零改）+ noteSubFanout 审计。
//
// 幂等（I2 铁律）：cursor 按 dispatchId 记 last_seen comment id（org 目录
// pr-comment-cursor.json，原子写）——同 comment id 只投一次；observe 干跑不进 cursor
//（转 auto 补投积压——observe 是看清不是消费）。
//
// 韧性（observe/patrol 档纪律）：gh 缺席/超时/坏响应=该行跳过该周期继续（warn 不炸）；
// 档位 off=整周期不研判（fetch 都不发起）。
//
// 依赖注记：in_review 状态由 prreview 批（a557e151）引入——本模块在其未收编基线上
// 对 in_review 行 stringly 比对（dispatch-log 该值恒不出现 → 轮询集恒空 = 优雅空转，
// prreview 收编即活，无耦合序要求）。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir, readDispatchLogFile } from "./org.js";
import { autoTierOf, recordWouldDo } from "./auto-tiers.js";
import { subFanTarget } from "./subfanout.js";

export interface PrWatchRow {
  /** 归属单全 id（审计关联，勿截断） */
  dispatchId: string;
  /** 承接会话（台账权威：review-ledger 段行透传交付者 sid） */
  sessionId: string;
  prUrl: string;
  title?: string;
  /** 末行 status（in_review=审查期直投；终态=PM 回落窗） */
  status: string;
}

export interface PrComment {
  /** REST comment id（单调增——cursor 幂等键） */
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

const PR_URL_FULL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+?)\/pull\/(\d+)/;
/** 终态单 PR 评论 PM 回落窗（ms）：收割后晚到评论不丢——窗口外不再拉（防历史单无限轮询） */
const TERMINAL_WINDOW_MS = Number(process.env.CCR_PR_COMMENT_TERMINAL_WINDOW_MS ?? "") || 24 * 60 * 60 * 1000;

/**
 * 轮询集收集（纯读）：dispatch-log 末行收敛后取
 *  - status=in_review 且 receipt 带 PR URL（review-ledger begin 行——leader-harvest
 *    --review 落账 note 嵌 URL，PM 工具配套）：审查期，评论直投交付者；
 *  - status=done|failed 且 receipt 带 PR URL 且终态行 ts 在回落窗内：收割后晚到评论
 *    回落 PM（不投 worker——单已收口，subFanTarget 对终态恒 null）。
 */
export function collectPrWatchRows(dir?: string, now = Date.now()): PrWatchRow[] {
  const last = new Map<string, ReturnType<typeof readDispatchLogFile>[number]>();
  for (const e of readDispatchLogFile(dir)) last.set(e.id, e); // 末行赢（append-only 状态机）
  const rows: PrWatchRow[] = [];
  for (const e of last.values()) {
    const st = e.status as string;
    const inReview = st === "in_review"; // stringly：prreview（a557e151）未收编基线恒不命中
    const terminalFresh = (st === "done" || st === "failed") && now - e.ts <= TERMINAL_WINDOW_MS;
    if (!inReview && !terminalFresh) continue;
    const m = (e.receipt ?? "").match(PR_URL_FULL_RE);
    if (!m || !e.session_id) continue;
    rows.push({ dispatchId: e.id, sessionId: e.session_id, prUrl: m[0], title: e.title, status: st });
  }
  return rows;
}

// ---------- cursor（I2 幂等账：同 comment id 只投一次） ----------
function cursorPath(dir?: string): string {
  return join(dir ?? orgDir(), "pr-comment-cursor.json");
}

export function readPrCommentCursor(dir?: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(cursorPath(dir), "utf-8")) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {}; // 无文件/坏 JSON = 空态（首周期全量拉，cursor 写穿修复）
  }
}

export function writePrCommentCursor(map: Record<string, number>, dir?: string): boolean {
  try {
    const d = dir ?? orgDir();
    mkdirSync(d, { recursive: true });
    const p = cursorPath(dir);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(map), "utf-8");
    renameSync(tmp, p); // 原子换名（半写不腐蚀）
    return true;
  } catch (e) {
    console.warn(`[pr-comment] cursor 写失败（本周期幂等账不进，下周期重拉重投——at-least-once 容错）: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- 评论抓取（生产实现 + 测试注入缝） ----------
/** gh api 直拉 PR 评论（REST issues/<n>/comments）。代理同 PM 工具口径
 *  （CCR_GH_PROXY 缺省 127.0.0.1:7890，空串=显式直连）；失败 reject 由周期捕获跳行。 */
export function fetchPrCommentsViaGh(prUrl: string): Promise<PrComment[]> {
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return Promise.reject(new Error(`PR URL 不合法: ${prUrl}`));
  const proxyEnv = process.env.CCR_GH_PROXY ?? "http://127.0.0.1:7890";
  const env = { ...process.env, ...(proxyEnv ? { https_proxy: proxyEnv, HTTPS_PROXY: proxyEnv } : {}) };
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["api", `repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout) => {
        if (err) { reject(new Error(`gh api 拉评论失败: ${err.message}`)); return; }
        try {
          const arr = JSON.parse(stdout) as Array<{ id?: unknown; user?: { login?: unknown }; body?: unknown; created_at?: unknown }>;
          const out: PrComment[] = [];
          for (const c of Array.isArray(arr) ? arr : []) {
            if (typeof c.id !== "number") continue;
            out.push({
              id: c.id,
              author: typeof c.user?.login === "string" ? c.user.login : "?",
              body: typeof c.body === "string" ? c.body : "",
              createdAt: typeof c.created_at === "string" ? c.created_at : "",
            });
          }
          resolve(out);
        } catch (e) {
          reject(new Error(`评论响应解析失败: ${e instanceof Error ? e.message : String(e)}`));
        }
      },
    );
  });
}

/** 评论定向文本（返修单语义）：PR 链接（可链接到具体评论）+摘要+行动指引 */
export function buildCommentMessage(row: PrWatchRow, c: PrComment): string {
  const cid = `${row.prUrl}#issuecomment-${c.id}`;
  return [
    `PR 评论回流｜${row.title ?? row.dispatchId.slice(0, 8)}（单在${row.status === "in_review" ? "审" : "终态"}）：`,
    `@${c.author} 评论于 ${cid}`,
    `「${c.body.replace(/\s+/g, " ").slice(0, 300)}」`,
    row.status === "in_review"
      ? "按评论返修或回复（P0/P1 修复后才收割；修复重推分支后 PM 重跑审查）"
      : "单已收口，本评论已转 PM（如需跟进由 PM 分诊）",
  ].join("\n");
}

export interface PrCommentCycleDeps {
  /** 定向投递（notifyConfirm：[待确认] todo+USER_NOTE+通知账——subfanout confirm 直通同款） */
  notifyConfirm(sessionId: string, text: string): boolean;
  /** 直通审计痕（noteSubFanout——路由决策留痕，DS 账本纪律） */
  noteSubFanout(targetSid: string, fan: { dispatchId: string; status: string }, text: string): void;
  /** PM 回落（终态单/承接会话不在册：leader 定向或通知账兜底） */
  pmFallback(text: string, dispatchId: string, commentId: number): void;
  /** observe 干跑账目录（dataDir） */
  dataDir: string;
  /** 抓取缝（缺省 gh 生产实现；测试注入） */
  fetchComments?: (prUrl: string) => Promise<PrComment[]>;
  /** org 目录（缺省 orgDir；测试隔离用） */
  dir?: string;
  now?: () => number;
}

export interface PrCommentCycleResult {
  rows: number;
  delivered: number;
  pmFallback: number;
  observeWouldDo: number;
  skippedGh: number;
  off: boolean;
}

/**
 * 单周期：off=零研判零抓取；observe=干跑记账（recordWouldDo）不投递不进 cursor；
 * auto=直投/回落 + cursor 推进。任何抓取失败=该行跳过（warn），周期零异常返回。
 */
export async function runPrCommentCycle(deps: PrCommentCycleDeps): Promise<PrCommentCycleResult> {
  const res: PrCommentCycleResult = { rows: 0, delivered: 0, pmFallback: 0, observeWouldDo: 0, skippedGh: 0, off: false };
  const tier = autoTierOf("patrol");
  if (tier === "off") { res.off = true; return res; } // patrol 族 off：连研判都停（完全黑）
  const fetchComments = deps.fetchComments ?? fetchPrCommentsViaGh;
  const rows = collectPrWatchRows(deps.dir, (deps.now ?? Date.now)());
  res.rows = rows.length;
  if (rows.length === 0) return res;
  const cursor = readPrCommentCursor(deps.dir);
  let cursorDirty = false;
  for (const row of rows) {
    let comments: PrComment[];
    try {
      comments = await fetchComments(row.prUrl);
    } catch (e) {
      res.skippedGh++;
      console.warn(`[pr-comment] 拉取跳过（本周期该行不投，observe/patrol 档纪律零异常）: ${row.prUrl} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const seen = cursor[row.dispatchId] ?? 0;
    const fresh = comments.filter((c) => c.id > seen).sort((a, b) => a.id - b.id);
    if (fresh.length === 0) continue;
    // 判定单点：subFanTarget（in_review/在途 → 承接会话；终态 → null 走 PM 回落）
    const fan = subFanTarget(row.dispatchId, deps.dir);
    for (const c of fresh) {
      const text = buildCommentMessage(row, c);
      const dest = fan ? `worker:${fan.sessionId.slice(0, 12)}` : "PM（终态回落）";
      if (tier === "observe") {
        recordWouldDo(deps.dataDir, "patrol", "pr-comment", `deliver→${dest}`, `PR 评论 ${c.id}（${row.prUrl}）`);
        res.observeWouldDo++;
        continue; // 干跑：不投递不进 cursor（转 auto 补投积压——observe 是看清不是消费）
      }
      if (fan && deps.notifyConfirm(fan.sessionId, text)) {
        deps.noteSubFanout(fan.sessionId, { dispatchId: fan.dispatchId, status: fan.status }, text);
        res.delivered++;
        console.log(`[pr-comment] 直投交付会话 ${fan.sessionId.slice(0, 12)}（${fan.status} 单 ${row.dispatchId.slice(0, 8)}，comment ${c.id}）`);
      } else {
        deps.pmFallback(text, row.dispatchId, c.id);
        res.pmFallback++;
        console.log(`[pr-comment] 回落 PM（单 ${row.dispatchId.slice(0, 8)} ${fan ? "承接会话不在册" : "终态"}，comment ${c.id}）`);
      }
    }
    cursor[row.dispatchId] = Math.max(seen, ...fresh.map((c) => c.id));
    cursorDirty = true;
  }
  if (cursorDirty && tier === "auto") writePrCommentCursor(cursor, deps.dir); // observe 不消费
  return res;
}
