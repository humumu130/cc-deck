// W-HEADUNI（用户 1020 口径+#148 返工收敛）：手机端全页面 head 高度单一基准。
// 基准=会话列表页（ListScreen topbar）：paddingHorizontal 12 / paddingVertical 4 /
// minHeight 48 / 底边框 1.5 lineStrong / 底色 bg——全部页面（4 主 tab+全部二级页）
// 的 head 容器统一引本常量，禁止各页写死魔法数。
// 注：详情页 #148 曾以自身 d.head（边框 1/line/无 minHeight）为对齐源——用户 1020
// 改定会话列表页为唯一基准，本常量覆盖旧口径（minHeight 48 兜底内容波动）。
export const HEAD_BASE = {
  paddingHorizontal: 12,
  paddingVertical: 4,
  minHeight: 48,
} as const;

/** 统一 head 容器样式基（spread 进各页 StyleSheet.create 的 head 键；边框/底色按页语言保留差异项时显式覆盖） */
export const HEAD_BASE_STYLE = {
  ...HEAD_BASE,
  borderBottomWidth: 1,
  borderBottomColor: undefined as unknown as string, // 占位：消费方以 c.line / c.lineStrong 显式给（theme 闭包外不可引 c）
} as const;
