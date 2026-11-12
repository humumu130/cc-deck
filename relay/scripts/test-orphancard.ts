// orphancard（t-0b2ed6c7，1109 用户质问治本）：孤儿卡源头三断口契约锁。
//   R1（t-60c5d6ad，审查 t-ea2391a7 定谳返修）：
//   · P0 findContCard 双形态触发——生产真身 7 张全后缀式「W-XXX 续跑」（A6 组真板
//     title **原样**入测：夹具与生产分叉=W-P2BATCH5 P0-2 同族病，组红线）
//   · P1 链闭 claimed 活性闸（F 组 SessionManager 真链双场景：活会话跳过/死会话照翻
//     ——审查 adversarial 重演入测）
//   · P2 B4 恒真断言改直等 + chainBaseSlug 吃数字代尾（-review2=今日现行重派约定）
//   今日三波手工清：①09 时 no_pr 键缺失（dutyreviewed 根修在案）②15 时 9 张审查卡
//   （收割翻主卡不翻审查卡——baseSlug 基族不含 -review 尾）③15 时 11 张续跑重投孤儿
//   （org dispatch「W-XXX 续跑」建新卡——首版正则只吃前缀式 0/7 命中，R1 双形态根治）。
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainBaseSlug, findContCard, harvestKeyOf, zombieInvariantScan } from "../src/board-recon.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadBoard, upsertBoardEntry } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}

console.log("A. 刀一 findContCard（续跑唤醒复用原卡——不建新卡）");
{
  const entries = [
    { id: "t-orig", text: "W-ORPHAN 主单（原卡）" },
    { id: "t-r1", text: "W-ORPHAN-R1 返修单" },
    { id: "t-other", text: "W-OTHER 无关单" },
  ];
  ok(findContCard(entries, "续跑 W-ORPHAN 停滞单继续处理") === "t-orig", "A1 续跑前缀式命中原卡（终态卡复活复用）");
  ok(findContCard(entries, "续跑 w-orphan-r1 返修继续") === "t-r1", "A2 基族含 -rN 代尾（命中返修卡）");
  ok(findContCard(entries, "续跑 W-NOTEXIST") === null, "A3 板上无原卡=首次形态（null→照旧建新卡）");
  ok(findContCard(entries, "W-ORPHAN 新单（非续跑形态）") === null, "A4 非续跑形态不触发（正常派单零影响）");
  ok(findContCard([], "续跑 W-ORPHAN") === null, "A5 空板回落新卡");
}
{
  // —— R1 P0：生产真板 fixture（1109 现板 pg-7cb58ab4 实勘**原样拷入**——7 张孤儿卡
  // title（后缀式「W-XXX 续跑」=PM 真实重投派单 title）+对应原卡（leader 台账 1109 同日
  // 实单文本）。孤儿卡本体也入列（板序=时间序：原卡在前）——精确代次优先应越过后产
  // 孤儿卡命中前代原卡。零手造形态。 ——
  const realBoard = [
    { id: "t-p2b5r1", text: "W-P2BATCH5-R1 返修P0x2删件③+V1-d实勘（1109）" },
    { id: "t-revxrev", text: "W-REVEXCL-REVIEW 双档审查review-of路径谓词（1109）" },
    { id: "t-headc", text: "W-HEAD-C 桌面状态栏三路C交互方案裁决（1109二轮）" },
    { id: "t-proj1", text: "W-PROJTEAM1 项目⊇团队分层期一实施（1109用户拍板）" },
    { id: "t-headfix", text: "W-HEADFIX 手机head重设计实施A'单行化（1109三路裁决）" },
    { id: "t-revxr1", text: "W-REVEXCL-R1 返修review-of路径谓词（1109）" },
    { id: "t-proj1rev", text: "W-PROJTEAM1-REVIEW 双档审查A模型B界面（1109）" },
    { id: "t-z1", text: "W-P2BATCH5-R1 续跑" },
    { id: "t-z2", text: "W-REVEXCL-REVIEW 续跑" },
    { id: "t-z3", text: "W-HEAD-C 续跑" },
    { id: "t-z4", text: "W-PROJTEAM1 续跑" },
    { id: "t-z5", text: "W-HEADFIX 续跑" },
    { id: "t-z6", text: "W-REVEXCL-R1 续跑" },
    { id: "t-z7", text: "W-PROJTEAM1-REVIEW 续跑" },
  ];
  // 7 张真板重投 title（孤儿卡文本=当次派单 title 原样）——后缀式全命中
  ok(findContCard(realBoard, "W-P2BATCH5-R1 续跑") === "t-p2b5r1", "A6 真板①后缀式命中（审查 P0 根治——首版 0/7）");
  ok(findContCard(realBoard, "W-REVEXCL-REVIEW 续跑") === "t-revxrev", "A7 真板②审查单续跑（raw 含 -review 尾精确）");
  ok(findContCard(realBoard, "W-HEAD-C 续跑") === "t-headc", "A8 真板③主单续跑");
  ok(findContCard(realBoard, "W-PROJTEAM1 续跑") === "t-proj1", "A9 真板④主单续跑（同键孤儿卡在后不抢——精确代次板序优先）");
  ok(findContCard(realBoard, "W-HEADFIX 续跑") === "t-headfix", "A10 真板⑤主单续跑");
  ok(findContCard(realBoard, "W-REVEXCL-R1 续跑") === "t-revxr1", "A11 真板⑥返修代续跑");
  ok(findContCard(realBoard, "W-PROJTEAM1-REVIEW 续跑") === "t-proj1rev", "A12 真板⑦审查单续跑");
  ok(findContCard(realBoard, "续跑 W-P2BATCH5-R1") === "t-p2b5r1", "A13 双形态同归（前缀式与后缀式命中同卡）");
  ok(findContCard(realBoard, "中断文案分类：外部 CLI 不诺自动续跑") === null, "A14 词边界：正文含「自动续跑」不误触（leader 台账 311 笔唯一续跑词命中即此 title 原样）");
  ok(findContCard(realBoard, "续跑 巡查员上岗轮值") === null, "A15 含续跑词但无 w- 键→null（非本面回落新卡）");
}

