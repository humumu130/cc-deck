# cc-deck 存量实现审计（vs V2 底座）—— 三 Agent 并行审计汇总

> 2026-09-22。审计问题（用户原话）：「已实现的东西，实现方式合理吗？就算当前合理，对未来新底座来说，还合适吗？有需要修改的吗？」
> 分工：A = relay 核心底盘 / B = 业务链路与工具链 / C = 前端三端。并行独立审计后，承重主张逐条对源核实（B 5/5、A/C 抽核 6/6 坐实）。
> 配套：`v2-system-design.md` 0.5 已吸收本报告第四节反哺清单。本文件是存量侧的权威记录，行号为 2026-09-22 工作区。

## 一、总判断（三家合并）

**留管道、换脊柱、先改心跳。**

- V1「事件流 = 状态真相」前提下，存量实现质量是高的——纠错注释密度（#53/#72/#82/#109/#144…每条都是实跑事故沉淀）说明正确性资产很多，不是草稿代码
- **管道层与新底座无结构性冲突，整体带走**：EventBus 广播面、cloud-client（云桥零改造实证）、injector、agent-adapter（= ClaudeCodeAdapter 基座，六能力已覆盖 3/5/6 大半）、task-store（= 对账真相源现成件）、连接层全家桶（多源状态机/E2E/断线自愈/LAN-first）
- **脊柱层必须按 M1① 一次换掉，不能渐进**：history 回放路径、≥12 处散落文件态、全量状态入事件——中途任何「先在旧脊柱上兼容新事件类型」的投入都是双倍成本
- 最优先的一行级改动：SESSION_HEARTBEAT 改 emitTransient

## 二、三分类总表（按域）

### relay 核心底盘（A）

| 模块 | 判定 | 要点 |
|---|---|---|
| event-bus.ts | 需改（角色收窄） | 管道接口整体留用为广播层；退役其「重放真相」角色与运行期同步写盘（:43 每事件 appendLine 含心跳） |
| history.ts | **重做** | reduceHistory 闭世界 switch（:203 `default: break` 静默丢未知类型）——回放路径随 M1① 落库整体下线，非扩桶；`deriveTitle` 可留 |
| index.ts | 需改 | :240-243 启动重放重建随 DB 消失；:37-51 单实例锁健康，嵌入式已兼容 |
| config.ts | 保留 | token/目录是进程配置非实体态，本就不该进库 |
| session-manager.ts | 需改（大拆） | 2542 行巨石：会话态+5 组文件态助手+28 命令+看门狗+双轮询；watchdog/unacked 账/streamGen 守卫等正确性资产搬进编排层，不是重写 |
| task-store.ts | 保留 | 对账真相源指定部件，null/[] 语义分明，补 file id+mtime 幂等去重即可 |
| bridge.ts | 需改（分层） | 机制保留（外部会话的事实 Adapter）；~25 个内存 Map 重启即失（watchdog 信号要穿一条落库路径）；转录尾读 512KB 增量窗口合规，replayArtifacts 全文件扫违规 |
| ws-server.ts | 需改 | :52-80 COMMAND_TYPES 是 types.ts 手工重复闭集；/api/deliver、/api/acceptance、/api/notify 实为板命令面雏形，M1② 并入统一 API 面 |
| agent-adapter.ts | 保留 | = ClaudeCodeAdapter 基座；stop() 先 deny 后 interrupt 的 250ms 时序等纠错原样带走；缺 spawn-record 落库（采集点现成 :265-277） |
| acceptance.ts | 需改（换存储） | 安全口径原样迁移；rows 按 i 索引+task 自由文本的结构差已由 V2 D8 覆盖 |
| cloud-client.ts | 保留 | 云桥零改造成立（:353-395 与 LAN 同源纪律已制度化） |
| injector / artifacts / cron / title-gen / summarizer / proc-tree / uploads | 保留 | 各自独立价值；TaskTracker 就是「CC 侧任务投影」构建器 |
| todo-hidden.ts | 需改（微） | :8 模块相对路径不吃 CCR_DATA_DIR，打包形态落点漂移 |

### 业务链路与工具链（B）

