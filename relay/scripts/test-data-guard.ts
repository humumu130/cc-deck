// DL-P1-9 测试隔离硬闸专项（2026-11-27 夜间缺陷台账）：1122 夜生产库
// ~/.cc-deck/data/cc-deck.sqlite3 被多进程轮流重灌（约 200 套件没钉读档、60+ 构造
// SessionManager/写 org 台账）——事故承诺的 fail-fast 硬闸本件落地并断言。
// 判定要素：①test-* 主入口 ②生产家 ~/.cc-deck 在场 ③解析值落生产家 ④未豁免。
// 本机（开发机，有生产安装）跑即真闸；CI（无生产安装）自动静默——断言用注入的
// 假 homedir 边界（guard 的 productionHome 只进 assert 的字符串比对，测试里直调
// 纯函数+临时 argv/豁免变量构造四条件，不真写生产）。
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeTestRunner, productionHome, productionDataPresent, assertTestNotTouchingProd } from "../src/test-data-guard.js";
import { pinSandbox } from "./test-lib.js";

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };
const throws = (fn: () => void): boolean => { try { fn(); return false; } catch { return true; } };

const ROOT = pinSandbox("data-guard");

// ---------- ① 测试语境判定 ----------
{
  const realArgv1 = process.argv[1];
  assert(looksLikeTestRunner() === true, "① 本文件（test-data-guard.ts）自身匹配测试语境");
  process.argv[1] = "/x/y/src/index.ts";
  assert(looksLikeTestRunner() === false, "① 生产入口 src/index.ts 不匹配");
  process.argv[1] = "/x/y/scripts/bench-read-mode.ts";
  assert(looksLikeTestRunner() === false, "① bench-*/probe-* 诊断工具不匹配（读生产合法，无需豁免）");
  process.argv[1] = "/x/y/scripts/test-foo.mjs";
  assert(looksLikeTestRunner() === true, "① mjs/js 形态同判");
  process.argv[1] = realArgv1;
}

// ---------- ② 沙盒路径零波及（钉档测试照常） ----------
{
  assert(!throws(() => assertTestNotTouchingProd("dataDir", join(ROOT, "data"))), "② 沙盒 dataDir 不拦（钉档测试零波及）");
  assert(!throws(() => assertTestNotTouchingProd("orgDir", "/private/tmp/anything-org")), "② 任意非生产家路径不拦");
}

// ---------- ③ 生产家路径拦截（本机有生产数据时真闸；CI 形态字符串面构造） ----------
{
  // ③a P1-1 返修根修判据直测：productionDataPresent(home 参数化)——空壳家（CI 被
  // 测代码自 mkdir 的形态）不算生产数据，真记账承载物才算
  {
    const fake = mkdtempSync(join(tmpdir(), "dg-fakehome-"));
    assert(productionDataPresent(fake) === false, "③a① 空壳家（连目录都没有）不算生产数据");
    mkdirSync(join(fake, "org"), { recursive: true });
    assert(productionDataPresent(fake) === false, "③a② 空org目录（ensureOrgDir 自 mkdir 形态）不算");
    writeFileSync(join(fake, "org", "CLAUDE.md"), "seed");
    assert(productionDataPresent(fake) === false, "③a③ CLAUDE.md 种子（ensureOrgClaudeMd 形态）不算——CI 误杀根因排除");
    writeFileSync(join(fake, "org", "dispatch-log.ndjson"), "{}");
    assert(productionDataPresent(fake) === true, "③a④ org 记账文件在（台账）算生产数据");
    rmSync(join(fake, "org", "dispatch-log.ndjson"));
    mkdirSync(join(fake, "data"), { recursive: true });
    assert(productionDataPresent(fake) === false, "③a⑤ 空data目录不算");
    writeFileSync(join(fake, "data", "cc-deck.sqlite3"), "");
    assert(productionDataPresent(fake) === true, "③a⑥ 生产 sqlite 库在算（1122 污染面）");
    rmSync(fake, { recursive: true, force: true });
  }
  const prodHasData = productionDataPresent();
  const prodData = join(productionHome(), "data");
  if (prodHasData) {
    assert(throws(() => assertTestNotTouchingProd("dataDir", prodData)), "③b 测试语境解析生产 dataDir → 抛错拒跑（本机生产数据在场的真闸）");
    assert(throws(() => assertTestNotTouchingProd("orgDir", join(productionHome(), "org"))), "③b 生产 orgDir 同拦（台账/板文件污染面）");
    const err = (() => { try { assertTestNotTouchingProd("dataDir", prodData); return null; } catch (e) { return e as Error; } })();
    assert(!!err && err.message.includes("1122") && err.message.includes("CCR_DATA_DIR"), "③b 报错带事故锚+整改指引（可排障不猜谜）");
  } else {
    // CI 形态：无真实生产数据——闸静默（未钉档套件维持现状，CI 不红）
    assert(!throws(() => assertTestNotTouchingProd("dataDir", prodData)), "③b 生产数据不在场（CI/空壳家）静默——不误伤");
  }
  assert(prodHasData === productionDataPresent(join(homedir(), ".cc-deck")), "③b 判定与真实 homedir 一致（无注入漂移）");
}

// ---------- ④ 豁免门 ----------
{
  const prodData = join(productionHome(), "data");
  process.env.CCR_TEST_PROD_DATA_OK = "1";
  const waived = !throws(() => assertTestNotTouchingProd("dataDir", prodData));
  delete process.env.CCR_TEST_PROD_DATA_OK;
  assert(waived, "④ CCR_TEST_PROD_DATA_OK=1 显式豁免（只读诊断声明门）");
}

// ---------- ⑤ 接线源码锚（解析单点两处挂闸） ----------
{
  const cfg = (await import("node:fs")).readFileSync(join(process.cwd(), "src", "config.ts"), "utf8");
  assert(cfg.includes('assertTestNotTouchingProd("dataDir", d)'), "⑤ resolveDataDir 挂闸（data 面）");
  const org = (await import("node:fs")).readFileSync(join(process.cwd(), "src", "org.ts"), "utf8");
  assert(org.includes('assertTestNotTouchingProd("orgDir", prod)'), "⑤ orgDir 缺省分支挂闸（org 面）");
  assert(org.includes('assertTestNotTouchingProd("orgDir", process.env.CCR_ORG_DIR)'), "⑤ 显式 CCR_ORG_DIR 指生产同样拦");
}

// ---------- ⑥ pinSandbox 标准入口 ----------
{
  assert(existsSync(join(ROOT, "data")) && existsSync(join(ROOT, "org")), "⑥ pinSandbox 建 data/org 双沙盒目录");
  assert(process.env.CCR_DATA_DIR === join(ROOT, "data") && process.env.CCR_ORG_DIR === join(ROOT, "org"), "⑥ 双变量钉档到位");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n== test-data-guard 汇总：${pass} ok / ${fail} FAIL ==`);
if (fail > 0) process.exit(1);
void fileURLToPath; // 保留 import 占位（路径工具一致性）