console.log("B. 刀二 chainBaseSlug（收割闭链基族——审查尾扩展）");
{
  ok(chainBaseSlug("w-orphan") === "w-orphan", "B1 主单键原样");
  ok(chainBaseSlug("w-orphan-r1") === "w-orphan", "B2 -rN 代尾剥（原 cardlife 语义保持）");
  ok(chainBaseSlug("w-orphan-review") === "w-orphan", "B3 -review 审查尾剥（1109 九张滞留根）");
  ok(chainBaseSlug("w-orphan-audit") === "w-orphan", "B4 -audit 复审尾剥（R1 改直等断言——原写法三元条件永假=恒真，-audit 从未被真测）");
  ok(chainBaseSlug("w-orphan-r1-review") === "w-orphan", "B5 多重尾循环剥（返修的审查）");
  ok(chainBaseSlug("w-orphanreview") === "w-orphanreview", "B6 词边界：无连字符尾不剥（防误伤独立单名）");
  ok(chainBaseSlug("w-headfix-review2") === "w-headfix", "B8 -review2 数字代尾剥（R1 P2-2：今日现行重派约定 W-HEADFIX-REVIEW2 真单形态）");
  ok(chainBaseSlug("w-x-audit3") === "w-x", "B9 -audit3 数字代尾剥");
  ok(chainBaseSlug("w-x-r1-review2") === "w-x", "B10 多重尾含数字代（返修的二次审查）");
  ok(chainBaseSlug("w-revexcl-fin") === "w-revexcl-fin", "B11 低频尾不剥（-fin 披露面——zombie TTL 兜底，防误伤优先于覆盖率）");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok(sm.includes("private closeChainSiblings(") && sm.includes("chainBaseSlug(curKey)"), "B7 cardlife 闭链基族已换单点（源码锚——W-CARDTERM 提取 closeChainSiblings 共享方法：pr-report MERGED+board move→done 双触发同源，链窗双向化）");
}

console.log("C. 刀三 harvestKeyOf 归一锁测（续跑/返修后缀天然归一——防漂移）");
{
  ok(harvestKeyOf("续跑 W-ORPHAN 停滞单") === "w-orphan", "C1 前缀词不挡键提取");
  ok(harvestKeyOf("W-ORPHAN 续跑") === "w-orphan", "C2 后缀词不进键");
  ok(harvestKeyOf("W-ORPHAN-R1 返修") === "w-orphan-r1", "C3 返修代尾在键（对账证据按代匹配）");
}

