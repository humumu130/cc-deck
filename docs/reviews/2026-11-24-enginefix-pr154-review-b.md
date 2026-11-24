# review-enginefix-B · PR#154 语义/回归+反方追审 回执（路B）

- 任务：t-1a1bf969 · gid pg-7cb58ab4 · 2026-11-24
- 审对象：PR#154（feat/enginefix-qwen-auth-type @529b1175，自 origin/dev @ff5a1fef 切；dev 已领先一笔 18224c30 不相冲突）
- 审查人工作目录：/private/tmp/cc-deck-w-review-enginefix-b-pr-15（feat/review-enginefix-b-pr-15）
- 性质：审查单零改码（任务书纪律）；产出=本回执 + 分支审查记录 + draft PR 意见面

## 审查结论（分级）

**无 P0 / 无 P1 → 放行（PR#154 CI 全绿，可收割）**；P2×2 随批修或入单排产；P3×4 记录。

| 级别 | 编号 | 发现 | 建议 |
|---|---|---|---|
| P2 | P2-1 | 刀A 把 codebuddy 模型错误从「响亮 fail-fast（白名单 throw）」变「静默降级为引擎默认」，回落唯一可察点=relay 进程 console.log（engine-registry.ts:105-107），UI/会话时间线零提示；且分档白名单 CODEBUDDY_MODELS（agent-codebuddy.ts:46-53，help 实勘 17 键）与账号 API 实况有漂移——worker 真机实证（w-enginefix-qwen-auth-type.md）：API 400 回带 16 项为 `hy4flash-free/hy4flash/hy4std…` 系，而白名单含 `hy4free/hy4std/hy3/hy3-x` 系。engine profile 的 model 是自由字符串（settings.ts validateEngineProfile 只验类型不验词表，:124-126）→「API 支持、清单外」的合法模型经派单/profile 路径会被**静默**降级为默认（旧形态至少响亮拒绝暴露漂移）。主路径（新建弹窗）不受影响：模型下拉按 engine_catalog 取数（trae/qwen 禁用只留「默认模型」，codebuddy=白名单），UI 选不出清单外串 | ①回落用户可见化：回落时向会话时间线/卡补一行提示（不止 relay 日志），兑现「不静默」口径；②词表口径拍板对齐（--help 清单 vs API 400 回带清单，以哪个为准需真机裁）——`custom:` 逃生门保留；③可选：对「疑似引擎原生串」（非 Claude 系、非 [1m] 尾）保留 fail-fast，只对全局 Claude 串静默回落 |
| P2 | P2-2 | relay.yml 键数下限闸未随键增抬锚：本笔 matrix/anchored 双列表 56→57 零差（实测 57/57 含 enginefix），但闸仍 `matrix.length < 55`（缺口 2；dev 预存缺口 1），且 OK 日志文案改成「W-ENGINEFIX 补 enginefix 56→57」与实际闸值 `<55` 不符——注释自定军规「键增同步抬锚定值」，文案制造「已抬锚」假象误导后来者 | 闸值 55→57 + 两处文案对齐（一字修，随批顺手） |
| P3 | P3-1 | agent-codebuddy.ts:118 throw 文案「内置 20 个」vs 头注「help 实勘 17 个」矛盾（预存，非本笔引入） | 顺手修文案 |
| P3 | P3-2 | session-commands.ts:83 注释「probe 现算无缓存=登录后下一次创建即恢复」与 engine-auth.ts 45s TTL 缓存语义矛盾（预存漂移；缓存语义本身合理：修复配置后拦截最迟 45s 自愈，注释改一下防误读） | 注释对齐 |
| P3 | P3-3 | qwen env 组合表是上游 0.27.1 源码级手抄（预存设计）：CLI 升级若动 getAuthTypeFromEnv 会造成「探针比 CLI 严」的 fail-closed 假拦截。缓解在位：authFailureHint 运行时兜底 + 45s TTL 自愈 + settings selectedType 显式选型逃生 | 记录性：qwen-code 升版时复对版 |
| P3 | P3-4 | 显示语义变化未入发版说明：codex 新会话 state.model 从「全局模型串（说谎，codex 本不消费）」变「空（卡上只显引擎名）」；qwen/trae 同理。是修正不是回归，但用户可见 | 随发版 notes 提一句 |

## 验收点逐项对账

