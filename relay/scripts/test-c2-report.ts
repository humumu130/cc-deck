// #018-C2 dispatch-report 对账巡检桩测（worker G）。
//
// 直跑入口（relay 目录）：node --import tsx scripts/test-c2-report.ts
//
// 手造 fixture NDJSON 全形态（四类异常 + ACK 误读四畸形 + 空账 + 纯成功账 +
// attempt:2 收口账 + DELIVER 排除 + 缺账本），spawn **真实 bash 工具**断言
// 分类/计数/exit code/json 结构/人类可读关键字。fixture 时间全部用固定 ISO 串
//（工具自身也只比行间先后，无取当下时钟的比对——纪律：禁两取时点 Date.now）。
// 账本路径以位置参数显式注入沙箱 mkdtemp，且 child env 的 CCR_DATA_DIR 也指
// 沙箱双保险——绝不触达 ~/.cc-deck 生产账。

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..", ".."); // relay/scripts → 仓库根
const REPORT = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch-report");

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

// ---------- 沙箱与 fixture 工厂 ----------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c2-"));
let tsTick = 0;
const iso = (): string => `2026-10-05T08:${String(tsTick++).padStart(2, "0")}:00.000000Z`;
type RowOver = Partial<{ ts: string; session_id: string; dispatch_id: string; command_id: string | null; type: string; ok: unknown; error: unknown; attempt: unknown }> & Record<string, unknown>;
const row = (over: RowOver = {}): string => JSON.stringify({
  ts: iso(), session_id: "sess-a", dispatch_id: "d-auto", command_id: "c-auto",
  type: "COMMAND_MESSAGE", ok: true, error: null, attempt: 1, ...over,
});

interface Counts {
  rows: number; valid_rows: number; deliver_rows: number; bad_rows: number;
  ack_misread_rows: number; ts_regressions: number; timeout: number; orphan: number;
  duplicate_commands: number; duplicate_dispatches: number; success_commands: number;
}
interface Item {
  kind?: string; command_id?: string; dispatch_id?: string; lines?: number[]; line?: number;
  reason?: string; command_ids?: string[]; dispatch_ids?: string[]; session_id?: string;
  error?: string; attempt?: number; note?: string;
}
interface ReportJson { counts: Counts; items: { timeout: Item[]; orphan: Item[]; duplicate: Item[]; seqgap: Item[] }; verdict: string }
interface RunResult { status: number | null; stdout: string; stderr: string }

const writeLedger = (name: string, lines: string[]): string => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  return p;
};

const run = (ledger: string | null, opts: { json?: boolean; strict?: boolean } = {}, argOverride?: string): RunResult => {
  const args = [REPORT];
  if (opts.json) args.push("--json");
  if (opts.strict) args.push("--strict");
  args.push(argOverride ?? ledger ?? "");
  // CCR_DATA_DIR 双保险指沙箱：即使账本参数意外为空也绝不落到生产默认路径
  const r = spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, CCR_DATA_DIR: SANDBOX } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const jsonOf = (r: RunResult): ReportJson => JSON.parse(r.stdout) as ReportJson;

