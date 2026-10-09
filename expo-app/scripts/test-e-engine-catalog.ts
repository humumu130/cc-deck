// 75-E 新建会话引擎选择器（expo 半）直跑测试（worker L / 75-E）。
//
// 实际直跑入口（expo-app 目录）：
//   npx tsx scripts/test-e-engine-catalog.ts
//
// 被测面（任务书作业⑥：词表字面锚+契约字段消费锚+undefined 降级锚+codexBlock
// 迁移锚+降级标记锚，参照 test-e-permission-summary 九段式）：
//   A. ENGINE_STATE_LABEL / ENGINE_PHRASES 词表字面 deepEq 钉死（三端同词勿改）
//   B. engineCatalogOf 鸭子收容（undefined 降级锚 / 畸形条目剔除 / 字段级宽容）
//   C. normalizeSnapshotPayload 的 source_capabilities.engine_catalog 收容链
//      （畸形→不设键=旧 relay 降级；正常→数组透出）
//   D. engineSummaryLine 摘要行降级矩阵（旧 relay / 单引擎 / auto 预置 / 手动覆盖）
//   E. engineSelectable 可选性 + enginePresetOf 预置推导
//   F. engineDowngradeNote ACK 降级标记（不一致→提示；undefined 旧 relay 不误报）
//   G. NewSessionModal 源码字面锚（codexBlock checkbox 迁移带入/熄灭逻辑随迁/
//      checkbox 移除/两层浮层/创建前阻止/提交按钮唯一）
//   H. store engine 透传锚 + theme ENGINE_ACCENT 005 词表锚 + 跨端 token 陷阱锚
//
// 全程零桩：被测纯函数全在 protocol.ts（零 RN 依赖），组件/store/theme 只做
// readFileSync 源码锚——不需要动态 import，也就不需要 process.exit

import {
  ENGINE_PHRASES,
  ENGINE_STATE_LABEL,
  engineCatalogOf,
  engineDowngradeNote,
  enginePresetOf,
  engineSelectable,
  engineSummaryLine,
  normalizeSnapshotPayload,
  type EngineCatalogEntry,
} from "../src/protocol";

// @ts-expect-error node:fs 未进 expo tsconfig types 字段
import { readFileSync } from "node:fs";

let tests = 0;
const check = (condition: unknown, msg = "assertion failed"): void => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};
const eq = (a: unknown, b: unknown, msg = "deep-equal failed"): void => {
  tests += 1;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`#${tests} ${msg}: got ${ja} want ${jb}`);
};
const SECTION = (name: string): void => console.log(`  ${name}`);

// 契约形状样例（PM-75 §4.3 钉死契约）：ready 带 capabilities/models/default_for_roles；
// unavailable 带 preflight fail；unsupported 裸条目
const CAT: EngineCatalogEntry[] = [
  { id: "claude", label: "Claude", state: "ready", capabilities: { resume: true, approval: true, artifacts: true }, preflight: { state: "pass" }, models: ["glm-5.3"], default_for_roles: ["worker"] },
  { id: "trae", label: "Trae", state: "ready", capabilities: { resume: false, approval: false, artifacts: false }, preflight: { state: "pass" }, models: ["glm-5.3"] },
  { id: "codex", label: "Codex", state: "unavailable", preflight: { state: "fail", reason: "codex CLI 未安装" } },
  { id: "zcode", label: "zcode", state: "unsupported" },
];

