# M1-0 契约冻结前置勘察：现状 inventory 与注册表草案

> 只读勘察，日期 2026-10-05。对照：`docs/v2-system-design.md` 0.9 §五～§十；源码证据均为 m2 工作树。任务书给出的 `ws-server.ts:132-163=28`、`types.ts:294-313=19` 已过时；当前实况是 WS 白名单 33 条、`CommandType` 35 条、`EventType` 26 条，以下以源码为准。

## 1. 持久化 inventory

约定：`瞬态`=重启可由别处重建/不应作为实体真相；`durable`=跨重启事实；`sidecar`=实体事实之外的兼容或审计账。

| 路径 | 写入方/证据 | 字段面 | 生命周期 |
|---|---|---|---|
| `data/token` | `config.ts:71-82` 首启生成/读取 | relay 主 token 字符串 | durable，凭证 |
| `data/bridge-token` | `config.ts:97-105` | hook bridge token | durable，凭证 |
| `data/last-cwd` | `config.ts:83-92`、`session-manager.ts:2553` | 最近有效 cwd | durable 配置 |
| `data/settings.json` | `settings.ts:1-3,50`、`session-manager.ts:685-694` | `employeeHome` | durable 配置 |
| `data/engine-profiles.json` | `settings.ts:50-51` 及 profile API | engine/provider/profile_ref/model/capabilities/enabled；禁止秘密字段 | durable 配置 |
| `data/allow-rules.json` | `allow-rules.ts:6,112` | 允许规则、pattern/label/scope | durable 配置 |
| `data/child-sessions.json` | `session-manager.ts:273-291,2753-2760` | relay 拉起的子 CLI sdk id 列表 | durable 运行索引，有上限 |
| `data/title-overrides.json` | `session-manager.ts:316-369,2220` | `relay_session_id -> 手动标题` | durable sidecar |
| `data/pinned-sessions.json` | `session-manager.ts:369-375,3368-3395` | relay session id 数组 | durable 用户偏好 |
| `data/events.ndjson` | `history.ts:100-113` append；启动压缩 `history.ts:70-84` | Envelope/会话事件审计与回放摘要 | durable append-log，但会压缩 |
| `data/notifications.json` | `session-manager.ts:715-751` | 结构化通知 lifecycle：key/kind/group/severity/source/actionable/created/resolved/handled | durable 投影账 |
| `data/decision-notifications.json` | `decision-notify.ts:188-264` | 注入/投递 ledger：key/revision/source_session/first_sent/reminded/resolved/handled/dismissed | durable 审计账；不作端上实体列表 |
| `data/deliverables.json` | `session-manager.ts:316-348,1499-1532` | sid/path/ts，ghost/unverified 兼容状态 | durable sidecar，最多保留窗口 |
| `data/acceptances/<id>.json` | `acceptance.ts:1-66` 登记方写 | id/title/created/preface/rows/notes/sheet_key | durable 业务实体 |
| `data/acceptances/<id>.results.json` | `acceptance.ts:86-120` 提交方写 | history[]，每行 i/verdict/note/提交元数据 | durable 结果历史 |
| `~/.cc-deck/artifacts/**` | `artifacts.ts:1-34` 外部 CLI/用户写；relay 扫描 | 文件本体；按 source/path 扫描，当前无 SQLite 索引 | durable 文件资产 |
| `~/.claude/tasks/<cli_sid>/<id>.json` | Claude CLI 写；`task-store.ts:1-35` 只读 | id/subject/status/activeForm/mtime | durable 外部 task source |
| `<orgDir>/CLAUDE.md` | `org.ts:115-209` 初始化/增量记忆 | 团队记忆与纪律文本 | durable 人读账 |
| `<orgDir>/org.json` | `org.ts:213-266` | version/leader_session_id/leader_sdk_id/employee_home/created/updated | durable relay identity/锚 |
| `<orgDir>/dispatch-log.ndjson` | `org.ts:270-307`；SessionManager 多出口 | ts/id/tier/target/project_anchor/status/receipt/session_id/actor | durable append-log；同 id 读侧取最后 |
| `<orgDir>/projects.json` | `projects.ts:141-172` | groups[] + trust_light | durable group 索引，全量写穿 |
| `<orgDir>/boards/<gid>.json` | `projects.ts:143-147,393-410` | gid/entries[]/lessons[]/updated_at；entry 三态、owner/dispatch/deps/gate | durable group board |
| `<orgDir>/confirms.json` | `projects.ts:150,580-625` | confirms[]：id/kind/title/reason/payload/status/created/decided | durable 人类决策队列；已决只留最近 200 |
| `duty-rounds.ndjson` | 当前代码未见写入口；019 目标要求独立审计 | 值守 round/claim/feed/receipt | **缺口**：不得进 EventType/events |
| transcript `~/.claude/projects/**.jsonl` | CLI/SDK 写，relay `history.ts`/adapter 读 | 原始消息、tool、result、message id | durable 消息真相；不可由 SQLite 摘要替代 |

