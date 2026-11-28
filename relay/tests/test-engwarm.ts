// DEV-23 断言档：引擎登录态探针热路径暖读（SNAPSHOT 冻结治根回归锁）。
// 缺陷链（本机实锤）：SNAPSHOT 组装 → engineCatalogSummary → probeEngineAuth(codebuddy)
// → spawnSync('codebuddy-code',['auth','status'],{timeout:5000})——codebuddy CLI 冷启
// 实测 34s，探针 5s 超时期间 spawnSync 同步冻结事件循环整 5s：心跳//health/云桥全停，
// LAN/云首连 SNAPSHOT 延至 ~5.7s（test:settings-ws 本地确定性红根因；CI 无 codebuddy
// ENOENT 秒回故 CI 绿）。45s TTL 缓存只降频不消除。
// 治根三件（engine-auth.ts）：①热路径 engineAuthWarmRead 绝不同步 spawn（缓存/文件
// 判定优先，冷缓存 fail-open ready）②spawn 系探针 execFile 异步回填同一缓存
// ③index.ts 启动预热+暖读见过期自续探。本档锁行为：
//   A 热路径零同步 spawn：慢桩 CLI 配置下 engineCatalogSummary 亚秒返回（原缺陷形态
//     =5s 冻结），桩未被同步拉起（marker 缺席）
//   B 异步回填真值：needs_auth 桩输出 → 异步预热完成后暖读翻 needs_auth（带 hint）；
//     B3 锁非零退出+失效文案形态（修前暖读把一切 execFile err 短路 fail-open ready
//     写脏 probeCache=审查桩实验实锤的 P1 分叉），B4/B5 锁同步直探/async 探针同判据
//   C codex 认配置优先铁律不破：三源在场（OPENAI_API_KEY）→ 暖读恒 ready 零 spawn
//   D 暖读非阻塞：任意缓存态暖读恒亚秒（stale-while-revalidate 的间接形态）——
//     「过期先回陈值」本体未直测：TTL 是模块私有常量无注入缝（已知测试局限，
//     P3② 如实化；注入缝随其他工作落地时顺手补真断言，不单独立项）
//   E 同步口 probeEngineAuth 语义原样：命令处置路径（COMMAND_CREATE/派单拦截）不受
//     暖读改造波及（带 opts 直探旁路依旧零缓存）
// 环境隔离：mkdtemp DATA/ORG；桩脚本写 marker 文件证「是否被拉起过」。
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CCR_STORAGE_READ_MODE = "json";
const DATA = mkdtempSync(join(tmpdir(), "engwarm-data-"));
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "engwarm-org-"));
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_CLOUD_URL = "";
delete process.env.CCR_CWD;

