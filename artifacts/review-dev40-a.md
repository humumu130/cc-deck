# DEV-40 审查回执 · 审查者 A（正确性/回归面向）

- 审查对象：`git diff 24c84bca..96e850e1`（8a2a647e expo updated_at 守卫 / b81978b8 状态词汇表 / 96e850e1 探针轮询修复）
- worktree：`/Users/xdd/dev/cc-deck-wt-dev40`（分支 agent/deck-fixer-1/dev-40，树清洁）
- 方法：全量 diff 逐文件精读 + web 双 IIFE 守卫逐 token 对照 + expo 全仓裸赋值/消费面 grep 清点 + 锚测试有效性推演（含提取 regex 失败路径）+ 基线对照复跑四套测试 + 截图证据实看（/tmp/dev40-shots/statusvocab/）+ 基线空树提取复跑 blankset（/tmp/dev40-base-check，归档自 24c84bca，未触碰仓库树）

## 逐项发现

### P2-1 · 范围外新发现：settings-domain 首屏占位会话卡仍渲「运行中=info 蓝」，词表收敛声明未覆盖此面
- 证据：`web-console/js/settings-domain.js:2506`（`tagClass: ({ working: "info", waiting: "action", error: "danger", done: "done" })[status]`）+ `:524`（`<span class="tag ${item.tagClass}">${item.tag}</span>` 真渲染）+ `:2552-2553`（`renderSessionList` 桌面变体全量落 DOM）。`:2545` 自注释「地基首屏占位；接管后由 B2 renderMyList 重渲」——每次冷启动首帧可见，B2 接管后消失。
- 问题：b81978b8/词表 §五宣称「手机『运行中』info 蓝、检查器『运行中』done 绿两处乱面同批收敛」，但第四处同族乱面（settings-domain 首屏占位列表）仍在渲 `.tag.info` 蓝=纪律①违例面残留。属任务点名三处 STATUS_TAG 之外的范围外残留（未改，不扩大战线），但词表/台账的「收敛完成」口径高估。
- 建议：随批一行改（该 map working→"st-working" 等四键对齐 st-*，CTA 判定读 "action"/"danger" 需同步保留或改判定键）或入单后续批；词表 §五加一行登记该残留面。

### P2-2 · SetupScreen 连接指示末档与 ListScreen 同态不同相（#357 口径劈叉）
- 证据：`expo-app/src/screens/SetupScreen.tsx:472` `connDotColor = connecting||reconnecting ? c.working : c.waiting`——末档（offline/连不上）未随本批调整，token 分相后静默黄转橙；同语义的 `expo-app/src/screens/ListScreen.tsx:1426-1432` connColor 末档本批已按 #357 用户定版归 `c.error` 红（改动自带注释引 #357）。
- 问题：同一 connState 轴两屏两色相（列表=红/设置页=橙）。#357 定版「连不上=红」若按全局口径读，SetupScreen 即漏网点；修前两处同为黄（均已违 #357），本批修一漏一，劈叉是新引入的。
- 建议：SetupScreen :472 末档对齐 `c.error`（一行）；或明示两处语义不同并记录于词表。定级 P2（视觉一致性、无功能影响；若 leader 认 #357 为全局口径则升 P1）。

### P2-3 · 词表 §五/台账 §9 落点清单与实际 diff 失准（过闸规范的对账面）
- 证据：`docs/design/status-vocabulary.md` §五「借 waiting 当警示琥珀的**三处**（md del/ImportPicker failT/NewSessionModal inputErr）」——实际 diff 琥珀借用改指 working 共 **18 个声明位**（md.tsx:254、ImportPicker:392、NewSessionModal:553-554、SetupScreen:898/926/938、SettingsPage:922/1601/1665/1681、DetailScreen:909/2618/3068/3204/3213/3220、detail-styles diffDel:390、RenameModal:76-77）；perm* 族+stripBtnWarn 边+DetailScreen permName+ListScreen connColor 的**归红组**（8 处声明位）§五全未登记（仅 ui-ledger §9 有记）。`docs/night-audit/ui-ledger.md` §9「警示琥珀借用**六处**」与其自身列举（约 16 处）亦不符。
- 问题：词表是状态类 UI 的过闸规范，「本批收敛落点」表与实际改动面不一致会误导后续批对「已收敛/未收敛」的判断。
- 建议：§五 落点表按实际 diff 对账（18+8 两组的完整清单或「见 ui-ledger §9」的显式委托+数字订正）。

