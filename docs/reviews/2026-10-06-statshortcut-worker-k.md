# STAT-SHORTCUT 验收归档：checkpoint 快进热路径优化（worker K，READMODE-FIX 性能报忧转单）

> 2026-10-06 · 任务书 /tmp/dispatch-k-statshortcut.md · 回单 /tmp/worker-k-statshortcut.md · #139 · 提交 `315854a`（6 files +67/-11）

## Leader 亲验记录

| 项 | 结果 |
|---|---|
| test-read-mode（含段4b 长驻锁+段4c 四断言） | **49/49**（Leader 亲跑） |
| import-parity | **21/21**（Leader 亲跑） |
| diff 亲读两件核心 | import-util（OBS_MEMO+2MB 上限+双 statSync ns 腿+命中短路/miss 刷新/超限 delete+头注正确性锚三行）/import-org（:108 COUNT 下推单行替换+注释备案） |
| 树核 | K 认领六件齐、L 在途 expo 件零碰 |

## 裁量四项裁定（全采信）

1. **COUNT 下推四处=observe 面语义延展**：skipped 分支 loss 计数属快进路径返回值构造，四处均单行替换语义严格等价（同域行数），非主流程改造——判边界内；
2. **mtimeNs 腿=必要加固**：任务书 mtimeMs 方案被对抗锁实锤（同 ms 等长覆盖写误命中），ns 腿堵缝；checkpoint 比对仍 mtimeMs 口径零影响；秒级精度 FS 退化现行为=安全侧；
3. **<3ms 未达（7.2ms）备案不动**：剩余=七域 observe 目录扫描+逐域 checkpoint query+portCache 往返（单域 bench 0.148ms 佐证主体是流程骨架），再压需动导入器主流程超界；
4. **fixture 病态勘误纳入翻转裁量**：30.1ms 基线=8000 全坏行病态形态（loss 8001 行），生产 events loss≈0 真实基线远低于 30ms——sqlite 翻转紧迫度据此重估（生产实际读税低于此前估计）。

## 技术要点（回单 §一/§三）

八轮 profile 推翻任务书假设：readFileSync 全进程占比仅 2.6%，真死点=四导入器 skipped 分支 listLoss 全表捞行 filter 计数（loss 8001 行 18.4ms vs COUNT 0.044ms=**420 倍**税）。双刀：①statThenRead 短路 memo（mtimeNs+size 双未变⇒复用 text；2MB 上限防 events.ndjson 增长源常驻内存）②listLoss→COUNT 下推×4（import-org :108 三源/import-notification :101 两源/import-artifact :245 动态 N 源/import-acceptance :203 单源）。性能 30.1→7.2ms/次（4.2 倍）。

段4c 四断言：命中等价/计时塌缩 0.0107ms<0.1ms 阈值（14× 裕度，readFileSync 无 seam 以塌缩替身计数锁）/等长覆盖写对抗锁（ns 腿独立工作）/memo 刷新锁。

## 结论

**STAT-SHORTCUT 验收通过**——READMODE-FIX 性能报忧闭环收口，sqlite 默认档翻转读税前置债清偿（且经 fixture 勘误后真实读税负担修正下修）。#139 ✅。K 空闲待派。
