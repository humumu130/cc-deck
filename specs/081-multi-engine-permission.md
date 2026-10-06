# 081 多引擎权限模式抽象设计（草案）

- 日期：2026-10-06
- 状态：P81-doc 设计先行，供 P81-impl 拆批实现
- 范围：统一组织层权限档、引擎能力声明、三端呈现、环境护栏与迁移回退
- 不改动：`relay/src`、`specs/083-org-model-final.md`、`specs/019-pm-duty.md`

> 本文区分“当前已由仓库证实的能力”和“目标设计”。引擎原生档位只有在当前 relay 代码或明确 CLI 参数中出现时才记为已确认；未确认的原生档位不猜测、不在 UI 中假造。`~/.codex/config.toml` 仅作为敏感配置路径，不读取、不复制其中任何值。

## 1. 设计结论

采用 **A 案为外层契约、吸收 B 案的 native detail 元数据**：组织、任务书、审计和三端 UI 只依赖少量稳定的归一档位；适配器在能力矩阵中声明自己的原生细节、可否审批和可否切换。这样既能跨引擎比较“能否自动编辑”，又不会把 Claude 的审批能力假投射给 Codex/JSONL 引擎。

统一档位只代表 CC Deck 的安全意图，不保证每个引擎都能完成同等动作。映射失败时必须选择更保守档位或返回 `forbidden`，不得静默升权；没有能力声明的引擎按 fail-closed 处理。

2026-10-06 用户拍板：**混编团队新开卡的请求默认 `permissionMode=bypassPermissions`**。该拍板改变“请求默认值”，不取消环境、tier、角色、playbook、预算和 preflight 护栏。实现时必须同时记录 `requested_mode` 与 `effective_mode`，避免把“默认请求”误写成“无条件有效权限”。

## 2. 现状与术语边界

### 2.1 当前 relay 的稳定面

- 六枚举在 `relay/src/types.ts:25-35`：`claude`、`codex`、`trae`、`qwen-code`、`codebuddy`、`zcode`。
- EngineRegistry 当前只注册三类 JSONL 引擎（`trae`、`qwen-code`、`codebuddy`），见 `relay/src/engine-registry.ts:36-61`；Claude/Codex 由 `session-manager.ts` 的专用工厂路径承接，不能把“枚举存在”当成“Registry 已注册”。
- `AgentLike.setPermissionMode()` 当前只有四个 wire 值：`default`、`acceptEdits`、`plan`、`bypassPermissions`，见 `relay/src/agent-adapter.ts:334-351`。Claude 的 SDK 选项将 `permissionMode` 与 `allowDangerouslySkipPermissions` 分开传递，见 `relay/src/agent-adapter.ts:435-457`。
- `COMMAND_CREATE` 当前只接受显式 `bypassPermissions`，其他值回落为未传，见 `relay/src/session-manager.ts:1921-1937`。P81-impl 应把混编团队默认值放在服务端策略决策中，而不是依赖客户端勾选。
- 组织命令目前是粗粒度角色能力矩阵：`owner`/`operator`/`viewer` 与 `org:write`、`profile:write`、`artifact:read` 等，见 `relay/src/org.ts:17-24`、`relay/src/org.ts:54-80`。本文的 permission mode 是“工具/文件执行档位”，不能取代 actor capability。

### 2.2 归一词表

| CC Deck 归一档位 | 当前 Claude wire 映射 | 意图 | 默认风险 |
|---|---|---|---|
| `ask` | `default` | 命令与编辑逐项确认 | 最保守 |
| `plan` | `plan` | 只读规划、先出方案 | 低 |
| `edit-auto` | `acceptEdits` | 编辑免审，命令仍按引擎能力约束 | 中 |
| `full-auto` | `bypassPermissions` | 不经交互审批执行允许的命令与编辑 | 高 |

`permissionMode` 是兼容 wire 字段；`normalized_mode` 是组织层字段。两者同时出现时，以服务端计算的 `effective_mode` 为准。未来新增引擎不应直接向端上暴露一套未经审计的原生字符串。

## 3. 六引擎权限矩阵（按现状证据）

### 3.1 总表

