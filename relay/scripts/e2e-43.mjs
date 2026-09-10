// #43 端到端自测：web 前端（CDP）+ 真 relay 8787 的排队→晋升全链
// 链路：hook 建会话(WORKING) → ws EXT_INPUT 注入(回显 pending) → 前端见排队气泡
//      → transcript enqueue 行(hook PostToolUse 触发增量读) → relay 晋升
//      → 前端 pending 消失 + user_message 上浮 —— 不断言 relay（test:bridge 已盖），
//      只断言 web 消费正确（排队闪烁的客户端视角闭环）
import WebSocket from "ws";
import { appendFileSync, writeFileSync } from "node:fs";
const CDP = process.argv[2];
const RELAY_TOKEN = "a5aa50d0e0f54a0ea7d13f63b26fc068";
const BRIDGE_TOKEN = (await import("node:fs")).readFileSync("D:/dev/cc-watch/relay/data/bridge-token", "utf8").trim();
const T = "D:/dev/cc-watch/relay/data/e2e-43-transcript.jsonl";
const SID_CLI = "e2e-43-cli";
const SID_EXT = "ext-" + SID_CLI;

// ---- CDP 侧 ----
const cdp = new WebSocket(CDP);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })); });
cdp.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const shot = async (name) => { const img = (await send("Page.captureScreenshot", { format: "png" })).data; (await import("node:fs")).writeFileSync(`D:/dev/cc-watch/.tmp-043/e2e43-${name}.png`, Buffer.from(img, "base64")); console.log("shot:", name); };

// ---- relay 侧 ----
const hook = (body) => fetch("http://127.0.0.1:8787/bridge/hook", {
  method: "POST",
  headers: { "content-type": "application/json", "x-bridge-token": BRIDGE_TOKEN },
  body: JSON.stringify({ session_id: SID_CLI, cwd: "D:\\dev\\cc-watch", ...body }),
}).then((r) => r.json());

cdp.on("open", async () => {
  try {
    await send("Page.enable");
    // ① 打开 web + 注入源
    await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
    await sleep(2000);
    await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{ id: "v1", name: "本机验收", kind: "lan", wsUrl: "ws://127.0.0.1:8787/ws", token: "${RELAY_TOKEN}" }])); "ok"`);
    await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
    await sleep(3000);

    // ② 建会话：WORKING + transcript
    writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线" }] } }) + "\n");
    await hook({ event: "UserPromptSubmit", prompt: "#43 端到端自测回合", cli_pid: 999999, transcript_path: T });
    await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
    await sleep(600);

    // ③ web 选该会话（容器 #cards，卡片 .card；SNAPSHOT 渲染有延迟，轮询等卡）
    let picked = "notfound";
    for (let i = 0; i < 20 && picked.startsWith("notfound"); i++) {
      picked = await ev(`(() => {
        const cards = [...document.querySelectorAll("#cards .card")];
        const c = cards.find((x) => x.textContent.includes("#43"));
        if (c) { c.click(); return "ok"; }
        return "notfound:" + cards.length;
      })()`);
      if (picked.startsWith("notfound")) await sleep(500);
    }
    console.log("pick:", picked);
    await sleep(800);

    // ④ ws 客户端注入消息（模拟手机/web 用户发送）——CLI busy → pending 回显
    const MSG = "这条消息用来验证排队闪烁修复的端到端链路，内容超过一点长度以贴近真实使用";
    const wsCmd = new WebSocket(`ws://127.0.0.1:8787/ws?token=${RELAY_TOKEN}`);
    await new Promise((r) => wsCmd.on("open", r));
    wsCmd.send(JSON.stringify({ command_id: "cmd-43a", type: "COMMAND_EXT_INPUT", payload: { session_id: SID_EXT, text: MSG }, ts: Date.now() }));
    await sleep(1500); // 等 SNAPSHOT 同步 & 前端渲染 pending

    const pendingShown = await ev(`(() => {
      const tl = document.querySelector("#timeline");
      const s = tl ? tl.textContent : "";
      return { hasPending: s.includes("排队") || s.includes(MSG.slice(0, 10)), tlLen: tl ? tl.children.length : -1 };
    })()`);
    console.log("after-send:", JSON.stringify(pendingShown));
    await shot("1-pending");

    // ⑤ CLI 捕获进队（真实 CLI 会写 queue-operation enqueue 行）→ relay #43 晋升
    appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: MSG }) + "\n");
    await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
    await sleep(1500);

    const afterPromote = await ev(`(() => {
      const tl = document.querySelector("#timeline");
      const s = tl ? tl.textContent : "";
      return { msgPromoted: s.includes("排队闪烁修复的端到端链路"), pendingGone: !s.includes("已排队") };
    })()`);
    console.log("after-promote:", JSON.stringify(afterPromote));
    await shot("2-promoted");

    // ⑥ 断言汇总
    const ok = pendingShown.hasPending && afterPromote.msgPromoted && afterPromote.pendingGone;
    console.log(ok ? "E2E-43 PASS" : "E2E-43 FAIL");
    // 清场
    await hook({ event: "SessionEnd", reason: "clear" });
    (await import("node:fs")).rmSync(T, { force: true });
    try { wsCmd.close(); } catch {}
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("ERR", e.message);
    process.exit(1);
  }
});
