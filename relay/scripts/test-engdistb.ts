// W-ENGDIST-B（1110，100% 工程批二）断言档：三件契约锁。
//   A qwen resume：buildArgs 双形态（无锚基线/有锚 --resume）+caps resume:true+
//     失锚自愈（构造真会话灌 engineSessionId→模拟失败文案含 session→锚被清回落重注）
//   B trae usage：buildArgs 带 -t 轨迹路径+config-file 权威位+caps usage:true+
//     harvestTraeUsage 纯函数（fixture 轨迹→onUsage 聚合+onContext 水位/坏档/缺档零回调）
//   C codex effort：opts.effort 归一（别名/白名单外 throw）+buildArgs -c 注入+缺省不传+
//     profile 透传静态锚（session-manager 读 codex profile effort）
// 实测证据（真 CLI 探针，回执贴证）：qwen result 帧 session_id+--resume 失锚硬错；
// codex -c model_reasoning_effort 接受+reasoning_output_tokens 在场。本档=契约面锁。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CCR_STUB = process.env.CCR_STUB_MODE;
process.env.CCR_STUB_MODE = "1"; // 防 trae config 模板写真实 home（agent-trae 护栏）

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  const qwen = await import("../src/agent-qwen.js");
  const trae = await import("../src/agent-trae.js");
  const codex = await import("../src/agent-codex.js");

  // ---------- A qwen resume ----------
  console.log("A qwen 原生 resume：");
  {
    assert(qwen.QWEN_CODE_CAPABILITIES.resume === true, "A1 caps resume=true（0.27.1 help 实勘 -r/--resume）");
    assert(!qwen.QWEN_PENDING_SMOKE.some((x) => x.includes("resume")), "A2 冒烟欠账表 resume 项已清（已接线非待办）");
    // buildArgs 双形态：无锚=基线零新增参；有锚=--resume <sid> 在 prompt 前
    const mk = (cbOverrides = {}) => {
      const calls: unknown[][] = [];
      const cb = {
        onLog: () => {}, onStatusChange: () => {}, onTurnEnd: (ok: boolean, d: string) => calls.push([ok, d]),
        onUsage: () => {}, onSessionEnd: () => {}, onInit: () => {}, onContext: () => {},
        ...cbOverrides,
      } as never;
      return { session: new qwen.QwenCodeAgentSession({ cwd: "/tmp", model: "m", cb } as never), calls };
    };
    const s1 = mk().session as unknown as { buildArgs(p: string, r?: string): string[] };
    const base = s1.buildArgs("P");
    assert(base.includes("-p") && base.includes("P") && !base.includes("--resume"), "A3 无锚基线：-p+prompt 零 --resume（首回合形态）");
    const resumed = s1.buildArgs("P2", "sid-123");
    assert(resumed.includes("--resume") && resumed[resumed.indexOf("--resume") + 1] === "sid-123" && !resumed.includes("--resume-create-missing"), "A4 有锚：--resume <sid> 紧邻传值（qwen 无 create-missing——失锚自愈在 relay 侧）");
    // 失锚自愈：真会话灌锚→模拟失败文案（No saved session）→锚被清
    const logs: string[] = [];
    const { session: s2 } = mk({ onLog: (_k: string, t: string) => logs.push(t) } as never);
    const inner = s2 as unknown as { engineSessionId?: string };
    inner.engineSessionId = "sid-stale";
    const wrappedCb = (s2 as unknown as { opts: { cb: { onTurnEnd(ok: boolean, d: string): void } } }).opts.cb;
    wrappedCb.onTurnEnd(false, 'qwen: No saved session found with title "sid-stale".');
    assert(inner.engineSessionId === undefined, "A5 失锚自愈：失败文案含 session → 锚清空（下回合回落全文重注）");
    assert(logs.some((t) => t.includes("回落全文重注")), "A6 自愈留痕日志在（用户可察该轮上下文丢失）");
    // 非失锚失败不清锚
    const { session: s3 } = mk();
    const inner3 = s3 as unknown as { engineSessionId?: string };
    inner3.engineSessionId = "sid-live";
    (s3 as unknown as { opts: { cb: { onTurnEnd(ok: boolean, d: string): void } } }).opts.cb.onTurnEnd(false, "网络超时");
    assert(inner3.engineSessionId === "sid-live", "A7 非失锚失败不清锚（普通失败下回合照常 resume）");
  }

  // ---------- B trae usage ----------
  console.log("B trae usage 轨迹收割：");
  {
    assert(trae.TRAE_CAPABILITIES.usage === true, "B1 caps usage=true（上游轨迹文件计量——源码实勘 trajectory_recorder.py:103-117 四键全量）");
    const cbCalls: Record<string, unknown[]> = { usage: [], context: [] };
    const mkTrae = () => {
      const cb = {
        onLog: () => {}, onStatusChange: () => {}, onTurnEnd: (ok: boolean) => cbCalls.turnEnd = [ok],
        onUsage: (u: unknown) => cbCalls.usage.push(u), onContext: (n: number) => cbCalls.context.push(n),
        onSessionEnd: () => {}, onInit: () => {},
      } as never;
      return new trae.TraeAgentSession({ cwd: "/tmp", model: "m", cb } as never) as unknown as { buildArgs(p: string): string[]; trajPath: string };
    };
    const t = mkTrae();
    const args = t.buildArgs("T");
    assert(args.includes("run") && args.includes("--config-file"), "B2 run+config-file 权威位保持（W-ENGREST-FIX P1 不回归）");
    const ti = args.indexOf("-t");
    assert(ti >= 0 && args[ti + 1] === t.trajPath && t.trajPath.includes("trae-traj-"), "B3 -t 轨迹路径在（tmpdir 会话级——不污染项目目录+收口可读）");
    // harvest 纯函数：fixture 轨迹（两 interaction 聚合）
    const root = mkdtempSync(join(tmpdir(), "engdistb-"));
    try {
      const traj = join(root, "traj.json");
      writeFileSync(traj, JSON.stringify({ task: "x", interactions: [
        { response: { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } },
        { response: { usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 15, cache_creation_input_tokens: 10 } } },
        { response: {} }, // 无 usage 步跳过
      ] }), "utf-8");
      const h = trae.harvestTraeUsage(traj, { onUsage: (u: unknown) => cbCalls.usage.push(u), onContext: (n: number) => cbCalls.context.push(n) } as never);
      const u = cbCalls.usage.at(-1) as { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
      assert(h?.input === 300 && u.input_tokens === 300 && u.output_tokens === 30 && u.cache_read_input_tokens === 20 && u.cache_creation_input_tokens === 10, "B4 聚合本回合全 interactions（input 300/output 30/cache 20+10——session-manager 累计语义同源）");
      assert(cbCalls.context.at(-1) === 200 + 20 + 10, "B5 onContext=末次调用窗口占用（200+cache20+10=水位口径）");
      assert(trae.harvestTraeUsage(join(root, "absent.json"), { onUsage: () => {} } as never) === null, "B6 缺档零回调（尽力而为不炸）");
      const bad = join(root, "bad.json");
      writeFileSync(bad, "{not json", "utf-8");
      assert(trae.harvestTraeUsage(bad, { onUsage: () => {} } as never) === null, "B7 坏档零回调");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // ---------- C codex effort ----------
  console.log("C codex effort 透传：");
  {
    const mkCodex = (effort?: string) => {
      const cb = { onLog: () => {}, onStatusChange: () => {}, onTurnEnd: () => {}, onUsage: () => {}, onSessionEnd: () => {}, onInit: () => {} } as never;
      return new codex.CodexAgentSession("/tmp", "m", cb, undefined, { effort }) as unknown as { effort?: string };
    };
    assert(mkCodex("high").effort === "high", "C1 直传六档值归一恒等");
    assert(mkCodex("快速").effort === "low" && mkCodex("均衡").effort === "high" && mkCodex("极致").effort === "xhigh", "C2 中文别名归一（快速low/均衡high/极致xhigh——codebuddy 同源词表）");
    let threw = "";
    try { mkCodex("turbo"); } catch (e) { threw = String((e as Error).message); }
    assert(threw.includes("未知 effort") && threw.includes("turbo"), "C3 白名单外 fail-fast throw（错配置响亮暴露非静默跑偏）");
    assert(mkCodex().effort === undefined, "C4 缺省 undefined（~/.codex/config.toml 用户级值生效零变化）");
    // buildArgs 注入静态锚（execTurn 私有——源码锚定）
    const src = readFileSync(new URL("../src/agent-codex.ts", import.meta.url), "utf-8");
    assert(src.includes('args.push("-c", `model_reasoning_effort=${this.effort}`)'), "C5 execTurn 注入 -c model_reasoning_effort（threadId resume 之后图参之前）");
    const smSrc = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
    assert(smSrc.includes('profiles.find((e) => e.engine === "codex")') && smSrc.includes("codexEffort"), "C6 engine profile effort 透传在（codex profile 读+spawn 传入——codebuddy 同源读法）");
  }

  if (!CCR_STUB) delete process.env.CCR_STUB_MODE; else process.env.CCR_STUB_MODE = CCR_STUB;
  console.log(`\n== test-engdistb：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}
void main();
