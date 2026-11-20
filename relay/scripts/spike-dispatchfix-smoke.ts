// W-DISPATCHFIX headless 拉起冒烟（验收⑥·真 claude -p 端到端——手动跑一次即止，不入 CI）
// 用法：relay/scripts 内 `tsx scripts/spike-dispatchfix-smoke.ts`
// 形态：沙盒 SessionManager（temp 数据面零生产触碰）+ 假死占位 worker（池空窗）→
// dispatch → 自动拉起**真** claude -p 消费 mock 单（prompt=两字输出即停）→ 断言
// 台账 queued→running(headless)→done 全链 + 日志落盘。跑完进程自退（-p 形态天然即停）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { createGroup, setGroupStatus } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await wait(200); }
  return pred();
}

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-smoke-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-smoke-data-"));
  const prevEnv: Record<string, string | undefined> = {
    CCR_ORG_DIR: process.env.CCR_ORG_DIR,
    CCR_ORG_MAX_GROUPS: process.env.CCR_ORG_MAX_GROUPS,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN,
    CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_CWD: process.env.CCR_CWD,
    CCR_NO_HEADCOUNT_TRIM: process.env.CCR_NO_HEADCOUNT_TRIM,
    CCR_NO_DISPATCH_SWEEP: process.env.CCR_NO_DISPATCH_SWEEP,
    CCR_WT_ROOT: process.env.CCR_WT_ROOT,
    CCR_NO_HEADLESS_SPAWN: process.env.CCR_NO_HEADLESS_SPAWN,
    CCR_HEADLESS_CLAUDE: process.env.CCR_HEADLESS_CLAUDE,
  };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ORG_MAX_GROUPS = "5";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_NO_HEADCOUNT_TRIM = "1";
  process.env.CCR_NO_DISPATCH_SWEEP = "1";
  delete process.env.CCR_CWD;
  delete process.env.CCR_NO_HEADLESS_SPAWN; // 冒烟主角
  delete process.env.CCR_HEADLESS_CLAUDE; // 真 claude（resolveClaudeCliPath 解析）
  let ok = true;
  try {
    const cfg: RelayConfig = {
      port: 8799, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null, accountToken: "",
    };
    const anchor = join(ORG, "smoke-anchor");
    mkdirSync(anchor, { recursive: true });
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    // 假 agent 工厂：最小面（本冒烟不依赖 SDK 会话——占位 worker 直接注入）
    mgr.setAgentFactory(() => ({
      id: randomUUID(), startedAt: Date.now(), ended: true,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => {}, setPermissionMode: async () => {},
    }));
    // 占位 worker：编制 1/1、status WORKING、真活性 dead（无帧+流断——池空窗）
    const cg = createGroup({ name: "冒烟组", anchor_dir: anchor, tier: "轻立项" });
    const gid = cg.ok ? cg.group.id : "";
    setGroupStatus(gid, "active");
    mgr.orgAction("cap-set", { gid, cap: 1 });
    const fakeSid = "fx-smoke-dead-1";
    (mgr as unknown as { sessions: Map<string, unknown> }).sessions.set(fakeSid, {
      agent: { id: "fx-agent-smoke", ended: true },
      // wd.phase=sampling：跳过 tickWatchdog 扫描面（半注入会话无完整看门狗形态——
      // 冒烟只用到 cap/真活性判定，不该被自家看门狗炸）
      wd: { phase: "sampling", gaveUp: false },
      lastProgressAt: 0,
      unacked: [],
      state: { session_id: fakeSid, status: "WORKING", external: false, cwd: anchor, title: "假死占位", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, started_at: Date.now(), updated_at: Date.now() },
    });
    const proj = (await import("../src/projects.js"));
    (proj.addMember as (gid: string, sid: string, role?: string) => unknown)(gid, fakeSid, "worker");

    const prompt = "这是派单链 headless 拉起的真机冒烟测试。请只回复四个字：冒烟通过。不要使用任何工具，不要写任何文件，回复后立即结束。";
    const r = mgr.dispatchWorker({ anchor, gid, prompt, title: "SMOKE", slug: "smoke-headless" }) as { ok: boolean; queued?: boolean; queue_reason?: string; dispatch_id?: string };
    console.log(`dispatch 返回：queued=${r.queued} queue_reason=${r.queue_reason}`);
    if (!(r.queued && r.queue_reason === "pool-empty")) { console.error("✗ 未进入池空窗排队（前置失败）"); ok = false; }
    const id = r.dispatch_id ?? "";
    const led = () => readDispatchLog().find((e) => e.id === id);
    if (!(await waitFor(() => led()?.status === "running" && led()?.headless === true, 15_000))) {
      console.error(`✗ headless 未拉起（台账 ${led()?.status}/${led()?.headless}）`); ok = false;
    } else {
      console.log(`✓ headless 已拉起（running 行 headless:true，target=${led()?.target}）`);
    }
    // 真 claude -p 消费：等退出收口（rc=0 → done）。模型往返数十秒量级，窗给 180s。
    if (!(await waitFor(() => led()?.status === "done", 180_000))) {
      console.error(`✗ 消费未收口（台账 ${led()?.status}）`); ok = false;
    } else {
      console.log(`✓ 消费收口 done（receipt=${(led()?.receipt ?? "").slice(0, 80)}）`);
    }
    const logDir = join(DATA, "headless-workers");
    try {
      const logs = readdirSync(logDir);
      const body = logs.length ? readFileSync(join(logDir, logs[logs.length - 1]), "utf-8") : "";
      console.log(`✓ 日志落盘：${logs.length} 份（尾份 ${body.length} 字节，含模型输出=${body.includes("冒烟") || body.length > 50}）`);
    } catch { console.error("✗ 日志目录缺失"); ok = false; }
    console.log(ok ? "\n== 冒烟结果：PASS ==" : "\n== 冒烟结果：FAIL ==");
    process.exitCode = ok ? 0 : 1;
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await wait(500);
    try { rmSync(ORG, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

void main();
