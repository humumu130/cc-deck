// W-SPLIT-S3c：组织/看板/任务域命令 mixin（case 体逐字搬出，仅 this.→mgr.）。
// 样板同 S3R2c/S3a（any 网关跨 private/payload 边界；行为等价由
// test-dispatch + check-behavior-parity 锁）。TASK_CREATE/UPDATE/DISPATCH
// 三命令共享一体（board-commands 内单函数，三 case 标签同委托）。
import { statSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSessionEngine } from "../engine-registry.js";
import { resolveUploadImage } from "../uploads.js";
import { truncate } from "../summarizer.js";
import { listWorkerPluginPaths } from "../plugin-config.js";
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_FETCH_MAX_BYTES, mimeOf, readPinnedSessions, writePinnedSessions } from "../session-manager.js"; // 本地符号（原文件 export 单源）
export function createBoardCommands(mgr: any) {
  return {
    COMMAND_ORG_ACTION(cmd: any, by: string): any {
          // #018-R1b org 命令真链路：LAN（ws-server）与 cloud（cloud-client）两入口
          // 都经 handleCommand 到这里，统一收口 orgCommand 咽喉（权限矩阵 + B2a
          // adapter + 审计）。ACK data 冻结口径 {group, needsConfirm, confirm?}。
          // 现连接面全部持主 token（ws hello / cloud E2E 密封），无 viewer 通道——
          // 角色统一记 owner；未来连接级角色（viewer 分享链接等）只换这里实参，
          // 咽喉零改（org.ts：不信任客户端自报角色，actor 由连接身份解析）
          const r = mgr.orgCommand(
            "owner",
            by,
            String((cmd.payload as { action?: unknown }).action ?? ""),
            cmd.payload as Record<string, unknown>,
          );
          if ("forbidden" in r) return r.forbidden;
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
    },
    COMMAND_ORG_CONFIRM(cmd: any, by: string): any {
          // #26 M2 确认单决议（用户点击确认卡）：R1b 起同走 orgCommand 咽喉（审计 +
          // 二次决议幂等收口）；决议后确认单状态与 projects 三态联动在咽喉内落地。
          // ACK 保持既有口径（ok，不带 data——B0 冻结的客户端形状不动）
          const r = mgr.orgCommand("owner", by, "confirm-decide", {
            confirm_id: cmd.payload.confirm_id,
            approve: cmd.payload.approve,
          });
          if ("forbidden" in r) return r.forbidden;
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
    },
    COMMAND_PROJECT_DETAIL(cmd: any, by: string): any {
          // #26 M2 项目组详情：{ group, board, receipts }（编制/板/回执流四分节数据源）
          const r = mgr.orgAction("project-detail", { id: cmd.payload.gid });
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
    },
    COMMAND_LESSON_APPEND(cmd: any, by: string): any {
          // W-EXPP1 退役（设计 §8 P1 旧域读侧退役清单）：#087 lessons 分区已被团队经验
          // 库接管（relay/src/experience.ts），本命令字不再受理——M12-4 收口自动账仍走
          // orgAction("lesson-append") 写旧域（维持现状，不经此命令面）
          return {
            command_id: cmd.command_id,
            ok: false,
            error: "lesson 命令已退役（经验回流走团队经验库：org CLI `org exp append` / HTTP exp-append；P2 起面板 COMMAND_EXP_*）",
          };
    },
    COMMAND_PEER_KICK(cmd: any, by: string): any {
          // 议题①踢除：幂等（dev 不存在也回 ok）；先广播 kick 让在线设备刷新清单，
          // 再执行移除（peers 写穿落盘 + 各桥发 pair_nack 令其立即停止重连）
          if (!mgr.cloud || !mgr.peerKicker) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const dev = String((cmd.payload as { dev?: unknown }).dev ?? "");
          if (!/^[a-z]{2}-[0-9a-f]{6,64}$/.test(dev)) {
            return { command_id: cmd.command_id, ok: false, error: "无效的设备号" };
          }
          const name = mgr.cloud.peers.get(dev)?.name || dev.slice(0, 11);
          mgr.peerKicker(dev);
          mgr.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "kick" });
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_ARTIFACT_FETCH(cmd: any, by: string): any {
          // #79 输出物远程访问（实时 E2E 传输，不落云存储）：授权锚点 = path 归一化
          // 后必须命中该会话 state.artifacts 已登记条目（防任意读/路径穿越——客户端
          // 只能拉它本就看得见的输出物）；≤20MB；成功 ACK 携带 size/mime，数据本体
          // 经瞬态 ARTIFACT_CHUNK 帧按 ref=command_id 回发（LAN/云同路径，云侧自动
          // E2E 密封，桥不落存储）。幂等重放（duplicate ack）不会重发数据——缺帧
          // 重试必须换新 command_id
          // FB14 气泡附图：path 为 img-* basename 引用时走临时目录分支（resolveUploadImage
          // 校验形态+会话归属+目录钳制，授权口径同级：只能拉本会话收过的图）。复用同一
          // CHUNK 回发管线，端上拉取代码零分叉
          const s = mgr.require(cmd.payload.session_id);
          const rawPath = String(cmd.payload.path ?? "");
          const imgHit = resolveUploadImage(mgr.cfg.dataDir, s.state.session_id, rawPath);
          const key = imgHit ? "" : resolve(rawPath).toLowerCase();
          const hit = imgHit
            ? { path: imgHit }
            : (s.state.artifacts ?? []).find((a: any) => a.path.toLowerCase() === key);
          if (!hit) {
            return { command_id: cmd.command_id, ok: false, error: "路径未登记在该会话的输出物清单里，无权拉取" };
          }
          let st;
          try {
            st = statSync(hit.path);
          } catch {
            return { command_id: cmd.command_id, ok: false, error: imgHit ? "图片已过期（临时附件定期清扫）" : "文件不存在或不可访问（可能已被移动/删除）" };
          }
          if (!st.isFile()) return { command_id: cmd.command_id, ok: false, error: "不是常规文件" };
          if (st.size > ARTIFACT_FETCH_MAX_BYTES) {
            return { command_id: cmd.command_id, ok: false, error: `文件 ${(st.size / 1048576).toFixed(1)}MB 超过 20MB 上限，请在电脑端查看` };
          }
          const ref = cmd.command_id;
          try {
            const buf = readFileSync(hit.path);
            const total = Math.max(1, Math.ceil(buf.length / ARTIFACT_CHUNK_BYTES));
            for (let seq = 0; seq < total; seq++) {
              mgr.bus.emitTransient(
                "ARTIFACT_CHUNK",
                {
                  ref,
                  seq,
                  total,
                  b64: buf.subarray(seq * ARTIFACT_CHUNK_BYTES, (seq + 1) * ARTIFACT_CHUNK_BYTES).toString("base64"),
                },
                by,
              );
            }
            mgr.bus.emitTransient("ARTIFACT_CHUNK", { ref, done: true }, by);
          } catch (e) {
            mgr.bus.emitTransient("ARTIFACT_CHUNK", { ref, error: e instanceof Error ? e.message : String(e) }, by);
          }
          return { command_id: cmd.command_id, ok: true, artifact: { size: st.size, mime: mimeOf(hit.path) } };
    },
    COMMAND_RESUME_SESSION(cmd: any, by: string): any {
          // #49 按需恢复：点击「已保存」休眠卡触发。已在线会话幂等成功（顺手清残留
          // 休眠标记）；失败同步抛错回 ACK，异步失败（流断/超时）走 SESSION_ERROR，
          // saved 保留可重试
          const s = mgr.require(cmd.payload.session_id);
          if (s.state.external) {
            // W-INJECT：外部会话恢复 = 重启收养误标 historical 的手动翻案通道（此前
            // 一律「外部会话不支持恢复」拒死，客户端对误标只读卡毫无办法）。CLI 进程
            // 活着 → 清只读标记即恢复可交互（进程在，无需也不应新开终端）；进程真死
            // → 明确报错。真实「拉起+投递」在发消息路径的 resumeExternal（恢复语义与
            // 消息投递绑定，点卡不该凭空开窗）
            const pid = s.state.cli_pid;
            let alive = false;
            if (pid) {
              try { process.kill(pid, 0); alive = true; } catch (e) {
                alive = (e as NodeJS.ErrnoException).code === "EPERM";
              }
            }
            if (!alive) {
              return { command_id: cmd.command_id, ok: false, error: "该会话的终端进程已结束，无法在此恢复；在电脑终端里 claude --resume 后发消息即可重新接入" };
            }
            s.state.historical = false;
            s.state.idle_archived = undefined;
            mgr.emitUpdated(s, true);
            return { command_id: cmd.command_id, ok: true };
          }
          if (s.agent && !s.agent.ended) {
            if (s.state.saved) {
              s.state.saved = undefined;
              mgr.emitUpdated(s, true);
            }
            return { command_id: cmd.command_id, ok: true };
          }
          mgr.reviveSaved(s);
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_PIN_SESSION(cmd: any, by: string): any {
          // #49 置顶/取消置顶：写穿 pinned-sessions.json。休眠态（saved）也可 unpin——
          // 摘掉 saved 让卡片退回普通历史会话。
          // UIPOLISH3 件一（2026-10-11 用户拍板）：外部 CLI 会话解锁置顶——原「由 CLI 自身
          // 维护」的拦截无技术依据（置顶是纯列表整理：state.pinned 标记 + 文件写穿 +
          // SESSION_UPDATED 回显，与托管/外部无关），CLI sid 一视同仁；applyPinned 重启
          // 登记对 ext 只补 pinned 标记不做休眠登记（ext 无 agent 不可 resume）。
          const s = mgr.require(cmd.payload.session_id);
          const pinned = cmd.payload.pinned === true;
          s.state.pinned = pinned || undefined;
          if (!pinned) s.state.saved = undefined;
          s.state.updated_at = Date.now();
          writePinnedSessions(
            mgr.cfg.dataDir,
            [...readPinnedSessions(mgr.cfg.dataDir).filter((x) => x !== cmd.payload.session_id), ...(pinned ? [cmd.payload.session_id] : [])],
          );
          // 显式带 pinned/saved 布尔（含 false）：端上据此直接改卡片，不等快照
          mgr.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            pinned,
            saved: !!s.state.saved,
            updated_at: s.state.updated_at, // #271：帧完整性（pin 是 UI 态≠活动）
          });
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_SETTINGS_UPDATE(cmd: any, by: string): any {
          // #17 第二批：雇员独立家开关热切换（三端设置项入口）。ack 带最新状态；
          // env 锁定/写盘失败等拒改场景 ok:false 带可读指引。审查修正（P2）：字段
          // 非布尔明确拒收——缺键/字符串一律按 false 落盘会把开关静默关掉
          if (typeof cmd.payload.employee_home !== "boolean") {
            return { command_id: cmd.command_id, ok: false, error: "employee_home 须为布尔值" };
          }
          const r = mgr.applyEmployeeHome(cmd.payload.employee_home);
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
    },
    COMMAND_RELAY_NAME_SET(cmd: any, _by: string): any {
          // #272 源名称可编辑（hostname 默认过长如 huanglin）：relay-name 文件唯一事实源
          //（W-SRCLABEL #134 单点，读写都收口 settings.ts），本命令是唯一写口——
          // sanitize ≤12/拒控制字符/空=清空回落 hostname；成功即广播 RELAY_NAME_UPDATED
          //（LAN+cloud 全扇出：本端与对端云配对源同名即时跟随，SNAPSHOT 亦现算新名）。
          // ack.data = { relay_name }（生效名——清空时即回落后的 hostname）
          const r = mgr.setRelayName((cmd.payload as { name?: unknown } | undefined)?.name);
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
    },
    COMMAND_TASK_CREATE(cmd: any, by: string): any {
          // M12-1 三新命令（v2-m10-freeze §3.1 新增候选定岗）：LAN/cloud 两入口都经
          // handleCommand 到这里，同走 orgCommand 咽喉（权限矩阵+审计一行），adapter
          // 把 canonical payload 映射到 orgAction 旧 shape 再执行——不建第二事实源。
          // ACK data 冻结口径 {entity_id, gid}（dispatch 并列 dispatch_id/session_id）
          // W-EXPP1：COMMAND_LESSON_APPEND 命令字下线（设计 §8 P1 退役清单）——经验
          // 回流走经验库 exp 通道（经验库 HTTP 面 exp-append；P2 面板 COMMAND_EXP_*），
          // case 单列显式退役报错优于落 generic unsupported（端上可读指引）
          const m12Action: Record<string, string> = {
            COMMAND_TASK_CREATE: "task-create",
            COMMAND_TASK_UPDATE: "task-update",
            COMMAND_DISPATCH: "dispatch",
          };
          const r = mgr.orgCommand("owner", by, m12Action[cmd.type] ?? "", cmd.payload as Record<string, unknown>);
          if ("forbidden" in r) return r.forbidden;
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
    },
  };
}
