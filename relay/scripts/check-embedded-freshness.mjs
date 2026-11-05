#!/usr/bin/env node
// W-RELAYFRESHCI 新鲜度硬闸：出包物内嵌 relay 的版本戳必须 == 仓库根 VERSION。
//
// 背景（test.98/99 发布事故，2026-11-05 派单）：desktop.yml 出包 job 此前无
// bundle 重建步，内嵌 desktop-tauri/src-tauri/resources/relay.mjs 停在 97 期
// （444dbce7）连续两版未更新——appendOnly 振荡根治/watchdogperm/429 与版本哨
// relay 面全缺，「tag 出包≠源码状态」。本闸与 CI 的「当场重建」步配对使用：
// 重建步缺席/静默失效/版本没 bump，任一形态必红，零静默通过。
//
// 用法：node scripts/check-embedded-freshness.mjs [--expect-tag <tag版本>]
//   relay 目录下运行（或任意 cwd，路径按本文件位置推导，与 build-plugin 同规）。
//   --expect-tag：tag 出包时传 ${GITHUB_REF_NAME#v}——断言 tag == VERSION。
//   「打了 tag 但仓库 VERSION 没 bump」是 98/99 事故的反向形态（tag 说新版、
//   事实源还在旧版），同闸拦截，防「重建了但忘 bump」。
//
// 校验面（期望值恒为仓库根 VERSION——版本单一事实源，2026-10-10 A1 收敛）：
//   ① cc-plugins/plugins/cc-deck/.claude-plugin/plugin.json 的 version
//   ② web-console/index.html 的 CONSOLE_VERSION（旧壳）
//   ③ web-console/index-005.html 的 __ccDeck005Version（005 壳）
//   ④ relay.mjs bundle 内 define 烙印（CCR_RELAY_VERSION，bundle-options.mjs
//      注入；bundle 未 minify，替换产物为带引号字面量可直接 indexOf）
//   ⑤ 双副本 SHA 一致：cc-plugins/.../scripts/relay.mjs ==
//      desktop-tauri/src-tauri/resources/relay.mjs，且两文件存在（改陈/删除
//      任一形态都过不了 ④⑤——98/99 事故的机器可检形态）
//
// 注意：本闸设计为紧跟 build-plugin 重建步、在 tag/dev 版本烙印步**之前**跑——
// 烙印步会把 CONSOLE_VERSION 改写为通道标识（无 tag 构建带 -dev.N 后缀），
// 闸后跑会被后缀误伤；烙印语义是通道显示，与本闸的「产物==事实源」正交。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const relayRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(relayRoot, "..");

const argTagIdx = process.argv.indexOf("--expect-tag");
// W-RELAYFRESHCI-R1（A 审 P0）：剥 -nova 后缀归一——真实 tag 形如 v0.7.1-test.1-nova
//（W-NOVAONLY 门强制 tag 必带），workflow 剥 v 后仍带 -nova，而 VERSION 永不带
//（-nova 是打包通道标记非版本语义）。脚本内单点归一（A 审修法口径：勿在三个
// workflow 各改——冗余易漏）。修前：--expect-tag 0.7.1-test.1-nova vs VERSION
// 0.7.1-test.1 → exit 1 = 下次发版 tag 一触发 desktop Win/mac+android 三 job
// freshness gate 全红、发布管线断（A 审亲测复现）。
const expectTagRaw = argTagIdx !== -1 ? process.argv[argTagIdx + 1] : undefined;
const expectTag = expectTagRaw !== undefined ? expectTagRaw.replace(/-nova$/, "") : undefined;

const errors = [];
const fail = (msg) => {
  errors.push(msg);
  console.error(`::error::${msg}`);
};
const ok = (msg) => console.log(`✅ ${msg}`);

// ── 期望值：仓库根 VERSION（唯一事实源）──────────────────────────────
let ver = "";
try {
  ver = readFileSync(join(root, "VERSION"), "utf-8").trim();
} catch {
  fail(`仓库根 VERSION 文件不可读（${join(root, "VERSION")}）`);
}
if (ver && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(ver)) {
  fail(`VERSION 不是三段 semver（可带 -test.N/-snap.N 预发段）：${ver}`);
  ver = "";
}
if (ver) ok(`VERSION（唯一事实源）= ${ver}`);

