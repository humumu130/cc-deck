# PR 审查制分析报告：Multica 机制 · cc-deck 现行制 · 业界对标（三路调研，用户 1101 令）

> 2026-11-01 ｜ PM 汇总·三路回执全文见 ~/.cc-deck/artifacts/w-{multica-pr-arch,pr-model-comparison,pr-industry-bench}.md（行号级证据在彼）

## 一、结论（一段话）

**不换制。** 我们的回执审查制内核（证据账本+复跑实证+P0/P1 必修完再收割+真机分级）不只是能打——它与 Anthropic 官方最佳实践「让 agent 展示证据而非宣称成功」同构，是业界正统的证据层；八轮实战 P1×7 全部拦在收割前（含一次会让发版闸卡死的断裂级问题）。要补的不是理念，是**两个结构缺口**：结构化 diff 审查面（inline/CI 联动/多端）与机器预审常态化。建议：**回执制不动，叠加「收割段 PR 化（L1 试点）+审查四层化（AI 预审默认层+抽审分级）」**，外加 Multica 四件可直接抄的单据化/回执化设计。

## 二、Multica 的 PR 制真相（源码考古）

**「PR 是交付物镜像，issue 是审查账本」**：
- agent 自己开 PR（`gh pr create`，worktree 分支契约：交付物=分支），但**平台不做任何自动合并**——合并权恒在人
- 审查意见**不走 PR 原生评论**（`pull_request_review` 事件被 ack 后丢弃）——全走 issue 评论面四通道：assignee 评论触发/@mention 即任务/wakeup `--until-pr checks|merged`（等 CI 绿自动唤醒，30s 平台自证）/`--steer`（注入运行中回合中途纠偏）
- **review 可以是又一个 issue**（review-the-PR issue 一等公民；Reviewer 是数据字段不是机制）
- CI 三段接线：webhook 纯触发→服务端快照→条件自证（agent 永不轮询）；「query the link table — do not infer from GitHub」二阶事实纪律
- 军规：「CI running 不是交付验收——Local tests pass; CI running: <PR link> 即完整交付」

## 三、我们现行制的体检（八轮样本实测）

- **健康**：闸口制生效（P0=0/P1=7/P2≈40 全数拦截后收割）；机器闸纯本地零网络；重派率 37% 的病根在会话活性不在审查载体
- **PR 制在本仓的历史**：试过 3 笔 PR 全 CLOSED 弃收——实际用途=远端 CI 白嫖，代码最终全走 PM 直推收编
- **真缺口**：①CI 只测 relay 域（16 项），本周风暴全是 web UI 批=预检零覆盖（web 测试入 CI 才是前置工程，独立立项）②织合冲突 5 次/夜批全靠 PM 手工 merge-tree（工具面可升级）③回执游离在任务态外（无状态投影）

## 四、业界对标（四层模型已收敛）

`agent 开 draft PR → 确定性闸+AI 机器预审 → 风险分级人审（终审/抽审） → 合并后快速回滚兜底`
四家头部（Claude Code/Copilot/Codex/Cursor）无一例外把人放最后一层；Google AutoCommenter 量产；检出率 200-400 行拐点；DORA 2025：AI 放大器效应（吞吐↑不稳定↑）。

## 五、裁定清单

### 采纳（三层叠加，回执内核不动）
| # | 措施 | 依据 | 成本 |
|---|---|---|---|
| 1 | **L1 试点：收割段 PR 化**——PM 收割时 push 分支→开 PR（body=回执镜像）→CI（pull_request 触发器已在，relay 16 项免费）→**PM 手按 squash merge**=托管版收割→`--delete-branch` | 本仓三笔历史=自然先例；多端 diff/冲突面/CI 前置三收益 | +2~4min/批；代理断则退回本地 squash（PR 恒 advisory） |
| 2 | **AI 预审常态化**：/code-review 从可选项升为 L1+ 默认层，人审读机器报告+抽核 | 业界默认层 | 近零 |
| 3 | **抽审分级+超体量升档**：审查定档表加抽审率（低风险机器审+人抽 20%；diff>400 行自动升高档） | Anthropic spot-check+检出率拐点 | 规则化 |
| 4 | **回执 checklist 增项**：「重复引入/未复用既有件」（AI 特有缺陷，GitClear 重复 4× 实证） | GitClear | 一行 |

### 从 Multica 直接抄（与 C 模式批次天然接驳）
- **review-as-issue 单据化**：审查回执升格为板卡子单/字段（状态三面投影，钩子有账可查）——与席位语义手术同族
- **trigger_outcomes 同步回执**（blocked/coalesced/deferred）：派单活性从巡检变回执
- **条件自证唤醒**（--until-pr 式）：等外部事实（CI 绿/装机版本对齐）自动唤醒 PM，替代超时巡检——我们还有 events.ndjson 事件流优势（他们 30s 轮询是无总线的妥协）
- **CI 不等军规**入 worker 岗位纪律：「本地测试过+CI 在跑=完整交付」

### 不采纳
merge queue（大团队并发件，单人=净负担）｜多审批人/CODEOWNERS 官僚层（无第二审批人）｜AI 签核（GitHub 默认也关；我们的反方路是更好的第二双眼）｜worker 自开 PR（权限面扩大，L1 由 PM 收割时开）｜「人审已死」极端化（四项不可自动化内核仍在：用户验收/复核判断/闸口决策/验收标准预置）

## 六、勘误与遗留

- **勘误（R4）**：PM 早前「mac CI 额度耗尽」断言无实据——仓库 PUBLIC 标准 runner 免费，10-31 desktop 取消原因未明（非额度证据）；已重跑排队验证中
- 遗留：web 测试入 CI（独立立项，预检真收益的前置）；L1 试点授权（建议下一夜批 2~3 笔试跑）；leader-harvest 加 advisory PR 状态项（~20 行，随 L1 试点）

结果：不换制；回执内核=业界正统证据层；采纳收割段 PR 化 L1 试点+AI 预审默认层+抽审分级+Multica 单据化四件｜改动文件：本文档
