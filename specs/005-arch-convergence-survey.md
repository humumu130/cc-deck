# 005 连接架构收敛勘察存档（#150 实施依据）

> 勘察时间：2026-10-07，基线 d40a09b（行号锚点以该版为准，后续批漂移以 grep 复核）。
> 勘察 worker 只读盘点，Leader 定稿拆批。本文=勘察结论+拆批决策，R2/R3 任务书以此为据。
> 决策语境：用户拍板先收敛再出包（DV-ARCH 落账 d40a09b）。

## 一、三连接现状（勘察实证）

物理连接恰 2 条：B2 自建（1214）+地基（3889）；B4 桥为劫持不新增。地基/B2 的 onmessage 均为**赋值式**（3915/1225），桥 tap 用 addEventListener（3039）——两者合法并存是当前不炸的根基，也是总线方案可行性的直接证据。

| 层 | 位置 | 关键机制 |
|---|---|---|
| 地基 connectLan | 3882-3923 | ws 创建 3889；`__ccDeck005MainWs` 3891；onmessage 3915（COMMAND_ACK 先截给 Team.onAck 3919 后 return）；重连退避 4198-4204 |
| 地基 Team | 4211-4241 | ackWaiters 4213；sendCommand 4220-4230（"team-" 前缀）；onAck 无主静默丢 4237-4238；onFrame 4243-4289（团队/项目帧） |
| 地基 onEvent | 4292-4300 | 只吃 SNAPSHOT；renderSessionList 让位 guard 4152（b2Owned） |
| B2 connectB2 | 1210-1226 | 自建 ws 1214（全页最后建）；onclose 立即 fail 全部飞行 1220-1221（#143 盲评R-1） |
| B2 handleFrame | 1249-1266 | 帧处理全集：ACK 1356-1368（**无主且 ok:false → toast 误报源**）/ARTIFACT_CHUNK 1252-1376/SNAPSHOT 1269-1284（S.timelines 重建 1272）/SESSION_* 1285-1330/SESSION_LOG→pushLog 1335-1346（400 条上限） |
| B2 sendCmd | 1229-1247 | fire-and-forget；commandAck 走 S.ackWaiters 8000ms；命令全集：ARTIFACT_FETCH/RENAME/PIN/DELETE/REJECT/CONTINUE/ANSWER/MESSAGE/EXT_INPUT/EXT_STOP/STOP/CREATE |
| B4 TappedWebSocket | 3033-3060 | 劫持 window.WebSocket；sockets Set+activeSocket 覆盖（DOMContentLoaded 后恒为 B2 socket——**bridge.connection 实际跟随 B2 而非地基**，隐性错位） |
| B4 handleFrame | 2993-3031 | COMMAND_ACK 自结算 2995-2998；数据面：sessions（Object.assign 无白名单 3023-3028，与 B2 MERGE_KEYS 1292 语义有差）/notifications/confirms/accepts/projects；changed→subscribers 3030 |
| B4 sendCommand | 2956-2969 | mainWs 优先+sockets.find fallback（可能借道 B2 → ACK 落 B2 连接触发其无主 toast——串台残留） |
| B2↔地基耦合 | 让位网 | b2Owned 打标 1450/guard 三处 4152/4328/4374；选中链=DOM class 驱动+MutationObserver 2307-2326；**渲染层机制，本次收敛不动** |
| 消费方 | B4 桥 | B4 域/notify(3555 ACK)/settings(4083)/mobile(4475/4892)——零改动验证对象 |
| 消费方 | B2 导出面 | 2557-2569（S/canCmd/sendPrompt）；唯一消费方移动端（4484/4562 timelines/4681-4683） |

## 二、Leader 拆批决策

**架构终态**：地基唯一持连；`window.__ccDeck005Frames` 原始帧总线（事件两类：`{kind:"frame",frame}` / `{kind:"ws",state:"open"|"close"}`）；域脚本一律订阅总线+经统一通道发命令。

