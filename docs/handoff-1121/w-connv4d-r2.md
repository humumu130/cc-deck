# W-CONNV4D-R2 审查回执（2 路之二·实证路）——CONNV4 批D LAN 邻居

> 被审：fix/connv4d @c46215cf（draft PR #147 base=dev，gh 亲验 OPEN/draft/headRef 对齐）+回执 w-connv4d.md。
> 复跑环境：worktree /private/tmp/cc-deck-w-connv4d 只读跑（复跑全程零改 worktree 文件；基线对照在主仓 dev@69ce1905）；探针单套逐跑防 Chrome 竞态；gh 直连。
> 方法：git diff 69ce1905..c46215cf 全量通读（12 文件 1116+/11-）+ 依赖函数溯源（device-admin/device-trust/bonjour-service dist 源码）+ 独立复跑 + 活体实证探针（/tmp/connv4d-r2-verify/probe-unignore.mts，真 ws-server+真 sqlite 临时目录）。

## 一、diff 对账（任务书重点 1）——✓ 全符

12 文件与回执 §二改动清单逐件对账一致，**无未声明变更**：

| 文件 | 回执声明 | 实核 |
|---|---|---|
| relay/src/lan-peers.ts（新 398 行） | 新 3xx 行全域 | ✓ 纯函数三件（parse/open/admit）+决议副作用+Hub 全读 |
| relay/src/mdns.ts | TXT v2+browseLanPeers | ✓ advertiseRelay 第三参 extraTxt 合并；browse errorCallback 静默降级 |
| relay/src/ws-server.ts | 三端点 | ✓ GET /api/lan-peers+POST /api/lan-connect-send（token）+POST /api/lan-connect（外来面 rateLimited+8KB 帽，lan-auth 同款）；opts.lanPeers 注入+null 降级（200 空快照/501/501） |
| relay/src/index.ts | hub 装配+txt 传参+同门 browse | ✓ CCR_NO_MDNS 同门；onReady 时序（listen 异步回调晚于同步 identity 构造）成立 |
| relay/src/projects.ts / decision-notify.ts / session-manager.ts | kind 注册+标签+双分支 | ✓ ✓ 分支与 ✗ 分支同一副作用单点 applyLanConnectDecision |
| web-console/js/settings-domain.js | LAN_PEERS+四态行+段4+点击委托 | ✓ 五处 hunk 逐一对上；node --check OK |
| 测试 2 新+CI 2 文件 | 68+23+矩阵 52→54 | ✓（见 §三） |

**mobile lane 零改声明实核成立**：diff 无 expo-app/desktop-tauri/移动端文件；且 cloudMobileLaneInner（:4686）只消费 sdelServerRows(true)——不进 sourceListRows，LAN 段结构上到不了 mobile lane（比「没改」更强：想漏也漏不进）。

## 二、发现（分级）

### P1-1【挡闸·实证】LAN 拒绝记忆的解除链在用户面完全断——「恢复」按钮存在但恒败

- **链条**：LAN 拒绝决议写 setIgnored+revokeDevice（rl- dev）→ 设备管理 list（混源台账并集：peerMap⊕trustMap⊕adminMap）**确实显示该 rl- 行**（实测 kind=other/ignored_at 有值/trust=revoked）→ web 渲染器对 ignored 行渲染「恢复」钮（data-devadmin-unignore，不分 kind）→ 点击 POST /api/device-admin {action:"unignore"} → **ws-server.ts:883 写守卫 `kindOf(d)==="other"` 一律 400「dev 需为 ph-/wb-/wt- 前缀设备号」**。
- **活体实证**（/tmp/connv4d-r2-verify/probe-unignore.mts，真 startServer+真 sqlite）：
  ```
  [1] applyLanConnectDecision(false) → ok=true
  [2] device-admin list 含 rl- 行：true（kind=other ignored_at=1795136736821 trust=revoked）
  [3] unignore(rl-) → HTTP 400 body={"ok":false,"error":"dev 需为 ph-/wb-/wt- 前缀设备号"}
  ```
