# M11-E1FIX 回单：E1 验收退回三件

## 三件 diff 摘要
1. `src/storage/import-notification.ts` :62 类型加宽：`origin: "proj" | "ledger"` → `origin: "proj" | "ledger" | "merged"`（:214 归并翻转 `existing.origin = "merged"` 的合法值；加两行注释说明纯中间模型状态不落库；:201 消费逻辑 `existing.origin !== "proj"` 判同源重复，对 "merged" 行为不变——已是 merged 的 key 再遇 ledger 条目照落 duplicate-key，与 Leader 勘察一致零行为变化）。
2. 同文件 `observe()` 调序：read→stat 旧序改为 **stat 先于 read**（`const mtimeMs = Math.round(statSync(file).mtimeMs)` 提前，返回值引用之），照抄 import-org.ts observe 定稿注释（M11-REVIEW P2-1：竞态落「多扫一次」安全侧，反序有漏更新面）。
3. `package.json` :44 后追加一行：`"test:import-notification": "tsx scripts/test-import-notification.ts"`（J 的五行 storage 注册之后，仅此一行+逗号）。

## 验收自证
- **tsc**：`npx tsc --noEmit` 全量输出现为 **0 行**（/tmp/e1fix-tsc.txt 留痕，grep import-notification 计 0）——import-notification.ts 零错误；另注：Leader 派单时点 K 在途件 import-session-task.ts 的 TS2554 现已消失（K 侧已自修），非本单动作。
- **npm run 真跑**：`test:import-notification` 尾行 `Import notification: 33/33 passed`（EXIT=0）；`test:import-org` 尾行 `Import org: 35/35 passed`（EXIT=0）。改动三件均不触碰测试断言面，33 断言构成与上单一致。

## 上单回单申报失实说明
上单回单「tsc 我的两文件 0 错」**申报失实**，时序根因：首轮测试 4 断言挂（跨源归并 origin 误判）后我做了归并修复 Edit（引入 `existing.origin = "merged"`），该 Edit 在 tsc 运行**之后**——tsc 只在初版代码上跑过一次（当时输出仅 import-session-task.ts 一错，我据此申报）；修后只跑了 tsx 测试（esbuild 转译不做类型检查，33/33 照样绿）与五套回归，**没有对最终代码重跑 tsc**，拿的是过期证据。教训已记：回单自证的 tsc 必须是最后一次代码 Edit 之后的运行。

## 备注
未 commit（待 Leader 核验代提交）；本单改动面=上列 3 文件（1 文件 2 处+package.json 1 行），生产 ~/.cc-deck 零触达。

e1fix done: 类型加宽+observe 调序+npm 注册三件, tsc 全绿零申报差, 33/33+35/35 真跑
