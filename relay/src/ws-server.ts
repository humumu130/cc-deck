import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { detectLanIp } from "./lan-ip.js";
import { permissionCapabilitiesSummary, permissionPolicyEnabled } from "./permission-policy.js";
import { engineCatalogSummary } from "./engine-catalog.js";
import { listArtifacts, serveArtifact, validateDeliverablePath } from "./artifacts.js";
import {
  serveAcceptancePage,
  loadAcceptance,
  saveResult,
  rateLimited,
  ACCEPTANCE_ID_RE,
  listAcceptances,
  applyCloudSubmits,
  type Acceptance,
  type CloudSubmit,
} from "./acceptance.js";
import { listDesignDocs, resolveDesignFile } from "./design-docs.js";
import { listModels } from "./models.js";
// #26 M2 组织项目组：快照字段同源（索引 + 待决确认单）
import { listBoards, listGroups, listPendingConfirms } from "./projects.js";
import { appendDispatch, readDispatchLog } from "./org.js"; // W-CMDIMPL T1-STAGE：阶段事件入台账
import { harvestCheck } from "./harvest.js"; // W-CMDIMPL ①：收割机器闸
import { ReleaseModule } from "./release.js"; // W-CMDIMPL ③：发版编排
import { listExperience } from "./experience.js"; // W-EXPP2：SNAPSHOT.experience 锚定帧数据源
import { listRules } from "./team-rules.js"; // W-RULES2：SNAPSHOT.rules 锚定帧数据源
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { REPLAY_FAST_MAX, type EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import { SNAPSHOT_LOGS_LAN } from "./session-manager.js"; // W-INJECT④：LAN 快照宽窗（云端 CF 安全默认不动）
import type { RelayConfig } from "./config.js";
import { Bridge, parseGateTools } from "./bridge.js";
import { SNAPSHOT_SCHEMA_VERSION, type BridgeEvent, type Command, type CommandAckPayload, type Envelope } from "./types.js";

/** W-SRC2 #134：SNAPSHOT 会话自报 relay_source（本 relay 显示名；空名=零注入原样）。
 * per-session 打标根修——聚合端（web/expo）此前靠客户端三处补丁拼标，存量卡漏标
 * =用户两报根因；relay 侧单点下发后端上守卫（`|| srcTag` / `if (!s.relay_source)`）
 * 自动让位自带字段，旧端零改兼容 */
function withRelaySource(sessions: ReturnType<SessionManager["snapshot"]>, relayName: string | undefined): ReturnType<SessionManager["snapshot"]> {
  if (!relayName) return sessions;
  return sessions.map((s) => ({ ...s, relay_source: s.relay_source ?? relayName }));
}

/** #265 增量续传对账帧（瞬态）：last_seq 快路径只补漏事件，不建「哪些会话还活着」
 * 的权威清单——relay 侧已消失且无 SESSION_DELETED 事件的会话（重启历史回放未复活/
 * 外部 GC）在客户端增量态永久滞留（1026 用户 16 张死卡根因，PM 实测快照 12 活、
 * 16 死 sid 零命中）。replay 后补发在线会话 id 全集，端上集合外会话就地清卡。
 * seq:0 瞬态（PAIR_REQUEST 同语义）：不进缓冲、不落 ndjson、不补发——每次重连
 * 现算重发，天然幂等；session_ids 与 SNAPSHOT.sessions 同源（snapshot() 收口，
 * 含 no-leader 锚卡过滤）。LAN ws-server 与云桥 resumePhone/resumeWan 三出口共用 */
export function buildSessionsReconcile(mgr: SessionManager, relayName: string | undefined): Envelope {
  return {
    seq: 0,
    session_id: "",
    ts: Date.now(),
    type: "SESSIONS_RECONCILE",
    payload: {
      session_ids: mgr.snapshot().map((s) => s.session_id),
      relay_source: relayName ?? "",
    },
  };
}

function localIps(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === "IPv4") out.add(ni.address);
  }
  return out;
}

// 浏览器 CORS 可信域白名单：网页控制台部署域。cc-deck.humumu.online 为新域（#411 根修）——
// 旧白名单只认 cc.humumu.online，网页开在新域时跨源读本机 /local-info、/api/pair-code
// 响应被浏览器静默拦截，「本机领码」必失败。新增部署域只需在此追加。
const TRUSTED_WEB_ORIGINS: readonly string[] = ["https://cc.humumu.online", "https://cc-deck.humumu.online"];

// #448 插件可选能力配置：~/.cc-deck/config.json 五键（guard-stop/guard-context hooks 与
// /api/plugin-config 端点共用）。P71 起读写落 src/plugin-config.ts 独立件（值守判定面
// session-manager 要读 duty 总闸，不许反向依赖 ws-server HTTP 面）；此处 re-export
// readPluginConfig 保 cloud-client 既有 import 不破，PLUGIN_CFG_KEYS/pluginConfigPath
// 本文件 /api/plugin-config 写面自用。
// #71 第五键 duty：值守总闸（019 §6.5 拍板），缺省 true 显式 false 才关（kill-switch）。
import { PLUGIN_CFG_KEYS, pluginConfigPath, readPluginConfig } from "./plugin-config.js";
export { readPluginConfig } from "./plugin-config.js";

// #138 回填通知（LAN 直提与 #175 云回流共用）：按出单时盖进记录的 cwd 归因到会话，
// 推一条 system 行——「3✓ 1✗ 2未测」式摘要消掉人肉对账。归因不到（旧单没盖
// cwd / 会话已收摊）= 静默，不影响提交；通知异常也不影响调用方。
function notifyAcceptanceRefill(acc: Acceptance, rows: unknown, mgr: SessionManager): void {
  try {
    const cwd = (acc as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || !cwd) return;
    const sid = mgr.matchSessionByCwd(cwd);
    if (!sid) return;
    const rs = Array.isArray(rows) ? (rows as { verdict?: unknown }[]) : [];
    const p = rs.filter((r) => r && r.verdict === "pass").length;
    const f = rs.filter((r) => r && r.verdict === "fail").length;
    const u = rs.length - p - f;
    const t = acc.title.length > 40 ? acc.title.slice(0, 40) + "…" : acc.title;
    mgr.pushExternalLog(sid, "system", `验收单已回填：《${t}》 ${p}✓ ${f}✗ ${u}未测`);
  } catch { /* 通知失败不影响提交/回流 */ }
}

// #184 验收单状态推送：acceptances 原本只随 SNAPSHOT 下发，他端提交后在线手机的
// 待填卡要等重连才消失（用户实测：桌面填完手机卡滞留、点开已收摊的单）。提交/回流/
// 登记后 emitTransient 全量汇总——LAN 直播（ws-server 总线订阅）+ 云桥 onEnv 转发
// 两路同达，旧端未知类型自然跳过；seq:0 不落 ndjson，断线端由重连 SNAPSHOT 兜底。
function emitAcceptancesUpdated(bus: EventBus): void {
  bus.emitTransient("ACCEPTANCES_UPDATED", { acceptances: listAcceptances() });
}

