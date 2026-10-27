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
// 任意进程均可，claude.exe 存活期=会话期，最稳）。平台：win32 走 powershell CIM；
// macOS/Linux 走 ps（登录 shell comm 可能带前导 -）。
// #113 根修（2026-10-15）：walk 结果永远权威，缓存只做两级兜底——
// ①快路径：缓存 pid 恰为直接父进程（hook 由 CLI 直接拉起的常态）零探测采信；
// ②walk 失败才回落缓存，且缓存 pid 仍须存活且为 CLI 映像（死 pid 不上报，
//   relay 保留原定位，不给死亡扫描喂误报）。
// 旧实现缓存优先 +「CLI 每次启动 session_id 变化天然无陈旧」的假设对
// `claude --resume <id>` 不成立：resume 复用同 session_id 换新进程，旧缓存 pid
// 已死却永久命中，hook 一直上报死 pid → relay 死亡扫描反复误报「CLI 进程已退出」
//（生产 ext-29ab 单会话 4 小时 102 连报实锤）。attach 失败时 Relay 删缓存促重新
// 定位的语义不变（walk 成功即回写缓存）。
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

// 缓存兜底前的存活校验：pid 须仍存活且映像为 CLI 宿主（claude|node），与 relay 侧
// cliHostAlive 同语义。win32 无轻量探测（tasklist 重），回落时原样采信（relay 侧
// 映像校验兜底）
function cachedPidLooksAlive(execFileSync, pid) {
  try {
    const line = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000 }).trim();
    const name = (line.split("/").pop() ?? "").replace(/^-+/, "");
    return /^(claude|node)(\.exe)?$/i.test(name);
  } catch {
    return false;
  }
}

async function resolveCliPid(sessionId) {
  const cacheUrl = join(dataDir, "cli-pids.json");
  let cached = 0;
  try {
    cached = JSON.parse(readFileSync(cacheUrl, "utf-8"))[sessionId] ?? 0;
  } catch {}
  // 快路径：缓存 pid 恰为直接父进程（hook 由 CLI 直接拉起的常态）→ 零探测采信
  if (cached > 0 && cached === process.ppid) return cached;

  let execFileSync = null;
  let pid = 0;
  try {
    ({ execFileSync } = await import("node:child_process"));
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
    return pid;
  }

  // walk 失败才回落缓存：死 pid / 非 CLI 映像不上报（relay 保留原定位，
  // 不给死亡扫描喂误报）
  if (cached > 0 && execFileSync) {
    if (process.platform === "win32" || cachedPidLooksAlive(execFileSync, cached)) return cached;
    diag(`cli_pid cache stale: session=${sessionId.slice(0, 8)} pid=${cached}`);
  }
  return 0;
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

  // PreToolUse 等远程审批（最长 600s，须 < settings.json 里该 hook 的 timeout 620s）。
  // 旁路事件 1500→3000（2026-10-09）：relay 主线程高负载时事件循环阻塞普遍 >1.5s
  //（实测 UserPromptSubmit 广播滞后 6.6s），1.5s 短窗在回合首尾（relay 正忙）必撞
  // #279 SessionStart（广播注入）：会话启动路径——短窗 2s、单轮不重试，宁可这次
  // 不注入也不拖慢开局（下次 resume/clear 还有机会；relay 不在=无输出静默降级）
  const waitMs = event === "PreToolUse" ? 600_000 : event === "SessionStart" ? 2000 : 3000;
  // 逐候选上报：403（token 失配）/连不上（relay 未起或换班）就试下一目录的
  // bridge.json；命中 2xx 即止。多数时候首轮即成功，失配期多花一次本地请求
  // 外层补 3 轮整体重试（2s/4s 退避，仅旁路事件）：relay 热替换重启窗口约 5~8s，
  // 旁路事件短等撞上即丢（审批/通知凭空消失的根因之一）；PreToolUse 的
  // 600s 长等天然覆盖重启窗口，无需多轮
  const rounds = event === "PreToolUse" || event === "SessionStart" ? 1 : 3;
  let res = null;
  for (let round = 0; round < rounds && !res; round++) {
    if (round) await new Promise((r) => setTimeout(r, 2000 * round).unref?.());
    for (let i = 0; i < cfgs.length; i++) {
      const c = cfgs[i];
      // 超时经 AbortController 真正中止未决 fetch，且超时 timer 不再 unref：原先
      // race 输掉后 fetch 的 socket 仍持着事件循环引用的假象——一旦 socket 已死
      //（relay 忙时 ECONNRESET 很常见），只剩 unref 的重试 timer，事件循环排空、
      // 整个 hook 进程提前退出，r1/r2 重试静默失效（2026-10-09 hook-debug 实证：
      // r0 超时后无任何 r1 记录）。AbortController 让超时语义落在 fetch 本体上
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(new Error("timeout")), waitMs);
      try {
        res = await fetch(`http://127.0.0.1:${c.port}/bridge/hook`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bridge-token": c.token },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        diag(`post fail (r${round} ${i}): ` + (ac.signal.reason?.message ?? e?.message ?? e));
        res = null;
        continue;
      } finally {
        clearTimeout(to);
      }
      if (res && res.ok) {
        diag(`post ok (r${round} ${i})`);
        break;
      }
      diag(`post ${res ? res.status : "?"} (r${round} ${i})，回退下一候选`);
      res = null;
    }
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

  // #279 SessionStart 广播回传：relay 决策携带 {context} → additionalContext 注入
  //（CLI 把它并入会话启动上下文，野生会话由此得知 cc-deck 在场）。无 context/
  // 超时/relay 不在：零输出静默降级，会话照常启动——广播是增益不是依赖。
  // 存量兼容：老 relay 不认识 SessionStart 事件也回 2xx（dispatchInner default
  // pass，无 context 字段）→ 同样零输出，双端任一旧版本均不炸
  if (event === "SessionStart" && res && res.ok) {
    const d = await res.json().catch(() => null);
    const ctx = d && typeof d.context === "string" ? d.context.trim() : "";
    if (ctx) {
      const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
      await new Promise((r) => process.stdout.write(JSON.stringify(out), r));
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
