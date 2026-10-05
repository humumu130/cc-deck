# cc-deck V2 开发计划表（可直派 worker 版）

> 日期：2026-10-05。依据：M1-0 冻结件 `docs/v2-m10-freeze.md`（15 表/35 命令/26 事件/8 批）、`v2-system-design.md` 0.9 §七～§十、`specs/083-org-model-final.md`、`specs/019-pm-duty.md` 与 m2 源码实况。每行都是一个独立任务书颗粒；验收标准均以“动词开头”，不得以“整体好用”替代。
> 档位：常规=普通 worker；熟手=relay/协议/存储经验；前端强=Web/Expo/Tauri UI；审查强=测试/安全/迁移。相同靶子默认串行，依赖列必须先完成。

## 1. M1-1 SQLite 数据地基

### M1-1A：StoragePort 与驱动骨架

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-A1 | SQLite 驱动与 StoragePort | `relay/src/storage/port.ts`、`sqlite.ts`（新）；`relay/package.json` | 创建临时 dataDir 数据库；验证 WAL/FK 开关生效、事务提交/回滚和重启可重开；不写生产目录 | — | 熟手/relay 熟手 |
| M11-A2 | 迁移 runner 与测试隔离 | `relay/src/storage/migrator.ts`（新）、`relay/scripts/test-storage.ts`（新） | 执行版本迁移一次；重复执行不改结果；失败保留前一版本；测试启动前断言 `CCR_DATA_DIR/CCR_ORG_DIR` 均为临时目录 | M11-A1 | 常规/测试强 |

### M1-1B：DDL、索引、checkpoint

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-B1 | 15 表 DDL 与约束 | `relay/src/storage/schema.ts`（新）、`relay/scripts/test-storage-schema.ts`（新） | 创建 15 张表和 6 个索引；逐项查询 FK/CHECK/唯一键；拒绝非法 task 状态、artifact existence_state、org_confirm status | M11-A1 | 熟手/SQLite 熟手 |
| M11-B2 | 导入 checkpoint 与 loss writer | `relay/src/storage/checkpoint.ts`、`loss-report.ts`（新） | 以 `path+mtime_ms+line_count+offset+schema_version` 断点；中断后续跑不重复；缺归因写 NULL 并追加 loss，不造关联 | M11-A2,M11-B1 | 熟手/迁移强 |

### M1-1C：org/project/group/member/confirm 导入

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-C1 | 组织域导入 | `<orgDir>/org.json`、`projects.json`、`boards/*.json`、`confirms.json` → `relay/src/storage/import-org.ts`（新） | 导入 project/group/group_member/member/org_confirm；stable_identity 按 `<orgDir>@<role>@<engine>`；历史 `actor:"leader"` 归 Leader member；重复运行行数不增 | M11-B2 | 熟手/组织域熟手 |
| M11-C2 | 组织导入等价 fixture | `relay/scripts/test-import-org.ts`（新）、`projects.ts:40-130` | 比对组四态/tier/single_card/hold/archive、board 依赖/gate、pending confirm；旧字段缺失按冻结 loss list 记录 | M11-C1 | 常规/断言强 |

### M1-1D：session/task/dispatch/lesson 导入

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-D1 | 会话与任务导入 | `events.ndjson`、transcript、`~/.claude/tasks` → `relay/src/storage/import-session-task.ts`（新） | 导入 session 当前态和 task；todo→backlog、doing→claimed、done→done；review_required=1 的完成候选进入 submitted；不把正文复制进 SQLite | M11-B2,M11-C1 | 熟手/relay 熟手 |
| M11-D2 | 派单与经验导入 | `dispatch-log.ndjson`、board.lessons → `import-dispatch-lesson.ts`（新） | 保留每条 dispatch 终态、attempt_no/parent 链、actor；lesson 保留 tags/source_dispatch_id；坏行只进 loss | M11-B2,M11-C1 | 熟手/账本熟手 |

