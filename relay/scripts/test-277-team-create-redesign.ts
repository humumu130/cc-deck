// #277 建团弹窗重设计+团队域多源化+成员 tab 修坏——六点断言（行为级 eval + 静态闸）。
// 范式：真源码抽取直跑（test-268/272 同范式），靶子 web-console/js/{team,session,settings}-domain.js。
//
// 断言组（对应任务书 6 点）：
//   A 源选择器+候选联动（②③）：cloudPaired+online 才透出「创建到」；候选 relay_source 对位；
//     成员行 v2 无引擎徽标
//   B 提交路由（②）：显式选源 → state.command 第 4 参 wsOverride；目标源离线拦截
//   C 目录选择器（④）：本机+Tauri+loopback 三闸；远程源隐藏；弹窗含浏览钮/hint 锚
//   D 头像同源（⑥）：memberAvatarHtml 委派 __ccDeck005AvaOf（.ava-brand 包装，不再裸 SVG）
//   E 团队卡源标签（⑤）：成员会话源去重 ≤2+N；会话全缺失时 __relay_source 兜底（聚合恒显）
//   F/G 静态闸：merge 打源标、sendCommand wsOverride、CSS 门控孪生/头像修锚、× 关闭锚
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-277-team-create-redesign.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const td = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
const ssd = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string, zone?: string): string {
  const src = zone ?? td;
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const j = src.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return "";
}
function bodyOf(block: string): string { return block.slice(block.indexOf("{") + 1, block.lastIndexOf("}")); }
function link(block: string, params: string[], deps: Record<string, unknown>): (...a: unknown[]) => unknown {
  const f = new Function(...params, "__D", "with (__D) {" + bodyOf(block) + "}");
  return (...a: unknown[]) => { const p = [...a]; while (p.length < params.length) p.push(undefined); return f(...p, deps); };
}

console.log("#277 建团弹窗重设计+团队域多源化+成员tab修坏（六点断言）");

