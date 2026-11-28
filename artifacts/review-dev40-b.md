# DEV-40 审查回执 · 审查者 B（反方视角 / 规范符合性）

- 审查对象：`git diff 24c84bca..96e850e1`（8a2a647e expo updated_at 守卫 / b81978b8 状态词汇表 / 96e850e1 探针轮询修复）
- worktree：`/Users/xdd/dev/cc-deck-wt-dev40`（分支 agent/deck-fixer-1/dev-40）
- 方法：词表 `docs/design/status-vocabulary.md` 全文逐条对照 diff；web-console（css/js）与 expo-app/src 主动搜运行态残留乱面（六态词形 × 旧类 × 字面量色三向 grep）；「琥珀借 working / 危险归红」改动点逐个判语义位 vs 装饰位；1014 灯本体 / member-state 定版本体 diff 逐行核对；expo↔web 六态值亮暗双主题逐值比对；ui-ledger §9 三销项（P2-7 / l02 / P2-3 复核）逐项回代码验证；机器面独立复跑（test:fc / test:teampolish / test-updated-at-guard / test:005-blankset / expo tsc / probe-statusvocab-shot 实跑 + B1 计数自写脚本对 24c84bca 基线重算，基线文件经 `git show` 提取到 /tmp，未触碰仓库树）。
- 交叉印证：审查者 A 回执（artifacts/review-dev40-a.md）已先行产出，本回执与其重叠点位显式标注「与 A 交叉」；B 独有发现为 §P1-1、§P2-B1～B4 及 P3-B 组大部。

## 逐项发现

### P1-1 · 词表纪律①「任何端不得把 A 态渲成 B 态色相」与其管辖的存量活跃面正面冲突，词表既未转换也未豁免登记
- 证据：`web-console/js/bridge-core.js:907`（`VROW_K = { WORKING: ["运行中", " run"], … }`）+ `:921`（`kCls === " run" ? "is-run"`）+ `:941/:956`（项目域会话/团队分区行消费）+ `web-console/css/base.css:3744`（`.cc-badge.is-run { … color: var(--done) } /* 运行中=全站唯一保留饱和实底语义的态（C5 绿） */`）。渲染入口 `renderLongPage`（bridge-core.js:1036-1043）= 项目域长页「会话」「团队」分区每行右侧徽章——WORKING 行渲染**绿相「运行中」实底徽章**，与词表纪律①明令禁止、且本批刚在检查器（l02）与手机两处定性为「乱面」收敛掉的形态完全同款。同函数 `:956` 离席成员 `["离线", " wait"]` → `is-warn` **橙**（S6 closed 应灰系，「tint=look here」常驻行动色被无事实态占用）。
- 另同族：项目卡点轴 `bridge-core.js:795/:835` + `base.css:3755-3758`——`pc3-dot` 三态「红/蓝/灰」（有进行中=**蓝** `--info`、含 WAITING/ERROR 需行动=**红** `--error`）：working 渲 info 相、waiting 渲 error 相，双违纪律①。
- 问题：词表 §二①写的是全称不变式（「任何端不得……」），§三矩阵只收会话卡 dot/roster lamp-dot/member-state/.tag.st-*/手机 tag/expo 灯八列；§一只把「看板五态色轴（W-BOARDCOLOR）」声明为同源收编——项目域 vrow 徽章轴与 pc3-dot 点轴这两条**活跃的存量运行态语言**既没被收编也没被豁免，规范落地第一天即存在自身管辖面内的活体违例。台账 §9「手机『运行中』info 蓝、检查器『运行中』done 绿两处乱面同批收敛」句式亦会让读者误读绿「运行中」已全站清零。
- 建议（二选一，均为小改）：(a) 代码收敛——VROW_K working 腿改 st-working 族（或 `.tag.st-*` 新增 k 列样式）、离线腿改灰（is-neutral），pc3-dot 蓝腿改 `--st-working`；(b) 规范豁免——词表 §四/§五显式登记「项目域 vrow C5 绿实底徽章 / pc3-dot A2 三态点为既有拍板语言，豁免纪律①」并写明溯源，同时订正 ui-ledger §9 措辞。在 (a)/(b) 任一落地前，本批不宜收割。

