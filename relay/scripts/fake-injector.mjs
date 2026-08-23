// 测试假注入器：CCR_INJECT_CMD 指向本文件，把参数逐行记到 CCR_INJECT_LOG
// pid=424242 时模拟 attach 失败（记完日志退出码 1 → injector 映射为 process-gone）
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.CCR_INJECT_LOG, JSON.stringify(args) + "\n");
if (args[0] === "424242") process.exit(1);
