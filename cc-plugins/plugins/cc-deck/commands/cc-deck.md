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

命令收到 ACK（`ok:true`）后打印 `ok=true` 与 `command_id`；relay 明确拒收（`ok:false`）立即非零退出；超时或断线自动短重试一次（stderr 提示「第 2 次尝试」，沿用同一 command_id 防双投），仍无有效 ACK 才非零退出并提示转人工巡检。
每次投递追加审计行（含 `attempt` 尝试次数）到 `$CCR_DATA_DIR/cli-dispatches.ndjson`，未设置时使用 `~/.cc-deck/data`。

## 派单巡检对账

收到 dispatch 的「转人工巡检」提示，或需定期核对派单审计账时，用插件内置 `dispatch-report` 做四类判定（orphan 未达待重投 / duplicate 重复迹象 / timeout 重试用尽 / seq-gap 行完整性与时序）：

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report"              # 人类可读；账本取 $CCR_DATA_DIR/cli-dispatches.ndjson
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report" --json       # 机器可读 {counts, items, verdict}
"${CLAUDE_PLUGIN_ROOT}/bin/dispatch-report" --strict     # duplicate/seq-gap 也升级为非零退出
```

退出码：`0` = 账干净或仅 warn（duplicate/seq-gap 属待人工核验，不阻断）；`1` = orphan/timeout 待处置（`--strict` 下含 duplicate/seq-gap）；`2` = 用法错误或账本不存在。成功只认审计行 `ok` 严格布尔真，字符串或缺省一律不进成功账；DELIVER 行（deliver 直投）不入此对账面。
