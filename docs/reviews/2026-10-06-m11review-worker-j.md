# worker-J 回单：M11-REVIEW 存储线四单独立盲评（M11-A1/A2/B1/B2）

盲评对象：3da3901(A1 驱动+StoragePort) / 3548225(A2 迁移 runner) / 8a33615(B1 15 表 DDL) / ac72306(B2 checkpoint+loss)。
盲评纪律：先独立完成五维审查+node 实测+四套测试亲跑，本回单主体成文后才读 worker-G 回单做对照（见 §六）。
方法：七源文件全读（port/sqlite/migrator/schema/checkpoint/loss-report/import-org）、冻结件 docs/v2-m10-freeze.md 逐条对表、tsx 临时库实测（三表 PRAGMA 抽查+双连接 BEGIN IMMEDIATE 争用+TEXT PK NULL 怪癖）、四套测试连跑两轮。

## 一、五维结论总表

| 维度 | 判定 | 核心证据 |
|---|---|---|
| ①边界与错误面 | **PASS** | 编程错误全炸不静默（未 open/重复 open/嵌套 begin/无事务 commit 四路实测拒绝）；迁移失败原子回滚保留前版可重跑；offset 越界显式校验炸；CHECK 词表与冻结件逐值一致 |
| ②并发与重入 | **WARN** | 双连接 BEGIN IMMEDIATE 实测=第二写者等 ~7.5s 后可判定抛 "database is locked"，零损坏零死锁；WAL 跨进程读写实证存活。WARN 源：observe 读序竞态（P2-1，归 C1 消费面）+ busy_timeout 未显式声明（P3-1） |
| ③数据正确性抽查 | **PASS** | 亲手临时库 runMigrations {from:0,to:2,applied:[1,2]} user_version=2；task 25 列/artifact 12 列/org_confirm 10 列逐列对照冻结件 §2 全一致（列序/类型/NOT NULL/默认值/CHECK/UNIQUE/复合主键） |
| ④测试质量 | **WARN** | 四套 140 断言连跑两轮全绿一致（21+18+67+34）；断言总体从严（真事务回滚状态断言、真临时源文件+utimesSync 推 mtime）。WARN 源：四测试件未注册 package.json scripts（P2-2），回归入口缺失 |
| ⑤安全面 | **PASS** | exec 双模守界清晰（带 params 全走 prepare 绑定单语句 sqlite.ts:58-63；无 params 多语句 exec 仅 DDL 静态常量）；setVersion 插值无注入面（version 经 assertWellFormed 校验 migrator.ts:41-45）；loss excerpt 截断 512 |

四单总评：**可验收**。无 P1；P2×2；P3×7。架构（端口三拍事务/exec 双模/user_version 版本态/五元组 checkpoint/loss 台账）与冻结件 §1 红线、§2 DDL、§4 checkpoint 口径一致。

## 二、维度 ①边界与错误面：PASS

**端口编程错误全炸不静默（实测四路拒绝）**：
- 未 open 直接 exec → requireDb 抛（sqlite.ts:73-76；test-storage-driver.ts:96 实证）
- 重复 open → 炸（test-storage-driver.ts:97）
- 嵌套 begin → 炸（:98；port.ts:29 注释明示「已有未结事务时视为编程错误」）
- 无未结事务 commit → 炸（test-storage-driver.ts:64）

**迁移失败原子回滚**：migrator.ts:56-64 逐版本 `begin→up→setVersion→commit`，catch→rollback+包版本上下文错误（:64「保留 v{from+applied.length} 完整态」）；up 与 user_version 同事务，schema 与版本号一并回滚。test-storage.ts:59-81 注入实证：v2→v3 中途炸后 user_version=2、v2 schema+数据完整、失败版本索引零残留、重跑仅补 v3 且不丢既有数据（:80-81）。

**checkpoint offset 越界/负值**：checkpoint.ts:31-33 显式校验 `Number.isInteger(offset) && 0 <= offset <= lineCount`，违者抛「编程错误」；test-storage-checkpoint.ts:102 实证 offset=14>lineCount=13 炸。读回面：readCheckpoint 五元组任一不符返回 null（checkpoint.ts:67-74），三路失效（lineCount/mtime/schema_version）各有实证（test-storage-checkpoint.ts:92-97）。

