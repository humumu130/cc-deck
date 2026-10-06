// ---------- 导入 parity 报告：六域 M1 直读 vs v2 表投影等价性（M11-G2） ----------
// 六域对账口径（基准=M1 直读 json 档原路径，v2=导入 SQLite 后表投影）：
//   group        projects.json groups vs projectGroupsFromDb——数量/id 集/逐组 tier/status/headcount
//   task         tasksDir 文件 stem 集 vs task 表 external_task_file_id DISTINCT + status 映射抽样
//   dispatch     readDispatchLog（json 收敛视图）vs dispatchEntriesFromDb——id 集/逐 id 末态 status/
//                ts/段链收敛语义（含终态后再现行重投 #rN 场景）
//   notification notifications.json+decision-notifications.json 源 key 集 vs notification 表
//                condition_key 集（跨源同 key 归并）+ client_state 覆盖面
//   acceptance   acceptances 目录 stem∪doc.id 键集 vs acceptance_sheet/item/result + verdict 抽样
//   artifact     deliverables.json vs artifact 表——数量/按 source_id 分组数量/路径归一抽样
// 板语义回归锁：board entries 不入 SQLite（17 表无 board 表）——锁「v2 读面改造后 M1 板语义
//   零回归」：同一 board JSON 经 computeReadySet 输出逐条金值（depends_on 全 done/gate 未过/
//   坏引用路径各至少一例）+ listLessons tags 谓词投影侧与 json 侧同结果。
// loss 与差异稳定排序：报告排序键固定 domain→category→key；同 fixture 两轮连跑逐字节一致；
//   坏行 loss 各域至少一例，断言差异行内容与排序双稳定（差异全集=已知坏行清单）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-m1-import-parity.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { type StoragePort } from "../src/storage/port.js";
import { ensureStore, projectGroupsFromDb, dispatchEntriesFromDb, resetReadModeForTest, type ReadModeDirs } from "../src/storage/read-mode.js";
import { listLessons, computeReadySet } from "../src/projects.js";
import { readDispatchLog } from "../src/org.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ---------- parity 报告行与稳定排序（排序键固定 domain→category→key） ----------
interface ParityRow { domain: string; category: string; key: string; detail: string }
function row(domain: string, category: string, key: string, detail: string): ParityRow {
  return { domain, category, key, detail };
}
function sortRows(rows: ParityRow[]): ParityRow[] {
  const cmp = (a: ParityRow, b: ParityRow): number =>
    a.domain < b.domain ? -1 : a.domain > b.domain ? 1 :
    a.category < b.category ? -1 : a.category > b.category ? 1 :
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return [...rows].sort(cmp);
}
function reportLine(r: ParityRow): string {
  return `parity|${r.domain}|${r.category}|${r.key}|${r.detail}`;
}

// ---------- 造态（全部 mkdtemp 内联，不新增固定 fixture 文件） ----------
const root = mkdtempSync(join(tmpdir(), "cc-m1-parity-"));
const dataDir = join(root, "data");
const orgDir = join(root, "org");
const tasksDir = join(dataDir, "tasks");
const accDir = join(dataDir, "acceptances");
const boardsDir = join(orgDir, "boards");
for (const d of [dataDir, orgDir, join(tasksDir, "s-1"), accDir, boardsDir]) mkdirSync(d, { recursive: true });
// 读模式层 env 兜底链消费 CCR_DATA_DIR/CCR_ORG_DIR——测试显式指到 fixture（G1 首跑教训：
// 未注入时 resolveDirs 兜底 cwd/data，库文件会落进 relay/data）。
process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_ORG_DIR = orgDir;
const T = 1760000000000;
const hex = (ch: string): string => ch.repeat(32);

