// W-SPLIT-S3c：通知域命令 mixin（case 体逐字搬出，仅 this.→mgr.）。
// 样板同 S3R2c/S3a（any 网关跨 private/payload 边界；行为等价由
// test-dispatch + check-behavior-parity 锁）。TASK_CREATE/UPDATE/DISPATCH
// 三命令共享一体（board-commands 内单函数，三 case 标签同委托）。
export function createNotifyCommands(mgr: any) {
  return {
    COMMAND_NOTIFICATION_ACK(cmd: any, by: string): any {
          // #018-R1c 通知生命周期（B0 冻结 action 词表 handled|dismissed；resolved
          // 由来源事件驱动不经此）。幂等：已 resolved 的账 ok 不复活；未知 key 拒收
          if (typeof cmd.payload.notification_key !== "string" || !cmd.payload.notification_key) {
            return { command_id: cmd.command_id, ok: false, error: "notification_key 必填" };
          }
          const r = mgr.notificationAck(cmd.payload.notification_key, cmd.payload.action);
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
    },
  };
}