### P3-4 · `:not(.tag)` 对既有非状态胶囊的轻微视觉漂移（收割检查「收起」钮）
- 证据：`web-console/css/base.css:1691` 改为 `.inspector-title > span:last-child:not(.tag)`；`web-console/js/team-domain.js:749` 收割检查 title 末位是 `.tag`（收起钮，非 st-* 态胶囊）——失 text-strong 覆盖后退 `.tag` 基础 `--tag-ink`（暗 #D7E3EF/亮 #2D4358），且失 tabular-nums。非 tag 元素（标题 span、metric 等）经 ：not 闸零影响，无其他回归面（全仓 inspector-title 消费仅 session-domain:2854/team-domain:749 两处）。
- 建议：确证接受即可（tag-ink 本就是 pill 惯用文字色）；不改无碍。

### P3-5 · ListScreen sumWaiting 注释引用的桌面锚已不存在
- 证据：`expo-app/src/screens/ListScreen.tsx:2338` 注释「对齐桌面 .card-summary.waiting」——全 css grep 无该选择器（仅 base.css:2714 注释提及旧名）。改动本身（dangerFg→blocked）与纪律④一致无问题，陈旧注释随行保留。
- 建议：随下批顺手订正注释。

### P3-6 · 探针截图证据 03/04 裁剪错位；亮档 waiting 双端异值宜在词表显式标注
- 证据：`relay/scripts/probe-statusvocab-shot.mjs` `inspClip` 只按首卡（sv-work）计算一次，切卡后 03-inspector-waiting.png/04-inspector-error.png 实拍错位（实看 03 仅截到边角），waiting/error 胶囊的截图证据不可用（computed 断言输出仍有效）；01/02/05 实看正确（六态卡灯橙/黄/灰/红/绿各归位、检查器「运行中」黄胶囊= l02 销项、token 对照表全表同相）。expo 亮档 waiting #C05B33 与 web 亮档 --st-blocked #E5895B 同相不同值——词表 §三「亮同值」措辞仅指 web 侧，§三已注 expo 亮档自调条款，无矛盾但易误读。
- 建议：探针切卡后重算 clip（一行）；词表 §三 waiting 行加「expo 亮 #C05B33=端上自调」半句。

### P3-7 · 96e850e1 轮询修复未回植兄弟探针（口径说明）
- 证据：轮询就绪只落在新增 `probe-statusvocab-shot.mjs:31-38`；约 20 个兄弟探针仍为固定睡一次性 fetch（如 `probe-awaituser-shot.mjs:18` `await wait(2200)` 后直连 /json/list）——正是本 commit message 描述并「自愈」的竞态形态。范围内无回归（新文件自身健壮），兄弟面系存量。
- 建议：后续批批量回植轮询模式，或在本commit回执注明仅新探针生效。

### 新发现-8 · 范围外：test:005-blankset B1②/B1③ 闸在基线即红（非本批引入）
- 证据：本分支 HEAD 复跑 `9 passed, 2 failed`（B1② 裸奔 81 条 / B1③ box-shadow 缺兜底 8 条）；将 24c84bca 基线归档到 /tmp/dev40-base-check 复跑同脚本——**同样 81 条/8 条、同签名失败**。即本批零新增违规（新 st-* 五规则+is-live 全部合规双写，81=81 恒等），但「双写军规机器闸」在基线已失效，本批的「blankset 计数随动」保障实际是红灯下的计数对比。
- 建议：leader 知悉——81 条存量裸奔需专项清偿后该闸才恢复回归价值；本批合规性由「基线恒等对比」背书（已做，证据如上）。

## 逐项核验（通过面）

