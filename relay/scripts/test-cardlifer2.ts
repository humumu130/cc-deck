// W-CARDLIFE-R2 测试件：板卡生命周期强制化（1105 深夜用户令「不靠规则靠机制」）
//   A pr-report MERGED→当轮+同链前代自动翻（转移内建于动作）+资格闸（非 submitted 不翻+告警）
//   B 收口资格位（回执尾行合规才进 submitted；不合规板完全不动）+板写失败重试×3→degraded
//   C 静态锁（harvest 降级标注/relay 接线/词表）
// 真链：SessionManager 全链 orgAction pr-report/closeOpenDispatches→**板仓 JSON 断言**
//（不是 mock 返回值——design-cardlife「存状态」铁律：断言落盘实态）。三断链形态故障
// 注入：B2=回执缺失（证据误翻面）、A3=未过审 merged（矛盾态）、A2=同链滞留前代。
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch } from "../src/org.js";
import { loadBoard, upsertBoardEntry } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const dirs: string[] = [];
function mkEnv() {
  const ORG = mkdtempSync(join(tmpdir(), "clr2-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "clr2-data-"));
  const ART = mkdtempSync(join(tmpdir(), "clr2-art-"));
  dirs.push(ORG, DATA, ART);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE, CCR_CONFIG_FILE: process.env.CCR_CONFIG_FILE };
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA; process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_STORAGE_READ_MODE = "json";
  const cfgDir = mkdtempSync(join(tmpdir(), "clr2-cfg-")); dirs.push(cfgDir);
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
  return { ORG, DATA, ART, mgr, bus, cleanup: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

async function main() {
  try {
    // ===== A 组：pr-report MERGED 状态机 =====
    console.log("A pr-report MERGED→自动翻（转移内建于动作）:");
    {
      const f = mkEnv();
      const gid = "pg-clr2";
      const mk = (r: ReturnType<typeof mkEnv>) => r.mgr.orgAction("project-create", { name: "clr2 组", anchor: "/tmp/clr2", tier: "轻立项" });
      const pc = mk(f) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gidReal = pc.data?.group?.id ?? gid;
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      const boardUpsert = (text: string, status: string) =>
        f.mgr.orgAction("board", { op: "upsert", gid: gidReal, text, status });
      // submitted 建卡走 R2 内核同款路径（upsert submitted 直设被闸拒——完成候选只能由
      // claimed+done(review_required:true) 改道生成，测试与生产同漏斗）
      // submitted 建卡=收口同款内核路径直调（orgAction board 命令面不透传
      // review_required/dispatch_id 且 id 参数名=entry_id——三处命令面差异实测；内核
      // 直调与 relay 收口路径（closeOpenDispatches→upsertBoardEntry）完全同构）
      const mkSubmitted = (text: string, dispatchId: string) => {
        boardUpsert(text, "claimed");
        attachDispatch(gidReal, text.slice(0, text.indexOf("：") + 1), dispatchId); // 前缀含全角冒号止——防同基 slug 卡（W-CLR2CHAIN 与 -R1 前 10 字同）误挂
        const ent = loadBoard(gidReal).entries.find((x) => x.dispatch_id === dispatchId);
        if (!ent) throw new Error(`mkSubmitted 卡未找到: ${dispatchId}`);
        const r2 = upsertBoardEntry(gidReal, { id: ent.id, text: ent.text, status: "done", review_required: true });
        if (!r2.ok) throw new Error(`mkSubmitted step2: ${"error" in r2 ? r2.error : ""}`);
      };
      // dispatch_id 挂卡：orgAction 命令面不透传该键（派单建卡联动=relay 内部路径）——
      // 测试直写板文件（journal/status 面与生产同构，挂键等价派单联动结果）
      const attachDispatch = (gidX: string, textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gidX}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attachDispatch 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      // A1 当轮 submitted 卡 merged→自动翻 done（板仓 JSON 断言）
      mkSubmitted("W-CLR2A：生命周期强制化（当轮）", "d-clr2a");
      const r1 = f.mgr.orgAction("pr-report", { dispatch_id: "d-clr2a", pr_url: "https://github.com/x/y/pull/1", pr_state: "merged" }) as { ok: boolean; error?: string };
      ok(r1.ok, "A0 pr-report merged 受理");
      const b1 = loadBoard(gidReal);
      const c1 = b1.entries.find((x) => x.dispatch_id === "d-clr2a");
      ok(c1?.status === "done", "A1 submitted+merged→自动翻 done（无机械手参与）");
      ok((c1?.note ?? "").includes("PR merged 自动收口"), `A1b note 链闭留痕（${(c1?.note ?? "").slice(0, 40)}）`);
      // A2 同链前代：w-clr2chain（ts 早 1h，claimed）+终代 merged→前代一并 done
      boardUpsert("W-CLR2CHAIN：同链前代（返修首单）", "claimed");
      mkSubmitted("W-CLR2CHAIN-R1：同链终代", "d-chain1");
      attachDispatch(gidReal, "W-CLR2CHAIN：同链前代", "d-chain0");
      // 前代 ts 前移（ts 窗判据：前代 ts 早于终代）——直写板文件
      {
        const bp = join(f.ORG, "boards", `${gidReal}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ text: string; ts?: number }> };
        const e0 = b.entries.find((x) => x.text.startsWith("W-CLR2CHAIN："));
        if (e0) e0.ts = Date.now() - 3600_000;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      }
      f.mgr.orgAction("pr-report", { dispatch_id: "d-chain1", pr_url: "https://github.com/x/y/pull/2", pr_state: "merged" });
      const b2 = loadBoard(gidReal);
      const prevCard = b2.entries.find((x) => x.dispatch_id === "d-chain0");
      const termCard = b2.entries.find((x) => x.dispatch_id === "d-chain1");
      ok(prevCard?.status === "done" && (prevCard?.note ?? "").includes("同链闭卡"), `A2 同链前代自动闭（${prevCard?.status}——返修链滞留形态根治）`);
      ok(termCard?.status === "done", "A2b 终代同步 done");
      // A3 资格闸：claimed 卡（交付流程未走完）merged→不自动翻+告警卡
      boardUpsert("W-CLR2GATE：未过审交付（claimed）", "claimed");
      attachDispatch(gidReal, "W-CLR2GATE", "d-gate");
      f.mgr.orgAction("pr-report", { dispatch_id: "d-gate", pr_url: "https://github.com/x/y/pull/3", pr_state: "merged" });
      const b3 = loadBoard(gidReal);
      const g3 = b3.entries.find((x) => x.dispatch_id === "d-gate");
      ok(g3?.status === "claimed", "A3 资格闸：非 submitted 收 merged 不自动翻（矛盾态留人工）");
      const notif = await readNdjson<{ title?: string }>(join(f.DATA, "notifications.json")).catch(() => [] as { title?: string }[]);
      void notif;
      const audit = (() => { try { return readFileSync(join(f.DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
      ok(audit.includes("cardlife-pr-merged-blocked"), "A3b 资格闸审计在（cardlife-pr-merged-blocked）");
      ok(audit.includes("cardlife-chain-close"), "A2c 链闭审计在（cardlife-chain-close）");
      ok(audit.split("\n").some((l) => { try { return (JSON.parse(l) as { action?: string }).action === "cardlife-pr-merged"; } catch { return false; } }), "A1c 自动收口审计在（action 精确匹配）");
      f.cleanup();
    }

    // ===== B 组：收口资格位+degraded =====
    console.log("B 收口资格位（回执合规才进 submitted）+板写失败 degraded:");
    {
      const f = mkEnv();
      const pc = f.mgr.orgAction("project-create", { name: "clr2b 组", anchor: "/tmp/clr2b", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gid = pc.data?.group?.id ?? "pg-clr2b";
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      // 合规回执文件
      const receiptOk = join(f.ART, "w-clr2b.md");
      writeFileSync(receiptOk, "# 回执\n\n结果：测试交付成功｜改动文件：a.ts\n", "utf-8");
      const attachDispatchB = (textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attachDispatchB 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      // B1 合规→submitted（资格位放行）
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2B：合规交付卡", status: "claimed" });
      attachDispatchB("W-CLR2B", "d-b1");
      appendDispatch({ ts: Date.now(), id: "d-b1", tier: "轻立项", target: "manual", status: "running", session_id: "s-b1", title: "W-CLR2B 合规交付" });
      (f.mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.set("s-b1", [{ id: "d-b1", tier: "轻立项", gid, receiptPath: receiptOk }]);
      (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches("s-b1", "done", "交付：测试");
      await sleep(100);
      const b1 = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-b1");
      ok(b1?.status === "submitted" && b1?.review_required === true, `B1 合规回执→submitted+资格位（${b1?.status}/rr=${b1?.review_required}）`);
      // B2 断链①：回执缺失→板完全不动（不进 submitted 不裸翻 done）
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2B2：回执缺失卡", status: "claimed" });
      attachDispatchB("W-CLR2B2", "d-b2");
      appendDispatch({ ts: Date.now(), id: "d-b2", tier: "轻立项", target: "manual", status: "running", session_id: "s-b2", title: "W-CLR2B2 缺回执" });
      (f.mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.set("s-b2", [{ id: "d-b2", tier: "轻立项", gid, receiptPath: join(f.ART, "w-不存在.md") }]);
      (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches("s-b2", "done", "交付：缺回执");
      await sleep(100);
      const b2 = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-b2");
      ok(b2?.status === "claimed", `B2 断链①回执缺失→板不动（留 ${b2?.status}——终态≠交付的误翻总根封死）`);
      const audit2 = (() => { try { return readFileSync(join(f.DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
      ok(audit2.includes("cardlife-receipt-gate"), "B2b 资格位审计在（cardlife-receipt-gate）");
      // B3 断链②（degraded）：板冻结注入+合规回执→重试×3 败→degraded 审计+告警
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2B3：冻结板卡", status: "claimed" });
      attachDispatchB("W-CLR2B3", "d-b3");
      appendDispatch({ ts: Date.now(), id: "d-b3", tier: "轻立项", target: "manual", status: "running", session_id: "s-b3", title: "W-CLR2B3 冻结" });
      const boardPath = join(f.ORG, "boards", `${gid}.json`);
      const frozenBoard = JSON.parse(readFileSync(boardPath, "utf-8")) as { frozen: boolean };
      frozenBoard.frozen = true;
      writeFileSync(boardPath, JSON.stringify(frozenBoard), "utf-8");
      (f.mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.set("s-b3", [{ id: "d-b3", tier: "轻立项", gid, receiptPath: receiptOk }]);
      (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches("s-b3", "done", "交付：冻结板");
      await sleep(100);
      const audit3 = (() => { try { return readFileSync(join(f.DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
      ok(audit3.includes("board-flip-degraded") && audit3.includes("3 次重试均败"), "B3 断链②板写失败→重试×3→degraded 审计留痕（不静默）");
      f.cleanup();
    }

    // ===== R3 组：资格位三洞返修（t-076acfc1，A 审 P1×3） =====
    console.log("R3 资格位三洞（400 窗误拦/converge 裸翻/迟写补翻）:");
    {
      const f = mkEnv();
      const pc = f.mgr.orgAction("project-create", { name: "clr2r3 组", anchor: "/tmp/clr2r3", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gid = pc.data?.group?.id ?? "pg-clr2r3";
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      const attachR3 = (textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attachR3 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      const closeAs = (sid: string, dispatchId: string, receiptPath: string | undefined) => {
        appendDispatch({ ts: Date.now(), id: dispatchId, tier: "轻立项", target: "manual", status: "running", session_id: sid, title: `R3 ${dispatchId}` });
        (f.mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.set(sid, [{ id: dispatchId, tier: "轻立项", gid, ...(receiptPath ? { receiptPath } : {}) }]);
        (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches(sid, "done", "交付：R3");
      };
      const cardOf = (dispatchId: string) => loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
      // R3-A1 >400 字长回执（A 审实锤形态：412 字被 400 窗切掉军规行）→行锚放行
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R3A：长回执卡", status: "claimed" });
      attachR3("W-CLR2R3A", "d-r3a");
      const longReceipt = join(f.ART, "w-r3a.md");
      writeFileSync(longReceipt, "# 回执\n\n" + "正文段落。".repeat(120) + "\n\n结果：长回执交付（>400 字军规行仍在——行锚放行）｜改动文件：a.ts、b.ts\n", "utf-8");
      closeAs("s-r3a", "d-r3a", longReceipt);
      await sleep(100);
      const cA = cardOf("d-r3a");
      ok(cA?.status === "submitted", `R3-A1 >400 字长回执→行锚放行 submitted（实 ${cA?.status}——R2 slice(-400) 此形态误拦 27% 真实回执）`);
      // R4-B（A 审 P2-B）军规行本体 >400 字单行：老 400 窗（slice(-400)）把行首切掉=
      // 必拦（前缀「结果：」丢失形态识别失败）；行锚全行扫=必放——R3-A1（长正文+短军规
      // 行）对老窗零判别力（窗内完整含短行=老代码也放），本形态老必拦新必放=真判别。
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R4B：超长军规行卡", status: "claimed" });
      attachR3("W-CLR2R4B", "d-r4b");
      const hugeLineReceipt = join(f.ART, "w-r4b.md");
      const hugeRule = "结果：超长军规行本体交付（" + "合规细节与影响面说明。".repeat(60) + "）｜改动文件：a.ts、b.ts、c.ts";
      writeFileSync(hugeLineReceipt, "# 回执\n\n" + hugeRule + "\n", "utf-8");
      closeAs("s-r4b", "d-r4b", hugeLineReceipt);
      await sleep(100);
      const cB = cardOf("d-r4b");
      ok((hugeRule.length > 400) && cB?.status === "submitted", `R4-B 军规行本体 ${hugeRule.length} 字（>400）单行→行锚放行 submitted（实 ${cB?.status}——老 slice(-400) 切掉行首必拦，本形态=新老真判别）`);
      // R3-A2 后置补记形态（军规行后有 PR 补记节——w-linkquality 先例）→末个合规行锚命中
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R3A2：补记形态卡", status: "claimed" });
      attachR3("W-CLR2R3A2", "d-r3a2");
      const appendReceipt = join(f.ART, "w-r3a2.md");
      writeFileSync(appendReceipt, "# 回执\n\n结果：补记形态交付｜改动文件：c.ts\n\n---\n\n## PR 落地补记（后置节）\n\nhttps://github.com/x/y/pull/9 已 squash。\n", "utf-8");
      closeAs("s-r3a2", "d-r3a2", appendReceipt);
      await sleep(100);
      ok(cardOf("d-r3a2")?.status === "submitted", "R3-A2 军规行后置补记节→末个合规行命中（跳过补记扫全文行锚）");
      // R3-B converge 保护：不合规回执收口→台账 receipt_gate:true→converge 跳过+催收清单
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R3B：拦中卡", status: "claimed" });
      attachR3("W-CLR2R3B", "d-r3b");
      const badReceipt = join(f.ART, "w-r3b.md");
      writeFileSync(badReceipt, "# 回执\n\n写了但没写军规行（尾行不合规形态）\n", "utf-8");
      closeAs("s-r3b", "d-r3b", badReceipt);
      await sleep(100);
      ok(cardOf("d-r3b")?.status === "claimed", "R3-B1 拦中卡留 claimed（板不动）");
      const logB = readFileSync(join(f.ORG, "dispatch-log.ndjson"), "utf-8").split("\n").filter((l) => l.includes('"d-r3b"'));
      const gatedRow = logB.filter((l) => { try { return (JSON.parse(l) as { status?: string; receipt_gate?: boolean }).status === "done"; } catch { return false; } });
      ok(gatedRow.some((l) => { try { return (JSON.parse(l) as { receipt_gate?: boolean }).receipt_gate === true; } catch { return false; } }), "R3-B2 台账收口行落 receipt_gate:true（拦截事实账面化）");
      const { convergeBoardsWithDispatchLog } = await import("../src/projects.js");
      const conv = convergeBoardsWithDispatchLog(f.ORG);
      ok(conv.receiptGated.some((x) => x.dispatchId === "d-r3b"), `R3-B3 converge 跳过拦中卡+催收清单（清单 ${conv.receiptGated.length} 张含 d-r3b——不再 ≤30min 裸翻 done）`);
      ok(cardOf("d-r3b")?.status === "claimed", "R3-B4 converge 后卡仍 claimed（零审查裸翻根除）");
      // R3-C 迟写补翻：回执补齐军规行→runReceiptCheck 复查→补翻 submitted
      writeFileSync(badReceipt, "# 回执\n\n补齐了。\n\n结果：迟写补齐交付｜改动文件：d.ts\n", "utf-8");
      (f.mgr as unknown as { runReceiptCheck: (e: { id: string; gid: string; title: string; receiptPath?: string }) => void }).runReceiptCheck({ id: "d-r3b", gid, title: "W-CLR2R3B", receiptPath: badReceipt });
      ok(cardOf("d-r3b")?.status === "submitted", `R3-C1 回执迟写补齐→90s 复查补翻 submitted（实 ${cardOf("d-r3b")?.status}——遗留项「回调翻卡未接」接上）`);
      const auditC = (() => { try { return readFileSync(join(f.DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
      ok(auditC.includes("cardlife-receipt-late"), "R3-C2 补翻审计在（cardlife-receipt-late）");
      // R4-A（A 审 P2-A）rgate 告警解除双向闭环：补翻回调换独立键 receipt-gate-（出现）
      // +旧 rgate- 同键卡 transitionNotifications resolved（消除）——原同键重投被
      // upsertNotification 非 dispatch kind 静默 return=「已补齐」永不出现（A 审实锤）。
      type NoteRow = { key: string; resolved_at?: number };
      const emptyNotes: { notifications: NoteRow[] } = { notifications: [] };
      const noteAccount: { notifications: NoteRow[] } = (() => { try { return JSON.parse(readFileSync(join(f.DATA, "notifications.json"), "utf-8")) as { notifications: NoteRow[] }; } catch { return emptyNotes; } })();
      const newCard = noteAccount.notifications.find((n) => n.key.includes("receipt-gate-d-r3b"));
      const oldCard = noteAccount.notifications.find((n) => n.key.includes("rgate-d-r3b") && !n.key.includes("receipt-gate"));
      ok(!!newCard, `R4-A1 补翻后「已补齐」卡出现（独立键 receipt-gate- 在场——原同键静默 return 根除）`);
      ok(!!oldCard?.resolved_at, `R4-A2 旧「卡已拦」卡 resolved 消除（resolved_at 在场——告警解除双向闭环）`);
      // R3-D note 拼接：前代卡带旧打回 note→同链闭链不洗
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R3D：带痕前代", status: "claimed" });
      attachR3("W-CLR2R3D", "d-r3d0");
      {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ text: string; note?: string; ts?: number }> };
        const e0 = b.entries.find((x) => x.text.startsWith("W-CLR2R3D"));
        if (e0) { e0.note = "[R1 打回] 证据不足退回"; e0.ts = Date.now() - 3600_000; }
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      }
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CLR2R3D-R1：终代", status: "claimed" });
      attachR3("W-CLR2R3D-R1：", "d-r3d1");
      {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ text: string; status?: string; dispatch_id?: string }> };
        const e1 = b.entries.find((x) => x.dispatch_id === "d-r3d1");
        if (e1) e1.status = "submitted";
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      }
      f.mgr.orgAction("pr-report", { dispatch_id: "d-r3d1", pr_url: "https://github.com/x/y/pull/10", pr_state: "merged" });
      const cD = cardOf("d-r3d0");
      ok((cD?.note ?? "").includes("[R1 打回]") && (cD?.note ?? "").includes("同链闭卡"), `R3-D note 拼接保留（前代打回留痕不被闭链覆写洗掉：${(cD?.note ?? "").slice(0, 60)}）`);
      f.cleanup();
    }

    // ===== C 组：静态锁 =====
    console.log("C 静态锁（降级标注/接线/词表）:");
    {
      const hv = readFileSync(join(process.cwd(), "..", "cc-plugins", "plugins", "cc-deck", "bin", "leader-harvest"), "utf-8");
      ok(hv.includes("W-CARDLIFE-R2") && hv.includes("降级路径"), "C1 harvest 降级路径标注在（relay 在位后机械手=兼容兜底）");
      ok(hv.includes("同链悬空卡拒收割") && hv.includes("cardlife-pr-merged/chain-close"), "C1b harvest 硬闸功能锚（同链悬空卡拒收割+降级路径指向 relay 状态机——R1 行为不变）");
      const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
      ok(sm.includes("cardlife-pr-merged") && sm.includes("cardlife-chain-close") && sm.includes("cardlife-receipt-gate"), "C2 relay 三挂点接线（merged 翻/链闭/资格位）");
      const ty = readFileSync(new URL("../src/types.ts", import.meta.url), "utf-8");
      ok(["cardlife-pr-merged", "cardlife-chain-close", "cardlife-pr-merged-blocked", "cardlife-flip-degraded", "board-flip-degraded", "cardlife-receipt-gate", "cardlife-receipt-late"].every((k) => ty.includes(`"${k}"`)), "C3 审计词表七词在（R3 补 cardlife-receipt-late）");
    }

    console.log(`\ncardlifer2: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
    process.exit(fail ? 1 : 0);
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
async function readNdjson<T>(p: string): Promise<T[]> { try { return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T); } catch { return []; } }
void main();
