// W-WATCHAGENT（1104 用户令「1、2 都要」之二）巡查员 Agent 化专项测试：
//   ① 岗位模板入库：内置库 slug=watchdog（org role show 可见）+ 注入块含证据锚纪律行
//   ② 巡查员在编定位：active 组 headcount role=watchdog 且会话在册 → 命中；
//      非本岗/组挂起/会话不在册 → 不命中
//   ③ 喂料链：patrol-report.md 新增告警行 → tick 投递（prompt 含行原文=证据锚材料）
//      → 水位持久化 → 次轮静默（onset-only 常态零打扰）→ WORKING 跳过水位不动下轮补投
//   ④ 零在册巡查员 → 哑然（零投递+审计可观测）
//   ⑤ 确认卡端到端：orgAction patrol-suggest（agent 面无 direct）→ kind=patrol-suggest
//      pending → confirm-decide ✓ → patrol-config.json 落盘 + process.env 即时改 +
//      preloadPatrolOverrides 重启预载语义；✗ → 零半态；direct:true 直写即时生效
//   ⑥ 词表闸：坏 key 响亮拒 / 非正数拒
//   ⑦ 单点注册（同类绝迹机制）：WATCH_FEED_SOURCES 注册假源 → tick 全链自动覆盖
//      （水位/静默/投递零额外代码）
//   ⑧ 上岗单模板：三类问+证据锚纪律+patrol-suggest 指引在场
//   ⑨ 风暴截断：行数超预算 → 折叠保头尾+全量指引
//   ⑩ CLI 面：org.sh 物化文本含 patrol-suggest/dispatch role 透传且 bash 语法过
// 隔离口径：CCR_DATA_DIR/CCR_ORG_DIR/CCR_STORAGE_READ_MODE/CCR_PERMISSION_POLICY 四钉
//（照 test-patrol/test-role-templates 配方），store 面直接传 dir，绝不触生产。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { setGroupHeadcount, setGroupStatus } from "../src/projects.js";
import { getRoleTemplate, buildRoleInjection, resetRoleTemplatesRuntimeForTests } from "../src/role-templates.js";
import {
  WatchFeedModule, WATCH_FEED_SOURCES, WATCHDOG_ROLE,
  PATROL_TUNABLE_KEYS, applyPatrolOverride, readPatrolConfig, preloadPatrolOverrides,
  buildWatchdogOnboardingPrompt,
} from "../src/watch-feed.js";
import { listPendingConfirms } from "../src/projects.js";
import { ensureOrgCli } from "../src/org.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; process.exitCode = 1; }
  else console.log(`ok - ${msg}`);
}

const DATA = mkdtempSync(join(tmpdir(), "ccr-watchagent-"));
const ORG = mkdtempSync(join(tmpdir(), "ccr-watchagent-org-"));
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_ORG_BIN_DIR = join(ORG, "bin", "org"); // 沙盒物化面（否则 CCR_ORG_DIR 在场返回 null 不碰生产 bin）
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_PERMISSION_POLICY = "off"; // 生产现态（P81-9）——自由 role 名可达知识轴
process.env.CCR_NO_LEADER = "1";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_PROJECTS_ROOT = join(DATA, "projects-root"); // 孤儿扫描隔离（test-ws 配方——防扫真实 ~/.claude/projects）
mkdirSync(join(DATA, "artifacts"), { recursive: true });
process.env.CCR_ARTIFACTS_DIR = join(DATA, "artifacts");
// org fixture 直写（test-patrol ② 同手法）：active 轻立项组一张
writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [
  { id: "pg-watchagent", name: "巡查测试组", status: "active", tier: "轻立项", anchor_dir: "/tmp/watchagent", headcount: [], single_card: false, created_at: Date.now(), updated_at: Date.now() },
], trust_light: null }));

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
resetRoleTemplatesRuntimeForTests();

// 喂料投递缝：捕获数组（不真 spawn——投递通道生产为 resumeAgent/extInput，此处验逻辑）
const delivered: { sid: string; prompt: string; external: boolean }[] = [];
const mkFeed = (reportPath: string, extra: { maxLines?: number } = {}) => new WatchFeedModule(mgr, {
  dataDir: DATA,
  reportPath,
  enabled: () => true,
  deliver: (sid, prompt, external) => { delivered.push({ sid, prompt, external }); return true; },
  ...extra,
});

