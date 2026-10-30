# PRD v0.2 审查回执——A2 路·租户与存储专项

> 审查对象：docs/specs/multi-device-orchestration-prd.md v0.2 新增部分（§2.1 G5/G6、§4.4 T/C 层、§4.5 全节、§6 T1/T2、§8 验收 7-9）
> 审查者：A2（架构·租户存储专项，1029）｜对照代码：cloudflare/src/worker.ts、cloud-bridge/src/router.ts + index.ts、relay/src/cloud-identity.ts、relay/src/storage/{port,schema}.ts、cloudflare/wrangler.toml
> 结论先行：**方向成立，落地链有 1 个 P0 设计缺口 + 6 个 P1**；两处关键断言裁定见 §5/§6（「凭证中立」弱真；「n=1 零特判」不成立）。

---

## 一、DO storage 作为租户权威的可行性

**结论：技术上可行且有一处 PRD 没意识到的利好，但「低危」评级在备份设计落地前不成立；且权威单点只覆盖了双桥形态之一（见 P1-1）。**

事实核对：

- RouterDO 已是 SQLite-backed DO：`cloudflare/wrangler.toml` `[[migrations]] tag="v1" new_sqlite_classes=["RouterDO"]`。**PRD §4.5「CF Worker 无 SQLite 用 DO 自带持久层」表述不准**——不但有持久层，还能用 `ctx.storage.sql` 做带索引的租户表（对「踢出名单/注册码 TTL 查询」是利好），KV 风格 get/put 也照常可用（P2-3）。
- 配额：SQLite-backed DO 存储上限（128MB 起步、GA 后更高）对 KB 级租户表毫无压力；读写频率=注册/管理操作，低频。**配额非问题**。
- 一致性：DO 单线程 input gate 天然把桥主管理操作与连接处理串行化，无并发竞态——这是 DO 方案的隐性优点，PRD 未提及，建议补进 §4.5 作为选型理由。
- 休眠：CloudRouter 内存表（router.ts:22-24）DO 休眠即丢，靠附件重建（worker.ts:609-617 rehydrate）。**租户归属必须进 WebSocket attachment**（worker.ts:526 serializeAttachment 现有 `{dev,connId,rk,wanTo,ip}` 加一个 `tenant` 字段），否则 rehydrate 是同步函数而 `ctx.storage.get` 异步——要么改 rehydrate 为 async（触 webSocketMessage 全链），要么连接时查一次 storage 后钉进附件。这是实现层最容易踩的坑，任务书应点名。
- **备份设计缺位（P1-6）**：§7 缓解栏只写「DO storage 持久+桥主导出备份」一句，无格式/落点/恢复演练/幂等重放（重放时已绑定设备不得重复入租、踢出名单恢复次序）。定性变化要指出：**现状桥是零状态路由器**（router.ts:1-4「纯逻辑、无 I/O」，Durable 状态只有 WebSocket 运行时），误删 DO namespace / class 迁移失误 / 账号事故在今天=无损重部署，T1 之后=全设备脱离租户孤儿化。建议：导出=桥主签名 JSON 落 DL KV（现有 binding，wrangler.toml kv_namespaces），验收加「删库重放恢复」一条；备份设计落地前风险等级应记**中**非低。

---

## 二、RELAYS 帧租户过滤的真实改动面（P2-1）

PRD §4.5-G6① 写成一句「现状全桥列改为分组列」，实际是 **router.ts 六个触点 + 两个适配器**：