| 链路 | 判定 | 要点 |
|---|---|---|
| 验收表单 | 保留为主 | 安全口径四件套、单 HTML 表单、#138 回填回流全保留；**需改**：行号 i 无 `< rows.length` 上界（:82）、results.json 非原子写+无上限追加（:90-102）、提交零事件（审计无痕）、全目录扫 |
| deliver 登记链 | 需改 | API 形状/幂等/cwd 归因保留；deliverables.json（cap 300 静默丢+非原子+双态真相）→ artifact 表；bin/deliver 直读 data/token 入 URL（凭据面越界）→ loopback 网关收口 |
| artifacts 收录 | 保留为主 | 意图声明制语义、白名单/防穿越、自动收录回放挂回全保留；双态真相（内存列表 vs json）是 V2 要切的第二真相 |
| 出单工具 bin/acceptance | **重做（落盘+分发）** | 解析器保留可平移为 sheet.issue payload 构造器；**落盘绕 relay 直写文件**（无事件无校验零感知）；**无分发落位机制**（已两次手工同步实证漂移；build-plugin 不拷 bin/） |
| 插件打包 build-plugin | 需改 | esbuild bundle/版本单源/hook 双形态保留；复制清单与 tauri resources 手工双维护（#150 咬过一次）；guard-*.mjs 源码只存在插件目录（仓中仓孤本）；**bundle 内无 core/扩展边界**——路由注册/事件订阅/自有表三个接缝一个没有 |
| hook 桥 bridge-hook + guard 族 | 保留为主 | 六条链路里质量最高：静默优先、wx 原子锁去重、多 dataDir 回退、重启 3 轮退避、PreToolUse 600s 长轮询、hooks.json 六类挂载点（对账 hook 直接在此扩 matcher） |

### 前端三端（C）

| 面 | 判定 | 要点 |
|---|---|---|
| 连接与游标 | 保留为主 | 多源状态机/relay_dev 身份归并/断线自愈全家桶/云桥 HTTP 长轮询兜底全保留；**需改**：advance-before-process 丢帧窗口（#135 结构根，仅引用）、last_seq 纯内存重启归零 |
| 消息渲染与缓存 | 保留+补 | LogEntry.id 流式原地替换 = message-id 锚的现成积木；artifact 磁盘缓存（文件+索引+LRU+防抖+启动恢复）= 端上消息缓存的克隆模板；**需改**：ScrollView 全挂载无上滑钩子、时间线 cap 500/400 静默丢头；**重做**：COMMAND_HISTORY 全链路（协议无此命令、三端零命中） |
| 会话列表 | 保留+分组重做 | 活跃置顶/密度三档/删除撤销/休眠恢复保留；项目分组需 relay 下发 project_id 后重做（GroupHeader 已弃用，UI 语言重拍） |
| 通知 | **重做** | 无分级通知系统：toast 单例互覆、USER_NOTE 与 PAIRED_DEVICE 同权、TASK_DONE 去重两端双写；taskSeen/taskViewed 水位机制可迁移为 read_at 端上镜像 |
| 导航/rail | 保留 | 单焦点切换与 D7 一致；项目入口端上零准备（前置全在 relay）；「源」维度与「项目」维度正交并存关系待定义 |
| 设置页 | 需改 | 插件页仅 web 有、走 127.0.0.1 HTTP 旁路（手机远程不可管）；三端不齐，V2 扩展注册表 UI 需统一通道 |
| 更新机制 | 保留 | 与 V2 完全正交 |

## 三、高优先发现（核实状态标注）

