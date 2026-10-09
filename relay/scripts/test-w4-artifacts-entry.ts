// W4 产物池 web-console 入口：数据源单源锚（/api/artifacts 池 A，禁双源拼装）/
// 入口两枚（sideHead 常驻钮 + detail/empty 同列顶层态）/降级三态（404/401/网络错→
// 探测失败即藏，401 不当空池）/#71 同门控/首连探测一次/禁 schema 判据/复用零重写核
// （artLayoutItems 抽取=原核搬运零行为变化；artRowHtml/artFolderHtml/artRelOf/artDirOf
// 零改）/unknown 结构性排除锚（池条目无存在性字段，伪会话 cwd="" 短路 artRelOf）。
// 语义权威：docs/reviews/2026-10-06-72w0-worker-h.md 四裁定 + /tmp/worker-h-72w0.md。
// 手法 = W 线先例（test-w2b-artifacts.ts / test-m13-web-delta.ts / test-m13-web-notify.ts）：
// 静态锚 + 正则提取纯函数 new Function 直跑。
// 直跑：cd relay && env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-w4-artifacts-entry.ts
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
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function fnSrc(name: string, args: string): string {
  return html.match(new RegExp(`function ${name}\\(${args}\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

// ---- 提取被测件 ----
const layoutSrc = fnSrc("artLayoutItems", "s, arts");
const itemsOfSrc = fnSrc("artPoolItemsOf", "list");
const mimeSrc = fnSrc("artPoolMime", "name");
const relSrc = fnSrc("artRelOf", "s, t");
const gateM = html.match(/const artPoolGate = \(ctx\) => !!\(([\s\S]*?)\);/);

// ================= ① 数据源单源锚（裁定①） =================
console.log("== W4 pool single-source anchors ==");
ok(count(html, '"/api/artifacts?token="') === 2,
  "pool data comes from /api/artifacts exactly at probe + load (single source, no dual-source mix)");
ok(!html.includes("deliverables") === false && !/artPool[\s\S]{0,400}payload\.artifacts/.test(html),
  "pool layer never reads the per-session deliverables ledger (no dual-source assembly)");
ok(count(html, "function listArtifacts") === 0,
  "web side never reimplements relay listArtifacts (read-only endpoint consumption; 注释性提及不算)");
// 与会话产物 fetch 通道分离：池走 HTTP 静态服务，不借 ws COMMAND_ARTIFACT_FETCH
ok(html.includes('"/artifacts/" + encodeURIComponent(name) + "?token="'),
  "pool action channel = HTTP /artifacts/<name> static service (not ws command chain)");
ok(count(html, "COMMAND_ARTIFACT_FETCH") > 0 &&
  !/artPoolFetch[\s\S]{0,300}COMMAND_ARTIFACT_FETCH/.test(html),
  "session fetchArtifact command chain untouched and not borrowed by pool");

// ================= ② 入口两枚（裁定②） =================
console.log("== W4 entry anchors ==");
ok(html.includes('<button id="artpoolBtn" title="输出物目录"') &&
   html.includes('<button id="themeBtn" title="深浅色切换">'),
  "sideHead carries permanent pool icon button next to themeBtn");
const sideHeadIdx = html.indexOf('<div id="sideHead">');
const btnIdx = html.indexOf('id="artpoolBtn"');
const themeIdx = html.indexOf('id="themeBtn"');
const railIdx = html.indexOf('id="rail"');
ok(sideHeadIdx >= 0 && btnIdx > sideHeadIdx && btnIdx < themeIdx,
  "pool button sits inside sideHead (NOT the session rail — 005 rail 六钮无产物域，不发明新范式)");
ok(railIdx < 0 || !(html.slice(railIdx, railIdx + 4000).includes("artpoolBtn")),
  "pool entry never added into session rail domain");
ok(html.includes('<div id="artpool" style="display:none">') &&
   html.includes('id="ap-back"') && html.includes('id="ap-head"') &&
   html.includes('id="ap-body"') && html.includes('class="ap-title">输出物<'),
  "pool view = top-level state container sibling of #detail/#empty (workspace-head 形态头部)");
// renderDetail 四态路由
ok(html.includes("const pool = artPoolOpen && artPoolSrcs().length > 0;") &&
   html.includes('$("artpool").style.display = pool ? "flex" : "none";') &&
   html.includes('if (pool) { renderArtPool(); return; }'),
  "renderDetail routes pool as top-level state (artpool/detail/empty 三容器互斥显隐)");
ok(html.includes("artPoolOpen = false; // #72 W4 选中会话即回落会话详情（72W0 裁定②）"),
  "select() falls back to session detail (选中会话即回会话详情)");
ok(html.includes('$("ap-back").onclick = closeArtPool;') &&
   html.includes('$("artpoolBtn").onclick = openArtPool;'),
  "pool head back button + entry button wired");
ok(html.includes("if (!artPoolSrcs().length) return; // 门关死不入"),
  "openArtPool refuses when no gated source (entry hidden = feature offline, 降级=整体下线)");

// ================= ③ 降级面：探测一次 + 三态藏 + #71 同门控（裁定③） =================
console.log("== W4 degrade/gate anchors ==");
const probeSrc = fnSrc("probeArtPool", "ctx");
ok(probeSrc !== "" && count(html, "async function probeArtPool(") === 1,
  "probeArtPool single definition");
ok(html.includes('if (status === "online") probeArtPool(ctx);'),
  "probe hook at setConn online transition (首连探测一次挂点)");
ok(probeSrc.includes('if (ctx._artPool) return;') && probeSrc.includes('ctx._artPool = "pending";'),
  "probe once per ctx (重连不重试，不循环打爆轮询——Q3 禁循环重试)");
ok(probeSrc.includes('ctx._artPool = r.ok ? "yes" : "no";') && probeSrc.includes('catch { ctx._artPool = "no"; }'),
  "404/401/网络错 all => no (入口钮隐藏；401 不当空池)");
ok(probeSrc.includes('ctx.cfg.kind !== "lan"') && /kind !== "lan"[\s\S]{0,80}_artPool = "no"/.test(probeSrc),
  "cloud source: HTTP unreachable => no (slash 联想同口径，:9092 先例)");
ok(!/legacyMode|schemaVersion|schema_version/.test(probeSrc),
  "NO schema/legacyMode criterion in probe (72W0 勘误：legacyMode≠无池端点)");
// #71 同门控
ok(gateM !== null && gateM![1].includes('ctx._artPool === "yes"') &&
   gateM![1].includes("ctx.deliverables === true") && gateM![1].includes('ctx.status === "online"'),
  "artPoolGate = probe-yes && #71 deliverables && online (三重门，tab 关了池不开)");
ok(html.includes("updateArtPoolBtn(); // #72 W4 池入口与 #71 同门控"),
  "SNAPSHOT deliverables flip re-evaluates pool entry (#71 同门控接线)");
ok(html.includes('if (!on && artPoolOpen) { artPoolOpen = false; renderDetail(); }'),
  "gate-all-closed while open => exit pool view (不灰置诱惑)");
// 降级文案三态 + 空池区分（Q3：不误导「没有产出」）
ok(html.includes('"token 无效"') && html.includes("当前 relay 版本不支持输出物目录，升级 relay 后可见") &&
   html.includes('"网络不可达"'),
  "load-failure copy distinguishes 401 / 404 / network (不在 401 时当空池)");
ok(html.includes("暂无输出物——交付物落盘后自动收录"),
  "genuinely empty pool gets its own copy (空池≠不支持，不误导)");
ok(html.includes("正在读取输出物目录…"),
  "loading state copy present");
ok(html.includes('ctx._artPoolData = { state: "err", code: r.status };'),
  "load failure persisted per-source as err (非空池形状)");

// ================= ④ 复用零重写核（裁定④：七项复用，diff 无重写痕迹） =================
console.log("== W4 reuse-no-rewrite anchors ==");
ok(count(html, "function artRowHtml(") === 1 && count(html, "function artFolderHtml(") === 1 &&
   count(html, "function artRelOf(") === 1 && count(html, "function artDirOf(") === 1 &&
   count(html, "function artifactsTabHtml(") === 1,
  "existing render layer functions each still defined exactly once (无重定义)");
ok(html.includes("const { folders, items, newestG } = artLayoutItems(s, arts);") &&
   count(html, "const dirN = new Map();") === 1,
  "artifactsTabHtml now delegates grouping core to extracted artLayoutItems (原核搬运，内联残留=0)");
ok(layoutSrc !== "" && layoutSrc.includes("dirN.set(k, (dirN.get(k) || 0) + 1);") &&
   layoutSrc.includes("(dirN.get(k) || 0) < 2") &&
   layoutSrc.includes("...loose.map((t) => ({ f: 0, t, at: t.last_at || t.first_at || 0 }))"),
  "artLayoutItems body = verbatim grouping core (≥2 同父聚合/散文件/混排降序)");
ok(html.includes("openArtViewer(name, artPoolMime(name), bytes);") &&
   count(html, "function openArtViewer(") === 1,
  "pool preview reuses openArtViewer verbatim (分级展示零重写)");
ok(fnSrc("markArtFetchError", "path, retry, root").includes("(root || $(\"timeline\"))") &&
   fnSrc("clearArtFetchError", "path, root").includes("(root || $(\"timeline\"))") &&
   html.includes("markArtFetchError(name, () => { void artPoolPreview(ctx, name); }, $(\"ap-body\"));"),
  "W2b error bars parameterized by root (default keeps session-tab behavior; pool passes ap-body)");
ok(html.includes("const bar = artBatchBar(grp);") &&
   /artPoolBatch[\s\S]{0,2000}dataset\.batchBusy/.test(html) &&
   html.includes('"重试失败 " + failed.length'),
  "W3 batch bar shape reused (progress/retry/busy-lock) with pool channel");
// 池永远形态一：不出现「新建/修改」组头（池无 op 概念）
const sectionSrc = fnSrc("artPoolSectionHtml", "ctx, items");
ok(sectionSrc !== "" && !sectionSrc.includes('af-gt') && !sectionSrc.includes("新建 <span>"),
  "pool sections always use form-one loop (形态二「新建/修改」组头对池语义错)");
ok(sectionSrc.includes("artFolderHtml(s, it.g,") && sectionSrc.includes("artRowHtml(it.t, s)"),
  "pool section renders via existing artFolderHtml/artRowHtml (伪会话适配，零行渲染重写)");
ok(sectionSrc.includes('session_id: "artpool:" + ctx.cfg.id') && sectionSrc.includes('cwd: ""'),
  "pseudo session: unique fold-memory sid + cwd=\"\" (artRelOf 短路→无 outside 角标)");
// 伪条目适配：path/last_at/size/origin:"cwd"（cwd 外角标抑制），无 op/exists
ok(itemsOfSrc.includes("path: a.name") && itemsOfSrc.includes("last_at:") &&
   itemsOfSrc.includes("size:") && itemsOfSrc.includes('origin: "cwd"') &&
   !itemsOfSrc.includes("exists") && !itemsOfSrc.includes("op:"),
  "pool items carry path/last_at/size + origin:\"cwd\" (无 cwd 外角标) — no op badge, no existence field");
// artFolderHtml 第 4 参参数化（root 先例同款手法）：缺省零变化，池传 badge:false 抑制 op 徽标
ok(fnSrc("artFolderHtml", "s, g, open, opts").includes("{ sub: true, badge: true, ...opts }") &&
   fnSrc("artPoolSectionHtml", "ctx, items").includes(", { badge: false })"),
  "artFolderHtml opts passthrough (default = unchanged; pool passes badge:false — 组内行无「修改」徽标)");

// ================= ⑤ unknown 结构性排除锚（M13-6 同款护栏，#28/#29 安全口径） =================
console.log("== W4 unknown-exclusion anchors ==");
ok(itemsOfSrc.includes("typeof a.name === \"string\" && a.name"),
  "pool list filters malformed entries (结构上只收 relay 已 stat 成功的条目)");
ok(html.includes('if (r.status === 404) throw new Error("文件已不存在（可能已被清理）");'),
  "dangling click => refuse (列表后删除窗口 404 悬空即拒，session-manager 同哲学)");
ok(!/artPool[\s\S]{0,6000}existence_state/.test(html),
  "pool layer never fabricates existence_state (池结构性无 unknown，备案口径)");

// ================= ⑥ 动作链与安全细节 =================
console.log("== W4 action-chain anchors ==");
ok(html.includes("?token=" + '" + encodeURIComponent(ctx.cfg.token)') || count(html, "encodeURIComponent(ctx.cfg.token)") >= 3,
  "token always URL-encoded in pool HTTP calls (probe/load/fetch)");
ok(mimeSrc.includes('"application/octet-stream"') && mimeSrc.includes('"image/png"') &&
   mimeSrc.includes('"text/markdown"') && mimeSrc.includes('"application/pdf"'),
  "mime inferred from extension with octet-stream fallback (unknown type never previewed as html)");
ok(/artPoolDownload[\s\S]{0,1400}artDlBusy/.test(html) && html.includes("if (artDlBusy) { toast(\"上一个输出物还在下载中…\", 2500); return; }"),
  "pool download shares #13 busy lock (双击/连点不并发)");
ok(/artPoolSave[\s\S]{0,600}saveArtifact/.test(html) && /artPoolSave[\s\S]{0,900}a\.download/.test(html),
  "download dual channel: desktop shell saveArtifact / browser a[download] fallback");
ok(html.includes('if (row.dataset.fdir) openArtPoolFolderPop(row, ev.clientX, ev.clientY);') &&
   html.indexOf("data-ap-retry") > 0,
  "pool click delegation: folder ⋯ before row ⋯ (#222 同序) + per-source retry button");
ok(html.includes("if (frow) { toggleFgroup(frow); return; } // #222 折叠翻转复用"),
  "pool folder toggle reuses toggleFgroup (artFoldSt 伪 sid 隔离)");
ok(count(html, '$("artpool").addEventListener("click"') === 1 &&
   count(html, '$("artpool").addEventListener("dblclick"') === 1,
  "pool has its own delegation listeners (timeline 委托零触碰)");

// ================= ⑦ 直跑：artLayoutItems（原核等价性） =================
console.log("== artLayoutItems direct runs ==");
ok(layoutSrc !== "", "artLayoutItems extractable");
if (layoutSrc) {
  // artDirOf 桩与真实现同语义（path 含 / → 父目录；顶层 → ""）
  const artDirOf = (_s: unknown, t: { path?: string }) => {
    const p = String(t.path ?? "");
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i > 0 ? p.slice(0, i) : "";
  };
  const artLayoutItems = new Function("artDirOf", "return (" + layoutSrc + ");")(artDirOf) as
    (s: unknown, arts: Array<Record<string, unknown>>) => {
      folders: Map<string, { dir: string; leaf: string; files: Array<Record<string, unknown>>; at: number; size: number }>;
      loose: Array<Record<string, unknown>>;
      items: Array<{ f: number; at: number; t?: Record<string, unknown>; g?: { dir: string } }>;
      newestG: { dir: string; at: number } | null;
    };
  const s = { cwd: "", session_id: "artpool:srv1" };
  const t = (path: string, last_at: number, size?: number) => ({ path, last_at, size });

  // 聚合：同父 ≥2 → 折叠组；单文件目录 → 散
  const r1 = artLayoutItems(s, [t("r/a.md", 100), t("r/b.md", 200), t("solo.md", 300), t("r/sub/c.md", 50)]);
  ok(r1.folders.size === 1 && r1.folders.get("r")!.files.length === 2,
    "same-parent ≥2 aggregate into one folder group");
  ok(r1.folders.get("r")!.dir === "r" && r1.folders.get("r")!.leaf === "r",
    "group dir/leaf derived from parent path");
  ok(r1.folders.get("r")!.at === 200 && r1.folders.get("r")!.size === 0,
    "group at = max child last_at, size sums numeric only");
  ok(r1.loose.length === 2 && r1.loose.some((x) => x.path === "solo.md") &&
     r1.loose.some((x) => x.path === "r/sub/c.md"),
    "solo dirs and top-level files stay loose (单文件目录不聚合，复合键子目录独立成组)");
  ok(r1.items.length === 3 && r1.items[0].f === 0 && r1.items[0].t?.path === "solo.md" &&
     r1.items[1].f === 1 && r1.items[2].f === 0,
    "items interleave folders/loose by recency desc (最新交付永远在顶)");
  ok(!!r1.newestG && r1.newestG.dir === "r" && r1.newestG.at === 200,
    "newestG = most recent folder (默认展开目标)");
  // 组内文件按最近活跃排序 + size 聚合
  const r2 = artLayoutItems(s, [t("g/x.md", 10, 5), t("g/y.md", 20, 7)]);
  ok(JSON.stringify(r2.folders.get("g")!.files.map((f) => f.path)) === '["g/y.md","g/x.md"]' &&
     r2.folders.get("g")!.size === 12,
    "group files sorted byRecency + sizes summed");
  // 空池形状
  const r3 = artLayoutItems(s, []);
  ok(r3.folders.size === 0 && r3.loose.length === 0 && r3.items.length === 0 && r3.newestG === null,
    "empty input => all-empty layout (空池分支外层自判的前提)");
  // 大小写归一折叠
  const r4 = artLayoutItems(s, [t("Docs/a.md", 1), t("docs/b.md", 2)]);
  ok(r4.folders.size === 1 && r4.folders.has("docs"),
    "dir key lowercased (relay mergeArtifact 同口径，Windows 源大小写不敏感)");
}

// ================= ⑧ 直跑：artPoolItemsOf（relay 形状→伪条目） =================
console.log("== artPoolItemsOf direct runs ==");
ok(itemsOfSrc !== "", "artPoolItemsOf extractable");
if (itemsOfSrc) {
  const artPoolItemsOf = new Function("return (" + itemsOfSrc + ");")() as
    (list: unknown) => Array<{ path: string; last_at: number; size?: number; origin?: string }>;
  const out = artPoolItemsOf([
    { name: "sub/report.md", size: 120, mtime: 300 },
    { name: "top.png", size: 9, mtime: 500 },
    { name: "", size: 1, mtime: 9 },        // 畸形：空名剔除
    { name: 42 },                             // 畸形：非 string 剔除
    null,                                     // 畸形：null 剔除
    { name: "no-time.txt" },                  // 缺 mtime → 0；缺 size → undefined
  ]);
  ok(out.length === 3, "malformed entries filtered (只收可渲染条目)");
  ok(out[0].path === "top.png" && out[0].last_at === 500,
    "relay {name,mtime} mapped to artifact row shape and sorted by mtime desc");
  ok(out[2].path === "no-time.txt" && out[2].last_at === 0 && out[2].size === undefined,
    "missing mtime/size tolerated (行上时间/大小列留空不崩)");
  ok(JSON.stringify(artPoolItemsOf("junk")) === "[]" && JSON.stringify(artPoolItemsOf(null)) === "[]",
    "non-array input => [] (defensive)");
  ok(!out.some((x) => "exists" in x || "op" in x),
    "mapped items carry no existence/op fields (unknown 结构性排除)");
  ok(out.every((x) => x.origin === "cwd"),
    "every mapped item carries origin:\"cwd\" (cwd 外角标结构性不出现)");
}

// ================= ⑨ 直跑：artPoolMime =================
console.log("== artPoolMime direct runs ==");
ok(mimeSrc !== "", "artPoolMime extractable");
if (mimeSrc) {
  const artPoolMime = new Function("return (" + mimeSrc + ");")() as (name: string) => string;
  ok(artPoolMime("a.png") === "image/png" && artPoolMime("b.MD") === "text/markdown" &&
     artPoolMime("c.pdf") === "application/pdf" && artPoolMime("d.html") === "text/html" &&
     artPoolMime("e.json") === "application/json",
    "known extensions mapped (大小写不敏感)");
  ok(artPoolMime("noext") === "application/octet-stream" && artPoolMime("x.weird") === "application/octet-stream",
    "unknown extension => octet-stream (openArtViewer 兜底自动下载，禁预览)");
  ok(artPoolMime("archive.tar.gz") === "application/octet-stream",
    "multi-dot names take last segment");
}

// ================= ⑩ 直跑：伪会话适配前提（artRelOf 短路） =================
console.log("== pseudo-session adaptation (artRelOf short-circuit) ==");
ok(relSrc !== "" && relSrc.includes('if (t.origin !== "cwd" || !s.cwd) return "";'),
  "artRelOf unchanged and short-circuits on empty cwd");
if (relSrc) {
  const artRelOf = new Function("return (" + relSrc + ");")() as
    (s: { cwd: string }, t: { origin?: string; path: string }) => string;
  const pseudo = { cwd: "", session_id: "artpool:srv1" };
  ok(artRelOf(pseudo, { path: "sub/a.md" }) === "",
    "pseudo session (cwd=\"\") => rel \"\" => dir2 gray branch, no outside badge");
  ok(artRelOf({ cwd: "/home/u" }, { origin: "cwd", path: "/home/u/x.md" }) === "x.md",
    "real session behavior unchanged (零改核)");
}

// ================= ⑪ 直跑：artPoolGate 三重门真值表 =================
console.log("== artPoolGate truth table ==");
ok(gateM !== null, "artPoolGate extractable");
if (gateM) {
  const artPoolGate = new Function("return ((ctx) => !!(" + gateM![1] + "));")() as
    (ctx: { _artPool?: string; deliverables?: boolean; status?: string } | null) => boolean;
  const c = (over: Record<string, unknown>) => ({ _artPool: "yes", deliverables: true, status: "online", ...over });
  ok(artPoolGate(c({})) === true, "probe-yes + #71 on + online => gated in");
  ok(artPoolGate(c({ _artPool: "no" })) === false, "probe failed (404/401/net) => hidden");
  ok(artPoolGate(c({ _artPool: "pending" })) === false, "probe in-flight => hidden");
  ok(artPoolGate(c({ deliverables: false })) === false, "#71 off => hidden (tab 关了池不开)");
  ok(artPoolGate(c({ deliverables: undefined })) === false, "#71 field absent (旧 relay) => hidden");
  ok(artPoolGate(c({ status: "offline" })) === false, "source offline => hidden");
  ok(artPoolGate(null) === false && artPoolGate(undefined as never) === false, "null/undefined ctx => false");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
