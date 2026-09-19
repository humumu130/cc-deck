# 打包发版体系设计（#24）

> 2026-09-20 定稿。本文把散落在 CLAUDE.md、脚本注释与 CI workflow 里的发版机制收拢成体系全貌：
> 版本与通道模型、三段式流程、分发基础设施、端上更新链、下载通道可见性、护栏对照。
> 定位是「现状权威描述 + 已知约束 + 改进提案」——除标注【提案】外均为已实施现状。

## 0. 背景这套体系是怎么长出来的

发版体系不是一次性设计，是一串事故各自催生护栏、护栏叠加成网的结果：

| 事故 | 教训 | 落下的护栏 |
|---|---|---|
| 版本链断裂（09-14）：三处 relay.mjs 不一致，装的包与仓库脱钩 | 产物必须与仓库强一致 | `check-bundle-sync.sh`（md5 三处 + 诊断桩 + 语法检查） |
| 0.4.18.1 四段版本号产物错乱（09-11） | Tauri/npm 不认四段 semver | VERSION 文件锁三段 semver |
| 版本显示不同步（#394） | 四处版本号手工同步必漏 | `version.mjs --write` 五落点单一事实源 |
| colorOf 未定义引用出包即闪退（09-17） | release 构建不跑 tsc | `release-guard.sh` 加 tsc 闸门 |
| test.1 KV 坏包装机闪退（09-17） | 上传损坏必须当场拦截 | `kv-put-verified.sh` 回读 md5 + zip 校验；ECS 侧同款校验 |
| test.11 混入主清单（09-18） | 正式用户被提示装测试包 | 通道隔离：test 专属清单 `latest-test.json`，主清单永不写 test |
| 公司网屏蔽 ECS 裸 IP，更新 99% 死循环 | 302 跳裸 IP 对公司是死路 | CF KV 直出优先（唯一全通路径），清单加本域 `url`/`url_cf` |
| 0.5.2-dev.90 被提示"升级"0.5.2（实为降级） | semver 正式>预发布方向反着坑 dev 包 | dev 通道不参与更新检查 |
| 0.5.2-test.17 基线不高于已发正式版（09-19） | 发过的版本号不再作 test 基线 | `build-test-apk.sh` 基线守卫（latest.json 为权威） |
| 多会话并行出包撞 test.N 序号（09-18） | 出包必须全局串行 | mkdir 原子锁 + pid 探活 |

## 1. 版本与通道模型

### 1.1 版本号：单一事实源

- **事实源**：仓库根 `VERSION` 文件（单行三段 semver，四段号 09-11 废止）。
- **落点五处**（`node scripts/version.mjs --write` 一次写入，`--check` 漂移即拦，挂 pre-commit）：
  1. `web-console/index.html` CONSOLE_VERSION
  2. `expo-app/app.json` expo.version
  3. `expo-app/android/app/build.gradle` versionName
  4. `desktop-tauri/package.json` version
  5. `web-console/site/index.html` 主页三处版本展示（09-09 用户定立的发版纪律）
- CLAUDE.md 写的「四处同步」是历史口径，现以五处为准（事实源机制不变，只是多了主页落点）。
- **烙印**：`-test.N` / `-snap.N` / `-dev.<run>` 只在出包时烙进 versionName（工作区不提交 test 烙印）；CI 对含 `-snap`/`-test` 或无 `-` 的 tag 烙 tag 名，无 tag 构建烙 `-dev.N`。`release-guard.sh` 发版前检查仓库无烙印污染。

### 1.2 四通道（由 versionName 预发布后缀判定，`channelOf()`）

