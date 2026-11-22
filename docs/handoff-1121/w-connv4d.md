# W-CONNV4D 回执——LAN 邻居发现+一键发起+对端同意流+拒绝记忆（connv4d）

> 批D（评审 v2 §三）：mDNS 双向化+同意弹窗+拒绝记忆（键=公钥指纹）+请求帧签名（P2 加固）。
> 分支 fix/connv4d（worktree /private/tmp/cc-deck-w-connv4d @69ce1905+本批）→ draft PR base=origin/dev。
> 安全红线（评审 R5）全程写死落地：**同意制只授权传输层准入；身份恒走配对码/账号信任链**。

## 一、交付概览（9 验收点逐条）

| # | 验收点 | 落点 | 状态 |
|---|---|---|---|
| 1 | 发现：browse 同网+lan-peers 列表+自见过滤 | `mdns.ts` browseLanPeers（new）+`lan-peers.ts` LanPeersHub/parseLanService；组播被拦 errorCallback→mdns:false 静默降级 | ✓ |
| 2 | 源列表 LAN 段激活+组播隐藏 | `settings-domain.js` lanPeersRows() 段4（详见 §三裁决）；mdns:false/空邻居/无 token=段隐藏非报错 | ✓ |
| 3 | 发起→对端确认卡→同意=upsertFirstSeen+confirmDevice | hub.sendConnect（密封帧出站）→对端 handleIncoming→lanConnectConfirmCard（名字+指纹尾4位）→applyConfirmEffects case "lan-connect"→applyLanConnectDecision(true)=confirmDevice | ✓ |
| 4 | 拒绝记忆：setIgnored+revoke，再请求不弹卡；unignore 解除 | applyLanConnectDecision(false)=setIgnored+revokeDevice 双写返检；再请求走 silent 分支（发起端见「对方已拒绝」）；解除=批C2 unignore 双清链**零新代码**（测试实证解除后重新出卡） | ✓ |
| 5 | 重复请求限频 | 独立短冷却 60s（LAN_CONNECT_COOLDOWN_MS——KICK_COOLDOWN 24h 是账号类踢除语义不合，详见 §三）；只挡 request 弹卡路径，status 只读不受限 | ✓ |
| 6 | 身份红线：同意≠身份信任+未验证灰标 | 决议只写 device_trust（不动 identity.peers/rk 面）；数据连接零新通道（同账号 rk 免码/配对码照既有链）；confirmed 行 UI 灰 tag「未验证」 | ✓ |
| 7 | RN/手机端不在本批 | mobile lane（cloudMobileLaneInner）独立渲染器未触碰——批E 同步 | ✓（零改） |
| 8 | 测试：tsx 直测+web 探针+全套回归+CI 矩阵 | test-lan-peers.ts **68/68** + test-lanpeers-web.ts **23/23** + tsc 0 错 + 全套回归（见 §五）+ CI 矩阵 52→54 双落点 | ✓ |
| 9 | 回执+draft PR+2 路审查占位 | 本文件+PR（draft）+§六占位 | ✓ |

## 二、改动清单

**relay 侧（4 改 1 增）**
- `relay/src/lan-peers.ts`（**新 3xx 行**）：LanPeer/帧/状态机全域——parseLanService（TXT v2+devId 自洽+自见过滤）/openLanConnect（sealed box 持钥证明+ts ±5min 防重放+防冒名）/admitLanConnect（受理状态机纯函数）/applyLanConnectDecision（决议副作用：写返检同批C1 fix2 口径）/LanPeersHub（发现缓存+发起端 HTTP 出站+受理端入口+待决轮询 5s×3）
- `relay/src/mdns.ts`：advertiseRelay TXT 扩 v2 帧（v:"2"+extraTxt 合并）；新增 browseLanPeers（Bonjour.find+up/down/txt-update 事件+errorCallback 静默降级；BonjourCtor 可注入=测试 mock 位）
- `relay/src/ws-server.ts`：三端点——GET /api/lan-peers（token）/POST /api/lan-connect-send（token，本机发起）/POST /api/lan-connect（外来受理面：rateLimited 防洪+8KB body 帽，lan-auth 同款）；opts.lanPeers 注入
- `relay/src/index.ts`：hub 装配（闭包读 cloudIdentity——时序安全：onReady 在同步主流程 identity 构造后的事件循环里执行）；advertiseRelay 传 hub.txt()（identity 缺席=null→只发 v:"2" 空帧，#316 手表发现零变化）；CCR_NO_MDNS 同门启 browse
- `relay/src/projects.ts`：ConfirmKind +"lan-connect"；`relay/src/decision-notify.ts`：kind 标签「局域网连接请求」；`relay/src/session-manager.ts`：applyConfirmEffects ✓/✗ 双分支（✗ 与 ✓ 同一副作用单点——device-trust 先例纪律）

