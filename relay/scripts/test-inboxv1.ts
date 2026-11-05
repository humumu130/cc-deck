// W-INBOX-V1（收件箱最小切片三刀）断言：
//   刀1 ×双钮：active 行「知道了/稍后」双钮（× 退役）；snooze relay 锚（B0 词表扩
//     snooze——notificationAck/snoozed_until 持久化+钳位+收口清锚）
//   刀2 行键归一：synth 行键=pua[].key（stableKey 同口径）+同键让位（channel 行在场
//     synth 不复活）；canAck/dismiss ACK 条件扩 ledgerKey
//   刀3 已归档分区：账面 handled/dismissed&&!resolved 行+本地 × 行进「已归档」可找回
//     （恢复钮=本地撤销；反账重开不在 V1 词表）
// 混合形态：transitionNotification 纯函数真跑 + 源码静态锚（notify.js/bridge-core/
//   session-manager/notify-commands/types）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transitionNotification, type NotificationLifecycleItem } from "../src/decision-notify.js";

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

const js = readFileSync(join(repoRoot, "web-console/js/notify.js"), "utf-8");
const bridge = readFileSync(join(repoRoot, "web-console/js/bridge-core.js"), "utf-8");
const sm = readFileSync(join(repoRoot, "relay/src/session-manager.ts"), "utf-8");
const cmds = readFileSync(join(repoRoot, "relay/src/commands/notify-commands.ts"), "utf-8");
const types = readFileSync(join(repoRoot, "relay/src/types.ts"), "utf-8");

async function main() {
  // ---------- A transitionNotification 纯函数（snooze 锚语义） ----------
  section("\nA snooze 锚纯函数（transitionNotification）：");
  const base: NotificationLifecycleItem = { key: "dispatch:x", kind: "dispatch", group: "action", severity: "waiting", title: "t", body: "", sourceContext: { domain: "org", entityId: "x", alertId: "dispatch:x", returnPath: "" }, actionable: true, created_at: 1000 };
  const at = 10_000;
  {
    const s = transitionNotification(base, "snoozed", at, at + 60_000);
    assert(s.snoozed_until === 70_000, "A1 snoozed 落锚（snoozed_until=调用方 until——纯函数不猜时长）");
    assert(s.handled_at === undefined && s.dismissed_at === undefined && s.resolved_at === undefined, "A2 snooze 非终态（handled/dismissed/resolved 全空）");
    const h = transitionNotification(s, "source_succeeded", at + 1000);
    assert(h.handled_at === 11_000 && h.snoozed_until === undefined, "A3 handled 收口清锚（账终态>暂避——锚不残留）");
    const s2 = transitionNotification(base, "snoozed", at, at + 60_000);
    const d = transitionNotification(s2, "dismissed", at + 2000);
    assert(d.dismissed_at === 12_000 && d.snoozed_until === undefined, "A4 dismissed 收口同清锚");
    const r = transitionNotification({ ...base, resolved_at: at }, "snoozed", at + 3000, at + 90_000);
    assert(r.snoozed_until === undefined, "A5 已 resolved 行不可 snooze（无「回箱」语义）");
    const bad = transitionNotification(base, "snoozed", at, at - 1000);
    assert(bad.snoozed_until === undefined, "A6 过期 until 拒落（until>at 才有效——防倒锚恒隐藏）");
  }

  // ---------- B relay 侧静态锚（notificationAck B0 扩项+钳位+命令层透传） ----------
  section("\nB relay 侧锚：");
  assert(sm.includes('"handled" | "dismissed" | "snooze"'), "B1 notificationAck B0 词表含 snooze（扩一项）");
  assert(sm.includes("Math.max(60_000, Math.min(24 * 3600_000"), "B2 snooze_ms 钳位 1 分钟..24 小时（缺省 30 分钟）");
  assert(sm.includes('"snoozed", Date.now(), until'), "B3 snooze 落账走 transitionNotification snoozed（持久+投影双发）");
  assert(cmds.includes("snooze_ms"), "B4 命令层 snooze_ms 透传（COMMAND_NOTIFICATION_ACK payload）");
  assert(types.includes("snoozed_until?: number"), "B5 NotificationItem.snoozed_until 字段（投影下发面）");

  // ---------- C web 侧静态锚（三刀主体） ----------
  section("\nC web 侧锚：");
  assert(js.includes('const snoozeBtn = row.active && !row.archived'), "C1 刀1 active 行稍后钮（归档行不出——乐观窗防错钮）");
  assert(js.includes('const x = row.active ? "" :'), "C2 刀1 × 只留非 active 行（active 行一键蒸发退役）");
  assert(js.includes('puaKeyOf("org-confirm", confirm.id) || "confirm:" + confirm.id'), "C3 刀2 org-confirm synth 键=pua[].key（stableKey 同口径，pua 缺席回落旧键）");
  assert(js.includes('bridge.notifications.some((n) => n.key === cKey)'), "C4 刀2 同键让位（channel 行在场 synth 整行不建——handled 后不复活 active 的根）");
  assert(js.includes('row.ledgerKey === true'), "C5 刀2 canAck/ACK 条件扩 ledgerKey（synth 归一后 ACK 可落账）");
  assert(js.includes('ledgerArchivedKey'), "C6 刀3 账面归档判定（handled/dismissed 且未 resolved）");
  assert(js.includes('data-notify-arch-toggle') && js.includes("已归档"), "C7 刀3 已归档分区组头（独立折叠态）");
  assert(js.includes('data-notify-restore'), "C8 刀3 恢复钮（本地 × 撤销——可找回）");
  assert(js.includes("scheduleSnoozeWake"), "C9 刀1 wake timer（到点自动回箱——最早到期+300ms 一拍重渲）");
  assert(bridge.includes("snoozed_until: item.snoozed_until"), "C10 bridge 归一透传 snoozed_until（端上消费 relay 锚）");

  console.log(`\n== test-inboxv1：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

void main();
