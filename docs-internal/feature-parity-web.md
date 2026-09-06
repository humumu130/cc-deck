# 网页端功能对齐清单（安卓 App vs web-console）

> 2026-09-06 依据 #279 调研产出。对照对象：`expo-app/src/screens/`（手机端，领先）↔ `web-console/index.html`（2824 行单文件，滞后）。
> 桌面壳 `desktop/main.js` 直接加载 web-console/index.html（loadFile），**改网页即桌面同受益**，下文不再逐项重复；wear-app 为独立代码库，不直接受益（个别项手表端另有同款实现，单独标注）。
> 协议侧核对结论：relay 命令面（`relay/src/ws-server.ts` COMMAND_TYPES L21-38）已含 COMMAND_DELETE / COMMAND_TODO_HIDE / COMMAND_MESSAGE.images / 历史会话 resume（`session-manager.ts` L485-499、L857-875）——下列缺失项**均无需动 relay**，只补网页 UI。

## 一、汇总表（16 项候选 + 5 项额外发现）

| # | 功能 | 网页端 | 难度 | 价值 | 建议 |
|---|------|--------|------|------|------|
| ④ | 转录 #NNN 任务号点击跳任务定位（#264） | **缺失** | S | 高 | **批次 1** |
| ⑤ | 任务面板治理：已完成 24h 窗口封顶 15 条 + 条目 ✕ 隐藏 + active_form | **缺失** | S | 高 | **批次 1** |
| E | 列表排序对齐（活跃置顶 + updated_at 倒序） | 部分（口径不同） | S | 中高 | **批次 1** |
| ① | 会话删除 + 4s 撤销条（#247） | **缺失**（删除本身都没有） | M | 高 | **批次 2** |
| A | 图片发送（选图/粘贴截图 → COMMAND_MESSAGE.images） | **缺失** | M | 高 | **批次 3** |
| B | 历史会话 resume 续聊（relay_session_id） | **缺失**（且文案误导"仅可查看"） | S | 中高 | **批次 3** |
| ⑦ | ctx 水位条：窄屏（≤720px）详情页缺口 | 部分（桌面已够用） | S | 中 | 批次 4 |
| ⑨ | 会话卡紧凑模式（+折叠空闲） | **缺失** | S | 中 | 批次 4 |
| ③ | tab 指示条动效 + 键盘 ←/→ 切页 | 部分（有点击切换+淡入） | S | 中低 | 批次 4 |
| ⑪ | 展开全文/思考块折叠动画 | **缺失**（直接重排） | S | 中低 | 批次 4 |
| ⑮ | 任务 tab 手动刷新等待态（todoSpin） | 部分（↻ 已有） | S | 低 | 批次 4 |
| C | 过程消息三档（紧凑/标准/隐藏） | 部分（tab 过滤已覆盖主诉求） | S | 低 | 候补 |
| D | 列表卡 WORKING 实时行（回合耗时+↓输出 tokens 走秒） | 部分（耗时已走秒） | S | 低 | 候补 |
| H | 详情工具区整体折叠（▲/▼） | **缺失** | S | 低 | 候补 |
| ② | 列表底部上滑更新（#255） | 缺失但**不建议移植** | — | 低 | 不做 |
| ⑥ | 子 Agent 状态块（subagents） | ✅ 已有 | — | — | 无 |
| ⑫ | 排队消息显示（pending_inputs） | ✅ 已有 | — | — | 无 |
| ⑬ | 外部 CLI 排队注入提示 | ✅ 已有 | — | — | 无 |
| ⑭ | 跨天分隔线 | ✅ 已有 | — | — | 无 |
| ⑯ | AskUserQuestion 作答横幅 | ✅ 已有（与手机同构） | — | — | 无 |
| ⑧ | 语音输入 | 跳过（按任务约定） | — | — | 候补（Web Speech API） |
| ⑩ | 左滑重命名/删除手势 | 重命名已有；删除并入① | — | — | 形态换 hover 按钮 |

**建议实施批次**（价值×难度，每批一次交付 + 3agent 审查）：