| 引擎 | 原生档位/审批能力（已确认范围） | 配置落点证据 | 当前 relay 接入形态 | P81 设计结论 |
|---|---|---|---|---|
| Claude | SDK `permissionMode` 四档由 relay 透传；运行时有 `allow/deny/answer/hasPending` 能力 | `relay/src/agent-adapter.ts:334-351,435-457`；CLI 侧由 SDK 的 `permissionMode` 选项承接 | `AgentSession` 专用路径；创建、resume、revive 均携带 `permissionMode`，见 `relay/src/session-manager.ts:2596-2611,3141-3154,3219-3229` | 映射最完整；`full-auto` 仍受环境与策略闸门，不能因 SDK 支持就绕过组织权限 |
| Codex | 当前 relay **未确认任何可切换 native permission mode**；审批接口三口和 `setPermissionMode` 明确 no-op | 当前 spawn 仅见 `codex exec --json --skip-git-repo-check -C <cwd>`，见 `relay/src/agent-codex.ts:409-425,446-453`；preflight 只查 CLI/凭证/版本/JSONL，见 `:84-105` | `CodexAgentSession` 专用 headless `exec`；`approval=false` | 只允许声明式的 `ask`/观察或由部署明确证明的受限自动档；在 native flag 未经 preflight 验证前，不宣称 `full-auto` |
| Trae | 当前 relay 未确认原生权限档位，`approval=false`；待冒烟项明确包含“非交互/自动批准” | `relay/src/agent-trae.ts:4-26`；实际参数只有 `trae-cli run <prompt>`，`:37-50` | JSONL/文本 `JsonProcessAgentSession`，Registry 注册 | `ask` 只能表示“relay 不自动批准”；不能伪造 WAITING。自动档仅在未来 preflight 声明 capability 后开放 |
| Qwen Code | 当前 relay 未确认原生权限档位，`approval=false` | `relay/src/agent-qwen.ts:4-26`；当前参数为 `-p <prompt> --output-format json`，`:37-50` | JSONL `JsonProcessAgentSession`，Registry 注册；provider 走 profile/env | 先按无审批引擎处理；`edit-auto/full-auto` 只能在新增能力证据和映射 fixture 通过后开放 |
| CodeBuddy Code | 当前 relay 未确认原生权限档位，`approval=false`；decision channel 仍在待冒烟清单 | `relay/src/agent-codebuddy.ts:4-26`；当前参数为 `--print <prompt> --output-format stream-json`，`:37-55` | JSONL `JsonProcessAgentSession`，Registry 注册 | 无 decision channel 时不出现审批卡；自动档必须以 capability 为前置，不以 UI 选择为前置 |
| ZCode | 显式 unsupported/fail-closed；不是“有枚举就可用”的引擎 | `relay/src/agent-zcode.ts:15-32`：隐私/遥测 preflight 恒失败；`relay/src/engine-registry.ts:63-80`：未进入 definitions | 六枚举中存在，未进入 Registry；无可用 permission 接入 | 所有档位均 `unsupported`/`forbidden`；不得加入默认引擎列表，不得把失败映射成 `ask` 后继续执行 |

### 3.2 配置与秘密边界

1. Claude 的 permission mode 当前在 relay 创建 Agent 时作为 SDK 选项落入，不需要从用户配置文件读取秘密。
2. Codex 的敏感配置路径可记为 `~/.codex/config.toml`，但本设计不读取其内容；P81-impl 只能通过 CLI/preflight 的布尔结果或脱敏 capability 结果判断，不把 token、凭证原文、配置全文进入日志、SNAPSHOT 或审计。
3. Trae/Qwen/CodeBuddy 的当前配置面是命令路径、provider/base URL、密钥环境变量名等 `ProviderProfile`，见 `relay/src/agent-jsonl.ts:24-29,446-483`；环境变量只按名称引用，值不回显。
4. “原生档位未确认”是可观察状态，不是默认开放状态：能力矩阵必须携带 `permission_capability_state=confirmed|unverified|unsupported`，三端显示对应文案。

## 4. 两案对照与推荐

### 4.1 案 A：统一档位

