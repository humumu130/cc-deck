# relay 系统服务化（macOS launchd）— #76

把 relay 从「桌面壳子进程」升级为 launchd LaunchAgent：开机自启、崩溃自拉起、
不依赖 CC Deck 桌面端开着。

## 属主模型（谁拥有 8787）

| 场景 | 行为 |
|---|---|
| launchd 服务先起（开机） | 壳启动探测端口已服务 → 让位不 spawn（main.rs 既有逻辑：`!port_listening` 才拉） |
| 壳先起（服务未启用/未装） | 壳 spawn 内嵌 relay，服务后来启用时 enable.sh 拒绝撞端口 |
| 壳退出 | `kill_embedded_relay` 只杀本方子进程——服务实例不受影响，手机不断线 |
| 服务死 | KeepAlive 5s 节流自动重拉（比壳 supervisor 的 1.5s 慢一点，但无人值守） |
| 壳内「关闭 relay」开关 | 只停壳自己的实例；端口上是外部实例时透出指引（#76 打磨），不越权 kill |

## 启用 / 停用

桌面端 test.27+ 的 ⚙ 设置 → relay 页有「开机自启（系统服务）」图形开关（#196，
壳命令 `relay_service_toggle`，同款逻辑内嵌壳里）——优先走它。本目录脚本是
备用/预埋通道（终端用户没有仓库，脚本主要面向开发机）：

```sh
./enable.sh     # 端口被占会拒绝并给过渡顺序（先退 CC Deck 再跑）
./disable.sh    # bootout + 清 plist；下次开壳回到旧模式
```

`FORCE=1 ./enable.sh`：只注册不抢占——壳退出后 KeepAlive 自动接管，适合预埋。

## 过渡顺序（生产切换，需用户在场拍板）

1. 退出 CC Deck 桌面端（壳带走内嵌 relay，端口空出）
2. `./enable.sh`（bootstrap + kickstart，端口即服务）
3. 重开 CC Deck（验证壳正确让位：设置行 relay 状态 = 端口 ✓ / 内嵌 ✗）
4. 手机断开重连一次验证云链路（云桥 register 应出现新 relay 连接）

回滚：`./disable.sh` + 重启 CC Deck。

## 热部署交互（日常发版）

替换 bundle 内 relay.mjs 后：

```sh
launchctl kickstart -k gui/$(id -u)/online.humumu.ccdeck.relay
```

比旧的「kill 壳子进程等 supervisor 重拉」更干净（无父进程竞态）；日志独立在
`~/.cc-deck/data/relay-service.log`（与壳孵化模式的 embedded-relay.log 区分）。

## 已知边界

- app 更新替换 bundle 瞬间 relay.mjs 可能短暂缺失 → 实例崩、KeepAlive 按节流重试，
  更新完成后自愈（/Applications/CC Deck.app 路径稳定，plist 无需改）。
- plist 由 enable.sh 用启用当时的绝对路径生成（node/app 路径写死在 plist 里）——
  换 node 安装位置或挪 app 后需重跑 enable.sh。
- relay 源码零改动：`CCR_PARENT_PID` 不传 → relay/index.ts parentPid=0 自动跳过
  父进程轮询（#324 防孤儿逻辑为壳孵化模式选装）。
