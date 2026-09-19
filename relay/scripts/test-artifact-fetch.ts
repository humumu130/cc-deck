// #79 输出物远程拉取专项（纯单元）：授权锚点 / 大小上限 / 分块重组 / 幂等重放
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { ArtifactChunkPayload, Command } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-artifact-fetch/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

const bus = new EventBus();
const mgr = new SessionManager(bus, loadConfig());

// 瞬态帧捕获
const chunks: { env: ArtifactChunkPayload; ts: number }[] = [];
bus.subscribe((env) => {
  if (env.type === "ARTIFACT_CHUNK") chunks.push({ env: env.payload as ArtifactChunkPayload, ts: Date.now() });
});
const fetchCmd = (sid: string, path: string, cid: string) =>
  mgr.handleCommand({ command_id: cid, type: "COMMAND_ARTIFACT_FETCH", payload: { session_id: sid, path }, ts: Date.now() } as Command, "test");

// 会话 + 登记两个真实文件
mgr.ensureExternal("ext-af-1", ROOT, "拉取测试");
const okFile = join(ROOT, "报告.html");
const body = "<html><body>夜间工作报告".repeat(90_000) + "</body></html>"; // ~1.6MB → 4 块
writeFileSync(okFile, body, "utf-8");
const secretFile = join(ROOT, "机密.txt");
writeFileSync(secretFile, "不该被跨会话拉取", "utf-8");
// 机密登记到另一个会话（授权锚点必须按会话隔离）
mgr.ensureExternal("ext-af-2", ROOT, "另一个会话");
mgr.registerDeliverable("ext-af-2", secretFile);
mgr.registerDeliverable("ext-af-1", okFile);

// ---------- S1 授权锚点 ----------
{
  const r1 = fetchCmd("ext-af-1", okFile, "af-1");
  assert(r1.ok && r1.artifact?.size === Buffer.byteLength(body), `S1 已登记路径 ok（size=${r1.artifact?.size}）`);
  assert(r1.artifact?.mime === "text/html", `S1 mime 推导 html got=${r1.artifact?.mime}`);
  const r2 = fetchCmd("ext-af-1", secretFile, "af-2");
  assert(!r2.ok && /无权拉取/.test(r2.error ?? ""), `S1 其它会话的登记路径拒绝 got=${r2.error}`);
  const r3 = fetchCmd("ext-af-1", join(ROOT, "../../etc/passwd"), "af-3");
  assert(!r3.ok, "S1 路径穿越拒绝（未登记即拒）");
  const r4 = fetchCmd("ext-af-1", okFile + ".bak", "af-4");
  assert(!r4.ok, "S1 同目录未登记文件拒绝");
  const r5 = fetchCmd("ext-af-nope", okFile, "af-5");
  assert(!r5.ok, "S1 不存在的会话拒绝");
}

// ---------- S2 大小上限（稀疏文件，不实写 20MB） ----------
{
  const big = join(ROOT, "大文件.zip");
  writeFileSync(big, "z"); // truncate 不建文件，先落 1 字节
  truncateSync(big, 20 * 1024 * 1024 + 1);
  mgr.registerDeliverable("ext-af-1", big);
  const r = fetchCmd("ext-af-1", big, "af-6");
  assert(!r.ok && /20MB/.test(r.error ?? ""), `S2 超 20MB 拒绝 got=${r.error}`);
  const gone = join(ROOT, "已删除.md");
  writeFileSync(gone, "x");
  mgr.registerDeliverable("ext-af-1", gone);
  rmSync(gone);
  const rg = fetchCmd("ext-af-1", gone, "af-7");
  assert(!rg.ok && /不存在/.test(rg.error ?? ""), `S2 已删除文件拒绝 got=${rg.error}`);
}

// ---------- S3 分块重组（乱序容忍） ----------
{
  const dataFrames = chunks.filter((c) => c.env.ref === "af-1" && typeof c.env.seq === "number");
  const total = dataFrames[0]?.env.total ?? 0;
  assert(total === Math.ceil(Buffer.byteLength(body) / (512 * 1024)), `S3 块数正确 total=${total}`);
  // 客户端口径重组：按 seq 归位（模拟乱序到达）
  const slots = new Array<number>(total).fill(-1);
  for (const c of dataFrames) slots[c.env.seq!] = c.ts;
  assert(dataFrames.length === total && slots.every((t, i) => t > 0), `S3 全部 ${total} 块到达且 seq 连续`);
  const reassembled = Buffer.concat(
    [...dataFrames].sort(() => Math.random() - 0.5).map((c) => Buffer.from(c.env.b64 ?? "", "base64")),
  );
  // 乱序拼接按 b64 原文顺序错了没关系——客户端按 seq 归位后再拼，这里按 seq 排序模拟
  const ordered = [...dataFrames].sort((a, b) => a.env.seq! - b.env.seq!).map((c) => Buffer.from(c.env.b64 ?? "", "base64"));
  const reassembledOrdered = Buffer.concat(ordered);
  assert(reassembledOrdered.toString("utf-8") === body, `S3 按 seq 归位重组与原文一致（${reassembledOrdered.length}B）`);
  assert(chunks.some((c) => c.env.ref === "af-1" && c.env.done === true), "S3 成功尾帧 done");
}

// ---------- S4 幂等重放不重发数据 ----------
{
  const before = chunks.filter((c) => c.env.ref === "af-1").length;
  const dup = fetchCmd("ext-af-1", okFile, "af-1");
  const after = chunks.filter((c) => c.env.ref === "af-1").length;
  assert(dup.duplicate === true && before === after, `S4 同 command_id 幂等（帧数 ${before}→${after}，ack.duplicate=${dup.duplicate}）`);
}

// ---------- S5 瞬态语义：不落盘不进缓冲 ----------
{
  const persist = join(ROOT, "datadir", "events.ndjson");
  let sawChunk = false;
  try {
    for (const l of (await import("node:fs")).readFileSync(persist, "utf-8").split("\n")) {
      if (l.includes("ARTIFACT_CHUNK")) sawChunk = true;
    }
  } catch {}
  assert(!sawChunk, "S5 ARTIFACT_CHUNK 不落 events.ndjson（瞬态）");
  assert(bus.replayAfter(0).every((e) => e.type !== "ARTIFACT_CHUNK"), "S5 不进事件缓冲（重连不补发）");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nARTIFACT FETCH TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
