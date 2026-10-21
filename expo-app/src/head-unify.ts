// W-HEADUNI（用户 1020 口径+#148 返工收敛）：手机端全页面 head 高度单一基准。
// 基准=会话列表页（ListScreen topbar）：paddingHorizontal 12 / paddingVertical 4 /
// 高度 48（固定）/ 底边框 1.5 lineStrong / 底色 bg——全部页面（4 主 tab+全部二级页）
// 的 head 容器统一引本常量，禁止各页写死魔法数。
// 注：详情页 #148 曾以自身 d.head（边框 1/line/无 minHeight）为对齐源——用户 1020
// 改定会话列表页为唯一基准，本常量覆盖旧口径。
// #191 根修（W-HEADFIX-R，test.46 用户实测三档高度）：minHeight→height 固定——
// minHeight 只兜下限，内容行数/pill 撑行的 ±1~2px 波动（titleRow 26 + subRow 15 +
// padV 8 = 49 之类）会让各页渲染出 48/49/50 不同档；固定 height 48 + 容器
// alignItems:center（各消费面本就有）=内容垂直居中、总高恒 48，不再靠 minHeight
// 碰运气。内容行已按 48 预算收口（subRow mt 2→1，见 page-head.tsx）。
export const HEAD_BASE = {
  paddingHorizontal: 12,
  paddingVertical: 4,
  height: 48,
} as const;