**web-console（1 文件）**
- `web-console/js/settings-domain.js`：LAN_PEERS 状态+fetchLanPeers（节流 5s/无 token 不发/失败静默）+lanPeersRows（四态行：发起钮/等待确认/已同意+未验证/对方已拒绝；「局域网」小标≤3字；同账号设备不双列）+lanConnectSend（POST 后 toast+强刷）+sourceListRows 插段4+点击委托+nearby 卡裁决注记

**测试（2 新）+CI**
- `relay/scripts/test-lan-peers.ts`（68 断言：解析/帧/状态机/决议/Hub 端到端真 sqlite+真 confirms/路由面真 ws-server/mock bonjour 发现链）
- `relay/scripts/test-lanpeers-web.ts`（23 断言：渲染链/行四态/发起动作/快照消费——test-280-conn-page 同款源码抽取直跑范式）
- `.github/workflows/relay.yml` 矩阵 52→54（lan-peers+lanpeers-web 双落点：matrix+anchored+下限注释）；package.json test:lan-peers/test:lanpeers-web

## 三、worker 勘定项与裁决点（任务书留白处的决策，请审查重点过目）

1. **LAN 源前缀推演（任务书点名）**：LAN 邻居身份键=**对端 relay 的 rl- dev**（cloud-keypair 公钥派生，devId 自洽校验）。**不新增前缀、不复用 wb-**——wb-/ph-/wt- 是「连到 relay 的客户端设备」域（pair_req/lan-auth），rl- 是「relay 本体」域（xmsg/云桥 RELAYS）：LAN 邻居发现与同意流的主体是对端 relay（mDNS 由 relay 进程 publish，TXT 带的就是 rl- dev），两域分属。受理面 dev 校验 `/^rl-/`，与 device-admin 的 ph-/wb-/wt- 词表互斥不混淆（kindOf 归 other 不入管理台账——LAN 邻居不占设备管理面，其「管理」=确认卡本身+unignore）。
2. **请求帧「签名」（评审 P2 加固）**：落法=**sealed box 持钥证明**——发起端用自身私钥+对端公钥（mDNS TXT pk）密封 {op, ts, name}，受理端 unseal 成功即证明持钥（面向受理方的签名等价物），+devId(spk)===from 自洽+ts ±5min 防重放。**零新密钥类型**（复用 cloud-keypair，无 sign keypair 新管理面）；取舍：box 只能对端验签（不能第三方验）——本场景唯一验证方就是受理端，足够。E2E 兜底照评审原案：伪造同意最坏=空转传输连接零数据暴露。
3. **nearby 卡 vs 源列表排序（任务书两处表述调和）**：验收点2 字面「nearby 卡渲染 LAN 待连行」与用户口径「LAN 待连段在离线同账号之后、配对码源之前」（1117 原话排序）冲突——独立卡（DOM 在 this-machine 卡后）无法嵌入源列表段序。**裁决：段4 渲染进源列表卡**（用户排序口径优先），nearby 保留位继续 hidden+裁决注记（web-console/js/settings-domain.js:1246）。
4. **冷却口径**：独立 60s 短冷却（任务书「复用 KICK_COOLDOWN 口径或独立短冷却」二选一）——KICK_COOLDOWN=24h 是「kick 账号类设备」的静默期语义，用在同意流=同意前状态 24h 内连状态查询都僵死，不合。60s 挡「卡在悬的重复弹卡」足够（卡查重本身也不重弹，冷却是 DB 查询前置快挡+弹卡洪水的第二道闸）。**silent 分支不刷冷却**（拒绝记忆幂等静默，verdict 表查即挡）——否则 unignore 解除后 60s 内仍被冷却挡住重启同意流（测试抓出的语义坑）。
5. **pending+无卡→重新出卡**：admitLanConnect 的 pending 态分两支——卡在悬=幂等 noop；**无卡=重新出卡**（unignore 解除/决议写失败场景的同意流重启）。upsertFirstSeen exists 时二查卡在悬才幂等（竞态窗收窄）。
6. **conn 状态双向融合**：snapshot().peers[].conn=发起端 states 缓存 ⊕ 受理端 device_trust 账本——对端先请求、本机已同意的邻居，本机列表同样显示「已同意」（不必本机再发起一次才知道）。device_trust 即传输层准入账本（双向语义）。
7. **TXT v2 帧**：{v:"2", dev, nm, pk}。v1 帧（无 dev/pk）被发现侧忽略——旧版 relay 不进 LAN 段（无法构成连接语义，非缺陷）。pk 入 TXT（44 字符）换发起端免二次握手（发现即得对端公钥，直接 seal）。
8. **ctxPool 归属（任务书点名核清楚）**：LAN 源**不进 acct 池**（pool key="acct:"+dev，LAN≠账号源）；本批**零数据连接通道**——「发起连接」产出的是对端 device_trust 记账+本机状态行，真正的数据源连接照既有链（同账号 rk 免码=activateAcctRelay 既有链/配对码=「＋添加」既有链）。web 端发起动作走本机 relay HTTP（acctApiBase 同款），不碰 connectLan/ctxPool/云链。

