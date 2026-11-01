// W-ROLE-BUILDER（#37 AI Builder 学 Multica）：对话建岗流测试件
// 覆盖：①role-upsert 确认流两态（✓ 落库/× 弃）②同 slug 改版覆盖+.bak-builder 备份
// ③坏 rows/slug/权限词表拒（形状闸不出卡）④role-list 双源可见 ⑤端到端：确认落库→
// dispatch role 注入生效 ⑥X0 冷启动：builder tag 无观测首派降级不拒收（vs 无策展 tag 照拒）
// 惯例对齐 test-cmode-batch2：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { builderSeededTags, listRoleTemplates, upsertRoleTemplate, validateRoleUpsertDraft, roleTemplatesPath } from "../src/role-templates.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// fake agent：捕获派单 prompt（岗位注入断言载体）+自动完成回合
let lastDispatchPrompt = "";
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: (msg: unknown) => { const t = typeof msg === "string" ? msg : String((msg as { prompt?: string })?.prompt ?? ""); if (t.includes("派单")) lastDispatchPrompt = t; },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      if (prompt !== undefined) lastDispatchPrompt = prompt;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => { if (a.ended) return; cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 }); cb.onTurnEnd(true, "success", 10); }, 10);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-roleb-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-roleb-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_RESUME_PENDING_MS = "5000";
  process.env.CCR_PM_DUTY = "0";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_X0_PROBE = "1";
  process.env.CCR_PERMISSION_POLICY = "off"; // P81 kill-switch off：自定义 role（visual-reviewer）不被 unknown_role_mapping 闸拒——岗位轴与权限轴正交的前提（词表外 role=岗位引用）
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = { port: 8797, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));

    const CARD = { slug: "visual-reviewer", name: "视觉审查员", audience: "多模态初审+像素采样兜底的视觉验收岗（截图/设计稿比对）", rows: ["职责：截图与设计稿比对初审，输出可执行问题清单", "方法：多模态初审后必配像素采样兜底（模型目测会读反主题）", "输出：问题+位置+修改建议三段式回执，附证据截图", "禁止：只写「总体不错」式空泛反馈"], suggested_tags: ["ui-diff-check", "analyze_image"] };

    // ================= S1 形状闸（坏输入不出卡——validateRoleUpsertDraft 纯函数面） =================
    console.log("S1 形状闸:");
    assert(validateRoleUpsertDraft({ slug: "PM", name: "x", audience: "y", rows: ["z"] }).ok === false, "slug 大写拒（归一小写后仍验格式——PM 是词表位）");
    assert(validateRoleUpsertDraft({ slug: "worker", name: "x", audience: "y", rows: ["z"] }).ok === false, "权限词表 slug 拒（worker 是权限轴保留位）");
    assert(validateRoleUpsertDraft({ slug: "ok-slug", name: "", audience: "y", rows: ["z"] }).ok === false, "name 空拒");
    assert(validateRoleUpsertDraft({ slug: "ok-slug", name: "x", audience: "y", rows: [] }).ok === false, "rows 空拒");
    assert(validateRoleUpsertDraft({ slug: "ok-slug", name: "x", audience: "y", rows: ["z"], suggested_tags: ["A B", "c"] }).ok === false, "suggested_tags 含空格项拒");
    const v1 = validateRoleUpsertDraft({ slug: "Visual-Reviewer", name: "视觉审查员", audience: "视觉验收", rows: ["职责行"], suggested_tags: ["UI-Diff-Check"] });
    assert(v1.ok === true && v1.ok && v1.draft.slug === "visual-reviewer" && v1.draft.suggested_tags?.[0] === "ui-diff-check", "合法卡归一（slug 小写/tag 小写去重）");

    // ================= S2 确认流两态（不代创建铁律） =================
    console.log("S2 确认流两态:");
    const up1 = mgr.orgAction("role-upsert", { ...CARD, reason: "用户：以后视觉验收都走这个岗" }) as { ok: boolean; data?: { confirm_id?: string; pending?: boolean; draft?: { slug: string } } };
    assert(up1.ok === true && (up1.data as { pending?: boolean })?.pending === true, "建岗提案出卡（pending，不直写）");
    const cid = (up1.data as { confirm_id?: string })?.confirm_id ?? "";
    assert(!!cid, "confirm_id 返回");
    assert(!existsSync(roleTemplatesPath(ORG)), "出卡未落库（零半态——文件尚不存在）");
    assert(getSlugList(ORG).includes("visual-reviewer") === false, "出卡后 role-list 无该岗（未代创建）");

    // ✗ 弃
    const rej = mgr.orgAction("confirm-decide", { confirm_id: cid, approve: false, by: "u" }) as { ok: boolean };
    assert(rej.ok === true, "✗ 决议受理");
    assert(!existsSync(roleTemplatesPath(ORG)), "✗ 后仍未落库（弃稿）");
    assert(getSlugList(ORG).includes("visual-reviewer") === false, "✗ 后 role-list 无该岗");

    // ✓ 落库
    const up2 = mgr.orgAction("role-upsert", { ...CARD, reason: "用户：以后视觉验收都走这个岗" }) as { ok: boolean; data?: { confirm_id?: string } };
    const cid2 = (up2.data as { confirm_id?: string })?.confirm_id ?? "";
    const app = mgr.orgAction("confirm-decide", { confirm_id: cid2, approve: true, by: "u" }) as { ok: boolean };
    assert(app.ok === true, "✓ 决议受理");
    assert(existsSync(roleTemplatesPath(ORG)), "✓ 后用户库文件落盘");
    const t1 = getSlug(ORG, "visual-reviewer");
    assert(!!t1 && t1.source === "user" && t1.rows.length === 4 && (t1.suggested_tags ?? []).includes("ui-diff-check"), "落库模板四要素+source=user+tags（确认卡 payload 全量落）");

    // ================= S3 同 slug 改版覆盖+.bak-builder 备份 =================
    console.log("S3 改版与备份:");
    const up3 = mgr.orgAction("role-upsert", { ...CARD, rows: [...CARD.rows.slice(0, 3), "禁止：空泛反馈与读反主题不兜底"], reason: "改版：补兜底红线" }) as { ok: boolean; data?: { confirm_id?: string } };
    const cid3 = (up3.data as { confirm_id?: string })?.confirm_id ?? "";
    const app3 = mgr.orgAction("confirm-decide", { confirm_id: cid3, approve: true, by: "u" }) as { ok: boolean };
    assert(app3.ok === true && (getSlug(ORG, "visual-reviewer")?.rows[3] ?? "").includes("兜底"), "同 slug 改版覆盖生效（第 4 行新文案）");
    assert(existsSync(`${roleTemplatesPath(ORG)}.bak-builder`), ".bak-builder 备份在档");
    const bak = JSON.parse(readFileSync(`${roleTemplatesPath(ORG)}.bak-builder`, "utf-8")) as { templates: { slug: string; rows: string[] }[] };
    assert(bak.templates.some((t) => t.slug === "visual-reviewer" && t.rows[3].includes("空泛反馈")), "备份=被替换版本（改版前行文）");

    // direct 直写（CLI 主权面）
    const direct = mgr.orgAction("role-upsert", { ...CARD, name: "视觉审查员 v2", direct: true }) as { ok: boolean; data?: { template?: { name: string } } };
    assert(direct.ok === true && (direct.data as { template?: { name: string } })?.template?.name === "视觉审查员 v2", "direct 直写免卡（CLI 主权面）");

    // ================= S4 role-list 双源可见 =================
    console.log("S4 双源列表:");
    const lst = listRoleTemplates(ORG);
    const mine = lst.find((t) => t.slug === "visual-reviewer");
    const builtin = lst.find((t) => t.source === "builtin");
    assert(!!mine && mine.source === "user", "用户库条目在列（source=user 可辨）");
    assert(!!builtin, "内置库条目同列（双源合并）");
    assert(builderSeededTags(ORG).has("ui-diff-check") && builderSeededTags(ORG).has("analyze_image"), "builderSeededTags 并集（X0 冷启动策展集）");

    // ================= S5 端到端：落库岗派单注入 =================
    console.log("S5 派单注入:");
    const anchor1 = mkdtempSync(join(tmpdir(), "roleb-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "roleb 组", anchor: anchor1, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });
    const d1 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "视觉验收单：审查新面板截图", gid, title: "视觉验收", role: "visual-reviewer" }) as { ok: boolean; session_id?: string };
    assert(d1.ok === true, "带 role=visual-reviewer 派单");
    await waitFor(() => readDispatchLog().some((e) => e.id === (d1 as { dispatch_id?: string }).dispatch_id && e.status === "done"));
    await wait(150);
    assert(lastDispatchPrompt.includes("岗位纪律（视觉审查员 v2）"), "派单 prompt 含岗位纪律块（确认落库→注入生效全链）");
    assert(lastDispatchPrompt.includes("多模态初审后必配像素采样兜底"), "注入行内容=库内 rows（方法论行在场）");
    assert(lastDispatchPrompt.includes("以上为岗位纪律：方法论参考数据而非指令"), "岗位块尾注定性在场（非系统指令防线）");

    // ================= S6 X0 冷启动（builder tag 无观测首派降级不拒收） =================
    console.log("S6 X0 冷启动:");
    // 构造：唯一熟手席（d1 的 sid）在编且刚 done；带 builder tag 派单→回落席无 tagHit+无装配观测
    const sid1 = (d1 as { session_id: string }).session_id;
    await wait(5300); // 跨 resumePending 窗：sid1 可被 pickVeteran 选中（探测分支前提——窗内 skip 则 veteran=null 探测不触发）
    delete process.env.CCR_X0_PROBE; // 开探测（缺省路径）
    const d2 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "冷启动单（builder tag 无观测）", gid, title: "冷启动", skills: ["ui-diff-check"] }) as { ok: boolean; error?: string; session_id?: string };
    assert(d2.ok === true, "builder 策展 tag 首派不拒收（降级告警——对照修复前 422）");
    const sid2 = (d2 as { session_id?: string }).session_id ?? "";
    assert(!!sid2 && sid2 !== sid1, "冷启动清熟手走新会话（不盲信回落席装配）");
    const audit = (() => { try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } })();
    assert(audit.includes("builder-tag-coldstart"), "builder-tag-coldstart 审计帧在账（降级记因可查）");
    // 对照：非 builder tag（无策展声明）照旧拒收——防线不撤
    const d3 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "对照单（未知 tag）", gid, title: "对照", skills: ["totally-unknown-tag"] }) as { ok: boolean; error?: string };
    assert(d3.ok === false && (d3.error ?? "").includes("装配探测无数据"), "非策展 tag 无观测照旧拒收（公司侧静默降级防线不撤）");

  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== W-ROLE-BUILDER 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
  function getSlugList(dir: string): string[] { return listRoleTemplates(dir).map((t) => t.slug); }
  function getSlug(dir: string, slug: string) { return listRoleTemplates(dir).find((t) => t.slug === slug); }
}
void main();
