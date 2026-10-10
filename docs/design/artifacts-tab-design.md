# 输出物（Artifacts）Tab 设计笔记

> 2026-09-19 UI/产品专项设计（只设计，不含实现）。目标：详情页右侧新增第 6 个子 tab「输出物」，把"这个会话产出了哪些文件"从翻文件管理器变成一屏可见、双击即开。mockup 见同目录 `artifacts-tab-mockup.html`。
>
> 用户原始需求（逐字）：「当前桌面端右侧有 5 个子 tab（消息、任务、全部、定时、统计），考虑分析一下是否需要再增加一个'输出物'的 tab。具体设想如下：1. 功能定位：展示某个会话输出的文档，让用户在这个 tab 下可以直接看到本地的对应文件。2. 交互需求：是否需要预览内容另说，但至少要支持直接双击，调用电脑本地的软件去打开文件。3. 解决痛点：避免用户再去文件管理器里面找文件，因为那个过程很繁琐。……打开功能主要是针对本地文件。比如说我在手机端，而这个文件实际上是在电脑端生成的，那我手机端至少要能看到这个文件以及它的简单信息，比如它的路径」

## 一、价值判断：该做，而且便宜

**结论：做。** 理由不是"功能越多越好"，而是三点：

1. **痛点真实且高频**。cc-deck 的会话以写文件为主要产出（本仓库 2026-09-13 以来的开发几乎每会话都有 Write/Edit），用户拿到产出物的路径是"去 Finder/资源管理器里翻"，与会话 cwd 无关联线索，确实繁琐。这是把"流水账"（全部 tab 的工具行）变成"结果清单"的一步。
2. **地基已经备好 80%**（2026-09-19 盘点）：

| 需要什么 | 已有什么 | 位置 |
|---|---|---|
| 双击调本地软件打开 | Tauri 命令 `open_path(path, reveal)`（opener 插件：系统默认应用打开 / 文件管理器定位） | `desktop-tauri/src-tauri/src/main.rs:102`，INIT_SCRIPT 注入 `window.ccDeck.openPath` |
| 打开/定位/复制菜单 | `#326` 路径浮窗 `openFpathPop()`：桌面壳给"打开文件/打开所在目录"，浏览器只剩"复制路径" | `web-console/index.html:6535` |
| 文件路径数据流 | 外部会话 `feedFileStats()` 已解析 Edit/Write/MultiEdit/NotebookEdit 的 `tool_input.file_path` 与结果；托管会话 `extractDiffStats()` 已把路径收进 `filesTouched` Set | `relay/src/bridge.ts:1724`、`relay/src/agent-adapter.ts:163,348`、`relay/src/summarizer.ts:392` |
| 面板骨架先例 | 非时间线 tab（任务/定时/统计）都是 `#timeline` 容器内换渲染函数 + key 防重建；tab 机制通用（data-tab 按钮 + tabInd 量活动按钮宽度），加第 6 个零改骨架 | `web-console/index.html:4255-4290, 6264-6284` |
| 全局产物中心 | relay 已有 `artifacts.ts`：`~/.cc-deck/artifacts/` 目录列表 + token 鉴权静态服务（`/api/artifacts`、`/artifacts/<file>`），**尚无任何 UI 消费** | `relay/src/artifacts.ts`、`relay/src/ws-server.ts:430-447` |

3. **差异化顺路**：这是"监控工具"向"工作台"演进的一块——产出物是用户最终要验收的东西，值得一个一等入口。

**明确不做/后置的**（防过度设计）：
- 不做内置预览器（M0 一个字都不预览；M1 只做"文本小文件只读预览"，见 §五）。
- 不做 Bash 产物的路径抓取（启发式太噪声，见 §四）。
- 不做文件内容 diff 回看（「全部」tab 已有工具行 diff）。

**与既有全局产物中心的关系**：`~/.cc-deck/artifacts/` 是"CLI 主动投放"的全局共享目录（跨会话、无归属）；本设计是"会话内自动捕获"的私有清单（有归属、零成本）。两者数据源不同、互不替代；M1 在会话输出物列表里给投放进 artifacts 目录的文件加 `origin: "artifacts"` 角标即可打通（手机/远端此时可经 `/artifacts/<file>` 直下），M0 不动全局中心。

## 二、信息架构

### Tab 定义

