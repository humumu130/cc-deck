#!/usr/bin/env node
// 回执真实性校验（W-FLOW 环 6 硬闸，2026-10-11）
// ============================================================
// 背景：件十-B 事故——worker 回执 ✅「红黄绿自绘灯」，Leader 核验只 grep 锚点
// 存在性就放行，用户在真机上看到的是旧界面单色灯。本脚本把「声明 vs 实测」
// 的机器可判部分自动化，Leader 带宽只花在机器判不了的地方（截图过目/实质抽查）。
//
// 用法：
//   node scripts/verify-receipt-claims.mjs <回执.md> [--repo <仓库根>] [--deep]
//
// 核验项（三色输出）：
//   ✅      声明与机器实测一致
//   ❌      声明与实测不符（Leader 必看）
//   需真机  机器物理上无法核验（壳层/跨端行为），转验收单排队
//
// 机器能判的四类：
//   1. 文件改动声明（git status 代码块 / 正文 repo 相对路径引用）vs git diff 实况
//   2. 截图证据存在性（回执引用的 .png/.jpg 路径逐一 stat）
//   3. 真机项抽取（「装机复验/真机/headless 验不了/受限项」关键词行）→ 需真机清单
//   4. 复核点清点（「请 Leader 复核」段行数）+ 测试声明复跑命令建议
//
// 设计红线：不试图理解自然语言的一切。判不了的明确说「机器判不了」，
// 输出人话，退出码：0=无❌，1=有❌（可挂自动化流程）。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// ---------- 参数 ----------
const args = process.argv.slice(2);
const receiptPath = args.find((a) => !a.startsWith('--'));
const repoIdx = args.indexOf('--repo');
const repo = repoIdx >= 0 ? resolve(args[repoIdx + 1]) : process.cwd();
const deep = args.includes('--deep');

if (!receiptPath) {
  console.error('用法: node scripts/verify-receipt-claims.mjs <回执.md> [--repo <仓库根>] [--deep]');
  process.exit(2);
}
if (!existsSync(receiptPath)) {
  console.error(`❌ 回执文件不存在: ${receiptPath}`);
  process.exit(2);
}

const text = readFileSync(receiptPath, 'utf8');
const lines = text.split('\n');

const out = [];
const push = (color, msg) => out.push({ color, msg });
const git = (cmd) => execFileSync('git', cmd, { cwd: repo, encoding: 'utf8' });

// ---------- 1. 文件改动声明 ----------
// 来源 A：git status 代码块（回执惯例：```内 M path 行）
const declaredFiles = new Set();
let inFence = false;
for (const line of lines) {
  if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
  // 代码块内 git status 行：M/A/D/?? + 空格 + 路径（容忍 (说明) 尾注）
  if (inFence) {
    const st = line.match(/^\s*([MAD?]{1,2})\s+([^\s(（]+)/);
    if (st) declaredFiles.add(st[2]);
  }
}
// 来源 B：正文高频 repo 相对路径引用（形如 `web-console/index-005.html:123` 或 `path` 行文引用）
// 扩展名按长度降序（json 先于 js、tsx 先于 ts），防 app.json 被截成 app.js；
// cp/mv/拷贝 同行的路径是处置命令语境非改动声明，排除（自指测试实锤：⚠️段 cp 命令被当声明）
const repoFileRe = /(?:^|[\s`（(])((?:web-console|expo-app|desktop-tauri|relay|scripts|mobile|cc-plugins)\/[\w./-]+\.(?:html|json|gradle|mjs|tsx|mts|cts|md|sh|ts|js))(?::(\d+))?/g;
for (const line of lines) {
  if (/^\s*(?:cp|mv)\s/.test(line)) continue; // 处置命令行整体跳过
  for (const m of line.matchAll(repoFileRe)) {
    // 路径之前的文本落在处置动词后（「同步: cp …」「复制 …」）= 命令语境非改动声明
    const before = line.slice(0, m.index);
    if (/(?:拷贝|复制|同步|cp|mv)\s*`?\s*$/.test(before)) continue;
    declaredFiles.add(m[1]);
  }
}

