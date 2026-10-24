// [t-7e0c6189] 会话列表瘦身——worker 收进团队域：静态锚 + 纯函数直跑 + 结构闸。
// 靶子 web-console/index-005.html（产品真身；范式同 test-005-parity.ts B 段 / test-005-ui-rows.ts ⑨ 段）。
// 覆盖：
//   §A 过滤口径直跑（PM/Leader 直列、worker/qa/reviewer 收起、置顶例外、无编制直连、选中临时出列、跨团归属）
//   §B CSS 四件（团队入口卡 / 第四列 team-drawer + 检查器收起联动 / 成员卡可直开 / 检查器成员胶囊）
//   §C 列表渲染链（过滤接线 / _slimHiddenIds 记账 / 团队小节 / 组装顺序）
//   §D MutationObserver 放行 + 选中变化重渲（临时出列/切走收回）
//   §E 帧链（PROJECTS_UPDATED case + 快照锚定守卫 + onLog 未读聚合 + SNAPSHOT 未读重置/drawer 恢复）
//   §F 直开路径（SlimUi 暴露 / 团队域成员卡 click→railJump+open / select→markSeen）
//   §G 检查器团队块 + 第四列（胶囊直开 / 展开链 / drawer 卡 data-slim-open / 走秒 / localStorage 记忆）
//   §H 结构闸（div 平衡 / 六内联块编译 / 新增 CSS 块零裸色值）
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-session-slim.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");
// W-WXSTYLE 顺手跟锚（S4b 遗留基线债）：JS 块已外置 js/session-domain.js——fnBody/
// jsConst 的 JS 抽取改读该源（html 已无内联脚本；主仓同崩实证=既有非新引入）
const sessionSrc = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");

// W-SPLIT-S4a：CSS 外置跟锚——cssBlock/CSS 串断言改读 css/{tokens,base}.css（html 内 <style> 已退役）
const css = readFileSync(join(root, "web-console", "css", "tokens.css"), "utf-8") + readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

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
function fnBody(name: string): string {
  const i = sessionSrc.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const j = sessionSrc.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < sessionSrc.length; k++) {
    if (sessionSrc[k] === "{") depth++;
    else if (sessionSrc[k] === "}") { depth--; if (depth === 0) return sessionSrc.slice(i, k + 1); }
  }
  return "";
}
function jsConst(name: string): string {
  const i = sessionSrc.indexOf(`const ${name} = `);
  if (i < 0) return "";
  const end = sessionSrc.indexOf("\n", i);
  return sessionSrc.slice(i, end);
}
function cssBlock(selector: string): string {
  const i = css.indexOf(selector + " {");
  if (i < 0) return "";
  const j = css.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < css.length; k++) {
    if (css[k] === "{") depth++;
    else if (css[k] === "}") { depth--; if (depth === 0) return css.slice(j, k + 1); }
  }
  return "";
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const BARE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

console.log("== [t-7e0c6189] session list slim: worker sessions fold into team domain ==");

