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
  deferred: number; discarded: number; queue_pending: number; queue_bad_lines: number;
  duplicate_commands: number; duplicate_dispatches: number; success_commands: number;
}
interface Item {
  kind?: string; command_id?: string; dispatch_id?: string; lines?: number[]; line?: number;
  reason?: string; command_ids?: string[]; dispatch_ids?: string[]; session_id?: string;
  error?: string; attempt?: number; note?: string; queue_state?: string;
}
interface ReportJson { counts: Counts; items: { timeout: Item[]; orphan: Item[]; deferred: Item[]; queue_pending: string[]; duplicate: Item[]; seqgap: Item[] }; verdict: string }
interface PhaseCounts { rows: number; bad_lines: number; broken: number; failed: number; complete: number; success_missing_ledger_row: number; ledger_without_phase: number; pending_chains: number; phase_file_exists: boolean }
interface PhaseJson { counts: PhaseCounts; items: { broken: { dispatch_id: string; missing: string[]; tool: string; session_id: string; command_id: string }[]; failed: { dispatch_id: string; error: string; tool: string }[]; success_missing_ledger_row: string[]; pending_chains: { dispatch_id: string; command_id: string }[] }; verdict: string }
interface RunResult { status: number | null; stdout: string; stderr: string }

const writeLedger = (name: string, lines: string[]): string => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  return p;
};

const run = (ledger: string | null, opts: { json?: boolean; strict?: boolean; phase?: boolean } = {}, argOverride?: string): RunResult => {
  const args = [REPORT];
  if (opts.json) args.push("--json");
  if (opts.strict) args.push("--strict");
  if (opts.phase) args.push("--phase");
  args.push(argOverride ?? ledger ?? "");
  // CCR_DATA_DIR 双保险指沙箱：即使账本参数意外为空也绝不落到生产默认路径
  const r = spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, CCR_DATA_DIR: SANDBOX } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const jsonOf = (r: RunResult): ReportJson => JSON.parse(r.stdout) as ReportJson;
const phaseJsonOf = (r: RunResult): PhaseJson => JSON.parse(r.stdout) as PhaseJson;

