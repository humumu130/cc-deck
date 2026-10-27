# org 多源路由设计（云会话建团落错机器）—— #278 · A 路独立出稿

> **本稿=A 路独立出稿（会话 334aa34d，2026-10-27 用户裁定三路并行），未参考 B/C 路，交叉盲评防趋同。**
> 状态：待 PM 审查 + 用户拍板 · W-OMSR · 基于 fedd93cf 精读（worktree 统一线 fix/engine-chip-slim@03f3bcd2，org/命令面代码与 fedd93cf 一致）
> 事故：1027 公司源（云配对远程电脑）会话自主建团，聊天报「团队已组建」，家面板零变化。

## 0. 根因实证（含一处对任务书的重要修正）

**修正：org CLI 不是裸本地文件工具，是 relay HTTP 客户端。** `~/.cc-deck/bin/org` 末行（L310）：

```bash
exec curl -sS -X POST "http://127.0.0.1:${port}/api/org?token=${token}" ...
```

端口/token 解析链（L37-44）：`CCR_PORT` env → `bridge.json` 的 port → 8787。**打的是本机 relay**。

事故全链：
1. 公司机会话（归属家 org pg-7cb58ab4、经云桥回家上报）跑 `org create`；
2. CLI 按 `bridge.json` 解析出**公司机本机 relay** 端口 → POST 公司 relay `/api/org`；
3. 公司 relay `orgCommand` 咽喉把组写进**公司机 `~/.cc-deck/org/projects.json`**（ws-server.ts:843 HTTP 面 → org.ts store）；
4. 家面板读**家 relay** 的 org → 两机两份 org 数据，永不相遇。任务书称「org CLI 是本地文件工具」在效果上对（写的都是本机 relay 的本地存储），机制上是「CLI → 本机 relay HTTP → 本机 org 文件」。

**关键放大因素**：`agent-adapter.ts childEnv()`（L54-77）给 spawn 会话只注 `PATH/CCR_RELAY_CHILD/CLAUDE_CONFIG_DIR`，**不注 CCR_PORT/CCR_ORG 归属**——远程会话没有任何信号知道「我的 org 在家」。这是缺口的最小根：**会话缺少 org 归属信号 + org 写面只认本机**。

## 1. 现状事实清单（全部代码锚点实证）

| # | 事实 | 锚点 |
|---|---|---|
| F1 | org CLI 全命令面=HTTP POST 单端点 `/api/org`，动作白名单（提案面非决议面） | org L310；ws-server.ts:843-870 `ORG_HTTP_ACTIONS` |
| F2 | relay 侧 org 命令实现完备：`orgCommand` 咽喉（权限矩阵+确认卡+审计）+ boards/experience/rules 同 store | relay/src/org.ts；session-manager orgCommand 分派 |
| F3 | 云桥 router 支持 **rl-→rl- 定向帧**（`handleFrame to:任意 dev`，两 relay 都以 rl- dev 注册桥上）——**relay 间管道今天就在，缺的是协议处理器** | cloud-bridge/src/router.ts:87-150 |
| F4 | cloud-client `onFrame` 现只处理 wb（手机/网页）与 wan 帧——**不识别来自其他 relay 的帧** | cloud-client.ts onFrame |
| F5 | web 面板命令通道已可**显式选源打远程**（COMMAND_ORG_ACTION + #277 wsOverride）——**面板侧建团到远程今天已通** | settings-domain Team.sendCommand；#277 B 组断言 |
| F6 | org 目录全家桶同缺：projects.json/boards/+journal/confirms.json/experience.json/rules.json/dispatch-queue.json/dispatch-log.ndjson 全在 `~/.cc-deck/org/` | `ls ~/.cc-deck/org/` 实证 |
| F7 | 远程会话 hook 事件上报**已回家**（云桥回家=面板能看到该会话及其聊天——事故里 PM 正是在面板看到「团队已组建」） | 事故实证 |
| F8 | `ensureLeader`（PM 值守选举）扫**本机 org** 的编制会话 | index.ts/org.ts ensureLeader |
| F9 | #260 锚点校验是 relay 侧宿主感知（anchorPathError 按平台）——校验的是**收到命令的那台 relay** 的文件系统 | #260 批；board-commands create |

