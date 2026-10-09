// CUT-1 闸门 6 取证：读面性能 bench（docs/v2-dual-read-cutover.md §4.6 口径原文）：
// 「sqlite 档读路径在真实数据量级（当前生产 events 规模）下不慢于 json 档基线
//  （bench 口径：四读函数×1000 次取样）」。
//
// 四读函数 = read-mode 接线面原文四件（viaReadMode 四消费点，M11-G1 读入口接线）：
//   listGroups      ← projects.ts readProjectsFile（group 域，private 经公开包装同一路径）
//   listConfirms    ← projects.ts readConfirms（confirm 域，同上）
//   listLessons     ← projects.ts（lesson 域）
//   readDispatchLog ← org.ts（dispatch 域唯一读原点）
//
// **进程隔离取样（方法论备案，v8 JIT 状态污染教训）**：同进程先跑 json 档 5000 次再切
// sqlite 档，sqlite 投影函数被 JIT 解释执行态污染（lessonsFromDb 实测 0.01ms→0.9ms，
// 90×劣化，干净进程对照实证）——两档**各自独立子进程**取样（每档干净 JIT 状态），主进程
// 汇总判据。fixture 由主进程建一次共享（json 子进程零写；sqlite 子进程写库+checkpoint，
// 源 mtime 不动→checkpoint 五元组稳定）。
//
// 取样口径：每函数每档 SAMPLES=1000 次 performance.now() 单调计时；**首轮冷样本弃出统计
// 单独备案**（json 档冷=文件系统冷缓存；sqlite 档冷=ensureStore 首调 open+migrate+
// importAllForShadow 全链灌库——翻转后生产首次读的一次性成本），热样本=余 999 次×ROUNDS
// 轮取中位轮报 P50/P95/均值（多轮中位降噪：微基准单轮分布受调度噪声主导）。
// 判据：sqlite 档热 P50 与均值均 ≤ json 档热（等值或更快即过）；慢 → 报告差距百分比+
// 瓶颈定位，**不擅自优化**（只取证，优化另立单）。
//
// 数据量级两档（§4.6「真实数据量级」+合成放大）：
//   m2    = ~/.cc-deck-m2 的 org/ + data/ **复制副本**（cpSync preserveTimestamps 保 mtime
//           ——checkpoint 五元组依赖 mtime 稳定；不直连不写源）。实况：events.ndjson
//           19193 行/25.5MB、dispatch-log.ndjson 24 行、org.json 锚、无 boards/confirms/
//           projects.json——group/confirm/lesson 域读缺失路径（两档等价空读，备案）。
//   synth = 合成放大档（合成逻辑内嵌本脚本，不另立件）：events ~20 万行合法事件流
//           （4000 session×50 行=CREATED+DONE+48×HEARTBEAT——HEARTBEAT 零实体写入是重放
//           快路径，CREATED 带 payload.cwd 合法建行，session 表 4000 行灌库量级）、
//           dispatch-log 250 行（appendDispatch 真写）、confirms 20 单（addConfirm 真写）、
//           org 面 groups×5（createGroup 真写，maxActiveGroups 护栏内顶格，trust_light 先开
//           避 pending）+boards×5 各 500 lesson（addLesson 真写——m2 无板，合成档补 lesson
//           域读量证据）。等比基准：m2 events 19193×10.4≈20 万、dispatch 24×10.4≈250。
//
// 纪律：mkdtemp+env 五清；生产 ~/.cc-deck 与 8787 零触达（m2 只复制副本只读）；relay/src
// 零改（只 import 现有读函数）；不改 package.json（注册行建议 bench:read 报回单 Leader 代提交）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//       npx tsx scripts/bench-read-mode.ts [--m2|--synth]（缺省两档全跑）
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setLightConfirmTrusted, createGroup, addLesson, addConfirm, listGroups, listConfirms, listLessons } from "../src/projects.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { ensureStore } from "../src/storage/read-mode.js";

const SAMPLES = 1000;
/** 降噪轮数：单轮 999 热样本的微秒级分布受调度噪声主导——ROUNDS 轮各报 P50/P95/mean，
 * 取中位轮为该函数代表值。 */
