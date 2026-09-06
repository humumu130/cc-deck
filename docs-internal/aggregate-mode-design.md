# App 端聚合模式改造设计（#294）

对标网页端多源形态（web-console `ctxs`/`ensureCtx`/`sendCommandTo`/src-badge），expo-app 从"单活跃连接"扩展为
"按源并发的多连接 + 聚合视图"，与单源手动切换并存，opt-in 开关。核心思路：把 store.ts 的单连接状态机
按源实例化（网页端 ctx 同构），快照与命令路由做薄聚合层，UI 只加角标不改结构。

## 1. 连接层（expo-app/src/store.ts）

- 新增 `SourceConn`（对齐网页端 ensureCtx 返回的 ctx）：`{ id, name, entry, ws, channel, lastSeq,
  sessions: Map, timelines: Map, reconnectDelay, reconnectTimer, hbTimer, probeTimer, lastDownAt,
  epoch, pendingCmds: Map, cloudCfg }`；cloudCfg 取自 entry.cloud。RelayStore 增
  `conns: Map<sourceId, SourceConn>`、`activeId`、`aggregate`。
- 现有单连接方法 conn 化（逻辑不变，首参带 conn，`this.ws !== ws` 守卫改 `conn.ws !== ws`）：
  `connect`→`connConnect(conn)`、`connectCycle(ep)`→`connCycle(conn, ep)`、`probeLan`（lastSeq 读 conn）、
  `adoptLan`、`openCloud`、`startHb/stopHb`、`scheduleReconnect`、`onMessage/onEvent/pushLog`、
  `consumePendingByUserMsg`。`killWs`/`sameCloud` 原样复用——#291 幂等按 conn 实例天然隔离，
  所有换连路径必须继续走 killWs（含 probeLan 失败分支）。
- `applyConfig` 幂等逻辑降级为 conn 级（目标 conn 一致且 connecting/online 则跳过重建）；
  `connectServer` 聚合时 ensureConn+connConnect 且不拆其他源、并设 active；`updateServer` 只重连被改 conn；
  `deleteServer` 聚合时销毁该 conn（killWs + 清缓存 + 出 Map）；`loadConfig` 聚合时有 token 的源全部连。
- 开关切换处置（`setAggregate(v)`）：true→逐源建连（active 源被 #291 幂等跳过，不拆重建）；
  false→其余源 killWs + 清 timer，**保留 sessions/timelines/lastSeq 内存缓存**——再开时按 last_seq 续传
  无感恢复，只有 deleteServer 才彻底清。
- 并发行为（#110/#132 历史坑的放大效应）：每 conn 独立 15s/55s 心跳、1s→10s 退避、4s LAN 探测；
  N 源全离线 = N 路探测/重连循环，退避相位天然错峰、总量有界。#291 根因（CONNECTING 期 close 静默
  no-op）从偶发双连放大为必然 N 连——严禁新增绕过 killWs 的换连路径。`resumeProbe()` 遍历 conns 逐个体检。
- CHANNEL 混源：每 conn 独立跑"先 LAN 4s、败转云桥"周期，LAN/云混合是自然结果；deviceKeys 设备级共用
  （同网页端 ckp 跨源共用）。**风险点**：两云源指向同一桥 URL 时同 dev 多 socket，桥按 dev 路由的扇出
  行为需批1实测确认（先验 LAN+云双源主干）。connText 聚合为 `${online}/${total} 在线`。

## 2. 状态层（store.ts / protocol.ts）

- protocol.ts `SessionState` 加客户端侧可选 `src?: string`（relay 不下发，emit 平铺时写入）——
  sid 为 uuid 全局唯一，可作跨源主键。reportedTaskTs/taskSeen/taskViewed 均按 sid 键，跨源无碰撞，不动。
- `Snapshot.sessions` 保持 `SessionState[]` 不变（单源模式只装 active conn 的会话，既有 UI 零感知）；
  聚合时平铺全部 conn 会话并写 src。新增 `sources: {id,name,state,channel}[]`；`connected/connState` =
  any-online 派生（App.tsx 的通知权限/前台服务/hasCfg/AppState 重连均取此口径，调用方零改动）。
- `timelineOf(sid)` 签名不变：内部经 `sidIndex: Map<sid, SourceConn>`（onEvent 增删会话时维护）定位
  conn——DetailScreen `store.timelineOf(sid)` 零改动。