## 2. 方案对比

### A1. org CLI 直连远程（否）
CLI（bash+curl）自带云桥地址与 E2E 凭据直接打远程。否决：E2E 密封（nacl box）在 bash 不可实现；凭据下发到每个远程会话环境扩大暴露面；与「CLI 永远只认本机 relay」的现有安全模型冲突。

### A2. 本机 relay 转发（**推荐，P1 骨架**）
```
远程会话 org CLI →（不变）本机 relay /api/org
  → 本机 relay 检测「该操作归属远程 org」（见 §3 归属判定）
  → relay-to-relay 密封 RPC：{to: rl-家, data: seal({t:"org-rpc", action, payload, src_session})}
  →（云桥定向帧，F3 管道既有）家 relay cloud onFrame 新增 org-rpc 处理器
  → 复用 orgCommand 咽喉（权限矩阵/确认卡/审计全继承）
  → 回执密封回传公司 relay → CLI 打印（含确认卡提示语）
```
改动面：childEnv 注入归属 env（§3）＋本机 /api/org 转发分支＋cloud-client 双侧各一个处理器。org CLI **零改动**。

### B. org 数据双写同步（否）
公司机写本地+异步同步回家。否决：确认卡决议流跨机竞态（两端同时决议同一单）、journal 冲突面大、org 数据本就单写者设计（orgCommand 咽喉），双写破坏单事实源纪律。

### C1. 面板建团路由（已存在，列为对照）
F5：用户在面板建团选「创建到远程」今天已通（#277 正好补齐了显式选源）。**它解决「用户发起」不解决「远程会话 agent 自主发起」**——事故是后者。

### C2. 治理面：禁止远程会话自主建团（否决为方案，保留为开关）
最小改动=org HTTP 面拒远程会话（检测 CCR_RELAY_CHILD+归属 env）。削弱远程自主性、把负担转给用户值守，仅作为 A2 的可选兜底闸（config 开关，默认关）。

## 3. A2 归属判定（设计核心）

**信号源**：家 PM 经云派单/编制远程 worker 时（或远程机配对加入 org 时），由**家 relay 在 dispatch/成员注册链路**给远程会话注入：

- `CCR_ORG_RELAY=rl-<家dev>` —— org 归属 relay 的桥上 dev
- `CCR_ORG_DEVID=<远程机 wb-dev 或 relay dev>` —— 调用方身份（鉴权用）

注入点两处（都要）：① 远程 spawn 的会话 env（childEnv 透传，agent-adapter 拉起时并入）；② 远程机 relay 对该会话的会话记录（CLI 在用户家目录重跑时 fallback 判定）。

**判定规则**（本机 /api/org 入口处）：
1. 无 `CCR_ORG_RELAY` env → 本机 org（现状，零变化）；
2. 有 → 远程 org：走转发。**白名单内的写动作才转发**（P1=project-create/member-add，见 §4）；读动作（status/detail/exp-list）同样转发（否则读也错机）；决议类动作**不转发**（远程会话本就无决议权，与 F1 白名单语义一致）。
3. 转发失败（云桥断/家 relay 离线）→ **明确报错不落本地**：「org 属远程中继 rl-xxx，云桥不通，命令未送达（本机不落盘防脏数据）」——降级明示（任务书 §5）。

## 4. 全链路 × 多源矩阵（用户八点逐条裁决）

