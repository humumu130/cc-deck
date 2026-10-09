B4 指定施工边界内的项目域（只读聚合）与通知中心迁移已完成（B4-DONE）；本报告为 ⑥e 补写——原施工批以短式提交交付、报告未随批落档，本报告从代码与提交史重建实施面、桥契约、契约请求与偏差备案，全部结论以 HEAD=6b390e6 的码内实况与提交记录为据。

## 一、批次范围与提交号

- **施工提交**：`1d6ac2b`（2026-10-07 11:48，#143 B4: 项目域+通知域迁移——只读聚合/输出物卡/通知列表轻动作，+732/-9，单文件 `web-console/index-005.html`）。提交信息记载施工面：「#d-project(485)/#d-notify(246) 内 + rail 通知按钮 badge，style/地基脚本未动」——此为施工时行数，后续批已使行号漂移。
- **任务书**：`specs/005-port-B4-task.md`（代号 #143-B4）：只许改 `#d-project` 与 `#d-notify` 两 section 内部 + rail 通知 badge；`<style>` 与地基脚本禁改；偏差备案 B4-D 起；沙盒 8798。
- **对本域的后续修订**（本报告一并收录，避免行号与形态混淆）：
  - `994547a` 盲评修复批：A-1 止血——桥命令通道固定走地基主连接 `window.__ccDeck005MainWs`（ACK 不串台）；S-1——验收单 total/judged 两处 Number 收窄（XSS 注入面）。
  - `575058e` ⑥a 视觉批：⑥a-3 总览指标卡大数字式→icon 行内式、「活跃团队」→「团队」；⑥a-4 检查器两处水位块（项目域「最活跃会话水位」/通知域「来源会话水位」）；⑥a-5 workspace-sub 去追加计数、footer 文案「项目不产生第二写面 · 所有动作回原域」→「编辑请回来源域」、头部 actionTag 删（原型终态已删）。
  - ⑥c 各批（eeaebca/c38224c/28d9970）成为桥的下游消费方，见三之「下游消费面」。

## 二、实施面清单

行号锚点均以 HEAD=6b390e6 的 `web-console/index-005.html` 实测为准。

### 项目域 #d-project（section L2829–3329，域内 script L2833–3328）

- **静态 DOM**：摘除 B1 备案的 `data-stub="B4"`（D03 占位兑现）；原型演示项目卡（cc-deck/windclaw-qclaw/legacy-scripts）、大数字 metric（6/1/46/2）、aggregate 四卡演示文案全部替换为 `data-*` 挂点：`data-project-queue`（L2830，含 `data-relay-state="loading"`）、`data-project-name/source/sub/body/state`、检查器 `data-project-risk-count/risk-copy/artifact-count/artifact-rows`（L2831–2832）；「＋」按钮改 `data-project-create`（aria-label「发起立项 · 去团队域」，点击仅 railJump 去团队域，L3309–3313——不伪造立项能力）。⑥a-4 增设的 `data-project-waterline` 挂点在 L2832。
- **域内脚本**（IIFE，L2834 起）：通用工具（转义/相对时间/uuid/引擎徽标/toast，L2843–2878，口径同地基）→ 共享桥声明（L2880–2971，见三）→ 聚合与渲染。
- **聚合逻辑**：`deriveEntries()`（L3089–3103）以 `projects[].anchor_dir` 归一（去尾斜杠）匹配 `sessions[].cwd`（`underAnchor`，L3078）；未命中任何项目组的会话按 cwd 目录聚为「未立项」条目（key `c:<dir>`）；排序=组内最新会话 updated_at 优先。`projectActionItems()`（L3105–3121）=组内未决 actionable 通知 + 未被通知账覆盖的待决确认单（按 entityId 去重）。`artifactsOf()`（L3123–3134）=组内各会话 `artifacts[]` 按 path 去重、过滤 `exists:false`、按 last_at 倒序——本地聚合，未新增协议请求（任务书授权「能用现有 sessions 数据本地聚合的就本地算」）。
- **渲染面**：左列队列三组 `renderQueue`（L3149–3162，活跃项目/待确认立项/挂起归档，queue-card 带 selected/需行动 tag）；头部 `renderHead`（L3164–3170）；六 tab 与 `render`（L3275–3305）——`overviewMarkup`（L3172–3193，readonly-banner + metric 四卡 + aggregate-grid 四卡）、`sessionsTabMarkup`（L3195–3200，行卡可跳会话域）、`teamTabMarkup`（L3202–3205，明确「项目页不复制团队状态」）、`taskTabMarkup`（L3207–3209，「任务板随团队域维护（按需经 COMMAND_PROJECT_DETAIL 拉取）」——项目域不私拉）、`artifactsTabMarkup`（L3211–3220，相对路径显示 + 跳来源会话）、`acceptancesTabMarkup`（L3222–3226，验收单行卡 `data-open-acceptance` 开表单页）。检查器 `renderInspector`（L3228–3256，风险/产物/水位）。选中默认取「首个有需行动项的条目，否则第一条」（L3291–3294）。
- **交互路由**（L3307–3323）：立项＋→团队域；验收单行→`openAcceptance` 开 `/acceptance/<id>`（relay #125 自包含表单页，路由已在 ws-server.ts L693 备案存在）；队列卡→域内选中；`data-domain-jump`→`railJump` + 可选 `selectSessionCard` 定位会话卡。写操作零个——项目域只读聚合。

