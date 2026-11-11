// 看板投影（W-BOARDV2，1111 用户架构定调「查表即真相」）
// ============================================================
// 架构语义：boards/<gid>.json 的卡位字段不再作为状态真相（历史副本保留兼容但降级为
// 事件源之一）——看板渲染改为**读时计算**：从 dispatch-log.ndjson（含 W-BOARDV2 黑板
// 事件链）+ 板卡 transitions 实时投影每张卡的当前泳道。没有第二份账，不可能漂移；
// 既有 LANEFLIP/BOARDTRUTH 副本对账机制在此模型下自然消亡（二期退役，本期并行落）。
//
// 时间线合并规则（后写赢，单一事实源不破）：
//   ① dispatch-log 行（按卡 dispatch_id 关联；黑板事件链=执行侧真相）
//   ② 板卡 transitions（收割/PR merged/人工 move 族写入——流程侧真相，二期起由
//      user-override/harvest 事件行接替；transitions[0]=建卡首道入线，跳过——初始态）
//   ③ 板文件当前态隐式行（updated_at 时点；transitions 缺席的存量卡兜底）
//   ④ user-override 事件行（target=card:<gid>:<entry_id>，手动改板；stage=
//      custom.board-<lane> 承载目标泳道——schema 合法且不改六态状态机）
// 全部按 ts 升序排序后顺序归并，末行赢（同 ts 保持插入序：dispatch 行→transitions→
// 基线行→override 的 push 序即同 ts 优先级，基线兜底行最后 push=板面自述最弱）。
//
// 泳道词表=BOARD_ENTRY_STATUSES 同形（planned/backlog/claimed/submitted/
// ready_to_install/done）：web/RN 四处锚零改动即可消费（UI 兼容铁律）；语义映射：
//   queued→backlog（排队 chip）/ dispatched·running·worker-ack·worker-start·
//   worker-milestone→claimed（进行中）/ worker-done·relay done 收口·in_review·
//   submitted→submitted（待审）/ 收割 done（板侧 done 晚于 relay 收口）→done /
//   failed→backlog（打回 chip）。
//
// 性能兜底（1111 定调：表尾窗口/秒级缓存）：dispatch-log 尾窗 20000 行（与对账/收割
// 读窗统一——双窗会口径分裂，反方审查 P3 处置）+ 行数指纹的进程内缓存（台账未变直接
// 回缓存，投影 O(卡数)；age_ms/generated_at 每次调用现算——缓存命中不冻结停留时长，
// 「卡死/跑路」形态正是本投影要抓的信号）。投影自身零写零翻卡零副作用；loadBoardFile
// 内嵌的 heal/迁移写盘属 projects 域既有行为，与本模块无关。

import { readDispatchLogRaw, type DispatchEntry } from "./org.js";
import { loadBoardFile, type BoardEntry } from "./projects.js";

/** 投影泳道 = BOARD_ENTRY_STATUSES 同形词表（UI 四处锚零改动） */
export type ProjectedLane = "planned" | "backlog" | "claimed" | "submitted" | "ready_to_install" | "done";

export interface ProjectedLifecycleRow {
  ts: number;
  /** 黑板事件词（dispatch-queued/…/worker-done/user-override）；transitions/基线行为空串 */
  event: string;
  /** 行 status（六态）或 transitions 落点/override 目标（板态词） */
  status: string;
  /** 行来源（tie-break 权威：同毫秒时 dispatch/transition 行赢过基线行——事件是细粒度真相） */
  kind: "dispatch" | "transition" | "base" | "override";
  detail?: string;
}

export interface ProjectedCard {
  entry_id: string;
  text: string;
  priority?: string;
  /** 板文件存量态（legacy 副本，兼容保留——投影 lane 才是渲染真相） */
  base_status: string;
  /** 投影泳道（BOARD_ENTRY_STATUSES 同形） */
  lane: ProjectedLane;
  /** 当前态判定依据：定泳道那行的事件词/来源（人读可辨「为什么在这条泳道」） */
  last_event: string;
  last_event_ts: number;
  /** 当前态停留时长（毫秒；now-last_event_ts） */
  age_ms: number;
  dispatch_id?: string;
  /** 该卡黑板全链（时间升序；派发决策→施工→交付→收口全程可回放——1111 用户追加①） */
  lifecycle: ProjectedLifecycleRow[];
  /** worker 真交付申报（worker-done 事件）时刻与申报文 */
  worker_done_at?: number;
  worker_done_detail?: string;
  /** done 说真话：relay 收口 done 但 worker-done 缺席（半途跑路/静默收工——1111 实锤形态） */
  abnormal_done?: boolean;
  /** 收口回执摘（≤120） */
  receipt?: string;
  /** 资格位拦截标（W-CARDLIFE-R3 透传——投影面可见「催收中」） */
  receipt_gate?: boolean;
}