### M1-1E：通知双层与值守边界

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-E1 | notification 双层导入 | `data/notifications.json`、`decision-notifications.json` → `import-notification.ts`（新） | 导入实体 resolved/handled；把 read_at/dismissed_at 写入 per-client state；多设备读态互不覆盖；合并重跑不重复 | M11-B2,M11-C1 | 熟手/通知账熟手 |
| M11-E2 | 值守审计边界 | `relay/src/leader-duty.ts`、`specs/019-pm-duty.md`、StoragePort 注记 | 证明 `duty-rounds.ndjson` 不进 SQLite/EventType/events；关闭/重启边界写清；不新增值守事实源 | M11-A1 | 常规/协议审查强 |

### M1-1F：acceptance 与 artifact 导入

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-F1 | 验收三表导入 | `relay/src/acceptance.ts:21-120` → `import-acceptance.ts`（新） | 导入 sheet/item/result/history；缺 task/group 写 NULL+loss；重复 history 不折叠；错误行不阻断其他 sheet | M11-B2,M11-C1 | 熟手/数据迁移强 |
| M11-F2 | artifact 复合键导入 | `relay/src/artifacts.ts:32-35`、`artifact-view.ts`、`deliverables.json` → `import-artifact.ts`（新） | 生成归一 source_id；按 `(source_id,normalized_path)` 幂等；exists/missing/unknown 映射正确；unknown 禁 open/download | M11-B2,M11-C1 | 熟手/安全强 |

### M1-1G：有界双读与 parity

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-G1 | 双读开关与影子比对 | `relay/src/storage/read-mode.ts`（新）、`session-manager.ts`/`projects.ts` 读入口 | 切换 `json|sqlite|shadow` 三档；shadow 只报告差异不改旧读；旧 JSON 永不被影子写覆盖 | M11-C2,M11-D2,M11-E1,M11-F2 | 熟手/relay 熟手 |
| M11-G2 | 导入 parity 报告 | `relay/scripts/test-m1-import-parity.ts`（新）、fixtures | 对比组/task/dispatch/notification/acceptance/artifact 六域数量、关键键、computeReady 等价；输出 loss 与差异稳定排序 | M11-G1 | 审查强/测试强 |

### M1-1H：地基里程碑与退役闸门

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M11-H1 | M1-1 地基收口 | `relay/scripts/test-m1-foundation.ts`（新）、StoragePort/DDL/import 全线 | 通过建库、迁移、断点续跑、重启、断电模拟、loss 报告；证明 SQLite current state 可重建三端所需投影 | M11-G2 | 熟手/验收强 |
| M11-H2 | 双读截止计划 | `relay/src/storage/read-mode.ts`、发布配置、迁移文档 | 标记旧 JSON 只读截止=M1-2 结束；保留冷备份；关闭 SQLite 写入时明确失败而非静默回写 JSON | M11-H1 | Leader/relay 熟手（串行锁） |

## 2. M1-2 编排闭环

