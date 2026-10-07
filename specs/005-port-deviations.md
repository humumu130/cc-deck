# 005 移植偏差备案总档

> 军规依据：完全还原 005 原型（`specs/005-prototype-a.html`），一切细节优化须偏差备案。
> 本文是**跨批汇总索引** + 无 report 载体批次的补录处；各批自有 report 的以其 report 为权威表述。
> 原型参照系唯一：`specs/005-prototype-a.html`（不是 `web-console/index.html`——那是 v1 旧版）。
> 盲评参照：A 卷（视觉还原，/tmp/005-review-a.md）、B 卷（工程质量，/tmp/005-review-b.md）。

## 状态总览

| 批次 | 提交 | 备案体系 | 权威载体 |
|---|---|---|---|
| B1 壳骨架 | a273dbf | D01–D20（样式逐字节一致，SHA 核验） | 005-port-B1-report.md |
| B2 会话域 | 840321e | DV2-1…（本文补录，无独立 report） | 本文 |
| B3 团队域 | f888221 + 3af0643（契约） | B3-D1…D10 | 005-port-B3-report.md |
| B4 项目+通知 | 1d6ac2b | DV4-1…3 | 005-port-B4-report.md |
| 盲评修复批 | 994547a | 工程修复（A-1 止血等）；架构级差异记 DV-ARCH | 提交信息 + 本文 |
| ⑥a 视觉修复批 | 575058e | D6a-1…D6a-3 | 本文 |
| ⑥b 本档 | b6931ce | — | 本文 |
| ⑥c-1 设置域 B6 | eeaebca | DV6c-1…DV6c-3 | 本文 |
| ⑥c-2 移动端四屏 | c38224c | DV6c-5 | 本文 |
| ⑥c-3 m-detail 五 tab | 28d9970 | DV6c-4、DV6c-6 | 本文（派单模式首批：worker 实施，Leader 核验代提交） |
| #150 收敛线 R1-R3 | 1d676e7 / 2830005 / 98e8904 | DV-ARCH 终态达成（本批不改用户可见面） | 005-arch-convergence-survey.md + 本文 DV-ARCH 节 |

## B2 会话域补录（DV2-）

B2 无独立 report（worker 交付短式提交），已知持久偏差在此补录：

- **DV2-1 检查器首块替换**：原型第三列检查器静态首块为「验收进度」（演示数据 2/3）；B2 接真数据后替换为「会话」信息块（标题/引擎/目录），其余三块（任务清单/用量/输出物）保留原型结构与命名。理由：SNAPSHOT 无按会话的验收进度实体，演示数字不可伪造。
- **DV2-2 列表接管协议**：B2 以 `data-b2Owned` 标记接管会话列表渲染与走秒，地基 `renderSessionList` 见标让位（盲评 A-1 止血，994547a）。这是双渲染者并存的过渡形态，非终态——见 DV-ARCH。
- **DV2-3 演示态→真数据替换面**：任务书授权范围内的整域替换（对话流/输入栏/任务 tab/输出物 tab/用量 tab/头部联动）不逐条备案，以 8c8c5b6 任务书 B2 段为授权清单。

## B4 项目+通知补录（DV4-）

> 权威表述见 005-port-B4-report.md（⑥e 补写：实施面/桥契约/B4-C 契约清单/DV4 详述），此处保留索引。

- **DV4-1 WS 桥形态**：B4 以 `TappedWebSocket`（window.WebSocket 劫持）从地基连接搭桥，暴露 `window.__ccDeck005B4`。994547a 后桥命令固定走主连接（ACK 不串台）。完整收敛（地基唯一持连 + 订阅 API、拆除劫持）**另立任务，出包前排期**——B 卷结论：「连接架构的账必须在出包前算清」。
- **DV4-2 S-3 `var(--sans)` 未定义**：L369/L914/L918 三处 font 简写引用未定义变量、回退继承。**与原型逐字节一致（原型同款），按资产一致性不修**。若未来原型方补 `:root { --sans }` 定义，随样式同步带入。
- **DV4-3 静态壳演示数据保留**：设置域（B6 未施工）、移动端（B7 未施工）、部分 stub 区的原型演示文案仍在原位，由 ⑥c 收口处置；收口前的差异属施工排期而非偏差。

## ⑥a 视觉修复批新增（D6a-）

- **D6a-1 菜单禁用态**：右键行菜单对只读会话（`canCmd` 为假：历史且非 external）置灰置顶/重命名/删除三项，`复制 ID` 恒可用；新增 `.row-menu button:disabled` CSS 三条。原型演示态无禁用分支，此为接真数据的新增防御（relay 侧同规则拦截，双保险）。
- **D6a-2 待处理溢出回落**：待处理组封顶 3（置顶优先），第 4 项起回落「其他会话」组按项目子分组显示。原型演示态溢出项不显示（`slice(0,3)` 后丢弃）；成品不丢会话卡片。分组头计数如实反映各组实数。
- **D6a-3 复制 ID 兜底**：`navigator.clipboard` 不可用（非安全上下文等）时 `execCommand("copy")` textarea 兜底；全败时 toast 提示手动复制。原型仅静态 toast。

## ⑥c 设置域+移动端收口批（DV6c-）

