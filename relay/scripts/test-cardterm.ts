// W-CARDTERM 套件（1112 第六现 32 张滞卡——审查单/返修单卡终态缺口）：三刀真链
//   T1 刀一：审查单（title -REVIEW\d* 形态）收口回执合规→卡直达 done（非 submitted）
//   T2 对照：实施单同路径→submitted+资格位（R2 内核语义不变）
//   T3 刀二：board move→done 收割确认→同链 R1/REVIEW 前代卡一并闭（含 claimed 无 owner 照翻）
//   T4 刀三：recon submitted∧台账 done∧>4h→翻 done；2h 窗内不翻；claimed 1h 窗语义不变
// 真链：SessionManager 全链（closeOpenDispatches/orgAction board move/runLedgerRecon）
// →板仓 JSON 断言（design-cardlife「存状态」铁律同款）。夹具复刻 cardlifer2 mkEnv。
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
  const ORG = mkdtempSync(join(tmpdir(), "ct-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "ct-data-"));
  const ART = mkdtempSync(join(tmpdir(), "ct-art-"));
  dirs.push(ORG, DATA, ART);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE, CCR_CONFIG_FILE: process.env.CCR_CONFIG_FILE };
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA; process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_STORAGE_READ_MODE = "json";
  const cfgDir = mkdtempSync(join(tmpdir(), "ct-cfg-")); dirs.push(cfgDir);
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
  return { ORG, DATA, ART, mgr, cleanup: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

async function main() {
  try {
    // ===== T1/T2 刀一：审查单终态直达 vs 实施单 R2 内核 =====
    console.log("T1/T2 刀一 审查单收口直达 done（对照实施单 submitted 语义不变）:");
    {
      const f = mkEnv();
      const pc = f.mgr.orgAction("project-create", { name: "ct 组", anchor: "/tmp/ct", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gid = pc.data?.group?.id ?? "pg-ct";
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      const receiptOk = join(f.ART, "w-ct.md");
      writeFileSync(receiptOk, "# 回执\n\n结果：审查通过可收割｜改动文件：无（审查）\n", "utf-8");
      const attach = (textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attach 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      const mkClaimed = (text: string, dispatchId: string, title: string, sid: string) => {
        f.mgr.orgAction("board", { op: "upsert", gid, text, status: "claimed" });
        attach(text.slice(0, text.indexOf("：") + 1), dispatchId);
        appendDispatch({ ts: Date.now(), id: dispatchId, tier: "正经立项", target: "manual", status: "running", session_id: sid, title });
        (f.mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.set(sid, [{ id: dispatchId, tier: "正经立项", gid, receiptPath: receiptOk }]);
      };
      // T1 审查单（真实事故 title 形态：W-XXX-REVIEW2 尾巴批审查二）
      mkClaimed("W-CTA-REVIEW2：审查演示卡", "d-ct-rev", "W-CTA-REVIEW2 审查演示", "s-rev");
      (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches("s-rev", "done", "交付：审查结论");
      await sleep(150);
      const t1 = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-ct-rev");
      ok(t1?.status === "done", `T1 审查单收口回执合规→直达 done（${t1?.status}——非 submitted：审查单无收割后续，submitted=结构性永久滞留）`);
      ok((t1?.note ?? "").includes("cardterm"), `T1b note 终态直达留痕（${(t1?.note ?? "").slice(0, 44)}）`);
      // T2 实施单对照（title 无 -REVIEW）
      mkClaimed("W-CTB：实施演示卡", "d-ct-impl", "W-CTB 实施演示", "s-impl");
      (f.mgr as unknown as { closeOpenDispatches: (...a: unknown[]) => void }).closeOpenDispatches("s-impl", "done", "交付：实施完成");
      await sleep(150);
      const t2 = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-ct-impl");
      ok(t2?.status === "submitted" && t2?.review_required === true, `T2 实施单同路径→submitted+资格位（${t2?.status}/rr=${t2?.review_required}——R2 内核语义不变，收割复核窗保留）`);
      f.cleanup();
    }

    // ===== T3 刀二：board move→done 收割确认→同链闭（R1+REVIEW 前代） =====
    console.log("T3 刀二 move→done 同链闭（返修单+审查单前代）:");
    {
      const f = mkEnv();
      const pc = f.mgr.orgAction("project-create", { name: "ct2 组", anchor: "/tmp/ct2", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gid = pc.data?.group?.id ?? "pg-ct2";
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      const attach = (textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attach 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      // 链族（真实事故形态）：W-P2TAIL2 主链——R1 返修 submitted+REVIEW2 审查 submitted+终代 submitted
      const mkSubmittedCard = (text: string, dispatchId: string) => {
        f.mgr.orgAction("board", { op: "upsert", gid, text, status: "claimed" });
        attach(text.slice(0, text.indexOf("：") + 1), dispatchId);
        const ent = loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
        if (!ent) throw new Error("mkSubmittedCard 卡未找到");
        const r = upsertBoardEntry(gid, { id: ent.id, text: ent.text, status: "done", review_required: true });
        if (!r.ok) throw new Error("mkSubmittedCard step2 失败");
      };
      mkSubmittedCard("W-CT2X：主单卡", "d-m0");
      await sleep(25); // ts 严格递增（链窗判据 xt<ct——同毫秒建卡会全落空，cardlifer2 A2 同款坑）
      mkSubmittedCard("W-CT2X-R1：返修卡", "d-m1");
      await sleep(25);
      mkSubmittedCard("W-CT2X-REVIEW2：审查卡", "d-m2");
      const term = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-m0");
      ok(!!term, "T3 夹具：终代+R1+REVIEW2 三卡 submitted 在位");
      const mv = f.mgr.orgAction("board", { op: "move", gid, entry_id: term!.id, status: "done" }) as { ok: boolean; error?: string };
      ok(mv.ok, `T3a board move 终代→done 受理（${mv.error ?? "ok"}）`);
      const b3 = loadBoard(gid);
      const r1c = b3.entries.find((x) => x.dispatch_id === "d-m1");
      const r2c = b3.entries.find((x) => x.dispatch_id === "d-m2");
      ok(r1c?.status === "done" && (r1c?.note ?? "").includes("cardterm"), `T3b 同链 R1 返修卡连带闭（${r1c?.status}——第六现主漏面：收割只精确命中主卡）`);
      ok(r2c?.status === "done", `T3c 同链 REVIEW 审查卡连带闭（${r2c?.status}）`);
      // 异链对照：不同链基的 submitted 卡不被误闭
      mkSubmittedCard("W-OTHER：别家单卡", "d-o1");
      const b4 = loadBoard(gid);
      ok(b4.entries.find((x) => x.dispatch_id === "d-o1")?.status === "submitted", "T3d 异链 submitted 不误闭（链基识别精确）");
      f.cleanup();
    }

    // ===== T4 刀三：recon submitted 长窗兜底 =====
    console.log("T4 刀三 recon submitted∧台账 done∧>4h 翻 done（窗内不翻）:");
    {
      const f = mkEnv();
      const pc = f.mgr.orgAction("project-create", { name: "ct3 组", anchor: "/tmp/ct3", tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
      const gid = pc.data?.group?.id ?? "pg-ct3";
      if (pc.data?.needsConfirm) f.mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
      const attach = (textPrefix: string, dispatchId: string) => {
        const bp = join(f.ORG, "boards", `${gid}.json`);
        const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
        const ent = b.entries.find((x) => x.text.startsWith(textPrefix));
        if (!ent) throw new Error(`attach 卡未找到: ${textPrefix}`);
        ent.dispatch_id = dispatchId;
        writeFileSync(bp, JSON.stringify(b), "utf-8");
      };
      const mkSubmittedCard = (text: string, dispatchId: string, ledStatus: "done" | "running", ledAgeMs: number) => {
        f.mgr.orgAction("board", { op: "upsert", gid, text, status: "claimed" });
        attach(text.slice(0, text.indexOf("：") + 1), dispatchId);
        const ent = loadBoard(gid).entries.find((x) => x.dispatch_id === dispatchId);
        if (!ent) throw new Error("mkSubmittedCard 卡未找到");
        upsertBoardEntry(gid, { id: ent.id, text: ent.text, status: "done", review_required: true });
        appendDispatch({ ts: Date.now() - ledAgeMs, id: dispatchId, tier: "正经立项", target: "manual", status: ledStatus, session_id: "s-x", title: text.slice(0, text.indexOf("：")) });
      };
      mkSubmittedCard("W-CT3A：超窗滞卡", "d-t4a", "done", 5 * 3_600_000);   // done 5h 前 → 翻
      mkSubmittedCard("W-CT3B：窗内复核卡", "d-t4b", "done", 2 * 3_600_000); // done 2h 前 → 不翻
      mkSubmittedCard("W-CT3C：台账未终态卡", "d-t4c", "running", 6 * 3_600_000); // 无终态 → 不翻
      f.mgr.runLedgerRecon("cardterm-test");
      await sleep(100);
      const b5 = loadBoard(gid);
      ok(b5.entries.find((x) => x.dispatch_id === "d-t4a")?.status === "done", "T4a submitted∧done∧5h→翻 done（32 张滞卡形态根治——板不说谎优先）");
      ok(b5.entries.find((x) => x.dispatch_id === "d-t4b")?.status === "submitted", "T4b 4h 复核窗内不翻（复核权保留）");
      ok(b5.entries.find((x) => x.dispatch_id === "d-t4c")?.status === "submitted", "T4c 台账未终态不翻（终态收敛末行判据）");
      // claimed 1h 窗既有语义回归（#263 不回归）
      f.mgr.orgAction("board", { op: "upsert", gid, text: "W-CT3D：claimed 滞卡", status: "claimed" });
      attach("W-CT3D", "d-t4d");
      appendDispatch({ ts: Date.now() - 2 * 3_600_000, id: "d-t4d", tier: "正经立项", target: "manual", status: "done", session_id: "s-y", title: "W-CT3D" });
      f.mgr.runLedgerRecon("cardterm-test2");
      await sleep(100);
      ok(loadBoard(gid).entries.find((x) => x.dispatch_id === "d-t4d")?.status === "done", "T4d claimed∧done∧2h→翻（#263 1h 窗语义不回归）");
      f.cleanup();
    }

    console.log(`\n========== cardterm 套件：${pass} 通过 / ${fail} 失败 ==========`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
void main();