- `send(type, payload)` 路由：按 payload.session_id 查 sidIndex 定位 conn；无 sid（COMMAND_CREATE）→
  active conn。wire() 闭包捕获 conn；`clearPendingCmds`/断连清场全部 conn 级——#244 ACK 追踪语义原样
  （超时重发同 conn 同 command_id，relay 幂等去重兜底）。
- `emitLogFrame` 合帧窗口保持全局一个：多源流式块共用 200ms 窗口，通知频率反而更低。
- `pairCloud()`/`requestPairCode()` 走 active conn（配对是 per-server 行为，语义不变）；
  `saveCloudPairing` 回写时按 conn.entry 定位条目。

## 3. UI 层

- ListScreen `sorted` useMemo：比较器（rank+updated_at 倒序）原样作用于合并列表 = 源内规则保持、
  源间按更新时间全局混排。
- 新组件 `SrcBadge`（ListScreen 内）：复用 `styles.tag/tagExt` 形态（10px 圆角胶囊+描边+轻染底），
  色板沿用网页端 `SRC_COLORS` 8 色 + `srcColor(id)` 哈希取色（每源固定不变）；仅聚合且源>1 时在
  卡片 foot 行左侧展示（标准/紧凑卡同位）。
- 顶栏统计行：counts 聚合全源（数据源已是合并 sessions，原逻辑不动）；connChip 聚合文案
  `${online}/${total}`，配色按 any-online。
- DetailScreen：顶部 sub 行追加 `· ${srcName}`（聚合时）；会话查找 `snap.sessions.find` 与
  `store.timelineOf` 零改动（src 随会话对象携带）。
- 模式开关：SettingsDrawer「显示」区加 Switch（对齐「简洁列表」行样式），接 display-settings.ts 新增
  `getAggregate/setAggregate`（AsyncStorage `cc.display.aggregate`）+ `useAggregate` hook，切换调
  `store.setAggregate`。
- 列表空态（ListScreen emptyS）：聚合且部分源离线时提示 `已连接 ${online}/${total} 源`，引导查设置。
- NewSessionModal：聚合且多源时标题下加"将发送至：${activeName}"（对齐网页端 newTarget 提示）。

## 4. 兼容与迁移

- 默认单源（aggregate=false）：Snapshot.sessions 只装 active conn，全既有行为逐字节不变。
- watch.ts：`flush()` 转发前按 activeId 过滤 snap.sessions（手表协议、快照体积、带宽零变化）；
  `handleWatchCommand` 走 store.send 的 sidIndex 路由，天然到达正确源。
- `ccr_conns`/`ccr_active` 存储结构不动，无迁移；仅新增 `cc.display.aggregate` 键。
- Shell 路由（App.tsx）不动：`store.connect()` 调用点（启动/回前台/重连按钮）在 store 内分发
  aggregate ? connectAll : connConnect(active)。

## 5. 分批实施（每批独立 commit + tsc）

- 批1 连接层：SourceConn 抽取、conns Map、方法 conn 化、setAggregate、connText/connState/sources 聚合。
  验收：tsc 0 错；VM 配双源（同 relay 双条目先行，再 LAN+云异构）聚合全在线、relay 侧连接数=源数无僵尸；
  单源模式回归不变；切开关不重建 active 连接；杀 A 源 B 源不受扰。
- 批2 列表/角标/统计：emit 平铺 + src 字段 + SrcBadge + 统计行/connChip 聚合。
  验收：双源合并排序正确（活跃置顶+全局 updated_at 混排）；角标每源固定色；SessionCard memo 行级重渲
  不回归（双源流式压测不卡返回键，#282 口径）。
- 批3 命令路由+详情页：sidIndex + send 按源路由 + 每 conn ACK + 详情页源标注 + NewSessionModal 提示。
  验收：双源各开会话，消息/审批/删除/重命名均达正确源；断 A 源时 B 源命令照常且 A 源报"未连接"；
  ACK 超时重发不跨源串扰。
- 批4 开关+设置项：display-settings/drawer 开关 + 空态提示 + watch 过滤 + 全量回归。
  验收：默认单源全功能回归；开关状态 AsyncStorage 记忆；手表快照仍单源；按三段收尾
  （3agent 审查 + 测试 + 分批提交）后才标完成。

批1–3 联调期间经 adb 手动置 `cc.display.aggregate=1` 开启（开关 UI 批4 才上线）。
