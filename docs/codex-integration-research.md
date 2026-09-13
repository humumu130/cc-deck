# 调研：Codex 官方能力盘点与 CC Deck 接入评估（2026-09-13）

> 调研背景：评估 CC Deck 支持 Codex 作为第二种 agent 的可行性。所有"实测"结论均在本机（Mac M1, macOS 14.6）当日验证；官方能力以 2026-09 当期文档为准——**Codex 迭代极快（一周内 0.92→0.154 砍掉 chat 协议），本文时效性有限，动工前建议复核**。

## TL;DR

1. Codex 官方已有 CLI / 桌面 App / IDE 扩展 / 云任务 / **ChatGPT 手机 Remote**（新），纯 OpenAI 生态内"手机/异地连自家电脑"已被官方补上
2. 但官方是**单机视角 + 账号绑定 + 走 OpenAI 中转**：多机只能"逐台切换"不能聚合面板；桌面端作远程客户端仍是未实现的功能请求；本地 CLI 会话（尤其第三方模型接线的）不上云、管不到
3. CC Deck 的差异化（多源聚合、Claude+Codex 双栈、GLM 等第三方模型、自托管 relay）**依然全部成立**，但窗口期变短，建议加快
4. 接入建议：P0 用 `codex exec --json`（headless，对标 `claude -p`）做冒烟 spike；P1 再评估 `codex app-server`（实验性 JSON-RPC，桌面/IDE 同款协议）

## 一、Codex 产品形态盘点

| 形态 | 状态 | 说明 |
|---|---|---|
| CLI（终端 TUI）| 稳定，本机 0.154.0 实测 | `npm i -g @openai/codex`；`codex` 交互 / `codex exec` 非交互（headless）|
| 桌面 App | macOS + Windows | "command center"：本地+云任务管理、computer use、记忆、插件。CLI 执行 `codex app` 可启动/自动安装 |
| IDE 扩展 | VS Code / Cursor / Windsurf | marketplace "Codex – OpenAI's coding agent" |
| 云任务 | ChatGPT 网页/移动内 | 跑在 **OpenAI 沙箱**（非用户机器），需 Plus/Pro 订阅 |
| 手机 Remote | **新上线** | ChatGPT 手机 App → Remote 连自家电脑，启动/引导/审查任务（见下节）|

## 二、Codex Remote：能力与边界（三台电脑场景）

**官方机制**：被控端桌面 App 设置 → Connections → **Control this Mac or PC** 批准；远程连接**底层用 SSH 拉起远端的 codex app-server** 来管理会话。控制端是 ChatGPT 移动/桌面 App。

用户场景推演（A、B 两台跑活，C 要管理）：

