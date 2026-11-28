# DEV-33 装机回归记录（test.37，2026-11-28）

> 执行：deck-fixer-1（用户授权装机回归由团队执行）。基线：dev `d236eb31`（= tag `v0.7.1-test.37-nova` + bump `ea9ac97d`）。
> 关键前置事实勘定：任务单预设「test.35 出包、无需 bump」不成立——tag `v0.7.1-test.35-nova` 已于 11-27 14:32 打在 bump 笔 `ac517c83`（**早于夜批 17 笔修复与 #158 ABI 对齐**），且该产物已于 11-27 14:36 手工换装在机（晨报「装机指纹 test.34」系 version-sentinel 台账陈账）。夜批修复从未装机。故按版本纪律 bump `0.7.1-test.36`→`0.7.1-test.37` 重出（test.36 tag 被出包 ABI 闸交叉决策假红烧毁，见 §预清障②）。

## 预清障两笔（leader 预批直修，均在 dev）

1. **patrol-escalate A1 时敏假红**（`8aefd3ea`）：S3 终审参数落地——窗 500→2000ms＋首睡眠 120→400ms；须超窗腿随窗重推（A2 450→1800、B1/B2 550→2200；定时器只晚不早，≥2200ms 恒超 2000ms 窗）。修前红：CI run 46087000346 `FAIL: A1 窗内同文重复不升级`（低配 runner 120ms 睡眠实际超睡 >500ms 窗）；本地 30 连跑不复现（时敏型）。修后绿：本地 20/20 连跑 8 ok/0 FAIL + tsc 0 错；CI run 46097048011 全绿（test:patrol-escalate ✓）。
2. **CI 出包 ABI 闸交叉决策**（`d236eb31`）：#164 给 build-plugin.mjs 加缺省 127 的 abi-gate × #158「android 链不受影响／Windows 持 20」两判断交叉，**首次 tag 出包**（v0.7.1-test.36-nova）android run 46097998939 / desktop-win run 46097998924 双假红（node 20 ≠ 期望 127）。修法：android node 20→22（与 relay.yml/mac job 同源）；win 出包步显式 `CC_DECK_EXPECT_ABI=115`（保留 #158 拍板——用户 win 机系统 node 未核实不盲切；覆盖≠豁免，档位断言+dlopen 往返仍跑）。tag 通道仅 tag push 触发，夜批两笔落 dev 后无 tag 出包，掩盖至今。修后 test.37 三 workflow 全绿。

## 出包（test 通道）

- `scripts/release-test.sh 0.7.1-test.36` → `0.7.1-test.37` 两轮（36 被①烧毁后重出 37）：bump → version.mjs 七落点 → build-plugin → deploy-web 四面锚全绿 → check-bundle-sync 守卫绿（versionCode 70037 单调）→ tag `v0.7.1-test.37-nova`。
- CI：android ✓ + desktop（win NSIS ✓ / mac dmg ✓）+ relay dev ✓（run 46098530816 / 46098530797 / 46098530842）。
- mac dmg 产物指纹：`CC Deck Nova_0.7.1-test.37-nova_aarch64.dmg` sha256 `a96a2637591c268085da1996d164ba89c02463eba15d17914585c7eeebf1c26a`。
- 出包前闸预清：sync-leader-cli 双位漂移拒发——部署位 leader-harvest 经字节比对 = `62386ca1` 历史版（零热改，纯陈账漂移），`--force` 重分发（自动备份 `backup/leader-harvest.20261128-102409.bak`+逐字节 cmp ✓）。

## 换装（swap-nova 真机演练，DL-P1-4 关联项）