- **命名**：「输出物」（沿用用户措辞；不叫"文件"——与输入文件、仓库文件区分；不叫"产物"——与全局产物中心的"产物"错开一级）。
- **位置**：插在「全部」之后、「定时」之前 → **消息 · 任务 · 全部 · 输出物 · 定时 · 统计**。理由：消息/任务是协作面，全部是完整流水，输出物是**结果面**紧跟流水；定时/统计是辅助面板收尾。手机端 VIEWS 同位插入（`expo-app/src/screens/DetailScreen.tsx:24`）。
- **可见性**：所有会话恒显（含历史/外部会话；空态文案见下）——不学 cron 那样条件显隐，因为"没有产出"本身也是有效信息（纯问答会话）。

### 面板结构（桌面）

```
┌ 汇总行  12 个文件 · 新建 3 · 修改 9 · +248 −96        [打开工作目录] ┐
│ 分组「新建 · 3」                                                     │
│   [图标] 文件名        所在目录(相对 cwd)      +行−行  时间  [⋯]      │
│ 分组「修改 · 9」                                                     │
│   …（组内按 last_at 降序）                                           │
└ 底注：双击打开 · 右键更多 · N=本会话捕获口径说明                      ┘
```

- **汇总行**：个数 + 新建/修改拆分 + 累计增删行（复用统计 tab 的 +/- 着色语言）；右侧「打开工作目录」按钮（桌面壳显式给 `reveal cwd`，浏览器隐藏）。
- **分组**：只分两组——**新建**（本会话内创建过的文件，用户最关心的"产出"）与**修改**（存量文件改动）。不做目录分组/时间线分组：单会话典型 <30 个文件，再分层是过度组织；目录信息降级进行内次要文字（`src/screens/` 前缀灰显、文件名亮显）。组头样式复用任务面板 `.todo-gt`（小号大写字距标签 + 底部 1px 分隔，新建组用 `--done` 绿系、修改组用中性）。
- **行内容**（一行主信息 + 右侧元信息，不再做两行卡）：
  - 左：类型图标（12px 圆角方底 + 单色 glyph，按扩展名映射：代码/文档/图片/数据/压缩/其他六类，见 mockup）；
  - 中：文件名（`--text-strong`）+ 目录前缀（`--faint`，相对 cwd；cwd 外文件显示 `…/` 截断的绝对路径 + 「cwd 外」角标）；
  - 右：`+24 −6`（增删行，沿用 `.ds-add/.ds-del` 色）· 最后修改时间（`HH:mm`，>24h 显 `昨天/EEE`，>7d 显 `M/d`）· hover 显 `⋯` 菜单钮；
  - 状态角标（仅异常时占位）：`已删除`（文件 stat 不到）/ `cwd 外`。
- **行交互**（对齐用户第 2 点 + 既有 #326 语言）：
  - **双击 = 用本地默认应用打开**（`window.ccDeck.openPath(path, false)`）；
  - 右键 或 `⋯` = `openFpathPop` 同款浮窗：打开文件 / 打开所在目录 / 复制路径 / 复制相对路径；
  - 单击 = 无动作（防误开；与表格类 UI 直觉一致）；
  - 已删除行：双击 → toast「文件已不存在（可能已被清理）」，浮窗里"打开"两项禁用；
  - Enter 键打开选中行、↑↓ 移动选中（桌面键盘闭环，实现成本低则 M0 带，否则 M1）。
- **空态**：居中两行（复用 `.todo-empty` 形态）——「本会话还没有文件产出 / CLI 里用 Write/Edit 写文件后，这里会自动出现」。外部会话追加一行「需 CLI 挂 cc-deck hooks 才能捕获」。

### 手机端（expo-app）

用户第 3 点：手机上文件在电脑端，**至少看到文件 + 路径 + 简单信息**。

- 列表行 = 桌面行去交互版：图标 + 文件名 + 相对路径（单行省略）+ 第二行元信息（新建/修改 · 时间 · +−行）。
- **点行 = 底部详情 sheet**（复用长按菜单/浮层的视觉语言）：
  - 文件名 + 类型角标；
  - 绝对路径整段展示（mono、可选中，系统选择手柄可拖选）；
  - 元信息行：大小 · 创建/最后修改时间 · 操作类型 · 累计增删行；
  - 动作钮：**复制路径**（expo-clipboard，先例 `DetailScreen.tsx:297`）/ **分享**（`Share.share`，先例 :311）；
  - 底部固定说明：「文件在电脑上，App 内暂不能打开」（M1 若该文件投放于全局产物中心且可直下，则换「下载/查看」钮）。
