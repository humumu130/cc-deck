// #22 web 改名实测：设置里改服务器名 → 保存 → 连接不断（token 保留）
import WebSocket from "ws";
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;
ws.on("open", async () => {
  try {
    await send("Page.enable");
    // ① 开设置（gear 面板连接页）
    await ev(`(() => { const g = document.querySelector("#gearBtn, [title*=设置]"); if (g) g.click(); return "gear"; })()`);
    await sleep(600);
    // ② 点第一行服务器进编辑
    const opened = await ev(`(() => {
      const row = document.querySelector("#srvList .srv-row");
      if (!row) return "norow";
      row.click();
      return "row-clicked";
    })()`);
    console.log("edit-open:", opened);
    await sleep(800);
    // ③ 改名为「改名验证 22」并保存
    const saved = await ev(`(() => {
      const name = document.querySelector("#srvName, input[name=name], .conn-form input");
      if (!name) return "nofield:" + [...document.querySelectorAll(".conn-form input, #srvList input")].map(i => i.id || i.placeholder).join(",");
      name.focus();
      name.value = "改名验证 22";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      const save = document.querySelector("#saveEdit, [title*=保存], .conn-form button.primary");
      if (!save) return "nosave";
      save.click();
      return "saved";
    })()`);
    console.log("save:", saved);
    await sleep(2500);
    // ④ 断言：连接不断 + 名字生效
    const after = await ev(`(() => ({
      conn: document.querySelector("#connText")?.textContent,
      firstName: document.querySelector("#srvList .srv-row b")?.textContent?.slice(0, 20),
      savedLs: localStorage.getItem("ccd_servers")?.includes("改名验证 22"),
    }))()`);
    console.log("after:", JSON.stringify(after));
    const ok = after.conn && /在线/.test(after.conn) && after.firstName && after.firstName.includes("改名验证");
    console.log(ok ? "E2E-22 PASS（改名后连接保持）" : "E2E-22 FAIL");
    // 还原名
    await ev(`(() => { const row = document.querySelector("#srvList .srv-row"); row && row.click(); return 1; })()`);
    await sleep(600);
    await ev(`(() => {
      const name = document.querySelector("#srvName, .conn-form input");
      if (name) { name.focus(); name.value = "本机"; name.dispatchEvent(new Event("input", { bubbles: true })); const s = document.querySelector("#saveEdit, [title*=保存], .conn-form button.primary"); s && s.click(); }
      return 1;
    })()`);
    process.exit(ok ? 0 : 1);
  } catch (e) { console.error("ERR", e.message); process.exit(1); }
});
