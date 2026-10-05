# M1-0 契约冻结件终稿 + M1-1 批次拆解草案

> 版本：2026-10-05。依据已验收的 `pm-m10-inventory`；11 个开放问题全部按用户拍板/技术裁定生效。本文件只冻结契约与施工边界，不改代码。旧 JSON 双读截止为 M1-2 结束，之后保留冷备份、不再作为事实源。

## 1. 冻结红线

1. SQLite（better-sqlite3/WAL/FK/CHECK）是实体当前态唯一真相；`events.ndjson` 是广播/审计摘要；transcript 是消息正文真相；所有新 durable 写入经 `StoragePort`。
2. 迁移一次完成三态→五态：`todo→backlog(待认领)`、`doing→claimed(进行中)`、`done→done(完成)`；不保留旧态。`submitted` 仅由完成候选且 `review_required=1` 生成；`ready_to_install` 无存量自动生成。
3. 事件先复用 `PROJECTS_UPDATED`/`BOARD_UPDATED` 扩 payload 携 `entity_ref + delta`；`TASK_UPDATED` 等五个细事件不进 M1-0，M1-3 若需要另行注册并先做旧端 fixture。
4. `orgAction()` 是组织写入单漏斗；新 task/dispatch/lesson 命令只经 adapter 调现有咽喉，不建第二事实源。
5. artifact 主键为 `(source_id, normalized_path)`；`source_id=源注册名归一化`；`unknown` 禁下载、禁预览；同任务同 `delivery_group_key` 幂等。
6. 多 Leader 通知合并过渡期沿用 `mergeNotificationPair` 的 last-writer 形态（`created_at=min`），不引 generation/actor version；产品化留 v2 R 线。
7. `duty-rounds.ndjson` 独立 append-only，不进 SQLite、不进 EventType；M1-1 只冻结 StoragePort 边界注释。
8. 导入按“文件 mtime + 行数”checkpoint 断点重试；缺失 task/group 归因写 NULL，并进入 loss list，禁止造数据补归因。

## 2. DDL 定案（15 表）

所有时间为 INTEGER epoch-ms；JSON 为 TEXT 且入库前 schema 校验；`group_member` 是关系表，不替代 member/group 身份。

```sql
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
-- 迁移：todo→backlog，doing→claimed，done→done；review_required=1 的 done 候选→submitted。
-- blocked 不入 status；gate_reason 非 NULL 即派生态 blocked。
CREATE TABLE dispatch (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), group_id TEXT REFERENCES "group"(id),
  tier TEXT NOT NULL, target_member_id TEXT REFERENCES member(id),
  source_session_id TEXT REFERENCES session(id), actor TEXT NOT NULL, command_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('dispatched','running','done','failed')),
  receipt TEXT, attempt_no INTEGER NOT NULL DEFAULT 1,
  parent_dispatch_id TEXT REFERENCES dispatch(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- 一行状态机：重投新建一行、attempt_no+1、parent_dispatch_id 指向父；旧终态行永不删除。
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
```

## 3. 注册表终稿

### 3.1 命令（现存 35 条）

证据：WS 白名单 `relay/src/ws-server.ts:138-179`（33 条）；类型声明 `relay/src/types.ts:663-698`（35 条）。`COMMAND_ENGINE_PROFILE_UPDATE` 与 `COMMAND_ARTIFACT_GROUP_FETCH` 已声明且 manager 有 case，本冻结将其补入 LAN/cloud 白名单；以下 35 条全部为“保留”终态，其中两条带“补白名单”标记。

| # | 命令 | 终态 |
|---:|---|---|
|1|COMMAND_CREATE|保留|
|2|COMMAND_MESSAGE|保留|
|3|COMMAND_STOP|保留|
|4|COMMAND_CONTINUE|保留|
|5|COMMAND_REJECT|保留|
|6|COMMAND_EXT_MODE|保留|
|7|COMMAND_EXT_INPUT|保留|
|8|COMMAND_EXT_STOP|保留|
|9|COMMAND_DELETE|保留|
|10|COMMAND_RENAME|保留|
|11|COMMAND_ANSWER|保留|
|12|COMMAND_PAIR_START|保留|
|13|COMMAND_PAIR_CODE|保留|
|14|COMMAND_LOGIN_GRANT|保留|
|15|COMMAND_WATCH_GRANT|保留|
|16|COMMAND_PEERS|保留|
|17|COMMAND_PEER_KICK|保留|
|18|COMMAND_PEERS_IMPORT|保留|
|19|COMMAND_CLOUD_INFO|保留|
|20|COMMAND_PERM|保留|
|21|COMMAND_MODEL|保留|
|22|COMMAND_REFRESH_TODOS|保留|
|23|COMMAND_TODO_HIDE|保留|
|24|COMMAND_PIN_SESSION|保留|
|25|COMMAND_RESUME_SESSION|保留|
|26|COMMAND_IMPORT_PUSH|保留|
|27|COMMAND_ALLOW_RULE_REMOVE|保留|
|28|COMMAND_ORG_CONFIRM|保留|
|29|COMMAND_PROJECT_DETAIL|保留|
|30|COMMAND_ARTIFACT_FETCH|保留|
|31|COMMAND_SETTINGS_UPDATE|保留|
|32|COMMAND_ORG_ACTION|保留；orgAction 单漏斗|
|33|COMMAND_NOTIFICATION_ACK|保留|
|34|COMMAND_ENGINE_PROFILE_UPDATE|保留；补 LAN/cloud 白名单|
|35|COMMAND_ARTIFACT_GROUP_FETCH|保留；补 LAN/cloud 白名单|

