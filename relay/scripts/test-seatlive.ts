// W-SEATALIVE 测试件：值守座位回合感知存活（1106 断档第四现治本，用户实锤 3h 断档）
//   A 刀1 三层判活：pid 活→守位 / pid 死+回合 TTL 内→between-turns 守位（喂活照投）
//     / pid 死+TTL 外→真死清档+审计；刀2 候选补全（pid 死+活跃窗内候选保留）
//   B 刀2 pid 补水：override 旧 pid→setExternalCliPid 新 pid→override 回写+审计
//   C 刀3 续任免卡：同 sid 24h 内 claim→renewed 直接落位零卡；换 sid→出卡
//   D 刀4 no_pm_target 连击≥2→streak 告警卡（notifications 断言）
// fake timer≈真 timer 短窗（CCR_SEAT_TURN_GAP_MIN=0.02≈1.2s——够断言窗内/窗外两态）。
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { setPmOverride, readPmOverride, recordPmLastApproved, readPmLastApproved } from "../src/org.js";
import { listPendingConfirms } from "../src/projects.js";
import { writeCollabMode } from "../src/settings.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const dirs: string[] = [];
function mkEnv(extra: Record<string, string> = {}) {
  const ORG = mkdtempSync(join(tmpdir(), "seatlive-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "seatlive-data-"));
  dirs.push(ORG, DATA);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE, CCR_CONFIG_FILE: process.env.CCR_CONFIG_FILE, CCR_SEAT_TURN_GAP_MIN: process.env.CCR_SEAT_TURN_GAP_MIN, CCR_PM_DUTY: process.env.CCR_PM_DUTY, CCR_NO_LEADER: process.env.CCR_NO_LEADER, CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN, ...Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]])) };
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_PM_DUTY = "1"; process.env.CCR_NO_TITLE_GEN = "1"; // CCR_NO_LEADER 不设——dutyEnabled 门取 !=="1"（no-leader 走 writeCollabMode 文件面，env 设 1 反而关值守链）
  const cfgDir = mkdtempSync(join(tmpdir(), "seatlive-cfg-")); dirs.push(cfgDir);
  process.env.CCR_CONFIG_FILE = join(cfgDir, "config.json");
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  const cfg: RelayConfig = { port: 8930 + Math.floor(Math.random() * 40), token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
  writeCollabMode(DATA, "no-leader"); // env CCR_NO_LEADER 不被 readCollabMode 认（pmseat 先例：设置文件面）
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(() => ({ id: randomUUID(), startedAt: Date.now(), ended: true, sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} }));
  try { mgr.ensureLeader(); } catch { /* leader 非必须 */ }
  return { ORG, DATA, mgr, bus, cleanup: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}
const auditOf = (DATA: string) => { try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } };
const notifOf = (DATA: string) => { try { return readFileSync(join(DATA, "notifications.json"), "utf-8"); } catch { return ""; } };