### 通知域 #d-notify（section L3331–3600，域内 script L3335–3599）

- **静态 DOM**：摘 `data-stub="B5"`（D04 兑现）；三列改为挂点——`data-notification-queue`（L3332）、正文 `data-notification-list` + `data-notify-state`、检查器 `data-notify-action-count`×2 与 ⑥a-4 的 `data-notify-waterline`（L3333–3334）。检查器静态文案即产品口径：badge「只计行动」「处理完最后一项行动才清零」；写面归属（验收回填→来源会话，失联接替/编制确认→来源团队）；轻动作白名单（标记已读/暂停提醒/确认已知）。
- **rail badge**（L1107）：去 `data-stub="B5"`、默认 `hidden`、计数 0；运行时由 `syncCounts` 更新（L3490–3498，同步 aria-label/title，零时隐藏）。口径=**全部需行动**（含验收/确认合成行），与团队 badge（仅 pending 确认数）按任务书区分。
- **行合成 `buildRows()`**（L3363–3389）三层：① 通知账为权威（`bridge.notifications` 逐条，L3365–3375）；② 待决确认单兜底——无在册 org-confirm 通知覆盖的 `pendingConfirms` 补 synth 行（按 entityId 去重，L3376–3380）；③ 验收单行——relay 暂无 acceptance 通知产生源，端上本地合成（L3381–3386，**契约请求 B4-C3**，synth 行 `actionable:false` 不给轻动作位）。排序=需行动优先、时间倒序。
- **渲染面**：左列 `queueMarkup` 三组（L3409–3428，需你行动/注意/动态——005 原型三组形态）；正文 `listMarkup` 来源分组（L3466–3474，live/历史动态两组）+ `sourceCard`（L3440–3464，kicker 来源标注/引擎徽标/状态 tag/轻动作与跳转按钮）；空态 demo-empty-state「暂无需要你行动的通知」（L3481–3488）；`syncWaterline`（L3501–3518，⑥a-4 来源会话水位）。
- **跳转路由**：`jumpOf`（L3391–3399）按 kind 定向——waiting/dispatch/system→会话域（可带 segment 定位 tab）、org-confirm→团队域看板、acceptance→开表单页；`focusSource`（L3565–3578）执行 railJump/clickTab/selectSessionCard 并 toast「写操作在原域完成」。历史动态行点击仅 toast 归档说明（L3592）。
- **轻动作 ACK**（L3547–3563，码内注 #018-W1b 口径）：`COMMAND_NOTIFICATION_ACK { notification_key, action:"handled" }`；乐观行即刻消失（flight 过滤）→ ACK ok 等权威 `NOTIFICATIONS_UPDATED` 归位历史动态；失败回滚（行回来+toast）；旧 relay 未知命令按错误文本识别（L3550 正则）置 `notifyAckUnsupported` 能力位、隐藏动作位。relay 侧命令白名单已含此命令（ws-server.ts L170，#018-R1c 生命周期 handled/dismissed）。
- **「×」按钮**（L3584）：不清零，toast 说明「需行动项处理后自动归档为历史动态」——通知不清零口径。

## 三、B4 桥契约（window.__ccDeck005B4）

