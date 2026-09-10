// #30 插件三组件端到端终版：真 relay 进程 + 真插件 hook 脚本子进程 + USERPROFILE 重定向隔离
// 验：A qNotify（忙碌插话→USER_NOTE）/ B taskGuard（待办摘要注入 stdout）/ C restorePoint（state.md 落盘）/ D Stop 拦截
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wsPkg from "file:///D:/dev/cc-watch/relay/node_modules/ws/index.js";
const { WebSocket } = wsPkg;

const PORT = String(19400 + Math.floor(Math.random() * 90));
const fakeHome = mkdtempSync(join(tmpdir(), "plugF-"));
const deck = join(fakeHome, ".cc-deck");
const data = join(deck, "data"); // relay dataDir 同目录（生产对齐：cli-pids 由 relay 写、guard 读）
mkdirSync(data, { recursive: true });
writeFileSync(join(deck, "config.json"), JSON.stringify({ taskGuard: true, qNotify: true, restorePoint: true }));

const env = { ...process.env, CCR_DATA_DIR: data, CCR_PORT: PORT, USERPROFILE: fakeHome, HOME: fakeHome };
delete env.CCR_CLOUD_URL;
const relay = spawn("npx", ["tsx", "src/index.ts"], { cwd: "D:/dev/cc-watch/relay", env, stdio: ["ignore", "pipe", "pipe"], shell: true });
await new Promise((r) => setTimeout(r, 5500));
const token = readFileSync(join(data, "token"), "utf8").trim();

const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws?token=" + token);
const notes = [];
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "USER_NOTE") notes.push(m.payload); });
await new Promise((r) => ws.on("open", r));

const P = "D:/dev/cc-watch/cc-plugins/plugins/cc-deck/scripts";
const run = (script, input) => new Promise((resolve) => {
  const p = spawn("node", [join(P, script)], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("exit", () => resolve(out));
  p.stdin.end(JSON.stringify(input));
});

const sid = "e2e-" + Date.now();
const taskDir = join(fakeHome, ".claude", "tasks", sid);
mkdirSync(taskDir, { recursive: true });
writeFileSync(join(taskDir, "1.json"), JSON.stringify({ id: 1, subject: "#1 遗留任务测试", status: "pending" }));
writeFileSync(join(taskDir, "2.json"), JSON.stringify({ id: 2, subject: "#2 另一件", status: "in_progress" }));
const cwd = mkdtempSync(join(tmpdir(), "projF-"));

// ① hook.mjs 注册会话（relay 写 cli-pids.json → guard 作用域守卫放行）
await run("hook.mjs", { event: "UserPromptSubmit", session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: "任务一", cli_pid: process.pid, transcript_path: join(cwd, "t.jsonl") });
await new Promise((r) => setTimeout(r, 600));
// ② guard-context ×3：1 置忙碌 → 2/3 忙碌插话（qNotify 发 USER_NOTE；taskGuard 注入待办摘要）
await run("guard-context.mjs", { session_id: sid, cwd, prompt: "第一条" });
await run("guard-context.mjs", { session_id: sid, cwd, prompt: "插话：看看 X" });
const ctxOut = await run("guard-context.mjs", { session_id: sid, cwd, prompt: "再来一句" });
await new Promise((r) => setTimeout(r, 1500));
// ③ guard-stop：第一次拦截 → 第二次确认放行（restorePoint 此时落盘）
const stopOut = await run("guard-stop.mjs", { session_id: sid, cwd, stop_hook_active: false });
const stopOut2 = await run("guard-stop.mjs", { session_id: sid, cwd, stop_hook_active: true });

const stateMd = existsSync(join(cwd, ".cc-deck", "state.md")) ? readFileSync(join(cwd, ".cc-deck", "state.md"), "utf8") : "";
console.log("A qNotify→USER_NOTE:", notes.length > 0, notes[0] ? "| " + notes[0].text : "");
console.log("B taskGuard→待办摘要(含#1):", /#1 遗留/.test(ctxOut));
console.log("C restorePoint→state.md(含任务):", /#1 遗留|#2 另一件/.test(stateMd));
console.log("D Stop 拦截(未完成提示):", /#1 遗留|未完成/.test(stopOut));
const all = notes.length > 0 && /#1 遗留/.test(ctxOut) && /#1 遗留|#2/.test(stateMd) && /#1 遗留|未完成/.test(stopOut);
console.log(all ? "PLUGIN E2E PASSED" : "PLUGIN E2E PARTIAL/FAIL");
relay.kill();
process.exit(0);