1. **[高·已核实] 假心跳**：SESSION_HEARTBEAT 是 relay 侧定时器（session-manager.ts:2252），代码注释自证「流断后心跳照跳，与子进程健康无关」（:2262-2263）。双信号三色若把现心跳当活性信号，托管会话系统性误报「活着」。真信号：托管 = childPid 探活/流回调 touch/CPU 采样（#7 看门狗已实现）；外部 = hook 到达 + pid 探活
2. **[高·已核实] 回放路径与新事件类型根本不相容**：reduceHistory `default: break` 静默丢（history.ts:203）+ 压缩吞新类型 + seq 回退——正确解是 M1① 落库后回放重建整体下线，不是扩桶（扩桶=为旧脊柱再造第二套 reducer）
3. **[高·已核实] 文件态全景 ≥12 处，V2 迁移清单原只覆盖 2 处**：session-manager 内嵌五组（child-sessions/deleted-ext/deliverables/title-overrides/pinned）+ todo-hidden + cli-pids + last-cwd + relay-name + config + acceptances/*；其中 title-overrides/pinned/child-sessions 代码注释自证是**权威**非缓存（#53：忙会话改名帧被压缩挤掉，文件才是权威）
4. **[高] 事件携带全量状态是协议级冲突**：emitUpdated 每帧摊 ~15 字段（session-manager.ts:2213-2245）；三端按「增量帧≈全量刷新」消费——DB 切换时事件语义须同步从「状态快照帧」改「实体引用增量」，M1①/M1③ 联动
5. **[高·已核实] 前端红线三处真违反**：ConfirmFloat 正则扫 todos 派生「待确认/待验证」（fmt.ts:34-44——客户端重算业务语义）；任务重排走 prompt 注入「请立即用 TodoWrite 按新顺序重写」（DetailScreen.tsx:1393-1405——CC 专属非结构化通道，板命令面取代对象）；闲置/休眠派生口径两端各自实现无共享常量
6. **[高] 出门回填验收单不可达**：cloud-bridge 白名单无 /acceptance/ 路径（cloud-bridge/src/index.ts:62-103）——联动 O2/#137/#132
7. **[中] 性能铁律存量违规清单**：COMMAND_ARTIFACT_FETCH 内联 readFileSync ≤20MB（session-manager.ts:1724）、bridge replayArtifacts 全文件扫、双轮询每 30s 同步读全部会话 cwd、event-bus 每事件同步落盘
8. **[中] 事件/命令闭集五处联动**：新增一个事件类型要动 types.ts/history×2/ws-server/cloud-client——扩展体系必须以单一注册表为前提（COMMAND_TYPES 手工重复集是反面教材）
9. **[中] 端上缓存三端存储差异被低估**：web 需 IndexedDB（现状零使用，localStorage 顶 5MB 上限）；RN 需文件+索引式（AsyncStorage 整块 JSON 卡 JS 线程）；artifact 缓存是唯一已验证范式
10. **[中] ext- 前缀双态**：桥接会话 `ext-`+sid（bridge.ts:261）vs 托管裸 sid，前缀术散落多处——入库剥前缀 → agent_type + claude_sid 两列
11. **[低] desktop-tauri 是薄壳**：UI 100% 复用 web-console，V2 唯一新增负担 = better-sqlite3 随平台打包

## 四、对 V2 设计文档的反哺（已并入 0.5）

1. §三能力5：Adapter 必须声明**心跳物理来源**（现 SESSION_HEARTBEAT 是假心跳，不得当活性信号）
2. §五前置必改扩为四项：+SESSION_HEARTBEAT 改 emitTransient（一行级，消 ndjson 无界增长主源 + seq 回退尾部场景结构性消失）；+回放路径 M1① 后整体下线
3. §五迁移：文件态全景清单补遗（五组权威文件态入库或明示留文件态）；已知损失补 results.json 多轮历史只读归档/artifacts 手放文件归 default/ext- 剥前缀
4. §五新增：事件语义协议迁移（状态快照帧→实体引用增量，M1①/M1③ 联动）
5. §六：artifact kind=sheet path 措辞改「出单源文件（md）」；O8 历史验收单归宿两案
6. §八：端上缓存细则（三端存储/定序契约「id 幂等去重为最终一致手段，游标仅优化」/SNAPSHOT 恒权威不 merge/getHistory message-id 必须与直播事件同字面/接收侧铁律）
7. §九：O2 注 Android FGS 常驻通知位已被连接保活占用
8. §十：M1② 板命令面收编三个雏形端点；M1③ 验收点补「断连中途杀 App 重启」+ 回放帧宽容解析 + 存量同步读清零
9. §十二：扩展注册表机制（命令/事件类型+schema+处理器一处注册）
10. §呈现纪律：客户端不得 parse 消息内容推语义（ConfirmFloat 动工即拆；TodoWrite prompt 注入被命令面取代）

## 五、现存缺陷移交清单（与 V2 无关、今天就该修）

按地盘归属移交（均对端在途区域，勿重复修）：

| # | 缺陷 | 位置 | 建议去向 |
|---|---|---|---|
| 1 | 回填行号无 `< rows.length` 上界，脏提交可撑爆 done 判定 | acceptance.ts:82 | #126 打磨批 |
| 2 | results.json 非原子写（写一半崩溃=历史清零）+ 无上限追加 | acceptance.ts:90-102 | #126 打磨批 |
| 3 | 验收提交零事件（审计无痕） | acceptance.ts saveResult | V2 迁移时补，或 #126 先补 |
| 4 | 云桥白名单无 /acceptance/（出门回填不可达） | cloud-bridge/src/index.ts:62-103 | #137/#132 联动拍板 |
| 5 | deliver 直读 LAN token 入 URL query | ~/.cc-deck/bin/deliver:11,21 | #131 M1 loopback 网关 |
| 6 | EventBus seq 回退窗口（心跳落盘被压缩裁尾） | event-bus.ts:24-25 + history.ts | V2 前置必改（或独立小修先行） |
| 7 | 假心跳（若 #7 看门狗已防托管侧，外部会话滞留检测仍依赖它） | session-manager.ts:2252 | 与 V2 能力5 一并定 |

## 附：核实记录

- B 五条：ext- 前缀（bridge.ts:261）/ 行号校验（acceptance.ts:82）/ bin 直写绕 relay / 云桥白名单 / 出单 md 已进 artifacts —— 5/5 坐实
- A/C 六条：假心跳（:2252+:2262 注释）/ reduceHistory default 丢（history.ts:203）/ title-overrides 权威注释（:573-576）/ CONFIRM_RE 正则（fmt.ts:34）/ TodoWrite prompt 注入（DetailScreen.tsx:1393）/ lastSeq 纯内存（store.ts:68）—— 6/6 坐实
