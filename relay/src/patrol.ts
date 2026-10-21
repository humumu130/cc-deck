// W-PATROL 巡检哨兵：relay 内置定时巡检（30min 全巡 + 5min 轻探针）
// 参考实现 ~/.cc-deck/bin/patrol.sh（launchd 手工版）翻译进 relay——手工版只属于单机
//（其他安装没有；手工持久化被安全分类器拦截=本就不该手工做），relay 已常驻于每个安装，
// 巡检作为内置定时模块零新增进程，装 cc-deck 即有。异常经 notifyDone 推用户（与
// /api/notify 绿框同通道同兜底选session）；自愈（kickstart 自拉）由壳负责，不在本模块。
//
// 四层内容（对齐 patrol.sh）：
//   全巡(30min)：① worker 帧新鲜度（WORKING 且 updated_at > 40min，排除 compacting——
//                   压缩期静默合法）② 看板对账漂移（active 组 claimed 停滞 >48h /
//                   submitted 待验收积压）③ 报告落盘 patrol-report.md（tail 200 防膨胀）
//   轻探针(5min)：④ 磁盘余量（Data 卷 <5GB）+ dataDir 可写 + 事件循环漂移自检
// 去重口径：同 key 告警文本未变化不重推（onset-only），条件解除写恢复行不推送。
// 开关：plugin-config 第十键 patrol（默认开，设置页 lever 随设置批）+ CCR_PATROL=0 应急停。
import { statfsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { statSync } from "node:fs";
import { listGroups, loadBoardFile } from "./projects.js";
import type { SessionManager } from "./session-manager.js";

const WORKER_STALE_MIN = 40;     // WORKING 无帧判停滞（分钟）
const BOARD_CLAIMED_STALE_H = 48; // claimed 停滞（小时）
const DISK_FREE_MIN_GB = 5;      // 磁盘余量红线

export interface PatrolAlert {
  key: string;
  text: string;
}

export interface PatrolOptions {
  dataDir: string;
  reportPath: string;            // dataDir/patrol-report.md
  enabled: () => boolean;        // 配置开关（plugin-config 键 + env 聚合后注入）
  lightMs?: number;              // 默认 5min（CCR_PATROL_LIGHT_MS 覆盖，测试用短值）
  fullMs?: number;               // 默认 30min（CCR_PATROL_FULL_MS）
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export class PatrolModule {
  private lightTimer: NodeJS.Timeout | null = null;
  private fullTimer: NodeJS.Timeout | null = null;
  // 去重账本：key → 上次告警文本（onset-only）
  private lastAlerts = new Map<string, string>();

  constructor(
    private mgr: SessionManager,
    private opts: PatrolOptions,
  ) {}

  start(): void {
    if (this.lightTimer || this.fullTimer) return;
    const lightMs = num(process.env.CCR_PATROL_LIGHT_MS, this.opts.lightMs ?? 5 * 60_000);
    const fullMs = num(process.env.CCR_PATROL_FULL_MS, this.opts.fullMs ?? 30 * 60_000);
    this.lightTimer = setInterval(() => {
      if (!this.opts.enabled()) return;
      // #199 B1：熔断到期补试——resumeCooldownUntil 过期后若无人触发（深夜无 turn_end/
      // event），值守链会一直哑到下一事件；light 周期顺手探测「刚过期」窗口补一轮喂活
      try { this.runLight(); } catch (e) { console.log(`[patrol] light error: ${e instanceof Error ? e.message : e}`); }
      try { this.retryExpiredBreaker(); } catch { /* 补试尽力而为 */ }
    }, lightMs);
    this.fullTimer = setInterval(() => {
      if (!this.opts.enabled()) return;
      try { this.runFull(); } catch (e) { console.log(`[patrol] full error: ${e instanceof Error ? e.message : e}`); }
    }, fullMs);
    this.lightTimer.unref?.();
    this.fullTimer.unref?.();
  }

  stop(): void {
    if (this.lightTimer) clearInterval(this.lightTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    this.lightTimer = null;
    this.fullTimer = null;
  }

  // ---------- 轻探针（5min）：磁盘 / dataDir 可写 / 事件循环漂移 ----------
  runLight(): void {
    if (!this.opts.enabled()) return;
    const alerts: PatrolAlert[] = [];
    // 磁盘余量
    try {
      const st = statfsSync("/");
      const freeGb = (st.bavail * st.bsize) / 1e9;
      if (freeGb < DISK_FREE_MIN_GB) alerts.push({ key: "disk", text: `磁盘余量 ${freeGb.toFixed(1)}GB（红线 ${DISK_FREE_MIN_GB}GB）` });
      else alerts.push({ key: "disk", text: "" });
    } catch { /* statfs 失败不告警（挂载点异常属壳域） */ }
    // dataDir 可写
    try {
      const probe = join(this.opts.dataDir, ".patrol-probe");
      writeFileSync(probe, String(Date.now()));
      alerts.push({ key: "dataDir", text: "" });
    } catch {
      alerts.push({ key: "dataDir", text: "数据目录不可写（磁盘满或权限被收）" });
    }
    // 事件循环漂移：500ms 定时器实际延迟 >5s = 循环被饿（CPU 烧蚀/同步阻塞前兆）
    const t0 = Date.now();
    setTimeout(() => {
      const drift = Date.now() - t0 - 500;
      if (drift > 5_000) this.push("loop", `事件循环漂移 ${Math.round(drift / 100) / 10}s（存在同步阻塞/CPU 烧蚀）`);
      else this.resolve("loop");
    }, 500).unref?.();
    for (const a of alerts) {
      if (a.text) this.push(a.key, a.text);
      else this.resolve(a.key);
    }
    this.appendReport(`light: ${alerts.map((a) => `${a.key}=${a.text || "OK"}`).join(" ")}`);
  }

  // ---------- 全巡（30min）：worker 帧 / 看板漂移 ----------
  runFull(): void {
    if (!this.opts.enabled()) return;
    const now = Date.now();
    // ① worker 帧新鲜度：WORKING 且静默 >40min（压缩期静默合法，排除）
    // #199 B3：盲面双补——①WAITING 久滞（等用户确认超 2h=疑似确认卡丢失/没人管，与
    // WORKING 停滞分列报告）②compacting 挂死（压缩标志 >90min 不落=看门狗状态机卡死，
    // 原判定直接排除 compacting 把这类永久静默）
    const stale = this.mgr.snapshot().filter((s) =>
      s.status === "WORKING" && (!s.compacting || now - (s.updated_at ?? 0) > 90 * 60_000) &&
      now - (s.updated_at ?? 0) > WORKER_STALE_MIN * 60_000);
    const staleWaiting = this.mgr.snapshot().filter((s) =>
      s.status === "WAITING" && now - (s.updated_at ?? 0) > 2 * 3600_000);
    if (stale.length) {
      const text = `${stale.length} 个会话 WORKING 停滞>${WORKER_STALE_MIN}min：` +
        stale.slice(0, 5).map((s) => `${s.title || s.session_id.slice(0, 8)}(${Math.round((now - (s.updated_at ?? 0)) / 60_000)}m)`).join("、");
      this.push(`worker-stale`, text);
      if (staleWaiting.length) {
        this.push(`waiting-stuck`, `${staleWaiting.length} 个会话 WAITING >2h：` +
          staleWaiting.slice(0, 5).map((s) => `${s.title || s.session_id.slice(0, 8)}(${Math.round((now - (s.updated_at ?? 0)) / 3600_000)}h)`).join("、"));
      } else this.resolve(`waiting-stuck`);
      // #92 W-NOTIFY2 D：40min 无帧自动升级——可操作通知（点跳会话卡）替代纯文本
      // 推送（notifyDone 只兜底到首个 external，丢面大）；stableKey 同键幂等，恢复
      // resolve 面不变。首卡 actionable 跳转，severity=waiting 提级
      const first = stale[0];
      if (first) {
        try {
          (this.mgr as any).upsertNotification("system", "stale-escalate", String(Math.floor(now / 60_000)), {
            title: `会话停滞升级（${stale.length} 个 >${WORKER_STALE_MIN}min 无帧）`,
            body: text,
            severity: "waiting", group: "attention", actionable: true, sessionId: first.session_id, domain: "session", returnPath: "/",
          });
          (this.mgr as any).emitChainAudit?.("stale-escalate", text, first.session_id);
        } catch { /* 升级尽力而为 */ }
      }
    } else this.resolve(`worker-stale`);
    // ② 看板对账漂移（active 组）
    const boardAlerts: string[] = [];
    try {
      for (const g of listGroups()) {
        if (g.status !== "active") continue;
        const board = loadBoardFile(g.id);
        if (!board) continue;
        const claimedStale = board.entries.filter((e) =>
          e.status === "claimed" && now - (e.updated_at ?? now) > BOARD_CLAIMED_STALE_H * 3600_000);
        const submitted = board.entries.filter((e) => e.status === "submitted");
        for (const e of claimedStale) {
          boardAlerts.push(`[${g.name}] claimed 停滞>${BOARD_CLAIMED_STALE_H}h：${(e.text ?? "").slice(0, 24)}`);
        }
        if (submitted.length) boardAlerts.push(`[${g.name}] submitted 待验收 ${submitted.length} 条`);
      }
    } catch (e) {
      console.log(`[patrol] board scan error: ${e instanceof Error ? e.message : e}`);
    }
    if (boardAlerts.length) this.push("board", boardAlerts.slice(0, 6).join("；"));
    else this.resolve("board");
    this.appendReport(`full: worker-stale=${stale.length} board=${boardAlerts.length ? boardAlerts.length + "项" : "OK"}`);
    // #199 D：full 周期挂三账对账 + 对账心跳查龄（PM turn-report 双触发，此处兜底——
    // PM 停帧时对账链不断）
    try { (this.mgr as any).runLedgerRecon?.("patrol-full"); } catch { /* 尽力而为 */ }
    try {
      const hb = join(this.opts.dataDir, "recon-heartbeat.json");
      const st = statSync(hb);
      if (Date.now() - st.mtimeMs > 70 * 60_000) this.push("recon-stalled", `三账对账心跳停跳 ${Math.round((Date.now() - st.mtimeMs) / 60_000)}min（PM turn-report 与 patrol 双触发均未跑）`);
      else this.resolve("recon-stalled");
    } catch { /* 心跳文件未生成前静默 */ }
  }

  // ---------- 去重推送（onset-only）+ 报告落盘 ----------
  private push(key: string, text: string): void {
    const prev = this.lastAlerts.get(key);
    if (prev === text) return; // 同条件未变化：不重推
    this.lastAlerts.set(key, text);
    // 投递目标兜底链（与 /api/notify handleNotify 同款）：WORKING external → external → 首个
    const sessions = this.mgr.snapshot();
    const target =
      sessions.find((s) => s.status === "WORKING" && s.external) ||
      sessions.find((s) => s.external) ||
      sessions[0];
    // #199 B5：无投递目标（零会话极端态）不再静默 return——报告仍落 patrol-report.md
    // （排障面从「什么都没发生」变「告警了但没人可推」）
    if (!target) { this.appendReport(`ALERT-NO-TARGET [${key}] ${text}`); return; }
    this.mgr.notifyDone(target.session_id, [`⚠️ 巡检：${text}`], 0);
    this.appendReport(`ALERT [${key}] ${text}`);
  }

  /** #199 B1：熔断到期补试——leader resumeCooldownUntil 在 [过期, 过期+light 周期] 窗内
   * 且上次值守终态是 resume_breaker → 补一轮 feedPM("patrol-retry")。幂等窗=一个 light
   * 周期只补一次（breakerRetryAt 记账），常态零成本（无熔断 leader 短路）。 */
  private breakerRetryAt = 0;
  private retryExpiredBreaker(): void {
    const now = Date.now();
    if (now - this.breakerRetryAt < 5 * 60_000) return;
    const sm = this.mgr as unknown as { sessions: Map<string, { resumeCooldownUntil?: number; resumeFailStreak?: number }>; feedPM?: (t: string) => void };
    if (typeof sm.feedPM !== "function" || !(sm.sessions instanceof Map)) return;
    for (const s of sm.sessions.values()) {
      if (s.resumeCooldownUntil && s.resumeCooldownUntil <= now && s.resumeCooldownUntil > now - 10 * 60_000) {
        this.breakerRetryAt = now;
        this.appendReport(`BREAKER-RETRY cooldown 到期补试 feedPM（streak=${s.resumeFailStreak ?? "?"}）`);
        sm.feedPM("patrol-retry");
        return;
      }
    }
  }

  private resolve(key: string): void {
    if (this.lastAlerts.delete(key)) {
      this.appendReport(`RECOVERED [${key}]`);
    }
  }

  private appendReport(line: string): void {
    try {
      const ts = new Date().toLocaleString("zh-CN", { hour12: false });
      const path = this.opts.reportPath;
      let prev = "";
      try { prev = readFileSync(path, "utf-8"); } catch {}
      const lines = [...prev.split("\n").filter(Boolean), `[${ts}] ${line}`];
      writeFileSync(path, lines.slice(-200).join("\n") + "\n");
    } catch { /* 报告落盘失败不影响巡检 */ }
  }
}
