# 全库架构拆分方案（design-split-plan）· 设计稿先审后拍

> 2026-10-20 · W-REFACTOR2 · **零代码交付**（本稿=方案，拍板后才实施）
> 缘起：用户多次批评 index-005.html「单文件 1.4 万行全部内联零框架，每句话都很可怕」；session-manager.ts 亦 8.6k 行。
> 数据基线：dev 线 698bbb2（test.45）实查——relay 侧已含 restart-ledger/dispatch 三分支/回执契约闸（昨晚 dispatch 可靠性大改），本稿按当前代码盘点，非旧印象。

---

## 1. 现状盘点（实查 2026-10-20）

### 1.1 巨型文件排行（全库 >900 行）

| 文件 | 行数 | 结构现状 | 职责数（估） |
|---|---|---|---|
| web-console/**index-005.html** | **14,159** | 4 个 `<style>` + 7 个 `<script>` 内联块（script 合计 ~11.2k 行） | 桌面壳全页面：双列布局/会话域/团队域/项目域/设置域/通知/看板/检查器/云桥/更新弹窗/mock 桥 |
| web-console/index.html | 13,251 | 同构（**已冻结退役**，W-P0-FIX 双壳收口） | 拆分对象**否**——按既定口径一个版本周期后删除 |
| relay/src/**session-manager.ts** | **8,684** | 单 class SessionManager + 84 个 command case + ~15 个 `// ----` 注释分区 | 会话生命周期/命令路由(84)/收养/拉活/上下文/派单/决策账/通知/验收/外部桥协调/巡检钩子 |
| expo-app/screens/**DetailScreen.tsx** | 4,525 | 单文件多组件（AskBanner/WaitCard/CtxSegMeter…~30 组件） | 会话详情全页 |
| relay/src/bridge.ts | 3,724 | 单 class Bridge | 外部 CLI 桥接（hooks/pending/收养/晋升） |
| expo-app/src/store.ts | 3,608 | 单 class RelayStore | 多源连接/命令/快照投影/云桥 |
| expo ListScreen/SettingsPage | 2,075/1,809 | — | 列表/设置 |
| relay ws-server/types | 1,355/1,392 | — | HTTP+WS 面/类型 |

**模块生态参照**：relay/src 已有 65 个模块文件（3.2 万行总量）——**拆分惯例已立**（engine-login/engine-auth-watch/patrol/decision-notify/dispatch-queue/context-watchdog 等均为近月从大文件抽出的独立件+配套测试），session-manager 是「最后一个没拆的大山」，不是孤例。测试基建：relay 139 个 test-*.ts + expo 25 个——回归闸充足。

### 1.2 痛点实害（为什么值得拆）

| 痛点 | 实害证据 |
|---|---|
| 合并冲突高发 | 本会话亲历：test-expodomain #92 锚四分支重放（四条 worker 线都碰同文件）；W-CTXFIX 曾预警 test.8 汇集批同文件冲突；W-V8A 批 1-4a 四笔「待收割」部分因同文件排队 |
| 审查/导航成本 | 8.6k 行单 class，任何审查都要 grep 定位；行号锚跨批次漂移（pipeline-audit v2 七处漂移实录） |
| 认知风险 | 单文件改动面不可控——「改 A 域顺手碰坏 B 域」的回归面随行数超线性 |
| 并行上限 | 多 worker 同文件=串行瓶颈，拆分=并行度直接释放 |
| web 端特有 | 内联零模块——CSS/JS 互相全局污染靠人工纪律；用户「每句话都很可怕」的直接观感 |

---

## 2. 拆分目标与原则

### 2.1 目标粒度

| 层 | 目标 | 依据 |
|---|---|---|
| relay .ts | 单文件 ≤1,500 行、单职责模块（命令族/领域一个文件） | 对齐既有惯例（bridge 3.7k 是上限容忍线，新拆件全部 <1.2k） |
| web index-005 | **HTML 骨架 ≤500 行 + 静态资产目录**（css/js 各自 <1k 行/文件，按域分文件） | 保持零构建可直达（见 §4） |
| expo | 单 screen ≤2,500 行、组件级抽离到 components/ | DetailScreen 4.5k 是最痛单点 |

### 2.2 不拆面（防过度工程）

- **已冻结的 index.html**：不动（即将删除）
- **纯类型文件 types.ts**：1.4k 行纯声明无逻辑，不拆
- **测试脚本**：test-*.ts 单件自包含是刻意设计（套件可单跑），不合并不拆散
- **数据/配置 JSON**：不在范围
- **v8 原型 mockups**：设计稿性质，不拆

### 2.3 铁律：行为零变（纯机械搬移）

1. **只搬不改**：每批次 diff 应近乎纯移动（函数原样剪切+import 接线）；任何「顺手改」另开任务
2. **每阶段测试闸**：搬移前后全量测试套件逐 bit 等绿（relay 139 件+expo 25 件）+ tsc/bundle 闸；**行为断言锁**：搬移前先跑一遍全量存基线输出，搬移后 diff 基线
3. **单批次可回滚**：每阶段=独立分支独立提交，出问题 revert 一笔即回
4. **与业务批互斥窗口**：拆分期间该文件冻结业务改动（Leader 排班错峰——拆 session-manager 的周不出会话域功能批）

---

## 3. 分阶段路线图（风险低→高；每阶段=独立可合并批次）

### 阶段 0：基线固化（0.5 天）——零拆分

- 跑全量测试存**基线快照**（输出逐件存 artifacts/split-baseline/）；建 `scripts/check-behavior-parity.sh`（前后 diff 基线）
- **验证标准**：基线脚本自身可重复跑且输出稳定（flaky 件先修或标记豁免）

### 阶段 1：expo DetailScreen 组件抽离（1 天，风险低——纯展示组件无状态纠缠）

- 拆什么：AskBanner/WaitCard/NotifSwipeRow/CtxSegMeter 等展示组件 → `expo-app/src/components/`
- 怎么拆：机械剪切+props 传参（已是无状态/自含 state 组件，依赖面=theme+store.send）
- 验证：expo tsc+全 25 套件+锚套件不回归（mv8a/expodomain 的 detailSrc 锚**需随搬移更新路径**——锚跟改属本批）
- 工作量：~30 组件 × 机械搬

### 阶段 2：relay session-manager **只读域**抽离（2 天，风险中低——纯函数/无状态面先行）

- 拆什么（按既有注释分区，先抽无 this 依赖或 this 面窄的）：
  - 决策通知账投影（#018-R1c 纯函数段）→ decision-ledger-projection.ts
  - 标题派生/overrides 读取（#53 段）→ title-derive.ts
  - 快照裁剪/预算（取证窗口/cap 段）→ snapshot-budget.ts
- 怎么拆：函数签名不变，class 方法改模块导出函数（this 引用改显式参数）
- 验证：relay 139 件全绿+新增三件单测（从既有件抽 case）
- 工作量：~1,200 行出舱

### 阶段 3：relay session-manager **命令路由分族**（3 天，风险中——84 case 按域分文件）

- 拆什么：handleCommand 的 84 case → 按域分 `commands/session.ts / commands/org.ts / commands/acceptance.ts / commands/settings.ts / commands/artifacts.ts`（路由表注册制：每文件导出 `register(map)`，handleCommand 查表分发）
- **dispatch 族保最后**：restart-ledger/dispatch 三支/回执闸是昨晚新改——单独一批且紧跟其验收期后
- 验证：139 件全绿+test-bridge 475 认证件重点跑+行为基线 parity
- 工作量：~2,500 行出舱，session-manager 降至 ~5k

### 阶段 4：web index-005 **静态资产外置**（3 天，风险中——零构建约束内拆）

- 拆什么：4 个 style 块 → `web-console/css/{base,shell,team,dashboard}.css`；7 个 script 块 → `web-console/js/{bridge-core,session-domain,team-domain,settings-domain,notify,update,util}.js`（**普通 `<script src>` 顺序加载，不引打包器**——见 §4 选型 A 案）
- 关键坑防：script 块间有**隐式全局共享**（跨块函数互调/闭包变量）——外置时块序=原序，共享面挂 `window.ccdeck005` 命名空间（一次性显式化，替代隐式全局）
- 验证：双主题 CDP 探针（既有 test-005-* 静态锚需跟改提取源路径）+ 真壳加载走查+file:// 与 http:// 双协议（Tauri tauri:// 兼容性复核——W-BLK3B 教训）
- 工作量：11.2k 行 script 分 7 文件+全局显式化（**最大单批，可再分两子批**：先 css 后 js）

### 阶段 5：relay session-manager **会话生命周期核**瘦身（2 天，风险中高）

- 拆什么：收养/adopt（外部会话段）、autoRevive/激活器协调、上下文链（ctxLimit/watchdog 挂钩）各自出舱成模块（部分已有半成品件可归拢）
- 剩余：session-manager 留「会话 CRUD+状态机+命令注册表」≤1,500 行核
- 验证：全量+活体沙盒（test-askfix-live 同款真 CLI 闭环）
- 工作量：~2k 行出舱

### 阶段 6（可选，另拍板）：expo store 拆分

- 3.6k 行 store 拆 connection/domain-snapshot/commands 三模块——**风险高**（全局单例状态），建议放到有强需求时再动

### 排期与并行

- 总量 ~11.5 人日；阶段 1-2 可并行（不同文件），阶段 3/4/5 串行（各自文件冻结窗口）
- 每阶段结束=一次可发 test 包验证点（结合既有出包节奏）

---

## 4. 技术选型：web 端要不要引构建链（两案对比）

### A 案：**零构建资产外置**（推荐，阶段 4 采用）

普通 `<link>/<script src>` 多文件，无打包器无框架。

| 维度 | 评价 |
|---|---|
| 永不联网约束 | ✅ 零依赖零 CDN（现状约束自然延续） |
| Tauri 壳兼容 | ✅ tauri:// 直读静态文件（现状同构——只多几个文件） |
| 热部署链 | ✅ check-bundle-sync/kv-put 口径不变（只多文件清单） |
| 用户「零框架可怕」的痛点 | ⚠️ **解一半**——文件可读了，但仍是手写 DOM 无组件化 |
| 迁移成本 | 低（纯外置+全局显式化） |

### B 案：引构建链+轻框架（Preact/Vue petite + esbuild/vite）

| 维度 | 评价 |
|---|---|
| 痛点 | ✅ 根治（组件化+模块化+HMR） |
| 永不联网 | ⚠️ 依赖 npm 生态自托管可行（@fontsource 先例），但**构建产物进入发版链**=bundle 同步闸/热部署/KV 分发全链改造（check-bundle-sync 需加 web 产物面） |
| Tauri | ⚠️ 构建产物路径+tauri.conf frontendDist 调整；tauri:// 下 hash 路由等兼容复核 |
| 迁移成本 | **高**（14k 行重写级，非搬移）——与「行为零变」铁律冲突，实际是重写项目 |
| 团队 | ⚠️ 并行 worker 需学框架范式 |

### 建议拍板口径

**A 先 B 后**：A 案立即可做（阶段 4），把「可读性/可协作」拿到手；B 案不在本计划内——若用户对组件化有强诉求，**另立「web 壳重写」专项**（scope=新产品级，不是 refactor）。参照：v8 原型（纯手写）已证明零框架可维护设计复杂度，痛点主要在「单文件」而非「零框架」。

---

## 5. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 拆分期回归（改 A 坏 B） | 行为基线 parity 脚本+每阶段全量闸+纯机械搬移铁律+单批可回滚 |
| R2 | 并行 worker 冲突（拆分冻结 vs 业务批抢文件） | Leader 排班错峰表（哪周拆哪个文件提前公布）；冻结窗口内业务批走「先攒后合」 |
| R3 | 热部署/发版链断（web 多文件后 kv-put/check-bundle-sync 清单漂移） | 阶段 4 前先改两脚本接受文件清单（+manifest）；发一版验证再继续 |
| R4 | 静态锚测试大跟改（139+25 件中 ~30 件锚文件路径） | 跟改属各阶段批内（已有四分支锚重放教训——路径变更一次到位） |
| R5 | script 块隐式全局外置后时序/作用域炸（index-005 最大单险） | 块序=原序死规则+全局面先盘点（阶段 4 第 0 步出 globals 清单）+双协议 CDP 走查+分两子批降爆面 |
| R6 | Tauri tauri:// 对多静态文件路径解析差异 | W-BLK3B 已证 tauri://≈file://；阶段 4 收尾跑真壳（Nova app 加载）验证 |
| R7 | dispatch 族昨晚刚大改，拆早了踩新伤 | 阶段 3 内 dispatch 族**最后拆**且要求其验收期（装机绿）已过 |
| R8 | 拆完无人维护新模块边界（慢慢又长回大文件） | 行数闸进 CI（>1,500 行的 src 文件 fail）+CLAUDE.md 拆分纪律条目 |

---

## 6. 拍板点（提用户）

1. **A 案先行**（零构建外置）是否认可？B 案（引框架重写）是否明确排除出本计划？
2. 阶段排期（~11.5 人日、6 阶段）与冻结窗口排班是否可接受？
3. index.html（冻结退役件）是否随阶段 4 顺带删除（提前一个版本周期的口径可豁免）？
4. CI 行数闸阈值 1,500 行是否认可？