| 通道 | 版本形态 | 出包方式 | 产物位置 | 更新清单 | 应用内检查更新 | 目标设备 |
|---|---|---|---|---|---|---|
| **dev** | `X.Y.Z-dev.N` | CI 无 tag 构建（workflow_dispatch/push） | 仅 Actions run | 无 | **不查**（无专属清单，读主清单必被 semver 误判降级） | adb 装机验证 |
| **test** | `X.Y.Z-test.N` | 本地 `build-test-apk.sh`（ECS 序号自动递增） | ECS 版本化文件名 +（可选）CF KV 版本化 | `latest-test.json`（ECS 单源；条目带 `url`（ECS）与 `url_cf`（CF）双下载地址） | 查专属清单；下载不回落 GitHub（正式包版本错配） | 测试机（.103） |
| **snap** | `X.Y.Z-snap.N` | 推 `v…-snap.N` tag 触发 CI | Actions run + `update-snap-dist.sh` 推 ECS/KV（版本化 + 稳定名 + `snap-latest-version` 指针） | 读主清单（双镜像）——主清单只含正式版 → 实际不会被 OTA 提示 | 查得到但永远「已是最新」，装机走手动 | 自愿尝鲜（快照版按钮/链接） |
| **release** | `X.Y.Z` | 干净 tag `vX.Y.Z` 触发 CI | GitHub Release + ECS 固定名 `cc-deck.apk` + CF KV + 主清单 | `latest.json` 双镜像（ECS + CF） | 全链路 OTA（24h 静默 + 手动 + relay 广播即时通知） | 所有正式用户 |

纪律要点：
- **test 包永不进 CF 主域主页 / GitHub Release / 主清单**——防正式用户看到测试包。
- **snap 不广播**：不建 Release、不动 latest.json、不推送给正式通道；产物在 Actions + 快照直链，谁要谁取。
- **正式版已发过的版本号不再作 test 基线**（09-19 用户定规矩）：`build-test-apk.sh` 开工先对 ECS `latest.json` 守卫。

### 1.3 semver 比较（`isNewer()`）

core 三段数值比较 → 相等时：正式 > 预发布；同为预发布取后缀数字（test.17 > test.9）；再相等按字典序。此规则同时决定了「0.5.2-dev.90 不会被 0.5.2 误升」的拦截前提（dev 通道直接不查，双保险）。

## 2. 三段式发版流程

### 2.1 test 段（随时可出）

`scripts/build-test-apk.sh ["改动摘要"]` 一条命令完成：
出包互斥锁（mkdir 原子锁 + 死锁探活）→ 基线守卫（base 必须严格大于 latest.json 已发正式版）→ SSH 查 ECS 已有 test.N 取下一个 → 烙 `<base>-test.N` 进 build.gradle + app.json（不提交）→ arm64 release 构建 → `unzip -t` + aapt 版本回读 → 推 ECS 版本化文件名 + 远端 md5 比对 → （配了 CF_TOKEN 时）`kv-put-verified.sh` 上 KV 加 `url_cf` → 写 `latest-test.json`。

版本晋级不需要理由，test 段就是草稿纸。

### 2.2 snap 段（本地 test 通过 + 功能批次攒齐）

1. `VERSION` bump（patch=修复批 / minor=功能批 / major=重大改版，用户拍板）→ `version.mjs --write` 五落点。
2. bump 提交：`chore: bump X.Y.Z（snapshot 批：#A-#B 概要）「snap」`。
3. `./scripts/release-guard.sh X.Y.Z` 全绿（版本一致 / 无烙印 / bundle 三处同步 / expo tsc / web-console 语法 / 工作区干净 / bridge 测试）。
4. 推 `vX.Y.Z-snap.N` tag → android.yml + desktop.yml 出产物（Actions run，不建 Release）。
5. CI 绿后 `scripts/update-snap-dist.sh vX.Y.Z-snap.N`：下载双 workflow 产物 → ECS 版本化 + `-snap-latest` 稳定名 → KV exe 对象（metadata.filename 版本化下载名）+ `snap-latest-version` 指针 → 双通道路由实测（ECS 206 / CF 200 + 文件名头）。
6. 快照直链发给需要的人（近期进「输出物」看板）。

### 2.3 release 段（snap 连续使用几天无问题 + 用户拍板）

1. 同 2.2 的 1–3（版本号视情况再 bump——snap 用过的号可以转正，tag 是干净的 `vX.Y.Z` 即可）。
2. 推干净 tag → CI 建 GitHub Release 挂 APK（arm64 + v7a）与桌面 setup.exe。
3. `./scripts/release-publish.sh X.Y.Z "版本说明"`：下载 Release 产物 → ECS 固定名（`cc-deck.apk` / `latest.json` / exe / `latest.yml`）→ Tauri 更新链（setup.exe 上 KV + 生成带签名的 `tauri-latest.json` 上 KV）→ relay `/api/notify` 广播在线客户端 → 核对清单。
4. 主页版本展示随 `version.mjs --write` 已同步；VERSION_NOTES 随正式版维护（措辞纪律见 updates.ts 注释：产品/用户视角、UI 类合并、具体功能单列）。

