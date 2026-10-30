// M1+M3 可观测域断言（multica 深研 synthesis M1/M3，2026-10-29 批）——真源码 import 直跑
//（test-272/285 范式）。靶子：
//   M1 relay/src/dispatch-run-archive.ts + org.ts appendDispatch 咽喉 + storage 三件
//      （schema v7 / importer 三 SQL / read-mode 回读）
//   M3 types.ts SessionUsagePayload + session-manager onUsage 接线 + web-console 消费位
//
// 断言组：
//   A（M1 归档链）：A1 任务书快照全文｜A2 终态三件套+run_ref 回填+stats 末值+切片窗滤
//      ｜A3 审计行不归档｜A4 drill 跳过｜A5 queued-only 不归档｜A6 sqlite v7 列+回读链
//   B（M3 帧）：B1 payload 类型锁｜B2 源码接线锚（relay+web，防删锚先例 E2）
//
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_READ_MODE npx tsx scripts/test-m-observ.ts
//（脚本自建沙盒三目录——CCR_ARTIFACTS_DIR/CCR_ORG_DIR/CCR_DATA_DIR 全部指 tmp，隔离生产）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { SessionUsagePayload } from "../src/types.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---------- 沙盒：三目录全隔离（artifacts/org/data），events.ndjson 造料 ----------
const SB = (p: string) => mkdtempSync(join(tmpdir(), p));
const artDir = SB("m-observ-art-"), orgD = SB("m-observ-org-"), dataD = SB("m-observ-data-");
process.env.CCR_ARTIFACTS_DIR = artDir;
process.env.CCR_ORG_DIR = orgD;
process.env.CCR_DATA_DIR = dataD;

const { appendDispatch, readDispatchLog } = await import("../src/org.js");
const { archiveDispatchPrompt, dispatchRunRef } = await import("../src/dispatch-run-archive.js");

// events 造料：目标 session 两回合 usage 递增 + 噪声（跨 session 行 + 窗外旧行）
const SESS = "sess-m-observ-w1";
const T0 = Date.now() - 10_000;
const ev = (seq: number, session_id: string, ts: number, type: string, payload: unknown) =>
  JSON.stringify({ seq, session_id, ts, type, payload });
mkdirSync(dataD, { recursive: true });
// org 沙盒最小底座（sqlite 导入面 org 三源宽容前提：projects.json 存在且合法）
writeFileSync(join(orgD, "projects.json"), JSON.stringify({ groups: [] }, null, 2));
writeFileSync(join(dataD, "events.ndjson"), [
  ev(1, SESS, T0 - 120_000, "SESSION_UPDATED", { status: "WORKING" }),            // 窗外（dispatched 前 >60s）
  ev(2, "sess-other", T0 - 1_000, "SESSION_UPDATED", { usage: { input_tokens: 999 } }), // 跨 session 噪声
  ev(3, SESS, T0 - 500, "SESSION_CREATED", { title: "m-observ 派单" }),           // 窗内首帧（放宽 -60s 内）
  ev(4, SESS, T0 + 1_000, "SESSION_UPDATED", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } }),
  ev(5, SESS, T0 + 2_000, "SESSION_LOG", { kind: "assistant_text", text: "working" }),
  ev(6, SESS, T0 + 3_000, "SESSION_UPDATED", { usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 } }), // 末值应取此
  "{ 坏行不炸读侧",                                                                 // 损坏行（loadEvents 同口径跳过）
].join("\n") + "\n");

console.log("M1 run 机器留档（multica 借① keystone）：");

// ---------- A1 任务书快照 ----------
const DID = "dp-m-observ-001";
const PROMPT = ["# 测试派单任务书", "", "正文段落一——中文内容混排 `code` 与「引号」。", "结果：一行结果行"].join("\n");
archiveDispatchPrompt(DID, PROMPT, { tier: "正经立项", title: "可观测域", target: SESS });
const briefPath = join(artDir, "dispatch-runs", DID, "task-brief.md");
ok(existsSync(briefPath), "A1 task-brief.md 落 artifacts/dispatch-runs/<id>/");
const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf-8") : "";
ok(brief.includes("正文段落一——中文内容混排") && brief.includes("结果：一行结果行"), "A1 prompt 全文不截断入档");
ok(brief.includes("正经立项") && brief.includes("可观测域"), "A1 头部元信息（档位/标题）随档");