// ---- §T W-TEAMSNC（2026-10-24 一期：chip 点亮+厚抽屉）----
console.log("-- §T W-TEAMSNC chip data chain + thick drawer");
const chipFn = fnBody("pmTeamChipOf");
ok(chipFn.includes("out.push({ gid: p.id") && chipFn.includes('=== "archived"') && chipFn.includes("idle: running === 0"), "pmTeamChipOf returns team array [{gid,name,accent,idle}] (多团队多枚 chip)；archived 退役（E4）+全闲置灰（E5）");
ok(sessionSrc.includes('data-team-chip="' + "' + esc(t.gid)") && sessionSrc.includes("✦ ") && stripComments(sessionSrc).includes('const teamChip = ev.target.closest("[data-team-chip]");'), "chip is a button (data-team-chip) with ✦ badge; delegated click opens drawer with stopPropagation (srow-more precedent)");
ok(sessionSrc.includes('headTeams.map(teamChipMarkup)') && fnBody("renderHeader").includes("identity"), "detail head identity-cluster carries same chip (③，null 不占位)");
ok(sessionSrc.includes('case "BOARD_UPDATED"') && fnBody("onSnapshot").includes("p.boards"), "BOARD_UPDATED frame + SNAPSHOT.boards consumed (drawer 在办概览，S.boards 唯一新消费点)");
ok(sessionSrc.includes("syncDrawerOverlay") && css.includes(".desktop-screen.drawer-overlay .team-drawer { right: 0; z-index: 5; }") && css.includes(".drawer-mask"), "docked(≥1360)/overlay(<1360)+mask dual form (B 稿共存矩阵)");
// 纯函数直跑：teamDrawerModelOf（拼装模型单测锚——板缺席降级/泳道归并/在办计数/roster 排序）
const lanesConst = jsConst("TEAM_DRAWER_LANES");
const legacyConst = jsConst("TEAM_DRAWER_LEGACY");
const modelFn = fnBody("teamDrawerModelOf");
const sortFn = fnBody("teamDrawerRosterSort");
ok(lanesConst !== "" && legacyConst !== "" && modelFn !== "" && sortFn !== "", "teamDrawerModelOf pure functions extracted for direct run");
const keepRoleSrcT = jsConst("SLIM_KEEP_ROLE"); // §T 自取（§A 的 keepRoleSrc 声明在后，前置引用 TDZ 崩）
const drawerFx = new Function(`${keepRoleSrcT}\n${lanesConst}\n${legacyConst}\n${modelFn}\n${sortFn}\nreturn { teamDrawerModelOf, teamDrawerRosterSort };`)() as {
  teamDrawerModelOf: (t: unknown, b: unknown, m: Map<string, unknown>) => Record<string, unknown>;
  teamDrawerRosterSort: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
};
const sess = new Map([["pm1", { status: "WORKING", title: "PM 会话", context_usage: 50000, context_limit: 1000000, artifacts: [{ path: "/a/w-teamsync.md", last_at: 20 }] }], ["w1", { status: "DONE", title: "worker1", artifacts: [] }], ["w2", { status: "WORKING", title: "worker2", context_usage: 900000, context_limit: 1000000, artifacts: [{ path: "/a/fix.md", last_at: 10 }] }]]);
const teamFx = { id: "g1", name: "矩阵团队", members: [{ session_id: "w1", role: "worker" }, { session_id: "w2", role: "worker" }, { session_id: "pm1", role: "pm" }, { session_id: "x9", role: "观察员" }] };
const md = drawerFx.teamDrawerModelOf(teamFx, [
  { status: "todo", text: "legacy 待办" }, { status: "claimed", text: "进行中", gate: { reason: "等 Leader" } },
  { status: "done", text: "完成" }, { status: "submitted", text: "待审" },
], sess) as { rosterN: number; running: number; roster: { sid: string; pm: boolean; online: boolean }[]; lanes: { k: string; n: number }[]; activeN: number; keyTasks: unknown[]; artsCount: number; recentArts: { path: string }[] };
ok(md.rosterN === 4 && md.running === 2, `model counts roster/running (got ${md.rosterN}/${md.running})`);
ok(md.lanes.find((l) => l.k === "backlog")?.n === 1 && md.lanes.find((l) => l.k === "claimed")?.n === 1 && md.lanes.find((l) => l.k === "done")?.n === 1, "legacy todo/doing fold into five-lane vocabulary");
ok(md.activeN === 3 && md.keyTasks.length === 1, "active = four unfinished lanes; gate entries surface as key tasks (≤3)");
ok(md.artsCount === 2 && md.recentArts[0].path.endsWith("w-teamsync.md"), "artifacts aggregated cross-member, latest first");
const sorted = md.roster.slice().sort(drawerFx.teamDrawerRosterSort);
ok(sorted[0].sid === "pm1" && sorted[0].pm === true && md.roster.find((r) => r.sid === "x9")?.online === false, "roster sort: PM first; unsynced member stays as offline row (不隐行)");
const mdNoBoard = drawerFx.teamDrawerModelOf(teamFx, null, sess) as { lanes: null; running: number };
ok(mdNoBoard.lanes === null && mdNoBoard.running === 2, "boardEntries=null → lanes null (板未同步降级，不伪造 0/0/0)；running 无板依赖");
const mdEmpty = drawerFx.teamDrawerModelOf(null, [], sess) as { rosterN: number; name: string };
ok(mdEmpty.rosterN === 0 && mdEmpty.name === "", "null team degrades to empty model (defensive)");