### 2.4 版本号决策口径

- **patch**：bug 修复批，无新功能。
- **minor**：有用户可感知的新功能批（如 0.5.3→0.6.0：输出物功能重大）。
- **major**：交互形态/架构级改版。
- 判断权在用户；夜间自主发版只在已拍板的号上执行。

## 3. 分发基础设施（三源两镜）

| 源 | 地址 | 公司网络 | 家庭/流量 | 特性 |
|---|---|---|---|---|
| ECS 裸 IP | `http://8.133.211.170:8888` | ❌ 屏蔽 | ✅ 满速 | 无 TLS；固定名 + 版本化文件名都放；阿里云对 CF 境外回源 403（不能当 CF 的回源） |
| CF Worker + KV | `https://cc.humumu.online` | ✅ 唯一全通 | ✅（速度波动 80KB/s~5.7MB/s） | KV 直出 ≤25MiB、Range/206 断点续传、`/dl/` attachment、`/view/` 在线预览、metadata.filename 控制下载名 |
| GitHub Releases | `github.com/humumu130/cc-deck` | 视网络 | 慢/易超时 | 正式版档案（单一事实源之一）；手机更新链的最后兜底（懒解析 asset） |

CF Worker 路由要点（`cloudflare/src/worker.ts`）：
- `/`、`/app` 主页与控制台；`/download/*` 兼容别名 → `/dl/*`。
- `/dl/<file>`：KV 直出优先（含 206），KV 未上传 302 ECS 兜底——这是「公司唯一全通路径」的根。
- `/dl/cc-deck-snap-latest.apk`：302 到 KV 指针 `snap-latest-version` 指向的版本化文件名。
- `/dl/cc-deck-snap-latest-setup.exe`：KV 直出 + 版本化下载名。
- `latest.json` 主清单双镜像：CF 域 + ECS 同路径各一份（检查秒回，清单可达时整条检查链不出墙）。

**已知硬约束**：KV 单值 25MiB 上限。R8 瘦身后 APK ~16MB 安全；若未来包体超限，CF 只能退 302 ECS（公司死路）——包体体积是架构级约束，需在构建侧持续控制。

## 4. 端上更新链

### 4.1 手机（updates.ts）

1. **判定通道**（versionName 后缀）→ dev 直接不查。
2. **读清单**：test → ECS `latest-test.json` 单源；snap/release → CF/ECS 双镜像任一可达即用。test 条目的下载地址过白名单（必须 ECS/CF 本域版本化前缀），防清单被劫持后回落主通道固定名包。
3. **semver 比较** → 无新版秒回 null。
4. **双清单全 miss** → GitHub API 兜底（仅 snap/release；test 包不上 Releases）。
5. **下载**：模块级管理器（弹窗只是订阅者）——`.part` 断点续传（先探测 206/200，200 全量重下绝不追加污染）、AppState active 自动续传、指数退避重试、前台服务保活；下载源 `url_cf` 本域优先 → ECS → GH asset 懒解析。
6. **安装**：交系统安装器（APK 签名校验兜底，下载源不可信的风险边界在安装器收口）。

### 4.2 桌面（Windows Tauri）

- Tauri updater 端点 `https://cc.humumu.online/download/tauri-latest.json`（release-publish.sh 生成并上 KV，含 CI 自带签名 `.sig`）。
- exe 内链必须公司可达 → setup.exe 上 KV 直出，url 指 CF 域。
- relay.mjs 作为资源内嵌桌面包（`src-tauri/resources/`），随桌面版本走；Mac 侧另有热替换部署管线（三处 md5 一致 + 已装 App 同步）。

### 4.3 relay 广播

正式发布后 relay `/api/notify` 向在线客户端推「🎉 vX.Y.Z 发布」——24h 静默检查之外的即时通道。

## 5. 下载通道可见性

