// W-CHAINRECALL（1104 用户令「1、2 都要」，架构升级期二）——链式召回 MVP 回归：
//   A 四类对象取回（会话/板卡/派单/回执，摘要≤80）
//   B 关联链两跳（板卡→派单→回执；既有账面事实，不新建关系库）
//   C 零写账（mtime/size/目录清单三面对照 + 源码零写 API 静态锁）
//   D 单点注册表（RECALL_KINDS + 显式 kind 路由 + 非法 kind/hop 收口）
//   E slug 派生单点（与 leader-dispatch python 规则同源的样本向量）
//   F 未命中与容错（坏板文件/未知 id/空 id）
//   G 挂接面静态锁（ws-server 路由+token 闸/leader-dispatch --recall 节/org CLAUDE 种子段）
// 沙盒惯例对齐 test-org-defects：CCR_ORG_DIR/CCR_ARTIFACTS_DIR 隔离，断言累计。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallResolve, receiptSlugOfTitle, RECALL_KINDS, type RecallSessionLike } from "../src/recall.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const cps = (s: string) => Array.from(s).length; // 码点长（与 ≤80/≤40 口径同源）

// ---------- 沙盒 ----------
const orgDirSandbox = mkdtempSync(join(tmpdir(), "chainrecall-org-"));
const artSandbox = mkdtempSync(join(tmpdir(), "chainrecall-art-"));
const dataSandbox = mkdtempSync(join(tmpdir(), "chainrecall-data-"));
process.env.CCR_ORG_DIR = orgDirSandbox;
process.env.CCR_ARTIFACTS_DIR = artSandbox;
process.env.CCR_DATA_DIR = dataSandbox;
// json 读模式（沙盒惯例）：否则 viaReadMode 撞生产 sqlite（导入器 database is locked，
// 台账读空）——readDispatchLog 在生产 sqlite 档下走导入器是正确行为，沙盒隔离用
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_CONFIG_FILE = join(orgDirSandbox, "config.json");

mkdirSync(join(orgDirSandbox, "boards"), { recursive: true });
writeFileSync(join(orgDirSandbox, "boards", "pg-test.json"), JSON.stringify({
  gid: "pg-test", frozen: false, updated_at: 1,
  entries: [
    { id: "t-recall1", text: "链式召回 MVP：取回工具落地", status: "claimed", owner_session: "sess-alpha", dispatch_id: "d-recall-a", ts: 1, updated_at: 2 },
    { id: "t-other", text: "无关卡", status: "backlog", ts: 1, updated_at: 1 },
  ],
}), "utf-8");
writeFileSync(join(orgDirSandbox, "dispatch-log.ndjson"), [
  // R1-B1 生产形态：title 只在 dispatched 首行（appendDispatch 写侧口径），终态行不带
  JSON.stringify({ ts: 1, id: "d-recall-a", tier: "正经立项", target: "org-leader", status: "dispatched", session_id: "sess-alpha", title: "Chain recall fix 链式召回修复" }),
  JSON.stringify({ ts: 2, id: "d-recall-a", tier: "正经立项", target: "org-leader", status: "done", session_id: "sess-alpha", receipt: "结果：链式召回落地｜改动文件：relay/src/recall.ts" }),
  JSON.stringify({ ts: 3, id: "d-other", tier: "正经立项", target: "org-leader", status: "dispatched", session_id: "sess-beta", title: "Unrelated dispatch 别的单" }),
  // R1-P2-2 越窗形态：520 个老单（把 d-recall-a 推出缺省 500 窗——大 max 应全捕获）
  ...Array.from({ length: 520 }, (_, i) => JSON.stringify({ ts: 1_000_000 + i, id: `d-old-${String(i + 1).padStart(3, "0")}`, tier: "正经立项", target: "org-leader", status: "done", session_id: "sess-old", title: `Old dispatch ${i + 1} 老单` })),
].join("\n") + "\n", "utf-8");
writeFileSync(join(artSandbox, "w-chain-recall-fix.md"),
  "# W-CHAIN-RECALL-FIX 回执：链式召回 MVP 交付\n\n## 改动清单\n- relay/src/recall.ts\n\n结果：正文引用行（反向取末行时应被忽略）\n\n结果：链式召回落地｜改动文件：relay/src/recall.ts\n", "utf-8");
const SESSIONS: RecallSessionLike[] = [
  { session_id: "sess-alpha", title: "worker 单：chainrecall 实现", status: "WORKING", action_summary: "写 relay/src/recall.ts" },
  { session_id: "sess-beta", title: "别的单", status: "IDLE" },
];
const sess = () => SESSIONS;

