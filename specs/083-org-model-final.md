# 083 组织模型终版对照汇总（十轮评审收齐 · 待用户拍板）

> 状态：**已拍板（2026-10-06 用户授权「按团队建议」定案，P1-P6 全过，含 081/PM-75 吸收）**——本文件升级为实施依据；实施四件按 §6 依赖序排队（B 模式启用判据不变：2-3 团队以上才启用，当前单团队试点=A 模式，实施不急）。原评审脉络：评审文档 /tmp/codex-minstaff-review.md（十轮，890 行）；正式落文档版=018 §9 组织模型 v2（f6fcdb5）；角色×引擎映射=006 §6.1；多引擎权限=081 §2-6；开卡选择器=PM-75 §3-6；值守口径=019-pm-duty.md。
> 本文件是拍板入口：P1-P6 拍板点 + 实施四件清单 + 伴随面四问全检。拍板后本文件升级为实施依据（任务书「依据文档」栏引用）。

## 1. 十轮收敛结论（一句话）

产品不是在 A/B 两套团队间二选一，而是在同一条「Leader 位 → PM → Worker」结构上切换 Leader 位由用户自任（A）还是 AI 薄 Leader 委托承担（B）；PM 始终是团队常驻重角色，评审卡始终是按需临时角色。（评审 §16 verdict）

## 2. 终版模型速查（详版 018 §9）

| 项 | 终版口径 |
|---|---|
| 默认模式 | **A（self）**：用户占 Leader 位不占卡，直达各团队 PM；单团队最小 2 卡（PM×1+Worker×1） |
| B 模式（delegated） | 用户与各 PM 间插一个全局**薄 Leader**：只路由/聚合/提醒/升级；**无验收权、无 commit 权、无 PM rescue 接管权**；开关插拔 |
| B 启用判据 | 单团队不开 B；2-3 个团队以上且跨团队沟通/持续值守收益明显时才启用 |
| 开关粒度 | 第一版**全局二值**，作用域与 relay/org 根一致；per-team 混合第二阶段 |
| 切换机制 | `active → switching → active(new_mode)`；A→B 注入上下文、B→A 生成 PM 交接清单；在途派单/确认/验收安全收口后生效；**失败保持旧模式** |
| PM 职责面 | 分诊/任务书/派单/验收链/巡检/代提交/团队板与台账维护/Worker rescue；A 直接面向用户，B 面向薄 Leader |
| 评审卡 | `proposed → active → retired`；盲评/复审/高风险验收/专项审查；跑完即删不计常驻编制 |
| 通知路由 | A 落用户可见面；B 先投薄 Leader 再聚合；通知必须带 `project_gid` + PM 来源 + 返回路径 |
| 存储 | 新增轻量 `org-config.json`（mode 持久化）；不把 mode 只放进 OrgAnchor（A 模式可能无 Leader 锚） |

**薄 Leader 作用域（§15.4.1）**：第一版=一个 relay/org 作用域一个薄 Leader；多 `org_id` 并存时必须按 org_id 索引 leaderId/锚/mode（第一版明确不做，边界已记录）。

**B 消息管道按第十轮降级（§15.4.2）**：管道运力已存在（COMMAND_MESSAGE 点对点+回执+通知+快照），无新总线无新命令类型。真增量仅三块：①投递目标模式分支（recordOrgConfirmNotification sessionId / notifyDispatchClosed 目标选择）②薄 Leader 卡产品化（引导词/开卡生命周期/交接快照/SNAPSHOT 入口）③团队归属判断是薄 Leader 的 AI 行为（不硬编码进 ws-server）。relay 变动量=小至中等的投递分支+卡生命周期，不是中等新管道。

## 3. 引入伴随面四问全检（#84 机制 · 对「PM 常驻化+双模式」整体）

