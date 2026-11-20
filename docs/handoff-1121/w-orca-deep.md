# W-ORCA-DEEP 回执：Orca 深调四问+三方选型（用户决策级调研）

> 2026-11-20 · 纯调研零代码 · 证据基线：stablyai/orca@main（2026-11-20 浅克隆 blobless，gh api 直连全通）
> 前科复用：Multica 四卷（mech1 执行可靠性/mech2 数据一致性/mech3 协议层/mech4 特性取舍）

## 结论前置（用户令：不护短，直说）

**Orca 不是「另一个竞品」，是降维打击级的基础设施**：130K star、MIT、TS/Electron、**4 天发 5 个桌面版+3 个 Android 版**（v1.4.261→265，2026-11-16→19）、39 引擎图标（src/shared/agent-icons/ 实数）、全平台+远程三形态。**在「多机跑 agent 的 IDE/编排器」这个战场上，cc-deck 已无追赶可能**——Computer Use/浏览器面板/移动模拟器/Design Mode/插件市场/逐行 AI 溯源（attribution），每一项都是独立团队量级。

但「全面优」不成立。**四个面 cc-deck 仍是唯一解**：
1. **治理制度化**——强制多路审查闸（review-gate 钩子拦「未审标完成」）、PM/worker 岗位制编制、三账对账（板卡/台账/事件流）、回执链+deliver 闭环、确认卡人工拍板。Orca 有其中 60-70% 的**机制原语**（且部分工程更深），但没有**强制性与制度化**。
2. **中文优先**——Orca 有中文 README+微信群，但产品 UI 英文优先；GLM 配方两家完全同款（见 Q4）。
3. **默认零云**——Orca 核心闭环可零依赖自托管（比预期好得多），但遥测默认开（可关）、移动推送内容必经其网关（无法自托管）、star-nag 会查你有没有给它点星。
4. **与用户 SOP 的自举耦合**——发版三段式/验收单回流/经验回流是给用户自己的纪律定制的；Orca 不编码任何人的 SOP。

**行动建议（三选一中的答案）：深耕差异化，但战场收缩**——不追 IDE/引擎广度（追=死路），把 cc-deck 收敛为「治理脑+中文+零云」层；同时**用户日常单机多 agent 编码可以直接开始用 Orca**，不必等 cc-deck 补任何 IDE 能力。混合方案（cc-deck 治理脑+Orca 执行舰队）技术上可行（Orca 全量 CLI 化），建议做一次 spike 验证（见 §5）。

PM 初判两处错误均被本调研证实为用户正确：①引擎面 39 家含 zcode/qwen-code/codebuddy/kimi/mimo-code/trae/qoder-cn/jcode 图标实数；②跨设备全覆盖（桌面三平台+iOS/Android+Remote Server/SSH/云 VM+联邦派单 `--on <host>`）。

---

## Q1 编排治理深度（源码级）

### Orca 有什么（全部源码实证，非 README 转述）

编排层 `src/main/runtime/orchestration/`（14 子模块，SQLite 持久化）——**注意：整层在 Settings → Experimental 开关后面**（docs/site/content/docs/cli/orchestration.mdx:12-15）：

