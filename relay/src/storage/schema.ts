// ---------- 基线 schema（M11-B1）：v1 = baseline-15-tables ----------
// DDL 逐字转录自冻结件 docs/v2-m10-freeze.md §2「DDL 定案（15 表）」——15 表 + 6 索引，
// FK/CHECK/唯一键/部分索引全按冻结件；表序即冻结件顺序（依赖拓扑有序，project/member 无外键先行）。
// 本文件零运行时逻辑：只导出 migrations（消费 A2 runMigrations）与表/索引名清单常量。
// 事务语义：v1 整段 DDL 在 runner 的单事务内执行，失败即回滚保留空库（user_version=0）可重跑。
// 冻结件随附语义注记（导入期翻译，不属于 DDL 执行）：
//   task 状态迁移：todo→backlog，doing→claimed，done→done；review_required=1 的 done 候选→submitted。
//   blocked 不入 status；gate_reason 非 NULL 即派生态 blocked。
//   dispatch 一行状态机：重投新建一行、attempt_no+1、parent_dispatch_id 指向父；旧终态行永不删除。
//   group_member 是关系表不替代 member/group 身份——command_role/task_participation 为组内角色覆盖，
//   可空=不覆盖时回落 member 行自身定义。
import type { Migration } from "./migrator.js";

/** 15 表名清单（sqlite_master 对账/导入器 loss list 对账用；"group" 是 SQL 关键字，SQL 里须带引号）。 */
export const STORAGE_TABLES = [
  "project",
  "member",
  "group",
  "group_member",
  "session",
  "task",
  "dispatch",
  "lesson",
  "org_confirm",
  "acceptance_sheet",
  "acceptance_item",
  "acceptance_result",
  "artifact",
  "notification",
  "notification_client_state",
] as const;

/** 6 索引名清单（idx_confirm_pending 为部分索引：WHERE status='pending'）。 */
export const STORAGE_INDEXES = [
  "idx_task_ready",
  "idx_dispatch_open",
  "idx_confirm_pending",
  "idx_artifact_attr",
  "idx_notification_action",
  "idx_acceptance_task",
] as const;

/** v2 导入台账表名清单（import_checkpoint + import_loss，M11-B2；非冻结件 15 表口径，单独列）。 */
export const IMPORT_LEDGER_TABLES = ["import_checkpoint", "import_loss"] as const;

