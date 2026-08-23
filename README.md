# Cloud Code Relay

远程查看/控制 PC 上的 Claude Code 会话 —— 手机（Android）+ 手表（Wear OS）。

PC 侧 Claude Code 接入智谱 GLM API（自定义 `ANTHROPIC_BASE_URL`），官方 Remote Control 不可用，
故自建 Relay。完整技术决策见 [design/技术方案评审.md](design/技术方案评审.md)。

## 当前状态：里程碑 1（PC Relay + Web 调试台）

LAN 直连全链路已跑通：Web 调试台 ↔ WebSocket ↔ Relay ↔ Claude Agent SDK（智谱 glm-5.3）。

```
浏览器（PC / 手机，同局域网）
   └─ ws://<pc-ip>:8787/ws?token=xxx
        💻 PC Relay（relay/）
           ├─ SessionManager   多会话表 + 状态机（WORKING/WAITING/ERROR/DONE）
           ├─ AgentSession     Agent SDK streaming 模式；canUseTool 挂起 → 远程 Allow/Reject
           ├─ EventBus         全局 seq + 环形缓冲(500) + 断线补发(last_seq)
           └─ ws-server        token 鉴权 + 命令路由 + 全量快照
```

## 快速开始

```bash
cd relay
npm install
npm run dev
```

启动后控制台打印 Web 控制台地址（含 token），形如：
`http://192.168.x.x:8787/?token=<random>`。
手机连同一 WiFi 用浏览器打开即可（里程碑 1 的"准移动端"验收方式）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCR_PORT` | `8787` | 监听端口 |
| `CCR_TOKEN` | 随机生成并打印 | 鉴权 token（重启不变需显式设置） |
| `CCR_CWD` | relay 目录 | 新建会话缺省工作目录 |
| `CCR_MODEL` | `ANTHROPIC_DEFAULT_SONNET_MODEL` | 会话模型（必须显式传给 SDK，否则 CLI 会拼 `[1m]` 后缀） |
| `CCR_DEBUG` | - | 打印 CLI stderr 与 tool_use_result 原始结构 |

### 调试台功能

- 新建会话（指定 cwd + 初始指令）；会话卡片四态色（运行中/等待确认/错误/完成）
- 时间线（助手文本 / 工具调用 / 工具结果 / 系统事件）
- WAITING 卡片：远程 Allow / Reject；文件变更统计 `+N -M`
- 追加消息（开新回合）、停止会话；断线自动重连（携带 last_seq 补发）

## 协议

唯一定义源：`relay/src/types.ts`。信封 `{seq, session_id, ts, type, payload}`；
事件 `SESSION_CREATED/UPDATED/HEARTBEAT/WAITING/WAITING_RESOLVED/ERROR/DONE/LOG/SNAPSHOT`；
命令 `COMMAND_CREATE/MESSAGE/STOP/CONTINUE/REJECT`（`command_id` 幂等去重）。
Android 端（M2）将直接复用此协议。

## 测试脚本（relay/ 下）

```bash
npm run spike          # 验证智谱 env 继承 + 模型自报
npm run test:bus       # EventBus seq/环形缓冲/补发
npm run test:sessions  # 双会话并发全生命周期（含 WAITING→Allow、diff 统计）
npm run test:ws        # WS 鉴权/快照/断线补发/幂等/容错
npx tsx scripts/smoke-e2e.ts <token>   # 对运行中的 dev server 走浏览器等价全流程
```

## 里程碑路线

- **M1（当前）** Relay + Web 调试台，LAN 直连
- M2 Android 手机端（Kotlin/Compose，扫码配对、通知、语音）
- M3 Wear OS 端（Wear Compose，经手机 Data Layer 网关）
- M4（1.5 阶段）自建云桥（Docker，出站 WSS + E2E 加密）、多通道切换、Tiles
