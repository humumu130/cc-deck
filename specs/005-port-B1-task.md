# 005 换壳 B1 任务书：web-console 新立 005 壳骨架（index-005.html）

> 任务代号 #143-B1。Leader 派单，Codex 执行。交付=文件+报告，**不 commit**（Leader 核验后代提交）。

## 背景一句话

生产网页端现为旧 v1 布局；用户要的新 UI = `specs/005-prototype-a.html`（rail 侧边导航 + 五 workspace）。本批把 005 壳立进 web-console，形成并行新前端骨架；旧 `index.html` 一字不动。

## 产出物（只新增这两个文件）

1. `web-console/index-005.html` —— 005 壳骨架 + 最小真实数据绑定（见范围）
2. `specs/005-port-B1-report.md` —— 自测报告 + 偏差备案表

## 铁律（违反=返工）

1. **逐字照抄**：005 的 `<style>`（约 L7–L1075）、DOM 骨架（rail + 五 workspace + SVG symbol 图标 + mobile 视图）、theme 体系，从 `specs/005-prototype-a.html` 原样搬运。禁止自创样式、禁止改字号/间距/配色/圆角/字体。
2. 任何必要偏差（删除演示数据桩、占位文案微调、为绑定真实数据加钩子属性）→ 逐条写入报告「偏差备案表」：位置 + 原因 + 内容。没有备案的偏差按私改算。
3. 只新增/修改上列两文件；**不改** `index.html`、relay 源码、其他任何文件。
4. 不 `git commit` / 不 `git add`；不跑 `build-plugin.mjs`；不碰 `/Applications`；不碰端口 8787/8788（生产与 M2 实例）。
5. 不打印任何 token/密钥文件内容。
6. 沙盒 relay 用完按 PID 定点杀，不留残留进程。

## 范围（B1 只做这些）

- **壳**：rail（会话/团队/项目/通知/设置 + 主题切换钮）、五 workspace（`#d-session`/`#d-team`/`#d-project`/`#d-notify`/`#d-settings`）、mobile 视图、SVG symbol、浅/深主题——全部来自 005 原型。
- 保留 005 自身的壳交互 JS（rail 域切换、主题切换、segment-bar 切换）；其中演示数据注入与真数据绑定冲突的部分，剥离并备案。
- **真实绑定仅一项**：连接 relay（ws + SNAPSHOT），`#d-session` 的会话列表用 SNAPSHOT 真数据渲染。连接与协议代码可从 `web-console/index.html` 整段拷贝进 `index-005.html`（拷了什么备案什么）。token/端口从 URL `?token=` 与页面既有约定获取，同 index.html 口径。
- 其余区域保留原型占位，加 `data-stub="B2"`/`"B3"`… 标记待迁批次。

## 自测（三件，缺一须注明原因）

1. **结构锚点**：grep 断言 rail-btn data-domain 五域齐全、五 workspace id 齐全、SVG symbol 齐全；`<style>` 块与 005 做 diff，除备案差异外逐字节一致。
2. **沙盒起服**：relay 目录下
   `CCR_PORT=8795 CCR_DATA_DIR=/tmp/005-b1/data CCR_ORG_DIR=/tmp/005-b1/org CCR_TOKEN=b1devtoken npm run dev`
   等 60s（boot 启动风暴 CPU 高属常态）后 curl 根路径返回 200；index-005.html 可达（按 relay webRoot 实际行为选择伺服路径或 file:// 加载，怎么验的备案什么）。
3. **浏览器验证**：用 playwright（`/usr/local/bin/playwright`）无头加载页面，断言无 console error、rail 五钮可见、会话列表组件正常渲染（空态或沙盒会话均可，不强建造数据）。截图存 `/tmp/005-b1-shot-*.png`（只存 /tmp）。

## 报告格式（specs/005-port-B1-report.md）

首行一句话结论 → 改动文件清单 → 三件自测结果 → 偏差备案表 → 遗留问题。
