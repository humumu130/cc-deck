# PRD 审查·A 路架构正确性：多机编排域 v0.1

> 对象：docs/specs/multi-device-orchestration-prd.md ｜ 审查者：A 路（架构正确性）｜ 1029
> 核对基准：cloud-bridge/src/router.ts（全文）、cloud-bridge/src/index.ts、cloudflare/src/worker.ts、relay/src/cloud-client.ts（全文）、relay/src/bridge.ts（ext-input-queue 段）、relay/src/org.ts、relay/src/board-mirror.ts、web-console/js/session-domain.js

**总评**：路由扩展的总思路（复用 dev 路由 + 接收侧零新逻辑面）方向正确、与代码兼容性好，但安全模型建立在对桥侧鉴权/路由能力的三处误读上（L1 配对表不存在、L2 不构成发送方鉴权、定向帧根本无需桥发版），且 §4.8 幂等设计在自设常数下自相矛盾——按 P0 修订后骨架可立。

---

## 事实纠错（PRD 断言 vs 代码事实）

**F-1｜§5「先发 RouterDO（透传新帧）再发 relay」的部署顺序断言不成立——且不需要。**
router.ts `handleFrame` 对定向帧（to=具体 dev）**完全不检查内层帧类型**：router.ts:144-149 只查 `to` 是否在路由表，任何 `{to, data}` 原样透传。PRD 引的「:141 bad frame 口」只作用于**通配帧**（to:"*"）分支（router.ts:115-142，仅约束 disc/pair_req 两类）。xmsg 设计为定向帧 → **现行 RouterDO 与 CF Worker 已透传 xmsg，X1 无需任何桥侧发版**。依赖序该删，X1 依赖简化为「纯 relay 双端」。

**F-2｜§3.2 帧形状与真实协议不符。**
客户端→桥的真实协议是 `{to, data}`（router.ts:101-107 只要求 to/data 两键），`from` 由桥盖戳（router.ts:149），内层类型 `t` 一律放 `data` 里（hello/ping/wan/pair_req 全部如此，见 cloud-client.ts:629-643、770-806）。PRD 画的 `{t:"xmsg", to, from, data}` 信封级 `t`/`from` 会被桥忽略/覆盖——照 PRD 字面实现，接收侧读 `data.t` 落空、自报 from 无效。正确形状：`{to:"rl-xxx", data:{t:"xmsg", target_session, payload, msg_id, …}}`。xack 同理。

**F-3｜§8.6「旧 relay 不识别 xmsg = 零影响」不成立——存在 pair_nack 永久乒乓。**
旧 relay 的 onFrame 收到定向 xmsg 后：非 ROUTE_MISS（cloud-client.ts:551）→ 非 wan/pair_req（:631/:643）→ 落入 :739 peers 查找 → **rl-\* 从不在 peers**（peers 只收配对手机/网页/手表）→ 双身份 unseal 试解失败（:747-757）→ `notifyUnpaired`（:758-762）向发送方回 `{t:"pair_nack"}`（:362-367，60s/dev 限频）→ 对端 relay 收到 pair_nack 走同一路径**再回 nack** → 两 relay 间形成每分钟一来一回的 pair_nack 永久循环 + 双侧持续刷 "drop frame from unpaired dev" 日志。功能无害但非「零影响」，验收点 6 按现文过不了。设计需补：xmsg 发送方对 rl-\* 来源的 pair_nack 静默，或（更好）接收侧在 :739 前加 rl- 分支短路。

**F-4｜§4.1「需在 SNAPSHOT/投影帧透出 origin_sid」前提与代码不符。**
云通道 SNAPSHOT 的 `payload.sessions` 直接携带**源 relay 的真实 session_id**，无任何重映射（cloud-client.ts:487 `withRelaySource(this.mgr.snapshot())` 只加 relay_source 名，不改 id）；端上卡片 Map 就以原 sid 为键（web-console/js/session-domain.js:3345、620）。代码里不存在「投影 id ≠ 原 sid」的重映射层——dd151481 出现在 org.json `leader_session_id`（org.ts:252，relay 本地卡 id）是本地锚问题，不是投影遮挡。**真正缺的是 per-session 的源 relay dev（rl-\*）归因**：sessions 只带 relay_source（显示名），SNAPSHOT 只有顶层 relay_dev 一枚。G2 前置应改写为「投影卡可归因到源 relay_dev」——xmsg 寻址要的 (to=rl-dev, sid) 元组，缺的是前半。

