# 任务书：连接域 P0 批——状态可见性最小改造（纯呈现层）

基线：fix/engine-chip-slim@6e5c47e2（本 worktree 即此）。**先读** `artifacts/research-conn-ux-063.md`（在主仓 /Users/xdd/dev/cc-deck/artifacts/，调研报告含全部文件:行证据）§三 P0 节。范围：**仅 expo-app**（web-console 归 P1）。机制零改动——不动连接/合并/聚合逻辑，只把已有状态说给人看。

## 四件（P0-1~P0-4，报告锚点为准）

1. **P0-1 每源四态+原因透出**：SourceStatus 扩 stateText/failNote 字段（store.ts connStatusPatch 一处收口），源胶囊副行呈现四态（连接中/已连/等对端/失败+原因），六态压三色的旧呈现退役。受益面：源胶囊（source-switch.tsx）+ListScreen 空态。
2. **P0-2 云桥三段断点一段式文案**：三段判据已有（报告锚 1505/1432/1455 段1 桥不可达、1534 段2 对端离线、1564+markUnpaired 段3 配对失效）——人话一段式：「云桥连不上（桥服务不可达）/电脑端 relay 未挂桥/配对已失效需重新配对」，挂源胶囊副行+空态。
3. **P0-3 ListScreen 空态按源报状态**：空列表不再只给通用空态——按源报（该源已连但 0 会话 vs 该源断开）；修「点右下角＋」错位文案（报告实锤的错位锚）。
4. **P0-4 SetupScreen「配对云桥」置灰原因行**：置灰时一行原因（缺云配置/已在配对中/等授权…）。

## 铁律

- 纯呈现：store 只加状态字段与文案映射，**不动** mergeByIdentity/聚合/扫码行为（那是 P1 批的行为改动，本批禁碰）。
- 文案即产品：状态文案用户视角措辞（不出现「relay_dev/桥 token」内部术语），每态一行内说清。
- 测试：test-e2a-list 同款基建加断言（空态分源/四态映射纯函数）；`npx -p typescript tsc` 触碰文件 0 错（tsconfig jsx 配置下）或说明。E2A 43/43 不回归。
- 审查 1 路（常规批档）回执进提交体。提交 `[正经立项] feat: 连接域P0 状态可见性` 推 `fix/conn-ux-p0`。禁碰 relay/web-console/deploy。

## 完成定义

PM 复验（断言+真机口径走查清单给用户验）+合入统一线。
