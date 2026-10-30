// 输出物链五件断言套件（deliver-chain·公司侧反馈 1029）：
// ①Bug1 sid 命名空间：relay 账本落 cli_sid（CLI 原生 sid）+ deliver-stop hook
//   三态对账（sid ‖ cli_sid ‖ ext-+sid）——登记即豁免从未生效的根治；未登记照拦
// ②Bug2 deliver CLI Windows 路径双拼：D:\x / D:/x 原样过；POSIX/相对零变化
// ③Bug3 validateDeliverablePath 错误文案原文透传（resolve 重写不再误导排障）
// ④问题0 python 探测器 python3→python→py（org CLI e23e6bf4 模式复用）
// ⑤附带 同 sid+path 复登幂等（大小写不敏感）+ 响应 deduped 标记
// 直跑：node --import tsx/esm scripts/test-deliver-chain.ts（在 relay/ 下）
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}
function section(s: string): void { console.log(s); }

const REPO = fileURLToPath(new URL("..", import.meta.url)); // relay/
const PLUGIN = join(REPO, "..", "cc-plugins", "plugins", "cc-deck");
const SB = join(tmpdir(), "ccr-deliver-chain-" + Date.now());
mkdirSync(SB, { recursive: true });

// ---------- S1 relay：cli_sid 落账 + 复登幂等（Bug1 根 + 附带） ----------
section("\nS1 relay cli_sid 落账 + 复登幂等");
{
  process.env.CCR_DATA_DIR = join(SB, "data-s1");
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");
  const bus = new EventBus();
  const cfg = loadConfig();
  const mgr = new SessionManager(bus, cfg);
  const dataDir = cfg.dataDir ?? process.env.CCR_DATA_DIR!;
  const ledgerPath = join(dataDir, "deliverables.json");
  const ledger = (): { sid: string; path: string; ts: number; cli_sid?: string }[] =>
    JSON.parse(readFileSync(ledgerPath, "utf-8"));

  const root = join(SB, "s1-files");
  mkdirSync(root, { recursive: true });
  const f1 = join(root, "report-1.md"); writeFileSync(f1, "# 1\n");
  const f2 = join(root, "report-2.md"); writeFileSync(f2, "# 2\n");
  const fCase = join(root, "Case.md"); writeFileSync(fCase, "# c\n");

  // 三形态卡：ext- 前缀（现行外部 CC 卡）/ 裸 UUID 老卡（#230 relay_session_id
  // 反查）/ 托管形态（卡 id 即 CLI sid）
  const SID_E = "11111111-aaaa-4bbb-8ccc-000000000001";
  const SID_O = "22222222-aaaa-4bbb-8ccc-000000000002";
  const SID_M = "33333333-aaaa-4bbb-8ccc-000000000003";
  const CARD_O = "oldcard-9999-aaaa-bbbb";
  mgr.ensureExternal(`ext-${SID_E}`, root, "外部卡", SID_E);
  mgr.ensureExternal(CARD_O, root, "老卡", SID_O);
  mgr.ensureExternal(SID_M, root, "托管形态卡", SID_M + "-unused");

  // ext- 形态：账本 sid=卡 id（ext-前缀）+ cli_sid=CLI 原生 sid
  let r = mgr.deliverBySession(SID_E, root, f1);
  ok(r.ok && r.session_id === `ext-${SID_E}`, "ext- 卡归因不变（session_id=卡 id）");
  let e = ledger().find((x) => x.path === f1);
  ok(e?.sid === `ext-${SID_E}` && e?.cli_sid === SID_E, "【Bug1 主断言①】ext- 形态账本同时落 cli_sid=CLI 原生 sid");

  // 老卡形态（#230 反查）：卡 id 与 CLI sid 无前缀关系——纯前缀归一化必漏，cli_sid 兜住
  r = mgr.deliverBySession(SID_O, root, f2);
  ok(r.ok && r.session_id === CARD_O, "老卡反查归因不变（#230 回归）");
  e = ledger().find((x) => x.path === f2);
  ok(e?.sid === CARD_O && e?.cli_sid === SID_O, "【Bug1 主断言②】老卡任意 id 形态账本落 cli_sid（纯 ext- 剥前缀盖不住的形态）");

  // 托管形态（卡 id === CLI sid）：cli_sid 不落（两形态同 id，无需冗余）
  r = mgr.deliverBySession(SID_M, root, f1);
  ok(r.ok && r.session_id === SID_M, "托管形态第一查直接命中");
  const m = ledger().find((x) => x.sid === SID_M);
  ok(m !== undefined && !("cli_sid" in m), "托管形态 cli_sid 冗余位省略（sid 本身即原生形态）");

  // 复登幂等（附带）：同 sid+path 二登 → 账本一行 + 响应 deduped
  const before = ledger().length;
  r = mgr.deliverBySession(SID_E, root, f1);
  ok(r.ok && r.deduped === true, "【附带】同 sid+path 复登响应带 deduped:true");
  ok(ledger().length === before, "【附带】复登后账本条目数不增（幂等）");
  // 大小写形态（Windows 同文件异拼写）：Case.md → case.md 一行
  mgr.deliverBySession(SID_E, root, fCase);
  const r2 = mgr.deliverBySession(SID_E, root, join(root, "case.md"));
  const rows = ledger().filter((x) => x.path.toLowerCase() === fCase.toLowerCase());
  ok(rows.length === 1 && r2.deduped === true, `【附带】大小写异拼写同文件去重为一行（实 ${rows.length} 行）`);
}

