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
import { homedir } from "node:os";
import { listGroups, loadBoardFile, upsertBoardEntry } from "./projects.js";
import { readDispatchLog, orgDir } from "./org.js";
import { drillDue, runDrill } from "./drill.js";
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
        let freed = 0;
        for (const d of hit) {
          try { rmSync(d, { recursive: true, force: true }); freed++; } catch { /* 占用中的跳过 */ }
        }
        this.push("cbc-prefetch", `清理了 ${freed} 个更新预取残留目录（每个约 288MB，磁盘反复吃紧的已知源头）`);
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
        const t = Date.now();
        const r = runDrill(this.opts.dataDir);
        if (!r.ok) this.push("drill-failed", `链路演练断点在「${r.failed_hop}」（全链 ${r.hops.length} 跳 / ${r.duration_ms}ms）——链路自身可能坏了`);
        else this.resolve("drill-failed");
        this.appendReport(`drill: ${r.ok ? "OK" : "FAIL@" + r.failed_hop} in ${Date.now() - t}ms`);
      }
    } catch (e) {
      console.log(`[patrol] drill error: ${e instanceof Error ? e.message : e}`);
    }
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
      try { (this.mgr as unknown as { feedPM?: (t: string) => void }).feedPM?.("board-wakeup"); } catch { /* 喂活尽力而为（无值守=纯通知面） */ }
    } else this.resolve("board-wakeup");
    if (stallHits.length) {
      const text = `${stallHits.length} 张 doing 卡滞留>${staleMin}min：${stallHits.slice(0, 5).join("、")}${stallHits.length > 5 ? " 等" : ""}（提醒不自动重派——重派决策留人/PM）`;
      this.push("board-doing-stale", text);
      try {
        (this.mgr as any).upsertNotification("system", "board-doing-stale", String(Math.floor(now / 60_000)), {
          title: `doing 滞留提醒（${stallHits.length} 张 >${staleMin}min 无进展）`,
          body: text,
          severity: "waiting", group: "attention", domain: "team", returnPath: "/",
        });
      } catch { /* 通知尽力而为 */ }
    } else this.resolve("board-doing-stale");
    this.appendReport(`board-card: wakeup=${wakeHits.length} doing-stale=${stallHits.length}`);
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
