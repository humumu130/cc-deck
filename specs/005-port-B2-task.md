# 005 换壳 B2 任务书：会话域全功能迁移（#d-session）

> 任务代号 #143-B2。Claude 执行。在你的专属 worktree 施工，**不 commit**（Leader 核验后代提交）。

## 背景与施工位置

B1 已交付 `web-console/index-005.html`（005 壳骨架+会话列表真数据，已过盲评闸，提交 a273dbf）。本批把**会话域**的全部功能从旧 `web-console/index.html`（v1，776KB）迁入新壳。先读 `specs/005-port-B1-report.md` 的偏差表 D01-D20——特别是 D11-D14（连接/协议代码怎么拷、怎么备案）与 D15（选中态/CTA 先例）。

## 施工边界（铁律，违反=返工）

1. **只允许改动 `#d-session` 这个 `<section>` 区间内部**（含区间内新增内联 `<script>` 块）。文件其余部分——`<style>`、底部地基脚本（连接/SNAPSHOT/主题/init 链）、其他 section、mobile 屏、rail——一律禁改。
2. `<style>` 与 005 原型逐字节一致是过闸资产，**禁改**。新功能必须装进 005 既有组件形态（卡/行/pill/段签/readonly-banner）；确需新样式 → 报告写「契约请求」，不得私加。
3. 需要地基新钩子（如增量事件消费、COMMAND 发送通道）→ 同样写「契约请求」，不得自行改地基脚本。B1 的 D13 只消费全量 SNAPSHOT；若你需要 SESSION_UPDATED/LOG 等增量事件，属契约请求。
4. 偏差备案制：与 005 原型的一切偏差逐条编号（B2-D1 起）进报告。
5. 不 git add/commit；不动本 worktree 外任何文件；沙盒自测必须全套隔离 env；截图只存 /tmp。

## 迁移范围（#d-session 域内）

按旧版功能面对照，最小闭集：

1. **对话流**（中央列）：消息渲染（用户气泡/助手块/工具调用卡）、时间分隔行、待办行动卡（允许/拒绝按钮 → 真协议 COMMAND_CONTINUE/审批链）、流式更新。旧版参照：v1 index.html 帧分发器与渲染段。
2. **输入栏**（footer composer）：发送、停止、历史消息上下翻（#79 已在 005 定过形态）、附件/图片粘贴拖入（#79）。
3. **任务 tab**（segment-bar「任务」）：todosTabHtml 四组制+VERIFY_RE 跳转逻辑。
4. **输出物 tab**：产物行（目录分组+批量下载，#52 形态）。
5. **用量 tab**：context meter（005 检查器里已有分段条形态）。
6. **头部联动**：选中会话 → workspace-head 的 title/sub/status tag/engine badge 更新（D15 已留选中态钩子）。
7. **「+」新建**：开卡入口接引擎选择器（#75 形态：多引擎菜单）。

范围大，允许报告里标「本轮完成 X，遗留 Y 建议 B2b」——但不许拿占位冒充完成。

## 自测（缺一注明原因）

沙盒配方（B1 验证过；端口用 **8796**，全量隔离）：

```bash
mkdir -p /tmp/005-b2/webroot/web-console
cp <你的worktree>/web-console/index-005.html /tmp/005-b2/webroot/web-console/index.html
cp /Users/xdd/dev/cc-deck-m1/web-console/nacl.js /Users/xdd/dev/cc-deck-m1/web-console/qr.js /tmp/005-b2/webroot/web-console/
env CCR_PORT=8796 CCR_DATA_DIR=/tmp/005-b2/data CCR_ORG_DIR=/tmp/005-b2/org CCR_TOKEN=b2devtoken CCR_WEB_ROOT=/tmp/005-b2/webroot CLAUDE_CONFIG_DIR=/tmp/005-b2/claude CCR_NO_LEADER=1 CCR_NO_MDNS=1 CCR_NO_BRIDGE_MIRROR=1 CCR_NO_TITLE_GEN=1 CCR_CLOUD_URL= npm run dev --prefix /Users/xdd/dev/cc-deck-m1/relay
# 等 60s 启动风暴（CPU 高属常态）→ curl http://127.0.0.1:8796/ 应 200
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --screenshot=/tmp/b2-shot-1440.png --window-size=1440,900 --virtual-time-budget=9000 "http://127.0.0.1:8796/?token=b2devtoken"
```

沙盒无会话时列表为空态——需要真数据就往 `/tmp/005-b2/data` 的 sqlite/会话存储造（或用 CCR_CWD 指到有 ~/.claude/projects 回放的目录），怎么造的备案什么。用完按 PID 定点杀 relay。

## 交付

`specs/005-port-B2-report.md`：首行一句话结论 → 完成项/遗留项 → 自测结果（含截图路径）→ 偏差备案表（B2-D1 起）→ 契约请求清单。stdout 最后一行输出 `B2-DONE` 或 `B2-BLOCKED: 原因`。
