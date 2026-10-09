import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { deriveArtifactView } from "../src/artifact-view.js";
import type { ArtifactViewInput } from "../src/artifact-view.js";
import { artifactsDir, listArtifacts, serveArtifact, validateDeliverablePath } from "../src/artifacts.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import type { ArtifactItem } from "../src/types.js";

const ROOT = join(process.cwd(), ".tmp-test-artifact-view");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "data"), { recursive: true });
mkdirSync(join(ROOT, "project"), { recursive: true });
mkdirSync(join(ROOT, "artifacts", "018-后端实施"), { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "data");
process.env.CCR_PROJECTS_ROOT = join(ROOT, "projects");
process.env.CCR_ARTIFACTS_DIR = join(ROOT, "artifacts");
process.env.CCR_PORT = "8896";
process.env.CCR_CWD = join(ROOT, "project");
process.env.CCR_NO_TITLE_GEN = "1";

let pass = 0;
let fail = 0;
function assert(condition: unknown, name: string): void {
  if (condition) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.error(`FAIL - ${name}`);
  }
}

const viewFixture = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "view-join.json"), "utf8")) as Parameters<typeof deriveArtifactView>[0];
const records = deriveArtifactView(viewFixture);
const joined = records.find((record) => record.source_id === "local" && record.display_name === "018-00-api.md");
const remote = records.find((record) => record.source_id === "remote");
const legacy = records.find((record) => record.source_id === "unknown");
const missing = records.find((record) => record.display_name === "missing-report.md");

assert(records.length === 4, "视图投影不重复合并并保留缺失/旧记录");
assert(
  joined?.origin === "deliverable" && joined.session_ids.includes("session-local") && joined.project_gids.includes("project-a"),
  "全局 artifacts 与 session/deliverable 按 source_id+path join",
);
assert(!!remote && remote.normalized_path === joined?.normalized_path && remote.group_key !== joined?.group_key, "同路径双源不合并");
assert(joined?.delivery_group_key === "batch-018-backend", "显式交付批次优先");
assert(joined?.derived_prefix_group === "018-" && joined.derived_prefix_label === "按文件名前缀推断", "文件名前缀只生成推断显示字段");
assert(remote?.availability === "unreachable" && remote.collapsed && remote.needs_refresh, "不可达源保留记录并默认折叠");
// #72A0FIX2：待刷新信号（unverified）映射进 existence_state=unknown——原映射
// unreachable 与「源确认不可达」混轨，unknown 才是「缺存在证据」的正确桶
assert(legacy?.source_label === "来源未知/待刷新" && legacy.availability === "unknown" && legacy.needs_refresh, "无 source_id 旧记录进入来源未知/待刷新（unknown 态，#72A0FIX2 映射）");
assert(missing?.exists === false && missing.availability === "missing" && missing.collapsed, "缺失登记不删除且默认折叠");
const unverifiablePath = deriveArtifactView({
  sessions: [{ session_id: "session-relative", source_id: "local", artifacts: [{ path: "relative-old.md", exists: true }] }],
});
assert(unverifiablePath[0]?.source_label === "来源未知/待刷新" && unverifiablePath[0]?.needs_refresh, "不可验证路径进入来源未知/待刷新");

// #72A0（P1-1C）NUL 键碰撞：旧裸拼接下 (source "a", path "/dir\0/b.md") 与
// (source "a\0/dir", path "/b.md") 生成同一 merge key 会被错误合并；
// 新结构化编码 + NUL 拒收后两记录必须独立且走 unknown/unverified 分支
const NUL = String.fromCharCode(0);
const collideView = deriveArtifactView({
  sessions: [
    { session_id: "session-nul-1", source_id: "a", artifacts: [{ path: `/dir${NUL}/b.md`, exists: true }] },
    { session_id: "session-nul-2", source_id: `a${NUL}/dir`, artifacts: [{ path: "/b.md", exists: true }] },
  ],
});
assert(collideView.length === 2, "NUL source/path 构造键碰撞：两记录独立不 merge");
assert(
  collideView.every((r) => r.source_label === "来源未知/待刷新" && r.needs_refresh),
  "NUL 非法输入落 unknown/unverified 分支（不抛异常）",
);

