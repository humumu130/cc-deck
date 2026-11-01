// win-font-aa（1101 用户 2K 屏字体锯齿实锤）断言：
//   ①DPI 感知实证：build.rs app_manifest 烙 PerMonitorV2（932b48ba 已落——本批核验
//     其仍在+双声明齐全）+tauri.conf 无 additionalBrowserArguments 历史遗留坏开关
//   ②分数缩放防护：INIT_SCRIPT 禁 Ctrl+滚轮/键盘缩放（wheel 捕获 preventDefault+
//     Ctrl+±0 键盘路径）
//   ③CSS 渲染开关：全库零 text-rendering:never/font-smoothing 错值（默认 ClearType 路径）
//   ④ClearType 文档：三步向导+验收单条目在位
//   ⑤CI 产物实证步：desktop.yml NSIS job Verify DPI manifest 步在位（真机证据链自动化）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

async function main() {
  const buildRs = readFileSync(join(repoRoot, "desktop-tauri/src-tauri/build.rs"), "utf-8");
  const mainRs = readFileSync(join(repoRoot, "desktop-tauri/src-tauri/src/main.rs"), "utf-8");
  const conf = readFileSync(join(repoRoot, "desktop-tauri/src-tauri/tauri.conf.json"), "utf-8");
  const novaConf = readFileSync(join(repoRoot, "desktop-tauri/src-tauri/tauri.nova.conf.json"), "utf-8");
  const wf = readFileSync(join(repoRoot, ".github/workflows/desktop.yml"), "utf-8");
  const doc = readFileSync(join(repoRoot, "docs/windows-cleartype.md"), "utf-8");
  const cssDir = join(repoRoot, "web-console/css");
  const { readdirSync } = await import("node:fs");

  section("\nG1 DPI 感知实证（manifest 烙印）：");
  {
    assert(buildRs.includes("PerMonitorV2, PerMonitor"), "build.rs manifest：dpiAwareness=PerMonitorV2, PerMonitor（932b48ba 烙印仍在）");
    assert(buildRs.includes("true/pm"), "dpiAware=true/pm 双声明（旧版阅读器兼容）");
    assert(buildRs.includes("app_manifest(manifest)"), "manifest 经 tauri_build app_manifest 挂载（进 exe 资源）");
    assert(buildRs.includes("Common-Controls"), "Common-Controls v6 依赖保留（tauri-build 文档要求）");
    assert(!conf.includes("additionalBrowserArguments"), "tauri.conf 无 additionalBrowserArguments（零历史遗留坏开关）");
    assert(!novaConf.includes("disable-lcd-text") && !novaConf.includes("force-device-scale-factor"), "nova 变体无 disable-lcd/force-device-scale 遗留");
    // Electron 旧壳排除备案：desktop/main.js 无 dpi 处理但版本线 0.3.x 已停更（非用户日用面）
    const pj = JSON.parse(readFileSync(join(repoRoot, "desktop/package.json"), "utf-8")) as { version?: string };
    assert(String(pj.version ?? "").startsWith("0.3."), `Electron 旧壳 v${pj.version}=停更线（排除用户日用面：NSIS 壳 0.7.0-test.3 起为 Windows 主分发）`);
  }

  section("\nG2 分数缩放防护（INIT_SCRIPT）：");
  {
    const i = mainRs.indexOf('const INIT_SCRIPT');
    const seg = mainRs.slice(i, i + 4000);
    assert(seg.includes('addEventListener("wheel"') && seg.includes("e.ctrlKey") && seg.includes("preventDefault"), "Ctrl+滚轮缩放禁（wheel 捕获层 preventDefault）");
    assert(seg.includes("passive: false, capture: true"), "捕获层+非 passive（拦截早于浏览器手势）");
    assert(seg.includes('e.key === "+"') && seg.includes('e.key === "0"'), "键盘路径同拦（Ctrl+ +/-/0）");
    assert(seg.includes("zoomHintAt") && seg.includes("__ccDeck005B4.toast"), "拦截有可感知反馈（toast 节流 2.5s——「滚轮坏了」错觉防）");
    assert(seg.includes("win-font-aa"), "注释锚在位（来历可溯）");
  }

  section("\nG3 CSS 渲染开关（全库零坏值）：");
  {
    const bad: string[] = [];
    for (const f of readdirSync(cssDir)) {
      const s = readFileSync(join(cssDir, f), "utf-8");
      if (/text-rendering:\s*(optimizeSpeed|never)/i.test(s)) bad.push(f + ":text-rendering");
      if (/font-smoothing:\s*(none|never)/i.test(s) && !/antialiased/.test(s)) bad.push(f + ":font-smoothing");
    }
    assert(bad.length === 0, `零 text-rendering/font-smoothing 坏值（${bad.length ? "命中：" + bad.join(",") : "默认 ClearType 路径未受扰"}）`);
  }

  section("\nG4 ClearType/显示向导文档：");
  {
    // 1101 PM 侧改版为「三层自查」（分数缩放灰度 AA 机理+200% 整数档+对照表）——锚对齐现文
    assert(doc.includes("125%") && doc.includes("100%"), "缩放档位取舍（100% 大字号方案/125% 固有观感说明）");
    assert(doc.includes("ClearType") && doc.includes("下一步"), "ClearType 校准向导（样张四轮）");
    assert(doc.includes("PerMonitorV2") && doc.includes("Ctrl+滚轮"), "应用侧对照表（manifest 实测+壳内停用网页缩放）");
    assert(doc.includes("原生分辨率"), "第三步：原生分辨率核查（GPU 整图缩放糊源）");
    assert(doc.includes("Chrome") && doc.includes("截图"), "反馈口径（区分应用内 vs 系统级的三件套）");
  }

  section("\nG5 CI 产物实证步（闸口制）：");
  {
    assert(wf.includes("Verify DPI manifest"), "desktop.yml NSIS job 含 Verify DPI manifest 步");
    assert(wf.includes("PerMonitorV2") && wf.includes("::error::"), "解包 grep 实证+失败即 error（闸口制非提醒制）");
    // 闸三硬伤锁死（首版缺陷：路径缺 working-directory 恒空/nova 主 exe 改名不中/windows runner 无 strings）：
    const g5 = wf.slice(wf.indexOf("Verify DPI manifest"), wf.indexOf("Verify DPI manifest") + 1600);
    assert(g5.includes("working-directory: desktop-tauri"), "闸步带 working-directory: desktop-tauri（Build NSIS 同款——根目录下 src-tauri/ 路径恒空的硬伤）");
    assert(g5.includes("'{app}\\\\*.exe'") || g5.includes("{app}\\*.exe"), "通配提主 exe（nova 变体改名 cc-deck-nova——钉死 CC Deck.exe 单名不中 nova tag）");
    assert(g5.includes("grep -a") && !g5.includes("strings "), "grep -a 直证 PE .rsrc 明文（windows runner 无 strings——兜底恒炸的硬伤）");
    assert((g5.match(/exit 1/g) || []).length >= 2, "提取失败也 exit 1（fail-closed——7z 路径形态漂移不得静默漏检）");
  }

  section("\nG6 关于页渲染环境探针（归因自动化）：");
  {
    const sd = readFileSync(join(repoRoot, "web-console/js/settings-domain.js"), "utf-8");
    assert(sd.includes("data-settings-render-probe"), "关于页版本行下有渲染环境探针行（DOM 位）");
    assert(sd.includes("devicePixelRatio") && sd.includes("分数档"), "探针读 devicePixelRatio+分数档判定（125%/150% 缩放=Chromium 禁子像素 AA 的直接归因）");
    assert(sd.includes("windows-cleartype.md"), "分数档文案直接指向自查向导（用户自助闭环）");
    assert(sd.indexOf("fillRenderProbe") < sd.indexOf("setupSettingsDomain();") && /fillRenderProbe\(\); \/\/ win-font-aa/.test(sd), "探针在 setupSettingsDomain() 建成后调用（首版 IIFE 挂 init 期=元素未生跑空——CDP 实证零尺寸后修）");
    assert(!sd.includes("Ctrl+0 可恢复"), "文案无 Ctrl+0 残留（壳内已拦缩放键——自相矛盾口径清除）");
    const doc2 = readFileSync(join(repoRoot, "docs/windows-cleartype.md"), "utf-8");
    assert(doc2.includes("渲染环境"), "向导反馈口径接探针行（报判定而非猜百分比）");
  }

  console.log(`\n========== win-font-aa 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