| 受众 | 能看到什么 | 入口 |
|---|---|---|
| 公网用户 | 正式版（版本展示随发版同步）+ 快照版按钮（snap-latest 指针） | 主页 `cc.humumu.online` |
| 正式版用户 | 只有正式版 OTA 提示 | latest.json 主清单 + GH 兜底 |
| 快照版用户 | 无 OTA（主清单永远「已是最新」），手动换包 | 快照直链 |
| 测试通道 | 只有 test.N OTA | ECS `latest-test.json`（裸 IP，不进 CF 主域/主页） |
| 公司网络用户 | 全链路走 CF 域（清单 + 下载） | KV 直出 |

设计原则：**通道之间互不可见**——正式用户永远看不到 test/snap 包；test 设备永远看不到正式包提示（下载不回落 GH）；快照用户不被广播打扰。可见性由「清单按通道分文件 + 下载地址白名单 + 不建 Release」三层实现。

「输出物」看板（#77 起）：所发版本的**快照**三平台 CFKV 下载地址登记进输出物，随会话远程查看——这是快照分发的新入口，不改变上述隔离（拿到链接 = 主动获取）。

## 6. 护栏速查（何时跑什么）

| 时点 | 脚本/机制 | 拦什么 |
|---|---|---|
| 每次 commit | pre-commit `version.mjs --check` | 五落点漂移 |
| test 出包 | `build-test-apk.sh` 内置 | 并行出包（锁）/ 基线倒挂 / 坏 APK / ECS 上传损坏 / 清单污染 |
| KV 上传 | `kv-put-verified.sh` | 坏包上线（回读 md5 + zip） |
| 打 tag 前 | `release-guard.sh` | 版本漂移 / 烙印污染 / bundle 不同步 / tsc 错误 / web-console 语法 / 工作区脏 / bridge 回归 |
| 任何构建前 | `check-bundle-sync.sh` | relay.mjs 三处不一致 / 旧产物 / bundle 语法错误 |
| CI | android.yml / desktop.yml / relay.yml | tag 烙印 / dev 通道标识 / relay 自包含测试矩阵 |
| 发版后 | release-publish.sh 第④步 | 清单/直链未生效（curl 实测） |

## 7. 已知约束与改进提案【未实施，待拍板】

1. **test 清单单源痛点**：`latest-test.json` 只在 ECS——公司网络的 test 设备连检查更新本身都 miss（下载有 `url_cf` 走 CF，但清单拉不到就到不了下载）。提案：清单文件也上 KV（`latest-test.json` 入 TEST_MANIFEST_URLS 双源），通道隔离不变（仍是独立文件，只是多一镜像）。
2. **snap 无 OTA**：设计如此（不广播）。若未来想给固定尝鲜设备推送，可加 `latest-snap.json` 专属清单 + snap 通道读它——广播范围仍由「谁装了 snap 包」天然限定。当前不需要。
3. **KV 25MiB 上限**：包体持续监控；超限即公司网络不可达（只能 302 裸 IP）。构建侧保持 R8/ splits 瘦身纪律。
4. **dev 通道无自动化分发**：靠 adb 装。量大时可加 `latest-dev.json` + CI 自动推，但 dev 包本就是一次性验证，不值得。
5. **release-publish.sh 的 Tauri 链依赖 CF_TOKEN 现场导出**：漏配只 warning 不失败——正式发版时需人工留意第④步核对输出。提案：缺 token 时降级为硬失败（正式发布场景宁停勿缺）。

## 8. 速查表

- 出 test 包：`scripts/build-test-apk.sh "摘要"`
- 出 snap：改 `VERSION` → `node scripts/version.mjs --write` → bump 提交 → `release-guard.sh` → `git tag v…-snap.N && git push origin v…-snap.N` → CI 绿 → `scripts/update-snap-dist.sh v…-snap.N`
- 出正式：同上但干净 tag → CI 建 Release → `scripts/release-publish.sh X.Y.Z "说明"`
- 快照直链：`https://cc.humumu.online/dl/cc-deck-snap-latest.apk` / `…-setup.exe`（版本化文件名见 `snap-latest-version` 指针）
- 主清单：`https://cc.humumu.online/dl/latest.json` + `http://8.133.211.170:8888/latest.json`
- test 清单：`http://8.133.211.170:8888/latest-test.json`
- 桌面 updater：`https://cc.humumu.online/download/tauri-latest.json`
