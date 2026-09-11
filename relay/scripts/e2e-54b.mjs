// #54 真实会话复现：本会话（01ae6ba5）消息 tab 的 TaskCreate 行展开
import WebSocket from "ws";
const cdp = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method: m, params: p })); });
cdp.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;
cdp.on("open", async () => {
  try {
    const picked = await ev(`(() => {
      const c = [...document.querySelectorAll("#cards .card")].find(x => x.textContent.includes("恢复点") || x.textContent.includes("接力"));
      if (c) { c.click(); return "ok"; }
      return "not:" + [...document.querySelectorAll("#cards .card")].map(x => x.textContent.slice(0, 12)).join("|");
    })()`);
    console.log("pick:", picked);
    await sleep(1800);
    const probe = await ev(`(() => {
      const rows = [...document.querySelectorAll(".trow .tline")];
      const tc = rows.filter(x => x.textContent.includes("TaskCreate"));
      const first = tc[0];
      return { total: rows.length, taskRows: tc.length, firstRow: first ? first.textContent.slice(0, 70) : null, firstHasBtn: first ? !!first.querySelector(".x-full") : null };
    })()`);
    console.log("probe:", JSON.stringify(probe));
    if (probe.taskRows > 0) {
      if (probe.firstHasBtn) {
        await ev(`(() => { const rows = [...document.querySelectorAll(".trow .tline")]; rows.find(x => x.textContent.includes("TaskCreate")).querySelector(".x-full").click(); return 1; })()`);
        await sleep(600);
        const st = await ev(`(() => { const d = document.querySelector(".tdetail"); return { open: !!d, text: d ? d.textContent.slice(0, 60) : null }; })()`);
        console.log("after-click:", JSON.stringify(st));
        console.log(st.open ? "RESULT: web 端展开正常（需进一步查 App 端）" : "RESULT: 点击后明细未出现 = 复现 #54");
      } else {
        console.log("RESULT: 任务行无展开按钮（detail 缺失）= 复现 #54 的另一形态");
      }
    }
    process.exit(0);
  } catch (e) { console.error("ERR", e.message); process.exit(1); }
});