- 换装前快照：app `0.7.1-test.35-nova`（11-27 14:36 手工装，**不含夜批修复**）、relay /health ok（test.35）、8787 监听、org 锚 pg-7cb58ab4 active、cloud-peers 23 台、`~/.cc-deck/data/` 只读清点 60+ 件未触碰；回滚依据 = swap 自动备份 + 既有 30+ 历史备份。
- 预检：dmg 挂载后内嵌 `better_sqlite3.node` 在本机 node 22.23.4（ABI 127）dlopen+建表读写往返 ✓（读回 42）。
- `swap-nova.sh --dry-run` 计划核对 → 实换：**10:40:13 发起 → 10:40:20 EXIT(0) 换装+复活闭环（7 秒）**，备份 `/Applications/CC Deck Nova-bak-20261128-104013.app`。日志 `~/.cc-deck/data/swap-nova.log`。
- 立验：/health ok 且三处版本指纹一致 `0.7.1-test.37`（relay/console005/consoleLegacy=…-nova）+ app Info.plist `0.7.1-test.37-nova` + 装机 console 落 `__ccDeck005Version = "0.7.1-test.37"`；org 锚 active；设备 23 台（wb-c896… 4s 内 hello 回连 unparked）。

## sqlite 治本验证（DL-P1-2）

| 面 | 换装前 | 换装后 |
|---|---|---|
| NODE_MODULE_VERSION 115↔127 | 日志 10 处，最新 02:03:41Z（org-write-tx/session-write 降级活跃） | **换装后 0 处** |
| boot 探针 | — | `probe-sqlite=50ms`（真加载） |
| 库活性 | wal 0B 冻结（11-26 起） | sqlite3/-shm/-wal mtime 10:40-10:41 活跃，wal 5.7MB 增长 |
| 读面 | 降级 json | `[read-mode] importAllForShadow 完成（失败域 0）` |

## 回归轮逐项

| 项 | 操作 | 观察 | 判定 |
|---|---|---|---|
| R1 空闲跳序 | 真 relay 控制台 70s 每 10s 采样卡序（21 卡全窗存活） | 8 帧采样**零重排**，末帧相对序稳定 true | **过**（收口条件「静置 60s 零跳序」达成） |
| R3 图钉 | 本会话卡实机点 pin→点卡体→再点 pin 复原（浏览器真面） | pin→`srow-pin on`+跳至 idx0/20；**点卡体 pin 态不变**（P0 误触不复发）；复原 `srow-pin` | **过** |
| R6 六芒星/活性灯 | 装机面 30s×6 采样动画态 + 真机 app 窗口截图 | status-dot `anim=none` 六采样一致；状态行/灯无闪动 | **过**（采样面；持续观感留日常使用） |
| R11 hook 误判死 | 换装后日志/事件流 grep（排除会话思考文本镜像） | 真实误判死/乒乓事件 0；CI test 矩阵 66/66 | **过**（观察面） |
| R12 板面新鲜度 | 控制台实连真 relay 收 BOARDS_DIGEST 帧 + 板面实时渲染 | 板面/看板实时正确（真机窗口截图留档）；CI 矩阵绿 | **过**（观察面） |
| R13 半连接 | 换装后 link-quality/route 观察 | 仅 1 笔 route miss=重启后正常回连舞步（4s hello 复原），无循环风暴 | **过**（静置观察面） |
| R14 手机通知按钮 | — | 需真机手机埋点回数（<300ms） | **留用户** |
| DL-P2-6 派发队列 | 换装后事件流队列相关行 + CI | 排水死锁/自锁真实事件 0；test:leader-dispatch/drainfix/dispatchfix ✓ | **过**（观察面：窗内无新派发流量，结构性回归由 CI 套件背书） |
| DL-P1-5 patrol osascript 实弹 | ①沙盒跑真 patrol.ts 升级路径（CCR_PATROL_ESCALATE_MS=1500）②沙盒跑 patrol-standalone.sh（假 relay down） | ①ESCALATED 行落盘+osascript 本机通知发射 ✓ ②`ALERT [relay] 连续 1 拍无响应…已本机通知` ✓ | **过**（双通道实弹，零生产触碰） |
| DL-P1-4 boardrecon 通电 | 读 auto-tiers.ts:50 + 生产 config.json | 缺省 observe、config 无 autoBoardrecon 键=干跑中 | **纯拍板项留用户**（一键通电：`~/.cc-deck/config.json` 加 `"autoBoardrecon": "auto"` 后重启 Nova；建议先跑一轮 PM 过目 wouldDo 清单） |
| P2-9 1x/2x | 装机 dmg 字节 harness 计算几何 + 真机 2x 窗口截图 | composer 底行五件中轴 mid=763 共线（2x）；真机 app 2x 截图留档 | **过（2x）**；1x 无外接显示器未验，留 |
| swap-nova 演练 | 本单换装即首次真机演练 | 7s 闭环 EXIT(0)，日志/判定文件齐全 | **过** |

