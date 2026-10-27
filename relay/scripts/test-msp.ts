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
// #286 审查 A/B-P1：cards.set 直播种（test-reclaim 先例）——mgr.create() 会真 spawn
// claude CLI（真进程+真计费+transcript 落生产 ~/.claude/projects 可被孤儿扫描收编成
// 幽灵卡，探针实锤 3 进程/跑）。快照归一断言只需 state 在册，不需要真会话
const seed = (id: string, engine: unknown) => {
  cards.set(id, { state: { session_id: id, engine, status: "DONE", title: id, updated_at: Date.now() } });
};

console.log("§R relay 行为面：");
// R1 snapshot 归一（undefined / 空串 / 显式引擎三态）
{
  // engine 缺席（create 条件展开不落键——生产 17/19 卡形态）
  seed("msp-r1-undefined", undefined);
  // 空串（历史帧可能带的形态）
  seed("msp-r1-empty", "");
  // 显式引擎
  seed("msp-r1-codex", "codex");
  const snap = mgr.snapshot();
  const c1 = snap.find((s) => s.session_id === "msp-r1-undefined");
  const c2 = snap.find((s) => s.session_id === "msp-r1-empty");
  const c3 = snap.find((s) => s.session_id === "msp-r1-codex");
  ok(c1?.engine === "claude", `R1a engine=undefined 下发归一 claude（实 ${c1?.engine}）`);
  ok(c2?.engine === "claude", `R1b engine="" 下发归一 claude（实 ${c2?.engine}）`);
  ok(c3?.engine === "codex", `R1c 显式引擎原样（实 ${c3?.engine}，非 claude 不动）`);
  ok((cards.get("msp-r1-undefined")!.state.engine as unknown) === undefined, "R1d 内存原样（归一只在下发面，内部判定零扰动）");
}

// R2 权限面 ??→||（A-P2③ 补真断言：判定行 :2366 与审计行 :2332 同口径——
// 审查 P1① 的回归锁。normalizeLegacyPermissionMode 走 bypass 分支的判定链）
{
  const smSrc = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
  // 判定行跨行（|| 与 "claude" 断行）——宽松锚：bypass 分支内的 engineCapabilityState 调用
  const cond = smSrc.match(/bypass_demoted"\)\s*\{[\s\S]{0,200}?engineCapabilityState\(s\.state\.engine(.{1,12}?)"claude"\)/);
  ok(!!cond && cond[1].trim() === "||", `R2 权限判定行空串兜底（实 ${cond ? JSON.stringify(cond[1]) : "未找到"}——与 :2332 审计行同口径）`);
}

console.log("§W web 前端面：");
{
  const src = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
  ok(/const engineKey = inferEngineOf\(session\) \|\| "claude";/.test(src), "W1 myCardItem engineKey 空值归一 claude（未知引擎不再折叠空 class——审查 B-P2① 修点）");
  ok(src.includes('(item.engine || "?").charAt(0).toUpperCase()'), "W1' PH 首字母占位链保持（真未知引擎仍占位，设计不变）");
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