const ROUNDS = 5;
const SYNTH_SESSIONS = 4000;
const SYNTH_EVENTS_PER_SESSION = 50; // CREATED + DONE + 48×HEARTBEAT
const SYNTH_DISPATCH = 250;
const SYNTH_GROUPS = 5; // maxActiveGroups 护栏=5（projects.ts），超限即拒——护栏内顶格
const SYNTH_LESSONS_PER_BOARD = 500;
const SYNTH_CONFIRMS = 20;

interface Stats { cold: number; p50: number; p95: number; mean: number }
interface FnSample { name: string; p50: number; p95: number; mean: number }
interface SampleReport { tier: string; mode: string; coldMs: number; fns: FnSample[]; probe: Record<string, number> }

const fmt = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(4));

/** 取样器：首轮冷样本单独计时弃出；ROUNDS 轮各 SAMPLES-1 热样本，取中位轮的 P50/P95/mean。 */
function bench(fn: () => unknown): Stats {
  const c0 = performance.now();
  fn();
  const cold = performance.now() - c0;
  const rounds: Stats[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const xs: number[] = [];
    for (let i = 0; i < SAMPLES - 1; i++) {
      const a = performance.now();
      fn();
      xs.push(performance.now() - a);
    }
    xs.sort((a, b) => a - b);
    rounds.push({ cold, p50: xs[Math.floor(xs.length * 0.5)] ?? 0, p95: xs[Math.floor(xs.length * 0.95)] ?? 0, mean: xs.reduce((s, x) => s + x, 0) / xs.length });
  }
  rounds.sort((a, b) => a.mean - b.mean);
  return rounds[Math.floor(rounds.length / 2)] ?? rounds[0] ?? { cold, p50: 0, p95: 0, mean: 0 };
}

// ---------- 合成放大档 fixture（真写函数路径，产物天然合法） ----------
function synthFixture(fx: string): { firstGid: string; events: number } {
  const orgDir = join(fx, "org");
  const dataDir = join(fx, "data");
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  process.env.CCR_ORG_DIR = orgDir;
  process.env.CCR_DATA_DIR = dataDir;
  // org 锚（import-org Leader member 路径；形抄 test-import-org fixture）
  writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "sess-bench-leader", leader_sdk_id: "sdk-bench", created_at: 1700000000000, updated_at: 1700000001000 }) + "\n");
  setLightConfirmTrusted(true); // 轻立项免确认→组直接 active（板可写）
  let firstGid = "";
  for (let g = 0; g < SYNTH_GROUPS; g++) {
    const r = createGroup({ name: `bench-g${g}`, anchor_dir: `/fx/bench/g${g}`, tier: "轻立项" });
    if (!r.ok || !r.group) throw new Error(`createGroup 失败: ${JSON.stringify(r)}`);
    if (g === 0) firstGid = r.group.id;
    for (let l = 0; l < SYNTH_LESSONS_PER_BOARD; l++) {
      const lr = addLesson(r.group.id, { text: `bench lesson ${g}-${l}（合成放大档灌库量级证据）`, tags: ["bench"] });
      if (!lr.ok) throw new Error(`addLesson 失败: ${JSON.stringify(lr)}`);
    }
  }
  for (let c = 0; c < SYNTH_CONFIRMS; c++) addConfirm({ kind: "archive", title: `bench confirm ${c}`, reason: "bench", payload: { gid: firstGid } });
  for (let d = 0; d < SYNTH_DISPATCH; d++) {
    const ok = appendDispatch({ ts: 1700000000000 + d, id: `d-bench-${d}`, tier: "轻立项", target: "org-leader", status: "done", session_id: `sess-bench-${d}` });
    if (!ok) throw new Error("appendDispatch 失败");
  }
  // events ~20 万行（NDJSON 直写——写函数面无 events 真写口，合成行形抄 import-session-task
  // 事件词表；CREATED 带 payload.cwd 合法建行，HEARTBEAT 零实体写入=重放快路径）。
  // 流式逐行写（不攒大数组——堆驻留会干扰子进程微基准）
  let n = 0;
  const evPath = join(dataDir, "events.ndjson");
  const lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) {
      writeFileSync(evPath, lines.join("\n") + "\n", { flag: "a" });
      lines.length = 0;
    }
  };
  for (let s = 0; s < SYNTH_SESSIONS; s++) {
    const sid = `sess-bench-ev-${s}`;
    const base = 1700000000000 + s * 1000;
    lines.push(JSON.stringify({ session_id: sid, type: "SESSION_CREATED", ts: base, payload: { cwd: "/fx/bench/ev" } }));
    for (let h = 0; h < SYNTH_EVENTS_PER_SESSION - 2; h++) lines.push(JSON.stringify({ session_id: sid, type: "SESSION_HEARTBEAT", ts: base + h + 1, payload: {} }));
    lines.push(JSON.stringify({ session_id: sid, type: "SESSION_DONE", ts: base + SYNTH_EVENTS_PER_SESSION - 1, payload: { done_reason: "bench", duration_ms: 1000 } }));
    n += SYNTH_EVENTS_PER_SESSION;
    if (lines.length >= 2000) flush();
  }
  flush();
  return { firstGid, events: n };
}

