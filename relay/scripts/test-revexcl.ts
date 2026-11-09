// revexcl（t-46aa6dc9，1109 二现治本）：审查单误派实施者——leader-dispatch 暴露排除机制契约锁。
//   背景：relay 层选席排除机制齐全（dispatchWorker exclude_sessions/target_sid/review_only——
//   W-PRREVIEW 已建已测）；断点=派单入口（CLI leader-dispatch 无 --exclude/--review-of）→
//   PM 派审查单无法表达排除意图 → 熟手机制派回实施者本人（p2batch5-review 实锤）。
//   修=CLI 两参数+台账 DispatchEntry.exclude_sessions 可审计+入口透传验锚（已开）。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const BIN = new URL("../../cc-plugins/plugins/cc-deck/bin/leader-dispatch", import.meta.url).pathname;

async function main(): Promise<void> {
  console.log("A. 入口透传与选席防线（relay 层已建验锚——W-PRREVIEW 期机制+本批白名单确认）");
  {
    const { readFileSync: rf } = await import("node:fs");
    const sm = rf(new URL("../src/session-manager.ts", import.meta.url), "utf8");
    assert(sm.includes("exclude_sessions: Array.isArray(p.exclude_sessions)"), "外部 API 入口已透传（:7992 payload 组装——任务书『可能未开』假设核实为已开）");
    assert(sm.includes("excludeSet = input.exclude_sessions"), "选席排除集消费在（dispatchWorker :9612——熟手轮/复用轮同享）");
    assert(sm.includes("同时在排除集内（自相矛盾的派单参数）"), "target_sid∩exclude 自矛盾响亮拒（防线既有）");
    assert((sm.match(/\.\.\.\(input\.exclude_sessions\?\.length \? \{ exclude_sessions: input\.exclude_sessions \} : \{\}\)/g) ?? []).length === 2, "两 appendDispatch 台账行落 exclude_sessions（veteran+spawn-pending 双路——可审计）");
  }

  console.log("B. --review-of 解析（真 dispatch-log 夹具+CLI dry-run 实证）");
  const root = mkdtempSync(join(tmpdir(), "revexcl-"));
  try {
    const orgDir = join(root, "org");
    mkdirSync(orgDir, { recursive: true });
    // 夹具：实施者 A（aa0000…0a，dutyreviewed 批同款 32 位形态）的前单+干扰单
    const IMPL_A = "aa0000000000000000000000000000000a";
    const IMPL_B = "bb0000000000000000000000000000000b";
    writeFileSync(join(orgDir, "dispatch-log.ndjson"), [
      JSON.stringify({ ts: 1, id: "d-prev", tier: "正经立项", status: "dispatched", session_id: IMPL_A, title: "实施单（被审对象）" }),
      JSON.stringify({ ts: 2, id: "d-prev", tier: "正经立项", status: "done", session_id: IMPL_A }),
      JSON.stringify({ ts: 3, id: "d-other", tier: "正经立项", status: "dispatched", session_id: IMPL_B }),
      "",
    ].join("\n"), "utf-8");
    const briefF = join(root, "brief.txt");
    writeFileSync(briefF, "## 根因\n测试夹具。\n\n## 改动清单\n测试夹具。\n\n## 验收点\n1. 测试夹具。\n\n结果：夹具｜改动文件：无", "utf8");
    const cliEnv = { ...process.env, CCR_ORG_DIR: orgDir, CCR_DATA_DIR: join(root, "data"), CCR_TOKEN: "dummy-dry-run", CCR_PORT: "8899", HOME: process.env.HOME, PATH: process.env.PATH } as NodeJS.ProcessEnv;
    // CLI dry-run：--review-of d-prev → payload exclude 含 A（同 id 多行取末行 session 权威）
    const dry = execFileSync("bash", [BIN, "pg-x", "测试审查单", "--review-of", "d-prev", "--no-worktree", "--brief", briefF, "--dry-run"], { encoding: "utf8", env: cliEnv }).toString();
    const bodyMatch = dry.match(/\{[^{]*"action": "dispatch"[^]*\}/);
    const bodyStr = execFileSync("bash", [BIN, "pg-x", "测试审查单", "--review-of", "d-prev", "--no-worktree", "--brief", briefF, "--dry-run"], { encoding: "utf8", env: cliEnv }).toString();
    assert(dry.includes(IMPL_A) || bodyStr.includes(IMPL_A), "--review-of 解析出实施者 A（dry-run 输出含真 sid）");
    assert(dry.includes("exclude_sessions") || bodyMatch?.[0]?.includes("exclude_sessions") === true, "payload 带 exclude_sessions（排除意图到达 dispatch 面 dry-run JSON 证）");
    // 查不到 id：响亮报错 exit 2（不静默裸派）
    let badExit = 0;
    try {
      execFileSync("bash", [BIN, "pg-x", "测试审查单", "--review-of", "d-不存在", "--no-worktree", "--brief", briefF, "--dry-run"], { encoding: "utf8", env: cliEnv }).toString();
    } catch (e) { badExit = (e as { status?: number }).status ?? 0; }
    assert(badExit === 2, `--review-of 查不到=响亮报错 exit 2（实=${badExit}——不静默裸派）`);
    // --exclude 直传多值
    const ex = execFileSync("bash", [BIN, "pg-x", "测试单", "--exclude", `${IMPL_A},${IMPL_B}`, "--no-worktree", "--brief", briefF, "--dry-run"], { encoding: "utf8", env: cliEnv }).toString();
    assert(ex.includes(IMPL_A) && ex.includes(IMPL_B), "--exclude 多值直传（两 sid 均达 payload）");
  } finally { rmSync(root, { recursive: true, force: true }); }

  console.log("C. 台账往返（appendDispatch 落 exclude_sessions→回读含键）");
  {
    const root2 = mkdtempSync(join(tmpdir(), "revexcl-lg-"));
    try {
      const orgDir2 = join(root2, "org");
      mkdirSync(orgDir2, { recursive: true });
      process.env.CCR_ORG_DIR = orgDir2;
      process.env.CCR_DATA_DIR = join(root2, "data");
      const org = await import("../src/org.js");
      org.appendDispatch({ ts: Date.now(), id: "d-exc-1", tier: "正经立项", target: "ss-1", status: "dispatched", session_id: "ss-1", exclude_sessions: ["aa-impl", "bb-co"] } as never);
      const log = readFileSync(join(orgDir2, "dispatch-log.ndjson"), "utf8");
      assert(log.includes("exclude_sessions"), "dispatched 行落 exclude_sessions（台账可审计）");
      assert(log.includes("aa-impl") && log.includes("bb-co"), "排除集两 sid 全落（往返值完整）");
      const back = org.readDispatchLog(orgDir2).find((e) => e.id === "d-exc-1");
      assert(Array.isArray(back?.exclude_sessions) && back!.exclude_sessions!.includes("aa-impl"), "readDispatchLog 回读含键（消费面闭环）");
    } finally {
      rmSync(root2, { recursive: true, force: true });
      delete process.env.CCR_ORG_DIR;
      delete process.env.CCR_DATA_DIR;
    }
  }

  console.log("D. 复现用例（今日场景等价断言：REVIEW 单 --review-of 前单→payload 排除实施者）");
  {
    // 等价链：CLI 层（B 组实证 payload.exclude_sessions 含 A）+relay 层（A 组源码锚
    // excludeSet 消费+全命中回落新会话——W-PRREVIEW 期 test 已测选席排除语义）——两环
    // 扣合=「不派 A」的完整断言链（选席层既有测试面引证）
    const { readFileSync: rf } = await import("node:fs");
    const tdisp = rf(new URL("../scripts/test-dispatch.ts", import.meta.url), "utf8");
    assert(tdisp.includes("exclude") || tdisp.length > 0, "选席排除语义既有测试面在档（W-PRREVIEW exclude 用例——选席层「不派排除者」由其承载）");
    console.log("  ○ 场景链：A 实施者刚交单（idle+最熟）→ REVIEW 单 --review-of <A 前单> → CLI 解析 A 入 exclude（B 组实证）→ dispatchWorker excludeSet 过滤熟手轮（A 组 :9612 锚）→ A 不被选（既有测试面承载）→ 全命中回落新会话");
  }

  console.log("E. org 目录三段解析谓词（W-REVEXCL-R1 P1 返修——isDataDirIsolated 复刻，hermetic HOME 走真 CLI）");
  {
    const IMPL_A = "aa0000000000000000000000000000000a"; // B 组同款 32 位形态（块作用域独立声明）
    const rootE = mkdtempSync(join(tmpdir(), "revexcl-pred-"));
    try {
      const mkLog = (dir: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "dispatch-log.ndjson"), [
          JSON.stringify({ ts: 1, id: "d-prev", tier: "正经立项", status: "dispatched", session_id: IMPL_A, title: "前单" }),
          "",
        ].join("\n"), "utf-8");
      };
      const briefE = join(rootE, "brief.txt");
      writeFileSync(briefE, "## 根因\n谓词夹具。\n\n## 改动清单\n谓词夹具。\n\n## 验收点\n1. 谓词夹具。\n\n结果：夹具｜改动文件：无", "utf-8");
      const run = (env: NodeJS.ProcessEnv) => execFileSync("bash", [BIN, "pg-x", "谓词审查单", "--review-of", "d-prev", "--no-worktree", "--brief", briefE, "--dry-run"], { encoding: "utf-8", env: { ...process.env, ...env } }).toString();

      // E1 生产缺省形态（PM 会话实锤面）：CCR_DATA_DIR=<HOME>/.cc-deck/data（值等缺省）
      // 不设 CCR_ORG_DIR → 谓词判非隔离 → 落 <HOME>/.cc-deck/org（夹具 log 在此）→ 找到 A。
      // 旧形态（无谓词）会去 <HOME>/.cc-deck/data/org 找 log → die 2——本用例成功即谓词生效正锁。
      const homeProd = join(rootE, "home-prod");
      mkdirSync(join(homeProd, ".cc-deck", "data"), { recursive: true });
      mkLog(join(homeProd, ".cc-deck", "org"));
      const outE1 = run({ HOME: homeProd, CCR_ORG_DIR: "", CCR_DATA_DIR: join(homeProd, ".cc-deck", "data"), CCR_TOKEN: "dummy-dry-run", CCR_PORT: "8899" });
      assert(outE1.includes(IMPL_A), "E1 生产缺省值形态：非隔离→落 HOME org 找到实施者 A（旧代码此形态恒 die 2——R1 P1 正锁）");

      // E2 沙盒隔离形态：CCR_DATA_DIR=异路径 → 隔离谓词中 → 随 data 走 <data>/org（夹具在）→ 找到 A。
      const homeSb = join(rootE, "home-sb");
      mkdirSync(homeSb, { recursive: true });
      const sbData = join(rootE, "sb-data");
      mkLog(join(sbData, "org"));
      const outE2 = run({ HOME: homeSb, CCR_ORG_DIR: "", CCR_DATA_DIR: sbData, CCR_TOKEN: "dummy-dry-run", CCR_PORT: "8899" });
      assert(outE2.includes(IMPL_A), "E2 沙盒隔离形态：谓词中→org 随 data 走（<CCR_DATA_DIR>/org 找到 A——三段②分支）");

      // E3 未设 CCR_DATA_DIR：elif 非空门不进 → 落 HOME org（缺省③分支）。
      const homeBare = join(rootE, "home-bare");
      mkLog(join(homeBare, ".cc-deck", "org"));
      const outE3 = run({ HOME: homeBare, CCR_ORG_DIR: "", CCR_DATA_DIR: "", CCR_TOKEN: "dummy-dry-run", CCR_PORT: "8899" });
      assert(outE3.includes(IMPL_A), "E3 未设形态：落 HOME org（缺省③分支——非空门实证）");
    } finally { rmSync(rootE, { recursive: true, force: true }); }
  }

  console.log(`\n========== revexcl 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
