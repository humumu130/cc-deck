# relay owner 收敛拍板（2026-10-13，用户授权 Leader 定案）

> 依据：两路独立调研（正方=launchd 独占 / 反方=内嵌独占+折衷）+ 1012~1013 五实例事故实证。
> 正方报告要点：CCR_PARENT_PID 3s 自杀机制（index.ts:88-96）、服务化三件套已落地（EADDRINUSE 退出/supervisor 让位/enable.sh 拒占）、bundle 双 SHA 漂移、**僵而不听实例实证（boot 重放在 listen 前，仲裁只在 listen 时刻生效）**。
> 反方报告要点：M2 33h 烧蚀=孤儿服务活反面教材、launchd 旧作业 5s 热旋循环、内嵌三层崩溃缓解（uncaughtException→supervisor 重拉→autoReviveManaged transcript 复活）、折衷方案 ≥4 态状态机+永久发布义务。

## 拍板

**Phase 1（1013 已执行）：内嵌 relay 独占 8787。**
- bootout `online.humumu.ccdeck.m2.relay`（94% CPU 烧 33h，plist → `.retired-20261013`）
- bootout `online.humumu.ccdeck.relay`（5s 热旋循环，plist → `.retired-20261013`）
- 清理孤儿内嵌 relay（50534/8798）与僵而不听实例（42068）
- 终态：`lsof -iTCP:8787` 单 LISTEN（Nova App 内嵌），`ps` 全机 relay 类进程唯一

**Phase 2（test.22 验收后的特性批候选，不随下一批）：launchd 化前置套件。**
做完以下四件才允许重新 enable launchd 作业，届时 macOS 默认 launchd、内嵌降为兜底（supervisor 1.5s 重拉，已建成）：
1. bundle SHA 定版纪律：plist 指向 canonical bundle（带 SHA+VERSION 烙印），发布链同步双 SHA 合一（今日实测 a1b8280c ≠ a74e86b2 漂移）
2. boot 看门狗：启动 N 秒未 listen 自退 + 失败退避（防 5s 热旋与 M2 式循环烧蚀）
3. 「僵而不听」防护：boot 重放若可能长阻塞，移出 listen 前或加硬超时（仲裁绕过实证）
4. patrol 深探：区分「不在」与「僵」（curl 只知端口，需 pid+listen 双查），发现僵进程可自动清

**Phase 3（暂不做，等真实需求）：无人值守 kickstart 折衷。**
App 退出时有活 worker → kickstart launchd 续命。用户夜批模式 App 常开 + autoRevive 已覆盖重启恢复；折衷的状态机复杂度（≥4 态）与永久发布义务暂不值。触发条件：用户实际出现「关 App 还要 worker 继续跑」的场景。

## 理由（为何内嵌先行）

1. **故障证据不对称**：launchd 路线的三大风险（bundle 漂移/热旋/僵而不听）在 1013 全部实证发生；内嵌路线的风险（App 关闭冻结 worker）有三层缓解且未成灾。
2. **迁移成本不对称**：内嵌即现状（零迁移）；launchd 化需先还清前置套件的债。
3. **用户模式匹配**：App 是常开控制台（含设置页「开机自启」LaunchAgent，登录即有 relay），launchd 的可用性优势大部分被覆盖。
4. **双向门保留**：回滚 = disable.sh → 端口空 → supervisor 1.5s 重拉内嵌；同数据目录（~/.cc-deck/data）零迁移。Phase 2 做完随时可再切换。

## 遗留清理项

- `deploy/mac-relay-launchd/`（enable.sh/disable.sh）保留——Phase 2 复用，enable 前必须过前置套件
- 两个 `.retired-20261013` plist 保留观察一周后删
- dev 直启 relay（npm run dev / tsx）必须带 `CCR_DATA_DIR` 沙盒隔离（防再抢生产目录）
