# 018 后端工程实施方案：005 原型到真产品

- **版本**：018 v2 / backend implementation plan
- **日期**：2026-10-04
- **状态**：v2 定稿级实施方案；协议与拆批可直接派单，用户拍板项见第 6 章
- **范围**：relay 核心、web-console、expo 手机端、desktop-tauri 壳层、cc-plugins CLI 的后端支撑与协议落地
- **不在本单**：不改 005 视觉判定；不把本文件直接当作代码任务书；每一批实施前仍须由 Leader 从本文件提炼自包含任务书

> 本方案把 005 的 UI 组件还原成真实数据、事件和命令。已有能力均以当前源码为准；“需扩展/需新建”是实施设计，不代表已经存在。协议字段先改 relay 类型与双快照出口，再改三端镜像，避免前端先猜字段。

## 1. 总架构与 Agent 协作模型

### 1.1 系统全景

cc-deck 的生产边界不是一个前端页面，而是“每台工作机一个 relay、多个客户端通过 LAN 或云桥观察/命令、CLI/SDK 引擎被 relay 统一编排”的分层系统。

| 层 | 组成 | 责任 | 当前事实 |
|---|---|---|---|
| Relay 核心 | `session-manager.ts`、`ws-server.ts`、`event-bus.ts`、`history.ts` | 会话生命周期、命令路由、状态机、事件广播/重放、快照构建 | `SessionManager.snapshot()` 统一过滤已删除输出物：`relay/src/session-manager.ts:638-647`；LAN 连接策略在 `relay/src/ws-server.ts:270-274` |
| 组织/项目 | `org.ts`、`projects.ts`、`routing.ts` | 锚点、派单台账、项目组状态、成员编制、任务板、确认单 | 项目索引/板/确认单路径见 `relay/src/projects.ts:117-130`；派单日志为 append-only NDJSON：`relay/src/org.ts:191-254` |
| 引擎编排 | `agent-adapter.ts`、`agent-jsonl.ts`、Claude/Codex 适配器、`engine-registry.ts` | 把六类 `SessionEngine` 枚举映射成 `AgentLike` 与 `AgentCallbacks`；当前 Registry 只注册三类 JSONL 引擎 | 六类枚举见 `relay/src/types.ts:25-35`；当前 `EngineRegistry` 实际注册 Trae/Qwen Code/CodeBuddy 三类见 `relay/src/engine-registry.ts:36-61`；Claude/Codex 走既有专用路径，ZCode 目前未注册，必须显式 unsupported/fail-closed；能力位原则见 `specs/006-engine-adapters-spec.md:1-20` |
| LAN 客户端 | `web-console/index.html`、桌面内嵌 webview | 浏览器/桌面工作台，直连 relay WebSocket；Tauri 只负责壳、内置 relay 与系统能力 | 原型五域/桌面四层结构在 `specs/005-prototype-a.html:936-952`；桌面壳拉起内置 relay 在 `desktop-tauri/src-tauri/src/main.rs:461-523` |
| 手机客户端 | `expo-app` | 云桥/LAN 多源列表、详情、设置、通知、项目/团队视图 | 协议镜像和状态字段集中在 `expo-app/src/protocol.ts:1-176`；列表与详情分别由 `expo-app/src/screens/ListScreen.tsx`、`DetailScreen.tsx` 承载 |
| 云桥 | `cloud-client.ts`、Cloudflare bridge | E2E 密封转发、手机恢复、增量补发或全量快照；不解释业务事件 | 手机恢复策略是缓冲内重放，否则单帧预算快照：`relay/src/cloud-client.ts:348-385`；命令解密后进入 `SessionManager.handleCommand`：`relay/src/cloud-client.ts:595-602` |
| CLI/SDK 引擎 | Claude、Codex、Trae、Qwen Code、CodeBuddy、ZCode | 产生正文、工具调用、审批、用量、输出物与任务信息 | 适配器只向 `AgentCallbacks` 汇报；契约在 `relay/src/agent-adapter.ts:133-188`，JSONL 兜底在 `relay/src/agent-jsonl.ts:395-409` |
| 数据层 | 四类独立节点：`~/.cc-deck/org`、事件审计 `events.ndjson`、CLI task-store、artifact store | 组织资产、事件审计/重放、引擎原生任务、输出物登记/拉取各自负责，不互相冒充事实源 | `org` 物理边界见 `relay/src/org.ts:5-11,28-35`；事件追加和环形缓冲见 `relay/src/event-bus.ts:14-55`；task-store 见 `relay/src/task-store.ts:1-39`；artifact store 见 `relay/src/artifacts.ts:1-56` |

数据边界固定为：**relay 是当前源的业务真相，`events.ndjson` 是事件审计事实源，客户端状态只是投影，云桥只是传输，不成为第二业务数据库**。`events.ndjson` 不替代 `org/projects`、task-store 或 artifact store；后者各自保留自己的生命周期与回滚策略。输出物文件本体仍在源机器，跨端通过 relay/E2E 拉取，不把项目目录复制到云存储；现有协议已明确 `COMMAND_ARTIFACT_FETCH` + `ARTIFACT_CHUNK` 的实时传输方向，见 `relay/src/types.ts:424-432`。

relay identity 独立于云桥状态：v2 新增 `data/relay-identity.json`，首启生成稳定 `relay_id`，后续 LAN、cloud phone、WAN 三个 SNAPSHOT 出口都必带。现有 `cloud-keypair.json` 派生的可选 `relay_dev` 继续作为云桥兼容字段，但不再作为新客户端的唯一 merge key。旧 relay 没有 `relay_id` 时，客户端只能使用 `legacy:<relay_dev>`；连 `relay_dev` 也没有时使用 `legacy-endpoint:<normalized endpoint>` 并标记“不保证跨地址归并”，不得静默把不同源合并。

### 1.2 三张架构图的位置与文字解说

[成品图：018-fig-architecture.html](018-fig-architecture.html)（archify 交付，sha256 前 12 位 7b585aba8050，9/9 checks）

**图 1 图注：系统架构与信任边界。** Leader 重绘时必须从左至右表现“用户客户端 → LAN/Cloud Bridge → Relay Core → EngineRegistry/Adapter → CLI/SDK”，并在 relay 下方明确画出四个独立数据节点：`org/projects/boards/confirms`、事件审计 `events.ndjson`、CLI task-store、artifact store。EngineRegistry 节点标注“六类 SessionEngine 枚举 / 当前已注册三类；Claude/Codex 专用路径；ZCode unsupported”。引擎边拆成两条有向边：`Relay → Adapter/CLI：command/stdin` 与 `Adapter/CLI → Relay：JSONL/transcript events`。云桥只传递 E2E 密文；业务命令最终在源 relay 鉴权、幂等和执行。

[成品图：018-fig-dataflow.html](018-fig-dataflow.html)（Agent 任务单旅程图，runtime protocol 以 §3.1 parity matrix 为准）

**图 2 图注：任务单/Agent 旅程叙事。** 本版本选择审查员 R3 的方案 (a)：图 2 保持 Agent 任务单旅程（需求→编排→投递→执行→验收/固化），不再把它宣称为运行时协议流；这样与现有 archify 成品及图 3 的协作叙事一致。真正的运行时流不依赖图 2，统一由第 3.1 节的 SNAPSHOT parity matrix、命令状态机和文字契约承载：`COMMAND(command_id) → ACK → SessionManager/OrgAction → EventBus → LAN/cloud/WAN`，断线时 `last_seq → replay`，超出缓冲则 `SNAPSHOT + bounded logs`。Leader 重绘图 2 时应在图注或旁注写明“runtime protocol = §3.1”，不得补画成与任务单旅程混淆的第二套事实。

[成品图：018-fig-workflow.html](018-fig-workflow.html)（从设计到生产的工作流）

**图 3 图注：从设计到生产的工作流。** 用户拍板设计；PM 输出判定和规范；Leader 勘察源码、拆自包含任务、串行锁定同靶子、派 worker；worker 改代码并回执；Leader 用探针/真链路/双端对查验收并代提交；最后把实施差异固化到 004/013。任何状态不清先查 `events.ndjson` 与 ACK，不以聊天轮询推断成功。

图由 Leader 使用 archify 生成成品 HTML；本文件只保留占位和图注，不在此手画 SVG。

### 1.3 Agent 协作模型

| 角色 | 允许做什么 | 明确不做什么 | 交互协议 |
|---|---|---|---|
| 用户 | 拍板设计冲突、批准生产变更/合流/凭证/花钱、最终验收 | 不被动承担 worker 的逐步调度 | PM 设计单需要“建议直接做/须用户拍板”；生产动作需显式确认 |
| Leader | 源码勘察、事实核对、提炼任务书、派单、串行锁、探针/真链路验收、代提交、写回单 | 不下场替 worker 写实现；不替 PM 改设计口径；不绕过用户做生产变更 | `dispatch_id`/`command_id` 可追踪；收到 ACK 必须核 `ok:true`；完成回执固定含结果与改动文件 |
| PM | 设计判定、信息架构、规范条款、冲突收敛、DoD | 不改实现、不代替 Leader 验证源码事实 | 输出设计单/规范草案；设计结论优先于旧任务书，实施偏差由 Leader 标注 |
| worker | 在明确靶子文件内实施、写测试/探针、回分段报告和最终回执 | 不扩范围、不自行改变协议语义、不把过程日志灌回 Leader | 改前认领、改后 diff 摘要、零确认直做；最后一行按任务书格式回执 |
| 视觉审查员 | 逐屏核对层级、密度、双端形态和错投 | 不把无法看到的能力猜成缺陷 | 截图批次 + P2/P3/P1 + 明确暂不判定项 |
| 三角度审查员 | 从结构/语义/实现完整性三角度复核；抓错屏、假交互、重复信息 | 不越权改代码或改变已拍板规范 | 每项给证据、风险等级、重投/修复建议 |

派单通道必须把“角色协议”落成可验证字段：`dispatch_id` 贯穿 dispatched/running/done/failed；客户端命令必须有 `command_id`；回执必须包含同一 id、`ok`、错误或数据。`SessionManager.handleCommand` 已有重复 `command_id` 回放机制：`relay/src/session-manager.ts:1582-1597`；后续所有新命令复用这一机制。

#### 1.3.1 DispatchEnvelope / WorkerAck / WorkerReceipt

最小协议示例（字段名冻结，任务书可扩展 `metadata`，不得删除必填字段）：

