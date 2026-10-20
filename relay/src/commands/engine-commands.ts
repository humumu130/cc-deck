// W-SPLIT-S3c：引擎登录域命令 mixin（case 体逐字搬出，仅 this.→mgr.）。
// 样板同 S3R2c/S3a（any 网关跨 private/payload 边界；行为等价由
// test-dispatch + check-behavior-parity 锁）。TASK_CREATE/UPDATE/DISPATCH
// 三命令共享一体（board-commands 内单函数，三 case 标签同委托）。
import { cancelEngineLogin, engineLoginStatus, startEngineLogin, verifyEngineLogin } from "../engine-login.js";
import { isSessionEngine } from "../engine-registry.js";
export function createEngineCommands(mgr: any) {
  return {
    COMMAND_ENGINE_LOGIN(cmd: any, by: string): any {
          // #102 批 B 引擎登录引导（把饭喂到嘴里）：action 四态——
          //   start  幂等起登录 pane（tmux 托管）+ AUTH_REQUIRED 事件流（url 增量推）
          //   status 查当前流程（瞬态事件断线不补发，重连后靠这里兜底）
          //   verify 「我已完成登录」：异步直探（不阻塞——结果走 AUTH_REQUIRED 事件：
          //         ready 卡片转绿/仍 pending 回弹），ACK 只做受理
          //   cancel 收 pane 推 cancelled（用户关卡）
          // ACK data = 流程投影（与 AUTH_REQUIRED payload 同构，端上同一渲染面）；
          // handleCommand 同步约束：全部接口同步受理、异步推进（spawn/探针不进 ACK 路径）
          {
            const p = cmd.payload as { engine?: unknown; action?: unknown };
            const engine = p.engine;
            if (!isSessionEngine(engine)) {
              return { command_id: cmd.command_id, ok: false, error: `未知引擎: ${String(engine)}` };
            }
            if (engine === "claude") {
              return { command_id: cmd.command_id, ok: false, error: "claude 免登录（relay 内嵌 SDK）" };
            }
            const action = p.action === "status" || p.action === "verify" || p.action === "cancel" ? p.action : "start";
            if (action === "status") {
              const flow = engineLoginStatus(engine);
              return { command_id: cmd.command_id, ok: true, data: flow };
            }
            if (action === "cancel") {
              const flow = cancelEngineLogin(mgr.bus, engine);
              return { command_id: cmd.command_id, ok: true, ...(flow ? { data: flow } : { data: null }) };
            }
            if (action === "verify") {
              verifyEngineLogin(mgr.bus, engine); // 受理；探针结果走 AUTH_REQUIRED 事件
              return { command_id: cmd.command_id, ok: true, data: { engine, accepted: true } };
            }
            const flow = startEngineLogin(mgr.bus, engine);
            return { command_id: cmd.command_id, ok: true, data: flow };
          }
    },
  };
}
