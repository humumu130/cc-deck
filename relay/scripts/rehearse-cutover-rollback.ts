// CUT-1 闸门 5 取证：读面回退演练（docs/v2-dual-read-cutover.md §4.5+§6 口径原文）：
// 「演练环境执行一次 §6 回退路径并记录耗时与数据零丢失证明」。
// §6 回退路径：1.停 relay → 2.CCR_STORAGE_READ_MODE=json（或 unset）→ 3.起 relay：读路径回
// 旧 JSON 直读（读面切换即时生效，无迁移依赖）→ 4.缺口补写（本演练只证发现能力，不做补写）。
//
// 演练编排（进程隔离模拟 relay 生死——ensureStore 端口缓存按 dataDir 模块级单例，无公开
// 重置口，「停→起」以子进程生死模拟）：
//   父进程：mkdtemp fixture → 计时 spawnSync 三段 → 汇总耗时表+断言 → rm fixture。
//   phase=write（READ_MODE 未设=json 档写入，M1-2 期写者=JSON 直写现状）：
//     六域真写函数写入（group=createGroup×2、task=upsertBoardEntry×3、dispatch=appendDispatch×2、
//     lesson=addLesson×3、confirm=addConfirm×2+decideConfirm×1 终态面、notification=手工
//     notifications.json R1c 包裹形×2；加发 acceptance=手工 acceptances/<32hex>.json×1、
//     artifact=手工 deliverables.json×1——六域字面齐）→ 切 READ_MODE=sqlite（currentReadMode
//     每调解析 env，同进程即时生效）→ ensureStore 灌库 → **sqlite 档读值快照**落
//     <fixture>/sqlite-snapshot.json（翻转期生产读面等价物）。
//   phase=rollback（READ_MODE=json+指回 fixture）：§6 第 1-3 步——四读函数 json 档读值 vs
//     sqlite 快照逐域对账（键集全等+抽样字段全等；剔除备案有损映射面 trust_light[无表列
//     投影恒 false]/dispatch.target+dispatch.session_id[sqlite 投影两者恒空串，诊断实证]），
//     N 域断言+耗时输出。
//   phase=gap（§6 第 4 步模拟，可选加分）：删 json 侧 confirms.json 首单（模拟「JSON 停写期
//     缺口」）→ 切 READ_MODE=shadow 读一次（触发对账落 shadow-diff.ndjson）→ 抓 confirm 域
//     差异行报告（只证发现能力，不做补写）。
// 判据：rollback 段四域断言全过=数据零丢失证明；gap 段 shadow 抓到=缺口发现能力证明。
// 纪律：mkdtemp+env 五清；relay/src 零改；生产零触达；worker 不 commit。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//       npx tsx scripts/rehearse-cutover-rollback.ts [--skip-gap]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { setLightConfirmTrusted, createGroup, upsertBoardEntry, addLesson, addConfirm, decideConfirm, listGroups, listConfirms, listLessons } from "../src/projects.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { ensureStore } from "../src/storage/read-mode.js";

const self = fileURLToPath(import.meta.url);
const tsx = join(self, "..", "..", "node_modules", ".bin", "tsx"); // scripts/../.. = relay/

interface Snapshot { groups: unknown[]; confirms: unknown[]; lessons: Record<string, unknown[]>; dispatch: unknown[] }
const sha1hex = (s: string): string => createHash("sha1").update(s).digest("hex");

