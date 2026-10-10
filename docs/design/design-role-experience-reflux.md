# 角色经验回流专项 · 设计文档

> 2026-10-10 · W-EXPDESIGN · 设计阶段产出（只读调研后成文，未改任何仓库代码）
> 用户定调：**特色功能，好好设计，值得深挖**。实现批另行派工（等设计核验 + 用户拍板 + UI 批错峰）。

> **修订记录（2026-10-10 · W-DESIGNFIX）**：依据三份审查回执（架构一致性 /tmp/design-review-arch、可靠性 /tmp/design-review-rel、产品体验 /tmp/design-review-ux 各自 receipts/review.md）做局部补丁修订；核心架构三视角全认可，本文主结论未动。逐条「意见→改在哪节」对照见 /tmp/wdesignfix/receipts/fix.md。主要修订：收口自动账不进经验库（D1-1）、存储原子写+坏 JSON 拒写（REL 必-1）、软上限只计 active（REL 必-2）、提案失效重验+快照 write-ahead（REL 必-3）、申报教学行（D1-2）、手机端协议帧口径（ARCH M1）、plugin-config 第七键（ARCH M3）等 25 条。
> **行号基线（ARCH M2）**：dev 分支 `daf1814a`（2026-10-10）。审查实测本文部分行号相对早期快照漂移 +42~196 行不等；本文代码定位一律以「函数名 + 锚字符串」优先、行号仅辅助，实现批开工前以 dev 实测重锚。

---

## 0. 摘要（一页速览）

**需求**：团队里不同角色（如 UI 设计）的经验应回流并持久化；其他团队的相同角色应能共享这些经验与踩过的坑。经验条目存在两个正交 scope 轴：**角色轴**（角色专属 ↔ 跨角色通用）× **项目轴**（项目特化 ↔ 全局通用），共四象限。

**两个留白题的推荐答案**：

| 留白题 | 推荐 | 一句话理由 |
|---|---|---|
| ① 要不要按项目隔离 | **不物理分层。单池 + 条目打双轴 scope 标签，注入时按接收者（角色×项目）匹配过滤** | 隔离本质是注入时的过滤器问题，不是存储边界问题；物理分层要额外发明「层间迁移」「项目结项条目归处」两套规则，标签制一条谓词解决 |
| ② 面板要不要展示 | **后台为主 + 面板只读查看入口 + 总开关** | 注入静默生效是主战场；但组织记忆跨项目静默生效，v8 设计稿 §3.4 本就承诺「变更可见、事后可否决」——纯后台违背既有拍板，重面板则错配主战场 |

**核心设计**：新建全局**团队经验库**（`~/.cc-deck/org/experience.json`），条目模型 `ExperienceEntry{ text, kind, role_scope, project_scope, tags, status, use_count/last_used_at, source }`；捕获走混合制（agent 回执申报 + 用户/Leader 直写，全过 orgAction 单漏斗；**M12-4 收口自动账留 lessons/派单台账域、不进经验库**——流水账不占 curated 池，见 §3.1）；注入挂在 worker 派单首条消息（`wrapDispatchPrompt` 扩展，**字符预算 ≤700 字符按权重裁剪**）——veteran resume 同路径天然覆盖。**防膨胀双层防线**：注入预算硬裁剪（最后一道闸）+ 定期整理 GC（预算内质量），整理走「机械档自动 + 语义档提案」分档制，全程整理日志可回溯可恢复。

**分期**：P1 relay 单域为主（存储+写入+注入预算+机械档 GC，零 LLM；端上仅一处顺手改动——迁移后清空旧 lessons 缓存，§8 ARCH M1）；P2 面板只读入口+用户否决+语义档整理（合并/聚类提案回合）+external 会话注入。

---

## 1. 调研现状（设计依据，贴代码现实）

### 1.1 团队机制与数据面

