# 任务书：SQLite Cutover 批3——experience/rules/notifications/deliverables 写切（#292-B3）

基线：fix/engine-chip-slim@5064f977（本 worktree 即此，含批2 的 org-write-tx 骨架）。总图 `docs/specs/sqlite-cutover-plan.md`。

## 范围（四域写口）

- **experience/rules**（org.ts exp/rule 面 → experience.json）与 **notifications**（sm:976 一带 → notifications 存储）与 **deliverables**（sm:371 一带 → deliverables.json）：写路径套用批2 已落地的 `withOrgWriteTx` 模式（互斥+文件照写+commit 后导入追赶+三级降级）。
- **先读 5fc1d27b 的 org-write-tx.ts 与三出口外包范式**（setGroupStatus/upsertBoardEntry/decideConfirm 怎么被包的），批3 是同构复制——不要发明新模式，除非发现批2 模式在此域有真不适配（有就先在回执里论证）。
- notification 域注意频率特性（每通知一写，比 org 域高频）：评估互斥锁+追赶同步导入的单写成本，若引入可感延迟（>50ms 量级）把「commit 后追赶」改异步并论证一致性窗口可接受。

## 铁律（承批1/批2，违者返工）

- API 以源码为准；写 import 前 grep 实际 export。
- 段链/冻结行/importer 联动敬畏：动前读对应导入器（import-notification/import-artifact）的 checkpoint/重扫语义。
- 测试沙盒自设 CCR_ORG_DIR+CCR_DATA_DIR（参照 test-c2.ts 头部口径）；测试内禁盲读。
- 降级不炸主链；BUSY/建库失败落纯文件账+warn 一次。
- 批2 备案项 P2-3（八个未包口：createGroup/setGroupTier/addMember 等）**本批顺手统一包口**——批2 已把范式立好，这批把 org 域剩下的写口一次包齐。

## 交付要求

- 新测试 `relay/scripts/test-c3.ts`：四域事务透传+回读+降级路+（若做异步追赶）一致性窗口断言。
- 回归：test-c2 16/16+test-brm 全过+既有套件+触碰文件 tsc 0+build 绿。
- 审查 A/B（一路反方），回执进最终提交体（格式参照 5fc1d27b/40491c31）。
- 提交 `[正经立项] feat: #292-B3 ...` 推 `fix/cutover-b3`。禁碰 deploy/发版。语义疑点先问 PM 别硬猜。

## 完成定义

PM 复验（复跑矩阵+沙盒/真库零污染核查+合入统一线）。