- ✅ C 可以连到 A 和 B（社区确认：可连接多台主机，**在主机与线程之间切换**）
- ❌ 没有"聚合面板"：官方模型是**选设备 → 进入该机的会话**，不是把 A+B 的所有会话混排成一个视图
- ⚠️ 桌面端作远程客户端连另一台 Codex 主机**尚未实现**（open issue [#26846](https://github.com/openai/codex/issues/26846)）——当前远程控制面主要是 ChatGPT App
- ⚠️ 本地 CLI 会话（`~/.codex/sessions` 的 JSONL）**不上云**；第三方模型（如 GLM）接线的 CLI 会话更不在官方 Remote 管辖内
- ⚠️ 已知粗糙：桌面 App 对远程主机上的项目支持不全（[#10450](https://github.com/openai/codex/issues/10450)）；社区有新会话跑错本地的报告；账号绑定 ChatGPT 订阅、流量走 OpenAI 中转、国内有网络/支付门槛

## 三、与 CC Deck 模型对照

| 维度 | Codex 官方 | CC Deck |
|---|---|---|
| 设备模型 | 单机视角，逐台切换 | 多源聚合面板（源/终端模型）|
| Agent 生态 | 仅 OpenAI | Claude + Codex 双栈（可扩展）|
| 模型供给 | ChatGPT 订阅/OpenAI API | 任意第三方（GLM Coding Plan 已验证）|
| 架构 | OpenAI 云中转 | 自托管 relay，数据不经第三方 |
| 本地会话发现 | 无 | 自动嗅探本地 Claude/Codex 会话 |
| 移动端 | ChatGPT App 内嵌 Remote | 独立 App（expo），可做双栈统一入口 |

**结论**：官方补掉的是"OpenAI 生态内单机远程"这个单点；多源 × 双栈 × 第三方模型 × 自托管的组合官方结构性做不了。挤压真实存在（Remote 体验会是官方级顺滑），速度是关键。

## 四、接入点技术细节

1. **`codex exec --json`**（P0）：非交互 headless，输出 JSON 事件流。对标 `claude -p`，最小改动进 relay 的 agent-adapter
2. **`codex app-server`**（P1，实验性）：JSON-RPC 服务，桌面 App/IDE 扩展同款协议，富交互（流式、会话管理、审批）。API 未稳定，勿重仓
3. **本地会话嗅探**：`~/.codex/sessions/*.jsonl`（JSONL，含会话元数据）——relay 现有本地发现逻辑可复用，加一种格式解析
4. **配置面**：`~/.codex/config.toml`（provider/模型/key）+ `~/.codex/models.json`（模型目录）。注入第三方 provider 即改这两个文件，可程序化生成
5. **认证差异**：Codex 无 Claude 的 trust 对话框概念，但有 git 目录信任检查（`--skip-git-repo-check`）与审批模式（`--full-auto`/sandbox 档位），注入语义与 Claude 不同，relay 的会话注入模块要按此适配
6. **沙箱差异**：macOS Seatbelt / Linux Landlock，与 Claude 的终端会话模型不同，远程执行的审批流要单独设计

## 五、GLM Coding Plan 接线（本机已验证，可直接抄）

官方文档：https://docs.bigmodel.cn/cn/coding-plan/tool/codex

- **必须用 Responses 协议端点** `https://open.bigmodel.cn/api/v1`（新版 Codex 已砍 `wire_api = "chat"`，老的 `coding/paas/v4` 端点会 404）
- `~/.codex/config.toml`：`model_provider="ZAI"`、`model="glm-5.3"`、`model_reasoning_effort="max"`、`model_catalog_json=~/.codex/models.json`、provider 块内 `base_url` + `experimental_bearer_token` + `wire_api="responses"`
- `~/.codex/models.json`：官方模板声明 glm-5.3（1M 上下文）与 glm-5-turbo（200k，agent 优化）
- 实测：`codex exec "Reply with exactly: OK"` → glm-5.3 回 OK，~3k tokens（含 reasoning）
- 坑：npm 新装二进制若被 Gatekeeper 弹窗/秒杀（exit 137），`xattr -cr <vendor目录>` 即愈；版本升级可能随时再变协议

## 六、SSH vs WS/HTTP+云桥：传输层取舍（结论：主干不动）

Codex Remote 底层是"SSH 上去拉起 codex app-server，再说 JSON-RPC"——SSH 只是门（传输+认证+引导），与云桥解决的是同一层（够到 NAT 后的机器）。

对比：SSH 直连在 NAT 穿透（仍需跳板=换协议的云桥）、移动弱网（TCP 半开经典痛点）、浏览器端（说不了 SSH）、源端零配置（Windows 要装 sshd）上全面劣于现有 WS/HTTP+云桥；优势仅在认证成熟与对 Codex 官方同构。

吸收建议：
1. **Codex agent 走官方同构**：relay 内嵌 `ssh2`（纯 JS）连目标机拉起 `codex app-server`，行为对齐官方 Remote
2. **SSH 只当门、WS 当路**：若做 SSH 直连高级模式，SSH 仅做可达性+端口转发到本地 relay 的 WS 端口——协议栈/配对/会话逻辑零改动，Claude+Codex 通吃

## 七、建议 Spike 路线

1. **P0（1-2 天）**：relay 新增 Codex agent 类型，`codex exec --json` 打通"web-console/手机同时看到 Claude 与 Codex 会话"单场景 demo
2. **P1（评估后）**：`codex app-server` 富接入可行性验证（流式/审批/多会话），跟踪其 API 稳定性
3. **风险清单**：版本协议漂移（常态化）、实验 API 变更、沙箱/审批语义差异、官方 Remote 持续蚕食单机远程场景

## 参考链接

- 官方发布：https://openai.com/index/work-with-codex-from-anywhere/
- Remote 文档：https://learn.chatgpt.com/docs/remote-connections · https://learn.chatgpt.com/docs/remote
- 手机远程实践：https://developers.openai.com/blog/mastering-codex-remote-for-engineering
- openai/codex 仓库：https://github.com/openai/codex
- 智谱 Codex 接入：https://docs.bigmodel.cn/cn/coding-plan/tool/codex
- 本机配置参考：`~/.codex/config.toml`、`~/.codex/models.json`（key 与 Claude Code 共用，已验证）
