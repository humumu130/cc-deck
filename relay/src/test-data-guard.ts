// DL-P1-9（2026-11-27 夜间缺陷台账·测试隔离洞治根）：1122 夜生产库
// ~/.cc-deck/data/cc-deck.sqlite3 被多进程轮流「重灌」（INCIDENT-1122-prod-db-pollution：
// 约 200 个套件没钉读档、其中 60+ 会构造 SessionManager 或写 org 台账）。事故后承诺的
// 「fail-fast 硬闸」未落——本件就是那道闸。
//
// 判定（四条件同时成立即抛错拒跑）：
//   ① 测试语境：主入口脚本名匹配 test-*（relay/scripts/test-*.ts 直跑、tsx/CI 同判）
//      ——生产 relay 入口是 src/index.ts，永不匹配；
//   ② 生产家在场：本机确有 ~/.cc-deck（CI runner 无生产安装→闸静默，未钉档套件
//      维持现状不红 CI；开发机有→闸生效）；
//   ③ 解析结果落在生产家：dataDir/orgDir 解析值位于 ~/.cc-deck 之下（CCR_DATA_DIR
//      显式指向生产、或 orgDir 无隔离时的缺省 ~/.cc-deck/org、或插件 bundle 缺省）；
//   ④ 未显式豁免：CCR_TEST_PROD_DATA_OK=1（只读诊断/迁移工具的声明门——bench-*/
//      probe-* 命名不匹配 ①，本就不需要豁免）。
//
// 沙盒缺省（resolveDataDir 的 cwd/data、mkdtemp 夹具）不在 ~/.cc-deck 下——零波及：
// 既有钉档测试全部照常。设计取舍：闸放在解析单点（config.resolveDataDir/org.orgDir），
// 不做测试文件逐个改造（296 个 scripts/test-*.ts 的机械翻新不减少任何风险面——
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

function insideProduction(dir: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const home = norm(productionHome());
  return (norm(dir) + "/").startsWith(home + "/") || norm(dir) === home;
}

/** 硬闸本体：测试语境 × 生产家在场 × 路径落生产家 × 未豁免 → 抛错（fail-fast，
 * 不带任何写动作）。what/resolved 仅用于报错定位（"dataDir"/"orgDir" + 解析值）。
 * 「生产家在场」条件（existsSync ~/.cc-deck）：CI runner 无生产安装——闸静默
 * （未钉档套件维持现状不红 CI）；开发机有生产安装——闸生效，未钉档即拒跑。 */
export function assertTestNotTouchingProd(what: string, resolved: string): void {
  if (process.env.CCR_TEST_PROD_DATA_OK === "1") return;
  if (!looksLikeTestRunner()) return;
  if (!existsSync(productionHome())) return;
  if (!insideProduction(resolved)) return;
  throw new Error(
    `[test-data-guard] 测试进程解析${what}到生产数据面：${resolved}——1122 生产库污染事故的复发通道，拒跑。` +
      `测试请钉 CCR_DATA_DIR/CCR_ORG_DIR 到沙盒（mkdtemp 或 scripts/test-lib.ts 的 pinSandbox）；确需读生产数据的诊断工具请改名非 test-* 前缀或显式 CCR_TEST_PROD_DATA_OK=1。`,
  );
}
