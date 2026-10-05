# v2-system-design.md 双口径评审合流简报（Leader + PM 盲评 → 用户拍板件）

> 2026-10-05。两份独立评审：/tmp/leader-v2-review.md（keep 10/revise 13/overturn 3）、/tmp/pm-v2-review.md（keep 9/revise 12/overturn 4）。结论高度收敛——同一批现状证据（projects.ts/org.ts/083/引擎一期/005）推出同方向判定。

## 一、双评共识（直接照此修订，无需逐项拍板）

**1. 总定位**：v2 保留为**目标上位架构**，但不是可照抄编码的现状规范（成稿 09-23，12 天的 m2 增量未吸收）；018 不废止，转为过渡实施线（已完成件保留收尾，不再新增文件态存储节点）。

**2. 推翻并集（两人独立收敛到同三刀 + PM 独有两刀，合流五项）**：
| # | 推翻项 | 来源 | 合流方案 |
|---|---|---|---|
| O1 | team「开团编制」表定位推翻 | 两人同刀（我①+PM O1 互补） | **member（全局锚表，含 archive：joined_at/retired_at/心跳）+ group（项目组全字段表，headcount 快照列）** 两表取代 team+team_member；身份三轴分列（business_role / command_role / task_participation）——083 的 PM 重角色/薄 Leader/评审卡全装得下，M3 退休复活跨组生命周期天然成立 |
| O2 | 「M1 仅 ClaudeCodeAdapter」推翻 | 两人一致 | ClaudeCodeAdapter=契约基准 + 多适配器按 006 增量并进；schema 增 engine/provider/preflight_state 列；ZCode 显式 unsupported |
| O3 | 「其余六表机械合并无争议」标签作废 | 两人一致（PM 已逐表执行重审） | 修订版逐表重审，无跳过项 |
| O4 | artifact「只挂 project 不挂 sid」绝对口径推翻 | PM 独有（Leader 复议后**倾向同意 PM**，见分歧①） | 表键 (source_id, normalized_path) + project/session/task 归因同存——artifact-view 已实装的跨源 join 是实证 |
| O5 | 「先全量表再一次切脊柱」执行方式推翻 | PM 独有 | schema-first + 存量 import + 有界双读一个版本周期，反大爆炸 |

**3. 四新表共识**（我 4 新表 vs PM 覆盖 3 漏 1）：
- lesson / dispatch（attempt 历史维度） / group——两人全有
- **org_confirm（五 kind 人类决策队列）——PM 漏项，Leader 补正必收**：「确认卡是用户决策唯一写面」红线，pending→approved/rejected，partial index WHERE status='pending'
- task 补 depends_on/gate/tier 联动、notification 双层（结构化实体+注入审计账，resolved≠read）——两人一致

**4. PM 独有细度（全采纳）**：R9 orgAction 单漏斗 adapter 映射（新命令不建第二写入口）/ R10 值守 019 字段一次纳入 / R12 新持久化统一经 StoragePort / R11 事件 schema 冻结先于三端改动 / R3 旧验收自由文本迁移不伪造外键。

## 二、真分歧（2 项，请拍板）

**① artifact 归属键**：v2 原文「只挂 project」（我原判「仍对」）vs PM 推翻「project 聚合 + source/session/task 追责同存」。Leader 复议后倾向 PM（artifact-view 跨源 join 是已实装实证），但此条是 v2 原文明确设计且涉用户此前「根治归因」拍板语境——**建议选 PM 方案，请确认**。
- 选项 A（推荐）：采纳 PM——表键 (source_id, normalized_path)，project/session/task 全挂
- 选项 B：维持 v2 原文——仅 project_id，跨源归因走 view 层

**② blocked 落库形态**（技术细节，给推荐即可）：我「status CHECK 补 blocked 六值」vs PM「gate 列落库、blocked 做派生态」。推荐 PM 形态（gate_reason 列在场即阻塞，避免双写一致性问题），schema 定稿时落。

## 三、合流 M1 四步（两版步骤并轨）

| 步 | 内容 | 来源 |
|---|---|---|
| M1-0 契约冻结 | 逐文件 inventory；schema 定案（十实体+四新表+身份三轴）；命令/事件单一注册表；**005 域冻结同期做**（泳道正名=呈现契约，我方泳道评审反哺） | PM M1-0 + 我「005 冻结先行」 |
| M1-1 数据地基 | better-sqlite3+WAL/FK/CHECK/索引；存量 JSON 五类全量导入（含迁移损失清单+computeReady 等价断言）；库先写事件后发；旧 JSON 只读兼容一个版本周期 | PM M1-1 + 我迁移验收点 |
| M1-2 编排闭环 | 用户 task.create 先入账再 dispatch（流①）；per-session token 回写 claim/submit/receipt（流②）；beads ready/gate/lessons 接线；083 A/B 模式；值守 019 | 两人 M1② 并 |
| M1-3 呈现+发布闸门 | 实体引用增量事件+SNAPSHOT parity+history 分块；005 组件化管线合流（组件抽取第一批=M1-0/1 间插入窗口）；T2/T3/V1+24h 矩阵 | PM M1-3 + 我组件抽取时序 |

**启动时序**：005 定稿域冻结（等泳道 PM 小件+用户拍板）→ M1-0 →（018 B3a/B4a 收口）→ M1-1 → M1-2 → M1-3。

## 四、待用户拍板三件
1. 合流方案照此修订 v2-system-design.md 出 0.9 版（修订主体：O1-O5+四新表+M1 四步+018 过渡裁定）？
2. 分歧①artifact 归属键选 A 还是 B？
3. M1 启动时序确认（005 冻结为第一颗扣子）？

v2-merge done: 共识 O1-O5+四新表，分歧 2（artifact 键/blocked 形态），M1 四步并轨
