// #263 单元测试：z.ai 内置工具桥文本分类（离线，不需要 relay 运行）。
// 用法: npx tsx scripts/test-zai.ts
import { zaiToolName, isZaiOutput, zaiBridgePrefix, capDetail } from "../src/summarizer.js";

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

console.log(fail === 0 ? "\n[test-zai] ALL PASS" : `\n[test-zai] FAIL x${fail}`);
process.exit(fail === 0 ? 0 : 1);
