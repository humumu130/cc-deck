// #263 断言件：recon 收口边沿自动收敛——台账终态 done/failed（超 1h 窗）×板卡滞留
// claimed/backlog 的自动搬卡 + 保护边界（running 不动/窗内不急搬/复核态不搬/冻结组不写）
// + 幂等（零搬动零审计）。直跑（CCR_ORG_DIR 显式隔离，不碰生产 org）：
//   env -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-recon-autoclose.ts
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { RelayConfig } from "../src/config.js";
import { loadBoardFile } from "../src/projects.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`PASS ${msg}`); }
  else { fail++; console.error(`FAIL ${msg}`); }
}

const ORG = mkdtempSync(join(tmpdir(), "ccr-reconauto-org-"));
const DATA = mkdtempSync(join(tmpdir(), "ccr-reconauto-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";
try {
  const cfg: RelayConfig = {
    port: 8799, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "m", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const eventsPath = join(DATA, "events.ndjson");
  const bus = new EventBus({ persistPath: eventsPath });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(((_cwd: any, _m: any, _cb: any, _prompt: any, _opts?: any) => null) as any);

  const H = 3_600_000;
  const now = Date.now();
  const GID = "g-recon";      // active 组
  const GIDP = "g-reconpark"; // parked 组（板冻结）
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [
    { id: GID, name: "对账组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [], created_at: now - 86_400_000 },
    { id: GIDP, name: "冻结组", anchor_dir: DATA, status: "parked", tier: "随手办", headcount: [], created_at: now - 86_400_000 },
  ] }));

  // 台账种子（append-only 收敛视图：同 id 末行赢）
  const rows: object[] = [
    // A1 done 超时（真回执，2h 前）×板 claimed → 搬 done
    { ts: now - 3 * H, id: "d-done-old", tier: "随手办", target: "org-leader", status: "dispatched", session_id: "w-1", title: "#301 单" },
    { ts: now - 2 * H, id: "d-done-old", tier: "随手办", target: "org-leader", status: "done", receipt: "结果：全绿", session_id: "w-1", title: "#301 单" },
    // A2 done 超时（重启中断定格回执——22 卡实锤形态）×板 backlog → 搬 done
    { ts: now - 2 * H, id: "d-done-backlog", tier: "随手办", target: "org-leader", status: "done", receipt: "relay 重启，回合中断", session_id: "w-2", title: "#302 单" },
    // A3 running（未收口）→ 不碰
    { ts: now - 5 * H, id: "d-running", tier: "随手办", target: "org-leader", status: "running", session_id: "w-3", title: "#303 单" },
    // A4 failed 超时 ×板 claimed → 归 backlog 且卡保留
    { ts: now - 2 * H, id: "d-failed", tier: "随手办", target: "org-leader", status: "failed", receipt: "结果：失败｜改动文件：无", session_id: "w-4", title: "#304 单" },
    // A5 done 但终态在 1h 窗内（10min 前）→ 不急搬
    { ts: now - 10 * 60_000, id: "d-done-fresh", tier: "随手办", target: "org-leader", status: "done", receipt: "结果：完成", session_id: "w-5", title: "#305 单" },
    // A6 done 超时 ×板 submitted（复核态）→ 不搬
    { ts: now - 2 * H, id: "d-done-sub", tier: "随手办", target: "org-leader", status: "done", receipt: "结果：完成", session_id: "w-6", title: "#306 单" },
    // A7 done 超时 ×冻结组（parked）板 claimed → 不写只跳过
    { ts: now - 2 * H, id: "d-done-park", tier: "随手办", target: "org-leader", status: "done", receipt: "relay 重启，回合中断", session_id: "w-7", title: "#307 单" },
  ];
  writeFileSync(join(ORG, "dispatch-log.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // 板种子
  const ent = (id: string, text: string, status: string, dispatchId?: string) => ({
    id, text, status, ...(dispatchId ? { dispatch_id: dispatchId } : {}), ts: now - 6 * H, updated_at: now - 6 * H,
  });
  mkdirSync(join(ORG, "boards"), { recursive: true });
  writeFileSync(join(ORG, "boards", `${GID}.json`), JSON.stringify({ entries: [
    ent("c-1", "#301 单 done 超时搬", "claimed", "d-done-old"),
    ent("c-2", "#302 单 backlog 收敛", "backlog", "d-done-backlog"),
    ent("c-3", "#303 单 running 不动", "claimed", "d-running"),
    ent("c-4", "#304 单 failed 归 backlog", "claimed", "d-failed"),
    ent("c-5", "#305 单窗内不急搬", "claimed", "d-done-fresh"),
    ent("c-6", "#306 单复核态保护", "submitted", "d-done-sub"),
  ] }));
  writeFileSync(join(ORG, "boards", `${GIDP}.json`), JSON.stringify({ entries: [
    ent("c-7", "#307 单冻结组跳过", "claimed", "d-done-park"),
  ] }));

  const card = (gid: string, eid: string) => loadBoardFile(gid)?.entries.find((x) => x.id === eid);
  const auditCount = () => readFileSync(eventsPath, "utf-8").split("\n").filter((l) => l.includes("recon-autoclose")).length;

  mgr.runLedgerRecon("test");

  // —— 主断言（任务书 ≥3：done 超时搬 / running 不搬 / failed 归 backlog）——
  ok(card(GID, "c-1")?.status === "done", `A1 done 超时：claimed→done（实 ${card(GID, "c-1")?.status}）`);
  ok(card(GID, "c-2")?.status === "done", `A2 done 超时×backlog：backlog→done（实 ${card(GID, "c-2")?.status}）`);
  ok(card(GID, "c-3")?.status === "claimed", `A3 running 不搬：仍 claimed（实 ${card(GID, "c-3")?.status}）`);
  const c4 = card(GID, "c-4");
  ok(c4?.status === "backlog" && !!c4, `A4 failed 归 backlog 且卡保留（实 ${c4?.status ?? "卡被吞"}）`);
  // —— 保护边界 ——
  ok(card(GID, "c-5")?.status === "claimed", `A5 1h 窗内终态不急搬（实 ${card(GID, "c-5")?.status}）`);
  ok(card(GID, "c-6")?.status === "submitted", `A6 复核态 submitted 不搬（实 ${card(GID, "c-6")?.status}）`);
  ok(card(GIDP, "c-7")?.status === "claimed", `A7 冻结组（parked）板不写（实 ${card(GIDP, "c-7")?.status}）`);
  // —— 审计闭环 ——
  const n1 = auditCount();
  ok(n1 >= 1, `A8 chain-audit 审计帧落盘（events.ndjson recon-autoclose ${n1} 行）`);
  const mirror = readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8");
  ok(mirror.includes("recon-autoclose") && mirror.includes("2 张→done") && mirror.includes("1 张→backlog"),
    `A9 chain-audit.jsonl 镜像行含动作与计数（含冻结跳过注记=${mirror.includes("冻结组待复活收敛")}）`);
  // —— 幂等：第二轮零搬动零审计 ——
  mgr.runLedgerRecon("test-again");
  ok(auditCount() === n1 && card(GID, "c-1")?.status === "done", `A10 幂等：复跑零新审计行（${n1}→${auditCount()}）且卡稳态 done`);

  console.log(`\n${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  delete process.env.CCR_ORG_DIR;
  delete process.env.CCR_NO_TITLE_GEN;
  delete process.env.CCR_STORAGE_READ_MODE;
}
