// W-MOBILE3 #109 主题橙防回退断言（2026-10-15 拍板：品牌色统一橙系）。
//
// 权威=docs/mockups/v8-ui-interactive-v3.html 手机壳独立体系（--p-* token：
// dark 段 82-96 行 / light 段 155-162 行）。theme.ts 的 brand 族键已逐键直译
// （2026-10-14 批落地 brandA/B/Hover/tint*/qRowSel/fabPlus/sendFg/me*），本套件
// 锁死两端对照——原型侧改色或 theme 侧回退青/蓝系即刻红。
//
// 直跑（tsx 装在 relay/node_modules）：
//   cd expo-app && node --import tsx scripts/test-mobile3-theme.ts
// 纯读文件断言，无 RN 依赖（不需要 401c 桩层）。

// @ts-expect-error node:module 未进 expo tsconfig types 字段（401c 同款）
import { readFileSync } from "node:fs";
// @ts-expect-error 同上
import { fileURLToPath } from "node:url";
// @ts-expect-error 同上
import { dirname, join } from "node:path";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const here = dirname(fileURLToPath(import.meta.url));
const proto = readFileSync(join(here, "../../docs/mockups/v8-ui-interactive-v3.html"), "utf-8");
const themeSrc = readFileSync(join(here, "../src/theme.ts"), "utf-8");

// 从原型抽手机壳 token（dark 段=「手机壳独立体系」注释后；light 段=[data-theme="light"] 内 .phone 前）
function protoToken(name: string, light: boolean): string {
  // --p-* 只在手机壳段出现两次（dark 块 + light 块）；按出现序 dark 在前 light 在后
  const re = new RegExp(`--${name}:\\s*([^;\\n]+)`, "g");
  const hits = [...proto.matchAll(re)].map((m) => m[1].trim());
  return hits[light ? 1 : 0] ?? "";
}

// theme.ts 值抽取（DARK/LIGHT 两对象按出现序）
function themeValue(key: string, light: boolean): string {
  const re = new RegExp(`${key}:\\s*"([^"]+)"`, "g");
  const hits = [...themeSrc.matchAll(re)].map((m) => m[1]);
  return hits[light ? 1 : 0] ?? "";
}

console.log("== W-MOBILE3 #109 主题橙：theme.ts ↔ v3 手机壳 token 对照 ==");

// ---- A. dark 档逐键 ----
ok(protoToken("p-brand", false) === "#EC9A73" && themeValue("brandA", false) === "#EC9A73", "A1 dark brandA = v3 --p-brand #EC9A73");
ok(protoToken("p-brand2", false) === "#C96442" && themeValue("brandB", false) === "#C96442", "A2 dark brandB = v3 --p-brand2 #C96442");
ok(themeValue("tintSoft", false) === "rgba(224,138,99,0.13)".replace("0.13", "0.13"), "A3 dark tintSoft = rgba(224,138,99,0.13)（v3 --p-brand-soft）");
ok(themeValue("meLine", false) === "rgba(224,138,99,0.45)", "A4 dark meLine = rgba(224,138,99,0.45)（v3 --p-brand-line）");
ok(themeValue("meBg", false) === "rgba(224,138,99,0.13)", "A5 dark meBg 与 soft 同基色");
ok(themeValue("fabPlus", false) === "#EC9A73" && themeValue("sendFg", false) === "#EC9A73", "A6 dark fabPlus/sendFg = brandA");

// ---- B. light 档逐键 ----
ok(protoToken("p-brand", true) === "#B85228" && themeValue("brandA", true) === "#B85228", "B1 light brandA = v3 --p-brand #B85228");
ok(protoToken("p-brand2", true) === "#96391A" && themeValue("brandB", true) === "#96391A", "B2 light brandB = v3 --p-brand2 #96391A");
ok(protoToken("p-brand-soft", true) === "rgba(192,91,51,.1)" && themeValue("tintSoft", true) === "rgba(192,91,51,0.10)", "B3 light tintSoft = rgba(192,91,51,0.10)（v3 --p-brand-soft）");
ok(protoToken("p-brand-line", true) === "rgba(192,91,51,.35)" && themeValue("meLine", true) === "rgba(192,91,51,0.35)", "B4 light meLine = rgba(192,91,51,0.35)（v3 --p-brand-line）");
ok(themeValue("fabPlus", true) === "#B85228" && themeValue("sendFg", true) === "#B85228", "B5 light fabPlus/sendFg = brandA");

// ---- C. 青/蓝系 accent 零残留（brand 位不许回退旧 accent）----
const STALE = ["#5B8DEF", "#3B82F6", "#2DD4BF", "#14B8A6", "#00C2A8", "#4F9CF9", "#2F81F7", "#6C8FF5", "#8B5CF6"];
for (const hex of STALE) ok(!themeSrc.includes(hex), `C 零残留 ${hex}（旧青/蓝紫 accent 不回潮）`);
ok(themeSrc.includes("#EC9A73") && themeSrc.includes("#B85228"), "C10 两档品牌橙基色在场");

// ---- D. 原型手机壳段自证（防原型侧漂移导致 A/B 假绿）----
ok(proto.includes("品牌色已统一橙"), "D1 原型手机壳段「品牌色已统一橙」标记在场（1014 拍板锚）");

console.log(`\nmobile3-theme: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
