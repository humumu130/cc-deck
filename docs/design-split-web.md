# 桌面壳 web 端拆分方案（index-005.html）· W-SPLIT-WEB 设计稿

> 2026-10-20 · 零代码设计 · 基线 698bbb2（test.45）· 对象 `web-console/index-005.html`
> 定位：三路域方案之一（桌面壳拆分路）；与另两路（域方案）交叉后由 Leader 拍板合并策略。

## 一、现状实查（全部实测，非估算）

**总量**：14160 行 / 1,219 KB 单文件，零构建零外部依赖（无 type=module、无 importmap、无外链 JS/CSS）。

**构成**：

| 层 | 行数 | 占比 | 形态 |
|---|---|---|---|
| CSS | 2,868 | 20% | 单 `<style>` 块（含暗/亮双主题 token 两套） |
| JS | 11,149 | 79% | 9 个 `<script>` 块（实质 6 块 + 诊断钩子 23 行 + 2 个 1 行桩） |
| HTML 骨架 | 143 | 1% | rail/五域容器/windowbar/toast 等静态壳 |

**JS 六大块职责画像**（天然拆分边界——现行 IIFE 隔离约定已成立）：

| 块 | 行数 | 职责 | 次级分区 |
|---|---|---|---|
| L2945 会话域 | **4,077** | 帧总线消费/会话列表/对话流渲染（MD+高亮+diff）/任务 tab/输出物 tab/输入栏/引擎菜单/右键菜单/模型与权限胶囊/artViewer | 22 分区 |
| L9457 桌面地基+设置+云桥 | **3,831** | windowbar/source-menu/设置域六面板/检查更新/服务器管理与删除/云桥 E2E 密封/配对入口/多源并行视角/快捷键系统 | 18 分区 |
| L7032 项目域+共享桥 | 1,269 | 帧总线创建（全页唯一 WS）/项目域只读聚合/团队创建表单/经验库域 | — |
| L13288 手机端 | 870 | 四屏真数据+导航栈+b2Api 适配 | — |
| L8307 通知 V3 | 293 | rail 🔔 锚定浮窗三级分组 | — |
| L2922 诊断钩子 | 23 | 全局错误显形条 | — |

**跨块耦合面（拆分要过的桥）**：块间经 `window.__ccDeck005*` 命名空间（Frames 总线/B4 共享桥/B2 会话世界/CloudUI/PathUi/LoginCard 等约 8 个全局）——**IIFE 边界已是事实模块边界**，拆分主要是物理搬移+import 显式化。

**断言套件包袱（最大迁移面）**：relay/scripts 下 11 件套件按**单文件文本锚**锁此文件（mv8a/detail2/mobile3-settings/ui-rows/005 系等）——拆分后全部锚路径失配，需随迁重定位（见 §四 阶段闸）。

## 二、拆分单位设计

**按「CSS 一抽 + JS 六块 + 命名空间契约文件」切**，对齐现行 IIFE 边界（不发明新边界）：

```
web-console/
  index-005.html          # 骨架 143 行 + <style>/<script> 引用（产物形态由方案定）
  css/
    tokens.css            # 双主题 --* 变量（暗/亮两段）
    base.css              # 布局/组件层（现 CSS 按 token/组件分区再对切）
  js/
    diag.js               # 诊断钩子（最先加载）
    frames-bus.js         # 帧总线创建（原 L7032 块头部——全页最早执行）
    project-domain.js     # 项目域+共享桥（B4）
    session-domain.js     # 会话域 4077 行（内部可再按 22 分区切子文件，二期）
    desktop-base.js       # windowbar/设置/云桥（内部 18 分区，二期可再切）
    notify.js
    mobile.js             # 依赖 b2Api 适配器（现耦合点显式化）
    contracts.js          # window.__ccDeck005* 命名空间契约（类型注释+挂载点单点——
                          # 现「B4 桥谁先创建」等隐式时序契约显式化为注释契约+启动顺序数组）
```

**顺序契约显式化**（拆分最大风险点）：现行块间加载顺序=HTML 顺序隐式保证（frames-bus 先于一切消费者、B2 导出先于手机块）。拆分后由引用清单数组（案 A）或 entry import 顺序（案 B）显式承载，`contracts.js` 注释固化「谁创建谁消费」矩阵。

## 三、技术选型两案

### 案 A：零构建（原生 ES modules，相对路径 import，不用 importmap）

- **机制**：六块改 `type="module"` + 相对 import；`window.__ccDeck005*` 命名空间保留（模块只管加载组织，运行时耦合面零改动——**改动量最小**）
- **importmap 风险规避**：bare specifier 才需要 importmap（Safari 16.4+/macOS 13.3+）——**方案采用纯相对路径**（ES modules 本体 Safari 10.1+/macOS 10.13+ 全支持），importmap 不引入，WKWebView 支持度风险归零
- **热部署链**：多文件拷贝（三处部署位目录级 cp）——`check-bundle-sync`/`check-deploy-complete` 改为**目录级**比对；**编译期嵌入面（E11 教训）不受影响**（Tauri 壳仍嵌产物，只是产物从 1 文件变 N 文件——tauri.conf resources 目录打包即可）
- **代价**：①模块加载 N 个请求（file:// 下 module 解析 OK；tauri.localhost 自定义协议 OK——WKWebView 对同源相对 module 无限制）②产物多文件=KV 分发（手机 web 通道）要多键或打包 zip——**手机 web 端与桌面壳分发的分叉点**③git diff 粒度变碎（review 习惯变化）

### 案 B：源拆 + esbuild 单文件产物（开发拆分、部署不变）★推荐