export interface BoardProjection {
  gid: string;
  generated_at: number;
  source: "dispatch-log-projection";
  cards: ProjectedCard[];
}

// ---------- dispatch 行 → 泳道映射（单点词表，测试锚） ----------

/** 黑板事件 → 泳道（worker 侧四态+派发侧 queued；其余派发侧事件不改泳道——
 *  reused/spawned/seat-scan 的泳道语义由行 status 决定）。 */
function eventLane(event: string): ProjectedLane | null {
  switch (event) {
    case "worker-done":
      return "submitted"; // 真交付申报→待审（1111 生命周期映射）
    case "worker-ack":
    case "worker-start":
    case "worker-milestone":
      return "claimed"; // 接单/开工/心跳→进行中
    case "dispatch-queued":
      return "backlog"; // 入队→待办（排队 chip 由 last_event 辨）
    case "user-override":
      return null; // 泳道由行 status=目标板态承载（写侧约定），见归并循环
    case "dispatch-seat-scan":
    case "dispatch-reused":
    case "dispatch-spawned":
      return null; // 派发过程事件：不改泳道（dispatched 行自身已定 claimed）
    default:
      return null;
  }
}

/** dispatch 六态 → 泳道（无事件行的旧行兼容口径）。 */
function statusLane(status: string): ProjectedLane | null {
  switch (status) {
    case "queued":
      return "backlog";
    case "dispatched":
    case "running":
      return "claimed";
    case "done":
      // relay 收口 done=worker 回合终态→待 PM 审查（closeOpenDispatches R2 内核
      // 把卡翻 submitted 同语义）；收割完成的 done 由板侧晚行覆盖
      return "submitted";
    case "failed":
      return "backlog"; // 打回（chip 由 last_event 辨「失败」）
    case "in_review":
      return "submitted";
    default:
      return null; // 未知态不参与判定（宽容惯例）
  }
}

/** 板态词 → 泳道（词表同形恒等；显式列出防漂移，未知态宽容落待办）。 */
function boardLane(status: string): ProjectedLane {
  switch (status) {
    case "planned":
    case "backlog":
    case "claimed":
    case "submitted":
    case "ready_to_install":
    case "done":
      return status;
    default:
      return "backlog";
  }
}

// ---------- 秒级缓存（台账指纹） ----------

interface ProjectionCacheEntry {
  sig: string;
  projection: BoardProjection;
}
const projectionCache = new Map<string, ProjectionCacheEntry>();

/** 清缓存（测试缝——投影断言跨夹具隔离用；板面手动强刷面备用）。 */
export function clearBoardProjectionCache(): void {
  projectionCache.clear();
}

// ---------- 主投影 ----------

/** 缓存命中出参：age_ms/generated_at 每次现算（停留时长=「卡死/跑路」核心信号，
 *  缓存命中冻结会让最需要它的场景失真，审查 A-P1 ④）。浅拷贝 O(卡数)，台账 parse
 *  （真开销）仍被缓存挡住。 */
function freshAges(p: BoardProjection): BoardProjection {
  const now = Date.now();
  return {
    ...p,
    generated_at: now,
    cards: p.cards.map((c) => ({ ...c, age_ms: Math.max(0, now - c.last_event_ts) })),
  };
}

/**
 * 单板投影：板卡静态数据（boards/<gid>.json，legacy）× dispatch-log 尾窗事件链
 * → 每卡当前泳道 + 全生命周期时间线。纯读零副作用；台账未变走缓存。
 */
