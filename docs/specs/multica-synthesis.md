# multica 深研四卷总表（PM 汇总·1029）

> 四卷全回：research-multica-mech{1,2,3,4}.md（源码级证据+cc-deck 对照+排产件）｜本表=决策视图

## 一句话总结

multica 用「中心 server+数据库不变式+driver 批处理」三个根本取舍换来了板即真相/零对账/28 工具统一——cc-deck 不抄它的栈，抄它的**不变式纪律、终态合同、fail-closed 语义**；同时它的天花板（活输入止步 turn 边界/审批焊死/无热切权限）精确反证了 cc-deck 活会话路线的独特价值。

## 排产汇总（跨四卷 18 件，按优先级）

### 立即可排（小件，1 worker 1 批内）
| 件 | 源 | 内容 | 量级 |
|---|---|---|---|
| S1 假成功翻转 | 卷一 | 零产出 DONE 判定（复合谓词+320 字符+误报代价不对称）——L-1026-1 直接解法 | 纯脚本 |
| S2 目录锁 | 卷四借③ | dispatch 入口同目录活派单拒单闸——0927 坏包事故闸级根治 | S |
| S3 一致性三小改 | 卷二 P3/P4/P7 | dispatch 世代 CAS/入队幂等约束/IssueSnapshot 基线 | 小改 |
| S4 uncertain 三分 | 卷一 | 写操作超时的正确分类法（云桥/ws 链路通用） | 小改 |

### 中件（随批）
| 件 | 源 | 内容 |
|---|---|---|
| M1 run 机器留档 | 卷四借① keystone | dispatch 终态自动归档三件套+run_ref——虚报事故双证解 |
| M2 板卡唤醒+父子 | 卷四借②④ | wakeup_at+滞留规则/parent_id+折叠（同批） |
| M3 结构化输出帧 | 卷三方案 A | SESSION_USAGE/SESSION_ARTIFACT 帧扩展（vs 侧文件不推荐） |
| M4 claim barrier | 卷一 | 热部署优雅等待窗（两级空闲检测+CAS）——#296 姊妹批 |
| M5 双活 SQL 防 | 卷一 | NOT EXISTS 内嵌拒并发——#257 TOCTOU 消法 |

### 与 PRD 合流
- 装配探测做厚（B3=multica runtime 探测范式）→ PRD X0
- awakeclock 挂起感知计时 → 巡检域改造
- token 轮换（B5）→ PRD 4.5

### 大方向（拍板级）
- **ACP 引入第三族**（卷三）：jsonl 升级路径+request_permission 桥审批卡=差异化机会；不动 Claude 主引擎
- 全局任务池/跨机执行（PRD 开放问题 5/6）

## 不借清单（四卷一致维持）

Postgres 栈/无头 run 替代活会话/SaaS 账号全量/webhook 公网入口/自定义字段/labels-workflow/Chat 糖/Squad 分工（现密度不够）——各附不可辩驳理由（详见卷四 §6-7）。

## 方法论沉淀（进经验库）

- 审多写口一致性先找 SQL 层不变式（约束/唯一索引/CAS），应用层检查只算第二道
- 调研大库 schema 用 sqlc 生成模型+queries 权威，migrations 只做语义溯源
- 终态 fail-closed 合同：干净退出≠完成/叙述不当终答/terminal_reason 优先
