// #125/#137 验收单模块测试（纯单元，不起服务）：saveResult 落盘留痕 +
// listAcceptances 待填态汇总（无 results=待填、部分已判=待填、全覆盖=done、
// 排序新的在前、上限截断）。CCR_ACCEPTANCE_DIR 隔离测试目录。
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadAcceptance, saveResult, listAcceptances, ACCEPTANCE_ID_RE } from "../src/acceptance.js";

const ROOT = fileURLToPath(new URL("../data/test-acceptance/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_ACCEPTANCE_DIR = ROOT;

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// 空目录：汇总为空数组（不炸——生产常态）
assert(listAcceptances().length === 0, "空目录汇总=[]");

// 登记三张单（手工写文件，同 bin/acceptance 工具产物结构）
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ task: `#t${i}`, item: `项${i}`, criteria: `标准${i}` }));
const mk = (id: string, title: string, at: number, n: number) =>
  writeFileSync(join(ROOT, `${id}.json`), JSON.stringify({ id, title, created_at: at, rows: rows(n) }));
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
mk(A, "单A旧", 1000, 3);
mk(B, "单B新", 2000, 2);
mk(C, "单C最新", 3000, 4);
// 非法名文件混入：不进汇总
writeFileSync(join(ROOT, "zz-not-an-id.json"), "{}");

let l = listAcceptances();
assert(l.length === 3, "3 张单全扫到（非法名滤除）");
assert(l.map((x) => x.id).join(",") === [C, B, A].join(","), "新的在前排序");
assert(l[0].total === 4 && l[0].judged === 0 && l[0].done === false, "无 results=0 判待填");

// B 部分已判（1/2）：待填
assert(saveResult(B, { rows: [{ i: 0, verdict: "pass", note: "" }] }, "test-ua") === null, "saveResult 落盘成功");
l = listAcceptances();
const b = l.find((x) => x.id === B)!;
assert(b.judged === 1 && b.done === false, "部分已判=待填");

// B 补齐第二行（history 第二次提交全覆盖）：done 翻真——以最新一次提交为准
saveResult(B, { rows: [{ i: 0, verdict: "pass", note: "" }, { i: 1, verdict: "fail", note: "有问题" }] }, "test-ua");
l = listAcceptances();
assert(l.find((x) => x.id === B)!.done === true, "最新提交全覆盖=done");

// C 提交含 null（未测行）：judged 只计 pass/fail
saveResult(C, { rows: [{ i: 0, verdict: null, note: "" }, { i: 1, verdict: "pass", note: "" }, { i: 2, verdict: "pass", note: "" }, { i: 3, verdict: "pass", note: "" }] }, "ua");
assert(listAcceptances().find((x) => x.id === C)!.judged === 3, "null 行不计入已判");

// 上限截断：limit=2 只留最新两张
assert(listAcceptances(2).map((x) => x.id).join(",") === [C, B].join(","), "limit 截断留最新");

// loadAcceptance 白名单：id 格式校验
assert(loadAcceptance("nothex") === null, "非法 id 拒载");
assert(ACCEPTANCE_ID_RE.test(A), "32hex 格式正则");

// 脏 results（坏 JSON）：单本身仍在、状态回落待填
writeFileSync(join(ROOT, `${A}.results.json`), "{broken");
l = listAcceptances();
assert(l.find((x) => x.id === A)!.judged === 0, "坏 results 回落待填不炸");

// ---- #138 回填回流：cwd→会话归因（matchSessionByCwd）----
// 独立数据目录隔离（SessionManager 构造/journal 不碰生产 ~/.cc-deck/data）
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
process.env.CCR_DATA_DIR = join(ROOT, "sm-data");
process.env.CCR_TOKEN = "test-token";
{
  const mgr = new SessionManager(new EventBus(), loadConfig());
  const W = "/virtual/work";
  const s1 = mgr.ensureExternal("sid-one", W, "会话一");
  mgr.ensureExternal("sid-two", "/virtual/other", "会话二");
  assert(mgr.matchSessionByCwd(W) === "sid-one", "cwd 精确命中");
  assert(mgr.matchSessionByCwd(W + "/sub/dir") === "sid-one", "出单 cwd 在会话子目录=命中");
  assert(mgr.matchSessionByCwd("/virtual") === "sid-one", "出单 cwd 比会话浅（反向前缀）=命中");
  assert(mgr.matchSessionByCwd("/nowhere/else") === null, "无关 cwd=null（relay 侧静默跳过）");
  // 同族多会话：updated_at 新鲜度决胜（deliverByCwd 同款语义）
  (s1 as unknown as { updated_at: number }).updated_at = Date.now() + 5000;
  assert(mgr.matchSessionByCwd("/virtual") === "sid-one", " bumped 更新时间者胜");
  (s1 as unknown as { updated_at: number }).updated_at = 1;
  assert(mgr.matchSessionByCwd("/virtual/work") === "sid-one", "唯一精确命中不受新鲜度影响");
  // 空 cwd 会话不参与匹配（原 "" + sep 前缀匹配一切的误归因修复）
  const s3 = mgr.ensureExternal("sid-empty", "/virtual/third", "会话三");
  (s3 as unknown as { cwd: string; updated_at: number }).cwd = "";
  (s3 as unknown as { updated_at: number }).updated_at = Date.now() + 9999;
  assert(mgr.matchSessionByCwd("/virtual/work") === "sid-one", "空 cwd 会话不劫持匹配");
  // #203 符号链接归一：会话登记物理路径、查询走逻辑路径（macOS /tmp vs
  // /private/tmp 实锤形态）——两边 realpath 归一后前缀匹配应命中。查询路径
  // 物理存在（生产链路 deliver 传的是 Bash cwd，必然存在；realpathSync 对
  // 缺失尾段会 throw 回落 resolve 值，那是另一条路径，不在本用例口径）
  const realDir = join(ROOT, "sl-real");
  mkdirSync(join(realDir, "sub"), { recursive: true });
  const linkDir = join(ROOT, "sl-link");
  try { symlinkSync(realDir, linkDir); } catch { /* 重跑残留 */ }
  mgr.ensureExternal("sid-sym", realDir, "符号链接会话");
  assert(mgr.matchSessionByCwd(linkDir + "/sub") === "sid-sym", "查询路径过符号链接=realpath 归一命中");
  assert(mgr.matchSessionByCwd(linkDir) === "sid-sym", "符号链接精确路径同样命中");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fail === 0 ? `\nACCEPTANCE TESTS PASSED (${pass})` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
