# Leader 独立评审：v2-system-design.md（0.8）vs 现状架构 —— 差距/优化/推翻

> 2026-10-05。评审对象：~/dev/cc-deck/docs/v2-system-design.md（336 行，2026-09-23 定稿 0.8）+ v2-legacy-audit.md。
> 对照基准：m2 已实装（projects.ts/org.ts M1-M4 + beads bfa3668）、083-org-model-final（PM 重角色/A/B 模式）、005（UI 宪法）、006（引擎适配规范）、引擎一期在途、018 六批、用户两条流锚定。
> 盲评纪律：独立完成，未与 PM 交流结论。

## 一、逐表差距（v2 §六 vs 现状实体）

| v2 表 | 现状实体 | 差距判定 |
|---|---|---|
| task | BoardEntry（projects.ts:69-90） | **三大缺口**：①无 depends_on/gate——beads 已实装（depends_on 引用+computeReady+gate 在场=blocked），v2 :94 仅「blocked 为 M2 预留态」，M2 已到；②五态（backlog/claimed/submitted/ready_to_install/done）vs 现板三态（todo/doing/done）——现板证明渲染只需收口三段，五态是验收闭环超集，需映射层不冲突；③无 tier（分诊六档：咨询/随手办/轻立项/正经立项/暂缓/看门狗）与 dispatch_id 联动（派单收口自动搬卡） |
| acceptance_item/result/sheet | acceptances/*.json v0 | v2 三表仍先进两代，保留主体。用户「验收项↔子任务一对一」= item.task_id NOT NULL 挂叶子天然支持，补一条实践约定：正经档拆卡默认按验收项 1:1 |
| session | 现状散文件态 | 仍对。agent_type 已是现实列（引擎一期：claude/codex/trae/codebuddy/generic）；083 org-config.json（mode）需进文件态清单 |
| team | ProjectGroup（projects.ts:40-63） | **实质差距**：v2 两态[active\|archived] vs 现状四态（pending 确认期/parked 挂起）；无 tier（轻/正经立项）；无 single_card（轻立项单卡简化态）；无 headcount 编制快照/role_defaults；无 hold_suggested_at（挂起冷却）/archive_note |
| team_member | OrgAnchor（全局锚）+ headcount 快照 + 083 角色模型 | **实体模型分歧**：v2=per-team 行（role[leader\|worker\|verifier\|researcher]）；现状=全局成员锚（退休/复活/跨组复用，M3 已实装）+编制快照挂组。083 终版：PM 常驻重角色、薄 Leader 仅 B 模式插拔（无验收权/无 commit 权/无 rescue 权）、评审卡=临时角色（proposed→active→retired 跑完即删）。词表全变 |
| notification | 005 通知域六语义 | v2 只有 read_at；005 已定语义：三段摘要/轻动作（confirm 链）/jump/已处置翻转（resolved≠已读）/统计高亮/源分组。缺 resolved_at + action 语义 + category 源枚举 |
| artifact | deliverables.json + deliver 链 | 仍对（挂 project 不挂 sid 根治归因，正确）。lessons 是行为经验非交付物，不进 artifact |
| ——缺失—— | OrgConfirm（projects.ts:118-130） | **v2 无对应**：五种 kind（project-create/tier-change/suggest-hold/archive/revive）人类决策队列，pending→approved/rejected，「确认卡是用户决策唯一写面」红线 |
| ——缺失—— | DispatchEntry（org.ts:277-288，append-only ndjson） | **v2 无对应**：派单过程账（六档 tier/dispatched→running→done→failed/receipt 回执/actor 谁派活）。流①流②的执行账本体 |
| ——缺失—— | LessonEntry（projects.ts:91-99） | **v2 无对应**：tags AND 筛选+source_dispatch_id 溯源，append-only。009 §4 语义：经验由 cc-deck 定义不散外部 memory |

## 二、概念演化冲突（09-23 写作时点 → 10-05 现状）

1. **组织词表整体迁移（最大冲突）**：v2 通篇 Leader=常驻重角色（分诊/派单/验收豁免权）；083 终版已重分配——Leader 位=用户自任（A/self）或薄 Leader（B/delegated，只路由/聚合/提醒/升级），**PM 才是常驻重角色**（分诊/任务书/派单/验收链/巡检/代提交/Worker rescue）。波及：§六 role 词表、§七权限表「用户/leader 豁免」、§九接替触发权。083 实施批③已定存量 role:"leader" 读映射 team_pm
2. **「M1 仅 ClaudeCodeAdapter」前提失效**（§一:11）：引擎一期已实装 Trae/CodeBuddy/通用 JSONL 兜底+角色→引擎配置（006 §6.1）。「接口先行、实现唯一」纪律本身被验证仍对（真实需求来了才写），但 M1② 的单适配器排序假设过时
3. **两条流覆盖度**：流①（用户建任务→入库→下发）——task.create+taskRef 主路+硬路注入骨架在，但**分诊路由链**（六档 tier→选引擎/成员→spawn→dispatch 台账→收口搬卡）是 m2 实装增量，v2 无一字；流②（Agent 自更新回写）——命令面+对账两级覆盖 CC，引擎一期证明「任务文件轮询=对账真相源」仅 CC 成立，其他引擎靠通用 JSONL 投影，§三能力4 hasNativeTasks 声明已预留（正确）
4. **blocked 预留态已到期**：beads gate 已实装且带红线（无自动放行/关闭，清除只能人显式 upsert gate:null）——表化直接落列+CHECK 补第六枚举值
5. **「目录即项目」vs「显式立项」是两层不是一层**：v2 §四=会话 cwd 指纹静默聚合；m2=正经立项走确认卡（pending 期）+anchor_dir 显式锚定+编制。两层并存裁定：project 表（指纹实体，自动聚合，v2 设计保留）+group 表（业务项目组，立项门槛+编制+板，v2 team 表改造）。轻任务（咨询/随手办）不立项直达——tier 门控
6. **验收链 tier 门控缺失**：v2 sheet 全链（issue/fill/close）面向装机批次，默认所有任务走验收；现状实践=咨询/随手办无单直收、正经立项才走验收。修订：验收链启用由 tier 门控（轻档可选、正经档强制）

## 三、三级清单

### 保留（10 项）——v2 骨架仍先进
1. §五 SQLite better-sqlite3 总纲+双轨职责线（库答当前态/events.ndjson 答审计广播）+mutation 先写库后 emit
2. §六 acceptance 三表拆分+D13 两段式（活工作态搬运）+D15 判定效力+D16 身份凭证（per-session token/端凭证/id 仅路由）
3. §六 session 表全景承接（runtime_state_json/文件态 ≥12 处归位/spawn_record 收库）+回放路径下线（§五前置必改④）
4. §八 锚=message.id+反向块扫+性能铁律（禁 O(文件) 读）+断连补洞握手+alert 补发
5. §九 watchdog 双信号三色+接替触发权三域+失联通知分级+重建窗口静默
6. §十二 扩展体系+单一注册表（命令/事件一处注册）
7. §五 前置必改四项（压缩分桶三件套/seq max/心跳 emitTransient/回放下线）——独立于 V2 也要修
8. §六 task 外部锚两列化（external_sid+external_task_file_id 复合唯一取代拼串）——引擎一期验证两列通用（取值域扩为各引擎原生任务 id）
9. §七 修复轮规则 D14（fail 原卡不回退+修复子卡+克隆溯源+批收口）
10. §七 命令面+状态转移矩阵+单写者纪律（relay 单线程=原子性来源）；task.project_id 外键已覆盖用户「任务↔项目关联」口径

### 优化（13 项）——改，给改法
1. **task 补 beads 三件**：`depends_on_json`（卡 id 数组，读时 computeReady——同「父卡状态读时不落列」哲学）+`gate_reason?/gate_opened_at?` 两列（清除=显式 UPDATE NULL，无自动路径）+status CHECK 补 `blocked`（六值）
2. **新增 lesson 表**：id/project_id→/tags_json/text/source_task_id?/source_dispatch_id?/ts；append-only；查询按 tags AND 扫表（MB 级可接受，FTS 后议）
3. **新增 org_confirm 表**：id/kind CHECK(project-create|tier-change|suggest-hold|archive|revive)/title/reason/payload_json/status CHECK(pending|approved|rejected)/decided_at?/decided_by?；partial index `WHERE status='pending'`
4. **新增 dispatch 表**（台账表化）：id/tier CHECK 六值/target/project_id?/status CHECK(dispatched|running|done|failed)/receipt?/session_id/actor/ts；append-only 读侧同 id 取末行；流①②执行账
5. **team 表改造为 group 表**：status CHECK 四值（+pending 确认期+parked）+tier CHECK(轻立项|正经立项)+single_card+headcount_json 编制快照+role_defaults_json+hold_suggested_at?+archive_note?——ProjectGroup 全字段搬迁
6. **team_member 重定义**：全局 member 锚表（退休/复活/跨组）+headcount 快照入 group 列（升降级只补不重建=快照语义）；role CHECK[pm|worker|reviewer|leader_thin]（083：评审卡临时角色带 lifecycle 字段，薄 Leader B 插拔）；status 补 retired；model_route 拆 engine+model 两列（006 §6.1）
7. **notification 补 resolved_at?+action_json?**（轻动作语义：confirm 动作完成后已处置翻转≠已读）；category 枚举对齐 005 源分组
8. **tier 不上 task 列**：维持 dispatch 表持有+task↔dispatch 关联（避免双写；分诊是派单属性——现状 DispatchTier 挂台账已验证）
9. **org-config.json 进 §五文件态清单**（083 裁定轻量 json 留文件态：mode self|delegated+leaderId 索引）
10. **§七命令面补派单命令族**：dispatch.create（流①：用户建卡→分诊→下发 spawn）/dispatch 状态回写（relay 编排写；agent 侧仍只走 task 命令族+verdict.self——流②回写入口=对账+task.submit，引擎原生任务态经通用 JSONL 投影归一）
11. **§四开团锚定补确认环节**：正经立项 create→org_confirm(pending)→用户✓→active（pending 态写入点）；轻立项=单卡简化态
12. **§五存量迁移清单扩容**：原 12 处文件态是 09-22 审计口径；m2 增量五类（org/anchors/projects.json/boards/<gid>.json/confirms.json/dispatch-log.ndjson）+org-config.json 为新迁移源；迁移验收点补 computeReady 表化断言等价（99+22 测试平移）
13. **agent_type 枚举实值定案**：claude/codex/trae/codebuddy/generic_jsonl（引擎一期实装值）；ext- 剥除两列化对 Codex 桥接同适用

### 推翻（3 项）——重设计，给理由
1. **team 表「开团编制」定位整体推翻**：v2 team=一次开团编制+team_member per-team 行；083+m2 已演化成「项目组=常驻业务实体（四态+编制+板+台账）+成员=全局锚复用」。重设计：**member（全局锚表）+group（项目组全字段表，headcount 快照列）两表取代 team+team_member**。理由：M3 退休/复活（成员跨组生命周期）、083 PM 卡休眠责任不消失、编制快照「只补不重建」语义，三者在 per-team 行模型下都要造跨表迁徙，全局锚+快照模型天然成立
2. **「M1 仅 ClaudeCodeAdapter」排序前提推翻**：M1② 改「ClaudeCodeAdapter=契约基准实现+多适配器按 006 规范增量并进」；契约六能力按引擎一期实证回填（如 Codex 桥接 spawn 语义=挂靠非 spawn）。理由：引擎一期已开工，排序回不到单适配器世界
3. **§六「其余六表（机械合并，无争议）」标签作废**：team/team_member/notification 三表在 083/beads/005 三线增量下全部有实质差距（见逐表），修订版逐表重审，不得再以「无争议」跳过

## 四、与 018 实施线关系裁定

- **018 在途批次（B3a/B4a）继续收口**：它们是 v2 迁移的「存量源」，先收口=迁移时数据形态稳定
- **B1a 起冻结新增文件态节点**：018 四类文件节点之外不再新增文件态存储；新实体集中 projects.ts 单文件（迁移面可控）
- **v2 M1① 动工双条件**：018 收口 + 005 组件化第一批抽出（M1① 的事件语义改型〔状态快照帧→实体引用增量〕动三端，与 005 实装管线同期必撞——组件抽取期协议面未动，是插入窗口）
- 迁移脚本验收点：org 五类 JSON+dispatch-log 全量搬迁、beads 语义断言平移

## 五、修订后 M1 三步

1. **M1① 数据地基（扩容）**：原案全保（SQLite+索引+指纹+前置必改四项+注册表）+ 四新表（lesson/org_confirm/dispatch/group）+ member 重设计 + task 补 blocked/depends_on/gate + org 五类 JSON 迁移 + 事件语义改型三端联动
2. **M1② 编排（适配器扩容）**：原案全保（命令面+三档同步+对账+watchdog+接替+sheet 自动化+单会话引导+身份模型）+ 派单命令族（流①②）+ 分诊引擎表化接线 + 多适配器按 006 并进 + 083 A/B 模式（org-config+薄 Leader 卡+PM 队列四态）
3. **M1③ 呈现**：原案全保（项目域+通知+history+MCP 骨架+手动接替）+ 005 组件化管线合流（005=呈现契约）+ A 模式 PM 工作台（团队目录/选 PM 发需求/队列四态）+ tier 门控验收链

**顺序建议**：005 定稿域冻结→组件抽取（第一批）→ M1① →（018 已收口）→ M1② → M1③。

v2review done: keep 10, revise 13, overturn 3