## UI 双主题实看（#163+#165，装机 dmg 字节 + 真机）

- **机器检查 24 项全录**（ui-checks.txt）：P1-1 二维码占位=「二维码」二字+44px 盒 ✓；P1-2 `:root/select color-scheme=dark`（深色原生下拉不白底——§7.1 s0 待查项随之销）✓；P1-4 浅色 conv-mini.on 底色 16%+描边 45% ✓；P2-8 设置卡标题 12px（fs-E 档，与页头 17px 拉开）✓；P2-9 中轴共线 ✓；P3-6 版本徽章 chip 化 1px 边 ✓；N1 `.mobile-settings-detail .mobile-back` 规则装机字节在位可解析（width:auto 复原）✓。
- **字号/密度档随档（87 处收敛后首次）**：`--ui-scale` 100→110→90 实测 `.queue-card p` 12→13.2→10.8px、`.nrow-time` 11→12.1→9.9px——**直值收敛面真随档** ✓。
- **装机产物静态闸**：css/js 半像素 font-size **0 命中**；字面量残留均为台账列明有意保留族（6/7/8px glyph、24px 配对码等显示级）。
- **截图 ~40 张**（暗/亮 × 桌面全域 + 420px 移动台）+ 真机 app 窗口浅色 2 张（dark 系统翻转对 app 无效——console 走自带主题档，app 内点换未自动化，harness 双主题矩阵已全覆盖装机字节，真机深色留用户一眼）。
- 布局不协调治理点逐屏过目：看板（P2-10 图例行在位）、设置六子页、通知面板（P2-4 时间戳双色未见异常）、连接与设备（P2-5 行律动）、会话详情/输出物/错误卡、移动台四屏——未见新的 P1 级失调。

## 新发现（范围外，记档不扩战线）

1. **org status 值守面**：`pm.mode=no-leader`，pending 任命 ext-5dd7（auto 提名）+ member-join cf-6381ea08 两笔待决议——装机后 PM 席仍空，R10 断档主题的值守面未恢复，建议 leader 处置。
2. **哨兵视角的板账**：patrol-standalone 实弹时顺带读出 claimed 停滞 ~570h×5 单（任务表对账面）——boardrecon 通电（拍板项）后应能自动对出，与 DL-P1-4 判断一致。
3. `docs/night-audit/night-report-2026-11-28.md` 与 `docs/product-review/` 在主仓未入库（晨报自注「入树与否随用户」；product-review 疑为 Stage 1 B/C 席产物）——本轮以 `.git/info/exclude` 隔离防夹带，未代提交。
4. cua/System Events 自动化在本会话超时不可用（AXRaise -1712）——真机 app 内主题点换未能自动化，非产品缺陷，记录备查。

## 风险与未尽项

- test.36 tag 已烧毁（两腿假红历史在案）；test.37 为装机基线，回滚位 `/Applications/CC Deck Nova-bak-20261128-104013.app`（test.35 无夜批修复）与更早 test.34 备份。
- android 包 test.37 为 node 22 对齐后首出（expo 工具链兼容面 CI 已过，真机装机未验——手机端装机属用户面）。
- R6/R11/R12/R13 为观察面判定（静置窗+CI 背书），长期复发监控归 patrol/boardrecon 通电后的常态面。
- P2-9 1x、R14 手机埋点、boardrecon 通电、app 内深色一眼：四项留用户。
