import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { artifactsDir } from "./artifacts.js";
import {
  appendDispatch, clearOrgAnchor, ensureOrgClaudeMd, ensureOrgCli, ensureOrgDir, ORG_LEADER_BOOTSTRAP_PROMPT,
  ORG_LEADER_TITLE, orgDir, readDispatchLog, readOrgAnchor, writeOrgAnchor,
} from "./org.js";
import type { DispatchTier } from "./org.js";
// #26 M2 项目组底座（纯 fs，无环）：分诊引擎（立项/状态迁移/派单/板/确认单副作用）
// 全部经 orgAction 单漏斗进出，广播统一 emitOrgState/emitBoard
import {
  addConfirm, addMember, buildArchiveChecklist, canTransition, createGroup, decideConfirm,
  findGroup, findGroupByAnchor, findStaleGroups, listConfirms, listGroups, listGroupsByStatus,
  listPendingConfirms, loadBoard, markHoldSuggested, maxActiveGroups,
  moveBoardEntry, moveEntryByDispatch,
  removeBoardEntry, setGroupStatus, setGroupTier, setLightConfirmTrusted, upsertBoardEntry,
  ensureProjectClaudeMd,
  type OrgConfirm, type ProjectGroupStatus, type ProjectTier, type BoardEntryStatus,
} from "./projects.js";
// #26 M3 路由表（纯 fs，无环）：派单收口自动记账 + 熟手查表（§5 工作路由）
import { rateRouting, recordRoutingResult, routingFor, tagRouting } from "./routing.js";
import { devId } from "./e2e.js";
import type { EventBus } from "./event-bus.js";
import { AgentSession } from "./agent-adapter.js";
import type { RelayConfig } from "./config.js";
import type { ReplayedSession } from "./history.js";
import { deriveTitle } from "./history.js";
import { generateTitle } from "./title-gen.js";
import { cronTasksKey, readCronTasks } from "./cron.js";
import { readTaskStoreTodos } from "./task-store.js";
import { killTree, snapshotTree, treeCpuMs } from "./proc-tree.js";
import { saveUploadFiles, type UploadBlob } from "./uploads.js";
import { normKey, taskDoneLabel, truncate } from "./summarizer.js";
import type { AgentLike } from "./agent-adapter.js";

// 上下文窗口上限：口径与证据见 context-limit.ts（#72，session-manager/history 共用）
import { contextLimitOf } from "./context-limit.js";
import { AllowRuleStore } from "./allow-rules.js";

// 2026-09-19 输出物口径（用户三轮澄清拍板，替代 #51 扩展名白名单）：只收「明确
// 交付」的东西，且交付物原地不动、看板只做登记——
// ① 原地登记（主力）：项目内交付物（docs/ 报告等）写在本该在的地方，agent 交付
//    完成后 POST /api/deliver 登记原路径（registerDeliverable，tools 记「登记」）；
// ② 产物目录：写 ~/.cc-deck/artifacts/ 即声明交付（任意格式，含二进制），自动
//    收录——全局一次性产物/ui-review 页面等既有用途；
// 启发式扩展名判断（前端项目改一堆 html/md 全是噪音）彻底废除。
import { addHiddenTodoKey, hiddenTodoKeys } from "./todo-hidden.js";
import type {
  AgentCallbacks,
} from "./agent-adapter.js";
import type {
  ArtifactItem,
  Command,
  CommandAckPayload,
  FileChangeStats,
  LogEntry,
  ManagedPermissionMode,
  PendingInput,
  PeerMeta,
  SessionState,
  SubagentInfo,
  TodoItem,
  TokenUsage,
  WaitingPayload,
  ImportPushEntry,
} from "./types.js";

function isManagedMode(m: unknown): m is ManagedPermissionMode {
  // bypassPermissions 必须在内：① CLI init 回报 skip 会话时据此镜像记录 state（否则
  // 挂起恢复 `state.permission_mode ?? "default"` 把 skip 会话掉回 default，每条命令
  // 重新送审）② COMMAND_PERM 切换接受 skip 档——客户端切换器已含四档，缺此则一切走
  // default/acceptEdits 就再也切不回 skip（用户实踩：skip 启动 → 点权限按钮 → 永久降级）
  return m === "default" || m === "acceptEdits" || m === "plan" || m === "bypassPermissions";
}

// 设备类型派生：meta 自报身份优先（CC Deck App / 移动 platform → phone，watch → watch），
// 前缀派生兜底（ph-手机 wb-网页 wt-手表）——修正云桥配对手机被一律标"网页"的失真
function peerKind(dev: string, meta?: PeerMeta): "phone" | "web" | "watch" | "other" {
  const plat = (meta?.platform ?? "").toLowerCase();
  const app = (meta?.app ?? "").toLowerCase();
  if (app.includes("cc deck") || app.includes("ccdeck")) return "phone";
  if (/wear|watch/.test(plat)) return "watch";
  if (/android|ios/.test(plat)) return "phone";
  if (dev.startsWith("ph-")) return "phone";
  if (dev.startsWith("wt-")) return "watch";
  return "web";
}

// 外部会话可携带的 CLI 权限模式全集：托管会话不许 bypass（门控语义），但用户自开
// 终端会话可以是任意启动模式（bypass 常见）——恢复时需原样镜像，不复用 isManagedMode
const EXTERNAL_PERM_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "manual"]);

// COMMAND_IMPORT_PUSH 条目校验（relay 不解释语义，只卡形状与尺寸——条目含令牌，
// 长度上限压到防滥用档；cloud 子对象是出码端 pair 所需的全套身份，字段齐才放行）
function sanitizeImportPushEntry(raw: unknown): ImportPushEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind === "cloud" ? "cloud" : e.kind === "lan" ? "lan" : null;
  if (!kind) return null;
  const wsUrl = typeof e.wsUrl === "string" ? e.wsUrl : "";
  if (!/^wss?:\/\/.{3,200}$/.test(wsUrl)) return null;
  const token = typeof e.token === "string" ? e.token.slice(0, 200) : "";
  if (kind === "lan" && !token) return null;
  let cloud: ImportPushEntry["cloud"];
  if (kind === "cloud") {
    const c = (e.cloud && typeof e.cloud === "object" ? e.cloud : null) as Record<string, unknown> | null;
    if (!c) return null;
    const url = typeof c.url === "string" ? c.url : "";
    const bt = typeof c.token === "string" ? c.token : "";
    const rd = typeof c.rd === "string" ? c.rd : "";
    const rk = typeof c.rk === "string" ? c.rk : "";
    if (!/^(wss?|https?):\/\//.test(url) || !bt || !rd.startsWith("rl-") || rk.length < 40) return null;
    cloud = {
      url: url.slice(0, 200),
      token: bt.slice(0, 200),
      rd: rd.slice(0, 40),
      rk: rk.slice(0, 100),
      paired: true,
      ...(typeof c.code === "string" && /^\d{6,8}$/.test(c.code) ? { code: c.code } : {}),
    };
  }
  return { kind, wsUrl, ...(token ? { token } : {}), ...(cloud ? { cloud } : {}) };
}

// #293 新增会话工作目录三级回落：手机指定目录 → 默认目录（CCR_CWD/sticky）→ 用户主目录。
// 目录校验必须 try/catch：目录不存在/不可访问时 statSync 直接抛 ENOENT，旧实现裸调
// 把 errno 原文抛给手机端（Mac 源启动目录失效时"新增会话"必失败且提示不可读）。
// 2026-09-18 修正（M0）：指定目录"非空但无效"（手机残留的 Windows 路径 /C: 等）此前
// 直接跳默认落 homedir——sticky 默认目录永远没机会兜，云端会话全落家目录（三连
// "卡住"根因）。改为：指定无效时先试默认目录，默认可用就落它（附说明），都没有才 homedir。
// 未配置或校验失败一律回落 homedir（跨平台）并返回人话说明；完全无可用目录时
// cwd 返回空串，由调用方把说明当错误上屏（含建议值）。
// #208（2026-09-25 用户需求）autoMkdir 开关：创建会话时指定目录不存在 → mkdir -p
// 建出来（新项目还没 init 就想开会话的诉求）；建失败（权限/路径中间是文件）不硬抛，
// 落回本回落链并点名原因。开关由客户端创建表单随命令带上，默认关＝完全旧行为。

// ~ 前缀展开（#208 顺手）：手机端 placeholder 就是 ~/dev/myproject——shell 习惯的
// ~ 在 node resolve 下只是字面目录名（autoMkdir 会真在 relay 进程 cwd 下建出 "~/…"
// 目录），展开成 homedir 再解析。仅认 "~" 与 "~/" 两种前缀，其余原样
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveCreateCwd(
  rawCwd: string,
  defaultCwd: string,
  autoMkdir = false,
): { cwd: string; fallbackNote: string } {
  const isUsableDir = (p: string): boolean => {
    if (!p) return false;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false; // 不存在/无权访问/非目录：一律视为不可用
    }
  };
  const tryMkdir = (abs: string): boolean => {
    try {
      mkdirSync(abs, { recursive: true });
      return isUsableDir(abs);
    } catch {
      return false; // EACCES/EROFS/路径中间是文件（ENOTDIR）等：交给回落链
    }
  };

  const wanted = expandHome((rawCwd || "").trim());
  const def = expandHome((defaultCwd || "").trim());
  let mkdirFailed = false; // 开着且指定目录建不出来：回落说明里点名「自动创建失败」
  if (wanted) {
    const abs = resolve(wanted);
    if (isUsableDir(abs)) return { cwd: abs, fallbackNote: "" };
    if (autoMkdir) {
      if (tryMkdir(abs)) {
        return { cwd: abs, fallbackNote: `工作目录 ${abs} 原不存在，已按「自动创建」开关创建` };
      }
      mkdirFailed = true;
    }
  }
  // 指定无效或未指定：默认目录（CCR_CWD / sticky last-cwd）可用则兜住
  if (def) {
    const abs = resolve(def);
    if (isUsableDir(abs)) {
      const note = wanted
        ? mkdirFailed
          ? `指定的工作目录 ${resolve(wanted)} 不存在，「自动创建」失败（路径中间可能是文件或无写权限），本次已回落默认目录 ${abs}`
          : `指定的工作目录 ${resolve(wanted)} 不是有效目录（不存在或无法访问），本次已回落默认目录 ${abs}`
        : "";
      return { cwd: abs, fallbackNote: note };
    }
  }

  const home = homedir();
  // 默认目录两种失效形态分开说（#293 sticky-cwd 场景）：配置了但无效要点名路径，
  // 用户才知道去修哪里（回落 note 只说"未配置"会误导——明明设过 CCR_CWD）
  const defDesc = def
    ? `默认目录（CCR_CWD/上次有效目录）${resolve(def)} 无效（不存在或无法访问）`
    : "默认目录未配置（CCR_CWD）";
  const wantedDesc = wanted
    ? mkdirFailed
      ? `指定的工作目录 ${resolve(wanted)} 不存在，「自动创建」失败（路径中间可能是文件或无写权限），${defDesc}`
      : `指定的工作目录 ${resolve(wanted)} 不是有效目录（不存在或无法访问），${defDesc}`
    : `未指定工作目录，且${defDesc}`;
  const suggest =
    '如需固定工作目录，请设置 CCR_CWD 环境变量指向实际项目目录（如 Windows "D:\\projects\\myapp"、macOS/Linux "~/projects/myapp"）后重启 relay';
  if (isUsableDir(home)) {
    return {
      cwd: home,
      fallbackNote: `${wantedDesc}，本次已回落用户主目录 ${home}。${suggest}`,
    };
  }
  return {
    cwd: "",
    fallbackNote: `${wantedDesc}，用户主目录 ${home} 也无法访问，无法创建会话。请在手机端填写有效的工作目录。${suggest}`,
  };
}

const PERM_MODE_ZH: Record<ManagedPermissionMode, string> = {
  default: "标准（每次确认）",
  acceptEdits: "自动接受编辑",
  plan: "规划（只读）",
  bypassPermissions: "跳过权限确认",
};

// 图片消息清洗：最多 4 张、单张 8MB base64，剔除非法项
function sanitizeImages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 8 * 1024 * 1024);
  return list.length > 0 ? list.slice(0, 4) : undefined;
}

// #62 文件附件清洗：最多 2 个、单个 28MB base64（≈20MB 原文件，2026-09-19 用户反馈
// 4.5MB 太小后放宽）。超限项剔除而非整单拒收——手机端选文件时已有前置大小提示，
// 这里兜底防裸协议灌大包（28MB×2=56MB 仍在 ws 默认 100MB 单帧内）
function sanitizeFiles(raw: unknown): UploadBlob[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: UploadBlob[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const name = typeof (x as Record<string, unknown>).name === "string" ? (x as Record<string, unknown>).name : "";
    const b64 = (x as Record<string, unknown>).b64;
    if (typeof b64 !== "string" || b64.length === 0 || b64.length > 28 * 1024 * 1024) continue;
    list.push({ name: String(name), b64 });
  }
  return list.length > 0 ? list.slice(0, 2) : undefined;
}

// relay 自拉的一次性 SDK 子会话记录（标题生成等），持久化到 <dataDir>/child-sessions.json；
// 孤儿扫描（bridge.adoptOrphans）必须跳过这些 CLI session_id，否则被误收养成垃圾外部会话
const CHILD_SESSIONS_CAP = 200;

function readChildSessions(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "child-sessions.json"), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function appendChildSession(dataDir: string, sid: string): void {
  const list = readChildSessions(dataDir);
  if (list.includes(sid)) return;
  list.push(sid);
  try {
    writeFileSync(join(dataDir, "child-sessions.json"), JSON.stringify(list.slice(-CHILD_SESSIONS_CAP)));
  } catch {}
}

// 手机端删除过的外部会话 id：孤儿扫描的墓碑。没有它，transcript 还新鲜（30 分钟内）
// 的已删会话会在下一轮扫描被重新收养，删除永远不生效
function readDeletedExts(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "deleted-ext.json"), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function appendDeletedExt(dataDir: string, id: string): void {
  const list = readDeletedExts(dataDir);
  if (list.includes(id)) return;
  list.push(id);
  try {
    writeFileSync(join(dataDir, "deleted-ext.json"), JSON.stringify(list.slice(-300)));
  } catch {}
}

// 意图声明制登记清单（2026-09-19）：项目内交付物原路径不搬动，只在看板记录。
// 登记动作不在 transcript 里，重启回放重建不出来——必须落盘（同 title-overrides
// 模式），ensureExternal/adopt/setArtifacts 三处回放挂回
const DELIVERABLES_CAP = 300;

interface DeliverableEntry { sid: string; path: string; ts: number }

function readDeliverables(dataDir: string): DeliverableEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "deliverables.json"), "utf-8")) as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (x): x is DeliverableEntry =>
            !!x && typeof x === "object" &&
            typeof (x as DeliverableEntry).sid === "string" &&
            typeof (x as DeliverableEntry).path === "string" &&
            typeof (x as DeliverableEntry).ts === "number",
        )
      : [];
  } catch {
    return [];
  }
}

function appendDeliverable(dataDir: string, e: DeliverableEntry): void {
  const list = readDeliverables(dataDir).filter((x) => !(x.sid === e.sid && x.path === e.path));
  list.push(e);
  try {
    writeFileSync(join(dataDir, "deliverables.json"), JSON.stringify(list.slice(-DELIVERABLES_CAP)));
  } catch {}
}

// 手动命名的跨重启持久化（2026-09-16）：外部会话重启后经 ensureExternal 从 transcript
// 重新推导标题，内存里的 rename 全丢——"改好名字过一会变回去"根因。sid -> title 落盘，
// ensureExternal 建卡时回放并打 title_locked（后续智能标题/桥接升级路径都尊重该锁）
function readTitleOverrides(dataDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "title-overrides.json"), "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 40);
    }
    return out;
  } catch {
    return {};
  }
}

// #49 置顶会话清单：写穿 data/pinned-sessions.json（relay session_id 数组）。
// 置顶 = 跨重启保留：重启后 applyPinned 把清单内托管会话登记为休眠（saved，
// 可见不可操作），用户点卡片发 COMMAND_RESUME_SESSION 才用 transcript resume 拉起
const PINNED_SESSIONS_CAP = 50;

function pinnedSessionsPath(dataDir: string): string {
  return join(dataDir, "pinned-sessions.json");
}