组织层保存 `normalized_mode`，引擎适配器提供 `map(normalized_mode) -> native request`。四档为 `ask`、`plan`、`edit-auto`、`full-auto`；映射不到时只准降到更保守档或拒绝。

### 4.2 案 B：引擎原生透传

组织层保存 `engine`、`native_mode`、`capabilities` 和 `fallback`；UI 根据引擎展示原生档位。未知引擎或无 capability 只能显示 unsupported，不能由 UI 猜测档位。

### 4.3 四维评估

| 维度 | 案 A 统一档位 | 案 B 原生透传 | 判定 |
|---|---|---|---|
| 可观察性 | 跨引擎能比较意图和有效风险，但需暴露 `mapping_state` | 原生准确，但跨引擎无法比较“自动程度” | A 更适合作为审计主轴，B 作为 detail |
| 降级面 | 映射失败可统一保守降级或 `forbidden` | 每个引擎都要实现自己的回退，旧端容易误解 | A 的失败面更小 |
| 三端 UI 成本 | 四个稳定控件，展示 capability badge | 每个引擎一套动态控件与文案 | A 明显更低 |
| 审计留痕 | `requested/effective/normalized/native/reason` 可统一查询 | 原生字符串散落，难比较和审计 | A 更强 |

### 4.4 推荐：A 外层 + B native detail

落库最小结构：

```json
{
  "normalized_mode": "full-auto",
  "requested_mode": "bypassPermissions",
  "effective_mode": "edit-auto",
  "native_mode": null,
  "capability_state": "unverified",
  "engine": "qwen-code",
  "reason": "native_permission_not_confirmed",
  "policy_source": "mixed_team_default"
}
```

- `normalized_mode` 供组织策略和三端使用；`requested_mode` 保留兼容 wire 请求；`native_mode` 只有适配器确认后才填。
- Claude 可将 `full-auto` 映射为 `bypassPermissions`，但必须同时满足角色、tier、目录和环境策略。
- Codex、Trae、Qwen、CodeBuddy 在 `approval=false` 或 native 未确认时，不得将 `full-auto` 伪装成真实审批绕过；应显示 `unsupported/unverified` 并选择 `ask`/安全降级或 `forbidden`。
- ZCode 永远 fail-closed，不能通过手工传 `native_mode` 绕过 preflight。

## 5. 角色、tier 与合法组合

### 5.1 规则

- `CommandRole`（owner/operator/viewer）决定是否能写组织、profile、artifact；permission mode 决定引擎执行动作的自动化程度，二者必须同时通过。
- `team_pm` 负责分诊、派单、验收和回退；`worker` 执行已授权任务；`review_pm` 只审查/验收，默认不获得高风险自动执行；全局 Leader（如 B 模式薄 Leader）不因身份自动获得 worker 的执行档。
- `full-auto` 的合法性由 `(environment, tier, business_role, command_capability, engine_capability, policy)` 共同决定。单凭客户端传入 `bypassPermissions` 不得放行。

### 5.2 tier × 权限合法组合表

表中“可用上限”是允许请求的最高归一档位；“混编默认”是满足混编团队条件时新卡的请求默认，不等于生产环境必然有效。

| tier / 角色 | PM 默认 / 上限 | worker 默认 / 上限 | review_pm 默认 / 上限 | bypass 条件 |
|---|---|---|---|---|
| 咨询 | `plan` / `edit-auto` | `ask` / `edit-auto` | `plan` / `plan` | 默认禁止；需用户明确确认且只在沙盒短任务 |
| 随手办 | `edit-auto` / `full-auto` | `edit-auto` / `full-auto` | `plan` / `edit-auto` | 仅预授权 playbook、非生产目录、预算未超；未知风险 `review_only` |
| 正经立项 | `edit-auto` / `full-auto` | `edit-auto` / `full-auto` | `plan` / `edit-auto` | 必须有 group policy、环境闸门、引擎 capability 和审计；生产默认不接受 bypass |
| 暂缓/冻结 | `plan` / `plan` | `ask` / `ask` | `plan` / `plan` | 禁止自动执行；只能读、审查和收口 |
| 混编团队新开卡（PM/worker） | **请求默认 `bypassPermissions`** / 按所在 tier 上限 | **请求默认 `bypassPermissions`** / 按所在 tier 上限 | `plan` / `edit-auto` | **2026-10-06 用户拍板**；服务端仍做 tier、环境、capability、预算裁决，不能由默认值绕过护栏 |

