// D18 板域五态测试（freeze v2-m10-freeze §1.2 逐字锁）。
// 五面：①一次性迁移就近映射全谱（todo→backlog、doing→claimed、done→done，不保留旧态；
// 冷备份 .pre-d18.json 在场；无存量 submitted/ready_to_install 自动生成）②幂等重跑零位移
// ③submitted 生成条件锁（R1 资格拒/R2 done 候选升级/R3 复核闭环清位）④ready_to_install
// 显式搬卡+computeReady/未完成计数五态语义 ⑤三端词表静态锚（store/types/session-manager/
// web-console/expo 五面同源一致性）。
// 隔离：mkdtemp+CCR_ORG_DIR 注入 tmp，纯 store 层直测（无 ws/无端口），不触生产。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeReadySet, loadBoard, moveBoardEntry, upsertBoardEntry, BOARD_ENTRY_STATUSES,
} from "../src/projects.js";

const here = dirname(fileURLToPath(import.meta.url)); // relay/scripts
const repo = join(here, "..", "..");                   // 仓库根（web-console/expo 静态锚用）
const root = mkdtempSync(join(tmpdir(), "cc-deck-d18-"));
const orgDir = join(root, "org");
let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
const j = (x: unknown) => JSON.stringify(x);

// fixture：active 组 + 三态板（直写盘上 JSON=迁移的真实输入形态；不走 API——API 词表已收五态）
mkdirSync(join(orgDir, "boards"), { recursive: true });
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({
  groups: [{ id: "g-d18", name: "D18 迁移组", anchor_dir: root, tier: "轻立项", status: "active", created_at: 1, updated_at: 1, headcount: [], single_card: true }],
  trust_light: true,
}, null, 2) + "\n");
const boardPath = join(orgDir, "boards", "g-d18.json");
const legacy = {
  gid: "g-d18",
  entries: [
    { id: "e1", text: "待办卡", status: "todo", ts: 10, updated_at: 10 },
    { id: "e2", text: "进行卡", status: "doing", ts: 11, updated_at: 11, owner_session: "s-1", dispatch_id: "d-1" },
    { id: "e3", text: "完成卡", status: "done", ts: 12, updated_at: 12 },
  ],
  frozen: false,
  updated_at: 13,
};
writeFileSync(boardPath, JSON.stringify(legacy, null, 2) + "\n");

