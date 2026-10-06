// #72 E 线 产物中心（全局产物池 A 单源）expo 域纯函数。
// 零依赖纯 TS（不 import react/react-native）——ArtPoolModal（screens/ArtPoolModal.tsx）
// 消费 + scripts/test-e-artifacts-entry.ts 直跑断言共用同一条判定路径（notify-jump.ts
// 同范式：测的就是跑的）。
//
// 规格依据（docs/reviews/2026-10-06-72w0-worker-h.md 四裁定 + W 线 03e8fcd 对表）：
// - 数据源 = 产物池 A 单源（/api/artifacts 全局目录视图，relay 既有端点只读消费），
//   与会话账 deliverables 语义正交，禁双源拼装；
// - 降级面 = fetch 探测失败即藏（首连探测一次，404/401/网络错 → no → 入口隐藏；
//   401 不当空池——凭据问题不是空目录）；#71 总开关（deliverables）同门控；
//   **判据 = fetch 探测，禁 schema 版本门控**（artifacts 端点始于 2026-09-14 早于
//   schema_version 首现，版本判据会误杀该窗口 relay——勘误级实锤，三端一致）；
// - 动作通道 = HTTP 直取 /artifacts/<name>?token=（LAN 静态服务；池条目是全局扫描
//   相对名，不在会话账授权锚点内，ws 的 COMMAND_ARTIFACT_FETCH 通道校验 path 必须
//   命中该会话 artifacts 账，池条目不可走）——web W 线同款；
// - token 只在 store 内部使用不进 UI（本模块只接收组装好的参数，不感知来源）。

import { fmtLastActive } from "./fmt";

// ---------- ArtViewData 类型权威（自 DetailScreen.tsx 迁入，DetailScreen re-export 兼容） ----------

// #79 拉取结果分级：img=内嵌图片；html=WebView 渲染（报告类主格式，看源码没意义）；
// txt/md=内嵌文本（md 走 MdText）；sys=复杂格式（pdf/office/zip…）落盘后交系统应用打开
export type ArtViewData =
  | { kind: "img"; name: string; uri: string; size: number }
  | { kind: "html"; name: string; text: string; size: number }
  | { kind: "txt"; name: string; text: string; size: number }
  | { kind: "md"; name: string; text: string; size: number }
  | { kind: "sys"; name: string; uri: string; mime: string; size: number };

export function decodeUtf8(u8: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(u8);
}

// #79 mime 分级路由（单口径）：会话账拉取（DetailScreen.fetchArtView）与池 HTTP 直取
// （ArtPoolModal）共用同一把分级尺——防双口径漂移（同一文件两端分级不一致）。
// mime 参数段自剥（"text/html; charset=utf-8" → "text/html"）：会话账 ACK 的 mime 是
// 裸值，池面 HTTP header 带参数——单口径函数自身健壮，不靠调用方预处理。
// uri 仅 img/sys 两级使用（内嵌/落盘路径），文本级忽略
export function artDataOf(u8: Uint8Array, mime: string, name: string, uri: string): ArtViewData {
  const m = (mime || "").split(";")[0].trim();
  if (m.startsWith("image/")) return { kind: "img", name, uri, size: u8.length };
  if (m === "text/html") return { kind: "html", name, text: decodeUtf8(u8), size: u8.length };
  if (m === "text/markdown") return { kind: "md", name, text: decodeUtf8(u8), size: u8.length };
  if (m.startsWith("text/") || m === "application/json") return { kind: "txt", name, text: decodeUtf8(u8), size: u8.length };
  return { kind: "sys", name, uri, mime: m || "application/octet-stream", size: u8.length };
}

// ---------- 三重门（W 线 artPoolGate 同构镜像） ----------

// 池入口门（web: ctx._artPool==="yes" && ctx.deliverables===true && ctx.status==="online"）：
// 任一门不过 = 入口整体隐藏（降级=下线不灰置）。三输入全部鸭子判定（unknown 收窄），
// SourceStatus 传入即可，不 import store（零依赖直跑）。
// - artPool === "yes"：探测通过（fetch /api/artifacts 首连探测一次成功；"pending"=
//   未探明、"no"=探测失败——两者都 false）
// - deliverables === true：#71 输出物看板总开关（同门控，W 线裁定③）
// - state === "online"：源在线（离线源没有可达的 HTTP 面，探了也白探）
export function artPoolGate(s: { artPool?: unknown; deliverables?: unknown; state?: unknown } | null | undefined): boolean {
  if (!s || typeof s !== "object") return false;
  return s.artPool === "yes" && s.deliverables === true && s.state === "online";
}

// ---------- 池条目规范化（W 线 artPoolItemsOf 同构镜像） ----------

