// prchip（t-07183db2，1104 用户问「pr 审查在泳道里有体现吗」）：板卡 PR 徽章全链测试。
// 七面：
//   S1 词表单点（PR_STATES org-schema 权威 + BOARD/DISPATCH 双 SCHEMA 键登记）
//   S2 upsertBoardEntry pr_url 行为（落值/pr_state 缺省补 ci_unknown/https 词表外
//      零渲染锚在端上——服务端 upsert 落值即透传/null 清除/state 孤儿不落/schema 过闸）
//   S3 pr-report 全链（orgAction：dispatch 建单建卡→submitted→pr-report 落值→板卡
//      pr_url/pr_state→台账末行带 pr_url+generation 透传→BOARD_UPDATED 广播帧携带）
//   S4 pr-report 校验拒（词表外 pr_state/非 https pr_url/缺 dispatch_id/双空/无对应卡）
//   S5 sqlite v11 三处同步（迁移后列在场/import 往返 pr_url 进出/read-mode 投影带回）
//   S6 端上静态锚（web prChip 构造+委托分支+CSS pr-dot 色轴零新色；RN protocol 字段
//      +TeamDetailPage chip+Linking+tPrDot）
// 沙盒：CCR_ORG_DIR/CCR_DATA_DIR 隔离+json 读档+fake agent（test-planlane 同款）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { PR_STATES, applyOrgChange, BOARD_ENTRY_SCHEMA, DISPATCH_ENTRY_SCHEMA } from "../src/org-schema.js";
import { upsertBoardEntry, loadBoard, type BoardEntry } from "../src/projects.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { dispatchEntriesFromDb } from "../src/storage/read-mode.js";
import { importDispatchLesson } from "../src/storage/import-dispatch-lesson.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

