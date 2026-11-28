# HANDOFF-75：项目整体接手——Windows 主力机损坏，Mac 全面接管（会话交接文档）

> 写于 2026-09-13 晚。上一会话（在家目录 `/Users/xdd` 启动）已完成全部核查，本文件供新会话直接接上，无需用户重新交代背景。

## 背景

- 用户的 Windows 主力机（原主开发会话所在）今日损坏，**之后由这台 Mac 独立接管开发**
- 原工作流：Windows 写代码 → 打 bundle（`/tmp/mac-*.bundle`）→ 传到 Mac `/tmp` → Mac `pull --ff-only` 合入 + 构建装机验证（见 HANDOFF-72/74/74b）
- **该工作流已终止**：Mac 现在是唯一开发机，直接在本地提交

## 今日时间线（已核实 reflog + bundle heads）

| 时间 | 事件 |
|---|---|
| 03:06 | 最后一次推 GitHub（`52529a6` bump 0.4.22）|
| 09:41–14:42 | Windows 完成 11 个提交（#110–117 修复，覆盖 expo-app/relay/deploy/web-console/desktop-tauri/cc-plugins 全组件）|
| 10:30 | `547f1bb` 0.4.22-test 版本号 ← 用户手机下午装的测试版就是这个 |
| 14:51 | Windows 打出最后 bundle（`/tmp/mac-handoff-17.bundle`，HEAD=42af506）|
| 14:56 | Mac 快进合入 `42af506`（= Windows 最后提交，**无丢失**）|
| 14:58 | 本地 relay.mjs 重打包（未提交，见下）|

**风险窗口**：仅 14:42 之后 Windows 上可能存在的未提交改动，从 Mac 无法恢复。已提交内容 100% 在 Mac。

## 当前仓库状态（`~/dev/cc-deck`，分支 dev @ 42af506）

- **领先 GitHub 11 个提交（+1335 行），未推送** —— 目前只存在这台 Mac 上，是最大风险点
- 远程：`origin` → `/Users/xdd/cc-deck.bundle`（**9月6日的过期 bundle，待改指向 GitHub**）；`github` → `https://github.com/humumu130/cc-deck.git`（上一会话新加，已 fetch，确认 GitHub dev=`52529a6` 是本地祖先，无分叉）
- 未提交改动：`desktop-tauri/src-tauri/resources/relay.mjs`（仅打包路径注释差异 `relay/node_modules/` → `node_modules/`，源码未变。HEAD 版 md5=`964dd931`，与 cc-plugins 副本一致，即 db86e9b 提交所述"双端一致"验证版 → **可安全 `git restore`**）
- stash@{0}（今天14:56）：relay.mjs 重打包 + relay/package-lock.json，同步过程副产品
- stash@{1}（9月7日）：relay/src 大面积 WIP，**大概率已被后续数百提交覆盖**，暂留勿动
- `git fsck` 通过，无未跟踪文件

## 网络与凭据

- 直连 github.com 超时；**本地代理 127.0.0.1:7890 可用**（Clash，系统级已配置）：
  `export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890`
- `gh` 未登录、keychain 无 GitHub 凭据、无 SSH key → **推送前需用户认证**（`! gh auth login` 或提供 PAT）

## 待办（按优先级）

1. 【最高】GitHub 认证后推送：`git push github dev`（fast-forward，无破坏性）。推完提醒用户可顺手 `git remote set-url origin <github url>` 并删 bundle remote
2. `git restore desktop-tauri/src-tauri/resources/relay.mjs`（还原到验证版）
3. 两个 stash 处置待用户确认后清理
4. 可选：为本仓建 CLAUDE.md（此前没有）；项目无 .claude/CLAUDE.md，仅 settings.local.json
5. 之后按用户指示继续开发（工具链齐备：Rust/Tauri、Node 在 `~/node`、`~/.cargo/env`，见 HANDOFF-74 步骤 1）

## 参考

- 仓库：https://github.com/humumu130/cc-deck（用户 humumuu）
- 版本：0.4.22（手机端装 0.4.22-test）
- 家目录 `PROJECT_STATUS_REPORT.md` / `QUICK_START_GUIDE.md` 属于 Pipecat 语音项目，与本仓无关
