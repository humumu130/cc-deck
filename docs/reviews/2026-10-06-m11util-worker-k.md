# worker-K 回单：M11-UTIL 导入工具共享化

> 2026-10-06。一新件 + 四件迁移，worker 未 commit。纯重构达成：**六套导入测试零改动全绿**，tsc 全项目 0 错，十一套回归零退（21/18/67/34 + import-org 39、parity 55、notification 33、session-task 46、acceptance 38、artifact 37 + duty-boundary 32）。

## 一、改动清单与 diff 规模

| 文件 | 性质 | 规模 |
|---|---|---|
| `relay/src/storage/import-util.ts` | 新 | 54 行（3 导出+权威注释） |
| `relay/src/storage/import-session-task.ts`（D1） | 迁移 | +16/−10（sha12 删、observeNdjson 改） |
| `relay/src/storage/import-acceptance.ts`（F1） | 迁移 | +18/−12（sha12 删、observeAcceptanceDir 观测内核改） |
| `relay/src/storage/import-notification.ts`（E1） | 迁移 | +18/−13（sha12 删、observe 改） |
| `relay/src/storage/import-artifact.ts`（F2） | 迁移 | +22/−13（sha12 删、observeFile 改；含 NUL 修复 1 行，见「四」） |

四件合计 +74/−48，净 −26 行；util 新增 54 行——共享化后全线净减副本。diff 全部落在 import 头部与 observe/sha12 定义处，**主体逻辑零改**（映射/事务/checkpoint/loss 段一行未动）。

## 二、import-util.ts 导出面（验收点 1）

```ts
export function sha12(s: string): string                    // sha1 前 12 hex，导入短 id 公共词根
export interface ObservedFile { mtimeMs: number; text: string }  // 单文件观测产物（mtime 已 Math.round）
export function statThenRead(file: string): ObservedFile    // stat 先于 read 定稿序骨架
```

- **sha12**：四件私有副本逐字同构（org 第五份），收敛为唯一定点。
- **statThenRead**：「stat 先于 read」定稿序（M11-REVIEW P2-1 / efd06ce）的唯一权威注释与实现定点——新导入器一律经此消费，不得再持私有 statSync+readFileSync 对。
- **容错边界（设计定夺，备案）**：骨架**裸调不吞 IO 异常**——异常域是各导入器的领域决策（单文件源炸出事务回滚 vs 目录遍历 catch continue 跳坏件），骨架只管定序不管容错；需容错的消费方自行 try/catch（先例=F1 observeAcceptanceDir）。这与四件迁移前行为逐字节一致，纯重构零语义漂移。
- **util 自身不单测**（任务书口径）：可用性由四件迁移后六套导入测试零改动全绿证明。

### 领域观测类型不共享的定夺清单（任务书点名说明）

各件领域类型**保留不迁**：org/notification 的 `ObservedSource{name,file,mtimeMs,lineCount,text}`、session-task 的 `ObservedNdjson`、acceptance 的 `ObservedDir{sheets,results}`、artifact 的 `ObservedSource{records,badJson}`——各自与 checkpoint 五元组消费位/loss 源标识/解析段紧耦合，强行统一必牵动主体逻辑（超界）。共享面收敛到 util 三导出即止。

## 三、迁移矩阵（验收点 2）

| 文件 | sha12 | observe→statThenRead | fs/crypto import 收缩 |
|---|---|---|---|
| import-session-task.ts | 删私有→import | observeNdjson ✓ | crypto import 删；fs 保留（observeTasksDir/D1 observeAcceptanceDir/:392 仍消费） |
| import-acceptance.ts | 删私有→import | observeAcceptanceDir 观测内核 ✓（try/catch continue 域保留） | crypto 删；fs 缩 `{existsSync, readdirSync}` |
| import-notification.ts | 删私有→import | observe ✓ | crypto 删；fs 缩 `{existsSync}` |
| import-artifact.ts | 删私有→import | observeFile ✓ | crypto **保留**（observeInline 内容指纹）；fs 缩 `{existsSync}` |

- artifact 的 `observeInline`（内容指纹替代 mtime，F2 特化）与 session-task 的 `observeTasksDir`（只 stat 不读内容）、D1 版 `observeAcceptanceDir`（stat/read 异常域分段：stat 失败跳过 vs read 失败落账）**不动**——非「stat 先于 read 骨架副本」，是领域特化，套骨架会改异常语义。
- **纯重构自证**：六套导入测试（org/parity/notification/session-task/acceptance/artifact）文件零改动全绿——验收灵魂达成。

## 四、import-org.ts 处置 + F2 提交件 NUL 损坏修复备案

**import-org.ts：未迁，留待下批**。本单开工与收工两次 `git log --grep C2FIX` 均空（G 的 C2FIX 在途未代提交），按任务书口径不碰；工作区 `M import-org.ts` + 两个 org 测试的 M 是 G 的在途改动，零触碰。org 的 observe 与 notification 迁移前逐字同构，util 头注已备「C2FIX 落地后下批回迁」指引。

**F2 提交件 NUL 损坏（需 Leader 知会 F2 owner/G）**：迁移开工时 `import-artifact.ts` 被 ugrep 判 binary——定位 **:258 模板字符串分隔符处 1 个 NUL 字节**（`` `${row.sourceId} ${row.normalizedPath}` `` 中间），`file` 判 "data"。**HEAD（296bbf9）同坏**——损坏随 F2 提交入库（NUL 在字符串字面量内，tsc/测试恰好容忍，且该 key 仅作内存 Map 去重键不落库，行为无感）。已用 perl 单字节替换 NUL→空格修复（Edit 工具无法表达 NUL；该字节无任何持久化语义，测试行为零变化），修复在 `git diff` 中即 artifact 22 行变更里的那一行。建议下批让 G 端自查写入链路（F2 交付时源文件即带 NUL）。

## 五、验收点逐条自证

1. **导出面清晰** ✓：三导出+权威注释（见「二」）；util 无独立测试件（任务书明示不单测）。
2. **四件迁移** ✓：sha12/observe 私有副本删净（`grep "function sha12"` 四件全空）、改 import 消费；diff 只动导入头部与调用点，主体逻辑零改。
3. **十一套回归零退 + tsc 0** ✓：storage 四套（21/18/67/34）+ 导入六套（39/55/33/46/38/37）+ duty-boundary 32 全绿；`npx tsc --noEmit` 全项目 0 错（含 util 新件与 G 在途 org 改动共存态）。
4. **回单** ✓：本件。

等 Leader 核验代提交。提交时注意：工作区另有 G 的三件在途 M（import-org.ts、test-import-org.ts、test-import-org-parity.ts），与本单无关，请按文件拆分。
