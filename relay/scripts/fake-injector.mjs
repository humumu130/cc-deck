// 测试假注入器：CCR_INJECT_CMD 指向本文件，把参数逐行记到 CCR_INJECT_LOG
// pid=424242 时模拟 attach 失败（记完日志退出码 1 → injector 映射为 process-gone）
// --peek（防抢发快照）：CCR_FAKE_PEEK_FILE 提供屏幕内容时拷给快照文件（exit 0），
//   未设时模拟快照不可用（exit 1 → capture null → 守门 fail-open）；
//   CCR_FAKE_PEEK_CHAOS=1 时把模板里的 %T% 替换为当前时间戳——每次快照内容都不同，
//   确定性模拟"持续打字"（不依赖测试进程里会被事件循环饿死的定时器）
// 假 osascript（-e 脚本含 "return contents of t"）：同样回 CCR_FAKE_PEEK_FILE 内容
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.CCR_INJECT_LOG, JSON.stringify(args) + "\n");
if (args[0] === "424242") process.exit(1);
if (args[1] === "--peek") {
  if (!process.env.CCR_FAKE_PEEK_FILE) process.exit(1);
  try {
    if (process.env.CCR_FAKE_PEEK_CHAOS) {
      writeFileSync(args[2], readFileSync(process.env.CCR_FAKE_PEEK_FILE, "utf8").replaceAll("%T%", String(Date.now())));
    } else {
      copyFileSync(process.env.CCR_FAKE_PEEK_FILE, args[2]);
    }
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
if (args[0] === "-e" && String(args[1]).includes("return contents of t") && process.env.CCR_FAKE_PEEK_FILE) {
  try {
    process.stdout.write(readFileSync(process.env.CCR_FAKE_PEEK_FILE, "utf8"));
  } catch {}
}
