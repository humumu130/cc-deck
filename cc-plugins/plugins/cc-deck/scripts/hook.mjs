#!/usr/bin/env node
// CC Deck bridge hook：用户自开 CLI 会话 -> Relay 桥接（事件上报 + 远程审批 + cli_pid 定位）
// 设计约束：任何情况下静默 exit 0，绝不干扰 CLI（bridge.json 不存在 = Relay 没跑，立即退出）
// 单源双形态：本文件同时服务 dev 模式（relay/hooks/ -> ../data）与插件模式
// （build-plugin.mjs 复制到 cc-deck/scripts/hook.mjs -> ~/.cc-deck/data 优先）
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Relay 自己 spawn 的 CLI（managed 会话 / 标题生成）带 CCR_RELAY_CHILD=1，
// 不上报桥接（否则会注册成多余的外部会话，与 managed 双注册）
if (process.env.CCR_RELAY_CHILD) process.exit(0);

// dataDir 候选：插件 relay（/cc-deck 启动）写 ~/.cc-deck/data（hook 首选）；
// 另收本文件旁 ./data 与 ../data（直装 ~/.cc-deck/ 与开发仓 relay/hooks/ 布局）。
// 候选取"存在 bridge.json"者，POST 403/连不上时逐个回退——dev/插件两个 relay
// 换班持端口时首选目录的 token 可能短暂失配，绝不因单点 403 丢事件（#211）
const pluginData = join(homedir(), ".cc-deck", "data");
const selfDir = fileURLToPath(new URL(".", import.meta.url));
const dataDirs = [...new Set([pluginData, join(selfDir, "data"), join(selfDir, "..", "data")])]
  .filter((d) => existsSync(join(d, "bridge.json")));
const dataDir = dataDirs[0] ?? join(selfDir, "..", "data");

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

// 双注册去重：hook 同时挂在 settings.json 与插件 hooks.json 上（老会话插件 hook
// 会失效，settings 级是保底），同一事件会被 CLI 双发、毫秒级重复到达。文件级原子锁
//（wx 独占创建 + 事件内容 hash + TTL）保证只有第一个实例上报；任何异常都放行——
// 宁可偶发双发，绝不丢事件
const DEDUP_TTL_MS = 5000;
function onceByKey(key) {
  try {
    const dir = join(dataDir, "hook-dedup");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, key + ".mark");
    try {
      writeFileSync(f, String(Date.now()), { flag: "wx" });
    } catch (e) {
      if (e?.code !== "EEXIST") return true;
      try {
        if (Date.now() - statSync(f).mtimeMs < DEDUP_TTL_MS) return false;
        rmSync(f);
        writeFileSync(f, String(Date.now()), { flag: "wx" });
      } catch {}
    }
    try {
      for (const g of readdirSync(dir)) {
        const p = join(dir, g);
        try { if (Date.now() - statSync(p).mtimeMs > 60_000) rmSync(p); } catch {}
      }
    } catch {}
    return true;
  } catch {
    return true;
  }
}

// 定位 CLI 进程 pid（注入用）：hook 父链 node(hook)→shell×N→CLI 宿主，
// 向上走祖先跳过 shell 层取第一个非 shell 进程（Windows 上 AttachConsole 同控制台
// 任意进程均可，claude.exe 存活期=会话期，最稳）。缓存 session_id→pid，命中零开销；
// attach 失败时 Relay 删缓存促下次事件重新定位（CLI 每次启动 session_id 变化，天然无陈旧）。
// 平台：win32 走 powershell CIM；macOS/Linux 走 ps（登录 shell comm 可能带前导 -）
const SKIP_SHELL = /^-?(bash|sh|zsh|fish|dash|ksh)(\.exe)?$/i;

function walkAncestorsWindows(execFileSync) {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `$p=${process.ppid}; for($i=0;$i -lt 6 -and $p;$i++){ $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $proc){break}; "$p|$($proc.Name)"; $p=$proc.ParentProcessId }`],
    { encoding: "utf8", timeout: 8000 }).trim();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\|(.+)$/.exec(line.trim());
    if (!m) continue;
    if (SKIP_SHELL.test(m[2])) continue;
    return Number(m[1]);
  }
  return 0;
}

function walkAncestorsUnix(execFileSync) {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 0; i++) {
    const line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5000 }).trim();
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (!m) break;
    // macOS comm 是完整路径（/bin/zsh、/opt/homebrew/bin/node），先取 basename；
    // 登录 shell argv[0] 带前导 -
    const name = (m[2].trim().split("/").pop() ?? "").replace(/^-+/, "");
    if (!SKIP_SHELL.test(name)) return pid;
    pid = Number(m[1]);
  }
  return 0;
}

async function resolveCliPid(sessionId) {
  const cacheUrl = join(dataDir, "cli-pids.json");
  try {
    const cache = JSON.parse(readFileSync(cacheUrl, "utf-8"));
    if (cache[sessionId]) return cache[sessionId];
  } catch {}

  let pid = 0;
  try {
    const { execFileSync } = await import("node:child_process");
    pid = process.platform === "win32" ? walkAncestorsWindows(execFileSync) : walkAncestorsUnix(execFileSync);
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

  const cfgs = [];
  for (const d of dataDirs) {
    try {
      const c = JSON.parse(readFileSync(join(d, "bridge.json"), "utf-8"));
      if (c && c.port && c.token) cfgs.push(c);
    } catch (e) {
      diag("bridge.json fail (" + d + "): " + (e?.message ?? e));
    }
  }
  if (!cfgs.length) return; // Relay 未运行

  const event = j.hook_event_name ?? "";
  const session_id = j.session_id ?? "";
  if (!session_id) return;
  const dedupKey = createHash("md5")
    .update(JSON.stringify([event, session_id, j.tool_name ?? "", j.tool_use_id ?? "", j.prompt ?? null, j.message ?? null]))
    .digest("hex")
    .slice(0, 16);
  if (!onceByKey(dedupKey)) return;
  const cli_pid = await resolveCliPid(session_id);
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
  // 逐候选上报：403（token 失配）/连不上（relay 未起或换班）就试下一目录的
  // bridge.json；命中 2xx 即止。多数时候首轮即成功，失配期多花一次本地请求
  let res = null;
  for (let i = 0; i < cfgs.length; i++) {
    const c = cfgs[i];
    try {
      res = await Promise.race([
        fetch(`http://127.0.0.1:${c.port}/bridge/hook`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bridge-token": c.token },
          body: JSON.stringify(body),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), waitMs).unref?.()),
      ]);
    } catch (e) {
      diag(`post fail (${i}): ` + (e?.message ?? e));
      res = null;
      continue;
    }
    if (res && res.ok) {
      diag(`post ok (${i})`);
      break;
    }
    diag(`post ${res ? res.status : "?"} (${i})，回退下一候选`);
    res = null;
  }

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
