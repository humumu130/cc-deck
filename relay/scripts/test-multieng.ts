// #219（W-MULTIENG，2026-10-23）多引擎适配三件测试：
//   件① buildOrgDisciplineBlock per-engine 组织纪律引导段（claude=null 不重复注入/
//        非 claude=块内容锚点）+ wrapDispatchPrompt 第六参 orgBlock 前缀渲染 + 五参
//        兼容（无 orgBlock 输出与旧签名逐字节一致）；
//   件② title-codex 纯函数面（session_index.jsonl 单行宽松解析/按 thread_id 查
//        thread_name/同 id 取文件序最后/缺文件与畸形行静默 null/120 截断）；
//   件③ 回执契约核对的静态锚（SESSION_DONE 契约=派单纪律 prompt 行在所有引擎
//        prompt 通路共用——wrapDispatchPrompt 输出含完成回执行，引擎无关）。
// 隔离口径：纯函数+tmpdir，零 spawn 零生产触碰。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrgDisciplineBlock, wrapDispatchPrompt } from "../src/session-manager.js";
import { parseCodexSessionIndexLine, readCodexThreadName } from "../src/title-codex.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
};

// ---------- 件① buildOrgDisciplineBlock ----------
console.log("\n[件①] buildOrgDisciplineBlock per-engine 引导段");
ok(buildOrgDisciplineBlock("claude") === null, "claude → null（CLAUDE.md 全量版在场，不重复注入）");
ok(buildOrgDisciplineBlock(undefined) === null, "undefined → null（缺省 claude 同口径）");
ok(buildOrgDisciplineBlock(null) === null, "null → null");
for (const eng of ["codex", "trae", "qwen-code", "codebuddy", "zcode"]) {
  ok(buildOrgDisciplineBlock(eng) !== null, `${eng} → 非 null（无 CLAUDE.md 通路，prompt 前缀注入）`);
}
const blk = buildOrgDisciplineBlock("codex") ?? "";
ok(blk.includes("组织纪律引导"), "块含定性头行（组织纪律引导）");
ok(blk.includes("worktree"), "块含 worktree 隔离纪律");
ok(blk.includes("<type>/<英文短横线slug>"), "块含分支命名规范");
ok(blk.includes("squash"), "块含 squash 收口纪律");
ok(blk.includes("已 push 的历史禁止重写"), "块含不重写历史红线");
ok(blk.includes("自测"), "块含自测三口径纪律");
ok(blk.includes("CLAUDE.md") && blk.includes("权威正本"), "块含正本指针行（引导段不替代正本）");
ok(blk.includes("派单纪律恒优先"), "块含与派单纪律的优先级声明");
ok(!blk.includes("results:") && blk.split("\n").length <= 10, `块行数精简（${blk.split("\n").length} 行 ≤10）`);

// ---------- 件① wrapDispatchPrompt 第六参 ----------
console.log("\n[件①] wrapDispatchPrompt orgBlock 前缀渲染与五参兼容");
const base5 = wrapDispatchPrompt("正经立项", "任务正文");
const withOrg = wrapDispatchPrompt("正经立项", "任务正文", undefined, undefined, undefined, blk);
ok(withOrg.startsWith(blk + "\n[正经立项 派单]"), "orgBlock 渲染在最前（prompt 前缀位，先于 [tier 派单] 头）");
ok(withOrg.includes(base5), "追加 orgBlock 后旧输出完整保留（谱系序不破坏）");
ok(wrapDispatchPrompt("正经立项", "任务正文") === base5, "六参缺省 = 五参调用输出逐字节一致（既有调用零波及）");
ok(base5.includes("完成回执：最后一行固定格式"), "[件③] 完成回执契约行在 prompt 模板（引擎无关通路）");
ok(base5.includes("过程不回灌，只收回执"), "[件③] 派单纪律段在 prompt 模板（非 claude 引擎唯一到达通道）");

// ---------- 件② title-codex 纯函数面 ----------
console.log("\n[件②] parseCodexSessionIndexLine 单行宽松解析");
ok(
  parseCodexSessionIndexLine(`{"id":"tid-1","thread_name":"修登录页","updated_at":"2026-10-23T00:00:00Z"}`)?.id === "tid-1" &&
    parseCodexSessionIndexLine(`{"id":"tid-1","thread_name":" 修登录页 ","updated_at":"x"}`)?.thread_name === "修登录页",
  "合法行解析 + thread_name trim",
);
ok(parseCodexSessionIndexLine(`{"id":"tid-2"}`) === null, "缺 thread_name → null");
ok(parseCodexSessionIndexLine(`{"thread_name":"无名"}`) === null, "缺 id → null");
ok(parseCodexSessionIndexLine(`{"id":"","thread_name":"x"}`) === null, "空 id → null");
ok(parseCodexSessionIndexLine(`{"id":"t","thread_name":"  "}`) === null, "空白 thread_name → null");
ok(parseCodexSessionIndexLine("not-json") === null, "畸形 JSON → null（静默跳过口径）");

console.log("\n[件②] readCodexThreadName 按索引查名");
const home = mkdtempSync(join(tmpdir(), "codex-title-"));
const lines = [
  `{"id":"aaa","thread_name":"第一版名","updated_at":"1"}`,
  `{"id":"bbb","thread_name":"照片后期优化","updated_at":"2"}`,
  `{"id":"aaa","thread_name":"更新版名","updated_at":"3"}`,
  `garbage-line`,
  `{"id":"ccc","thread_name":""}`,
].join("\n");
writeFileSync(join(home, "session_index.jsonl"), lines, "utf-8");
ok(readCodexThreadName("bbb", home) === "照片后期优化", "按 thread_id 命中");
ok(readCodexThreadName("aaa", home) === "更新版名", "同 id 多条取文件序最后（最新口径）");
ok(readCodexThreadName("zzz", home) === null, "无命中 → null（回落档由调用方接）");
ok(readCodexThreadName("", home) === null, "空 threadId → null");
ok(readCodexThreadName("aaa", join(home, "不存在")) === null, "索引文件缺失 → null（该 codex 无索引，恒回落）");
const longName = "长".repeat(200);
writeFileSync(join(home, "session_index.jsonl"), `{"id":"long","thread_name":"${longName}"}`, "utf-8");
ok([...(readCodexThreadName("long", home) ?? "")].length === 120, "超长名截 120（会话标题口径）");
rmSync(home, { recursive: true, force: true });

// ---------- 收尾 ----------
console.log(`\n===== #219 W-MULTIENG 测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