console.log("A. 四类对象取回");
{
  const s = recallResolve("sess-alpha", { sessions: sess });
  assert(!!s && s.kind === "session" && s.id === "sess-alpha", "会话取回：kind/id 正确");
  assert(!!s && s.summary.includes("chainrecall") && s.summary.includes("WORKING") && s.summary.includes("写 relay"), "会话摘要含标题/状态/最近动作");
  assert(!!s && cps(s.summary) <= 80, "会话摘要 ≤80 字");

  const c = recallResolve("t-recall1", { sessions: sess });
  assert(!!c && c.kind === "card" && c.id === "t-recall1" && c.summary.includes("pg-test") && c.summary.includes("claimed"), "板卡取回：gid/状态入摘要（t- 前缀自动检测）");

  const d = recallResolve("d-recall-a", { sessions: sess });
  assert(!!d && d.kind === "dispatch" && d.summary.includes("done") && !d.summary.includes("dispatched") && d.summary.includes("sess-al"), "派单取回：同 id 末行收敛（done 非 dispatched）+ 承接会话前缀");
  assert(!!d && d.summary.includes("Chain recall"), "R1-B1：首行 title 回填（终态行无 title 不再退化裸 UUID）");
  const old = recallResolve("d-old-001", { sessions: sess });
  assert(!!old && old.kind === "dispatch" && old.summary.includes("老单"), "R1-P2-2：越窗老单仍取回（520 行 > 缺省 500 窗，大 max 捕获）");

  const r1 = recallResolve("w-chain-recall-fix.md", { sessions: sess });
  const r2 = recallResolve("chain-recall-fix", { sessions: sess });
  const r3 = recallResolve("w-chain-recall-fix", { sessions: sess });
  assert(!!r1 && r1.kind === "receipt" && r1.summary.includes("链式召回 MVP") && r1.summary.includes("结果："), "回执取回：# 标题+结果行入摘要（全名）");
  assert(!!r1 && r1.summary.includes("链式召回落地") && !r1.summary.includes("应被忽略"), "R1-P3：结果行反向取末行（正文引用行不误采）");
  assert(!!r1 && !!r2 && !!r3 && r1.id === r2.id && r2.id === r3.id && r3.id === "w-chain-recall-fix.md", "回执 id 三种写法归一（w-x.md/w-x/x）");
}

console.log("B. 关联链两跳（既有账面事实）");
{
  const c1 = recallResolve("t-recall1", { sessions: sess, hop: 1 });
  const toD = c1?.related.find((x) => x.kind === "dispatch");
  const toS = c1?.related.find((x) => x.kind === "session");
  assert(!!c1 && !!toD && toD.id === "d-recall-a" && !!toS && toS.id === "sess-alpha", "板卡 hop=1：dispatch_id+owner_session 两条直接关联");

  const c2 = recallResolve("t-recall1", { sessions: sess, hop: 2 });
  const dRef = c2?.related.find((x) => x.kind === "dispatch");
  const receiptInHop2 = dRef?.related?.some((x) => x.kind === "receipt" && x.id === "w-chain-recall-fix.md");
  assert(!!c2 && !!receiptInHop2, "板卡 hop=2：经派单第二跳见回执（板卡→派单→回执）");
  assert(c2?.related.every((x) => cps(x.summary) <= 40) === true, "关联摘要 ≤40 字");

  const d = recallResolve("d-recall-a", { sessions: sess });
  const kinds = new Set(d?.related.map((x) => x.kind));
  assert(!!d && kinds.has("session") && kinds.has("card") && kinds.has("receipt"), "派单 hop=1 三向关联：会话/板卡/回执（回执走 title→slug 文件名约定）");

  const r = recallResolve("w-chain-recall-fix.md", { sessions: sess });
  assert(!!r && r.related.some((x) => x.kind === "dispatch" && x.id === "d-recall-a"), "回执反向关联：slug 反查派单台账");

  const s = recallResolve("sess-alpha", { sessions: sess });
  assert(!!s && s.related.some((x) => x.kind === "dispatch" && x.id === "d-recall-a") && s.related.some((x) => x.kind === "card" && x.id === "t-recall1"), "会话关联：承接派单+持有板卡（无 sess-beta 的单）");
}

console.log("C. 零写账（只读铁律）");
{
  const targets = [
    join(orgDirSandbox, "boards", "pg-test.json"),
    join(orgDirSandbox, "dispatch-log.ndjson"),
    join(artSandbox, "w-chain-recall-fix.md"),
  ];
  const before = targets.map((p) => { const st = statSync(p); return `${st.mtimeMs}:${st.size}`; });
  const dirBefore = [readdirSync(orgDirSandbox).sort().join(","), readdirSync(artSandbox).sort().join(","), readdirSync(join(orgDirSandbox, "boards")).sort().join(",")];
  for (const id of ["t-recall1", "d-recall-a", "sess-alpha", "w-chain-recall-fix.md", "不存在的id"]) {
    recallResolve(id, { sessions: sess, hop: 2 });
  }
  const after = targets.map((p) => { const st = statSync(p); return `${st.mtimeMs}:${st.size}`; });
  const dirAfter = [readdirSync(orgDirSandbox).sort().join(","), readdirSync(artSandbox).sort().join(","), readdirSync(join(orgDirSandbox, "boards")).sort().join(",")];
  assert(before.join("|") === after.join("|"), "全量召回电池后：账面文件 mtime+size 零变化");
  assert(dirBefore.join("|") === dirAfter.join("|"), "org/artifacts/boards 目录清单零变化（无新文件）");

  const src = readFileSync(new URL("../src/recall.ts", import.meta.url), "utf-8");
  assert(!/(writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync)/.test(src), "静态锁：recall.ts 源码零写 API");

  let threw = false;
  try { recallResolve("zzz-no-such", { sessions: sess, kind: "bogus" }); } catch { threw = true; }
  assert(!threw, "非法 kind/未知 id 返 null 不抛异常");
}

