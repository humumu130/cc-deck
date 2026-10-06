// C3 CLI 无网/失败回退、重投/代挂路径桩测（worker G / #018-C3）。
//
// 直跑入口（relay 目录）：env -u CCR_TOKEN npx tsx scripts/test-c3-cli.ts
//
// 设计先行口径（018 :428/:443/:656；实现=bin/dispatch 失败回退段头注）：
//   重投=同 dispatch_id 续链（grep 一键对账贯穿两次投递）、attempt 续号（attempts_used+1
//   起步，忠实试错史，report timeout 判定 attempt>=2 兼容）、同 command_id（relay 幂等
//   回放不双投）；代挂=--defer 跳过投递直接转存（exit 3=挂起 receipt）；失败自动转存
//   （连接性失败 11/12 短重试耗尽；拒收 10 不转存）exit 保持 1=失败终态；放弃=--discard
//   exit 0。队列 cli-deferred.ndjson append-only 生命周期账（queued 含 envelope 全文/
//   done/discarded），每 dispatch_id 文件序最后一行=当前态。
// receipt 三态：成功（exit 0+台账 ok:true）/放弃（--discard exit 0+队列 discarded）/
//   挂起（--defer exit 3+队列 pending）；失败自动转存=exit 1+两账合看（台账 deferred 行+
//   队列 pending 行）可判，不静默丢单。
// 场景（沙箱 A=转存→重投串链/放弃主链路；沙箱 B=--defer 代挂专测）：
//   A1 无网真跑（port=1）→ exit 1 + 队列 queued(source=auto) + 台账 deferred: 前缀 +
//      phase 六拍（final→queued 尾拍）+ stderr --retry/--discard 入口
//   A2 --retry 串链补投成功（WS 桩 ok）→ exit 0 + 同 command_id 三向证明（stdout/
//      桩收帧/台账同 id）+ attempt 续号 3 + 队列 queued→done + phase 链同 id 补齐 +
//      report 主对账归 success/deferred 0 + --phase complete（续链 final 取末次）
//   A3 --retry 再败再 queued（port=1）→ attempts_used 累计 2→4（最新行覆盖语义）
//   A4 --discard 放弃 → exit 0 + ok=discarded + 队列 discarded + 台账不动 +
//      report discarded 计数（放弃终态非异常不 warn）
//   A5 已终止单/不存在单 --retry --discard → exit 2 拒绝操作
//   B1 --defer 显式代挂 → exit 3 + stdout ok=deferred + 队列 source=defer + 台账零行
//      （不投递不记账）+ phase 仅 queued 一拍
//   B2 --defer 无 token 也通（干净 env 无 CCR_TOKEN 且沙箱无 token 文件）
//   B3 --phase 挂起链（仅 queued 拍）不误报断拍：pending_chains 计数、broken 0、exit 0
//   B4 report 主对账 queue_pending（仅队列挂起无台账行）warn 不 blocking
//   B5 用法错误（--retry 缺参）→ usage 退出
// 测试环境纪律（T17 教训）：所有真跑 bin/dispatch 的 env 显式注入 CCR_TOKEN 测试常量
// （透传 process.env 依赖宿主环境=泄漏绿）；B2 无 token 场景用显式构造的干净 env。
// 沙箱：CCR_DATA_DIR=mkdtemp、CCR_PORT 指桩或 port=1，生产 ~/.cc-deck 零触达。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..", ".."); // relay/scripts → 仓库根
const DISPATCH = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch");
const REPORT = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch-report");

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