- **org 目录** `~/.cc-deck/org`（`CCR_ORG_DIR` 覆盖）= 用户可见团队资产；与 `data/`（relay 运行数据）、`artifacts/`（交付物自动收录）三分，**绝不进 artifacts/**（org.ts:5-8 三个物理事实，勿改）。现状文件：`org.json`（Leader 锚）、`CLAUDE.md`（组织记忆）、`dispatch-log.ndjson`（快账）、`projects.json`、`confirms.json`；`boards/`、`routing.json` 本机尚未产生（团队功能轻用期）。
- **组织形态**：唯一常驻 Leader（cwd=org 目录 → org CLAUDE.md 自动加载，org.ts:108-110）+ 动态项目组（`anchor_dir` 锚点目录，编制 `headcount: {session_id, role}[]`，projects.ts:42-51）。建团走 Leader 分诊（org CLI → POST /api/org，org.ts:351-525），解散 = `org set archived` → `disbandGroupMembers`（session-manager.ts:5955）。
- **派单链**：`dispatchWorker`（session-manager.ts:5644）→ 路由表查空闲熟手 resume（会话亲和，`pickVeteran` session-manager.ts:5909）或新会话+`wrapDispatchPrompt` 首条消息（记忆亲和，5837）。收口 = `closeOpenDispatches`（4198）：台账终态行 + 板卡搬动 + M12-4 经验自动回流（4231-4248）。
- **熟手路由表** `routing.json`（routing.ts:1-60）：`RoutingEntry{gid, session_id, count, failed, last_ts, last_receipt, rating, tags}`——「经验」目前以**会话亲和**形态存在（熟手上下文即经验，resume 承续），会话死了只剩统计档案。技能标签手动（`org tag`），派单可带 skills 优先命中熟手（5905-5915，标签双侧小写归一）。

### 1.2 角色现状（很薄，是本专项要补的洞）

`role` 目前只是两个消费点的键，**没有任何角色语义载体**：

1. `role_defaults[role].engine/model/provider` 引擎预置（session-manager.ts:5675，`ProjectRoleDefault` projects.ts:36-40）；
2. P81 权限岗位映射 `bizRole`，封闭词表 `worker/pm/team_pm/review/review_pm`（session-manager.ts:5765-5780），词表外 fail-closed 拒派；
3. 落卡字段 `engine_role`（types.ts:278，spawn 透传 session-manager.ts:2960/3492），纯标记。

**没有角色指令/角色模板**：派单纪律统一 `wrapDispatchPrompt(tier, task)`（session-manager.ts:6657-6667），不区分角色；「UI 设计师」和「后端」拿到的是同一份纪律前缀。M2 后 Leader 是唯一分诊出口，「项目 Leader」岗位已退役（org.ts:166 过渡段标注已过时）。

> 含义：角色经验回流不能只建库——**role_scope 的值域现实就是自由字符串**（dispatchWorker `input.role?.trim() || "worker"`，5673）。设计必须与这个现实对齐（见 §4.3）。

### 1.3 现有「经验/记忆」类机制盘点（六项）

| # | 机制 | 载体 | 谁读得到 | 结构化 | 状态 |
|---|---|---|---|---|---|
| 1 | 组织记忆（慢账） | org CLAUDE.md（org.ts:124-212） | 仅 Leader（cwd 自动加载） | ✗ 自由文本 | 运行中；写入纪律已种子化（宁缺毋滥三门槛 org.ts:139-152） |
| 2 | 项目记忆（防漂移种子） | 项目锚点 CLAUDE.md（projects.ts:860-891，幂等种子存在即认） | 该目录所有会话 | ✗ | 运行中；只装防漂移纪律 |
| 3 | **board lessons 分区（#087 经验回流雏形）** | boards/\<gid\>.json lessons 分区（projects.ts:110-131）+ sqlite lesson 表（schema.ts:106-110） | 端上板 delta 已下发但 **UI 从未渲染** | ✓ `LessonEntry{id,text,tags,ts,source_dispatch_id}` | **存储+查询已落，注入消费明确未接线**（projects.ts:112「本批只落存储+查询，注入接线不做」） |
| 4 | 派单收口自动账（M12-4） | 经 orgAction lesson-append 写 #3（session-manager.ts:4231-4248） | 同上 | ✓ | 运行中；口径「**不生成内容性经验**（不总结不提炼防垃圾账）」，内容性走人/agent 主动 |
| 5 | 熟手路由档案 | routing.json（routing.ts） | Leader 派单查表 | ✓ | 运行中；经验=会话上下文本体，档案只是统计 |
| 6 | 个人层 | 用户全局 CLAUDE.md + Claude Code 原生 memory | 全局 | ✗ | 运行中；组织层写入纪律明文「个人层已有的不收」（org.ts:141） |

另有 **events.ndjson 只留 30 会话**（history.ts:7-9，compactEvents 裁剪）——它是状态恢复面不是档案，经验**绝不能**指望它沉淀。

### 1.4 注入通道盘点（谁能在 spawn 时被喂什么）

| 通道 | 覆盖谁 | 机制 | 可用性 |
|---|---|---|---|
| cwd CLAUDE.md 自动加载 | 所有会话 | CLI 原生，零代码 | 现役（组织记忆/项目记忆都靠它）——但 worker cwd=项目目录，**读不到 org 侧任何东西** |
| initialPrompt（首条消息） | managed 会话（Leader/worker/随手办） | `create(..., prompt)` 唯一注入点，`wrapDispatchPrompt` 已是现役前缀（5810/5837/6657） | **P1 注入挂点（推荐）** |
| veteran resume 首条 | 熟手承接 | `resumeAgent(veteran, wrapDispatchPrompt(...))`（5810）——同走同一前缀 | 同上，天然覆盖「已有成员接新单时喂新经验」 |
| 插件 hooks（UserPromptSubmit 注入） | **external 桥接会话限定** | guard-context 组件制（guard-context.mjs:1-12，四组件先例）；managed 雇员会话 `CCR_RELAY_CHILD=1` 直接退出（hook.mjs:13-14），**不受控** | P2 可选通道 |
| employee home CLAUDE.md | 全体雇员共享单目录（config.ts:121-129，非按角色） | `CLAUDE_CONFIG_DIR` 注入（session-manager.ts:2984） | 不适合角色区分（全体共享一份），不推荐做角色注入位 |

> managed 会话没有 system-reminder 类通道；**首条消息是唯一可靠、已在用的注入位**。这不是妥协——它是确定性最强的通道（不依赖 hook 生命周期、不污染用户项目文件）。

### 1.5 持久化惯例（存储选型的约束面）

- **JSON 写穿全量 + 坏 JSON 容忍为空态**（routing.ts:47-56、projects.ts readConfirms 等）：org 域小账的统一惯例——**⚠ 注意此惯例只适用于可重建档案**（routing 是统计账，丢了可重积累）；经验库是不可重建的组织资产，**不照抄此惯例**，存储硬约束见 §6.2（REL 必-1：可重建的 events.ndjson 都做了 tmp+rename 原子写，不可重建的经验库裸写说不过去）；
- **append-only ndjson**（dispatch-log.org.ts:311-321）：审计语义账，「无容量上限，M1 量级无需轮转」；
- **sqlite** `data/cc-deck.sqlite3`：15 表冻结 schema（schema.ts，v1 基线 + v2 导入台账 + v3 权限审计），定位是 **events/boards/dispatch 的审计投影**（M11 导入器体系按 checkpoint 断点续跑回放，`import-dispatch-lesson.ts` 全件）；lesson 表已在其中（group 域投影）。read-mode 三档读（`viaReadMode`，read-mode.ts:645-670）已是接线范式；
- **目录定位纪律**：经验库是「用户可见团队资产」→ 必须落 org/，不能进 data/（org.ts:5-8）。

### 1.6 空白结论（本专项要填的）

1. **角色维度完全缺失**：无角色语义载体，经验无处挂角色标签；
2. **跨组共享缺失**：lessons 锁 group 域（`addLesson(gid,...)` projects.ts:728），A 组踩的坑 B 组看不到；org CLAUDE.md 只有 Leader 读；
3. **跨角色通用经验无通道**：构建命令、环境要点、协作纪律目前只能进项目 CLAUDE.md（单项目）或 org CLAUDE.md（Leader 专属）——worker 侧两头够不着；
4. **注入断头**：lessons 有存储有查询无消费（#087 留的出口正好是本专项的入口）。

### 1.7 与既有设计的关系（不另起炉灶的锚）

- **v8-team-matrix.html §3.2/3.3/3.4 记忆三层**：个人层（用户手写，AI 只读）/ 组织层（Leader 机器维护）/ 项目层（跟目录走）+ 写入判据两条 + 周期淘汰 + 「变更可见、事后可否决」。本专项 = 在组织层**内**叠加角色轴结构化，组织层从「Leader 专属自由文本」扩为「Leader 慢账（CLAUDE.md，不动）+ 团队经验库（结构化，全员可注入）」双载体；
- **009-beads-research.md §4 M2**：「lessons 由收口回执写入 board lessons 分区，下次任务书按项目/角色/引擎筛选注入；不全量灌入 Leader 上下文」——注入设计的原文依据，本专项即「注入接线」的兑现+扩展；
- **#087 lessons 分区**：组域雏形保留运行（M12-4 自动账还在写它），P1 起新库接管，旧域冻结迁移（见 §8.1 开放问题 1）。

---

## 2. 内容模型

### 2.1 什么算一条「经验」

一句话：**再遇到同类局面时，希望直接想起、且忘了会重复劳动或重复踩坑的可复用知识**（对齐 org.ts:140-141 门槛的组织层版本）。四类 `kind`（同构存储，kind 只影响展示图标与淘汰策略，不建两套模型）：

| kind | 装什么 | 例 |
|---|---|---|
| `pitfall` 踩坑 | 现象→根因→绕过/修复路径 | 「tmux 下注入必须走 send-keys，Terminal 定位必落空」（injector.ts:192-199 实例） |
| `practice` 方法 | 被验证有效的工作方式/流程 | 「出包前必跑 check-bundle-sync.sh」 |
| `preference` 偏好 | 用户/项目明说「以后都这样」 | 「提交信息动词开头、≤35 字」 |
| `fact` 环境事实 | 会过期的环境特异性 | 「adb 端口会漂移，先 mdns 发现」 |

**踩坑与正面经验同构**：同一结构、`kind` 区分——pitfall 多一个隐含契约「绕过方案要在 text 里」（org 种子原文「踩过的坑与排查路径（含绕过方案）」org.ts:147）。不建 `severity`/`confidence` 主观分。

### 2.2 条目结构（ExperienceEntry）

```jsonc
{
  "id": "exp-a1b2c3d4",              // exp- 前缀 + 8 位（对齐 lesson id projects.ts:738）
  "text": "≤200字一句话；pitfall 必含绕过方案",
  "kind": "pitfall",                 // pitfall | practice | preference | fact
  "role_scope": "ui-designer",       // "any" = 跨角色通用；其余自由角色名（§4.3）
  "project_scope": "global",         // "global" = 全局；否则项目锚点目录绝对路径（§4.1）
  "tags": ["expo", "发版"],           // 自由标签，AND 筛选沿用 listLessons 谓词
  "status": "active",                // active | retired（周期淘汰标记，永不物理删）
  "use_count": 3,                    // 注入命中计数（置信度的可操作替身）
  "created_at": 1760000000000,
  "last_used_at": 1760100000000,
  "updated_at": 1760100000000,
  "merged_from": ["exp-…", "exp-…"], // GC 合并收编的旧条目 id（溯源链，可空；旧条目同批转 retired）
  "source": {
    "actor": "agent",                // agent（worker 申报）| user（人/Leader 直写）；system 保留枚举——收口自动账已不进库（§3.1 D1-1），留给未来低频显式沉淀规则
    "session_id": "…",               // 来源会话
    "dispatch_id": "…"               // 收口自动账回溯链（可空；随 system 一并备用）
  }
}
```

设计要点：

- **置信度 = use_count + last_used_at**，不做主观评分。「有效」的可操作定义就是「真的被注入过且还活着」；排序消费它，淘汰也消费它（§5.3）；
- **retired 不删**：append-only 审计哲学（lessons 分区同款「只增不删，量大了再议归档」projects.ts:126），面板可看 retired 历史，避免「删了又踩」；
- **text ≤200 字**：对齐台账 receipt 截断惯例（org.ts:288），注入预算才可控；
- **四象限即两轴取值组合**，模型零特殊分支——`{any, global}` 通用 / `{role, global}` 角色专属通用 / `{any, project}` 项目全员 / `{role, project}` 项目角色专属。

### 2.3 捕获内容的最小闭环示例（用户原诉求对照）

- UI 设计师在 A 团队踩「Expo 图片必须 `@2x` 后缀才不被 metro 摇树」→ 写 `{kind:pitfall, role_scope:"ui-designer", project_scope:"global"}`（跨项目通用的角色经验）→ B 团队新 spawn 的 `role=ui-designer` worker 首条消息自动带上；
- 「本项目构建命令是 `node scripts/version.mjs --write && pnpm build`」→ `{kind:fact, role_scope:"any", project_scope:"/Users/xdd/dev/cc-deck"}` → 该项目任何角色新成员都拿到；
- 「发版说明动词开头 ≤35 字」→ `{kind:preference, role_scope:"any", project_scope:"global"}` → 所有团队所有角色。

---

## 3. 捕获机制

### 3.1 三类写入口，一个漏斗（推荐：混合制）

全部经 **orgAction 单漏斗**（对齐 lesson-append 先例 session-manager.ts:5314-5328「单漏斗内调 store 层，执行体无审计」），新增 action：`exp-append` / `exp-bump` / `exp-retire` / `exp-list`。

| 入口 | 触发 | 内容 | 防噪声定位 |
|---|---|---|---|
| ① 收口自动账——**明确不进经验库**（修订 D1-1） | —（M12-4 维持现状写 lessons/派单台账域） | 「卡摘要+结果+dispatch 锚」是派单流水不是可复用经验——**P1 不做 lesson-append 切 exp-append**：流水不成为经验条目、不进注入候选池、不计软上限 | 若照原设想按单灌库：软上限被流水烧穿、注入预算被最近流水占满、真经验被挤出窗口——三连劣化，与 §3.2「curated 账不是日志」自相矛盾；「不生成内容性经验、不总结不提炼防垃圾账」口径原样保留（session-manager.ts:4233 附近，以函数定位为准） |
| ② agent 回执申报（agent） | worker 收口回执带可选行 | 回执末行「经验：<一句话>（#pitfall/#practice/#preference/#fact 之一）」格式，收口时解析（**手法对齐 `receiptWithResultLine` 捞「结果：」行**，session-manager.ts，以函数定位为准）；**带 kind 标记才收**，无标记的纯文本不收（REL 建-4 防横向污染）；**role_scope 由收口侧从承接会话 engine_role 填写**，不由 worker 自报（ARCH S1，判定权在收口侧防脏 scope） | 行可选 + 字数截断 + kind 标记门槛 + 写入门控（§3.2）把关；解析失败/scope 校验失败静默不炸收口；配套**申报教学行**见 §5.1（D1-2：没人教 worker 写这行，解析器永远空转） |
| ③ 用户/Leader 直写（user） | org CLI `exp append` 子命令 / 端上 COMMAND（P2） | 全字段可指定 | 人写不拦 |

**自动提取（从会话流/转录挖掘）明确不做**（P3 再议）：external 会话事件经 hook 桥接只有工具名/摘要级信息（hook.mjs:10 诊断日志「不含用户内容」），managed 会话在进程内有全量但挖掘=内容性生成，正是垃圾场主风险源；v8 §3.5 本就拍板「沉淀是显式动作或回合末增量，不依赖会话结束自动沉淀钩子」。

### 3.2 写入门控（防经验库变垃圾场）

写入时（store 层 `appendExperience`，对齐 `addLesson` 的校验位 projects.ts:727-748）四条判据作为**提示性纪律**（种子文本+申报模板引导），两条作为**硬校验**：

- 硬 ① 文本必填 ≤200 字、role_scope/project_scope 形状合法（project_scope 必须是存在过的锚点目录或 "global"）；**校验失败与解析失败同口径：静默丢弃不炸收口**（随手办派单有 anchor 无 gid，其 anchor 不在 projects.json 时走此路径，ARCH S4）；「校验失败降级 project_scope=global + 审计行标注」列为开放问题 11 交拍板；
- 硬 ② **去重**：同 `role_scope+project_scope+kind` 下按**经验域自定义归一键**（trim + 小写 + 去标点去空白 + 前 N 字符，N 实现定）命中既有条目 → 拒收并返回既有 id，调用方可改走 `exp-bump`（use_count+1）——「重复踩坑」的正确动作是给旧条目加权，不是建新条目。**不复用 summarizer.ts:33 的 normKey**：那是 todo 隐藏/桥接消息配对键（口径=空白折叠+300 截断，不归一标点/大小写/全半角，「…必须@2x」vs「…必须 @2x。」不命中），当去重键效力被高估会漏（REL 建-5）；
- 硬 ② **复活环（修订 D1-3）**：append/exp-bump 命中同归一键的 **retired** 条目 → **不拒收，自动 restore + bump + 整理日志留痕**（自愈环：坑复发 = 条目自动回春；单测锁定）。低频场景的真经验 90 天未命中被自动 retire、场景复发重新申报时若被去重拒收，经验将永远躺平 retired、下次继续踩坑——自动 retire 的安全性论证（§3.3.2「风险≈0」）恰恰依赖本环存在；
- 软门槛（进申报模板与种子，不代码拦截——对齐组织记忆种子三条 org.ts:139-142 的软法传统）：跨角色还成立吗？换项目还成立吗？个人层/项目 CLAUDE.md 已有的不收；再遇希望直接想起；
- **软上限（只计 active 条目，修订 REL 必-2）**：全局 200 条 / 单角色 100 / 单项目 100（超限拒新，报错提示先 `exp-retire` 淘汰——经验库是 curated 账不是日志）。**retired 不占额**——retired 是终态且单调递增（自动 retire/手动 retire/合并收编都产），计入上限则库必然永久饱和、拒新常驻，经验库功能性死亡。retired 另设归档：**retired > 500 时整批移入 `org/experience-archive.json` + 通知提醒**（experience.json 保持轻；archive 同为 append 审计域，P1 随 GC 带出）。

### 3.3 整理机制（GC）：防经验库膨胀、保注入预算内质量

> 2026-10-10 用户补充定调：避免经验库持续膨胀、侵占上下文，需要定期整理。与压缩前任务摘要（context-watchdog，context-watchdog.ts:1-12 W-CTXFIX B3）同一设计哲学：**膨胀/压缩是预期行为，系统做「外置存档 + 低危自动 + 高危提案」，节奏不依赖会话生命**。

#### 3.3.1 触发：定时 + 阈值双轨

| 轨 | 条件 | 说明 |
|---|---|---|
| 定时 | 每周一次（relay 内存扫描器，`setInterval` + 错峰）**+ 启动补跑（修订 REL 建-1/ARCH Q2，采纳）** | setInterval 相位在内存不落盘，relay 频繁重启时段周扫可能长期不触发——**启动时读 `exp-gc-log.ndjson` 末行 ts，超 7 天即补跑一轮**（几行代码，与 findStaleGroups「扫描器纯函数 + 触发点分离」同构，projects.ts:952-984）；扫描器与单测共用判定 |
| 阈值 | active 条目数 ≥ 软上限 80%（全局 160/200）**或** json 体积 ≥ 256KB | 即时触发一轮，不等周扫；冷却窗 1h 防风暴（`WD_COOLDOWN_MS` 同款手法，context-watchdog.ts:24-25）。**256KB 阈值的真实定位（修订 REL 必-2）**：200 条 × ~300B ≈ 60KB，软上限正常生效时永远达不到——它实际防的是 retired 失控膨胀（retired 不占软上限额，§3.2），是**保险丝非独立防线** |

**饱和稳定态（修订 REL 必-2）**：库满且机械档无淘汰空间时，阈值轨每冷却窗到期就白跑一轮（冷却窗防风暴不防永续空转）——**饱和态扫描降频至 24h 一次**（判定：本轮动作集为空 → 下轮间隔升到 24h；有动作即恢复 1h 冷却）。

#### 3.3.2 动作：机械档（自动）+ 语义档（提案）分档制

**机械档（relay 规则，零 LLM，自动执行）**：

1. **精确去重补漏**：写入侧归一键去重（§3.2 硬②，经验域自定义键）只挡同 scope+同 kind；GC 轮补跨 kind 的归一键撞车——后条 retire、前条 `use_count` 并入（`merged_from` 记溯源）；
2. **低价值衰减淘汰（梯度制，风险分层）**：
   - **从未命中**（use_count=0）且 created_at 超 90 天 → **自动 retire**。风险≈0 的前提有二：从未被任何注入命中 = 角色/项目场景没再出现过；**且被 retire 的经验在场景复发时会经去重复活环自动回春**（§3.2 硬②复活环，D1-3）——此前提不存在则「风险≈0」不成立。可 `exp-restore` 一键恢复（retired 永不物理删，§2.2）+ 整理日志留痕——「gate 无自动路径」红线（projects.ts:106-107）管的是不可逆的用户决策，此处可逆+可查+低危，性质不同；
   - **命中过但超期未用**：fact 类 45 天 / 其余 90 天未命中 → 降权（**GC 给条目挂 demote 标记**，注入排序时按 §3.3.4 单点定义的权重公式落到候选尾位——公式不在本文两处重复定义，ARCH S2）；365 天未命中 → **提案 retire**（出确认卡/通知，人点头才执行）；
3. **体积兜底**：软上限已满且本轮无淘汰空间 → 拒新已在写入侧生效（§3.2），GC 出「库已饱和」提醒推动人工/语义档介入。

**语义档（内容性整理，LLM 提案回合，P2）**：

4. **相似条目聚类收敛 + 同主题合并升级**：阈值轨触发且机械档后仍 ≥80% 水位时，拉**一次性子会话**执行整理（**基建照抄 title-gen**：Claude CLI 一次性子会话，session-manager.ts:3017-3019 同款——不新建常驻角色）；输入=候选簇（按 scope+tags 预分组），指令=结构化约束（compactPrompt 同款风格，context-watchdog.ts:45-52：只输出 JSON、每条 ≤200 字、保留各自溯源）；
5. **提案制**：合并/聚类产出=「旧条目集 → 提案新条目」diff，**默认人工确认**（v8 §3.4「回流=提案 diff+一键确认」既有拍板）；确认后执行=旧条目 retire+新条目 append（`merged_from` 全记录）。**apply 执行时刻失效重验（修订 REL 必-3）**：拉子会话产出提案（分钟级）到人工确认（可能数小时后）之间存在窗口，候选条目可能已被用户 retire / 被 exp-bump 加权 / 被另一轮 GC 收编——执行前**逐条重验**（id 仍存在且 `updated_at` 未变），失效条目剔除并记入 GC 日志；**执行只允许经 race 赢家/用户确认这一条路径**（title-gen 的 Promise.race 超时后 run() 仍在后台跑、结果不消费——机械照搬会把过期提案卷入执行，覆盖用户操作）。超时/故障→本轮跳过，库照常可用（**整理是质量优化不是可用性依赖**——context-watchdog「压缩节奏归 CLI，本模块只做存档」同款边界哲学）。**快照时序 = write-ahead（修订 REL 必-3）**：执行前快照**先于本轮任何动作落盘**（§3.3.5），否则崩溃窗口内「动作已执行、快照未写」，极端误整理不可回放恢复。

#### 3.3.3 执行者推荐：relay 定时器 + 一次性子会话，不设 PM 整理岗

| 候选 | 判定 |
|---|---|
| **relay 内存扫描器 + 一次性子会话（推荐）** | 机械档零成本常驻；语义档按需拉起（title-gen 先例零新基建）；整理节奏与任何会话生命解耦 |
| PM/Leader 角色承担 | 否——Leader 回合烧 token 且不主动；组织记忆种子明文 Leader 的双手只用于分诊（org.ts:185-188 执行口径精神同构） |
| 专门「整理员」常驻角色 | 否——为低频动作养常驻岗位，错配；且角色岗本身也要吃经验注入，自指 |

#### 3.3.4 上下文侵占防护：注入预算硬裁剪（与 GC 双层防线）

- **注入侧（硬保障，P1）**：单个成员的单次注入按**字符预算**裁剪（默认 **≤700 字符**，env 可调；折算注释：1 token ≈ 1.5-2 汉字，700 字符 ≈ ~400 tokens——relay 无 tokenizer，预算实现为字符近似，不为「token 级」引分词依赖，修订 ARCH S7/REL 疑-1/UX D1-9），预算内按权重装满即止：**权重公式单点定义在注入纯函数头注释**——权重 = scope 优先级（project > role > global）× `use_count` × 新近度衰减（GC demote 标记参与该公式，本文其余各处只引用不重复定义，ARCH S2）。**经验库再膨胀，注入上限恒定**——防侵占的最后一道闸是裁剪不是整理；
- **整理侧（质量保障）**：GC 保证「预算内质量」——库小而精时预算装的都是高价值；库膨胀时衰减+淘汰把低价值挤出预算窗口；
- 预算裁剪是纯函数（候选集+预算→入选集），单测锁定「库 1000 条时注入块 ≤ 预算」性质。

#### 3.3.5 整理日志：可回溯、可人工干预（对齐 context-watchdog/memory 固化模式）

- **`org/exp-gc-log.ndjson`**（append-only 审计账，dispatch-log 同款惯例）：每轮一行 `{ts, trigger: scheduled|threshold, mode: auto|proposal, actions: [{type: dedupe|demote|retire|restore|merge_propose|merge_apply, target_ids, result}], snapshot_ref}`——`snapshot_ref` 指向本轮受影响条目的执行前快照；
- **快照**：`org/exp-gc-backup.json` 滚动保留最近 10 轮受影响条目集（外置存档，pre_compact_summary 同哲学）——极端误整理可整轮回放恢复。**写入时序 = write-ahead（修订 REL 必-3）**：快照**先于本轮任何 GC 动作落盘**，保证任意崩溃点「要么动作没执行、要么快照已可回放」；「动作已执行、快照未写」的窗口不允许存在——「可恢复」承诺的时序保障；
- **人工干预口**：`exp-restore`（retired→active）/ `exp-retire`（手动淘汰）走同一 orgAction 漏斗；P2 面板加「整理日志」只读分节 + 条目一键恢复。

---

## 4. 隔离维度（留白题①：要不要按项目隔离）

### 4.1 推荐：不物理分层——单池 + 条目双轴 scope 标签

**方案 A（推荐）**：一个全局经验池（org/experience.json），每条带 `role_scope × project_scope`，注入时按接收者 `(role, anchor_dir)` 谓词过滤。

```
匹配谓词（注入侧）：
  (e.role_scope === "any" || e.role_scope === myRole)
  && (e.project_scope === "global" || sameDir(e.project_scope, myAnchor))
  && e.status === "active"
```

**方案 B（对照）**：物理分层（全局池 + 每项目一层）——不推荐，理由三条：

1. **隔离是注入时态不是存储态**：四象限本来就是标签维度；物理分层后「这条通用经验要不要提升到全局池」「项目结项后条目搬哪」要发明一整套迁移规则和执行者，标签制下这些问题不存在（project_scope 指锚点目录，目录即锚点——v8 既有口径「目录即锚点，不依赖活的项目组」）；
2. **项目组的生命周期比目录短**：组 archived/结项（编制解散，session-manager.ts:5955）后经验应该活——`project_scope` 用 `anchor_dir` 而非 gid，二次立项读档恢复时旧经验直接复用（v8 §3.2 项目层「结项封存不删、二次立项读档恢复」的同行语义）；组只是经验的生产消费单位，不是归属单位；
3. **量级不需要**：单用户 cc-deck，条目软上限 200，单 json 内存过滤零压力；SQL/索引是为千条以上准备的（routing.ts:9「量大迁 sqlite」同款判断）。

### 4.2 项目轴的精度选择：anchor_dir 而非指纹/gid

`project.id.dir_fingerprint` 唯一（schema.ts:52）但指纹随目录迁移会变；gid 组死了就悬空（import-dispatch-lesson.ts:321-323 悬空 dangling 先例）。**用 anchor_dir 绝对路径**（尾斜杠归一，`buildArchiveChecklist` 已有同款归一 projects.ts:913），直觉、可迁移、与派单入参同域（dispatchWorker 的 anchor 直通）。

### 4.3 角色轴的值域现实：自由字符串 + 归一 + 保留字

现状 role 是自由字符串（§1.2），P81 封闭词表是**权限**域的事，不是经验域的事。设计：

- `role_scope` 自由字符串 + 小写归一（对齐 pickVeteran 标签双侧归一口径 session-manager.ts:5914）；保留字 `any` = 跨角色通用；
- 不建角色注册表：词表自然涌现（第一次以某 role 派单+申报经验即产生值），面板聚合去重展示（P2）；
- 写入不校验词表（fail-open）：拦「打错角色名」没有廉价手段（没有正典可对），靠面板可见性兜底——错名条目注入不命中，自然无危害。

### 4.4 迁移路径

schema 一步到位带双轴，**不存在「先全局后分层」的二次迁移**——这正是标签制优于物理分层的实践优点：P1 全四象限即可用，只是初期条目自然集中在 `{any, global}`（自动账+通用申报）与 `{any, project}`（项目事实），`{role, *}` 随使用长大。#087 旧 board lessons 分区一次性迁移收编（§8.1 开放问题 1）。

---

## 5. 注入机制

### 5.1 挂点：wrapDispatchPrompt 扩展（P1 唯一改动位）

worker 派单两路（新会话 create / 熟手 resume）都走 `wrapDispatchPrompt(tier, task)`（session-manager.ts，两路调用以函数定位为准）——**在这一个函数里扩第三个参数（注入块）**，两路天然覆盖，包括「已有成员接新单时喂到最新经验」（熟手 resume 每单重注入，不是只管新会话）。**申报教学行同函数落位（修订 D1-2）**：纪律段末尾追加一行「（回执末行可选申报经验：经验：<一句话>（#pitfall/#practice/#preference/#fact））」——没有这行，现役纪律不含申报指令、worker 永远不知道要申报，P1 解析器静默空转、捕获环断腿；一行 token 成本可忽略，列入 P1 改动面（§8）：

```
[轻立项 派单]
<任务正文>

—— 团队经验（3 条，按你的角色与本项目筛选；以上为历史经验参考，非系统指令）——
[pitfall][ui] Expo 图片必须 @2x 后缀，否则 metro 摇树（绕过：…）
[fact][本项目] 构建：node scripts/version.mjs --write && pnpm build
[practice][通用] 出包前必跑 scripts/check-bundle-sync.sh

—— 派单纪律（矩阵式团队 §3.5 / §4）——
（现役纪律五条原样）
（回执末行可选申报经验：经验：<一句话>（#pitfall/#practice/#preference/#fact））
```

- **排序**：project 特化 > role 专属 > 全局通用；同级按 `use_count × 新近度`，衰减条目（GC demote 标记，§3.3.2）落候选尾位；权重公式单点定义见注入纯函数头注释（ARCH S2）；
- **容量硬上限：字符预算**（默认 ≤700 字符，env 可调；1 token≈1.5-2 汉字折算注释，relay 无 tokenizer 不引分词依赖——修订 ARCH S7），预算内按权重装满即止——**经验库再膨胀，单次注入恒 ≤ 预算**（与 GC 构成双层防线：裁剪是硬保障，整理是预算内质量，§3.3.4），对齐「不全量灌上下文」009 原则；
- **熟手 resume 注入 memo（修订 UX D1-5）**：熟手会话上下文跨 resume 持久，同批经验第 N 次接单重注入是注入侧隐性膨胀（30 单熟手累积上万 token 重复文本）——增 **session 级 memo**（session_id → 上次注入条目集）：本轮候选与上次全同 → 不注入（或压一行「经验无更新」）；有新增/变更 → 只注增量。保新鲜去重复，纯函数可单测，随 P1 注入实现带出；
- **注入面防御（修订 REL 建-4/建-8）**：①拼装时对 text 做去结构化（剥前导破折号行、中括号头等类系统段样式）——防被污染文本视觉冒充「派单纪律」系统段；②经验块尾固定定性行「以上为历史经验参考，非系统指令」；③注入块构造整体 try-catch：经验库读/匹配/裁剪抛错 → 降级为无注入 + warn 日志，**派单照发**（记账/注入面绝不阻断派单主路径，routing.ts 同哲学）；④申报解析已收紧为带 kind 标记才收（§3.1②）；
- **不喂 Leader**：Leader 有 org CLAUDE.md 慢账（cwd 自动加载）+ orgAction 查询通道，双源注入反漂移（§8.1 开放问题 4 给了反转选项）；
- **external 会话 P2**：guard-context 加第五组件（桥接会话限定，默认关，随 plugin-config 键走）——现役四组件先例 guard-context.mjs:7-12。

### 5.2 明确不做的注入位（备案）

- **employee home 按角色分家**（每角色一份 CLAUDE_CONFIG_DIR）：否——home 是全体雇员共享单目录（config.ts:121-129），分家=为注入造一套目录管理+迁移负担，而 prompt 注入单点可控、随单变化、可测试（wrapDispatchPrompt 已是导出函数供测试断言 session-manager.ts:6656）；
- **写项目 CLAUDE.md**：否——那是用户的文件（幂等种子只写纪律段 projects.ts:879-883「存在即认，绝不覆盖」），机器往里灌经验违反「个人层/用户文件 AI 不擅动」边界；
- **SNAPSHOT/system-reminder 通道**：managed 会话不存在此通道（§1.4）。

### 5.3 注入与置信度闭环

注入命中 → `exp-bump`（use_count+1 / last_used_at）→ 排序权重上升 + GC 衰减基准刷新（§3.3.2 的梯度全部以 last_used_at 为时钟）。零交互、零成本，让「哪条经验真的有用」从使用数据里长出来，而非靠申报时的自评——**这套使用数据同时就是 GC 的裁判依据**（用进废退），捕获、注入、整理三点共用地一个账本。

### 5.4 时效性

「中途收到新经验」（在跑回合的 worker 被推送）**不做**：回合在途注入会污染正在执行的上下文，且经验的价值场景是「接单时」不是「干活中」；熟手下单自然吃到最新（5.1）。面板/P2 通知满足「人想立刻看」的场景。

---

## 6. 存储选型

### 6.1 推荐：`org/experience.json`（JSON 写穿全量），不进 sqlite

| 维度 | 判断 |
|---|---|
| 目录定位 | 经验库=用户可见团队资产 → **必须 org/**（org.ts:5-8 三物理事实）；data/ 的 sqlite 是 relay 运行数据域，先排除 |
| 读写形态 | 经验库是**可编辑活账**（status/bump/retire 都改存量）——JSON 写穿全量正贴 routing.json/projects.json 惯例；sqlite M11 体系是**append-only 审计投影**（导入器按 checkpoint 回放，import-dispatch-lesson.ts 全件），把可变账塞进回放模型是逆着设计用 |
| 查询形态 | 四象限匹配=内存小集谓词过滤（≤200 条），无需 SQL；`viaReadMode` 三档读已把「将来迁 sqlite」的缝留好（read-mode.ts:645-670，lesson 域先例 schema.ts:106） |
| 审计 | 写/淘汰经 orgAction 单漏斗自记 dispatch-log 审计行（M12-4 回流处 actor=system 同款口径，session-manager.ts:4238-4240）——审计走台账，不靠存储引擎 |
| 升级阈值 | >500 条或查询成为热路径时，按 routing.ts:9「json 起步，量大迁 sqlite，API 面向迁移收敛」既定路径迁——store 函数族（append/list/match/bump/retire）从第一天就是唯一读写口，迁移只换壳 |

### 6.2 文件与广播

- `~/.cc-deck/org/experience.json`：`{ entries: ExperienceEntry[] }`。**两条存储硬约束（修订 REL 必-1，写进 P1 存储层验收项），不照抄 routing.ts 裸写穿惯例**——routing 是可重建统计档案，experience.json 是不可重建的组织记忆资产，两条失效链都通向全库蒸发（写中途崩溃→截断 JSON→重启读坏→空态→下一次 append 把空库+新条目写回=历史全灭；用户手改写坏 JSON 同链被整体抹掉）：**① save 一律 tmp+rename 原子写**（照 history.ts rewriteFile 模式，#25-P1 先例：「崩溃只会留下可清理的 .tmp 残件，正文件要么旧要么新」——可重建的 events.ndjson 都做了原子写，不可重建的经验库没有理由裸写）；**② load 遇坏 JSON 绝不静默空态续跑**——坏文件改名 `experience.json.corrupt-<ts>` 留证 + 告警 + **拒绝一切写操作**（要求人工介入）。其余照旧：写失败 warn 不抛（记账面不阻断派单收口主路径，指正常写路径的失败告警语义）；
- `~/.cc-deck/org/exp-gc-log.ndjson`（GC 整理日志，append-only）+ `org/exp-gc-backup.json`（滚动快照，§3.3.5，**write-ahead 时序**）——同域三件套：活账/审计/存档；
- `~/.cc-deck/org/exports/experience-<ts>.json`（**导出备份，2026-10-10 用户追加拍板**）：`{ format: "cc-deck-experience-export", version, exported_at, count（条目计数校验和）, entries 全量含 retired }`——GC backup 体系之外的用户主动备份通道（`org exp export [path]`）；导入（`org exp import <path>`）=normKey 合并去重（撞车 bump 不覆盖、撞 retired 走复活环）、整读校验在前零半写（坏 JSON/计数不符/schema 单条坏/超 5MB 整单拒绝）、软上限超出 skipped_cap 跳过、动作+条目数入整理日志（trigger=import）；
- **并发安全前提（修订 REL 建-6）**：store 文件头注释写明「同步 read-modify-write（readFileSync→改→writeFileSync 全程同步）是并发安全前提，**禁止 async 化**；迁 sqlite 时须引入串行队列」——Node 单线程下多 worker 同时收口写经验的零竞态依赖的就是这个同步性，顺手 await 化即引入丢失更新窗口；GC 周扫触发器若涉异步（语义档 P2），机械档部分保持同步块完成；
- 变更广播 P2 接 SNAPSHOT 新域 + 专用 delta 帧（对齐 emitBoard lessons 差分先例 session-manager.ts:5597-5608 附近，以函数定位为准）；P1 无端面，零广播。

---

## 7. 展示形态（留白题②：纯后台 vs 面板展示）

### 7.1 推荐：后台为主 + 面板只读查看入口 + 总开关

**为什么不是纯后台**：注入是静默生效的跨项目跨团队行为，v8 §3.4 对组织层的既有拍板就是「变更可见（对话流摘要，事后可否决）+ append-only 审计可查」——纯后台把「AI 学了什么」藏起来，用户失去纠偏权，与「个人层优先、AI 只收增量」的整个记忆哲学冲突。

**为什么不是重面板**：经验库的主消费方是 worker spawn（机器），人是抽查/纠偏角色——低频动作；面板做重（搜索/编辑/审批流）是给次要场景建主界面，错配。

**折中落点**（三端现状对齐，§1.6）：

| 端 | 落位 | 优先级 |
|---|---|---|
| 手机（expo-app） | 项目组详情加「经验」分节（**参照 lessons 的 EntityDelta 差分模式为 experience 新域建协议帧——形状同构、域不同**，protocol.ts:455-466 BoardDelta 形状可复用；不是「纯 UI 空缺」：P1 迁移落地后 lessons 分区冻结无新增，UI 必须挂在新域协议上，修订 ARCH M1）；全局经验库入口挂 ListScreen orgZone（orgChips 同区，ListScreen.tsx:991-1017 附近） | P2 首选 |
| web-console | org 确认卡区（org-cfs）旁只读列表 | P2 跟进 |
| 桌面（Tauri） | 跟随 web-console 数据面，暂不单独立项 | P3 |

**展示粒度**：列表一行一条（kind 图标 + text + 两轴徽标 role/project + use_count + 新旧），点开看 source 回溯链（session/dispatch）； retired 折叠区。操作 = 「退役/恢复」+ **「补申报/改归组」组合动作（修订 UX D1-6）**：实现为 append(新) + retire(旧) + `merged_from` 关联（append-only 审计美学不破，COMMAND_EXP_APPEND 与 RETIRE 成对）——role 是自由字符串、多数派单默认 role="worker"，错挂 scope 是预期内最高频失败，无此入口则「retire + CLI append」两步且离不开命令行，主诉求的数据错了修不动，面板成坟场看板；开放问题 2 的「提级 any」落此入口。自由文本编辑仍不做（改字=新条目，保持 append-only 审计简单性）。

**总开关**：plugin-config **第七键** `experience`（现役六键：taskGuard/qNotify/restorePoint/deliverables/duty/preCompactSummary——preCompactSummary 已占第六，W-CTXFIX 2026-10-10 新增；修订 ARCH M3/REL 建-7。缺省开——对齐 #107 决策反转先例：默认关用户几个月发现不了，plugin-config.ts:19-31），关=注入停 + 面板隐藏，零残留（deliverables 键同款语义；自动账本就不经本库、无需停写）。

---

## 8. 分期实现计划

### P1 最小可用（relay 单域为主，零 LLM；端上仅旧 lessons 缓存清空一处）

| 项 | 改动面 | 预估 |
|---|---|---|
| 存储层 `org/experience.json` store 函数族（append/list/match/bump/retire/restore + 去重 + 软上限只计 active + retired 归档）。**验收项（REL 必-1）**：save=tmp+rename 原子写；load 坏 JSON → 改名 `.corrupt-<ts>` 留证+告警+拒绝一切写操作；文件头注释「同步 read-modify-write 禁止 async 化」（REL 建-6） | relay/src 新件 `experience.ts`（org/routing 同构范式） | ~280 行 |
| orgAction `exp-append/exp-bump/exp-retire/exp-restore/exp-list` + 审计行 | session-manager.ts orgAction 漏斗 | ~80 行 |
| ~~派单收口自动账升级~~ **明确不做（修订 D1-1）**：M12-4 维持现状写 lessons/派单台账域，**不切 exp-append、不进经验库**（0 行——防实现批按旧稿误实现） | 无 | 0 行 |
| 注入：`wrapDispatchPrompt` 扩展 + 匹配排序 + **字符预算裁剪纯函数** + resume session memo + 去结构化/try-catch 防御 | session-manager.ts + 新纯函数（可单测；库 1000 条注入仍 ≤ 预算的性质锁定） | ~150 行 |
| **申报教学行（修订 D1-2）**：wrapDispatchPrompt 纪律段末尾一行「（回执末行可选申报经验：…）」 | session-manager.ts 同函数 | 1 行 |
| 机械档 GC：触发双轨 + **启动补跑**（REL 建-1）+ 去重补漏（含 retired 复活环，D1-3）+ 衰减梯度 + 饱和降频 + 整理日志/快照（write-ahead） | experience.ts 扫描器 + relay 启动挂载 | ~170 行 |
| worker 回执「经验：」行解析（对齐 receiptWithResultLine；带 kind 标记才收，role_scope 收口侧填 engine_role） | session-manager.ts 收口链 | ~50 行 |
| org CLI `exp` 子命令（append/list/retire/bump） | org.ts ORG_CLI_TEMPLATE + /api/org 路由 | ~60 行 |
| **exp-export 导出备份（2026-10-10 用户追加）**：org/exports/experience-<ts>.json（或自选绝对路径）全量+format/version/计数校验和；坏 JSON 保护态拒导出（防空备份假象） | experience.ts store + orgAction + org CLI | ~60 行 |
| **exp-import 导入恢复（同上追加）**：normKey 合并去重（撞 active bump / 撞 retired 复活环 / 文件内自撞去重）、整读校验零半写（>5MB/坏 JSON/计数不符/schema 坏整单拒绝）、软上限超出 skipped_cap、动作入整理日志 | experience.ts store + orgAction + org CLI | ~110 行 |
| 旧 lessons 分区一次性迁移器（→experience，带组→anchor 换算；**按 source lesson id 幂等**——中途崩溃重跑不产生重复条目；**切换序=先迁后切**：迁移器报错即保持旧域运行、不冻结，REL 建-2；**只迁内容性条目**，D1-1） | scripts 或 experience.ts 内 | ~90 行 |
| **旧域读侧退役清单（修订 ARCH S6）**：COMMAND_LESSON_APPEND 命令字下线、listLessons 消费出口收口、M11 导入器 lesson 段（import-dispatch-lesson.ts:274-337）停灌、「lesson 表停灌不删表 + read-mode 兼容评估」升为正式项、**端上 lessons 缓存处置=清空**（org-delta mergeBoard 会继续维护旧缓存，迁移后无人清理——写死清空，不采用「标记陈旧」案，ARCH M1） | session-manager.ts / org-delta.ts / import-dispatch-lesson.ts | ~60 行 |
| 测试：store 去重/上限/匹配谓词/**复活环**/**坏 JSON 拒写** + 注入排序容量/memo + 收口解析 | relay/tests 新件 | 1-2 件 |

