// 上下文窗口上限：按模型名集中查表，随 context_usage 下发，客户端不存映射表。
//
// #166（2026-09-23，推翻 #72 的 200K 一刀切结论）：窗口必须按模型查，用户切换
// 模型时 relay 下一次 usage 更新即自动跟随（所有调用点都传当回合 model）。
//
// 为什么是映射表而不是「查模型」：① 代理 GET /v1/models 只返回模型清单、无窗口
// 字段；② CLI transcript init 行无 contextWindow；③ CLI 二进制 strings 无模型目录
// ——上游无处可查，这里就是唯一维护点。
//
// 表项来源（均为官方规格或用户实证，有据才进表）：
// - glm-5.3 → 1M：用户 CLI 对照（CLI ~16% vs 200K 口径 81%，恰 5 倍）+ 会话转录
//   2959 主链回合 per-call 水位峰值 866906、165 条超 200K、867K→117K 骤降 = 1M
//   窗口 ~87% 全量压缩边界（#72 当年看到的 165-166K 边界实为 microcompact）。
// - glm-5 / 5.1 / 5.2 → 1M：z.ai 官方规格（GLM-5.2 "usable 1M-token context"）。
// - glm-4.7 → 1M：Cursor 端点显示旁证（官方规格未查到，存疑可 env 覆盖）。
// - glm-4.6 → 200K：z.ai 官方（128K→200K 扩容）。
// - glm-4.5（含 air）→ 128K：z.ai 官方。
// - glm-5 系 flash/turbo 变体 → 随 5 系前缀按 1M。
// 未知模型默认 200K（Anthropic 系标准窗口量级）；显示用途宁可随代际走前缀规则，
// 个别型号偏差可由 env 精确覆盖。
//
// 水位显示如实反映 used/limit；压缩节奏仍完全归 CLI 管，这里只做显示。

export const CONTEXT_LIMIT_DEFAULT = 200_000;

// env 一票覆盖（数字，token 数）：自定义模型/未收录型号/官方规格调整时，
// 无需发版即可纠偏。启动时读一次并缓存。
function envOverride(): number | undefined {
  const raw = process.env.CCR_CONTEXT_LIMIT;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function contextLimitOf(model: string | undefined): number {
  const o = envOverride();
  if (o !== undefined) return o;
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return CONTEXT_LIMIT_DEFAULT;
  if (m.startsWith("glm-5")) return 1_000_000; // 5 / 5-turbo / 5.1 / 5.2 / 5.3 / 5.3-flash(x)
  if (m.startsWith("glm-4.7")) return 1_000_000; // Cursor 端点旁证，存疑
  if (m.startsWith("glm-4.6")) return 200_000; // 官方
  if (m.startsWith("glm-4.5")) return 128_000; // 官方（含 4.5-air）
  return CONTEXT_LIMIT_DEFAULT;
}

// 回放还原水位时的真实性上限（#72 follow-up）：真实 per-call 水位可以短暂越窗
// （1M 窗口实测峰值 867K，越窗余量按 1.5M 放宽）；旧版 bug 把「回合聚合 usage」
// 当水位写进事件流的污染值（忙会话动辄数百万）越此上限一律丢弃——重启后新回合
// 首个 assistant 会写回真实值，被丢弃的会话只是短暂无水位条（远好于假 >100%）。
export const REPLAY_CONTEXT_MAX = 1_500_000;
