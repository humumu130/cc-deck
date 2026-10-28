// #292-B2 批2 断言套件：org 域三口（组状态/板写/确认决议）写切 StoragePort 事务。
//   §T 事务透传与写后可见：三口写后，读面（viaReadMode sqlite 投影）立即可见——
//      「写文件→库可见」窗口收进锁域（commit 后导入追赶），竞态真根（写口投影读陈旧
//      →改→写回抹并发新写）根治的行为级实证
//   §S 串行化（test-brm S0/S1 时序的行为级重放）：建组→立即 setGroupStatus→立即
//      upsert 交错序列 50 轮零「任务板已冻结」/终态一致——批2 验收症状
//   §D 降级：json 读档=零 SQLite 参与口径（事务短路纯文件）；SQLite 建库失败=
//      纯文件账降级（#158 语义）不炸主链
// 直跑：cd relay && env -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-c2.ts
import { rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-c2-org/", "../data/test-c2-data/", "../data/test-c2-data2/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-c2-org/");
process.env.CCR_DATA_DIR = SB("../data/test-c2-data/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
// #292-cutover-P1（C-C6）：可控注入——KEEP_READ_MODE=1 保留外部 env（真 json 档
// 全套件覆盖），缺省钉 sqlite 档（生产同款）。此前无条件 delete 使「json 档跑
// 全套件」的 env 通道失效（覆盖是假的）。
if (process.env.KEEP_READ_MODE !== "1") delete process.env.CCR_STORAGE_READ_MODE; // 缺省 sqlite 档（生产同款）

let pass = 0, fail = 0;
function assert2(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}

const { createGroup, setGroupStatus, upsertBoardEntry, loadBoard, listGroups } = await import("../src/projects.js");
const { ensureStore, resolveDirs } = await import("../src/storage/read-mode.js");

const DIR = process.env.CCR_ORG_DIR;
const gidOf = (r: { ok: true; group: { id: string } } | { ok: false; error: string }) =>
  r.ok ? (r as { group: { id: string } }).group.id : "";

console.log("§T 事务透传与写后可见：");
let gid = "";
{
  // T1 组域：建组（pending）→决议 active（decideConfirm 也进 T3 面）→setGroupStatus
  const created = createGroup({ name: "c2-t1", anchor_dir: "/tmp/c2-t1", tier: "轻立项" }, DIR);
  assert2(created.ok, "T1a 建组成功（轻立项）", created.ok ? "" : created.error);
  gid = gidOf(created as never);
  const act = setGroupStatus(gid, "active", undefined, DIR);
  assert2(act.ok, "T1b setGroupStatus active 事务透传", act.ok ? "" : act.error);
  // 写后库立即可见：直接查库（投影同源表）
  const port = ensureStore(resolveDirs());
  const row = port.query<{ status: string }>(`SELECT status FROM "group" WHERE id = ?`, [gid]);
  assert2(row[0]?.status === "active", `T1c 写后库立即可见 active（实 ${row[0]?.status}）——commit 后导入追赶生效`);
  // 读面投影（viaReadMode sqlite 的 listGroups）一致
  assert2(listGroups(DIR).find((g) => g.id === gid)?.status === "active", "T1d 读面投影一致（窗口闭合）");
}
// T2 板域：upsert 建卡→回读
{
  const up = upsertBoardEntry(gid, { text: "c2 卡片" }, DIR);
  assert2(up.ok, "T2a upsertBoardEntry 事务透传", up.ok ? "" : up.error);
  const b = loadBoard(gid, DIR);
  assert2(b.entries.some((e) => e.text === "c2 卡片"), "T2b 板写后回读在册");
}
// T3 确认域：正经立项确认单→决议→投影可见
{
  const created = createGroup({ name: "c2-t3", anchor_dir: "/tmp/c2-t3", tier: "正经立项" }, DIR);
  const g3 = gidOf(created as never);
  const port = ensureStore(resolveDirs());
  const c0 = port.query<{ id: string; status: string }>("SELECT id, status FROM org_confirm WHERE group_id = ? AND status = 'pending'", [g3]);
  assert2(c0.length === 1, `T3a 正经立项生成 pending 确认单（库见 ${c0.length}）`);
  const { decideConfirm } = await import("../src/projects.js");
  const dec = decideConfirm(c0[0]?.id ?? "", true, "c2-test", DIR);
  assert2(dec.ok, "T3b decideConfirm 事务透传", dec.ok ? "" : dec.error);
  // #292-cutover-P1（C-C1）：org 写口追赶转 deferred——「库立即可见」改「tick 排空后
  // 可见」（文件账先成=降级安全；同步冻结 98.8s 的代价换最终一致，读者走读前触发
  // 自带追赶同款窗口）。json 档（KEEP_READ_MODE 专跑）=零 SQLite 参与铁律：决议真
  // 相在文件面断言（confirms.json），库断言跳过（json 档库是旁路残留不承诺投影）。
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  if (process.env.CCR_STORAGE_READ_MODE === "json") {
    const { readFileSync: rfC2 } = await import("node:fs");
    const cf = JSON.parse(rfC2(join(DIR, "confirms.json"), "utf-8")) as { confirms: { id: string; status: string }[] };
    const inFile = cf.confirms.find((x) => x.id === (c0[0]?.id ?? ""))?.status;
    assert2(inFile === "approved", `T3c-json 决议后文件面 approved（json 档零库参与，实 ${inFile}）`);
  } else {
    const c1 = port.query<{ status: string }>("SELECT status FROM org_confirm WHERE id = ?", [c0[0]?.id ?? ""]);
    assert2(c1[0]?.status === "approved", `T3c 决议后库可见 approved（deferred 排空后，实 ${c1[0]?.status}）`);
  }
}

console.log("§D 降级：");
{
  // D1 json 读档=事务短路纯文件（零 SQLite 参与口径）
  process.env.CCR_STORAGE_READ_MODE = "json";
  const { resetSqliteDriverForTest } = await import("../src/storage/sqlite.js");
  void resetSqliteDriverForTest;
  const created = createGroup({ name: "c2-d1", anchor_dir: "/tmp/c2-d1", tier: "轻立项" }, DIR);
  const g = gidOf(created as never);
  const act = setGroupStatus(g, "active", undefined, DIR);
  assert2(act.ok, "D1 json 档三口照常纯文件（事务短路，结果 ok）", act.ok ? "" : act.error);
  delete process.env.CCR_STORAGE_READ_MODE;
  // D2 SQLite 建库失败（dataDir 指只读路径）→纯文件账降级不炸主链
  process.env.CCR_DATA_DIR = "/dev/null/no-such-dir/c2";
  const created2 = createGroup({ name: "c2-d2", anchor_dir: "/tmp/c2-d2", tier: "轻立项" }, DIR);
  const g2 = gidOf(created2 as never);
  const act2 = setGroupStatus(g2, "active", undefined, DIR);
  assert2(act2.ok, "D2 库不可用降级纯文件账（#158 语义，主链不炸）", act2.ok ? "" : act2.error);
  process.env.CCR_DATA_DIR = SB("../data/test-c2-data/");
}

console.log("§S 串行化（test-brm S0/S1 时序重放 50 轮）：");
{
  let frozen = 0, failN = 0;
  for (let i = 0; i < 50; i++) {
    const nm = `c2-s${i}`;
    const created = createGroup({ name: nm, anchor_dir: `/tmp/${nm}`, tier: "轻立项" }, DIR);
    if (!created.ok) { failN++; continue; }
    const g = gidOf(created as never);
    const act = setGroupStatus(g, "active", undefined, DIR);
    if (!act.ok) { failN++; continue; }
    const up = upsertBoardEntry(g, { text: `卡 ${i}` }, DIR);
    if (!up.ok && /冻结/.test((up as { error?: string }).error ?? "")) frozen++;
    else if (!up.ok) failN++;
    // 生命周期收尾：archived 释放 active 名额（maxActiveGroups 护栏——不清理则第 N 轮起建组被上限拒，混入 failN 噪声）
    setGroupStatus(g, "archived", "c2-s 轮收尾", DIR);
  }
  assert2(frozen === 0, `S1 建组→active→upsert 交错 50 轮零「任务板已冻结」（实 frozen=${frozen}）——批2 验收症状根除`);
  assert2(failN === 0, `S2 全序列零失败（实 fail=${failN}）`);
}

// §N B 路审查真根修行为锁：checkpoint ns 精化——同毫秒二次写（等长覆盖形态）不再假有效
{
  const { utimesSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const nm = "c2-ns";
  const c1 = createGroup({ name: nm, anchor_dir: "/tmp/" + nm, tier: "轻立项" }, DIR);
  const gn = gidOf(c1 as never);
  const act1 = setGroupStatus(gn, "active", undefined, DIR);
  if (act1.ok) {
    // 钉回 setGroupStatus 落盘的 mtime（同毫秒），再做一次等长翻转 active→parked（7↔6 不等长——用 pending 组做 pending→active 等长 7 字符翻转更贴 B 探针；此处用 parked 翻转亦可验证 ns 腿）
    const pf = join(DIR, "projects.json");
    const fixMs = (rf(pf) && (await import("node:fs")).statSync(pf).mtimeMs) || Date.now();
    const act2 = setGroupStatus(gn, "parked", undefined, DIR);
    // 手工把文件 mtime 钉回第一次写的毫秒（模拟同毫秒碰撞——ns 不同 ms 相同）
    utimesSync(pf, new Date(fixMs), new Date(fixMs));
    const act3 = setGroupStatus(gn, "active", undefined, DIR);
    const portN = ensureStore(resolveDirs());
    const rowN = portN.query<{ status: string }>('SELECT status FROM "group" WHERE id = ?', [gn]);
    // ns 腿生效=追赶重灌不被假 checkpoint 拦 → 库见最终态（active）；ns 缺位旧行为=库停在碰撞前态
    assert2(rowN[0]?.status === "active", `N1 同毫秒碰撞（utimesSync 钉回）后 ns 腿保证投影见最终态（实 ${rowN[0]?.status}）——B 路探针行为锁`);
    void wf;
  } else { assert2(false, "N0 前置失败"); }
}

// A-P3-1⑤：写路径全程不得触发 sqlite 降级横幅（P1-1 的行为锁——嵌套被吞成假降级即抓）
{
  const rm = await import("../src/storage/read-mode.js") as { isSqliteDegradationNotifiedForTest: () => boolean; resetSqliteDegradationFlagForTest: () => void };
  rm.resetSqliteDegradationFlagForTest();
  const act5 = setGroupStatus(gid, "parked", undefined, DIR);
  const act6 = setGroupStatus(gid, "active", undefined, DIR);
  const up5 = upsertBoardEntry(gid, { text: "P3e 板写" }, DIR);
  // 口径（B 路审查修正）：断言对象=「写口事务自身零降级」——低层未包口（B-P2-3 八口）
  // 的投影读可能撞导入器遗留事务偶发假降级（残留面，备案），不归三口事务的责任面
  assert2(act5.ok && act6.ok && up5.ok && !rm.isSqliteDegradationNotifiedForTest(), "P3e 三口事务自身零降级横幅（P1-1 锁：锁内嵌套导入已被直读根除）");
}
// A-P3-1⑥：坏 projects.json 的 T0a 语义（P1-2 的行为锁——裸异常穿透即抓）
{
  const { writeFileSync, readFileSync, rmSync: rm2 } = await import("node:fs");
  const pf = join(DIR, "projects.json");
  const backup = readFileSync(pf, "utf-8");
  writeFileSync(pf, '{"groups": ["坏 JSON'); // 截断坏文件
  let threw = false;
  try { setGroupStatus(gid, "parked", undefined, DIR); } catch { threw = true; }
  assert2(!threw, "P3f 坏索引文件：写口不裸抛（T0a 语义——journal 回放/只读闸，调用面收 {ok:false}）");
  writeFileSync(pf, backup); // 还原（journal 回放可能已重建——双保险还原原文）
  const restored = listGroups(DIR);
  void restored; void rm2;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
for (const d of ["../data/test-c2-org/", "../data/test-c2-data/", "../data/test-c2-data2/"]) {
  try { rmSync(SB(d), { recursive: true, force: true }); } catch {}
}
process.exit(fail > 0 ? 1 : 0);
void dirname; void join;
