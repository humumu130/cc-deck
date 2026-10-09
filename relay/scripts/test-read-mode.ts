// ---------- 读模式三档开关与影子比对测试（M11-G1） ----------
// 六段：0 解析器 fail-fast / 1 json 档金值+零 SQLite 参与 / 2 sqlite 档表投影金值+旧 JSON 零写
// / 3 shadow 档返回值=JSON 侧+人为差异落账 / 4 七域对账器 / 5 无效值 boot 抛错。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-read-mode.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { resetReadModeForTest, resolveReadMode, currentReadMode, compareDomain, runShadowCompare, readShadowDiff } from "../src/storage/read-mode.js";
import { statThenRead } from "../src/storage/import-util.js";
import { listGroups, findGroup, isLightConfirmTrusted, listConfirms, listLessons } from "../src/projects.js";
import { readDispatchLog } from "../src/org.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}
const snap = new Map<string, { mtime: number; body: string }>();
function snapshotStores(org: string): void {
  snap.clear();
  const files = ["projects.json", "confirms.json", join("boards", "g-1.json"), "dispatch-log.ndjson"];
  for (const f of files) {
    const p = join(org, f);
    if (existsSync(p)) snap.set(f, { mtime: statSync(p).mtimeMs, body: readFileSync(p, "utf-8") });
  }
}
function assertStoresUntouched(org: string, label: string): void {
  let untouched: boolean = true;
  for (const [f, before] of snap) {
    const p = join(org, f);
    if (!existsSync(p)) { untouched = false; continue; }
    const st = statSync(p);
    if (st.mtimeMs !== before.mtime || readFileSync(p, "utf-8") !== before.body) untouched = false;
  }
  assert(untouched, `${label}：旧 JSON store 全家 mtime+内容零变化（铁律 2）`);
}

