# CUT-1 验收归档（Leader 核验，cutover 闸门 5/6 取证）

- 任务：CUT-1 cutover §4 闸门 5/6 取证（#112）
- worker：K（3191106b）｜回单：/tmp/worker-k-cut1.md（16:26 收尾）
- 提交：见本笔（两脚本+package.json 注册+cutover §4 回填+本档）

## 亲验记录

1. **改动面**：K 两件 untracked（bench-read-mode.ts 15.4KB+rehearse-cutover-rollback.ts 17.9KB）；src/ 四件 M 为 G 的 M13-2 在途面（K 零碰 src 实证）+G 新增 test-delta-projection.ts untracked（同 G 面）。
2. **亲跑 rehearse:rollback**：PASS 复现——四域零丢失断言全过（键集+抽样全等+decided 终态面）+§6 缺口发现能力实证（shadow-diff 抓被删 confirm 单 1 行命中）；dispatch 有损面（target+session_id 恒空串）对账双剔+备案口径一致。
3. **亲跑 bench:read**：SLOW 复现——m2 实况档（events 19193 行）四函数 SLOW 16~41%（绝对 3~25μs）；synth 放大档（20 万行）43~103%（绝对 0.03~0.8ms）；冷启动 ensureStore 442/771ms 一次性。读值探针防死代码+证非空面。与 K 回单数据同构（K m2 档 group/confirm 域空读 vs 我跑 groups=1/confirms=1——bench 每次 cpSync 最新 m2 副本，pg 立项+PM-75 派单新落所致，反证真实副本）。
4. **回归抽验**：read-mode 43/43（K 靶面）；K 自证 18 套全绿+tsc 0+NUL 0。
5. **方法论备案采信**：进程隔离取样（spawnSync 每档独立子进程防 JIT 污染）+空库陷阱（先写后切档时序，防「空库假象 0.01ms」）——bench 头注已固化，后续取证人免踩。

## 裁定

1. **闸门 5=PASS 已回填 §4.5**（证据：本笔+演练脚本可复跑）。
2. **闸门 6=SLOW 呈用户裁**（头注铁律：判据变更须用户知悉，不擅自改口径）。三选项：
   - **A 收口放行**：绝对差 m2 实况 3~25μs（请求面无感），synth 是 ×10 放大压力档非现产规模——按「实质不回退」收口；
   - **B 改判据口径**：如「绝对差 <1ms」或「m2 实况档过线即可」（synth 为前瞻压力参考）；
   - **C 立项优化**：批量编解码/行对象池（另立单，解决结构性差不封顶）。
   - Leader 倾向：A+B 组合（实况档收口+判据补「绝对差无感阈值」防前瞻恶化），优化不立项（现产规模无需求信号）。
3. **dispatch 投影 target+session_id 有损面**：read-mode.ts 头注既有备案只列 target——session_id 为新发现。补录头注属 src 改动，与选项裁定合并呈报（若用户选收口，另起文档备案小单）。
4. **冷启动 442/771ms**：翻转窗口首读一次性成本，§6 回退路径不受影响（回退方向 json 档冷启动 0.27ms）——呈报注明即可。

## 结论

**通过。#112 completed。** cutover checklist 六闸现状：1 shadow≥7 天（观察期）、2 parity 全绿（M13-1 闸）、3 写者收口（前半 ✅ 15172db/后半等 M1-3 写切换）、4 冷备份（翻转拍板后执行前）、**5 ✅（本笔）**、**6 取证完成待裁（呈报）**。翻转拍板前置件全部就绪，待：shadow 观察期满+用户三裁（闸门 6 选项+确认卡 cf-27b132fa+PM-75/72W0 提案）。