> `session-manager.ts` 是单写者靶子；M12-1～M12-8 全部串行。M1-2 完成锚=“task.create 先入账→dispatch→执行→ACK/receipt→task/session 回写→验收/lessons”。

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M12-1 | orgAction adapter 与 4 命令 | `session-manager.ts:3949-4121`、`projects.ts:291`、`types.ts:663-698`、`ws-server.ts:138-179`、`cloud-client.ts:603-686` | 让新 4 命令均经单漏斗/adapter；补 ACK/权限/旧 relay error fixture；LAN/cloud 白名单一致 | M11-H1 | 熟手/协议强 |
| M12-2 | task.create→dispatch | `session-manager.ts:4404`、`projects.ts:393-425`、`types.ts` 新命令 payload | 先写 task 再生成 dispatch；依赖/gate 不满足时零 spawn；成功返回 command_id/dispatch_id/task_ref | M12-1 | 熟手/编排强 |
| M12-3 | dispatch 生命周期与 receipt | `org.ts:270-307`、`session-manager.ts:3722-3820,4404-4519` | 覆盖 dispatched/running/done/failed；重投生成新行并接 parent；ACK/receipt/events 一一对账；closeOpenDispatches 全出口不漏 | M12-2 | 熟手/账本强 |
| M12-4 | beads ready/gate/lesson 接线 | `projects.ts:66-96,430-580`、`session-manager.ts` dispatch 前置 | 验证依赖完成才 ready；gate 在场拒派；收口写 lesson；坏引用不误放行；确认卡仍是 gate 唯一清除面 | M12-3 | 常规/relay 熟手 |
| M12-5 | 引擎 profile/preflight 编排 | `engine-registry.ts`、`settings.ts:50-100`、`agent-jsonl.ts:437-460`、`session-manager.ts:578-629` | 选择 engine/provider/model；执行 Claude/Codex/JSONL preflight；ZCode 返回 unsupported；失败不写 running 假态 | M12-1 | 熟手/引擎强 |
| M12-6 | watchdog/值守喂活闭环 | `session-manager.ts:2481-2538,3722-3747,4946-5116`、`leader-duty.ts` | 在统一回合结束接值守；全 running 放行；四类异常触发一次 feed；写 duty audit 不进 EventBus；失败升级用户 | M12-3,M12-4 | 熟手/状态机强 |
| M12-7 | 验收与 artifact 归因回写 | `acceptance.ts`、`artifacts.ts`、`artifact-view.ts`、`session-manager.ts:1456-1754` | acceptance result 可回 task/group；artifact 缺归因保 NULL；unknown 禁操作；收单闭环更新 task 五态 | M12-3,M11-F1,M11-F2 | 熟手/数据一致性强 |
| M12-8 | 编排闭环真链路 | `relay/scripts/test-m1-orchestration.ts`（新）、M12 全部单写入口 | 跑通新任务→派单→worker→回执→验收→lesson；断线/重启后不丢；M1-2 结束前旧 JSON 只读截止 | M12-4,M12-5,M12-6,M12-7 | Leader/全链路验收强 |

## 3. M1-3 呈现与发布闸门

> M1-3 完成锚=三端读 SQLite 投影、SNAPSHOT parity、005 组件化合流、发布矩阵通过。客户端任务可并行；`web-console/index.html` 内部改动一律单 worker 串行。

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| M13-1 | SNAPSHOT 三出口 parity | `types.ts:370-420`、`ws-server.ts:887-930`、`cloud-client.ts:364-396,692-686` | 比对 LAN/phone/WAN 同字段；旧端缺字段降级；实体引用不塞全量正文；last_seq 缺口按 SNAPSHOT 恢复 | M12-8 | 熟手/协议强 |
| M13-2 | UPDATED delta 投影 | `types.ts:470-520`、`session-manager.ts:4391`、`projects.ts`、parity fixtures | 让 PROJECTS_UPDATED/BOARD_UPDATED 同时保旧字段和 entity_ref+delta；旧端忽略新字段；重复 delta 幂等 | M13-1 | 熟手/事件强 |
| M13-3 | Web 三域 SQLite 投影 | `web-console/index.html:3080-3160,4280-4370,4900-5000` | 渲染任务五泳道、通知 resolved/read 分离、项目/团队增量；断开重连后与 SNAPSHOT 一致；禁止假造静态实体 | M13-2 | 前端强/Web 单文件锁 |
| M13-4 | Expo 三域投影 | `expo-app/src/store.ts:80-110,198-240,520-600,2200-2240`、`screens/ListScreen.tsx`/`DetailScreen.tsx` | 显示同五泳道/通知/项目数据；消费 delta 与快照覆盖；旧 relay 缺字段隐藏能力，不渲染假入口 | M13-2 | 前端强/Expo |
| M13-5 | Desktop 壳与连接投影 | `desktop-tauri/src-tauri/src/main.rs:461-520,1160-1180`、内置 webview bridge | 验证内置 relay spawn 与数据目录/端口契约；断开、重启、旧 relay 均给可见状态；不新增端口 | M13-1 | 常规/Tauri 熟手 |
| M13-6 | 全局通知/产物/验收入口 | `web-console/index.html`、`expo-app/src/screens/DetailScreen.tsx`、`relay/src/artifact-view.ts` | 打开存在产物；unknown 禁预览/下载；通知动作不清零 resolved；验收链接回原 task/group | M12-7,M13-3,M13-4 | 前端强/跨端核对 |
| M13-7 | bundle 统一生成 | `relay/scripts/build-plugin.mjs`、插件 web 副本、两份 `relay.mjs` 产物 | 构建一次生成三端所需副本；产物 hash/版本一致；沙盒运行不写生产目录 | M13-3,M13-4,M13-5 | 熟手/构建强 |
| M13-8 | 发布闸门矩阵 | `relay/scripts/test-snapshot-parity.ts`、`test-cloud.ts`、`test-005-parity.ts`、发布清单 | 通过类型检查、测试套件、真链路、LAN/cloud/WAN、24h 断连/杀 App/旧 relay/dispatch 对账；失败可回到 M1-2 只读模式 | M13-6,M13-7 | Leader/发布验收强 |

