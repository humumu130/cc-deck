# node:sqlite（Node 内建 SQLite）替代 better-sqlite3 评估报告

> DEV-39 清单5（arch-review-2026-11-28 §五 R3-②）。**先评估后拍板，本报告不迁移任何代码。**
> 实证环境：本机 node v22.23.4（ABI 127，darwin-arm64）+ better-sqlite3 11.10.0（SQLite 3.49.2）。
> 所有 API 断言均为本机实测（非文档转述），测试脚本随报告结论可复跑。

## 〇、结论先行（建议，拍板权在 leader）

**建议：现阶段不迁；把迁移列为「Node 档位升到 27+ 且 node:sqlite 转正后」的条件触发性工程。**

理由三行：

1. **收益真实但已打折**——迁移能消掉整个 ABI 事故类（11-24 恒降级）与双闭包汇集，但本批（DEV-39）已落地的 ABI 烙印+运行时自比对（清单3）把该事故类从「无声恒降级」变成「当场报警」，剩余风险敞口大幅收窄；
2. **风险不对称**——node:sqlite 在**所有已发布 Node 线（含当前 LTS 26.x）仍是 experimental**（仅 Node 27 alpha 转正），而 cc-deck 存储层刚刚完成收口（写面单一真相源），此刻换驱动=在刚稳定的地面下抽板；
3. **迁移面本身不大**（见 §三：单文件 sqlite.ts ~200 行），真要做时成本可控——所以更没有理由在 experimental 期抢跑。

拍板点（leader 定）：① 接受「不迁+条件触发」建议，或 ② 指定「随下次 Node 档位升级一并迁」的时点，或 ③ 立即迁（本报告的迁移清单即施工图）。

## 一、API 面对照（cc-deck 实际消费面为准）

cc-deck 对 better-sqlite3 的全部消费收口在 `relay/src/storage/sqlite.ts` 一个文件（StoragePort 唯一驱动实现）。实际用到的 API 与 node:sqlite 对照（✓=本机实测通过）：

| cc-deck 消费面（sqlite.ts） | better-sqlite3 11.10 | node:sqlite（22.23.4 实测） | 判定 |
|---|---|---|---|
| `new Database(path)` 构造 | ✓ | ✓ `new DatabaseSync(path)` | 等价 |
| 同步执行 `exec()`（多语句 DDL） | ✓ | ✓ | 等价 |
| prepared 语句 `prepare().run/get/all` | ✓ | ✓（run 返回 `{lastInsertRowid, changes}` 同形） | 等价 |
| 匿名参数 `?` 位置绑定 | ✓ | ✓ | 等价 |
| 命名参数 `@x`（未来面） | ✓ | ✓ | 等价 |
| 事务三拍 begin/commit/rollback | ✓（`exec("BEGIN IMMEDIATE")`） | ✓（同款 exec 面，实测 commit/rollback 语义正确） | 等价 |
| `.pragma(x)` | ✓ 方法 | ✗ 无方法——`exec("PRAGMA x")` 替代（实测 WAL/foreign_keys/busy_timeout 均可） | 改写即可 |
| `inTransaction` 属性 | ✓ | ✗ **22.23.4 无此属性**（实测 undefined） | **缺口**：端口内自记账布尔可替（进程内单连接，语义等价） |
| `busy_timeout` | `pragma("busy_timeout=5000")` | 同款 pragma（实测生效；构造选项 `busyTimeout` 亦有） | 等价 |
| BUSY 报错形态 | `SqliteError: database is locked` | `ERR_SQLITE_ERROR: database is locked`（code 词表不同） | 捕获面需改（现按 message 正则的地方） |
| 自定义函数 `db.function()` | ✓ | ✓（实测） | 等价（src 未用，仅未来面） |
| 语句迭代 `for...of stmt` | ✓ | ✗ 22 无（高版本有） | 不需要（src 全走 .all()） |
| 大整数返回 | number（安全域内） | number（`readBigInts` 选项管 2^53 外） | 等价（ms 时间戳远低于 2^53） |
| 动态可失败加载（#158 降级语义） | `createRequire` require+成败缓存 | `require("node:sqlite")` 同款 try/catch（模块常在，构造才可能失败） | 等价可守 |

**同步特性总判定：node:sqlite 已具备 cc-deck 消费面的绝大部分**——与 arch 报告预判一致。

