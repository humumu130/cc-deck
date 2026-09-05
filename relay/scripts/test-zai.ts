// #263 单元测试：z.ai 内置工具桥文本分类（离线，不需要 relay 运行）。
// #265 增补：混合形态（正文+桥文本同块）拆分测试。
// 用法: npx tsx scripts/test-zai.ts
import { zaiToolName, isZaiOutput, zaiBridgePrefix, capDetail, splitZaiText } from "../src/summarizer.js";

let fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? ` :: ${detail}` : ""}`);
  if (!cond) fail++;
};

const ZAI_CALL = `**🌐 Z.ai Built-in Tool: webReader**\n**Input:** {"url": "https://example.com/x"}`;
const ZAI_OUTPUT = `**Output:**\n**webReader_result_summary:** [{"text": {"url": "https://example.com/x", "title": "t"}}]`;

// zaiToolName：真实格式命中 + 前导空白容错
ok("zaiToolName 命中调用块", zaiToolName(ZAI_CALL) === "zai:webReader", String(zaiToolName(ZAI_CALL)));
ok("zaiToolName 容错前导空白", zaiToolName("\n" + ZAI_CALL) === "zai:webReader");
ok("zaiToolName 普通正文不命中", zaiToolName("正常回复正文 **🌐 不是开头") === null);
ok("zaiToolName 变体工具名", zaiToolName(`**🌐 Z.ai Built-in Tool: analyze_image**`) === "zai:analyze_image");

// isZaiOutput：真实格式命中 + 误判防护
ok("isZaiOutput 命中结果块", isZaiOutput(ZAI_OUTPUT));
ok("isZaiOutput 容错前导空白", isZaiOutput("  " + ZAI_OUTPUT));
ok("isZaiOutput 正文以 **Output:** 开头但次行非 summary 键不误判", !isZaiOutput("**Output:** 是这样生成的：xxx_result_summary 是占位"));
ok("isZaiOutput 讨论格式的正文不误判", !isZaiOutput("**Output:**\n这里讨论的是 _result_summary 格式本身"));
ok("isZaiOutput 普通正文不命中", !isZaiOutput("普通回复"));

// zaiBridgePrefix：流式期间只看前缀
ok("zaiBridgePrefix 拦截 **🌐 前缀", zaiBridgePrefix("**🌐"));
ok("zaiBridgePrefix 拦截 **Output:** 前缀", zaiBridgePrefix("**Output:**"));
ok("zaiBridgePrefix 拦截部分前缀（流式首 delta）", zaiBridgePrefix("**"));
ok("zaiBridgePrefix 不拦普通正文", !zaiBridgePrefix("正常"));
ok("zaiBridgePrefix 容错前导空白", zaiBridgePrefix(" **🌐"));

// capDetail：截断标记
const long = "x".repeat(2500);
ok("capDetail 截断带标记", capDetail(long, 2000) === "x".repeat(1999) + "… (+500 字符)");
ok("capDetail 短文原文", capDetail("abc", 2000) === "abc");

// ---------- #265 splitZaiText：混合形态（正文+桥文本同块，取自 seq 195558 真实形态） ----------
const MIXED = [
  "401 连续出现，重试另一路工具。**🌐 Z.ai Built-in Tool: analyze_image**",
  "",
  "**Input:**",
  "```json",
  '{"imageSource":"https://cdn.example.com/x.png","prompt":"截图分析"}',
  "```",
  "*Executing on server...*",
  "**Output:**",
  '**analyze_image_result_summary:** [{"text": "内容……", "type": "text"}]',
  "400 again — 需要换编码重试。",
].join("\n");
{
  const { body, segs } = splitZaiText(MIXED);
  ok("混合拆分：段数 2（调用+结果）", segs.length === 2, JSON.stringify(segs.map((s) => s.kind)));
  ok("混合拆分：调用段工具名", segs[0]?.kind === "tool_use" && segs[0]?.tool === "zai:analyze_image");
  ok("混合拆分：结果段 tool=zai", segs[1]?.kind === "tool_result" && segs[1]?.tool === "zai");
  ok("混合拆分：正文不含 Input/Output 原文", !/Input:|result_summary|Built-in/.test(body), body.slice(0, 80));
  ok("混合拆分：正文保留首尾", body.startsWith("401 连续出现") && body.includes("400 again"), body.slice(-40));
  ok("混合拆分：调用段含 Input JSON", (segs[0]?.raw ?? "").includes('"imageSource"'));
  ok("混合拆分：结果段含 summary", (segs[1]?.raw ?? "").includes("_result_summary"));
}
{
  // 独立桥块（整块，终态由 zaiToolName 优先处理，这里验证 splitZaiText 也正确兜底）
  const { body, segs } = splitZaiText(ZAI_CALL + "\n" + ZAI_OUTPUT);
  ok("独立块拆分：body 空、段 2", body === "" && segs.length === 2);
}
{
  const { body, segs } = splitZaiText("普通正文，无桥文本。\n第二行。");
  ok("纯正文不拆", body.includes("普通正文") && segs.length === 0);
}
{
  // 误判防护：反引号包裹的格式讨论（整行非裸标记）
  const discuss = "讨论格式：`**🌐 Z.ai Built-in Tool: webReader**` 这样写会被识别。\n**Output:**\n这里没有 summary 键";
  const { body, segs } = splitZaiText(discuss);
  ok("反引号包裹的格式讨论不误拆", segs.length === 0, JSON.stringify(segs.map((s) => s.kind)));
  ok("Output 行无 summary 次行不误拆", body.includes("**Output:**"));
}
{
  // 流式半截：正文+调用标记行到达、Output 未到——调用段吞尾静默，正文保留
  const half = "先说结论。\n**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{\"a\":1}";
  const { body, segs } = splitZaiText(half);
  ok("流式半截：正文保留", body === "先说结论。", body);
  ok("流式半截：悬空调用段归工具日志", segs.length === 1 && segs[0].kind === "tool_use");
}
{
  // 围栏代码块内演示桥格式：属正文，不识别（防悬空段吞掉块后正文）
  const fenced = ["看这个格式：", "```", "**🌐 Z.ai Built-in Tool: webReader**", "**Output:**", '**webReader_result_summary:** [{"text":"x"}]', "```", "如上所示，继续正文。"].join("\n");
  const { body, segs } = splitZaiText(fenced);
  ok("围栏内桥格式不拆", segs.length === 0, JSON.stringify(segs.map((s) => s.kind)));
  ok("围栏内容与块后正文保留", body.includes("**🌐 Z.ai Built-in Tool: webReader**") && body.includes("继续正文"), body.slice(-30));
}
{
  // 混合：真实桥段（含 ```json 围栏包裹的 Input）与围栏正文共存——段内围栏不干扰跟踪
  const mix = ["先演示：", "```", "**🌐 Z.ai Built-in Tool: webReader**", "```", "然后真调一次。**🌐 Z.ai Built-in Tool: webReader**", "**Input:**", "```json", '{"url":"https://e.com"}', "```", "**Output:**", '**webReader_result_summary:** [{"text":"y"}]'].join("\n");
  const { body, segs } = splitZaiText(mix);
  ok("正文围栏后真实调用仍拆出", segs.length === 2, JSON.stringify(segs.map((s) => s.kind)));
  ok("正文围栏块保留且含演示标记", body.includes("先演示：") && body.includes("**🌐 Z.ai Built-in Tool: webReader**"));
}

console.log(fail === 0 ? "\n[test-zai] ALL PASS" : `\n[test-zai] FAIL x${fail}`);
process.exit(fail === 0 ? 0 : 1);
