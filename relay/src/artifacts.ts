// Artifacts 产物中心（2026-09-14）：~/.cc-deck/artifacts/ 目录的列表与安全静态服务。
// CLI（会话）把输出物（设计稿/报告/导出包）写入该目录即对全部客户端可见——手机/网页
// 经 /api/artifacts 列表 + /artifacts/<file> 取用，桌面端"输出物"区同理。
// 安全：文件名白名单（同云桥 /dl/ 风格）+ resolve 后必须仍位于产物目录内（防穿越）。
// #72A0（2026-10-05 安全批）：symlink 越界/TOCTOU 修复——serve 走 realpath containment +
// fd 级读取（O_NOFOLLOW/fstat），list 判型不跟随，deliver 校验闸一次性采集 stat 快照。
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { ArtifactItem } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const ARTIFACT_SEGMENT = "[\\w一-鿿][\\w一-鿿.-]*";
const ARTIFACT_NAME_RE = new RegExp(`^${ARTIFACT_SEGMENT}(?:/${ARTIFACT_SEGMENT})?$`);

export function artifactsDir(): string {
  // CCR_ARTIFACTS_DIR 覆盖（测试隔离用）；默认全局产物目录 ~/.cc-deck/artifacts/
  return process.env.CCR_ARTIFACTS_DIR || join(homedir(), ".cc-deck", "artifacts");
}

export interface ArtifactGroupingItem extends Pick<ArtifactItem, "path" | "last_at"> {
  exists?: boolean;
  source_id?: string;
  sourceId?: string;
  source_reachable?: boolean;
  sourceReachable?: boolean;
  reachable?: boolean;
  failed?: boolean;
  failure?: string | boolean;
  error?: string | boolean;
  download_failed?: boolean;
  download_status?: string;
  download?: { failed?: boolean; status?: string };
}

export interface ArtifactGroupOptions {
  cwd?: string;
  session_cwd?: string;
  sessionCwd?: string;
  source_id?: string;
  sourceId?: string;
  source_reachable?: boolean;
  sourceReachable?: boolean;
}

export interface ArtifactGroupActionReservation {
  kind: "download" | "reconnect";
  enabled: boolean;
}

// Reserved for a future group download job. This batch does not start or track transport.
export interface ArtifactGroupDownloadState {
  job_id: string | null;
  progress: number | null;
  partial_failure: boolean;
  retryable: boolean;
}

export interface ArtifactGroup {
  group_key: string;
  directory_key: string;
  directory_label: string;
  source_id: string;
  items: ArtifactGroupingItem[];
  file_count: number;
  failed_count: number;
  latest_at: number;
  last_at: number;
  has_downloadable: boolean;
  reachable: boolean;
  collapsed: boolean;
  batch_action: ArtifactGroupActionReservation;
  recovery_action: ArtifactGroupActionReservation;
  download: ArtifactGroupDownloadState;
}

export interface ArtifactGroupSummary {
  file_count: number;
  failed_count: number;
  latest_at: number;
  source_id: string;
  reachable: boolean;
}

function normalizedPath(path: string): string {
  const value = normalize(path || ".").replaceAll("\\", "/");
  if (value.length > 1) return value.replace(/\/+$/, "");
  return value;
}

function parentPath(path: string): string {
  return normalizedPath(dirname(path));
}

function sourceIdOf(item: ArtifactGroupingItem, opts: ArtifactGroupOptions): string {
  return String(item.source_id ?? item.sourceId ?? opts.source_id ?? opts.sourceId ?? "local").trim() || "local";
}

function sourceReachableOf(item: ArtifactGroupingItem, opts: ArtifactGroupOptions): boolean {
  if (typeof item.source_reachable === "boolean") return item.source_reachable;
  if (typeof item.sourceReachable === "boolean") return item.sourceReachable;
  if (typeof item.reachable === "boolean") return item.reachable;
  if (typeof opts.source_reachable === "boolean") return opts.source_reachable;
  if (typeof opts.sourceReachable === "boolean") return opts.sourceReachable;
  return true;
}

