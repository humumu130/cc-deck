// #213 W-DISPATCHX 单元断言：leader-dispatch / leader-harvest 机械手（bash）。
// 沙盒隔离：CCR_DATA_DIR/CCR_ORG_DIR/CCR_ARTIFACTS_DIR/CCR_WT_ROOT 全指临时目录 +
// 假 relay（/api/org 可编程应答、/api/notify 捕获）——零生产接触。
// 跑法：cd relay && npx tsx scripts/test-leader-dispatch.ts
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const BIN_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../cc-plugins/plugins/cc-deck/bin");
const LD = join(BIN_DIR, "leader-dispatch");
const LH = join(BIN_DIR, "leader-harvest");
const root = mkdtempSync(join(tmpdir(), "cc-deck-leader-dispatch-"));
const dataDir = join(root, "data");
const orgDir = join(root, "org");
const artDir = join(root, "artifacts");
const wtRoot = join(root, "wt");
mkdirSync(dataDir, { recursive: true });
mkdirSync(orgDir, { recursive: true });
mkdirSync(artDir, { recursive: true });
mkdirSync(wtRoot, { recursive: true });
writeFileSync(join(dataDir, "token"), "test-token-213\n");

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

// ---------- 假 relay：/api/org 应答可编程，/api/notify 捕获 ----------
const orgResponses: Array<{ status: number; body: unknown }> = [];
const orgBodies: string[] = [];
const notifyBodies: string[] = [];
const notifyResponses: Array<{ status: number; body: unknown }> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url?.startsWith("/api/org")) {
      orgBodies.push(body);
      const r = orgResponses.shift() ?? { status: 200, body: { ok: false, error: "假 relay 未编程应答" } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    if (req.url?.startsWith("/api/notify")) {
      notifyBodies.push(body);
      const r = notifyResponses.shift() ?? { status: 200, body: { ok: true, mode: "confirm" } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;

function sandboxEnv(): Record<string, string> {
  return {
    ...process.env,
    CCR_DATA_DIR: dataDir,
    CCR_ORG_DIR: orgDir,
    CCR_ARTIFACTS_DIR: artDir,
    CCR_WT_ROOT: wtRoot,
    CCR_PORT: String(port),
    CCR_TOKEN: "test-token-213",
    CCR_LD_POLL_MS: "200",
  };
}

interface RunResult { status: number | null; stdout: string; stderr: string }
function run(script: string, args: string[], opts: { input?: string; envPatch?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  return new Promise((done) => {
    const env = sandboxEnv();
    if (opts.envPatch) {
      for (const [k, v] of Object.entries(opts.envPatch)) {
        if (v === undefined) delete env[k]; else env[k] = v;
      }
    }
    const child = spawn("bash", [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c; });
    child.stderr.on("data", (c: Buffer) => { stderr += c; });
    child.stdin.end(opts.input ?? "");
    child.on("error", (e) => done({ status: null, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => done({ status: code, stdout, stderr }));
  });
}

// ---------- 夹具 git 仓 ----------
const repo = join(root, "repo");
execSync(`git init -q "${repo}" && git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t`);
execSync(`git -C "${repo}" commit -q --allow-empty -m init && git -C "${repo}" branch -m dev`);
const baseSha = execSync(`git -C "${repo}" rev-parse dev`).toString().trim();

const GOOD_BRIEF = `# 样例任务

## 已知现状
- relay/src/org.ts:343 dispatchLogPath 为台账路径单点
- relay/src/ws-server.ts:758 /api/org 白名单含 dispatch

## 用户口径
用户 1022 拍板：PM 派单应像发一条 Agent 调用一样省事。

## 验收点
- leader-dispatch 一次命令完成 worktree+派单+活性核验
- leader-harvest 机器闸对缺节回执报 ✗
`;

async function resetState(): Promise<void> {
  orgBodies.length = 0;
  notifyBodies.length = 0;
  orgResponses.length = 0;
  notifyResponses.length = 0;
  rmSync(join(dataDir, "leader-dispatches.ndjson"), { force: true });
}

// ---------- 1. bash -n ----------
{
  const r1 = execSync(`bash -n "${LD}" 2>&1 && echo OK`).toString();
  assert(r1.includes("OK"), "leader-dispatch bash -n 语法通过");
  const r2 = execSync(`bash -n "${LH}" 2>&1 && echo OK`).toString();
  assert(r2.includes("OK"), "leader-harvest bash -n 语法通过");
}

// ---------- 2. 用法/参数错误 ----------
{
  await resetState();
  const r = await run(LD, []);
  assert(r.status === 2, "无参数退出码 2");
  const r2 = await run(LD, ["pg-x", "标题", "--type", "hotfix"], { input: "x" });
  assert(r2.status === 2 && r2.stderr.includes("feat|fix|diag|build"), "非法 --type 拒绝");
  const r3 = await run(LD, ["pg-x", "标题"], { input: "" });
  assert(r3.status === 2 && r3.stderr.includes("正文为空"), "空正文拒绝");
}

// ---------- 3. 模板铁律闸 ----------
{
  await resetState();
  const brief = "# 任务\n\n## 已知现状\n- relay/src/org.ts:343 台账单点\n\n## 验收点\n- 一条命令完成派单\n";
  const r = await run(LD, ["pg-1", "#213 缺口径单", "--slug", "gate-miss", "--dry-run"], { input: brief });
  assert(r.status === 0, "dry-run 即便闸会拦也放行展示（零副作用）");
  assert(r.stderr.includes("缺节或空节「用户口径」"), "dry-run stderr 预告缺用户口径节");
  assert(r.stdout.includes("## 用户口径") && r.stdout.includes("（待填"), "骨架展开样例含占位节");
  assert(r.stdout.includes("## 纪律") && r.stdout.includes("结果：<一行结果>｜改动文件："), "机械注入尾注（回执格式+纪律行）在样例中");
  assert(orgBodies.length === 0, "dry-run 零 API 调用");

  const r2 = await run(LD, ["pg-1", "#213 缺口径单", "--slug", "gate-miss"], { input: brief });
  assert(r2.status === 3, "实跑缺节被闸拦（退出码 3）");
  assert(r2.stderr.includes("用户口径"), "闸报缺「用户口径」");

  const bad = GOOD_BRIEF
    .replace("relay/src/org.ts:343 dispatchLogPath 为台账路径单点", "台账路径在 org.ts 某处")
    .replace("relay/src/ws-server.ts:758 /api/org 白名单含 dispatch", "白名单在 ws-server 某处");
  const r3 = await run(LD, ["pg-1", "#213 无行号单", "--slug", "gate-noline"], { input: bad });
  assert(r3.status === 3 && r3.stderr.includes("路径:行号"), "已知现状无 path:line 被拦（铁律②）");

  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-skip", session_id: "s-skip" } });
  const r4 = await run(LD, ["pg-1", "#213 绕闸单", "--slug", "gate-skip", "--skip-gate", "--repo", repo, "--wait", "0"], { input: bad });
  assert(r4.status === 0, "--skip-gate 显式绕行放行");
  const led = JSON.parse(execSync(`tail -1 "${join(dataDir, "leader-dispatches.ndjson")}"`).toString());
  assert(led.gate === "skipped", "绕行记账 gate=skipped");
}

// ---------- 4. dry-run 全链（零副作用：无 API 调用、无 worktree） ----------
{
  await resetState();
  const r = await run(LD, ["pg-7cb58ab4", "#213 派单封装 W-DISPATCHX", "--repo", repo, "--dry-run"], { input: GOOD_BRIEF });
  assert(r.status === 0, "dry-run 退出码 0");
  assert(r.stdout.includes("RESULT ok=dry-run"), "dry-run RESULT 行");
  assert(r.stdout.includes("213-w-dispatchx"), "slug 自动派生 ASCII（213-w-dispatchx）");
  assert(r.stdout.includes("cc-deck-w-213-w-dispatchx"), "worktree 路径按 cc-deck-w-<slug> 惯例拼（沙盒根覆盖）");
  assert(r.stdout.includes("feat/213-w-dispatchx"), "分支=feat/<slug>");
  assert(r.stdout.includes("自 dev @") || r.stdout.includes("自 origin/dev @"), "基线解析展示（夹具退 dev）");
  assert(r.stdout.includes('"action": "dispatch"'), "POST body 展示含 action=dispatch");
  assert(!r.stdout.slice(r.stdout.indexOf("prompt")).split("\n").slice(0, 5).join("\n").includes("skills"), "未传 --skills 不带 skills 键");
  assert(orgBodies.length === 0, "dry-run 不发请求");
  const wl = execSync(`git -C "${repo}" worktree list`).toString();
  assert(!wl.includes("213-w-dispatchx"), "dry-run 未建 worktree");

  // origin/dev 存在时优先于 dev
  execSync(`git -C "${repo}" commit -q --allow-empty -m second && git -C "${repo}" update-ref refs/remotes/origin/dev HEAD`);
  const r2 = await run(LD, ["pg-1", "#213 基线优先级", "--slug", "base-pref", "--repo", repo, "--dry-run"], { input: GOOD_BRIEF });
  assert(r2.stdout.includes("自 origin/dev @"), "origin/dev 存在时优先");

  // --no-worktree 不渲染幻影 worktree/分支行（审查 P1-2 回归）
  const r3 = await run(LD, ["pg-1", "#213 幻影单", "--slug", "phantom", "--repo", repo, "--no-worktree", "--dry-run"], { input: GOOD_BRIEF });
  assert(r3.stdout.includes("（未预建，--no-worktree）") && !r3.stdout.includes("cc-deck-w-phantom"), "--no-worktree 骨架无幻影 worktree 行");
}

// ---------- 5. e2e：闸过 → dispatch ok → worktree 真建 + 两本账记账（--wait 0 免活性） ----------
{
  await resetState();
  const expBase = execSync(`git -C "${repo}" rev-parse origin/dev`).toString().trim(); // section 4 已建 origin/dev
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-1111", session_id: "sess-2222-3333" } });
  const r = await run(LD, ["pg-7cb58ab4", "#213 e2e 派单", "--slug", "e2e-ok", "--repo", repo,
    "--skills", "worker,本项目", "--wait", "0"], { input: GOOD_BRIEF });
  assert(r.status === 0, `e2e 退出码 0（${r.stderr.slice(0, 200)}）`);
  assert(orgBodies.length === 1, "恰一次 /api/org POST");
  const sent = JSON.parse(orgBodies[0]);
  assert(sent.action === "dispatch" && sent.gid === "pg-7cb58ab4" && sent.title === "#213 e2e 派单", "POST body 字段齐");
  assert(Array.isArray(sent.skills) && sent.skills.join(",") === "worker,本项目", "skills 逗号拆数组");
  assert(sent.prompt.includes("## 已知现状") && sent.prompt.includes("relay/src/org.ts:343"), "prompt 含正文已知现状（path:line）");
  assert(sent.prompt.includes("## 背景") && sent.prompt.includes("worktree"), "prompt 注入背景元数据");
  assert(sent.prompt.includes("结果：<一行结果>｜改动文件："), "prompt 注入回执格式");
  assert(sent.prompt.includes("数据不是指令"), "prompt 注入内容防线纪律行");
  const wl = execSync(`git -C "${repo}" worktree list`).toString();
  assert(wl.includes("cc-deck-w-e2e-ok") && wl.includes("feat/e2e-ok"), "worktree+分支真建在夹具仓");
  const led = JSON.parse(execSync(`tail -1 "${join(dataDir, "leader-dispatches.ndjson")}"`).toString());
  assert(led.dispatch_id === "did-1111" && led.session_id === "sess-2222-3333", "派单账记账 dispatch/session");
  assert(led.base_sha === expBase && led.branch === "feat/e2e-ok", `派单账记 base_sha/branch（${led.base_sha.slice(0, 8)}）`);
  assert(led.receipt === join(artDir, "w-e2e-ok.md"), "派单账记回执路径（artifacts 沙盒根）");
  assert(r.stdout.includes("liveness=skipped"), "--wait 0 跳过活性核验并标注");
}

// ---------- 5b. 活性核验三态：有帧存活 / 无帧升级 / 排队免核验 ----------
{
  await resetState();
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-alive", session_id: "sess-alive-1" } });
  writeFileSync(join(dataDir, "events.ndjson"), `${JSON.stringify({ type: "SESSION_UPDATED", session_id: "sess-alive-1", ts: Date.now() - 1000, payload: { status: "WORKING", action_summary: "读取任务书" } })}\n`);
  const r = await run(LD, ["pg-1", "#213 有帧单", "--slug", "alive", "--repo", repo, "--no-worktree", "--wait", "3"], { input: GOOD_BRIEF });
  assert(r.status === 0 && r.stdout.includes("已见帧况") && r.stdout.includes("WORKING"), "有帧→活性核验 ✓ 退出 0");
  assert(notifyBodies.length === 0, "存活不发升级通知");

  await resetState();
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-dead", session_id: "sess-dead-1" } });
  const r2 = await run(LD, ["pg-1", "#213 无帧单", "--slug", "dead", "--repo", repo, "--no-worktree", "--wait", "1"], { input: GOOD_BRIEF });
  assert(r2.status === 4, "无帧→活性超时退出码 4");
  assert(notifyBodies.length === 1 && notifyBodies[0].includes("派单落点未确认"), "超时走 /api/notify 升级");
  assert(notifyBodies[0].includes('"mode": "confirm"'), "notify 走黄框 confirm 通道（真实契约 mode=confirm+text）");
  assert(r2.stderr.includes("勿静默重派"), "超时文案带防双跑提示");

  // notify 拒收（400 等）→ 兜底提示可达（-f 生效），退出码仍 4 不被掩盖
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-dead2", session_id: "sess-dead-2" } });
  notifyResponses.push({ status: 400, body: { error: "text 不能为空" } });
  const r2b = await run(LD, ["pg-1", "#213 通知拒收单", "--slug", "dead2", "--repo", repo, "--no-worktree", "--wait", "1"], { input: GOOD_BRIEF });
  assert(r2b.status === 4 && r2b.stderr.includes("升级发送失败"), "notify HTTP400 → -f 兜底提示可达，退出码仍 4");

  await resetState();
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-q", session_id: "", queued: true } });
  const r3 = await run(LD, ["pg-1", "#213 排队单", "--slug", "queued", "--repo", repo, "--no-worktree", "--wait", "3"], { input: GOOD_BRIEF });
  assert(r3.status === 0 && r3.stdout.includes("queued=true"), "排队单退出 0 且免活性核验");
  assert(notifyBodies.length === 0, "排队不发升级通知");

  await resetState();
  orgResponses.push({ status: 422, body: { ok: false, error: "项目组不存在: pg-x" } });
  const r4 = await run(LD, ["pg-x", "#213 拒收单", "--slug", "reject", "--repo", repo, "--no-worktree"], { input: GOOD_BRIEF });
  assert(r4.status === 1 && r4.stderr.includes("项目组不存在"), "API 拒收退出码 1 带错误文案");
}

// ---------- 6. worktree 幂等：创建 → 同 slug 复用 → 移除后挂载既有分支 ----------
{
  await resetState();
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-r1", session_id: "s-r1" } });
  const r1 = await run(LD, ["pg-1", "#213 续派一", "--slug", "reuse", "--repo", repo, "--wait", "0"], { input: GOOD_BRIEF });
  assert(r1.status === 0, "续派一（首建）受理");
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-r2", session_id: "s-r2" } });
  const r2 = await run(LD, ["pg-1", "#213 续派二", "--slug", "reuse", "--repo", repo, "--wait", "0"], { input: GOOD_BRIEF });
  assert(r2.status === 0 && r2.stdout.includes("复用既有 worktree"), "同 slug 续派复用 worktree（幂等）");
  execSync(`git -C "${repo}" worktree remove "${join(wtRoot, "cc-deck-w-reuse")}"`);
  orgResponses.push({ status: 200, body: { ok: true, dispatch_id: "did-r3", session_id: "s-r3" } });
  const r3 = await run(LD, ["pg-1", "#213 续派三", "--slug", "reuse", "--repo", repo, "--wait", "0"], { input: GOOD_BRIEF });
  assert(r3.status === 0 && r3.stdout.includes("挂载既有分支"), "分支在 worktree 无 → 挂载既有分支不重置");
  const wtHead = execSync(`git -C "${join(wtRoot, "cc-deck-w-reuse")}" rev-parse --abbrev-ref HEAD`).toString().trim();
  assert(wtHead === "feat/reuse", "挂载后分支正确");
}

// ---------- 7. leader-harvest ----------
const didOk = "hhhhhhhh-1111-2222-3333-444444444444";
const receiptPath = join(artDir, "w-harvest-ok.md");
{
  await resetState();
  writeFileSync(receiptPath, `# 回执\n\n## 根因\n老路径缺封装。\n\n## 改动清单\n- 新增两脚本\n\n## 自测证据\n- 断言 21/21\n\n## 验收点\n- ✓ 三项全过\n\n## 遗留\n无\n\n结果：封装全链绿｜改动文件：a,b\n`);
  writeFileSync(join(orgDir, "dispatch-log.ndjson"), `${JSON.stringify({ ts: Date.now(), id: didOk, tier: "正经立项", target: "w", status: "running", session_id: "s-h1", title: "#213 收割样例" })}\n`);
  writeFileSync(join(dataDir, "leader-dispatches.ndjson"), `${JSON.stringify({ ts: Date.now(), tool: "leader-dispatch", dispatch_id: didOk, session_id: "s-h1", queued: false, gid: "pg-1", title: "#213 收割样例", slug: "harvest-ok", type: "feat", branch: "feat/harvest-ok", base_ref: "dev", base_sha: baseSha, worktree: join(wtRoot, "cc-deck-w-harvest-ok"), anchor: repo, receipt: receiptPath, gate: "pass", wait: 30, no_worktree: false })}\n`);
  execSync(`git -C "${repo}" worktree add -b feat/harvest-ok "${join(wtRoot, "cc-deck-w-harvest-ok")}" "${baseSha}"`);
  execSync(`git -C "${join(wtRoot, "cc-deck-w-harvest-ok")}" commit -q --allow-empty -m "[正经立项] 样例提交"`);
  const r = await run(LH, [didOk]);
  assert(r.status === 0, `收割闸全绿退出 0（${r.stderr}）`);
  assert(r.stdout.includes("✓ 回执存在"), "回执存在性 ✓");
  assert(r.stdout.includes("✓ 必需节「根因」") && r.stdout.includes("✓ 必需节「自测」") && r.stdout.includes("✓ 必需节「验收点」"), "三必需节 ✓");
  assert(r.stdout.includes("✓ 尾行结果摘要"), "尾行结果摘要 ✓");
  assert(r.stdout.includes("样例提交") && r.stdout.includes("新提交 1 笔"), "分支新提交清单");
  assert(r.stdout.includes("merge --squash feat/harvest-ok"), "squash 建议命令打印");
  assert(r.stdout.includes("不自动化"), "人工判断项提示在场");
  assert(r.stdout.includes("RESULT harvest=") && r.stdout.includes("fails=0"), "RESULT fails=0");

  writeFileSync(receiptPath, `# 回执\n\n## 自测证据\n- 断言 3/3\n\n结果：缺根因与验收点｜改动文件：a\n`);
  const r2 = await run(LH, [didOk]);
  assert(r2.status === 1 && r2.stdout.includes("✗ 必需节「根因」") && r2.stdout.includes("✗ 必需节「验收点」"), "缺节回执逐项 ✗ 退出 1");

  rmSync(receiptPath);
  const r3 = await run(LH, [didOk]);
  assert(r3.status === 1 && r3.stdout.includes("回执文件不存在"), "回执缺失 ✗");

  writeFileSync(receiptPath, `# 回执\n\n## 根因\nx\n\n## 自测证据\nx\n\n## 验收点\nx\n\n结果：ok｜改动文件：a\n`);
  writeFileSync(join(wtRoot, "cc-deck-w-harvest-ok", "dirty.txt"), "wip");
  const r4 = await run(LH, [didOk]);
  assert(r4.status === 1 && r4.stdout.includes("未提交改动"), "未提交改动 ⚠ 拦收割");
  execSync(`rm "${join(wtRoot, "cc-deck-w-harvest-ok", "dirty.txt")}"`);

  await resetState();
  const r5 = await run(LH, [didOk]);
  assert(r5.status === 1 && r5.stdout.includes("台账终态：running"), "无派单账回退派单台账取终态");
  assert(r5.stdout.includes("回执路径未知"), "账外单回执路径未知 ✗（提示手工指路）");

  const r6 = await run(LH, ["ffffffff-0000-0000-0000-000000000000"]);
  assert(r6.status === 2 && r6.stderr.includes("两本账都无"), "完全未知单退出码 2");

  const r7 = await run(LH, ["manual-id", "--receipt", receiptPath, "--worktree", join(wtRoot, "cc-deck-w-harvest-ok"), "--branch", "feat/harvest-ok", "--base", baseSha]);
  assert(r7.status === 0, `账外单手工指路可收割（${r7.stderr}）`);

  // org 目录隔离态回退（不设 CCR_ORG_DIR）：relay orgDir 隔离态= join(CCR_DATA_DIR,"org")
  mkdirSync(join(dataDir, "org"), { recursive: true });
  writeFileSync(join(dataDir, "org", "dispatch-log.ndjson"), `${JSON.stringify({ ts: Date.now(), id: didOk, tier: "正经立项", target: "w", status: "done", session_id: "s-h1", title: "#213 隔离态台账" })}\n`);
  const r8 = await run(LH, [didOk, "--receipt", receiptPath, "--worktree", join(wtRoot, "cc-deck-w-harvest-ok"), "--branch", "feat/harvest-ok", "--base", baseSha], { envPatch: { CCR_ORG_DIR: undefined } });
  assert(r8.stdout.includes("台账终态：done"), "不设 CCR_ORG_DIR 时按 join(data,'org') 隔离态回退读到台账");
}

// ---------- 清理 ----------
server.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