| 概念 | Orca 实现 | cc-deck 对应物 | 判定 |
|---|---|---|---|
| 任务状态机 | Run/Task/Dispatch：pending/ready/dispatched/completed/failed/blocked（orchestration.mdx:30-35） | 任务清单+派单台账 | ≈等价 |
| **幂等回执** | mutation-receipts：caller fingerprint+requestId+payload hash 三态去重（db/mutation-receipts/mutation-receipt-store.ts:36-60，BEGIN IMMEDIATE 事务） | 派单台账 appendDispatch 单口 | Orca 更深（RPC 级幂等） |
| **对账** | attempt-observation-store：双权威钟（execution/home）事实幂等入库+sameFact 去重（db/attempt-observation-store.ts:9-70） | 三账对账（板/台账/事件流） | 各有侧重：Orca 跨联邦单链对账深；cc-deck 跨系统三账广 |
| **熔断+重试** | failDispatch 推进熔断器，3 次阈值→circuit_broken→task failed（coordinator/escalation/coordinator-escalation-triage.ts:55-63） | dispatch-retry 六枚举+30s 重试+retry_of 链深 1 | ≈等价（Orca 多熔断器） |
| **发送者防伪** | escalation 强校验 dispatch 绑定+sender 归属（escalation-triage.ts:30-45）；gate 创建 consumer_fenced/task_not_startable 双拒（db/decision-gates/decision-gate-store.ts:38-73） | 板卡 owner 校验 | ≈等价 |
| **确认卡拍板** | Decision gate：任务阻塞于问题，「Only explicit human gate resolution may unblock」（coordinator/decision-gates/coordinator-decision-gates.ts:52-60）+启动时 reblock 待决闸 | 确认卡+决策账本 | ≈等价（Orca 无决策账本留痕面） |
| **审批升级** | worker 权限提示→escalation，「Only a person can allow it」默认人审；可选让 coordinator 代批（orchestration.mdx:89-99）；approvals/ 有 terminal-worker-approval-holds 整族 | 授权位四档热切+P81 语义 | ≈等价机制、cc-deck 档位更细 |
| **席位活性** | crew 读模型：projectLiveness+sessionActivityEvidence 活性投影（crew/crew-party-snapshot.ts:22-24）+worker-status-notice SQLite 触发器广播行变更（db/worker-status-notice.ts:14-24） | 探活+member-retire+熟手池 | ≈等价 |
| **worker 回执** | worker_done 强制 --outcome succeeded/failed+files-modified；worker-release 归档可检输出（orchestration.mdx:59-87） | 回执+deliver 登记 | ≈等价（cc-deck 多 deliver 看板） |
| **逐行 AI 溯源** | attribution：agent 写过的行 gutter 标记、人工改回人工（docs/review/attribution.mdx） | 无 | **Orca 独有** |

### Orca 没有什么（差距所在）

- **强制多路审查闸不存在**：全 src/main grep「reviewer」只命中 GitLab MR 外部集成（gitlab/merge-requests/merge-request-review-mutations.ts）。审查流=人在 diff 上批注→批量发回 agent 修订（annotate-ai-diff.mdx），**纯自愿，无「审查不过不合」的强制闸**——coordinator 可以不经任何审查直接 commit-push。cc-deck 的 review-gate 钩子（拦 TaskUpdate 标完成）无对应物。
- **常设岗位制/编制不存在**：coordinator 是按 Run 临时的 agent（"end your turn, Orca wakes the coordinator"），无常设 PM、无编制名册、无岗位模板/预算闸（对比 cc-deck team-rules 数值硬闸）。
- **跨系统对账账本不存在**：无「板面不说谎」跨账核验、无损失点活账本文档化机制。

### Q1 结论

**机制深度（单链可靠性工程）：Orca ≥ cc-deck**——fencing/双钟观察/幂等回执恰好是 Multica mech1 卷的同课题，Orca 做到了同等深度。**制度深度（强制审查/岗位/对账工作流）：cc-deck 独有**。且 Orca 整层挂着 Experimental 牌、API 随日更漂移（"Command flags evolve with the app"），生产可用性自担风险。**差距没有想象的大，但剩余差距恰好是用户建 cc-deck 的理由**：Orca 假设「人是纪律」，cc-deck 把纪律焊进系统。

## Q2 安全模型（docs+源码）

### Remote Orca Server 配对信任链

- 配对 URL=**持 token 的访问凭证**（"Treat it like a password"，remote-servers.mdx:71-74）；每客户端独立可撤销 token，撤销即时断连（:115-118）。
- 单次配对券升级：10 分钟窗口内客户端自提新凭证、旧 token 首次新签后退役，防丢回复搁浅（pairing/pairing-ticket-exchange.ts:5-10）——TOCTOU 安全设计。
- **桌面客户端↔服务器链路默认非 E2E**：runtime RPC 服务器=明文 WebSocketServer（rpc/transports/websocket/ws-transport.ts:248，无 TLS 证书），安全模型=设备 token+**私网承载**（官方推荐 Tailscale；`orca serve` 默认拒绝公网地址，--allow-public 才放行，remote-servers.mdx:171-178）。
- **移动链路真 E2EE**：tweetnacl box（Curve25519-XSalsa20-Poly1305）应用层 ECDH over plain WebSocket（rpc/server/pairing/e2ee-keypair.ts:1，shared/remote-runtime/e2ee/node/e2ee-crypto.ts），配对码携公钥、连接后强制握手（e2ee-channel.ts:33 MAX_CONSECUTIVE_DECRYPT_FAILURES=5）。
- **托管 Relay（跨 NAT）**：需 Orca 账号登录（login.onorca.dev）；数据面 E2EE——**relay 只见密文**；host-proof 域分离转录签名+30s 时钟窗防 relay 冒充主机（mobile-cloud-relay/control-channel/relay-host-proof.ts:5-11）；撤销走持久化 outbox。

