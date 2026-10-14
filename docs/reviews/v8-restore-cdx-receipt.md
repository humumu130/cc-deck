# v8 视觉还原 · Codex 轨回执

日期：2026-10-14

## 本轮结论

- Expo 默认无存储偏好时进入 v8 蓝紫深色壳；已有 `ccr_theme` 偏好继续尊重。
- 桌面保留 v8 暖橙品牌轴，收口 rail 激活态、团队/项目卡、通知浮层、设置卡和配对弹窗。
- 会话详情信息架构与功能未重排；移动端只做 token、卡面、底栏、浮层和设置连接设备视觉对齐。
- 未修改 `expo-app/src/store.ts`、`expo-app/src/protocol.ts`。
- `cd expo-app && npx tsc --noEmit`：通过。

## C01–C41 对照表

| 标记 | 处理 | 落实位置 |
|---|---|---|
| C01 | 原型参考，不产品化页头说明 | `docs/mockups/v8-ui-interactive-v2.html`；正式壳沿用 `web-console/index-005.html` 现有窗口顶栏 |
| C02 | 原型参考，不新增一次性提示 | `docs/mockups/v8-ui-interactive-v2.html` |
| C03 | 原型参考，不新增演示字幕条 | `docs/mockups/v8-ui-interactive-v2.html` |
| C04 | 还原桌面壳层级与 rail 激活锚点 | `web-console/index-005.html` 末段 v8 CSS 收口；桌面 `domain-rail` / `rail-btn` |
| C05 | 保留现有连接入口，校准浮层与状态层级 | `web-console/index-005.html` 配对/连接 CSS；`expo-app/src/screens/ListScreen.tsx` 源切换菜单 |
| C06 | 保留 alert-only badge 语义，统一通知浮层卡片 | `expo-app/src/screens/NotifCenterPage.tsx`；`web-console/index-005.html` `.notifpanel` / `.nrow` |
| C07 | 团队一级域的标题、卡片和 tab 视觉对齐 | `web-console/index-005.html` 团队域样式；`expo-app/src/screens/OrgTabs.tsx` |
| C08 | 团队消息沿用现有能力，统一卡面 token 与纵向间距 | `web-console/index-005.html` 全局 v8 token；`expo-app/src/theme.ts` |
| C09 | 看板卡、泳道和状态色统一 v8 层级 | `web-console/index-005.html` `.task-card` / board 样式；`expo-app/src/screens/TeamDetailPage.tsx` |
| C10 | 成员卡采用三态色与双信号信息层级 | `web-console/index-005.html` `.member-card` / `.watchdog-signal`；`expo-app/src/screens/TeamDetailPage.tsx` |
| C11 | 活动时间线统一节点、时间和事件行视觉 | `web-console/index-005.html` `.activity-row`；`expo-app/src/screens/TeamDetailPage.tsx` |
| C12 | 结构冻结，仅换主题 token 与浮层质感 | `expo-app/src/theme.ts`；`expo-app/App.tsx`；`expo-app/src/screens/ListScreen.tsx` |
| C13 | 保留现有历史/确认结构，仅统一状态色与 sheet 层 | `expo-app/src/theme.ts`；`expo-app/src/screens/ListScreen.tsx` |
| C14 | 保留验收能力，统一卡片边框、动作色与进度层级 | `expo-app/src/screens/ListScreen.tsx`；`web-console/index-005.html` |
| C15 | 保留合并流结构，统一列表卡与弱化信息色 | `expo-app/src/screens/ListScreen.tsx`；`expo-app/src/theme.ts` |
| C16 | 保留输出物入口，复用 v8 卡片/标签 token | `expo-app/src/theme.ts`；`web-console/index-005.html` |
| C17 | 保留低频菜单入口，统一底部 sheet 视觉 | `expo-app/src/screens/ListScreen.tsx` |
| C18 | 保留统计 pane，沿用详情结构冻结约束 | `expo-app/src/theme.ts`；`expo-app/src/screens/ListScreen.tsx` |
| C19 | 项目一级域卡片、图标锚点与只读边界对齐 | `web-console/index-005.html`；`expo-app/src/screens/OrgTabs.tsx` |
| C20 | 保留三入口验收链，只对齐卡片/步骤 token | `expo-app/src/screens/ListScreen.tsx`；`expo-app/App.tsx` |
| C21 | 设置域统一页面标题、分组卡与行式节奏 | `web-console/index-005.html`；`expo-app/src/screens/SettingsPage.tsx` |
| C22 | 通用设置保持行式配置，增加 v8 行高与卡面层级 | `expo-app/src/screens/SettingsPage.tsx` |
| C23 | 连接与设备采用活动卡、服务器卡、设备卡三段视觉 | `expo-app/src/screens/SettingsPage.tsx`；`web-console/index-005.html` |
| C24 | Provider 卡与引擎 chip 统一 token，保留凭证安全提示 | `expo-app/src/screens/SettingsPage.tsx`；`expo-app/src/theme.ts` |
| C25 | 身份模板保留现有字段，统一卡片/引擎 chip 语言 | `expo-app/src/screens/SettingsPage.tsx` |
| C26 | 扩展页不新增演示数据，仅承接统一设置卡 token | `expo-app/src/screens/SettingsPage.tsx` |
| C27 | 关于信息保留现有事实源，弹层换 v8 sheet 质感 | `expo-app/src/screens/SettingsPage.tsx` |
| C28 | 手机壳 root/二级页导航保持现有状态机，底栏与背景换 v8 | `expo-app/src/theme-context.tsx`；`expo-app/src/bottom-tabs.tsx`；`expo-app/App.tsx` |
| C29 | 会话主页卡片化，保留搜索、瘦身过滤、源切换和新建入口 | `expo-app/src/screens/ListScreen.tsx` |
| C30 | 会话详情结构冻结，仅统一 token、菜单 sheet 与全局浮层 | `expo-app/src/theme.ts`；`expo-app/src/screens/ListScreen.tsx` |
| C31 | 团队主页加入 v8 图标锚点、选中态和卡片密度 | `expo-app/src/screens/OrgTabs.tsx` |
| C32 | 团队详情看板/成员/活动节奏与 v8 卡片层级对齐 | `expo-app/src/screens/TeamDetailPage.tsx` |
| C33 | 项目 root 卡片加入项目图标锚点与动作行层级 | `expo-app/src/screens/OrgTabs.tsx` |
| C34 | 项目详情沿用只读聚合边界，复用统一主题 token | `expo-app/src/screens/OrgTabs.tsx`；`expo-app/src/screens/TeamDetailPage.tsx` |
| C35 | 通知中心保留顶栏入口，badge 只数需行动项，sheet 加深层级 | `expo-app/src/screens/NotifCenterPage.tsx`；`expo-app/src/screens/ListScreen.tsx` |
| C36 | 验收单状态机不动，沿用移动验收入口的 v8 卡面 token | `expo-app/src/screens/ListScreen.tsx`；`expo-app/App.tsx` |
| C37 | 设置 root 使用底栏进入，设置组卡和行高对齐 v8 | `expo-app/src/bottom-tabs.tsx`；`expo-app/src/screens/SettingsPage.tsx` |
| C38 | 连接设备保持移动浏览态与回电脑端安全边界 | `expo-app/src/screens/SettingsPage.tsx` |
| C39 | Provider 保持脱敏浏览态与回电脑端凭证边界 | `expo-app/src/screens/SettingsPage.tsx` |
| C40 | 结构复核，不向正式产品搬入原型舞台闭合元素 | `docs/mockups/v8-ui-interactive-v2.html` |
| C41 | 原型说明留在对照稿，不进入正式控制台 | `docs/mockups/v8-ui-interactive-v2.html` |

## 验证与限制

- 已执行：`cd expo-app && npx tsc --noEmit`。
- 已执行：`git diff --check`。
- 已执行（均使用 `CCR_DATA_DIR=$(mktemp -d)` 隔离）：`relay/scripts/test-005-parity.ts` 通过；`relay/scripts/test-005-ui-rows.ts` 通过（143 passed / 0 failed）。
- `relay/scripts/test-session-slim.ts`：32 passed / 5 failed；失败均为既有 slim-list 基线静态锚点问题（团队入口点击锚点、`renderMyList` 管线、`active → teams → idle` 顺序、团队成员点击跳转、div 配平），本轮未改动相关功能与结构。
- 本轮未执行 headless/真机截图验收；桌面与 Expo 真机仍需 Leader 部署后按屏并排复核。
- 当前容器 `.git` 不可写，创建 `feat/v8-visual-restore-cdx` 与提交均被环境权限阻断；未伪造 commit，也未触碰 GLM worktree。
