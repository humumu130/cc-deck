// W-DUTYBACKOFF-R2 测试件（t-059c971a，test.4 实锤 external PM 消费断链）：
//   A external 真身复刻（核心断链形态→修后绿）：pushExternalLog 复刻 emitTranscriptEntry
//     形态（text=truncate(全文,400)+full=全文）——长前置+末行 DUTY_RECEIPT accept 三 sid
//     →duty-reviewed.json 落盘+审计 duty-receipt-accept；before 对照（无 full=text-only
//     截断）→不消费（证明 full 是唯一通路——test.4 断链根因复刻）
//   B 幂等：同 receipt 重放（full 同）→feed_id Set 去重→accept 审计不重复
//   C 观测窗（件③）：CCR_DUTY_RECEIPT_GRACE_MS 短窗——duty PM Stop 边沿（override 命中）
//     →窗尽无消费→duty-receipt-missing 审计；消费后 Stop→无 missing（容忍带防误报）
//   D 回归锚：bridge Stop 挂点（pushAssistantTexts+noteExternalDutyTurnEnd）文本锚
// 沙盒：test-dutywire 同款。跑法：env -u CCR_DATA_DIR -u CCR_ORG_DIR npx tsx scripts/test-dutybackoffr2.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { writeCollabMode } from "../src/settings.js";
import { setPmOverride } from "../src/org.js";
import { readDutyReviewed } from "../src/leader-duty.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, extra = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("✗ " + n + (extra ? "｜" + extra : "")); } };

