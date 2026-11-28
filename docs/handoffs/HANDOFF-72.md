# HANDOFF-72：CC Deck Mac 白屏修复——构建+装机+验证

（由 Windows 主会话交接，2026-09-11 深夜；Windows 关机清灰中，你独立完成全程）

## 背景
- 仓库 ~/dev/cc-deck 已更新到 e98000c（`git log --oneline -1` 可确认，勿改 git 状态）
- 修复内容（desktop-tauri/src-tauri/src/main.rs，**不要改动修复逻辑**）：
  1. on_navigation 白名单双形态：Windows=http://tauri.localhost，macOS=tauri://localhost（host=localhost，scheme=tauri）——旧版只认前者，mac 首次导航被拦 → WebView 透明不渲染，窗口只剩壁纸（这就是要修的白屏）
  2. node_path() 跨平台：which + 常见安装位枚举（~/node/bin 等——GUI app 的 PATH 摸不到用户 shell 的自定义路径）
- 本任务：本地构建 dmg → 装 /Applications → 验证窗口正常渲染 UI

## 环境事实
- node v22 在 ~/node/bin，**每个新 shell 要 `export PATH=$HOME/node/bin:$PATH`**
- cargo/rustc 未装，需先装 rustup（网络直连正常）
- 无风扇 MacBook Air，cargo 首次全量编译 15-25 分钟属预期，发热正常，不要中断
- Xcode CLT 已在位（git 可用）

## 步骤
1. `export PATH=$HOME/node/bin:$PATH`
2. 装 Rust：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` 然后 `source $HOME/.cargo/env`；`cargo --version` 确认
3. `cd ~/dev/cc-deck/desktop-tauri && npm ci`
4. `npx tauri build --bundles dmg`（15-25 分钟耐心等完）
5. 产物在 `src-tauri/target/release/bundle/dmg/*.dmg`
6. 装机（App 实名 "CC Deck Tauri"）：
   ```
   pkill -x "CC Deck Tauri" 2>/dev/null
   hdiutil attach "<dmg路径>"
   rm -rf "/Applications/CC Deck Tauri.app"
   cp -R "/Volumes/CC Deck Tauri"*/CC\ Deck\ Tauri.app /Applications/
   hdiutil detach "/Volumes/CC Deck Tauri"*
   xattr -dr com.apple.quarantine "/Applications/CC Deck Tauri.app"
   open -a "CC Deck Tauri"
   ```
7. `sleep 15` 等启动
8. 验证（本任务核心验收）：
   a. `screencapture -x /tmp/ccdeck-72-verify.png`
   b. 用 Read 工具读这张图：应看到 CC Deck 深色 UI（左侧会话栏+主面板+连接区），而**不是透明窗口露出桌面壁纸**——透明=修复失败
   c. 版本核验：`defaults read /Applications/CC\ Deck\ Tauri.app/Contents/Info.plist CFBundleShortVersionString`（应为 0.4.19）
   d. relay 侧：8787 若已有手动 relay 在跑（CCR_TOKEN=mactest...），内嵌版让位属正常；`curl -s http://127.0.0.1:8787/local-info` 返回 ok 即可，**不要杀它**
9. 结果写 `/tmp/ccdeck-handoff-result.md`（覆盖写）：构建成败、版本号、截图结论（UI 渲染 or 透明）、遇到的问题与处理过程

## 失败处理
- rustup/npm 下载失败：重试即可
- cargo 编译报错：完整贴到结果文件，不要自行改 main.rs 修复逻辑（明显笔误除外）
- open 后无进程/无窗口：查 `~/Library/Logs/DiagnosticReports/` 最新崩溃报告，路径贴结果文件

## 红线
- 不动 ~/dev/cc-deck 的 git 状态（不 commit/reset/checkout；stash 已 pop 回 #305 测试现场）
- 不杀 8787 已有 relay，不改 relay/ 目录
- 不装/不改系统级配置（pmset 防睡主会话已处理）
