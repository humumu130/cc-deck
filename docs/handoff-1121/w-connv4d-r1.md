# W-CONNV4D-R1 回执——安全路深查（LAN 邻居发现批D）

> 被审：fix/connv4d @c46215cf（worktree /private/tmp/cc-deck-w-connv4d，diff 69ce1905..c46215cf，12 文件 +1116）+回执 w-connv4d.md。
> 安全路（网络准入新攻击面专审），只读零改码。行号均指 c46215cf 工作树。
> 复跑证据：批内 68/68（test-lan-peers）+23/23（test-lanpeers-web）本机复现属实；主仓基线 @69ce1905 cardlifer2 43/44 红（R4⑪）、settings-ws 同红同断言行（"A: 新装 SNAPSHOT…got=undefined"）均实测复现=归因属实；bridge 未复跑（回执三重证据+本批 diff 不触 bridge/SESSION_CREATED 链，环境敏感项照单采信）。

## 〇、结论速览

| 级 | # | 一句话 |
|---|---|---|
| P1 | 1 | onReady/identity 时序证伪——生产启动路径 TXT 恒发空帧，LAN 发现腿对同版本部署死路；回执「时序安全」声明不实 |
| P1 | 2 | 拒绝记忆成单行道——rl- 设备被 device-admin 写面 gate 拒之门外，「解除忽略」用户面无路径；回执「解除走批C2 unignore 零新代码」声明不实 |
| P2 | 3 | 卡面指纹尾 4 位=16bit，暴力同尾4+同名即可造出与真卡不可区分的冒充卡 |
| P2 | 4 | confirmed 落共享 xmsg 信任账本——卡面「同意仅开放传输层准入」与账本真实授权面不符（当前有租户双闸兜底，语义债） |
| P2 | 5 | 弹卡洪水残余：身份循环绕 per-dev 冷却（rateLimited 10/min/IP 是唯一闸；IPv6 源循环无界；mDNS 邻居列表灌水零限流） |
| P3 | 6-12 | 发起端状态回执明文可伪造/ACAO:* 沿先例/SSRF-lite/8KB 帽按字符计/无云桥形态静默不可用/注释与现实不符/v1→v2 手表兼容仓内无证据/✓ 不 drain 悬置 xmsg |

**结果：挡**（P1×2 必修后再收割；P2 建议随批修或入单）。

---

## 一、P1-1：onReady 时序——TXT 恒空帧，LAN 发现腿在生产启动路径死路

**证据链（全部静态实锤，时序推演见下）：**
- `relay/src/index.ts:489`：`advertiseRelay(cfg.port, …, lanPeersHub.txt() ?? undefined)`——在 `onReady`（listen 回调）里**一次性**求值 TXT；
- `relay/src/index.ts:403` `cloudIdentity = null` 起手，全仓唯一赋值点在 `index.ts:696`（`if (cfg.cloudUrls.length)` 云桥块内）；
- `index.ts:540` `await yieldLoop(); // 进段先让一轮——listen 事件最早期可达`——bootfast2 数据段**刻意在重步前让出事件循环**（540/543/571/581/625 五处 yield 全部先于 696）；
- `relay/src/mdns.ts` advertiseRelay 无 updateTxt/再发布路径，publish 一次定格。

**推演**：listen 完成事件在首个 yield（:540）后的首轮事件循环投递 → onReady 跑 `hub.txt()` → `keypair()` 读 `cloudIdentity` **仍为 null**（:696 未到）→ 返回 null → TXT 落 `{v:"2"}` 无 dev/nm/pk → 对端 `parseLanService`（lan-peers.ts:71-77）因缺 dev/pk 滤掉 → **本机在任何邻居的 LAN 列表里永远不出现**。同版本双机部署互不可见：发现腿（验收点1/2）、发起腿（点不了不存在的人）在生产启动路径整体不可达——只有「受理腿」（/api/lan-connect 外来帧直打）活着。回执 §二「时序安全：onReady 在同步主流程 identity 构造后的事件循环里执行」**与代码事实相反**（bootfast2 的设计目标恰恰是让 listen 事件先于数据步到达）；§七承认「真机双机 mDNS 实测未做」——此 bug 双机必现。测试为何绿：mock bonjour 从 hub 层注入，从不走 index.ts 真实启动序。