| 问 | 全检结论 |
|---|---|
| ①影响哪些现有功能 | M2「AI Leader」卡改身份（team_pm，保上下文不删卡）；通知默认目标 leaderId 需按模式分支；派单 actor 语义（新写 pm+source_pm/gid，历史 actor:"leader" 可读兼容）；UI 词汇 leader-label 等；ensureLeader 生命周期挂 mode（B 卡失联不无条件重建，回退 A 用户可见面） |
| ②需要哪些配套 | org-config.json；A 模式 PM 工作台（关键路径非备用面）；薄 Leader 受限 prompt（现有 org.ts CLI/提示词偏「全套分诊」，必须收窄为路由/摘要/转交/聚合，否则薄卡工具面变重 PM）；SNAPSHOT 下发 mode+入口；设置页角色模板（引擎×模型） |
| ③什么情况下失效 | 薄 Leader 卡死/失联/切换失败（回退 A 用户可见面，交接快照保 B→A）；跨 org_id 多组织（单 leaderId 串台——第一版单 org 作用域内不发生）；B 下用户绕过 Leader 直达 PM（见 P6：第一版为 UX 委托非权限强制）；PM 卡休眠（角色责任不消失：队列/权限/团队上下文/交接责任随团队存续） |
| ④如何回退 | 模式切换状态机失败保持旧模式；B→A 交接快照；存量 actor:"leader" 历史值继续可读；改名批全部带兼容别名（#9 文案批先例：先 UI 文案后代码字段） |

## 4. A 模式 PM 工作台清单（W 线新增关键路径，018 §9.7）

- [ ] 团队目录 + 选 PM 发需求（直达入口）
- [ ] PM 队列四态视图：待处理 / 等待用户 / 验收中 / 空转
- [ ] 建派单 / 确认卡决议（用户侧确认单 ✓/✗）
- [ ] 回执流（dispatch-log 按 project_gid 过滤，谁派活谁收通知 M4 复用）
- [ ] 通知携带 project_gid + PM 来源 + 返回路径（点击回原团队）
- [ ] 005 原型已切 PM 词汇（544dceb/096eb9e 落库）；工作台形态=新画布（#83 实施件①）

## 5. 角色 × 引擎配置面（006 §6.1 已落表）

| 角色 | 档位 | 生命周期 |
|---|---|---|
| PM | 强推理档（Claude/Codex 级） | 常驻，随团队 |
| 薄 Leader | 中档 | 仅 B 模式插拔 |
| Worker | 按任务选档 | 常驻 N≥1 |
| 评审卡 | 强档 | 临时，跑完即删 |

落设置页角色模板：engine+model 两栏，出厂默认+单卡覆盖（实施件④）。

### 5.1 多引擎权限抽象（081 吸收）

- 083 只保留组织层契约：采用「统一归一档位外层 + 引擎 native detail 内层」；归一档位供角色策略和三端消费，native 值只由适配器确认后记录，映射失败不得静默升权。完整矩阵、降级和审计规则引用 `specs/081-multi-engine-permission.md:58-103,120-145`，本节不复制。
- 混编团队新开卡缺省请求为 `bypassPermissions`（用户 2026-10-06 拍板）；这是服务端策略输入，不等于必然 effective。服务端按环境、tier、业务角色和引擎 capability 求值，生产仍可降级或返回 forbidden。
- 组织/会话审计至少保留 `requested`、`effective`、`actor`、`reason` 四项；`normalized/native/capability` 为解释与适配细节。P81-1..9 的依赖拓扑与 StoragePort、旧卡回退、三端呈现闸门见 `specs/081-multi-engine-permission.md:160-226` 及 P81-PLAN 回单。
- 角色表中的 engine/model 是 role_defaults，不是第二权限事实源；手动权限请求仍须经过服务端策略，薄 Leader 不因 B 模式身份获得验收、commit 或 PM rescue 权限。

### 5.2 开卡引擎选择器（PM-75 吸收）

- 开卡求值顺序固定为：**手动选择 > 角色预置 `role_defaults` > 源默认**。手动选择只覆盖当前卡/当前派单，不回写组模板；选择器只消费 relay 暴露的可用性、能力和 effective 摘要，不复制权限映射。详见 PM-75 §3-5（`docs/reviews/2026-10-06-pm75-pm.md`（PM-75 归档））。
- 三端共用同一引擎词表和降级语义：显式选择未安装/未通过 preflight 的引擎即阻止提交；默认引擎不可用不得静默换引擎；旧 relay 缺字段时只显示安全的旧能力，不假造新引擎已选中。详见 PM-75 §4、§6（`docs/reviews/2026-10-06-pm75-pm.md`（PM-75 归档））。
- B 模式薄 Leader 由角色生命周期使用其 role_defaults，不新增一套选择器权限；用户手动选择只作用于用户发起的 PM/Worker 卡。该交互已由 P1（薄 Leader 角色边界）与 P6（B 模式绕过策略）覆盖，无需新增 P7。

