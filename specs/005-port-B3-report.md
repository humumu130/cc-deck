B3 指定施工边界内的团队域迁移已完成（B3-DONE），28 组静态/隔离 DOM 验证通过；地基事件与 COMMAND 通道尚待 Leader 按契约接入，真实 relay/浏览器全链路验收未完成，不以模拟测试冒充上线可用。

## 完成项 / 遗留项

### 完成项

- 仅修改 `web-console/index-005.html` 的 `#d-team` **开标签与闭标签之间**的内容，以及 rail 团队按钮的 badge `<span>`；该 section 开闭标签、rail 按钮/SVG、其余 section、mobile、样式与底部地基脚本均保持逐字节不变。本报告为另一个交付文件。未 git add / commit，未改旧入口、原型、relay、依赖或 worktree 外的项目文件；验证材料仅写 `/tmp/005-b3`。
- 项目队列使用真实 `projects`，可鼠标/键盘选择；显示项目状态、编制席位、所属来源与关联待确认数，移除全部演示团队和无协议支撑的「＋」。保留 pending / active / parked / archived，结项组可只读查看。无组使用 `readonly-banner`，缺团队字段明确显示未接入/不支持，绝不退回演示数据。
- 五泳道始终为「待认领 / 进行中 / 待审查 / 待收单 / 完成」。支持旧三态及当前仓库五态，映射定案见 B3-D4。task-card 包含真实标题/备注、承接席位、引擎、来源、状态 tag 与 gate 阻塞原因；冻结板只读展示；未知状态在五泳道之外保留原值，不伪造完成。
- 成员以 `ProjectGroup.headcount` 为编制事实，结合同源 `sessions` 补充标题、引擎/模型。显示角色、引擎、模型、provider、来源；不填演示模型，不默认未知引擎为 Claude，也不虚构 +1 Leader 席位；计数明确写「编制席位」。成员 tab 与检查器均可查看。
- 活动 tab / 检查器呈现最近派单回执，消费详情中的 `receipts`；按稳定 id 末条胜出、时间倒序、最多 30 条，显示时间、承接方、档位、状态、收口说明、引擎/来源。可选快照 `receipts` 必须按 `project_anchor` 精确归组（去尾斜杠），不把其他组回执混入。真实服务器详情回执已归组，沿用其口径。
- 确认卡消费严格 `status === "pending"` 的 `org_confirms`，覆盖正经立项、升降级、暂缓、结项，并兼容当前后端的 revive。展示标题、理由、载荷（含增量编制/核对清单），点击「查看并决议」选择该卡，再由 footer 的「确认 / 否决」发起决议。所有待决卡既在检查器显示，也在看板的可滚动正文显示，以保证检查器折叠时仍能查看。footer 仅呈现当前所选决议，不让多张卡撑满固定 footer。
- 决议只由用户点击产生 `COMMAND_ORG_CONFIRM { confirm_id, approve: boolean }`。未知 ID / 非法按钮 approve 值不发送；未绑定通道、离线、不支持时禁用；同卡飞行中与成功 ACK 后等待权威更新时防重。成功 ACK **不**改项目、成员、板、确认单状态或 badge；仅权威帧移除待决卡。失败/超时可见，严格拒绝非布尔成功与矛盾 ACK。
- rail badge 与团队行动计数使用去重后的 pending 确认单数，零时隐藏 badge，同步 aria-label/title；即使项目组为空也保留孤立待决卡，不丢决议入口。
- 团队内联脚本公开 `window.ccDeckTeam` 的冻结接口；DOMContentLoaded 时等待原地基 `setupStubTabs()` 完成，再填充已有四个 pane，保留 tab / tabpanel / ARIA / 方向键与检查器折叠节点，删除团队运行时 stub 属性。没有轮询、额外 WebSocket、HTTP、劫持 onEvent/onmessage、覆盖地基函数或私设 COMMAND_ACK 分发器。
- 项目详情由注入的命令通道按需获取；绑定/快照/选组首次加载，项目/板权威更新及手动刷新重新获取回执。请求单飞行，并防止快照、断线、项目移除、项目/板权威更新之后的迟到详情覆盖新状态；发生锚点变化时重拉详情。

