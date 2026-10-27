# 野生会话纳管（#279）——org 可发现性与规则约束通道

> 背景：用户项目目录直接开的 Claude Code 会话（「野生会话」）此前对 cc-deck 零感知——
> data-integration-platform 会话用内置 Agent 工具自建编排团队（共享任务板+匿名 subagent
> 派工）全程绕开 org 体系，根因是**它不知道 cc-deck 存在**。本机制做「纳管」不做「管制」：
> 广播在场、开放规则、指路分诊；官方 Agent Teams 等 CLI 实验特性不绑定、不背书。

## 一、SessionStart 广播（默认启用）

**链路**：CLI 会话启动（startup/resume/clear）→ 插件 hook（`hooks.json` 的 `SessionStart`
事件 / `relay/scripts/install-hooks.mjs` 全局安装面）→ `relay/hooks/bridge-hook.mjs` 走既有
`/bridge/hook` 上报（SessionStart 专用：2s 短窗、单轮不重试，不拖慢开局）→
`bridge.onSessionStart`（严格只读：不建卡、不改状态，外部卡仍由首条 UserPromptSubmit 建）→
`session-manager.sessionStartBroadcast(cwd)` 组清单+PM 值守快照 → hook 以
`hookSpecificOutput.additionalContext` 回传注入会话上下文。

**文案**（≤5 行，分层指引=共存不禁止，1027 PM 裁决）：

```
[cc-deck] 本机有 cc-deck 团队调度（PM 值守：在岗 ✓ / 当前无在岗 PM）。项目组 N 个：★名（当前目录组）…
[cc-deck] 会话内短平快子任务可用内置 Agent/subagent 自理；立项级/跨会话/多成员编排走 org 分诊（org status / org dispatch），PM 值守在岗时自动接管记账。
[cc-deck] 团队规则镜像 ~/.cc-deck/RULES.md；组织说明 ~/.cc-deck/org/CLAUDE.md。
```

- PM 值守口径 = `dutyTargetId()`（no-leader 模式=最近活跃 external 会话+cli_pid 探活；
  leader 模式=锚卡在位语义，不新增探活）。`org.json leader_session_id` 为遗留字段，
  广播与 status 均不依赖（#279 修正④）。
- **降级语义**：relay 未起/超时/老版本不回 context → hook 零输出，会话照常启动（广播是
  增益不是依赖）。老 hook 版本没有 SessionStart 处理 → CLI 不触发该事件注册，同样静默。
- relay 自管的托管会话（CCR_RELAY_CHILD=1）不经此广播——它们的纪律注入走
  `wrapDispatchPrompt`（经验/规则/岗位块），不重复。

## 二、规则可发现性：RULES.md 镜像（默认启用）

规则真相唯一在 `~/.cc-deck/org/rules.json`（`org rule append|retire|supersede` 命令面）。
`team-rules.saveRules` 每次写库后把 **active 条目**镜像到 `~/.cc-deck/RULES.md`（org 目录
旁；沙盒形态随 `CCR_ORG_DIR` 隔离），relay 启动时自愈刷新一次。镜像为机器生成文件，手编
会被下次写库覆盖；每行格式 `[rule-id] audience · scope：文本`。

## 三、可选 PreToolUse 拦截模板（默认不启用，仅文档化）

> 定位：给「想把团队规则变成硬约束」的用户的起步模板。默认不装——团队经验与产品判断
> 一致：自然语言规则无法机械判定违规，硬拦截极易误伤（过度管控），先广播+镜像软引导。

模板骨架（自行放入 `~/.claude/settings.json` 的 `PreToolUse`，或项目 `.claude/settings.json`）：

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Task",           // 只看编排类工具，日常 Edit/Bash 不拦
        "timeout": 10,
        "hooks": [
          { "type": "command", "command": "node ~/.cc-deck/bin/rules-reminder.mjs" }
        ]
      }
    ]
  }
}
```

`rules-reminder.mjs` 要点（自写，不随包分发）：读 stdin 的 `tool_name/session_id` → 读
`~/.cc-deck/RULES.md` → 从 `~/.cc-deck/org/projects.json` headcount 反查 session 角色 →
按 audience（`all` / `role:<本会话角色>`）过滤 → 命中时输出
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"团队规则提示：<命中条目>"}}`
——模板建议用 `ask`（升级为人工确认）而非 `deny`；野生会话不在编制内无角色，仅命中
`audience:all` 条目。role 感知依赖 org headcount 的 sid 映射，会话被 retire 后自然退化为
全员口径。

## 四、org status 值守视图（PM 心跳/接管指引）

`org status` 返回新增 `pm` 块：`{ mode, session_id, alive, hint? }`——`alive=false` 时带
`hint: "当前无在岗 PM，分诊暂缓或走接管流程"`（与 #261 备档「死席巡检提示」同族同口径，
提示语单源在 `pmDutyStatus()`，勿在别处复写）。Leader 会话/野生编排会话据此决定：等 PM
回岗、走 org 面板接管、或暂缓跨会话编排。

## 五、显式不做（PM 裁决，防范围蔓延）

- 不绑定/不配置官方 Agent Teams 实验特性（cc-deck 有自有 org 体系）；广播文案不提它。
- 不自动补记野生多 Agent 工作进 dispatch-log（误判成本高）——先靠广播引导走正道，观察期后再议。

（#279；实施分支 fix/wild-session-onboarding；测试 `relay/scripts/test-wild-onboard.ts`）