let pass = 0, fail = 0;
function ok(c: unknown, name: string) {
  if (c) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const eng = await import("../src/engine-auth.js");
  const { engineCatalogSummary } = await import("../src/engine-catalog.js");

  // 桩脚本：启动即写 marker（证被拉起）；sleep 9s（> 探针 5s 超时——同步形态必冻 5s）
  const stubDir = join(DATA, "stubs");
  mkdirSync(stubDir, { recursive: true });
  const mkStub = (name: string, body: string): string => {
    const p = join(stubDir, name);
    writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  const marker = join(DATA, "spawned.marker");
  const slowStub = mkStub("slow-cli", `#!/bin/sh\ntouch "${marker}"\nsleep 9\n`);
  const needsAuthStub = mkStub("needsauth-cli", `#!/bin/sh\ntouch "${marker}"\necho "Authentication required. Please use /login command to sign in to your account"\n`);

  // ---------- A 热路径零同步 spawn ----------
  console.log("A 热路径零同步 spawn（慢桩 9s > 探针超时 5s）：");
  process.env.CCR_CODEBUDDY_PATH = slowStub;
  eng.resetEngineAuthCache();
  const t0 = Date.now();
  const cat = engineCatalogSummary("");
  const elapsed = Date.now() - t0;
  const cb = cat.find((e) => e.id === "codebuddy");
  ok(elapsed < 500, `A1 engineCatalogSummary 亚秒返回（实 ${elapsed}ms；原缺陷形态=冻结 ~5000ms）`);
  ok(!!cb && cb.state === "ready", `A2 冷缓存 fail-open ready（实 ${cb?.state}——同步超时探针的结果同为 ready，零信息损失）`);
  ok(!existsSync(marker), "A3 慢桩未被同步拉起（marker 缺席=零 spawnSync）");
  // A 段暖读触发的慢桩异步探针（5s 超时杀）需先排空——in-flight 去重会挡掉 B 段预热
  //（常规足够；高负载下残留由 B 段轮询重驱兜底，见 B1 注）
  await wait(5300);

  // ---------- B 异步回填真值 ----------
  console.log("B 异步回填真值（needs_auth 桩）：");
  rmSync(marker, { force: true });
  process.env.CCR_CODEBUDDY_PATH = needsAuthStub;
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  // 轮询重驱替代一次性 600ms 等待：A 段慢桩探针（5s 超时杀）的 in-flight 去重在
  // 高负载下可超出上方 5300ms 排空窗（电池轮实测 B1/B2 偶发红即此）——轮询期间
  // summary 暖读对空缓存引擎自动续触发探针，冷负载下仍确定性收敛
  const b1Deadline = Date.now() + 6500;
  while (!existsSync(marker) && Date.now() < b1Deadline) {
    engineCatalogSummary("");
    await wait(150);
  }
  ok(existsSync(marker), "B1 异步预热确实拉起桩（marker 在场）");
  let after = engineCatalogSummary("").find((e) => e.id === "codebuddy");
  const b2Deadline = Date.now() + 2000;
  while (!(after?.state === "needs_auth" && after?.auth_hint) && Date.now() < b2Deadline) {
    await wait(150);
    after = engineCatalogSummary("").find((e) => e.id === "codebuddy");
  }
  ok(after?.state === "needs_auth" && !!after?.auth_hint, `B2 回填后暖读翻 needs_auth 带 hint（实 ${after?.state}/${!!after?.auth_hint}）`);

  // B3（DEV-23 修复轮 P1 回归锁）：非零退出+失效文案桩——「装了未登录」真实形态
  //（codebuddy auth status 未登录时非零退出吐 Authentication required）。修前暖读把
  // 一切 execFile err（含非零退出）短路 fail-open ready 写脏 probeCache（审查桩实验
  // 实锤的分叉），修后判据对齐同步版：仅拉起失败/超时杀才 fail-open，非零退出照常
  // 文本匹配。B4/B5 同桩双口一致性：同步直探（带 opts 旁路缓存）与 async 探针（登录
  // pane 轮验路径=P3③ execFileText 收窄面）必须同判 needs_auth——锁三口不分叉。
  const nzStub = mkStub("needsauth-exit2-cli", `#!/bin/sh\ntouch "${marker}"\necho "Authentication required. Please use /login command to sign in to your account"\nexit 2\n`);
  rmSync(marker, { force: true });
  process.env.CCR_CODEBUDDY_PATH = nzStub;
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  // 同 B1/B2：轮询重驱至回填收敛（防 in-flight 残留/冷负载一次性等待竞态）
  let nz = engineCatalogSummary("").find((e) => e.id === "codebuddy");
  const nzDeadline = Date.now() + 6500;
  while (!(nz?.state === "needs_auth" && nz?.auth_hint) && Date.now() < nzDeadline) {
    engineCatalogSummary("");
    await wait(150);
    nz = engineCatalogSummary("").find((e) => e.id === "codebuddy");
  }
  ok(nz?.state === "needs_auth" && !!nz?.auth_hint, `B3 非零退出+失效文案桩：回填后暖读 needs_auth（实 ${nz?.state}/${!!nz?.auth_hint}——修前=ready 脏缓存）`);
  ok(eng.probeEngineAuth("codebuddy", { timeoutMs: 1500 }).state === "needs_auth", "B4 同桩同步口带 opts 直探 needs_auth（暖读/直探不分叉）");
  ok((await eng.probeEngineAuthAsync("codebuddy", { timeoutMs: 1500 })).state === "needs_auth", "B5 同桩 async 探针 needs_auth（P3③ execFileText 收窄后非零退出走文本匹配）");

  // ---------- C codex 认配置优先铁律 ----------
  console.log("C codex 认配置优先（中转不误报）：");
  const codexMarker = join(DATA, "codex.marker");
  process.env.CCR_CODEX_PATH = mkStub("codex-liar", `#!/bin/sh\ntouch "${codexMarker}"\necho "Not logged in"\n`);
  process.env.OPENAI_API_KEY = "sk-test-stub";
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  await wait(200);
  const cx = engineCatalogSummary("").find((e) => e.id === "codex");
  ok(cx?.state === "ready", `C1 OPENAI_API_KEY 在场恒 ready（实 ${cx?.state}——中转用户 login status 恒 Not logged in 但可跑）`);
  ok(!existsSync(codexMarker), "C2 认配置在场零 spawn（codex 桩未被拉起）");
  delete process.env.OPENAI_API_KEY;
  rmSync(codexMarker, { force: true });

  // ---------- D 暖读非阻塞（stale-while-revalidate 间接形态） ----------
  console.log("D 暖读非阻塞（暖读恒亚秒）：");
  rmSync(marker, { force: true });
  process.env.CCR_CODEBUDDY_PATH = slowStub;
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  await wait(600); // needs_auth 桩已被换慢桩——先种缓存
  // 已知测试局限（P3② 如实化）：「过期先回陈值」本体未直测——TTL 是模块私有常量
  // （45s）无注入缝，真等不现实；本档锁的是可观测间接形态：任何缓存态（含回填/
  // 陈值路径）暖读恒亚秒不阻塞热路径。注入缝随其他工作落地时顺手补真断言。
  const t1 = Date.now();
  const cat2 = engineCatalogSummary("");
  const elapsed2 = Date.now() - t1;
  ok(elapsed2 < 500 && cat2.find((e) => e.id === "codebuddy") !== undefined, `D1 暖读恒亚秒（实 ${elapsed2}ms，缓存值/回填值均不阻塞热路径）`);

  // ---------- E 同步口语义原样 ----------
  console.log("E 同步口 probeEngineAuth 不受波及：");
  const direct = eng.probeEngineAuth("codebuddy", { timeoutMs: 1500 });
  ok(direct.state === "ready", `E1 带 opts 直探旁路仍 fail-open（慢桩超时→ready，实 ${direct.state}）`);
  eng.resetEngineAuthCache();
  const t2 = Date.now();
  const syncProbe = eng.probeEngineAuth("codebuddy"); // 无 opts=生产同步口（命令处置路径语义保持）
  const syncElapsed = Date.now() - t2;
  ok(syncElapsed >= 1400 && syncProbe.state === "ready", `E2 无 opts 同步口仍真探（慢桩 ${syncElapsed}ms≥桩时延——命令路径权威值语义原样）`);

  rmSync(DATA, { recursive: true, force: true });
  console.log(`\nengwarm: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
