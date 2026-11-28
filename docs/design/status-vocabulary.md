# 状态词汇表 v1：六态 glyph ＋ 染色纪律（DEV-40 · T4）

> 2026-11-28 定稿。来源：竞品调研 Top5 之 T4/U1（orca 六态 glyph 全端统一＋「tint means look
> here」，`docs/product-review/competitor-review-2026-11-28.md` §6.B/§8）＋ ui-ledger 状态可视化
> 拖尾（P2-3/P2-7/l02）＋架构审视 TD-P0-3「三端同答案」（`docs/product-review/arch-review-2026-11-28.md` §2.4）。
> **地位**：状态类 UI 的过闸规范——所有新状态面（灯/胶囊/chip/图标）上线前必查本表；违词表即审查退回项。

## 一、六态定义（会话/成员运行态轴）

relay `SessionStatus` ＋ 两处用户定版判活派生（#291 待命 / #160 置灰）收敛为六态。**任何端不得增删态、不得改名**——新业务态先映射进六态（映射不进=提设计变更单改本表）。

| # | 态 | 语义 | 判定（数据源） |
|---|---|---|---|
| S1 | **working 运行中** | 真有活动在跑 | `status=WORKING` 且过 isRealWorking 真判定（#291：有近期工具活动） |
| S2 | **standby 待命** | 接了单没开工 / 挂起 / 值守保活 | `WORKING` 但 isRealWorking=false（#291）；PM 常值守态（#287） |
| S3 | **waiting 等你** | 等用户拍板/审批/作答——**唯一「需要你看」的态** | `status=WAITING`（waiting_request 在场=强形态；脱钩帧不算） |
| S4 | **done 完成/空闲** | 正常终态或静息 | `status=DONE`（含刚完成鲜亮期） |
| S5 | **error 出错** | 异常终态 | `status=ERROR` |
| S6 | **closed 离席/未同步** | 无运行事实：成员离线、会话未同步、历史归档、超时置灰 | offline/离席事件、异源未同步、idle-dim 超阈值（#160） |

**派生复合态（非轴成员，只许复用母态色相）**：置灰蒙层（S4/S5 静默超阈值，透明度手段非新色）、后台子代理 ⑂（bgLive，借 S1 黄呼吸）、休眠卡（dormant=saved，S6 灰系）。看板五态色轴（W-BOARDCOLOR：进行中黄/完成绿/待动作橙两档/未开始灰）与本表同源族，不另立。

## 二、染色纪律（tint = look here）

1. **色相恒等律**：每态一个色相族，三端同相——working=黄、waiting=橙、done=绿、error=红、closed=灰（standby 灰呼吸）。**任何端不得把 A 态渲成 B 态的色相**（修前实锤：expo waiting 黄=working 相；web 检查器「运行中」绿=done 相；手机「运行中」蓝=info 相——本批全数收敛，见 §五）。亮色档饱和度可端上自调（对比度理由，1019 拍板精神），**色相不可换**。
2. **tint=look here**：染色只留给「需要你看」——waiting 橙是唯一常驻行动色；working 黄是状态事实色（呼吸=在跑，不是求看）；done 绿是终态确认色。同屏 tint 上限：**每卡 ≤1 个染色强调**（tokens.css 色预算立法的子集，状态灯位不计强调元素）。
3. **词形分工**：灯（dot）=扫读态；胶囊（tag）=读词态；chip=归属/身份/行动指向（见 §四）。同一态在灯与胶囊两层**必须同色相**。
4. **红只给错误**：红=error＋通知铃铛（tokens.css 立法原文）；waiting 文案不得走红系（修前 expo「需要确认」dangerFg 红字=违律，本批改橙）。

## 三、Glyph 矩阵（六态 × 三端）

色值落点：web `tokens.css --st-*`（暗）/ 亮档覆写；expo `theme.ts`（working/waiting/error/done/blocked）；手机=web-console mobile 视图（同 base.css）。