### 遗留项（合流前必须接线 / 复验）

1. **B1 目前根本没有向团队转发 SNAPSHOT 或提供 COMMAND Promise 的钩子**，且忽略 COMMAND_ACK。本 worker 遵守铁律没有更改地基，所以当前独立页面仍明确显示「团队数据通道尚未接入」，未绑定时不会执行决议；不能把域内 renderer 完成说成真实 M2 数据链路已完成。必须落实 B3-C1 / C3 / C4。
2. `PROJECTS_UPDATED` / `ORG_CONFIRM_UPDATED` / `BOARD_UPDATED` 的覆盖式消费入口已实现，实际转发仍待地基接入；当前 v2 `delta` **不**在 B3 私自起底合并，需要 Leader 的共享投影提供已锚定全量，见 B3-C2。
3. 核对真实来源的 board / receipts 按需详情、决议 ACK 及权威回帧，验证离线禁用和重连全量收敛；本轮不启动已知 EPERM 的监听服务，也不尝试生产端口或真实 Leader。端口 **8797** 留给 Leader 按 B2 全隔离配方复验。
4. 真实浏览器（包括 390px / 1440px、浅深主题、检查器折叠）尚未验证、没有生成截图；长确认理由/载荷与 footer 的实际占用需 Leader 做像素复验。本轮只使用既有布局，未靠新增 CSS 解决潜在视觉问题。
5. 保留对话 tab 的明确只读说明「团队对话请回到来源会话」，不迁入演示聊天、团队发消息、主动新建/提案或编制编辑；这些不在任务书列出的六项迁移范围内，也没有私发 `COMMAND_ORG_ACTION`。多源管理及 mobile 仍属后续域，不在本批施工。

## 自测结果

验证时间：2026-10-07。执行 `node /tmp/005-b3/verify.cjs`，**28 组全部通过**；日志 `/tmp/005-b3/verification.txt`。假项目、会话、确认单、板、回执仅在该 `/tmp` 测试脚本内，未写入交付页面、真实 sqlite 或任何 relay 存储。

| 验证 | 结果 |
| --- | --- |
| 施工范围逐字节断言 | 将本次团队内部及 badge 替换回 baseline 后，整页与 `git show HEAD:web-console/index-005.html` 完全一致；section 开闭标签、按钮/SVG、所有保护区原样 |
| style 与 baseline / 005 原型 | 逐字节一致，SHA-256 `31444536d56e566e1bcc582b61c1e9c32275d92ad2166db15403738aceb6094d`；`diff -u /tmp/005-b3/prototype-style.txt /tmp/005-b3/index-style.txt` 无输出、退出 0 |
| 静态结构 / 语法 | 静态 DOM 五条 lane；task-card / member-card / activity-row / 确认 / footer / badge 挂点齐全；两个 script 都通过 `vm.Script`；团队无新增 style/内联 style、无直连 socket/HTTP/定时轮询/地基拦截 |
| 隔离 DOM 初始化 | **执行现存地基原样的** setupStubTabs / wireSegmentTabs / wireSegmentTabSemantics，而非重写其行为；DOMContentLoaded 前快照、移除 stub、幂等 mount、四 tab、方向键、ARIA、重渲染保留当前 tab 与检查器节点全部通过 |
| 数据与安全 | 真字段映射、引擎/模型/来源、XSS 文本及属性转义、constructor 词表键、缺字段/畸形条目、pending 严格过滤、stable id 去重、权威替换/空态/孤立确认卡与 badge 全部通过 |
| 看板 / 成员 / 活动 | 三态兼容及五态、五条 lane 计数、unknown 外置、冻结态、review_required 不推断状态、只呈现真实编制席位、最近 30 回执/末条胜出/跨项目隔离/无效时间全部通过 |
| 决议与 ACK | 四类及 revive、显式选择、自动流程不发送决议、真布尔 approve、单飞行/成功后防重、ACK 不改 badge、权威回帧收敛、矛盾/缺失/失败/超时 ACK、旧命令不支持、离线禁用全部通过 |
| 增量接口与详情竞态 | 覆盖式事件、拒绝 raw delta / 错 gid、不完整详情、选组/删组回退、项目/板变更重拉回执、手动刷新、迟到详情/决议 ACK、快照/断线 epoch 与锚点变化保护全部通过 |
| HTML 结构补验 | Python 标准库 HTMLParser 检查 section 开闭平衡、五桌面域顺序、五条实际 DOM lane、团队内仅一条新增 script，全部通过 |
| diff / 真实环境 | `git diff --check` 通过；真实 relay / 浏览器由 Leader 复验，**本轮未执行，不声称通过** |

