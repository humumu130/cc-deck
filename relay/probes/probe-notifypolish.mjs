// W-NOTIFYPOLISH 探针（1105 用户令「通知弹窗太丑了」三路审查落地验收）。
// 双态：before=改前基线取证（截图+暗主题材质 computed JSON——暗零变化对照的机器面）；
//       after =断言（聚合/整行点/×防误触/Tab 环/徽章减熵/nowrap/面板更亮/对比度/暗材质恒等）。
// 用法：node probe-notifypolish.mjs <before|after>（复用 probe-notify-shot 骨架：CDP+SNAPSHOT 注入）。
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9841 + Math.floor(Math.random() * 300), TAG = process.argv[2] || "after";
const MODE = TAG === "before" ? "before" : "after";
const OUT = `/tmp/notify-polish/${TAG}`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/notifypolish-" + TAG + "-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page");
const tab = list.find(t => t.url.includes("index-005")) || list[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  shot ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1500);

// ---------- fixture：三组+同质×4（聚合靶）+版本芯片（nowrap 靶）+userPending（减熵靶） ----------
const now = Date.now();
const mkS = (id, title, status) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000 });
const n = (key, kind, group, title, body, ago, extra = {}) => ({ key, kind, group, severity: "info", title, body, sourceContext: { domain: "org", sessionId: "a-w-1" }, actionable: group === "action", created_at: now - ago, ...extra });
const notifs = [
  n("r1", "waiting", "action", "会话等待你的确认（AskUser 问卷卡：发布通道）", "请在会话内选择后继续", 4e4),
  n("r2", "org-confirm", "action", "组织确认：worker 成员入编审批", "", 12e4),
  // 聚合靶：同 kind+title ×4（异 key 异刻——843 重复单实锤形态）
  n("d1", "dispatch", "action", "派单收割待办：W-TEST97 交付回执已到", "", 26e4),
  n("d2", "dispatch", "action", "派单收割待办：W-TEST97 交付回执已到", "", 30e4),
  n("d3", "dispatch", "action", "派单收割待办：W-TEST97 交付回执已到", "", 34e4),
  n("d4", "dispatch", "action", "派单收割待办：W-TEST97 交付回执已到", "", 38e4),
  // W-NOTIFYPOLISH-R1 P1-2 靶：同题过时 ×4（aged>7d——豁免聚合：逐行默认可见可核销；
  // before 态（旧聚合）折 1 代表行=对照截图的问题形态，after 态 4 行逐张在场）
  n("s1", "dispatch", "action", "派单收割待办：W-AGED89 交付回执已到", "", 6.5e8),
  n("s2", "dispatch", "action", "派单收割待办：W-AGED89 交付回执已到", "", 6.6e8),
  n("s3", "dispatch", "action", "派单收割待办：W-AGED89 交付回执已到", "", 6.7e8),
  n("s4", "dispatch", "action", "派单收割待办：W-AGED89 交付回执已到", "", 6.8e8),
  n("r5", "system", "action", "系统：relay 版本错配横幅（壳 v0.7.0-test.97-nova 旧于界面 v0.7.0-test.98-nova）", "", 91e4), // .nid nowrap 靶
  n("y1", "dispatch", "attention", "worker 连败 3 单升级：建议处置", "会话 8f3a21ab 连续失败 3 单，建议查看回执后 member-retire。", 3e5),
  n("y2", "system", "attention", "聚合源连接恢复（云桥）", "", 8e5),
  n("n1", "dispatch", "info", "派单成功：review-duo → 会话 2f15…", "", 22e5),
  n("n2", "system", "info", "relay 快照完成（18 会话/4 项目）", "", 25e5),
  n("n3", "acceptance", "info", "验收单 a3d61105 全部通过", "", 3e6),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u",
  sessions: [mkS("a-w-1", "在跑审查批", "WORKING")],
  projects: [], notifications: notifs, acceptances: [], receipts: [],
  pending_user_actions: [{ key: "pu1", kind: "waiting", entity_id: "a-w-1" }] } }; // userPending 靶（等你拍板 chip）
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
// R1：展开「动态」组（stale 过时行落此组——豁免断言+可见性截图需要；observe3 默认折叠）
await ev(`document.querySelector('.ngrp[data-notify-grp="n"]')?.click()`); await wait(500);
const pRect = async () => ev(`(() => { const r = document.querySelector('[data-notify-panel]').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: Math.min(r.height + 24, 880), scale: 1 }; })()`);

