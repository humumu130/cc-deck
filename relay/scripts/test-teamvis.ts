// #236（W-TEAMVIS，2026-10-23）聚合团队域四连修——relay 侧收敛扫测试：
//   convergeBoardsWithDispatchLog（projects.ts）：台账末行终态=done 的联动卡归 done 泳道
//   （boot 一次性断点清扫）；防碾两面——failed 不动 / 收口后人工搬卡（updated_at 晚于
//   终态 ts+60s）不动；只扫 active 组（parked 板冻结）；重扫幂等。
// 隔离口径（团队经验 pitfall）：worker 会话自带生产 env——本测试全部显式传 dir，
// 不吃 CCR_ORG_DIR 缺省；组具走手写 projects.json 直造 active（test-board-journal 同款）。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatch } from "../src/org.js";
import { convergeBoardsWithDispatchLog, loadBoard, upsertBoardEntry } from "../src/projects.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};

const dirs: string[] = [];
const now = Date.now();
const DAY = 86_400_000;

function mkActiveOrg(): { org: string; gid: string; anchor: string } {
  const org = mkdtempSync(join(tmpdir(), "ccr-teamvis-org-")); dirs.push(org);
  const anchor = mkdtempSync(join(tmpdir(), "ccr-teamvis-anchor-")); dirs.push(anchor);
  const gid = "g-tv1";
  writeFileSync(join(org, "projects.json"), JSON.stringify({
    groups: [{ id: gid, name: "收敛扫组", anchor_dir: anchor, status: "active", tier: "轻立项", headcount: [], single_card: false, created_at: 1, updated_at: 1 }],
    trust_light: false,
  }), "utf-8");
  return { org, gid, anchor };
}

const statusOf = (org: string, gid: string, id: string): string =>
  loadBoard(gid, org).entries.find((x) => x.id === id)?.status ?? "missing";

console.log("\n[件D] convergeBoardsWithDispatchLog 收敛扫");
{
  const { org, gid, anchor } = mkActiveOrg();
  const uA = upsertBoardEntry(gid, { text: "W-RELFIX 旧卡（收口 done 未搬）", status: "claimed", dispatch_id: "disp-A" }, org);
  const uB = upsertBoardEntry(gid, { text: "W-AUDIT 旧卡（failed 留板）", status: "claimed", dispatch_id: "disp-B" }, org);
  const uC = upsertBoardEntry(gid, { text: "人工已拖 ready（收口后动过）", status: "ready_to_install", dispatch_id: "disp-C" }, org);
  const uD = upsertBoardEntry(gid, { text: "无台账挂人卡（非派单联动）", status: "backlog" }, org);
  ok(uA.ok && uB.ok && uC.ok && uD.ok, "前置：四卡建卡成功");
  appendDispatch({ id: "disp-A", ts: now - 11 * DAY, status: "dispatched", tier: "正经立项", target: "worker", session_id: "s-A", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-A", ts: now - 10 * DAY, status: "done", tier: "正经立项", target: "worker", receipt: "r-A", session_id: "s-A", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-B", ts: now - 11 * DAY, status: "dispatched", tier: "正经立项", target: "worker", session_id: "s-B", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-B", ts: now - 10 * DAY, status: "failed", tier: "正经立项", target: "worker", receipt: "r-B", session_id: "s-B", project_anchor: anchor, actor: "test" }, org);
  const uE = upsertBoardEntry(gid, { text: "中断重启单（F-08 退 backlog 口径）", status: "backlog", dispatch_id: "disp-E" }, org);
  appendDispatch({ id: "disp-C", ts: now - 11 * DAY, status: "dispatched", tier: "正经立项", target: "worker", session_id: "s-C", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-C", ts: now - 10 * DAY, status: "done", tier: "正经立项", target: "worker", receipt: "r-C", session_id: "s-C", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-E", ts: now - 9.5 * DAY, status: "dispatched", tier: "正经立项", target: "worker", session_id: "s-E", project_anchor: anchor, actor: "test" }, org);
  appendDispatch({ id: "disp-E", ts: now - 9 * DAY, status: "done", tier: "正经立项", target: "worker", receipt: "relay 重启，回合中断", session_id: "s-E", project_anchor: anchor, actor: "test" }, org);

  // 夹具回填：upsertBoardEntry 建卡强制 updated_at=now（真值语义=建卡时刻），而收口
  // done 行在更晚——防碾闸按 updated_at 对比会把全部旧卡误判「人工动过」。直接改板
  // 文件把非 eC 卡回填旧 updated_at（eC 保持 now-1h=收口后人工搬过形态）
  {
    const bf = join(org, "boards", gid + ".json");
    const bj = JSON.parse(readFileSync(bf, "utf-8"));
    for (const e of bj.entries) if (e.dispatch_id !== "disp-C") e.updated_at = now - 12 * DAY;
    writeFileSync(bf, JSON.stringify(bj), "utf-8");
  }

  const moved = convergeBoardsWithDispatchLog(org);
  ok(moved === 1, `恰好搬 1 张（实际 ${moved}）`);
  ok(uE.ok && statusOf(org, gid, uE.entry!.id) === "backlog", "中断补记行（receipt 带 relay 重启）不算收割，退 backlog 口径不被碾");
  ok(uA.ok && statusOf(org, gid, uA.entry!.id) === "done", "台账 done 的旧卡归 done 泳道（断点残留清扫）");
  ok(uB.ok && statusOf(org, gid, uB.entry!.id) === "claimed", "failed 单不动（失败面留板待人处置）");
  ok(uC.ok && statusOf(org, gid, uC.entry!.id) === "ready_to_install", "收口后人工搬过（updated_at 晚于终态 ts）不碾");
  ok(uD.ok && statusOf(org, gid, uD.entry!.id) === "backlog", "无 dispatch_id 卡不碰（非派单联动）");

  const moved2 = convergeBoardsWithDispatchLog(org);
  ok(moved2 === 0, `重扫幂等零搬（实际 ${moved2}）`);
}

// parked 组冻结面：同款残留不被扫（writableBoard 挡）
{
  const org = mkdtempSync(join(tmpdir(), "ccr-teamvis-org2-")); dirs.push(org);
  const anchor = mkdtempSync(join(tmpdir(), "ccr-teamvis-anchor2-")); dirs.push(anchor);
  const gid = "g-tv2";
  writeFileSync(join(org, "projects.json"), JSON.stringify({
    groups: [{ id: gid, name: "挂起组", anchor_dir: anchor, status: "parked", tier: "轻立项", headcount: [], single_card: false, created_at: 1, updated_at: 1 }],
    trust_light: false,
  }), "utf-8");
  // parked 板 writableBoard 冻结（连 upsert 都拒）——夹具直接手写板文件
  mkdirSync(join(org, "boards"), { recursive: true });
  writeFileSync(join(org, "boards", gid + ".json"), JSON.stringify({
    gid, frozen: false, updated_at: now - 12 * DAY,
    entries: [{ id: "eP", text: "挂起组旧卡", status: "claimed", ts: now - 12 * DAY, updated_at: now - 12 * DAY, dispatch_id: "disp-P" }],
  }), "utf-8");
  appendDispatch({ id: "disp-P", ts: now - 10 * DAY, status: "done", tier: "正经立项", target: "worker", receipt: "r-P", session_id: "s-P", project_anchor: anchor, actor: "test" }, org);
  const moved = convergeBoardsWithDispatchLog(org);
  ok(moved === 0 && statusOf(org, gid, "eP") === "claimed", "parked 板冻结不被扫（listGroupsByStatus active 面外）");
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n===== #236 W-TEAMVIS relay 测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