// ---------- phase=write：六域写入 + sqlite 档读值快照 ----------
function phaseWrite(fx: string): void {
  const orgDir = join(fx, "org");
  const dataDir = join(fx, "data");
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  process.env.CCR_ORG_DIR = orgDir;
  process.env.CCR_DATA_DIR = dataDir;
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE", "CCR_STORAGE_READ_MODE"]) delete process.env[k];

  const t0 = performance.now();
  writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "sess-rl-leader", leader_sdk_id: "sdk-rl", created_at: 1700000000000, updated_at: 1700000001000 }) + "\n");
  setLightConfirmTrusted(true);
  // group×2（轻立项+信任免确认→active）
  const gids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = createGroup({ name: `rollback-g${i}`, anchor_dir: `/fx/rollback/g${i}`, tier: "轻立项" });
    if (!r.ok || !r.group) throw new Error(`createGroup 失败: ${JSON.stringify(r)}`);
    gids.push(r.group.id);
  }
  // task×3（板条目，组 0 两张+组 1 一张）
  for (let i = 0; i < 3; i++) {
    const r = upsertBoardEntry(gids[i % 2]!, { text: `rollback task ${i}`, status: "todo" });
    if (!r.ok) throw new Error(`upsertBoardEntry 失败: ${JSON.stringify(r)}`);
  }
  // lesson×3
  for (let i = 0; i < 3; i++) {
    const r = addLesson(gids[0]!, { text: `rollback lesson ${i}`, tags: ["rollback"] });
    if (!r.ok) throw new Error(`addLesson 失败: ${JSON.stringify(r)}`);
  }
  // dispatch×2
  for (let i = 0; i < 2; i++) {
    if (!appendDispatch({ ts: 1700000000000 + i, id: `d-rl-${i}`, tier: "轻立项", target: "org-leader", status: i === 0 ? "done" : "running", session_id: `sess-rl-${i}` })) throw new Error("appendDispatch 失败");
  }
  // confirm×2 + 决议×1（终态面）
  const c1 = addConfirm({ kind: "archive", title: "rollback confirm A", reason: "演练", payload: { gid: gids[0] } });
  addConfirm({ kind: "revive", title: "rollback confirm B", reason: "演练", payload: { gid: gids[1] } });
  const d = decideConfirm(c1.id, true, "leader");
  if (!d.ok) throw new Error(`decideConfirm 失败: ${JSON.stringify(d)}`);
  // notification×2（R1c 包裹形，手工——通知写面在 session-manager 内部，读面源形抄 import-notification）
  writeFileSync(join(dataDir, "notifications.json"), JSON.stringify({
    notifications: [
      { key: "rl-notif-a", kind: "info", title: "演练通知 A", body: "", actionable: false, created_at: 1700000000100, sourceContext: {}, client_states: [] },
      { key: "rl-notif-b", kind: "done", title: "演练通知 B", body: "", actionable: false, created_at: 1700000000200, sourceContext: {}, client_states: [] },
    ],
  }) + "\n");
  // acceptance×1（sheet 最小合法形：32hex id/title/created_at/rows）
  const sheetId = sha1hex("rollback-sheet").slice(0, 32);
  mkdirSync(join(dataDir, "acceptances"), { recursive: true });
  writeFileSync(join(dataDir, "acceptances", `${sheetId}.json`), JSON.stringify({ id: sheetId, title: "演练验收单", created_at: 1700000000300, cwd: "/fx/rollback/g0", sheet_key: "rl", rows: [] }) + "\n");
  // artifact×1（deliverables.json 形 {sid,path,ts}）
  writeFileSync(join(dataDir, "deliverables.json"), JSON.stringify([{ sid: "sess-rl-0", path: "/fx/rollback/out.log", ts: 1700000000400 }]) + "\n");
  const writeMs = performance.now() - t0;

  // 切 sqlite 档（§6 回退的「翻转态」等价面）：灌库 + sqlite 读值快照
  const t1 = performance.now();
  process.env.CCR_STORAGE_READ_MODE = "sqlite";
  const port = ensureStore({ dataDir, orgDir, tasksDir: join(dataDir, "tasks") });
  const ensureMs = performance.now() - t1;
  const t2 = performance.now();
  const snapshot: Snapshot = {
    groups: listGroups(),
    confirms: listConfirms(),
    lessons: { [gids[0]!]: listLessons(gids[0]!), [gids[1]!]: listLessons(gids[1]!) },
    dispatch: readDispatchLog(),
  };
  const snapMs = performance.now() - t2;
  writeFileSync(join(fx, "sqlite-snapshot.json"), JSON.stringify({ snapshot, gids, sheetId }) + "\n");
  console.log(`WRITE_MS:${JSON.stringify({ writeMs, ensureMs, snapMs, groups: snapshot.groups.length, confirms: snapshot.confirms.length, dispatch: snapshot.dispatch.length, lessonsG0: snapshot.lessons[gids[0]!]?.length ?? 0 })}`);
  port.close();
}

