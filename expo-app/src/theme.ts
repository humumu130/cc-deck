// 主题调色板：深色（默认，cc light 风格）+ 浅色
export interface ThemeColors {
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  text: string;
  dim: string;
  faint: string;
  brandA: string;
  brandB: string;
  working: string;
  waiting: string;
  error: string;
  done: string;
  tintSoft: string;    // 品牌色弱底（chip/卡片叠层）
  tintStrong: string;  // 选中态底
  overlay: string;     // 命令栏等近实底
  // 列表页"新建会话"FAB（2026-09-18 亮色二次反馈：品牌蓝底太突兀）：
  // 深色保持原观感（近黑底+暖橙十字），浅色走中性面板口径（暖白底+灰描边+深灰十字）
  fabBg: string;
  fabLine: string;
  fabPlus: string;
  // 详情页命令栏发送键（2026-09-18 亮色反馈定稿、2026-09-19 #48 补暗色）：
  // 两主题同规则——与并排输入框同材质（panel2 底 + line 描边）+ 品牌橙 ➤
  // （FAB 十字同为品牌橙，按钮符号色全端一致；废止暗色品牌蓝实底）
  sendBg: string;
  sendLine: string;
  sendFg: string;
}

export const DARK: ThemeColors = {
  bg: "#050B12",
  panel: "#0B1622",
  panel2: "#101F30",
  line: "rgba(125,165,220,0.10)",
  text: "#E8F0FA",
  dim: "#7B93AE",
  faint: "#4A5F78",
  brandA: "#4D9FFF",
  brandB: "#7C6CF2",
  working: "#FFC53D",
  waiting: "#F0524F",
  error: "#FF7849",
  done: "#2BD98F",
  tintSoft: "rgba(125,165,220,0.08)",
  tintStrong: "rgba(93,134,245,0.16)",
  overlay: "rgba(8,15,26,0.97)",
  fabBg: "#1D1726",
  fabLine: "rgba(255,255,255,0.09)",
  fabPlus: "#D97757",
  // #48：暗色与亮色统一（用户 2026-09-19 反馈）——同输入框材质 + 品牌橙 ➤
  sendBg: "#101F30",
  sendLine: "rgba(125,165,220,0.10)",
  sendFg: "#D97757",
};

export const LIGHT: ThemeColors = {
  // #351 浅色降刺眼：冷白偏暖灰（蓝灰相→暖灰相），整体压暗半档；panel 从近纯白降为暖白
  bg: "#E9EAE4",
  panel: "#F2F3EE",
  panel2: "#E2E4DC",
  line: "rgba(52,58,50,0.13)",
  text: "#29302A",
  dim: "#5D665C",
  faint: "#8B938A",
  brandA: "#2F7FE8",
  brandB: "#6F5FE8",
  // 浅色状态四色与网页端 CSS 浅色变量对齐（两端风格一致）
  working: "#A16207",
  waiting: "#DC2626",
  error: "#C2410C",
  done: "#047857",
  tintSoft: "rgba(47,127,232,0.06)",
  tintStrong: "rgba(47,127,232,0.13)",
  overlay: "rgba(240,241,236,0.97)",
  fabBg: "#E2E4DC",
  fabLine: "rgba(52,58,50,0.13)",
  // #23 补：浅色十字/箭头回归品牌橙（与深色 FAB 十字同色），中性面板上保品牌识别
  fabPlus: "#D97757",
  sendBg: "#E2E4DC",
  sendLine: "rgba(52,58,50,0.13)",
  sendFg: "#D97757",
};

// #RRGGBB + alpha -> #RRGGBBAA（RN 支持 8 位 hex）
export const withA = (hex: string, a: number): string => {
  const v = Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${v}`;
};

// 两 hex 预混合（t=0 取 a，t=1 取 b），输出不透明 hex。#17 白块根因：elevation 阴影
// 会从半透明底后面不均匀透出（边缘浓成灰环、中心无阴影成亮块）——玻璃浮钮染底一律
// 用 mix(前景, 页面底, t) 预混合成不透明色，观感与真半透明一致且无分层（品红实验定案）
export const mix = (a: string, b: string, t: number): string => {
  const pa = [0, 2, 4].map((i) => parseInt(a.slice(1 + i, 3 + i), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.slice(1 + i, 3 + i), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.min(1, Math.max(0, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

// 兼容旧引用（静态场景）；组件内请用 useTheme()
export const C = DARK;

export const STATUS_ZH: Record<string, string> = {
  WORKING: "运行中",
  WAITING: "等待确认",
  ERROR: "错误",
  DONE: "已完成",
};

export const statusColor = (s: string, c: ThemeColors = DARK) =>
  s === "WORKING" ? c.working : s === "WAITING" ? c.waiting : s === "ERROR" ? c.error : c.done;
