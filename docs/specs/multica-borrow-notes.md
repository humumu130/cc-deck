# multica 学习借鉴清单（对照 cc-deck 与多机编排 PRD v0.3）

> 1029 PM 学习笔记｜素材：本机 daemon 实况（0.7.1，双机 runtime 在线，DEV-1 跨机单流转中）+ 源码（~/dev/multica）+ 既有双路调研（artifacts/research-multica-{arch,features}.md）
> 用户语境：公司电脑试用后「很多地方值得借鉴」

## 一、根本路线差（先讲清楚，借鉴才有锚）

| 维度 | multica | cc-deck |
|---|---|---|
| 架构 | **中心化**：server（云/自托管 Go+PG+Redis）是大脑，daemon 连 server 领任务 | **去中心**：各 relay 独立+云桥 P2P 转发 |
| 工作抽象 | **issue 板为一等公民**（人+agent 同为 assignee，MUL-123 编号） | 会话卡为一等公民，板卡是 org 域附属 |
| agent 驱动 | **driver 模式**：daemon spawn 无头 run（每任务一 run，终态即归档） | **hook 旁路+活会话**：可交互、上下文连续 |

各有利弊，不是谁对谁错——cc-deck 的活会话交互是 multica 没有的，multica 的板协作纪律是 cc-deck 弱的。

## 二、值得借鉴的九点（按价值排序）

### B1 全局任务池的体验（最高价值，直接冲击 PRD v0.3）
DEV-1 实证：公司发单→家里 agent 领。中心化 server 让「任何设备发 issue、任何 runtime 领」天然成立。cc-deck PRD 的「对端权威」模型（A 派给 B 的编制消化）是保守版。**吸收**：PRD §9 增开放问题——跨机任务池投影（各机板卡互投+闲者领单，去中心实现全局池语义：xmsg 投递「领单意向」+板卡状态互同步即可起步，不必上中心 server）。
### B2 run 概念：执行留档的完整度
multica 的 Run=一次执行的完整生命周期（输入/输出/usage/deliverable 归档）。cc-deck 有回执但没有 run 级完整留档（回执是 worker 自述）。**吸收**：dispatch 增加 run 侧记录面（relay 侧自动留：任务书/事件流切片/终态 stats——归 artifact 域），审查收割时「自述+机器档」双证。
### B3 runtime 自动探测+能力协商
multica daemon 自动发现本机 28 种 agent 工具+读用户 ~/.claude 配置尊重现装+claim 时上报能力（claim-poll-hints-v1）。cc-deck engine 注册表手工维护（engine-rollouts），PRD X0 装配探测刚起步。**吸收**：X0 的探测件按 multica 范式做厚——探测即注册（发现什么工具自动进 engine 表）+派单能力协商（单子要求的能力 vs runtime 上报的能力预匹配）。
### B4 daemon 自更新三件套（优雅更新）
跟随替换二进制（**等在跑任务完成再重启进新版**）+agent CLI 升级原地 re-probe 不重启+boot 自启。cc-deck 更新链会打断在跑 worker（L-1026-1 家族痛）。**吸收**：relay/壳更新引入「优雅等待窗」（检测在跑派单→等终态或超时提示，不硬杀）——正好补 #296 单通道收敛批没覆盖的更新面。
### B5 配对/登录态模型互证
multica 的 daemon_pairing_session+daemon_token 表与 PRD v0.3 的邀请→登录态 token 流同构——**独立验证了 PRD 4.5 方向**。细节可抄：配对码短时效+一码一设备（PRD 已有）+**token 轮换周期**（multica daemon token 定期换发——PRD 补）。
### B6 Autopilot：用户可定义的触发自动化
「定时/触发→agent 动作」（如 issue 打标签自动派）。cc-deck 的 patrol/duty 是内部机制，用户不可定义。**吸收**：远期——duty 面开放用户规则（「板卡进 doing 超 1h 自动唤醒」类），先记录不做。
### B7 术语与认知成本
issue/run/runtime/squad 命名直白；cc-deck 的 org/编制/派单/回执/收割术语体系学习成本高（公司侧反馈 #4 零感知同族）。**吸收**：X0 的 SessionStart 广播文案里用平语重述（「任务板/领任务/交回执」），不搞术语改名（存量记忆成本）。
### B8 Squad 编排策略
小组=跨 agent 协作单元+自动分工策略。cc-deck 编制+技能标签已近，差距在自动分工。**吸收**：远期记录。
### B9 三端同构的实现纪律
Next.js/Electron/Exo 三端同一 workspace 体验。cc-deck 同构三端（web-console/Tauri/Expo）但功能进度常不同步（桌面先手机后）。multica 的对象模型单一（server 权威）天然同构——cc-deck 去中心下同构靠 relay SNAPSHOT 协议统一。已做对，记录提醒。

## 三、明确不借鉴的（想清楚不抄的）

- **Postgres/Redis 重栈**：cc-deck 本地优先+SQLite cutover 正确，个人工具不要服务器依赖
- **无头 run 替代活会话**：cc-deck 的可交互会话是核心价值（注入/审批/接管），不退
- **SaaS 账号体系全量**：PRD 已裁（登录态凭证先行，账号 UI 后置 T2）

## 四、落地动作（并入现有批次）

| 借鉴点 | 落点 |
|---|---|
| B1 全局任务池 | PRD §9 开放问题 5（v0.3 已加） |
| B2 run 留档 | 新批候选（或并入 X2 回程腿：摘要回带 run 切片） |
| B3 探测即注册 | PRD X0 装配探测件直接做厚 |
| B4 优雅更新 | 独立小批（更新链域，与 #296 姊妹） |
| B5 token 轮换 | PRD 4.5 补一行 |
| B6/B7/B8 | X0 文案/远期记录 |