```json
{
  "dispatch_id": "dsp_01J...",
  "command_id": "cmd_01J...",
  "actor": "leader",
  "target": { "session_id": "sid_...", "gid": "gid_...", "anchor": "/repo" },
  "tier": "随手办",
  "prompt": "任务书全文；含目标、边界、纪律、自查、回单路径、验收点",
  "acceptance": { "probe": ["relay/scripts/test-dispatch.ts"], "receipt_path": "/tmp/worker-receipt.md" },
  "created_at": 1790000000000,
  "attempt": 1,
  "metadata": { "engine": "codex", "model": "...", "provider": "..." }
}
```

```json
{
  "dispatch_id": "dsp_01J...",
  "command_id": "cmd_01J...",
  "ok": true,
  "accepted_at": 1790000001000,
  "worker_session_id": "sid_...",
  "status": "accepted"
}
```

```json
{
  "dispatch_id": "dsp_01J...",
  "command_id": "cmd_01J...",
  "status": "done",
  "result": "状态 dock 已接入并通过 fixture",
  "changed_files": ["relay/src/session-manager.ts"],
  "tests": [{ "cmd": "npm run test:sessions", "ok": true }],
  "evidence": ["/tmp/worker-receipt.md", "events.ndjson#seq=123"],
  "unresolved": [],
  "commit": "abc1234",
  "finished_at": 1790003600000
}
```

状态机：`dispatched → accepted → running → done|failed|cancelled`。Leader 发起并写 `dispatch-log.ndjson`；relay/派单通道触发 worker；worker 首次收到任务在租约内回 `WorkerAck(status=accepted)`；ACK 必须同 `command_id` 且 `ok:true` 才允许进入 running。超时未 ACK：一次短重试；仍无 ACK 转人工巡检，不自动重复派单。ACK 后无 receipt：按租约超时标记 `timeout`，Leader 可选择 `retry(attempt+1)`、`handoff` 或 `cancel`，不得无审计覆盖原单。worker 明确拒收回 `ok:false + error + reason`，不进入 running；执行中取消只允许由 Leader/用户有权限的命令触发，最终态仍保留原 receipt。任何 done/failed/cancelled 都不可回写成 running；重复 envelope 只回放首次 ACK/最终 receipt。

#### 1.3.2 命令权限与审计边界

`CommandBase` v2 增加可选 `auth`/`actor` 元数据：`{ device_id, role: owner|operator|viewer, capabilities: string[] }`。relay 端以已配对设备/本机 LAN token 解析真实连接身份，不能信任客户端自报的 `actor`；`actor` 只用于审计显示。至少三类写操作有 capability：`org:write`（团队/确认）、`profile:write`（引擎配置）、`artifact:read`/`artifact:batch`（输出物读取/批量）。缺 capability 统一 `COMMAND_ACK { command_id, ok:false, error:"forbidden", required }`，不执行副作用。权限模型的默认迁移策略属于第 6 章拍板项；在拍板前，新增高风险命令按最小权限拒绝，既有审批/消息命令保持当前兼容。所有拒绝、允许、重试都写 actor/device_id/command_id 到审计上下文。

## 2. 005 功能逐块后端映射

### 2.0 统一映射原则

本章三列含义固定：

- **已有**：当前源码已经提供可复用的事实或协议，必须写 `file:line`；前端原型只是视觉示意，不算后端能力。
- **需扩展**：已有事实能支撑主流程，但需要补字段、聚合、授权、持久化、事件或客户端镜像。
- **需新建**：当前没有可直接复用的生产能力，需要新增文件、EventType、COMMAND 或持久化投影。

所有扩展遵循两条红线：①不把跨引擎差异塞进 `SessionManager` 的 `if (engine===...)`；②同一字段同时检查 LAN `ws-server.ts` 和云桥 `cloud-client.ts` 快照出口，不能只改一端。`SnapshotPayload` 当前明确说项目与确认单字段需要两处同步，见 `relay/src/types.ts:315-338`。

### 2.1 会话域

#### 2.1.1 第二列：待处理/其他会话单流

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| `SessionState.status/action_summary/waiting_request/todos/last_task_done/project_gid/updated_at` 已存在，见 `relay/src/types.ts:96-153`；`snapshot()` 可下发所有会话，见 `relay/src/session-manager.ts:638-647`；005 桌面原型现有行动/全部双视图节点，见 `specs/005-prototype-a.html:951-952`。 | 固定协议语义 `queue_flags`：`needs_action`、`is_working`、`needs_acceptance`、`is_other`、`reason`。优先客户端派生，只有跨设备必须一致的规则才由 relay 附带。 | 删除双视图语义后，新建每端纯函数/协议 fixture；不建数据库。`queuePartition` 不是现有共享代码层，Web/Expo 各自实现但使用相同 fixture。组头 `待处理/其他会话` 计数只能来自过滤后实际渲染卡数，不能使用源总数。桌面搜索/源/项目/状态筛选作为列表工具行，手机一期不额外增加筛选协议。 |

推荐分组规则：`needs_action` 优先，条件为真实 `WAITING` 可决策、待验收/确认类持久行动、或已有任务/通知明确要求用户动作；普通 `WORKING` 只在确有可观察工作状态时进入“待处理”，不能因为在线就占行动位；其余进入“其他会话”。同一 `session_id` 必须互斥，只出现一次。

#### 2.1.2 详情对话 pane 与 AI 无框消息

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| 日志由 `LogEntry` 统一表示，含 `ts/kind/text/full/id/streaming/detail/diff`，接口均定义在 `relay/src/types.ts:203-214`；`pushExternalLog` 支持同 id 原地替换和 `SESSION_LOG` 广播，见 `relay/src/session-manager.ts:1535-1555`；适配器通过 `onLog` 把 `assistant_text/tool_use/tool_result/system/user_message` 送入统一回调，见 `relay/src/agent-adapter.ts:155-164`。 | 保持正文流协议不变，补充 `speaker/role` 的可靠来源（托管会话默认 agent，用户消息为 user，团队成员由 `project_gid + session_id` 解析），并把源/引擎身份作为元信息而非正文。`full` 仍只用于长文/markdown，前端按 id 替换流式块。 | 共享的是协议语义，不是假设已有 shared package：Web 在 `web-console/index.html`、Expo 在 `expo-app/src/store.ts`/`DetailScreen.tsx` 各自实现 `renderMessage`。AI/Leader/worker 使用头像行+无框正文，用户使用气泡；relay 不新增“气泡事件”。 |

时间口径：`relay/src/types.ts:11-21` 的 Envelope 与 `relay/src/types.ts:203-214` 的 LogEntry 当前都是 relay 记录/接收时间，底层 `Date.now()` 记账见 `relay/src/event-bus.ts:29-35`，不能把它宣称为模型/工具实际生成时间。若审计或 dock 需要生成时间，适配器在 `meta` 增加可选 `occurred_at`；缺失时显示“收到时间”，不伪造精度。旧日志只含 `ts` 时继续按接收时间排序。

#### 2.1.3 状态 dock：任务级摘要 + 操作级活动

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| `SessionStatus` 四态、`action_summary`、`turn_started_at`、`duration_ms`、`waiting_request` 已在 `SessionState`，见 `relay/src/types.ts:37-41`、`96-123`；适配器有 `onStatusChange`、`onWaiting`、`onWaitingResolved`，见 `relay/src/agent-adapter.ts:133-143`；状态变更由 `session-manager.ts:2358-2398` 接入。 | 把当前任务摘要从 `todos.in_progress.active_form`、项目板条目、dispatch prompt/回执中按优先级派生；把操作级摘要从 `SESSION_LOG.kind=tool_use/tool_result` 与 `onStatusChange(actionSummary)` 派生。`SESSION_UPDATED` 增加可选 `activity` 当前值和 `activity_capabilities`，`SNAPSHOT.sessions` 同构携带。活动更新必须节流/去重，不能每个 token 都写状态事件。 | 新增短生命周期 `SESSION_ACTIVITY` 瞬态 EventType（不落 `events.ndjson`、不进入重放），用于在线 dock 的高频操作；当前活动同时写入 `SessionState.activity`，让断线后 SNAPSHOT 能恢复最后一条。新增共享 `StatusDockState` 类型和四态/活动映射测试。 |

状态语义：

1. **任务段**是稳定上下文，例如“回填验收证据”；来源是任务清单/派单/项目板，不随着每个工具调用抖动。
2. **活动段**是当前具体操作，例如“正在执行 npm test”；来源是可靠的 tool/use/result 或引擎状态。无活动能力时只显示四态+任务段。
3. **WAITING** 时 dock 只显示“等待处理”或四态词，不复制 wait-card 的工具输入、允许/拒绝和 Bash 文案；`waiting_request`/wait-card 是授权细节唯一来源。
4. **DONE/ERROR** 时 dock 保留一次短反馈；新回合开始或用户关闭详情后清理过期活动，不能把上一回合操作当作常驻当前状态。

#### 2.1.4 wait-card

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| `waiting_request` 字段与 `WaitingPayload` 已有，含 `request_id/tool_name/input_summary/questions/decidable/remember`，见 `relay/src/types.ts:271-281`；`COMMAND_CONTINUE/REJECT/ANSWER` 已在命令协议，见 `relay/src/types.ts:562-677`；`SESSION_WAITING(_RESOLVED)` 已进入事件类型，见 `relay/src/types.ts:356-390`。 | 统一 `decidable=false`、AskUserQuestion、远程审批超时和 superseded 的客户端降级；每次 waiting 变化必须同时清 `SessionState.waiting_request`、状态和 dock 活动，避免残留假等待。 | 暂不新建审批存储；若要支持跨 relay 长期待处理，只增加通知投影，不复制 waiting 生命周期。审批动作继续回来源会话。 |

#### 2.1.5 输出物 tab：目录组

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| `ArtifactItem` 已有路径、操作、工具、增删、首末时间、大小、存在性、origin，见 `relay/src/types.ts:78-94`；适配器 `onArtifacts` 已有，见 `relay/src/agent-adapter.ts:142-143`；文件登记和 re-stat 已有，见 `relay/src/session-manager.ts:1143-1217`、`1224-1264`；交付目录在 `relay/src/artifacts.ts:26-56`。 | 固定目录组协议：组键=源内归一化父目录；组头带 `directory_key/file_count/failed_count/last_at/has_downloadable`；文件行仍使用平铺 `ArtifactItem`，客户端共享分组函数。批量下载状态由 relay 以组级 job id 返回，失败文件可单独重试。 | 新建 `ArtifactGroupSummary` 和按组批量拉取命令（一期可先只做组内文件列表与单文件 `COMMAND_ARTIFACT_FETCH`）；多源场景给每个 relay 结果附 `source_id/relay_dev`，相同路径不合并为同一物理目录。 |

目录组不是实体卡，后端只负责稳定分组、失败态和下载授权；桌面/手机的无框分组视觉由前端实现。旧版目录折叠、文件行和远程拉取经验已记录在 `specs/014-legacy-adoption.md:1-73`。

