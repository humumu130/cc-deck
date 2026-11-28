# updated_at 写手清单与单点守卫契约（DL-P1-7，DEV-22 批 B，2026-11-28）

> 背景：空闲跳序四现 saga（用户 11-23→11-24 连续四轮实锤「空闲的会话卡反复跳到顶部」）
> 的定性结论=**一个根因藏了至少 6 个写手，四轮才逐个拔掉**（修现象不修注册面）。本文=
> 写手全量清单+守卫契约，结构性防第五现。谱系证据：defect-ledger.md DL-P1-7 / §五 R1。

## 守卫契约（端上面，已落地）

`touchUpdatedAt(sess, ts, force)` —— web-console 双 IIFE（js/session-domain.js +
js/bridge-core.js）各自持份（IIFE 互不 import，同口径复制）；expo（src/store.ts）
模块级导出同签同语义（DEV-40·R4 立即件收编，三端同答案）。语义三律：

1. **缺载/非数不推进**（#271 口径：不伪造接收时刻）；
2. **同值/回拨不洗**（空闲跳序根因形态——只有更新的真值才推进）；
3. **force=真态变必推进**（WAITING/ERROR/DONE 等状态翻转）。

**任何新写手禁止绕口裸赋值 `x.updated_at =`** —— `relay/scripts/test-updated-at-guard.ts`
源码锚（裸赋值计数=1/文件，只许守卫体内）+行为断言（74 项，含 X 组 expo 面）锁死；
新洗点接线须同步补锚。

## 写手清单（全量盘点，2026-11-28 树核证）

### relay 侧（session-manager.ts——DEV-31 清件③已收编单点，2026-11-28）

| 写手 | 历史修复笔 | 现状 |
|---|---|---|
| 同值 status 洗 | c5b65148（首现） | 已修（同值 status 不洗） |
| todos/stats/pending 三写手 | 158184c9（二现） | 已修（同值守卫） |
| revive-on-hydrate WORKING 恒洗 | 0f29bc7a（四现） | 已修（恒洗退役） |
| **全写手单点收编** | DEV-31（2026-11-28） | **已落地**：`touchIfChanged(state, at?, force?)` 单点（session-manager 私有方法），29 处直写全过口 + `setExternalUsage`（lifecycle/context-link 搬运体）1 处同收编；裸赋值仅守卫体内 1 处（`test-updated-at-guard` R1 锚锁死） |

**relay 单点语义（DEV-31 定案，与端上三律同构、force 分工按 relay 真相源角色）**：

1. **非数/非正 at 不推进**（显式坏 ts 不伪造接收时刻——比收编前更强：旧直写
   `updated_at = at ?? now` 形态下 NaN/0 会直落盘，现一律拒写）；
2. **非 force 同值/回拨不洗**（内容变写手：todos/subagents/pending/stats/artifacts/
   title/usage——乱序旧转录 ts 不回拨排序面）；
3. **force=真态变/权威校正必推进**（状态翻转/终态/退休/恢复 + 水合回放校正——
   `setExternalStatus`/`emitUpdated`/`finishExternal` 等 at 是权威时刻的路径，回拨到
   真相是校正不是洗；#271 boot 采纳与 #144 sweep 收殓语义逐字保留，回归锚 R4-2b/R4-3）。

**心跳载荷（DEV-22 审查 ：13129 实锤，DEV-31 补键）**：SESSION_HEARTBEAT 载荷带既有
`updated_at`（#157 帧完整性——防缺载兜底消费面回落信封 ts），心跳本身永不推进它；
三端消费面（web onHeartbeat/桥 SESSION_HEARTBEAT 排除口/expo 只读 elapsed_ms）均不
据它洗，纯帧完整性加固。

### 端上面（web-console——DEV-22 批 B 已收编）

| 写手 | 位置 | 收编方式 |
|---|---|---|
| onSessionUpdated 载荷洗 | session-domain.js | `touchUpdatedAt(s, p.updated_at)`（载荷显式携带才推进） |
| onWaiting 真态变 | 同上 | force 口 |
| onWaitingResolved 真态变 | 同上 | force 口 |
| onErrorEvt / onDoneEvt 真态变 | 同上 | force 口 |
| onLog 日志活动洗 | 同上 | `touchUpdatedAt(s, entry.ts \|\| Date.now())`（乱序旧 ts 不回拨） |
| onHeartbeat 心跳洗 | 同上 | **三现已修保持**（专用键 last_heartbeat_at，负向锚锁死零回退） |
| 桥副本 SESSION_MERGE 合并洗 | bridge-core.js | 载荷时刻优先/信封兜底/同值回拨不洗 |
| **桥副本心跳信封 ts 洗**（第五写手，本批新拔） | bridge-core.js | SESSION_HEARTBEAT 帧不推进 updated_at（三现同法——PM 常驻保活每拍信封 ts=桥副本排序面反复跳序） |
| 建卡初始化（SESSION_CREATED/桥新建） | 两文件 | 非洗点（新对象），保持直写 |

### expo 面（src/store.ts——DEV-40·R4 立即件收编，2026-11-28）

| 写手 | 位置 | 收编方式 |
|---|---|---|
| SESSION_UPDATED 载荷洗 | store.ts | `touchUpdatedAt(s, payload.updated_at)`（律①缺载不推进自 #157/#271 已在；**律②同值/回拨不洗本批补齐**——修前任何正数直赋值，乱序旧转录 ts 可回拨排序面=R1 第五现候补现场，arch-review §四 R-5） |
| 心跳/日志/状态翻转 | store.ts | 非洗点零写：心跳只读 elapsed_ms、SESSION_LOG 只刷 last_tool_use_at（#291 专用键）、WAITING/ERROR/DONE 翻转不本地造时刻（relay 真相源 force 推进后经载荷下行） |
| 建卡初始化（SESSION_CREATED/SNAPSHOT 装配） | store.ts | 非洗点（新对象），保持直写 |

回归面：`test-updated-at-guard.ts` X 组（源码锚 X1-X3 + 行为断言 X4——提取函数体剥
TS 注隔离求值，与 web 两份同法）。

## 回归与装机观察点

- 机器面：`npm run test:ui-followup`（saga 原套件）+ `test-updated-at-guard`（端上面
  + relay R 组，DEV-31 后 56 项）+ `test:fc`。
- relay 侧机器回归（DEV-31 落地）：`test-updated-at-guard` R4 行为组含「同值重报 ×12
  （5s×12=60s 等价）updated_at 不变」断言——空闲 60s 不变契约的 relay 面等价形态；
  真机 60s 静置仍按下方装机面走一轮收口。
- 装机面（入 leader 晨报/回归轮）：空闲会话（含 PM 常驻保活席）静置 60s 列表零跳序——
  台账建议的端到端断言形态，真机一轮即可收口 R1 行。