| # | 链路点 | 现状 | 裁决 | 设计稿处置 |
|---|---|---|---|---|
| ① | dispatch 派单跨源（spawn 在哪台起/锚点异机不存在） | 派单命令打到哪台 relay，spawn 就在那台起（命令面= spawn 面）；锚点校验按收到命令的 relay 宿主（#260）。远程 worker 接活=活必须派到**worker 所在 relay** | **在范围（P1 边界条件）** | A2 只转发 org 元数据动作；**dispatch 不盲转发**——面板派单已按源路由（F5），远程会话内 agent 的 org dispatch 需拆两跳：org 行（板联动）转发归属 relay，spawn 仍按锚点宿主本机执行 → 设计为「dispatch 动作转发时带 `spawn_local:true` 语义，家 relay 记板/台账、spawn 回执归锚点机」。P1 先只转发「无 spawn 的纯组织动作」，dispatch 留 P2 专项设计（锚点路径映射是独立课题） |
| ② | 板面/收割（org/boards 同目录） | 同缺（F6） | **在范围（P2）** | board upsert/move/del 走同一 org-rpc 通道（P2 批）；收割（harvest）读板动作同理 |
| ③ | 经验库/规则（experience/rules） | 同目录同缺 | **在范围（P2）** | exp-*/rule-* 动作同通道转发（读+写全量；库本身有硬校验，转发层零语义） |
| ④ | 验收单/交付物（acceptance/deliver） | acceptances 是 relay 数据域（家 relay /api/acceptance 面+KV）；deliver=本机 bin 写 artifacts 索引 | **部分在范围** | 验收单回填走家 relay 面（远程会话若需开单→P3 评估同一通道）；deliver 是**本机产物登记**，产物文件本就在生成它的机器上——跨机聚合展示已有（deliverables 看板聚合），**不搬文件只登记路由**：P3 评估「远程 deliver 登记回家」 |
| ⑤ | PM 值守选举归哪个 relay | ensureLeader 扫本机 org（F8）——远程机若有本地组会自己选一个（分裂风险） | **在范围（P1 必答）** | 归属判定落地后：远程机 relay 的 ensureLeader **跳过远程归属会话**（有 CCR_ORG_RELAY 的不参选）；家 relay 选举已把远程编制会话算成员（org 数据在家=天然正确） |
| ⑥ | 聚合视图远程团队入口卡 | **已通**：mergedTeamPayload 并集两源 projects（聚合视角远程团队可见，前提=组写在正确的 relay） | 已通（依赖项写明） | 本设计修好「写落错机」后，聚合展示链零改动即正确；写明依赖=远程 relay 需在线且 SNAPSHOT projects 域到达 |
| ⑦ | 远程会话 hook 上报归属 | **已通**（F7：云桥回家，事件流/快照/上下文全回） | 已通（依赖项写明） | A2 的鉴权信任面建立在此之上：会话身份由云桥 E2E 配对背书 |
| ⑧ | #260 锚点校验跨平台残余 | 校验在收到命令的 relay 执行（F9）——转发后=家 relay 校验家宿主路径 ✓ 语义正确 | **不在范围（写明依赖）** | 转发后锚点校验自然回到归属机，#260 语义自洽；残余（如 UNC 形态）属 #260 自身迭代 |
| 补 | 命令面盘点总表 | — | — | **必须路由（P1）**：project-create、member-add、member-retire、project-status/tier、status、detail、suggest-hold、rate、tag、auth-bypass。**P2**：board×3、exp×7、rule×5、dispatch（专项）。**本地保留（不路由）**：role list/show（只读模板库，本机副本可接受）、exp-import/export（大文件不走 RPC，远程机本地操作+P3 评估聚合） |
| 补 | cron 定时任务/通知 | cron 是 relay 本机域；notify 走家 relay 面 | 不在范围 | 与 org 数据无涉，明示不改 |

## 5. 生效链设计（建团成功 → 面板即时变化）