## 偏差备案表

本表以 B1FIX 后的 005 壳为施工基线，编号独立从 B3-D1 起；已完整阅读 B1 报告 D01–D20，遵循 D02 占位替换与 D11–D14 协议备案先例。

| 编号 | 位置 | 原因 / 定案 |
| --- | --- | --- |
| B3-D1 | 团队 queue | 原型项目组名/数量/来源全部替换为 projects；状态和归档由真实字段展示；删掉无协议支撑的「＋」，不把空按钮伪装新建能力；选组节点沿用 queue-card，补 role=button/tabindex/键盘操作 |
| B3-D2 | workspace-head | 真实当前组标题、状态、tier、anchor_dir、编制席位和来源联动；不保留 PM 示例模型/虚假进度/演示待收单数 |
| B3-D3 | 五泳道 / task-card | 清除静态演示任务；五条 lane 保留定序与既有 class，标题/承接/引擎/来源/tag/gate 来自板与同源编制/会话；冻结/未拉取/失败分别说明 |
| B3-D4 | 板状态词表（展示定案） | **todo → 待认领；doing → 进行中；done → 完成**。旧三态没有审查/收单事实，因此两个中间泳道保持空，不根据 note、receipt、review_required、派单完成或关键词伪造。兼容当前后端 **backlog → 待认领；claimed → 进行中；submitted → 待审查；ready_to_install → 待收单；done → 完成**；submitted/ready_to_install 的文案沿任务书 005，而非 v1「待复核/待装机」，不写回后端。未知状态原值在板后展示，绝不增第六泳道或归为完成 |
| B3-D5 | 成员 tab / inspector | 成员卡绑定 headcount 与同源 sessions，显示真实角色/引擎/模型/provider；未知项写未标注；与 v1 常驻 Leader +1 计法不同，明确只统计实际编制席位，不构造不存在的卡 |
| B3-D6 | 活动 tab / inspector | 移除演示活动，消费详情 receipts；只呈现 readDispatchLog 收敛回执而非虚构消息日志，保持最近 30、末条胜出；可选快照 receipts 属接口扩展，不假定真实 SNAPSHOT 已下发该字段 |
| B3-D7 | 确认卡 / footer | 原型单个「确认编制方案」改为真实待决卡选择 + 所选卡的确认/否决；卡在 inspector 与看板正文两处可见，footer 只保留一张所选决议；兼容 revive；采用既有 task-card / inspector-title / identity-cluster / 按钮 class，无新样式 |
| B3-D8 | 决议行为 | 参照 v1 orgSendConfirm 的布尔 approve、飞行闸、权威回帧纪律，在域内重新实现 transport 注入。ACK 比旧版更严格，ok 必须真布尔且无错误文本；成功后等待权威更新仍禁重；不直接复制 v1 全局 ctxs/commandAck/onAck，更不私改地基 |
| B3-D9 | badges / 来源与状态形态 | rail 团队 badge 改真实 pending 数并零时 hidden；保留 005 团队来源 badge 隐藏 CSS，不破坏其逐字节资产。任务状态 tag 放在既有 identity-cluster 内，避开原型 `#d-team .task-card > .tag { display:none }`；任务承接文字仍可见真实引擎/来源，头部亦显示来源 |
| B3-D10 | 团队新增内联 script / tabs | 脚本封闭于 IIFE，只公开 ccDeckTeam；等待原地基建好 panes，再更新内容并去掉团队运行时 stub，保持开闭标签及地基启动链不变；对话 tab 不装演示消息，明确导向来源会话 |
| B3-D11 | 数据接入 / 请求边界 | 暴露与地基 `onEvent(context,message)` 同形的域内回调，不覆盖该函数；覆盖式事件已实现，raw delta 返回 false，等待共享投影；command Promise 注入后才允许加载详情/点击决议，快照与离线 invalidation 防迟到覆盖；所有需改地基项备案为下节契约，不私自实现 |
| B3-D12 | 验收方式 | 按本任务书用静态断言 + VM/DOM 替身，不重复已知 EPERM 起服尝试，不以 file:///模拟 ACK 冒充 LAN 通信；真实 8797 浏览器验收留 Leader |