**F-5｜§4.4 L1「云桥配对表（22 台白名单）已有」失实。**
桥侧没有配对表：register 只做 token + dev↔rk 自洽校验（cloud-bridge/src/index.ts:157-161、cloudflare/src/worker.ts:353-354）。「22 台」是 relay 侧 peers（手机/网页/手表↔单个 relay 的配对），**relay↔relay 之间今天零配对零鉴权**。xmsg 的 L1 实际不存在，需从零建（见 P0-1）。

---

## P0（设计错误，必须改）

**P0-1｜xmsg 明文帧在生产公共桥上无法认证发送方——L2（CLOUD_TOKEN+wss）不是发送方鉴权。**
生产桥 cc.humumu.online 是公共 token 桥（cloud-client.ts:848-862 wanStrict 逻辑自证其认知：「公共桥（token 公开，任意人可注册任意 dev）」）。#29 自洽校验只绑定 dev↔rk 的数学关系，**不验证持钥**：攻击者经 disc 帧拿到任意在线 relay 的 (dev, rk)——disc 对任何连接开放且返回全部 rl- dev+公钥（router.ts:123-128）——凭公开 token 重放该 (dev,rk) 注册（router.ts:52-55 同 dev 新连接还顶替踢掉真 relay），即可：
- (a) 以 from=rl-真身 向任何开了 xmsg 的 relay 发明文 xmsg，按 §4.3 直落注入链 = **向对端 CLI 会话（持工具权限的 agent）注入任意文本**；
- (b) 占住真 relay 的 dev 槽，截收发给它的 xmsg。

既有两通道对此的答案分别是 E2E 密封（手机）与 wanStrict 凭据（手表）——xmsg 明文 = 重开 /wan 已堵上的洞。**修法（基建全在，增量极小）**：xmsg 必须 nacl 密封（e2e.ts seal/unseal）发送方 sk → 接收方 rk，接收侧以「能用 from-dev 的 rk 成功解封」作为身份证明——「双身份 unseal 定位」模式 cloud-client.ts:747-757 已有现成先例；rk 经 disc 获取。密封顺带消除内容对桥运营商可见的问题，且使 F-3 的旧 relay 路径变成 unseal 失败静默（无 pair_nack 乒乓），一石三鸟。

**P0-2｜X1「最小闭环」把无鉴权注入面排进第一批。**
L3 白名单/审批全部排在 X2，X1 只剩 L1（F-5：不存在）+ L2（P0-1：不鉴权发送方）——两台机一开 `CCR_XMSG=on`，公共桥上即出现可被重放注册攻破的远程注入口。最小闭环必须内含：发送方鉴权（P0-1 密封）+ 接收侧 rl- 白名单底线（硬编码 allow-dev 列表即可）。否则 X1 不可灰度，「默认 off 的开关」挡不住用户自己开。

---

## P1（应改）

**P1-1｜§4.8 幂等窗口与 outbox TTL 失配 → 双注入窗，验收点 4「无重无丢」在自设常数下不可满足。**
接收侧去重 10min vs 发送 outbox TTL 24h：xack 丢失（发送方恰在对端注入完成的瞬间断线）→ outbox 不删 → 对端下次 relay-online 触发补发 → 若距首投 >10min 去重已过期 → **同一消息注入两次**。修法三选一：① 接收侧去重持久化、TTL 对齐 outbox TTL；② outbox 删除降级为「路由命中即删」，明示接受 at-least-once；③ xack 可补发/重询。

**P1-2｜outbox 补发触发缺「本机重连」腿。**
relay-online 由桥在目标 register 时广播给**当时在线**的连接（router.ts:66-72）；发送方若比对端晚重连，永远收不到对端的 relay-online，outbox 挂死。补：自身 ws open 时对 outbox 各目标试投一轮（ROUTE_MISS 即留队），或发 disc（router.ts:123-128）取在线清单后冲排。

**P1-3｜三远程通道统一性（§7-4 的裁决意见）：统一于「密封 Command 信封 + relay 作为 peer」，xmsg 不另起第三套命令面。**
现状事实：远程审批与手机/网页远程源**已是同一 substrate**——密封 Command 信封 + COMMAND_TYPES 白名单 + COMMAND_ACK + peers E2E 鉴权（cloud-client.ts:45-85、807-818）；W-CROSSQUEUE（bridge.ts:3677-3709）证明注入链对云通道远程输入早已打通。xmsg 若按 PRD 另立帧族（独立 xack/独立 L3 白名单/独立审计），将造出**第三套命令面**：三套白名单、两套 ack 约定必然漂移——本项目已有专门纪律防这种漂移（cloud-client.ts:41-44「与 ws-server COMMAND_TYPES 逐字一致」#117/#212 教训），不该再主动造一个新漂移源。
**裁决**：传输/鉴权/回执层并入既有密封 Command 通道——建立「relay 作为 peer」（一次性 relay 配对，复用 pair_req/pair_ack 范式或新 rl-pair 握手，把对端 relay 登进本机 peers）；xmsg 语义（target_session/origin 归因/断线 outbox）做 payload 级扩展（新 `COMMAND_XMSG` 进 COMMAND_TYPES，白名单/ACK/审计三免费）。真正全新独立的只有 outbox（手机通道无断线排队需求）。三条远程通道收敛为一个模型：**「远程角色 → relay 的密封命令」，差异只在角色（手机/网页/手表/relay）与载荷**。