### 2.2 团队域

| 005 UI 区域 | 已有（file:line） | 需扩展 | 需新建 |
|---|---|---|---|
| queue 卡 | `ProjectGroup` 有 name/anchor/status/tier/headcount/single_card，`relay/src/projects.ts:40-61`；快照 `SnapshotPayload.projects/org_confirms` 已有，`relay/src/types.ts:330-338`；web 组织区由快照和增量重渲染，`web-console/index.html:4506-4524`。 | 派单承接会话补齐 `project_gid/dispatch_tier` 的实时一致性；队列卡需从 group 状态、open dispatch、pending confirm 统一计算行动原因。 | 新建共享 `TeamQueueProjection`，只做纯投影，不再建第二份 team DB。 |
| 看板 | `ProjectBoard`、`BoardEntry`、`boards/<gid>.json` 已有，`relay/src/projects.ts:63-88`、`117-130`；`BOARD_UPDATED` 与 `COMMAND_PROJECT_DETAIL` 已有，`relay/src/types.ts:404-411`、`752-758`。 | 增加 board 条目与 worker `dispatch_id/owner_session` 的一致性探针；快照不内嵌整板，详情按需拉取保持帧小。 | 暂不新建板存储；若需要手机首屏摘要，只新增 `BoardSummary`，不把完整板塞入 SNAPSHOT。 |
| 对话 pane | 成员会话均是 `SessionState`，项目归属字段已有 `project_gid`，见 `relay/src/types.ts:136-141`；日志 `SNAPSHOT.logs` 按 session_id 提供，见 `relay/src/types.ts:315-323`。 | 按 group headcount/`project_gid` 聚合成员会话，定义排序=最近活动；排除已退休、已删和跨组会话；聚合前保留 source/session 标识；时间优先 `occurred_at ?? ts`。 | 新建 `TEAM_LOG` 只是可选优化；一期由客户端对现有 logs 做聚合，避免复制消息事实源。成员归档身份必须参与 join，保证历史行不随 headcount 变化改名或消失。 |
| 成员 pane | 编制快照 `headcount` 与 add/remove member 已有，`relay/src/projects.ts:305-346`；成员引擎/模型/provider 字段见 `ProjectHeadcountEntry:26-32`。 | 提供成员在线/最近活动/状态的 join：以 `session_id` 查当前快照，找不到只显示档案态；退休成员不得被误标在线。 | 不新建全局 members 表；项目组 headcount 是组织成员的现行事实；项目存储新增不可变 `member_archive[]`，字段至少含 `session_id/role/engine/model/provider/display_name/avatar_key/joined_at/retired_at`。 |
| 活动 pane | 派单台账 `DispatchEntry` 有状态、回执、session、actor，`relay/src/org.ts:191-215`；收口时 `DISPATCH_DONE` 已广播，`relay/src/session-manager.ts:3295-3305`。 | 给前端一个按 gid/session 的活动投影，保留 dispatched/running/done/failed 全生命周期；失败回执仍注入 Leader。 | 新建 `TeamActivityProjection` 读侧，不新增事实日志。 |
| footer 状态驱动 | 团队状态机 `pending/active/parked/archived` 与迁移规则已有，`relay/src/projects.ts:23-24`、`197-210`；确认单 kind/status 已有，`relay/src/projects.ts:90-108`。 | 明确按钮计算：只有 pending confirmation 才显示确认编制；其他状态只显示 composer/去看板；状态变化同时来自 `PROJECTS_UPDATED/ORG_CONFIRM_UPDATED/BOARD_UPDATED`。 | 暂不新建 footer 命令；确认继续 `COMMAND_ORG_CONFIRM`，写操作回 orgAction 单漏斗。 |
| 新建团队轻入口 | 组织 CLI `org create` 生成项目组/确认单，模板位于 `relay/src/org.ts:261-280`；服务端组织动作入口在 `relay/src/session-manager.ts:3312-3738`。 | 为手机/桌面统一提供认证的创建命令或 HTTP 委托；创建成功返回现有 `{group, needsConfirm, confirm?}`，不能让前端只改本地卡。 | 新增 `COMMAND_ORG_ACTION`（一期只允许 create），命令层由 `{anchor_dir}` adapter 到现有 `orgAction("project-create", {anchor})`，加入 `ws-server.ts` allowlist 和 `Command` union。 |

团队对话“聚合”只是一种视图，不创建团队消息副本；所有回复仍通过具体 `session_id` 发给成员会话。这样团队 pane 可读、原域可写，符合 `specs/007-notify-domain-ia.md:19-35` 的单一写面原则。

### 2.3 项目域

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| 项目索引、锚点、状态、tier、headcount、板和确认单已由 `projects.ts` 提供，见 `relay/src/projects.ts:40-130`；项目详情按需返回 group/board/receipts 的 ACK 口径在 `relay/src/types.ts:752-758`、`895-910`；项目源选择器/单源与聚合视觉开关在 `specs/005-prototype-a.html:939-952`。 | 指标带统一聚合来源：会话数=源内有效 session；活跃团队=headcount/active group；输出物数=存活 ArtifactItem；需行动=真实 actionable projection。路径统计不再与 sub 行重复。项目输出物必须按全局源模式过滤，源间相同路径标记为独立副本。 | 新建 `ProjectSourceProjection`：`source_id/anchor_key/reachability/duplicate_path_count`；新增跨源副本比较只做元数据（路径、mtime、size、hash 可选），不默认读取全量文件，也不合并副本。 |

单源模式由客户端只请求/显示当前 source；多源聚合模式由客户端合并各 relay 的公开快照并保留稳定 `relay_id`。当前云桥 `relay_dev` 已随快照下发，见 `relay/src/cloud-client.ts:364-383`，但它是可选兼容字段，不可作为唯一 merge key；新实现使用独立持久 `data/relay-identity.json`，旧 relay 按 `legacy:<relay_dev>` 或归一化 endpoint fallback 并标记 legacy。

### 2.4 通知域

通知采用 `007 B+`：通知只持有 alert 与来源上下文，轻动作可快捷执行，重流程回会话/团队原域；规范依据 `specs/007-notify-domain-ia.md:19-35`。

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| `decision-notify.ts` 已有 org-confirm/waiting watcher、去重 key、首推/提醒/解决 ledger，见 `relay/src/decision-notify.ts:6-35`、`83-107`、`177-245`；默认文件已是 `cfg.dataDir/decision-notifications.json`，路径构造见 `relay/src/decision-notify.ts:50-55`；`notifyConfirm` 会写待确认并发 `USER_NOTE`，见 `relay/src/session-manager.ts:1045-1052`；org/board/confirm 增量帧已存在，见 `relay/src/session-manager.ts:3741-3749`。 | 扩展既有 ledger，不新建第二个 `notifications.json`：增加 `handled_at/dismissed_at/sourceContext/group/severity` 等投影字段；将 decision key 映射为 `需你行动/注意/动态`，分组计数只统计当前可行动 alert，通知不因打开自动清零。`sourceContext` 必须带 `domain/entityId/segment/alertId/returnPath`，跳转和返回不靠标题匹配。 | 新建 `NotificationItem`/`NOTIFICATIONS_UPDATED` 的类型与双快照投影，以及 `COMMAND_NOTIFICATION_ACK`（仅标记已处理/已读，不改变来源实体状态）；持久文件仍固定为 `cfg.dataDir/decision-notifications.json`，与现有 decision ledger 单一写面。 |

通知事实仍来自确认单、waiting、dispatch/acceptance/session 事件；通知投影不是第二状态机。用户点开卡不清零；只有来源动作成功或用户明确“已知/关闭”才更新 notification projection。离线端以 SNAPSHOT 恢复，在线端以瞬态更新，不能只依赖 `USER_NOTE`，因为 `EventBus.emitTransient` 明确不落盘、不补发，见 `relay/src/event-bus.ts:58-73`。

### 2.5 设置域

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| 雇员独立家设置支持读取、写盘、锁定和 `SETTINGS_UPDATED`，见 `relay/src/session-manager.ts:649-671`；插件配置 GET/POST 在 `relay/src/ws-server.ts:43-61`、`1057-1105`；模型列表由 relay 快照下发，web 渲染在 `web-console/index.html:8258-8270` 附近。 | 006 的 provider 配置必须进入 EngineRegistry preflight，不在设置页硬编码某一 CLI；能力位、缺失 usage/approval/telemetry 要显示降级原因。卡片密度是客户端偏好，跨端统一默认值，但不应写入 relay 业务事件。配置目录冻结：通知仍落 `cfg.dataDir/decision-notifications.json`，profile 使用 `cfg.dataDir/engine-profiles.json`，秘密只存 env/keychain reference；不新增 `CCR_*`。 | 新建 `COMMAND_ENGINE_PROFILE_UPDATE` 仅在用户确认后写入受控 provider profile；凭证只存环境变量引用/系统密钥标识，不把明文 key 放 SNAPSHOT。ZCode 隐私开关按 `specs/006-engine-adapters-spec.md:1-20` 的 fail-closed 规则实施。生产默认端口保持 `8787`，桌面 M2 变体使用 `8788`，不新增端口；依据 `relay/src/config.ts:50-65`、`desktop-tauri/src-tauri/src/main.rs:376-383`。 |

### 2.6 源管理与连接胶囊

| 已有 | 需扩展 | 需新建 |
|---|---|---|
| source switcher、source mode、连接胶囊和多源聚合是 005 原型现有结构，见 `specs/005-prototype-a.html:308-331`、`683-692`；web 端连接条目/云桥身份归并逻辑见 `web-console/index.html:2761-2815`；手机 Setup 对源状态的读取见 `expo-app/src/screens/SetupScreen.tsx:406-436`。 | 快照补齐稳定 `relay_dev`、source health、last_seen、capability/version；源胶囊只显示状态点+源名+必要异常，源级统计不在顶部重复。LAN/云桥同源按 relay identity 归并。 | 若要让多源项目副本有稳定关联，新建客户端 `SourceIdentity`/`SourceProjection`，不在 relay 之间同步项目文件；跨源 merge 只发生在客户端 projection 层。 |

### 2.7 手机端对应位（Expo）

