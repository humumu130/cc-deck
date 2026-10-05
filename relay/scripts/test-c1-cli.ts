// C1 CLI 派单/交付通道三态桩测（worker G / #018-C1）。
//
// 直跑入口（relay 目录）：node --import tsx scripts/test-c1-cli.ts
//
// 原理：起 node 假 relay 桩（WS：原生 net+crypto 最小 RFC6455 服务端，剧本可编程；
// HTTP：node:http 供 deliver），对**真实 CLI 脚本**（bin/dispatch、bin/deliver、
// bin/acceptance）跑全状态：
//   ① dispatch ACK ok:true → exit 0 + stdout ok=true command_id + 审计 true 行(attempt:1)
//   ② dispatch ok:false 拒收 → exit 非零 + 审计 false 行含 error + 不重试（桩只收 1 帧）
//   ③ dispatch 连不上（桩关闭）→ 首试失败 + 第 2 次尝试 + 仍败 → exit 非零 + 审计 attempt:2
//   ④ dispatch 首连被静默关闭、重试后 ACK ok → exit 0 + 审计 attempt:2 + 两帧同 command_id
//   ⑤ deliver HTTP 三态（ok / ok:false / 拒连）+ DELIVER 审计行
//   ⑥ acceptance 本地登记 + 云端失败非零退出（CF token 消毒 → kv 脚本快败，无网络副作用）
// —— #018-C1 二轮（日志链+严判+环境注入）新增 ——
//   ⑦ dispatch 超时态（桩收帧不 ACK，CCR_ACK_TIMEOUT_MS=300）→ 短重试仍超时 +
//     审计 attempt:2 error 含超时 + stderr 三 ID phase 日志（send×2/ack×2/final 同键）
//   ⑧ deliver 超时态（桩迟应，CCR_TIMEOUT=1）→ 非零 + error 含超时
//   ⑨ deliver --session 显式参数优先于 env 三级链（phase 日志与审计同归因）
//   ⑩ deliver 三级全缺 → stderr 警告不静默 + 审计 session_id 空串如实落账
//   ⑪ dispatch-report 真账交叉对账（本轮全部真实 CLI 落账行 → 四类判定+dispatch_ids）
// 沙箱：CCR_DATA_DIR=mkdtemp、CCR_TOKEN/CCR_PORT 注入桩，生产 ~/.cc-deck 零触达。
// 纪律：断言不比对两个独立取时点的 Date.now()（全部为结构与内容断言）。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..", ".."); // relay/scripts → 仓库根
const DISPATCH = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch");
const DELIVER = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/deliver");
const ACCEPTANCE = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/acceptance");
const REPORT = path.join(ROOT, "cc-plugins/plugins/cc-deck/bin/dispatch-report");

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

// ---------- 沙箱 ----------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cc-c1-"));
const dataDir = path.join(sandbox, "data");
fs.mkdirSync(dataDir, { recursive: true });
const TOKEN = "tok-SECRET-abc123";
const AUDIT_LOG = path.join(dataDir, "cli-dispatches.ndjson");

type WsMode = "ok" | "reject" | "ok-second" | "silent";
let wsMode: WsMode = "ok";
let wsSawOnce = false; // ok-second：首连接静默关闭、次连接正常 ACK
const wsReceived: { command_id: string; text: string }[] = [];

// 服务端→客户端帧（不掩码）
const wsFrame = (payload: Buffer): Buffer => {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const h = Buffer.alloc(4);
  h[0] = 0x81; h[1] = 126; h.writeUInt16BE(payload.length, 2);
  return Buffer.concat([h, payload]);
};

