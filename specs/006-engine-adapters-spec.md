# CC Deck 预置 Agent 引擎第一期适配器规格

- 文档编号：`006`
- 日期：2026-10-03
- 状态：设计冻结候选，供 Claude 实现者拆批执行
- 范围：新增 Trae、Qwen Code、CodeBuddy Code、ZCode 四个引擎适配器；保留 Claude、Codex 行为不变
- 纪律：本文件只定义架构、契约、验证和实施拆解，不直接修改 `relay/src` 实现

> 本规格中的“已确认”来自当前仓库源码与 `test-codex` 的现状盘点；CLI 命令、事件字段和原生续接能力如果没有被仓库或一次真实 `--help`/冒烟确认，统一标注“待冒烟核实”，不得当作稳定契约硬编码。

## 0. 设计结论先行

1. 新引擎不进入 `SessionManager` 的业务分支堆叠，而是注册到统一的 `EngineRegistry`/spawn 工厂；编排层只依赖现有 `AgentLike` 和 `AgentCallbacks`。
2. 有原生 resume 的引擎保存原生会话锚点；没有 resume 的引擎统一使用“上下文重注入”层，将最近会话状态、任务清单、输出物和 M2 派单纪律包装为下一次 fresh spawn 的首条输入。
3. CLI 输出以“宽松 JSON/JSONL 事件映射器”接入；未知事件只能记录诊断日志，不得阻塞主回合，不得因为一个未知字段使会话卡死。
4. provider 配置采用“引擎命令 + provider 环境变量映射”的配置面。`base_url`、`api_key` 只有在目标 CLI 明确支持对应变量或 flag 时才注入；不把 Claude SDK 的配置假设外溢到其他引擎。
5. ZCode 以隐私安全为最高优先级：CC Deck 默认关闭遥测；无法确认关闭成功时，在非显式用户 opt-in 下拒绝启动，并在设置和错误中显示警示。
6. 第一期不承诺所有引擎都具备 Claude 同等的审批、图片、子 Agent、diff 和 token 统计能力；能力缺失必须通过能力位和可见的降级状态表达，不能伪造 WAITING 或统计数据。

## 1. 现状盘点：接入面与不可破坏契约

### 1.1 `AgentAdapter`/`AgentLike` 契约

当前最小编排接口位于 `relay/src/agent-adapter.ts:133` 和 `relay/src/agent-adapter.ts:174`。新适配器必须实现以下面向 `SessionManager` 的行为：

| 契约 | 要求 | 不满足时的口径 |
|---|---|---|
| `id` | 暴露逻辑会话当前的 CLI/SDK 锚点；首次初始化前可使用临时值，但收到原生 session/thread id 后必须回调落盘 | 无锚点只能走重注入模式，不能声称支持原生 resume |
| `startedAt` | 记录当前适配器实例启动时间 | 用于状态与看门狗诊断 |
| `ended` | `stop()` 后为 `true`；干净的单回合进程退出不等同于逻辑会话结束 | 误置 `true` 会使下一条消息无法续跑 |
| `sendMessage(text, images?, echo?)` | 消息回显、图片/文件能力和排队语义必须明确；不能并发启动两个回合 | 回合中消息排队并在当前回合收口后串行执行 |
| `allow/deny/answer` | 支持原生审批时映射到 CLI；不支持时恒返回 `false`，且不产生假 `WAITING` | 未支持能力要在会话卡上展示“该引擎不提供交互审批” |
| `stop()` | 先收口 relay 状态，再杀进程树；幂等 | 不得留下孤儿 CLI 或悬挂 dispatch |
| `setPermissionMode()` | 能切换时执行；不能切换时返回可诊断错误或明确 no-op | 不得声称切换成功 |
| `hasPending?()` | 只有存在真实等待请求才为 `true` | 无审批引擎恒为 `false` |
| `childPid?` | 子进程引擎必须暴露根 PID，供 CPU 采样和杀树 | 无 PID 时看门狗退化为时间窗放弃，不强行杀错进程 |

### 1.2 `AgentCallbacks` 事件契约

`relay/src/agent-adapter.ts:133-164` 定义的回调是跨引擎唯一事件面。适配器应将 CLI 事件映射到以下语义，而不是把各家原始 JSON 直接泄漏到端上：

- `onInit(sdkSessionId, model, permissionMode?)`：逻辑会话首次建立或原生 resume 重新初始化时回调。`sdkSessionId` 是可续接锚点；`model` 是真实可确认的模型名，无法取得时填引擎显示名并注明来源。
- `onStatusChange(status, actionSummary)`：只允许 `WORKING`、`WAITING`、`DONE`、`ERROR`。工具启动、模型生成、文件修改、回合开始均至少能给出一个可读摘要。
- `onWaiting`/`onWaitingResolved`：只在确实存在用户可决策的等待请求时使用；把“CLI 正在运行”误映射为等待是 P0 错误。
- `onStats`、`onArtifacts`、`onTodos`、`onSubagents`：有可靠事件或本地扫描依据才上报；缺失时保持空/未知，不能从普通文本猜造。
- `onUsage`：回合聚合 token 用量；无法取得则不发伪造的零值，端上显示“该引擎未提供”。
- `onContext`：每次 API 调用/回合可取得上下文水位时上报；只有总量而没有水位时不冒充水位。
- `onLog(kind, text, meta)`：保留正文、工具、思考、系统、错误、用户回显的统一 kind；原始事件必要时只进受控 debug 日志。
- `onTurnEnd(ok, reason, durationMs)`：每个逻辑回合恰好一次；`ok=true` 代表当前回合完成，不能等同整个会话终结。
- `onSessionEnd(reason)`：仅在逻辑会话终结、首回合初始化失败或用户 stop 时触发。单回合 CLI 正常退出而逻辑会话仍可继续时不得触发。

