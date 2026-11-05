// bootfast3 修后验收 mutate：真实写面写入（走 advance 链——模拟上一实例运行期 org 写）
// 用法：CCR_ORG_DIR/CCR_DATA_DIR 指沙盒后 tsx 本文件——writeOrgAnchor 改锚（写面+checkpoint 推进）
import { writeOrgAnchor } from "../src/org.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const orgDir = process.env.CCR_ORG_DIR!;
const f = join(orgDir, "org.json");
const raw = JSON.parse(readFileSync(f, "utf8"));
const ok = writeOrgAnchor({ ...raw, note: "mutate-" + Date.now() }, orgDir);
console.log(`mutate writeOrgAnchor ok=${ok}`);