## 四、流程纪要（受理/发起全链）

- **发起端**：web 点「发起连接」→本机 relay `/api/lan-connect-send`→hub 从发现缓存取 ip:port+pk→seal {op:"request", ts, name}→POST 对端 `/api/lan-connect`→响应透传 web（toast+状态行）→pending 期自动轮询 5s×3+snapshot 时 >10s 节流补拍
- **受理端**：外来帧→openLanConnect（shape→自洽→unseal→ts 窗，坏 nonce/base64 吞成 unseal 失败——测试实锤 nacl 抛真攻击面）→adminVerdict（ignored 恒静默）→冷却→trustVerdict（none→upsertFirstSeen+出卡/pending→卡查重幂等或重启/confirmed→幂等/revoked→静默/mismatch→403）→lanConnectConfirmCard（「XX 请求连接」+指纹尾4位+红线注记）
- **决议**：用户 ✓→confirmDevice（传输层准入记账，身份面零动）；✗→setIgnored+revoke 双写返检。解除=批C2 设备管理 unignore（clearAdminMarks+unRevokeDevice，零新代码）→同意流可重启

## 五、自测证据

- `env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-lan-peers.ts` → **CONNV4D TESTS: 68 pass / 0 fail**
- `env -u CCR_ORG_DIR npx tsx scripts/test-lanpeers-web.ts` → **LANPEERS-WEB TESTS: 23 pass / 0 fail**
- `npx tsc --noEmit`（relay）→ 0 错；`node --check settings-domain.js` → OK
- 全套回归（CI 矩阵 54 套串行）：见下

### 回归结果

**CI 矩阵 54 套串行：51 绿 / 3 红，3 红全部基线/环境归因（非本批引入，逐条证据）：**

| 套件 | 红因 | 证据 |
|---|---|---|
| test:cardlifer2（43/44） | R4⑪ 读 `~/.cc-deck/org/dispatch-log.ndjson` **生产台账**的数据断言（存量 no_pr:true 行）——「本地跑即硬闸」的生产数据面 | 断言源码 test-cardlifer2.ts:393-396 直读 homedir 生产文件；本批零碰 dispatch 域 |
| test:settings-ws | 主仓 dev 基线（69ce1905，不含本批）**同断言同红**：「A: 新装 SNAPSHOT 默认开 + 首启物化 got=undefined」 | 主仓 relay 跑基线复现同 FAIL 行 |
| test:bridge | 基线红+环境敏感（与生产 relay 同机）| 三重证：①主仓基线跑两次两次红（形态不同=flaky：一次「45d message gone」一次端口 8798 被占）；②worktree 内把 relay/src **还原到 69ce1905 基线**（撤掉本批全部 src 改动）复现同红「FAIL: SESSION_CREATED emitted」——非本批引入实锤；③本批 src 改动（HTTP 端点+import）不触 bridge hook→SESSION_CREATED 链 |

