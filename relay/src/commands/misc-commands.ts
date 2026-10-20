// W-SPLIT-S3b：小族命令 mixin（session-manager 七 case 体逐字搬出，仅 this.→mgr.）。
// 搬运纪律与 S3R2c 样板（pairing-commands.ts）同款：与执行体内逻辑零改动（含注释
// 原样）；依赖的模块级助手（isManagedMode/PERM_MODE_ZH/sanitizeImages/sanitizeFiles）
// 随迁导出，session-manager 原定义删除改反向 import（防双源）。EXT 族依赖
// mgr.bridge——照搬不改（任务书口径）。
import { addHiddenTodoKey } from "../todo-hidden.js";
import { normKey, truncate } from "../summarizer.js";
import type { CommandAckPayload, ManagedPermissionMode } from "../types.js";
import type { UploadBlob } from "../uploads.js";

// 样板参数：真身 SessionManager / Command——any 网关为跨 private 成员与 payload
// 联合类型窄化边界（原 case 内的 switch narrowing 在独立函数不可复现）。行为等价
// 由 test-dispatch + check-behavior-parity 锁死，非类型信任面

export function isManagedMode(m: unknown): m is ManagedPermissionMode {
  // bypassPermissions 必须在内：① CLI init 回报 skip 会话时据此镜像记录 state（否则
  // 挂起恢复 `state.permission_mode ?? "default"` 把 skip 会话掉回 default，每条命令
  // 重新送审）② COMMAND_PERM 切换接受 skip 档——客户端切换器已含四档，缺此则一切走
  // default/acceptEdits 就再也切不回 skip（用户实踩：skip 启动 → 点权限按钮 → 永久降级）
  return m === "default" || m === "acceptEdits" || m === "plan" || m === "bypassPermissions";
}

export const PERM_MODE_ZH: Record<ManagedPermissionMode, string> = {
  default: "标准（每次确认）",
  acceptEdits: "自动接受编辑",
  plan: "规划（只读）",
  bypassPermissions: "跳过权限确认",
};

// 图片消息清洗：最多 4 张、单张 8MB base64，剔除非法项
export function sanitizeImages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 8 * 1024 * 1024);
  return list.length > 0 ? list.slice(0, 4) : undefined;
}

// #62 文件附件清洗：最多 2 个、单个 28MB base64（≈20MB 原文件，2026-09-19 用户反馈
// 4.5MB 太小后放宽）。超限项剔除而非整单拒收——手机端选文件时已有前置大小提示，
// 这里兜底防裸协议灌大包（28MB×2=56MB 仍在 ws 默认 100MB 单帧内）
export function sanitizeFiles(raw: unknown): UploadBlob[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: UploadBlob[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const name = typeof (x as Record<string, unknown>).name === "string" ? (x as Record<string, unknown>).name : "";
    const b64 = (x as Record<string, unknown>).b64;
    if (typeof b64 !== "string" || b64.length === 0 || b64.length > 28 * 1024 * 1024) continue;
    list.push({ name: String(name), b64 });
  }
  return list.length > 0 ? list.slice(0, 2) : undefined;
}