// org 前置（归因链依赖）：org.json + projects.json（g-1 好 + g-bad status 词表外坏组）+ confirms.json
writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "s-leader", created_at: T }, null, 2) + "\n");
const g1 = { id: "g-1", name: "serious", anchor_dir: "/fx/serious", status: "active", tier: "正经立项", headcount: [{ session_id: "s-1", role: "coder" }], role_defaults: { coder: { model: "sonnet" } }, single_card: false, created_at: T + 1, updated_at: T + 2 };
const gBad = { id: "g-bad", name: "bad", anchor_dir: "/fx/bad", status: "zombie", tier: "正经立项", headcount: [], single_card: false, created_at: T + 3, updated_at: T + 4 };
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({ trust_light: false, groups: [g1, gBad] }, null, 2) + "\n");
writeFileSync(join(orgDir, "confirms.json"), JSON.stringify({ confirms: [] }, null, 2) + "\n");

// task 域源：events.ndjson（s-1 归因链）+ tasksDir 树（3 好 + blocked 词表外 + 缺 subject 各一坏）
const ev = (seq: number, sid: string, ts: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ seq, session_id: sid, ts, type, payload });
writeFileSync(join(dataDir, "events.ndjson"),
  ev(1, "s-1", T, "SESSION_CREATED", { cwd: "/fx/serious", model: "sonnet", relay_session_id: "rs-1", initial_prompt: "p" }) + "\n");
const taskDoc = (id: string, subject: string | undefined, status: string): string =>
  JSON.stringify(subject === undefined
    ? { id, description: "d", status, blocks: [], blockedBy: [] }
    : { id, subject, description: "d", status, blocks: [], blockedBy: [] });
writeFileSync(join(tasksDir, "s-1", "t1.json"), taskDoc("1", "任务一", "pending") + "\n");
writeFileSync(join(tasksDir, "s-1", "t2.json"), taskDoc("2", "任务二", "in_progress") + "\n");
writeFileSync(join(tasksDir, "s-1", "t3.json"), taskDoc("3", "任务三", "completed") + "\n");
writeFileSync(join(tasksDir, "s-1", "t6.json"), taskDoc("6", "词表外", "blocked") + "\n");
writeFileSync(join(tasksDir, "s-1", "t8.json"), taskDoc("8", undefined, "pending") + "\n");