## 2. 0.9 逐表差距

| 0.9 表 | 当前实体 | 缺列/多列/归并去向 |
|---|---|---|
| `member` | 无独立表；`ProjectHeadcountEntry`=`session_id/role/engine/model/provider`（`projects.ts:26-36`） | 缺 stable identity、business/command/task 三轴、joined/retired、heartbeat、archive；从 headcount 与 session/dispatch 固化成员快照导入 |
| `group` | `ProjectGroup`（`projects.ts:40-65`）+`projects.json` | 已有四态/tier/single_card/headcount/role_defaults/hold/archive；缺 project_id/workflow_profile、member archive 关系；迁移为 group 表 |
| `project` | 仅 group.anchor_dir/name，无独立 project 表 | 新建 `project`，group.project_id 外键；旧 name/anchor 先导入 |
| `task` | `BoardEntry`（`projects.ts:66-88`）三态 todo/doing/done | 依赖/gate 已有但字段名需规范化；缺五态、parent/session/task_ref/assignee/review 字段；board entries 导入 task，`blocked` 由 gate 派生 |
| `dispatch` | `DispatchEntry`（`org.ts:274-293`） | 缺 task/group/source session/command/attempt/history/actor 快照；dispatch-log 全量导入，不丢终态行 |
| `lesson` | 嵌套 `boards/<gid>.json.lessons[]`（`projects.ts:87-96`） | 目标独立 append-only 表；text/tags/source_dispatch_id 保留，补 group/task/created |
| `org_confirm` | `confirms.json` 已接近目标（`projects.ts:118-130`） | `kind`/payload/status 基本兼容；改唯一写面、partial pending index、decided_by/时间类型；旧文件全量导入 |
| `session` | 内存 `SessionState` + events/transcript + sidecars（`types.ts:160-240`） | 0.9 session 表承接运行态、usage/todos/subagents/pending/done/error；events 仅广播审计，transcript 保正文 |
| `acceptance_*` | 两文件实体/结果历史（`acceptance.ts:21-38,103-120`） | 结构可导入；需 acceptance_item/result/sheet 外键、用户凭证、版本与 task/group 归因 |
| `artifact` | `ArtifactItem`（`types.ts:145-159`）+deliverables.json+扫描目录 | 缺 `(source_id,normalized_path)` 主键、project/session/task/delivery_group_key、exists/missing/unknown 三态；文件本体留 FS，sidecar 导入 |
| `notification` | `NotificationItem`+`notifications.json`，另有 decision ledger | SQLite 结构化实体与投递审计双层；`read_at` 属端侧状态表，alert badge 派生，不落列；decision ledger 保审计 |

## 3. 命令注册表三态

证据：WS 白名单 `ws-server.ts:138-179`；类型总表 `types.ts:663-698`。以下“保留”表示进入 M1-0 终稿；“保留/补白名单”表示类型已有但 LAN/cloud 入口当前漏放。

