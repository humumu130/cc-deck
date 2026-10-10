# Anthropic knowledge-work-plugins 深度调研 · A 路（产品/机制视角）

> 2026-10-10 · 调研对象 [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)（clone 至 /tmp/kwp-a，只读）
> 定位：与 cc-deck「团队编制/角色经验/插件体系」异曲同工的官方实现。B 路做架构落地对照，本报告只讲产品与机制。引用均为 `文件:行号`（clone 根为基准）。

---

## 1. 仓库概览

**规模**：22 个插件（17 个 Anthropic 自研岗位插件 + 5 个 partner-built：slack/apollo/brand-voice/common-room/zoom-plugin），252 个 SKILL.md，1173 个 markdown + 47 个 json，**全仓库没有一行需要构建的代码**（README.md:65 "Every component is file-based — markdown and JSON, no code, no infrastructure, no build steps"）。

**目标平台**：为 Claude Cowork（桌面 agent 应用）设计，兼容 Claude Code（README.md:3）。安装即用：`claude plugin marketplace add anthropics/knowledge-work-plugins` → `claude plugin install sales@knowledge-work-plugins`（README.md:39-45）。

**产品一句话**（README.md:9）：*Each plugin bundles the skills, connectors, slash commands, and sub-agents for a specific job function.* —— 插件 = 岗位。装上 = 给 AI 办入职。

**自研岗位清单**：productivity / sales / customer-support / product-management / marketing / legal / finance / data / enterprise-search / operations / design / human-resources / engineering / small-business(44 技能，最大) / bio-research(垂直行业，11 个 MCP + 5 技能) / pdf-viewer / cowork-plugin-management（元插件：教 AI 建插件和定制插件）。

**CI 供应链纪律**（.github/workflows/）：外部 partner 插件按 SHA 钉死收录（marketplace.json source.sha），nightly 工作流检测上游漂移→validate→每插件一个 bump PR（bump-plugin-shas.yml:1-30）；MCP URL 活性检查（check-mcp-urls.yml）；策略扫描是 main 的 required check。

---

## 2. 岗位插件解剖

### 2.1 统一目录结构

```
plugin-name/
├── .claude-plugin/plugin.json   # manifest，最小只有 name+version+description+author
├── .mcp.json                    # 该岗位依赖的 MCP 连接器（可选）
├── CONNECTORS.md                # ~~占位符→工具类别的映射表（可选）
├── README.md                    # 岗位说明：Commands 表 + Skills 表 + Example Workflows
├── skills/<skill-name>/SKILL.md # 核心单位（references/ examples/ scripts/ 按需）
├── commands/*.md                # ⚠️ legacy，官方明说新插件别用
└── agents/*.md                  # 子 agent（全库仅 brand-voice 1 处自研使用）
```

### 2.2 SKILL.md 的两种人格：命令 vs 后台知识

全库 252 个 skill 的 frontmatter 字段统计：

| 字段 | 数量 | 含义 |
|---|---|---|
| name + description | 252/252 | 必填；description 是**触发器**，第三人称+引号短语 |
| argument-hint | 74 | 有它 ≈ 斜杠命令（用户显式调用） |
| user-invocable | 57（其中 false 54） | `false` = 纯后台知识，用户不可直接调 |
| triggers | 46 | 关键词表（主要用于 zoom 等 SDK 类技能） |
| allowed-tools | 44 | 权限收窄，如 `Read, WebFetch` |

**关键机制**：`commands/` 目录已被官方判定为 legacy——Cowork UI 把 commands 和 skills 统一呈现为一个 "Skills" 概念（create-cowork-plugin/SKILL.md:47、cowork-plugin-customizer/SKILL.md:26）。engineering 插件 README 里的 `/standup` `/review` `/debug` 六个"命令"实际全是 skills（engineering 没有 commands/ 目录），带 `argument-hint` 的 skill 自动获得斜杠入口。**一个文件两种人格，由 frontmatter 决定**：
- `argument-hint: "[yesterday | today | blockers]"` → 出现在斜杠菜单，`$ARGUMENTS` 接参（37 个 skill 这么干）
- `user-invocable: false` → 模型按 description 自行判断何时拉取（如 productivity 的 task-management/memory-management）