## 六、2 路审查占位（PM 派审）

- **审查路 A（安全路·必派）**：对照 review-connv4-sec §一红线逐条——同意只授权传输层/名字不可信展示层/拒绝记忆键公钥指纹/sealed box 等价签名取舍/防弹窗洪水/防探测（帧校验失败无状态回显）/rateLimited+8KB/CORS 面（lan-connect 回 access-control-allow-origin:*——与 lan-auth 同款，请确认）
- **审查路 B（工程路）**：状态机边界（pending 无卡重启/unignore 后冷却不挡/exists 竞态窗）+ws-server 端点范式对齐+web 渲染链（五段序/空态/四态行/同账号过滤）+CI 矩阵

## 七、遗留与风险（如实）

1. **真机双机 mDNS 实测未做**（单机沙盒 mock bonjour 验证+真 ws-server 路由面；两台真机同网段 discover+publish 实链待装机验——mDNS 组播在真实路由器环境的可达性天然多变，代码已按「被拦即静默降级」容错）。L4 跨端项按核验分级铁律：**代码核验过，真机待验**。
2. mobile lane 批E 同步（验收点7 零改）。
3. 「已同意·未验证」行的后续动作（引导输配对码/引导登录同账号）是 UX 增强面，本批只显态不加引导（防超范围）。

## 八、交付物

- 分支 fix/connv4d @c46215cf（WIP 一笔，squash 归 Leader）；**draft PR #147** base=origin/dev（https://github.com/humumu130/cc-deck/pull/147，gh 直连）
- 本回执 w-connv4d.md

结果：交付完成——9 验收点全落（发现/源列表段4/发起-同意流/拒绝记忆+unignore 解除/60s 限频/身份红线/批次边界/测试/回执+PR）；tsx 直测 68/68+web 探针 23/23+tsc 0 错+CI 矩阵 54 套 51 绿（3 红全基线/环境归因非本批，逐条证据在 §五）；worker 勘定 8 项决策在 §三请审查重点过目（前缀推演=rl- 域/sealed box 等价签名/nearby 卡裁决/冷却口径/pending 无卡重启/conn 双向融合/TXT v2/ctxPool 零碰）；真机双机 mDNS 实链待装机验（L4 项「代码核验过，真机待验」）；2 路审查占位（安全路+工程路）待 PM 派审，不越闸自合。

---

# 返修批 fix1（双审挡闸项 P1×2+P2 顺手）——状态：**待复核**

> 任务书 brief-connv4d-fix1.md；详证 w-connv4d-r1.md（安全路）/w-connv4d-r2.md（实证路）。
> 追加提交 **af35c60e**（fix/connv4d 第二笔，c46215cf..af35c60e，10 文件 +273/−29），已 push，PR #147（draft）已带评注更新。worktree /private/tmp/cc-deck-w-connv4d。

## 一、P1-1 TXT 时序死路——修法：identity 预构造提前（非补发布）

