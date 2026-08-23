#!/usr/bin/env node
// Cloud Code Relay bridge hook：用户自开 CLI 会话 -> Relay 单向桥接
// 设计约束：任何情况下静默 exit 0，绝不干扰 CLI（bridge.json 不存在 = Relay 没跑，立即退出）
import { readFileSync, appendFileSync } from "node:fs";

// 诊断日志（排查 hooks 是否触发/为何失败；确认链路稳定后可移除）
function diag(line) {
  try {
    appendFileSync(new URL("../data/hook-debug.log", import.meta.url), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

async function main() {
  diag("invoked");
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
    cfg = JSON.parse(readFileSync(new URL("../data/bridge.json", import.meta.url), "utf-8"));
  } catch (e) {
    diag("bridge.json fail: " + (e?.message ?? e));
    return; // Relay 未运行
  }

  const event = j.hook_event_name ?? "";
  diag(`event=${event} session=${(j.session_id ?? "").slice(0, 8)} mode=${j.permission_mode ?? ""}`);
  const body = {
    event,
    session_id: j.session_id ?? "",
    cwd: j.cwd ?? "",
    permission_mode: j.permission_mode,
    prompt: j.prompt,
    tool_name: j.tool_name,
    tool_input: j.tool_input,
    tool_response: j.tool_response,
    message: j.message,
    reason: j.reason,
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