// ---------- 材质 computed 快照（暗/光双主题——暗零变化的机器对照面） ----------
const matJSON = await ev(`(() => {
  const lum = (rgb) => { const m = rgb.match(/\\d+(\\.\\d+)?/g); if (!m) return -1; const [r, g, b] = m.map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b); };
  const panel = document.querySelector('[data-notify-panel]');
  const grab = () => { const cs = getComputedStyle(panel); const grp = document.querySelector('.ngrp'); const head = document.querySelector('.np-head'); const row = document.querySelector('.nrow'); const act = document.querySelector('.nrow .act'); const time = document.querySelector('.nrow-time'); return { panelBg: cs.backgroundColor, panelShadow: cs.boxShadow, ngrpBg: grp ? getComputedStyle(grp).backgroundColor : "", ngrpBlur: grp ? getComputedStyle(grp).backdropFilter : "", headBorder: head ? getComputedStyle(head).borderBottomColor : "", rowBorder: row ? getComputedStyle(row).borderBottomColor : "", actColor: act ? getComputedStyle(act).color : "", actSize: act ? getComputedStyle(act).fontSize : "", timeColor: time ? getComputedStyle(time).color : "", panelLum: lum(cs.backgroundColor), pageLum: lum(getComputedStyle(document.querySelector('.workspace') || document.body).backgroundColor) }; };
  const dark = grab();
  document.documentElement.setAttribute('data-theme', 'light');
  const light = grab();
  document.documentElement.setAttribute('data-theme', 'dark');
  return JSON.stringify({ dark, light });
})()`);
writeFileSync(`${OUT}/material.json`, matJSON, "utf-8");
console.log(`  material.json 落盘（${OUT}）`);

const rect0 = await pRect();
await shot("01-panel-dark", rect0);
await ev(`document.documentElement.setAttribute('data-theme', 'light')`); await wait(400);
await shot("02-panel-light", rect0);
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await wait(300);

if (MODE === "before") {
  // R1 P2-4：before 补至 4 张（对齐 after 形态——×清一行后的面板双主题；旧 before
  // 只 01/02 两张，对照面不全）。× 在场才点（baseline 无行则跳过纯截图）。
  await ev(`(() => { const x = document.querySelector('.nrow .x'); if (x) x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return 1; })()`);
  await wait(500);
  await shot("03-panel-after-dark", await pRect());
  await ev(`document.documentElement.setAttribute('data-theme', 'light')`); await wait(400);
  await shot("04-panel-after-light", await pRect());
  try { __p.kill(); } catch {} console.log("DONE before " + OUT); process.exit(0);
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + name); };

// ①聚合：同 kind+title ×4 → 一代表行+×4 展开钮；展开出 4 子行；再点收起
const aggBefore = await ev(`(() => { const t = [...document.querySelectorAll('.nrow b')].filter(b => b.textContent.includes('W-TEST97')); return JSON.stringify({ n: t.length, hasChip: !!document.querySelector('[data-notify-agg-toggle]') }); })()`);
const agg0 = JSON.parse(aggBefore);
ok(agg0.n === 1 && agg0.hasChip, `① 同质×4 聚合为一代表行（n=${agg0.n} chip=${agg0.hasChip}）`);
const subN = await ev(`(() => { const b = document.querySelector('[data-notify-agg-toggle]'); if (!b) return 0; b.click(); return 1; })()`);
await wait(400);
const expanded = await ev(`document.querySelectorAll('.nrow.sub').length`);
ok(subN === 1 && expanded === 3, `① 展开子项 3 行（N-1——代表行之外逐条可处置；n=${expanded}）`);
await ev(`document.querySelector('[data-notify-agg-toggle]')?.click()`); await wait(300);
ok(await ev(`document.querySelectorAll('.nrow.sub').length`) === 0, "① 再点收起子项");

// ---------- R1 组（A 审 P1×2 返修验收） ----------
// P1-2 stale 豁免聚合：同题 aged×4 逐行在场（before 态折 1——「过时可查」承诺恢复）
const staleRows = await ev(`[...document.querySelectorAll('.nrow')].filter(r => ((r.querySelector('b')||{}).textContent||'').includes('W-AGED89')).length`);
ok(staleRows === 4, `R1-a 过时行豁免聚合（同题 aged×4 逐行 ${staleRows}/4——PM 拍板：过时单逐张可见可核销，聚合只用于活跃同题降噪）`);
// 活跃同题聚合不回归（豁免只放行 stale——active 簇照折）
ok((await ev(`[...document.querySelectorAll('.nrow b')].filter(b => b.textContent.includes('W-TEST97')).length`)) === 1, "R1-b 活跃同题聚合不回归（W-TEST97 仍折 1 代表行）");
// P1-1 计数单源：组头 cnt = rail badge = 原始行数（收起簇态同屏同数——旧态组头显簇数 4 打架）
const cnts = JSON.parse(await ev(`(() => { const g = document.querySelector('.ngrp[data-notify-grp="r"] .cnt'); const b = document.querySelector('.rail-btn[data-domain="notify"] [data-notify-badge]') || document.querySelector('[data-notify-badge]'); return JSON.stringify({ grp: g ? g.textContent : "?", rail: b ? b.textContent : "?" }); })()`));
ok(cnts.grp === "7" && cnts.rail === "7", `R1-c 组头计数单源（组头 ${cnts.grp} = rail ${cnts.rail} = 原始 7 行——簇收起态不显簇数，展开不跳变）`);
// P1-2 联动：stale 行不计需行动（badge 7 不含 aged 4——过时归档不虚增行动数）
ok(cnts.rail === "7", `R1-d 过时行不计需行动（rail=7 含 d 簇 4 折计原数、不含 s1-s4——aged 归档口径维持）`);