| 触点 | 位置 | 改动 |
|---|---|---|
| register 签名 | router.ts:49 | 增 tenant 参（或构造注入 `tenantOf(dev)` 回调）|
| dev→tenant 内存映射 | router.ts:22-24 旁 | 新增第三张 Map，与 connOf 同生命周期 |
| disc 发现帧 | router.ts:123-129 | `devs()` 全列 → 按请求方 tenant 过滤 |
| pair_req 广播 | router.ts:134-140 | 全 rl- 转发 → 同租户才转发；**未绑定设备的 pair_req 何去何从协议未定义**（配对退役后新设备入租户走哪帧、谁回 ack——PRD 只说「输码」，无帧设计）|
| relay-online 广播 | router.ts:66-72 | **PRD 完全漏了这条**：#34 上线广播现在发给全体 connOf，租户化后跨租户泄露 relay 存在性，违 §4.5「不可探测」语义，须同租户收窄 |
| 直发帧租户闸 | router.ts:144-149 | §4.5「跨租户帧=ROUTE_MISS」要求直发路径查双方 tenant——PRD 未列此触点 |
| CF 适配器 | worker.ts:526/527/615 | attachment 增 tenant（保 rehydrate 同步，见 §一）|
| Node 适配器 | cloud-bridge/src/index.ts:208 | register 调用点同步改——且它没有 DO storage（见 P1-1）|

**向后兼容（未绑租户的存量设备看见什么）**：fail-open（未绑定=看见全部）则不升级/不绑定即绕过租户隔离，§8-7 作废；fail-closed（未绑定=空列表+全拒）则 §8-6「旧 relay 全功能零影响」作废。**验收 6 与 7 在迁移未完成时直接互斥**（详见 P1-4）。建议明文：未绑定=空 RELAYS+直发全 ROUTE_MISS（fail-closed），并把存量迁移从「备注」升格为 T1 验收项。

---

## 三、device_trust 表设计（P2-2）

落点顺不顺架构：**顺**。schema.ts 是逐版追加迁移制（v1 15 表→v2 导入台账→v3 permission_audit，schema.ts:202-218），device_trust 走 v4 迁移 + StoragePort 单写者（port.ts 头注「所有新 durable 写入经 StoragePort」），与 permission_audit 先例完全同构，零破界。

但 PRD 只给了表名没给字段，按 §4.4/§4.5 的承诺反推，**四个字段缺口**：

1. **pubkey 钉扎**——rl- dev 由公钥派生可自证（worker.ts:25-32），但 wb-/ph- 无所有权证明（worker.ts:24 注释自认「顶替 DoS 面为协议固有」）。表里只存 dev 不钉 pubkey，非 rl 设备换钥顶替 dev 即绕过互信。必须存 `(dev, pubkey)` 对。
2. **revoked_at（吊销语义）**——§4.4「用户可随时吊销互信」、桥主「踢出即吊销该设备密钥」，两种吊销（relay 本地互信吊销 / 桥侧租户踢出）都没落字段。
3. **confirmed_by / origin**——first-contact 确认卡谁点的、信任来源（卡片确认/租户导入/LAN 配对迁移），审计面（§4.4 A 层）要求可回溯。
4. **tenant 域**——信任按租户作用域（跨租户重绑不自动继承），PRIMARY KEY 应为 (dev, tenant)。

**G6-④ LAN 同权的 trust 传递是 §4.5 最大的内生矛盾（P1-2）**：三条纪律放不进同一间房——

- G6-④「LAN 直连同权（信任来自租户凭证）」：LAN 路径（ws://lan-ip，cloud-identity.ts 头注：peers 公钥来自 LAN 信道 COMMAND_PAIR_START）**不经过桥**；
- §4.5「桥侧映射不复制到 relay」：relay 无法本地判「同租户」；
- 桥主踢设备（§8-8）要求吊销即时可达：LAN 不经桥，踢出如何传播到各 relay 的 LAN 口？

正解方向：**租户凭证=桥签名成员资格令牌**（绑定 dev+pubkey+tenant+exp，relay 用桥公钥离线验签——验「凭证」不等于复制「映射表」，不踩红线）；吊销走 CRL/在线复核。PRD 对凭证的密码学形状只字未定，这是 T1 任务书前必须补的规格。另注意：**§8-8 只验证云通道**（桥侧拒帧），被踢设备在 relay 的 device_trust 若未联动清除，LAN 口仍开——验收 8 需补 LAN 腿或明示不覆盖。

