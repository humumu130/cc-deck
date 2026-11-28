// [W-AGGBUG] 建团本机源误判（1109 用户实锤）——静态闸（防回退）+行为锚。
// 定罪：pm-led 默认模板的 PM 人选=「会话列表残留选中」隐式默认，pmInSource out 时整单硬拦
// （8 本机成员无辜陪绑；文案不点名 sid 归因成「成员不在本机源」）。修复：out 降级不带 PM 行
// （absent 同语义先例）+prefill.source 弹窗源随成员对齐。行为面实证=probe-aggbug 六连跑 8/0。
// 范式对齐 test-277（真源码抽取断言）。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const td = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
const bc = readFileSync(join(root, "web-console", "js", "bridge-core.js"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---------- ① out 降级（不再整单硬拦） ----------
{
  const seg = td.slice(td.indexOf("if (template === \"pm-led\" && srcSelEarly)"), td.indexOf("if (pmSid) { const i = headcount.findIndex"));
  ok(seg.includes('v.verdict === "out"') && seg.includes("pmSidOut.v = \"\";"), "① out 分支降级：pmSidOut 清空（payload 不带 PM 行）");
  ok(!/verdict === "out"[\s\S]{0,200}return;/.test(seg), "① out 分支无整单 return（硬拦退役）");
  ok(seg.includes("不在\" + srcLabel + \"——本团未带 PM 行"), "① 降级文案在场（PM 行缺席明示）");
  ok(seg.includes("pmSid.slice(0, 6)"), "① 文案点名 sid 前 6（消「8 成员被拦」误读）");
  ok(seg.includes("编制面板补任 PM"), "① 指引后果语言（可稍后补任）");
  // absent 分支降级先例保持不破
  ok(seg.includes('v.verdict === "absent"') && seg.includes("pmSidOut.v = \"\";"), "① absent 降级先例原样（同语义两分支对齐）");
}

// ---------- ② pmInSource 判定器本身不动（口径防线） ----------
{
  const seg = td.slice(td.indexOf("const pmInSource = (which, sid)"), td.indexOf("if (template === \"pm-led\" && srcSelEarly)"));
  ok(seg.includes("s.relay_source || s.source") && seg.includes('verdict: "out"'), "② pmInSource 判定器原样（out 判定仍在——只降消费侧）");
  ok(seg.includes("(!src || (ln && src === ln)) ? { verdict: \"in\" }"), "② 本机源兜底口径原样（缺源标=本机计）");
}

// ---------- ③ prefill.source 弹窗源对齐 ----------
{
  ok(td.includes('pf.source === "local" || pf.source === "cloud"'), "③ openTeamCreate 消费 prefill.source（值域闸）");
  ok(/const defSrc = pfSrc \|\|/.test(td), "③ defSrc=pfSrc 优先（视角判定回落）");
}

// ---------- ④ bridge-core 预填链源一致性 ----------
{
  const seg = bc.slice(bc.indexOf('const aggCreate = target.closest("[data-agg-create]")'), bc.indexOf("aggPrefs[dir] = { ...(aggPrefs[dir]"));
  ok(seg.includes("prefillSource") && seg.includes("srcs.size === 1"), "④ 预填链算成员源一致性（全同源才传）");
  ok(seg.includes('prefillSource = "cloud"') && seg.includes('prefillSource = "local"'), "④ 源名对位（cloudRelayName/lanRelayName 各归位）");
  ok(seg.includes("...(prefillSource ? { source: prefillSource } : {})"), "④ source 条件透传（混源/无名册不传=旧行为）");
  ok(seg.includes("members: prefillSessions.map"), "④ members 排序链重构后语义不变（活跃序）");
}

// ---------- ⑤ 跨源防线不撤（成员面候选过滤+relay seatGate） ----------
{
  ok(td.includes("teamCandsForSource(srcSel.value"), "⑤ 成员候选 relay_source 对位过滤原样（第一道防线）");
  ok(/src === cloudName : \(!src \|\| src === lanName\)/.test(td), "⑤ 候选过滤兜底口径原样（缺源标=本机计——与校验同源同兜底，嫌疑 c 闭合）");
}

// ---------- ⑥ 旧码复现证据锚（回执引用，防「没复现过」翻案） ----------
{
  ok(!td.includes("PM 会话需属于所选源：当前选中会话不在"), "⑥ 旧硬拦文案绝迹（源码零残留）");
}

console.log(fail === 0 ? `\naggbug: ${pass} passed, 0 failed` : `\naggbug: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
