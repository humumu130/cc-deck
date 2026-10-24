// W-MOBLIST #250：engine 缺失兜底推断链——PM/外部会话 engine 字段可能为空
//（relay 侧按引擎注入，PM 编制会话/旧 CLI 接入无 engine），但 model 字符串恒在
//（relay 集中维护）。按 model 子串推断引擎 id，供头像品牌图/引擎徽/详情 head
// 兜底（灭「?」占位）。双端同规则：expo 消费本 util；web 侧 session-domain
// renderHeader 内联同链（注释互指，改链两处同步）。
// 顺序敏感：先长键后短键（qwen-code 先于 qwen 誤配…实际词表无裸 qwen，保序防
// 未来引擎名互为前缀）。
const MODEL_HINTS: [needle: string, engine: string][] = [
  ["claude", "claude"],
  ["codex", "codex"],
  ["codebuddy", "codebuddy"],
  ["qwen-code", "qwen-code"],
  ["qwen", "qwen-code"],
  ["glm", "glm"],
  ["trae", "trae"],
  ["zcode", "zcode"],
];

/** engine 字段优先；缺失时按 model 子串推断；双缺返回 null（调用方落各自兜底：
 *  详情 head=「?」字母占位、列表卡=首字母字母头像）。 */
export function inferEngine(engine: string | undefined | null, model?: string | null): string | null {
  if (engine) return engine;
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  for (const [needle, id] of MODEL_HINTS) {
    if (m.includes(needle)) return id;
  }
  return null;
}
