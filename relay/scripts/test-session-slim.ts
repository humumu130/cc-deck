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
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}
function jsConst(name: string): string {
  const i = html.indexOf(`const ${name} = `);
  if (i < 0) return "";
  const end = html.indexOf("\n", i);
  return html.slice(i, end);
}
function cssBlock(selector: string): string {
  const i = html.indexOf(selector + " {");
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(j, k + 1); }
  }
  return "";
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const BARE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

console.log("== [t-7e0c6189] session list slim: worker sessions fold into team domain ==");

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
ok(entryCss.includes("cursor: pointer") && cssBlock(".team-entry .t-expand").length > 0, "team-entry card is clickable with inline expand button");
const drawerCss = cssBlock(".team-drawer");
ok(drawerCss.includes("position: absolute") && drawerCss.includes("width: 248px") && html.includes(".desktop-screen.inspector-collapsed .team-drawer { right: 42px; }"), "team-drawer is an overlay fourth column, re-anchors when inspector collapses");
ok(cssBlock(".member-card[data-team-member-session]").includes("cursor: pointer") && html.includes('.member-card[data-team-member-session]::after { content: "↗ 直开"'), "team-domain member card hover reveals direct-open affordance");
ok(cssBlock(".member-chips").includes("flex-wrap") && cssBlock(".member-chip .mc-ava").includes("border-radius: 50%") && cssBlock(".t-expand.has-unread::after").includes("animation: slimPulseKf"), "inspector member chips + unread pulse styles exist (V8R+ ③未读点迁 t-expand 角标)");

// ---- §C 列表渲染链 ----
console.log("-- §C render chain");
ok(html.includes("const slimRoster = slimRosterOf(S.projects);") && html.includes(".filter((x) => (pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x) && slimVisible(x))") && html.includes("const slimVisible = (x) => !slimIsHidden(x, slimRoster, S.selected);"), "renderMyList pipes sessions through slim filter");
ok(html.includes("const pinnedKeep = (x) => x.pinned === true;") && html.includes(".filter((x) => !((pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x)))"), "1015 pinned keep: pinned cards exempt from status filter (always rendered, pinned-first top); filterHidden ledger shares the same predicate so observer amnesty stays exact");
ok(html.includes("S._slimHiddenIds = slimHiddenIds.length ? new Set(slimHiddenIds) : null;"), "hidden sids recorded for observer amnesty (same FB17 discipline)");
ok(html.includes('data-group-toggle="slim-teams"') && html.includes("<span>team</span>") && html.includes("session-group teams-dock") && html.includes(".session-group.teams-dock {") && html.includes(".teams-dock .dock-lamp"), "team dock renders as bottom pane with collapsible head (#103: title \"team\", status-bar collapse, B11 toggle reuse)");
ok(html.includes("tpl.innerHTML = pinnedMarkup + activeMarkup + idleMarkup;") && html.includes("mountTwoPane(tpl.content);") && html.includes('upper.className = "list-upper";'), "list assembly: two-pane (#103) — upper sessions pane, dock below");
ok(fnBody("slimTeamEntryMarkup").includes('const isAllFilter = !filterDef || filterDef.id === "all";') && fnBody("slimTeamEntryMarkup").includes("if (!hit.length && (!isAllFilter || !team.members.length)) return \"\";") && fnBody("slimTeamEntryMarkup").includes("const rosterN = team.members.length;"), "team card for roster-present teams (#99-5: unsynced/PM-only included on all-filter via id check, filter purity kept) + roster headcount counting (#99-6)");

// ---- §D MutationObserver 放行 + 选中联动 ----
console.log("-- §D observer integration");
ok(count(html, "S._slimHiddenIds && S._slimHiddenIds.has(k)") === 1 && html.includes("&& !(S._slimHiddenIds && S._slimHiddenIds.size > 0)"), "completeness check amends slim-hidden set (miss-loop guard, both empty-list and per-sid)");
ok(html.includes("renderMyList(); // [t-7e0c6189] 选中进出 worker 会话时出列/收回要跟着换"), "selection change re-renders list (temporary listing folds back)");

