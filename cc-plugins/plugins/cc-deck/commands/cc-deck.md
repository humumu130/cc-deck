---
description: 启动 CC Deck relay 并显示手机扫码连接（App 下载码 + 网页控制台码）
---

启动 CC Deck，把当前 Claude Code 会话桥接给手机/手表/网页端操控。按以下步骤执行，把输出原样展示给用户（二维码必须保持等宽字体原样展示）。

1. 检查 relay 是否已在运行：

```bash
curl -s -m 2 http://127.0.0.1:8787/health
```

2a. 返回 `{"ok":true}`：relay 已在运行，直接跳到第 3 步。

2b. 无响应：以后台守护进程方式启动（数据目录 ~/.cc-deck/data，日志 ~/.cc-deck/data/relay.log）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" --daemon
```

启动后等 2 秒，再 curl 一次 /health 确认。若仍失败，执行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs"` 前台运行查看报错（Ctrl+C 退出后改用 --daemon 重试）。

3. 显示连接二维码（App 下载 + 网页控制台，等宽字体原样输出）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" --qr
```

4. 向用户转述使用方式：

- 手机 App 已装：直接扫第二个码（App 直连码）自动添加服务器，无需手动输入任何地址；未装 App：扫第一个码下载，装好后再扫第二个码连接。
- 同电脑浏览器打开 `http://127.0.0.1:8787` 会自动直连，无需配置；其他设备浏览器打开码旁标明的 `http://<本机IP>:8787`。
- iPhone / iPad：暂无 App，用 Safari 打开网页控制台，可「添加到主屏幕」作全屏应用使用。
- 装完后新开的 Claude Code 会话会自动出现在手机上（hooks 已由插件注册）。当前已运行的会话需要新开会话才会接入。
- 异地设备（公司网页端/不在局域网的手机）接入用 `/cc-deck-pair` 领 8 位配对码。
- 停止用 `/cc-deck-stop`。

注意：若用户 ~/.claude/settings.json 中已存在旧的 bridge-hook.mjs 手动 hooks（relay/scripts/install-hooks.mjs 安装的），提醒用户二者会重复上报，建议手动删除旧条目。

## 向指定会话投递消息

使用插件内置 `dispatch` 通过 relay WS 投递 `COMMAND_MESSAGE`：

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch" -c '{"text":"请继续处理"}' <session_id>
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch" payload.json <session_id>
```

命令收到 ACK（`ok:true`）后打印 `ok=true` 与 `command_id`；relay 明确拒收（`ok:false`）立即非零退出；超时或断线自动短重试一次（stderr 提示「第 2 次尝试」，沿用同一 command_id 防双投），仍无有效 ACK 才非零退出并提示转人工巡检。单拍 ACK 等待默认 15 秒，慢网可用 `CCR_ACK_TIMEOUT_MS`（毫秒）调整。

无网/失败回退（失败不丢单）：连接性失败（连不上/超时/断线）短重试用尽后**自动转存待发队列** `$CCR_DATA_DIR/cli-deferred.ndjson`（exit 仍为 1=失败终态；stderr 给出 `--retry`/`--discard` 处置入口；relay 明确拒收不转存——业务错重投无意义）。已知 relay 不在线时也可 `--defer` 显式代挂：跳过投递直接转存，exit 3=挂起。队列 append-only，每行一个生命周期事件（queued 含原 envelope 全文=重投凭据 / done / discarded），每单文件序最后一行为当前态。relay 恢复后处置：

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch" --retry <dispatch_id>     # 补投：同 dispatch_id 续链、attempt 续号、同 command_id（幂等不双投）
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch" --discard <dispatch_id>   # 放弃：exit 0 放弃终态，台账原始失败行保留
```

