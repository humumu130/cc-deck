# 经验回流 PM 审核环（#126）· 一页纸建议

> 2026-10-16 · W-DESIGN 件二 · 用户思路：worker 完结/退役前总结经验回流 PM，PM 决定是否落盘

## 结论

**做，但做薄。** #126 与既有 experience.ts 体系（W-EXPP1/P2 捕获/注入/GC/面板）**不是重复建设**——既有链路缺的正是用户点名的两环：①worker 完结/退役前的**主动总结**（现状只靠回执末行一条可选约定，量少质随机）②**PM 落盘决策权**（现状 agent 申报直接入库，PM 只有事后 activity 通知）。补这两环、其余全复用，不新建系统、不动 schema、不新增帧类型。

## 1. 现状链路（判定依据，实测锚定）

- **捕获**：dispatch 收口 `status=done` 时 `captureExperienceDeclaration`（session-manager.ts:4761）扫回执末条 assistant 的「经验：<一句话>（#kind）」行 → `appendExperience` **直接入库**（actor=agent）→ 广播 + activity 纯信息通知。回执格式约定已在派单纪律模板（本批任务书即带）。
- **退役**：`org member-retire <gid> <sid>`（org.ts:394，编制除名）——**无任何经验环节**。
- **管理面**：org CLI（exp list/bump/retire）+ web 团队域第五 tab 经验库 pane（W-EXPP2，筛选/导入/改归组）+ 升格链 `org rule promote <经验id>`。
- **缺口清单**：主动总结无触发保障 ｜ 落盘无审核 ｜ 退役无回流 ｜ PM 决策无交互形态。

## 2. 建议（四点，按薄到厚）

### ① 落盘决策权 = 确认卡（核心件）
`captureExperienceDeclaration` 从「直接 appendExperience」改为**先出 orgConfirm 确认卡**（kind=`experience-review`，复用既有确认卡框架+通知 action 双通道）：✓=入库（现路径）/ ✗=丢弃（留决策台账一行）。
- **降级闸（必带，1014 PM 事故教训）**：PM 是会话不是人——PM 无头值守/转后台时确认卡会积压。卡龄 >30 分钟未处理**自动按 ✓ 落盘**（fail-open 回退到现状行为，宁可多入库一条——GC 与 bump 链自会淘汰低值条目，卡死积压代价更大）。
- 改动面：session-manager 分流 ≈80 行 + orgConfirm kind 词表 + 决策台账。**不动 ExperienceEntry schema**（不加 status——pending 态存确认卡不存库）。

### ② 主动总结 = 收口侧补提示，不新建「总结帧」
载体用**回执附录**足够（回执本就是 PM↔worker 账面）。真正的缺口不是格式而是**触发保障**：正经立项档派单收口时若回执无「经验：」行 → PM 侧收一条「零申报」提醒（信息行，非确认卡），由 PM 决定是否追问 worker。轻立项/随手办不提醒（噪声控制）。**不造专用帧**——过度设计。

### ③ 退役回流 = member-retire 挂提示钩
`org member-retire` 执行时：CLI stdout 提示「该成员 N 条经验已随库保留；如需退役前总结，让成员在收工回执附『经验：』行」+ relay 侧给 PM 发一条信息通知。不做强制总结流（退役常是紧急操作，加流程反堵）。

### ④ #96 经验 tab 衔接 = 面板加「待审」分区
经验库 pane 顶部加「申报待审 N」分区（读 pending 的 experience-review 确认卡），行内 ✓/✗ 快捷——人在面板时可直接批量裁决，不必等确认卡逐张点。已有 pane 扩一列，无新页面。

## 3. 不做清单（防蔓延）

- 不新建「总结帧」/「经验回流」专用 EventType——确认卡与通知已覆盖双向
- 不动 ExperienceEntry schema（不加 status/审核字段）
- 不改 GC/注入链——入库时机后移不影响两者
- 不做「退役强制总结」——紧急退役不允许被流程堵

## 4. 工作量与验收点

**M ≈ 1 天**：①确认卡分流+降级闸 ②零申报提醒 ③retire 提示 ④面板待审分区 + 测试（收口出卡/✓入库/✗丢弃/30min 自动落盘/零申报提醒/面板裁决）。
验收点（真机）：worker 回执带「经验：」行 → 团队域出现确认卡 → ✓ 后经验面板可见该条；✗ 后不出现；30 分钟不处理自动入库；面板待审分区可直接裁决。
