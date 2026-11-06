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
import { statfsSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process"; // W-BOARDRECON-R3：dev log 证据子进程（10min 缓存）
import { homedir } from "node:os";
import { listGroups, loadBoardFile, upsertBoardEntry, convergeBoardsWithDispatchLog } from "./projects.js";
import { reconcileBoardCards, harvestKeyOf } from "./board-recon.js"; // [W-BOARDRECON] 三方对账器（孤儿归位+数字一致性——1104 第三现）；R3 harvestKeyOf（已收割未翻判定）
import { unclaimedStaleDispatches, unclaimedTtlMs, prStaleBoardActions, type PrTruthSnap, type TruthBoardEntry } from "./board-truth.js"; // [W-BOARDTRUTH] 刀2 未认领 TTL+刀3 审查中泳道×PR 真值对账（第三现治本）
import { appendDispatch } from "./org.js"; // W-BOARDTRUTH 刀2：撤单台账收口行
import { readDispatchLog, orgDir, dispatchLogPath } from "./org.js";
import { drillDue, runDrill } from "./drill.js";
import { autoTierOf, recordWouldDo, observeBucket } from "./auto-tiers.js"; // observe3：自主动作三档（patrol/converge 族挂档点，见 auto-tiers.ts 挂档纪律）
import type { SessionManager } from "./session-manager.js";

const WORKER_STALE_MIN = 40;     // WORKING 无帧判停滞（分钟）
const BOARD_CLAIMED_STALE_H = 48; // claimed 停滞（小时）
const DISK_FREE_MIN_GB = 5;      // 磁盘余量红线
// W-CMDIMPL ②（#216，设计 §2）：新层阈值——env 可调（拍板 #2：24h+env；§2.5 不加
// plugin-config 键，阈值全走 env，对齐既有惯例）
const RECEIPT_STALE_H_DEFAULT = 24; // 新回执落盘无收口提醒阈值（小时）
const TODO_STALE_H_DEFAULT = 48;    // 会话任务单 pending 陈旧阈值（小时）
const CBC_PREFETCH_MAX = 20;        // cbc-update-prefetch 目录数水位（超则自动清+通知）
// M2a（multica 借②·板卡唤醒）：doing(claimed) 滞留提醒阈值（分钟，env 可调——卷四
// 裁决「默认 60 为建议值，PM 可调」；不进 plugin-config，阈值全走 env 对齐既有惯例）
const DOING_STALE_MIN_DEFAULT = 60;

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
  /** R1-P0 两拍确认跨拍状态：上拍孤儿候选集（entryId） */
  private reconFlagged = new Set<string>();
  /** W-BOARDRECON-R3：dev git log 证据缓存（slug 文本+时刻——10min TTL，对账低频子进程一次取回） */
  private reconDevLogCache = { text: "", at: 0 };
  /** R1-P2-1 审计/告警签名去重（同判定不重发） */
  private reconLastSig = "";
  private reconLastMismatch = "";
  private fullTimer: NodeJS.Timeout | null = null;
  // 去重账本：key → 上次告警文本（onset-only）
  private lastAlerts = new Map<string, string>();
  // observe3 R1 P2⑧：observe 档独立去重账（不写 lastAlerts——防 observe→auto 切换后
  // 同文告警被「observe 期见过」吞掉；observe 期间同文不重复记账用本账）
  private observeSeen = new Map<string, string>();

  // observe3 R1（P1-1 六面收口）：patrol 族档位面级单点——本模块一切自主动作副作用
  // （push 推送/boardCardScan 写板+喂活+直写通知账/stale-escalate 升级/drill 演练/
  // recon 对账/breaker 补试喂活）经 patrolObserve() 判档：observe=副作用只记 observe
  // 账（wouldDo 单口，研判/扫描照常）。静态锁（test-observe3 E 族）断言六面引用——
  // 新增自主动作面必须挂本单点（auto-tiers.ts 挂档纪律）。
  private patrolObserve(): boolean {
    return autoTierOf("patrol") === "observe";
  }
  private wouldDo(key: string, action: string, detail: string): void {
    recordWouldDo(this.opts.dataDir, "patrol", key, action, detail);
    this.appendReport(`OBSERVE [${key}] 将${action}：${String(detail).slice(0, 120)}——observe 档未执行`);
  }

  constructor(
    private mgr: SessionManager,
    private opts: PatrolOptions,
  ) {}

  start(): void {
    if (this.lightTimer || this.fullTimer) return;
    const lightMs = num(process.env.CCR_PATROL_LIGHT_MS, this.opts.lightMs ?? 5 * 60_000);
    const fullMs = num(process.env.CCR_PATROL_FULL_MS, this.opts.fullMs ?? 30 * 60_000);
    // sqlitefix-R1（A 审 P1-2 订正）：本刀**零代码变更**（setInterval 原样）——「错峰」
    // 实际语义=仅 watch-feed/pr-comment 首拍相位偏移（40s/20s），稳态三定时器仍按各自
    // 周期同网格重合。稳态共振由根修（读路径签名短路+append 增量续读）消除——错峰只是
    // 首拍窗保险，非「峰值减 ~2/3」的稳态保险（原注释宣称不实，订正）。
    this.lightTimer = setInterval(() => {
      if (!this.opts.enabled()) return;
      if (autoTierOf("patrol") === "off") return; // observe3：patrol 族 off 档（完全黑——与配置键/应急停同义叠加）
      // #199 B1：熔断到期补试——resumeCooldownUntil 过期后若无人触发（深夜无 turn_end/
      // event），值守链会一直哑到下一事件；light 周期顺手探测「刚过期」窗口补一轮喂活
      try { this.runLight(); } catch (e) { console.log(`[patrol] light error: ${e instanceof Error ? e.message : e}`); }
      try { this.retryExpiredBreaker(); } catch { /* 补试尽力而为 */ }
    }, lightMs);
    this.fullTimer = setInterval(() => {
      if (!this.opts.enabled()) return;
      // observe3 R1 P2⑥：runFull 是 converge 周期扫的宿主——两族都 off 才停摆（patrol=off
      // +converge=auto 时循环保活，runFull 内 converge 段自带档位闸、其余 patrol 族面在
      // converge 段后 off 早退）。light 纯 patrol 族维持单族 off 闸。
      if (autoTierOf("patrol") === "off" && autoTierOf("converge") === "off") return;
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
    // W-CMDIMPL ②（#216 任务书）：cbc-update-prefetch 磁盘水位——Claude Code 每 CLI
    // 会话留 ~288MB prefetch 目录永不清理（1022 磁盘反复满真根因）。超 20 个自动清
    // （仅清 cbc-update-prefetch-* 前缀目录，误伤面为零）+ 通知
    try {
      const tmpRoot = "/private/var/folders";
      const hit: string[] = [];
      const scan = (d: string, depth: number) => {
        if (depth > 3) return;
        let entries: string[] = [];
        try { entries = readdirSync(d); } catch { return; }
        for (const n of entries) {
          const full = join(d, n);
          if (n.startsWith("cbc-update-prefetch-")) hit.push(full);
          else if (depth < 3) scan(full, depth + 1);
        }
      };
      if (existsSync(tmpRoot)) {
        for (const top of readdirSync(tmpRoot)) scan(join(tmpRoot, top), 1);
      }
      if (hit.length > CBC_PREFETCH_MAX) {
        // observe3：cbc 清理是**破坏性自主动作**（rmSync）——observe 档必须真不删（push
        // 拦截只挡通知，这里单独挡执行），只记 would-clean
        if (autoTierOf("patrol") === "observe") {
          recordWouldDo(this.opts.dataDir, "patrol", "cbc-prefetch", "clean", `将清理 ${hit.length} 个更新预取残留目录（每个约 288MB）——observe 档未执行`);
          this.appendReport(`OBSERVE [cbc-prefetch] 将清理 ${hit.length} 个残留目录（observe 档未执行）`);
        } else {
          let freed = 0;
          for (const d of hit) {
            try { rmSync(d, { recursive: true, force: true }); freed++; } catch { /* 占用中的跳过 */ }
          }
          this.push("cbc-prefetch", `清理了 ${freed} 个更新预取残留目录（每个约 288MB，磁盘反复吃紧的已知源头）`);
        }
      } else this.resolve("cbc-prefetch");
    } catch { /* 扫描失败不告警（非本机平台/权限） */ }
    // 事件循环漂移：500ms 定时器实际延迟 >5s = 循环被饿（CPU 烧蚀/同步阻塞前兆）
    const t0 = Date.now();
    setTimeout(() => {
      const drift = Date.now() - t0 - 500;
      if (drift > 5_000) this.push("loop", `事件循环漂移 ${Math.round(drift / 100) / 10}s（存在同步阻塞/CPU 烧蚀）`);
      else this.resolve("loop");
    }, 500).unref?.();
    // M2a 板卡域两规则（multica 借②）：wakeup_at 到点触发 + doing 滞留提醒。挂轻探针
    //（5min 周期——唤醒精度与滞留响应的平衡点；全巡 30min 太钝，板文件读轻量可承受）
    try { this.boardCardScan(); } catch (e) { console.log(`[patrol] board-card scan error: ${e instanceof Error ? e.message : e}`); }
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
    // boardfix 刀3（1103 板面说谎）：台账→看板收敛扫从 boot-only 升周期自愈——
    // runFull 30min 一拍（boot 既有调用保留）；72h 强翻分支（刀2）在此路径生效，
    // 长跑 relay 不重启也能翻正陈卡。
    // boardfix R3：①强翻两道人工豁免（hold/人工重开）命中计 skipped，通知改述明示
    // 「跳过 N 张疑似人工在管」（不静默不谎报——豁免已根治「碾人后静默」，skip 文案
    // 同文去重属信息不重复推送，人机打架面已不存在）②强翻命中经回调发 board-force-close
    // 审计（converge 自由函数无 this，mgr.emitChainAudit R3 转公）③catch 补 warn 与
    // boot 侧口径对齐（长期抛错不再无感）。
    // observe3（converge 族三档挂档点）：off=跳过收敛扫；observe=dryRun（研判/豁免照跑、
    // 翻面不执行，wouldClose 落 observe 账本+通知账一行式——面板可见）；auto=原路径。
    // 注意 observe 的记录走 mgr.upsertNotification 直达（不经 this.push——push 受 patrol
    // 族档位管辖，两族独立）。
    try {
      const tier = autoTierOf("converge");
      if (tier !== "off") {
        const converged = convergeBoardsWithDispatchLog(undefined, (action, detail) => this.mgr.emitChainAudit(action, detail), { dryRun: tier === "observe" });
        // W-CARDLIFE-R3 P1-2：资格位拦中卡催收告警（converge 跳过+清单直达通知账——
        // 拦截事实与档位无关，observe/auto 双档都出；90s 迟写补翻成功后该 id 自然出清）
        if (converged.receiptGated.length > 0) {
          try {
            this.mgr.upsertNotification("system", "converge-rgate", String(converged.receiptGated.length), {
              title: `资格位拦中 ${converged.receiptGated.length} 张卡（催收中，不收敛）`,
              body: `回执未合规被拦的卡 ${converged.receiptGated.slice(0, 3).map((x) => x.entryId).join("、")}${converged.receiptGated.length > 3 ? " 等" : ""}——等回执军规行补齐（90s 复查自动补翻 submitted），对账器已跳过`,
              severity: "waiting", group: "attention", actionable: true, domain: "org", returnPath: "/",
            });
          } catch { /* 通知尽力而为 */ }
          this.appendReport(`RGATE 拦中 ${converged.receiptGated.length} 张（converge 跳过催收）：${converged.receiptGated.slice(0, 3).map((x) => x.entryId).join(",")}`);
        }
        if (tier === "observe") {
          const would = converged.wouldClose;
          if (would.length > 0 || converged.skipped > 0) {
            recordWouldDo(this.opts.dataDir, "converge", "board-converge", "force-close",
              `将翻正 ${would.length} 张陈卡${converged.skipped > 0 ? `，另跳过 ${converged.skipped} 张疑似人工在管` : ""}：${would.slice(0, 3).map((w) => w.text).join("、")}${would.length > 3 ? " 等" : ""}——observe 档未执行`);
            try {
              this.mgr.upsertNotification("system", "observe-converge", observeBucket(), {
                title: "[observe] 板收敛干跑：将翻正 " + would.length + " 张陈卡",
                body: `converge 档=observe（研判通过不执行）。将翻正：${would.slice(0, 3).map((w) => w.text).join("、")}${would.length > 3 ? ` 等 ${would.length} 张` : ""}${converged.skipped > 0 ? `；跳过 ${converged.skipped} 张疑似人工在管` : ""}——转 auto 档才会执行`,
                severity: "waiting", group: "attention", actionable: false, domain: "session", returnPath: "sessions",
              });
            } catch { /* 通知账不可用时 observe-log 已在案 */ }
            this.appendReport(`OBSERVE [board-converge] 将翻正 ${would.length} 张陈卡（跳过 ${converged.skipped} 张人工在管）——observe 档未执行`);
          }
        } else if (converged.moved > 0 || converged.skipped > 0) {
          const parts: string[] = [];
          if (converged.moved > 0) parts.push(`翻正 ${converged.moved} 张陈卡（backlog+台账 done>72h 断链残留）`);
          if (converged.skipped > 0) parts.push(`跳过 ${converged.skipped} 张疑似人工在管（hold 锁/人工重开豁免）`);
          // observe3 R1 P2⑤：converge 族完成通知直达通知账——不经 this.push（push 受
          // patrol 族档位管辖，patrol=observe+converge=auto 组合会把已执行动作的完成
          // 通知吞进 observe 账+族别错记）。revision=文本键：同文幂等更新、计数变即新行。
          const convText = `台账→看板收敛：${parts.join("，")}`;
          try {
            this.mgr.upsertNotification("system", "board-converge", convText.slice(0, 60), {
              title: "台账→看板收敛完成",
              body: convText.slice(0, 200),
              severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
            });
          } catch { /* 通知尽力而为（审计 emitChainAudit 已在案） */ }
          this.appendReport(`CONVERGE ${convText}`);
        }
      }
    } catch (e) {
      console.warn(`[patrol] 板收敛扫失败（跳过）: ${e instanceof Error ? e.message : String(e)}`);
    }
    // [W-BOARDRECON]（1104 第三现「工作中 5 沃克 vs 进行中 8 卡」）：三方对账器——
    // observe3 R1 P2⑥ 下半：patrol 族 off 而 converge 档仍活时，converge 段跑完即退——
    // 后续 worker 帧新鲜度/看板漂移/演练/对账皆 patrol 族面，off 不执行
    if (autoTierOf("patrol") === "off") { this.appendReport("full: patrol off（仅 converge 段运行）"); return; }
    // observe3 R1 P2⑦：observe 干跑告知行收口（对应族离开 observe 档即 resolved——防按天驻留）
    try { this.mgr.resolveObserveAdvisories?.(); } catch { /* 收口尽力而为 */ }
    // boardlife 审后补（review-w-boardlife-b-1103 P1）：submitted 滞留铃——收割口漏斗
    // 兜底。done 出口=org CLI/HTTP 人工面（web/expo 无搬卡 UI，leader-harvest 纯只读），
    // PM 漏收一次=submitted 永挂（「板谎报」换「板沉默卡死」更糟）；30min 一拍扫 active
    // 组 submitted 卡 updated_at 超阈（缺省 24h，CCR_BOARD_SUBMITTED_STALE_MS 可调）推
    // 收割提醒。push 同文去重=安静卡不刷屏，卡龄进位/新卡才再响。
    try {
      const staleMs = Number(process.env.CCR_BOARD_SUBMITTED_STALE_MS) || 24 * 3600_000;
      const stale: string[] = [];
      for (const g of listGroups()) {
        const board = loadBoardFile(g.id);
        if (!board) continue; // 坏半态板跳过（读失败≠空板）
        for (const e of board.entries) {
          if (e.status !== "submitted") continue;
          if (now - Number(e.updated_at || 0) > staleMs) stale.push(`「${String(e.text || e.id).slice(0, 24)}」（${Math.floor((now - Number(e.updated_at || 0)) / 3600_000)}h）`);
        }
      }
      if (stale.length) this.push("board-submitted-stale", `审查中卡滞留超 ${Math.floor(staleMs / 3600_000)}h：${stale.length} 张待收割——${stale.slice(0, 3).join("、")}`);
    } catch { /* 尽力而为（铃不是闸） */ }
    // ── W-BOARDTRUTH 刀2（t-1e731c9c 第三现治本）：未认领 TTL 扫尾 ──
    // 派单 queued/dispatched 停滞超阈（CCR_UNCLAIMED_TTL_H 缺省 6h，"0"=关）=「未认领
    // 陈卡」真身（派了没开工，claimed 泳道虚高第三现成因之二）：台账 failed 收口+
    // 板卡回 backlog 标注+审计+PM 日聚合通知（同 key 幂等=非轰炸）。判定=board-truth
    // 纯函数（末行赢——早行 queued 晚行 done 的单不看早行）。
    try {
      const ttlH = Math.floor(unclaimedTtlMs() / 3600_000);
      if (Number.isFinite(ttlH)) {
        const staleD = unclaimedStaleDispatches(readDispatchLog(undefined, 20_000));
        if (staleD.length) {
          const dayKey = new Date().toISOString().slice(0, 10);
          let flippedN = 0;
          for (const r of staleD) {
            const did = String(r.id || "");
            if (!did) continue;
            appendDispatch({ ts: Date.now(), id: did, tier: "轻立项", target: "org-command", status: "failed", receipt: `未认领超时撤单（TTL ${ttlH}h——派单停滞 queued/dispatched 未开工，看板不说谎第三现治本刀2）`, session_id: "", actor: "system", failure_reason: "logic_error" }); // leaderId 私有——撤单行 session 空账（target=org-command 面已足）
            // W-BOARDTRUTH-R1（P1 撤单驱逐）：同步逐出 cap-queue 重放队列——否则 queued
            // 单在 drain 时照样重放，台账成 queued→failed→running 矛盾链（A 审定罪）
            try { this.mgr.evictQueuedDispatch(did); } catch { /* 驱逐尽力而为（drain 前查终态闸兜底） */ }
            // 板卡：dispatch_id 匹配的 claimed/在途卡回 backlog+标注（无卡=纯台账单零动作）
            for (const g of listGroups().filter((x) => x.status === "active")) {
              const board = loadBoardFile(g.id);
              if (!board) continue;
              const hit = board.entries.find((x) => x.dispatch_id === did);
              if (!hit || hit.status === "done" || hit.status === "backlog") continue;
              upsertBoardEntry(g.id, { id: hit.id, text: hit.text, status: "backlog", note: `${hit.note ? hit.note + " " : ""}[boardtruth ${new Date().toLocaleDateString("zh-CN")}] 未认领超时撤单（>${ttlH}h 未开工）——回待认领` });
              flippedN += 1;
              this.mgr.emitBoard(g.id);
            }
            this.mgr.emitChainAudit("boardtruth-unclaimed-ttl", `dispatch ${did.slice(0, 8)} 未认领超时撤单（>${ttlH}h 停滞）——台账 failed 收口${flippedN ? "+板卡回 backlog" : ""}`);
          }
          try {
            this.mgr.upsertNotification("system", `boardtruth-unclaimed-${dayKey}`, String(staleD.length), {
              title: `未认领超时撤单 ×${staleD.length}（日聚合）`,
              body: `超 ${ttlH}h 未开工派单自动撤：${staleD.slice(0, 3).map((x) => String(x.id || "").slice(0, 8)).join("、")}${staleD.length > 3 ? " 等" : ""}——板卡已回待认领（如需重派走原任务书）`,
              severity: "waiting", group: "attention", actionable: true, domain: "org", returnPath: "/",
            });
          } catch { /* 通知尽力而为 */ }
          this.appendReport(`BOARDTRUTH-TTL 撤单 ${staleD.length} 单（>${ttlH}h 未认领，板卡回 ${flippedN} 张）`);
        }
      }
    } catch (e) { console.warn(`[patrol] boardtruth TTL 扫失败（跳过）: ${e instanceof Error ? e.message : String(e)}`); }
    // ── W-BOARDTRUTH 刀3：审查中泳道 × 开 PR 真值强对账 ──
    // 板卡 submitted/ready_to_install 带 pr_url（prchip 落值）× gh pr list --state all
    // 真值：PR closed→翻 backlog 标陈；merged（事件丢失形态）→翻 done（pr-report 状态机
    // 补网）。gh 不可用=降级跳过（审计留痕）——无把握不动（任务书「无把握项标待核销推
    // PM」：无 pr_url 的审查中卡=无真值源不臆断，由 submitted 滞留铃（上方）兜底推收割）。
    try {
      const prRaw = execFileSync("gh", ["pr", "list", "--state", "all", "--json", "number,state,url,headRefName", "--limit", "100"], { encoding: "utf-8", timeout: 10_000 });
      const prs = JSON.parse(prRaw) as PrTruthSnap[];
      const boards: Array<{ gid: string; entries: TruthBoardEntry[] }> = [];
      for (const g of listGroups().filter((x) => x.status === "active")) {
        const board = loadBoardFile(g.id);
        if (board) boards.push({ gid: g.id, entries: board.entries as unknown as TruthBoardEntry[] });
      }
      const acts = prStaleBoardActions(boards, prs);
      let doneN = 0, backlogN = 0;
      for (const a of acts) {
        const board = boards.find((x) => x.gid === a.gid);
        const ent = board?.entries.find((x) => x.id === a.entryId);
        if (!ent) continue;
        if (a.reason === "pr-merged-missed") {
          const r = upsertBoardEntry(a.gid, { id: ent.id, text: ent.text ?? "", status: "done", note: `${ent.note ? ent.note + " " : ""}[boardtruth ${new Date().toLocaleDateString("zh-CN")}] PR merged 对账补翻（merged 事件丢失形态——pr-report 状态机补网）`, journal_action: "boardtruth-pr-merged-missed" });
          if (r.ok) doneN += 1;
        } else {
          const r = upsertBoardEntry(a.gid, { id: ent.id, text: ent.text ?? "", status: "backlog", note: `${ent.note ? ent.note + " " : ""}[boardtruth ${new Date().toLocaleDateString("zh-CN")}] PR 已关闭（非 merged）——审查中翻回待认领标陈`, journal_action: "boardtruth-pr-closed-stale" });
          if (r.ok) backlogN += 1;
        }
        this.mgr.emitChainAudit(a.reason === "pr-merged-missed" ? "boardtruth-pr-merged-missed" : "boardtruth-pr-closed-stale", a.detail);
        this.mgr.emitBoard(a.gid);
      }
      if (acts.length) {
        this.appendReport(`BOARDTRUTH-PR 对账处置 ${acts.length} 张（merged 补翻 ${doneN}+closed 退回 ${backlogN}）`);
        try {
          this.mgr.upsertNotification("system", "boardtruth-pr-reconcile", String(acts.length), {
            title: `审查中泳道对账处置 ×${acts.length}`,
            body: `PR 真值对账：merged 补翻 done ${doneN} 张+PR 已闭退 backlog ${backlogN} 张——泳道数字与 GitHub 真值强一致（第三现治本刀3）`,
            severity: "info", group: "activity", actionable: false, domain: "org", returnPath: "/",
          });
        } catch { /* 通知尽力而为 */ }
      }
    } catch { this.appendReport("BOARDTRUTH-PR gh 降级跳过（gh 不可用/超时——下拍重试）"); }
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
        // observe3 R1 P1-1（面③）：stale-escalate 绕 push 直写通知账（actionable 面更重）
        // ——observe 档只记 observe 账不写通知账；审计行（记录非动作）两档都留
        if (this.patrolObserve()) this.wouldDo("stale-escalate", "升级停滞通知", text.slice(0, 120));
        else {
          try {
            (this.mgr as any).upsertNotification("system", "stale-escalate", String(Math.floor(now / 60_000)), {
              title: `会话停滞升级（${stale.length} 个 >${WORKER_STALE_MIN}min 无帧）`,
              body: text,
              severity: "waiting", group: "attention", actionable: true, sessionId: first.session_id, domain: "session", returnPath: "/",
            });
          } catch { /* 升级尽力而为 */ }
        }
        try { (this.mgr as any).emitChainAudit?.("stale-escalate", text, first.session_id); } catch { /* 审计尽力而为 */ }
      }
    } else this.resolve(`worker-stale`);
    // [W-BOARDRECON R1]（1104 第三现；R1 按 A 审返修）：三方对账器——claimed 卡 ×
    // owner 会话活跃（多源判死+两拍确认）× dispatch 台账 running 行。R1-P1-3：档位
    // 挂 autoTierOf("boardrecon") 单点（原私有 env 绕过=审查打回项；块移到 patrol off
    // 早退后——patrol=off 对账不跑）；缺省 observe（PM 过目干跑清单后 config
    // autoBoardrecon 切）。R1-P1-2：终态收殓归 recon（本件只管孤儿/滞留/告警）。
    try {
      const mode = autoTierOf("boardrecon");
      // R2-P2：off 早退——off 档零动作（不加载板/零审计零通知；不能用 return——
      // 本方法后续还有看板漂移等扫描段）
      if (mode !== "off") {
      const boards: Array<{ gid: string; board: NonNullable<ReturnType<typeof loadBoardFile>> }> = [];
      for (const g of listGroups()) {
        if (g.status !== "active") continue;
        const b = loadBoardFile(g.id);
        if (b && !b.frozen) boards.push({ gid: g.id, board: b }); // R1-P2-3：frozen 板豁免（人工意图——converge hold 同口径）
      }
      const sessions = this.mgr.snapshot().map((x) => ({ session_id: x.session_id, done_reason: x.done_reason ?? null, status: x.status, cli_pid: x.cli_pid ?? null, last_active_at: x.updated_at ?? 0 }));
      const dispatchLog = readDispatchLog(undefined, 20_000); // R1-P2-4：台账窗 20k（converge 教训）
      // W-BOARDRECON-R3：收割证据三源构建（已收割未翻判定）——①台账 done+receipt 聚合
      // ②dev git log（子进程一次取回 10min 缓存——对账低频可接受）③回执文件尾行合规扫描
      // （artifacts/w-*.md 含「结果：…｜改动文件：」即合规，slug 键与卡/台账统一）。
      const harvest = ((): Parameters<typeof reconcileBoardCards>[0]["harvest"] => {
        const doneLedger = new Map<string, { count: number; hasReceipt: boolean }>();
        // R1-P2-1（A 审）：台账 done 终态行不带 title（appendDispatch 只在 dispatched 首行
        // 写——readDispatchLog 同 id 收敛取末行即丢；生产 1840 条仅 2 条带）→ 证据①恒死。
        // 修=ndjson 原始行两段聚合（chainrecall R1 同款直读）：按 id 聚「任意行提 title+
        // 末行判 done+任意行 receipt」，再按 slug 键聚合 count/hasReceipt。
        const byId = new Map<string, { title?: string; done: boolean; hasReceipt: boolean }>();
        try {
          for (const line of readFileSync(dispatchLogPath(), "utf-8").split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const r = JSON.parse(t) as { id?: string; title?: string; status?: string; receipt?: string };
              if (typeof r.id !== "string" || !r.id) continue;
              const cur = byId.get(r.id);
              byId.set(r.id, {
                title: r.title || cur?.title, // 首行（dispatched）title 保住——终态行不带
                done: r.status === "done" || (cur?.done ?? false), // 末行 done 即终态（后行覆盖前值语义：非 done 行不翻转已 done）
                hasReceipt: !!r.receipt || (cur?.hasReceipt ?? false),
              });
            } catch { /* 损坏行跳过 */ }
          }
        } catch { /* 台账不可读：证据①缺席（②仍可用——R1-P1-1 后①本就是弱证） */ }
        for (const { title, done, hasReceipt } of byId.values()) {
          if (!done || !title) continue;
          const key = harvestKeyOf(title);
          if (!key) continue;
          const cur = doneLedger.get(key);
          doneLedger.set(key, { count: (cur?.count ?? 0) + 1, hasReceipt: (cur?.hasReceipt ?? false) || hasReceipt });
        }
        if (Date.now() - this.reconDevLogCache.at > 10 * 60_000) {
          try {
            const anchor = listGroups().find((g) => g.status === "active")?.anchor_dir;
            if (anchor) {
              this.reconDevLogCache.text = execFileSync("git", ["-C", anchor, "log", "--oneline", "-400"], { encoding: "utf-8", timeout: 10_000 }).toLowerCase();
              this.reconDevLogCache.at = Date.now();
            }
          } catch { /* git 不可达=证据②缺席（①③仍可用） */ }
        }
        const receiptSlugs = new Set<string>();
        try {
          const artDir = process.env.CCR_ARTIFACTS_DIR ?? join(homedir(), ".cc-deck", "artifacts");
          for (const f of readdirSync(artDir)) {
            const m = f.match(/^w-[a-z0-9][a-z0-9-]{1,40}\.md$/i);
            if (!m) continue;
            try {
              const tail = readFileSync(join(artDir, f), "utf-8").slice(-400);
              if (tail.includes("结果：") && tail.includes("改动文件：")) receiptSlugs.add(m[0].replace(/\.md$/i, "").toLowerCase());
            } catch { /* 单文件读失败跳过 */ }
          }
        } catch { /* artifacts 目录不可读=证据③缺席 */ }
        return { doneLedger, devLogText: this.reconDevLogCache.text, receiptSlugs };
      })();
      const flagNow = new Set<string>();
      const r = reconcileBoardCards({ boards, sessions, dispatchLog, previouslyFlagged: this.reconFlagged, flaggedNow: flagNow, harvest });
      this.reconFlagged = flagNow; // 两拍确认跨拍状态推进（候选标记→下拍复核）
      const sig = r.actions.map((a) => a.entryId + a.reason).sort().join("|") + (r.mismatch ?? "");
      if (r.actions.length && sig !== this.reconLastSig) { // R1-P2-1 审计签名去重
        this.reconLastSig = sig;
        const lines2 = r.actions.slice(0, 8).map((a) => `${a.entryId}「${a.text}」${a.reason}：${a.detail}`);
        this.mgr.emitChainAudit("board-recon", `三方对账（${mode}）：${r.actions.length} 张判定——${lines2.join("；").slice(0, 400)}`);
        if (mode === "auto") {
          let moved = 0;
          let flipped = 0;
          for (const a of r.actions) {
            if (a.advisory) continue; // R1-P1-1：owner 活跃（长任务静默）只提醒不搬；R3 多义降告警同面
            const b = boards.find((x) => x.gid === a.gid)?.board;
            const e = b?.entries.find((x) => x.id === a.entryId);
            // W-BOARDRECON-R3：已收割未翻——submitted→done（journal action 定制=审计行
            // 可检索 boardrecon-auto-done；note 记证据依据——三证任一 Chain closure）
            if (a.toDone && e && e.status === "submitted") {
              const up = upsertBoardEntry(a.gid, { id: e.id, text: e.text, status: "done", note: `[boardrecon auto ${new Date().toLocaleDateString("zh-CN")}] 已收割未翻自动收口：${a.detail}`, journal_action: "boardrecon-auto-done" });
              if (up.ok) flipped++;
              continue;
            }
            if (e && e.status === "claimed") {
              const up = upsertBoardEntry(a.gid, { id: e.id, text: e.text, status: "backlog", note: `[boardrecon ${new Date().toLocaleDateString("zh-CN")}] ${a.reason} 归位可重派：${a.detail}` });
              if (up.ok) moved++; // R1-P2-3：核返回——拒写不计数
            }
          }
          this.push("board-recon", `三方对账（auto）：${moved} 张孤儿卡归位 + ${flipped} 张已收割未翻收口（advisory ${r.actions.filter((a) => a.advisory).length} 条仅提醒）`);
        } else {
          this.wouldDo("boardrecon", "归位孤儿卡", `${r.actions.filter((a) => !a.advisory).length} 张候选（两拍确认+旁证聚合后）——干跑不执行`);
          this.push("board-recon", `三方对账（observe）：${r.actions.length} 张判定（孤儿候选/滞留提醒）——清单在审计流，PM 过目后 config autoBoardrecon=auto 生效`);
        }
      }
      if (r.mismatch && r.mismatch !== this.reconLastMismatch) { // R1-P2-1 告警去重
        this.reconLastMismatch = r.mismatch;
        this.push("board-recon", `账实不符告警：${r.mismatch}`);
      }
      } // R2-P2 off 早退门闭
    } catch (e) {
      console.warn(`[patrol] 三方对账失败（跳过）: ${e instanceof Error ? e.message : String(e)}`);
    }
    // W-BOARDRECON-R2（P1 移位返修）：对账块与 stale 分支平级——深夜 0 在岗+孤儿卡群
    // （stale.length=0）时对账器照跑（R1 误嵌 if(stale.length) 体内=目标场景整支不跑）。
    // P2 off 早退：off 档零动作（不加载板/零审计零通知——autoTierOf 三档语义完整）。
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
    // ⑤ W-CMDIMPL ②（#216，设计 §2.1）：新回执扫描——近 N 小时落盘的回执/验收单文件
    // 无台账收口关联 → 低置信提醒（**不自动重派**——帧况停≠工作没做，重派前必查四证）。
    // 账源（P2-3 修正）：设计假设 artifacts-index.json 实不存在——以现实落点为准：
    // CCR_ARTIFACTS_DIR（~/.cc-deck/artifacts）+ dataDir/deliverables.json 双账；
    // 收口判定=文件名出现于 dispatch-log 任一终态行 receipt 字段（弱匹配从宽）。
    try {
      const staleH = num(process.env.CCR_PATROL_RECEIPT_STALE_H, RECEIPT_STALE_H_DEFAULT);
      const cutoff = now - staleH * 3600_000;
      const artDir = process.env.CCR_ARTIFACTS_DIR || join(homedir(), ".cc-deck", "artifacts");
      const candidates: { name: string; ageH: number }[] = [];
      const scanDir = (d: string) => {
        if (!existsSync(d)) return;
        for (const n of readdirSync(d)) {
          if (!/^receipt|^acceptance/i.test(n)) continue; // 只认回执/验收单命名面（模式收窄防误报）
          const full = join(d, n);
          try {
            const st = statSync(full);
            if (st.isFile() && st.mtimeMs < cutoff) candidates.push({ name: n, ageH: Math.round((now - st.mtimeMs) / 3600_000) });
          } catch {}
        }
      };
      scanDir(artDir);
      // deliverables.json 登记面（deliver 工具账）：近阈值登记的 path 也算候选
      try {
        const dv = JSON.parse(readFileSync(join(this.opts.dataDir, "deliverables.json"), "utf-8")) as { items?: { path?: string; ts?: number }[] };
        for (const it of dv.items ?? []) {
          if (!it.path || !/^receipt|^acceptance/i.test(it.path.split("/").pop() || "")) continue;
          const ts = Number(it.ts) || 0;
          if (ts && ts < cutoff) candidates.push({ name: it.path.split("/").pop() || it.path, ageH: Math.round((now - ts) / 3600_000) });
        }
      } catch {}
      // 收口弱匹配：文件名出现在台账任一终态行 receipt 字段=已收口
      let openNames: string[] = [];
      if (candidates.length) {
        const closedText = readDispatchLog(orgDir(), 2000)
          .filter((e) => e.status === "done" || e.status === "failed")
          .map((e) => String(e.receipt || ""))
          .join("\n");
        openNames = [...new Set(candidates.filter((c) => !closedText.includes(c.name)).map((c) => c.name))];
      }
      if (openNames.length) {
        this.push("receipt-stale", `${openNames.length} 份回执/验收单落盘>${staleH}h 未见派单收口：${openNames.slice(0, 4).join("、")}${openNames.length > 4 ? ` 等` : ""}（可能被遗忘的完成——人工核对后处置，不自动重派）`);
      } else this.resolve("receipt-stale");
    } catch (e) {
      console.log(`[patrol] receipt scan error: ${e instanceof Error ? e.message : e}`);
    }
    // ⑥ W-CMDIMPL ②（#216，设计 §2.2）：会话任务单维度陈年 pending——板维度 claimed
    // >48h 已有（②），会话 todos 维度缺。updated_at 缺席的项无法判龄（宽容跳过）。
    try {
      const todoH = num(process.env.CCR_PATROL_TODO_STALE_H, TODO_STALE_H_DEFAULT);
      const todoCutoff = now - todoH * 3600_000;
      const staleTodo = this.mgr.snapshot().filter((s) =>
        Array.isArray(s.todos) && s.todos.some((t) => t.status === "pending" && Number(t.updated_at ?? 0) > 0 && Number(t.updated_at) < todoCutoff));
      if (staleTodo.length) {
        this.push("todo-stale", `${staleTodo.length} 个会话存在 >${todoH}h 未动的待办任务：` +
          staleTodo.slice(0, 5).map((s) => `${s.title || s.session_id.slice(0, 8)}`).join("、"));
      } else this.resolve("todo-stale");
    } catch (e) {
      console.log(`[patrol] todo scan error: ${e instanceof Error ? e.message : e}`);
    }
    // ⑦ W-CMDIMPL T6（#216，设计 §2.4）：链路代码变更自动演练——org/dispatch/harvest/
    // patrol/drill 链路文件集主仓最新 commit 时间 > 上次 drill 时间则补跑一轮（relay 内
    // 兜底；失败与巡检告警同通道推用户）。主仓不可达（云端）静默跳过。
    try {
      const mainRepo = process.env.CCR_MAIN_REPO || join(homedir(), "dev", "cc-deck");
      if (drillDue(mainRepo, this.opts.dataDir)) {
        // observe3 R1 P1-1（面⑤：drill 向真实台账追加假任务行）：observe 档只记不跑
        if (this.patrolObserve()) { this.wouldDo("drill", "补跑链路演练", `主仓 ${mainRepo} 链路文件变更触发（不写台账假行）`); }
        else {
        const t = Date.now();
        const r = runDrill(this.opts.dataDir);
        if (!r.ok) this.push("drill-failed", `链路演练断点在「${r.failed_hop}」（全链 ${r.hops.length} 跳 / ${r.duration_ms}ms）——链路自身可能坏了`);
        else this.resolve("drill-failed");
        this.appendReport(`drill: ${r.ok ? "OK" : "FAIL@" + r.failed_hop} in ${Date.now() - t}ms`);
        }
      }
    } catch (e) {
      console.log(`[patrol] drill error: ${e instanceof Error ? e.message : e}`);
    }
    this.appendReport(`full: worker-stale=${stale.length} board=${boardAlerts.length ? boardAlerts.length + "项" : "OK"}`);
    // #199 D：full 周期挂三账对账 + 对账心跳查龄（PM turn-report 双触发，此处兜底——
    // PM 停帧时对账链不断）
    // observe3 R1 P1-1（面⑥：recon 对账含 recon-autoclose 搬卡副作用）：observe 档只记不跑
    if (this.patrolObserve()) this.wouldDo("recon", "跑三账对账", "patrol-full 周期触发（含 recon-autoclose 搬卡——不执行）");
    else { try { (this.mgr as any).runLedgerRecon?.("patrol-full"); } catch { /* 尽力而为 */ } }
    try {
      const hb = join(this.opts.dataDir, "recon-heartbeat.json");
      const st = statSync(hb);
      if (Date.now() - st.mtimeMs > 70 * 60_000) this.push("recon-stalled", `三账对账心跳停跳 ${Math.round((Date.now() - st.mtimeMs) / 60_000)}min（PM turn-report 与 patrol 双触发均未跑）`);
      else this.resolve("recon-stalled");
    } catch { /* 心跳文件未生成前静默 */ }
  }

  // ---------- M2a 板卡域两规则（multica 借②：wakeup_at 卡级定时 + doing 滞留提醒） ----------
  /** 规则①：wakeup_at 到点 → 消费制触发（actionable 通知+PM 喂活+字段清空防重触）。
   * 规则②：claimed(doing) 卡滞留>阈值（默认 60min，CCR_PATROL_DOING_STALE_MIN）且
   * 执行者会话同样无活动 → 滞留提醒（**不自动重派**——重派决策留人/PM，防误杀长编译；
   * 执行者活跃=卡旧人在干，不算滞留）。onset-only 去重与既有 patrol 告警同口径。 */
  private boardCardScan(): void {
    const now = Date.now();
    const staleMin = num(process.env.CCR_PATROL_DOING_STALE_MIN, DOING_STALE_MIN_DEFAULT);
    const staleMs = staleMin * 60_000;
    const sessionsById = new Map(this.mgr.snapshot().map((s) => [s.session_id, s]));
    const wakeHits: string[] = [];
    const stallHits: string[] = [];
    for (const g of listGroups()) {
      if (g.status !== "active") continue;
      const board = loadBoardFile(g.id);
      if (!board) continue;
      let touched = false;
      for (const e of board.entries) {
        // ① wakeup_at 到点（消费制：触发即置空，防下轮重触；消费失败留字段=下轮重扫，
        // 通知去重兜底防刷屏）
        if (e.wakeup_at && Number(e.wakeup_at) <= now) {
          const face = (e.text || e.id).slice(0, 24);
          const dueAt = new Date(Number(e.wakeup_at)).toLocaleString("zh-CN", { hour12: false });
          wakeHits.push(`[${g.name}] ${face}`);
          // observe3 R1 P1-1（面①：写板清 wakeup_at+直写通知账）：observe 档零板面副作用
          // ——wakeup_at 保留（研判可重复，observeSeen 去重防记账刷屏），只记 would-wake
          if (this.patrolObserve()) {
            this.wouldDo("board-wakeup", "唤醒板卡", `[${g.name}] ${face}（${dueAt}，当前 ${e.status} 泳道——不写板不清 wakeup_at）`);
            continue;
          }
          const r = upsertBoardEntry(g.id, { id: e.id, text: e.text, status: e.status, wakeup_at: null });
          if (r.ok) touched = true;
          try {
            (this.mgr as any).upsertNotification("system", "board-wakeup", e.id, {
              title: `板卡唤醒：${(e.text || e.id).slice(0, 30)}`,
              body: `wakeup_at 到点（${dueAt}）——卡在 [${g.name}]「${face}」当前 ${e.status} 泳道，按认领配置处置（重新派单或人工核卡）`,
              severity: "waiting", group: "attention", actionable: true, domain: "team", returnPath: "/",
            });
          } catch { /* 通知尽力而为 */ }
          continue;
        }
        // ② doing(claimed) 滞留：卡龄超阈值且（无主或主会话活动也超阈值——长编译防误杀）
        if (e.status === "claimed" && now - (e.updated_at ?? 0) > staleMs) {
          const owner = e.owner_session ? sessionsById.get(e.owner_session) : undefined;
          const ownerFresh = owner ? now - (owner.updated_at ?? 0) < staleMs : false;
          if (!ownerFresh) {
            stallHits.push(`[${g.name}] ${(e.text || e.id).slice(0, 24)}（${Math.round((now - (e.updated_at ?? 0)) / 60_000)}min 无进展${owner ? `·执行者 ${(owner.title || e.owner_session || "").slice(0, 8)} 同静默` : "·无执行者"}）`);
          }
        }
      }
      if (touched) { try { (this.mgr as any).emitBoard?.(g.id); } catch { /* 广播尽力而为 */ } }
    }
    if (wakeHits.length) {
      this.push("board-wakeup", `${wakeHits.length} 张板卡 wakeup 到点：${wakeHits.slice(0, 4).join("、")}${wakeHits.length > 4 ? " 等" : ""}`);
      // observe3 R1 P1-1（面②：feedPM 喂活 PM）：observe 档不喂活（push 侧自记 observe 账）
      if (!this.patrolObserve()) {
        try { (this.mgr as unknown as { feedPM?: (t: string) => void }).feedPM?.("board-wakeup"); } catch { /* 喂活尽力而为（无值守=纯通知面） */ }
      } else this.wouldDo("board-wakeup", "喂活PM", `board-wakeup ×${wakeHits.length}（feedPM 不执行）`);
    } else this.resolve("board-wakeup");
    if (stallHits.length) {
      const text = `${stallHits.length} 张 doing 卡滞留>${staleMin}min：${stallHits.slice(0, 5).join("、")}${stallHits.length > 5 ? " 等" : ""}（提醒不自动重派——重派决策留人/PM）`;
      this.push("board-doing-stale", text);
      // observe3 R1 P1-1（面④：doing-stale 绕 push 直写通知账）：observe 档只走 push 的
      // observe 记账，不落通知账
      if (!this.patrolObserve()) {
        try {
          (this.mgr as any).upsertNotification("system", "board-doing-stale", String(Math.floor(now / 60_000)), {
            title: `doing 滞留提醒（${stallHits.length} 张 >${staleMin}min 无进展）`,
            body: text,
            severity: "waiting", group: "attention", domain: "team", returnPath: "/",
          });
        } catch { /* 通知尽力而为 */ }
      }
    } else this.resolve("board-doing-stale");
    this.appendReport(`board-card: wakeup=${wakeHits.length} doing-stale=${stallHits.length}`);
  }

  // ---------- 去重推送（onset-only）+ 报告落盘 ----------
  private push(key: string, text: string): void {
    const prev = this.lastAlerts.get(key);
    if (prev === text) return; // 同条件未变化：不重推
    // observe3（patrol 族单咽喉）+R1 双修：observe 档干跑——研判照常、动作只记 observe
    // 账+web 一行式。P2⑧：observe **不写 lastAlerts**（防 observe→auto 切换后同文告警
    // 被「observe 期见过」吞掉——去重走独立 observeSeen 账）；P2①：observe 记录补
    // upsertNotification 一行式（day-bucket+attention 组+[observe] 前缀，converge/revive
    // 同款——「先看见再放开」对 patrol 族成立）。auto 档零变化；off 档定时器层已拦。
    if (autoTierOf("patrol") === "observe") {
      const seen = this.observeSeen.get(key);
      if (seen === text) return; // observe 期间同文不重复记账（独立账，不占 auto 去重位）
      this.observeSeen.set(key, text);
      recordWouldDo(this.opts.dataDir, "patrol", key, "push", text);
      try {
        this.mgr.upsertNotification("system", "observe-patrol-" + key, observeBucket(), {
          title: `[observe] 巡检将告警：${key}`,
          body: `patrol 档=observe（研判通过不推送）。${text.slice(0, 140)}——转 auto 档才会推送`,
          severity: "waiting", group: "attention", actionable: false, domain: "session", returnPath: "sessions",
        });
      } catch { /* 通知账不可用时 observe-log 已在案 */ }
      this.appendReport(`OBSERVE [${key}] ${text}`);
      return;
    }
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
        // observe3 R1 P1-1（面⑦：breaker 补试自主拉活 PM）：observe 档只记不喂
        if (this.patrolObserve()) { this.wouldDo("patrol-retry", "补试喂活PM", `熔断到期会话（streak=${s.resumeFailStreak ?? "?"}）——feedPM 不执行`); return; }
        this.appendReport(`BREAKER-RETRY cooldown 到期补试 feedPM（streak=${s.resumeFailStreak ?? "?"}）`);
        sm.feedPM("patrol-retry");
        return;
      }
    }
  }

  private resolve(key: string): void {
    this.observeSeen.delete(key); // observe3 R1：observe 去重账同刻清（恢复后新 onset 重新记账）
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