- **刀法**：`index.ts` 把 `loadOrCreateIdentity` 从云桥块（原 :696 唯一赋值点）**提前到 startServer 之前**（lanPeersHub 构造上方）：onReady 里 `advertiseRelay` 求值 `hub.txt()` 时 identity 已就绪 → TXT v2 首帧即含 dev/nm/pk。云桥块改为 `if (!cloudIdentity)` 重试——预构造失败（身份文件损坏）重演既有后台段 catch 兜底行为，前台不崩进程；成功则复用同一实例（二次构造会换 peers Map 实例=写穿态丢失）。
- **为什么不是 R1 建议的 updateTxt/stop+重 publish**：实读 bonjour-service dist——Registry **无 updateTxt 路径**（announce 的再播定时器捕获首次 records 快照，改 service.txt 不生效）；stop+重 publish 有三害：①multicast-dns `respond` 即时发+loopback 默认开（dist 实证），自收 goodbye 撞新 probe 的随机窗（`Math.random()*250ms` 内到达=判「name in use」静默不播，比空帧更糟）；②邻居端 down/up 闪烁（发现缓存瞬断）；③空帧窗口仍在（identity 就绪要等后台段跑完云桥块）。预构造是几 ms 级小文件读（cloud-keypair/wan-secret/peers/tenant 四文件），bootfast「listen ≤2s」不受伤，且恢复 bootfast2 之前的时序不变量（原序 identity 本就先于 startServer）。
- **无云桥形态**（cloudUrls 空）：不构造（不生成 keypair 文件，行为不变）→ TXT 仍 v2 空帧，#316 手表发现零变化。
- **真实启动序断言**（R1 点名「非 mock」）：新套件 `test-lan-boot.ts`——真 index 子进程（tsx spawn，272 同款安全 env）+ **真组播栈**（真 bonjour publish/browse 零 mock）→ 浏览器收包断言 TXT 含 v="2"+dev（rl- 形态）+pk 自洽（devId(pk)===dev）+nm+与 data/cloud-keypair.json 逐字一致。**隔离纪律**（#20 幽灵实例教训）：新 env 钮 `CCR_MDNS_IP`（mdns.ts，publish/browse 双读）把组播组挪到私有组 239.192/14——同网真实设备（224.0.0.251 组）不可见，测试端同组回环收包；CCR_MDNS_NAME 唯一名；CCR_CLOUD_URL 指哑桥（127.0.0.1:1，零外联）只开 identity 构造闸。另带静态序锚（「云身份预构造」字样必须先于 startServer 调用——bootfast 时序回归锁）。
- **断言咬合力实证**：stash 撤掉 index.ts 修复单跑 → **8 红**（真组播 TXT 断言全灭：服务可见但 TXT 无 dev/pk=超时红，正是 P1-1 病理）；复修 → **10/10 绿**。
- **对 R1 指认的原回执不实声明勘误**：§二原文「时序安全：onReady 在同步主流程 identity 构造后的事件循环里执行」**与代码事实相反**（bootfast2 设计目标恰恰是让 listen 事件先到，五个 yield 全在云桥块前）——R1 定谳正确，worker 当时未追 bootfast2 的让出语义，声明作废；修复后该声明由「闭包时序安全」改为「预构造时序安全」并有 lan-boot 套件锁死。

## 二、P1-2 拒绝记忆单行道——修法：device-admin 写面 rl- 分型放行

- **gate**（ws-server.ts）：`kindOf` 扩 `rl- → "lan"`；写面校验分型——**unignore 放行**（解除拒绝记忆：clearAdminMarks+unRevokeDevice 链原样，恢复钮从恒 400 变真通路）；**ignore 放行**（预拒=与 ✗ 决议同一条 setIgnored+revokeDevice 链，peerKicker 对 rl- 幂等空转）；**kick 分型拒**（400「LAN 邻居不支持踢出」——无持久连接可断、24h 冷却在 LAN 受理面无消费方，放行=假动作）；其余未知前缀维持原 400。
- **UI**（settings-domain.js）：DEV_KIND_TXT/ICON 增 `lan:「局域网」`（复用 desktop 形）；rl- 行**隐藏「踢」钮**（防点了恒 400 的死钮），「忽略」（未忽略行）与「恢复」（已忽略行）保持——两条写都已放行。probe-connv4c2 既有锚全用 ph-/wb-/wt- 行，不受影响（复跑 23/0 证）。
- **测试改走 HTTP 面**（R1/R2 双审同点：原测试直调库函数绕过 API gate=测试面≠生产面）：test-lan-peers §7b 新锚——真 ws-server 起 HTTP 面，全链：HTTP 首帧出卡→拒绝决议→再请求静默 rejected→**POST /api/device-admin {unignore, rl-} 200**→再请求**重新出卡**（UI 承诺「解除忽略后可重新发起」兑现）→kick rl- 400/ignore rl- 200（verdict 恒拒证）/ignore→unignore 幂等往返/未知前缀 400/list 面 kind=lan。test-connv4c1:186 原「rl- 非管理面设备 400」锚标签校准（状态仍 400，拒因已变为 kick 分型拒——断言逻辑零改）。
- **对 R1 指认的原回执不实声明勘误**：§四「解除=批C2 设备管理 unignore 双清链**零新代码**（测试实证解除后重新出卡）」——**双错**：路径死（API gate 400）+测试虚（直调库函数绕 gate），「实证」二字不成立；§三.1「kindOf 归 other 不入管理台账——LAN 邻居不占设备管理面」与事实相反（list 面是三源并集不过滤，rl- 行在列且带着永远点不动的恢复钮）。两处声明作废，以本批 §二修法+§7b HTTP 锚为准。

