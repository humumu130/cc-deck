# worker 任务/输出物挂载机制设计

- 日期：2026-10-03
- 背景：M2 cc-deck 里 Codex（PM）会话 tab 的任务面板、输出物面板全空。混编试点实操发现，属真实机制缺口，非渲染 bug。
- 状态：设计定稿待实施（批 A/B 随 M4 派单回调同批落地，条款进 #43 经验固化）。

## 1. 根因（代码实证）

| 面板 | 根因 | 实证 |
|---|---|---|
| 任务面板空 | todos 权威源=CLI task store 直读（`~/.claude/tasks/<cli_sid>/`，#206），**Claude Code 专属**；Codex 无此存储、适配器无 todos 上报面 | session-manager.ts `pollTaskStore`；codex adapter 无 todos 字段 |
| 输出物面板空 | deliver 归属=按 **cwd 猜**（`deliverByCwd`），载荷无 session 字段；混编常态=同锚点多会话，猜错对象（PM 的交付挂到了同 cwd 的另一个会话 701fd345 名下）；且任务书纪律未要求 worker 自主 deliver，一直 Leader 代跑 | ws-server.ts:552 `/api/deliver` 载荷仅 {path,cwd}；bin/deliver 无归属参数 |

## 2. 机制设计：三层挂载模型

**总原则：系统联动 > worker 自主 > Leader 兜底。** 每层只做它最擅长的事。

### 2.1 任务挂载（引擎无关抽象）

- **L1 派单台账联动（系统自动·主通道）**：worker 会话的任务面板主数据源 = relay 派单台账（DispatchStatus：dispatched→running→done/failed，按 session_id 过滤）。**派单即挂载，worker 零动作**。台账数据 M2 已有，缺的只是 external 会话 tab 渲染这层视图。
- **L2 原生 todos 透出（Claude 系引擎增强）**：pollTaskStore 继续直读 task store，Claude worker 的子任务细进度原生透出。
- **L3 注入型 [待确认]**：notifyConfirm 注入的确认项显示（已有，#52）。

统一心法：**「这头驴在拉什么磨」由派单系统回答（全引擎都有）；「磨到什么细度」由引擎原生任务面回答（有则透出）**。与 specs/006 六引擎适配器的「通用 JSONL 兜底」同构：Codex/Trae/Qwen/CodeBuddy 走 L1+L3，不欠 L2 的债。

### 2.2 输出物挂载（归属显式化）

- **协议**：`/api/deliver` 载荷增可选 `session_id`（显式归属优先）；无此字段回落 deliverByCwd（向后兼容）。
- **worker 自主（Claude 系）**：spawn 时 relay 注入 `CCR_SESSION_ID` 环境变量；deliver CLI 自动读取携带（`--from` 可覆盖）。任务书纪律模板增补条款：「交付时对每个交付物跑 deliver 登记」——进 #43 任务书模板。
- **Codex worker：Leader 核验代挂**。Codex 沙盒 shell 层禁网（安全设计，防提示注入外传）跑不了 curl，这是既定安全代价而非缺陷——Leader 核验通过后 `deliver --from <pm_sid>` 代挂，归属仍记 worker 名下。
- **UI**：输出面板按 session_id 归属渲染；代挂条目带「代挂」角标（审计区分自挂/代挂，可选增强）。

## 3. 落地批次

| 批 | 内容 | 落点 |
|---|---|---|
| A | /api/deliver session_id 字段 + deliver CLI CCR_SESSION_ID/--from + spawn 注入 env + 任务书模板补条款 | M4（#40 派单回调同批）+ #43 |
| B | external 会话 tab 任务面板 = 派单台账视图（DispatchStatus 流渲染） | M4 |
| C | 输出面板「代挂」角标 | 可选增强，随批 B 顺手 |

## 4. 试点期间的临时口径（机制落地前）

- Codex PM 的交付物由 Leader 核验后 commit 并 deliver（现行流程不变，归属错挂问题等批 A）。
- 用户看 PM 产出以 specs/ git log + 输出物看板为准（现惯例），Codex tab 两面板的空态属已知缺口，勿当 bug 报。