const TOKEN = "c3-token-SECRET";
const roots: string[] = [];
const mkSandbox = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-c3-${tag}-`));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  roots.push(dir);
  return dir;
};

// ---------- WS 桩（仅 ok 剧本：--retry 补投成功路径；收帧记录 command_id 供串链证明） ----------
const wsReceived: string[] = [];
const wsServer = net.createServer((sock) => {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let upgraded = false;
  sock.on("error", () => {});
  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      buf = buf.subarray(end + 4);
      if (!/upgrade:\s*websocket/i.test(head)) {
        sock.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
        sock.destroy();
        return;
      }
      const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      return;
    }
    while (buf.length >= 2) {
      const second = buf[1]!;
      let len = second & 0x7f;
      let off = 2;
      const masked = !!(second & 0x80);
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len + (masked ? 4 : 0)) break;
      let body = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      body = Buffer.from(body);
      if (masked) { const mask = buf.subarray(off, off + 4); for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!; }
      buf = buf.subarray(off + (masked ? 4 : 0) + len);
      let cmd: { command_id?: string } = {};
      try { cmd = JSON.parse(body.toString("utf8")) as { command_id?: string }; } catch { continue; }
      wsReceived.push(String(cmd.command_id ?? ""));
      const frame = Buffer.concat([
        Buffer.from([0x81, Buffer.byteLength(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: true }))]),
        Buffer.from(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: true })),
      ]);
      sock.write(frame);
    }
  });
});
const listen = (srv: net.Server): Promise<number> =>
  new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
const close = (srv: net.Server): Promise<void> =>
  new Promise((resolve) => srv.close(() => resolve()));

// CLI 跑法：桩场景必须异步 spawn（spawnSync 冻住事件循环，同进程桩无法应答 WS 握手，
// 见 test-c1-cli 头注同款备案）；port=1 无网场景无桩应答需求，spawnSync 直跑即可
interface CliResult { status: number | null; stdout: string; stderr: string }
const runCli = (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }); });
  });
const runSync = (args: string[], env: NodeJS.ProcessEnv): CliResult => {
  const r = spawnSync("bash", args, { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

interface PhaseRow { phase: string; ok: boolean | null; error: string | null; attempt: number; dispatch_id: string; command_id: string; session_id: string }
const phaseLines = (stderr: string): PhaseRow[] =>
  stderr.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as PhaseRow).filter((o) => o.phase !== undefined);

interface LedgerRow { ok: boolean; error: string | null; attempt: number; command_id: string; dispatch_id: string }
const readLedger = (dataDir: string): LedgerRow[] => {
  const p = path.join(dataDir, "cli-dispatches.ndjson");
  return fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow)
    : [];
};
interface QueueRow { ts: string; type: string; source?: string; session_id?: string; dispatch_id: string; command_id?: string; attempts_used?: number; command?: Record<string, unknown> }
const readQueue = (dataDir: string): QueueRow[] => {
  const p = path.join(dataDir, "cli-deferred.ndjson");
  return fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as QueueRow)
    : [];
};

interface ReportJson {
  verdict: string;
  counts: { timeout: number; orphan: number; deferred: number; discarded: number; queue_pending: number; queue_bad_lines: number; success_commands: number; bad_rows: number };
  items: { deferred: { dispatch_ids: string[]; queue_state: string }[]; queue_pending: string[] };
}
const runReport = (dataDir: string, extra: string[] = []): { r: CliResult; j: ReportJson } => {
  const env = { ...process.env, CCR_DATA_DIR: dataDir };
  delete (env as Record<string, unknown>).CCR_TOKEN;
  delete (env as Record<string, unknown>).CCR_PORT;
  const r = runSync([REPORT, "--json", ...extra, path.join(dataDir, "cli-dispatches.ndjson")], env);
  return { r, j: JSON.parse(r.stdout) as ReportJson };
};
interface PhaseJson { verdict: string; counts: { broken: number; failed: number; complete: number; pending_chains: number; ledger_without_phase: number } }
const runPhaseReport = (dataDir: string): { r: CliResult; j: PhaseJson } => {
  const env = { ...process.env, CCR_DATA_DIR: dataDir };
  delete (env as Record<string, unknown>).CCR_TOKEN;
  delete (env as Record<string, unknown>).CCR_PORT;
  const r = runSync([REPORT, "--json", "--phase", path.join(dataDir, "cli-dispatches.ndjson")], env);
  return { r, j: JSON.parse(r.stdout) as PhaseJson };
};

async function main(): Promise<void> {
  const wsPort = await listen(wsServer);

  // ═══════════ 沙箱 A：无网转存 → 重投串链 / 放弃主链路 ═══════════
  const aDir = path.join(mkSandbox("a"), "data");
  const envA = { ...process.env, CCR_DATA_DIR: aDir, CCR_TOKEN: TOKEN, CCR_ACK_TIMEOUT_MS: "100" };
  delete (envA as Record<string, unknown>).CCR_PORT;
  const envDead = { ...envA, CCR_PORT: "1" }; // 保留端口必连接拒绝——无网态真跑
  const runDispatchA = (args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> =>
    runCli("bash", [DISPATCH, ...args], env);

  // —— A1 无网真跑 → 失败自动转存（exit 1 失败终态 + 两账合看挂起可判）——
  {
    const r = await runDispatchA(["-c", '{"text":"c3-a1"}', "sess-a1"], envDead);
    check(r.status === 1, `A1 无网失败 exit 1（got ${r.status}）`);
    check(r.stdout.trim() === "", "A1 失败终态 stdout 零 ok=true 行（不谎报成功）");
    check(r.stderr.includes("第 2 次尝试") && r.stderr.includes("转人工巡检"), "A1 短重试耗尽转人工提示保留（018 :88 口径）");
    check(r.stderr.includes("已转存待发队列") && r.stderr.includes("--retry") && r.stderr.includes("--discard"),
      "A1 stderr 给出 --retry/--discard 处置入口（不静默丢单）");
    const q = readQueue(aDir);
    check(q.length === 1 && q[0]!.type === "queued" && q[0]!.source === "auto" && q[0]!.attempts_used === 2,
      "A1 队列 queued 行 source=auto attempts_used=2（忠实试错史）");
    const env1 = q[0]!.command as { command_id?: string; payload?: { text?: string; session_id?: string } };
    check(env1.command_id && env1.payload?.session_id === "sess-a1" && env1.payload?.text === "c3-a1",
      "A1 凭据行 envelope 全文（command_id+payload 原样=重投凭据）");
    const led = readLedger(aDir);
    check(led.length === 1 && led[0]!.ok === false && (led[0]!.error ?? "").startsWith("deferred") && (led[0]!.error ?? "").includes("无法连接 relay"),
      "A1 台账失败行 error 带 deferred: 前缀（明细保留可判原因）");
    check(led[0]!.command_id === env1.command_id, "A1 台账与队列凭据同 command_id（id 不丢·一）");
    const ph = phaseLines(r.stderr);
    check(ph.map((p) => p.phase).join(",") === "send,ack,send,ack,final,queued",
      "A1 phase 六拍序（final 失败终态→queued 挂起尾拍收尾）");
    check(ph[5]!.ok === null && ph[5]!.error === "deferred" && ph[5]!.attempt === 2,
      "A1 queued 尾拍 ok:null error=deferred attempt 承终局拍");
    check(ph.every((p) => p.dispatch_id === ph[0]!.dispatch_id && p.command_id === env1.command_id),
      "A1 六拍同 dispatch_id 同 command_id（id 不丢·二）");
  }
  const qA = readQueue(aDir);
  const didX = qA[0]!.dispatch_id;
  const cidX = qA[0]!.command_id!;

  // —— A2 --retry 串链补投成功（WS 桩 ok；同 dispatch_id 续链+attempt 续号+同 command_id）——
  {
    const before = wsReceived.length;
    const r = await runDispatchA(["--retry", didX], { ...envA, CCR_PORT: String(wsPort) });
    check(r.status === 0, `A2 --retry 补投 exit 0（got ${r.status}；stderr=${r.stderr.slice(-200)}）`);
    check(r.stdout.trim() === `ok=true command_id=${cidX}`, "A2 stdout ok=true 同 command_id（id 不丢·三/receipt=成功）");
    check(wsReceived.slice(before).length === 1 && wsReceived[before] === cidX,
      "A2 桩只收 1 帧且 envelope 同 command_id（relay 幂等回放不双投）");
    const led = readLedger(aDir);
    check(led.length === 2, "A2 台账两行（失败 deferred + 补投成功）");
    check(led[1]!.ok === true && led[1]!.dispatch_id === didX && led[1]!.command_id === cidX,
      "A2 成功行同 dispatch_id 同 command_id（续链不换 id）");
    check(led[1]!.attempt === 3, `A2 attempt 续号 3（attempts_used=2 + 1，got ${led[1]!.attempt}）`);
    const q = readQueue(aDir);
    check(q.length === 2 && q[1]!.type === "done" && q[1]!.dispatch_id === didX,
      "A2 队列 queued→done（生命周期账文件序末行=当前态 done）");
    const ph = phaseLines(r.stderr);
    check(ph.map((p) => p.phase).join(",") === "send,ack,final" && ph.every((p) => p.dispatch_id === didX && p.command_id === cidX),
      "A2 phase 三拍同链（同 dispatch_id 续链，grep 一键贯穿两次投递）");
    check(ph.map((p) => p.attempt).join(",") === "3,3,3", "A2 phase attempt 全 3（续号贯穿拍链）");
    const { r: mr, j: mj } = runReport(aDir);
    check(mr.status === 0 && mj.verdict === "clean", "A2 report 主对账 clean exit 0（失败+成功同 id=T7 收口形态归 success）");
    check(mj.counts.success_commands === 1 && mj.counts.deferred === 0 && mj.counts.timeout === 0 && mj.counts.orphan === 0,
      "A2 counts：success 1 / deferred 0 / timeout 0 / orphan 0（补投成功自然成立）");
    check(mj.counts.queue_pending === 0 && mj.counts.discarded === 0 && mj.counts.queue_bad_lines === 0,
      "A2 队列交叉：无挂起无放弃无坏行");
    const { r: pr, j: pj } = runPhaseReport(aDir);
    check(pr.status === 0 && pj.verdict === "clean" && pj.counts.complete === 1 && pj.counts.failed === 0 && pj.counts.broken === 0,
      "A2 --phase 续链归 complete（phases 去重、final 取末次 ok:true）");
  }

  // —— A3 --retry 再败再 queued（attempts_used 累计）——
  {
    const r2 = await runDispatchA(["-c", '{"text":"c3-a3"}', "sess-a3"], envDead);
    check(r2.status === 1, "A3 第二单无网转存 exit 1");
    const didY = readQueue(aDir).filter((x) => x.type === "queued" && x.command && (x.command as { payload?: { text?: string } }).payload?.text === "c3-a3")[0]!.dispatch_id;
    const r = await runDispatchA(["--retry", didY], envDead);
    check(r.status === 1, "A3 --retry 仍无网 → exit 1 失败终态");
    const rows = readQueue(aDir).filter((x) => x.dispatch_id === didY);
    check(rows.length === 2 && rows[0]!.attempts_used === 2 && rows[1]!.type === "queued" && rows[1]!.attempts_used === 4,
      "A3 attempts_used 累计 2→4（续号忠实两轮试错史；最新行覆盖语义）");
    const led = readLedger(aDir).filter((x) => x.dispatch_id === didY);
    check(led.length === 2 && led.every((x) => x.ok === false) && led[1]!.attempt === 4,
      "A3 台账两失败行同 dispatch_id attempt 2/4（同链多轮可判）");
  }

  // —— A4 --discard 放弃（receipt=放弃终态）——
  const didY = readQueue(aDir).map((x) => x.dispatch_id).filter((d) => d !== didX)[0]!;
  {
    const ledBefore = readLedger(aDir).length;
    const r = await runDispatchA(["--discard", didY], envA);
    check(r.status === 0, `A4 --discard exit 0（got ${r.status}）`);
    check(r.stdout.startsWith(`ok=discarded dispatch_id=${didY}`), "A4 stdout ok=discarded+id（receipt=放弃）");
    const q = readQueue(aDir).filter((x) => x.dispatch_id === didY);
    check(q[q.length - 1]!.type === "discarded", "A4 队列末行 discarded（放弃终态）");
    check(readLedger(aDir).length === ledBefore, "A4 台账不动（放弃不追加审计行，原始失败行保留）");
    const { r: mr, j: mj } = runReport(aDir);
    check(mr.status === 0 && mj.verdict === "clean", "A4 report clean exit 0（挂起单放弃后=已决终态，无 warn 无 blocking）");
    check(mj.counts.discarded === 1 && mj.counts.deferred === 0 && mj.counts.queue_pending === 0,
      "A4 counts：discarded 1（放弃单从 deferred 剔除归终态）+ deferred 0");
  }

  // —— A5 非法操作拒绝：已终止单 / 不存在单 / 队列不存在 / 用法错 ——
  {
    let r = await runDispatchA(["--retry", didY], envA);
    check(r.status === 2 && r.stderr.includes("不在挂起态") && r.stderr.includes("discarded"),
      "A5 已放弃单 --retry → exit 2 拒绝（文案报实际终态）");
    r = await runDispatchA(["--discard", "00000000-0000-0000-0000-000000000000"], envA);
    check(r.status === 2 && r.stderr.includes("队列无"), "A5 不存在单 --discard → exit 2");
    const emptyDir = mkSandbox("empty");
    r = runSync([DISPATCH, "--retry", didX], { ...envA, CCR_DATA_DIR: path.join(emptyDir, "data") });
    check(r.status === 2 && r.stderr.includes("待发队列不存在"), "A5 队列不存在 → exit 2（不静默假装无事）");
    r = runSync([DISPATCH, "--retry"], envA);
    check(r.status === 1, "A5 --retry 缺参 → usage 退出 1（历史口径）");
  }

  await close(wsServer);

  // ═══════════ 沙箱 B：--defer 代挂专测 ═══════════
  const bRoot = mkSandbox("b");
  const bDir = path.join(bRoot, "data");
  const envB = { ...process.env, CCR_DATA_DIR: bDir, CCR_TOKEN: TOKEN, CCR_PORT: "1" };
  delete (envB as Record<string, unknown>).CCR_ACK_TIMEOUT_MS;

  // —— B1 --defer 显式代挂：跳过投递直接转存，exit 3=挂起 receipt ——
  {
    const r = runSync([DISPATCH, "-c", '{"text":"c3-b1"}', "sess-b1", "--defer"], envB);
    check(r.status === 3, `B1 --defer exit 3 挂起（got ${r.status}）`);
    check(/^ok=deferred dispatch_id=\S+ command_id=\S+$/m.test(r.stdout), "B1 stdout ok=deferred+双 ID（挂起 receipt 机判）");
    check(!r.stdout.includes("ok=true"), "B1 stdout 零 ok=true（挂起≠成功）");
    const q = readQueue(bDir);
    check(q.length === 1 && q[0]!.type === "queued" && q[0]!.source === "defer" && q[0]!.attempts_used === 1,
      "B1 队列 queued source=defer attempts_used=1（未投递即挂起）");
    check(readLedger(bDir).length === 0, "B1 台账零行（不投递不记账——挂起非失败）");
    const ph = phaseLines(r.stderr);
    check(ph.length === 1 && ph[0]!.phase === "queued" && ph[0]!.ok === null,
      "B1 phase 仅 queued 一拍（挂起链：无投递拍不判断拍）");
  }

  // —— B2 --defer 无 token 也通（转存是本地动作）——
  {
    const cleanEnv: NodeJS.ProcessEnv = { CCR_DATA_DIR: bDir, CCR_PORT: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" };
    delete (cleanEnv as Record<string, unknown>).CCR_TOKEN; // 干净 env：无 CCR_TOKEN 且沙箱无 token 文件
    const r = runSync([DISPATCH, "-c", '{"text":"c3-b2"}', "sess-b2", "--defer"], cleanEnv);
    check(r.status === 3, `B2 无 token --defer 仍 exit 3（got ${r.status}）`);
    check(readQueue(bDir).length === 2, "B2 队列两行（token 缺失不阻塞代挂）");
  }

  // —— B3 --phase 挂起链不误报断拍 + B4 主对账 queue_pending ——
  {
    const { r: pr, j: pj } = runPhaseReport(bDir);
    check(pr.status === 0 && pj.verdict === "clean", "B3 --phase 挂起链 verdict clean exit 0（仅 queued 拍≠断拍）");
    check(pj.counts.pending_chains === 2 && pj.counts.broken === 0 && pj.counts.failed === 0 && pj.counts.complete === 0,
      "B3 pending_chains 2 / broken 0 / failed 0（挂起≠中断≠失败，不判断拍）");
    // B4：主对账需要台账在册才不报「账本不存在」——补一单真实成功账再验 queue_pending
    const wsPort2 = await listen(wsServer);
    const r0 = await runCli("bash", [DISPATCH, "-c", '{"text":"c3-b4-ok"}', "sess-b4"], { ...envB, CCR_PORT: String(wsPort2) });
    check(r0.status === 0, "B4 前置：真实成功单落台账（got 非零）");
    await close(wsServer);
    const env = { ...process.env, CCR_DATA_DIR: bDir };
    delete (env as Record<string, unknown>).CCR_TOKEN;
    delete (env as Record<string, unknown>).CCR_PORT;
    const mr = runSync([REPORT, "--json", path.join(bDir, "cli-dispatches.ndjson")], env);
    const mj = JSON.parse(mr.stdout) as ReportJson;
    check(mr.status === 0 && mj.verdict === "warn", "B4 主对账 warn exit 0（queue_pending 挂起已知状态非 blocking）");
    check(mj.counts.queue_pending === 2 && mj.counts.deferred === 0 && (mj.items.queue_pending?.length ?? 0) === 2,
      "B4 queue_pending 2（--defer 直转存无台账行，单列不混 deferred）");
  }

  // —— B5 补投全恢复：B1 挂起单 relay 恢复后 --retry 补投成功（代挂→补投闭环）——
  {
    const wsPort3 = await listen(wsServer);
    const didB1 = readQueue(bDir)[0]!.dispatch_id;
    const cidB1 = readQueue(bDir)[0]!.command_id!;
    const r = await runCli("bash", [DISPATCH, "--retry", didB1], { ...envB, CCR_PORT: String(wsPort3) });
    check(r.status === 0 && r.stdout.trim() === `ok=true command_id=${cidB1}`, "B5 代挂单补投 exit 0 同 command_id（全恢复）");
    const q = readQueue(bDir).filter((x) => x.dispatch_id === didB1);
    check(q[q.length - 1]!.type === "done", "B5 队列收口 done（挂起→补投→done 全链）");
    const led = readLedger(bDir).filter((x) => x.dispatch_id === didB1);
    check(led.length === 1 && led[0]!.ok === true && led[0]!.command_id === cidB1,
      "B5 台账补一行 ok:true 同 id（挂起期台账零行的豁免就此闭合）");
    await close(wsServer);
  }

  console.log(`C3 cli fallback tests ${tests}/${tests} passed (sandbox=${bRoot})`);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e: Error) => {
    console.error(String(e?.stack ?? e));
    process.exit(1);
  });
