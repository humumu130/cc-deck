# M11-REVIEW3 盲评回单：E2 值守护栏 + D2 派单经验导入器（worker-K）

> 2026-10-06。方法：四份靶子独立通读→五维+特检推演→/tmp node 实测取证（六场景）→固化独立稿→**然后才读**两份归档回单对照。不改代码（P2 也不改，等 Leader 拍板）。
>
> **亲跑记录**（env 全清 -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE）：duty-boundary **32/32**、import-dispatch-lesson **36/36**、十一套回归零退（21/18/67/34 + 39/55/33/46/38/37）、`npx tsc --noEmit` 全项目 0 错（末次读文件之后）。实测脚本 /tmp/k-review3-d2.ts、k-review3-r.ts（已删）。

## 一、五维·E2（port.ts DUTY-BOUNDARY 注记 + test-duty-boundary.ts）

①**边界错误面**：三零边界静态（S1-S4 表/索引/迁移名清单、S5 EventType 联合段、S6/S7 纯函数出口、S8 bus 全文、S9 注记在位）+运行（R1 库内 17 表、R6/R7 零文件副作用）双面闭环；S1 硬编码 15 表=冻结件锁死（未来加表真红=护栏意图）。**三零断言是真锁**：静态面锁三处源码词面+运行面锁 sqlite_master 与 dataDir 清单，漏报方向最大洞只有 S5 截断（见 T4）。
②**并发重入**：非本件靶面（护栏件无重入态）；两轮连跑（runOnce 结构）覆盖的是幂等观测。
③**数据正确性**：R2-R5 纯函数跑轮四类判定/K=3/回执/策略各有 fixture 锚；port.ts:6-19 注记亲验在位，三零理由+「破界先改规格再改注记与测试三处同步」指引齐。
④**测试质量**：32 断言无恒真；runOnce×2 全新 mkdtemp 复跑=范式正面样本。
⑤**安全面**：mkdtemp+rmSync 零残留；fixture 只读。

## 二、五维·D2（import-dispatch-lesson.ts 494 行 + 测试 36 断言）

①**边界错误面**：坏行五词表全对号（实测亲验：dispatch 源 6 账含物理行号 :8/:9 悬空、:13 bad-json、:12/:14 missing、:15 词表外；boards 源 7 账同精）；FK 倒序清域（lesson 先 dispatch 后）+全库 foreign_key_check 三点断言。**例外见 P2-1**（一类坏行走成了硬炸而非 loss）。
②**并发重入**：批间中断续跑（cp 五元组自洽 offset 落后→restoreSegs 从表恢复段链→仅续余行，r3 实测覆盖）✓；失效重放（mtime 变→两域联动、确定性重建，r4/r5/r6）✓；同源进程级并发=全导入线 B2 范式共性边界（单进程单线程假设），非 D2 特有缺陷。
③**数据正确性**：段链收敛语义（status=末行/created_at=首行/receipt=末个非空 COALESCE(NULLIF)/attempt+parent 派生）fixture 锚齐；归因两分法（常态 NULL 不落账/显式悬空 NULL+账）与 D1 同款亲验一致；tags 洗刷同 addLesson 口径。**P2-1 与 P3-2 例外见清单**。
④**测试质量**：36 断言全实数（行号:reason 精确匹配）零恒真；fixture 双轨造态（真写 appendDispatch/addLesson + 手搓脏行）是好手法；cp 手拨五元组自洽造真实崩现场（r3）是教科书级。形式面两处弱化备案（见 P3-6）。
⑤**安全面**：mkdtemp×2+自清理零生产触达；excerpt 截 200；无 crypto/子进程/网络。

## 三、特检 T1-T4