### 2.3 递进披露（Progressive Disclosure）——上下文经济学

官方写死三级（component-schemas.md:52-56）：

1. **Metadata（常驻上下文）**：name + description，约 100 词——模型永远知道"我有哪些本事"
2. **SKILL.md 正文（触发才加载）**：核心知识，**上限 3000 词、理想 1500-2000**（component-schemas.md:36）
3. **references/（按需加载）**：深度资料无限量——全库 25% 的 skill（63/252）配了 references/

写作规范（component-schemas.md:33-36）：description 第三人称带触发短语（"This skill should be used when the user asks to..."）；正文**祈使句、写给 Claude 不是写给用户**（"Parse the config file"，不是 "You should parse..."）。

### 2.4 子 agent（subagents）：全库唯一实例 brand-voice

agents/*.md 的 frontmatter：`name / description / model(sonnet|haiku|inherit) / color(蓝绿黄红紫语义色) / maxTurns / tools`。最值得注意的是 **description 里写 2-3 个 `<example>` 对话块**（context → user → assistant → `<commentary>` 解释为什么该委派），等于给主 agent 的路由训练样本（partner-built/brand-voice/agents/content-generation.md:4-26）。

skill 正文显式写委派指令：*"For complex or long-form content, delegate to the content-generation agent"*（brand-voice-enforcement/SKILL.md:75-76）、*"For transcripts: Delegate to the conversation-analysis agent for pattern recognition"*（guideline-generation/SKILL.md:39-41）——**skill 管流程编排，agent 管重活**（多文档并行解析、长文生成、QA 校验），QA agent 甚至用 haiku 省钱。

### 2.5 MCP 连接器与 hooks

- `.mcp.json` 直连官方 HTTP MCP 端点（mcp.slack.com/mcp、mcp.notion.com/mcp…），带 OAuth clientId（productivity/.mcp.json）；`google calendar` 条目 URL 为空——按 name 匹配目录条目的动态端点模式（component-schemas.md:290-292）
- **hooks：schema 完备，22 个插件 0 个使用**。hooks.json 事件表/类型都写在文档里（component-schemas.md:142-227），但自研+partner 全部插件没有一个 hooks.json——连 Anthropic 自己都不在知识型插件里做确定性拦截，全靠 skill 指令 + 记忆文件

### 2.6 全库统一的「STANDALONE / SUPERCHARGED」降级叙事

每个命令型 skill 开头都有同一张 ASCII 框图（standup/SKILL.md:24-36、write-spec、brainstorm 同款）：

```
┌──────────────────────────────────────┐
│  STANDALONE (always works)           │
│  ✓ Tell me what you worked on...     │
├──────────────────────────────────────┤
│  SUPERCHARGED (when you connect)     │
│  + Source control: Recent commits    │
└──────────────────────────────────────┘
```

没连任何工具也能干活（用户口述→AI 格式化），连上工具自动增强。这是「装上就有用，连上更强」的产品承诺落到每个技能里。

---

## 3. productivity 看板模式：文件即协作界面（重点）

### 3.1 数据层：TASKS.md 是唯一事实源

```markdown
# Tasks

## Active

## Waiting On

## Someday

## Done
```

固定四段模板（task-management/SKILL.md:36-46），行格式 `- [ ] **任务标题** - 上下文, for 某人, due 日期`，完成变 `[x] ~~划线~~ (完成日期)`。约定字段：`for [人]`（对谁的承诺）、`due [日期]`、`since [日期]`（等在手的东西等了多久）（:75-82）。**文件同时是 AI 的数据结构和用户的阅读界面**——人类可读可编辑可 git，这是信任的来源。

### 3.2 共同维护协议：谁改什么、怎么避免互踩

全部写在 SKILL.md 指令里，八条规则：

1. **位置恒定**：永远用当前工作目录的 TASKS.md，没有就按 exact template 建（:13-16）
2. **AI 各动作的固定响应**：查（读+摘要+标过期）、加（进 Active 带上下文）、完（[x]+划线+日期+挪 Done）、等（读 Waiting On 标注等了多久）（:55-72）
3. **AI 不许自动写**：*"Ask before adding - don't auto-add without confirmation"*（:91）；update 命令同样 *"Never auto-add tasks or memories without user confirmation"*（update/SKILL.md:164）——**写操作确认制是防互踩的第一道闸**
4. **外部工具同步走 diff 呈现**：拉取 Asana/Linear/Jira 任务后按标题模糊匹配四象限（外部有本地无→建议加；两边有→跳过；本地有外部无→标可能过期；外部完成→建议勾掉），**diff 摆给用户决定**（update/SKILL.md:37-46）
5. **主动 triage**：过期任务/Active 超 30 天/无上下文任务，逐条问"完成？改期？挪 Someday？"（update:49-55）
6. **Done 清理节奏**：保留约一周后清旧项（:82）
7. **会议/对话中顺手提取任务**，同样先问再加（:86-91）
8. **从任务里补记忆**：任务里的链接/状态变化/关系/截止日期反向富化记忆库（update:88-94）

### 3.3 前端渲染层：dashboard.html 单文件应用

**分发机制**：dashboard.html（3111 行自包含 HTML+CSS+JS，零依赖）平时躺在插件目录，**AI 在首次任务交互时把它拷贝到用户工作目录**（task-management/SKILL.md:20-24），并提示 "Run `/productivity:start` to set up the full system"。

**技术栈**（纯浏览器 API，无需服务器）：
- **File System Access API**：`showDirectoryPicker()` 选目录、`getFileHandle()` 拿句柄、`createWritable()` 写回（dashboard.html:2576、1856、2463）
- **解析/序列化**：`parseTaskMarkdown()` / `toMarkdown()` 双向映射——`## 段名`→看板列、`- [ ] **标题** - 备注`→卡片、缩进行→子任务（:1399-1416）。**看板只是视图，重排/勾选/拖拽全是对内存数组操作后 toMarkdown 全量重写文件**
- **拖拽**：标准 HTML5 drag events，卡片/列两级（:1457、1663-1750）

### 3.4 双写同步协议：1 秒轮询 + 防抖互斥（精髓）

```
本地编辑 → markChanged() → 500ms 防抖 → autoSave()
         createWritable() 全量写入 → 记录 file.lastModified（:1845-1869）

每 1s checkForExternalChanges()（:1887-1890）：
  if (hasChanges || isSaving) return    ← 本地有未落盘改动/写盘中：跳过，绝不覆盖自己
  if (file.lastModified > lastModified)  ← 外部（AI 或用户手编）改过：
      重读 → parseTaskMarkdown → 重渲染 → showStatus('Reloaded')   （:1871-1885）
```

三方（用户手改文件 / AI 改文件 / 看板改文件）通过 lastModified 时间戳 + 写盘互斥标志协调，**last-write-wins，无 CRDT/OT**。粒度是全文件重写，但 markdown 小文件完全够用。这套协议 40 行代码实现，是「AI 与用户共写同一文件」最简可靠解。

### 3.5 环境适配细节

Cowork 的 agent 跑在 VM 里，`open`/`xdg-open` 够不到用户浏览器——skill 里明确禁止并改为提示用户从文件管理器打开（start/SKILL.md:32）。**平台怪癖写进技能指令**，这是 agent 工程的常见坑位。

---

## 4. 岗位说明书（编制）注入机制

### 4.1 装插件 ≠ 改 system prompt

官方没有 system prompt 注入点。岗位知识靠三层叠加：

1. **skill metadata 常驻**：所有 252 个 description（每个约 100 词）在会话里常驻——模型随时知道"我这个岗位会什么"，这是按需触发的索引
2. **SKILL.md 按需加载**：用户提问命中 description → 拉全文
3. **记忆文件落工作目录**：岗位的"编制记忆"不是插件自己存的，而是写进**用户工作目录的 CLAUDE.md**——Claude Code/Cowork 平台原生每次会话自动加载 CWD 的 CLAUDE.md，插件借平台机制实现跨对话持久

### 4.2 两级记忆架构（memory-management skill，user-invocable: false）

```
CLAUDE.md          ← 热缓存 ~50-80 行：Top30 联系人 + Top30 术语 + 活跃项目 + 偏好
memory/
  glossary.md      ← 全量解码环（所有缩写/黑话/昵称/项目代号）
  people/{name}.md ← 个人档案（沟通偏好、汇报线、私聊话题）
  projects/{name}.md ← 项目档案
  context/company.md ← 团队/工具/流程
```

设计目标明确：**"CLAUDE.md covers 90% of daily decoding needs"**（memory-management/SKILL.md:43）。查找协议写死成指令：CLAUDE.md → glossary → 深档 → 都没有就问用户并记下来（:224-233）。**晋升/降级机制**：常用的 promote 进热缓存，过时的 demote 回深档，热缓存永不大腹便便（:314-323）。

「解码」是这个记忆体系的核心动词——用户说 *"ask todd to do the PSR for oracle"*，AI 解成 *"Ask Todd Martinez (Finance lead) to prepare the Pipeline Status Report for the Oracle Systems deal ($2.3M, closing Q2)"*（:15-20）。**这就是「AI 像老同事一样听得懂黑话」的机制化实现。**

### 4.3 「每次开新对话重新自我介绍」的解法

答案 = CLAUDE.md 自动加载 + 记忆文件常驻磁盘。配套三个流程命令形成闭环：

- **`/productivity:start`（冷启动）**：检查四件套（TASKS.md/CLAUDE.md/memory//dashboard.html）缺啥建啥；然后**从用户现有任务列表 bootstrap 记忆**——*"The best source of workplace language is the user's actual task list. Real tasks = real shorthand."*（start/SKILL.md:49）。逐条交互解码："PSR 是什么？Todd 全名？Phoenix 是项目代号吗？"（:63-81），可选 `--comprehensive` 深扫 chat/email/docs，按置信度分组（高置信直接加/存疑先问/低频记着）（:93-105）
- **`/productivity:update`（日常回流）**：默认档=同步外部任务源+triage 过期项+扫描任务里的记忆缺口逐个补（update:23-102）；`--comprehensive` 档=深扫活动源找漏记的任务和新出现的实体，表格呈现频次和上下文让用户勾选（:104-160）
- 记忆在**自然对话中有机生长**：用户说"记住 X 是 Y"就落盘到对应层级（memory-management:252-268）

**用户心智**：不是「配置 AI」，是「带 AI 熟悉工作环境」——第一天的入职能有产出，之后每天 update 一点点。

---

## 5. 可定制层

### 5.1 ~~ 占位符：模板与实例的分离

需要分发给不同团队时，插件文本里用 `~~category` 占位（`~~project tracker`、`~~chat`、`~~your-team-channel`），**工作流按工具「类别」写而不是具体产品**，插件根放 CONNECTORS.md 做映射表（productivity/CONNECTORS.md:3-16）：

| Category | Placeholder | Included servers | Other options |
|---|---|---|---|
| Chat | `~~chat` | Slack | Teams, Discord |
| Project tracker | `~~project tracker` | Asana, Linear, Jira… | Shortcut, Basecamp |

这使同一个插件在公司 A=Asana、公司 B=Linear 下都能跑——**工具无关的工作流描述层**。

### 5.2 AI 定制师（cowork-plugin-customizer）：把配置变成对话

定制流程完全交给 AI 执行（SKILL.md）：

1. `grep -rn '~~\w'` 找出全部定制点（:18）
2. **先从知识 MCP 自动收集答案**——扫 Slack 里的工具讨论、文档里的 onboarding 指南、邮件里的许可证通知，摸清团队用什么工具/流程/约定（:44-62）；答不了的才 AskUserQuestion
3. 替换占位符/改正文/更新 URL 模式/写配置值（:85-92）
4. 顺手把新识别的工具连上对应 MCP（:94-104）
5. 打包成 `.plugin`（zip）文件，用户在聊天里**预览文件树、点按钮安装**（:108-118）
6. 按来源分组汇报："From searching Slack: 你们用 Asana、Sprint 两周一个；From your answers: 状态列是 Backlog/In Progress/In Review/Done"（:120-139）

两条产品纪律值得抄：**绝不向用户暴露技术细节**（"Never mention ~~ prefixes, placeholders, or customization points to the user" :32——用户看到的是"学习你们团队的 standup 流程"而不是"替换 SKILL.md 占位符"）；**定制不改插件/skill 名字**（:30，保升级路径）。

### 5.3 手动定制 = 直接编辑 markdown

README.md:69-74 给手动路线：换 `.mcp.json` 连接器、往 skill 文件里加公司术语、改工作流指令。**用户可读可改，没有任何专有格式**——定制的最低门槛是打开记事本。cowork-plugin-management 还配了 create-cowork-plugin 引导 AI 从零建新插件（五阶段对话式，产出 .plugin 文件）。

---

## 6. 产品视角评估与可借鉴点清单

### 6.1 用户心智为什么好

1. **「装插件 = 给 AI 办入职」**：plugin=岗位、skills=岗位手册、connectors=工位上的工具、memory=老同事的默契。整套 HR 隐喻让非技术用户零门槛理解"装了会发生什么"——AI 不是变强了，是**懂行了**。
2. **一切皆文件**：TASKS.md/CLAUDE.md/memory/ 全是人类可读文本，用户随时可看可改可备份可 git，AI 与用户在**同一个界面上协作**（文件即 UI）。信任感与掌控感直接拉满，且天然无锁定。
3. **STANDALONE 承诺**：每个功能不连工具也有 60 分体验，"连上更强"是加分项不是门槛——新装机/离线场景不尴尬。
4. **定制 = 对话**：AI 替你读 Slack、读文档、问你问题、打包结果——「配置」这个动词在产品里消失了。
5. **两档节奏的记忆维护**：日常 update 轻同步 + 偶尔 comprehensive 深扫，按置信度分组让用户勾选——AI 主动但不越权，符合「写操作确认制」。

### 6.2 可借鉴点清单（每条：cc-deck 现状 + 借鉴什么 + 成本粗估）

> cc-deck 现状按产品层描述（CLAUDE.md/memory 里的口径）；代码级对照归 B 路。

| # | 借鉴点 | cc-deck 对应现状 | 借鉴什么 | 成本 |
|---|---|---|---|---|
| 1 | **两级记忆热缓存**（CLAUDE.md 热缓存 + memory/ 深档 + 晋升/降级） | 经验回流 experience.ts（W-EXPP1，1099 行全量导出/导入）；MEMORY.md 自动记忆 | 经验库分层：热数据 ~100 行覆盖 90% 日常 + 冷数据全量 + 显式 promote/demote 协议——防「经验库越大越不可用」 | 中：experience.ts 数据模型分层 + 回流协议改造 |
| 2 | **从任务历史 bootstrap 角色经验**（start:49「真实任务=真实黑话」） | 经验冷启动无内容，靠用户手写 | 新角色/新团队首次开启时，扫历史任务与会话事件流，交互式生成经验初版 | 低-中：数据都在 events.ndjson，做扫描+交互编排 |
| 3 | **交互式解码 onboarding**（PSR? Todd? Phoenix? 逐条问） | 团队模式用户教育是老大难（待办清单/编制概念推不动） | 把「配置角色」重铸为「AI 面试你 5 分钟」——用户不觉得在学产品，觉得在被理解 | 低：纯对话编排 |
| 4 | **update 两档回流节奏**（默认轻同步 / --comprehensive 深扫按置信度分组勾选） | 经验回流是手工批处理（导出/导入） | 「常回小流 + 定期深扫」产品节奏；深扫结果置信度分组呈现 | 中：回流自动化 + 分组 UI |
| 5 | **文件即看板 + 40 行同步协议**（lastModified 1s 轮询 + 500ms 防抖 + 写盘互斥） | 任务清单在 relay 侧（跨端 TaskList）；artifacts 看板已自动收录 | ① 输出物/任务支持「导出 markdown 看板 + 自包含 dashboard.html」离线视图；② 多端/多写者同步协议直接抄这 40 行（lastModified + 互斥标志，last-write-wins 对小文件够用） | 低：协议照抄；导出视图按需 |
| 6 | **写操作确认制成文**（Ask before adding / Never auto-add） | 全局准则有分诊精神，但未写入各技能规范 | 每个「AI 可自动做 / 必须先问」边界写成显式指令，不靠模型自觉 | 极低：写规范 |
| 7 | **~~占位符 + AI 定制师**（知识源自动收集→问答→打包→按来源汇报） | 插件体系有 plugin.json/marketplace.json 落点；定制靠改配置文件 | 团队编制模板占位符化；装机/入编流程 = AI 搜会话历史+问用户→替换→汇报「从哪学到的」 | 中：模板体系 + 定制编排 |
| 8 | **STANDALONE/SUPERCHARGED 降级叙事** | 功能说明常假设全家桶在线 | 每功能两栏承诺「没有 X 也能用 / 连上 X 更强」，文案模板化——新装机/relay 断连场景不尴尬 | 极低：文案规范 |
| 9 | **skill 双人格 frontmatter**（argument-hint=命令入口 / user-invocable:false=后台知识 / triggers 关键词表） | cc-deck 技能触发主要靠 description 语义 | 区分「用户点用的命令」与「后台自动触发的知识」并显式标注；高频误触发场景补关键词表 | 低：frontmatter 约定 |
| 10 | **agents 的 \<example\> 路由样本**（context/user/assistant/commentary 对话块 + 语义色 + maxTurns） | 子 agent 定义无路由示例，委派时机靠模型猜 | description 里写 2-3 个委派示例对话块，显著提升「何时该派子 agent」的命中率；skill 正文显式写委派边界（流程 vs 重活） | 低：改现有 agent 描述 |
| 11 | **零 hooks 的定调**（22 插件 0 hooks.json——连官方都不在知识包里做确定性拦截） | cc-deck 平台层 hooks 用得多（task-stop/task-context） | 定调：知识型插件保持「纯 markdown」不做 hooks，确定性约束收在平台层——插件可移植性最大化 | 0：定调即可 |
| 12 | **插件供应链 CI**（外部收录 SHA 钉死 + nightly bump PR + URL 活性检查） | 发版链有 check-bundle-sync 自检 | cc-deck 市场收录第三方插件时照抄三件套 | 低：收录时建 |

### 6.3 一句话总结

KWP 把「给 AI 岗位培训」拆成了**四样全是文件的东西**：岗位手册（skills）、工位工具（.mcp.json）、同事默契（CLAUDE.md + memory/）、办公桌看板（TASKS.md + dashboard.html）——没有一行服务端代码，却完成了编制注入、协作界面、经验沉淀三件事。对 cc-deck 最值钱的不是某条功能，而是三个产品决策：**记忆落平台原生文件借平台机制持久化**、**文件即 UI 建立人机共同事实源**、**AI 定制师把配置变成对话**。
