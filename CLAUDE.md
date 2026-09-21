# cc-deck 项目规则

> 2026-09-13 Mac 接管后立（对齐既有发版惯例；内部交接文档在 ~/.cc-deck/handoffs/，不入库）。

## 分支与提交纪律（2026-09-20 用户拍板）

- **默认 dev 直推 + 任务号逐笔提交**：一事项一提交（设计稿/实现/follow-up 可分多笔，每笔完整原子），无 WIP 提交。任务号（#NN）就是逻辑分支——`git log --grep '#NN'` 即任务聚合视图，不靠物理分支分层。
- **分支触发条件（唯一）**：两个 AI 会话需要同时改同一批文件时，后开工的开 `feat/NN-xxx` 临时分支隔离，完事 squash 回 dev（并行交错的历史才值得 squash；串行工作流不产生交错噪声）。分支是工具不是仪式，默认不开。
- **不重写已推送历史**：dev 单主干 + tag 三段式发版依赖历史稳定，已 push 的提交禁止 rebase/reset 改写。
- **多会话工作区纪律**：动工前 `git status` 认领本次要改的文件；提交前 `git diff` 核查每处改动归属本任务，混入其他任务未提交改动时用 `git add -p` 拆分提交，严禁一笔试多件事。

## 发版流程（三段式）

1. **本地测试**：先本地打包测试，版本号带 `-test` 后缀。
   写法先例（0.4.22-test 全覆盖）：`expo-app/app.json` 的 expo.version、`expo-app/android/app/build.gradle` 的 versionName、`web-console/index.html` 的 CONSOLE_VERSION、`desktop-tauri/package.json`——四处同步，漏一处就版本号打架。
2. **Snapshot 包**：本地测试通过后发 snapshot。
   惯例：bump 版本提交（`chore: bump X.Y.Z（snapshot 批：#A-#B 概要）「snap」`）→ 推 `v<X.Y.Z>-snap.N` tag 触发 CI。snap 产物只在 Actions run（不建 GitHub Release、不上传 latest.json 清单）；CI 会把 tag 后缀烙进 versionName，手机端"关于"显示完整通道版本 + "快照版"角标。
3. **Release 包**：snapshot 攒了几批、连续使用几天无问题后发正式版。
   `v<X.Y.Z>` 干净 tag → CI 建 GitHub Release 挂产物 + latest.json 轻量清单同步（双镜像，见 updates.ts 的发版八步清单注释）。

### 更新说明军规（cc-deck 特化落点）

通用五军规/排版结构/通道精度见全局 ~/.claude/CLAUDE.md「更新说明军规」节（2026-09-21，权威，持续打磨）。本节只记项目特化：

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
