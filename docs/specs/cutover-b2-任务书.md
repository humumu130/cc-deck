# 任务书：SQLite Cutover 批2——org 域写切 StoragePort 事务（#292-B2）

基线：fix/engine-chip-slim@24ed9313（本 worktree 即此）。

> **换人交接**：前席 18265972 压缩死循环零落地已停（恢复锚两版均在转录，无代码遗产）——你从零开始，worktree 除本任务书外干净。开工先一口气读完任务书+总图再动手，中途被压缩打断时优先恢复施工而不是重写状态摘要。设计总图：`docs/specs/sqlite-cutover-plan.md`（先读）。

## 目标（批2 范围，三域写口切事务）

1. **org.json 保存口**（`relay/src/org.ts` 约 :289，saveOrg/写 projects.json 一带）与 **boards 写口**（upsertBoardEntry/loadBoardFile 所在 `relay/src/projects.ts`）、**confirms 写口**——写路径改为：文件照写（审计账保留）+ StoragePort **三拍事务**（begin/commit/rollback，失败 rollback 落 console.warn 降级=文件账仍在）。
2. **事务必须包住读-改-写整段**：现状 projects.json 是整读→内存改→整写，setGroupStatus 与 upsertBoardEntry 之间存在读改写竞态（已实测复现：test-brm 2.8% flake，S0 建组后立即 upsert 偶发「任务板已冻结」）。批2 用 `BEGIN IMMEDIATE` 把「读当前组状态→校验→写」收进单事务，竞态根除——这是批2 的验收症状之一（修完后 test-brm 100 连跑零 FAIL）。
3. **读侧撤双路径**：批2 域内（group/task/confirm 的 viaReadMode 消费点）确认读全走库（现状已 sqlite 默认档，检查有无残留 json 分支路径可撤/收窄，不必激进——撤不了就记备案）。

## 铁律（批1 血泪教训，违者返工）

- **API 以源码为准，禁止想象**：`ensureStore(resolveDirs())` 返回 StoragePort（`relay/src/storage/port.ts`：exec(sql,params)/query/begin/commit/rollback/isOpen）。**不存在** `loadSqliteDriver`。批1 v1 对想象 API 编码 import 即炸。写任何 import 前先 grep 实际 export。
- **段链/冻结行不可侵犯**：dispatch 导入器铁律「旧终态行永不删除/改写」（import-dispatch-lesson.ts restoreSegs）。org 域无此状态机但要同敬畏：写库前看清 import-org.ts 的 checkpoint/重扫联动（read-mode.ts DOWNSTREAM_TABLES/orgRescanPending——**org 三源 checkpoint 失效会触发下游 10 表全清重灌**，你的直写必须在导入器语义之内或让其幂等收敛，想不清就先在任务书回执里提问）。
- **测试沙盒**：`CCR_ORG_DIR` 指沙盒 + dataDir=cwd/data（resolveDirs 语义，worktree 本地库，零真库污染）。测试头注明 `env -u CCR_ORG_DIR` 直跑口径。测试内禁盲读 `.entry.id`（守卫式提取 `.entry?.`，批1 修复见 test-brm.ts 现 HEAD 版）。
- **失败降级不炸主链**：SQLite 不可用（#158 降级语义）时写路径落回纯文件账 + warn 一次，relay 主流程零影响。

## 交付要求

- 新测试 `relay/scripts/test-c2.ts`：三域事务写透传+回读、BEGIN IMMEDIATE 串行化（并发 setGroupStatus+upsert 交错不再冻结误判——可多跑循环放大验证）、降级路径（mock 库异常落文件账）。
- 存量回归全绿：`test-brm.ts` 100 连跑零 FAIL（竞态根除的实证）、既有套件（beads/journal/gate 等你在仓库能找到的）+ `npx tsc --noEmit` 对你触碰的文件 0 错 + `node scripts/build-plugin.mjs` 绿。
- 审查：A/B 两路（一路持反方），回执写进最终提交体（P1 必修/P2 随批/P3 备案），格式参照 40491c31。
- 提交格式 `[正经立项] feat: #292-B2 ...`，推送 `fix/cutover-b2` 分支。禁碰 deploy/发版。

## 完成定义

PM 验收=复跑你的测试矩阵+代码走查+合入统一线。有拿不准的语义点（尤其导入器联动）宁可停下来在 events 里写明疑问等 PM，不要硬猜。