## 4. 并行线待排期池

这些任务不改 M1-1 schema；若触碰 `session-manager.ts` 或 `web-console/index.html`，按靶子串行锁接入衔接视图。

| 单号 | 标题 | 靶子（文件/模块坐标） | 验收标准（动词开头、可独立判定） | 依赖（单号） | 建议档位与 worker 特质 |
|---|---|---|---|---|---|
| P42 | #42 引擎适配器一期收口 | `relay/src/agent-trae.ts`、`agent-qwen.ts`、`agent-codebuddy.ts`、`agent-jsonl.ts`、`engine-registry.ts`、`scripts/test-engine-adapters.ts` | 比对三引擎 spawn/stream/DONE/ERROR/activity/capability；preflight 失败返回 fail-closed；fixture 全过且不伪造 approval | M1-0 | 熟手/引擎强（与 M12-5 串行接触 registry 时） |
| P58 | #58 016 记档产品化收口 | `specs/016-design-sprint-report.md:30-49`、`web-console/index.html`、`expo-app/src`、`relay/scripts/test-005-ui-rows.ts` | 把空/加载/错误、键盘可达、选中态、通知轻动作等已裁定条目逐项变为可观察 UI；Web/Expo 同类位对查；探针逐项通过 | — | 前端强/视觉验收强；Web 靶子单 worker |
| P72 | #72 产物中心三端入口 | `relay/src/artifact-view.ts`、`artifacts.ts`、`ws-server.ts`、`web-console/index.html`、`expo-app/src/screens/DetailScreen.tsx`、Tauri bridge | 显示全局目录分组；复合键不串源；md/html 可预览、下载受 exists；删除/幽灵登记按安全策略拒绝；三端旧 relay 隐藏 | M13-1（协议依赖弱） | 前端强/安全强 |
| P75 | #75 新建会话引擎选择器 | `web-console/index.html:2437-2717,8480-8510`、`expo-app/src/screens/NewSessionModal.tsx:28-150`、`relay/src/types.ts` | 从 SNAPSHOT/profile 展示 engine/provider/model；无 capability 禁选；COMMAND_CREATE ACK 失败可见且不造会话；默认值跨端一致 | P42,M12-5 | 前端强/协议熟手；Web 单文件锁 |
| P81 | #81 多引擎权限抽象 | `relay/src/org.ts:14-83`、`agent-adapter.ts:340-380,1042-1070`、`types.ts`、`expo-app/src/screens/SettingsDrawer.tsx` | 以 capability/role 判定 org/profile/artifact；拒绝统一 forbidden ACK；Claude/Codex/JSONL/ZCode 能力差异可观察；旧端安全降级 | P42,M12-5 | 熟手/安全与权限强 |
| P83 | #83 组织拓扑 A/B 双模式 | `specs/083-org-model-final.md:1-70`、`org.ts`、`session-manager.ts:3949-4121`、`web-console/index.html` | 持久化全局 mode；A 直达 PM、B 薄 Leader 只路由聚合；切换失败保持旧模式；actor 与通知返回路径不串台 | M12-1,M12-6 | 熟手/组织模型强；session-manager 串行锁 |
| P84 | #84 伴随面四问机制化 | `specs/083-org-model-final.md:28-53`、`specs/019-pm-duty.md`、`relay/scripts/test-pm-companion.ts`（新） | 对影响/配套/失效/回退四问生成可验收清单；覆盖 PM、通知、派单、模式切换四域；每项能指向事实源/回退动作 | P83,M12-6 | PM/审查强；文档先行 |
| P71 | #71 值守产品化一期 | `relay/src/leader-duty.ts`、`projects.ts:393-580`、`session-manager.ts` 值守接线、`specs/019-pm-duty.md` | 把派单入 boards store；固化 actionable 候选序、全 running 休眠、异常唤醒、DUTY_RECEIPT；fixture 覆盖 blocked/all-running/continuation | M12-3,M12-6 | 熟手/状态机强；session-manager 串行锁 |

