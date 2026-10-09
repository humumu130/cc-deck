// W-ORPH 孤儿会话输出物与引导（2026-10-09）：无插件机器（公司机器实锤形态）上
// ①孤儿卡接入文案按插件在场分叉（未装→安装指引 + deliver 点名；装了→老重启口径）
// ②deliver 登记按 CLI sid / cwd 归因到孤儿卡（ext- 前缀 + relay_session_id 反查 +
// cwd 启发式三路全验）③登记跨重启回放 ④孤儿会话中途写产物目录即时上板（增量批
// 次不再只有 firstRead）⑤deliver 脚本兜底落位（缺失创建/在场不碰/模板与插件 bin
// 逐字节同源）。
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge, deckHooksInstalled } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { validateDeliverablePath } from "../src/artifacts.js";
import { DELIVER_BIN_TEMPLATE, ensureDeliverBin } from "../src/deliver-bin.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

// 沙盒铁律（test-bridge 同款）：数据/扫描根/claude 配置/产物目录全钉 mkdtemp，
// 不碰真实 ~/.cc-deck 与 ~/.claude
const TDATA = mkdtempSync(join(tmpdir(), "worph-data-"));
const PROOT = mkdtempSync(join(tmpdir(), "worph-proot-"));
const CCFG = mkdtempSync(join(tmpdir(), "worph-ccfg-"));
const ARTD = mkdtempSync(join(tmpdir(), "worph-artifacts-"));
process.env.CCR_DATA_DIR = TDATA;
process.env.CCR_PROJECTS_ROOT = PROOT;
process.env.CLAUDE_CONFIG_DIR = CCFG;
process.env.CCR_ARTIFACTS_DIR = ARTD;
process.env.CCR_NO_LEADER = "1";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_DELIVER_BIN_DIR = join(TDATA, "bin", "deliver");

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const bridge = new Bridge(bus, mgr, { gateTools: new Set(), hasClients: () => false, dataDir: cfg.dataDir });
const scan = () => (bridge as unknown as { adoptOrphans(): void }).adoptOrphans();
const feed = (id: string, p: string) =>
  (bridge as unknown as { pushAssistantTexts(id: string, p?: string): void }).pushAssistantTexts(id, p);
const ago = (f: string, ms: number) => utimesSync(f, new Date(Date.now() - ms), new Date(Date.now() - ms));

