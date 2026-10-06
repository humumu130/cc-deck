// #018-W3 团队/项目/通知/设置收口 + 005 视觉对查静态锚点测试。
// 断言面：①词汇收口（PM 新口径 4 处 + org-leader 协议值保持 + §9 规范词注释）
// ②能力缺失可见降级（srv legacy 徽 / 输出物空态能力提示 / artKey 随 legacy 重建）
// ③组级批量下载（005 artifact-batch 形态对齐：菜单入口壳探测 / 并发 3 / busy 锁 /
//   partial 重试只拉失败 / complete 定妆 / batch 条三色档）
// ④双端对查 web 锚点锁定（queuePartition 两组 / needs_action / existence / W2b outcome）
// ⑤词汇零旧词 + 结构闸。行为直跑（正则提取纯函数 + 桩依赖）覆盖 artifactsTabHtml
// 空态分叉与 batchDownloadGroup 全流程。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-w3-domains.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console");
const html = readFileSync(join(webDir, "index.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockOf(startMark: string, endMark: string): string {
  const a = html.indexOf(startMark);
  if (a < 0) return "";
  const b = html.indexOf(endMark, a);
  return b < 0 ? "" : html.slice(a, b);
}
function cssBlock(selector: string): string {
  const i = html.indexOf(selector + " {");
  if (i < 0) return "";
  let depth = 0, j = html.indexOf("{", i);
  const start = j;
  for (; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return "";
}

console.log("== #018-W3 domains closeup: static anchors ==");

// ---- ① 词汇收口（013 §11 / 018 §9 口径） ----
ok(html.includes("团队成员（PM 与派单成员）的会话记录"), "emp-home copy: PM 与派单成员");
ok(html.includes("relay 侧单漏斗 orgAction：PM 只提案、决议与"), "orgAction comment: PM 只提案");
ok(html.includes('人（PM 兼管）</h5>'), "熟手池 copy: PM 兼管");
ok(html.includes('r.target !== "org-leader"'), "org-leader protocol value untouched");
ok(html.includes("// ↑ 协议值保持 org-leader（relay 兼容，动则断链），UI 显示词按 018 §9.7 迁移"), "protocol-value guard comment per task brief");
ok(html.includes("+1 = 组织 Leader 位（A 模式=用户自占/B 模式=薄 Leader，018 §9.1"), "headcount +1 comment uses §9.1 wording");
// 团队级旧词零残留：文件内 Leader 命中行只允许协议值/§9 规范词/指定注释
const leaderLines = html.split("\n").filter((l) => /leader/i.test(l));
ok(leaderLines.length > 0 && leaderLines.every((l) =>
  /org-leader|薄 Leader|Leader 位|§9\.7|§9\.1/.test(l)
), "every remaining Leader line is protocol value or §9 canonical wording (" + leaderLines.length + ")");

// ---- ② 能力缺失可见降级 ----
ok(/const legacyBadge = ctx && ctx\.status === "online" && ctx\.legacyMode === true/.test(html), "legacy badge gated on online+legacyMode");
ok(html.includes('class="srv-pbadge dim" title="旧版 relay：输出物同步、通知、组织命令等能力可能不可用，升级 relay 后恢复"'), "legacy badge copy lists affected surfaces");
ok(html.includes('+ legacyBadge + "</span>" +'), "legacy badge rendered into srv-right slot");
ok(cssBlock(".srv-pbadge.dim") !== "", "css rule .srv-pbadge.dim");
ok(/artifactsTabHtml\(s, legacy\)/.test(html), "artifactsTabHtml receives legacy flag");
ok(/"art:" \+ s\.session_id \+ ":" \+ JSON\.stringify\(s\.artifacts \?\? null\) \+ ":" \+ \(s\.artifacts_truncated \? 1 : 0\) \+ ":" \+ \(legacy \? 1 : 0\)/.test(html), "artKey includes legacy bit (re-render on capability change)");
ok(html.includes('legacy ? "当前 relay 版本不支持输出物同步，升级 relay 后可见" : "当前会话还没有文档产出"'), "empty-state copy branches on legacy (no misleading vacuum)");
// 通知域降级位（W1b 已落，锚点防回退——对查表引用）
ok(html.includes("ctx.notificationsSupported = (own(p, \"notifications\") && capNotifications !== false) || capNotifications === true;"), "notifications capability bit intact (W1b)");
ok(html.includes('.filter((ctx) => ctx.notificationsSupported)'), "notify panel filters unsupported sources");
ok(html.includes("ctx.cmdCaps = cmdCapRemember(ctx.cmdCaps,"), "cmdCap memory-bit precedent intact");

// ---- ③ 组级批量下载（005 artifact-batch 对齐） ----
ok(html.includes("if (grp && window.ccDeck && window.ccDeck.saveArtifact) {"), "batch menu item gated on desktop shell saveArtifact");
ok(html.includes('const n = grp.querySelectorAll(".fkids .afrow:not(.dead)").length;'), "batch menu counts non-dead files only");
ok(html.includes('mk("批量下载（" + n + " 个文件）", () => batchDownloadGroup(dir, grp));'), "batch menu item wired with dir+grp");
ok(/function artBatchBar\(grp\) \{/.test(html), "artBatchBar fn present");
ok(/\.af-batch-err\[data-batch\]/.test(html), "batch bar distinguished via data-batch attr");
ok(/async function batchDownloadGroup\(dir, grp\) \{/.test(html), "batchDownloadGroup fn present");
const batchFn = html.match(/async function batchDownloadGroup\(dir, grp\) \{[\s\S]*?\n\}/)?.[0] ?? "";
ok(batchFn.includes("grp.dataset.batchBusy") , "batch busy lock on group dataset");
ok(batchFn.includes("t.exists !== false"), "batch queue skips dead files");
ok(batchFn.includes("Math.min(3, list.length)"), "batch concurrency capped at 3");
ok(batchFn.includes("window.ccDeck.saveArtifact(name,"), "batch saves via shell (no openPath spam)");
ok(batchFn.includes('" partial" : " complete"'), "batch terminal states partial/complete");
ok(batchFn.includes('"重试失败 " + failed.length'), "partial state offers retry-failed-only button");
ok(batchFn.includes("void pull(failed)"), "retry re-pulls failed subset only");
ok(batchFn.includes('"全部 " + list.length + " 个文件已下载"'), "complete copy");
ok(batchFn.includes('finally { grp.dataset.batchBusy = ""; }'), "busy lock released in finally");
for (const sel of [".af-batch-err.batch", ".af-batch-err.batch.complete", ".af-batch-err.batch.partial"]) {
  ok(cssBlock(sel) !== "", "css rule " + sel);
}
// 菜单项注册于「复制路径」之前（005 组头主操作位次对齐）
ok(html.indexOf("批量下载（") < html.indexOf('mk("复制路径"'), "batch item registered before copy-path");

// ---- ④ 双端对查 web 锚点锁定（对查表 web 侧事实；expo 侧见回单表） ----
ok(html.includes('label: "待处理"') || html.includes('"待处理"'), "web partition section: 待处理");
ok(html.includes('>其他会话</span>'), "web partition section: 其他会话");
ok(/function flagsOf|const waitingDecidable/.test(html), "web needs_action flags intact (expo splitPending 同语义)");
ok(/t\.exists === false|exists === false/.test(html), "web existence via exists boolean (expo existence_state 三字段未进协议，双端同走回退)");
ok(html.includes('data-artifact-outcome'), "web W2b outcome attr intact (expo data-artifact-outcome 对齐)");
ok(html.includes('case "SESSION_WAITING_RESOLVED"'), "web waiting closeout intact (expo 等待条去重同语义)");

// ---- ⑤ 行为直跑：artifactsTabHtml 空态分叉（空态路径零依赖触达） ----
{
  const fnSrc = html.match(/function artifactsTabHtml\(s, legacy\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok(fnSrc !== "", "behavior: artifactsTabHtml extractable");
  const run = new Function("s", "legacy", fnSrc + "\nreturn artifactsTabHtml(s, legacy);") as (s: unknown, legacy: boolean) => string;
  ok(run({ artifacts: [] }, true).includes("不支持输出物同步"), "behavior: legacy empty state shows capability notice");
  ok(run({ artifacts: [] }, false).includes("还没有文档产出"), "behavior: normal empty state unchanged");
}

// ---- ⑤b 行为直跑：batchDownloadGroup 全流程（桩 ctx/壳/拉取） ----
{
  const fnSrc = html.match(/async function batchDownloadGroup\(dir, grp\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const barFnSrc = html.match(/function artBatchBar\(grp\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok(fnSrc !== "" && barFnSrc !== "", "behavior: batch fns extractable");
  let bar: any = null; // 初始无条 → artBatchBar 走 createElement 分支创建并挂到 grp
  const grp: any = { dataset: {} as Record<string, string>, appendChild(el: any) { bar = el; }, querySelector(_sel: string) { return null; } };
  const art = (path: string, exists = true) => ({ path, dir: "/d", exists });
  // b.md 死文件（组内排除）；c.md 活文件但拉取失败 → 2 个参与、1 成 1 败 = partial
  const state = { failPaths: new Set<string>(["/d/c.md"]), saved: [] as string[], pulls: [] as string[] };
  const deps = {
    selSession: () => ({ ctx: { tag: "ctxA" }, s: { session_id: "s1", artifacts: [art("/d/a.md"), art("/d/b.md", false), art("/d/c.md")] } }),
    fetchArtifact: async (_ctx: unknown, _sid: string, path: string) => {
      state.pulls.push(path);
      if (state.failPaths.has(path)) throw new Error("拉取超时");
      return { b64s: ["QQ=="], mime: "text/markdown", size: 1 };
    },
    toast: (_m: string, _ms?: number) => {},
    bytesToB64: (_u: unknown) => "QQ==",
    artB64ToBytes: (_b: unknown) => new Uint8Array([1]),
    artDirOf: (_s: unknown, t: any) => t.dir,
    artBatchBar: null as unknown,
    document: { createElement: () => ({ className: "", dataset: {} as Record<string, string>, innerHTML: "", children: [] as any[], appendChild(el: any) { this.children.push(el); } }) },
    window: { ccDeck: { saveArtifact: async (name: string, _b64: string) => { state.saved.push(name); return "/dl/" + name; } } },
  };
  deps.artBatchBar = new Function("document", barFnSrc + "\nreturn artBatchBar;")(deps.document);
  const run = new Function(
    "selSession", "fetchArtifact", "toast", "bytesToB64", "artB64ToBytes", "artDirOf", "artBatchBar", "window", "document",
    fnSrc + "\nreturn batchDownloadGroup;",
  )(deps.selSession, deps.fetchArtifact, deps.toast, deps.bytesToB64, deps.artB64ToBytes, deps.artDirOf, deps.artBatchBar, deps.window, deps.document);
  await run("/d", grp);
  ok(state.saved.join(",") === "a.md" && !state.pulls.includes("/d/b.md"), "behavior: dead file excluded, only live files pulled+saved");
  ok(bar.className.includes("partial"), "behavior: 1-of-2 fail settles partial");
  ok(bar.innerHTML.includes("1 / 2 已下载") && bar.innerHTML.includes("1 个失败"), "behavior: partial copy shows progress + fail count");
  ok(grp.dataset.batchBusy === "", "behavior: busy lock released after settle");
  const retryBtn = bar.children.find((c: any) => typeof c.innerHTML === "string" && c.innerHTML.includes("重试失败")) ?? bar.children[0];
  ok(!!retryBtn, "behavior: partial state mounts retry button");
  // 重试只拉失败文件：c.md 转好 → 重试后 complete（a.md 不重拉、b.md 死文件永不参与）
  state.failPaths.clear();
  retryBtn.onclick();
  await new Promise((r) => setTimeout(r, 10));
  ok(state.pulls.filter((p) => p === "/d/c.md").length === 2 && state.pulls.filter((p) => p === "/d/a.md").length === 1, "behavior: retry re-pulls failed subset only");
  ok(state.saved.join(",") === "a.md,c.md", "behavior: retried file lands after recovery");
  ok(bar.className.includes("complete"), "behavior: retry success settles complete");
  ok(bar.innerHTML.includes("全部 1 个文件已下载"), "behavior: complete copy counts retried subset");
  // busy 重入：运行中二次调用直接返回
  const grp2: any = { dataset: { batchBusy: "1" }, appendChild() {}, querySelector: () => null };
  await run("/d", grp2);
  ok(grp2.dataset.batchBusy === "1", "behavior: busy group refuses re-entry");
}

// ---- ⑥ 结构闸 ----
const endIdx = html.indexOf("</html>");
ok(endIdx > 0 && html.slice(endIdx + 7).trim() === "", "nothing after </html>");
const staticHtml = html.slice(html.indexOf("<body"), html.indexOf("<script", html.indexOf("<body")));
const ids = [...staticHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(ids).size === ids.length && ids.length > 50, "static ids unique (" + ids.length + ")");
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(allIds).size === allIds.length, "all ids unique (" + allIds.length + ")");

console.log(`\nw3-domains: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