| 状态 | 命令（全列） | 处理 |
|---|---|---|
| 保留 | `COMMAND_CREATE`, `COMMAND_MESSAGE`, `COMMAND_STOP`, `COMMAND_CONTINUE`, `COMMAND_REJECT`, `COMMAND_EXT_MODE`, `COMMAND_EXT_INPUT`, `COMMAND_EXT_STOP`, `COMMAND_DELETE`, `COMMAND_RENAME`, `COMMAND_ANSWER` | 会话生命周期/输入/审批；沿用现有 ACK 与幂等 command_id |
| 保留 | `COMMAND_PAIR_START`, `COMMAND_PAIR_CODE`, `COMMAND_LOGIN_GRANT`, `COMMAND_WATCH_GRANT`, `COMMAND_PEERS`, `COMMAND_PEER_KICK`, `COMMAND_PEERS_IMPORT`, `COMMAND_CLOUD_INFO` | 配对/设备/云桥；LAN/cloud 共用白名单 |
| 保留 | `COMMAND_PERM`, `COMMAND_MODEL`, `COMMAND_REFRESH_TODOS`, `COMMAND_TODO_HIDE`, `COMMAND_PIN_SESSION`, `COMMAND_RESUME_SESSION`, `COMMAND_IMPORT_PUSH`, `COMMAND_ARTIFACT_FETCH` | 配置/任务/恢复/产物读取 |
| 保留 | `COMMAND_ALLOW_RULE_REMOVE`, `COMMAND_ORG_CONFIRM`, `COMMAND_PROJECT_DETAIL`, `COMMAND_ORG_ACTION`, `COMMAND_NOTIFICATION_ACK`, `COMMAND_SETTINGS_UPDATE` | 018/现行 M2 业务命令；orgAction 仍是单漏斗，confirm 是用户唯一决议写面 |
| 保留/补白名单 | `COMMAND_ENGINE_PROFILE_UPDATE`, `COMMAND_ARTIFACT_GROUP_FETCH` | `types.ts:697-698` 已声明，但不在 `ws-server.ts:138-179`；M1-0 必须决定补入 LAN/cloud 或显式废弃，不能保持半注册 |
| 新增候选 | `COMMAND_TASK_CREATE`, `COMMAND_TASK_UPDATE`, `COMMAND_DISPATCH`, `COMMAND_LESSON_APPEND` | 0.9 §七、§十 M1-2；建议先经 orgAction/dispatch 单写者 adapter，不另开事实源 |
| 废弃 | 无当前命令 | 旧客户端未知命令必须统一 error ACK；删除须有旧端兼容 fixture |

## 4. 事件注册表三态

证据：`types.ts:451-477`、`EventPayloadMap:480-520`。现有 26 项全部暂保留；瞬态与 durable 归属不得混写。`SNAPSHOT` 仍是三端投影，`events.ndjson` 不承实体当前态。

| 状态 | 事件（全列） | 归属/备注 |
|---|---|---|
| 保留 | `SESSION_CREATED`, `SESSION_UPDATED`, `SESSION_HEARTBEAT`, `SESSION_WAITING`, `SESSION_WAITING_RESOLVED`, `SESSION_ERROR`, `SESSION_DONE`, `SESSION_LOG`, `SESSION_ACTIVITY`, `TASK_DONE`, `SESSION_DELETED` | 会话/任务流；heartbeat/activity 按 transient 语义，DONE/ERROR 为回合终态 |
| 保留 | `SNAPSHOT`, `PAIR_REQUEST`, `PAIR_RESOLVED`, `PAIRED_DEVICE`, `USER_NOTE` | 快照/配对/用户注记；旧端忽略未知字段 |
| 保留 | `ACCEPTANCES_UPDATED`, `ALLOW_RULES_UPDATED`, `PROJECTS_UPDATED`, `BOARD_UPDATED`, `ORG_CONFIRM_UPDATED`, `DISPATCH_DONE`, `SETTINGS_UPDATED`, `NOTIFICATIONS_UPDATED`, `WATCHDOG`, `ARTIFACT_CHUNK` | M2/018 现有投影；`DISPATCH_DONE`/`ARTIFACT_CHUNK` 是在线瞬态，离线由 facts+SNAPSHOT 恢复 |
| 新增候选 | `TASK_UPDATED`, `DISPATCH_UPDATED`, `ARTIFACTS_UPDATED`, `LESSONS_UPDATED`, `MEMBERS_UPDATED` | 0.9 §八、§十实体引用增量事件；M1-0 需冻结是否复用 `BOARD_UPDATED/PROJECTS_UPDATED`，不可两套并行 |
| 废弃 | 无 | `LEADER_DUTY_ROUND` 明确不进入 EventType/events；值守写独立 `duty-rounds.ndjson`（019） |