**T1（段链唯一可辩护读法）**：行序终态切分在三个边角下**稳**——①终态→非终态→终态（d-retry 轨迹即此形态，rt2 attempt=2 断言在）；②跨批断点落段中（r3 offset=10 续跑，restoreSegs 从表恢复段 1 终态→正确开 #r2）；③restoreSegs parent 回溯**不猜 #rN 尾缀**（root 沿 parent 链归位，源 id 恰带尾也正确）+guard 1000 防环死循环。**残余面两处**：环链 break 落假 root→segs 键分裂（P3-3）；派生 id 与源既有 id 碰撞→批硬炸（P2-1，实测坐实）。
**T2（清域单次+联动）**：cleared 首批单次✓（注释给出理由：每批清会删前批父行→跨批段链 FK 炸+静默丢行；r5 batchSize=2×17 行实测行数不变）；dispatch 失效⇒lesson 必重灌✓（replay 与段 2 共用 cpLog===null 判据）；boards 失效⇒仅 lesson✓。跨批父行存活性✓（首批提交后续批增量）。**空文件/缺文件/缺目录三态实测**：空文件首轮清域+cp(offset=0,lineCount=0) 落位、二轮快进✓；缺文件 dispatch 域保留✓但 lesson 联动重灌+rescanned 恒报（P3-2）；缺目录=空目录语义（cp mtime=0/count=0 自洽快进，J 备案同口径）✓。
**T3（私有 observeNdjson）**：:86-95 与 D1 逐字同构、定序已对 stat-先-read，无正确性问题。UTIL（225a895）已收敛六件，D2 为第七持副本者——**P3 记一条：下批随六件统一回迁**（与 J 备案 4 同口径，双方一致）。
**T4（E2 词面稳健性）**：S1-S4 为**清单级**词面（断言枚举对象而非源码 grep）——不误伤、未来合法 duty 命名真红=护栏意图；S5 EventType 切片 `indexOf(";")` 实测当前 union（跨行 | 列表）段内恰 1 分号切片正确，**未来 union 内行注释含分号会提前截断→漏报 duty 词**（安全洞方向，P3）；S6 `/^import\s/m` 块注释行首 import 假红、S8 bus 全文 /duty/i 注释假红（均误伤方向不漏，P3）；R6/R7 副本断言为文件名清单级——「轮中写+删同批」漏检，但 S6 已静态证纯函数零 import（无 fs 能力），R6 属纵深冗余可接受（P3 备案）。R7 名字断言+清单对比**真锁** duty-rounds.ndjson 不落地。

## 四、双口径差异表（读归档后对照）

**我看到了、施工方没报**：
1. D2 派生段 id 主键冲突→批硬炸（P2-1，实测；J 未提）
2. D2 restoreSegs 环链 guard 假 root 分裂无账（P3-3；J 未提）
3. D2 续跑路径 lesson 联动缺口→sdi 归因陈旧面（P3-4；J 的联动规则只覆盖失效路径）
4. D2 缺文件稳态下 lesson 域每次调用重灌+rescanned 恒报（P3-2；J 备案 3 只说「不清域不落账」指 dispatch 域，lesson 联动面未提）
5. D2 rescanned 虚报：**与 J 自述「动态构建…不虚报」直接出入**——实测 boards 失效轮 rescanned=[log.ndjson,boards] 而 dispatchProcessed=0（:460 无条件 push）（P3-5）
6. E2 词面脆弱三处（S5 截断/S6 假红/S8 假红）+R6 清单口径+R2-R5 的 process.cwd() 依赖（P3-7/8/9/10；H 未提）

**施工方报了、我没看到/修正我判读的**：
1. **J 披露「写侧真实重投（org.ts:4476）用全新 randomUUID 独立成行、行间无关联键」**——T1/P2-1 定级关键输入：段链是防御性兼容路径而非主路径，派生 id 与源 id 碰撞概率≈uuid 空间级。P2-1 维持（范式违背硬事实+实测真炸）但注明现实触发概率极低，修法轻（派生前查表转 loss 或 INSERT catch UNIQUE）。
2. J 备案 3「boards 目录缺失→count=0 失效→lesson 清空」与我 S4 实测一致 ✓。
3. H 自评 S6「强于任务书口径」（零 import/require 而非仅不引 bus/storage）——认同，纯函数零 import 使 R6 纵深冗余成立。
4. J 自述「两轮一致」=外部连跑两遍（测试内单轮多相 r1-r7）；E2 为测试内 runOnce 结构——两种形态均达成两轮一致，我 P3-6 相应弱化为形式差异备案。

**双方一致**：清域单次理由（跨批父行存活性）、T3 回迁口径、缺文件 dispatch 域不动作、缺目录=空目录。

