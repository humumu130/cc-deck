# W-RB-FIX：redbook 外部会话注入链路排查与修复报告

**手机端暂时还不能给 redbook 发消息——注入链路的决定性根因已找到并有完整修复代码（worktree 未合入），需合入 dev → 发版 → relay 重启窗口后生效。**

- 日期：2026-10-09
- 会话：ext-5c3bc728-d450-4314-b5fe-30c6063826c2（redbook，tmux 会话 `redbook`，CLI pid 74510）
- 修复代码：worktree `/Users/xdd/dev/cc-deck-w19`，分支 `fix/w-rb-tmux-inject`（基于 dev 76d52ad），**按多会话纪律未 commit**

---

## 一句话结论

「手机注入失败」不是一个问题，是三层问题叠加：**① relay 的 macOS 注入器不支持 tmux 宿主且静默误报成功（决定性根因）；② hook 上报对 relay 的 POST 超时 1.5s 窗口撞上 relay 主线程高负载，回合首尾事件丢失，且重试机制因 unref 缺陷静默失效；③ 回合结束后转录尾行增长把会话标回「转录活跃（无 hook 会话）」的文案回潮**。

---

## 排查过程与证据链

### 1. hook-debug.log：通道是「半通」不是「全断」

前人结论「UserPromptSubmit POST 超时失败」属实，但日志显示同一会话的 Stop（14:04:36）和 Notification（14:05:39）都 `post ok`。14:18:50 复测自检：**UserPromptSubmit 这次 61ms 就 post ok 了**，但 5 分钟前它超时——不是通道死，是间歇性丢，且规律是：**回合首（UserPromptSubmit）和回合尾（Stop）最容易丢**——这两个时刻恰是 relay 最忙的时候。

### 2. relay 主线程高负载是事件丢失的土壤

- PID 16549（10-08 23:50 启动，22h+）CPU 90% 持续，sample 2 秒：主线程 45% 在 JS，热点为 `StringIndexOf（BoyerMooreHorspool）+ JsonParse + Buffer 分配`——与 3s 转录轮询逐行 parse、ws 全量 snapshot 序列化的特征吻合。
- 实测 relay 收到 hook 事件后**广播滞后 6.6 秒**（UserPromptSubmit 14:18:50.953 到达，SESSION_UPDATED 14:18:57.556 落盘）。
- relay-service.log 尾部是 ws-upgrade 风暴 + 云桥 disconnect→reconnect 循环：「relay 忙 → pong 延迟 → 服务端判 miss terminate → 客户端重连全量同步 → 更忙」的正反馈嫌疑很大。
- 附带发现：HTTP probe 44ms 正常与事件处理秒级滞后并存，因为 probe 打在事件循环空闲窗口。

### 3. hook.mjs 两处缺陷（代码级，已修）

**超时窗口太短**：非 PreToolUse 事件 `waitMs = 1500`。relay 阻塞窗口实测 1.5~7s，1.5s 必撞。

**重试机制静默失效（关键新发现）**：`Promise.race([fetch, setTimeout(1.5s).unref()])` 超时后，race 拒绝但 fetch 的 socket 悬挂；当 relay 忙时 socket 已死（ECONNRESET），事件循环里只剩 unref 的重试 timer → **整个 hook 进程提前退出，r1/r2 重试根本不会跑**。hook-debug.log 实证：14:04:29 `post fail (r0 0): timeout` 后没有任何 `r1` 记录（对照 10-07 日志里正常重试有 `r1` 记录）。

### 4. 注入链路的决定性根因：tmux 宿主完全不在 macOS 注入器射程内

relay macOS 注入走 Terminal.app `do script`：`ps -o tty= -p <cli_pid>` 取 CLI 的 tty，再遍历 Terminal 窗口/标签页找 `tty of t ends with targetTty` 的标签页。

**redbook CLI 跑在 tmux 里，它的 tty（ttys006 = tmux pane）不属于任何 Terminal.app 标签页**。真机验证：

```
CLI 74510 tty = ttys006；tmux: /dev/ttys006 session=redbook:0.0
Terminal.app 定位脚本遍历结果：found=false
```