function readPinnedSessions(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(pinnedSessionsPath(dataDir), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedSessions(dataDir: string, ids: string[]): void {
  try {
    writeFileSync(pinnedSessionsPath(dataDir), JSON.stringify(ids.slice(-PINNED_SESSIONS_CAP)));
  } catch {} // 写穿失败静默降级：置顶只影响重启后的休眠登记，运行期状态不受影响
}

interface ManagedSession {
  agent: AgentLike | null;      // null = Relay 重启遗留的历史会话，不可操作
  state: SessionState;
  logs: LogEntry[];             // 供 SNAPSHOT 下发的时间线
  lastUpdateEmit: number;
  // #7 看门狗锚点：最近一次流进展（onLog/onStatusChange/onUsage 等任意回调）时刻；
  // sendMessage 不推进锚点——流死了发再多消息也只是灌进死队列（中午案例的教训）
  lastProgressAt: number;
  lastProgressKind: string;
  // 已 sendMessage 但流未回显 user_message 的消息：僵死恢复时重放（回显即出队，
  // 已被 CLI 处理过的消息在 transcript 里，重放会重复）
  unacked: { text: string; images?: string[]; ts: number }[];
  wd: WatchdogState;
  // #109 流代际：resumeAgent/reviveSaved 换流前递增。回调闭包按创建时代际比对，
  // 不匹配即忽略——旧流的任何后续事件（接管补刀的收尾回调 / 网络回魂）不再写
  // 状态/时间线/用量，双流并发写同一会话在此根治
  streamGen: number;
  // #189 resume 互斥：上次 resumeAgent/reviveSaved 发起时刻（新流 onInit 清除）。
  // 窗口内（resumePendingWindowMs）到达的消息/auto-revive 不再换流——新 agent 的
  // childPid 尚未就位，此时换流补刀必然落空（双进程根源），消息改走 sendMessage
  // 排队等新流就绪。undefined = 无进行中的 resume
  resumePending?: number;
}

interface WatchdogState {
  phase: "idle" | "sampling" | "recovering";
  recoveries: number[]; // 自愈时间戳（1h 滑窗，≥2 次后放弃自愈转人工）
  gaveUp: boolean; // #109 已放弃自愈：touch() 见流回调即翻回 WORKING（放弃态误判自愈）
}

const UPDATE_THROTTLE_MS = 2000;   // 同状态下的 SESSION_UPDATED 节流
const HEARTBEAT_INTERVAL_MS = 5000;
const CRON_POLL_INTERVAL_MS = 30_000; // 定时任务文件轮询（无官方文件监听事件，读文件足够便宜）
const MAX_SESSIONS = 20;

// #79 输出物远程拉取限额：单文件 ≤20MB；明文分块 512KB（对齐 #408 快照预算——
// 密文 ~700KB < CF Workers ws 1MiB 单帧硬限，云通道实测口径）
const ARTIFACT_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const ARTIFACT_CHUNK_BYTES = 512 * 1024;

// #79 预览分级用 MIME（扩展名推导，未命中给 application/octet-stream——客户端
// 走下载+系统打开兜底）
const ARTIFACT_MIME: Record<string, string> = {
  txt: "text/plain", log: "text/plain", md: "text/markdown",
  html: "text/html", htm: "text/html", json: "application/json", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip", apk: "application/vnd.android.package-archive", dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable", msi: "application/x-msdownload",
};

export function mimeOf(p: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  return (m && ARTIFACT_MIME[m[1].toLowerCase()]) || "application/octet-stream";
}

// ===== #7 SDK 会话流中断看门狗参数（env 读取放函数里逐次求值：测试可动态改） =====
// 两轮 CPU 采样间整树累计增量低于此值（毫秒 CPU 时间）= 空闲。30s 窗口里 500ms ≈ 1.7%
// 平均占用——给 ps 精度与偶发唤醒留噪声余量，长构建/长思考远高于此
const WATCHDOG_CPU_IDLE_DELTA_MS = 500;
function watchdogStallMs(): number {
  const v = Number(process.env.CCR_WATCHDOG_STALL_MS);
  return Number.isFinite(v) && v >= 5_000 ? v : 600_000;
}
// 快速通道：最后一条进展事件是 tool_result（工具已完成，CLI 本该立刻接话）却静默
// 超过该窗——中午 bb2c7681 案例的精确指纹，不必等满 10 分钟
function watchdogFastMs(): number {
  const v = Number(process.env.CCR_WATCHDOG_FAST_MS);
  return Number.isFinite(v) && v >= 2_000 ? v : 180_000;
}
function watchdogSampleMs(): number {
  const v = Number(process.env.CCR_WATCHDOG_SAMPLE_MS);
  return Number.isFinite(v) && v >= 50 ? v : 30_000;
}
// #189 resume 互斥窗：resumeAgent/reviveSaved 发起（spawn）→ 新流 onInit 到达之间的
// 并发窗口。实测双拉案例：11:10:32 relay 重启 auto-revive 拉起 A1，36s 后用户消息触
// 发接管 resume——A1 的 childPid 由异步 spawn 回调填充尚未就位，第二次补刀落空 →
// 双进程并存、旧进程输出无人采集。窗口内到达的 resume 请求不换流：消息走 sendMessage
// 排队（AsyncQueue 即 SDK prompt 流，按序消费）。45s 覆盖 CLI 冷启动（reviveSaved 的
// init 超时 30s 再放宽），超窗仍无 init 视为本次 resume 失败，放行下一次接管补刀
function resumePendingWindowMs(): number {
  const v = Number(process.env.CCR_RESUME_PENDING_MS);
  return Number.isFinite(v) && v >= 5_000 ? v : 45_000;
}
function watchdogDisabled(): boolean {
  return process.env.CCR_WATCHDOG_DISABLE === "1";
}

// #408 SNAPSHOT 大帧根治（2026-09-09 事故）：客户端 last_seq 落到事件缓冲窗外走
// 全量 SNAPSHOT，此前 LAN 快照把全部时间线日志塞单帧（随历史线性膨胀，实测 3 会话
// 0.63MiB）、云通道瘦身后逐条密文流式（数千帧洪峰触发 CF 桥限流踢线 → 重连 →
// auto-resume 再补 → 自喂养断连死循环；CF Workers ws 另有 1MiB 单帧硬限）。
// 修法：LAN 与云共用同一预算装配——每会话只带最近 perSessionCap 条，且全帧日志
// JSON 总量 ≤ budgetBytes。512KB 明文 → seal 后 base64 ≈ 4/3 膨胀 ~700KB，连同
// sessions/信封余量充足（<900KB）；条数与字节双帽保证历史再大单帧也确定性有界。
const SNAPSHOT_LOGS_BUDGET_BYTES = 512 * 1024;
const SNAPSHOT_LOGS_PER_SESSION = 50;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  // 幂等去重存首次回执（0.4.4 起）：旧实现重复固定回 ok:true——失败后的同 id 重试
  //（ACK 丢失重发等）会拿到假成功；缓存真实结果重放，语义对全部命令成立
  private processedCommands = new Map<string, CommandAckPayload>();
  private titleRequested = new Set<string>();   // 已请求过自动命名的会话
  // relay 自拉的一次性 SDK 子会话（标题生成）的 CLI session_id：
  // 无 hook 但 transcript 活跃，孤儿扫描必须排除，否则被误收养成垃圾外部会话
  private childSdkIds: Set<string>;
  private deletedExtIds: Set<string>;
  private titleOverrides: Record<string, string>;

  // #26 矩阵式 M1：组织 Leader 常驻态。leaderId = 当前 Leader 的 relay 会话 id
  //（isLeaderSession 的内存匹配源——COMMAND_MESSAGE/onTurnEnd 高频路径零盘 IO）；
  // ensureLeader 维护，onInit 不重置（resume 换流只会话对象换、relay id 不变）。
  // leaderOpenDispatch = 进行中派单 id FIFO（M2 泛化为 openDispatches：按会话键一
  // FIFO——Leader=咨询档同机制复用，worker=派单承接；回合串行，消息数=回合数。
  // 值带收口所需 tier/gid/anchor：收口行写回真实档位，gid 联动任务板搬卡）
  private openDispatches = new Map<string, { id: string; tier: DispatchTier; gid?: string; anchor?: string }[]>();
  private leaderId: string | null = null;
  private leaderEnsured = false;
  // #26 M3 挂起自动化扫描节拍（boot + 每小时；startStaleScan 起，CCR_ORG_STALE_DAYS=0 不起）
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  /** #388 供 ws-server 读默认模型（快照 payload.models 聚合用） */
  readonly cfg: RelayConfig;

  /** #212 允许并记住：规则存储单例（Bridge / AgentSession / HTTP API 三方共用同一份） */
  readonly allowRules: AllowRuleStore;

  // #49 测试缝：托管 AgentSession 工厂。生产恒为 null（直接 new AgentSession，
  // 行为与从前逐字节一致）；test-bridge/test-cloud 注入假 agent 验证置顶/按需恢复
  // 与休眠登记路径，免拉真 CLI 子进程
  private agentFactory: ((cwd: string, model: string, cb: AgentCallbacks, initialPrompt: string | undefined, opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[]; rules?: AllowRuleStore }) => AgentLike) | null = null;

  setAgentFactory(
    fn: ((cwd: string, model: string, cb: AgentCallbacks, initialPrompt: string | undefined, opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[]; rules?: AllowRuleStore }) => AgentLike) | null,
  ): void {
    this.agentFactory = fn;
  }

  private newAgent(
    cwd: string,
    model: string,
    cb: AgentCallbacks,
    initialPrompt: string | undefined,
    opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[] },
  ): AgentLike {
    const withRules = { ...opts, rules: this.allowRules };
    return this.agentFactory
      ? this.agentFactory(cwd, model, cb, initialPrompt, withRules)
      : new AgentSession(cwd, model, cb, initialPrompt, withRules);
  }

  constructor(
    private bus: EventBus,
    cfg: RelayConfig,
  ) {
    this.cfg = cfg;
    this.allowRules = new AllowRuleStore(cfg.dataDir);
    // #212 规则集任何 mutation（落规则/删除/会话清理）后瞬态广播最新全量——
    // 在线端设置页「记住的规则」实时收敛；离线端重连 SNAPSHOT.allow_rules 兜底
    this.allowRules.onChange = () =>
      this.bus.emitTransient("ALLOW_RULES_UPDATED", { rules: this.allowRules.list() });
    this.childSdkIds = new Set(readChildSessions(cfg.dataDir));
    this.deletedExtIds = new Set(readDeletedExts(cfg.dataDir));
    this.titleOverrides = readTitleOverrides(cfg.dataDir);
    const t = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    t.unref();
    const c = setInterval(() => {
      this.pollCronTasks();
      this.pollTaskStore();
    }, CRON_POLL_INTERVAL_MS);
    c.unref();
  }

  // 该 CLI session_id 是否归 relay 自己管（托管会话的 relay_session_id / 一次性子会话）
  ownsCliSession(cliSid: string): boolean {
    if (this.childSdkIds.has(cliSid)) return true;
    for (const s of this.sessions.values()) if (s.state.relay_session_id === cliSid) return true;
    return false;
  }

  isDeletedExt(id: string): boolean {
    return this.deletedExtIds.has(id);
  }

  snapshot(): SessionState[] {
    return [...this.sessions.values()].map((s) => this.cloneState(s));
  }

  // 自动命名：一次轻量模型调用把首条 prompt 变成短标题（托管/外部会话通用）
  // CC 自带的 session name 在本环境基本不生成，这里兜底；已有 CC 名时外部会话由 bridge 跳过
  requestSmartTitle(sessionId: string, task: string): void {
    if (process.env.CCR_NO_TITLE_GEN === "1") return;
    if (this.titleRequested.has(sessionId)) return;
    this.titleRequested.add(sessionId);
    // 子会话 cwd 指到数据目录下的 .tmp-titlegen：转录不落用户项目区（.tmp- 前缀段
    // 被 bridge 孤儿扫描/事件双护栏排除，#283）
    const titleCwd = join(this.cfg.dataDir, ".tmp-titlegen");
    try { mkdirSync(titleCwd, { recursive: true }); } catch {}
    void generateTitle(task, this.cfg.model, (sid) => {
      // 子会话 id 一到手就登记（不等 result：超时丢 sid 会让孤儿扫描误收养它）
      this.childSdkIds.add(sid);
      appendChildSession(this.cfg.dataDir, sid);
    }, titleCwd).then(({ title: t }) => {
      if (!t) return;
      const s = this.sessions.get(sessionId);
      if (!s || s.state.title === t || s.state.title_locked) return;
      s.state.title = t;
      s.state.updated_at = Date.now();
      this.bus.emit(sessionId, "SESSION_UPDATED", {
        status: s.state.status,
        action_summary: s.state.action_summary,
        stats: { ...s.state.stats },
        title: t,
      });
    });
  }

  snapshotLogs(): Record<string, LogEntry[]> {
    const out: Record<string, LogEntry[]> = {};
    for (const [id, s] of this.sessions) out[id] = s.logs;
    return out;
  }

  // #408 快照日志预算装配（LAN ws-server 与云通道 cloud-client 共用，双端同语义）：
  // 每会话取最近 perSessionCap 条，总量超 budgetBytes 时优先从条目最多的会话逐条
  // 丢最旧（每会话保底 1 条），保证单帧确定性有界。返回被截断会话的省略条数——
  // 客户端时间线接受截断语义（无更早分页拉取通道），标记仅供 UI 提示用。
  // #70（2026-09-19 用户实测）：重连端走快照重建时无差别裁最旧，把 assistant 正文
  // 当工具噪音一起洗掉——「手机上看得到回答、打开 Mac 只剩提问」。修正：截断两级
  // 保护——① 取证窗口放宽到 2×cap，消息类条目（user_message/assistant_text，时间
  // 线主骨）在窗口内全保、名额让给最新非消息条目补足；② 字节预算裁剪时优先丢
  // 非消息条目，只有全员皆消息时才丢消息（每会话保底 1 条不变）。
  buildSnapshotLogs(
    budgetBytes: number = SNAPSHOT_LOGS_BUDGET_BYTES,
    perSessionCap: number = SNAPSHOT_LOGS_PER_SESSION,
  ): { logs: Record<string, LogEntry[]>; logs_truncated: Record<string, number> } {
    // 消息类条目判定（与客户端「消息」视图的 kind 口径一致）
    const isMsg = (e: LogEntry): boolean => e.kind === "user_message" || e.kind === "assistant_text";
    const logs: Record<string, LogEntry[]> = {};
    const logsTruncated: Record<string, number> = {};
    // 每条字节量先算一次，预算裁剪纯算术推进，不反复整体序列化
    const kept: { id: string; entries: { e: LogEntry; b: number }[] }[] = [];
    let total = 0;
    for (const [id, s] of this.sessions) {
      // 取证窗口 2×cap：长会话（内存上限 500 条）里消息稀疏，窗口不放宽的话
      // 保护逻辑根本采不到窗口外的正文
      const wide = s.logs.length > perSessionCap * 2 ? s.logs.slice(s.logs.length - perSessionCap * 2) : s.logs;
      let pick: LogEntry[];
      if (wide.length <= perSessionCap) {
        pick = wide;
      } else {
        const msgIdx = wide.reduce<number[]>((acc, e, i) => (isMsg(e) ? (acc.push(i), acc) : acc), []);
        // 消息全保（极端刷屏超 cap 时仍裁最旧的消息），剩余名额给最新的非消息条目
        const keepMsg = msgIdx.length > perSessionCap ? new Set(msgIdx.slice(msgIdx.length - perSessionCap)) : new Set(msgIdx);
        const restIdx = wide.map((_, i) => i).filter((i) => !keepMsg.has(i));
        const room = Math.max(0, perSessionCap - keepMsg.size);
        const keepRest = new Set(restIdx.slice(Math.max(0, restIdx.length - room)));
        pick = wide.filter((_, i) => keepMsg.has(i) || keepRest.has(i));
      }
      if (pick.length < s.logs.length) logsTruncated[id] = s.logs.length - pick.length;
      const entries = pick.map((e) => ({ e, b: Buffer.byteLength(JSON.stringify(e)) + 1 }));
      if (entries.length) {
        kept.push({ id, entries });
        total += entries.reduce((acc, x) => acc + x.b, 0);
      }
    }
    while (total > budgetBytes) {
      // 条目最多的会话先裁：活跃会话（条目已被 K 帽截到同量级）相对公平；
      // 会话内先丢最旧的非消息条目，全是消息才丢最旧一条消息（保底 1 条不变）
      let big: (typeof kept)[number] | null = null;
      for (const k of kept) if (k.entries.length > 1 && (!big || k.entries.length > big.entries.length)) big = k;
      if (!big) break; // 每会话只剩 1 条：物理下限（MAX_SESSIONS 条单条日志远小于预算）
      let dropAt = big.entries.findIndex((x) => !isMsg(x.e));
      if (dropAt < 0) dropAt = 0;
      const dropped = big.entries.splice(dropAt, 1)[0];
      if (!dropped) break;
      total -= dropped.b;
      logsTruncated[big.id] = (logsTruncated[big.id] ?? 0) + 1;
    }
    for (const k of kept) logs[k.id] = k.entries.map((x) => x.e);
    return { logs, logs_truncated: logsTruncated };
  }

  // Relay 重启后收养历史会话（agent 为空，仅展示不可操作）
  adopt(replayed: Map<string, ReplayedSession>): number {
    // 活跃度优先：按 updated_at 倒序收养，超出上限丢最久未动的
    //（按 started_at 会把"创建早但一直在用"的长期会话挤出去，重启即丢整条时间线）
    const entries = [...replayed.entries()].sort((a, b) => b[1].state.updated_at - a[1].state.updated_at);
    let adopted = 0;
    for (const [id, rs] of entries) {
      if (this.sessions.size >= MAX_SESSIONS) break;
      rs.state.historical = true;
      // #53 手动命名跨重启：改名虽双写（overrides 文件 + 事件帧），但事件流压缩每会话
      // 只留最近 50 条状态帧，忙会话的改名帧会被挤掉——title-overrides.json 才是权威，
      // 收养时套用（managed/external 通吃），否则重启后名字退回首条 prompt 派生名
      const ov = this.titleOverrides[id];
      if (ov) {
        rs.state.title = ov;
        rs.state.title_locked = true;
      }
      this.sessions.set(id, { agent: null, state: rs.state, logs: rs.logs, lastUpdateEmit: 0, lastProgressAt: 0, lastProgressKind: "", unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0 });
      this.applyDeclaredDeliverables(id);
      adopted++;
    }
    return adopted;
  }

  // #75 无人值守连续性（2026-09-19 用户拍板最小闭环：不追求完善机制，先保证
  // 「重启后当前工作会话能被拉起继续干活」）：relay 启动收养历史托管会话后，凡
  // CLI 任务存储（~/.claude/tasks/<cli_sid>/，权威源）里仍有未完成待办
  //（pending/in_progress）的托管会话，自动 resume 并注入续跑指令——不再依赖人
  // 发消息触发恢复。约束：外部会话不适用（用户终端自管，hooks 会重新接入）；
  // 无未完成待办的不拉（已收工/纯闲聊会话拉起来只会空转耗 token）；单次上限
  // 按最近活跃排序取 3 个；失败即止不重试（留 historical 态 = 与旧行为一致，
  // 等人来发消息）。CCR_NO_AUTOREVIVE=1 逃生阀（测试/紧急关闭）。
  autoReviveManaged(limit = 3): number {
    if (process.env.CCR_NO_AUTOREVIVE === "1") return 0;
    const candidates: { s: ManagedSession; updated: number }[] = [];
    for (const s of this.sessions.values()) {
      if (s.state.external || s.agent) continue;
      // #26 M3 审查修正：挂起退休成员不自动拉起——组挂起=编制退休释放（板冻结），
      // 重启后 auto-revive 不得把它拉回去干活。org_parked 是内存态（重启即丢，boot
      // 由 rehydrateParkedMembers 重建），再按 project_gid 组状态兜一层双保险
      if (s.state.org_parked) continue;
      if (s.state.project_gid) {
        const pg = findGroup(s.state.project_gid);
        if (pg && pg.status !== "active") continue;
      }
      // #189 resume 互斥：上一轮 resume 的 agent 还在路上（spawn→onInit 窗口），
      // 不重复拉起（双拉 → childPid 未就位补刀落空 → 双进程）
      if (s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) continue;
      if (!s.state.relay_session_id) continue; // 首回合未完成即断，无 resume 锚点
      const todos = readTaskStoreTodos(s.state.relay_session_id);
      if (!todos || !todos.some((t) => t.status === "pending" || t.status === "in_progress")) continue;
      // 48h 新鲜度：一周前残留的"pending 愿望"不是活工作，拉起来只会空转误导
      if (Date.now() - s.state.updated_at > 48 * 3600_000) continue;
      candidates.push({ s, updated: s.state.updated_at });
    }
    candidates.sort((a, b) => b.updated - a.updated);
    let revived = 0;
    for (const c of candidates) {
      if (revived >= limit) break;
      try {
        this.resumeAgent(c.s, "[relay 自动恢复] relay 重启完成，检测到本会话仍有未完成任务。请直接读取任务清单继续推进工作，无需复述上下文。");
        revived++;
      } catch (e) {
        console.log(`[auto-revive] ${c.s.state.session_id.slice(0, 8)} 恢复失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (revived > 0) console.log(`[auto-revive] 已自动拉起 ${revived} 个有未完成待办的托管会话`);
    return revived;
  }

  // ---------- 外部会话（hooks 桥接）----------

  private bridge: {
    resolvePending: (sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string, rememberScope?: "session" | "global", by?: string) => boolean;
    answerPending: (sessionId: string, requestId: string, answers: string[]) => string | null;
    extInput: (sessionId: string, text: string, images?: string[], files?: UploadBlob[]) => { ok: boolean; error?: string };
    extStop: (sessionId: string) => { ok: boolean; error?: string };
    refreshTodos: (sessionId: string) => { ok: boolean; error?: string };
    hideTodo: (sessionId: string, content: string) => { ok: boolean; error?: string };
  } | null = null;

  setBridge(b: {
    resolvePending: (sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string, rememberScope?: "session" | "global", by?: string) => boolean;
    answerPending: (sessionId: string, requestId: string, answers: string[]) => string | null;
    extInput: (sessionId: string, text: string, images?: string[], files?: UploadBlob[]) => { ok: boolean; error?: string };
    extStop: (sessionId: string) => { ok: boolean; error?: string };
    refreshTodos: (sessionId: string) => { ok: boolean; error?: string };
    hideTodo: (sessionId: string, content: string) => { ok: boolean; error?: string };
  }): void {
    this.bridge = b;
  }

  // 云桥身份（index.ts 在云桥启用时注入；PAIR_START/PEERS 依赖）。meta 为 #42 设备
  // 自报身份元数据（可选，与 CloudIdentity.PeerEntry 对应字段同构）
  private cloud: {
    keypair: { publicKey: string };
    relayDev: string;
    peers: Map<string, { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number; last_seen?: number }>;
    addPeer: (dev: string, entry: { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number }) => void;
    importPeers: (entries: { dev: string; pubkey: string; name?: string; meta?: PeerMeta; paired_at?: number }[]) => number;
  } | null = null;

  setCloud(c: {
    keypair: { publicKey: string };
    relayDev: string;
    peers: Map<string, { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number; last_seen?: number }>;
    addPeer: (dev: string, entry: { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number }) => void;
    importPeers: (entries: { dev: string; pubkey: string; name?: string; meta?: PeerMeta; paired_at?: number }[]) => number;
  }): void {
    this.cloud = c;
  }

  // 配对码签发器（index.ts 注入，与 /api/pair-code 同源）：COMMAND_PAIR_CODE 依赖。
  // opts.ttlMs = 按次长码（≤30min，pairing.ts 夹逼；F4）
  private pairIssuer: ((opts?: { ttlMs?: number }) => { code: string; expires_in: number }) | null = null;

  setPairIssuer(fn: (opts?: { ttlMs?: number }) => { code: string; expires_in: number }): void {
    this.pairIssuer = fn;
  }

  // 议题①踢除执行器（index.ts 注入：identity.removePeer + 各桥 CloudClient.kickPeer
  // 发 pair_nack 停其重连）：COMMAND_PEER_KICK 依赖
  private peerKicker: ((dev: string) => void) | null = null;

  setPeerKicker(fn: (dev: string) => void): void {
    this.peerKicker = fn;
  }

  // #325 扫码登录授权器（index.ts 注入，转发各云桥客户端 grantLogin）
  private loginGranter: ((dev: string, pubkey: string, name: string) => boolean) | null = null;
  // 0.4.4 跨网回传执行器（云层注册）：密封 payload 投给目标 dev，目标离线返回 false
  private importPusher: ((dev: string, pubkey: string, payload: Record<string, unknown>) => boolean) | null = null;

  setLoginGranter(fn: (dev: string, pubkey: string, name: string) => boolean): void {
    this.loginGranter = fn;
  }

  setImportPusher(fn: (dev: string, pubkey: string, payload: Record<string, unknown>) => boolean): void {
    this.importPusher = fn;
  }

  // 不存在则注册外部会话（bridge.ts 调用）；startedAt：真实起点（孤儿收养时取自
  // transcript 首条时间戳，#321——否则收养时刻会冒充会话时长起点，老会话显示 55s）
  ensureExternal(id: string, cwd: string, prompt: string, cliSessionId = "", startedAt = 0): SessionState {
    const existing = this.sessions.get(id);
    if (existing) {
      // Relay 重启后 adopt 为 historical 的外部会话：真实 hook 事件回来了，恢复可操作
      existing.state.historical = false;
      // #53 兜底：手动命名权威在 title-overrides.json（该会话改名帧可能已被压缩挤掉）
      const ov = this.titleOverrides[id];
      if (ov && existing.state.title !== ov) {
        existing.state.title = ov;
        existing.state.title_locked = true;
      }
      if (!existing.state.relay_session_id && cliSessionId) existing.state.relay_session_id = cliSessionId;
      this.applyDeclaredDeliverables(id);
      return existing.state;
    }
    const state: SessionState = {
      session_id: id,
      relay_session_id: cliSessionId,
      cwd: cwd || process.cwd(),
      initial_prompt: prompt,
      title: prompt ? deriveTitle(prompt) : (cwd.split(/[\\/]/).pop() ?? "未命名会话") || "未命名会话",
      model: "",
      status: "WORKING",
      action_summary: prompt ? truncate(prompt, 40) : "接入中",
      started_at: startedAt || Date.now(),
      updated_at: Date.now(),
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      external: true,
      remote_mode: false,
    };
    // 手动命名回放（readTitleOverrides）：重启前的 rename 跨重启保留
    const ov = this.titleOverrides[id];
    if (ov) {
      state.title = ov;
      state.title_locked = true;
    }
    this.sessions.set(id, { agent: null, state, logs: [], lastUpdateEmit: 0, lastProgressAt: 0, lastProgressKind: "", unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0 });
    this.applyDeclaredDeliverables(id);
    this.bus.emit(id, "SESSION_CREATED", {
      cwd: state.cwd,
      initial_prompt: prompt,
      title: state.title,
      model: "",
      external: true,
      started_at: state.started_at,
    });
    return state;
  }

  getExternal(id: string): SessionState | undefined {
    return this.sessions.get(id)?.state;
  }

  setExternalStatus(id: string, status: SessionState["status"], summary: string, turnStartedAt?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const changed = s.state.status !== status;
    s.state.status = status;
    s.state.action_summary = summary;
    if (status === "WORKING" && turnStartedAt) s.state.turn_started_at = turnStartedAt;
    s.state.updated_at = Date.now();
    if (changed || status === "WORKING") {
      this.bus.emit(id, "SESSION_UPDATED", {
        status,
        action_summary: summary,
        stats: { ...s.state.stats },
        ...(s.state.turn_started_at ? { turn_started_at: s.state.turn_started_at } : {}),
        historical: !!s.state.historical,
      });
    }
  }

  // #363 上下文压缩状态：PreCompact 置位（压缩期转录静默，端上据此区分"卡死"与
  // "压缩中"）；8 分钟兜底自动清——清位事件丢失时不永久卡标志
  setExternalCompacting(id: string, on: boolean): void {
    const s = this.sessions.get(id);
    if (!s || s.state.compacting === on) return;
    s.state.compacting = on;
    s.state.updated_at = Date.now();
    if (on) {
      const t = setTimeout(() => {
        if (s.state.compacting) this.setExternalCompacting(id, false);
      }, 480_000);
      t.unref?.();
    }
    // #93：compacting 是部分帧——必须随带 status/action_summary，否则客户端
    //（web-console SESSION_UPDATED 直接采信 payload.status）会把会话状态覆写成
    // undefined，render 里 s.status.toLowerCase() 崩掉整条消息渲染线（UI 冻结：
    // 提问不弹窗、状态停旧值）。其他 setExternal* 均随带，唯独此处漏——对齐
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      compacting: on,
    });
  }

  // pid 对账/解锁等纯状态修复后强制下发：emitUpdated 携带 historical 等字段，
  // 否则客户端要等下次 SNAPSHOT 才摘掉"仅可查看"
  emitExternalSync(id: string): void {
    const s = this.sessions.get(id);
    if (s) this.emitUpdated(s, true);
  }

  // #393 手动通知注入（/api/notify）：把一段文字作为 TASK_DONE 汇报推给指定/最新会话，
  // 悬浮框当即弹出（拖图原理答疑/联调实测用）；同时落 last_task_done 供断线恢复
  notifyDone(sessionId: string, done: string[], remainingCount: number): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const report = { done: done.slice(0, 10), remaining_count: remainingCount, ts: Date.now() };
    s.state.last_task_done = report;
    this.bus.emit(sessionId, "TASK_DONE", {
      done: done.slice(0, 10),
      remaining: [],
      ts: report.ts,
    });
    return true;
  }

  // #393 黄色 [待确认] 悬浮框推送（/api/notify mode=confirm）：往目标会话 todos
  // 追加一条 pending [待确认] 条目——客户端 #300/#306 确认提醒链路天然接住（弹黄框，
  // 用户逐条 ✕ / 全部已读即消，会话任务面板同步可见）
  notifyConfirm(sessionId: string, text: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const todos = [...(s.state.todos ?? []), { content: `[待确认] ${text}`, status: "pending" as const }];
    this.setTodos(sessionId, todos);
    return true;
  }

  // 任务清单更新（TodoWrite；managed 与 external 两条路径共用）。
  // 单一咽喉点：hook 路径 / transcript 轮询 / COMMAND_REFRESH_TODOS 重发全部经此，
  // 隐藏条目（COMMAND_TODO_HIDE 记入 todo-hidden.json）在这里统一过滤。
  // at：事件真实发生时刻——relay 重启后的 transcript 水合（firstRead 重建清单）必须
  // 传转录时间戳，缺省才用当下（#157：水合刷 Date.now() 会把全表最后活跃时间伪造成
  // 重启时刻，闲置置灰判定全失效——公司 relay 晨启批量"当前时间"的根因）
  setTodos(id: string, todos: TodoItem[], at?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const hidden = hiddenTodoKeys(id);
    const list = hidden.size ? todos.filter((t) => !hidden.has(normKey(t.content))) : todos;
    s.state.todos = list;
    s.state.updated_at = at ?? Date.now();
    this.emitUpdated(s, true, at);
  }

  // external 会话子 Agent 工作状态：仅 subagents 实际变化时下发 SESSION_UPDATED
  // （运行中条目的"秒数走动"由客户端本地计时，relay 不逐秒推）。at 语义同 setTodos
  setExternalSubagents(id: string, list: SubagentInfo[], at?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const prev = JSON.stringify(s.state.subagents ?? []);
    const next = JSON.stringify(list);
    if (prev === next) return;
    s.state.subagents = list.length ? list : undefined;
    s.state.updated_at = at ?? Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      subagents: list,
      updated_at: s.state.updated_at,
    });
  }

  // 外部会话标题升级（CC 会话名 / 首个 prompt 摘要）；initialPrompt 只在缺失时补记。
  // #347：title_locked（用户手动命名）在此兜底——bridge 的首个 prompt 升级路径
  //（relay 重启后 initial_prompt 已丢、named 集合清空）会带着派生标题进来，
  // 无条件覆盖会把用户改的名冲掉（"几小时后恢复原名"根因）
  setExternalTitle(id: string, title: string, initialPrompt?: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.state.external) return;
    if (initialPrompt && !s.state.initial_prompt) s.state.initial_prompt = initialPrompt;
    if (s.state.title_locked) return;
    s.state.title = title;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      title,
    });
  }

  // external 会话排队注入消息（已发送、CLI 尚未处理）：随状态下发，
  // 客户端显示在工作指示器下方；UserPromptSubmit 匹配 / Stop 回合结束时晋升为正式 user_message
  setExternalPending(id: string, list: PendingInput[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.pending_inputs = list.length ? list : undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      pending_inputs: list,
    });
  }

  // 外部会话文件改动统计（bridge 从 Edit/Write 结果累计）
  setExternalStats(id: string, stats: FileChangeStats): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.stats = stats;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...stats },
    });
  }

  // #35 输出物单条合并咽喉点（实时路径：external hook 事件 / 托管 SDK 工具结果）。
  // 归一 key = 小写绝对路径（macOS 不敏感盘 / Windows 盘符大小写归一，展示保留原文）；
  // 相对入参以会话 cwd 补全；create 不降级（"本会话产出过该文件"是最有价值的归类）；
  // 捕获时顺手 stat 刷新 size/exists（不做轮询）。silent = 不逐条广播（回放批量
  // 由 setArtifacts 收尾一次 emit）
  mergeArtifact(
    id: string,
    item: { path: string; tool: string; adds: number; dels: number; created: boolean; ts: number },
    silent = false,
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!item.path || item.path === "(未知文件)") return;
    const cwd = s.state.cwd || "";
    let p = item.path;
    if (!isAbsolute(p) && cwd) p = resolve(cwd, p);
    // 意图声明制（见文件头注释）：自动采集只认显式产物目录——写进
    // ~/.cc-deck/artifacts/ 本身就是交付声明，任意格式可收；项目目录里的交付物
    // 不经此处，由 /api/deliver 显式登记（registerDeliverable）
    const adir = resolve(artifactsDir()).toLowerCase();
    if (!p.toLowerCase().startsWith(adir + sep)) return;
    const key = p.toLowerCase();
    const list: ArtifactItem[] = s.state.artifacts ? s.state.artifacts.map((a) => ({ ...a })) : [];
    const idx = list.findIndex((a) => a.path.toLowerCase() === key);
    let size: number | undefined;
    let exists = true;
    try {
      size = statSync(p).size;
    } catch {
      exists = false;
    }
    const origin = cwd ? (p === cwd || p.startsWith(cwd + sep) ? ("cwd" as const) : ("outside" as const)) : undefined;
    if (idx >= 0) {
      const a = list[idx] as ArtifactItem;
      list[idx] = {
        ...a,
        op: a.op === "create" || item.created ? "create" : "edit",
        tools: a.tools.includes(item.tool) ? a.tools : [...a.tools, item.tool],
        adds: a.adds + item.adds,
        dels: a.dels + item.dels,
        last_at: Math.max(a.last_at, item.ts),
        size,
        exists,
        ...(origin ? { origin } : {}),
      };
    } else {
      list.push({
        path: p,
        op: item.created ? "create" : "edit",
        tools: [item.tool],
        adds: item.adds,
        dels: item.dels,
        first_at: item.ts,
        last_at: item.ts,
        size,
        exists,
        ...(origin ? { origin } : {}),
      });
      // #82 落盘：产物目录写入即交付声明（#69），但声明动作不在 transcript；journal
      // 状态帧每会话仅留最近 50 条（见 #53 注释），写产物那帧很快被挤掉——托管（SDK）
      // 会话没有 transcript 全文件重扫兜底，relay 重启后产物表只剩 deliverables.json
      // 挂回项（2026-09-20 晨间夜间报告丢失实锤）。新条目同步进登记清单
      // （appendDeliverable sid+path 幂等，回放重扫/轮转不重复追加），借
      // ensureExternal/adopt/setArtifacts 三处 applyDeclaredDeliverables 跨重启存活；
      // 重启挂回后 tools 降级为「登记」、增删行归零，可见性优先可接受
      appendDeliverable(this.cfg.dataDir, { sid: id, path: p, ts: item.ts });
      // 上限保最新：超 200 条丢最旧 + 标记截断（UI 汇总行提示）
      if (list.length > 200) {
        list.sort((x, y) => y.last_at - x.last_at);
        list.length = 200;
        s.state.artifacts_truncated = true;
      }
    }
    s.state.artifacts = list;
    if (silent) return;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      artifacts: list.map((a) => ({ ...a })),
      ...(s.state.artifacts_truncated ? { artifacts_truncated: true } : {}),
    });
  }

  // 意图声明制 · 原地登记（/api/deliver）：交付物路径原样记录（项目内 docs/ 等
  // 不搬动），stat 补 size/exists；同路径重复登记幂等合并（tools 记「登记」，
  // 产物目录自动收录的条目并入同 key 不重复）。持久化 deliverables.json
  registerDeliverable(sessionId: string, rawPath: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, error: `会话不存在: ${sessionId}` };
    const p = resolve(rawPath.trim());
    appendDeliverable(this.cfg.dataDir, { sid: sessionId, path: p, ts: Date.now() });
    const list: ArtifactItem[] = s.state.artifacts ? s.state.artifacts.map((a) => ({ ...a })) : [];
    const idx = list.findIndex((a) => a.path.toLowerCase() === p.toLowerCase());
    let size: number | undefined;
    let exists = true;
    try {
      size = statSync(p).size;
    } catch {
      exists = false;
    }
    const ts = Date.now();
    if (idx >= 0) {
      const a = list[idx] as ArtifactItem;
      list[idx] = {
        ...a,
        tools: a.tools.includes("登记") ? a.tools : [...a.tools, "登记"],
        last_at: ts,
        size,
        exists,
      };
    } else {
      list.push({ path: p, op: "create", tools: ["登记"], adds: 0, dels: 0, first_at: ts, last_at: ts, size, exists });
      if (list.length > 200) {
        list.sort((x, y) => y.last_at - x.last_at);
        list.length = 200;
        s.state.artifacts_truncated = true;
      }
    }
    s.state.artifacts = list;
    s.state.updated_at = Date.now();
    this.bus.emit(sessionId, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      artifacts: list.map((a) => ({ ...a })),
      ...(s.state.artifacts_truncated ? { artifacts_truncated: true } : {}),
    });
    return { ok: true };
  }

  // cwd→会话归因核心（deliverByCwd 与 #138 验收单回填通知共用）：会话 cwd 与入参
  // cwd 互为前缀都算（agent 会 cd 进子目录交付，也可能反向），命中多个取最近活跃。
  // Bash 环境拿不到 CLAUDE_SESSION_ID，cwd 前缀+新鲜度是可得的最强归因；同仓库并行
  // 会话极端场景可能归到姊妹会话，可接受（看板仍在，只是挂在隔壁卡上）。
  // 空 cwd 会话跳过（原先 "" + sep 会前缀匹配一切绝对路径，属潜在误归因，顺手修复）
  // #203 realpath 归一（2026-09-25）：macOS /tmp 是 /private/tmp 的符号链接——会话
  // 登记逻辑路径（/tmp）与 Bash/hook 上报物理路径（/private/tmp/keyhive）两种形态
  // 并存时前缀匹配失配（secret 会话实锤：deliver-guard 自动登记与手动补登记同死
  // 此处，且 hook 失败静默无人知）。两边 realpath 后再比；路径已消失（历史会话
  // cwd 被删）realpathSync 会 throw，回落 resolve 值。低频调用（deliver/验收单
  // 回填），循环内逐会话归一的代价可忽略
  matchSessionByCwd(cwd: string): string | null {
    const norm = (x: string): string => {
      const r = resolve(x || ".");
      try { return realpathSync(r); } catch { return r; }
    };
    const c = norm(cwd);
    let best: { id: string; updated: number } | null = null;
    for (const s of this.sessions.values()) {
      const rawCwd = s.state.cwd;
      if (!rawCwd) continue;
      const sc = norm(rawCwd);
      const related = c === sc || c.startsWith(sc + sep) || sc.startsWith(c + sep);
      if (!related) continue;
      if (!best || s.state.updated_at > best.updated) best = { id: s.state.session_id, updated: s.state.updated_at };
    }
    return best ? best.id : null;
  }

  // /api/deliver 归因（matchSessionByCwd 之上叠交付物登记）
  deliverByCwd(cwd: string, rawPath: string): { ok: boolean; session_id?: string; error?: string } {
    const sid = this.matchSessionByCwd(cwd);
    if (!sid) return { ok: false, error: "无匹配会话（cwd 对不上任何已知会话）" };
    const r = this.registerDeliverable(sid, rawPath);
    return r.ok ? { ok: true, session_id: sid } : r;
  }

  // 重启回放：把该会话登记过的交付物挂回（登记不在 transcript，靠 deliverables.json）
  private applyDeclaredDeliverables(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entries = readDeliverables(this.cfg.dataDir).filter((e) => e.sid === sessionId);
    if (!entries.length) return;
    const list: ArtifactItem[] = s.state.artifacts ? s.state.artifacts.map((a) => ({ ...a })) : [];
    for (const e of entries) {
      if (list.some((a) => a.path.toLowerCase() === e.path.toLowerCase())) continue;
      let size: number | undefined;
      let exists = true;
      try {
        size = statSync(e.path).size;
      } catch {
        exists = false;
      }
      list.push({ path: e.path, op: "create", tools: ["登记"], adds: 0, dels: 0, first_at: e.ts, last_at: e.ts, size, exists });
    }
    s.state.artifacts = list;
  }

  // #35 输出物整表重建（transcript 回放路径：relay 重启后全文件重扫）。必须整体替换
  // 而非逐条 merge 增量——转录轮转/收缩会再次触发 firstRead 回放，merge 会把
  // adds/dels 双计；items 按转录时间顺序喂入，合并语义由 mergeArtifact(silent) 承担
  setArtifacts(
    id: string,
    items: { path: string; tool: string; adds: number; dels: number; created: boolean; ts: number }[],
    at?: number,
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.artifacts = undefined;
    s.state.artifacts_truncated = false;
    for (const it of items) this.mergeArtifact(id, it, true);
    // 登记制条目不在 transcript 里：整表替换会把原地登记的交付物洗掉，必须从
    // deliverables.json 挂回（转录轮转/收缩重触 firstRead 也不丢登记；items 为
    // 空也走这里——只剩登记条目同样要恢复）
    this.applyDeclaredDeliverables(id);
    if (!s.state.artifacts) return;
    // 局部转写断开 TS 对 776 行 undefined 赋值的窄化（方法调用不重推属性窄化）
    const merged = s.state.artifacts as ArtifactItem[] | undefined;
    // at 语义同 setTodos：firstRead 输出物回放传转录时刻，防重启水合刷"最后活跃"（#157）
    s.state.updated_at = at ?? Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      artifacts: (merged ?? []).map((a) => ({ ...a })),
      ...(s.state.artifacts_truncated ? { artifacts_truncated: true } : {}),
      updated_at: s.state.updated_at,
    });
  }

  // 外部会话 token 用量 / 模型（bridge 从 transcript assistant 条目累计提取）
  // 上下文窗口上限按模型区分（集中维护，随 context_usage 一起下发；换模型只改这里）。
  // at 语义同 setTodos：首读 usage 种子传转录时刻（#157）
  setExternalUsage(id: string, usage: TokenUsage, model?: string, contextUsage?: number, at?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.usage = usage;
    if (model) s.state.model = model;
    if (contextUsage !== undefined) {
      s.state.context_usage = contextUsage;
      s.state.context_limit = contextLimitOf(model ?? s.state.model);
    }
    s.state.updated_at = at ?? Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      usage,
      ...(model ? { model } : {}),
      ...(contextUsage !== undefined ? { context_usage: contextUsage, context_limit: contextLimitOf(model ?? s.state.model) } : {}),
      updated_at: s.state.updated_at,
    });
  }

  setExternalWaiting(id: string, payload: WaitingPayload): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.status = "WAITING";
    s.state.waiting_request = payload;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_WAITING", payload);
  }

  // 外部会话记录 CLI 上报的最新权限模式——恢复会话（claude --resume）时镜像原始启动
  // 参数用：原来带 skip/权限模式的，恢复也带，不回落默认确认门控
  setExternalPermMode(id: string, mode: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.state.external || !EXTERNAL_PERM_MODES.has(mode)) return;
    s.state.permission_mode = mode as ManagedPermissionMode;
  }

  // 删除会话：外部会话写墓碑防历史重放复活（#34 断言的闭环），置顶清单同步摘除（#49）。
  // COMMAND_DELETE 与 SessionEnd 主动关闭收口共用（主动退出 → 客户端卡片同步清除）
  // M1 审查轮：返回 false = 拒删（组织 Leader 卡——锚 org.json 仍指向它，§3.5
  // 逻辑常驻锚是权威；进程内删卡只会让组织失聪：leaderEnsured 已真 → ensureLeader
  // no-op，重启前无入口。解散组织走清锚通道：删锚后重启即不再拉起）
  deleteSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return true;
    if (this.isLeaderSession(id)) return false;
    this.sessions.delete(id);
    this.lastStoreTodos.delete(id);
    this.allowRules.dropSession(id); // #212 会话删除清 session 级记住规则
    if (s.state.external) {
      this.deletedExtIds.add(id);
      appendDeletedExt(this.cfg.dataDir, id);
    }
    if (s.state.pinned) {
      writePinnedSessions(this.cfg.dataDir, readPinnedSessions(this.cfg.dataDir).filter((x) => x !== id));
    }
    this.bus.emit(id, "SESSION_DELETED", { session_id: id });
    return true;
  }

  // #144：at = 完成时刻（默认判定时刻）。静默推断收敛（sweep 扫描）必须传真实
  // 最后活动时刻 idleSince——relay 重启后首轮 sweep 会批量收殓回放出的 WORKING
  // 僵尸（CLI 早已死、停在最后一帧，lastHookAt/lastGrow 内存表为空），若刷
  // Date.now() 会把「几小时前的死亡」洗成「刚刚活跃」，快照下发后全端 30 分钟
  // 不置灰（2026-09-22 用户实测：装 test.18 重启即本机源全亮、远程源正常）。
  // 正常终态上报（Stop hook/用户打断/compact 归档）不传 at，判定时刻即真实时刻
  finishExternal(id: string, reason: string, durationMs: number, at: number = Date.now()): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.status = "DONE";
    s.state.done_reason = reason;
    s.state.duration_ms = durationMs;
    s.state.waiting_request = undefined;
    s.state.updated_at = at;
    this.bus.emit(id, "SESSION_DONE", {
      terminal_reason: reason,
      duration_ms: durationMs,
      stats: { ...s.state.stats },
    });
  }

  // #160 外部会话日志的 live 引用（只读约定）：bridge 的任务编号回填按稳定 id
  // 找原条目取文案/detail，原地重发同 id 条目（不新增行）
  getExternalLogs(id: string): LogEntry[] {
    return this.sessions.get(id)?.logs ?? [];
  }

  pushExternalLog(
    id: string,
    kind: LogEntry["kind"],
    text: string,
    tool?: string,
    meta?: { full?: string; detail?: string; diff?: string[]; id?: string },
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const entry: LogEntry = { ts: Date.now(), kind, text, tool, ...meta };
    // #73 同 id 原地替换（与托管 onLog 同语义）：外部 CLI 转录把同一条消息的流式
    // 增长快照逐行落盘，bridge 按 message.id 识别增长链后复用稳定 id——中间快照
    // 替换既有条目而非新增，时间线不再增量刷屏。替换不占 500 条帽（新条目才计）
    const i = meta?.id ? s.logs.findIndex((e) => e.id === meta.id) : -1;
    if (i >= 0) {
      s.logs[i] = entry;
    } else {
      s.logs.push(entry);
      if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
    }
    this.bus.emit(id, "SESSION_LOG", entry);
  }

  setRemoteMode(id: string, enabled: boolean): void {
    const s = this.sessions.get(id);
    if (!s || !s.state.external) return;
    s.state.remote_mode = enabled;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      remote_mode: enabled,
    });
  }

  setExternalCliPid(id: string, pid: number): void {
    const s = this.sessions.get(id);
    if (!s || s.state.cli_pid === pid) return;
    s.state.cli_pid = pid;
  }

  clearExternalCliPid(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.state.cli_pid = undefined;
  }

  handleCommand(cmd: Command, by: string): CommandAckPayload {
    // 幂等去重：重复 command_id 重放首次回执（防失败后同 id 重试假成功）
    const seen = this.processedCommands.get(cmd.command_id);
    if (seen) {
      // #65 回放带 duplicate 标记：ok/session_id/error 保持首次原样（客户端状态机
      // 零影响），调用方能区分「刚执行」与「幂等重放」——此前原样回放导致 test-ws
      // 「second ack marked」断言在干净 HEAD 即失败
      return { ...seen, duplicate: true };
    }
    const ack = this.execCommand(cmd, by);
    this.processedCommands.set(cmd.command_id, ack);
    if (this.processedCommands.size > 1000) {
      const first = this.processedCommands.keys().next().value;
      if (first !== undefined) this.processedCommands.delete(first);
    }
    return ack;
  }

  private execCommand(cmd: Command, by: string): CommandAckPayload {
    try {
      switch (cmd.type) {
        case "COMMAND_CREATE": {
          // permissionMode: 客户端可选 bypassPermissions（新建时勾选"跳过权限确认"）
          const pm = cmd.payload.permissionMode === "bypassPermissions" ? "bypassPermissions" : undefined;
          // #208 autoMkdir：客户端创建表单「目录不存在时自动创建」开关（默认关＝旧回落行为）
          const session_id = this.create(cmd.payload.cwd, cmd.payload.prompt, pm, cmd.payload.autoMkdir === true);
          return { command_id: cmd.command_id, ok: true, session_id };
        }
        case "COMMAND_MESSAGE": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话请使用 COMMAND_EXT_INPUT" };
          }
          // #62 文件附件：SDK 用户消息只收 image blocks，文件类附件落盘 tmp 后把
          // 「正文 + 路径处理指令」作为正文下发（echo 分离：客户端可见面不暴露临时
          // 路径，同 #54b 口径；unacked 记合成文——重放时盘上文件仍在，指令照常有效）
          const orig = cmd.payload.text;
          let text = orig;
          let echo: string | undefined;
          const files = sanitizeFiles(cmd.payload.files);
          if (files && files.length > 0) {
            const saved = saveUploadFiles(this.cfg.dataDir, cmd.payload.session_id, files);
            if (saved.length > 0) {
              const list = saved.join("、");
              text = text.trim() ? `${text}\n（文件已保存：${list}——请按需读取处理）` : `请处理以下文件：${list}`;
              echo = `${orig.trim()}（+${saved.length} 文件）`.trim();
            } else if (!text.trim()) {
              return { command_id: cmd.command_id, ok: false, error: "文件保存失败（临时目录不可写）" };
            }
          }
          // #26 派单台账（M1 咨询档）：Leader 会话的每条用户消息 = 一次咨询派单。
          // M1「派与跑同刻」直接落 running（dispatched 留 M2 异步派单，schema 已留位）；
          // 放在文件保存失败返回之后 = 只记必达消息，三投递出口（resumePending 排队 /
          // resumeAgent 换流 / 直发 sendMessage）一次全覆盖。上岗引导走 create 的
          // initialPrompt 不经此处，天然不入账（org.ts 注释同口径）。
          if (this.isLeaderSession(cmd.payload.session_id)) {
            const dispatchId = randomUUID();
            this.pushOpenDispatch(cmd.payload.session_id, { id: dispatchId, tier: "咨询" });
            appendDispatch({
              ts: Date.now(), id: dispatchId, tier: "咨询", target: "org-leader",
              status: "running", session_id: cmd.payload.session_id,
            });
          }
          // agent 已死（Relay 重启遗留 / stop 收尾）或已放弃自愈（#109：放弃路径不再
          // 预杀树，僵流可能还挂着）：有 SDK 会话 id 就地 resume 复活（接管时补刀旧树）
          if (!s.agent || s.agent.ended || s.wd.gaveUp) {
            // #189 resume 互斥：上次 resume 的 agent 还在路上（spawn→onInit 窗口），
            // ended 只是流先关了——此刻再接管必然双拉（新 agent childPid 未就位，
            // 补刀落空 → 双进程）。消息走 sendMessage 排队：AsyncQueue 即 SDK prompt
            // 流，新流 init 后按序消费，语义与正常排队一致
            if (s.agent && !s.wd.gaveUp && s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) {
              if (s.state.status === "ERROR" || s.state.status === "DONE") s.state.status = "WORKING";
              s.agent.sendMessage(text, sanitizeImages(cmd.payload.images), echo);
              s.unacked.push({ text, images: sanitizeImages(cmd.payload.images), ts: Date.now() });
              this.emitUpdated(s, true);
              return { command_id: cmd.command_id, ok: true };
            }
            this.resumeAgent(s, text, sanitizeImages(cmd.payload.images), echo);
            return { command_id: cmd.command_id, ok: true };
          }
          if (s.state.status === "ERROR" || s.state.status === "DONE") {
            s.state.status = "WORKING";
          }
          s.agent.sendMessage(text, sanitizeImages(cmd.payload.images), echo);
          // #7 看门狗重放账：入队即记，流回显 user_message 才出队（流死时 CLI 从未
          // 收到，恢复后须重发；不推进 lastProgressAt——灌进死队列不是"进展"）
          s.unacked.push({ text, images: sanitizeImages(cmd.payload.images), ts: Date.now() });
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_MODEL": {
          // #388 模型切换：注入 CLI 原生 /model slash 命令（托管 sendMessage / 外部 EXT_INPUT，
          // CLI 下一回合生效）；state.model 立即更新供端上显示（以 CLI 实际回报为准）
          const sid = String(cmd.payload.session_id ?? "");
          const model = String(cmd.payload.model ?? "").replace(/\[1m\]$/, "").trim();
          if (!model || !/^[\w.\/-]{1,80}$/.test(model)) {
            return { command_id: cmd.command_id, ok: false, error: "无效模型名" };
          }
          const s = this.sessions.get(sid) ?? this.sessions.get(`ext-${sid}`);
          if (!s) return { command_id: cmd.command_id, ok: false, error: "会话不存在" };
          if (s.state.external) {
            if (!this.bridge) return { command_id: cmd.command_id, ok: false, error: "外部会话通道未就绪" };
            const r = this.bridge.extInput(s.state.session_id, `/model ${model}`);
            if (!r.ok) return { command_id: cmd.command_id, ok: false, error: r.error ?? "注入失败" };
          } else if (s.agent && !s.agent.ended) {
            s.agent.sendMessage(`/model ${model}`);
          } else {
            return { command_id: cmd.command_id, ok: false, error: "会话不可操作（已结束）" };
          }
          s.state.model = model;
          s.state.updated_at = Date.now();
          this.pushExternalLog(s.state.session_id, "system", `模型切换: ${model}`);
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PERM": {
          const live = this.requireLive(cmd.payload.session_id);
          if (live.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持权限模式切换" };
          }
          const mode = cmd.payload.mode;
          if (!isManagedMode(mode)) {
            return { command_id: cmd.command_id, ok: false, error: `未知权限模式: ${mode}` };
          }
          void live.agent.setPermissionMode(mode)
            .then(() => {
              live.state.permission_mode = mode;
              this.pushExternalLog(live.state.session_id, "system", `权限模式切换: ${PERM_MODE_ZH[mode]}`);
              this.emitUpdated(live, true);
            })
            .catch((e) => {
              this.pushExternalLog(live.state.session_id, "system", `权限模式切换失败: ${e instanceof Error ? e.message : String(e)}`);
            });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_STOP": {
          const s = this.requireLive(cmd.payload.session_id);
          void s.agent.stop();
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_CONTINUE": {
          const s = this.require(cmd.payload.session_id);
          // #212 remember_scope：allow 的同时落规则（可记忆性以当时下发的
          // WaitingPayload.remember 为准，relay 侧 suggestPattern 二次校验，危险形态不落）
          const scope = cmd.payload.remember_scope;
          if (s.state.external) {
            if (!this.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "allow", undefined, scope, by)) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "allow", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.allow(cmd.payload.request_id, by, scope)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_REJECT": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!this.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "deny", cmd.payload.reason)) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "deny", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.deny(cmd.payload.request_id, cmd.payload.reason, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_ANSWER": {
          const answers = cmd.payload.answers.map((a) => a.trim()).filter(Boolean).slice(0, 4);
          if (!answers.length) {
            return { command_id: cmd.command_id, ok: false, error: "answers 不能为空" };
          }
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            // 外部会话：allow+updatedInput 把答案注入工具入参，CLI 视为已作答不再弹本地选择器
            const ansErr = this.bridge?.answerPending(cmd.payload.session_id, cmd.payload.request_id, answers);
            if (ansErr) {
              return { command_id: cmd.command_id, ok: false, error: ansErr };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "answer", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.answer(cmd.payload.request_id, answers, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_EXT_MODE": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "not an external session" };
          }
          this.setRemoteMode(cmd.payload.session_id, cmd.payload.enabled);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_EXT_INPUT": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_MESSAGE" };
          }
          if (!this.bridge) {
            return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
          }
          const r = this.bridge.extInput(
            cmd.payload.session_id,
            cmd.payload.text,
            sanitizeImages(cmd.payload.images),
            sanitizeFiles(cmd.payload.files),
          );
          return { command_id: cmd.command_id, ok: r.ok, error: r.error };
        }
        case "COMMAND_EXT_STOP": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_STOP" };
          }
          if (!this.bridge) {
            return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
          }
          const r = this.bridge.extStop(cmd.payload.session_id);
          return { command_id: cmd.command_id, ok: r.ok, error: r.error };
        }
        case "COMMAND_REFRESH_TODOS": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!this.bridge) {
              return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
            }
            const r = this.bridge.refreshTodos(cmd.payload.session_id);
            return { command_id: cmd.command_id, ok: r.ok, error: r.error };
          }
          // 托管会话：任务目录是权威源（#206）。force 重读磁盘强制重发可见集，
          // 不删轮询缓存——diff 仍与上轮比较，恰逢完成项照样发 TASK_DONE
          this.pollTaskStore(true);
          if (s.state.todos) this.setTodos(cmd.payload.session_id, s.state.todos.map((t) => ({ ...t })));
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_TODO_HIDE": {
          const s = this.require(cmd.payload.session_id);
          const content = cmd.payload.content.trim();
          if (!content) return { command_id: cmd.command_id, ok: false, error: "content 不能为空" };
          if (s.state.external) {
            if (!this.bridge) {
              return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
            }
            const r = this.bridge.hideTodo(cmd.payload.session_id, content);
            return { command_id: cmd.command_id, ok: r.ok, error: r.error };
          }
          // 托管会话：SDK feed 后续重推也被 setTodos 过滤兜住
          addHiddenTodoKey(cmd.payload.session_id, normKey(content));
          if (s.state.todos) this.setTodos(cmd.payload.session_id, s.state.todos.map((t) => ({ ...t })));
          // 删除闭环：让会话本体同步删掉本地任务条目（显示层过滤≠源头删除）
          s.agent?.sendMessage(
            `[移动端删除任务] 用户删除了任务清单条目：「${truncate(content.trim(), 120)}」。请将该条目从你的本地任务列表同步删除（任务工具置 deleted 或移除），不要重新创建或继续处理它。本条为系统通知，简短确认即可。`,
          );
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_DELETE": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.status === "WORKING" || s.state.status === "WAITING") {
            return { command_id: cmd.command_id, ok: false, error: "会话运行中，不能删除" };
          }
          if (!this.deleteSession(cmd.payload.session_id)) {
            return { command_id: cmd.command_id, ok: false, error: "组织 Leader 卡不可删除（逻辑常驻，锚是权威）；解散组织请清 org.json 锚后重启" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        // #212 删除「允许并记住」规则。删不存在的 id 回 ok:false；成功后的
        // ALLOW_RULES_UPDATED 广播由 allowRules.onChange 统一触发（构造处挂接，
        // 覆盖落规则/删除/会话清理全部 mutation——见 AllowRuleStore.onChange 注释）
        case "COMMAND_ALLOW_RULE_REMOVE": {
          if (!this.allowRules.remove(cmd.payload.id)) {
            return { command_id: cmd.command_id, ok: false, error: "no such rule" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_RENAME": {
          const s = this.require(cmd.payload.session_id);
          const title = cmd.payload.title.trim().slice(0, 40);
          if (!title) return { command_id: cmd.command_id, ok: false, error: "标题不能为空" };
          s.state.title = title;
          s.state.title_locked = true;
          s.state.updated_at = Date.now();
          // 落盘（跨重启回放）：外部会话重启后 ensureExternal 会从 transcript 重推标题，
          // 不落盘改名就静默丢失（"改好名字过一会变回去"）
          this.titleOverrides[s.state.session_id] = title;
          try {
            writeFileSync(join(this.cfg.dataDir, "title-overrides.json"), JSON.stringify(this.titleOverrides));
          } catch {}
          this.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            title,
            title_locked: true,
          });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PAIR_START": {
          // 云桥配对：信任锚 = LAN 信道的 token 鉴权（与现状同威胁模型）
          if (!this.cloud || !this.cfg.cloudUrl) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const { pubkey } = cmd.payload;
          if (typeof pubkey !== "string" || !/^[A-Za-z0-9+/]{43}={0,2}$/.test(pubkey)) {
            return { command_id: cmd.command_id, ok: false, error: "bad pubkey" };
          }
          const dev = devId(pubkey, "ph");
          const name = cmd.payload.name || "手机";
          this.cloud.addPeer(dev, { pubkey, name, paired_at: Date.now() });
          // 议题①：手机扫码配对同样是新设备入册（全权）——广播提醒其余在线设备
          this.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "add" });
          return {
            command_id: cmd.command_id,
            ok: true,
            cloud: {
              url: this.cfg.cloudUrl,
              token: this.cfg.cloudToken,
              relay_dev: this.cloud.relayDev,
              relay_pubkey: this.cloud.keypair.publicKey,
            },
          };
        }
        case "COMMAND_PAIR_CODE": {
          // 信任设备（已配对手机，LAN token / 云 E2E 任一信道）为网页端新设备签发一次性配对码。
          // ttl_ms 可选：按次长码（F4；签发端夹逼 60s~30min，见 pairing.ts）
          if (!this.cloud || !this.pairIssuer) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const ttlRaw = (cmd.payload as { ttl_ms?: unknown }).ttl_ms;
          const opts =
            typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0 ? { ttlMs: ttlRaw } : undefined;
          return { command_id: cmd.command_id, ok: true, pair_code: this.pairIssuer(opts) };
        }
        case "COMMAND_PEERS": {
          // 议题①可信设备清单：kind 优先采信 meta 自报身份（app/platform），前缀派生
          // 降级为兜底——云桥配对的手机此前被一律按 wb- 前缀标成"网页"（前缀语义过时，
          // 2026-09-14 用户实测设备列表标签失真）。云桥未启用时 peers 恒空，返回空清单
          // 而非报错（网页端 UI 直接显示「暂无」。#42 e.meta 随条目下发）
          const peers = this.cloud
            ? [...this.cloud.peers.entries()].map(([dev, e]) => ({
                dev,
                name: e.name || dev.slice(0, 11),
                pubkey: e.pubkey,
                kind: peerKind(dev, e.meta),
                paired_at: e.paired_at,
                last_seen: e.last_seen ?? 0,
                ...(e.meta ? { meta: e.meta } : {}),
              }))
            : [];
          return { command_id: cmd.command_id, ok: true, peers };
        }
        case "COMMAND_PEERS_IMPORT": {
          // 导入配对备份（导出的逆操作）：按 dev 合并入库（已存在跳过），返回导入数。
          // 条目格式与 COMMAND_PEERS 下发一致（dev/pubkey 必填，name/meta/paired_at 可选）
          if (!this.cloud) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const raw = (cmd.payload as { peers?: unknown }).peers;
          if (!Array.isArray(raw)) return { command_id: cmd.command_id, ok: false, error: "peers 必须是数组" };
          const entries: { dev: string; pubkey: string; name?: string; meta?: PeerMeta; paired_at?: number }[] = [];
          for (const item of raw.slice(0, 100)) {
            const it = item as { dev?: unknown; pubkey?: unknown; name?: unknown; meta?: unknown; paired_at?: unknown };
            const dev = typeof it.dev === "string" ? it.dev : "";
            const pubkey = typeof it.pubkey === "string" ? it.pubkey : "";
            if (!/^[a-z]{2}-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pubkey)) continue;
            entries.push({
              dev,
              pubkey,
              ...(typeof it.name === "string" && it.name.trim() ? { name: it.name.trim().slice(0, 32) } : {}),
              ...(it.meta && typeof it.meta === "object" ? { meta: it.meta as import("./types.js").PeerMeta } : {}),
              ...(typeof it.paired_at === "number" ? { paired_at: it.paired_at } : {}),
            });
          }
          const imported = this.cloud.importPeers(entries);
          for (const e of entries) {
            if (this.cloud.peers.has(e.dev)) {
              this.bus.emitTransient("PAIRED_DEVICE", { dev: e.dev, name: this.cloud.peers.get(e.dev)?.name ?? "", action: "add" });
            }
          }
          return { command_id: cmd.command_id, ok: true, imported };
        }
        case "COMMAND_PEER_KICK": {
          // 议题①踢除：幂等（dev 不存在也回 ok）；先广播 kick 让在线设备刷新清单，
          // 再执行移除（peers 写穿落盘 + 各桥发 pair_nack 令其立即停止重连）
          if (!this.cloud || !this.peerKicker) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const dev = String((cmd.payload as { dev?: unknown }).dev ?? "");
          if (!/^[a-z]{2}-[0-9a-f]{6,64}$/.test(dev)) {
            return { command_id: cmd.command_id, ok: false, error: "无效的设备号" };
          }
          const name = this.cloud.peers.get(dev)?.name || dev.slice(0, 11);
          this.peerKicker(dev);
          this.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "kick" });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_CLOUD_INFO": {
          // #25b（2026-09-10 移动网络场景）：本机 relay 的云桥身份自述——控制台据此
          // 给手机发「本机 relay 的云码」（手机在任何网络可连）。LAN token 鉴权内含
          //（能发命令即受信端）。bt 只给首桥（多桥并发码留待需要时再扩）
          if (!this.cloud) {
            return { command_id: cmd.command_id, ok: true, cloudInfo: { cloud: false } };
          }
          return {
            command_id: cmd.command_id,
            ok: true,
            cloudInfo: {
              cloud: true,
              bridge: (this.cfg.cloudUrls[0] ?? "").replace(/\/$/, "").replace(/^http/, "ws"),
              bt: this.cfg.cloudToken,
              rd: this.cloud.relayDev,
              rk: this.cloud.keypair.publicKey,
            },
          };
        }
        case "COMMAND_LOGIN_GRANT": {
          // #325 扫码登录：手机（信任信道）授权网页端出示的会话公钥，relay 配对并回 ack。
          // dev 必须与公钥派生值一致（与 pair_req 路径同款校验，防冒名占位）
          const p = cmd.payload as { session_dev?: string; session_pk?: string; name?: string };
          const dev = String(p.session_dev ?? "");
          const pk = String(p.session_pk ?? "");
          if (!this.cloud || !this.loginGranter) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "会话参数格式无效" };
          }
          this.loginGranter(dev, pk, String(p.name ?? "web").slice(0, 32) || "web");
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_IMPORT_PUSH": {
          // 0.4.4 合并扫码跨网回传：手机把一条连接条目推给出示合并码的网页/exe 端。
          // 校验后交云层密封投递；pusher 返回 false = 目标端离线（码浮层已关/断线）
          const p = cmd.payload as { target_dev?: string; target_pk?: string; entry?: unknown; note?: unknown };
          const dev = String(p.target_dev ?? "");
          const pk = String(p.target_pk ?? "");
          if (!this.cloud || !this.importPusher) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "目标设备参数无效" };
          }
          const entry = sanitizeImportPushEntry(p.entry);
          if (!entry) {
            return { command_id: cmd.command_id, ok: false, error: "回传条目格式无效" };
          }
          if (!this.importPusher(dev, pk, { t: "ccdeck-import-resp", entry, ...(p.note ? { note: String(p.note).slice(0, 80) } : {}) })) {
            return { command_id: cmd.command_id, ok: false, error: "电脑端不在线（二维码可能已关闭）" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PIN_SESSION": {
          // #49 置顶/取消置顶：写穿 pinned-sessions.json。托管会话专用（外部 CLI 会话
          // 生命周期由用户终端自管，重启后 hooks 重新接入，无需休眠恢复）。休眠态
          // （saved）也可 unpin——摘掉 saved 让卡片退回普通历史会话
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持置顶（由 CLI 自身维护）" };
          }
          const pinned = cmd.payload.pinned === true;
          s.state.pinned = pinned || undefined;
          if (!pinned) s.state.saved = undefined;
          s.state.updated_at = Date.now();
          writePinnedSessions(
            this.cfg.dataDir,
            [...readPinnedSessions(this.cfg.dataDir).filter((x) => x !== cmd.payload.session_id), ...(pinned ? [cmd.payload.session_id] : [])],
          );
          // 显式带 pinned/saved 布尔（含 false）：端上据此直接改卡片，不等快照
          this.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            pinned,
            saved: !!s.state.saved,
          });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_RESUME_SESSION": {
          // #49 按需恢复：点击「已保存」休眠卡触发。已在线会话幂等成功（顺手清残留
          // 休眠标记）；失败同步抛错回 ACK，异步失败（流断/超时）走 SESSION_ERROR，
          // saved 保留可重试
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持恢复" };
          }
          if (s.agent && !s.agent.ended) {
            if (s.state.saved) {
              s.state.saved = undefined;
              this.emitUpdated(s, true);
            }
            return { command_id: cmd.command_id, ok: true };
          }
          this.reviveSaved(s);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_ARTIFACT_FETCH": {
          // #79 输出物远程访问（实时 E2E 传输，不落云存储）：授权锚点 = path 归一化
          // 后必须命中该会话 state.artifacts 已登记条目（防任意读/路径穿越——客户端
          // 只能拉它本就看得见的输出物）；≤20MB；成功 ACK 携带 size/mime，数据本体
          // 经瞬态 ARTIFACT_CHUNK 帧按 ref=command_id 回发（LAN/云同路径，云侧自动
          // E2E 密封，桥不落存储）。幂等重放（duplicate ack）不会重发数据——缺帧
          // 重试必须换新 command_id
          const s = this.require(cmd.payload.session_id);
          const key = resolve(String(cmd.payload.path ?? "")).toLowerCase();
          const hit = (s.state.artifacts ?? []).find((a) => a.path.toLowerCase() === key);
          if (!hit) {
            return { command_id: cmd.command_id, ok: false, error: "路径未登记在该会话的输出物清单里，无权拉取" };
          }
          let st;
          try {
            st = statSync(hit.path);
          } catch {
            return { command_id: cmd.command_id, ok: false, error: "文件不存在或不可访问（可能已被移动/删除）" };
          }
          if (!st.isFile()) return { command_id: cmd.command_id, ok: false, error: "不是常规文件" };
          if (st.size > ARTIFACT_FETCH_MAX_BYTES) {
            return { command_id: cmd.command_id, ok: false, error: `文件 ${(st.size / 1048576).toFixed(1)}MB 超过 20MB 上限，请在电脑端查看` };
          }
          const ref = cmd.command_id;
          try {
            const buf = readFileSync(hit.path);
            const total = Math.max(1, Math.ceil(buf.length / ARTIFACT_CHUNK_BYTES));
            for (let seq = 0; seq < total; seq++) {
              this.bus.emitTransient(
                "ARTIFACT_CHUNK",
                {
                  ref,
                  seq,
                  total,
                  b64: buf.subarray(seq * ARTIFACT_CHUNK_BYTES, (seq + 1) * ARTIFACT_CHUNK_BYTES).toString("base64"),
                },
                by,
              );
            }
            this.bus.emitTransient("ARTIFACT_CHUNK", { ref, done: true }, by);
          } catch (e) {
            this.bus.emitTransient("ARTIFACT_CHUNK", { ref, error: e instanceof Error ? e.message : String(e) }, by);
          }
          return { command_id: cmd.command_id, ok: true, artifact: { size: st.size, mime: mimeOf(hit.path) } };
        }
        case "COMMAND_ORG_CONFIRM": {
          // #26 M2 确认单决议（用户点击确认卡）：决议 + 副作用 + 广播统一走 orgAction
          const r = this.orgAction("confirm-decide", { confirm_id: cmd.payload.confirm_id, approve: cmd.payload.approve, by });
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
        }
        case "COMMAND_PROJECT_DETAIL": {
          // #26 M2 项目组详情：{ group, board, receipts }（编制/板/回执流四分节数据源）
          const r = this.orgAction("project-detail", { id: cmd.payload.gid });
          return { command_id: cmd.command_id, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) };
        }
        case "COMMAND_WATCH_GRANT":
          // #316 手表配对授权在 ws-server 层处理（持有待配对连接池）；云信道走到这里
          // 说明命令被路由错了——明确报错而非静默
          return { command_id: cmd.command_id, ok: false, error: "手表配对授权仅限局域网信道" };
      }
    } catch (e) {
      return {
        command_id: cmd.command_id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private create(rawCwd: string, prompt: string, permissionMode?: ManagedPermissionMode, autoMkdir = false, opts?: { skipStickyCwd?: boolean }): string {
    // #293 三级回落：指定/默认目录无效时回落用户主目录（说明进时间线），完全无可用目录才报错；
    // #208 autoMkdir：指定目录不存在时先 mkdir -p 建出来（失败仍走回落链）
    const { cwd, fallbackNote } = resolveCreateCwd(rawCwd, this.cfg.defaultCwd, autoMkdir);
    if (!cwd) throw new Error(fallbackNote);
    // sticky 默认目录（M0，2026-09-18）：解析出的有效项目目录记为下次默认——手机端
    // /C: 类残留指定进来时，回落落在真实项目目录而非家目录；CCR_CWD 显式配置时不越权。
    // 回落到家目录的 cwd 不记（记了等于没记）
    // #26 skipStickyCwd：内部会话（组织 Leader 以 org 目录为 cwd）不污染全局默认——
    // 否则 org 会成为之后所有无指定目录新会话的落点
    if (!process.env.CCR_CWD && !opts?.skipStickyCwd && cwd !== homedir()) {
      this.cfg.defaultCwd = cwd;
      try { writeFileSync(join(this.cfg.dataDir, "last-cwd"), cwd, "utf-8"); } catch {}
    }
    this.evictOldSessions();

    const managed: ManagedSession = {
      agent: null,
      state: {
        session_id: "",
        relay_session_id: "",
        cwd,
        initial_prompt: prompt,
        title: deriveTitle(prompt),
        model: this.cfg.model,
        status: "WORKING",
        action_summary: "启动中",
        started_at: Date.now(),
        turn_started_at: Date.now(),
        updated_at: Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      },
      logs: [],
      lastUpdateEmit: 0,
      lastProgressAt: Date.now(),
      lastProgressKind: "",
      unacked: [],
      wd: { phase: "idle", recoveries: [], gaveUp: false },
      streamGen: 0,
    };

    const agent = this.newAgent(
      cwd,
      this.cfg.model,
      this.agentCallbacks(managed),
      // 空提示词 = parked 形态（#49）：会话建好等输入，不注入空消息
      prompt.trim() ? prompt : undefined,
      permissionMode ? { permissionMode } : undefined,
    );

    managed.agent = agent;
    managed.state.session_id = agent.id;
    this.sessions.set(agent.id, managed);
    this.bus.emit(managed.state.session_id, "SESSION_CREATED", {
      cwd,
      initial_prompt: prompt,
      title: managed.state.title,
      model: this.cfg.model,
    });
    // 目录回落说明进时间线：手机端能看到会话为何落在用户主目录，relay 日志同步留痕
    if (fallbackNote) {
      const entry: LogEntry = { ts: Date.now(), kind: "system", text: fallbackNote };
      managed.logs.push(entry);
      this.bus.emit(managed.state.session_id, "SESSION_LOG", entry);
      console.log(`[create-cwd] ${agent.id.slice(0, 8)} ${fallbackNote}`);
    }
    this.requestSmartTitle(agent.id, prompt);
    return agent.id;
  }

  // AgentSession 回调：create 与 resume 共用（状态机与事件下发完全一致）
  private agentCallbacks(managed: ManagedSession): AgentCallbacks {
    // #109 流身份守卫：闭包捕获创建时代际；resumeAgent/reviveSaved 换流前递增
    // managed.streamGen——旧流再吐任何事件（接管补刀的收尾 / 网络回魂）都过不了
    // 代际比对，各回调整体忽略
    const gen = managed.streamGen;
    const mine = (): boolean => managed.streamGen === gen;
    // #7 看门狗：任何流回调都算"活着"，推进锚点
    const touch = (kind: string): void => {
      if (!mine()) return;
      // #109 放弃态自愈：防风暴放弃后 WAITING 钉死——onLog 不翻状态、onStatusChange
      // 回合中不来，被误判的活流只能干等人工（今晚案例：relay 重启拉活后卡片恒显
      // 「等待 CLI 输入」而流实际在工作）。任何流回调都是活体证据：翻回 WORKING
      // 并撤销放弃标记
      if (managed.wd.gaveUp) {
        managed.wd.gaveUp = false;
        managed.state.status = "WORKING";
        managed.state.action_summary = "流已恢复";
        managed.state.waiting_request = undefined;
        managed.state.turn_started_at = Date.now();
        this.pushExternalLog(managed.state.session_id, "system", "检测到会话流仍在工作，已自动撤销等待状态");
        this.emitUpdated(managed, true);
      }
      managed.lastProgressAt = Date.now();
      managed.lastProgressKind = kind;
    };
    return {
        onInit: (sdkId, model, permissionMode) => {
          if (!mine()) return;
          touch("init");
          // #189 resume 互斥解除：新流 init 到达 = spawn 窗口结束，后续消息/恢复
          // 请求恢复正常路径（sendMessage 直达 / 接管补刀）
          managed.resumePending = undefined;
          // #307：托管子会话 sid 即时落盘 child-sessions.json——relay 在此刻之后
          // 任意时点重启，孤儿扫描都认得它是自己的（不再被收养成"relay"垃圾会话）
          if (!this.childSdkIds.has(sdkId)) {
            this.childSdkIds.add(sdkId);
            appendChildSession(this.cfg.dataDir, sdkId);
          }
          managed.state.relay_session_id = sdkId;
          // #26 Leader 锚回写：resume 会产生新 sdkId（onInit 无条件覆盖上面这行即证），
          // 锚必须跟着收敛——否则下次恢复用旧 sid 必 404。「固定 session id」的实现
          // 就是这个锚 + 每次回写，而非假设 id 不变。
          if (managed.state.session_id === this.leaderId) {
            const a = readOrgAnchor();
            if (a && a.leader_session_id === managed.state.session_id) {
              writeOrgAnchor({ ...a, leader_sdk_id: sdkId, updated_at: Date.now() });
            }
            // #26 待命化（防看门狗误杀）：init 已到、无排队消息（没有即将开始的回合）
            // 却停在 WORKING——tickWatchdog 只检测 WORKING，parked Leader 静默 10min
            // 必进 slow lane 被杀树重拉。翻 DONE = 合法的「等待咨询」形态。
            // 消息驱动 resume 先 push unacked 再 spawn，到达这里 unacked≥1 不误翻；
            // reviveSaved 的 onInit 包裹在 base 之后自设 DONE，覆盖不冲突。
            if (managed.unacked.length === 0 && managed.state.status === "WORKING") {
              managed.state.status = "DONE";
              managed.state.done_reason = "待命（等待咨询）";
              managed.state.action_summary = "组织 Leader · 待命";
              managed.state.turn_started_at = undefined;
            }
          }
          managed.state.model = model;
          if (isManagedMode(permissionMode)) managed.state.permission_mode = permissionMode;
          this.emitUpdated(managed, true);
        },
        onStatusChange: (status, summary) => {
          if (!mine()) return;
          touch(status === "WORKING" ? "status_working" : "status");
          // 审批弹窗死锁根治③：status 与 waiting_request 必须同进退——端上卡片按钮
          // 只看 waiting_request、详情弹窗只看 status，任一帧让两者脱钩（status 翻走
          // 而 waiting_request 残留）就是"处理按钮在、审批窗永不出现"。agent 仍有未
          // 决议权限请求（hasPending，CLI 真阻塞）时，WORKING 是误报，保持 WAITING；
          // pending 已清（CLI 越过权限门）则接受新状态并同帧清掉 waiting_request
          const live = managed.state.status === "WAITING" && !!managed.state.waiting_request;
          const effStatus =
            live && status === "WORKING" && (managed.agent?.hasPending?.() ?? false) ? "WAITING" : status;
          const changed = managed.state.status !== effStatus;
          // 回合起点：非 WORKING → WORKING 的跳变时刻（手机/手表状态行计时用）
          if (changed && effStatus === "WORKING") managed.state.turn_started_at = Date.now();
          const cleared = live && effStatus !== "WAITING";
          if (cleared) managed.state.waiting_request = undefined;
          managed.state.status = effStatus;
          managed.state.action_summary = summary;
          // 审批数据清零是关键翻转，不受节流吞帧（下一帧 UPDATE 即各端收敛的保证）
          this.emitUpdated(managed, changed || cleared);
        },
        onWaiting: (p) => {
          if (!mine()) return;
          touch("waiting");
          managed.state.status = "WAITING";
          managed.state.waiting_request = p;
          managed.state.updated_at = Date.now();
          this.bus.emit(managed.state.session_id, "SESSION_WAITING", p);
        },
        onWaitingResolved: (requestId, decision, resolvedBy) => {
          if (!mine()) return;
          touch("waiting_resolved");
          // 根治③续：仅当决议针对"当前挂起"的请求才收口状态——孤儿请求补发的
          // superseded 理论上可能晚于下一个 WAITING 到达（多端并发决议的时序窗口），
          // 无差别收口会把新请求的 WAITING 一并打掉，复刻死锁
          const cur = managed.state.waiting_request;
          if (!cur || cur.request_id === requestId) {
            managed.state.status = "WORKING";
            managed.state.waiting_request = undefined;
            // 强制补一帧带 waiting_request:null 的 UPDATE：RESOLVED 是瞬态帧，云桥/
            // 断线丢帧时这帧是各端收敛的第二通道（不受节流）
            this.emitUpdated(managed, true);
          }
          managed.state.updated_at = Date.now();
          this.bus.emit(managed.state.session_id, "SESSION_WAITING_RESOLVED", {
            request_id: requestId,
            decision,
            by: resolvedBy ?? "relay",
          });
        },
        onStats: (stats) => {
          if (!mine()) return;
          touch("stats");
          managed.state.stats = stats;
        },
        // #35 输出物：SDK 工具结果单条合并（agent-adapter 从 tool_use/tool_result 配对产出）
        onArtifacts: (item) => {
          if (!mine()) return;
          this.mergeArtifact(managed.state.session_id, item);
        },
        onTodos: (todos) => {
          if (!mine()) return;
          // 经 setTodos 咽喉点：托管会话的隐藏条目同样被过滤
          this.setTodos(managed.state.session_id, todos);
        },
        // #112 子 Agent 工作状态（SDK 托管会话）：复用 setExternalSubagents 咽喉
        //（JSON 对比去重 + SESSION_UPDATED 下发——实现与 external 无耦合，通用）
        onSubagents: (list) => {
          if (!mine()) return;
          touch("subagents");
          this.setExternalSubagents(managed.state.session_id, list);
        },
        onUsage: (u) => {
          if (!mine()) return;
          touch("usage");
          // result 消息是每回合一条，usage 为回合聚合量（回合内各次调用之和）：只累计
          // 会话总量。#72：聚合值 ≠ 当前窗口占用（重回合恒超窗口上限，曾把水位钉死
          // 假 100%）——水位改由 onContext（每条 assistant 消息的 per-call usage）维护
          const cur = managed.state.usage;
          managed.state.usage = {
            input_tokens: (cur?.input_tokens ?? 0) + u.input_tokens,
            output_tokens: (cur?.output_tokens ?? 0) + u.output_tokens,
            cache_read_input_tokens: (cur?.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: (cur?.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          };
          this.emitUpdated(managed, true);
        },
        // #72 上下文水位（per-call 口径，回合内逐调用实时刷新）：assistant 消息自带
        // usage，in+cr+cc = 该次调用实际送入的上下文，覆盖式——压缩后自然回落。
        // 可选回调：旧实现方（标题生成等假 agent）不实现也不影响
        onContext: (tokens: number) => {
          if (!mine()) return;
          touch("context");
          if (tokens > 0) managed.state.context_usage = tokens;
          managed.state.context_limit = contextLimitOf(managed.state.model);
          this.emitUpdated(managed, false);
        },
        onLog: (kind, text, meta) => {
          if (!mine()) return;
          touch(kind);
          // #7 看门狗消息重放账：流回显 user_message = CLI 真正收到了这条消息
          //（echo 文案带"（+N 图）"尾缀，匹配前剥掉；normalize 口径与手机端一致）
          if (kind === "user_message") {
            const key = text.replace(/（\+\d+ 图）$/, "").trim().replace(/\s+/g, " ").slice(0, 200);
            const i = managed.unacked.findIndex((m) => m.text.trim().replace(/\s+/g, " ").slice(0, 200) === key);
            if (i >= 0) managed.unacked.splice(i, 1);
          }
          const entry: LogEntry = { ts: Date.now(), kind, text, ...meta };
          // 同 id 流式块原地替换，避免时间线被增量刷屏
          const i = meta?.id ? managed.logs.findIndex((e) => e.id === meta.id) : -1;
          if (i >= 0) managed.logs[i] = entry;
          else {
            managed.logs.push(entry);
            if (managed.logs.length > 500) managed.logs.splice(0, managed.logs.length - 500);
          }
          this.bus.emit(managed.state.session_id, "SESSION_LOG", entry);
        },
        onTurnEnd: (ok, reason, durationMs) => {
          if (!mine()) return;
          // #7 看门狗恢复期：杀树时 CLI 可能吐出最后的 interrupted result——状态
          // 归恢复流程接管（resumeAgent 紧接着设 WORKING），此处让位避免 ERROR/DONE
          // 假终态帧闪现
          if (managed.wd.phase === "recovering") return;
          // #26 派单台账收口（M2 泛化全会话）：一回合一单，FIFO 收最旧（多消息排队时
          // 按序逐回合收）；Leader 咨询档与 worker 派单同机制，FIFO 空 = no-op。
          // recovering 让位漏掉的收口由恢复流的下个 onTurnEnd 补上
          this.closeOpenDispatches(managed.state.session_id, ok ? "done" : "failed", reason, false,
            // #26 M3 审查修正：interrupted（用户手动停止，agent-adapter 停止路径固定此
            // reason）≠ 交付——同「中断不写熟手账」口径，不抬 count（板联动照旧走 done）
            !(ok && reason === "interrupted"));
          managed.state.updated_at = Date.now();
          managed.state.duration_ms = durationMs;
          // 回合收口同时清残留审批数据（打断等待中的请求等场景）：status 与
          // waiting_request 脱钩是审批弹窗死锁的根源，任何离开 WAITING 的路径都收口
          managed.state.waiting_request = undefined;
          if (ok) {
            managed.state.status = "DONE";
            managed.state.done_reason = reason;
            this.bus.emit(managed.state.session_id, "SESSION_DONE", {
              terminal_reason: reason,
              duration_ms: durationMs,
              stats: { ...managed.state.stats },
            });
          } else {
            managed.state.status = "ERROR";
            managed.state.last_error = reason;
            this.bus.emit(managed.state.session_id, "SESSION_ERROR", { message: reason });
          }
        },
        onSessionEnd: (reason) => {
          if (!mine()) return;
          // #7 看门狗：恢复期旧 agent 流被杀关闭是预期步骤，不产生 DONE 假终态
          //（状态由恢复流程接管）；其余路径（进程自然退出/stop 收尾）照旧收口，
          // 并复位采样相位——新 agent 由 resumeAgent/reviveSaved 重新起算
          if (managed.wd.phase === "recovering") return;
          // #26 派单台账兜底（M2 泛化全会话）：流关闭时仍未收口的派单一律 done
          //（流没了 = 该回合无法继续，咨询与 worker 派单同语义），全清 FIFO。
          // M3 审查修正：兜底收口是中断口径（能走到这的都没收过 onTurnEnd 终态——
          // 未开工/被打断），不写熟手 count（含用户停止触发的 pump finally 路径）。
          // M1/M2 审查轮：板去向也按中断口径退 todo——活没交付，台账 done 只写实
          //「流关了」，条目退回待认领（否则结项核对清单看不见未完，绕过知情放行卡）
          this.closeOpenDispatches(managed.state.session_id, "done", reason, true, false, undefined, "todo");
          managed.wd.phase = "idle";
          if (managed.state.status !== "DONE" && managed.state.status !== "ERROR") {
            managed.state.status = "DONE";
            managed.state.done_reason = reason;
            this.bus.emit(managed.state.session_id, "SESSION_DONE", {
              terminal_reason: reason,
              duration_ms: Date.now() - managed.state.started_at,
              stats: { ...managed.state.stats },
            });
          }
        },
    };
  }

  // 死会话复活：用 SDK resume 在同一 relay 会话上重建 agent（时间线/状态保留）。
  // echo（#62 文件消息）：客户端可见回显文本——正文已合成路径指令时传原文本短回显，
  // 不暴露临时路径（同 #54b 口径）；不传则回显截断正文 + 图片计数
  private resumeAgent(s: ManagedSession, firstMessage: string, images?: string[], echo?: string): void {
    const sdkId = s.state.relay_session_id;
    if (!sdkId) {
      throw new Error("会话已结束且无 SDK 会话记录，无法恢复（模型尚未完成初始化）");
    }
    // #109 旧流收尾：放弃路径不再预杀树，接管时在此补刀（防孤儿进程/双流并发）。
    // 代际递增先于补刀——旧流的收尾回调过不了身份守卫，不会污染新流状态
    // #189 补刀不看 ended：ended 只代表 SDK 流关闭，进程可能还活着（流半开/早断，
    // 实测 91907 活尸——流断数小时进程仍在跑）。接管换流时旧进程必须杀：它的工作
    // 要么已入 transcript 要么已丢，留着只会双进程分叉。childPid 未就位（异步 spawn
    // 回调填充中）的窗口由调用侧互斥（resumePending）挡住，不该走到这里
    const old = s.agent;
    s.streamGen++;
    if (old?.childPid) {
      void this.watchdogProcs.killTree(old.childPid).catch(() => {});
    }
    // #189 resume 互斥标记：spawn→onInit 窗口内的二次 resume 请求在调用侧被拦下
    s.resumePending = Date.now();
    const agent = this.newAgent(
      s.state.cwd,
      s.state.model,
      this.agentCallbacks(s),
      firstMessage,
      { resume: sdkId, permissionMode: s.state.permission_mode ?? "default", images },
    );
    s.agent = agent;
    // resume 的子 sid 同样经 onInit 回调登记（见 agentCallbacks.onInit 的 #307 落盘）
    s.state.status = "WORKING";
    s.state.historical = false;
    s.state.saved = undefined;
    // #26 M3 审查修正：复活即脱离挂起休眠——不清的话组挂起后用户发消息救活的成员
    // 在熟手池里永远显示「随组挂起」（pool parked 口径失真，直到组复活才洗掉）
    s.state.org_parked = undefined;
    // #139：摘掉休眠期残留的「已保存，点击恢复」摘要——不清的话手机/紧凑卡在
    // 恢复后到首个进度事件之间仍显示旧文案，看起来像「恢复了但没生效」
    s.state.action_summary = "";
    s.state.done_reason = undefined;
    s.state.last_error = undefined;
    s.state.turn_started_at = Date.now();
    // #7 看门狗：新 agent 锚点重新起算；首条消息同样入重放账（resume 后流再断，
    // 下一轮自愈要带上它）
    s.lastProgressAt = Date.now();
    s.lastProgressKind = "";
    s.wd.phase = "idle";
    s.wd.gaveUp = false;
    s.unacked.push({ text: firstMessage, images, ts: Date.now() });
    const marker = images && images.length > 0 ? `（+${images.length} 图）` : "";
    this.pushExternalLog(s.state.session_id, "user_message", echo ?? truncate(firstMessage, 200) + marker);
    this.pushExternalLog(s.state.session_id, "system", `已恢复 SDK 会话（resume ${sdkId.slice(0, 8)}…）`);
    this.emitUpdated(s, true);
  }

  // #49 按需拉起（COMMAND_RESUME_SESSION）：不带首条消息的 parked resume——
  // transcript 重放完成后 CLI 停在等待输入，首个回合由后续 COMMAND_MESSAGE 开启。
  // 成功判定 = init 消息到达（SDK 会话就绪）；init 前流关闭 / 30s 超时 = 恢复失败
  // （ERROR + last_error，saved 保留让卡片可重试）。回调包裹仅在此路径生效，
  // resumeAgent（消息驱动）行为保持原样不动
  private reviveSaved(s: ManagedSession): void {
    const sdkId = s.state.relay_session_id;
    if (!sdkId) {
      throw new Error("无 SDK 会话记录（首次回合未完成即中断），无法恢复");
    }
    let inited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // #109 换流代际递增 + 撤销放弃标记（resumeAgent 同口径：新流身份从现在起算）
    s.streamGen++;
    // #189 resume 互斥标记（同 resumeAgent：spawn→onInit 窗口内不换流）
    s.resumePending = Date.now();
    s.wd.gaveUp = false;
    const base = this.agentCallbacks(s);
    const fail = (reason: string): void => {
      if (inited) return;
      inited = true; // 流关闭与超时可能先后到，双触发只记一次
      if (timer) clearTimeout(timer);
      s.state.status = "ERROR";
      s.state.last_error = `恢复失败: ${reason}`;
      s.state.done_reason = undefined;
      s.state.action_summary = "恢复失败";
      s.state.saved = true; // 休眠卡保留：端上标「恢复失败」，可重试
      s.state.updated_at = Date.now();
      this.pushExternalLog(s.state.session_id, "system", s.state.last_error);
      this.bus.emit(s.state.session_id, "SESSION_ERROR", { message: s.state.last_error });
      this.emitUpdated(s, true);
    };
    const cb: AgentCallbacks = {
      ...base,
      onInit: (sdkIdNew, model, permissionMode) => {
        inited = true;
        if (timer) clearTimeout(timer);
        // 先清休眠标记再走 base 的 emitUpdated，让首帧就带最终状态
        s.state.saved = undefined;
        s.state.historical = false;
        s.state.org_parked = undefined; // M3 审查修正：恢复即脱离挂起休眠（同 resumeAgent）
        base.onInit(sdkIdNew, model, permissionMode);
        s.state.status = "DONE";
        s.state.done_reason = "已恢复（等待输入）";
        s.state.action_summary = "已恢复，等待输入";
        s.state.turn_started_at = undefined;
        this.pushExternalLog(s.state.session_id, "system", `已恢复 SDK 会话（resume ${sdkId.slice(0, 8)}…）`);
        this.emitUpdated(s, true);
      },
      onSessionEnd: (reason) => {
        if (!inited) {
          fail(reason);
          return;
        }
        base.onSessionEnd(reason);
      },
    };
    // 初始化看门狗：CLI 卡住不吐 init 时不让会话永远吊在「恢复中」
    timer = setTimeout(() => {
      timer = null;
      fail("初始化超时（30s）");
      void s.agent?.stop();
    }, 30_000);
    timer.unref?.();
    const agent = this.newAgent(s.state.cwd, s.state.model, cb, undefined, {
      resume: sdkId,
      permissionMode: s.state.permission_mode ?? "default",
    });
    s.agent = agent;
    s.state.status = "WORKING";
    s.state.action_summary = "恢复中";
    s.state.done_reason = undefined;
    s.state.last_error = undefined;
    s.state.updated_at = Date.now();
    // #7 看门狗：parked 恢复锚点起算（init 30s 超时兜底 pre-init 挂死）
    s.lastProgressAt = Date.now();
    s.lastProgressKind = "";
    s.wd.phase = "idle";
    this.emitUpdated(s, true);
  }

  // #49 开机置顶登记（不自动拉起，2026-09-09 用户拍板）：pinned-sessions.json 是
  // 权威清单（历史事件里的 pinned 可能过时——unpin 落盘后重启的兜底，一律按文件
  // 归一）。清单内托管会话标 pinned+saved 休眠（可见、状态 DONE「已保存」、不可
  // 操作，点卡走 COMMAND_RESUME_SESSION）；查无会话的条目（压缩丢失/已删）静默清理
  applyPinned(): { saved: number } {
    const file = readPinnedSessions(this.cfg.dataDir);
    const keep: string[] = [];
    let saved = 0;
    for (const s of this.sessions.values()) {
      const pinned = file.includes(s.state.session_id);
      if (pinned && !s.state.external) {
        keep.push(s.state.session_id);
        const was = s.state.pinned;
        s.state.pinned = true;
        if (!s.agent) {
          // 休眠登记：relay 刚启动，置顶会话一律无 agent
          s.state.saved = true;
          s.state.status = "DONE";
          s.state.done_reason = "已保存（重启休眠）";
          s.state.action_summary = "已保存，点击恢复";
          s.state.last_error = undefined;
          s.state.waiting_request = undefined;
          saved++;
        }
        if (!was) this.emitUpdated(s, true);
      } else if (s.state.pinned) {
        // 文件已无此 id（unpin 已落盘但历史事件仍带 pinned=true）
        s.state.pinned = undefined;
        this.emitUpdated(s, true);
      }
    }
    if (keep.length !== file.length) writePinnedSessions(this.cfg.dataDir, keep);
    return { saved };
  }

  // ================= #26 矩阵式团队 M1：组织 Leader 常驻化 =================
  // 设计稿 v3.1 §3.5「逻辑常驻」：常驻 = 固定身份（org.json 锚，独立于 events.ndjson
  // 压缩与 pinned 双向清理）+ 按需物理拉起（复用休眠卡/pinned/消息驱动 resume 底座）。
  // 开机 ensureLeader 只保证「卡在、锚准」；除首建带上岗引导 spawn 一次（一次性拿
  // sdkId——无 sdkId 的会话无法 resume，见 org.ts 引导注释）外零 spawn。

  isLeaderSession(sessionId: string): boolean {
    return this.leaderId === sessionId;
  }

  ensureLeader(): { ok: true; session_id: string; created: boolean; rebuilt: boolean } | { ok: false; error: string } {
    if (this.leaderEnsured && this.leaderId) {
      return { ok: true, session_id: this.leaderId, created: false, rebuilt: false };
    }
    try {
      ensureOrgDir();
      ensureOrgClaudeMd();
      ensureOrgCli(); // #26 M2：物化 ~/.cc-deck/bin/org（Leader 分诊指令通道；测试态跳过）
    } catch (e) {
      return { ok: false, error: `org 目录不可用: ${e instanceof Error ? e.message : String(e)}` };
    }
    // #26 断档补记：上一进程遗留的 running/dispatched 悬账（relay 崩溃/强杀时回合
    // 没收口；dispatched = M2 派单 spawn 窗口崩的账）——本进程的内存 FIFO 已随进程
    // 丢失，不补则永悬；各补一行 done 收口（不联动搬卡：worker 会话 resume 后板条
    // 仍归它，Leader 可重派）。auto-revive 续跑不走 COMMAND_MESSAGE 天然不入新账，
    // 不会双记。
    const hung = readDispatchLog().filter((e) => e.status === "running" || e.status === "dispatched");
    for (const e of hung) {
      appendDispatch({ ...e, ts: Date.now(), status: "done", receipt: "relay 重启，回合中断" });
    }
    const anchor = readOrgAnchor();
    if (!anchor) return this.createLeaderFirstTime();
    const s = this.sessions.get(anchor.leader_session_id);
    if (s) {
      this.adoptExistingLeader(s, anchor);
      return { ok: true, session_id: anchor.leader_session_id, created: false, rebuilt: false };
    }
    if (!anchor.leader_sdk_id) {
      // 首建后 init 前崩过的废锚：会话无法 resume（无 sdkId），清锚按未建组织处理
      clearOrgAnchor();
      return this.createLeaderFirstTime();
    }
    return this.rebuildDormantLeader(anchor);
  }

  // 首建：带上岗引导消息 spawn（parked 空 prompt 在真实链路不回 init、拿不到 sdkId，
  // 见 org.ts ORG_LEADER_BOOTSTRAP_PROMPT 注释），一次性拿 sdkId——此后常驻零 spawn。
  // 锚紧邻 create 同步落盘（崩溃窗口微秒级；后果=pinned 残卡可手删，下次重建）。
  private createLeaderFirstTime(): { ok: true; session_id: string; created: boolean; rebuilt: boolean } | { ok: false; error: string } {
    const id = this.create(orgDir(), ORG_LEADER_BOOTSTRAP_PROMPT, undefined, false, { skipStickyCwd: true });
    const now = Date.now();
    // M1 审查轮：锚写失败不得继续置常驻——否则本进程「假常驻」（leaderEnsured 真、
    // 锚不在盘上）+ 下次启动按未建组织再 spawn → 双 Leader 卡。失败即报错返回
    //（会话保留为普通卡可手删；下次启动重试）。崩溃窗口=spawn 与落盘之间，微秒级
    if (!writeOrgAnchor({ version: 1, leader_session_id: id, leader_sdk_id: "", created_at: now, updated_at: now })) {
      return { ok: false, error: "组织锚写盘失败（盘满/权限？），本次未标记常驻；下次启动重试" };
    }
    // 题名双写：override 文件管跨重启（adopt 套用），内存 state.title 管当下卡片
    //（不设的话首建到下次重启之间卡片显示的是空 prompt 派生名）
    const s = this.sessions.get(id);
    if (s) {
      // 内存态同步置顶：驱逐豁免（evictOldSessions）读的是 state.pinned，只写文件
      // 的话首建到重启之间 Leader 仍是可驱逐的普通卡
      s.state.pinned = true;
      s.state.title = ORG_LEADER_TITLE;
      s.state.title_locked = true;
      this.emitUpdated(s, true);
    }
    this.setTitleOverride(id, ORG_LEADER_TITLE);
    this.leaderId = id;
    this.leaderEnsured = true;
    // 首建即置顶：驱逐豁免（evictOldSessions）+ 重启休眠登记（applyPinned）都吃 pinned
    this.pinLeaderFile(id);
    return { ok: true, session_id: id, created: true, rebuilt: false };
  }

  // 正常重启路径：会话已由 adopt 从 events 收养（可能已被 applyPinned 标休眠）。
  // 只做常驻收口：补钉（unpin 过/文件条目被清过都复原——常驻语义）+ 题名 + leaderId。
  // 不 spawn、不改 status（agent 存活时更不动运行态）。
  private adoptExistingLeader(s: ManagedSession, _anchor: ReturnType<typeof readOrgAnchor>): void {
    const id = s.state.session_id;
    s.state.pinned = true;
    if (!s.agent) {
      s.state.saved = true;
      if (s.state.status !== "DONE") {
        s.state.status = "DONE";
        s.state.done_reason = "已保存（组织 Leader 休眠）";
      }
    }
    this.pinLeaderFile(id);
    this.setTitleOverride(id, ORG_LEADER_TITLE);
    this.leaderId = id;
    this.leaderEnsured = true;
  }

  // events 被压缩挤掉（>30 会话）或用户删卡后的重建：从锚合成休眠卡，零 spawn。
  // 不 emit SESSION_CREATED——锚才是重建权威；开机广播走 emitUpdated（与 applyPinned
  // 同款），孤儿 UPDATED 行在 reduceHistory 里天然跳过（缺 CREATED）。
  private rebuildDormantLeader(anchor: NonNullable<ReturnType<typeof readOrgAnchor>>): { ok: true; session_id: string; created: boolean; rebuilt: boolean } {
    const id = anchor.leader_session_id;
    const managed: ManagedSession = {
      agent: null,
      state: {
        session_id: id,
        relay_session_id: anchor.leader_sdk_id,
        cwd: orgDir(),
        initial_prompt: "",
        title: ORG_LEADER_TITLE,
        model: this.cfg.model,
        status: "DONE",
        done_reason: "已保存（组织 Leader 休眠）",
        action_summary: "组织 Leader · 待命",
        started_at: anchor.created_at || Date.now(),
        updated_at: anchor.updated_at || Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
        title_locked: true,
        historical: true,
        pinned: true,
        saved: true,
      },
      logs: [],
      lastUpdateEmit: 0,
      lastProgressAt: 0,
      lastProgressKind: "",
      unacked: [],
      wd: { phase: "idle", recoveries: [], gaveUp: false },
      streamGen: 0,
    };
    this.sessions.set(id, managed);
    this.pinLeaderFile(id);
    this.setTitleOverride(id, ORG_LEADER_TITLE);
    this.leaderId = id;
    this.leaderEnsured = true;
    this.emitUpdated(managed, true);
    return { ok: true, session_id: id, created: false, rebuilt: true };
  }

  // Leader 常驻置顶写穿（去重后追加；cap 50 由 writePinnedSessions 裁）
  private pinLeaderFile(id: string): void {
    const ids = readPinnedSessions(this.cfg.dataDir).filter((x) => x !== id);
    ids.push(id);
    writePinnedSessions(this.cfg.dataDir, ids);
  }

  // 题名 override 写穿（跨重启收养/重建时都套用；仿 COMMAND_RENAME 落盘写法）
  private setTitleOverride(id: string, title: string): void {
    this.titleOverrides[id] = title;
    try {
      writeFileSync(join(this.cfg.dataDir, "title-overrides.json"), JSON.stringify(this.titleOverrides));
    } catch {}
  }

  // #26 派单台账收口（M2 泛化全会话）：按会话键从 FIFO 取未收口派单补 done/failed
  // 行（append-only 状态机，读侧同 id 取最后一行收敛）。all=true 全清（onSessionEnd
  // 流关闭兜底）；FIFO 空 = 无未收口派单（上岗引导回合等），no-op。
  // 回执 = terminal_reason 截 200 字；gid 条目联动任务板：done→done、failed→todo
  //（退回待认领）。boardTo 显式覆盖板去向：兜底收口（流关闭/恢复待命）台账记
  // done（中断≠交付，回执写实）但活没交付，板须退 todo——不能用台账 status 推板。
  private pushOpenDispatch(key: string, e: { id: string; tier: DispatchTier; gid?: string; anchor?: string }): void {
    const q = this.openDispatches.get(key) ?? [];
    q.push(e);
    this.openDispatches.set(key, q);
  }

  private closeOpenDispatches(key: string, status: "done" | "failed", receipt: string, all = false, recordRouting = true, onlyGid?: string, boardTo?: "done" | "todo"): void {
    const q = this.openDispatches.get(key);
    if (!q || q.length === 0) return;
    // onlyGid（组挂起/结项联动收口用）：只收**该组**的派单——同一熟手可跨多组在跑，
    // A 组挂起不得把成员为 B 组干的活一起收掉（矩阵式「项目×熟手」正交）
    const es = onlyGid
      ? (() => {
          const hit = q.filter((x) => x.gid === onlyGid);
          for (const x of hit) q.splice(q.indexOf(x), 1);
          return hit;
        })()
      : all
        ? q.splice(0)
        : [q.shift()].filter((x): x is { id: string; tier: DispatchTier; gid?: string; anchor?: string } => !!x);
    if (q.length === 0) this.openDispatches.delete(key);
    for (const e of es) {
      appendDispatch({
        ts: Date.now(), id: e.id, tier: e.tier,
        target: key === this.leaderId ? "org-leader" : key,
        status, receipt: truncate(receipt, 200), session_id: key,
        ...(e.anchor ? { project_anchor: e.anchor } : {}),
      });
      if (e.gid) {
        moveEntryByDispatch(e.gid, e.id, boardTo ?? (status === "done" ? "done" : "todo"));
        this.emitBoard(e.gid);
        // #26 M3 路由表记账：项目组派单收口即写熟手底账（次数/上次/回执；断档补记
        // 直接走 appendDispatch 不经此，天然豁免——relay 重启不是 worker 的账）。
        // recordRouting=false = 挂起联动收口：回合中断是用户决策不是 worker 干砸，
        // 熟手评价无感
        if (recordRouting) recordRoutingResult(e.gid, key, status, receipt);
      }
    }
  }

  // ---------- #26 M2 分诊引擎（§4 响应四档/第五态 + §6.2 状态机 + 确认门槛） ----------
  // 单漏斗：Leader CLI（ws-server /api/org HTTP）与用户客户端（COMMAND_ORG_CONFIRM）
  // 都路由到 orgAction。决议与执行分离：decideConfirm 只记决策，副作用统一
  // applyConfirmEffects（可审计）。用户是指挥/验收者——Leader 只提案不决议。

  orgAction(action: string, p: Record<string, unknown>): { ok: true; data?: unknown } | { ok: false; error: string } {
    const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
    const bool = (k: string): boolean => p[k] === true;
    try {
      switch (action) {
        case "status": {
          return {
            ok: true,
            data: {
              groups: listGroups(),
              pending: listPendingConfirms(),
              open: readDispatchLog().filter((e) => e.status === "running" || e.status === "dispatched").slice(-20),
            },
          };
        }
        case "project-create": {
          const name = str("name");
          const anchor = str("anchor");
          const tier = str("tier") as ProjectTier;
          if (!name || !anchor) return { ok: false, error: "name/anchor 必填" };
          if (!isAbsolute(anchor)) return { ok: false, error: "anchor 必须是绝对路径" };
          if (tier !== "轻立项" && tier !== "正经立项") return { ok: false, error: "tier 必须是 轻立项|正经立项" };
          const r = createGroup({ name, anchor_dir: anchor, tier });
          if (!r.ok) return r;
          ensureProjectClaudeMd(anchor, name); // §3.4 防漂移种子（幂等：存在即认不覆盖）
          this.emitOrgState();
          return { ok: true, data: { group: r.group, needsConfirm: r.needsConfirm, confirm: r.confirm } };
        }
        case "project-status": {
          const id = str("id");
          const to = str("to") as ProjectGroupStatus;
          const note = str("note");
          if (!id || !to) return { ok: false, error: "id/to 必填" };
          if (!["active", "parked", "archived"].includes(to)) return { ok: false, error: "to 必须是 active|parked|archived" };
          // 确认门槛不可旁路：pending（正经立项/首次轻立项的确认前态）只经确认卡决议
          // 出口（✓→active / ✗→archived 留痕），Leader 直接 set 会绕过用户决策
          const cur = findGroup(id);
          if (cur?.status === "pending") {
            return { ok: false, error: `项目组待确认（pending），去留由用户在确认卡上 ✓/✗ 决议` };
          }
          if (to === "archived") {
            const chk = buildArchiveChecklist(id);
            if (!chk) return { ok: false, error: `项目组不存在: ${id}` };
            // §3.4 结项断言核对：零悬账零未完 → 一句话归档；有异常 → 确认卡附清单裁决
            if (chk.openDispatches.length === 0 && chk.openBoardEntries === 0) {
              const r = setGroupStatus(id, "archived", note || "零异常一句话归档");
              if (!r.ok) return r;
              this.disbandGroupMembers(r.group.id); // M3：编制解散（停流+解除归属；路由档案永存）
              this.emitOrgState();
              this.emitBoard(r.group.id);
              return { ok: true, data: { group: r.group, archived: true } };
            }
            const confirm = addConfirm({
              kind: "archive",
              title: `结项确认：${chk.name}`,
              reason: `悬账 ${chk.openDispatches.length} 项 / 板未完 ${chk.openBoardEntries} 条，附核对清单裁决`,
              payload: { gid: chk.gid, checklist: chk, note },
            });
            this.emitOrgState();
            return { ok: true, data: { needsConfirm: true, confirm, checklist: chk } };
          }
          // 挂起（你说「先放放」）/ 复活（读档重建）：用户明示决策，直达不走确认单。
          // M3 审查修正（挂起序）：先收成员再冻组——组一 parked 板即冻结只读，先冻
          // 后收会让「板退待办」静默失效（被打断的条目永挂 doing）。迁移合法性先核，
          // 非法迁移不动成员
          const cur2 = findGroup(id);
          if (!cur2) return { ok: false, error: `项目组不存在: ${id}` };
          if (!canTransition(cur2.status, to)) {
            return { ok: false, error: `非法状态迁移: ${cur2.status} → ${to}` };
          }
          // M1/M2 审查轮（复活边锚复查）：archived 组的锚在归档时已释放
          //（findGroupByAnchor 排除 archived），期间锚可能被新组占位——此时复活会
          // 造出双组同锚（派单回执按锚过滤会串组、板/编制口径全糊），先核占用
          if (to === "active" && cur2.status === "archived") {
            const holder = findGroupByAnchor(cur2.anchor_dir);
            if (holder && holder.id !== cur2.id) {
              return { ok: false, error: `锚点已被在办组「${holder.name}」占用，复活会双组同锚；请为新位置重新立项（或先结项占位组）` };
            }
          }
          if (to === "parked") this.parkGroupMembers(id);
          const r = setGroupStatus(id, to, note || undefined);
          if (!r.ok) return r;
          // #26 M3 两层联动：挂起 → 成员会话全 parked（收悬账+停流+退休进熟手池）；
          // 复活 → 只清标记（原班由路由表在下次派单拉回）
          if (to === "active") this.reviveGroupMembers(r.group.id);
          this.emitOrgState();
          this.emitBoard(r.group.id); // 冻结态翻转随板广播
          return { ok: true, data: { group: r.group } };
        }
        case "project-tier": {
          const id = str("id");
          const to = str("to") as ProjectTier;
          const reason = str("reason");
          if (!id) return { ok: false, error: "id 必填" };
          if (to !== "轻立项" && to !== "正经立项") return { ok: false, error: "to 必须是 轻立项|正经立项" };
          if (!reason) return { ok: false, error: "升降级必须带一句理由（§4 矫正通道）" };
          const g = findGroup(id);
          if (!g) return { ok: false, error: `项目组不存在: ${id}` };
          // #26 收尾加固：档位是立项确认卡语义的一部分（首建档位就写在 project-create
          // 卡上）——pending 组先改档会出现「审的是轻、落地的是正」；archived 组编制
          // 已解散，改档无意义（重启请重新立项）。挂起组允许（整理档位与复活后口径
          // 连贯——原记录在案口子，此轮收口）
          if (g.status === "pending") return { ok: false, error: "项目组待立项确认（pending），档位随立项卡定——先 ✓/✗ 立项决议" };
          if (g.status === "archived") return { ok: false, error: "结项组不可改档（编制已解散；如需重启请重新立项）" };
          if (g.tier === to) return { ok: true, data: { group: g, noop: true } };
          const confirm = addConfirm({
            kind: "tier-change",
            title: `${to === "正经立项" ? "升级" : "降级"}：${g.name}（${g.tier} → ${to}）`,
            reason,
            payload: { gid: g.id, to_tier: to },
          });
          this.emitOrgState();
          return { ok: true, data: { needsConfirm: true, confirm } };
        }
        case "suggest-hold": {
          const id = str("id");
          const reason = str("reason");
          const condition = str("condition");
          if (!reason) return { ok: false, error: "建议暂缓必须带一句理由" };
          if (!id) {
            // 无组暂缓（第五态最小形态）：纯台账留痕，回执即解除条件备忘
            appendDispatch({
              ts: Date.now(), id: randomUUID(), tier: "暂缓", target: "org-leader",
              status: "done",
              receipt: truncate(`${reason}${condition ? `（解除条件：${condition}）` : ""}`, 200),
              session_id: this.leaderId ?? "",
            });
            return { ok: true, data: { ledgered: true } };
          }
          const g = findGroup(id);
          if (!g) return { ok: false, error: `项目组不存在: ${id}` };
          // M3 审查修正：只对在办组建议暂缓——挂起/结项组再出卡，点头时联动重跑会
          // 误杀被他组派单/用户消息复活过的成员
          if (g.status !== "active") return { ok: false, error: `项目组 ${g.name} 为 ${g.status}，无需建议暂缓` };
          const confirm = addConfirm({
            kind: "suggest-hold",
            title: `建议暂缓：${g.name}`,
            reason,
            payload: { gid: g.id, ...(condition ? { condition } : {}) },
          });
          markHoldSuggested(g.id, Date.now()); // #26 M3：冷却起算——否决后触发器再等一个窗口不重复叨扰
          this.emitOrgState();
          return { ok: true, data: { needsConfirm: true, confirm } };
        }
        case "dispatch": {
          return this.dispatchWorker({
            anchor: str("anchor"),
            prompt: typeof p.prompt === "string" ? p.prompt : "",
            gid: str("gid") || undefined,
            title: str("title") || undefined,
          });
        }
        case "board": {
          const op = str("op");
          const gid = str("gid");
          if (!gid) return { ok: false, error: "gid 必填" };
          let r: { ok: true; data?: unknown } | { ok: false; error: string };
          if (op === "upsert") {
            const text = str("text");
            if (!text) return { ok: false, error: "text 必填" };
            const status = str("status") as BoardEntryStatus;
            if (status && !["todo", "doing", "done"].includes(status)) return { ok: false, error: "status 必须是 todo|doing|done" };
            const u = upsertBoardEntry(gid, {
              id: str("entry_id") || undefined,
              text,
              ...(status ? { status } : {}),
              ...(str("note") ? { note: str("note") } : {}),
            });
            r = u.ok ? { ok: true, data: { entry: u.entry } } : u;
          } else if (op === "move") {
            // M1/M2 审查轮：move 与 upsert 同口径校验——store 层不挡非法串，
            // 不校验会把任意字符串写进 BoardEntryStatus 污染三端分区渲染
            const st = str("status");
            if (!["todo", "doing", "done"].includes(st)) return { ok: false, error: "status 必须是 todo|doing|done" };
            const m = moveBoardEntry(gid, str("entry_id"), st as BoardEntryStatus);
            r = m.ok ? { ok: true, data: { entry: m.entry } } : m;
          } else if (op === "del") {
            const d = removeBoardEntry(gid, str("entry_id"));
            r = d.ok ? { ok: true } : d;
          } else {
            return { ok: false, error: `未知 board 操作: ${op}` };
          }
          if (r.ok) this.emitBoard(gid);
          return r;
        }
        case "project-detail": {
          const g = findGroup(str("id"));
          if (!g) return { ok: false, error: `项目组不存在: ${str("id")}` };
          // §3.1 项目组详情四分节的服务端数据源：状态/编制（group 内）+ 板 + 回执流；
          // M3 熟手池（§5 成员卡进化：经验 N 次·上次·在忙/空闲）——路由表档案 join
          // 会话运行态，服务端拼好端上零 join
          const receipts = readDispatchLog()
            .filter((e) => {
              const a = e.project_anchor ?? "";
              return a.replace(/\/+$/, "") === g.anchor_dir.replace(/\/+$/, "");
            })
            .slice(-30)
            .reverse();
          const pool = routingFor(g.id).map((e) => {
            const s = this.sessions.get(e.session_id);
            return {
              session_id: e.session_id,
              count: e.count,
              failed: e.failed,
              last_ts: e.last_ts,
              rating: e.rating,
              tags: e.tags,
              title: s?.state.title || "",
              /** 在忙/空闲（运行态，派单时现场口径同 pickVeteran） */
              busy: !!s && (s.state.status === "WORKING" || s.state.status === "WAITING"),
              /** 可拉起：在册且有 SDK resume 句柄；false = 退休（只剩路由表档案） */
              resumable: !!s && !!s.state.relay_session_id,
              /** 随本组挂起休眠（org_parked 指回本组） */
              parked: s?.state.org_parked === g.id,
            };
          });
          return { ok: true, data: { group: g, board: loadBoard(g.id), receipts, pool } };
        }
        // ---------- #26 M3 路由表评鉴（§5：评价跟着合作记录走，Leader 手动） ----------
        case "rate": {
          const gid = str("gid");
          const sid = str("sid");
          const rating = str("rating");
          if (!gid || !sid) return { ok: false, error: "gid/sid 必填" };
          if (rating !== "good" && rating !== "bad") return { ok: false, error: "rating 必须是 good|bad" };
          const r = rateRouting(gid, sid, rating);
          if (!r.ok) return r;
          return { ok: true, data: { entry: r.entry } };
        }
        case "tag": {
          const gid = str("gid");
          const sid = str("sid");
          const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [];
          if (!gid || !sid) return { ok: false, error: "gid/sid 必填" };
          if (tags.length === 0) return { ok: false, error: "tags 必填（至少一个）" };
          const r = tagRouting(gid, sid, tags);
          if (!r.ok) return r;
          return { ok: true, data: { entry: r.entry } };
        }
        case "confirm-decide": {
          const cid = str("confirm_id");
          if (!cid) return { ok: false, error: "confirm_id 必填" };
          // M1/M2 审查轮（决议副作用必须可执行）：批准立项前先核并行名额——pending
          // 组不占 MAX_ACTIVE_GROUPS 名额，若先决议再执行、执行时名额已满，卡已
          // approved 而组永卡 pending（确认卡是 pending 的唯一出口），死锁。前置
          // 核失败 → 卡保持待决，用户腾出名额再批
          if (bool("approve")) {
            const pend = listConfirms().find((c) => c.id === cid);
            const pgid = typeof pend?.payload.gid === "string" ? pend.payload.gid : "";
            if (pend?.kind === "project-create" && pend.status === "pending" && pgid) {
              const g = findGroup(pgid);
              if (g?.status === "pending" && listGroupsByStatus().active.length >= maxActiveGroups()) {
                return { ok: false, error: `在办并行已达上限（${maxActiveGroups()}），先挂起/结项一个组再批准（卡保持待决）` };
              }
            }
          }
          const d = decideConfirm(cid, bool("approve"), str("by") || "user");
          if (!d.ok) return d;
          const eff = this.applyConfirmEffects(d.confirm);
          if (!eff.ok) return { ok: false, error: eff.error ?? "决议副作用执行失败" };
          return { ok: true, data: { confirm: d.confirm } };
        }
        default:
          return { ok: false, error: `未知 org action: ${action}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 确认单决议副作用（一次决一次执行；这里之外不得有组状态迁移的旁路）。
  // M1/M2 审查轮：副作用失败必须回传——静默失败会让「卡已 approved、组没动」的
  // 劈叉态无人知晓（两层联动只做了成员侧）。失败时决议留痕不回滚（decideConfirm
  // 已落盘），错误带回决议方（卡上可见），用户可走直达通道（project-status）补救
  private applyConfirmEffects(c: OrgConfirm): { ok: boolean; error?: string } {
    const gid = typeof c.payload.gid === "string" ? c.payload.gid : "";
    const fail = (what: string, r: { error?: string }): { ok: false; error: string } => {
      this.emitOrgState(); // 失败路径同样广播：成员侧可能已部分变更（如挂起回滚）
      if (gid) this.emitBoard(gid);
      return { ok: false, error: `${what}失败: ${r.error ?? "未知原因"}（决议已留痕，可用 org set 直达通道补救）` };
    };
    if (c.status === "approved") {
      switch (c.kind) {
        case "project-create":
          if (gid) {
            const r = setGroupStatus(gid, "active");
            if (!r.ok) return fail("立项决议通过但激活", r);
            // §4 信任累积：轻立项首次确认通过 → 同类免确认通道打开（只在激活成功后）
            if (findGroup(gid)?.tier === "轻立项") setLightConfirmTrusted(true);
          }
          break;
        case "tier-change":
          if (gid) {
            const r = setGroupTier(gid, (c.payload.to_tier === "轻立项" ? "轻立项" : "正经立项"));
            if (!r.ok) return fail("档位迁移", r);
          }
          break;
        case "suggest-hold":
          // 点头即挂起（§4 第五态）+ M3 两层联动（成员会话全 parked）。
          // 审查修正（陈旧卡复核）：出卡后组可能已恢复活跃（又派了新单）或已非在办，
          // 只对仍 active 的组执行挂起；先收成员再冻组（板退卡窗口，同 project-status）。
          // 非在办 → 跳过属陈旧卡正常语义（ok），不报失败
          if (gid && findGroup(gid)?.status === "active") {
            this.parkGroupMembers(gid);
            const r = setGroupStatus(gid, "parked");
            if (!r.ok) {
              this.reviveGroupMembers(gid); // 冻组失败回滚成员侧标记，避免两层劈叉
              return fail("挂起迁移", r);
            }
          }
          break;
        case "archive":
          if (gid) {
            const a = setGroupStatus(gid, "archived", typeof c.payload.note === "string" && c.payload.note ? c.payload.note : "结项确认通过（悬账/未完条目知情放行）");
            if (!a.ok) return fail("结项迁移", a);
            this.disbandGroupMembers(gid); // M3：编制解散（知情放行的悬账按中断收口）
          }
          break;
        case "revive":
          // 复活边直达通常走 project-status；此类型位保留同款联动（清标记，原班走路由表）
          if (gid) {
            const r = setGroupStatus(gid, "active");
            if (!r.ok) return fail("复活迁移", r);
            this.reviveGroupMembers(gid);
          }
          break;
      }
    } else if (c.kind === "project-create" && gid) {
      const r = setGroupStatus(gid, "archived", "立项确认被否决"); // pending → archived 留痕
      if (!r.ok) return fail("否决留痕迁移", r);
    }
    this.emitOrgState();
    if (gid) this.emitBoard(gid);
    return { ok: true };
  }

  // #26 M2 组织广播（瞬态：在线端实时收敛；离线端由 SNAPSHOT.projects/org_confirms
  // 兜底，板由 COMMAND_PROJECT_DETAIL 按需拉取后经 BOARD_UPDATED 增量维护）
  emitOrgState(): void {
    this.bus.emitTransient("PROJECTS_UPDATED", { groups: listGroups() });
    this.bus.emitTransient("ORG_CONFIRM_UPDATED", { pending: listPendingConfirms() });
  }

  emitBoard(gid: string): void {
    this.bus.emitTransient("BOARD_UPDATED", { gid, board: loadBoard(gid) });
  }

  // #26 M2 派单（§4 随手办/项目组任务）：worker 会话承接——M3 起项目组活双来源
  //（§5 查表：空闲熟手 resume｜新会话+档案注入），随手办仍恒新会话（无组无路由记录）。
  // 先落账再执行（§3.5 台账纪律）：dispatched 行 → 拉起 → running 行（同 id 收敛）；
  // 拉起失败即收口 failed 不留悬账；崩溃窗口的 dispatched 由断档补记兜底。
  // 权限 acceptEdits（§4 随手办纪律）、跳过 sticky 默认目录（worker cwd 锚项目不动全局）。
  dispatchWorker(input: { anchor: string; prompt: string; gid?: string; title?: string }):
    { ok: true; dispatch_id: string; session_id: string } | { ok: false; error: string } {
    if (!input.prompt.trim()) return { ok: false, error: "prompt 必填" };
    if (!input.anchor.startsWith("/")) return { ok: false, error: "anchor 必须是绝对路径" };
    let tier: DispatchTier = "随手办";
    let anchor = input.anchor;
    if (input.gid) {
      const g = findGroup(input.gid);
      if (!g) return { ok: false, error: `项目组不存在: ${input.gid}` };
      if (g.status !== "active") return { ok: false, error: `项目组 ${g.name} 为 ${g.status}，不可派单（挂起冻结/结项只读）` };
      tier = g.tier;
      anchor = g.anchor_dir;
    }
    const dispatchId = randomUUID();
    // #26 M3 §5 双来源调度：项目组活先查路由表——空闲熟手 resume 原会话（会话亲和：
    // 上下文连续，适合长线运维）；忙/避开/只剩档案记录 → 新会话 + 锚点 CLAUDE.md
    // 档案注入（记忆亲和：干净冷启动）。排队不做——设计允许「排队或次优」，取次优：
    // 熟手全忙即顺延下一位或新会话，活不过夜
    const veteran = input.gid ? this.pickVeteran(input.gid) : null;
    appendDispatch({ ts: Date.now(), id: dispatchId, tier, target: veteran ?? "spawn-pending", status: "dispatched", session_id: veteran ?? "", project_anchor: anchor });
    let sessionId: string;
    if (veteran) {
      try {
        this.resumeAgent(this.require(veteran), wrapDispatchPrompt(tier, input.prompt));
        sessionId = veteran;
      } catch (e) {
        // 熟手复活失败（理论窗口：并发竞态后 require 抛/新 agent 拉起即抛）：同 id
        // 降级记忆亲和新会话，台账收敛到 running 行（熟手不因此记 failed——
        // closeOpenDispatches 才收口，路由表无感）
        const msg = e instanceof Error ? e.message : String(e);
        this.pushExternalLog(veteran, "system", `熟手复活失败，本单降级新会话: ${msg}`);
        try {
          sessionId = this.create(anchor, wrapDispatchPrompt(tier, input.prompt), "acceptEdits", true, { skipStickyCwd: true });
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          appendDispatch({ ts: Date.now(), id: dispatchId, tier, target: "spawn-pending", status: "failed", receipt: truncate(`resume 失败(${msg}) 后新会话亦失败: ${msg2}`, 200), session_id: "", project_anchor: anchor });
          return { ok: false, error: `worker 拉起失败: ${msg2}` };
        }
      }
    } else {
      try {
        sessionId = this.create(anchor, wrapDispatchPrompt(tier, input.prompt), "acceptEdits", true, { skipStickyCwd: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendDispatch({ ts: Date.now(), id: dispatchId, tier, target: "spawn-pending", status: "failed", receipt: truncate(msg, 200), session_id: "", project_anchor: anchor });
        return { ok: false, error: `worker 拉起失败: ${msg}` };
      }
    }
    const s = this.sessions.get(sessionId);
    if (s) {
      s.state.project_gid = input.gid;
      s.state.dispatch_tier = tier;
    }
    if (input.gid) addMember(input.gid, sessionId, "worker");
    appendDispatch({ ts: Date.now(), id: dispatchId, tier, target: sessionId, status: "running", session_id: sessionId, project_anchor: anchor });
    this.pushOpenDispatch(sessionId, { id: dispatchId, tier, gid: input.gid, anchor });
    if (input.gid) {
      upsertBoardEntry(input.gid, {
        text: input.title?.trim() || input.prompt.split("\n")[0].slice(0, 60),
        status: "doing",
        owner_session: sessionId,
        dispatch_id: dispatchId,
      });
      this.emitBoard(input.gid);
    }
    if (input.title?.trim()) this.setTitleOverride(sessionId, `[${tier}] ${input.title.trim().slice(0, 40)}`);
    // 徽标帧：create 的 SESSION_CREATED 早于归属字段写入（同 tick 内），补一帧部分
    // 更新带上 project_gid/dispatch_tier（#93 教训：部分帧必随带 status/action_summary）
    if (s) {
      this.bus.emit(sessionId, "SESSION_UPDATED", {
        status: s.state.status,
        action_summary: s.state.action_summary,
        ...(s.state.project_gid ? { project_gid: s.state.project_gid } : {}),
        dispatch_tier: s.state.dispatch_tier,
      });
    }
    this.emitOrgState();
    return { ok: true, dispatch_id: dispatchId, session_id: sessionId };
  }

  // #26 M3 §5 查表选熟手：按 routingFor 调度偏好序（bad 沉底→熟练→最近）扫第一个
  // 可承接者。避开名单 = bad 评价｜失败≥2 且多于成功（未手动评 bad 时的兜底——
  // 「干砸的记一笔，下次避开或加强验收」）；不可承接 = 会话不在册/无 SDK 会话 id
  //（退休后只剩路由表记录——档案位，等记忆亲和新会话）｜在忙（WORKING/WAITING）｜
  // resume 互斥窗口（spawn→onInit 双拉风险）｜外部会话（用户终端自管，relay 不得
  // 抢拉）｜Leader 本人（兼管是分诊不是承接）。historical 不排除：重启收养态正是
  // resume 的目标形态（与用户消息复活路径同款）。
  private pickVeteran(gid: string): string | null {
    for (const e of routingFor(gid)) {
      if (e.rating === "bad") continue;
      if (e.failed >= 2 && e.failed > e.count) continue;
      const s = this.sessions.get(e.session_id);
      if (!s || !s.state.relay_session_id) continue;
      if (s.state.external) continue;
      if (s.state.status === "WORKING" || s.state.status === "WAITING") continue;
      if (s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) continue;
      if (this.isLeaderSession(e.session_id)) continue;
      return e.session_id;
    }
    return null;
  }

  // ---------- #26 M3 两层联动（§6.2：组挂起 → 成员会话全 parked；恢复 → 路由表拉原班） ----------

  // 组挂起的成员侧联动：只收**本组**的悬账（审查修正：同一熟手可跨多组，成员为
  // B 组在跑的回合不随 A 组挂起陪葬——矩阵式「项目×熟手」正交，组间互不越权）；
  // 本组无在跑派单后才停流退休（在忙他组活的成员跳过休眠，B 组回合自然收口后
  // 空闲入池）。中断≠干砸：台账 failed + 板退待办 + 路由表不记（挂起是用户决策，
  // 不写熟手的失败账）。会话留册休眠（org_parked 记来源组）：点开详情/发消息/
  // 复活后派单都拉得起来（消息路径 resumeAgent 天然复活）。
  private parkGroupMembers(gid: string): void {
    this.retireMembers(gid, "parked", "项目组挂起，回合中断");
  }

  // 组结项的成员侧联动（§2.2「结项 archived：编制解散」，审查修正补落）：本组
  // 悬账收口（中断口径）+ 停流 + 解除归属（project_gid/dispatch_tier 清空——列表
  // 归组/徽标随散，M2 注释承诺的「只解除归属」落地）；路由表档案永存（结项后
  // 熟手池仍可查历史）；编制快照留组内（headcount 不动，结项详情可查）
  private disbandGroupMembers(gid: string): void {
    this.retireMembers(gid, "disbanded", "项目组结项，编制解散");
  }

  // 挂起/结项成员收口共用（审查修正抽取）：reasonText = 中断回执文案
  private retireMembers(gid: string, mode: "parked" | "disbanded", reasonText: string): void {
    const g = findGroup(gid);
    if (!g) return;
    for (const h of g.headcount) {
      const s = this.sessions.get(h.session_id);
      if (!s || s.state.external || this.isLeaderSession(h.session_id)) continue;
      if ((this.openDispatches.get(h.session_id)?.length ?? 0) > 0) {
        this.closeOpenDispatches(h.session_id, "failed", reasonText, false, false, gid);
      }
      // 他组在跑派单残留 → 会话仍在干活，不退休不杀流（挂起标记也不打：它没随本组休眠）
      if ((this.openDispatches.get(h.session_id)?.length ?? 0) > 0) continue;
      this.retireSession(s, gid, mode);
    }
  }

  // 停流收口（挂起/结项共用）：gen 递增让旧流回调全让位（身份守卫）——停流后的
  // interrupted/ended 不产生假终态帧、不重复收口；进程树按 pid 补刀
  private haltSessionStream(s: ManagedSession): void {
    const old = s.agent;
    s.streamGen++;
    if (old?.childPid) {
      void this.watchdogProcs.killTree(old.childPid).catch(() => {});
    } else if (old && !old.ended) {
      void old.stop().catch(() => {});
      // #26 M3 审查修正：resumePending 窗口（spawn→onInit）内 childPid 尚未就位，
      // stop 大概率落空且此后无人补刀——孤儿 CLI 会带着派单 prompt 裸奔（组与板
      // 显示已挂起，文件照改）。窗口期后再补一刀；agent === old 守卫确保只杀这条
      // 流（期间被复活换了新流则不动）
      const sid = s.state.session_id;
      // M1/M2 审查轮（代际守卫）：本函数在调度后同步置 s.agent=null，「触发时
      // agent !== old」恒真（null 或复活后的新对象都 !== old）→ 原守卫是死代码、
      // 补刀一次都不会发。改看 streamGen（同 attach 回调 mine() 范式）：窗口内被
      // 复活换流则代际已递增，自然跳过——只补刀这条没被接管的旧流
      const gen = s.streamGen;
      const t = setTimeout(() => {
        if (this.sessions.get(sid)?.streamGen !== gen || old.ended) return;
        if (old.childPid) void this.watchdogProcs.killTree(old.childPid).catch(() => {});
        else void old.stop().catch(() => {});
      }, resumePendingWindowMs() + 1000);
      t.unref?.();
    }
    s.agent = null;
  }

  // 单会话收口（组挂起退休 / 结项解散共用）：parked = 留 org_parked 标记随组休眠
  //（板已冻结只读，卡片归组展示不变）；disbanded = 清归属。unacked 即弃（中断
  // 语义，防复活后看门狗恢复重放挂起前的旧指令）
  private retireSession(s: ManagedSession, gid: string, mode: "parked" | "disbanded"): void {
    this.haltSessionStream(s);
    if (mode === "parked") {
      s.state.org_parked = gid;
    } else {
      s.state.org_parked = undefined;
      s.state.project_gid = undefined;
      s.state.dispatch_tier = undefined;
    }
    s.state.status = "DONE";
    s.state.done_reason = mode === "parked" ? "项目组挂起（成员退休进熟手池）" : "项目组结项（编制解散）";
    s.state.action_summary = mode === "parked" ? "已随项目组挂起" : "已随项目组结项解散";
    s.state.waiting_request = undefined;
    s.state.last_error = undefined;
    s.state.updated_at = Date.now();
    s.unacked = [];
    s.resumePending = undefined;
    s.wd.phase = "idle";
    this.emitUpdated(s, true);
  }

  // 复活联动：只清 parked 标记，不主动拉会话——「恢复 = 任务板解冻 + 路由表拉
  // 原班」：下次派单 pickVeteran 按 count 偏好自然回到熟手（resume），零 eager spawn
  private reviveGroupMembers(gid: string): void {
    for (const s of this.sessions.values()) {
      if (s.state.org_parked !== gid) continue;
      s.state.org_parked = undefined;
      if (s.state.action_summary === "已随项目组挂起") s.state.action_summary = "";
      s.state.updated_at = Date.now();
      this.emitUpdated(s, true);
    }
  }

  // #26 M3 重启重建挂起标记（审查修正）：org_parked 是内存态、不进事件流——重启后
  // 组仍 parked（projects.json 持久）但成员标记全丢（熟手池 parked 口径失真 + auto-
  // revive 豁免失效）。boot 时按组状态反推补标：零 spawn（流本就不在了），纯标记
  // 复原；外部会话/Leader/已被消息复活（agent 在）的跳过
  rehydrateParkedMembers(): number {
    let n = 0;
    for (const g of listGroups()) {
      if (g.status !== "parked") continue;
      for (const h of g.headcount) {
        const s = this.sessions.get(h.session_id);
        if (!s || s.state.external || s.state.org_parked || s.agent || this.isLeaderSession(h.session_id)) continue;
        s.state.org_parked = g.id;
        this.emitUpdated(s, true);
        n++;
      }
    }
    return n;
  }

  // ---------- #26 M3 挂起自动化（§5 两周无活动 → 主动建议暂缓） ----------
  // 触发器：boot + 每小时扫描；窗口天数 CCR_ORG_STALE_DAYS 覆盖（默认 14，0=关）。
  // 幂等：已有待决 suggest-hold 单不重提；否决冷却 = hold_suggested_at 后再等一个
  // 窗口（手动建议同样戳记）。活度口径纯函数在 projects.ts findStaleGroups（时钟
  // 注入可单测）；本方法只做决议面（出确认卡——用户点头才挂，Leader 只提案）

  private staleDays(): number {
    const raw = process.env.CCR_ORG_STALE_DAYS;
    if (raw === undefined || raw === "") return 14; // 未设 = 默认两周（Number("")===0 坑）
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 14;
  }

  autoSuggestHold(now = Date.now()): { suggested: string[]; skipped: string[] } {
    const days = this.staleDays();
    const suggested: string[] = [];
    const skipped: string[] = [];
    if (days <= 0) return { suggested, skipped };
    const pendingGids = new Set(
      listPendingConfirms()
        .filter((c) => c.kind === "suggest-hold")
        .map((c) => (typeof c.payload.gid === "string" ? c.payload.gid : "")),
    );
    const cooldown = days * 86_400_000;
    // 成员会话活动（M3 审查修正补信号）：用户直驱推进（COMMAND_MESSAGE）不走派单/
    // 台账/板，组 updated_at 全静止——拿成员会话 updated_at 当第五路活度，天天被
    // 直驱开发的组不被误建议挂起
    const memberActivity: Record<string, number> = {};
    for (const s of this.sessions.values()) {
      const mgid = s.state.project_gid;
      if (!mgid || s.state.external) continue;
      if (s.state.updated_at > (memberActivity[mgid] ?? 0)) memberActivity[mgid] = s.state.updated_at;
    }
    for (const info of findStaleGroups(now, days, undefined, memberActivity)) {
      const g = findGroup(info.gid);
      if (!g) continue;
      if (pendingGids.has(info.gid) || (g.hold_suggested_at && now - g.hold_suggested_at < cooldown)) {
        skipped.push(info.gid);
        continue;
      }
      addConfirm({
        kind: "suggest-hold",
        title: `建议暂缓：${g.name}`,
        reason: `${info.idleDays} 天无活动（两周无活动触发器，§5 挂起自动化）——挂起后组员退休进熟手池释放编制，恢复时路由表拉回原班`,
        payload: { gid: info.gid, auto: true },
      });
      markHoldSuggested(info.gid, now);
      suggested.push(info.gid);
    }
    if (suggested.length) this.emitOrgState();
    return { suggested, skipped };
  }

  startStaleScan(): void {
    if (this.staleTimer || this.staleDays() === 0) return;
    try {
      this.autoSuggestHold();
    } catch {
      // 首扫失败不阻断 boot（org 目录异常等）；下一小时再来
    }
    this.staleTimer = setInterval(() => {
      try {
        this.autoSuggestHold();
      } catch {}
    }, 3_600_000);
    this.staleTimer.unref?.();
  }

  private require(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
  }

  private requireLive(sessionId: string): ManagedSession & { agent: AgentLike } {
    const s = this.require(sessionId);
    if (!s.agent) {
      throw new Error(
        s.state.external ? "外部会话不支持该命令（hooks 单向桥接）" : "历史会话不可操作（Relay 重启前遗留）",
      );
    }
    return s as ManagedSession & { agent: AgentLike };
  }

  // 外部会话远程决定后的收尾（清 WAITING、回 WORKING）；answered = PC 端本地已作答
  emitWaitingResolved(sessionId: string, requestId: string, decision: "allow" | "deny" | "answer" | "answered", by: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.state.status = "WORKING";
    s.state.waiting_request = undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(sessionId, "SESSION_WAITING_RESOLVED", { request_id: requestId, decision, by });
  }

  // at：本帧对应的真实活动时刻（水合/回放路径传入，缺省当下——#157，语义同 setTodos）
  private emitUpdated(s: ManagedSession, force: boolean, at?: number): void {
    const now = Date.now();
    if (!force && now - s.lastUpdateEmit < UPDATE_THROTTLE_MS) return;
    s.lastUpdateEmit = now;
    s.state.updated_at = at ?? now;
    this.bus.emit(s.state.session_id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      // 根治③的权威自愈通道：waiting_request 恒随增量帧携带（null = 已清），端上
      // 无论错过哪条 RESOLVED/WAITING，下一帧 UPDATE 即收敛一致
      waiting_request: s.state.waiting_request ?? null,
      stats: { ...s.state.stats },
      ...(s.state.turn_started_at ? { turn_started_at: s.state.turn_started_at } : {}),
      ...(s.state.usage ? { usage: { ...s.state.usage } } : {}),
      ...(s.state.context_usage !== undefined ? { context_usage: s.state.context_usage, context_limit: s.state.context_limit ?? contextLimitOf(s.state.model) } : {}),
      ...(s.state.todos ? { todos: s.state.todos.map((t) => ({ ...t })) } : {}),
      ...(s.state.subagents ? { subagents: s.state.subagents.map((x) => ({ ...x })) } : {}),
      ...(s.state.relay_session_id ? { relay_session_id: s.state.relay_session_id } : {}),
      ...(s.state.permission_mode ? { permission_mode: s.state.permission_mode } : {}),
      ...(s.state.cron_tasks ? { cron_tasks: s.state.cron_tasks.map((t) => ({ ...t })) } : {}),
      ...(s.state.compacting ? { compacting: true } : {}),
      // #49 置顶/休眠标记恒随增量帧显式携带布尔：saved 的清除点（恢复成功 onInit/
      // 幂等恢复）不在命令回执路径上，只在为真时携带会让其他在线端一直挂着休眠卡
      //（SNAPSHOT 恒为全量权威，这里保证增量也能实时收口）
      pinned: !!s.state.pinned,
      saved: !!s.state.saved,
      // last_task_done 不随增量帧下发（#254）：手机/网页都不消费该路径，只在
      // SNAPSHOT 里用于断线恢复，增量携带纯属带宽浪费
      // historical 增删必须实时下发：转录自愈/pid 对账解锁后，已连接的客户端
      // 要等到下次 SNAPSHOT 才能摘掉"仅可查看"——期间用户以为发不了消息
      historical: !!s.state.historical,
      // #157 载荷显式带 updated_at：客户端最后活跃时间以它为准（水合帧 ≠ 活动帧，
      // 信 envelope ts 会把重启时刻误当活动时刻）；旧客户端忽略此字段不受影响
      updated_at: s.state.updated_at,
    });
  }

  private heartbeat(): void {
    const now = Date.now();
    this.tickWatchdog(now);
    for (const s of this.sessions.values()) {
      if (s.state.status === "WORKING" || s.state.status === "WAITING") {
        this.bus.emit(s.state.session_id, "SESSION_HEARTBEAT", {
          elapsed_ms: now - s.state.started_at,
          action_summary: s.state.action_summary,
        });
      }
    }
  }

  // ===== #7 SDK 会话流中断看门狗 =====
  // 现状：relay 的既有看门狗全在 bridge（外部 CLI 会话滞留补发等），SDK 托管子会话
  // 零检测——流断后心跳照跳（心跳是 relay 侧定时器，与子进程健康无关），用户消息
  // 灌进死队列。本看门狗 = 时间窗起疑 + CPU 双采样防误杀 + 杀树重拉 + 防风暴。
  // 检测范围：仅托管（!external）且带活 agent 的 WORKING 会话。WAITING（等提问/
  // 审批是合法静默）、compacting（压缩期天然无流事件）、历史/休眠/外部一律不检测。
  // 进程树采不到 pid（childPid 缺失）时直接不起疑——无 CPU 证据不下杀手。
  private watchdogProcs: { snapshotTree: typeof snapshotTree; killTree: typeof killTree } = {
    snapshotTree,
    killTree,
  };

  /** 测试缝：注入 proc-tree 替身（null 还原真实实现） */
  setWatchdogProcs(p: { snapshotTree: typeof snapshotTree; killTree: typeof killTree } | null): void {
    this.watchdogProcs = p ?? { snapshotTree, killTree };
  }

  // 心跳同频扫描（5s）。双通道起疑：慢通道 = 任意静默 > T_stall（10min）；快通道 =
  // 最后进展是 tool_result（工具已完成，CLI 本该立刻接话）却静默 > 3min。命中即进
  // sampling 相位（同会话采样期间不重复起疑）。
  // pre-init 豁免：brand-new parked CLI（空提示词创建，#49）设计上零输出等待首条
  // stdin 消息（真实链路实证：干净 env 下 15s 零输出，sendMessage 后 init 立即到达）
  // ——init 未到（无 relay_session_id）且无未回显消息的静默是合法等待，不检测；
  // 但用户已发消息（unacked 非空）仍起疑：CLI 收不到消息也回不了显，僵死后无
  // sdkId 可恢复，走到 recover_fail → ERROR 至少把死局上屏（否则永远假"启动中"）
  tickWatchdog(now = Date.now()): void {
    if (watchdogDisabled()) return;
    for (const s of this.sessions.values()) {
      if (s.wd.phase !== "idle") continue;
      if (s.state.external || s.state.historical) continue;
      // #189 resume 互斥豁免：spawn→onInit 窗口内新流零输出是合法等待（CLI 冷启
      // 动数秒到数十秒），不按静默起疑
      if (s.resumePending && now - s.resumePending < resumePendingWindowMs()) continue;
      if (!s.agent || s.agent.ended) {
        // #189 ended 盲区接管：流已关闭但 status 钉在 WORKING（换流代际错位丢了
        // 回合结束帧 / 流半开早断），再没人发 SESSION_DONE——原实现直接 continue，
        // 会话永久假「工作中」（实测钉死 24 分钟零接管）。按慢通道阈值判死后走
        // 标准恢复流程：unacked 重放 resume / 无消息 parked 恢复；防风暴（1h 2 次
        // 上限）与杀树清活尸同样生效
        if (
          s.agent && s.agent.ended && s.state.status === "WORKING" &&
          s.state.relay_session_id && now - s.lastProgressAt > watchdogStallMs()
        ) {
          s.wd.phase = "sampling";
          const stalled = now - s.lastProgressAt;
          this.bus.emit(s.state.session_id, "WATCHDOG", { action: "stall_detected", lane: "ended", stalled_ms: stalled });
          void this.recoverFromStall(s, "ended", stalled, 0);
        }
        continue;
      }
      if (!s.agent.childPid) continue;
      if (!s.state.relay_session_id && s.unacked.length === 0) continue;
      if (s.state.status !== "WORKING" || s.state.compacting) continue;
      const stalled = now - s.lastProgressAt;
      const lane: "slow" | "fast" | null =
        stalled > watchdogStallMs()
          ? "slow"
          : s.lastProgressKind === "tool_result" && stalled > watchdogFastMs()
            ? "fast"
            : null;
      if (!lane) continue;
      s.wd.phase = "sampling";
      this.bus.emit(s.state.session_id, "WATCHDOG", { action: "stall_detected", lane, stalled_ms: stalled });
      void this.sampleAndJudge(s, lane, stalled);
    }
  }

  // 两轮整树 CPU 采样（间隔 CCR_WATCHDOG_SAMPLE_MS，默认 30s）：增量 ≥ 500ms = 树在
  // 真干活（长构建/长思考），误杀排除并后移锚点；增量 ≈ 0 = 僵死实锤，进恢复。
  // detached 后台任务已脱离进程树（孤儿化 ppid=1），不参与采样也不被杀——设计口径
  private async sampleAndJudge(s: ManagedSession, lane: "slow" | "fast", stalled: number): Promise<void> {
    const pid = s.agent?.childPid;
    if (!pid) {
      s.wd.phase = "idle";
      return;
    }
    try {
      // 锚点必须在采样前捕获：窗口内任何流回调（touch）都会改 lastProgressAt，
      // 事后取值会拿到"窗口内的新锚点"与自身比较，中止条件恒假——恢复进展的
      // 会话会被误杀（测试场景 C 钉死该语义）
      const anchorAtStart = s.lastProgressAt;
      const snap1 = await this.watchdogProcs.snapshotTree();
      const cpu1 = treeCpuMs(snap1, pid);
      await new Promise((r) => setTimeout(r, watchdogSampleMs()));
      // 采样期间恢复进展 / 状态翻走 / 会话被换：中止
      const snap2 = await this.watchdogProcs.snapshotTree();
      if (s.wd.phase !== "sampling" || s.lastProgressAt !== anchorAtStart) {
        if (s.wd.phase === "sampling") s.wd.phase = "idle";
        return;
      }
      if (!s.agent || s.agent.ended || s.state.status !== "WORKING") {
        s.wd.phase = "idle";
        return;
      }
      const cpu2 = treeCpuMs(snap2, pid);
      const delta = Math.max(0, cpu2 - cpu1);
      if (delta >= WATCHDOG_CPU_IDLE_DELTA_MS) {
        this.bus.emit(s.state.session_id, "WATCHDOG", { action: "cpu_active", lane, cpu_delta_ms: delta });
        // 锚点后移到当前：下轮从现在重新计时，不每 5s 重复起疑
        s.lastProgressAt = Date.now();
        s.lastProgressKind = ""; // 清指纹：tool_result 快通道用过了，下轮只剩慢通道
        s.wd.phase = "idle";
        return;
      }
      this.bus.emit(s.state.session_id, "WATCHDOG", {
        action: "zombie_confirmed",
        lane,
        stalled_ms: stalled,
        cpu_delta_ms: delta,
      });
      await this.recoverFromStall(s, lane, stalled, delta);
    } catch (e) {
      this.bus.emit(s.state.session_id, "WATCHDOG", {
        action: "recover_fail",
        lane,
        detail: `采样异常: ${e instanceof Error ? e.message : String(e)}`,
      });
      if (s.wd.phase !== "recovering") s.wd.phase = "idle";
    }
  }

  // 恢复：防风暴检查（1h 内已自愈 2 次 → 放弃：不杀树，转 WAITING + 黄框通知人工
  // 介入；流若回魂由 gaveUp 自愈翻回 WORKING）→ 杀树（SIGTERM→3s→SIGKILL）→ 等流
  // 收尾 → resume 重拉（带未回显消息重放；无消息则 parked 恢复停在等待输入）→
  // 时间线留"看门狗接管"。
  private async recoverFromStall(s: ManagedSession, lane: "slow" | "fast" | "ended", stalled: number, cpuDelta: number): Promise<void> {
    s.wd.phase = "recovering";
    const sid = s.state.session_id;
    const t0 = Date.now();
    const agent = s.agent;
    this.bus.emit(sid, "WATCHDOG", { action: "recover_start", lane, stalled_ms: stalled, cpu_delta_ms: cpuDelta });
    // #189 ended 通道：流已关（非 CPU 僵死），文案区分——用户看时间线不困惑
    this.pushExternalLog(
      sid,
      "system",
      lane === "ended"
        ? `看门狗接管：会话流已断开且 ${Math.round(stalled / 60000)} 分钟无进展（状态未收尾），正在自动恢复`
        : `看门狗接管：会话流已 ${Math.round(stalled / 60000)} 分钟无进展（进程树 CPU 空闲确认），正在自动恢复`,
    );
    try {
      // #109 防风暴检查前置到杀树之前：放弃 = 承诺停止干预，而杀树恰是最重的干预
      // ——误判时（网络长等待 CPU 空闲被判僵死）先杀后弃把活会话弄死，WAITING 钉死
      // 后只能人工重建。真僵尸不杀也无害：放弃态由 gaveUp 自愈守卫看住，手动消息
      // 触发的 resume 接管时会补刀旧树（无孤儿进程）
      const hourAgo = Date.now() - 3600_000;
      s.wd.recoveries = s.wd.recoveries.filter((t) => t > hourAgo);
      if (s.wd.recoveries.length >= 2) {
        this.bus.emit(sid, "WATCHDOG", { action: "gave_up", lane, detail: `1 小时内已自愈 ${s.wd.recoveries.length} 次` });
        s.wd.gaveUp = true;
        s.state.status = "WAITING";
        s.state.action_summary = "流中断，自动恢复已达上限";
        s.state.waiting_request = undefined;
        s.unacked = [];
        this.pushExternalLog(
          sid,
          "system",
          `流中断自动恢复已达上限（1 小时 ${s.wd.recoveries.length} 次），已停止自愈——请在电脑端检查 CLI，或手动发一条消息触发恢复；若会话仍在工作，显示会自动恢复`,
        );
        this.notifyConfirm(sid, `会话「${s.state.title || sid.slice(0, 8)}」流中断，自动恢复已达上限，请手动处理`);
        this.emitUpdated(s, true);
        s.wd.phase = "idle";
        return;
      }
      if (agent?.childPid) {
        await this.watchdogProcs.killTree(agent.childPid);
      }
      // 杀树后 SDK 流应关闭（pump finally → ended）；5s 未关则 force stop 兜底
      const deadline = Date.now() + 5000;
      while (agent && !agent.ended && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (agent && !agent.ended) {
        await agent.stop().catch(() => {});
      }
      s.wd.recoveries.push(Date.now());
      // #26 M3 审查修正：恢复流程是长异步（杀树数秒），窗口内会话可能已被组挂起/
      // 结项收口（retireSession 置 agent=null 退休休眠）——此刻不得起死回生（挂起=
      // 停流释放），放弃本次恢复
      if (!s.agent || s.state.org_parked) {
        this.bus.emit(sid, "WATCHDOG", { action: "recover_abandon", lane, detail: "会话已随项目组挂起/结项收口，放弃恢复" });
        s.wd.phase = "idle";
        return;
      }
      const pending = s.unacked;
      s.unacked = [];
      const sdkId = s.state.relay_session_id;
      if (!sdkId) throw new Error("无 SDK 会话记录（首次回合未完成即中断），无法自动恢复");
      if (pending.length > 0) {
        // 多条未回显消息拼一段重放（CLI 按顺序本就该都收到）；图片合并仍守 4 张上限。
        // M1 审查轮（漏收窗口）：N 条合并成 1 个重放回合，onTurnEnd 只收 FIFO 头
        // 1 单——其余 N-1 单的独立回合已不存在（合成回合代答），先按中断口径收掉。
        // 从尾收（尾单旋到头再出队）：头单=最老单保留本回合回执（FIFO 语义）
        for (let i = 1; i < pending.length; i++) {
          const q = this.openDispatches.get(s.state.session_id);
          if (!q || q.length <= 1) break;
          q.unshift(q.pop()!);
          this.closeOpenDispatches(s.state.session_id, "done", "多消息合并重放（并入同回合）", false, false, undefined, "todo");
        }
        const text = pending.map((m) => m.text).join("\n\n");
        const images = pending.flatMap((m) => m.images ?? []).slice(0, 4);
        this.resumeAgent(s, text, images.length ? images : undefined);
      } else {
        // M1 审查轮（漏收窗口）：reviveSaved 是 parked 恢复（停在等待输入，不再产
        // 生任何回合事件）——FIFO 里挂着的派单/咨询单永等不到 onTurnEnd，先按中断
        // 口径全清（回执写实；不写路由），否则 org status 挂假账直到下一条消息
        this.closeOpenDispatches(s.state.session_id, "done", "流中断恢复待命，回合中断", true, false);
        this.reviveSaved(s); // 无未回显消息：parked 恢复，停在等待输入
      }
      s.wd.phase = "idle";
      this.bus.emit(sid, "WATCHDOG", {
        action: "recover_ok",
        lane,
        detail: `恢复已派发（耗时 ${Date.now() - t0}ms），重放未回显消息 ${pending.length} 条`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.bus.emit(sid, "WATCHDOG", { action: "recover_fail", lane, detail: msg });
      s.state.status = "ERROR";
      s.state.last_error = `看门狗恢复失败: ${msg}`;
      s.state.waiting_request = undefined;
      this.pushExternalLog(sid, "system", s.state.last_error);
      this.emitUpdated(s, true);
      s.wd.phase = "idle";
    }
  }

  // 定时任务轮询：读各会话 cwd 下 .claude/scheduled_tasks.json，变化才下发。
  // 文件消失但此前有任务 → 视为清空（CLI 移除任务时可能直接删文件而非留空数组）；
  // "bad"（读到半截 JSON 等解析失败）→ 保留旧值等下一轮，避免误发清空再回填的闪烁
  private pollCronTasks(): void {
    for (const s of this.sessions.values()) {
      const tasks = readCronTasks(s.state.cwd);
      if (tasks === "bad") continue;
      const next = tasks ?? (s.state.cron_tasks ? [] : undefined);
      if (next === undefined) continue;
      const prev = s.state.cron_tasks ?? [];
      if (prev.length === 0 && next.length === 0) continue;
      if (cronTasksKey(prev) === cronTasksKey(next)) continue;
      s.state.cron_tasks = next;
      this.emitUpdated(s, true);
    }
  }

  // 权威任务清单轮询（#206）：直读 CLI 任务存储 ~/.claude/tasks/<cli_sid>/，
  // 托管（sdkId）与外部（hook session_id）统一覆盖；JSON 变更检测防重发。
  // bridge 的 transcript 旁路 tracker 降级为无目录时的回退，本轮询是主路径——
  // 陈旧快照/跨会话污染从源头消除（目录天然按会话隔离）
  private pollTaskStore(force = false): void {
    for (const s of this.sessions.values()) {
      if (s.state.historical) continue; // 历史会话无活跃目录，读到的只能是陈旧/噪音
      const sid = s.state.relay_session_id || (s.state.external ? s.state.session_id.slice(4) : "");
      if (!sid) continue;
      // last_task_done 2h TTL 清扫（#254）：与手机端恢复窗口同口径，过期摘除
      // 不再随快照携带（手表转发整 sessions，常驻大包白占帧）
      const ltd = s.state.last_task_done;
      if (ltd && Date.now() - ltd.ts > 2 * 3600_000) s.state.last_task_done = undefined;
      const todos = readTaskStoreTodos(sid);
      if (todos === null) continue;
      // 与 setTodos 同口径先滤隐藏条目：缓存/diff/TASK_DONE 都基于可见集，被隐藏任务完成不弹汇报
      const hidden = hiddenTodoKeys(s.state.session_id);
      const visible = hidden.size ? todos.filter((t) => !hidden.has(normKey(t.content))) : todos;
      const next = JSON.stringify(visible);
      const prevStr = this.lastStoreTodos.get(s.state.session_id);
      if (!force && prevStr === next) continue;
      this.lastStoreTodos.set(s.state.session_id, next);
      // 任务完成汇报（#204）：前快照未完成 → 后快照已完成的项即本次完成。
      // 首见（prevStr 空，冷启动/SNAPSHOT 重建）不报，避免重启刷一屏假完成。
      // #393 补充：创建+完成落在同一轮询窗（30s）内的任务，首见时已是 completed——
      // 此前被上面"首见不报"一并吞掉，TASK_DONE 几乎不触发（悬浮框长期沉默根因）。
      // 会话已在轮询中（prevStr 存在）时，本轮新出现且已完成、且 updated_at 距今
      // 10 分钟内的条目按完成上报；无近期 mtime 的历史完成条目（resume 场景）仍不报
      if (prevStr) {
        try {
          const prev = JSON.parse(prevStr) as TodoItem[];
          const prevByContent = new Set(prev.map((t) => t.content));
          const prevOpen = new Set(prev.filter((t) => t.status !== "completed").map((t) => t.content));
          const done = visible
            .filter(
              (t) =>
                t.status === "completed" &&
                (prevOpen.has(t.content) ||
                  (!prevByContent.has(t.content) && typeof t.updated_at === "number" && Date.now() - t.updated_at < 10 * 60_000)),
            )
            // #160 汇报条目前缀任务编号（有 id 才带）：与时间线生命周期行同口径，
            // 不展开任务面板也能对上号
            .map(taskDoneLabel);
          if (done.length) {
            // 汇报同时记入会话状态（#254）：TASK_DONE 瞬态事件在客户端断线/进程被杀时
            // 丢失，落状态后 SNAPSHOT 可恢复未读汇报（端上按 ts 与已清除位去重）。
            // 状态里 done 截断 10 条与手机队列口径一致（事件 payload 保持全量供网页展示）
            const report = {
              done: done.slice(0, 10),
              remaining_count: visible.filter((t) => t.status !== "completed").length,
              ts: Date.now(),
            };
            s.state.last_task_done = report;
            this.bus.emit(s.state.session_id, "TASK_DONE", {
              done,
              remaining: visible.filter((t) => t.status !== "completed"),
              ts: report.ts,
            });
          }
        } catch {}
      }
      this.setTodos(s.state.session_id, todos);
    }
  }

  private lastStoreTodos = new Map<string, string>();

  private evictOldSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const finished = [...this.sessions.values()]
      // #49 置顶会话豁免驱逐：置顶的意义就是跨重启存活，容量满时先挤普通会话
      .filter((s) => (s.state.status === "DONE" || s.state.status === "ERROR") && !s.state.pinned)
      .sort((a, b) => a.state.started_at - b.state.started_at);
    for (const s of finished) {
      if (this.sessions.size < MAX_SESSIONS) break;
      void s.agent?.stop(); // 回收 parked 的 CLI 子进程（历史会话无 agent）
      this.sessions.delete(s.state.session_id);
      this.lastStoreTodos.delete(s.state.session_id);
    }
  }

  private cloneState(s: ManagedSession): SessionState {
    return JSON.parse(JSON.stringify(s.state)) as SessionState;
  }
}

// #26 M2 派单纪律 prompt 前缀（§4 随手办三件套 + §3.5 过程不回灌只收回执）：
// 三件套 = ①完成回一行结果+改动文件（回执）②commit 归属 [档位] 前缀 ③派单记录
// 留台账（由 dispatchWorker 自动落）。worker 会话首条输入即此包装，纪律随 cwd
// 的项目 CLAUDE.md（防漂移种子）双层生效。导出供测试断言。
export function wrapDispatchPrompt(tier: string, task: string): string {
  return `[${tier} 派单]
${task}

—— 派单纪律（矩阵式组织 §3.5 / §4）——
- 过程不回灌，只收回执：不逐动作汇报，结束才回。
- 改前认领：动文件前先一句说明要改哪些文件；改后报 diff 摘要（改了什么、几处）。
- commit 归属：提交信息以 [${tier}] 开头并描述任务；无提交环节的任务可省略。
- 完成回执：最后一行固定格式「结果：<一行结果>｜改动文件：<文件列表或无>」。
- 零确认直做（权限 acceptEdits）；发现超范围事项，回报而非扩权。`;
}
