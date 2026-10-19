# relay/src 拆分方案（design-split-relay）· 域路之三 · 设计稿先审后拍

> 2026-10-20 · W-SPLIT-RELAY · **零代码交付**
> 对象：relay/src/session-manager.ts（8,684 行，test.45 基线 698bbb2 实查——含昨晚并入的 restart-ledger 接线/dispatch 三分支/回执契约面）
> 与全库方案（docs/design-split-plan.md §3 阶段 2/3/5）的关系：本稿=其 relay 部分的**细化版**（三路域方案并行评审后合并定稿）。

---

## 1. 现状实查

### 1.1 体量与结构

| 指标 | 实数 |
|---|---|
| 总行数 | **8,684** |
| 单 class（SessionManager）方法数 | **~133 个 private/public 方法** |
| handleCommand case 数 | **84 个命令 case**（单 switch） |
| 显式注释分区 | ~22 个 `// ---- 域 ----` 标记（内聚块边界现成） |
| 依赖模块（import） | 60+（types/event-bus/config/各领域件） |

### 1.2 内聚块清单（注释锚实测，含行区间）

| 块 | 行锚（起） | 估算体量 | 内聚度 | this 纠缠 |
|---|---|---|---|---|
| 决策通知账（#018-R1c 产生/生命周期/投影） | :959 | ~400 | **高**（纯账面+投影，B3a 纯函数已外消费） | 低 |
| 引擎登录恢复三面（#102 批C） | :1395 | ~70 | 高 | 低（调 agent/bridge） |
| 复活资格链+激活器入口（W-ACTIVATOR） | :1469/:1517 | ~130 | 高 | 中 |
| 外部会话桥协调（hooks 桥接） | :1548 | ~600 | 中（与 bridge.ts 双向） | 高 |
| 转录/日志投影+收养（adopt/title/deliverables 散布） | :1027-:2100 间 | ~1,000 | 中 | 高 |
| 上下文链（effective/watchdog 挂钩） | :2227 附近 | ~150 | 高 | 低 |
| activity 状态舱（#018 R1a 单写者） | :3528 | ~300 | **高**（单写者批已立） | 中 |
| liveness 门（R3） | :4023 | ~200 | 高 | 中 |
| org 命令咽喉（#018-R1b orgCommand） | :5519 | ~360 | **高**（权限+审计单点） | 中 |
| **dispatch 编排**（dispatchWorker/认领/FIFO 排水/restart-ledger 接线） | :7461 区+散布 | ~700 | **高但热路径** | 高 |
| 分诊引擎（#26 M2） | :5881 | ~500 | 高 | 中 |
| 编制上限/headcount 裁剪（P0 两段） | :7461/:7719 | ~400 | 高 | 中 |
| 两层联动+挂起自动化（#26 M3） | :7828/:8000 | ~450 | 高 | 中 |
| 验收回写 receipt（M12-7 D14/D18） | :5457 | ~60 | 高 | 低 |
| 值守喂活（leader-duty 协调面） | 散布 | ~150 | 高（本体已在外） | 低 |
| 会话 CRUD+状态机+resume/revive 核心 | 散布 | ~1,800 | 核（不拆） | — |

### 1.3 已示范的抽取模式（「新件+接线」四例）

restart-ledger.ts（117 行：save/load+entry 类型，session-manager 4 处接线点）、dispatch-queue.ts（FIFO 持久）、leader-duty.ts（351）、agent-activator.ts（78）、patrol.ts、decision-notify.ts——**模式成熟**：领域逻辑独立件+SessionManager 留接线薄层（import+少量 this 协调）。

---

## 2. 拆分单位设计（目标拓扑）

```
relay/src/
  session-manager.ts        ≤1,500 行核：会话 CRUD/状态机/命令注册表/回调接线
  sessions/
    adopt.ts                收养+title 派生+deliverables 挂回（~600）
    external-bridge.ts      外部会话桥协调（~600，与 bridge.ts 边界再画）
    lifecycle.ts            resume/revive/流代际/互斥窗（~800，核旁最险）
    context.ts              上下文链挂钩（~150）
    liveness.ts             R3 门（~200）
    activity-ledger.ts      R1a 状态舱（~300）
  dispatch/
    orchestrator.ts         dispatchWorker/认领/排水（~400）
    roster.ts               编制上限+headcount 裁剪（~400）
    triage.ts               #26 M2 分诊（~500）
    suspension.ts           #26 M3 两层联动+挂起（~450）
  org/
    command-gate.ts         orgCommand 咽喉（~360）
    decision-ledger.ts      #018-R1c 账（~400）
  acceptance/
    settle.ts               receipt/回写/归因（~150，含 M12-7）
```

接线制沿用 restart-ledger 模式：新件导出纯函数/窄类，session-manager 核以**注入回调**（同 setAuthWatchReadyHook 惯例）或显式参数调用；**不引 DI 容器**（过度工程）。

### 2.1 不拆面