// ---- §E 帧链 ----
console.log("-- §E frame wiring");
ok(html.includes('case "PROJECTS_UPDATED": onProjectsUpdated(m.payload || {}); break;'), "session domain handles PROJECTS_UPDATED (roster stays fresh without full SNAPSHOT)");
const projFn = fnBody("onProjectsUpdated");
ok(projFn.includes("if (!S.hasSnapshot) return;") && projFn.includes("p.delta.upserts") && projFn.includes("p.delta.removes") && projFn.includes("Array.isArray(p.groups)"), "projects delta merges with snapshot-anchor guard (#143 C-3 discipline)");
const logFn = fnBody("onLog");
ok(logFn.includes("S.slimUnread.get(m.gid)") && logFn.includes("!SLIM_KEEP_ROLE.test(m.role)") && logFn.includes("sid !== S.selected"), "SESSION_LOG from unseen foldable member records team unread");
const snapFn = fnBody("onSnapshot");
ok(snapFn.includes("S.slimUnread = new Map();") && snapFn.includes('localStorage.getItem("cc-deck-005-slim-drawer")'), "snapshot resets unread (replay no backfill) and restores drawer gid");

// ---- §F 直开路径 ----
console.log("-- §F direct-open path");
ok(html.includes("window.__ccDeck005SlimUi = Object.freeze({ open: slimOpenSession, markSeen: slimMarkSeen, toggleDrawer: slimToggleDrawer });"), "slim UI api exposed cross-domain");
const openFn = fnBody("slimOpenSession");
ok(openFn.includes("inputDrafts.set(S.selected, UI.input.value)") && openFn.includes("renderMyList(); // 直聊中的 worker 会话临时出列") && openFn.includes("b2Toast(\"成员会话不在当前来源\")"), "direct-open reuses selection chain: drafts, temporary listing, missing-session toast");
const memberAnchor = `data-team-member-session="' + escape(member.session_id)`;
ok(html.includes('window.__ccDeck005B4?.railJump?.("session");') && html.includes("window.__ccDeck005SlimUi?.open?.(memberCard.dataset.teamMemberSession);") && html.includes(memberAnchor), "team member card click: jump to session domain + open (roster member markup carries sid)");
ok(html.includes("window.__ccDeck005SlimUi?.markSeen?.(gid);"), "team select() clears that team's unread aggregate");
ok(html.includes("slimMarkSeen(gid); // 进团队域即清未读") && html.includes('window.__ccDeck005B4?.railJump?.("team");'), "team entry click: mark seen + jump to team domain");

// ---- §G 检查器团队块 + 第四列 ----
console.log("-- §G inspector block + fourth column");
const inspFn = fnBody("renderInspector");
ok(inspFn.includes("slim-team-block") && inspFn.includes("团队成员 · ") && inspFn.includes("data-slim-open=") && inspFn.includes("展开成员会话 ⤢"), "inspector renders team-member block with chips + drawer link for rostered session");
ok(inspFn.includes('class="member-chip' + "' + (unread ? \" unread\" : \"\")") || inspFn.includes('(unread ? " unread" : "")'), "unread members highlight in inspector chips");
const drawerFn = fnBody("renderSlimDrawer");
const drawerCardFn = fnBody("slimDrawerCardMarkup");
ok(drawerCardFn.includes(`data-slim-open="' + item.id`) && !drawerCardFn.includes("data-session-card"), "drawer card markup carries data-slim-open (not data-session-card — bypasses ground click chain)");
ok(drawerFn.includes("cc-deck-005-slim-drawer") && drawerFn.includes('el.hidden = true'), "drawer collapses + persists when team no longer exists");
ok(html.includes('slimDrawerEl.querySelectorAll(".queue-card[data-slim-open]")'), "per-second ticker also drives drawer cards");

// ---- §H 结构闸 ----
console.log("-- §H structure gates");
const opens = count(html, "<div"); const closes = count(html, "</div>");
ok(opens - closes === 1, `div imbalance stays at dev baseline (+1 pre-existing on origin/dev 665/664; this batch adds none: ${opens}/${closes})`);
const slimZone = html.slice(html.indexOf("[t-7e0c6189] 会话列表瘦身：团队入口卡"), html.indexOf("/* #B3-17 入场工具类"));
ok(!BARE_COLOR.test(stripComments(slimZone)), "new slim css zone carries zero bare color literals (token-only discipline)");
let compiled = true;
const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m: RegExpExecArray | null; let blocks = 0;
while ((m = scriptRe.exec(html))) {
  if (/\bsrc=/.test(m[1])) continue;
  blocks++;
  try { new Function(m[2]); } catch { compiled = false; }
}
ok(blocks === 6 && compiled, `all ${blocks} inline scripts compile`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
