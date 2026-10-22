// 链路演练注入器（W-CMDIMPL T6，#216；设计 §2.4——巡检查「死没死」，演练查「通不通」）
// 假任务全链：假派单→假 worker 响应→假回执→假收割→假部署闸→假验收回填。
// 全程 drill:true 标记（DispatchEntry schema 内字段，读侧宽容忽略=旧 relay/端上零
// 破坏）；不真 spawn worker 会话、不真构建不真推 ECS（部署闸=配对逻辑模拟断言，
// 到「出包前一步」为止）；不触真实任务/用户。
// 断点台账：data/drill-log.ndjson append-only（每跳 {ts, hop, ok, ms, detail}）——
// drill 失败=链路自身坏了，与巡检告警同通道推用户。
// 触发两路：①手动 orgAction action=drill-run；②链路代码变更自动跑（patrol runFull
// 比对链路文件集主仓最新 commit 时间 > 上次 drill 时间，patrol.ts 接线）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatch, orgDir } from "./org.js";
import { harvestCheck } from "./harvest.js";
import { appendJournal } from "./fs-safe.js";

export interface DrillHopResult {
  hop: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface DrillResult {
  ok: boolean;
  run_id: string;
  hops: DrillHopResult[];
  failed_hop?: string;
  duration_ms: number;
}

const DRILL_MARK = true;

/** 假部署闸（§2.4 分面④）：版本烙印/清单配对逻辑的模拟断言——对 drill 临时文件跑
 *  「清单 version==本次 VER」同款校验（build 脚本 manifest_gate 语义的纯函数复刻），
 *  不真构建不真推 ECS。 */
export function gateManifestPairing(version: string, manifestJson: string): { ok: boolean; detail: string } {
  try {
    const manifest = JSON.parse(manifestJson) as { version?: string };
    if (manifest.version === version) return { ok: true, detail: `清单配对 ✓（${version}）` };
    return { ok: false, detail: `清单配对错位：清单 ${manifest.version} ≠ 本次 ${version}` };
  } catch (e) {
    return { ok: false, detail: `清单不可解析: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 链路文件集（自动触发比对面——这些文件变更=链路自身可能变了，补跑一轮） */
export const DRILL_WATCH_FILES = [
  "relay/src/org.ts",
  "relay/src/harvest.ts",
  "relay/src/drill.ts",
  "relay/src/patrol.ts",
  "relay/src/projects.ts",
];

export function lastDrillTime(dataDir: string): number {
  try {
    return Number(JSON.parse(readFileSync(join(dataDir, "drill-last.json"), "utf-8")).ts) || 0;
  } catch {
    return 0;
  }
}

/** 主仓链路文件最新 commit 时间 > 上次 drill 时间 → 需要补跑（patrol 自动触发判据）。
 *  主仓不可达（云端 relay）→ false（演练仅本机语义，同 harvest/release 部署边界）。 */
export function drillDue(mainRepo: string, dataDir: string): boolean {
  try {
    if (!existsSync(join(mainRepo, ".git"))) return false;
    const out = execFileSync("git", ["-C", mainRepo, "log", "-1", "--format=%ct", "--", ...DRILL_WATCH_FILES], { encoding: "utf-8", timeout: 5000 }).trim();
    const latest = Math.max(0, ...out.split("\n").map((l) => Number(l.trim()) * 1000).filter((n) => Number.isFinite(n)));
    return latest > lastDrillTime(dataDir);
  } catch {
    return false;
  }
}

export function runDrill(dataDir: string): DrillResult {
  const t0 = Date.now();
  const runId = `drill-${t0.toString(36)}`;
  const hops: DrillHopResult[] = [];
  const hop = (name: string, fn: () => string | void): void => {
    const s = Date.now();
    try {
      const detail = fn();
      hops.push({ hop: name, ok: true, ms: Date.now() - s, ...(detail ? { detail } : {}) });
      appendJournal(join(dataDir, "drill-log.ndjson"), { ts: Date.now(), run_id: runId, hop: name, ok: true, ms: Date.now() - s, ...(detail ? { detail } : {}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      hops.push({ hop: name, ok: false, ms: Date.now() - s, detail: msg });
      appendJournal(join(dataDir, "drill-log.ndjson"), { ts: Date.now(), run_id: runId, hop: name, ok: false, ms: Date.now() - s, detail: msg });
      throw e;
    }
  };
  const drillId = `dp-drill-${t0.toString(36)}`;
  const tmp = mkdtempSync(join(tmpdir(), "cc-deck-drill-"));
  let failed: string | undefined;
  try {
    // ① 假派单（drill 标记行，不真 spawn）
    hop("dispatch", () => {
      const ok = appendDispatch({ ts: Date.now(), id: drillId, tier: "轻立项", target: "drill-worker", status: "dispatched", session_id: "drill-sess", title: "链路演练假任务", drill: DRILL_MARK });
      if (!ok) throw new Error("drill 派单行写不进台账");
      // 直读 ndjson 原文（sqlite 投影丢 drill 标记=有损映射面备案 read-mode.ts；drill
      // 自证必须见标记原文——json/sqlite 双档行为一致）
      const raw = readFileSync(join(orgDir(), "dispatch-log.ndjson"), "utf-8");
      const row = raw.split("\n").map((l) => { try { return JSON.parse(l) as { id?: string; drill?: boolean }; } catch { return null; } }).filter((x) => x && x.id === drillId).pop();
      if (!row || row.drill !== true) throw new Error("drill 派单行读回无标记");
      return "台账行落盘+drill 标记读回（ndjson 原文）";
    });
    // ② 假 worker 响应（running 行）
    hop("worker-claim", () => {
      const ok = appendDispatch({ ts: Date.now(), id: drillId, tier: "轻立项", target: "drill-worker", status: "running", session_id: "drill-sess", title: "链路演练假任务", drill: DRILL_MARK });
      if (!ok) throw new Error("running 行写不进");
      return "承接成功";
    });
    // ③ 假回执（临时目录，W-DISPATCHX 全格式）
    const receiptPath = join(tmp, "receipt-drill.md");
    hop("receipt", () => {
      writeFileSync(receiptPath, "## 根因\ndrill\n## 自测\ndrill 全绿\n## 验收点\ndrill\n\n结果：演练完成｜改动文件：无\n", "utf-8");
      if (!existsSync(receiptPath)) throw new Error("回执文件未落");
      return "合成回执落临时目录";
    });
    // ④ 假收割（harvest-check 对 drill 单跑全闸——指向 drill 临时 worktree）
    const wt = join(tmp, "wt");
    const g = (a: string[]) => execFileSync("git", ["-C", wt, ...a], { encoding: "utf-8" });
    hop("harvest", () => {
      mkdirGit(wt);
      g(["init", "-q"]); g(["config", "user.email", "d@d"]); g(["config", "user.name", "d"]);
      writeFileSync(join(wt, "f.txt"), "1"); g(["add", "-A"]); g(["commit", "-qm", "base"]);
      const base = g(["rev-parse", "HEAD"]).trim();
      writeFileSync(join(wt, "g.txt"), "2"); g(["add", "-A"]); g(["commit", "-qm", "[正经立项] drill 提交"]);
      const r = harvestCheck({ dispatch_id: drillId, receipt: receiptPath, worktree: wt, branch: "fix/drill", base });
      if (!r.ok) throw new Error(r.error ?? "harvest-check 失败");
      if (r.fails !== 0) throw new Error(`机器闸 ${r.fails} 项 ✗（${r.checks.filter((c) => !c.pass && c.severity !== "warning").map((c) => c.gate).join(",")}）`);
      return "harvest 全闸绿";
    });
    // ⑤ 假部署闸（配对逻辑模拟，不真构建）
    hop("release-gate", () => {
      const ver = `0.0.0-drill.${t0}`;
      const manifest = JSON.stringify({ version: ver });
      const ok = gateManifestPairing(ver, manifest);
      if (!ok.ok) throw new Error(ok.detail);
      const mismatch = gateManifestPairing(ver + "-x", manifest);
      if (mismatch.ok) throw new Error("错配应拒（闸灵敏度丢失）");
      return `配对闸模拟 ✓（正例过/错配拒，到出包前一步为止）`;
    });
    // ⑥ 假验收回填（闭环终态+台账收敛断言）
    hop("acceptance-close", () => {
      const ok = appendDispatch({ ts: Date.now(), id: drillId, tier: "轻立项", target: "drill-worker", status: "done", session_id: "drill-sess", title: "链路演练假任务", receipt: "drill 闭环", drill: DRILL_MARK });
      if (!ok) throw new Error("终态行写不进");
      // 收敛断言同样走 ndjson 原文（同 id 末行=done）
      const rows = readFileSync(join(orgDir(), "dispatch-log.ndjson"), "utf-8").split("\n").map((l) => { try { return JSON.parse(l) as { id?: string; status?: string }; } catch { return null; } }).filter((x) => x && x.id === drillId);
      if (!rows.length || rows[rows.length - 1]!.status !== "done") throw new Error("台账收敛失败（末行非终态）");
      return "台账收敛 done";
    });
  } catch (e) {
    failed = hops.find((h) => !h.ok)?.hop ?? "unknown";
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  try { writeFileSync(join(dataDir, "drill-last.json"), JSON.stringify({ ts: Date.now(), run_id: runId, ok: !failed })); } catch {}
  const duration = Date.now() - t0;
  appendJournal(join(dataDir, "drill-log.ndjson"), { ts: Date.now(), run_id: runId, hop: "summary", ok: !failed, ms: duration, ...(failed ? { detail: `断点：${failed}` } : {}) });
  return { ok: !failed, run_id: runId, hops, ...(failed ? { failed_hop: failed } : {}), duration_ms: duration };
}

function mkdirGit(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
