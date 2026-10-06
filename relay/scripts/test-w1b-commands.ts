// #018-W1b：Web 命令/通知/组织写链路 fixture 直跑测试（worker H）。
// 被测对象 = web-console/index.html 的 W1B-COMMANDS 纯函数段（锚点正则提取，
// new Function 构造直跑——段自包含零 DOM，构造+运行不需浏览器）。
// 覆盖（018 :413 验收面）：①ACK ok:true 严格判定三态（§5.4：HTTP 200/已发送/退出 0
// 都不算成功）②通知 reducer（乐观消失/失败回滚/§3.3 打开不清零/组计数随可行动项）
// ③旧 relay 降级决策（能力位记忆/静默/恢复条件）④双击闸（E4b ackTapGuard 同语义）
// ⑤确认卡决议 + 远程立项 payload 组装（relay 咽喉实况口径）
// + 结构自查闸（018 §5.5：`</html>` 后零内容、全文重复 id、锚点段零 DOM）。
// 断言时间全定值（at=1000 等），无两个取时点 Date.now 比对。
// 直跑入口（relay 目录）：
//   env -u CCR_ORG_DIR node --import tsx/esm scripts/test-w1b-commands.ts
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
  console.log(`w1b commands projection: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

// ---------- 被测段提取 + 锚点唯一性 ----------
const html = readFileSync(WEB_HTML, "utf8");
const seg = /\/\* W1B-COMMANDS-START \*\/([\s\S]*?)\/\* W1B-COMMANDS-END \*\//.exec(html);
check(!!seg, "锚点① W1B-COMMANDS 段存在且可提取");
check(html.split("W1B-COMMANDS-START").length === 2 && html.split("W1B-COMMANDS-END").length === 2,
  "锚点② START/END 标记全文各只出现一次（提取无歧义）");
const segCode = seg ? seg[1] : "";

type Verdict = { ok: boolean; error: string | null; kind: string };
type NotifItem = {
  key: string; group?: string; title?: string; body?: string; actionable?: boolean;
  resolved_at?: number | null; handled_at?: number | null; dismissed_at?: number | null;
  __w1b_pend?: { action: string; at: number };
};
type W1BApi = {
  ackVerdict(ack: unknown): Verdict;
  unknownCommandError(err: unknown): boolean;
  cmdCapRemember(caps: unknown, cmd: string): Record<string, boolean>;
  cmdCapBlocked(caps: unknown, cmd: string): boolean;
  cmdCapRecoverOnSnapshot(caps: unknown, snap: unknown, identityChanged?: boolean): Record<string, boolean>;
  ackTapGuard(inFlight: Set<string>, k: string): "skip" | "go";
  notifFlightKey(srcId: unknown, key: unknown): string;
  notifOptimistic(items: unknown, key: string, action: string, at: number): { items: NotifItem[]; prev: NotifItem; index: number } | null;
  notifRollback(items: unknown, key: string, prev: NotifItem): { items: NotifItem[]; rolled: boolean };
  notifActionableOf(items: unknown): NotifItem[];
  notifGroupCounts(items: unknown): { group: string; total: number; actionable: number }[];
  orgConfirmPayload(confirmId: unknown, approve: unknown): { confirm_id: string; approve: boolean } | null;
  orgCreatePayload(input: unknown): { ok: boolean; payload?: Record<string, unknown>; error?: string };
};
const api = new Function(
  segCode + "\nreturn { ackVerdict: ackVerdict, unknownCommandError: unknownCommandError, cmdCapRemember: cmdCapRemember, cmdCapBlocked: cmdCapBlocked, cmdCapRecoverOnSnapshot: cmdCapRecoverOnSnapshot, ackTapGuard: ackTapGuard, notifFlightKey: notifFlightKey, notifOptimistic: notifOptimistic, notifRollback: notifRollback, notifActionableOf: notifActionableOf, notifGroupCounts: notifGroupCounts, orgConfirmPayload: orgConfirmPayload, orgCreatePayload: orgCreatePayload };",
)() as W1BApi;

const notif = (key: string, over: Partial<NotifItem> = {}): NotifItem =>
  ({ key, group: "action", title: "t:" + key, body: "", actionable: true, ...over });

// ---------- ① ACK 判定三态（§5.4 严格口径：ok===true 才算成功） ----------
{
  const v1 = api.ackVerdict({ ok: true, data: { group: { id: "g1" }, needsConfirm: true } });
  check(v1.ok === true && v1.kind === "ok" && v1.error === null, "① ok:true → 成功收口（kind=ok，error 空）");
  const v2 = api.ackVerdict({ ok: false, error: "confirm_id 必填" });
  check(v2.ok === false && v2.kind === "rejected" && v2.error === "confirm_id 必填",
    "① ok:false → 错误呈现（rejected，原文透传不吞）");
  const v3 = api.ackVerdict(null);
  check(v3.ok === false && v3.kind === "unconfirmed" && typeof v3.error === "string" && v3.error.length > 0,
    "① null（发送失败/超时）→ unconfirmed，可读错误非空");
  const v4 = api.ackVerdict(undefined);
  check(v4.ok === false && v4.kind === "unconfirmed", "① undefined（等待器缺失）同归 unconfirmed");
  const v5 = api.ackVerdict({ ok: "yes" });
  check(v5.ok === false && v5.kind === "rejected", "① ok:\"yes\"（truthy 非布尔）不算成功——严格 ===true");
  const v6 = api.ackVerdict({ ok: false });
  check(v6.ok === false && v6.kind === "rejected" && typeof v6.error === "string" && v6.error.length > 0,
    "① ok:false 无 error 字段 → 兜底可读错误（不裸奔 undefined）");
  const v7 = api.ackVerdict({ ok: true });
  check(v7.error === null && v7.kind === "ok", "① 裸 ok:true（无 data）同样收口——通知 ACK 不带 data 的真实形状");
}

// ---------- ② 通知 reducer：乐观消失/失败回滚/打开不清零/组计数随可行动项 ----------
{
  const fresh = [notif("n1"), notif("n2", { actionable: false }), notif("n3", { resolved_at: 5 })];
  const opt = api.notifOptimistic(fresh, "n1", "handled", 1000);
  check(!!opt && opt.items[0].handled_at === 1000 && !!opt.items[0].__w1b_pend,
    "② 乐观标记：handled_at 填空位 + __w1b_pend 在身（渲染层据此行即刻消失）");
  check(!!opt && opt.prev.key === "n1" && opt.prev.handled_at == null,
    "② prev 快照原样保留（回滚原料，未被突变）");
  check(fresh[0].handled_at == null && fresh.length === 3,
    "② 输入数组不可变（乐观副本替换，不改原账——§3.3 账面不动）");
  check(api.notifOptimistic(fresh, "n3", "handled", 1000) === null,
    "② 已 resolved（来源动作成功收口）→ 无从乐观（null，ACK 照发 relay 幂等）");
  check(api.notifOptimistic([notif("n1", { handled_at: 9 })], "n1", "handled", 1000) === null,
    "② 已 handled → 不叠突变（幂等空位判据）");
  const handledRow = notif("n4", { handled_at: 9 });
  const dOpt = api.notifOptimistic([handledRow], "n4", "dismissed", 1000);
  check(!!dOpt && dOpt.items[0].dismissed_at === 1000 && dOpt.items[0].handled_at === 9,
    "② dismissed 补已 handled 行的 dismissed_at 空位（expo 镜像判据）");
  check(api.notifOptimistic(fresh, "missing", "handled", 1000) === null, "② key 不在账 → null");
  check(api.notifOptimistic(fresh, "n1", "renew", 1000) === null, "② action 越词表（B0 冻结 handled|dismissed）→ null");
  check(api.notifOptimistic("junk", "n1", "handled", 1000) === null, "② 非数组 → null（降级不崩）");
  // 失败回滚：行回来
  const rb = api.notifRollback(opt ? opt.items : [], "n1", opt ? opt.prev : notif("n1"));
  check(rb.rolled === true && rb.items[0].key === "n1" && rb.items[0].__w1b_pend === undefined && rb.items[0].handled_at == null,
    "② 回滚：乐观副本还原为 prev（行回来，标记与 handled_at 同撤）");
  const authFrame = [notif("n1", { handled_at: 777 })]; // 期间权威帧已覆盖（值被替换）
  const rb2 = api.notifRollback(authFrame, "n1", notif("n1"));
  check(rb2.rolled === false && rb2.items[0].handled_at === 777,
    "② 权威帧已到（无我方标记）不回滚——以权威为准（expo 同判据）");
  const rb3 = api.notifRollback([notif("n2")], "n1", notif("n1"));
  check(rb3.rolled === false && rb3.items.length === 1, "② 行已消失（帧删了它）→ 不复活不崩");
  // 打开/浏览/重连不清零（§3.3）：handled 行留在账面，只是不再可行动
  const ledger = [notif("n1", { handled_at: 9 }), notif("n2")];
  check(api.notifActionableOf(ledger).length === 1 && ledger.length === 2,
    "② 打开不清零：handled 行留账面（仅出可行动集），reducer 无任何清零操作");
  // 组头计数随可行动项（绝不用源总数）
  const g1 = api.notifGroupCounts([notif("a"), notif("b", { handled_at: 1 }), notif("c", { group: "activity" })]);
  check(g1.length === 2 && g1[0].actionable === 1 && g1[0].total === 2 && g1[1].group === "activity",
    "② 组计数：actionable 只数未收口可行动项（handled 不占计数）");
  const opt1 = api.notifOptimistic([notif("a"), notif("b")], "a", "handled", 1000);
  const g2 = api.notifGroupCounts(opt1 ? opt1.items : []);
  check(g2[0].actionable === 1, "② 组计数随乐观即时收缩（点了知道了计数立刻 -1）");
  check(api.notifGroupCounts("junk").length === 0 && api.notifActionableOf(null).length === 0,
    "② 计数/可行动集非数组降级 → 空（不崩）");
}

// ---------- ③ 降级决策：未知命令签名/能力位记忆/恢复条件 ----------
{
  check(api.unknownCommandError("invalid command shape") === true, "③ 签名① ws 白名单拒发 invalid command shape");
  check(api.unknownCommandError("unsupported command") === true, "③ 签名② 旧 handleCommand default unsupported command");
  check(api.unknownCommandError("unsupported org action: create") === true, "③ 签名③ orgCommand 咽喉不认识的 action");
  check(api.unknownCommandError("notification_key 必填") === false && api.unknownCommandError("并行项目组已达上限") === false,
    "③ 业务性拒绝（校验/护栏）≠ 未知命令——照常错误呈现不降级");
  check(api.unknownCommandError(undefined) === false && api.unknownCommandError(42) === false, "③ 非字符串 error → false（降级不崩）");
  const caps0: Record<string, boolean> = { COMMAND_ORG_CONFIRM: false };
  const caps1 = api.cmdCapRemember(caps0, "COMMAND_NOTIFICATION_ACK");
  check(caps1.COMMAND_NOTIFICATION_ACK === false && caps1.COMMAND_ORG_CONFIRM === false && caps0.COMMAND_NOTIFICATION_ACK === undefined,
    "③ 能力位记忆：新增位不动旧位，原对象不可变");
  check(api.cmdCapBlocked(caps1, "COMMAND_NOTIFICATION_ACK") === true && api.cmdCapBlocked({}, "COMMAND_NOTIFICATION_ACK") === false
    && api.cmdCapBlocked(null, "x") === false, "③ 静默不发判据：记忆位 true 封锁；空/null caps 放行");
  const legacyCaps = api.cmdCapRemember({}, "COMMAND_NOTIFICATION_ACK");
  check(api.cmdCapRecoverOnSnapshot(legacyCaps, {}) === legacyCaps,
    "③ 恢复条件①不满足：旧 relay 快照（无 schema_version）→ 记忆原样保留（不被快照冲掉）");
  check(api.cmdCapRecoverOnSnapshot(legacyCaps, { schema_version: 0 }) === legacyCaps,
    "③ schema_version 0 同属 legacy → 记忆保留");
  check(Object.keys(api.cmdCapRecoverOnSnapshot(legacyCaps, { schema_version: 1 })).length === 0,
    "③ 恢复条件②：schema_version>=1（relay 升级新命令面）→ 记忆清零重放行");
  check(Object.keys(api.cmdCapRecoverOnSnapshot(legacyCaps, {}, true)).length === 0,
    "③ 恢复条件③：relay 身份变更（连接换指另一实例）→ 记忆清零");
}

// ---------- ④ 双击闸（E4b ackTapGuard 同语义） ----------
{
  const flight = new Set<string>();
  check(api.ackTapGuard(flight, "n1") === "go", "④ 空飞行集 → go（首击放行）");
  flight.add("n1");
  check(api.ackTapGuard(flight, "n1") === "skip", "④ 飞行中同键再点 → skip（防双发）");
  check(api.ackTapGuard(flight, "n2") === "go", "④ 不同键不连坐（逐行闸）");
  check(api.notifFlightKey("srcA", "k1") === api.notifFlightKey("srcA", "k1")
    && api.notifFlightKey("srcA", "k1") !== api.notifFlightKey("srcB", "k1"),
    "④ 飞行键=源+通知复合（跨源同 key 不互误；单源同键仍同闸）");
}

// ---------- ⑤ payload 组装：确认卡决议 + 远程立项（relay 咽喉实况口径） ----------
{
  const c1 = api.orgConfirmPayload("cf-abc123", true);
  check(!!c1 && c1.confirm_id === "cf-abc123" && c1.approve === true, "⑤ 决议 payload：confirm_id + approve 真布尔");
  const c2 = api.orgConfirmPayload("cf-abc123", "1");
  check(!!c2 && c2.approve === false, "⑤ approve 字符串 \"1\" → 强转 false（relay 严判 ===true，字符串会误判否决）");
  check(api.orgConfirmPayload("", true) === null && api.orgConfirmPayload(null, true) === null
    && api.orgConfirmPayload(42, true) === null, "⑤ confirm_id 非法（空/null/非串）→ null（不发）");
  const m1r = api.orgCreatePayload({ name: " 收银台改造 ", anchor_dir: " /Users/x/dev/pos ", tier: "轻立项" });
  const m1 = m1r.ok && m1r.payload ? m1r.payload : null;
  check(!!m1 && m1.action === "create" && m1.name === "收银台改造"
    && m1.anchor_dir === "/Users/x/dev/pos" && m1.tier === "轻立项",
    "⑤ 立项 payload：action=create 注入 + name/anchor trim（ws create 路径 adaptOrgAction 口径）");
  check(api.orgCreatePayload({ name: "x", anchor_dir: "/a", tier: "随手办" }).ok === false,
    "⑤ tier 随手办拒收（ws create 只收 轻立项|正经立项——随手办组由会话派单产生）");
  check(api.orgCreatePayload({ name: "x", anchor_dir: "/a" }).ok === false,
    "⑤ tier 缺省拒收（不放行服务端必拒的请求）");
  check(api.orgCreatePayload({ name: "x", anchor_dir: "dev/pos", tier: "轻立项" }).ok === false,
    "⑤ anchor 相对路径拒收（relay 侧文件系统绝对路径）");
  check(api.orgCreatePayload({ name: "  ", anchor_dir: "/a", tier: "轻立项" }).ok === false
    && typeof api.orgCreatePayload({ name: "", anchor_dir: "/a", tier: "轻立项" }).error === "string",
    "⑤ name 空白拒收 + 错误可读（行内直显不裸奔）");
}

// ---------- ⑥ 结构自查闸（018 §5.5，W1a 基线保持 + W1B 段零 DOM） ----------
{
  const closeIdx = html.lastIndexOf("</html>");
  check(closeIdx > 0 && html.slice(closeIdx + "</html>".length).trim() === "",
    "⑥ `</html>` 后零内容（防 markup 被追加到文件尾）");
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(ids).size === ids.length, `⑥ 静态 markup 无重复 id（共 ${ids.length} 个）`);
  const jsIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(jsIds).size === jsIds.length, `⑥ 全文（含脚本内模板）无重复 id（共 ${jsIds.length} 个）`);
  check(!/document\.|window\.|querySelector/i.test(segCode),
    "⑥ W1B 段零 DOM 依赖（无 document/window/querySelector 引用）");
  check(!segCode.includes("Date.now"), "⑥ W1B 段不取时（时间由调用方注入 at——断言无两个取时点问题）");
}

finish();
