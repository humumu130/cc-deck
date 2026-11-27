# updated_at 写手清单与单点守卫契约（DL-P1-7，DEV-22 批 B，2026-11-28）

> 背景：空闲跳序四现 saga（用户 11-23→11-24 连续四轮实锤「空闲的会话卡反复跳到顶部」）
> 的定性结论=**一个根因藏了至少 6 个写手，四轮才逐个拔掉**（修现象不修注册面）。本文=
> 写手全量清单+守卫契约，结构性防第五现。谱系证据：defect-ledger.md DL-P1-7 / §五 R1。

## 守卫契约（端上面，已落地）

`touchUpdatedAt(sess, ts, force)` —— web-console 双 IIFE（js/session-domain.js +
js/bridge-core.js）各自持份（IIFE 互不 import，同口径复制）。语义三律：

1. **缺载/非数不推进**（#271 口径：不伪造接收时刻）；
2. **同值/回拨不洗**（空闲跳序根因形态——只有更新的真值才推进）；
3. **force=真态变必推进**（WAITING/ERROR/DONE 等状态翻转）。

**任何新写手禁止绕口裸赋值 `x.updated_at =`** —— `relay/scripts/test-updated-at-guard.ts`
源码锚（裸赋值计数=1/文件，只许守卫体内）+行为断言（34 项）锁死；新洗点接线须同步补锚。

## 写手清单（全量盘点，2026-11-28 树核证）

### relay 侧（session-manager.ts——批 A 改派面，DEV-22 未动）

| 写手 | 历史修复笔 | 现状 |
|---|---|---|
| 同值 status 洗 | c5b65148（首现） | 已修（同值 status 不洗） |
| todos/stats/pending 三写手 | 158184c9（二现） | 已修（同值守卫） |
| revive-on-hydrate WORKING 恒洗 | 0f29bc7a（四现） | 已修（恒洗退役） |
| subagents/其余增量键 | — | 逐点守卫，**无单点函数** |

**改派建议（leader → 批 A）**：relay 侧立同语义 `touchIfChanged()` 单点，session-manager
一切写 updated_at 路径收编过口——端上已示范（双 IIFE 同法），并加 relay 侧「空闲 60s
updated_at 不变」回归断言（端上装机回归清单同步，见 feedback-ledger 11 月回填 R1 行）。

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

## 回归与装机观察点

- 机器面：`npm run test:ui-followup`（saga 原套件）+ `test-updated-at-guard`（34 项）+ `test:fc`。
- 装机面（入 leader 晨报/回归轮）：空闲会话（含 PM 常驻保活席）静置 60s 列表零跳序——
  台账建议的端到端断言形态，真机一轮即可收口 R1 行。
