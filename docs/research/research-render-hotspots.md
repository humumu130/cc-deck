# 渲染热点问题族清单（全量重建 → 定向更新改造立项素材）

> 2026-10-27 · #281 顺带产出 · 基线 `fix/engine-chip-slim`@5ea5070c
> 起因：1027 用户实锤「会话列表滚到下方后周期帧一到自动跳回顶部」——根因是渲染层大面积采用
> **整容器重建**（innerHTML 全量写 / replaceChildren 换子树 / textContent="" 重 append），容器一换，
> 浏览器侧的一切瞬态（滚动位/焦点/选区/动画/输入草稿）全部归零。本清单盘点全部热点，作为
> 「渲染层定向更新改造」大单的立项素材；#281 本身只做了会话列表的最小锚点恢复（见 §5）。

## 1. 扫描方法与口径

- 扫描面：`web-console/js/` 全部 8 个域脚本 + `index-005.html`（无内联写点）。
- 识别式：`innerHTML =` 全量赋值 / `replaceChildren(新子树)` / `textContent = ""` 后重灌。
- 排除式：追加式写（appendChild 到既有容器）、定点文本写（querySelector 后 `.textContent =`）、
  弹层/菜单（挂在 body 的临时节点，本就不该保态）。
- 行号以基线 5ea5070c 为准，**以函数名为锚**（行号随分支漂移）。

## 2. 热点总表

### 2.1 会话域（session-domain.js，innerHTML×48）

| # | 热点 | 容器 | 触发源 | 受影响面 | 现有缓解 | 建议定向更新 |
|---|------|------|--------|----------|----------|--------------|
| S1 | `renderMyList` → `mountUpper` | `.list-upper`（整节点新建+replaceChildren，滚动容器本体） | SNAPSHOT / SESSION_UPDATED / CREATED / DELETED / WAITING / ERROR / DONE / PROJECTS_UPDATED / COLLAB_MODE_UPDATED；WORKING 会话心跳周期高频 | **滚动跳顶**（用户实锤）；重命名输入框（`startRowRename` 的 input 挂卡内，帧到即销毁丢草稿）；入场动画 enter class 重放；hover 态 | **#281 已加 scrollTop 记录/恢复**（300ms wheel 手势窗跳过） | **高优**：keyed 卡片复用（按 `data-session-card` 对齐新旧卡，状态类/摘要/秒数定点写）；滚动改锚点卡恢复（首可见卡 sid+offset，免疫高度变化） |
| S2 | `renderSlimDrawer` | `[data-slim-drawer]` innerHTML | 同上 + 抽屉开合 | drawer-body 滚动位；走秒已定点（1s tick 只写 `.srow-sec`） | 隐藏态早退（零开销） | 中优：同 S1 keyed |
| S3 | `renderInspector` | `UI.inspector` innerHTML 全量 | 选中会话的任何帧（renderAll 链） | 检查器拖宽条（FB6 已打「摘下回填」补丁——**全量重建逼出来的补丁**）；成员胶囊展开 | FB6 补丁 | **高优**：补丁本身证明痛点；块级拆分（todo 块/artifact 块独立容器） |
| S4 | `renderConversation` | `UI.convPane`（textContent="" 重灌） | 选中会话任何帧（SESSION_LOG 高频） | **文本选区丢失**（用户选中复制时帧到→选区丢，滚动已有锚点不丢但选区没保）；代码块展开态（若有 DOM-only 态） | 件十九已加 top-anchor 滚动恢复（2026-10-12 同族 bug 先例） | **高优**：timeline 只尾增（既有 lastAiNode 增链可扩成 append-only 增量），选区保住 |
| S5 | `renderTasks` / `renderArtifacts` / `renderMore` | `UI.panes[1..3]` innerHTML | 选中会话任何帧 | 目录展开态（**artOpenDirs state 外置回放已保**）、任务勾选瞬态、下载进度条动画 | 展开态 state 记账（artOpenDirs/artOpenInit） | 中优：进度条/计数定点写，列表结构 keyed |
| S6 | `renderHeader` / `renderDock` / `renderTray` | 小容器 | 高频（含 1s 走秒 tick 的 dock） | 面积小，无用户可感损失（走秒已定点写 `[data-dock-sub]`/elapsed） | tickDockElapsed 定点 | 低优：维持 |
| S7 | `#160` 置灰看门狗（60s setInterval） | 逐卡对账 `.idle` 类 | 60s 周期 | 失配时整列重渲（会消费 #281 滚动保持——已有保护）；设计上「跨阈值时刻无交互」 | 读定向（逐卡比对）写全量 | 低优：失配时改单卡类切换 |

### 2.2 设置域（settings-domain.js，innerHTML×27）

| # | 热点 | 容器 | 触发源 | 受影响面 | 现有缓解 | 建议 |
|---|------|------|--------|----------|----------|------|
| T1 | 地基 `renderSessionList`（:1761） | `.session-list` | 冷启动/重连（b2Owned 让位后基本退场） | 冷启动窗口滚动（无内容可滚，无实害） | #143 让位机制 | 无需改 |
| T2 | `renderCloudUI`（:3435） | 云桥面板 | 连接状态变化（低频） | 配对码 canvas 重绘 | — | 低优 |
| T3 | 云诊断面板（#268 附带） | `[data-cloud-diag]` 文本 | 5s setInterval | — | **已定向**（只写文本节点，输码框无感）=正面参照 | 已达标 |