let pass = 0, fail = 0;
function assert(cond: boolean, name: string, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}` + (detail ? "｜" + detail : "")); }
}
const j = (x: unknown) => JSON.stringify(x);
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
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-prchip-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-prchip-"));
  // prchipR1（P2 配套）：归档面隔离——原夹具未盖 CCR_ARTIFACTS_DIR，dispatch 终态首
  // 归档写真实 ~/.cc-deck/artifacts/dispatch-runs/（夹具泄真目录）；本断言组要读
  // terminal-stats，顺带把泄真修掉
  const ART = mkdtempSync(join(tmpdir(), "ccr-art-prchip-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PM_DUTY = "0";
  delete process.env.CCR_CWD;
  try {
    // ============ S1 词表单点 ============
    console.log("S1 词表单点（PR_STATES org-schema 权威）:");
    assert(j(PR_STATES) === j(["open", "merged", "ci_green", "ci_red", "ci_unknown"]), "词表五值（open/merged/ci_green/ci_red/ci_unknown）");
    assert(!!BOARD_ENTRY_SCHEMA.pr_url && BOARD_ENTRY_SCHEMA.pr_url.type === "string", "BOARD_ENTRY_SCHEMA 登记 pr_url");
    assert(BOARD_ENTRY_SCHEMA.pr_state?.type === "enum" && j(BOARD_ENTRY_SCHEMA.pr_state?.enumTable) === j(PR_STATES), "BOARD_ENTRY_SCHEMA 登记 pr_state（enum 锚词表）");
    assert(!!DISPATCH_ENTRY_SCHEMA.pr_url && DISPATCH_ENTRY_SCHEMA.pr_state?.type === "enum", "DISPATCH_ENTRY_SCHEMA 登记两键");
    assert(applyOrgChange("board-entry", { id: "t-x", text: "x", status: "backlog", ts: 1, updated_at: 1, pr_url: "https://github.com/a/b/pull/8", pr_state: "ci_green" }).ok === true, "board-entry 校验：合法 pr_url/pr_state 过闸");
    assert(applyOrgChange("board-entry", { id: "t-x", text: "x", status: "backlog", ts: 1, updated_at: 1, pr_state: "bogus" }).ok === false, "board-entry 校验：词表外 pr_state 拒写");

    // ============ S2 upsertBoardEntry pr_url 行为 ============
    console.log("S2 upsertBoardEntry（板写口）:");
    const cfg: RelayConfig = {
      port: 8814, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "m", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "prchip-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "prchip 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建（正经立项）");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });

    const mk = upsertBoardEntry(gid, { text: "PR 徽章样卡", status: "backlog" });
    assert(mk.ok === true, "前置：建卡");
    const kid = String(okEntry(mk)?.id ?? "");
    const p1 = upsertBoardEntry(gid, { id: kid, text: "PR 徽章样卡", pr_url: "https://github.com/humumu130/cc-deck/pull/8" });
    assert(p1.ok === true && okEntry(p1)?.pr_url === "https://github.com/humumu130/cc-deck/pull/8", "pr_url 落值");
    assert(okEntry(p1)?.pr_state === "ci_unknown", "pr_state 缺省自动补 ci_unknown（有 PR 状态未明）");
    const p2 = upsertBoardEntry(gid, { id: kid, text: "PR 徽章样卡", pr_url: "https://github.com/humumu130/cc-deck/pull/8", pr_state: "ci_green" });
    assert(okEntry(p2)?.pr_state === "ci_green", "pr_state 显式更新（CI 绿）");
    const p3 = upsertBoardEntry(gid, { id: kid, text: "PR 徽章样卡", pr_state: "ci_red" });
    assert(okEntry(p3)?.pr_state === "ci_red", "只更新 pr_state（PR 在场允许）");
    const p4 = upsertBoardEntry(gid, { id: kid, text: "PR 徽章样卡", pr_url: null });
    assert(!okEntry(p4)?.pr_url && !okEntry(p4)?.pr_state, "pr_url:null 清除（连带 pr_state——PR 关闭/收割去徽章）");
    // state 孤儿：无 PR 的卡只写 state 不落
    const mk2 = upsertBoardEntry(gid, { text: "无 PR 普通卡", status: "backlog" });
    const kid2 = String(okEntry(mk2)?.id ?? "");
    const orphan = upsertBoardEntry(gid, { id: kid2, text: "无 PR 普通卡", pr_state: "ci_green" });
    assert(orphan.ok === true && !okEntry(orphan)?.pr_state && !okEntry(orphan)?.pr_url, "state 孤儿不落（无 PR 的卡只写 state 被忽略）");

    // ============ S3 pr-report 全链 ============
    console.log("S3 pr-report 全链（orgAction→板卡+台账+广播）:");
    const boardFrames: Array<Record<string, unknown>> = [];
    bus.subscribe((ev: unknown) => {
      const e = ev as { type?: string; payload?: Record<string, unknown> };
      if (e?.type === "BOARD_UPDATED") boardFrames.push(e.payload ?? {});
    });
    // dispatch 建单（派单建卡联动——卡带 dispatch_id）
    const dp = mgr.orgAction("dispatch", { anchor, prompt: "prchip 派单样例：交付开 PR", gid, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(dp.ok === true, "前置：派单建单" + (dp.ok ? "" : "｜" + (dp.error ?? "")));
    const dispatchId = String(dp.dispatch_id ?? "");
    await waitFor(() => !!dispatchId && loadBoard(gid).entries.some((x) => x.dispatch_id === dispatchId), 6000);
    const dcard = loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
    assert(!!dcard, "派单联动建卡（dispatch_id 挂卡）");
    // 完成候选进 submitted（徽章主场景态）
    if (dcard) {
      const toSub = upsertBoardEntry(gid, { id: dcard.id, text: dcard.text, status: "done", review_required: true });
      assert(toSub.ok === true && okEntry(toSub)?.status === "submitted", "前置：卡进 submitted（完成候选）");
    }
    const pr = mgr.orgAction("pr-report", { dispatch_id: dispatchId, pr_url: "https://github.com/humumu130/cc-deck/pull/9", pr_state: "ci_green" }) as { ok: boolean; data?: { entry?: BoardEntry }; error?: string };
    assert(pr.ok === true, "pr-report 落值成功" + (pr.ok ? "" : "｜" + (pr.error ?? "")));
    const after = loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
    assert(after?.pr_url === "https://github.com/humumu130/cc-deck/pull/9" && after?.pr_state === "ci_green", "板卡带 pr_url+pr_state（BOARD_UPDATED/SNAPSHOT 透传源）");
    // 台账续行：末行带 pr_url；generation 若在场透传
    const ledRows = readDispatchLog().filter((r) => r.id === dispatchId);
    const lastLed = ledRows.at(-1);
    assert(lastLed?.pr_url === "https://github.com/humumu130/cc-deck/pull/9" && lastLed?.pr_state === "ci_green", "台账末行带 pr_url/pr_state（审计面）");
    assert(lastLed?.status === ledRows[0]?.status, "续行 status 保持（状态机不动）");
    // BOARD_UPDATED 广播帧携带
    await wait(60);
    const frameHit = boardFrames.some((f) => {
      const delta = f.delta as { entries?: { upserts?: BoardEntry[] } } | undefined;
      return delta?.entries?.upserts?.some((e) => e.pr_url === "https://github.com/humumu130/cc-deck/pull/9") ?? false;
    });
    assert(frameHit, "BOARD_UPDATED delta.upserts 携带 pr_url（端上 chip 数据链）");
    // 状态更新覆盖（CI 转红）
    const pr2 = mgr.orgAction("pr-report", { dispatch_id: dispatchId, pr_state: "ci_red" }) as { ok: boolean; error?: string };
    assert(pr2.ok === true, "pr-report 只更新状态（CI 转红）");
    const after2 = loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
    assert(after2?.pr_state === "ci_red" && after2?.pr_url === "https://github.com/humumu130/cc-deck/pull/9", "状态覆盖更新（URL 保持）");
    // ============ S3b prchipR1（P2）：run_ref 透传——终态续行不重归档 ============
    // 修复前：pr-report 续行（status=done 透传）不带 run_ref → appendDispatch 终态咽喉
    // 命中 archiveDispatchTerminal 重归档 → terminal-stats/events-slice 被续行 ts 覆写
    //（实证 done 真值 duration≈1000ms 覆写成 59000ms 假时长，PM 收割上报必现）。
    // 修复后：续行行透传 prev.run_ref → 咽喉 !run_ref 闸不触发 → 首归档值纹丝不动。
    console.log("S3b run_ref 透传（终态续行不重归档）:");
    const statsPath = join(ART, "dispatch-runs", dispatchId, "terminal-stats.json");
    assert(existsSync(statsPath), "前置：终态首归档在案（terminal-stats 三件套——dispatch done 收口时 archiveDispatchTerminal 落盘）");
    const statsBefore = existsSync(statsPath) ? readFileSync(statsPath, "utf-8") : "";
    const rowAfterPr2 = readDispatchLog().filter((r) => r.id === dispatchId).at(-1);
    assert(!!rowAfterPr2?.run_ref, "终态续行行带 run_ref（透传在位——重归档闸的防触发键）");
    const pr3 = mgr.orgAction("pr-report", { dispatch_id: dispatchId, pr_state: "ci_green" }) as { ok: boolean };
    assert(pr3.ok === true, "前置：再续一行（ci_green 回转，第三行续行）");
    const statsAfter = existsSync(statsPath) ? readFileSync(statsPath, "utf-8") : "";
    assert(statsAfter === statsBefore && statsBefore !== "", "续行后 terminal-stats 保持首归档值（重归档未触发——duration/终态读数不被续行 ts 覆写）");

    // ============ S4 校验拒 ============
    console.log("S4 pr-report 校验拒:");
    const bad1 = mgr.orgAction("pr-report", { dispatch_id: dispatchId, pr_url: "ftp://x/pull/1" }) as { ok: boolean; error?: string };
    assert(bad1.ok === false && (bad1.error ?? "").includes("https"), "非 https pr_url 拒");
    const bad2 = mgr.orgAction("pr-report", { dispatch_id: dispatchId, pr_state: "bogus" }) as { ok: boolean; error?: string };
    assert(bad2.ok === false && (bad2.error ?? "").includes("词表"), "词表外 pr_state 拒");
    const bad3 = mgr.orgAction("pr-report", { pr_url: "https://github.com/a/b/pull/1" }) as { ok: boolean; error?: string };
    assert(bad3.ok === false && (bad3.error ?? "").includes("dispatch_id"), "缺 dispatch_id 拒");
    const bad4 = mgr.orgAction("pr-report", { dispatch_id: dispatchId }) as { ok: boolean; error?: string };
    assert(bad4.ok === false, "双空（无 pr_url 无 pr_state）拒");
    const bad5 = mgr.orgAction("pr-report", { dispatch_id: "no-such-dispatch", pr_url: "https://github.com/a/b/pull/2" }) as { ok: boolean; error?: string };
    assert(bad5.ok === false && (bad5.error ?? "").includes("未找到"), "无对应板卡拒");
    const bad6 = mgr.orgAction("pr-report", { dispatch_id: kid2, pr_url: "https://github.com/a/b/pull/3" }) as { ok: boolean; error?: string };
    assert(bad6.ok === false, "entry id 冒充 dispatch_id 拒（只按台账 id 定位）");

    // ============ S5 sqlite v11 三处同步 ============
    console.log("S5 sqlite v11（dispatch 表加列三处同步）:");
    const sdb = mkdtempSync(join(tmpdir(), "ccr-prchip-sqlite-"));
    const boardsDir = join(sdb, "boards");
    writeFileSync(join(sdb, "dispatch-log.ndjson"), [
      j({ ts: 1, id: "d-pr1", tier: "轻立项", target: "org-leader", status: "done", session_id: "s1", receipt: "结果：完成｜改动文件：无", pr_url: "https://github.com/a/b/pull/5", pr_state: "merged" }),
      j({ ts: 2, id: "d-pr2", tier: "轻立项", target: "org-leader", status: "done", session_id: "s2", receipt: "结果：完成｜改动文件：无" }),
    ].join("\n") + "\n", "utf-8");
    const port = createSqlitePort({ dataDir: sdb });
    port.open();
    runMigrations(port, migrations);
    const cols = port.query<{ name: string }>("PRAGMA table_info(dispatch)").map((c) => c.name);
    assert(cols.includes("pr_url") && cols.includes("pr_state"), "v11 迁移后列在场（PRAGMA table_info——schema.ts 三处之一）");
    const imp = importDispatchLesson(port, { dispatchLogFile: join(sdb, "dispatch-log.ndjson"), boardsDir });
    assert(!imp.skipped && imp.counts.dispatch >= 2, "导入器消费 ndjson（INSERT 两列写入——import-dispatch 三处之二）", `counts=${j(imp.counts)}`);
    const proj = dispatchEntriesFromDb(port).filter((e) => e.id === "d-pr1" || e.id === "d-pr2");
    const hit1 = proj.find((e) => e.id === "d-pr1");
    assert(hit1?.pr_url === "https://github.com/a/b/pull/5" && hit1?.pr_state === "merged", "投影带回 pr_url/pr_state（read-mode SELECT 三处之三）");
    const hit2 = proj.find((e) => e.id === "d-pr2");
    assert(!hit2?.pr_url && !hit2?.pr_state, "旧行/无 PR 行不带键（null 不带=宽容对齐）");

    // ============ S6 端上静态锚 ============
    console.log("S6 三端静态锚:");
    const webTeam = readFileSync(join(repo, "web-console", "js", "team-domain.js"), "utf-8");
    assert(webTeam.includes("data-board-pr") && webTeam.includes("pr-chip"), "web：PR chip 构造+data-board-pr 标记");
    assert(webTeam.includes("__ccDeck005OpenUrl(prUrl)"), "web：点击走统一开链（桌面 openExternal/浏览器降级）");
    assert(webTeam.includes("ci_green") && webTeam.includes("ci_red") && webTeam.includes("ci_unknown"), "web：CI 三态词表锚（relay PR_STATES 镜像）");
    assert(!/pr-chip[^}]*#[0-9a-f]{3,6}/.test(webTeam), "web：chip 无新色值（色轴走 CSS 变量）");
    const webCss = readFileSync(join(repo, "web-console", "css", "base.css"), "utf-8");
    assert(webCss.includes(".pr-dot.ok") && webCss.includes(".pr-dot.bad") && webCss.includes(".pr-dot.mid"), "CSS：pr-dot 三态（ok/bad/mid）");
    assert(webCss.includes("var(--done)") && webCss.includes("var(--error)") && webCss.includes("var(--faint)"), "CSS：CI 点纯既有变量（零新色）");
    const rnProto = readFileSync(join(repo, "expo-app", "src", "protocol.ts"), "utf-8");
    assert(rnProto.includes("pr_url?: string") && rnProto.includes("pr_state?: string"), "RN：protocol BoardEntry 镜像字段");
    const rnPage = readFileSync(join(repo, "expo-app", "src", "screens", "TeamDetailPage.tsx"), "utf-8");
    assert(rnPage.includes("Linking.openURL(url)") && rnPage.includes("tPrDot"), "RN：chip 点击 Linking 直达+tPrDot 样式");
    assert(rnPage.includes("e.pr_url") && rnPage.includes("ci_unknown"), "RN：数据面消费 pr_url+词表缺省锚");
    // 旧卡零渲染（降级）双端锚
    assert(webTeam.includes('if (!url || !/^https:\\/\\//i.test(url)) return "";'), "web：无 pr_url/异常值零渲染");
    assert(rnPage.includes('if (!url || !/^https:\\/\\//i.test(url)) return null;'), "RN：同款零渲染");

    console.log("");
    console.log(fail === 0 ? `PASS ${pass}（prchip：词表/板写/pr-report 全链/校验拒/sqlite 三处/三端锚）` : `FAIL ${pass}/${pass + fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    Object.assign(process.env, prev);
    rmSync(ART, { recursive: true, force: true });
  }
}

void main();
