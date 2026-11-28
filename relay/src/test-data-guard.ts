// DL-P1-9（2026-11-27 夜间缺陷台账·测试隔离洞治根）：1122 夜生产库
// ~/.cc-deck/data/cc-deck.sqlite3 被多进程轮流「重灌」（INCIDENT-1122-prod-db-pollution：
// 约 200 个套件没钉读档、其中 60+ 会构造 SessionManager 或写 org 台账）。事故后承诺的
// 「fail-fast 硬闸」未落——本件就是那道闸。
//
// 判定（四条件同时成立即抛错拒跑）：
//   ① 测试语境：主入口脚本名匹配 test-*（relay/tests/test-*.ts 直跑、tsx/CI 同判）
//      ——生产 relay 入口是 src/index.ts，永不匹配；
//   ② 真实生产数据在场（P1-1 返修根修，2026-11-28）：生产家内存在**数据承载物**——
//      data/cc-deck.sqlite3、data/events.ndjson、org 记账文件（dispatch-log.ndjson/
//      org.json/projects.json/boards/等）。裸「目录存在」不行：CI runner 上被测代码会在
//      测试运行中把 ~/.cc-deck 自 mkdir 出来（ensureOrgDir org.ts 缺省创建点同族），
//      空壳家触发闸=误杀 test:boardv2（PR #162 CI 实锤）——空壳（空目录+CLAUDE.md 种子）
//      不是生产数据，不触发；
//   ③ 解析结果落在生产家：dataDir/orgDir 解析值位于 ~/.cc-deck 之下（CCR_DATA_DIR
//      显式指向生产、或 orgDir 无隔离时的缺省 ~/.cc-deck/org、或插件 bundle 缺省）；
//   ④ 未显式豁免：CCR_TEST_PROD_DATA_OK=1（只读诊断/迁移工具的声明门——bench-*/
//      probe-* 命名不匹配 ①，本就不需要豁免）。
//
// 沙盒缺省（resolveDataDir 的 cwd/data、mkdtemp 夹具）不在 ~/.cc-deck 下——零波及：
// 既有钉档测试全部照常。设计取舍：闸放在解析单点（config.resolveDataDir/org.orgDir），
// 不做测试文件逐个改造（296 个 tests/test-*.ts 的机械翻新不减少任何风险面——
// 单点闸一个不漏）。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 测试语境判定：主入口脚本名形如 test-*.ts|tsx|mjs|cjs|js（CI/本地直跑同判）。
 * 纯函数导出供测试直测。 */
export function looksLikeTestRunner(): boolean {
  const entry = process.argv[1] ?? "";
  const base = entry.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^test-[^/]+\.(ts|tsx|mjs|cjs|js)$/i.test(base);
}

/** 生产家边界：~/.cc-deck（数据面+org 面共用根）。 */
export function productionHome(): string {
  return join(homedir(), ".cc-deck");
}

/** org 面记账承载物清单：任一在场=真生产 org（台账/锚/项目表/板目录/值守/确认单）。
 * 刻意枚举而非「目录非空」——ensureOrgClaudeMd 的 CLAUDE.md 种子与被测代码 mkdir 的
 * 空壳不算生产数据（P1-1 返修：CI 自建家误杀根因）。 */
const ORG_DATA_MARKERS = [
  "dispatch-log.ndjson", // 派单台账（1122 污染面之一）
  "org.json",            // Leader 锚
  "projects.json",       // 项目/编制表
  "boards",              // 板文件目录
  "duty.json",           // 值守任命
  "confirms.json",       // 确认单
  "chain-audit.jsonl",   // 审计镜像
] as const;

/** 真实生产数据在场判定（P1-1 返修根修）：home 参数化供测试直测（缺省=真实生产家）。
 * 数据面 sqlite 库或 events 流在，或 org 面记账承载物任一在 → true；空壳家（被测
 * 代码 CI 上自 mkdir 的空目录/CLAUDE.md 种子）→ false。 */
export function productionDataPresent(home: string = productionHome()): boolean {
  try {
    if (existsSync(join(home, "data", "cc-deck.sqlite3"))) return true;
    if (existsSync(join(home, "data", "events.ndjson"))) return true;
    for (const m of ORG_DATA_MARKERS) {
      if (existsSync(join(home, "org", m))) return true;
    }
  } catch {
    return false; // 判定失败保守放行（闸静默——不拦沙盒是底线）
  }
  return false;
}

function insideProduction(dir: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const home = norm(productionHome());
  return (norm(dir) + "/").startsWith(home + "/") || norm(dir) === home;
}

/** 硬闸本体：测试语境 × 真实生产数据在场 × 路径落生产家 × 未豁免 → 抛错（fail-fast，
 * 不带任何写动作）。what/resolved 仅用于报错定位（"dataDir"/"orgDir" + 解析值）。
 * 「真实生产数据在场」条件（productionDataPresent）：开发机有生产安装——闸生效，
 * 未钉档即拒跑；CI 自建空壳家——闸静默（P1-1 返修：原裸 existsSync 误杀 boardv2）。 */
export function assertTestNotTouchingProd(what: string, resolved: string): void {
  if (process.env.CCR_TEST_PROD_DATA_OK === "1") return;
  if (!looksLikeTestRunner()) return;
  if (!productionDataPresent()) return;
  if (!insideProduction(resolved)) return;
  throw new Error(
    `[test-data-guard] 测试进程解析${what}到生产数据面：${resolved}——1122 生产库污染事故的复发通道，拒跑。` +
      `测试请钉 CCR_DATA_DIR/CCR_ORG_DIR 到沙盒（mkdtemp 或 tests/test-lib.ts 的 pinSandbox）；确需读生产数据的诊断工具请改名非 test-* 前缀或显式 CCR_TEST_PROD_DATA_OK=1。`,
  );
}
