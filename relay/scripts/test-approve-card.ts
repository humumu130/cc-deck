// W-APPROVE #232 单元断言：审批卡远程批准（被动卡按键注入）+ worker 派单预授权。
// 三段：①B 面 evaluatePermission dispatch 语义（纯函数）；②A 面 injectPendingDecision
// 预检分支（in-process mgr+bridge，假注入器环境）；③成功路径 E2E（真 tmux pane 假弹
// 窗脚本——验证 resolveTmuxTarget→send-keys→capture 验证→emitWaitingResolved 全链；
// 无 tmux 环境自动 skip）。跑法：cd relay && npx tsx scripts/test-approve-card.ts
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import { evaluatePermission, engineCapabilityState } from "../src/permission-policy.js";
import { permDialogKeyFrom } from "../src/injector.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass += 1;
    console.log(`ok - ${msg}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${msg}`);
  }
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- 沙盒隔离（test-bridge 同款全参数） ----------
const root = mkdtempSync(join(tmpdir(), "ccdeck-approve-"));
process.env.CCR_PORT = "8799";
process.env.CCR_TOKEN = "approve-token";
process.env.CCR_BRIDGE_TOKEN = "approve-bridge-token";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_DATA_DIR = join(root, "data");
process.env.CCR_ORG_DIR = join(root, "org");
process.env.CCR_PROJECTS_ROOT = join(root, "projects");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-cfg");
process.env.CCR_NO_LEADER = "1";
process.env.CCR_DEAD_SWEEP = "0";
process.env.CCR_NO_TERM_LINE = "1";
// ② 段走 resolveTmuxTarget 恒 null（CCR_OSASCRIPT_CMD 逃生门=tmux 定位跳过）→ 注入
// 失败路径稳定；③ 段 tmux E2E 前删除（真 tmux 通道）。不用 CCR_INJECT_CMD——它会把
// useAppleInjector 翻 false，而 injectPermChoice 的 tmux 通道与假注入器正交（#232 修正）
process.env.CCR_OSASCRIPT_CMD = join(root, "fake-osascript.sh");
writeFileSync(process.env.CCR_OSASCRIPT_CMD, "#!/bin/sh\nexit 0\n");

// ---------- ① B 面：dispatch 预授权语义（evaluatePermission 纯函数） ----------
{
  const base = {
    requested_mode: "bypassPermissions",
    engine: "claude",
    role: "worker",
    tier: "正经立项",
    capability_state: engineCapabilityState("claude"),
    policy_source: "tier_default",
    dir_scope: "production",
    env: "production",
    user_authorized_bypass: false,
  } as const;
  const ok = evaluatePermission({ ...base, skip_confirm_checked: true });
  assert(ok.effective_mode === "full-auto" && (ok.reason ?? "").includes("skip_confirm_authorized"),
    `dispatch 面勾选语义：生产 bypass 即放（${ok.effective_mode}/${ok.reason}）`);
  const deniedRow = evaluatePermission({ ...base });
  assert(deniedRow.effective_mode === "forbidden" && deniedRow.reason === "production_bypass_denied",
    `create 面未勾选回归守卫：生产未授权仍 forbidden（${deniedRow.reason}）`);
  const sandbox = evaluatePermission({ ...base, skip_confirm_checked: true, dir_scope: "sandbox", env: "sandbox" });
  assert(sandbox.effective_mode === "full-auto", "sandbox 环境勾选即放（零环境闸路径）");
  const authorized = evaluatePermission({ ...base, user_authorized_bypass: true });
  assert(authorized.effective_mode === "full-auto" && (authorized.reason ?? "").includes("user_authorized"),
    "授权位路径语义不变（#69 兼容）");
  const unknownEnv = evaluatePermission({ ...base, skip_confirm_checked: true, dir_scope: "unknown", env: "unknown" });
  assert(unknownEnv.effective_mode === "full-auto", "unknown 环境勾选同样放行（口径②：用户已同意）");
}

// ---------- ①b 键位解析 fail-closed（W-KEYFIX，W-REV54-B P1/P2 修复面） ----------
{
  const hist = "⎿ 1. Yes\n（上轮应答留痕）\n";
  const dialog = "Bash command\n Create empty file\n Do you want to proceed?\n 1. Yes\n 2. Yes, and always allow access\n 3. No\n";
  // 反方攻击 1a 构造复跑（验收点 1）：历史留痕在场 + 当前弹窗——解析必须落锚后当前选项
  assert(permDialogKeyFrom(hist + dialog, "allow") === "1", "1a 复跑：历史留痕在场，allow 解析锚后当前弹窗 1. Yes（不落历史区重复行）");
  assert(permDialogKeyFrom(hist + dialog, "deny") === "3", "1a 复跑：deny 唯一性保持（解析 3. No）");
  // 攻击形态变体：当前弹窗首选项带后缀（无行尾 Yes）→ fail-closed null 不注（旧实现落历史 "1"）
  const drift = hist + "Do you want to proceed?\n 1. Yes, and always allow access\n 2. Yes, and switch to auto mode\n 3. No\n";
  assert(permDialogKeyFrom(drift, "allow") === null, "形态漂移 fail-closed：无行尾 Yes → null 不注入（旧实现误落历史 1）");
  assert(permDialogKeyFrom(drift, "deny") === "3", "形态漂移 deny 仍可达（3. No 在锚后域）");
  // 锚缺失（弹窗不在屏/形态完全不同）→ null
  assert(permDialogKeyFrom("random output\n1. Yes\n2. No\n", "allow") === null, "锚缺失 fail-closed：无 proceed 锚 → null（旧实现误落裸文本编号行）");
  // 正常校准形态回归（原批行为一致，验收点 3）
  assert(permDialogKeyFrom("Do you want to proceed?\n 1. Yes\n 2. Yes, and always allow access to /tmp from this project\n 3. Yes, and switch to auto mode\n 4. No\n", "allow") === "1", "校准形态回归：allow=1");
  assert(permDialogKeyFrom("Do you want to proceed?\n 1. Yes\n 2. Yes, and always allow access to /tmp from this project\n 3. Yes, and switch to auto mode\n 4. No\n", "deny") === "4", "校准形态回归：deny=4");
}

