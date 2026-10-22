// 收割机器闸 node 化（W-CMDIMPL ①，#216；设计 docs/cmdprod-design.md §1）
// 真身移植 ~/.cc-deck/bin/leader-harvest（#213 W-DISPATCHX，bash+python3）——机械闸
// 语义逐字对齐：必需节正则/基线退化最近10条/建议打印不执行，三项不重新发明。
// 红线（§7 SSOT）：harvest-check 永不写——不 commit/不 squash/不改台账终态；判断四项
// （diff 抽查/自测证据/真机分级/是否收口）固定留 PM，UI 人工清单区呈现。
// 纯底座风格（org.ts 同款）：不 import session-manager，无环。
// 同步边界：git 快操作（log/status/rev-parse）execFileSync + timeout 5s 兜底，orgAction
// 同步漏斗不动。
// 部署边界（§1.4）：仅本机语义——worktree 不存在/坏仓返回结构化占位（不炸 500）；响应
// 恒带 relay_source 供 UI 置灰非本机源。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDispatchLog, orgDir } from "./org.js";

export interface HarvestCheckRow {
  gate: "receipt" | "sections" | "tail" | "commits" | "dirty" | "acceptance";
  pass: boolean;
  severity?: "warning"; // warning 不计 fails（第六 gate=铁律 7 提醒面，不拦收割）
  detail: string;
  log?: string[];
}

export interface HarvestCheckResult {
  ok: boolean;
  error?: string; // 无 dispatch_id / 账外单无指路等请求面错误
  relay_source?: string;
  dispatch_id: string;
  title: string;
  session_id: string;
  ledger_status: string;
  ledger_receipt?: string;
  checks: HarvestCheckRow[];
  squash_plan: string[];
  fails: number;
  stages: { stage: string; ts: number; detail?: string }[];
}

/** 派单账（leader-dispatch 写）行形态——字段缺省宽容（账在写侧演进） */
interface LeaderDispatchRow {
  id?: string; title?: string; session_id?: string; receipt?: string;
  worktree?: string; branch?: string; base_sha?: string; base_ref?: string;
  gate?: string; slug?: string;
  [k: string]: unknown;
}

function dataDir(): string {
  return process.env.CCR_DATA_DIR || join(homedir(), ".cc-deck", "data");
}

/** 两本账寻址（§1.2）：①派单账 leader-dispatches.ndjson（同 id 末行）②派单台账
 *  dispatch-log.ndjson（readDispatchLog 收敛末行）。派单账优先（worktree/receipt/
 *  base_sha 台账行不带）；两账缺席容忍（账外单走手工指路）。 */
function locateDispatch(id: string): { ledger: LeaderDispatchRow | null; logEntry: ReturnType<typeof readDispatchLog>[number] | null } {
  let ledger: LeaderDispatchRow | null = null;
  const lp = join(dataDir(), "leader-dispatches.ndjson");
  if (existsSync(lp)) {
    try {
      for (const line of readFileSync(lp, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t) as LeaderDispatchRow;
          if (row && row.id === id) ledger = row; // 末行赢
        } catch {}
      }
    } catch {}
  }
  const logEntry = readDispatchLog().find((x) => x.id === id) ?? null;
  return { ledger, logEntry };
}

/** 必需节行首节头匹配——leader-harvest:120 正则逐字移植（裸子串会被「结果：缺根因
 *  与验收点」这类尾行误命中） */
function hasSection(receiptText: string, sec: string): boolean {
  return new RegExp(`^[ \\t\\-\\*#> ]*${sec}`, "m").test(receiptText);
}

/** git 参数化执行（§1.2 纪律：execFileSync 参数数组禁 shell 拼接；worktree/branch
 *  来自两本账属可信域仍按不信任入参处理）。 */
function git(worktree: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("git", ["-C", worktree, ...args], { timeout: 5000, encoding: "utf-8" }) };
  } catch {
    return { ok: false, out: "" };
  }
}

export interface HarvestCheckInput {
  dispatch_id?: unknown;
  receipt?: unknown;
  worktree?: unknown;
  branch?: unknown;
  base?: unknown;
}

