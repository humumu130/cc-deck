// org CLI Windows 双修断言套件（公司侧反馈 #1/#2·1029）：
// ①abs() anchor 三形态归一化（D:\x、D:/x、/d/x → Node fs 可用；POSIX 零变化）
// ②python 探测器顺序（python3→python→py；全缺=人话报错含安装指引）
// ③relay 侧 dispatchWorker anchor 校验换 anchorPathError 单点（win32 盘符不拒）
// ④物化源含探测+归一化（ensureOrgCli 沙盒物化产物逐锚）
// 直跑：env -u CCR_ORG_DIR -u CCR_ORG_BIN_DIR node --import tsx/esm scripts/test-org-cli-win.ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}
function section(s: string): void { console.log(s); }

// 沙盒物化（CCR_ORG_BIN_DIR 隔离，不碰 ~/.cc-deck/bin/org）
const SB = join(tmpdir(), "ccr-orgwin-" + Date.now());
mkdirSync(SB, { recursive: true });
process.env.CCR_ORG_BIN_DIR = join(SB, "org");
delete process.env.CCR_ORG_DIR;
const { ensureOrgCli } = await import("../src/org.js");
const bin = ensureOrgCli();
ok(typeof bin === "string" && bin === process.env.CCR_ORG_BIN_DIR, "物化到沙盒 CCR_ORG_BIN_DIR（不碰家目录）");
const script = readFileSync(bin!, "utf-8");

// abs() 提取器（物化产物 → bash eval 直跑真函数）
const absFn = script.slice(script.indexOf("abs() {"), script.indexOf("\n}", script.indexOf("abs() {")) + 2);
function abs(p: string, gitbash: boolean, cwd?: string): string {
  // PWD 经环境注入（Git Bash PWD=/d/ 形态在 mac 上无真实目录，cd 不可用——
  // bash 的 PWD 是普通变量，赋值即可被函数内 $PWD 读到）
  const out = execFileSync("bash", ["-c", `eval '${absFn.replace(/'/g, "'\\''")}' && WIN_GITBASH=${gitbash ? 1 : 0} PWD='${cwd ?? "/tmp"}' abs "$ORG_TEST_P"`], { encoding: "utf-8", env: { ...process.env, ORG_TEST_P: p } });
  return out.trim();
}

// ---------- S1 anchor 三形态归一化 ----------
section("\nS1 abs() 三形态归一化");
{
  ok(abs("/Users/x/dev/cc-deck", false) === "/Users/x/dev/cc-deck", "POSIX 绝对直通（零变化）");
  ok(abs("rel/sub", false) === "/tmp/rel/sub", "相对路径 cwd 补全（POSIX）");
  ok(abs("/d/code/myproject", true) === "D:/code/myproject", "【#1 主断言】Git Bash /d/code → D:/code（MSYS 虚拟根转盘符）");
  ok(abs("/c/Users/you/p", true) === "C:/Users/you/p", "/c/ → C:/（盘符通用）");
  ok(abs("/e/work", true) === "E:/work", "小写盘符转大写");
  ok(abs("D:\\\\code\\\\x", true) === "D:\\\\code\\\\x", "D:\\code\\x 原样过（Node win32 直接可用）");
  ok(abs("D:/code/x", true) === "D:/code/x", "D:/code/x 原样过");
  ok(abs("/home/real", true) === "/home/real", "WIN_GITBASH=1 下非单字母根 POSIX 路径仍直通（不误转）");
  ok(abs("/d/code/myproject", false) === "/d/code/myproject", "POSIX 机器 /d/... 是合法绝对路径（WIN_GITBASH=0 零转换=回归保证）");
  // 相对路径在 Git Bash PWD 形态下补全后同过转换
  const relGit = abs("myproject", true, "/d/code");
  ok(relGit === "D:/code/myproject", `相对路径+Git Bash PWD(/d/code) → 补全后同过转换（实 ${relGit}）`);
}