// ---- §A 过滤口径直跑（纯函数：SLIM_KEEP_ROLE + slimRosterOf + slimIsHidden）----
console.log("-- §A filter semantics (direct run)");
const keepRoleSrc = jsConst("SLIM_KEEP_ROLE");
const rosterSrc = fnBody("slimRosterOf");
const hiddenSrc = fnBody("slimIsHidden");
ok(keepRoleSrc !== "" && rosterSrc !== "" && hiddenSrc !== "", "slim pure functions extracted for direct run");
const slim = new Function(`${keepRoleSrc}\n${rosterSrc}\n${hiddenSrc}\nreturn { slimRosterOf, slimIsHidden };`)() as {
  slimRosterOf: (p: unknown[]) => { bySid: Map<string, { gid: string; role: string }>; teams: Map<string, { id: string; name: string; members: unknown[] }> };
  slimIsHidden: (s: Record<string, unknown> | null, r: { bySid: Map<string, unknown> }, sel: string) => boolean;
};
const rosterFx = slim.slimRosterOf([
  { id: "g1", name: "矩阵团队", headcount: [
    { session_id: "pm1", role: "pm" }, { session_id: "ld1", role: "Leader" },
    { session_id: "w1", role: "worker" }, { session_id: "qa1", role: "QA" }, { session_id: "rv1", role: "reviewer" },
  ] },
  { id: "g2", name: "夜巡团队", headcount: [{ session_id: "w2", role: "执行者" }] },
  { id: "bad", name: "无编制" }, { name: "无 id 团" }, null,
]);
ok(rosterFx.teams.size === 2 && rosterFx.bySid.size === 6, "roster builds team/member index, skips empty-or-invalid projects");
ok(rosterFx.bySid.get("w2")?.gid === "g2" && rosterFx.bySid.get("pm1")?.gid === "g1", "roster maps member sid to owning team gid");
const mkS = (sid: string, pinned = false) => ({ session_id: sid, pinned });
ok(slim.slimIsHidden(mkS("pm1"), rosterFx, "") === false && slim.slimIsHidden(mkS("ld1"), rosterFx, "") === false, "pm/leader sessions stay listed (case-insensitive role)");
ok(slim.slimIsHidden(mkS("w1"), rosterFx, "") === true && slim.slimIsHidden(mkS("qa1"), rosterFx, "") === true && slim.slimIsHidden(mkS("rv1"), rosterFx, "") === true && slim.slimIsHidden(mkS("w2"), rosterFx, "") === true, "worker/qa/reviewer/plain-role member sessions fold away");
ok(slim.slimIsHidden(mkS("w1", true), rosterFx, "") === false, "pinned worker session stays listed (user pin overrides IA rule)");
ok(slim.slimIsHidden(mkS("free1"), rosterFx, "") === false, "rosterless (direct) session stays listed");
ok(slim.slimIsHidden(mkS("w1"), rosterFx, "w1") === false && slim.slimIsHidden(mkS("w1"), rosterFx, "pm1") === true, "selected worker session temporarily listed (direct-chat), re-folds when selection moves on");
ok(slim.slimIsHidden(null, rosterFx, "") === false, "null session is never hidden (defensive)");

// ---- §B CSS 四件 ----
console.log("-- §B css anchors");
const entryCss = cssBlock(".team-entry");
/* #193 顺手清债：team-entry 卡断言删除——.team-entry 选择器随 #103 团队域两段式重排退役（css/js 双源不存在） */
const drawerCss = cssBlock(".team-drawer");
ok(drawerCss.includes("position: absolute") && drawerCss.includes("width: 296px") && css.includes(".team-drawer.open {") && css.includes(".desktop-screen.inspector-collapsed .team-drawer { right: 42px; }"), "team-drawer is an overlay fourth column (W-TEAMSNC ④ 296px + .open transition), re-anchors when inspector collapses"); // W-TEAMSNC ④：248→296 + class 动效（.open 是独立规则，断言走全量 css 非 drawerCss 单块）
ok(cssBlock(".member-card[data-team-member-session]").includes("cursor: pointer") && css.includes('.member-card[data-team-member-session]::after { content: "↗ 直开"'), "team-domain member card hover reveals direct-open affordance");
ok(cssBlock(".member-chips").includes("flex-wrap") && cssBlock(".member-chip .mc-ava").includes("border-radius: 50%") && cssBlock(".t-expand.has-unread::after").includes("animation: slimPulseKf"), "inspector member chips + unread pulse styles exist (V8R+ ③未读点迁 t-expand 角标)");

