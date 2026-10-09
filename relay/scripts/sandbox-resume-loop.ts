// W-LEADFIX 沙盒复现 driver：隔离 env（数据目录 /tmp/wleadfix，绝不碰生产 16549 与
// ~/.cc-deck）内进程级复现「会话 resume 必败 + 消息流持续 → 每条触发恢复 → 失败 →
// 下一条再触发」的死循环形态，并验证熔断三板（连败冷却 / 手动路径存活 / 到期解封）
// 在真实代码路径（handleCommand → resumeAgent → 熔断闸）上生效。
//
// 驱动口径：生产死循环的外驱动 = 值守喂活/派单回执/org 通知（relay 内部直调
// resumeAgent）；本 driver 用 autoReviveManaged 循环充当等价的自动恢复驱动源（同一
// resumeAgent 入口、同一熔断闸），COMMAND_MESSAGE 充当用户手动路径。resume 必败
// 形态用「CLI 加载大上下文即崩」（factory 抛错——与 init 挂死同属恢复必败类，且不
// 残留 agent，auto-revive 每轮都是候选）。时窗 env 缩短，跑完 ~15s。
//
// 跑法：npx tsx scripts/sandbox-resume-loop.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { ReplayedSession } from "../src/history.js";
import type { Command } from "../src/types.js";

const ROOT = "/tmp/wleadfix/sandbox";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "data"), { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "data");
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_RESUME_BREAKER_BASE_MS = "3000"; // 冷却 base 3s（演示窗口看得清）

const CLI_SID = "leadfix-sandbox-leader-cli";
const TASKS = join(homedir(), ".claude", "tasks");
mkdirSync(join(TASKS, CLI_SID), { recursive: true });
writeFileSync(join(TASKS, CLI_SID, "1.json"), JSON.stringify({ id: 1, subject: "值守队列有活", status: "in_progress" }));
const cleanup = (): void => { rmSync(join(TASKS, CLI_SID), { recursive: true, force: true }); rmSync(ROOT, { recursive: true, force: true }); };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const mgr = new SessionManager(new EventBus(), loadConfig());
let resumes = 0;
mgr.setAgentFactory(() => {
  resumes++;
  log(`  → resume 发起 #${resumes}：CLI 加载大上下文……崩溃（恢复必败形态）`);
  throw new Error("模拟 CLI resume 崩溃（大上下文加载失败）");
});

mgr.adopt(new Map([
  ["m-leader", {
    state: {
      session_id: "m-leader", relay_session_id: CLI_SID, cwd: "/tmp", initial_prompt: "x",
      title: "全局 Leader（复现）", model: "glm-5.3", status: "DONE", action_summary: "（历史）",
      started_at: Date.now(), updated_at: Date.now(),
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      // 长跑数日形态：大用量 + 有未完成待办（auto-revive 候选）
      usage: { input_tokens: 9_000_000, output_tokens: 900_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    logs: [],
  } as unknown as ReplayedSession],
]));

const st = () => mgr.snapshot().find((s) => s.session_id === "m-leader")!;
const breaker = () => mgr.resumeBreakerForTests("m-leader")!;

log("—— 阶段 1：死循环复现（消息流持续 → 每轮一拉一败）——");
for (let round = 1; round <= 2; round++) {
  mgr.autoReviveManaged(); // 生产等价：值守/回执触发的自动恢复
  await sleep(100);
  log(`  消息轮 ${round}：卡片=${st().status}（熔断 streak=${breaker().streak}）`);
}
log("—— 阶段 2：熔断生效（连败 2 次 → 冷却，后续消息轮零发起）——");
{
  const b = breaker();
  log(`  熔断就位：streak=${b.streak}，冷却 ${((b.cooldownUntil - Date.now()) / 1000).toFixed(1)}s`);
  const before = resumes;
  for (let round = 3; round <= 8; round++) {
    mgr.autoReviveManaged();
    await sleep(100);
    log(`  消息轮 ${round}：resume 发起数=${resumes}（${resumes === before ? "被熔断压制，零发起" : "仍在发起！"}）`);
  }
  if (resumes === before) log("  ✓ 死循环已断根：冷却期内自动路径全部入队不再拉起（对照生产当晚 ×34）");
}

log("—— 阶段 3：手动路径存活（冷却期用户发消息照常拉起）——");
{
  const before = resumes;
  const ack = mgr.handleCommand({ command_id: "sb-1", type: "COMMAND_MESSAGE", payload: { session_id: "m-leader", text: "用户手动消息：试试能不能拉起" }, ts: Date.now() } as unknown as Command, "user");
  log(`  COMMAND_MESSAGE ack ok=${ack.ok}，resume 发起数=${resumes}（${resumes > before ? "越过熔断照常发起 ✓（失败是恢复必败形态使然，路径本身存活）" : "被封锁 ✗"}）`);
}

log("—— 阶段 4：冷却到期自动解封——");
{
  // 阶段 3 的手动发起也失败 → streak=3 → 退避翻倍（4s→6s）。按实际冷却窗动态等待
  // ——这本身就是退避语义的活演示：越败越等，不会越败越勤
  const b = breaker();
  const wait = Math.max(0, b.cooldownUntil - Date.now()) + 200;
  log(`  当前 streak=${b.streak}，退避窗 ${((b.cooldownUntil - Date.now()) / 1000).toFixed(1)}s（手动重试失败同样进退避，翻倍等待）`);
  await sleep(wait);
  const before = resumes;
  mgr.autoReviveManaged();
  log(`  冷却过期后自动恢复轮：resume 发起数=${resumes}（${resumes > before ? "解封 ✓（退避窗结束自动重试）" : "仍封锁 ✗"}）`);
}
log(`—— 沙盒结束：发起 ${resumes} 次 / 全程 ${((Date.now() - t0) / 1000).toFixed(1)}s ——`);
log("（对照修复前形态：每轮 +1 次发起永不封住；修复后 2 次封住、手动存活、到期解封）");
cleanup();