| 005 位 | 已有 | 需扩展/新建 |
|---|---|---|
| root 列表 | `ListScreen` 已消费多源、项目组、确认单和 `snap.sources`，相关路径见 `expo-app/src/screens/ListScreen.tsx:545-695`、`929-1054`。 | 删除旧的 `待处理/全部会话` 双切换，使用待处理置顶单流；summary 统计固定为单流口径；性能上按 source/session memoize，不在每次 SESSION_LOG 重建整屏。 |
| 详情对话 | `DetailScreen` 已根据 `s.waiting_request` 渲染审批，见 `expo-app/src/screens/DetailScreen.tsx:1886-2056`；输出物按父目录分组，见 `expo-app/src/screens/DetailScreen.tsx:2455-2600`。 | 接入无框 AI 消息、双段 dock、活动能力位、目录组协议；等待卡仍独占授权详情；手机 dock 位于 composer 前，活动文字节流。 |
| 项目/团队 | `ListScreen` 已展示 headcount、项目详情按 `COMMAND_PROJECT_DETAIL` 拉取，见 `expo-app/src/screens/ListScreen.tsx:563-705`。 | 指标带/聚合列表行与桌面同对象同判定；团队对话按成员 session 聚合，手机不复制写面。 |
| 设置/连接 | `SetupScreen` 已支持源连接编辑、配对、remember token，见 `expo-app/src/screens/SetupScreen.tsx:92-331`、`406-436`。 | 引擎 provider/能力位/隐私警示进入设置；源胶囊轻量化；新增协议字段必须同步 `expo-app/src/protocol.ts`，旧 relay 缺字段按能力隐藏。 |
| 通知 | `notify.ts`/App 已有前台通知能力，见 `expo-app/App.tsx:10-12`；多源确认汇总依赖 `snap.sources`，见 `expo-app/src/screens/ListScreen.tsx:1025-1054`。 | 接入持久通知 projection、分组计数与 sourceContext 返回栈；通知打开不清零，动作成功后再更新。 |

## 3. 数据模型与协议扩展

### 3.1 EventType、SNAPSHOT、COMMAND 缺口清单

当前 `EventType` 实际约 24 类，完整枚举与 payload 映射在 `relay/src/types.ts:356-380`；“24 类”是当前代码计数，新增类型落地后以源码枚举为准。扩展按下表执行。`LogEntry`、命令 Envelope 与快照镜像均以 `relay/src/types.ts` 为 canonical source，不另造 `Envelope.ts`/`LogEntry.ts`。

#### 3.1.1 SNAPSHOT parity matrix（B0 首先产出）

B0 的第一件交付物不是新字段，而是逐字段 parity matrix。每一行必须同时记录 LAN `relay/src/ws-server.ts:887`、cloud phone `relay/src/cloud-client.ts:364`、WAN `relay/src/cloud-client.ts:692` 的装配情况、旧 relay 行为、Expo 镜像字段与缺失时的降级。至少覆盖当前已存在但不对称的 `models`、`homedir`、`deliverables`、`acceptances`、`relay_dev`、`relay_name`、`projects`、`boards`、`confirms`、`logs`、`last_seq`；`models` 的 LAN 已有而 cloud 缺失事实见 `relay/src/ws-server.ts:901-905` 与 `relay/src/cloud-client.ts:375-401`。现有 ad-hoc 字段必须先补进 `SnapshotPayload`（`relay/src/types.ts:315-338`）及 `expo-app/src/protocol.ts`，再增加本方案的新字段。

| 字段族 | LAN | cloud phone | WAN | 旧端/缺失降级 | B0 证据 |
|---|---|---|---|---|---|
| sessions/logs/last_seq | 必须有 | 必须有 | 必须有或明确不支持 | 缺失时空列表/从 SNAPSHOT 重建，不崩溃 | 三出口 fixture + seq-gap fixture |
| models/homedir | 补齐类型与镜像 | 补齐或标记 unsupported | 明确是否下发 | UI 隐藏能力，不显示假数据 | model parity regression |
| deliverables/acceptances | 补齐类型与镜像 | 补齐或保留旧端缺失 | 明确是否下发 | 输出物/验收入口降级为不可用 | artifact/acceptance fixture |
| relay_id/relay_dev/relay_name | `relay_id` 必带，旧字段兼容 | 同上 | 同上 | 旧 relay 使用 `legacy:<relay_dev>` 或 `legacy-endpoint:<normalized endpoint>` | source identity fixture |
| 新增 notifications/activity/capabilities/schema_version | 仅 B0 后装配 | 同构装配 | 同构或显式 unsupported | 未知字段忽略、缺失按能力位隐藏 | old/new client fixture |

矩阵是协议事实表，不以“LAN 与 cloud 代码路径相似”替代。任何新增字段若三出口未登记，禁止进入客户端批。

| 编号 | 类型 | 状态 | 用途与字段 | 白名单/接线 | 双快照纪律 |
|---|---|---|---|---|---|
| E1 | `SESSION_ACTIVITY` | 新建 | 在线 dock 当前活动：`session_id, state, activity_kind, text, tool?, observed_at, occurred_at?, capabilities, seq_local`；`seq_local` 仅调试，不冒充全局 seq | 加入 `EventType/EventPayloadMap`；`SessionManager` 由 `onLog/onStatusChange` 节流发；LAN/cloud 监听；不进 `COMMAND_TYPES` | 不作为历史事实；`SessionState.activity` 和 `SnapshotPayload.sessions[].activity` 作为最后值，两出口同字段 |
| E2 | `NOTIFICATIONS_UPDATED` | 新建 | 通知投影全量或变更：`items[]`，每项含 `key, kind, severity, title, body, sourceContext, actionable, created_at, resolved_at?, handled_at?` | EventBus transient；web/expo reducer；旧端忽略未知 type | `SnapshotPayload.notifications` 同构；LAN `ws-server.ts` 与云 `cloud-client.ts` 都装配 |
| E3 | `PROJECT_SOURCE_UPDATED` | 可选 | 项目跨源副本变化摘要；一期可由现有 `PROJECTS_UPDATED` + source snapshot 合并，不强制新增 | 若新增，加入 `EventType` 与两端事件转发 | 快照必须同源；不能只有 web 端知道副本 |
| E4 | `ARTIFACT_GROUP_UPDATED` | 可选 | 目录组计数/下载 job 状态；一期先由 `SESSION_UPDATED.artifacts` 客户端派生 | 仅在批量下载真正进入 relay job 后新增；否则不造空事件 | `Snapshot` 可恢复 job/失败摘要，不能仅靠瞬态 toast |

新增 `SnapshotPayload` 字段：

```text
sessions[].activity?: StatusDockState
sessions[].activity_capabilities?: ActivityCapabilities
notifications?: NotificationItem[]
source_capabilities?: SourceCapabilities
schema_version?: number
```

`schema_version` 只做能力协商，不用来阻断旧端；未知字段忽略，缺失字段按“旧 relay 不支持”处理。`occurred_at` 只在 `relay/src/types.ts` 的 `LogEntry`、`SessionLogPayload` 与 `expo-app/src/protocol.ts` 三处一次定型；没有引擎原生产生时间时保留 `ts` 并标注为 relay 接收时间。`SESSION_ACTIVITY` 拆成 durable/transient 两层：transient 帧在线高频、不落 `events.ndjson`、不重放；最后值进入 `SessionState.activity`/SNAPSHOT。项目/板/确认现有双快照约束见 `relay/src/types.ts:330-338`，本方案将同样纪律推广到新增字段。

新增 `COMMAND`：

| 命令 | 最小 payload | 行为 |
|---|---|---|
| `COMMAND_ORG_ACTION` | 命令层 `{action:"create", name, anchor_dir, tier}` | 由 adapter 映射为现有单漏斗 `orgAction("project-create", {anchor: anchor_dir, name, tier})`；现有入口只认 `project-create` 与 `p.anchor`，见 `relay/src/session-manager.ts:3317-3338`；CLI 形状见 `relay/src/org.ts:301-307`。ACK `data` 固定为 `{group, needsConfirm, confirm?}`，对应实际返回 `relay/src/session-manager.ts:3352-3356`，禁止 worker 猜测为 `gid/status`。 |
| `COMMAND_NOTIFICATION_ACK` | `{notification_key, action:"handled"|"dismissed"}` | 只更新通知投影，不直接改变会话/团队/项目状态；重流程必须回来源命令 |
| `COMMAND_ENGINE_PROFILE_UPDATE` | `{engine, provider, profile_ref}` | 更新非秘密 profile 引用，触发 preflight；密钥不进 payload 持久化 |
| `COMMAND_ARTIFACT_GROUP_FETCH` | `{session_id, group_key}` | 可选二期；返回组级文件清单/下载 job；一期沿用 `COMMAND_ARTIFACT_FETCH` |

每个命令都必须：

1. 加入 `relay/src/types.ts` 的 `CommandType`、接口、`Command` union；
2. 加入 `ws-server.ts` 的 `COMMAND_TYPES` allowlist（当前白名单在 `relay/src/ws-server.ts:138-174`）；
3. 在 `SessionManager.execCommand/handleCommand` 接线；
4. 通过 `COMMAND_ACK` 回同一 `command_id`，`ok:false` 也算已处理回执；
5. LAN 与 cloud 共用同一 `COMMAND_TYPES` allowlist 和权限判定；云桥解密后复用 `handleCommand`，现有路径见 `relay/src/cloud-client.ts:595-602`，不得只在 LAN 入口校验；
6. `execCommand()` 必须有统一 `default`，返回 `{command_id, ok:false, error:"unsupported command"}`；旧 relay 收到新客户端未知命令也必须返回可判定 ACK，不能返回 `undefined`；
7. 加入“新客户端→旧 relay（LAN/cloud）”fixture、relay/web/Expo 协议 fixture；旧客户端对未知命令/未知事件安全忽略。

#### 3.1.2 命令权限、身份与成员归档

命令来源统一带 `actor {actor_id, device_id, role}` 与 `source {lan|cloud, relay_id}`。一期权限矩阵固定为：`owner/operator` 可执行 `org:write`（仅 create）、`profile:write`（非秘密 profile 引用）、`artifact:read`/`artifact:batch`（后者需显式 capability）；`viewer` 仅读。拒绝统一返回 `COMMAND_ACK {command_id, ok:false, error:"forbidden"}`，且写入审计事件。权限不是前端隐藏按钮。

relay identity 独立于云桥状态生成并持久化到 `data/relay-identity.json`，LAN/cloud/WAN SNAPSHOT 均必带 `relay_id`；可选 `relay_dev` 只能作为云桥兼容字段，不能作为新客户端唯一 merge key。旧 relay 依次使用 `legacy:<relay_dev>`、`legacy-endpoint:<normalized endpoint>`，并标记 `identity_legacy=true`。

项目存储增加不可变 `member_archive[]`（或等价地在 dispatch/receipt 固化成员身份快照），至少包含 `session_id, role, engine, model, provider, display_name, avatar_key, joined_at, retired_at`。团队 timeline join 规则是 live session 优先，缺失时回退 archive snapshot；成员退休后历史消息仍显示归档身份，不能因当前 headcount 变化改写历史。

#### 3.1.3 引擎 capability matrix

