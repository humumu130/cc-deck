# worker-K 回单：M11-UTIL2 import-org.ts 回迁（收尾）

> 2026-10-06。C2FIX（009dedd）落地判据满足，import-org.ts 回迁完成，**M11 导入线六导入器全数收敛 import-util.ts，私有副本清零**。worker 未 commit。

## 一、diff 摘要

| 文件 | 规模 | 内容 |
|---|---|---|
| `src/storage/import-org.ts` | +7/−10 | ①crypto import **保留**（:307 project 锚点完整 40-hex sha1 是合法独立消费，非 sha12）；fs 缩 `{existsSync}`；增 `import { sha12, statThenRead } from "./import-util.js"` ②私有 sha12 三行删 ③observe 内核改 statThenRead 消费，原三行定稿序注释收为指引（「权威注释见 import-util.ts，本函数是定稿序出处」） |
| `src/storage/import-util.ts` | +7/−7（仅头注） | 迁移备案段更新：「六件全数消费本件，私有副本清零」——UTIL 单留下的「C2FIX 落地后下批回迁」指引闭环 |

**C2FIX 零碰**：confirms 格式两吃段与映射链一行未动（diff 全落在 import 区/sha12/observe 三处）。领域类型 ObservedSource 等照留（UTIL 单定夺口径）。

## 二、自证

- **tsc**：`npx tsc --noEmit` 全项目 0 错。
- **纯重构**：两测试文件零改动。
  ```
  Import org: 39/39 passed
  Import org parity: 55/55 passed
  ```
- 工作区改动面仅我两件 M，无他人在途混入。

## 三、收线状态

M11 导入线六导入器（org / notification / session-task / acceptance / artifact）+ 共享件 import-util 全数落地：sha12 与「stat 先于 read」定稿序各唯一定点，G1 线可直接消费。worker-K 存储线 M11 全单交付完毕，待命等 G1 后新排产。