try {
  process.env.CCR_ORG_DIR = orgDir;

  // ---------- S1 一次性迁移：就近映射全谱+冷备份+无存量新态 ----------
  console.log("S1 一次性迁移（todo→backlog、doing→claimed、done→done）");
  const b1 = loadBoard("g-d18");
  assert(j(b1.entries.map((e) => [e.id, e.status])) === j([["e1", "backlog"], ["e2", "claimed"], ["e3", "done"]]),
    "迁移就近映射：todo→backlog、doing→claimed、done→done（不保留旧态）");
  assert(!b1.entries.some((e) => e.status === "submitted" || e.status === "ready_to_install"),
    "迁移无存量 submitted/ready_to_install 自动生成（freeze §1.2）");
  assert(existsSync(`${boardPath}.pre-d18.json`), "冷备份 .pre-d18.json 在场（迁移不删旧文件，cutover 冷档案精神）");
  const backupRaw = JSON.parse(readFileSync(`${boardPath}.pre-d18.json`, "utf-8")) as typeof legacy;
  assert(j(backupRaw.entries.map((e) => e.status)) === j(["todo", "doing", "done"]), "备份内容=迁移前三态原文");
  const onDisk = JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: { status: string }[] };
  assert(j(onDisk.entries.map((e) => e.status)) === j(["backlog", "claimed", "done"]), "盘上板文件已写新态（写新态落盘）");
  assert(b1.entries[1]!.owner_session === "s-1" && b1.entries[1]!.dispatch_id === "d-1", "迁移不动其余字段（owner_session/dispatch_id 保留）");

  // ---------- S2 幂等重跑零位移 ----------
  console.log("S2 幂等重跑零位移");
  const before = readFileSync(boardPath, "utf-8");
  const b2 = loadBoard("g-d18");
  assert(readFileSync(boardPath, "utf-8") === before, "五态板重跑零写（幂等：无位移不落盘）");
  assert(j(b2.entries.map((e) => e.status)) === j(["backlog", "claimed", "done"]), "重跑读面稳定（零位移断言）");

  // ---------- S3 submitted 生成条件锁 ----------
  console.log("S3 submitted 仅由完成候选且 review_required=1 生成");
  const r1a = upsertBoardEntry("g-d18", { id: "e1", text: "待办卡", status: "submitted" });
  assert(r1a.ok === false && (r1a as { error: string }).error.includes("review_required"), "R1：无资格直提交 submitted 拒（upsert）");
  const r1b = moveBoardEntry("g-d18", "e2", "submitted");
  assert(r1b.ok === false && (r1b as { error: string }).error.includes("review_required"), "R1：无资格直搬 submitted 拒（move）");

  const r2 = upsertBoardEntry("g-d18", { id: "e1", text: "待办卡", status: "done", review_required: true });
  assert(r2.ok === true && (r2 as { entry: { status: string; review_required?: boolean } }).entry.status === "submitted",
    "R2：done 请求+review_required=1 → 落 submitted（完成候选升级，唯一生成路径）");
  assert((r2 as { entry: { review_required?: boolean } }).entry.review_required === true, "R2：资格位随卡记录");

  const r3 = moveBoardEntry("g-d18", "e1", "done");
  assert(r3.ok === true && (r3 as { entry: { status: string; review_required?: boolean } }).entry.status === "done" &&
    (r3 as { entry: { review_required?: boolean } }).entry.review_required === undefined,
    "R3：submitted→done 复核闭环（落 done+清资格位）");
  assert(!("review_required" in (JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: Record<string, unknown>[] }).entries[0]!), "R3 清位落盘（无残留键）");

  const rNew = upsertBoardEntry("g-d18", { text: "建卡即候选", status: "done", review_required: true });
  assert(rNew.ok === true && (rNew as { entry: { status: string } }).entry.status === "submitted", "R2 新卡面：建卡即完成候选 → submitted");
  // 资格位独立维护（status 缺省时）：true=标记完成候选
  upsertBoardEntry("g-d18", { id: "e2", text: "进行卡", review_required: true });
  const rrMove = moveBoardEntry("g-d18", "e2", "submitted");
  assert(rrMove.ok === true && (rrMove as { entry: { status: string } }).entry.status === "submitted", "先设资格位后 move submitted 放行（两步生成路径）");
  // false 撤销资格走独立维护路径（status 缺省；status 在场非 done 时 rrInput 不作清位消费——resolve 注释口径）
  upsertBoardEntry("g-d18", { id: "e2", text: "进行卡", review_required: false });
  const rrClear = JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: { id: string; review_required?: boolean }[] };
  assert(rrClear.entries.find((e) => e.id === "e2")?.review_required === undefined, "显式 review_required=false 撤销资格");

  // ---------- S4 ready_to_install + computeReady/计数五态语义 ----------
  console.log("S4 ready_to_install 显式搬卡+依赖/计数语义");
  const r4 = moveBoardEntry("g-d18", "e2", "ready_to_install");
  assert(r4.ok === true && (r4 as { entry: { status: string } }).entry.status === "ready_to_install", "ready_to_install 显式搬卡放行（无自动生成路径）");
  const rFree = upsertBoardEntry("g-d18", { text: "自由卡", status: "backlog" });
  const freeId = (rFree as { entry: { id: string } }).entry.id;
  const rDep = upsertBoardEntry("g-d18", { text: "依赖待装机卡", status: "backlog", depends_on: ["e2"] });
  const depId = (rDep as { entry: { id: string } }).entry.id;
  const readySet = computeReadySet(loadBoard("g-d18"));
  const freeCheck = readySet.find((x) => x.id === freeId);
  assert(freeCheck !== undefined && freeCheck.check.ready === true, "backlog 卡无依赖无 gate → ready（待派，待认领即前沿）");
  const e3check = readySet.find((x) => x.id === "e3");
  assert(e3check === undefined, "computeReadySet 过滤 done 卡（依赖判定口径 D18 零回归）");
  const depCheck = readySet.find((x) => x.id === depId);
  assert(depCheck !== undefined && depCheck.check.ready === false &&
    depCheck.check.reasons.some((r) => r.includes("未完成") && r.includes("ready_to_install")),
    "依赖 ready_to_install（非 done 终态）→ 未就绪（依赖判定只认 done）");

  // ---------- S5 orgAction 词表校验五态（session-manager 板域校验面静态锁+运行时单点） ----------
  console.log("S5 词表常量单点与五态完备");
  assert(j(BOARD_ENTRY_STATUSES) === j(["backlog", "claimed", "submitted", "ready_to_install", "done"]),
    "BOARD_ENTRY_STATUSES 词表序=freeze §1.2（store 单点，校验面共用）");

  // ---------- S6 三端词表静态锚（store/types/session-manager/web-console/expo 同源） ----------
  console.log("S6 三端渲染词表静态锚");
  const projectsSrc = readFileSync(join(repo, "relay", "src", "projects.ts"), "utf-8");
  const typesSrc = readFileSync(join(repo, "relay", "src", "types.ts"), "utf-8");
  const smSrc = readFileSync(join(repo, "relay", "src", "session-manager.ts"), "utf-8");
  const webSrc = readFileSync(join(repo, "web-console", "index.html"), "utf-8");
  const expoSrc = readFileSync(join(repo, "expo-app", "src", "screens", "ListScreen.tsx"), "utf-8");
  for (const s of ["backlog", "claimed", "submitted", "ready_to_install", "done"]) {
    assert(projectsSrc.includes(`"${s}"`), `projects.ts 词表含 ${s}`);
    assert(webSrc.includes(s), `web-console BOARD_LANE 含 ${s}`);
    assert(expoSrc.includes(`"${s}"`), `expo ListScreen 分区含 ${s}`);
  }
  assert(projectsSrc.includes('export type BoardEntryStatus = "backlog" | "claimed" | "submitted" | "ready_to_install" | "done"'),
    "BoardEntryStatus 五态类型定义（词表权威行）");
  assert(typesSrc.includes("status?: BoardEntryStatus") && typesSrc.includes('status?: "backlog" | "claimed"'),
    "types.ts 命令 payload 词表（task create/update 五态+dispatch.task 收窄 backlog|claimed）");
  assert(smSrc.includes("BOARD_ENTRY_STATUSES") && !smSrc.includes('["todo", "doing", "done"]'),
    "session-manager 板域校验走单点常量（旧三态字面量清零）");
  assert(!smSrc.includes('"todo"') && !smSrc.includes('"doing"'), "session-manager 板域旧态字面量零残留（搬卡/认领检测全迁）");
  assert(webSrc.includes('e.status || "backlog"'), "web-console 无 status 兜底归 backlog（M13-3 按值分组兜底位升级）");

  console.log(`\nD18 five states: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