B4 的关键结构决策：**项目域脚本声明共享桥，通知域脚本消费同一实例**（L3338–3341 注释明示），后续 ⑥c 各批继续复用。桥以 `TappedWebSocket`（L3033–3058，继承原生 WebSocket、安装于 L3060 `window.WebSocket = TappedWebSocket`）分接地基/B2 的全部连接——地基不为此提供任何钩子（DV4-1 过渡形态，见五）。

### 状态字段（L2909–2922）

| 字段 | 类型/初值 | 语义 |
|---|---|---|
| `hasSnapshot` / `snapshot` | bool / null | 是否已收全量快照及原始 payload |
| `sessions` | Map<session_id, SessionState> | 本地聚合的会话账 |
| `notifications` | NotificationItem[] | 通知账（normalize 后） |
| `notificationsSupported` | bool | SNAPSHOT 是否携带 notifications 字段（`hasOwnProperty` 判能力，L2980——对齐 relay #018-R1c「空数组也下发、字段存在性判能力」口径；旧 relay 缺字段→通知中心整体不可用态，L3532–3538） |
| `pendingConfirms` / `accepts` / `projects` | OrgConfirm[] / AcceptanceSummary[] / ProjectGroup[] | 待决确认单/验收单/项目组（元素须有 string 型 id，畸形过滤） |
| `relayName` / `homedir` | string | relay_name 缺省回退 `location.host`（relay 侧条件携带，ws-server.ts L948 #100）；homedir 用于目录缩写 `~/` |
| `connection` | unconfigured/connecting/online/offline | 桥观测的连接态（file:// 直判 unconfigured，token 推导同地基 D12 口径 L2906–2908） |
| `notifyAckUnsupported` | bool | 旧 relay 不支持通知 ACK 的能力位记忆 |

工具导出：`escapeHtml / relTime / toast / engineBadge / doneOfNotification`（L2922，供通知域与 ⑥c 移动端复用，口径同地基）。

### 方法面（L2923–2969）

- `waitingText()`：各连接态的等待文案（未配置/等快照/连接中/已断开）。
- `railJump(domain)`：白名单字符过滤后点击 rail 按钮（域跳转）。
- `clickTab(selector, label)`：按文案匹配点击 segment-bar 按钮（跨域 tab 定位）。
- `selectSessionCard(sessionId)`：CSS.escape 后点击会话卡，不在列则 toast「来源会话不在当前列表」。
- `openAcceptance(id)`：`[a-zA-Z0-9_-]` 过滤后 `window.open("/acceptance/<id>")`，弹窗被拦 toast。
- `bannerOf(text)` / `subscribe(fn)`：readonly-banner 节点工厂 / 订阅者注册（返回退订函数；帧变化与连接变化均通知）。
- `sendCommand(type, payload, timeoutMs=8)`（L2956–2969）：Promise 封装；**994547a A-1 止血后**优先走地基主连接 `window.__ccDeck005MainWs`（readyState=1 时），无主连接才回退任意分接 socket，全无则 resolve(null)；`command_id`=uuid，超时（默认 8s）resolve(null)。ACK 结算在 `handleFrame` 的 COMMAND_ACK 分支按 command_id 查 `ackWaiters`（L2995–2999）。**ACK 帧口径 `{ type:"COMMAND_ACK", command_id, ok:boolean, error?:string }`**——relay ws-server.ts L999/L1015 实证（白名单外 `ok:false,error:"unsupported command"`）。

### 帧消费面（applySnapshot L2973–2990 / handleFrame L2992–3031）

- `SNAPSHOT`：全量替换 sessions/notifications/pendingConfirms/accepts/projects/relayName/homedir。
- `NOTIFICATIONS_UPDATED`：全量替换通知账——与 relay 侧语义对齐（session-manager.ts L757「全量替换语义」瞬态帧）。
- `ORG_CONFIRM_UPDATED` / `ACCEPTANCES_UPDATED` / `PROJECTS_UPDATED`：对应数组覆盖（relay 侧 #184 验收单推送、#26 M2 均存在）。
- `SESSION_CREATED` / `SESSION_DELETED` / 六种 SESSION_MERGE_TYPES（UPDATED/HEARTBEAT/DONE/ERROR/WAITING/WAITING_RESOLVED，L2992）：本地增量合并——**只 merge 不 diff**，桥不消费 LOG 流。
- 任何 changed 后广播 subscribers；COMMAND_ACK 只结算等待表不广播。

