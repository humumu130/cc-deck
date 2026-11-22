# 审查单 E-R1·CONNV4E 正确性+UX（含反方·2 路之一·只读）

> 被审：fix/connv4e @649f569c（PR draft base=origin/dev）+回执 w-connv4e.md。只读，回执 w-connv4e-r1.md。

## 用户口径
- 网页端聚合「网页 ×N」+断当前连接（主 token 共享语义，真踢除不在本批）；mobile 源列表 lane 与桌面同构（五段序）；小标签 ≤3 字；能力位分流（LAN 段 404=旧版隐藏）

## 已知现状
- 回执改动面（先读全）：settings-domain.js 聚合行+cloudMobileLaneInner(:4619) 同步+mobile.js+探针；worktree /private/tmp/cc-deck-w-connv4e

## 审查重点
1. 聚合正确性：wb- 纯网页行聚合（在线/总数）与带名字 wb- 行不聚合的判据；断开=全部 wb peerKicker 的语义与主 token 共享一致
2. mobile lane 五段序与桌面 sourceListRows 同构性（本机置顶/同账号三态/LAN 条件段/配对码源）——逐段对照
3. 能力位分流：lan-peers API 404 形态隐藏不报错；有 API 时渲染（与批D 合入后即通的兼容面）
4. UX 反方：聚合行信息量够吗（在线数误导面）；mobile 只读台账（无管理双键）的边界清晰否
5. 探针断言真锁；全套锚复跑（connv4c2 23+acctmulti 8+fc 137）
6. 尾行「结果：过/挡」→ w-connv4e-r1.md
