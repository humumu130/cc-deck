# 审查单 D-R3·CONNV4D 返修复核（R1 口径·只读）

> 被审：fix/connv4d 追加笔 af35c60e（c46215cf 之上 10 文件 +273/−29，PR #147 已更新）+回执 w-connv4d.md「返修批 fix1」段。先读 w-connv4d-r1.md（你上轮挡的 P1×2）。

## 用户口径
- 发现腿要真活（生产启动序）+误拒可解除（HTTP 面端到端）——两个 P1 修法真锁才放

## 已知现状
- 返修自报：P1-1 identity 预构造提前（非补发布——worktree 勘 af35c60e 实际修法）+真实启动序断言；P1-2 device-admin gate 放行 rl-（HTTP 面端到端断言）；P2-3 指纹尾 8 位
- 锚：relay/src/index.ts:489 邻域（原 P1-1 病位）/relay/src/ws-server.ts:894（原 P1-2 gate）/relay/src/lan-peers.ts:173

## 验收点
1. P1-1 复核：新修法在真启动序下 TXT 含 dev/pk（读码推演+真实启动序断言真锁非 mock）
2. P1-2 复核：unignore rl- 走 HTTP 200→发起端重新出卡端到端断言真锁
3. P2-3：卡面尾 8 位落位
4. 增量 diff af35c60e 全 hunk 对账零未声明
5. 复跑：test-lan-peers（含新锚）+connv4b 9/0+acctmulti 8/8+tsc
6. 尾行「结果：放行/继续挡（清单）」→回执 w-connv4d-r3.md