// ---------- m2 实数据复制副本 fixture ----------
function m2Fixture(fx: string): void {
  const m2 = join(process.env.HOME ?? "", ".cc-deck-m2");
  cpSync(join(m2, "org"), join(fx, "org"), { recursive: true, preserveTimestamps: true });
  cpSync(join(m2, "data"), join(fx, "data"), { recursive: true, preserveTimestamps: true });
  process.env.CCR_ORG_DIR = join(fx, "org");
  process.env.CCR_DATA_DIR = join(fx, "data");
}

// ---------- 子进程：单档单 mode 取样（--phase=sample）——每子进程单一档=干净 JIT 状态 ----------
function samplePhase(tier: string, mode: string, fx: string, gid: string): void {
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE"]) delete process.env[k];
  process.env.CCR_ORG_DIR = join(fx, "org");
  process.env.CCR_DATA_DIR = join(fx, "data");
  process.env.CCR_STORAGE_READ_MODE = mode;

  const fns: { name: string; fn: () => unknown }[] = [
    { name: "listGroups", fn: () => listGroups() },
    { name: "listConfirms", fn: () => listConfirms() },
    { name: "listLessons", fn: () => listLessons(gid) },
    { name: "readDispatchLog", fn: () => readDispatchLog() },
  ];
  const probe: Record<string, number> = {};
  let coldMs = -1;
  // sqlite 档：先显式 ensureStore 计冷启动（open+migrate+全链灌库，一次性翻转首读成本），
  // 再取样（其后 viaReadMode 内 ensureStore 恒缓存命中=零快进税的热路径）。json 档冷=首调
  // 文件系统冷缓存（bench 首轮弃出值）。
  if (mode === "sqlite") {
    const c0 = performance.now();
    const port = ensureStore({ dataDir: join(fx, "data"), orgDir: join(fx, "org"), tasksDir: join(fx, "data", "tasks") });
    coldMs = performance.now() - c0;
    probe.sqliteSessions = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -1;
  }
  const out: FnSample[] = [];
  for (const f of fns) {
    const st = bench(f.fn);
    out.push({ name: f.name, p50: st.p50, p95: st.p95, mean: st.mean });
    if (f.name === "listGroups" && mode === "json") coldMs = st.cold;
  }
  probe.groups = (fns[0]!.fn() as unknown[]).length;
  probe.confirms = (fns[1]!.fn() as unknown[]).length;
  probe.lessons = (fns[2]!.fn() as unknown[]).length;
  probe.dispatch = (fns[3]!.fn() as unknown[]).length;
  const report: SampleReport = { tier, mode, coldMs, fns: out, probe };
  console.log(`BENCH_JSON:${JSON.stringify(report)}`);
}

