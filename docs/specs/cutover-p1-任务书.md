# 任务书：SQLite cutover 三路审查 P1 修复批（地基级，翻闸前置）

基线：fix/engine-chip-slim@1a4ad0b6。**先读三份回执**：主仓 /Users/xdd/dev/cc-deck/artifacts/review-cutover-{A,B,C}.md（全部文件:行证据与修法方向都在里面）。背景：cutover 四批已合入，三路审查（正确性/反方/性能运维）共抓 P1×6——本批全修，修完才允许评估 CCR_BOOT_FROM=db 翻闸。

## P1×6（全修，按危害序）

1. **B-F3 非原子写×导入器清域（现行即触·最高优先）**：confirms/notifications/deliverables 三域非原子文件写，崩溃在半写态 → 导入器「坏 JSON=清域+落 checkpoint」把坏态合法化=**静默清空表**。修法：三域写口改原子写（tmp+rename），或导入器清域前加坏账隔离（回执 B §F3 给了锚 projects.ts:1292、import-org.ts:297-356）。
2. **C-C1 org 重扫 98.8s 冻结（生产性能雷）**：org 三源写 commit 后同步追赶触发下游 10 表全清+全量重灌（35MB events 实测 98.8s 单线程冻结）。修法：重灌改后台异步+期间读走旧投影（回执 C §P1-C1），或 org 域追赶节流合并。
3. **C-C2 deferred 追赶无合并**：events.ndjson 35MB 超 SIZE_MEMO_MAX_BYTES=2MB → 每次追赶全文读 90-140ms 纯税；通知风暴 K 条=K 次。修法：追赶合并去抖（同 tick 批一次）+ memo 上限对 events 特例或 mtime 未变短路。
4. **A-1/B-F1 已删会话复活（双路互证）**：deleteSession 无库侧墓碑+直写 deleted_at 恒 null+boot 无条件收养 dbOnly → 翻 db 后删除复活。修法：deleteSession 走库侧墓碑（deleted_at 落库）+ boot 收养剔除 deleted 集。
5. **B-F2 历史标题回退 UUID**：dbRowsToReplayed 无条件覆盖回放行，pre-flip 库行 runtime_state_json 无 title。修法：字段级合并（回放行非空字段优先）。
6. **A-2 对账哨假判据**：bootReconcile statusMismatch 从未实现=「对账零差异」翻闸判据生产永不成立。修法：实现 statusMismatch 或翻闸判据改真可达成口径。

## 顺手批（P2 摘三件，其余备案）

- busy_timeout 一行修（A/B 双提）
- appendDeliverable catch{} 静默吞文件写失败（B）→ 至少 warn+返回 false
- c2/c3/c4 头部 `delete CCR_STORAGE_READ_MODE` 使 json 档套件覆盖是假的（C）→ 改可控注入

## 铁律

承 cutover 批1-4 全部铁律（API 实证/段链敬畏/沙盒/降级不炸）。修 1/2/3 时**必须带生产量级负载断言**（≥10MB events 沙盒），不许 KB 级沙盒糊弄。每修一件带回归断言进 test-c2/c3/c4 或新 test-c5。审查 A/B 双路回执进最终提交体。提交 `[正经立项] fix: cutover 审查 P1 批` 推 `fix/cutover-p1`。禁碰翻闸开关本身（CCR_BOOT_FROM 缺省仍 events）。

## 完成定义

PM 复验（三份回执逐条对照核销+全套件+生产量级负载复测）→ 三路审查闭环。