if (declaredFiles.size === 0) {
  push('warn', '未抽到文件改动声明（回执无 git status 块也无 repo 路径引用）——人工确认改动域');
} else {
  // git 实况：工作区改动集（回执惯例是未 commit 交付；若已 commit，用最近一笔 diff）
  let actual = new Set();
  let mode = '';
  try {
    // 先 split 再判空：整体 trim 会吃掉第一行行首的 porcelain 状态空格，
    // slice(3) 随即切坏路径（实测 ` M docs/README.md` → `ocs/README.md`，2026-10-11 自指测试）
    const statusLines = git(['status', '--porcelain']).split('\n').filter((l) => l.trim());
    if (statusLines.length) {
      mode = '工作区未提交改动';
      for (const l of statusLines) actual.add(l.slice(3).split(' -> ').pop().trim());
    } else {
      mode = '工作区干净，改用 HEAD 一笔 diff';
      const head = git(['log', '-1', '--format=%h %s']).trim();
      const stat = git(['diff', '--name-only', 'HEAD~1', 'HEAD']).trim();
      mode += `（${head}）`;
      if (stat) for (const l of stat.split('\n')) actual.add(l.trim());
    }
  } catch (e) {
    push('warn', `git 实况取不到（${e.message.split('\n')[0]}）——文件声明核验跳过`);
  }
  if (actual.size) {
    push('info', `git 实况：${mode}，共 ${actual.size} 个文件`);
    let hit = 0;
    for (const f of [...declaredFiles].sort()) {
      const inActual = [...actual].some((a) => a === f || a.endsWith('/' + f) || f.endsWith('/' + a));
      if (inActual) { hit++; push('ok', `文件改动: ${f}（git 实况有此文件）`); }
      else push(hit ? 'bad' : 'pending-bad', `文件声明: ${f}——git 实况改动集中没有它`);
    }
    // 0 命中 = 大概率回执与当前工作区不同源（跨 worktree 核验 / 已 squash 进主干），
    // 逐文件❌全是噪音——降级为一条口径提示（真❌只在部分命中时才有区分力）
    const pending = out.filter((o) => o.color === 'pending-bad');
    if (pending.length && hit === 0) {
      for (const p of pending) p.color = 'info';
      push('warn', `文件声明 ${pending.length}/${declaredFiles.size} 全部未命中当前 git 实况——回执与当前工作区不同源（跨 worktree？已 squash？）。文件级核验请到交付 worktree 跑本脚本，或核对声明指向的提交`);
    } else {
      for (const p of pending) if (p.color === 'pending-bad') p.color = 'bad';
    }
    // 反向：实况有但回执没提的文件（混入其他任务的信号）
    for (const a of [...actual].sort()) {
      const mentioned = [...declaredFiles].some((f) => f === a || f.endsWith('/' + a) || a.endsWith('/' + f));
      if (!mentioned) push('warn', `实况有但回执未提: ${a}——他任务混入？或回执改动清单不全`);
    }
  }
}

// ---------- 2. 截图证据存在性 ----------
const shotRe = /((?:\/[\w.-]+)+\/[\w.-]+\.(?:png|jpg|jpeg))/g;
const shots = new Set();
for (const m of text.matchAll(shotRe)) shots.add(m[1]);
let shotOk = 0, shotBad = 0;
for (const s of [...shots].sort()) {
  if (existsSync(s)) { shotOk++; push('ok', `截图在: ${s}`); }
  else { shotBad++; push('bad', `截图缺失: ${s}（回执引用但文件不存在——L2「必看图」无从看起）`); }
}
if (shots.size === 0) {
  // 只在「报告测试结果」语境提醒（自指测试实锤：描述脚本能力的 CDP 字样不缺截图）；
  // 测试结果语境 = 断言 N 项 / ALL PASS / N/N 全绿 / CDP…过
  const uiResult = /(断言|探针).{0,20}\d+\s*项|ALL PASS|\d+\/\d+\s*(全绿|PASS)|CDP.{0,30}(全过|全绿|✓)/.test(text);
  push(uiResult ? 'warn' : 'info', uiResult
    ? '回执报了断言/测试结果但没引用任何截图——L2 级改动缺视觉证据，按 flow-hardening §2.2「L2 必看图」补'
    : '无截图引用（纯 L1 逻辑件属正常）');
}