// dispatch 域源：disp-1 状态机三行 + disp-2 单行 + disp-3 终态后再现行（重投段）+ 缺 id 坏行
const dLines = [
  { ts: T + 50, id: "disp-1", tier: "正经立项", target: "s-1", status: "dispatched", session_id: "s-leader", actor: "user" },
  { ts: T + 51, id: "disp-1", tier: "正经立项", target: "s-1", status: "running", session_id: "s-leader" },
  { ts: T + 52, id: "disp-1", tier: "正经立项", target: "s-1", status: "done", receipt: "收口ok", session_id: "s-leader", actor: "user" },
  { ts: T + 53, id: "disp-2", tier: "咨询", target: "s-leader", status: "dispatched", session_id: "s-leader" },
  { ts: T + 60, id: "disp-3", tier: "正经立项", target: "s-1", status: "done", session_id: "s-leader" },
  { ts: T + 70, id: "disp-3", tier: "正经立项", target: "s-1", status: "dispatched", session_id: "s-leader", actor: "user" },
  { ts: T + 71, id: "disp-3", tier: "正经立项", target: "s-1", status: "running", session_id: "s-leader" },
  { ts: T + 80, status: "dispatched", tier: "咨询", target: "s-x", session_id: "s-leader" },
];
writeFileSync(join(orgDir, "dispatch-log.ndjson"), dLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// lesson 源（boardsDir）+ board entries（computeReady 板语义锁：ready/依赖未完成/gate/坏引用路径）
writeFileSync(join(boardsDir, "g-1.json"), JSON.stringify({
  gid: "g-1",
  entries: [
    { id: "e-done", text: "已完成卡", ts: T + 43, updated_at: T + 43, title: "已完成卡", status: "done" },
    { id: "e-a", text: "无依赖卡", ts: T + 43, updated_at: T + 43, title: "无依赖卡", status: "todo" },
    { id: "e-b", text: "依赖全 done", ts: T + 43, updated_at: T + 43, title: "依赖全 done", status: "doing", depends_on: ["e-done"] },
    { id: "e-c", text: "gate 未过", ts: T + 43, updated_at: T + 43, title: "gate 未过", status: "doing", depends_on: ["e-done"], gate: { reason: "等用户验收", opened_at: T + 44 } },
    { id: "e-d", text: "坏引用", ts: T + 43, updated_at: T + 43, title: "坏引用", status: "todo", depends_on: ["e-ghost"] },
  ],
  lessons: [
    { id: "l-1", text: "经验一", tags: ["react", "p1"], ts: T + 40 },
    { id: "l-2", text: "经验二", tags: ["p2"], ts: T + 41, source_dispatch_id: "disp-1" },
  ],
  frozen: false, updated_at: T + 42,
}, null, 2) + "\n");

// notification 域源：notifications.json（proj 形含 client_states）+ decision-notifications.json（ledger 形）
// k-1 跨源双见（E1 归并先例）；k-bad 缺 kind 拒入。
writeFileSync(join(dataDir, "notifications.json"), JSON.stringify({ notifications: [
  { key: "k-1", kind: "org-confirm", group: "action", severity: "waiting", title: "确认单等批", body: "b1",
    sourceContext: { domain: "org", entityId: "g-1", sessionId: "s-leader" }, actionable: true, created_at: T + 90,
    client_states: [{ client_id: "phone", read_at: T + 91 }, { client_id: "desktop", read_at: T + 92, dismissed_at: T + 93 }] },
  { key: "k-2", kind: "org-confirm", group: "action", severity: "waiting", title: "确认单二", body: "b2",
    sourceContext: { domain: "org", entityId: "g-1" }, actionable: true, created_at: T + 94 },
  { key: "k-bad", created_at: T + 95 },
] }, null, 2) + "\n");
writeFileSync(join(dataDir, "decision-notifications.json"), JSON.stringify([
  { key: "k-1", kind: "decision", source_session_id: "s-1", created_at: T + 96, first_sent_at: T + 96, group: "action", actionable: true, revision: 1 },
  { key: "k-4", kind: "decision", source_session_id: "s-1", created_at: T + 97, first_sent_at: T + 97, group: "action", actionable: true, revision: 1 },
], null, 2) + "\n");

// acceptance 域源：sheet 登记单两好（stem 身份 + doc.id 优先身份）+ 坏 JSON + results 历史账
writeFileSync(join(accDir, `${hex("a")}.json`), JSON.stringify({
  id: hex("a"), title: "验收单一", created_at: T + 100, cwd: "/fx/serious",
  rows: [{ task: "t1", item: "项一", criteria: "标准一" }, { task: "t2", item: "项二", criteria: "标准二" }],
}, null, 2) + "\n");
writeFileSync(join(accDir, `${hex("b")}.json`), JSON.stringify({
  id: hex("c"), title: "doc.id 优先单", created_at: T + 101, cwd: "/fx/serious",
  rows: [{ task: "t3", item: "项三", criteria: "标准三" }],
}, null, 2) + "\n");
writeFileSync(join(accDir, `${hex("d")}.json`), "{oops 坏 json\n");
// results 历史：row.i=0-based item 序号（F1 词表），verdict 词表 pass|fail
writeFileSync(join(accDir, `${hex("c")}.results.json`), JSON.stringify({
  history: [{ at: T + 110, ua: "user-x", rows: [{ i: 0, verdict: "pass", note: "ok" }] }],
}, null, 2) + "\n");

// artifact 域源：deliverables.json 3 好行 + 缺 sid 坏行（missing-attribution）
writeFileSync(join(dataDir, "deliverables.json"), JSON.stringify([
  { sid: "s-1", path: "/repo/out/deck.html", ts: T + 120 },
  { sid: "s-1", path: "/repo/out/notes.md", ts: T + 121 },
  { sid: "s-1", path: "/repo/other/x.md", ts: T + 122 },
  { path: "/repo/orphan/y.md", ts: T + 123 },
], null, 2) + "\n");

const dirs: ReadModeDirs = { dataDir, orgDir, tasksDir };

// ---------- 六域对账（基准=json 档直读 vs v2=表投影；差异行如实产出，含已知坏行） ----------
function collectSourceKeys(dir: string, isSheet: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || !isSheet(name)) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, name), "utf-8")) as Record<string, unknown>;
      out.push(typeof p.id === "string" && p.id ? p.id : name.slice(0, -5));
    } catch { out.push(name.slice(0, -5)); } // 坏 JSON：键=stem（对账如实报 missing-in-sqlite）
  }
  return out;
}

