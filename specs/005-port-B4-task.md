# 005 换壳 B4 任务书：项目域 + 通知中心迁移（#d-project、#d-notify）

> 任务代号 #143-B4。Claude 执行。在你的专属 worktree 施工，**不 commit**（Leader 核验后代提交）。

## 背景与施工位置

B1 已交付 `web-console/index-005.html`（005 壳骨架，提交 a273dbf）。本批迁移**项目域（只读聚合）+ 通知中心**。先读 `specs/005-port-B1-report.md` 偏差表 D01-D20（D03/D04 标记本批占位；D11-D14 协议拷贝先例）。

## 施工边界（铁律，违反=返工）

1. **只允许改动 `#d-project` 与 `#d-notify` 两个 `<section>` 区间内部 + rail 通知按钮 badge**（含区间内内联 `<script>`）。其余——`<style>`、地基脚本、其他 section、mobile 屏——禁改。
2. `<style>` 逐字节一致是过闸资产，禁改；新功能装 005 既有形态（metric/aggregate-card/notify 行/readonly-banner）；需要新样式 → 「契约请求」。
3. 地基脚本禁改；增量事件/命令通道需求 → 「契约请求」清单。
4. 偏差备案制（B4-D1 起）；不 git add/commit；不动 worktree 外文件；沙盒隔离 env；截图只存 /tmp。

## 迁移范围

**#d-project（只读聚合）**——005 形态：metric 四卡（会话/活跃团队/输出物/需行动）+ aggregate-card 四组（会话/团队/输出物/验收单）+ readonly-banner「项目页只读聚合」：
1. 数据：按锚点聚合的会话列表摘要、团队摘要、输出物（deliver 登记目录分组）、验收单（acceptance 回填状态）。
2. 「在会话中查看/在团队中查看」等按钮 = rail 域跳转（可本地实现：触发 rail 切换）；跨域动作不越权实现。
3. SNAPSHOT 无对应聚合字段的部分 → 报告「契约请求」标注缺什么，能用现有 sessions/artifacts 数据本地聚合的就本地算。

**#d-notify（通知中心）**——005 形态：行化列表（来源摘要+轻动作内联）+「N 项需行动」：
1. 旧版已有实现可迁：通知 resolved/unresolved 分离、验收链接回跳（M13-6W）、轻动作（#54 形态）。
2. 数据：SNAPSHOT 通知/notification 域字段 + org_confirms 的行动项；字段缺 → 契约请求。
3. rail badge：需行动计数（与团队 badge 口径区分：通知=全部需行动，含验收/确认）。
4. 空态形态按 005。

## 自测

沙盒配方同 B2 任务书（端口用 **8798**，目录 /tmp/005-b4/，token b4devtoken），全量隔离 env，等 60s 启动风暴，Chrome headless 截图 1440+390。用完按 PID 定点杀。缺项注明原因。

## 交付

`specs/005-port-B4-report.md`：首行结论 → 完成项/遗留项 → 自测结果（截图路径）→ 偏差备案表（B4-D1 起）→ 契约请求清单。stdout 最后一行 `B4-DONE` 或 `B4-BLOCKED: 原因`。