// v1 基线 DDL——与冻结件 §2 逐字对齐（含引号写法 "group"）。
const BASELINE_15_TABLES_DDL = `
CREATE TABLE project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, dir_fingerprint TEXT NOT NULL UNIQUE,
  anchor_dir TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, ts INTEGER NOT NULL
);
CREATE TABLE member (
  id TEXT PRIMARY KEY, stable_identity TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, business_role TEXT NOT NULL,
  command_role TEXT NOT NULL, task_participation TEXT NOT NULL,
  engine TEXT, provider TEXT, model TEXT, external_sid TEXT,
  joined_at INTEGER NOT NULL, retired_at INTEGER,
  last_heartbeat_at INTEGER, last_business_log_at INTEGER,
  status TEXT NOT NULL, archive_json TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL
);
CREATE TABLE "group" (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL, anchor_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','parked','archived')),
  tier TEXT NOT NULL CHECK(tier IN ('轻立项','正经立项')), single_card INTEGER NOT NULL,
  headcount_json TEXT NOT NULL DEFAULT '[]', role_defaults_json TEXT NOT NULL DEFAULT '{}',
  hold_suggested_at INTEGER, archive_note TEXT,
  workflow_profile TEXT NOT NULL DEFAULT 'engineering', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE group_member (
  group_id TEXT NOT NULL REFERENCES "group"(id), member_id TEXT NOT NULL REFERENCES member(id),
  command_role TEXT, task_participation TEXT, joined_at INTEGER NOT NULL,
  retired_at INTEGER, archive_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(group_id, member_id)
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, relay_session_id TEXT, group_id TEXT REFERENCES "group"(id),
  member_id TEXT REFERENCES member(id), external_sid TEXT, engine TEXT, provider TEXT, model TEXT,
  cwd TEXT NOT NULL, status TEXT NOT NULL, runtime_state_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE task (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), group_id TEXT REFERENCES "group"(id),
  session_id TEXT REFERENCES session(id), parent_task_id TEXT REFERENCES task(id),
  origin TEXT NOT NULL, external_sid TEXT, external_task_file_id TEXT,
  task_ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}', handoff TEXT, assignee_id TEXT REFERENCES member(id),
  branch TEXT, artifact_id TEXT, depends_on_json TEXT NOT NULL DEFAULT '[]',
  gate_reason TEXT, gate_opened_at INTEGER, review_required INTEGER NOT NULL DEFAULT 0,
  review_status TEXT CHECK(review_status IN ('pending','passed','not_required')),
  workflow_profile TEXT, status TEXT NOT NULL CHECK(status IN ('backlog','claimed','submitted','ready_to_install','done')),
  deleted_at INTEGER, ts INTEGER NOT NULL
);
CREATE TABLE dispatch (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), group_id TEXT REFERENCES "group"(id),
  tier TEXT NOT NULL, target_member_id TEXT REFERENCES member(id),
  source_session_id TEXT REFERENCES session(id), actor TEXT NOT NULL, command_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('dispatched','running','done','failed')),
  receipt TEXT, attempt_no INTEGER NOT NULL DEFAULT 1,
  parent_dispatch_id TEXT REFERENCES dispatch(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE lesson (
  id TEXT PRIMARY KEY, group_id TEXT REFERENCES "group"(id), task_id TEXT REFERENCES task(id),
  text TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  source_dispatch_id TEXT REFERENCES dispatch(id), created_at INTEGER NOT NULL
);
CREATE TABLE org_confirm (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT REFERENCES "group"(id),
  title TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT
);
CREATE TABLE acceptance_sheet (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), group_id TEXT REFERENCES "group"(id),
  title TEXT NOT NULL, created_at INTEGER NOT NULL, sheet_key TEXT
);
CREATE TABLE acceptance_item (
  id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL REFERENCES acceptance_sheet(id),
  item_index INTEGER NOT NULL, task TEXT NOT NULL, item TEXT NOT NULL, criteria TEXT NOT NULL,
  UNIQUE(sheet_id,item_index)
);
CREATE TABLE acceptance_result (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES acceptance_item(id),
  verdict TEXT CHECK(verdict IN ('pass','fail') OR verdict IS NULL), note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE artifact (
  source_id TEXT NOT NULL, normalized_path TEXT NOT NULL,
  project_id TEXT REFERENCES project(id), group_id TEXT REFERENCES "group"(id),
  session_id TEXT REFERENCES session(id), task_id TEXT REFERENCES task(id),
  delivery_group_key TEXT, size INTEGER, kind TEXT NOT NULL,
  existence_state TEXT NOT NULL CHECK(existence_state IN ('exists','missing','unknown')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_id, normalized_path)
);
CREATE TABLE notification (
  id TEXT PRIMARY KEY, project_id TEXT, group_id TEXT, session_id TEXT,
  level TEXT NOT NULL, category TEXT NOT NULL, payload_json TEXT NOT NULL,
  handled_at INTEGER, resolved_at INTEGER, condition_key TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE notification_client_state (
  notification_id TEXT NOT NULL REFERENCES notification(id), client_id TEXT NOT NULL,
  read_at INTEGER, dismissed_at INTEGER, PRIMARY KEY(notification_id, client_id)
);
CREATE INDEX idx_task_ready ON task(group_id,status,gate_reason);
CREATE INDEX idx_dispatch_open ON dispatch(group_id,status);
CREATE INDEX idx_confirm_pending ON org_confirm(status) WHERE status='pending';
CREATE INDEX idx_artifact_attr ON artifact(project_id,group_id,session_id,task_id);
CREATE INDEX idx_notification_action ON notification(level,resolved_at,handled_at);
CREATE INDEX idx_acceptance_task ON acceptance_sheet(task_id,group_id);
`;

// v2 导入台账 DDL（M11-B2）——checkpoint 断点续跑表 + loss 台账表。
// 冻结件 §4 验收口径内（M1-1B：15 表 DDL、6 索引、FK/CHECK、schema_version、checkpoint 表）。
// checkpoint 五元组=path+mtime_ms+line_count+offset+schema_version；offset 存列名 line_offset
// （offset 是 SQL 关键字），行数语义：前 offset 行已处理，续跑从 offset+1 行起。
// loss 台账：缺归因/坏行/悬空引用追加记录，实体行归因列写 NULL，绝不造关联（冻结件 §1 口径）。
const IMPORT_LEDGER_DDL = `
CREATE TABLE import_checkpoint (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  line_offset INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE import_loss (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  reason TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

/** 迁移列表：v1 一次性建全 15 表 + 6 索引；v2 导入台账（checkpoint+loss）（v3+ 逐版追加）。入口 runMigrations(port, migrations)。 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "baseline-15-tables",
    up: (p) => p.exec(BASELINE_15_TABLES_DDL),
  },
  {
    version: 2,
    name: "import-ledger",
    up: (p) => p.exec(IMPORT_LEDGER_DDL),
  },
];