function failedArtifact(item: ArtifactGroupingItem): boolean {
  if (item.failed === true || item.download_failed === true) return true;
  if (typeof item.failure === "string" || item.failure === true) return true;
  if (typeof item.error === "string" || item.error === true) return true;
  if (item.download?.failed === true) return true;
  return [item.download_status, item.download?.status].some((status) => status?.toLowerCase() === "failed");
}

function directoryLabel(parent: string, cwd?: string): string {
  if (!cwd) return parent;
  const label = relative(resolve(cwd), resolve(parent)).replaceAll("\\", "/");
  return label || ".";
}

function cwdOf(opts: ArtifactGroupOptions): string | undefined {
  return opts.cwd ?? opts.session_cwd ?? opts.sessionCwd;
}

// #72A0（P2-3A）：分组键结构化编码——source_id 与 parent 都可能含 "::"，裸拼接可构造
// 跨源混组（如 source "a"+parent "b::c" 与 source "a::b"+parent "c" 同键）。JSON 数组
// 编码使键空间无歧义；group_key 是不透明 id，人类可读展示走 directory_label
export function normalizeArtifactGroupKey(parent: string, source_id: string): string {
  return JSON.stringify([source_id, normalizedPath(parent)]);
}

export function summarizeGroup(group: Pick<ArtifactGroup, "items" | "source_id"> & Partial<Pick<ArtifactGroup, "reachable">>): ArtifactGroupSummary {
  const items = group.items;
  return {
    file_count: items.length,
    failed_count: items.filter(failedArtifact).length,
    latest_at: items.reduce((latest, item) => Math.max(latest, item.last_at), 0),
    source_id: group.source_id,
    reachable: group.reachable !== false,
  };
}

export function groupArtifacts(items: readonly ArtifactGroupingItem[], opts: ArtifactGroupOptions = {}): ArtifactGroup[] {
  const groups = new Map<string, { group: ArtifactGroup; order: number }>();
  items.forEach((item, index) => {
    const parent = parentPath(item.path);
    const source_id = sourceIdOf(item, opts);
    const group_key = normalizeArtifactGroupKey(parent, source_id);
    let entry = groups.get(group_key);
    if (!entry) {
      entry = {
        order: index,
        group: {
          group_key,
          directory_key: parent,
          directory_label: directoryLabel(parent, cwdOf(opts)),
          source_id,
          items: [],
          file_count: 0,
          failed_count: 0,
          latest_at: 0,
          last_at: 0,
          has_downloadable: false,
          reachable: true,
          collapsed: false,
          batch_action: { kind: "download", enabled: true },
          recovery_action: { kind: "reconnect", enabled: false },
          download: { job_id: null, progress: null, partial_failure: false, retryable: false },
        },
      };
      groups.set(group_key, entry);
    }
    entry.group.items.push(item);
    entry.group.reachable = entry.group.reachable && sourceReachableOf(item, opts);
  });

  return [...groups.values()]
    .map(({ group, order }) => {
      group.items = group.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => b.item.last_at - a.item.last_at || a.item.path.localeCompare(b.item.path) || a.index - b.index)
        .map(({ item }) => item);
      const summary = summarizeGroup(group);
      group.file_count = summary.file_count;
      group.failed_count = summary.failed_count;
      group.latest_at = summary.latest_at;
      group.last_at = summary.latest_at;
      group.has_downloadable = group.reachable && group.items.some((item) => item.exists !== false && !failedArtifact(item));
      group.recovery_action.enabled = !group.reachable;
      return { group, order };
    })
    .sort((a, b) => b.group.latest_at - a.group.latest_at || a.order - b.order)
    .map(({ group }) => group);
}

