---
description: 收割（W-DISPATCHX 封装）：调 leader-harvest 机器闸 + 人工判断清单
argument-hint: <dispatch-id>
---

你是 PM。收割 = 机器闸核机械事实 + 你做人工判断。用户参数：$ARGUMENTS

## 第一步：跑机器闸

```bash
~/.cc-deck/bin/leader-harvest <dispatch-id>
```

机器闸只核：回执存在性+必需节（根因/自测证据/验收点/尾行结果摘要）、台账终态、分支新提交清单、未提交改动、squash 命令建议。

## PR 互审链（W-PRREVIEW 期一④，1104 用户拍板「Multica 同款」——pr_flow 单适用）

任务书带「交付 PR 约定」的单（本地派单账 pr_flow 位），收割前走互审链；**终态链不变**（交付→审查→收割→装机真验→回填，PR 只是载体与审查面）：

```bash
~/.cc-deck/bin/leader-harvest <dispatch-id> --review [--reviews N]   # ①发起互审
~/.cc-deck/bin/leader-harvest <dispatch-id>                          # ②机器闸（含 PR CI 绿检查位）
~/.cc-deck/bin/leader-harvest <dispatch-id> --merge                  # ③squash-merge 收割
```

1. **--review**：解析 PR（回执链接优先，缺则 PM 兜底开 draft PR）→ **PR CI 绿前置闸**（红灯直接打回 worker 修复重推，不进审查）→ 互审员路由（org review-route：在编 worker 同域熟手优先、避交付者与同单关联会话；无匹配自动回落 PM 子代理）→ 互审意见落 **PR 评论**（可链接）。审查档位纪律零变化：一行级 1 审 / 常规 2 审其一反方 / 重大 3 审——**N 由你按全局审查纪律定**，工具不代定档；
2. **P0/P1 决议**：互审意见 P0/P1 必修完再收割（PM 终审不变：你复核决议，不因审查员来源变化放水）；
3. **--merge**：`gh pr merge --squash` 单笔纪律不变（dev 一事项一笔）；gh 不可用/远端失败自动降级旧路（本地审+手工 squash，回执记降级标记）。


## 第二步：人工判断（不自动化，SSOT 内核，逐项过、勿跳）

1. **diff 抽查**：抽 1~2 处关键改动亲自看代码（不信回执自述）；
2. **自测证据核验**：回执的断言/套件数字与 git 提交、产物对得上；
3. **真机分级**（项目 CLAUDE.md 核验分级硬规则）：L2 web UI 项必须看真机/截图对照；L3 壳层 / L4 跨端项未真机验证不得收——标「代码核验过，真机待验」进验收单；
4. **是否 squash**：闸全绿且以上人工项过 → 才执行脚本打印的 squash 建议（dev 一事项一笔，信息带 #NN）；有 ✗ → 开修复单；未测 → 留 in_progress 等补验。

## 第三步：回报用户

闸结果逐项 ✓/✗ + 你的判断结论 + 下一步（收编出包 / 修复 / 挂起）。worker 若已退休（会话不在编制），回执与分支照常收割，人员处置走 `org member-retire`。

纪律：收割判断不自动化是拍板红线；发现超出本命令范围的事项，回报用户而非扩权。
