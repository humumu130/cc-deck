// #212 W-SESSLABEL —— 会话标题读 Claude Code 自带 ai-title/custom-title（session-title.ts）
// 纯函数面直跑断言：行识别（预过滤/畸形宽容/assistant 行防误命中）+ 批量扫描（后行覆盖/
// custom>ai 优先级链）+ 编码目录定位（mac/Windows/点段）+ cwd+sessionId 文件定位（直查/
// mtime 兜底/目录缺失 null）+ 真实形态回归锁（任务书 includes('"title"') 过滤实测漏抓的
// 陷阱断言，防回退）。fixture 形态按 2026-10-22 本机 ~/.claude/projects 一手抽样。
// 隔离口径：文件定位面全走 mkdtemp 假 home（home 参数），绝不触生产 ~/.claude/projects。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodedProjectDir, resolveSessionTitleFile, scanTitleText, titleFromLine } from "../src/session-title.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-sesslabel-${tag}-`));
const dirs: string[] = [];

// 真实形态样本（本机一手抽样，中文标题=乱码教训回归载体）
const AI_LINE = `{"type":"ai-title","aiTitle":"设计文档可靠性边界审查","sessionId":"02159bf3-b2fa-4c32-b07f-90faadafe34c"}`;
const CUSTOM_LINE = `{"type":"custom-title","customTitle":"手改名会话"}`;

// ---------- S0 行识别：预过滤/字段/畸形/防误命中 ----------
section("\nS0 titleFromLine 行识别（预过滤/字段提取/畸形宽容/防误命中）");
{
  const ai = titleFromLine(AI_LINE);
  assert(!!ai && ai.ai === "设计文档可靠性边界审查" && ai.custom === undefined, "ai-title 行 → {ai}（中文不乱码）");
  const cu = titleFromLine(CUSTOM_LINE);
  assert(!!cu && cu.custom === "手改名会话" && cu.ai === undefined, "custom-title 行 → {custom}");
  // 任务书口径陷阱锁：includes('"title"') 对真实 ai-title 行实测 false——预过滤必须
  // 用类型词（ai-title/custom-title），此断言防「优化回退」重蹈
  assert(!AI_LINE.includes('"title"'), "真实 ai-title 行不含 '\"title\"' 子串（任务书过滤口径陷阱锁）");
  assert(!!titleFromLine(AI_LINE), "类型词预过滤命中真实 ai-title 行");
  // CLI 写紧凑 JSON；带空格的第三方形态宽容两吃
  assert(!!titleFromLine(`{"type": "custom-title", "customTitle": "空格形态"}`), "带空格形态宽容命中");
  assert(titleFromLine(`{"type":"assistant","message":{"content":[{"type":"text","text":"提到 ai-title 字样"}]}}`) === undefined, "assistant 行含标题字样不误命中（parse 后 type 不符）");
  assert(titleFromLine(`{"type":"ai-title","aiTitle":""}`) === undefined, "空串 aiTitle 忽略");
  assert(titleFromLine(`{"type":"ai-title"}`) === undefined, "缺 aiTitle 字段忽略");
  assert(titleFromLine(`{"type":"ai-title","aiTitle":` /* 截断半行 */) === undefined, "畸形半行 parse 失败静默跳过");
  assert(titleFromLine(`null`) === undefined, "null 行跳过");
  assert(titleFromLine(`[1,2]`) === undefined, "数组行跳过");
}