**修法方向（供 worker，非指令）**：identity 就绪后补发布——advertiseRelay 返回 service 句柄上挂 txt 更新（bonjour publish 支持 updateTxt/或 stop+重 publish），或把 advertise+start 延到云桥块 identity 赋值后（注意无云桥形态仍要 publish v2 空帧保 #316 手表行为）。另建议补一条**真实启动序断言**（起真 index 进程→抓 advertise TXT 含 dev/pk）防回归。

**安全路注记**：此 bug 不开洞（是功能死），但让「指纹核对/同意制」这层安全 UX 在生产中根本不发生——安全叙事建立在一条实际不运行的腿上，故升 P1。

## 二、P1-2：拒绝记忆单行道——rl- 无法经用户面解除忽略

**证据链：**
- `lan-peers.ts:173`：✗ 决议 `setIgnored(port, dev, "LAN 连接请求被拒绝")`——写 rl- dev 的忽略清单；
- `ws-server.ts:894-897`：device-admin **写面公共 gate** `if (!/^[a-z]{2}-…/.test(d) || kindOf(d) === "other") → 400 "dev 需为 ph-/wb-/wt- 前缀设备号"`——`kindOf("rl-…")="other"`，kick/ignore/**unignore 三写全拒**；
- `ws-server.ts:855`：list 面 `all = Set(peerMap ∪ trustMap ∪ adminMap)`——rl- 行**确实进**「连进来的设备」台账（kind=other、无名）；`web-console/js/settings-domain.js renderDevAdminRows`：忽略行渲染「恢复」钮（data-devadmin-unignore）→ 点击 → `devAdminRun("unignore","rl-…")` → **400** → toast「操作未生效：管理数据写入失败」；
- 界面承诺：发起端已拒行文案「对方在『连进来的设备』里解除忽略后可重新发起」（settings-domain.js lanPeersRows rejected 分支）+ 卡决 console「unignore 可解除」（session-manager.ts:9633）——**全部不可兑现**。

**后果**：用户误拒（或拒后改主意）→ 该邻居**永久拉黑**，无任何用户面路径解除（库级 clearAdminMarks+unRevokeDevice 只在测试里调过——「unignore 解除后再请求 → 重新出卡」断言走库函数绕开了 HTTP gate，典型测试面≠生产面）。回执 §四「解除=批C2 设备管理 unignore 双清链（零新代码）」与 §三.1「LAN 邻居不占设备管理面」两处声明均与代码不符（前者路径死、后者 list 面占了）。

**修法方向**：device-admin 写面 gate 放行 rl-（unignore 必放行；kick/ignore 是否放行随批定——不放行则 list 面 rl- 行不该带踢/忽略钮）；或 lan-connect 自带解除口。同时补 HTTP 级 rl- unignore 断言。

## 三、P2-3：卡面指纹尾 4 位可暴力——冒充卡不可区分

`lan-peers.ts:193` `fp = dev 尾 4 hex`（16bit）。攻击推演：攻击者（LAN 内）暴力 ~2^16 个 keypair 即可得到与受害者真机 **dev 尾 4 位相同**的密钥（成本分钟级），帧内 `name` 又是自报（卡面已注明不可信但用户实操看名字）→ 产出一张**名字+尾4 与真卡完全一致**的确认卡。卡文案说「公钥指纹才是身份」但卡面只给 4 hex 人肉核对位=防绕过面名存实亡。payload 里全量 dev/pubkey 有（projects 卡渲染进 `<details>` 折叠）但核对动线不引导。**修法**：卡面显 ≥8 hex（或全 dev 尾 8 位+首 4 位）；成本零，防混淆增益实质。后果边界：即便误 ✓，权限面受 P2-2 同款闸（传输记账+租户内 xmsg），不致数据泄露——故 P2 不 P1。

## 四、P2-4：confirmed 落共享 xmsg 账本——「同意仅开放传输层准入」话术与真实授权面不符

**核验（brief 重点1）**：决议路径确实**零碰 identity.peers/rk 面**——applyLanConnectDecision（lan-peers.ts:166-177）只写 device_trust+device_admin_state；sendConnect 只出站密封帧，零 ctxPool/activateAcctRelay 触点。✓ 字面红线成立。

**但**：`confirmDevice` 写的 confirmed 行落在**xmsg 信任账本**（device-trust.ts 文件头自述「xmsg 接收链按本表裁决信任」）——`xmsg-commands.ts:387` trustVerdict confirmed → `deliver()` → COMMAND_MESSAGE/ext-input **注入值班会话**。即 lan-connect ✓ 与既有「跨机首联」卡产**完全同权**的 confirmed 行；卡面却承诺「同意仅开放传输层准入，数据信任仍走配对码/账号」。当前跨账号不可达（云桥 RELAYS 租户过滤下发 cloud-client.ts:1159 注释+接收侧租户硬边界 xmsg-commands.ts:379-386 双闸；且需 CCR_XMSG=1 显式开），**实际权限未放宽**——但语义债成立：账本语义超出同意话术，未来桥闸任何松动（多桥部署/租户口径变化）即成放大面，且「confirmed 行先于任何消息存在」是新路径（此后该 dev 首条 xmsg 免卡直投）。**修法二选一**：lan-connect ✓ 落独立传输记号（不写 confirmed_at，xmsg 首联卡照旧）；或卡面如实披露「同意=对方可经云桥向你发送跨机消息（带来源标注）」。另注：✓ 不 drain 悬置 xmsg（onTrustDecision 未挂，P3 级不一致）。

## 五、P2-5：受理面弹卡洪水残余（身份循环）

per-dev 冷却（60s）与拒绝记忆都键于攻击者可无限再生的事实身份：换 keypair=换 dev=冷却/记忆全清零。弹卡成本=1 次密封帧（自己钥+受害者 pk，pk 就在 mDNS TXT 里）。现有闸：rateLimited **10 次/60s/源IP**（acceptance.ts:78，进程内存）。推演残余面：
1. 单 IPv4 源 10 卡/分钟持续（600 卡/小时，pending 确认列表+device_trust 行皆无上限——addConfirm 无 cap、trust 行无 GC）；
2. **IPv6 源循环**：同网攻击者换源地址即换桶，实质无界；
3. **mDNS 服务灌水零限流**：组播面与 HTTP 面独立，伪造 _ccdeck._tcp 服务可灌满受害者 LAN 邻居列表（peers Map 无上限），每行带「发起连接」钮；
4. cooldowns/lastAdmit/states/peers 四张内存 Map 无淘汰（慢性膨胀）。

**建议**：card 动作单独更严的 per-IP 预算（如 2/min）+pending lan-connect 卡全局 cap（如 5，超则 silent）+peers 表 cap+parseLanService 限 RFC1918/链路本地段（兼收 P3 SSRF-lite）。均不阻塞本批，但 IPv6 家庭/办公网现实存在，建议随批修 ①③。

## 六、逐项核验对照（任务书七点）

1. **R5 红线落地**：零碰 identity/rk ✓（§四）；「confirmed 与配对码/账号源同构不放宽」——同构 ✓、当前未放宽 ✓（租户双闸）、话术不符=**P2-4**。
2. **受理面攻击**：rateLimited 10/60s/IP+8KB 帽（lan-auth 同款确认 ws-server.ts:730-745）；伪造 devId→shape/self 400；超 ts 窗→403 replay；重放 sealed box：±5min 窗内重放合法帧=卡在悬 noop/已决幂等/拒绝静默，仅「卡过期未决」形态可重弹一张，界内。坏 nonce/base64 吞 unseal ✓（测试有锚）。**缺口=§五身份循环**。
3. **sealed box 持钥证明**：冒名他人 dev 不可达（无其私钥则 unseal 必败）✓；人肉核对面被尾4 暴力击穿=**P2-3**。
4. **确认卡 UX**：同名混淆成立（名字自报+尾4 可撞）；卡上可辨识物仅 名字+尾4（payload 折叠里才是全 dev）；发起端「对方已拒绝」态=对端明文 HTTP 回执，**MITM/伪造 mDNS 指向可伪造任意态**（pending/confirmed/rejected 展示层欺骗，无数据暴露，P3）。
5. **拒绝记忆边界**：换钥新身份绕过成立（§五，自证身份固有）；与配对码零联动（全程不触 pairing）✓；解除路径死=**P1-2**。
6. **三红归因**：cardlifer2/settings-ws 主仓基线各跑一次均同红 ✓（见头部复跑记录）；bridge 采信回执三重证据。
7. **探针盲区清单**（68+23 未覆盖）：HTTP 级 429 洪水/8KB 掐连/unignore-via-HTTP（rl-，**P1-2 会被抓**）/CORS 头在场/真实启动序 TXT（**P1-1 会被抓**）/身份循环弹卡/xmsg 互联（P2-4）/MITM 状态伪造。建议随修随补。

## 七、P3 清单（不阻塞，如实记录）

- `/api/lan-connect` ACAO:* 与 lan-auth/lan-hello 同款先例（ws-server.ts:727/758），drive-by 可探测面增量≈0（无钥帧恒 bad frame）——确认沿用可接受，回执 §六问询项答复「同款属实」。
- 8KB 帽按 utf8 解码后字符累计（多字节可放大 ~4× 字节）——宽松无害注记。
- `ipv4Of` 收任意公网 IPv4+SRV 端口：用户点「发起连接」=向伪造 ip:port 发一条盲 POST（密封体目标不可读）——SSRF-lite，建议限内网段（随 P2-5③）。
- 无云桥（cloudUrls 空）形态：hub 照 start（browse 可见他人）、txt() 恒 null（不可见）、受理 503——功能静默不可用，回执已声明为设计取舍（身份锚在 cloud-keypair），知会用户即可。
- ws-server.ts:466 注释「lanPeers null=未启用（CCR_NO_MDNS/无 identity 形态）」与 index 恒传实例不符（null 仅测试可达；CCR_NO_MDNS=1 是 mdns:false 形态）——注释纠偏。
- TXT v1→v2 对 #316 手表兼容：expo-app 仓内**无任何 mDNS 消费代码**，零变化声明在本仓不可证——真机待验清单应含旧手表客户端发现回归（L4 项）。
- lan-connect ✓ 不 drain 悬置 xmsg（onTrustDecision 未挂）——同 dev 既有悬置消息等 TTL，边缘不一致。

## 八、改动面零触碰确认

只读审查零改码；worktree /private/tmp/cc-deck-w-connv4d 未动（仅 git log/diff/读文件/跑测试）；主仓基线跑测在 /Users/xdd/dev/cc-deck（relay 套件自带沙盒 env，未触生产数据；cardlifer2 按套件设计只读生产台账断言）。

结果：挡——P1×2（发现腿时序死路+拒绝记忆单行道，均伴随回执声明失实与测试盲区）必修；P2×3 建议随批（尾4 位数升/confirmed 记号或话术/弹卡预算）；P3 记录在案。安全红线字面（决议零碰 identity/rk、零新数据通道、sealed box 持钥证明、防探测回显）核验成立——失分在「声明与代码现实的三处脱钩」而非闸门本身。