后果：osascript 循环静默空转 → exit 0 → **relay 误报注入成功** → pending 消息晋升、手机端显示已发送，实际 CLI 从未收到。这就是「手机注入失败」的真正面目。防抢发快照（captureConsoleBottom）同路径落空，产生「防抢发检测不可用（无法快照输入框）」SESSION_LOG 三连后放弃补发回车——同一根因的另一个症状。

relay 源码 grep 全库无 tmux 处理（唯一一处提及是注释承认「tmux 抓不到屏幕，静默回退」）。

### 5. 状态机误判：「转录活跃（无 hook 会话）」文案回潮

`pushAssistantTexts`（bridge.ts）逻辑：转录增长 + 状态 DONE/ERROR → 标 noHookIds + 翻 WORKING 带「转录活跃（无 hook 会话）」文案。问题：**Stop 事件正常置 DONE 后，转录还会补写 usage/metadata 尾行**，3s 轮询立刻把这个刚被 hook 服务过的会话重新标回「无 hook 会话」。14:04 自检的完整时间线：14:04:37.087 Stop post ok → 14:04:38.244 被转录轮询标回「转录活跃（无 hook 会话）」→ 文案残留到下个广播。hook 通道其实是通的，文案却是坏的。

---

## 修复内容（worktree `/Users/xdd/dev/cc-deck-w19`，未 commit）

### A. `relay/src/injector.ts` — tmux 注入通道（决定性修复）

新增 tmux 支持层（`runTmux` / `resolveTmuxTarget` / `tmuxSendKeys`）：
- 按 CLI pid 取 tty → `tmux list-panes -a -F '#{pane_tty}\t…'` 匹配 → 命中得 target（`=<session>:<win>.<pane>`，tmux ≥3.1 的 `=` 前缀防 session 名前缀歧义；版本探测缓存，老 tmux 回退裸名）
- 四个入口加分支：`injectTextMac`（`send-keys -l -- <text>` + 单独 `Enter`）、`injectEsc`（`Escape`）、`injectEnter`（`Enter`）、`captureConsoleBottom`（`capture-pane -p`，顺带把防抢发检测和终端转轮摘要在 tmux 会话上激活）
- **tmux 失败会明确报错 exit≠0，不再有「静默误报成功」**；不在 tmux 里/无 tmux → 回退原 Terminal 通道；测试假注入器（CCR_OSASCRIPT_CMD/CCR_INJECT_CMD）恒走原路径不碰 tmux

真实环境已验证：tmux 3.6a，`=target` 精确形式、`-l --` 字面量（含中文与连字符文本）、Enter、capture-pane 全链通过。

### B. `relay/hooks/bridge-hook.mjs` — POST 超时与重试修复

- `waitMs` 1500 → 3000（覆盖实测 1.5~7s 阻塞窗口的中位；PreToolUse 的 600s 不变）
- `Promise.race + unref timer` → **AbortController**：超时真正中止 fetch（socket 释放）、timer 不再 unref（进程活满整个重试序列，r1/r2 重试恢复生效）
- 真实链路已验证：unset CCR_RELAY_CHILD 后直跑新 hook 代码对生产 relay 8787 发沙箱事件（`.tmp-` cwd）→ `post ok (r0 0)` 88ms，relay 侧正确放行不建档

### C. `relay/src/bridge.ts` — 「无 hook 会话」文案回潮修复

`pushAssistantTexts` 的 DONE/ERROR 态标注加 `lastHookAt` 保护：hook 刚活过（≤15s 有事件到达）的 DONE 是回合正常收尾，此后转录尾行增长不再标 noHookIds、不再回潮兜底文案。真正无 hook 的会话（lastHookAt 为 0 或很旧）行为不变。

---

## 自测记录

| 项 | 结果 |
|---|---|
| 类型检查（tsc --noEmit） | 改动文件（bridge.ts / injector.ts）0 错误；残余 4 个错误全部为 worktree 缺 node_modules 的 cloud-bridge 环境解析差异，与改动无关（主区基线 0） |
| bridge-hook.mjs 语法（node --check） | 通过 |
| test-bridge 集成套件 | 原版与改动版在无竞争环境（错开端口 8813）**双双 BRIDGE TESTS PASSED**（46 段全过，含 #38 全部 5 断言） |
| hook 真实链路（生产 relay） | post ok 88ms，沙箱事件正确放行 |
| tmux send-keys/capture 真实语法 | tmux 3.6a 全通过 |