// #175 验收单云通道回流：公司网浏览器打不开家庭 LAN，提交走 CF Worker
// （POST /view/acceptance-<id>.results.json → KV 数组 append）。这里每 60s 对
// 未完成单子拉云端结果、签名去重后落盘（applyCloudSubmits），有新增即推 #138 通知
//（按最后一条算摘要，多条新增不刷屏）。云端无提交/网络失败静默下次再试；单子
// 全部判完（done）即不再拉。启动延迟 20s 让云桥/收养广播先落地。
export function startAcceptanceCloudPoll(cfg: RelayConfig, mgr: SessionManager, bus: EventBus): void {
  let base = "";
  try {
    base = `https://${new URL(cfg.cloudUrl).host}`;
  } catch {
    return; // 云桥未配置（cloudUrl 空/非法）——云通道回流不启用
  }
  // #184 tick 签名对账：云回流落盘、新出单登记、删单都会改变 listAcceptances() 汇总，
  // 与上一拍不同即广播——在线端 ≤60s 内收到新态（LAN 提交另有 POST 落盘后的即时广播）
  let lastSig = JSON.stringify(listAcceptances());
  const tick = async (): Promise<void> => {
    for (const s of listAcceptances()) {
      if (s.done) continue;
      let submits: CloudSubmit[] | null = null;
      try {
        // #28 results 读面收紧：提交数组含全部勾选+备注，不该让任何拿到 id 的互联网
        // 读走——GET 携云桥 token（与 /cloud WS 同源密钥）。旧 Worker 忽略未知 header，
        // 新 Worker 验它——**必须新版 relay 先发、新 Worker 后发**，反序回流 401 断流
        const r = await fetch(`${base}/view/acceptance-${s.id}.results.json`, {
          headers: { authorization: `Bearer ${cfg.cloudToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) submits = (await r.json()) as CloudSubmit[];
      } catch { /* 网络失败下次再试 */ }
      if (!Array.isArray(submits) || submits.length === 0) continue;
      const added = applyCloudSubmits(s.id, submits);
      if (added.length > 0) {
        const acc = loadAcceptance(s.id);
        if (acc) notifyAcceptanceRefill(acc, added[added.length - 1].rows, mgr);
        mgr.settleAcceptanceResult(s.id); // M12-7 收单归因回写（幂等，与 LAN 提交同口径）
      }
    }
    try {
      const sig = JSON.stringify(listAcceptances());
      if (sig !== lastSig) {
        lastSig = sig;
        emitAcceptancesUpdated(bus);
      }
    } catch { /* 汇总失败跳过本拍广播 */ }
  };
  setTimeout(() => void tick(), 20_000).unref?.();
  setInterval(() => void tick(), 60_000).unref?.();
}

// LAN 入口命令白名单（不在表内拒发 "unsupported command"）。导出供测试与 cloud-client
// 白名单做逐字一致断言（#117/#212 教训：加命令漏白名单=实机死路，mgr case 与单测全过、
// 唯独入口层挡死）
export const COMMAND_TYPES = new Set([
  "COMMAND_CREATE",
  "COMMAND_MESSAGE",
  "COMMAND_STOP",
  "COMMAND_CONTINUE",
  "COMMAND_REJECT",
  "COMMAND_EXT_MODE",
  "COMMAND_EXT_INPUT",
  "COMMAND_EXT_STOP",
  "COMMAND_DELETE",
  "COMMAND_RENAME",
  "COMMAND_ANSWER",
  "COMMAND_PAIR_START",
  "COMMAND_PAIR_CODE",
  "COMMAND_LOGIN_GRANT",
  "COMMAND_WATCH_GRANT",
  "COMMAND_PEERS",
  "COMMAND_PEER_KICK",
  "COMMAND_PEERS_IMPORT",
  "COMMAND_CLOUD_INFO",
  "COMMAND_PERM",
  "COMMAND_MODEL",
  "COMMAND_REFRESH_TODOS",
  "COMMAND_TODO_HIDE",
  "COMMAND_PIN_SESSION",
  "COMMAND_RESUME_SESSION",
  "COMMAND_IMPORT_PUSH",
  "COMMAND_ARTIFACT_FETCH",
  // #212 允许并记住：设置页规则删除（漏加时 ws 入口白名单拒发 "invalid command
  // shape"，手机端删除必失败——mgr 的 case 与单测都过，唯独 ws 层挡死，实机首验抓到）
  "COMMAND_ALLOW_RULE_REMOVE",
  // #26 M2 组织：确认单决议（用户端确认卡）+ 项目组详情拉取
  "COMMAND_ORG_CONFIRM",
  "COMMAND_PROJECT_DETAIL",
  // #018-R1b：org 命令真链路（立项 create；与云通道同走 mgr.orgCommand 咽喉——
  // 漏加时 ws 白名单在此拒发，mgr 的 case 与单测都过、唯独 LAN 实机死路，#212 同款坑）
  "COMMAND_ORG_ACTION",
  // #018-R1c：通知生命周期 ACK（handled/dismissed；与云通道同走 mgr）
  "COMMAND_NOTIFICATION_ACK",
  // #17 第二批：雇员独立家开关切换（三端设置项）
  "COMMAND_SETTINGS_UPDATE",
  // M12-1 四新命令（v2-m10-freeze §3.1）：经 orgCommand 咽喉→orgAction 单漏斗
  "COMMAND_TASK_CREATE",
  "COMMAND_TASK_UPDATE",
  "COMMAND_DISPATCH",
  "COMMAND_LESSON_APPEND",
  // #102 批 B 引擎登录引导（把饭喂到嘴里）：起登录 pane/查状态/我已完成登录/取消
  //（漏加白名单=LAN 实机死路，#212 同款坑——mgr case 与单测全过唯独入口层挡死）
  "COMMAND_ENGINE_LOGIN",
]);

const HEARTBEAT_MS = 30_000;
// #85 心跳容忍度（2026-09-21，与 cloud-bridge 同款）：单轮无 pong 即 terminate 会把
// 手机后台停摆（doze/冻结，持续几分钟是常态）全误杀，且 terminate 硬掐 TCP 不发
// close 帧，客户端冻结期间无从感知（回前台成假在线）。踢人只是服务端清死连接的
// 卫生动作（客户端恢复靠自身探测）——容忍 20 轮（10 分钟）：停摆 <10min 的连接
// 解冻后 OkHttp 补 pong 即原地复活；ping 节奏不变（保 NAT 不掐 idle TCP）
const HEARTBEAT_MISS_LIMIT = 20;

// 内置 slash 命令表（手机/网页输入联想）：只列稳定核心集，desc 仅作提示文案
const BUILTIN_COMMANDS: { name: string; desc: string }[] = [
  { name: "compact", desc: "压缩对话历史，释放上下文" },
  { name: "clear", desc: "清空当前会话历史" },
  { name: "help", desc: "查看帮助" },
  { name: "model", desc: "查看/切换模型" },
  { name: "cost", desc: "当前会话 token 用量" },
  { name: "context", desc: "上下文使用概况" },
  { name: "memory", desc: "编辑项目记忆 CLAUDE.md" },
  { name: "init", desc: "为当前项目初始化 CLAUDE.md" },
  { name: "review", desc: "审查 PR / 代码变更" },
  { name: "resume", desc: "恢复历史会话" },
  { name: "rename", desc: "重命名当前会话" },
  { name: "export", desc: "导出当前会话记录" },
  { name: "todos", desc: "查看当前任务清单" },
  { name: "permissions", desc: "权限规则管理" },
  { name: "config", desc: "打开配置面板" },
  { name: "mcp", desc: "MCP 服务器管理" },
  { name: "statusline", desc: "状态栏配置" },
  { name: "output-style", desc: "切换输出风格" },
  { name: "add-dir", desc: "添加额外工作目录" },
  { name: "vim", desc: "切换 vim 按键模式" },
  { name: "doctor", desc: "Claude Code 健康检查" },
  { name: "login", desc: "切换账号" },
  { name: "bug", desc: "报告问题" },
  { name: "release-notes", desc: "查看更新日志" },
];

interface SlashCommand {
  name: string;
  desc: string;
  source: "builtin" | "user" | "project";
}

// 扫描自定义命令目录（~/.claude/commands 或 <cwd>/.claude/commands）：
// 文件名=命令名，子目录一层 namespace:name；desc 取 frontmatter description 或首个非空行
function listCustomCommands(dir: string, source: "user" | "project"): SlashCommand[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return [];
  }
  const descOf = (p: string): string => {
    try {
      const head = readFileSync(p, "utf-8").slice(0, 400);
      const m = /^description:\s*(.+)$/m.exec(head);
      if (m) return m[1].trim().slice(0, 80);
      const line = head.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("---"));
      return line ? line.trim().slice(0, 80) : "";
    } catch {
      return "";
    }
  };
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      out.push({ name: e.name.slice(0, -3), desc: descOf(join(dir, e.name)), source });
    } else if (e.isDirectory()) {
      try {
        for (const g of readdirSync(join(dir, e.name))) {
          if (g.endsWith(".md")) out.push({ name: `${e.name}:${g.slice(0, -3)}`, desc: descOf(join(dir, e.name, g)), source });
        }
      } catch {}
    }
  }
  return out;
}

// W-CMDIMPL ③（#216）：发版编排模块单例（进程级——单飞互斥跨请求生效）
let releaseModuleSingleton: { bus: EventBus | null; dataDir: string | null; mod: ReleaseModule | null } = { bus: null, dataDir: null, mod: null };
let releaseInitDone = false;
function getReleaseModule(bus: EventBus, dataDir: string): ReleaseModule {
  const s = releaseModuleSingleton;
  if (!s.mod || s.bus !== bus || s.dataDir !== dataDir) {
    s.mod = new ReleaseModule(bus, dataDir);
    s.bus = bus;
    s.dataDir = dataDir;
  }
  return s.mod;
}

export interface StartServerOptions {
  gateToolsRaw?: string;    // CCR_GATE_TOOLS，逗号分隔门控工具名
  holdMs?: number;          // PreToolUse 挂起上限（测试用短值）
  questionHoldMs?: number;  // AskUserQuestion 挂起窗口（测试用短值）
  cloudHasPhones?: () => boolean; // 云通道是否有活跃手机（计入"手机在线"门控）
  pairCodes?: { issue(opts?: { code?: string; ttlMs?: number }): { code: string; expires_in: number } }; // 云桥配对码（网页端领码；管理员可指定码值/时长）
  cloudRelayDev?: () => string; // 云桥设备 id：随 SNAPSHOT relay_dev 下发，客户端据此合并同机 LAN/云条目
  cloudWanDev?: () => string; // F7 /wan 手表凭据 dev：随 SNAPSHOT wan_dev 下发，手机据此拼手表连接配置
  relayName?: () => string; // #100 relay 自定义名称（dataDir/relay-name）：随 SNAPSHOT 下发，客户端默认显示名
  // #95 云身份 LAN 握手：同网云配对设备凭回箱挑战换 LAN token（免输码直连）。
  // lanHint 给 SNAPSHOT（ip:port）；authHello/authHandle 由 index 注入（持 identity）
  lanHint?: () => string;
  lanAuthHello?: () => { relay_dev: string; nonce: string } | null;
  lanAuthHandle?: (dev: string, box: { n: string; c: string }) => { ok: true; box: { n: string; c: string } } | { ok: false; error: string };
  onReady?: () => void;     // listen 成功后回调（daemon 模式在此时写 pid 文件，防端口被占时留下死 pid）
}

// 连接策略：
//  - 新客户端（无 last_seq）：发 SNAPSHOT 全量会话快照，之后收实时事件
//  - 重连客户端（last_seq 在缓冲内）：只补发 seq > last_seq 的事件
//  - last_seq 落后到缓冲外：退化为 SNAPSHOT 重建（客户端应重置本地状态）
export function startServer(
  bus: EventBus,
  mgr: SessionManager,
  cfg: RelayConfig,
  opts: StartServerOptions = {},
): { port: number; close: () => Promise<void>; bridge: Bridge } {
  // 静态根（#150 复发根治，2026-09-24）：不再依赖 esbuild define / 运行时 env——按候选探测，
  // 谁的 web-console/index.html 存在用谁：CCR_WEB_ROOT 显式指定 > bundle 上级（插件 scripts/../
  // 与桌面 app Resources/ 同构）> 仓库根（dev：src/../../）。旧表达式（CC_DECK_PLUGIN 三元）
  // 在桌面 app 无人设 env、手敲 esbuild 又漏 --define 时走 src/../../ 分支 = Contents/ 下无
  // web-console → `/` 恒 503（#150 同款事故复发，实测 2026-09-24 热替换后）
  const webRootCandidates = [
    process.env.CCR_WEB_ROOT,
    fileURLToPath(new URL("../", import.meta.url)),
    fileURLToPath(new URL("../../", import.meta.url)),
  ];
  const webRoot =
    webRootCandidates.find((p) => p && existsSync(join(p, "web-console", "index-005.html"))) ??
    webRootCandidates[1]!;
  // 新旧壳共存（用户拍板，2026-10-07）：`/` 主路径 = 旧版稳定壳，`/app2` = 005 新壳对照体验
  const consoleHtml005 = join(webRoot, "web-console", "index-005.html");
  const naclJs = join(webRoot, "web-console", "nacl.js");
  const qrJs = join(webRoot, "web-console", "qr.js");
  const mobileDir = join(webRoot, "mobile") + sep;
  // web-console PWA 资产白名单（manifest 引用的文件；此前 404 → 加主屏无图标/无 manifest）
  const PWA_ASSETS: Record<string, string> = {
    "/manifest.json": "application/manifest+json; charset=utf-8",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/maskable-512.png": "image/png",
  };

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".apk": "application/vnd.android.package-archive",
  };
  // /m 静态托管（移动端 App 壳），仅允许 mobile/ 目录内已知扩展
  const serveMobile = (url: URL, res: ServerResponse): boolean => {
    if (url.pathname !== "/m" && !url.pathname.startsWith("/m/")) return false;
    const rel = url.pathname === "/m" ? "index.html" : url.pathname.slice(3).replace(/^\/+/, "");
    if (!/^[\w.-]+$/.test(rel)) {
      res.writeHead(400).end("bad path");
      return true;
    }
    const file = mobileDir + rel;
    // #29（A-P3）：existsSync 对目录也真——rel 形如 "." 或命中子目录时 readFileSync
    // 抛 EISDIR 炸 request 回调，必须 isFile 收口
    let isFile = false;
    try { isFile = statSync(file).isFile(); } catch {}
    if (!isFile) {
      res.writeHead(404).end("not found");
      return true;
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" }).end(readFileSync(file));
    return true;
  };

  // W-DESIGNHUB：/design/<相对路径> 系统设计图纸静态服务（docs/system-design/ 两层）。
  // 原样渲染红线：readFileSync 直出，无容器页无加工（archify 图纸自带深浅主题与交互，
  // 新窗直开）。遍历防护 = resolveDesignFile（resolve 后必须仍在 designDir 内 + 扩展
  // 白名单 + decodeURIComponent 后校验）；目录缺失（旧部署形态）自然 404——清单侧
  // 同步为空、端上入口隐藏。cache-control：图纸随包分发低频换代，给短缓存即可（与
  // no-store 的控制台不同——图纸大，避免每次重开全量拉 6MB）
  const serveDesign = (url: URL, res: ServerResponse): boolean => {
    if (!url.pathname.startsWith("/design/")) return false;
    const rel = url.pathname.slice("/design/".length).replace(/^\/+/, "");
    const file = resolveDesignFile(webRoot, rel);
    if (!file) {
      res.writeHead(rel ? 400 : 404).end(rel ? "bad design path" : "not found");
      return true;
    }
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {}
    if (!isFile) {
      res.writeHead(404).end("not found");
      return true;
    }
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "max-age=300" }).end(readFileSync(file));
    return true;
  };

  // #29（A-P2）：ws 接收缓冲上限 1MB——此前无 maxPayload，恶意/失控客户端单帧可把
  // relay 内存吃到上限（ws 默认 100MB/帧）。合法上行帧远小于此：命令帧 KB 级、
  // 导入回发帧（ccdeck-import-resp 含连接条目列表）实测几十 KB
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const bridge = new Bridge(bus, mgr, {
    gateTools: parseGateTools(opts.gateToolsRaw ?? process.env.CCR_GATE_TOOLS),
    dataDir: cfg.dataDir,
    rules: mgr.allowRules, // #212 允许并记住：与 AgentSession 同一份规则存储
    // #316 审查修复：待配对手表连接未鉴权，不计入"手机在线"——否则配对连接会让
    // 提问/权限门控误判有手机在场，挂起等一个不存在的审批方
    hasClients: () =>
      [...wss.clients].some((c) => c.readyState === WebSocket.OPEN && !(c as ClientWs).pairing) ||
      !!opts.cloudHasPhones?.(),
    holdMs: opts.holdMs,
    questionHoldMs: opts.questionHoldMs,
  });
  mgr.setBridge(bridge);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/bridge/hook") {
      void handleBridgeHook(req, res, bridge, cfg);
      return;
    }
    if (req.method === "GET" && serveMobile(url, res)) return;
    if (req.method === "GET" && serveDesign(url, res)) return;
    // 手机浏览器不再跳 /m：web-console 自带 720px 移动端布局（#169 PWA 路线），
    // /m 仅保留给旧主屏图标，页面自身跳回根路径
    if (req.method === "GET" && url.pathname === "/") {
      // W-P0-FIX P0-1 双壳收口（2026-10-13 架构审查 P0，用户点名）：主路径切 005 新壳，
      // 旧壳 index.html 冻结退役——不再被任何路由服务（文件留仓一个版本周期后删，
      // 见 web-console/index.html 头部冻结注释）。2026-10-07「新旧共存」口径就此收口
      if (!existsSync(consoleHtml005)) {
        res.writeHead(503).end("web-console/index-005.html 不存在（005 新壳未生成/未随包）");
        return;
      }
      // no-store：控制台是单文件全量替换（无哈希资产名），浏览器启发式缓存会
      // 让 relay 升级后的 LAN 用户一直看旧页（token 换代 → 莫名 401）
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(consoleHtml005));
      return;
    }
    // 005 新壳入口（/app2 历史书签兼容：与 / 同文件，保留防外链断链）
    if (req.method === "GET" && url.pathname === "/app2") {
      if (!existsSync(consoleHtml005)) {
        res.writeHead(503).end("web-console/index-005.html 不存在（005 新壳未生成/未随包）");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(consoleHtml005));
      return;
    }
    // 预览页白名单：web-console/preview/<name>.html（A/B 双轨对比页等临时产物，
    // 不进 bundle 打包清单）——同源 http 天然连 relay，替代 file://+硬编码 ws hack。
    // name 白名单字符防目录穿越；文件缺席 404（预览属临时物，不报 503）
    if (req.method === "GET" && url.pathname.startsWith("/preview/")) {
      const name = url.pathname.slice("/preview/".length);
      if (!/^[a-z0-9-]+\.html$/.test(name)) {
        res.writeHead(404).end("not found");
        return;
      }
      const previewPath = join(webRoot, "web-console", "preview", name);
      if (!existsSync(previewPath)) {
        res.writeHead(404).end("preview 不存在: " + name);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(previewPath));
      return;
    }
    if (req.method === "GET" && url.pathname === "/nacl.js") {
      // web-console 云桥模式依赖的 tweetnacl（页面 <script src="/nacl.js">）
      if (!existsSync(naclJs)) {
        res.writeHead(503).end("web-console/nacl.js 不存在（cp node_modules/tweetnacl/nacl-fast.min.js）");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(naclJs));
      return;
    }
    if (req.method === "GET" && url.pathname === "/qr.js") {
      // #325 扫码登录的二维码编码器（页面 <script src="/qr.js">）；此前白名单漏了
      // 此路由 → 404 → QRCode 未定义 → 点击按钮静默抛错不弹窗（2026-09-07 用户实测踩中）
      if (!existsSync(qrJs)) {
        res.writeHead(503).end("web-console/qr.js 不存在");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(qrJs));
      return;
    }
    // W-SPLIT-S4a/S4b：CSS/JS 外置资产的静态路由（web-console/css/* 和 web-console/js/*）
    // 安全：路径遍历防——pathname 只允许 [a-z0-9._-]，前缀限 css/ 或 js/
    if (req.method === "GET" && (url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/"))) {
      const rel = url.pathname.slice(1).replace(/^\/+/, "");
      if (!/^[a-z0-9._\-\/]+\.(css|js)$/.test(rel) || rel.includes("..")) {
        res.writeHead(404).end("not found");
        return;
      }
      const assetPath = join(webRoot, "web-console", rel);
      if (!existsSync(assetPath)) { res.writeHead(404).end("not found"); return; }
      const ct = rel.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": ct, "cache-control": "no-store" }).end(readFileSync(assetPath));
      return;
    }
    if (req.method === "GET" && PWA_ASSETS[url.pathname]) {
      const file = join(webRoot, "web-console", url.pathname.slice(1));
      if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": PWA_ASSETS[url.pathname] }).end(readFileSync(file));
      return;
    }
    // #95 云身份 LAN 握手（同网直连，详见 opts.lanAuth* 注释）
    if (url.pathname === "/api/lan-hello" && req.method === "GET") {
      const hello = opts.lanAuthHello?.();
      if (!hello) { res.writeHead(501).end(); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" })
        .end(JSON.stringify({ ok: true, relay_dev: hello.relay_dev, nonce: hello.nonce }));
      return;
    }
    if (url.pathname === "/api/lan-auth" && req.method === "POST") {
      // #29（A-P2）：无鉴权端点（挑战密文落盘前）——body 8KB 帽防内存放大
      //（合法挑战帧恒 <1KB：dev 路由键+box 密文几十字节），超限直接掐连接
      if (rateLimited(`lan-auth:${req.socket.remoteAddress ?? "?"}`)) {
        res.writeHead(429, { "content-type": "application/json" }).end('{"ok":false,"error":"太频繁"}');
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => {
        body += c;
        if (body.length > 8192) req.destroy();
      });
      req.on("end", () => {
        try {
          // #95 修正：nacl.box 需发送者公钥解密，dev 藏密文里则无从获取——dev 提为
          // 明文路由键（伪造无用：box 须用 peers[dev] 公钥+真私钥才能构造/解开）
          const { dev, box } = JSON.parse(body) as { dev?: string; box?: { n: string; c: string } };
          if (!dev || !box || !opts.lanAuthHandle) { res.writeHead(400).end('{"error":"bad request"}'); return; }
          const r = opts.lanAuthHandle(dev, box);
          if (r.ok) res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }).end(JSON.stringify({ ok: true, box: r.box }));
          else res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: r.error }));
        } catch { res.writeHead(400).end(); }
      });
      return;
    }
    // #100 relay 自定义名称读写：GET 回显 / POST 保存（dataDir/relay-name，SNAPSHOT 随发）
    if (url.pathname === "/api/relay-name") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) { res.writeHead(401).end(); return; }
      const file = join(cfg.dataDir, "relay-name");
      if (req.method === "GET") {
        let name = "";
        try { name = readFileSync(file, "utf8").trim().slice(0, 40); } catch {}
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: true, name }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          try {
            const { name } = JSON.parse(body) as { name?: string };
            const clean = (name ?? "").trim().slice(0, 40);
            if (!clean || /[\r\n<>]/.test(clean)) { res.writeHead(400).end('{"error":"名称需 1-40 字且不含换行/尖括号"}'); return; }
            writeFileSync(file, clean, "utf8");
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: clean }));
          } catch { res.writeHead(400).end(); }
        });
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // 同机零配置直连：本机浏览器打开 CC Deck 网页时探测本机 relay，直接拿连接参数。
    // 仅 loopback 请求放行；token 只回给可信 origin（我们的部署域/本机/本机 LAN IP 托管页），
    // 防止任意网页从 loopback 套取 token。Safari 不豁免 loopback 混合内容，会探测失败（回退手动）。
    if (req.method === "GET" && url.pathname === "/local-info") {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const origin = (req.headers.origin ?? "").trim();
      const ips = localIps();
      const hostTrusted = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
      // 带 Origin（跨源页面）：白名单回显放行；无 Origin：同源 fetch / 本机进程，认 Host。
      // Host 浏览器不可伪造；能伪造的非浏览器进程本来就能直接读 token 文件，非此端点威胁面。
      let allowOrigin = "";
      // Origin:"null" 豁免已删除（P1FIX 2026-10-10，安全审计 W-AUDIT-SEC P1-1 实锤）：
      // 沙箱 iframe 的 fetch 恒带 Origin:null，豁免 = 任意网页可经 loopback 读走
      // {token,…}=主 token 连 ws 全权（Safari/Firefox 无 PNA 拦截）。桌面端自 #43 起
      // 改走 tauri command 注入 token（壳进程 reqwest 无 Origin、不经浏览器 CORS），
      // 豁免无合法消费方；合法来源仍走下方白名单（部署域/本机/LAN IP 托管页）
      if (origin) {
        try {
          const u = new URL(origin);
          if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostTrusted(u.hostname)) allowOrigin = origin;
        } catch {}
      } else {
        const host = (req.headers.host ?? "").split(":")[0];
        if (hostTrusted(host)) allowOrigin = `http://${req.headers.host}`;
      }
      if (!isLoopback || !allowOrigin) { res.writeHead(404).end(); return; }
      // #25：探测抽到 lan-ip.ts（两段式）——用户公司机实测 lan_ip:""（网卡名撞过滤词
      // 吃光全部地址），回退段无视网卡名取私网 IP。单测 scripts/test-lanip.mjs
      const lanIp = detectLanIp(networkInterfaces());
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": allowOrigin,
        "cache-control": "no-store",
      }).end(JSON.stringify({ ok: true, port: cfg.port, token: cfg.token, lan_ip: lanIp }));
      return;
    }
    // 领取配对码（--pair CLI / /cc-deck-pair 用）：loopback + bridgeToken，
    // 与 /bridge/hook 同信任模型（能读本机 bridge.json 的进程本就可信）
    if (req.method === "POST" && url.pathname === "/api/pair-issue") {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLoopback || (req.headers["x-bridge-token"] ?? "") !== cfg.bridgeToken) {
        res.writeHead(403).end();
        return;
      }
      if (!opts.pairCodes) {
        res.writeHead(501).end("pairing not enabled");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.pairCodes.issue()));
      return;
    }
    // 云桥配对码（网页端首次配对用）：LAN token 鉴权，码一次性短时效
    //（pairing.ts 默认 5 分钟/CCR_PAIR_TTL_MS 可配；expires_in 随响应下发，端上动态渲染）
    if (req.method === "POST" && url.pathname === "/api/pair-code") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (!opts.pairCodes) {
        res.writeHead(501).end("pairing not enabled");
        return;
      }
      // #397 CORS：网页端「本机显示配对码」从云桥域页面跨源读本机响应——
      // 与 /local-info 同款可信 origin 白名单（我们的部署域/本机/本机 LAN IP），
      // 否则浏览器静默拦截响应，领码在部署域页面必失败（#411：新域 cc-deck.* 已入白名单）
      const origin = (req.headers.origin ?? "").trim();
      const ips = localIps();
      const hostOk = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
      let acao = "";
      // Origin:"null" 豁免已删除（同 /local-info，P1FIX 2026-10-10：沙箱 iframe 可造
      // Origin:null；本端点另有 token 鉴权在前，豁免纯属多余攻击面）
      if (origin) {
        try {
          const u = new URL(origin);
          if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostOk(u.hostname)) acao = origin;
        } catch {}
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (acao) headers["access-control-allow-origin"] = acao;
      // 管理员可指定码值/时长（2026-09-09）：?code=789321&ttl=1200000（毫秒，下限 60s）
      const qCode = url.searchParams.get("code") ?? undefined;
      const qTtlRaw = Number(url.searchParams.get("ttl"));
      const qTtl = Number.isFinite(qTtlRaw) && qTtlRaw > 0 ? qTtlRaw : undefined;
      res
        .writeHead(200, headers)
        .end(JSON.stringify(opts.pairCodes.issue(qCode || qTtl ? { code: qCode, ttlMs: qTtl } : undefined)));
      return;
    }
    // #393 手动通知（LAN token 鉴权）：body {session_id?, done: string[]} → 该会话（缺省
    // 取最新 WORKING/外部会话）悬浮框弹 TASK_DONE。答疑/联调实测悬浮框用
    if (req.method === "POST" && url.pathname === "/api/notify") {
      void handleNotify(req, res, mgr, cfg);
      return;
    }
    // W-CMDIMPL ③（#216，设计 §3.2）：POST /api/release——发版编排三 action（主 token
    // 鉴权与 /api/org 同级）。仅本机语义：无发版环境返回 no_release_env+relay_source
    //（UI 置灰）。RELEASE_PROGRESS/DONE/FAILED 三事件经 bus 出（PROGRESS 段落级节流）。
    if (req.method === "POST" && url.pathname === "/api/release") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) { res.writeHead(401).end("unauthorized"); return; }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c;
        if (body.length > 262144) req.destroy();
      });
      req.on("end", () => {
        try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const action = typeof payload.action === "string" ? payload.action : "";
        const rel = getReleaseModule(bus, cfg.dataDir);
        if (!releaseInitDone) {
          releaseInitDone = true;
          rel.markInterrupted(); // §7：relay 重启时进行中 run 标 interrupted（不复活子进程）
          rel.notifyConfirmHook = (text) => {
            try { mgr.notifyLeaderSystem(`[发版失败] ${text}`); } catch {}
          };
        }
        if (action === "config-get") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: { ...rel.configGet().data, relay_source: (opts.relayName?.() ?? "") } }));
          return;
        }
        if (action === "config-set") {
          const r = rel.configSet(payload);
          res.writeHead(r.ok ? 200 : 422, { "content-type": "application/json" }).end(JSON.stringify(r));
          return;
        }
        if (action === "run") {
          const r = rel.run(payload);
          if (r.ok) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: { ...r.data, relay_source: (opts.relayName?.() ?? "") } })); }
          else {
            const noEnv = r.error === "no_release_env";
            res.writeHead(noEnv ? 503 : 422, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: r.error, ...(noEnv ? { relay_source: (opts.relayName?.() ?? "") } : {}) }));
          }
          return;
        }
        res.writeHead(400).end('{"ok":false,"error":"action 必须是 config-get|config-set|run"}');
        } catch {
          res.writeHead(400).end("bad json");
        }
      });
      return;
    }
    // #199 A 对端：CLI Stop 钩子外报（~/.claude/hooks/turn-report.mjs）。LAN 本机回环
    // 专用（钩子只打 127.0.0.1），无 token 面（回环即信任边界——与 /api/notify 同款
    // 本机口径）；body {sid, key, transcript_size, at}。PM→重跑值守+三账对账；
    // worker→60s 去重+worker_done 边沿。失败 relay 侧不回 5xx（钩子已 spool，回 200
    // 防重报风暴——接受窗语义：收到即受理）
    if (req.method === "POST" && url.pathname === "/api/turn-report") {
      let trBody = "";
      req.on("data", (c: Buffer) => { trBody += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(trBody || "{}") as { sid?: string; key?: string };
          const sid = String(body.sid ?? "");
          const key = String(body.key ?? "");
          if (sid && key) (mgr as unknown as { handleTurnReport(s: string, k: string): boolean }).handleTurnReport(sid, key);
        } catch { /* 受理即 200 */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    // Artifacts 产物中心（2026-09-14）：CLI 把输出物写 ~/.cc-deck/artifacts/ 即对全部
    // 客户端可见——列表 JSON + 静态服务（ui-review 汇总页亦由此分发，外网经 ECS 转发）
    if (req.method === "GET" && url.pathname === "/api/artifacts") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, artifacts: listArtifacts() }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      // #29（A-P2）：%ZZ 畸形编码让 decodeURIComponent 抛 URIError——未捕获会炸掉整个
      // http server request 回调（进程级风险），400 兜底
      let artName: string;
      try {
        artName = decodeURIComponent(url.pathname.slice("/artifacts/".length));
      } catch {
        res.writeHead(400).end("bad encoding");
        return;
      }
      if (!serveArtifact(artName, res)) {
        res.writeHead(404).end("not found");
      }
      return;
    }
    // 2026-09-19 输出物原地登记（意图声明制）：交付物写到它本该在的地方（项目
    // docs/ 等），agent 完成交付后 POST 登记原路径——文件不搬动，看板只记
    // path/size/时间。归因：#227 起 session_id 优先（deliver 脚本自动携带 Bash 环境的
    // CLAUDE_CODE_SESSION_ID，hook 上下文经 CC_DECK_SESSION_ID 透传）——精确挂账；
    // 无身份（手动终端调用）回落 cwd 前缀匹配最近活跃会话（见 deliverByCwd）
    if (req.method === "POST" && url.pathname === "/api/deliver") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c;
        if (body.length > 8192) req.destroy();
      });
      req.on("end", () => {
        try {
          const { path: p, cwd, session_id: sid } = JSON.parse(body) as {
            path?: unknown; cwd?: unknown; session_id?: unknown;
          };
          if (typeof p !== "string" || !p.trim()) {
            res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"error":"path 必填"}');
            return;
          }
          const validated = validateDeliverablePath(p);
          if (!validated.ok) {
            res.writeHead(400, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: false, error: validated.error }));
            return;
          }
          const c = typeof cwd === "string" && cwd ? cwd : p;
          // #72A0FIX2：校验闸快照随签名穿透进登记侧——mgr 不再二次 stat（TOCTOU
          // 剩余段收口），unverified 标记由登记侧落账（deliverables.json + 账面）
          const r = typeof sid === "string" && /^[A-Za-z0-9-]{8,64}$/.test(sid)
            ? mgr.deliverBySession(sid, c, validated.path, validated)
            : mgr.deliverByCwd(c, validated.path, validated);
          // #72A0（P1-1B）：校验闸已在 open+fstat 同一时刻采集 stat 快照并标记
          // symlink 分量（unverified——原地交付合法不拒绝，目标元数据不当文件本体
          // 口径）；标记随响应回传供调用方核对
          const respBody = r.ok && validated.unverified ? { ...r, unverified: true } : r;
          res.writeHead(r.ok ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(respBody));
        } catch {
          res.writeHead(400).end("bad json");
        }
      });
      return;
    }
    // #26 M2 分诊指令通道（Leader 会话有 Bash，分诊决策 = 执行 org CLI → 此处）：
    // POST /api/org?token=...  body { action, ...payload }，action 全集见
    // session-manager.orgAction（status/project-create/project-status/project-tier/
    // suggest-hold/dispatch/board/project-detail；M3 追加 rate/tag——路由表评鉴，
    // Leader 手动记 good/bad 与技能标签；#26 补章追加 member-retire/member-add——
    // 编制面执行动作）。鉴权循 deliver 先例（主 token）。
    // 用户端决议不经此（走 WS COMMAND_ORG_CONFIRM）——Leader 只提案不决议。
    // M1/M2 审查轮：白名单强制上述口径——confirm-decide 属人类决议面，HTTP 放行
    // 等于允许读过 token 的进程（含 Leader/被注入的 worker）自批确认卡，绕过
    // 「用户是指挥/验收者」的确认门槛（此前只是注释声明，未强制）
    if (req.method === "POST" && url.pathname === "/api/org") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c;
        if (body.length > 65536) req.destroy(); // 派单 prompt 可长，64KB 上限
      });
      req.on("end", () => {
        try {
          const { action, ...payload } = JSON.parse(body) as { action?: unknown };
          if (typeof action !== "string" || !action.trim()) {
            res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"error":"action 必填"}');
            return;
          }
          // 决议类动作不开放 HTTP（Leader 提案面）；未来新增 orgAction 动作默认
          // 也不放行，需显式加白名单（防决议面被新动作意外扩大）
          const ORG_HTTP_ACTIONS = new Set([
            "status", "project-create", "project-status", "project-tier", "suggest-hold",
            "dispatch", "board", "project-detail", "rate", "tag",
            "member-retire", "member-add", // #26 补章：编制面执行动作（可逆：复拉走 member-add），非决议类
            // W-EXPP1 经验库动作（非决议类：写入面走经验库自身硬校验+软上限+漏斗审计
            // 行，无用户决策卡语义；exp-list/exp-export 只读——org exp 子命令的 HTTP 面）
            "exp-append", "exp-bump", "exp-retire", "exp-restore", "exp-list",
            "auth-bypass", // W-PERMERR：授权位写入口（org CLI 专用；on/off 均非决议类——写/撤授权文件）
            // W-EXPP2 面板组合动作（D1-6 补申报/改归组）：HTTP 面与 WS 面同权开放
            "exp-regroup",
            // W-EXPP1 追加：导出备份/导入恢复（导入整读校验+零半写在 store 层）
            "exp-export", "exp-import",
            // W-KWP1 件三：岗位模板库只读查看（org role list/show 的 HTTP 面；写面 P2）
            "role-list", "role-show",
            // W-RULES1 团队规则库（org/rules.json 的 HTTP 面 = org rule 子命令）：直写
            // 面带 direct 标记（用户 CLI 主权面，org exp append 同款信任级）；缺省=
            // 提案出确认卡（零写入，决议仍走用户端——rule-append 不给 HTTP 开直批口，
            // 入库动作在用户 ✓ 后 applyConfirmEffects 落，Leader 无法自批）
            "rule-append", "rule-list", "rule-retire", "rule-supersede",
            // W-RULES1 升格（经验→规则复制，拍板 #5；org rule promote 的 HTTP 面）
            "exp-promote",
            // W-CMDIMPL ①（#216，设计 §1.1）：收割机器闸——纯机械只读+命令建议打印，
            // 零写入/无确认卡语义，信任级低于 dispatch（写面）非决议类，可开 HTTP。
            // WS 面同权开放（orgAction 单漏斗 case 同名——W-RULES2 的 P1 教训不复发）
            "harvest-check",
          ]);
          if (!ORG_HTTP_ACTIONS.has(action.trim())) {
            res.writeHead(403, { "content-type": "application/json" }).end(
              JSON.stringify({ ok: false, error: `action「${action.trim()}」不开放 HTTP 通道（决议类只走用户端确认卡）` }),
            );
            return;
          }
          const r = mgr.orgAction(action.trim(), payload as Record<string, unknown>);
          res.writeHead(r.ok ? 200 : 422, { "content-type": "application/json" }).end(JSON.stringify(r));
        } catch {
          res.writeHead(400).end("bad json");
        }
      });
      return;
    }
    // #125 验收单在线表单：GET /acceptance/<id> 出自包含表单页，POST /api/acceptance
    // 收勾选结果落 data/acceptances/<id>.results.json。鉴权=登记白名单（id 32hex 必须
    // 命中已登记文件）+ 限流；不使用 relay 主 token——填表链接永不携带主 token。
    if (req.method === "GET" && url.pathname.startsWith("/acceptance/")) {
      const id = url.pathname.slice("/acceptance/".length).replace(/\/+$/, "");
      if (!serveAcceptancePage(id, res)) res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // #175 云版表单页：apiPath 烙成 CF Worker 的 /view/acceptance-<id>.results.json
    //（提交落 KV、relay 回流），出单工具 curl 本端点拿 HTML 后上传 KV——公司网浏览器
    // 经 https://cc.humumu.online/view/acceptance-<id>.html 打开填写。页面无密钥可公开。
    if (req.method === "GET" && url.pathname.startsWith("/acceptance-cloud/")) {
      const id = url.pathname.slice("/acceptance-cloud/".length).replace(/\/+$/, "");
      const apiPath = `/view/acceptance-${id}.results.json`;
      if (!serveAcceptancePage(id, res, apiPath)) res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/acceptance") {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c;
        if (body.length > 65536) req.destroy();
      });
      req.on("end", () => {
        try {
          const { id, rows } = JSON.parse(body) as { id?: unknown; rows?: unknown };
          const acc =
            typeof id === "string" && ACCEPTANCE_ID_RE.test(id) ? loadAcceptance(id) : null;
          if (typeof id !== "string" || !acc) {
            res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false,"error":"验收单不存在"}');
            return;
          }
          if (rateLimited(id)) {
            res.writeHead(429, { "content-type": "application/json" }).end('{"ok":false,"error":"提交太频繁"}');
            return;
          }
          const ua = String(req.headers["user-agent"] ?? "");
          const err = saveResult(id, { rows }, ua);
          if (err) {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          // #138 回填自动回流：按出单时盖进记录的 cwd 归因到会话推 system 行（详见
          // notifyAcceptanceRefill；与 #175 云回流共用同一条通知路径）
          notifyAcceptanceRefill(acc, rows, mgr);
          mgr.settleAcceptanceResult(id); // M12-7 收单归因回写（幂等，与云回流同口径）
          // #184 状态即时广播：LAN 提交落盘即推（云回流走 poll tick 的签名对账）
          emitAcceptancesUpdated(bus);
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"error":"bad json"}');
        }
      });
      return;
    }
    // #448 插件可选能力配置（设置「插件」页三开关）：读写 ~/.cc-deck/config.json 的
    // taskGuard/qNotify/restorePoint。hooks（guard-stop/guard-context）与本端点共用该
    // 文件为单一事实源；缺省 taskGuard=false / qNotify=true / restorePoint=false。
    // 鉴权与 CORS 与 /api/pair-code 同款（LAN token + 部署域白名单 + #43 回环豁免）；
    // POST 参数走 query（?taskGuard=1）避免跨源 JSON body 触发预检。
    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/plugin-config") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      void handlePluginConfig(req, res);
      return;
    }
    // Slash 命令列表（手机/网页输入联想）：内置表 + 用户级 ~/.claude/commands +
    // 项目级 <cwd>/.claude/commands（cwd 经 LAN token 鉴权后信任，与 WS 命令同信任级）
    if (req.method === "GET" && url.pathname === "/api/commands") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const cwd = url.searchParams.get("cwd") ?? "";
      const custom = [
        ...listCustomCommands(join(homedir(), ".claude", "commands"), "user"),
        ...(cwd ? listCustomCommands(join(cwd, ".claude", "commands"), "project") : []),
      ];
      // 自定义命令同名覆盖内置
      const seen = new Set(custom.map((c) => c.name));
      const commands: SlashCommand[] = [
        ...custom,
        ...BUILTIN_COMMANDS.filter((c) => !seen.has(c.name)).map((c) => ({ ...c, source: "builtin" as const })),
      ];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ ok: true, commands }));
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    console.log(`[ws-upgrade] from=${req.socket.remoteAddress} path=${url.pathname}`);
    if (url.pathname !== "/ws") {
      console.log(`[ws-upgrade] reject: bad path`);
      socket.destroy();
      return;
    }
    // #316 手表配对信道：?pair=1 无 token（手表 mDNS 发现后走此路，等手机比对 6 位码授权）。
    // 连接标记 pairing=true：不订事件、不收命令，授权通过才把 token 发给它自行重连正规信道
    const pairing = url.searchParams.get("pair") === "1";
    if (!pairing && (url.searchParams.get("token") ?? "") !== cfg.token) {
      console.log(`[ws-upgrade] reject: token mismatch`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    console.log(`[ws-upgrade] accepted${pairing ? " (pairing)" : ""}`);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, url));
  });

  // ── #316 手表配对池：PAIR_REQUEST/PAIR_RESOLVED 是瞬态帧（seq:0 不进 EventBus，
  // 不落 events.ndjson），只直播给 LAN 已鉴权客户端；授权命令同样只在 ws-server 层消化
  const PAIR_TTL_MS = 120_000;
  const watchPairings = new Map<
    string,
    { name: string; code: string; ws: WebSocket; timer: ReturnType<typeof setTimeout> }
  >();
  const lanBroadcast = (obj: unknown): void => {
    const text = JSON.stringify(obj);
    for (const client of wss.clients) {
      if ((client as ClientWs).pairing) continue;
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  };
  const pairResolvedFrame = (requestId: string, decision: "allow" | "deny" | "timeout") =>
    lanBroadcast({ seq: 0, session_id: "", ts: Date.now(), type: "PAIR_RESOLVED", payload: { request_id: requestId, decision } });
  function resolvePairing(requestId: string, decision: "allow" | "deny" | "timeout"): void {
    const p = watchPairings.get(requestId);
    if (!p) return;
    watchPairings.delete(requestId);
    clearTimeout(p.timer);
    try {
      if (decision === "allow") p.ws.send(JSON.stringify({ type: "PAIR_OK", token: cfg.token }));
      else if (decision === "deny") p.ws.send(JSON.stringify({ type: "PAIR_DENY" }));
      else p.ws.send(JSON.stringify({ type: "PAIR_TIMEOUT" }));
    } catch {}
    // 给帧留出 flush 时间再关；watch 拿到 token 自行断开重连正规信道
    setTimeout(() => {
      try {
        p.ws.close();
      } catch {
        try {
          p.ws.terminate();
        } catch {}
      }
    }, 400);
    pairResolvedFrame(requestId, decision);
    console.log(`[pair] watch pairing ${requestId} -> ${decision}`);
  }
  function startWatchPairing(ws: WebSocket, url: URL): void {
    // 未鉴权标记必须最先打：池满拒绝路径也要带着它走（close 握手可被扣住 ~30s，
    // 期间 bus/lanBroadcast 会把全部会话事件漏给这条连接——#316 审查 Critical）
    (ws as ClientWs).pairing = true;
    if (watchPairings.size >= 5) {
      // 并发待配对池上限：防 LAN 内恶意设备刷请求轰炸手机弹窗
      try { ws.send(JSON.stringify({ type: "PAIR_DENY", reason: "配对请求过多，请稍后再试" })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    const requestId = randomUUID();
    const name = (url.searchParams.get("name") ?? "手表").slice(0, 24);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const entry = { name, code, ws, timer: setTimeout(() => resolvePairing(requestId, "timeout"), PAIR_TTL_MS) };
    watchPairings.set(requestId, entry);
    ws.on("close", () => {
      // 手表放弃（断开）：清池并通知手机收弹窗
      if (watchPairings.get(requestId)?.ws === ws) {
        watchPairings.delete(requestId);
        clearTimeout(entry.timer);
        pairResolvedFrame(requestId, "timeout");
      }
    });
    try {
      ws.send(JSON.stringify({ type: "PAIR_PENDING", request_id: requestId, code, expires_in: Math.floor(PAIR_TTL_MS / 1000) }));
    } catch {}
    lanBroadcast({
      seq: 0, session_id: "", ts: Date.now(), type: "PAIR_REQUEST",
      payload: { request_id: requestId, name, code, expires_in: Math.floor(PAIR_TTL_MS / 1000) },
    });
    console.log(`[pair] watch pairing request id=${requestId} name=${name}`);
  }

  wss.on("connection", (ws: WebSocket, url: URL) => {
    const clientId = `web-${connectionCounter++}`;
    (ws as ClientWs).isAlive = true;
    (ws as ClientWs).clientId = clientId;
    ws.on("pong", () => {
      (ws as ClientWs).isAlive = true;
    });
    ws.on("error", () => undefined);

    if (url.searchParams.get("pair") === "1") {
      startWatchPairing(ws, url);
      return;
    }

    const lastSeq = Number(url.searchParams.get("last_seq") ?? "0") || 0;
    // W-MODE：replay 补发同样滤锚卡 SESSION_CREATED（no-leader 态重连不复活锚卡；
    // 其余帧端上无卡自然无操作）
    const replay = lastSeq > 0 && !bus.isBeyondBuffer(lastSeq) ? bus.replayAfter(lastSeq).filter((env) => !mgr.suppressLeaderEvent(env)) : null;
    // 落后太多 = 客户端冷启动（内存空但 localStorage 存着旧 seq）：增量事件只能更新
    // 已知会话、建不出列表，且上千帧补发挤占带宽——超过阈值直接 SNAPSHOT 全量重建
    if (replay && replay.length <= REPLAY_FAST_MAX) {
      for (const env of replay) ws.send(JSON.stringify(env));
      // #265 增量续传对账：快路径无 SNAPSHOT，补发 SESSIONS_RECONCILE 清集合外陈旧卡
      ws.send(JSON.stringify(buildSessionsReconcile(mgr, opts.relayName?.())));
    } else {
      // #408 大帧根治：日志不再全量内联（随历史膨胀，实测 3 会话即 0.63MiB，规模
      // 上去必撞 CF 桥 1MiB 单帧硬限），改预算装配（每会话最近 K 条 + 总字节上限，
      // 与云通道同一构建）。客户端 timelines 接受截断语义；logs_truncated 标记供 UI 提示
      // W-INJECT 问题④：LAN 直连走宽窗（4MB/1200）——重启/冷启动后面板转录不再被
      // #408 云端安全窗口（50 条/会话）替换出「历史回滚数小时」；云端 buildSnapshotLogs()
      // 默认值不动（CF 桥 1MiB 单帧硬限）
      const snapLogs = mgr.buildSnapshotLogs(SNAPSHOT_LOGS_LAN.budgetBytes, SNAPSHOT_LOGS_LAN.perSessionCap);
      const snapshot: Envelope = {
        seq: bus.lastSeq(),
        session_id: "",
        ts: Date.now(),
        type: "SNAPSHOT",
        payload: {
          // W-SRC2 #134：每条会话随 SNAPSHOT 自报 relay_source（=本 relay 显示名）——
          // 聚合端零拼装（此前全靠客户端三处补丁打标：t25fix/B4 桥/B2 建卡，存量卡/
          // 打标时序竞态漏标=用户 1016/1021 两报根因）。旧客户端 session.relay_source
          // 客户端打标有 `|| srcTag`/`if (!s.relay_source)` 守卫=自带字段自动优先，
          // 向前兼容零改
          sessions: withRelaySource(mgr.snapshot(), opts.relayName?.()),
          logs: snapLogs.logs,
          ...(Object.keys(snapLogs.logs_truncated).length ? { logs_truncated: snapLogs.logs_truncated } : {}),
          server_time: Date.now(),
          schema_version: SNAPSHOT_SCHEMA_VERSION,
          homedir: homedir(),
          // relay 本机平台（#8：手机端 NewSessionModal 自适应路径文案/盘符拦截依据；
          // #117 教训——云通道快照同名字段必须同步，云桥手机才收得到）
          platform: process.platform,
          models: listModels(mgr.cfg.model),
          // #71 输出物开关：恒布尔随快照下发（旧客户端忽略未知键），三端 tab 据此显隐
          deliverables: readPluginConfig().deliverables,
          // #137 三步方案②：验收单待填态汇总（云通道 cloud-client 同步携带）
          acceptances: listAcceptances(),
          // #212 允许并记住：已记规则全量（设置页「记住的规则」列表数据源；
          // 空数组也下发——端上以字段存在性判断能力，与 deliverables 同口径）
          allow_rules: mgr.allowRules.list(),
          // #26 M2 组织：项目组索引 + 待决确认单（cloud-client 云通道快照同步携带，
          // #117 教训）
          projects: listGroups(),
          org_confirms: listPendingConfirms(),
          // P0 板持久信道（夜审 B2-F1）：板全量随 SNAPSHOT——断连端重连即追平
          //（BOARD_UPDATED 瞬态不补发+板此前不随快照=断连窗口变更全丢的根治）；
          // web 消费面 6896 行早已锚 payload.boards（本批只补 relay 下发）；
          // 体积守卫与 lessons 摘除口径见 listBoards；detail 按需拉保留为旧 relay
          //（boards 缺省）与超守卫规模的回退路
          ...(() => { const b = listBoards(); return b === null ? {} : { boards: b }; })(), // 守卫弃发=键缺席（旧 relay 形态，单次读盘）；空数组也下发=能力位
          // W-EXPP2 经验库：全量条目锚定帧 + 总开关（空数组也下发——端上以字段存在性
          // 判断能力；cloud-client 云通道快照同步携带，#117 教训）
          experience: listExperience(),
          experience_enabled: readPluginConfig().experience,
          // W-RULES2 团队铁律库：全量条目锚定帧 + 总开关（experience 同款口径——空数组
          // 也下发，端上以字段存在性判断能力；cloud-client 云通道快照同步携带，#117 教训）
          rules: listRules(),
          rules_enabled: readPluginConfig().rules,
          // #018-R1c 决策通知账（cloud-client 云通道同步携带，#117 教训；空数组也
          // 下发——端上以字段存在性判断能力）
          notifications: mgr.notificationsList(),
          // #17 第二批：雇员独立家开关（设置页数据源；cloud-client 云通道同步携带，
          // #117 教训）
          settings: mgr.employeeHomeState(),
          // W-MODE 协作模式（设置-团队域开关数据源；no-leader 时 sessions 已由
          // snapshot() 过滤锚卡；cloud-client 云通道快照同步携带，#117 教训）
          collab_mode: mgr.collabMode(),
          // #240 W-LEADERHIDE：锚 Leader 会话 id 随快照下发（空串=无锚/旧 relay 缺席）
          // ——端上列表滤 Leader 卡唯一可靠识别（锚不在团队编制 headcount，反查失效）
          leader_session_id: mgr.leaderSessionId(),
          // W-DESIGNHUB 系统设计图纸清单（设置-关于「系统设计图纸」区 + 项目域总览
          // 「设计图纸」区数据源；空数组/缺键 = 入口隐藏——旧 relay 与缺 docs 部署
          // 自动降级。移动端暂缓，云通道不带）
          design_docs: listDesignDocs(webRoot),
          // M13-2 v2 投影协议能力位：端上（expo/Tauri/Web）据此启用五态渲染与
          // PROJECTS/BOARD_UPDATED delta merge 分支；phone 出口同发（#117，M13-1 闸），
          // WAN 手表极简集不带（M13-1 断言 WAN ⊆ 核心+截断）
          // P81-9 kill-switch off：permission 摘要停发（端上经 P81-8 双端 undefined
          // 降级面自动隐藏=三端自动还原）；engine_catalog 属 #75 线不受开关影响
          source_capabilities: { projection_v2: true, ...(permissionPolicyEnabled() ? { permission: permissionCapabilitiesSummary() } : {}), engine_catalog: engineCatalogSummary(mgr.cfg.model) },
          // 云桥启用的 relay 附带自身设备 id（= CloudConfig.relayDev 同源值）：
          // 客户端据此密码学匹配"LAN 直连条目"与"云桥条目"是同一台 relay，自动合并。
          // wan_dev（F7）：手表 /wan 透传通道的凭据 dev，手机侧写进手表连接配置
          ...(opts.cloudRelayDev?.() ? { relay_dev: opts.cloudRelayDev() } : {}),
          ...(opts.cloudWanDev?.() ? { wan_dev: opts.cloudWanDev() } : {}),
          ...(opts.relayName?.() ? { relay_name: opts.relayName() } : {}), // #100
          ...(opts.lanHint?.() ? { lan_hint: opts.lanHint() } : {}), // #95 同网直连提示
        },
      };
      ws.send(JSON.stringify(snapshot));
    }

    ws.on("message", (data) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(data)) as Command;
      } catch {
        ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: "?", ok: false, error: "invalid JSON" }));
        return;
      }
      if (cmd && (cmd as { type?: string }).type === "PING") {
        // 手机应用层心跳（云/LAN 同协议）：探测 NAT 半开
        ws.send('{"type":"PONG"}');
        return;
      }
      // #45 三码体系·客户端间转发：手机「从手机导入」的回发帧（t=ccdeck-import-resp）
      // 不是命令——原样转发给同 relay 的其他已认证 ws 客户端（网页/exe 的导入监听器）。
      // #29（A-P1）：pairing 未鉴权连接必须跳过——该帧含 LAN 主 token/云桥凭据，
      // 转给待配对手表连接等于把全部凭据喂给任意 LAN 设备（2 分钟配对窗常驻可收）
      if (cmd && (cmd as { t?: string }).t === "ccdeck-import-resp") {
        const raw = JSON.stringify(cmd);
        for (const c of wss.clients) {
          if (c === ws || (c as ClientWs).pairing) continue;
          if (c.readyState === WebSocket.OPEN) c.send(raw);
        }
        ws.send('{"t":"ccdeck-import-resp-ack"}');
        return;
      }
      if (
        !cmd ||
        typeof cmd.command_id !== "string" ||
        typeof cmd.type !== "string" ||
        typeof cmd.payload !== "object" ||
        cmd.payload === null
      ) {
        ws.send(
          JSON.stringify({
            type: "COMMAND_ACK",
            command_id: typeof cmd?.command_id === "string" ? cmd.command_id : "?",
            ok: false,
            error: "invalid command shape",
          }),
        );
        return;
      }
      if (!COMMAND_TYPES.has(cmd.type)) {
        ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: false, error: "unsupported command" }));
        return;
      }
      // #316 手表配对授权：ws-server 层消化（持有待配对池），不进 mgr
      if (cmd.type === "COMMAND_WATCH_GRANT") {
        const p = cmd.payload as { request_id?: unknown; allow?: unknown };
        const rid = typeof p.request_id === "string" ? p.request_id : "";
        if (!watchPairings.has(rid)) {
          ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: false, error: "配对请求不存在或已过期" }));
          return;
        }
        resolvePairing(rid, p.allow ? "allow" : "deny");
        ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: true }));
        return;
      }
      const ack = mgr.handleCommand(cmd, clientId);
      ws.send(JSON.stringify({ type: "COMMAND_ACK", ...ack }));
    });
  });

  // 全局事件广播（#316：待配对手表未鉴权，不收事件）。
  // #79 定向瞬态帧（env.to）：只发给命令来源连接——大流量分块不殃及同 relay 的
  // 其他在线端（否则一次 20MB 拉取会向所有客户端广播 ~27MB base64）
  const unsubscribe = bus.subscribe((env) => {
    // W-MODE：no-leader 态锚卡 SESSION_CREATED 不下发（端上唯一建卡帧；UPDATED 等
    // 对无卡端无操作——suppressLeaderEvent 内部非 CREATED 帧零读盘短路）
    if (mgr.suppressLeaderEvent(env)) return;
    const text = JSON.stringify(env);
    for (const client of wss.clients) {
      const cw = client as ClientWs;
      if (cw.pairing) continue;
      if (env.to && cw.clientId !== env.to) continue;
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as ClientWs;
      if (!c.isAlive) {
        c.miss = (c.miss ?? 0) + 1;
        if (c.miss >= HEARTBEAT_MISS_LIMIT) {
          client.terminate();
          continue;
        }
      } else {
        c.miss = 0;
      }
      c.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);

  // #2025-10 架构审查 C 路发现：无 error 监听 → EADDRINUSE 被吞 → 僵尸 relay
  // （已持锁但不监听端口不退出）。加 error 监听器：端口冲突时打日志并 process.exit(1)，
  // 让 launchd KeepAlive 重启出干净实例（而非僵尸共存）。
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[relay] 端口 ${cfg.port} 被占用（可能已有实例），退出让 launchd 重启。`);
      process.exit(1);
    }
    console.error(`[relay] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(cfg.port, opts.onReady);

  return {
    port: cfg.port,
    bridge,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        bridge.close();
        unsubscribe();
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

// #448 /api/plugin-config：GET 读三键；POST query/body 布尔值合并写（未知键保留、
// 无效值忽略）。token 鉴权在路由层完成；CORS 与 /api/pair-code 同款
async function handlePluginConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = (req.headers.origin ?? "").trim();
  const ips = localIps();
  const hostOk = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
  let acao = "";
  // Origin:"null" 豁免已删除（同 /local-info，P1FIX 2026-10-10：沙箱 iframe 可造
  // Origin:null；本端点已持 LAN token 才可达，豁免无合法消费方）
  if (origin) {
    try {
      const u = new URL(origin);
      if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostOk(u.hostname)) acao = origin;
    } catch {}
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(acao ? { "access-control-allow-origin": acao } : {}),
  };
  if (req.method === "GET") {
    res.writeHead(200, headers).end(JSON.stringify({ ok: true, config: readPluginConfig() }));
    return;
  }
  // POST：吸掉 body（可能为空/JSON）后合并 query 参数写入；只认白名单键布尔（PLUGIN_CFG_KEYS），其余忽略
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  let parsed: Record<string, unknown> = {};
  try {
    if (body.trim()) parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {}
  const next = readPluginConfig();
  let changed = false;
  // query 值只认 1/true/0/false（缺参/空串/垃圾值视为未传），body 值必须是布尔
  const parseQBool = (v: string): boolean | undefined => {
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return undefined;
  };
  for (const k of PLUGIN_CFG_KEYS) {
    const raw = url.searchParams.get(k);
    const qb = raw === null ? undefined : parseQBool(raw);
    const bv = parsed[k];
    if (qb !== undefined) {
      next[k] = qb;
      changed = true;
    } else if (typeof bv === "boolean") {
      next[k] = bv;
      changed = true;
    }
  }
  if (changed) {
    try {
      // 保留文件里的未知键（前向兼容），写完回读返回生效值。
      // dev 形态 dataDir=relay/data，~/.cc-deck 可能还不存在——先建目录再写
      let full: Record<string, unknown> = {};
      try {
        full = JSON.parse(readFileSync(pluginConfigPath(), "utf-8")) as Record<string, unknown>;
      } catch {}
      for (const k of PLUGIN_CFG_KEYS) full[k] = next[k];
      mkdirSync(dirname(pluginConfigPath()), { recursive: true });
      writeFileSync(pluginConfigPath(), JSON.stringify(full, null, 2) + "\n", "utf-8");
    } catch {
      res.writeHead(500, headers).end(JSON.stringify({ ok: false, error: "config.json 写入失败" }));
      return;
    }
  }
  res.writeHead(200, headers).end(JSON.stringify({ ok: true, config: readPluginConfig() }));
}

// #393 /api/notify：手动注入 TASK_DONE（悬浮框通知），LAN token 鉴权
// bus（#52）：mode=confirm 时除注入 [待确认] todo 外，同步 emitTransient USER_NOTE
// 直播全部在线端（web/exe/手机弹通知；seq:0 不落盘不补发，离线端由 todo 兜底）
async function handleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  mgr: SessionManager,
  cfg: RelayConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if ((url.searchParams.get("token") ?? "") !== cfg.token) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  try {
    const p = JSON.parse(body) as { session_id?: string; done?: unknown; mode?: string; text?: unknown; dispatch_id?: unknown; stage?: unknown; stage_detail?: unknown };
    // W-CMDIMPL T1-STAGE（#216，设计 §1.5）：mode=stage——worker 阶段事件入派单台账
    //（STAGE:{task, stage, detail} 语义）。纯记账面：同 id 追加行，status 保持 running
    //（阶段事件不改终态语义）；stages 历史由 harvest-check 读侧扫描。词表（拍板 #9）：
    // 基表 merged|bumped|tagged|ci-green|distributed|receipt-filed + custom.<名> 前缀
    //——reducer schema 校验拒词表外（appendDispatch 内 applyOrgChange）。
    if (p.mode === "stage") {
      const did = typeof p.dispatch_id === "string" ? p.dispatch_id.trim() : "";
      const stage = typeof p.stage === "string" ? p.stage.trim() : "";
      const detail = typeof p.stage_detail === "string" ? p.stage_detail.trim().slice(0, 200) : undefined;
      if (!did || !stage) { res.writeHead(400).end('{"error":"dispatch_id 与 stage 必填"}'); return; }
      const last = readDispatchLog().find((x) => x.id === did);
      if (!last) { res.writeHead(404).end('{"error":"台账无此 dispatch_id（阶段事件依附已有派单行）"}'); return; }
      const row = {
        ts: Date.now(),
        id: last.id,
        tier: last.tier,
        target: last.target,
        ...(last.project_anchor ? { project_anchor: last.project_anchor } : {}),
        status: "running" as const, // 阶段事件不改终态语义（§1.5）
        session_id: last.session_id,
        ...(last.title ? { title: last.title } : {}),
        ...(last.actor ? { actor: last.actor } : {}),
        ...(last.engine ? { engine: last.engine } : {}),
        ...(last.provider ? { provider: last.provider } : {}),
        ...(last.model ? { model: last.model } : {}),
        stage,
        ...(detail ? { stage_detail: detail } : {}),
      };
      if (!appendDispatch(row)) { res.writeHead(422).end('{"error":"stage 行校验拒写（词表外？）"}'); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode: "stage", dispatch_id: did, stage }));
      return;
    }
    // #393 mode=confirm：黄框 [待确认] 推送（text 单条），否则绿框 TASK_DONE（done 列表）
    if (p.mode === "confirm") {
      const text = typeof p.text === "string" ? p.text.trim().slice(0, 120) : "";
      if (!text) { res.writeHead(400).end('{"error":"text 不能为空"}'); return; }
      const sessions = mgr.snapshot();
      // session_id 兼容裸 CLI id：外部会话 relay id = "ext-"+<cli_sid>（#448 守卫 hook 直传裸 sid）
      const target =
        (p.session_id
          ? (sessions.find((s) => s.session_id === p.session_id) ??
            sessions.find((s) => s.session_id === "ext-" + p.session_id))
          : undefined) ||
        sessions.find((s) => s.status === "WORKING" && s.external) ||
        sessions.find((s) => s.external) ||
        sessions[0];
      // W-RESTARTDESIGN 案二（F6）：无在线会话不再 503 即丢——notifyConfirm 只吃在册
      // session，此处无 target 时落 ledger（system/task-done 条目，离线重载不丢）后
      // 200+queued（通知语义=最终被看到，非此刻弹窗；调用脚本无 -f 无 body 解析零改动）
      if (!target) {
        mgr.notifyLeaderSystem(`[待确认·排队] ${text}`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode: "confirm", queued: true }));
        return;
      }
      mgr.notifyConfirm(target.session_id, text);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode: "confirm", session_id: target.session_id }));
      return;
    }
    const items = Array.isArray(p.done) ? p.done.filter((x): x is string => typeof x === "string" && !!x).slice(0, 10) : [];
    if (!items.length) { res.writeHead(400).end('{"error":"done 不能为空"}'); return; }
    const sessions = mgr.snapshot();
    const target =
      (p.session_id ? sessions.find((s) => s.session_id === p.session_id) : undefined) ||
      sessions.find((s) => s.status === "WORKING" && s.external) ||
      sessions.find((s) => s.external) ||
      sessions[0];
    // W-RESTARTDESIGN 案二（F6）：TASK_DONE 同款——无会话落 ledger 后 200+queued（不 503 即丢）
    if (!target) {
      mgr.notifyLeaderSystem(`[任务完成·排队] ${items.slice(0, 3).join("；")}${items.length > 3 ? ` 等 ${items.length} 项` : ""}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, queued: true }));
      return;
    }
    const remaining = target.todos ? target.todos.filter((t) => t.status !== "completed").length : 0;
    mgr.notifyDone(target.session_id, items, remaining);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, session_id: target.session_id }));
  } catch {
    res.writeHead(400).end('{"error":"bad json"}');
  }
}

// hooks 桥接入口：仅本机回环 + bridge token；PreToolUse 可能长轮询挂起
async function handleBridgeHook(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: Bridge,
  cfg: RelayConfig,
): Promise<void> {
  const remote = req.socket.remoteAddress ?? "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback || (req.headers["x-bridge-token"] ?? "") !== cfg.bridgeToken) {
    res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
    return;
  }
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  try {
    const ev = JSON.parse(body) as BridgeEvent;
    const decision = await bridge.handleEvent(ev);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
  }
}

interface ClientWs extends WebSocket {
  isAlive: boolean;
  miss?: number; // #85 连续未回 pong 轮数（达到 HEARTBEAT_MISS_LIMIT 才 terminate）
  pairing?: boolean; // #316 待配对手表（/ws?pair=1）：未鉴权，不收事件、不发命令
  clientId?: string; // #79 本连接的命令来源 id（web-N）：定向瞬态帧（to 字段）的过滤键
}

let connectionCounter = 0;
