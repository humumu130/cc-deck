// #27 Codex 引擎接入（P0，2026-10-01）：V2「Agent 无关编排层」的第二个真实
// AgentAdapter——接入纪律①（接口先行、实现唯一）在 codex 这个真实需求上的兑现。
// 协议依据：codex-cli 0.154.0 一手实测（docs/codex-integration-research.md 附录）。
//
// 架构关键差异（与 Claude SDK 常驻流根本不同）：`codex exec` 是**一回合一进程**
// ——turn 完即退。映射到 AgentLike 语义：
//   - 逻辑会话 = codex thread_id（thread.started 回填），跨进程常驻
//   - 每回合 = spawn `codex exec [--json] [resume <thread_id>]`，prompt 走 stdin
//   - 干净退出（turn.completed 后进程退出）**不发 onSessionEnd**：对齐 AgentSession
//     「DONE 语义=当前任务完成，sendMessage 可再开新回合」的常驻语义
//   - 回合中 sendMessage 排队，干净收口后 merge("\n\n") 再起下一回合
//
// P0 已知缺口（备案，非本笔范围）：
//   - headless 无交互审批通道：allow/deny/answer 恒 false、setPermissionMode no-op、
//     hasPending 恒 false（WAITING 形态后续版本再议）
//   - -i 附图仅首回合（codex 协议限制：attach to the initial prompt）；续回合带图
//     发 system 日志后忽略
//   - model 参数不透传（relay 的模型名是 Claude 侧概念；codex 用自己的
//     config.toml 接线——本机 GLM 同源，见研究文档）
//   - file_change/reasoning 等事件 P0 不映射；stats 恒零（无 Edit/Write 语义面）
//
// 测试口径：CodexEventMapper 是纯函数面（fixture 喂事件断言回调），CI 零真 spawn；
// 真链路冒烟在沙盒手工跑（用户已明示预算不敏感，2026-10-01）。
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { killTree } from "./proc-tree.js";
import { childEnv } from "./agent-adapter.js";
import type { AgentCallbacks, AgentLike } from "./agent-adapter.js";
import { capDetail, fullText, truncate } from "./summarizer.js";
import type { FileChangeStats } from "./types.js";

// ---------------------------------------------------------------------------
// 事件映射器（纯函数面，单测直接喂 fixture JSONL 行）
// ---------------------------------------------------------------------------

/** codex 事件的最小宽松形状（0.154.0 实测词汇表；未知字段原样忽略向前兼容） */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    // agent_message
    text?: string;
    // command_execution
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: string | { message?: string };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** thread.started / turn.* / item.* / error → AgentCallbacks。
 *  会话侧另在 mapper 之前截获 thread.started 回填 threadId（锚在会话不在映射器）。 */
export class CodexEventMapper {
  /** 当前回合起始时刻（turn.started 记，回合收口事件算时长用；测试可注入 now 定值） */
  turnStartMs = 0;
  /** 上个回合是否已收口（turn.completed/turn.failed）。会话侧判「进程退出但回合
   *  未收口」用——true 时退出码不再补发 onTurnEnd（防双发） */
  turnTerminal = true;
  /** 已见过的 thread_id（同值幂等；变化=协议异常，保留最新） */
  lastThreadId: string | undefined;

  handle(raw: unknown, cb: AgentCallbacks, now: number = Date.now()): void {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as CodexEvent;
    switch (ev.type) {
      case "thread.started": {
        const tid = typeof ev.thread_id === "string" ? ev.thread_id : "";
        this.lastThreadId = tid || this.lastThreadId;
        // 模型名 codex 事件流不携带：onInit 的 model 位给引擎名（端上徽标数据源）
        cb.onInit(tid, "codex");
        break;
      }
      case "turn.started":
        this.turnStartMs = now;
        this.turnTerminal = false;
        cb.onStatusChange("WORKING", "执行中");
        break;
      case "item.started": {
        const it = ev.item;
        if (it?.type === "command_execution") {
          cb.onLog("tool_use", truncate(it.command ?? "(命令)", 200) || "(命令)", {
            tool: "command",
            id: it.id,
            full: capDetail(it.command ?? ""),
          });
        }
        break;
      }
      case "item.completed": {
        const it = ev.item;
        if (!it) break;
        if (it.type === "agent_message") {
          cb.onLog("assistant_text", it.text ?? "", { id: it.id });
        } else if (it.type === "command_execution") {
          const exit = it.exit_code ?? null;
          const ok = it.status === "failed" || (exit !== null && exit !== 0) ? false : true;
          const head = (it.aggregated_output ?? "").trim().split("\n")[0] ?? "";
          cb.onLog("tool_result", ok ? (head || `退出码 ${exit}`) : `失败（退出码 ${exit ?? "?"}）`, {
            tool: "command",
            id: it.id,
            full: capDetail(it.aggregated_output ?? ""),
          });
        }
        // file_change / reasoning / mcp_tool_call / web_search / todo_list：P0 不映射
        break;
      }
      case "turn.completed": {
        // 口径铁律（预算护栏批结论，此处同源）：usage 取 input+output；
        // cached_input_tokens ≈ Claude cache_read（非实耗，勿当消耗计）；
        // reasoning_output_tokens ⊂ output（不叠加，防双计）
        const u = ev.usage ?? {};
        cb.onUsage({
          input_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
          cache_read_input_tokens: num(u.cached_input_tokens),
          cache_creation_input_tokens: num(u.cache_write_input_tokens),
        });
        cb.onTurnEnd(true, "success", this.turnStartMs ? Math.max(0, now - this.turnStartMs) : 0);
        this.turnTerminal = true;
        break;
      }
      case "turn.failed": {
        const msg = typeof ev.error === "string" ? ev.error : ev.error?.message;
        cb.onTurnEnd(false, truncate(msg ?? "回合失败", 200) || "回合失败", this.turnStartMs ? Math.max(0, now - this.turnStartMs) : 0);
        this.turnTerminal = true;
        break;
      }
      case "error": {
        const msg = typeof ev.error === "string" ? ev.error : ev.error?.message;
        // 只留痕不收口回合：error 后进程退出码路径由会话侧统一判（防双发 onTurnEnd）
        cb.onLog("system", `codex 错误：${truncate(msg ?? "(无信息)", 200)}`);
        break;
      }
      default:
        break; // 未知事件静默吞（协议演进；漏映射=降级显示，不炸链路）
    }
  }
}