- **后果**：拒绝记忆对用户=永久。用户可达的四条路径全断：①设备管理「恢复」恒 400（UI 弹「操作未生效」误导为存储故障）；②被拒后再请求恒 silent 不出卡；③受理端 LAN 行无任何操作钮；④无 CLI 口。仅手工 SQL 可解。
- **回执虚报定性**：验收点4「解除=批C2 unignore 双清链零新代码（测试实证解除后重新出卡）」——测试只直调 clearAdminMarks+unRevokeDevice 函数（test-lan-peers.ts §4/§5e），**绕过了 API 守卫**，函数级语义正确但用户面不可达。§三.1「kindOf 归 other 不入管理台账——LAN 邻居不占设备管理面」论断与事实相反（list 是并集不过滤，实测在列）——worker 检查过这个交叉面但查反了。
- **web 行文案同时被证伪**：rejected 行 title「对方在『连进来的设备』里解除忽略后可重新发起」指向的正是这条断链。
- **修法建议**（最小改）：ws-server.ts:883 守卫按 action 分级——unignore 对 `/^rl-/` 放行（恢复性操作风险面小；kick/ignore 维持白名单拒），补一条 API 级测试锚（unignore rl- → 200 → 再请求重新出卡）。或 LAN 域自带解除端点（改动面大，不推荐本批）。

### P2-1 TXT v:"1"→"v:2" 跨仓兼容未证实

- v1 是 #316 协议铺底（dd9d2c5b，手表端在独立仓），本批 publish TXT 恒发 v:"2"。回执「#316 手表发现零变化」**无证据支撑**：手表端源码不在本仓，若其有 `txt.v==="1"` 硬校验则手表自动发现静默回归。本仓无法核验——列入装机验证清单点名项（手表同 WiFi 自动发现在 v2 广播下仍工作），或手表仓侧确认 TXT 消费逻辑。

### P3 组（随批修或入单）

1. **受理端 LAN 行文案方向反**：本机拒绝的对端在本机 LAN 列表同样显示「对方已拒绝 · 对方解除忽略后可重新发起」（conn 双向融合后单视角文案覆盖双向态）——误导受理端用户去对方机操作（忽略标记在本机）。P1-1 修复时顺带按 self/对端视角分文案。
2. **组播降级中段无覆盖（任务书点名盲区）**：errorCallback→mdns:false 一段无探针/mock（FakeBonjour 忽略 errorCallback；browseLanPeers catch 降级路径未测）；首尾两段有覆盖（§7 未 start=mdns:false + web L8 mdns:false→段隐藏）。记盲区，建议补一条 errorCallback 触发的 mock 断言。
3. **unignore 后 60s 冷却窗**：card/noop 路径刷冷却，解除后 60s 内再请求回缓存态「rejected」（陈旧态），60s 自愈。回执 §三.4 的论证只对 silent 分支成立。
4. **probe-connv4b 本机 flaky**：4 跑 2 红 2 绿（红形态=账号行/池前置态未建立，click false+pool 空），基线一发绿——环境级（探针冷启 2200ms 硬等待），非本批引入（批树可复现 9/0 全绿）。建议探针加确定性等待/重试，非本批事。
5. **rateLimited 余量薄**：外来面 10 次/60s/IP；稳态轮询（schedulePoll 3 次+refreshPendingAsync 6 次/分）≈6-9 次/分/peer，手动连点「发起连接」可触发 429（防御性失效，静默）。观察项。

## 三、复跑数据表（任务书重点 2/6——逐套实跑 vs 自报）

| 套件 | 自报 | 实跑（worktree c46215cf） | 判定 |
|---|---|---|---|
| test-lan-peers | 68/0 | **68 pass / 0 fail** | ✓ |
| test-lanpeers-web | 23/0 | **23 pass / 0 fail** | ✓ |
| npx tsc --noEmit（relay） | 0 错 | **0 错（exit 0）** | ✓ |
| node --check settings-domain.js | OK | **OK** | ✓ |
| probe-acctmulti | 8/8 | **8 ✓ / 0 ✗** | ✓ |
| probe-connv4b | 9/0（任务书锚） | **2 红 2 绿**（✗✗✓✓；绿跑全 9✓） | 环境级 flaky（见 P3-4，非本批引入） |
| probe-connv4c2 | 23/0 | **23 ok / 0 FAIL** | ✓ |
| test:fc | 137/0 | **137 ok / 0 FAIL** | ✓ |
| （基线对照·主仓 dev@69ce1905）probe-connv4b | — | **9 ✓ / 0 ✗**（一发绿） | flaky 归因旁证 |