## 6. 实施四件（拍板后开单；顺序建议=依赖序）

| # | 件 | 内容 | 主要靶子 | 量级（评审 §15.6） |
|---|---|---|---|---|
| ① | 005 A 工作台 UI | §4 清单六项画进 005 团队域（原型先行定形态） | specs/005-prototype-a.html | 中（设计批） |
| ② | 模式开关批 | org-config.json mode(self\|delegated) + 切换状态机（switching+交接包+失败保持旧模式）+ SNAPSHOT 下发 mode/入口 + 通知目标模式分支（recordOrgConfirmNotification sessionId / notifyDispatchClosed）+ ensureLeader 挂 mode | relay/src/{org,projects,session-manager,types,ws-server}.ts | 小-中改×5 文件，session-manager 最高风险 |
| ③ | 词汇/标识符改名批 | 019 八个未实施标识符（feedPM/pm_actionable_work 等）+ 带注项（ensureLeader/leaderId/leader-label）+ org.ts 引导词拆双套（PM 全套管理 / 薄 Leader 只路由聚合）+ web/expo 存量词汇收口（W3 后残点）+ role:"leader" 存量读映射 team_pm | relay+web-console+expo | 小-中（#9 先例：先文案后字段带别名） |
| ④ | 设置页角色模板 | §5 表落设置页（engine+model 两栏出厂默认+单卡覆盖） | web-console+expo 设置域 | 小 |

顺序理由：①先定形态（005 是设计宪法）；③的文案半批可先行（零风险）；②是结构批（通知分支依赖 mode 存在）；③的标识符半批在②后（isLeaderSession 拆分依赖 global_leader 标识）；④独立收尾。

## 7. 拍板点 P1-P6

- **P1 终版方案**：§2 表整体确认（A 默认/B 全局二值开关/薄 Leader 无验收无 commit/评审卡跑完即删/PM 常驻重角色）——018 §9 已按此落文档，确认即冻结。
- **P2 实施四件与顺序**：§6 表（①→③文案半批→②→③标识符半批→④）或用户调序。
- **P3 M2 试点卡迁移**：现有沙盒「AI Leader」卡（本 PM 会话）保上下文改身份 team_pm，不删卡重建（评审 §17.4：判据=旧卡仍能恢复原上下文继续管理团队）。
- **P4 停 Codex 评审卡**：十轮评审收齐，本汇总为最后一单；拍板后评审卡 a773b5b0 按生命周期 retired 删除（决策记录与审查产物保留在评审文档）。
- **P5 Worker 扩编**（悬置项，用户曾问「沃客够用吗」）：当前 H+G 双卡在飞 W3/C1；余线 W3→P1→T2/T3、C2/C3、V1 + 实施四件。建议加 1 张 GLM worker-I（接 005 域 #79/#80 输入栏与存量特性批+文档批类），点头即开卡。
- **P6 B 绕过策略**：B 模式下用户直达 PM 是否禁止。第一版建议=UX 委托（UI 引导经薄 Leader，不加服务端强制门禁）；若要权限强制，②中加模式门禁改点。

**P1-P6 复核（含 081/PM-75）**：权限默认、effective 求值、角色预置与手动选择覆盖、旧 relay 降级，以及 B 模式薄 Leader 的选择器边界均已归入 P1/P6 和 §5.1-5.2；未产生新的用户拍板点，不新增 P7。#83 具备终版拍板条件。

## 8. 明确不做（第一版边界，防扩散）

- per-team 混合模式（第二阶段，需每项目存 Leader 位归属/授权/路由入口/交接快照）
- 多 org_id 独立 Leader（需按 org 索引 leaderId/锚/mode）
- 服务端自然语言路由（薄 Leader AI 行为，不进 ws-server）
- CommandRole(owner/operator/viewer) 与业务角色（team_pm/global_leader/review_pm）混用——两套保持分离
