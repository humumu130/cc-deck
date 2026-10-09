# FIX-1 验收归档（Leader 核验，M1-3 前置缺陷修复批）

- 任务：FIX-1 import-org 聚合缺陷+notification 比对口径修复（#109，源自 M12-8 真链路钉住的两缺陷）
- worker：K（3191106b）｜回单：/tmp/worker-k-fix1.md（15:53 SESSION_DONE）
- 提交：见本笔（五件 +67/−38）

## 亲验记录

1. **案 B 定案论证核**：下游三面零联动锚点实锤——session.member_id 恒 NULL（import-session-task.ts 头注「源无归因信息→NULL」）/成员投影走 headcount_json 直还与 member 表行数解耦/跨组归并 groupIds.push 未动（diff 无此段）。改动面对比（案 B 两处 identity+dedup vs 案 A+视图双处修补）成立。
2. **notification 口径修复核**：改读 notifications.json（{notifications:[…]} 包裹）+decision-notifications.json（裸数组）→三项过验（key/kind/created_at）distinct key vs COUNT——与写面（session-manager:752 / decision-notify:190）及导入面（import-notification.ts:2 头注两源消费）三方一致；源缺失 catch→0 对齐导入器 text===null 路径；头注降级备案同步留痕。
3. **seenRef 低级错自捕备案采信**：现码为 has+add 两步（亲读 import-org.ts diff）；Set.add 返 this 的首版错已修且回单留痕（诚实度加分）。
4. **亲跑**：import-org 40/40 / m1-orchestration 26/26（O10④ 收紧后仍全绿=shadow 全域 0 行实证）/ read-mode 43/43。K 侧全量 18 套+tsc 0+NUL；Leader 复扫五件 NUL CLEAN。
5. **改动面**：五件=四件预期靶面+test-import-org-parity.ts（+1/−1，S5 identity 断言加 session 段联动，断言语义不变）——超出申报但为案 B 必然联动，采信。m1-foundation :226 member 金值为行数断言（COUNT）非 id 值，案 B 不碰金值（49/49 绿的解释成立，K 回单未明说此点、Leader 补核）。
6. **O10④ 收紧亲读**：删 notifKnown/hardExceptNotif 特殊化，恢复 hardRows===0 && offRows===0 全域硬断言，头注「两处钉住缺陷」→「已修」口径翻转。

## 裁定

- 生产必炸缺陷（同组多 worker 同 role 同引擎 UNIQUE 炸→org 域整体回滚）根除；两场景测试（同卡两次认领去重 1 行/两卡分立各 1 行）断言原文为「UNIQUE 炸根除直接证词」——修复前同构 fixture 实测复现原缺陷，修复后绿。
- cutover 闸门 2（parity 全绿）与 shadow 观察期的 notification 假红面同时清障。

## 结论

**通过。M1-3 前置缺陷清零，#109 completed。** M12-8 归档中「缺陷转交」两项全部闭环。G（M13-1）在途健康。
