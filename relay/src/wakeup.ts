// ---------- T1 条件唤醒基建最小版（DEV-43，multica --until-* 语义对齐） ----------
// 「平台替你验事实，事实成立才叫人」（竞品调研 F1）：唤醒规则存 relay 侧规则表，
// 周期验谓词——事实成立才外发（云桥直推手机，cloud-push.ts 同通道）；事实一直
// 不成立则 expiresAt 兜底（到期发一条「规则过期未满足」的触达后死亡，绝不静默
// 消失——multica --expires-in 的语义是兜底不是哑火）。
//
// 谓词最小集（relay 已有域对象的状态类）：
//   · session_status     —— 会话状态到位（如「某会话转 ERROR」「任一 external 转
//                           WORKING」；PM 候命位死亡=leader/duty 会话离场侧的等价
//                           观测位，当前 no-leader 态下先供排产/演练用）
//   · board_entry_status —— 板卡状态到位（如「某卡 submitted/done」——验收回流
//                           断档 DL-P1-3 的观测位）
//   · notification_pending —— 通知账 pending 数越线（告警积压=无人消费的观测位）
//
// 存储形态：data/wakeup-rules.json（relay 原生状态文件——同 cloud-peers.json 族，
// 非导入域；升 sqlite 随存储收口批走，本件最小版不动 schema）。写盘 tmp+rename
// 原子替换；读失败按空表起（规则丢了炸不掉 relay）。
//
// 外发：pushAll 注入（index.ts 装配 pushCloudAlertAll；测试注入桩）。一次触发
// one-shot——fired 后不再评；expired 同理。评估纯函数化（evaluateWakeup）供
// 测试锚：事实成立触发/不成立不触发/expires 兜底三负向见 tests/test-wakeup.ts。
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type WakeupPredicate =
  | { kind: "session_status"; status: string; sessionId?: string; external?: boolean }
  | { kind: "board_entry_status"; status: string; textIncludes?: string }
  | { kind: "notification_pending"; minCount: number };

export type WakeupRuleState = "armed" | "fired" | "expired";

export interface WakeupRule {
  id: string;
  createdAt: number;
  createdBy: string;
  predicate: WakeupPredicate;
  /** 触发窗下限（ms）：创建后须满窗才可触发——防「创建即满足」的自反噪声 */
  triggerAfterMs?: number;
  /** 兜底过期（epoch-ms）：到期未满足 → 发过期触达后转 expired */
  expiresAt?: number;
  title: string;
  body: string;
  level?: string;
  state: WakeupRuleState;
  firedAt?: number;
  /** 触发原因：predicate=事实成立；expired=兜底过期 */
  firedReason?: "predicate" | "expired";
  /** 评估次数（诊断面：谓词器活着但一直不满足的可见位） */
  checks: number;
}

export interface WakeupFacts {
  sessions: Array<{ sessionId: string; status: string; external: boolean }>;
  boardEntries: Array<{ text: string; status: string }>;
  notificationPending: number;
}

export interface WakeupOutcome {
  action: "fire" | "wait" | "expire" | "noop";
}

function predicateHolds(p: WakeupPredicate, facts: WakeupFacts): boolean {
  switch (p.kind) {
    case "session_status":
      return facts.sessions.some(
        (s) =>
          (!p.sessionId || s.sessionId === p.sessionId) &&
          (!p.external || s.external) &&
          s.status === p.status,
      );
    case "board_entry_status":
      return facts.boardEntries.some(
        (e) => e.status === p.status && (!p.textIncludes || e.text.includes(p.textIncludes)),
      );
    case "notification_pending":
      return facts.notificationPending >= p.minCount;
  }
}

/** 评估单规则（纯函数）。顺序语义：过期检查先于事实成立（expires 是硬上限——
 * 到期那一拍即便事实同时成立也按过期走，防「永不满足的规则借过期窗尾触发」
 * 的边沿歧义；triggerAfter 窗内一律 wait）。 */
export function evaluateWakeup(rule: WakeupRule, facts: WakeupFacts, now: number): WakeupOutcome {
  if (rule.state !== "armed") return { action: "noop" };
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return { action: "expire" };
  if (rule.triggerAfterMs !== undefined && now < rule.createdAt + rule.triggerAfterMs) return { action: "wait" };
  return predicateHolds(rule.predicate, facts) ? { action: "fire" } : { action: "wait" };
}

// ---------- 存储 ----------

export function loadWakeupRules(dataDir: string): WakeupRule[] {
  try {
    const f = join(dataDir, "wakeup-rules.json");
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is WakeupRule => !!x && typeof x === "object" && typeof (x as WakeupRule).id === "string");
  } catch {
    return [];
  }
}

