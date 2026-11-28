// DEV-39 批测：四件代码面的行为与接线锁。
//   A. boot-env（清单1 载体）：白名单/进程 env 优先/坏文件不炸/应用可观测。
//   B. storage/status（清单4）：画像恒真面（四键+降级事实+实效档）。
//   C. build-info（清单3）：unstamped 缺席语义 + 烙印比对 ok/mismatch 两态。
//   D. events 归档位（清单2）：压缩丢弃段整段入档、seq 连续性、缺省 off 零行为。
//   E. 接线锚：index 首位 import / /health 两段 / patrol 两键 / bundle defines。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const GRAY_KEYS = ["CCR_STORAGE_READ_MODE", "CCR_SESSION_WRITE_MODE", "CCR_SESSION_IMPORT", "CCR_BOOT_FROM", "CCR_EVENTS_ARCHIVE", "CCR_BUILD_NODE_VERSION", "CCR_BUILD_NODE_ABI", "CCR_BUILD_PLATFORM", "CCR_DATA_DIR", "CCR_ORG_DIR"] as const;
// 隔离要点：CCR_RELAY_ENV_FILE 不走 delete——delete 后 boot-env 回落缺省
// ~/.cc-deck/relay-env.json，生产灰度文件真实存在时会渗进测试（DEV-39 收口期实测
// 踩中）。恒钉到不存在的沙盒位=「文件缺席」语义的可控实现。
const NO_ENV_FILE = join(tmpdir(), "dev39-no-relay-env.json");
const clearGrayEnv = (): void => {
  for (const k of GRAY_KEYS) delete process.env[k];
  process.env.CCR_RELAY_ENV_FILE = NO_ENV_FILE;
};

