# 引擎适配器真实冒烟清单（#42 第一期装机后核对）

> 130d024 已含三适配器 + 通用 JSONL 兜底 + stub 单测（12/12）。本清单=本机未装三 CLI 而
> 无法真实核实的项，装机后逐项跑。权威设计：specs/006-engine-adapters-spec.md §3.1-3.3。
> 纪律：每项先探测再定案；发现与写死参数不符→改适配器参数并补 stub 用例，不将错就错。

## Trae（agent-trae.ts，006 §3.1）

| # | 待核项 | 探测 | 通过标准 |
|---|---|---|---|
| T1 | `trae-agent --prompt-file --output-format jsonl` 参数真实存在 | `trae-agent --help` 全文 | 三参数均在；缺则改用实际等价参数 |
| T2 | 事件分类映射（onInit/onMessage/onTool 等分类与 006 §3.1 表一致） | 跑一个最小 prompt 落 JSONL 比对 | 分类字段名/结构对上 mapper；对不上改映射+补 stub 样本 |
| T3 | 无 resume（fresh spawn + context packet）够用 | 交互中断后重派单 | 重派单为新会话、context packet 生效（首帧可见任务上下文） |
| T4 | provider/env 变量名 | `env | grep -i trae` + 官方文档 | 声明式 CCR_TRAE_API_KEY_ENV 指到的变量名真实存在 |

## Qwen Code（agent-qwen.ts，006 §3.2）

| # | 待核项 | 探测 | 通过标准 |
|---|---|---|---|
| Q1 | `qwen -p <prompt> --output-format json` 输出确为单 JSON | 跑最小 prompt 抓 stdout | whole-document JSON 回落路径吃到；若实际是 JSONL 则走分帧路径，两路径都有兜底 |
| Q2 | usage 字段（token 计量）可用 | 同上，查 JSON 里 usage | usage 可解析进会话统计；缺则能力位降级不伪造 |
| Q3 | resume 语义（第一期不实装，仅确认未来路径） | `qwen --help` 查 resume/session 参数 | 记录实际形态进 006 备注，不改代码 |
| Q4 | provider/env 变量名 | `env | grep -i -E "qwen\|dashscope"` | 同 T4 口径 |

## CodeBuddy（agent-codebuddy.ts，006 §3.3）

| # | 待核项 | 探测 | 通过标准 |
|---|---|---|---|
| C1 | 可执行名与安装形态（`codebuddy`？子命令壳？） | `which codebuddy; codebuddy --help` | 与 spawn 的 command 对齐；不符改 spawn 名 |
| C2 | `--ci-mode` 真实存在且无交互审批 | CI 模式跑一个需写权限的 prompt | 无 WAITING 事件；权限错误落 ERROR 带可行动诊断（stub 已锁行为，验真形态） |
| C3 | 输出协议（stdout 格式） | 抓最小 run 输出 | JSONL/JSON/纯文本三条兜底路径其一吃到，正文不丢 |
| C4 | provider/env 变量名 | `env | grep -i -E "codebuddy\|tencent"` | 同 T4 口径 |

## 通用（agent-jsonl.ts / engine-registry.ts）

| # | 待核项 | 通过标准 |
|---|---|---|
| G1 | preflight 对未装/未配 provider 的真实报错形态 | ERROR 文案含「哪一项缺、怎么补」，不裸抛 |
| G2 | 三家 stderr 通道 | stderr 有内容时不丢（入日志），不误判为失败 |

## 记录规则

- 每项核完在本文档行尾标 `✓（日期/版本）` 或 `✗（现象）`；✗ 项开修复单。
- ZCode 不在本期（006 §3.4 遥测风险），勿顺手实装。

## 机器化（DL-P1-8，DEV-22 批 B，2026-11-28）

清单机器哨兵：`relay/scripts/engine-smoke.ts`（`npm run smoke:engines`，relay 目录下）。
三类覆盖与人工项的对应：

| 机器段 | 覆盖 | 对应人工项 |
|---|---|---|
| S1 词表卫生 | CODEBUDDY 词表无重复/形态合法/别名目标不越界 + **文案「内置 N 个」计数 vs 词表实长**（A-13 同族哨兵） | C 系前置 |
| S2 探针组合 | engine-auth.ts 源码审计 env 组合表（当前锚 qwen vertex-ai 两组合，新引擎接入补表行） | T4/Q4/C4 的静态半 |
| S3 装机在场 | 五 CLI `which` + `--help` 退出码 | T1/Q1/C1 前置 |

口径：
- **不在 CI matrix**（.github/workflows 面 2026-11-28 归 DEV-25/leader）：基线未清零前挂
  CI = 恒红噪音。当前已知漂移 3 项（见下方漂移账），全在 relay/src 面——修完归零后由
  leader 把 `smoke:engines` 加进 relay.yml 的 script matrix 即成 CI 冒烟闸；过渡期 CI 采集
  用 `--soft`（只报告不拦）。
- 输出三档：✓ / ✗（漂移，行动列含改派指引）/ SKIP（未装 CLI 的人工装机项）。
- 人工装机项（T2/T3/Q2/Q3/C2/C3/G1/G2 需真跑 CLI）仍按上方各表执行，结论回写行尾。

**当前漂移账（2026-11-28 首跑，npm run smoke:engines = 9 ✓ / 3 ✗）**：
①文案计数「内置 20 个」≠ 词表实长 17（agent-codebuddy.ts，A-13）；②③qwen vertex-ai
GOOGLE_API_KEY+GOOGLE_MODEL / GOOGLE_CLOUD_PROJECT+GOOGLE_MODEL 探针组合零命中
（engine-auth.ts，DL-P1-8 artifacts 深挖②）。三项均为 relay/src 改派面。
