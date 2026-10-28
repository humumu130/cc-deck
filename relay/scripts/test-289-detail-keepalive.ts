// #289 手机端详情页多余状态栏（KeepAliveCard 收敛）——源级断言。
// 勘查事实（任务①）：expo DetailScreen 源零挂载 KeepAliveCard（全仓仅 SettingsPage 紧凑行
// +SetupScreen detail 态两消费点）；用户所见「去优化 ›」=设置页紧凑行形态。修法（任务②）
// =App 级设置域唯一入口化：SetupScreen detail 态挂载退役，只留 SettingsPage 一处。
// 断言口径（任务③）：详情页（expo DetailScreen/web 移动壳）两态零卡；设置页保留。
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-289-detail-keepalive.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const detail = readFileSync(join(root, "expo-app", "src", "screens", "DetailScreen.tsx"), "utf-8");
const setup = readFileSync(join(root, "expo-app", "src", "screens", "SetupScreen.tsx"), "utf-8");
const settings = readFileSync(join(root, "expo-app", "src", "screens", "SettingsPage.tsx"), "utf-8");
const webMobile = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");
const app = readFileSync(join(root, "expo-app", "App.tsx"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("#289 KeepAliveCard 收敛——详情域零卡 + 设置域唯一入口");

ok(!detail.includes("KeepAliveCard") && !detail.includes("去优化") && !detail.includes("fgSupported"),
  "R1 expo DetailScreen 零挂载（活跃/空闲两态同源——详情组件树根本不含该卡，任务①勘查实锤）");
ok(!webMobile.includes("KeepAliveCard") && !webMobile.includes("去优化") && !webMobile.includes("电池优化"),
  "R2 web 移动壳（index-005 mobile stage）零挂载——双移动壳口径一致");
ok(!app.includes("KeepAliveCard"),
  "R3 App.tsx 根导航层零直挂（detail navLayer/主壳均不染指设置域卡片）");
ok(!setup.includes("<KeepAliveCard") && !setup.includes('import KeepAliveCard'),
  "R4 SetupScreen detail 态挂载退役（添加连接页与电池豁免无关——任务②收敛：只留 SettingsPage）");
ok(!setup.includes("kaWrap") || (setup.match(/kaWrap/g) || []).length === 0,
  "R5 孤儿样式/import 清净（未用引用零残留）");
ok(settings.includes('{fgSupported() ? <KeepAliveCard /> : null}'),
  "S1 SettingsPage「通用与偏好」末行保留（App 级设置域唯一入口——任务③设置页保留锚）");

// R6 仓级唯一性锚（审查 P3 补强：白名单式断言拦不住未来新 screen 挂载——
// 全 src 扫描 KeepAliveCard 消费点必须恰为 SettingsPage 一处）
{
  const { readdirSync, statSync } = await import("node:fs");
  const srcDir = join(root, "expo-app", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name);
      if (statSync(fp).isDirectory()) { walk(fp); continue; }
      if (!/\.(tsx|ts)$/.test(name)) continue;
      if (fp.endsWith("KeepAliveCard.tsx")) continue;
      const txt = readFileSync(fp, "utf-8");
      // 只认消费面（import/JSX 挂载），注释性提及不算
      const consumes = txt.includes('import KeepAliveCard') || txt.includes("<KeepAliveCard");
      if (consumes && !fp.endsWith(join("screens", "SettingsPage.tsx"))) offenders.push(fp.replace(srcDir + "/", ""));
    }
  };
  walk(srcDir);
  ok(offenders.length === 0, `R6 仓级唯一消费点锚：expo src 内 KeepAliveCard 挂载仅 SettingsPage（违者：${offenders.join("、") || "无"}）`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
