# KWP 记忆/经验体系对照分析（C 路·记忆/经验专项）

> 2026-10-10 · KWP 借鉴吸收三路之 C。对照物：anthropics/knowledge-work-plugins（/tmp/kwp-lead，只读）`productivity` 插件记忆层 vs cc-deck 经验回流体系。全部引用带文件路径。与 Leader 精读（research-kwp-lead.md）独立成文，分歧点已标注。

## 0. 摘要（三条核心判断）

1. **两层记忆的本质差异不在层数在消费形态**：KWP 记忆是**查询型**（lookup，AI 主动去查词表解码用户输入），cc-deck 经验是**注入型**（push，派单时按预算推送）。因此 KWP 的「热缓存/全量库」两层在我们这对应的是「注入预算裁剪/全量 store」——结构上已经同构，**真正缺的是分类配额**：我们 700 字符预算内全是全局权重竞争，单一 kind 高产会挤占整个预算（KWP 每类固定 ~30 槽位不会）。
2. **glossary 解码环值得做，形态收敛为经验库新 kind=`term`，不做独立文件**。cc-deck 团队黑话（打标/收口/挂账/@2x）现在人肉住在 CLAUDE.md 三层里，正是 glossary 要解的问题；进经验库白得去重/GC/导出/注入链，改动面横切 ~5 触点但全是机械改动。唯一硬前置：GC 衰减梯度必须给 term 特化租期（术语稳定，90 天衰减会误杀）。
3. **写入端哲学相反且各有道理，不互搬**：KWP 确认制（never auto-add）服务个人助理场景，cc-deck 推式+格式门控（worker 申报自动收）服务多 worker 高频收口场景——确认制在后者会造成派单流水线阻塞。可吸收的是 KWP 的**呈现模式**（按置信度分组），正好是 P2 语义档提案面板的 UX 模板。

---

## 1. 两侧体系速览

### KWP 侧（productivity 插件，4 个 SKILL.md 即全部协议，零代码逻辑）

| 件 | 文件 | 角色 |
|---|---|---|
| 热缓存 | 用户工作目录 `CLAUDE.md`（协议在 memory-management/SKILL.md §78-115） | ~30 人 + ~30 术语 + 5-15 活跃项目 + 偏好，~100 行，显式目标「覆盖 90% 日常解码」 |
| 解码环 | `memory/glossary.md`（协议 §119-151） | 四张表：Acronyms / Internal Terms / Nicknames→人名 / Project Codenames，可无限增长 |
| 富档案 | `memory/people/{name}.md`、`projects/{name}.md`、`context/company.md`（§153-220） | 多节结构（沟通偏好/语境/人脉/工具表/流程表） |
| 冷启动 | start/SKILL.md §45-151 | 从既有任务清单逐条交互式解码；可选 comprehensive 扫描聊天/邮件/日历/文档 |
| 保鲜 | update/SKILL.md | 解码任务找 memory 缺口→填缺→富集；--comprehensive 按提及频次建议新记忆 + 建议 30 天未提及的清理 |
| 写入纪律 | memory-management §250-268 + update §164 | 用户说 "remember this"/"X means Y" 即写；**铁律：绝不未经用户确认自动添加** |

### cc-deck 侧

| 件 | 文件 | 角色 |
|---|---|---|
| 经验库 | `relay/src/experience.ts`（1099 行，org/ 域单文件 experience.json） | 扁平 entries + kind 四类（pitfall/practice/preference/fact）+ 双轴 scope（role×project），≤200 字/条 |
| 注入链 | experience.ts `buildExperienceInjection`（§614-637）→ session-manager.ts §6041-6046 → `wrapDispatchPrompt` 第三参（§7003-7014） | 权重排序（scope×(1+use_count)×recency，§518-525）贪心装 700 字符预算；熟手 memo 防重复；命中即 bump 闭环 |
| 写入端 | worker 申报：session-manager.ts `captureExperienceDeclaration`（§4266-4303，回执末行「经验：<话>#kind」自动解析）；用户直写：`org exp append`（org.ts §375，exp-append→session-manager.ts §5473）；系统迁移：`migrateLessonsToExperience`（§851-896） | 推式+门控：200 字/kind 标记/去重/软上限四道闸，无用户确认环节 |
| GC | experience.ts `runExperienceGc`（§676-789） | 机械档：归一键去重收编 + 从未命中 90d 自动 retire + 超期未用降权 + retired 归档；复活环兜底 |
| 压缩摘要 | `relay/src/context-watchdog.ts`（70 行）+ session-manager.ts §2296-2298 注回、§6455 挂点 | 水位 ≥85% → 摘要指令 → 捕获落 `state.pre_compact_summary` → 检测实际压缩后首帧 system-reminder 注回一次 |
| CLAUDE.md 三层 | 全局 ~/.claude/CLAUDE.md / 项目 / org | 人肉维护的术语+纪律（「打标/收口/挂账/回执」等黑话实际住这里） |