1. **批次 1｜任务面板闭环**（全纯渲染层，零协议改动）：④ #NNN 跳转 + ⑤ 任务治理 + E 排序对齐。三者都落在 `render()/todosTabHtml()/entryHtml()`，一批做完互不冲突。
2. **批次 2｜删除闭环**：① hover 🗑 + 底部撤销浮条（复用 taskDone 浮窗动效语言）。
3. **批次 3｜输入能力**：A 图片发送（桌面粘贴截图高频）+ B 历史会话续聊。
4. **批次 4｜体验打磨**（可再按 UI 微任务批制拆分提交）：⑦ 窄屏 ctx、⑨ 紧凑列表、③ tab 动效、⑪ 折叠动画、⑮ todoSpin。
5. **明确不移植**（网页范式下无意义/已有更优形态）：⑤的自绘滑块（网页原生 ::-webkit-scrollbar 可见，index.html L605-607）、②上滑更新（WS 实时推送 + F5 已覆盖）、⑩左滑手势（hover 按钮更符合鼠标范式）、长按复制/分享（浏览器原生文本选择+右键已覆盖）、手机左缘右滑呼出抽屉（网页侧栏常驻）。

---

## 二、每项详情

### ① 会话删除 + 4s 撤销条（#247）——缺失【批次 2，M，价值高】

- **手机**：`ListScreen.tsx` SwipeRow 左滑露出删除（L109-198）；`requestDelete` 点删只隐藏卡片，4s 后才真发 COMMAND_DELETE（L368-418）；`UndoBar` 撤销浮条（L202-242，spring 上滑入场）；提交后 `deleting[]` 保持隐藏至 SESSION_DELETED，3s 兜底出列（L379-384）；别处已删终结挂起删除防误报（L387-400）。
- **网页**：全文无 COMMAND_DELETE 调用（仅 deleteServer 删源，L2404-2419）；卡片 hover 只有 ✎ 重命名（L266-272、L1818）。
- **形态适配**：不做左滑。卡片 hover 时 ✎ 旁加 🗑（opacity 过渡与 ✎ 同款）；删除后底部弹撤销条（视觉复用 `#taskDone` 浮框语言，右下角，4s 自动消失）；列表 key 过滤挂起项即可。DONE/ERROR 才可删（与手机 `deletable` 同口径）。
- **受益**：桌面（会话清理刚需）。手表端独立实现，不涉及。

### ② 列表底部上滑更新（#255）——缺失但不建议移植

- **手机**：`footRefresh` 滚到底触发重连重走快照，8s 冷却 + 拖拽装弹守卫（ListScreen L536-544）；底部 "↻ 上滑更新" 提示行（L619-625）。
- **网页**：事件驱动实时更新 + 心跳 ping-resume 自愈（L1456-1469）+ visibilitychange 回台补偿（L1476-1490），无刷新入口。移动端习惯映射到浏览器 F5。
- **结论**：不做手势。若顺手，可在 connPanel 源行加 ↻ 重连按钮（S、价值极低），排最末。

### ③ 五视图横滑翻页 + tab 指示条动效（#250/#252）——部分【批次 4，S，价值中低】

- **手机**：横向 pager 翻页（DetailScreen L974-995，懒渲染 ±1 页）；指示条逐像素跟手 + 中途拉伸 1.3x（L662-677、L952）；越中线即换高亮。
- **网页**：tabs 点击切换 + `#timeline.rise` 淡入（L411-412、L2690-2702），active 下划线瞬跳（L354-365）。
- **形态适配**：不做横滑。补两点即可：①active 下划线改为独立指示条元素 + `transform: translateX()` transition（tab 等宽，几何简单）；②键盘 ←/→ 切 tab（桌面加分项）。注意手机端是为触屏"单手可达"，网页鼠标点击已是最短路径。

### ④ 转录 #NNN 任务号点击跳任务定位（#264）——缺失【批次 1，S-M，价值高】

