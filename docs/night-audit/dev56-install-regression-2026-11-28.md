# DEV-56 装机回归记录（test.38，2026-11-28）

> 执行：deck-fixer-1。基线：dev `9629696e`（W2/W3 全集成）→ bump `67b08170` → tag `v0.7.1-test.38-nova`。
> 前提事实：生产在装 test.37-nova，W2/W3 新腿（43+51+54 wakeup 链／50 liveness／43 推送腿）全部停在「代码核验过、真机未生效」态——本批以正规 test 通道换装闭环。

## 出包（test 通道；DEV-44 产物出 git 后首次真 tag 出包）

- `scripts/release-test.sh 0.7.1-test.38` 全链绿：CLI 同步闸→feedback 闸→VERSION→七落点（`--check` 9 面全 ✓，versionCode 70038 单调）→build-plugin→deploy-web 四面锚（V1-a/V1-c 22 件全等）→check-bundle-sync 发布期自检→tag→push（dev `9629696e..67b08170`）。
- bump 笔 `67b08170`：9 文件 453+/63-——版本戳 8 文件＋`desktop-tauri/src-tauri/resources/relay.mjs` 496 行差（内嵌 bundle 重建面，即 W2/W3 载荷本体；R2② tracked face）。
- CI 三 workflow 全绿：relay `46140649950`／desktop `46140649820`／android `46140649792`（括注为轮询观测到 success 的时点 11:41:57Z/11:43:32Z/11:47:17Z，gh updatedAt 各早 10~23s）。mac job 链：先构建后引用（CI 内 build-plugin）＋ABI 三重闸＋freshness 闸＋tag 烙印——DEV-44 新语义全链首验通过，零卡点。
- mac dmg 产物：`CC Deck Nova_0.7.1-test.38-nova_aarch64.dmg` sha256 `318c27daa7e3b4e464b8cba26ef4f63a0614d810d21181034de703f878187ec8`（下载经代理断流一次，改直连断点续传取齐，完整性以 sha 为准）。
- 预检三件：Info.plist `0.7.1-test.38-nova` ✓；内嵌 `better_sqlite3.node` 系统 node 22.23.4（ABI 127）dlopen+读写往返 ✓；dmg bundle 与本地构建逐行 diff 唯一差 `STAMPED_NODE` 22.23.5（CI）vs 22.23.4（本地）——同 ABI 档环境烙印，属预期。

## 换装（swap-nova，DEV-33 同款）

- 出包前快照（19:33，release-test 运行前）：app `0.7.1-test.37-nova`；/health ok（三指纹 test.37、sqlite、ABI match）；org 锚 pg-7cb58ab4 active（Watchtower parked）；cloud-peers 23 台（ph-* 手机 8）；launchd 三件 exit=0；`~/.cc-deck/data/` 只读清点未触碰。
- **deploy-web 前置热写披露（审查 P2-1）**：release-test 链的 deploy-web S2 步在 19:35:49 已把 test.38 console 面热写进在装 test.37 app——**换装时点真实形态＝relay 37／console 38**（12:05:02 换装后首拍 `[pallette] 版本拼盘` 警告记录的正是收口前这个窗）；/health 三指纹 38 全一致自换装完成起成立。连带：swap 自动备份 `bak-20261128-200459` 的 console 面已被预写为 38（mtime 19:35），**真 37 时代取证面是 DEV-33 的 `bak-20261128-104013`**；回滚到 200459 备份会得到 relay 37＋console 38 的拼盘（liveness 键 relay 37 不发→005 无键零渲染，不炸、退化观察），必要时改用 104013 备份整批回 37。回滚位＝上述两备份＋30+ 历史备份。
- `--dry-run` 计划核对 → 实换：**20:04:59 发起 → 20:05:08 EXIT(0) 闭环（9 秒）**，备份 `/Applications/CC Deck Nova-bak-20261128-200459.app`。日志 `~/.cc-deck/data/swap-nova.log`。
- 立验：/health ok 且三指纹 `relay=0.7.1-test.38 / console005=0.7.1-test.38 / consoleLegacy=0.7.1-test.38-nova`；abi `buildNode=22.23.5（CI 烙印）/runtime=22.23.4` 双 127 match ok；boot-time 总 575ms（listen 前段；含收养确认的完整启动 4854ms，probe-sqlite=57ms 真加载）；桌面壳 webview 8787 ESTABLISHED 回连；orphan-adopt 6 行（dev-57/58/59/60/42 五会话＋task-83 域）；值守 PM 席位于 20:05:12 自愈拉起（notifications.json `#PMRESUME`——R10 断档主题正面观察）。

## 换装后验证

| 面 | 观察 | 判定 |
|---|---|---|
| /health 三指纹 | test.38 一致（consoleLegacy 带 -nova 烙印，同 test.37 形态） | 过 |
| wakeup 装配日志行 | `12:05:06 [wakeup] 条件唤醒已装配（周期 30000ms，/api/wakeup 可用）`——DEV-54 解耦后独立于 patrol 闸装配 | 过 |
| sqlite 读面 | 换装后 NODE_MODULE_VERSION 降级行 **0 处**；storage 读=sqlite 写=db boot=db | 过 |
| 设备回连 | cloud-peers 23 台不变；桌面壳 webview 回连 ESTABLISHED；org 锚 active | 过 |
| launchd 三件 | patrol/relay-sentinel/disk-watchdog 最后一跑 exit=0；patrol-report 20:06 行（换装后 relay:200） | 过 |