### SSH 形态

标准 OpenSSH 语义：known_hosts 校验+指纹展示、TOFU 默认/strict 可选、换钥拒绝并给 ssh-keygen -R 恢复路径（ssh.mdx:32-34）；口令句仅存内存会话级；FIDO2/GSSAPI 走系统 ssh；首次连接经你的 SSH 装 relay+node-pty（代码文件留在原地）。**中规中矩，无惊喜无硬伤**。

### 云 VM 数据面

BYO provider（Vercel Sandbox/Fly/Modal/SSH/Docker），recipe 脚本进仓（orca.yaml），连接走配对 URL 或 SSH——「Orca is a thin wrapper: your provider account, images, and billing stay yours」（ways-to-run.mdx:74,107-111）。

### Q2 结论

跨网互联安全语义：**移动/Relay 路径≈cc-deck 密封云桥同级（真 E2EE+主机证明+可撤销），桌面客户端路径差一档（明文 WS+token，靠 Tailscale 兜底）**。cc-deck 全链密封默认；Orca 把「信网络」当默认前提（Beta 文档明说 keep on private network path）。若用户在不可信 LAN 用桌面客户端连服务器，流量可被嗅（token 认证防伪造不防窃听）。**实质差=一档（桌面链路），不是一个量级。**

## Q3 自托管支持度

### 逐项实证

- **Server 完全开源自部署**：✅ 仓内即全部（Electron 桌面共享 or `orca serve`/orcad 无头服务器）；官方发 **server-only Linux x64/arm64 tarball（约 60MB，无 GUI 依赖）**+sha256 校验+systemd service install（remote-servers.mdx:192-208）；身份管理（机器镜像复制冲突→ORCA_INSTANCE_ID/reset-identity）、终端内存 cgroup 上限、GPU 开关——运维面想得很全。
- **桌面+手机正常工作必须连的域名**：核心闭环 **零必须**。可选用云服务全清单（src/main 实数）：login/relay/push.onorca.dev（账号+Relay+推送）、share.onorca.dev（产物云分享）、connector.orca.dev（webhook）、app.orca.dev（web 端/bot 链接）、orca.dev（插件目录/文档/APK）；更新源=**GitHub Releases**（updater/releases/updater-prerelease-feed.ts:15）；遥测=PostHog 美区，**默认开**，DO_NOT_TRACK=1/ORCA_TELEMETRY_DISABLED=1/设置页三路任一即关（telemetry.mdx:50-63），内容级承诺「never prompts/output/paths/repo names」。所有云服务 URL 均可用 env 覆盖（ORCA_PUSH_GATEWAY_URL/ORCA_CONNECTOR_URL 等，且校验器只认 https 或 loopback）。彩蛋：**star-nag** 会调 GitHub API 查你 star 没.star 没就弹窗劝你 star（src/main/star-nag/）。
- **云 VM 依赖度**：零——纯可选特性，不开云 VM 无任何功能残废（Remote Server/SSH 两形态覆盖同样场景）。
- **移动配对是否必须其推送服务**：**否**——LAN/Tailscale 直连配对（默认端口 6768）完全自托管；Relay（穿 NAT）才需登录其服务。`--mobile-pairing` 出 QR 码在 tailnet 内扫。**唯二硬伤**：①移动**推送通知**必经 push.onorca.dev→APNs/FCM（通知标题/正文可达其网关，无脱敏模式，ORCA_MOBILE_PUSH_MODE=disabled 可整体关——关了就没推送，只剩应用内实时事件）；②Relay 穿 NAT 无自托管替代（relay 服务端不在仓内——cloud/ 目录在但 relay 本体是托管服务）。