- **手机**：`TaskRefText` 把 tool_use/tool_result 摘要中 `#\d{1,3}` 渲染成品牌色可点段（DetailScreen L207-232）；`jumpToTask` 切任务 tab → onLayout 记 y 滚动定位 → 落点闪高 1.5s（L593-611）；任务不在渲染窗口时只切 tab（无害回退）。
- **网页**：`entryHtml` 的 tline/tres 文本纯 escapeHtml（L2164、L2180-2185），无链接化。
- **移植要点**：DOM 版比 RN 更简单——`todosTabHtml` 给每条任务行加 `data-tid={t.id}`（relay TodoItem 已带 id，手机 `renderTodo` L558 在用）；tline/tres 文本在 escapeHtml 后对 `#\d{1,3}\b` 做 `<a class="task-ref">` 替换（注意避开 markdown 内联正则干扰，仅作用于工具行摘要文本）；点击 → 切 todos tab（复用现有 tab click 逻辑）→ `querySelector([data-tid])`.scrollIntoView + 1.5s 高亮 class。
- **受益**：桌面同款高频（CLI 摘要里全是 #NNN 引用）。手表端转录面积小，暂不涉及。

### ⑤ 任务面板治理（24h/15 封顶、✕ 隐藏、active_form）——缺失【批次 1，S，价值高】

- **手机**：已完成只显近 24h（有 mtime 时）再封顶最新 15 条，分组 label 带计数 "已完成 3/12 · 近1天·最新15"（DetailScreen L522-546）；条目 ✕ 隐藏发 COMMAND_TODO_HIDE + 本地先滤（L513-519、L581-587）；in_progress 显示 active_form（L579）。
- **网页**：`todosTabHtml`（L1996-2020）全量渲染、无隐藏、无 active_form、分组无窗口逻辑；✕ 无入口（全文无 COMMAND_TODO_HIDE）。
- **明确不移植**：手机的自绘滚动滑块（DetailScreen L1085-1104）——那是 RN 系统滚动条不可见的 workaround，网页原生滚动条可用（L605-607），不搬。
- **移植要点**：窗口/封顶逻辑照抄 L522-546（含 `updated_at` 时间戳判断）；✕ 按钮加在 todo-item 行尾（hover 显现，同 card-edit 语言）；hide 后本地先滤 + 命令上行，todosKey 已含 length/status 序列会自然重建。
- **受益**：桌面（马拉松日任务面板可读性）；手表端任务面板另案。

### ⑥ 子 Agent 状态块（subagents）——✅ 已有

- 网页 `#agbox`（L479-488 CSS、L1892-1903 渲染）：最近 4 条、运行中⑂/结束✓、配色与手机一致；运行中走秒靠每秒 renderDetail（L2705）+ `Date.now()` 计算达成。与手机 DetailScreen L547-554、L1211-1227 等价。**无需动。**

### ⑦ 上下文水位 ctx 条分级色——部分【批次 4，S，价值中】

- **网页已有**：列表卡 ctx-mini 分级色条（<60% done / <85% working / ≥85% waiting，L348-352、L1716-1725，与手机 contextLevel 同口径原始比值判级）；liverow 附 `tok/limit`（L1888-1889）。
- **缺口**：详情头部无水位条——桌面这是**有意设计**（L348 注释：列表与详情同屏不重复）。但 ≤720px 移动视图下 `body.detail-open #side{display:none}`（L624），详情全屏时列表卡不可见 → 手机浏览器用 web 时全程看不到水位。
- **修法**：媒体查询 ≤720px 时在 `#dsub` 行尾追加 ctx-mini（复用 `ctxHtml(s)`），桌面布局不动。
- **受益**：手机浏览器/PWA 窄屏；桌面不变化。

### ⑧ 语音输入——跳过（按任务约定）

备注：未来如做，Web Speech API（Chrome 系可用）+ 按住说话交互可平移手机方案（DetailScreen L776-825）；依赖公司浏览器策略，优先级最低。

### ⑨ 会话卡紧凑模式——缺失【批次 4，S，价值中】

- **手机**：设置抽屉"简洁列表"开关（SettingsDrawer L279-288）+ 紧凑卡三行布局（状态点+标题+时长 / 摘要 / 目录+改动+水位，ListScreen L290-316）。
- **网页**：单一密度卡片（L250-272）。
- **配套顺手项**：手机还有"折叠空闲"按钮（一键隐藏 DONE 会话，ListScreen L502-517、L589-599），网页也没有——同一批做（列表渲染 `visible` 过滤 + statRow 加按钮）。
- **形态适配**：localStorage 持久化（如 `ccd_list_compact`），卡片加 `compact` class 切两套 CSS；开关放 connPanel 底部或 runhint 行（网页没有设置抽屉，勿为此新建抽屉）。
- **受益**：桌面（会话多时列表密度）。