// 客户端→服务端帧解包（RFC6455 掩码）
function parseClientFrames(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  while (buf.length >= 2) {
    const second = buf[1]!;
    let len = second & 0x7f;
    let off = 2;
    const masked = !!(second & 0x80);
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask: Buffer | undefined;
    if (masked) { if (buf.length < off + 4) break; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    const body = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
    frames.push(body);
    buf = buf.subarray(off + len);
  }
  return { frames, rest: buf };
}

const wsServer = net.createServer((sock) => {
  // Buffer 泛型显式放宽到 ArrayBufferLike：Buffer.alloc 推断 Buffer<ArrayBuffer>，
  // 而 subarray/parseClientFrames 产出 Buffer<ArrayBufferLike>，回写时 TS2322
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
        // 非 WS 的杂散 HTTP（如 acceptance 探云页打到本口）→ 明确拒绝防悬挂
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
    const { frames, rest } = parseClientFrames(buf);
    buf = rest;
    for (const body of frames) {
      const text = body.toString("utf8");
      let cmd: { command_id?: string } = {};
      try { cmd = JSON.parse(text) as { command_id?: string }; } catch { continue; }
      wsReceived.push({ command_id: String(cmd.command_id ?? ""), text });
      if (wsMode === "silent") {
        // 超时态剧本：收帧不 ACK 不断连——客户端单拍 ACK 等待到点判超时
        return;
      }
      if (wsMode === "ok" || (wsMode === "ok-second" && wsSawOnce)) {
        sock.write(wsFrame(Buffer.from(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: true }))));
      } else if (wsMode === "reject") {
        // error 回显 token：专门考 dispatch 的 redaction 红线
        sock.write(wsFrame(Buffer.from(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: false, error: `invalid token ${TOKEN} leak` }))));
      } else if (wsMode === "ok-second" && !wsSawOnce) {
        wsSawOnce = true;
        sock.destroy(); // 收到命令但不 ACK、直接断——触发客户端「连接意外关闭」重试路
      }
    }
  });
});

// deliver 的 HTTP 桩
let deliverMode: "ok" | "reject" | "down" | "slow" = "ok";
const httpServer = http.createServer((req, res) => {
  // 超时态剧本：客户端 curl 先到点断开，桩随后写死套接字——错误静音防未处理事件
  req.on("error", () => {});
  res.on("error", () => {});
  let body = "";
  req.on("data", (c: Buffer) => { body += String(c); });
  req.on("end", () => {
    if (deliverMode === "ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: (JSON.parse(body) as { path: string }).path }));
    } else if (deliverMode === "reject") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `invalid token ${TOKEN} leak` }));
    } else if (deliverMode === "slow") {
      // 迟应 > CCR_TIMEOUT（测试注入 1s）：curl 到点判超时，本桩的迟响应被丢弃
      setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, path: (JSON.parse(body) as { path: string }).path }));
        } catch { /* 客户端已断 */ }
      }, 1300);
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "stub down" }));
    }
  });
});

const listen = (srv: net.Server | http.Server): Promise<number> =>
  new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
const close = (srv: net.Server | http.Server): Promise<void> =>
  new Promise((resolve) => srv.close(() => resolve()));

// CLI 跑法必须是异步 spawn 而非 spawnSync：spawnSync 会冻住本进程事件循环，
// 同进程桩服务端无法应答 TCP 升级握手，子 CLI 全部 15s 超时假败（真连接死锁，
// 非被测代码问题）。异步 spawn 期间桩照常收发，子 CLI 结果以 Promise 回收。
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