// ---------- S1 批量扫描：后行覆盖/custom>ai ----------
section("\nS1 scanTitleText 批量扫描（后行覆盖/custom>ai/真实转录混排）");
{
  const two = scanTitleText(`${AI_LINE}\n{"type":"ai-title","aiTitle":"换任务后的新标题","sessionId":"x"}`);
  assert(two.ai === "换任务后的新标题", "同类型后行覆盖（换任务 aiTitle 更新语义）");
  const mix = scanTitleText(`{"type":"ai-title","aiTitle":"自动标题"}\n${CUSTOM_LINE}`);
  assert(mix.custom === "手改名会话" && mix.ai === "自动标题", "custom 与 ai 并存各自保留（取用层 custom||ai）");
  const late = scanTitleText(`${CUSTOM_LINE}\n{"type":"custom-title","customTitle":"再改一次"}`);
  assert(late.custom === "再改一次", "custom 后行覆盖（最后一次 /rename 权威）");
  assert(scanTitleText("").ai === undefined && scanTitleText("").custom === undefined, "空文本零命中");
  // 真实转录混排：assistant/user/summary 行间夹标题行，互不干扰
  const real = scanTitleText([
    `{"type":"user","message":{"content":"帮我看下 title 生成"},"timestamp":"2026-10-22T10:00:00.000Z"}`,
    AI_LINE,
    `{"type":"assistant","message":{"content":[{"type":"text","text":"好的"}]},"timestamp":"2026-10-22T10:00:01.000Z"}`,
    `{"type":"summary","summary":"旧版摘要行","leafUuid":"x"}`,
  ].join("\n"));
  assert(real.ai === "设计文档可靠性边界审查" && real.custom === undefined, "真实转录混排只取标题行");
}

// ---------- S2 编码目录名 ----------
section("\nS2 encodedProjectDir（mac/Windows/点段/连字符保留）");
{
  assert(encodedProjectDir("/Users/xdd/dev/cc-deck") === "-Users-xdd-dev-cc-deck", "mac 绝对路径（/ → -，首字符含）");
  assert(encodedProjectDir("D:\\code\\pcs-cloud") === "D--code-pcs-cloud", "Windows 盘符路径（:\\ → --，任务书样本）");
  assert(encodedProjectDir("/a/.claude/worktrees/x") === "-a--claude-worktrees-x", "点段转 '-'（.claude → -claude，实测目录吻合）");
  assert(encodedProjectDir("/keep-here") === "-keep-here", "已有连字符保留不动");
  assert(encodedProjectDir("/中文/目录".replace(/[^A-Za-z0-9-]/g, "-")) === encodedProjectDir("/中文/目录"), "非 ASCII 逐字符替换（函数自洽）");
}

// ---------- S3 cwd+sessionId 文件定位（假 home 隔离） ----------
section("\nS3 resolveSessionTitleFile（直查/mtime 兜底/目录缺失/空参）");
{
  const home = mkDir("s3");
  dirs.push(home);
  const projDir = join(home, ".claude", "projects", encodedProjectDir("/Users/xdd/dev/cc-deck"));
  mkdirSync(projDir, { recursive: true });
  const fA = join(projDir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
  const fB = join(projDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
  writeFileSync(fA, AI_LINE, "utf-8");
  writeFileSync(fB, CUSTOM_LINE, "utf-8");
  utimesSync(fA, new Date(1000), new Date(1000));
  utimesSync(fB, new Date(2000), new Date(2000));
  const hit = resolveSessionTitleFile({ cwd: "/Users/xdd/dev/cc-deck", sessionId: "aaaaaaaa-0000-0000-0000-000000000001", home });
  assert(hit === fA, "sessionId 直查命中 <encoded>/<sessionId>.jsonl");
  const fallback = resolveSessionTitleFile({ cwd: "/Users/xdd/dev/cc-deck", sessionId: "ffffffff-0000-0000-0000-000000000000", home });
  assert(fallback === fB, "直查 miss → 同编码目录 mtime 最新兜底");
  assert(resolveSessionTitleFile({ cwd: "/no/such/dir", sessionId: "x", home }) === null, "编码目录不存在 → null（不越目录全局扫）");
  assert(resolveSessionTitleFile({ cwd: "", sessionId: "x", home }) === null, "空 cwd → null");
  assert(resolveSessionTitleFile({ cwd: "/a", sessionId: "", home }) === null, "空 sessionId → null");
  // 空 .jsonl 目录：无候选 → null
  const emptyDir = join(home, ".claude", "projects", encodedProjectDir("/empty/proj"));
  mkdirSync(emptyDir, { recursive: true });
  assert(resolveSessionTitleFile({ cwd: "/empty/proj", sessionId: "x", home }) === null, "目录无 .jsonl 候选 → null");
}

// ---------- 清理 + 结果 ----------
for (const d of dirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\n===== W-SESSLABEL 测试结果：${pass} pass / ${fail} fail =====`);
process.exit(fail > 0 ? 1 : 0);
