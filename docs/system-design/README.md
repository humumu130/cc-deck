# 系统设计图纸（system-design）

> W-DESIGNHUB（2026-10-12）入仓：面板「系统设计」浏览入口的数据面。relay 扫描本目录
> 生成清单（SNAPSHOT.design_docs）并在 `/design/<相对路径>` 原样静态服务；桌面端
> 设置→关于「系统设计图纸」区列全局图纸，项目域总览按项目名/锚点分词匹配列项目相关
> 图纸。移动端 backlog。

## 收录口径

- **只收浏览面**：archify 产出的自包含 HTML 图纸（+同名 .json 元数据）。HTML 原样
  渲染不二次加工（图纸自带深浅主题与交互）。
- **不收**：PNG 截图证据（visual-check/fit，留 ~/.cc-deck/artifacts 原位）、md 报告
  （归 docs/ 对应区）、原型页（artifacts-panel-proto 等——原型非系统设计）。
- **目录即分组**：一级子目录名 = 面板分组标题（如「005-换壳」）；根目录文件 =
  「全局」组。
- **项目关联**：目录名+文件名分词即 tags（`005-换壳/warch-01…` → 005/换壳/warch/01/…）；
  项目域按项目组 name/锚点目录分词取交集匹配，当前图纸均无项目专属归属（全部走
  设置→关于全局入口），后续项目图纸放对应命名子目录即自动挂上。

## 清单

| 文件 | 标题 | 组 |
|---|---|---|
| fig-patrol.html | 巡检哨兵：双层定时监控 | 全局 |
| fig-night-watch.html | 夜班看门监控机制 | 全局 |
| 005-换壳/warch-01-system-architecture.html | cc-deck 系统架构与信任边界 | 005-换壳 |
| 005-换壳/warch-02-team-dispatch-flow.html | cc-deck 团队模式 · 分诊派单协作流程 | 005-换壳 |
| 018-后端实施/018-01-fig-architecture.html | CC Deck M2 · 混编团队系统全景 | 018-后端实施 |
| 018-后端实施/018-02-fig-dataflow.html | M2 信息流 · 一张任务单的旅程 | 018-后端实施 |
| 018-后端实施/018-03-fig-workflow.html | M2 工作流 · order 生命周期 | 018-后端实施 |
| 018-后端实施/018-99-index.html | 018 后端实施方案 · 交付物目录 | 018-后端实施 |
| 019-值守设计/019-fig-duty-workflow.html | Leader 值守 v3 · 工作流程 | 019-值守设计 |

## 分发

- dev：webRoot=仓库根，`docs/system-design/` 天然可达。
- 插件包：`relay/scripts/build-plugin.mjs` 递归拷贝至 `out/docs/system-design/`。
- 桌面 relay-service（~/.cc-deck/relay-service/）：部署时需同步拷贝本目录（部署脚本
  批处理，见 W-DESIGNHUB 回执备案）；缺目录时清单为空、入口自动隐藏（能力位口径）。
