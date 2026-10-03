# Beads 在 cc-deck 团队模式中的用武之地

- 调研日期：2026-10-03
- 范围：`/tmp/beads-research/` 指定材料；对照 `docs/team-mode-design.md`、`specs/006-engine-adapters-spec.md` 与现有 relay 项目/板/确认实现。

## 1. beads 是什么

- beads 是面向 AI 编程 Agent 的依赖图 issue tracker；一个 bead/issue 有类型、优先级、状态、负责人和关系。
- `blocks`、父子等依赖形成图，`bd ready` 计算当前无阻塞、可认领的工作前沿。
- `bd update --claim` 提供原子认领，评论、标签、handoff 和 merge slot 支持多 Agent 协调。
- 数据由 Dolt 版本化 SQL 存储，`bd dolt push/pull` 支持跨机器同步；联邦可连 DoltHub、S3、GCS、SSH 等 peer。
- `bd` CLI 全面提供 JSON 输出；另有 MCP、IDE/Agent setup 与 routing/hydration。
- formula 是可复用的 TOML/JSON 工作流模板，cook 成 proto，再 pour 成持久 molecule 或临时 wisp。
- gate 把人决策、定时器、GitHub CI/PR 等异步条件建模为阻塞节点。
- 它的核心价值是让工作图、上下文和审计记录跨会话存活，而不依赖 markdown 或某个 Agent 记忆。

## 2. 对照评估表

| 对照项 | beads 机制 | cc-deck 现有设计 | 判定 |
|---|---|---|---|
| issue 依赖图 vs board 泳道 | `blocks`/parent-child/related 等图关系；`bd ready` 自动释放后继工作 | 项目组 board JSON 是跨会话单一事实源，当前主要是 `todo/doing/done` 与派单联动；依赖由 Leader 拆单和 prompt 维持 | **beads 更强**：借鉴依赖字段/ready 前沿，但不替换板的用户可视泳道 |
| `bd claim` 与 handoff vs Leader 派单 | 原子 claim、自选 ready、assignee、评论/线程、merge slot，适合平行协作和交接 | Leader 按角色/引擎派单；`dispatchWorker` 先落台账再拉起，会话首条输入注入任务书和回执纪律；board claim 由 relay 原子判定 | **互补**：cc-deck 保留指挥链与引擎路由，吸收 claim/handoff/冲突串行化语义 |
| gates（人决策/CI/定时）vs 确认卡 | gate 是依赖图节点，可由人、timer、GitHub run/PR 检查后关闭，自动回到 ready | 立项、升降级、暂缓、结项、复活是持久确认单；用户是最终验收者，`ready_to_install` 永不自动 done | **互补**：确认卡继续是用户决策唯一写面；CI/定时等待可借鉴 gate，不绕过确认卡 |
| Dolt 同步与联邦 vs 多源与跨源远期 | 每工作区独立 Dolt，push/pull 与 peer federation；有 hub-spoke/mesh/分层、来源系统和主权层级 | relay 可连接公司/家里多个源，但当前不跨源混编；远期才考虑联邦；团队 board 是本机 JSON 快照+事件流 | **beads 更强**：联邦能力明显领先；当前不引入，避免把跨 relay 路由误当成 board 同步 |
| issue metadata(JSON) vs lessons 回流 | issue 可挂任意 JSON metadata，也有 `remember/recall` 持久记忆、评论和审计 | 计划中的 worker 收口回执带 lessons → board lessons 分区 → 下次派单注入；回执仍是 cc-deck 任务闭环 | **互补**：lessons 语义和注入策略由 cc-deck 定义，metadata 可作为兼容承载，不把经验散落到 beads memory |
| formulas/molecules 模板 vs 任务书模板 | formula 描述 DAG、变量、依赖、gates；pour 后成为可执行 molecule | Leader 派单任务书固定五要素：背景/任务/交付物路径/纪律边界/摘要上限；`wrapDispatchPrompt` 注入回执纪律 | **互补**：任务书是单次派单契约；formula 可描述可复用的多步作战，不替代五要素 |
| bd CLI/MCP vs relay 命令面 | `bd`/MCP 直接操作 issue 图，适合 Agent 自助查询、claim、comment、JSON 消费 | 所有 board/dispatch/confirm 走 relay 鉴权信道和事件流；六引擎统一由 AgentAdapter 接入，不能泄漏引擎原始协议 | **我们已覆盖**：relay 仍是执行与权限中枢；beads 只能作为可选工具面，不能绕过 relay |
| 版本化审计 vs board/events | Dolt 提供行/字段级历史、分支和冲突合并 | board.json 记当前态，events.ndjson 记 relay 事件；内部数据不进 git，收团后板只读归档 | **互补**：beads 增强历史与跨机协作，但 cc-deck 事件流仍负责端上实时恢复和会话审计 |

