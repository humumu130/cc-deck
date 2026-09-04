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
};

export const LIGHT: ThemeColors = {
  bg: "#EEF1F5",
  panel: "#F7F9FB",
  panel2: "#E5EAF1",
  line: "rgba(38,64,96,0.12)",
  text: "#22303E",
  dim: "#5A6B7E",
  faint: "#8697A9",
  brandA: "#2F7FE8",
  brandB: "#6F5FE8",
  // 浅色状态四色与网页端 CSS 浅色变量对齐（两端风格一致）
  working: "#A16207",
  waiting: "#DC2626",
  error: "#C2410C",
  done: "#047857",
  tintSoft: "rgba(47,127,232,0.06)",
  tintStrong: "rgba(47,127,232,0.13)",
  overlay: "rgba(244,246,249,0.97)",
};

// #RRGGBB + alpha -> #RRGGBBAA（RN 支持 8 位 hex）
export const withA = (hex: string, a: number): string => {
  const v = Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${v}`;
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
