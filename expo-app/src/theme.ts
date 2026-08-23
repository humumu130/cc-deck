export const C = {
  bg: "#050B12",
  panel: "#0B1622",
  panel2: "#101F30",
  line: "rgba(125,165,220,0.10)",
  text: "#E8F0FA",
  dim: "#7B93AE",
  faint: "#4A5F78",
  brandA: "#4D9FFF",
  brandB: "#7C6CF2",
  working: "#2BD98F",
  waiting: "#F5B841",
  error: "#F0524F",
  done: "#4D9FFF",
};

export const STATUS_ZH: Record<string, string> = {
  WORKING: "运行中",
  WAITING: "等待确认",
  ERROR: "错误",
  DONE: "已完成",
};

export const statusColor = (s: string) =>
  s === "WORKING" ? C.working : s === "WAITING" ? C.waiting : s === "ERROR" ? C.error : C.done;