- **命令 switch 骨架**：84 case 留在核（路由分发是单点职责）——case 体瘦身（调用拆出件）
- resume/revive **核心流**（lifecycle.ts 拆挂钩面，流本体留核——#189 互斥窗/流代际是全局态，外移风险>收益）
- types.ts/config.ts（纯声明/既有粒度）

---

## 3. 路线图（风险低→高；每阶段=独立可合并批+测试闸）

| 阶段 | 拆什么 | 测试闸（随拆随保） | 风险 | 量 |
|---|---|---|---|---|
| R0 | 基线固化：全量 139 件跑存输出基线+`check-behavior-parity.sh` | 自身稳定（flaky 件标记） | 零 | 0.5d |
| R1 | **org/decision-ledger.ts**（#018-R1c：最纯的账面+投影） | test-decision-notify（若有）+全量 parity | 低 | 0.5d |
| R2 | **acceptance/settle.ts**（M12-7 receipt，60 行小刀） | test-acceptance | 低 | 0.25d |
| R3 | **sessions/ 三纯域**：context/liveness/activity-ledger（R1a 单写者批边界现成） | test-liveness/test-ctxfix 对应件+全量 | 低 | 1d |
| R4 | **dispatch/roster.ts + triage.ts + suspension.ts**（#26 族：内聚度高、this 面窄） | **test-dispatch（299 断言）**+test-headcount+test-m1-orchestration+全量 | 中 | 1.5d |
| R5 | **org/command-gate.ts**（orgCommand 咽喉：权限+审计单点，动它=动 P81 面） | test-role-templates（116）+test-gatefix+test-bridge 475 认证+全量 | 中高 | 1d |
| R6 | **sessions/adopt.ts + external-bridge.ts**（收养族+外部桥协调：this 纠缠最重） | test-bridge 全量+test-clidead+活体沙盒（askfix-live 同款） | 高 | 1.5d |
| R7 | **dispatch/orchestrator.ts**（热路径本体：认领/直注/换流/排水——**验收期后才动**） | **test-dispatch 299+restart-ledger 件+回执契约闸+活体闭环重跑** | **最高** | 1d |

- 总量 ~7.25 人日；R1-R3 可并行一批；R5-R7 各自独占冻结窗
- **R7 前置硬条件**：dispatch 三分支（W-SCHEDFIX2）+回执契约闸（W-RESTARTDESIGN）**装机验收绿**后才启动

---

## 4. 硬约束（红线）

1. **派单热路径零回归**：W-SCHEDFIX2 三分支语义（新建/直注/换流）+ unacked 账面 + flushResumeBacklog 补投——R4/R7 拆出件**不改任何分支判定逻辑**，纯搬移；每阶段跑活体闭环（沙盒真 CLI dispatch→作答→回执全链）作行为级闸
2. **零新增帧类型**：EventBus 事件词表冻结（拆分不动协议面——SNAPSHOT/SESSION_* 等形状 byte 级不变；端上三端零感知）
3. **bundle 单文件产物不变**：esbuild bundle-options.mjs 参数零改——relay.mjs 仍是单文件产物（Tauri/KV 分发链零波及）；拆分只改源文件布局，构建入口 session-manager.ts 仍被 build-plugin 引用（或显式换 entry+同步 bundle-options，**推荐前者**：核文件保名，管线零动）
4. 测试脚本 import 路径跟改属各阶段批内（139 件中约 40 件引用 session-manager 符号——按导出保持性尽量零跟改：**核文件 re-export 拆出符号**，测试 import 不动）

---

## 5. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| S1 | this 纠缠拆不断（方法互调私字段） | 每块拆前先画 this 依赖清单（本稿 1.2 表已标）；纠缠重的（external-bridge）留核薄壳+逻辑外移 |
| S2 | 热路径回归（dispatch/liveness/值守） | R7 置末+验收期前置+活体闭环闸+299 断言件全绿 |
| S3 | 测试锚大跟改（40 件 import） | 核 re-export 保符号（多数零跟改）；确需跟改的当批完成（四分支重放教训） |
| S4 | 隐式时序（挂表/定时器初始化顺序） | R0 基线含启动日志序列比对；拆出件的 init 挂点集中核 constructor 显式序 |
| S5 | 与业务批并行冲突 | 冻结窗排班（R5-R7 各独占一周该文件）；W-SPLIT 与功能批互斥窗口由 Leader 排 |
| S6 | 拆后长回大文件 | CI 行数闸（>1,500 fail）+ 新件模板含「本件职责一句」头部纪律 |
| S7 | bundle 体积漂移（多文件打包顺序/去重差异） | 每阶段 check-bundle-sync 重建对比闸（三方 SHA）+ 产物 md5 记录进基线 |

---

## 6. 拍板点

1. 目标拓扑（§2 三目录 14 件）与核 ≤1,500 行是否认可？
2. R7（dispatch 热路径）独立置末+验收期前置条件是否认可？
3. 核文件保名（session-manager.ts 继续做 build 入口，bundle 管线零动）vs 换 entry（需同步 bundle-options）——**推荐前者**？
4. R1-R3 并行批合并节奏（一周一批 vs 完成即合）？
