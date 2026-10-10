# docs 索引与归档规则

cc-deck 的重量级产物集中地：架构图纸、功能设计文档、调研报告、UI 原型、运维/发版文档。
每份文档一行注：**是什么 / 给谁看 / 状态**（现行 = 仍然权威；已实现 = 设计稿对应功能已落地；历史 = 留档参考）。

## 目录结构

```
docs/
├── README.md            ← 本索引
├── *.md / *.html        ← 钉住件：被代码注释按精确路径引用，勿挪（见下）
├── architecture/        ← 架构图纸与架构文档
├── design/              ← 功能设计文档
├── research/            ← 调研报告（外部对照）
├── mockups/             ← UI 原型 / 设计稿（html/png）
├── operations/          ← 发版、运维、排查、施工管理
├── attic/               ← 阁楼区：已完成/被取代的一次性文档（保留不删）
├── reviews/             ← 审阅回执存档（按日期命名，现状保留）
├── readme/              ← README 门面资产（hero.svg / home-btn.svg / architecture.png）
└── …/specs（仓库根）    ← 编号设计施工档案（000-019 + 08x），原地保留
```

## 根部钉住件（代码注释锚点，勿挪）

这 5 份被源码注释按 `docs/<文件名>` 精确路径引用（含 §章节号），移动即断链，故钉在根目录：

| 文件 | 是什么 | 给谁看 | 状态 |
|---|---|---|---|
| [v8-team-matrix.html](v8-team-matrix.html) | 团队模式组织形态规范（矩阵式裁决稿 v3.1）：常驻组织/两本账/工作路由 | 团队模式开发者 | 现行权威（锚：relay org/routing/projects.ts） |
| [v2-m10-freeze.md](v2-m10-freeze.md) | M1-0 契约冻结件：15 表 DDL、五态迁移红线、orgAction 漏斗 | relay/存储开发者 | 现行权威（锚：storage 三件 + test-storage-schema） |
| [v2-dual-read-cutover.md](v2-dual-read-cutover.md) | V2 双读截止计划：sqlite 缺省翻转备案与回滚档 | relay/存储开发者 | 现行（锚：read-mode.ts + cutover 脚本） |
| [codex-integration-research.md](codex-integration-research.md) | Codex 官方能力盘点与接入评估（2026-09-13，含时效提醒） | 引擎接入开发者 | 历史调研·动工前复核（锚：agent-codex/agent-jsonl.ts） |
| [perm-mode-design.md](perm-mode-design.md) | 手机端权限模式四选一重设计 | 手机端开发者 | 已实现·#36（锚：DetailScreen.tsx） |

## architecture/ — 架构图纸与架构文档

| 文件 | 是什么 | 给谁看 | 状态 |
|---|---|---|---|
| [architecture.md](architecture/architecture.md) | 系统架构总览：relay 唯一中枢、三类客户端、外部/托管双接入路径 | 所有人（README 链此） | 现行权威 |
| [v2-system-design.md](architecture/v2-system-design.md) | V2 系统设计 0.9：Agent 无关编排层、Adapter 六能力、引擎矩阵 | 核心开发者 | 现行权威 |
| [v8-team-diagrams.html](architecture/v8-team-diagrams.html) | 矩阵式团队三图总览（组织·流程·状态） | 所有人 | 现行 |
| [v8-team-diagram-flow.html](architecture/v8-team-diagram-flow.html) / [org](architecture/v8-team-diagram-org.html) / [state](architecture/v8-team-diagram-state.html) | 三图单页版；archify 源在 [v8-team-diagram-src/](architecture/v8-team-diagram-src/) | 团队模式开发者 | 现行 |
| [warch-01-system-architecture.html](architecture/warch-01-system-architecture.html) | 系统架构与信任边界图（含源 candidate.json + @2x PNG） | 所有人 | 现行（2026-10-09 换壳批重画） |
| [warch-02-team-dispatch-flow.html](architecture/warch-02-team-dispatch-flow.html) | 团队派单流程图（含源 + @2x PNG） | 团队模式开发者 | 现行 |
| [019-fig-duty-workflow.html](architecture/019-fig-duty-workflow.html) | Leader 值守 v3 工作流程图（配套 [specs/019-pm-duty.md](../specs/019-pm-duty.md)） | 值守机制读者 | 现行 |

## design/ — 功能设计文档

