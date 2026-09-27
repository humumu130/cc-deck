// #212 允许并记住规则引擎测试（纯单元，不起服务）：isMemorable 危险判定（黑名单/
// 组合符/提问类）+ suggestPattern 建议（Bash 前缀/目录/工具级）+ AllowRuleStore
// 匹配/去重/删除/会话清扫/落盘回放。data/test-allow-rules/ 隔离测试目录。
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AllowRuleStore, isMemorable, suggestPattern } from "../src/allow-rules.js";

const ROOT = fileURLToPath(new URL("../data/test-allow-rules/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// ---------- isMemorable：危险形态不给记 ----------
assert(isMemorable("AskUserQuestion", { questions: [] }) === false, "AskUserQuestion 不可记");
assert(isMemorable("ExitPlanMode", { plan: "x" }) === false, "ExitPlanMode 不可记");
assert(isMemorable("Bash", { command: "git log --oneline" }) === true, "普通 git 命令可记");
assert(isMemorable("Bash", { command: "rm -rf /tmp/x" }) === false, "rm 黑名单不可记");
assert(isMemorable("Bash", { command: "sudo npm i" }) === false, "sudo 黑名单不可记");
assert(isMemorable("Bash", { command: "echo hi && rm x" }) === false, "组合符 & 不可记");
assert(isMemorable("Bash", { command: "cat a | grep b" }) === false, "管道 | 不可记");
assert(isMemorable("Bash", { command: "echo $(whoami)" }) === false, "命令替换 $() 不可记");
assert(isMemorable("Bash", { command: "  " }) === false, "空命令不可记");
assert(isMemorable("Edit", { file_path: "/a/b.ts" }) === true, "Edit 带路径可记");
assert(isMemorable("Edit", {}) === false, "Edit 无路径不可记");
assert(isMemorable("WebFetch", { url: "https://x" }) === true, "WebFetch 工具级可记");

// ---------- suggestPattern：建议规则 ----------
const s1 = suggestPattern("Bash", { command: "git log --oneline -5" });
assert(s1?.pattern === "git log", "Bash 建议取前 2 token（旗标滤除）");
assert(s1?.label.includes("git log"), "label 含命令前缀");
assert(suggestPattern("Bash", { command: "FOO=1 BAR=2 npm run build" })?.pattern === "npm run", "环境变量前缀剥掉");
assert(suggestPattern("Bash", { command: "rm -rf /" }) === null, "危险命令无建议");
assert(suggestPattern("Bash", { command: "echo a; echo b" }) === null, "组合命令无建议");
const s2 = suggestPattern("Edit", { file_path: "/Users/x/dev/cc-deck/relay/src/x.ts" });
assert(s2?.pattern === "/Users/x/dev/cc-deck/relay/src", "Edit 建议取目录");
assert(s2?.label.includes("文件编辑"), "Edit label 含「文件编辑」");
assert(suggestPattern("WebSearch", { query: "x" })?.pattern === "*", "其他工具工具级 *");
assert(suggestPattern("AskUserQuestion", { questions: [{}] }) === null, "提问类无建议");

// ---------- AllowRuleStore：匹配语义 ----------
const store = new AllowRuleStore(ROOT);
const SID = "sess-1", OTHER = "sess-2";

store.add("Bash", "git log", "global", undefined, "test");
assert(store.match(SID, "Bash", { command: "git log --oneline" }) !== null, "global 规则任意会话命中");
assert(store.match(SID, "Bash", { command: "git log" }) !== null, "旗标变化同构命中");
assert(store.match(SID, "Bash", { command: "FOO=1 git log -3" }) !== null, "环境变量前缀不影响命中");
assert(store.match(SID, "Bash", { command: "git push" }) === null, "git push 头 2 token 不同不命中");
assert(store.match(SID, "Bash", { command: "git status" }) === null, "第二 token 不同不命中");
assert(store.match(SID, "Bash", { command: "git log && rm -rf /" }) === null, "组合命令永不走记忆通道");
assert(store.match(SID, "Bash", { command: "rm -rf /" }) === null, "黑名单命令即使误存也不匹配");
assert(store.match(OTHER, "Bash", { command: "git log -1" }) !== null, "另一会话也命中 global");

store.add("Edit", "/Users/x/dev/proj", "session", SID, "test");
assert(store.match(SID, "Edit", { file_path: "/Users/x/dev/proj/a.ts" }) !== null, "session 规则本会话命中");
assert(store.match(SID, "Edit", { file_path: "/Users/x/dev/proj/sub/b.ts" }) !== null, "子目录递归命中");
assert(store.match(OTHER, "Edit", { file_path: "/Users/x/dev/proj/a.ts" }) === null, "session 规则会话隔离");
assert(store.match(SID, "Edit", { file_path: "/Users/x/dev/proj2/a.ts" }) === null, "前缀串目录不误命中（proj2≠proj）");

store.add("WebFetch", "*", "global", undefined, "test");
assert(store.match(SID, "WebFetch", { url: "https://any" }) !== null, "工具级 * 命中任意入参");

// ---------- 去重 / 删除 / 会话清扫 ----------
const before = store.list().length;
store.add("Bash", "git log", "global", undefined, "test-again");
assert(store.list().length === before, "同 scope+tool+pattern 去重不增条");
const rules = store.list();
const sidRules = rules.filter((r) => r.scope === "session" && r.session_id === SID);
assert(sidRules.length === 1, "session 规则登记 1 条");
store.dropSession(SID);
assert(store.list().every((r) => !(r.scope === "session" && r.session_id === SID)), "dropSession 清 session 级");
assert(store.list().some((r) => r.tool === "Bash"), "global 规则不受 dropSession 影响");
const someId = store.list()[0]!.id;
assert(store.remove(someId) === true, "删除存在的规则成功");
assert(store.remove(someId) === false, "重复删除返回 false");

// ---------- 落盘回放 ----------
const store2 = new AllowRuleStore(ROOT);
assert(store2.list().length === store.list().length, "重启回放条数一致");
assert(store2.match(SID, "Bash", { command: "git log -1" }) !== null, "回放后 global 规则仍命中");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
