# W-CONNV4E 回执：网页端 wb- 聚合行 + mobile 源列表 lane 五段序同步 + 台账只读

- 分支 `fix/connv4e`（worktree /private/tmp/cc-deck-w-connv4e，基于 dev@69ce1905——**不含批D**，任务书前提）
- 提交 `649f569c`（WIP 一笔，squash 归 Leader）；任务书 `/Users/xdd/.cc-deck/artifacts/brief-connv4e.md`
- 改动面：`web-console/js/settings-domain.js`（+151/-6）、`web-console/js/mobile.js`（+38/-3）、`relay/scripts/probe-connv4e.mjs`（新，25 断言）。零 CSS 改动（复用 .src-offline/.dev-row/.devadmin-confirm/.mobile-lane 既有类）、零 relay 改动。

## 验收点对照

### ① 网页端聚合（评审 R6 定案）
- `renderDevAdminRows`：无名 wb- 纯网页行聚合一行 **「网页 ×N」**（副行「在线 x / N · 共用主 token · 断开=全部当前网页连接下线」）+行内**「断开」钮**（红系 devadmin-kick）；带名字的 wb- 行（配对过的网页源）不聚合照旧逐行（双键保留）。判定三处同构：`kind==="web" && 无名 && 非 ignored`（桌面聚合组/`wbAggKickAll`/mobile 只读台账）。
- 断开链：确认条（devadmin-confirm 家族，文案「断开全部 N 个网页连接 · 24 小时内不再自动重连」）→ 确认 → `wbAggKickAll()` **恰对在线无名 wb- 逐个 kick**（串行 for-await；离线/有名行不踢——探针⑦实锤调用集）→ toast 计数句（部分失败人话「部分未生效：x/N 已断开」）→ 重拉重渲。全部离线=断开钮退役（无可断）。
- 聚合行虚拟键 `WB_AGG_KEY="__wb-agg__"`（下划线形态在后端 dev 正则外零碰撞）；活动区内位置=named 行之后、忽略区之前。

### ② mobile 源列表 lane 五段序（1117 全栈一致性心智）
- `mobileSourceLaneRows()` 单口：本机（恒置顶，data-src-goto-local 与桌面共用锚）→ acct 在线（名字序+「连接」钮）/离线（src-offline 灰显+上次在线+「离线」标）→ **LAN 待连** → 配对码源（sdelServerRows(true)）→「＋添加」。空态登录分叉与桌面 sourceListRows 同口径。
- `cloudMobileLaneInner()` 重构为「头+mobileSourceLaneRows()+源名编辑+cloudUIOn 尾块」；**cloud 与非 cloud 分支同源**（新挂口 `window.__ccDeck005MobileSourceLane`，mobile.js 非 cloud 分支接入，缺席回落旧写死空态=旧构建兼容）。
- mobile.js 补拍：详情渲染后 1.6s lane 串有变则重渲一次（LAN 邻居/台账首拉异步到达——串稳定即止不自旋）。

### ③ LAN 段条件渲染（批D 未合入现实）
- 数据源 `/api/lan-peers`（GET，token 门）：**404=能力缺席段隐藏非报错**（批C2 能力位分流同款手法）；数据在场（批D 合入后）渲染四态行（none=发起连接钮/pending=等待对方确认/confirmed=已同意+未verified/rejected=对方已拒绝）——语义/文案与批D 桌面 `lanPeersRows` 同构，同账号设备不双列（批D 同款过滤）。
- **命名/锚与批D 全错开**：`MOBILE_LAN`/`fetchMobileLanPeers`/`lanPeersMobileRows`/`data-lan-connect-m`（vs 批D `LAN_PEERS`/`data-lan-connect`）——批D 合入后双缓存并存零 redeclare 冲突、双委托零互扰，**即通**（探针⑯ mock 批D API 形状实测）。
- 发起连接：`lanConnectSendMobile` → POST `/api/lan-connect-send`（端点同批D，独立函数防撞名）→ toast 分型句 → force 重拉。