### Q3 评分：**8.5/10**

核心闭环（本地/私网多机+手机直连监控）真零依赖；扣分项=推送通知不可自托管、遥测默认开、Relay 闭源托管。对比 cc-deck 自托管=10/10（自有 relay+CF 面全自主）。

## Q4 三方选型矩阵（按用户场景）

| 场景 | Orca | Multica（引四卷） | cc-deck | 胜者 |
|---|---|---|---|---|
| ①多设备自托管编排（Mac+家Win+公司Win+手机，自有订阅引擎） | Remote Server 每台+联邦派单 `--on`+手机单视图聚合全主机+Tailscale 组网；Win 一等公民（签名包）；**编排层 Experimental** | 云 SaaS 形态为主，自托管非其形态（mech2：PG+Redis 全家桶） | relay 自家部署+org 岗位制派单+expo 手机端；Win 壳层较新 | **Orca**（成熟度+广度；cc-deck 稳但不广） |
| ②生产级治理（审查闸/人对齐拍板） | 原语全（gates/approvals/回执/熔断/活性）但**无强制审查闸、无岗位制、Experimental**；attribution 逐行溯源独有 | 无审查闸概念（run 批处理模型，mech3 天花板=机器人审批） | **review-gate 强制闸+三账对账+确认卡+决策账本+回执链**，生产在跑 | **cc-deck**（唯一制度化） |
| ③中文与本土引擎（glm 系） | 39 引擎：zcode/qwen-code/codebuddy/kimi/mimo-code/trae/qoder-cn/jcode 图标级一等；GLM-5.2 官方文档（glm-agent.mdx）配方=cc-deck 同款 env 别名+glm-5.2[1m]；UI 英文优先 | 无本土引擎倾斜 | bigmodel 原生+claude-* 别名同款配方+中文 UI/文档/SOP 全中文 | **平手偏 Orca**（引擎广度）/**cc-deck**（中文体验） |
| ④长期数据主权 | 核心零依赖可自托管；但推送经其网关、遥测默认开、Relay 托管、日更节奏绑定上游 | SaaS 账号模型（mech4 三不抄之一） | **全自有**（relay/CF/数据目录/events 流/发版链自举） | **cc-deck** |

### 混合方案互斥性评估（「Orca 单机 fleet+cc-deck 治理层」）

**会话层互斥、git 层不互斥**：
- 互斥面：两者都要驱动 agent 进程（Orca 用自有 PTY/runtime，cc-deck 用 relay 注入链）。同一会话只能归一家管——cc-deck 的活会话注入/审批/上下文水位不能作用于 Orca 会话。
- **可行面 1（git 层治理）**：cc-deck 审查闸/验收/对账本来就在分支+diff 层工作——Orca worktree 出的分支完全可进 cc-deck 的 review-gate→squash 流水（cc-deck 当「合并权+审计权」，Orca 当「生产力」）。零改造。
- **可行面 2（CLI 适配器，需 spike）**：Orca 全量 CLI 化（`orca orchestration worker-start --on <host>`），cc-deck agent-adapter 理论上可加一个「orca 引擎」——PM 派单→cc-deck worker 起的是 orca worker→worker_done 回执→cc-deck 审查闸收割。风险=编排 CLI 挂 Experimental、日更漂移、双系统预算/审计割裂。**建议一次 spike 实测链路再拍**。

## 5 行动建议（三选一）

**选深耕差异化，附带战场收缩令**：

1. **不追清单（追=死路）**：Computer Use/Automations/浏览器面板/Design Mode/移动模拟器/插件市场/逐行溯源/引擎数量竞赛/IDE 化 UI——这些直接用 Orca，cc-deck 永不建。
2. **深耕三根桩**：①治理制度化（审查闸/三账对账/回执链/确认卡——继续按 pipeline-audit 损失点活账本进化）；②中文+GLM 原生体验；③默认零云自托管（含推送自主通道）。
3. **混合 spike（一单量级）**：agent-adapter 加 orca CLI 引擎面，验证「cc-deck 治理脑+Orca 执行舰队」——若通，用户场景①的日常生产力迁 Orca、生产链留 cc-deck，两全。
4. **若选收敛自用**：砍掉所有「给外人用」的野心面（推广/插件化/多用户），cc-deck 只服务用户自己的生产链——省下的量全给治理深度。**若选迁移 Orca**：治理 IP（强制闸/岗位制/对账）需在 Orca 之上重建（gates+approvals 原语在，强制性与账本要自建插件/外部脚本），中文 UI 没了，SOP 自举重写，估 3-6 周且绑死 Experimental API——**不推荐全迁**。

### 给用户的一句话

> Orca 赢了「跑 agent 的地方」，cc-deck 还握着「 agent 交付的纪律」。日常写码装 Orca 就用起来（免费 MIT 零冲突）；生产链和审查权留在 cc-deck；要不要让 cc-deck 骑在 Orca 舰队上，一个 spike 就知道。

---

### 证据索引（关键锚点，均对 2026-11-20 main）

- 仓库元数据：gh api repos/stablyai/orca（129,968★/MIT/TS/pushed 2026-11-20/size 3.15GB）；releases v1.4.261→265（4 天 5 版）
- 编排：docs/site/content/docs/cli/orchestration.mdx（Experimental:12；核心模型:27-37；escalation 人审:89-99）；src/main/runtime/orchestration/{coordinator,db,workers,crew}/
- 治理源码：decision-gates/coordinator-decision-gates.ts:52-60（人类解闸）；escalation/coordinator-escalation-triage.ts:55-63（熔断）；db/mutation-receipts/mutation-receipt-store.ts:36-60（幂等回执）；db/attempt-observation-store.ts:9-70（双钟对账）；crew/crew-party-snapshot.ts:22-24（活性投影）；db/worker-status-notice.ts:14-24（触发器广播）
- 安全：rpc/server/pairing/e2ee-keypair.ts:1-4（tweetnacl ECDH）；rpc/transports/websocket/ws-transport.ts:248（明文 WSServer）；pairing/pairing-ticket-exchange.ts:5-10（单次配对券）；mobile-cloud-relay/control-channel/relay-host-proof.ts:5-11（主机证明）；remote-servers.mdx:71-78,113-121,171-178（token/撤销/拒公网）
- 自托管：remote-servers.mdx:192-208（server-only tarball）；telemetry.mdx:50-63（三路关）；notifications.mdx:33-52（推送网关+ORCA_MOBILE_PUSH_MODE）；mobile.mdx:123-136（Relay 域名白名单+LAN 直连）；updater/releases/updater-prerelease-feed.ts:15（GitHub 更新源）；star-nag/（GitHub star 检查）；artifact-cloud-config.ts:3（share.onorca.dev）
- 引擎面：src/shared/agent-icons/ 39 png（zcode/qwen-code/codebuddy/kimi/mimo-code/trae/qoder-cn/jcode 在列）；docs/agents/glm-agent.mdx（GLM-5.2 经 harness 配置，配方=ANTHROPIC_DEFAULT_* env 别名+glm-5.2[1m]+AUTO_COMPACT_WINDOW=1M——与 cc-deck 现行方案逐字同源）
- Multica 引用：mech1（执行可靠性纵深）、mech3 §5（天花板=turn 边界+机器人审批+权限锁死）、mech4 §3（SaaS 账号不抄）

结果：Orca 深调完成——产品面/引擎面/远程执行面 Orca 全面优（39 引擎+日更+全平台，直说不护短）；治理制度化（强制审查闸/岗位制/三账对账）、中文优先、默认零云三面 cc-deck 仍是唯一解；桌面链路非 E2E 差一档、自托管 8.5/10（推送经其网关+Relay 托管）；建议=深耕差异化+战场收缩令（不追清单/深耕三根桩/混合 spike 一单验证「cc-deck 治理脑+Orca 执行舰队」），不推荐全迁（治理 IP 重建 3-6 周绑 Experimental API）｜改动文件：无（纯调研，回执本件）
