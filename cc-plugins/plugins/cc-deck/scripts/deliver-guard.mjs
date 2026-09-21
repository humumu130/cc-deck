#!/usr/bin/env node
// 交付物兜底登记（2026-09-21 用户拍板：deliver 从「自觉纪律」升级为「hook 强制」——
// 起因：设置抽屉 mockup 写完忘了登记，规则只活在 CLAUDE.md 里靠自觉）。
// PostToolUse(Write|Edit) 后，凡 Claude 写入项目 docs/ 的文档类文件，自动调
// ~/.cc-deck/bin/deliver 登记到看板——同路径幂等合并（relay registerDeliverable），
// 重复触发无堆积。三个防御保证零打扰：
// ① 路径过滤——路径含 docs/ 段 + 文档扩展名白名单才登记（代码/配置天然不匹配；
//    ~/.cc-deck/artifacts/ 有「写进去=自动收录」机制且路径无 docs 段，不会重复登记）
// ② deliver 脚本不存在（未装 cc-deck relay 的机器）直接退出
// ③ 登记失败静默退出——兜底机制不许打断主流程，看板漏了手动 deliver 补即可
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DOC_EXT = new Set([
  "md", "markdown", "html", "htm", "pdf", "txt",
  "png", "jpg", "jpeg", "svg", "gif", "webp",
  "csv", "xlsx", "docx", "pptx",
]);

let evt;
try { evt = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const raw = evt?.tool_input?.file_path ?? evt?.tool_response?.filePath;
if (typeof raw !== "string" || raw === "") process.exit(0);
const p = path.resolve(raw);
if (!p.split(path.sep).includes("docs")) process.exit(0);
const ext = path.extname(p).slice(1).toLowerCase();
if (!DOC_EXT.has(ext)) process.exit(0);
if (!existsSync(p)) process.exit(0);
const bin = path.join(os.homedir(), ".cc-deck", "bin", "deliver");
if (!existsSync(bin)) process.exit(0);
try { spawnSync(bin, [p], { timeout: 8000, stdio: "ignore" }); } catch {}
process.exit(0);
