// E4a Setup/App/notify 只读投影直跑测试（worker H / #018-E4a）。
//
// 直跑入口（tsx 装在 relay/node_modules，--import 解析以 cwd 为基准）：
//   relay 目录：node --import tsx ../expo-app/scripts/test-e4a-setup.ts
//
// 被测面 = protocol.ts E4a 只读投影纯函数段（capsuleSubline / projectNotifications /
// capabilityCardModel）。该文件零外部依赖（纯 TS 类型+函数），沿 test-e1-reducer.ts
// 先例**直接 import、无需 registerHooks 模块桩**——桩层是为 RN 原生依赖（Flow 语法/
// expo 原生包/.png）而设，本批纯函数触不到那些模块。SetupScreen/App 侧只做 memo 消费
// 与 JSX 渲染（无法 node 直测），留装机补验（见回单）。
//
// 纪律：断言不比对两个独立取时点的 Date.now()（N1② 教训）——被测函数均无时间入参，
// 全部断言为确定性值。

// @ts-expect-error The direct test runner loads TypeScript through tsx.
import { capsuleSubline, projectNotifications, capabilityCardModel, type NotificationItem, type SourceCapabilities } from "../src/protocol.ts";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

// 通知 fixture（B0 冻结面 NotificationItem；dismissed_at 为 relay lifecycle 扩展，
// 冻结面暂无——投影按运行时形状防御读取，fixture 以 cast 携带）
const note = (key: string, group: string, over: Partial<NotificationItem> = {}): NotificationItem => ({
  key,
  kind: "approval",
  group,
  severity: "warn",
  title: "通知 " + key,
  body: "正文",
  sourceContext: { domain: "session", entityId: "e1", alertId: "a1", returnPath: "detail" },
  actionable: true,
  created_at: 1000,
  ...over,
});

// ---------- ① 源胶囊副行：健康/异常/缺字段降级三态 ----------
{
  check(capsuleSubline(undefined) === null, "① 源不在快照（undefined）→ null 副行不渲染");
  check(capsuleSubline(null) === null, "① null → null");
  check(capsuleSubline({ channel: "lan" }) === null, "① 旧 relay 无 schema_version → null（轻量行仍渲染，仅无副行）");
  check(capsuleSubline({ channel: null, schemaVersion: 1 }) === "v1 · 直连", "① v+channel(null=直连)");
  check(capsuleSubline({ channel: "cloud", schemaVersion: 2 }) === "v2 · 云桥", "① v+云桥");
  check(capsuleSubline({ channel: "lan", schemaVersion: 2, notificationsLegacy: true }) === "v2 · 直连 · 通知不可用", "① 通知能力缺失 → 必要异常入副行");
  check(capsuleSubline({ channel: "cloud", schemaVersion: 3, notificationsLegacy: false }) === "v3 · 云桥", "① 通知能力正常 → 不出提示");
  // 结构化最小面：store SourceStatus 全字段对象天然可传（多余键无害）
  check(capsuleSubline({ channel: "cloud", schemaVersion: 3, notificationsLegacy: false, relayName: "工作站", state: "online" } as never) === "v3 · 云桥", "① SourceStatus 全形状兼容");
  // 390 宽：副行段数有界（恒 ≤3 段，单行截断前内容就不失控）
  const sub = capsuleSubline({ channel: "cloud", schemaVersion: 99, notificationsLegacy: true })!;
  check(sub.split(" · ").length <= 3, "① 副行段数有界 ≤3");
}

// ---------- ② 通知 projection：装载/分组计数/角标/畸形/不清零 ----------
{
  // 旧 relay：无通知账 → legacy 口径（横幅计数整块不渲染）
  for (const empty of [null, undefined]) {
    const p = projectNotifications(empty);
    check(p.legacy === true && p.total === 0 && p.badgeCount === 0, "② 旧 relay（null/undefined）→ legacy 零计数");
    check(p.buckets.action.count === 0 && p.buckets.attention.count === 0 && p.buckets.activity.count === 0, "② legacy 三组全零");
  }
  // 新 relay 零通知：空数组 ≠ legacy
  check(projectNotifications([]).legacy === false && projectNotifications([]).badgeCount === 0, "② 空数组=新 relay 零通知（非 legacy）");

  const items: NotificationItem[] = [
    note("a1", "action"), // 未决 actionable → 角标
    note("a2", "action", { handled_at: 500 }), // 已处理 → 不入角标
    note("a3", "action", { resolved_at: 600 }), // 已收敛 → 不入角标
    note("a4", "action", { actionable: false }), // 非 actionable → 只计数
    note("a5", "action", { dismissed_at: 700 } as Partial<NotificationItem>), // dismissed（扩展字段）→ 已处理
    note("a6", "action"), // 未决 actionable → 角标
    note("t1", "attention"),
    note("t2", "attention"), // attention 即使 actionable 也不进角标（角标只认 action 组）
    note("y1", "activity"),
    note("z9", "weird"), // 未知分组 → 跳过（畸形防御，同 relay 口径）
  ];
  const p = projectNotifications(items);
  check(p.legacy === false && p.total === 9, "② 总数 9（未知分组不计）");
  check(p.buckets.action.count === 6, "② action 组计数 6");
  check(p.buckets.attention.count === 2 && p.buckets.activity.count === 1, "② attention 2 / activity 1");
  check(p.badgeCount === 2 && p.buckets.action.badgeCount === 2, "② 角标=未决 actionable 2（handled/resolved/dismissed/非 actionable 均剔除）");
  check(p.buckets.attention.badgeCount === 0 && p.buckets.activity.badgeCount === 0, "② 角标只认 action 组");

  // 未决不清零（只读投影天然满足）：重复投影不突变入参、不丢条目
  const before = JSON.stringify(items);
  const p2 = projectNotifications(items);
  check(JSON.stringify(items) === before, "② 入参数组零突变（a2/a3/a5 时间戳原样）");
  check(p2.badgeCount === 2 && p2.total === 9, "② 重复投影计数稳定（不清零不重复）");
  // 值替换帧语义：新数组整体替换 → 投影随之收敛（快照/帧两路同函数）
  const replaced = projectNotifications([note("a1", "action", { handled_at: 999 })]);
  check(replaced.total === 1 && replaced.badgeCount === 0, "② 值替换帧：权威账整体覆盖后角标收敛");
}

