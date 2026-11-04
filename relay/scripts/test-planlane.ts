// planlane（t-405bdbc9，1104 用户想法）：板卡词表加 planned（规划中）泳道全链测试。
// 八面：
//   S1 词表单点（org-schema 权威数组 + BoardEntryStatus 数组推导——同类绝迹机制）
//   S2 R4 状态机（单进单出锁：建卡直设/同态幂等/排产→backlog/废弃→done/transitions
//      留痕；既有态回 planned 拒；planned→claimed·ready_to_install 拒；upsert/move 双口同规则）
//   S3 存量迁移（[规划] 前缀 backlog 卡惰性迁 planned——生产 pg-7cb58ab4 四卡同形态 fixture；
//      前缀文字保留/冷备份 .pre-planlane.json/幂等零写/非 backlog 前缀卡不迁）
//   S4 dispatch 认领不可达（entry_id 认领 planned 拒；同题名重派接卡池不含 planned）
//   S5 converge 收敛扫不碰 planned（防御性：带 dispatch_id+台账 done 的规划卡零位移）
//   S6 镜像排除（boardMirrorTodos 不含 planned——CLI 待办=执行面，规划想法不进）
//   S7 sqlite v10 迁移（v1 CHECK 拒 planned 对照 → 全量迁移后 planned 合法 + 行保持 +
//      idx_task_ready 重建在场 + foreign_key_check 净）
//   S8 三端静态锚（web lanes 首位/stripe 灰系/排产废弃钮/空态文案/tokens --p-planned/
//      session-domain 抽屉词表+activeN 按位假设修复/index.html 老壳前向精修 +
//      RN protocol 类型锚/OrgZone BOARD_LANES/TeamDetailPage 色轴·渲染序·操作行/
//      DetailScreen TEAM_LANES·activeN 修复）
// 沙盒：CCR_ORG_DIR/CCR_DATA_DIR 隔离+CCR_STORAGE_READ_MODE=json+fake agent（test-boardlife 同款）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import {
  BOARD_ENTRY_STATUSES, convergeBoardsWithDispatchLog, loadBoard, loadBoardFile,
  moveBoardEntry, upsertBoardEntry, type BoardEntry,
} from "../src/projects.js";
import { boardMirrorTodos } from "../src/board-mirror.js";
import { appendDispatch } from "../src/org.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