// ---------- A2 终态三件套（dispatched→running→done 全链走真 appendDispatch 咽喉） ----------
appendDispatch({ ts: T0, id: DID, tier: "正经立项", target: SESS, status: "dispatched", session_id: SESS, title: "可观测域" });
appendDispatch({ ts: T0 + 1500, id: DID, tier: "正经立项", target: SESS, status: "running", session_id: SESS, title: "可观测域" });
const doneTs = Date.now();
appendDispatch({ ts: doneTs, id: DID, tier: "正经立项", target: SESS, status: "done", session_id: SESS, title: "可观测域", receipt: "结果：m-observ 闭环｜改动文件：a.ts" });

const runDir = join(artDir, "dispatch-runs", DID);
const gz = join(runDir, "events-slice.ndjson.gz");
const statsP = join(runDir, "terminal-stats.json");
ok(existsSync(gz) && existsSync(statsP) && existsSync(briefPath), "A2 三件套齐（brief/gz/stats）");

const rows = readDispatchLog(orgD).filter((r) => r.id === DID);
const term = rows.find((r) => r.status === "done");
ok(term?.run_ref === dispatchRunRef(DID), `A2 终态台账行回填 run_ref（实得 ${term?.run_ref ?? "无"}）`);
ok(rows.find((r) => r.status === "dispatched")?.run_ref === undefined, "A2 非终态行不带 run_ref（缺省=未归档口径）");

const stats = existsSync(statsP) ? JSON.parse(readFileSync(statsP, "utf-8")) : {} as Record<string, unknown>;
ok(stats.dispatch_id === DID && stats.status === "done" && stats.target_session === SESS, "A2 stats 身份面（id/status/session）");
ok(stats.dispatched_ts === T0 && stats.terminal_ts === doneTs && (stats.duration_ms as number) === doneTs - T0, "A2 stats 时窗（末次 dispatched→终态，时长=差值）");
const su = stats.usage as { input_tokens: number } | undefined;
ok(su?.input_tokens === 200, `A2 usage 取切片 SESSION_UPDATED 末值（实得 ${su?.input_tokens ?? "无"}，期 200）`);
ok(typeof stats.events_sliced === "number" && (stats.events_sliced as number) === 4, `A2 切片行数（窗内本 session 4 行，实得 ${stats.events_sliced}）`);

const sliced = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString("utf-8").trim().split("\n") : [];
const slicedParsed = sliced.map((l) => JSON.parse(l) as { session_id: string; seq: number; ts: number });
ok(slicedParsed.length === 4 && slicedParsed.every((r) => r.session_id === SESS), "A2 gunzip 切片全为目标 session（跨 session 噪声滤除）");
ok(slicedParsed.some((r) => r.seq === 3) && !slicedParsed.some((r) => r.seq === 1), "A2 切片窗正确（窗内首帧含/窗外旧行不含）");
ok(!sliced.some((l) => l.includes("坏行")), "A2 损坏行跳过（不炸切片）");

// ---------- A3 审计行（单行 done 无 dispatched 前行）不归档 ----------
appendDispatch({ ts: Date.now(), id: "dp-audit-row", tier: "随手办", target: "org-command", status: "done", session_id: SESS, receipt: "org list · ok" });
ok(!existsSync(join(artDir, "dispatch-runs", "dp-audit-row")), "A3 审计单行不归档（无 run 目录）");
ok(readDispatchLog(orgD).find((r) => r.id === "dp-audit-row")?.run_ref === undefined, "A3 审计行无 run_ref");

