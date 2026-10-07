# 005 换壳 B3 任务书：团队域全功能迁移（#d-team）

> 任务代号 #143-B3。Codex 执行。在你的专属 worktree 施工，**不 commit**（Leader 核验后代提交）。

## 背景与施工位置

B1 已交付 `web-console/index-005.html`（005 壳骨架，提交 a273dbf）。本批把**团队域**从旧 `web-console/index.html`（v1）迁入新壳。先读 `specs/005-port-B1-report.md` 偏差表 D01-D20（D02 标记了本域占位；D11-D14 是协议代码拷贝/备案先例）。

## 施工边界（铁律，违反=返工）

1. **只允许改动 `#d-team` 这个 `<section>` 区间内部 + rail 上团队按钮的 badge 元素**（含区间内新增内联 `<script>`）。其余——`<style>`、底部地基脚本、其他 section、mobile 屏——禁改。
2. `<style>` 与 005 逐字节一致是过闸资产，禁改；新功能装进 005 既有形态（task-card/lane/member-card/activity-row/tag/avatar/engine-badge）；需要新样式 → 报告「契约请求」。
3. 地基脚本禁改；需要增量事件（BOARD_UPDATED/PROJECTS_UPDATED/ORG_CONFIRM_UPDATED）或 COMMAND 发送（COMMAND_ORG_CONFIRM/COMMAND_PROJECT_DETAIL）→「契约请求」清单，不得私改地基。B1 地基目前只消费全量 SNAPSHOT——你的渲染器可以订阅地基已有的回调形态设计好接口，在报告里写明期望的接线点，由 Leader 在合流时统一接入。
4. 偏差备案制（B3-D1 起）；不 git add/commit；不动 worktree 外文件。

## 迁移范围（#d-team 域内）

005 团队域形态：看板五泳道（待认领/进行中/待审查/待收单/完成）+ task-card（标题/指派/引擎徽标/来源徽标/状态 tag）+ 成员卡 + 活动流 + footer 确认按钮。接 M2 后端真数据：

1. **看板**：SNAPSHOT `projects`（项目组列表摘要）+ 板 store 数据（todo/doing/done → 映射到五泳道的展示规则在报告里定案并备案）。
2. **成员**：编制（member 卡：角色/引擎/模型/来源）。
3. **活动流**：最近派单回执流（readDispatchLog 口径的数据已随 SNAPSHOT/项目详情来）。
4. **确认卡**：`org_confirms` 消费渲染（正经立项/升降级/暂缓/结项四类），决议动作走用户确认——**UI 只呈现与发起决议命令，决议本身由用户点击**（参照旧版确认卡交互）。
5. **rail badge**：团队待处理计数（org_confirms pending 数）。
6. 空态：无项目组时按 005 空态形态（readonly-banner）呈现。

## 自测

你环境监听 EPERM 起不了服务——静态断言 + 隔离 DOM 测试（B1FIX 的 vm/DOM 替身先例）：
- 结构锚点 grep（lane×5/task-card/member-card/activity-row 齐全、badge 挂点）；
- 用假 SNAPSHOT payload（含 projects/org_confirms/板数据）跑你的渲染函数断言输出（文本转义、空态、计数）；
- `<style>` 与原型 diff 仍逐字节一致；
- 沙盒 relay 的浏览器验证由 Leader 复验（配方见 B2 任务书，端口 8797 预留）。

## 交付

`specs/005-port-B3-report.md`：首行结论 → 完成项/遗留项 → 自测结果 → 偏差备案表（B3-D1 起）→ **契约请求清单**（你期望地基提供的回调/命令通道，精确到函数签名建议）。stdout 最后一行 `B3-DONE` 或 `B3-BLOCKED: 原因`。