export function projectBoard(gid: string): BoardProjection {
  const board = loadBoardFile(gid);
  const entries: BoardEntry[] = board?.entries ?? [];
  // dispatch-log 原始行（尾窗 20000——与 hasDispatchEvent 对账窗/leader-board 读窗统一；
  // 手搬卡/心跳链被 2000 窗挤出会致投影回跳与口径分裂，反方审查 P3 处置）
  let rows: DispatchEntry[] = [];
  try {
    rows = readDispatchLogRaw(undefined, 20_000);
  } catch {
    rows = [];
  }
  const boardSig = `${entries.length}:${board?.updated_at ?? 0}`;
  const lastRow = rows[rows.length - 1];
  const sig = `${rows.length}:${lastRow ? `${lastRow.id}:${lastRow.ts}` : "-"}|${boardSig}`;
  const cached = projectionCache.get(gid);
  if (cached && cached.sig === sig) return freshAges(cached.projection);

  const now = Date.now();
  // 行索引：dispatch_id → 全部行（文件序）；user-override 行按卡索引（target=card:<gid>:<entry_id>）
  const byDispatch = new Map<string, DispatchEntry[]>();
  const overridesByCard = new Map<string, DispatchEntry[]>();
  for (const r of rows) {
    if (r.event === "user-override") {
      const m = /^card:([^:]+):(.+)$/.exec(r.target ?? "");
      if (m && m[1] === gid) {
        const arr = overridesByCard.get(m[2]) ?? [];
        arr.push(r);
        overridesByCard.set(m[2], arr);
      }
      continue;
    }
    const arr = byDispatch.get(r.id) ?? [];
    arr.push(r);
    byDispatch.set(r.id, arr);
  }

  const cards: ProjectedCard[] = entries.map((entry) => {
    const lifecycle: ProjectedLifecycleRow[] = [];
    const drows = entry.dispatch_id ? (byDispatch.get(entry.dispatch_id) ?? []) : [];
    for (const r of drows) {
      lifecycle.push({
        ts: typeof r.ts === "number" ? r.ts : 0,
        event: r.event ?? "",
        status: r.status,
        kind: "dispatch",
        ...(r.receipt ? { detail: String(r.receipt).slice(0, 120) } : r.stage ? { detail: r.stage } : {}),
      });
    }
    // transitions[0]=建卡「首道入线」（projects.ts 建卡写 transitions:[{status,ts}]）——
    // 初始态记录，不是后续搬卡事件；投影跳过（初始态由 base 行承载）。跳过它防同毫秒
    // 竞争：建卡与派行同 ms 时（relay 建卡紧跟 running 行，生产常态），首道入线若参与
    // tie-break 会以「更晚插入序」压过 failed/done 等终态行（test-boardv2 B5 实锤）。
    // 存量卡（pre-件十九建卡无 transitions）的首行可能是搬卡/迁移写入而非建卡
    //（审查 A-P2 ⑧）——首行仅在「贴近建卡时点（entry.ts+5s 内）」时视作首道入线跳过，
    // 晚于它的一律当真实搬卡事件参与归并
    const trans = entry.transitions ?? [];
    const skipFirst = trans.length > 0 && (trans[0].ts ?? 0) <= (entry.ts ?? 0) + 5_000;
    for (let i = skipFirst ? 1 : 0; i < trans.length; i++) {
      const t = trans[i];
      lifecycle.push({ ts: t.ts, event: "", status: t.status, kind: "transition" });
    }
    for (const o of overridesByCard.get(entry.id) ?? []) {
      lifecycle.push({
        ts: typeof o.ts === "number" ? o.ts : 0,
        event: "user-override",
        // 写侧约定（session-manager board-move 写入口）：override 行 status 恒 "done"
        //（六态合法终态值——schema 写严格），目标泳道在 stage=custom.board-<lane>
        status: (o.stage ?? "").replace(/^custom\.board-/, "") || "backlog",
        kind: "override",
        ...(o.receipt ? { detail: String(o.receipt).slice(0, 120) } : {}),
      });
    }
    // 板文件当前态隐式行（updated_at 时点；kind=base=同毫秒 tie-break 里优先级最低的兜底源）
    lifecycle.push({ ts: entry.updated_at ?? entry.ts ?? 0, event: "", status: entry.status, kind: "base" });
    lifecycle.sort((a, b) => a.ts - b.ts); // 稳定排序（ES2019+ Array.sort 恒稳定）：同 ts 保持插入序

    let lane: ProjectedLane = boardLane(entry.status);
    let lastEvent = `board:${entry.status}`;
    let lastTs = entry.updated_at ?? entry.ts ?? now;
    for (const row of lifecycle) {
      // tie-break（同毫秒）：dispatch/transition/override 行恒可应用（后写赢，事件是
      // 细粒度真相）；base 兜底行只在严格更晚时参与（防同 ms 基线覆盖事件判定——
      // 建卡与派行同 ms 是生产常态）
      const isBase = row.kind === "base";
      const applicable = isBase ? row.ts > lastTs : row.ts >= lastTs;
      if (!applicable) continue;
      let candidate: ProjectedLane | null;
      let label: string;
      if (row.event === "user-override") {
        candidate = boardLane(row.status); // override 行 status=目标板态（写侧约定）
        label = `user-override→${row.status}`;
      } else if (row.event) {
        candidate = eventLane(row.event) ?? statusLane(row.status);
        label = row.event; // 黑板事件词=判定依据最细粒度
      } else if (row.kind === "dispatch") {
        // 纯六态 dispatch 行（无 event 的旧链行：dispatched/running/done/failed 直映）
        candidate = statusLane(row.status);
        label = `dispatch:${row.status}`;
      } else {
        candidate = boardLane(row.status); // transitions/基线行（板态词直映）
        label = `board:${row.status}`;
      }
      if (candidate) {
        const changed = candidate !== lane;
        lane = candidate;
        lastTs = row.ts;
        // last_event 语义=「当前态怎么来的」：事件词恒记（最细粒度）；无事件行只在
        // 泳道变化时记（防机械行洗掉更有信息量的事件词）；base 兜底行不洗事件词
        if (row.event) lastEvent = label;
        else if (changed && !isBase) lastEvent = label;
      }
    }
    // last_event 精化：最近一条黑板事件词若与终态泳道同向，则优先呈现——
    // 「为什么在这条泳道+最近发生了什么」双答（板副本较新但无信息量时，事件词
    // 比 board:<status> 更可判读；反向（如收口后残留施工心跳）不回退，laneSetter 为准）
    {
      const evRows = lifecycle.filter((r) => r.event && r.event !== "user-override");
      if (evRows.length) {
        const lastEv = evRows[evRows.length - 1];
        const implied = eventLane(lastEv.event) ?? statusLane(lastEv.status);
        if (implied === lane) lastEvent = lastEv.event;
      }
    }

    const doneRows = drows.filter((r) => r.status === "done");
    const lastDone = doneRows[doneRows.length - 1];
    const workerDoneRows = drows.filter((r) => r.event === "worker-done");
    const lastWorkerDone = workerDoneRows[workerDoneRows.length - 1];

    return {
      entry_id: entry.id,
      text: entry.text,
      ...(entry.priority ? { priority: entry.priority } : {}),
      base_status: entry.status,
      lane,
      last_event: lastEvent,
      last_event_ts: lastTs,
      age_ms: Math.max(0, now - lastTs),
      ...(entry.dispatch_id ? { dispatch_id: entry.dispatch_id } : {}),
      // 出参下采样（审查 A-P2 ⑨）：帧随带 lifecycle 全量会随心跳卡膨胀（90s 节流下
      // 长单数百行×每帧）——归并判定已在上全量跑完，出参截尾 40 行（最近真相）；
      // 全链回放走 leader-board/原始台账（append-only 审计面恒全量）
      lifecycle: lifecycle.length > 40 ? lifecycle.slice(-40) : lifecycle,
      ...(lastWorkerDone ? { worker_done_at: lastWorkerDone.ts, ...(lastWorkerDone.receipt ? { worker_done_detail: String(lastWorkerDone.receipt).slice(0, 120) } : {}) } : {}),
      ...(lastDone?.abnormal_done === true ? { abnormal_done: true } : {}),
      ...(lastDone?.receipt ? { receipt: String(lastDone.receipt).slice(0, 120) } : {}),
      ...(lastDone?.receipt_gate === true ? { receipt_gate: true } : {}),
    };
  });

  const projection: BoardProjection = {
    gid,
    generated_at: now,
    source: "dispatch-log-projection",
    cards,
  };
  projectionCache.set(gid, { sig, projection });
  if (projectionCache.size > 64) {
    // 防陈账膨胀：超 64 板清最旧（FIFO 简易——生产组数 << 64，防御性保留）
    const firstKey = projectionCache.keys().next().value;
    if (firstKey !== undefined) projectionCache.delete(firstKey);
  }
  return freshAges(projection); // 出参 age 现算（缓存底稿不动，命中路径同口径）
}
