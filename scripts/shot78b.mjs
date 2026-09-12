// #78b 侧栏三元素底色截图验证（浅/深双模式）
import WebSocket from "ws";
const CDP = process.argv[2];
const ws = new WebSocket(CDP);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
const shot = async (name, mode) => {
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
  await sleep(1800);
  // localStorage 配本机 relay 源 + 主题模式
  await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"a5aa50d0e0f54a0ea7d13f63b26fc068"}])); "ok"`);
  // App 读取的 key 是 ccr_theme（index.html:1676），此前误写 ccd_theme 导致浅色截图实际仍是深色
  if (mode === "light") await ev(`localStorage.setItem("ccr_theme","light")`); else await ev(`localStorage.removeItem("ccr_theme")`);
  await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
  await sleep(2500);
  const img = (await send("Page.captureScreenshot", { format: "png" })).data;
  (await import("node:fs")).writeFileSync(`D:/dev/cc-watch/.tmp-043/78b-${mode}.png`, Buffer.from(img, "base64"));
  console.log("shot:", mode);
};
await shot("dark", "dark");
await shot("light", "light");
// 顺手取三元素计算样式
const probe = await ev(`JSON.stringify(["runhint","会话","密度"].map(k=>k))`); console.log(probe);
process.exit(0);