| 态 | 色相（暗/亮 web 值） | web 会话卡 dot（9px） | web 成员卡胶囊 | web roster 行 lamp-dot（8px） | web 文字胶囊 `.tag.st-*`（本批立） | 手机卡 tag | expo 卡灯 | expo 活动舱 icon |
|---|---|---|---|---|---|---|---|---|
| working | 黄 #FFD24D/#FFB020 | 实点+呼吸光晕（::after 移帧） | 软底12%+描边32% | 实点+光晕 | st-working 同左配方 | st-working | BlinkDot 黄呼吸 | ✶ |
| standby | 灰 --st-closed/--faint | 灰点+微呼吸（working-standby） | （不单列——计数不占，title 悬停说明） | 灰点呼吸 | st-standby 灰胶囊 | st-standby（待命） | 灰呼吸点 | ✶＋灰灯 |
| waiting | 橙 --st-blocked #E5895B（亮同值） | **空心橙环**（inset 1.5px） | 软底12%+描边32% 橙 | 实点橙 | st-waiting 橙胶囊 | st-waiting | **橙实点**（本批改，原黄=working 相违律①）＋「需要确认」橙字（原红违律④） | ◉ |
| done | 绿 --done #35DC97/#168D60 | 实点绿 | 软底+描边 绿 | 实点绿 | st-done 绿胶囊 | st-done | 实点绿 | ✓ |
| error | 红 --error #E5484D/#C84C51 | 实点红+shake-once | 软底+描边 红 | 实点红 | st-error 红胶囊 | st-error | 实点红 | ⚠ |
| closed | 灰 --st-closed | （无 dot；卡面蒙层/置灰） | state-offline 灰 | 灰点 | st-standby 灰复用 | 同左 | 置灰蒙层（dim） | — |

（expo 亮档 done #22A06B/error #D63B3B 与 web 亮档 #168D60/#C84C51 为端上对比度自调，合纪律 1 的亮档条款。）

**胶囊统一配方**（DEV-30 P2-3 定版，本批升为全局 `.tag.st-*` 族）：`background: color-mix(态色 12%, transparent)`＋`border 1px: color-mix(态色 32%, transparent)`＋`color: 态色`（各带静态兜底行，B1② 双写军规）。旧 `.tag.done/.action/.danger/.info` 语义档保留给**非状态**用途（done=完成动作回执、action=交互强调、danger=危险操作、info=信息），**不得再作运行态词形**。

## 四、chip 分层规范（P2-7 定案）

会话卡 r2/r3 徽章群三层，各有用户期溯源，**几何已同 pill 档**（999 圆/1px 边/同 padding，DEV-30 查证）：

| 层 | 例 | 形 | 色 | 溯源 |
|---|---|---|---|---|
| 行动指向 | 等你拍板 awaitu-flag | 描边+软底+600 字重 | 橙（brand/待动作轴） | W-AWAITUSER |
| 归属 | 团队 chip team-chip | 实底/accent | --team-accent 组色 | 编制归属 |
| 身份 | 引擎徽章 engine-badge、CC Deck cc-badge | 品牌形 | 品牌色/蓝（身份轴非状态轴） | #227/P2-6 |

规则：chip 层**不走六态色相**（状态归灯/胶囊层）——身份与状态两轴不许混色（expo theme.ts 注释同款口径）。