// ---- §C 列表渲染链 ----
console.log("-- §C render chain");
ok(sessionSrc.includes("const slimRoster = slimRosterOf(S.projects);") && sessionSrc.includes(".filter((x) => (pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x) && slimVisible(x))") && sessionSrc.includes("const slimVisible = (x) => !slimIsHidden(x, slimRoster, S.selected);"), "renderMyList pipes sessions through slim filter");
ok(sessionSrc.includes("const pinnedKeep = (x) => x.pinned === true;") && sessionSrc.includes(".filter((x) => isLeaderSession(x) || !((pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x)))"), "1015 pinned keep: pinned cards exempt from status filter (always rendered, pinned-first top); filterHidden ledger shares the same predicate so observer amnesty stays exact"); /* W-TS63FIX 顺手修锚：预存红——W-LEADERHIDE 批给 filterHidden 加 isLeaderSession 前缀后锚未跟（pinned 豁免语义未丢，stash 实证与 TS63 改动无关） */
ok(sessionSrc.includes("S._slimHiddenIds = slimHiddenIds.length ? new Set(slimHiddenIds) : null;"), "hidden sids recorded for observer amnesty (same FB17 discipline)");
ok(sessionSrc.includes("const gidForFrame = S.drawerGid;") && sessionSrc.includes("if (S.drawerGid && S.drawerGid === gidForFrame) el.classList.add(\"open\");"), "W-TS63FIX P3-1: rAF open guard—same-frame close cannot ghost-open cleared drawer");
ok((() => { const b = fnBody("renderSlimDrawer"); return b.includes("scrollTop") && b.includes("data-slim-open") && b.includes("aeAnchor"); })(), "W-TS63FIX P2-2: drawer re-render preserves scrollTop + re-focuses active roster row by sid anchor");
ok((() => { const b = fnBody("slimToggleDrawer"); return b.includes("renderHeader()") && b.includes("[data-team-chip=\"") && b.includes("chipAgain"); })(), "W-TS63FIX P3-2: toggle re-renders header (head-chip aria sync) + restores focus to same-gid chip");
ok((() => { const b = fnBody("slimRosterOf"); return b.includes("archived"); })(), "W-TS63FIX P2-1: slimRosterOf filters archived teams (chip/dock/drawer/fold four-face gate alignment)");
ok((() => { const b = fnBody("teamDrawerMarkup"); return b.includes("d-stale") && b.includes("离线·陈旧"); })(), "W-TS63FIX P3-3: drawer-head stale badge when offline (S.status!=online)");
ok(sessionSrc.includes('data-group-toggle="slim-teams"') && sessionSrc.includes("<span>team</span>") && sessionSrc.includes("session-group teams-dock") && css.includes(".session-group.teams-dock {") && css.includes(".teams-dock .dock-lamp"), "team dock renders as bottom pane with collapsible head (#103: title \"team\", status-bar collapse, B11 toggle reuse)");
ok(sessionSrc.includes("tpl.innerHTML = pinnedMarkup + activeMarkup + idleMarkup;") && sessionSrc.includes("mountTwoPane(tpl.content);") && sessionSrc.includes('upper.className = "list-upper";'), "list assembly: two-pane (#103) — upper sessions pane, dock below");
ok(fnBody("slimTeamEntryMarkup").includes('const isAllFilter = !filterDef || filterDef.id === "all";') && fnBody("slimTeamEntryMarkup").includes("if (!hit.length && (!isAllFilter || !team.members.length)) return \"\";") && fnBody("slimTeamEntryMarkup").includes("const rosterN = team.members.length;"), "team card for roster-present teams (#99-5: unsynced/PM-only included on all-filter via id check, filter purity kept) + roster headcount counting (#99-6)");

// ---- §D MutationObserver 放行 + 选中联动 ----
console.log("-- §D observer integration");
ok(count(sessionSrc, "S._slimHiddenIds && S._slimHiddenIds.has(k)") === 1 && sessionSrc.includes("&& !(S._slimHiddenIds && S._slimHiddenIds.size > 0)"), "completeness check amends slim-hidden set (miss-loop guard, both empty-list and per-sid)");
ok(sessionSrc.includes("renderMyList(); // [t-7e0c6189] 选中进出 worker 会话时出列/收回要跟着换"), "selection change re-renders list (temporary listing folds back)");

// ---- §E 帧链 ----
console.log("-- §E frame wiring");
ok(sessionSrc.includes('case "PROJECTS_UPDATED": onProjectsUpdated(m.payload || {}); break;'), "session domain handles PROJECTS_UPDATED (roster stays fresh without full SNAPSHOT)");
const projFn = fnBody("onProjectsUpdated");
ok(projFn.includes("if (!S.hasSnapshot) return;") && projFn.includes("p.delta.upserts") && projFn.includes("p.delta.removes") && projFn.includes("Array.isArray(p.groups)"), "projects delta merges with snapshot-anchor guard (#143 C-3 discipline)");
const logFn = fnBody("onLog");
ok(logFn.includes("S.slimUnread.get(m.gid)") && logFn.includes("!SLIM_KEEP_ROLE.test(m.role)") && logFn.includes("sid !== S.selected"), "SESSION_LOG from unseen foldable member records team unread");
const snapFn = fnBody("onSnapshot");
ok(snapFn.includes("S.slimUnread = new Map();") && snapFn.includes('localStorage.getItem("cc-deck-005-slim-drawer")'), "snapshot resets unread (replay no backfill) and restores drawer gid");

