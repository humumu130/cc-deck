# cc-deck 项目规则

> 2026-09-13 Mac 接管后立（对齐既有发版惯例；内部交接文档在 ~/.cc-deck/handoffs/，不入库）。

## 分支与提交纪律（2026-09-20 立基；2026-10-10 用户两次拍板收敛拓扑/命名/粒度）

- **单主干拓扑（2026-10-10 用户拍板）**：`dev` = 新版唯一开发主干（relay 源码与壳端 UI 同线完备，**出包直接 tag dev**，原 feat/005-win-shell 出包线已并回退役）；`legacy/v0.6` = 旧版归档线（指 v0.6.3）；`main` = 门面快照。其他分支一律是围绕主线的短命工作线，用完即并即删，攒着就是乱源。
- **分支命名规范（2026-10-10 起）**：主线 `dev` / `main` / `legacy/v<版本>`；工作线 `<type>/<英文短横线slug>`（type ∈ feat/fix/diag/build），**禁止**内部里程碑编号入名（feat/005-win-shell、build/064test1 为反面教材）、禁止连字符混型（feat-240-rel 为反面教材）。
- **分支时机：非小修一律分支（2026-10-10 用户拍板）**：一行小修可直推 dev；其余一切（bug 修复、功能、重构）开 `<type>/<slug>` 短命分支开发——分支内提交随意（WIP 也行），完事 **squash 成一笔回 dev**（`git merge --squash` 后按规范信息提交，带 #NN），分支即删。多会话并行同改同批文件时同样各开分支（叠加下方 worktree 铁律）。
- **装机反馈批的分支口径（2026-10-10 用户问询后补）**：用户试用一次反馈多条小问题 = 每条入任务单分诊，按主题/冲突面拆给 worker——**一个 worker 一条 `fix/<批次slug>` 分支**，批内逐条提交，最后 squash 一笔回 dev（提交 body 列逐条清单）。事项边界 = 分支边界：不同 worker/不同主题各算各的一笔，不混不拆。单条紧急 bug 同样走分支，只是分支生命周期更短。
- **提交粒度：dev 上一事项一笔（2026-10-10 用户拍板）**：dev 历史 = 一笔一事项（一笔 bug 修复 / 一笔功能）。分支 squash 回来的天然一笔；确需直推 dev 的小修，过程中可多次本地提交，但 **push 前必须 fixup/amend 收口成一笔**（修复+测试+关联 follow-up 合并；打包、版本 bump 另成独立 chore 笔）。已 push 的提交不可再收口（下方不重写历史纪律），所以**先收口再 push** 是铁律。
- **main = 门面快照分支（2026-10-03 起）**：仓库 default branch，访客与外部 PR 看到的是它；**不在其上开发**；发正式版打 tag 后快进同步 `git push origin v<X.Y.Z>:main`（推广期改了 README 想立刻上门面也可随时手动快进 `git push origin origin/dev:main`）。
- **并行开发强制 worktree 磁盘隔离（2026-09-27 增补，用户令）**：分支只隔离提交历史，`~/dev/cc-deck` 磁盘文件全体会话共享一份——多会话并行时，后开工方必须 `git worktree add` 独立目录做开发编辑，只拉分支不挪目录等于没隔离。构建读磁盘不认分支，混合工作区里打出的 bundle 必然扫进别人的未提交代码（2026-09-27 relay 坏包打挂生产的事故根源）；此期间禁止构建/热部署，部署前必跑 `scripts/check-bundle-sync.sh`。
- **不重写已推送历史**：dev 单主干 + tag 三段式发版依赖历史稳定，已 push 的提交禁止 rebase/reset 改写（分支未 push 前 fixup/squash 随意）。
- **多会话工作区纪律**：动工前 `git status` 认领本次要改的文件；提交前 `git diff` 核查每处改动归属本任务，混入其他任务未提交改动时用 `git add -p` 拆分提交，严禁一笔试多件事。