// ---------------------------------------------------------------------------
// CLI 定位（仿 cli-path.ts：env 覆盖 → PATH → 常见安装位）
// ---------------------------------------------------------------------------

let cachedBin: string | null | undefined;

export function resolveCodexCliPath(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const fromEnv = process.env.CCR_CODEX_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    cachedBin = fromEnv;
    return cachedBin;
  }
  // 父进程 PATH + childEnv 同款补位（spawn env 与此处解析保持同一视野）
  const dirs = (childEnv().PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = join(d, "codex");
    if (existsSync(p)) {
      cachedBin = p;
      return p;
    }
  }
  cachedBin = null;
  return null;
}

/** 测试缝：清缓存（CCR_CODEX_PATH 改 env 后重解析） */
export function resetCodexCliCache(): void {
  cachedBin = undefined;
}

// ---------------------------------------------------------------------------
// 会话（一回合一进程；逻辑会话 = thread_id）
// ---------------------------------------------------------------------------

export interface CodexSessionOpts {
  /** codex thread_id（resume 重建 / 看门狗恢复 / 换班恢复的锚） */
  resume?: string;
  /** 兼容工厂统一签名：headless 无审批通道，忽略 */
  permissionMode?: string;
  /** 仅首回合生效（-i 协议限制），后续带图在 sendMessage 侧提示并忽略 */
  images?: string[];
  /** 兼容工厂统一签名：允许规则是 Claude 权限面概念，忽略 */
  rules?: unknown;
  /** 兼容工厂统一签名：雇员独立家是 CLAUDE_CONFIG_DIR 概念；CODEX_HOME 隔离后置 */
  configHome?: string;
}

export class CodexAgentSession implements AgentLike {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly stats: FileChangeStats = { files_changed: 0, lines_added: 0, lines_deleted: 0 };
  ended = false;

  private readonly cb: AgentCallbacks;
  private readonly cwd: string;
  private readonly bin: string;
  private threadId: string | undefined;
  private mapper = new CodexEventMapper();
  private proc: ChildProcess | null = null;
  private pid: number | undefined;
  private queued: string[] = [];
  private stopping = false;
  private stderrTail = "";

  get childPid(): number | undefined {
    return this.pid;
  }

  constructor(
    cwd: string,
    // 工厂统一签名（session-manager :571 对齐）；codex 侧不消费——模型接线在
    // ~/.codex/config.toml（本机 GLM 同源），relay 模型名是 Claude 侧概念
    _model: string,
    cb: AgentCallbacks,
    initialPrompt: string | undefined,
    opts?: CodexSessionOpts,
  ) {
    this.cwd = cwd;
    this.cb = cb;
    this.threadId = opts?.resume;
    const bin = resolveCodexCliPath();
    if (!bin) {
      // 同步抛 → session-manager create() 的 try/catch（f975fea 先例）兜成
      // ok:false 横幅；无半登记残留
      throw new Error("codex CLI 未找到（安装 codex 或设 CCR_CODEX_PATH）");
    }
    this.bin = bin;
    // undefined = 按需恢复的 parked 形态：不 spawn，首个回合由 sendMessage 开启
    if (initialPrompt !== undefined) this.execTurn(initialPrompt, opts?.images);
  }

