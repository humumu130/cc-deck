// W-DOCKIDLE 断言档（1108 用户实锤：输入框上方状态栏空闲态绿行常驻）。
// 定罪链：relay applyActivity 终态冻结（session-manager.ts「终态（DONE/ERROR）下整体
// 冻结：不覆写」）→ 空闲会话 activity.state 滞留收口前最后帧（常为 WORKING）→ 旧渲染
// 条件 `dock && s.status !== "WORKING"`（只排 WORKING）把冻结残影整条渲染 → WORKING
// 映射 c.done 绿 #35DC97 → 「空闲的时候一直显示一个绿色的什么什么」。
// 修复：dockModelOf 终态不入舱（两活态白名单）+渲染闸 dockLineVisible 锚会话级真相
// （仅 WAITING）双防线。纯函数已迁驻 ../src/status-dock（零 RN 依赖，本档可直 import
// ——notify-jump 先例；此前寄居 DetailScreen 无法被 node 测试 import）。
// 直跑：node --import tsx scripts/test-dockidle.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closingBarOf, DONE_TAIL_MS, dockLineVisible, dockModelOf } from "../src/status-dock";
import type { SessionState, SessionStatus } from "../src/protocol";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log(`  ok ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

const here = dirname(fileURLToPath(import.meta.url));
const dsSrc = readFileSync(join(here, "../src/screens/DetailScreen.tsx"), "utf8");

const CAPS = { native_status: true, operation_summary: true, native_elapsed: true } as const;
/** 最小会话夹具：status=会话级真相；activityState=activity 投影（终态冻结残影可任意） */
function mkS(status: SessionStatus, activityState?: string, over: Record<string, unknown> = {}): SessionState {
  return {
    session_id: "s1",
    status,
    ...(activityState
      ? {
          activity: {
            state: activityState,
            updated_at: 1_700_000_000_000,
            activity: { kind: "tool_use", text: "正在读 config.json", tool: "Read" },
            task_summary: { text: "排查空闲绿行" },
            elapsed_ms: 42_000,
            capabilities: CAPS,
          },
          activity_capabilities: CAPS,
        }
      : {}),
    ...over,
  } as unknown as SessionState;
}

console.log("== W-DOCKIDLE：空闲态绿行常驻（修前复现→修后净空）==");

console.log("A dockModelOf 投影（终态不入舱——修复面）：");
ok(dockModelOf(mkS("WORKING", "WORKING"))?.state === "WORKING", "A1 WORKING 活态入舱（icon ✶）");
ok(dockModelOf(mkS("WAITING", "WAITING"))?.state === "WAITING", "A2 WAITING 活态入舱");
ok(dockModelOf(mkS("DONE", "DONE")) === null, "A3 DONE 终态不入舱（修复点——旧四态全过）");
ok(dockModelOf(mkS("ERROR", "ERROR")) === null, "A4 ERROR 终态不入舱（修复点）");
ok(dockModelOf(mkS("DONE")) === null, "A5 activity 缺失→null（原语义回归）");
ok(dockModelOf({ ...mkS("WORKING", "WORKING"), activity: { ...((mkS("WORKING", "WORKING").activity)!), capabilities: {}, state: "WORKING", updated_at: 0 } as never, activity_capabilities: undefined } as never) === null, "A6 native_status 能力关→null（原语义回归）");
const wm = dockModelOf(mkS("WORKING", "WORKING"));
ok(wm?.actText === "正在读 config.json" && wm?.actKind === "tool_use" && wm?.actTool === "Read" && wm?.elapsedMs === 42_000, "A7 operation_summary/native_elapsed 门控填充（活态原路径零变化）");

console.log("B dockLineVisible 渲染闸（锚会话级真相——新防线）：");
const wkDock = dockModelOf(mkS("WAITING", "WORKING"))!; // 等确认时底层活动在跑（活态形状）
ok(dockLineVisible(wkDock, "WAITING") === true, "B1 WAITING 会话→显示（等确认=工作范畴，用户口径「工作时正常」）");
ok(dockLineVisible(dockModelOf(mkS("WORKING", "WORKING")), "WORKING") === false, "B2 WORKING 会话→不显示（dockWork 黄行承载，零回归）");
ok(dockLineVisible(dockModelOf(mkS("DONE", "WORKING")), "DONE") === false, "B3 DONE 会话→净空（**空闲绿行根治断言**）");
ok(dockLineVisible(dockModelOf(mkS("ERROR", "WORKING")), "ERROR") === false, "B4 ERROR 会话→不显示（StatusStrip ⚠ 常驻承载）");
ok(dockLineVisible(null, "WAITING") === false, "B5 投影 null→不显示");

console.log("C 冻结残影形态（1108 实锤场景：修前常驻复现 vs 修后净空对照）：");
// 修前渲染谓词复刻（git 史实：`dock && s.status !== "WORKING"`）
const oldVisible = (dock: unknown, status: string) => !!dock && status !== "WORKING";
const frozenWork = dockModelOf(mkS("DONE", "WORKING")); // relay 终态冻结→残影是活态形状
const frozenWait = dockModelOf(mkS("DONE", "WAITING"));
ok(!!frozenWork && oldVisible(frozenWork, "DONE") === true, "C1 修前复现①：DONE 会话+activity 冻结 WORKING → 旧谓词渲染=true（绿点 ✶ c.done #35DC97+陈文本整条常驻——定罪帧）");
ok(dockLineVisible(frozenWork, "DONE") === false, "C2 修后净空①：同输入新闸=false（残影不再外显——修复帧）");
ok(!!frozenWait && oldVisible(frozenWait, "DONE") === true && dockLineVisible(frozenWait, "DONE") === false, "C3 复现②/净空②：冻结 WAITING 残影同病同治");
ok(dockModelOf(mkS("DONE", "DONE")) === null, "C4 陈旧 DONE 残影：投影层已滤（终态不入舱，双防线第一道）");
// 恒新 updated_at 形态（任务书疑点链②）：relay 终态不覆写→updated_at 不可能恒新；
// 若真恒新也只影响 DONE 尾窗长度（closingBarOf 设计行为），不产生绿工作行
const T = 1_700_000_000_000;
const freshDone = mkS("DONE", "DONE", {}) as SessionState & { activity: { updated_at: number } };
freshDone.activity.updated_at = T - 3000; // 尾窗内 3s（「恒新」极端化=updated_at 恒贴 now，尾窗恒开——closingBarOf 设计域）
ok(dockModelOf(freshDone) === null && dockLineVisible(null, "DONE") === false, "C5 恒新形态：投影 null（无绿行）；尾窗行为归 closingBarOf 设计域（StatusStrip ✓ 8s，非本病灶）");

console.log("D closingBarOf 回归（StatusStrip 收口条零变化）：");
ok(closingBarOf(mkS("ERROR") as never, T)?.kind === "error", "D1 ERROR 会话→⚠ 收口条常驻（last_error 承载）");
ok(closingBarOf(freshDone, T)?.kind === "done" && closingBarOf(freshDone, T)?.text === "本轮已完成", "D2 DONE+activity DONE+窗内→✓ 本轮已完成");
ok(closingBarOf(mkS("DONE", "DONE", { activity: { state: "DONE", updated_at: T - (DONE_TAIL_MS + 1000), capabilities: CAPS } as never, activity_capabilities: CAPS } as never), T) === null, "D3 超尾窗 8s→自隐（净空）");
ok(closingBarOf(mkS("DONE", "DONE", { activity: { state: "DONE", updated_at: T + 5000, capabilities: CAPS } as never, activity_capabilities: CAPS } as never), T) === null, "D4 时钟错位（age<0）→null 保护");
ok(closingBarOf(mkS("WAITING", "WAITING"), T) === null, "D5 WAITING 会话→无收口条（不误出）");
ok(dockLineVisible(dockModelOf(mkS("WORKING", "WORKING")), "DONE") === false, "D6 WORKING 投影配 DONE 会话（错位组合）→闸拦（真相优先）");

console.log("E 接线静态锚（渲染面真接上，防改丢）：");
ok(dsSrc.includes("dockLineVisible(dock, s.status)"), "E1 渲染闸真接线（JSX 条件走纯函数）");
ok(!dsSrc.includes('s.status !== "WORKING" ? (\n          <View style={[d.dockLine'), "E2 旧裸条件已退役（dockLine 不再只排 WORKING）");
ok(dsSrc.includes('dock && dockLineVisible(dock, s.status) ? (') && dsSrc.includes('<View style={[d.dockLine, { borderLeftColor: dockColor }]}'), "E3 闸后即 dockLine 容器（dock&& 前置窄化+接线位置正确）");
ok(dsSrc.includes('s.status === "WORKING" ? (\n          <View style={d.dockWork}'), "E4 dockWork 黄行条件不动（WORKING 零回归锚）");
ok(!dsSrc.includes("dock.state === \"DONE\" ? c.brandHover"), "E5 dockColor 终态死分支已清（两活态配色）");
ok(dsSrc.includes("export { closingBarOf, dockModelOf, dockLineVisible, DONE_TAIL_MS } from \"../status-dock\""), "E6 DetailScreen re-export 兼容面在");

console.log(`\n== test-dockidle：${pass} passed / ${fail} failed ==`);
process.exit(fail ? 1 : 0);