export function harvestCheck(input: HarvestCheckInput, opts: { relaySource?: string } = {}): HarvestCheckResult {
  // relay_source 缺省自读 data/relay-name（#100 自定义名；响应恒带——§1.4 UI 置灰依据）
  if (opts.relaySource === undefined) {
    try { opts.relaySource = readFileSync(join(dataDir(), "relay-name"), "utf-8").trim() || "本机 relay"; } catch { opts.relaySource = "本机 relay"; }
  }
  const base_result: HarvestCheckResult = {
    ok: false, dispatch_id: "", title: "", session_id: "", ledger_status: "",
    checks: [], squash_plan: [], fails: 0, stages: [],
    ...(opts.relaySource ? { relay_source: opts.relaySource } : {}),
  };
  const did = typeof input.dispatch_id === "string" ? input.dispatch_id.trim() : "";
  if (!did) return { ...base_result, error: "dispatch_id 必填" };

  const { ledger, logEntry } = locateDispatch(did);
  const title = String(ledger?.title ?? logEntry?.title ?? "");
  const sid = String(ledger?.session_id ?? logEntry?.session_id ?? "");
  const dlStatus = String(logEntry?.status ?? "");
  // 手工覆盖 > 派单账 >（台账 receipt 是收口摘要非文件路径，不混用）
  const receipt = typeof input.receipt === "string" && input.receipt.trim() ? input.receipt.trim() : String(ledger?.receipt ?? "");
  const worktree = typeof input.worktree === "string" && input.worktree.trim() ? input.worktree.trim() : String(ledger?.worktree ?? "");
  const branch = typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : String(ledger?.branch ?? "");
  let base = typeof input.base === "string" && input.base.trim() ? input.base.trim() : String(ledger?.base_sha ?? ledger?.base_ref ?? "");

  if (!ledger && !logEntry && (!receipt || !branch)) {
    return { ...base_result, dispatch_id: did, error: `两本账都无 dispatch_id=${did.slice(0, 8)} 的记录（账外单须带 receipt+branch 手工指路）` };
  }

  const checks: HarvestCheckRow[] = [];
  const squash_plan: string[] = [];
  let fails = 0;

  // ---------- 闸① 回执：存在性 + 必需节 + 尾行 ----------
  let receiptText = "";
  if (!receipt) {
    checks.push({ gate: "receipt", pass: false, detail: "回执路径未知（账无记录且未手工指定）" });
    fails++;
  } else if (!existsSync(receipt)) {
    checks.push({ gate: "receipt", pass: false, detail: "回执文件不存在（worker 未交？核对任务书回执路径约定）" });
    fails++;
  } else {
    let bytes = 0;
    try { bytes = statSync(receipt).size; } catch {}
    try { receiptText = readFileSync(receipt, "utf-8"); } catch {}
    checks.push({ gate: "receipt", pass: true, detail: `回执存在（${bytes} 字节）` });
    const missing = ["根因", "自测", "验收点"].filter((sec) => !hasSection(receiptText, sec));
    checks.push({
      gate: "sections",
      pass: missing.length === 0,
      detail: missing.length === 0 ? "必需节「根因/自测/验收点」全在" : `必需节缺：${missing.map((m) => `「${m}」`).join(" ")}（W-DISPATCHX 回执格式）`,
    });
    if (missing.length) fails++;
    // 尾行：结果：…｜改动文件：…（取最后一行 结果： 行查「改动文件」子串）
    const tailLines = receiptText.split("\n").filter((l) => /^[ \t]*结果：/.test(l));
    const tailOk = tailLines.length > 0 && tailLines[tailLines.length - 1].includes("改动文件");
    checks.push({
      gate: "tail",
      pass: tailOk,
      detail: tailOk ? "尾行结果摘要在" : "尾行结果摘要缺（固定格式：结果：<一行>｜改动文件：<列表或无>）",
    });
    if (!tailOk) fails++;
  }

  // ---------- 闸② 分支账：新提交清单 + 未提交改动（机械事实，判断留 PM） ----------
  let mainRepo = "";
  if (worktree && existsSync(worktree)) {
    let logLines: string[] = [];
    const baseOk = base ? git(worktree, ["rev-parse", "--verify", "--quiet", base]).ok : false;
    if (baseOk) {
      logLines = git(worktree, ["log", "--oneline", `${base}..HEAD`]).out.split("\n").filter((l) => l.trim());
    } else {
      logLines = git(worktree, ["log", "--oneline", "-10"]).out.split("\n").filter((l) => l.trim());
      base = ""; // 退化标记
    }
    if (logLines.length > 0) {
      checks.push({
        gate: "commits",
        pass: true,
        detail: `新提交 ${logLines.length} 笔${base ? `（自基线 ${base.slice(0, 8)}）` : "（基线不可解析，退最近 10 条）"}`,
        log: logLines.slice(0, 20),
      });
    } else {
      checks.push({ gate: "commits", pass: false, detail: "基线后无新提交（worker 未 commit？）" });
      fails++;
    }
    const dirtyOut = git(worktree, ["status", "--porcelain"]).out;
    const dirtyN = dirtyOut.split("\n").filter((l) => l.trim()).length;
    checks.push({
      gate: "dirty",
      pass: dirtyN === 0,
      detail: dirtyN === 0 ? "无未提交改动" : `未提交改动 ${dirtyN} 处（squash 前需先收口）`,
    });
    if (dirtyN > 0) fails++;
    // 主仓根（squash 建议第 2 步的 cd 目标）
    const gd = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim();
    if (gd) mainRepo = gd.replace(/\/\.git$/, "") || gd;
    const head = git(worktree, ["rev-parse", "--short", "HEAD"]).out.trim();
    void head; // HEAD 短码进 squash_plan 附注（UI 明细面）
  } else if (worktree) {
    checks.push({ gate: "commits", pass: false, detail: `worktree 不存在：${worktree}（已被清理？分支仍在主仓可查）` });
    checks.push({ gate: "dirty", pass: true, detail: "worktree 缺席，dirty 闸跳过" });
    fails++;
  } else {
    checks.push({ gate: "commits", pass: true, detail: "无 worktree 记录——随手办/账外单，分支账跳过" });
    checks.push({ gate: "dirty", pass: true, detail: "无 worktree，dirty 闸跳过" });
  }

  // ---------- squash 建议（打印不执行——SSOT 拍板表原文语义；「复制命令」非「执行」） ----------
  squash_plan.push(
    ...(branch
      ? [`git -C ${worktree || "<worktree>"} add -A && git -C ${worktree || "<worktree>"} commit -m "[正经立项] ${title || "<标题>"}"`]
      : []),
    `cd ${mainRepo || "<主仓>"} && git merge --squash ${branch || "<分支>"} && git commit   # 信息带 #NN，body 列逐条清单`,
    ...(worktree ? [`git worktree remove ${worktree} && git branch -D ${branch || "<分支>"}`] : []),
  );

  // ---------- 第六 gate：验收单状态（§1.3 B 路评审 P2-4：warning 不 fail） ----------
  // 铁律 7 的机器提醒面：dispatch 关联验收单是否 submitted/回填。查 artifacts 登记
  // acceptance*.md 近邻（无精确关联账——文件名含 dispatch slug/title 弱匹配从宽）。
  const acc = acceptanceHint(did, title);
  checks.push({
    gate: "acceptance",
    pass: acc.state === "ok",
    severity: "warning",
    detail: acc.detail,
  });

  return {
    ...base_result,
    ok: true,
    dispatch_id: did,
    title,
    session_id: sid,
    ledger_status: dlStatus,
    ...(logEntry?.receipt ? { ledger_receipt: logEntry.receipt } : {}),
    checks,
    squash_plan,
    fails,
    stages: stagesOf(did),
  };
}