## 3. 结论：部分用

结论不是把 beads 当作 cc-deck 的替代品，而是**部分用**：保留 relay、board、Leader 派单、任务书和确认卡为主模型；吸收 beads 的依赖图、原子 claim、handoff、gate、formula 设计，并把 beads 作为可选后端/工具，不作为默认基础设施。

明确取舍：

1. **直接集成 `bd` CLI：暂不进入 M1/M2 默认路径，M3 做实验性可选存储后端。** 在 board provider 接口后提供 `JsonBoardProvider` 与 `BeadsBoardProvider` 二选一；relay 通过 `bd --json` 读写，不让 UI/Agent 直写 Dolt，不做 JSON board 与 beads 双写。
2. **只借鉴设计思想：现在就采纳。** board 增加可选 `depends_on`/关系、handoff、lessons、外部引用等字段；派单前计算 ready 子集，认领保持 relay 原子操作；任务书继续是唯一 prompt 契约。
3. **MCP：作为 M2/M3 的只读或受控写入入口评估。** 可让 Leader/worker 查询依赖、历史、lessons；写操作必须回 relay 命令，或在选用 `BeadsBoardProvider` 的团队中统一落 beads，禁止同一团队两套事实源。
4. **不采纳 Dolt 联邦作为当前多源方案。** 它解决 issue 数据复制，不解决 cc-deck 的 relay 身份、会话、引擎能力和跨源混编协议；跨源联邦仍按 cc-deck 远期架构另行设计。
5. **不让 beads gate 取代确认卡。** 人类立项/升降级/结项仍由 cc-deck confirmation funnel 产生副作用；CI/定时等待可映射为 board 的 blocked/gate 信息。

## 4. 若采纳：落地路径与风险

### 落地路径

- **M1（当前 board 闭环）**：不引入 Go/Dolt/bd 依赖；在现有 board JSON 中加入可选依赖关系、handoff、lessons 和 gate 描述，`bd ready` 的思想只在 relay 内实现。任务卡仍由 Leader 创建/派单，worker 回执回 board。
- **M2（验收与经验回流）**：把 `depends_on` 接入派单前置检查，把 gate 映射到 `blocked`；人类确认卡仍是唯一决策入口。lessons 由收口回执写入 board lessons 分区，下次任务书按项目/角色/引擎筛选注入；不全量灌入 Leader 上下文。
- **M3（跨项目复用/实验）**：实现可插拔 board provider；先做 `bd --json` 读写和 MCP 只读 spike，再决定是否开放 `BeadsBoardProvider`。选 beads 后，board UI、派单台账、确认卡、事件广播仍由 relay 适配，避免 bd 成为第二套编排器。
- 与 `specs/006-engine-adapters-spec.md` 的关系：beads 位于引擎无关的编排/持久化层；六引擎只看到统一任务书和回执，不在各 adapter 中分叉 beads 逻辑。

### 风险清单

- **Go+Dolt 依赖**：cc-deck 当前是桌面/本机 relay 的低依赖形态；引入 `bd`、Dolt server、schema migration 和版本兼容会扩大安装与故障面。
- **分发与升级**：macOS/Windows/多 relay 需随包分发或探测 `bd`，还要处理 CLI 版本、PATH、权限、Dolt 二进制和离线升级；缺依赖时必须可退回 JSON board。
- **存储双轨**：JSON board、events.ndjson、dispatch log、确认单与 Dolt 历史若双写，极易出现卡状态、认领、回执不一致；必须 provider 单选、迁移有快照/回滚，禁止隐式双主。
- **同步/冲突/租约**：Dolt 联邦中 issue 状态跨 replica 可能滞后，claim lease 不跨 replica 复制；不能把远端 stale assignee 当作本机存活判断。
- **语义越权**：bd gate 自动关闭或 Agent 直用 `bd close` 可能绕过用户确认、验收和 done 前 git/产物校验；所有高风险动作继续由 relay 鉴权和确认卡守门。
- **复杂度收益比**：当前团队板规模小、单 relay 单写者已足够；若没有跨项目 DAG、多人自助认领或跨机协作的实证需求，M3 也不应为引入 Dolt 而引入。