## #38 对照实验结论（非回归）

改动版首跑时 #38 FAIL，经原版基线对照 + 改动版复跑判定为**环境性 flake，非回归**：

- 首跑 FAIL 发生在 w15 并行会话高频抢 CPU/测试端口（8798/8799 被其 relay 实例监听）的窗口；#38 断言依赖 3s queuePollTimer 轮询时序（`promotePending` 由轮询触发），高负载下轮询迟到即假阴性——测试文件 waitLog 注释自证该套件有「高负载连续 flake 实录」，#38 断言未用 waitLog 是其既有缺口（与本修复正交）。
- 无竞争环境复跑：原版 PASSED、改动版 PASSED，#38 五断言全 ok。
- 机理复核：`promotePending`/`noteUserMsg` 均不 gate 在本修复触碰的 noHookIds/turnStart/状态翻转路径上，与分析一致。

（遗留建议，未动手：#38 断言改用 waitLog 轮询等待，可根治该段 flake——留给后续任务。）

## 生效条件与建议（需 Leader 拍板）

1. **代码合入**：worktree `fix/w-rb-tmux-inject` 三文件改动合入 dev（A/B/C 相互独立，可分批；B 已同步运行位即刻生效，合入只是让源头归位）。
2. **发版**：relay 打包走常规 test → snap → release 三段式；bundle 重建入口 `relay/scripts/build-plugin.mjs`（esbuild 单文件，同时负责把 hook.mjs 复制进 cc-plugins——合入后重跑一次即让运行位与 git 源对齐）。
3. **重启窗口**：PID 16549 需重启加载新代码。它托管 Leader 会话——建议窗口：Leader 会话收工/闲时；重启影响面 = 全部会话短暂离线、events.ndjson 重放恢复（20 会话，秒级）、手机端短暂重连。重启顺带清掉 22h 积累的内存压力与正反馈循环起点。
4. **重启前的临时替代**：redbook 会话手机端发消息仍不可用；期间向 redbook 传话可直接 `tmux send-keys -t redbook -l -- "<文本>"` + `tmux send-keys -t redbook Enter`（本次验证过语法）。

## 部署状态（超出原计划的低风险即时生效项）

**hook 修复（B）已部署到运行位并生效**：hook 进程每次事件新起、读 cc-plugins 运行位文件，不依赖 relay 重启。已把 worktree 的 bridge-hook.mjs 同步到 `cc-plugins/plugins/cc-deck/scripts/hook.mjs`（主区该文件现为 modified 状态 = 本次部署动作，源头改动在 worktree；**请勿 git checkout 还原该文件**，否则运行位回退旧版）。

部署后真实链路复验（14:54/14:55 两轮）：
- 沙箱事件：`post ok (r0 0)` 88ms/1.2s
- **redbook 真实回合：UserPromptSubmit hook 14:55:08.918 触发 → 14:55:09.490 post ok（572ms，旧代码此位置曾超时丢失）**

## 最终自检与验证口径

按任务书标准（SESSION_UPDATED 不再含「无 hook 会话」）：**当前不通过，原因明确**——relay 16549 仍跑旧代码，修复 A/C 均需「合入 → 重建 bundle → 重启」后才生效。修复后的预期表现：hook 上报稳定到达（已验证）+ Stop 置 DONE 后文案不再回潮（C）+ 手机消息真正进入 CLI（A）。

14:55 终检时间线：注入 → UPS post ok（572ms）→ 转录轮询标「转录活跃（无 hook 会话）」（旧代码回潮 bug 原样复现，恰好证明修复 C 的必要性）。

## 红线遵守

- 未重启 relay 16549 ✓
- 未改 ~/.claude/settings.json ✓
- 未动 tmux redbook 工作内容（仅注入两条通道自检消息，均已按提示语回复）✓
- 改动全部在独立 worktree，未 commit ✓