function writeTranscript(sid: string, cwd: string, lines: unknown[]): string {
  const dir = join(PROOT, "p-" + sid.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, sid + ".jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  ago(f, 60_000);
  return f;
}

// ---------- 1. deliver 脚本兜底落位 ----------
{
  assert(ensureDeliverBin() === "written", "1 deliver bin 落位（缺失时创建）");
  const st = statSync(process.env.CCR_DELIVER_BIN_DIR);
  assert(st.isFile() && (st.mode & 0o111) !== 0, "1 deliver bin 可执行位");
  assert(readFileSync(process.env.CCR_DELIVER_BIN_DIR, "utf-8").startsWith("#!/bin/bash"), "1 deliver bin shebang");
  assert(ensureDeliverBin() === "exists", "1 deliver bin 幂等（同模板 → exists）");
  writeFileSync(process.env.CCR_DELIVER_BIN_DIR, "#!/bin/sh\n# 用户自改/插件新版\n", "utf-8");
  assert(ensureDeliverBin() === "foreign", "1 deliver bin 不覆盖已有内容（foreign）");
  assert(readFileSync(process.env.CCR_DELIVER_BIN_DIR, "utf-8").startsWith("#!/bin/sh"), "1 deliver bin 用户内容原样保留");
  // 模板与插件 bin 逐字节同源（防两份漂移；改任一侧必须同步另一侧）
  const pluginBin = fileURLToPath(new URL("../../cc-plugins/plugins/cc-deck/bin/deliver", import.meta.url));
  assert(readFileSync(pluginBin, "utf-8") === DELIVER_BIN_TEMPLATE, "1 模板与 cc-plugins bin/deliver 逐字节同源");
}

// ---------- 2. 孤儿接入：无插件 → 安装指引文案 ----------
assert(!deckHooksInstalled(), "2 沙盒无插件：deckHooksInstalled=false");
const sidA = "1a2b3c4d-0000-4000-8000-aaaaaaaaaaaa";
const cwdA = join(TDATA, "proj-a");
mkdirSync(cwdA, { recursive: true });
writeTranscript(sidA, cwdA, [
  { type: "user", cwd: cwdA, message: { role: "user", content: "写个报告" } },
  { type: "user", cwd: cwdA, message: { role: "user", content: "第二回合" } },
]);
scan();
const extA = "ext-" + sidA;
assert(!!mgr.getExternal(extA), "2 孤儿收养建卡");
{
  const logs = mgr.getExternalLogs(extA).map((l) => l.text).join("\n");
  assert(logs.includes("尚未安装 CC Deck 接入插件"), "2 无插件文案：点名未装插件");
  assert(logs.includes("claude plugin install cc-deck@cc-deck-plugins"), "2 无插件文案：含安装指引");
  assert(logs.includes("deliver"), "2 无插件文案：点名输出物通道不受影响");
  assert(!logs.includes("重启该 CLI 后获得完整功能"), "2 无插件文案：不再误导重启");
}

// ---------- 3. deliver 精确归因（CLI 原生 sid，deliver 脚本 env 链形态） ----------
const fileA = join(cwdA, "docs", "报告.html");
mkdirSync(join(cwdA, "docs"), { recursive: true });
writeFileSync(fileA, "<html>报告</html>", "utf-8");
{
  const v = validateDeliverablePath(fileA);
  assert(v.ok, "3 交付物校验通过");
  const r = mgr.deliverBySession(sidA, cwdA, v.path, v);
  assert(r.ok && r.session_id === extA, `3 deliver CLI sid 归因到孤儿卡（got ${r.session_id ?? r.error}）`);
  const arts = mgr.getExternal(extA)?.artifacts ?? [];
  assert(arts.some((a) => a.path === fileA), "3 孤儿卡输出物视图含登记条目");
  assert(arts.some((a) => a.path === fileA && a.tools.includes("登记")), "3 登记条目 tools 记「登记」");
}

// ---------- 4. cwd 启发式归因 + 双孤儿不串卡 ----------
const sidB = "1a2b3c4d-0000-4000-8000-bbbbbbbbbbbb";
const cwdB = join(TDATA, "proj-b");
mkdirSync(cwdB, { recursive: true });
writeTranscript(sidB, cwdB, [
  { type: "user", cwd: cwdB, message: { role: "user", content: "另一个项目" } },
  { type: "user", cwd: cwdB, message: { role: "user", content: "第二回合" } },
]);
scan();
const extB = "ext-" + sidB;
assert(!!mgr.getExternal(extB), "4 第二个孤儿收养");
const fileB = join(cwdB, "周报.md");
writeFileSync(fileB, "# 周报", "utf-8");
{
  const v = validateDeliverablePath(fileB);
  const r = mgr.deliverByCwd(cwdB, v.path, v);
  assert(r.ok && r.session_id === extB, `4 cwd 归因命中正确孤儿卡（got ${r.session_id ?? r.error}）`);
  assert((mgr.getExternal(extA)?.artifacts ?? []).every((a) => a.path !== fileB), "4 卡 A 不串入卡 B 的登记");
}

// ---------- 5. 登记跨重启回放（deliverables.json → applyDeclaredDeliverables） ----------
{
  const mgr2 = new SessionManager(new EventBus(), cfg);
  mgr2.ensureExternal(extA, cwdA, "", sidA, 0);
  const arts = mgr2.getExternal(extA)?.artifacts ?? [];
  assert(arts.some((a) => a.path === fileA), "5 重启后登记条目挂回孤儿卡");
}

// ---------- 6. 插件在场 → 老口径（重启获得完整功能） ----------
{
  mkdirSync(join(CCFG, "plugins"), { recursive: true });
  writeFileSync(
    join(CCFG, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "cc-deck@cc-deck-plugins": [{ scope: "user" }] } }),
    "utf-8",
  );
  assert(deckHooksInstalled(), "6 installed_plugins 含 cc-deck@ → 检测为在场");
  const sidC = "1a2b3c4d-0000-4000-8000-cccccccccccc";
  const cwdC = join(TDATA, "proj-c");
  mkdirSync(cwdC, { recursive: true });
  writeTranscript(sidC, cwdC, [
    { type: "user", cwd: cwdC, message: { role: "user", content: "插件已装但 CLI 早于插件" } },
    { type: "user", cwd: cwdC, message: { role: "user", content: "第二回合" } },
  ]);
  scan();
  const logs = mgr.getExternalLogs("ext-" + sidC).map((l) => l.text).join("\n");
  assert(logs.includes("重启该 CLI 后获得完整功能"), "6 插件在场：恢复老口径（重启获全功能）");
  assert(!logs.includes("尚未安装 CC Deck 接入插件"), "6 插件在场：不再出安装指引");
}

