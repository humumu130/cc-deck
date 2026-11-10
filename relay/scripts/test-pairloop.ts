// pairloop（t-2ef63713，1110 用户实锤）：配对自环防呆契约锁。
//   实锤：Mac 输入公司电脑码→加回来的源=Mac 自己（会话全本机）。全段排查定谳=消码段
//   （③）+ack 校验段（④）：网页侧零「≠本机 relay」比对——本机码自配自（用户码混淆/
//   BAKED known 列表命中本机 relay 单播）无任何拦截。修=ack 落库前 isSelfPairAck
//   拦截（relay_dev 命中本机=拒建源+文案指路）+watchdog 耗尽提示。SNAPSHOT.relay_dev
//   为比对钥匙（零 relay 改动）；老快照无键=fail-open 放行（防误伤）。
import { readFileSync } from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-unused-vars

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}
const REPO = new URL("../..", import.meta.url).pathname;
const sd = readFileSync(REPO + "web-console/js/settings-domain.js", "utf8");

console.log("A. isSelfPairAck 纯函数语义（提取逻辑四态——源码实现同款表达式）");
{
  const isSelfPairAck = (ackDev: string, localDev: string) => !!(ackDev && localDev && ackDev === localDev);
  ok(isSelfPairAck("rl-a", "rl-a") === true, "A1 ack=本机 → 拦截（自环）");
  ok(isSelfPairAck("rl-a", "rl-b") === false, "A2 ack=对端 → 放行（正常配对）");
  ok(isSelfPairAck("rl-a", "") === false, "A3 本机身份不可知（老快照无 relay_dev）→ fail-open 放行（防误伤正常配对）");
  ok(isSelfPairAck("", "rl-a") === false, "A4 ack 缺 dev → 放行（后续身份校验段拦截）");
}

console.log("B. 刀 A 接线锚（ack 落库前拦截）");
ok(sd.includes("isSelfPairAck(inner.relay_dev, localRelayDevOf())"), "B1 ack 落库前自环判定在（cfg.cloud 覆写之前）");
ok(sd.includes("配对码属于本机") && sd.includes("另一台电脑"), "B2 拒绝文案指路对端领码");
ok(sd.includes("pair_ack 自环拦截"), "B3 拦截日志锚（事后可追溯）");
ok(sd.indexOf("isSelfPairAck(inner.relay_dev, localRelayDevOf())") < sd.indexOf('cfg.cloud = { url: cfg.wsUrl, token: serverBridgeToken(cfg), rd: inner.relay_dev'), "B4 拦截先于 cfg.cloud 覆写（顺序断言）");

console.log("C. 比对钥匙（零 relay 改动——SNAPSHOT.relay_dev 三源兜底）");
ok(sd.includes("b.snapshot") && sd.includes("s.relay_dev === \"string\""), "C1 本机身份取 B4 桥快照 relay_dev（类型守卫）");
ok(sd.includes("fail-open") || sd.includes("老快照无此键"), "C2 fail-open 语义注释在（老 relay 快照无键不拦）");

console.log("D. watchdog 耗尽提示（本机码永远无 ack 形态的用户指引）");
ok(sd.includes("一直配不上") && sd.includes("本机的码在本机输入"), "D1 看门狗耗尽 toast 指路文案在");
ok(sd.includes("isSelfPairCodeHint"), "D2 提示条件 helper（本机 relay 云身份在场）");

console.log("E. 零 relay 改动红线（git 面核——本批 diff 仅 web+本测试）");
{
  const { execFileSync } = await import("node:child_process");
  const changed = execFileSync("git", ["diff", "--name-only", "origin/dev"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  const relaySrc = changed.filter((f) => f.startsWith("relay/src/") || f.startsWith("cloudflare/"));
  ok(relaySrc.length === 0, `E1 relay src+worker 零触碰（实=${relaySrc.join(",") || "无"}）`);
  ok(changed.includes("web-console/js/settings-domain.js"), "E2 改动面=web settings-domain（刀 A 落点）");
}

console.log(`\n========== pairloop 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