设置 live 区现状：诊断面板已定向（T3）、配对倒计时 `pairTimer` 只写文本——**live 区基本健康**，剩余 innerHTML 多为静态设置页一次性构建。

### 2.3 团队域（team-domain.js，innerHTML×17）

| # | 热点 | 容器 | 触发源 | 受影响面 | 现有缓解 | 建议 |
|---|------|------|--------|----------|----------|------|
| M1 | `render`（:855） | `[data-team-projects]` innerHTML + 主详情 pane 全量 | SNAPSHOT / PROJECTS_UPDATED / 经验帧 / 每个操作回调（runHarvestCheck 等均尾调 render()） | 团队列表滚动位；选中态（state.selected 记账回放）；**行内表单输入草稿**（expForm/rulesForm 只记目标 id 不记草稿文本，帧到→重建→输入丢）；两步武装确认态（expArm 4s 计时器与重渲赛跑） | 大量 state 外置（expForm/expArm/flights）回放 | **高优**：行内表单草稿记账（改前先保）；中期 keyed |
| M2 | 活动流/看板区（feedFilter 前端过滤重渲） | 活动列表 | 筛选切换+帧 | 滚动位 | — | 中优 |

### 2.4 通知域（notify.js）

| # | 热点 | 容器 | 触发源 | 受影响面 | 现有缓解 | 建议 |
|---|------|------|--------|----------|----------|------|
| N1 | `render`（:139） | `panelBody.replaceChildren` 全量 | **`bridge.subscribe(() => render())`——桥上任何事件全量重渲**（含每条帧） | 通知列表滚动位（通知攒多后重置到顶）；isNew 入场动画每次全列表重放；hover 态 | isNew 有 seen 集合去重（动画不闪旧条） | **高优**：先收敛触发粒度（通知数据未变不重渲，按 key diff），再 keyed |
| N2 | bridge-core 检查器/队列域（`render`/`renderQueue`/`renderInspector`） | #d-notify 检查器列 | 帧总线 | 滚动/展开 | — | 中优 |

### 2.5 同族外延（本单只登记不入 Urgency）

- **mobile.js**（innerHTML×17）：移动壳 renderInbox/renderNotify/renderTeam/renderProject/renderSettingsRows/renderMobileDetail 全量——同族问题在第二壳层复刻，大单需双壳同步改造。
- **release-domain.js / bridge-core.js 项目域**：低频或只读聚合，损失面小。
- **弹层类**（source-menu/filter-pop/row-menu，挂 body）：临时节点设计上不保态，**不属于问题族**。

## 3. 既有三种缓解模式（改造时的正面参照）

1. **锚点恢复**（滚动位）：`renderConversation` 件十九 top-anchor；**#281 本单** `.list-upper` scrollTop 记录/恢复（+300ms wheel 手势窗跳过）。成本最低，治标。
2. **state 外置回放**（交互态）：artOpenDirs（目录展开）、expForm/rulesForm（表单目标）、state.selected（选中）、seenNotifyKeys（已读）——把瞬态搬到 JS state，重建后回放。治交互态丢，但草稿类（输入框文本）需额外记账。
3. **定点写**（本就不该重建的）：走秒 tick（`.srow-sec`/`[data-dock-sub]`）、云诊断面板（`[data-cloud-diag]`）、#160 看门狗的读路径。治本样板。

## 4. 大单建议（「渲染层定向更新改造」立项要点）

- **路径分级**：①锚点/state 回放铺满（低成本止血，#281 属于这类）→ ②keyed 卡片复用（按 data-* 身份对齐新旧节点，类/文本定点写——收益/成本最优的主战场：S1/S2/S5/M1/N1）→ ③全面模板+绑定层（等于引入轻量渲染框架，**不建议**：与当前零依赖字符串模板架构冲突，改动面失控）。
- **优先序**（按用户可感损失）：S1 滚动（已修）→ S4 对话流选区 → N1 通知全量重渲（每帧触发）→ M1 行内表单草稿 → S3 检查器 → 其余。
- **回归面**：mo 完整性检查（observer 依赖「重渲=全量重建」语义，`_filterHiddenIds`/`_slimHiddenIds` 记账放行缺卡）——定向更新后「缺卡」语义变化，需同步核 observer 口径，这是大单最大隐藏风险。
- **断言基建**：#281 的帧总线注入探针（/tmp/w281/probe.mjs 模式：SNAPSHOT/SESSION_UPDATED 注入+scrollTop 断言，修复前红/修复后绿对照）可直接复用为大单的回归闸。

## 5. 本单已做（#281）

`session-domain.js` `renderMyList`：`mountUpper` 挂载单口内，`replaceChildren` 前记录旧 `.list-upper` 的 scrollTop、挂载后写回新节点；wheel/touchmove 300ms 手势活跃窗内跳过恢复（惯性滚动中程序写 scrollTop 与手势打架）。headless 探针 6/6 断言通过（修复前 B/F 两项红，复现跳顶）。