// ---------- S2 python 探测器 ----------
section("\nS2 python 探测器顺序");
{
  const mkFake = (dir: string, name: string): void => { writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, name), 0o755); };
  // 探测行从物化产物提取（保证测的是真脚本行为）
  const probeLine = 'PY="$(command -v python3 || command -v python || command -v py || true)"';
  ok(script.includes(probeLine), "探测器单行在物化产物（python3→python→py 顺序锚）");
  ok(script.includes("未找到 python（依次尝试过 python3 / python / py 都不在 PATH）"), "全缺报错文案含尝试顺序（人话）");
  ok(script.includes("python.org/downloads"), "报错含安装指引 URL");
  const runProbe = (pathDir: string): string => {
    try {
      return execFileSync("bash", ["-c", `PATH="${pathDir}" ; ${probeLine} ; echo "$PY"`], { encoding: "utf-8" }).trim();
    } catch { return "EXIT"; }
  };
  // 仅 py 在（Windows Git Bash 典型形态）
  const d1 = join(SB, "only-py"); mkdirSync(d1); mkFake(d1, "py");
  ok(runProbe(d1).endsWith("/py"), "仅 py 可用 → 探测到 py（Windows 典型形态）");
  // python 优先于 py
  const d2 = join(SB, "py-python"); mkdirSync(d2); mkFake(d2, "py"); mkFake(d2, "python");
  ok(runProbe(d2).endsWith("/python"), "python 与 py 并存 → python 优先（顺序第二压第三）");
  // python3 最优先
  const d3 = join(SB, "all"); mkdirSync(d3); mkFake(d3, "py"); mkFake(d3, "python"); mkFake(d3, "python3");
  ok(runProbe(d3).endsWith("/python3"), "三者并存 → python3 最优先（顺序第一）");
  // 全缺（PATH 清空到不存在目录）→ 空串（脚本 exit 1 分支由文案断言覆盖）
  const none = runProbe(join(SB, "none"));
  ok(none === "", `全缺 → PY 空（exit 1 路径触发；实 ${JSON.stringify(none)}）`);
}

// ---------- S3 relay 侧 dispatchWorker anchor 校验 ----------
section("\nS3 relay 侧 anchor 校验单点化");
{
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(!sm.includes('!input.anchor.startsWith("/")'), "dispatchWorker 硬编码 startsWith(\")\") 已移除（D:\\code 派单不再误拒）");
  ok(sm.includes("if (!input.gid) {\n      const anchorErr = anchorPathError(input.anchor);"), "换 anchorPathError 宿主判定单点（#260 同源：win32 盘符/posix 斜杠随宿主）");
  // anchorPathError 双平台行为（platform 注入，mac 测试机可验 win32 分支）
  const { anchorPathError } = await import("../src/projects.js");
  ok(anchorPathError("D:\\code\\x", "win32") === "", "anchorPathError win32 接受 D:\\code\\x");
  ok(anchorPathError("D:/code/x", "win32") === "", "anchorPathError win32 接受 D:/code/x");
  ok(anchorPathError("/Users/x/p", "darwin") === "", "anchorPathError posix 接受 /Users/x/p");
  ok(anchorPathError("relative/x", "win32") !== "", "anchorPathError win32 拒相对路径（文案带平台与示例）");
  ok(anchorPathError("D:\\x", "darwin") !== "", "anchorPathError posix 拒盘符形态（跨宿主形态互斥=防误配）");
}

// ---------- S4 物化产物完整性 ----------
section("\nS4 物化产物完整性");
{
  ok(!script.includes("python3 -"), "无残留裸 python3 调用（17 处全换 $PY）");
  ok((script.match(/"\$PY"/g) ?? []).length >= 17, `$PY 引用 ≥17 处（实 ${(script.match(/"\$PY"/g) ?? []).length}）`);
  ok(script.includes("WIN_GITBASH=0"), "WIN_GITBASH 检测在产物（MINGW/MSYS/CYGWIN）");
  ok(script.includes('case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)'), "uname 检测锚（Git Bash 识别）");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
try { rmSync(SB, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