## 二、性能对照（本机实测，:memory: 同款负载）

| 负载 | better-sqlite3 | node:sqlite | 差 |
|---|---|---|---|
| 插入 20k 行（单事务 prepared 复用） | 13.5ms | 13.5ms | 持平 |
| 点查 20k 次（prepared 复用） | 14.3ms | 17.1ms | +20%（点查慢） |
| 全表 COUNT×20 | 0.2ms | 0.2ms | 持平 |

结论：写入与聚合持平，点查约慢 20%。cc-deck 读面模式=低频点查+批量投影（sqlitefix 后还有域缓存），20% 的点查差不在热路径敏感区。**性能不构成迁移障碍。**

附：bundled SQLite 版本——better-sqlite3 11.10.0=3.49.2，node:sqlite(22.23.4)=3.53.4（更新，无功能回退面）。

## 三、迁移成本（若拍板迁）

- **代码面：单文件**。`relay/src/storage/sqlite.ts`（~200 行）重写驱动实现：require 换 `node:sqlite`、`.pragma()` 四连改 `exec("PRAGMA …")`、`inTransaction` 改端口自记账布尔、BUSY 正则改 `ERR_SQLITE_ERROR`。StoragePort 接口零改动，七导入器/org-write-tx/session-write 等全部上层零感知。
- **构建面：大幅简化**。build-plugin 的 native 闭包汇集（gatherClosure ~2MB×2 份）、双闭包逐字节闸、Windows CI prebuild-install 覆盖步、nativeMagic 告示——全部可删；`bundle-options.mjs` external 列表去掉 better-sqlite3。
- **测试面**：test-storage-driver/test-sqlite-resilience 的注入位（resetSqliteDriverForTest）语义保持；ABI 系（abi-gate②③）随闭包消失而退役，abi-gate①（构建档位）与 DEV-39 烙印自比对仍留（防的是「运行时 node 与产物预期档位」错配，与驱动来源无关——但威胁面缩小为「node 主版本悬差」）。
- **估时**：代码+测试 1 人日，构建链清理+CI 验证 0.5 人日，灰度回归（对账零差异段重走一轮）1 人日。**合计 ~2.5 人日。**

## 四、风险清单（不迁的主要依据）

1. **experimental 身份（头号风险）**：所有已发布线（22/24/26）均 experimental，仅 Node 27 alpha 转正。含义：API 可跨小版本变（22.23.4 已实测 `inTransaction`/语句迭代两处版本差）、语义可调、每 boot 打 ExperimentalWarning 到 stderr（生产日志噪声+「实验特性」心智负担）。cc-deck 壳内嵌 relay 固定 node 档位，跨版本漂移风险低，但插件形态（relay.mjs 跑在**用户自己的 node** 上）无此保护。
2. **node 下限抬升**：node:sqlite 22.5.0 才引入（22.13 前还要 flag）。迁移后 bundle 的真实下限从 node18 跳到 22.5+（bundle-options target=node18 需同步抬），插件形态对老 node 用户从「能跑」变「起不来」——需要启动探测+引导升级的壳层配合。
3. **收口刚完成**：写面单一真相源（DEV-39 清单1）刚落定，立刻换驱动=收口验收期的第二变量。灰度序的教训（每步一个变量、每步验收数字）在此同样适用——要迁也应单独立单走完整对账零差异段。
4. **生态差异小项**：无 `.backup()` 在线备份 API（src 未用；冷备份走 tar 不受影响）、错误码词表不同（ERR_SQLITE_ERROR vs SqliteError——降级路径的 code 字段消费面需同步核）。

## 五、触发条件建议（何时该迁）

- Node 27+ 转正且 cc-deck 内嵌 node 档位升到该线（消 experimental 风险①②）；或
- Windows/外部部署者撞 ABI 墙成为现实高频 issue（消闭包的收益兑现时点提前）；或
- better-sqlite3 停更/安全漏洞无法跟进。

任一成立再启动，迁移清单即 §三。

---

*deck-fixer-3 · 2026-11-28 · 全部断言本机实测可复现（node 22.23.4）；版本事实来源：[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)、[node:sqlite stable 报道（Node Weekly #649）](https://nodeweekly.com/issues/649)、[hocuspocus 迁移讨论](https://github.com/ueberdosis/hocuspocus/issues/1205)。结论留给 leader 拍板。*