新增候选（不计入上面的 35 条现存终态）：`COMMAND_TASK_CREATE`、`COMMAND_TASK_UPDATE`、`COMMAND_DISPATCH`、`COMMAND_LESSON_APPEND`。来源为 0.9 §七、§十 M1-2；四者均经 `orgAction/dispatch adapter`，不另开事实源，具体 payload 与权限在 M1-2 前注册。

### 3.2 事件（26 条）

证据：`relay/src/types.ts:451-477`。全部现存事件保留；`LEADER_DUTY_ROUND` 明确不注册。

| 终态 | 事件 |
|---|---|
|保留|SESSION_CREATED、SESSION_UPDATED、SESSION_HEARTBEAT、SESSION_WAITING、SESSION_WAITING_RESOLVED、SESSION_ERROR、SESSION_DONE、SESSION_LOG、SESSION_ACTIVITY、TASK_DONE、SESSION_DELETED|
|保留|SNAPSHOT、PAIR_REQUEST、PAIR_RESOLVED、PAIRED_DEVICE、USER_NOTE|
|保留|ACCEPTANCES_UPDATED、ALLOW_RULES_UPDATED、PROJECTS_UPDATED、BOARD_UPDATED、ORG_CONFIRM_UPDATED、DISPATCH_DONE、SETTINGS_UPDATED、NOTIFICATIONS_UPDATED、WATCHDOG、ARTIFACT_CHUNK|
|不注册|LEADER_DUTY_ROUND：写独立 `duty-rounds.ndjson`，不进 EventBus/events/SQLite|

`PROJECTS_UPDATED` 新 payload 草案（旧 `projects` 字段保留）：`{ projects, entity_refs?: [{entity_type:"project|group|member", entity_id, revision?}], delta?: {op:"upsert|patch|remove", entity_type, entity_id, fields?} }`。

`BOARD_UPDATED` 新 payload 草案（旧 `gid/board` 字段保留）：`{ gid, board, entity_refs?: [{entity_type:"task|lesson", entity_id}], delta?: {op:"upsert|patch|remove", entity_type:"task|lesson", entity_id, fields?} }`。旧端只读全量旧字段并忽略 `entity_refs/delta`；M1-0 不新增五个细事件。

## 4. Import loss list（M1-1 验收单）