建议第一期补充但不改变旧调用方的能力描述：

```ts
interface EngineCapabilities {
  nativeResume: boolean;
  interactivePermission: boolean;
  images: "native" | "path-in-prompt" | "unsupported";
  files: "native" | "path-in-prompt" | "unsupported";
  streaming: "events" | "stdout" | "none";
  usage: "exact" | "partial" | "none";
  artifacts: "events" | "diff-scan" | "none";
  todos: "events" | "file-scan" | "none";
}
```

能力位用于 UI、测试和降级，不替代 `AgentLike` 方法；旧客户端不识别时按缺省能力处理。

### 1.3 Claude 与 Codex 的实现参照

- Claude `AgentSession` 位于 `relay/src/agent-adapter.ts`：使用 SDK `query` 常驻流，支持 `spawn/resume`、权限回调、todo、usage、上下文水位、子 Agent、输出物、流式日志和权限模式。`childEnv()` 统一补 PATH、`CCR_RELAY_CHILD=1`、`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`，可选注入 `CLAUDE_CONFIG_DIR`。
- Claude 的看门狗依赖 child PID、`lastProgressAt`、`streamGen`、`resumePending`、`unacked` 等状态；新引擎不能只靠“进程还活着”判断有进展。
- Codex `relay/src/agent-codex.ts` 是目前第二个真实适配器：一回合一进程，逻辑会话锚点是 `thread_id`，调用为 `codex exec --json ...`，prompt 走 stdin；`thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error` 由 `CodexEventMapper` 映射。
- Codex 的关键经验必须复用：resume 也会重发 `thread.started`；干净 turn 退出不发 `onSessionEnd`；零事件崩溃要走 `onTurnEnd(false)`；回合中输入必须排队；CI 测试用 shell stub，不拉真 CLI。

### 1.4 `SessionManager` 中 engine 字段的完整链路

当前链路位置和一期扩展点如下：

1. `COMMAND_CREATE` 在 `relay/src/session-manager.ts:1583` 接收 `payload.engine`，当前只白名单 `codex`，未知值按 Claude 兼容路径处理；应改为由 `SessionEngine`/registry 做严格白名单，未知值返回可行动错误，不静默落回错误引擎。
2. `create()` 在约 `2162` 行将 engine 写入 `SessionState`，再在约 `2213` 行调用 `newAgent()`；创建帧和快照必须继续携带 engine，客户端才能显示引擎徽标和降级能力。
3. `newAgent()` 在约 `566` 行是现有唯一 spawn 工厂：目前 `codex` 分叉到 `CodexAgentSession`，其他值进入 Claude。四家应注册为 `engine -> factory`，不要继续增加长 `if/else`。
4. `agentCallbacks()` 在约 `2257` 行是 create/resume 共用的状态收口面；新适配器只产出回调，不得直接改事件总线或项目台账。
5. `resumeAgent()` 在约 `2531` 行、`reviveSaved()` 在约 `2630` 行按 `state.engine` 透传 resume；应由 registry 给出 native resume 或 reinjection 两种策略，保留初始化超时、流代际和 resume 互斥保护。
6. `dispatchWorker()` 在约 `3631` 行：当前熟手走 `resumeAgent()`，新会话走 `create(anchor, wrapDispatchPrompt(...), "bypassPermissions", ...)`，并在约 `3704` 行以 `addMember(gid, sessionId, "worker")` 入编。这里目前没有 engine/model/role 透传，是四家接入的主缺口。
7. `wrapDispatchPrompt()` 在约 `4448` 行是 M2 派单纪律的唯一包装源；无 resume 引擎必须复用它，不得在每家适配器复制另一套派单提示。

### 1.5 必须保持的会话与看门狗语义

- relay `SessionState.relay_session_id` 是 CLI/SDK 侧的续接锚点；原生 resume 引擎写入真实锚点，无 resume 引擎写入 CC Deck 自有逻辑标识并额外保存重注入检查点。
- 一个 `sendMessage()` 只开启一个当前回合；正在运行时的后续输入排队，不能并发 spawn。
- spawn 即先报 `WORKING/启动中`；避免 CLI 尚未输出首事件时 UI 仍停在 DONE。
- 初始化看门狗、进度看门狗和 stop/kill-tree 必须覆盖：零事件退出、只有 stderr、长时间无 stdout、回合已收口但进程未退、resume 不吐 init。
- 看门狗超时的错误要包含引擎、命令路径（脱敏）、cwd、回合阶段、stderr 尾段；API key、完整 prompt、文件内容不得进入日志。
- 干净回合结束后保留逻辑会话，`onTurnEnd(true)` 后允许下一回合；只有 stop、无法建立任何续接锚点的首回合失败或用户显式关闭才 `onSessionEnd()`。

## 2. 通用适配器架构

### 2.1 引擎注册表

将 `SessionEngine` 从当前的 `"claude" | "codex"` 扩展为稳定字符串联合或注册表键：

