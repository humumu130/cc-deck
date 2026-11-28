# ci.json 键账审计：80 键「三层皆无」逐键三去向（2026-11-28，DEV-55）

> 执行：deck-fixer-2。基线 dev `ed3439f4`（DEV-42 集成后），worktree `agent/deck-fixer-2/dev-55`。
> 缘起：DEV-53 收割时新发现＋deck-reviewer 独立复核（review-dev53-f88bf9a5.md §五）——relay/package.json
> test:* 键中 80 键不在 matrix/quarantine/watch 任何一层（DEV-38 单源化前历史遗留），「红无人知、
> 绿无人看」，是「CI 红=必有人管」承诺的最后一段盲区。本表为该 80 键的首个全量逐键去向台账。

## 〇、总数对账

| 口径 | 数 |
|---|---|
| 审计对象（三层皆无键） | 80 |
| ① 晋 matrix（自包含，CI 盯守） | **73** |
| ② 入 quarantine（红键定罪，待修复批） | **4** |
| 补位 watch（本地绿、CI 无凭据不可跑） | **3** |
| ③ 死键退役 | **0** |
| 审计后三层账面 | matrix 87→**160**（minMatrix=160）/ quarantine 1→**5** / watch 32→**35**；package.json test:* 200 键三层皆无剩余 **0** |

## 一、方法与证据基线（双轴）

- **轴一·本机 sweep**：80 键顺序全量跑（node v22.23.4，逐键 300s 限时、进程组击杀防 tsx 孤儿互扰；
  worktree 全新检出＋npm install 后首跑，无旧构建残件掩绿）。结果 **75 PASS / 5 FAIL**——FAIL 中
  test:account 系本 worktree 缺 cloud-bridge 依赖（CI 有 `Install cloud-bridge dependencies` 步），
  补装后复跑绿，计入绿键。
- **轴二·剥净 HOME 复跑（CI 无用户态近似）**：绿键以 `env -i HOME=<空目录>` 复跑——绿＝自包含
  （不依赖真实 CLI/凭据/用户态），红/降级＝环境依赖。72/72 候选键全绿＋account 样本轮绿；
  **负向对照**：test:sessions 在此轴红（`Not logged in · Please run /login`）、test:worker-plugins-e2e
  降级 1/4 且挂起——两键真 CLI 依赖实证（marker 静态扫描漏网、本轴捕获，是轴二存在的理由）。
- 辅证：80 文件平台标记扫描（PlistBuddy/osascript/launchctl/darwin 等）零命中；80 根文件递归
  import 精确大小写解析全过（CI Linux 大小写敏感文件系统防线）；/bin/sh 桩（engine-auth/
  engine-adapters 等）与既有 matrix 键 test:codex 同范式；cc-plugins 引用三处中 leader-harvest/
  leader-dispatch 为 in-git 源件，唯 hook.mjs 为 DEV-44 出 git 产物（见 §四 clidead）。

## 二、① 晋 matrix 清单（73 键——双轴绿＝自包含双证）

sweep＝轴一（本机常态环境），scrub＝轴二（剥净 HOME）。分组按子系统，括号内为出处批（git 首录）。

