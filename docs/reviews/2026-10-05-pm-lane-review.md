# 团队看板泳道独立评审（PM 盲评，2026-10-05）

## 现状证据
- 005 桌面团队看板当前固定五列：`待认领 / 进行中 / 待验收 / 待装机 / 完成`，见 `specs/005-prototype-a.html:1096-1097`。
- 手机不是五列，而是列表/任务 pane 形态；当前仍泄漏“就绪待装机/待收单”语义，见 `specs/005-prototype-a.html:1136-1138`、`:1205-1206`。
- 后端 `BoardEntry` 只有 `todo/doing/done`，并明确把“待装机”列为旧词表，见 `relay/src/projects.ts:63-85`；V2 目标五态为 `backlog/claimed/submitted/ready_to_install/done`，见 `docs/v2-system-design.md:84-121`。
- 004 当前还把五泳道写进正常态，并要求组头数字等于实际卡数，见 `specs/004-design-spec-a.md:91`、`:197`。

## 三项判定

### 1. 词表：不把「待装机」作为通用正名
- 推荐 canonical lane：**待收口**。
- 理由：`ready_to_install` 的本质是“产物/验收单已就绪，等待用户完成最后确认”，装机只是发版类项目的一个动作；非发版项目继续显示“待装机”会制造错误前提。
- release workflow 可保留上下文副词：`待收口 · 待装机`、`待收口 · 待确认`；泳道标题不随项目改名，避免三端词表漂移。

### 2. 数量：不新增第六条顶层泳道
- **不采纳“待审查”独立第六列**：它不是 V2 新状态，而是 `submitted/待验收` 内的责任阶段；新增列会把产品视图状态与五态机再次分叉。
- 在“待验收”卡内增加阶段徽标/过滤：`待审查` → `待验收单`（或“验收准备”）；有 reviewer/verifier 或项目策略要求时才显示“待审查”。
- 建议协议字段：`review_required`、`review_status[pending|passed|not_required]`；字段只影响投影与行动位，不新增 task terminal state。审查失败沿 V2 `task.reject(reason)` 回到执行态，保持 `submitted→claimed` 语义（`docs/v2-system-design.md:129-152`）。

### 3. 空泳道与 tier/workflow 门控
- 五态是数据模型，不等于每个项目必须渲染五列。新增 `workflow_profile[engineering|delivery|custom]`；不要复用 `ProjectTier`，因为现有 tier 是“轻立项/正经立项”治理档位（`relay/src/projects.ts:23-24`）。
- `待收口`仅在 delivery 或显式启用验收/交付流程时渲染；非发版 engineering 项目隐藏该列，不渲染一个误导性的空“待装机”列。若任务实际进入 `ready_to_install`，自动显现该列/阶段。
- 桌面：启用的核心泳道保留稳定列位；启用但为空显示低强调 `0`，禁用泳道不占位。手机：只显示非空分组，`待收口`有卡才出现，避免滚动长空组。
- 空态文案应说明下一动作，不写“没有任务”：如“暂无待收口项”“完成审查后会进入这里”。
- lane/group 计数只数实际 task card，不数 review 事件、验收行或 dispatch 次数；同一卡不得同时出现在两个泳道。

## 收口建议
- 采用：**四个通用泳道 + 一个按 workflow 启用的「待收口」泳道；「待审查」作为待验收内阶段，不升格为第六列。**
- 实施顺序：先冻结词表与 `workflow_profile/review_status` 契约，再改 005 三端投影；后端仍先保持三态兼容映射，待 V2 task 五态落库后切换。

lane-review done: 不加第六列，将「待装机」正名为按流程启用的「待收口」，「待审查」收进「待验收」阶段徽标
