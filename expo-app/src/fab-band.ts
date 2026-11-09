// p2batch5 件②（teamtab 遗留·三魔法数抽取）：FAB（任务队列浮钮）占位带共享常量。
// 实测关系（W-TEAMTAB C2 三路裁决 + #208 键盘支）：
//   · FAB_BAND=52 —— 浮钮让位带：列表 contentContainer 额外 paddingBottom（有任务在队
//     时 +52，DetailScreen TeamPane/主列表两处 + ListScreen 同语义）；同时是 dockWork
//     「■ 停止」制动钮 26dp 遮挡带的组成部分。
//   · DETAIL_BOTTOM_BASE=114 —— 详情页浮钮非键盘落位 = FAB_BAND 52 + paddingBottom
//     基线 62（App.tsx 键盘收起分支 insets.bottom + 114）。
//   · DETAIL_BOTTOM_KB=120 —— 详情页键盘弹出支 = BASE 114 + 6 微抬（贴键盘上沿让位
//     命令栏；W-TEAMTAB C2 从 74→114/80→120 同步 +40）。
// 三处消费：App.tsx:169 键盘支两值 + DetailScreen.tsx TeamPane/主列表 FAB_BAND 两处。
// 独立模块防 App↔DetailScreen import 环（App import DetailScreen 反向取常量即环）。
export const FAB_BAND = 52;
export const DETAIL_BOTTOM_BASE = 114;
export const DETAIL_BOTTOM_KB = 120;