| 组 | 键（sweep/scrub 秒数） |
|---|---|
| 会话/引擎基础 | allow-rules(1.2/1.3)、history-stream(1.1/1.1)、singleton-lock(3.7/3.9)、delidem(7.6/4.6)、todo-env(1.3/1.3)、waiting-deadlock(3.9/3.5)、transition(1.0/1.0)、retired-sessions(5.1/5.2)、session-title(1.2/1.3)、design-docs(1.0/1.3)、board-journal(0.8/0.8) |
| 连接/云/配对 | cloud-reflux(2.7/2.8)、258-pair-selfheal(0.9/0.9)、272-source-name(9.3/9.6，子进程真 relay 回环)、280-conn-page(1.8/1.8)、conn-page-v2(0.7/0.7)、account(5.6/样本轮，进程内 cloud-bridge 回环)、console-guardrails(1.3/1.4) |
| 保活/席位/活性 | 289-detail-keepalive(0.7/0.7)、permerr(3.2/3.3)、seatgate(1.5/1.5)、alivereclaim(3.3/3.4)、reclaim(2.6/2.6)、fc(3.1/3.2)、msp(2.8/2.8)、273-askuser(11.5/11.5) |
| 引擎认证/适配 | engine-auth(2.8/2.8，/bin/sh 假探针)、engine-auth-watch(6.4/6.5)、engine-adapters(10.6/10.4，stub-engine.sh 桩)、multieng(2.7/2.7，纯函数)、t10-login-loop(5.5/5.5，tmux-fake 沙盒) |
| 注入链/hook | hookfail(16.7/15.2，mkdtemp HOME 沙盒)、watchagent(6.6/6.6，无监听 rc=7 设计＝零网络依赖)、clidead 除外（§四） |
| 板域/任务域 | observe3(4.2/4.2)、chainrecall(1.6/1.6)、agent-activator(2.6/3.0)、domstep1(7.4/7.5)、teamvis(1.4/1.4)、brm(1.1/1.1)、planlane(3.1/3.3)、boardtruth7(1.2/1.2)、boardreconr3(1.1/1.1)、headcount 除外（§四） |
| 决策/通知/广播 | decision-notify(4.9/5.0)、decision-ledger(1.1/1.1)、experience(16.7/18.4，S8 fake agent factory)、experience-broadcast(4.2/4.2)、team-rules(3.7/3.7)、rules-broadcast(2.8/2.8)、acceptance(3.1/3.1) |
| 导入/存储族 | sqlitefix(1.2/1.2)、sqlitefix-poison(1.2/1.2)、storage-driver(1.9/1.9)、storage-migrator(1.2/1.2)、storage-schema(1.1/1.1)、storage-checkpoint(1.1/1.1)、import-org-parity(1.4/1.4)、import-dispatch-lesson(1.2/1.2)、import-notification(1.1/1.1)、import-board-task(1.3/1.3)、import-acceptance(1.2/1.2)、import-artifact(1.4/1.4)、recon-autoclose(3.0/3.0)、resume-reboot(3.9/3.9)、d18-five-states(1.4/1.4) |
| 纯函数/静态锚 | worker-plugins(3.0/3.0，非 e2e 件)、artifact-groups(1.2/1.2)、activity-mapper(2.3/2.3)、r1a-activity(2.7/2.7)、r1b-org(4.0/4.0)、orgagg(1.2/1.2)、spa(1.2/1.2)、ui-askrender(1.5/1.5)、win-font-aa(1.0/1.0，源码锚无 Windows 运行时依赖) |

> 晋 matrix 的判据齐套：双轴绿＋平台标记零命中＋大小写解析过＋无外网点＋回环/沙盒形态。
> matrix 87→160（+73），CI 分片同幅增长（公共仓标准 runner，concurrency 组内 cancel-in-progress 已有）。

## 三、② 入 quarantine 定罪表（4 键——丙族表格式：结论/处置/证据锚）

| 键 | 结论 | 处置 | 证据锚 |
|---|---|---|---|
| test:287-pm-keepalive | **锚漂移（乙类）**：P2 移动卡 stTag 锚期望 `["待命","waiting"]`，DEV-40 T4 词表 S2 合法改形为 `["待命","st-standby"]`（灰胶囊），锚未随刷 | 入 quarantine 待锚刷新批（DEV-42 同型流程：修绿→watch→leader 审入 matrix） | 本机 sweep 21/22 过、唯一红=P2；源形对照 web-console/js/mobile.js:35（改形注释在案） |
| test:seatlive | **行为红·语义演进未跟测（丙类候选）**：A/B 组 6 断言红（between-turns 守位/turn-gap 审计/pid 回写/补水自愈），F 组组合链全绿——1106 后席位保活语义演进 | 入 quarantine 待定性修复批（真缺陷 or 有意变更未跟测，DEV-41 同型流程） | 本机 sweep 25/31；首败 A2「pid 死+回合 TTL 内→between-turns 守位（undefined）」 |
| test:headcount | **行为红·语义演进未跟测（丙类候选）**：排队单接续两断言红——队列未排空/第二排队单停 queued | 入 quarantine 待定性修复批 | 本机 sweep 60/62；首败「队列最终排空（实际 1）」 |
| test:clidead | **断链红·DEV-44 产物出 git**：T1-T6b 判活全绿后 readFileSync `cc-plugins/plugins/cc-deck/scripts/hook.mjs` ENOENT——该件随 DEV-44（`3c365e2d`）出 git，新检出无此件，旧机残构建掩红 | 入 quarantine 待断链修复批（修向：锚改 in-git 源件或先构建后引用——DEV-44 消费面口径） | 本机 sweep T1-T6b 全 ok 后崩；git show HEAD 无该 path、主仓残件在（实测对照） |

## 四、watch 补位（3 键——本地绿＋CI 无 CLI/凭据不可跑）

先例：test:ws（DEV-41 迁出注明「需真 CLI 键，仅本地 sweep 可跑」）、test:version-sentinel（DEV-42
迁出注明「macOS 面键 CI Linux 不可跑」）——**绿但 CI 环境性不可跑**的键归 watch（本地 sweep:watch
运行腿盯守），不属 quarantine（红基线定罪台账）。本批 3 键同型：