### 5.3 默认值的精确定义

1. 新卡创建时，如果组被标记为 mixed-engine，服务端将缺省 `requested_mode` 物化为 `bypassPermissions`，并写入审计；不能只依赖 web/Expo 是否勾选。
2. `effective_mode` 随后由策略求值：沙盒且有 capability 时可保持 `full-auto`；生产 8787、无 capability、越 tier 或预算不足时，按配置选择安全降级到 `edit-auto/ask`，或返回 `forbidden`。显式请求越过允许上限时必须 `forbidden`，不静默接受。
3. `review_pm` 是例外角色：即使混编团队新开审查卡，也不继承 worker 的 bypass 默认，只接受 `plan` 或受限 `edit-auto`。

## 6. 安全边界与拒绝面

### 6.1 环境护栏

- **生产 8787**：默认禁止 `full-auto/bypassPermissions` 直接生效。服务端识别运行环境和工作目录后，显式 bypass 请求若无用户授权与生产策略许可，返回统一 `forbidden ACK`；混编默认请求可记录为 requested，但不得伪装为 effective。
- **沙盒**：允许按 tier、playbook、预算和引擎 capability 开放 `full-auto`。沙盒路径必须与生产目录隔离，测试不得写 `~/.cc-deck` 组织数据或真实 8787。
- **审计**：每次创建、切换、降级和拒绝记录 actor、command/session、engine/provider/model（不含秘密）、tier、environment、requested/effective mode、capability state、reason、preflight 版本和时间。
- **生产写操作**：permission mode 不替代 `org.ts` 的 `CommandRole`/`CommandCapability`。org/profile/artifact 写命令仍走原有单漏斗；无 capability 先返回 `forbidden`，不因 worker 有 bypass 就获得组织写权。

### 6.2 统一拒绝与旧端降级

| 场景 | relay 行为 | 客户端可观察结果 |
|---|---|---|
| actor/tier 越权 | `ok:false,error:"forbidden"`，带 `actor_role` 和 reason | 显示“无权使用该权限档”，不改变本地显示的有效档 |
| 引擎无 capability | `unsupported` 或安全降级；不得伪造 WAITING/approval | 显示“该引擎不提供交互审批/自动档未证实” |
| 旧客户端发送未知扩展字段 | relay 只读取已知 `permissionMode`，未知字段忽略 | 旧端仍看到已有四档；服务端不因未知字段升权 |
| 旧 relay 不识别 normalized 字段 | 发送兼容 wire 值前先由服务端求值；无法证明映射则安全降级/拒绝 | 不出现静默 bypass；ACK/状态说明原因 |
| preflight 失败 | 不创建或不切换会话，返回可诊断错误 | 会话保持旧有效档或回到 `ask`，不留半成功状态 |

### 6.3 生产与三端 UI

- Web 当前已有四档词表和危险二次确认，见 `web-console/index.html:3223-3231,9356-9400`；P81-impl 应把归一档位映射到该现有控件，增加 capability/effective/降级原因，不另造一套循环点击协议。
- Expo 新建会话当前由 `bypass` 布尔值决定是否传 `permissionMode`，见 `expo-app/src/screens/NewSessionModal.tsx:35-139`；要改为读取服务端 policy 默认与 effective ACK，不能仅把 checkbox 初值改成 true。
- Expo 设置抽屉当前没有统一引擎权限 policy 行，`SettingsDrawer.tsx:832-858` 的可见设置是雇员独立家；P81-impl 可在同一 relay 设置区新增只读能力摘要/策略入口，但不把个人偏好当组织权限事实源。

## 7. 接口与审计草案（供 P81-impl）

### 7.1 capability profile

```json
{
  "engine": "claude",
  "registered": true,
  "permission_modes": ["ask", "plan", "edit-auto", "full-auto"],
  "native_modes": ["default", "acceptEdits", "plan", "bypassPermissions"],
  "approval": true,
  "preflight_state": "confirmed",
  "fallback_mode": "ask"
}
```

