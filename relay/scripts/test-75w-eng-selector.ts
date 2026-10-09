// #75-W 新建会话引擎选择器 web 半：词表字面锚 + 契约字段消费锚 + undefined 降级锚 +
// resolveEngChoice 直跑 + 旧 checkbox 一次性迁移锚 + ACK 失败不建卡不变量沿用 + 降级对照锚。
// 词表钉死（任务书；四状态 + 四固定文案，改字面必三端同步）。75-R（relay engine_catalog 投影）
// 在途，本件按 PM-75 提案 §4.3 契约形状锁 web 消费面。
// 直跑：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-75w-eng-selector.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console");
const html = readFileSync(join(webDir, "index.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function blockOf(startMark: string, endMark: string): string {
  const a = html.indexOf(startMark);
  if (a < 0) return "";
  const b = html.indexOf(endMark, a);
  return b < 0 ? "" : html.slice(a, b);
}
function extract(re: RegExp): string {
  return re.exec(html)?.[0] ?? "";
}

console.log("== 75-W engine selector web: static anchors + behavior ==");

// ---- ① 词表字面锚（任务书钉死，逐词 verbatim——改字面须三端同步，此处即闸） ----
{
  const stTbl = extract(/const ENG_STATE_LABEL = \{[\s\S]*?\};/);
  ok(stTbl.includes('ready: "可用"'), "vocab: ready=可用");
  ok(stTbl.includes('unavailable: "未安装或校验未过"'), "vocab: unavailable=未安装或校验未过");
  ok(stTbl.includes('unsupported: "不支持 · 不可选"'), "vocab: unsupported=不支持 · 不可选");
  ok(stTbl.includes('unknown: "状态未知"'), "vocab: unknown=状态未知");
  ok(count(html, "const ENG_STATE_LABEL") === 1 && count(html, "const ENG_COLORS") === 1 && count(html, "const ENG_CAP_LABEL") === 1 && count(html, "const ENG_ROLE_ZH") === 1, "vocab: four tables single-defined");
  // 四固定文案（已覆盖预置=摘要行元素字面；使用引擎默认=模型层首行；升级 relay=engUpHint；
  // 跟随 <role> 预置=浮层 autoDesc 拼接「跟随 Worker 预置」）
  ok(html.includes(">已覆盖预置</span>"), "fixed-copy: 已覆盖预置 present (engOver element)");
  ok(html.includes("使用引擎默认"), "fixed-copy: 使用引擎默认 present (models layer first row)");
  ok(html.includes("升级 relay 可选择更多引擎"), "fixed-copy: 升级 relay 可选择更多引擎 present (engUpHint)");
  ok(/"跟随 " \+ ENG_ROLE_ZH\.worker \+ " 预置/.test(html), "fixed-copy: 跟随 <role> 预置 template (worker → 跟随 Worker 预置)");
  // 引擎 badge 色对齐 specs/005 引擎色词表（--engine-* 六值）
  const colorTbl = extract(/const ENG_COLORS = \{[\s\S]*?\};/);
  ok(colorTbl.includes('claude: "#A97A62"') && colorTbl.includes('codex: "#8DABFF"') && colorTbl.includes('trae: "#58C9B1"'), "vocab: ENG_COLORS aligned with 005 (claude/codex/trae)");
  ok(colorTbl.includes('"qwen-code": "#B493FF"') && colorTbl.includes('codebuddy: "#4BA8F0"') && colorTbl.includes('zcode: "#E58DB0"'), "vocab: ENG_COLORS aligned with 005 (qwen/codebuddy/zcode)");
}

// ---- ② 契约消费锚（SNAPSHOT source_capabilities.engine_catalog 字段存在性；75-R 在途） ----
{
  ok(/ctx\.engineCatalog = Array\.isArray\(msg\.payload\.source_capabilities\?\.engine_catalog\) \? msg\.payload\.source_capabilities\.engine_catalog : null;/.test(html), "SNAPSHOT: engineCatalog field-existence consumption (undefined → null)");
  ok(/engineCatalog: null, \/\/ #75-W/.test(html), "ensureCtx: engineCatalog init null");
  ok(count(html, 'id="engSelRow"') === 1 && count(html, 'id="engSelPop"') === 1 && count(html, 'id="engSum"') === 1 && count(html, 'id="engOver"') === 1 && count(html, 'id="engUpHint"') === 1 && count(html, 'id="engSelBtn"') === 1, "structure: six new ids unique");
  ok(html.indexOf('id="engSelRow"') > html.indexOf('id="newTarget"') && html.indexOf('id="engSelRow"') < html.indexOf('class="row newopts"'), "structure: summary row between #newTarget and .newopts (prompt below, opts above)");
  ok(/<div id="engSelPop"><\/div>/.test(html) && html.indexOf('id="engSelPop"') > html.indexOf('id="permPop"'), "structure: popup shell default-empty, after #permPop");
  ok(/#engSelPop\.open \{ display: block; \}/.test(html), "structure: popup opens via .open class (modelPop same shell)");
  const snapBlk = blockOf("ctx.engineCatalog = Array.isArray", "ctx.orgConfirms");
  ok(snapBlk.includes("syncEngUI();"), "SNAPSHOT: syncEngUI chained (summary row + checkbox visibility refresh)");
  ok(/发送链：catalog 存在 = 选择器驱动/.test(html) && /selection_source 随命令携带/.test(html), "contract: send-chain documents selection_source vocabulary");
}

// ---- ③ resolveEngChoice 直跑（纯函数三态：ok / block / needConfirm） ----
{
  const fn = extract(/function resolveEngChoice\(cat, sel, role\) \{[\s\S]*?\n\}/);
  const engLabel = extract(/var ENGINE_LABEL = \{[\s\S]*?\};/);
  const stTbl = extract(/const ENG_STATE_LABEL = \{[\s\S]*?\};/);
  ok(fn !== "" && engLabel !== "" && stTbl !== "", "behavior: resolveEngChoice extractable with real vocab");
  const run = (cat: unknown, sel: Record<string, unknown>, role?: string) =>
    new Function("cat", "sel", "role", engLabel + "\n" + stTbl + "\n" + fn + "\nreturn resolveEngChoice(cat, sel, role);")(cat, sel, role) as Record<string, unknown>;
  const READY_TRAE = { id: "trae", label: "Trae", state: "ready", capabilities: { resume: false, approval: false, artifacts: false }, preflight: { state: "pass", reason: "" }, models: ["glm-5.3"], default_for_roles: ["worker"] };
  const READY_CLAUDE = { id: "claude", state: "ready", models: [], default_for_roles: [] };
  const UNAV_CODEX = { id: "codex", state: "unavailable", models: [], default_for_roles: [] };
  let r = run([READY_CLAUDE, READY_TRAE], { engine: "", model: "", manual: false });
  ok(r.ok === true && r.engine === "trae" && r.model === "glm-5.3" && r.selection_source === "role_default", "behavior: auto + worker preset ready → role_default with models[0]");
  r = run([READY_CLAUDE, UNAV_CODEX], { engine: "", model: "", manual: false });
  ok(r.ok === true && r.engine === undefined && r.selection_source === "relay_default", "behavior: no worker preset → relay_default, engine field omitted (source default Claude)");
  r = run([READY_CLAUDE, READY_TRAE], { engine: "trae", model: "glm-5.3", manual: true });
  ok(r.ok === true && r.engine === "trae" && r.model === "glm-5.3" && r.selection_source === "manual", "behavior: manual pick → manual + explicit engine/model");
  r = run([READY_CLAUDE, READY_TRAE], { engine: "trae", model: "", manual: true });
  ok(r.ok === true && r.model === undefined, "behavior: manual without model → model omitted (使用引擎默认)");
  r = run([READY_CLAUDE, UNAV_CODEX], { engine: "codex", model: "", manual: true });
  ok(typeof r.block === "string" && (r.block as string).includes("未安装或校验未过") && (r.block as string).includes("Codex"), "behavior: explicit unavailable engine → block with state wording (no fake claude substitute)");
  r = run([READY_CLAUDE, { id: "trae", state: "ready", preflight: { state: "fail", reason: "missing binary" } }], { engine: "trae", model: "", manual: true });
  ok(typeof r.block === "string" && (r.block as string).includes("missing binary"), "behavior: preflight fail → block with relay-provided reason");
  r = run([{ id: "claude", state: "unavailable" }, { id: "trae", state: "ready", models: [], default_for_roles: [] }], { engine: "", model: "", manual: false });
  ok(r.needConfirm === true && r.fallback === "trae", "behavior: default engine unavailable + fallback exists → needConfirm (no silent engine swap)");
  r = run([{ id: "claude", state: "unavailable" }, { id: "zcode", state: "unsupported" }], { engine: "", model: "", manual: false });
  ok(typeof r.block === "string", "behavior: nothing usable → block");
  r = run([{ id: "claude", state: "ready", preflight: { state: "unknown", reason: "" } }, { id: "trae", state: "ready", models: [], default_for_roles: [] }], { engine: "", model: "", manual: false });
  ok(r.ok === true && r.selection_source === "relay_default", "behavior: preflight unknown does not block default (fail = fail only)");
  r = run([{ id: "claude", state: "ready", preflight: { state: "pass", reason: "" } }, { id: "trae", state: "ready", models: [], default_for_roles: [] }], { engine: "", model: "", manual: false });
  ok(r.ok === true && r.selection_source === "relay_default", "behavior: preflight pass does not block default");
  r = run(null, { engine: "codex", model: "", manual: true });
  ok(r.ok === true && r.selection_source === "relay_default", "behavior: null catalog (old relay) → relay_default, caller keeps checkbox chain");
  r = run([null, READY_CLAUDE, 42] as unknown[], { engine: "", model: "", manual: false });
  ok(r.ok === true, "behavior: malformed catalog entries tolerated");
}

// ---- ④ undefined 降级锚：renderEngSelRow 直跑（旧 relay / 离线 / 单引擎三面） ----
{
  const fn = extract(/function renderEngSelRow\(\) \{[\s\S]*?\n\}/);
  const engLabel = extract(/var ENGINE_LABEL = \{[\s\S]*?\};/);
  const roleTbl = extract(/const ENG_ROLE_ZH = \{[\s\S]*?\};/);
  ok(fn !== "", "behavior: renderEngSelRow extractable");
  const mkEls = () => ({
    engSelRow: { style: {} as Record<string, string> },
    engSum: { textContent: "" },
    engOver: { style: {} as Record<string, string> },
    engSelBtn: { style: {} as Record<string, string> },
    engUpHint: { style: {} as Record<string, string> },
  });
  const run = (ctxMock: unknown, sel: Record<string, unknown>) => {
    const els = mkEls();
    new Function("$", "ctxs", "activeServerId", "firstOnlineCtx", "engSel",
      engLabel + "\n" + roleTbl + "\n" + fn + "\nreturn renderEngSelRow();")(
      (id: string) => els[id as keyof typeof els] ?? null,
      new Map([["srv1", ctxMock]]), "srv1", () => null, sel,
    );
    return els;
  };
  const CAT = [
    { id: "claude", state: "ready", models: [], default_for_roles: [] },
    { id: "trae", state: "ready", models: ["glm-5.3"], default_for_roles: ["worker"] },
    { id: "zcode", state: "unsupported", models: [], default_for_roles: [] },
  ];
  let e = run({ status: "online", engineCatalog: null }, { engine: "", model: "", manual: false });
  ok(e.engSelRow.style.display === "flex" && e.engSum.textContent === "自动 · Claude", "degraded: old relay online → 自动 · Claude");
  ok(e.engUpHint.style.display === "" && e.engSelBtn.style.display === "none", "degraded: old relay → upgrade hint shown, no change button");
  ok(e.engOver.style.display === "none", "degraded: old relay → no override badge");
  e = run({ status: "online", engineCatalog: CAT }, { engine: "", model: "", manual: false });
  ok(e.engSelRow.style.display === "flex" && e.engSum.textContent === "自动（Worker 预置） · Trae · glm-5.3", "behavior: auto with worker preset → 自动（Worker 预置） · Trae · glm-5.3");
  ok(e.engUpHint.style.display === "none" && e.engSelBtn.style.display === "", "behavior: catalog present → hint hidden, change button shown");
  e = run({ status: "online", engineCatalog: CAT }, { engine: "trae", model: "glm-5.3", manual: true });
  ok(e.engSum.textContent === "Trae · glm-5.3" && e.engOver.style.display === "", "behavior: manual pick → engine · model + 已覆盖预置 badge shown");
  e = run({ status: "online", engineCatalog: [{ id: "trae", state: "ready", models: [], default_for_roles: [] }] }, { engine: "", model: "", manual: false });
  ok(e.engSum.textContent === "仅可用：Trae" && e.engSelBtn.style.display === "none", "degraded: single-engine → 仅可用：X, no dropdown arrow");
  e = run({ status: "online", engineCatalog: CAT }, { engine: "", model: "", manual: false });
  e = run({ status: "offline", engineCatalog: CAT }, { engine: "", model: "", manual: false });
  ok(e.engSelRow.style.display === "none", "degraded: offline → row hidden");
  e = run(null, { engine: "", model: "", manual: false });
  ok(e.engSelRow.style.display === "none", "degraded: no ctx → row hidden");
}

// ---- ⑤ 浮层渲染直跑（两层 + 灰显不可选 + Claude 模型回退） ----
{
  const fn = extract(/function renderEngSelPop\(\) \{[\s\S]*?\n\}/);
  const esc = extract(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
  const engLabel = extract(/var ENGINE_LABEL = \{[\s\S]*?\};/);
  const stTbl = extract(/const ENG_STATE_LABEL = \{[\s\S]*?\};/);
  const capTbl = extract(/const ENG_CAP_LABEL = \{[\s\S]*?\};/);
  const colorTbl = extract(/const ENG_COLORS = \{[\s\S]*?\};/);
  const roleTbl = extract(/const ENG_ROLE_ZH = \{[\s\S]*?\};/);
  ok(fn !== "" && esc !== "", "behavior: renderEngSelPop extractable");
  const run = (ctxMock: unknown, sel: Record<string, unknown>, view: string) => {
    const el = { innerHTML: "", style: {} as Record<string, string> };
    new Function("$", "ctxs", "activeServerId", "firstOnlineCtx", "engPopView", "engSel",
      esc + "\n" + engLabel + "\n" + stTbl + "\n" + capTbl + "\n" + colorTbl + "\n" + roleTbl + "\n" + fn +
      "\nreturn renderEngSelPop();")(
      (id: string) => (id === "engSelPop" ? el : null),
      new Map([["srv1", ctxMock]]), "srv1", () => null, view, sel,
    );
    return el.innerHTML;
  };
  const CAT = [
    { id: "claude", state: "ready", capabilities: { resume: true, approval: true, artifacts: true }, preflight: { state: "pass", reason: "" }, models: [], default_for_roles: [] },
    { id: "trae", state: "ready", capabilities: { resume: false, approval: false, artifacts: false }, preflight: { state: "pass", reason: "" }, models: ["glm-5.3", "glm-air"], default_for_roles: ["worker"] },
    { id: "zcode", state: "unsupported", capabilities: {}, preflight: { state: "pass", reason: "" }, models: [], default_for_roles: [] },
    { id: "codex", state: "unavailable", capabilities: {}, preflight: { state: "fail", reason: "not installed" }, models: [], default_for_roles: [] },
  ];
  const ctxMock = { status: "online", engineCatalog: CAT, models: ["GLM-5.3", "GLM-4.7"] };
  let h = run(ctxMock, { engine: "", model: "", manual: false }, "root");
  ok(h.includes("跟随预置") && h.includes("跟随 Worker 预置 · Trae · glm-5.3"), "popup L1: preset row with 跟随 Worker 预置 + resolved engine · model");
  ok(h.includes('data-act="eng" data-e="' + encodeURIComponent("trae") + '"'), "popup L1: usable engine rows selectable");
  ok((h.match(/class="ep-row dis"/g) || []).length === 2, "popup L1: unavailable/unsupported rows greyed non-selectable (展示项≠可选项)");
  ok(h.includes("未安装或校验未过") && h.includes("不支持 · 不可选"), "popup L1: state vocabulary surfaced");
  ok(h.includes("校验未过：not installed"), "popup L1: preflight fail reason surfaced on greyed row");
  ok(h.includes("续传✓") && h.includes("审批—"), "popup L1: capability bits rendered as ✓/—");
  ok(h.includes("权限档由组织/角色策略决定"), "popup L1: permission note (zero policy re-evaluation)");
  h = run(ctxMock, { engine: "trae", model: "", manual: true }, "trae");
  ok(h.includes("使用引擎默认") && h.includes("glm-5.3") && h.includes("glm-air"), "popup L2: 使用引擎默认 first row + catalog models listed");
  ok(h.includes('data-act="model" data-m="' + encodeURIComponent("glm-5.3") + '"'), "popup L2: model rows carry encodeURIComponent payload");
  ok(h.includes("← Trae"), "popup L2: back header to root");
  h = run(ctxMock, { engine: "claude", model: "", manual: true }, "claude");
  ok(h.includes("GLM-5.3") && h.includes("GLM-4.7"), "popup L2: claude without catalog models falls back to ctx.models (SNAPSHOT.models claude-only fallback)");
  h = run(ctxMock, { engine: "zcode", model: "", manual: true }, "zcode");
  ok(h.includes("使用引擎默认") && !h.includes("GLM-5.3"), "popup L2: non-claude engine without models → default-only (SNAPSHOT.models never passed off as other engines' list)");
}

// ---- ⑥ 旧 #27 checkbox 一次性迁移直跑（ccd_use_codex → engSel，记忆保留不清除） ----
{
  const fn = extract(/function engSelMigrate\(\) \{[\s\S]*?\n\}/);
  ok(fn !== "", "behavior: engSelMigrate extractable");
  const run = (ls: Record<string, string>, catalog: unknown, initSel: Record<string, unknown>) => {
    const f = new Function("localStorage", "ctxs", "activeServerId", "firstOnlineCtx", "initSel",
      "let engSel = initSel; let engSelMigrated = false;\n" + fn +
      "\nengSelMigrate();\nreturn { sel: engSel, migrated: engSelMigrated };");
    const stub = { getItem: (k: string) => (k in ls ? ls[k] : null) }; // getItem 桩（裸对象会抛 TypeError 被 catch 吞）
    return f(stub, new Map([["srv1", { status: "online", engineCatalog: catalog }]]), "srv1", () => null, initSel) as { sel: Record<string, unknown>; migrated: boolean };
  };
  let r = run({ ccd_use_codex: "1" }, [{ id: "claude", state: "ready" }], { engine: "", model: "", manual: false });
  ok(r.sel.engine === "codex" && r.sel.manual === true && r.migrated === true, "migrate: ccd_use_codex=1 + catalog → one-shot engine=codex manual");
  r = run({ ccd_use_codex: "1" }, null, { engine: "", model: "", manual: false });
  ok(r.sel.engine === "" && r.migrated === false, "migrate: old relay (null catalog) → no migration face, checkbox chain untouched");
  r = run({}, [{ id: "claude", state: "ready" }], { engine: "", model: "", manual: false });
  ok(r.sel.engine === "" && r.migrated === true, "migrate: no stored preference → mark migrated, selector stays auto");
  ok(!html.includes('localStorage.removeItem("ccd_use_codex")') && !html.includes("localStorage.removeItem('ccd_use_codex')"), "migrate: stored checkbox memory kept (旧 relay 环境原样消费，兼容期不清除)");
}

// ---- ⑦ syncEngUI 直跑（checkbox 显隐随 catalog；入口被 selector 替代面） ----
{
  const fn = extract(/function syncEngUI\(\) \{[\s\S]*?\n\}/);
  const migFn = extract(/function engSelMigrate\(\) \{[\s\S]*?\n\}/);
  ok(fn !== "", "behavior: syncEngUI extractable");
  const run = (catalog: unknown) => {
    const lbl = { style: {} as Record<string, string> };
    const els: Record<string, { style: Record<string, string>; closest?: () => unknown }> = {
      useCodex: { style: {}, closest: () => lbl },
      engSelRow: { style: {} }, engSum: { style: {} },
      engOver: { style: {} }, engSelBtn: { style: {} }, engUpHint: { style: {} },
    };
    new Function("$", "ctxs", "activeServerId", "firstOnlineCtx", "engSelMigrate", "renderEngSelRow",
      "let engSel = { engine: \"\", model: \"\", manual: false };\n" + fn + "\nreturn syncEngUI();")(
      (id: string) => els[id] ?? null,
      new Map([["srv1", { status: "online", engineCatalog: catalog }]]), "srv1", () => null,
      migFn ? () => {} : () => {}, () => {},
    );
    return lbl;
  };
  ok(run([{ id: "claude", state: "ready" }]).style.display === "none", "sync: catalog present → useCodex label hidden (entry replaced by selector)");
  ok(run(null).style.display === "", "sync: old relay (null) → useCodex label visible (#27 兼容行为零变化)");
}

// ---- ⑧ ACK 失败不建卡不变量沿用 + 降级对照链（成功记账 → SESSION_CREATED 对照标已降级） ----
{
  // 双行锚定位 createBtn 的 waiter（另有单行内联 res 的其他命令 waiter，勿误取——P81-8W 同款）
  const resBlk = blockOf("ackWaiters.set(id, {\n      res: (ack) => {", "t: wd,");
  ok(resBlk.includes("forbiddenZh(ack.error)"), "face2: ACK res routes through forbiddenZh (P81-8W invariant kept)");
  ok(resBlk.includes('"新建会话被拒："'), "face2: forbidden toast prefix present");
  ok(!resBlk.includes("sessions.set") && !resBlk.includes("timelines.set"), "face2: failed ACK adds no local session/timeline (no fake success state)");
  ok(resBlk.includes("reqEngBySid.set(ack.session_id, engField)") && resBlk.includes("ack.ok === true"), "degrade: success ACK books requested engine (failure books nothing)");
  const scBlk = blockOf('case "SESSION_CREATED"', 'case "SESSION_UPDATED"'); // endMark 勿用 SESSION 前缀（自吞）
  ok(scBlk.includes("reqEngBySid.get(sid)") && scBlk.includes("reqEngBySid.delete(sid)"), "degrade: SESSION_CREATED consumes mapping (取账即删)");
  ok(scBlk.includes("engine_degraded") && scBlk.includes('(msg.payload.engine || "claude") !== reqEng'), "degrade: mismatch between requested and actual engine → engine_degraded flag");
  ok(/const badges = \(dormant \?/.test(html) && html.includes('+ (s.engine_degraded ?'), "degrade: badge appended outside the class chain (all four categories can degrade)");
  ok(html.includes('已降级</span>') && html.includes("请求的引擎与实际创建不一致"), "degrade: badge literal + hover explanation");
  const createBlk = blockOf('$("createBtn").onclick', "#168 历史目录");
  ok(createBlk.includes("confirm(") && createBlk.includes("不静默换引擎"), "degrade: default-engine-unavailable requires explicit confirm (PM §6.1)");
  ok(createBlk.includes("engField ? { engine: engField }") && createBlk.includes("modelField ? { model: modelField }") && createBlk.includes("selSource ? { selection_source: selSource }"), "request: engine/model/selection_source carried on COMMAND_CREATE (no new command)");
  ok(createBlk.includes('engField = codex ? "codex" : undefined'), "request: old-relay branch keeps checkbox semantics verbatim (省略 engine)");
  ok(/const cat75 = ctx && Array\.isArray\(ctx\.engineCatalog\) \? ctx\.engineCatalog : null;/.test(createBlk), "request: catalog gate at send site (undefined → checkbox chain)");
}

// ---- ⑨ 结构闸（新函数单定义 + 三弹层互斥 + 表单链 + </html> 后无物） ----
ok(count(html, "function renderEngSelRow") === 1 && count(html, "function syncEngUI") === 1 && count(html, "function resolveEngChoice") === 1 && count(html, "function engSelMigrate") === 1 && count(html, "function renderEngSelPop") === 1 && count(html, "function openEngSelPop") === 1 && count(html, "function closeEngSelPop") === 1, "structure: seven new functions single-defined");
{
  const openBlk = extract(/function openEngSelPop\(\) \{[\s\S]*?\n\}/);
  ok(openBlk.includes("closeModelPop(); closePermPop();"), "structure: popup mutual-exclusion (modelPop/permPop same shell)");
  ok(/window\.addEventListener\("click", \(ev\) => \{[\s\S]*?closeEngSelPop\(\);\n\}, true\);/.test(html), "structure: capture-phase outside-click close");
  const closeForm = extract(/function closeNewForm\(\) \{[\s\S]*?\n\}/);
  ok(closeForm.includes("closeEngSelPop();"), "structure: form close collapses popup (no dangling layer)");
  ok(/syncCwdPick\(\);\n    syncEngUI\(\);/.test(html), "structure: form open chains syncEngUI");
}
ok(html.slice(html.indexOf("</html>") + 7).trim() === "", "structure: nothing after </html>");

console.log(`\n75w-eng-selector: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
