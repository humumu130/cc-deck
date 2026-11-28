# HANDOFF-74：Mac 窗口按钮原生红黄绿——增量构建+装机+验证

（Windows 主会话交接第二弹；上一单 HANDOFF-72 已完成，工具链你装的 Rust 还在）

## 背景
- 仓库已 pull 到 64cbd07（#74：Mac 版窗口控制按钮从网页自绘 Windows 风改为系统原生左上红黄绿三圆点）
- 实现方式：tauri.macos.conf.json 平台覆盖（decorations=true + titleBarStyle=Overlay）+ 网页标题栏左侧 78px 圆点安全区 + 右侧自绘按钮组在 mac 隐藏
- **不要改任何代码**，只做构建装机验证

## 步骤
1. `export PATH="$HOME/node/bin:/usr/local/bin:$PATH"; source $HOME/.cargo/env`
2. `cd ~/dev/cc-deck/desktop-tauri && npx tauri build --bundles dmg`（增量编译，预计 2-5 分钟）
3. 装机：
   ```
   pkill -x cc-deck-desktop-tauri 2>/dev/null   # 注意进程实名（上一单的坑）
   hdiutil attach src-tauri/target/release/bundle/dmg/*.dmg
   rm -rf "/Applications/CC Deck Tauri.app"
   cp -R "/Volumes/CC Deck Tauri"*/CC\ Deck\ Tauri.app /Applications/
   hdiutil detach "/Volumes/CC Deck Tauri"*
   xattr -dr com.apple.quarantine "/Applications/CC Deck Tauri.app"
   open -a "CC Deck Tauri"
   ```
4. 验证（写进结果文件）：
   a. **红黄绿三圆点存在性（核心验收）**：
      `osascript -e 'tell application "System Events" to tell (first process whose name contains "cc-deck") to get name of every button of window 1'`
      返回含 close/minimize/zoom 三个按钮名 = 系统圆点在位 ✅（这是原生 traffic lights 的 AX 表现）
   b. 若上面查询报错（辅助功能权限），改查窗口是否带标题栏：编译一个小工具或用
      `osascript -e 'tell application "System Events" to tell (first process whose name contains "cc-deck") to get size of window 1'`（仅辅助）
   c. 窗口正常渲染复查：`lsof -i :8787 | grep -i webkit`（页面 WebSocket 在=UI 活着，同上单证据法）
5. 结果**追加**写 `/tmp/ccdeck-handoff-result.md`（不覆盖上一单记录）：构建成败、按钮查询原始输出、版本（应仍 0.4.19）

## 若构建失败
- 完整贴 cargo/tauri 错误到结果文件，**不要尝试改代码**（Windows 侧会接手）

## 红线（同上单）
- 不动 git 状态；不杀 8787 relay；不改 relay/ 目录；不改系统配置
