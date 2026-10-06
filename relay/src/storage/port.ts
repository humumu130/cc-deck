// ---------- StoragePort：v2 数据地基端口（M1-1A，冻结件 docs/v2-m10-freeze.md §1） ----------
// 冻结口径：SQLite（better-sqlite3/WAL/FK/CHECK）是实体当前态唯一真相；所有新 durable
// 写入经 StoragePort。本文件只定端口形状——驱动实现见 sqlite.ts，迁移 runner 见 A2
// （migrator.ts），DDL/schema 见 B1（schema.ts）；均消费本接口，不绕过直连驱动。
//
// ---------- DUTY-BOUNDARY：值守三零边界（M11-E2，规格 specs/019-pm-duty.md） ----------
// 值守（PM duty）是旁路审计机制，不进 v2 实体库——019 口径：「PM_DUTY_ROUND 是独立日志
// 条目，写入 CCR_DATA_DIR/duty-rounds.ndjson append-only 文件，不进入 EventBus、
// EventType union 或 events.ndjson，不参加业务状态机」（§1/§4.3）。三零边界：
//   零 SQLite 表 —— duty-rounds.ndjson 不落任何 STORAGE_TABLES/IMPORT_LEDGER_TABLES 表，
//     不新增迁移版本；15+2 表清单是冻结件口径，值守审计不是实体（无外键归属、无投影消费）。
//   零 EventType 注册 —— types.ts 的 EventType 联合不含任何 duty 事件词；值守轮次不进
//     events.ndjson 事件流。
//   零 EventBus 出口 —— leader-duty.ts 零 import event-bus/storage（纯函数文件），值守
//     判定/回执校验不经总线广播。
// 理由：值守只保存跨事实源的派生观察、去重和审计（019 §1），消费面是审计追溯而非业务
// 状态机；入库会把旁路日志升格成实体、引入 FK/迁移/投影连带漂移。护栏测试
// scripts/test-duty-boundary.ts（npm run test:duty-boundary）静态+运行双面断言本边界——
// 未来若需破界（duty 入库/入流），先改 019 规格与冻结件，再改注记与测试，三处同步。


/** 端口构造参数。dataDir 必须由调用方保证指向受控目录（生产=cfg.dataDir，测试=mkdtemp
 * 临时目录）；本层不读任何 CCR_* 环境变量——环境解析归上层，端口只认显式路径。 */
export interface StoragePortOptions {
  /** 数据目录（库文件将创建在其下）。 */
  dataDir: string;
  /** 库文件名；缺省 `cc-deck.sqlite3`。测试隔离可用不同名多开。 */
  filename?: string;
}

/** SQLite 存储端口最小集。事务语义：begin/commit/rollback 手动三拍（迁移 runner 的
 * 「失败保留前一版本」依赖 rollback）；exec 承接写路径与多语句 DDL；query 承接读路径。
 * A2（migrator）消费 begin/commit/rollback/exec；B1（schema）消费 exec 承接 DDL。 */
export interface StoragePort {
  /** 库文件绝对路径（open 后可读；未 open 为空串）。 */
  readonly path: string;
  /** 是否处于打开状态。 */
  readonly isOpen: boolean;

  /** 打开（或创建）库文件并落冻结 PRAGMA（WAL/外键）。目录不存在则创建。重复 open 已打开的端口视为编程错误。 */
  open(): void;
  /** 关闭连接（WAL 随 close 落盘 checkpoint）。未打开时调用视为编程错误。 */
  close(): void;

  /** 开启手动事务（BEGIN IMMEDIATE——写锁前置，避免升级死锁）。已有未结事务时视为编程错误。 */
  begin(): void;
  /** 提交当前事务。无未结事务时视为编程错误。 */
  commit(): void;
  /** 回滚当前事务——回滚后数据与 begin 前一致。无未结事务时视为编程错误。 */
  rollback(): void;

  /** 执行写/DDL/PRAGMA：带 params 走预编译参数绑定（单语句），不带 params 走原生 exec（允许多语句，B1 DDL 用）。 */
  exec(sql: string, params?: unknown[]): void;
  /** 执行读查询，返回全部行（空结果为空数组）。 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}
