# HANDOFF-CONNV4 —— CONNV4 全线交接文档（2026-11-21 02:10，PM cc-deck-7d 固化）

> 目的：任何设备/会话拉起本仓后按此文档无缝接手。版本事实源：0.7.1-test.26；dev HEAD=69ce1905（已推远端，工作区干净）。

## 一、已入 dev 且部署（随下版 test.27 出包）

| 批 | 内容 | commit | 审查档 |
|---|---|---|---|
| 批A 源列表 UI | 本机置顶+来源标签+五段序+诊断迁位 | e0fd1c9f 合并 PR#143 | 双路过闸 |
| 批B 连接池最小版 | cloudCtx let 化 fg 指针+ctxPool+单台预热+emit 门控+39 调用参数化+七门 | c2a1a911（PR#144） | 四路（R1/R2/R3/R4 复审） |
| 批C1 桥侧设备管理 | /api/device-admin 四动作+静默拒+写面 fail-closed | 1b904279（PR#145） | 三路（R1/R2/R3 复核） |
| 批C2 web UI 双键 | 台账+踢/忽略分型 toast+恢复+旧 relay 回落 | 40de1eec（PR#146） | 三路+PM 终审 |

部署态：deploy-web.sh 四面锚全绿（1120 部署）；镜像收口 91ee443f/69ce1905 已推。

## 二、在途三单（交付在各分支+回执，**待审查收割**——这是接手第一优先）

| 单 | 分支（已推远端） | 回执（~/.cc-deck/artifacts/） | 状态 | 接手动作 |
|---|---|---|---|---|
| 批D LAN 邻居（含返修 fix1） | fix/connv4d @af35c60e（PR#147 draft） | w-connv4d.md（含返修段）+w-connv4d-r1/r2.md（双审双挡已返修） | 待复核（R1 口径三件：P1-1 真实启动序断言/P1-2 HTTP 端到端/指纹尾 8 位——审查单 brief-connv4d-r3.md 已备，**worker 夜间停未跑**） | 起审查→过→ready+squash PR#147→复验（lan-peers 68+web 23+全套锚）→部署 relay 面 |
| 批E 收官批 | fix/connv4e @649f569c | w-connv4e.md（审查占位空） | 待双路审查（brief-connv4e-r1.md 已备） | 起审查→过→squash→复验→部署 web 面（注：批E 用能力位分流不依赖批D 合入序） |
| #190 派单链治本 | fix/dispatchfix @1 笔 | w-dispatchfix.md（七验收点自报全落+48 断言） | 待审查（brief-dispatchfix-r1.md 已备） | 起审查→过→squash（ws-server 若与批D 撞 hunk 以批D 先行 rebase）→部署 |

**审查 worker 起法（本机已验证手法）**：`cd /Users/xdd/dev/cc-deck && nohup claude -p "你是 cc-deck 审查 worker。任务书 /Users/xdd/.cc-deck/artifacts/<brief>.md——读并严格照做（回执写 <指定路径>）。gh 直连。完成即止。" --dangerously-skip-permissions > /tmp/w-xxx.log 2>&1 &`（官方派单链有已知病见 §四）

## 三、等用户拍板（不催）

1. **Orca 决策卡**（#191）：A 深耕差异化+混合 spike（PM 推荐）/B 收敛自用/C 全迁（不推荐）。详证 w-orca-deep.md（四问+选型矩阵）。金句：Orca 赢了跑 agent 的地方，cc-deck 握着 agent 交付的纪律
2. test.26 验收单 444f3996 装机回流（#185）
3. 批四（计数诚信）/批五（IA）未发话；zcode 决策卡不催
4. PM 任命卡 cf-936b1c4c 挂板

## 四、已知坑（接手必读）

- **官方派单链（leader-dispatch→org dispatch）有三现病**（#190 正在根治，其分支即上表第三单）：queued 假「活席忙」实际池空窗死等/板面活性假态/同 slug 死锁 119min。**过渡期用 §二 的 headless 手法起 worker**
- 探针连跑会 Chrome 资源竞争假红——**单套逐跑**（R3/batch B 多次实证）
- gh 走直连（7890 代理曾 403）；`gh pr merge --squash`（非 `gh pr squash`）；PR 合并前先 `gh pr ready`
- deploy-web.sh 干净树闸：镜像（cc-plugins/）改动须随批提交；**worktree 里跑部署会把未合入内容同步进主仓镜像**（已还原过一次）——部署只在主仓干净态跑
- 6f75e36a=批B 原工位；2006d49b/8ac5cb9a/f07af792=各返修工位；25707938=C2R3 停摆席（勿再派）

## 五、环境态快照（2026-11-21 02:07）

- 主仓 /Users/xdd/dev/cc-deck：dev@69ce1905 干净已推；worktree：/private/tmp/cc-deck-w-{connv4b,connv4c1,connv4c2,connv4d,connv4e,dispatchfix,connv4c1-r2,connv4c2-r2}（b/c1/c2 已收割可 `git worktree remove` 清理）
- 无 worker 进程在跑；feifan 车机会话（f5d40b90）独立进程在 /Users/xdd/dev/feifan 干活中（勿动）
- PM 会话=本机 cc-deck-7d（212c8258）；平行值守席 cc-deck-3e（73c01bec）划界已立：CONNV4 链归 PM，巡检它一行带过
- Claude 侧 durable cron 仅 boardtruth 周一/四 09:23；巡检令=用户手动投喂（无 cron 发源）

## 六、接手第一小时清单

1. 读本文档+~/.cc-deck/artifacts/w-orca-deep.md（决策语境）
2. 三单审查收割（§二 表逐行——brief 都已备好，headless 起即可）
3. 三单合入后：test.27 发版评估（/release 流程；攒 A~E 全量+UI 批零~三）→出验收单
4. Orca 拍板若 A：spike 单（agent-adapter 加 orca CLI 引擎）任务书另立