// /api/artifacts 响应条目形状（relay/src/artifacts.ts listArtifacts）：{name,size,mtime}，
// mtime 降序。池条目无 unknown/existence 字段——lstat 扫描即实存（unknown 护栏在动作
// 时刻由 poolNameOk + HTTP 404 承载，不在列表层猜测）
export interface ArtPoolItem {
  name: string;
  size: number;
  mtime: number;
}

// 响应规范化：非数组/条目畸形一律安全剔除（不炸不假造）；保 relay 原序（mtime 降序，
// 排序属 relay 呈现口径，客户端不重排防两端口序漂移）
export function artPoolItemsOf(raw: unknown): ArtPoolItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ArtPoolItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) continue;
    out.push({
      name: o.name,
      size: typeof o.size === "number" && Number.isFinite(o.size) && o.size >= 0 ? o.size : 0,
      mtime: typeof o.mtime === "number" && Number.isFinite(o.mtime) && o.mtime > 0 ? o.mtime : 0,
    });
  }
  return out;
}

// ---------- 名字合法性（unknown 护栏客户端先拒） ----------

// relay serveArtifact 的 ARTIFACT_NAME_RE 客户端镜像（relay/src/artifacts.ts:31,315）：
//   ^[\w一-鿿][\w一-鿿.-]*(/[\w一-鿿][\w一-鿿.-]*)?$  且拒反斜杠
// 即：1~2 段（最多一层子目录）、段首字符非点（拒隐藏文件/相对点段）、段内 \w + 汉字 +
// 点连字符。列表后文件可能已被清理或 relay 端尺收紧——客户端先拒一眼能拒的（.. 穿越、
// 反斜杠、隐藏文件、深嵌套），畸形名不发请求（HTTP 404 兜底不可达名）。
const POOL_SEG = /^[\w一-鿿][\w一-鿿.-]*$/;
export function poolNameOk(name: unknown): name is string {
  if (typeof name !== "string" || !name || name.includes("\\")) return false;
  const segs = name.split("/");
  if (segs.length > 2) return false; // relay 只容一层子目录
  return segs.every((s) => POOL_SEG.test(s));
}

// ---------- 动作 URL（W 线池动作通道同款） ----------

// HTTP 直取 URL：/artifacts/<name>?token=（relay ws-server 静态服务，ARTIFACT_NAME_RE +
// realpath 双重防穿越）。name 含子目录斜杠时 encodeURIComponent 整体编码（web W 线同款，
// relay 端 decodeURIComponent 后按原尺校验）。调用方保证 name 已过 poolNameOk。
export function artPoolUrl(base: string, name: string, token: string): string {
  return `${base}/artifacts/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
}

// 探测/刷新 URL：/api/artifacts?token=（全局目录视图，机器级扫描只读）
export function artPoolListUrl(base: string, token: string): string {
  return `${base}/api/artifacts?token=${encodeURIComponent(token)}`;
}

// ---------- 池视图分组 ----------

// 一级分组：根文件（dir=""）在前、子目录桶按名排序在后；组内保 relay 原序（mtime 降序）。
// 池条目 name 至多一层子目录（poolNameOk 同尺），故 dir 即 name 的 "/" 前段或 ""
export function artPoolGroupsOf(items: ArtPoolItem[]): { dir: string; items: ArtPoolItem[] }[] {
  const root: ArtPoolItem[] = [];
  const dirs = new Map<string, ArtPoolItem[]>();
  for (const it of items) {
    const i = it.name.indexOf("/");
    if (i < 0) root.push(it);
    else {
      const dir = it.name.slice(0, i);
      const bucket = dirs.get(dir);
      if (bucket) bucket.push(it);
      else dirs.set(dir, [it]);
    }
  }
  const out: { dir: string; items: ArtPoolItem[] }[] = [];
  if (root.length) out.push({ dir: "", items: root });
  for (const dir of [...dirs.keys()].sort()) out.push({ dir, items: dirs.get(dir)! });
  return out;
}

// ---------- 尺寸/时间显示（自 DetailScreen.tsx 迁入，池行与会话账行同语言） ----------

// 输出物尺寸：B/KB/MB 三档（#79 既有口径原样；<10KB 留一位小数）
export function fmtArtSize(n: number | undefined): string {
  if (typeof n !== "number" || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

// 输出物时间：#162 套用 #155 微信式分级（当天 HH:mm / 昨天 / 今年 M月d日 / 跨年带
// 年份，自然日边界）——与卡片最后活跃、web-console 同口径；周X/M/d 旧档位废弃
export function fmtArtTime(ts: number): string {
  if (!ts) return "";
  return fmtLastActive(ts);
}