// ---------- ① 岗位模板入库 ----------
{
  const t = getRoleTemplate(WATCHDOG_ROLE);
  assert(!!t, "① 内置库命中 slug=watchdog");
  assert(t?.source === "builtin", "① 来源=内置（入仓随发版）");
  assert(!!t?.rows.some((r) => r.includes("证据锚")), "① 岗位纪律含证据锚行");
  assert(!!t?.rows.some((r) => r.includes("patrol-suggest")), "① 岗位纪律含阈值建议通道行");
  const show = mgr.orgAction("role-show", { slug: WATCHDOG_ROLE });
  assert(show.ok && (show as { data?: { template?: { slug?: string } } }).data?.template?.slug === WATCHDOG_ROLE, "① org role show watchdog 可见");
  const inj = buildRoleInjection({ session_id: "sess-fresh", role: WATCHDOG_ROLE });
  assert(!!inj && inj.block.includes("巡查员") && inj.block.includes("证据锚"), "① 派单注入块构建成功（岗位纪律进场）");
}

// ---------- ② 巡查员在编定位 ----------
const WD = "wd-session-01";
const WD_WORKER = "wd-worker-99";
const gid = "pg-watchagent";
{
  // store 层直写 headcount（绕 seatGate——external 测试会话不能入编是 seatGate 轴②语义，
  // 喂料定位只读「在册+role」，与入编闸正交）
  const r1 = setGroupHeadcount(gid, [{ session_id: WD, role: WATCHDOG_ROLE }, { session_id: WD_WORKER, role: "worker" }]);
  assert(r1.ok, "② headcount 写入（watchdog+worker 双席）");
  mgr.ensureExternal(WD, "/tmp/watchagent", "巡查员甲");
  mgr.ensureExternal(WD_WORKER, "/tmp/watchagent", "普通工人");
  const feed = mkFeed(join(DATA, "patrol-report.md"));
  const hit = feed.locateWatchdogs();
  assert(hit.length === 1 && hit[0].session_id === WD, "② 定位唯一巡查员（worker 席不命中）");
  const r2 = setGroupStatus(gid, "parked", "测试挂起");
  assert(r2.ok && feed.locateWatchdogs().length === 0, "② 组挂起后不定位（只在编组喂）");
  setGroupStatus(gid, "active", "恢复");
  assert(feed.locateWatchdogs().length === 1, "② 复活后恢复定位");
}

