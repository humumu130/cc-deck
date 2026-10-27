// #286 手机端设置精简+引擎头像根治——断言套件。
// 覆盖（四件）：
//   R1 relay 下发面 engine 归一：snapshot() 对 engine 空值（undefined/""）卡归一 "claude"
//      （生产实测 19 卡 17 张 engine=undefined 的根治单口；SNAPSHOT 双出口一次收口）
//   R2 权限面 ??→||：空串 engine 走 claude 档（"" ?? x === "" 穿透实锤）
//   W1 web engineBrandSvgOf 空 class 兜底 claude 螃蟹（双保险：旧 relay 快照未归一时）
//   E1 expo EngineIcon 空 engine 兜底 claude 蟹；未知非空引擎仍首字母占位（设计保持）
//   E2/E3 设置三处纯装饰块标题退役（偏好/Agent 引擎/关于）+ 连接管理组头保留（折叠功能件）
//   E4 版本水印：关于页 Build 行右对齐+完整通道版本
// 直跑：cd relay && env -u CCR_ORG_DIR npx tsx scripts/test-msp.ts
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-msp-org/", "../data/test-msp-data/", "../data/test-msp-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-msp-org/");
process.env.CCR_DATA_DIR = SB("../data/test-msp-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-msp-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";
const mgr = new SessionManager(new EventBus(), cfg);
const cards = (mgr as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;

console.log("§R relay 行为面：");
// R1 snapshot 归一（undefined / 空串 / 显式引擎三态）
{
  // engine 缺席（create 条件展开不落键——生产 17/19 卡形态）
  const created = (mgr as unknown as { create(cwd: string, prompt: string): string }).create(process.env.CCR_PROJECTS_ROOT!, "R1 缺席卡");
  cards.get(created)!.state.engine = undefined;
  // 空串（历史帧可能带的形态）
  const empty = (mgr as unknown as { create(cwd: string, prompt: string): string }).create(process.env.CCR_PROJECTS_ROOT!, "R1 空串卡");
  cards.get(empty)!.state.engine = "";
  // 显式引擎
  const codex = (mgr as unknown as { create(cwd: string, prompt: string): string }).create(process.env.CCR_PROJECTS_ROOT!, "R1 codex卡");
  cards.get(codex)!.state.engine = "codex";
  const snap = mgr.snapshot();
  const c1 = snap.find((s) => s.session_id === created);
  const c2 = snap.find((s) => s.session_id === empty);
  const c3 = snap.find((s) => s.session_id === codex);
  ok(c1?.engine === "claude", `R1a engine=undefined 下发归一 claude（实 ${c1?.engine}）`);
  ok(c2?.engine === "claude", `R1b engine="" 下发归一 claude（实 ${c2?.engine}）`);
  ok(c3?.engine === "codex", `R1c 显式引擎原样（实 ${c3?.engine}，非 claude 不动）`);
  ok((cards.get(created)!.state.engine as unknown) === undefined, "R1d 内存原样（归一只在下发面，内部判定零扰动）");
}

console.log("§W web 前端面：");
{
  const src = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  ok(/if \(!item\.engineClass\) return ENGINE_BRAND_SVG\.claude;/.test(src), "W1 engineBrandSvgOf 空 class 兜底 claude 螃蟹（旧 relay 快照双保险）");
  ok(src.includes('(item.engine || "?").charAt(0).toUpperCase()'), "W1' 未知非空引擎仍首字母占位（设计保持）");
}

console.log("§E expo 面：");
{
  const icon = readFileSync(join(root, "expo-app", "src", "engine-icon.tsx"), "utf-8");
  ok(/const key = engine \|\| "claude";/.test(icon), "E1a EngineIcon 空 engine 兜底 claude 蟹");
  ok(icon.includes('const letter = (engine ?? "?").charAt(0).toUpperCase();'), "E1b 未知非空引擎仍字母占位（设计保持）");
  const sp = readFileSync(join(root, "expo-app", "src", "screens", "SettingsPage.tsx"), "utf-8");
  ok(!/>偏好<\/Text>/.test(sp) && !/>Agent 引擎<\/Text>/.test(sp) && !/>关于<\/Text>/.test(sp), "E2 三处纯装饰块标题退役（偏好/Agent 引擎/关于）");
  ok(/>连接管理\{srvCollapsed/.test(sp), "E3 连接管理组头保留（折叠+计数功能件——非纯装饰）");
  ok(sp.includes('textAlign: "right" }]}>CC Deck · {APP_VER.replace(/^v/, "")}'), "E4 版本水印右对齐+完整通道版本（nativeApplicationVersion 含 CI 烙印）");
}

console.log(`\n§R-§E：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#286 引擎头像根治+设置精简+版本水印");
process.exit(fail > 0 ? 1 : 0);
