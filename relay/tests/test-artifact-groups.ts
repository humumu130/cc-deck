import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  groupArtifacts,
  listArtifacts,
  serveArtifact,
  summarizeGroup,
  type ArtifactGroupingItem,
} from "../src/artifacts.js";

type Fixture = { cwd: string; items: ArtifactGroupingItem[] };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf-8")) as Fixture;

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

const groupsFixture = fixture("artifact-groups.json");
const groups = groupArtifacts(groupsFixture.items, { cwd: groupsFixture.cwd });
const officeDocs = groups.find((group) => group.source_id === "office" && group.directory_label === "docs");
const homeDocs = groups.find((group) => group.source_id === "home" && group.directory_label === "docs");

assert(groups.length === 3, "分组按 parent + source_id 聚合");
assert(!!officeDocs && !!homeDocs && officeDocs.group_key !== homeDocs.group_key, "同路径不同 source 不合并");
assert(groups[0]?.source_id === "home" && groups[0]?.latest_at === 1500, "组间按 latest_at 倒序");
assert(officeDocs?.items.map((item) => item.path).join("|") === "/workspace/cc-deck/docs/release-report.md|/workspace/cc-deck/docs/release-check.md|/workspace/cc-deck/docs/old-note.md", "组内按 last_at 倒序");
assert(officeDocs?.directory_label === "docs" && groups.find((group) => group.directory_label === "src")?.directory_label === "src", "directory_label 相对 cwd 展示");
assert(officeDocs?.file_count === 3 && officeDocs.failed_count === 0, "exists:false 不改变组实体且不误计失败");
assert(homeDocs?.reachable === false && homeDocs.recovery_action.enabled, "不可达源保留组并预留恢复入口");
assert(officeDocs?.collapsed === false && officeDocs.batch_action.kind === "download", "组头预留折叠与批量动作");
assert(officeDocs?.directory_key === "/workspace/cc-deck/docs" && officeDocs.last_at === officeDocs.latest_at && officeDocs.has_downloadable, "组头目录键/最近时间/可下载字段");
assert(officeDocs?.download.job_id === null && officeDocs.download.progress === null && !officeDocs.download.partial_failure && !officeDocs.download.retryable, "组级下载预留 job/进度/失败/重试字段");
assert(summarizeGroup(officeDocs!).latest_at === 1200 && summarizeGroup(officeDocs!).source_id === "office", "summarizeGroup 输出摘要");

const statusFixture = fixture("artifact-status.json");
const statusGroups = groupArtifacts(statusFixture.items, { cwd: statusFixture.cwd });
const officeBuild = statusGroups.find((group) => group.source_id === "office");
const homeBuild = statusGroups.find((group) => group.source_id === "home");
assert(statusGroups.length === 2, "失败/不可达状态不使组消失");
assert(officeBuild?.file_count === 3 && officeBuild.failed_count === 2, "下载失败计入 failed_count，缺失文件仍保留");
assert(homeBuild?.reachable === false && homeBuild.file_count === 1, "源不可达只改变 reachable，不降级组实体");
assert(officeBuild?.items[0]?.last_at === 2100 && homeBuild?.latest_at === 2200, "状态组仍按时间稳定排序");

const root = join(process.cwd(), ".tmp-test-artifact-groups");
const artifactDir = join(root, "artifacts");
rmSync(root, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });
const previousDir = process.env.CCR_ARTIFACTS_DIR;
process.env.CCR_ARTIFACTS_DIR = artifactDir;
writeFileSync(join(artifactDir, "报告.html"), "<h1>ok</h1>");
writeFileSync(join(artifactDir, ".hidden"), "hidden");
mkdirSync(join(artifactDir, "nested"));
writeFileSync(join(artifactDir, "old.txt"), "old");
utimesSync(join(artifactDir, "报告.html"), new Date(2000), new Date(2000));
utimesSync(join(artifactDir, "old.txt"), new Date(1000), new Date(1000));
const listed = listArtifacts();
assert(listed.length === 2 && listed[0]?.name === "报告.html" && listed[1]?.name === "old.txt", "listArtifacts 文件列表与排序回归");
assert(listed[0]?.size === statSync(join(artifactDir, "报告.html")).size, "listArtifacts size 回归");

type MockResponse = {
  status?: number;
  headers?: Record<string, unknown>;
  body?: Buffer;
  writeHead: (status: number, headers: Record<string, unknown>) => MockResponse;
  end: (body?: Buffer) => MockResponse;
};

function responseMock(): MockResponse {
  const response: MockResponse = {
    writeHead(status: number, headers: Record<string, unknown>) {
      response.status = status;
      response.headers = headers;
      return response;
    },
    end(body?: Buffer) {
      response.body = body;
      return response;
    },
  };
  return response;
}

const served = responseMock();
assert(serveArtifact("报告.html", served as unknown as ServerResponse) && served.status === 200 && served.body?.toString() === "<h1>ok</h1>", "serveArtifact 正常文件回归");
assert((served.headers?.["content-type"] as string)?.startsWith("text/html"), "serveArtifact MIME 回归");
assert(!serveArtifact("../报告.html", responseMock() as unknown as ServerResponse), "serveArtifact 路径穿越拒绝回归");
assert(!serveArtifact("missing.html", responseMock() as unknown as ServerResponse), "serveArtifact 不存在文件回归");

if (previousDir === undefined) delete process.env.CCR_ARTIFACTS_DIR;
else process.env.CCR_ARTIFACTS_DIR = previousDir;
rmSync(root, { recursive: true, force: true });

console.log(`\nARTIFACT GROUP TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