---

## 2. 问题一：两层记忆 vs 经验库——本质差异与可吸收点

### 对照表

| 维度 | KWP 两层 | cc-deck experience.json |
|---|---|---|
| 服务对象 | 解码用户输入（「todd 的 PSR」→ 全语境），**查询型** | 派单前预防（这个角色这个项目别踩坑），**注入型** |
| 组织维度 | 分类树：people / glossary / projects / context，各带 schema 模板 | 扁平 entries + kind 标签 + role×project 双轴 scope |
| 常驻集管理 | **固定槽位**（每类 ~30）+ 晋升/降级机制（高频→热缓存，过时→降级 memory/） | **全局竞争**：权重排序贪心装 700 字符，无维度配额 |
| 饱和策略 | 热缓存满→降级旧的；全量库无限增长 | 软上限拒新（全局 200/角色 100/项目 100）+ GC 淘汰 + retired 归档 |
| 条目富度 | people 多节富文本；glossary 三元组表（term/meaning/context） | 一句话 ≤200 字硬约束（curated 账不是日志） |
| 消费时机 | AI 每回合开头读 CLAUDE.md，缺了才去查 memory/ | 每次派单自动构建注入块，worker 无感知 |

### 本质差异分析

**差异一（最关键）：槽位制 vs 竞争制。** KWP 热缓存「~30 人 + ~30 术语 + 活跃项目」是**按类别分配的固定配额**——每个维度保证有代表。cc-deck 的 `selectForInjection`（experience.ts §562-578）是纯权重竞争：如果某角色累计了 100 条高权重 practice（比如某项目连续两周申报方法类经验），4 条 pitfall 会被**整体挤出** 700 字符预算——而 pitfall（踩过的坑）恰恰是单位价值最高的 kind。这不是假设：软上限按维度分桶（全局/角色/项目各 200/100/100），但**注入端没有对应的维度保护**，存储端的分桶纪律到注入端断链了。

**差异二：降级语义相同，晋升语义我们缺失。** KWP「demote 不删除」「frequently used → promote」与我们 retired 永不物理删 + use_count bump 完全同构（已对齐，无动作）。但 KWP 的 promote 有明确触发（高频使用→进热缓存），我们的 use_count 只影响排序不影响**准入**——700 字符装满后，高 use_count 条目和低 use_count 条目挤不挤得进只差排序，没有「保证在场的常驻集」。memo 机制（§589，session 级已注入集）部分补偿了这一点（熟手不重复注），但新 worker 首单的注入块依然是纯竞争结果。

### 吸收建议（E1：注入分类配额）

**吸收什么**：KWP 槽位制的「维度多样性保障」——注入裁剪从纯权重竞争改为**kind 分桶配额**。

**落点**：`relay/src/experience.ts` 的 `selectForInjection`（§562-578）纯函数内部——排序逻辑从「全局降序贪心」改为「按 kind 分桶，桶内权重降序，桶间保底/封顶轮转装填」。建议参数：单 kind ≤ 预算 50% + 每桶保底 1 条（有候选时）。**性质锁定不变**：输出整块恒 ≤ 预算、纯函数、env 可覆盖（配额比走 `CCR_EXP_INJECT_*` 新 env，同 §79 envNum 手法）。

**改动面粗估**：单函数 ~30 行改动 + 单测若干（现有「库 1000 条注入块 ≤ 预算」断言不受影响，新增「单 kind 不挤占全部」断言）。半人日内。

**冲突检查**：偏离设计 §3.3.4「按权重降序贪心」拍板（experience.ts §508-517 权重公式注释是权威）。属于注入质量优化而非存储/schema 变化，但公式是「全文其余各处只引用不重复定义」的单点定义处——改动须同步设计文档并经用户拍板。

---

## 3. 问题二：写入端协议对照

### 三渠道对照表