function main(): void {
  try {
  // ================= A. 词表字面锚（三端统一词表钉死——勿改字面） =================
  SECTION("A. 词表字面锚");
  eq(ENGINE_STATE_LABEL, {
    ready: "可用",
    unavailable: "未安装或校验未过",
    unsupported: "不支持 · 不可选",
    unknown: "状态未知",
  }, "engine_catalog 四态词（与 75-W/75-R 逐字一致）");
  eq(ENGINE_PHRASES, {
    legacyRelayHint: "升级 relay 可选择更多引擎",
    onlyAvailable: "仅可用",
    overrideTag: "已覆盖预置",
    engineDefaultModel: "使用引擎默认",
    preflightFail: "预检未通过",
    basicExec: "基础执行",
    autoSourceDefault: "自动（源默认）",
    downgrade: "已降级",
  }, "固定短语八条（跨端同词）");

  // ================= B. engineCatalogOf 收容（undefined 降级锚） =================
  SECTION("B. engineCatalogOf 收容");
  eq(engineCatalogOf(undefined), undefined, "undefined（旧 relay 不发）→ undefined 降级");
  eq(engineCatalogOf(null), undefined, "null → undefined");
  eq(engineCatalogOf("catalog"), undefined, "非数组串 → undefined");
  eq(engineCatalogOf(42), undefined, "非数组数 → undefined");
  eq(engineCatalogOf([]), undefined, "空数组 → undefined（同降级语义）");
  eq(engineCatalogOf([null, 42, "x", {}, { id: "", state: "ready" }, { id: "trae", state: "maybe" }]), undefined, "全畸形条目 → undefined（不出假清单）");
  eq(engineCatalogOf(CAT), CAT, "正常契约条目全字段透出");
  eq(engineCatalogOf([
    { id: "trae", state: "ready", junk: "unknown-key" },
    null,
    42,
    { id: "codex", state: "unknown" },
  ]), [
    { id: "trae", state: "ready" },
    { id: "codex", state: "unknown" },
  ], "混入畸形条目剔除其余透出；未知键不收（不造假字段）");
  // 字段级宽容：capabilities/preflight/models/default_for_roles 各自畸形 → 各自降缺省，
  // id+state 合法即收（呈现层按存在性渲染）
  eq(engineCatalogOf([{
    id: "trae", state: "ready",
    capabilities: "yes", preflight: { state: "meh" }, models: ["ok", 7], default_for_roles: [3],
    label: 0,
  }]), [{ id: "trae", state: "ready" }], "字段级畸形各自降缺省（条目保留）");
  eq(engineCatalogOf([{
    id: "trae", state: "ready",
    preflight: { state: "fail", reason: "" }, models: [], default_for_roles: [],
  }]), [{ id: "trae", state: "ready", preflight: { state: "fail" } }], "空 reason/空 models/空 roles → 降缺省不设键");

  // ================= C. SNAPSHOT 收容链（normalizeSnapshotPayload） =================
  SECTION("C. SNAPSHOT source_capabilities.engine_catalog 收容链");
  const snapOf = (source_capabilities: unknown) =>
    normalizeSnapshotPayload({
      connected: true, conn_text: "", conn_state: "online", channel: "lan",
      sessions: [], sources: [{ id: "s1", name: "mac", state: "online", color_key: "k" }],
      active_source_id: "s1", aggregate: false, source_capabilities,
    }).sourceCapabilities;
  eq(snapOf(undefined)?.engine_catalog, undefined, "旧 relay 无 engine_catalog → undefined");
  eq(snapOf({})?.engine_catalog, undefined, "空 source_capabilities → 不设键");
  eq(snapOf({ engine_catalog: "nope" })?.engine_catalog, undefined, "engine_catalog 非数组 → 不设键");
  eq(snapOf({ engine_catalog: [null, {}, { id: "trae", state: "bogus" }] })?.engine_catalog, undefined, "全畸形条目 → 不设键（降级隐藏不白屏）");
  eq(snapOf({ engine_catalog: [{ id: "trae", label: "Trae", state: "ready" }] })?.engine_catalog,
    [{ id: "trae", label: "Trae", state: "ready" }], "正常 engine_catalog 收容透出");
  eq(snapOf({ engine_catalog: [{ id: "trae", state: "ready" }, "junk"] })?.engine_catalog,
    [{ id: "trae", state: "ready" }], "混入畸形条目剔除其余透出");
  // permission 与 engine_catalog 并存互不干扰（P81 资产同载荷）
  const both = snapOf({
    permission: [{ engine: "codex", capability_state: "unverified", modes: ["default"] }],
    engine_catalog: [{ id: "codex", state: "ready" }],
  });
  eq(both?.permission?.length, 1, "并存：permission 照常收容");
  eq(both?.engine_catalog?.length, 1, "并存：engine_catalog 照常收容");

  // ================= D. engineSummaryLine 摘要行降级矩阵（派单作业③降级面） =================
  SECTION("D. engineSummaryLine 摘要行矩阵");
  // 旧 relay（catalog undefined）：回落默认 + 升级提示；codex 记忆带入如实显示（可点取消）
  eq(engineSummaryLine({ catalog: undefined, selected: "auto", model: null }),
    { headline: "默认引擎", sub: "升级 relay 可选择更多引擎", overridable: true }, "旧 relay auto → 默认引擎+升级提示");
  eq(engineSummaryLine({ catalog: undefined, selected: "codex", model: null }),
    { headline: "codex", sub: "升级 relay 可选择更多引擎", overridable: true }, "旧 relay codex 记忆 → id 显示+保留取消入口");
  // 单引擎：仅可用：X，不可改（无更改箭头）
  eq(engineSummaryLine({ catalog: [CAT[1]], selected: "auto", model: null }),
    { headline: "仅可用：Trae", sub: null, overridable: false }, "单引擎 → 仅可用：X 不可改");
  // 多引擎 auto：预置推导三段
  eq(engineSummaryLine({ catalog: CAT, selected: "auto", model: null }),
    { headline: "自动（Worker 预置） · Claude · glm-5.3", sub: null, overridable: true }, "auto+预置 → 三段（角色大写+引擎+模型）");
  eq(engineSummaryLine({ catalog: [CAT[1], CAT[3]], selected: "auto", model: null }),
    { headline: "自动（源默认）", sub: null, overridable: true }, "auto 无 default_for_roles → 自动（源默认）");
  // 手动覆盖：引擎+模型段 + 已覆盖预置
  eq(engineSummaryLine({ catalog: CAT, selected: "trae", model: null }),
    { headline: "Trae · 使用引擎默认", sub: "已覆盖预置", overridable: true }, "手动引擎无模型 → 使用引擎默认+覆盖标记");
  eq(engineSummaryLine({ catalog: CAT, selected: "trae", model: "glm-5.3" }),
    { headline: "Trae · glm-5.3", sub: "已覆盖预置", overridable: true }, "手动引擎+模型 → 全显+覆盖标记");
  // 失效 id（换源后残留）兜底回自动——不出假引擎名
  eq(engineSummaryLine({ catalog: CAT, selected: "ghost", model: null }),
    { headline: "自动（源默认）", sub: null, overridable: true }, "失效 id → 兜底回自动");

  // ================= E. engineSelectable + enginePresetOf =================
  SECTION("E. engineSelectable 可选性 / enginePresetOf 预置推导");
  eq(engineSelectable(CAT[0]), null, "ready → 可选");
  eq(engineSelectable({ id: "x", state: "unknown" }), null, "unknown 状态未知 → 不禁（relay 创建兜底，端上不探测）");
  eq(engineSelectable(CAT[3]), "不支持 · 不可选", "unsupported 无 reason → 词表态词禁选");
  eq(engineSelectable({ id: "zcode", state: "unsupported", preflight: { state: "unknown", reason: "枚举占位未接入编排（不可选）" } }),
    "枚举占位未接入编排（不可选）", "unsupported + reason → 原因优先（75-R 实测 zcode 投影形状）");
  eq(engineSelectable(CAT[2]), "codex CLI 未安装", "unavailable + reason → 原因优先（显式选未安装创建前阻止，同一把尺）");
  eq(engineSelectable({ id: "x", state: "unavailable", preflight: { state: "fail" } }), "未安装或校验未过", "unavailable 无 reason → 词表态词兜底");
  eq(engineSelectable({ id: "x", state: "ready", preflight: { state: "fail", reason: "CCR_TRAE_API_KEY 缺失" } }), "CCR_TRAE_API_KEY 缺失", "preflight fail → 原因透出");
  eq(engineSelectable({ id: "x", state: "ready", preflight: { state: "fail" } }), "预检未通过", "preflight fail 无 reason → 固定词兜底");
  eq(engineSelectable({ id: "x", state: "ready", preflight: { state: "unknown" } }), null, "preflight unknown → 放行");
  eq(enginePresetOf(CAT), CAT[0], "预置 = 第一个 default_for_roles 非空条目");
  eq(enginePresetOf([CAT[1], CAT[3]]), null, "无 default_for_roles → null（源默认）");

  // ================= F. engineDowngradeNote ACK 降级标记（派单作业③） =================
  SECTION("F. engineDowngradeNote");
  eq(engineDowngradeNote("codex", "claude"), "已降级：请求引擎 codex，实际 claude", "不一致 → 降级提示");
  eq(engineDowngradeNote("codex", "codex"), null, "一致 → 无提示");
  eq(engineDowngradeNote("codex", undefined), null, "acked=undefined（旧 relay ACK 无 engine 字段）→ 不比较不提示");
  eq(engineDowngradeNote("codex", null), null, "acked=null → 不提示");
  eq(engineDowngradeNote("codex", 42), null, "acked 非串 → 不提示（字段存在性消费）");
  eq(engineDowngradeNote("codex", ""), null, "acked 空串 → 不提示");
  eq(engineDowngradeNote(null, "claude"), null, "requested=null（跟随预置不指定引擎）→ 不提示");
  eq(engineDowngradeNote("trae", "claude", (id) => ({ trae: "Trae", claude: "Claude" }[id] ?? id)),
    "已降级：请求引擎 Trae，实际 Claude", "labelOf 注入 → 目录 label 人话");

  // ================= G. NewSessionModal 源码字面锚（codexBlock 迁移+选择器形态） =================
  SECTION("G. NewSessionModal 源码字面锚");
  const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
  const modalSrc = srcOf("../src/screens/NewSessionModal.tsx");
  // codexBlock 迁移（PM-75 §7.3，兼容行为不删）：旧 checkbox 偏好 → engine=codex 带入
  check(modalSrc.includes("ccr_use_codex"), "codexBlock 迁移：ccr_use_codex 记忆口径保留");
  check(modalSrc.includes('setEngineSel((cur) => (cur === "auto" ? "codex" : cur))'), "迁移：ccr_use_codex=1 → engine=codex 带入（仅仍 auto 时，防覆盖用户选择）");
  check(modalSrc.includes('engineSel === "codex" && codexBlock'), "迁移：熄灭逻辑随 checkbox 迁移（codex 不可选 → 回 auto）");
  check(modalSrc.includes('AsyncStorage.setItem("ccr_use_codex", "0")'), "迁移：熄灭时记忆回关");
  check(!modalSrc.includes("用 Codex 引擎</Text>"), "迁移：旧「用 Codex 引擎」checkbox 产品入口已移除（被选择器取代；注释提及不算）");
  // 选择器形态（PM-75 §4.2）：摘要行 + 紧凑浮层两层 + 提交按钮仍唯一
  check(modalSrc.includes("引擎 / 模型"), "摘要行：引擎 / 模型");
  check(modalSrc.includes("更改 ›"), "摘要行：更改 › 入口");
  check(modalSrc.includes("跟随预置（自动）"), "浮层第一层：跟随预置行");
  check(modalSrc.includes("已覆盖预置") || modalSrc.includes("ENGINE_PHRASES"), "覆盖关系呈现走 engineSummaryLine（protocol 词表）");
  check(modalSrc.includes("ENGINE_PHRASES.engineDefaultModel"), "第二层模型行：使用引擎默认（无清单不冒充 SNAPSHOT.models）");
  check(modalSrc.includes('selection_source: "manual"'), "payload：手动选择带 selection_source=manual（不新开命令）");
  check(modalSrc.includes("engineDowngradeNote(engineExplicit, ackEngine, engineName)"), "ACK engine 不一致 → notifyCmdError 通道标「已降级」");
  check(modalSrc.includes("engineSelectable(selEntry)"), "创建前阻止：显式选不可用引擎 → 行内原因不发送（与灰显同一把尺）");
  check((modalSrc.match(/启动会话/g) ?? []).length === 1, "提交按钮仍唯一（启动会话全文仅一处）");
  // 跨端 token 陷阱锚（P81-8EFIX 教训）：状态映射不得用 waiting（expo=红）
  check(!modalSrc.includes('unavailable: "waiting"'), "状态色 unavailable ≠ waiting（expo waiting=#F0524F 红，跨端同名异色）");
  check(modalSrc.includes('unavailable: "working"'), "状态色 unavailable=working（琥珀警示，P81-8EFIX 同语义档）");

  // ================= H. store 透传锚 + theme 引擎色锚 =================
  SECTION("H. store engine 透传 / theme ENGINE_ACCENT");
  const storeSrc = srcOf("../src/store.ts");
  check(storeSrc.includes("typeof ack.engine === " + '"string" && ack.engine'), "store：COMMAND_ACK engine 原样透传 onAck（75-R 落地前 undefined）");
  check(storeSrc.includes("engine?: string"), "store：onAck 回调类型带 engine 可选字段");
  const themeSrc = srcOf("../src/theme.ts");
  // 005 原型词表 --engine-* 直搬（PM-75 §2 同一引擎色体系）
  for (const [id, hex] of [["claude", "#A97A62"], ["codex", "#8DABFF"], ["trae", "#58C9B1"], ["qwen-code", "#B493FF"], ["codebuddy", "#4BA8F0"], ["zcode", "#E58DB0"]] as const) {
    check(themeSrc.includes(id), `ENGINE_ACCENT 六引擎 id 齐：${id}`);
    check(themeSrc.includes(hex), `ENGINE_ACCENT 005 色值：${id} ${hex}`);
  }

  console.log(`\nOK ${tests} assertions`);
  } catch (e) {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  }
}

main();