| 表 | 旧来源→新去向 | 明确有损项/备案 |
|---|---|---|
| project | group.anchor/name→project | 无 project_id 的旧组按 `project` 由 anchor fingerprint 归并；无法归并=NULL+loss |
| member | headcount/session/dispatch actor→member、group_member | 旧 display/role 不完整；stable_identity 按 `<orgDir>@<role>@<engine>`，external_sid 可空；`actor:"leader"`→Leader member |
| group | projects.json groups[]→group | 无 workflow_profile 默认 engineering；headcount 是快照，不冒充成员；旧字段外无损 |
| group_member | headcount[]→关系表 | 旧成员无 joined/retired 时间时取 group.created_at；跨组历史写 archive_json |
| session | events/transcript/SessionState→session | 压缩事件缺的 runtime 字段取 NULL/{}；正文不导入 SQLite，保 transcript |
| task | boards.entries[]→task | todo/doing/done 一次性映射；缺 task_ref 用稳定迁移 id；旧 board 分区/颜色丢弃 |
| dispatch | dispatch-log.ndjson→dispatch | 每行保留终态；缺 task/group/command/actor 快照写 NULL/旧 actor；不丢 parent/attempt 若已有 |
| lesson | board.lessons[]→lesson | tags 保留；无 source_dispatch_id=NULL；文本不改写 |
| org_confirm | confirms.json→org_confirm | 已决历史保留；无法识别 kind/status 的行进入 loss，不猜决议 |
| acceptance_sheet | acceptances/*.json→sheet | 缺 task/group 归因=NULL+loss；sheet_key 保留，不进公开表单正文 |
| acceptance_item | rows[]→item | `task/item/criteria` 均保留；数组顺序成为 item_index；异常行拒入并记 loss |
| acceptance_result | results.history[]→result | 原提交元数据缺失由 NULL/迁移批 actor；重复历史按原序保留，不折叠 |
| artifact | deliverables.json+artifacts scan→artifact | source_id 按源注册名归一；缺归因 NULL；无法 stat=unknown；不造存在性、不合并跨源同路径 |
| notification | notifications.json→notification | 当前 lifecycle 字段映射；`read_at/dismissed_at` 不进实体，read/dismiss 下沉 client state |
| notification_client_state | 端侧历史（若无则空）→client_state | 旧 JSON 没有 per-device read 事实，迁移不推断；缺 client_id 记 loss |
| duty audit | 无旧事实→不导入 SQLite | `duty-rounds.ndjson` 由 019 自有生命周期；M1-1 只写 StoragePort 边界说明 |

每个导入器 checkpoint=`{source_path, mtime_ms, line_count, last_offset, schema_version}`；同一 `(source_path,mtime_ms,line_count)` 重跑必须幂等。迁移报告固定输出 `loss.json`/审计摘要，但 loss 不是业务事实源。

## 5. M1-1 批次拆解（8 批）

| 批 | 契约面/靶子 | 依赖 | 独立验收与回滚 |
|---|---|---|---|
|M1-1A|better-sqlite3 选型、`StoragePort`/事务/迁移 runner 骨架；新 `relay/src/storage/*`|M1-0|临时 dataDir 建库/重启可开；删除新 DB 回旧 JSON |
|M1-1B|15 表 DDL、6 索引、FK/CHECK、schema_version、checkpoint 表|A|DDL introspection 与坏迁移拒绝；rollback=删除未发布 DB |
|M1-1C|org/project/group/member/group_member/org_confirm 导入器|B|projects/confirm fixture 等价、member archive/identity 断言；失败保留 checkpoint+loss |
|M1-1D|session/task/dispatch/lesson 导入器；三态→五态、attempt 链|B|computeReady/状态映射/dispatch 终态逐行对账；旧 JSON 只读可重放 |
|M1-1E|notification 双层导入、client state、decision ledger 只读桥；duty-round boundary|B|resolved/handled/read/dismiss 分离、多设备不互覆；ledger 失败不改实体 |
|M1-1F|acceptance sheet/item/result 与 artifact composite key 导入|B|缺归因 NULL+loss、unknown 禁 open/download、复跑无重复；删除影子表回滚 |
|M1-1G|有界双读/影子读比对：SQLite current vs JSON projection；导入报告|C-F|完整快照 parity、mtime+行数断点、重启/断电 fixture；开关关闭即旧读 |
|M1-1H|回归/发布闸门；双读截止标记为 M1-2 结束、旧 JSON 转冷备份|G|旧端 SNAPSHOT parity、24h 重启/断线；回滚为只读冷备份，不恢复新写 JSON。（Leader 核验修正：原稿「T2/T3/V1」为 018 时代编号——T3 已并入 #36 装机验收、V1 已并入 v2 M1-3 发布闸门，均不在 M1-1 闸门范围）|

每批一个契约面、独立 commit/自测；A→B→(C-F 可并行，按文件 owner 分开)→G→H。C-F 不得共享同一 importer 文件；StoragePort/DDL 变更必须串行回到 B。worker 任务书必须包含目标、边界、纪律、自查、回单路径、验收点六件套。

## 6. M1-0 完成定义

- [ ] 005 词表与五泳道冻结；task migration fixture 证明无旧态残留。
- [ ] 15 表 DDL、6 索引、FK/CHECK 与 import loss list 一一对应。
- [ ] 35 条现存命令逐条入 registry；2 条半注册命令补 LAN/cloud 白名单。
- [ ] 26 条现存事件逐条入 registry；`PROJECTS_UPDATED/BOARD_UPDATED` 扩 payload 保旧字段；值守事件不入注册表。
- [ ] orgAction 单漏斗、notification 双层、StoragePort 边界、LWW 过渡语义均写入契约。
- [ ] M1-1 八批靶子、依赖、回滚目标与独立验收口径可直接派单。

freeze done: 表 15/命令 35 终态/loss 15 项/M1-1 批 8