### 下游消费面（B4 施工时不存在，⑥c 起成为桥的契约承担者）

⑥c-1 `initSettingsLiveData`（L4033 起，eeaebca）订阅桥渲染设置域真数据；⑥c-2 005-mobile IIFE（L4386 起，c38224c）四屏渲染与 `jumpDesktop`；⑥c-3 `mobileAckNotify`（L4475，28d9970）移动端通知轻动作复用同一条 `COMMAND_NOTIFICATION_ACK` 链。桥因此已是**三域+移动端共用的事实数据面**——收敛责任见六。

## 四、契约请求清单（B4-C 系）

原施工批的完整契约清单未随短式提交落档；码内可考编号仅 B4-C3 一处（L3362），另有一处无编号备案（L3225）。本节以码内注释为纲重建，不虚构编号：

- **B4-C3 验收单通知产生源**（码内 L3361–3362 明示）：relay 通知账协议类型 `NotificationKind` 已预留 `"acceptance"`（types.ts L154），但产生点 `upsertNotification` 四处调用（session-manager.ts L898 waiting / L920 org-confirm / L4118 dispatch / L4350 system）**无 acceptance 调用**——验收单登记/提交不产生通知。端上补偿=buildRows 第三层本地合成行（submitted 状态变化只经 `ACCEPTANCES_UPDATED`/SNAPSHOT 到达，行状态随之刷新）。若 relay 补产生源，合成层按 L3381 `hasAcceptanceChannel` 判定自动让位。
- **（无编号）验收单项目归属字段**（码内 L3225 banner「SNAPSHOT 无项目归属字段，契约请求已备案」）：`AcceptanceSummary`（acceptance.ts L133–143）仅 id/title/created_at/total/judged/submitted，无 gid/anchor——项目域验收单 tab 只能按登记时间全局列出，不能归组到项目条目。
- **（非契约，事实备案）桥的存续依赖**：notifications 能力位、`relay_name` 条件携带（#100）、`/acceptance/<id>` 路由（#125）均已在当前 relay 实现，无缺口；桥本身的终态替换见 DV-ARCH。

## 五、偏差备案明细（DV4-）

权威编号沿用 ⑥b 总档（specs/005-port-deviations.md）DV4-1..3；原施工 worker 码内自编号 **B4-D2**（L2836「WS 只读分接桥（B4-D2）」）即 DV4-1，其余自编号随短式提交遗失。

- **DV4-1 WS 桥形态**（=码内 B4-D2）：B4 以 `TappedWebSocket` 劫持 `window.WebSocket` 从地基连接搭桥，暴露 `window.__ccDeck005B4`。施工时的形态（命令随机借道任一 readyState=1 的分接 socket）在 994547a A-1 止血后固定走主连接——`window.__ccDeck005MainWs` 由地基 `connectLan` 挂出，ACK 回主连接由桥的 message 监听先结算，不再随机借道 B2 socket 造成「无主 ACK」串台弹错。此为**双连接过渡形态**（DV-ARCH）：地基与 B2 各持连接 + 三套命令等待表 + 本劫持桥并存。完整收敛（地基唯一持连 + 域订阅 API、拆除劫持）另立任务、出包前排期——B 卷盲评结论原文「连接架构的账必须在出包前算清」。
- **DV4-2 S-3 `var(--sans)` 未定义**：三处 font 简写引用未定义变量、回退继承——总档记 L369/L914/L918，⑥a 批新增 CSS 后行号漂移，当前实测 **L369/L917/L921**（.session-list-tools input / .row-rename-input / body.file-drag-over::after）。与原型逐字节一致（原型同款缺定义），按资产一致性不修；若原型方补 `:root { --sans }` 定义，随样式同步带入。
- **DV4-3 静态壳演示数据保留**：施工时点设置域（B6 未施工）、移动端（B7 未施工）及部分 stub 区的原型演示文案仍在原位。此条已被 ⑥c 收口处置（eeaebca/c38224c/28d9970，设置域六面板 + 移动端四屏 + m-detail 五 tab 均接桥真数据）——收口前的差异属施工排期而非偏差，历史结论保留。
- **伴随偏差（不另立编号，随 B4-C3 备案）**：buildRows 二、三层合成行（待决确认单兜底/验收单）为端上补偿视图——`synth:true` 行无轻动作位（`actionable:false`），确认决议仍必须去团队域、验收回填仍必须开表单页；合成行不写入任何权威账，权威帧到达即重算。另：项目域 metric 第三卡原型为「▣ 输出物」文本符号、⑥a-3 已改 icon-package（原型终态），此处以 ⑥a 批备案为准。