// ── tag 同步断言（--expect-tag，tag 出包通道）───────────────────────
if (expectTag !== undefined) {
  if (!ver) {
    fail("VERSION 不可读时无法断言 tag 同步");
  } else if (expectTag.trim() !== ver) {
    fail(
      `tag 版本（${expectTag}）≠ 仓库 VERSION（${ver}）——tag 已打但版本事实源未 bump，` +
        "此包必为「tag 出包≠源码状态」形态（98/99 事故反向态）。先 bump VERSION 提交再重打 tag。"
    );
  } else {
    ok(`tag 版本 == VERSION（${ver}）`);
  }
}

// ── ① plugin.json version（bundle 伴生清单）────────────────────────
const pluginJsonPath = join(root, "cc-plugins", "plugins", "cc-deck", ".claude-plugin", "plugin.json");
try {
  const raw = readFileSync(pluginJsonPath, "utf-8");
  const m = raw.match(/"version":\s*"([^"]+)"/);
  if (!m) fail(`${pluginJsonPath} 无 version 字段`);
  else if (ver && m[1] !== ver) fail(`plugin.json version=${m[1]} ≠ VERSION=${ver}（bundle 陈账或回写不命中）`);
  else ok(`plugin.json version = ${m[1]}`);
} catch {
  fail(`${pluginJsonPath} 不可读——重建步未跑或产物缺失`);
}

// ── ② ③ 双壳 console 版本（与 build-plugin 回写正则同款）───────────
const consoleStamps = [
  ["CONSOLE_VERSION（旧壳）", join(root, "web-console", "index.html"), /CONSOLE_VERSION\s*=\s*"([^"]+)"/],
  ["__ccDeck005Version（005 壳）", join(root, "web-console", "index-005.html"), /__ccDeck005Version\s*=\s*"([^"]+)"/],
];
for (const [label, p, re] of consoleStamps) {
  try {
    const m = readFileSync(p, "utf-8").match(re);
    if (!m) fail(`${label}：${p} 无版本常量命中（正则 ${re}）——console-guardrails ④ 形态，回写/闸双盲`);
    else if (ver && m[1] !== ver) fail(`${label}=${m[1]} ≠ VERSION=${ver}`);
    else ok(`${label} = ${m[1]}`);
  } catch {
    fail(`${label}：${p} 不可读`);
  }
}

// ── ④⑤ 双副本存在 + bundle 烙印 + SHA 一致 ─────────────────────────
const bundlePaths = {
  plugin: join(root, "cc-plugins", "plugins", "cc-deck", "scripts", "relay.mjs"),
  desktop: join(root, "desktop-tauri", "src-tauri", "resources", "relay.mjs"),
};
const contents = {};
for (const [k, p] of Object.entries(bundlePaths)) {
  if (!existsSync(p)) {
    fail(`${k} 副本缺失：${p}——内嵌 relay 不存在（98/99 陈账的删除态形态），重建步必未生效`);
  } else {
    contents[k] = readFileSync(p);
  }
}
if (contents.plugin && contents.desktop) {
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const s1 = sha(contents.plugin);
  const s2 = sha(contents.desktop);
  if (s1 !== s2) fail(`双副本 SHA 不一致：plugin=${s1.slice(0, 12)}… desktop=${s2.slice(0, 12)}…——resources 副本非同源（手工改/半截拷贝）`);
  else ok(`双副本 SHA 一致（${s1.slice(0, 12)}…，${contents.desktop.length}B）`);

  // bundle 烙印：define 注入产物为 JSON.stringify(ver) 形态的带引号字面量
  if (ver) {
    const stamp = JSON.stringify(ver);
    for (const [k, b] of Object.entries(contents)) {
      if (!b.includes(stamp)) fail(`${k} 副本 bundle 无版本烙印 ${stamp}——CCR_RELAY_VERSION define 未注入（陈 bundle 或重建参数漂移）`);
      else ok(`${k} 副本 bundle 烙印在位（${stamp}）`);
    }
  }
}

// ── 结论 ────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(`\n❌ 新鲜度硬闸未过（${errors.length} 项红）：内嵌 relay 与版本事实源不同步，禁止出包。逐项见上方 ::error。`);
  process.exit(1);
}
console.log(`\n✅ 新鲜度硬闸通过：内嵌 relay 当场重建且版本戳 == VERSION（${ver}）——W-RELAYFRESHCI`);
