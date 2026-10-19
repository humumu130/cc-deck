#!/usr/bin/env node
// Stop hook（CLAUDE.md 任务调度准则第 6 条）：会话收工时若存在可执行待办
// （pending/in_progress，豁免 [搁置]/[常驻]/parked），拦截并要求继续；
// 60 秒内第二次停止即放行（确需收工：等待用户/被阻塞）。
// 输出契约：{"decision":"block","reason":"..."}（官方文档 Stop decision control）。
// 连续 block 8 次后 CLI 会强制结束（文档护栏，无需自行计数）。
//
// 远程模式豁免（2026-09-14）：用户通过云桥远程操控时（Mac 无人），Stop hook 的
// 拦截会触发 CLI 空转轮次，输出 "No response requested." 并推送到远程设备——
// 用户看到的是这个而不是实际回复。远程活跃时（relay events 近期有更新）
// 不拦截，避免空转推送。
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readTasks, actionable, summarize, readStdin } from "./task-lib.mjs";

const STATE_DIR = join(homedir(), ".claude", "hooks", ".state");
const DOUBLE_STOP_MS = 60_000;

// 远程模式检测：relay events.ndjson 近 3 分钟内有更新 = 可能有远程设备在操控。
// 此时 Stop hook 不拦截（拦截会造成 "No response requested." 空转推送到远程设备）
async function isRemoteActive(mySid) {
  try {
    const eventsPath = join(homedir(), ".cc-deck", "data", "events.ndjson");
    const st = statSync(eventsPath);
    if ((Date.now() - st.mtimeMs) >= 3 * 60_000) return false;
    // A5 精化：尾扫最近 4KB 只认 session_id ≠ 本会话的帧（原全局 mtime 在多 worker
    // 并行时恒真——任何一个 worker 写事件都算"远程活跃"，本会话的待办拦截被吃掉）。
    // 解析失败/无 sid 可比回落 false（放行面不变、拦截面恢复）；失败回落全局
    // mtime 保底，比恒真弱但比误杀好。
    const my = (mySid ?? "").replace(/[^a-f0-9-]/g, "").slice(0, 8);
    const { openSync, readSync } = await import("node:fs");
    const size = Math.min(4096, st.size);
    const fd = openSync(eventsPath, "r");
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    const tail = buf.toString("utf-8");
    for (const line of tail.split("\n")) {
      const i = line.indexOf('"session_id"');
      if (i < 0) continue;
      // W-SMALLFIX A5 补修：seg 截 18 字符 vs my 截 8 字符长度不对齐——
      // `seg !== my` 对本会话帧恒真（S1 场景实测 FAIL=拦截永远被吃）。按 my 的
      // 实际长度对齐比较（my 为空=无可比，保持 false 不误放）
      const seg = line.slice(i + 14, i + 14 + Math.max(8, my.length)).replace(/[^a-f0-9-]/g, "");
      if (my && seg && seg.slice(0, my.length) !== my) return true; // 异会话活跃帧
    }
    return false; // 尾窗内只有本会话帧：非远程，恢复拦截
  } catch { return false; }
}

const input = await readStdin();
if (!input.transcript_path) process.exit(0);

const tr = await readTasks(input);
const list = actionable(tr);
if (!list.length) process.exit(0); // 无可执行待办：正常放行

// 远程活跃时不拦截（拦截 → CLI 空转 → "No response requested." 推送到远程设备）
const sid0 = String(input.session_id ?? "");
if (await isRemoteActive(sid0)) process.exit(0);

const sid = String(input.session_id ?? "default");
const stampFile = join(STATE_DIR, `task-stop-${sid.replace(/[^a-zA-Z0-9-]/g, "")}.ts`);
let lastBlock = 0;
try { lastBlock = Number(readFileSync(stampFile, "utf8")) || 0; } catch {}

// 60s 内第二次停止：确需收工，放行（不清理 stamp 也无妨——下次 block 会重写）
if (Date.now() - lastBlock < DOUBLE_STOP_MS) {
  // A4 软兜底：带单收工场景放行前给一句固化提醒（stderr 可见；不 block 不改拦截语义）
  process.stderr.write(`[task-stop] 放行收工：仍有 ${list.length} 条可执行待办未完成，会话结束将丢失——建议先固化到 memory 或继续处理。\n`);
  process.exit(0);
}

try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(stampFile, String(Date.now())); } catch {}

process.stdout.write(JSON.stringify({
  decision: "block",
  reason: `仍有 ${list.length} 条可执行待办（准则：空闲主动拉单，FIFO/优先级先行；[搁置] 已豁免）：\n${summarize(list)}\n\n继续处理；确需收工（等待用户/被阻塞），请在 60 秒内再次停止即放行。`,
}));
process.exit(0);