| 文件 | 是什么 | 给谁看 | 状态 |
|---|---|---|---|
| [design-role-experience-reflux.md](design/design-role-experience-reflux.md) | 角色经验回流专项设计：注入+捕获+GC+迁移，三视角审查修订完 | 团队模式开发者 | 设计定稿·待实现 |
| [design-project-card-model.md](design/design-project-card-model.md) | 项目卡与项目模型设计：快捷链接/多路径聚合/未立项分组 | 桌面前端开发者 | 设计定稿·待实现 |
| [design-expo-07.md](design/design-expo-07.md) | expo 手机端 0.7 化设计：桌面能力移植的手机适配取舍 | 手机端开发者 | 实现进行中（0.7.0-test 批） |
| [team-artifacts-aggregation-design.md](design/team-artifacts-aggregation-design.md) | 团队输出物聚合归属设计：锚定项目组的只读投影 | 前端+relay 开发者 | 设计定稿 |
| [relay-service-switch-design.md](design/relay-service-switch-design.md) | relay 系统服务化产品化开关设计（形态 A 主线） | 桌面端开发者 | 待拍板 |
| [team-mode-design.md](design/team-mode-design.md) | 团队模式立项设计笔记（2026-09-18 定稿快照） | 了解演进史者 | 历史·现行方向见钉住件 v3.1 |
| [artifacts-tab-design.md](design/artifacts-tab-design.md) | 输出物 Tab 设计笔记：会话产出一屏可见、双击即开 | 前端开发者 | 已实现（原型：[mockups](mockups/artifacts-tab-mockup.html)） |
| [v8-color-semantics.html](design/v8-color-semantics.html) | 色彩与状态语义规范（裁决稿）：状态色/品牌色使用口径 | 三端 UI 开发者 | 现行 |
| [输出物-意图声明制说明.md](design/输出物-意图声明制说明.md) | 输出物·意图声明制双通道说明（口径权威在 relay session-manager.ts 头注） | 使用者/贡献者 | 现行 |
| [status-light-analysis.md](design/status-light-analysis.md) | 会话卡状态灯显眼度量化分析与方案（明暗双列） | 三端 UI 开发者 | 方案提出·待拍板（原型：[mockups](mockups/status-light-mockup.html)） |

## research/ — 调研报告

| 文件 | 是什么 | 给谁看 | 状态 |
|---|---|---|---|
| [research-kwp-product.md](research/research-kwp-product.md) | Anthropic knowledge-work-plugins 调研 A 路：产品/机制视角 | 团队模式设计者 | 2026-10-10 调研 |
| [research-kwp-arch.md](research/research-kwp-arch.md) | KWP B 路：架构/落地对照（18 插件 252 技能实测） | 架构设计者 | 同上 |
| [research-kwp-lead.md](research/research-kwp-lead.md) | KWP Leader 精读（第三路）：productivity 插件+编制范式 | 同上 | 同上 |
| [research-kwp-memory-fusion.md](research/research-kwp-memory-fusion.md) | KWP C 路：记忆/经验体系对照（查询型 vs 注入型） | 经验回流设计者 | 同上 |
| [research-kwp-role-templates.md](research/research-kwp-role-templates.md) | KWP D 路：岗位模板库专项设计（relay 注入层落地） | 经验回流实现者 | 同上 |

## mockups/ — UI 原型与设计稿

| 文件 | 是什么 | 状态 |
|---|---|---|
| [proto-topbar-head.html](mockups/proto-topbar-head.html) | nova 高保真布局原型 v2（可拖拽·可对比） | nova 设计线原型 |
| [perm-dialog-proto.html](mockups/perm-dialog-proto.html) | 权限档位原型 v3.1 | 已实现方向稿 |
| [artifacts-panel-proto.html](mockups/artifacts-panel-proto.html) | 005 输出物面板重设计原型 | 已实现方向稿 |
| [perm-mode-mockup.html](mockups/perm-mode-mockup.html)（+.png） | 手机权限切换 Head 区 mockup（8 帧，配套根部 perm-mode-design.md） | 已实现 |
| [artifacts-tab-mockup.html](mockups/artifacts-tab-mockup.html) | 输出物子 tab mockup（配套 design/artifacts-tab-design.md） | 已实现 |
| [settings-drawer-redesign-mockup.html](mockups/settings-drawer-redesign-mockup.html) | 设置抽屉重设计 mockup | 已实现 |
| [status-light-mockup.html](mockups/status-light-mockup.html) | 状态灯方案 mockup（配套 design/status-light-analysis.md） | 待落地 |
| [team-mode-mockup.html](mockups/team-mode-mockup.html) | 团队模式 UI mockup | 迭代中 |
| [v8-ui-interactive-v2.html](mockups/v8-ui-interactive-v2.html) | V8 交互原型（整合面板·可点击·自动演示） | 历史迭代 |
| [v8-ui-mockup.html](mockups/v8-ui-mockup.html) | 团队模式完整形态静态稿 v7.1（与交互原型互链成对） | 历史迭代 |