### P2-B1 · `--status-working-glow` 绿值 token 与词表相律冲突，⑂ 后台子代理呼吸光晕实为绿——§一「⑂（bgLive）借 S1 黄呼吸」承诺与代码不符
- 证据：`web-console/css/tokens.css:104`（暗 `--status-working-glow: rgba(53,220,151,.5)`=#35DC97 **绿**）/`:265`（亮 rgba(22,141,96,.3) 同绿）；消费点 `base.css:735`（`.srow-live-dot::after` 呼吸光晕）+ `:2802`（本体 `background: var(--working)` 黄）+ `:2803` 注释自认「活体语义由**绿点**呼吸承载」。expo 侧对照 `expo-app/src/screens/ListScreen.tsx:1008`（`bgLive ? c.working`）为黄呼吸。
- 问题：本批为同一逻辑修了兄弟 token（`--status-waiting-glow` 黄→橙，注释明书「与 --st-blocked 空心环不同相」相悖），却留下名为 working、值为 done 绿的 glow token 继续给⑂光晕上色——web 端⑂=黄体绿晕、expo 端=纯黄，跨端不同答案；词表 §一「借 S1 黄呼吸」在 web 端只对了一半（本体黄、晕绿）。
- 建议：`--status-working-glow` 双主题改 `--st-working` 同相（或直接引用 color-mix），顺带消掉「名字说黄、值是绿」的陷阱；§一措辞同步。

### P2-B2 · 词表 §四 dispatch chip 例外条款自相矛盾：waiting 语义的 chip 被合法化为 working 黄相
- 证据：`docs/design/status-vocabulary.md` §四「已派单·等待处理 dispatch-pending 用**黄**描边=『机器侧等待』语义，词表**收录为 waiting 的 chip 形**（同橙系待动作轴……不新增色相）」；实际 `base.css:751`（`.tag.dispatch-pending`，`--working` 黄）与 `base.css:2181`（`.tag.dispatched-flag`，`color: var(--working)`）双双黄相。
- 问题：按 §三矩阵 waiting=橙——一张「waiting 的 chip 形」渲染 working 相，正是纪律①禁止的 A 态 B 相；括号里「不新增色相」只回答了色相来源，没回答相态归属，条款内部打架。后续批照此过闸时无所适从。
- 建议：改文案为「机器侧等待=working 黄相的 chip 形（非 S3 waiting）」，或把两 chip 改 `--st-blocked` 橙。一字之差，过闸口径天壤之别。

### P2-B3 · 「借 working 保原观」让状态色 working 黄兼任全站装饰琥珀 token（18 处声明位），复 trap 已埋
- 证据：diff 中 `c.waiting→c.working` 的装饰/动作位改指共 18 处（md del、ImportPicker failT、NewSessionModal×2、RenameModal×2、SetupScreen×3、SettingsPage×4、detail-styles diffDel、DetailScreen KC img×2 + ripple×4）；theme.ts 注释自证 working 黄被用户调过色（1019 提亮提饱和，t25fix 还有一版 #E8B84B 废弃史）。
- 问题：这 18 处与运行态无关，但此后它们的外观与 working 状态色**单点耦合**——用户下次调工作灯黄（1019 先例证明会发生），18 处表单报错/删除武装/diff 删除线/图标轴静默漂移，正是本批自己在台账 §9「新发现」里点名的「token 同名异色静默改色陷阱」的下一代形态。本批零视觉变化的目标达成（改指保原观正确），但架构债以更大面积续期。
- 建议：后续批立装饰琥珀专用 token（如 `--amber-deco`，双主题定义一次），18 处一次性改指；词表 §二补一句「装饰琥珀不得引用六态 token」。

### P2-B4 · SetupScreen 连接点末档与 ListScreen 同态不同相（#357 劈叉）——与 A 审查 P2-2 交叉印证，B 独立实勘同结论
- 证据：`expo-app/src/screens/SetupScreen.tsx:471-472`（`connDotColor = connecting||reconnecting ? c.working : c.waiting`，末档 offline/连不上=橙，渲染位 `:779` connStatDot）vs `expo-app/src/screens/ListScreen.tsx:1426-1432`（本批已按 #357 归 `c.error` 红）。
- 问题：修前两处同为琥珀（都违 #357「连不上=红」），本批修一漏一，劈叉是新引入的端内不一致。若 leader 认 #357 为全局口径，升 P1。
- 建议：SetupScreen :472 末档对齐 `c.error`（一行）。