// ---------- ③ 喂料链（时序：告警行落盘 → tick 投递 → 水位 → 静默 → WORKING 跳过） ----------
const REPORT = join(DATA, "patrol-report.md");
{
  mgr.ensureExternal(WD, "/tmp/watchagent", "巡查员甲").status = "DONE"; // 空闲态（WORKING=在答问，喂料不打断）
  const feed = mkFeed(REPORT);
  feed.tick();
  assert(delivered.length === 0, "③ 零报告文件 → 静默零投递");
  writeFileSync(REPORT, "[2026/11/4 16:00:00] ALERT [board-doing-stale] 3 张 doing 卡滞留>60min：t-abc12345（提醒不自动重派）\n", "utf-8");
  feed.tick();
  assert(delivered.length === 1 && delivered[0].sid === WD, "③ 告警行落盘 → tick 投递到巡查员");
  assert(delivered[0].prompt.includes("ALERT [board-doing-stale]") && delivered[0].prompt.includes("t-abc12345"), "③ 投递 prompt 含报告行原文（证据锚材料）");
  assert(delivered[0].prompt.includes("[巡查喂料"), "③ 投递 prompt 自包含头在场");
  const st = JSON.parse(readFileSync(join(DATA, "watch-feed-state.json"), "utf-8")) as { cursors: Record<string, number> };
  assert(st.cursors["patrol-report"] === 1, "③ 水位持久化=1（已投行数）");
  feed.tick();
  assert(delivered.length === 1, "③ 无新行次轮静默（onset-only 常态零打扰）");
  // WORKING 跳过：新增行（append 在尾——报告 append-only 语义）+ 巡查员 WORKING → 不打断，水位不动
  const s = mgr.ensureExternal(WD, "/tmp/watchagent", "巡查员甲");
  s.status = "WORKING";
  writeFileSync(REPORT, "[2026/11/4 16:00:00] ALERT [board-doing-stale] 3 张 doing 卡滞留>60min：t-abc12345（提醒不自动重派）\n[2026/11/4 16:05:00] ALERT [worker-stale] 停滞验证 停滞>40min\n", "utf-8");
  feed.tick();
  assert(delivered.length === 1, "③ 巡查员 WORKING → 本轮跳过不打断（feedPM 同语义）");
  const st2 = JSON.parse(readFileSync(join(DATA, "watch-feed-state.json"), "utf-8")) as { cursors: Record<string, number> };
  assert(st2.cursors["patrol-report"] === 1, "③ 跳过轮水位不动（下轮重投不丢）");
  s.status = "DONE";
  feed.tick();
  assert(delivered.length === 2 && delivered[1].prompt.includes("worker-stale"), "③ 空闲后下轮补投新增行");
  // R1-F3① 心跳行滤（喂料克制）：light:/full:/board-card:/OBSERVE 常态行不投，ALERT 才投
  const before3 = delivered.length;
  writeFileSync(REPORT, "[2026/11/4 16:20:00] light: disk=OK data=OK\n[2026/11/4 16:20:00] board-card: wakeup=0 doing-stale=0\n[2026/11/4 16:21:00] OBSERVE [board-converge] 将翻正 2 张陈卡——observe 档未执行\n[2026/11/4 16:22:00] RECOVERED [worker-stale]\n", "utf-8");
  feed.tick();
  const last3 = delivered[delivered.length - 1];
  assert(delivered.length === before3 + 1 && last3.prompt.includes("RECOVERED [worker-stale]") && !last3.prompt.includes("light:"), "③ F3① 心跳/OBSERVE 行滤除，只投异常族（RECOVERED）");
  // R1-F3② 滚动窗内容锚：报告 tail 裁掉老行（含已投末行）→ 指纹重定位投新行，不重置轰炸
  const before4 = delivered.length;
  writeFileSync(REPORT, "[2026/11/4 17:00:00] ALERT [fresh-1] 滚动后新行一\n[2026/11/4 17:01:00] ALERT [fresh-2] 滚动后新行二\n", "utf-8");
  feed.tick();
  const last4 = delivered[delivered.length - 1];
  assert(delivered.length === before4 + 1 && last4.prompt.includes("fresh-1") && last4.prompt.includes("fresh-2") && !last4.prompt.includes("board-doing-stale"), "③ F3② 滚动丢老行→指纹重定位（只投新行，零重置轰炸）");
  const st4 = JSON.parse(readFileSync(join(DATA, "watch-feed-state.json"), "utf-8")) as { cursors: Record<string, number>; signatures: Record<string, string> };
  assert(st4.cursors["patrol-report"] === 2 && /^[0-9a-f]{16}$/.test(st4.signatures["patrol-report"] ?? ""), "③ F3② 水位双锚持久化（cursor+签名）");
}

// ---------- ④ 零在册巡查员哑然 ----------
{
  const before = delivered.length;
  const feed = mkFeed(REPORT); // 新实例零水位（会全量重投一次——幂等无害语义）
  setGroupHeadcount(gid, []); // 清编制 → 零巡查员
  writeFileSync(REPORT, "[2026/11/4 16:10:00] ALERT [disk] 磁盘余量 4.2GB\n", "utf-8");
  feed.tick();
  assert(delivered.length === before, "④ 零巡查员 → 哑然零投递（水位不动，上岗后首轮吃到）");
}