| `SessionEngine` 枚举 | Registry/路径 | preflight 与失败语义 |
|---|---|---|
| Claude | 专用 Claude adapter/path | preflight 检查 SDK/凭证/版本；失败返回 unsupported 或配置错误，不伪造 activity |
| Codex | 专用 Codex adapter/path | preflight 检查 CLI/凭证/版本与 JSONL 能力；失败 fail-closed |
| Trae | `EngineRegistry` 已注册，见 `relay/src/engine-registry.ts:36-61` | JSONL mapper 能力位；缺操作摘要时显示能力缺失 |
| Qwen Code | Registry 已注册 | 同上 |
| CodeBuddy | Registry 已注册 | 同上 |
| ZCode | 枚举存在于 `relay/src/types.ts:25-35`，当前未注册 | 显式 `unsupported`/fail-closed；不得因枚举存在而加入默认列表 |

该矩阵同时区分“六枚举”和“当前 Registry 三类已注册”，不把枚举存在、已注册、可用凭证混为一谈。

### 3.2 状态 dock 数据源契约

```text
StatusDockState {
  state: WORKING | WAITING | DONE | ERROR;
  task_summary?: {
    text: string;
    source: "todo" | "dispatch" | "board" | "session";
    updated_at: number;
  };
  activity?: {
    kind: "tool_use" | "tool_result" | "assistant_text" | "system";
    text: string;
    tool?: string;
    observed_at: number;
    occurred_at?: number;
  };
  elapsed_ms?: number;
  capabilities: {
    native_status: boolean;
    operation_summary: boolean;
    native_elapsed: boolean;
    approval: boolean;
  };
  updated_at: number;
}
```

语义与引擎能力：

| 引擎/来源 | 四态 | 操作摘要 | 原生耗时 | 审批 |
|---|---|---|---|---|
| Claude SDK | `onStatusChange` 全 | tool block/`onLog` 可给 | relay 用 `turn_started_at` 计算，原生时间可选 | `onWaiting`/allow/deny |
| Codex | 由 adapter/转录映射，未知时保守 WORKING/ERROR | JSONL 有 tool/assistant 时给；只有普通文本时显示“引擎输出中” | relay 计算 | 只有真实远程 decision channel 才置 true；不能伪造 WAITING |
| Trae/Qwen Code/CodeBuddy | 由 JSONL mapper 能力位决定 | 有事件给，无事件显示能力缺失 | relay 计算 | 默认 false，除非真实冒烟确认 |
| ZCode | 先过隐私/遥测 preflight | 不确定时不启动，不显示假活动 | relay 计算 | 默认 false |
| 外部 CLI | bridge transcript/onLog | tool/assistant 可给，时间字段视 transcript | relay 接收时间兜底 | `remote_mode` 与真实 waiting_request 决定 |

强制规则：`relay/src/types.ts:11-21` 的 Envelope 与 `relay/src/types.ts:203-214` 的 LogEntry 缺乏原生产生时间时，UI 文案使用“收到”；任何 `occurred_at` 必须来自引擎事件或 bridge 的明确时间，不可由客户端从网络延迟倒推。活动节流建议 100–250ms 合并同工具连续更新，最终结果必须单独收口。

### 3.3 通知分组协议

`NotificationItem` 统一为：

```text
key: stable source key (org-confirm:<id>:<revision> / waiting:<sid>:<request_id> / dispatch:<id> / ...)
kind: org-confirm | waiting | dispatch | acceptance | system
group: action | attention | activity
severity: info | working | waiting | error | done
title/body: human-readable summary
sourceContext: { domain, entityId, sessionId?, segment?, alertId, returnPath }
actionable: boolean
created_at/resolved_at/handled_at: number?
```

- `action` 组计入 badge；`attention/activity` 不自动计入需行动数。
- 分组头计数=该组当前渲染 item 数，不是“所有历史产生数”。
- 打开、浏览、重连不清零；来源动作成功或用户明确 dismiss 才变 handled。
- `USER_NOTE` 继续作为瞬态横幅，不当作通知持久层；当前 `USER_NOTE` 的 seq:0、不落盘、离线不补发语义见 `relay/src/event-bus.ts:58-73`。

### 3.4 输出物目录化协议

一期以扁平 `ArtifactItem[]` 为兼容基础，统一分组函数：

```text
group_key = normalize(parent(path), source_id)
directory_label = display parent relative to session cwd
sort = last_at DESC, then path
group summary = file_count, failed_count, latest_at, source_id, reachable
```

`exists:false`、不可达源、下载失败属于文件/源状态，不改变组的实体性质。目录组头只提供折叠、批量动作和恢复入口；单文件拉取继续复用现有 `COMMAND_ARTIFACT_FETCH`。真正组级下载必须有 job id、进度、部分失败和重试，不以 toast 冒充完成。

### 3.5 团队对话流聚合协议

一期不新建消息事实表：

1. `ProjectGroup.headcount[].session_id` 是成员集合；
2. 从当前 `SNAPSHOT.sessions` 筛选 `project_gid === gid`；
3. 从 `SNAPSHOT.logs[session_id]` 合并为只读 team timeline；
4. 排序键优先 `LogEntry.occurred_at ?? LogEntry.ts`，同值再用 session_id/entry id；
5. 发消息时必须带具体 `session_id`，team pane 的“回复 Leader/某成员”只是路由 UI；
6. 组成员被移除后，历史消息保留归档身份，不能因当前 headcount 移除而改写历史。

## 4. 三端实施拆批

### 4.1 拆批原则

1. 每批具备独立提交、独立验收、明确靶子文件和回执路径；同一物理文件只有一个 active writer。
2. `session-manager.ts` 是 relay 集成单写者靶子；纯函数、fixture、ledger 和 adapter mapper 可以先并行，但不得偷偷改集成文件。
3. B0 先冻结类型、三出口 parity matrix、旧端 fixture；客户端不得凭猜字段先落 UI。B0 不承担 Web 实现。
4. 每批任务书必须带六件套、环境差异、角色越权检查、rollback target/数据兼容/降级行为、受影响的 004/013 条款。
5. 每批按“局部测试→探针→真链路→分段回执”滚动交付；生成 bundle 由 P1 单独统一执行，不由 Tauri/CLI 各自复制。
6. 每批若出现失败或返工，回执必须附一页简短复盘：影响/根因/修复/防复发探针，并记录本批实际瓶颈；不得把“换模型”当作默认提速方案。

### 4.2 批次总表

| 批号 | 内容 | 靶子文件 | 依赖/并行 | 验收口径（该批独有） | 规模 |
|---|---|---|---|---|---|
| B0 | 协议类型、三出口 SNAPSHOT parity matrix、schema/capabilities、旧端兼容 fixture；现有 ad-hoc 字段先进入 `SnapshotPayload`/Expo 镜像 | `relay/src/types.ts`、`relay/src/ws-server.ts`、`relay/src/cloud-client.ts`、`expo-app/src/protocol.ts`、`tests/fixtures/snapshot-*` | 首批；独占协议靶子 | 三出口逐字段对照；模型快照不对称回归；新客户端→旧 relay LAN/cloud 未知命令均得错误 ACK；旧客户端忽略未知字段；不含 Web UI | 中 |
| B1a | adapter/JSONL activity mapper 与引擎 capability fixture；不接 `SessionManager` | `relay/src/agent-adapter.ts`、`agent-jsonl.ts`、各 adapter、`tests/fixtures/engine-*` | B0 后，与 B3a/B4a/T1a 并行 | Claude/Codex preflight；Trae/Qwen/CodeBuddy mapper；ZCode unsupported；tool/assistant/occurred_at fixture | 中 |
| B3a | 扩展既有 decision ledger 的纯读写/分组/去重函数；不接 `SessionManager` | `relay/src/decision-notify.ts`、`tests/fixtures/notification-*` | B0 后，与 B1a/B4a/T1a 并行 | `cfg.dataDir/decision-notifications.json` 单一写面；handled/dismissed/sourceContext；离线重载 | 小-中 |
| B4a | Artifact 目录分组、源副本元数据比较纯函数；不接 `SessionManager`/CLI deliver | `relay/src/artifacts.ts`、`tests/fixtures/artifact-*` | B0 后，与 B1a/B3a/T1a 并行 | 同路径不同 source 不合并；failed/exists:false/reachable；排序与组计数稳定 | 小-中 |
| T1a | Tauri spawn/资源存在性探针，不碰生成 bundle | `desktop-tauri/src-tauri/src/main.rs`、`desktop-tauri/tests/*` | B0 后，与 B1a/B3a/B4a 并行 | dev relay 拉起、端口 8787/8788 约定、资源路径探针 | 小 |
| B2a | projects/org/settings 纯业务与 command fixture；命令接口已由 B0 冻结 | `relay/src/projects.ts`、`relay/src/org.ts`、`relay/src/settings.ts`、`tests/fixtures/command-*` | B1a/B3a/B4a 后；接 R1 前完成 | org create adapter 映射与 `{group,needsConfirm,confirm?}`；profile 非秘密引用；权限拒收 ACK | 中 |
| R1 | relay 集成单写者：按 activity → org/command → notification → artifact 顺序接入 `SessionManager`、LAN/cloud ACK 与审计 | `relay/src/session-manager.ts`、必要的 `ws-server.ts`/`cloud-client.ts` 接线 | B0+B1a+B2a+B3a+B4a；relay 串行核心 | SessionManager 三层 fixture、幂等/未知命令 default、事件/快照/ACK 对账；每段独立 commit/回执 | 大 |
| E1 | Expo protocol/store/reducer 与新快照字段 | `expo-app/src/protocol.ts`、`expo-app/src/store.ts` | B0；独占 Expo 协议靶子 | `tsc --noEmit`；旧 relay 缺字段降级；不要求真命令 UI | 中 |
| E2a | Expo root 列表只读 projection：单流、源模式、指标 | `expo-app/src/screens/ListScreen.tsx` | E1+B0；与 E3a/E4a 并行 | fixture 渲染待处理置顶/其他会话互斥、手机 390 宽不整屏抖动 | 中-大 |
| E3a | Expo detail 只读 projection：AI 无框、dock 展示、artifact group 展示 | `expo-app/src/screens/DetailScreen.tsx` | E1+B0；与 E2a/E4a 并行 | fixture 断言四态、WAITING 不重复、目录分组；不接真命令 | 中-大 |
| E4a | Expo Setup/App/notify 只读 projection 与能力提示 | `expo-app/src/screens/SetupScreen.tsx`、`App.tsx`、`notify.ts` | E1+B0；与 E2a/E3a 并行 | 源胶囊、前台通知、profile capability/隐私提示 | 中 |
| W1a | Web fixture/read-only queue 与快照 projection；不依赖后端真命令 | `web-console/index.html` | B0 后；Web 单文件锁 | 原型现有 91 探针 + 单流互斥/源模式 fixture；`</html>` 后零内容 | 中 |
| W1b | Web 命令/通知/组织真链路接线 | `web-console/index.html` | W1a+R1；与 E2b/E3b/E4b/C1 并行 | create/notification ACK `ok:true`、旧 relay 降级、通知不清零 | 大 |
| W2a | Web AI 无框消息与双段 dock | `web-console/index.html` | W1b+R1；单文件串行 | message role/stream 替换、WAITING 不重复、done/error 收口 | 中-大 |
| W2b | Web artifact/wait-card/目录组 | `web-console/index.html` | W2a+B4；单文件串行 | 组折叠、失败/不可达、审批动作回原 session | 中 |
| W3 | Web 团队/项目/通知/设置与 005 视觉收口 | `web-console/index.html` | W2b+R1；单文件串行 | 双端对查、结构闸、五域 projection 与能力缺失降级 | 中 |
| E2b | Expo root 真命令/通知/组织接线 | `expo-app/src/screens/ListScreen.tsx`、必要 store | R1+E2a；与 E3b/E4b/C1 并行 | 手机真链路 command→ACK→SNAPSHOT；返回栈与不清零 | 中 |
| E3b | Expo detail 真命令/审批/artifact 接线 | `expo-app/src/screens/DetailScreen.tsx`、必要 store | R1+E3a；与 E2b/E4b/C1 并行 | 390 宽真机/模拟器；WAITING、artifact fetch 与失败回退 | 中-大 |
| E4b | Expo Setup/App/notify 真连接与前台通知 | `expo-app/src/screens/SetupScreen.tsx`、`App.tsx`、`notify.ts` | R1+E4a；与 E2b/E3b/C1 并行 | 配对/云桥/通知恢复；权限拒绝可见且不重试风暴 | 中 |
| C1 | CLI 源脚本：deliver 显式 `session_id`、环境注入、dispatch/ACK 日志；不写生成 bundle | `cc-plugins/plugins/cc-deck/commands/*`、插件源脚本 | B0+B4a；与客户端批并行 | `session_id/dispatch_id/command_id` 全链路日志；`ok:true` 才成功；无网不静默丢单 | 中 |
| P1 | 统一运行 `relay/scripts/build-plugin.mjs`，生成 Web 副本与两份 relay bundle | `relay/scripts/build-plugin.mjs` 产物：`cc-plugins/plugins/cc-deck/web-console/index.html`、插件 `scripts/relay.mjs`、`desktop-tauri/src-tauri/resources/relay.mjs` | R1、W3、E4b、C1 完成后；独占生成物 | 三产物版本/SHA 一致；产物启动并能读 `schema_version`；不手工复制 | 中 |
| T2 | Tauri 平台差异、版本/协议显示与资源加载回归 | `desktop-tauri/src-tauri/src/main.rs`、`desktop-tauri/tests/*` | T1a+P1；与 C2 并行 | 目标平台 dev/bundle 行为一致；8787/8788 不冲突；协议版本可见 | 中 |
| T3 | 安装包 smoke 与升级/旧 relay 兼容 | 安装包测试脚本、Tauri 配置/不改业务源 | T2+P1；与 C3 并行 | 安装包启动、内置 relay、旧端 fixture、回滚到上一 bundle | 中 |
| C2 | CLI ACK/派单巡检日志与 reconciliation 输出 | `cc-plugins/plugins/cc-deck/commands/*`、CLI 测试 | C1+R1；与 T2 并行 | orphan/duplicate/timeout/seq-gap 可判定，ACK 误读不能判成功 | 小-中 |
| C3 | CLI 无网/失败回退、重投/代挂路径 | CLI 源脚本与测试 | C2+P1；与 T3 并行 | 无网转 Leader 代挂或重试；不丢 command_id；receipt 最终态明确 | 中 |
| V1 | 全链路集成、回滚/兼容和双端验收 | 探针/脚本/验收单，不与产品靶子并写 | P1+T3+C3+W3+E2b/E3b/E4b | 91+14+20 电池、三出口 parity、四类对账异常、三视口/390 真链路 | 大 |

