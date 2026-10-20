// W-SPLIT-S2（design-split-plan §3 阶段 2 ②）：标题派生/overrides 读取外迁。
// 只搬不改：readTitleOverrides 函数体逐字未动，仅 export+import 接线。
// 写面（:3012 处 title-overrides.json 写穿）留 session-manager（写路径非只读域）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readTitleOverrides(dataDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "title-overrides.json"), "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 40);
    }
    return out;
  } catch {
    return {};
  }
}
