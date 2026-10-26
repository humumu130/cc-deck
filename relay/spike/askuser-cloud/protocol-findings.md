# #273 AskUserQuestion 云回传——协议实测与事故解码（断点固化 1026 晚）

> 分支 fix/askuser-cloud-return（基于 fedd93cf）。本件=协议实测结论+passcomb 事故数据解码+现状机制地图。
> 复现 harness：capture.mjs（A：裸 SDK 无 canUseTool）/ captureC.mjs（C：canUseTool deny-message 作答）。
> 报文样本：wire-samples/（真实 CLI 2.1.241 一对 control_request/control_response）。

## 一、协议实测结论（任务书步骤 1，已闭环）

环境：SDK `@anthropic-ai/claude-agent-sdk@0.3.241`（relay package.json "latest" 当前解析值），
SDK 自带 CLI `claude-agent-sdk-darwin-arm64/claude` = **2.1.241**（生产 managed 会话同源）；
端点 bigmodel GLM；`CCR_RELAY_CHILD=1` 隔离 hook 上报。

**关键形态纠偏：AskUserQuestion 在 SDK/stream-json 形态下不走 `request_user_dialog`，走 canUseTool 权限通道。**

1. **工具可用性门**：SDK 会话不传 `canUseTool`（→ CLI 不带 `--permission-prompt-tool stdio`）时，
   **模型工具清单里根本没有 AskUserQuestion**（capture A：模型自述无此工具，正常答完收场）。
   传 canUseTool → 工具出现，模型可调用。dialog 通道（`request_user_dialog`/`supportedDialogKinds`，
   dialog_kind 全清单见 CLI 二进制 `Ko({kind:"..."})`，ask 对应 `permission_ask_user_question`）是
   更新的并行机制，2.1.241 的 canUseTool 路径实测仍为主路径。
2. **下发报文（CLI stdout，实抓）**：
   ```json
   {"type":"control_request","request_id":"<uuid>","request":{
     "subtype":"can_use_tool","tool_name":"AskUserQuestion",
     "display_name":"AskUserQuestion",
     "input":{"questions":[{"question":"…","header":"…","options":[{"label":"…","description":"…"}],"multiSelect":false}]},
     "tool_use_id":"call_…","requires_user_interaction":true}}
   ```
3. **应答报文（CLI stdin，实抓）**——由 SDK 从 canUseTool 返回值代写：
   ```json
   {"type":"control_response","response":{"subtype":"success","request_id":"<同上uuid>",
     "response":{"behavior":"deny","message":"用户回答：「饺子」","interrupt":false,"toolUseID":"call_…"}}}
   ```
   - **作答=deny-message**（summarizer.buildAnswerMessage 现行机制）：deny message 作为 tool_result
     回给模型，模型按答案继续。allow+updatedInput.answers 会被 SDK 忽略（summarizer.ts:79 旧 spike
     结论，本批未翻案）。
   - pending 键 = `opts.requestId` = control_request 的 request_id（≠ tool_use_id）——
     与 agent-adapter `opts.requestId ?? opts.toolUseID` 现行取法一致。
4. **CLI 级续跑确认**（capture C）：deny 回写后 num_turns=2，CLI 立即发起下一轮 API 调用——
   死锁解除。C 变体最终 result 报 `Prompt is too long`（turn-2 输入 264K）为 bigmodel 端点
   无缓存硬限的测试环境工件，**与通道无关**（生产 passcomb 同端点 2M 输入可跑）。

## 二、passcomb 事故解码（生产 events.ndjson 只读取证）

会话 4c12cccd（cwd ~/dev/keyhive，relay 派生 managed）：
- `SESSION_WAITING` ts=1792992924：AskUserQuestion「旧数据处理」waiting 卡**正常建卡下发**（questions 完整）。
- `SESSION_WAITING_RESOLVED` ts=1792998003：`decision:"deny" by:"relay"` —— **5080 秒（84.6 分钟）后**才决议，
  by:relay = PM kill 时 denyAllPending/sweep 清扫，非真实作答。
- 结论：**下发链通、上行链断**——期间任何客户端的作答都没送达 `agent.answer()`；且 managed pending
  无任何超时放行（external 有 questionHoldMs 90s，managed 无对应物）→ 双缺。

## 三、现状机制地图（哪段已存在/哪段缺）

| 段 | 现状 | 锚 |
|---|---|---|
| 下发：managed canUseTool → waiting 卡（含 questions） | ✅ 已存在 | agent-adapter.ts:965 handlePermission → onWaiting |
| 下发：external PreToolUse hook → waiting 卡 | ✅ 已存在（90s questionHoldMs 超时放行本地选择器） | bridge.ts:3221/:3403 |
| 命令面：COMMAND_ANSWER（external=answerPending / managed=agent.answer） | ✅ 已存在 | commands/session-commands.ts:425 |
| 云白名单：COMMAND_ANSWER 在 cloud COMMAND_TYPES | ✅ 在列 | cloud-client.ts:56 |
| 上行真实断点 | ❓ 待定位：面板/手机端 waiting 卡是否可作答（managed questions 形态）、云链 SESSION_WAITING 帧转发、作答回传实测 | 待查 web-console/expo/app2 |
| managed 超时放行 | ❌ **不存在**（passcomb 84min 实锤） | agent-adapter pending 无时限 |
| 「已失效」回收 | 部分：external 超时决议有广播；端上 TTL 置灰锚 received_at 已挂 | W-ASKFIX ③ |

## 四、下一步（实施批）

1. 定位上行断点（面板渲染/云帧转发/回传实测三处逐一核）。
2. managed AskUserQuestion 超时放行（默认窗口+超时 deny-message「远程未作答」+通知+decision:"timeout" 决议广播）。
3. 幂等：重复 COMMAND_ANSWER 不二次写（answer() false → ok:false 已天然幂等，补断言锁死）。
4. 「已失效」回收链自洽（超时决议 → 端上置灰终态）。