预估规模是相对估算，不是工时承诺；真正的并行上限由靶子文件和验收环境决定，而不是 worker 数量。每批回执必须同时报告 `rollback target`、数据兼容/迁移方式、降级行为、环境差异（worker 若 Chrome SIGTRAP 则由 Leader CDP 补验）、角色越权检查、受影响的 004/013 章节及“不适用”理由。

### 4.3 五条流水线的批序列

**relay/src：** `B0 → (B1a || B3a || B4a || T1a) → B2a → R1 → V1`。`session-manager.ts` 只有 R1 单写者；B1a/B3a/B4a 只能写各自 mapper、ledger、artifact 纯函数和 fixture。

**web-console/index.html：** `W1a → W1b → W2a → W2b → W3`，全程单 worker；视觉 order5 与字段接线合并进对应批，避免模板/委托重复改。

**expo-app/src：** `E1 → (E2a || E3a || E4a) → (E2b || E3b || E4b) → V1`；同一 screen 文件仍串行，读侧 fixture 先行。

**desktop-tauri：** `T1 资源/启动探针 → T2 平台差异与 relay 版本显示 → T3 安装包 smoke`。Tauri 不是业务数据源，原则上不在壳层复制 session/team/project 协议。

**cc-plugins CLI：** `C1 → C2 → C3`；C1 只写源脚本与命令，不直接改生成 `relay.mjs`；P1 统一产物后 C3 才做 bundle 失败回退。

交叉依赖顺序固定：`B0` 先于所有客户端；R1 冻结真链路后才接 W1b/E2b/E3b/E4b；P1 统一刷新插件 Web 副本与两份 relay.mjs；V1 只有在 P1、T3、C3 和所有客户端批都有独立回执后启动。理论峰值并行度来自 B1a/B3a/B4a/T1a、读侧 Expo 与 Web/CLI 不同靶子，不来自多个 worker 同写核心文件。

## 5. 经验与优化专章

### 5.1 任务书自包含

每一张 worker 任务书必须同时包含六件套：

1. **目标**：完成什么用户能力/协议行为；
2. **边界**：允许改哪些文件、明确不改哪些文件；
3. **纪律**：类型、兼容、同靶子串行、不得猜字段；
4. **自查**：worker 自己执行的 grep/typecheck/局部测试；
5. **回单路径**：固定写入哪个 `/tmp` 回单，最后一行格式；
6. **验收点**：Leader 后续用什么探针、真链路和截图核验。

本周 relay 故障期间，靠 v2 接替单凭完整任务书无损续命，证明任务书不是说明文，而是 worker 进程死亡后的接管协议。新会话只要拿到任务书，就应能从源码恢复上下文，不依赖已死进程聊天记录。

### 5.2 同靶子串行锁

005 原型单文件全程只允许一个 worker 写；relay 侧 CLI 冒烟线与 005 线因靶子不同可以并行，这是已验证的有效分工。规则写成工程护栏：

- 同一个文件/同一段生成模板只能有一个 active writer；
- 需要接力时先结束/关闭前 worker，再把 diff、测试结果和未完成项交给后 worker；
- 不同靶子只有在协议边界已冻结时并行；
- “同一领域”不是锁粒度，“同一物理文件”才是锁粒度。

### 5.3 拆批滚动交付

大单按“低风险结构 → 中结构协议 → 大体系整合”拆三批。每批都预置秒验探针和分段报告：

- 低风险：类型/fixture/纯函数、token/selector 不影响主流程；
- 中结构：事件/命令/快照、单域 projection；
- 大体系：跨端真链路、断线恢复、源模式、通知/项目联动。

这样事故窗口从整批缩到单批；失败时回退一个小提交，而不是重做整单。任何批次没有独立验收口径，不得因为“改动很小”并入下一批。

### 5.4 派单通道工程

- `command_id` 必填，且在 relay/云桥/客户端回执中保持不变；
- ACK 必须核 `ok:true`，只看到 HTTP 200、进程退出 0 或“已发送”不能判成功；
- 事故教训：字段丢失曾造成三单静默积压 40 分钟，ACK 误读成功又放大了误判；
- 轮询通知不可靠，必须有 Leader 主动巡检：事件日志、派单台账、进程状态和 worker 回单四项至少核三项；
- `events.ndjson` 是唯一事件事实源，聊天消息/通知 toast/临时状态都只是投影；
- 任何新命令加入 `ws-server.ts` allowlist，否则 manager 有 case 也会被入口挡住；这是现有 `COMMAND_ALLOW_RULE_REMOVE` 漏白名单后手机失败的同类风险，白名单位置见 `relay/src/ws-server.ts:138-174`。

### 5.5 验收体系

验收电池由三层组成：

1. **断言探针电池**：已有 91 + 14 + 20 的分层实证规模；新增协议批要增加 fixture 断言，不能用截图替代字段验证；
2. **结构自查闸**：检查 `</html>` 后零内容，防止 markup 被 worker 追加到文件尾；对单文件 web 还要检查重复 id、闭合标签、委托入口和模板双 variant；
3. **双端对查硬条款**：桌面改动必须找到手机同类位；同一对象的卡/行、状态、计数、源语义不能只改一个端。

005 还需固定核验：单流分组互斥、dock 任务/活动双段、WAITING 不重复、AI 无框消息、输出物目录组、项目跨源副本、通知不清零、旧 relay 降级。

### 5.6 环境差异兜底

- worker 环境 Chrome 可能 SIGTRAP，不能自测时不以“本机打不开”判实现失败；Leader 用 CDP 环境补验收并记录环境差异；
- 旧版 bundle 有死会话不 revive、附图管线缺失等债务，不能假定生产 bundle 与 dev 树一致；由 dev 树接管实现与验证，再单独做 bundle/安装包 smoke；
- Tauri 内置 relay 资源路径、Windows `CREATE_NO_WINDOW`、macOS 服务化是壳层差异，业务协议只测 relay 契约；
- 真 CLI 不宜在 CI 依赖 API key；006 规定 mapper fixture、进程 stub、SessionManager 接线三层测试，见 `specs/006-engine-adapters-spec.md:610-630`。

### 5.7 角色纪律

Leader 只勘察/派单/核验/代提交，不下场写 worker 代码；设计判定归 PM；生产变更、合流、凭证、花钱由用户拍板。worker 发现超范围事项只回报，不自行扩权、不重写规范。审查员只能判定和给证据，不能把“无法判定”改成“缺陷已证实”。

### 5.8 收敛流程

标准流水线：

`设计单（单议题快速收敛，约 4 分钟实证） → 任务书（提炼实施口径，冲突以设计单为准） → 分段报告 → 回单 → 探针验收 → 代提交 → 004/013 规范固化`。

