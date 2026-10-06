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
