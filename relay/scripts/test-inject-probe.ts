// #221（W-INJECT3 P0）：注入起跑探针测试——inject done 后 T 秒未起跑立即补发，
// 不依赖快照/下次 submit/看门狗 sweep（89s 空窗根因=三慢速面叠加，见 bridge.ts 探针注释）。
// 四态断言：①滞留未起跑→探针补发（绕 60s sweep 限速）②WORKING 不误发 ③晋升静默
// ④tries≥3 封顶共享（探针不越顶）。直调 scheduleInjectProbe（setTimeout 用真时钟短值，
// CCR_INJECT_PROBE_MS=150ms 快跑）。
//
// 直跑：cd relay && env -u CCR_ORG_DIR -u CCR_TOKEN CCR_INJECT_PROBE_MS=150 \
//   node --import tsx/esm scripts/test-inject-probe.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PROBE_MS = Number(process.env.CCR_INJECT_PROBE_MS ?? 150);
if (PROBE_MS > 500) { console.error("CCR_INJECT_PROBE_MS 需 ≤500ms 快跑"); process.exit(2); }

const bus = new EventBus();
const cfg: RelayConfig = {
  port: 18996, token: "t", tokenGenerated: false, defaultCwd: "", model: "m",
  bridgeToken: "bt", dataDir: mkdtempSync(join(tmpdir(), "ccr-injectprobe-")),
  cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
};
const mgr = new SessionManager(bus, cfg);
mgr.setAgentFactory((_c: string, _m: string, cb: AgentCallbacks): AgentLike => ({
  id: randomUUID(), startedAt: Date.now(), ended: false,
  sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
  stop: async () => {}, setPermissionMode: async () => {},
}));
const bridge = new Bridge(bus, mgr, { dataDir: cfg.dataDir } as never);
// 探针真发走 fireStuckEnter→injectEnter(pid)——pid 用不存在的进程号，注入必败但
// 「已尝试发回车」可从 tries 账本观测（fireStuckEnter 计账先行，注入失败走 onInjectFail）
process.env.CCR_INJECT_CMD = ""; // 不设真注入命令 → injectEnter 走默认路径对死 pid 失败（无害）

// 造外部会话（桥接域）+pending 滞留
function mkExt(id: string, status: string, pendingTexts: string[], pid = 999_001): void {
  bus.emit("*", "SESSION_CREATED", {}); // 噪音帧无碍
  (mgr as unknown as { sessions: Map<string, { state: Record<string, unknown>; logs: unknown[] }> }).sessions.set(id, {
    state: { session_id: id, status, cli_pid: pid, external: true, pending_inputs: pendingTexts.map((t) => ({ text: t, ts: Date.now() })) },
    logs: [],
  } as never);
}
const ledgerTries = (id: string, key: string): number => {
  const w = (bridge as unknown as { stuckWatch: Map<string, { tries: number; msgKey: string }> }).stuckWatch.get(id);
  return w && w.msgKey === key ? w.tries : -1;
};