- 长按行 = 快捷菜单：复制路径 / 分享路径（不进 sheet 一步到位）。

### 远程浏览器（网页端开 relay）

与桌面同构；能力探测（`window.ccDeck.openPath` 不存在）自动降级：`⋯` 浮窗只剩"复制路径 / 复制相对路径"，双击 toast「在桌面端打开可双击启动本地应用」+ 顺带把路径复制进剪贴板（补救动作，不让降级成为死胡同）。「打开工作目录」按钮隐藏。

## 三、数据模型与协议

```ts
// relay/src/types.ts 新增（expo-app/src/protocol.ts 同步镜像）
export type ArtifactOp = "create" | "edit";

export interface ArtifactItem {
  path: string;        // 绝对路径（主键；分隔符保留 OS 原样；同名大小写差异按平台归一）
  op: ArtifactOp;      // 本会话内新建过 → "create"（后继 Edit 不降级）；否则 "edit"
  tools: string[];     // 出现过的工具名（Write/Edit/MultiEdit/NotebookEdit）
  adds: number;        // 累计 + 行
  dels: number;        // 累计 − 行
  first_at: number;    // 首次出现（ms）
  last_at: number;     // 最后一次写（ms；排序键）
  size?: number;       // 最近一次 stat 的字节数（捕获时顺手 stat；缺省不显）
  exists?: boolean;    // 最近一次 stat 是否存在；false → UI「已删除」态
  origin?: "cwd" | "outside";   // 相对会话 cwd 的位置（UI 决定相对/绝对展示与角标）
}
```

- **挂载点**：`SessionState.artifacts?: ArtifactItem[]`（可缺省 = 无数据，与 `todos`/`cron_tasks` 同款可缺省语义）。
- **下发**：变化时随 `SESSION_UPDATED` 增量携带（`SessionUpdatedPayload` 加 `artifacts?: ArtifactItem[]`，null/缺失 = 不变，`[]` 语义上等于空态但通常干脆不带）；SNAPSHOT 全量携带（断线重连/手机冷启动重建）。走既有总线，**零新端点、零新事件类型**。
- **去重与合并**（key = 绝对路径归一）：
  - 同文件多次 Edit → 单行，`adds/dels` 累加、`last_at` 刷新、`tools` 并集；
  - Write 新建后被 Edit → 保持 `create`（"本会话产出过这个文件"是最有价值的归类，不因后继编辑降级）；
  - Write 覆盖已存在文件 → `edit`（判定见 §四）。
- **上限**：单会话 200 条封顶（超出保最新 200 条 + 汇总行注「已截断」）。依据：本仓库马拉松会话实测日改 ~40 文件，200 已是 5 倍余量；真超限的会话（批量重命名等）用户也只需要尾部。
- **不持久化**（M0）：内存态 + transcript/事件流天然可重建（外部会话，见 §四）；托管会话 relay 重启后 SDK 进程已亡、会话本身转 historical 只读，artifacts 随 SNAPSHOT 语义走内存即可——与 `todos` 的持久化待遇一致即可，不另立存储。若实测重启丢失体验差，M1 把 artifacts 并进外部会话 transcript 重放（一次性投入）。

## 四、relay 采集口径（实现锚点，文件 + 函数级）

口径：**只捕 Write / Edit / MultiEdit / NotebookEdit 四类工具**（确定性：入参必有 `file_path`，结果带结构化 diff），Bash 产物不入 M0——`ls > out.txt` 类重定向路径靠正则猜，误报（把 grep 到的路径当产出）比漏报更伤信任。Bash 场景的兜底是「打开工作目录」按钮。

### 外部会话（hooks 桥接）——两个点位