// ---------- 主进程：建 fixture→两子进程取样→汇总判据 ----------
async function main(): Promise<void> {
  const arg = process.argv[2] ?? "--all";
  const tiers = arg === "--m2" ? ["m2"] : arg === "--synth" ? ["synth"] : ["m2", "synth"];
  for (const k of ["CCR_TOKEN", "CCR_ORG_DIR", "CCR_DATA_DIR", "CCR_PORT", "CCR_STUB_MODE", "CCR_STORAGE_READ_MODE"]) delete process.env[k];
  const self = fileURLToPath(import.meta.url);

  const report: string[] = [];
  let allPass = true;
  for (const tier of tiers) {
    const fx = mkdtempSync(join(tmpdir(), `cc-deck-bench-${tier}-`));
    let eventsDesc = "";
    let gid = "pg-bench-nonexistent";
    if (tier === "m2") {
      m2Fixture(fx);
      gid = "pg-nonexistent"; // m2 无组：lesson 域读缺失路径（两档等价空读，备案）
      eventsDesc = "events 19193 行/25.5MB（m2 实况，复制副本）";
    } else {
      const s = synthFixture(fx);
      gid = s.firstGid;
      eventsDesc = `events ${s.events} 行（合成 ${SYNTH_SESSIONS} session×${SYNTH_EVENTS_PER_SESSION} 行）+dispatch ${SYNTH_DISPATCH}+lesson ${SYNTH_GROUPS * SYNTH_LESSONS_PER_BOARD}+confirms ${SYNTH_CONFIRMS}`;
    }

    const samples: Record<string, SampleReport> = {};
    for (const mode of ["json", "sqlite"]) {
      const r = spawnSync(join(dirname(self), "..", "node_modules", ".bin", "tsx"), [self, "--phase=sample", "--tier", tier, "--mode", mode, "--fx", fx, "--gid", gid], {
        encoding: "utf8",
        timeout: 600_000,
        env: { ...process.env },
      });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("BENCH_JSON:"));
      if (!line) {
        console.error(`[bench] ${tier}/${mode} 子进程取样失败:\n${r.stdout}\n${r.stderr}`);
        process.exitCode = 1;
        return;
      }
      const rep = JSON.parse(line.slice("BENCH_JSON:".length)) as SampleReport;
      samples[mode] = rep;
    }

    const j = samples["json"]!;
    const q = samples["sqlite"]!;
    report.push(`== 量级档 ${tier}（${eventsDesc}）==`);
    report.push(`  冷启动备案：json 首调=${fmt(j.coldMs)} ms；sqlite ensureStore（open+migrate+全链灌库，一次性翻转首读成本）=${fmt(q.coldMs)} ms${q.probe.sqliteSessions !== undefined ? `（session 表 ${q.probe.sqliteSessions} 行）` : ""}`);
    report.push("  函数            |  json P50 |  json P95 | json mean |  sql P50  |  sql P95  | sql mean  | 判定");
    for (const jf of j.fns) {
      const qf = q.fns.find((x) => x.name === jf.name);
      if (!qf) continue;
      const pass = qf.p50 <= jf.p50 && qf.mean <= jf.mean;
      if (!pass) allPass = false;
      const pct = (x: number, y: number): string => (y > 0 ? `（${(((x - y) / y) * 100).toFixed(1)}%）` : "");
      const note = pass ? "PASS" : `SLOW p50${pct(qf.p50, jf.p50)} mean${pct(qf.mean, jf.mean)}`;
      report.push(`  ${jf.name.padEnd(15)} | ${fmt(jf.p50).padStart(9)} | ${fmt(jf.p95).padStart(9)} | ${fmt(jf.mean).padStart(9)} | ${fmt(qf.p50).padStart(9)} | ${fmt(qf.p95).padStart(9)} | ${fmt(qf.mean).padStart(9)} | ${note}`);
    }
    report.push(`  读值探针（防死代码消除+非空面证词）：groups=${q.probe.groups} confirms=${q.probe.confirms} lessons=${q.probe.lessons} dispatch=${q.probe.dispatch}`);
    report.push("");

    delete process.env.CCR_STORAGE_READ_MODE;
    delete process.env.CCR_ORG_DIR;
    delete process.env.CCR_DATA_DIR;
    rmSync(fx, { recursive: true, force: true });
  }

  console.log(report.join("\n"));
  console.log(`BENCH verdict: ${allPass ? "PASS（sqlite 档热路径四读函数均不慢于 json 档——闸门 6 判据满足）" : "SLOW（sqlite 档存在回退函数——差距与瓶颈定位见上表，不擅自优化，报回单裁度）"}`);
  if (!allPass) process.exitCode = 1;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}

// ---------- 入口分派 ----------
if (process.argv.includes("--phase=sample")) {
  const at = (k: string): string => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? (process.argv[i + 1] ?? "") : "";
  };
  samplePhase(at("--tier"), at("--mode"), at("--fx"), at("--gid"));
} else {
  void main();
}