async function main() {
  try {
    process.env.CCR_SEAT_TURN_GAP_MIN = "0.02"; // ≈1.2s 回合间隙窗（窗外态用 sleep 跨窗）
    console.log("A 刀1 三层判活（pid 活/TTL 内守位/TTL 外真死）:");
    {
      const f = mkEnv();
      const sid = "ext-seatlive-pm";
      // 回合活跃帧：EventBus emit 一条该 sid 的 SESSION_UPDATED（lastFrameAtFromEvents 数据源）
      f.bus.emit(sid, "SESSION_UPDATED", { status: "WORKING", action_summary: "回合收尾" });
      // ① pid 活（本进程）→ alive 守位
      f.mgr.ensureExternal(sid, "/Users/xdd/dev/pm", "值守 PM", "sdk-seatlive");
      f.mgr.setExternalCliPid(sid, process.pid);
      setPmOverride({ session_id: sid, cli_pid: process.pid, cwd: "/Users/xdd/dev/pm", claimed_at: Date.now() });
      const t1 = (f.mgr as unknown as { dutyTargetId(): string | null }).dutyTargetId();
      ok(t1 === sid, `A1 pid 活→守位（${t1?.slice(0, 12)}）`);
      // ② pid 死 + TTL 内（帧刚发）→ between-turns 守位（回合间隙不清档）
      const dp = spawn("sleep", ["0.03"]); const deadPid = dp.pid ?? 1;
      await sleep(120); // 等 sleep 退出
      f.bus.emit(sid, "SESSION_UPDATED", { status: "IDLE", action_summary: "回合结束" }); // 回合尾帧刷新活跃时刻
      setPmOverride({ session_id: sid, cli_pid: deadPid, cwd: "/Users/xdd/dev/pm", claimed_at: Date.now() });
      const t2 = (f.mgr as unknown as { dutyTargetId(): string | null }).dutyTargetId();
      ok(t2 === sid, `A2 pid 死+回合 TTL 内→between-turns 守位（${t2?.slice(0, 12)}——1106 断档形态不再清位）`);
      // ③ TTL 外（跨 1.2s 窗）→ 真死清档+审计
      await sleep(1400);
      const t3 = (f.mgr as unknown as { dutyTargetId(): string | null }).dutyTargetId();
      ok(t3 === null, `A3 pid 死+TTL 外→真死清档（${t3}）`);
      ok(auditOf(f.DATA).includes("pm-override-turn-gap-expired"), "A3b turn-gap-expired 审计在");
      // ④ 刀2 候选补全：pid 死+活跃窗内→候选保留（不静默跳）——会话 pid 也要设死
      //（A1 setExternalCliPid 设的是本进程=活，candidate 走活分支不进死分支）
      const dp2 = spawn("sleep", ["0.03"]); const deadPid2 = dp2.pid ?? 1;
      await sleep(120);
      f.mgr.setExternalCliPid(sid, deadPid2);
      f.bus.emit(sid, "SESSION_UPDATED", { status: "WORKING", action_summary: "下回合拉起" });
      const cand = (f.mgr as unknown as { dutyCandidateId(): string | null }).dutyCandidateId();
      ok(cand === sid, `A4 刀2 候选补全：pid 死+活跃窗内→候选保留（${cand?.slice(0, 12)}——拉起边补水可达）`);
      ok(auditOf(f.DATA).includes("pm-override-pid-stale-candidate"), "A4b pid_stale 候选审计在（可观测不静默）");
      f.cleanup();
    }

    console.log("B 刀2 pid 补水（回合拉起注册边回写 override）:");
    {
      const f = mkEnv();
      const sid = "ext-seatlive-re";
      f.mgr.ensureExternal(sid, "/Users/xdd/dev/pm2", "值守 PM2", "sdk-seatlive2");
      const dp = spawn("sleep", ["0.03"]); const oldPid = dp.pid ?? 1;
      await sleep(120);
      setPmOverride({ session_id: sid, cli_pid: oldPid, cwd: "", claimed_at: Date.now() });
      f.mgr.setExternalCliPid(sid, process.pid); // 回合拉起：新 pid 注册
      const ov = readPmOverride();
      ok(ov?.cli_pid === process.pid, `B1 override pid 回写（${oldPid}→${ov?.cli_pid===process.pid?"本进程":"未回写"}——拉起即归位）`);
      ok(auditOf(f.DATA).includes("pm-override-pid-replenished"), "B1b replenished 审计在");
      const t = (f.mgr as unknown as { dutyTargetId(): string | null }).dutyTargetId();
      ok(t === sid, "B2 补水后判活即活（stale/dead 判据自愈）");
      f.cleanup();
    }

    console.log("C 刀3 续任免卡（同 sid 24h 内 claim 免卡）:");
    {
      const f = mkEnv();
      const sid = "ext-seatlive-renew";
      f.mgr.ensureExternal(sid, "/Users/xdd/dev/pm3", "值守 PM3", "sdk-seatlive3");
      f.mgr.setExternalCliPid(sid, process.pid);
      // 无批准记录 → claim 出卡（基线）
      const r1 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/pm3", pid: process.pid }) as { ok: boolean; data?: { needsConfirm?: boolean } };
      ok(r1.data?.needsConfirm === true, "C1 首次 claim 出确认卡（基线）");
      // 批准记录（模拟上次 ✓ 落位后被清位）+同 sid 再 claim → renewed 免卡
      for (const c of listPendingConfirms().filter((x) => x.kind === "pm-appoint")) (f.mgr as unknown as { orgAction: Function }).orgAction("confirm-decide", { confirm_id: c.id, approve: false, by: "u" });
      recordPmLastApproved({ session_id: sid, at: Date.now() - 3600_000 }); // 1h 前批准
      const r2 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/pm3", pid: process.pid }) as { ok: boolean; data?: { renewed?: boolean } };
      ok(r2.ok === true && r2.data?.renewed === true, `C2 同 sid 1h 内 claim→renewed 免卡直落（${JSON.stringify(r2.data ?? {}).slice(0, 60)}）`);
      ok(readPmOverride()?.session_id === sid, "C2b override 已落位（喂活即刻恢复）");
      ok(auditOf(f.DATA).includes("pm-claim-renewed"), "C2c renewed 审计在");
      ok(!listPendingConfirms().some((x) => x.kind === "pm-appoint" && x.status === "pending"), "C3 零在决任命卡（当日第三卡摩擦形态绝迹）");
      // 换 sid → 重新出卡（先腾位：C2 落的 override 活占会走互斥闸拒绝而非出卡）
      (f.mgr as unknown as { orgAction: Function }).orgAction("pm-release", {});
      const sid2 = "ext-seatlive-other";
      f.mgr.ensureExternal(sid2, "/Users/xdd/dev/other", "另一会话", "sdk-other");
      // pid 用不同值（生产每 CLI 进程 pid 唯一）——件5 伴生修复后 pid 匹配优先于
      // cwd，夹具共用 process.pid 会命中先注册的原会话走 renewed，测不到换 sid
      f.mgr.setExternalCliPid(sid2, process.pid + 1);
      const r3 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/other", pid: process.pid + 1 }) as { ok: boolean; data?: { needsConfirm?: boolean } };
      ok(r3.data?.needsConfirm === true, "C4 换 sid→重新出卡（授权不跨会话）");
      f.cleanup();
    }

    // ---------- E 组（W-P2BATCH4 件4-F2/件5）：批准边真链+任命并卡 ----------
    console.log("E 批准边+任命并卡（P2BATCH4）:");
    {
      // E1（F2）：真实批准链——claim 出卡→confirm-decide approve:true→readPmLastApproved 落点
      const f = mkEnv();
      const sid = "ext-p2b4-approve";
      f.mgr.ensureExternal(sid, "/Users/xdd/dev/p2b4a", "批准边 PM", "sdk-p2b4a");
      f.mgr.setExternalCliPid(sid, process.pid);
      const r1 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/p2b4a", pid: process.pid }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string } } };
      ok(r1.data?.needsConfirm === true && !!r1.data?.confirm?.id, "E1前置 claim 出卡（真实批准链入口）");
      if (r1.data?.confirm?.id) {
        const r2 = (f.mgr as unknown as { orgAction: Function }).orgAction("confirm-decide", { confirm_id: r1.data.confirm.id, approve: true, by: "u" }) as { ok: boolean };
        ok(r2.ok === true, "E1a confirm-decide approve:true ok");
        const la = readPmLastApproved(f.ORG);
        ok(la?.session_id === sid, "E1b 批准边真链：readPmLastApproved().session_id===sid（:8647 recordPmLastApproved 误删即红——原 C2 手灌绕过）");
        ok(readPmOverride()?.session_id === sid, "E1c override 落位（批准即就位）");
      }
      // E2（件5）：已是现任（提名/认领刚批准落位）→同 sid 再 claim→零二卡幂等。
      // pid 传 number（与生产 org CLI json.dumps({"pid": os.getppid()}) 同型）——
      // 逼出 str() 只认 string 的定位死代码（件5 伴生修复），测试留 number 防回退。
      const before = listPendingConfirms().filter((x) => x.kind === "pm-appoint" && x.status === "pending").length;
      const r3 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/p2b4a", pid: process.pid }) as { ok: boolean; error?: string; data?: { incumbent?: boolean; renewed?: boolean; already?: boolean; needsConfirm?: boolean } };
      ok(r3.ok === true && r3.data?.needsConfirm !== true, "E2a 现任同 sid claim→幂等零二卡（形态: " + (r3.data?.already === true ? "already" : r3.data?.incumbent === true ? "incumbent" : r3.data?.renewed === true ? "renewed" : (r3.error ?? JSON.stringify(r3.data ?? {})).slice(0, 50)) + "——1106 双卡摩擦根除）");
      const after = listPendingConfirms().filter((x) => x.kind === "pm-appoint" && x.status === "pending").length;
      ok(after === before, "E2b 零新任命卡（pending 计数不变——两次拍板一个意图绝迹）");
      // E3（件5 守卫）：换 sid claim 仍出卡（授权不跨会话）。pid 用不同值——生产每
      // CLI 进程 pid 唯一，夹具共用 process.pid 会被 pid 精确匹配先命中 E1 会话
      //（件5 伴生修复后 pid 优先于 cwd，夹具须对齐生产的 pid 唯一性）
      (f.mgr as unknown as { orgAction: Function }).orgAction("pm-release", {});
      const sid2 = "ext-p2b4-other";
      f.mgr.ensureExternal(sid2, "/Users/xdd/dev/p2b4b", "另一会话", "sdk-p2b4b");
      f.mgr.setExternalCliPid(sid2, process.pid + 1);
      const r4 = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/p2b4b", pid: process.pid + 1 }) as { ok: boolean; error?: string; data?: { needsConfirm?: boolean } };
      ok(r4.data?.needsConfirm === true || (r4.error ?? "").includes("已有"), "E3 换 sid claim 仍出卡或互斥闸拒（守卫语义——实: " + ((r4.error ?? "") .slice(0, 40) || JSON.stringify(r4.data ?? {}).slice(0, 40)) + "）");
      f.cleanup();
    }

    // ---------- F 组（W-P2BATCH4 件4-F1 组合）：between-turns 席位+feedPM→extInput ----------
    // 三层判活（A 组）与外部喂活通道（#105）各自的单测都在，但「回合间隙席位 + 喂活
    // 真投外部终端」的组合链无断言——1106 断档第四现正是这条链（席位守住了，喂活
    // 有没有真到 PM 终端没人证）。F 组补组合：死 pid+回合 TTL 内守位 → feedPM →
    // bridge.extInput 真收到含候选的 prompt。
    console.log("F between-turns 席位+feedPM→extInput（P2BATCH4 组合链）:");
    {
      const f = mkEnv();
      const sid = "ext-p2b4-f1";
      const dp = spawn("sleep", ["0.03"]); const deadPid = dp.pid ?? 1;
      await sleep(120); // 等 sleep 退出（pid 真死——between-turns 判定前提）
      f.mgr.ensureExternal(sid, "/Users/xdd/dev/p2b4f1", "组合 PM", "sdk-f1");
      f.mgr.setExternalCliPid(sid, deadPid);
      // 首发边（ensureExternal/setExternalCliPid）席位空会机会主义提名出 pm-appoint
      // 卡——卡在决=值守全线 blocked。先 reject 决卡（进否决档防再提名），本组测的
      // 是「已任命席位的回合间隙喂活」，任命走手落 override（C 组先例）
      for (const c of listPendingConfirms().filter((x) => x.kind === "pm-appoint" && x.status === "pending")) {
        (f.mgr as unknown as { orgAction: Function }).orgAction("confirm-decide", { confirm_id: c.id, approve: false, by: "u" });
      }
      // ensureExternal 缺省 WORKING 会被「PM WORKING 合并语义」无声拦（:6474——回合
      // 在跑不追加值守回合）；between-turns 形态=回合已收口，翻 IDLE 对齐真实态
      (f.mgr as unknown as { sessions: Map<string, { state: { status: string } }> }).sessions.get(sid)!.state.status = "IDLE";
      f.bus.emit(sid, "SESSION_UPDATED", { status: "IDLE", action_summary: "回合结束" }); // 回合尾帧（TTL 窗内）
      setPmOverride({ session_id: sid, cli_pid: deadPid, cwd: "/Users/xdd/dev/p2b4f1", claimed_at: Date.now() });
      // bridge stub：extInput 真链终点（#105 终端按键注入）
      const calls: Array<{ sid: string; text: string }> = [];
      f.mgr.setBridge({
        resolvePending: () => true, answerPending: () => null,
        extInput: (s: string, text: string) => { calls.push({ sid: s, text }); return { ok: true }; },
        extStop: () => ({ ok: true }), refreshTodos: () => ({ ok: true }), hideTodo: () => ({ ok: true }), forget: () => {},
      } as never);
      // actionable 候选：pending 验收回执（dutybackoff B3 同款 40h 未提交形态）
      const accDir = join(f.DATA, "acceptances"); mkdirSync(accDir, { recursive: true });
      writeFileSync(join(accDir, "f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6.json"), JSON.stringify({ id: "f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6", submitted: false, updated_at: Date.now() - 40 * 3600_000, rows: [{ label: "回归", result: "", note: "" }] }), "utf-8");
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("turn_end");
      await sleep(150); // 喂活链异步收口（轮账落盘）
      const rounds = (() => { try { return readFileSync(join(f.DATA, "duty-rounds.ndjson"), "utf-8"); } catch { return ""; } })();
      ok(rounds.includes('"result":"continue"'), `F1 between-turns 席位喂活 continue（轮账含 continue——回合间隙席位照投不死等 pid）`);
      ok(calls.length >= 1 && calls[0]!.sid === sid, `F1b 喂活经 bridge.extInput 真达外部 PM（calls=${calls.length} sid=${calls[0]?.sid ?? "无"}——#105 外部通道组合链）`);
      ok((calls[0]?.text ?? "").includes("验收") || (calls[0]?.text ?? "").length > 40, `F1c prompt 携带候选内容（${(calls[0]?.text ?? "").slice(0, 40).replace(/\n/g, " ")}…）`);
      f.cleanup();
    }

    console.log("D 刀4 no_pm_target 连击告警:");
    {
      const f = mkEnv();
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("worker_done");
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("turn_end");
      ok(notifOf(f.DATA).includes("pm-no-target-streak"), "D1 连击 2 轮→streak 告警卡在（notifications 落盘）");
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("worker_done");
      ok(auditOf(f.DATA).includes("连击 3 轮"), "D2 第三轮计数更新（审计连击 3 轮——通知面同 key upsert 幂等不重弹，计数走审计流）");
      ok(auditOf(f.DATA).includes("pm-no-target-streak"), "D3 streak 审计在");
      f.cleanup();
    }

    console.log("E 静态锁:");
    {
      const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
      ok(sm.includes("between-turns") && sm.includes("CCR_SEAT_TURN_GAP_MIN"), "E1 三层判活+TTL env 在");
      ok(sm.includes("pm-override-pid-replenished") && sm.includes("CCR_SEAT_RENEW_TTL_H"), "E2 补水+续任 TTL 在");
      const ty = readFileSync(new URL("../src/types.ts", import.meta.url), "utf-8");
      ok(["pm-override-turn-gap-expired", "pm-override-pid-replenished", "pm-claim-renewed", "pm-no-target-streak", "pm-override-pid-stale-candidate"].every((k) => ty.includes(`"${k}"`)), "E3 词表五词在");
    }

    console.log(`\nseatlive: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
    process.exit(fail ? 1 : 0);
  } finally {
    delete process.env.CCR_SEAT_TURN_GAP_MIN;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
void main();