// ---------- 3. 真机项抽取（需真机三色） ----------
// 两档词表（自指测试实锤：行粒度关键词无法区分「声明受限」vs「描述规则时提到该词」，
// 长行假阳烧 Leader 注意力=案例 4 核心矛盾）：
//   受限项段内 → 宽表（段语境本身就是声明）
//   段外行 → 严表（只认「复验点」式强列举，描述性提及不抽；漏网兜底=受限项段整体抽取）
const broadRe = /(装机复验|留装机|待装机|真机待验|真机补验|真机复验|headless\s*(?:无法|验不了|验不到|无法验证)|无法\s*headless|生产环境补验|需云桥在线的生产环境)/i;
const strictRe = /(装机复验点|装机验证点|留装机复验|待装机复验|真机复验点|复验点清单|需云桥在线的生产环境)/i;
const realItems = [];
let inRestrictedScan = false;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^#{2,4}\s*.*受限/.test(l)) { inRestrictedScan = true; continue; }
  if (inRestrictedScan && /^#{2,4}\s/.test(l)) inRestrictedScan = false;
  const re = inRestrictedScan ? broadRe : strictRe;
  if (re.test(l)) {
    // 取该行去掉 markdown 装饰的紧凑文本（截 100 字）
    const t = l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim().slice(0, 100);
    if (t && !realItems.some((x) => x === t)) realItems.push(t);
  }
}
// 「受限项」段整体抽取（回执惯例强制段）
const restricted = [];
let inRestricted = false;
for (const l of lines) {
  if (/^#{2,4}\s*.*受限/.test(l)) { inRestricted = true; continue; }
  if (inRestricted && /^#{2,4}\s/.test(l)) inRestricted = false;
  if (inRestricted) {
    const t = l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim();
    if (t && !restricted.includes(t)) restricted.push(t);
  }
}
for (const t of restricted.slice(0, 20)) push('device', `受限项: ${t}`);
for (const t of realItems) {
  if (!restricted.some((r) => t.includes(r.slice(0, 30)) || r.includes(t.slice(0, 30)))) {
    push('device', `真机项: ${t}`);
  }
}
if (realItems.length === 0 && restricted.length === 0) {
  push('warn', '未抽到任何真机/受限声明——若改动涉 Tauri 壳层/expo（L3/L4），回执按 flow-hardening §2.1 必须列装机复验点');
}

// ---------- 4. 复核点与测试声明 ----------
// 只认「标题级」复核段（## 请 Leader 复核…）——正文中部「回执请 Leader 复核」字样
// 不是段起点（W-TEST11 实测：误锚定正文导致 19 条数成 4 条）
const reviewSections = [];
const headRe = /^#{2,4}\s*.*请\s*Leader\s*复核.*$/gm;
let hm;
while ((hm = headRe.exec(text))) {
  const rest = text.slice(hm.index + hm[0].length);
  const end = rest.match(/\n#{2,4}\s|\n---/);
  reviewSections.push(end ? rest.slice(0, end.index) : rest);
}
const reviewCount = reviewSections.reduce((n, s) => n + (s.match(/^\s*\d+\.\s/gm) || []).length, 0);
push(reviewCount ? 'info' : 'warn', reviewCount
  ? `复核点 ${reviewCount} 条（Leader 逐条裁决后回执才算闭环）`
  : '无「请 Leader 复核」标题段——口径取舍要么没有（确认）要么漏写（补）');

// 测试声明 → 复跑命令建议（--deep 时不代跑，给命令让 Leader 决定跑不跑）
const suggestions = [];
if (/tsc|类型检查/i.test(text)) suggestions.push('cd expo-app && ./node_modules/.bin/tsc --noEmit');
if (/单测|测试套件|vitest|jest|node --test/i.test(text)) suggestions.push('（按回执提到的套件路径重跑，如: cd relay && npm test）');
if (/ALL PASS|断言.*PASS|\d+\/\d+/.test(text)) suggestions.push('（CDP 探针脚本按回执沙盒配方复跑——配方在回执「沙盒配方」段）');
if (suggestions.length) push('info', '复跑建议（Leader 自选执行）：\n    ' + suggestions.join('\n    '));

// ---------- 输出 ----------
const ICON = { ok: '✅', bad: '❌', device: '🟡 需真机', warn: '⚠️ ', info: 'ℹ️ ' };
console.log(`\n== 回执核验表 ==（${receiptPath}）\n`);
for (const o of out) console.log(`${ICON[o.color]} ${o.msg}`);
const c = (k) => out.filter((o) => o.color === k).length;
console.log(`\n== 汇总 == ✅ ${c('ok')} · ❌ ${c('bad')} · 需真机 ${c('device')} · ⚠️ ${c('warn')}`);
console.log('\nLeader 下一步（flow-hardening 环 6）:');
let step = 0;
const next = (msg) => console.log(`  ${++step}. ${msg}`);
if (c('bad')) next('逐条看上面 ❌ 项——声明与实测不符是核验第一优先');
const shotDir = [...shots].find((s) => existsSync(s));
if (shotDir) next(`L2 必看图：打开截图逐张过目（截图目录样本: ${shotDir.replace(/\/[^/]+$/, '')}）`);
if (c('device')) next('需真机项 → 写进验收单（环 7 唯一排队处），任务标「代码核验过，真机待验」');
next('抽查 1-2 件实质（不是 grep 锚点——找断言对应的视觉/行为证据）');
process.exit(c('bad') ? 1 : 0);