async function main() {
  console.log("== #221 W-INJECT3: 注入起跑探针 ==");

  // ① 滞留未起跑（DONE+pending 在）→ 探针 T 秒后补发（tries 从 0→1）
  {
    const id = "probe-a-" + randomUUID().slice(0, 8);
    const text = "滞留消息A";
    mkExt(id, "DONE", [text]);
    const before = ledgerTries(id, text);
    (bridge as unknown as { scheduleInjectProbe(id: string, pid: number, text: string, sentAt: number): void }).scheduleInjectProbe(id, 999_001, text, Date.now());
    await sleep(PROBE_MS + 600); // 探针 150ms + 注入异步余量
    const after = ledgerTries(id, text);
    ok(after === (before < 0 ? 1 : before + 1), `① DONE+滞留 → 探针补发（tries ${before}→${after}，绕 60s sweep 限速）`);
  }

  // ② WORKING（输出中）→ 绝不补发（防打断输出）
  {
    const id = "probe-b-" + randomUUID().slice(0, 8);
    const text = "输出中会话的滞留消息B";
    mkExt(id, "WORKING", [text]);
    (bridge as unknown as { stuckWatch: Map<string, unknown> }).stuckWatch.delete(id);
    (bridge as unknown as { scheduleInjectProbe(id: string, pid: number, text: string, sentAt: number): void }).scheduleInjectProbe(id, 999_002, text, Date.now());
    await sleep(PROBE_MS + 400);
    const w = (bridge as unknown as { stuckWatch: Map<string, { tries?: number }> }).stuckWatch.get(id);
    ok(!w || !w.tries, "② WORKING → 探针静默（起跑判定双证之 status，不误发打断输出）");
  }

  // ③ 晋升（pending 已清）→ 静默
  {
    const id = "probe-c-" + randomUUID().slice(0, 8);
    mkExt(id, "DONE", []); // 无 pending=已晋升
    (bridge as unknown as { scheduleInjectProbe(id: string, pid: number, text: string, sentAt: number): void }).scheduleInjectProbe(id, 999_003, "已晋升消息C", Date.now());
    await sleep(PROBE_MS + 400);
    const w = (bridge as unknown as { stuckWatch: Map<string, { tries?: number }> }).stuckWatch.get(id);
    ok(!w || !w.tries, "③ 消息已晋升 → 探针静默（正常链路零扰动）");
  }

  // ④ tries≥3 封顶共享：预置满账 → 探针不再发
  {
    const id = "probe-d-" + randomUUID().slice(0, 8);
    const text = "封顶消息D";
    mkExt(id, "DONE", [text]);
    (bridge as unknown as { stuckWatch: Map<string, unknown> }).stuckWatch.set(id, { lastTry: Date.now(), tries: 3, skips: 0, given_up: true, msgKey: text });
    (bridge as unknown as { scheduleInjectProbe(id: string, pid: number, text: string, sentAt: number): void }).scheduleInjectProbe(id, 999_004, text, Date.now());
    await sleep(PROBE_MS + 400);
    const w = (bridge as unknown as { stuckWatch: Map<string, { tries: number }> }).stuckWatch.get(id);
    ok(w?.tries === 3, "④ tries=3 封顶 → 探针不越顶（fireStuckEnter 共享账本，防叠发）");
  }

  // ⑤ WAITING → 交看门狗（不误触权限弹窗）
  {
    const id = "probe-e-" + randomUUID().slice(0, 8);
    const text = "权限悬停消息E";
    mkExt(id, "WAITING", [text]);
    (bridge as unknown as { scheduleInjectProbe(id: string, pid: number, text: string, sentAt: number): void }).scheduleInjectProbe(id, 999_005, text, Date.now());
    await sleep(PROBE_MS + 400);
    const w = (bridge as unknown as { stuckWatch: Map<string, { tries?: number }> }).stuckWatch.get(id);
    ok(!w || !w.tries, "⑤ WAITING → 探针不发（回车会误触权限弹窗，交看门狗慢层）");
  }

  // ⑥ 探针挂点静态锚：inject done 后三链齐挂（armVerify/submitEnter/probe）
  {
    const src = (await import("node:fs")).readFileSync(join(import.meta.dirname, "..", "src", "bridge.ts"), "utf-8");
    ok(src.includes("this.scheduleInjectProbe(sessionId, state.cli_pid, text, sentAt); // #221"),
      "⑥ inject done 后挂探针（与 armVerify/submitEnter 同点三链）");
    ok(src.includes("CCR_INJECT_PROBE_MS"), "⑥b env 可调（CCR_INJECT_PROBE_MS，0=关）");
    ok(src.includes("probe: 注入后"), "⑥c 补发日志带原因与秒计时");
    ok(true, "⑥d WORKING/WAITING 双保护在 ②⑤ 已行为验证");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e) => { console.error("异常终止:", e); process.exit(1); });