### 1. 反方视角——试着证明修法是错的

**「全局模型串静默回落掩盖用户意图」：部分成立，可控（P2-1）。**
- 主路径不成立：新建弹窗模型下拉按引擎目录取数（session-domain.js createModelsFor→catalogEntries，:4749-4753），trae/qwen 引擎下拉禁用只留「默认模型」、codebuddy 只列白名单——UI 层面用户**选不出**会被回落的串，回落只吃 relay 侧兜底填充（cfg.model）与存量/profile 路径。
- 显示面不说谎：create() 分档后 state.model=""（与 spawn 同源真值）；卡渲染 `s.model ? " · "+model : ""`（session-domain.js:4315）只显引擎名；模型胶囊 cur=""→显「默认模型」（:2477-2480）。用户看到的就是实际跑的（引擎默认）。
- 残余说谎面=**意图静默调整**而非显示说谎：engine profile/派单带出的清单外串被静默降级（P2-1 展开）。定性：降级后卡片显示真值，用户可察「没按 profile 的模型跑」，但**为什么**不提示（relay 日志普通用户不看）。
- 反方结论：修法方向正确（原形态=UI 显示假串+relay 拒创建，双输），需补「回落可见化」收尾。

**「qwen 前置收紧把部分配置可用用户挡在门外」：不成立（净改善）。**
- 单 env 键形态在非交互 qwen 下**本就必炸**：worker 真机实证 qwen 0.27.1 未选型 `-p` 实炸原文与用户截图逐字一致（「No auth type is selected」）——旧探针假 ready 只是让炸点从「创建前人话拦截+自动拉登录 pane」后移到「spawn 后裸 CLI 报错会话卡」。收紧拦掉的只有「从未能工作」的形态。
- 真·已配置形态全保留：settings selectedType（B2）、QWEN_OAUTH 单键（engine-auth.ts:110 `if (v("QWEN_OAUTH")) return true`——上游「单键即选」语义未误伤）、anthropic/openai/gemini 组合（B4）、凭据文件 oauth_creds.json/google-accounts/aws（B5，登录完成态不误拦）。
- fail-open 精神保留在正确的层：codex/codebuddy spawn 探针故障仍 fail-open 判 ready（engine-auth.ts probeEngineAuthDirect），收紧只砍 qwen 静态判定的假阳性。
- 残余风险=手抄组合表随上游漂移（P3-3，记录性）。

### 2. 回归——显示面与路径覆盖

- **弹窗链一致**：engine_catalog 下发（engine-catalog.ts）trae/qwen models 恒 []（「严禁冒充」既有契约）、codebuddy=[...CODEBUDDY_MODELS]（:117 同源单一事实源）→ 弹窗下拉与 relay 分档同源，回落后 UI 显示（空→「默认模型」/引擎名）=实跑（引擎默认）。✓
- **聚合/派单同走回落**：dispatchWorker 全部落点经 `this.create(..., {engine: planned.engine, model: planned.model})`（session-manager.ts 10840 区双落点）→ create() 分档 → newAgent → createRegisteredEngine 漏斗二次归一（同函数幂等）。✓
- **远程源（LAN/云）**：创建命令落在对端 relay，同代码路径（COMMAND_CREATE→create），合并后自动一致。✓
- **COMMAND_MODEL 无第三通路**：session-commands.ts:356-358 对带 engine 会话整拒（「新建会话时指定」），异引擎无运行时切模型面。✓
- **codex 分支**：engineRaw 含 codex → state.model=""，但 CodexAgentSession 本就弃参 model（agent-codex 头注既有口径），spawn 行为零变化，显示从假串变真值=P3-4 的语义修正。✓
- **zcode 不达分档**：preflightDispatchEngine/settings 面 unsupported fail-closed 拒绝（session-manager.ts:9991-9992）在 create 之前，engineRaw 含 zcode 无实际可达面；createRegisteredEngine(zcode) 返回 undefined 亦无注册定义（test-engine-adapters 有锁）。✓
- **存量卡复活**：resume/fresh/revive 经 createRegisteredEngine 漏斗——存量 codebuddy 卡带异引擎串的 spawn 从「炸未知模型」变「回落默认」，改善方向。✓

### 3. 测试件真实性（19 断言构成）