### ⑩ 左滑重命名/删除手势——重命名已有；删除并入①

- **网页已有**：卡片 hover ✎ 就地改名（L266-272、L2627-2652，Enter 提交/Esc 取消/编辑中跳过重建）；详情页 ✎ prompt 改名（L2653-2660）。
- **结论**：手势不移植，hover 按钮即网页范式；删除入口随①补齐。

### ⑪ 展开全文/思考块折叠动画——缺失【批次 4，S，价值中低】

- **手机**：`Collapse` 组件高度动画（motion），思考/工具详情/diff 展开均有过渡。
- **网页**：expandRev 触发 innerHTML 全量重建（L2204-2212），展开瞬间跳变。
- **修法**：不引入 JS 动画——重建后给新增的 `.th-body/.tdetail/.diff` 加 CSS 入场（riseIn 已有 keyframes L337，或 `grid-template-rows:0fr→1fr` transition 需改成保留 DOM 结构，成本高不推荐）。取轻量方案：入场 fade+下移即可，视觉语言与手机 Collapse 一致。

### ⑫ 排队消息显示（pending_inputs）——✅ 已有

网页 `#pendbox` 右对齐呼吸气泡（L471-478、L1905-1911）+ `consumePendingByUserMsg` user_message 晋升兜底（L1646-1659）。与手机 PendingRow（L302-320）同构。**无需动。**

### ⑬ 外部 CLI 排队注入提示——✅ 已有

网页 external 会话 placeholder "注入到终端（空闲即发，忙碌排队）"（L1916-1918）+ WAITING 发送后 toast "已排队，回合结束后自动发送"（L2595）+ pendbox ⑫ 兜底。手机另有 4s queuedHint 条（L445-449），toast 等价。**无需动。**

### ⑭ 跨天分隔线——✅ 已有

网页 `.day-sep`（L413、L2145、L2193-2201），首条也标注日期，与手机一致。**无需动。**

### ⑮ 任务 tab 上滑更新 + 手动刷新——部分【批次 4，S，价值低】

- **已有**：↻ 刷新按钮发 COMMAND_REFRESH_TODOS（L2007-2009、L1940-1941）。
- **缺**：刷新等待态（手机 todoSpin：↻ 变品牌色，todos 引用变化或 2.5s 超时收尾，DetailScreen L465-480）；上拉触发（#257/#266）不移植（网页按钮即可）。
- **修法**：点击时 ↻ 加旋转/变色，下一帧 todosKey 重建时复位；顺手项，随批次 4。

### ⑯ AskUserQuestion 作答横幅——✅ 已有（完整对齐）

网页 `#questions`（L392-402、L2214-2280）：单问题单选点选即答 / 多问题·多选勾选提交 / 自由输入 / 取消作答视为拒绝，与手机 AskBanner（L323-412）逐条对应。**无需动。**

---

## 三、候选清单之外的额外发现

### A. 图片发送（选图/粘贴截图）——缺失【批次 3，M，价值高】

- **手机**：相册多选 ≤4 张 → JPEG 压缩长边 ≤1568 → base64 随 COMMAND_MESSAGE.images 上送（DetailScreen L826-861、L1266-1279；缩略图行可删）。
- **relay**：已支持（`types.ts` L289-290；`session-manager.ts` L492/498 透传；`agent-adapter.ts` pushUserMessage L386-392）。resume 路径同样带 images（L857-875）。
- **网页形态**（比手机更强）：textarea `paste` 事件截剪贴板图片 + 📎/📷 按钮文件选择，canvas 压缩同规格；缩略图行复用手机视觉。桌面贴图是高频操作，价值最高的输入侧补齐。

### B. 历史会话 resume 续聊——缺失【批次 3，S，价值中高】