// ---------- ⑤ 确认卡端到端（R1-P0-F1：真 HTTP 链+真 CLI 发卡——禁直调 mgr.orgAction 绕墙） ----------
const CFG_KEY = "CCR_PATROL_DOING_STALE_MIN";
{
  delete process.env[CFG_KEY];
  // 沙盒起 ws-server（test-ws 配方：CCR_CLOUD_URL 空防公网桥+独立端口防撞生产 8787）
  process.env.CCR_CLOUD_URL = "";
  const PORT = 18790 + (process.pid % 500);
  process.env.CCR_PORT = String(PORT);
  const cfg2 = loadConfig();
  const { startServer } = await import("../src/ws-server.js");
  startServer(bus, mgr, cfg2);
  const orgUrl = `http://127.0.0.1:${PORT}/api/org?token=${cfg2.token}`;
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(orgUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as { ok?: boolean; data?: Record<string, unknown>; error?: string } };
  };
  // ⑤-a HTTP 白名单放行（R1-F1 堵①）：提案出卡
  const s1 = await post({ action: "patrol-suggest", key: CFG_KEY, value: 30, reason: "doing 滞留误报多，60→30min 更敏感", session_id: WD });
  assert(s1.status === 200 && s1.json.ok === true && typeof s1.json.data?.confirm_id === "string", `⑤ HTTP 面白名单放行+出卡${s1.json.error ? `（${s1.json.error}）` : ""}`);
  const cid = s1.json.data!.confirm_id as string;
  const pend = listPendingConfirms().find((c) => c.id === cid);
  assert(!!pend && pend.kind === "patrol-suggest", "⑤ 面板可见（pending 确认卡在账）");
  assert(!existsSync(join(DATA, "patrol-config.json")), "⑤ 出卡≠落效：patrol-config 未写（零半态）");
  assert((pend?.payload as { value?: number }).value === 30, "⑤ 卡载荷携 key/value/reason");
  // ⑤-b HTTP 面 direct 被剥（R1-F1 堵③：恒出卡，无直写通道）
  const s1b = await post({ action: "patrol-suggest", key: "CCR_PATROL_TODO_STALE_H", value: 24, direct: true, reason: "试图直写" });
  assert(s1b.json.ok === true && typeof s1b.json.data?.confirm_id === "string" && !existsSync(join(DATA, "patrol-config.json")), "⑤ HTTP 带 direct 仍出卡（剥除面）——落盘零半态");
  // ⑤-c WS 咽喉直通（R1-F1 堵②：orgCommand 不再 unsupported）
  const wsPath = mgr.orgCommand("owner", "dev-test", "patrol-suggest", { key: "CCR_PATROL_LIGHT_MS", value: 300000, reason: "WS 面板通道验证" }) as { ok: boolean; error?: string };
  assert(wsPath.ok === true, `⑤ orgCommand 咽喉直通出卡${wsPath.ok ? "" : `（${wsPath.error}）`}`);
  // ⑤-d 真 CLI 发卡（物化 org.sh）：执行轨迹断言——本 CC 执行环境的网络层吞 spawn-curl
  // 对监听端口的流量（实测：curl 连上 0 字节超时 28、Node fetch 同进程通；用户真机 shell
  // 无此层不受影响），故 CLI 真链按 bash -x 轨迹验证（URL/token/port/body/exec curl 五要素
  // 全对+到达 curl 步=脚本全逻辑），网络传输层由 ⑤-a fetch 真 HTTP 覆盖——两层合证全链。
  writeFileSync(join(DATA, "bridge.json"), JSON.stringify({ port: PORT }), "utf-8");
  const cli = ensureOrgCli() as string;
  assert(!!cli, "⑤ org CLI 物化在位");
  const spawnSync = (await import("node:child_process")).spawnSync;
  // 无监听端口（curl 0ms 拒绝 rc=7 秒回，trace 完整不挂）；剔代理+timeout 兜底
  const cliEnv = { ...process.env, CCR_DATA_DIR: DATA, CCR_TOKEN: cfg2.token, CCR_PORT: "18995", no_proxy: "*", NO_PROXY: "*" } as Record<string, string>;
  delete cliEnv.http_proxy; delete cliEnv.https_proxy; delete cliEnv.HTTP_PROXY; delete cliEnv.HTTPS_PROXY; delete cliEnv.all_proxy; delete cliEnv.ALL_PROXY;
  const cliRun = spawnSync("/bin/bash", ["-x", cli, "patrol-suggest", CFG_KEY, "45", "CLI 真链发卡验证"], { encoding: "utf-8" as const, env: cliEnv, timeout: 15_000 });
  const trace = cliRun.stderr ?? "";
  assert(cliRun.status === 7 && trace.includes("exec curl") && trace.includes(`/api/org?token=${cfg2.token}`) && trace.includes('"key": "CCR_PATROL_DOING_STALE_MIN"') && trace.includes('"value": 45'), `⑤ CLI 发卡执行轨迹全对（bash -x：URL/token/body/exec 五要素+到达 curl 步 rc=7）［${cliRun.status} ${trace.split("\n").slice(-2).join(" | ").slice(0, 140)}］`);
  // ⑤-e 用户 ✓（决议=用户面板等价，orgAction 单漏斗）→ 落效三面
  const dec = mgr.orgAction("confirm-decide", { confirm_id: cid, approve: true, by: "user-test" });
  assert(dec.ok, `⑤ confirm-decide ✓ 通过${dec.ok ? "" : `（${(dec as { error?: string }).error}）`}`);
  const pc = readPatrolConfig(DATA);
  assert(pc.overrides[CFG_KEY] === 30, "⑤ patrol-config.json 落盘 overrides=30");
  assert(process.env[CFG_KEY] === "30", "⑤ process.env 即时改（runtimeImmediate 阈值下轮巡检即吃到）");
  // 重启预载语义：清 env → preload 恢复
  delete process.env[CFG_KEY];
  const n = preloadPatrolOverrides(DATA);
  assert(n === 1 && process.env[CFG_KEY] === "30", "⑤ preloadPatrolOverrides 重启预载恢复 env");
  // ⑤-f ✗ 路径：否决 → 零半态
  const dec2 = mgr.orgAction("confirm-decide", { confirm_id: (s1b.json.data as { confirm_id: string }).confirm_id, approve: false, by: "user-test" });
  assert(dec2.ok, "⑤ ✗ 决议通过（纯留痕）");
  assert(readPatrolConfig(DATA).overrides["CCR_PATROL_TODO_STALE_H"] === undefined, "⑤ ✗ 零半态（未落效）");
}