### P3-B1 · `.cc-badge.is-live`「第二黄收编」口径过满：规则本身是死规则，亮档字面量原样残留
- 证据：`base.css:3743`（暗档收编，但 `color: #fbbf24` 字面量作为静态兜底行保留在文件里）；`:3748`（`html[data-theme="light"] .cc-badge.is-live` 仍 `rgba(180,83,9,.12)/#b45309` 字面量，本批未动）；全仓 grep `is-live` 无任何 JS/HTML 消费面（死 CSS）。
- 问题：台账 §9「is-live 收编 --st-working（静态兜底行保留）」对暗档属实，但亮档另一黄字面量原封不动、且整条规则无消费面——「第二黄收编」的实际收益≈零，账面观感大于实效。
- 建议：亮档覆写行随批补收编或整条死规则退役；台账措辞降格为「死规则防复活对齐」。

### P3-B2 · 归红组两处语义/观感残缺点
- 证据：(a) `expo-app/src/screens/SetupScreen.tsx:423-426`——注释明书「配对失效=**红**」，`srvBadgeDead` 修前琥珀、本批改指 `c.working` 仍琥珀：按词表这是错误族状态位，注释与值自相矛盾被原样保留；(b) `expo-app/src/screens/DetailScreen.tsx:3065-3068`——停止/打断钮边框+文字本批归红（`stripBtnWarn`→`c.error`），ripple 却改指 `c.working` 琥珀（`:3068`），同一控件红边琥珀涟漪混色。
- 建议：(a) 随批把 srvBadgeDead 归 `c.error` 或订正注释（属于「注释明书红而 token 非红」同族 trap，本批修了 detail-styles 八处漏了这处同类）；(b) ripple 随边框归红或明示有意。

### P3-B3 · §三亮档注记不全：expo 暗档 error 与 web 异值未登记
- 证据：`expo-app/src/theme.ts:90`（暗 error `#F0524F`）vs `web-console/css/tokens.css` 暗 `--error: #E5484D`；词表 §三注记只列亮档 done/error 端上自调（#22A06B/#D63B3B），暗档 error 异值只字未提。色相同红合律①，但「三端同答案」对账面缺一行。
- 建议：§三注记补暗档 error 一句（或注明「error 暗档端上自调同亮档条款」）。

### P3-B4 · 六态展示词形漂移未被词表治理
- 证据：S3 一态在产品里同时存在「等你（词表定名）/待处理（web/mobile STATUS_TAG、bridge）/需要确认（expo ListScreen:1115）/待确认（expo DetailScreen:167）」四形；working 在 expo 详情舱叫「在跑」、error 叫「异常」、standby 叫「待开工」。§一「不得改名」若只指数据轴则应显式声明，若兼指展示词形则现网大面积「违表」。
- 建议：词表 §一补一行「展示词形白名单」或显式声明「本表只辖数据映射与色相，展示词另册」——现状两可，过闸时必生争议。

### P3-B5 · 范围边界未声明：设备/连接轴仍在旧语义档
- 证据：`settings-domain.js:1663/:1685/:1693/:1836/:1840`（设备「在线/离线」=`.tag done/无类`）、`:4578/:4805`（「等待对方确认/待配对」=`.tag action`）、`mobile.js:870`（relay 连接态 `done/action`）；`release-domain.js:43`（发布通道「进行中」=`.tag action` 橙——running 语义橙相，纪律①若按全称读即违例）。
- 问题：词表自限「会话/成员运行态轴」，设备在线/配对/发布进程是否入表未置一词——这些面视觉上与会话状态胶囊同形（`.tag`），用户无从知道它们「有意不同」。
- 建议：词表 §一或 §六补「轴外清单」（设备在线/配对/发布进程不入六态，沿用旧语义档），堵住后续审查反复争议。

