// bootfast3（t-e23febf2，test.98 实产反例）：org 源写面 checkpoint 推进契约锁。
//   病灶（沙盒复现实证：暖启动 2.3s vs org 源 mtime 变后 65.4s——listen 前仅 559ms，
//   65s 全在 listen 后事件循环内被同步 sqlite 全量重灌霸占）：org.json/projects.json/
//   confirms.json 写面写文件但不推进 import_checkpoint → orgRescanPending 严格匹配失配
//   → 联动十表全清+删全部非 org checkpoint → 七域全量重灌（生产 30MB events 连坐）。
//   修=三写面单点（org.ts writeOrgAnchor / projects.ts writeProjectsFile / writeConfirms）
//   成功后调 advanceOrgSourceCheckpoint（观测口径与 import-org observe 逐字同款）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  console.log("A. 源码锚：三写面单点接线在场（漏一个=修一半）");
  {
    const { readFileSync: rd } = await import("node:fs");
    const org = rd(new URL("../src/org.ts", import.meta.url), "utf8");
    const projects = rd(new URL("../src/projects.ts", import.meta.url), "utf8");
    const rm = rd(new URL("../src/storage/read-mode.ts", import.meta.url), "utf8");
    assert(org.includes("advanceOrgSourceCheckpoint(orgFilePath("), "writeOrgAnchor 写面推进接线（org.ts）");
    assert(projects.includes("advanceOrgSourceCheckpoint(projectsFilePath("), "writeProjectsFile 写面推进接线（projects.ts）");
    assert(projects.includes("advanceOrgSourceCheckpoint(confirmsFilePath("), "writeConfirms 写面推进接线（projects.ts——确认卡=运行期最高频 org 源写者）");
    assert(rm.includes("export function advanceOrgSourceCheckpoint"), "推进口导出在位（read-mode）");
    // 观测闸锚（定位盲区根修——此前 orgRescanPending 联动+导入耗时全静默）
    assert(rm.includes("org 源 checkpoint 失配→联动十表全清+全域重灌"), "联动触发观测行在位（bootfast3 观测——修后出现即追查写入来源）");
    assert(rm.includes("importAllForShadow 完成"), "导入耗时观测闸在位（>50ms 出行）");
  }

  console.log("B. 行为：写面推进后 orgRescanPending 不触发（联动全清根除）");
  {
    const { ensureStoreQuiet, resolveDirs, importAllForShadow } = await import("../src/storage/read-mode.js");
    const { advanceOrgSourceCheckpoint } = await import("../src/storage/read-mode.js");
    const { createSqlitePort } = await import("../src/storage/sqlite.js");
    const { runMigrations } = await import("../src/storage/migrator.js");
    const { migrations } = await import("../src/storage/schema.js");
    const { readCheckpoint } = await import("../src/storage/checkpoint.js");
    const { writeOrgAnchor } = await import("../src/org.js");
    const { statThenRead } = await import("../src/storage/import-util.js");
    const root = mkdtempSync(join(tmpdir(), "bootfast3-"));
    const orgDir = join(root, "org");
    const dataDir = join(root, "data");
    // advanceOrgSourceCheckpoint 内部 resolveDirs 从 env 取 dataDir（写面只有 orgDir 上下文）
    // ——套件必须显式钉 env 指沙盒（防外层隔离变量渗入）
    process.env.CCR_DATA_DIR = dataDir;
    process.env.CCR_ORG_DIR = orgDir;
    mkdirSync(orgDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(join(orgDir, "projects.json"), JSON.stringify({ groups: [], trust_light: false }, null, 2) + "\n", "utf8");
      writeFileSync(join(orgDir, "confirms.json"), JSON.stringify({ confirms: [] }, null, 2) + "\n", "utf8");
      const dirs = resolveDirs({ dataDir, orgDir });
      const port = createSqlitePort({ dataDir });
      port.open();
      runMigrations(port, migrations);
      // 首轮导入：org 域落 checkpoint（org.json 首次由 writeOrgAnchor 建面+推进）
      writeOrgAnchor({ leader: "s-bootfast3", created_at: Date.now(), collab: "leader" } as never, orgDir);
      importAllForShadow(port, dirs);
      const sessionRowsBefore = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -1;
      assert(sessionRowsBefore >= 0, `首轮导入落定（session=${sessionRowsBefore}——org 写面建锚同步推进）`);

      // B1 对照组（修前形态）：外部直改 org.json（不走写面）→ checkpoint 失配 → orgRescanPending 触发语义保持
      const orgFile = join(orgDir, "org.json");
      const raw = JSON.parse(readFileSync(orgFile, "utf8"));
      writeFileSync(orgFile, JSON.stringify({ ...raw, note: "external-write" }, null, 2) + "\n", "utf8");
      const obsNow = statThenRead(orgFile);
      const linesNow = obsNow.text.split("\n");
      if (linesNow.length > 0 && linesNow[linesNow.length - 1] === "") linesNow.pop();
      const cpStale = readCheckpoint(port, orgFile, { mtimeMs: obsNow.mtimeMs, mtimeNs: obsNow.mtimeNs, lineCount: linesNow.length, schemaVersion: 1 });
      assert(cpStale === null, "对照组：外部写（不走写面）checkpoint 仍失配（联动语义保持——外部改源=真变更该重灌）");

      // B2 修后主路径：真实写面（writeOrgAnchor）→ 推进 → checkpoint 命中（orgRescanPending 不触发）
      writeOrgAnchor({ ...raw, note: "write-face" } as never, orgDir);
      const obs2 = statThenRead(orgFile);
      const lines2 = obs2.text.split("\n");
      if (lines2.length > 0 && lines2[lines2.length - 1] === "") lines2.pop();
      const cp2 = readCheckpoint(port, orgFile, { mtimeMs: obs2.mtimeMs, mtimeNs: obs2.mtimeNs, lineCount: lines2.length, schemaVersion: 1 });
      assert(cp2 !== null, "**主断言：写面写后 checkpoint 即时命中**（mtimeMs/mtimeNs/lineCount 五元组全等——orgRescanPending 不触发=联动全清根除）");

      // B3 推进口径与 import-org observe 逐字同款（行为证：importAllForShadow 后 checkpoint 仍命中——域快进）
      await importAllForShadow(port, dirs);
      const cp3 = readCheckpoint(port, orgFile, { mtimeMs: obs2.mtimeMs, mtimeNs: obs2.mtimeNs, lineCount: lines2.length, schemaVersion: 1 });
      assert(cp3 !== null, "推进口径与导入器 observe 同款（导入后 checkpoint 不被覆写成异值——快进稳定）");

      // B4 缺席文件防御：推进口对不存在文件 no-op 不炸
      advanceOrgSourceCheckpoint(join(orgDir, "no-such.json"));
      assert(true, "缺席文件 no-op 不炸（clearOrgAnchor 删文件形态）");

      port.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("C. 正交锚：events appendOnly 快进不回归（本修不动 events 语义）");
  {
    const { readFileSync: rd } = await import("node:fs");
    const ck = rd(new URL("../src/storage/checkpoint.ts", import.meta.url), "utf8");
    assert(ck.includes("opts?.appendOnly") && ck.includes("current.lineCount < checkpoint.lineCount"), "appendOnly 增量续读在位（events append→offset 续跑——bootfast3 与 F2 正交）");
    const st = rd(new URL("../src/storage/import-session-task.ts", import.meta.url), "utf8");
    assert(st.includes("appendOnly: true"), "session-task events 段 appendOnly 接线在位（不回归）");
  }

  console.log("D. 刀 B：导入 async 让出+冷路径后台化（HTTP 活性保命底）");
  {
    const { readFileSync: rd } = await import("node:fs");
    const rm = rd(new URL("../src/storage/read-mode.ts", import.meta.url), "utf8");
    const st = rd(new URL("../src/storage/import-session-task.ts", import.meta.url), "utf8");
    // D1 源码锚：让出结构在位
    assert(rm.includes("export async function importAllForShadow") && rm.includes("opts?: { yieldFn"), "importAllForShadow async 化+yieldFn 透传（域间让出）");
    assert(rm.includes("await run();"), "steps 循环 await（session-task 域内批间 yieldFn 生效前提）");
    assert(rm.includes("yieldFn: () => new Promise<void>((r) => setImmediate(r))"), "scheduleShadowImport chunked 让出（后台≠异步——同步 sqlite 链照样霸占事件循环，让出才给 IO 处理窗）");
    assert(!rm.includes("importAllForShadow(port, dirs);\n  shadowSigCache.set"), "冷路径同步导入退役（原「返回 port 即已灌」语义拆除）");
    assert(st.includes("await yieldFn?.();"), "importSessionTask 批间让出在位（events 批+task parse 批）");
    assert(st.indexOf("await yieldFn?.();") > st.indexOf("flushBatch();") && st.includes("(fi + 1) % 200 === 0"), "让出点在批事务 commit 之后+task parse 200 文件批间（事务内绝不 await）");

    // D2 行为：yieldFn 让出生效+数据完整性（让出不破坏批事务/checkpoint 推进）
    const { importAllForShadow: iafs } = await import("../src/storage/read-mode.js");
    const { importSessionTask } = await import("../src/storage/import-session-task.js");
    const { createSqlitePort } = await import("../src/storage/sqlite.js");
    const { runMigrations } = await import("../src/storage/migrator.js");
    const { migrations } = await import("../src/storage/schema.js");
    const { readCheckpoint: rcp } = await import("../src/storage/checkpoint.js");
    const { writeFileSync: wf, mkdirSync: mk } = await import("node:fs");
    const rfStats = (p: string): number => Math.round(statSync(p).mtimeMs);
    const root2 = mkdtempSync(join(tmpdir(), "bootfast3b-"));
    const orgDir2 = join(root2, "org");
    const dataDir2 = join(root2, "data");
    mk(orgDir2, { recursive: true });
    mk(dataDir2, { recursive: true });
    mk(join(dataDir2, "tasks"), { recursive: true });
    mk(join(dataDir2, "acceptances"), { recursive: true });
    wf(join(orgDir2, "projects.json"), JSON.stringify({ groups: [], trust_light: false }, null, 2) + "\n");
    wf(join(orgDir2, "confirms.json"), JSON.stringify({ confirms: [] }, null, 2) + "\n");
    const eventsFile2 = join(dataDir2, "events.ndjson");
    const evRow = (i: number, cwdRoot: string) => JSON.stringify({ seq: i, session_id: "s" + (i % 3), ts: 1700000000000 + i, type: "SESSION_CREATED", payload: { cwd: cwdRoot, model: "glm-5.3" } });
    let big = "";
    for (let i = 0; i < 12; i++) big += evRow(i, root2) + "\n";
    wf(eventsFile2, big);
    try {
      const port2 = createSqlitePort({ dataDir: dataDir2 });
      port2.open();
      runMigrations(port2, migrations);
      // 12 行 / batchSize 4 = 3 批 → events 批间让出 ≥3；不传 yieldFn 时零让出（同步等价）
      let yields = 0;
      const yieldFn = async (): Promise<void> => { yields++; };
      const rA = await importSessionTask(port2, { eventsFile: eventsFile2, tasksDir: join(dataDir2, "tasks"), acceptanceDir: join(dataDir2, "acceptances") }, { batchSize: 4, yieldFn });
      const nSess = port2.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -1;
      assert(yields >= 3, `events 批间让出生效（12 行/批 4 → yields=${yields} ≥3——导入期事件循环有处理窗）`);
      assert(rA.eventsProcessed === 12 && nSess === 3, `让出不破坏数据（processed=${rA.eventsProcessed}/12，session=${nSess}/3——批事务完整性保持）`);
      const cpE = rcp(port2, eventsFile2, { mtimeMs: rfStats(eventsFile2), lineCount: 12, schemaVersion: 1 }, { appendOnly: true });
      assert(cpE !== null && cpE.offset === 12, "让出后 checkpoint 推进到 lineCount（断点续跑链路完好）");
      // 全链（七域域间让出）：importAllForShadow 计数 > 单域
      let yields2 = 0;
      await iafs(port2, { dataDir: dataDir2, orgDir: orgDir2, tasksDir: join(dataDir2, "tasks") } as never, { yieldFn: async () => { yields2++; } });
      assert(yields2 >= 7, `importAllForShadow 域间让出生效（七域 → yields=${yields2} ≥7）`);
      port2.close?.();
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }

    // D3 行为：冷路径后台化（ensureStore 返回即 isShadowImportPending=true——json 权威兜底窗）
    const { ensureStore, isShadowImportPending, flushShadowImportForTest, resolveDirs } = await import("../src/storage/read-mode.js");
    const root3 = mkdtempSync(join(tmpdir(), "bootfast3c-"));
    const orgDir3 = join(root3, "org");
    const dataDir3 = join(root3, "data");
    mk(orgDir3, { recursive: true });
    mk(dataDir3, { recursive: true });
    mk(join(dataDir3, "tasks"), { recursive: true });
    mk(join(dataDir3, "acceptances"), { recursive: true });
    wf(join(orgDir3, "projects.json"), JSON.stringify({ groups: [], trust_light: false }, null, 2) + "\n");
    wf(join(orgDir3, "confirms.json"), JSON.stringify({ confirms: [] }, null, 2) + "\n");
    let big3 = "";
    for (let i = 0; i < 12; i++) big3 += evRow(i, root3) + "\n";
    wf(join(dataDir3, "events.ndjson"), big3);
    try {
      process.env.CCR_DATA_DIR = dataDir3;
      process.env.CCR_ORG_DIR = orgDir3;
      const dirs3 = resolveDirs({ dataDir: dataDir3, orgDir: orgDir3 });
      const port3 = ensureStore(dirs3);
      assert(port3 !== null && isShadowImportPending(dataDir3), "冷路径返回 port 且导入在后台窗内（isShadowImportPending=true——读面走 json 权威兜底，不再同步霸占）");
      await flushShadowImportForTest(dataDir3);
      assert(!isShadowImportPending(dataDir3), "后台导入收尾（dirty 清——sqlite 权威恢复）");
      const n3 = port3.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -1;
      assert(n3 === 3, `后台导入数据完整（session=${n3}/3——返回后落账）`);
      port3.close?.();
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  }

  console.log(`\n========== bootfast3 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
