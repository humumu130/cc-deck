# CC Deck

**从手机 / 手表 / 网页远程查看与控制 PC 上的 Claude Code 会话。** 自建 relay，不依赖任何官方远程服务。

在 PC 上跑一个轻量 relay，Claude Code 的会话状态、权限审批请求、提问都会实时同步到你的 Android 手机、Wear OS 手表和浏览器；在手机上发消息、点审批、追任务进度，PC 上的编码会话照常运转。外出时经云桥中继，端到端加密，桥本身只见密文。

<!-- TODO: 截图占位 —— 等整理出手机端 / 网页控制台 / 手表端实际截图后补充 -->

## 功能特性

- **会话状态实时同步**：多会话列表 + 四态徽标（运行中 / 等待输入 / 出错 / 完成），断线自动重连并按 seq 补发错过的事件
- **远程审批与打断**：Bash / Edit / Write 等工具调用挂起等你 Allow / Reject（可配置工具清单，最长挂起约 10 分钟后回落 CLI 本地流程）；随时远程停止会话
- **消息注入与排队**：手机上直接给会话发消息（支持附带压缩后的图片）；会话忙时消息排队，空闲自动送入
- **AskUserQuestion 远程作答**：模型向你提问时，问题实时推到手机，选项远程点选
- **任务清单**：TodoWrite 的 todos 结构化下发，手机端进度条 + 逐项状态
- **thinking / Markdown 渲染**：时间线完整转录工具调用、diff、思考过程
- **子 Agent 状态**：并行子 Agent 单独成卡，各自带状态与摘要
- **云桥跨网络接入**：PC 与手机都只发出站连接，tweetnacl 端到端加密，中继桥零知识
- **Wear OS 手表端**：会话快照经手机网关转发到手表，抬腕查看状态
- **历史会话恢复**：事件落盘持久化，relay 重启后自动恢复历史会话与时间线

## 架构

```
                ┌──────────────────── PC ────────────────────┐
                │  Claude Code CLI（你自己开的各个会话）      │
                │     │ hooks（6 类事件上报 + 审批挂起）      │
                │     ▼                                      │
                │  CC Deck Relay  ──── 出站连接 ────┐        │
                │   （:8787，token 鉴权，            │ 仅密文 │
                │     事件总线 + 历史持久化）        ▼        │
                └──────┬──────────────────────► ☁ 云桥 ──┐   │
                       │ ws://<PC-IP>:8787/ws?token=…    │   │
        ┌──────────────┴────────────┐                   │   │
        ▼                           ▼                   ▼   ▼
  🌐 网页控制台                📱 手机 App（Android）  （跨网络设备同样只发出站连接，
  http://<PC-IP>:8787/         │                     经云桥互通，E2E 加密）
  （手机浏览器也能用）          ├─ 局域网内：直连 relay
                              └─ 外出时：自动切云桥通道
                                 ⌚ Wear OS 手表 ◄── 手机网关转发快照
```

- **局域网形态**：手机 / 手表 / 网页直接 WebSocket 连 PC 上的 relay（`:8787`，token 鉴权）
- **云桥形态**：PC relay 与手机都向桥发起**出站** WebSocket，帧为端到端密文信封 `{n,c}`，桥只按公钥派生的设备 id 路由，无法解密、不持久化；默认公共桥开箱即用，也可 4 条命令自建（见下文）

更完整的模块图 / 数据流时序 / 持久化与可靠性机制，见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

三条路径任选：**①** Claude Code 插件（推荐，一键装好 relay + hooks）；**②** 手动跑 relay（适合读源码、改代码）；**③** 手机端安装。①②是 PC 侧的不同装法，③配合①或②使用。

### ① Claude Code 插件（推荐）

```bash
claude plugin marketplace add humumu130/cc-deck
claude plugin install cc-deck@cc-deck-plugins
```

装好后重启 Claude Code，在任意会话里：

