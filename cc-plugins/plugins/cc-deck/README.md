# CC Deck

把 Claude Code 桥接给手机 / 手表 / 网页远程操控：手机上实时看会话状态、发消息、审批权限、管任务清单；CLI 会话由 hooks 自动接入，无需手动注册。

## 使用

### 1. 启动

在任意 Claude Code 会话里执行：

```
/cc-deck
```

命令会以后台守护方式启动 relay（数据目录 `~/.cc-deck/data`，日志 `~/.cc-deck/data/relay.log`），并显示两个二维码：

- **App 下载码**：手机摄像头扫描，下载安装 CC Deck App；打开后选「新增服务器」，填二维码上方标明的 `局域网IP:8787` 即可连接。
- **网页控制台码**：同电脑浏览器打开 `http://127.0.0.1:8787/?token=...` 自动直连；其他设备需带 token 访问。

装完后**新开的** Claude Code 会话会自动出现在手机上（hooks 已由插件注册）；当前已运行的会话需新开会话才接入。

### 2. 停止

```
/cc-deck-stop
```

## 命令与文件

| 项 | 说明 |
|---|---|
| `/cc-deck` | 启动守护 relay + 显示连接二维码 |
| `/cc-deck-stop` | 停止后台 relay |
| `hooks/hooks.json` | 六类事件（UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd）自动桥接 |
| `scripts/relay.mjs` | relay 单文件打包（源码见主仓库 `relay/`） |
| `scripts/hook.mjs` | 事件上报 + 远程审批（PreToolUse 最长等 600s） |
| `~/.cc-deck/data/` | token / bridge.json / events.ndjson / relay.log 等运行数据，与插件升级解耦 |

## 注意

- 若 `~/.claude/settings.json` 中存在旧版 `bridge-hook.mjs` 手动 hooks（`relay/scripts/install-hooks.mjs` 安装），会与本插件重复上报，建议删除旧条目。
- 远程权限审批依赖手机在线；手机不在线时 CLI 走本地正常权限流程。
- LAN 直连未启用 TLS，token 会出现在 URL 中——仅限可信局域网使用；跨公网场景请走云桥（E2E 加密）。
- 云桥（外出场景经公网中继）默认连 CC Deck 公共桥，开箱即用；自建/禁用用 `CCR_CLOUD_URL` 覆盖，详见主仓库 README。

## 从源码构建

```bash
cd relay && node scripts/build-plugin.mjs   # bundle relay.mjs + 汇集静态资源到 ../cc-plugins/plugins/cc-deck/
```