orgCommand 成功边**已有** PROJECTS_UPDATED / BOARD_UPDATED / ORG_CONFIRM_UPDATED 广播（W-RULES2 同款成功边广播模式）。A2 转发后：
- 家 relay 广播 → 家侧连接（本机 web + 云桥手机/网页）全收 → 团队卡/team-chip/编制即时上屏；
- 公司机面板：聚合视角经两源 SNAPSHOT/增量帧收（⑥ 依赖）；本机视角看不到（正确——组不在本机 org）。
- 头像旗/Leader 螃蟹：随编制数据（PROJECTS_UPDATED 帧带 headcount）自动渲染，零额外设计。
- **新增一帧**：转发成功回执里带家 relay 的 `relay_name`，CLI 输出「已写入 <家源名>」——agent 聊天里可读，防再次误判。

## 6. 安全与鉴权边界

- **通道信任**：relay-to-relay 帧走云桥 E2E 密封（配对身份背书，同 wb→relay 命令面强度）；新增 org-rpc 处理器只接受**已配对 dev** 的密封帧。
- **命令面边界**：转发动作 ⊆ F1 HTTP 白名单（提案面）；决议类（确认卡 ✓/✗）永不接受远程——用户主权面不扩大。
- **org 内角色**：orgCommand 咽喉的权限矩阵照跑（actor=远程会话身份，按其编制角色授权——worker 无决议权等语义继承）。
- **远程设备能操作家 org 到什么程度**：= 持家 relay token 的本机 CLI 同权（提案面）；`auth-bypass` 类敏感动作默认**不转发**（P1 白名单排除，上收面板）。
- **防滥用**：转发动作带 `src_session` 审计行（orgCommand 审计已有 by 字段，扩展记录 via=cloud-rpc）。

## 7. 兼容与降级

- 本机会话（无 CCR_ORG_RELAY env）：行为逐字节不变（判定规则 §3.1）。
- 云桥断：明确报错不落本地（§3.3），CLI exit≠0——agent 可感知重试或上报。
- 家 relay 离线：同上；不提供本地暂存队列（暂存=双写变体，否决同 B）。
- 旧远程机（未升级 plugin/CLI 物化）：无归属 env → 行为=现状（写错机但不崩）——升级随 plugin 分发闭环。
- 回滚：归属 env 不注入即整体回到现状，转发分支死代码化——单开关回退。

## 8. 实施分批建议

- **P1（最小可用=修事故面）**：归属 env 注入（dispatch/成员注册链）＋本机 /api/org 转发分支（白名单=§4 P1 动作集）＋cloud-client 双侧 org-rpc 处理器＋ensureLeader 跳远程＋降级报错。断言：转发往返/白名单拒收/云桥断报错/本机零变化四组。
- **P2**：board/exp/rule 动作并入白名单＋dispatch 专项（锚点两跳设计）＋⑤选举边界全量。
- **P3**：acceptance 开单/交付物登记路由评估＋exp-import/export 聚合＋C2 兜底闸开关。

## 9. 关键疑点清单（拍板点）

1. **远程 worker 的 spawn 归属信号**：家 PM 目前怎么把活派到公司机？（若现状=公司机自主接单而非家侧 spawn，归属 env 的注入点要落在「公司机加入 org 的成员注册」而非 dispatch 链）——需 PM 给一帧现状说明，我方再核 dispatch-queue/编制注册代码。
2. **auth-bypass 上收**（§6）：是否同意 P1 不转发（远程授权跳权限确认回到面板操作）？
3. **dispatch 两跳**（§4①）：P2 专项还是随 P1 简化（P1 直接拒绝远程 dispatch 并报「请在面板派单」）？倾向后者——把事故面之外的动作先显式挡住。
4. **转发读动作**：远程会话 org status/detail 是否也要回家（读错机同样误导）？本设计默认**是**，代价=每次读都走云桥——若云桥弱环境频繁，可加本地 org 只读缓存（P3）。
5. **⑤选举**：远程机 relay 本地若已有存量脏组（事故写错的那份），升级后 ensureLeader 跳远程归属会话，但**存量脏组清理**要不要给一条 `org migrate-to <relay>` 工具命令？（建议给，P1 附带）。
