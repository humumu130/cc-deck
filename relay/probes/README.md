# probes/——一次性探针归档区

> DEV-38 / R7（2026-11-28）：probe-\* 从 relay/scripts/ 迁入本目录归档。

## 退役口径

- **probe-\* = 取证用一次性脚本**：为某个具体诊断问题临时写的观测/复现件（sqlite 档位
  实测、手机端行为取证、生产数据只读探查等），问题关闭即失效，不进 CI、不随版本维护。
- **归档 ≠ 可用承诺**：本目录文件不保证随源码演进而更新——引用其结论的锚（源码注释、
  台账）以当时的取证结论为准；重跑前先核对所锚源码是否已漂移。
- **新探针写法**：仍先在 scripts/ 起草（与被观测源码同目录便于相对引用），取证完成、
  结论落进台账（docs/night-audit/ 等）后迁入本目录，件头补一行结论指针
  （如「结论：见 docs/night-audit/xxx.md §N」）。
- **只读纪律不变**：读生产数据（~/.cc-deck/data）的探针必须显式
  CCR_TEST_PROD_DATA_OK=1 且只读（src/test-data-guard.ts 闸不受 probe-\* 命名豁免
  影响——豁免的只是「测试语境判定」，数据面闸照常生效）。

## 为什么它们不留在 scripts/

scripts/ 是构建/运维件（build-plugin、rebuild-bundle、install-hooks…）的家；测试已归
tests/，探针归此——三目录各答一个问题：**怎么构建（scripts/）、怎么验证（tests/）、
当时发生了什么（probes/）**。