```text
/cc-deck          # 后台启动 relay + 显示两个二维码（App 下载码、网页控制台码）
/cc-deck-pair     # 领 6 位云桥配对码（异地设备输码接入，20 分钟内有效、一次性）
/cc-deck-stop     # 停止后台 relay
```

- 数据目录 `~/.cc-deck/data/`（token、日志 `relay.log`、事件历史），与插件升级 / 卸载解耦
- 插件自带的 hooks 会自动把**新开的** Claude Code 会话桥接进来（含远程审批）；已运行的会话需新开后才接入
- 同电脑浏览器打开 `http://127.0.0.1:8787/?token=…`（二维码里带 token）自动直连

### ② 手动跑 relay

要求：Node.js ≥ 20，且 PC 上已能正常使用 `claude` CLI（模型 / API 配置由你现有环境决定）。

> 平台说明：Windows / macOS / Linux 均可运行 relay。仅「向外部 CLI 会话注入按键」（发消息 / 打断 / 晚到作答）依赖 Windows 专属注入器，其他平台上外部会话为只读监控 + 审批；relay 自己管理的会话全功能可用。

```bash
cd relay
npm install
npm run dev
```

启动后控制台打印（首启自动生成随机 token 并持久化到 `relay/data/token`）：

```text
CC Deck Relay 已启动
  token:  <你的 token>
  控制台: http://192.168.x.x:8787/?token=<你的 token>
```

手机 / 任何浏览器打开该地址即可用网页控制台。要让**你自己开的** Claude Code 会话也接入，再把 hooks 装进用户级配置：

```bash
node scripts/install-hooks.mjs     # relay 目录下执行；幂等，首次自动备份 settings.json
```

它会在 `~/.claude/settings.json` 里为六类事件各加一条命令 hook，形如：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node D:/path/to/cc-deck/relay/hooks/bridge-hook.mjs" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "timeout": 620,
        "hooks": [{ "type": "command", "command": "node D:/path/to/cc-deck/relay/hooks/bridge-hook.mjs" }] }
    ],
    "PostToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node …/bridge-hook.mjs" }] }],
    "Notification":  [{ "hooks": [{ "type": "command", "command": "node …/bridge-hook.mjs" }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "node …/bridge-hook.mjs" }] }],
    "SessionEnd":    [{ "hooks": [{ "type": "command", "command": "node …/bridge-hook.mjs" }] }]
  }
}
```

说明：hook 只向本机回环地址上报（relay 未运行时 <50ms 即退出，不影响 CLI）；已运行的会话不会热加载 hooks，需新开会话生效。手动形态下领云桥配对码：`cd relay && npx tsx src/index.ts --pair`。

### ③ 手机端

- **安装**：在 [Releases](https://github.com/humumu130/cc-deck/releases) 下载 `CC-Deck-<tag>.apk` 安装（当前 0.3.x，包名 `com.humumu.ccwatch`）
- **局域网连接**：App 内「设置 → 新增服务器」，地址填 `ws://<PC-IP>:8787/ws`，令牌填 relay 启动时打印的 token（即上面 URL 里 `?token=` 的值）
- **跨网络连接**：无需碰 IP 和端口——PC 上执行 `/cc-deck-pair`（插件）或 `npx tsx src/index.ts --pair`（手动）领 6 位配对码，手机 App「新增服务器 → 配对码」输入即可；异地浏览器则打开 <https://cc.humumu.online> 输码接入
- **Wear OS 手表**：手表端 App（`wear-app/`）支持两种接入——WebSocket 直连 relay（无 GMS 设备的主通道，国行手表实测可用）或经手机 App 的 Data Layer 网关转发快照

### ④ 桌面端（Windows，不信任托管网页时用）

网页控制台默认由你自己的 relay 托管，也有公网镜像 <https://cc.humumu.online>（云桥密文通道）。如果你不希望在任何浏览器/托管页输入 relay token，可以用桌面客户端——UI 从本地磁盘加载、默认自动探测并连接本机 relay，全程不出局域网：