## 契约请求清单

### B3-C1：SNAPSHOT / 回调转发（必需）

建议地基统一提供以下订阅口径，或在其 `onEvent(context,message)` 内等价调用本域回调；**本轮未修改地基实现**。

```ts
type TeamContext = { relayName?: string };
type TeamMessage = { type: string; payload?: unknown };

function subscribeRelayEvents(
  listener: (context: TeamContext, message: TeamMessage) => void
): () => void;

window.ccDeckTeam.onEvent(context: TeamContext, message: TeamMessage): boolean;
window.ccDeckTeam.snapshot(payload: TeamSnapshot, context?: TeamContext): boolean;
```

- 全量 `SNAPSHOT` 在地基原会话过滤/早退之前独立交付本域；不能要求 `payload.sessions` 非空才转发团队。snapshot 支持有效空 `{ projects: [], org_confirms: [] }`，缺 projects 表示不支持/未接入，畸形 payload 返回 false。
- `TeamSnapshot` 需要真实 `projects?: ProjectGroup[]`、`org_confirms?: OrgConfirm[]`、`sessions?: SessionState[]`、`relay_name?: string`；若共享投影已有完整板，可额外提供 `boards?: ProjectBoard[]`。`receipts?: DispatchEntry[]` 仅为可选扩展，传入时须含 project_anchor 供隔离。
- 实际 `relay/src/ws-server.ts` 的 SNAPSHOT 构造仅包含 projects / org_confirms，并不下发每组板/回执；项目详情依靠 C3 拉取。这与任务书概述「已随 SNAPSHOT/项目详情来」有别，不能以缺 board 推断无任务。
- 单来源 B1 绑定；不得把不同 relay 的同名 gid / confirm_id 送进同一 ccDeckTeam 实例。后续多源由 Leader 的统一架构管理，不在 B3 私做。

### B3-C2：覆盖式增量 / 已锚定投影（必需）

同一个 onEvent 入口已接受：

```ts
{ type: "PROJECTS_UPDATED", payload: { groups: ProjectGroup[] } }
{ type: "ORG_CONFIRM_UPDATED", payload: { pending: OrgConfirm[] } }
{ type: "BOARD_UPDATED", payload: { gid: string, board: ProjectBoard } }
```

如果 relay capability 开启 v2 delta，请地基按 v1 的 mergeEntityDelta / applyBoardDelta 纪律先投影、再通知全量；projects 由 SNAPSHOT/覆盖帧锚定，board 未锚定必须经详情重拉，不能对空基线应用 delta。B3 onEvent 遇到 raw `payload.delta` 返回 false、不清旧 store、不伪造 merge。选中组的项目/板覆盖更新会经 C3 重新取详情回执；当前既无派单回执广播字段也无私设活动事件。协议签名例：

```ts
function subscribeTeamProjection(
  listener: (context: TeamContext, message: TeamMessage) => void
): () => void;
```

这是 C1 订阅的已投影替代形态，不要求重复注册两次。如用多个订阅，须避免同一权威帧重复投递造成无意义重拉。

### B3-C3：注入 COMMAND Promise / ACK 关联（必需）

本域已经实现如下接口，不直接发送 socket：

```ts
type TeamCommand = "COMMAND_PROJECT_DETAIL" | "COMMAND_ORG_CONFIRM";
type TeamAck = { ok: boolean; error?: string; data?: unknown };
type TeamCommandPayload = { gid: string } | { confirm_id: string; approve: boolean };

window.ccDeckTeam.bind(options?: {
  command?: (type: TeamCommand, payload: TeamCommandPayload) => Promise<TeamAck | null>;
  online?: boolean;
}): void;

function commandAck(
  context: RelayContext,
  type: TeamCommand,
  payload: TeamCommandPayload,
  timeoutMs?: number
): Promise<TeamAck | null>;
```

