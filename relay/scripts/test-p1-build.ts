// #018-P1b build-plugin 三产物统一生成测试。
// 断言面：三产物存在且非空、Web 副本 byte-identical 同源、两份 relay.mjs SHA256 一致
// （018 :424/:654 DoD）、插件版本同步（plugin.json=marketplace.json）、Web 副本 </html>
// 收尾结构闸、构建幂等（测试内连跑两次构建，第二次前后产物快照零 diff——可重复执行
// 不漂移）。跑本测试会执行 build-plugin.mjs 刷新产物（产物本就是生成物，刷新即同步）。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-p1-build.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginBundle = join(root, "cc-plugins", "plugins", "cc-deck", "scripts", "relay.mjs");
const desktopBundle = join(root, "desktop-tauri", "src-tauri", "resources", "relay.mjs");
const webSrc = join(root, "web-console", "index.html");
const webCopy = join(root, "cc-plugins", "plugins", "cc-deck", "web-console", "index.html");
const pluginJsonPath = join(root, "cc-plugins", "plugins", "cc-deck", ".claude-plugin", "plugin.json");
const mktPath = join(root, ".claude-plugin", "marketplace.json");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
function snapshot(): Record<string, string> {
  return {
    pluginBundle: sha256(pluginBundle),
    desktopBundle: sha256(desktopBundle),
    webCopy: sha256(webCopy),
    mkt: sha256(mktPath),
  };
}
async function runBuild(): Promise<void> {
  await execFileP("node", ["scripts/build-plugin.mjs"], { cwd: join(root, "relay") });
}

// ---- 静态面（构建前先验证在产物已生成态） ----
console.log("#018-P1b build-plugin 三产物");
try {
  for (const [label, p] of [["插件 bundle", pluginBundle], ["desktop bundle", desktopBundle], ["Web 副本", webCopy]] as const) {
    ok(statSync(p).isFile() && statSync(p).size > 0, `${label}存在且非空（${(statSync(p).size / 1024 / 1024).toFixed(1)}MB）`);
  }
  ok(statSync(pluginBundle).size > 1024 * 1024 && statSync(desktopBundle).size > 1024 * 1024,
    "两份 relay.mjs 均为 MB 级真 bundle（防空拷/占位文件）");

  const src = readFileSync(webSrc);
  const copy = readFileSync(webCopy);
  ok(src.equals(copy), "Web 副本与 web-console/index.html byte-identical（单源复制）");
  ok(readFileSync(webCopy, "utf-8").trimEnd().endsWith("</html>"), "Web 副本 </html> 收尾（完整非截断）");

  ok(sha256(pluginBundle) === sha256(desktopBundle), "两份 relay.mjs SHA256 一致（018 :654 DoD）");

  const pluginVer = JSON.parse(readFileSync(pluginJsonPath, "utf-8")).version;
  const mkt = JSON.parse(readFileSync(mktPath, "utf-8"));
  const mktVer = (mkt.plugins as { name: string; version: string }[]).find((p) => p.name === "cc-deck")?.version;
  ok(pluginVer === mktVer, `插件版本同步（plugin.json ${pluginVer} = marketplace.json ${mktVer}）`);

  const bundleText = readFileSync(pluginBundle, "utf-8");
  ok(/schema_version:\s*1\b/.test(bundleText), "bundle 内联 SNAPSHOT_SCHEMA_VERSION=1（快照协议在）");
} catch (e) {
  ok(false, "静态面读取异常：" + (e as Error).message);
}

// ---- 幂等面（连跑两次构建，第二次前后快照零 diff） ----
try {
  await runBuild(); // 第一跑：把任何 stale 刷新到与源同步
  const before = snapshot();
  await runBuild(); // 第二跑：可重复执行验证
  const after = snapshot();
  for (const key of Object.keys(before)) {
    ok(before[key] === after[key], `幂等：第二跑前后 ${key} 零变化`);
  }
} catch (e) {
  ok(false, "构建执行异常：" + (e as Error).message);
}

const total = pass + fail;
console.log(`P1 build: ${pass}/${total}`);
process.exit(fail === 0 ? 0 : 1);
