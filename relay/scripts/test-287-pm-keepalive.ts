// #287 PM 常驻化——保活判定纯函数行为级 + 接线源码锚 + 面板待命态锚。
// 断言口径（任务书）：PM 空闲不挂起（keep-alive）/新消息零 resume 冷启动/非 PM 不变/换届失效。
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-287-pm-keepalive.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pmKeepaliveEligible, PM_KEEPALIVE_DELAY_MS, PM_KEEPALIVE_MAX_IDLE_STREAK } from "../src/lifecycle/revive.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sm = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
const ty = readFileSync(join(root, "relay", "src", "types.ts"), "utf-8");
const ssd = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const mj = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const base = {
  envOff: undefined, reason: "stream closed", external: false, historical: false,
  isDutyTarget: true, resumePending: undefined, resumeCooldownUntil: undefined,
  now: 1_000_000, idleStreak: 0,
};

console.log("#287 PM 常驻化——保活判定（pmKeepaliveEligible 行为级）");

ok(pmKeepaliveEligible({ ...base }) === true, "K1 快乐路径：dutyTarget 托管会话自然空闲关闭 → 保活");
ok(pmKeepaliveEligible({ ...base, envOff: "0" }) === false, "K2 逃生阀 CCR_PM_KEEPALIVE=0 不保活（测试/紧急关停）");
ok(pmKeepaliveEligible({ ...base, reason: "stopped" }) === false, "K3 用户停止（stopped）不保活——非自然空闲退出");
ok(pmKeepaliveEligible({ ...base, external: true }) === false, "K4 外部会话不保活（终端自管）");
ok(pmKeepaliveEligible({ ...base, historical: true }) === false, "K5 historical 弃档态不保活");
ok(pmKeepaliveEligible({ ...base, isDutyTarget: false }) === false, "K6 非 dutyTarget 不保活（非 PM 会话行为不变——worker 空闲照常驻档）");
ok(pmKeepaliveEligible({ ...base, resumePending: Date.now() }) === false, "K7 #189 换流互斥窗内不拉（防双流）");
ok(pmKeepaliveEligible({ ...base, resumeCooldownUntil: base.now + 60_000 }) === false, "K8 W-LEADFIX 熔断冷却期不拉（自动路径让位，手动不受限——resumeAgent 原口径）");
ok(pmKeepaliveEligible({ ...base, resumeCooldownUntil: base.now - 1 }) === true, "K9 冷却已过期恢复资格");
ok(pmKeepaliveEligible({ ...base, idleStreak: PM_KEEPALIVE_MAX_IDLE_STREAK }) === false, "K10 死循环闸：连续无活动退出达上限停拉");
ok(pmKeepaliveEligible({ ...base, idleStreak: PM_KEEPALIVE_MAX_IDLE_STREAK - 1 }) === true, "K11 未达上限仍可拉（首次空转退出后再给一次机会）");
ok(PM_KEEPALIVE_DELAY_MS === 3_000 && PM_KEEPALIVE_MAX_IDLE_STREAK === 2, "K12 参数锚：3s 延时 + 2 次上限");

console.log("#287 接线（session-manager/types 源码锚）");

ok(sm.includes("this.schedulePmKeepalive(managed, reason);") && sm.indexOf("this.schedulePmKeepalive(managed, reason);") > sm.indexOf("onSessionEnd: (reason) => {"),
  "W1 主 onSessionEnd 尾挂保活调度（自然关闭收口后）");
ok(sm.includes("private schedulePmKeepalive") && sm.includes("if (!check()) return; // 换届/熔断/互斥在火时重查"),
  "W2 调度体：schedule 与 fire 双查同源（3s 窗内换届/删除/竞态全防）");
ok(sm.includes("if (s.agent && !s.agent.ended) return; // 调度窗内消息先到"),
  "W3 fire 时活流在场不扰（消息先到=用户意图优先，不换流）");
ok(sm.includes("managed.pmKeepaliveStreak = 0; // #287 回合真实跑过"),
  "W4 onTurnEnd 复位死循环闸（回合有效=拉起有功）");
ok(sm.includes("clearTimeout(s.pmKeepaliveTimer); s.pmKeepaliveTimer = null; }"),
  "W5 deleteSession 清保活 timer（防删后幽灵拉起）");
ok(sm.includes("c.pm_standby = !!(dutyId && c.session_id === dutyId && c.status === \"DONE\");"),
  "W6 快照派生 pm_standby（dutyTarget∧DONE→待命；零存储 flag 无陈旧面——换届自动失效）");
ok(ty.includes("pm_standby?: boolean;"),
  "W7 SessionState 类型补 pm_standby 可选位");
ok(sm.includes("pmKeepaliveStreak: 0,") && (sm.match(/pmKeepaliveStreak: 0,/g) || []).length >= 3,
  "W8 三处会话创建字面量全初始化保活账（缺一=undefined 崩判定）");

console.log("#287 面板待命态（web-console 源码锚）");

ok(ssd.includes("pmStandby: session.pm_standby === true") && ssd.includes("值守 PM 常驻待命"),
  "P1 桌面卡：myCardItem 透传 + r2 行「待命」tag（替代 DONE 假死——活跃/待命连续态对齐 #276）");
ok(mj.includes('s.pm_standby ? ["待命", "waiting"]'),
  "P2 移动卡：stTag 待命二态（waiting 色系）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