| 渠道 | KWP | cc-deck |
|---|---|---|
| 对话中沉淀 | 用户说 "remember this"/"X means Y" → AI 分流写 glossary/people/projects/preferences（memory-management §250-268） | worker 申报：回执末行「经验：<一句话>#kind」→ `captureExperienceDeclaration` 自动解析入库（session-manager.ts §4266-4303）；用户直写：`org exp append`（org.ts §375） |
| 冷启动 | start：从**既有任务清单**逐条解码（「PSR 是什么？Todd 是谁？」交互式问询）→ 建档；可选 comprehensive 扫描聊天/邮件/日历/文档，按置信度分组呈现（start §45-151） | `migrateLessonsToExperience`（experience.ts §851-896）：旧 board lessons 一次性收编，幂等、先迁后切、kind 统一落 practice |
| 保鲜 | update：解码任务找 memory 缺口→交互式填缺→富集（链接/状态/关系/deadline）；--comprehensive 按提及频次建议新记忆 + 建议 30 天未提及清理（update §57-158） | GC 机械档（无 LLM）：去重收编/衰减降权/自动 retire/归档，复活环兜底（experience.ts §676-789） |
| 写入确认 | **铁律：绝不未经确认自动添加**（update §164 "Never auto-add tasks or memories without user confirmation"） | **无确认环节**：agent 申报格式门+硬校验+软上限自动收（session-manager.ts §4264「静默丢弃不炸收口」） |

### 差异本质

KWP 是**拉式+确认制**：AI 发现候选→打断用户→确认→写。cc-deck 是**推式+门控制**：worker 主动申报→四道闸自动收（200 字/kind 标记/归一键去重/软上限），质量兜底交给 GC 梯度+复活环。

**这个差异不是优劣是有意设计**：KWP 面向个人助理（一天几条记忆，确认成本可忽略）；cc-deck 面向多 worker 高频收口（一批验证反馈十几条申报，逐条确认会阻塞派单流水线）。cc-deck 的格式门（无 #kind 标记不收，REL 建-4）实质上是「把确认成本前置成了格式契约」——申报即确认。

### bootstrap 启发评估

**旧数据迁移：不缺。** `migrateLessonsToExperience` 就是 cc-deck 版 bootstrap（lessons 冷启动），且比 KWP 的交互式问询更适合机器链路（幂等/先迁后切/坏 JSON 保护态联动）。

**新团队冷启动：P2+ 再议。** KWP「从既有文本资产提取术语」的思路对 cc-deck 新装团队有场景（org/ 空库但 data/ 有历史 events.ndjson、项目里有既有 CLAUDE.md）——但两个硬理由推迟：(a) P1 经验库刚落未装机验证，先跑稳主链；(b) 自动提取撞写入哲学拍板——我们 agent 申报是「格式门自动收」，提取器产出的候选没有格式契约背书，必须走确认制，等于在 P2 面板之外新开一条人审链。**结论：不做提取器，把「按置信度分组呈现」吸收进 P2 提案面板**（见 E3）。

---

## 4. 问题三：解码环（glossary）专项

### 现状判断

**cc-deck 完全没有 glossary，但事实上已经有一个劣化版的家：CLAUDE.md 三层。** 本会话任务书里的「打标/收口/挂账/回执/认领/出包」，全局 CLAUDE.md 里的「@2x/deliver/验收单四段结构」——全是人肉维护的术语表，且暴露三个 glossary 类问题：

1. **无生命周期管理**：CLAUDE.md 术语没有 GC，过时术语（如已退役的分支名惯例）靠人肉清理；
2. **无结构化 scope**：「@2x」是全局术语、「B14」是批次语境、「挂账」是 relay 域黑话——现在全平铺在文档里，没有 role/project 维度；
3. **worker 注入不可达**：全局 CLAUDE.md 对人的会话生效，但 worker 收到的只有派单 prompt——PM 在任务书里写「验收单四段结构」，worker 未必知道四段是哪四段。

### 值不值得做：值得，理由三条

1. **价值链路比 KWP 更短**：KWP 解码的是用户日常闲聊（错了可以追问），我们解码的是**任务书**（理解错了直接产出错误交付物）。任务书黑话的解码失误成本更高。
2. **形态天然兼容**：「术语：含义」恰好是一句话——「@2x：Retina 导出倍数，截图交付必须 @2x」完全满足 ≤200 字契约；scope 双轴白得（全局术语 project_scope=global，批次黑话锚定项目）。
3. **注入链白得**：term 条目 role_scope=any + project_scope=global 即可全员注入，PM 派单时 worker 自动带上术语语境。E1 的 kind 配额正好保护 term 不挤占 pitfall 席位。