- **手机**：`resumable = !external && !!s.relay_session_id`（DetailScreen L745-752），历史会话可发消息恢复（placeholder "继续对话（恢复会话）…"，L1333；histnote 区分可恢复/只读，L1170-1172）。
- **网页**：`historical && !external` 直接隐藏 cmdbar（L1915），hisnote 写死"仅可查看"（L743）——文案与手机行为已经脱节，用户被误导。
- **修法**：按 `s.relay_session_id` 放开 cmdbar + hisnote 文案分支（"发送消息将恢复继续"）；COMMAND_MESSAGE 路径 relay 侧已处理 resume。注意 mobile 窄屏 hisnote 底距。

### C. 过程消息三档（标准/紧凑/隐藏）——部分，候补

手机 PROC_FONT（DetailScreen L78-83）+ 设置抽屉三档（SettingsDrawer L19-23、L253-268）。网页已有"消息/全部"tab 过滤（L1955-1957）+ 思考开关 + 全局字号档（L2665-2679），主诉求已覆盖；若补，做"全部"tab 下过程行降字号/透明度一档即可（class 切换，S）。优先级低。

### D. 列表卡 WORKING 实时行——部分，候补

手机 LiveStat：回合耗时 + ↓输出 tokens + 摘要每秒走（ListScreen L75-92、L325）。网页卡片耗时已走秒（render key 含 elapsed，L1798），无输出 tokens 数。补法：WORKING 卡 summary 行前插 `↓tok · Ns`（usage.output_tokens 已在 SESSION_UPDATED 字段白名单 L1588）。S、价值低。

### E. 列表排序口径——部分【批次 1，S，价值中高】

- **手机**：活跃（WORKING/WAITING/ERROR）置顶 + 组内 **updated_at 倒序**——"新完成的会话紧跟活跃段，不再闪现后跳到底部像消失"（ListScreen L476-484 注释）。
- **网页**：WAITING>WORKING>ERROR>DONE + 组内 **started_at 倒序**（L1793-1797）——刚跑完 1 小时的会话可能沉到 DONE 组底部（按启动时间排），找不到了。
- **修法**：排序 key 换 `(order[status]) || (b.updated_at - a.updated_at)`；顺带把 order 对齐手机（手机 ERROR 与 WORKING/WAITING 同为活跃段 rank 0，网页把 ERROR 单独排第 2——保留网页现状亦可，差异点是"更新的优先"这一条必须改）。

### F. 其他记录在案的小差异（不单独立项）

- 手机输入草稿按 session_id 暂存（DetailScreen L65-66）；网页单一 msginput 切会话不清空≈全局共享草稿，够用，不动。
- 手机任务 tab 底部 "↻ 上滑更新" 提示行（L1081-1083）——随⑮评估，网页可不加。
- 手机详情工具区折叠按钮（L899-909）：网页 tabs 常驻占地不大，候补 H 项。
- 手机卡片"外部 CLI/托管"标签、目录 folder 名（ListScreen L333-334）；网页卡片有 src 角标+统计行，信息密度取向不同，不强行对齐。

---

## 四、实施注意事项

1. **单文件体量**：index.html 已 2824 行，批次 1-3 全在既有函数内改（render/todosTabHtml/entryHtml/sendBtn 路径），预计 +150~250 行/批；建议每批独立 commit（UI 微任务批制、分开提交的既有约定）。
2. **todosKey/cronKey 守卫**：任务面板新增 ✕ 隐藏与 active_form 后，todosKey（L1936）需把 `todoHidden.length` 计入，否则本地隐藏不触发重建。
3. **删除撤销的多源语义**：①的 pendingDel/deleting 状态是"选中源 ctx 级"还是全局？手机单源无此问题；网页多源建议按 sid 全局记账（sid 全局唯一），COMMAND_DELETE 按源路由已有 `sendCommandTo(ctx,...)` 现成通道。
4. **图片体积**：桌面粘贴截图常超 1MB，压缩规格必须与手机一致（JPEG q0.82、长边 1568）再 base64，防云桥帧超限（云桥密文帧有大小约束，先查 relay/bridge 帧上限再定）。
5. **验证**：每批完成后按既有三段收尾（3agent 审查 → 测试 → 提交）；视觉核对走截图双服务商交叉。