**P1-4｜接收分支插入点须写成设计约束。**
xmsg 接收分支必须插在 onFrame 的 peers 机制**之前**（cloud-client.ts:739 前），按 `from.startsWith("rl-")` + data.t 分流；落错位即坠入双身份 unseal 遍历 + F-3 的 pair_nack 乒乓。PRD §4.3 应点名此插入点。

**P1-5｜xack 缺失败终态。**
注入链有显式失败路径（bridge.ts:357-360 连续 3 败 given_up、scheduleStuckFail 15s 宽限转败），xack 只有 queued|injected|rejected——补 `failed` 态，否则发送方对注定失败的消息永远停在 queued。

---

## P2（建议）

- **P2-1**｜§7 限速「每对 dev ≤2 条/s」无执行点：桥无 per-connection 帧率限制（router.ts 全文无此逻辑），必须写明在发送方 relay 侧执行。
- **P2-2**｜8KB 上限对 X3 任务书可能偏紧（任务书+验收点+背景常超）；桥侧 MAX_FRAME=8MB（router.ts:18）空间充裕，建议 dispatch 类放宽 32-64KB，或先实测既有任务书 P95 尺寸再定。
- **P2-3**｜`CCR_XMSG` 开关需明确双端语义：接收侧 off 时对密封 xmsg 应回 `rejected:not-enabled`（密封 xack）而非静默——静默会让发送方 outbox 挂到 TTL（且对旧 relay 重演 F-3）。
- **P2-4**｜防转环规则：经 xmsg 到达的 dispatch 任务书，对端 PM 不得再 `--remote` 转发回源机（1-hop 上限），防双 leader 互派死循环（§9-5 相关）。

---

## 对 §9 开放问题 1/2/5 的裁决意见

**Q1（回执回流方向）：裁决「B 机收割 + 摘要回」——对端权威，A 只收摘要。**
依据：org/板 per-relay 本地是本 PRD 明示的非目标边界（§2.2）；worker 回执若直回 A 机 PM，A 的任务账与 B 的板卡构成同一任务的**双账本**——board-mirror.ts:3-6 刚以「唯一事实源强制」军规消灭的同款反模式。附加条件：① 摘要走定义好的 digest 帧（一种 xmsg kind），不是自由文本；② B 无 PM/编制能力时按 §4.5 即时回 `rejected:no-org-capability`，A 不盲等。

**Q2（非文本承载）：首版纯文本正确，上限按 P2-2 分类定档。**
文件/截图坚决不进 xmsg、走既有 artifact 链——同意 PRD 倾向；但 8KB 对 dispatch 任务书是否够需实测（P2-2），这是 X3 前唯一要补的数据。

**Q5（leader 模式跨机语义）：§4.5「PM 是编制内角色非机器属性」原则下自然成立，但有两条实打实的补充义务。**
① 各机各 leader 互不冲突是构造使然（org 锚是本地卡 id，org.ts:252），真正要补的是 P2-4 防转环 + §4.5 已列的「远端 PM」标注；② leader 模式下值守目标=Leader 锚卡（session-manager.ts:4320-4321），与 no-leader（external PM 会话）消化路径不同——X3 的 E2E 验收必须双模式各跑一条，不能只在兼任制验证。

---

## 附：分期修正建议（§6）

| 批 | PRD 原案 | A 路修正 |
|---|---|---|
| X1 | 帧协议+接收口+ccops 发送，依赖「RouterDO 透传先发」 | 依赖删空（F-1）；**并入** P0-1 密封 + rl- 白名单底线（P0-2）+ 接收分支插入点约束（P1-4）+ 本机重连补发腿（P1-2） |
| X2 | L3 白名单+审批+审计+outbox | 白名单从底线升全量；outbox 落地时必须同步修 P1-1 幂等失配 |
| X3 | org dispatch --remote + PM 感知 + B/C | 加 P2-4 防转环 + 双模式 E2E 义务（Q5） |
