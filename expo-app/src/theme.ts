// 主题调色板：W-EXPO 阶段二 005 化（2026-10-09）——色值从设计权威
// web-console/index-005.html 的 CSS 变量区（:root 暗色 / html[data-theme=light] 亮色）
// 逐键直译，暗亮双主题同名键；旧接口键全部保留（全端引用零改动即整体换装），
// 005 新增键（textStrong/qRow*/ctx*/tag*/me*/art* 六类分色等）随阶段三~五接入。
// 更新 token 时以 index-005.html 为准同步两端。
// 2026-10-14 拍板品牌色统一橙（#109①）：brand 族键（brandA/B/Hover、tint*、
// qRowSel、fabPlus、sendFg、onBrand、me*）改以 docs/mockups/v8-ui-interactive-v3.html
// 手机壳段（--p-brand 系）为准；其余中性/状态/语义键仍循 index-005.html。
export interface ThemeColors {
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  lineStrong: string;
  text: string;
  textStrong: string;
  dim: string;
  faint: string;
  brandA: string;
  brandB: string;
  brandHover: string;
  working: string;
  waiting: string;
  error: string;
  done: string;
  info: string;
  // 实心绿钮文字 / 红系可读文字（005 --done-ink）
  onDone: string;
  dangerFg: string;
  onBrand: string;
  tintSoft: string;    // 品牌色弱底（chip/卡片叠层，005 --mobile-active-bg）
  tintStrong: string;  // 选中态底（005 --action-bg）
  overlay: string;     // 命令栏等近实底
  // 列表页"新建会话"FAB：中性面板口径 + 品牌色十字（旧结构保留）
  fabBg: string;
  fabLine: string;
  fabPlus: string;
  // 详情页命令栏发送键：与输入框同材质 + 品牌色 ➤（005 --composer-bg/--line）
  sendBg: string;
  sendLine: string;
  sendFg: string;
  // ---------- 005 增补键 ----------
  hover: string;       // 交互 hover 底（--hover）
  chrome: string;      // 顶栏/窗铬底（--chrome）
  headBg: string;      // 手机头部底（--mobile-head-bg）
  navBg: string;       // 手机底部导航底（--mobile-nav-bg）
  qRowHov: string;     // 通栏行扫过淡底（--q-row-hov）
  qRowSel: string;     // 通栏行选中淡底（--q-row-sel）
  tagBg: string;       // tag 胶囊底（--tag-bg）
  tagBorder: string;   // tag 胶囊描边（--tag-border）
  tagInk: string;      // tag 胶囊文字（--tag-ink）
  ctxTrack: string;    // 水位计/微型条轨道（--ctx-track）
  ctxSafe: string;     // 水位分级：安全（--ctx-safe）
  ctxAttention: string; // 水位分级：注意（--ctx-attention）
  ctxCritical: string; // 水位分级：紧张（--ctx-critical）
  ctxSafeFill: string;     // 水位条填充：安全（--ctx-safe-fill）
  ctxAttentionFill: string; // 水位条填充：注意（--ctx-attention-fill）
  ctxCriticalFill: string; // 水位条填充：紧张（--ctx-critical-fill）
  meBg: string;        // 用户消息气泡底（--me-bg）
  meLine: string;      // 用户消息气泡描边（--me-line）
  artDoc: string;      // #168 输出物六类分色（只染瓦片）：doc 紫
  artSheet: string;    // sheet 琥珀
  artCode: string;     // code=info
  artImage: string;    // image=done
  artPkg: string;      // pkg 中性
  artAccept: string;   // accept=brand 系
}

export const DARK: ThemeColors = {
  // V8 手机壳直译（品牌色已统一橙 · 1014 拍板；会话详情只消费 token，不改信息架构）
  // 品牌族色值照抄 v8-ui-interactive-v3.html 手机壳段：--p-brand #EC9A73 /
  // --p-brand2 #C96442 / soft·line 系 rgba(224,138,99,·)
  bg: "#070D18",
  panel: "#0C1727",
  panel2: "#122034",
  line: "#1A2942",       // --p-line
  lineStrong: "#29415F",
  text: "#C9D8EA",
  textStrong: "#EAF2FC",
  dim: "#8CA3BF",
  faint: "#546784",
  brandA: "#EC9A73",
  brandB: "#C96442",
  brandHover: "#F0AF91",
  working: "#FFC53D",
  waiting: "#FFC53D",
  error: "#F0524F",
  done: "#35DC97",
  info: "#7CB8FF",
  onDone: "#062619",
  dangerFg: "#FF7B78",
  onBrand: "#FFFFFF",
  tintSoft: "rgba(224,138,99,0.13)",
  tintStrong: "rgba(224,138,99,0.20)",
  overlay: "rgba(7,13,24,0.97)",
  fabBg: "#122034",
  fabLine: "#29415F",
  fabPlus: "#EC9A73",
  sendBg: "#0C1727",
  sendLine: "#29415F",
  sendFg: "#EC9A73",
  // 005 增补键
  hover: "#172B46",
  chrome: "#070D18",
  headBg: "rgba(12,23,39,0.96)",
  navBg: "rgba(12,23,39,0.98)",
  qRowHov: "rgba(140,163,191,0.08)",
  qRowSel: "rgba(224,138,99,0.14)",
  tagBg: "rgba(84,103,132,0.19)",
  tagBorder: "rgba(117,145,180,0.22)",
  tagInk: "#DCE9F8",
  ctxTrack: "#263B59",
  ctxSafe: "#35DC97",
  ctxAttention: "#FFC53D",
  ctxCritical: "#F0524F",
  ctxSafeFill: "#7FE8B7",
  ctxAttentionFill: "#FFD76C",
  ctxCriticalFill: "#FF8582",
  meBg: "rgba(224,138,99,0.13)",
  meLine: "rgba(224,138,99,0.45)",
  artDoc: "#B7A5F0",
  artSheet: "#E9B84C",
  artCode: "#7EAFE8",
  artImage: "#4BCB91",
  artPkg: "#A9BCD1",
  artAccept: "#F0A06A",
};

