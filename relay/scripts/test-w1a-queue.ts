// #018-W1a：Web 第二列单流投影 fixture 直跑测试（worker H）。
// 被测对象 = web-console/index.html 的 W1A-PROJECTION 纯函数段（锚点正则提取，
// new Function 构造直跑——段自包含零 DOM，构造+运行不需浏览器）。
// fixture 语义与 E2a 同套（018 :130：queuePartition 非共享层，Web/Expo 各自实现
// 但使用相同 fixture——互斥/组头计数/needs_action 边界/旧 relay 降级/源归并）
// + 结构自查闸（018 §5.5 硬条款：`</html>` 后零内容、全文重复 id）。
// 断言时间无 Date.now 比对（fixture 全定值 updated_at）。
// 直跑入口（relay 目录）：
//   env -u CCR_ORG_DIR node --import tsx/esm scripts/test-w1a-queue.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB_HTML = fileURLToPath(new URL("../../web-console/index.html", import.meta.url));

let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`w1a queue projection: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

// ---------- 被测段提取 + 结构闸前置 ----------
const html = readFileSync(WEB_HTML, "utf8");
const seg = /\/\* W1A-PROJECTION-START \*\/([\s\S]*?)\/\* W1A-PROJECTION-END \*\//.exec(html);
check(!!seg, "锚点① W1A-PROJECTION 段存在且可提取");
check(html.split("W1A-PROJECTION-START").length === 2 && html.split("W1A-PROJECTION-END").length === 2,
  "锚点② START/END 标记全文各只出现一次（提取无歧义）");
const segCode = seg ? seg[1] : "";

type QueueFlags = { needs_action: boolean; is_working: boolean; needs_acceptance: boolean; is_other: boolean; reason: string };
type QueueSession = {
  session_id: string;
  status?: string;
  waiting_request?: unknown;
  last_task_done?: unknown;
  activity?: { activity?: { text?: string; tool?: string } };
  updated_at?: number;
  started_at?: number;
};
type SourceGroup = { key: string; name: string; online: boolean; exceptions: string[]; srcIds: string[] };
type QueueApi = {
  normalizeEndpoint(u: unknown): string;
  sourceIdentityOf(e: unknown): { key: string; tier: string };
  projectSources(list: unknown): SourceGroup[];
  queueFlagsOf(s: unknown, notifActionable?: boolean): QueueFlags;
  queuePartition(sessions: unknown, opts?: unknown): { pending: QueueSession[]; others: QueueSession[]; flags: Map<string, QueueFlags> };
};
// 段是普通函数声明脚本——new Function 包装后取回五个纯函数（构造成功即语法自包含）
const api = new Function(
  segCode + "\nreturn { normalizeEndpoint: normalizeEndpoint, sourceIdentityOf: sourceIdentityOf, projectSources: projectSources, queueFlagsOf: queueFlagsOf, queuePartition: queuePartition };",
)() as QueueApi;

const sess = (id: string, status: string, over: Partial<QueueSession> = {}): QueueSession =>
  ({ session_id: id, status, updated_at: 100, ...over });

// ---------- ① 单流互斥：待处理置顶 + 同 id 只出现一次（E2a 同语义） ----------
{
  const mixed: QueueSession[] = [
    sess("w2", "WAITING", { waiting_request: { tool_name: "Bash" }, updated_at: 300 }),
    sess("dup", "WAITING", { waiting_request: { tool_name: "Edit" }, updated_at: 200 }),
    sess("dup", "DONE", { updated_at: 900 }), // 同 id 二次出现必须被滤（首见优先）
    sess("d1", "DONE", { updated_at: 100 }),
  ];
  const q = api.queuePartition(mixed);
  check(q.pending.length === 2 && q.others.length === 1, "① 分区计数：待处理2+其他1（重复 id 先滤再计）");
  check(q.pending.every((s) => s.status === "WAITING"), "① 待处理组全为可决策 WAITING");
  const ids = [...q.pending, ...q.others].map((s) => s.session_id);
  check(new Set(ids).size === ids.length, "① 同一 session_id 全局只出现一次（两组互斥）");
  check(ids.filter((id) => id === "dup").length === 1, "① 重复 id 收敛为一张卡（首见 WAITING 优先）");
  check(q.pending[0]?.session_id === "w2", "① 待处理组内按 updated_at 倒序（w2 新于 dup）");
  // 多源复合键（Web 集成面）：跨源同 id 各自成卡，注入 keyOf 后不误滤
  const twoSrc: QueueSession[] = [
    sess("s9", "DONE", { updated_at: 100 }),
    sess("s9", "DONE", { updated_at: 200 }),
  ];
  const qm = api.queuePartition(twoSrc, { keyOf: (s: object) => "src" + (s as QueueSession).updated_at + "/" + (s as QueueSession).session_id });
  check(qm.pending.length === 0 && qm.others.length === 2, "① 注入 keyOf：跨源同 id 各自成卡（Web 多源语义）");
  const qd = api.queuePartition(twoSrc);
  check(qd.others.length === 1, "① 默认键 session_id：同 id 仍互斥（单源/fixture 语义同 E2a）");
  const qj = api.queuePartition([null, { status: "WAITING" }, sess("ok1", "DONE")] as unknown as QueueSession[]);
  check(qj.pending.length === 0 && qj.others.length === 1, "① 畸形条目（null/无 id）跳过不入流，正常卡不受牵连");
  const qe = api.queuePartition("junk" as unknown as QueueSession[]);
  check(qe.pending.length === 0 && qe.others.length === 0 && qe.flags.size === 0, "① 非数组入参 → 空两组空 flags（降级不崩）");
}

// ---------- ② 组头计数 = 过滤后实际渲染卡数（018 §2.1.1 硬条款） ----------
{
  // 模拟调用方时序：先筛选（源/搜索/折叠工具行），后进分区——计数来自过滤后集合
  const full: QueueSession[] = [
    sess("w1", "WAITING", { waiting_request: {}, updated_at: 400 }),
    sess("w2", "WAITING", { waiting_request: {}, updated_at: 300 }),
    sess("k1", "DONE", { updated_at: 200 }),
    sess("k2", "DONE", { updated_at: 100 }),
  ];
  const qAll = api.queuePartition(full);
  check(qAll.pending.length + qAll.others.length === full.length, "② 未过滤：两组合计=去重后卡数");
  const filtered = full.filter((s) => s.session_id !== "k2"); // 调用方先把筛选做完
  const qF = api.queuePartition(filtered);
  check(qF.pending.length + qF.others.length === filtered.length && qF.others.length === 1,
    "② 过滤后：组头计数随筛选收缩（绝不用源总数）");
  // decidable:false 的 WAITING 是脱钩帧——不占待处理（真实可决策才计数）
  const mixedW: QueueSession[] = [
    sess("w1", "WAITING", { waiting_request: {} }),
    sess("w2", "WAITING", { waiting_request: { decidable: false } }),
    sess("d1", "DONE"),
    sess("d2", "ERROR"),
  ];
  const qW = api.queuePartition(mixedW);
  check(qW.pending.length === 1 && qW.pending[0]?.session_id === "w1",
    "② 组头计数=真实待处理卡数（decidable:false 不计入待处理）");
  check(qW.flags.size === 4 && [...qW.flags.values()].every((f) => typeof f.reason === "string"),
    "② flags 逐会话在账（每组会话各有五标志判定）");
  const qEmpty = api.queuePartition([]);
  check(qEmpty.pending.length === 0 && qEmpty.others.length === 0,
    "② 空流：两组零卡（调用方不出段头，走空态提示）");
}

// ---------- ③ needs_action 五型边界（018 §2.1.1 推荐分组规则） ----------
{
  const q1 = api.queueFlagsOf(sess("a", "WAITING", { waiting_request: { tool_name: "Bash" } }));
  check(q1.needs_action && !q1.is_other && q1.reason === "waiting",
    "③ 真实 WAITING 可决策 → 待处理 reason=waiting");
  const q2 = api.queueFlagsOf(sess("b", "WAITING"));
  check(!q2.needs_action && q2.is_other && q2.reason === "other",
    "③ WAITING 但无 waiting_request（脱钩帧）→ 不占待处理");
  const q3 = api.queueFlagsOf(sess("c", "WAITING", { waiting_request: { decidable: false } }));
  check(!q3.needs_action && q3.is_other, "③ WAITING + decidable:false → 不可决策不占位（web 处理按钮同口径）");
  const q4 = api.queueFlagsOf(sess("d", "DONE", { last_task_done: { done: ["x"], remaining_count: 0, ts: 1 } }));
  check(q4.needs_action && q4.needs_acceptance && q4.reason === "acceptance",
    "③ 待验收类持久行动（last_task_done）→ 待处理 reason=acceptance");
  const notif = [{ actionable: true, sourceContext: { sessionId: "n1" } }];
  const q5 = api.queueFlagsOf(sess("n1", "DONE"), true);
  check(q5.needs_action && q5.reason === "notification" && !q5.needs_acceptance,
    "③ 会话级通知要求动作 → 待处理 reason=notification");
  const q5p = api.queuePartition([sess("n1", "DONE")], { notifications: notif });
  check(q5p.pending.length === 1, "③ 分区侧：actionable 未决通知把会话提入待处理");
  const q6 = api.queuePartition([sess("n1", "DONE")], { notifications: [{ actionable: true, resolved_at: 5, sourceContext: { sessionId: "n1" } }] });
  check(q6.pending.length === 0, "③ 已 resolved 通知不再要求动作（不占待处理）");
  const q7 = api.queuePartition([sess("n2", "DONE")], { notifications: notif });
  check(q7.pending.length === 0, "③ 通知绑定他人 session → 本会话不占位");
  const q8 = api.queueFlagsOf(sess("g", "WORKING", { activity: { activity: { text: "npm test", tool: "Bash" } } }));
  check(!q8.needs_action && !q8.is_other && q8.is_working && q8.reason === "working",
    "③ WORKING 确有可观察工作状态 → 待处理 reason=working（needs_action 仍 false：信息位非行动位）");
  const q8t = api.queueFlagsOf(sess("h", "WORKING", { activity: { activity: { tool: "Read" } } }));
  check(!q8t.is_other, "③ WORKING 仅工具名在（无正文）→ 仍算可观察工作状态");
  const q9 = api.queueFlagsOf(sess("i", "WORKING"));
  check(q9.is_working && q9.is_other && q9.reason === "other",
    "③ 在线空转 WORKING（无活动证据）→ 其他会话（在线不占行动位）");
  const shape = api.queueFlagsOf(sess("j", "DONE"));
  check(shape.needs_action === false && shape.is_working === false && shape.needs_acceptance === false
    && shape.is_other === true && shape.reason === "other",
    "③ queue_flags 五标志齐（needs_action/is_working/needs_acceptance/is_other/reason）");
}

// ---------- ④ 旧 relay 缺字段降级四型（不崩、不伪造） ----------
{
  const q1 = api.queueFlagsOf({ session_id: "x", updated_at: 1 }); // 无 status
  check(q1.is_other && q1.reason === "other" && !q1.needs_action, "④ 降级① 无 status 字段 → 安全落其他会话");
  const q2 = api.queueFlagsOf(sess("y", "WORKING", { activity: "junk-string" as unknown as QueueSession["activity"] }));
  check(q2.is_other && !q2.needs_action, "④ 降级② activity 畸形（非对象）→ 不伪造工作状态，落其他");
  const q3 = api.queuePartition([sess("z", "DONE", { last_task_done: { ts: 9 } })], { notifications: "junk" });
  check(q3.pending.length === 1, "④ 降级③ 通知池非数组 → 按空池处理，其余判定不受牵连");
  const q4 = api.queueFlagsOf(sess("w", "DONE", { last_task_done: "junk" as unknown as QueueSession["last_task_done"] }));
  check(!q4.needs_acceptance && q4.is_other, "④ 降级④ last_task_done 畸形（非对象）→ 不判待验收");
  const q5 = api.queueFlagsOf(sess("v", "WAITING", { waiting_request: "junk" as unknown as QueueSession["waiting_request"] }));
  check(!q5.needs_action && q5.is_other, "④ 降级⑤ waiting_request 畸形（非对象）→ 不判可决策");
  const q6 = api.queuePartition([sess("m", "WAITING", { waiting_request: {} }), null, undefined] as unknown as QueueSession[]);
  check(q6.pending.length === 1 && q6.others.length === 0, "④ null/undefined 条目混入 → 跳过不崩，正常会话照常分区");
}

// ---------- ⑤ 源归并三型（relay_id 一致 / legacy 回落 / endpoint 归一） ----------
{
  const g1 = api.projectSources([
    { id: "a", name: "公司 iMac", relayId: "r-1", wsUrl: "ws://192.168.1.2:8787", online: true },
    { id: "b", name: "公司 iMac 云桥", relayId: "r-1", cloudUrl: "wss://cc.example.com", online: false },
  ]);
  check(g1.length === 1 && g1[0].srcIds.length === 2 && g1[0].key === "rid:r-1",
    "⑤ relay_id 一致 → LAN+云桥归并一组（v1 主键优先）");
  check(g1[0].online === true && g1[0].exceptions.length === 0,
    "⑤ 归并组 online=任一在线；v1 身份无 legacy 异常标");
  const g2 = api.projectSources([
    { id: "a", name: "", relayDev: "rl-x", wsUrl: "ws://10.0.0.1:8787" },
    { id: "b", name: "家relay", relayDev: "rl-x", online: true },
  ]);
  check(g2.length === 1 && g2[0].key === "legacy:rl-x" && g2[0].exceptions.indexOf("legacy") >= 0,
    "⑤ 旧 relay relay_dev 回落 → legacy:<rd> 键归并 + legacy 异常标");
  check(g2[0].name === "家relay", "⑤ 组名取首个非空（空名条目不顶掉实名）");
  const epSame = api.projectSources([
    { id: "a", wsUrl: "ws://127.0.0.1:8787" },
    { id: "b", wsUrl: "WS://127.0.0.1:8787/" },
    { id: "c", wsUrl: "ws://127.0.0.1:8787?token=x" },
  ]);
  check(epSame.length === 1 && epSame[0].key.startsWith("legacy-endpoint:") && epSame[0].srcIds.length === 3,
    "⑤ endpoint 归一：协议大小写/尾斜杠/查询串抹平后同源归并");
  check(api.normalizeEndpoint("wss://a.example.com") === "a.example.com:443"
    && api.normalizeEndpoint("wss://a.example.com:443/snap") === "a.example.com:443",
    "⑤ endpoint 归一：默认端口补全 + 路径剥离");
  check(api.normalizeEndpoint("ws://a.example.com") !== api.normalizeEndpoint("wss://a.example.com"),
    "⑤ endpoint 归一：ws/wss 默认端口不同 → 不同源（不误归并）");
  const g3 = api.projectSources([{ id: "a", wsUrl: "ws://10.0.0.1:1" }, { id: "b", wsUrl: "ws://10.0.0.2:1" }]);
  check(g3.length === 2, "⑤ 不同 endpoint 各自成组（不跨源误并）");
  const gBoth = api.sourceIdentityOf({ relayId: "r-9", relayDev: "rl-9" });
  check(gBoth.key === "rid:r-9" && gBoth.tier === "v1", "⑤ 身份三级回落：relay_id 在场时压过 legacy rd");
  check(api.projectSources("junk" as unknown as unknown[]).length === 0
    && api.projectSources([null, 42, { id: "solo" }]).length === 1,
    "⑤ 非数组/畸形条目降级：空投影或孤立组（solo 键，不崩）");
}

// ---------- ⑥ 结构自查闸（018 §5.5 硬条款） ----------
{
  const closeIdx = html.lastIndexOf("</html>");
  check(closeIdx > 0 && html.slice(closeIdx + "</html>".length).trim() === "",
    "⑥ `</html>` 后零内容（防 markup 被追加到文件尾）");
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, ""); // 静态 markup 面（脚本内模板字符串另查）
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(ids).size === ids.length, `⑥ 静态 markup 无重复 id（共 ${ids.length} 个）`);
  const jsIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(jsIds).size === jsIds.length, `⑥ 全文（含脚本内模板）无重复 id（共 ${jsIds.length} 个）`);
  check(!/document\.|window\.|querySelector/i.test(segCode),
    "⑥ 投影段零 DOM 依赖（无 document/window/querySelector 引用）");
}

finish();
