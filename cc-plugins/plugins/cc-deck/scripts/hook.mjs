#!/usr/bin/env node
// CC Deck bridge hook：用户自开 CLI 会话 -> Relay 桥接（事件上报 + 远程审批 + cli_pid 定位）
// 设计约束：任何情况下静默 exit 0，绝不干扰 CLI（bridge.json 不存在 = Relay 没跑，立即退出）
// 单源双形态：本文件同时服务 dev 模式（relay/hooks/ -> ../data）与插件模式
// （build-plugin.mjs 复制到 cc-deck/scripts/hook.mjs -> ~/.cc-deck/data 优先）
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Relay 自己 spawn 的 CLI（managed 会话 / 标题生成）带 CCR_RELAY_CHILD=1，
// 不上报桥接（否则会注册成多余的外部会话，与 managed 双注册）
if (process.env.CCR_RELAY_CHILD) process.exit(0);

// dataDir：插件 relay（/cc-deck 启动）写 ~/.cc-deck/data，存在即优先；
// 否则回退本文件旁边的 ../data（dev 模式）
const pluginData = join(homedir(), ".cc-deck", "data");
const dataDir = existsSync(join(pluginData, "bridge.json"))
  ? pluginData
  : fileURLToPath(new URL("../data", import.meta.url));

// 诊断日志（事件名/工具名/pid，不含用户内容；超 256KB 截断防无限增长）
const diagFile = join(dataDir, "hook-debug.log");
function diag(line) {
  try {
    if (existsSync(diagFile) && statSync(diagFile).size > 256 * 1024) {
      writeFileSync(diagFile, "");
    }
    appendFileSync(diagFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// 定位 CLI 进程 pid（注入用）：hook 父链 node(hook)→bash×N→claude.exe，
// 向上走祖先跳过 bash/sh 层取第一个非 shell 进程（AttachConsole 同控制台任意进程均可，
// claude.exe 存活期=会话期，最稳）。缓存 session_id→pid，命中零开销；attach 失败时
// Relay 删缓存促下次事件重新定位（CLI 每次启动 session_id 变化，天然无陈旧）。
const SKIP_SHELL = /^(bash|sh)\.exe$/i;

async function resolveCliPid(sessionId) {
  const cacheUrl = join(dataDir, "cli-pids.json");
  try {
    const cache = JSON.parse(readFileSync(cacheUrl, "utf-8"));
    if (cache[sessionId]) return cache[sessionId];
  } catch {}

  let pid = 0;
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `$p=${process.ppid}; for($i=0;$i -lt 6 -and $p;$i++){ $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $proc){break}; "$p|$($proc.Name)"; $p=$proc.ParentProcessId }`],
      { encoding: "utf8", timeout: 8000 }).trim();
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+)\|(.+)$/.exec(line.trim());
      if (!m) continue;
      if (SKIP_SHELL.test(m[2])) continue;
      pid = Number(m[1]);
      break;
    }
  } catch (e) {
    diag("cli_pid walk fail: " + (e?.message ?? e));
  }

  if (pid > 0) {
    try {
      let cache = {};
      try { cache = JSON.parse(readFileSync(cacheUrl, "utf-8")); } catch {}
      cache[sessionId] = pid;
      const keys = Object.keys(cache);
      if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete cache[k];
      writeFileSync(cacheUrl, JSON.stringify(cache));
    } catch {}
  }
  return pid;
}

async function main() {
  const stdin = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // stdin 意外不关闭时兜底
    setTimeout(() => resolve(data), 2000).unref();
  });
  let j;
  try {
    j = JSON.parse(stdin);
  } catch (e) {
    diag("stdin parse fail: " + (e?.message ?? e) + " len=" + stdin.length);
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(dataDir, "bridge.json"), "utf-8"));
  } catch (e) {
    diag("bridge.json fail: " + (e?.message ?? e));
    return; // Relay 未运行
  }

  const event = j.hook_event_name ?? "";
  const session_id = j.session_id ?? "";
  const cli_pid = session_id ? await resolveCliPid(session_id) : 0;
  diag(`event=${event} session=${session_id.slice(0, 8)} mode=${j.permission_mode ?? ""} tool=${j.tool_name ?? ""} tu=${j.tool_use_id ? String(j.tool_use_id).slice(0, 12) : "-"} cli_pid=${cli_pid || "-"}`);
  const body = {
    event,
    session_id,
    cwd: j.cwd ?? "",
    permission_mode: j.permission_mode,
    transcript_path: j.transcript_path,
    prompt: j.prompt,
    tool_name: j.tool_name,
    tool_use_id: j.tool_use_id,
    tool_input: j.tool_input,
    tool_response: j.tool_response,
    message: j.message,
    reason: j.reason,
    cli_pid: cli_pid || undefined,
  };

  // PreToolUse 等远程审批（最长 600s，须 < settings.json 里该 hook 的 timeout 620s）
  const waitMs = event === "PreToolUse" ? 600_000 : 1500;
  const res = await Promise.race([
    fetch(`http://127.0.0.1:${cfg.port}/bridge/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": cfg.token },
      body: JSON.stringify(body),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), waitMs).unref?.()),
  ]).catch((e) => {
    diag("post fail: " + (e?.message ?? e));
    return null;
  });
  if (res) diag(`post ok: ${res.status}`);

  // 仅 PreToolUse 需要把决定回给 CLI；其余事件纯旁路
  if (event === "PreToolUse" && res && res.ok) {
    const d = await res.json().catch(() => null);
    if (d && (d.decision === "allow" || d.decision === "deny")) {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: d.decision,
          ...(d.reason ? { permissionDecisionReason: d.reason } : {}),
          ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}),
        },
      };
      // 等 flush 完成再退出，避免管道下 stdout 被截断
      await new Promise((r) => process.stdout.write(JSON.stringify(out), r));
    }
    // decision === "pass" 或超时：无输出，CLI 走正常权限流程
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
