// P81-8W 权限摘要 web-console 呈现：词表字面锚 + undefined 降级锚 + ACK 失败不建卡逻辑面。
// 三面：①设置域源权限摘要（#permPanel，六引擎三态+档集）②开卡 forbidden reason 码人话
// （forbiddenZh + createBtn ACK res）③详情页档位人话条（#permDetail）+ ZCode/unsupported
// 禁选位（updateEngineOpt）。词表字面钉死（specs/081；与 expo 线同段，改字面必三端同步）。
// 直跑：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-p81-8w-perm-web.ts
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

console.log("== P81-8W permission summary web: static anchors + behavior ==");

// ---- ① 词表字面锚（specs/081 钉死，逐词 verbatim——改字面须三端同步，此处即闸） ----
{
  const capTbl = extract(/const CAP_STATE_LABEL = \{[\s\S]*?\};/);
  ok(capTbl.includes('confirmed: "完整支持"'), "vocab: confirmed=完整支持");
  ok(capTbl.includes('unverified: "未验证 · 请求档可能降级"'), "vocab: unverified=未验证 · 请求档可能降级");
  ok(capTbl.includes('unsupported: "不支持 · 不可开卡"'), "vocab: unsupported=不支持 · 不可开卡");
  const modeTbl = extract(/const PERM_MODE_ZH = \{[\s\S]*?\};/);
  ok(modeTbl.includes('default: "每次询问"') && modeTbl.includes('ask: "每次询问"'), "vocab: default/ask=每次询问");
  ok(modeTbl.includes('acceptEdits: "自动接受编辑"') && modeTbl.includes('"edit-auto": "自动接受编辑"'), "vocab: acceptEdits/edit-auto=自动接受编辑");
  ok(modeTbl.includes('plan: "计划模式"'), "vocab: plan=计划模式");
  ok(modeTbl.includes('bypassPermissions: "完全自动"') && modeTbl.includes('"full-auto": "完全自动"'), "vocab: bypassPermissions/full-auto=完全自动");
  ok(modeTbl.includes('forbidden: "已拒绝"'), "vocab: forbidden=已拒绝");
  const fTbl = extract(/const FORBIDDEN_ZH = \{[\s\S]*?\};/);
  ok(fTbl.includes("capability_state_missing: \"引擎能力未确认，已降为每次询问\""), "vocab: capability_state_missing");
  ok(fTbl.includes("unknown_requested_mode: \"未知权限档\""), "vocab: unknown_requested_mode");
  ok(fTbl.includes("unknown_engine: \"未知引擎\""), "vocab: unknown_engine");
  ok(fTbl.includes("zcode_fail_closed: \"该引擎不支持权限控制\""), "vocab: zcode_fail_closed");
  ok(fTbl.includes("above_role_tier_ceiling: \"超出岗位权限上限\""), "vocab: above_role_tier_ceiling");
  ok(fTbl.includes("production_bypass_denied: \"生产环境禁止完全自动档\""), "vocab: production_bypass_denied");
  ok(fTbl.includes("env_unknown_bypass_denied: \"环境不明，禁止完全自动档\""), "vocab: env_unknown_bypass_denied");
  ok(fTbl.includes("unknown_role_mapping: \"岗位未映射，已拒绝\""), "vocab: unknown_role_mapping");
  ok(fTbl.includes("mixed_engine: \"混编引擎，按保守档\""), "vocab: mixed_engine");
  ok(count(html, "const FORBIDDEN_ZH") === 1 && count(html, "const CAP_STATE_LABEL") === 1 && count(html, "const PERM_MODE_ZH") === 1, "vocab: three tables single-defined");
}