// ④减熵：.ic 列已删（无 .nrow .ic）+userPending 行只留 chip（kind 徽章不在）+行内色点 ≤2
const entropy = JSON.parse(await ev(`(() => { const ic = document.querySelectorAll('.nrow .ic').length; const au = [...document.querySelectorAll('.nrow')].find(r => r.querySelector('.awaitu-chip')); const kindOnAu = au ? au.querySelectorAll('.nbadge:not(.awaitu-chip):not(.stale-chip)').length : -1; const dots = [...document.querySelectorAll('.nrow')].map(r => r.querySelectorAll('.awaitu-dot,.ndot').length); return JSON.stringify({ ic, kindOnAu, maxDots: Math.max(...dots, 0) }); })()`));
ok(entropy.ic === 0, `④ .ic 图标列已删（腾 26px 给标题；余 ${entropy.ic}）`);
ok(entropy.kindOnAu === 0, `④ userPending 行只留「等你拍板」chip（kind 徽章余 ${entropy.kindOnAu}）`);
ok(entropy.maxDots <= 2, `④ 单行色点 ≤2（max=${entropy.maxDots}）`);

// ⑦排印：.nid 不劈行（getClientRects 单矩形）+组头字距 0/左缘 14 对齐
const typo = JSON.parse(await ev(`(() => { const nids = [...document.querySelectorAll('.nid')]; const wrapped = nids.filter(x => x.getClientRects().length > 1 || x.scrollWidth > x.clientWidth + 1).length; const grp = getComputedStyle(document.querySelector('.ngrp')); const row = document.querySelector('.nrow'); return JSON.stringify({ nidN: nids.length, wrapped, grpLs: grp.letterSpacing, grpPadL: grp.paddingLeft, rowPadL: getComputedStyle(row).paddingLeft }); })()`));
ok(typo.nidN > 0 && typo.wrapped === 0, `⑦ .nid 版本芯片零劈行（${typo.nidN} 枚 wrapped=${typo.wrapped}）`);
ok((typo.grpLs === "normal" || parseFloat(typo.grpLs) === 0) && typo.grpPadL === typo.rowPadL, `⑦ 组头字距 0+左缘对齐（ls=${typo.grpLs} grp=${typo.grpPadL} row=${typo.rowPadL}）`);

// ⑤材质（光主题）：面板比页面亮+无 backdrop-filter+暗主题材质与 before 恒等
const mat = JSON.parse(matJSON);
ok(mat.light.panelLum > mat.light.pageLum + 3, `⑤ 光主题浮层比底层亮（panel ${mat.light.panelLum.toFixed(0)} > page ${mat.light.pageLum.toFixed(0)}）`);
ok(mat.dark.ngrpBlur === "none", `⑤ .ngrp backdrop-filter 已删（=${mat.dark.ngrpBlur}——WKWebView 隐患清）`);
let matEq = true, matDiff = [];
try {
  const before = JSON.parse(readFileSync("/tmp/notify-polish/before/material.json", "utf-8"));
  for (const k of ["panelBg", "panelShadow", "ngrpBg", "headBorder", "rowBorder"]) {
    if (before.dark[k] !== mat.dark[k]) { matEq = false; matDiff.push(k + ": " + before.dark[k] + " → " + mat.dark[k]); }
  }
} catch { ok(false, "⑤ before/material.json 缺（先跑 before 态）"); matEq = false; }
ok(matEq, `⑤ 暗主题材质恒等（panel/组头/分隔线零变化${matDiff.length ? "｜" + matDiff.join("；") : ""}）`);