**豁免登记（审查 B P1/P2 订正，色相恒等律的显式边界——改色需设计变更单）**：
- **dispatch-pending（已派单·等待处理）**：语义=S2 standby 的 chip 形（机器侧等待=接单未开工，非 S3 等你）。视觉=W-DISPVIS C2 定版黄描边（定版面不动），违纪律①色相条款属**登记在案的既有定版豁免**；后续若统一为 S2 灰系走设计变更单。
- **项目卡聚合点轴（pc3-dot）**：非会话态词形——注意力优先级轴（A2 点语言三态：需行动红〔含 WAITING/ERROR 聚合〕/有进行中蓝/组态灰〔挂起归档与未立项各有灰空心变体〕）。聚合点不携带状态词面；同卡状态词面走 vrow 徽章（`.cc-badge`，本批已归位 S1 黄）。蓝档=「有进行中」的注意力中档指示，非 WORKING 态渲染。
- **验收单「待填」徽章（web 项目域 acceptsRows，DEV-61 收口）**：非会话运行态——验收单**回填生命周期**的「等你交卷」位（文档域行动指向，非 S3 会话轴）。视觉=`.cc-badge.is-warn` 橙（base.css 该类注释「待填/待处理橙」即本位与 vrow WAITING 腿共用一类），与纪律②「waiting 橙=唯一常驻行动色」同族借用；已提交态=is-neutral 幽灵灰。出处 B P3-B5／DEV-40 审查 P3③（「豁免清单外」→本条登记收案）——后续若统一改幽灵灰走设计变更单。

## 五、本批（DEV-40）收敛落点与销项

| 乱面 | 修前实况 | 落点 |
|---|---|---|
| l02 检查器「运行中」徽标 | `session-domain.js` STATUS_TAG WORKING→`.tag.done` **绿**（软底旧风格与 member-state 描边族并存） | 改 `.tag.st-*` 族（working 黄胶囊）——l02 销项 |
| 会话卡 waiting 灯光圈 | `base.css:3286/3290` 光圈环走 `--working` **黄**＋`--status-waiting-glow` 黄 rgba；srow 头像角灯 halo waiting=黄/working=**绿**（W-V8 批2a「运行中绿系」残留族）——与 :713 空心橙环、lamp-dot.blocked「与 .status-dot 完全同源」注释相悖 | 光圈环/halo 归位 `--st-blocked` 橙（waiting）与 `--st-working` 黄（working）；`--status-waiting-glow` 双主题橙化——1014 五色灯语言贯通灯全层 |
| 手机「运行中」徽标 | `mobile.js` STATUS_TAG WORKING→`.tag.info` **蓝** | 同上改 st-* 族 |
| 桥副本状态词表 | `bridge-core.js` STATUS_TAG（info/action/danger/done，死图）＋ `.cc-badge.is-live` 第二黄 #fbbf24 字面量 | 死图对齐 st-*；is-live 收编 `--st-working` token（静态兜底行保留） |
| expo waiting 色 | `theme.ts` waiting=#FFD24D **=working 同值**（1019 注释系对当时现状的描述，本批按纪律①收敛；working 黄值本身不动） | waiting→#E5895B/#C05B33（=blocked 同源）；借 waiting 当警示琥珀的八处位 15 声明（md del/ImportPicker failT/NewSessionModal×2/SetupScreen×3/RenameModal×2/detail-styles diffDel·KC img·ripple×4）改指 working 黄保持原观 |
| expo「需要确认」字色 | dangerFg **红**（违纪律④） | 改 c.blocked 橙 |
| P2-3 徽标三风格 | DEV-30 已修（member-state 归一） | 本表 §三 收录为全局配方，复核在位 |
| P2-7 chip 混用 | DEV-30 查证·维持，留 leader 定案 | §四 成文定案=销项（分层有意，词汇表即依据） |
| 项目长页 vrow 徽章（审查 B P1-1） | `.cc-badge.is-run`「运行中」绿实底（C5 时代值）；离线成员徽章借 is-warn 橙 | is-run 色相绿→黄归位 S1（实底角色保留，亮档补覆写）；离线→is-neutral 灰（S6）——bridge-core `teamRows` |
| 设置域首屏占位会话卡（审查 A P2-1） | `settings-domain.js` 占位 tagClass working=`info` **蓝**（B2 接管前冷启动首帧可见） | chipClass 拆字段走 st-* 族；tagClass 只司 CTA 判定（与 B2 :1321 同映射） |
| expo SetupScreen 连接指示末档（审查 A/B P2 交叉） | 连不上走 c.waiting（waiting 分相后=橙），同语义 ListScreen 本批已按 #357 归红 | 改 c.error（#357 用户定版：连不上=红） |
| ⑂/agdot 呼吸光圈（审查 B P2） | `--status-working-glow` 双主题**绿**（W-V8 残留；本体 var(--working) 黄=同灯两相） | 双主题黄化 rgba(255,210,77,.5)/rgba(255,176,32,.3)——词表 §一「借 S1 黄呼吸」落地 |

