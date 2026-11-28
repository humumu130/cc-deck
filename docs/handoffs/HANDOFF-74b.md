# HANDOFF-74b：第四轮 mac 无标题栏 + App 改名——构建装机验证

（第三单；上一单红黄绿已验证生效，用户目验后两轮迭代：顶栏整个撤掉+应用名去 Tauri）

## 本单改动（已 pull 到 9f783ba，勿改代码）
- mac 上整个顶栏撤掉（Slack/Notion 无标题栏范式），圆点浮在侧栏上方，侧栏头让出安全区并接棒拖拽
- productName: "CC Deck Tauri" → "CC Deck"——**产物 App 名变为 CC Deck.app**，安装/卸载路径都变

## 步骤
1. `export PATH="$HOME/node/bin:/usr/local/bin:$PATH"; source $HOME/.cargo/env`
2. `cd ~/dev/cc-deck/desktop-tauri && npx tauri build --bundles dmg`（增量，2-5 分钟）
3. 装机（注意新名字 + 卸旧名 App）：
   ```
   pkill -x cc-deck-desktop-tauri 2>/dev/null
   hdiutil attach src-tauri/target/release/bundle/dmg/*.dmg
   rm -rf "/Applications/CC Deck Tauri.app" "/Applications/CC Deck.app"
   cp -R "/Volumes/CC Deck"*/CC\ Deck.app /Applications/   # 卷名/App 名以实际挂载为准（可能带版本号后缀，先 ls /Volumes/ 票一眼）
   hdiutil detach "/Volumes/CC Deck"*
   xattr -dr com.apple.quarantine "/Applications/CC Deck.app"
   open -a "CC Deck"
   ```
4. 验证（写结果）：
   a. App 名：`ls /Applications | grep -i deck` 应只有 CC Deck.app；`defaults read /Applications/CC\ Deck.app/Contents/Info.plist CFBundleName`
   b. 红黄绿圆点在位（同上单 System Events 查 buttons）
   c. **顶栏撤掉**：窗口顶部直接是侧栏内容（左侧栏头部），圆点浮在侧栏上方——用 System Events 查 window 1 的 UI element 结构描述（有无 title bar element）
   d. 页面活着：`lsof -i :8787 | grep -i webkit`
   e. 报告窗口内容区顶部布局的文字描述（侧栏头是否正常让位）
5. 结果**追加** /tmp/ccdeck-handoff-result.md；stdout 会被用户侧查看

## 红线
不动 git；不杀 8787 relay；不改代码；不改系统配置