- **DV6c-1 设备/配对记录空态**（c1）：SNAPSHOT 无已配设备与配对记录数据源。设备 pane 如实空态「设备管理在桌面端完成」；配对记录 pane 如实空态；配对入口降级为 toast 指引「分享本页同款带 token 的链接即可加入」。原型演示行为态，不伪造清单。
- **DV6c-2 identity 角色卡=default_for_roles 投影**（c1）：原型 identity 面板四成员卡为演示数据；成品=engine_catalog `default_for_roles` 反查、按首引擎聚合 member-card，无角色缺省引擎时如实空态。语义从「成员」改为「角色缺省引擎」，与 relay 侧 org role_defaults 对齐。
- **DV6c-3 检查更新/云桥状态如实「未知」**（c1）：检查更新=toast「当前已是最新版本·网页端随 relay 部署更新」（网页端无独立更新通道，随 relay 部署更新是事实）；云桥行 tag info「未知」——云通道状态未随网页端 SNAPSHOT 下发，不伪造连接态。
- **DV6c-4 B2 导出面**（c3）：B2 IIFE 尾挂 `window.__ccDeck005B2 = { S, canCmd, sendPrompt }` 供 005-mobile IIFE 复用会话状态、只读判定与发送链（sendMessage 强耦合桌面 composer，导出 sid+text 包装，命令类型同源 COMMAND_MESSAGE/COMMAND_EXT_INPUT）。属 DV-ARCH 双连接过渡形态的延展——域间数据通道从 B4 桥单通道扩为 B2+B4 双导出面；终态收敛（地基唯一持连+域订阅 API）时一并拆除。
- **DV6c-5 移动端演示数据→真数据授权清单式总备案**（c2）：m-inbox/m-notify/m-team/m-project/m-settings 六屏静态演示替换为 B4 桥真渲染（导航栈/待处理3+项目子分组/通知三键/三 tab/摘要四数/设置行真数字），整面替换不逐条备案，以 ⑥c 任务书为授权清单（同 DV2-3 口径）。
- **DV6c-6 移动端审批仅浏览验证**（c3）：m-detail wait-card 真数据视觉（标题/摘要取 waiting_request），两按钮（拒绝并说明/允许一次）点击 toast 引导「审批操作请在桌面会话域完成」。产品口径：移动端不做真审批命令链（误触风险+确认场景需要完整上下文），非能力缺失。

## 架构级（DV-ARCH）

- **DV-ARCH 双连接过渡形态（历史备案，已收敛）**：地基与 B2 各持一条 ws + 三套命令等待表 + WebSocket 劫持桥并存（994547a A-1 止血后用户可见面无已知缺陷）。**终态已于 #150 收敛线达成**（2026-10-07，R0-R3 提交链：a1c8822 勘察 / 1d676e7 R1 帧总线+桥去劫持 / 2830005 R2 B2 并轨 / 98e8904 R3 收口）：
  - 地基 `connectLan` 为全页唯一物理连接（`new WebSocket` 恰 1 处），挂 `window.__ccDeck005MainWs`；
  - `window.__ccDeck005Frames` 帧总线单源分发：`{kind:"frame",frame}`（地基 parse 后的对象）+ `{kind:"ws",state:"connecting"|"open"|"close"}`，订阅者异常隔离；
  - 桥劫持面（TappedWebSocket / `window.WebSocket` 替换 / sockets / activeSocket）与 B2 自持连接（connectB2 / 重连退避 / 握手超时）全部退役；桥 connection 三态由地基 ws 事件驱动（修正旧世界跟错 B2 的隐性错位）；
  - 命令三表并存隔离：Team `team-` 前缀 / B2 `S.ackWaiters` uuid / 桥 `ackWaiters` uuid——键空间互不相交，ACK 多播后各自认领、跨表必 miss；
  - R3：桥 sessions 浅拷贝切断与 B2/地基的共享对象别名（桥 merge 以信封 ts 覆写 updated_at 不再越权污染他域，#157 水合语义）；B2 自发命令失败回执补齐。
- **DV-ARCH 决策（用户拍板 2026-10-07）**：**先收敛再出包**——连接架构收敛为 ⑥d 出包的前置任务（台账 #150），0.7.0-test.2 不带双连接形态出包。（同日 Leader 曾提案「test.2 带过渡形态出包、收敛排正式版前」，用户选择更严格的先收敛路线。）**决策已执行完毕，收敛完成。**
- **收敛残留（备案不修）**：①握手 8s 超时双排程为 R0 既有形态（非回归）；②让位网（b2Owned）/选中链（DOM class 驱动）/三方数据副本分持=渲染层议题，后续另行评估；③DV6c-4 B2 导出面（`window.__ccDeck005B2`）与 B4 桥（`window.__ccDeck005B4`）作为域间数据通道保留——域订阅 API 化属下一轮架构演进，不阻塞出包。

## 合流闸口径（⑥d 出包前检查）

1. 所有 P1/P2 级偏差有归宿（修掉或有 DV 编号备案）✓（A 卷 P1×2 已收口于 ⑥c；R3b 复核 P2/P3 已清零）；
2. DV-ARCH 收敛完成 ✓（#150 R0-R3 提交链 a1c8822/1d676e7/2830005/98e8904，2026-10-07）——出包闸放行；
3. B4 report 补写（⑥e，f2e19c6）后 DV4 系列指向迁移 ✓；
4. 本文档随每批更新，新偏差先入表后合入 ✓。
