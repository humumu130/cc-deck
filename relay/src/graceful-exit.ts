// W-RELDEATH（DEV-18 P0-A 随批）：SIGTERM/SIGINT 告别行——治「静默死」排障盲区。
// 背景（2026-11-24 生产事故）：换装脚本 kill relay 后，旧 shutdownDiag 只在「有活派单」
// 时才打印——无活单的 SIGTERM 退出零留痕，embedded-relay.log 尾部看不出进程是何时、
// 因何信号死的（当夜排障只能靠 mtime+外部日志倒推）。治法：告别行无条件打一行（信号
// +pid+活派单计数），活派单明细维持原有逐一列行。纯函数抽出为的是可测（test:graceful-exit）。
// SIGKILL 无法捕获，仍是静默死——本行只覆盖 SIGTERM/SIGINT 面。

/** 派单账最小面（readDispatchLog 行的子集——结构性兼容，避免硬耦合 org 类型） */
export interface GracefulDispatchRow { id?: string; status?: string; title?: string }

/**
 * 生成告别日志行。entries=null 表示派单账不可读（读侧异常降级——告别行仍打，计数位
 * 标「账不可读」而不是误导性的 0）。
 */
export function gracefulExitLines(sig: string, pid: number, entries: GracefulDispatchRow[] | null): string[] {
  const active = (entries ?? []).filter((r) => r.status === "dispatched" || r.status === "running");
  const countText = entries === null ? "派单账不可读" : `活派单 ${active.length}`;
  const lines = [`[graceful] 收到 ${sig}，relay 退出（pid=${pid}，${countText}）`];
  if (active.length > 0) {
    lines.push(`  （重启后 reloadDispatchQueue 恢复排队）：`);
    for (const a of active) lines.push(`  · ${a.id ?? "?"} [${a.status ?? "?"}] ${a.title ?? ""}`);
  }
  return lines;
}
