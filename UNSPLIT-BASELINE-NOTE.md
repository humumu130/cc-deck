# artifacts/split-baseline/ 基线快照说明

W-SPLIT-S0（docs/design-split-plan.md §3 阶段 0）固化——**164 件**（relay 139 + expo 25）测试输出快照，`<域>-<件名>.txt` 一件一文件（含 exit 码+时间戳+完整输出）。

- 基线时点：feat/w-splits0 @379af75（design-split-plan 拍板落定后）
- 首轮结果：**164/164 全绿，FLAKY 清单空**
- 用法见 `scripts/check-behavior-parity.sh` 头注释（--record 固化 / 无参比对 / relay|expo 单域）
- 拆分阶段（R1-R7）每批合并前必跑 parity——「基线全绿→出现失败」即实质破坏，禁止合并