- 在 [Releases](https://github.com/humumu130/cc-deck/releases) 下载 `CC-Deck-Setup-<tag>.exe`（一键安装）或 `CC-Deck-<tag>-portable.zip`（免安装解压即用）
- 启动后自动检测本机 relay（`127.0.0.1:8787`）并连上；也可在设置里手动添加局域网 / 云桥源
- 关窗最小化到托盘，双击托盘图标恢复；`Electron` 壳仅加载本地 `web-console/`，无任何远程页面

从源码构建：`cd desktop && npm install && npm run dist`（产物在 `desktop/dist/`）。首次运行未签名 exe 会触发 SmartScreen 提示，选「更多信息 → 仍要运行」即可（详见 [docs/desktop-decision.md](docs/desktop-decision.md)）。

### 环境变量（relay）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCR_PORT` | `8787` | 监听端口 |
| `CCR_TOKEN` | `data/token` 文件（首启生成、持久化） | 鉴权 token；设环境变量（≥8 位）可覆盖 |
| `CCR_CWD` | relay 目录 | 托管新建会话的缺省工作目录 |
| `CCR_MODEL` | `ANTHROPIC_DEFAULT_SONNET_MODEL`，再缺省 `glm-5.3` | 托管会话模型；不用 GLM 时请显式指定 |
| `CCR_DEBUG` | – | 打印 CLI stderr 与工具原始结构 |
| `CCR_GATE_TOOLS` | `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch` | 远程审批门控的工具名（逗号分隔） |
| `CCR_BRIDGE_TOKEN` | `data/bridge-token` 文件 | hooks 回连 relay 的桥接令牌 |
| `CCR_DATA_DIR` | 插件 `~/.cc-deck/data` / 开发 `relay/data` | 数据目录 |
| `CCR_CLOUD_URL` | `wss://cc.humumu.online/cloud` | 云桥地址，逗号分隔可多桥并行；**空串禁用云桥** |
| `CCR_CLOUD_TOKEN` | `ccdeck-public-9f3k2m7v` | 云桥层连接 token（公共桥为公开 token；自建桥换成自己的） |

## 安全模型（请务必阅读）

- **LAN token 是共享秘密**：任何拿到 token 的人都能完全控制你的 Claude Code 会话（读代码、发消息、批权限）。token 首次启动即随机生成（不是弱默认值），请通过安全渠道传递；如需更换，删除 `data/token` 文件重启即重新生成，或直接设 `CCR_TOKEN`。
- **局域网直连无 TLS**：token 会出现在 URL / WebSocket 查询参数中，仅限可信局域网使用；跨公网场景请走云桥。
- **云通道是端到端加密**：手机与 relay 各持一对 tweetnacl box 密钥，配对时经可信 LAN 信道交换公钥；桥上流转的全是密文信封 `{n,c}`，桥既解不开、也不落盘。设备 id 由公钥派生，互不可见。
- **默认公共桥由作者运营**：`wss://cc.humumu.online/cloud` 使用公开 token `ccdeck-public-9f3k2m7v` 仅做准入，带连接数 / 设备数 / 上行帧率限流。它能防第三方窃听（E2E），但桥运营方理论上可做元数据观测与断连。介意者请自建云桥，4 条命令即可：

```bash
cd cloudflare
npx wrangler login                     # 一次浏览器授权
npx wrangler secret put CLOUD_TOKEN    # 设 ≥8 位随机串（私有 token）
# 编辑 wrangler.toml：改 name，routes 换成自己的域名（或删掉 routes 用默认 workers.dev）
npx wrangler deploy
```

部署完成后得到 `wss://<你的桥>/cloud`，relay 侧设 `CCR_CLOUD_URL` 与 `CCR_CLOUD_TOKEN` 指向它即可（手机重新配对一次）。

## 自建云桥（两种形态，协议相同）

云桥是无状态密文路由：客户端帧 `{to, data}`，按设备 id 点对点转发，无持久化无缓冲，断线补发复用 relay 的 seq 机制。

| 形态 | 目录 | 适合 |
|---|---|---|
| Node + ws（Docker 就绪） | `cloud-bridge/` | 有 VPS / 内网服务器 |
| Cloudflare Worker + Durable Object | `cloudflare/` | 不想维护服务器，空闲不计费 |

**Node / Docker：**

```bash
docker build -t cc-cloud-bridge ./cloud-bridge
docker run -d -p 8790:8790 -e CLOUD_TOKEN=<8位以上随机串> cc-cloud-bridge
```

本地裸跑：`cd cloud-bridge && npm install && npm run dev`（默认 `:8790`，`CLOUD_PORT` / `CLOUD_EXTRA_PORT` 可调；`CLOUD_TOKEN` 未设置或过短会随机生成并打印）。

**Cloudflare Worker：** 见上文 4 条命令；本地验证 `npm install && npm run test:cloud`（自动起 wrangler dev 跑协议冒烟）。可选 `npx wrangler secret put PUBLIC_TOKEN` 再开一个公开 token，把桥共享给朋友 / 小团队用（任一 token 匹配即放行，限流同样生效）。

自建后中继地址形如 `wss://<你的桥>/cloud`（Worker 原生 TLS）。提示：workers.dev 域名在部分网络可达性一般，绑自定义域可改善。

## 开发指南

```bash
# relay（Node ≥ 20）
cd relay && npm install
npm run dev             # 前台跑 relay
npm run test:bus        # EventBus seq / 环形缓冲 / 断线补发
npm run test:sessions   # 双会话并发全生命周期（含远程审批、diff 统计）
npm run test:ws         # WS 鉴权 / 快照 / 补发 / 幂等
npm run test:history    # 历史持久化与重启恢复
npm run test:bridge     # hooks 桥接外部会话 / 远程审批 / 超时
npm run test:cloud      # 云通道端到端：配对 / 密文收发 / 断线补发
npx tsx scripts/test-transcript.ts    # 转录 detail 与 diff 下发
npx tsx scripts/test-p3.ts            # 权限模式切换 / resume / 斜杠命令直通
npx tsx scripts/test-p4.ts            # TodoWrite todos + 图片消息
npx tsx scripts/smoke-e2e.ts <token>  # 对运行中的 server 走浏览器等价全流程

# 手机端（Expo 57 / React Native 0.86，需 Android 环境）
cd expo-app && npm install && npx expo run:android

# 手表端（Kotlin + wear-compose）
cd wear-app && ./gradlew assembleDebug     # Windows: gradlew.bat assembleDebug

# 云桥
cd cloud-bridge && npm run test:cloud      # Node 形态：鉴权 / 路由 / 断连清理
cd cloudflare && npm run test:cloud        # Worker 形态协议冒烟

# 从源码重建插件（bundle relay 单文件 + 汇集静态资源到 cc-plugins/plugins/cc-deck/）
cd relay && node scripts/build-plugin.mjs
```

仓库布局：`relay/`（核心，协议唯一定义源 `relay/src/types.ts`）、`web-console/`（网页控制台）、`mobile/`（APK 分发 + 旧 /m 图标跳转页）、`expo-app/`（Android 手机端 + 手表网关）、`wear-app/`（Wear OS 手表端）、`desktop/`（Windows 桌面客户端，Electron 壳复用 web-console）、`cloud-bridge/` 与 `cloudflare/`（云桥双形态，共享同一路由核心语义）、`cc-plugins/`（Claude Code 插件成品，由 build-plugin.mjs 生成）、`design/`（技术方案评审记录）。

## Roadmap

- 手表 Tiles（不打开 App 直接看状态）
- 局域网扫码 / 配对体验优化
- 多手机同时在线
- LAN 直连 WSS / TLS 部署加固

## License

[MIT](LICENSE) © humumu130