async function main(): Promise<void> {
  clearGrayEnv();

  console.log("A. boot-env：灰度 env 覆盖文件（清单1 生产载体）");
  {
    const root = mkdtempSync(join(tmpdir(), "dev39-bootenv-"));
    try {
      // A1 白名单：未知键忽略、合法键应用（query 破缓存取新模块实例——模块体 boot 期语义）
      const f1 = join(root, "relay-env-1.json");
      writeFileSync(f1, JSON.stringify({ CCR_BOOT_FROM: "auto", CCR_NOT_A_GRAY_KEY: "x" }));
      process.env.CCR_RELAY_ENV_FILE = f1;
      const m1 = await import(`../src/boot-env.js?a=${Date.now()}`);
      assert(process.env.CCR_BOOT_FROM === "auto", "A1 白名单键应用（CCR_BOOT_FROM=auto）");
      assert((process.env as Record<string, string | undefined>).CCR_NOT_A_GRAY_KEY === undefined, "A1 未知键不注入");
      assert(m1.appliedRelayEnvFile().keys.length === 1 && m1.appliedRelayEnvFile().keys[0] === "CCR_BOOT_FROM", "A1 应用记录可观测（keys=[CCR_BOOT_FROM]）");
      assert(m1.appliedRelayEnvFile().file === f1, "A1 应用记录含文件路径");

      // A2 进程显式 env 优先：已设键不被文件覆盖
      clearGrayEnv();
      const f2 = join(root, "relay-env-2.json");
      writeFileSync(f2, JSON.stringify({ CCR_SESSION_IMPORT: "off" }));
      process.env.CCR_RELAY_ENV_FILE = f2;
      process.env.CCR_SESSION_IMPORT = "on"; // CLI 直跑显式语义
      const m2 = await import(`../src/boot-env.js?b=${Date.now()}`);
      assert(process.env.CCR_SESSION_IMPORT === "on", "A2 进程显式 env 不被文件覆盖");
      assert(m2.appliedRelayEnvFile().keys.length === 0, "A2 被覆盖键不计入应用记录");

      // A3 坏文件：不炸、不应用、file 记「读了没成」
      clearGrayEnv();
      const f3 = join(root, "relay-env-3.json");
      writeFileSync(f3, "{not json");
      process.env.CCR_RELAY_ENV_FILE = f3;
      const m3 = await import(`../src/boot-env.js?c=${Date.now()}`);
      assert(m3.appliedRelayEnvFile().file === f3 && m3.appliedRelayEnvFile().keys.length === 0, "A3 坏 JSON 忽略且可观测");

      // A4 非串值跳过
      clearGrayEnv();
      const f4 = join(root, "relay-env-4.json");
      writeFileSync(f4, JSON.stringify({ CCR_EVENTS_ARCHIVE: 1 }));
      process.env.CCR_RELAY_ENV_FILE = f4;
      const m4 = await import(`../src/boot-env.js?d=${Date.now()}`);
      assert(m4.appliedRelayEnvFile().keys.length === 0, "A4 非字符串值跳过");

      // A5 文件缺席：零动作零记录
      clearGrayEnv();
      process.env.CCR_RELAY_ENV_FILE = join(root, "nope.json");
      const m5 = await import(`../src/boot-env.js?e=${Date.now()}`);
      assert(m5.appliedRelayEnvFile().file === "" && m5.appliedRelayEnvFile().keys.length === 0, "A5 文件缺席零动作");
    } finally {
      clearGrayEnv();
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("B. storage/status：存储态单点画像（清单4 / R-3）");
  {
    const { storageStatus } = await import("../src/storage/status.js");
    const { resetReadModeForTest, resetSqliteDegradationFlagForTest } = await import("../src/storage/read-mode.js");
    const { resetSqliteDriverForTest } = await import("../src/storage/sqlite.js");
    resetReadModeForTest();

    // B1 缺省画像：读 sqlite/写 shadow/导入 on/boot events/未降级/驱动 ok（本机驱动真实可载）
    clearGrayEnv();
    let st = storageStatus();
    assert(st.readMode === "sqlite" && st.effectiveReadMode === "sqlite", "B1 缺省读档 sqlite（2026-10-06 翻转后缺省）");
    assert(st.writeMode === "shadow" && st.sessionImport === "on" && st.bootFrom === "events", "B1 缺省灰度三键（shadow/on/events）");
    assert(st.degraded === null && st.driver === "ok", "B1 未降级+驱动可载");
    assert(st.envFile.file === "" && st.envFile.keys.length === 0, "B1 env 文件未参与");

    // B2 灰度键全反映
    process.env.CCR_SESSION_WRITE_MODE = "db";
    process.env.CCR_SESSION_IMPORT = "off";
    process.env.CCR_BOOT_FROM = "auto";
    st = storageStatus();
    assert(st.writeMode === "db" && st.sessionImport === "off" && st.bootFrom === "auto", "B2 灰度三键画像反映");
    clearGrayEnv();

    // B3 降级路径：驱动失败 → 降级事实入账 + 实效档 json（json 模 io 不触盘）
    resetReadModeForTest();
    resetSqliteDegradationFlagForTest();
    resetSqliteDriverForTest({ ok: false, ctor: null, error: "NODE_MODULE_VERSION 115 vs 127（测试注入）", code: "ERR_DLOPEN_FAILED" });
    const { viaReadMode } = await import("../src/storage/read-mode.js");
    const back = viaReadMode("task", { json: () => [{ x: 1 }], sqlite: () => [{ x: 2 }] });
    assert(JSON.stringify(back) === JSON.stringify([{ x: 1 }]), "B3 驱动失败读面落 json 权威（#158 语义保持）");
    st = storageStatus();
    assert(st.degraded !== null && st.degraded?.code === "ERR_DLOPEN_FAILED", "B3 降级事实入账（code 可读——/health/patrol 消费面）");
    assert(st.effectiveReadMode === "json" && st.driver === "failed", "B3 实效档 json+driver failed");
    // 复原（后续段不吃注入）
    resetReadModeForTest();
    resetSqliteDriverForTest();
    st = storageStatus();
    assert(st.degraded === null && st.driver === "ok", "B3 复原后画像回健康（reset 面）");
  }

  console.log("C. build-info：ABI 烙印自比对（清单3 / R-7）");
  {
    // C1 tsx 源码跑=无烙印：unstamped 不比对不告警（缺席≠错误）
    clearGrayEnv();
    const c1 = await import(`../src/build-info.js?a=${Date.now()}`);
    assert(c1.buildRuntimeMatch().match === "unstamped" && c1.buildRuntimeMatch().stamped === false, "C1 源码跑 unstamped（无 define 三键）");

    // C2 烙印一致：ok
    process.env.CCR_BUILD_NODE_VERSION = process.versions.node;
    process.env.CCR_BUILD_NODE_ABI = process.versions.modules;
    process.env.CCR_BUILD_PLATFORM = `${process.platform}-${process.arch}`;
    const c2 = await import(`../src/build-info.js?b=${Date.now()}`);
    assert(c2.buildRuntimeMatch().match === "ok", "C2 烙印=运行时 → ok");

    // C3 ABI 错配（11-24 形态）：mismatch+错配面=abi（node 主版本同档不虚报）
    process.env.CCR_BUILD_NODE_ABI = String(Number(process.versions.modules) === 127 ? 115 : 127);
    const c3 = await import(`../src/build-info.js?c=${Date.now()}`);
    const mm = c3.buildRuntimeMatch();
    assert(mm.match === "mismatch" && mm.mismatchKeys.includes("abi"), "C3 ABI 错配 → mismatch（报警路径入口）");

    // C4 平台错配（哨兵串——审查 P1：钉真实平台名会在 CI（linux-x64 runner）上
    // 恰与运行时相等 → 断言恒假必红；用不存在于任何真实 runtime 的探针串）
    process.env.CCR_BUILD_NODE_ABI = process.versions.modules;
    process.env.CCR_BUILD_PLATFORM = "ci-probe-mismatch-platform";
    const c4 = await import(`../src/build-info.js?d=${Date.now()}`);
    assert(c4.buildRuntimeMatch().match === "mismatch" && c4.buildRuntimeMatch().mismatchKeys.includes("platform"), "C4 平台错配 → mismatch（探针串，CI/本机同判）");
    clearGrayEnv();
  }

  console.log("D. events 归档位（清单2 / R-9）");
  {
    const { compactEventsFile, loadEvents } = await import("../src/history.js");
    const root = mkdtempSync(join(tmpdir(), "dev39-archive-"));
    try {
      // 夹具：40 会话×各 3 条 LOG（MAX_SESSIONS_KEPT=30 → 压缩必丢 10 会话）
      const lines: string[] = [];
      let seq = 0;
      for (let s = 0; s < 40; s++) {
        lines.push(JSON.stringify({ seq: ++seq, session_id: `s-${s}`, ts: seq, type: "SESSION_CREATED", payload: {} }));
        for (let l = 0; l < 3; l++) lines.push(JSON.stringify({ seq: ++seq, session_id: `s-${s}`, ts: seq, type: "SESSION_LOG", payload: { text: `log-${l}` } }));
      }
      const live = join(root, "events.ndjson");
      writeFileSync(live, lines.join("\n") + "\n");
      const before = loadEvents(live);
      const archDir = join(root, "events-archive");

      // D1 无 archiveDir（缺省 off 行为）：压缩照旧、无归档目录
      const r0 = compactEventsFile(live, 1);
      assert(r0 !== null && !existsSync(archDir), "D1 缺省无归档（行为与收口前同款）");
      const kept0 = loadEvents(live);
      assert(kept0.length < before.length, "D1 压缩确已发生");

      // D2 有 archiveDir：丢弃段整段入档、账目对平、seq 全量守恒
      // 重建夹具到「再可压缩」形态：补 15 个新会话（总 45>30，且新会话更活跃排前）
      const lines2: string[] = [readFileSync(live, "utf-8")];
      for (let s = 100; s < 115; s++) {
        lines2.push(JSON.stringify({ seq: ++seq, session_id: `n-${s}`, ts: seq, type: "SESSION_CREATED", payload: {} }) + "\n");
        for (let l = 0; l < 4; l++) lines2.push(JSON.stringify({ seq: ++seq, session_id: `n-${s}`, ts: seq, type: "SESSION_LOG", payload: { text: `log-${l}` } }) + "\n");
      }
      writeFileSync(live, lines2.join(""));
      const before2 = loadEvents(live);
      const r2 = compactEventsFile(live, 1, { archiveDir: archDir });
      assert(r2 !== null && typeof r2.archived === "number" && r2.archived > 0, `D2 归档发生（archived=${r2?.archived}）`);
      const archFile = r2?.archiveFile ?? "";
      assert(existsSync(archFile) && /events-arch-\d{8}\.ndjson$/.test(archFile), "D2 归档文件按日命名在位");
      const kept2 = loadEvents(live);
      const archived = loadEvents(archFile);
      assert(archived.length === r2?.archived, "D2 归档行数=报告数");
      assert(kept2.length + archived.length === before2.length, `D2 账目对平（保留 ${kept2.length}+归档 ${archived.length}=压缩前 ${before2.length}）`);
      const seqs = new Map<string, number>();
      for (const e of [...kept2, ...archived]) seqs.set(`${e.seq}`, (seqs.get(`${e.seq}`) ?? 0) + 1);
      assert([...seqs.values()].every((n) => n === 1) && seqs.size === before2.length, "D2 seq 全量守恒且无重复（连续性零破坏）");
      assert(Math.max(...kept2.map((e) => e.seq)) === Math.max(...before2.map((e) => e.seq)), "D2 活文件末行 seq 不回退（EventBus 续seq 前提）");

      // D3 已最简：二次压缩 null（幂等）
      const r3 = compactEventsFile(live, 1, { archiveDir: archDir });
      assert(r3 === null, "D3 已最简不白写（幂等）");

      // D4 追加合流：另一文件压缩丢弃段入同一归档目录（同日 append 合流/异日新文件）
      const more = join(root, "more.ndjson");
      writeFileSync(more, Array.from({ length: 40 }, (_, i) => JSON.stringify({ seq: i + 1, session_id: `z-${i}`, ts: i + 1, type: "SESSION_LOG", payload: {} })).join("\n") + "\n");
      const ra = compactEventsFile(more, 1, { archiveDir: archDir });
      // 40 会话各 1 log：保留 top30（MAX_SESSIONS_KEPT），弃 10
      assert(ra !== null && ra.archived === 10, `D4 第二轮归档发生（archived=${ra?.archived}，期望 10）`);
      const { readdirSync } = await import("node:fs");
      const total = readdirSync(archDir).filter((f) => f.endsWith(".ndjson")).reduce((n, f) => n + loadEvents(join(archDir, f)).length, 0);
      assert(total === (r2?.archived ?? 0) + 10, `D4 归档目录总量对平（${total}=${r2?.archived}+10，append 合流不覆盖）`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("E. 接线锚（漏接=修一半）");
  {
    const rd = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
    const idx = rd("../src/index.ts");
    assert(idx.indexOf('import "./boot-env.js"') !== -1 && idx.indexOf('import "./boot-env.js"') < idx.indexOf('import { bootMark'), "E1 index.ts 首位 import boot-env（先于一切业务模块）");
    assert(idx.includes("abiSentinelAtBoot();"), "E1 boot ABI 哨调用在位");
    assert(idx.includes("[storage-boot]"), "E1 boot 存储态行在位");
    assert(idx.includes("eventsArchiveDir"), "E1 归档 tick 接线在位");
    const ws = rd("../src/ws-server.ts");
    assert(ws.includes("storage: storageStatus()") && ws.includes("abi: buildRuntimeMatch()"), "E2 /health 双段（storage+abi）在位");
    const pt = rd("../src/patrol.ts");
    assert(pt.includes('"storage-degraded"') && pt.includes('"abi-mismatch"'), "E3 patrol 轻探针两告警键在位");
    const bo = rd("../scripts/bundle-options.mjs");
    assert(bo.includes("CCR_BUILD_NODE_VERSION") && bo.includes("CCR_BUILD_NODE_ABI") && bo.includes("CCR_BUILD_PLATFORM"), "E4 bundle defines 三键在位");
    const bp = rd("../scripts/build-plugin.mjs");
    assert(bp.includes("pluginJson.build"), "E4 plugin.json manifest 烙印在位");
    // E5：坏行防御回归锚（loadEvents 对归档/活文件同样适用）
    const hist = rd("../src/history.ts");
    assert(hist.includes("R-9 审计归档位"), "E5 history.ts 归档位设计注记在位");
  }

  console.log("F. 终态直写根修锚（收口阻断项：transition 单点直写）");
  {
    const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
    const tStart = sm.indexOf("private transition(sid: string");
    const tEnd = sm.indexOf("private transitionNotifications", tStart);
    assert(tStart !== -1 && tEnd !== -1, "F1 transition 函数定位在档");
    const body = sm.slice(tStart, tEnd);
    assert(body.includes("shadowWriteSession(s.state)"), "F1 transition 内直写收口在位（终态 DONE 不再漏库——import=off 后唯一写路径）");
    // emitUpdated 帧面挂点保留（内容更新路径不回归）
    assert(sm.includes("try { shadowWriteSession(s.state); } catch"), "F1 emitUpdated 帧面直写挂点保留（双路幂等）");
    // 返修 P1-1a：终态收口点字段补写后的末笔全量落库（flushSessionRow）——六终态路径
    // + setExternalStatus 旁路（返修 P2-1e）都必须过口（缺一个=不完整快照复发面）
    const flushSites = (sm.match(/this\.flushSessionRow\(/g) ?? []).length;
    assert(flushSites >= 7, `F2 终态/外部收口点 flushSessionRow ≥7 处（实测 ${flushSites}：finishExternal/turn-end ok/turn-end err/stream-close/stream-idle/boot-dim/setExternalStatus）`);
    assert(sm.includes("private flushSessionRow"), "F2 flushSessionRow 单点定义在位");
  }

  console.log("G. 返修面：boot 归档重写/降级清账/暴露面收敛");
  {
    // G1 rewriteFileArchiving 行为（deck-reviewer P2-1 返修后=全程同步）：函数返回即
    // 重写完毕——下方所有断言零轮询零等待（这就是同步锚本体：异步窗口由构造消除，
    // boot 中段的同步 appendLine 只能落在重写后的活文件上）；账目对平+追加不丢。
    const { rewriteFileArchiving, loadEvents, appendLine } = await import("../src/history.js");
    const root = mkdtempSync(join(tmpdir(), "dev39-bootarch-"));
    try {
      const lines: string[] = [];
      let seq = 0;
      for (let s = 0; s < 40; s++) {
        lines.push(JSON.stringify({ seq: ++seq, session_id: `b-${s}`, ts: seq, type: "SESSION_CREATED", payload: {} }));
        lines.push(JSON.stringify({ seq: ++seq, session_id: `b-${s}`, ts: seq, type: "SESSION_LOG", payload: { text: "x" } }));
      }
      const live = join(root, "events.ndjson");
      writeFileSync(live, lines.join("\n") + "\n");
      const before = loadEvents(live);
      // kept=后 30 会话（活跃序）——模拟 bootReplayFile 的 kept 形态
      const kept = before.filter((e) => Number(e.session_id.slice(2)) >= 10);
      rewriteFileArchiving(live, kept, join(root, "events-archive"));
      const after = loadEvents(live); // 零等待直读——同步完成的账目对平锚
      const { readdirSync } = await import("node:fs");
      const arch = readdirSync(join(root, "events-archive")).flatMap((f) => loadEvents(join(root, "events-archive", f)));
      assert(after.length === kept.length, `G1 活文件=kept（${after.length}=${kept.length}，返回即重写完毕）`);
      assert(arch.length === before.length - kept.length, `G1 丢弃段整段入档（${arch.length}=${before.length - kept.length}）`);
      assert(arch.every((e) => !kept.some((k) => k.seq === e.seq)), "G1 归档段与 kept 无交集");
      assert(after.length + arch.length === before.length, `G1 账目对平（${after.length}+${arch.length}=${before.length}）`);
      // boot 窗口追加不丢锚：重写后同 tick 追加（adopt 广播的同步 appendLine 形态），
      // 行必须在活文件——异步版此处活文件还是旧内容/追加行会被迟到重写截掉。
      appendLine(live, { seq: 999999, session_id: "b-10", ts: Date.now(), type: "SESSION_LOG", payload: { text: "post-rewrite" } });
      assert(loadEvents(live).some((e) => e.seq === 999999), "G1 重写后追加行不丢（boot 窗口账目对平）");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // G2 暴露面收敛（源锚）：/health 不泄绝对路径与超长错误串
    const st = readFileSync(new URL("../src/storage/status.ts", import.meta.url), "utf8");
    assert(st.includes("basename(envApplied.file)"), "G2 envFile 只出 basename");
    assert(st.includes("degraded.reason.length > 160"), "G2 degraded.reason 截断 160");
    // G3 降级清账（源锚）：viaReadMode ensureStore 成功后清 lastDegradation
    const rmSrc = readFileSync(new URL("../src/storage/read-mode.ts", import.meta.url), "utf8");
    assert(rmSrc.includes("降级台账清账"), "G3 恢复清账口在位（patrol storage-degraded 可闭合）");
    // G4 boot 归档接线（源锚）
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert(idx.includes("rewriteFileArchiving(persistPath, kept, eventsArchiveDir)"), "G4 boot 压缩走归档版重写");
    // G5 同步构造源锚：函数体内无 readline/事件回调（异步窗口复发面）
    const hist = readFileSync(new URL("../src/history.ts", import.meta.url), "utf8");
    const rfaStart = hist.indexOf("export function rewriteFileArchiving");
    const rfaEnd = hist.indexOf("export function appendLine", rfaStart);
    const rfaBody = hist.slice(rfaStart, rfaEnd);
    assert(!rfaBody.includes("readline") && !rfaBody.includes(".on("), "G5 rewriteFileArchiving 全同步（无事件回调——窗口由构造消除）");
    assert(rfaBody.includes("readFileSync"), "G5 二遍扫=同步读（与 compactEventsFile 同形）");
  }

  console.log("H. 降级→恢复→再降级 复发可见（deck-reviewer P2-2 负向锚——清单4口径）");
  {
    const { viaReadMode, resetReadModeForTest } = await import("../src/storage/read-mode.js");
    const { resetSqliteDriverForTest } = await import("../src/storage/sqlite.js");
    const { storageStatus } = await import("../src/storage/status.js");
    const root = mkdtempSync(join(tmpdir(), "dev39-relapse-"));
    try {
      resetReadModeForTest();
      const io = {
        json: () => [] as unknown[],
        sqlite: () => [] as unknown[],
        dirs: { dataDir: join(root, "data"), orgDir: join(root, "org"), tasksDir: join(root, "tasks") },
      };
      const CODE = "ERR_DLOPEN_FAILED";
      const fail = (msg: string): void => resetSqliteDriverForTest({ ok: false, ctor: null, error: msg, code: CODE });
      // 第一次降级：台账入账（11-24 主场景——首降可见既有面）
      fail("第一次降级（测试注入）");
      viaReadMode("task", io);
      assert(storageStatus().degraded !== null, "H1 第一次降级可见（台账入账）");
      // 恢复：驱动 ok + ensureStore 成功（沙盒建库）→ 台账清账
      resetSqliteDriverForTest();
      viaReadMode("task", io);
      assert(storageStatus().degraded === null, "H1 恢复清账（台账 null，/health 回健康）");
      // 再降级：闩已随恢复复位——第二次必须重新入账（回归锚：闩不清时此处恒 null，
      // /health 报健康+patrol 空文案=复发盲区，正是清单4要堵的形态）
      fail("第二次降级（测试注入——复发）");
      viaReadMode("task", io);
      const d2 = storageStatus().degraded;
      assert(d2 !== null && d2?.reason.includes("第二次"), "H1 复发当场可见（第二次降级重新入账）");
      assert(d2?.code === CODE, "H1 复发事实带错误码（patrol 文案消费面）");
    } finally {
      resetSqliteDriverForTest();
      resetReadModeForTest();
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} DEV-39 批测：${pass} 过 / ${fail} 败`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