// #72A0（P2-3A）分组键：source id 含 "::" 的两条不同源记录不得同组
//（旧 `${source_id}::${parent}` 下 ("a", "/x::/y") 与 ("a::/x", "/y") 同键混组）
const groupView = deriveArtifactView({
  sessions: [
    { session_id: "session-gk-1", source_id: "a", artifacts: [{ path: "/x::/y/f-one.md", exists: true }] },
    { session_id: "session-gk-2", source_id: "a::/x", artifacts: [{ path: "/y/f-two.md", exists: true }] },
  ],
});
assert(groupView.length === 2, "分组键测试前置：两记录独立存在");
const gkOne = groupView.find((r) => r.display_name === "f-one.md");
const gkTwo = groupView.find((r) => r.display_name === "f-two.md");
assert(!!gkOne && !!gkTwo && gkOne.group_key !== gkTwo.group_key, "source id 含 :: 的不同源记录不得同组");

// #72A0（P2-3C）exists 缺省：无 artifact_exists/registration_exists 证据 → unknown，
// exists=false，open/reveal/download 不开（幽灵产物不再默认可打开）
const noEvidence = deriveArtifactView({
  deliverables: [{ path: "/w/project/report-final.md", source_id: "local" }],
});
assert(noEvidence.length === 1 && noEvidence[0]?.existence_state === "unknown" && noEvidence[0]?.exists === false, "缺 exists 证据：existence_state=unknown 且 exists=false");
assert(
  noEvidence[0]?.capabilities.open === false && noEvidence[0]?.capabilities.reveal === false && noEvidence[0]?.capabilities.download === false,
  "缺证据记录 open/reveal/download 不开",
);

// #72A0FIX2：unverified 登记落账形态（symlink 分量交付）→ existence_state=unknown
//（非 unreachable），且被标记污染的 exists 证据不可采信
const unverifiedView = deriveArtifactView({
  deliverables: [
    { path: "/w/project/symlink-report.md", source_id: "local", unverified: true },
    { path: "/w/project/scanned-report.md", source_id: "local", unverified: true, exists: true },
  ],
});
assert(
  unverifiedView.length === 2 && unverifiedView.every((r) => r.existence_state === "unknown" && r.exists === false && r.needs_refresh),
  "unverified 登记 → existence_state=unknown 且 boolean 存在证据不采信",
);
assert(
  unverifiedView.every((r) => r.capabilities.open === false && r.capabilities.retry === false && r.source_label === "来源未知/待刷新"),
  "unverified 记录 open/retry 不开、来源标待刷新（retry 是重连通源，救不了 symlink 分量）",
);
// 源不可达（source_reachable=false）保持 unreachable 桶不回归
const unreachableStill = deriveArtifactView({
  deliverables: [{ path: "/w/project/offline.md", source_id: "local", reachable: false }],
});
assert(unreachableStill[0]?.existence_state === "unreachable" && unreachableStill[0]?.needs_refresh, "源确认不可达仍映射 unreachable（与 unverified 分轨不回归）");

