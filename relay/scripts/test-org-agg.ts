// #283 org 域跨源聚合——web 团队域分区合并 + 双端聚合契约静态锚。
// 手法 = test-m13-web-delta 先例：静态锚+正则提取纯函数块 new Function 直跑注入
// 帧比对终态；expo 侧为聚合契约回归锁（读侧 flatMap 锚点存在性——expo 已聚合，
// 本单锁死不回退）。直跑：node --import tsx/esm scripts/test-org-agg.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const teamSrc = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
const settingsSrc = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
const listSrc = readFileSync(join(root, "expo-app", "src", "screens", "ListScreen.tsx"), "utf-8");
const orgZoneSrc = readFileSync(join(root, "expo-app", "src", "screens", "OrgZone.tsx"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}

// ---------- 提取 mergePartition/aggViewOn/groupKeyOf/confirmKeyOf 块直跑 ----------
const FN_BLOCK_MARK = "const aggViewOn = () =>";
const blockStart = teamSrc.indexOf(FN_BLOCK_MARK);
const blockEnd = teamSrc.indexOf("const TEAM_ROLE_PRESETS", blockStart);
if (blockStart < 0 || blockEnd < 0) throw new Error("锚点缺失：team-domain #283 函数块");
const fnSrc = teamSrc.slice(blockStart, blockEnd);
const g: Record<string, unknown> = { window: { __ccDeck005SourceView: undefined as undefined | (() => string) } };
const extracted = new Function("window", fnSrc + "\nreturn { aggViewOn, mergePartition, groupKeyOf, confirmKeyOf };")(g.window) as Record<string, unknown>;
Object.assign(g, extracted);
const { aggViewOn, mergePartition, groupKeyOf } = g as never as {
  aggViewOn: () => boolean;
  mergePartition: <T>(current: T[] | null, incoming: T[], frameSrc: unknown, keyOf: (x: T) => string | undefined) => T[];
  groupKeyOf: (x: { id?: unknown }) => string | undefined;
};
const setAgg = (on: boolean) => { (g.window as { __ccDeck005SourceView?: () => string }).__ccDeck005SourceView = on ? () => "aggregate" : () => "local"; };
type G = { id: string; name: string; __relay_source?: string };

console.log("\nS1 聚合分区合并（mergePartition 直跑）");
{
  setAgg(true);
  // 双源各有团队：家源组保留 + 公司源组带入并盖源标
  const out = mergePartition<G>([{ id: "pg-home", name: "家团队", __relay_source: "家 relay" }], [{ id: "pg-corp", name: "公司团队" }], "公司 relay", groupKeyOf as never);
  ok(out.length === 2, "双源各有团队 → 并集两组全见");
  ok(out.some((x) => x.id === "pg-home" && x.__relay_source === "家 relay"), "非帧源分区原样保留（源标不丢）");
  ok(out.some((x) => x.id === "pg-corp" && x.__relay_source === "公司 relay"), "帧源入参盖 __relay_source=帧源");
  // 帧源分区整替换（relay 重启首播：家源组清单换代，公司分区不动）
  const out2 = mergePartition<G>([
    { id: "h1", name: "旧家1", __relay_source: "家 relay" },
    { id: "h2", name: "旧家2", __relay_source: "家 relay" },
    { id: "c1", name: "公司1", __relay_source: "公司 relay" },
  ], [{ id: "h2", name: "新家2" }], "家 relay", groupKeyOf as never);
  ok(out2.length === 2 && out2.some((x) => x.id === "h2" && x.name === "新家2") && out2.some((x) => x.id === "c1"), "帧源分区整替换 + 他源分区保留（重启首播不清并集——#283 主病灶）");
  ok(!out2.some((x) => x.id === "h1"), "帧源旧条目随分区替换退场（不粘性）");
  // 同 id 异源碰撞：帧源权威
  const out3 = mergePartition<G>([{ id: "dup", name: "家拷贝", __relay_source: "家 relay" }], [{ id: "dup", name: "公司版本" }], "公司 relay", groupKeyOf as never);
  ok(out3.length === 1 && out3[0].name === "公司版本" && out3[0].__relay_source === "公司 relay", "同 id 碰撞帧源权威（确定性）");
  // current 空/未锚定
  const out4 = mergePartition<G>(null, [{ id: "a", name: "A" }], "srcX", groupKeyOf as never);
  ok(out4.length === 1 && out4[0].__relay_source === "srcX", "current 未锚定（null）→ 仅入参分区");
}
console.log("\nS2 单源视图不变（整替换/不盖章）");
{
  setAgg(false);
  const incoming: G[] = [{ id: "only", name: "唯一组" }];
  const out = mergePartition<G>([{ id: "other", name: "他组", __relay_source: "别源" }], incoming, "本源", groupKeyOf as never);
  ok(out.length === 1 && out[0].id === "only" && out[0].__relay_source === undefined, "单源视角整替换且不盖章（既有行为）");
  const out2 = mergePartition<G>([{ id: "x", name: "X" }], incoming, undefined, groupKeyOf as never);
  ok(out2.length === 1 && out2[0].__relay_source === undefined, "聚合开但帧源缺失 → 整替换降级（不半合并）");
}
console.log("\nS3 team-domain case 守卫修正（静态锚）");
{
  const caseProjects = teamSrc.slice(teamSrc.indexOf('message?.type === "PROJECTS_UPDATED"'), teamSrc.indexOf('message?.type === "ORG_CONFIRM_UPDATED"'));
  ok(caseProjects.includes("Array.isArray(payload?.groups)") && !caseProjects.includes("delta === undefined"), "PROJECTS_UPDATED 消费 delta 并载全量帧（稳态帧不再被丢）");
  ok(caseProjects.includes("mergePartition(state.projects"), "PROJECTS_UPDATED 走分区合并");
  const caseConfirm = teamSrc.slice(teamSrc.indexOf('message?.type === "ORG_CONFIRM_UPDATED"'), teamSrc.indexOf('message?.type === "BOARD_UPDATED"'));
  ok(caseConfirm.includes("mergePartition(state.confirms"), "ORG_CONFIRM_UPDATED 走分区合并（确认卡并集不清）");
  const caseBoard = teamSrc.slice(teamSrc.indexOf('message?.type === "BOARD_UPDATED"'), teamSrc.indexOf("return false;", teamSrc.indexOf('message?.type === "BOARD_UPDATED"')));
  ok(caseBoard.includes("payload.board?.gid === payload.gid") && !caseBoard.includes("delta === undefined"), "BOARD_UPDATED 全量形态恒消费（delta 并载不挡）");
}
console.log("\nS4 settings-domain 合成快照源标（静态锚）");
{
  const mergeBlock = settingsSrc.slice(settingsSrc.indexOf("function mergedTeamPayload"), settingsSrc.indexOf("return out;", settingsSrc.indexOf("function mergedTeamPayload")));
  ok(mergeBlock.includes("g, { __relay_source: String(c.relayName"), "projects 源标（#277 ⑤ 既有）");
  ok(mergeBlock.includes("b, { __relay_source: String(c.relayName"), "boards 补源标（#283）");
  ok(mergeBlock.includes("cf, { __relay_source: String(c.relayName"), "org_confirms 补源标（#283——分区合并的分区键）");
}
console.log("\nS5 expo 聚合契约回归锁（expo 已聚合，锁死读侧平铺不回退）");
{
  ok(listSrc.includes("snap.sources.flatMap((x) => x.projects ?? [])"), "ListScreen 组织区跨源平铺（团队收纳分组）");
  ok(orgZoneSrc.includes("for (const src of snap.sources)"), "OrgZone 遍历全源（确认卡+团队卡 {src,g} 对）");
  ok(orgZoneSrc.includes("src.projects ?? []"), "OrgZone 组列表取 per-src projects 并集");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
