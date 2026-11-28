// console-guardrails 三护栏断言（1030 黄底事故防再犯）：
//   ④常量统一：index-005 唯一定义位 __ccDeck005Version（build-plugin 回写该处）+
//     settings-domain 无独立字面量源（读 window 值）+index.html 老壳常量与 005 同值
//   ①横幅三态纯函数：parseChannelVer/consoleShellMismatch（core/通道/序号/nova 剥除/
//     不可解析静默）+静态锚（横幅渲染/关于页双版本/browser 静默链）
//   ②打包清单：tauri.conf resources 含 web-console/js/ 与 css/ 目录映射（1030 事故
//     「tar 内只有 html+图标」的根治锚）+build-plugin copy 清单 ⊆ tauri 覆盖面
//   ③部署链：desktop.yml（2 出包 job）+android.yml（1）各有 Deploy reminder 步+
//     artifact path 附 DEPLOY-CHECKLIST.md+yaml 可解析
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

async function main() {
  const html005 = readFileSync(join(repoRoot, "web-console/index-005.html"), "utf-8");
  const htmlOld = readFileSync(join(repoRoot, "web-console/index.html"), "utf-8");
  const sd = readFileSync(join(repoRoot, "web-console/js/settings-domain.js"), "utf-8");
  const css = readFileSync(join(repoRoot, "web-console/css/base.css"), "utf-8");
  const bp = readFileSync(join(repoRoot, "relay/scripts/build-plugin.mjs"), "utf-8");
  const tauri = JSON.parse(readFileSync(join(repoRoot, "desktop-tauri/src-tauri/tauri.conf.json"), "utf-8")) as { bundle?: { resources?: Record<string, string> } };

  // ---------- ④ 常量统一 ----------
  section("\nG4 CONSOLE_VERSION 常量统一：");
  {
    const m005 = /__ccDeck005Version\s*=\s*"([^"]+)"/.exec(html005);
    assert(!!m005, "index-005 头部含 __ccDeck005Version 定义（唯一定义位）");
    const v005 = m005?.[1] ?? "";
    assert(html005.indexOf("__ccDeck005Version") < html005.indexOf("icon-sprite"), "定义位在域 JS/图标之前（加载序）");
    const mOld = /CONSOLE_VERSION\s*=\s*"([^"]+)"/.exec(htmlOld);
    assert(!!mOld && mOld[1] === v005, `双壳同值（index.html=${mOld?.[1]} ≡ index-005=${v005}）`);
    assert(!/const CONSOLE_VERSION = "\d/.test(sd), "settings-domain 无独立版本字面量（单源，只读 window.__ccDeck005Version）");
    assert(sd.includes('window.__ccDeck005Version || "dev"') && !/"0\.7\.0-test\.\d+"/.test(sd), "settings-domain 读值兜底（中性 dev，无版本字面量=防漂移第三源复活）");
    assert(bp.includes('__ccDeck005Version\\s*=\\s*'), "build-plugin 回写正则命中 005 真定义位（旧 CONSOLE_VERSION 正则对 005 恒空调用）");
    assert(bp.includes('CONSOLE_VERSION\\s*=\\s*'), "build-plugin 老壳回写正则保留");
  }

  // ---------- ① 横幅三态（纯函数直跑） ----------
  section("\nG1 版本错配横幅三态：");
  // blockFrom（test-005-servers 范式）：锚串起整函数到配对 }——eval 直跑真实现
  const blockFrom = (needle: string): string => {
    const i = sd.indexOf(needle);
    if (i < 0) return "";
    const j = sd.indexOf("{", i);
    let depth = 0;
    for (let k = j; k < sd.length; k++) {
      if (sd[k] === "{") depth++;
      else if (sd[k] === "}") { depth--; if (depth === 0) return sd.slice(i, k + 1); }
    }
    return "";
  };
  const parseChannelVer = eval("(" + blockFrom("function parseChannelVer") + ")");
  const consoleShellMismatch = eval("(" + blockFrom("function consoleShellMismatch") + ")");
  assert(typeof parseChannelVer === "function" && typeof consoleShellMismatch === "function", "纯函数提取成功（blockFrom 真实现直跑）");
  {
    assert(JSON.stringify(parseChannelVer("0.7.0-test.75")) === JSON.stringify({ core: "0.7.0", channel: "test", seq: 75 }), "parseChannelVer：core+通道+序号");
    assert(JSON.stringify(parseChannelVer("0.7.0")) === JSON.stringify({ core: "0.7.0", channel: "", seq: 0 }), "parseChannelVer：裸正式版");
    assert(parseChannelVer("dev-build-xyz") === null, "parseChannelVer：不可解析→null（宁漏勿误）");
    assert(consoleShellMismatch("0.7.0-test.75-nova", "0.7.0-test.73") === "seq", "错配态①：序号落后（1030 事故同款：test.4 vs test.75，nova 后缀剥除）");
    assert(consoleShellMismatch("0.8.0", "0.7.0-test.73") === "core", "错配态②：core 落后");
    assert(consoleShellMismatch("0.7.0-test.73", "0.7.0-test.75") === null, "一致态：完全同版无横幅");
    assert(consoleShellMismatch("0.7.0", "0.7.0") === null, "一致态：正式版同版");
    assert(consoleShellMismatch("x", "0.7.0") === null, "静默态：shell 版本不可解析不判");
    // 静默态③（browser/PWA）：探测链只在 Tauri invoke 成功后写 __shellVer——静态锚
    assert(sd.includes("if (!shellV) return;"), "browser/PWA 静默：无 __shellVer 即 return（三态之三）");
    assert(sd.includes("checkConsoleShellVersion(); // console-guardrails ①：壳版本到位即比对"), "invoke 回调挂比对（壳版本到达即查）");
    assert(sd.includes('addEventListener("ccdeck:shellver", checkConsoleShellVersion)'), "shellver 事件重查（重载/热启动）");
    assert(sd.includes("壳 v\" + shellV + \" · 界面 v\""), "关于页双版本并显（错配恒可见）");
    assert(css.includes(".ver-mismatch-banner") && css.includes('[data-mismatch="core"]'), "横幅样式（双主题+core 态强化）");
    assert(sd.includes('id = "cc-ver-mismatch"') || sd.includes('el.id = "cc-ver-mismatch"'), "横幅 DOM 幂等（同 id 复用）");
  }

  // ---------- ② 打包清单 ----------
  section("\nG2 包内完整兜底（tauri.conf 目录映射）：");
  {
    const res = tauri.bundle?.resources ?? {};
    assert(res["../../web-console/js/"] === "web-console/js/", "resources 含 web-console/js/ 目录映射（1030 事故根治锚）");
    assert(res["../../web-console/css/"] === "web-console/css/", "resources 含 web-console/css/ 目录映射");
    assert(res["../../web-console/index-005.html"] === "web-console/index-005.html", "005 主壳文件级条目保留");
    // build-plugin copy 面 ⊆ tauri 覆盖面（web-console 域）
    const copies = [...bp.matchAll(/copy\(join\(root, "web-console", "([^"]+)"\)/g)].map((m) => m[1]);
    const covered = (rel: string): boolean => ("../../web-console/" + rel) in res || ("../../web-console/" + rel.split("/")[0] + "/") in res;
    // 豁免：preview=插件开发预览面（桌面运行时不需要，仅插件分发携带）
    const EXEMPT = new Set(["preview"]);
    const uncovered = copies.filter((c) => !covered(c) && !EXEMPT.has(c));
    assert(copies.length > 0 && uncovered.length === 0, `build-plugin web-console 拷贝面 ⊆ tauri 覆盖（${copies.length} 项全中${uncovered.length ? "，漏：" + uncovered.join(",") : ""}）`);
  }

  // ---------- ③ 部署链 ----------
  section("\nG3 出包 job 部署提醒（workflow）：");
  {
    for (const wf of ["desktop.yml", "android.yml"]) {
      const src = readFileSync(join(repoRoot, ".github/workflows", wf), "utf-8");
      const n = (src.match(/Deploy reminder（console-guardrails/g) || []).length;
      const uploads = (src.match(/- name: Upload artifact/g) || []).length;
      assert(n === uploads && n > 0, `${wf}：每个 Upload artifact 前有 Deploy reminder 步（${n}/${uploads}）`);
      assert(src.includes("::warning::⚠️ 本包不含部署"), `${wf}：annotation 硬提醒在位`);
      assert(src.includes("DEPLOY-CHECKLIST.md <<'CHK'"), `${wf}：核对表生成步在位`);
      assert(src.includes("DEPLOY-CHECKLIST.md\n") || src.trimEnd().endsWith("DEPLOY-CHECKLIST.md"), `${wf}：artifact path 附核对表`);
      assert(src.includes("$GITHUB_STEP_SUMMARY"), `${wf}：job summary 硬提醒`);
      // YAML 校验经 python3 子进程（本机 yaml 模块实测可用；仓内无 js-yaml 依赖——
      // 校验器依赖不进 runtime 是纪律）
      let parsedOk = false;
      try { execSync(`python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" "${join(repoRoot, ".github/workflows", wf)}"`, { stdio: "pipe" }); parsedOk = true; } catch { parsedOk = false; }
      assert(parsedOk, `${wf}：YAML 可解析`);
    }
    const dy = readFileSync(join(repoRoot, ".github/workflows/desktop.yml"), "utf-8");
    assert(dy.includes('__ccDeck005Version = \\"'), "desktop.yml CI 005 烙印 sed 修到真定义位（旧 CONSOLE_VERSION 模式恒不命中）");
    assert(dy.includes('const CONSOLE_VERSION = \\"'), "desktop.yml 老壳烙印 sed 保留");
  }

  console.log(`\n========== console-guardrails 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