1. **实时**：`relay/src/bridge.ts` `feedFileStats()`（约 :1724）已在 PostToolUse 事件里过滤同四类工具并解析出 `file`（`tool_response.filePath/file_path` → `tool_input.file_path` 兜底）。在此顺路喂给新增的 `SessionManager.setExternalArtifacts(id, item, op)` 咽喉点（对齐 `setTodos`/`setExternalStats` 模式：合并、截断、变化才 `emitUpdated`）。新建/修改判定：结果对象 `structuredPatch` 为空数组且 `content` 非空 = 新建（`extractDiffStats` 已按此分支数行，判定逻辑现成）；有 patch = 修改。
2. **重建**（relay 重启 / 无 hook 会话）：`relay/src/bridge.ts` `pushAssistantTexts()`（:1423）增量扫 transcript，已解析 tool_use 块（`lastTool`/`taskOps` 同源）。扩展：扫到四类工具的 tool_use 时同样喂咽喉点（transcript 是唯一完整事实源，先例 `replayTaskHistory` :1772 全文件回放——108MB 分块扫 ~1s，工具行同样按行过滤开销可忽略）。tool_use 与 result 的配对关系 feedFileStats 已示范（callId 交集）。

### 托管会话（SDK）——两个点位

`relay/src/agent-adapter.ts` `handleMessage()`：
1. `case "assistant"` 的 `block.type === "tool_use"`（约 :313）：四类工具则记 `block.id → { name, input.file_path }` 待配对（现有 `this.tasks.feed(block.name, block.input)` 就在旁边，同款姿势）。
2. `case "user"` 的 tool_result（约 :340）：`extractDiffStats(structured ?? tr.content, this.stats, this.filesTouched)`（`summarizer.ts:392`）已经把 `filePath/file_path/gitDiff.filename` 收进 `filesTouched`——扩展为同时产出 `ArtifactItem`（在 `AgentCallbacks` 加 `onArtifacts(items)`，`session-manager.ts:1374` onStats 旁边接线）。

### 存活校验（exists/size）

捕获时顺手 `statSync`（失败 → `exists:false`）；**不**做轮询刷新。UI 端在打开失败时 toast 兜底；M1 可在"切换到输出物 tab"时经既有 COMMAND 信道发一次 `COMMAND_REFRESH_ARTIFACTS`（对齐 `COMMAND_REFRESH_TODOS` :4330 先例）让 relay 对当前会话 ≤200 条做一次批量 stat——低成本保鲜，M0 不做。

### 归一

- 路径一律存**绝对路径**（外部会话 `file_path` 相对时以会话 cwd 补全——cwd 抓取已有：transcript 尾部 8KB 扫描，`bridge.ts:319`）；
- `origin` 判定：`path` 以 `cwd + 分隔符` 开头 → `cwd`，否则 `outside`（UI 换绝对路径展示 + 角标）；
- macOS 大小写不敏感盘、Windows 盘符大小写：归一 key 用 `toLowerCase()` 比较、展示保留原文。

## 五、三端交互与实现路径汇总

### 双击打开（用户第 2 点，桌面核心）

- **Tauri 壳**：`window.ccDeck.openPath(path, false)` → `open_path` 命令（`main.rs:102`，opener 插件 `open_path`/`reveal_item_in_dir`）——**已上线能力（#326），零新增 Rust 代码**。
- **Electron 壳（desktop/）**：preload 同形 `openPath`（#326 注释明示 Tauri/Electron 同形），同样零新增。
- **浏览器降级**：见 §二（复制路径 + 提示）；不给浏览器做"file:// 直开"——现代浏览器全拦，别试。
- 权限面：opener 调用全在壳侧 Rust/主进程，不经 IPC ACL，无 capabilities 变更（`capabilities/default.json` 不动）。

### 手机端打开缺口（用户第 3 点）

M0 = 只读清单 + 路径复制/分享（§二）。M1 可选两条增强，安全边界如下：