// ---------- 7. 孤儿会话中途写产物目录 → 增量批次即时上板 ----------
{
  const artFile = join(ARTD, "ui-review.html");
  const projFile = join(cwdA, "docs", "过程笔记.md");
  writeFileSync(artFile, "<html>汇总</html>", "utf-8");
  const tf = join(PROOT, "p-" + sidA.slice(0, 8), sidA + ".jsonl");
  // 先吃掉 firstRead（收养后首轮轮询语义）
  feed(extA, tf);
  appendFileSync(
    tf,
    JSON.stringify({
      type: "assistant",
      cwd: cwdA,
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Write", input: { file_path: artFile } }] },
    }) + "\n" +
    JSON.stringify({
      type: "user",
      cwd: cwdA,
      tool_use_result: { type: "create", content: "<html>汇总</html>" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "File created successfully" }] },
    }) + "\n" +
    JSON.stringify({
      type: "assistant",
      cwd: cwdA,
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu-2", name: "Write", input: { file_path: projFile } }] },
    }) + "\n",
    "utf-8",
  );
  feed(extA, tf); // 增量批次：无 hook，靠 W-ORPH A3 触发回放
  const arts = mgr.getExternal(extA)?.artifacts ?? [];
  assert(arts.some((a) => a.path === artFile), "7 产物目录写入即时上板（增量批次）");
  assert(arts.every((a) => a.path !== projFile), "7 项目目录写入不进自动采集（意图声明制不变）");
}

// ---------- 8. 归因三查之 relay_session_id 反查（findByCliSid 路径） ----------
{
  // 裸 UUID 老卡形态：卡 id 无 ext- 前缀推导关系，锚点只有 relay_session_id
  const sidD = "1a2b3c4d-0000-4000-8000-dddddddddddd";
  const cardId = "legacy-card-0001";
  mkdirSync(join(TDATA, "proj-d"), { recursive: true });
  mgr.ensureExternal(cardId, join(TDATA, "proj-d"), "", sidD, 0);
  const fileD = join(TDATA, "proj-d", "交付.txt");
  writeFileSync(fileD, "x", "utf-8");
  const v = validateDeliverablePath(fileD);
  const r = mgr.deliverBySession(sidD, join(TDATA, "proj-d"), v.path, v);
  assert(r.ok && r.session_id === cardId, `8 relay_session_id 反查归因（got ${r.session_id ?? r.error}）`);
}

console.log("\nW-ORPH test-orphan-deliver 全绿");
process.exit(0);