对 JSONL 引擎，`approval:false`、`native_modes:[]`、`preflight_state:"unverified"` 必须真实反映当前代码，不得因为 UI 有四个按钮就补齐数组。ZCode 使用 `registered:false`、`preflight_state:"unsupported"`。

### 7.2 session policy record

```json
{
  "session_id": "...",
  "engine": "claude",
  "tier": "正经立项",
  "business_role": "worker",
  "requested_mode": "bypassPermissions",
  "normalized_mode": "full-auto",
  "effective_mode": "full-auto",
  "mapping_state": "confirmed",
  "policy_source": "mixed_team_default",
  "environment": "sandbox",
  "actor": "member-id",
  "reason": "allowed_playbook"
}
```

`effective_mode` 变更必须可追踪；拒绝也写审计，但不得创建一个声称已 bypass 的会话状态。provider、API key、Bearer token 等秘密只允许以环境变量名/布尔 preflight 结果出现。

### 7.3 P81-impl 必测 fixture

1. Claude：四档创建、resume、运行时切换，`requested/effective` 和审计一致。
2. Codex：创建与 `COMMAND_PERM` 均不得假造 approval；`setPermissionMode` no-op 的结果对端可见。
3. Trae/Qwen/CodeBuddy：无 native capability 时四档请求均不能冒充审批；未知自动档安全降级或 `forbidden`。
4. ZCode：枚举可解析但创建前 preflight 拒绝，且不进入默认引擎列表。
5. 混编新卡：缺省请求落为 `bypassPermissions`；生产 8787 不得 effective bypass，沙盒按策略可放行。
6. 旧客户端/旧 relay：未知扩展字段忽略但不升权；旧四档仍能看到有效安全状态。
7. 组织交叉：viewer、无 `profile:write` 的 actor、越 tier 的 worker 均收到统一 `forbidden ACK`，且不落半状态。

## 8. 回退与迁移

### 8.1 存量卡与旧配置

- 显式存量 `permission_mode` 原样保留；resume/revive 继续使用该值，避免升级后会话静默升权或降权。
- 缺失字段的存量卡按 `ask/default` 解析；只有新建且明确属于 mixed-engine 的卡才使用 2026-10-06 的 `bypassPermissions` 请求默认。
- 不强制重写旧 JSON、旧 session 或旧配置文件；新字段采用有界双读，完成一个版本周期后再按迁移计划退役旧读路径。
- 旧客户端只理解四个 wire 值时，服务端不得把 `normalized_mode` 原样下发给它；先映射到已知值或返回安全降级。

### 8.2 映射失败

1. 读取到未知 normalized/native 值：保留原始请求用于诊断，`effective_mode=ask` 或返回 `forbidden`，不继续创建高风险会话。
2. 引擎 preflight 从 confirmed 变为 unverified：暂停越权切换；当前回合不被伪造为已审批，下一次 resume 走安全档并记录原因。
3. 组织策略从允许变为禁止：不杀正在运行的 worker，不删除事实源；阻止下一次高风险动作，写通知/审计并等待用户确认。
4. P81 实施失败：保留现有四档 wire 契约，关闭新 normalized policy 入口；旧卡按原值运行，新混编卡不采用默认 bypass，直到策略闸门可验证。

## 9. P81-impl 交付边界

P81-impl 必须新增统一 permission policy 判定层，但不得在 Claude、Codex、JSONL 适配器中各自再造一套组织权限。实施顺序建议为：

1. capability/profile 类型与六引擎矩阵（先把 `registered`、`approval`、`preflight_state` 立住）；
2. org/tier/role/environment 求值与统一 forbidden ACK；
3. `COMMAND_CREATE` 服务端默认、resume/revive 兼容和审计；
4. Claude 映射与 Codex/JSONL/ZCode fail-closed；
5. Web/Expo effective 状态、旧端 fixture 和生产/沙盒隔离回归。

完成标准是：任何客户端都不能仅凭传入 `bypassPermissions` 获得越过策略的权限；混编新卡的默认请求可观测；无 capability 引擎不伪造审批；生产 8787 的降级/拒绝、审计与旧端兼容均有 fixture 锁定。
