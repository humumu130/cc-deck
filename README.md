# Cloud Code Relay

远程查看/控制 PC 上的 Claude Code 会话 —— 手机（Android）+ 手表（Wear OS）。

PC 侧 Claude Code 接入智谱 GLM API（自定义 `ANTHROPIC_BASE_URL`），官方 Remote Control 不可用，
故自建 Relay。完整技术决策见 [design/技术方案评审.md](design/技术方案评审.md)。

## 当前状态：里程碑 4（云桥）+ M3 手机网关已完成

LAN 直连与云桥中继全链路均已跑通，手机 App（Expo）优先 LAN、外出自动切云通道（E2E 加密），
并把会话快照经 Wear Data Layer 转发给手表。

```
浏览器（PC / 手机，同局域网）
   └─ ws://<pc-ip>:8787/ws?token=xxx ─┐
                                     ├─> 💻 PC Relay（relay/）
📱 手机 App（expo-app/，优先 LAN 直连）┘      ├─ SessionManager   多会话表 + 状态机（WORKING/WAITING/ERROR/DONE）
   └─ 外出时经 ☁ 云桥（cloud-bridge/ 或 cloudflare/）│  ├─ AgentSession     Agent SDK streaming；canUseTool 挂起 → 远程 Allow/Reject
        （PC/手机均出站连接，桥只见密文）      │  ├─ EventBus         全局 seq + 环形缓冲(500) + 断线补发(last_seq) + 落盘
                                              │  └─ ws-server        token 鉴权 + 命令路由 + 全量快照
⌚ 手表（wear-app/）<─ Wear Data Layer ─ 手机网关（expo-app/modules/wear + src/watch.ts）
```

会话历史持久化在 `relay/data/events.ndjson`（gitignore）：Relay 重启后自动恢复历史会话
（含时间线，标记为"历史"不可操作），seq 跨重启延续，断线客户端可无缝补发。

## 快速开始

```bash
cd relay
npm install
npm run dev
```

启动后控制台打印 Web 控制台地址（含 token），形如：
`http://192.168.x.x:8787/?token=<random>`。
手机连同一 WiFi 用浏览器打开即可（里程碑 1 的"准移动端"验收方式）。

手机原生 App：`cd expo-app && npm install && npx expo run:android`，
LAN 连上后在设置页「配对云桥」即可获得外出云通道。

## 云桥（M4）

LAN 不可达时手机经云桥中继连接 PC Relay，双方都只发起出站连接：

- **协议**：`ws://<bridge>/cloud?token=<桥token>&dev=<设备id>`；客户端帧 `{to, data}`，
  `data` 为 E2E 密文信封 `{n,c}`（tweetnacl box），桥不可解、无持久化无缓冲；
  断线补发复用 Relay 的 seq/last_seq 机制
- **E2E**：手机/Relay 各持一对 box 密钥（AsyncStorage / `relay/data/cloud-keypair.json`），
  设备 id 从公钥派生（`ph-`/`rl-` 前缀 + 公钥前 8 字节 hex）
- **配对**：手机与 Relay 同 LAN 在线时一键配对（信任锚 = LAN token）：
  `COMMAND_PAIR_START` → Relay 记 `data/cloud-peers.json` → ACK 回云桥参数落手机
- **双形态**：`cloud-bridge/`（Node + ws，Docker 就绪）与 `cloudflare/`（Worker +
  Durable Object）共享同一纯函数路由核心 `router.ts`；本机各起 8790/8791 均已验证
- **启动**：Relay 侧设 `CCR_CLOUD_URL` + `CCR_CLOUD_TOKEN` 即启用出站云客户端；
  未配对的手机设备帧直接丢弃

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCR_PORT` | `8787` | 监听端口 |
| `CCR_TOKEN` | 随机生成并打印 | 鉴权 token（重启不变需显式设置） |
| `CCR_CWD` | relay 目录 | 新建会话缺省工作目录 |
| `CCR_MODEL` | `ANTHROPIC_DEFAULT_SONNET_MODEL` | 会话模型（必须显式传给 SDK，否则 CLI 会拼 `[1m]` 后缀） |
| `CCR_DEBUG` | - | 打印 CLI stderr 与 tool_use_result 原始结构 |
| `CCR_GATE_TOOLS` | `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch` | 外部会话远程审批门控的工具名（逗号分隔） |
| `CCR_BRIDGE_TOKEN` | `relay/data/bridge-token` | hooks 桥接令牌（默认首启生成后固定） |
| `CCR_CLOUD_URL` | -（禁用） | 云桥地址如 `ws://host:8790/cloud`，设置后启用云客户端 |
| `CCR_CLOUD_TOKEN` | - | 云桥层连接 token |

### 调试台功能

- 视觉：OLED 黑底 + 蓝紫品牌色 + 四态色（WORKING 青绿呼吸 / WAITING 琥珀 / ERROR 红 / DONE 蓝）
- 新建会话（指定 cwd + 初始指令）；会话卡片带自动标题 + 四态徽标 + `N 文件 · +N -M`
- WAITING 卡片内联"处理"入口；详情页 活动 / 日志 / 统计 三 Tab
- 历史会话（Relay 重启前遗留）灰显为"历史"，时间线完整可查、不可操作
- 追加消息（开新回合）、停止会话；断线自动重连（携带 last_seq 补发）

## Hooks 桥接外部会话（M1.3）

用户自己开的 Claude Code CLI 会话（非 Relay 拉起）经 hooks 单向接入：

- `relay/hooks/bridge-hook.mjs`（已装进 `~/.claude/settings.json`，与 traffic-light 并存）→
  POST 本机 `/bridge/hook`（loopback + `relay/data/bridge.json` 里的 token）
- Relay 未运行时 hook 立即退出（<50ms），对 CLI 零影响
- 外部会话在控制台带「外部」徽章：状态/时间线单向可见，标题取自 prompt
- **远程审批**（默认关，控制台会话详情头开关）：开启后 `Bash/Edit/Write/WebFetch` 等
  （`CCR_GATE_TOOLS` 可配）在**有客户端在线时**挂起等手机/网页 Allow/Reject
  （最长 590s，超时回退 CLI 本地流程）；终端切 `--dangerously-skip-permissions`
  （hook payload `permission_mode=bypassPermissions`）则完全放行
- 外部会话不支持远程发消息/停止（hooks 无输入通道）

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
npm run test:history   # 历史持久化：压缩/重放/跨重启 seq/adopt
npm run test:bridge    # hooks 桥接：外部会话/远程审批/超时/鉴权
npm run test:cloud     # 云通道端到端：配对/密文收发/断线补发/未配对拒收
npx tsx scripts/smoke-e2e.ts <token>   # 对运行中的 dev server 走浏览器等价全流程
```

cloud-bridge/ 下：`npm run test:cloud`（鉴权/双设备互通/ROUTE_MISS/同 dev 顶替/断连清理）。

## 里程碑路线

- **M1 ✅** Relay + Web 调试台，LAN 直连（含 M1.3 hooks 桥接外部会话）
- **M2 ✅** Android 手机端（expo-app/，Expo 原生，LAN 直连 + 远程审批）
- **M3 ✅** Wear OS 手表端：手表收发端（wear-app/）+ 手机 Data Layer 网关
  （expo-app/modules/wear 原生模块 + src/watch.ts 节流转发；真表联调待验）
- **M4 ✅** 自建云桥双形态（cloud-bridge/ Node + cloudflare/ Worker）+ E2E 加密 +
  手机多通道自动切换（本机全链路验证；公网部署待用户择机）
- 后续：Tiles、扫码配对、多手机、WSS/TLS 部署加固