## operations/ — 发版、运维、施工管理

| 文件 | 是什么 | 给谁看 | 状态 |
|---|---|---|---|
| [release-system-design.md](operations/release-system-design.md) | 打包发版体系设计：三段式流程/通道模型/护栏对照 | 发版执行者 | 现行权威 |
| [engine-adapters-smoke-checklist.md](operations/engine-adapters-smoke-checklist.md) | 引擎适配器装机冒烟清单（权威设计在 [specs/006](../specs/006-engine-adapters-spec.md)） | 装机验证者 | 现行 checklist |
| [mixed-team-playbook.md](operations/mixed-team-playbook.md) | 混编团队协作实践手册：Leader↔PM↔worker 协作范式 | 多会话协作者 | 现行方法论 |
| [v2-dev-plan.md](operations/v2-dev-plan.md) | V2 开发计划表（41 单·可直派 worker 版） | Leader/worker | 施工中 |
| [v2-team-roster.md](operations/v2-team-roster.md) | v2 开发团队编制表（会话号↔代号对应） | Leader | 现行·随编制更新 |
| [relay-topology-cleanup.md](operations/relay-topology-cleanup.md) | relay 拓扑收敛报告：M2 拓扑定案与遗留拍板项 | 运维/relay 开发者 | 现状记录 |
| [v2-legacy-audit.md](operations/v2-legacy-audit.md) | 存量实现审计汇总（三 Agent 并行，2026-09-22） | 了解演进史者 | 历史审计 |

## attic/ — 阁楼区（保留不删，门面外）

| 文件 | 是什么 | 保留原因 |
|---|---|---|
| [005-parity-master-plan.md](attic/005-parity-master-plan.md) | 005 对齐移植排期总纲（#167，两路审计台账合成） | 移植批已完成，留移植范围凭证 |
| [redbook-inject-fix-report.md](attic/redbook-inject-fix-report.md) | redbook 外部会话注入链路排查与修复报告 | 修复已合入，留排查过程记录 |

## specs/（仓库根，原地保留）

编号设计施工档案：000-019 为 v0.6 时代设计→实施全记录（IA 冻结、重设计、引擎适配、beads、后端实施、值守等，每号含图与视觉核查），081/083/084 为多引擎权限、组织模型、陪伴计划专项。文件多、互链密，保持原样；新重量级文档不再进 specs/，走本 README 上方结构。

## reviews/

2026-10-05/06 M1 施工批的审阅回执存档（按日期+角色命名），作为施工过程凭证原地保留；新审阅记录按同约定继续落此。

## 后续重量级文档归档规则

1. **新设计文档进 `docs/design/`**（架构级进 `architecture/`），文件名 `<主题>-design.md`，成文即在本 README 对应表补一行注。
2. **图纸一律 [archify](https://github.com/anthropics/skills) 产出**（自包含 HTML + candidate.json 源 + @2x PNG），落 `docs/architecture/`；入 README 等需静态位图处用 @2x 截图。
3. **入库前敏感自查**：token/密钥/内网地址（192.168.* 等）/真实人名/会话凭据——命中即不入库；一次性排查与过时稿进 `docs/attic/`。

## 不入库的存在性说明

- **历次验收单**（0.7.0-test.5~10、0.6 批等）与晨报存于 `~/.cc-deck/artifacts/`（本机），含内网验收链接与内部测试口径，不入库；验收单体系说明随全局工作准则维护。
- **内部交接文档**（`~/.cc-deck/handoffs/`）与会话 memory 体系为团队内部资产，不入库。
- `~/.cc-deck/artifacts/` 下的小红书推广素材、018-后端实施旧快照（以 [specs/018](../specs/018-backend-implementation.md) 为准）未收入。
