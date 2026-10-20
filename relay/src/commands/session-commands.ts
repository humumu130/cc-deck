// W-SPLIT-S3a：session CRUD 域命令 mixin（九 case 体逐字搬出，仅 this.→mgr.）。
// 样板同 S3R2c（commands/pairing-commands.ts）：any 网关跨 private/payload 窄化
// 边界；行为等价由 test-dispatch + check-behavior-parity + test-headcount 锁。
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EFFECTIVE_TO_MANAGED, engineCapabilityState, evaluatePermission, permDenyMessage, permissionPolicyEnabled } from "../permission-policy.js";
import { appendPermissionAudit, auditStore, readBypassAuthorization, resolveDirScope, resolveEnvScope } from "../permission-audit.js";
import type { PermissionAuditRow } from "../permission-audit.js";
import { catalogReadyEngines } from "../engine-catalog.js";
import { probeEngineAuth } from "../engine-auth.js";
import { startEngineLogin } from "../engine-login.js";
import { recordBlockedCreate } from "../engine-auth-watch.js";
import { isSessionEngine } from "../engine-registry.js";
import { appendDispatch } from "../org.js";
import { findGroup } from "../projects.js";
import { truncate } from "../summarizer.js";
import { imageRefsOf, saveUploadFiles, saveUploadImages } from "../uploads.js";
import { wrapPreCompactReminder } from "../context-watchdog.js";
import { sanitizeFiles, sanitizeImages } from "./misc-commands.js"; // S3MERGE：S3b 删了 session-manager 本地定义（misc 单源），同步改引
import { resumePendingWindowMs } from "../session-manager.js"; // 本地函数（原文件 export 单源保留）
import type { SessionEngine } from "../types.js";
import type { CommandAckPayload } from "../types.js";

