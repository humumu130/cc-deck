// X1 多机编排（PRD v0.3 §3.2/§4.2-4.4/§4.8）：密封 xmsg 子系统控制器——策略面单源。
// 职责分界：本文件=信任裁决/首联卡/投递/outbox 补发/审计；cloud-client=解封与桥帧传输；
// xmsg.ts=账本与校验；device-trust.ts=互信表。挂在 SessionManager（mixin 范式，
// this.→mgr. any 网关同 misc-commands.ts 口径）。
//
// 接收链（§4.3）：解封（传输面）→信任链校验→（未信）首联卡+悬置→（已信）既有注入链
// →xack 四态（queued=已入 ext-input 队列/悬置首联；injected=flushQueue 真敲进 CLI 或
// managed 直发；rejected:<reason>=策略拒；failed[:<reason>]=投递尝试失败）。
// 幂等 24h 同窗（msg_id seen 缓存回执，断线补发零重）。
// 发送链（§4.2 三口汇流）：COMMAND_XMSG op=send → outbox 落盘 → 泵（限速 2 条/对/秒）
// →桥帧密封发送 → xack 回填 outbox 终态（ccops/org CLI/面板轮询 op=status 可见）。
import { randomUUID } from "node:crypto";
import type { CommandAckPayload } from "../types.js";
import { addConfirm, listPendingConfirms } from "../projects.js";
import { confirmDevice, getDeviceTrust, listDeviceTrust, revokeDevice, trustStore, trustVerdict, upsertFirstSeen } from "../device-trust.js";
import {
  annotateBody, isXmsgWire, isXackWire, openXmsgStores, spkMatchesDev, validateXmsgInner,
  XMSG_BODY_MAX, XMSG_TTL_DEFAULT_MS, xmsgEnabled, XmsgRateGate,
  type XackInner, type XmsgHeldItem, type XmsgInner, type XmsgOutboxState, type XmsgStores,
} from "../xmsg.js";

/** 传输面（index.ts 注入，跨 cloudClients 聚合；cloud-client 实现密封/发现/解封）。
 * 控制器不持密钥——密封与解封全在传输面（策略/密钥分离，密钥只在 cloud-identity 域）。 */
export interface XmsgTransport {
  myDev(): string;
  myTenant(): string | null;
  /** 密封发送（false=桥未连接；目标离线由桥回 ROUTE_MISS，补发腿承接）。 */
  send(dev: string, inner: XmsgInner, theirPubkey: string): boolean;
  /** 密封回执给来帧方（公钥=来帧 spk 缓存）。 */
  ack(dev: string, theirPubkey: string, inner: XackInner): boolean;
  /** 目标公钥发现（disc→RELAYS，含 devId 自洽校验）；null=未发现。 */
  discover(dev: string): Promise<string | null>;
}

const DEV_RE = /^rl-[0-9a-f]{4,64}$/;

export interface XmsgController {
  COMMAND_XMSG(cmd: any, by: string): CommandAckPayload;
  /** 传输面注入（index.ts 云桥装配完成后调；未注入=无云桥，send 口报错）。 */
  attachTransport(t: XmsgTransport): void;
  /** 云桥 rl- 来帧入口（cloud-client 解封后调；inner=xmsg 明文体 / xack 回执 / null=解封失败。
   * 返回 false=未启用/非 xmsg 帧，调用方回落原路径。 */
  receive(from: string, inner: XmsgInner | XackInner | null, wire: unknown): boolean;
  /** 桥（重）连后补发泵触发（cloud-client open 钩子调）。 */
  flushOutbox(): void;
  /** ext-input 队列条目真注入成功（bridge flushQueue 钩子调，QueuedInput.xmsg_id 携带）。 */
  injected(msgId: string): void;
  /** 首联确认卡决议副作用（applyConfirmEffects case "device-trust" 调）。 */
  onTrustDecision(dev: string, approved: boolean, by: string): void;
  /** 面板/CLI 的对端清单（op=peers 数据源）。 */
  knownPeers(): { dev: string; confirmed: boolean; seen: boolean }[];
}

