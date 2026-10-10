# KWP Leader 精读结论（第三路·2026-10-10）

> 双路 worker（A 产品机制 / B 架构落地）并行调研中，本篇是 Leader 亲自精读的第三路——聚焦「与我们设计最像的 productivity 插件 + 编制范式」。仓库 /tmp/kwp-lead（anthropics/knowledge-work-plugins）。

## 结构实录

每插件 = `plugin.json`（清单四行）+ `skills/`（SKILL.md frontmatter：name/description/user-invocable）+ `CONNECTORS.md`（MCP 工具连接）。productivity 无 commands 目录（start 等 user-invocable 技能兼任命令）。

**productivity 三技能**（与 cc-deck 最像的部分）：

1. **task-management**：任务=当前目录 `TASKS.md` 共享文件，AI 与用户都能编辑——「文件即协作界面」
2. **memory-management**：**两层记忆**——
   - `CLAUDE.md` 热缓存：~30 常联系人 + ~30 常用缩写 + 活跃项目(5-15) + 偏好，目标「覆盖 90% 日常解码」
   - `memory/` 全量库：glossary.md 解码环 / people/ / projects/ / context/，查不到才搜全量
   - 核心价值主张：「ask todd to do the PSR for oracle」→ AI 解码成完整语境（人/文档/项目全称）
3. **start**：初始化四件套（TASKS.md/CLAUDE.md/memory//dashboard.html）

**dashboard.html（3111 行单文件看板）**：读同一个 TASKS.md；`setInterval(checkForExternalChanges, 1000)` 轮询监听外部变更（CLI 端 AI 改了看板自动同步）；拖拽重排。纯前端零服务端——首次交互时 AI 把它从插件目录拷到用户工作目录。

**engineering 编制** = 10 个领域 skill（standup/code-review/architecture/incident-response/tech-debt…）——「岗位 = 一组领域技能包」。

## 三条最值得借鉴（Leader 判）

1. **两层记忆的组织方式**（按 people/glossary/projects/context 分类 + 热缓存「覆盖 90%」的显式目标）——与我们经验回流「注入预算裁剪+全量库」同哲学不同实现；他们的**分类维度**可借鉴进我们经验库 kind 体系与 P2 面板分组。
2. **「文件即 UI」的用户主权重表**：TASKS.md 用户随时手改、AI 与看板都尊重外部变更——对照我们面板「relay 单一事实源直连」，这是另一种协作哲学（文件是用户地盘，AI 是客人）。我们**验收单/任务清单类低频协作**可考虑落用户可见文件（org/ 域惯例本就如此），但实时会话控制不适合。
3. **岗位=技能包模板库**：engineering 10-skill 就是岗位说明书——与 #37 智能建团（PM 自动生成编制）天然衔接：**编制生成时按岗位预装技能包+经验偏好**，比空泛的「role 名字」更工程化。

## 兼容性快判

官方插件是标准 Claude Code 插件（claude plugin marketplace add 即装）——我们托管会话是标准 SDK 宿主，**理论上用户可直接装用**（含 MCP 连接面）。cc-plugins marketplace 机制同源，无排异。

## 待双路报告补充后汇总

A 路（产品机制解剖）/B 路（架构落地对照）报告回传后，三路合并出「可落地清单」给用户拍板。
