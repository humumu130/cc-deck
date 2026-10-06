# B0 SNAPSHOT parity matrix

实测基线：2026-10-05。三出口均使用 `SnapshotPayload`；旧 relay/旧 Expo 对新增字段按缺失降级，未知字段不阻断快照。

| 字段族 | LAN (`relay/src/ws-server.ts:892-923`) | cloud phone (`relay/src/cloud-client.ts:377-405`) | WAN (`relay/src/cloud-client.ts:704-711`) | 旧 relay 行为 | Expo 镜像字段 | 缺失降级 |
|---|---|---|---|---|---|---|
| `sessions` | 有，`mgr.snapshot()` | 有，`this.mgr.snapshot()` | 有，`this.mgr.snapshot()` | 必有 | `SessionState[]` | 空数组 |
| `sessions[].activity` / `activity_capabilities` | 随会话状态可选 | 随会话状态可选 | 随会话状态可选 | 缺失 | `StatusDockState` / `ActivityCapabilities` optional | 仅展示旧状态行 |
| `logs` / `logs_truncated` | 有，预算日志 | 有，预算日志 | 有，预算日志 | `logs` 有，截断标记可缺失 | `LogEntry[]`、`occurred_at?` | 只显示可用日志 |
| `server_time` | 有 | 有 | 有 | 有 | `SnapshotPayload.server_time` | 不渲染服务端时钟 |
| `schema_version` | `1` | `1` | `1` | 缺失视为旧协议 | optional `number` | 按旧能力集合处理 |
| `models` | 有，`listModels(mgr.cfg.model)` | 有，`listModels(this.mgr.cfg.model)` | 有，`listModels(this.mgr.cfg.model)` | cloud phone/WAN 旧版本缺失 | optional `string[]` | 空模型列表/沿用默认模型 |
| `homedir` | 有 | 有 | 无（WAN 最小快照） | 可能缺失 | optional `string` | 不展示路径提示 |
| `deliverables` | 有 | 有 | 无（WAN 最小快照） | 缺失=关闭/隐藏 | optional `boolean` | 隐藏输出物能力 |
| `acceptances` | 有 | 有 | 无（WAN 最小快照） | 缺失=空表 | optional `unknown[]` | 不显示验收入口 |
| `relay_dev` / `relay_name` | 按配置可选 | `relay_dev` 有，名称按扩展可选 | 无 | 缺失使用旧 endpoint 标识 | optional string | 不做跨源身份归并 |
| `projects` / `org_confirms` | 有 | 有 | 无（WAN 最小快照） | 缺失=无组织域 | optional project/confirm arrays | 隐藏团队与确认卡 |
| `boards` | 当前未内嵌 | 当前未内嵌 | 未内嵌 | 详情命令按需拉取 | optional `ProjectBoard[]` | 走详情请求 |
| `notifications` | 类型已冻结，当前未装配 | 类型已冻结，当前未装配 | 类型已冻结，当前未装配 | 缺失=无通知投影 | optional `NotificationItem[]` | 空通知列表 |
| `source_capabilities` | 类型已冻结，当前未装配 | 类型已冻结，当前未装配 | 类型已冻结，当前未装配 | 缺失=旧能力推断 | optional `SourceCapabilities` | 按字段存在性降级 |

## B0 结论

- 本批修复的不对称为 `models`：LAN、cloud phone、WAN 三出口统一装配；并统一携带 `schema_version: 1`。
- cloud phone 同步补齐 `homedir`；WAN 保持最小手表快照，不把路径/组织/验收等非手表能力强行塞入。
- `notifications`、`source_capabilities`、`boards` 只冻结类型并记录当前未装配，业务投影属于后续批次，不在 B0 偷接线。
- 新字段均为可选；旧 relay 缺字段时客户端保持现有列表/时间线行为，不能把缺失误判为空的业务事实。