## 五、分级发现清单

**P1：零。**

**P2（1 条）**
- **P2-1** `src/storage/import-dispatch-lesson.ts:248`——派生段 id `${e.id}#r${nextAttempt}` 前无存在性检查。复现：源四行=①`{id:"x#r2",dispatched}` ②`{id:"x",dispatched}` ③`{id:"x",done}` ④`{id:"x",dispatched}`→行④派生 "x#r2" 与行①主键冲突→`UNIQUE constraint failed: dispatch.id` **抛错批回滚**（实测）。违背范式五要点第 4 条「坏行 loss 不阻断」（应 bad-field/duplicate 拒行落账）。缓解：J 披露写侧重投=randomUUID 新 id，现实触发概率极低；修法轻（派生前查表→dangling/duplicate 账拒行，或 INSERT catch UNIQUE 转 loss）。**等 Leader 拍板是否派修**。

**P3（10 条）**
- P3-1（D2，回迁）`:86-95` observeNdjson 私有副本——随六件统一回迁 import-util（T3，双方同口径）。
- P3-2（D2，口径）`:464` 缺文件稳态（lines=null→cpLog=null）每次调用触发 lesson 域清重灌+rescanned 恒报——「缺文件不动作」口径在段 2 条件开洞（实测删文件后 skipped=false、dispatch 保留✓、lesson 重灌）。幂等无损。
- P3-3（D2，数据）`:170` restoreSegs guard break 落假 root→segs 键分裂，attempt 推导靠环迭代奇偶（实测 c1 环续跑碰巧 attempt=3 parent 对；换构造可能 segs.get=undefined→开段 1 INSERT 冲突炸批）。环=外部篡改态，防死循环目的达成，坏数据行为未定义且无账。
- P3-4（D2，联动）`:464` 续跑路径（cpLog 有效 offset<lineCount）产生新 dispatch id 时 boards 命中则 lesson 不重灌→板内 sdi 引用新 id 归因陈旧（已落 NULL+dangling 账不重算）。append-only 语义可辩护，乱序罕见。
- P3-5（D2，返回值）`:460` 段 1 无条件 push rescanned——dispatch 跑完态+boards 失效时零处理仍报重扫（实测 boards 失效轮 rescanned 双源、dispatchProcessed=0）。与 J 自述「不虚报」出入，消费方只读 skipped/counts/loss 故无实害。
- P3-6（D2，测试）形式面：两轮一致靠外部连跑（测试内单轮多相）；env 只 set CCR_DATA_DIR 无清污染断言（F1/E2 有）；r7 boards 失效未断 rescanned 单源。
- P3-7（E2，词面）`test-duty-boundary.ts:52-54` S5 切片 `indexOf(";")`——union 内行注释含分号会提前截断漏报 duty 词（当前 types.ts 格式健康：跨行 | 列表段内恰 1 分号，实测）。
- P3-8（E2，词面）`:60` S6 `/^import\s/m` 块注释行首 import 假红；`:67` S8 全文 /duty/i 注释/未来合法 duty 词假红——误伤方向不漏，护栏脆弱非错误。
- P3-9（E2，口径）`:104-106` R6 文件名清单对比不含 mtime/内容——「轮中写+删同批」漏检；S6 已静态证零 fs 能力，纵深冗余可接受，备案。
- P3-10（E2，环境）`:29-30` R2-R5 fixture 经 process.cwd() 解析 tests/fixtures/——npm run 口径 OK，仓库根直跑 tsx 会炸。

**positive**：E2 注记段（port.ts:6-19）三零理由+破界三处同步指引是范式级文档；D2 fixture 双轨造态/cp 手拨五元组自洽/loss 行号级对号/foreign_key_check 三点是测试范式正面样本；J 回单的写侧 randomUUID 披露与清域单次理由披露质量高（直接支撑盲评定级）。

**结论**：两件均可收（无 P1；P2-1 触发概率极低且 fail-fast 语义下不产生脏数据——批回滚保旧快照，等 Leader 拍板修法）。E2 三零边界真锁；D2 主路径（段链/清域/联动/续跑）实测行为与回单口径一致，除清单所列备案面外无异议。

worker-K，等 Leader 核验。
