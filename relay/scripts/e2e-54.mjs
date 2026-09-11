// #54 复现：消息 tab 任务行展开是否工作
import WebSocket from "ws";
import { readFileSync } from "node:fs";
const CDP = process.argv[2];
const RELAY_TOKEN = readFileSync("D:/dev/cc-watch/relay/data/token", "utf8").trim();
const BRIDGE_TOKEN = readFileSync("D:/dev/cc-watch/relay/data/bridge-token", "utf8").trim();
const SID_CLI = "e2e-54-cli";
const cdp = new WebSocket(CDP);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method: m, params: p })); });
cdp.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const hook = (body) => fetch("http://127.0.0.1:8787/bridge/hook", {
  method: "POST", headers: { "content-type": "application/json", "x-bridge-token": BRIDGE_TOKEN },
  body: JSON.stringify({ session_id: SID_CLI, cwd: "D:\dev\cc-watch", ...body }),
}).then((r) => r.json());
cdp.on("open", async () => {
  try {
    await send("Page.enable");
    await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
    await sleep(2500);
    // 造 TaskCreate（带 detail 的 tool_use）
    await hook({ event: "UserPromptSubmit", prompt: "#54 任务行展开复现", cli_pid: 999054 });
    await hook({ event: "PreToolUse", tool_name: "TaskCreate", tool_input: { subject: "展开复现任务", description: "这条明细应该在展开后可见" }, permission_mode: "default" });
    await hook({ event: "PostToolUse", tool_name: "TaskCreate", tool_response: { ok: true } });
    await sleep(1200);
    // 选会话（消息 tab 默认）
    let picked = "notfound";
    for (let i = 0; i < 12 && picked.startsWith("not"); i++) {
      picked = await ev(`(() => { const c = [...document.querySelectorAll("#cards .card")].find(x => x.textContent.includes("#54")); if (c) { c.click(); return "ok"; } return "not"; })()`);
      if (picked === "not") await sleep(500);
    }
    console.log("pick:", picked);
    await sleep(1000);
    // 找任务行与展开钮
    const probe = await ev(`(() => {
      const rows = [...document.querySelectorAll(".trow .tline")];
      const r = rows.find(x => x.textContent.includes("TaskCreate"));
      if (!r) return { found: false, rows: rows.map(x => x.textContent.slice(0, 20)) };
      const btn = r.querySelector(".x-full");
      return { found: true, hasBtn: !!btn, btnText: btn ? btn.textContent : null, rowText: r.textContent.slice(0, 60), detailVisible: !!document.querySelector(".tdetail") };
    })()`);
    console.log("probe:", JSON.stringify(probe));
    if (probe.found && probe.hasBtn) {
      // 点展开
      const after = await ev(`(() => {
        const rows = [...document.querySelectorAll(".trow .tline")];
        const r = rows.find(x => x.textContent.includes("TaskCreate"));
        const btn = r.querySelector(".x-full");
        btn.click();
        return "clicked";
      })()`);
      await sleep(500);
      const state = await ev(`(() => {
        const d = document.querySelector(".tdetail");
        return { detailOpen: !!d, detailText: d ? d.textContent.slice(0, 60) : null };
      })()`);
      console.log("after-click:", JSON.stringify(state));
      console.log(state.detailOpen ? "E2E-54: 展开正常（web 端）" : "E2E-54 FAIL: 点击后明细未出现");
    } else {
      console.log("E2E-54: 无展开按钮或无任务行——", JSON.stringify(probe));
    }
    await hook({ event: "SessionEnd", reason: "clear" });
    process.exit(0);
  } catch (e) { console.error("ERR", e.message); process.exit(1); }
});