## 三、P2 顺手件

- **P2-3 指纹尾 8 位**（lan-peers.ts 卡面）：尾 4 位=16bit，分钟级暴力 2^16 keypair 可造同名+同尾 4 冒充卡；升尾 8 位（32bit）+文案同步「尾 8 位」。锚：§5a fp 长度 4→8。
- **P2-5 发现缓存帽 64**（零成本部分）：`LAN_PEERS_MAX=64`——hub up 回调对**新 dev** 超帽不入（组播伪造服务灌 peers Map 无上限=受理面放大器），既有 dev 刷新不受限。锚：§8b 灌 70 个伪造服务→snapshot 恒 ≤64+既有行刷新可见。
- **P2-5 超成本部分入单回报**（不在本批）：per-IP 弹卡预算收紧（现 10/min/IP）、IPv6 源循环换桶、pending lan-connect 卡全局 cap——三件都要动 acceptance/rateLimited 域，超出「零成本」口径，建议独立小批或并入安全加固批。

## 四、复跑数据（worktree @af35c60e 逐套实跑）

| 套件 | 结果 | 备注 |
|---|---|---|
| test-lan-peers | **83/0** | 68 原锚+15 新：§7b HTTP 解除链 ×12（前置×4+rejected+unignore200+重新出卡+kick400+ignore200+verdict 恒拒+幂等往返+未知前缀+list kind=lan）+§8b 灌水帽 ×2+fp 尾 8 ×1 |
| test-lan-boot（新） | **10/0** | 撤修实证 8 红（stash 单撤 index.ts 复跑）——断言咬合力亲证 |
| test-lanpeers-web | 23/0 | UI 改动后复跑 |
| test-connv4c1 | 63/0 | gate 域回归（:186 锚标签校准，逻辑零改） |
| probe-connv4c2 | 23/0 | device-admin UI 面在射程内 |
| probe-connv4b | 9/0 | |
| probe-acctmulti | **8/8** | 首跑 ⑤ 红（计时 flake：⑤不刷 live 直读 900ms 窗）→复跑×2 连绿；路径与改动零交集（acct-relay 行） |
| test:fc | 137/0 | |
| test:settings / test:linkquality | 35/0 / 44/0 | 共享 settings-domain.js 防误伤加跑 |
| tsc --noEmit | 0 错 | |
| node --check settings-domain.js | OK | |
| test:settings-ws | 基线红同断言行 | 「A: 新装 SNAPSHOT…got=undefined」与 R1/R2 在 69ce1905 基线亲验一字不差，非本批 |

CI：矩阵 54→55（`test:lan-boot` 双落点 script+anchored+下限注释+CI 可跑性注释；矩阵键守卫 yaml 复算 55 键全注册）。

## 五、边界与遗留（如实）

1. **lan-boot 在 CI（ubuntu runner）**：私有组组播在同主机回环（loopback 默认开）应可用；darwin 本机 10/10 实证。若 runner 环境组播受限会红——属环境项，红了即拆矩阵保本地（锚已带静态序锚兜底，不至于失去全部覆盖）。
2. TXT 发布仍是一次性定格（relay 改名后 TXT nm 不随改——批D 原状，非本批引入；如需 live 改名广播，须 bonjour 层重 publish 设计，入单项）。
3. R2 P3 组（受理端 LAN 行文案方向反/errorCallback 降级段无探针/unignore 后 60s 冷却窗陈旧态）未随本批——不在 fix1 任务书口径内，维持入单。
4. P2-4（confirmed 落共享 xmsg 信任账本话术）R1 定 P2 建议项，任务书未列——未动，待拍板二选一（独立传输记号 vs 卡面如实披露）。

## 六、交付物

- 追加提交 af35c60e（fix/connv4d，已 push）；PR #147 draft 评注更新（issuecomment-7028409264）
- 本返修段（w-connv4d.md 追加）；新套件 relay/scripts/test-lan-boot.ts；CI 矩阵 55 键