| 键 | 判定 | 证据锚 |
|---|---|---|
| test:sessions | 真 CLI 会话测试（拉真 claude CLI 等真模型回合；DEV-38 丁族行在案「CI 无 CLI/凭据必挂」） | 本机绿 47.5s；剥净 HOME 红 `Not logged in · Please run /login`＝凭据依赖实证 |
| test:273-askuser-e2e | 真 CLI 双端 e2e 验收件（#273 作答续跑/超时放行/迟到注入；头注自标「手动跑」） | 本机绿 75.5s；设计态排除口径同上 |
| test:worker-plugins-e2e | SDK query options.plugins→真 CLI 加载插件→skill 触发 e2e | 本机绿 26.4s；剥净 HOME 降级 1/4 且挂起＝真 CLI 依赖实证（静态扫描漏网、轴二捕获） |

## 五、③ 死键退役：0 键（判定过程）

- 80 键 npm 注册全在、测试文件全在位（零 MISSING）；无指向已删功能/已删文件的断链键（clidead
  的断链在构建产物引用方式，其判活断言本身仍活）；
- 与既有 matrix 87 键零别名重复（boardrecon/boardreconr3、boardtruth/boardtruth7、280-conn-page/
  conn-page-v2、history/history-stream 均为不同断言面的互补锁，非新旧替身）；
- 退役候选逐一复核（289-detail-keepalive 锁「退役态不回潮」、retired-sessions 锁活功能、
  win-font-aa 锁在产桌面链）均为活锁。
- 结论：**「三层皆无」≠死键聚集，而是未登记的活测试聚集**——退役通道本批未用，DEV-53 闸的
  「退役 NOTE 点名」路径保留给未来真死键。

## 六、minKeys/反向差集护栏（DEV-38 审查 P3.3 同网收口）

`relay/scripts/check-ci-layers.mjs` 补三件（结构面常开×2＋差集×1）：

1. **test:\* 反向注册**：package.json 每个 test:* 键必须三层居其一——新键从创建起必须登记
   （80 键盲区的成因类堵死）；违例 exit 1（键名列点）。
2. **minMatrix 地板**：ci.json 显式 `minMatrix: 160`，matrix 键数低于即红——删键/漏键本地裸跑
   （无 --base）也拦；合法降级须同步显式下调地板（reviewed diff 可见动作）。
3. **matrix 出层反向差集**（--base 模式）：键离开 matrix 必须降级 quarantine/降级 watch/连 npm
   注册退役，三居其一——CI 盯守面不可静默缩水（与 DEV-53/DEV-42 两向对称规则补齐第三向）。

**负例自测实录**（8/8 达标，脚本口径 backup→改→跑→restore）：

| 例 | 操作 | 结果 |
|---|---|---|
| N1 | 删 matrix 键 test:fc（不动地板） | 结构面双红（反向注册 orphan＋地板 159<160）＋--base 红 ✓ |
| N1b | 删基线 matrix 键 test:org（地板抬 200 隔离） | `matrix 迁出规则违背：test:org`（差集规则单独红）✓ |
| N2 | package.json 加裸键 test:zzz-fake | 反向注册红 ✓ |
| N3 | test:fc 降 watch＋地板同步 159 | 结构面绿＋--base 绿（合法降级通路）✓ |
| N4 | 当前态（80 键全落位） | 结构面＋--base 双绿 ✓ |
| N5 | quarantine 摘 test:retired-live | DEV-53 既有规则仍红（回归）✓ |
| N6 | 地板抬 161>160 | 地板红 ✓ |

## 七、风险与未尽项

- **CI 分片 87→160**：PR CI 每 run 分片近翻倍（公共仓标准 runner 免费；每分片设置成本 ~1.5min，
  concurrency cancel-in-progress 已在）。若后续嫌吵可评估分片聚合，属 CI 架构面非本批。
- **watch 35 键本地 sweep 时长增长**：+3 键（47.5s/75.5s/26.4s）≈+2.5min，sweep:watch 900s/键
  限时口径不变。
- **4 红键是欠账不是终结**：287/seatlive/headcount/clidead 待修复批（锚刷新/定性修复/断链修向），
  修绿后按「迁出=入 watch」走 DEV-41/42 同型流程；建议随 DEV-62 尾池或下个 CI/测试面批。
- **P3-乙（DEV-61）顺带对账**：tests/test-c5.ts 无 npm 键不在本批 80 键面（它是「文件无键」非
   「键无层」）；本批 minMatrix/反向注册闸守键账，文件账（无键的孤儿测试文件）仍无机械校验——
   记新发现，见 DEV-55 回执。