console.log("D. 今日三波复现（纯函数级+接线锚）");
{
  // 波③：续跑重投——复用路径断言（源码锚：建卡段 contCardId 分支在）
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok(sm.includes("findContCard(loadBoard(input.gid).entries") && sm.includes("input.entry_id ?? contCardId ?? "), "D1 波③ 续跑复用接线（findContCard→taskRefId 四处同键）+建卡分支跳过防双写");
  ok(sm.includes("续跑复用原卡"), "D2 复用翻卡 note 留痕（不建新卡）");
  // 波②：审查卡联动——chainBaseSlug 使 w-xxx-review 归 w-xxx 基族（cardlife prevs 同基族判定即覆盖）
  ok(chainBaseSlug("w-patrolfix-review") === chainBaseSlug("w-patrolfix"), "D3 波② 审查卡归主单基族（终代收割闭链覆盖审查卡）");
  // 波①：no_pr 键（dutyreviewed 批根修）——溯源锚
  ok(sm.includes("no_pr"), "D4 波① no_pr 键链在位（dutyreviewed 根修——溯源锚）");
  // R1 P1：链闭活性闸接线锚（精确到谓词调用形态）
  ok(sm.includes("sessionActiveByEvents(this.cfg.dataDir, pv.owner_session)"), "D5 活性闸接线（claimed prevs×sessionActiveByEvents 真调用）");
}

console.log("E. zombie 对账兜底（历史孤儿/未来漏网——三证强翻）");
{
  // 续跑卡超 TTL + dev log 有原单收割词 → 强翻动作（对账不再依赖 PM 手工）
  const boards = [{
    gid: "pg-x",
    board: {
      id: "b", name: "组", status: "active", updated_at: 0, entries: [
        { id: "t-zomb", text: "W-ZOMB 续跑重投（历史孤儿形态）", status: "claimed", ts: Date.now() - 10 * 3600_000, updated_at: Date.now() - 10 * 3600_000 },
      ],
    } as never,
  }];
  const harvest = {
    doneLedger: new Map([["w-zomb", { count: 1, hasReceipt: true }]]),
    receiptSlugs: new Set(["w-zomb"]),
    devLogText: "… [任务] W-ZOMB：原单已收割（dev log 词证据）…",
  } as never;
  const { actions } = zombieInvariantScan({ boards, harvest: harvest as never, ttlMs: 6 * 3600_000 });
  ok(actions.length === 1 && actions[0].entryId === "t-zomb" && actions[0].evidence === "ledger-done", `E1 续跑孤儿卡超 TTL 三证强翻（evidence=${actions[0]?.evidence}）`);
  // 词边界保护回归：卡键 w-sup 不被 dev log 里 w-super 误命中（既有 R1-P2-2② 保护不回退）
  const harvest2 = { doneLedger: new Map(), receiptSlugs: new Set(), devLogText: "w-super 已收割" } as never;
  const boards2 = [{ gid: "pg-x", board: { id: "b", name: "组", status: "active", updated_at: 0, entries: [{ id: "t-sup", text: "W-SUP 短键卡", status: "claimed", ts: Date.now() - 10 * 3600_000, updated_at: Date.now() - 10 * 3600_000 }] } as never }];
  const r2 = zombieInvariantScan({ boards: boards2, harvest: harvest2 as never, ttlMs: 6 * 3600_000 });
  ok(r2.actions.length === 1 && r2.actions[0].evidence === null, "E2 词边界保护：w-sup 不被 w-super 超串误命中（证据 null=保守告警不翻）");
}

