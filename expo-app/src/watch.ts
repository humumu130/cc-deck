import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { store, type Snapshot } from "./store";
import type { SessionState } from "./protocol";

// 手表网关：把会话快照节流转发给已配对手表（PATH_SESSIONS），
// 手表命令翻译成 relay 命令发回 store（PATH_CMD）。契约见 wear-app protocol/Protocol.kt。

const PATH_SESSIONS = "/ccr/sessions";
// #373 /ccr/cfg：下发手表连接配置——活动源走云时发 wan 透传地址，走 LAN 发直连地址
const PATH_CFG = "/ccr/cfg";
let lastCfg = "";
const PATH_CMD = "/ccr/cmd";
const THROTTLE_MS = 5000;   // 常规更新（action_summary 等）最短下发间隔
const KEEPALIVE_MS = 30000; // 兜底重发：手表晚于手机启动时也能在 30s 内拿到快照

interface WearNative {
  start(): Promise<boolean>;
  getNodes(): Promise<string[]>;
  send(path: string, text: string): Promise<number>;
  addListener(event: string, cb: (ev: { path?: string; text?: string }) => void): void;
}

const mod = Platform.OS === "android" ? requireOptionalNativeModule<WearNative>("Wear") : null;

// 手表可见会话（#294 批4 + 审查修复）：聚合模式下手表保持单源口径——只发活动源的
// 会话；src 字段无条件剥离（手表协议无此字段，聚合→单源切回后懒盖章残留也不外泄，
// 快照与单源模式零差异）；非活动源的会话变动同样不触发紧急下发（指纹与转发共用本口径）
function watchSessions(snap: Snapshot): SessionState[] {
  const sid = snap.activeSourceId;
  const list = !snap.aggregate || !sid ? snap.sessions : snap.sessions.filter((s) => s.src === sid);
  return list.map(({ src: _src, ...rest }) => rest);
}

// 状态指纹：任一会话 status/waiting 出现或消失、会话增删 → 视为紧急，立即下发
function fingerprint(list: SessionState[]): string {
  return list
    .map((s: SessionState) => `${s.session_id}:${s.status}:${s.waiting_request ? 1 : 0}`)
    .join("|");
}

export function startWatchGateway(): void {
  if (!mod || started) return;
  started = true;

  mod.addListener("onMessage", (ev: { path?: string; text?: string }) => {
    if (ev.path !== PATH_CMD || !ev.text) return;
    handleWatchCommand(ev.text);
  });
  void mod.start().catch(() => undefined);

  let lastSentAt = 0;
  let lastFingerprint: string | null = null; // null = 首帧必发（此前误写字面 NUL 字节，git 判了二进制）
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const snap = store.getSnapshot();
    const list = watchSessions(snap);
    lastSentAt = Date.now();
    lastFingerprint = fingerprint(list);
    try {
      void mod!.send(PATH_SESSIONS, JSON.stringify(list)).catch(() => undefined);
    } catch {}
    // #373 连接配置跟随活动源（变化才发）：wan 透传 / LAN 直连
    try {
      const sid = snap.activeSourceId;
      const info = sid ? store.sourceInfoOf(sid) : null;
      let cfg: string = "";
      if (info?.channel === "cloud" && info.cloudUrl && info.relayDev) {
        const base = info.cloudUrl.replace(/\/cloud.*$/, "");
        const t = encodeURIComponent(info.cloudToken ?? "");
        cfg = JSON.stringify({ mode: "RELAY", url: `${base}/wan?token=${t}&dev=wt-app1&to=${info.relayDev}`, wan: true });
      } else if (info?.wsUrl && info.channel === "lan") {
        cfg = JSON.stringify({ mode: "RELAY", url: `${info.wsUrl}${info.wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(info.token)}` });
      }
      if (cfg && cfg !== lastCfg) {
        lastCfg = cfg;
        void mod!.send(PATH_CFG, cfg).catch(() => undefined);
      }
    } catch {}
  };

  store.subscribe(() => {
    const snap = store.getSnapshot();
    const urgent = fingerprint(watchSessions(snap)) !== lastFingerprint;
    const elapsed = Date.now() - lastSentAt;
    if (urgent || elapsed >= THROTTLE_MS) {
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, THROTTLE_MS - elapsed);
  });

  setInterval(flush, KEEPALIVE_MS);
}

// 手表命令 → relay 命令。手表帧的 session_id 在顶层、无 request_id，
// request_id 由手机侧从当前 waiting_request 补齐；COMMAND_ALLOW 对应 relay 的 CONTINUE。
function handleWatchCommand(text: string): void {
  let cmd: { type?: string; session_id?: string; payload?: { text?: string; request_id?: string; answers?: string[] } };
  try {
    cmd = JSON.parse(text);
  } catch {
    return;
  }
  const sid = cmd.session_id;
  if (!sid || !cmd.type) return;
  const sess = store.getSnapshot().sessions.find((x) => x.session_id === sid);
  const requestId = sess?.waiting_request?.request_id;
  switch (cmd.type) {
    case "COMMAND_ALLOW":
      if (requestId) store.send("COMMAND_CONTINUE", { session_id: sid, request_id: requestId });
      break;
    case "COMMAND_REJECT":
      if (requestId) store.send("COMMAND_REJECT", { session_id: sid, request_id: requestId });
      break;
    case "COMMAND_STOP":
      store.send("COMMAND_STOP", { session_id: sid });
      break;
    case "COMMAND_MESSAGE":
      if (cmd.payload?.text) store.send("COMMAND_MESSAGE", { session_id: sid, text: cmd.payload.text });
      break;
    case "COMMAND_ANSWER": {
      const answers = Array.isArray(cmd.payload?.answers) ? cmd.payload!.answers!.filter((a) => typeof a === "string" && a.trim()) : [];
      const rid = typeof cmd.payload?.request_id === "string" && cmd.payload.request_id ? cmd.payload.request_id : requestId;
      if (rid && answers.length) store.send("COMMAND_ANSWER", { session_id: sid, request_id: rid, answers });
      break;
    }
  }
}

let started = false;