// ---------- phase=rollback：json 档读回 + 逐域对账 ----------
function phaseRollback(fx: string): void {
  const orgDir = join(fx, "org");
  const dataDir = join(fx, "data");
  process.env.CCR_ORG_DIR = orgDir;
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_STORAGE_READ_MODE = "json"; // §6 第 2 步：读面回旧 JSON 直读
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE"]) delete process.env[k];

  const { snapshot, gids } = JSON.parse(readFileSync(join(fx, "sqlite-snapshot.json"), "utf-8")) as { snapshot: Snapshot; gids: string[] };
  const t0 = performance.now();
  const back: Snapshot = {
    groups: listGroups(),
    confirms: listConfirms(),
    lessons: { [gids[0]!]: listLessons(gids[0]!), [gids[1]!]: listLessons(gids[1]!) },
    dispatch: readDispatchLog(),
  };
  const readMs = performance.now() - t0;

  // 键集全等+抽样字段全等（剔除备案有损映射面 trust_light/dispatch.target——read-mode 头注备案）
  const results: { domain: string; pass: boolean; detail: string }[] = [];
  const keySet = <T,>(rows: T[], k: (r: T) => string): string => rows.map(k).sort().join();
  results.push({
    domain: "group",
    pass: keySet(snapshot.groups, (g) => (g as { id: string }).id) === keySet(back.groups, (g) => (g as { id: string }).id)
      && (snapshot.groups as { id: string; name: string; tier: string; status: string }[]).every((g) => {
        const b = (back.groups as { id: string; name: string; tier: string; status: string }[]).find((x) => x.id === g.id);
        return b !== undefined && b.name === g.name && b.tier === g.tier && b.status === g.status;
      }),
    detail: `groups ${snapshot.groups.length} vs ${back.groups.length}`,
  });
  results.push({
    domain: "confirm",
    pass: keySet(snapshot.confirms, (c) => (c as { id: string }).id) === keySet(back.confirms, (c) => (c as { id: string }).id)
      && (snapshot.confirms as { id: string; kind: string; status: string; title: string }[]).every((c) => {
        const b = (back.confirms as { id: string; kind: string; status: string; title: string }[]).find((x) => x.id === c.id);
        return b !== undefined && b.kind === c.kind && b.status === c.status && b.title === c.title;
      }),
    detail: `confirms ${snapshot.confirms.length} vs ${back.confirms.length}（含 decided 终态面）`,
  });
  const lessonPass = gids.every((gid) => {
    const a = (snapshot.lessons[gid] ?? []) as { id: string; text: string }[];
    const b = (back.lessons[gid] ?? []) as { id: string; text: string }[];
    return keySet(a, (l) => l.id) === keySet(b, (l) => l.id) && a.every((l) => b.find((x) => x.id === l.id)?.text === l.text);
  });
  results.push({ domain: "lesson", pass: lessonPass, detail: `lessons ${Object.values(snapshot.lessons).flat().length} vs ${Object.values(back.lessons).flat().length}` });
  results.push({
    domain: "dispatch",
    pass: keySet(snapshot.dispatch, (e) => (e as { id: string }).id) === keySet(back.dispatch, (e) => (e as { id: string }).id)
      && (snapshot.dispatch as { id: string; ts: number; tier: string; status: string }[]).every((e) => {
        const b = (back.dispatch as { id: string; ts: number; tier: string; status: string }[]).find((x) => x.id === e.id);
        return b !== undefined && b.ts === e.ts && b.tier === e.tier && b.status === e.status;
      }),
    detail: `dispatch ${snapshot.dispatch.length} vs ${back.dispatch.length}（抽样 ts/tier/status；剔除备案有损面 target+session_id——sqlite 投影两者恒空串，诊断实证）`,
  });

  const allPass = results.every((r) => r.pass);
  console.log(`ROLLBACK_MS:${JSON.stringify({ readMs })}`);
  console.log(`ROLLBACK_RESULT:${JSON.stringify({ allPass, results })}`);
}