## 5. M1-0 冻结草案

### 5.1 SQLite DDL（字段级草案）

```sql
CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir_fingerprint TEXT NOT NULL UNIQUE, anchor_dir TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, ts INTEGER NOT NULL);
CREATE TABLE member (id TEXT PRIMARY KEY, stable_identity TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, business_role TEXT NOT NULL, command_role TEXT NOT NULL, task_participation TEXT NOT NULL, engine TEXT, provider TEXT, model TEXT, external_sid TEXT, joined_at INTEGER NOT NULL, retired_at INTEGER, last_heartbeat_at INTEGER, last_business_log_at INTEGER, status TEXT NOT NULL, archive_json TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL);
CREATE TABLE "group" (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), name TEXT NOT NULL, anchor_dir TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','active','parked','archived')), tier TEXT NOT NULL, single_card INTEGER NOT NULL, headcount_json TEXT NOT NULL DEFAULT '[]', role_defaults_json TEXT NOT NULL DEFAULT '{}', hold_suggested_at INTEGER, archive_note TEXT, workflow_profile TEXT NOT NULL DEFAULT 'engineering', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, relay_session_id TEXT, group_id TEXT REFERENCES "group"(id), member_id TEXT REFERENCES member(id), external_sid TEXT, engine TEXT, provider TEXT, model TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, runtime_state_json TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE task (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), group_id TEXT REFERENCES "group"(id), session_id TEXT REFERENCES session(id), parent_task_id TEXT REFERENCES task(id), origin TEXT NOT NULL, external_sid TEXT, external_task_file_id TEXT, task_ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', scope_json TEXT NOT NULL DEFAULT '{}', handoff TEXT, assignee_id TEXT REFERENCES member(id), branch TEXT, artifact_id TEXT, depends_on_json TEXT NOT NULL DEFAULT '[]', gate_reason TEXT, gate_opened_at INTEGER, review_required INTEGER NOT NULL DEFAULT 0, review_status TEXT, workflow_profile TEXT, status TEXT NOT NULL, deleted_at INTEGER, ts INTEGER NOT NULL);
CREATE TABLE dispatch (id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), group_id TEXT REFERENCES "group"(id), tier TEXT NOT NULL, target_member_id TEXT REFERENCES member(id), source_session_id TEXT REFERENCES session(id), actor TEXT NOT NULL, command_id TEXT, status TEXT NOT NULL, receipt TEXT, attempt_no INTEGER NOT NULL DEFAULT 1, parent_dispatch_id TEXT REFERENCES dispatch(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE lesson (id TEXT PRIMARY KEY, group_id TEXT REFERENCES "group"(id), task_id TEXT REFERENCES task(id), text TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', source_dispatch_id TEXT REFERENCES dispatch(id), created_at INTEGER NOT NULL);
CREATE TABLE org_confirm (id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT REFERENCES "group"(id), title TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT);
CREATE TABLE acceptance_sheet (id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), group_id TEXT REFERENCES "group"(id), title TEXT NOT NULL, created_at INTEGER NOT NULL, sheet_key TEXT);
CREATE TABLE acceptance_item (id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL REFERENCES acceptance_sheet(id), item_index INTEGER NOT NULL, task TEXT NOT NULL, criteria TEXT NOT NULL, UNIQUE(sheet_id,item_index));
CREATE TABLE acceptance_result (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES acceptance_item(id), verdict TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, actor TEXT NOT NULL);
CREATE TABLE artifact (source_id TEXT NOT NULL, normalized_path TEXT NOT NULL, project_id TEXT REFERENCES project(id), session_id TEXT REFERENCES session(id), task_id TEXT REFERENCES task(id), delivery_group_key TEXT, size INTEGER, kind TEXT NOT NULL, existence_state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(source_id,normalized_path));
CREATE TABLE notification (id TEXT PRIMARY KEY, project_id TEXT, group_id TEXT, session_id TEXT, level TEXT NOT NULL, category TEXT NOT NULL, payload_json TEXT NOT NULL, dismissed_at INTEGER, handled_at INTEGER, resolved_at INTEGER, condition_key TEXT, created_at INTEGER NOT NULL);
CREATE TABLE notification_client_state (notification_id TEXT NOT NULL REFERENCES notification(id), client_id TEXT NOT NULL, read_at INTEGER, PRIMARY KEY(notification_id,client_id));
CREATE INDEX idx_task_ready ON task(group_id,status,gate_reason); CREATE INDEX idx_dispatch_open ON dispatch(group_id,status); CREATE INDEX idx_confirm_pending ON org_confirm(status) WHERE status='pending'; CREATE INDEX idx_artifact_attr ON artifact(project_id,session_id,task_id); CREATE INDEX idx_notification_action ON notification(level,resolved_at,handled_at); CREATE INDEX idx_acceptance_sheet_task ON acceptance_sheet(task_id);
```