// ---- ② SNAPSHOT 消费 + undefined 降级锚（旧 relay 不发 → 整区隐藏不白屏） ----
{
  ok(/ctx\.permCaps = Array\.isArray\(msg\.payload\.source_capabilities\?\.permission\) \? msg\.payload\.source_capabilities\.permission : null;/.test(html), "SNAPSHOT: permCaps field-existence consumption (undefined → null)");
  ok(/permCaps: null, \/\/ P81-8W/.test(html), "ensureCtx: permCaps init null");
  const snapBlk = blockOf("ctx.permCaps = Array.isArray", "ctx.orgConfirms");
  ok(snapBlk.includes("renderPermSummary();") && snapBlk.includes("updateEngineOpt();"), "SNAPSHOT: summary + engine-opt refresh chained");
  ok(/if \(selected && selected\.src === ctx\.cfg\.id\) renderDetail\(\);/.test(snapBlk), "SNAPSHOT: open detail re-renders on summary flip (no stale dot)");
  ok(/<div class="panel" id="permPanel" style="display:none"><\/div>/.test(html), "face1: #permPanel default hidden");
  ok(/<div id="permDetail" style="display:none"><\/div>/.test(html), "face3: #permDetail default hidden");
  ok(html.indexOf('id="permPanel"') > html.indexOf('id="gpStatus"') && html.indexOf('id="permPanel"') < html.indexOf('id="connPanel"'), "face1: #permPanel between status card and conn panel");
  ok(html.indexOf('id="permDetail"') > html.indexOf('id="permBtn"') && html.indexOf('id="permDetail"') < html.indexOf('id="waitbox"'), "face3: #permDetail between detail head and waitbox");
}