const dirs: string[] = [];
function sandbox(tag: string) {
  const dataDir = mkdtempSync(join(tmpdir(), `ccr-dbr2-${tag}-`));
  const orgDir = mkdtempSync(join(tmpdir(), `ccr-dbr2-org-${tag}-`));
  dirs.push(dataDir, orgDir);
  const prev = { ...process.env } as Record<string, string | undefined>;
  process.env.CCR_ORG_DIR = orgDir;
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_ARTIFACTS_DIR = join(dataDir, "artifacts");
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_COLLAB_MODE = "";
  delete process.env.CCR_COLLAB_MODE;
  const cfg: RelayConfig = { port: 8890 + Math.floor(Math.random() * 60), token: "t", tokenGenerated: false, defaultCwd: "", model: "test-model", bridgeToken: "bt", dataDir, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
  const bus = new EventBus({ persistPath: join(dataDir, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  return { dataDir, orgDir, mgr, cleanup: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s); // emitTranscriptEntry 同款
// events 帧注入（external 席位活跃度凭证——cli_pid=0 override 判活的唯一来源）
import { appendFileSync } from "node:fs";
function seedFrame(dataDir: string, sid: string, ts: number): void {
  appendFileSync(join(dataDir, "events.ndjson"), JSON.stringify({ seq: Math.floor(ts / 1000), session_id: sid, ts, type: "SESSION_HEARTBEAT", payload: {} }) + "\n");
}
const auditText = (dataDir: string) => { try { return readFileSync(join(dataDir, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } };

// 真身回执行（test.4 形态：feed_id+accept 三 sid——PM 已手动止血的三张即此类）
const SID_A = "sid-aaa-1111", SID_B = "sid-bbb-2222", SID_C = "sid-ccc-3333";
const RECEIPT_LINE = `DUTY_RECEIPT {"v":1,"feed_id":"feed-bc83ae95","actions":[{"kind":"accept","ids":["${SID_A}","${SID_B}","${SID_C}"]}],"blocked":[],"next_trigger":"turn_end"}`;
// 长前置（值守回合的分析正文——把 DUTY_RECEIPT 行挤出 text 的 400 字窗）
const LONG_PREFIX = "值守回执审查：".repeat(90) + "\n\n逐张核对（bc83ae95 三张陈回执证据充分，均予验收）。\n\n";

async function main() {
  try {
    console.log("A external 真身复刻（text 截断 400+full 全文——test.4 断链形态）:");
    {
      const f = sandbox("a");
      writeCollabMode(f.dataDir, "no-leader");
      setPmOverride({ session_id: "ext-dutypm", cli_pid: 0, cwd: "/tmp", claimed_at: Date.now() });
      f.mgr.ensureExternal("ext-dutypm", "/tmp", "duty pm"); // 会话在册（pushExternalLog 前提）
      seedFrame(f.dataDir, "ext-dutypm", Date.now());
      // 修后通路：full 在——text 截断无所谓
      f.mgr.pushExternalLog("ext-dutypm", "assistant_text", truncate(LONG_PREFIX + RECEIPT_LINE, 400), undefined, { full: LONG_PREFIX + RECEIPT_LINE });
      const reviewed = readDutyReviewed(f.orgDir);
      ok(reviewed.includes(SID_A) && reviewed.includes(SID_B) && reviewed.includes(SID_C), `A1 full 全文→三 sid reviewed 落盘（实 ${reviewed.length} sid）`);
      ok(auditText(f.dataDir).includes("duty-receipt-accept"), "A2 消费审计在（duty-receipt-accept）");
      // before 对照：同内容但无 full（旧通路复刻）→截断行 parse 失败→静默不消费
      const f2 = sandbox("a2");
      writeCollabMode(f2.dataDir, "no-leader");
      f2.mgr.ensureExternal("ext-dutypm-old", "/tmp", "duty pm old");
      f2.mgr.pushExternalLog("ext-dutypm-old", "assistant_text", truncate(LONG_PREFIX + RECEIPT_LINE, 400), undefined, {});
      ok(!readDutyReviewed(f2.orgDir).includes(SID_A), "A3 before 对照：text-only（截断）→不消费（test.4 断链根因复刻——full 是唯一通路）");
      f.cleanup(); f2.cleanup();
    }

    console.log("B 幂等（重放不重复记账）:");
    {
      const f = sandbox("b");
      writeCollabMode(f.dataDir, "no-leader");
      f.mgr.ensureExternal("ext-dutypm", "/tmp", "duty pm");
      for (let i = 0; i < 3; i++) f.mgr.pushExternalLog("ext-dutypm", "assistant_text", truncate(RECEIPT_LINE, 400), undefined, { full: RECEIPT_LINE });
      const acc = auditText(f.dataDir).split("\n").filter((l) => l.includes("duty-receipt-accept")).length;
      ok(acc === 1, `B1 同 receipt 三次重放→accept 审计恰一条（feed_id Set 去重，实 ${acc}）`);
      ok(readDutyReviewed(f.orgDir).length === 3, "B2 reviewed 无重复 sid（union 落盘）");
      f.cleanup();
    }

    console.log("C 观测窗（Stop 边沿→窗尽无消费→missing 审计）:");
    {
      const f = sandbox("c");
      writeCollabMode(f.dataDir, "no-leader");
      setPmOverride({ session_id: "ext-dutypm", cli_pid: 0, cwd: "/tmp", claimed_at: Date.now() });
      f.mgr.ensureExternal("ext-dutypm", "/tmp", "duty pm");
      seedFrame(f.dataDir, "ext-dutypm", Date.now()); // 活跃凭证（cli_pid=0 席位判活唯一来源）
      process.env.CCR_DUTY_RECEIPT_GRACE_MS = "150";
      // 断链形态：Stop 边沿起窗→不消费→窗尽 missing
      f.mgr.noteExternalDutyTurnEnd("ext-dutypm", { force: true }); // force=窗机制直测（席位判定 dutywire/seatlive 已测面）
      await new Promise((r) => setTimeout(r, 400));
      const miss = auditText(f.dataDir);
      ok(miss.includes("duty-receipt-missing") && miss.includes("断链观测"), `C1 断链回合→窗尽 missing 审计在（实「${miss.split("\n").find((l) => l.includes("duty-receipt-missing"))?.slice(0, 80) ?? "无"}」）`);
      // 正常形态：先消费（回合末行已推）再 Stop→容忍带（消费在 turnEnd 邻域）→无新 missing
      const before2 = auditText(f.dataDir).split("\n").filter((l) => l.includes("duty-receipt-missing")).length;
      f.mgr.pushExternalLog("ext-dutypm", "assistant_text", RECEIPT_LINE, undefined, { full: RECEIPT_LINE });
      f.mgr.noteExternalDutyTurnEnd("ext-dutypm", { force: true });
      await new Promise((r) => setTimeout(r, 400));
      const after2 = auditText(f.dataDir).split("\n").filter((l) => l.includes("duty-receipt-missing")).length;
      ok(after2 === before2, `C2 消费在 Stop 邻域→容忍带无新 missing（防正常回合误报，${before2}→${after2}）`);
      // 非 duty 会话 Stop 不起窗
      const f3 = sandbox("c3");
      writeCollabMode(f3.dataDir, "no-leader");
      setPmOverride({ session_id: "ext-dutypm", cli_pid: 0, cwd: "/tmp", claimed_at: Date.now() });
      f3.mgr.ensureExternal("ext-dutypm", "/tmp", "duty pm");
      seedFrame(f3.dataDir, "ext-dutypm", Date.now());
      process.env.CCR_DUTY_RECEIPT_GRACE_MS = "150";
      f3.mgr.noteExternalDutyTurnEnd("ext-其他会话");
      await new Promise((r) => setTimeout(r, 300));
      ok(!auditText(f3.dataDir).includes("duty-receipt-missing"), "C3 非 duty 目标 Stop 不起窗（无回执预期面零观测）");
      process.env.CCR_DUTY_RECEIPT_GRACE_MS = "";
      f.cleanup(); f3.cleanup();
    }

    console.log("D 回归锚（bridge Stop 挂点）:");
    {
      const bt = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf-8");
      ok(bt.includes('ev.event === "Stop"') && bt.includes("noteExternalDutyTurnEnd") && bt.includes("pushAssistantTexts(this.extId(ev), ev.transcript_path)"), "D1 bridge Stop 挂点（增量补读+观测窗起表）");
      const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
      ok(sm.includes("(entry as { full: string }).full") && sm.includes("W-DUTYBACKOFF-R2"), "D2 消费挂点吃全文（full 优先——截断断链根治锚）");
    }

    console.log(`\ndutybackoffr2: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
    process.exit(fail ? 1 : 0);
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
void main();