console.log("D. 单点注册表");
{
  assert(JSON.stringify(RECALL_KINDS) === JSON.stringify(["session", "card", "dispatch", "receipt"]), "RECALL_KINDS 四类单点注册表");
  const byKind = [
    recallResolve("sess-alpha", { sessions: sess, kind: "session" }),
    recallResolve("t-recall1", { sessions: sess, kind: "card" }),
    recallResolve("d-recall-a", { sessions: sess, kind: "dispatch" }),
    recallResolve("chain-recall-fix", { sessions: sess, kind: "receipt" }),
  ];
  assert(byKind.every((n) => !!n), "显式 kind 路由：四类各命中自家 resolver");
  assert(recallResolve("t-recall1", { sessions: sess, kind: "nope" }) === null, "非法 kind 显式拒收 → null");

  const hop1 = recallResolve("t-recall1", { sessions: sess, hop: 1 });
  assert(hop1?.related.every((r) => !r.related) === true, "hop=1 不下钻（无嵌套 related）");
  const orphan = recallResolve("w-chain-recall-fix.md", { sessions: sess, hop: 2 });
  assert(orphanSafe(orphan), "hop=2 空关联面对象不炸（孤儿回执无派单反查时）");
}
function orphanSafe(n: unknown): boolean {
  try { return n === null || Array.isArray((n as { related?: unknown[] }).related); } catch { return false; }
}

console.log("E. slug 派生单点（与 leader-dispatch python 同源样本向量）");
{
  assert(receiptSlugOfTitle("Chain recall fix 链式召回修复") === "chain-recall-fix", "混合标题：ASCII 连串小写连短横线（CJK 串自然丢弃）");
  assert(receiptSlugOfTitle("Mobile swipe fix 移动滑动修复") === "mobile-swipe-fix", "先例向量：mobile-swipe-fix");
  assert(receiptSlugOfTitle("012345678901234567890123456789") === "012345678901234567890123", "24 字符封顶");
  assert(receiptSlugOfTitle("a".repeat(23) + "-b") === "a".repeat(23), "封顶后再去尾短横线（python [:24].strip 同序）");
  assert(receiptSlugOfTitle("纯中文标题零拉丁字母") === "", "纯 CJK → 空（leader-dispatch 走时间戳兜底，recall 不编关联）");
}

console.log("F. 未命中与容错");
{
  assert(recallResolve("no-such-object", { sessions: sess }) === null, "未知 id → null");
  assert(recallResolve("   ", { sessions: sess }) === null, "空白 id → null");
  writeFileSync(join(orgDirSandbox, "boards", "pg-bad.json"), "{ 坏 JSON", "utf-8");
  const c = recallResolve("t-recall1", { sessions: sess });
  assert(!!c && c.kind === "card", "坏板文件跳过不炸（同目录好板照常召回）");
}

console.log("G. 挂接面静态锁");
{
  const ws = readFileSync(new URL("../src/ws-server.ts", import.meta.url), "utf-8");
  const blk = ws.slice(ws.indexOf('"/api/recall"'));
  const tokenAt = blk.indexOf('searchParams.get("token")');
  const resolveAt = blk.indexOf("recallResolve(");
  assert(ws.includes('"/api/recall"') && tokenAt >= 0 && resolveAt > tokenAt, "ws-server 路由在+token 闸先于解析（401 面不裸奔）");
  assert(blk.includes("mgr.snapshot()"), "会话快照接线 mgr.snapshot()");

  const ld = readFileSync(new URL("../../cc-plugins/plugins/cc-deck/bin/leader-dispatch", import.meta.url), "utf-8");
  assert(ld.includes("--recall") && ld.includes("关联对象索引（chainrecall）"), "leader-dispatch --recall 可选节在");

  const org = readFileSync(new URL("../src/org.ts", import.meta.url), "utf-8");
  assert(org.includes("ORG_CLAUDE_MD_RECALL_MARKER") && org.includes("hasRecall"), "org CLAUDE.md 种子增量段+幂等追加（PM 工具箱说明落点）");
}

console.log(`\n${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
