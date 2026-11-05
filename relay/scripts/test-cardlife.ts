// W-CARDLIFE（1105 用户军令「卡片生命周期的每个节点应该都要处理、都要翻转」）——
// 同链前代卡联动翻转+审查节点表达 全链测试（真跑 leader-harvest bash×沙盒 relay）。
// 覆盖：
//   A 同链翻转：slug 两轮 dispatch（R0+R1，orgAction dispatch 内建两卡）→ ledger 手写
//     同 slug 两行 → leader-harvest <R1did> --merge → 板仓 JSON 断言 R0/R1 卡同帧
//     done + note 带「收割链闭」（断链形态③前代卡滞留的机械手收口——验收点 1）
//   B 幂等：二次 --merge 已 done 卡跳过零误翻
//   C 审查打回：leader-harvest <did> --reject "<原因>" → 本单卡 note 追加「R<N> 打回」
//     且状态不动（不新增枚举）；非本单卡零打扰
//   D 边界：无 slug 账行（账外单）--merge 零翻转不炸；无卡 dispatch 链零翻转
// 直跑：cd relay && env -u CCR_TOKEN -u CCR_STUB_MODE npx tsx scripts/test-cardlife.ts
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { loadBoard } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import { randomUUID } from "node:crypto";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 6000, every = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}
const here = fileURLToPath(import.meta.url);
const harvestBin = join(here, "..", "..", "..", "cc-plugins", "plugins", "cc-deck", "bin", "leader-harvest");

const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => { setTimeout(() => { if (!a.ended) { cb.onLog("assistant_text", "完成\n结果：完成｜改动文件：无（夹具回执）"); cb.onTurnEnd(true, "success", 5); } }, 5); },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => { if (!a.ended) { cb.onInit("sdk-" + a.id.slice(0, 8), model, "default"); if (prompt !== undefined) setTimeout(() => { if (!a.ended) { cb.onLog("assistant_text", "完成\n结果：完成｜改动文件：无（夹具回执）"); cb.onTurnEnd(true, "success", 5); } }, 5); } }, 5);
    return a;
  };