// ---------- phase=gap：json 侧缺口 + shadow 发现能力（§6 第 4 步模拟） ----------
// 时序关键（与真实缺口同构）：先 shadow 档 ensureStore 灌库（完整态入库）→ 再删 json 侧
// confirms.json 首单并**恢复 mtime**（checkpoint mtime 桶判定「源未变」→ 快进跳过重灌 → 库
// 保持删前快照）→ listConfirms() 触发对账 → shadow 抓「库有 json 无」。恢复 mtime 的语义=
// 绕过快进判定的直写/救援写（真实缺口成因：mtime 桶语义外的变更库侧不可见，而 shadow 每读
// 实时比对恰好能抓——发现能力与 checkpoint 快进解耦，正是 §6 第 4 步要证的面）。只证发现，
// 不做补写。
function phaseGap(fx: string): void {
  const orgDir = join(fx, "org");
  const dataDir = join(fx, "data");
  process.env.CCR_ORG_DIR = orgDir;
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_STORAGE_READ_MODE = "shadow";
  for (const k of ["CCR_TOKEN", "CCR_PORT", "CCR_STUB_MODE"]) delete process.env[k];
  // ① 库灌完整态（新进程 portCache 空，首建灌库=删前快照）
  const port = ensureStore({ dataDir, orgDir, tasksDir: join(dataDir, "tasks") });
  // ② 删 json 侧首单 + 恢复 mtime（checkpoint 判「源未变」跳过重灌）
  const cfPath = join(orgDir, "confirms.json");
  const st = statSync(cfPath);
  const doc = JSON.parse(readFileSync(cfPath, "utf-8")) as { confirms: { id: string }[] };
  const removed = doc.confirms.shift();
  writeFileSync(cfPath, JSON.stringify(doc) + "\n");
  utimesSync(cfPath, st.atime, st.mtime);
  // ③ shadow 读一次（端口缓存命中不重灌）→ 对账落 shadow-diff.ndjson
  listConfirms();
  port.close();
  const diffPath = join(dataDir, "shadow-diff.ndjson");
  const rows = existsSync(diffPath)
    ? (readFileSync(diffPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { domain: string; key: string; category: string }))
    : [];
  const caught = rows.filter((r) => r.domain === "confirm" && r.key === (removed?.id ?? "?"));
  console.log(`GAP_RESULT:${JSON.stringify({ removedId: removed?.id ?? null, diffRows: rows.length, caught: caught.length, categories: caught.map((c) => c.category) })}`);
}