### ④ mobile「这台电脑」连入台账只读（反向视图最小面）
- 新挂口 `window.__ccDeck005DevAdminLedger`（DevAdminWired 块内挂——与 DEV_ADMIN 同作用域；返回 cache，unsupported/未拉到=null）。
- `mobileDevicesLane()`：ledger 在场→只读台账（**wb- 聚合行同构无钮**「网页 ×N · 在线 x · 共用主 token」、named 行照旧带在线/离线/已忽略态、区块头「只读」标、**零管理钮**——探针㉑实锤）；null→触发 `__ccDeck005DevAdminRefresh` 首拉+relay_devices 旧链渲染零改（补拍吃新值）。mobile 管理面独立立项不在本批。

## 自测证据（验收点④「全套绿」）

| 套件 | 结果 | 备注 |
|---|---|---|
| probe-connv4e（新） | **25/25** | 三连绿（一轮 20/25 时序 flaky 复跑即绿） |
| probe-connv4a | 11/11 | |
| probe-connv4b | 9/9 | 首跑 3/6 flaky（Chrome 冷启竞态，connv4b 探针既有病——非本批面），连跑两轮全绿 |
| probe-connv4c2 | 23/23 | mobile.js 收尾改动后复跑再绿 |
| probe-acctmulti | 8/8 | 一崩一 7/8 均 Chrome 冷启 flaky（与本批改动面不相交——acct 视角/云缓存），复跑两连绿 |
| test-fc（tsx） | 137/137 | |
| node --check | 过 | settings-domain.js + mobile.js |

截图证据：/tmp/connv4e-1-wb-agg-row.png（聚合行+named 行）、2-wb-agg-after-kick.png（全离线+钮退役）、3-mobile-lane-404.png（LAN 段隐藏面）、4-mobile-lane-lan.png（五段全序含 LAN）、5-mobile-devices-readonly.png（台账只读零钮）——多模态视觉核验逐张过（聚合行结构/五段序/只读态全对）。

**视觉核验抓到并已修的真 bug**：mobile 只读行 relTime 自带「前」+拼接再「 前」=「5 小时前前」双拼（源码级修复+复跑绿）。

## 复核口径点（Leader 裁决）

- **R1 双缓存裁量**：批D 合入后 LAN 桌面段（批D `LAN_PEERS`）与 mobile 段（本批 `MOBILE_LAN`）两份独立缓存+节流各自拉同端点。批E 选「错开命名保即通零冲突」而非「复用批D 函数」（dev 上不存在，复用=编译期 ReferenceError）。合并后可归一为单缓存（重构项，非本批）。
- **R2 聚合行 N=1 形态**：单条无名 wb- 也聚合为「网页 ×1」（与多行同构不分叉，行为一致性优先）。若 PM 倾向 N=1 逐行显示，改 `wbPure.length` 门一处即可。
- **R3 kick 副作用口径**：「断开当前连接」对在线 wb- 各上 24h 冷却（批C1 账号类 kick 语义=复用不改桥）。R6 已定案主 token 共享限制下这是本批上限；per-device token 独立立项后应换真踢除。
- **R4 mobile 详情补拍**：`_renderSettingsDetail("连接与设备")` 后 1.6s 串比较补拍一次（LAN/台账异步到达跟随）。自包含无新挂口；若嫌 magic number 可抽常量。
- **R5 观察项（非本批引入）**：mobile 设置详情返回钮「‹ 设置」在 420px/DSF2 截图中视觉竖排疑重叠——该行 HTML 零改动（既有），CSS width:auto 在场（conn-page-v2 P1-1b 修过），疑截图渲染误读；留给 UI 巡检独立核。

## 审查占位（常规 2 路——Leader 派）

- 审查 A（正确性）：__________
- 审查 B（UX/文案·含反方视角）：__________

## 环境/交付态

- draft PR：base=origin/dev，head=fix/connv4e（commit 649f569c）
- worktree 已推，node_modules 软链主仓（gitignore 内不污染）
- 版本闸（pre-commit 七落点）全绿 0.7.1-test.26