/** 第六 gate 数据面：artifacts 目录 acceptance*.md 存在性弱提示（无关联账，从宽：
 *  有任一近期验收单=「在」；查无=提醒未出验收单）。铁律 7 提醒面，不拦收割。 */
function acceptanceHint(did: string, title: string): { state: "ok" | "missing"; detail: string } {
  try {
    const artDir = process.env.CCR_ARTIFACTS_DIR || join(homedir(), ".cc-deck", "artifacts");
    if (existsSync(artDir)) {
      const hits = readdirSafe(artDir).filter((n) => /^acceptance/i.test(n));
      if (hits.length > 0) return { state: "ok", detail: `验收单在册（${hits.length} 份，回填状态以单据为准）` };
    }
    return { state: "missing", detail: "查无验收单（铁律 7：出包必带验收单——装机验证批次先出单）" };
  } catch {
    return { state: "ok", detail: "验收单状态未知（artifacts 目录不可读，不拦收割）" };
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** stages 断点续办（§1.5）：同 id 全台账行扫 stage 字段（读侧口径扩展——旧行无此
 *  字段宽容忽略；stage 事件不改终态语义）。 */
function stagesOf(did: string): { stage: string; ts: number; detail?: string }[] {
  try {
    const p = join(orgDir(), "dispatch-log.ndjson");
    if (!existsSync(p)) return [];
    const out: { stage: string; ts: number; detail?: string }[] = [];
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { id?: string; stage?: string; stage_detail?: string; ts?: number };
        if (row && row.id === did && typeof row.stage === "string") {
          out.push({ stage: row.stage, ts: typeof row.ts === "number" ? row.ts : 0, ...(row.stage_detail ? { detail: row.stage_detail } : {}) });
        }
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
