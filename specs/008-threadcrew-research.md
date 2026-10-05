# ThreadCrew 与 Orca 对照评估：本地多 Agent 编排的两个业界样本

- 调研日期：2026-10-05～06（混编团队 M2 任务 #008）
- 方法与素材声明：本机到 GitHub 直连/代理均不可达（网络受限）。ThreadCrew 素材来自 PM 经 GitHub API 核验的仓库元数据与官方 README 全文；Orca 素材来自 web 检索侧写（官网/GitHub/第三方评测/社区讨论）。**两者源码均未直接拉取**，细节评估按此标注置信度。
- 对照基线：`specs/018-backend-implementation.md` §9 组织模型 v2、`specs/019-pm-duty.md`（PM 职责与值守）、`specs/009-beads-research.md`（格式模板与 beads 采纳包）。

## 1. 对象定位结论

**ThreadCrew：定位成功（用户更正拼写后）。** 原始地址 `ryan-ezier/threadcrew` 404 系拼写出入；更正为 `github.com/ryan-eziar/ThreadCrew`（public、非 fork、v0.3.4；owner 账号 2026-09-24 新建，名下仅此一 repo）。官方定位："One local room for you, Claude Code and Codex. Your agents keep their own apps and sessions."——本地「房间」制多 Agent 群聊协调器：Claude Code/Codex 各自保留自己的 app 与会话，ThreadCrew 只做房间内消息传递，不调 API、不托管会话。Windows 优先。README 已核机制：群聊互发消息、讨论轮次控制（三轮）、Kick off 预算会话、agent 互派评审、断线重连 paste 房间史恢复、附件/房间/备注/搜索/导出；源码树 118 文件（src/ui/docs/tests/chat.mjs/AGENTS.md/CLAUDE.md 等）。README 与全量路径扫描零 orca 提及——**非 Orca 组件**。

**Orca：独立项目，主候选 stablyai/orca（高置信）。** 用户确认其独立于 ThreadCrew。同域检索候选中 `github.com/stablyai/orca`（官网 onorca.dev，Stably AI 出品，MIT）与用户语境（「ThreadCrew 类似功能」=本地多 Agent/双 CLI 混编）完全吻合：Agent Development Environment（ADE），统一跑 Claude Code/Codex/Gemini/Cursor CLI/OpenCode 等 CLI agent；每 agent 隔离 git worktree；orchestration skill 注入 coordinator agent 管理任务 DAG、decision gates、agent 间消息；桌面+移动端，宣传支持 10–100 并行。近似候选已排除：heddles/agent-orca（K8s 编排，不同域）、echoVic/orca-agent（DeepSeek 单 agent，不同域）。

## 2. 对照评估表

### ThreadCrew vs cc-deck 混编团队

| 维度 | ThreadCrew 机制 | cc-deck 现有设计 | 判定 |
|---|---|---|---|
| 编排原语 | 房间+群聊消息是唯一原语；agent 保持自有 app/会话，无任务契约 | 会话卡+任务书六件套（自包含契约）+PM 分诊派单+board 泳道 | **不同范式**：消息流自组织 vs 指挥链+显式契约；生产编排需契约与台账，不换 |
| 执行模型 | 不托管进程、零隔离；讨论三轮=轮次约定；重连靠 paste 房间史回灌 | relay 托管生命周期、dispatch 状态机、同靶子单写者、worktree 磁盘隔离 | **我们强**：零侵入以放弃管控为代价；重连 paste 行恰是托管缺失的补丁 |
| 人机边界 | 人是房间平等成员随发随插；无审批门，Kick off 即放行 | 确认卡唯一决策入口（立项/升降级/生产变更）+019 值守升级 | **我们强**：无硬门=高风险动作无审计边界，不可接受 |
| 可观测/对账 | 群聊即可见性；附件/备注/搜索/导出；无台账无 ACK 对账 | events.ndjson 事件事实源+dispatch-log+对账四类异常+duty-rounds 审计 | **我们强**：其导出≈我们台账导出的弱化版 |
| 依赖/门控 | 无依赖图；轮次/互派评审是隐式时序约定 | beads 采纳包：depends_on+ready 就绪集+gates→blocked（#43 待实施） | **无借鉴**：互派评审语义评审卡已覆盖且更严（盲评/跑完即删/不继承权限） |
| 强点/不适用 | 强点：①agent 会话主权不动（零侵入接入用户既有 CLI 流）②全员同房间天然可见 | ②已被团队对话聚合（018 §3.5 只读 timeline）覆盖；①是我们未走的轻路线 | **抄思想不抄实现**：①记档为远期外部自管会话接入参考，006 fail-closed 不动 |

### Orca vs cc-deck 混编团队