async function main(): Promise<void> {
  const wsPort = await listen(wsServer);
  const httpPort = await listen(httpServer);

  // 子进程环境：全链路指沙箱；CF token 消毒（acceptance 的 kv 上传脚本快败，无网络副作用）；
  // CC_DECK_SESSION_ID 固定以锁归因；清 CLAUDE_* 防本会话 env 串入
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CCR_DATA_DIR: dataDir,
    CCR_TOKEN: TOKEN,
    CCR_PORT: String(wsPort),
    CC_DECK_SESSION_ID: "sess-E2E",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    CF_TOKEN: "",
    CLOUDFLARE_API_TOKEN: "",
  };
  // deliver 走 HTTP 桩（与 WS 桩不同口）：经 env CCR_PORT 只有一个……deliver/acceptance
  // 同读 CCR_PORT。二者测试互不并行：dispatch 态先把 CCR_PORT 指 WS 口，deliver 态改指 HTTP 口
  const envFor = (port: number): NodeJS.ProcessEnv => ({ ...childEnv, CCR_PORT: String(port) });

  interface AuditRow { ok: boolean; error: string | null; attempt: number; type: string; command_id: string | null; dispatch_id: string; session_id: string }
  const readAudit = (): AuditRow[] =>
    fs.existsSync(AUDIT_LOG)
      ? fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditRow)
      : [];
  const auditAll = (): string => (fs.existsSync(AUDIT_LOG) ? fs.readFileSync(AUDIT_LOG, "utf8") : "");

  const runDispatch = (port: number, payload: string, sid: string) =>
    runCli("bash", [DISPATCH, "-c", payload, sid], envFor(port));
  // 超时态专用：ACK 单拍等待调到 300ms（否则 15s×2 拍 + 2s 短重试间隔拖垮套件）
  const runDispatchT = (port: number, payload: string, sid: string) =>
    runCli("bash", [DISPATCH, "-c", payload, sid], { ...envFor(port), CCR_ACK_TIMEOUT_MS: "300" });
  // 三 ID phase 日志解析（stderr 单行 JSON，{"tool":"dispatch"|"deliver"} 开头）
  interface PhaseLine { tool: string; phase: string; ts: string; session_id: string; dispatch_id: string; command_id: string | null; attempt: number; ok: boolean | null; error: string | null }
  const phaseLines = (stderr: string, tool: string): PhaseLine[] =>
    stderr.split("\n").filter((l) => l.startsWith(`{"tool":"${tool}"`)).map((l) => JSON.parse(l) as PhaseLine);

  // ═══════════ ① dispatch：ACK ok:true ═══════════
  {
    wsMode = "ok";
    const r = await runDispatch(wsPort, JSON.stringify({ text: "你好，继续" }), "sess-1");
    check(r.status === 0, `① exit 0（got ${r.status}，stderr=${r.stderr.slice(0, 200)}）`);
    const m = /^ok=true command_id=(\S+)$/m.exec(r.stdout);
    check(!!m, "① stdout 打 ok=true command_id=");
    const cmdId = m![1]!;
    check(wsReceived.length === 1 && wsReceived[0]!.command_id === cmdId, "① 桩恰收 1 帧、command_id 同回执");
    check(wsReceived[0]!.text.includes('"text":"你好，继续"') && wsReceived[0]!.text.includes('"session_id":"sess-1"'), "① payload/session_id 完整进 COMMAND_MESSAGE");
    const audit = readAudit();
    check(audit.length === 1 && audit[0]!.ok === true && audit[0]!.attempt === 1, "① 审计 true 行 attempt:1");
    check(audit[0]!.command_id === cmdId && audit[0]!.type === "COMMAND_MESSAGE" && audit[0]!.dispatch_id.length >= 32, "① 审计行带 command_id/dispatch_id/type（全链路 id）");
    check(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN) && !auditAll().includes(TOKEN), "① token 不入 stdout/stderr/审计");
  }

  // ═══════════ ② dispatch：ok:false 明确拒收（不重试） ═══════════
  {
    wsMode = "reject";
    const before = wsReceived.length;
    const auditBefore = readAudit().length;
    const r = await runDispatch(wsPort, JSON.stringify({ text: "被拒单" }), "sess-2");
    check(r.status !== 0, "② 拒收 → 非零退出");
    check(wsReceived.length === before + 1, "② 明确拒收不重试（桩只多收 1 帧）");
    check(r.stderr.includes("[redacted]") && !r.stderr.includes("SECRET"), "② token 红线：error 消毒后才落 stderr");
    check(r.stderr.includes("未静默丢单"), "② 失败提示「未静默丢单」");
    const audit = readAudit();
    check(audit.length === auditBefore + 1 && audit[audit.length - 1]!.ok === false, "② 审计 false 行");
    check(audit[audit.length - 1]!.attempt === 1 && (audit[audit.length - 1]!.error ?? "").includes("[redacted]"), "② 拒收 attempt:1、error 已消毒入审计");
    check(!r.stdout.includes(TOKEN) && !auditAll().includes(TOKEN), "② token 不入 stdout/审计");
  }

  // ═══════════ ③ dispatch：连不上 → 短重试一次 → 仍败（attempt:2 转人工） ═══════════
  {
    await close(wsServer); // 桩关闭 = 连接拒绝
    const auditBefore = readAudit().length;
    const r = await runDispatch(wsPort, JSON.stringify({ text: "无网单" }), "sess-3");
    check(r.status !== 0, "③ 连不上 → 非零退出");
    check(r.stderr.includes("第 2 次尝试"), "③ stderr 打「第 2 次尝试」重试进度可见");
    check(r.stderr.includes("转人工巡检") && r.stderr.includes("未静默丢单"), "③ 重试仍败 → 转人工巡检提示 + 未静默丢单");
    const audit = readAudit();
    const last = audit[audit.length - 1]!;
    check(audit.length === auditBefore + 1 && last.ok === false && last.attempt === 2, "③ 审计单行 ok:false attempt:2（不刷行）");
    check((last.error ?? "").includes("无法连接"), "③ 审计 error=连接失败语义");
    check(!auditAll().includes(TOKEN) && !r.stderr.includes("SECRET"), "③ token 不入 stderr/审计");
  }

  // ═══════════ ④ dispatch：首连静默断、重试后成功（同 command_id 不换新 id） ═══════════
  {
    wsSawOnce = false;
    wsMode = "ok-second";
    const port2 = await listen(wsServer); // 重开桩（新口）
    const before = wsReceived.length;
    const r = await runDispatch(port2, JSON.stringify({ text: "重试成功单" }), "sess-4");
    check(r.status === 0, `④ 重试后成功 exit 0（got ${r.status}，stderr=${r.stderr.slice(0, 200)}）`);
    check(r.stderr.includes("第 2 次尝试"), "④ 重试进度可见");
    const two = wsReceived.slice(before);
    check(two.length === 2 && two[0]!.command_id === two[1]!.command_id, "④ 两拍 envelope 同 command_id（不换新 id，relay 幂等防双投）");
    const audit = readAudit();
    const last = audit[audit.length - 1]!;
    check(last.ok === true && last.attempt === 2 && last.command_id === two[1]!.command_id, "④ 审计 true 行 attempt:2、command_id 贯穿");
    await close(wsServer);
  }

  // ═══════════ ⑤ deliver：HTTP 三态 ═══════════
  {
    const file = path.join(sandbox, "交付物.md");
    fs.writeFileSync(file, "# 交付物\n");
    // ⑤a ok：exit 0 + 回显 body + DELIVER true 行
    deliverMode = "ok";
    let r = await runCli("bash", [DELIVER, file], envFor(httpPort));
    check(r.status === 0, `⑤a deliver ok → exit 0（got ${r.status}，stderr=${r.stderr.slice(0, 200)}）`);
    check(r.stdout.includes(file) && r.stdout.includes('"ok":true'), "⑤a stdout 回显登记 body");
    let audit = readAudit();
    check(audit[audit.length - 1]!.ok === true && audit[audit.length - 1]!.type === "DELIVER", "⑤a DELIVER 审计 true 行");
    check(audit[audit.length - 1]!.command_id === null, "⑤a DELIVER 无 command_id（HTTP 直投非 WS 命令，不适用位如实留空）");
    // ⑤b ok:false 拒收：非零 + error 消毒 + 审计 false
    deliverMode = "reject";
    r = await runCli("bash", [DELIVER, file], envFor(httpPort));
    check(r.status !== 0 && r.stderr.includes("[redacted]") && !r.stderr.includes("SECRET"), "⑤b deliver 拒收 → 非零 + token 消毒");
    audit = readAudit();
    check(audit[audit.length - 1]!.ok === false && (audit[audit.length - 1]!.error ?? "").includes("[redacted]"), "⑤b DELIVER 审计 false 行含消毒后 error");
    // ⑤c 拒连：非零 + 明确错误 + 审计 false（无静默丢）
    await close(httpServer);
    r = await runCli("bash", [DELIVER, file], envFor(httpPort));
    check(r.status !== 0 && r.stderr.includes("无法连接 relay") && r.stderr.includes("未静默丢单"), "⑤c deliver 拒连 → 非零 + 明确错误");
    audit = readAudit();
    check(audit[audit.length - 1]!.ok === false && (audit[audit.length - 1]!.error ?? "").includes("无法连接"), "⑤c DELIVER 审计 false 行");
    check(!auditAll().includes(TOKEN) && !r.stdout.includes(TOKEN), "⑤ token 不入 stdout/审计");
  }

  // ═══════════ ⑥ acceptance：本地登记 + 云端失败非零（CF token 消毒快败） ═══════════
  {
    const md = path.join(sandbox, "验收单.md");
    fs.writeFileSync(md, [
      "# C1 验收单（桩测）",
      "- 前置：桩测环境",
      "| 任务号 | 验收项 | 通过标准 | 通过与否 | 问题 |",
      "|---|---|---|---|---|",
      "| C1① | 派单 ok 态 | exit 0 + 审计 true | | |",
      "| C1② | 拒收态 | 非零 + 审计 false | | |",
      "| C1③ | 重试态 | attempt:2 转人工 | | |",
      "| C1④ | 重试成功 | attempt:2 落 true 行 | | |",
      "备注：云端失败属预期（token 消毒）。",
    ].join("\n"));
    const r = await runCli("python3", [ACCEPTANCE, md], envFor(0)); // 口 0=连不上 → 云页失败
    check(r.status === 1, `⑥ 云端失败 → 非零退出 1（got ${r.status}）`);
    check(r.stdout.includes("已登记 4 行"), "⑥ stdout 报登记行数");
    check(r.stdout.includes("填写链接(家庭网)"), "⑥ LAN 链接仍可用（云端失败不吞 LAN 出单）");
    const accDir = path.join(dataDir, "acceptances");
    const files = fs.readdirSync(accDir).filter((f) => f.endsWith(".json"));
    check(files.length === 1, "⑥ 验收单 json 落 CCR_DATA_DIR 沙箱");
    const doc = JSON.parse(fs.readFileSync(path.join(accDir, files[0]!), "utf8")) as {
      title: string; rows: { task: string; item: string; criteria: string }[]; sheet_key: string; session_id?: string; notes: string[];
    };
    check(doc.rows.length === 4 && doc.rows[0]!.task === "C1①" && doc.rows[0]!.criteria.includes("exit 0"), "⑥ 表格前三列解析正确");
    check(doc.title.includes("C1 验收单") && typeof doc.sheet_key === "string" && doc.sheet_key.length >= 16, "⑥ 标题与 per-sheet 密钥落本地");
    check(doc.session_id === "sess-E2E", "⑥ 会话归因（CC_DECK_SESSION_ID 透传）");
    check(doc.notes.join("").includes("备注"), "⑥ 表格后备注段解析");
    check(!r.stdout.includes(TOKEN), "⑥ token 不入 stdout");
  }

  // ═══════════ ⑦ dispatch：超时态（桩收帧不 ACK，CCR_ACK_TIMEOUT_MS 调快） ═══════════
  {
    wsMode = "silent";
    const portT = await listen(wsServer);
    const before = wsReceived.length;
    const auditBefore = readAudit().length;
    const r = await runDispatchT(portT, JSON.stringify({ text: "超时单" }), "sess-5");
    check(r.status !== 0, "⑦ 超时 → 非零退出");
    check(r.stderr.includes("第 2 次尝试") && r.stderr.includes("转人工巡检") && r.stderr.includes("未静默丢单"),
      "⑦ 超时短重试仍败 → 转人工巡检提示");
    const two = wsReceived.slice(before);
    check(two.length === 2 && two[0]!.command_id === two[1]!.command_id, "⑦ 两拍 envelope 同 command_id（超时重发同 id）");
    const audit = readAudit();
    const last = audit[audit.length - 1]!;
    check(audit.length === auditBefore + 1 && last.ok === false && last.attempt === 2 && (last.error ?? "").includes("超时"),
      "⑦ 审计 attempt:2、error 含超时（TIMEOUT_CLASS 可判）");
    // 三 ID 全链路 phase 日志：send×2/ack×2/final，全拍同 dispatch_id/command_id
    const ph = phaseLines(r.stderr, "dispatch");
    check(ph.length === 5 && ph.filter((p) => p.phase === "send").length === 2 && ph.filter((p) => p.phase === "ack").length === 2 && ph[4]!.phase === "final",
      "⑦ phase 日志五拍齐（send×2/ack×2/final）");
    check(new Set(ph.map((p) => p.dispatch_id)).size === 1 && ph.every((p) => p.command_id === last.command_id),
      "⑦ 全拍同 dispatch_id/command_id（grep '" + '"dispatch_id"' + "' 单键可对账）");
    check(ph.map((p) => p.attempt).join(",") === "1,1,2,2,2" && ph[4]!.ok === false && (ph[3]!.error ?? "").includes("超时"),
      "⑦ attempt 随拍推进、ack 超时错误可判定、final ok=false");
    await close(wsServer);
  }

  // ═══════════ ⑧ deliver：超时态（桩迟应，CCR_TIMEOUT 调快） ═══════════
  {
    deliverMode = "slow";
    const portT = await listen(httpServer);
    const file = path.join(sandbox, "交付物.md");
    const auditBefore = readAudit().length;
    const r = await runCli("bash", [DELIVER, file], { ...envFor(portT), CCR_TIMEOUT: "1" });
    check(r.status !== 0, "⑧ 超时 → 非零退出");
    check(r.stderr.includes("无法连接 relay（超时") && r.stderr.includes("未静默丢单"), "⑧ 超时可判定文案 + 未静默丢单");
    const audit = readAudit();
    const last = audit[audit.length - 1]!;
    check(audit.length === auditBefore + 1 && last.ok === false && (last.error ?? "").includes("超时"),
      "⑧ DELIVER 审计 false 行 error 含超时");
    await close(httpServer);
  }

  // ═══════════ ⑨ deliver：--session 显式参数优先于 env 三级链 ═══════════
  {
    deliverMode = "ok";
    const portT = await listen(httpServer);
    const file = path.join(sandbox, "交付物.md");
    const r = await runCli("bash", [DELIVER, "--session", "sess-explicit", file],
      { ...envFor(portT), CC_DECK_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "sess-env", CLAUDE_SESSION_ID: "" });
    check(r.status === 0, `⑨ --session 显式归因 exit 0（got ${r.status}，stderr=${r.stderr.slice(0, 200)}）`);
    const last = readAudit()[readAudit().length - 1]!;
    check(last.session_id === "sess-explicit" && last.ok === true, "⑨ 审计归因=显式参数（优先于 env 链）");
    const ph = phaseLines(r.stderr, "deliver");
    check(ph.length === 3 && ph.map((p) => p.phase).join(",") === "send,ack,final" && ph.every((p) => p.session_id === "sess-explicit"),
      "⑨ phase 日志三拍同显式归因（send/ack/final）");
    check(new Set(ph.map((p) => p.dispatch_id)).size === 1 && ph[2]!.ok === true, "⑨ phase 日志同 dispatch_id、final ok=true");
    await close(httpServer);
  }

  // ═══════════ ⑩ deliver：三级全缺 → stderr 警告不静默空值归因 ═══════════
  {
    deliverMode = "ok";
    const portT = await listen(httpServer);
    const file = path.join(sandbox, "交付物.md");
    const r = await runCli("bash", [DELIVER, file],
      { ...envFor(portT), CC_DECK_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "" });
    check(r.status === 0, "⑩ 全缺仍登记成功（警告不拦单）");
    check(r.stderr.includes("警告：session_id 全缺") && r.stderr.includes("挂错卡"), "⑩ stderr 明确警告（不静默空值归因）");
    const last = readAudit()[readAudit().length - 1]!;
    check(last.session_id === "", "⑩ 审计 session_id 空串如实落账");
    await close(httpServer);
  }

  // ═══════════ ⑪ dispatch-report：真账交叉对账（本轮真实 CLI 落账 → 四类判定） ═══════════
  {
    const r = await runCli("bash", [REPORT, "--json", AUDIT_LOG], childEnv);
    check(r.status === 1, "⑪ 对账 verdict=fail（orphan/timeout 在册）→ exit 1");
    const j = JSON.parse(r.stdout) as {
      verdict: string;
      counts: { success_commands: number; timeout: number; orphan: number; deliver_rows: number; bad_rows: number };
      items: { timeout: { dispatch_ids: string[] }[] };
    };
    check(j.verdict === "fail", "⑪ verdict fail");
    check(j.counts.success_commands === 2, "⑪ 成功 2（① attempt:1 与 ④ attempt:2 各一）");
    check(j.counts.timeout === 2, "⑪ timeout 2（③ 拒连重试用尽 + ⑦ 超时重试用尽）");
    check(j.counts.orphan === 1, "⑪ orphan 1（② 明确拒收 attempt:1 不属超时类）");
    check(j.counts.deliver_rows === 6, `⑪ DELIVER 行 6（got ${j.counts.deliver_rows}；counts=${JSON.stringify(j.counts)}）`);
    check(j.counts.bad_rows === 0, "⑪ 坏行 0（⑩ 空归因 DELIVER 行是已警告的合法账，不判坏行）");
    check(j.items.timeout.every((it) => Array.isArray(it.dispatch_ids) && it.dispatch_ids.length >= 1),
      "⑪ timeout 项携带 dispatch_ids（PM 对账键贯穿台账）");
  }

  console.log(`C1 cli three-state tests ${tests}/${tests} passed (sandbox=${sandbox})`);
}

main()
  .then(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((e) => {
    console.error(String(e && e.stack ? e.stack : e));
    process.exit(1);
  });