- **17 行为断言 + 2 接线文本锚**（锚占比 2/19≈10.5%）：A 组 A1-A5 纯函数九例（真参实调）、A7a/A7b **端到端**（假 bin 过 preflightEngine X_OK→createRegisteredEngine→真调 buildArgs 断 argv 无/有 --model——最有价值件）、A8 白名单透传；B1-B5 探针五态（空 home/settings 选型/单键实锤形态/三键组合/凭据文件，真文件真 env 操作）、B6/B7 pattern 双向。
- 两文本锚均**唯一匹配不空转**：`resolveForeignEngineModel(engineRaw, rawModel)` 在 session-manager.ts 恰 1 处、`needs_auth: true` 在 session-commands.ts 恰 1 处（实测 grep count=1）——锁「接线存在」而非锁实现细节，A9 防 create() 分档被误删、B8 防 #102 闸被拆，合格。
- 可接受缺口：create() 分档无行为级断言（A9 文本锚补位）；回落 console.log 无断言（日志面非契约）；zcode 分档无断言（不可达面）。
- test-engine-auth.ts 三断言翻面（P3c/P3c'''/P3c''''' ready→needs_auth）与新语义一致，P3c'''' 三键组合 ready 保留；env 清场单扩七键（ANTHROPIC_BASE_URL/MODEL、OPENAI_BASE_URL/MODEL、QWEN_MODEL、GEMINI_MODEL、QWEN_OAUTH）——密封修复本机 bigmodel 路由 env 染色问题，restoreEnv 恢复口径正确（undefined→delete）。

### 4. 回归面复跑（本审查独立执行，非转抄 worker）

- `tsc --noEmit`：0 错
- test:enginefix **19/0**（新锚件）
- test:engine-auth **42/0**
- test:engine-adapters **54 pass**
- test:multieng **34/0**
- test:codex **100 pass**
- test:engine-auth-watch **27/0**
- PR#154 CI **全绿**（matrix-guard pass + 全矩阵 relay tests pass，含新 test:enginefix；`gh pr checks` 0 非 pass 行）

### 5. 回执与交付

本回执 + 分支审查记录（docs/reviews/2026-11-24-enginefix-pr154-review-b.md）+ draft PR（见交付节）。审查单零改码——PR#154 的代码未动。

## 正面确认清单（审查核实过的安全面）

- registry 定义仅 trae/qwen-code/codebuddy 三引擎，createCodeBuddyAgent 等工厂零旁路直调（全仓 grep 无生产旁路）——漏斗「全 spawn 入口」声明成立
- `credentialCandidatePresent` 死代码清除后零残留引用
- buildArgs 白名单 throw 保留为末防线（agent-codebuddy.ts:117-118），漏斗归一后正常链路恒不触发
- worker 回执关键声明交叉核实属实（真机三发、双列表 56→57、预存红归属另报）
- 预存红四件（75r-engine-catalog S4/p9-killswitch/snapshot-parity/005-cloud ⑦）worker 已归属非本批，与本审查不冲突

## 遗留

- P2-1/P2-2 修法建议见上表（P2-2 可随收割批顺手，P2-1 的词表口径需真机拍板，建议入单）
- P3-1/P3-2 顺手修候选；P3-3 记录性（qwen 升版复对版）；P3-4 发版 notes 候选
- 词表漂移与 UI 按引擎列模型的加分项（#101/#110 基建在位）worker 已另报，与 P2-1 同根，可合并排产

## 交付

- 回执：~/.cc-deck/artifacts/w-review-enginefix-b-pr-15.md
- 审查记录（分支内）：docs/reviews/2026-11-24-enginefix-pr154-review-b.md
- draft PR：见本分支 draft PR（链接随 PR body 与 artifacts 回执同步；审查记录不预编号）

结果：PR#154 追审（路B）放行——无 P0/P1，语义/回归/测试件真实性/回归面四维全过；反方主发现=刀A 静默降级×词表-API 漂移叠加（P2-1）+CI 下限闸未抬锚文案失真（P2-2）｜改动文件：docs/reviews/2026-11-24-enginefix-pr154-review-b.md（分支审查记录；relay 代码零改）

经验：分档回落类修复的反方审查先钉「清单外串的真实可达面」——UI 下拉白名单封死主路径后，残余面往往缩到 profile/派单带出的自由串，定级从「说谎」降到「意图静默调整」要靠渲染链逐点核实（#practice）