// ---------- ⑥ 词表/值域/读侧白名单闸（R1-F2/F4/F5） ----------
{
  const bad1 = mgr.orgAction("patrol-suggest", { key: "CCR_EVIL_KEY", value: 1 });
  assert(!bad1.ok && !!(bad1 as { error?: string }).error?.includes("未知巡查阈值"), "⑥ 词表外 key 响亮拒（含词表回显）");
  const bad2 = mgr.orgAction("patrol-suggest", { key: CFG_KEY, value: -5 });
  assert(!bad2.ok && !!(bad2 as { error?: string }).error?.includes("正数"), "⑥ 非正数拒");
  // R1-F2：词表键与 patrol.ts 实读 env 对齐（SUBMITTED=_MS 毫秒档，_H 旧错键不进词表）
  const keys = PATROL_TUNABLE_KEYS.map((k) => k.key);
  assert(keys.includes("CCR_BOARD_SUBMITTED_STALE_MS") && !keys.includes("CCR_BOARD_SUBMITTED_STALE_H"), "⑥ F2 词表键=实读 env（_MS 毫秒档；_H 错键绝迹）");
  // R1-F5：值域闸（1ms 定时器风暴拒收；词表内 min/max 边界值放行）
  const storm = mgr.orgAction("patrol-suggest", { key: "CCR_PATROL_LIGHT_MS", value: 1 });
  assert(!storm.ok && !!(storm as { error?: string }).error?.includes("越界"), "⑥ F5 LIGHT_MS=1 越界拒（防定时器风暴）");
  const huge = applyPatrolOverride("CCR_PATROL_DOING_STALE_MIN", 9_999_999, DATA);
  assert(!huge.ok && huge.error?.includes("越界"), "⑥ F5 超上限拒（防永哑）");
  const edge = mgr.orgAction("patrol-suggest", { key: "CCR_PATROL_LIGHT_MS", value: 10_000 });
  assert(edge.ok === true, "⑥ F5 词表下边界值放行（10s 合法）");
  // R1-F4：读侧词表滤（手编/篡改 patrol-config 塞任意键→读面丢弃→preload 不注入）
  const evilPath = join(DATA, "patrol-config.json");
  writeFileSync(evilPath, JSON.stringify({ schema_version: 1, updated_at: Date.now(), overrides: { CCR_EVIL_INJECT: 1, ["PATH"]: "/tmp/pwn", [CFG_KEY]: 45 } }), "utf-8");
  const rc = readPatrolConfig(DATA);
  assert(rc.overrides[CFG_KEY] === 45 && rc.overrides["CCR_EVIL_INJECT"] === undefined && rc.overrides["PATH"] === undefined, "⑥ F4 读侧词表滤（任意键注入不达）");
  const savedPath = process.env.PATH;
  delete process.env[CFG_KEY];
  const n2 = preloadPatrolOverrides(DATA);
  assert(n2 === 1 && process.env[CFG_KEY] === "45" && process.env.PATH === savedPath, "⑥ F4 preload 白名单注入（词表外键零注入）");
  const bad3 = applyPatrolOverride("CCR_PATROL_LIGHT_MS", 0, DATA);
  assert(!bad3.ok, "⑥ store 层同闸（store 直调也拒）");
  assert(PATROL_TUNABLE_KEYS.length === 6 && PATROL_TUNABLE_KEYS.every((k) => k.key.startsWith("CCR_")), "⑥ 词表 6 键（patrol.ts 实读 env 名单）");
}