const gitRun = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccr-cardlife-"));
  const orgD = join(root, "org");
  const dataD = join(root, "data");
  const artD = join(root, "artifacts");
  mkdirSync(orgD, { recursive: true }); mkdirSync(dataD, { recursive: true }); mkdirSync(artD, { recursive: true });
  const prev = { ...process.env } as Record<string, string | undefined>;
  process.env.CCR_ORG_DIR = orgD;
  process.env.CCR_DATA_DIR = dataD;
  process.env.CCR_ARTIFACTS_DIR = artD;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_MDNS = "1";
  delete process.env.CCR_CWD;
  try {
    // ---------- 沙盒 relay（HTTP——bash 的 org_post 真链目标） ----------
    const port = 18600 + Math.floor(Math.random() * 300);
    const tok = "cardlife-tok";
    process.env.CCR_PORT = String(port);
    process.env.CCR_TOKEN = tok;
    const cfg: RelayConfig = { port, token: tok, tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: dataD, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
    const bus = new EventBus({ persistPath: join(dataD, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "前置 Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "cardlife-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "cardlife 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "前置 组建");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });
    const server = startServer(bus, mgr, cfg, {});
    await wait(300);

    // ---------- 夹具：两轮 dispatch（同 slug R0+R1，orgAction 内建两卡）+ ledger ----------
    const SLUG = "cardlife-chain";
    const d0 = mgr.orgAction("dispatch", { anchor, prompt: "cardlife R0 初代单（夹具）", gid, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(d0.ok === true, "前置 R0 派单" + (d0.ok ? "" : "｜" + (d0.error ?? "")));
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "cardlife R1 返修单（夹具）", gid, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(d1.ok === true, "前置 R1 派单" + (d1.ok ? "" : "｜" + (d1.error ?? "")));
    const did0 = String(d0.dispatch_id ?? ""), did1 = String(d1.dispatch_id ?? "");
    await waitFor(() => loadBoard(gid).entries.filter((e) => e.dispatch_id === did0 || e.dispatch_id === did1).length === 2, 8000);
    const cards = loadBoard(gid).entries;
    assert(cards.some((e) => e.dispatch_id === did0) && cards.some((e) => e.dispatch_id === did1), "前置 两轮派单联动建卡（R0/R1 卡 dispatch_id 挂卡）");
    // 闸面夹具（同 test-harvest）：假 worktree（base+新提交）+合规回执
    const wt = join(root, "wt-cardlife");
    mkdirSync(wt, { recursive: true });
    gitRun(wt, ["init", "-q"]); gitRun(wt, ["config", "user.email", "t@t"]); gitRun(wt, ["config", "user.name", "t"]);
    writeFileSync(join(wt, "a.txt"), "1"); gitRun(wt, ["add", "-A"]); gitRun(wt, ["commit", "-qm", "base"]);
    const baseSha = gitRun(wt, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(wt, "b.txt"), "2"); gitRun(wt, ["add", "-A"]); gitRun(wt, ["commit", "-qm", "[任务] cardlife worker 提交"]);
    const receipt = join(root, "w-cardlife-fixture.md");
    writeFileSync(receipt, "## 根因\n夹具\n## 自测\n夹具\n## 验收点\n夹具\n\n结果：完成｜改动文件：a.ts\n", "utf-8");
    // ledger 同 slug 两行（R0+R1——同链寻址键）
    const ledgerRow = (id: string, title: string) => JSON.stringify({ dispatch_id: id, id, title, session_id: "s-cardlife", slug: SLUG, gid, type: "fix", branch: "fix/cardlife", base_sha: baseSha, worktree: wt, receipt, gate: "ok" });
    writeFileSync(join(dataD, "leader-dispatches.ndjson"), ledgerRow(did0, "R0 初代") + "\n" + ledgerRow(did1, "R1 返修") + "\n", "utf-8");
    // 台账终态（bash 寻址兜底面——ledger 在即可）
    const before0 = loadBoard(gid).entries.find((e) => e.dispatch_id === did0);
    const before1 = loadBoard(gid).entries.find((e) => e.dispatch_id === did1);

    // ---------- A 同链翻转：harvest <R1> --merge ----------
    console.log("A 同链联动翻转：");
    // HTTP 探针：bash 的 curl 打同一 port——先证 server 活（拒绝=server 面，通=env 面）
    try {
      const probeRes = await fetch(`http://127.0.0.1:${port}/api/org?token=${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status" }) });
      const probeBody = (await probeRes.text()).slice(0, 80);
      console.log(`  [探针] HTTP ${probeRes.status}: ${probeBody}`);
      assert(probeRes.status < 500, "A前置 沙盒 relay HTTP 活（bash curl 同 port 可达）", probeBody);
    } catch (e) {
      assert(false, "A前置 沙盒 relay HTTP 活（fetch 拒绝——server 未起）", String(e).slice(0, 100));
    }
    const runBash = async (args: string[]): Promise<string> => {
      try {
        const r = await execFileAsync("bash", [harvestBin, ...args], { encoding: "utf-8", env: { ...process.env, CCR_PORT: String(port), CCR_TOKEN: tok, CCR_ORG_DIR: orgD, CCR_DATA_DIR: dataD }, maxBuffer: 8 * 1024 * 1024 });
        return r.stdout;
      } catch (e) {
        const err = e as { stdout?: string; code?: number };
        return (err.stdout ?? "") + `\n(bash exit ${err.code ?? "?"})`;
      }
    };
    const outA = await runBash([did1, "--merge"]);
    console.log(outA.split("\n").filter((l) => /翻转|✓ 卡|✗ 卡|RESULT/.test(l)).map((l) => "  | " + l).join("\n"));
    const afterA = loadBoard(gid).entries;
    const a0 = afterA.find((e) => e.dispatch_id === did0);
    const a1 = afterA.find((e) => e.dispatch_id === did1);
    assert(a0?.status === "done" && a1?.status === "done", `A① R0/R1 卡同帧翻 done（R0=${a0?.status} R1=${a1?.status}——前代卡不再滞留）`);
    assert(!!a0?.note && a0.note.includes("收割链闭") && a0.note.includes(did1.slice(0, 8)), `A② 前代卡 note 链闭标记（含末代单 id ${did1.slice(0, 8)}）`, (a0?.note ?? "").slice(0, 120));
    assert(!!a1?.note && a1.note.includes("收割链闭"), "A③ 当轮卡 note 同样链闭");
    assert(outA.includes("RESULT harvest=") && !outA.includes("✗ 卡"), "A④ bash 全绿零翻转失败");
    assert((a0?.transitions ?? []).some((t) => t.status === "done") && (a1?.transitions ?? []).some((t) => t.status === "done"), "A⑤ transitions 记 done 翻转时刻（状态真时刻留痕）");

    // ---------- B 幂等：二次 --merge 已 done 跳过 ----------
    console.log("B 幂等：");
    const outB = await runBash([did1, "--merge"]);
    const afterB = loadBoard(gid).entries.find((e) => e.dispatch_id === did0);
    assert(outB.includes("已 done——跳过"), "B① 已 done 卡跳过（幂等零误翻）");
    assert((afterB?.note ?? "").split("收割链闭").length - 1 === 1, "B② note 不重复追加（链闭标记恰一次）", (afterB?.note ?? "").slice(0, 160));

    // ---------- C 审查打回：--reject ----------
    console.log("C 审查打回：");
    // 新一轮 R2（第三代——打回对象）：先翻回 submitted 形态（审查中）便于断言状态不动
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "cardlife R2 二次返修单（夹具）", gid, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string };
    assert(d2.ok === true, "C前置 R2 派单");
    const did2 = String(d2.dispatch_id ?? "");
    await waitFor(() => loadBoard(gid).entries.some((e) => e.dispatch_id === did2 && e.status === "submitted"), 10000); // 等稳定态（fake agent 后台收口搬卡 claimed→submitted——防 reject 窗口竞态）
    const led = readFileSync(join(dataD, "leader-dispatches.ndjson"), "utf-8");
    writeFileSync(join(dataD, "leader-dispatches.ndjson"), led + ledgerRow(did2, "R2 二次返修") + "\n", "utf-8");
    const c2Before = loadBoard(gid).entries.find((e) => e.dispatch_id === did2);
    const outC = await runBash([did2, "--reject", "P1 边界漏判——请返修（夹具原因）"]);
    console.log(outC.split("\n").filter((l) => /打回|✓ 卡|✗ 卡|RESULT/.test(l)).map((l) => "  | " + l).join("\n"));
    const c2After = loadBoard(gid).entries.find((e) => e.dispatch_id === did2);
    assert(!!c2After?.note && /R2 打回：P1 边界漏判/.test(c2After.note), `C① 本单卡 note 追加「R2 打回：<原因>」（世代轮次=R2 实锚）`, (c2After?.note ?? "").slice(0, 160));
    assert(c2After?.status === c2Before?.status, `C② 状态不动（before=${c2Before?.status} after=${c2After?.status}——不新增枚举，返修收割时链闭）`);
    const r0After = loadBoard(gid).entries.find((e) => e.dispatch_id === did0);
    assert(!(r0After?.note ?? "").includes("打回"), "C③ 非本单卡零打扰（R0 卡 note 无打回）");

    // ---------- D 边界 ----------
    console.log("D 边界：");
    writeFileSync(join(dataD, "leader-dispatches.ndjson"), ledgerRow("d-noslug-x", "无slug账外行").replace(`"slug":"${SLUG}"`, '"slug":""') + "\n", "utf-8");
    const outD = await runBash(["d-noslug-x", "--merge"]);
    assert(outD.includes("RESULT harvest=d-noslug-x fails=0") || outD.includes("RESULT harvest=d-noslug-x"), "D① 无 slug 账行 --merge 零翻转不炸（链寻址空=无操作）");
    const r2Final = loadBoard(gid).entries.find((e) => e.dispatch_id === did2);
    assert(r2Final?.status === c2Before?.status, "D② R2 卡不受边界跑动（仍待返修态）");

    // ---------- E R1 返修：退出码守卫+链窗+reject 幂等 ----------
    console.log("E R1 返修：");
    // E 前置：D 组整文件覆写了 ledger——重建 did1/did2 账行（E 组自洽夹具）
    writeFileSync(join(dataD, "leader-dispatches.ndjson"), ledgerRow(did1, "R1 返修") + "\n" + ledgerRow(did2, "R2 二次返修") + "\n", "utf-8");
    // E①（P1）死端口：env 覆盖 CCR_PORT 打向死口——org_post 全拒→翻转失败→exit 1+锁保留
    const wtLock = join(root, "wt-cardlife", ".cc-deck-lock");
    // 先造活锁形态：直接写锁文件（leader-dispatch 语义——树锁在场）
    writeFileSync(wtLock, JSON.stringify({ slug: SLUG, dispatch_id: did1, session_id: "s-cardlife", created_at: Date.now(), expires_at: Date.now() + 7200_000 }), "utf-8");
    const deadPort = 18790; // 与沙盒 relay 错开的死口（E 组专用——复用 runBash 但改 env port）
    let deadOut = "";
    try {
      const r = await execFileAsync("bash", [harvestBin, did1, "--merge"], { encoding: "utf-8", env: { ...process.env, CCR_PORT: String(deadPort), CCR_TOKEN: tok, CCR_ORG_DIR: orgD, CCR_DATA_DIR: dataD }, maxBuffer: 8 * 1024 * 1024 });
      deadOut = r.stdout;
    } catch (e) {
      const err = e as { stdout?: string; code?: number };
      deadOut = (err.stdout ?? "") + `\n(bash exit ${err.code ?? "?"})`;
    }
    console.log(deadOut.split("\n").filter((l) => /RESULT|锁|exit|✗/.test(l)).map((l) => "  | " + l).join("\n"));
    assert(/\(bash exit 1\)$/.test(deadOut.trim()) || deadOut.includes("(bash exit 1)"), `E① 死端口 EXIT_CODE=1（修前 exit 0——A 审受控实验复现）`, deadOut.slice(-120));
    assert(/RESULT harvest=\S+ fails=[1-9]/.test(deadOut), `E② fails>0 RESULT 响亮（闸红/翻红任一路径——修前死端口 exit 0 静默）`, deadOut.slice(-160));
    assert(existsSync(wtLock), "E③ 锁文件物理在场（rm 未执行）");
    // E④ 修复后（活端口）锁正常清+exit 0（对照组）
    const outE4 = await runBash([did1, "--merge"]);
    assert(!existsSync(wtLock), "E④ 活端口闸全绿（卡已 done）→锁正常清（对照）");
    assert(!outE4.includes("(bash exit"), `E④b 对照 exit 0（${outE4.slice(-60).trim()}）`);
    // E⑤（P2-1）链窗：ledger 追加同 slug 老线行（ts=20 天前）+新线卡——老线卡不被新线翻
    const oldTs = Date.now() - 20 * 86400 * 1000;
    const oldRow = JSON.stringify({ dispatch_id: "d-oldline", id: "d-oldline", title: "R0 初代（老线复用同题）", session_id: "s-cardlife", slug: SLUG, gid, type: "fix", branch: "fix/cardlife", base_sha: baseSha, worktree: wt, receipt, gate: "ok", ts: oldTs });
    const ledNow = readFileSync(join(dataD, "leader-dispatches.ndjson"), "utf-8");
    writeFileSync(join(dataD, "leader-dispatches.ndjson"), ledNow + oldRow + "\n", "utf-8");
    // 老线卡造册（板仓直插 submitted 形态——夹具权限在测试进程内）
    const boardNow = loadBoard(gid);
    const boardPath = join(orgD, "boards", gid + ".json");
    const rawBoard = JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: Array<Record<string, unknown>> };
    rawBoard.entries.push({ id: "e-oldline", text: "cardlife 老线卡（20 天前同题）", status: "submitted", dispatch_id: "d-oldline", updated_at: oldTs });
    writeFileSync(boardPath, JSON.stringify(rawBoard), "utf-8");
    const outE5 = await runBash([did1, "--merge"]);
    const oldCard = JSON.parse(readFileSync(boardPath, "utf-8")) as { entries: Array<{ id: string; status?: string; dispatch_id?: string }> };
    const eOld = oldCard.entries.find((x) => x.dispatch_id === "d-oldline");
    assert(eOld?.status === "submitted", `E⑤ 老线卡（ts 距 20 天>窗 14）不被新线翻（实 ${eOld?.status}——误伤绝迹）`);
    assert(!outE5.includes("e-oldline"), "E⑤b 老线卡零触碰输出");
    // E⑥（P3-1）reject 幂等：同理由二次 --reject 不重复录
    const outE6a = await runBash([did2, "--reject", "幂等验证理由"]);
    const outE6b = await runBash([did2, "--reject", "幂等验证理由"]);
    const c2n = loadBoard(gid).entries.find((e) => e.dispatch_id === did2);
    const hits = ((c2n?.note ?? "").match(/打回：幂等验证理由/g) ?? []).length;
    assert(outE6b.includes("幂等跳过"), `E⑥ 二次运行幂等跳过（${outE6b.includes("幂等跳过") ? "在" : "缺"}）`);
    assert(hits === 1, `E⑥b note 打回标记恰一次（实 ${hits}——修前每次运行+1）`, (c2n?.note ?? "").slice(-160));

    await server.close();
    console.log(`\n========== cardlife 套件：${pass} 通过 / ${fail} 失败 ==========`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    if (prev.CCR_PORT === undefined) delete process.env.CCR_PORT; else process.env.CCR_PORT = prev.CCR_PORT;
    if (prev.CCR_TOKEN === undefined) delete process.env.CCR_TOKEN; else process.env.CCR_TOKEN = prev.CCR_TOKEN;
    if (prev.CCR_ORG_DIR === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prev.CCR_ORG_DIR;
    if (prev.CCR_DATA_DIR === undefined) delete process.env.CCR_DATA_DIR; else process.env.CCR_DATA_DIR = prev.CCR_DATA_DIR;
    if (prev.CCR_ARTIFACTS_DIR === undefined) delete process.env.CCR_ARTIFACTS_DIR; else process.env.CCR_ARTIFACTS_DIR = prev.CCR_ARTIFACTS_DIR;
    if (prev.CCR_STORAGE_READ_MODE === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prev.CCR_STORAGE_READ_MODE;
    void prev;
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((e: unknown) => { console.error("SUITE CRASH:", e); process.exit(1); });