// ---------- S2 validateDeliverablePath 错误原文透传（Bug3） ----------
section("\nS2 错误文案原文透传");
{
  const { validateDeliverablePath } = await import("../src/artifacts.js");
  const garbage = "/d/code/proj/C:\\docs\\报告.md";
  const v1 = validateDeliverablePath(garbage);
  ok(!v1.ok && v1.error!.includes(garbage), "【Bug3 主断言】混反斜杠垃圾路径报错原文样透传（不渲染 resolve 重写形）");
  ok(typeof v1.path === "string" && v1.path.length > 0, "（回归）path 字段仍返回 resolved 形态（程序面消费不变）");
  const v2 = validateDeliverablePath("no/such/rel.md");
  ok(!v2.ok && v2.error === "交付物不存在或不可访问: no/such/rel.md", "相对路径报错=原文（非 resolved 绝对形，mac 可区分新旧行为）");
  const dirp = join(SB, "s2dir"); mkdirSync(dirp, { recursive: true });
  const v3 = validateDeliverablePath(dirp);
  ok(!v3.ok && v3.error === `交付物必须是普通文件: ${dirp}`, "目录报错=原文");
  const realRaw = join(SB, "s2real.md"); writeFileSync(realRaw, "x");
  const real = realpathSync(realRaw); // realpath 形态：/var→/private/var 符号链接不触发 unverified（size=null 是既有正确行为非回归）
  const v4 = validateDeliverablePath(real);
  ok(v4.ok && v4.path === real && typeof v4.size === "number", "（回归）合法文件成功路径零变化（resolved+size 快照）");
  ok(validateDeliverablePath("   ").ok === false, "空白 path 拒绝");
}
// ---------- S3 deliver-stop hook e2e 三态对账（Bug1 验收点1） ----------
section("\nS3 deliver-stop hook 三态对账 e2e");
{
  const hook = join(PLUGIN, "scripts", "deliver-stop.mjs");
  const mkHome = (sid: string, ledgerRows: unknown[], watchPaths: string[], realFiles: string[]): string => {
    const home = join(SB, "home-" + sid);
    const deck = join(home, ".cc-deck");
    mkdirSync(join(deck, "data", "deliver-watch"), { recursive: true });
    mkdirSync(join(deck, "bin"), { recursive: true });
    writeFileSync(join(deck, "config.json"), JSON.stringify({ deliverables: true }));
    writeFileSync(join(deck, "bin", "deliver"), "#!/bin/sh\n"); // hook 只验存在性
    writeFileSync(join(deck, "data", "cli-pids.json"), JSON.stringify({ [sid]: process.pid }));
    writeFileSync(join(deck, "data", "deliverables.json"), JSON.stringify(ledgerRows));
    if (watchPaths.length) writeFileSync(join(deck, "data", "deliver-watch", sid + ".json"), JSON.stringify({ p: watchPaths, a: [] }));
    mkdirSync(join(SB, "s3files"), { recursive: true });
    for (const f of realFiles) writeFileSync(f, "x");
    return home;
  };
  // 摘除 CCR_RELAY_CHILD：本测试进程自身可能由 relay spawn（worker 会话），透传会
  // 触发 hook 的「relay 自拉 CLI 不守卫」直通豁免——所有场景假绿 exit 0（场景 D
  // 的「未登记照拦」即此污染的哨兵）
  const hookEnv: Record<string, string | undefined> = { ...process.env, HOME: "" };
  delete hookEnv.CCR_RELAY_CHILD;
  const runHook = (home: string, sid: string) =>
    spawnSync("node", [hook], { input: JSON.stringify({ session_id: sid }), encoding: "utf-8", env: { ...hookEnv, HOME: home } });

  const files = (n: string) => join(SB, "s3files", n);
  const SID_A = "aaaaaaa1-0000-4000-8000-00000000000a";
  const SID_B = "aaaaaaa2-0000-4000-8000-00000000000b";
  const SID_C = "aaaaaaa3-0000-4000-8000-00000000000c";
  const SID_D = "aaaaaaa4-0000-4000-8000-00000000000d";
  const SID_E = "aaaaaaa5-0000-4000-8000-00000000000e";

  // A. 存量 ext- 账目（公司侧 5 条实锤形态，无 cli_sid）→ 登记即豁免
  let h = mkHome(SID_A, [{ sid: `ext-${SID_A}`, path: files("a.md"), ts: Date.now() }], [files("a.md")], [files("a.md")]);
  let r = runHook(h, SID_A);
  ok(r.status === 0, `【Bug1 验收①·ext- 存量形态】登记后 Stop 放行（exit ${r.status}，修复前必 2）`);

  // B. cli_sid 账目（新落账形态，老卡任意 id）→ 放行
  h = mkHome(SID_B, [{ sid: "oldcard-anything", cli_sid: SID_B, path: files("b.md"), ts: Date.now() }], [files("b.md")], [files("b.md")]);
  r = runHook(h, SID_B);
  ok(r.status === 0, `【Bug1 验收①·cli_sid 形态】登记后 Stop 放行（exit ${r.status}）`);

  // C. 托管裸 sid 账目（原就有形态回归）
  h = mkHome(SID_C, [{ sid: SID_C, path: files("c.md"), ts: Date.now() }], [files("c.md")], [files("c.md")]);
  r = runHook(h, SID_C);
  ok(r.status === 0, `（回归）裸 sid 精确命中形态仍放行（exit ${r.status}）`);

  // D. 未登记 → 照拦（exit 2 + 提醒文案）
  h = mkHome(SID_D, [], [files("d.md")], [files("d.md")]);
  r = runHook(h, SID_D);
  ok(r.status === 2 && r.stderr.includes(files("d.md")), `【Bug1 验收②】未登记会话照拦（exit ${r.status}，stderr 含漏登记路径）`);

  // E. 部分登记 → 只拦剩余（原语义回归）
  h = mkHome(SID_E, [{ sid: `ext-${SID_E}`, path: files("e1.md"), ts: Date.now() }], [files("e1.md"), files("e2.md")], [files("e1.md"), files("e2.md")]);
  r = runHook(h, SID_E);
  ok(r.status === 2 && r.stderr.includes("e2.md") && !r.stderr.includes("e1.md"), "（回归）部分登记只提醒剩余文件");
}

