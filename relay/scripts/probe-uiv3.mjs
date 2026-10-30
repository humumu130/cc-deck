// W-UIV3 视觉探针：项目卡 v3 + 聚合两行制 + 移动项目卡（注入 SNAPSHOT→切项目域→断言+双主题截图）
// 用法：node probe-uiv3.mjs <after|before>——同一 fixture 双态跑，产物落 /tmp/w-uiv3-probe/<tag>/
// 注意 HTML_PATH 指向本 worktree（团队经验：复用批次探针先查指向，勿打他 worktree）。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9341 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "after"; // 动态端口：crash 残留的孤儿 Chrome 会占死旧端口（本探针 crash 掉 kill 段的实锤）——新跑连上幽灵实例=陈旧行为假象
const OUT = `/tmp/w-uiv3-probe/${TAG}`;
const URL0 = "file:///private/tmp/cc-deck-w-ui-v3-visual/web-console/index-005.html";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/uiv3-cdp-" + TAG + "-" + Date.now(), `--window-size=1440,940`, URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page" && t.url.includes("index-005"));
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); require("node:fs").writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);

// ---------- fixture：三组+未立项+验收+通知+长标题+裸 UUID ----------
const now = Date.now();
const mkS = (id, title, status, cwd, extra = {}) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - (extra.ago ?? 3e5), started_at: now - 9e5, cwd, context_usage: 84000, context_limit: 200000, artifacts: extra.arts, initial_prompt: extra.ip });
const projA = [];
for (let i = 1; i <= 13; i++) projA.push(mkS(`a-done-${i}`, `完成会话 ${i}（历史批次）`, "DONE", "/Users/u/dev/cc-deck", { ago: i * 36e5 }));
projA.push(mkS("a-w-1", "在跑修复批：板卡归宿方案 A 导入面（跨域长标题验收——断括号截断测试「逐字段投影+读切库」）", "WORKING", "/Users/u/dev/cc-deck", { ago: 2e4 }));
projA.push(mkS("a-w-2", "在跑 UI v3 视觉大修三路合并", "WORKING", "/Users/u/dev/cc-deck", { ago: 9e4 }));
projA.push(mkS("a-w-3", "在跑发版链 test.74 出包", "WORKING", "/Users/u/dev/cc-deck", { ago: 1.2e5 }));
projA.push(mkS("a-w-4", "在跑巡检批", "WORKING", "/Users/u/dev/cc-deck", { ago: 1.5e5 }));
projA.push(mkS("a-wait-1", "等确认的 AskUser 问卷卡 v2（悬停待处理）", "WAITING", "/Users/u/dev/cc-deck", { ago: 5e4 }));
projA.push(mkS("a-err-1", "连接断开重连中", "ERROR", "/Users/u/dev/cc-deck", { ago: 6e4 }));
const bareUuid = "3fa9c1d2-7b84-4f55-9c31-a6e04b22d1ff"; // 裸 UUID 标题（C3 降级面）
projA.push(mkS(bareUuid, undefined, "DONE", "/Users/u/dev/cc-deck", { ip: undefined, ago: 2e6 }));
projA[1].artifacts = [{ path: "/Users/u/dev/cc-deck/docs/v2-m10-freeze.md", exists: true, last_at: now - 8e5 }, { path: "/Users/u/dev/cc-deck/artifacts/w-board-fate-a.md", exists: true, last_at: now - 2e5 }];
const notif = (key, sid, title) => ({ key, kind: "dispatch", group: "action", severity: "waiting", title, body: "", sourceContext: { domain: "org", sessionId: sid }, actionable: true, created_at: now - 4e4 });
const notifs = [notif("n1", "a-wait-1", "问卷卡等确认"), notif("n2", "a-err-1", "连接异常需处理")];
for (let i = 1; i <= 12; i++) notifs.push(notif(`bx-${i}`, "b-done-1", `B 组行动项 ${i}（>9 显 9+ 面）`));
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u",
  sessions: [...projA,
    mkS("b-done-1", "B 组短会话", "DONE", "/Users/u/lab/短平快实验", { ago: 5e5 }),
    mkS("b-w-1", "B 组进行中", "WORKING", "/Users/u/lab/短平快实验", { ago: 3e4 }),
    mkS("c-old-1", "挂起项目旧会话", "DONE", "/Users/u/archive/旧项目归档区", { ago: 9e7 }),
    mkS("u-misc-1", "未立项散会话（中文目录）", "WORKING", "/Users/u/笔记/中文目录名很长的情况测试", { ago: 7e4 }),
    mkS("d-w-1", "D 组无待办在跑", "WORKING", "/Users/u/dev/other", { ago: 6e4 }),
    mkS("d-done-1", "D 组完成", "DONE", "/Users/u/dev/other", { ago: 6e6 })],
  projects: [
    { id: "gA", name: "cc-deck 主项目", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", created_at: now - 864e5, acceptance_count: 2, headcount: [
      { session_id: "a-w-1", role: "worker", model: "glm-5.3" }, { session_id: "a-w-2", role: "worker", model: "glm-5.3" }, { session_id: "missing-offline", role: "worker" }] },
    { id: "gB", name: "短平快实验", status: "pending", tier: "轻立项", anchor_dir: "/Users/u/lab/短平快实验", created_at: now - 432e5, acceptance_count: 0, headcount: [] },
    { id: "gC", name: "旧项目归档区", status: "parked", tier: "轻立项", anchor_dir: "/Users/u/archive/旧项目归档区", created_at: now - 9e8, acceptance_count: 0, headcount: [] },
    { id: "gD", name: "活跃无待办组", status: "active", tier: "轻立项", anchor_dir: "/Users/u/dev/other", created_at: now - 2e7, acceptance_count: 0, headcount: [] },
  ],
  acceptances: [
    { id: "acc-1", title: "板卡归宿方案 A 验收单（导入幂等/行数对齐/读切库三区）", judged: 1, total: 3, created_at: now - 26e6, submitted: false },
    { id: "acc-2", title: "AskUser 问卷卡 v2 验收单", judged: 3, total: 3, created_at: now - 7e7, submitted: true },
  ],
  notifications: notifs, receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`); // file:// 下 connection 恒 unconfigured——补 open 事件解锁 waiting 横幅（hasSnapshot 后 waitingText 空）
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(400);
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(900);
// 未入项目组展开（默认折叠；unfiledCollapsed 是脚本装载期读死的变量——localStorage 预写无效，
// 只能点击翻转。带重试：点击后确认第 5 卡出现为止（跨渲染帧偶发一拍延迟）
for (let i = 0; i < 4; i++) {
  const n = await ev(`document.querySelectorAll('#d-project [data-project-queue] .queue-card.pc3').length`);
  if (n >= 5) break;
  await ev(`document.querySelector('[data-project-unfiled-toggle]')?.click()`);
  await wait(450);
}

// ---------- 截图：项目列表 / 聚合（宽两列+窄单列）/ 浅色 / 移动 ----------
const qRect = await ev(`(() => { const r = document.querySelector('#d-project aside.queue').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 860), scale: 1 }; })()`);
await shot("01-project-list-dark", qRect);
const mRect = await ev(`(() => { const r = document.querySelector('#d-project .workspace').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 860), scale: 1 }; })()`);
await shot("02-aggregate-dark-wide", mRect);
// 窄窗单列（900px）
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 940, deviceScaleFactor: 1, mobile: false });
await wait(500);
const mRect2 = await ev(`(() => { const r = document.querySelector('#d-project .workspace').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 860), scale: 1 }; })()`);
await shot("03-aggregate-dark-narrow", mRect2);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
// 浅色主题
await ev(`document.documentElement.setAttribute('data-theme', 'light')`);
await wait(500);
await shot("04-aggregate-light-wide", mRect);
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
// 移动端项目卡
await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await wait(400);
await ev(`document.getElementById('stage-desktop').classList.remove('active'); document.getElementById('stage-mobile').classList.add('active')`);
await ev(`document.querySelector('.mobile-nav [data-mobile-root="project"]')?.click()`); // 走移动导航真入口（直改 class 不换 active 独占态，探针首拍实锤截到收件箱）
await wait(900);
const moRect = await ev(`(() => { const r = document.getElementById('m-project').getBoundingClientRect(); return { x: 0, y: 0, width: 420, height: 900, scale: 1 }; })()`);
await shot("05-mobile-project", moRect);

// ---------- 断言（after 态；before 态只截图不断言） ----------
if (TAG === "after") {
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await ev(`document.getElementById('stage-mobile').classList.remove('active'); document.getElementById('stage-desktop').classList.add('active')`);
  await wait(500);
  let pass = 0, fail = 0;
  const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + n); };
  const r = await ev(`(() => {
    const cards = [...document.querySelectorAll('#d-project .queue-card.pc3')];
    const metas = cards.map(c => c.querySelector('.pc3-meta')?.textContent || "");
    const capsuleInMeta = cards.some(c => c.querySelector('.pc3-meta .cc-badge, .pc3-meta .pc2-count'));
    const dots = [...new Set(cards.map(c => getComputedStyle(c.querySelector('.pc3-dot')).backgroundColor))].filter(x => x !== "rgba(0, 0, 0, 0)"); // 空心点背景透明（灰在描边上）不计色位
    const badge = document.querySelector('#d-project .queue-card.pc3 .cc-badge.is-alert');
    const bs = badge ? getComputedStyle(badge) : null;
    const groups = [...document.querySelectorAll('#d-project [data-project-queue] .queue-group[data-count]')];
    const gAfter = groups.length ? getComputedStyle(groups[0], "::after").content : "";
    const unfiledDot = [...document.querySelectorAll('#d-project .pc3-dot.is-idle-o')].map(d => getComputedStyle(d));
    const vrow = document.querySelector('#d-project .vrow.v3');
    const vt = vrow ? getComputedStyle(vrow.querySelector('.t')) : null;
    const vk = vrow ? getComputedStyle(vrow.querySelector('.k')) : null;
    const vid = document.querySelector('#d-project .vrow.v3 .v3-id');
    const prog = document.querySelector('#d-project .v3-prog i');
    const liveDot = document.querySelector('#d-project .live-dot');
    const pathA = cards[0]?.querySelector('.pc3-path')?.textContent || "";
    const grid = getComputedStyle(document.querySelector('#d-project .psec-grid'));
    const openBtn = document.querySelector('#d-project .queue-card.pc3 .project-open-btn');
    return {
      nCards: cards.length, dotCls: cards.map(c => c.querySelector('.pc3-dot')?.className), metas, capsuleInMeta, dotColors: dots,
      badgeH: bs ? bs.height : "", badgeR: bs ? bs.borderRadius : "", badgeF: bs ? bs.fontSize : "",
      badge9: cards.some(c => c.querySelector('.cc-badge.is-alert')?.textContent.includes("9+")),
      noBadgeZero: cards.filter(c => !c.querySelector('.cc-badge.is-alert')).length,
      gAfter, gFlex: groups.length ? getComputedStyle(groups[0]).display : "",
      unfiledHollow: unfiledDot.length > 0 && unfiledDot.every(s => s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderWidth !== "0px"),
      unfiledDbg: unfiledDot.map(s => [s.backgroundColor, s.borderWidth, s.width, s.borderTopStyle]),
      tCol: vt ? vt.flexDirection : "", kW: vk ? vk.width : "", kJust: vk ? vk.justifyContent : "",
      idLen: vid ? vid.textContent.length : 0,
      progW: prog ? prog.style.width : "",
      liveD: liveDot ? getComputedStyle(liveDot).width : "",
      pathA, gridCols: grid.gridTemplateColumns.split(" ").length,
      openAbs: openBtn ? getComputedStyle(openBtn).position : "",
    };
  })()`);
  ok(r.nCards >= 4, `pc3 卡 ${r.nCards} 张在位（dot=${JSON.stringify(r.dotCls)}）`);
  ok(!r.capsuleInMeta, `统计行无胶囊（用户点名项；元信息=${JSON.stringify(r.metas.slice(0, 3))}）`);
  ok(r.metas.every(m => /^\d+ 会话( · \d+ 进行中)?$/.test(m)), `元信息行纯文本「N 会话 · W 进行中」（12px 次级 · 分隔）`);
  ok(r.dotColors.length <= 3, `点语言 ≤3 色（实测 ${r.dotColors.join(" | ")}）`);
  ok(r.badgeH === "20px" && r.badgeR === "999px" && r.badgeF === "11px", `徽章规格统一 20px/999px/11px（实测 ${r.badgeH}/${r.badgeR}/${r.badgeF}）`);
  ok(r.badge9, `>9 需行动显 9+（B 组 12 项）`);
  ok(r.noBadgeZero >= 1, `0 需行动卡无胶囊（实测 ${r.noBadgeZero} 张）`);
  ok(r.gAfter.includes("attr") === false && /\d+/.test(r.gAfter), `分组头计数右对齐 ::after（content=${r.gAfter}）`);
  ok(r.unfiledHollow, `未立项=灰空心点（胶囊退役；实测 ${JSON.stringify(r.unfiledDbg)}）`);
  ok(r.tCol === "column", `聚合两行制（.t column；实测 ${r.tCol}）`);
  ok(r.kW === "72px", `右侧固定 72px 徽章列（实测 ${r.kW}）`);
  ok(r.idLen === 8, `裸 UUID 标题降级前 8 位等宽（实测 ${r.idLen}）`);
  ok(/%$/.test(r.progW) && r.progW !== "0%", `验收单迷你进度条（实测 width=${r.progW}）`);
  ok(r.liveD === "7px", `页头 live 圆点对齐（${r.liveD}）`);
  ok(r.pathA.startsWith("~/"), `路径 ~/ 缩写+末两级（实测 ${r.pathA}）`);
  ok(r.gridCols >= 2, `宽窗两列网格（minmax 420px；实测 ${r.gridCols} 列）`);
  ok(r.openAbs === "absolute", `文件夹图标绝对定位（${r.openAbs}）`);
  console.log(`\n探针断言: ${pass} 通过, ${fail} 失败`);
  globalThis.__fail = fail;
}
await wait(300);
globalThis.__p.kill();
process.exit(TAG === "after" && globalThis.__fail > 0 ? 1 : 0);