```ts
type SessionEngine =
  | "claude" | "codex" | "trae" | "qwen-code" | "codebuddy" | "zcode";

interface EngineDefinition {
  id: SessionEngine;
  label: string;
  capabilities: EngineCapabilities;
  create(opts: EngineSpawnOptions): AgentLike;
  buildResume?(opts: EngineResumeOptions): EngineResumePlan;
  preflight?(opts: EngineConfig): Promise<PreflightResult>;
}
```

`SessionManager.newAgent()` 只做 `registry.get(engine).create(...)`；Claude 和 Codex 迁移成同样的 definition，降低扩展第四、第五家的风险。旧存量 `engine` 缺省仍解释为 Claude。

### 2.2 子进程适配器基类建议

四家均是 CLI 子进程，建议抽出 `JsonProcessAgentSession`（名称可调整），但不要把引擎特有事件判断塞进基类。基类只负责：

1. argv 数组 spawn，不经过 shell；prompt 优先 stdin，其次使用权限受控的临时 prompt 文件；禁止把完整 prompt 拼在 shell 字符串中。
2. 每回合状态机：`idle -> starting -> working/waiting -> turn-end -> idle`，队列在 turn-end 合并后续跑。
3. UTF-8 分帧、JSON 单对象和 JSONL 双模式、stderr 环形尾、退出码和信号收口。
4. `childPid`、`lastProgressAt`、当前 turn id、是否已发 turn-end、是否已收到 init 的通用看门狗状态。
5. 标准化 `stop`、kill-tree、清理临时文件、避免旧流回调污染新流的 `streamGen`。

引擎 mapper 只接收已分帧的 `unknown`，产出统一事件；未知 JSON 不抛异常，非 JSON stdout 作为普通日志或诊断行处理，并由配置决定是否可作为正文。

### 2.3 输出事件统一映射

| 原始语义 | Relay 回调 | 最低实现要求 |
|---|---|---|
| 会话/线程创建 | `onInit` | native resume 的引擎必须稳定提供；没有则走 reinjection |
| turn 开始、工具调用、stdout 活动 | `onStatusChange(WORKING, ...)` | 至少一种进度信号 |
| 用户审批/选择 | `onWaiting` | 只有 CLI 可回传决策时才实现 |
| 模型正文增量/完成 | `onLog("assistant_text", ...)` | 流式可替换 id；非流式一次性落正文 |
| 工具调用/结果 | `onLog("tool_use"/"tool_result", ...)` | 无可靠工具事件则不伪造 |
| 文件修改 | `onArtifacts`/`onStats` | 事件或 cwd diff 扫描，注明来源 |
| 任务清单 | `onTodos` | 原生任务事件/文件扫描；否则能力位为 none |
| token/context | `onUsage`/`onContext` | 只接真实字段；unknown 不写零 |
| turn 完成/失败 | `onTurnEnd` | 每 turn exactly once |
| 进程和会话终结 | `onSessionEnd` | 区分 clean turn exit 与 logical end |

### 2.4 provider 配置面

统一配置模型建议如下，凭证值不落 `projects.json` 或普通事件日志：

```ts
interface EngineProviderConfig {
  engine: SessionEngine;
  provider?: string;
  model?: string;
  command?: string;
  base_url?: string;
  api_key_ref?: string;     // 指向系统密钥存储/本机安全文件，不保存明文
  env?: Record<string, string>;
  telemetry_enabled?: boolean;
  resume_mode?: "native" | "reinjection" | "auto";
}
```

优先级：单次会话明确值 > 角色声明 > 项目默认 > 全局引擎默认 > CLI 自己的配置文件。`api_key_ref` 解引用后只在 spawn 子进程环境中存在，禁止通过 argv、`SESSION_*` 事件和错误文本传播。

`base_url`/`api_key` 复用国产中转的边界：

- CLI 明确兼容 OpenAI 风格环境变量或 flag 时，允许 provider profile 映射，例如 `OPENAI_BASE_URL`/`OPENAI_API_KEY`，具体变量名必须按该 CLI 的 `--help`/源码确认。
- CLI 使用自有 provider 配置、OAuth 或设备登录时，不强行注入 `OPENAI_*`，由其原生登录流程负责；CC Deck 只传 model/provider 选择。
- 一个 profile 必须声明“变量名、是否需要 URL 路径后缀、是否支持流式/JSON”；不能把 Claude 的 `ANTHROPIC_*` 变量假设成通用变量。
- 启动前做脱敏 preflight：命令存在、provider 配置完整、base URL 可解析；不在 preflight 真实发送 prompt，真实连通性留给冒烟。

## 3. 四家引擎逐家设计

本节分成“候选调用形态”和“必须先验证的事实”。候选命令用于实现者搭建接口和 stub，不代表可以跳过真实 CLI 的 `--help`、最小 prompt、错误退出和中断测试。

### 3.1 Trae（`bytedance/trae-agent`）

#### 定位与候选调用

Trae 是第一期重点接入的开源 CLI。当前仓库没有 Trae 依赖或协议实现，因此以下均为设计候选：

```text
trae-agent --cwd <cwd> --prompt-file <prompt-file> --output-format jsonl
```

备选是 prompt 走 stdin：

```text
trae-agent --cwd <cwd> --output-format jsonl < prompt-file
```

**待冒烟核实：** 可执行文件名、是否存在 `run` 子命令、prompt 参数名、是否支持 stdin、JSON/JSONL 开关、非交互/自动批准开关、模型和 provider 参数、退出码语义、是否有 session/resume 参数。实现不得先写死 `--prompt` 或 `--output-format jsonl` 后再用猜测补救。

#### 输出与进度解析