// ---------- S4 deliver CLI：python 探测器 + 路径三形态（Bug2+问题0） ----------
section("\nS4 deliver CLI 探测器与路径三形态");
{
  const bin = join(PLUGIN, "bin", "deliver");
  const script = readFileSync(bin, "utf-8");
  execFileSync("bash", ["-n", bin]);
  ok(true, "bash -n 语法通过");
  // 探测器（org e23e6bf4 模式）
  const probeLine = 'PY="$(command -v python3 || command -v python || command -v py || true)"';
  ok(script.includes(probeLine), "探测器单行在产物（python3→python→py 顺序锚）");
  ok(script.includes("依次尝试过 python3 / python / py 都不在 PATH"), "全缺报错文案含尝试顺序");
  ok(script.includes("python.org/downloads"), "报错含安装指引 URL");
  const callLines = script.split("\n").filter((l) => /(?<![A-Za-z0-9_#"])python3\s+-/.test(l));
  ok(callLines.length === 0, `无残留裸 python3 调用（实 ${callLines.length} 处）`);
  ok((script.match(/"\$PY"/g) ?? []).length >= 6, `$PY 引用 ≥6 处（实 ${(script.match(/"\$PY"/g) ?? []).length}）`);
  ok(script.includes('WIN_GITBASH=0') && script.includes('DELIVER_TEST_GITBASH'), "Git Bash 检测+测试注入口在产物");
  // 探测器顺序行为（PATH 注入假解释器）
  const fakeDir = join(SB, "fake-bin"); mkdirSync(fakeDir, { recursive: true });
  const mkFake = (dir: string, name: string): void => { writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, name), 0o755); };
  const runProbe = (d: string): string => {
    try { return execFileSync("bash", ["-c", `PATH="${d}" ; ${probeLine} ; echo "$PY"`], { encoding: "utf-8" }).trim(); } catch { return "EXIT"; }
  };
  const d1 = join(fakeDir, "only-py"); mkdirSync(d1); mkFake(d1, "py");
  ok(runProbe(d1).endsWith("/py"), "仅 py → 探测到 py（Git Bash 典型形态）");
  const d2 = join(fakeDir, "py-python"); mkdirSync(d2); mkFake(d2, "py"); mkFake(d2, "python");
  ok(runProbe(d2).endsWith("/python"), "python 压 py（顺序二压三）");
  const d3 = join(fakeDir, "all"); mkdirSync(d3); mkFake(d3, "py"); mkFake(d3, "python"); mkFake(d3, "python3");
  ok(runProbe(d3).endsWith("/python3"), "python3 最优先（顺序一）");
  ok(runProbe(join(fakeDir, "none")) === "", "全缺 → PY 空（exit 1 路径）");
  // abs() 三形态（物化产物提取真函数 bash eval）
  const absFn = script.slice(script.indexOf("abs() {"), script.indexOf("\n}", script.indexOf("abs() {")) + 2);
  const abs = (p: string, gitbash: boolean, cwd?: string): string =>
    execFileSync("bash", ["-c", `eval '${absFn.replace(/'/g, "'\\''")}' && WIN_GITBASH=${gitbash ? 1 : 0} PWD='${cwd ?? "/tmp"}' abs "$ORG_TEST_P"`], { encoding: "utf-8", env: { ...process.env, ORG_TEST_P: p } }).trim();
  ok(abs("/Users/x/dev/cc-deck", false) === "/Users/x/dev/cc-deck", "（回归）POSIX 绝对直通零变化");
  ok(abs("rel/sub.md", false) === "/tmp/rel/sub.md", "（回归）相对路径补 $PWD（POSIX）");
  ok(abs(".", false) === "/tmp", "（回归）abs . 精确等于 $PWD（body cwd 参数字节不变）");
  ok(abs("D:\\\\code\\\\x.md", false) === "D:\\\\code\\\\x.md", "【Bug2 主断言①】D:\\code\\x.md 原样过（不再拼 $PWD 双拼）");
  ok(abs("D:/code/x.md", true) === "D:/code/x.md", "【Bug2 主断言②】D:/code/x.md 原样过");
  ok(abs("/d/code/proj/docs/a.md", true) === "D:/code/proj/docs/a.md", "Git Bash /d/… → D:/…（MSYS 虚拟根转盘符）");
  ok(abs("/d/code/x.md", false) === "/d/code/x.md", "（回归）POSIX 机器 /d/… 合法绝对零转换");
  ok(abs("docs/a.md", true, "/d/code/proj") === "D:/code/proj/docs/a.md", "Git Bash PWD 相对路径补全后同过转换");
  ok(script.includes('f="$(abs "$f")"'), "主路径已接 abs（双拼病灶行替换锚）");
  ok(script.includes('"$(abs .)"'), "body cwd 参数已接 abs（Git Bash cwd 同归一）");
}

// ---------- 收尾 ----------
try {
  if (existsSync(SB)) rmSync(SB, { recursive: true, force: true });
} catch {}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