async function main(): Promise<void> {
  // ═══════ T1 纯成功账：clean / exit 0 ═══════
  {
    const led = writeLedger("t1.ndjson", [
      row({ command_id: "c1", dispatch_id: "d1", ok: true, attempt: 1 }),
      row({ command_id: "c2", dispatch_id: "d2", ok: true, attempt: 1 }),
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0, `T1 纯成功账 exit 0（got ${r.status}）`);
    check(j.verdict === "clean" && j.counts.success_commands === 2, "T1 verdict=clean success=2");
    check(j.counts.timeout === 0 && j.counts.orphan === 0 && j.counts.duplicate_commands === 0
      && j.counts.duplicate_dispatches === 0 && j.counts.bad_rows === 0 && j.counts.ts_regressions === 0,
      "T1 四类全零");
    const h = run(led);
    check(h.status === 0 && h.stdout.includes("结论：clean"), "T1 人类可读结论 clean");
  }

  // ═══════ T2 timeout 终态：attempt:2 仍败 + 超时/连不上/断线三类 error ═══════
  {
    const led = writeLedger("t2.ndjson", [
      row({ command_id: "c3", dispatch_id: "d3", ok: false, error: "15s 超时，未收到 COMMAND_ACK", attempt: 2 }),
      row({ command_id: "c4", dispatch_id: "d4", ok: false, error: "WS 连接意外关闭", attempt: 2 }),
      row({ command_id: "c5", dispatch_id: "d5", ok: false, error: "无法连接 relay（连接拒绝/网络错误/超时）", attempt: 2 }),
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 1, `T2 timeout 存在 → exit 1（got ${r.status}）`);
    check(j.verdict === "fail" && j.counts.timeout === 3 && j.counts.orphan === 0, "T2 timeout=3 orphan=0 verdict=fail");
    check(j.items.timeout.some((it) => it.command_id === "c3" && it.attempt === 2 && (it.error ?? "").includes("15s 超时")),
      "T2 明细含 c3 attempt:2 超时 error");
    const h = run(led);
    check(h.status === 1 && h.stdout.includes("转人工巡检") && h.stdout.includes("attempt:2"), "T2 人类可读：转人工巡检 + attempt:2");
  }

  // ═══════ T3 orphan：全失败行无成功行（拒收类 / attempt:1 残留） ═══════
  {
    const led = writeLedger("t3.ndjson", [
      row({ command_id: "c6", dispatch_id: "d6", ok: false, error: "ACK ok 非 true：project not found", attempt: 1 }),
      row({ command_id: "c7", dispatch_id: "d7", ok: false, error: "15s 超时，未收到 COMMAND_ACK", attempt: 1 }),
      row({ command_id: "c8", dispatch_id: "d8", ok: false, error: "未找到 relay token", attempt: 1 }),
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 1 && j.verdict === "fail", "T3 orphan 存在 → exit 1 fail");
    check(j.counts.orphan === 3 && j.counts.timeout === 0, "T3 orphan=3（attempt:1 超时类归 orphan 非 timeout 终态）");
    check(j.items.orphan.every((it) => (it.command_id ?? "").startsWith("c")), "T3 orphan 明细带 command_id");
    const h = run(led);
    check(h.stdout.includes("待人工重投"), "T3 人类可读：待人工重投清单");
  }

  // ═══════ T4 duplicate：同 command_id 双 ACK + 同 dispatch_id 跨 command_id ═══════
  {
    const led = writeLedger("t4.ndjson", [
      row({ command_id: "c9", dispatch_id: "d9", ok: true, attempt: 1 }),   // 同 id 第一次
      row({ command_id: "c9", dispatch_id: "d9", ok: true, attempt: 2 }),   // 同 id 又一条有效 ACK
      row({ command_id: "c10", dispatch_id: "d-dup", ok: true, attempt: 1 }),
      row({ command_id: "c11", dispatch_id: "d-dup", ok: true, attempt: 1 }), // 换 id 迹象
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0, `T4 duplicate 缺省仅 warn → exit 0（got ${r.status}）`);
    check(j.verdict === "warn" && j.counts.duplicate_commands === 1 && j.counts.duplicate_dispatches === 1,
      "T4 verdict=warn dup_cmd=1 dup_disp=1");
    check(j.counts.success_commands === 3, "T4 成功账含重复行 command（c9/c10/c11 均有有效 ACK）");
    const dupCmd = j.items.duplicate.find((it) => it.kind === "command_id");
    check(!!dupCmd && (dupCmd.lines?.length ?? 0) === 2 && dupCmd.command_id === "c9", "T4 command_id 重复明细含两行行号");
    const dupDisp = j.items.duplicate.find((it) => it.kind === "dispatch_id");
    check(!!dupDisp && dupDisp.dispatch_id === "d-dup" && (dupDisp.command_ids?.length ?? 0) === 2,
      "T4 dispatch_id 跨 command_id 明细");
    const strict = run(led, { json: true, strict: true });
    check(strict.status === 1 && jsonOf(strict).verdict === "fail", "T4 --strict → duplicate 升级非零 fail");
    const h = run(led);
    check(h.stdout.includes("待核验"), "T4 人类可读：重复迹象待核验");
  }

  // ═══════ T5 ACK 误读四畸形：ok:"yes"/"1"/"true"/缺省 全不进成功账 ═══════
  {
    const led = writeLedger("t5.ndjson", [
      row({ command_id: "cm1", ok: "yes" }),        // 字符串 truthy
      row({ command_id: "cm2", ok: "1" }),          // 字符串数字
      row({ command_id: "cm3", ok: "true" }),       // 字符串布尔
      (() => { const o = JSON.parse(row({ command_id: "cm4" })) as Record<string, unknown>; delete o.ok; return JSON.stringify(o); })(), // 缺省
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0, `T5 畸形行=坏行 warn → exit 0（got ${r.status}）`);
    check(j.counts.ack_misread_rows === 4 && j.counts.bad_rows === 4, "T5 四畸形全计坏行 ack_misread=4");
    check(j.counts.success_commands === 0, "T5 成功账零入账（误读行绝不进成功账）");
    check(j.counts.orphan === 0 && j.counts.timeout === 0, "T5 误读行不臆断 orphan/timeout（结构不可信行不入语义分类）");
    check(j.items.seqgap.length === 4 && j.items.seqgap.every((it) => (it.reason ?? "").includes("ACK 误读态")),
      "T5 seqgap 四条明细全标 ACK 误读态");
    const strict = run(led, { strict: true });
    check(strict.status === 1, "T5 --strict → 畸形行升级非零");
    const h = run(led);
    check(h.stdout.includes("ACK 误读态"), "T5 人类可读：ACK 误读态标注");
  }

  // ═══════ T6 seq-gap 代位：坏行计数 + ts 倒序，均报行号 ═══════
  {
    const badIso = "2026-10-05T08:05:00.000000Z";
    const led = writeLedger("t6.ndjson", [
      "not-json{{{",                                                                          // L1 非 JSON
      row({ command_id: "cs2", session_id: "" }),                                             // L2 缺 session_id（空串）
      row({ command_id: "cs3", attempt: "2" }),                                               // L3 attempt 类型错
      row({ command_id: "cs4", type: "WEIRD" }),                                              // L4 未知 type
      // L5 DELIVER 有效行（attempt 由 JSON.stringify 的 undefined 语义自然省略）
      row({ command_id: null, type: "DELIVER", dispatch_id: "d-deliv", ok: true, ts: badIso }),
      row({ command_id: "cs1", ok: true, ts: "2026-10-05T08:01:00.000000Z" }),                // L6 有效但 ts 早于 L5 → 倒序
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0 && j.verdict === "warn", `T6 seq-gap 仅 warn → exit 0（got ${r.status}/${j.verdict}）`);
    check(j.counts.bad_rows === 4 && j.counts.ts_regressions === 1, "T6 坏行=4 倒序=1");
    check(j.counts.deliver_rows === 1 && j.counts.success_commands === 1, "T6 DELIVER 行计入不计类、有效 COMMAND 正常成功");
    check(j.items.seqgap.filter((it) => typeof it.line === "number" && it.line >= 1).length === 5,
      "T6 五条 seqgap 明细全带行号");
    const reg = j.items.seqgap.find((it) => (it.reason ?? "").includes("倒序"));
    check(!!reg && reg.line === 6, "T6 倒序明细落 L6（晚行 ts 早于前一行）");
    const strict = run(led, { strict: true });
    check(strict.status === 1, "T6 --strict → seq-gap 升级非零");
    const h = run(led);
    check(h.stdout.includes("ts 倒序") && /L1 非 JSON/.test(h.stdout), "T6 人类可读：倒序与非 JSON 行号");
  }

  // ═══════ T7 attempt:2 收口账：重试成功行 = 正常成功，失败行不拖累分类 ═══════
  {
    const led = writeLedger("t7.ndjson", [
      row({ command_id: "c13", dispatch_id: "d13", ok: true, attempt: 2 }),                    // 单行 attempt:2 ok（重试成功收口）
      row({ command_id: "c14", dispatch_id: "d14", ok: false, error: "15s 超时", attempt: 1 }),
      row({ command_id: "c14", dispatch_id: "d14", ok: true, attempt: 2 }),                    // 败后重试成
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0 && j.verdict === "clean", "T7 收口账 clean exit 0");
    check(j.counts.success_commands === 2 && j.counts.timeout === 0 && j.counts.orphan === 0 && j.counts.duplicate_commands === 0,
      "T7 attempt:2 ok 行=成功；有成功行在，失败行不判 orphan/timeout");
  }

  // ═══════ T8 空账 / T9 缺账本 / T10 用法错误 ═══════
  {
    const empty = writeLedger("t8.ndjson", []);
    const r8 = run(empty, { json: true });
    check(r8.status === 0 && jsonOf(r8).verdict === "clean" && jsonOf(r8).counts.rows === 0, "T8 空账 clean rows=0");
    const missing = path.join(SANDBOX, "nope.ndjson");
    const r9 = run(null, {}, missing);
    check(r9.status === 2 && r9.stderr.includes("账本不存在"), `T9 缺账本 exit 2（got ${r9.status}）不谎报干净`);
    const r10 = run(empty, {}, "--bogus");
    check(r10.status === 2, "T10 未知参数 exit 2");
  }

  // ═══════ T11 DELIVER 排除备案：失败 DELIVER 行不产生 orphan/timeout ═══════
  {
    const led = writeLedger("t11.ndjson", [
      row({ command_id: null, type: "DELIVER", dispatch_id: "d-deliv2", ok: false, error: "无法连接 relay（连接拒绝/网络错误/超时）" }),
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(r.status === 0 && j.verdict === "clean", "T11 纯 DELIVER 账 clean（不入对账面）");
    check(j.counts.deliver_rows === 1 && j.counts.timeout === 0 && j.counts.orphan === 0,
      "T11 DELIVER 失败行零分类（失败回退属 C3 线备案）");
  }

  // ═══════ T12 综合账人类可读细节：四段节标记 + 行号引用 + error 摘要 ═══════
  {
    const led = writeLedger("t12.ndjson", [
      row({ command_id: "cx1", ok: true, attempt: 1 }),
      row({ command_id: "cx2", ok: false, error: "无法连接 relay（连接拒绝/网络错误/超时）", attempt: 2 }),
      "garbage-line",
    ]);
    const h = run(led);
    check(h.status === 1, "T12 综合账 fail exit 1");
    for (const mark of ["①", "②", "③", "④", "L3", "command_id=cx2", "无法连接 relay"]) {
      check(h.stdout.includes(mark), `T12 人类可读含「${mark}」`);
    }
  }

  console.log(`C2 dispatch-report tests ${tests}/${tests} passed (sandbox=${SANDBOX})`);
}

main()
  .then(() => {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((e) => {
    console.error(String(e && e.stack ? e.stack : e));
    process.exit(1);
  });