## 发版流程（三段式）

1. **本地测试**：先本地打包测试，版本号带 `-test` 后缀。
   写法先例（0.4.22-test 全覆盖）：`expo-app/app.json` 的 expo.version、`expo-app/android/app/build.gradle` 的 versionName、`web-console/index.html` 的 CONSOLE_VERSION、`desktop-tauri/package.json`——四处同步，漏一处就版本号打架。
2. **Snapshot 包**：本地测试通过后发 snapshot。
   惯例：bump 版本提交（`chore: bump X.Y.Z（snapshot 批：#A-#B 概要）「snap」`）→ 推 `v<X.Y.Z>-snap.N` tag 触发 CI。snap 产物只在 Actions run（不建 GitHub Release、不上传 latest.json 清单）；CI 会把 tag 后缀烙进 versionName，手机端"关于"显示完整通道版本 + "快照版"角标。
3. **Release 包**：snapshot 攒了几批、连续使用几天无问题后发正式版。
   `v<X.Y.Z>` 干净 tag → CI 建 GitHub Release 挂产物 + latest.json 轻量清单同步（双镜像，见 updates.ts 的发版八步清单注释）→ **main 快进到该 tag**（`git push origin v<X.Y.Z>:main`，门面分支与发版同步）。

### 更新说明军规（cc-deck 特化落点）

通用六军规/排版结构/通道精度见全局 ~/.claude/CLAUDE.md「更新说明军规」节（2026-09-21 定立、2026-09-22 补措辞语气条，权威，持续打磨）。本节只记项目特化：

- 数据结构：`VERSION_NOTES: { group: "new"|"improved"|"fixed"; text: string; note?: string }[]` + `VERSION_DATE`，在 expo-app/src/updates.ts，随版本同步维护；消费端 = 手机关于弹窗（SettingsDrawer AboutModal）。
- 桌面端发版说明（Tauri）与 GitHub Release body 同口径：Release 正文放全量细节（弹窗「查看完整变更」的落地页）。
- test/snap 通道 notes（latest-test.json 等）由提交聚合生成，不人工收敛；正式版（latest.json + VERSION_NOTES）人工收敛到军规内。
- 反例来历：0.6.0 首版 13 条 32 行平铺被用户骂「跟狗屎一样堆起来」（2026-09-21），调研后定军规。

### 发版记录归档

- **不单独维护发版文档**：git tag + 提交信息 + GitHub Release 页即完整档案（单一事实源），另记一份必然漂移。
- 用户可见的版本说明：`expo-app/src/updates.ts` 的 `VERSION_NOTES` 随正式版同步维护（措辞纪律见该文件注释）。

## 交付物投递约定（2026-09-19，#69 意图声明制）

- **项目内交付物**（用户明确让输出的报告/文档）：写到它本该在的位置（如 `docs/`），随后 `~/.cc-deck/bin/deliver <绝对路径>` 登记——文件不搬动，看板只记录（tools 标「登记」）。登记数据持久化在 relay `data/deliverables.json`，重启回放会挂回。
- **全局一次性产物**（ui-review 页面等）：直接写 `~/.cc-deck/artifacts/` 即视为交付（任意格式自动收录，CCR_ARTIFACTS_DIR 可覆盖）。
- 代码/配置文件改动**不算**交付物；旧的扩展名白名单启发式已彻底废除（relay/src/session-manager.ts 文件头注释是口径权威）。

## 环境备忘

- 直连 github.com 超时，git 走仓库本地配置的 `http.https://github.com/.proxy`（Clash 127.0.0.1:7890）；gh CLI 需手动 export 同款代理。
- 手机无线 adb：配对已完成，连接端口会漂移，先 `adb mdns services` 发现再连；adb 在 `~/Library/Android/sdk/platform-tools/`。
- relay 数据目录 `~/.cc-deck/data/`（events.ndjson 事件流、cli-pids.json、embedded-relay.log）。