console.log("F. P1 链闭活性闸（SessionManager 真链双场景——审查 adversarial 重演入测）");
{
  // 场景（审查回指 adversarial 原样）：主单（claimed·死会话）→ 审A（claimed·活会话）
  // → R1 终代（submitted）PR merged → 死主单照翻 done / 活审A 跳过不误翻+告警审计。
  const ORG = mkdtempSync(join(tmpdir(), "oc1-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "oc1-data-"));
  const ART = mkdtempSync(join(tmpdir(), "oc1-art-"));
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE, CCR_CONFIG_FILE: process.env.CCR_CONFIG_FILE };
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA; process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_STORAGE_READ_MODE = "json";
  const cfgDir = mkdtempSync(join(tmpdir(), "oc1-cfg-"));
  process.env.CCR_CONFIG_FILE = join(cfgDir, "config.json");
  const cfg: RelayConfig = {
    port: 8890 + Math.floor(Math.random() * 60), token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(() => ({
    id: randomUUID(), startedAt: Date.now(), ended: true,
    sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
    stop: async () => {}, setPermissionMode: async () => {},
  }));
  try {
    const pc = mgr.orgAction("project-create", { name: "oc1 组", anchor: "/tmp/oc1", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
    const gid = pc.data?.group?.id ?? "pg-oc1";
    if (pc.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
    const boardPath = join(ORG, "boards", `${gid}.json`);
    const boardUpsert = (text: string, status: string) => mgr.orgAction("board", { op: "upsert", gid, text, status });
    // 测试直写板文件（owner_session/ts/dispatch_id 命令面不透传——cardlifer2 同款先例：
    // journal/status 面与生产同构，等价派单联动结果）
    const patchBoard = (prefix: string, kv: Record<string, unknown>) => {
      const b = JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: Array<Record<string, unknown>> };
      const e = b.entries.find((x) => String(x.text).startsWith(prefix));
      if (!e) throw new Error(`patchBoard 卡未找到: ${prefix}`);
      Object.assign(e, kv);
      writeFileSync(boardPath, JSON.stringify(b), "utf-8");
      return String(e.id);
    };
    const deadSid = "sid-dead-0001", liveSid = "sid-live-0002";
    boardUpsert("W-OCFAM 主单（死会话 claimed）", "claimed");
    patchBoard("W-OCFAM 主单", { owner_session: deadSid, ts: Date.now() - 3 * 3600_000 });
    boardUpsert("W-OCFAM-REVIEW A档审查（活会话 claimed）", "claimed");
    patchBoard("W-OCFAM-REVIEW", { owner_session: liveSid, ts: Date.now() - 2.5 * 3600_000 });
    // 终代 submitted（cardlifer2 同款内核路径：claimed→done(review_required)=完成候选）
    boardUpsert("W-OCFAM-R1 返修终代", "claimed");
    const termId = patchBoard("W-OCFAM-R1", { dispatch_id: "d-oc1-term" });
    const rSub = upsertBoardEntry(gid, { id: termId, text: "W-OCFAM-R1 返修终代", status: "done", review_required: true });
    if (!rSub.ok) throw new Error("mkSubmitted 失败");
    // 活会话喂活：events.ndjson 近窗事件（sessionActiveByEvents 真函数吃真文件）
    appendFileSync(join(DATA, "events.ndjson"), JSON.stringify({ seq: 1, session_id: liveSid, ts: Date.now(), type: "SESSION_UPDATED" }) + "\n");
    const rep = mgr.orgAction("pr-report", { dispatch_id: "d-oc1-term", pr_url: "https://github.com/x/y/pull/9", pr_state: "merged" }) as { ok: boolean; error?: string };
    ok(rep.ok, "F0 pr-report merged 受理");
    const b2 = loadBoard(gid);
    const main2 = b2.entries.find((x) => String(x.text).startsWith("W-OCFAM 主单"));
    const rev2 = b2.entries.find((x) => String(x.text).startsWith("W-OCFAM-REVIEW"));
    const term2 = b2.entries.find((x) => String(x.text).startsWith("W-OCFAM-R1"));
    ok(term2?.status === "done", "F1 终代 submitted→done（主链不受闸影响）");
    ok(main2?.status === "done" && String(main2?.note ?? "").includes("同链闭卡"), `F2 死会话 claimed 主单照翻 done（波②治理保真——现态 ${main2?.status}）`);
    ok(rev2?.status === "claimed", `F3 活会话 claimed 审查卡跳过不误翻（现态 ${rev2?.status}——板面不谎「已完成」）`);
    const audit = (() => { try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
    ok(audit.includes("cardlife-chain-skip-live"), "F4 skip-live 告警审计在（活会话跳过留痕——PM 可见不静默）");
    ok(audit.includes("cardlife-chain-close"), "F5 链闭审计在（死会话面照闭——审计行只报实翻集）");
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

console.log(`\n========== orphancard 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