旧任务书与新设计单冲突时，不默默混用：任务书注明“以哪一版设计单为准”，Leader 在回单标出实现偏差，PM 再决定是否更新规范。

### 5.9 速度结论

实测代理商管道限速下三模型同速，换模型没有稳定收益。提速正道只有三条：

1. 找到真实可并行靶子；
2. 滚动验收、失败立即止损；
3. 预置探针，把等待从“人工找问题”变成“自动报差异”。

加人只在有并行靶子时有效；同一单文件加 worker 只增加冲突和接管成本。

### 5.10 状态透明与事故复盘

- 统一轮询：每单一行进度账，包含 `dispatch_id / 当前阶段 / 最近 ACK / 下一验收点`；
- 用户可见进度保持简明，不转发 worker 过程噪声；
- 事故当日出三层洋葱报告：外层影响与时间线、中层根因与边界、内层修复/防复发探针；
- 事件事实查 `events.ndjson`，派单事实查 `dispatch-log.ndjson`，命令事实查 ACK/回单，三者互相对照。

## 6. 风险与拍板项

### 6.1 诚实风险

1. **旧端兼容**：新 EventType/字段可能被旧 web/Expo 丢弃；字段缺失不能导致整个快照无法渲染。必须做能力存在性判断、旧端 fixture 和渐进发布。
2. **引擎能力位差异**：Trae/Qwen/CodeBuddy/ZCode 不一定有可靠 tool、approval、usage、resume。dock 只能展示能力位允许的内容，不能把普通文本猜成工具或等待。
3. **时间戳语义**：SSE/Envelope/LogEntry 的 `ts` 主要是 relay 记账时间；若把它当生成时间，会导致耗时和排序错误。需要 `occurred_at` 可选字段和“收到”降级。
4. **手机性能**：多源、多会话、日志和通知同时更新可能造成整屏重渲染；Expo 必须 reducer 增量更新、memoize、限制 timeline/活动频率，不能每帧重建全列表。
5. **云快照膨胀**：`logs` 已有每会话 K 条和总字节预算；新增 notifications/activity/项目摘要若不设上限，会再次触发桥单帧/限流事故。所有新增字段要做独立预算，活动只发最后值。
6. **通知投影漂移**：通知 ledger 如果成为第二状态源，会出现已处理但来源未处理、或反向清除。通知只能引用来源 key，来源动作成功才 resolve。
7. **跨源副本误合并**：相同 `~/dev/cc-deck` 不代表同一个物理目录；没有 source identity 时不得合并指标/输出物。
8. **团队消息聚合失真**：headcount 与 session 生命周期不同，成员退休/会话驱逐可能导致缺消息；历史需保留身份快照或归档标签。
9. **Tauri bundle 漂移**：dev 树通过而内置 relay 缺协议字段；必须有安装包 smoke，不能只跑 TypeScript。
10. **安全边界**：`COMMAND_ORG_ACTION`、profile 更新、批量 artifact 下载都扩大权限面；需 allowlist、来源权限、幂等和审计，不能用前端隐藏按钮代替授权。

### 6.2 需要用户拍板的事项

以下 8 项每项固定五格；未拍板前按“保守降级”执行，worker 不自行扩大范围。

1. **通知持久投影**
   - **背景一句**：现有 `decision-notifications.json` 已能去重/解决，005 还要求通知分组、不清零和跨端恢复。
   - **推荐选项**：批准扩展既有 ledger，增加 `NotificationItem` 投影与 `COMMAND_NOTIFICATION_ACK`。
   - **保守降级**：只保留现有 decision ledger + todo 兜底，不增加通知 ACK 写面。
   - **不拍板阻塞什么**：阻塞通知中心分组、已处理状态和离线恢复的最终接线，不阻塞瞬态 `USER_NOTE`。
   - **预计成本**：relay 一个投影扩展、两个端 reducer、约一组 ledger/fixture；不新增目录。

2. **组织动作范围**
   - **背景一句**：新建团队必须通过现有 `orgAction` 单漏斗，成员增删/状态迁移尚未有同等稳定命令契约。
   - **推荐选项**：一期只批准 `COMMAND_ORG_ACTION=create`，adapter 固定映射 `project-create/anchor`。
   - **保守降级**：新建团队继续由 CLI/Leader 触发，客户端只读确认卡。
   - **不拍板阻塞什么**：阻塞手机/桌面新建团队真链路，不阻塞已有 org confirm 展示。
   - **预计成本**：一个命令 handler、权限/ACK fixture 和组织状态回帧；扩展成员动作另计。

3. **细粒度活动 dock**
   - **背景一句**：任务级摘要稳定，tool/脚本活动高频且引擎能力不齐。
   - **推荐选项**：批准 transient `SESSION_ACTIVITY` + durable `SessionState.activity` 最后值，按 capability 显示。
   - **保守降级**：只显示 `SESSION_UPDATED.action_summary + SESSION_LOG` 的低频任务级 dock。
   - **不拍板阻塞什么**：阻塞操作级 dock 与活动探针，不阻塞四态/任务摘要。
   - **预计成本**：relay 节流、快照字段、Web/Expo 增量 reducer 和 mapper fixture。

4. **生成时间字段**
   - **背景一句**：现有 `ts` 是 relay 记账时间，误当生成时间会造成耗时/排序错误。
   - **推荐选项**：批准 `occurred_at?` 进入 `LogEntry`、`SessionLogPayload`、Expo mirror；缺失时显示“收到”。
   - **保守降级**：只使用 `ts`，明确它是 receive time，不显示伪精确生成时间。
   - **不拍板阻塞什么**：阻塞跨成员 timeline 精确排序和操作耗时增强，不阻塞旧日志。
   - **预计成本**：类型与 adapter mapper 三处同步，加回归 fixture；不改变历史数据。

5. **跨源副本比较**
   - **背景一句**：同一路径在公司电脑与家用 iMac 可能是不同物理副本，项目聚合不能误合并。
   - **推荐选项**：一期只比较 path/mtime/size/reachability，保留 source identity；hash/抽样显式 opt-in。
   - **保守降级**：只标注“多源同路径”，不做一致性判断。
   - **不拍板阻塞什么**：阻塞项目输出物跨源差异提示，不阻塞单源模式和普通项目聚合。
   - **预计成本**：客户端 projection 与少量 relay 元数据，不读全量文件。

6. **组级输出物下载**
   - **背景一句**：目录组可折叠不等于批量下载完成，真正批量动作需要 job/部分失败/重试。
   - **推荐选项**：一期批准目录组协议和单文件拉取；组级 download job 延后二期。
   - **保守降级**：只做目录折叠、单文件 E2E 拉取和失败重试，不出现批量完成 toast。
   - **不拍板阻塞什么**：只阻塞批量下载按钮的真链路，不阻塞输出物目录组和失败态。
   - **预计成本**：二期另需 job 存储、进度事件和云桥带宽预算。

7. **Provider profile 与秘密**
   - **背景一句**：设置域需要展示 006 provider 能力，但明文凭证不能进 SNAPSHOT 或 profile 文件。
   - **推荐选项**：批准非秘密 `engine-profiles.json` 引用与只读 preflight；秘密只存 env/keychain reference。
   - **保守降级**：只读环境变量/能力探测，不允许 profile 写盘命令。
   - **不拍板阻塞什么**：阻塞设置域的 profile 编辑和远程切换，不阻塞引擎列表/能力展示。
   - **预计成本**：一个受控 profile 文件、权限审计和 preflight；不新增 `CCR_*`、不新增端口。

8. **命令权限与 ZCode 默认位**
   - **背景一句**：配对设备是否全权会决定 org/profile/artifact 三类写操作的安全边界，且 ZCode 只有枚举未注册。
   - **推荐选项**：采用 `owner/operator/viewer + capability` 拒绝 ACK；ZCode 保持默认 unsupported/fail-closed，不纳入默认列表。
   - **保守降级**：未建立角色服务前把配对设备视为全权，但只开放现有 create，所有 actor 入审计；ZCode 仍禁用。
   - **不拍板阻塞什么**：阻塞远程写命令与 profile/artifact batch 的生产启用，不阻塞只读客户端。
   - **预计成本**：权限矩阵、拒绝 fixture、审计字段和一次安全验收；全权降级成本较低但风险更高。

## 7. 完成定义

### 7.1 每批通用 DoD

每批按类型选择模板，不再把“命令→ACK→客户端投影”强套到纯协议、纯 relay、客户端或壳批；但以下字段是所有批回执的共同门禁：

- 任务书六件套齐全；worker 回执包含结果、改动文件、测试命令、未完成项、`dispatch_id/command_id`；
- rollback target、数据兼容/迁移方式、降级行为、环境差异和角色越权检查有明确结论；
- 受影响 004/013 章节列出“已更新/不适用及理由”，并给 file:line 索引；
- 失败项标明是既有 known failure 还是本批 required failure，required failure 阻断进入依赖批；
- 失败/返工批必须附事故洋葱复盘与防复发探针；正常批也记录实际瓶颈和可复用提速结论；
- Leader 验收单记录计划/实际引擎、模型、provider、回执和改动文件。

**协议批模板（B0）**：类型检查、LAN/cloud phone/WAN parity、旧端 fixture、未知命令错误 ACK、schema/capability 兼容矩阵；不要求客户端真 UI。

**relay 批模板（B1a/B2a/B3a/B4a/R1）**：局部单测、SessionManager/adapter 三层 fixture（适用时）、持久化重载、幂等/权限/审计、至少一条 relay 真链路；纯函数批不强制客户端投影。

**客户端批模板（W/E）**：类型/构建、fixture projection、旧 relay 缺字段降级、目标视口/性能、依赖 relay 真链路的批再验 command→ACK→投影；Web 必过 `</html>` 后零内容。

**壳/生成批模板（T/P/C）**：Rust/脚本检查、资源/版本/SHA、安装包或 CLI smoke、无网/失败回退；P1 必须由统一构建脚本生成所有 bundle，不能手工复制。

所有涉及活动、派单或事件链的批必须运行 reconciliation probe，至少判定 `orphan`、`duplicate`、`timeout`、`seq-gap`；V1 将其作为阻断项。

### 7.2 各批 DoD