// ---- §F 直开路径 ----
console.log("-- §F direct-open path");
ok(sessionSrc.includes("window.__ccDeck005SlimUi = Object.freeze({ open: slimOpenSession, markSeen: slimMarkSeen, toggleDrawer: slimToggleDrawer, selectedSid: () => S.selected })"), "slim UI api exposed cross-domain (W-TEAMSNC ① +selectedSid：建团表单 PM 带队档取当前选中会话)");
const openFn = fnBody("slimOpenSession");
ok(openFn.includes("inputDrafts.set(S.selected, UI.input.value)") && openFn.includes("renderMyList(); // 直聊中的 worker 会话临时出列") && openFn.includes("b2Toast(\"成员会话不在当前来源\")"), "direct-open reuses selection chain: drafts, temporary listing, missing-session toast");
const memberAnchor = `data-team-member-session="' + escape(member.session_id)`;
/* #193 顺手清债：member-card 直开断言删除——data-team-member-session 锚随 #103 团队域改版退役（css/js 双源不存在） */
/* #193 顺手清债：team select 清未读断言删除——markSeen?.(gid) 调用形态随团队域改版退役 */
ok(sessionSrc.includes("slimMarkSeen(gid); // 进团队域即清未读") && sessionSrc.includes('window.__ccDeck005B4?.railJump?.("team");'), "team entry click: mark seen + jump to team domain");

// ---- §G 检查器团队块 + 第四列 ----
console.log("-- §G inspector block + fourth column");
const inspFn = fnBody("renderInspector");
ok(inspFn.includes("slim-team-block") && inspFn.includes("团队成员 · ") && inspFn.includes("data-slim-open=") && inspFn.includes("团队信息 ⤢"), "inspector renders team-member block with chips + drawer link for rostered session (W-TEAMSNC ④ 链接文案随厚抽屉升级)");
ok(inspFn.includes('class="member-chip' + "' + (unread ? \" unread\" : \"\")") || inspFn.includes('(unread ? " unread" : "")'), "unread members highlight in inspector chips");
const drawerFn = fnBody("renderSlimDrawer");
/* W-TEAMSNC ④：旧成员会话卡列（slimDrawerCardMarkup）随厚抽屉退役——roster 行 data-slim-open
   直开吸收职能；断言改锚新四区链 */
ok(drawerFn.includes('el.classList.remove("open")') && drawerFn.includes("cc-deck-005-slim-drawer") && drawerFn.includes("requestAnimationFrame"), "drawer collapses via .open class (keep-mounted 动效) + persists when team no longer exists");
ok(fnBody("teamDrawerMarkup").includes("dr-sec") && fnBody("teamDrawerMarkup").includes("lane-bar") && fnBody("teamDrawerMarkup").includes("roster-row") && fnBody("teamDrawerMarkup").includes("entry-btns") && fnBody("teamDrawerMarkup").includes("data-team-jump"), "thick drawer four zones render (概览/roster/输出物/跳域钮)");

// ---- §H 结构闸 ----
console.log("-- §H structure gates");
const opens = count(html, "<div"); const closes = count(html, "</div>");
ok(opens - closes === 0, `html 骨架 div 平衡（#193 外置后骨架无业务 div，${opens}/${closes}）；业务 DOM 由 js/* 动态生成不在此计`);
const slimZone = html.slice(html.indexOf("[t-7e0c6189] 会话列表瘦身：团队入口卡"), html.indexOf("/* #B3-17 入场工具类"));
ok(!BARE_COLOR.test(stripComments(slimZone)), "new slim css zone carries zero bare color literals (token-only discipline)");
let compiled = true;
try { new Function(sessionSrc.replace(/^\s*\(\(\) => \{/, "").replace(/\}\);?\s*$/, "")); } catch { compiled = false; } // #193 外置后：session-domain.js 剥 IIFE 包装编译闸（html 内联已零）
ok(compiled, "session-domain.js compiles (IIFE 剥壳直编；html 内联脚本已外置清零)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