## 5. 衔接与拓扑执行序

1. **先行**：`M11-A1 → M11-A2 → M11-B1 → M11-B2`；同时启动不改 M1 schema 的 `P42`、`P58`、`P84` 文档/fixture 就绪单。`P75` 等 `P42`，`P83` 等 M12-1，`P71` 等 M12-6。
2. **地基并行**：完成 B 后，`M11-C1/C2`、`M11-D1/D2`、`M11-E1/E2`、`M11-F1/F2` 可分四条流水线并行；同一 importer 文件不得拆给多个 worker。
3. **地基锚**：`M11-G1 → M11-G2 → M11-H1` 标志 **M1-1 地基完成点**；`M11-H2` 只做退役闸门，和 M1-2 单写者串行。
4. **编排串行**：`M12-1 → M12-2 → M12-3 → M12-4`，随后 `M12-5/M12-6/M12-7` 仍按 `session-manager.ts` 单写者锁串行，最后 `M12-8` 标志 **M1-2 闭环点**。
5. **呈现交叉**：`M13-1 → M13-2` 后，Web、Expo、Tauri 可并行；Web 单文件内部串行，Expo 与 Tauri 不共享靶子。`P72/P75` 可分别插入客户端流水线，但不得改协议字段绕过 M13-1。
6. **发布锚**：`M13-6 → M13-7 → M13-8` 标志 **M1-3 呈现+发布闸门点**；`P42/P81/P83/P84/P71` 的新增协议或持久化必须在 M1-3 parity 前交付 fixture。
7. **无环检查**：M1-1 只依赖 M1-0；M1-2 只依赖 M1-1H1；M1-3 只依赖 M1-2 与客户端并行线；P75→P42、P83→M12-1、P84→P83、P71→M12-6 均为已排产单，不存在悬空依赖。

## 6. 交付前自查闸

- [ ] 每单验收均以动词开头、结果可观察，不使用“整体好用”等内部模糊词。
- [ ] `session-manager.ts`、`web-console/index.html` 的同靶子任务均显式串行；不同靶子才并行。
- [ ] 每单都有建议承接档：PM 负责设计/验收口径，H 负责前端，G 负责 relay/协议，J 负责测试/审查，Leader 只做核验/代提交或明确承担的 coder 单。
- [ ] M1-1 地基、M1-2 闭环、M1-3 发布三个里程碑均有唯一锚单。
- [ ] 每批任务书补齐目标、边界、纪律、自查、回单路径、验收点六件套；失败回滚目标已写在验收标准或批次说明中。

devplan done: M1 线 32 单/并行线 8 单/衔接 7 条