// ---------- 父进程编排 ----------
function main(): void {
  for (const k of ["CCR_TOKEN", "CCR_ORG_DIR", "CCR_DATA_DIR", "CCR_PORT", "CCR_STUB_MODE", "CCR_STORAGE_READ_MODE"]) delete process.env[k];
  const fx = mkdtempSync(join(tmpdir(), "cc-deck-rollback-"));
  const skipGap = process.argv.includes("--skip-gap");
  const spawn = (phase: string): string => {
    const t0 = performance.now();
    const r = spawnSync(tsx, [self, `--phase=${phase}`, fx], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      console.error(`[rehearse] phase=${phase} 子进程失败（exit=${r.status}）:\n${r.stdout}\n${r.stderr}`);
      process.exitCode = 1;
      rmSync(fx, { recursive: true, force: true });
      process.exit(1);
    }
    console.log(`  phase=${phase} 段耗时 ${ms.toFixed(0)} ms（含 tsx 进程冷启动）`);
    return r.stdout;
  };

  console.log("== CUT-1 闸门 5：读面回退演练（§6 路径，mkdtemp 全链，生产零触达）==");
  const parseLine = <T,>(out: string, tag: string): T => {
    const line = out.split("\n").find((l) => l.startsWith(`${tag}:`));
    if (!line) throw new Error(`子进程输出缺 ${tag}: 行`);
    return JSON.parse(line.slice(line.indexOf(":") + 1)) as T;
  };
  const wOut = spawn("write");
  const wMs = parseLine<{ writeMs: number; ensureMs: number; snapMs: number; groups: number; confirms: number; dispatch: number; lessonsG0: number }>(wOut, "WRITE_MS");
  const rOut = spawn("rollback");
  const rMs = parseLine<{ readMs: number }>(rOut, "ROLLBACK_MS");
  const rRes = parseLine<{ allPass: boolean; results: { domain: string; pass: boolean; detail: string }[] }>(rOut, "ROLLBACK_RESULT");
  let gapCaught = -1;
  if (!skipGap) {
    const gOut = spawn("gap");
    const gRes = parseLine<{ removedId: string | null; diffRows: number; caught: number }>(gOut, "GAP_RESULT");
    gapCaught = gRes.caught;
  }

  console.log("\n== 演练记录（耗时表）==");
  console.log(`  六域写入（写函数 JSON 直写）           : ${wMs.writeMs.toFixed(1)} ms`);
  console.log(`  ensureStore 灌库（翻转态首读一次性成本）: ${wMs.ensureMs.toFixed(1)} ms`);
  console.log(`  sqlite 档读值快照（四读函数）          : ${wMs.snapMs.toFixed(2)} ms（groups=${wMs.groups} confirms=${wMs.confirms} dispatch=${wMs.dispatch} lessons=${wMs.lessonsG0}）`);
  console.log(`  §6 回退：切 json 档读回+对账           : ${rMs.readMs.toFixed(2)} ms`);
  console.log("\n== 数据零丢失证明（sqlite 快照 vs json 读回，四域逐域断言）==");
  for (const r of rRes.results) console.log(`  [${r.pass ? "✓" : "✗"}] ${r.domain} 域：${r.detail}`);
  console.log(`  四域断言 ${rRes.allPass ? "全过——数据零丢失成立" : "有失败——零丢失不成立（回单报红）"}`);
  if (gapCaught >= 0) {
    console.log(`\n== §6 第 4 步缺口发现能力模拟（只证发现，不做补写）==`);
    console.log(`  ${gapCaught > 0 ? `✓ shadow 档对账抓到被删 confirm 单（${gapCaught} 行差异命中）——缺口发现能力成立` : "✗ shadow 未抓到缺口（回单报红）"}`);
  }
  const pass = rRes.allPass && (skipGap || gapCaught > 0);
  console.log(`\nREHEARSE verdict: ${pass ? "PASS（回退路径可用+零丢失+缺口可发现——闸门 5 判据满足）" : "FAIL（见上，报回单）"} [run ${randomUUID().slice(0, 6)}]`);
  if (!pass) process.exitCode = 1;
  rmSync(fx, { recursive: true, force: true });
}

// ---------- 入口分派 ----------
const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
if (phaseArg) {
  const fx = process.argv[process.argv.indexOf(phaseArg) + 1] ?? "";
  const phase = phaseArg.slice("--phase=".length);
  if (phase === "write") phaseWrite(fx);
  else if (phase === "rollback") phaseRollback(fx);
  else if (phase === "gap") phaseGap(fx);
  else { console.error(`未知 phase: ${phase}`); process.exitCode = 1; }
} else {
  main();
}
