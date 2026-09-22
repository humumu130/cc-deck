// hooks 桥接：用户自开 CLI 会话（外部会话）事件路由 + 远程审批挂起 + 终端按键注入
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { BridgeEvent, PendingInput, WaitingPayload, TodoItem, SubagentInfo, AskQuestion } from "./types.js";
import { injectText, injectEsc, injectEnter, ensureInjector, injectSupported, captureConsoleBottom, cliHostAlive, resumeSession } from "./injector.js";
import { guardConfig, guardCompensateEnter } from "./type-guard.js";
import {
  addHiddenTodoKey,
} from "./todo-hidden.js";
import {
  buildAnswerMessage,
  capDetail,
  detailToolResult,
  detailToolUse,
  diffLines,
  fileEditMetrics,
  fullText,
  normKey,
  parseAskQuestions,
  summarizeToolResult,
  summarizeToolUse,
  splitZaiText,
  TaskTracker,
  truncate,
  zaiToolName,
  isZaiOutput,
  isMachineUserText,
  stripLeadingSystemBlocks,
} from "./summarizer.js";
import { deriveTitle } from "./history.js";
import { readTaskStoreTodos } from "./task-store.js";
import { saveUploadImages, saveUploadFiles, type UploadBlob } from "./uploads.js";

export interface BridgeOptions {
  gateTools: Set<string>;          // 远程审批门控的工具名
  hasClients: () => boolean;       // 当前是否有 WS 客户端在线（手机在线才拦截）
  holdMs?: number;                 // PreToolUse 最长挂起（默认 590s，须 < hook 脚本内部 600s < settings timeout 620s）
  questionHoldMs?: number;         // AskUserQuestion 挂起窗口（默认 90s；超时放行 CLI 本地选择器）
  dataDir: string;                 // pid 缓存所在数据目录（与 hook 单源对齐：插件形态 ~/.cc-deck/data，dev 形态 <repo>/data）
}

export interface BridgeDecision {
  decision: "allow" | "deny" | "pass";   // pass = 不干预，CLI 走正常权限流程
  reason?: string;
  updatedInput?: Record<string, unknown>; // allow 时改写工具入参（AskUserQuestion 答案注入）
}

interface Pending {
  sessionId: string;
  requestId: string;
  resolve: (d: BridgeDecision) => void;
  timer: NodeJS.Timeout;
  questions?: AskQuestion[];               // AskUserQuestion：原问题（作答时回显进 updatedInput）
  toolInput?: Record<string, unknown>;     // AskUserQuestion：原始 tool_input
}

// transcript 里一次任务工具操作（use 或已配对的 result）
type TaskOp = { tool?: string; input?: unknown; result?: { task: { id: number } } };

// 排队消息的对账键：带图消息的展示回显（text）与注入全文（body）不同，CLI 侧一切
// 回流文本都是 body 形态——匹配一律取 body（见 PendingInput 注释）
function pBody(p: PendingInput): string {
  return p.body ?? p.text;
}