// phase 过程账行工厂（--phase 模式 fixture；C1 phase_log schema：tool/phase/ts/
// session_id/dispatch_id/command_id/attempt/ok/error）
const prow = (over: Record<string, unknown> = {}): string => JSON.stringify({
  ts: iso(), tool: "dispatch", phase: "final", session_id: "sess-a",
  dispatch_id: "dp-auto", command_id: "cp-auto", attempt: 1, ok: true, error: null, ...over,
});

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

  // ═══════ T13 C2fix/P2-1 error 字段三形态：缺 error=坏行不臆断 orphan ═══════
  {
    const noError = (over: RowOver): string => {
      const o = JSON.parse(row(over)) as Record<string, unknown>;
      delete o.error; // C1 schema 恒写 error——删除即模拟损坏/截断行
      return JSON.stringify(o);
    };
    const led = writeLedger("t13.ndjson", [
      noError({ command_id: "c-corrupt", dispatch_id: "d-corrupt", ok: false, attempt: 1 }),  // L1 ok:false+缺 error
      row({ command_id: "c-ok", dispatch_id: "d-ok", ok: true, error: null, attempt: 1 }),    // L2 成功行 error:null 合法
      row({ command_id: "c-badtype", dispatch_id: "d-bt", ok: true, error: 123, attempt: 1 }), // L3 error 非串非 null
      row({ command_id: "c-real", dispatch_id: "d-real", ok: false, error: "ACK ok 非 true：project not found", attempt: 1 }), // L4 真 orphan
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(j.counts.bad_rows === 2 && j.counts.valid_rows === 2,
      "T13 缺 error 与 error 类型错均计坏行（2），成功 error:null 行仍有效（2）");
    check(j.counts.success_commands === 1 && j.counts.orphan === 1 && j.counts.timeout === 0,
      "T13 损坏行不进语义账：orphan 只剩真未达 1（缺 error 的 ok:false 不臆断「未达」）");
    check(j.items.orphan.length === 1 && j.items.orphan[0]?.command_id === "c-real",
      "T13 orphan 明细=c-real（损坏行 command_id 不入 orphan 清单）");
    check(r.status === 1 && j.verdict === "fail", `T13 真 orphan 在 → blocking fail exit 1（got ${r.status}）`);
    check(j.items.seqgap.filter((it) => it.line === 1 || it.line === 3).length === 2,
      "T13 两坏行报行号 L1/L3");
    const h = run(led);
    check(h.stdout.includes("缺字段 error") && h.stdout.includes("错字段 error"),
      "T13 人类可读：缺 error 与类型错均报原因");
  }

  // ═══════ T14 C2fix/P3-1 strict 文案两分支：blocking 喊重投 / warnable 对账异常 ═══════
  {
    const ledA = writeLedger("t14a.ndjson", [
      row({ command_id: "cd1", dispatch_id: "dd1", ok: true, attempt: 1 }),
      row({ command_id: "cd1", dispatch_id: "dd1", ok: true, attempt: 2 }), // duplicate（warnable）
      "garbage-line", // 坏行（warnable）
    ]);
    const rs = run(ledA, { json: true, strict: true });
    check(rs.status === 1 && jsonOf(rs).verdict === "fail",
      `T14 strict 仅 warnable 失败 → exit 1 verdict fail（got ${rs.status}）`);
    const hs = run(ledA, { strict: true });
    check(hs.stdout.includes("对账异常") && hs.stdout.includes("无需重投"),
      "T14 strict warnable fail 人类文案=对账异常+无需重投（新分支）");
    check(!hs.stdout.includes("转人工巡检"),
      "T14 strict warnable fail 不喊「转人工巡检」（P3-1 误导话术已除）");
    const hw = run(ledA, { json: true });
    check(hw.status === 0 && jsonOf(hw).verdict === "warn",
      "T14 缺省（非 strict）同账仍 warn exit 0（exit 语义不动）");
    const ledB = writeLedger("t14b.ndjson", [
      row({ command_id: "cx", dispatch_id: "dx", ok: false, error: "未找到 relay token", attempt: 1 }), // 真 orphan
    ]);
    const hb = run(ledB, { strict: true });
    check(hb.status === 1 && hb.stdout.includes("orphan/timeout 待处置") && hb.stdout.includes("转人工巡检"),
      "T14 blocking fail（含 strict）仍走待处置重投话术（原分支不回退）");
  }

  // ═══════ T15 --phase 三拍链桩测：断拍可判定 / 失败链降提示 / 完整链 ═══════
  {
    const led = writeLedger("t15-led.ndjson", [
      row({ command_id: "c-ok", dispatch_id: "d-ok", ok: true, attempt: 1 }),      // d-ok 完整链终态
      row({ command_id: "c-fail", dispatch_id: "d-fail", ok: false, error: "15s 超时，未收到 COMMAND_ACK", attempt: 2 }), // d-fail 终态失败
    ]);
    writeLedger("cli-phase.ndjson", [
      prow({ dispatch_id: "d-ok", command_id: "c-ok", phase: "send" }),
      prow({ dispatch_id: "d-ok", command_id: "c-ok", phase: "ack" }),
      prow({ dispatch_id: "d-ok", command_id: "c-ok", phase: "final", ok: true }),
      prow({ dispatch_id: "d-b1", command_id: "c-b1", phase: "send" }),            // 断拍：缺 ack+final
      prow({ dispatch_id: "d-b2", command_id: "c-b2", phase: "send" }),            // 断拍：缺 ack（send+final 在）
      prow({ dispatch_id: "d-b2", command_id: "c-b2", phase: "final", ok: false, error: "WS 连接意外关闭" }),
      prow({ dispatch_id: "d-fail", command_id: "c-fail", phase: "send" }),
      prow({ dispatch_id: "d-fail", command_id: "c-fail", phase: "ack" }),
      prow({ dispatch_id: "d-fail", command_id: "c-fail", phase: "final", ok: false, error: "15s 超时，未收到 COMMAND_ACK" }),
    ]);
    const r = run(led, { json: true, phase: true });
    const j = phaseJsonOf(r);
    check(r.status === 1, `T15 断拍存在 → exit 1（got ${r.status}）`);
    check(j.verdict === "fail" && j.counts.broken === 2 && j.counts.failed === 1 && j.counts.complete === 1,
      "T15 broken=2（d-b1 缺 ack+final / d-b2 缺 ack）failed=1 complete=1");
    const b1 = j.items.broken.find((it) => it.dispatch_id === "d-b1");
    const b2 = j.items.broken.find((it) => it.dispatch_id === "d-b2");
    check(!!b1 && b1.missing.join(",") === "ack,final" && !!b2 && b2.missing.join(",") === "ack",
      "T15 断拍明细：缺拍清单逐链可判定（b1 缺 ack+final / b2 仅缺 ack）");
    check(j.counts.success_missing_ledger_row === 0 && j.counts.ledger_without_phase === 0,
      "T15 交叉零异常（d-ok/d-fail 台账都有行）");
    const h = run(led, { phase: true });
    check(h.status === 1 && h.stdout.includes("① 断拍链") && h.stdout.includes("d-b1") && h.stdout.includes("勿臆断已投达"),
      "T15 人类可读：断拍链标记 + dispatch_id + 可判定文案");
    check(h.stdout.includes("② 失败链") && h.stdout.includes("归主对账面"),
      "T15 失败链降提示不重复判（019：ack ok 只证明投递不证明执行）");
  }

  // ═══════ T16 --phase 台账交叉：成功链终态缺行 fail / 旧账无 phase 链提示 / phase 账缺文件不谎报 ═══════
  {
    const ledA = writeLedger("t16a.ndjson", [
      row({ command_id: "c-x", dispatch_id: "d-other", ok: true, attempt: 1 }), // 台账只有别的 id
    ]);
    // phase 账与账本同目录同名派生（cli-phase.ndjson）——用独立沙箱目录承载固定名
    const sbA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c2-ph-"));
    fs.writeFileSync(path.join(sbA, "cli-dispatches.ndjson"), fs.readFileSync(ledA, "utf-8"), "utf-8");
    fs.writeFileSync(path.join(sbA, "cli-phase.ndjson"), [
      prow({ dispatch_id: "d-ghost", phase: "send" }),
      prow({ dispatch_id: "d-ghost", phase: "ack" }),
      prow({ dispatch_id: "d-ghost", phase: "final", ok: true }),
    ].join("\n") + "\n", "utf-8");
    const rA = run(null, { json: true, phase: true }, path.join(sbA, "cli-dispatches.ndjson"));
    const jA = phaseJsonOf(rA);
    check(rA.status === 1 && jA.verdict === "fail" && jA.counts.success_missing_ledger_row === 1,
      `T16 成功链终态缺行 → fail exit 1（got ${rA.status}）`);
    check(jA.items.success_missing_ledger_row[0] === "d-ghost", "T16 缺行明细带 dispatch_id");
    fs.rmSync(sbA, { recursive: true, force: true });

    const ledB = writeLedger("t16b.ndjson", [
      row({ command_id: "c-old", dispatch_id: "d-old", ok: true, attempt: 1 }), // 旧版期台账行
    ]);
    const sbB = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c2-ph-"));
    fs.writeFileSync(path.join(sbB, "cli-dispatches.ndjson"), fs.readFileSync(ledB, "utf-8"), "utf-8");
    fs.writeFileSync(path.join(sbB, "cli-phase.ndjson"), "", "utf-8");
    const rB = run(null, { json: true, phase: true }, path.join(sbB, "cli-dispatches.ndjson"));
    const jB = phaseJsonOf(rB);
    check(rB.status === 0 && jB.verdict === "clean" && jB.counts.ledger_without_phase === 1,
      "T16 旧账无 phase 链 → 提示计数不 fail（旧版/未落盘期非异常）");
    fs.rmSync(sbB, { recursive: true, force: true });

    const sbC = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c2-ph-")); // 无 cli-phase.ndjson
    fs.writeFileSync(path.join(sbC, "cli-dispatches.ndjson"), fs.readFileSync(ledB, "utf-8"), "utf-8");
    const rC = run(null, { phase: true }, path.join(sbC, "cli-dispatches.ndjson"));
    check(rC.status === 0 && rC.stdout.includes("phase 过程账不存在"),
      "T16 phase 账缺文件 → 明说非异常证据，不谎报 clean 也不误报 fail");
    fs.rmSync(sbC, { recursive: true, force: true });
  }

  // ═══════ T17 --phase 真链路：无网真跑 dispatch → phase 账六拍（C3 失败自动转存尾拍 queued）→ 过程对账 warn ═══════
  {
    const DISPATCH = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch");
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c2-real-"));
    const port = 1; // 保留端口必连接拒绝——无网态真跑，不走桩
    const dr = spawnSync("bash", [DISPATCH, "-c", '{"text":"c2-t17"}', "sess-real"], {
      encoding: "utf8",
      // CCR_TOKEN 显式钉测试常量（C2-fix）：port=1 连接拒绝不涉真鉴权，但 dispatch
      // :42 前置解析 token——透传 process.env 时纯净环境（无 CCR_TOKEN）走 fail
      // 「未找到 relay token」只落 1 拍，五拍断言即红（PM 无 CCR_TOKEN 环境坐实）
      env: { ...process.env, CCR_DATA_DIR: sb, CCR_PORT: String(port), CCR_ACK_TIMEOUT_MS: "100", CCR_TOKEN: "t17-fixed-token" },
    });
    check(dr.status === 1, `T17 无网 dispatch 非零退出（got ${dr.status}）`);
    const phaseRows = fs.readFileSync(path.join(sb, "cli-phase.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    // C3：失败自动转存后终局多一拍 queued（send,ack,send,ack,final,queued 六拍）
    check(phaseRows.length === 6, `T17 phase 账六拍（send/ack×2+final+queued，got ${phaseRows.length}）`);
    check(phaseRows.map((o) => o.phase).join(",") === "send,ack,send,ack,final,queued", "T17 phase 序列 send,ack,send,ack,final,queued（C3 转存尾拍）");
    check(phaseRows.map((o) => o.attempt).join(",") === "1,1,2,2,2,2", "T17 attempt 序列 1,1,2,2,2,2（queued 承终局 attempt）");
    check(new Set(phaseRows.map((o) => o.dispatch_id)).size === 1 && new Set(phaseRows.map((o) => o.command_id)).size === 1,
      "T17 六拍同 dispatch_id 同 command_id（三 ID 贯穿）");
    check(phaseRows[4].ok === false && String(phaseRows[4].error).includes("无法连接 relay"), "T17 final ok:false 可判定错误");
    check(phaseRows[5].phase === "queued" && phaseRows[5].ok === null && phaseRows[5].error === "deferred", "T17 queued 尾拍 ok:null error=deferred（挂起证据）");
    // C3 联动：无网真跑同时落队列凭据行（queued 含 envelope 全文）
    const qrow = JSON.parse(fs.readFileSync(path.join(sb, "cli-deferred.ndjson"), "utf-8").trim().split("\n")[0]) as Record<string, unknown>;
    check(qrow.type === "queued" && qrow.source === "auto" && qrow.dispatch_id === phaseRows[0].dispatch_id && qrow.command_id === phaseRows[0].command_id,
      "T17 队列凭据行 queued 与 phase 链三 ID 一致（source=auto）");
    const pr = run(null, { json: true, phase: true }, path.join(sb, "cli-dispatches.ndjson"));
    const pj = phaseJsonOf(pr);
    check(pr.status === 0 && pj.verdict === "warn" && pj.counts.broken === 0 && pj.counts.failed === 1,
      "T17 --phase 过程对账 warn exit 0（三拍齐但失败；终态处置归台账面；queued 拍不断拍）");
    check(pj.counts.success_missing_ledger_row === 0, "T17 台账有终态行，无缺行");
    // C3 主对账联动：台账 error 带 deferred: 前缀 → 排除 orphan/timeout 归 deferred，warn 不 blocking
    const mr = run(null, { json: true }, path.join(sb, "cli-dispatches.ndjson"));
    const mj = jsonOf(mr);
    check(mr.status === 0 && mj.verdict === "warn", "T17 主对账 deferred 单 warn exit 0（挂起非 blocking）");
    check(mj.counts.deferred === 1 && mj.counts.orphan === 0 && mj.counts.timeout === 0,
      "T17 台账 deferred 行归第四态（不进 orphan/timeout）");
    fs.rmSync(sb, { recursive: true, force: true });
  }

  // ═══════ T18 ACK 误读防回退锁死：三态（ok:false/超时 error/缺 ok）绝不判 success ═══════
  {
    const noOk = (over: RowOver): string => {
      const o = JSON.parse(row(over)) as Record<string, unknown>;
      delete o.ok;
      return JSON.stringify(o);
    };
    const led = writeLedger("t18.ndjson", [
      row({ command_id: "c-rej", dispatch_id: "d-rej", ok: false, error: "ACK ok 非 true：project not found", attempt: 1 }), // 明确拒收
      row({ command_id: "c-to", dispatch_id: "d-to", ok: false, error: "15s 超时，未收到 COMMAND_ACK", attempt: 2 }),       // 超时终态
      noOk({ command_id: "c-nook", dispatch_id: "d-nook" }),                                                              // body 无效形态（缺 ok）
    ]);
    const r = run(led, { json: true });
    const j = jsonOf(r);
    check(j.counts.success_commands === 0, "T18 三态行 success_commands 严格为 0（误读/失败绝不判成功）");
    check(j.counts.orphan === 1 && j.counts.timeout === 1 && j.counts.bad_rows === 1,
      "T18 拒收归 orphan、超时终态归 timeout、缺 ok 归坏行（三态各归其类）");
    check(r.status === 1, `T18 orphan+timeout 在 → exit 1（got ${r.status}）`);
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