| 批 | 必须通过的 DoD |
|---|---|
| B0 | `SnapshotPayload`/Expo 镜像类型检查；LAN/cloud phone/WAN parity matrix；模型不对称回归；新客户端→旧 relay LAN/cloud 未知命令均返回统一错误 ACK；旧端忽略新字段。 |
| B1a | Claude/Codex preflight 与 mapper；Trae/Qwen/CodeBuddy JSONL fixture；ZCode unsupported；`occurred_at` 缺失降级；不改 `SessionManager`。 |
| B3a | 既有 `decision-notifications.json` 扩展读写、去重、分组、handled/dismissed、坏 JSON/离线重载；不新建第二通知事实源。 |
| B4a | 目录分组、失败/不可达/`exists:false`、源副本不合并、稳定排序与计数；不接 CLI deliver。 |
| T1a | dev relay spawn、8787/8788、资源存在性和壳探针；不拥有生成 bundle。 |
| B2a | org create adapter 返回 `{group,needsConfirm,confirm?}`；profile 非秘密；org/profile/artifact 权限拒收 ACK 与 actor 审计 fixture。 |
| R1 | activity→org→notification→artifact 分段真链路；SessionManager 单写者；未知命令 default；LAN/cloud 共用白名单；dispatch/ACK/events/receipt 对账。 |
| E1 | Expo protocol/store 类型检查、旧 relay 缺字段降级、reducer 单测；不要求真命令 UI。 |
| E2a/E3a/E4a | 各自只读 fixture：单流/目录/dock/源胶囊/通知 projection；390 宽度和增量渲染；不接真命令。 |
| W1a | 91 探针、单流/源模式 fixture、协议 projection、`</html>` 后零内容。 |
| W1b | create/notification 真 ACK、通知不清零、旧 relay 降级；Web 单文件串行。 |
| W2a | AI 无框、流式替换、任务/活动 dock、WAITING 不重复、done/error 收口。 |
| W2b | artifact group 折叠/失败/不可达、wait-card 回原 session。 |
| W3 | 团队/项目/通知/设置收口、双端对查、结构闸。 |
| E2b/E3b/E4b | 手机各自真命令/审批/通知/源连接链路；390 宽；失败回退和不重试风暴。 |
| C1 | CLI 显式 `session_id/dispatch_id/command_id`、`ok:true` 判定、无网不静默丢单；不改 bundle。 |
| P1 | Web 插件副本、插件 `relay.mjs`、Tauri `relay.mjs` 由同一脚本生成且 SHA/版本一致。 |
| T2/T3 | 壳平台差异、版本显示、安装包启动/升级/回滚、旧 relay 兼容。 |
| C2/C3 | ACK/派单对账四类异常；无网/失败重投或 Leader 代挂；最终 receipt 明确。 |
| V1 | 91+14+20 探针、三出口 parity、LAN/cloud 断线恢复、多源单/聚合、四态 dock、通知不清零、全链路真验收；reconciliation 四类异常为零或有明确 known failure。 |

### 7.3 全局自测军规引用

UI 与交付验收继续遵守 `specs/013-ui-design-playbook.md:1-74`：形态随功能、双端对齐、八态、token-only、同一信息不重复、可交互即真实可交互。引擎验收遵守 `specs/006-engine-adapters-spec.md:610-630` 的 fixture/stub/SessionManager 三层结构。输出物挂载遵守 `specs/012-worker-mount-mechanism.md:1-64` 的通用层/适配层隔离；通知写面遵守 `specs/007-notify-domain-ia.md:19-35` 的 B+ 归属。

**最终工程结论：** 先以 B0 冻结协议，再按 relay、web、Expo、Tauri、CLI 的靶子流水线滚动交付；所有状态、通知、输出物和团队聚合都以 relay/事件事实为根，客户端只做投影。只有在用户拍板的风险项完成后，才把对应“需新建”批次列入生产默认能力。

## 8. v2 变更日志

本节是三审查员结论的落点索引；实施时以实际源码和本文件的“已有/需扩展/需新建”列为准，若实现与草案不同，Leader 必须在批次回执中标注差异。

### 8.1 A 类必修落实

| 编号 | 落实状态 | 正文位置 |
|---|---|---|
| A1 / R1-1 | 已落实：`COMMAND_ORG_ACTION` 的 `{anchor_dir}` 通过 adapter 映射为现有 `orgAction("project-create", {anchor})`，ACK `data` 固定 `{group, needsConfirm, confirm?}`。 | §2.2、§3.1 命令表、§6.2-2 |
| A2 / R1-2 | 已落实：LAN/cloud 共用 allowlist；`execCommand()` 统一 unknown-command 错误 ACK；B0 纳入新客户端→旧 relay LAN/cloud fixture。 | §3.1 命令接线规则、§4.2 B0/R1、§7.2 |
| A3 / R1-3 | 已落实：新增独立持久 `data/relay-identity.json`，三出口必带 `relay_id`；`relay_dev` 仅兼容字段，旧 relay 有稳定 fallback。 | §1.1、§2.3、§3.1.2 |
| A4 / R1-4 | 已落实：B0 第一产物为 LAN/cloud phone/WAN parity matrix；先补 `SnapshotPayload` 与 Expo 镜像的现有 ad-hoc 字段，再加新字段。 | §3.1.1、§4.2 B0、§7.2 |
| A5 / R1-5 | 已落实：`owner/operator/viewer + capability`，覆盖 org/profile/artifact，拒绝 ACK 和 actor/device 审计；默认迁移策略列入拍板。 | §1.3.2、§3.1.2、§6.2-8 |
| A6 / R1-6 | 已落实：projects store 增不可变 `member_archive[]`，timeline live-first/archive-fallback，历史身份不随 headcount 改写。 | §2.2、§3.1.2、§3.5 |
| A7 / R1-7 | 已落实：六枚举/三类 Registry 已注册矩阵，Claude/Codex preflight，ZCode unsupported/fail-closed。 | §1.1、§3.1.3、§3.2、§4.2 B1a |
| A8 / R2 核心 | 已落实：按 B0→并行纯模块→B2a→R1 relay integration→客户端读侧/真链路→P1→T2/T3、C2/C3→V1 重排；补齐 T2/T3/C2/C3，P1 统一生成三份产物，`session-manager.ts` 单写者。 | §4.1-4.3、§7.2 |
| A9 / R3 图文一致 | 已落实：图 1 图注加入四数据层节点、双向 EngineRegistry 边、六枚举/三注册；图 2 明确采用方案 (a)，parity matrix 与协议文字承载运行时流；Leader 重绘源图，不改 HTML。 | §1.2、§8.3 |
| A10 / R3 协议精度 | 已落实：DispatchEnvelope/WorkerAck/WorkerReceipt JSON 示例与状态机、超时/拒收/重投/取消/接替/重复 envelope 语义已冻结。 | §1.3.1 |
| A11 / R3 拍板五格 | 已落实：第 6 章 8 项均使用“背景/推荐/保守降级/阻塞/成本”五格；权限与 ZCode 合并为第 8 项。 | §6.2 |
| A12 / R3 经验落点 | 已落实：六件套、环境差异、角色纪律、回滚、004/013 同步进入批模板/DoD；V1 纳入 orphan/duplicate/timeout/seq-gap reconciliation。 | §4.1、§4.2、§7.1-7.2 |

### 8.2 B 类顺手修处置

- EventType 数量改为当前实况约 24 类；云桥描述改为 Cloudflare bridge 的 E2E 转发，不宣称 KV 直出业务帧；见 §1.1、§3.1。
- Envelope/LogEntry 引用统一到 `relay/src/types.ts`；`occurred_at` 在 relay types、SessionLogPayload、Expo mirror 三处一次定型；见 §2.1.2、§3.1、§3.2。
- 通知明确为扩展既有 `cfg.dataDir/decision-notifications.json`，不新增第二个通知事实源；见 §2.4、§3.3、B3a DoD。
- `queuePartition` 改写为“协议语义 + Web/Expo 各自实现”，不虚构共享 package；见 §2.1.1、§4.2 W1a/E2a。
- 新目录、profile 文件名、端口和 env 冻结：通知 `decision-notifications.json`、profile `engine-profiles.json`、不新增 `CCR_*`/端口；见 §2.5、§6.2-7。
- models/homedir/deliverables/acceptances/relay identity 的 LAN/cloud/WAN 不对称进入 B0 parity 与回归；见 §3.1.1、§4.2 B0。
- `SESSION_ACTIVITY` 明确 transient/durable 拆分；见 §2.1.3、§3.1、§3.2。
- 采纳 R2 的 W2/E3 再拆、W1a/E2a fixture 先行、B1a/B3a/B4a 纯模块先行与 P1 bundle 统一；理由是消除单文件冲突并增加可独立验收的并行靶子，见 §4.2-4.3。

### 8.3 图源 JSON 交接清单（Leader 重绘）

Leader 只修改 archify 图的源 JSON/HTML，不修改本文件的三个占位。图 1 源 JSON 需：新增 `org/projects/boards/confirms`、`events.ndjson`、`CLI task-store`、`artifact store` 四节点；将原单向 `Relay→EngineRegistry: JSONL` 边拆为 `Relay→Adapter/CLI: command/stdin` 与 `Adapter/CLI→Relay: JSONL/transcript events`；EngineRegistry 标签改为“六类枚举/三类已注册/Claude-Codex 专用/ZCode unsupported”；补四个存储节点的读写边与事实源/投影说明。图 2 保留任务单旅程节点，不新增伪运行时边；将标题/旁注改为“Agent 任务单旅程，runtime protocol 见 §3.1 parity matrix”，删除任何暗示图 2 自己表达 ACK、last_seq 或双出口的标签。图 3 保留协作工作流，但在批次节点旁标出六件套、单 writer、探针验收和规范固化门禁。

### 8.4 取舍与未采纳项

- 未采纳“另建 `notifications.json`”建议，改为扩展既有 ledger，避免两个文件各自判断 handled/resolved。
- 未采纳“所有 relay 核心批可并行”建议，改为 `session-manager.ts` 单写者 R1；并行只放到不冲突的 mapper/ledger/artifact fixture。
- 未采纳“B0 同时负责 Web 类型消费”建议，B0 只冻结协议与 Expo mirror，Web 消费移入 W1a，避免协议批扩大靶子和破坏独立验收。
- 未采纳“以 `relay_dev` 作为稳定源主键”建议，改为独立持久 `relay_id` + legacy fallback。
- 未采纳“图 2 必须重画为运行时数据流图”作为本轮阻塞，选择 R3 方案 (a)：保留已有任务旅程图，运行时精确性由 parity matrix、文字状态机和 B0 fixture 保证，减少与 Leader 已有成图的重复改造；若后续用户要求可视化运行时流，再另开图单。

### 8.5 013 playbook 术语增补建议

下一次规范固化时，建议在 `013-ui-design-playbook.md` 增加新人速查词条：`relay`、`source`、`SNAPSHOT`、`event`、`COMMAND`、`ACK`、`dispatch_id`、`command_id`、`projection`、`task-store`、`artifact store`、`status dock`、`指标带`、`列表行`、`轻量分组行`、`member archive`、`parity matrix`、`reconciliation probe`。本批不直接修改 013。