// transcript 首条记录的时间戳（ISO 字符串）——孤儿收养时的真实会话起点（#321）；
// 只读首 4KB，解析失败返回 0（回落 ensureExternal 的 Date.now()）
function transcriptFirstTs(p: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    const line = buf.toString("utf-8", 0, n).split("\n")[0];
    const ts = line ? (JSON.parse(line) as { timestamp?: string }).timestamp : undefined;
    const t = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

const DEFAULT_HOLD_MS = 590_000;
const QUESTION_HOLD_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #65 CLI 自写会话状态文件（~/.claude/sessions/<pid>.json）的 status 探针：
// "idle"=CLI 空闲（回合结束的权威信号，hook 无关）；busy/缺失/读失败=false。
// 只在 WORKING 高疑会话（静默 90s+）上调用，频次低
function cliSessionIdle(pid: number): boolean {
  try {
    const f = path.join(homedir(), ".claude", "sessions", `${pid}.json`);
    const d = JSON.parse(readFileSync(f, "utf-8")) as { status?: string };
    return d.status === "idle";
  } catch {
    return false;
  }
}

// CLI 状态原文（busy/idle）：外部会话状态的权威信号——CLI 自己说在忙就是忙，
// 说空闲（且转录静默防抖）就是空闲。5s 轮询逐会话消费（pollCliStatus）
function cliSessionStatus(pid: number): string | null {
  try {
    const f = path.join(homedir(), ".claude", "sessions", `${pid}.json`);
    const d = JSON.parse(readFileSync(f, "utf-8")) as { status?: string };
    return typeof d.status === "string" ? d.status : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // Windows 上他人进程也报 EPERM，视作存活
  }
}

export class Bridge {
  private pending = new Map<string, Pending>();   // ext session_id -> 挂起中的一次审批（CLI 工具串行，一会话最多一个）
  private turnStart = new Map<string, number>();  // ext session_id -> 本回合开始时间
  private inputQueue = new Map<string, string[]>(); // ext session_id -> 排队中的输入（忙时攒，回合结束注入）
  private flushing = new Set<string>();           // 正在逐条注入的会话（防并发交错）
  private named = new Set<string>();              // 已取到 CC 会话名的外部会话
  private nameMisses = new Map<string, number>(); // 取名失败计数（超过 8 次放弃，避免每事件扫目录）
  private transcriptPaths = new Map<string, string>();  // ext id -> transcript JSONL（排队消息轮询）
  private recentUserMsgs = new Map<string, Map<string, { ts: number; via: "promote" | "prompt" }>>(); // ext id -> 归一化文本 -> 最近记录（via：晋升回显 / PC 手敲 prompt）
  private escMarkedAt = new Map<string, number>(); // ext id -> 最近一次 Esc 注入成功时间（乐观置 DONE 的自我纠正窗口）
  private queuePollTimer: NodeJS.Timeout | null = null;
  private healTimer: NodeJS.Timeout | null = null;
  private extFileStats = new Map<string, { files: Set<string>; added: number; deleted: number }>();
  private extUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; model: string; ctx: number }>();
  // 排队消息滞留看门狗：ext id -> { 最近补发时间, 连续补发次数, 连续跳过次数, 是否已放弃 }
  private stuckWatch = new Map<string, { lastTry: number; tries: number; skips: number; given_up: boolean }>();
  // 防抢发守门进行中的会话（等待人工停手期间，看门狗节拍跳过防重入）
  private stuckGuarding = new Set<string>();
  // #111 注入后主动验证：ext id -> { 定时器, 最后注入的文本 }。注入成功 ≠ 提交成功
  //（回车被 TUI 重渲吞掉），不被动等 10s 看门狗——3s 后快照确认，仍滞留输入框即守门补发
  private verifyTimers = new Map<string, { timer: NodeJS.Timeout; text: string }>();
  private subagentSeq = 0; // hook 未带 tool_use_id 时的合成 id 序号（ag-N）
  private askFallback = new Map<string, { requestId: string; questions: AskQuestion[] }>(); // 提问超时放行本地选择器后的兜底（手机晚答仍可送达）
  // 无 hook 会话（CLI 早于插件启动，无 Stop/UserPromptSubmit 事件）：
  // 转录在 DONE 态仍在增长即翻 WORKING，静默 25s 视作回合结束——状态显示与排队消息
  // 注入不再依赖 90s 看门狗兜底
  private noHookIds = new Set<string>();
  private lastGrow = new Map<string, number>();
  // ext id -> 最近一次 hook 事件到达时间（#211 空闲兜底的时钟之一：
  // Stop 上报被 403 丢弃时无任何事件到达，转录也不再增长 → 判定 CLI 实际空闲）
  private lastHookAt = new Map<string, number>();

  // 看门狗/子 Agent TTL 阈值（env 可调：测试用短值，生产默认 90s/60s/10min/30min）
  private readonly stuckAfterMs: number;
  private readonly stuckRetryMs: number;
  private readonly subagentEndTtlMs: number;
  private readonly subagentRunTtlMs: number;
  // 恢复会话闭环（2026-09-18 公司机报障）：spawn 成功 ≠ 恢复进程上线。窗口期内
  // 滞留看门狗对会话持袖旁观（补回车只会打进旧 CLI 空输入框）；窗口到期/闭环判定
  // 未上线则解除，下条消息可重试恢复
  private resumeClosures = new Map<string, NodeJS.Timeout>();

  // hook 侧 pid 缓存路径必须与 bridge-hook.mjs 的 dataDir 判定一致，
  // 否则插件形态下（bundle 在插件缓存目录）按模块路径解析会读错文件，
  // relay 重启后 cli_pid 补水失效、远程发消息全被拒
  private pidCacheFile = "";

  // 恢复窗口/上线校验阈值：运行时读 env（测试中途可调，同 guardConfig 惯例）
  private get resumeWindowMs(): number {
    return Number(process.env.CCR_RESUME_WINDOW_MS) > 0 ? Number(process.env.CCR_RESUME_WINDOW_MS) : 120_000;
  }
  private get resumeVerifyMs(): number {
    return Number(process.env.CCR_RESUME_VERIFY_MS) > 0 ? Number(process.env.CCR_RESUME_VERIFY_MS) : 45_000;
  }

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private opts: BridgeOptions,
  ) {
    this.pidCacheFile = path.join(opts.dataDir, "cli-pids.json");
    this.stuckAfterMs = Number(process.env.CCR_STUCK_AFTER_MS) > 0 ? Number(process.env.CCR_STUCK_AFTER_MS) : 90_000;
    this.stuckRetryMs = Number(process.env.CCR_STUCK_RETRY_MS) > 0 ? Number(process.env.CCR_STUCK_RETRY_MS) : 60_000;
    this.subagentEndTtlMs = Number(process.env.CCR_SUBAGENT_END_TTL_MS) > 0 ? Number(process.env.CCR_SUBAGENT_END_TTL_MS) : 10 * 60_000;
    this.subagentRunTtlMs = Number(process.env.CCR_SUBAGENT_RUN_TTL_MS) > 0 ? Number(process.env.CCR_SUBAGENT_RUN_TTL_MS) : 30 * 60_000;
    this.hydratePidsFromCache();
    this.reconcilePidsFromSessions();
    this.healExternal();
    this.adoptOrphans();
    // 自愈 + 孤儿扫描：60s 一轮，也兜住运行期间任何来源的误标（不止重启重放）
    this.healTimer = setInterval(() => {
      this.hydratePidsFromCache();
      this.reconcilePidsFromSessions();
      this.healExternal();
      this.adoptOrphans();
      this.sweepIdleArchive();
    }, 60_000);
    this.healTimer.unref?.();
  }

  // #50 idle 归档：DONE 且长时间（默认 12h，CCR_IDLE_ARCHIVE_MS 可调）无事件无增长的
  // ext 会话标 historical（沉底降权 + 旧端仅查看）。同 cwd 挂着旧终端的会话不再
  // 跟当前工作会话抢列表焦点（用户实测「CC-watch-ba」旧身挂了一天双显示）。
  // 回到那个终端继续用时，hook 事件/转录增长路径自动翻活（清 historical）
  private sweepIdleArchive(): void {
    const idleMs = Number(process.env.CCR_IDLE_ARCHIVE_MS) > 0 ? Number(process.env.CCR_IDLE_ARCHIVE_MS) : 12 * 3600_000;
    const now = Date.now();
    for (const s of this.mgr.snapshot()) {
      if (!s.external || s.historical || s.status !== "DONE") continue;
      const last = Math.max(s.updated_at ?? 0, this.lastHookAt.get(s.session_id) ?? 0);
      if (!last || now - last < idleMs) continue;
      const st = this.mgr.getExternal(s.session_id);
      if (st) st.historical = true;
    }
  }

  // 外部会话 ERROR 自愈：外部 CLI 是独立进程，relay 重启/重放把它标成 ERROR 属误伤
  // （空闲 ext 会话没有 hook 事件来翻状态，就永久锁死在"错误"）。pid 仍在跑 → 翻回
  // WORKING；pid 已死则维持 ERROR（真终态）。注入失败自愈链（onInjectFail）会在
  // pid 失效时清掉定位，与这里不冲突。
  private healExternal(): void {
    for (const s of this.mgr.snapshot()) {
      if (!s.external || s.status !== "ERROR" || !s.cli_pid) continue;
      if (!pidAlive(s.cli_pid)) continue;
      const st = this.mgr.getExternal(s.session_id);
      if (st?.historical) st.historical = false; // 恢复可操作（ensureExternal 的 adopt 路径同款语义）
      this.mgr.setExternalStatus(s.session_id, "WORKING", "自愈：CLI 进程仍在运行");
      this.mgr.pushExternalLog(s.session_id, "system", "检测到误标错误（CLI 进程仍在运行），已自动恢复为运行中");
    }
  }

  // 孤儿扫描：CLI 早于插件安装/启动（或 hook 未注册）的外部会话永远不发事件，
  // 手机上完全不可见。扫 ~/.claude/projects/*/*.jsonl 找 30 分钟内活跃、
  // 不归 relay 管（托管 relay_session_id / 一次性子会话）、也非已注册 ext 的 transcript，
  // 收养为只读外部会话——无 pid 不能注入，但列表可见 + transcript 文本照常轮询桥接；
  // 该 CLI 重启后 hook 生效即获得完整功能
  private adoptOrphans(): void {
    try {
      const root =
        process.env.CCR_PROJECTS_ROOT ?? path.join(homedir(), ".claude", "projects");
      const cutoff = Date.now() - 30 * 60_000;
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        let files: string[];
        try {
          files = readdirSync(path.join(root, dir.name));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const sid = f.slice(0, -6);
          if (!/^[0-9a-f-]{8,64}$/i.test(sid)) continue;
          const id = "ext-" + sid;
          const p = path.join(root, dir.name, f);
          if (this.mgr.getExternal(id)) {
            // 已注册外部会话：relay 重启后 transcriptPaths 是纯内存的会丢（外部会话的
            // relay_session_id 同时命中 ownsCliSession，必须先走这个分支补挂，否则
            // 重启后文本桥接永久失效——曾致手机只看得到系统日志看不到正文）
            if (!this.transcriptPaths.has(id)) {
              this.transcriptPaths.set(id, p);
              this.ensureQueuePoll();
            }
            continue;
          }
          if (this.mgr.ownsCliSession(sid)) continue; // 托管会话/一次性子会话：不收养
          if (this.mgr.isDeletedExt(id)) continue; // 手机删过的：墓碑拦截，防复活
          let mtime: number;
          try {
            mtime = statSync(p).mtimeMs;
          } catch {
            continue;
          }
          if (mtime < cutoff) continue;
          // 太新鲜的也跳过：title-gen 子会话从 transcript 落盘到 onSid 登记有 ~1s 窗口，
          // 这里的文件下一轮（60s 后）仍会被扫到，不损失发现速度
          if (mtime > Date.now() - 15_000) continue;
          const cwd = this.readCwdFromTail(p);
          if (!cwd) continue;
          // 起标题子会话指纹（#283）：首条 user prompt 是 relay 自己的命名指令——
          // 历史 title-gen 转录（cwd=relay 进程目录）已被 .tmp- 护栏之前的版本落盘，
          // 靠 registry（重启/换形态丢失）挡不住，指纹是形态无关的最终防线
          if (this.isTitleGenTranscript(p)) continue;
          // relay 自测探针指纹（#67）：test-ws 的 COMMAND_CREATE 探针历史用仓库根
          // 目录当 cwd（transcript 落全局 projects，无 .tmp- 段又是多回合，上述护栏
          // 全漏过），被生产 relay 收养成一排「relay」同名卡且 journal 回放永久复活
          if (this.isTestProbeTranscript(p)) continue;
          // 测试沙箱不收养：relay 自测（test:sessions 等）在 .tmp-test 起真实 SDK 会话，
          // transcript 落全局 projects 目录，不拦就以孤儿身份混进手机会话列表（#269）。
          // Windows 路径大小写不敏感，段比较需 lower（手工建 .TMP-TEST 会让护栏静默失效）
          // .tmp- 前缀泛化：.tmp-test 沙箱 + .tmp-titlegen 起标题子会话（#283）
          if (cwd.split(/[\\/]+/).some((seg) => seg.toLowerCase().startsWith(".tmp-"))) continue;
          // 单发探针/一次性 print 模式 CLI（单回合无追问）不值得监控：user<2 且
          // 无工具调用时观察一轮文件增长再定（见 scanOrphanActivity 注释）；
          // 仍在增长 → 穿透收养，否则记探针等下一轮
          const act = this.scanOrphanActivity(p);
          if (!act.adopt) {
            const prev = this.orphanProbe.get(p);
            if (prev === undefined || act.size <= prev.size) {
              this.orphanProbe.set(p, { size: act.size, ts: Date.now() });
              if (this.orphanProbe.size > 200) {
                for (const [k, v] of this.orphanProbe) {
                  if (Date.now() - v.ts > 30 * 60_000) this.orphanProbe.delete(k);
                }
              }
              continue;
            }
          }
          this.mgr.ensureExternal(id, cwd, "", sid, transcriptFirstTs(p));
          this.transcriptPaths.set(id, p);
          this.mgr.setExternalStatus(id, "DONE", "扫描接入（只读）");
          this.mgr.pushExternalLog(
            id,
            "system",
            "孤儿扫描接入：该 CLI 启动早于插件或未加载 hook，事件无法上报；当前只读可见，重启该 CLI 后获得完整功能",
          );
          this.ensureQueuePoll();
          console.log(`[orphan-adopt] ${id} cwd=${cwd}`);
        }
      }
    } catch {}
  }

  // 从 transcript 尾部抓 cwd（CC 每条记录都带 cwd）：只读末 8KB，避免大文件全量 IO；
  // 首行可能是被截断的半行，JSON.parse 失败自然跳过
  private readCwdFromTail(p: string): string {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      const size = statSync(p).size;
      const len = Math.min(size, 8192);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf-8").split("\n").reverse();
      for (const line of lines) {
        const i = line.indexOf("{");
        if (i < 0) continue;
        try {
          const j = JSON.parse(line.slice(i)) as { cwd?: unknown };
          if (typeof j.cwd === "string" && j.cwd) return j.cwd;
        } catch {}
      }
      return "";
    } catch {
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // 起标题子会话转录识别：只读文件头 4KB 找命名指令指纹（latin1 子串匹配，中文
  // prompt 经 JSON 转义后 UTF-8 字节序列不变，latin1 视图下按字节序列命中）
  // transcript 头 4KB 含指定串：探针/指纹类护栏共用（首条 user prompt 必在头部，
  // 只读头不全量 IO，与 readCwdFromTail 同开销量级）
  private transcriptHeadHas(p: string, needle: string): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      return buf.subarray(0, n).includes(needle);
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private isTitleGenTranscript(p: string): boolean {
    return this.transcriptHeadHas(p, "起一个简短的中文标题");
  }

  // #67 relay 自测探针指纹：.tmp- cwd 护栏之外形态无关的兜底——探针会话无论在
  // 哪个 cwd 起（历史事故：test-ws 用仓库根目录），只要首条 prompt 命中指纹就不
  // 收养。改测试探针文案务必同步这里，两处是约定联动
  private static readonly TEST_PROBE_MARKS = [
    "请直接回复两个字：收到", // test-ws COMMAND_CREATE 探针（真实 CLI 落 transcript）
    "请直接回复四个字：好的收到", // test-sessions 探针（.tmp- 沙箱内，双保险）
  ];

  private isTestProbeTranscript(p: string): boolean {
    return Bridge.TEST_PROBE_MARKS.some((m) => this.transcriptHeadHas(p, m));
  }

  // 孤儿候选交互性判定 + 文件大小（供"增长观察"用）。流式分块扫全文件，64KB 块 +
  // 1KB carry 防跨界漏匹配；非末块的末 1KB 区域命中留给下一块计（避免重复计数），
  // 只对孤儿候选（新发现、mtime 30min 内）执行，频次低。
  // user≥2 → 收养（多回合；含工具结果回填的 user 行）。
  // user=1 且 tool_use≥1 → 也收养（2026-09-16）：首回合已调工具（终端里等权限确认
  //   时 transcript 恰好只有 1 user + 1 assistant，旧版硬性 ≥2-user 门槛让它永远
  //   不收养——公司 Windows 机器"新会话几分钟不接入"根因）。一次性 print 若带工具
  //   会被误收养，代价仅一张只读卡片（可删），可接受。
  // 其余（纯文本首回合 / claude -p 单发）：不收养，返回 size 供调用方观察增长——
  //   活跃会话下一轮必然变长，-p 单发不会。
  private orphanProbe = new Map<string, { size: number; ts: number }>();

  private scanOrphanActivity(p: string): { adopt: boolean; size: number } {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      const size = statSync(p).size;
      const chunk = 64 * 1024;
      const buf = Buffer.alloc(chunk + 1024);
      let carry = Buffer.alloc(0);
      let users = 0;
      let toolUse = 0;
      const reUser = /"type":\s*"user"/g;
      const reTool = /"type":\s*"tool_use"/g;
      const countIn = (text: string, limit: number, re: RegExp): number => {
        let n = 0;
        re.lastIndex = 0;
        for (let m = re.exec(text); m && m.index < limit; m = re.exec(text)) n++;
        return n;
      };
      for (let pos = 0; pos < size; ) {
        const len = readSync(fd, buf, 0, chunk, pos);
        if (len <= 0) break;
        pos += len; // 按实际读取推进（防短读跳字节）
        const isLast = pos >= size;
        const text = Buffer.concat([carry, buf.subarray(0, len)]).toString("latin1");
        const limit = isLast ? text.length : text.length - 1024;
        users += countIn(text, limit, reUser);
        toolUse += countIn(text, limit, reTool);
        carry = Buffer.from(text.slice(-1024), "latin1");
      }
      return { adopt: users >= 2 || (users >= 1 && toolUse >= 1), size };
    } catch {
      return { adopt: false, size: 0 };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // Relay 重启后内存里的 cli_pid 丢了，而空闲终端不会有新 hook 事件来恢复；
  // 从 hook 侧缓存文件补回（key=CLI session_id，CLI 存活期不变）
  private hydratePidsFromCache(): void {
    try {
      const cache = JSON.parse(readFileSync(this.pidCacheFile, "utf-8")) as Record<string, number>;
      for (const s of this.mgr.snapshot()) {
        if (!s.external || s.cli_pid) continue;
        const pid = cache[s.relay_session_id || s.session_id.slice(4)];
        if (pid) this.mgr.setExternalCliPid(s.session_id, pid);
      }
    } catch {}
  }

  // hook 侧 pid 缓存有不存在的窗口（hook 死亡后无人写、dataDir 换代后从未写过）——
  // 2026-09-04 下午事故：cli-pids.json 缺失 8 小时，daemon 每次重启 pid 补水无源，
  // 手机发消息被"尚未定位 CLI 进程"拒绝 2h40m。CLI 自写的 ~/.claude/sessions/<pid>.json
  //（sessionId→name）是 hook 无关的权威源：按会话 id 对上即补定位；只在会话无 pid
  // 或现有 pid 已死时才写（不覆盖活的），陈旧 sessions 文件靠 pid 存活校验兜底。
  // 补定位顺带清 historical：活 pid 即会话真实存活的证明。
  private reconcilePidsFromSessions(): void {
    try {
      const dir = process.env.CCR_SESSIONS_ROOT || path.join(homedir(), ".claude", "sessions");
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        return;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const pid = Number(f.slice(0, -5));
        if (!Number.isInteger(pid) || pid <= 0) continue;
        let sid = "";
        try {
          const d = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as { sessionId?: string };
          if (typeof d.sessionId === "string" && d.sessionId) sid = d.sessionId;
        } catch {}
        if (!sid || !Bridge.pidAlive(pid)) continue;
        for (const s of this.mgr.snapshot()) {
          if (!s.external) continue;
          if (s.cli_pid && Bridge.pidAlive(s.cli_pid)) continue;
          const key = s.relay_session_id || s.session_id.slice(4);
          if (key !== sid) continue;
          this.mgr.setExternalCliPid(s.session_id, pid);
          const st = this.mgr.getExternal(s.session_id);
          if (st?.historical) {
            st.historical = false;
            this.mgr.pushExternalLog(s.session_id, "system", "已通过 CLI 会话信息恢复进程定位（自愈）");
          }
          this.mgr.emitExternalSync(s.session_id);
        }
      }
    } catch {}
  }

  private static pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async handleEvent(ev: BridgeEvent): Promise<BridgeDecision> {
    // 测试沙箱事件直接放行不建档：relay 自测（test:sessions 等）的 SDK 子进程会加载
    // 全局 hook 把事件发给生产 relay，不拦就以真实会话身份混进手机列表（#269；
    // 孤儿收养侧 adoptOrphans 另有同款护栏，两路都堵才断根）
    if ((ev.cwd ?? "").split(/[\\/]+/).some((seg) => seg.toLowerCase().startsWith(".tmp-"))) return { decision: "pass" };
    // hook 事件到达即证明该会话有 hook：从无 hook 疑似名单除名（回合首条转录写入
    // 早于 UserPromptSubmit POST 到达的竞态窗口里可能被 5s tick 误登记，长工具
    // 静默期会被 sweepNoHookIdle 误判回合结束）
    this.noHookIds.delete(this.extId(ev));
    this.lastHookAt.set(this.extId(ev), Date.now());
    const decision = await this.dispatch(ev);
    // 分发后捕获：新会话的首个事件（UserPromptSubmit/PreToolUse）在 handler 内才 ensureExternal
    if (ev.cli_pid && ev.cli_pid > 0) {
      const id = this.extId(ev);
      // #50（2026-09-11 用户实测）compact 换代归档：CLI /compact 后续接会开新
      // session_id（进程不变、无 SessionEnd），旧 ext 会话永久残留——同一台
      // CLI 在手机/桌面显示成两个会话（「CC-watch-ba」+「0.4.3 memory 恢复点
      // 接力」实录）。同 cli_pid 的其他 ext 会话 = 换代前旧身，立即归档收尾
      for (const s of this.mgr.snapshot()) {
        if (!s.external || s.session_id === id || s.cli_pid !== ev.cli_pid) continue;
        this.mgr.finishExternal(s.session_id, "completed", 0);
        const old = this.mgr.getExternal(s.session_id);
        if (old) old.historical = true; // 旧端仅可查看语义 + #32 离线降权视觉
        this.mgr.pushExternalLog(s.session_id, "system", "上下文已压缩，续接为新会话（本条目归档）");
      }
      this.mgr.setExternalCliPid(id, ev.cli_pid);
    }
    if (ev.transcript_path) {
      this.transcriptPaths.set(this.extId(ev), ev.transcript_path);
      this.ensureQueuePoll();
      // #361 任务清单时效：TodoWrite/Task 系列 PostToolUse 到达即读转录增量
      //（含 taskOps 解析→setTodos），不等 5s 轮询节拍
      if (ev.event === "PostToolUse" && /^(TodoWrite|TaskCreate|TaskUpdate)$/.test(ev.tool_name ?? "")) {
        this.pushAssistantTexts(this.extId(ev), ev.transcript_path);
      }
    }
    this.correctEscMark(this.extId(ev), ev);
    // #363 任何新事件都意味着压缩已结束（压缩后继续回合 → 新 prompt/工具事件）；
    // PreCompact 自身是置位事件不清
    if (ev.event !== "PreCompact") this.mgr.setExternalCompacting(this.extId(ev), false);
    return decision;
  }

  // Esc 乐观置 DONE 的自我纠正：Esc 打断不触发 Stop hook，置 DONE 后若仍有工具活动，
  // 说明打断没真生效 → 翻回 WORKING；回合自然翻篇（新 prompt/Stop/SessionEnd）则撤销标记
  private correctEscMark(id: string, ev: BridgeEvent): void {
    const marked = this.escMarkedAt.get(id);
    if (marked === undefined) return;
    if (!this.mgr.getExternal(id)) {
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "PreToolUse") {
      // 新工具又开跑了：打断未生效（dispatch 已置 WORKING/WAITING，DONE 时补翻）
      if (this.mgr.getExternal(id)?.status === "DONE") {
        this.mgr.setExternalStatus(id, "WORKING", "打断未生效，恢复运行中");
      }
      this.mgr.pushExternalLog(id, "system", "打断未生效，恢复运行中");
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "PostToolUse") {
      // ≤3s 的视为被打断回合的收尾事件：忽略且不删标记
      if (Date.now() - marked <= 3000) return;
      if (this.mgr.getExternal(id)?.status === "DONE") {
        this.mgr.setExternalStatus(id, "WORKING", "打断未生效，恢复运行中");
        this.mgr.pushExternalLog(id, "system", "打断未生效，恢复运行中");
      }
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "UserPromptSubmit" || ev.event === "Stop" || ev.event === "SessionEnd") {
      this.escMarkedAt.delete(id); // 回合已自然翻篇
    }
  }

  // 5s 轮询 transcript：PC 端敲字排队（queue-operation enqueue）发生在任意时刻，
  // 只靠 hook 触发的增量读会有长工具调用期间的盲区；同一节拍顺带跑子 Agent TTL 清理
  // 与排队消息滞留看门狗
  private ensureQueuePoll(): void {
    if (this.queuePollTimer) return;
    this.queuePollTimer = setInterval(() => {
      if (this.transcriptPaths.size > 60) {
        // 只清已不存在的会话；全清会误伤长工具调用期间（无新 hook 事件）的活会话
        for (const id of [...this.transcriptPaths.keys()]) {
          if (!this.mgr.getExternal(id)) this.transcriptPaths.delete(id);
        }
        if (this.transcriptPaths.size > 120) this.transcriptPaths.clear(); // 兜底硬上限
      }
      for (const [id, p] of this.transcriptPaths) this.pushAssistantTexts(id, p);
      void this.pollTerminalLines();
      this.pollCliStatus();
      this.sweepNoHookIdle();
      this.sweepWorkingIdle();
      this.sweepSubagents();
      this.pollSubagentActivity();
      this.sweepStuckInputs();
    }, 3000); // 5s→3s（2026-09-17 用户反馈转轮行仍偏慢）：转轮行秒数每秒都在变，
    // 采样节奏就是用户可见的刷新率；3s 主循 + 2.5s 会话节流 ≈ 2.5~3s 级刷新
    this.queuePollTimer.unref();
  }

  // 终端实时状态行（2026-09-16 用户需求）：CLI 转轮文案（"✻ Crunched for 34s ●
  // Agent … finished · Proofing… (9s · ↓ 1.5k tokens)"）不写入状态文件（只有
  // busy/idle），唯一来源是终端屏幕本身——复用滞留验证的屏幕捕获（Windows
  // inject --peek / macOS Terminal contents），取底部转轮行刷新 action_summary。
  // 两者读的都是内存文本缓冲——窗口最小化/遮挡不影响（2026-09-16 澄清：最小化
  // 顾虑不成立）；仅 tmux/分离会话等非常规宿主抓不到，此时静默回退旧摘要。
  // WORKING 且有 cli_pid 的外部会话按主循 3s + 每源 2.5s 节流采样（2026-09-17 调优：
  // 5s 主循时用户实测转轮行秒数 5 秒一跳仍嫌慢）；文本变化才下发，
  // hook 工具事件一来即被权威摘要覆盖（事件间隙的实时性补位）
  private cliStatusAt = new Map<string, number>();

  // CLI 状态文件驱动外部会话状态（2026-09-16 用户实测"CLI 已空闲 10 分钟、软件
  // 还显示工作中"）：公司机等无 hook 直读通道的会话，CLI 自报状态是最权威信号。
  // busy → WORKING（自愈误 DONE）；idle 且转录/hook 静默 >20s（防工具间隙抖动）→
  // completed。WAITING/审批挂起不动（等待审批时 CLI 可能报 idle）
  private pollCliStatus(): void {
    const now = Date.now();
    for (const s of this.mgr.snapshot()) {
      if (!s.external || !s.cli_pid || s.historical) continue;
      if (s.status !== "WORKING" && s.status !== "DONE" && s.status !== "ERROR") continue;
      if ((s.pending_inputs?.length ?? 0) > 0) continue; // 审批挂起中不动（等待审批时 CLI 可能报 idle）
      if (now - (this.cliStatusAt.get(s.session_id) ?? 0) < 5_000) continue;
      this.cliStatusAt.set(s.session_id, now);
      const st = cliSessionStatus(s.cli_pid);
      if (!st) continue;
      try {
        if (st === "busy") {
          if (s.status !== "WORKING") {
            this.mgr.setExternalStatus(s.session_id, "WORKING", s.action_summary || "CLI 运行中");
            this.mgr.pushExternalLog(s.session_id, "system", "CLI 状态恢复运行（状态文件）");
          }
        } else if (st === "idle") {
          const quiet = now - Math.max(
            this.lastGrow.get(s.session_id) ?? 0,
            this.lastHookAt.get(s.session_id) ?? 0,
            0,
          );
          if (s.status === "WORKING" && quiet > 20_000) {
            const turn = this.turnStart.get(s.session_id) ?? s.started_at;
            this.mgr.finishExternal(s.session_id, "completed", now - turn, now - quiet); // #144 完成时刻=最后转录/hook 活动，非判定时刻
          }
        }
      } catch {}
    }
  }

  private termLine = new Map<string, string>();
  private termCapAt = new Map<string, number>();
  private titleScanned = new Set<string>();
  private pollTerminalLineBusy = false;
  // 转录标题扫描（cc-light 借鉴）：custom-title（用户 /rename）> ai-title（CLI 自动
  // 任务标题=终端标签名）——免 GLM 配额、与终端所见一致。头 32KB + 尾 64KB 两窗扫描
  //（标题多在会话前段；长会话后期任务切换的新标题在尾部），取文件序最新一条
  private scanTranscriptTitles(p: string): { custom?: string; ai?: string } {
    try {
      const size = statSync(p).size;
      const buf = Buffer.alloc(Math.min(size, 96 * 1024));
      const fd = openSync(p, "r");
      try {
        readSync(fd, buf, 0, buf.length, 0);
        if (size > buf.length) readSync(fd, buf, buf.length / 2, size - buf.length, size - (size - buf.length) / 1 > 0 ? size - 64 * 1024 : 0);
      } catch {}
      finally { try { closeSync(fd); } catch {} }
      const text = buf.toString("latin1");
      let custom: string | undefined, ai: string | undefined;
      // latin1 字节视图的捕获组须先还原 UTF-8 再 parse：中文标题字节序列直接
      // JSON.parse 会变乱码（端边对账→ç«¯è¾¹å¯¹è´¢）；转义序列纯 ASCII 两视图等价。
      // 源码是正本：08699ef 曾只改 bundle 副本未落此处，重打包即被冲掉——勿再走岔
      const reC = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;
      for (const m of text.matchAll(reC)) {
        try { custom = JSON.parse('"' + Buffer.from(m[1], "latin1").toString("utf-8") + '"'); } catch {}
      }
      const reA = /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g;
      for (const m of text.matchAll(reA)) {
        try { ai = JSON.parse('"' + Buffer.from(m[1], "latin1").toString("utf-8") + '"'); } catch {}
      }
      return { custom, ai };
    } catch { return {}; }
  }

  // 标题回写：不锁 title_locked（CLI 会随任务切换更新标题，保持跟随）；用户后续
  // 在 App 改名仍走 titleOverrides 最高优先
  private applyTranscriptTitle(id: string, p: string): void {
    if (this.titleScanned.has(id)) return;
    const st = this.mgr.getExternal(id);
    if (!st || st.title_locked) { this.titleScanned.add(id); return; }
    const p2 = this.transcriptPaths.get(id) ?? p;
    const { custom, ai } = this.scanTranscriptTitles(p2);
    const t = custom || ai;
    if (t && t.trim()) this.mgr.setExternalTitle(id, t.trim().slice(0, 120));
    this.titleScanned.add(id);
  }

  private async pollTerminalLines(): Promise<void> {
    if (this.pollTerminalLineBusy) return;
    // 测试环境关门：45f 段对控制台 peek 计数断言，后台采集器会多出真实 peek 干扰
    if (process.env.CCR_NO_TERM_LINE === "1") return;
    this.pollTerminalLineBusy = true;
    try {
      const now = Date.now();
      for (const s of this.mgr.snapshot()) {
        if (!s.external || s.status !== "WORKING" || !s.cli_pid) continue;
        if (this.pending.has(s.session_id)) continue; // 审批横幅优先展示
        // 转录标题扫描（cc-light 借鉴）：custom-title（用户 /rename）> ai-title（CLI 自动
        // 任务标题=终端标签名）——免 GLM 配额、与终端所见一致；每会话扫一次即可
        if (!this.titleScanned.has(s.session_id)) {
          const tp = this.transcriptPaths.get(s.session_id);
          if (tp) this.applyTranscriptTitle(s.session_id, tp);
        }
        if (now - (this.termCapAt.get(s.session_id) ?? 0) < 2_500) continue;
        this.termCapAt.set(s.session_id, now);
        try {
          const rows = await captureConsoleBottom(s.cli_pid, 14);
          if (!rows || !rows.length) continue;
          // 转轮行启发式：底部向上找含 CLI 转轮动词符号或以 … 收尾的非输入行
          let line = "";
          for (let i = rows.length - 1; i >= 0; i--) {
            const t = rows[i].trim();
            if (t.length < 12 || t.includes("❯")) continue;
            // 必须含 CLI 转轮符号：通用 "Processing…" 行会混入（2026-09-16 实测），
            // 且星符号在 relay 侧剥离，客户端动画星成为唯一指示不重复
            if (/[✻✳✶✦✿✽]/.test(t)) {
              // 行首 CLI 装饰性转轮星剥掉：客户端状态行自带动画星（LiveStatusLine/
              // conn-dots），双星重复且工具摘要行无星不统一（2026-09-16 用户反馈）
              line = t.replace(/^[✻✳✶✦✿✽●]\s*/u, "");
              break;
            }
          }
          if (!line || line === this.termLine.get(s.session_id)) continue;
          this.termLine.set(s.session_id, line);
          // \u200B 零宽前缀=「终端实时行」标记：客户端识别后隐藏自家计时/走秒
          //（转轮行自带活动时长与 ↓token，再叠客户端计时就是重复——2026-09-16 用户反馈）
          this.mgr.setExternalStatus(s.session_id, "WORKING", "\u200B" + truncate(line, 120));
        } catch {}
      }
    } finally {
      this.pollTerminalLineBusy = false;
    }
  }

  // 无 hook 会话的回合结束：无 Stop 事件可依赖。纯文本收尾（turnShape="end"）静默
  // 超过阈值即视作结束（状态回落 + flush 排队消息）；其余形态（工具执行中/下一条
  // 生成中）给 10 分钟长窗——转录整条落盘，纯思考空窗可达分钟级，短窗必误判回落
  //（封顶防 Esc 打断/进程死亡后再无写入的永久卡 WORKING）
  private sweepNoHookIdle(): void {
    if (!this.noHookIds.size) return;
    const idleMs = Number(process.env.CCR_NOHOOK_IDLE_MS) > 0 ? Number(process.env.CCR_NOHOOK_IDLE_MS) : 90_000;
    const now = Date.now();
    for (const id of [...this.noHookIds]) {
      const st = this.mgr.getExternal(id);
      if (!st) {
        this.noHookIds.delete(id);
        this.lastGrow.delete(id);
        this.turnStart.delete(id);
        this.turnShape.delete(id);
        continue;
      }
      if (st.status !== "WORKING" || st.compacting || this.pending.has(id)) continue;
      const last = this.lastGrow.get(id) ?? 0;
      const shape = this.turnShape.get(id) ?? "gen";
      if (!last || now - last <= (shape === "end" ? idleMs : 600_000)) continue;
      this.noHookIds.delete(id);
      const turn = this.turnStart.get(id) ?? st.started_at;
      this.turnStart.delete(id);
      this.mgr.finishExternal(id, "completed", Date.now() - turn, last); // #144 完成时刻=最后转录增长，非判定时刻
      this.mgr.pushExternalLog(id, "system", "转录静默，回合视作结束（无 hook 会话）");
      if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    }
  }

  // #211 空闲兜底：hook 上报链路整体失联（403/桥配置失配/relay 换 token）时 Stop
  // 永远到不了，WORKING 外部会话永久卡死。有 hook 会话（不在 noHookIds）以
  // "转录增长 + hook 事件"双时钟判空闲：两时钟均静默超过 shape 档上限（end=90s /
  // 其余 10min，与 sweepNoHookIdle 同参）即视作回合完成。误判可自愈——真在跑的
  // 长工具下一事件到达即翻回 WORKING；不兜底则是永久假 WORKING（更糟）。
  private sweepWorkingIdle(): void {
    const idleMs = Number(process.env.CCR_NOHOOK_IDLE_MS) > 0 ? Number(process.env.CCR_NOHOOK_IDLE_MS) : 90_000;
    // 进程存活硬信号清扫开关（生产默认开；测试假 pid 世界在文件顶部整体关掉，46 段局部开）
    const deadSweepOn = process.env.CCR_DEAD_SWEEP !== "0";
    const now = Date.now();
    if (this.lastHookAt.size > 200) this.lastHookAt.clear(); // 会话量上限兜底（与 lastGrow 同口径）
    for (const s of this.mgr.snapshot()) {
      if (!s.external || s.status !== "WORKING") continue;
      const id = s.session_id;
      // #144：真实最后活动起点——dead 分支也用它收殓时刻戳，先算（重启回放后
      // lastGrow/lastHookAt 为空，回退到回放态 updated_at = 最后落盘事件 ts，
      // 正是僵尸的真实死亡时刻；判定时刻 now 只影响"何时发现"，不能当活跃时刻）
      const idleSince = Math.max(
        this.lastGrow.get(id) ?? 0,
        this.lastHookAt.get(id) ?? 0,
        s.updated_at ?? 0,
      );
      // 进程存活硬信号：cli_pid 已不是 CLI 宿主 → 异常断开（无 SessionEnd 的死亡：
      // 死机/重启/崩溃；主动退出走 SessionEnd → 卡片已同步清除，到不了这里）。
      // 不等静默窗口、不受 updated_at 刷新干扰（手机反复发消息会把 idleSince 一直
      // 推新，纯静默判定对僵尸会话失效——#114 遗留面）。卡片保留（done_reason=
      // disconnected），客户端发消息可触发服务端 claude --resume 恢复。
      if (deadSweepOn && s.cli_pid && !cliHostAlive(s.cli_pid)) {
        const turn = this.turnStart.get(id) ?? s.started_at;
        this.turnStart.delete(id);
        this.mgr.finishExternal(id, "disconnected", now - turn, idleSince);
        const dropped = this.inputQueue.get(id)?.length ?? 0;
        this.inputQueue.delete(id);
        this.disarmVerify(id);
        if (s.pending_inputs?.length) this.mgr.setExternalPending(id, []);
        this.mgr.pushExternalLog(id, "system", `CLI 进程已退出（未见主动结束上报），会话保留可恢复${dropped ? `，弃 ${dropped} 条排队消息` : ""}`);
        continue;
      }
      if (this.noHookIds.has(id) || s.compacting || this.pending.has(id)) continue; // 无 hook 会话有专属扫描；压缩中/审批挂起中不动
      // 有 hook 活动史的会话：长工具（后台 CI/长轮询）期间 hook 事件与转录双静默
      // 数分钟是常态——60s/90s 档会把"工作中"误判成已完成（2026-09-16 16:16 用户实测
      // 本会话正在跑长任务双端却显示空闲）。hook 会话的权威完成信号是 Stop hook，
      // 静默兜底窗提到 15 分钟；从无 hook 事件的会话维持原启发式（#211/#65 场景）
      const hooked = (this.lastHookAt.get(id) ?? 0) > 0;
      const effWin = hooked ? 900_000 : (this.turnShape.get(id) ?? "gen") === "end" ? idleMs : 600_000;
      // 末条形态分档（与 sweepNoHookIdle 同参）：end=纯文本收尾 90s 即回落，
      // 其余（工具执行中/生成中）给 10 分钟长窗——先判全局 600s 会让 90s 档变死代码
      const shape = this.turnShape.get(id) ?? "gen";
      if (!idleSince || now - idleSince <= effWin) {
        // #65（2026-09-11 用户实测公司机 10 分钟不回落）：gen/tool 档静默 90s+ 且
        // CLI 自写的会话状态文件报 idle → 权威快速回落（不等 10 分钟窗。生成中
        // CLI 报 busy，长思考不误伤；hook 失联时这是唯一可靠快信号）
        // 2026-09-16：快速回落仅限从无 hook 事件的会话——有 hook 史的长工具执行期
        // CLI 进程状态同样报 idle，60s 误判成"已完成"（本会话长 CI 等待实测中招）
        if (!hooked && now - idleSince > idleMs && s.cli_pid && cliSessionIdle(s.cli_pid)) {
          const turn = this.turnStart.get(id) ?? s.started_at;
          this.turnStart.delete(id);
          this.mgr.finishExternal(id, "completed", now - turn, idleSince);
          this.mgr.pushExternalLog(id, "system", "CLI 已空闲（进程状态 idle），回合视作结束");
          if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
        }
        continue;
      }
      const turn = this.turnStart.get(id) ?? s.started_at;
      this.turnStart.delete(id);
      this.mgr.finishExternal(id, "completed", now - turn, idleSince);
      this.mgr.pushExternalLog(id, "system", "转录与事件均静默超时，回合视作结束（hook 失联兜底）");
      if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    }
  }

  // 记账"该文本近期已记为正式消息"：transcript 里 enqueue 与晋升可能同批读到，
  // 不去重会把已处理的消息再塞回 pending（手机双气泡）
  private noteUserMsg(id: string, text: string, via: "promote" | "prompt"): void {
    let m = this.recentUserMsgs.get(id);
    if (!m) {
      m = new Map();
      this.recentUserMsgs.set(id, m);
    }
    m.set(normKey(text), { ts: Date.now(), via });
    if (m.size > 40) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, rec] of m) if (rec.ts < cutoff) m.delete(k);
    }
  }

  private recentlyLogged(id: string, text: string): boolean {
    const rec = this.recentUserMsgs.get(id)?.get(normKey(text));
    return rec !== undefined && Date.now() - rec.ts < 60_000;
  }

  // 该文本是否被近期"晋升"记录覆盖（双向包含）：CLI 用合并形态（"A\rB"）重发已按单条
  // 晋升过的消息（或反之）时，任一方向包含即视为同批已展示；只认 promote 来源，
  // PC 手敲重发（via=prompt 记录）不吞。
  // 窗口 60s→10min（2026-09-17）：CLI 忙时排队消息从 enqueue 回执晋升到真正提交
  // （UserPromptSubmit）经常超过 60s，护栏过期后提交帧再记一条 → 手机双气泡
  // （用户实测 19:48/19:49 各一条）。promote 记录只来自客户端注入，10min 内的
  // 提交帧都该视为同一条消息的回声
  private coveredByRecentPromote(id: string, text: string): boolean {
    const m = this.recentUserMsgs.get(id);
    if (!m) return false;
    const pk = normKey(text);
    const now = Date.now();
    for (const [k, rec] of m) {
      if (rec.via !== "promote" || now - rec.ts >= 600_000 || !k) continue;
      if (k === pk || k.includes(pk) || pk.includes(k)) return true;
    }
    return false;
  }

  // 从 pending 里出队所有被 text 覆盖的条目（单条精确 / 合并形态包含），返回被出队的原文
  private consumePendingTexts(id: string, text: string): string[] {
    const state = this.mgr.getExternal(id);
    const list = state?.pending_inputs ?? [];
    if (!list.length) return [];
    const key = normKey(text);
    const kept = list.filter((p) => !key.includes(normKey(pBody(p))));
    if (kept.length === list.length) return [];
    this.mgr.setExternalPending(id, kept);
    for (const p of list) if (key.includes(normKey(pBody(p)))) this.dropEnqueuedKey(id, pBody(p));
    return list.filter((p) => key.includes(normKey(pBody(p)))).map((p) => p.text);
  }

  // PC 端敲字排队：与手机注入同构地进 pending_inputs，手机立即显示"排队中"
  private onQueueEnqueue(id: string, content: string): void {
    const state = this.mgr.getExternal(id);
    if (!state) return;
    const text = truncate(content.trim(), 300);
    if (!text || this.recentlyLogged(id, text)) return;
    // 删除闭环的系统通知注入：不作为排队气泡回显（晋升时的 user_message 已足够透明）
    if (text.startsWith("[移动端删除任务]")) return;
    const key = normKey(content);
    const pending = state.pending_inputs ?? [];
    // CLI 会把多条排队消息合并成一条 enqueue（"A\rB"，内部换行折叠）：覆盖任一待发消息
    // 即为同一批的重复表示，不重复入队；手机注入回显（extInput）已进队同样跳过。
    // 同时登记"已进 CLI 队列"：看门狗的滞留判定跳过（CLI 忙时排队是正常路径，非滞留）
    const covered = pending.some((p) => key.includes(normKey(pBody(p))));
    if (covered) {
      // #43 根治（2026-09-10 深夜）：transcript 的 enqueue 行 = CLI 已收到该消息的回执——
      // 不再只登记等 UserPromptSubmit 晋升（CLI 忙时合并提交的 UPS prompt 与 pending
      // 原文经 normKey 300 截断后互不包含，800 字长消息三式全脱靶 → 永久滞留闪烁，
      // 用户实测中招）。收到回执即晋升出队 + 写正式消息日志（enqueued 语义本就是已处理）
      const hits = pending.filter((p) => key.includes(normKey(pBody(p))));
      const kept = pending.filter((p) => !key.includes(normKey(pBody(p))));
      this.mgr.setExternalPending(id, kept);
      for (const p of hits) {
        // 晋升即出队：清进队标记（同文本再次滞留时看门狗仍要管），不重新登记——
        // 登记了 isEnqueued 会永久跳过补发，39 段回归（晋升后重滞留）正挂在这
        this.dropEnqueuedKey(id, pBody(p));
        this.noteUserMsg(id, pBody(p), "promote");
        this.mgr.pushExternalLog(id, "user_message", truncate(p.text, 300), undefined, { full: truncate(p.text, 2000) });
      }
      this.resetStuckWatch(id); // #111：enqueue 回执晋升与 UPS 晋升同权，重置滞留快窗
      return;
    }
    this.mgr.setExternalPending(id, [...pending, { text, ts: Date.now() }]);
  }

  // ext id -> transcript queue-operation 已见过的 normKey：这些文本已被 CLI 捕获进队，
  // 滞留看门狗不得对它们补发回车（误补发会在回合边界提交空行/干扰排队语义）
  private enqueuedKeys = new Map<string, Set<string>>();

  private noteEnqueuedKey(id: string, key: string): void {
    if (!key) return;
    let m = this.enqueuedKeys.get(id);
    if (!m) {
      if (this.enqueuedKeys.size > 60) this.enqueuedKeys.clear();
      m = new Set();
      this.enqueuedKeys.set(id, m);
    }
    m.add(key);
    if (m.size > 40) m.clear();
  }

  private isEnqueued(id: string, text: string): boolean {
    return this.enqueuedKeys.get(id)?.has(normKey(text)) ?? false;
  }

  // 晋升（transcript user 行 / UPS hook 确认提交）后移除标记：同文本再次注入滞留时看门狗仍要管
  private dropEnqueuedKey(id: string, text: string): void {
    this.enqueuedKeys.get(id)?.delete(normKey(text));
  }

  // steering 中途交付（attachment queued_command，不触发 UserPromptSubmit）：
  // 出 pending + 记正式消息；有钩子的路径仍由 promotePending 处理
  private onSteerDelivered(id: string, prompt: string): void {
    const state = this.mgr.getExternal(id);
    if (!state) return;
    const text = truncate(prompt.trim(), 300);
    if (!text || this.recentlyLogged(id, text) || this.coveredByRecentPromote(id, text)) return;
    // 合并形态（"A\rB"）交付：出队覆盖到的所有 pending，按各自原文各记一条（不记合并稿）
    const consumed = this.consumePendingTexts(id, text);
    if (consumed.length) {
      for (const t of consumed) {
        if (!this.recentlyLogged(id, t)) this.mgr.pushExternalLog(id, "user_message", truncate(t, 300), undefined, { full: truncate(t, 2000) });
        this.noteUserMsg(id, t, "promote");
      }
      this.resetStuckWatch(id); // #111：交付晋升同权，重置滞留快窗
    } else {
      this.mgr.pushExternalLog(id, "user_message", text, undefined, { full: truncate(prompt, 2000) });
    }
    this.noteUserMsg(id, text, "promote");
  }

  // 手动撤回排队消息（remove 且无 attachment 配对）：FIFO 出队一条
  private onQueueDiscard(id: string, count: number): void {
    const state = this.mgr.getExternal(id);
    if (!state || count <= 0) return;
    const pending = [...(state.pending_inputs ?? [])];
    while (count-- > 0 && pending.length) pending.shift();
    this.mgr.setExternalPending(id, pending);
  }

  // #363 PreCompact（手动 /compact 或上下文将满自动压缩）：CLI 进入
  // "Compacting conversation..."，转录静默可达分钟级——置 compacting 标志 +
  // 摘要明示，端上不误判卡死；仅对已建档会话生效（不从压缩事件新建档案）
  private onPreCompact(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    if (!this.mgr.getExternal(id)) return { decision: "pass" };
    this.mgr.setExternalStatus(id, "WORKING", "正在压缩上下文…", Date.now());
    this.mgr.setExternalCompacting(id, true);
    this.mgr.pushExternalLog(id, "system", "上下文接近上限，正在压缩对话历史");
    return { decision: "pass" };
  }

  // 模型显示名覆盖（读一次缓存）：模型别名接入（如 claude-* 别名路由 GLM）时 CLI 上报
  // 的模型名与实际服务不符——~/.cc-deck/data/model-display 放一行显示名即全端生效
  private static modelDisplay: string | null | undefined;

  private static modelDisplayName(): string | null {
    if (Bridge.modelDisplay === undefined) {
      try {
        Bridge.modelDisplay = readFileSync(path.join(homedir(), ".cc-deck", "data", "model-display"), "utf8").trim() || null;
      } catch {
        Bridge.modelDisplay = null;
      }
    }
    return Bridge.modelDisplay;
  }

  private async dispatch(ev: BridgeEvent): Promise<BridgeDecision> {
    const decision = await this.dispatchInner(ev);
    // 权限模式跟随：CLI 上报什么存什么（恢复会话时镜像原始启动参数的依据）。
    // 放事件处理之后——首事件时会话刚在 handler 里建卡，前置捕获会扑空
    if (ev.permission_mode) this.mgr.setExternalPermMode(this.extId(ev), ev.permission_mode);
    return decision;
  }

  private async dispatchInner(ev: BridgeEvent): Promise<BridgeDecision> {
    switch (ev.event) {
      case "UserPromptSubmit":
        return this.onPrompt(ev);
      case "PreToolUse":
        return this.onPreToolUse(ev);
      case "PostToolUse":
        return this.onPostToolUse(ev);
      case "Notification":
        return this.onNotification(ev);
      case "Stop":
        return this.onStop(ev);
      case "SessionEnd":
        return this.onSessionEnd(ev);
      case "PreCompact":
        return this.onPreCompact(ev);
      default:
        return { decision: "pass" };
    }
  }

  // 远程命令决定挂起中的审批（COMMAND_CONTINUE / COMMAND_REJECT）
  resolvePending(sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string): boolean {
    const p = this.pending.get(sessionId);
    if (!p || p.requestId !== requestId) return false;
    clearTimeout(p.timer);
    this.pending.delete(sessionId);
    p.resolve({ decision, reason });
    return true;
  }

  // 手机作答 AskUserQuestion：窗口内 allow+updatedInput 把答案注入工具入参（CLI 不再弹本地选择器）；
  // 窗口外（本地选择器已弹出）Esc 关闭它再以消息注入答案——两端任一先答即生效。
  // 返回 null=已受理，字符串=失败原因（Mac 无注入器等场景给用户可读的提示）
  answerPending(sessionId: string, requestId: string, answers: string[]): string | null {
    const p = this.pending.get(sessionId);
    if (p && p.requestId === requestId && p.questions?.length && p.toolInput) {
      clearTimeout(p.timer);
      this.pending.delete(sessionId);
      const answersMap: Record<string, string> = {};
      p.questions.forEach((q, i) => {
        if (answers[i]) answersMap[q.question] = answers[i];
      });
      p.resolve({
        decision: "allow",
        updatedInput: { ...p.toolInput, answers: answersMap },
      });
      return null;
    }
    // 超时兜底：CLI 本地选择器已弹出（hook 已放行），手机晚到的作答转为注入送达。
    // relay 重启会清内存兜底表，但 waiting 状态经 events.ndjson 重放仍在——按
    // request_id 从会话状态找回问题定义，晚答不因重启失效
    const fb = this.askFallback.get(sessionId);
    if (fb && fb.requestId !== requestId) return "no such pending request";
    const st = this.mgr.getExternal(sessionId);
    const wq = st?.waiting_request;
    const questions = fb?.questions ?? (wq?.request_id === requestId ? wq?.questions : undefined);
    if (!questions?.length) return "no such pending request";
    if (!st?.cli_pid) return "CLI 进程未定位";
    if (!ensureInjector()) return "当前平台不支持按键注入，请在电脑端作答";
    if (fb) this.askFallback.delete(sessionId);
    const pid = st.cli_pid;
    const msg = buildAnswerMessage(questions, answers);
    this.mgr.setExternalStatus(sessionId, "WORKING", "手机作答");
    void injectEsc(pid).then(async (r) => {
      if (!r.ok) {
        this.onInjectFail(sessionId, r.error);
        return;
      }
      // 等本地选择器收起、焦点回到输入框
      await sleep(400);
      const pid2 = this.mgr.getExternal(sessionId)?.cli_pid;
      if (!pid2) return;
      const r2 = await injectText(pid2, msg);
      if (!r2.ok) this.onInjectFail(sessionId, r2.error);
    });
    return null;
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  // ---------- 输入注入（COMMAND_EXT_INPUT / COMMAND_EXT_STOP）----------

  // 空闲（DONE）/运行中（WORKING）立即注入——CLI 对工作中收到的输入会原生排队/steering，
  // 与 PC 终端手敲一致；WAITING（本地权限弹窗/远程审批挂起）注入 Enter 可能误触弹窗，排队等回合结束。
  // ERROR 也放行（relay 重启重放的误标，自愈 sweeper 未及翻转时先到）：pid 死了注入
  // 自然失败走 onInjectFail 清定位，不会卡死
  extInput(sessionId: string, text: string, images?: string[], files?: UploadBlob[]): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    // #54 路线 A：外部会话发图——base64 落盘专用临时目录 <dataDir>/../tmp（7 天自动清扫，
    // 见 index.ts sweepTmpImages），合成「正文 + 路径查看指令」后走既有注入/排队链路，
    // CLI 用 Read 工具渲染图片（Read 原生支持 PNG/JPG）。扩展名按魔数嗅探兜底 png。
    // #62 文件同链路：落盘保留原始文件名，指令改「按需读取处理」（Read/Bash 均可接手）。
    // 落盘逻辑抽至 uploads.ts（与托管会话共用，命名口径对账见 test-bridge）
    let body = text.trim();
    const savedImgs = images && images.length ? saveUploadImages(this.opts.dataDir, sessionId, images) : [];
    if (savedImgs.length) {
      body = body
        ? `${body}\n（图片已保存：${savedImgs.join("、")}——请用 Read 工具查看后再继续）`
        : `请用 Read 工具查看图片：${savedImgs.join("、")}`;
    } else if (images && images.length && !body) {
      return { ok: false, error: "图片保存失败（临时目录不可写）" };
    }
    const savedFiles = files && files.length ? saveUploadFiles(this.opts.dataDir, sessionId, files) : [];
    if (savedFiles.length) {
      body = body
        ? `${body}\n（文件已保存：${savedFiles.join("、")}——请按需读取处理）`
        : `请处理以下文件：${savedFiles.join("、")}`;
    } else if (files && files.length && !body) {
      return { ok: false, error: "文件保存失败（临时目录不可写）" };
    }
    if (!body) return { ok: false, error: "空消息" };
    // 回显用短文本：排队气泡里别展开整串临时路径（#54b：echo/body 分离，客户端可见面不露路径）
    const echoBits = [text.trim()];
    if (savedImgs.length) echoBits.push(`[图片×${savedImgs.length}]`);
    if (savedFiles.length) echoBits.push(`[文件×${savedFiles.length}]`);
    const echoText = echoBits.filter((x) => x.length > 0).join(" ");
    // 平台不支持注入（Linux 无按键注入器；Windows SendInput / macOS osascript 均已支持）：
    // 明确报错而非排队后静默失败——手机端"消息消失无反应"的根因（#303），ACK ok:false 让客户端弹原因
    if (!injectSupported()) {
      return { ok: false, error: "当前 relay 主机暂不支持向外部 CLI 会话注入输入（仅 Windows/macOS）；托管会话不受影响" };
    }
    // 异常断开（进程死亡、无 SessionEnd）保留的会话：客户端发消息 → 服务端新开终端标签
    // claude --resume 同 id 恢复，消息作为初始 prompt 投递；恢复进程的 hooks 上报后
    // 会话自动翻回 WORKING、pid 重新定位，回到正常注入通路
    // 恢复触发放宽（2026-09-17）：电脑重启后 CLI 全灭、relay 重启后 pid 丢失、
    // done_reason 非 disconnected——只要 CLI 不可用就走恢复，不再限定断连
    // DONE 会话：CLI 进程不在了才走恢复（claude --resume 新终端重启+投递）。
    // CLI 还活着（等输入）→ 走正常注入路径，不打断
    // 误判双重防护（2026-09-18 公司机报障：CLI 窗口存活却走恢复开新窗，消息滞留
    // 输入框、对旧 CLI 空框补发 10 次回车）：判死前先抢救——
    // ①pid 缺失/已死 → 立即跑一轮补定位（不等 60s 自愈节拍：CLI 自写的 sessions
    //   文件 / cli-pids 缓存此刻可能已能恢复定位，定位到了就不开新窗）；
    // ②在档 pid 双探测：tasklist/ps 单次偶发失败（杀软干扰、系统瞬时繁忙）不直接
    //   判死，重试一次仍失败才算不可用。
    // 仍不可用才开恢复新窗，且把触发原因写进恢复日志（此前此分支无任何留痕可查）
    if (state.status === "DONE" && (!state.cli_pid || !cliHostAlive(state.cli_pid))) {
      if (!state.cli_pid || !pidAlive(state.cli_pid)) {
        this.reconcilePidsFromSessions();
        this.hydratePidsFromCache();
      }
      const pid2 = this.mgr.getExternal(sessionId)?.cli_pid ?? state.cli_pid;
      let alive2 = !!pid2 && cliHostAlive(pid2);
      if (!alive2 && pid2) alive2 = cliHostAlive(pid2); // 二次探测
      if (!alive2) {
        return this.resumeExternal(sessionId, body, !pid2 ? "无进程定位" : `进程 ${pid2} 判定不可用（二次探测仍失败）`, echoText);
      }
    }

    const q = this.inputQueue.get(sessionId) ?? [];
    q.push(body);
    this.inputQueue.set(sessionId, q);
    // 发送方回显：进会话状态 pending_inputs（客户端显示在工作指示器下方，处理时上浮为正式消息）。
    // 带图消息双文本：text=短回显（客户端可见面一律不暴露临时路径），body=注入 CLI 的
    // 全文——晋升/看门狗/防抢发守门对账用 body（pBody），CLI 侧回流的只有 body 形态
    this.mgr.setExternalPending(sessionId, [...(state.pending_inputs ?? []), { text: echoText, ts: Date.now(), ...(body !== echoText ? { body } : {}) }]);
    if ((state.status === "DONE" || state.status === "WORKING" || state.status === "ERROR") && !this.flushing.has(sessionId)) {
      if (state.status !== "DONE") {
        this.mgr.pushExternalLog(sessionId, "system", `已注入终端（CLI 运行中，自动排队跟随）：${truncate(echoText, 80)}`);
      }
      void this.flushQueue(sessionId);
    } else {
      this.mgr.pushExternalLog(sessionId, "system", `已排队（等待确认/回合结束后自动发送）：${truncate(echoText, 80)}`);
    }
    return { ok: true };
  }

  // 异常断开会话的恢复投递：pending 回显 + 新终端标签 claude --resume（权限模式镜像
  // 原始会话）。fire-and-forget：恢复进程的 hooks 上报驱动后续状态翻正，失败落会话日志。
  // 同会话恢复去重（2026-09-17）：此前每条消息都各开一个"新终端标签"——CLI 死亡的
  // 会话连发 N 条 = N 个重复标签（用户 Mac 一晚叠了 15 个）。窗口内后续消息只进
  // pending，恢复进程空闲时 flushQueue 自动带上
  private resumeSpawns = new Map<string, number>();

  private resumeExternal(sessionId: string, text: string, why?: string, echo?: string): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (this.resumeSpawns.size > 60) this.resumeSpawns.clear();
    const inWindow = Date.now() - (this.resumeSpawns.get(sessionId) ?? 0) < this.resumeWindowMs;
    // 带图消息：pending 回显/日志用短文本（不暴露临时路径），对账键仍是注入全文
    const shown = echo ?? text.trim();
    this.mgr.setExternalPending(sessionId, [...(state.pending_inputs ?? []), { text: shown, ts: Date.now(), ...(shown !== text.trim() ? { body: text.trim() } : {}) }]);
    if (inWindow) {
      this.mgr.pushExternalLog(sessionId, "system", `恢复进行中，消息已排队（恢复进程空闲后自动带上）：${truncate(shown, 80)}`);
      return { ok: true };
    }
    const cwd = state.cwd || homedir();
    this.resumeSpawns.set(sessionId, Date.now());
    this.mgr.pushExternalLog(sessionId, "system", `恢复会话中（新终端标签 claude --resume${why ? `，原因：${why}` : ""}）并投递：${truncate(shown, 80)}`);
    void resumeSession(cwd, sessionId.slice(4), text, state.permission_mode).then((r) => {
      if (!r.ok) {
        this.resumeSpawns.delete(sessionId); // 恢复失败解除窗口，下条消息可重试恢复
        this.mgr.setExternalPending(sessionId, []);
        this.mgr.pushExternalLog(sessionId, "system", `恢复失败：${r.error ?? "未知错误"}`);
        return;
      }
      // 恢复闭环（2026-09-18 公司机报障）：spawn 成功 ≠ 恢复进程上线——claude 不在
      // PATH / 并发同会话被拒 / 新窗启动失败时，此前 pending 永挂、滞留看门狗干转。
      // 回查窗口到期时消息仍未晋升（无 UserPromptSubmit）→ 判定恢复未上线：解除
      // resumeSpawns 让下条消息可重试恢复，并留痕告知
      const prev = this.resumeClosures.get(sessionId);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        this.resumeClosures.delete(sessionId);
        const st = this.mgr.getExternal(sessionId);
        if (!(st?.pending_inputs ?? []).some((p) => normKey(pBody(p)) === normKey(text))) return; // 已晋升/已清：恢复成功
        this.resumeSpawns.delete(sessionId);
        this.mgr.pushExternalLog(sessionId, "system", `恢复进程 ${Math.round(this.resumeVerifyMs / 1000)}s 内未上线（新终端可能启动失败），下条消息发送时将重试恢复`);
      }, this.resumeVerifyMs);
      t.unref?.();
      this.resumeClosures.set(sessionId, t);
    });
    return { ok: true };
  }

  // UserPromptSubmit 到达：若与排队注入消息同文本 → 晋升该条（出 pending 区、入正式转录），
  // 返回 true 表示已由回显晋升、无需重复记 user_message 日志。
  // 匹配不做 recentlyLogged 门控：pending 条目按次生成，命中即代表这是一次新的注入回显
  // （手机快速重发同一句会各自命中、各记一条，不会被 60s 去重吞掉）
  private promotePending(sessionId: string, prompt: string): boolean {
    const state = this.mgr.getExternal(sessionId);
    const list = state?.pending_inputs ?? [];
    if (!list.length) return false;
    const key = normKey(prompt);
    // 同文本全部晋升：桌面端发消息会双入队（注入回显 + PC 敲字 transcript enqueue 各一条，
    // 同文本同 ts 邻近）——只清第一条会留幽灵 pending 永久闪烁（2026-09-14 用户实测）
    const matched = list.filter((p) => normKey(pBody(p)) === key);
    const i = matched.length ? list.indexOf(matched[0]) : -1;
    if (i !== -1) {
      const promoted = list.splice(i, 1)[0];
      for (const dup of matched.slice(1)) {
        const di = list.findIndex((p) => p === dup);
        if (di !== -1) list.splice(di, 1);
      }
      this.mgr.setExternalPending(sessionId, list);
      this.dropEnqueuedKey(sessionId, pBody(promoted));
      this.noteUserMsg(sessionId, pBody(promoted), "promote");
      this.mgr.pushExternalLog(sessionId, "user_message", truncate(promoted.text, 300), undefined, { full: truncate(promoted.text, 2000) });
      this.resetStuckWatch(sessionId);
      return true;
    }
    // CLI 回合结束会把整队排队消息合并成一条 "A\rB" prompt 提交：连续段拼接匹配则整批晋升
    for (let s = 0; s < list.length; s++) {
      const acc: string[] = [];
      for (let e = s; e < list.length; e++) {
        acc.push(normKey(pBody(list[e])));
        const joined = acc.join(" ");
        if (joined.length > key.length) break;
        if (joined === key) {
          const hits = list.splice(s, e - s + 1);
          this.mgr.setExternalPending(sessionId, list);
          for (const h of hits) {
            this.dropEnqueuedKey(sessionId, pBody(h));
            this.noteUserMsg(sessionId, pBody(h), "promote");
            this.mgr.pushExternalLog(sessionId, "user_message", truncate(h.text, 300), undefined, { full: truncate(h.text, 2000) });
          }
          this.noteUserMsg(sessionId, prompt, "promote"); // 合并形态也记账：后续同形态到达直接跳过
          this.resetStuckWatch(sessionId);
          return true;
        }
      }
    }
    // #12 包含式回退（2026-09-10）：注入文与用户手打文被 CLI 合并成一条提交时，前两式
    // 皆脱靶（不连续/掺入其他文本），pending 条目滞留到回合结束仍在队里（Stop 兜底跳过
    // 在队项）→ 客户端永远排队闪烁。提交文本完整包含 pending 原文即视为已处理（与
    // consumePendingTexts 的口径一致）；误伤面仅限旧 pending 恰为后续更长提交的子串，
    // 晋升一条本就该出的旧条目，无害。
    // #43 超长脱靶补（2026-09-10 深夜实测）：normKey 双侧截 300——CLI 合并提交时该条
    // 排在中段（前面有其他消息），300 字窗口里既不完整包含也不被包含 → 三式全脱靶，长
    // 消息永远滞留（用户 800 字侧边栏反馈实测中招）。改用前缀窗口：取 pending 压空白后
    // 前 120 字做 key 的 includes——合并形态只要含该条开头 120 字即命中（CLI 提交原文
    // 必完整含每条排队消息的全文，前缀 120 字必在其中）
    const subHits = list.filter((p) => {
      const pk = normKey(pBody(p));
      return key.includes(pk) || (pk.length > 120 && key.includes(pk.slice(0, 120)));
    });
    if (subHits.length) {
      const keptList = list.filter((p) => !key.includes(normKey(pBody(p))));
      this.mgr.setExternalPending(sessionId, keptList);
      for (const h of subHits) {
        this.dropEnqueuedKey(sessionId, pBody(h));
        this.noteUserMsg(sessionId, pBody(h), "promote");
        this.mgr.pushExternalLog(sessionId, "user_message", truncate(h.text, 300), undefined, { full: truncate(h.text, 2000) });
      }
      this.resetStuckWatch(sessionId);
      return true;
    }
    return false;
  }

  // 注入 Esc 打断当前回合
  extStop(sessionId: string): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (state.status !== "WORKING") return { ok: false, error: "会话不在运行中" };
    if (!state.cli_pid) return { ok: false, error: "尚未定位 CLI 进程，等该会话下次活动后重试" };
    const pid = state.cli_pid;
    this.mgr.pushExternalLog(sessionId, "system", "发送打断（Esc）");
    void injectEsc(pid).then((r) => {
      if (!r.ok) {
        this.onInjectFail(sessionId, r.error);
        return;
      }
      // Esc 打断的回合不触发 Stop hook：乐观置 DONE（手机立即看到结束），
      // 若打断没真生效（后续仍有工具活动），correctEscMark 会翻回 WORKING
      const s = this.mgr.getExternal(sessionId);
      if (!s || s.status !== "WORKING") return; // 注入期间回合已自然结束/状态已翻篇
      if (this.escMarkedAt.size > 60) this.escMarkedAt.clear();
      this.escMarkedAt.set(sessionId, Date.now());
      const turn = this.turnStart.get(sessionId) ?? s.started_at;
      this.turnStart.delete(sessionId);
      this.mgr.finishExternal(sessionId, "interrupted", Date.now() - turn);
      this.mgr.pushExternalLog(sessionId, "system", "已打断");
      // 状态已是 DONE：排队的消息照常注入（flushQueue 认 DONE/WORKING）
      if ((this.inputQueue.get(sessionId)?.length ?? 0) > 0) void this.flushQueue(sessionId);
    });
    return { ok: true };
  }

  private async flushQueue(sessionId: string): Promise<void> {
    if (this.flushing.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      while (true) {
        const state = this.mgr.getExternal(sessionId);
        const q = this.inputQueue.get(sessionId);
        if (!q || q.length === 0) break;
        // 注入的下一条已进 WAITING（权限弹窗/审批挂起）：剩余留给下一次 Stop 后 flush（ERROR 放行，误标会话）
        if (!state || (state.status !== "DONE" && state.status !== "WORKING" && state.status !== "ERROR")) break;
        if (!state.cli_pid) {
          this.inputQueue.delete(sessionId);
          this.mgr.pushExternalLog(sessionId, "system", "排队消息被弃（进程定位丢失）");
          break;
        }
        const text = q.shift()!;
        const r = await injectText(state.cli_pid, text);
        if (!r.ok) {
          this.onInjectFail(sessionId, r.error);
          return;
        }
        this.armVerify(sessionId, text);
        await sleep(400); // 等 UserPromptSubmit 翻状态/给连续注入留节奏
      }
    } finally {
      this.flushing.delete(sessionId);
      // flush 尾部新入队的消息兜底再触发一轮
      const q = this.inputQueue.get(sessionId);
      const state = this.mgr.getExternal(sessionId);
      if (q && q.length > 0 && state?.status === "DONE") void this.flushQueue(sessionId);
    }
  }

  // 注入失败：CLI 进程多半已死/换壳，清定位缓存与队列，等下次 hook 事件重新定位
  private onInjectFail(sessionId: string, error?: string): void {
    this.mgr.clearExternalCliPid(sessionId);
    const dropped = this.inputQueue.get(sessionId)?.length ?? 0;
    this.inputQueue.delete(sessionId);
    if (this.mgr.getExternal(sessionId)?.pending_inputs?.length) this.mgr.setExternalPending(sessionId, []);
    this.clearPidCache(sessionId);
    const why = error === "pid-reuse" ? "进程定位失效（PID 被系统复用）" : (error ?? "未知");
    this.mgr.pushExternalLog(
      sessionId,
      "system",
      `注入失败（${why}），已清除进程定位${dropped ? `并弃 ${dropped} 条排队消息` : ""}；该会话下次活动后可重试`,
    );
  }

  // hook 侧 pid 缓存（relay 会话 id = "ext-" + CLI session_id）
  private clearPidCache(sessionId: string): void {
    try {
      const raw = JSON.parse(readFileSync(this.pidCacheFile, "utf-8")) as Record<string, number>;
      delete raw[sessionId.slice(4)];
      writeFileSync(this.pidCacheFile, JSON.stringify(raw));
    } catch {}
  }

  // ---------- 事件处理 ----------

  private extId(ev: BridgeEvent): string {
    return "ext-" + ev.session_id;
  }

  private onPrompt(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const turnStartedAt = Date.now();
    this.turnStart.set(id, turnStartedAt);
    // #292 系统通知块（后台任务通知 / slash 命令回显等）也会以 UserPromptSubmit 形态
    // 到达（CLI 把它们当 user 消息提交）：整块不作为用户消息/标题/状态摘要下发，
    // 只留 system 级过滤痕迹；回合本身是真实的（CLI 会处理该通知），照常翻 WORKING
    const rawPrompt = ev.prompt ?? "";
    const machine = isMachineUserText(rawPrompt);
    const prompt = machine ? "" : rawPrompt;
    const state = this.mgr.ensureExternal(id, ev.cwd, prompt, ev.session_id);
    // 会话由 PreToolUse 先创建（无 prompt）：首个 prompt 到达时把文件夹名标题升级为 prompt 摘要
    //（已取到 CC 会话名的保留会话名，只补记 initial_prompt）
    if (state.external && !state.initial_prompt && prompt) {
      const title = this.named.has(id) ? state.title : deriveTitle(prompt);
      this.mgr.setExternalTitle(id, title, prompt);
    }
    this.refreshName(id, ev);
    if (!this.named.has(id) && prompt) this.mgr.requestSmartTitle(id, prompt);
    this.mgr.setExternalStatus(
      id,
      "WORKING",
      machine ? "处理系统通知（后台任务/命令回显）" : truncate(rawPrompt || "新回合", 60),
      turnStartedAt,
    );
    if (machine) {
      this.mgr.pushExternalLog(id, "system", "系统通知块已过滤（后台任务/命令回显，不入消息列表）");
      return { decision: "pass" };
    }
    if (!this.promotePending(id, rawPrompt)) {
      // 晋升未命中：可能是 CLI 回合结束对已晋升排队消息的重复 UserPromptSubmit（合并形态冲刷），
      // 60s 内已被晋升记录覆盖 → 跳过；PC 手敲重发（上一条也走 prompt 记录）不受影响
      if (!this.coveredByRecentPromote(id, rawPrompt)) {
        this.noteUserMsg(id, rawPrompt, "prompt");
        this.mgr.pushExternalLog(id, "user_message", truncate(rawPrompt, 300), undefined, { full: truncate(rawPrompt, 2000) });
      }
    }
    void state;
    return { decision: "pass" };
  }

  // CC 会话名：~/.claude/sessions/<pid>.json 的 name 字段（CLI 启动数秒后异步写入，非必出现）
  // 命中则升级为标题；未命中继续在后续 prompt/Stop 上重试（有次数上限）
  private refreshName(id: string, ev: BridgeEvent): void {
    if (this.named.has(id)) return;
    if ((this.nameMisses.get(id) ?? 0) >= 8) return;
    if (this.mgr.getExternal(id)?.title_locked) return;
    const name = this.readCcSessionName(ev.session_id);
    if (name) {
      this.named.add(id);
      const state = this.mgr.getExternal(id);
      if (state && state.title !== name) this.mgr.setExternalTitle(id, name);
    } else {
      this.nameMisses.set(id, (this.nameMisses.get(id) ?? 0) + 1);
    }
  }

  private readCcSessionName(cliSessionId: string): string | null {
    try {
      const dir = path.join(homedir(), ".claude", "sessions");
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as { sessionId?: string; name?: string };
          if (d.sessionId === cliSessionId) return d.name?.trim() || null;
        } catch {}
      }
    } catch {}
    return null;
  }

  // 外部会话的任务清单追踪（TodoWrite / TaskCreate / TaskUpdate 增量累积）
  private trackers = new Map<string, TaskTracker>();

  // transcript 已读字节偏移：PostToolUse/Stop 时增量读出助手文本推上时间线
  private transcriptOffsets = new Map<string, number>();

  // #73 外部转录流式快照折叠：同一 message.id 的多行转录 = 同一条逻辑消息的增长
  // 快照（2026-09-19 实测：58 行 assistant 仅 19 个唯一 id，同 id 行文本逐行增长；
  // 个别尾行文本为空的分块 flush 伪影）。按 (sid, msgId, kind) 复用稳定日志 id 让
  // pushExternalLog 原地替换，时间线不再被增量快照刷屏；文本只增不减（最长快照
  // 胜出，空尾行不回退、等长重复快照不重复下发）。id 携带本次启动戳——重启后
  // 回放重建的时间线带着旧运行期的 id，seq 归零若复用裸序号会顶掉旧消息条目
  private static readonly XSTREAM_BOOT = Date.now().toString(36);
  private xstreamSeq = new Map<string, number>();
  private xchainId = new Map<string, string>(); // sid|msgId|kind -> 稳定日志 id
  private xchainBest = new Map<string, number>(); // 同 key -> 已下发最长文本长度

  // #72 上次计入总量的 usage 元组（会话 -> "in:out:cr:cw"）：转录流式快照会把同
  // 一次调用的 usage 行重复落盘 3~7 行，同元组只累计一次，否则会话 token 总量虚高
  // 数倍（实测虚到 cache_read 2.38 亿）。水位是覆盖式，天然不受重复行影响
  private lastUsageTuple = new Map<string, string>();

  // 转录末条形态：assistant 消息整条完成才落盘（生成期间零写入，纯思考可达分钟级），
  // 静默 ≠ 回合结束。可靠区分：末条是纯文本 assistant 消息 = 回合自然结束；
  // 末条是 tool_use（工具执行中）或 tool_result/新 prompt（下一条消息生成中）= 仍在回合内
  private turnShape = new Map<string, "tool" | "gen" | "end">();

  // hooks 不携带助手输出——从 transcript JSONL 增量提取 assistant 文本块。
  // 首见（或文件变小=轮转）只取最后一条，避免把历史回复全量刷进时间线；
  // 只读到行尾完整处，半行留给下次读（转录文件是追加写）。
  private pushAssistantTexts(id: string, transcriptPath?: string): void {
    if (!transcriptPath) return;
    try {
      const size = statSync(transcriptPath).size;
      const prev = this.transcriptOffsets.get(id);
      let start: number;
      let firstRead = false;
      if (prev === undefined || prev > size) {
        start = Math.max(0, size - 512 * 1024);
        firstRead = true;
      } else if (prev === size) {
        return;
      } else {
        start = prev;
      }
      const fd = openSync(transcriptPath, "r");
      const len = size - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      closeSync(fd);
      const raw = buf.toString("utf-8");
      const end = raw.lastIndexOf("\n");
      if (end < 0) return;
      this.transcriptOffsets.set(id, start + Buffer.byteLength(raw.slice(0, end + 1), "utf-8"));
      if (!firstRead) {
        if (this.lastGrow.size > 200) this.lastGrow.clear(); // 兜底上限（普通会话也在记账）
        this.lastGrow.set(id, Date.now());
        // #363 压缩完继续回合 → 转录恢复增长即清压缩标志（自动压缩后 hook 事件可能迟到）
        this.mgr.setExternalCompacting(id, false);
        const st0 = this.mgr.getExternal(id);
        // 增量增长落在 DONE 态 = 无 hook 会话（hook 会话回合首事件 UserPromptSubmit
        // 早已翻 WORKING）：翻 WORKING 让手机呼吸灯/工作状态随转录实时走。
        // ERROR 态同理——relay 重启会把无 pid 的外部会话误标 ERROR，没有 hook 事件
        // 就永远无自愈路径；转录在写 = CLI 活着。顺带清 historical：重启遗留的
        // "仅可查看"标记在会话被证活后必须解除，否则设备端永远发不了消息
        if (st0 && (st0.status === "DONE" || st0.status === "ERROR")) {
          this.noHookIds.add(id);
          if (!this.turnStart.has(id)) this.turnStart.set(id, Date.now());
          this.mgr.setExternalStatus(
            id,
            "WORKING",
            st0.status === "ERROR" ? "转录活跃（自愈：重启误标错误）" : "转录活跃（无 hook 会话）",
          );
        }
        if (st0?.historical) st0.historical = false;
      }
      const entries: { kind: "assistant_text" | "thinking" | "tool_use" | "tool_result"; text: string; tool?: string; detail?: string; msgId?: string }[] = [];
      const enqueues: string[] = [];
      const steers: string[] = [];
      const userTexts: string[] = []; // 本批真实用户 prompt 行（晋升 pending 用）
      // 类 CLI 摘要素材（#212）：无 hook/自愈会话的状态行从转录批次派生，
      // 不再长期停留在"转录活跃/自愈"这类兜底文案上
      let lastTool: { name: string; input: Record<string, unknown> } | null = null;
      let thinkPreview = "";
      // 末条形态：tool=悬置 tool_use / gen=回合推进中 / end=纯文本收尾；null=窗口内无相关行
      let shape: "tool" | "gen" | "end" | null = null;
      const taskOps: TaskOp[] = [];
      const agentNotifs: string[] = []; // 后台子 Agent 完成通知里的 tool-use-id
      const agentUses: { id: string; input: unknown }[] = []; // Agent/Task tool_use 块（真实 call id）
      const creates = this.taskCreateSet(id);
      let removes = 0;
      // token 用量/模型：assistant 条目自带 usage（逐条 API 调用量，累加为会话总量）
      let usageIn = 0;
      let usageOut = 0;
      let usageCr = 0;
      let usageCw = 0;
      let usageSeen = false;
      let ctxLast = 0; // 本轮增量中最后一条 assistant 的上下文水位（覆盖式）
      let model = "";
      for (const line of raw.slice(0, end).split("\n")) {
        // 后台子 Agent 完成通知：作为 user 消息或 attachment 行出现，取 tool-use-id 配对收尾
        //（捕获到 "<" 为止：不受 JSON 对闭合标签斜杠的转义影响）
        if (line.includes("<task-notification>")) {
          const m = /<tool-use-id>([^<]+)/.exec(line);
          if (m && m[1].trim()) agentNotifs.push(m[1].trim());
          continue;
        }
        // 宽容匹配：标准 CLI 转录是紧凑 JSON，但手写/第三方工具可能带空格
        if (/"type":\s*"queue-operation"/.test(line)) {
          try {
            const j = JSON.parse(line) as { operation?: string; content?: string };
            if (j.operation === "enqueue" && typeof j.content === "string" && j.content.trim()) enqueues.push(j.content);
            else if (j.operation === "remove") removes++;
          } catch {}
          continue;
        }
        if (/"type":\s*"attachment"/.test(line)) {
          try {
            const j = JSON.parse(line) as { attachment?: { type?: string; prompt?: string } };
            if (j.attachment?.type === "queued_command" && typeof j.attachment.prompt === "string" && j.attachment.prompt.trim()) {
              steers.push(j.attachment.prompt);
            }
          } catch {}
          continue;
        }
        if (!/"type":\s*"assistant"/.test(line)) {
          // 非 assistant 行（tool_result / 新 prompt / system 等）：回合仍在推进——
          // tool_result 之后 CLI 必生成下一条消息，prompt 之后同样
          shape = "gen";
          // 真实用户 prompt 行（string content 或纯 text 块数组；含 tool_result 等混合块整行跳过）：
          // 提取出来晋升 pending——hook 死亡/无 hook 会话的 UserPromptSubmit 断流由转录兜底
          if (userTexts.length < 16 && /"type":\s*"user"/.test(line)) {
            try {
              const j = JSON.parse(line) as { isMeta?: boolean; message?: { content?: unknown } };
              const c = j.message?.content;
              let t = "";
              if (!j.isMeta && typeof c === "string") t = c;
              else if (
                !j.isMeta &&
                Array.isArray(c) &&
                c.every((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
              ) {
                t = (c as { text?: unknown }[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("");
              }
              t = t.trim();
              // #292 系统包装块（后台任务通知/命令回显/系统提醒）与含后台任务输出
              // 路径的机器文本不作为用户输入（规则单源在 summarizer.isMachineUserText）
              if (t && !isMachineUserText(t)) userTexts.push(t);
            } catch {}
          }
          // user 行的 tool_result：TaskCreate 的结果文本（"Task #N created successfully"）
          if (line.includes("created successfully")) {
            try {
              const j = JSON.parse(line) as { message?: { content?: unknown[] } };
              if (Array.isArray(j.message?.content)) Bridge.collectTaskOps(j.message.content, taskOps, creates);
            } catch {}
          }
          continue;
        }
        try {
          const j = JSON.parse(line) as { message?: { id?: unknown; content?: unknown[]; usage?: Record<string, unknown>; model?: unknown } };
          const mu = j.message?.usage;
          if (mu && typeof mu === "object") {
            const inc = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
            const tuple = `${inc(mu.input_tokens)}:${inc(mu.output_tokens)}:${inc(mu.cache_read_input_tokens)}:${inc(mu.cache_creation_input_tokens)}`;
            // 同元组重复行（流式快照）只计一次总量；零值行（流中断 glitch）不计不记账
            if (tuple !== "0:0:0:0" && tuple !== this.lastUsageTuple.get(id)) {
              if (this.lastUsageTuple.size > 200) this.lastUsageTuple.clear();
              this.lastUsageTuple.set(id, tuple);
              usageIn += inc(mu.input_tokens);
              usageOut += inc(mu.output_tokens);
              usageCr += inc(mu.cache_read_input_tokens);
              usageCw += inc(mu.cache_creation_input_tokens);
            }
            usageSeen = true;
            ctxLast = inc(mu.input_tokens) + inc(mu.cache_read_input_tokens) + inc(mu.cache_creation_input_tokens);
          }
          if (typeof j.message?.model === "string" && j.message.model) model = Bridge.modelDisplayName() ?? j.message.model;
          // #73 增长链锚点：同一条消息的流式快照行共享 message.id（msg_*），链按它
          // 识别；缺 id（异常转录）退化为旧行为——每行独立条目，不折叠也不误合
          const msgId = typeof j.message?.id === "string" && j.message.id ? j.message.id : "";
          const content = j.message?.content;
          if (!Array.isArray(content)) continue;
          Bridge.collectTaskOps(content, taskOps, creates);
          const texts: string[] = [];
          const thinks: string[] = [];
          // z.ai 内置工具桥的展示文本（过程噪声，常带超长 URL/字面 \n 的 JSON）：
          // 归工具类日志，客户端"消息"视图按 kind 过滤即自动隐藏。
          // 先收集：content 顺序上 zai 注入对（调用→结果）在正文之前，循环内即时
          // push 会排在 thinking/正文之前，时间线倒挂
          const zaiEntries: { kind: "tool_use" | "tool_result"; text: string; tool: string; detail: string }[] = [];
          // #265 混合形态（正文+桥文本同块）拆出的段：位于正文之后，排在 zaiEntries 后
          const zaiMixed: { kind: "tool_use" | "tool_result"; text: string; tool: string; detail: string }[] = [];
          let hasToolUse = false;
          for (const b of content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown };
            if (blk.type === "text" && typeof blk.text === "string") {
              // #292 块首系统包装块（zai 图片占位提醒等系统注入与正文同块）：
              // 剥离后再进正文/桥识别，纯包装块整条不产生消息
              const clean = stripLeadingSystemBlocks(blk.text);
              if (!clean) continue;
              const zn = zaiToolName(clean);
              if (zn) {
                hasToolUse = true;
                zaiEntries.push({ kind: "tool_use", text: `zai 内置 ${zn.slice(4)} 调用`, tool: zn, detail: capDetail(clean, 2000) });
                continue;
              }
              if (isZaiOutput(clean)) {
                zaiEntries.push({ kind: "tool_result", text: "zai 内置工具结果", tool: "zai", detail: capDetail(clean, 2000) });
                continue;
              }
              // 混合形态：正文尾部被 z.ai append 了桥调用/输出（#265）——拆段，
              // 前后正文保留，桥段归工具日志
              const { body, segs } = splitZaiText(clean);
              for (const sg of segs) {
                if (sg.kind === "tool_use") hasToolUse = true;
                zaiMixed.push({
                  kind: sg.kind,
                  text: sg.kind === "tool_use" ? `zai 内置 ${sg.tool.slice(4)} 调用` : "zai 内置工具结果",
                  tool: sg.kind === "tool_use" ? sg.tool : "zai",
                  detail: capDetail(sg.raw, 2000),
                });
              }
              if (body) texts.push(body);
            }
            else if (blk.type === "thinking" && typeof blk.thinking === "string") {
              thinks.push(blk.thinking);
              if (!thinkPreview) thinkPreview = blk.thinking;
            } else if (blk.type === "tool_use") {
              hasToolUse = true;
              lastTool = {
                name: typeof blk.name === "string" ? blk.name : "",
                input: ((b as { input?: unknown }).input ?? {}) as Record<string, unknown>,
              };
              if (blk.name === "Agent" || blk.name === "Task") {
                agentUses.push({ id: typeof blk.id === "string" ? blk.id : "", input: (b as { input?: unknown }).input });
              }
            }
          }
          shape = hasToolUse ? "tool" : "end";
          // content 顺序上 thinking 在正文之前；每行各合并为一条。
          // 混合拆出的桥段在正文之后（append 形态所致），排在正文后
          const th = thinks.join("\n").trim();
          if (th) entries.push({ kind: "thinking", text: th, msgId });
          entries.push(...zaiEntries);
          const tx = texts.join("\n").trim();
          if (tx) entries.push({ kind: "assistant_text", text: tx, msgId });
          entries.push(...zaiMixed);
        } catch {}
      }
      // 末条形态记账（首读也算：relay 重启可能正落在回合中途）
      if (shape !== null) {
        if (this.turnShape.size > 200) this.turnShape.clear();
        this.turnShape.set(id, shape);
      }
      // 类 CLI 摘要升级（#212）：无 hook 会话（持续）与刚从兜底文案翻 WORKING 的会话，
      // 用本批最后一条 tool_use / thinking 预览替代"转录活跃/自愈"类占位文本；
      // 有 hook 的会话 PreToolUse 自带更及时的摘要，不碰
      if (!firstRead) {
        const derived = lastTool
          ? summarizeToolUse(lastTool.name || "tool", lastTool.input)
          : thinkPreview
            ? `思考中: ${truncate(thinkPreview, 60)}`
            : "";
        const st1 = this.mgr.getExternal(id);
        if (
          derived &&
          st1 &&
          st1.status === "WORKING" &&
          derived !== st1.action_summary &&
          (this.noHookIds.has(id) || /^转录活跃|^自愈：/.test(st1.action_summary ?? ""))
        ) {
          this.mgr.setExternalStatus(id, "WORKING", derived);
        }
      }
      // 首读（relay 重启/新接入）只回放最后一条正文，thinking 不回放避免刷屏；排队台账不回放（陈旧）
      const emit = firstRead ? entries.filter((e) => e.kind === "assistant_text").slice(-1) : entries;
      for (const e of emit) this.emitTranscriptEntry(id, e);
      if (!firstRead) {
        for (const t of enqueues) this.onQueueEnqueue(id, t);
        for (const t of steers) this.onSteerDelivered(id, t);
        if (removes > steers.length) this.onQueueDiscard(id, removes - steers.length);
        // hook 断流兜底：transcript 用户行晋升 pending。只晋升不新记（防与 UPS hook 双记）：
        // hook 在时 UPS 先到先晋升、这里无匹配静默；hook 死时这里补位——根治消息滞留排队闪烁
        for (const t of userTexts) this.promotePending(id, t);
      }
      // 子 Agent：先补/升级 tool_use 条目（同批快速完成时通知才有配对目标），再按通知收尾
      for (const u of agentUses) this.observeAgentUse(id, u);
      for (const n of agentNotifs) this.closeSubagentByNotification(id, n);
      // 任务清单：CLI 任务存储目录优先（权威、变更检测防重发），无目录再 transcript 回放/增量。
      // store 命中过至少一次后目录消失（CLI 清理/换代）不再回退 tracker——陈旧基线会覆写权威快照
      const storeTodos = this.readTaskStore(id);
      if (storeTodos) {
        const j = JSON.stringify(storeTodos);
        if (this.lastTodos.get(id) !== j) {
          if (this.lastTodos.size > 60) this.lastTodos.clear();
          this.lastTodos.set(id, j);
          this.mgr.setTodos(id, storeTodos);
        }
      } else if (!this.lastTodos.has(id)) {
        if (firstRead) this.replayTaskHistory(id, transcriptPath);
        else if (taskOps.length) {
          const tr = this.ensureTracker(id);
          for (const op of taskOps) {
            const todos = op.result ? tr.feedResult(op.result) : tr.feed(op.tool as string, op.input);
            if (todos) this.mgr.setTodos(id, todos);
          }
        }
      }
      // #35 输出物：首读全文件回放重建（转录轮转/shrink 重触 firstRead 也安全——
      // setArtifacts 整体替换，天然幂等不双计）
      if (firstRead) this.replayArtifacts(id, transcriptPath);
      if (usageSeen || model) {
        // 首读以窗口内条目做种子（relay 重启后的近似值）；此后增量累加
        let u = this.extUsage.get(id);
        if (!u || firstRead) {
          if (this.extUsage.size > 60) this.extUsage.clear();
          u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "", ctx: 0 };
          this.extUsage.set(id, u);
        }
        u.input += usageIn;
        u.output += usageOut;
        u.cacheRead += usageCr;
        u.cacheWrite += usageCw;
        if (usageSeen) u.ctx = ctxLast;
        if (model) u.model = model;
        this.mgr.setExternalUsage(
          id,
          { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
          u.model || undefined,
          u.ctx || undefined,
        );
      }
    } catch {}
  }

  // #73 转录条目下发（pushAssistantTexts 专用）：带 msgId 的 assistant_text/
  // thinking 走增长链——同 key 复用稳定日志 id（pushExternalLog 原地替换），文本
  // 只增不减（空尾行 flush 伪影不回退、等长重复快照不重复下发）；zai/工具类条目
  // 无 msgId，维持旧语义（每条独立）
  private emitTranscriptEntry(
    id: string,
    e: { kind: "assistant_text" | "thinking" | "tool_use" | "tool_result"; text: string; tool?: string; detail?: string; msgId?: string },
  ): void {
    let logId: string | undefined;
    if ((e.kind === "assistant_text" || e.kind === "thinking") && e.msgId) {
      const key = `${id}|${e.msgId}|${e.kind}`;
      logId = this.xchainId.get(key);
      if (!logId) {
        const n = (this.xstreamSeq.get(id) ?? 0) + 1;
        this.xstreamSeq.set(id, n);
        // 兜底上限：超量整表清空（链内中途被清的极端代价 = 该条消息拆回两条，可接受）
        if (this.xchainId.size > 400 || this.xchainBest.size > 400) {
          this.xchainId.clear();
          this.xchainBest.clear();
        }
        logId = `xstream-${Bridge.XSTREAM_BOOT}-${n}`;
        this.xchainId.set(key, logId);
      }
      const best = this.xchainBest.get(key) ?? 0;
      if (e.text.length <= best) return; // 回退/重复快照：保持已下发的更长文本
      this.xchainBest.set(key, e.text.length);
    }
    this.mgr.pushExternalLog(id, e.kind, truncate(e.text, 400), e.tool, {
      full: fullText(e.text, 400),
      ...(e.detail ? { detail: e.detail } : {}),
      ...(logId ? { id: logId } : {}),
    });
  }

  // 文件改动统计：Edit/Write/MultiEdit/NotebookEdit 结果的 +/- 行累计（统计页数据源）。
  // #35 同点位顺路喂输出物清单（mergeArtifact 咽喉点）；增删行/新建判定统一走
  // fileEditMetrics（+++ / --- 头行不计入，修掉旧内联计数的小高估）
  private feedFileStats(id: string, ev: BridgeEvent): void {
    const tool = ev.tool_name ?? "";
    if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit" && tool !== "NotebookEdit") return;
    const r = ev.tool_response as
      | { structuredPatch?: unknown; content?: unknown; filePath?: unknown; file_path?: unknown }
      | null
      | undefined;
    if (!r || typeof r !== "object") return;
    const m = fileEditMetrics(r);
    if (!m) return;
    const input = (ev.tool_input ?? {}) as { file_path?: unknown };
    const file =
      typeof r.filePath === "string" ? r.filePath :
      typeof r.file_path === "string" ? r.file_path :
      typeof input.file_path === "string" ? input.file_path :
      "(未知文件)";
    let st = this.extFileStats.get(id);
    if (!st) {
      st = { files: new Set(), added: 0, deleted: 0 };
      if (this.extFileStats.size > 60) this.extFileStats.clear();
      this.extFileStats.set(id, st);
    }
    st.files.add(file);
    st.added += m.adds;
    st.deleted += m.dels;
    this.mgr.setExternalStats(id, { files_changed: st.files.size, lines_added: st.added, lines_deleted: st.deleted });
    // 输出物清单（"(未知文件)"在 mergeArtifact 内挡掉；相对路径由其以 cwd 补全）
    this.mgr.mergeArtifact(id, { path: file, tool, adds: m.adds, dels: m.dels, created: m.created, ts: Date.now() });
  }

  // #35 输出物回放：转录全文件分块扫（先例 replayTaskHistory 的读法）。
  // tool_use 行（四类文件工具，入参含 file_path）记 callId → {tool, path}，
  // tool_result 行按 tool_use_id 配对回取结构化结果；行门 = file_path/filePath/
  // structuredPatch/gitDiff（配对两侧任一必含其一，未命中行直接跳过省 JSON.parse）
  private replayArtifacts(id: string, path: string): void {
    const items: { path: string; tool: string; adds: number; dels: number; created: boolean; ts: number }[] = [];
    const uses = new Map<string, { tool: string; path: string }>();
    try {
      const size = statSync(path).size;
      const fd = openSync(path, "r");
      const CHUNK = 8 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let carry = "";
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        const text = carry + buf.toString("utf-8", 0, n);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const hasFileKw =
            line.includes("file_path") || line.includes("filePath") ||
            line.includes("structuredPatch") || line.includes("gitDiff");
          // 结果行可能只带 type/content（无 filePath/patch 关键字）——有账目待配对时
          // 也放行 tool_use_id 行（无账目时纯布尔短路，不付 JSON.parse 成本）
          if (!hasFileKw && !(uses.size > 0 && line.includes("tool_use_id"))) continue;
          type TrLine = { timestamp?: unknown; message?: { content?: unknown }; tool_use_result?: unknown };
          let j: TrLine | null = null;
          try {
            j = JSON.parse(line) as TrLine;
          } catch {
            continue;
          }
          if (!j || !Array.isArray(j.message?.content)) continue;
          const parsed = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
          const at = Number.isFinite(parsed) ? parsed : Date.now();
          for (const b of j.message.content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: string; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown };
            if (blk.type === "tool_use") {
              const name = typeof blk.name === "string" ? blk.name : "";
              if (name !== "Write" && name !== "Edit" && name !== "MultiEdit" && name !== "NotebookEdit") continue;
              const fp = (blk.input as { file_path?: unknown } | null)?.file_path;
              if (typeof fp === "string" && fp && typeof blk.id === "string") {
                uses.set(blk.id, { tool: name, path: fp });
                if (uses.size > 512) uses.delete(uses.keys().next().value as string);
              }
            } else if (blk.type === "tool_result" && typeof blk.tool_use_id === "string") {
              const use = uses.get(blk.tool_use_id);
              if (!use) continue;
              uses.delete(blk.tool_use_id);
              const m = fileEditMetrics(j.tool_use_result ?? blk.content);
              if (m) items.push({ path: use.path, tool: use.tool, adds: m.adds, dels: m.dels, created: m.created, ts: at });
            }
          }
        }
        pos += n;
      }
      closeSync(fd);
    } catch {
      return;
    }
    this.mgr.setArtifacts(id, items);
  }

  // 首见/轮转（firstRead）：全文件回放任务工具调用重建完整清单。
  // 旧方案靠 hook 事件增量累积，relay 每次重启都从零开始（手机端 7/18 ≠ 实际的根因）；
  // transcript 是唯一完整事实源。预过滤 + 分块读，108MB 转录一次性扫描 ~1s。
  // 工具串行执行，use/result 按文件顺序回放即可正确配对（callId 交集做结果匹配）。
  private replayTaskHistory(id: string, path: string): void {
    const ops: TaskOp[] = [];
    const creates = new Set<string>();
    try {
      const size = statSync(path).size;
      const fd = openSync(path, "r");
      const CHUNK = 8 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let carry = "";
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        const text = carry + buf.toString("utf-8", 0, n);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes("TodoWrite") && !line.includes("created successfully")) continue;
          try {
            const j = JSON.parse(line) as { message?: { content?: unknown[] } };
            if (Array.isArray(j.message?.content)) Bridge.collectTaskOps(j.message.content, ops, creates);
          } catch {}
        }
        pos += n;
      }
      closeSync(fd);
    } catch {
      return;
    }
    const tr = new TaskTracker();
    this.trackers.set(id, tr);
    for (const op of ops) {
      const todos = op.result ? tr.feedResult(op.result) : tr.feed(op.tool as string, op.input);
      if (todos) this.mgr.setTodos(id, todos);
    }
  }

  // transcript content 块 → 任务操作序列（tool_use 直接收；tool_result 仅认已见 TaskCreate 的
  // "Task #N created successfully" 文本，经 callId 配对回填真实任务号）
  private static collectTaskOps(content: unknown[], ops: TaskOp[], creates: Set<string>): void {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const blk = b as { type?: string; name?: unknown; input?: unknown; id?: unknown; tool_use_id?: unknown; content?: unknown };
      if (blk.type === "tool_use") {
        const name = typeof blk.name === "string" ? blk.name : "";
        if (name !== "TaskCreate" && name !== "TaskUpdate" && name !== "TodoWrite") continue;
        ops.push({ tool: name, input: blk.input });
        if (name === "TaskCreate" && typeof blk.id === "string") creates.add(blk.id);
      } else if (blk.type === "tool_result" && typeof blk.tool_use_id === "string" && creates.has(blk.tool_use_id)) {
        const c = blk.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? (c as { type?: string; text?: unknown }[]).map((x) => (x && typeof x === "object" && x.type === "text" && typeof x.text === "string" ? x.text : "")).join("")
          : "";
        const m = /Task #(\d+) created successfully/.exec(text);
        if (m) ops.push({ result: { task: { id: Number(m[1]) } } });
      }
    }
  }

  // 增量批次里见过的 TaskCreate callId（跨批次配对 result 用）
  private taskCalls = new Map<string, Set<string>>();

  private taskCreateSet(id: string): Set<string> {
    let set = this.taskCalls.get(id);
    if (!set) {
      if (this.taskCalls.size > 60) this.taskCalls.clear();
      set = new Set();
      this.taskCalls.set(id, set);
    }
    return set;
  }

  // CLI 任务存储目录（~/.claude/tasks/<cli_session>/*.json）：权威清单，与 /tasks 实时一致
  // （会话压缩/任务清理后也对）。目录不存在（旧版 CLI/其他会话形态）返回 null 走 transcript 兜底。
  // 直读逻辑已抽到 task-store.ts，SessionManager 30s 轮询同源（#206）
  private lastTodos = new Map<string, string>();

  private readTaskStore(id: string): TodoItem[] | null {
    return readTaskStoreTodos(id.startsWith("ext-") ? id.slice(4) : id);
  }

  // 手动刷新：清掉 JSON 变更检测的缓存，强制重读任务存储并重发（绕过"内容没变不推"）
  refreshTodos(sessionId: string): { ok: boolean; error?: string } {
    try {
      const t = this.readTaskStore(sessionId);
      this.lastTodos.delete(sessionId);
      if (t) this.mgr.setTodos(sessionId, t);
      else {
        const cur = this.mgr.getExternal(sessionId)?.todos;
        if (cur) this.mgr.setTodos(sessionId, cur.map((x) => ({ ...x })));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 隐藏任务清单条目：CLI 任务存储无法外部真删——记 normKey 进隐藏集（持久化），
  // 再把当前 todos 重过一遍 setTodos（过滤在 SessionManager.setTodos 咽喉点）触发 SESSION_UPDATED。
  // 重复隐藏幂等；找不到匹配条目也回 ok（手机端有本地乐观过滤）
  hideTodo(sessionId: string, content: string): { ok: boolean; error?: string } {
    try {
      const text = content.trim();
      if (!text) return { ok: false, error: "content 不能为空" };
      addHiddenTodoKey(sessionId, normKey(text));
      const cur = this.mgr.getExternal(sessionId)?.todos;
      if (cur?.length) this.mgr.setTodos(sessionId, cur.map((x) => ({ ...x })));
      this.injectTodoDelete(sessionId, text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 删除闭环：显示层靠隐藏键过滤，但 CLI 本地任务存储无法外部真删——注入一条简短
  // 指令让会话本体在下一回合把该条目从自己的任务列表同步删除，两端才不会"删了又冒回来"
  private injectTodoDelete(sessionId: string, text: string): void {
    const st = this.mgr.getExternal(sessionId);
    if (!st) return;
    const q = this.inputQueue.get(sessionId) ?? [];
    q.push(`[移动端删除任务] 用户删除了任务清单条目：「${truncate(text, 120)}」。请将该条目从你的本地任务列表同步删除（任务工具置 deleted 或移除），不要重新创建或继续处理它。本条为系统通知，简短确认即可。`);
    this.inputQueue.set(sessionId, q);
    if ((st.status === "DONE" || st.status === "WORKING" || st.status === "ERROR") && !this.flushing.has(sessionId)) {
      void this.flushQueue(sessionId);
    }
  }

  private ensureTracker(id: string): TaskTracker {
    let tr = this.trackers.get(id);
    if (!tr) {
      if (this.trackers.size > 60) this.trackers.clear(); // 防泄漏兜底
      tr = new TaskTracker();
      // relay 重启后 tracker 丢了：用会话最后已知清单做种子（无任务号，仅保展示不丢）
      tr.seed(this.mgr.getExternal(id)?.todos ?? []);
      this.trackers.set(id, tr);
    }
    return tr;
  }

  private async onPreToolUse(ev: BridgeEvent): Promise<BridgeDecision> {
    const id = this.extId(ev);
    this.mgr.ensureExternal(id, ev.cwd, "", ev.session_id);
    const input = (ev.tool_input ?? {}) as Record<string, unknown>;
    // 子 Agent 派生追踪（Agent/Task 双名防御别名）：Pre 到达即建 running 条目
    if (ev.tool_name === "Agent" || ev.tool_name === "Task") this.trackSubagentStart(id, ev);
    // AskUserQuestion：解析结构化问题（门控时客户端渲染选项作答）
    const questions = ev.tool_name === "AskUserQuestion" ? parseAskQuestions(input) : [];
    const summary = questions.length
      ? `提问: ${questions.map((q) => q.header).join(" / ")}`
      : summarizeToolUse(ev.tool_name ?? "tool", input);

    const remote = !!this.mgr.getExternal(id)?.remote_mode;
    const shouldGate =
      // AskUserQuestion 不是权限决策而是必需输入：不要求 remote_mode，手机在线就下发选项
      (questions.length > 0 ||
        (remote &&
          this.opts.gateTools.has(ev.tool_name ?? "") &&
          ev.permission_mode !== "bypassPermissions")) &&   // 权限类：终端切到 skip 模式 = 用户显式放弃门控
      this.opts.hasClients();                                // 手机在线才拦截

    if (!shouldGate) {
      // 提问遇手机离线：CLI 立即弹本地选择器，但仍登记提问横幅——手机稍后重连（SNAPSHOT）
      // 即见横幅可晚答（askFallback 注入送达）；PC 先答由 PostToolUse 收尾。权限类不登记。
      if (questions.length) {
        const requestId = randomUUID();
        this.mgr.setExternalWaiting(id, {
          request_id: requestId,
          tool_name: ev.tool_name ?? "tool",
          input_summary: summary,
          suggestions: [],
          decidable: true,
          questions,
        });
        this.askFallback.set(id, { requestId, questions });
      } else {
        this.mgr.setExternalStatus(id, "WORKING", summary);
      }
      this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name, {
        detail: detailToolUse(ev.tool_name ?? "tool", input),
      });
      return { decision: "pass" };
    }

    // 挂起等远程决定
    const requestId = randomUUID();
    const payload: WaitingPayload = {
      request_id: requestId,
      tool_name: ev.tool_name ?? "tool",
      input_summary: summary,
      suggestions: [],
      decidable: true,
      ...(questions.length ? { questions } : {}),
    };
    this.mgr.setExternalWaiting(id, payload);
    this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name, {
      detail: detailToolUse(ev.tool_name ?? "tool", input),
    });

    // 权限类长挂起（590s）；提问类 90s 窗口——手机先答则 updatedInput 注入答案（PC 不再弹）；
    // 超时放行 CLI 本地选择器但手机横幅保留（askFallback），晚答仍可送达，两端任一先答即生效
    const holdMs = questions.length
      ? this.opts.questionHoldMs ?? QUESTION_HOLD_MS
      : this.opts.holdMs ?? DEFAULT_HOLD_MS;
    return new Promise<BridgeDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (questions.length) {
          // 提问超时：CLI 弹本地选择器，手机横幅保留可继续作答；PC 先答由 PostToolUse 清横幅
          this.askFallback.set(id, { requestId, questions });
        } else {
          this.mgr.setExternalStatus(id, "WORKING", summary);
          this.bus.emit(id, "SESSION_WAITING_RESOLVED", { request_id: requestId, decision: "timeout", by: "relay" });
        }
        resolve({ decision: "pass" });   // 回退 CLI 正常权限流程（提问=本地选择器）
      }, holdMs);
      timer.unref();
      this.pending.set(id, {
        sessionId: id,
        requestId,
        resolve,
        timer,
        ...(questions.length ? { questions, toolInput: input } : {}),
      });
    });
  }

  private onPostToolUse(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    // 子 Agent 收尾：非后台条目按 tool_use id（或串行兜底）置 ended；后台条目忽略——
    // 后台 spawn 的 PostToolUse 在派生瞬间就返回，真实结束靠 transcript 的 <task-notification>
    if (ev.tool_name === "Agent" || ev.tool_name === "Task") this.trackSubagentEnd(id, ev);
    this.mgr.pushExternalLog(id, "tool_result", summarizeToolResult(ev.tool_response), undefined, {
      detail: detailToolResult(ev.tool_response),
      diff: diffLines(ev.tool_response),
    });
    this.feedFileStats(id, ev);
    this.pushAssistantTexts(id, ev.transcript_path);
    // 清除 passive WAITING（CLI 本地已处理）
    if (state.status === "WAITING" && state.waiting_request?.decidable === false) {
      this.mgr.setExternalStatus(id, "WORKING", state.action_summary);
    }
    // 提问兜底收尾：PC 端已在本地选择器作答/取消 → 手机横幅收起
    //（兜底表被重启清掉时也要收——waiting 状态还在，按状态里的 request_id 结）
    if (ev.tool_name === "AskUserQuestion" && state.status === "WAITING" && state.waiting_request?.decidable) {
      const fb = this.askFallback.get(id);
      this.askFallback.delete(id);
      this.mgr.emitWaitingResolved(id, fb?.requestId ?? state.waiting_request.request_id, "answered", "cli");
    }
    return { decision: "pass" };
  }

  private onNotification(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    const msg = ev.message ?? "";
    if (/permission/i.test(msg)) {
      // CLI 在本地等权限确认：通知手机，但远程无法决定（无挂起通道）。
      // 从消息里抠工具名（"Claude needs your permission to use Update"→"Update"），
      // 否则手机状态条只能显示空荡荡的"等待确认："（#271）。
      // 剥尾标点 + 滤停用词："to use the WebFetch tool" 会抓到 the，非空错提取
      // 反而屏蔽手机端 input_summary 回退，比留空更差
      const m = /to use (\S+)/i.exec(msg);
      const rawName = m ? m[1].replace(/[.,;:!?)+]+$/, "") : "";
      const toolName = /^(the|a|an|this|that)$/i.test(rawName) ? "" : rawName;
      // #47（2026-09-11 用户实测）：AskUserQuestion 挂起 90s 超时放行本地选择器后，
      // CLI 会对着本地弹出的选择器再发一条 "needs your permission" 通知——不带
      // 此守卫会把带 questions 的横幅覆盖成 passive（decidable=false 无选项），
      // 手机/桌面端从「可作答的问题」塌缩成「请在电脑上处理」，晚答兜底也断链
      //（waiting_request.questions 被抹掉）。提问横幅在场时 permission 通知静默。
      if (state.waiting_request?.questions?.length) {
        return { decision: "pass" };
      }
      this.mgr.setExternalWaiting(id, {
        request_id: randomUUID(),
        tool_name: toolName,
        input_summary: msg,
        suggestions: [],
        decidable: false,
      });
    } else if (/waiting for your input/i.test(msg) && state.status === "WORKING") {
      // Esc 打断的回合不触发 Stop hook，CLI 空闲 60s 通知是唯一回退信号：
      // 视作回合结束（状态回落 DONE + flush 排队输入），迟于真实打断 ≤60s
      const turn = this.turnStart.get(id) ?? state.started_at;
      this.turnStart.delete(id);
      this.mgr.finishExternal(id, "completed", Date.now() - turn);
      this.mgr.pushExternalLog(id, "system", "空闲回退：未收到 Stop（回合可能被打断），已标记结束");
      if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    } else {
      this.mgr.pushExternalLog(id, "system", truncate(msg, 120));
    }
    return { decision: "pass" };
  }

  private onStop(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.refreshName(id, ev);
    this.pushAssistantTexts(id, ev.transcript_path);
    // 回合结束：已在回合中消费的 steering 消息（不在注入队列里）晋升为正式消息；
    // 仍在队列里的即将注入，等 CLI 处理时的 UserPromptSubmit 晋升（避免双气泡）
    const avail = [...(this.inputQueue.get(id) ?? [])];
    const kept: PendingInput[] = [];
    for (const p of state.pending_inputs ?? []) {
      const qi = avail.findIndex((t) => normKey(t) === normKey(pBody(p)));
      if (qi === -1) {
        this.noteUserMsg(id, pBody(p), "promote");
        this.mgr.pushExternalLog(id, "user_message", truncate(p.text, 300), undefined, { full: truncate(p.text, 2000) });
      } else {
        avail.splice(qi, 1); // 只做匹配记账，不动原队列（flushQueue 随后要注入）
        kept.push(p);
      }
    }
    if ((state.pending_inputs?.length ?? 0) !== kept.length) this.mgr.setExternalPending(id, kept);
    this.resetStuckWatch(id); // #111：Stop 出队晋升同权，重置滞留快窗
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, "completed", Date.now() - turn);
    if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    return { decision: "pass" };
  }

  private onSessionEnd(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.mgr.pushExternalLog(id, "system", "会话结束" + (ev.reason ? ` (${ev.reason})` : ""));
    const dropped = this.inputQueue.get(id)?.length ?? 0;
    this.inputQueue.delete(id);
    this.askFallback.delete(id);
    if (state.pending_inputs?.length) this.mgr.setExternalPending(id, []);
    if (dropped) this.mgr.pushExternalLog(id, "system", `会话结束，弃 ${dropped} 条排队消息`);
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, ev.reason ?? "ended", Date.now() - turn);
    // 主动关闭收口：同步清除客户端会话卡片（区别于异常断开的保留可恢复）。
    // 用户随后手动 claude --resume 同 id 仍会经 hooks 重新登记（墓碑只挡历史重放）
    this.mgr.deleteSession(id);
    return { decision: "pass" };
  }

  // ---------- 子 Agent 工作状态（SessionState.subagents）----------

  private static subagentDesc(input: Record<string, unknown>): string {
    const d = typeof input.description === "string" ? input.description.trim() : "";
    if (d) return truncate(d, 80);
    return truncate(String(input.prompt ?? "").trim(), 80) || "(子代理)";
  }

  // PreToolUse(Agent/Task)：建 running 条目（幂等：同 tool_use id 不重建）
  private trackSubagentStart(id: string, ev: BridgeEvent): void {
    const input = (ev.tool_input ?? {}) as Record<string, unknown>;
    const tuId = typeof ev.tool_use_id === "string" && ev.tool_use_id ? ev.tool_use_id : `ag-${++this.subagentSeq}`;
    const list = [...(this.mgr.getExternal(id)?.subagents ?? [])];
    if (list.some((x) => x.id === tuId)) return;
    const entry: SubagentInfo = {
      id: tuId,
      desc: Bridge.subagentDesc(input),
      kind: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general",
      bg: input.run_in_background === true,
      started_at: Date.now(),
    };
    list.push(entry);
    if (list.length > 30) list.splice(0, list.length - 30);
    this.mgr.setExternalSubagents(id, list);
  }

  // PostToolUse(Agent/Task)：id 命中或串行兜底（CLI 工具串行）收尾最近的 running 非后台条目；
  // bg 条目忽略（结束靠 task-notification）
  private trackSubagentEnd(id: string, ev: BridgeEvent): void {
    const list = this.mgr.getExternal(id)?.subagents;
    if (!list?.length) return;
    const tuId = typeof ev.tool_use_id === "string" ? ev.tool_use_id : "";
    let i = tuId ? list.findIndex((x) => x.id === tuId) : -1;
    if (i === -1) {
      for (let k = list.length - 1; k >= 0; k--) {
        if (!list[k].ended_at && !list[k].bg) {
          i = k;
          break;
        }
      }
    }
    if (i === -1 || list[i].bg || list[i].ended_at) return;
    // 不可原地改 list：它就是 state.subagents 的引用，先改会让 setExternalSubagents
    // 的 JSON 对比判定"无变化"而不下发（手机端永远收不到 ended）
    this.mgr.setExternalSubagents(id, list.map((x, k) => (k === i ? { ...x, ended_at: Date.now() } : { ...x })));
  }

  // transcript 里的 Agent tool_use 块（真实 call_xxx id）：
  //  - hook 未带 tool_use_id 时 Pre 建的是合成 id（ag-N）——升级为真实 id，后续 task-notification 才能配对
  //  - relay 重启等原因错过 Pre hook 的后台派生：补建条目（结束靠 task-notification）
  // 注意 list 取法必须是 `?? []`（与 trackSubagentStart 对齐）：state.subagents 初始
  // 是 undefined，早先的 `if (!list) return` 把"补建条目"路径整个堵死——relay 重启后
  // 第一个后台子 Agent 永远建不起来，手机/桌面全程误报空闲（#100 复发的第一根因）
  private observeAgentUse(id: string, use: { id: string; input: unknown }): void {
    if (!use.id) return;
    const list = this.mgr.getExternal(id)?.subagents ?? [];
    if (list.some((x) => x.id === use.id)) return;
    const input = (use.input ?? {}) as Record<string, unknown>;
    const desc = Bridge.subagentDesc(input);
    for (let k = list.length - 1; k >= 0; k--) {
      const x = list[k];
      if (!x.ended_at && x.id.startsWith("ag-") && normKey(x.desc) === normKey(desc)) {
        const next = list.map((y, i2) => (i2 === k ? { ...y, id: use.id } : y));
        this.mgr.setExternalSubagents(id, next);
        return;
      }
    }
    if (input.run_in_background === true) {
      const next = [...list, {
        id: use.id,
        desc,
        kind: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general",
        bg: true,
        started_at: Date.now(),
      }];
      if (next.length > 30) next.splice(0, next.length - 30);
      this.mgr.setExternalSubagents(id, next);
    }
  }

  // transcript 里 <task-notification> 的 tool-use-id：收尾后台子 Agent
  // （通知可能作为 user 消息或 attachment 行出现，识别在 pushAssistantTexts 的行扫描里做）
  private closeSubagentByNotification(id: string, toolUseId: string): void {
    const list = this.mgr.getExternal(id)?.subagents;
    if (!list?.length) return;
    let i = list.findIndex((x) => x.id === toolUseId);
    if (i === -1) {
      // hook 未带 id、合成条目未升级成功：退而收尾最老的 running 后台条目（合成 id）
      i = list.findIndex((x) => !x.ended_at && x.bg && x.id.startsWith("ag-"));
    }
    if (i === -1 || list[i].ended_at) return;
    // 同上：禁止原地改共享引用，否则变更检测吞掉 ended 下发
    this.mgr.setExternalSubagents(id, list.map((x, k) => (k === i ? { ...x, ended_at: Date.now() } : { ...x })));
  }

  // TTL 清理（每轮询节拍里跑）：已结束保留 10 分钟；running 以活性账本优先——
  // 子 Agent 转录最后一次增长距令超过 30 分钟才判僵尸（真实 CLI 死亡/失控后文件
  // 停止增长，仍会被清）；无账本记录（旧版 CLI 无转录信号）回落 started_at 旧口径
  private sweepSubagents(): void {
    const now = Date.now();
    for (const s of this.mgr.snapshot()) {
      if (!s.external || !s.subagents?.length) continue;
      const dropped: string[] = [];
      const kept = s.subagents.filter((x) => {
        if (x.ended_at) return now - x.ended_at < this.subagentEndTtlMs;
        const ok = now - (this.subagentAlive.get(`${s.session_id}:${x.id}`) ?? x.started_at) < this.subagentRunTtlMs;
        if (!ok) dropped.push(x.id);
        return ok;
      });
      if (dropped.length) {
        // 清掉的条目同步清活性账本（防 Map 无限膨胀 + 防同 id 复用吃陈旧活性）
        const prefix = `${s.session_id}:`;
        for (const k of [...this.subagentAlive.keys()]) {
          if (k.startsWith(prefix) && dropped.includes(k.slice(prefix.length))) {
            this.subagentAlive.delete(k);
            this.subagentFileSize.delete(k);
          }
        }
      }
      if (kept.length !== s.subagents.length) this.mgr.setExternalSubagents(s.session_id, kept);
    }
    // 账本兜底上限：会话换代/极端量级时整本清空（丢失代价 = TTL 回落 started_at）
    if (this.subagentAlive.size > 500) {
      this.subagentAlive.clear();
      this.subagentFileSize.clear();
    }
  }

  // ---------- #103 子 Agent 活性（HUD 风格：会话页能看到每个子 Agent 此刻在干什么）----------
  // CLI 把每个子 Agent 的对话落盘在 <父transcript同目录>/<会话id>/subagents/agent-<agentId>.jsonl，
  // 旁有 agent-<agentId>.meta.json 且自带 toolUseId（= Task 的 tool_use id，与 SubagentInfo.id
  // 直接配对，前台/后台通吃——父 transcript 的 tool_result 只有结束才带 agentId，配不上「进行中」）。
  // tail 出最后一个 assistant tool_use 即当前动作；act 变化才触发下发
  // （setExternalSubagents 的 JSON 对比兜底，端上 3s 级感知）。文件缺失（旧版 CLI 无此
  // 目录/已被清理）静默跳过，功能自动降级为无活性
  private subagentAgentIds = new Map<string, string>(); // toolUseId -> agentId（meta 不变，配对缓存复用）

  // running 子 Agent 活性账本（sweepSubagents 僵尸判定的第二时钟）：pollSubagentActivity
  // 每节拍顺手 stat 子 Agent 转录——文件大小增长 = 还在干活，刷新最后活性时间。
  // 此前 sweep 对 running 条目按 started_at 一刀切 30min，1h+ 的真实长任务会被当
  // 僵尸清掉、状态塌回"空闲"（#100 复发的第二根因）。无转录信号（旧版 CLI 无
  // subagents 目录 / 文件未建）时回落 started_at，行为与旧版一致
  private subagentAlive = new Map<string, number>();    // `${sid}:${toolUseId}` -> 最后转录增长时间
  private subagentFileSize = new Map<string, number>(); // 同 key -> 上次见到的文件大小

  private resolveSubagentAgent(dir: string, toolUseId: string): string | null {
    const cached = this.subagentAgentIds.get(toolUseId);
    if (cached) return cached;
    if (this.subagentAgentIds.size > 500) this.subagentAgentIds.clear();
    let names: string[];
    try { names = readdirSync(dir); } catch { return null; }
    for (const n of names) {
      if (!n.startsWith("agent-") || !n.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(readFileSync(path.join(dir, n), "utf8")) as { toolUseId?: string };
        const agentId = n.slice("agent-".length, -".meta.json".length);
        if (meta.toolUseId) this.subagentAgentIds.set(meta.toolUseId, agentId);
      } catch {}
    }
    return this.subagentAgentIds.get(toolUseId) ?? null;
  }

  // 末 64KB tail 足够覆盖最近几十个回合的工具序列；首行可能被截半丢弃
  private subagentActivity(file: string): string | null {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(file); } catch { return null; }
    const start = Math.max(0, st.size - 65_536);
    let buf: Buffer;
    try {
      const fd = openSync(file, "r");
      try {
        buf = Buffer.alloc(st.size - start);
        readSync(fd, buf, 0, buf.length, start);
      } finally { closeSync(fd); }
    } catch { return null; }
    const lines = buf.toString("utf8").split("\n");
    if (start > 0 && lines.length) lines[0] = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]?.trim();
      if (!l || !l.startsWith("{")) continue;
      let e: { type?: string; message?: { content?: unknown[] } };
      try { e = JSON.parse(l) as typeof e; } catch { continue; }
      if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      const cs = e.message!.content as Array<{ type: string; name?: string; input?: unknown }>;
      for (let k = cs.length - 1; k >= 0; k--) {
        const c = cs[k];
        if (c?.type === "tool_use" && c.name) return Bridge.describeToolUse(c.name, c.input);
      }
    }
    return null;
  }

  // 工具调用 → 人话摘要：Bash 优先 description（无则命令前几个词），文件类取 basename，
  // 检索类取 pattern/query——与 CLI/HUD 呈现粒度对齐（工具名 + 一眼可辨的目标）
  private static describeToolUse(name: string, input: unknown): string {
    const inp = (input ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    let gist = "";
    switch (name) {
      case "Bash": {
        gist = str(inp.description) || str(inp.command).split(/\s+/).slice(0, 4).join(" ");
        break;
      }
      case "Read": case "Edit": case "Write": case "NotebookEdit": {
        gist = str(inp.file_path).split(/[\\/]/).pop() ?? "";
        break;
      }
      case "Grep": case "Glob": { gist = str(inp.pattern) || str(inp.query); break; }
      case "WebSearch": case "WebFetch": { gist = str(inp.query) || str(inp.url); break; }
      case "Agent": case "Task": case "Skill": { gist = str(inp.description) || str(inp.skill); break; }
      default: break;
    }
    return truncate(`${name}${gist ? " · " + gist : ""}`, 80);
  }

  // 活性轮询（主循环 3s 节拍）：只碰有 running 子 Agent 的会话；结束条目不采——
  // 定格在结束前最后动作，随 TTL 清扫
  private pollSubagentActivity(): void {
    for (const s of this.mgr.snapshot()) {
      if (!s.external || !s.subagents?.length || !s.subagents.some((x) => !x.ended_at)) continue;
      const tp = this.transcriptPaths.get(s.session_id);
      if (!tp) continue;
      const dir = path.join(path.dirname(tp), path.basename(tp).replace(/\.jsonl$/i, ""), "subagents");
      let next: SubagentInfo[] | null = null;
      for (let i = 0; i < s.subagents.length; i++) {
        const cur = s.subagents[i];
        if (cur.ended_at) continue;
        const agentId = this.resolveSubagentAgent(dir, cur.id);
        if (!agentId) continue;
        const agentFile = path.join(dir, `agent-${agentId}.jsonl`);
        // 活性账本：转录在长 = 子 Agent 在干活（同一工具跑 40 分钟不换 act 也在写
        // tool_result），比 act 变化更钝但更稳；首次见到也算活（自举）
        const aliveKey = `${s.session_id}:${cur.id}`;
        try {
          const sz = statSync(agentFile).size;
          if (this.subagentFileSize.get(aliveKey) !== sz) {
            this.subagentFileSize.set(aliveKey, sz);
            this.subagentAlive.set(aliveKey, Date.now());
          }
        } catch {}
        const act = this.subagentActivity(agentFile);
        if (act === null || act === cur.act) continue;
        next = next ?? s.subagents.map((x) => ({ ...x }));
        next[i] = { ...next[i], act, act_at: Date.now() };
      }
      if (next) this.mgr.setExternalSubagents(s.session_id, next);
    }
  }

  // ---------- 注入后主动验证（#111）+ 排队消息滞留输入框看门狗 ----------

  // #111 注入成功 ≠ 提交成功：回车在回合切换/重渲窗口被 CLI 界面层吞掉时，文字滞留
  // 输入框，原看门狗要等 10s 首窗 + 5s 轮询才补发（实测滞留 13~94s，用户「放在输入框
  // 很久才发出去」的根因）。这里改为注入后 3s 主动验证：仍在 pending（未晋升）→ 快照
  // 输入框，框内只有我们的文本即立即补发回车；已晋升/框净（CLI 原生排队）则无事发生。
  // 补发的回车本身也可能被吞——最多补验 2 轮（round），其余交看门狗兜底。
  // 守门关闭（CCR_TYPE_GUARD=off）时退回纯看门狗路径。
  private armVerify(sessionId: string, text: string, round = 0): void {
    this.disarmVerify(sessionId);
    if (!guardConfig().enabled) return;
    // 1s（原 3s）：手机实测注入→发出全程 ~10s 的主因——do script 的 Return 偶被 TUI
    // 粘贴检测吞掉后，滞留补偿链（首验→读屏判定→补发→兜验）每轮 ~3s 起步。首验
    // 提前到 1s 只影响「框内文本=我们的注入」场景；用户开始打字仍由 capture 判定
    // foreignResidual 跳过（45 段红线，本参数不触碰）
    const ms = Number(process.env.CCR_VERIFY_MS) > 0 ? Number(process.env.CCR_VERIFY_MS) : 1000;
    const timer = setTimeout(() => {
      this.verifyTimers.delete(sessionId);
      this.runVerify(sessionId, text, round);
    }, ms);
    timer.unref?.();
    this.verifyTimers.set(sessionId, { timer, text });
  }

  private disarmVerify(sessionId: string): void {
    const v = this.verifyTimers.get(sessionId);
    if (v) {
      clearTimeout(v.timer);
      this.verifyTimers.delete(sessionId);
    }
  }

  private runVerify(sessionId: string, text: string, round: number): void {
    const st = this.mgr.getExternal(sessionId);
    if (!st?.cli_pid) return;
    // 已晋升（UserPromptSubmit 已到）：不是滞留，收工
    if (!(st.pending_inputs ?? []).some((p) => normKey(pBody(p)) === normKey(text))) return;
    // 与看门狗同款前置：状态不适合补回车 / 正有 flush 或守门在跑 → 交回看门狗兜底
    if (
      (st.status !== "WORKING" && st.status !== "DONE") ||
      this.flushing.has(sessionId) ||
      this.stuckGuarding.has(sessionId) ||
      (this.inputQueue.get(sessionId)?.length ?? 0) > 0
    ) return;
    const pid = st.cli_pid;
    // known 用全部 pending 文本（不止本条）：连续多条滞留时 foreignResidual 才能
    // 把框内全部内容解释为我们的，否则前一条会被误判"外来输入"而暂缓。
    // 带 #54 双文本口径：CLI 输入框里的滞留文是注入全文，对账键取 body——
    // 用回显短文本（「… [图片×1]」）比对必失配 → skip-absent 误判放弃补发
    const known = (st.pending_inputs ?? []).map((p) => pBody(p));
    this.stuckGuarding.add(sessionId);
    // verdict 语义与看门狗路径不同：skip-absent 在这里是「CLI 已原生排队、框已清」的
    // 正常态（pending 等工具边界自然晋升）——静默收手，绝不动 skips 计数（否则 3 条
    // 正常 WORKING 消息就把看门狗 given_up 弄死）；timeout（真人在打字）/快照不可用
    // 同样静默交回看门狗。只有确认滞留（enter*）才真正补发。
    void guardCompensateEnter(known, () => captureConsoleBottom(pid), {
      abort: () => {
        const s2 = this.mgr.getExternal(sessionId);
        return !s2 || (s2.status !== "WORKING" && s2.status !== "DONE") || this.flushing.has(sessionId) || (this.inputQueue.get(sessionId)?.length ?? 0) > 0;
      },
    })
      .then((v) => {
        if (v.kind === "enter" || v.kind === "enter-after-wait") {
          // 快照在途期间状态可能已变：新消息开始注入（分块进行中，此刻补回车会把长
          // 消息劈成两半）或本条已晋升（UserPromptSubmit 到达）——弃发交回下一轮
          const s2 = this.mgr.getExternal(sessionId);
          if (this.flushing.has(sessionId) || (this.inputQueue.get(sessionId)?.length ?? 0) > 0) return;
          if (!s2 || !(s2.pending_inputs ?? []).some((p) => normKey(pBody(p)) === normKey(text))) return;
          this.fireStuckEnter(sessionId, pid, v.kind === "enter-after-wait"
            ? `已补发回车（检测到输入框有其他输入，等停手 ${Math.round(v.waitedMs / 100) / 10}s 后补发）`
            : "注入后 3 秒仍滞留输入框，已补发回车（#111 主动验证）");
          if (round < 2) this.armVerify(sessionId, text, round + 1); // 回车再被吞的兜验（3 轮总窗 ~4s，超窗交看门狗）
        }
      })
      .finally(() => this.stuckGuarding.delete(sessionId));
  }

  // #111 晋升成功即重置滞留看门狗：补发生效说明链路活着，下一条滞留消息应继续享受
  // 10s 快窗——原实现 tries>0 后阈值跳回 90s（stuckAfterMs），连续第二条滞留要等 90s+
  private resetStuckWatch(sessionId: string): void {
    this.stuckWatch.delete(sessionId);
  }


  // 现象：注入的回车在回合切换瞬间被 CLI 界面层吞掉，文字滞留输入框未提交，
  // 直到下一条消息的回车才把两条一起冲出去。补发一个空回车（injectEnter）补救。
  // WAITING 严禁补发——回车会误触权限弹窗。
  // 防抢发（type guard）：补发回车前快照 CLI 输入框，框内有非我们注入的内容
  // （真人正在打字/半截输入）则暂缓，等停手后再补——否则会把用户打到一半的
  // 输入连同滞留消息一起抢发出去。CCR_TYPE_GUARD=off 可关。
  private sweepStuckInputs(): void {
    const now = Date.now();
    // 首检快窗：注入后 10s（env 短值时遵从 env）未提交也未进 CLI 队列即补发——
    // 手机发的消息不该等到用户走到 PC 才发现滞留输入框；补发过的回归长窗（stuckAfterMs）
    const firstMs = Math.min(10_000, this.stuckAfterMs);
    for (const s of this.mgr.snapshot()) {
      if (!s.external) continue;
      const id = s.session_id;
      const w0 = this.stuckWatch.get(id);
      const threshold = w0 && w0.tries > 0 ? this.stuckAfterMs : firstMs;
      const stuckTexts = (s.pending_inputs ?? []).filter((p) => {
        if (now - p.ts <= threshold) return false;
        if (this.isEnqueued(id, pBody(p))) return false;
        // 60s 内晋升过同文本：pending 条目早于晋升记录 = 已处理过的残留，跳过；
        // 条目更新 = 用户重发（"继续"这类高频词）再滞留，照常补发。
        // 对账键统一 body 形态（noteUserMsg 记的就是提交全文）
        const rec = this.recentUserMsgs.get(id)?.get(normKey(pBody(p)));
        return !(rec && now - rec.ts < 60_000 && rec.ts >= p.ts);
      }).map((p) => pBody(p));
      if (stuckTexts.length === 0) {
        this.stuckWatch.delete(id); // 真送达/清空：看门狗全额重置
        continue;
      }
      // 瞬态条件不满足（无定位/状态不适合/flush 中/队列有货）：跳过本轮但保留看门狗
      // 计数——此前这里整档 delete，tries/given_up 被反复清零，「3 次后暂停」上界
      // 打穿，同一条滞留消息刷出 10 条补发日志（2026-09-18 公司机实测）
      if (
        !s.cli_pid ||
        (s.status !== "WORKING" && s.status !== "DONE") ||
        this.flushing.has(id) ||
        (this.inputQueue.get(id)?.length ?? 0) > 0
      ) {
        continue;
      }
      // 恢复窗口期内（resumeSpawns 刚 spawn）：滞留消息归恢复闭环管理（上线校验 +
      // 窗口解锁重试），此时补回车只会打进旧 CLI 的空输入框——无效果纯噪音
      if (Date.now() - (this.resumeSpawns.get(id) ?? 0) < this.resumeWindowMs) continue;
      const w = this.stuckWatch.get(id);
      if (w?.given_up) continue; // 连续 3 次仍滞留：放弃，防无限打转
      if (w && now - w.lastTry < this.stuckRetryMs) continue; // 每会话限速
      const pid = s.cli_pid;
      // 防抢发守门（异步等待期间占位限速防重入；补发计数只在真正发回车时增加）
      if (guardConfig().enabled) {
        if (this.stuckGuarding.has(id)) continue; // 守门等待中：绝不旁路直发
        this.stuckWatch.set(id, { lastTry: now, tries: w?.tries ?? 0, skips: w?.skips ?? 0, given_up: w?.given_up ?? false });
        this.stuckGuarding.add(id);
        void this.guardedStuckEnter(id, pid, stuckTexts).finally(() => this.stuckGuarding.delete(id));
        continue;
      }
      this.fireStuckEnter(id, pid);
    }
  }

  // 真正补发回车（守门通过 / 守门关闭 / 快照不可用 fail-open 都走到这里）
  private fireStuckEnter(id: string, pid: number, msg?: string): void {
    const w = this.stuckWatch.get(id);
    const tries = (w?.tries ?? 0) + 1;
    this.stuckWatch.set(id, { lastTry: Date.now(), tries, skips: w?.skips ?? 0, given_up: tries >= 3 });
    // 「暂停自动补发」只在 tries===3 跃迁时打一次：#111 主动验证不查 given_up 门槛，
    // 后续消息仍会触发本函数（行为有界无害），反复打同款日志会与现实矛盾
    if (tries === 3) {
      this.mgr.pushExternalLog(id, "system", "排队消息疑似滞留输入框，已补发 3 次回车仍滞留，暂停自动补发（下次发送消息时会一并提交）");
    } else if (tries < 3) {
      this.mgr.pushExternalLog(id, "system", msg ?? "排队消息疑似滞留输入框，已补发回车");
    }
    void injectEnter(pid).then((r) => {
      if (!r.ok) this.onInjectFail(id, r.error);
    });
  }

  // 守门后的跳过（框内已无滞留消息）：不补发、不计数补发次数；连续跳过多次后停手，
  // 防无 hook 会话 pending 永不晋升时每 60s 刷一条日志
  private bumpStuckSkips(id: string, msg: string): void {
    const w = this.stuckWatch.get(id);
    const skips = (w?.skips ?? 0) + 1;
    this.stuckWatch.set(id, { lastTry: Date.now(), tries: w?.tries ?? 0, skips, given_up: (w?.given_up ?? false) || skips >= 3 });
    this.mgr.pushExternalLog(id, "system", skips >= 3 ? "输入框多次未见该排队消息，暂停自动补发（下次发送消息时会一并提交）" : msg);
  }

  // 补发回车前的防抢发守门：快照 CLI 输入框，有疑似人工输入则等停手再补。
  // 快照不可用（旧注入器/弹窗盖住/识别失败）fail-open 维持旧行为直接补发。
  private async guardedStuckEnter(id: string, pid: number, texts: string[]): Promise<void> {
    const v = await guardCompensateEnter(texts, () => captureConsoleBottom(pid), {
      abort: () => {
        // 等待期间状态翻 WAITING（回车会误触弹窗）/ flush 进行中 / 会话消失：放弃本轮
        const st = this.mgr.getExternal(id);
        return !st || (st.status !== "WORKING" && st.status !== "DONE") || this.flushing.has(id) || (this.inputQueue.get(id)?.length ?? 0) > 0;
      },
    });
    if (v.kind === "skip-absent") {
      this.bumpStuckSkips(id, "输入框已无该排队消息（可能已随人工输入提交或被清空），跳过本次补发回车");
      return;
    }
    if (v.kind === "timeout") {
      this.mgr.pushExternalLog(id, "system", "输入框检测到持续人工输入，本轮暂缓补发回车（停手后下一轮自动再试）");
      return;
    }
    if (v.kind === "aborted") return; // 状态变化，静默退出（下轮看门狗重判）
    if (v.kind === "enter-after-wait") {
      this.fireStuckEnter(id, pid, `已补发回车（检测到输入框有其他输入，等停手 ${Math.round(v.waitedMs / 100) / 10}s 后补发）`);
      return;
    }
    this.fireStuckEnter(id, pid); // enter / unknown（快照不可用 fail-open，行为同旧版）
  }
}

export function parseGateTools(raw: string | undefined): Set<string> {
  const def = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch";
  return new Set((raw ?? def).split(",").map((s) => s.trim()).filter(Boolean));
}