export function createMiscCommands(mgr: any) {
  return {
    COMMAND_PERM(cmd: any, _by: string): CommandAckPayload {
      const live = mgr.requireLive(cmd.payload.session_id);
      if (live.state.external) {
        return { command_id: cmd.command_id, ok: false, error: "外部会话不支持权限模式切换" };
      }
      const mode = cmd.payload.mode;
      if (!isManagedMode(mode)) {
        return { command_id: cmd.command_id, ok: false, error: `未知权限模式: ${mode}` };
      }
      void live.agent.setPermissionMode(mode)
        .then(() => {
          live.state.permission_mode = mode;
          mgr.pushExternalLog(live.state.session_id, "system", `权限模式切换: ${PERM_MODE_ZH[mode]}`);
          mgr.emitUpdated(live, true);
        })
        .catch((e: unknown) => {
          // #217 SDK 硬约束的英文报错翻译成人话（切跳过被拒的真实原因），
          // 其余错误原文透传
          const raw = e instanceof Error ? e.message : String(e);
          const friendly = /not launched with --dangerously-skip-permissions/.test(raw)
            ? "跳过档不可用：该会话不是以跳过权限创建的（跳过档只能在创建会话时开启）"
            : raw;
          mgr.pushExternalLog(live.state.session_id, "system", `权限模式切换失败: ${friendly}`);
        });
      return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_EXT_MODE(cmd: any, _by: string): CommandAckPayload {
      const s = mgr.require(cmd.payload.session_id);
      if (!s.state.external) {
        return { command_id: cmd.command_id, ok: false, error: "not an external session" };
      }
      mgr.setRemoteMode(cmd.payload.session_id, cmd.payload.enabled);
      return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_EXT_INPUT(cmd: any, _by: string): CommandAckPayload {
      const s = mgr.require(cmd.payload.session_id);
      if (!s.state.external) {
        return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_MESSAGE" };
      }
      if (!mgr.bridge) {
        return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
      }
      const r = mgr.bridge.extInput(
        cmd.payload.session_id,
        cmd.payload.text,
        sanitizeImages(cmd.payload.images),
        sanitizeFiles(cmd.payload.files),
      );
      return { command_id: cmd.command_id, ok: r.ok, error: r.error };
    },
    COMMAND_EXT_STOP(cmd: any, _by: string): CommandAckPayload {
      const s = mgr.require(cmd.payload.session_id);
      if (!s.state.external) {
        return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_STOP" };
      }
      if (!mgr.bridge) {
        return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
      }
      const r = mgr.bridge.extStop(cmd.payload.session_id);
      return { command_id: cmd.command_id, ok: r.ok, error: r.error };
    },
    COMMAND_REFRESH_TODOS(cmd: any, _by: string): CommandAckPayload {
      const s = mgr.require(cmd.payload.session_id);
      if (s.state.external) {
        if (!mgr.bridge) {
          return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
        }
        const r = mgr.bridge.refreshTodos(cmd.payload.session_id);
        return { command_id: cmd.command_id, ok: r.ok, error: r.error };
      }
      // 托管会话：任务目录是权威源（#206）。force 重读磁盘强制重发可见集，
      // 不删轮询缓存——diff 仍与上轮比较，恰逢完成项照样发 TASK_DONE
      mgr.pollTaskStore(true);
      if (s.state.todos) mgr.setTodos(cmd.payload.session_id, s.state.todos.map((t: { [k: string]: unknown }) => ({ ...t })));
      return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_TODO_HIDE(cmd: any, _by: string): CommandAckPayload {
      const s = mgr.require(cmd.payload.session_id);
      const content = cmd.payload.content.trim();
      if (!content) return { command_id: cmd.command_id, ok: false, error: "content 不能为空" };
      if (s.state.external) {
        if (!mgr.bridge) {
          return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
        }
        const r = mgr.bridge.hideTodo(cmd.payload.session_id, content);
        return { command_id: cmd.command_id, ok: r.ok, error: r.error };
      }
      // 托管会话：SDK feed 后续重推也被 setTodos 过滤兜住
      addHiddenTodoKey(cmd.payload.session_id, normKey(content));
      if (s.state.todos) mgr.setTodos(cmd.payload.session_id, s.state.todos.map((t: { [k: string]: unknown }) => ({ ...t })));
      // 删除闭环：让会话本体同步删掉本地任务条目（显示层过滤≠源头删除）
      s.agent?.sendMessage(
        `[移动端删除任务] 用户删除了任务清单条目：「${truncate(content.trim(), 120)}」。请将该条目从你的本地任务列表同步删除（任务工具置 deleted 或移除），不要重新创建或继续处理它。本条为系统通知，简短确认即可。`,
      );
      return { command_id: cmd.command_id, ok: true };
    },
    // #212 删除「允许并记住」规则。删不存在的 id 回 ok:false；成功后的
    // ALLOW_RULES_UPDATED 广播由 allowRules.onChange 统一触发（构造处挂接，
    // 覆盖落规则/删除/会话清理全部 mutation——见 AllowRuleStore.onChange 注释）
    COMMAND_ALLOW_RULE_REMOVE(cmd: any, _by: string): CommandAckPayload {
      if (!mgr.allowRules.remove(cmd.payload.id)) {
        return { command_id: cmd.command_id, ok: false, error: "no such rule" };
      }
      return { command_id: cmd.command_id, ok: true };
    },
  };
}