**计数口径注（DEV-40 审查 P3④→DEV-61 补注）**：上表「八处位 15 声明」的计数惯例——**位**=括列的消费位点簇（8 处：md del／ImportPicker failT／NewSessionModal／SetupScreen／RenameModal／detail-styles diffDel／DetailScreen KC img／DetailScreen ripple），**声明**=位上的 token 引用处（×N 标多位点）。按 `324f477a` 实 diff 复核：waiting→working 改指实为 **16 声明**（DetailScreen 的 KC img 图色映射有两处定义 :909/:2618，原计数并作一声）；按 diff 改动行计（+侧）=17 行——审查所数「~17-20 行」即此口径。多口径并行时以位点清单为准，引用数字随口径注明。

## 六、守卫与后续

- 机器锚：web 胶囊族/亮档值变更随 `test:fc`＋`test:005-blankset`（B1② 双写计数）；expo 侧色值无既有锚，状态色改动走 `npx tsc --noEmit`＋截图对照（验收标准要求 web/expo 各一屏同状态对照）。
- 新状态面检查单：①映射进六态了吗 ②色相查 §三 表了吗 ③胶囊走 `.tag.st-*` 了吗 ④chip 层没偷状态色吧 ⑤同屏 tint ≤1 吗。
- 手表端（wear-app）后续接入按 §三 expo 列同口径；legacy 壳已冻结不适用。

## 七、liveness 三值映射注记（DEV-50 · W-DISPATCHFIX 验收③端上消费，2026-11-28）

relay 真活性 `liveness`（`displayLivenessOf`：pid kill-0 / SDK 流活 / 帧龄复合判定；仅 `WORKING/WAITING` 会话随 SNAPSHOT 与 SESSION_HEARTBEAT 每 5s 下发，5min 显示窗）是六态轴上的**真值覆核层，不是第七态**——端上不得据它发明新态/新词形/新色相，只按下列映射覆核当前态的呈现：

| liveness 值 | relay 判定语义 | 呈现映射（不增删态） |
|---|---|---|
| `alive` | 进程在 / 流活 / 帧 ≤5min | **零覆核**——按 status 原六态渲染（S1 黄呼吸 / S3 橙环原样） |
| `between-turns` | 无 pid 探测面（外部 SDK / 已回收 agent）且帧 ≤30min——进程大概率在、回合间隙 | WORKING 卡降 **S2 standby** 形（`.working-standby` 灰呼吸——机器在而无产出，与 #291 待命同形同色相）；WAITING 卡维持 **S3**（「等你」行动语义优先，间隙不掩行动色） |
| `dead` | 声明在干活但进程死+5min 无帧＝停摆 | **S6 closed** 形：灯灰实点**不呼吸**（呼吸=「进程活着」形编码，1014 形定版——死不呼吸）+ 卡面轻置灰蒙层（`.stalled`，S6 手段）。waiting×dead 的「等你拍板」chip 保留（§四 行动指向层不受活性蒙层影响——诉求仍在，处理需先救活） |

纪律重申：①两档覆核全部落在既有灰系家族（S2/S6 复用 `--st-closed`/`faint` 色相），**不引入新色相**；②「停摆」不立独立态名/常驻 tag——呈现即 S6 蒙层+灰实点，语义走 status-dot title 悬停与本注记；③消费面收口在卡面灯（web `myCardItem`/expo `SessionCard`）——词面层（胶囊/chip/文案）不据 liveness 改写；④端上渲染必须带 status 门（仅 working/waiting 显示活性覆核，对齐 relay 侧 displayLivenessOf——「WORKING/WAITING 之外的态不显示」），且翻终态清陈标防下轮翻活误显。