- **机制**：源按 §二 拆分（.js/.css 模块+ES import）；`node scripts/build-web.mjs`（esbuild bundle CSS+JS→**注入 html 模板生成单文件 index-005.html**）——**产物形态与今天逐字节等价级**（单文件零外链）
- **热部署链零变化**：三处部署位仍拷单文件；编译期嵌入面不变；KV/云分发不变；**E11（编译期嵌进二进制）教训面完全继承**（产物单文件=壳重编译仍唯一生效路径，认知不变）
- **发版链增量**：build-plugin.mjs（bundle relay）之外多一步 build-web——**挂进既有 `scripts/build-plugin.mjs` 同链**（同一 esbuild 依赖，CI 与本地同构）；check-bundle-sync 增「源→产物重建对比」闸（同参重建 SHA 一致——**该模式 W-RELCHAIN 已有先例**，直接复制）
- **代价**：①引入构建依赖（esbuild 已在 relay devDeps，零新增）②产物不进 git（.gitignore web-console/index-005.html + CI 构建）——**仓库形态大变**：CI/本地调试都需 build 一步（现「改 html 即生效」的开发手感消失）③**断言套件锚源文件路径全改**（11 件→锚 js/ 模块文件）④热修手改产物的应急路径失效（必须改源重建）

### 对比结论

| 维度 | A 零构建 | B 源拆+单文件产物 |
|---|---|---|
| 热部署/编译嵌入/KV 分发 | **变**（多文件） | **零变化** |
| WKWebView 兼容 | 相对路径 module 全绿 | 与今天完全一致 |
| 开发手感 | 改文件刷新即见 | 需 build（watch 模式可救） |
| 断言套件迁移 | 11 件全改锚 | 11 件全改锚（同） |
| git/审查 | 碎但直观 | 源直观+产物不进库 |

**推荐 B**：分发链零风险是压倒项（E11/热部署成对拷/KV 三处教训全在分发面），A 的多文件产物把三个已踩坑的面全部重新暴露。B 唯一实质代价（build 一步）用 esbuild watch+现有 devDeps 吸收。

## 四、分阶段路线（每阶段独立可合并）

| 阶段 | 内容 | 验证标准 | 回归闸 |
|---|---|---|---|
| **S0 基线冻结** | 产物 byte 基线（SHA）+11 件锚套件清单+CDP 走查页集 | 基线 SHA 入库 | 全件跑绿存档 |
| **S1 CSS 抽离** | tokens.css/base.css 抽出，esbuild 注回 | **产物 SHA === S0 基线**（CSS 抽离可做到 byte 级：esbuild minify 关、原序保持） | 11 锚件（锚文本未动=应全绿）+ 005 三件 CDP |
| **S2 诊断+帧总线+通知+手机四小块** | 四块独立模块化（低耦合先行） | 产物 diff 仅 import 包装行；CDP 四域走查 | ui-rows/mobile3-settings/detail2 |
| **S3 项目域+会话域** | 两大块（4077+1269）模块化+**锚件随迁**（锚文本按模块重定位——本阶段交付锚件改写） | CDP 全域走查+mock-relay 快照回放 | mv8a/005-engauth/englogin/blankset 随迁全绿 |
| **S4 桌面地基块** | 最后一块（设置+云桥 3831） | 同上 | settings 系+winpair |
| **S5 构建链收编** | build-web 挂 build-plugin 同链+check-bundle-sync 增源重建闸+CI 改源构建+产物出库（.gitignore） | 五面闸全绿+CI 出包与 S4 产物同 SHA | 全量 11 件+check-bundle-sync+check-deploy-complete |

每阶段一分支一 squash（分支纪律），任一阶段可停在「源=产物等价」态——**中途放弃零损失**（S1-S4 期间源与产物双在库，S5 才切产物出库）。

## 五、风险清单

1. **Safari/WKWebView**（案 A）：相对路径 ES modules 无风险（10.1+）；importmap 不采用（16.4+ 门槛归零）。案 B 产物与今天等价=零新面。
2. **热部署编译期嵌入**（E11）：案 B 零影响；案 A 多文件需 tauri.conf resources 目录化+三处部署位同步逻辑改写（风险面重开，不推荐）。
3. **断言套件迁移**（两案同）：11 件按单文件文本锚——迁移时锚文本本身不变（代码搬运），只改「读哪个文件」路径；建议 S3/S4 各交付一半，防一把梭回归不可辨。
4. **块间时序契约**：frames-bus 必须最先（B4 桥幂等创建）——案 B 由 entry import 顺序承载+contracts.js 注释矩阵；S2 起每阶段 CDP 首屏走查显式验证「总线就绪才消费」。
5. **会话域 4077 行单模块仍巨型**：一期按六块切（与 IIFE 边界对齐零思考成本）；二期再按 22 分区细分（本稿不含，防一期摊大饼）。
6. **应急热修路径**（案 B）：手改产物能力消失——保留 `BUILD_SKIP=1` 直改产物逃生位（源不同步时 check-bundle-sync 会红=故意让它红，逼回源改）。

## 六、与另两路交叉的拍板点

1. 案 B「产物出库」是否可接受（git 形态变化）——不可接受则退化为「产物仍入库但由构建生成」（双入库，diff 噪音换零流程变化）
2. 手机 web 通道（KV 分发单文件）与桌面壳拆分是否**分家**（手机继续消费单文件产物=案 B 天然满足；若手机也要拆=另议）
3. 11 件锚套件迁移工时（预估 0.5-1 天/阶段×3 阶段）是否随阶段走还是 S5 一次清
