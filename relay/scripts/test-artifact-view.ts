import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { deriveArtifactView } from "../src/artifact-view.js";
import { artifactsDir, listArtifacts, serveArtifact, validateDeliverablePath } from "../src/artifacts.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";

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
assert(legacy?.source_label === "来源未知/待刷新" && legacy.availability === "unreachable", "无 source_id 旧记录进入来源未知/待刷新");
assert(missing?.exists === false && missing.availability === "missing" && missing.collapsed, "缺失登记不删除且默认折叠");
const unverifiablePath = deriveArtifactView({
  sessions: [{ session_id: "session-relative", source_id: "local", artifacts: [{ path: "relative-old.md", exists: true }] }],
});
assert(unverifiablePath[0]?.source_label === "来源未知/待刷新" && unverifiablePath[0]?.needs_refresh, "不可验证路径进入来源未知/待刷新");

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
  const ledgerAfterValid = JSON.parse(readFileSync(join(ROOT, "data", "deliverables.json"), "utf8")) as unknown[];
  const directoryResponse = await postDeliver(directory);
  const missingResponse = await postDeliver(missingPath);
  const brokenResponse = await postDeliver(brokenLink);
  const ledgerAfterGhosts = JSON.parse(readFileSync(join(ROOT, "data", "deliverables.json"), "utf8")) as unknown[];
  assert(directoryResponse.status === 400 && missingResponse.status === 400 && brokenResponse.status === 400, "deliver ghost 目录/不存在/断链均返回 4xx");
  assert(ledgerAfterValid.length === 1 && ledgerAfterGhosts.length === 1, "幽灵登记在 session 归因前被拦截且不写账");
  await server.close();
} else {
  console.log("skip - HTTP deliver integration (set CCR_RUN_HTTP=1 outside restricted sandbox)");
}
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nARTIFACT VIEW TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