// #72A0FIX2（C1 硬化）：C1 类控制字符（DEL/C1 集）与超长字段同 NUL 口径拒收——
// 落 unknown/unverified 分支，不抛异常
const DEL = String.fromCharCode(0x007f);
const NEL = String.fromCharCode(0x0085);
const c1View = deriveArtifactView({
  sessions: [
    { session_id: "s-c1", source_id: `a${DEL}`, artifacts: [{ path: "/x/f-c1.md", exists: true }] },
    { session_id: "s-nel", source_id: `b${NEL}`, artifacts: [{ path: "/y/f-nel.md", exists: true }] },
  ],
});
assert(
  c1View.length === 2 && c1View.every((r) => r.source_label === "来源未知/待刷新" && r.needs_refresh && r.exists === false),
  "C1 类控制字符（DEL/NEL）source_id 拒收落 unknown/unverified 分支",
);
const longView = deriveArtifactView({
  sessions: [
    { session_id: "s-longpath", source_id: "local", artifacts: [{ path: `/${"l".repeat(5000)}/f-long.md`, exists: true }] },
    { session_id: "s-longsid", source_id: "x".repeat(300), artifacts: [{ path: "/y/f-sid.md", exists: true }] },
    { session_id: "z".repeat(300), source_id: "local", artifacts: [{ path: "/y/f-sess.md", exists: true }] },
  ],
});
assert(longView.length === 3, "长度硬化测试前置：三记录独立存在");
// 超长路径记录：path 不可验证 → normalized_path 空、展示名走兜底截断——以空路径定位
const longPathRec = longView.find((r) => !r.normalized_path);
const longSidRec = longView.find((r) => r.display_name === "f-sid.md");
const longSessRec = longView.find((r) => r.display_name === "f-sess.md");
assert(!!longPathRec && longPathRec.needs_refresh && longPathRec.exists === false, "超长路径（>4096）视同不可验证走待刷新分支");
assert(!!longSidRec && longSidRec.source_label === "来源未知/待刷新", "超长 source_id（>256）拒收落 unknown 分支");
assert(!!longSessRec && longSessRec.session_ids.length === 0 && longSessRec.exists === true, "超长 session_id（>256）不入归因（其余判定不受牵连）");

// #72A0FIX2：merge/normalize 热路径粗性能预算——2 万 scan + 1 万登记（其中一半与
// scan 同 key 合并）防 O(n²) 回归。预算为单钟差、百倍裕量（沙盒抖动不敏感；
// 非 N1② 教训禁用的「两独立取时点相等比对」形态）
const PERF_N = 20000;
const bigInput: ArtifactViewInput = {
  artifacts: Array.from({ length: PERF_N }, (_, i) => ({ path: `/scan/dir${i % 50}/f-${i}.md`, source_id: "local", exists: true, size: i, mtime: 1000 + i })),
  deliverables: Array.from({ length: PERF_N / 2 }, (_, i) => ({ path: `/scan/dir${i % 50}/f-${i}.md`, source_id: "local", exists: true })),
};
const perfT0 = performance.now();
const bigView = deriveArtifactView(bigInput);
const perfElapsed = performance.now() - perfT0;
assert(bigView.length === PERF_N, `热路径前置：3 万条输入合并为 ${PERF_N} 条 got=${bigView.length}`);
assert(perfElapsed < 2000, `merge/normalize 热路径预算：3 万条 ${perfElapsed.toFixed(0)}ms < 2000ms（防 O(n²) 回归）`);

const target = join(ROOT, "project", "deliver.md");
const directory = join(ROOT, "project", "deliver-dir");
const missingPath = join(ROOT, "project", "not-there.md");
const brokenLink = join(ROOT, "project", "broken-link.md");
writeFileSync(target, "# deliver\n");
mkdirSync(directory, { recursive: true });
try { symlinkSync(join(ROOT, "project", "missing-target.md"), brokenLink); } catch { writeFileSync(brokenLink, ""); rmSync(brokenLink); }

assert(validateDeliverablePath(target).ok, "登记前允许存在且可读普通文件");
assert(!validateDeliverablePath(directory).ok && validateDeliverablePath(directory).error?.includes("普通文件"), "登记前拒绝目录");
assert(!validateDeliverablePath(missingPath).ok && validateDeliverablePath(missingPath).error?.includes("不存在"), "登记前拒绝不存在文件");
assert(!validateDeliverablePath(brokenLink).ok, "登记前拒绝断链");

