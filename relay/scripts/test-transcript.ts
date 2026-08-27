// #60 端到端：托管会话 Write+Edit → SESSION_LOG 携带 detail（工具完整入参）与 diff（+/- 行）。
// 用法: npx tsx scripts/test-transcript.ts
import WebSocket from "ws";

const TOKEN = process.env.CCR_TOKEN ?? "devtoken";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${TOKEN}`);

let sid = "";
let fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? ` :: ${detail}` : ""}`);
  if (!cond) fail++;
};

interface LogP {
  kind: string;
  tool?: string;
  text: string;
  detail?: string;
  diff?: string[];
}
const logs: LogP[] = [];

ws.on("open", () => {
  console.log("[test] connected, CREATE（Write + Edit scratch 文件）");
  ws.send(JSON.stringify({
    command_id: crypto.randomUUID(),
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: {
      cwd: "D:\\dev\\cc-watch\\relay\\data",
      prompt:
        "用 Write 工具创建文件 transcript-test.txt，内容两行：hello alpha\nsecond line。" +
        "然后用 Edit 工具把其中的 alpha 改成 beta。完成后用一句话说明两步结果。",
    },
  }));
});

ws.on("message", (d) => {
  const env = JSON.parse(String(d));
  if (env.type === "COMMAND_ACK") {
    console.log(`[ack] ok=${env.ok} sid=${env.session_id ?? "-"} ${env.error ?? ""}`);
    if (env.session_id) sid = env.session_id;
    return;
  }
  if (env.type === "SESSION_LOG" && env.session_id === sid) {
    logs.push(env.payload as LogP);
    return;
  }
  if (env.type === "SESSION_WAITING" && env.session_id === sid) {
    const p = env.payload;
    if (Array.isArray(p.questions) && p.questions.length > 0) return; // 问题等待不自动处理（本测试不触发）
    console.log(`[test] 自动放行工具: ${p.tool_name}`);
    ws.send(JSON.stringify({
      command_id: crypto.randomUUID(),
      type: "COMMAND_CONTINUE",
      ts: Date.now(),
      payload: { session_id: sid, request_id: p.request_id },
    }));
    return;
  }
  if (env.type === "SESSION_DONE" && env.session_id === sid) {
    console.log(`[done] ${env.payload.terminal_reason} · 收到 ${logs.length} 条日志`);
    const writes = logs.filter((l) => l.tool === "Write");
    const edits = logs.filter((l) => l.tool === "Edit");
    const writeDetail = writes.find((l) => (l.detail ?? "").includes("hello alpha"));
    ok("Write tool_use 带 detail（含文件内容）", !!writeDetail);
    const editDetail = edits.find((l) => (l.detail ?? "").includes("旧"));
    ok("Edit tool_use 带 detail（旧/新对照）", !!editDetail);
    const diffLogs = logs.filter((l) => l.kind === "tool_result" && Array.isArray(l.diff) && l.diff.length > 0);
    ok("tool_result 带 diff 行", diffLogs.length > 0, JSON.stringify(logs.filter((l) => l.kind === "tool_result").map((l) => ({ t: l.text, d: l.diff?.length }))));
    const allDiffLines = diffLogs.flatMap((l) => l.diff!);
    ok("diff 含 + 行（beta）", allDiffLines.some((l) => l.startsWith("+") && l.includes("beta")), JSON.stringify(allDiffLines));
    ok("diff 含 - 行（alpha）", allDiffLines.some((l) => l.startsWith("-") && l.includes("alpha")));
    const bigResult = logs.find((l) => l.kind === "tool_result" && (l.detail ?? "").length > 160);
    console.log(`[info] 长 result detail: ${bigResult ? bigResult.detail!.length + " 字符" : "无（本次无长输出）"}`);
    console.log(fail === 0 ? "\n[test-transcript] ALL PASS" : `\n[test-transcript] FAIL x${fail}`);
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  }
});

ws.on("error", (e) => {
  console.error("[test] ws error:", e.message);
  process.exit(2);
});
setTimeout(() => {
  console.error("[test] timeout 180s");
  process.exit(3);
}, 180_000);
