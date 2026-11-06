// W-PMRESOURCE-V1（#106 编排资源调派模型·件6）：子代理轻账断言档。
//   A 账三态：register/done/fail 同 id 末行收敛+raw/ledger 分层+countRunning
//   B orphan 扫描（注入 now 纯函数）：超阈扫出/未阈不扫/pending_dispose 幂等跳过/阈值 env
//   C markPendingDispose：running→pending_dispose 落行；已收口行幂等拒
//   D 回流门控 shouldLessonBackfill：kind/summary/gid 三条件
//   E orgAction 集成（真 SessionManager）：register→list→done（lesson 回流进组板）→
//     analyze 不回流→fail→重复上报拒
//   F 挂点静态锚：sweep 两挂点+ws 白名单+「不自动复活」语义锚
// 环境隔离：mkdtemp ORG/DATA（org 走 CCR_ORG_DIR，账走 cfg.dataDir 显式传参）。
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.CCR_STORAGE_READ_MODE = "json";
const ORG = mkdtempSync(join(tmpdir(), "sa-org-"));
const DATA = mkdtempSync(join(tmpdir(), "sa-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_NO_TITLE_GEN = "1";
delete process.env.CCR_CWD;

const { appendSubagentRow, readSubagentRowsRaw, readSubagentLedger, countRunningSubagents, scanOrphanSubagents, markPendingDispose, shouldLessonBackfill, subagentLogPath } = await import("../src/subagent-ledger.js");
const { createGroup, decideConfirm, setGroupStatus, loadBoard } = await import("../src/projects.js");
const { SessionManager } = await import("../src/session-manager.js");
const { EventBus } = await import("../src/event-bus.js");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
const smSrc = readFileSync(join(repoRoot, "relay/src/session-manager.ts"), "utf-8");
const wsSrc = readFileSync(join(repoRoot, "relay/src/ws-server.ts"), "utf-8");

async function main() {
  const T0 = 1_700_000_000_000;
  const mkRow = (over: Record<string, unknown>) => ({ ts: T0, id: "sa-aaaa0001", kind: "research", title: "调研 X", parent_sid: "pm-1", status: "running", registered_at: T0, ...over }) as import("../src/subagent-ledger.js").SubagentRow;

  // ================= A 账三态 =================
  console.log("A 账三态：");
  appendSubagentRow(mkRow({}), DATA);
  appendSubagentRow(mkRow({ ts: T0 + 1000, status: "done", done_at: T0 + 1000, artifact_path: "/tmp/a.md", summary: "X 可行", gid: "pg-t1" }), DATA);
  ok(readSubagentRowsRaw(DATA).length === 2, "A1 raw 逐行 2（append-only 审计面）");
  const led = readSubagentLedger(DATA);
  ok(led.length === 1 && led[0].status === "done" && led[0].artifact_path === "/tmp/a.md", "A2 末行收敛（同 id 末行赢=done 带产物）");
  appendSubagentRow(mkRow({ ts: T0 + 2000, id: "sa-bbbb0002", title: "审查 Y", kind: "review" }), DATA);
  ok(countRunningSubagents(DATA) === 1, "A3 countRunning 只数 running（done 不计）");
  appendSubagentRow(mkRow({ ts: T0 + 3000, id: "sa-bbbb0002", status: "failed", done_at: T0 + 3000, reason: "prompt 越界" }), DATA);
  ok(readSubagentLedger(DATA).find((r) => r.id === "sa-bbbb0002")?.status === "failed", "A4 fail 收口末行赢");
  ok(readSubagentRowsRaw(DATA).length === 4, "A5 raw 全量在册（四行不丢）");

  // ================= B orphan 扫描（注入 now） =================
  console.log("B orphan 扫描：");
  const T1 = T0 + 20 * 60_000; // 20 分钟后
  const ORG2 = mkdtempSync(join(tmpdir(), "sa-org2-"));
  appendSubagentRow(mkRow({ id: "sa-old0001", registered_at: T1 - 11 * 60_000 }), ORG2); // 超阈 11min
  appendSubagentRow(mkRow({ id: "sa-new0002", registered_at: T1 - 3 * 60_000 }), ORG2); // 未阈 3min
  appendSubagentRow(mkRow({ id: "sa-pd00003", registered_at: T1 - 30 * 60_000, status: "pending_dispose", reason: "已推卡" }), ORG2); // 已处置
  const sc = scanOrphanSubagents(ORG2, T1);
  ok(sc.length === 1 && sc[0].row.id === "sa-old0001" && sc[0].ageMs >= 10 * 60_000, "B1 超阈扫出（11min）+未阈/已处置不扫");
  ok(scanOrphanSubagents(ORG2, T1, 60 * 60_000).length === 0, "B2 阈值可调（60min 窗下 11min 不算孤儿）");

  // ================= C markPendingDispose =================
  console.log("C pending_dispose 标记：");
  const marked = markPendingDispose("sa-old0001", ORG2, "断档处置卡已推（test）");
  ok(!!marked && marked.status === "pending_dispose", "C1 running→pending_dispose 落行");
  ok(markPendingDispose("sa-old0001", ORG2, "再推") === null, "C2 幂等（已标记不再写）");
  ok(markPendingDispose("sa-pd00003", ORG2, "x") === null, "C3 终态/pending_dispose 行拒标（幂等闭环——推卡守门在 sweep 的 notify→mark 次序，F3 锚）");
  ok(scanOrphanSubagents(ORG2, T1).length === 0, "C4 标记后扫描清零（防重复推卡）");

  // ================= D 回流门控 =================
  console.log("D 回流门控：");
  ok(shouldLessonBackfill(mkRow({ kind: "research", status: "done", summary: "X 可行", gid: "pg-t1" })) === true, "D1 research+summary+gid=回流");
  ok(shouldLessonBackfill(mkRow({ kind: "review", status: "done", summary: "无 P0", gid: "pg-t1" })) === true, "D2 review 同回流");
  ok(shouldLessonBackfill(mkRow({ kind: "analyze", status: "done", summary: "中间步骤", gid: "pg-t1" })) === false, "D3 analyze 不回流（中间步骤不进记忆）");
  ok(shouldLessonBackfill(mkRow({ kind: "research", status: "done", summary: "", gid: "pg-t1" })) === false, "D4 无 summary 不回流");
  ok(shouldLessonBackfill(mkRow({ kind: "research", status: "done", summary: "有结论" })) === false, "D5 无 gid 不回流（账行已带索引，板回流须归属）");

  // ================= E orgAction 集成 =================
  console.log("E orgAction 集成：");
  const { createGroup: cg, decideConfirm: dc, setGroupStatus: sg } = await import("../src/projects.js");
  const gr = cg({ name: "子代理组", anchor_dir: join(ORG, "g1"), tier: "轻立项", headcount: [] });
  if (gr.ok && gr.confirm) dc(gr.confirm.id, true, "t");
  if (gr.ok && gr.group?.status === "pending") sg(gr.group.id, "active");
  const gid = gr.ok && gr.group ? gr.group.id : "";
  ok(!!gid, "E0 测试组建组 active");
  const cfg = { port: 8798, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [] as string[], cloudToken: "", cloudUrl: "", employeeConfigDir: null } as never;
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const reg = mgr.orgAction("subagent-report", { op: "register", kind: "research", title: "对比 A/B 两条链路", parent_sid: "pm-9", gid }) as { ok: boolean; data?: { id?: string }; error?: string };
  ok(reg.ok === true && typeof (reg as { data?: { id?: string } }).data?.id === "string", "E1 register ok（返 sa- id）");
  const saId = ((reg as { data?: { id?: string } }).data?.id) ?? "";
  const lst = mgr.orgAction("subagent-report", { op: "list" }) as { ok: boolean; data?: { rows?: { id: string; status: string }[]; running?: number } };
  ok(lst.ok === true && lst.data?.running === 1 && lst.data?.rows?.[0]?.id === saId, "E2 list 在途前置+running 计数");
  const dn = mgr.orgAction("subagent-report", { op: "done", id: saId, summary: "A 链路胜出（吞吐 2 倍），B 仅内存占优", artifact_path: "/tmp/x.md" }) as { ok: boolean; data?: { status?: string } };
  ok(dn.ok === true && dn.data?.status === "done", "E3 done 收口 ok");
  const lessons = gid ? loadBoard(gid).lessons ?? [] : [];
  ok(lessons.some((l) => l.text.includes("[子代理·research]") && l.text.includes(saId) && l.text.includes("A 链路胜出")), "E4 done 回流 lesson 一行（title+结论+产物+id——账进组板可查）");
  const regAn = mgr.orgAction("subagent-report", { op: "register", kind: "analyze", title: "中量数据分析", gid }) as { ok: boolean; data?: { id?: string } };
  const anId = regAn.data?.id ?? "";
  mgr.orgAction("subagent-report", { op: "done", id: anId, summary: "均值 3.2" });
  ok((loadBoard(gid).lessons ?? []).length === lessons.length, "E5 analyze done 不回流（门控生效——板 lesson 零新增）");
  const dup = mgr.orgAction("subagent-report", { op: "done", id: saId, summary: "再报" }) as { ok: boolean; error?: string };
  ok(dup.ok === false, "E6 已收口重复上报拒（append-only 末行赢的写侧闸）");
  const fl = mgr.orgAction("subagent-report", { op: "register", kind: "research", title: "失败样例" }) as { ok: boolean; data?: { id?: string } };
  const flId = fl.data?.id ?? "";
  const fr = mgr.orgAction("subagent-report", { op: "fail", id: flId, reason: "子代理超时" }) as { ok: boolean; data?: { status?: string } };
  ok(fr.ok === true && fr.data?.status === "failed", "E7 fail 收口（无 gid 无 summary 也不回流——主链不受阻）");
  const bad = mgr.orgAction("subagent-report", { op: "register", kind: "hack", title: "x" }) as { ok: boolean; error?: string };
  ok(bad.ok === false, "E8 kind 词表外拒收");
  ok(subagentLogPath(DATA).endsWith("subagent-log.ndjson"), "E9 账落 data/subagent-log.ndjson（* -log 命名对齐）");

  // ================= F 挂点静态锚 =================
  console.log("F 挂点静态锚：");
  ok(smSrc.includes("sweepOrphanSubagents(); // W-PMRESOURCE-V1（#106 件3）：重启 flush 边"), "F1 重启 flush 边挂点在（dutywire 邻接）");
  ok(smSrc.includes("sweepOrphanSubagents(); // W-PMRESOURCE-V1（#106 件3）：PM claim 落位边"), "F2 PM claim 落位边挂点在");
  ok(smSrc.includes("不自动复活进程") && smSrc.includes("markPendingDispose"), "F3 不自动复活语义锚+成功才标记（失败留 running 重试）");
  ok(smSrc.includes('case "subagent-report"') && smSrc.includes("shouldLessonBackfill(row)"), "F4 orgAction case+done 边门控回流");
  ok(wsSrc.includes('"subagent-report"'), "F5 ws/HTTP 白名单词在");
  ok(smSrc.includes("tags: [\"子代理\", row.kind]"), "F6 回流行带 kind 标签（lesson 可筛）");

  console.log(`\n== test-subagent：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

void main();