附带 P2：relay 将同时存在两套信任库——cloud-peers.json（配对手机，cloud-identity.ts:63-77，文件态）与 device_trust（SQLite 态）。PRD 自己最防「三账失真」，却不解释为何互信入库而配对留文件。至少要一句归置声明（合并/并存边界），否则半年后没人说得清「设备信任了没」查哪本账。

---

## 四、T1 先于 X1 的依赖序（P1-5）

PRD §6 论证：「密封信封带 tenant 字段依赖它（T1）」。**该论证不成立**：

- tenant 字段在 E2E 密封体**内层**（§3.2），桥只按 dev 路由不感知租户（§3.2 外层注释自认）。接收方校验 tenant 只需**本机知道自己属于哪个租户**——即 cloud-identity 单值配置（§4.5 存储模型③），不需要桥侧 tenantOf 表/注册码/桥主面/G6 任何一样。
- 即 X1 对 T1 的真实依赖只有「T1a：relay 本机租户身份」，一个配置字段，半天量级。
- 反过来才是真依赖链：T1 里的 **G6 自动互联**（§4.5-G6②「点选即连零配对码」）意味着 relay-yyy 要接受一台**从未配对**的手机发起密封通信——今天这条路被 peers 表（pair_ack 流，cloud-client.ts:643-736）把着。拆掉配对码后：手机要拿 relay-yyy 公钥（RELAYS 帧有 rk，rl- 可自证，OK），**relay-yyy 要拿手机公钥（无来源）**——这正是 P1-3，而其解法（桥签名令牌/成员公钥目录）未设计。G6 的实际深度 ≈ 一套新的跨 relay 授权原语，被「RELAYS 过滤+端侧列表」的措辞严重低估。

建议拆分：**T1a**（本机租户身份+密封 tenant 字段，并入或紧贴 X1）＋**T1b**（桥侧租户权威+G6，凭证密码学规格补齐后再排）。原「T1 先于 X1」作为排序结论侥幸不错（T1b 确实该先动桥），但论据错了会误导任务书切分。

---

## 五、裁定：「协议对凭证中立」——**弱真**

帧形状层面成立：凭证只出现在绑定握手，密封帧携带 tenant id 而非凭证本体，换账号 token 时 §3.2 协议逐字段不变。**但「零协议改动」≠「零改动」**，四处非零成本被「桥侧只换校验器」一笔带过：

1. 校验器从本地查表变**远程校验**（账号服务可用性成为桥的运行时依赖；DO 内 fetch+缓存+降级策略需设计——账号服务抖动时租户验证 fail-open 还是 fail-closed？）；
2. **吊销双账**：账号 token 吊销（账号系统）与设备踢出（桥侧）两个权威并存，语义合流未定义；
3. tenant id 命名空间迁移：v1 桥自生成 → v2 账号体系签发，存量 tenantOf 行要迁移方案；
4. 端侧凭证获取流程：输码（人闸一次性）→ OAuth 登录流（手机/桌面登录 UI+回调），端侧行为协议面虽不变但实现面是整条新腿。

裁定：**「中立」在协议帧上真，在桥侧实现语义与运维语义上假**。建议 PRD 措辞从「零协议改动」降为「零帧形状改动，桥侧校验器与吊销/命名空间迁移另案」。

## 六、裁定：「单租户 n=1 零特判」——**不成立**

两个硬事实：

1. **fail-closed 绑定门是新增硬门**。§8-7「未入租户设备对桥内任何 dev 不可见不可达」——自部署用户升级后，自己的 relay+手机全部变成「未入租户」，不生成/输入注册码就不可用。现状路径（token+dev+rk 直连即用，worker.ts:341-355）被切断。「不生成注册码也要能跑」的诉求与 §8-7 只能二选一：要么加隐式默认租户（=特判代码路径，断言作废），要么接受新增一次性引导步骤（断言的「零」作废，只剩「router 逻辑无 if 单租户」这个较弱命题成立）。且 headless relay「输码」的载体（CLI？config 键？）PRD 未定。
2. **「首个 relay 即桥主」在共享桥=接管向量**（与 P0-1 同根）：PUBLIC_TOKEN 桥（worker.ts:11）上任何先到者自封桥主、生成自己的注册码、把别人踢干净。

