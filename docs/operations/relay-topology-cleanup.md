# relay 拓扑收敛报告（W-RELAYCVG）

**结论：M2 拓扑已收敛——plist 的 CCR_PORT=8788 与应用期望一致（无需改），内嵌 relay 抢锁死循环已终结，M2 应用已确认复用外部服务（新 PID 5216）。但 m2 relay 实例自身带病：事件循环被某 timer 烧死（HTTP 层不可用、云桥闪断），且发现生产 bridge.json 已被 m2 身份覆写（外部 CLI hook 串门）。两处需拍板，红线全程未碰。**

2026-10-09 深夜 · W-RELAYCVG

---

## 一、核实结论：M2 期望端口 = 8788，plist 本来就对

读 `desktop-tauri/src-tauri/src/main.rs`：

- `M2_RELAY_PORT = 8788`（433 行）构建期写死；`relay_port()`（439 行）优先读环境变量 `CCR_DESKTOP_RELAY_PORT`，正常启动未设该变量 → 落默认 8788。
- 应用复用外部 relay 的判定 = **`port_listening(8788)` 纯 TCP connect 成功即让位**，三处一致：
  - 启动 setup（1180 行）：端口有服务 → 不 spawn 内嵌；
  - supervisor 1.5s 轮询（921 行）：「无本方子进程 && 端口无服务」才拉内嵌；
  - `relay_toggle`（841 行）：端口有服务 → "nothing to do"。
  - HTTP 握手判定（`classify_relay_port`）只用于状态展示，不参与让位。
- 锁机制（relay/src/index.ts 49-83 行）：`relay.lock` 在 dataDir 下记 pid，持锁者活着则后来者 5s 后让位退出。

**即：Leader 手建 plist 选的 `CCR_PORT=8788` 恰好就是代码期望值，端口无需修改。**

## 二、病理还原与修复过程

**病根不是端口选错，是启动时序竞态：**

1. 21:22 手建 m2 服务时，M2 应用正跑着内嵌 relay 占住 8788 → launchd 实例 21471 `EADDRINUSE`（relay-service.log 留证）→ listen 失败但进程不退（uncaughtException 只打日志）→ 卡在「无端口 + 云桥 1s 闪断重连」烧 CPU 88%；
2. 但 21471 手里的锁还握着 → M2 应用 supervisor 见端口空反复拉内嵌 relay → 内嵌见锁让位退出 → 再拉 → PID 轮换（92687→95672），即观察到的「重启循环」。

**修复动作（已执行）：**

```
osascript quit "CC Deck M2"        # 先停应用：掐掉 supervisor 抢端口竞态
launchctl bootout gui/501/online.humumu.ccdeck.m2.relay
launchctl bootstrap gui/501 ~/Library/LaunchAgents/online.humumu.ccdeck.m2.relay.plist
# （bootout/bootstrap = unload/load 的现代等价写法；plist 内容零改动）
open -a "CC Deck M2"
```

新实例 **5216** 一次起来：锁=5216、LISTEN 8788（lsof 证实）、旧锁文件随 21471 SIGTERM 自动 wipe，无需手动清。

**验证（任务3 达成）：** M2 应用启动后跑满 90s 页面自愈重探窗口，全机 relay 进程仅 5216（m2 服务）+ 16549（生产服务），**无任何 `CC Deck M2.app/.../relay.mjs` 内嵌进程**；lsof 见应用 WebKit 渲染进程（PID 6430）与 8788 一条 ESTABLISHED。复用成立。

## 三、最终拓扑一页纸

| | 生产 | M2 测试 | 007（待拍板） | dev 残留 |
|---|---|---|---|---|
| 应用 | CC Deck.app **0.6.3** | CC Deck M2.app **0.6.2** | CC Deck 007.app **0.7.0-test.4-dev.125** | — |
| bundle id | online.humumu.ccdeck.tauri | online.humumu.ccdeck.tauri.**m2** | online.humumu.ccdeck.tauri（**与生产同款**） | — |
| launchd 服务 | online.humumu.ccdeck.relay | online.humumu.ccdeck.m2.relay | 无 | 无 |
| 进程 | PID **16549** | PID **5216** | 未运行 | tsx PID 16398 |
| 端口 | **8787** | **8788** | 碰 8787 | **8804** |
| 数据目录 | ~/.cc-deck | ~/.cc-deck-m2 | **~/.cc-deck（生产）** | cc-deck-w15 工作树 |
| 云桥 dev id | rl-7e633461ae1d81e4 | rl-63c78cc353713b38 | — | — |
| 健康度 | HTTP 正常（/local-info 200），CPU 长期偏高 | **HTTP 不可用**（事件循环饿死）+ 云桥闪断，详见遗留① | 未运行 | 健康（闲置 dev 实例） |

云桥身份两边独立（keypair 与 dev id 均不同），不存在互踢。

## 四、遗留问题（需拍板/另开任务，我未动）

1. **m2 relay 事件循环烧死**：5216 持续 ~85-100% 单核。sample 采样（留档 /tmp/m2-relay-sample.txt，已摘录关键栈）：主线程 100% 耗在 `uv__run_timers → JS timer 回调 → Buffer.toString()` 大字符串解码 + V8 GC。后果双连：HTTP accept 饿死（curl 10s 超时）+ 云桥心跳挤不出（近 80 行日志 connected 13/disconnected 11）。同 bundle 生产 16549 同款烧法（长期 ~60-80%）但事件循环未死、HTTP 可用。疑 relay 代码/数据层 bug，**建议另开 relay perf 专项**，采样文件与本节证据可直接交接。
2. **生产 bridge.json 被 m2 身份覆写**：`~/.cc-deck/data/bridge.json` 现为 `{"port":8788,"token":"bcdfde…"}`（m2 的 token），正确应为 `{"port":8787,"token":"27abf04d…"}`（生产 token，/local-info 实取）。后果：外部 CLI hook 按此路由把生产工作目录的会话事件打进 m2 relay——5216 日志多条 `[orphan-adopt] cwd=/Users/xdd/dev/cc-deck*` 即串门实证。**动生产文件须拍板**；修法 = Leader 确认后改回上述内容（relay 不需要重启，下次外部 CLI 接入即走回 8787）。
3. **M2 应用 webview 连着生产 8787**：PID 6430 同时持 8787/8788 各一条连接。8788 是本域服务；8787 来源待查（疑似页面侧 LAN 发现/状态轮询）。量级无害，记录备查。
4. **007 app 摸底结论**：0.7.0-test.4-dev.125 的 **dev 构建、生产行为**（二进制无 `.cc-deck-m2` 烙印，M2_BUILD=false）→ 一旦打开即按生产身份探测/占用 8787、读写 ~/.cc-deck；且 bundle id 与 CFBundleName 均与生产同款（目录名 007 是唯一区分）。Spotlight/启动台误触风险实存。**建议归档或删除，等你拍板（未动）**。
5. **`RELAY_SERVICE_LABEL` 全局同款隐患**（main.rs 967 行）：常量不分 M2。在 M2 应用里开「开机自启」会 bootout 生产服务、以 m2 端口/数据目录覆写生产 plist。**M2 应用内勿开该开关**；代码级修复（label 加 .m2 后缀）建议另开任务。
6. w15 dev relay（8804）为 worktree 开发实例，闲置中，留置不动。

## 五、红线遵守声明

- PID 16549 / 8787 / ~/.cc-deck 全程未动（bridge.json 仅只读发现，未改写）；16549 未重启。
- 未删任何 app；未动手机配对数据。
- plist 授权范围内的改动 = 零（端口核实为已对齐，仅做了服务重载）。
