// Artifacts 产物中心（2026-09-14）：~/.cc-deck/artifacts/ 目录的列表与安全静态服务。
// CLI（会话）把输出物（设计稿/报告/导出包）写入该目录即对全部客户端可见——手机/网页
// 经 /api/artifacts 列表 + /artifacts/<file> 取用，桌面端"输出物"区同理。
// 安全：文件名白名单（同云桥 /dl/ 风格）+ resolve 后必须仍位于产物目录内（防穿越）。
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { homedir } from "node:os";

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