**A. 守卫正确性 —— 通过**
- `expo-app/src/store.ts:268-275` touchUpdatedAt 与 `web-console/js/session-domain.js:954-961`、`bridge-core.js:272-279` 逐 token 同体：null 安全（`!sess` 短路）、`Number(ts)||0`（缺载/非数/NaN/非正统一拒）、非 force 同值/回拨拒（`>=t`）、数字字符串归一（"1700000005000"→推进，X4-7 锁）、返回是否推进。六点全同，无口径漂移。
- 裸赋值清点：全 expo-app `\.updated_at\s*=` 仅 store.ts:273 守卫体内 1 处；其余 updated_at 流均为建卡对象字面量（store.ts:2651 SESSION_CREATED、SNAPSHOT 装配=新对象非洗点）或只读（排序/置灰/elapsed）。org-delta.ts 的 board-meta updated_at 属另一域非会话排序面。
- expo 特有路径核查：SESSION_WAITING/WAITING_RESOLVED/ERROR/DONE（store.ts:2727-2772）翻转状态零本地造时刻——与 web 的 force 口不同形但同答案：relay 侧真态变 force 推进后经 SESSION_UPDATED 载荷下行（relay/src/session-manager.ts:4078 bus.emit SESSION_WAITING → :4093 emitUpdated 相邻发帧证实 follow-up 在），expo 单帧消费面拿到推进值；契约在 updated-at-writers.md expo 节显式登记（「翻转不本地造时刻」），非漏守卫。bridge-core 合并口 `(payload.updated_at)||frame.ts` 信封兜底为 web 桥特例（A3-5 锚在管），expo 走 payload-only 与 session-domain 同款=#271 口径一致。
- 修前红形态确认：修前代码 `if (typeof pu === "number" && pu > 0) s.updated_at = pu`（无同值/回拨拒）——乱序旧转录 ts 可回拨排序面，X4-4 即该形态。

**B. 锚测试有效性 —— 通过（非形式锚）**
- X1-X3 源码锚与实现当前形态逐条比对一致（X3-1 精确到整行调用文本；X3-2 force 否定锚限 SESSION_UPDATED..SESSION_HEARTBEAT 段；X3-4 心跳段锚与源码实况吻合——段内唯一写 `s.elapsed_hint`；X3-5 建卡字面量锚）。漂移即红，无假绿路径。
- X4 是真行为断言：提取函数体剥 TS 返回注解后 `new Function` 隔离求值，九断言（null/缺载/非数/同值/回拨/真值/force/数字串）锁三律。提取失败由 X4-0 红灯拦截（`if (fnTextExpo)` 守卫不吞失败）；实现若重构为多行花括号块，非贪婪提取截断 → 括号失衡 → SyntaxError → 套件非零退出，同样红。extract() 新增的 `(:\s*\S+\s*)?` 返回注解容差对 web 两份无注解签名不受扰（可选组）。
- X2 bareWrites 正则与 web A2 同款（`\.updated_at\s*=(?![=>])`），实得 1=守卫体内。

**C. CSS 回归面 —— 通过**
- 双写军规：新增 `.tag.st-*` 五规则全部「静态兜底在前+color-mix 在后」（background: transparent→color-mix；border-color: var(--tag-border)→color-mix；color 为纯 var 引用无 color-mix 无需兜底）；`.cc-badge.is-live` 四通道全兜底（bg transparent/border var/color #fbbf24 字面量保留）。基线对照复跑证明零新增裸奔（81=81）。
- `.inspector-title > span:last-child:not(.tag)`：非 tag 元素行为不变（:not 精确豁免）；唯一副作用=team-domain 收起 pill 失 text-strong（P3-4，轻微）。
- waiting/working 灯 token 双主题在位：--st-working 暗 :53（#FFD24D）/亮 :220（#FFB020）；--st-blocked :55 :root 单值 #E5895B 双主题继承（词表「亮同值」口径自洽）；--status-waiting-glow 双主题已橙化（tokens.css :105/:264）。base.css:713 空心橙环（既有 --st-blocked）与 :3286/:3290 光圈环、:3295-3296 srow 头像 halo 现已全相贯通，srow working halo --done 绿残留一并归位 --st-working。

