# 会话大纲导航条（Conversation Outline Rail）实现规格——钉死数值版

> 来源：用户 1021 提供的 WorkBuddy 复刻规格（数值来自参考实现源码），实现时严格按值，勿自行发挥。

## 定位
桌面 005 壳会话详情区右侧竖向窄导航条，锚点单位=「用户消息」（只锚用户消息，不锚 AI 回复）。默认只显示一列短横线；悬停淡入摘要；点击平滑滚动到对应消息居中；滚动时当前可见消息对应横线自动高亮。另：聊天区滚动条去轨道（overlay 式，只留细 thumb）。

## 整体布局
- rail 与聊天区 flex 并排（**禁 position:fixed**），rail 在右
- rail 宽 **150px**；border-left **0.5px solid rgba(0,0,0,0.08)**（暗 rgba(255,255,255,0.08)）
- rail 内边距 **14px 0**；flex column；justify-content center；gap **4px**
- rail 背景 **#f7f7f5**（暗 **#252525**）

## 锚点项 item
- display flex；align-items center；gap 6px；cursor pointer；padding **5px 8px**；border-radius 6px
- rail 在右 → **flex-direction: row-reverse**（label 在 tick 左侧，文字向聊天区展开，不溢出视口）

## 横线 tick
- 高 **2px**；默认宽 **16px**；圆角 1px；flex-shrink 0
- 颜色：默认 rgba(0,0,0,0.35) / 暗 rgba(255,255,255,0.4)
- 悬停宽 24px / rgba(0,0,0,0.55) / 暗 0.55
- 高亮宽 28px / rgba(0,0,0,0.88) / 暗 0.95
- transition width .15s, background-color .15s

## 摘要文字 label
- 12px / 行高 16px；rgba(0,0,0,0.55) / 暗 0.6
- nowrap + hidden + ellipsis；opacity 0 + max-width 0 默认
- 悬停/高亮：opacity 1 + max-width **110px**
- 高亮加 font-weight 500 + color rgba(0,0,0,0.88) / 暗 0.96
- transition opacity .15s, max-width .15s

## 动效强化（第二版规范，与上并施）
- 分层时序：hover 时横线先动（width 180ms），文字晚 40ms 跟（opacity/max-width transition-delay 40ms on enter、0 on leave）
- 点击按压：tick scaleX 0.85 回弹 280ms cubic-bezier(0.34,1.56,0.64,1)，origin=靠聊天区侧（rail 在右→left center）；JS 加 .pressed 类，animationend 移除
- **active 切换不动宽度**（防滚动抖动）：active 只改 background/color/字重，宽度只在 idle↔hover 过渡
- 新锚点入场：opacity 0→1 + translateY 4px→0，200ms，播一次
- 空态：无锚点 rail opacity 0 + pointer-events none；首条淡入 200ms

## 滚动联动
- container scroll 监听 passive:true + requestAnimationFrame 节流
- 算法：遍历锚点 DOM，取「top ≥ 容器顶-40 且 top < 容器底」中 top 最大者为 active；初渲/ResizeObserver/锚点变化都重算
- 点击：scrollIntoView({behavior:'smooth',block:'center'})+立即设 active+按压动画

## 其他要点
- 摘要=用户消息纯文本截 24 全角字符；空串显示「（空消息）」
- 锚点 ≤4 居中，>4 space-between
- 无障碍：rail role=navigation aria-label=会话大纲；item role=link tabindex=0 回车/空格跳转；aria-current 标当前
- 消息流式追加时 runtime 增删锚点，不重渲整列
- 单条用户消息：显示单条且默认 on；聊天区空：rail 不渲染

## 滚动条去轨道（同批）
- 聊天区滚动条 overlay 式：::-webkit-scrollbar width 0/透明 track；thumb 细条悬浮式（或 width 4px 无 track 圆角 thumb，hover 才显）
- 与 rail 并存不冲突（rail 是功能索引，滚动条只是滚动指示）

## 验收
- [ ] 默认只见短横线无文字；滚动条无轨道
- [ ] hover：横线先加宽，文字延 40ms 淡入展开
- [ ] 点击：按压回弹+平滑滚动居中
- [ ] 滚动：高亮切换仅颜色渐变无宽度抖动，唯一高亮
- [ ] 流式新消息：新横线入场动效+联动正常
- [ ] 暗色全部变量适配
- [ ] 文字展开朝聊天区不溢出；≤4 居中