export function listArtifacts(): { name: string; size: number; mtime: number }[] {
  const dir = artifactsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; size: number; mtime: number }[] = [];
  const addFile = (name: string, path: string): void => {
    if (name.startsWith(".")) return;
    try {
      // #72A0（P1-1A）：lstat 不跟随——symlink 条目按本体判型，外部目标的
      // size/mtime 不得列进面板（d_type 未知兜底场景由下方 Dirent 判型前置挡掉）
      const st = lstatSync(path);
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch {}
  };
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    // #72A0（P1-1A）：symlink 一律跳过不跟随——文件 link（可能指向根外）与目录
    // link（可能递归带出根外整棵树）都不进列表
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      let children: import("node:fs").Dirent[];
      try {
        children = readdirSync(path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.name.startsWith(".")) continue;
        if (child.isSymbolicLink()) continue;
        addFile(`${entry.name}/${child.name}`, join(path, child.name));
      }
    } else {
      addFile(entry.name, path);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export interface DeliverablePathValidation {
  ok: boolean;
  path: string;
  error?: string;
  /** 校验同一时刻采集的 stat 快照（fstat 与 open 同一 fd）；unverified 时为 null */
  size?: number | null;
  mtime?: number | null;
  /** 路径含 symlink 分量：原地交付物合法不拒绝，但目标元数据不得当文件本体记账 */
  unverified?: boolean;
}

// /api/deliver 的登记前安全闸：只允许存在、可读的普通文件，且返回规范化绝对路径。
// 调用方必须在任何 session 归因/回退之前调用，避免幽灵登记或错挂其他会话。
// #72A0（P1-1B）：校验一次性完成——open 即读权限判定的唯一时刻（不可读直接打开
// 失败），isFile/size/mtime 由同一 fd 的 fstat 采集，消灭「先 stat 后 access 再用」
// 的 check-then-use 窗口；快照随结果返回，登记方应直接用它、不再二次 stat。
export function validateDeliverablePath(rawPath: string): DeliverablePathValidation {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, path: "", error: "path 必须是非空文件路径" };
  const path = resolve(trimmed);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EISDIR") {
      return { ok: false, path, error: `交付物必须是普通文件: ${path}` };
    }
    return { ok: false, path, error: `交付物不存在或不可访问: ${path}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, path, error: `交付物必须是普通文件: ${path}` };
    // symlink 分量检测：末段本体是 link，或父链某段经 symlink 解析（realpath 与词法
    // 路径不一致，macOS /tmp→/private/tmp 也算）。原地交付物合法不拒绝，但快照留空
    // ——symlink 目标的元数据不得当文件本体记账
    let unverified = false;
    try {
      unverified = lstatSync(path).isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path);
    } catch {
      unverified = true;
    }
    if (unverified) return { ok: true, path, size: null, mtime: null, unverified: true };
    return { ok: true, path, size: st.size, mtime: st.mtimeMs, unverified: false };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

// 命中并写出返回 true；文件名非法/不存在返回 false（调用方 404）
// 文件名允许中文（2026-09-19）：中文命名交付物（工作报告-….html）列得出就要下
// 得了，原 \w 正则对中文一律 404
// #72A0（P1-1A/1B）：两道闸——①词法快筛后必须 realpath 求真实路径做 containment
// （目录内 symlink 指向根外时词法通过但真实越界；断链/循环按不存在 404）；
// ②读取走 fd 级：open（O_NOFOLLOW 拒末段 symlink 竞态替换）→ fstat（isFile/size
// 与读同一 fd，content-length 不会错配他文件）→ 从 fd 读内容。
export function serveArtifact(name: string, res: import("node:http").ServerResponse): boolean {
  if (!ARTIFACT_NAME_RE.test(name) || name.includes("\\")) return false;
  const dir = resolve(artifactsDir());
  let realRoot: string;
  try {
    realRoot = realpathSync(dir);
  } catch {
    return false;
  }
  const full = resolve(join(dir, name));
  if (!full.startsWith(dir + sep) || relative(dir, full).split(sep).length > 2) return false;
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return false;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return false;
  if (relative(realRoot, real).split(sep).length > 2) return false;
  const type = MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return false;
    const data = readFileSync(fd);
    res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "no-store" });
    res.end(data);
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
