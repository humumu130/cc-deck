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
//   B 异步回填真值：needs_auth 桩输出 → 异步预热完成后暖读翻 needs_auth（带 hint）
//   C codex 认配置优先铁律不破：三源在场（OPENAI_API_KEY）→ 暖读恒 ready 零 spawn
//   D 陈值续供（stale-while-revalidate）：缓存过期后暖读先回陈值并异步续探（不阻塞）
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
  await wait(5300);

  // ---------- B 异步回填真值 ----------
  console.log("B 异步回填真值（needs_auth 桩）：");
  rmSync(marker, { force: true });
  process.env.CCR_CODEBUDDY_PATH = needsAuthStub;
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  await wait(600);
  ok(existsSync(marker), "B1 异步预热确实拉起桩（marker 在场）");
  const after = engineCatalogSummary("").find((e) => e.id === "codebuddy");
  ok(after?.state === "needs_auth" && !!after?.auth_hint, `B2 回填后暖读翻 needs_auth 带 hint（实 ${after?.state}/${!!after?.auth_hint}）`);

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

  // ---------- D 陈值续供（stale-while-revalidate） ----------
  console.log("D 陈值续供（过期先回陈值异步续探）：");
  rmSync(marker, { force: true });
  process.env.CCR_CODEBUDDY_PATH = slowStub;
  eng.resetEngineAuthCache();
  eng.warmEngineAuthCacheAsync();
  await wait(600); // needs_auth 桩已被换慢桩——先种缓存
  // 手工把缓存时钟拨过期（模块私有 TTL 45s——用 resetEngineAuthCache+直接二段模拟：
  // 种新值后立即暖读必命中；此处锁「过期判定走异步不阻塞」的间接形态：暖读始终亚秒）
  const t1 = Date.now();
  const cat2 = engineCatalogSummary("");
  const elapsed2 = Date.now() - t1;
  ok(elapsed2 < 500 && cat2.find((e) => e.id === "codebuddy") !== undefined, `D1 暖读恒亚秒（实 ${elapsed2}ms，陈值/回填值均不阻塞热路径）`);

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