// ---------- 造态（orgDir: 四 store 文件；dataDir: 零源——未造域=空态对账） ----------
const root = mkdtempSync(join(tmpdir(), "cc-read-mode-"));
const dataDir = join(root, "data");
const orgDir = join(root, "org");
// 读模式层 env 兜底链消费 CCR_DATA_DIR（resolveDirs 缺省 cwd/data）——测试显式指到 fixture，
// 防止库文件落进 relay/data（cwd 兜底路径）。
process.env.CCR_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(orgDir, "boards"), { recursive: true });
const T = 1760000000000;
const g1 = { id: "g-1", name: "serious", anchor_dir: "/fx/serious", status: "active", tier: "正经立项", headcount: [{ session_id: "s-w1", role: "coder" }], role_defaults: { coder: { model: "sonnet" } }, single_card: false, created_at: T + 1, updated_at: T + 2 };
const g2 = { id: "g-2", name: "light", anchor_dir: "/fx/light", status: "parked", tier: "轻立项", headcount: [], single_card: true, created_at: T + 3, updated_at: T + 4, parked_at: T + 5, archive_note: "暂缓备注" };
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({ trust_light: true, groups: [g1, g2] }, null, 2) + "\n");
// 源写形顺序：pending 段在前+decided 段在后（writeConfirms 落形）——投影顺序对齐面
const c1 = { id: "c-1", kind: "project-create", title: "立项 t", reason: "r1", payload: { gid: "g-1" }, status: "pending", created_at: T + 10 };
const c3 = { id: "c-3", kind: "archive", title: "结项", reason: "r3", payload: { gid: "g-2" }, status: "pending", created_at: T + 30 };
const c2 = { id: "c-2", kind: "tier-change", title: "升级", reason: "r2", payload: { gid: "g-1", to_tier: "正经立项" }, status: "approved", created_at: T + 20, decided_at: T + 25, decided_by: "user-x" };
writeFileSync(join(orgDir, "confirms.json"), JSON.stringify({ confirms: [c1, c3, c2] }, null, 2) + "\n");
writeFileSync(join(orgDir, "boards", "g-1.json"), JSON.stringify({ gid: "g-1", entries: [], lessons: [
  { id: "l-1", text: "经验一", tags: ["react", "p1"], ts: T + 40 },
  { id: "l-2", text: "经验二", tags: ["p2"], ts: T + 41, source_dispatch_id: "disp-1" },
], frozen: false, updated_at: T + 42 }, null, 2) + "\n");
// dispatch-log.ndjson：同 id 状态机三行（收敛 done+末行 ts）+独立一行
const dLines = [
  { ts: T + 50, id: "disp-1", tier: "正经立项", target: "s-w1", status: "dispatched", session_id: "s-leader", actor: "user" },
  { ts: T + 51, id: "disp-1", tier: "正经立项", target: "s-w1", status: "running", session_id: "s-leader" },
  { ts: T + 52, id: "disp-1", tier: "正经立项", target: "s-w1", status: "done", receipt: "收口ok", session_id: "s-leader", actor: "user" },
  { ts: T + 53, id: "disp-2", tier: "咨询", target: "s-leader", status: "dispatched", session_id: "s-leader" },
];
writeFileSync(join(orgDir, "dispatch-log.ndjson"), dLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const dbFile = join(dataDir, "cc-deck.sqlite3");
const setMode = (m: string | undefined): void => {
  if (m === undefined) delete process.env.CCR_STORAGE_READ_MODE;
  else process.env.CCR_STORAGE_READ_MODE = m;
};

try {
  // ---------- 0. 解析器：缺省/词表/无效值 fail-fast ----------
  console.log("段0 解析器:");
  // 缺省=sqlite（2026-10-06 SQLITE-FLIP 翻转，用户拍板「开干吧」；CUT-1 六闸全绿+读税双清前置）
  assert(resolveReadMode(undefined) === "sqlite" && resolveReadMode("") === "sqlite" && resolveReadMode("  ") === "sqlite", "缺省/空/空白= sqlite（2026-10-06 翻转，用户拍板）");
  assert(resolveReadMode("json") === "json", "显式 json 仍解析 json（回滚=env 钉 json，回退通道健在锁）");
  assert(resolveReadMode(" sqlite ") === "sqlite" && resolveReadMode("shadow") === "shadow", "词表三值 trim 后识别");
  let threw = false;
  try { resolveReadMode("jsno"); } catch { threw = true; }
  assert(threw, "无效值 throw（fail-fast，不静默回退）");

  // ---------- 1. json 档（显式钉 env）：金值+零 SQLite 参与 ----------
  console.log("段1 json 档:");
  setMode("json");
  assert(currentReadMode() === "json", "显式 json 档 currentReadMode= json（回滚档语义原样）");
  const jGroups = listGroups(orgDir);
  assert(jGroups.length === 2 && jGroups[0].id === "g-1" && jGroups[1].parked_at === T + 5 && jGroups[1].archive_note === "暂缓备注", "json 档组列表金值（含可选字段 parked_at/archive_note 原样）");
  assert(isLightConfirmTrusted(orgDir) === true, "json 档 trust_light=true（原样）");
  const jConfirms = listConfirms(orgDir);
  assert(jConfirms.length === 3 && jConfirms[0].id === "c-1" && jConfirms[2].id === "c-2" && jConfirms[2].decided_by === "user-x", "json 档确认单金值（源序）");
  const jLessons = listLessons("g-1", undefined, orgDir);
  assert(jLessons.length === 2 && jLessons[0].tags.includes("react"), "json 档经验金值");
  assert(listLessons("g-1", { tags: ["p2"] }, orgDir).length === 1, "json 档 tags 过滤（AND 语义）");
  const jDispatch = readDispatchLog(orgDir);
  assert(jDispatch.length === 2 && jDispatch[0].id === "disp-1" && jDispatch[0].status === "done" && jDispatch[0].receipt === "收口ok" && jDispatch[0].ts === T + 52, "json 档派单金值（同 id 收敛末行）");
  assert(readDispatchLog(orgDir, 1).length === 1 && readDispatchLog(orgDir, 1)[0].id === "disp-2", "json 档 max 截断（尾条）");
  assert(!existsSync(dbFile), "json 档 SQLite 零参与：库文件未创建");
  snapshotStores(orgDir);

  // ---------- 2. sqlite 档：表投影金值+旧 JSON 零写 ----------
  console.log("段2 sqlite 档:");
  setMode("sqlite");
  const sGroups = listGroups(orgDir);
  assert(sGroups.length === 2 && sGroups[0].id === "g-1" && sGroups[0].tier === "正经立项" && sGroups[0].status === "active", "sqlite 档组列表=表投影（导入后同值）");
  assert(JSON.stringify(sGroups[0].headcount) === JSON.stringify(g1.headcount) && (sGroups[0].role_defaults as Record<string, unknown> | undefined)?.coder !== undefined, "sqlite 档 headcount/role_defaults 从 JSON 列直还");
  assert(sGroups[0].parked_at === undefined && sGroups[1].parked_at === undefined, "sqlite 档 parked_at 无表列→undefined（投影缺省，备案面）");
  assert(isLightConfirmTrusted(orgDir) === false, "sqlite 档 trust_light 投影缺省 false（已知限制面证据）");
  assert(findGroup("serious", orgDir)?.id === "g-1", "sqlite 档 findGroup 经投影可查");
  const sConfirms = listConfirms(orgDir);
  assert(sConfirms.length === 3 && sConfirms[0].id === "c-1" && sConfirms[1].id === "c-3" && sConfirms[2].id === "c-2", "sqlite 档确认单=投影序（pending 段前+decided 段后）");
  assert(sConfirms[2].decided_at === T + 25 && sConfirms[2].payload.gid === "g-1", "sqlite 档 decided_at/payload 还原");
  const sLessons = listLessons("g-1", undefined, orgDir);
  assert(sLessons.length === 2 && sLessons[1].source_dispatch_id === "disp-1", "sqlite 档经验=lesson 表投影");
  assert(listLessons("g-1", { tags: ["p2"] }, orgDir).length === 1, "sqlite 档 tags 过滤同谓词");
  const sDispatch = readDispatchLog(orgDir);
  assert(sDispatch.length === 2 && sDispatch[0].id === "disp-1" && sDispatch[0].status === "done" && sDispatch[0].receipt === "收口ok" && sDispatch[0].ts === T + 52, "sqlite 档派单=段链收敛投影（状态机末态+末行 ts）");
  // 有损映射面金值：target/session_id 经 member/session 归因链——session 表空→NULL→投影 ""
  assert(sDispatch[0].target === "" && sDispatch[0].session_id === "", "sqlite 档 target/session_id 悬空归因→空串（值域映射备案面金值）");
  assert(readDispatchLog(orgDir, 1).length === 1 && readDispatchLog(orgDir, 1)[0].id === "disp-2", "sqlite 档 max 截断");
  assert(existsSync(dbFile), "sqlite 档读前触发灌库：库文件已建（铁律 3 lazy ensure）");
  assertStoresUntouched(orgDir, "sqlite 档");

  // ---------- 3. shadow 档：返回值=JSON 侧+人为差异落账 ----------
  console.log("段3 shadow 档:");
  setMode("shadow");
  const shGroups = listGroups(orgDir);
  assert(JSON.stringify(shGroups) === JSON.stringify(jGroups), "shadow 档组列表与 json 档逐字节一致（铁律 1 返回值以 JSON 为准）");
  const shConfirms = listConfirms(orgDir);
  assert(JSON.stringify(shConfirms) === JSON.stringify(jConfirms), "shadow 档确认单与 json 档逐字节一致");
  const shDispatch = readDispatchLog(orgDir);
  assert(JSON.stringify(shDispatch) === JSON.stringify(jDispatch), "shadow 档派单与 json 档逐字节一致");
  resetReadModeForTest(); // 清缓存后直改库一行，制造人为差异
  const raw = createSqlitePort({ dataDir });
  raw.open();
  raw.exec(`UPDATE "group" SET tier = '轻立项' WHERE id = 'g-1'`);
  raw.close();
  const sh2 = listGroups(orgDir);
  assert(JSON.stringify(sh2) === JSON.stringify(jGroups), "人为改库后 shadow 档返回值仍 JSON 侧（零行为改变）");
  const diffs = readShadowDiff(dataDir);
  const hit = diffs.find((r) => r.domain === "group" && r.key === "g-1" && r.category === "value-mismatch");
  assert(hit !== undefined && JSON.stringify(hit.json_value) === JSON.stringify({ tier: "正经立项", status: "active" }) && JSON.stringify(hit.sqlite_value) === JSON.stringify({ tier: "轻立项", status: "active" }), "人为差异落账：group/g-1 value-mismatch 双侧值（tier 改库被抓）");
  assert(diffs.some((r) => r.domain === "group" && r.key === "*" && r.category === "value-mismatch" && r.json_value === "truncated") === false, "差异行未触限额截断");
  assertStoresUntouched(orgDir, "shadow 档");

  // ---------- 4. 七域对账器：键集/数量/抽样三级 ----------
  console.log("段4 七域对账:");
  resetReadModeForTest();
  setMode("sqlite");
  // 还原段 3 人为差异（tier 改回）——对账面要求源与库对齐态
  const restore = createSqlitePort({ dataDir });
  restore.open();
  restore.exec(`UPDATE "group" SET tier = '正经立项' WHERE id = 'g-1'`);
  restore.close();
  listGroups(orgDir); // 触发 ensureStore+灌库
  const port = createSqlitePort({ dataDir });
  port.open();
  const dirs = { dataDir, orgDir, tasksDir: join(dataDir, "tasks") };
  const dGroupClean = compareDomain("group", port, dirs);
  assert(dGroupClean.length === 0, "group 域对账零差异（导入器与源对齐）");
  const dLesson = compareDomain("lesson", port, dirs);
  assert(dLesson.length === 0, "lesson 域对账零差异（键集+tags 抽样）");
  const dDispatch = compareDomain("dispatch", port, dirs);
  assert(dDispatch.length === 0, "dispatch 域对账零差异（行 id 对账，段尾剥离口径）");
  const dConfirm = compareDomain("confirm", port, dirs);
  assert(dConfirm.length === 0, "confirm 接线域对账零差异");
  port.exec(`DELETE FROM lesson WHERE id = 'l-1'`);
  const dBroken = compareDomain("lesson", port, dirs);
  assert(dBroken.some((r) => r.category === "missing-in-sqlite" && r.key === "l-1") && dBroken.some((r) => r.category === "count-mismatch"), "人为删行→missing-in-sqlite+count-mismatch 落账");
  const all = runShadowCompare(port, dirs);
  assert(Array.isArray(all) && existsSync(join(dataDir, "shadow-diff.ndjson")), "全域聚合对账落 shadow-diff.ndjson");
  assert(all.every((r) => r.domain !== "group" || r.category !== "value-mismatch" || r.key !== "g-1"), "runShadowCompare 对齐库零 group 值差异（对账面独立于段3人为差异）");
  port.close();

  // ---------- 4b. 长驻场景：portCache 命中分支也快进（READMODE-FIX；P81-6FIX B1 备案裁定修） ----------
  console.log("段4b 长驻增量可见:");
  setMode("sqlite");
  // 模拟长驻进程：不 resetReadModeForTest（端口缓存保持命中态），写侧直接追加 JSON 账——
  // dispatch-log 追加新单一行+板文件追加一条 lesson（org.ts append-only 写者语义）。
  // 修复前此处 ensureStore 命中 portCache 直接 return，读面永远停留首建快照（P81-6FIX O10 四红根因）。
  const dNew = [
    ...dLines,
    { ts: T + 60, id: "disp-3", tier: "正经立项", target: "s-w1", status: "dispatched", session_id: "s-leader", actor: "user" },
  ];
  writeFileSync(join(orgDir, "dispatch-log.ndjson"), dNew.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const boardDoc = JSON.parse(readFileSync(join(orgDir, "boards", "g-1.json"), "utf-8")) as { lessons: unknown[] };
  boardDoc.lessons.push({ id: "l-3", text: "追加经验", tags: ["live"], ts: T + 61 });
  writeFileSync(join(orgDir, "boards", "g-1.json"), JSON.stringify(boardDoc, null, 2) + "\n");
  // 同进程二次读（ensureStore 缓存命中→同样跑导入聚合，checkpoint 失效重灌）：新账必须可见
  const liveDispatch = readDispatchLog(orgDir);
  assert(liveDispatch.length === 3 && liveDispatch.some((e) => e.id === "disp-3" && e.status === "dispatched"),
    "长驻二次读见新派单（portCache 命中分支也快进——READMODE-FIX 语义锁）");
  const liveLessons = listLessons("g-1", undefined, orgDir);
  assert(liveLessons.length === 3 && liveLessons.some((l) => l.id === "l-3"),
    "长驻二次读见新经验（boards 追加增量可见，dispatch 失效⇒lesson 联动重灌）");
  // 注：铁律 2 零写检查在此段不适用——两源 mtime/body 变化是本段模拟写者的合法写入。

  // ---------- 4c. statThenRead 短路 memo：行为等价+失效对抗+计时塌缩（STAT-SHORTCUT） ----------
  console.log("段4c stat 短路 memo:");
  setMode("sqlite");
  // 独立探针文件（不进导入域）直测 statThenRead memo 面：命中/失效/计时
  const memoProbe = join(orgDir, "memo-probe.ndjson");
  writeFileSync(memoProbe, Array.from({ length: 8000 }, (_, i) => `{"i":${i},"pad":"${"y".repeat(120)}"}`).join("\n") + "\n");
  const m1 = statThenRead(memoProbe);
  const m2 = statThenRead(memoProbe);
  assert(m1.text === m2.text && m1.mtimeMs === m2.mtimeMs,
    "memo 命中：重复 observe 返回值逐字节一致（text+mtimeMs 等价锁）");
  const tHot = performance.now();
  for (let i = 0; i < 50; i++) statThenRead(memoProbe);
  const hotMs = (performance.now() - tHot) / 50;
  assert(hotMs < 0.1,
    `memo 命中计时塌缩 ${hotMs.toFixed(4)} ms/次（<0.1 阈值——全文读已跳过的计数锁替身：readFileSync 无 seam，1.4ms 全读 vs 0.0xms 命中有两个数量级分差）`);
  // 对抗锁：等长覆盖写（内容变 size 相同，writeFileSync 紧跟 observe——同毫秒内写 mtimeMs 不推，
  // 实锤 ms 粒度误命中，见 memo ns 腿头注）——ns 腿独立失效，size 相同不误短路
  const before = readFileSync(memoProbe, "utf-8");
  writeFileSync(memoProbe, before.replace('"i":1,', '"i":9,')); // 1→9 等长替换（值后逗号结尾才匹配，size 不变）
  const m3 = statThenRead(memoProbe);
  assert(m3.text !== m2.text && m3.text.includes('"i":9'),
    "等长覆盖写（size 同 mtime 推）→memo 失效见新内容（对抗锁：size 相同不误短路，ns 腿独立工作）");
  // memo 未毒化后续：再命中态恢复（mtime/size 稳定后重复 observe 一致）
  const m4 = statThenRead(memoProbe);
  assert(m4.text === m3.text, "失效重读后 memo 刷新：再次 observe 与新内容一致");

  // ---------- 5. 无效值 boot 抛错（读入口面） ----------
  console.log("段5 无效值读入口 fail-fast:");
  setMode("jsno");
  let bootThrew = false;
  try { listGroups(orgDir); } catch { bootThrew = true; }
  assert(bootThrew, "无效模式值经读入口即抛（boot fail-fast 语义）");
  setMode(undefined);

  // 二轮：org 写者活跃场景（推 projects.json mtime）→重扫联动重灌→差异文件重写为最新轮；随后新差异落账
  setMode("shadow");
  utimesSync(join(orgDir, "projects.json"), new Date(Date.now() + 15), new Date(Date.now() + 15));
  resetReadModeForTest();
  listGroups(orgDir); // 触发 org 重扫预判命中→下游联动作废→org+下游重灌（写者活跃主路径）
  const afterRescan = readShadowDiff(dataDir);
  assert(!afterRescan.some((r) => JSON.stringify(r.json_value ?? r.sqlite_value ?? "").includes("轻立项")), "重灌轮：段3人为差异（tier=轻立项改库）已随重灌消失——shadow-diff 整文件重写为最新一轮的直接证据（已知有损面差异 trust_light/parked_at 照常在报）");
  const flip2 = createSqlitePort({ dataDir });
  flip2.open();
  flip2.exec(`UPDATE "group" SET status = 'archived' WHERE id = 'g-1'`);
  flip2.close();
  resetReadModeForTest();
  listGroups(orgDir); // 新一轮 shadow：投影带 archived→差异落账
  const round2 = readShadowDiff(dataDir);
  setMode("json");
  resetReadModeForTest();
  listGroups(orgDir); // 回 json 档收尾（零副作用；SQLITE-FLIP 后收尾档显式钉 json，不依赖缺省）
  assert(round2.some((r) => r.domain === "group" && r.key === "g-1" && r.category === "value-mismatch" && JSON.stringify(r.sqlite_value) === JSON.stringify({ tier: "正经立项", status: "archived" })), "shadow 二轮新差异落账（g-1 status 改库被抓，双侧值精确）");
} finally {
  resetReadModeForTest();
  delete process.env.CCR_STORAGE_READ_MODE;
  delete process.env.CCR_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
}

console.log(`Read mode: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
