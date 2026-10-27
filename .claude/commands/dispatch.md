---
description: 派单（W-DISPATCHX 封装）：模板三铁律 + 预检三项 + 调 leader-dispatch 机械手
argument-hint: <gid> <title> [--skills a,b] [--type feat] [--base origin/dev]（任务书正文写临时文件经 --brief 传入）
---

你是 PM。本命令把一次派单收敛为「一条命令 + 任务书正文」：机械活全交 leader-dispatch 脚本，你只负责判断与内容。用户参数：$ARGUMENTS

## 第一步：预检三项（任一不明，先补齐再继续，不带着疑问派单）

1. **gid**：与目标项目组核对（`~/.cc-deck/bin/org status`）。本命令要求 gid（散活随手办直接用裸 `org dispatch`）。
2. **worktree 基线**：脚本会在 `<worktree根>/cc-deck-w-<slug>` 预建 worktree、分支 `<type>/<slug>`。slug 从 title 派生 ASCII 或 `--slug` 指定；基线缺省 origin/dev——**续派/验证批要点名既有分支与基线**（脚本对已存在的 worktree+分支做幂等复用，不重置）。
3. **任务书三铁律**（脚本机器闸会拦；被拦=补内容重派，`--skip-gate` 仅用户明示才可用）：
   - 模板只锁节结构，**内容句一律你撰写**，脚本不代写；
   - 「已知现状」必须是**文件路径+行号级事实**（例 `relay/src/org.ts:123`）——没预勘就先预勘再派；
   - 必含「用户口径」「验收点」两节（验收点一行一条，可独立判 ✓/✗）。

## 第二步：撰写任务书正文（按此节结构写临时文件）

```markdown
## 已知现状
（文件路径+行号级事实，一行一条）
## 用户口径
（用户原话/拍板口径；无特判也写「无特判」）
## 验收点
（一行一条可独立判 ✓/✗ 的可观察结果）
## 交付
（产物与位置；回执路径脚本自动注入 ~/.cc-deck/artifacts/w-<slug>.md）
```

背景元数据（worktree/分支/基线/回执路径/纪律行）由脚本自动注入，你不要手写。写到 `/tmp/dispatch-brief-<slug>.md`。

## 第三步：调用机械手

```bash
~/.cc-deck/bin/leader-dispatch <gid> "<title>" --slug <slug> --brief /tmp/dispatch-brief-<slug>.md
```

（可选：`--skills a,b` 熟手优先、`--type fix` 修bug、`--base <ref>` 指基线、`--wait 30` 活性窗口。管道喂正文：`... --brief -`。）

## 第四步：解读输出并回报

- `RESULT ok=true … liveness=<status>`：向用户回报 dispatch_id / session_id / 分支 / 回执路径，入会话任务单跟踪；
- `queued=true`（若 relay 返回，编制触顶排队）：drain 自动接续，告知用户无需动作；
- 退出码 3（模板闸）：按 stderr 提示补节重派；
- 退出码 4（活性超时）：脚本已 `/api/notify` 升级——回报用户「派单落点未确认」，**勿静默重派（防双跑）**。

纪律：派单即入账（`$CCR_DATA_DIR/leader-dispatches.ndjson`），收割时 `/harvest <dispatch-id>` 按名寻址；发现超出本命令范围的事项，回报用户而非扩权。