// ---------- ⑦ 单点注册（同类绝迹机制） ----------
const REPORT2 = join(DATA, "patrol-report-2.json");
{
  // 注册一个假巡查面源（模拟下位新事件源）——只动注册表一处，其余全链（水位/静默/投递）自动
  WATCH_FEED_SOURCES.push({
    id: "fake-zombie-audit",
    describe: "僵尸审计（测试源）",
    readIncrement: (cursor, _ctx) => {
      try {
        const lines = readFileSync(join(DATA, "fake-zombie.jsonl"), "utf-8").split("\n").filter(Boolean);
        if (lines.length <= cursor) return null;
        return { lines: lines.slice(cursor), cursor: lines.length };
      } catch { return null; }
    },
  });
  setGroupHeadcount(gid, [{ session_id: WD, role: WATCHDOG_ROLE }]);
  writeFileSync(join(DATA, "fake-zombie.jsonl"), '{"action":"zombie-retire","target":"sess-dead01","ts":1}' + "\n", "utf-8");
  const feed = mkFeed(REPORT2);
  feed.tick();
  assert(delivered.some((d) => d.prompt.includes("zombie-retire") && d.prompt.includes("僵尸审计")), "⑦ 注册即全链：假源行进摘要（零额外接线代码）");
  WATCH_FEED_SOURCES.pop(); // 还原（不留测试源进生产注册表）
  assert(WATCH_FEED_SOURCES.length === 1, "⑦ 注册表还原干净");
}

// ---------- ⑧ 上岗单模板 ----------
{
  const p = buildWatchdogOnboardingPrompt(REPORT, DATA);
  assert(p.includes("健康吗") && p.includes("为什么") && p.includes("哪些在打转"), "⑧ 上岗单三类问在场");
  assert(p.includes("证据锚"), "⑧ 上岗单证据锚纪律在场");
  assert(p.includes("patrol-suggest"), "⑧ 上岗单阈值建议通道指引在场");
}

// ---------- ⑨ 风暴截断 ----------
{
  const st = mgr.ensureExternal(WD, "/tmp/watchagent", "巡查员甲");
  st.status = "DONE";
  const lines = Array.from({ length: 100 }, (_, i) => `[2026/11/4 17:00:00] ALERT [storm-${i}] 风暴行 ${i}`).join("\n") + "\n";
  writeFileSync(join(DATA, "storm-report.md"), lines, "utf-8");
  // 独立 dataDir：水位账按源 id 键——③ 段水位在 DATA 根，换文件不换账会 ts 错位静默（生产报告路径恒一，仅测试多文件场景需隔离）
  mkdirSync(join(DATA, "storm"), { recursive: true });
  const feed = new WatchFeedModule(mgr, { dataDir: join(DATA, "storm"), reportPath: join(DATA, "storm-report.md"), enabled: () => true, deliver: (sid, prompt) => { delivered.push({ sid, prompt, external: true }); return true; }, maxLines: 10 });
  feed.tick();
  const last = delivered[delivered.length - 1];
  assert(last.prompt.includes("折叠"), "⑨ 超预算折叠（保头尾+全量指引）");
  assert(!last.prompt.includes("storm-50") && last.prompt.includes("storm-99"), "⑨ 中段折叠、尾行保住（最新事实不丢）");
}

// ---------- ⑩ CLI 面 ----------
{
  const p = ensureOrgCli();
  assert(!!p && p === join(ORG, "bin", "org"), `⑩ org CLI 物化到沙盒面（${p ?? "null"}）`);
  if (p) {
    const txt = readFileSync(p, "utf-8");
    assert(txt.includes("patrol-suggest"), "⑩ org.sh 含 patrol-suggest 子命令");
    assert(txt.includes('d["role"]=sys.argv[6]'), "⑩ dispatch 第 6 位 role 透传在场");
    assert(txt.includes("watchdog=巡查员"), "⑩ usage 注明 watchdog 岗位用法");
    execSync(`bash -n ${JSON.stringify(p)}`, { stdio: "pipe" }); // bash 语法闸（模板字符串改动防笔误）
    assert(true, "⑩ org.sh bash 语法过");
    // R1：拆 || true——参数缺失必须真失败（用法退出非零+stderr 带词表），假绿绝迹
    const usageRun = (await import("node:child_process")).spawnSync(p, ["patrol-suggest"], { encoding: "utf-8", env: { ...process.env, CCR_DATA_DIR: DATA, CCR_TOKEN: "x", CCR_PORT: String(process.env.CCR_PORT ?? "18790"), no_proxy: "*" } as Record<string, string>, timeout: 10_000 });
    assert(usageRun.status !== 0 && usageRun.stderr.includes("用法: org patrol-suggest"), `⑩ patrol-suggest 参数缺失→用法非零退出（R1 拆 || true）［${usageRun.status} ${usageRun.stderr.slice(0, 80).trim()}］`);
  }
}