**DDL CHECK 覆盖冻结件全部枚举**：冻结件 §2 共 6 组 CHECK——group.status/tier、task.status/review_status、dispatch.status、org_confirm.status、acceptance_result.verdict、artifact.existence_state。实测（tsx 临时库 sqlite_master 全文+test-storage-schema.ts:133-142 九路非法值拒绝+:123-130 全词表正检）逐组一致，无遗漏无多加。member.status/session.status/notification.level 冻结件本就无 CHECK，施工未擅自补——边界纪律正确。

**负面清单**：未发现任何吞错路径（catch 后不抛不记的点零个）；未发现错误消息缺上下文的迁移失败分支。

## 三、维度 ②并发与重入：WARN

**实测：两个导入器同库 BEGIN IMMEDIATE**（tsx 双连接，A 连接 StoragePort 先 begin 拿写锁，B 连接裸 better-sqlite3 BEGIN IMMEDIATE）：
- 第二写者等待 ~7.5s 后抛 `database is locked`（SQLITE_BUSY），可判定失败、零写入、零损坏、无死锁
- 换边重测对称（B 持锁 A 争，同样 ~7.9s 抛错）
- 等待 7.5s > busy_timeout 5s 的原因：busy handler 重试粒度，属正常 SQLite 行为

**WAL 跨进程读写边界**：test-storage-driver.ts:69-79 真·新进程 readonly 探针实证提交数据跨进程存活+回滚数据不可见；实测第二连接只读可见 A 已提交行。三 PRAGMA 冻结正确（sqlite.ts:31-33：WAL 持久化进库文件，foreign_keys/synchronous=NORMAL 连接级每次 open 重设）。

**WARN 源一（P2-1）：import-org.ts:61-64 observe() read 先于 stat 的竞态窗口**。注意：import-org.ts 属 M11-C1（f8e974f）交付，不在四单盲评范围，但它是四单 checkpoint 契约的唯一重量级消费面，按维度 2 提问纳入消费面观察。`readFileSync(:61)` 在 `statSync(:64)` 之前——若文件在 read 完成后、stat 前被改：mtime 观测到新值而 text 是旧内容，checkpoint 记「新 mtime+旧内容处理结果」；若后续修改恰不换行数，账目错位且方向是「漏更新」（下次误判未变跳过重扫）。修法一行：调序 stat→read（同序竞态落「多扫一次」安全侧）。四单侧无此问题（checkpoint.ts 自身只管表读写，观测归导入器，文件头注释已明示分工 checkpoint.ts:7）。

**WARN 源二（P3-1）：busy_timeout 未显式声明**。sqlite.ts open 三 PRAGMA 没设 busy_timeout，实际依赖 better-sqlite3 默认 5000ms（实测 PRAGMA busy_timeout=5000）。长导入事务（大 orgDir 域清重灌）下 5s 可能不够，第二进程导入器必抛 BUSY。单机单 relay 单写者纪律下可接受，但建议 sqlite.ts 显式 `pragma("busy_timeout = 5000")` 把隐式依赖变显式契约。

**P3-7（TOCTOU 备案）**：import-org.ts:108 readCheckpoint 判定在 :282 BEGIN IMMEDIATE 事务外——observe/checkpoint 读取与落库事务之间存在窗口。因 sha12 确定性 id+域清子表重灌的幂等设计，重复执行结果收敛，良性。

**P3-6（错误语境备案）**：import-org.ts:282 port.begin() 在 try 外——begin 失败（BUSY）直接冒泡原始错误。这是**正确**行为（begin 失败无需回滚，回滚才出错），仅报错无「导入」语境包装，友好度欠账。

## 四、维度 ③数据正确性抽查：PASS

**实测方法**：tsx 起临时库（mkdtemp，env 全清）→ `runMigrations(port, migrations)` 得 `{from:0, to:2, applied:[1,2]}`、`PRAGMA user_version=2` → 手写 SQL `PRAGMA table_info` + `sqlite_master.sql` 抽 task/artifact/org_confirm 三表 + import_checkpoint/import_loss 两台账。

