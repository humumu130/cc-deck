# cc-deck 品牌色使用审计（brand-color-audit）

> 2026-09-20 ｜ 依据用户原则：「UI 方面要避免滥用品牌色」
> 方法：静态盘点（三端 grep 全部橙系 HEX/rgba + 品牌变量消费链）+ 动态审查（本地静态 server + Playwright 双主题截图，外网/WS 全断，未触任何 relay）。
> 红线遵守：未改任何代码/页面；仅按任务指示在截图时切换 `html.light` 类。
> 行号口径：`web-console/index.html` 行号基于 2026-09-20 13:45 快照（审计期间有并发会话插入 4 行非橙 CSS，≥1195 区段行号可能再漂移，**定位以选择器为准**）。

---

## 1. 总览统计

| 端 | 使用处（去重） | A 品牌必要 | B 功能借用 | C 装饰滥用/治理 | 原始引用 |
|---|---|---|---|---|---|
| web-console/index.html | 69 | 13 | 52 | 4 | 橙系直接色值 51 行（含 5 行注释、11 行变量定义）+ 品牌变量消费 60 处（--brand 43 / --gp-accent 8 / --grad 4 / --brand-2 3 / --brand-line 3 等） |
| expo-app/src/** | 7 | 6 | 1 | 0 | 橙系 HEX 9 行（theme.ts 4、各屏 5） |
| desktop-tauri/src-tauri | 0 | — | — | — | main.rs 纯壳层，无 UI 用色 |
| **合计** | **76** | **19 (25%)** | **53 (70%)** | **4 (5%)** | — |

结论一句话：#98/#13/#48 等前序收敛后，**大面积橙底已基本清零**，剩余问题集中在「转录/浮层里高频重复的小面积橙」与「两处背景光晕」。B 类占七成，其中建议收敛的重点 10 处、低优先（hover/微标类，可不动）约 24 处。

分类标准：
- **A 品牌必要**：logo、主操作按钮（FAB ＋/发送 ➤/primary/wizGo）、已定案的细线选中态（#98 选中卡、#13 tab 线、设置抽屉选中形制）——保留。
- **B 功能借用**：用橙表达「选中/注意/可点/加载」等状态语义——候选收敛（换中性或语义色）。
- **C 装饰滥用/治理**：大面积装饰或色值治理问题——收敛重点。

状态色语义红线（不可侵占）：红=WAITING、橙红=ERROR、黄=WORKING、绿=DONE。

---

## 2. 品牌橙色值谱系（先看这个：产品里现存 8 种橙）

| 色值 | 角色 | 位置 |
|---|---|---|
| `#D97757` | 主橙：--brand（暗色文字/实底档） | index.html:33；expo ORANGE/fabPlus/sendFg/LogoMark/PlusMark/SRV_COLORS |
| `#C96442` | 暗调变体：--brand-2、渐变深端 | :34、:40；rgba(201,100,66,x) 光晕/边 |
| `#E8985F` | 渐变亮端 | :40、logo SVG ×2 |
| `#C2603E` | 浅色文字档：--brand/--sel-line/--gp-accent(浅) | :80、:107、:375 |
| `#A04E30` | 浅色 --brand-2 | :82 |
| `#E07B4C` | 浅色线条档：--brand-line | :84 |
| `#F1844F` | **第三种橙**：gearPop 暗 --gp-accent + 营销页 site --brand | :361；site/assets/style.css:15 |
| `#E69070` | app 渐变亮端（ORANGE_HI） | SetupScreen.tsx:40 |

治理判断：暗色线条/强调需要提亮档是合理的（#E07B4C 的存在理由），但 `#F1844F` 与 `#E07B4C` 是两个互相独立的「提亮橙」，且 gearPop 自带一套 8 变量局部 token 脱离全应用变量链。**建议 --gp-accent 直接改引用全局变量**（见 §5 治理项 6），营销页是否跟随由用户定夺（见 §6 范围外）。

---

## 3. 逐处清单

### 3.1 web-console / index.html（69 处）

#### 全局与侧栏

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 1 | 134-135 | `body` 背景 | 双层品牌辐射光晕（rgba(217,119,87,.04)/rgba(201,100,66,.03)） | **C** | **删除**。#78 后 #side/--bg-main 均为不透明层，body 光晕被完全遮盖，是死层（#98 减半后更是不可见） |
| 2 | 328-338 | `.sfab`（＋新建） | 默认半透明橙底+橙图标+橙描边，hover 橙实底 | **A** | 保留（#54 定案的降噪形态） |
| 3 | 328-338 | `.sfab`（⚙ 设置） | 同上 | B | 设置是导航不是主操作：可改 `background: var(--panel-2); border-color: var(--border); color: var(--dim)`，仅 ＋ 保品牌。低优先 |
| 4 | 1998 | header `.logo` SVG | 渐变 logo | **A** | 保留 |
| 5 | 2322 | 空态/关于 `.logo` SVG | 渐变 logo | **A** | 保留 |
| 6 | 1048 | `#sideGrip:hover, body.side-drag` | 拖拽热区橙 25% 底 | B | 换 `var(--hov)`（拖拽是功能反馈非品牌） |
| 7 | 1022 | `#srcChips button.on` | 源过滤选中 chip：橙 12% 底+橙 60% 边 | B | 源身份已是蓝系（SRC_COLORS），选中底可换 `var(--hov)`+`color: var(--text)`；或保现状（面积小）。中低 |
| 8 | 1084 | `.hbtn.on` | 列表工具 chips（折叠/密度）选中：橙字橙边 | B | 换 `color: var(--text-strong); border-color: var(--border)`。中 |
| 9 | 1156 | `.card.sel` | 选中卡 --sel-line 描边+1px 环（辉光已 #98 中性化） | **A** | 保留（#98 定案） |
| 10 | 1189 | `.his-badge.ext` | 「外部会话」徽章：橙字橙边 | B | 换中性：`color: var(--dim); border-color: var(--border)`（类别标签非品牌）。中 |
| 11 | 1214 | `.pin-flag` | pinned 锚形小图标橙 | B | 可换 `var(--dim)`；11px 小图标，低 |
| 12 | 1218 | `.card.dormant:hover` | 休眠卡 hover 橙 40% 边 | B | 换 `var(--hov)`。低 |

#### 表单与按钮

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 13 | 731 | `button.primary`（创建会话/连接/添加直连 ×3 DOM） | 橙渐变实底+橙 30% 投影 | **A** | 保留渐变底；投影 `rgba(217,119,87,.3)` 可中性化 `rgba(0,0,0,.3)`（对齐 #98 --sel-shadow 思路）。低 |
| 14 | 686 | `#emptyNewBtn` | 空态 CTA 渐变+橙 28% 投影 | **A** | 同上：投影中性化。低 |
| 15 | 763 | `.seg button.on`（活例 #newSrcSeg 多源新建选择器 :2051） | 选中段=橙渐变整块填充 | B | **全应用唯一残留的「渐变填充选中态」**（gearPop 内已被卡片式覆盖）。建议对齐 chips 语言：`background: rgba(217,119,87,.12); border-color: rgba(217,119,87,.55); color: var(--text)`，或中性 `var(--hov)`。中 |
| 16 | 744 | `input/textarea:focus` | 全局输入聚焦：橙描边+3px 橙 15% 晕 | B | **保留候选**：单强调色体系里 focus=品牌是常见正解且是 a11y 资产。若要收敛：`border-color: var(--brand-line); box-shadow: 0 0 0 3px rgba(217,119,87,.10)` |
| 17 | 1775-1776 | `#inputcard:focus-within` | 主输入卡聚焦：橙描边+双层橙晕（.22 外环 + .12 大光晕） | B | 保留描边；删第二层 `0 2px 18px rgba(217,119,87,.12)`（18px 扩散偏大）。中 |

#### 向导与弹层

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 18 | 900 | `#wizCode:focus` | 向导码框聚焦橙 | B | 同 #16 |
| 19 | 903 | `#wizGo` | 向导主按钮橙实底 | **A** | 保留 |
| 20 | 918 | `.wiz-opt.reco` | 推荐项橙描边 | B | 「推荐」是评价语义：可换 `var(--text-strong)` 边+`.wiz-tag` 同步。低 |
| 21 | 924-925 | `.wiz-tag` | 「推荐」小徽章橙字橙边 | B | 同上。低 |
| 22 | 265-266 | `.mp-row.cur/.mp-cur` | 模型弹层当前项橙字 | B | 选中态：换 `var(--text-strong)` + 现有 ✓ 即可。中 |
| 23 | 278-283 | `.pp-row.cur` 系列 | 权限弹层当前项：橙 10% 底+橙字 ×3 | B | 同上（#40 手机端已走中性 tint 口径，web 可对齐）。中 |
| 24 | 306 | `.sp-manage` | 「管理服务器…」橙字链接 | B | 换 `var(--dim)` + hover `var(--text)`。低 |
| 25 | 868 | `.tp-no` | 任务气泡 #NNN 橙字 | B | 换 `var(--text-strong)`。低 |
| 26 | 876 | `.tp-link` | 任务气泡「查看」橙字 | B | 同上。低 |

#### 连接与设置抽屉（gearPop）

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 27 | 808 | `#pairCode:focus` | 配对码框聚焦橙 | B | 注意：同抽屉内 gearPop 表单输入聚焦走 --gp-accent（#33），此处走 --brand，两套并存——随治理项 6 一并统一 |
| 28 | 944 | `.srv-row.active` | 活动源橙边+1px 橙环 | **A** | 保留（选中态细线） |
| 29 | 978 | `.srv-share:hover` | 分享钮 hover 橙 | B | 换 `var(--hov)`/`var(--text)`。低 |
| 30 | 1010 | `.srv-retry:hover` | 重试钮 hover 橙 | B | 同上。低 |
| 31 | 797 | `.pd-adv-toggle:hover .pd-adv-t` | 高级选项 hover 橙字 | B | 换 `var(--text)`。低（gearPop 版 #40 同） |
| 32 | 532 | `#gearPop .conn-form input:focus` | 抽屉表单聚焦（--gp-accent+rgba(241,132,79,.16) 晕） | B | 随治理项 6 统一为全局变量 |
| 33 | 614 | `.gp-code-cells.on i` | 配对码已填格橙 40% 边 | B | 面积小可保留；或 `var(--dim)`。低 |
| 34 | 400 | `.gp-nav-item.on::before` | 左缘 3px 橙标识条 | **A** | 保留（设计稿 §7 定案） |
| 35 | 455 | `.gp-hk.rec` | 快捷键录制态橙闪烁 | B | 录制=注意语义，可换 `var(--waiting)`；低 |
| 36 | 490 | `.gp-retry:hover` | 抽屉重试钮 hover 橙 | B | 同 #30。低 |
| 37 | 504 | `#gearPop .srv-row.active` | 同 #28 | **A** | 保留 |
| 38 | 523+528 | `#gearPop .seg button.on`（+✓ 圆） | 连接方式选中：橙边+左橙条+橙 ✓ 圆 | **A** | 保留（设计稿卡片式选中形制） |
| 39 | 538 | `#gearPop .pd-adv-toggle:hover` | 同 #31 | B | 低 |
| 40 | 660 | `.lever-opt.on` | 非 gp 版选中橙字——**死规则**（全部 lever 实例都在 gearPop 内，恒被 :666 覆盖） | **C** | 删除该行 |
| 41 | 666 | `#gearPop .lever-opt.on` | 拨杆选中档橙字 | B | 换 `var(--gp-text)`+600 即可（11px 小字）。低 |
| 42 | 361/375/455 | `--gp-accent` 定义（#F1844F/#C2603E/fallback） | 抽屉独立第三种橙 | **C** | 见 §5 治理项 6：改 `var(--brand-line)`/`var(--brand)` 引用 |

#### 详情页

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 43 | 1500-1501 | `#detail` 背景 | 双层品牌辐射光晕（rgba(217,119,87,.08)/rgba(201,100,66,.05)）——#98 减半后仍为 body 版两倍 | **C** | **收敛重点①**：删两层回到纯 `var(--bg-main)`；或至少再减半至 .04/.03。内容区右上半屏常驻暖橙雾，是现存最大面积品牌色 |
| 44 | 1544 | `.tab-ind` | tab 下划线 --brand-line | **A** | 保留（#13 定案） |
| 45 | 1551 | `.tabs button.mini.on` | 权限/上下文 mini chips 选中橙 | B | 同 #8。中 |
| 46 | 1290 | `#todoRefresh.wait` | 任务刷新等待态橙字橙边 | B | 加载语义：可换 `var(--dim)` 旋转。低 |
| 47 | 1375 | `.todo-item.flash` | 任务项变更闪橙 14% 底 | B | 瞬态提醒，可保留；或 `var(--hov)`。低 |
| 48 | 1313 | `.task-ref` | 转录 #NNN 任务号橙字加粗 | B | 高频出现在长转录：换 `var(--text-strong)`+700+下划线 hover。中 |
| 49 | 1316 | `.fpath` | 转录文件路径橙字（每条工具输出常驻） | B | **收敛重点②的一部分**：换 `var(--dim)` + hover 下划线（可点性由 cursor+underline 表达）。中高 |
| 50 | 1578 | `#waitbox.ask` | 提问卡橙 35% 描边 | B | **保留候选**（#14 定案「品牌轻描边」区分提问/审批两态）。若收敛换 `var(--hov)` |
| 51 | 1595 | `.q-item .q-header` | 提问小节标 --brand-2 橙字 | B | 换 `var(--dim)`+letter-spacing（小节标题无需品牌）。中 |
| 52 | 1608-1610 | `.q-opts button.sel` 系列 | 提问选项选中：橙 12% 底+橙 55% 边+橙标记+橙字 | B | 选中语义：可中性化（`var(--hov)` 底+`var(--text-strong)` 字+中性填充标记），与 #98 选中卡口径一致。中 |

#### 转录（时间线）

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 53 | 1644+1647 | `.msg-ai .ai-ava` | 每条 AI 消息 28px 橙渐变头像 + 橙 30% 投影 | B | **收敛重点③**：`background: var(--panel-2); color: var(--dim); box-shadow: none`（✻ glyph 保留）；或至少删投影。长转录里橙圆成列，是最高频的品牌重复 |
| 54 | 1653 | `.copy-btn` | 命令行复制钮橙字（hover 显现，每条命令行一枚） | B | **收敛重点②**：换 `var(--dim)`。中高 |
| 55 | 1677 | `.tname` | 工具名 --brand-2 橙加粗——**每条工具行常驻** | B | **收敛重点②之首**：`color: var(--dim); font-weight: 600`。工具行是转录里行数最多的元素，此一处贡献了转录区绝大部分橙 |
| 56 | 1692 | `.x-full` | 「展开全文」橙字 | B | 换 `var(--dim)` + hover 下划线。中 |
| 57 | 1738 | `.txt.md a` | Markdown 链接橙 | B | **保留候选**（链接=单强调色体系正统用法）；但与手机端不一致，见 §6 跨端差异，需用户拍板 |
| 58 | 1742 | `.md-code-wrap:hover .md-code` | 代码块 hover 橙边 | B | 换 `var(--hov)`。低 |
| 59 | 1749 | `.md-quote` | 引用块橙左条 | B | 换 `var(--border)`。低 |

#### 输入区与浮层

| # | 行号 | 选择器/组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 60 | 1844+1847 | `#sendBtn` | 发送 ➤ 橙 + hover --brand-line 边 | **A** | 保留（#48 定案） |
| 61 | 1795 | `#toBottomBtn:hover` | 回底钮 hover 橙边 | B | 换 `var(--hov)`。低 |
| 62 | 1102+1107 | `.cf-btn` | [待确认] 44px 常驻浮钮：橙 55% 边+橙字+hover 橙 90% 边 | B | **收敛重点④**：`border-color: var(--border); color: var(--text-strong)`（数字加粗保持醒目）；「待确认」是注意语义贴近 WAITING，不应占品牌色 |
| 63 | 1115 | `.cf-title` | 待确认标题橙字 | B | 换 `var(--text-strong)`。中 |
| 64 | 1117+1120 | `.cf-all` | 「全部已读」橙 14% 底橙边橙字 | B | 换 `background: var(--hov); border-color: var(--border); color: var(--text-strong)`。中 |
| 65 | 1128 | `.cf-row:hover` | 待确认行 hover 橙 10% 底 | B | 换 `var(--hov)`。中 |
| 66 | 1130 | `.cf-ref` | 待确认行 #NNN 橙字 | B | 换 `var(--text-strong)`。中 |
| 67 | 1132 | `.cf-x:hover` | 已读 ✕ hover 橙 12% 底 | B | 换 `var(--hov)`。中 |
| 68 | 1930-1933 | `#undoBar .ub-btn` | 删除撤销条动作钮：橙 14% 底+橙 40% 边+橙字 | B | **收敛重点⑤**：`background: var(--hov); border-color: var(--border); color: var(--text-strong)`。「撤销」是普通动作 |
| 69 | 1949 | `#noteBar .nb-ico` | USER_NOTE 通知图标橙 | B | 换 `var(--dim)`。低 |

（web 合计 69 行：A 13 / B 52 / C 4，与 §1 一致。）

### 3.2 expo-app / src（7 处）

| # | 文件:行 | 组件 | 用途 | 分类 | 建议 |
|---|---|---|---|---|---|
| 1 | theme.ts:51,80 | `fabPlus`（两主题） | FAB ＋ 十字橙 | **A** | 保留（#23/#48 定案） |
| 2 | theme.ts:55,83 | `sendFg`（两主题） | 发送 ➤ 橙 | **A** | 保留 |
| 3 | brand.tsx:5 | `LogoMark` 默认色 | logo | **A** | 保留 |
| 4 | ListScreen.tsx:96 | `PlusMark` 默认色 | FAB glyph | **A** | 保留 |
| 5 | SetupScreen.tsx:39,40,469 | 扫一扫 hero 渐变（#E69070→#D97757） | 主入口按钮 | **A** | 保留 |
| 6 | SetupScreen.tsx:39,40,684 | 保存栏渐变 | 主操作按钮 | **A** | 保留 |
| 7 | SettingsDrawer.tsx:61 | `SRV_COLORS` 首色 #D97757 | 服务器身份色点色板 | B | **对齐 SRC_COLORS 五色池** `["#2FBEDA","#5C94F5","#665AD8","#B886DF","#CD51C8"]`。现池还含 #2BD98F（撞 DONE 绿）、#FBBF24（撞 WORKING 黄），同时违反 #98 三条拍板（避状态色/池内 ≥25°/不占品牌橙）。web 侧同概念池已按 #98 清过，app 此池漏改，且 index.html:4136 注释「与手机端逐字节对齐」已失真 |

注：theme.ts 的 `brandA/brandB`（#4D9FFF/#7C6CF2、#2F7FE8/#6F5FE8）是**蓝紫系**命名撞车，不是橙系品牌色，不在本审计收敛范围；但其消费面（链接/选中/勾选框等 ~30 处）承担了 app 端「强调色」角色，是 app 橙用量天生就少的根因，也是两端链接色不一致的来源（§6）。

### 3.3 desktop-tauri / main.rs（0 处）

纯壳层（导航拦截/内嵌 relay/托盘/更新），无 UI 用色。✅

---

## 4. 动态审查记录（截图证据）

截图存于 `/tmp/brand-audit-*.png`（2x DPR，1440×900 视口；本地 http.server + 全外网/WS 断连）：

| 文件 | 内容 | 观察 |
|---|---|---|
| `01-wizard-dark.png` | 首启向导（暗） | 橙=实底「连接」钮+推荐项描边+「推荐」徽章，密度合理 |
| `02-list-empty-dark.png` | 会话列表空态（暗） | 橙=header logo、空态大 logo、渐变 CTA、双 FAB；右下角可见 detail 光晕的暖色渐染 |
| `03-newform-dark.png` / `09/11-*-zoom-dark.png` | 新建表单+聚焦（暗） | 「创建会话」primary 渐变正常；textarea 聚焦橙描边+3px 橙晕清晰 |
| `04-settings-conn-dark.png` | 设置-连接（暗） | 橙全部为细线/小圆点：nav 左缘 3px 条、seg 选中边+✓ 圆、活动源 1px 环、「＋添加服务器」链接。抽屉「不泛橙」纪律执行良好 |
| `05-settings-disp-dark.png` | 设置-显示（暗） | 仅 lever 选中档橙字，密度极低 ✅ |
| `06-settings-about-dark.png` | 设置-关于（暗） | 仅 LogoMark 一处橙 ✅ |
| `07-settings-conn-light.png` | 设置-连接（浅） | 浅色 #C2603E 档在线条上观感沉稳，无「红脏」（#13 巡检成果保持） |
| `08-list-empty-light.png` | 会话列表空态（浅） | body 光晕在浅色下不可见（#98 alpha 减半后趋零）；CTA 渐变+橙投影是浅色空态最大橙块 |

动态结论：可直达的界面里没有发现新的大面积橙（侧栏/抽屉纪律好）；**视觉重量最大的两处都在「数据态」**——详情页内容区光晕（有会话时常驻）与转录高频橙字（.tname/.ai-ava/.fpath/.copy-btn，需会话数据，本审计以静态口径认定，见清单 #43/#49/#53-55）。详情页各 tab（输出物/任务面板）同因无 relay 未能动态截取，以静态清单覆盖。

---

## 5. Top 5 收敛方案（按 面积×频率 排序，全部给到具体动作）

1. **#detail 内容区双层品牌光晕 + body 死层光晕**（#43、#1；index.html:1500-1501、134-135）
   动作：删 body 两层（死代码零风险）；#detail 删两层或减半至 `.04/.03`。这是现存最大面积常驻品牌色（详情页右上半屏暖橙雾）。

2. **转录高频橙字三件套**（#55、#54、#56、#49；:1677/:1653/:1692/:1316）
   动作：`.tname { color: var(--dim); font-weight: 600 }`；`.copy-btn { color: var(--dim) }`；`.x-full { color: var(--dim) }`；`.fpath { color: var(--dim) }`（hover 下划线保留可点暗示）。四处一行改动，转录区橙字量立减约八成。

3. **.ai-ava 渐变头像**（#53；:1644-1647）
   动作：`background: var(--panel-2); color: var(--dim); box-shadow: none`（✻ 保留）；保守版=仅删橙投影。每条 AI 消息一枚 28px 橙圆，长对话成列。

4. **#confirmFloat 待确认浮钮家族**（#62-67；:1100-1133，7 条规则）
   动作：cf-btn/cf-title/cf-ref → `var(--text-strong)`，边框 `var(--border)`；cf-all/cf-row hover/cf-x hover → `var(--hov)` 系。「待确认」语义贴 WAITING，右下 44px 常驻橙钮是最大的功能性借橙。

5. **#undoBar 撤销钮**（#68；:1929-1933）
   动作：`background: var(--hov); border-color: var(--border); color: var(--text-strong)`。

顺位 6-8（治理项，非面积但值得做）：

6. **--gp-accent 统一**（:361/:375/:455 及 :532/:614 rgba 变体）：`--gp-accent: var(--brand-line)`（暗）/`var(--brand)`（浅）或直接全局变量，消灭第三种橙 #F1844F，#pairCode 聚焦（:808）一并归队。
7. **SRV_COLORS 对齐 SRC_COLORS**（SettingsDrawer.tsx:61）：换五色池，同步修 index.html:4136 已失真的「逐字节对齐」注释。
8. **newSrcSeg 渐变填充选中**（:763，活例 :2051）：对齐 #srcChips 选中语言（12% 底+55% 边+text 字）或中性 chip，消灭全应用最后一处整块渐变选中态。

**保留白名单（A，明确不动）**：header/空态 logo、＋FAB、button.primary×3、#wizGo、#emptyNewBtn、#sendBtn ➤、.card.sel 与 .srv-row.active 细线选中（#98）、gp-nav 左缘条/gp-seg 卡片选中、.tab-ind（#13）。
**焦点环专题**（#16/#17/#18/#27/#32）：定性「借用但保留」——单强调色体系下 focus=品牌是正解且属 a11y 资产；仅建议 #17 的 18px 第二层橙晕删除。

---

## 6. 跨端差异与范围外发现（供拍板，不自动执行）

1. **链接色两端相反**：web 转录链接=品牌橙（.txt.md a:1738），手机 md.tsx=brandA 蓝（md.tsx:333）。同一内容两端异色。二选一：web 链接改蓝系（引入第二强调色，但与 app 一致）或 app 链接改橙（与 app 现行「橙仅 FAB/发送/logo」纪律冲突）。**建议维持 web 橙、app 蓝各自现状，把「链接色」记为两端各自体系的既定差异**；若要统一需用户拍板。
2. **营销页第三品牌**：`web-console/site/assets/style.css`（下载主页）自成体系用 #F1844F（≈29 处含大量光晕/热投影）。营销页用色大胆属常规，但色值与产品主橙不一致；如需统一，全局替换 `#F1844F/rgba(241,132,79,` 为 #D97757/rgba(217,119,87, 即可（纯色值替换，结构不动）。
3. **theme.ts brandA/brandB 命名**：蓝紫系顶着 "brand" 名，与橙系品牌语义相撞，建议后续任务改名为 accentA/accentB（本审计不动代码）。
4. **并发说明**：审计期间 index.html 被另一会话插入 4 行非橙 CSS（1195-1290 区段），本文行号已按 13:45 快照校正；引用时以选择器为准。

---

## 7. 审计方法与可复现

- 静态：`grep -i 'D97757|E8985F|C96442|E07B4C|C2603E|F1844F|E69070|217,119,87|201,100,66|241,132,79'` 三端 + 变量消费链（var(--brand*)/--grad/--gp-accent/--sel-*）逐一回读上下文归类。
- 动态：`python3 -m http.server 8931 --bind 127.0.0.1 --directory web-console` + Playwright（Chrome 145，--no-proxy-server），context.route 全量拦截非 127.0.0.1 请求 + routeWebSocket 全断——未连接任何 relay（含公共桥）。
- 局限：详情页数据态（转录/输出物 tab/任务面板/待确认浮钮/撤销条）无法无 relay 呈现，该部分结论来自静态代码 + 既有 #98/#13 巡检先例，置信度高但未截图佐证；如需补证可在本地测试 relay 环境重跑 `/tmp/brand-audit-shots.mjs`。