`--retry` 成功后同一 dispatch_id 在台账有「失败+成功」两行、phase 日志同链贯穿两次投递，`grep '"dispatch_id":"<id>"'` 一键对账。退出码：`0`=成功或放弃、`1`=失败（含自动转存——转存是挂起不是成功）、`2`=队列不可操作（队列不存在/单不在挂起态）、`3`=挂起（`--defer`）。receipt 三态可判：成功（exit 0+台账 ok:true）/放弃（--discard exit 0+队列 discarded）/挂起（--defer exit 3+队列 pending），两账合看不静默丢单。

每次投递追加审计行（含 `attempt` 尝试次数）到 `$CCR_DATA_DIR/cli-dispatches.ndjson`，未设置时使用 `~/.cc-deck/data`。同时每拍向 stderr 打单行 JSON 过程日志（phase=send/ack/final/queued，恒含 `session_id/dispatch_id/command_id`）并落盘 `$CCR_DATA_DIR/cli-phase.ndjson`——按 dispatch_id 对账投递全链用：

```bash
grep '"dispatch_id":"<id>"' "$CCR_DATA_DIR/cli-phase.ndjson"   # 投递→ACK→final→queued 全拍
```

## 派单巡检对账

收到 dispatch 的「转人工巡检」提示，或需定期核对派单审计账时，用插件内置 `dispatch-report` 做判定（orphan 未达待重投 / duplicate 重复迹象 / timeout 重试用尽 / seq-gap 行完整性与时序 / deferred 挂起待补投）：

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report"              # 人类可读；账本取 $CCR_DATA_DIR/cli-dispatches.ndjson
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report" --json       # 机器可读 {counts, items, verdict}
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report" --strict     # duplicate/seq-gap 也升级为非零退出
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report" --phase      # 过程面：三拍链完整性（断拍=可判定）
```

退出码：`0` = 账干净或仅 warn（duplicate/seq-gap/deferred 属待人工核验，不阻断）；`1` = orphan/timeout 待处置（`--strict` 下含 duplicate/seq-gap），`--phase` 下为断拍/终态账缺行；`2` = 用法错误或账本不存在。成功只认审计行 `ok` 严格布尔真，字符串或缺省一律不进成功账；DELIVER 行（deliver 直投）不入此对账面。

deferred 第四态：台账行 error 带 `deferred:` 前缀=挂起待补投（≠失败≠成功），排除出 orphan/timeout 单列，并交叉同目录队列账（cli-deferred.ndjson）互证当前态——队列 discarded=已放弃终态不再算异常、仅队列挂起无台账行（--defer 直转存）单列 queue_pending。挂起是已知状态非损坏，只 warn 不阻断；处置走上面 `--retry`/`--discard`。

`--phase` 对账的是投递过程链（投递→ACK→final 三拍齐不齐、成功链有没有落进终态账），不判定命令执行结果——ACK ok 只证明投达，不证明会话执行了命令；终态失败（orphan/timeout）归上面主对账面处置。仅 queued 一拍的挂起链（--defer 直接转存）不算断拍，单列 pending_chains 提示；`--retry` 补投成功同 dispatch_id 续链（final 取末次拍），自然归 complete。

## 交付物登记（deliver）

输出物看板登记用插件内置 `deliver`（文件留在原地，只登记路径）：

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/deliver" <文件路径>                    # 会话归因走环境变量链
"${CLAUDE_PLUGIN_ROOT}/bin/deliver" --session <id> <文件路径>     # 显式归因（跨会话代登记/修正用）
```

会话归因取值顺序：`--session` 显式参数 > `CC_DECK_SESSION_ID` > `CLAUDE_CODE_SESSION_ID` > `CLAUDE_SESSION_ID`；全缺时 stderr 警告（可能挂错会话卡），不静默丢归因。relay 不可达时按 curl 错误分类给出可判定文案（连接拒绝/超时/网络错误），单请求超时默认 15 秒，`CCR_TIMEOUT`（秒）可调；ACK 非 `ok:true`（明确拒收或 body 无效）一律非零退出，不静默丢单。
