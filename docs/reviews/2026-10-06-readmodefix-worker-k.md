# READMODE-FIX 验收归档：ensureStore portCache 陈旧账修复（worker K，P81-6FIX B1 裁定单）

> 2026-10-06 · 任务书 /tmp/dispatch-k-readmodefix.md · 回单 /tmp/worker-k-readmodefix.md · #136 · 提交 `2b9535f`（2 files +33/-2）

## Leader 亲验记录

| 项 | 结果 |
|---|---|
| test-read-mode | **45/45**（43 既有零退+段4b 长驻锁 2 新） |
| 回归 | orchestration 27/27+checkpoint 34/34（Leader 亲跑抽验） |
| 关键面亲读 | diff=命中分支快进+头注语义升级+缘由注完整（P81-6FIX B1→READMODE-FIX 链路可溯） |
| 金标准 | 还原修复态段4b 精确双红 43/45——测试锁与修复强耦合实锤 |

## 裁量审阅

- **长驻锁落点偏离**（checkpoint 件→read-mode 件）：**采信**——ensureStore 是 read-mode 函数+该件有全源 fixture 与缓存清理口子，「不走 reset 的二次 ensureStore」语义最贴；
- **O10 面零改动**：显式触发保留作语义文档+域级失败回归锁——零裁量负担，合理；
- **修复定性采信**：文件头铁律 3 本承诺「读前触发 lazy ensure——checkpoint 快进保证二次调用近零开销」，portCache 命中跳过导入恰是违背承诺——本修是实现对齐头注原意非语义扩张。

## 性能报忧（Leader 核）

30ms/次 @1MB（七导入器 observe 全文读与源体积线性，非「近零」）；10MB 预估 100ms+/次。影响面：生产 json 档唯一消费者（审计写面）无感；sqlite 翻转后读税可见但不损可用性。**stat 短路优化（mtime+size 未变⇒跳过全文读）转单排队**——翻转前收口，落点 import-util.ts statThenRead/七导入器（含边界：append-only 源 mtime+size 双保险防快速连续写漏读）。

## 结论

**READMODE-FIX 验收通过**——长驻进程陈旧账收口，sqlite 默认档翻转第六闸前置债清偿。#136 ✅