## W2/W3 新腿定向回归

| 腿 | 操作 | 观察 | 判定 |
|---|---|---|---|
| relay wakeup 链（43+51+54） | 装机 relay 实弹 `/api/wakeup` arm→list→cancel | arm `wk-mx0d5ua0-f0d11666`（session_status WORKING）→ **3s 后 FIRED**（wakeup-report.md ARMED 20:05:34→FIRED 20:05:37；持久化 state=fired checks=1 firedReason=predicate）→ cancel 路径 `ok:true`＋CANCELLED 行；list 双态正确（fired 不在活动表） | 过 |
| tick 竞争修复（51） | drill 双 tick + 装机 fired checks=1 | tick1 事实不成立 fired=0（不误触、不陈旧覆盖）→tick2 fired=1；先落盘后外发（P2-1 修向）在位 | 过 |
| liveness 端上（50） | `node probes/probe-liveness-shot.mjs`（12 断言；源面=装机面 22 件 hash 全等，唯 index.html tag 烙印差） | **12 ok / 0 FAIL**：①a-f 卡面三值（alive 黄呼吸/between-turns S2 灰呼吸 standby/dead 灰实点+置灰 0.62）＋②a 心跳翻面＋③a/b 终态收殓＋④a-c §W 对账 55=34+21 | 过 |
| 推送腿＋云桥直推（43） | drill-wakeup.ts（CCR_PUSH_TO 见证端）＋生产桥 | armed→tick1 不误触→tick2 fired→push 537ms→桥 **200 delivered:true**→见证端 168ms 收 bridge_alert（title/body/level 全须） | 过 |
| 手机端 bridge_alert（43） | adb 探测 | 无设备连接（mdns/services 空）——0.6.3 静默忽略设计兜底，处理器生效需手机装 test.38 | 留用户 |
| bridge-alert drill（43 演练同款） | 上行 drill-wakeup＋witness | DRILL-EXIT=0，armed→fired→投递全链一跑通 | 过 |

## 留用户项

1. **手机端 test.38 装机**（bridge_alert 处理器生效前提）：adb 未连接无法代办——`latest-test.json` 仍停 test.35（见新发现①），检查更新拉不到；可 adb 侧载 android run `46140649792` 的 apk 产物，或先补发清单再走 App 内更新。装后「关于」应显 `0.7.1-test.38-nova`。
2. liveness 卡面真机一眼（探针 12 ok 已代偿，日常使用中顺带过目）。

## 新发现（范围外记档）

1. **latest-test.json 停更三连批**（test.36 烧毁/test.37/test.38 均未发布）：清单更新是 CI 外人工步（desktop.yml 只打 Deploy reminder 勾选框）——手机端「检查更新」通道断供，建议随下批出包把清单发布收进出包链或列 PM 例行动。
2. **[pallette] 版本拼盘警告每批必响**：console005 `__ccDeck005Version` 无 `-nova` 烙印（`0.7.1-test.38`）vs legacy `CONSOLE_VERSION` 有（`-nova`）——对照物取 DEV-33 真 37 时代备份 `bak-20261128-104013` 同位逐字同型（git `4264cf21` 侧证同结论：非本批回归），CI 005 烙印 sed 疑零命中或 gather 时序使然；连带 005 关于页显示裸通道版本。建议归 desktop 出包段小修批。
3. **wakeup 投递结果无观测面**：生产 wiring 的 push 腿「尽力而为」不落 results（fire 能证、逐台手机投递结果不能证）——本次以见证端 drill 补协议层证据；建议 push 回执入 wakeup-report.md。附带：HTTP cancel 冒烟落盘终态为 `state=expired`（checks=0），无「已取消」语义标记（report 行有 CANCELLED）——审计面小缺口，建议随 wakeup 语义小修批。
4. boot-reconcile「库多 24 行/status 不一致 4」与换装前同族（DEV-39 存储面已知形态），非本批引入。
5. **patrol-heartbeat.json 时间戳单位=秒**（`"ts":1795867575`），与系统 ms 惯例不一致——任何按 ms 解析的消费方都会算出 1970-01-21 近 epoch 的假 stale 并告警（审查者报 20:10:07 有 `ALERT [sentinel-stale]`，本人在 patrol-report.md/events/relay 日志三面复核均 0 命中、未能定位落盘面，存疑留核）；心跳当前健康（20:06:15 写入 relay:200）。建议入单：统一 ms 或消费侧按秒读。
6. 旧 tag `v0.7.0-test.38-nova`（f11d81fc）与本批 `v0.7.1-test.38-nova` 并存——test.N 序号跨版本线重用，发版/回滚指认时需带全名，建议下批 tag 命名消化。

## 风险与未尽项

- 回滚位：`/Applications/CC Deck Nova-bak-20261128-200459.app`（relay=37＋console=38 预写拼盘，见换装节披露）与 `bak-20261128-104013.app`（整批真 37）；swap-nova.log/verdict 全程留痕。
- android test.38 真机未验（无设备）；win 通道本批未核（用户 win 机未开机面）。
- drill/wakeup 冒烟已向 8 台配对手机外发演练标题告警各一条（0.6.3 端静默忽略，无骚扰面）。