// 样板参数：真身 SessionManager / Command（见 S3R2c 备注同款）
export function createSessionCommands(mgr: any) {
  return {
    COMMAND_CREATE(cmd: any, by: string): CommandAckPayload {
          // permissionMode: 客户端可选 bypassPermissions（新建时勾选"跳过权限确认"）
          const pm = cmd.payload.permissionMode === "bypassPermissions" ? "bypassPermissions" : undefined;
          // #208 autoMkdir：客户端创建表单「目录不存在时自动创建」开关（默认关＝旧回落行为）
          const requestedEngine = (cmd.payload as { engine?: unknown }).engine;
          // P81-5 真实判定接线（§6.1「服务端识别运行环境和工作目录」）：判不出显式回
          // "unknown"（P81-3/4 头注钉死纪律——判定缺位走 fail-closed，绝不缺席两维）
          const dirScope = resolveDirScope(cmd.payload.cwd);
          const envScope = resolveEnvScope(mgr.cfg.port);
          if (requestedEngine !== undefined && !isSessionEngine(requestedEngine)) {
            // 未知引擎拒也落审计（§6.3「拒绝也写审计」；B8 修正面）。P81-9 off：恢复
            // P81 前口径——拒保留（isSessionEngine 校验非 P81 线），审计不落（新面不写）
            if (permissionPolicyEnabled()) {
              appendPermissionAudit(auditStore(mgr.cfg.dataDir), {
                requested_mode: pm ?? null, normalized_mode: null, effective_mode: "forbidden", native_mode: null,
                capability_state: engineCapabilityState(String(requestedEngine)), engine: String(requestedEngine),
                reason: "unknown_engine", policy_source: "explicit",
                environment: envScope, dir_scope: dirScope, tier: "随手办", actor: by, session_id: null, command_id: cmd.command_id, created_at: Date.now(),
              });
            }
            return { command_id: cmd.command_id, ok: false, error: `未知引擎: ${String(requestedEngine)}` };
          }
          const engine = requestedEngine as SessionEngine | undefined;
          // #75 开卡选择上下文（PM-75 提案 §3/§7.2）：可选 selection_source（选择来源
          // 词表）+gid/role（组上下文）。求值序与派单口一致（显式输入优先既有语义零
          // 改动）：payload.engine 显式值 > 组 role_defaults[role].engine 预置 > relay
          // 默认（claude）。预置引擎不在 catalog ready 态 ⇒ 回退默认+degraded 显式标记
          //（提案 §6.1「不静默换引擎」红线）；显式手动选择不经降级（P81 闸+preflight
          // 拒绝面既有语义，未选/选错都会被拒而非回落）。
          const selPayload = cmd.payload as unknown as { selection_source?: unknown; gid?: unknown; role?: unknown };
          const selSource = selPayload.selection_source;
          if (selSource !== undefined && selSource !== "role_default" && selSource !== "manual" && selSource !== "relay_default") {
            return { command_id: cmd.command_id, ok: false, error: `无效 selection_source: ${String(selSource)}（有效值：role_default/manual/relay_default）` };
          }
          const selGid = typeof selPayload.gid === "string" ? selPayload.gid.trim() : "";
          const selRole = typeof selPayload.role === "string" ? selPayload.role.trim() : "";
          let degraded = false;
          let degradedReason = "";
          let engineResolved = engine;
          if (!engineResolved && selGid && selRole) {
            const preset = findGroup(selGid)?.role_defaults?.[selRole]?.engine;
            if (preset) {
              if (catalogReadyEngines().has(preset)) {
                engineResolved = preset; // 预置引擎可用：role_default 缺省生效
              } else {
                degraded = true; // 预置不可用（未装/unsupported）：回退 claude+显式降级
                degradedReason = `角色预置引擎 ${preset} 不可用（catalog 非 ready），已回退默认引擎`;
              }
            }
          }
          // #102 批 A：引擎登录态 fail-fast 拦截（spawn 前置校验）——显式/预置解析落定
          // 的非 claude 引擎先探登录态，needs_auth 拒创建返结构化错误（needs_auth+
          // auth_hint），端上显示可操作指引而非 spawn 后炸「引擎返回错误」（1014 实锤
          // 根因：CodeBuddy 装了未登录）。claude 免检（relay 进程即 SDK）；探针 fail-open
          // （故障判 ready 不锁引擎）。kill-switch 分叉之前=两个分支统一覆盖；probe 现算
          // 无缓存=登录后下一次创建即恢复（目录投影同源 engine-auth.ts 单点）
          if (engineResolved && engineResolved !== "claude") {
            const auth = probeEngineAuth(engineResolved);
            if (auth.state === "needs_auth") {
              // #102 批 B：把饭喂到嘴里——拦截同时自动拉起登录 pane（tmux 托管）+
              // AUTH_REQUIRED 事件（含面板提取的授权 URL），端上引导卡渲染二维码，
              // 扫码即登录零终端操作（同步受理 pane 异步起流，事件后至）
              startEngineLogin(mgr.bus, engineResolved);
              // #102 批 C：创建被拦无会话实体可恢复——登记 intent 快照（anchor/task
              // 摘要），pane 关闭后 watch 兜底探到 ready 时通知「已登录，可以创建了」
              // +快照回显（内部挂 watch；cap 5 防通知风暴）
              recordBlockedCreate({
                engine: engineResolved,
                ...(typeof cmd.payload.cwd === "string" && cmd.payload.cwd ? { cwd: cmd.payload.cwd } : {}),
                prompt_summary: truncate(typeof cmd.payload.prompt === "string" ? cmd.payload.prompt : "", 80),
                ts: Date.now(),
              });
              return {
                command_id: cmd.command_id, ok: false,
                error: `引擎 ${engineResolved} 未登录: ${auth.auth_hint ?? "请先完成引擎登录"}`,
                needs_auth: true,
                ...(auth.auth_hint ? { auth_hint: auth.auth_hint } : {}),
              };
            }
          }
          // P81-9 kill-switch off（§8.2.4 回退契约）：完整回 P81 前行为——pm 走旧直通
          //（:2041 本就是旧形态），引擎/角色/ceiling/环境四闸跳过、forbidden 面缺席、
          // 不落新 P81 审计（「回退不删除任何事实源」=既有审计照旧，新面不写）；ACK 回
          // P81 前三键形态（无 permission 键——端上 P81-8 降级面见 undefined 自动隐藏）。
          // #75 selection 面（引擎预置/degraded 标记）与未知引擎校验保留（非 P81 线，
          // 75-R 交付已验收；校验拒不落审计=恢复 P81 前口径）。
          if (!permissionPolicyEnabled()) {
            const session_id = mgr.create(cmd.payload.cwd, cmd.payload.prompt, pm, cmd.payload.autoMkdir === true, {
              ...(engineResolved ? { engine: engineResolved } : {}),
              ...(cmd.payload.model ? { model: cmd.payload.model } : {}),
              ...(cmd.payload.provider ? { provider: cmd.payload.provider } : {}),
              ...(degraded ? { degraded: true, degraded_reason: degradedReason } : {}),
            });
            return {
              command_id: cmd.command_id,
              ok: true,
              session_id,
              ...(engineResolved ? { engine: engineResolved } : {}),
              ...(degraded ? { degraded: true, degraded_reason: degradedReason } : {}),
            };
          }
          // P81-2 开卡求值闸（§6.1 统一拒绝面）：用户自建卡映射 team_pm×随手办（§5.2
          // 上限 full-auto）。P81-5：两维真实判定接入+审计落库（成功与拒绝都落）+
          // spawn 传值收口（effective→MANAGED 实参——JSONL 降级后 CLI 收 acceptEdits
          // 而非伪装 bypass；claude 沙盒 bypass 恒等=多数路径零变）。
          const engineForPolicy = engineResolved ?? "claude";
          // P81-2 开卡求值闸。kill-switch 接线修正（2026-10-11）：本路径此前未接
          // permissionPolicyEnabled()——env=off 时策略应整体回退 P81 前（pm 硬传），
          // 实测却仍 forbidden（用户派单被卡）。对齐 6341 口径：policyOn=false ⇒ perm=null
          // 跳过求值与 forbid 面，下游 EFFECTIVE_TO_MANAGED 走 bypass 恒等回退。
          const perm: any = permissionPolicyEnabled() ? evaluatePermission({
            requested_mode: pm ?? null,
            engine: engineForPolicy,
            role: "team_pm",
            tier: "随手办",
            capability_state: engineCapabilityState(engineForPolicy),
            policy_source: "explicit",
            dir_scope: dirScope,
            env: envScope,
            // W-PERMERR：授权位接线补全（#69 半边）——此前仅组织派单口（:7123）传本字段，
            // 用户自建卡勾「跳过权限确认」在生产/未知环境恒 forbidden 且授权对它无效
            // （1016 用户 Windows 云通道实锤：连生产 relay 勾选即报错，无放行通道）。
            // 授权读数与派单口同源（permission-auth.json，org auth-bypass 写入）
            user_authorized_bypass: readBypassAuthorization(mgr.cfg.dataDir),
          }) : null;
          // 审计落库（§6.3 拒绝也写审计；session_id 拒=null 成功=新会话）。policy off
          // ⇒ perm=null，仅 forbidden 分支会落拒绝审计，null 不进该路径。
          if (perm && perm.effective_mode === "forbidden") {
            const denyRow: PermissionAuditRow = {
              requested_mode: perm.requested_mode, normalized_mode: perm.normalized_mode, effective_mode: perm.effective_mode,
              native_mode: perm.native_mode, capability_state: perm.capability_state, engine: perm.engine,
              reason: perm.reason, policy_source: perm.policy_source,
              environment: envScope, dir_scope: dirScope, tier: "随手办", actor: by,
              session_id: null, command_id: cmd.command_id, created_at: Date.now(),
            };
            appendPermissionAudit(auditStore(mgr.cfg.dataDir), denyRow);
            // W-PERMERR：拒绝面文案可操作化（1016 用户实锤：`forbidden: production_bypass_denied`
            // 英文 reason 码直出 toast，用户不知如何处置）。reason 保留在文案尾部（审计/排障
            // 对照），主文案=中文+行动指引（军规口径：动词开头、结果可察、无内部机制词）
            return { command_id: cmd.command_id, ok: false, error: permDenyMessage(perm.reason) };
          }
          const spawnPmMode: any = perm && perm.effective_mode !== "forbidden" ? (EFFECTIVE_TO_MANAGED as Record<string, any>)[perm.effective_mode] : (pm ?? "bypassPermissions");
          const session_id = mgr.create(cmd.payload.cwd, cmd.payload.prompt, spawnPmMode, cmd.payload.autoMkdir === true, {
            ...(engineResolved ? { engine: engineResolved } : {}),
            ...(cmd.payload.model ? { model: cmd.payload.model } : {}),
            ...(cmd.payload.provider ? { provider: cmd.payload.provider } : {}),
            ...(degraded ? { degraded: true, degraded_reason: degradedReason } : {}),
          });
          const okRow: PermissionAuditRow = perm
            ? { requested_mode: perm.requested_mode, normalized_mode: perm.normalized_mode, effective_mode: perm.effective_mode, native_mode: perm.native_mode, capability_state: perm.capability_state, engine: perm.engine, reason: perm.reason, policy_source: perm.policy_source, environment: envScope, dir_scope: dirScope, tier: "随手办", actor: by, session_id, command_id: cmd.command_id, created_at: Date.now() }
            : { requested_mode: pm ?? null, normalized_mode: null, effective_mode: spawnPmMode, native_mode: null, capability_state: engineCapabilityState(engineForPolicy), engine: engineForPolicy, reason: "p81_policy_off", policy_source: "explicit", environment: envScope, dir_scope: dirScope, tier: "随手办", actor: by, session_id, command_id: cmd.command_id, created_at: Date.now() };
          appendPermissionAudit(auditStore(mgr.cfg.dataDir), okRow);
          return {
            command_id: cmd.command_id,
            ok: true,
            session_id,
            // #75 实际引擎回显+降级显式标记（端上据此显示降级徽标，不静默——提案 §6.2）
            ...(engineResolved ? { engine: engineResolved } : {}),
            ...(degraded ? { degraded: true, degraded_reason: degradedReason } : {}),
            permission: perm
              ? { normalized: perm.normalized_mode ?? "", effective: perm.effective_mode, native_mode: perm.native_mode, reason: perm.reason }
              : { normalized: "", effective: spawnPmMode, native_mode: null, reason: "p81_policy_off" },
          };
    },
    COMMAND_MESSAGE(cmd: any, by: string): CommandAckPayload {
          const s = mgr.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话请使用 COMMAND_EXT_INPUT" };
          }
          // #62 文件附件：SDK 用户消息只收 image blocks，文件类附件落盘 tmp 后把
          // 「正文 + 路径处理指令」作为正文下发（echo 分离：客户端可见面不暴露临时
          // 路径，同 #54b 口径；unacked 记合成文——重放时盘上文件仍在，指令照常有效）
          const orig = cmd.payload.text;
          let text = orig;
          // W-CTXFIX B3：待注回摘要拼进本条消息首帧（system-reminder 形态，只注一次）。
          // 单点收敛：在此拼好 text，后续三个出口（resumePending 排队 / resumeAgent
          // 换流 / 直发 sendMessage）自然全部携带；echo 仍展示用户原文不含前缀
          if (s.ctxWd?.reinjectPending && s.state.pre_compact_summary) {
            s.ctxWd.reinjectPending = false;
            text = wrapPreCompactReminder(s.state.pre_compact_summary) + text;
            mgr.pushExternalLog(s.state.session_id, "system", "已注入压缩前任务状态摘要（外置记忆存档）");
            mgr.emitUpdated(s, true);
          }
          let echo: string | undefined;
          const files = sanitizeFiles(cmd.payload.files);
          if (files && files.length > 0) {
            const saved = saveUploadFiles(mgr.cfg.dataDir, cmd.payload.session_id, files);
            if (saved.length > 0) {
              const list = saved.join("、");
              text = text.trim() ? `${text}\n（文件已保存：${list}——请按需读取处理）` : `请处理以下文件：${list}`;
              echo = `${orig.trim()}（+${saved.length} 文件）`.trim();
            } else if (!text.trim()) {
              return { command_id: cmd.command_id, ok: false, error: "文件保存失败（临时目录不可写）" };
            }
          }
          // FB14 气泡附图：base64 原链照旧进 CLI（#63 不动），另落一份共享 tmp 供气泡
          // 回取——refs（basename 引用）随发送链透传：流回显经 onLog 对账取出附到
          // LogEntry.images，看门狗重放/resume 经 unacked.refs 续带。落盘失败不挡发送
          //（气泡少缩略，消息本身无损）
          const imgPayload = sanitizeImages(cmd.payload.images) ?? [];
          const imgRefs = imgPayload.length > 0
            ? imageRefsOf(saveUploadImages(mgr.cfg.dataDir, cmd.payload.session_id, imgPayload))
            : [];
          // #26 派单台账（M1 咨询档）：Leader 会话的每条用户消息 = 一次咨询派单。
          // M1「派与跑同刻」直接落 running（dispatched 留 M2 异步派单，schema 已留位）；
          // 放在文件保存失败返回之后 = 只记必达消息，三投递出口（resumePending 排队 /
          // resumeAgent 换流 / 直发 sendMessage）一次全覆盖。上岗引导走 create 的
          // initialPrompt 不经此处，天然不入账（org.ts 注释同口径）。
          if (mgr.isLeaderSession(cmd.payload.session_id)) {
            const dispatchId = randomUUID();
            mgr.pushOpenDispatch(cmd.payload.session_id, { id: dispatchId, tier: "咨询", actor: "user" });
            appendDispatch({
              ts: Date.now(), id: dispatchId, tier: "咨询", target: "org-leader",
              status: "running", session_id: cmd.payload.session_id, actor: "user",
            });
          }
          // agent 已死（Relay 重启遗留 / stop 收尾）或已放弃自愈（#109：放弃路径不再
          // 预杀树，僵流可能还挂着）：有 SDK 会话 id 就地 resume 复活（接管时补刀旧树）。
          // 停摆杜绝 R3（liveness 门，2026-10-13）：补第四态「僵尸流」——agent 对象在场、
          // ended 未翻 true（流 close 事件未到），但宿主进程已死（kill(0) 失败）：
          // 直发 sendMessage 会写进无人消费的死队列（1012~1013 停摆根因），并入判死走拉活。
          if (!mgr.agentStreamAlive(s)) {
            // #189 resume 互斥：上次 resume 的 agent 还在路上（spawn→onInit 窗口），
            // ended 只是流先关了——此刻再接管必然双拉（新 agent childPid 未就位，
            // 补刀落空 → 双进程）。消息走 sendMessage 排队：AsyncQueue 即 SDK prompt
            // 流，新流 init 后按序消费，语义与正常排队一致。
            // R3 口径备案：互斥窗内**不**加 liveness 守卫——窗内 childPid 常未就位
            //（spawn 异步填充），kill(0) 误杀会破互斥（189c 实锤）；窗内即夭由
            // init 看门狗兜底（超时 fresh 重放），liveness 门只管「窗外的稳态僵尸流」。
            // #27 补 !ended：codex 干净收口后 ended 恒 false（DONE 常驻），但 stop/
            // 早夭路径 ended=true 且窗口内——对 ended 的 agent sendMessage 只会被
            // 静默丢（codex 侧 console.warn），消息蒸发；一律走 resumeAgent 真拉活
            if (s.agent && !s.agent.ended && !s.wd.gaveUp && s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) {
              if (s.state.status === "ERROR" || s.state.status === "DONE") s.state.status = "WORKING";
              s.pendingImgRefs = imgRefs.length ? imgRefs : undefined; // FB14：回显槽先置（echo 同步消费）
              // P1FIX：push 先于 sendMessage（回显同步到达时账必须在），hold:"turn"
              // 让回显不出账——init 超时 fresh 回退靠账内条目合并重放（:3597 注释），
              // 出账时点 = 首个 ok 回合结束（onTurnEnd 清 hold:"turn"）
              const msgId = randomUUID();
              s.unacked.push({ id: msgId, text, images: imgPayload.length ? imgPayload : undefined, refs: imgRefs.length ? imgRefs : undefined, ts: Date.now(), hold: "turn" });
              mgr.persistRestartLedger(); // W-RESTARTDESIGN：入账写穿
              s.agent.sendMessage(text, imgPayload.length ? imgPayload : undefined, echo, msgId);
              mgr.emitUpdated(s, true);
              return { command_id: cmd.command_id, ok: true };
            }
            // W-LEADFIX：用户显式消息 = 手动恢复意图，越过熔断冷却照常拉起（streak
            // 不清零，onInit 成功才清——连发消息绕不过退避，连续失败冷却仍逐次翻倍）。
            // 自动路径（值守/回执/看门狗）没有这层豁免，死循环由此与手动路径分流
            if (s.resumeCooldownUntil && Date.now() < s.resumeCooldownUntil) {
              mgr.pushExternalLog(s.state.session_id, "system", "收到手动消息，越过恢复冷却尝试拉起");
            }
            // 停摆杜绝 R3：拉活失败的同步信号（无 SDK 会话记录=真拉不活）显式阻断——
            // 回执明确错误+通知面（stableKey 幂等），不再静默排队进死队列。手动豁免
            // 语义（W-LEADFIX：用户显式消息越冷却拉起）不变——冷却是退避不是死，
            // 只有同步不可恢复才拦。
            const agBefore = s.agent;
            const wasZombie = !!(agBefore && !agBefore.ended && !s.wd.gaveUp && agBefore.childPid);
            try {
              mgr.resumeAgent(s, text, imgPayload.length ? imgPayload : undefined, echo, imgRefs.length ? imgRefs : undefined);
              if (wasZombie) {
                mgr.pushExternalLog(s.state.session_id, "system", "检测到会话进程已断（消息未丢），已自动拉起恢复投递");
                mgr.upsertNotification("system", "liveness-revive", s.state.session_id, {
                  title: "会话进程已断，已自动复活",
                  body: `${s.state.title || s.state.session_id.slice(0, 8)}：检测到宿主进程已退出（liveness 门），消息已随自动拉起恢复投递，无需重发`,
                  severity: "info", group: "attention", actionable: false, sessionId: s.state.session_id, domain: "session", returnPath: "/",
                });
              }
              return { command_id: cmd.command_id, ok: true };
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err);
              mgr.upsertNotification("system", "liveness-block", s.state.session_id, {
                title: "消息未投递：会话进程已断且无法自动恢复",
                body: `${s.state.title || s.state.session_id.slice(0, 8)}：${why}——消息已退回未投递（点会话卡片可手动恢复后重发）`,
                severity: "waiting", group: "attention", actionable: true, sessionId: s.state.session_id, domain: "session", returnPath: "/",
              });
              return { command_id: cmd.command_id, ok: false, error: `会话进程已断且无法自动恢复，消息未投递：${why}` };
            }
          }
          if (s.state.status === "ERROR" || s.state.status === "DONE") {
            s.state.status = "WORKING";
          }
          const liveAgent = s.agent;
          if (!liveAgent) return { command_id: cmd.command_id, ok: false, error: "会话流不在场（liveness 窗口竞态）" }; // 类型窄化兜底（agentStreamAlive 已保证非空，逻辑不可达）
          s.pendingImgRefs = imgRefs.length ? imgRefs : undefined; // FB14：回显槽先置（echo 同步消费）
          // #7 看门狗重放账（P1FIX 2026-10-10 调序 + id 精确出账）：push 先于
          // sendMessage——adapter 的回显在 sendMessage 内同步发出并透传 ackId，账不在场
          // 则 findIndex 恒扑空（审计实锤的「永不按本条出队」根因）。已 init 会话无 hold
          // = 回显即出账（出账语义 = relay 已投递）；未 init（无 relay_session_id）保持
          // hold:"init"，pre-init 僵死检测与 onInit 清账接管。send 本身不推进
          // lastProgressAt（灌进死队列不是"进展"）
          const msgId = randomUUID();
          s.unacked.push({
            id: msgId, text,
            images: imgPayload.length ? imgPayload : undefined,
            refs: imgRefs.length ? imgRefs : undefined,
            ts: Date.now(),
            hold: s.state.relay_session_id ? undefined : "init",
          });
          mgr.persistRestartLedger(); // W-RESTARTDESIGN：入账写穿
          liveAgent.sendMessage(text, imgPayload.length ? imgPayload : undefined, echo, msgId);
          mgr.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_MODEL(cmd: any, by: string): CommandAckPayload {
          // #388 模型切换：注入 CLI 原生 /model slash 命令（托管 sendMessage / 外部 EXT_INPUT，
          // CLI 下一回合生效）；state.model 立即更新供端上显示（以 CLI 实际回报为准）
          const sid = String(cmd.payload.session_id ?? "");
          const model = String(cmd.payload.model ?? "").replace(/\[1m\]$/, "").trim();
          if (!model || !/^[\w.\/-]{1,80}$/.test(model)) {
            return { command_id: cmd.command_id, ok: false, error: "无效模型名" };
          }
          const s = mgr.sessions.get(sid) ?? mgr.sessions.get(`ext-${sid}`);
          // T10 残余收口：裸「会话不存在」不带 id=排查线索断绝（同文件 1969/7768 均带
          // id——本处漏网；用户侧报错对不上任何会话卡，等同「id 残缺」的另一形态）
          if (!s) return { command_id: cmd.command_id, ok: false, error: `会话不存在: ${sid}` };
          // #27 codex 拒收：模型接线在 ~/.codex/config.toml（relay 侧模型名是 Claude
          // 概念，注入 /model 只会被 codex 当普通文本跑一遍）
          if (s.state.engine) {
            return { command_id: cmd.command_id, ok: false, error: `${s.state.engine} 会话不支持运行时切换模型，请新建会话时指定` };
          }
          if (s.state.external) {
            if (!mgr.bridge) return { command_id: cmd.command_id, ok: false, error: "外部会话通道未就绪" };
            const r = mgr.bridge.extInput(s.state.session_id, `/model ${model}`);
            if (!r.ok) return { command_id: cmd.command_id, ok: false, error: r.error ?? "注入失败" };
          } else if (s.agent && !s.agent.ended) {
            s.agent.sendMessage(`/model ${model}`);
          } else {
            return { command_id: cmd.command_id, ok: false, error: "会话不可操作（已结束）" };
          }
          s.state.model = model;
          s.state.updated_at = Date.now();
          mgr.pushExternalLog(s.state.session_id, "system", `模型切换: ${model}`);
          mgr.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_STOP(cmd: any, by: string): CommandAckPayload {
          const s = mgr.requireLive(cmd.payload.session_id);
          void s.agent.stop();
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_CONTINUE(cmd: any, by: string): CommandAckPayload {
          const s = mgr.require(cmd.payload.session_id);
          // #212 remember_scope：allow 的同时落规则（可记忆性以当时下发的
          // WaitingPayload.remember 为准，relay 侧 suggestPattern 二次校验，危险形态不落）
          const scope = cmd.payload.remember_scope;
          if (s.state.external) {
            if (!mgr.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "allow", undefined, scope, by)) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            mgr.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "allow", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = mgr.requireLive(cmd.payload.session_id);
          if (!live.agent.allow(cmd.payload.request_id, by, scope)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_REJECT(cmd: any, by: string): CommandAckPayload {
          const s = mgr.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!mgr.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "deny", cmd.payload.reason)) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            mgr.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "deny", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = mgr.requireLive(cmd.payload.session_id);
          if (!live.agent.deny(cmd.payload.request_id, cmd.payload.reason, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_ANSWER(cmd: any, by: string): CommandAckPayload {
          const answers = (cmd.payload.answers as string[]).map((a) => a.trim()).filter(Boolean).slice(0, 4);
          if (!answers.length) {
            return { command_id: cmd.command_id, ok: false, error: "answers 不能为空" };
          }
          const s = mgr.require(cmd.payload.session_id);
          if (s.state.external) {
            // 外部会话：allow+updatedInput 把答案注入工具入参，CLI 视为已作答不再弹本地选择器
            const ansErr = mgr.bridge?.answerPending(cmd.payload.session_id, cmd.payload.request_id, answers);
            if (ansErr) {
              return { command_id: cmd.command_id, ok: false, error: ansErr };
            }
            mgr.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "answer", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = mgr.requireLive(cmd.payload.session_id);
          if (!live.agent.answer(cmd.payload.request_id, answers, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_DELETE(cmd: any, by: string): CommandAckPayload {
          const s = mgr.require(cmd.payload.session_id);
          if (s.state.status === "WORKING" || s.state.status === "WAITING") {
            return { command_id: cmd.command_id, ok: false, error: "会话运行中，不能删除" };
          }
          if (!mgr.deleteSession(cmd.payload.session_id)) {
            return { command_id: cmd.command_id, ok: false, error: "Leader 卡不可删除（逻辑常驻，锚是权威）；解散团队请清 org.json 锚后重启" };
          }
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_RENAME(cmd: any, by: string): CommandAckPayload {
          const s = mgr.require(cmd.payload.session_id);
          const title = cmd.payload.title.trim().slice(0, 40);
          if (!title) return { command_id: cmd.command_id, ok: false, error: "标题不能为空" };
          s.state.title = title;
          s.state.title_locked = true;
          s.state.updated_at = Date.now();
          // 落盘（跨重启回放）：外部会话重启后 ensureExternal 会从 transcript 重推标题，
          // 不落盘改名就静默丢失（"改好名字过一会变回去"）
          mgr.titleOverrides[s.state.session_id] = title;
          try {
            writeFileSync(join(mgr.cfg.dataDir, "title-overrides.json"), JSON.stringify(mgr.titleOverrides));
          } catch {}
          mgr.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            title,
            title_locked: true,
          });
          return { command_id: cmd.command_id, ok: true };
    },
  };
}
