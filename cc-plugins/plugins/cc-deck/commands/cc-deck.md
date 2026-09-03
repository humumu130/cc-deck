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

- 手机扫第一个码下载安装 CC Deck App，打开后选「新增服务器」填本机局域网地址（二维码上方标明的 IP:8787）即可连接；同电脑浏览器打开 `http://127.0.0.1:8787` 会自动直连，无需配置。
- 装完后新开的 Claude Code 会话会自动出现在手机上（hooks 已由插件注册）。当前已运行的会话需要新开会话才会接入。
- 停止用 `/cc-deck-stop`。

注意：若用户 ~/.claude/settings.json 中已存在旧的 bridge-hook.mjs 手动 hooks（relay/scripts/install-hooks.mjs 安装的），提醒用户二者会重复上报，建议手动删除旧条目。
