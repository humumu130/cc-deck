// [W-RETIRED] e2e 活 relay（验收件，手动跑/CDP 驱动）：沙盒起 ws-server + 造账 +
// 常驻，供 /tmp/retired-e2e/drive.mjs 做 SNAPSHOT/瞬态帧断言与三端 CDP 截图。
// 造账形态对齐用户 1029 实锤场景：退休成员的会话卡仍在列表（retire 后建卡模拟残留
// ——前端归档组正是吃这个形态）；用户本人会话不受影响（sess-USER 对照）。
// 直跑：cd relay && env CCR_PORT=18899 npm run test:retired-live
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import { createGroup, addMember, setGroupStatus, listGroups } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";

const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-retired-live-org/", "../data/test-retired-live-data/", "../data/test-retired-live-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-retired-live-org/");
process.env.CCR_DATA_DIR = SB("../data/test-retired-live-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-retired-live-projects/");
process.env.CCR_SESSIONS_ROOT = SB("../data/test-retired-live-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });
process.env.CCR_WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // 托管本 worktree 的 web-console（改后前端）
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";
process.env.CCR_PORT = process.env.CCR_PORT || "18899";

const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const { port } = startServer(bus, mgr, cfg);
console.log(`[retired-live] relay up :${port}（web=/app2，token=t）`);

// ---- 造账：组 + 两个 worker（在编+路由）+ 用户本人会话 ----
const anchor = process.env.CCR_SESSIONS_ROOT as string;
const r = createGroup({ name: "退休实测组", anchor_dir: anchor, tier: "轻立项" });
if (!r.ok) throw new Error("建组失败: " + r.error);
const gid = r.group.id;
if (r.group.status === "pending") {
  const a = setGroupStatus(gid, "active");
  if (!a.ok) throw new Error("激活失败: " + a.error);
}
addMember(gid, "sess-worker-1", "worker");
addMember(gid, "sess-worker-2", "worker");
addMember(gid, "sess-worker-3", "worker");
addMember(gid, "sess-worker-4", "worker");
recordRoutingResult(gid, "sess-worker-1", "done", "第一批活干完");
recordRoutingResult(gid, "sess-worker-2", "done", "第二批活干完");
recordRoutingResult(gid, "sess-worker-3", "done", "第三批活干完");
recordRoutingResult(gid, "sess-worker-4", "done", "第四批活干完");

// 真实 retire 动作（orgAction 全链，无卡清扫路径——worker 卡尚未建）
const r1 = mgr.orgAction("member-retire", { gid, sid: "sess-worker-1", reason: "e2e 退休一号" });
const r2 = mgr.orgAction("member-retire", { gid, sid: "sess-worker-2", reason: "e2e 退休二号" });
if (!r1.ok || !r2.ok) throw new Error("member-retire 失败");
console.log(`[retired-live] 已 retire worker-1/worker-2；名单=${JSON.stringify(mgr.retiredMemberSids())}`);

// 退休后建卡（= 用户场景：退休成员会话卡残留列表）
mgr.ensureExternal("sess-worker-1", anchor, "退休 worker 的历史会话一", "cli-w1", Date.now() - 3600_000);
mgr.ensureExternal("sess-worker-2", anchor, "退休 worker 的历史会话二", "cli-w2", Date.now() - 7200_000);
// 对照组：用户本人会话（不受退休过滤影响）
mgr.ensureExternal("sess-user", anchor, "用户本人的会话（对照）", "cli-u", Date.now() - 60_000);
// 对照组：现役成员（在编不隐藏）
mgr.ensureExternal("sess-worker-3", anchor, "现役 worker 的会话", "cli-w3", Date.now() - 120_000);
console.log(`[retired-live] 造账完成：快照 ${mgr.snapshot().length} 卡（user/worker-3 直列；worker-1/2 归档组）`);

// drive.mjs 的阶段钩子：往 org 目录写 flag 文件触发「在线再 retire」（阶段 2 瞬态帧断言用）。
// 注意 retire 目标必须无卡：external 卡在编=数据异常形态，member-retire 的 seatGate 正确拒绝
//（e2e 首跑实锤：worker-3 建卡后 retire 被拒=防御生效）——阶段 2 用无卡的 worker-4。
import { existsSync } from "node:fs";
setInterval(() => {
  try {
    const flag = join(process.env.CCR_ORG_DIR as string, "e2e-retire-4.flag");
    if (existsSync(flag)) {
      const rr = mgr.orgAction("member-retire", { gid, sid: "sess-worker-4", reason: "e2e 阶段2 在线退休" });
      console.log(`[retired-live] 阶段2 在线 retire worker-4 → ok=${rr.ok} 名单=${JSON.stringify(mgr.retiredMemberSids())}`);
      rmSync(flag, { force: true });
    }
  } catch { /* 心跳尽力而为 */ }
}, 500);

setInterval(() => {
  console.log(`[retired-live] 心跳 groups=${listGroups().length} retired=${mgr.retiredMemberSids().length}`);
}, 30_000);
console.log("[retired-live] 常驻中（SIGTERM 退出）");
process.on("SIGTERM", () => process.exit(0));