// ---------- ② A 面：injectPendingDecision 预检分支 ----------
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const { bridge } = startServer(bus, mgr, cfg, { holdMs: 5000, questionHoldMs: 800, gateToolsRaw: "Bash,Edit" });
await wait(300);
const SID = "ext-cli-appr";

{
  // 无会话
  assert(bridge.injectPendingDecision("ext-nope", "r0", "allow", "t") !== null, "未知会话拒绝受理");
  mgr.ensureExternal("ext-cli-appr", root, "测试任务");
  // 无 waiting
  assert(bridge.injectPendingDecision(SID, "r1", "allow", "t") !== null, "无 waiting_request 拒绝受理");
  // 门控挂起态（decidable=true）不走注入
  mgr.setExternalWaiting(SID, { request_id: "r-gate", tool_name: "Bash", input_summary: "ls", suggestions: [], decidable: true });
  assert(bridge.injectPendingDecision(SID, "r-gate", "allow", "t")?.includes("远程审批挂起"), "门控挂起态指回 CONTINUE 正路");
  // ask 类 passive 拒绝
  mgr.setExternalWaiting(SID, { request_id: "r-ask", tool_name: "AskUserQuestion", input_summary: "q", suggestions: [], decidable: false, questions: [{ question: "q?", header: "H", options: [], multi: false }] } as never);
  assert(bridge.injectPendingDecision(SID, "r-ask", "allow", "t")?.includes("作答通道"), "ask 类 passive 指回 COMMAND_ANSWER");
  // pid 缺失
  mgr.setExternalWaiting(SID, { request_id: "r2", tool_name: "Bash", input_summary: "ls -la", suggestions: [], decidable: false, received_at: Date.now() });
  assert(bridge.injectPendingDecision(SID, "r2", "allow", "t")?.includes("CLI 进程未定位"), "pid 缺失拒绝并给可读文案");
  // 受理（pid 在场；假注入器→resolveTmuxTarget null→异步失败路径：inFlight 清+横幅保留+日志留痕）
  mgr.setExternalCliPid(SID, process.pid); // 借自身 pid（tty 非-tmux，定位 null 路径稳定）
  assert(bridge.injectPendingDecision(SID, "r2", "allow", "tester") === null, "预检通过受理（返回 null）");
  assert(bridge.isInjectInFlight(SID) === true, "受理后 inFlight 置位（注入验证进行中）");
  await wait(1500); // 异步注键+验证窗（macTargetIsCliHost 过（node 进程）→tmux 定位 null→失败路径）
  assert(bridge.isInjectInFlight(SID) === false, "异步完成后 inFlight 清除");
  const st = mgr.getExternal(SID);
  assert(!!st && st.status === "WAITING" && st.waiting_request?.request_id === "r2", "失败路径横幅保留（可重试，不静默收卡）");
  const logs = mgr.getExternalLogs(SID).map((e) => e.text).join("\n");
  assert(logs.includes("远程批准未生效"), "失败留时间线日志（system 行）");
}