三红归因亲验（任务书重点 4，主仓 dev 基线各跑一次）：

| 套件 | 回执红因声明 | 基线实跑 | 归因判定 |
|---|---|---|---|
| test:cardlifer2 | 生产台账 no_pr 断言 | **43/44 同红（R4⑪ 同一条）** | ✓ 归因成立 |
| test:settings-ws | 新装 SNAPSHOT 默认开 got=undefined | **同 FAIL 行一字不差** | ✓ 归因成立 |
| test:bridge | 基线红+环境敏感（三重证） | 未复跑（任务书只点名前两套；回执已有 worktree 内还原基线复现证据） | 采信回执证据 |

CI 矩阵亲算（任务书重点 3，yaml safe_load）：

- 基线 69ce1905 矩阵 52 键 → c46215cf 54 键；added=[test:lan-peers, test:lanpeers-web]，removed=[]，无重复键。
- anchored 集 54 项 == matrix 集（双向全等）；floor 守卫 `matrix.length < 54` 在位；两新键 package.json scripts 均注册；矩阵 54 键全部在 pkg 有落点。**双落点四面全对。**

## 四、正面确认（安全与工程面读码）

- **sealed box 持钥证明链完整**：openLanConnect 四道闸（shape→self 自洽 devId(spk)===from→unseal（坏 base64/nonce 的 nacl 抛有 try 吞成失败码——真攻击面有防）→replay ±5min）；帧校验失败一律 4xx 无状态回显（防探测）；「等价签名」取舍（复用 cloud-keypair 零新密钥面）与场景匹配（唯一验证方=受理端）。
- **身份红线守住**：✓ 决议只写 device_trust（confirmDevice），identity.peers/rk 面零触碰；数据连接零新通道（不碰 connectLan/ctxPool/云链——代码实核无此引用）；confirmed 行 UI 双 tag「已同意+未验证」。
- **受理状态机 14 分支**纯函数+端到端真 sqlite+真 confirms 覆盖扎实（首帧出卡/冷却不重弹/status 只读/同意幂等/拒绝静默/unignore 函数级解除重出卡/伪造三态）——P1 只断在 API 达性，不在状态机本身。
- **发现侧过滤齐**：v2 帧+devId(pk)===dev 自洽（防顶替 dev 位）+自见+loopback+非 IPv4+dev 形态+名字 40 帽。
- **ws-server 端点范式**与 lan-auth 同族（rateLimited 按 remoteAddress+8KB 帽+全链 try；ACAO:* 同款既有面——受理响应仅回 status 无敏感信息，与 C1 已过闸面同族）。
- **web 渲染链**：五段序段4 位+空态判定含 LAN+四态行+同账号过滤（rl- dev 对齐 acct_relays 键）+5s 节流/无 token 不发/失败静默——L1-L11/S1-S3 全锚过。
- bonjour-service dist 源码核过：构造器 (opts, errorCallback) 签名对、txt-update 事件带全量 service 对象（mdns.ts 处理正确）。

## 五、结论

9 验收点中 8 点成立；**验收点4 的「unignore 解除」半边不成立**（P1-1：解除路径 API 层 400 断链，活体实证；回执该点虚报——测试绕过 API 守卫）。按审查分级纪律（P0/P1 必修完再收割）：修 P1-1（ws-server unignore 守卫放行 rl- 或等效解除路径+API 级测试锚）后本批可过；P2-1 进装机验证清单点名；P3 组随批修或入单。复跑侧：自报数全部复现（68/23/tsc0/8/23/137），三红归因两项亲验成立，connv4b 探针 flaky 为环境项非本批引入。

结果：挡（P1-1 unignore API 断链必修；修后复验该点即可放行，其余面已核绿）