- 先按字节分帧，尝试 JSONL；如果 Trae 的 JSON 模式是单个完整 JSON，则允许 whole-document fallback。
- 设计事件分类：`session/init` → `onInit`；`turn/start`、`tool/start`、`command`、`file` → `WORKING`；assistant text delta/final → `onLog`；turn success/failure → `onTurnEnd`。
- 如果只输出人类文本，解析器保留正文并按“收到 stdout 行”刷新活性；不把每一行当成工具事件。工具、diff、usage、todo 只有字段被冒烟确认才映射。
- Trae 没有已知稳定 resume 契约，第一期按 **无 resume** 设计；即使后续发现隐藏 session 参数，也要通过能力探测显式升级，不能让存量会话隐式改变续接语义。

#### 鉴权、provider 与图片

- 默认从 Trae 原生配置/登录读取；CC Deck 只提供 `command`、`model`、`provider`、`base_url`、`api_key_ref` 的映射槽。
- 是否接受 OpenAI-compatible `base_url`/`api_key` **待冒烟核实**；确认前不得默认注入 `OPENAI_BASE_URL`。
- 图片和文件先落到 relay 管理的临时目录，提示中只注入安全的绝对路径和“请读取该文件”的明确指令；原生附件参数若存在，另列能力位并单测。

#### 上下文重注入

每一轮 fresh spawn 的首个 prompt 使用 4.1 节的 context packet，顺序为：系统边界、项目 cwd/引擎标识、最近对话摘要、未完成任务、输出物清单、最近错误/等待状态、当前用户消息。M2 worker 额外先放 `wrapDispatchPrompt(tier, task)` 的派单纪律，不能让上下文摘要覆盖完成回执格式。

#### 主要风险

未知 CLI 入口和事件协议 + 无 resume 双重风险最高；必须先做命令探测和 shell stub，再进入 `SessionManager` 接线。

### 3.2 Qwen Code

#### 无头调用

用户已给定第一期基线：

```text
qwen -p <prompt> --output-format json
```

prompt 优先走参数还是 stdin、JSON 是单对象还是多行、是否支持 `--output-format stream-json`、是否有 `--resume`/`--continue`、是否有自动审批选项，均需 **待冒烟核实**。实现第一版按“单回合 fresh process + JSON 或 JSONL parser”设计，不依赖未经确认的 resume。

#### 输出与进度解析

- `--output-format json` 若为单对象：解析最终正文、usage、model、error；进程仍运行期间用 stderr/可选 stdout heartbeat 刷新 `WORKING`。
- 若实际输出 JSONL/stream-json：复用通用 mapper，识别 init、message delta、tool call/result、turn completed/failed。
- `-p` 是当前确定的 prompt 入口；任何 `--json`、`--stream`、`--approval-mode` 只能在冒烟后加入命令模板。
- 无结构化工具事件时，任务、输出物、diff、审批不伪造；可用 `path-in-prompt` 图片/文件降级。

#### 鉴权与国产中转

- Qwen Code 可能沿用 Gemini CLI 家族的登录/provider 配置；具体 env/配置文件 **待冒烟核实**。
- 适配器提供 provider profile：`qwen-official`、`openai-compatible`、`custom`。只有 `--help` 或官方文档确认支持时，才将 `base_url`/`api_key_ref` 映射到对应 env/flag。
- 国产中转可复用的判断条件是：CLI 接受 OpenAI-compatible endpoint 且能返回其 JSON 输出协议；不能因为后端是 Qwen 就假设任意中转兼容。

#### 续接策略

若 `--resume`/`--continue` 冒烟通过，保存其返回的 session id，按 native resume 接入；否则使用上下文重注入。native resume 必须单测“新进程首事件再次 init”和错误恢复，不能只测首回合。

### 3.3 CodeBuddy Code（腾讯）

#### 无头调用

用户给定的硬要求是使用 CI 模式。候选入口：

```text
codebuddy --ci-mode <prompt>
```

或 npm 包入口：

```text
npx --yes @tencent-ai/codebuddy-code --ci-mode <prompt>
```

**待冒烟核实：** 实际 bin 名、prompt 是 positional/`-p`/stdin、是否有 JSON/JSONL 输出、CI 模式是否自动确认、模型/provider/base URL 参数、退出码、resume 能力。生产不应每回合依赖 `npx` 在线安装；preflight 要优先解析本地 bin，只有显式开发配置才允许包管理器入口。

#### 输出与权限解析

- `--ci-mode` 只代表非交互运行候选，不等于 relay 可显示审批卡；只有 CLI 给出可回传 decision id 和决策参数，才实现 `allow/deny/answer`。
- 先支持非流式最终结果和 stderr 活性，再按实测事件增加流式正文/工具事件。
- 若 CodeBuddy 有 CI 专用 JSON 输出，写独立 `CodeBuddyEventMapper`；若只有文本，使用 text-final mapper，能力位标记 `streaming=none`、`usage=none` 等。
- 文件与图片采用路径提示降级；`--ci-mode` 下任何授权风险必须在会话卡显示“自动执行模式”。

#### 鉴权与续接

腾讯账号/密钥和 OpenAI-compatible 中转的变量名 **待冒烟核实**；不能将 `TENCENT_*` 或 `OPENAI_*` 其中任何一组作为事实写死。

第一期默认无 resume：如官方 CLI 提供可稳定恢复的会话 id，再新增 native profile；否则 fresh spawn + context packet。CI 模式若没有交互审批，`WAITING` 不应出现，权限问题映射为 `ERROR` 并带可行动诊断。