### 形态选择：经验库新 kind=`term`，不做独立文件

**否掉独立 glossary 文件的理由**：org 域文件纪律（experience.ts §1-4：经验库是 org 单文件，org.ts 三物理事实同款）——独立文件要另建一套 CRUD/GC/导出/坏 JSON 保护，全部重复造轮子；且 glossary 的消费形态在 KWP 里是 lookup，我们没有 lookup 时机（worker 不会主动查库），只有注入这一条消费链。

### 融合建议（E2：kind=term）

**吸收什么**：glossary 的「术语解码」职责，进经验库成为第五个 kind。

**落点与改动面**（机械改动，横切 ~5 触点）：

| 触点 | 文件:行 | 改动 |
|---|---|---|
| kind 词表 | experience.ts §34 `EXPERIENCE_KINDS` | 加 `"term"` |
| GC 租期特化 | experience.ts §105-107 常量 + §715 `limitDays` 分支 | **必须**：term 免衰减或超长租期（术语稳定，「@2x 90 天没用」不构成失效信号）——建议 term 走「永不自动 retire，仅手动淘汰」 |
| 申报解析 | experience.ts §642 `KIND_TAG_RE` | 加 term 分支（worker 也可申报术语：「经验：挂账=…#term」） |
| 导入校验 | experience.ts §985 `validateImportedEntry` | 自动过（引用 EXPERIENCE_KINDS 词表，无硬编码） |
| CLI 文档 | org.ts §375 用法行 + P2 面板图标 | 词表文案 |

**冲突检查**：① 偏离设计 §2.1「四类拍板」——需用户拍板；② GC 衰减梯度按 kind 分档的逻辑（fact 45d/其余 90d）必须扩展第三档，否则术语被 90 天衰减误杀——这是 E2 的硬前置而非可选；③ 与 KWP 对照的一个让步：KWP glossary 有「热缓存晋升」（top-30 进 CLAUDE.md），我们不做——注入预算+配额已承担常驻集职责，CLAUDE.md 保持人肉主权（Leader 报告的「文件是用户地盘」哲学，认同）。

**降级备选**：不加 kind，术语暂存 fact（零改动）。代价是失去免衰减语义和展示区分，fact 45 天降权对术语太凶。建议：术语量 <20 条时 fact 凑合，起来的那一刻升 kind——但鉴于改动是机械的，一次做到位更省。

---

## 5. 问题四：与压缩前摘要（context-watchdog）的衔接

### 现状与 KWP 对照

KWP **没有长会话管理的对应物**（个人助理场景无此压力）。但 KWP 有一个哲学差异值得注意：它的记忆全部是**用户可见可查的文件资产**（memory/ 目录用户能直接打开），而我们的压缩摘要是 `state.pre_compact_summary`（session-manager.ts §476 注释：持久+下发+回放）——**机器态，用户不可见不可查**。

### 互补空间分析

**摘要本身是高质量经验原料。** watchdog 摘要（context-watchdog.ts §52-60 `compactPrompt`）固定覆盖六段：任务书要点/已完成/进行中/下一步/关键文件:行号/纪律红线——这正是经验的浓缩形态。现在的链路里它注回一次后就沉没在会话 state 里，经验库的申报环（worker 主动写）完全可能漏掉摘要里的关键教训（压缩发生在会话末尾，worker 来不及申报）。

**互补方案（E4，最小版）**：摘要落审计域副本——`capturePreCompactSummary` 旁路把摘要追加到 `org/compact-summaries.ndjson`（append-only，appendGcLog 同款手法，experience.ts §284-292）。**注回链完全不动**（state 字段的生命周期语义——resume/回放/重启——与注回时机强耦合，挪落点要把「注回与否」状态拆两处，纯风险无收益）。审计域副本的作用：为 P2 的「经验提取器」留存原料（§3 已论证提取器 P2+ 再议），现在只是留档零消费。

**改动面粗估**：session-manager.ts watchdog 捕获收口处（§6455 挂点附近的终态收口）+ experience.ts 或新小模块加一个 append 函数，~20 行。但**建议与 E1-E3 拆开**：watchdog 也是 2026-10-10 刚落的新件（W-CTXFIX B3），两个未验证新件叠加改造违背一次一批纪律。

**冲突检查**：org 域新增文件类型（compact-summaries.ndjson）——org 域目前是「用户可见团队资产」定位（experience.ts §2-3），摘要审计件算不算团队资产需要用户拍板；若不算，落 data/ 域（relay 运行数据）更符合既有口径——但 data/ 是 relay 私域，跨会话提取器消费时口径又别扭。**此条冲突面大于收益，建议 P2 连同提取器一起再议，本期只记录不动手。**