// ⑥对比度：act 链与时间戳 ≥4.5:1（光暗双主题真值计算）
const contrast = JSON.parse(await ev(`(() => {
  // R1 P2-3（A 审实锤）：hex 兼容 color(srgb 0-1) 序列化——act 链色经 color-mix 产出
  // color(srgb …) 形态（分量 0-1），旧解析恒按 0-255 除法=亮度恒近 0、对比度虚高
  //（旧报 act 6.07/时间戳 20.05 失真；真值 act 暗 4.99/时间戳光 6.41——仍 ≥4.5 达标）。
  const hex = (c) => { const srgb = /^\\s*color\\(/.test(c); const m = c.match(/\\d+(\\.\\d+)?/g).map(Number); const f = (v) => { if (!srgb) v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (fg, bg) => { const a = hex(fg), b = hex(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const panel = document.querySelector('[data-notify-panel]');
  const bgOf = () => getComputedStyle(panel).backgroundColor;
  const one = () => { const act = document.querySelector('.nrow .act'); const time = document.querySelector('.nrow-time'); return JSON.stringify({ act: act ? ratio(getComputedStyle(act).color, bgOf()) : 99, time: time ? ratio(getComputedStyle(time).color, bgOf()) : 99 }); };
  const dark = JSON.parse(one());
  document.documentElement.setAttribute('data-theme', 'light');
  const light = JSON.parse(one());
  document.documentElement.setAttribute('data-theme', 'dark');
  return JSON.stringify({ dark, light });
})()`));
ok(contrast.light.act >= 4.5 && contrast.dark.act >= 4.5, `⑥ act 链 ≥4.5:1（光 ${contrast.light.act.toFixed(2)} / 暗 ${contrast.dark.act.toFixed(2)}）`);
ok(contrast.light.time >= 4.5, `⑥ 时间戳光主题 ≥4.5:1（${contrast.light.time.toFixed(2)}）`);

// ②×不误触（先于 jump 测——jump 换域可能关面板，× 测需面板在场）
const rowN = await ev(`document.querySelectorAll('.nrow').length`);
await ev(`(() => { const x = document.querySelector('.nrow .x'); if (x) x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return 1; })()`);
await wait(400);
const afterX = JSON.parse(await ev(`(() => JSON.stringify({ open: !!document.querySelector('#d-notify.on'), rows: document.querySelectorAll('.nrow').length }))()`));
ok(afterX.open === true && afterX.rows === rowN - 1, `② ×只清本行不误触（面板仍开 ${afterX.open} 行 ${afterX.rows}=${rowN}-1——× 先命中，不清全域不跳转）`);

// ③键盘：Tab 环（面板内 focusables；末位 Shift+Tab 回首位——debug 实证需 cancelable）
const tabbed = await ev(`(() => { const p = document.querySelector('[data-notify-panel]'); const f = p.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])'); if (!f.length) return "nofocus"; f[0].focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); return document.activeElement === f[f.length - 1] ? "wrap" : "nowrap:" + (document.activeElement ? document.activeElement.className : "none"); })()`);
ok(tabbed === "wrap", `③ 键盘 Tab 环成立（${tabbed}）`);

// 头部计数退役+时间信息在场（nsub 不再显「N 项需行动」）
const headTxt = await ev(`document.querySelector('[data-notify-panel-sub]')?.textContent || ""`);
ok(!/项需行动/.test(headTxt) && headTxt.trim().length > 0, `③ 头部计数退役+增量信息（「${headTxt.trim()}」）`);

// R1 P2-4（A 审实锤 03/04 空白）：原序 ② jump 在截图前——jump 切域关面板后对关态取
// rect=零框→空白（重开也不净：jump 副作用下面板态失真）。修：**截图前移**（×处置后的
// 真实 after 态：面板开+动态组展开=stale 逐行在镜），jump 测试挪到截图之后收尾。
await shot("03-panel-after-dark", await pRect());
await ev(`document.documentElement.setAttribute('data-theme', 'light')`); await wait(400);
await shot("04-panel-after-light", await pRect());
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await wait(300);
// R1 验收追加镜：fixture 行数多、面板滚动区+880 截高帽把动态组（stale 行所在）切在
// 镜外——np-body 滚到底补一张「过时行逐张在场」专项镜（P1-2 可视证据）
await ev(`(() => { const b = document.querySelector('[data-notify-panel-body]'); if (b) b.scrollTop = b.scrollHeight; return 1; })()`);
await wait(300);
await shot("05-stale-rows-dark", await pRect());
await ev(`(() => { const b = document.querySelector('[data-notify-panel-body]'); if (b) b.scrollTop = 0; return 1; })()`);

// ②整行可点（active 行点卡身=jump；bridge 暴露名 __ccDeck005B4——railJump 真 spy）
await ev(`(() => { window.__jumpSpy = 0; const b = window.__ccDeck005B4; if (b && b.railJump) { const o = b.railJump.bind(b); b.railJump = (...a) => { window.__jumpSpy = (window.__jumpSpy || 0) + 1; return o(...a); }; } return 1; })()`);
await ev(`(() => { const r = [...document.querySelectorAll('.nrow')].find(x => x.dataset.notifyActive === "true" && !x.classList.contains("sub")); const t = r?.querySelector(".t"); if (t) t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return !!t; })()`);
await wait(400);
ok(await ev(`window.__jumpSpy`) >= 1, "② active 行点卡身=执行 jump（整行可达——railJump 真实触发）");

console.log(`\nnotifypolish probe: ${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