| 维度 | Orca 机制 | cc-deck 现有设计 | 判定 |
|---|---|---|---|
| 编排原语 | ADE 壳+coordinator agent（skill 注入）+任务 DAG+decision gates | PM 常驻重角色（可 parked/resume）+任务书+board+确认单 | **高度同构**：coordinator≈PM、DAG≈beads 依赖图、gates≈确认卡/blocked；但其无验收权/代提交式权责切分 |
| 执行模型 | 每 agent 隔离 git worktree 为产品默认；10–100 并行宣传；多 CLI 原生进程并存 | worktree 磁盘隔离是 0927 事故后纪律（+check-bundle-sync）；六引擎 EngineRegistry 统一 adapter | **方向互证**：隔离思想一致（它产品化、我们纪律化）；引擎接入它走原生进程、我们走统一 adapter+fail-closed，各自成立 |
| 人机边界 | coordinator 管 decision gates（谁关门/是否人类唯一写面未深查，置信低） | 确认卡唯一决策入口+019 审计副作用校验 | **可能同向，证据不足**：文档可访问后补查，不预借用语 |
| 可观测/对账 | 全局 IDE 视图看 agent 状态（desktop+mobile）；审计/对账机制未深查（置信低） | events/台账/ACK 对账/值守审计全链 | **我们已备**，可见无新意 |
| 依赖/门控 | coordinator 显式管理任务 DAG（依赖+决策门） | beads 采纳包 depends_on/ready/blocked 待实施 | **独立印证**：业界同类同样收敛到 DAG+gate，#43 路线无需动摇 |
| 强点/不适用 | 强点：①worktree 隔离产品默认②orchestration-as-skill（编排=skill 注入，无独立基础设施）③多 CLI 统一壳 | ①已有纪律等价物；②PM 职责已 prompt 纪律化（任务书/引导词），relay 台账/权限是刻意加重 | **无引入价值**：重 IDE 形态、无组织模型/确认漏斗/值守，与我们「轻 relay 后台」形态相反 |

## 3. 结论

- **ThreadCrew：观望，抄一个思想。** 不引入（无审计/无契约/无依赖图、Windows 优先、repo 生命周期不足两周）。唯一记档思想：「agent 会话主权不动」的零侵入轻路线——远期外部自管会话接入观察面时可参考，当前不动 006 fail-closed。
- **Orca：观望，作思想验证值。** 不引入（重客户端 IDE、无组织模型）；其价值在独立印证我们已拍板的两件事——worktree 隔离默认化、coordinator+DAG+gates（≈PM+beads 采纳包）。可作季度级观察对象，无行动项。

## 4. 若采纳：落地路径

两者均**不进入 relay/board/任务书域**，无落地组件。思想层面：

- **与 beads 采纳包关系（明确）：平行印证，非融合非重叠。** Orca 的 coordinator-DAG-gates 模型独立印证 #43（depends_on/ready/blocked）方向，实施计划不变、不加字段不加语义；ThreadCrew 与依赖门控无关。
- **外部自管会话观察面**（ThreadCrew 强点①）：若未来出现「用户自有 CLI 会话（不经 relay 托管）接入团队对话/观察」需求，参照其房间消息总线形态在 relay 侧做只读投影；M3+ 远期候选，不排期。
- **评审互派**（ThreadCrew）：评审卡机制已覆盖且更严格，无动作。

## 5. 风险清单

- **素材置信度**：ThreadCrew 基于官方 README+PM 核验（中高置信）；Orca 基于搜索侧写（中置信）。两者源码未直接拉取，失败重试/gate 关闭语义/对账机制存在误判可能，网络可达后可补拉修正本节结论。
- **轻路线诱惑**：ThreadCrew 零侵入看似省事，但放弃台账/审计/隔离等于回到 0926/0927 事故前状态；我们的重资产（单写者/对账/确认卡）是事故教育出来的，不为省事让渡。
- **规模宣传干扰**：Orca「10–100 并行」与 018 §5.9 实测结论（并行上限由靶子决定）相悖，不作为容量规划输入。
- **生态早期**：ThreadCrew repo <2 周（v0.3.4），Orca 亦处早期，形态可能剧变；此刻任何深度集成/字段对齐都是负资产。

## 6. 给用户的拍板点

1. **两者均「不引入、仅思想记档」是否认可？**（worker 推荐：认可；本单无代码增量，文档即全部产出）
2. **「外部自管会话观察面」是否列入 M3+ 远期候选？**（ThreadCrew 强点①，跨源/外部 agent 接入的参考形态）只记档不排期。
3. **Orca 是否列为季度观察项？** 其 decision gates 与多 CLI 接入实现，待 #43 落地后可比对一次；只决定要不要记观察档，无行动。