**逐列对照结果**（对照 docs/v2-m10-freeze.md §2 DDL）：
- **task 25 列**：列序与冻结件完全同序；类型全 TEXT/INTEGER 无漂移；默认值四点全对（description `''`、scope_json `'{}'`、depends_on_json `'[]'`、review_required `0`）；task_ref UNIQUE 在；status CHECK 五态 backlog/claimed/submitted/ready_to_install/done 与 review_status CHECK 三态+可 NULL 全对；FK 5 条（project/group/session/parent_task/assignee）
- **artifact 12 列**：复合主键 (source_id, normalized_path) 落为主键序 1+2；existence_state CHECK 三态 exists/missing/unknown 对
- **org_confirm 10 列**：status CHECK 三态 pending/approved/rejected 对；payload_json DEFAULT '{}' 对
- **import_checkpoint**：五元组 path/mtime_ms/line_count/line_offset/schema_version + updated_at 全在，主键 path；**import_loss**：自增 id + 四业务列全在

三态→五态映射口径（冻结件红线 2）由 CHECK 词表物理兜底：legacy 值 todo/doing/blocked 直落必炸（test-storage-schema.ts:134-135 实证并注明「导入期翻译，不得直落」）。

**P3-4 实测发现：TEXT PRIMARY KEY 可插 NULL**——SQLite 历史怪癖（PRIMARY KEY 不隐含 NOT NULL，除 INTEGER PK/WITHOUT ROWID 外）。实测 org_confirm 插 NULL id 成功。16 表全部 `id TEXT PRIMARY KEY` 受影响，但**冻结件 §2 DDL 原文如此，施工零偏差**，属冻结件继承 laxity；实际写入路径 id 全由导入器 sha12 确定性生成，无 NULL 来源。备案不动。

**P3-5 备案**：checkpoint 列名 line_offset vs 冻结件 §4 行文 `last_offset`——冻结件 §2 DDL 未含 checkpoint 表定义（§4 是语义结构非 DDL 定案），命名自由度在 B2，语义一致，不违冻。

## 五、维度 ④测试质量：WARN

**亲跑实证**：四套连跑两轮全绿一致——driver 21/21、migrator 18/18、schema 67/67、checkpoint 34/34（合计 140 断言×2）。env 全清（env -u CCR_TOKEN/CCR_PORT/CCR_DATA_DIR/CCR_ORG_DIR）跑法与回单声明一致。

**断言从严的证据**（非走查式点头测试）：
- 迁移失败注入后断言三面（user_version+schema+数据）而非只看抛错（test-storage.ts:71-73）
- checkpoint 失效用真临时源文件+writeFileSync/utimesSync 驱动，连「APFS 同毫秒 mtime 不动」都显式推进 10ms 处理（test-storage-checkpoint.ts:87-89）——fixture 工程质量高
- FK 验证做执行态（悬空写入被拒四路）而非只查 PRAGMA 声明（test-storage-schema.ts:99-102）；CHECK 验证双向（全词表正检+非法值拒绝）；UNIQUE 验证声明（PRAGMA index_list 逐表计数）+执行（重复插入七路拒绝）
- 「绝不造关联」用对照断言坐实：硬塞悬空 id 被 FK 拒 vs 正解写 NULL（test-storage-checkpoint.ts:185）
- 真·新进程重开验证 WAL 持久（spawnSync 独立 node 进程 readonly 探针，test-storage-driver.ts:69-79）——不是同连接假装重启

**WARN 源（P2-2）：四个测试件均未注册 package.json scripts**。33 个 scripts 无一 storage 相关（test:bus…test:ws 共 31 套全有注册）；A1 提交动了 package.json（引入 better-sqlite3 依赖）却未加测试入口，A2/B1/B2 也未补。后果：回归入口缺失——下个 worker 不知道有这四套，`npm run` 不可发现，CI/批量回归不跑，「fixture 全过」只能靠手工 `npx tsx scripts/test-storage*.ts`。建议补四行（test:storage-driver/migrator/schema/checkpoint）或聚合一行串跑。

