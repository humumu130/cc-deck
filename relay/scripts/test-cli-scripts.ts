import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const BIN = resolve(dirname(new URL(import.meta.url).pathname), "../../cc-plugins/plugins/cc-deck/bin/deliver");
const root = mkdtempSync(join(tmpdir(), "cc-deck-cli-scripts-"));
const dataDir = join(root, "data");
const file = join(root, "交付物.md");
writeFileSync(file, "# CLI test\n", "utf8");
const sid = "cli-test-session-018";
const token = "cli-test-token";
let pass = 0;
let fail = 0;

function assert(condition: unknown, message: string): void {
  if (condition) {
    pass += 1;
    console.log(`ok - ${message}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${message}`);
  }
}

// 异步 spawn（勿用 spawnSync：同步等待会阻塞本进程假 relay 的事件循环，
// deliver 的 curl 连上后收不到响应而 15s 超时误报失败——2026-10-05 验收复跑抓出）
function runDeliver(port: number): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [BIN, file], {
      cwd: root,
      env: {
        ...process.env,
        CCR_DATA_DIR: dataDir,
        CCR_PORT: String(port),
        CCR_TOKEN: token,
        CC_DECK_SESSION_ID: sid,
      },
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err: Error) => { resolveRun({ status: null, stderr: `${stderr}${err.message}`, stdout }); });
    child.on("close", (code: number | null) => { resolveRun({ status: code, stderr, stdout }); });
  });
}

async function listen(response: { status: number; body: string; onBody?: (body: string) => void }): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  let body = "";
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      response.onBody?.(body);
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(response.body);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake relay did not bind a TCP port");
  return { server, port: address.port };
}

try {
  let requestBody = "";
  const success = await listen({
    status: 200,
    body: JSON.stringify({ ok: true, session_id: sid }),
    onBody: (body) => { requestBody = body; },
  });
  const successRun = await runDeliver(success.port);
  await new Promise<void>((resolveClose) => success.server.close(() => resolveClose()));
  assert(successRun.status === 0, `deliver 成功路径退出码 0（实际 ${successRun.status}）`);
  assert(JSON.parse(requestBody).session_id === sid, "deliver 携带显式 session_id 归因");

  const failed = await listen({ status: 200, body: JSON.stringify({ ok: false, error: "fake ACK failure" }) });
  const failedRun = await runDeliver(failed.port);
  await new Promise<void>((resolveClose) => failed.server.close(() => resolveClose()));
  assert(failedRun.status !== 0, `HTTP 200 且 ok:false 非零退出（实际 ${failedRun.status}）`);
  assert((failedRun.stderr ?? "").includes("ACK body"), "ACK body 失败信息写入 stderr");

  const unused = await listen({ status: 200, body: JSON.stringify({ ok: true }) });
  await new Promise<void>((resolveClose) => unused.server.close(() => resolveClose()));
  const offlineRun = await runDeliver(unused.port);
  assert(offlineRun.status !== 0, `无网/连接拒绝非零退出（实际 ${offlineRun.status}）`);
  assert((offlineRun.stderr ?? "").includes("重试"), "无网失败信息包含重试提示");

  const auditPath = join(dataDir, "cli-dispatches.ndjson");
  const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(audit.length === 3, `三路各追加一行审计（实际 ${audit.length}）`);
  assert(audit[0].type === "DELIVER" && audit[0].ok === true && audit[0].session_id === sid, "成功审计字段完整");
  assert(audit.slice(1).every((entry) => entry.type === "DELIVER" && entry.ok === false && typeof entry.error === "string"), "两条失败审计均为 ok:false 且有 error");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`CLI script tests: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