export const LIGHT: ThemeColors = {
  // V8 手机壳浅色档（与 --p-* light token 同源；品牌橙亮档 v3：#B85228/#96391A、
  // soft·line 系 rgba(192,91,51,·)）
  bg: "#F1F4F9",
  panel: "#FFFFFF",
  panel2: "#ECF1F8",
  line: "#E2E9F2",
  lineStrong: "#C8D5E5",
  text: "#34445C",
  textStrong: "#16202F",
  dim: "#66758E",
  faint: "#8494AC",
  brandA: "#B85228",
  brandB: "#96391A",
  brandHover: "#C2603E",
  working: "#E0A43C",
  waiting: "#E0A43C",
  error: "#D63B3B",
  done: "#22A06B",
  info: "#3978B8",
  onDone: "#073C27",
  dangerFg: "#C22F2F",
  onBrand: "#FFFFFF",
  tintSoft: "rgba(192,91,51,0.10)",
  tintStrong: "rgba(192,91,51,0.16)",
  overlay: "rgba(241,244,249,0.98)",
  fabBg: "#FFFFFF",
  fabLine: "#C8D5E5",
  fabPlus: "#B85228",
  sendBg: "#ECF1F8",
  sendLine: "#C8D5E5",
  sendFg: "#B85228",
  hover: "#E2E9F2",
  chrome: "#F1F4F9",
  headBg: "rgba(255,255,255,0.96)",
  navBg: "rgba(255,255,255,0.98)",
  qRowHov: "rgba(16,24,40,0.05)",
  qRowSel: "rgba(192,91,51,0.10)",
  tagBg: "rgba(132,151,169,0.16)",
  tagBorder: "rgba(96,117,138,0.24)",
  tagInk: "#2D4358",
  ctxTrack: "#C6D3DF",
  ctxSafe: "#168D60",
  ctxAttention: "#A56D00",
  ctxCritical: "#C84C51",
  ctxSafeFill: "#168D60",
  ctxAttentionFill: "#A56D00",
  ctxCriticalFill: "#C84C51",
  meBg: "rgba(192,91,51,0.10)",
  meLine: "rgba(192,91,51,0.35)",
  artDoc: "#6D5BD8",
  artSheet: "#A56D00",
  artCode: "#3978B8",
  artImage: "#168D60",
  artPkg: "#5B7186",
  artAccept: "#C86440",
};

// #RRGGBB + alpha -> #RRGGBBAA（RN 支持 8 位 hex）
export const withA = (hex: string, a: number): string => {
  const v = Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${v}`;
};

// 两 hex 预混合（t=0 取 a，t=1 取 b），输出不透明 hex。玻璃浮钮染底一律
// 用 mix(前景, 页面底, t) 预混合成不透明色，观感与真半透明一致且无分层
export const mix = (a: string, b: string, t: number): string => {
  const pa = [0, 2, 4].map((i) => parseInt(a.slice(1 + i, 3 + i), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.slice(1 + i, 3 + i), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.min(1, Math.max(0, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

// 兼容旧引用（静态场景）；组件内请用 useTheme()
export const C = DARK;

// 引擎标识色（index-005.html --engine-* 直值，web/桌面/手机三端同源）：
// 仅标识轴（这是哪个引擎），与状态轴（done/working/waiting/error/faint）两套
// 不同轴勿混——状态词徽章配色走主题四色
export const ENGINE_ACCENT: Record<string, string> = {
  claude: "#A97A62",
  codex: "#8DABFF",
  trae: "#58C9B1",
  "qwen-code": "#B493FF",
  codebuddy: "#4BA8F0",
  zcode: "#E58DB0",
};

// 005 STATUS_TAG 口径（index-005.html :1484）：WAITING 词面从「等待确认」
// 收敛为「待处理」（与桌面 tag/待处理组同词）
export const STATUS_ZH: Record<string, string> = {
  WORKING: "运行中",
  WAITING: "待处理",
  ERROR: "错误",
  DONE: "已完成",
};

export const statusColor = (s: string, c: ThemeColors = DARK) =>
  s === "WORKING" ? c.working : s === "WAITING" ? c.waiting : s === "ERROR" ? c.error : c.done;
