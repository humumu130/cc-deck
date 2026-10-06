# M11-FIX-C 回单：F2 去重键碰撞面+差集删上限（worker H，2026-10-06）

> 来源=M11-REVIEW2 P3-5/P3-6（F2=import-artifact.ts）。改动面独占：`src/storage/import-artifact.ts` + `scripts/test-import-artifact.ts` 两件 M，零他人在途混入（org.ts/projects.ts/read-mode/dispatch-lesson 的 M 均他人，未触碰）。worker 未 commit。

## 修复 1【P3-5】去重键空格拼接碰撞 → JSON 编码键

- `import-artifact.ts`（原 :254）：`` `${row.sourceId} ${row.normalizedPath}` `` → `JSON.stringify([row.sourceId, row.normalizedPath])`。无歧义编码，两段各自原样保留（含空格/特殊字符），免手写转义。
- 注释同步：键构造点三行注释（为什么撞键：source_id 仅 trim 不禁内嵌、path 原样保留；("a b","c") 与 ("a","b c") 同键→duplicate 误判+后写赢吃行；JSON 编码无歧义）。
- 测试 §8「去重键碰撞」（4 断言）：fixture 三行=错位组合两行（`("x","a b c")` / `("x a b","c")`——旧空格键下同键）+ 真重复一行。断言：两行独立入库（10→12、upserted=2）；`("x a b","c")` 行独立存活（旧键下被并键消失）；真重复走后写赢（exists→missing）；duplicate-key 恰 1 条落 line3（错位组合零误判）。

## 修复 2【P3-6】差集删 NOT IN 上限 → 案①正向分块删（定夺申报）

**选案①（正向删），不选案②（阈值降级整域重灌）**。理由：
1. **单一代码路径、各规模语义一致**——正向删=「现存−保留=应删集」精确删，与 NOT IN 在上限内逐行语义等价；案②引入阈值触发的第二语义路径（整域重灌），重灌面牵动 checkpoint/loss/事务语义，为概率极低的边界加一条高风险分叉不值。
2. 案①顺带消灭占位符面：DELETE 语句占位符数=**块内行数**（≤500），与保留集总量无关；现存集查询 `SELECT normalized_path WHERE source_id=?` 无变量上限问题。
3. `keep.size === 0` 全清分支保留单语句 `DELETE WHERE source_id=?`（坏 JSON 源路径，原语义+效率不变，测试 §5 继续覆盖）。

实现：`SELECT normalized_path FROM artifact WHERE source_id = ?`（事务内，同连接读）→ JS `filter(!keep.has)` → 按 `ARTIFACT_DELETE_CHUNK=500`（新导出常量）分块 `DELETE ... WHERE source_id=? AND normalized_path IN (块)`。`opts.deleteChunkSize` 注入口（Math.max(1,·) 防零块死循环）——沿 `opts.schemaVersion` 测试注入先例，唯一外部消费方 read-mode.ts 不带 opts 调用零破坏（grep 实证仅此一处）。
- 注释同步：头注 F2 特化段改写为正向差集删口径（含 NOT IN 上限 32766 与「分块 NOT IN 语义错位会误删他块保留行」的不可行说明）+删除段五行注释。
- 备案：每命名空间每次重扫多一次 SELECT 读——行数以库内容为界，读无上限面，代价可忽略。

- 测试 §7「差集删分块」（5 断言）：`deleteChunkSize: 3` 小上限注入；首轮 10 行入库→次轮保留 4+新增 3→断言 13→10（删 6 陈旧跨两块 3+3 全删净——只删首块会漏第二块）、保留 4 行全存活（分块 NOT IN 的语义错位=误删他块保留行，本断言即护栏）、新增 3 行在、块测源零 loss。

## 自证（全部亲跑，env 五清）

| 套件 | 结果 |
|---|---|
| import-artifact（靶子，原 37+增 10） | **47/47** ✓ 两轮连跑绿 |
| storage driver/migrator/schema/checkpoint | 21/21、18/18、67/67、34/34 ✓ |
| import-org / org-parity / notification / session-task / acceptance | 39/39、55/55、33/33、46/46、38/38 ✓（全套零退，原差集删行为语义等价实证：§4 演进删 gone.md、§5 坏 JSON 全清均原断言原过） |
| duty-boundary | 32/32 ✓ |
| `npx tsc --noEmit`（末次 Edit 后） | **0 错**（全项目；上一时点 read-mode 在途件的 TS2345 已被 G 侧修净） |

**已知非本单项**：`test-import-dispatch-lesson` 当前崩（`dispatchIds.add is not a function`，flushBatch）——**K 在途中间态**（工作区 `M import-dispatch-lesson.ts`，K 正迁移 statThenRead+改 applyDispatchLine 签名，调用点未同步完；该件 import 面=util/checkpoint/loss-report，与本单 import-artifact 零关联，git diff 实证归属）。

## 提交拆分提示

工作区另有他人 M：`src/org.ts`、`src/projects.ts`（G）、`src/storage/import-dispatch-lesson.ts`（K 在途）、未跟踪 read-mode 两件（G）。本单仅两件：`src/storage/import-artifact.ts` + `scripts/test-import-artifact.ts`。