### 3.4 ZCode（智谱 CLI）

#### 安全前置与调用形态

ZCode 的设计风险最高。背景输入明确指出 2026-09-23 存在“静默上传 Git 历史”争议；第一期不能把隐私开关当作文档口号。

候选命令仅用于搭建适配器：

```text
zcode <prompt-or-prompt-file>
```

实际 bin、非交互 flag、JSON/JSONL 输出、prompt 入口、resume 参数和 provider 变量全部 **待冒烟核实**。

#### 遥测默认关闭的具体机制

CC Deck 层设计一个不可绕过默认值：

```ts
interface ZCodePrivacy {
  telemetry_enabled: false;       // 默认值，设置页需显式 opt-in 才可改 true
  upload_git_history: false;      // 单独开关，默认 false
  strict_privacy: true;           // 无法验证关闭时拒绝启动
  acknowledged_warning: boolean;  // opt-in 前必须确认警示
}
```

spawn 前执行以下顺序：

1. 读取安全配置；缺省即 `telemetry_enabled=false`、`upload_git_history=false`、`strict_privacy=true`。
2. 依据已验证的 ZCode 原生 flag/env 注入关闭开关；候选名（如 `--no-telemetry`、`--no-upload-git-history`、`DO_NOT_TRACK=1`）都必须标为待冒烟，不能假设某个名字生效。
3. 若没有确认过的原生关闭机制，或 `--help`/启动诊断无法证明配置被接受，在未显式 opt-in 时返回 `ZCODE_PRIVACY_UNVERIFIED`，不启动 CLI。
4. 用户显式 opt-in 时，仍保持 `upload_git_history=false`，并在启动确认、设置页和会话首条系统日志显示“ZCode 可能上传项目/Git 信息，请确认其隐私策略”。两个开关必须分别记录审计时间和操作者。
5. 即使遥测关闭，prompt 中也不放 API key、完整 token、无关工作区文件；git 历史只允许在用户明确动作和 ZCode 原生能力确认后传入。

#### 输出、续接与 provider

- 只接受经过脱敏的 stdout/stderr；任何“上传/扫描/索引”事件都先映射成 `WORKING` 系统摘要，不把文件内容直接回灌到日志。
- usage、tool、diff、todo 只有实测字段才映射；无法确认则在能力位显示 unavailable。
- 原生 resume **待冒烟核实**；第一期默认走 context packet。若 ZCode 自带 transcript/项目索引，重注入时只引用其官方可读入口，不自行复制 Git 历史。
- 智谱 API key、base URL、model 的变量或 flag **待冒烟核实**。允许自定义中转的前提仍是 CLI 官方支持 endpoint 覆盖；不能绕过 ZCode 的隐私配置。

## 4. 上下文重注入层

### 4.1 适用范围与状态模型

所有没有经过真实验证的 native resume 引擎都使用 `reinjection`。它不是把完整历史无限拼回 prompt，而是一个可审计、可限长、带来源标签的上下文包：

```ts
interface ReinjectionContext {
  session_id: string;
  engine: SessionEngine;
  cwd: string;
  project_gid?: string;
  dispatch_tier?: string;
  turn: number;
  summary: string;
  todos: TodoItem[];
  artifacts: string[];
  recent_logs: string[];
  pending_input?: string;
  source: "relay-state" | "task-store" | "dispatch-wrapper";
}
```

建议状态新增可选元数据（兼容旧 JSON）：

```ts
engine_resume?: {
  mode: "native" | "reinjection";
  anchor?: string;
  checkpoint_turn: number;
  last_injected_at?: number;
}
```

`relay_session_id` 仍保持协议必填：native 模式填 CLI 锚点，reinjection 模式填 relay 逻辑会话 id 或 adapter 生成的稳定逻辑锚点；实际恢复由 `engine_resume.mode` 决定，不能拿假的锚点传给 CLI。

### 4.2 packet 组装顺序与大小护栏

1. 不可变边界：`你是 CC Deck 管理的 <engine> worker`、cwd、项目 id、禁止越权目录。
2. M2 派单包装：直接复用 `wrapDispatchPrompt(tier, task)`，保证改前认领、结果格式、commit 前缀和零确认纪律不漂移。
3. 任务连续性：未完成 todo、最近一张 doing board 卡、最近 dispatch id 和上一回合最后结果。
4. 证据：最近若干条 assistant/user/tool 摘要、输出物路径和最近错误；默认不复制二进制内容和完整 Git 历史。
5. 当前消息：最后放本轮新 prompt，明确“继续处理，不要复述已完成内容”。

packet 有最大字节/token 配额；超限时按“旧日志摘要 → 已完成 todo → 工具细节”的顺序裁剪，保留未完成任务、最近错误和当前消息。每次注入在 debug 审计中记录字段计数和 hash，不记录全文。

### 4.3 与派单、看门狗的关系

- `dispatchWorker()` 新建无 resume 会话时，先生成 packet，再调用引擎 adapter；不得先启动空会话再异步补上下文。
- packet 首次注入失败按当前回合错误收口；若 CLI 已产生逻辑锚点，可以由用户重试，不自动无限重试。
- fresh spawn 期间仍需 `onInit`/首进度看门狗。没有 native init 的引擎要定义 adapter 自己的“ready”事件；没有 ready 事件时以首个可解析输出作为 init，否则初始化超时。
- reinjection 不等于原生恢复：UI 必须显示“上下文重建”标签，避免用户误以为模型持有完整历史。