**断言松处排查**（未到 WARN 级，备案）：test-storage.ts 用假想 mig_scratch 三版本只验机制不验真 DDL——文件头注释明示设计意图且真实 DDL 归 test-storage-schema 67 断言覆盖，分工合理。schema 套对 group_member 覆盖列只断言列存在未断言类型（test-storage-schema.ts:69）——可空列无默认值，风险极低。

## 六、维度 ⑤安全面：PASS

**exec 多语句 vs prepare 绑定守界**：port.ts 语义=带 params 走 `db.prepare(sql).run(...params)`（sqlite.ts:63，单语句参数绑定）、无 params 走原生 exec（多语句，B1 DDL 消费形态）。排查全部写路径：B2 checkpoint UPSERT/loss INSERT、测试种子、migrator DDL——带 params 的全部真绑定，多语句 exec 仅 schema.ts 静态 DDL 常量（BASELINE_15_TABLES_DDL/IMPORT_LEDGER_DDL 编译期字面量，零插值）。

**插值点审计**：全存储线仅一处模板串插值——migrator.ts:37 `PRAGMA user_version = ${version}`；version 来自 assertWellFormed 校验（:41-45 从 1 连续升序的 number），无注入面。测试文件里 `PRAGMA table_info(${JSON.stringify(t)})` 表名经 JSON.stringify 引号包裹且为内部常量，安全。

**路径拼接逃逸**：sqlite.ts:79 `join(dir, filename)`——filename 由调用方 StoragePortOptions 传入，port 层不防 `../`；生产调用面 dataDir 由 cfg 钉死、测试全 mkdtemp 临时目录（四套启动前均断言 tmpdir 前缀+零生产写入，test-storage-driver.ts:29 还实证 ~/.cc-deck 下无库文件）。import-org 三源路径固定 join(orgDir, 固定名)，词表硬编码，id 全 sha12 确定性推导——无用户可控路径/标识进入 SQL 文本。

**loss excerpt 截断**：loss-report.ts:29 EXCERPT_MAX=512，:33-35 超长截断以 … 收尾，防超长坏行灌库；实证（test-storage-checkpoint.ts:126-129）。

## 七、发现清单

**P1（必须修）：无。**

**P2（应修）：**

| # | 级别 | 位置 | 问题 | 复现 | 建议 |
|---|---|---|---|---|---|
| 1 | P2 | import-org.ts:61-64（C1 单，消费面观察） | observe() readFileSync 先于 statSync，竞态窗口内文件被改则 checkpoint 记「新 mtime+旧内容」，错位方向为漏更新 | 文件 read 完成后 stat 前 recv 改写（毫秒窗口）；行数恰不变的修改最危险 | 调序 stat→read，使竞态落在「多扫一次」安全侧；一行改动 |
| 2 | P2 | package.json（四提交均未动 scripts） | 四套 storage 测试未注册 npm scripts，回归入口缺失，CI/他人不可发现 | `grep storage package.json` 零命中；31 套既有测试全有注册 | 补 test:storage-driver/test:storage-migrator/test:storage-schema/test:storage-checkpoint（或聚合串跑一行） |

**P3（备案）：**

| # | 位置 | 内容 | 不动理由/触发条件 |
|---|---|---|---|
| 1 | sqlite.ts:29-33 | busy_timeout 未显式设置，依赖 better-sqlite3 默认 5000ms（实测=5000） | 单写者纪律下够用；多进程导入落地时显式化 |
| 2 | sqlite.ts close | 有未结事务时 close 的行为未声明（better-sqlite3 静默回滚）——与「编程错误炸」哲学不完全一致 | 驱动行为安全（回滚不丢已提交数据）；编排层保证 begin/commit 配对 |
| 3 | migrator.ts:62-64 | catch 内 rollback() 若自身抛错会掩蔽原始迁移错误 | up 只发 DDL，rollback 再炸概率极低；嵌套 try 可修，收益小 |
| 4 | schema.ts（16 表） | TEXT PRIMARY KEY 无 NOT NULL，实测可插 NULL（SQLite 历史怪癖） | 冻结件 DDL 原文如此，施工零偏差；写入路径 id 全 sha12 确定性生成 |
| 5 | schema.ts v2 | checkpoint 列名 line_offset ≠ 冻结件 §4 行文 last_offset | §4 为语义结构非 DDL 定案，命名自由度在 B2，语义一致 |
| 6 | import-org.ts:282 | begin() 失败直接冒泡原始错误（无「导入」语境包装） | 行为正确（begin 失败无需回滚）；仅友好度 |
| 7 | import-org.ts:108 vs :282 | checkpoint 判定在事务外（TOCTOU） | sha12+域清重灌幂等使其良性；结果收敛 |