### P3-B6 · 词表生效即静默改色的「正确但未登记」面
- 证据：theme.ts waiting 分相令以下语义正确位点静默琥珀→橙：`OrgZone.tsx:64`（orgStColor pending）、`OrgZone.tsx:168`、`page-head.tsx:125`、`DetailScreen.tsx:1436`（WAITING strip）、`DetailScreen.tsx:157`（详情灯 c.blocked 本就橙）；`SetupScreen.tsx:549`（unpaired 点）+ `:547` 注释仍写「琥珀未配对」（陈旧）。方向全部符合词表，但 §五落点表未登记这些「分相波及面」，后续对账时会当漏网误报。
- 建议：§五加一行「waiting 分相波及面全录（语义正确，零动作）」。

### P3-B7 · web 亮档 waiting 一态两橙 + st-closed 注释陈旧
- 证据：`tokens.css:265` 亮档 `--status-waiting-glow: rgba(192,91,51,.22)`=#C05B33 系，而亮档空心环/光圈 color-mix 引 `--st-blocked`=#E5895B——同一态同一主题两种橙档（黄有「两黄归一」法条，橙无对应立法）；`tokens.css:57` 注释「亮 #42587A」与亮档 `--faint` 实值 `#767676`（`:214`）不符（前置批遗留，恰在词表引用的 token 上）。
- 建议：glow 与环同引 --st-blocked 系一档；:57 注释顺手订正。

### P3-B8 · 探针两点（与 A 审查 P3-6 交叉）：切卡后 clip 不重算致 03/04 截图错位；探针纯观测无硬断言
- 证据：`relay/scripts/probe-statusvocab-shot.mjs:36-37`（inspClip 按 sv-work 算一次复用于三次截图）+ `:62`（`process.exit(0)` 恒真，胶囊类即使错了也只打印不红——它是截图对照工具非守卫，与 §六「机器锚=test:fc+blankset」口径一致，但易被误当闸）。
- 建议：切卡后重算 clip（一行）；探针输出加最小断言（cls 含 st-* 才 0 退出）防将来静默退化。

## 逐项核验（B 面通过项）

1. **规范↔实现正面清单**：`.tag.st-*` 五规则配方=member-state 同款（软底12%+同相描边32%+`--tag-border` 兜底，base.css:759-763 vs :2007-2010）✓；inspector-title `:not(.tag)` 改动必要且最小（sess 块 tag 确为末位子元素，session-domain.js:2854；probe 实测 text=token 色）✓；三 STATUS_TAG 全数 st-* ✓；bridge-core STATUS_TAG 确为零消费死图（全文件仅 ：680 一处）✓；光圈/halo 归位橙/黄 ✓；1014 灯本体（base.css:678/712-724）与 member-state 本体（:2006-2010）diff 零触碰=P2-3 复核属实 ✓；expo glyph ✶◉✓⚠ 在位（status-dock.ts:23）✓；expo 卡灯 standby 灰呼吸/ListScreen:1007-1008、waiting 橙实点/statusColor→c.waiting ✓；updated-at 三端守卫逐 token 同体（store.ts:268-275 ≡ session-domain.js:954-961）✓。
2. **替换面**：三处点名的 STATUS_TAG 乱面确已收敛（probe 实跑 exit 0：working 胶囊 `tag st-working` text=#FFD24D、waiting `st-waiting`=#E5895B、六卡灯黄/灰/橙环/绿/红各归位）✓；残留乱面即上文 P1-1（vrow/pc3-dot）、P2-B4、P3-B5（与 A 的 P2-1 settings-domain 首屏占位 info 蓝互为补充——A 已立案，B 不另立）。
3. **过度替换**：18 处琥珀改指逐一判定为装饰/动作位（表单报错、删除武装、diff 删除线、图标轴、ripple）保原观正确，无误伤运行态位；归红组与各自注释明书的红一致（detail-styles:155/:190 注释实证）✓；残缺点见 P3-B2。
4. **用户定版本体**：1014 五色灯 status-dot 本体、member-state 胶囊（DEV-30 P2-3 定版）零触碰 ✓；被改的光圈/halo 属 B3-19 附加层且改向与 1014 橙相**一致**（纠偏非侵犯）✓。
5. **expo↔web 同答案**：暗档 working #FFD24D/waiting #E5895B/done #35DC97 全同 ✓；亮档 working #FFB020 同、done/error 端上自调已注 ✓；亮档 waiting #C05B33 vs #E5895B 同相异值（A P3-6 已注，B 补充：web 亮档内部 glow 与环也两橙，见 P3-B7）。
6. **销项真实性**：l02=真（probe 断言②实拍+computed）；P2-7=成文属实（§四即为销项载体）；P2-3 复核=真（本体未动+配方升全局）；updated-at-writers「74 项」与实测 PASS 74/74 精确一致 ✓。
7. **机器面复跑（本机，env -u CCR_ORG_DIR -u CCR_DATA_DIR）**：test:fc 137 ok/0 FAIL；test:teampolish 46/0；test-updated-at-guard PASS 74/0；test:005-blankset 9 passed/2 failed（B1② 81 裸奔/B1③ 8 缺兜底=基线同签名，B 以 `git show` 提取 24c84bca 基线独立重算：total 188→200、bare 81→81、shadowBare 8→8，本批 12 条新增 color-mix 全双写恒等——与 A 新发现-8 交叉印证：该闸基线即红，本批零新增）；expo `tsc --noEmit` src/ 零错误（22 个错误全在 scripts/test-*.ts 既有 node 类型缺失，非本批文件）；probe-statusvocab-shot 实跑 DONE（96e850e1 轮询修复生效）。