建议地基复用旧入口 `commandAck(context,type,payload,timeoutMs=8000)` / `onAck` 的 command_id 关联与超时清理，解除当前 B1 的 COMMAND_ACK 忽略分支；ACK handler 属 Leader 统一地基，不在 B3 script 私建。命令 envelope / 权限 / 断线清理由地基负责，传给 B3 的 Promise 必须最终 resolve 或 reject；null/超时/拒绝不是成功。不要替本域自动批准确认单，也不要将 boolean approve 转成 "1" / "0"。

- `COMMAND_PROJECT_DETAIL { gid }` 成功 data 必须是 `{ group: ProjectGroup, board: ProjectBoard, receipts: DispatchEntry[] }`，group.id 与 board.gid 必须匹配请求 gid。
- `COMMAND_ORG_CONFIRM { confirm_id, approve }` 只有用户点击后调用；成功 ACK 后仍等待 C2 权威项目/待决队列更新。
- 当前后端附加的 pool 等字段 B3 不伪造，headcount 与 receipts 为本任务显示事实。

### B3-C4：连接态与生命周期（必需）

在地基握手成功后 `bind({ command: adapter, online: true })`；离线/未配置/pagehide 调用 `bind({ online: false })`。bind 是低频 transport/连接态变化操作，不应每帧重复调用，它会失效旧飞行请求、清 capability 缓存并按需拉一次详情。重新连接再转发全量 SNAPSHOT（保留 B1 不带 last_seq 的纪律）。每次 snapshot 都清旧板/回执并重新锚定，因此不能靠缓存伪装重连后仍新鲜。

Leader 接线示意（**仅报告中的建议，不是本轮地基代码修改**）：

```js
const stopTeamSubscription = subscribeRelayEvents((context, message) => {
  window.ccDeckTeam.onEvent({ relayName: context.relayName }, message);
});
window.ccDeckTeam.bind({
  online: ctx.status === "online",
  command: (type, payload) => commandAck(ctx, type, payload, 8000),
});
```

必须在 ccDeckTeam 定义后注册，并向已注册/晚注册组件回放最新 SNAPSHOT。DOMContentLoaded 前的快照可以安全缓存；本域 mount 不需要更改原 `setupStubTabs` / `initInspectors`。卸载时调用取消订阅并 `bind({ online: false })`。

### B3-C5：样式与浏览器复验（非地基强制新增项）

无本轮功能必需的新增 CSS 请求：所有卡、lane、avatar、tag、badge、readonly-banner、按钮均复用 005。请在 8797 的真实浅/深主题与窄/宽视口复验确认卡长载荷和所选决议 footer；若需限宽/换行/更紧凑 footer，由 Leader 先确认契约、统一更新样式资产，B3 没有私加样式。现存团队 source-badge 隐藏规则若后续多来源形态需要调整，同样归 Leader 的共享样式契约，本轮保持原样。

## Leader 复验配方

按 B2 已给配方将本 HTML 复制到 `/tmp/005-b3/webroot/web-console/index.html`、附上 nacl.js / qr.js，以端口 **8797** 伺服沙盒根 `/`，不要依赖不存在的 `/index-005.html` 路由。保持 `CCR_DATA_DIR` / `CCR_ORG_DIR` / `CLAUDE_CONFIG_DIR` 全部在 `/tmp/005-b3`，并启用 `CCR_NO_LEADER=1 CCR_NO_MDNS=1 CCR_NO_BRIDGE_MIRROR=1 CCR_NO_TITLE_GEN=1 CCR_CLOUD_URL=''` 等隔离环境。

落实 C1–C4 后，使用沙盒项目/板/回执/确认单，在真实浏览器验证：五泳道数与归组、编制/回执、四类确认单可选择、布尔决议 envelope / ACK 单飞行、项目与 pending 权威回帧收敛、badge 归零、离线禁用、重连刷新，以及 390px / 1440px 的 tab / 检查器 / footer。截图只存 `/tmp/005-b3-shot-*.png`；不要写真实组织目录、启动真实 Leader 或连接生产端口。当前交付没有这些截图与真实协议运行结果。
