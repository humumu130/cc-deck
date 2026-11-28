// #273 AskUserQuestion 云回传——真 CLI 双端 e2e（验收件，手动跑，证据落 /tmp/w273-e2e/）
//
// 覆盖：转发（waiting 卡 questions 下发）+ 回写（COMMAND_ANSWER → deny-message 回写
// CLI stdin → CLI 续跑到 DONE）+ 超时放行（无人作答 → decision=timeout → CLI 不死锁
// 继续跑完 = kill 场景不再手动救）+ 迟到作答注入（timeout 后作答 → sendMessage 注入 ok）。
// 运行：CCR_RELAY_CHILD 无需（脚本侧 env 钉死）；证据 tail 打印 + 全帧落盘。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import type { Command, Envelope } from "../src/types.js";

// ---- 沙盒铁律（test-waiting-deadlock 同款 + 端口错开 + 短提问窗口）----
const EVID = "/tmp/w273-e2e";
mkdirSync(EVID, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "ccr-273e2e-"));
process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_PORT = "18974";
process.env.CCR_ASK_HOLD_MS = "20000"; // 短窗：phase1 秒答不受影响，phase2 20s 超时
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
// 隔离 hook 上报：CLI 子进程由 adapter 打 CCR_RELAY_CHILD，此处再钉一层防脚本自身误报
process.env.CCR_RELAY_CHILD = "1";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`FAIL - ${msg}`);
    appendFileSync(join(EVID, "result.log"), `FAIL - ${msg}\n`);
    return;
  }
  passed++;
  console.log(`ok - ${msg}`);
  appendFileSync(join(EVID, "result.log"), `ok - ${msg}\n`);
}

const PROMPT =
  "请立刻调用 AskUserQuestion 工具问我一个问题：header 用「午餐」，question 用「今天吃什么？」，选项 label 为 饺子 / 面条（各带一句 description）。拿到回答后只回复你选中的那个 label，不要做其他任何事。";

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);

const frames: Envelope[] = [];
bus.subscribe((e) => {
  frames.push(e);
  appendFileSync(join(EVID, "frames.jsonl"), JSON.stringify({ seq: e.seq, type: e.type, s: e.session_id?.slice(0, 8), payload: e.payload }) + "\n");
});

function cmd(c: Omit<Command, "command_id" | "ts">): Command {
  return { ...c, command_id: randomUUID(), ts: Date.now() } as Command;
}

function waitFrame(pred: (e: Envelope) => boolean, ms: number, label: string): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const hit = frames.find(pred);
    if (hit) return resolve(hit);
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = frames.find(pred);
      if (f) {
        clearInterval(iv);
        resolve(f);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`等待 ${label} 超时 ${ms}ms`));
      }
    }, 200);
  });
}

const lastText = (sid: string): string => {
  let txt = "";
  for (const e of frames) {
    if (e.session_id !== sid || e.type !== "SESSION_LOG") continue;
    const p = e.payload as { kind?: string; text?: string };
    if (p.kind === "assistant_text" && p.text) txt = p.text;
  }
  return txt;
};

const HOLD_MS = 20_000;

async function phase(answerIt: boolean, tag: string): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `ccr-273e2e-${tag}-`));
  const ack = mgr.handleCommand(
    cmd({ type: "COMMAND_CREATE", payload: { cwd, prompt: PROMPT, engine: "claude", model: "glm-5.3[1m]" } }),
    "e2e",
  );
  if (!ack.ok || !ack.session_id) throw new Error(`${tag} 建会话失败: ${ack.error}`);
  const sid = ack.session_id;

  // 转发域：waiting 卡到达且带 questions
  const w = await waitFrame(
    (e) => e.session_id === sid && e.type === "SESSION_WAITING" && Array.isArray((e.payload as { questions?: unknown }).questions) && ((e.payload as { questions: unknown[] }).questions.length > 0),
    180_000,
    `${tag} SESSION_WAITING(questions)`,
  );
  const wp = w.payload as { request_id: string; questions: { header: string; options: { label: string }[] }[] };
  assert(wp.questions[0]?.options?.some((o) => o.label === "饺子"), `${tag} 转发：waiting 卡 questions 选项完整下发`);

  if (answerIt) {
    const a = mgr.handleCommand(cmd({ type: "COMMAND_ANSWER", payload: { session_id: sid, request_id: wp.request_id, answers: ["饺子"] } }), "e2e");
    assert(a.ok, `${tag} 回写：COMMAND_ANSWER ack ok`);
    const r = await waitFrame(
      (e) => e.session_id === sid && e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { request_id: string }).request_id === wp.request_id,
      15_000,
      `${tag} RESOLVED`,
    );
    assert((r.payload as { decision: string }).decision === "answer", `${tag} 回写：决议 decision=answer`);
  }

  // CLI 续跑：回合终点（DONE/ERROR）出现（作答=终文本含「饺子」；超时=按默认跑完）
  await waitFrame((e) => e.session_id === sid && (e.type === "SESSION_DONE" || e.type === "SESSION_ERROR"), 240_000, `${tag} 回合终点`);
  const finalText = lastText(sid);
  if (answerIt) {
    assert(frames.some((e) => e.session_id === sid && e.type === "SESSION_DONE") && finalText.includes("饺子"), `${tag} 回写：CLI 收 deny-message 续跑至 DONE，终文本含「饺子」（实际: ${finalText.slice(0, 80)}）`);
  } else {
    // 超时域：窗口内无人作答 → timeout 放行 → CLI 继续跑完（kill 场景不再手动救）。
    // 断言一律扫描 frames（决议帧在 DONE 前早已在场，扫描无竞态）
    assert(
      frames.some((e) => e.session_id === sid && e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { request_id: string }).request_id === wp.request_id && (e.payload as { decision: string }).decision === "timeout"),
      `${tag} 超时：timeout 决议帧在场（decision=timeout）`,
    );
    assert(frames.some((e) => e.session_id === sid && e.type === "SESSION_DONE"), `${tag} 超时：无人作答 CLI 放行续跑至 DONE（无死锁、无需 kill）`);
    const late = mgr.handleCommand(cmd({ type: "COMMAND_ANSWER", payload: { session_id: sid, request_id: wp.request_id, answers: ["面条"] } }), "e2e");
    assert(late.ok, `${tag} 迟到作答：注入送达 ack ok（${late.error ?? ""}）`);
    await waitFrame((e) => e.session_id === sid && e.type === "SESSION_LOG" && String((e.payload as { text?: string }).text ?? "").includes("迟到作答已转注入"), 10_000, `${tag} 迟到注入日志`);
    assert(true, `${tag} 迟到作答：sendMessage 注入落帧（【AskUserQuestion 迟到作答】）`);
  }
}

try {
  await phase(true, "answer");
  await phase(false, "timeout");
  appendFileSync(join(EVID, "result.log"), `\n${passed} passed, ${failed} failed\n`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} catch (e) {
  console.error(`E2E_ABORT: ${e instanceof Error ? e.message : String(e)}`);
  appendFileSync(join(EVID, "result.log"), `E2E_ABORT: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