export function saveWakeupRules(dataDir: string, rules: WakeupRule[]): void {
  const f = join(dataDir, "wakeup-rules.json");
  const tmp = f + ".tmp";
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify(rules, null, 1));
  renameSync(tmp, f);
}

export interface ArmWakeupInput {
  predicate: WakeupPredicate;
  title: string;
  body: string;
  createdBy: string;
  level?: string;
  triggerAfterMs?: number;
  /** 相对过期（ms）——与 expiresAt 二选一，都给以 expiresAt 为准 */
  expiresInMs?: number;
  expiresAt?: number;
}

export function newWakeupRule(input: ArmWakeupInput, now: number = Date.now()): WakeupRule {
  return {
    id: "wk-" + now.toString(36) + "-" + randomUUID().slice(0, 8),
    createdAt: now,
    createdBy: input.createdBy,
    predicate: input.predicate,
    triggerAfterMs: input.triggerAfterMs,
    expiresAt: input.expiresAt ?? (input.expiresInMs !== undefined ? now + input.expiresInMs : undefined),
    title: input.title.slice(0, 120),
    body: input.body.slice(0, 500),
    level: input.level,
    state: "armed",
    checks: 0,
  };
}

// ---------- 服务（周期评估 + 外发） ----------

export type WakeupPushFn = (title: string, body: string, level?: string) => Promise<unknown>;

export interface WakeupServiceOptions {
  dataDir: string;
  push: WakeupPushFn;
  /** 事实采集（缺域=空集，不炸） */
  facts: () => WakeupFacts;
  checkMs?: number;
  now?: () => number;
  report?: (line: string) => void;
}

export class WakeupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: WakeupServiceOptions) {}

  start(): void {
    if (this.timer) return;
    const ms = this.opts.checkMs ?? (Number(process.env.CCR_WAKEUP_CHECK_MS) || 30_000);
    if (ms <= 0) return; // 0=显式关
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  arm(input: ArmWakeupInput): WakeupRule {
    const rules = loadWakeupRules(this.opts.dataDir);
    const rule = newWakeupRule(input, (this.opts.now ?? Date.now)());
    rules.push(rule);
    saveWakeupRules(this.opts.dataDir, rules);
    this.opts.report?.(`ARMED [${rule.id}] ${rule.title}（${rule.predicate.kind}，${rule.expiresAt ? "expires " + new Date(rule.expiresAt).toISOString() : "无兜底窗"}）`);
    return rule;
  }

  list(): WakeupRule[] {
    return loadWakeupRules(this.opts.dataDir).filter((r) => r.state === "armed");
  }

  cancel(id: string): boolean {
    const rules = loadWakeupRules(this.opts.dataDir);
    const hit = rules.find((r) => r.id === id && r.state === "armed");
    if (!hit) return false;
    hit.state = "expired";
    hit.firedAt = (this.opts.now ?? Date.now)();
    saveWakeupRules(this.opts.dataDir, rules);
    this.opts.report?.(`CANCELLED [${id}]`);
    return true;
  }

  /** 单轮评估（幂等可直调——测试/演练用）。串行锁防重入（周期拍与手动 tick 撞车）。 */
  async tick(): Promise<{ fired: number; expired: number }> {
    if (this.running) return { fired: 0, expired: 0 };
    this.running = true;
    let fired = 0;
    let expired = 0;
    try {
      const now = (this.opts.now ?? Date.now)();
      const rules = loadWakeupRules(this.opts.dataDir);
      let dirty = false;
      let facts: WakeupFacts | null = null;
      for (const rule of rules) {
        if (rule.state !== "armed") continue;
        if (facts === null) facts = this.opts.facts();
        rule.checks = (rule.checks ?? 0) + 1;
        dirty = true;
        const out = evaluateWakeup(rule, facts, now);
        if (out.action === "fire") {
          rule.state = "fired";
          rule.firedAt = now;
          rule.firedReason = "predicate";
          fired++;
          this.opts.report?.(`FIRED [${rule.id}] ${rule.title}`);
          try { await this.opts.push(rule.title, rule.body, rule.level); } catch { /* 外发尽力而为 */ }
        } else if (out.action === "expire") {
          rule.state = "expired";
          rule.firedAt = now;
          rule.firedReason = "expired";
          expired++;
          // 兜底触达：过期≠静默死——到期仍发一条（低级别），等的人知道等完了
          this.opts.report?.(`EXPIRED [${rule.id}] ${rule.title}（事实未成立，兜底触达）`);
          try {
            await this.opts.push(`⏰ 唤醒规则过期：${rule.title}`.slice(0, 120), `等待窗已结束，事实未成立——${rule.body}`.slice(0, 500), "info");
          } catch { /* 外发尽力而为 */ }
        }
      }
      if (dirty) saveWakeupRules(this.opts.dataDir, rules);
    } finally {
      this.running = false;
    }
    return { fired, expired };
  }
}