### 5.2 注册表终稿建议

1. 先冻结一份机器可读 registry：命令名、payload schema、权限/capability、幂等键、ACK error、事件名、durable/transient、Snapshot 旧端降级。
2. `CommandType` 的 2 个 typed-only 命令要么补 LAN/cloud 白名单，要么从类型移除；不得仅靠 manager case 存在。
3. org/profile/artifact 写操作统一经过现有单写者/adapter；`COMMAND_ORG_ACTION` 映射到 `orgAction()`，不建第二咽喉；actor/device 必入审计。
4. `NOTIFICATIONS_UPDATED` 投影 `notification` 实体；`decision-notifications.json` 仅注入/投递审计；`read_at` 只进 client state；值守审计独立文件。
5. 新增事件先做 payload/旧端 fixture，再改三出口 SNAPSHOT parity；事件只携 entity reference + delta，不塞全量正文。

## 6. 冻结前开放问题

1. SQLite canonical schema 与旧 JSON import 的逐字段损失清单、双读仅保留一个版本周期的截止版本。
2. `todo/doing/done` 到 `backlog/claimed/submitted/ready_to_install/done` 的迁移规则；`submitted` 与 `review_required/review_status` 的具体判定。
3. `COMMAND_ENGINE_PROFILE_UPDATE`、`COMMAND_ARTIFACT_GROUP_FETCH` 是否进入 LAN/cloud 白名单；新增 task/dispatch/lesson 命令是否只走 adapter。
4. 新增实体事件采用 5 个细事件还是 `PROJECTS_UPDATED/BOARD_UPDATED` 扩 payload；三端旧客户端的降级行为。
5. member stable_identity、退休/复活、跨组 archive 与 timeline join 的唯一键；旧 `actor:"leader"` 映射规则。
6. dispatch attempt 是一行状态机还是独立 attempt 表；command_id/receipt/actor 快照和重投/取消终态。
7. artifact source_id 的生成与跨源合并边界；`unknown` 是否允许下载/预览（建议禁止）；delivery_group_key 的唯一性。
8. 多 Leader 并发写 notification/decision ledger 的 merge 语义：当前 `mergeNotificationPair` 为 current/incoming 合并且 `created_at` 取 min，需决定是否引入 generation/actor 版本。
9. 端侧通知读态是否单独建 SQLite client state、是否允许多设备互相覆盖；`resolved` 与 `read/dismissed` 的 UI 语义。
10. `duty-rounds.ndjson` schema、轮转/重启恢复与 StoragePort 边界；019 值守字段何时从 JSON 过渡入库。
11. `acceptance`、transcript、artifacts 文件本体的迁移失败重试/幂等，以及 artifact/acceptance 的 task/group 归因补录策略。

## 7. 结论

M1-0 可冻结的现状基线：会话/配对/验收/通知/组织/产物均已有文件事实源，但 SQLite 目标表尚未落地；命令入口存在“类型已声明但 WS 未白名单”的半注册；事件现有 26 项足以支撑过渡，但 task/dispatch/artifact/lesson/member 增量事件需在 M1-0 明确取舍。先冻结词表、字段、registry 与 import loss list，再进入 M1-1；本勘察不建议提前新增 JSON 事实源。

m10 done: 文件 24 项/命令 35 态/事件 26 态/开放问题 11