**已对齐项（无动作）**：KWP「demote 不删除」哲学与 retired 永不物理删一致；「摘要注回以磁盘实际状态为准」的免责声明（context-watchdog.ts §63-69 wrapPreCompactReminder）与 KWP「memory 是参考不是事实源」同构。

---

## 6. 融合建议汇总表

| # | 吸收什么 | 落点 | 改动面 | 优先级 | 与既有拍板冲突 |
|---|---|---|---|---|---|
| E1 | 注入分类配额（kind 分桶保底/封顶，防单 kind 挤占预算） | experience.ts `selectForInjection` §562-578 | 单函数 ~30 行+单测，半人日 | P2 批（经验库装机验证后的第一个增强） | 偏离 §3.3.4 贪心拍板，**需拍板**；性质锁定（整块 ≤ 预算）不变 |
| E2 | glossary 解码环 = 经验库新 kind `term` | experience.ts §34 词表 / §105-107+§715 GC 租期特化 / §642 KIND_TAG_RE / org.ts §375 | 横切 5 触点，全机械改动，~1 人日含测试 | P2 批，与 E1 同批 | 偏离 §2.1 四类拍板，**需拍板**；GC term 免衰减是硬前置 |
| E3 | 提案面板「按置信度分组」UX 模板 | P2 语义档提案面板（设计 §3.3.2 365d 提案制 P2 的呈现层） | 零代码，设计参考 | P2 面板设计时 | 无冲突（KWP 原生模式，update SKILL.md §99-160 为模板原件） |
| E4 | 压缩摘要沉淀审计域（org/compact-summaries.ndjson） | session-manager.ts watchdog 收口处 §6455 挂点附近 | ~20 行 | **P2+ 暂缓**（域归属未拍板 + watchdog 新件未验证） | org 域「团队资产」定位是否覆盖摘要审计件，**需拍板** |
| N1 | 旧数据迁移 bootstrap | 已有 `migrateLessonsToExperience`（experience.ts §851-896） | 零 | — | 无（比 KWP 交互式问询更适合机器链路） |
| N2 | memory/ 文件树分类（people/projects/context 目录） | 不吸收 | — | — | 破坏 org 单文件纪律 + 原子写/坏 JSON 保护/导出导入全套既有设计；机器消费场景单 JSON+标签查询效率更高 |
| N3 | people 富档案多节 schema | 不吸收 | — | — | 与「一句话纪律 ≤200 字」（curated 账根基）直接冲突 |
| N4 | 写入确认制（never auto-add） | 不吸收 | — | — | 与 agent 申报自动收的拍板相反（格式门=前置确认）；多 worker 高频收口场景确认制阻塞流水线。对冲手段：P2 面板给「批量 retire 申报条」能力 |
| N5 | 热缓存晋升机制（top-30 进 CLAUDE.md） | 不吸收 | — | — | 注入预算+配额（E1）已承担常驻集职责；CLAUDE.md 保持人肉主权（认同 Leader「文件是用户地盘」判断） |
| N6 | comprehensive 扫描提取器（聊天/邮件→memory） | 不吸收（本期） | — | P2+ 连同 E4 再议 | 自动提取产出无格式契约背书，必须走确认制=新开人审链；P1 先跑稳 |

## 7. 与 Leader 精读的分歧与印证

- **印证**：Leader「两层记忆的组织方式值得借鉴」（research-kwp-lead.md §24）——本报告具体化为 E1（注入端配额）+ E2（glossary kind 化），Leader 只说了方向，落地形态（分桶算法/kind 横切清单）是本报告独立推导。
- **分歧（轻微）**：Leader 建议「分类维度借鉴进 kind 体系与 P2 面板分组」（§24）——本报告认为 P2 面板分组是展示层小事（listExperience 已有 kind/project/role 筛选，§486-494），**真正缺口在注入端**：面板看得到全部，worker 注入不到就白搭。E1 优先于面板分组。
- **独立发现（Leader 未提）**：CC-deck 黑话事实上已住在 CLAUDE.md 三层人肉维护（§4 现状判断）——glossary 的真问题不是「从零做不做」而是「人肉术语表要不要结构化进经验库换取 GC/去重/注入链」。这个 framing 让 E2 的必要性论证不需要假设未来场景，现状已经在疼。