**风险**：prompt 变长（字符预算硬封顶）；role 错名（注入不命中无危害，面板可见性兜底）；GC 误淘汰（从未命中才自动 retire + 复活环自动回春 + 一键恢复 + 日志快照多重兜底）。**回退**：开关置关即全停（注入/GC 同停；自动账不经本库，与开关无关）。

### P2 增强（面板 + 治理 + external + 语义档 GC）

- 手机「经验」分节 + 全局经验库只读入口（**experience 新域协议帧** + delta 合并 + ListScreen/DetailScreen UI，参照 lessons EntityDelta 模式，§7.1 ARCH M1）；
- 用户否决通道：COMMAND_EXP_RETIRE + COMMAND_EXP_APPEND + **「补申报/改归组」组合动作**（append+retire+merged_from，§7.1 UX D1-6；开放问题 2 提级落此）+ 新经验通知摘要一行 + **GC 轮摘要一行（修订 UX D1-4：「经验整理：淘汰 N、合并 M，均可恢复」）**——自动动作静默发生是信任口子，「变更可见」须同样覆盖「变更消失」（v8 §3.4 闭环；通知面 decision-notify/notifications.json 域现成）；
- **语义档 GC**：合并/聚类提案回合（title-gen 一次性子会话基建）+ 确认卡交互 + apply 失效重验（§3.3.2 必-3）+ 整理日志/恢复入口上面板；
- external 会话注入（guard-context 第五组件，默认关）；
- SNAPSHOT/delta 广播接线（emitBoard lessons 差分先例）。