## 八、零发现负面清单（查了什么、没查到什么）

- 全存储线 SQL 语句逐条过：无任何用户输入拼接进 SQL 文本的路径（唯一插值点 migrator.ts:37 受控）
- 无吞错路径：所有 catch 均重抛或落 loss 台账，无静默 continue
- CHECK 约束无遗漏无多加（6 组全对冻结件；member/session/notification 冻结件本无 CHECK，施工未擅补）
- 迁移列表无跳版/重号（assertWellFormed 守门+实测非连续列表炸）
- 事务配对无泄漏点（四单源码内 begin/commit/rollback 逐一配对；rollback 后连接可复用有实证 test-storage.ts:76-78）
- 四套测试无环境依赖（env 全清连跑两轮一致；无宿主 ~/.cc-deck 触达，driver 套有负向断言）
- 未深查面：better-sqlite3 原生层（绑定参数类型强转行为、WAL checkpoint 时机）依赖驱动默认，未做源码级审查；import-org 三源解析细节归 C1 单评审

## 九、G 回单对照（盲评后补记）

说明：../docs/reviews/2026-10-06-m11a2-worker-g.md 实为 **M11-A2 单单回单**（迁移 runner），非四单汇总评审。对照范围限 A2。

**逐条核验结果（零虚报）**：
- G 申报四条验收——与本人亲跑实证一致：18/18 两轮连跑 ✓、A1 driver 套回归 21/21 ✓、失败注入报错带 `v3(boom)…保留 v2` 上下文 ✓、user_version 回滚仍 2/v2 数据完整/失败版本索引零残留/重跑补差量不丢数据 ✓（对应 test-storage.ts:59-81 断言，逐条在件）
- G「失败注入方法说明」与测试件代码吻合（独立 v2 库注入同版本号坏迁移，:60-67；并如实交代了首轮注入点放错被幂等跳过的修正过程——申报诚实度好）
- G 申报 migrator.ts 69 行与实测一致；test-storage.ts 申报 105 行 vs 实测 98 行（-7，统计口径差，无实质影响）

**口径差一处（G 偏窄、行为偏严，不算差池）**：G 回单说坏列表=「`migrations[0].version !== 1` 即拒」；代码实为 assertWellFormed 逐项校验「从 1 连续升序」（migrator.ts:41-45），测试亦以非连续列表打头实证（test-storage.ts:86）。行为比申报更严，方向安全。

**盲评独立增面（G 回单未覆盖，均已在 §七立项）**：
- P2-2 四测试件未注册 package.json scripts——G 四条验收全绿但未提回归入口缺失
- P3-1 busy_timeout 隐式依赖 / P3-3 catch 内 rollback 二次抛错掩蔽 / P3-4 TEXT PK 可插 NULL / 双连接 BEGIN IMMEDIATE 并发实测 + WAL 跨进程探针复核——G 未做并发与原生层面
- 维度 3 三表逐列对照冻结件实测（G 无 B1 视角的此层验证，test-storage-schema 67 断言已覆盖大半，盲评抽三表为独立复核）

**对照结论**：G 回单与代码零失实、验收申报全部可复现；盲评五维结论与 G 无冲突；P2×2/P3×7 均为 G 回单未及面，非推翻性发现。

m11review done: dims PASS×3 WARN×2, P1×0 P2×2 P3×7, tests 140×2 绿, hands-on 4 组实测
