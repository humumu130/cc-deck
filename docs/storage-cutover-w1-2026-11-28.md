# 存储收口 W1 台账：#292 cutover 四步灰度走完（2026-11-28）

> DEV-39 清单1。#292 四步灰度（session-write.ts:41-47 自规划）本日全部走完，
> **写面单一真相源成立：session 表=直写唯一写者，boot 读源=库行优先**。
> 每步验收数字、快照位、回退演练与根修记录在案。回退通道常设（§五）。

## 一、终态（2026-11-28 12:19 起）

| 面 | 状态 | 载体 |
|---|---|---|
| 读档 | sqlite（表直读） | 缺省（2026-10-06 SQLITE-FLIP 既有态） |
| 写档 | **db**（直写正式态） | `~/.cc-deck/relay-env.json` |
| session 导入 | **off**（直写唯一写者） | 同上 |
| boot 读源 | **db**（库行优先喂 adopt，回放兜底） | 同上 |
| events.ndjson | 纯审计流（R5：审计≠实体） | 定格 |
| 审计归档 | **on**（压缩丢弃段整段落 events-archive/） | 同上，首个压缩窗后出目录 |
| 运行产物 | relay.mjs `a082c909…`（分支 `agent/deck-fixer-3/dev-39`） | 换装记录 §四 |

env 文件（灰度开关面，boot-env.ts 白名单五键；进程显式 env > 文件）：

```json
{"CCR_BOOT_FROM": "db", "CCR_SESSION_IMPORT": "off", "CCR_SESSION_WRITE_MODE": "db", "CCR_EVENTS_ARCHIVE": "on"}
```

boot 证据行（embedded-relay.log，每次重启可见）：
`[storage-boot] 读=sqlite 写=db 导入=off boot=db（env 文件应用 4 键）`
`[boot-from-db] 切源：库 37 行（新收养 10，覆盖 27，runtime 域回放兜底 17）`

**收口红利**：新收养 10 = events 压缩已丢弃的会话自此重启不丢（events 回放时代
每次压缩都在缩面板历史；库行时代全量在库）。

## 二、灰度序与每步验收数字

生产基线（起步态）：test.37 换装后读=sqlite/写=shadow/导入=on/boot=events，
降级 0，wal 活跃。冷备份：`pre-cutover-2026-11-28-b5c47e33.tar.gz`（org+data 98 件
+sha256）＋库快照 `pre-cutover-w1-db-20261128-120255.sqlite3`（8.4MB，41 session/
3802 task 行）。

| 步 | env 变更 | 验收数字 | 判定 |
|---|---|---|---|
| 1 auto 对账哨 | `CCR_BOOT_FROM=auto` | 7 采样：replayOnly 恒 0；statusMismatch 稳态 0（采样 1-4、7），采样 5/6 的 2-3 例均为灰度操作自身重启击杀的会话终结竞态，boot 后自愈至双侧 DONE；dbOnly 8→10 全为昨日 DONE 外部会话（结构性良性类：events 压缩弃、库保留） | ✅ 过 |
| 2 导入闸 | +`CCR_SESSION_IMPORT=off` | 快照 `pre-cutover-w1-step2-20261128-120940.sqlite3`；切换后 75s 观察窗 MAX(updated_at) 04:09:49→04:10:34 持续推进（直写活）；导入器 0 失败域；行数稳 39 | ✅ 过 |
| 3 写档位 | +`CCR_SESSION_WRITE_MODE=db` | /health writeMode=db；boot 行写=db；40s 窗写面活；直写降级告警 0 | ✅ 过 |
| 4 boot 切源 | +`CCR_BOOT_FROM=db`（+归档 on） | 快照 `pre-cutover-w1-step4-20261128-121801.sqlite3`；切源行「库 37 行（新收养 10，覆盖 27，runtime 域兜底 17）」；活会话 3+1 张全在（ext-7a4969/0225e8/bc0cc8/0f6906c5）；T+60s 写面推进 | ✅ 过 |

**对账哨抓出的真雷（本批最重要产出）**：步骤 1/2 间发现 db=WORKING/events=DONE
停滞对——根因：`transition()` 只改内存，终态路径（finishExternal 等）transition 后
不再发 UPDATED 帧 → 直写挂点（emitUpdated 尾）收不到终态；import=on 时代被导入器
投影掩盖，停灌即暴露。根修：直写收口进 `transition()` 状态机单点（分支第二笔
`fix: transition 单点直写`，test-dev39 F 节锚）。修后两停滞行自愈（DONE 落库），
净态采样 mismatch 收敛 3→1（残 1=当次重启自伤行，boot 后自愈）。

## 三、events.ndjson 角色定格（R-9 配套）

- 定格为纯审计流：session 实体态不再从 events 投影（导入停灌），timeline 正文
  仍留 events（R1 拍板：transcript 是消息正文真相）——重连走内存 replay。
- 归档位（history.ts compactEventsFile opts.archiveDir）：挂既有 6h 压缩 tick，
  压缩丢弃段**先整段 append** `events-archive/events-arch-<yyyyMMdd>.ndjson` 再重写
  活文件。seq 连续性零破坏（保留事件原 seq 在活文件、被弃事件带原 seq 入档）——
  这是选挂压缩而非整文件轮转的原因（EventBus.seq 以活文件末行延续）。