1. **文本小文件只读预览**：relay 加 `GET /api/session-file?sid&path&token`——**只允许精确命中该会话 artifacts 注册表里的 path**（不接受任意路径，防 traversal；等价 artifacts.ts 的 resolve 后仍须在册校验），且仅 text/* 类扩展名 + ≤256KB + 只读。命中全局产物中心的文件则直接走已有 `/artifacts/<file>`。
2. **拉起桌面打开**（"手机点一下、电脑开文件"）：走既有 COMMAND 信道发 `COMMAND_OPEN_ARTIFACT`，relay 侧用系统 opener 打开。有趣但跨设备惊扰（人不在电脑前文件弹开），且 opener 从服务进程拉 GUI 应用在 Windows 会话隔离下有坑——**列为 M1 议题不做承诺**，等用户表态。

### 时间与联动（发散项的取舍）

- **与「全部」tab 工具行联动**（做，便宜）：行上"在时间线中查看"项 → 跳「全部」tab 并滚动定位到该文件最后一条 Edit/Write 工具行 + 闪高（`jumpToTask` 同机制，`web-console/index.html:6325`）。反向：工具行里的 `.fpath` 已可点开 #326 浮窗，不动。
- **复制相对路径**（做）：从 IDE/终端粘贴场景比绝对路径常用。
- **行数/大小**（做增删行；大小只展示不参与排序）。
- **时间线分组**（不做，§二已述）。
- **新建/修改区分**（做，是分组主轴）。
- **文件类型图标**（做，六类映射，不追真实 filetype 图标）。

## 六、边界情形

| 情形 | 处理 |
|---|---|
| 文件已删/被清理 | `exists:false` → 行置灰 + 「已删除」角标；双击 toast，浮窗开项禁用，复制照常 |
| cwd 外文件（`../` 或绝对路径写出） | 照收；显示绝对路径 + 「cwd 外」角标；打开不受影响（本机能开就行） |
| 巨量文件（批量脚本 >200） | 截断保最新 200 + 汇总行「已截断」；M1 刷新命令可全量重算 |
| 非文件产出（Bash stdout、粘贴图片、回答正文） | 不属于本 tab 职责；正文在消息流、图片在 `#imgrow`；Bash 产物见 §四口径说明 |
| 同名覆盖（Write 覆盖已有文件） | 归「修改」组；结果 patch 空 + content 非空的判定天然覆盖 |
| Write 建后又删又重建 | 归并一行（同 key），op 保持 create，last_at 刷新 |
| 会话 resume（跨进程续聊） | 同一 session_id 续算，先前列表延续（内存态天然如此） |
| relay 重启 | 外部会话 transcript 回放重建（§四）；托管会话随 SNAPSHOT 内存重建，丢了就空态（可接受，M1 再评估持久化） |
| 历史会话（重启前遗留） | 无 artifacts 数据 → 空态文案换「历史会话无输出物记录」 |
| 路径含空格/中文/emoji | `openPath` 原样传参（opener 插件处理）；UI `word-break: break-all` |
| 大小写不同盘的同名文件 | §四归一规则：同 key 合并（展示原文保真） |

## 七、分期落地

**M0 最小可用（一个发版单元）**
1. relay：`ArtifactItem` 类型 + `SessionState.artifacts` + SESSION_UPDATED/SNAPSHOT 携带；外部会话 `feedFileStats` + `pushAssistantTexts` 双点位采集 + `setExternalArtifacts` 咽喉点；托管会话 agent-adapter 两点位 + `onArtifacts` 回调。types/protocol 两端镜像。
2. web-console：第 6 tab（面板渲染函数 `artifactsTabHtml(s)` + 事件委托挂 `#timeline`，对齐 cron/stats 先例）+ 双击打开/右键浮窗（复用 openFpathPop 加"复制相对路径"一项）+ 空态/已删除/cwd 外三态 + 深浅两主题 CSS 变量化。
3. expo-app：VIEWS 插「输出物」+ 列表 + 详情 sheet（复制/分享）+ 空态。
4. 发版自测：类型检查 + 既有测试套件 + 真机（手机 adb 装机走一遍列表/复制/分享；桌面包装机双击打开、浏览器降级复制）。

**M1 增强（按反馈排期）**
- tab 激活时 `COMMAND_REFRESH_ARTIFACTS` 批量 stat 保鲜；
- 「在时间线中查看」跳转联动；
- 全局产物中心打通（origin 角标 + 手机直下）；
- 手机文本小文件预览（§五安全边界）；
- 键盘导航（Enter/↑↓）；
- artifacts 持久化评估（重启丢失体感）。

## 八、开放问题（留给主会话）

1. **手机拉起桌面打开**（§五 M1-2）要不要做？跨设备惊扰值不值，需要用户表态。
2. **Bash 产物**是否真的永久放弃？若有高频场景（如"会话生成截图后自动开"）可考虑 `open_path` 白名单式 Bash 后置钩子，但不入 M0。
3. 托管会话 relay 重启后 artifacts 清空是否可接受（当前设计：接受，空态兜底）。
4. 200 条上限与「已截断」提示的阈值是否合适（等实测马拉松会话数据）。
5. tab 在窄屏（≤900px 详情头）挤压 6 个 tab 的表现需实现时实测；预案：字号 12.5→12px 或允许 tab 行横向滚动。