**范围裁定**（哪些不动）：
- 让位网（b2Owned）与选中链（DOM class 驱动）：渲染层双写者问题，非连接层——保留现状，收敛后另行评估
- 桥 sessions 副本与 B2 sessions 副本各自维护（merge 语义差接受）：副本合一属更大重构
- seq 跟踪（ctx.lastSeq 3920）：三端均不消费，维持现状

**R1 帧总线+桥去劫持**（已派工）：
1. 桥 IIFE 开头判空建总线（桥 2834 早于地基 3665，B2 1129 更早——R2 时 B2 判空复用）
2. 地基 onmessage：COMMAND_ACK 去 return 继续多播；每帧 emit 总线；open/close emit ws 事件（close 在 scheduleReconnect 前 emit）
3. 桥拆 TappedWebSocket/sockets/activeSocket；handleFrame 入口改总线回调（地基已 parse，桥不再 parse）；connection 由 ws 事件驱动（**修正隐性错位：从跟 B2 改为跟地基**——期望行为）
4. sendCommand 只走 __ccDeck005MainWs，删 sockets fallback（串台残留消除）
5. 消费方四域+B2 段零改动（diff 取证）

**R2 B2 并轨**（R1 合入后派）：
1. 删 connectB2/scheduleB2Retry/握手超时/S.ws；ready() 末行 connectB2() 调用删
2. B2 判空复用总线：handleFrame 原样接帧（ARTIFACT_CHUNK 分支天然保留）；ws close → fail S.ackWaiters（保持 fail-fast 语义）
3. sendCmd ws 引用改 __ccDeck005MainWs（fire-and-forget 语义+commandAck/S.ackWaiters 保留——B2 等待表独立于 Team，command_id 前缀天然区分）
4. **B2 onAck 无主 toast 分支删除**（并轨后 B2 会看到全部 ACK——地基/桥的 ACK 落进来会误报「命令失败」；勘察风险点 6 延伸）
5. __ccDeck005B2 导出面零变化；移动端对话 tab（S.timelines 数据源 4562）回归验证

**R3 清理+全量回归**：
1. 死代码清理（NativeWebSocket 捕获残留等）
2. 全量回归：语法/逻辑单测/沙盒 8791 真链路（重点链路：ARTIFACT_CHUNK 拉取、COMMAND_ACK 三表认领、断线 fail 语义、通知 ACK 能力位、移动端双数据源）
3. 用户可见面零变化复查（A 卷口径）+总档 DV-ARCH 状态更新「收敛完成」+解锁 ⑥d

## 三、勘察风险点对号（R1/R2 施工注意事项）

1. onmessage vs addEventListener 并存语义——总线方案下桥/B2 只经总线，地基唯一 onmessage，冲突源消除
2. activeSocket 时序（connection 跟错对象）——R1 第 3 步修正
3. sendCommand fallback 借道 B2——R1 第 4 步消除
4. SNAPSHOT 双投（两连接都触发 applySnapshot）——单连接后天然单投；R1 验证 hasSnapshot 幂等
5. 桥/B2 merge 语义差——接受（范围裁定）
6. ACK 三表分发链断裂（地基 3919 先截后 return）——R1 去掉 return 多播解决；B2 无主 toast 误报 R2 删
7. ARTIFACT_CHUNK 只在 B2 链路——总线方案下 B2 handleFrame 整体保留，天然无恙
8. b2Owned 让位网整拆或整留——整留（范围裁定）
9. 选中链 DOM 驱动——不动（范围裁定）
10. 移动端双数据源——B2 S.timelines 经总线继续增长，数据源不变
11. 断线语义不一致（B2 fail-fast/Team failFlights/桥 8s 超时）——各表保持各自语义（B2 fail-fast 保留；桥超时兜底保留）；统一口径非本次目标
12. 重复实现清单（握手超时/重连退避/token 三处）——R2 删 B2 份；桥 guessToken 只读保留
13. seq 无消费者——维持现状
14. Team.sendCommand 直用 ctx.ws——唯一持连后天然并轨，ACK 多播后 Team 仍唯一受益于自己前缀，无冲突