// ---------- A 源选择器 + 候选联动 ----------
{
  const srcInfo = link(blockFrom("function teamSourceInfo()"), [], {
    window: { __ccDeck005SourceState: () => ({ cloudPaired: true, cloudStatus: "online", lanRelayName: "Mac本机", cloudRelayName: "公司机" }) },
  });
  ok((srcInfo() as Record<string, unknown>)?.cloudRelayName === "公司机", "A1 云已配对在线 → 透出目标源信息");
  const srcNone = link(blockFrom("function teamSourceInfo()"), [], {
    window: { __ccDeck005SourceState: () => ({ cloudPaired: false, cloudStatus: "offline", lanRelayName: "x", cloudRelayName: "" }) },
  });
  ok(srcNone() === null, "A2 单源/云离线 → 无选择行（不误导）");
  const stateStub = { sessions: new Map([
    ["s1", { session_id: "s1", relay_source: "Mac本机", updated_at: 3 }],
    ["s2", { session_id: "s2", relay_source: "公司机", updated_at: 2 }],
    ["s3", { session_id: "s3", updated_at: 1 }], // 旧 relay 无源标记 → 按本机计
    ["s4", { session_id: "s4", relay_source: "公司机", external: true }], // external 剔除
  ]) };
  const cands = link(blockFrom("function teamCandsForSource(which, st)"), ["which", "st"], { state: stateStub });
  const cloud = cands("cloud", { lanRelayName: "Mac本机", cloudRelayName: "公司机" }) as Array<{ session_id: string }>;
  const local = cands("local", { lanRelayName: "Mac本机", cloudRelayName: "公司机" }) as Array<{ session_id: string }>;
  ok(cloud.length === 1 && cloud[0].session_id === "s2", "A3 云源候选=relay_source 对位该源的会话（external 剔除）");
  ok(local.length === 2 && local.map((x) => x.session_id).join(",") === "s1,s3", "A3 本机源候选=本机名+无标记兜底（旧快照兼容）");
  const listHtml = link(blockFrom("function teamCandListHtml(cands)"), ["cands"], {
    banner: (t: string) => "<p>" + t + "</p>",
    escape: (x: string) => String(x),
  });
  const html2 = listHtml([{ session_id: "s1", title: "推广主控" }]) as string;
  ok(html2.includes('data-team-member="s1"') && html2.includes("推广主控"), "A4 候选行 v2 勾选锚+标题保留");
  ok(!html2.includes("engine-badge"), "A4 成员行去引擎徽标（PM 美化：引擎身份归成员卡头像）");
}
// ---------- B 提交路由（显式选源锁通道） ----------
{
  ok(td.includes("wsOverride = window.__ccDeck005WsFor ? window.__ccDeck005WsFor(srcSel.value) : null"), "B1 submit 显式选源 → __ccDeck005WsFor 锁通道（T10 同语义不随视角漂移）");
  ok(td.includes("无法在远程创建") && td.includes("无法在本机创建"), "B2 目标源离线可读拦截文案");
  ok(td.includes("}, undefined, wsOverride))"), "B3 state.command 第 4 参透传 wsOverride");
  ok(sd.includes("sendCommand(type, payload, timeoutMs = 8000, wsOverride = null)") && sd.includes("const ws = wsOverride ||"), "B4 Team.sendCommand 接 wsOverride（显式选择优先级最高）");
}
// ---------- C 本机目录选择器 ----------
{
  const browse = link(blockFrom("function teamAnchorBrowseable(which)"), ["which"], {
    window: { __TAURI__: { dialog: {} }, __ccDeck005LocalRelayLoopback: () => true },
  });
  ok(browse("local") === true, "C1 本机+Tauri dialog+loopback 三闸齐 → 可浏览");
  ok(browse("cloud") === false, "C1 远程源 → 隐藏浏览钮（远程目录本机选无意义）");
  const noDialog = link(blockFrom("function teamAnchorBrowseable(which)"), ["which"], { window: {} });
  ok(noDialog("local") === false, "C1 纯 web（无 dialog 插件）→ 手输退化");
  ok(td.includes('data-team-anchor-browse') && td.includes('data-team-anchor-hint'), "C2 弹窗含浏览钮/提示锚");
  ok(td.includes("directory: true, multiple: false, title: \"选择锚点目录\""), "C2 pickTeamAnchor=Tauri 目录选择（#158-批3 先例同款）");
  ok(td.includes("syncTeamCreateSource(pop)"), "C2 切源联动浏览钮/hint（远程=那台电脑路径提示）");
}
// ---------- D 成员卡头像同源（⑥） ----------
{
  const ava = link(blockFrom("function memberAvatarHtml(info, roleClass)"), ["info", "roleClass"], {
    engines: new Map([["claude", ["Claude", "claude"]], ["codex", ["Codex", "codex"]]]),
    AVA_COLORS: { claude: "#c9684b", codex: "#4b7fc9" },
    window: { __ccDeck005AvaOf: (eng: string, role: string) => '<span class="ava-brand">' + (role === "pm" ? "PMCRAB" : "BRANDSVG:" + eng) + "</span>" },
    escape: (x: string) => String(x),
  });
  const htmlW = ava({ engine: "claude", name: "推广 worker" }, "worker") as string;
  ok(htmlW.includes('class="ava-brand"') && htmlW.includes("BRANDSVG:claude"), "D1 worker 头像委派 AvaOf（.ava-brand 包装受尺寸约束——裸 SVG=大螃蟹根因拔除）");
  const htmlP = ava({ engine: "claude", name: "PM" }, "pm") as string;
  ok(htmlP.includes("PMCRAB"), "D1 PM 角色蟹同表（ROLE_AVATAR_BRAND 单口）");
  const htmlQ = ava({ engine: "codex", name: "QA" }, "qa") as string;
  ok(htmlQ.includes('ava-qatag') && htmlQ.includes("BRANDSVG:codex"), "D2 qa 角标保留+引擎品牌正常");
  const avaNoHook = link(blockFrom("function memberAvatarHtml(info, roleClass)"), ["info", "roleClass"], {
    engines: new Map([["claude", ["Claude", "claude"]]]), AVA_COLORS: {}, window: {}, escape: (x: string) => String(x),
  });
  const htmlN = avaNoHook({ name: "无名" }, "worker") as string;
  ok(htmlN.includes("无"), "D2 AvaOf 缺席兜底首字母（旧环境兼容）");
  ok(!td.includes("const CRAB_PM_B64 =") && !td.includes("const CRAB_LEADER_B64 ="), "D3 团队域死蟹常量已退役（单一图源=session-domain ROLE_AVATAR_BRAND）");
}
// ---------- E 团队卡源标签（⑤） ----------
{
  const caps = link(blockFrom("const teamSrcCaps = (item) =>"), ["item"], {
    members: (p: { headcount?: Array<{ session_id: string }> }) => p.headcount || [],
    state: { sessions: new Map([["s1", { relay_source: "公司机" }], ["s2", { relay_source: "Mac本机" }]]) },
    window: { __ccDeck005SourceColor: () => "#3E8EF7" },
    escape: (x: string) => String(x),
  });
  const two = caps({ headcount: [{ session_id: "s1" }, { session_id: "s2" }] }) as string;
  ok(two.includes("公司机") && two.includes("Mac本机") && (two.match(/class="src-cap"/g) || []).length === 2, "E1 双源成员 → 两枚源胶囊");
  const mixed = caps({ headcount: [{ session_id: "s1" }, { session_id: "s1" }] }) as string;
  ok(mixed.includes("公司机") && !mixed.includes("Mac本机"), "E1 同源去重");
  const fallback = caps({ headcount: [{ session_id: "gone" }], __relay_source: "公司机" }) as string;
  ok(fallback.includes("公司机") && fallback.includes("src-cap"), "E2 成员会话全缺失 → __relay_source 兜底（聚合恒显=用户不可见根修）");
  const none = caps({ headcount: [{ session_id: "gone" }] }) as string;
  ok(none === "", "E3 无源可辨 → 空串（诚实缺席，不编造）");
  ok(sd.includes("__relay_source: String(c.relayName || \"\")"), "E4 聚合并集给 project 打源标（merge 写点）");
}
// ---------- F/G 静态闸 ----------
ok(ssd.includes("window.__ccDeck005AvaOf = (engine, teamRole)"), "G1 AvaOf 单口已挂（session-domain 与 team-domain 同源）");
ok(td.includes('data-team-close'), "G2 弹窗 × 关闭锚");
ok(td.includes('class="create-head"'), "G2 头行结构（标题不截断）");
ok(!td.includes('class="create-group"'), "G2 灰盒 create-group 退役（分段卡片流）");
ok(css.includes('body[data-source-count="1"] #d-team .queue-card .src-cap { display: none; }'), "G3 团队卡 src-cap 门控孪生（单源隐藏/聚合显示）");
ok(css.includes(".member-card .member-head .avatar.m-ava .ava-brand img") && !css.includes(".member-card .m-head .avatar.m-ava .ava-crab"), "G4 成员卡头像 CSS 修锚（.m-head→.member-head+ava-brand 同规格）");
ok(css.includes(".create-x") && css.includes(".create-inline"), "G5 弹窗 v2 皮肤落地");
ok(td.includes("创建到"), "G6 「创建到」行入弹窗（NewSessionModal 同语义）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
