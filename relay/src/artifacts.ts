// Artifacts 产物中心（2026-09-14）：~/.cc-deck/artifacts/ 目录的列表与安全静态服务。
// CLI（会话）把输出物（设计稿/报告/导出包）写入该目录即对全部客户端可见——手机/网页
// 经 /api/artifacts 列表 + /artifacts/<file> 取用，桌面端"输出物"区同理。
// 安全：文件名白名单（同云桥 /dl/ 风格）+ resolve 后必须仍位于产物目录内（防穿越）。
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
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

export function normalizeArtifactGroupKey(parent: string, source_id: string): string {
  return `${source_id}::${normalizedPath(parent)}`;
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
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; size: number; mtime: number }[] = [];
  for (const f of files) {
    if (f.startsWith(".")) continue;
    try {
      const st = statSync(join(dir, f));
      if (st.isFile()) out.push({ name: f, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// 命中并写出返回 true；文件名非法/不存在返回 false（调用方 404）
// 文件名允许中文（2026-09-19）：中文命名交付物（工作报告-….html）列得出就要下
// 得了，原 \w 正则对中文一律 404
export function serveArtifact(name: string, res: import("node:http").ServerResponse): boolean {
  if (!/^[\w一-鿿][\w一-鿿.-]*$/.test(name)) return false;
  const dir = resolve(artifactsDir());
  const full = resolve(join(dir, name));
  if (!full.startsWith(dir + "/") && full !== dir) return false;
  const path = full;
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (!st.isFile()) return false;
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  try {
    const data = readFileSync(path);
    res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "no-store" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
