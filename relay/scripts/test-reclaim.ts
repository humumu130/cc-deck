// #276 P0 重启后活会话不恢复——断言套件。§R 真对象行为（SessionManager 沙盒 +
// Bridge 原型链直调 reclaimAliveAtBoot）+ §A 静态锚 + 回归口径。
// 覆盖（任务书口径断言 ≥3）：
//   R1 活进程重接管：boot 后 DONE+cli_pid 活 → 翻 WORKING + 转录管道补挂（「从未重接管」根修）
//   R2 死进程不误接：DONE+pid 死 → 原样不动（终态是真实收尾）
//   R3 转录兜底不掩盖断管：sid 无转录文件 → 状态照翻活（不依赖转录在场）但管道不误挂；
//      有转录 → transcriptPaths 命中真路径（5s 轮询接上，帧走轮询通道不靠 hook 单通道）
//   R4 idle_archived 刻意沉底不翻案（#50 口径）+ WORKING/无 pid 不进重接管
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:reclaim
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---- 沙盒（test-ws 铁律） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-reclaim-org/", "../data/test-reclaim-data/", "../data/test-reclaim-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-reclaim-org/");
process.env.CCR_DATA_DIR = SB("../data/test-reclaim-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-reclaim-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";
process.env.CCR_SESSIONS_ROOT = SB("../data/test-reclaim-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });

const DATA = process.env.CCR_DATA_DIR;
const ROOT = process.env.CCR_PROJECTS_ROOT as string;
const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
const mgr = new SessionManager(bus, cfg);
type State = { session_id: string; relay_session_id: string; external: boolean; status: string; cli_pid?: number; updated_at: number; historical?: boolean; idle_archived?: boolean; saved?: boolean };
const cards = (mgr as unknown as { sessions: Map<string, { state: State; logs: { kind: string; text: string }[] }> }).sessions;

// ---- pid 道具 ----
const livePid = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
livePid.unref();
let deadPid = 0;
for (let i = 0; i < 5 && !deadPid; i++) {
  const r = spawnSync("/bin/sleep", ["0"]);
  if (r.pid) { try { process.kill(r.pid, 0); } catch { deadPid = r.pid; } }
}
ok(deadPid > 0, "道具：确定性死 pid");

function seedExt(id: string, sid: string, o: { pid?: number; status?: string; idleArchived?: boolean } = {}): void {
  cards.set(id, {
    state: {
      session_id: id, relay_session_id: sid, external: true,
      status: o.status ?? "DONE", updated_at: Date.now() - 3600_000,
      ...(o.pid ? { cli_pid: o.pid } : {}), stats: {},
      ...(o.idleArchived ? { idle_archived: true } : {}),
    },
    logs: [],
  } as never);
}
// 转录文件：a-sid 有（管道补挂命中） / b-sid 无（状态翻活但管道不误挂）
mkdirSync(join(ROOT, "-tmp-proj-a"), { recursive: true });
writeFileSync(join(ROOT, "-tmp-proj-a", "a-sid.jsonl"), '{"x":1}\n');

// 假 Bridge 实例：原型链继承（findTranscriptForSid 经原型可达）+ 最小实例态
const fakeBridge: unknown = Object.create(Bridge.prototype);
Object.assign(fakeBridge as Record<string, unknown>, {
  mgr,
  transcriptPaths: new Map<string, string>(),
  ensureQueuePoll: (() => { (fakeBridge as { polls?: number }).polls = ((fakeBridge as { polls?: number }).polls ?? 0) + 1; }),
});
const reclaim = (fakeBridge as { reclaimAliveAtBoot(): void; transcriptPaths: Map<string, string> });

console.log("§R 活进程重接管：");
// R1 活 pid + 有转录 → 翻 WORKING + 管道补挂
seedExt("ext-a", "a-sid", { pid: livePid.pid });
reclaim.reclaimAliveAtBoot();
let st = cards.get("ext-a")!.state;
ok(st.status === "WORKING", "R1a DONE+活 pid：boot 重接管翻 WORKING（「从未重接管」根修——原路径只认 historical/ERROR）");
ok(reclaim.transcriptPaths.get("ext-a") === join(ROOT, "-tmp-proj-a", "a-sid.jsonl"), "R1b 转录管道补挂命中真路径（transcriptPaths 重启即丢，5s 轮询接上——帧不再依赖 hook 单通道）");
ok(cards.get("ext-a")!.logs.some((l) => l.text.includes("重新接管")), "R1c 接管留痕（时间线 system 行）");
// R2 死 pid 不动
seedExt("ext-b", "b-sid", { pid: deadPid });
reclaim.reclaimAliveAtBoot();
st = cards.get("ext-b")!.state;
ok(st.status === "DONE" && !reclaim.transcriptPaths.has("ext-b"), "R2 死 pid：不误接（终态=真实收尾，管道不挂）");
// R3 无转录文件的活 pid：状态照翻、管道不误挂（状态翻活不依赖转录在场）
seedExt("ext-c", "c-sid", { pid: livePid.pid });
reclaim.reclaimAliveAtBoot();
st = cards.get("ext-c")!.state;
ok(st.status === "WORKING" && !reclaim.transcriptPaths.has("ext-c"), "R3 sid 无转录：状态照翻活（不靠转录兜底掩盖）+ 管道不误挂空路径");
// R4 沉底/无 pid 不进
seedExt("ext-d", "d-sid", { pid: livePid.pid, idleArchived: true });
seedExt("ext-e", "e-sid", {});
seedExt("ext-f", "f-sid", { pid: livePid.pid, status: "WORKING" });
reclaim.reclaimAliveAtBoot();
ok(cards.get("ext-d")!.state.status === "DONE", "R4a idle_archived 刻意沉底：不翻案（#50 口径）");
ok(cards.get("ext-e")!.state.status === "DONE", "R4b 无 pid 定位：不误接（定位补救归 hook/回读链）");
ok(cards.get("ext-f")!.state.status === "WORKING", "R4c 已 WORKING：幂等不再动");
// R5 boot 一次性语义锚：60s heal tick 不含 reclaim（Stop 正常收尾不被翻回）
const bridgeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bridge.ts"), "utf-8");
ok(!/this\.healTimer = setInterval\(\(\) => \{[\s\S]{0,600}reclaimAliveAtBoot/.test(bridgeSrc), "R5 一次性语义：60s tick 不跑 reclaim（回合间 DONE+进程活=常态，常驻版会打穿 Stop 收尾）");
ok(bridgeSrc.includes("this.reclaimAliveAtBoot(); // #276 P0"), "R5b 构造段挂接在位（revive 之后、孤儿扫描之前）");
ok(bridgeSrc.includes("private findTranscriptForSid("), "R5c 转录 sid 定向查找辅助在位");

console.log(`§R-§A：${pass} ok / ${fail} FAIL`);
try { livePid.kill(); } catch {}
if (fail > 0) { console.error(`FAIL：共 ${fail} 条断言未过`); process.exit(1); }
console.log(`\n全部通过：#276 boot 活进程重接管（翻活+管道补挂 / 死进程不误接 / 沉底不翻案）`);
process.exit(fail > 0 ? 1 : 0);