### P3 远期（不在本设计承诺内）

会话流自动提取（噪声治理成熟后）、角色模板系统（角色指令+经验一体下发）、云桥跨设备同步（经验域进 cloud SNAPSHOT）、sqlite 迁移（若量级触发）。

---

## 9. 开放问题清单（留给用户拍板）

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| 1 | #087 旧 board lessons 分区怎么处置 | a. 一次性迁移到 experience 后冻结旧域 b. 双写过渡观察一周 | **a**——双写=两个事实源，违背单源纪律。修订收窄（D1-1/建-2/建-3）：**只迁内容性条目**（M12-4 结构化账留台账域不迁不入库）；迁移器**按 source lesson id 幂等**（中途崩溃重跑不重复）；**切换序=先迁后切**（迁移器报错即保持旧域运行不冻结）；冻结含**读侧口径**——lesson 域读过滤为空（json/sqlite 同谓词一处谓词两档共用，防 sqlite 读档下 BOARD_UPDATED 仍带旧 lessons 双源同屏），端上 lessons 缓存清空（P1 表退役清单行）；M11 导入器 lesson 段同步退役 |
| 2 | worker 申报默认写谁的角色 | a. 默认申报者自身 engine_role，Leader/用户可提级 any b. 一律 any 由面板事后分拣 | **a（判定权在收口侧，修订 ARCH S1）**——role_scope 由收口侧从承接会话 engine_role 填写（dispatchWorker 落定、create 透传），申报行**不含角色自报**（自报错名=脏 scope 条目且注入不命中无从发现）；提级 any 是显式动作：用户/Leader 直写或 P2 面板「补申报/改归组」入口（§7.1 D1-6） |
| 3 | 用户否决交互形态 | a. 通知流一行摘要+一键退役（P2）b. 只做面板内管理（无主动通知） | **a**——面板是被动的，没人会定期巡检经验库；通知一行成本最低 |
| 4 | 经验注入要不要也喂 Leader | a. 不喂（慢账+查询通道够用）b. 喂（Leader 分诊时也能查全局经验） | **a**——Leader 的 org CLAUDE.md 是同域慢账，双源注入漂移风险大于收益；需要时 orgAction exp-list 查询 |
| 5 | project_scope 精度 | a. anchor_dir 绝对路径 b. dir_fingerprint c. gid | **a**（§4.2 已论证） |
| 6 | role 词表要不要封闭校验 | a. 自由字符串+归一（fail-open） b. 封闭词表 fail-closed | **a**（§4.3 已论证；P81 词表是权限域，不混） |
| 7 | 注入容量默认值 | ≤8 条/600 字 vs 更紧（4 条/300 字） | **字符预算 ≤700 字符为唯一硬约束（修订 D1-9/疑-1/S7）**——「≤8 条」降级为预期观测区间表述、非硬帽（若做成第二硬帽，权重排序形同虚设；条数是预算内涌现结果），P2 按 use_count 分布收敛 |
| 8 | stale 阈值 | practice/preference 90 天 / fact 45 天，还是统一 60 | **分 kind**——fact 先过期是实情（v8 原文点过代理端口/adb）；GC 衰减梯度（§3.3.2）已按此设 |
| 9 | 从未命中条目的自动 retire 默认态 | a. 默认自动（90 天档，可关+可恢复+有日志）b. 默认提案制（每周复核清单人点头） | **a**——主诉求是防膨胀，提案制把整理成本转嫁给人每周点头，违背「定期整理」本意；三重兜底（只限从未命中/一键恢复/日志快照）已把风险压到≈0 |
| 10 | 语义档合并（LLM 整理回合）确认交互 | a. 默认人工确认（提案 diff+一键采纳）b. 高置信自动执行 | **a**——对齐 v8 §3.4「回流=提案 diff+一键确认」既有拍板；内容性生成是垃圾场主风险源，人工闸值得 |
| 11 | 随手办等场景申报的 scope 校验失败处置（修订 ARCH S4） | a. 静默丢弃不炸收口（与解析失败同口径）b. 降级 project_scope=global + 审计行标注（随手办经验可回收） | **默认 a，b 留拍板**——a 是安全底（写死在 §3.2 硬①）；b 给随手办经验一条回收路，代价是 global 池混入弱关联条目，交用户拍板后可切 |

---

## 10. 调研中发现但不在本专项范围的事（备案）

- **role 语义载体整体缺失**（§1.2）：角色指令模板（「UI 设计师上岗带哪些守则」）是经验回流的天然上游，本设计只做 role_scope 标签，不做角色模板系统——若用户后续要「角色编制模板」，P3 有预留；
- guard-context 组件开关体系（plugin-config 现役六键，experience 将为第七键，§7.1）是 external 注入的现役范式，本设计 P2 复用，未动它；
- M11 导入器 lesson 段（import-dispatch-lesson.ts:274-337）在开放问题 1 选 a 时需同步退役，涉及 sqlite schema 语义（lesson 表停灌不删表）——实现批需带 read-mode 兼容评估。