## 5. 通用 JSONL 适配器兜底

### 5.1 目标

允许用户接入冷门 CLI 而不改代码，但只能覆盖“命令、字段路径和安全环境变量映射”，不能让配置任意执行 shell 或读取 relay 私密文件。

### 5.2 配置形态

建议新增用户配置节 `generic_jsonl_adapters`：

```json
{
  "my-agent": {
    "command": "/usr/local/bin/my-agent",
    "args": ["--cwd", "{cwd}", "--prompt-file", "{prompt_file}", "--jsonl"],
    "prompt_transport": "file",
    "resume": { "mode": "none" },
    "events": {
      "init": "session.id",
      "text": "message.text",
      "progress": "event",
      "turn_ok": "done == true",
      "turn_error": "error.message"
    },
    "env_allowlist": {
      "MY_AGENT_BASE_URL": "{base_url}",
      "MY_AGENT_API_KEY": "{api_key}"
    }
  }
}
```

实际实现可以使用受限 JSONPath + 简单比较表达式，不引入可执行 JavaScript。允许占位符仅包括 `{cwd}`、`{model}`、`{prompt_file}`、`{resume_anchor}`、`{base_url}`、`{api_key}`；argv 逐项传给 `spawn`，不经 shell。配置导入前拒绝 `;`、`&&`、管道和未允许的环境键。

### 5.3 兜底边界

- 只承诺 `onInit`（可选）、assistant text、progress、turn success/failure、stderr 诊断；审批、usage、todos、artifacts 默认为 unavailable。
- 事件字段缺失时不得依赖文本正则推断成功；没有 `turn_ok` 就按退出码收口，退出码非零为 ERROR。
- generic adapter 的 `resume.mode=none` 自动使用 4 节上下文重注入；配置声明 native 时仍要在首次运行记录真实锚点，否则降级为 reinjection。

## 6. 编制扩展：角色到引擎/模型

### 6.1 数据结构

当前 `relay/src/projects.ts:24-28` 的 `ProjectHeadcountEntry` 只有 `session_id` 和 `role`，项目组在 `ProjectGroup.headcount` 保存编制快照。第一期建议做向后兼容扩展：

```ts
export interface EngineSelection {
  engine?: SessionEngine;
  model?: string;
  provider?: string;
}

export interface ProjectHeadcountEntry extends EngineSelection {
  session_id: string;
  role: string;
}

export interface ProjectGroup {
  // 现有字段保持不变
  headcount: ProjectHeadcountEntry[];
  /** 角色级默认声明；旧 projects.json 缺省为空 */
  role_defaults?: Record<string, EngineSelection>;
}
```

设计口径：

- `headcount[]` 是实际成员快照，成员入编时把当时的 role/engine/model/provider 落进去；这样历史项目不会因全局默认变化而漂移。
- `role_defaults` 是项目组角色模板，供“该角色需要新会话”时选择引擎；没有模板时回落到全局默认。
- 旧 JSON 无新字段时按 `engine=claude`、model 使用现有 relay 默认值处理；序列化只写已声明的可选字段，避免无意义的大面积文件变更。
- `provider` 是路由/配置 profile 名，不是凭证；凭证仍由 `api_key_ref` 或系统密钥层解析。

### 6.2 `org member-add` CLI 设计

当前 `relay/src/org.ts:276` 的用法是：

```text
org member-add <gid> <sid> [role]
```

一期扩展为：

```text
org member-add <gid> <sid> [role] [engine] [model] [provider]
```

兼容规则：

- 缺省 role 仍为 `worker`；缺省 engine/model/provider 表示继承该 role 的 `role_defaults`，再继承全局默认。
- engine 必须经过 registry 白名单；model 可以是引擎原生模型名，但不能为空字符串。
- CLI 生成的 JSON action 增加可选字段：`engine`、`model`、`provider`；旧 Leader 仍可用旧参数。
- `member-add` 复拉退休成员时，如未传新选择，优先保留原 headcount 快照；显式传入才更新声明，并在项目详情中标出“配置已变更，下一次派单生效”。
- 新增一个可选管理动作用于设置角色模板：

```text
org role-default <gid> <role> [engine] [model] [provider]
```

这不是新增成员，不改变现有 headcount 数量；只更新 `role_defaults`。

### 6.3 派单透传路径

当前 `dispatchWorker()` 的输入只有 `anchor/prompt/gid/title/skills`，且新会话路径在 `session-manager.ts:3692` 没有传 engine。建议改为：

```ts
dispatchWorker({
  anchor,
  prompt,
  gid,
  title,
  skills,
  role?,
  engine?,
  model?,
  provider?,
})
```

解析与优先级：

1. 派单显式 `engine/model/provider`。
2. `gid + role` 命中的 `role_defaults`。
3. 选中的 veteran 对应 `headcount[]` 快照；resume 时以现有 session state 为准，不能用新默认改写熟手的原生会话。
4. 项目组默认/全局默认。

执行分叉：

- veteran 可 resume：调用 `resumeAgent()`，引擎、model、provider 由该 session state 的 immutable selection 决定；若传入的显式 selection 与 veteran 不同，先拒绝并提示“本次选择需要新会话”，不要把新模型塞进旧原生上下文。
- 新会话：调用 `create(anchor, wrappedPrompt, "bypassPermissions", true, { skipStickyCwd: true, employee: true, engine, model, provider, role })`；`create()` 将 selection 落入 `SessionState`，再经 `newAgent()` registry 生成实例。
- 由 `wrapDispatchPrompt()` 产生的派单纪律必须保持不变；context reinjection 在 adapter 层把该包装和状态包合并，不能让 `dispatchWorker()` 为每个引擎复制 prompt。
- 成功入组时 `addMember()` 写入实际 session 的角色和 engine/model/provider 快照；`BOARD_UPDATED`、dispatch 台账和 `SESSION_UPDATED` 继续按当前路径收口。

