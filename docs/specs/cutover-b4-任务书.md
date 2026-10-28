# 任务书：SQLite Cutover 批4（终批）——session 热态写切+boot 恢复读库（#292-B4）

基线：fix/engine-chip-slim@c8bddae9（本 worktree 即此，含批1-3 全部骨架）。总图 `docs/specs/sqlite-cutover-plan.md`（§三 批4、§四 R1/R4/R5 先读）。

## 范围（cutover 最后一步，最高风险）

1. **session 表由快照投影改为增量事务写**：现状 session 表靠导入器从 events.ndjson 快照投影——改为会话状态变更点（SESSION_UPDATED/HEARTBEAT 等帧处理口）直接经 StoragePort 小事务写库。**events.ndjson append-only 审计流一字不动**（R5：审计≠实体）。
2. **boot 恢复改读库**：现 boot 走 events.ndjson 回放+ensureExternal——改为库 open 先行（probeSqliteDriverAtBoot 扩展启动序，R1 冷启动时序：库 open 必须先于 SNAPSHOT 构建），回放仅作库缺失时的兜底（灰度期双路）。
3. **性能预算（R4）**：每帧写的热域拆小事务（单帧一事务，禁长事务跨帧）；`bench-read` 基准跑前后对比不回退（仓库已有基准脚本则用之，无则写一个简版：1k 会话快照读+100 帧写混合负载计时）。

## 灰度纪律（总图全局纪律，本批严格执行）

- **双写灰度**：session 域先影子模式（写文件+写库+shadow 比对零差异跑 20 轮）→ 翻转读库 → 撤旧写口分三提交，每步可独立回退。
- 回退通道验证：CCR_STORAGE_READ_MODE=json 下全链路行为不伤。

## 铁律（承批1-3 全部：API 实证/段链敬畏/沙盒/降级不炸主链/禁盲读）

- 会话域是 relay 最高频写点：任何单帧写 >5ms 或持锁跨帧=设计错误，回头改。
- 导入器 session 快照投影与直写并存期的一致性：直写行与投影行同 id UPSERT 语义想清楚再动（参照批1 v2 教训：restoreSegs/冻结语义）。
- boot 改动的验证必须含「库损坏/缺库冷启」路（降级回放兜底生效）。

## 交付要求

- 新测试 `relay/scripts/test-c4.ts`：帧写透传/影子比对零差异 20 轮/boot 读库/库缺失降级回放/性能预算断言（单帧 P95<5ms 沙盒口径）。
- 回归：test-c2/c3/brm 全过+既有套件+触碰文件 tsc 0+build 绿。
- 审查 A/B（一路反方），回执进最终提交体。三步灰度分三提交（`[正经立项] feat: #292-B4a/b/c ...`）推 `fix/cutover-b4`。
- 禁碰 deploy/发版。语义疑点（尤其 boot 时序与导入器并存）先问 PM。

## 完成定义

PM 复验（复跑矩阵+影子审计+性能基准对比+真库零污染+合入统一线）。本批收口=cutover 四批全毕，「库=唯一真相」达成，import runner 转退役评估。
