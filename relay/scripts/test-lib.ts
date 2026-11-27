// DL-P1-9 配套：测试沙盒钉档标准入口（新测试一律从这里开始）。
// 用法（测试文件最顶、任何 src import 之前）：
//   import { pinSandbox } from "./test-lib.js";
//   const ROOT = pinSandbox("my-suite");
// pinSandbox 做三件事：
//   ① CCR_DATA_DIR/CCR_ORG_DIR 钉到 mkdtemp 沙盒（返回沙盒根，测试自管清理）；
//   ② 若外层已带 CCR_DATA_DIR（CI 复用/嵌套）不覆盖——显式优先；
//   ③ 防御性清掉可能从外层环境泄漏进来的生产指向变量。
// 既有 165 个已钉档测试零波及；未钉档旧测试由 src/test-data-guard.ts 硬闸兜底
//（开发机有生产安装时未钉即拒跑——1122 事故复发通道封死）。
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function pinSandbox(suite: string): string {
  const root = mkdtempSync(join(tmpdir(), `ccdeck-${suite}-`));
  if (!process.env.CCR_DATA_DIR) {
    process.env.CCR_DATA_DIR = join(root, "data");
    mkdirSync(process.env.CCR_DATA_DIR, { recursive: true });
  }
  if (!process.env.CCR_ORG_DIR) {
    process.env.CCR_ORG_DIR = join(root, "org");
    mkdirSync(process.env.CCR_ORG_DIR, { recursive: true });
  }
  return root;
}