- 缺省 off（`CCR_EVENTS_ARCHIVE`），终态已开 on；归档只追加不读回（审计终态，
  重放永不消费）。账目对平由 test-dev39 D 节锁（保留+归档=压缩前、seq 全量守恒）。

## 四、生产换装与回退通道

- 换装：app Resources relay.mjs `5cb464e5…`→`31c7dcd5…`→（根修后）`a082c909…`，
  均备份在 `~/.cc-deck/data/relay.mjs.bak-pre-dev39-*`；SIGTERM 优雅停→Nova #66
  2s 内复活（全程 7 次重启零失败）。版本指纹四处一致 test.37（tauritrust 绿）。
- 回退总闸（任意一步出问题）：
  1. env 级（秒级）：改 `~/.cc-deck/relay-env.json` 对应键回 off/缺省→`kill -TERM
     <relay pid>`→Nova 自动复活。已演练：BOOT_FROM db→events 翻回一次，events 回放
     正常起、库行无损、health 绿（12:19:20）。
  2. 代码级：`cp ~/.cc-deck/data/relay.mjs.bak-pre-dev39-20261128-120301
     "/Applications/CC Deck Nova.app/Contents/Resources/resources/relay.mjs"` +
     删 env 文件 + 重启 relay。
  3. 数据级：停 relay→解 `pre-cutover-2026-11-28-b5c47e33.tar.gz` 或
     `pre-cutover-w1-step{2,4}-*.sqlite3` 回位→起 relay。
- 导入器降格口径：session 域=迁移工具（回退时去掉 off 即恢复投影互覆盖，REPLACE
  幂等）；注记落在 import-session-task.ts 头部【角色口径】节。

## 五、值守面（收口后常态）

- /health `storage` 段：四键档位+降级事实+env 文件应用记录（每请求现算恒真）。
- /health `abi` 段+boot `[abi-sentinel]` 行+patrol `abi-mismatch` 键：构建烙印 vs
  运行时档位错配（11-24 形态）当场报警。
- patrol 轻探针 `storage-degraded` 键：sqlite 降级 5min 粒度 onset-only 触达。
- boot 对账哨继续跑（boot=db 也跑）：dbOnly/replayOnly/statusMismatch 三类差异
  每次重启记日志——statusMismatch 非 0 且非重启自伤类时按「切源风险面」追查。

## 六、已知边界与后续

- dbOnly 单调缓增（events 压缩弃会话、库保留）——良性（=收口红利本体），无需收敛。
- 重启自伤竞态：重启击杀的会话在下一 boot 链收殓前有 ≤分钟级 statusMismatch
  窗（根修后自愈）。极低频（生产重启罕见）。
- relay-env.json 是**生产灰度常设机关**：文件在=四键生效；删文件=全缺省（回
  shadow/events——应急一键回退位）。
- 遗留观察项：backup-pre-cutover.mjs 快照清单不含 cc-deck.sqlite3（本批手工
  .backup 补位）——建议下批把库文件纳入清单（记 DEV-39 回执「新发现」）。

## 七、审查返修批（两路子代理审查后追加，同日）

审查（正方+反方，回执 `artifacts/review-dev39-{a,b}.md`）抓出的问题与处置：

| 级 | 问题 | 处置 |
|---|---|---|
| P1 | test-dev39 C4 平台断言钉真实平台名，CI linux runner 上恒假（首跑 CI 红=实锤） | 改探针哨兵串；返修后 CI test:dev39 success（run 46108257991） |
| P1 | transition 直写在终态字段补写前落库=不完整快照（done_reason/duration_ms/last_error 恒空；BOOT_FROM=db 重启 adopt 整包替换抹掉回放本有值） | flushSessionRow 收口点末笔全量落库（六终态路径；生产已重部署 `8dc14866`） |
| P2 | setExternalStatus 直赋旁路→外部会话状态迁移不落库 | changed 门内补写 |
| P2 | boot 压缩不归档（最大一刀销毁审计段） | rewriteFileArchiving 流式二遍扫归档版重写 |
| P2 | /health 无鉴权暴露 envFile 绝对路径+原始错误串 | basename+reason 截断 160（完整串在进程日志） |
| P2 | lastDegradation 永久 latch（可恢复成因恒假报） | viaReadMode ensureStore 成功清账+恢复行 |
| P2 | 归档失败静默停摆 | 单独 try+warn，压缩中止保审计零损失 |
| P3 | 写放大（翻转+帧面双写）/烙印同机不变量收窄/归档重复追加重试边角/test 锚偏弱 | 记账不阻塞（审查回执在案） |

返修后生产验证：四键终态保持（db/off/db+归档 on）、envFile 只出 basename、
boot-from-db 切源正常（库 36 行收养 10）、test-dev39 45→54 断言全绿。

---
*deck-fixer-3 · 2026-11-28 · 分支 `agent/deck-fixer-3/dev-39`；灰度操作全程快照先行、
每步可回滚；本台账与 relay/src/storage/session-write.ts:41-47 的自规划注释互为对照。*