`COMMAND_CREATE` 也应支持 `model`、`provider` 的可选字段，但客户端传入未知 engine、空 model 或不匹配 provider 时必须在 ack 中失败，不能静默落回 Claude。

### 6.4 迁移与一致性

- 新字段全部 optional，旧项目和旧快照可读取。
- `member-retire` 保留带引擎选择的路由档案；`member-add` 重新入编时再决定是否覆盖。
- 项目只读聚合页展示“角色 / 引擎 / 模型 / provider”，实际写操作仍回团队/会话原域。
- 派单台账建议追加 `engine`、`model`、`role` 字段，方便验收“实际跑的不是计划引擎”的异常；旧台账缺省显示 unknown。

## 7. 实施拆解：可独立提交的批次

每批必须能单独构建、运行自身测试、回滚，不要求四家一次合并。提交信息建议统一 `[engine-adapter] <batch>`。

### 批次 0：协议与注册表骨架

**交付：** 扩展 `SessionEngine`、`EngineSelection`、`EngineCapabilities`、`EngineRegistry`、`SessionState.engine_resume` 的类型和工厂缝；Claude/Codex 行为零回归；未知 engine 明确报错。

**测试：** registry 白名单、缺省 Claude、旧 JSON hydrate、create/resume engine 透传、能力位快照。不得在这一批接入真实新 CLI。

### 批次 1：通用子进程与 JSON/JSONL 映射基座

**交付：** UTF-8 分帧、单对象/JSONL、stderr tail、退出收口、队列、stream generation、watchdog hook、generic adapter 配置校验。

**测试：** 仿 `relay/scripts/test-codex.ts` 写 shell stub：正常 JSON、正常 JSONL、未知事件、畸形行、零事件退出、只有 stderr、turn 失败、stop 杀树、回合中两条消息合并。CI 不需要安装任何新 CLI。

### 批次 2：Trae adapter

**交付：** Trae 命令 profile、mapper、能力位、reinjection resume、provider preflight、诊断错误和文档中的待核实项清理。

**测试：** `TraeEventMapper` fixture + Trae shell stub + `SessionManager` create/resume/send/stop；至少覆盖无 native resume 的第二轮 packet 内容和 prompt 不泄漏 key。

### 批次 3：Qwen Code adapter

**交付：** `qwen -p ... --output-format json` 基线 profile；根据冒烟结果决定 JSON/JSONL 和 native resume；provider profile 及模型透传。

**测试：** 单对象 JSON、JSONL（若支持）、非零退出、无 usage、resume 或 reinjection 二选一；确认 `-p` prompt 在长文本、中文和换行下不被 shell 截断。

### 批次 4：CodeBuddy Code adapter

**交付：** 本地 npm bin resolver、`--ci-mode`、非交互错误语义、文本/JSON mapper；如果 CLI 无审批，能力位和 UI 提示一并落地。

**测试：** package bin stub、`--ci-mode` argv 断言、自动确认不被误映射成 WAITING、非零退出含 stderr、reinjection 二轮。

### 批次 5：ZCode adapter 与隐私闸门

**交付：** ZCode profile、原生遥测关闭探测、`strict_privacy` fail-closed、Git 历史单独禁用、显著警示和 opt-in 审计；未验证关闭开关时禁止默认启动。

**测试：**

- 未确认关闭开关 → 不 spawn 且返回 `ZCODE_PRIVACY_UNVERIFIED`；
- 已确认关闭 → argv/env 只出现关闭开关，不出现 Git 上传开关的反向值；
- opt-in 仍不自动开启 Git 历史；
- prompt、stderr、审计日志不含 key 和 Git 内容；
- 正常、失败、超时和 stop 的 watchdog 收口。

### 批次 6：角色/引擎/模型派单透传

**交付：** projects headcount 可选字段、role_defaults、`org member-add` 新参数、dispatch 输入和 create opts 透传、台账快照。

**测试：** 旧参数兼容；显式 selection 优先级；veteran resume 不被新 selection 改写；新会话按角色选择引擎；项目板 doing/done、dispatch close 和成员入编一致；未知 engine 拒绝。

### 批次 7：真实 CLI 冒烟与合流门禁

**交付：** 每家一份本机/沙盒冒烟记录，锁定候选命令、事件词汇、鉴权变量、resume 事实和能力矩阵；把已核实项从本规格的“待冒烟核实”移入代码注释/测试 fixture。

**门禁：** 四家均通过下面的三步验证；任一家失败只阻断该引擎，不回滚其他已验证引擎。

## 8. 每家引擎三步验证口径

### 第一步：无头冒烟

在隔离 cwd 和临时 HOME 下，不经过 Web/手机：

1. `--help`/版本确认 bin、prompt 入口、JSON/JSONL、自动批准、resume、provider 参数。
2. 最小 prompt：输出一段固定文本，验证 stdout/stderr、退出码、事件分帧和模型名。
3. 中文、长 prompt、换行、特殊字符、路径 prompt 各一次。
4. 错误用例：无 key、错误 base URL、模型不存在、cwd 非 git/无权限；确认错误可诊断且不泄漏密钥。
5. 发送 SIGTERM/stop 和制造长时间无输出，确认能收口。
6. ZCode 额外验证遥测/Git 历史关闭是否真的被 CLI 接受；无法证明即判失败，不得进入默认启用。