// ---------- ⑪ 上岗全链（fake factory 真走 dispatchWorker：入编+岗位注入+喂料定位） ----------
{
  // fake agent：捕获 spawn 现场 prompt（岗位注入断言载体）+自动完成回合（cmode 批惯例）
  let spawnedPrompt = "";
  const { randomUUID } = await import("node:crypto");
  mgr.setAgentFactory((_cwd: string, _model: string, cb: import("../src/agent-adapter.js").AgentCallbacks, initialPrompt: string | undefined) => {
    const a = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: (msg: unknown) => { const t = typeof msg === "string" ? msg : String((msg as { prompt?: string }).prompt ?? ""); if (t.includes("巡查")) spawnedPrompt = t; },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    } as unknown as import("../src/agent-adapter.js").AgentLike;
    setTimeout(() => {
      if (initialPrompt !== undefined) spawnedPrompt = initialPrompt;
      cb.onInit("sdk-" + a.id.slice(0, 8), "claude", "default");
    }, 5);
    return a;
  });
  // 立项组（正经立项出卡→✓ 激活）
  const anchor2 = mkdtempSync(join(tmpdir(), "watchagent-anchor-"));
  const cg = mgr.orgAction("project-create", { name: "巡查上岗组", anchor: anchor2, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
  const gid2 = cg.data?.group?.id ?? "";
  assert(!!gid2, "⑪ 立项组创建");
  if (cg.data?.needsConfirm) {
    const ok = mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "user-test" });
    assert(ok.ok, "⑪ 立项 ✓ 激活");
  }
  // dispatch role=watchdog（org CLI 第 6 位参数的 API 面）——上岗单走模板
  const onboarding = buildWatchdogOnboardingPrompt(REPORT, DATA);
  const d = mgr.orgAction("dispatch", { anchor: anchor2, prompt: onboarding, gid: gid2, title: "巡查员上岗", role: WATCHDOG_ROLE }) as { ok: boolean; error?: string; dispatch_id?: string; session_id?: string };
  assert(d.ok === true, `⑪ dispatch role=watchdog 派单受理${d.ok ? "" : `（${d.error}）`}`);
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && !spawnedPrompt; i++) await wait(50);
  assert(spawnedPrompt.includes("岗位纪律（巡查员）"), "⑪ 上岗 prompt 含巡查员岗位纪律块（dispatchWorker→buildRoleInjection 全链）");
  assert(spawnedPrompt.includes("证据锚"), "⑪ 岗位块证据锚纪律行在场");
  assert(spawnedPrompt.includes("健康吗") && spawnedPrompt.includes("哪些在打转"), "⑪ 上岗单三类问在场（同一 prompt）");
  // 入编证据（验收点 1：headcount role=watchdog）
  const g2 = (await import("../src/projects.js")).findGroup(gid2);
  assert(!!g2 && g2.headcount.some((m) => m.role === WATCHDOG_ROLE && m.session_id), "⑪ 巡查员会话在编（headcount role=watchdog 证据）");
  // 喂料链接到真在编巡查员（验收点 2 机器面：dispatch 产出的会话即喂料目标）
  writeFileSync(REPORT, "[2026/11/4 18:00:00] ALERT [receipt-stale] 新回执 3 份超 24h 未收口\n", "utf-8");
  const feed2 = mkFeed(REPORT);
  const hit2 = feed2.locateWatchdogs();
  assert(hit2.length >= 1 && hit2.some((h) => h.session_id === (d as { session_id?: string }).session_id), "⑪ 喂料定位命中在编巡查员会话（上岗→喂料链闭环）");
}

// ---------- 清场 ----------
rmSync(DATA, { recursive: true, force: true });
rmSync(ORG, { recursive: true, force: true });
console.log(failures === 0 ? "\nwatchagent: ALL PASS" : `\nwatchagent: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
