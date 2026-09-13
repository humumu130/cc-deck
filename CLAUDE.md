# cc-deck 项目规则

> 2026-09-13 Mac 接管后立（对齐 HANDOFF-75 与既有发版惯例）。

## 发版流程（三段式）

1. **本地测试**：先本地打包测试，版本号带 `-test` 后缀。
   写法先例（0.4.22-test 全覆盖）：`expo-app/app.json` 的 expo.version、`expo-app/android/app/build.gradle` 的 versionName、`web-console/index.html` 的 CONSOLE_VERSION、`desktop-tauri/package.json`——四处同步，漏一处就版本号打架。
2. **Snapshot 包**：本地测试通过后发 snapshot。
   惯例：bump 版本提交（`chore: bump X.Y.Z（snapshot 批：#A-#B 概要）「snap」`）→ 推 `v<X.Y.Z>-snap.N` tag 触发 CI。snap 产物只在 Actions run（不建 GitHub Release、不上传 latest.json 清单）；CI 会把 tag 后缀烙进 versionName，手机端"关于"显示完整通道版本 + "快照版"角标。
3. **Release 包**：snapshot 攒了几批、连续使用几天无问题后发正式版。
   `v<X.Y.Z>` 干净 tag → CI 建 GitHub Release 挂产物 + latest.json 轻量清单同步（双镜像，见 updates.ts 的发版八步清单注释）。

### 发版记录归档

- **不单独维护发版文档**：git tag + 提交信息 + GitHub Release 页即完整档案（单一事实源），另记一份必然漂移。
- 用户可见的版本说明：`expo-app/src/updates.ts` 的 `VERSION_NOTES` 随正式版同步维护（措辞纪律见该文件注释）。

## 环境备忘

- 直连 github.com 超时，git 走仓库本地配置的 `http.https://github.com/.proxy`（Clash 127.0.0.1:7890）；gh CLI 需手动 export 同款代理。
- 手机无线 adb：配对已完成，连接端口会漂移，先 `adb mdns services` 发现再连；adb 在 `~/Library/Android/sdk/platform-tools/`。
- relay 数据目录 `~/.cc-deck/data/`（events.ndjson 事件流、cli-pids.json、embedded-relay.log）。