建议：n=1 主张改写为「单租户=同一代码路径，但新增一次性 bootstrap 步骤」；bootstrap 策略按桥形态分流——私有桥（仅 CLOUD_TOKEN）可用首 relay 认领，公共桥（PUBLIC_TOKEN 在场）必须 ADMIN_TOKEN 环境变量显式立桥主。

---

## 七、分级汇总

| 级 | 编号 | 发现 | 一句话处置 |
|---|---|---|---|
| **P0** | P0-1 | **桥主面认证缺位**：CLOUD_TOKEN 全租户设备共有（worker.ts:341-343 连接唯一门），管理面若复用它=任何租户成员可踢人/发码/接管；「首个 relay 即桥主」在 PUBLIC_TOKEN 桥是先到者接管 | 管理面必须独立根凭证（ADMIN_TOKEN env bootstrap）；公共桥禁用首 relay 认领。T1 任务书前置项 |
| P1 | P1-1 | **双桥形态被无视**：CloudRouter 由 CF DO 与 Node 桥共享（router.ts:1-4；index.ts:59/208 register 调用，零持久层），「桥侧=RouterDO storage 权威」只覆盖 CF 形态；自部署 n=1 主张恰恰主要落在 Node 桥上 | CloudRouter 增存储端口抽象（tenantOf 回调），Node 侧配 JSON/SQLite 实现+等价桥主面；PRD 补「桥形态」一节 |
| P1 | P1-2 | 凭证密码学形状未定 → G6-④ LAN 同权 × 映射不复制 relay × 吊销可达性三律互斥（§三） | 凭证=桥签名成员令牌（dev+pubkey+tenant+exp）+吊销传播设计；T1 前补规格 |
| P1 | P1-3 | G6 密钥发现链路缺失：配对退役后 relay 侧拿不到陌生手机公钥； shortcuts=踩「映射不复制」红线或 #29 假 rk 注入复发（worker.ts:19-32 前科） | 成员公钥目录（桥按需签发/令牌自带）二选一，明文写进 §4.5 |
| P1 | P1-4 | 验收 6/7 互斥 + 存量导入清单源不存在：桥今天无任何设备持久名册（register 即弃），手机名册在各 relay 的 cloud-peers.json（cloud-identity.ts:63）桥拿不到；「一次性批量导入，无逐台重配」对离线设备/手机不可交付 | 导入清单源=各 relay 上报名册 or 接受手机逐台重绑并改口径；迁移完成前 6/7 二择一验收 |
| P1 | P1-5 | T1/X1 依赖论证不成立；G6 实际深度（新跨 relay 授权原语）被低估（§四） | 拆 T1a（本机身份，贴 X1）/T1b（桥权威+G6，凭证规格后置） |
| P1 | P1-6 | 桥从零状态变有状态=定性变化；导出备份仅一句话（§一） | 备份格式/落点（DL KV）/恢复演练入 T1 验收；风险等级低→中 |
| P2 | P2-1 | RELAYS 过滤真实改动面=router.ts 六触点+双适配器，PRD 只点名一帧（§二表） | 任务书按触点清单切 |
| P2 | P2-2 | device_trust 四字段缺口（pubkey 钉扎/revoked_at/confirmed_by/tenant 域）+与 cloud-peers.json 双信任库归置未声明（§三） | v4 迁移 DDL 进任务书；两账关系写一句 |
| P2 | P2-3 | 「CF Worker 无 SQLite」表述不准：RouterDO 已是 new_sqlite_classes，可用 ctx.storage.sql | 改口径，顺手把索引查询写进选型理由 |

**正面确认**（不是问题）：device_trust 走 StoragePort+v4 迁移与 permission_audit（v3）先例同构，落点顺架构；DO 单线程模型天然消解桥主并发写竞态；E2E 密封体携带 tenant 使桥侧隔离失效时仍有接收方兜底（纵深成立）。