**通过标准：** 命令可重复、事件/文本可解析、不会无限挂死、错误可归因；未确认的输出协议只能进入 generic/text 降级，不能假称结构化支持。

### 第二步：M2 沙盒建会话

用隔离 `CCR_DATA_DIR`、`CCR_ORG_DIR`、`CCR_CLOUD_URL=""`、无真实 Leader 的条件，类似 `test-codex.ts`：

1. `COMMAND_CREATE(engine=...)` 创建会话，检查 `SESSION_CREATED.engine`、model/provider、状态首帧和引擎 badge。
2. 第一轮完成后发第二条消息；native resume 验证原生锚点，reinjection 验证 packet 含未完成任务/上一轮结果且无无关历史。
3. 验证图片/文件能力降级、usage/todo/artifact 缺失状态、错误和 stop。
4. 触发零事件退出、无 init、无进度、stderr-only，确认 watchdog 不产生僵尸 WAITING/WORKING 卡。
5. relay 重启/parked revive 后确认 saved、engine、resume metadata 不丢。

**通过标准：** `AgentCallbacks` 回调序列与 Claude/Codex 语义一致；每回合一次 turn-end；clean turn 不误 session-end；错误能重试或明确不可恢复。

### 第三步：派单收口

在 M2 项目沙盒中：

1. 创建项目组，声明角色到 engine/model/provider；`org member-add` 复拉成员并检查 headcount 快照。
2. `dispatchWorker(gid, role, prompt)` 选择正确 veteran 或新会话；检查新会话的 engine/model/provider、cwd 锚点和 `wrapDispatchPrompt`。
3. 检查 board 卡从 doing 到 done、dispatch log 从 dispatched/running 到 done/failed、成员入编、SESSION_UPDATED 的 project_gid/dispatch_tier 一致。
4. 模拟 resume 失败，确认按既有策略降级新会话且不重复扣台账；模拟引擎启动失败，确认 dispatch 收口 failed 不留悬账。
5. 通过验收单检查“计划引擎、实际引擎、模型、provider、回执、改动文件”六项均可追溯。

**通过标准：** 派单可执行、失败可收口、板/台账/会话三处一致、用户能看到引擎能力限制和隐私警示。

## 9. 测试组织与完成定义

### 9.1 仿 `test-codex` 的测试结构

每家适配器都应有独立脚本（例如 `relay/scripts/test-trae.ts`），分成三层：

- **A：纯 mapper fixture。** 直接喂已记录 JSON/JSONL，断言 callback 序列、正文、错误、turn duration、未知事件容忍。
- **B：进程模型 stub。** `CCR_*` 全钉临时目录，shell stub 记录 argv/stdin/env，断言 prompt 传输、resume/reinjection、排队、崩溃、stop、stderr tail。禁止 CI 拉真 CLI。
- **C：SessionManager 接线。** 用真实工厂或受控 fake 验证 `COMMAND_CREATE`、SESSION_CREATED、第二轮、watchdog、dispatch 和项目台账。

每个脚本退出码非零即失败，测试产物收在临时目录并在 finally 清理；任何真实 API key、真实用户 HOME 和真实项目 cwd 都不得被测试读取。

### 9.2 完成定义

- [ ] `SessionEngine`、registry 和能力位完成；Claude/Codex 全部原测试通过。
- [ ] 四家各有 mapper fixture、进程 stub、SessionManager 接线测试。
- [ ] 四家各有无头冒烟记录；所有命令、输出和 resume 的不确定点已被核实或被明确降级。
- [ ] 无 resume 引擎使用统一 context packet，且 M2 `wrapDispatchPrompt` 只有一个事实源。
- [ ] role → engine/model/provider 从 `projects.ts`、`member-add` 到 `dispatchWorker` 可追踪。
- [ ] ZCode 默认遥测关闭、无法验证时 fail-closed、Git 历史默认关闭和文档警示均有自动化测试。
- [ ] dispatch、board、acceptance、session state 的 engine/model/provider 能形成验收证据链。

## 10. 风险排序与拍板项

| 风险 | 影响 | 处理 |
|---|---|---|
| ZCode 隐私开关不可验证或关闭语义漂移 | 可能造成 Git 历史或项目内容外传 | 默认关闭 + strict privacy fail-closed；未通过安全冒烟不进入默认列表 |
| Trae 无 resume 且 CLI 协议未知 | 上下文连续性、首轮事件和 watchdog 容易失真 | 先实现通用 reinjection；先做 mapper/stub，再接真实命令 |
| CodeBuddy CI 模式输出/权限语义未知 | 可能把自动运行误显示为可审批 | 能力位先保守；无真实 decision channel 不发 WAITING |
| Qwen JSON 输出形态与 resume 版本漂移 | 解析和会话续接不稳定 | 单对象/JSONL 双 parser；native resume 必须实测后启用 |
| provider env 变量命名不统一 | 中转配置不生效或误把 key 传错 CLI | profile 映射 + preflight；不做跨 CLI 环境变量猜测 |

本期**最高风险是 ZCode**：不是普通的命令兼容风险，而是默认配置下潜在的数据外传风险；因此它的验收门槛高于其他三家，宁可不可用，也不能在关闭遥测无法证明时静默运行。