const here = dirname(fileURLToPath(import.meta.url)); // relay/scripts
const repo = join(here, "..", "..");                   // 仓库根（静态锚用）

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const j = (x: unknown) => JSON.stringify(x);
/** upsert/move 联合返回的 ok 侧取件（tsc 收窄助手；断言层自证 ok 后调用） */
function okEntry(r: { ok: true; entry: BoardEntry } | { ok: false; error: string }): BoardEntry {
  return (r as { entry: BoardEntry }).entry;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
          cb.onTurnEnd(true, "success", 10);
        }, 10);
      }, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-planlane-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-planlane-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PM_DUTY = "0";
  delete process.env.CCR_CWD;
  try {
    // ============ S1 词表单点 ============
    console.log("S1 词表单点（同类绝迹机制）:");
    assert(j(BOARD_ENTRY_STATUSES) === j(["planned", "backlog", "claimed", "submitted", "ready_to_install", "done"]),
      "词表=六态 planned 最前（org-schema 单点权威，泳道序同形）");
    const schemaSrc = readFileSync(join(repo, "relay", "src", "org-schema.ts"), "utf-8");
    const projectsSrc = readFileSync(join(repo, "relay", "src", "projects.ts"), "utf-8");
    assert(schemaSrc.includes('export const BOARD_ENTRY_STATUSES = ["planned", "backlog"'),
      "权威数组在 org-schema.ts（校验面全引用此常量）");
    assert(projectsSrc.includes("export type BoardEntryStatus = (typeof BOARD_ENTRY_STATUSES)[number]"),
      "BoardEntryStatus 类型由词表数组推导（加态只动一处，字面量双写绝迹）");

    // ============ 组建（后续各段共用） ============
    const cfg: RelayConfig = {
      port: 8813, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "m", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "planlane-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "planlane 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建（正经立项）");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });

    // ============ S2 R4 状态机 ============
    console.log("S2 R4 单进单出锁（upsert/move 双口）:");
    const c1 = upsertBoardEntry(gid, { text: "[规划]PM 轻量化：机械面外挂轻执行体", status: "planned", note: "想法来自 1104" });
    assert(c1.ok === true && okEntry(c1)?.status === "planned", "建卡直设 planned 放行（唯一入口①）");
    assert(j(okEntry(c1)?.transitions?.map((t: { status: string }) => t.status)) === j(["planned"]), "首道 transitions=planned");
    const pid = String(okEntry(c1)?.id ?? "");
    const c1b = upsertBoardEntry(gid, { id: pid, text: "[规划]PM 轻量化：机械面外挂轻执行体（改注）", status: "planned" });
    assert(c1b.ok === true && okEntry(c1b)?.status === "planned" && okEntry(c1b)?.transitions?.length === 1,
      "同态编辑幂等（入口②：改 text 不追 transitions 行）");
    const cClaim = upsertBoardEntry(gid, { id: pid, text: "[规划]PM 轻量化", status: "claimed" });
    assert(cClaim.ok === false && (cClaim as { error: string }).error.includes("排产"),
      "planned→claimed 拒（不可认领——出口只有排产/废弃，upsert 口）");
    const mClaim = moveBoardEntry(gid, pid, "claimed");
    assert(mClaim.ok === false && (mClaim as { error: string }).error.includes("排产"),
      "planned→claimed 拒（move 口同规则）");
    const mReady = moveBoardEntry(gid, pid, "ready_to_install");
    assert(mReady.ok === false, "planned→ready_to_install 拒");
    const mSched = moveBoardEntry(gid, pid, "backlog");
    assert(mSched.ok === true && okEntry(mSched)?.status === "backlog", "排产：planned→backlog 放行（出口①）");
    assert(j(okEntry(mSched)?.transitions?.map((t: { status: string }) => t.status)) === j(["planned", "backlog"]), "排产 transitions 留痕");
    const back2plan = upsertBoardEntry(gid, { id: pid, text: "[规划]PM 轻量化", status: "planned" });
    assert(back2plan.ok === false, "backlog→planned 拒（既有卡不可回规划面）");
    const back2planM = moveBoardEntry(gid, pid, "planned");
    assert(back2planM.ok === false, "backlog→planned 拒（move 口）");
    // 废弃链：新建 planned 卡 → upsert done 带 note（web/RN 废弃钮同载荷形态）
    const c2 = upsertBoardEntry(gid, { text: "[规划]Router 攒批：量起来再做", status: "planned" });
    const pid2 = String(okEntry(c2)?.id ?? "");
    const scrap = upsertBoardEntry(gid, { id: pid2, text: "[规划]Router 攒批：量起来再做", status: "done", note: "[规划废弃] 规划终止（规划中泳道废弃钮）" });
    assert(scrap.ok === true && okEntry(scrap)?.status === "done" && (okEntry(scrap)?.note ?? "").includes("规划终止"),
      "废弃：planned→done 带 note 放行（出口②）");
    assert(j(okEntry(scrap)?.transitions?.map((t: { status: string }) => t.status)) === j(["planned", "done"]), "废弃 transitions 留痕");
    const done2plan = moveBoardEntry(gid, pid2, "planned");
    assert(done2plan.ok === false, "done→planned 拒（终态不回规划面）");
    // claimed→planned（在途卡不退规划面）
    const c3 = upsertBoardEntry(gid, { text: "在途卡", status: "claimed" });
    const c3m = moveBoardEntry(gid, String(okEntry(c3)?.id ?? ""), "planned");
    assert(c3m.ok === false, "claimed→planned 拒（在途卡退规划面=派单对账面失真）");

    // ============ S3 存量迁移（[规划] 前缀）——独立 ORG2（不覆写 gid 组的 projects.json） ============
    console.log("S3 [规划] 前缀存量迁移（生产 pg-7cb58ab4 四卡同形态）:");
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-planlane-mig-"));
    process.env.CCR_ORG_DIR = ORG2;
    mkdirSync(join(ORG2, "boards"), { recursive: true });
    writeFileSync(join(ORG2, "projects.json"), JSON.stringify({
      groups: [{ id: "g-mig", name: "迁移组", anchor_dir: anchor, tier: "正经立项", status: "active", created_at: 1, updated_at: 1, headcount: [], single_card: true }],
      trust_light: true,
    }, null, 2) + "\n");
    const migPath = join(ORG2, "boards", "g-mig.json");
    writeFileSync(migPath, JSON.stringify({
      gid: "g-mig",
      entries: [
        { id: "t-7291b8a9", text: "[规划]投机执行：observe 档跑稳后上（预算帽+丢弃纪律）", status: "backlog", ts: 10, updated_at: 10 },
        { id: "t-d39d1411", text: "[规划]Router 攒批：40条/分钟高流量打法", status: "backlog", ts: 11, updated_at: 11 },
        { id: "t-196c327a", text: "[规划]PM 轻量化：机械面外挂轻执行体", status: "backlog", ts: 12, updated_at: 12 },
        { id: "t-208449c6", text: "[规划]上下文引用图：链式召回 MVP 后评估", status: "backlog", ts: 13, updated_at: 13 },
        { id: "t-normal", text: "普通缓做卡（无前缀）", status: "backlog", ts: 14, updated_at: 14 },
        { id: "t-claimed-plan", text: "[规划]已在途的前缀卡（不迁）", status: "claimed", ts: 15, updated_at: 15 },
      ],
      frozen: false,
      updated_at: 16,
    }, null, 2) + "\n");
    const bm = loadBoard("g-mig");
    assert(j(bm.entries.filter((e) => e.text.startsWith("[规划]") && e.status === "backlog").map((e) => e.id)) === j([]),
      "四张 [规划] backlog 卡全迁 planned（读入即迁移）");
    assert(j(bm.entries.filter((e) => e.status === "planned").map((e) => e.id)) === j(["t-7291b8a9", "t-d39d1411", "t-196c327a", "t-208449c6"]),
      "迁移集合=四张前缀卡（账面证据：id 逐一在生产板上实存）");
    assert(bm.entries.every((e) => !e.text.includes("[规划]") || e.text.startsWith("[规划]")), "前缀文字保留（不动卡文本）");
    assert(bm.entries.find((e) => e.id === "t-normal")?.status === "backlog", "无前缀 backlog 卡不迁");
    assert(bm.entries.find((e) => e.id === "t-claimed-plan")?.status === "claimed", "非 backlog 前缀卡不迁（claimed 保持）");
    assert(existsSync(`${migPath}.pre-planlane.json`), "冷备份 .pre-planlane.json 在场");
    const backup = JSON.parse(readFileSync(`${migPath}.pre-planlane.json`, "utf-8")) as { entries: { status: string }[] };
    assert(backup.entries.filter((e) => e.status === "backlog").length === 5, "备份内容=迁移前原文（5 张 backlog）");
    const onDisk = JSON.parse(readFileSync(migPath, "utf-8")) as { entries: { id: string; status: string; transitions?: { status: string }[] }[] };
    assert(onDisk.entries.find((e) => e.id === "t-7291b8a9")?.transitions?.at(-1)?.status === "planned", "迁移 transitions 追加 planned 行（留痕）");
    const before = readFileSync(migPath, "utf-8");
    loadBoard("g-mig");
    assert(readFileSync(migPath, "utf-8") === before, "幂等重跑零写（迁后 status=planned 不再命中规则）");
    // 排产后不被迁回（首版实测教训：常驻前缀规则若只看 status，排产后的前缀卡下次读入
    // 即被迁回 planned=排产白点+R4 回流闸被绕——transitions 流转史判据堵死）
    const mSched1 = moveBoardEntry("g-mig", "t-7291b8a9", "backlog");
    assert(mSched1.ok === true, "前缀卡排产放行（planned→backlog）");
    const afterResched = loadBoard("g-mig").entries.find((e) => e.id === "t-7291b8a9");
    assert(afterResched?.status === "backlog", "排产后的前缀卡重读不回迁（transitions 有 planned 史=排产结果，程序不碾）");
    const rePlan = moveBoardEntry("g-mig", "t-7291b8a9", "planned");
    assert(rePlan.ok === false, "排产后的前缀卡手工回 planned 仍拒（R4 不因前缀豁免）");
    // journal 留痕
    const journal = readFileSync(join(ORG2, "boards-journal.ndjson"), "utf-8");
    assert(journal.includes("migrate-planlane"), "板 journal 留痕（action=migrate-planlane）");

    // ============ S6 镜像排除（同 ORG2：g-mig 板数据） ============
    console.log("S6 镜像排除 planned（CLI 待办=执行面）:");
    const mirror = boardMirrorTodos();
    const mirrorIds = new Set(mirror.map((m) => m.board_ref.entry_id));
    const plannedIds = ["t-d39d1411", "t-196c327a", "t-208449c6"]; // t-7291b8a9 已被上方排产子测转 backlog（合法进镜像）
    assert(mirrorIds.has("t-normal"), "backlog 卡进镜像（对照在场）");
    assert(mirrorIds.has("t-claimed-plan"), "claimed 前缀卡进镜像（在途卡不受前缀影响——防误伤口径）");
    assert(mirrorIds.has("t-7291b8a9"), "排产后前缀卡进镜像（排产=进派单面，S3 教训的反面印证）");
    assert(plannedIds.every((id) => !mirrorIds.has(id)), "planned 卡不进镜像（规划想法≠可执行待办，board_ref 精确断言）");
    process.env.CCR_ORG_DIR = ORG; // 换回主 ORG（后续 S4/S5 用 gid 组）
    try { rmSync(ORG2, { recursive: true, force: true }); } catch {}

    // ============ S4 dispatch 认领不可达 ============
    console.log("S4 dispatch 路由面不可达:");
    // 显式 entry_id 认领 planned 卡 → 拒
    const planCard = upsertBoardEntry(gid, { text: "[规划]待排产想法", status: "planned" });
    const planId = String(okEntry(planCard)?.id ?? "");
    const dp = mgr.orgAction("dispatch", { anchor, prompt: "认领规划卡试试", gid, entry_id: planId }) as { ok: boolean; error?: string };
    assert(dp.ok === false && (dp.error ?? "").includes("规划中态不可派"),
      "entry_id 认领 planned 卡拒（先排产再认领）");
    // 题名接卡：planned 卡题名与派单题名完全一致 → 接卡池不含 planned → 开新卡（不接）
    const sameTitle = "[规划]题名接卡试探";
    upsertBoardEntry(gid, { text: sameTitle, status: "planned" });
    const dSame = mgr.orgAction("dispatch", { anchor, prompt: sameTitle + "\n正文", gid, title: sameTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dSame.ok === true, "同题名派单正常出单（接卡池白名单不含 planned——不拒单，走新卡）");
    await waitFor(() => loadBoard(gid).entries.filter((e) => e.text.startsWith(sameTitle) && e.status !== "planned").length >= 1);
    const afterSame = loadBoard(gid).entries.filter((e) => e.text.startsWith(sameTitle));
    assert(afterSame.length === 2 && afterSame.some((e) => e.status !== "planned"),
      "同题名派单开新卡（claimed 或已收口 done——接卡不吞 planned）");
    assert(afterSame.filter((e) => e.text === sameTitle && e.status === "planned").length === 1,
      "原 planned 卡零位移（接卡池 backlog|submitted 不含 planned）");
    // 排产后可认领（planned→backlog→claimed 全链）
    moveBoardEntry(gid, planId, "backlog");
    const dAfter = mgr.orgAction("dispatch", { anchor, prompt: "排产后认领", gid, entry_id: planId }) as { ok: boolean };
    assert(dAfter.ok === true, "排产后 entry_id 认领放行（planned→backlog→claimed 全链通）");
    await waitFor(() => loadBoard(gid).entries.find((e) => e.id === planId)?.status === "claimed");
    assert(loadBoard(gid).entries.find((e) => e.id === planId)?.status === "claimed", "排产卡认领后转 claimed（生命周期接回主链）");

    // ============ S5 converge 不碰 planned ============
    console.log("S5 converge 收敛扫不碰 planned（防御性）:");
    const cGuard = upsertBoardEntry(gid, { text: "[规划]带史卡的规划态（防御形态）", status: "planned" });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    // 直接盘面挂 dispatch_id（模拟极端防御形态：planned 卡带在途账）+台账终态 done
    const guardBoard = loadBoard(gid);
    const guardEntry = guardBoard.entries.find((e) => e.id === String(okEntry(cGuard)?.id ?? ""));
    if (guardEntry) { guardEntry.dispatch_id = "disp-guard-plan"; }
    // 挂账后回写（走 saveBoardFile 的正规口：upsert 不支持 dispatch_id 改——直接文件回写模拟板外状态）
    writeFileSync(join(ORG, "boards", `${gid}.json`), JSON.stringify(guardBoard, null, 2) + "\n");
    const doneTs = Date.now() - 100 * 3600_000; // 100h 前（超 72h 强翻窗）
    appendDispatch({ ts: doneTs, id: "disp-guard-plan", tier: "正经立项", target: "x", status: "done", receipt: "结果：完成｜改动文件：无", session_id: "sess-guard" });
    const conv = convergeBoardsWithDispatchLog();
    const guardAfter = loadBoard(gid).entries.find((e) => e.id === String(okEntry(cGuard)?.id ?? ""));
    assert(guardAfter?.status === "planned", "planned 卡带台账 done 超 72h 仍零位移（收敛扫跳过规划态）");
    assert(conv.moved === 0 || conv.moved >= 0, `收敛扫正常返回（moved=${conv.moved}，skipped=${conv.skipped}）`);

    // ============ S7 sqlite v10 迁移 ============
    console.log("S7 sqlite v10（task.status CHECK 扩 planned）:");
    const dbDir = mkdtempSync(join(tmpdir(), "ccr-planlane-sqlite-"));
    const port = createSqlitePort({ dataDir: dbDir, filename: "planlane.sqlite3" });
    port.open();
    const ver = (p: typeof port) => p.query<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? -1;
    runMigrations(port, migrations.slice(0, 1)); // v1-only 对照（frozen 基线 CHECK 五态）
    port.exec("INSERT INTO task (id, origin, task_ref, title, status, ts) VALUES ('t1','board','board/g/x','标题','backlog',1)");
    let v1Rejects = false;
    try { port.exec("UPDATE task SET status = 'planned' WHERE id = 't1'"); } catch { v1Rejects = true; }
    assert(v1Rejects, "v1 基线 CHECK 拒 planned（对照面：迁移前确实拦）");
    const r10 = runMigrations(port, migrations);
    assert(r10.to === 10 && ver(port) === 10, `全量迁移至 v10（applied=${j(r10.applied)}）`);
    let v10Ok = true;
    try { port.exec("UPDATE task SET status = 'planned' WHERE id = 't1'"); } catch (e) { v10Ok = false; console.error(e); }
    assert(v10Ok, "v10 后 planned 合法（CHECK 词表已扩）");
    assert(port.query<{ n: number }>("SELECT COUNT(*) n FROM task")[0]?.n === 1, "重建搬行零丢失（M 序：TEMP 快照回灌）");
    assert(port.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_ready'").length === 1,
      "idx_task_ready 随表重建（索引在场）");
    assert(port.query("PRAGMA foreign_key_check").length === 0, "foreign_key_check 干净（defer 序无 FK 悬账）");
    port.close();
    rmSync(dbDir, { recursive: true, force: true });

    // ============ S8 三端静态锚 ============
    console.log("S8 三端渲染静态锚:");
    const teamDomain = readFileSync(join(repo, "web-console", "js", "team-domain.js"), "utf-8");
    const tokensCss = readFileSync(join(repo, "web-console", "css", "tokens.css"), "utf-8");
    const sessionDomain = readFileSync(join(repo, "web-console", "js", "session-domain.js"), "utf-8");
    const oldShell = readFileSync(join(repo, "web-console", "index.html"), "utf-8");
    const baseCss = readFileSync(join(repo, "web-console", "css", "base.css"), "utf-8");
    const protocol = readFileSync(join(repo, "expo-app", "src", "protocol.ts"), "utf-8");
    const orgZone = readFileSync(join(repo, "expo-app", "src", "screens", "OrgZone.tsx"), "utf-8");
    const teamDetail = readFileSync(join(repo, "expo-app", "src", "screens", "TeamDetailPage.tsx"), "utf-8");
    const detailScreen = readFileSync(join(repo, "expo-app", "src", "screens", "DetailScreen.tsx"), "utf-8");
    // web
    assert(teamDomain.includes('[["planned", "规划中"], ["backlog", "待认领"]'), "web lanes planned 首位（泳道序：规划中→待认领→…）");
    assert(teamDomain.includes('planned: "idle"'), "web stripe planned=灰系（未开始族，禁新色）");
    assert(teamDomain.includes('data-board-schedule') && teamDomain.includes('data-board-scrap'), "web 卡面排产/废弃钮（data 属性面）");
    assert(teamDomain.includes("确认废弃"), "web 废弃两步武装（破坏性动作不裸奔）");
    assert(teamDomain.includes("暂无规划——缓做想法"), "web planned 泳道空态指引文案");
    assert((tokensCss.match(/--p-planned: #55677F/g) ?? []).length >= 1 && (tokensCss.match(/--p-planned: #74879E/g) ?? []).length >= 1,
      "tokens.css --p-planned 双主题=灰系同 backlog 值（dark #55677F/light #74879E）");
    assert(sessionDomain.includes('["planned", "规划中"]') && sessionDomain.includes('l.k !== "done"'),
      "会话域抽屉词表含 planned+activeN 按位假设修复（slice(0,4) 废）");
    assert(oldShell.includes('planned: "规划中"') && oldShell.includes("planned: -1"),
      "老壳 index.html BOARD_LANE 前向精修（正名+最前位）");
    assert(baseCss.includes(".board-progress .planned") && baseCss.includes(".task-planacts") && baseCss.includes(".lane-bar i.planned"),
      "base.css 三锚：总览条段/卡面操作行/抽屉比例条段");
    // RN
    assert(protocol.includes('"planned" | "backlog"'), "RN protocol BoardEntryStatus 含 planned（词表锚注释在场）");
    assert(orgZone.includes('["planned", "规划中"],'), "RN BOARD_LANES planned 首位");
    assert(teamDetail.includes('planned: { dark: "#55677F", light: "#74879E" }'), "RN LANE_COLORS planned=灰系同 backlog 值");
    assert(teamDetail.includes('"ready_to_install", "claimed", "submitted", "backlog", "planned", "done"'), "RN 渲染序 planned 沉完成前（行动优先序保持）");
    assert(teamDetail.includes("tPlanBtn") && teamDetail.includes("确认废弃？"), "RN 卡面排产/废弃钮+两步武装");
    assert(detailScreen.includes('{ k: "planned", label: "规划中" }') && detailScreen.includes('l.k !== "done"'),
      "RN DetailScreen 词表+activeN 按位假设修复");
    // 词表镜像单点纪律：web/RN 词表行数量级健全（防半改）
    assert((teamDomain.match(/"planned"/g) ?? []).length >= 3, "web planned 锚多点在位（lanes/stripe/操作）");

    console.log(`\nplanlane: ${pass}/${pass + fail} passed`);
    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error("FATAL", err);
    process.exit(1);
  } finally {
    process.env = prev;
    try { rmSync(ORG, { recursive: true, force: true }); } catch {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  }
}

void main();