export function createXmsgCommands(mgr: any): XmsgController {
  // 字段初始化器时序：SessionManager 的 this.cfg 在构造体内才赋值——本工厂随 mixin
  // 字段初始化执行，账本/互信表全部惰性开（首次真用时 dataDir 已在）
  let stores: XmsgStores | null = null;
  const S = (): XmsgStores => {
    if (!stores) stores = openXmsgStores(mgr.cfg.dataDir);
    return stores;
  };
  const sendGate = new XmsgRateGate();
  const recvGate = new XmsgRateGate();
  let transport: XmsgTransport | null = null;
  let pumpTimer: NodeJS.Timeout | null = null;
  const trust = () => trustStore(mgr.cfg.dataDir);

  // ---------- 审计/通知（§4.4 域内-审计：收发双向全入 chain-audit，设备级归因） ----------

  const audit = (action: string, detail: string): void => {
    try { mgr.xmsgAudit(action, detail); } catch { /* 尽力而为，不阻断主路径 */ }
  };
  const notifySender = (msgId: string, state: string, detail?: string): void => {
    try {
      mgr.upsertNotification("system", `xmsg-${msgId}`, undefined, {
        title: `跨机消息${state === "rejected" ? "被拒" : "失败"}`,
        body: `${msgId} → ${detail ?? state}`,
        severity: "info",
        group: "attention",
        actionable: false,
        domain: "cloud",
        returnPath: "/",
      });
    } catch { /* 尽力而为 */ }
  };

  // ---------- 回执单点 ----------

  const replyAck = (from: string, spk: string, msgId: string, state: string, note?: string): void => {
    if (!transport || !spk) return;
    try {
      transport.ack(from, spk, { t: "xack", msg_id: msgId, state, ...(note ? { note } : {}) });
    } catch { /* 尽力而为 */ }
    audit("xmsg-ack", `to=${from.slice(0, 11)} msg=${msgId.slice(0, 10)} state=${state}${note ? ` note=${note}` : ""}`);
  };

  // ---------- 投递（§4.3：落 ext-input-queue→既有注入链；来源标注不可剥离） ----------

  const dutyTarget = (): string | null => {
    try { return (mgr.dutyTargetId?.() as string | null) ?? null; } catch { return null; }
  };

  /** 已信消息投递（幂等由 seen 承接；每条必达一个回执）。 */
  const deliver = (inner: XmsgInner, from: string, spk: string): void => {
    const v = validateXmsgInner(inner);
    if (!v.ok) {
      // 悬置过期等放行时失效：回执+审计，不入注入链
      replyAck(from, spk, inner.msg_id, `rejected:${v.reason}`);
      S().seen.record(inner.msg_id, `rejected:${v.reason}`, undefined, { from, spk });
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=${v.reason}（放行时失效）`);
      return;
    }
    const target = inner.target.session ?? dutyTarget();
    if (!target) {
      replyAck(from, spk, inner.msg_id, "rejected:no-duty-target", "对端无值班位（无活跃 PM/值守会话）");
      S().seen.record(inner.msg_id, "rejected:no-duty-target", undefined, { from, spk });
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=no-duty-target`);
      return;
    }
    const text = annotateBody(inner);
    const ext = (() => { try { return mgr.getExternal?.(target); } catch { return undefined; } })();
    if (ext) {
      // 外部会话：既有 ext-input 队列链 + xmsg_id 随队列条目（flushQueue 注入成功回执 injected）
      let r: { ok: boolean; error?: string };
      try {
        r = mgr.bridge.extInput(target, text, undefined, undefined, { xmsg_id: inner.msg_id });
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok) {
        const reason = (r.error ?? "inject").slice(0, 80);
        replyAck(from, spk, inner.msg_id, `failed:${reason}`);
        S().seen.record(inner.msg_id, `failed:${reason}`, undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} failed=${reason}`);
        return;
      }
      S().seen.record(inner.msg_id, "queued", undefined, { from, spk });
      // queued 回执不在入队瞬间发——空闲会话 flushQueue 毫秒级完成，等 injected（或 800ms
      // 兜底窗后仍 queued=真排队，回 queued）：避免发送方先见 queued 又立即 injected 的抖动
      const msgId = inner.msg_id;
      setTimeout(() => {
        const hit = S().seen.hit(msgId);
        if (hit && hit.state === "queued") replyAck(from, spk, msgId, "queued", "已入本机注入队列，等待目标会话回合");
      }, 800).unref?.();
      audit("xmsg-recv", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} target=${target.slice(0, 8)} ext 队列已入`);
      return;
    }
    // 托管会话：既有 COMMAND_MESSAGE 注入链（by 归因 xmsg-<dev>）
    let ack: CommandAckPayload;
    try {
      ack = mgr.handleCommand(
        { command_id: `xmsg-${inner.msg_id}-${randomUUID().slice(0, 6)}`, type: "COMMAND_MESSAGE", payload: { session_id: target, text } },
        `xmsg-${from.slice(0, 11)}`,
      );
    } catch (e) {
      ack = { command_id: "?", ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (ack.ok) {
      S().seen.record(inner.msg_id, "injected", undefined, { from, spk });
      replyAck(from, spk, inner.msg_id, "injected");
      audit("xmsg-inject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} target=${target.slice(0, 8)}（managed 直发）`);
    } else {
      const reason = (ack.error ?? "message").slice(0, 80);
      // 会话不存在属寻址问题=拒；其余投递尝试失败
      const state = reason.includes("会话不存在") ? "rejected:no-session" : `failed:${reason}`;
      S().seen.record(inner.msg_id, state, undefined, { from, spk });
      replyAck(from, spk, inner.msg_id, state);
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} ${state}`);
    }
  };

  // ---------- 首联（§4.4 域内-首次确认：新设备首条弹卡一次，确认后持久） ----------

  const firstContact = (inner: XmsgInner, from: string, spk: string): void => {
    const up = upsertFirstSeen(trust(), from, spk, inner.tenant, inner.msg_id);
    if (up === "unavailable") {
      replyAck(from, spk, inner.msg_id, "rejected:trust-unavailable", "本机互信表不可用（fail-closed）");
      S().seen.record(inner.msg_id, "rejected:trust-unavailable", undefined, { from, spk });
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=trust-unavailable`);
      return;
    }
    if (up === "mismatch") {
      replyAck(from, spk, inner.msg_id, "rejected:pubkey-mismatch", "设备公钥与互信表钉扎不符（疑似冒名/换钥）");
      S().seen.record(inner.msg_id, "rejected:pubkey-mismatch", undefined, { from, spk });
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=pubkey-mismatch（钉扎）`);
      return;
    }
    // 首见才出卡（pending 行已在=卡在悬/已决，不重复出——「弹卡一次」的锚）
    if (up === "created") {
      const pending = listPendingConfirms().some((c: any) => c.kind === "device-trust" && c.payload?.dev === from);
      if (!pending) {
        addConfirm({
          kind: "device-trust",
          title: `跨机首联：${from}`,
          reason: `新设备首条跨机消息（租户 ${inner.tenant ?? "未登录"}，正文「${inner.body.replace(/\s+/g, " ").slice(0, 40)}」）——确认后该设备后续消息免卡直投`,
          payload: { dev: from, pubkey: spk, tenant: inner.tenant, first_msg_id: inner.msg_id },
        });
        audit("xmsg-first-contact", `from=${from.slice(0, 11)} tenant=${inner.tenant ?? "null"} 首联卡已出（消息悬置）`);
      }
    }
    const item: XmsgHeldItem = { msg_id: inner.msg_id, inner, ts: Date.now() };
    if (!S().held.hold(from, item)) {
      replyAck(from, spk, inner.msg_id, "rejected:held-overflow", "悬置消息超上限，先确认首联卡");
      S().seen.record(inner.msg_id, "rejected:held-overflow", undefined, { from, spk });
      audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=held-overflow`);
      return;
    }
    S().seen.record(inner.msg_id, "held", undefined, { from, spk });
    replyAck(from, spk, inner.msg_id, "queued", "首联确认卡待决——消息已悬置，确认后自动投递");
  };

  // ---------- 发送泵（§4.8 串行+限速 2 条每对每秒；幂等补发由对端 seen 承接） ----------

  const pump = async (): Promise<void> => {
    if (!transport) return;
    let deferred = false;
    for (const e of S().outbox.due()) {
      if (!sendGate.allow(e.dev)) {
        deferred = true;
        continue;
      }
      let pk = S().peers.get(e.dev);
      if (!pk) {
        try { pk = await transport.discover(e.dev); } catch { pk = null; }
        if (pk) S().peers.put(e.dev, pk);
      }
      if (!pk) {
        deferred = true; // 未发现（离线/异租户被桥过滤）：留 pending 等下轮（ttl 过期由 due() 收口）
        continue;
      }
      const inner: XmsgInner = {
        t: "xmsg", v: 1, tenant: e.tenant,
        source: { dev: transport.myDev() },
        target: e.session ? { session: e.session } : {},
        msg_id: e.msg_id, ts: e.ts, ttl: XMSG_TTL_DEFAULT_MS, ack_req: true, body: e.body,
      };
      const sent = transport.send(e.dev, inner, pk);
      S().outbox.mark(e.msg_id, sent ? "sent" : "pending");
      if (!sent) deferred = true;
      audit("xmsg-send", `to=${e.dev.slice(0, 11)} msg=${e.msg_id.slice(0, 10)} ${sent ? "sent" : "bridge-down（待补发）"} try=${e.tries + (sent ? 1 : 0)}`);
    }
    if (deferred && !pumpTimer) {
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        void pump();
      }, 600);
      pumpTimer.unref?.();
    }
  };

  const flushOutbox = (): void => {
    if (!xmsgEnabled() || !transport) return;
    void pump();
  };

  // 周期补发腿（open 钩子即时触发之外，5s 兜底扫未决——断线补发零重由对端 seen 幂等承接）
  const retryTimer = setInterval(() => {
    if (!xmsgEnabled() || !transport) return;
    void pump();
  }, 5_000);
  retryTimer.unref?.();

  // ---------- 命令面（§4.2 三口汇流：ccops/org/会话卡按钮 → COMMAND_XMSG） ----------

  const doSend = (cid: string, p: any, by: string): CommandAckPayload => {
    if (!transport) return { command_id: cid, ok: false, error: "云桥未启用（CCR_CLOUD_URL），无跨机通道" };
    const dev = typeof p.dev === "string" ? p.dev.trim() : "";
    if (!DEV_RE.test(dev)) return { command_id: cid, ok: false, error: `目标设备号不合法（rl- 开头）: ${dev || "空"}` };
    const text = typeof p.text === "string" ? p.text : "";
    if (!text.trim()) return { command_id: cid, ok: false, error: "text 必填" };
    if (text.length > XMSG_BODY_MAX) return { command_id: cid, ok: false, error: `正文超限（≤32KB，实测 ${text.length}）` };
    const session = typeof p.session === "string" && p.session ? p.session : undefined;
    const sourceSession = typeof p.source_session === "string" && p.source_session ? p.source_session : undefined;
    const msgId = `xm-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    S().outbox.append({
      msg_id: msgId, dev, session, body: text, tenant: transport.myTenant(), ts: Date.now(),
      ...(sourceSession ? { detail: `source=${sourceSession.slice(0, 8)}` } : {}),
    });
    audit("xmsg-send", `to=${dev.slice(0, 11)} msg=${msgId.slice(0, 10)} by=${by.slice(0, 24)} ${session ? `target=${session.slice(0, 8)}` : "target=值班位"} 入队`);
    void pump();
    return { command_id: cid, ok: true, data: { msg_id: msgId, state: "queued" } };
  };

  const controller: XmsgController = {
    attachTransport(t: XmsgTransport): void {
      transport = t;
    },

    COMMAND_XMSG(cmd: any, by: string): CommandAckPayload {
      if (!xmsgEnabled()) return { command_id: cmd.command_id, ok: false, error: "xmsg 未启用（CCR_XMSG=1 开启）" };
      const p = cmd.payload ?? {};
      const op = p.op ?? "send";
      if (op === "send") return doSend(cmd.command_id, p, by);
      if (op === "status") {
        const e = S().outbox.get(typeof p.msg_id === "string" ? p.msg_id : "");
        if (!e) return { command_id: cmd.command_id, ok: false, error: `无此消息: ${String(p.msg_id ?? "")}` };
        return { command_id: cmd.command_id, ok: true, data: { msg_id: e.msg_id, state: e.state, detail: e.detail, tries: e.tries, dev: e.dev } };
      }
      if (op === "peers") {
        return { command_id: cmd.command_id, ok: true, data: { peers: controller.knownPeers(), self: transport?.myDev() ?? null } };
      }
      return { command_id: cmd.command_id, ok: false, error: `未知 op: ${String(op)}` };
    },

    knownPeers() {
      const out: { dev: string; confirmed: boolean; seen: boolean }[] = [];
      try {
        for (const r of listDeviceTrust(trust())) {
          if (r.revoked_at !== null) continue;
          out.push({ dev: r.dev, confirmed: r.confirmed_at !== null, seen: !!S().peers.get(r.dev) });
        }
      } catch { /* 尽力而为 */ }
      return out;
    },

    receive(from: string, inner: XmsgInner | XackInner | null, wire: unknown): boolean {
      if (!xmsgEnabled() || !from.startsWith("rl-")) return false;
      const w = wire as { t?: unknown; spk?: unknown; msg_id?: unknown };
      if (w.t === "xack") {
        // 回执：outbox 终态回填 + 发送方通知（§4.4「xack rejected 发送方可见」）
        if (!inner || inner.t !== "xack") return true;
        S().peers.put(from, String(w.spk ?? ""));
        const e = S().outbox.get(inner.msg_id);
        if (!e) return true; // 非本机 outbox 消息的回执（重放/手工帧）：仅审计
        const state: XmsgOutboxState = inner.state === "injected" ? "injected" : inner.state === "queued" ? "sent" : inner.state.startsWith("rejected") ? "rejected" : "failed";
        S().outbox.mark(inner.msg_id, state, inner.state + (inner.note ? `（${inner.note}）` : ""));
        audit("xmsg-ack", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} state=${inner.state}（发送方可见）`);
        if (state === "rejected" || state === "failed") notifySender(inner.msg_id, state, inner.state + (inner.note ? ` ${inner.note}` : ""));
        return true;
      }
      if (w.t !== "xmsg") return false;
      if (!isXmsgWire(wire)) {
        // 明文 xmsg 即丢（§3.2 纪律）：来方在互信表内（有钉扎公钥）→ 回 rejected:plaintext
        // （发送方可见）；未知来方不回执（防反射放大）。两种都审计。
        const row = getDeviceTrust(trust(), from);
        audit("xmsg-reject", `from=${from.slice(0, 11)} reason=plaintext（明文 xmsg 即丢${row ? "，已知设备回执" : "，未知设备静默"}）`);
        const mid = typeof w.msg_id === "string" ? w.msg_id : "";
        if (row) replyAck(from, row.pubkey, mid, "rejected:plaintext", "xmsg 必须密封（明文即丢）");
        return true;
      }
      const spk = String(w.spk);
      // spk 自洽（防冒名：dev 必须是 spk 派生值，与 pair_req 同款）
      if (!spkMatchesDev(spk, from)) {
        audit("xmsg-reject", `from=${from.slice(0, 11)} reason=spk-mismatch（dev 与公钥派生值不符）`);
        return true; // 身份不可信：不回执（防反射放大）
      }
      S().peers.put(from, spk);
      if (!inner || inner.t !== "xmsg") {
        // 解封失败=对端换钥/伪造密文：按未配对处理，不回执
        audit("xmsg-reject", `from=${from.slice(0, 11)} reason=unseal-failed（密文解不开——对端换钥或伪造）`);
        return true;
      }
      const v = validateXmsgInner(inner);
      if (!v.ok) {
        const mid = typeof inner.msg_id === "string" ? inner.msg_id : "unknown";
        replyAck(from, spk, mid, `rejected:${v.reason}`);
        if (mid !== "unknown") S().seen.record(mid, `rejected:${v.reason}`, undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${mid.slice(0, 10)} reason=${v.reason}`);
        return true;
      }
      // 24h 同窗幂等：窗口内重复 msg_id 回缓存态，零重投（断线补发零重的接收侧锚）。
      // 内部态→线态翻译：seen 的 "held"（首联悬置中）非合法线态——回 queued+悬置说明
      //（补发腿在首联未决期间反复重发，发送方稳定看到 queued 而非未知态落 failed）
      const hit = S().seen.hit(inner.msg_id);
      if (hit) {
        const wireState = hit.state === "held" ? "queued" : hit.state;
        const wireNote = hit.state === "held" ? "首联确认卡待决——消息已悬置" : hit.note;
        replyAck(from, spk, inner.msg_id, wireState, wireNote);
        audit("xmsg-recv", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} 幂等重发（回缓存态 ${hit.state}，零重投）`);
        return true;
      }
      // 接收侧限速（§4.8 每对每秒 2 条）
      if (!recvGate.allow(from)) {
        replyAck(from, spk, inner.msg_id, "rejected:rate-limit", "超出每对每秒 2 条限速");
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=rate-limit`);
        return true;
      }
      // 租户硬边界（§4.4）：本机已登录租户且来方租户不符 → 拒；本机 null=迁移窗（与桥矩阵一致）
      const mine = transport?.myTenant() ?? null;
      if (mine !== null && inner.tenant !== mine) {
        replyAck(from, spk, inner.msg_id, "rejected:tenant", "租户不符");
        S().seen.record(inner.msg_id, "rejected:tenant", undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=tenant（mine≠theirs）`);
        return true;
      }
      // 信任裁决（device_trust 四态）
      const verdict = trustVerdict(trust(), from, spk);
      if (verdict.state === "unavailable") {
        replyAck(from, spk, inner.msg_id, "rejected:trust-unavailable", "本机互信表不可用（fail-closed）");
        S().seen.record(inner.msg_id, "rejected:trust-unavailable", undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=trust-unavailable`);
        return true;
      }
      if (verdict.state === "mismatch") {
        replyAck(from, spk, inner.msg_id, "rejected:pubkey-mismatch", "设备公钥与互信表钉扎不符（疑似冒名/换钥）");
        S().seen.record(inner.msg_id, "rejected:pubkey-mismatch", undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=pubkey-mismatch（钉扎）`);
        return true;
      }
      if (verdict.state === "revoked") {
        replyAck(from, spk, inner.msg_id, "rejected:revoked", "设备已被否决/吊销");
        S().seen.record(inner.msg_id, "rejected:revoked", undefined, { from, spk });
        audit("xmsg-reject", `from=${from.slice(0, 11)} msg=${inner.msg_id.slice(0, 10)} reason=revoked`);
        return true;
      }
      if (verdict.state === "pending") {
        // 卡已在悬：消息悬置，不重复出卡
        const item: XmsgHeldItem = { msg_id: inner.msg_id, inner, ts: Date.now() };
        if (S().held.hold(from, item)) {
          S().seen.record(inner.msg_id, "held", undefined, { from, spk });
          replyAck(from, spk, inner.msg_id, "queued", "首联确认卡待决——消息已悬置");
        } else {
          S().seen.record(inner.msg_id, "rejected:held-overflow", undefined, { from, spk });
          replyAck(from, spk, inner.msg_id, "rejected:held-overflow", "悬置消息超上限，先确认首联卡");
        }
        return true;
      }
      if (verdict.state === "none") {
        firstContact(inner, from, spk);
        return true;
      }
      // confirmed：直投既有注入链
      deliver(inner, from, spk);
      return true;
    },

    flushOutbox,

    injected(msgId: string): void {
      // ext-input 真注入成功（bridge flushQueue 钩子）：seen 升级 + 回执 injected。
      // seen 缺席（重启丢账等边缘）→ 无法回执也无需——发送方按 ttl 收口
      const hit = S().seen.hit(msgId);
      if (!hit || hit.state === "injected" || !hit.from || !hit.spk) return;
      S().seen.record(msgId, "injected");
      replyAck(hit.from, hit.spk, msgId, "injected");
      audit("xmsg-inject", `msg=${msgId.slice(0, 10)} 注入完成（flushQueue 实敲进 CLI）`);
    },

    onTrustDecision(dev: string, approved: boolean, by: string): void {
      const items = S().held.drain(dev);
      const spk = S().peers.get(dev) ?? "";
      if (approved) {
        const r = confirmDevice(trust(), dev, by);
        if (!r.ok) {
          audit("xmsg-first-contact", `dev=${dev.slice(0, 11)} 确认失败: ${r.error}（悬置消息保留待处置）`);
          for (const it of items) S().held.hold(dev, it); // 回灌悬置
          return;
        }
        audit("xmsg-first-contact", `dev=${dev.slice(0, 11)} 已确认（by=${by.slice(0, 24)}），放行悬置 ${items.length} 条`);
        for (const it of items) {
          const hit = S().seen.hit(it.msg_id);
          if (hit && hit.state !== "held") continue; // 期间已被处置（罕见竞态）
          deliver(it.inner, dev, spk);
        }
      } else {
        revokeDevice(trust(), dev, "首联确认卡被否决");
        for (const it of items) {
          S().seen.record(it.msg_id, "rejected:first-contact", undefined, { from: dev, spk });
          replyAck(dev, spk, it.msg_id, "rejected:first-contact", "首联确认被否决");
        }
        audit("xmsg-first-contact", `dev=${dev.slice(0, 11)} 已否决，弃置悬置 ${items.length} 条`);
      }
    },
  };
  return controller;
}