// ---------- A4 drill 跳过 ----------
appendDispatch({ ts: Date.now(), id: "dp-drill-1", tier: "轻立项", target: "drill-worker", status: "dispatched", session_id: "drill-sess", drill: true });
appendDispatch({ ts: Date.now(), id: "dp-drill-1", tier: "轻立项", target: "drill-worker", status: "done", session_id: "drill-sess", receipt: "drill 闭环", drill: true });
ok(!existsSync(join(artDir, "dispatch-runs", "dp-drill-1")), "A4 演练假任务不归档");

// ---------- A5 queued-only（排水失败收口，无 dispatched/running）不归档 ----------
appendDispatch({ ts: Date.now(), id: "dp-q-1", tier: "随手办", target: "cap-queue", status: "queued", session_id: "", receipt: "编制已满排队" });
appendDispatch({ ts: Date.now(), id: "dp-q-1", tier: "随手办", target: "cap-queue", status: "failed", session_id: "", receipt: "排队撤销" });
ok(!existsSync(join(artDir, "dispatch-runs", "dp-q-1")), "A5 queued-only 段不归档（无 run 语义）");

// ---------- A6 sqlite v7 列 + 导入/回读链 ----------
const { ensureStoreQuiet, dispatchEntriesFromDb, resolveDirs } = await import("../src/storage/read-mode.js");
const port = ensureStoreQuiet(resolveDirs());
const dbRow = port.query<{ run_ref: string | null; status: string }>("SELECT status, run_ref FROM dispatch WHERE id = ?", [DID]);
ok(dbRow.length === 1 && dbRow[0]?.run_ref === dispatchRunRef(DID), `A6 sqlite v7 列落值（实得 ${dbRow[0]?.run_ref ?? "无"}）`);
const fromDb = dispatchEntriesFromDb(port).find((r) => r.id === DID);
ok(fromDb?.run_ref === dispatchRunRef(DID), "A6 dispatchEntriesFromDb 回读链带 run_ref");
const auditDb = port.query<{ run_ref: string | null }>("SELECT run_ref FROM dispatch WHERE id = ?", ["dp-audit-row"]);
ok(auditDb.length === 1 && (auditDb[0]?.run_ref ?? null) === null, "A6 审计行入库 run_ref 为 NULL（宽容缺省）");

console.log("M3 结构化输出帧（multica 卷三方案 A）：");

// ---------- B1 payload 类型锁（编译期——构造即校验） ----------
const frame: SessionUsagePayload = {
  scope: "turn", model: "claude-*", input_tokens: 100, output_tokens: 10,
  cache_read_input_tokens: 5, cache_creation_input_tokens: 2, turn: 1, source: "result", ts: Date.now(),
};
ok(frame.scope === "turn" && frame.turn === 1, "B1 SessionUsagePayload 类型可构造（token/轮次/模型同帧）");

// ---------- B2 源码接线锚（防删锚——test-005-leaderhide E2 静态锚先例） ----------
const smSrc = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
ok(smSrc.includes('"SESSION_USAGE"'), "B2 relay onUsage 接线锚（bus.emit SESSION_USAGE 在位）");
ok(smSrc.includes("turn_count = (managed.state.turn_count ?? 0) + 1"), "B2 轮次递增锚（turn_count 单点）");
ok(smSrc.includes("archiveDispatchPrompt(dispatchId, dispatchPrompt"), "B2 dispatchWorker 任务书归档锚（dispatched 侧）");
const webSrc = readFileSync(new URL("../../web-console/index.html", import.meta.url), "utf-8");
ok(webSrc.includes('case "SESSION_USAGE"'), "B2 web 帧消费锚（case 在位）");
ok(webSrc.includes("not-wired"), "B2 web not-wired 标识锚（未接线引擎降级显示）");
ok(webSrc.includes('"turn_count"'), "B2 web SNAPSHOT/UPDATE 字段透传锚");

// ---------- 收口 ----------
try { rmSync(artDir, { recursive: true, force: true }); rmSync(orgD, { recursive: true, force: true }); rmSync(dataD, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