## 六、遗留与收敛路径

1. **DV-ARCH 终态**（出包前排期，另立任务）：地基唯一持连 + 域订阅 API + 拆除 WebSocket 劫持。桥现有三个下游（通知域、⑥c-1 设置域、⑥c-2/3 移动端）+ B2 导出面 `__ccDeck005B2`（DV6c-4）——收敛时域间数据通道从「B4 桥单通道 + B2 导出面」双轨统一为地基订阅 API，届时 `TappedWebSocket`、`__ccDeck005MainWs` 标记、桥内 ackWaiters 一并拆除。994547a 止血后用户可见面已无已知缺陷（⑥d 口径），完整收敛可另立任务但须明确排期。
2. **B4-C3 产生源**：relay 补 acceptance 通知产生点后，端上合成层自动让位（L3381 判定已就位），无需改 B4 域代码。
3. **验收单归属字段**：relay 在 AcceptanceSummary 补 gid/anchor 后，acceptancesTabMarkup 可从全局列表改为按 entry 归组（当前 banner L3225 已如实说明局限）。
4. **任务板按需拉取**：项目域 taskTab 为引导占位（COMMAND_PROJECT_DETAIL 属 B3-C3 契约、由团队域实现），项目域不复制任务状态——如需项目域内嵌板，须 Leader 新立契约，不属 B4 遗留缺陷。

## 七、自测记录（转述，注明来源）

B4 施工 worker 的原始自测输出未落档（短式提交，本报告无法核实其 8798 沙盒与截图是否执行——**未核实项**）；可考记录如下：

- **1d6ac2b 提交信息**（Leader 核验口径）：「HTML 结构完整，交付面抽查 5/5」。
- **994547a**（涉及本域：A-1 桥命令通道固定、S-1 验收单 Number 收窄）：「自测：语法 4/4 块；Team 冒烟 12/12 + C-2/C-3 专项 5/5；沙盒 relay 8797 真链路 4/4（SNAPSHOT 团队字段+projection_v2+两命令 ACK 回路）」。
- **575058e ⑥a**（涉及本域：⑥a-3/4/5 五项中三项落在 B4 域）：「script 块语法 5/5；getSessionProject 逻辑单测 4/4；沙盒真链路冒烟（页面 200+新代码在页/SNAPSHOT projects+context 字段链/RENAME ACK ok:true）」。
- **⑥c 下游**（证明桥在真链路可用）：eeaebca「沙盒 8791 真链路（页面 200 含新代码；SNAPSHOT engine_catalog 六引擎实况）」；c38224c「沙盒 8791 真链路（SNAPSHOT 数据面：2 会话进 inbox/team/project 渲染源）」；28d9970「自测三件全绿：语法 6/6；逻辑单测 26/26；沙盒 8791 真链路」。
- **本报告（⑥e）自检**：文中全部行号在 HEAD=6b390e6 逐一 grep/read 复核；码内 B4-C/B4-D 注释共 3 处（L2836 B4-D2、L3362 B4-C3、L3225 无编号备案）全部收录；relay 侧佐证（NotificationKind 联合、upsertNotification 调用点、AcceptanceSummary 结构、COMMAND_ACK 帧构造、SNAPSHOT payload 字段、/acceptance 路由）均实证于源码。

## 八、⑥e 补写口径说明

本报告由 ⑥e 批 worker 依任务书补写：未改任何代码文件；码内 L2838 注释「偏差与契约见 specs/005-port-B4-report.md」自施工起即指向本文件，本报告补齐该承诺载体。DV4-1..3 的权威编号在总档，本报告为其权威详述（总档保留索引行）；B4-D2 为施工时码内自编号，映射关系见五。历史时点表述（如「施工时 485/246 行」「DV4-3 演示数据保留」）按当批提交记录保留，不回溯改写。