// ---------- ③ 能力卡：有字段渲染/无字段整卡隐藏/密钥不入渲染树 ----------
{
  // 旧 relay：两字段皆缺 → null = 整卡隐藏
  check(capabilityCardModel({}) === null, "③ 旧 relay（皆缺）→ null 整卡隐藏");
  check(capabilityCardModel({ schemaVersion: undefined, sourceCapabilities: undefined, models: ["m"] }) === null, "③ 仅 models 不出卡（models 非能力位依据）");

  // 仅 schema_version：出卡但只有版本行（行级按字段在场渲染）
  const schemaOnly = capabilityCardModel({ schemaVersion: 1 })!;
  check(schemaOnly.rows.length === 1 && schemaOnly.rows[0].value === "v1", "③ 仅版本 → 单行");
  check(schemaOnly.privacy.includes("环境变量") && schemaOnly.privacy.includes("不随快照"), "③ 隐私提示=非秘密引用文案");

  // 全字段：行序稳定、布尔 false → 「不可用」（键在场即渲染，不出假「—」也不缺报）
  const full = capabilityCardModel({
    schemaVersion: 2,
    sourceCapabilities: { models: true, activity: true, notifications: false, commands: ["COMMAND_A", "COMMAND_B"] } as SourceCapabilities,
    models: ["claude", "codex"],
  })!;
  check(full.rows.length === 6, "③ 全字段 6 行");
  check(full.rows.map((r) => r.key).join(",") === "schema,activity,modelsCap,notifications,commands,modelCount", "③ 行序稳定");
  check(full.rows.find((r) => r.key === "notifications")?.value === "不可用", "③ capability false → 「不可用」");
  check(full.rows.find((r) => r.key === "commands")?.value === "2 项", "③ 命令计数");
  check(full.rows.find((r) => r.key === "modelCount")?.value === "2 个", "③ 模型计数");

  // 缺 key：对应行隐藏（不猜字段）
  const partial = capabilityCardModel({ sourceCapabilities: { activity: true } })!;
  check(partial.rows.length === 1 && partial.rows[0].key === "activity", "③ 缺 key 行隐藏（只出 activity）");

  // 隐私红线：source_capabilities 上的未知键（含密钥形）一律不读不渲染
  const leaky = capabilityCardModel({
    schemaVersion: 3,
    sourceCapabilities: { activity: true, token: "sk-secret-token", api_key: "kk-123" } as unknown as SourceCapabilities,
  })!;
  const leakDump = JSON.stringify(leaky);
  check(!leakDump.includes("sk-secret-token") && !leakDump.includes("kk-123"), "③ 密钥类字段绝不入渲染树");
  check(!leakDump.includes("token") && !leakDump.includes("api_key"), "③ 密钥类键名也不出现");

  // 390 宽：行数有界、值短文案（单行截断前就不失控）
  check(full.rows.length <= 7 && full.rows.every((r) => r.value.length <= 20 && r.label.length <= 12), "③ 行数与文案长度有界");
}

// ---------- ④ memo 边界：同入参结构稳定（组件层 useMemo 不因投影抖动） ----------
{
  const input = { schemaVersion: 2, sourceCapabilities: { activity: true } as SourceCapabilities, models: ["a"] };
  const a = capabilityCardModel(input)!;
  const b = capabilityCardModel(input)!;
  check(JSON.stringify(a) === JSON.stringify(b), "④ 同入参两次投影结构相等（memo 值语义稳定）");
  const changed = capabilityCardModel({ ...input, schemaVersion: 3 })!;
  check(changed.rows[0].value === "v3" && changed.rows.length === a.rows.length, "④ 字段变化仅该行值变化");
}

console.log(`E4a setup projection tests ${tests}/${tests} passed`);