## 结论

**退回**（P0=0，P1=1；P1 清障后可过）。

- **P1-1（必清）**：词表纪律①与项目域 vrow 绿「运行中」徽章 / 离线橙徽章 / pc3-dot 蓝红点轴正面冲突且未豁免登记——代码收敛（小改）或规范豁免（成文）二选一，同时订正台账 §9 措辞。这是规范符合性审查的闸门项：过闸规范落地第一天即存在自身管辖面内的活体违例，不能带着过闸。
- **P2 组（随批修或入单，不单独阻塞）**：P2-B1 working-glow 绿值、P2-B2 §四 chip 例外自相矛盾、P2-B3 装饰琥珀 token 架构债、P2-B4 SetupScreen #357 劈叉（与 A P2-2 同点，若 leader 认 #357 全局口径则升 P1）。
- **P3 组（记录在案，后续批顺手）**：P3-B1～B8。
- 其余全部核实通过：R4 守卫三端同体+74/74 锚绿、三 STATUS_TAG 收敛+probe 实证、st-* 族配方正确、定版本体零侵犯、B1② 双写恒等（81=81/8=8 独立重算）、销项三件全部属实。

---

## 返修处置（deck-fixer-1，2026-11-28 同 run 闸内闭环）

- **P1-1（长页徽章/pc3-dot 与纪律①冲突）**：✅ 双轨修——①词面承载面收敛：`.cc-badge.is-run`「运行中」绿→黄（S1，rgba 静态族+亮档覆写，computed 双主题实证 rgba(255,210,77,.16)/#b45309）；离线徽章 is-warn 橙→is-neutral 灰（S6）。②非词面轴豁免登记：pc3-dot 聚合点轴（注意力优先级，A2 三态）入词表 §四 豁免登记，改色需设计变更单。台账 §9 措辞同步订正（「检查器/手机两乱面」收敛记录＋返修收敛行分列，绿「运行中」清零属实）。
- **P2 working-glow 绿残留**：✅ 随批修——双主题黄化 rgba(255,210,77,.5)/rgba(255,176,32,.3)（computed 实证），§一「⑂借黄呼吸」名实归一；test:fc DEV40R-5 锚。
- **P2 §四 dispatch chip 例外自相矛盾**：✅ 文本订正——重分类为 S2 standby 的 chip 形＋W-DISPVIS C2 定版视觉豁免登记（黄相保留属登记在案豁免，统一走设计变更单）。
- **P2 装饰位与状态黄耦合（架构债）/SetupScreen 劈叉/首屏占位**：SetupScreen 与首屏占位随批修（见审查 A 回执处置节）；耦合债入「新发现」不扩战线。
- 机器锚：test:fc 新增 DEV40R-1~5（五面防复活）；复跑 fc 142/0、teampolish 46/0、guard 74/74、expo tsc src 0 错。
