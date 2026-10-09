// 主题调色板：W-EXPO 阶段二 005 化（2026-10-09）——色值从设计权威
// web-console/index-005.html 的 CSS 变量区（:root 暗色 / html[data-theme=light] 亮色）
// 逐键直译，暗亮双主题同名键；旧接口键全部保留（全端引用零改动即整体换装），
// 005 新增键（textStrong/qRow*/ctx*/tag*/me*/art* 六类分色等）随阶段三~五接入。
// 更新 token 时以 index-005.html 为准同步两端。
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
  // 列表页"新建会话"FAB：中性面板口径 + 品牌橙十字（旧结构保留，005 直值）
  fabBg: string;
  fabLine: string;
  fabPlus: string;
  // 详情页命令栏发送键：与输入框同材质 + 品牌橙 ➤（005 --composer-bg/--line）
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
  // 005 :root 直译（暗 #07111D 系）
  bg: "#07111D",
  panel: "#101E2F",
  panel2: "#15273B",
  line: "#203247",       // --line-soft（通用 hairline；描边重档走 lineStrong）
  lineStrong: "#2A4058", // --line
  text: "#C4D0DE",
  textStrong: "#E8EFF8",
  dim: "#9AABBE",
  faint: "#8298B0",
  brandA: "#E2855E",
  brandB: "#F0A06A",
  brandHover: "#F0A06A",
  // 005 状态轴：working/waiting 同黄（待处理灯黄+静态光圈、运行灯黄+呼吸，
  // 靠动画区分——设计稿 .status-dot.waiting/.working 同色）
  working: "#E9B84C",
  waiting: "#E9B84C",
  error: "#EC7472",
  done: "#4BCB91",
  info: "#7EAFE8",
  onDone: "#082116",
  dangerFg: "#EC7472",
  onBrand: "#FFFAF6",
  tintSoft: "rgba(226,133,94,0.08)",
  tintStrong: "rgba(226,133,94,0.16)",
  overlay: "rgba(7,17,29,0.97)",
  fabBg: "#15273B",
  fabLine: "#2A4058",
  fabPlus: "#E2855E",
  sendBg: "#0E1B2B",
  sendLine: "#2A4058",
  sendFg: "#F0A06A",
  // 005 增补键
  hover: "#1D344D",
  chrome: "#070D15",
  headBg: "rgba(11,22,36,0.82)",
  navBg: "rgba(16,30,47,0.96)",
  qRowHov: "rgba(148,163,190,0.07)",
  qRowSel: "rgba(148,163,190,0.14)",
  tagBg: "rgba(83,103,126,0.19)",
  tagBorder: "rgba(111,139,166,0.18)",
  tagInk: "#D7E3EF",
  ctxTrack: "#3A5570",
  ctxSafe: "#4BCB91",
  ctxAttention: "#E9B84C",
  ctxCritical: "#EC7472",
  ctxSafeFill: "#79E3B4",
  ctxAttentionFill: "#F4C95F",
  ctxCriticalFill: "#FF8A87",
  meBg: "#15273B",
  meLine: "#4E6D8E",
  artDoc: "#B7A5F0",
  artSheet: "#E9B84C",
  artCode: "#7EAFE8",
  artImage: "#4BCB91",
  artPkg: "#A9BCD1",
  artAccept: "#F0A06A",
};

export const LIGHT: ThemeColors = {
  // 005 html[data-theme="light"] 直译（暖灰白 #F1F5F8 系）
  bg: "#F1F5F8",
  panel: "#E8EFF5",
  panel2: "#FFFFFF",
  line: "#DCE5EC",
  lineStrong: "#C6D3DF",
  text: "#30465B",
  textStrong: "#15283D",
  dim: "#334B61",
  faint: "#4B6278",
  brandA: "#C86440",
  brandB: "#D9754D",
  brandHover: "#D9754D",
  working: "#A56D00",
  waiting: "#A56D00",
  error: "#C84C51",
  done: "#168D60",
  info: "#3978B8",
  onDone: "#073C27",
  dangerFg: "#C84C51",
  onBrand: "#FFFFFF",
  tintSoft: "rgba(200,100,64,0.08)",
  tintStrong: "rgba(200,100,64,0.14)",
  overlay: "rgba(248,250,252,0.97)",
  fabBg: "#FFFFFF",
  fabLine: "#C6D3DF",
  fabPlus: "#C86440",
  sendBg: "#E8EFF5",
  sendLine: "#C6D3DF",
  sendFg: "#C86440",
  hover: "#DDE8F1",
  chrome: "#E5ECF2",
  headBg: "rgba(248,250,252,0.94)",
  navBg: "rgba(232,239,245,0.97)",
  qRowHov: "rgba(16,24,40,0.05)",
  qRowSel: "rgba(16,24,40,0.09)",
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
  meBg: "#FFFFFF",
  meLine: "#C6D3DF",
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
