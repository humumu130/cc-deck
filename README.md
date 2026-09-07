# CC Deck

[![relay CI](https://github.com/humumu130/cc-deck/actions/workflows/relay.yml/badge.svg)](https://github.com/humumu130/cc-deck/actions/workflows/relay.yml)
[![android CI](https://github.com/humumu130/cc-deck/actions/workflows/android.yml/badge.svg)](https://github.com/humumu130/cc-deck/actions/workflows/android.yml)
[![desktop CI](https://github.com/humumu130/cc-deck/actions/workflows/desktop.yml/badge.svg)](https://github.com/humumu130/cc-deck/actions/workflows/desktop.yml)
[![release](https://img.shields.io/github/v/release/humumu130/cc-deck)](https://github.com/humumu130/cc-deck/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

在手机上使用 PC 端的 Claude Code：查看会话状态、批准权限、发送消息、接收任务汇报。自建 relay，不经过任何第三方云服务；不在同一网络时走 Cloudflare 中继，端到端加密。

[网页控制台](https://cc.humumu.online) · [下载最新版](https://github.com/humumu130/cc-deck/releases/latest)

## 目录

- [功能](#功能)
- [快速开始](#快速开始)
- [架构](#架构)
- [安全模型](#安全模型)
- [进阶](#进阶)
- [开发](#开发)
- [Roadmap](#roadmap)

## 功能

**随身掌控**

- 多会话实时同步，四态徽标（运行中 / 等待输入 / 出错 / 完成），断线自动补发
- 权限审批推到手机点 Allow / Reject；AskUserQuestion 提问远程点选；随时打断
- 给会话发消息、传图片（App 支持语音输入）；历史会话可续聊

**替你盯着**

- 任务完成主动汇报：App 通知 + 手表震动，点按直达任务
- 上下文水位三端同口径分级色条，会话还能跑多久一眼可见
- 完整转录（工具调用 / diff / 思考过程），`#NNN` 任务号点击跳转
- 定时任务排程随身可查

**多源多端**

- Android App、Wear OS 手表、网页 / PWA、Windows 桌面客户端（Tauri 主推 3.4MB）
- 多台 PC 可聚合同屏（opt-in），卡片角标区分来源
- 跨网络经 6 位配对码接入云桥，全程密文，桥只见密文

<details>
<summary>四端能力矩阵</summary>

| 能力 | 📱 手机 App | ⌚ 手表 | 🌐 网页 / PWA | 🖥️ 桌面客户端 |
|---|---|---|---|---|
| 会话列表 · 四态速览 | ✅ | ✅ 抬腕速览 | ✅ | ✅ 同网页 |
| 远程审批 · Ask 作答 | ✅ | ✅ 允许 / 拒绝 / 点选 | ✅ | ✅ |
| 发消息 · 图片 | ✅ 语音 + 相册 | — | ✅ 粘贴截图 | ✅ |
| 打断 / 停止 / 删除 | ✅ | ✅ 停止 | ✅ 删除带撤销 | ✅ |
| 任务清单 + 完成汇报 | ✅ 通知 | ✅ 轻震直达 | ✅ | ✅ |
| 上下文水位 / 定时任务 | ✅ | ✅ ctx 百分比 | ✅ | ✅ |
| 转录时间线 | ✅ 全量 | ✅ 压缩版 | ✅ 全量 | ✅ |
| 多源聚合（默认关） | ✅ | — 跟随手机 | ✅ | ✅ |
| 历史会话恢复 / 续聊 | ✅ | — | ✅ | ✅ |

</details>

## 快速开始

### 第 0 步 · PC 上装插件（两条命令）

```bash
claude plugin marketplace add humumu130/cc-deck
claude plugin install cc-deck@cc-deck-plugins
```

装好重启 Claude Code，在任意会话里执行 `/cc-deck`：后台启动 relay，终端打出三张二维码（App 下载 / App 直连 / 网页控制台）。插件自带的 hooks 会自动桥接**新开的** Claude Code 会话；已运行的会话需重开。数据目录 `~/.cc-deck/data/`，与插件升级解耦。

配套命令：`/cc-deck-pair` 领 6 位云桥配对码（5 分钟内有效、一次性），`/cc-deck-stop` 停止后台 relay。

### 场景 A · 同一网络（局域网）

- **手机 App**：[Releases](https://github.com/humumu130/cc-deck/releases) 下载 APK 安装，「新增服务器 → 扫码添加」扫 `/cc-deck` 的 App 直连码，零手输
- **浏览器**：扫控制台码，或打开 `http://<PC-IP>:8787/?token=…`
- **桌面**：下载 `CC-Deck-Setup-<tag>.exe`，启动自动连本机。未签名 exe 首次运行会触发 SmartScreen，选「更多信息 → 仍要运行」

### 场景 B · 跨网络（外出 / 异地）

1. PC 保持 relay 运行，执行 `/cc-deck-pair` 领 6 位配对码（PC 只发出站连接，无需公网 IP）
2. 手机 App「新增服务器 → 配对码」输码；或任意浏览器打开 <https://cc.humumu.online> 输码（PWA 可加主屏）
3. 所在网络拦截 WSS 时，网页端自动降级 HTTP 长轮询保持在线

<details>
<summary>更多姿势（手动跑 relay / 手表 / 平台说明）</summary>

- **手动跑 relay**：`cd relay && npm install && npm run dev`；要桥接自己开的 CLI 会话再执行 `node scripts/install-hooks.mjs`；领配对码 `npx tsx src/index.ts --pair`
- **Wear OS 手表**：`wear-app/` 构建安装，WebSocket 直连 relay（无 GMS 国行手表的主通道），或经手机 App 转发快照
- **平台**：Windows / macOS / Linux 均可跑 relay；「向外部 CLI 会话注入按键」依赖 Windows 专属注入器，其他平台外部会话为只读监控 + 审批，托管会话全功能可用

</details>

## 架构

```mermaid
flowchart LR
    subgraph SCR["四块屏幕 · 同一套协议"]
        direction TB
        APP["📱 手机 App（expo-app / Android）"]
        WATCH["⌚ Wear OS 手表（wear-app）"]
        WEB["🌐 网页控制台 / PWA（web-console）"]
        EXE["🖥️ 桌面客户端（Tauri 主推 · Electron 过渡）"]
    end

    CLOUD["☁️ CF 云桥 cc.humumu.online<br/>零知识密文路由 · 默认公共桥 · 可自建"]

    subgraph PC["你的 PC · 任意网络环境（Node ≥ 20）"]
        RELAY["CC Deck Relay（:8787）<br/>事件总线 · seq 断线补发 · 事件落盘<br/>审批门控 · 任务汇报 · 定时任务快照"]
        EXT["Claude Code 外部会话<br/>你自己开的 CLI ×N"]
        HOSTED["Claude Code 托管会话<br/>Agent SDK query() 拉起"]
        RELAY <-->|"hooks · 六类事件上报 · 审批挂起 · 按键注入"| EXT
        RELAY <-->|"stdio 流式"| HOSTED
    end

    APP -->|"同 WiFi 直连 ws://ip:8787 + token（可扫码）"| RELAY
    WEB -->|"浏览器打开 relay 控制台"| RELAY
    EXE -->|"默认自动连本机 relay"| RELAY
    WATCH -->|"WS 直连 · 无 GMS 设备主通道"| RELAY
    WATCH <-.->|"Data Layer 快照转发"| APP

    RELAY ==>|"仅出站 WSS · tweetnacl 密文信封"| CLOUD
    APP ==>|"仅出站 WSS · 6 位配对码交换公钥"| CLOUD
    WEB ==>|"E2E · WS 被拦自动降级 HTTP 长轮询"| CLOUD
    EXE ==>|"E2E"| CLOUD

    CI["⚙️ GitHub Actions · 打 tag 自动出 APK + 桌面安装包挂 Release"]
    CI -.-> APP
    CI -.-> EXE
```

- 细箭头 `→`：局域网 / 本机通道，token 鉴权，仅限可信局域网
- 粗箭头 `⇒`：云桥端到端密文通道——桥只按公钥派生的设备 id 路由，无法解密、不落盘
- 详细模块图 / 数据流时序 / 持久化机制见 [docs/architecture.md](docs/architecture.md)

## 安全模型

- **LAN token 是共享秘密**：拿到 token 即可完全控制你的会话。token 首启随机生成，请经安全渠道传递；换发删 `data/token` 重启或设 `CCR_TOKEN`
- **局域网直连无 TLS**：token 出现在 URL / WebSocket 参数中，仅限可信局域网；跨公网走云桥
- **云通道端到端加密**：手机与 relay 各持 tweetnacl box 密钥，桥上流转的全是密文信封 `{n,c}`
- **默认公共桥由作者运营**（带连接数 / 设备数 / 帧率限流）：能防窃听，但桥运营方理论上可观测元数据。介意者按[进阶](#进阶)4 条命令自建

## 进阶

<details>
<summary>环境变量（relay）</summary>

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCR_PORT` | `8787` | 监听端口 |
| `CCR_TOKEN` | `data/token` 文件 | 鉴权 token；设环境变量（≥8 位）可覆盖 |
| `CCR_CWD` | 用户主目录 | 托管新建会话的缺省工作目录 |
| `CCR_MODEL` | `ANTHROPIC_DEFAULT_SONNET_MODEL` | 托管会话模型；不用默认值时请显式指定 |
| `CCR_DEBUG` | – | 打印 CLI stderr 与工具原始结构 |
| `CCR_GATE_TOOLS` | `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch` | 远程审批门控的工具名 |
| `CCR_BRIDGE_TOKEN` | `data/bridge-token` 文件 | hooks 回连 relay 的桥接令牌 |
| `CCR_DATA_DIR` | 插件 `~/.cc-deck/data` / 开发 `relay/data` | 数据目录 |
| `CCR_CLOUD_URL` | `wss://cc.humumu.online/cloud` | 云桥地址，逗号分隔可多桥；**空串禁用** |
| `CCR_CLOUD_TOKEN` | `ccdeck-public-9f3k2m7v` | 云桥层连接 token（自建桥换自己的） |

</details>

<details>
<summary>自建云桥（两种形态，协议相同）</summary>

云桥是无状态密文路由：客户端帧 `{to, data}` 按设备 id 点对点转发，无持久化无缓冲。

| 形态 | 目录 | 适合 |
|---|---|---|
| Node + ws（Docker 就绪） | `cloud-bridge/` | 有 VPS / 内网服务器 |
| Cloudflare Worker + Durable Object | `cloudflare/` | 不想维护服务器，空闲不计费 |

```bash
# Cloudflare Worker（4 条命令）
cd cloudflare
npx wrangler login
npx wrangler secret put CLOUD_TOKEN    # 设 ≥8 位随机串
# 编辑 wrangler.toml：改 name，routes 换成自己的域名（或删掉用默认 workers.dev）
npx wrangler deploy
```

```bash
# Node / Docker
docker build -t cc-cloud-bridge ./cloud-bridge
docker run -d -p 8790:8790 -e CLOUD_TOKEN=<8位以上随机串> cc-cloud-bridge
```

部署后 relay 侧设 `CCR_CLOUD_URL` 与 `CCR_CLOUD_TOKEN` 指向它，手机重新配对一次。

</details>

## 开发

<details>
<summary>构建与测试命令</summary>

```bash
# relay（Node ≥ 20）
cd relay && npm install
npm run dev             # 前台跑 relay
npm run test:bus        # EventBus seq / 环形缓冲 / 断线补发
npm run test:sessions   # 双会话并发全生命周期
npm run test:ws         # WS 鉴权 / 快照 / 补发 / 幂等
npm run test:history    # 历史持久化与重启恢复
npm run test:bridge     # hooks 桥接外部会话 / 远程审批 / 超时
npm run test:cloud      # 云通道端到端
npx tsx scripts/smoke-e2e.ts <token>  # 浏览器等价全流程

# 手机端（Expo 57 / React Native 0.86）
cd expo-app && npm install && npx expo run:android

# 手表端（Kotlin + wear-compose）
cd wear-app && ./gradlew assembleDebug

# 桌面客户端
cd desktop && npm install && npm run dist        # Electron
cd desktop-tauri && npx tauri build              # Tauri

# 从源码重建插件
cd relay && node scripts/build-plugin.mjs
```

</details>

仓库布局：`relay/`（核心，协议唯一定义源 `relay/src/types.ts`）、`web-console/`（网页控制台）、`expo-app/`（Android 手机端 + 手表网关）、`wear-app/`（Wear OS 手表端）、`desktop-tauri/`（桌面客户端主推）与 `desktop/`（Electron，过渡期保留）、`cloud-bridge/` 与 `cloudflare/`（云桥双形态）、`mobile/`（APK 分发页）、`cc-plugins/`（Claude Code 插件成品）、`docs/`（架构文档）。

## Roadmap

- 手表 Tiles（不开 App 直接看状态）
- 多手机 / 多设备同时在线
- LAN 直连 WSS / TLS 部署加固

## License

[MIT](LICENSE) © humumu130