**D. STATUS_TAG 消费面 —— 通过**
- 三文件全部类名（st-working/st-waiting/st-error/st-done/st-standby）在 base.css:763-767 均有规则；未映射态回退 `["完成","st-done"]` 有类不裸奔；mobile 待命旧用无定义的 `waiting` 类（恒落中性底）→ 现 st-standby 灰胶囊有定义=改善；bridge-core STATUS_TAG 为零消费死图（全文件仅 :680 一处定义，grep 实证），注释「防复活漂移种」属实；session-domain tagClass CTA 判定（:1321 独立 map）未受本批影响（"action"/"danger" 字面量判定链完好）。settings-domain 首屏占位残留见 P2-1（范围外）。

**E. expo theme waiting 分相 —— 通过**
- 全仓 `c.waiting` 消费面清点：statusColorOf（theme.ts:239，WAITING→橙实点=词表核心落点）、page-head 等你计数点、OrgZone pending/待你确认、DetailScreen WAITING strip（:1436）——语义均为「等你」轴，橙相正确；琥珀借用 18 处改指 working 保原观无遗漏（grep 无残留 waiting 警示借用）；perm* 八处+stripBtnWarn 边+connColor 归红=恢复 detail-styles :155/:190 注释明书的红（「红 tint 选中」「3px 红从属条」——1019 token 三迁留下的名实分离，本批名实归一），与各自注释现已一致；sumWaiting dangerFg→blocked 与纪律④一致。无消费方依赖「waiting==working 同值」旧假设残留（SetupScreen :472 的劈叉见 P2-2，属 #357 连接轴非琥珀借用）。

**F. 自测复跑 —— 全部执行（本机，env -u CCR_ORG_DIR -u CCR_DATA_DIR）**
| 套件 | 结果 |
|---|---|
| `npx tsx scripts/test-updated-at-guard.ts` | **PASS 74/74**（X 组 18 锚全绿） |
| `npm run test:teampolish` | **46 passed, 0 failed** |
| `npm run test:fc` | 137 ok / 0 FAIL |
| `npm run test:005-blankset` | 9 passed, **2 failed**——失败=基线既有同签名（新发现-8），本批零新增违规 |
| expo `npx tsc --noEmit` | src/ 零错误（仅 scripts/test-*.ts 既有 node 类型缺失，非本批文件） |
| 截图证据 | /tmp/dev40-shots/statusvocab/01/02/05 实看正确（03/04 裁剪错位见 P3-6） |

## 结论

**通过**（无 P0/P1）。

- R4 立即件（expo updated_at 守卫）实现与 web 双 IIFE 逐 token 同体，锚测试为真行为锁（提取失败/重构截断均红灯，无假绿路径），74/74 复跑绿——可收。
- T4 词汇表落地三处 STATUS_TAG 消费面/CSS 胶囊族/灯相归位全部核实在位，截图与 computed 证据齐——可收。
- 随批建议修：P2-2（SetupScreen 一行对齐 #357）、P2-3（词表 §五 对账）；P2-1/P3 组可随批或入单；新发现-8（blankset 基线红灯）报 leader 知悉排专项。

---

## 返修处置（deck-fixer-1，2026-11-28 同 run 闸内闭环）

- **P2-1（settings-domain 首屏占位 info 蓝）**：✅ 随批修——sessionItem 拆 `chipClass` 字段走 st-* 族（渲染用），`tagClass` 与 B2 :1321 同映射只司 CTA 判定；renderSessionCard 双 chip span 改 `${item.chipClass}`。机器锚：test:fc 新增 DEV40R-1（working:"info" 复活即红）。
- **P2-2（SetupScreen 连接末档橙/红劈叉）**：✅ 随批修——else 档改 `c.error` 对齐 #357/ListScreen，注释同口径。expo tsc src 0 错复核。
- **P2-3（词表 §五/台账 §九 琥珀计数失准）**：✅ 随批订正——§五/§9 改「八处位 15 声明」并列明位点；§四 补豁免登记（dispatch-pending/pc3-dot）。
- 复核面：test:fc 142/0（含 DEV40R×5 新锚）、teampolish 46/0、005-ui-rows 143/0、guard 74/74、blankset 基线恒等（81=81）。