  sendMessage(text: string, images?: string[], echo?: string): void {
    if (this.ended) {
      console.warn("[codex] 会话已结束，消息丢弃");
      return;
    }
    // 回显语义对齐 AgentSession（#62 echo 面：文件消息正文短回显不露临时路径）
    const marker = images && images.length > 0 ? `（+${images.length} 图）` : "";
    if (echo !== undefined) {
      this.cb.onLog("user_message", echo, { full: fullText(echo, 200) });
    } else {
      const full = fullText(text, 200);
      this.cb.onLog("user_message", truncate(text, 200) + marker, {
        full: full === undefined ? undefined : full + marker,
      });
    }
    if (images && images.length > 0 && (this.proc || this.threadId)) {
      this.cb.onLog("system", "codex 续回合暂不支持附图，图片已忽略（P0 已知缺口）");
    }
    if (this.proc) {
      // 回合进行中：排队，干净收口后 merge 再起（进程模型下没有并发回合）
      this.queued.push(text);
      return;
    }
    this.execTurn(text, images && images.length > 0 && !this.threadId ? images : undefined);
  }

  // headless 无审批通道（WAITING 形态 P0 不做）——三口恒 false，端上不出现审批卡
  allow(_requestId?: string, _by?: string, _rememberScope?: "session" | "global"): boolean {
    return false;
  }
  deny(_requestId?: string, _reason?: string, _by?: string): boolean {
    return false;
  }
  answer(_requestId?: string, _answers?: string[], _by?: string): boolean {
    return false;
  }
  hasPending(): boolean {
    return false;
  }

  async setPermissionMode(_mode?: string): Promise<void> {
    // no-op：兼容签名（CLI 的 /permissions 同款能力 codex exec 无面）
  }

  async stop(): Promise<void> {
    if (this.ended) return;
    this.stopping = true;
    this.ended = true;
    this.queued = [];
    const child = this.proc;
    this.proc = null;
    if (child?.pid) await killTree(child.pid); // close 事件随杀到达，stopping 守卫拦下
    this.pid = undefined;
    this.cb.onSessionEnd("stopped");
  }

  // -- 内部 -------------------------------------------------------------

  private execTurn(prompt: string, images?: string[]): void {
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", this.cwd];
    if (this.threadId) args.push("resume", this.threadId);
    if (images && images.length > 0 && !this.threadId) args.push("-i", ...images);
    args.push("-"); // prompt 从 stdin 读（长文本/引号/换行安全）

    const child = spawn(this.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: childEnv(),
    });
    this.proc = child;
    this.pid = child.pid;
    this.stderrTail = "";
    this.cb.onStatusChange("WORKING", "启动中"); // turn.started 前的窗口别停在 DONE

    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      // 只留尾段：失败原因可诊断即可，不做全量转发（codex 噪声大）
      this.stderrTail = ((this.stderrTail + d.toString("utf-8")).match(/[\s\S]{500}$/)?.[0] ?? "");
    });
    child.on("error", (e) => {
      // spawn 运行期失败（EACCES 等；构造期 ENOENT 已在 resolveCodexCliPath 拦）
      this.cb.onLog("system", `codex 进程错误：${truncate(e.message, 200)}`);
    });
    child.on("close", (code) => this.onClose(code));
    child.stdin!.on("error", () => {}); // EPIPE 容错（进程早退时 end() 写侧报错）
    child.stdin!.end(prompt, "utf-8");
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // --json 模式应逐行 JSON：非 JSON = 协议漂移，留痕可见但不炸链路
      this.cb.onLog("system", `codex 输出非 JSON：${truncate(line, 120)}`);
      return;
    }
    const ev = parsed as CodexEvent;
    if (ev?.type === "thread.started" && typeof ev.thread_id === "string" && ev.thread_id) {
      this.threadId = ev.thread_id; // 逻辑会话锚（resume 依赖；早于 onInit 回填）
    }
    this.mapper.handle(parsed, this.cb);
  }

  private onClose(code: number | null): void {
    this.proc = null;
    this.pid = undefined;
    if (this.stopping) return; // stop() 自己收口（onSessionEnd 已发）
    if (!this.mapper.turnTerminal) {
      // 进程退出而回合未收口：崩溃/被杀/协议漂移。有 threadId = 可 resume 自愈
      // （下次 sendMessage 自然续）；无 = 首回合早夭，对齐 Claude「init 前崩」
      this.mapper.turnTerminal = true;
      const dur = this.mapper.turnStartMs ? Math.max(0, Date.now() - this.mapper.turnStartMs) : 0;
      const why = code === null ? "进程被信号终止" : `退出码 ${code}`;
      this.cb.onTurnEnd(false, `codex ${why}${this.stderrTail ? `：${truncate(this.stderrTail.trim().split("\n").at(-1) ?? "", 160)}` : ""}`, dur);
      if (!this.threadId) {
        this.ended = true;
        this.cb.onSessionEnd("codex 首回合进程退出");
        return;
      }
    }
    // 干净收口：不发 onSessionEnd（逻辑会话常驻，对齐 AgentSession DONE 语义）
    if (this.queued.length > 0 && !this.ended) {
      const merged = this.queued.join("\n\n");
      this.queued = [];
      this.execTurn(merged);
    }
  }
}