// ---- ③ 面① renderPermSummary 直跑（真词表+真 escapeHtml 提取，桩 $/gpStatusCtx） ----
{
  const fn = extract(/function renderPermSummary\(\) \{[\s\S]*?\n\}/);
  const capTbl = extract(/const CAP_STATE_LABEL = \{[\s\S]*?\};/);
  const modeTbl = extract(/const PERM_MODE_ZH = \{[\s\S]*?\};/);
  const esc = extract(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
  ok(fn !== "" && capTbl !== "" && modeTbl !== "" && esc !== "", "behavior: renderPermSummary extractable with real vocab");
  const RELAY_CAPS = [ // relay permissionCapabilitiesSummary() 真形状（六注册引擎）
    { engine: "claude", capability_state: "confirmed", modes: ["ask", "plan", "edit-auto", "full-auto"] },
    { engine: "codex", capability_state: "unverified", modes: ["ask", "plan"] },
    { engine: "trae", capability_state: "unverified", modes: ["ask", "plan"] },
    { engine: "qwen-code", capability_state: "unverified", modes: ["ask", "plan"] },
    { engine: "codebuddy", capability_state: "unverified", modes: ["ask", "plan"] },
    { engine: "zcode", capability_state: "unsupported", modes: [] },
  ];
  const mkEl = () => ({ style: {} as Record<string, string>, innerHTML: "" });
  const mkRun = (ctxMock: unknown) => new Function(
    "$", "gpStatusCtx", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermSummary;",
  )(
    (id: string) => (id === "permPanel" ? mkEl() : null),
    () => ctxMock,
  );
  const el = mkEl();
  const runOnline = new Function(
    "$", "gpStatusCtx", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermSummary;",
  )(
    (id: string) => (id === "permPanel" ? el : null),
    () => ({ status: "online", permCaps: RELAY_CAPS }),
  );
  runOnline();
  ok(el.style.display === "" && el.innerHTML.includes("引擎权限能力"), "behavior: online+caps → panel shown with title");
  for (const eng of ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"]) {
    ok(el.innerHTML.includes(eng), "behavior: six engines listed (" + eng + ")");
  }
  ok(el.innerHTML.includes("完整支持") && el.innerHTML.includes("未验证 · 请求档可能降级") && el.innerHTML.includes("不支持 · 不可开卡"), "behavior: three state labels rendered");
  ok(el.innerHTML.includes("每次询问 / 计划模式 / 自动接受编辑 / 完全自动"), "behavior: confirmed modes mapped to unified wording");
  ok(!/(^|>)ask<|edit-auto|full-auto</.test(el.innerHTML), "behavior: no raw normalized codes leak (ask/edit-auto/full-auto mapped)");
  ok(el.innerHTML.includes("perm-dot unsupported") && el.innerHTML.includes("perm-dot confirmed") && el.innerHTML.includes("perm-dot unverified"), "behavior: three-state dots carried");
  const elHide = mkEl();
  const runNull = new Function(
    "$", "gpStatusCtx", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermSummary;",
  )(
    (id: string) => (id === "permPanel" ? elHide : null),
    () => ({ status: "online", permCaps: null }),
  );
  runNull();
  ok(elHide.style.display === "none" && elHide.innerHTML === "", "behavior: old relay (permCaps null) → whole panel hidden");
  const elOff = mkEl();
  new Function(
    "$", "gpStatusCtx", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermSummary;",
  )(
    (id: string) => (id === "permPanel" ? elOff : null),
    () => ({ status: "connecting", permCaps: RELAY_CAPS }),
  )();
  ok(elOff.style.display === "none", "behavior: non-online source → panel hidden");
  const elOdd = mkEl();
  new Function(
    "$", "gpStatusCtx", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermSummary;",
  )(
    (id: string) => (id === "permPanel" ? elOdd : null),
    () => ({ status: "online", permCaps: [null, { engine: 42, capability_state: "confirmed" }, { engine: "claude", capability_state: "confirmed", modes: "x" }] as unknown[] }),
  )();
  ok(elOdd.innerHTML.includes("claude") && !elOdd.innerHTML.includes("42"), "behavior: malformed entries skipped, modes non-array tolerated");
}

// ---- ④ 面② forbiddenZh 直跑 + ACK 失败不建卡逻辑面 ----
{
  const fn = extract(/function forbiddenZh\(error\) \{[\s\S]*?\n\}/);
  const fTbl = extract(/const FORBIDDEN_ZH = \{[\s\S]*?\};/);
  ok(fn !== "", "behavior: forbiddenZh extractable");
  const run = (error: unknown) => new Function("error", fTbl + "\n" + fn + "\nreturn forbiddenZh(error);")(error) as string | null;
  ok(run("forbidden: production_bypass_denied") === "生产环境禁止完全自动档", "behavior: production_bypass_denied mapped");
  ok(run("forbidden:env_unknown_bypass_denied") === "环境不明，禁止完全自动档", "behavior: no-space prefix also parsed");
  ok(run("forbidden: zcode_fail_closed") === "该引擎不支持权限控制", "behavior: zcode_fail_closed mapped");
  ok(run("forbidden: above_role_tier_ceiling") === "超出岗位权限上限", "behavior: above_role_tier_ceiling mapped");
  ok(run("forbidden: capability_state_missing") === "引擎能力未确认，已降为每次询问", "behavior: capability_state_missing mapped");
  ok(run("forbidden: unknown_requested_mode") === "未知权限档", "behavior: unknown_requested_mode mapped");
  ok(run("forbidden: unknown_engine") === "未知引擎", "behavior: unknown_engine mapped");
  ok(run("forbidden: unknown_role_mapping") === "岗位未映射，已拒绝", "behavior: unknown_role_mapping mapped");
  ok(run("forbidden: mixed_engine") === "混编引擎，按保守档", "behavior: mixed_engine mapped");
  ok(run("forbidden: some_future_code") === null, "behavior: unlisted code → null (caller falls back to raw error)");
  ok(run("未知引擎: zcode") === null && run("ok") === null && run(null) === null && run(undefined) === null, "behavior: non-forbidden / non-string errors → null");
  // ACK 失败不建卡：res 块只 toast，零本地会话簿记（卡片唯一入口=SESSION_CREATED 帧）。
  // 双行锚定位 createBtn 的 waiter（:4438 另有单行内联 res 的其他命令 waiter，勿误取）
  const resBlk = blockOf("ackWaiters.set(id, {\n      res: (ack) => {", "t: wd,");
  ok(resBlk.includes("forbiddenZh(ack.error)"), "face2: ACK res routes through forbiddenZh");
  ok(resBlk.includes('"新建会话被拒："'), "face2: forbidden toast prefix present");
  ok(resBlk.includes("新建会话失败: "), "face2: non-forbidden errors keep raw-error fallback");
  ok(!resBlk.includes("sessions.set") && !resBlk.includes("timelines.set"), "face2: failed ACK adds no local session/timeline (no fake success state)");
  ok(/卡片只由 SESSION_CREATED 帧建立/.test(resBlk), "face2: no-fake-success invariant documented at site");
}

// ---- ⑤ 面③ renderPermDetail 直跑（档位人话 + 引擎能力；旧 relay 缺摘要只显示档位行） ----
{
  const fn = extract(/function renderPermDetail\(s, ctx\) \{[\s\S]*?\n\}/);
  const capTbl = extract(/const CAP_STATE_LABEL = \{[\s\S]*?\};/);
  const modeTbl = extract(/const PERM_MODE_ZH = \{[\s\S]*?\};/);
  const esc = extract(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
  ok(fn !== "", "behavior: renderPermDetail extractable");
  const mkRun = (s: Record<string, unknown>, ctxMock: unknown) => {
    const el = { style: {} as Record<string, string>, innerHTML: "" };
    const f = new Function(
      "s", "ctx", "$", capTbl + "\n" + modeTbl + "\n" + esc + "\n" + fn + "\nreturn renderPermDetail;",
    )(s, ctxMock, (id: string) => (id === "permDetail" ? el : null));
    f(s, ctxMock);
    return el;
  };
  const caps = [{ engine: "codex", capability_state: "unverified", modes: ["ask", "plan"] }];
  const e1 = mkRun({ permission_mode: "bypassPermissions", engine: "codex" }, { permCaps: caps });
  ok(e1.innerHTML.includes("权限档：<b>完全自动</b>"), "behavior: bypassPermissions → 完全自动");
  ok(e1.innerHTML.includes("引擎 codex：未验证 · 请求档可能降级"), "behavior: engine capability appended when summary present");
  ok(e1.innerHTML.includes("perm-dot unverified"), "behavior: state dot carried");
  const e2 = mkRun({ permission_mode: "bypassPermissions", engine: "codex" }, { permCaps: null });
  ok(e2.innerHTML.includes("完全自动") && !e2.innerHTML.includes("perm-dot") && e2.innerHTML.includes("引擎 codex"), "behavior: old relay → mode row only, no capability part, no blank screen");
  const e3 = mkRun({}, { permCaps: undefined });
  ok(e3.innerHTML.includes("权限档：<b>每次询问</b>") && e3.innerHTML.includes("引擎 claude"), "behavior: missing mode/engine → default 每次询问 + claude");
  const e4 = mkRun({ permission_mode: "forbidden" }, null);
  ok(e4.innerHTML.includes("权限档：<b>已拒绝</b>"), "behavior: forbidden vocabulary reachable");
  const e5 = mkRun({ permission_mode: "plan", engine: "zcode" }, { permCaps: [{ engine: "zcode", capability_state: "unsupported", modes: [] }] });
  ok(e5.innerHTML.includes("计划模式") && e5.innerHTML.includes("不支持 · 不可开卡"), "behavior: zcode unsupported state surfaced");
}

// ---- ⑥ updateEngineOpt 直跑（ZCode/unsupported 禁选+原因；摘要缺席开关照旧） ----
{
  const fn = extract(/function updateEngineOpt\(\) \{[\s\S]*?\n\}/);
  const capTbl = extract(/const CAP_STATE_LABEL = \{[\s\S]*?\};/);
  const esc = extract(/function escapeHtml\(s\) \{[\s\S]*?\n\}/);
  ok(fn !== "", "behavior: updateEngineOpt extractable");
  const mk = () => ({ disabled: false, innerHTML: "", textContent: "" });
  const mkRun = (permCaps: unknown) => {
    const box = mk(), cap = mk();
    const els: Record<string, typeof box> = { useCodex: box, codexCap: cap };
    const ctxs = new Map<string, unknown>([["srv1", { permCaps }]]);
    new Function(
      "$", "ctxs", "activeServerId", "firstOnlineCtx", capTbl + "\n" + esc + "\n" + fn + "\nreturn updateEngineOpt;",
    )(
      (id: string) => els[id] ?? null, ctxs, "srv1", () => null,
    )();
    return { box, cap };
  };
  let r = mkRun([{ engine: "zcode", capability_state: "unsupported", modes: [] }, { engine: "codex", capability_state: "unsupported", modes: [] }]);
  ok(r.box.disabled === true && r.cap.innerHTML.includes("不支持 · 不可开卡"), "behavior: unsupported codex → disabled + reason shown");
  r = mkRun([{ engine: "codex", capability_state: "unverified", modes: ["ask", "plan"] }]);
  ok(r.box.disabled === false && r.cap.innerHTML.includes("未验证 · 请求档可能降级"), "behavior: unverified codex → selectable + downgrade hint");
  r = mkRun(null);
  ok(r.box.disabled === false && r.cap.innerHTML === "", "behavior: old relay (null caps) → checkbox unchanged, chip cleared");
  r = mkRun([{ engine: "claude", capability_state: "confirmed", modes: [] }]);
  ok(r.box.disabled === false && r.cap.innerHTML === "", "behavior: no codex entry → chip cleared, checkbox selectable");
  ok(/<span id="codexCap"><\/span>/.test(html), "face-opt: #codexCap chip present in engine label");
}

// ---- ⑦ 结构闸（新 id 唯一 + 面板归属 + 既有控制面零重写） ----
ok(count(html, 'id="permPanel"') === 1 && count(html, 'id="permDetail"') === 1 && count(html, 'id="codexCap"') === 1, "structure: three new ids unique");
ok(count(html, "function renderPermSummary") === 1 && count(html, "function renderPermDetail") === 1 && count(html, "function updateEngineOpt") === 1 && count(html, "function forbiddenZh") === 1, "structure: four new functions single-defined");
// PERM-SYNC（P81-8W 备案⑥裁定执行）：旧 PERM_LABEL 四档词已删，档位人话单一词表源=PERM_MODE_ZH
//（钉死词表双键同表）。断言收消费/定义形式清零（注释溯源提及「旧 PERM_LABEL 已删」允许存在）；
// 旧四档词「标准/自动编辑/规划/跳过」清零——「跳过」裸字有合法他用（确认跳过按钮/跳过权限确认
// checkbox），断言锁引号值形式；forbidden 档呈现「已拒绝」可达，选择面 PERM_CYCLE 四键不含
// forbidden = 结构性不可选（终态不可切回）。
ok(count(html, "const PERM_LABEL") === 0 && count(html, "PERM_LABEL[") === 0, "permsync: legacy PERM_LABEL zeroed (no def, no consumer)");
ok(count(html, "自动编辑") === 0 && count(html, "权限·标准") === 0 && count(html, '"规划"') === 0 && count(html, '"跳过"') === 0, "permsync: legacy four-mode wording zeroed (quoted-value form)");
ok(/PERM_MODE_ZH\[pm\] \?\? pm/.test(html) && /PERM_MODE_ZH\[m\]/.test(html) && /PERM_MODE_ZH\[s\.permission_mode \?\? "default"\]/.test(html), "permsync: all mode-label consumers route through PERM_MODE_ZH");
ok(html.includes("权限·每次询问"), "permsync: permBtn initial literal = 钉死词表 default 档");
ok(count(html, 'id="permBtn"') === 1 && count(html, "const PERM_CYCLE") === 1, "structure: existing #permBtn switch control untouched");
ok(html.slice(html.indexOf("</html>") + 7).trim() === "", "structure: nothing after </html>");

console.log(`\np81-8w-perm-web: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
