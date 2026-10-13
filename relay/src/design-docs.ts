// W-DESIGNHUB（2026-10-12）系统设计图纸目录服务：
// ① listDesignDocs(webRoot) 扫 docs/system-design/**.html（两层）生成清单——标题读
//   文件头 <title>（archify 产物自包含，20KB 窗口实测全覆盖）；目录即分组、目录+文件名
//   分词即 tags（项目域匹配面）。SNAPSHOT.design_docs 数据源 + 端上能力位（空数组/缺键
//   = 入口隐藏——旧 relay 与缺 docs 部署自动降级）。
// ② resolveDesignFile(webRoot, relPath)：/design/<rel> 的路径解析与遍历防护（纯函数
//   可单测）——resolve 后必须仍落在 designDir 内（".." 与绝对路径拼入一律 null），
//   .html/.json/.png/.svg 白名单扩展。
// 红线：HTML 原样服务不加工（图纸自带深浅主题与交互，无容器页——新窗直开）。
// 缓存：模块级 mtime 键（目录树 stat 摘要）——SNAPSHOT 每次连接都调，全量重扫+读
// 11 个文件头虽 <10ms，仍按「目录未变不重扫」收口（deploy 换文件后自动失效）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DesignDocItem } from "./types.js";

export type { DesignDocItem };

export const DESIGN_DIR_SEGMENTS = ["docs", "system-design"];

export function designDir(webRoot: string): string {
  return join(webRoot, ...DESIGN_DIR_SEGMENTS);
}

const DESIGN_EXT_RE = /\.(html|json|png|svg)$/i;

// ---------- 清单 ----------

const listCache = new Map<string, { key: string; list: DesignDocItem[] }>();

/** 目录树指纹：两层 statSync 摘要（mtimeMs+size）。目录未变 → 命中缓存零重扫 */
function dirFingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        parts.push(`${name}:${st.mtimeMs}:${st.size}:${st.isDirectory()}`);
        if (st.isDirectory() && depth < 1) walk(p, depth + 1); // 只走一层子目录（两层结构契约）
      } catch {}
    }
  };
  walk(dir, 0);
  return parts.join("|");
}

/** 文件头 24KB 窗口内取 <title>（archify 产物实测 20KB 内；无 title 回落文件名去扩展名） */
function readTitle(file: string, fallback: string): string {
  try {
    const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 24576);
    const m = head.match(/<title>([^<]{1,120})<\/title>/i);
    const t = m?.[1]?.trim();
    return t || fallback;
  } catch {
    return fallback;
  }
}

/** 分词：目录名+文件名按 [-_/.] 切段、小写、滤空与纯数字单段（"01" 无语义） */
function tokenize(segments: string[]): string[] {
  const out = new Set<string>();
  for (const seg of segments) {
    for (const tok of seg.toLowerCase().split(/[-_/.]+/)) {
      if (tok && !/^\d+$/.test(tok)) out.add(tok);
    }
  }
  return [...out];
}

export function listDesignDocs(webRoot: string): DesignDocItem[] {
  const root = designDir(webRoot);
  const key = dirFingerprint(root);
  const cached = listCache.get(webRoot);
  if (cached && cached.key === key) return cached.list;
  const list: DesignDocItem[] = [];
  // 两层结构契约：根 *.html + 一级子目录/*.html（README.md 不在扩展白名单自动跳过）
  const groups: Array<{ dir: string; group: string }> = [{ dir: root, group: "全局" }];
  try {
    for (const name of readdirSync(root).sort()) {
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) groups.push({ dir: p, group: name });
      } catch {}
    }
  } catch {
    listCache.set(webRoot, { key, list });
    return list; // 无 docs/system-design（旧部署形态）：空清单，端上入口隐藏
  }
  for (const { dir, group } of groups) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /\.html$/i.test(f)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const relSegs = dir === root ? [f] : [group, f];
      list.push({
        path: "/design/" + relSegs.map(encodeURIComponent).join("/"),
        group,
        title: readTitle(join(dir, f), f.replace(/\.html$/i, "")),
        tags: tokenize([...relSegs]),
      });
    }
  }
  listCache.set(webRoot, { key, list });
  return list;
}

// ---------- /design/<rel> 路径解析（遍历防护，纯函数） ----------

export function resolveDesignFile(webRoot: string, relPath: string): string | null {
  if (!relPath || relPath.includes("\0")) return null;
  // decodeURIComponent 后再校验（%2e%2e 编码形态不得绕过）
  let rel: string;
  try {
    rel = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  if (!DESIGN_EXT_RE.test(rel)) return null; // 扩展白名单（.html/.json/.png/.svg）
  const root = resolve(designDir(webRoot));
  const full = resolve(root, rel);
  // 遍历防护：解析后必须仍在 designDir 内（.. / 绝对路径注入 / sep 拼接逃逸全堵）
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

// 测试后门：清缓存（目录内容被测试改写后强制重扫）
export function resetDesignDocsCacheForTests(): void {
  listCache.clear();
}