function parityRows(port: StoragePort): ParityRow[] {
  const rows: ParityRow[] = [];

  // ① group：projects.json groups（json 直读）vs projectGroupsFromDb
  const srcGroups = (JSON.parse(readFileSync(join(orgDir, "projects.json"), "utf-8")) as { groups: { id: string; tier: string; status: string; headcount: unknown[] }[] }).groups;
  const dbGroups = projectGroupsFromDb(port);
  for (const g of srcGroups) {
    const hit = dbGroups.find((x) => x.id === g.id);
    if (!hit) rows.push(row("group", "missing-in-sqlite", g.id, "源组未入表（坏行拒入或导入缺口）"));
    else {
      if (hit.tier !== g.tier || hit.status !== g.status) rows.push(row("group", "value-mismatch", g.id, `tier/status: json=${g.tier}/${g.status} sqlite=${hit.tier}/${hit.status}`));
      if (JSON.stringify(hit.headcount) !== JSON.stringify(g.headcount)) rows.push(row("group", "value-mismatch", `${g.id}:headcount`, "headcount 不等"));
    }
  }
  for (const g of dbGroups) if (!srcGroups.some((x) => x.id === g.id)) rows.push(row("group", "missing-in-json", g.id, "表有源无"));

  // ② task：tasksDir 文件 stem 集 vs external_task_file_id DISTINCT + status 映射抽样
  const srcStems: string[] = [];
  for (const sid of readdirSync(tasksDir).sort()) {
    const sub = join(tasksDir, sid);
    for (const f of readdirSync(sub).sort()) if (f.endsWith(".json")) srcStems.push(f.slice(0, -5));
  }
  const dbStems = new Set((port.query<{ external_task_file_id: string }>("SELECT DISTINCT external_task_file_id FROM task")).map((r) => r.external_task_file_id));
  for (const s of srcStems) if (!dbStems.has(s)) rows.push(row("task", "missing-in-sqlite", s, "源 task 文件未入表（坏行拒入或导入缺口）"));
  for (const s of dbStems) if (!srcStems.includes(s)) rows.push(row("task", "missing-in-json", s, "表有源无"));
  const expectStatus: Record<string, string> = { t1: "backlog", t2: "claimed", t3: "submitted" }; // t3 completed 且被验收单命中→submitted（D1 review 联动）
  for (const [stem, want] of Object.entries(expectStatus)) {
    const got = port.query<{ status: string }>("SELECT status FROM task WHERE external_task_file_id = ?", [stem])[0]?.status;
    if (got !== want) rows.push(row("task", "value-mismatch", `${stem}:status`, `status 映射: want=${want} sqlite=${got ?? "无行"}`));
  }

  // ③ dispatch：readDispatchLog（json 收敛视图）vs dispatchEntriesFromDb（段链收敛投影）
  const jDisp = readDispatchLog(orgDir);
  const dbDisp = dispatchEntriesFromDb(port);
  const jIds = jDisp.map((d) => d.id);
  const dbIds = dbDisp.map((d) => d.id);
  for (const id of jIds) if (!dbIds.includes(id)) rows.push(row("dispatch", "missing-in-sqlite", id, "json 收敛视图有、投影无"));
  for (const id of dbIds) if (!jIds.includes(id)) rows.push(row("dispatch", "missing-in-json", id, "投影有、json 收敛视图无"));
  for (const j of jDisp) {
    const hit = dbDisp.find((d) => d.id === j.id);
    if (hit && (hit.status !== j.status || hit.ts !== j.ts)) rows.push(row("dispatch", "value-mismatch", j.id, `末态: json=${j.status}@${j.ts} sqlite=${hit.status}@${hit.ts}`));
  }
  // 段链收敛语义：disp-3 终态后重投——表侧两段（原段+重投段），投影收敛单条末行值
  const segs = port.query<{ id: string }>("SELECT id FROM dispatch WHERE id LIKE 'disp-3%' ORDER BY created_at").map((r) => r.id);
  if (!(segs.includes("disp-3") && segs.some((s) => /#r\d+$/.test(s)))) rows.push(row("dispatch", "value-mismatch", "disp-3:segments", `重投段链缺失: ${segs.join(",")}`));
  const firstSeg = port.query<{ created_at: number }>("SELECT created_at FROM dispatch WHERE id = 'disp-3'")[0];
  if (firstSeg && firstSeg.created_at !== T + 60) rows.push(row("dispatch", "value-mismatch", "disp-3:created_at", `首段 created_at=${firstSeg.created_at} want=${T + 60}`));

  // ④ notification：源 key 集（双源并）vs 表 condition_key 集 + 归并/client_state 覆盖
  const projRaw = (JSON.parse(readFileSync(join(dataDir, "notifications.json"), "utf-8")) as { notifications: { key: string }[] }).notifications.map((n) => n.key);
  const ledgerRaw = (JSON.parse(readFileSync(join(dataDir, "decision-notifications.json"), "utf-8")) as { key: string }[]).map((n) => n.key);
  const srcKeys = [...new Set([...projRaw, ...ledgerRaw])];
  const dbKeys = new Set(port.query<{ condition_key: string }>("SELECT condition_key FROM notification").map((r) => r.condition_key));
  for (const k of srcKeys) if (!dbKeys.has(k)) rows.push(row("notification", "missing-in-sqlite", k, "源条目未入表（坏行拒入或导入缺口）"));
  for (const k of dbKeys) if (!srcKeys.includes(k)) rows.push(row("notification", "missing-in-json", k, "表有源无"));
  const merged = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification WHERE condition_key = 'k-1'")[0]?.n ?? 0;
  if (merged !== 1) rows.push(row("notification", "value-mismatch", "k-1:merge", `跨源归并后行数=${merged} want=1`));
  const csCount = port.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notification_client_state s JOIN notification n ON s.notification_id = n.id WHERE n.condition_key = 'k-1'",
  )[0]?.n ?? 0;
  if (csCount !== 2) rows.push(row("notification", "value-mismatch", "k-1:client_state", `client_state 行数=${csCount} want=2`));
  const dismissed = port.query<{ dismissed_at: number | null }>(
    "SELECT s.dismissed_at FROM notification_client_state s JOIN notification n ON s.notification_id = n.id WHERE n.condition_key = 'k-1' AND s.client_id = 'desktop'",
  )[0]?.dismissed_at;
  if (dismissed !== T + 93) rows.push(row("notification", "value-mismatch", "k-1:desktop", `desktop dismissed_at=${dismissed} want=${T + 93}`));

  // ⑤ acceptance：stem∪doc.id 键集 vs 表 + sheet/item/result 抽样
  const srcSheetKeys = collectSourceKeys(accDir, (n) => !n.endsWith(".results.json"));
  const dbSheetIds = new Set(port.query<{ id: string }>("SELECT id FROM acceptance_sheet").map((r) => r.id));
  for (const k of srcSheetKeys) if (!dbSheetIds.has(k)) rows.push(row("acceptance", "missing-in-sqlite", k, "源 sheet 未入表（坏 JSON 拒入或导入缺口）"));
  for (const k of dbSheetIds) if (!srcSheetKeys.includes(k)) rows.push(row("acceptance", "missing-in-json", k, "表有源无"));
  const sheetA = port.query<{ title: string; created_at: number }>("SELECT title, created_at FROM acceptance_sheet WHERE id = ?", [hex("a")])[0];
  if (!sheetA || sheetA.title !== "验收单一" || sheetA.created_at !== T + 100) rows.push(row("acceptance", "value-mismatch", hex("a"), `title/created_at 抽样不等（${sheetA?.title ?? "无行"}）`));
  const itemsA = port.query<{ item_index: number; task: string }>("SELECT item_index, task FROM acceptance_item WHERE sheet_id = ? ORDER BY item_index", [hex("a")]);
  if (itemsA.length !== 2 || itemsA[0]?.task !== "t1" || itemsA[1]?.task !== "t2") rows.push(row("acceptance", "value-mismatch", `${hex("a")}:items`, `item 行数/序不等（${itemsA.length}）`));
  if (dbSheetIds.has(hex("b"))) rows.push(row("acceptance", "value-mismatch", hex("b"), "doc.id 优先单以 stem 身份入库（应=doc.id）"));
  const results = port.query<{ verdict: string; actor: string }>(
    "SELECT r.verdict, r.actor FROM acceptance_result r JOIN acceptance_item i ON r.item_id = i.id WHERE i.sheet_id = ?",
    [hex("c")],
  );
  if (results.length !== 1 || results[0]?.verdict !== "pass" || results[0]?.actor !== "user-x") rows.push(row("acceptance", "value-mismatch", `${hex("c")}:result`, `history 展开 result 抽样不等（${results.length} 行）`));

  // ⑥ artifact：deliverables.json 好行 path 集 vs 表 normalized_path（source_id 分组）+ 路径归一抽样
  const srcPaths = (JSON.parse(readFileSync(join(dataDir, "deliverables.json"), "utf-8")) as { sid?: string; path?: string }[])
    .filter((r) => typeof r.path === "string" && typeof r.sid === "string").map((r) => r.path as string);
  const dbArtifact = port.query<{ normalized_path: string; source_id: string }>("SELECT normalized_path, source_id FROM artifact WHERE source_id = 'deliverables'");
  const dbPaths = new Set(dbArtifact.map((r) => r.normalized_path));
  for (const p of srcPaths) if (!dbPaths.has(p)) rows.push(row("artifact", "missing-in-sqlite", p, "deliverables 源行未入表"));
  for (const p of dbPaths) if (!srcPaths.includes(p)) rows.push(row("artifact", "missing-in-json", p, "表有源无"));

  // loss 全账读出（域归属从 source_path 归域；category=reason；key=文件:行号）
  for (const l of port.query<{ source_path: string; line_no: number; reason: string }>("SELECT source_path, line_no, reason FROM import_loss")) {
    const base = basename(l.source_path);
    const domain = /\/tasks(\/|$)/.test(l.source_path) ? "task"
      : /\/acceptances(\/|$)/.test(l.source_path) ? "acceptance"
      : base === "projects.json" || base === "org.json" || base === "confirms.json" ? "group"
      : base === "dispatch-log.ndjson" ? "dispatch"
      : base === "notifications.json" || base === "decision-notifications.json" ? "notification"
      : base === "deliverables.json" ? "artifact" : "other";
    rows.push(row(domain, `loss:${l.reason}`, `${base}:${l.line_no}`, l.source_path));
  }
  return rows;
}

// 域差异断言 helper：某域某类别恰含期望键集（差异全集=已知坏行清单，不多了不少了）
function expectDiffKeys(rows: ParityRow[], domain: string, category: string, keys: string[]): boolean {
  const got = rows.filter((r) => r.domain === domain && r.category === category).map((r) => r.key).sort();
  const want = [...keys].sort();
  return got.length === want.length && want.every((k, i) => got[i] === k);
}

try {
  // ---------- 1. 灌库+六域逐域等价 ----------
  console.log("段1 六域对账:");
  const port = ensureStore(dirs);
  const rows = parityRows(port);
  assert(expectDiffKeys(rows, "group", "missing-in-sqlite", ["g-bad"]), "group 域：差异全集={g-bad}（status 词表外坏组拒入，g-1 逐组 tier/status/headcount 零差异）");
  assert(expectDiffKeys(rows, "task", "missing-in-sqlite", ["t6", "t8"]), "task 域：差异全集={t6,t8}（blocked 词表外+缺 subject 拒入），status 映射抽样 backlog/claimed/submitted 零差异");
  assert(!rows.some((r) => r.domain === "dispatch" && !r.category.startsWith("loss:")), "dispatch 域：id 集+逐 id 末态 status/ts 零差异（json 收敛视图=段链收敛投影，含 disp-3 重投场景；loss 轨=dangling-ref/missing-field 如实呈现）");
  assert(expectDiffKeys(rows, "notification", "missing-in-sqlite", ["k-bad"]), "notification 域：差异全集={k-bad}（缺 kind 拒入），k-1 跨源归并 1 行+client_state 2 行（desktop dismissed_at 抽样）零差异");
  assert(expectDiffKeys(rows, "acceptance", "missing-in-sqlite", [hex("d")]), "acceptance 域：差异全集={dddd…}（坏 JSON 拒入），sheet/item/result 抽样零差异");
  assert(!rows.some((r) => r.domain === "artifact" && !r.category.startsWith("loss:")), "artifact 域：deliverables 好行 path 集=表 normalized_path 零差异（缺 sid 行拒入落 loss 轨）");

  // ---------- 2. 段链/归并/身份语义金值 ----------
  console.log("段2 语义金值:");
  const segIds = port.query<{ id: string; attempt_no: number }>("SELECT id, attempt_no FROM dispatch WHERE id LIKE 'disp-3%' ORDER BY created_at");
  assert(segIds.length === 2 && segIds[0]?.id === "disp-3" && /#r\d+$/.test(segIds[1]?.id ?? "") && (segIds[1]?.attempt_no ?? 0) > (segIds[0]?.attempt_no ?? 0), `disp-3 重投段链两段（原段+重投段 ${segIds[1]?.id}），attempt_no 递进`);
  const db3 = dispatchEntriesFromDb(port).find((d) => d.id === "disp-3");
  assert(db3 !== undefined && db3.status === "running" && db3.ts === T + 71, "投影收敛语义：重投后同 id 单条=末段末行（running@T+71，与 json 侧一致）");
  assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification WHERE condition_key = 'k-1'")[0]?.n === 1, "k-1 proj+ledger 双源条目归并单行（E1 口径）");
  assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM acceptance_sheet WHERE id = ?", [hex("b")])[0]?.n === 0, "doc.id 优先：bbbb… stem 不以自身身份入库（表键=doc.id cccc…）");

  // ---------- 3. computeReady 板语义锁 + listLessons tags 双档同结果 ----------
  console.log("段3 板语义回归锁:");
  const board = JSON.parse(readFileSync(join(boardsDir, "g-1.json"), "utf-8")) as { entries: { id: string; text: string; ts: number; updated_at: number; title?: string; status: "todo" | "doing" | "done"; depends_on?: string[]; gate?: { reason: string; opened_at: number } }[] };
  const ready = computeReadySet({ entries: board.entries });
  const byId = new Map(ready.map((r) => [r.id, r.check]));
  assert(ready.length === 4 && !byId.has("e-done"), "computeReadySet 过滤 done 卡（entries 不入 SQLite，板读面仍 JSON 直读——M1 语义零回归锁）");
  assert(byId.get("e-a")?.ready === true && byId.get("e-b")?.ready === true, "ready 路径：无依赖卡+依赖全 done 卡均就绪");
  assert(byId.get("e-c")?.ready === false && byId.get("e-c")?.gate_reason === "等用户验收", "gate 未过路径：依赖全 done 仍不就绪，gate_reason 透传");
  assert(byId.get("e-d")?.ready === false && (byId.get("e-d")?.reasons ?? []).some((r) => r.includes("e-ghost")), "坏引用路径：依赖指向不存在卡按未就绪（reasons 单列）");
  resetReadModeForTest();
  delete process.env.CCR_STORAGE_READ_MODE;
  const jLessons = listLessons("g-1", { tags: ["p1"] }, orgDir);
  process.env.CCR_STORAGE_READ_MODE = "sqlite";
  resetReadModeForTest();
  const sLessons = listLessons("g-1", { tags: ["p1"] }, orgDir);
  assert(jLessons.length === 1 && jLessons[0].id === "l-1" && JSON.stringify(sLessons.map((l) => l.id)) === JSON.stringify(jLessons.map((l) => l.id)), "listLessons tags 谓词：json 档与 sqlite 投影侧同结果（boardsDir lessons 源经 D2 灌库）");
  process.env.CCR_STORAGE_READ_MODE = "shadow";
  resetReadModeForTest();
  const shLessons = listLessons("g-1", { tags: ["p1"] }, orgDir);
  assert(JSON.stringify(shLessons.map((l) => l.id)) === JSON.stringify(jLessons.map((l) => l.id)), "shadow 档 lessons 返回值仍 json 侧（零行为改变）");
  process.env.CCR_STORAGE_READ_MODE = "sqlite";
  resetReadModeForTest();
  listLessons("g-1", undefined, orgDir); // 回 sqlite 档（port 复用缓存）

  // ---------- 4. 报告稳定排序+两轮逐字节一致+坏行 loss 域覆盖 ----------
  console.log("段4 报告稳定性:");
  // 段3 切档调过 resetReadModeForTest（会 close 缓存连接）——重新 ensureStore 取活连接
  // （fixture 未变，导入器 checkpoint 快进幂等，近零开销）。
  const port4 = ensureStore(dirs);
  const r1 = sortRows(parityRows(port4));
  assert(r1.every((r, i) => i === 0 || `${r1[i - 1].domain} ${r1[i - 1].category} ${r1[i - 1].key}` <= `${r.domain} ${r.category} ${r.key}`), "报告排序键固定 domain→category→key（逐相邻对校验）");
  assert(["group", "task", "dispatch", "notification", "acceptance", "artifact"].every((d) => r1.some((r) => r.domain === d && r.category.startsWith("loss:"))), "坏行 loss 六域各有至少一例（差异与 loss 双轨落报告）");
  const r2 = sortRows(parityRows(port4));
  assert(JSON.stringify(r1.map(reportLine)) === JSON.stringify(r2.map(reportLine)), "同 fixture 两轮连跑报告逐字节一致（diff 空）");
  console.log("--- parity 报告（排定序，fixture 根路径归一便于跨进程 diff）---");
  for (const line of r1.map(reportLine)) console.log(`  ${line.replaceAll(root, "<fixture>")}`);

  // ---------- 5. 报告差异行内容精确（已知坏行清单全集，两轮稳定内容断言） ----------
  console.log("段5 差异内容精确:");
  assert(r1.find((r) => r.domain === "group" && r.category === "missing-in-sqlite" && r.key === "g-bad") !== undefined
    && r1.find((r) => r.domain === "task" && r.category === "missing-in-sqlite" && r.key === "t6") !== undefined, "坏行差异行内容可精确定位（域+类别+键三元组）");
  const zeroDiffDomains = ["dispatch", "artifact"].filter((d) => !r1.some((r) => r.domain === d && !r.category.startsWith("loss:")));
  assert(zeroDiffDomains.length === 2, "dispatch/artifact 对账零差异行（仅 loss 轨）——六域等价面收口");
} finally {
  resetReadModeForTest();
  delete process.env.CCR_STORAGE_READ_MODE;
  delete process.env.CCR_DATA_DIR;
  delete process.env.CCR_ORG_DIR;
  rmSync(root, { recursive: true, force: true });
}

console.log(`M1 import parity: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