// #72A0（P1-1B）deliver 校验闸：fd 级单时刻快照 + symlink 分量标记（不拒绝原地交付）
const liveLink = join(ROOT, "project", "live-link.md");
try { symlinkSync(target, liveLink); } catch { writeFileSync(liveLink, "# deliver\n"); }
const liveLinkResult = validateDeliverablePath(liveLink);
const plainResult = validateDeliverablePath(target);
assert(liveLinkResult.ok === true && liveLinkResult.unverified === true, "指向可读文件的 symlink 登记不拒绝且标 unverified");
assert(liveLinkResult.size === null && liveLinkResult.mtime === null, "unverified 登记快照不采集 symlink 目标元数据");
assert(plainResult.ok === true && plainResult.unverified === false && typeof plainResult.size === "number" && typeof plainResult.mtime === "number", "普通文件登记快照带 size/mtime 且 unverified=false");

const artifactFile = join(artifactsDir(), "018-后端实施", "018-00-api.md");
const rootArtifact = join(artifactsDir(), "root.txt");
const deepArtifact = join(artifactsDir(), "018-后端实施", "deep", "bad.txt");
writeFileSync(artifactFile, "# api\n");
writeFileSync(rootArtifact, "root\n");
mkdirSync(join(artifactsDir(), "018-后端实施", "deep"), { recursive: true });
writeFileSync(deepArtifact, "deep\n");
const listed = listArtifacts();
assert(listed.some((item) => item.name === "018-后端实施/018-00-api.md") && listed.some((item) => item.name === "root.txt"), "列表包含根文件与一级子目录文件");

const response = () => {
  const state: { status?: number; headers?: Record<string, unknown>; body?: Buffer } = {};
  return {
    state,
    writeHead(status: number, headers: Record<string, unknown>) { state.status = status; state.headers = headers; return this; },
    end(body?: Buffer) { state.body = body; return this; },
  } as never;
};
const nestedResponse = response();
assert(serveArtifact("018-后端实施/018-00-api.md", nestedResponse), "一级子路径文件可服务");
assert(serveArtifact("root.txt", response()), "根目录文件行为不回归");
assert(!serveArtifact("018-后端实施/deep/bad.txt", response()) && !serveArtifact("../root.txt", response()), "二级嵌套与穿越路径均拒绝");

// #72A0（P1-1A）symlink 越界：外部目标 link / 目录 link 一律拒下、拒列；
// 外部区用 mkdtemp 临时目录（artifacts 根外），不触碰真实 ~/.cc-deck
const outsideDir = mkdtempSync(join(ROOT, "outside-"));
const outsideFile = join(outsideDir, "secret.txt");
writeFileSync(outsideFile, "top secret\n");
writeFileSync(join(outsideDir, "inner.txt"), "inner\n");
const ghostNames = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "view-ghosts.json"), "utf8")) as {
  external_link: string;
  sub_link: string;
  dir_link: string;
  broken_artifact: string;
};
symlinkSync(outsideFile, join(artifactsDir(), ghostNames.external_link));
symlinkSync(outsideFile, join(artifactsDir(), ghostNames.sub_link));
symlinkSync(outsideDir, join(artifactsDir(), ghostNames.dir_link));
symlinkSync(join(artifactsDir(), "no-such-target.md"), join(artifactsDir(), ghostNames.broken_artifact));

const listedWithLinks = listArtifacts();
assert(!listedWithLinks.some((i) => i.name === ghostNames.external_link), "指向根外文件的 symlink 不入列表");
assert(!listedWithLinks.some((i) => i.name === ghostNames.sub_link), "一级子目录内 symlink 不入列表");
assert(!listedWithLinks.some((i) => i.name === ghostNames.dir_link), "目录 symlink 本体不入列表");
assert(!listedWithLinks.some((i) => i.name.startsWith(`${ghostNames.dir_link}/`)), "目录 symlink 不递归跟随列出根外文件");
assert(listedWithLinks.some((i) => i.name === "018-后端实施/018-00-api.md"), "symlink 排除不影响真实文件列出");