// ---------- ③ 成功路径 E2E（真 tmux 假弹窗；无 tmux 自动跳过） ----------
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
if (!hasTmux) {
  console.log("skip - 无 tmux 环境，成功路径 E2E 跳过（键位校准与通道验证需真 tmux）");
} else {
  delete process.env.CCR_OSASCRIPT_CMD; // ③ 段走真 tmux 定位（② 段逃生门关闭）
  // pane 用 node 跑（进程名 node 过 macTargetIsCliHost 的 VALID_TARGET 守卫——bash 会被
  // pid 防护拒掉）。脚本：显示弹窗特征行→raw 单键读→收到 1/3 清屏打标记（特征行离屏
  // =injectPermChoice 的 capture 验证通过）
  const markScript = join(root, "pane-mark.js");
  // 真弹窗屏面仿真（2026-10-23 校准形态）+ 历史区留痕行（W-REV54-B P1 攻击形态）：
  // 锚前有上轮弹窗留痕「1. Yes」——解析域限定 proceed 锚后，allow/deny 都必须命中
  // 当前弹窗选项（1/3）而非历史行（首匹配旧实现会落历史 "1"）
  writeFileSync(markScript, `const mark = process.argv[2] || "MARK";
process.stdout.write("⎿ 1. Yes\\n（上轮应答留痕）\\n Bash command\\n Create empty file\\n Do you want to proceed?\\n 1. Yes\\n 2. Yes, and always allow access\\n 3. No\\n");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.once("data", (d) => {
  const k = d.toString();
  process.stdout.write("\\x1b[2J\\x1b[H");
  if (k === "1") process.stdout.write(mark + "-ALLOW\\n");
  else if (k === "3") process.stdout.write(mark + "-DENY\\n");
  else process.stdout.write(mark + "-OTHER:" + JSON.stringify(k) + "\\n");
});
`);
  const mkPane = (name: string, mark: string): number => {
    try { execSync(`tmux kill-session -t ${name}`, { stdio: "ignore" }); } catch {}
    execSync(`tmux new-session -d -s ${name} "node ${markScript} ${mark}"`);
    return Number(execSync(`tmux list-panes -t ${name} -F '#{pane_pid}'`).toString().trim());
  };
  const paneText = (name: string): string =>
    execSync(`tmux capture-pane -p -t ${name}`).toString();

  for (const [decision, mark] of [["allow", "APPR"], ["deny", "APPR"]] as const) {
    const sess = `ccdeck-appr-${decision}`;
    const sid = `ext-cli-tmux-${decision}`;
    const pid = mkPane(sess, mark);
    mgr.ensureExternal(`ext-cli-tmux-${decision}`, root, "tmux 注入链验证");
    mgr.setExternalCliPid(sid, pid);
    const rid = `r-${decision}`;
    mgr.setExternalWaiting(sid, { request_id: rid, tool_name: "Bash", input_summary: "echo hi", suggestions: [], decidable: false, received_at: Date.now() });
    const err = bridge.injectPendingDecision(sid, rid, decision, "tester");
    assert(err === null, `tmux E2E[${decision}]：受理`);
    await wait(2200); // 注入+验证重试窗（600ms×2+capture）
    const st = mgr.getExternal(sid);
    assert(!!st && st.status === "WORKING" && !st.waiting_request, `tmux E2E[${decision}]：决议生效翻 WORKING 清横幅`);
    const txt = paneText(sess);
    assert(txt.includes(decision === "allow" ? "APPR-ALLOW" : "APPR-DENY"), `tmux E2E[${decision}]：键送达 pane（${decision} 键位命中）`);
    execSync(`tmux kill-session -t ${sess}`, { stdio: "ignore" });
  }
}

// ---------- ④ 双端静态锚（web/expo passive 卡可决化，改字面必三端同步） ----------
{
  const sd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../web-console/js/session-domain.js"), "utf-8");
  assert(sd.includes("passive && !isAsk"), "web：passive 权限卡分支锚（passive && !isAsk）");
  const pa = sd.indexOf("passive && !isAsk");
  const passiveBlock = pa < 0 ? "" : sd.slice(pa, sd.indexOf("} else if (passive)", pa));
  assert(passiveBlock.includes("data-wait-allow") && passiveBlock.includes("data-wait-deny"), "web：passive 卡渲染允许/拒绝按钮");
  assert(passiveBlock.includes("可远程批准"), "web：passive 卡文案锚（可远程批准）");
  const ds = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../expo-app/src/screens/DetailScreen.tsx"), "utf-8");
  assert(ds.includes("wr.decidable !== false || !wr.questions?.length"), "expo：passive 权限卡渲染门放开锚");
  assert(ds.includes("wr?.decidable !== false && isWaitStale"), "expo：stale 置灰对 passive 豁免锚");
  const sm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/session-manager.ts"), "utf-8");
  assert(sm.includes("skip-confirm 放行（dispatch 预授权，系统代填勾选）"), "relay：dispatch 面 gate-release 链审计锚");
  const br = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/bridge.ts"), "utf-8");
  assert(br.includes(".finally(() => this.injectInFlight.delete"), "relay：inFlight finally 收口锚");
  assert(br.includes("cur.request_id !== requestId"), "relay：rid 覆写守卫锚（防清新卡）");
  const inj = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/injector.ts"), "utf-8");
  assert(inj.includes("do you want to proceed?") && inj.includes("permDialogKeyFrom"), "relay：真弹窗特征+动态键位解析锚");
  assert(inj.includes("弹窗形态未识别") && !inj.includes("PERM_DIALOG_KEYS"), "relay：fail-closed 锚（形态未识别不注+常量回退已删）");
  assert(inj.includes("lastIndexOf(PERM_DIALOG_ANCHOR_TEXT)"), "relay：解析域限定 proceed 锚后锚（历史区排除）");
}

// ---------- 清理 ----------
try { execSync("tmux kill-session -t ccdeck-appr-allow", { stdio: "ignore" }); } catch {}
try { execSync("tmux kill-session -t ccdeck-appr-deny", { stdio: "ignore" }); } catch {}
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
