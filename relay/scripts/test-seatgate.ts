// [W-SMIMPL ①] seatGate 席位门单源穷举单测（W-SMDESIGN 候选 1 拍板口径）——
// 同 sid×角色×外部性全组合锁死四轴判据（pm 词表豁免/在册/外部/Leader），
// 外加接线锚（四入口真调 seatGate 的源码级断言——防未来新增入口漏走单源）。
//
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-seatgate.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seatGate, PM_ROLE_RE, type SeatGateContext } from "../src/projects.js";

const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sm = readFileSync(join(RELAY_ROOT, "src", "session-manager.ts"), "utf-8");
const pj = readFileSync(join(RELAY_ROOT, "src", "projects.ts"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// 事实注入桩：四类会话身份（PM 主会话=外部 / 托管 worker / 外部 worker / Leader 托管）
const SID = {
  extPm: "ext-pm-session-0001",       // 外部（PM 主会话生产形态）
  managed: "managed-worker-0002",     // 在册托管
  external: "ext-worker-0003",        // 在册外部
  leader: "managed-leader-0004",      // 在册托管 + Leader
  unknown: "ghost-session-0005",      // 不在册
};
const ctx: SeatGateContext = {
  seatInfo: (sid) => {
    if (sid === SID.unknown) return undefined;
    const external = sid === SID.extPm || sid === SID.external;
    return { external };
  },
  isLeader: (sid) => sid === SID.leader,
};

// ---------- §A 穷举矩阵：4 会话身份 × 4 角色全组合 ----------
// 期望表：ok | 拒因（pm 词表行=身份行语义豁免三轴；leader 会话勾 pm 也豁免——词表优先，
// 与 create pmSidRaw 分流/sanitize gate 旧口径一致：豁免在最前）
const ROLES = ["pm", "leader", "worker", "qa"] as const;
const expect: Record<string, Record<string, "ok" | "not_present" | "external" | "leader">> = {
  [SID.extPm]:    { pm: "ok", leader: "ok", worker: "external", qa: "external" },
  [SID.managed]:  { pm: "ok", leader: "ok", worker: "ok", qa: "ok" },
  [SID.external]: { pm: "ok", leader: "ok", worker: "external", qa: "external" },
  [SID.leader]:   { pm: "ok", leader: "ok", worker: "leader", qa: "leader" },
  [SID.unknown]:  { pm: "ok", leader: "ok", worker: "not_present", qa: "not_present" },
};
let combos = 0;
for (const [sid, roleMap] of Object.entries(expect)) {
  for (const role of ROLES) {
    const r = seatGate(sid, role, ctx);
    const want = roleMap[role];
    combos++;
    if (want === "ok") ok(r.ok === true, `matrix ${sid.slice(0, 10)}×${role} → ok`);
    else ok(r.ok === false && !r.ok && r.reason === want, `matrix ${sid.slice(0, 10)}×${role} → ${want}`);
  }
}
ok(combos === 5 * 4, `matrix exhaustive 20 combos (got ${combos})`);

// ---------- §B 词表边界（PM_ROLE_RE 全词表 + 大小写 + 非词表近似词） ----------
for (const role of ["PM", "Leader", "产品经理", "项目经理", "领队"]) {
  ok(seatGate(SID.external, role, ctx).ok === true, `pm 词表「${role}」豁免（大小写/中文全词）`);
}
ok(seatGate(SID.external, "pmm", ctx).ok === false, "非词表「pmm」不豁免（正则全词锚）");
ok(seatGate(SID.external, "worker-pm", ctx).ok === false, "非词表「worker-pm」不豁免");
ok(seatGate(SID.external, "领队X", ctx).ok === false, "非词表「领队X」不豁免");
ok(PM_ROLE_RE.test("pm") && !PM_ROLE_RE.test("pmm"), "PM_ROLE_RE 词表锚在位");

// ---------- §C 接线锚（四入口源码级——防未来入口漏走单源/回退散落 if） ----------
ok(sm.includes("seatGate(sid, hcRole, this.seatGateCtx())"), "create 前置门接线 seatGate");
ok(sm.includes("const seat = seatGate(sid, role, this.seatGateCtx());"), "HeadcountGate 闭包转调 seatGate（member-add 同款）");
ok(sm.includes('seatGate(sidFull, "worker", this.seatGateCtx())'), "member-retire 接线 seatGate（固定 worker 绕词表轴，PM 行除名仍拒外部/Leader 与旧版一致）");
// 判据体单源性：session-manager 不再散落三连 if 判据（grep 锚：直接读 s.state.external 判席位的旧式写法清零于门区）
const gateZone = sm.slice(sm.indexOf("随团编制会话校验"), sm.indexOf("adaptOrgAction(payload"));
ok(!gateZone.includes("if (this.isLeaderSession(sid))"), "create 门区旧式 Leader 直判已收口（判据在 seatGate）");
ok(pj.includes("export function seatGate"), "seatGate 落点 projects.ts（单源权威位）");

// ---------- §D retire 语境边界（外部/Leader 拒、无卡=合法清扫路径不拒） ----------
const rGhost = seatGate(SID.unknown, "worker", ctx); // ghost→not_present（retire 外层不拒）
ok(rGhost.ok === false && rGhost.reason === "not_present", "无卡 not_present（retire 外层=合法清扫路径自行处理）");
const rExt2 = seatGate(SID.external, "worker", ctx);
ok(rExt2.ok === false && rExt2.reason === "external", "外部拒（retire 数据异常口径同源）");
const rLdr = seatGate(SID.leader, "worker", ctx);
ok(rLdr.ok === false && rLdr.reason === "leader", "Leader 拒（不可退休同源）");

// ---------- §E ②回执标记透传闸（W-SMIMPL ②共批件）：schema 放行 + 台账落读端到端 ----------
// appendDispatch 经 applyOrgChange("dispatch-entry") 严格闸——receipt_missing 必须在
// DISPATCH_ENTRY_SCHEMA 白名单内，否则收口落账被拒写=观测标记静默丢失。
{
  const { appendDispatch, readDispatchLog } = await import("../src/org.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "smimpl-seatgate-"));
  try {
    const id = "smimpl-rm-test-0001";
    const wrote = appendDispatch({ ts: Date.now(), id, tier: "正经立项", target: "org-command", status: "done", receipt: "completed", session_id: "sess-rm", receipt_missing: true }, tmp);
    ok(wrote === true, "receipt_missing 行过 schema 闸落账（appendDispatch ok）");
    const rows = readDispatchLog(tmp).filter((r) => r.id === id);
    ok(rows.length === 1 && (rows[0] as { receipt_missing?: boolean }).receipt_missing === true, "台账读回 receipt_missing:true 透传");
    const wroteNoFlag = appendDispatch({ ts: Date.now(), id: id + "b", tier: "正经立项", target: "org-command", status: "done", receipt: "completed", session_id: "sess-rm" }, tmp);
    ok(wroteNoFlag === true, "无标记行（旧行为）照落——纯增量零破坏");
    const rowsB = readDispatchLog(tmp).filter((r) => r.id === id + "b");
    ok(rowsB.length === 1 && (rowsB[0] as { receipt_missing?: boolean }).receipt_missing === undefined, "旧行为行缺省 undefined（宽容读侧口径）");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- §F ②web 角标接线锚（done 卡「无回执」——数据源/渲染/CSS 三键） ----------
{
  const td = readFileSync(join(RELAY_ROOT, "..", "web-console", "js", "team-domain.js"), "utf8");
  const css = readFileSync(join(RELAY_ROOT, "..", "web-console", "css", "base.css"), "utf8");
  ok(td.includes("function missingReceiptIds(gid)") && td.includes('r.receipt_missing === true && r.id'), "web 数据源 missingReceiptIds（receipts 收敛行判定）");
  ok(td.includes('cline-miss" title="收口 done 但回执无「结果：」行'), "done 卡角标渲染接线（clineBits）");
  ok(css.includes(".task-cline .cline-miss { color: var(--error); }"), "cline-miss 样式（error 警示色）");
}

console.log(`\nseatgate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