assert(!serveArtifact(ghostNames.external_link, response()), "symlink 指向根外文件 serve 拒绝");
assert(!serveArtifact(ghostNames.sub_link, response()), "子目录 symlink 指向根外 serve 拒绝");
assert(!serveArtifact(`${ghostNames.dir_link}/inner.txt`, response()), "目录 symlink 借道越界拒绝");
assert(!serveArtifact(ghostNames.broken_artifact, response()), "断链 symlink serve 按不存在拒绝");
assert(serveArtifact("root.txt", response()), "symlink 排除后真实文件仍可服务");

if (process.env.CCR_RUN_HTTP === "1") {
  const bus = new EventBus();
  const cfg = loadConfig();
  const mgr = new SessionManager(bus, cfg);
  const sid = "ext-view-a1";
  mgr.ensureExternal(sid, join(ROOT, "project"), "A1 deliver validation");
  const server = startServer(bus, mgr, cfg, {});
  await wait(80);
  const postDeliver = async (path: string): Promise<Response> => fetch(`http://127.0.0.1:${cfg.port}/api/deliver?token=${cfg.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, cwd: join(ROOT, "project"), session_id: sid }),
  });
  const validResponse = await postDeliver(target);
  assert(validResponse.status === 200 && (await validResponse.json() as { ok?: boolean }).ok === true, "正常 deliver 行为回归");
  // #183 账本 = artifacts-index.json（keyed {sid:[...]}），拍平成 sid 行便于断言
  const flatLedger = (): { sid: string; path: string; unverified?: boolean }[] =>
    Object.entries(JSON.parse(readFileSync(join(ROOT, "data", "artifacts-index.json"), "utf8")) as Record<string, { path: string; unverified?: boolean }[]>)
      .flatMap(([sid, es]) => es.map((e) => ({ sid, path: e.path, unverified: e.unverified })));
  const ledgerAfterValid = flatLedger();
  const directoryResponse = await postDeliver(directory);
  const missingResponse = await postDeliver(missingPath);
  const brokenResponse = await postDeliver(brokenLink);
  const ledgerAfterGhosts = flatLedger();
  assert(directoryResponse.status === 400 && missingResponse.status === 400 && brokenResponse.status === 400, "deliver ghost 目录/不存在/断链均返回 4xx");
  assert(ledgerAfterValid.length === 1 && ledgerAfterGhosts.length === 1, "幽灵登记在 session 归因前被拦截且不写账");
  // #72A0（P1-1B）：symlink 分量路径 deliver 不拒绝（原地交付合法），200 响应带 unverified 标记
  const linkDeliverResponse = await postDeliver(liveLink);
  assert(
    linkDeliverResponse.status === 200 && (await linkDeliverResponse.json() as Record<string, unknown>).unverified === true,
    "deliver symlink 分量路径 200 且响应带 unverified 标记",
  );
  // #72A0FIX2：快照穿透 + unverified 落账——闸的标记经签名进登记侧，账面/持久层可还原
  const fixLedger = flatLedger();
  assert(fixLedger.some((e) => e.path === liveLink && e.unverified === true), "unverified 落关联索引（重启可还原）");
  const linkItem = mgr.getExternal(sid)?.artifacts?.find((x) => x.path === liveLink) as ArtifactItem & { unverified?: boolean };
  assert(linkItem?.unverified === true && linkItem.exists === true, "unverified 落 ArtifactItem 账面（不只 HTTP 响应）");
  const plainItem = mgr.getExternal(sid)?.artifacts?.find((x) => x.path === target) as ArtifactItem & { unverified?: boolean };
  assert(!!plainItem && plainItem.unverified === undefined, "普通文件登记账面不带 unverified");
  await server.close();
} else {
  console.log("skip - HTTP deliver integration (set CCR_RUN_HTTP=1 outside restricted sandbox)");
}
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nARTIFACT VIEW TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
