// 手机端上传附件落盘（#54 图片 / #62 文件）：<dataDir>/../tmp 一次性投递目录，
// CLI Read/处理过即无价值，7 天清扫见 index.ts sweepTmpImages。
// 图片按魔数嗅探扩展名（img-*，双端一致沿用 #54 命名）；文件保留原始文件名（file-*）
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface UploadBlob {
  name: string; // 原始文件名（仅文件类附件有意义；图片附件恒空串）
  b64: string;  // 原始 base64（不带头）
}

export function tmpUploadDir(dataDir: string): string {
  return path.join(dataDir, "..", "tmp");
}

function sidKeyOf(sessionId: string): string {
  return sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "ext";
}

// 图片魔数嗅探：PNG/JPG/GIF/WEBP，兜底 png（CLI Read 原生支持这四种）
function sniffImageExt(head: Buffer): string {
  if (head[0] === 0x89 && head[1] === 0x50) return "png";
  if (head[0] === 0xff && head[1] === 0xd8) return "jpg";
  if (head[0] === 0x47 && head[1] === 0x49) return "gif";
  if (head.slice(0, 4).toString("latin1") === "RIFF" && head.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  return "png";
}

// 文件名清洗：取 basename（剥掉路径分隔）、去控制字符、剥前导点、限长 60。
// 中文文件名原样保留（macOS/Windows 文件系统与 CLI Read 均直接可用）
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(new RegExp("[\\x00-\\x1f\\x7f]", "g"), "").replace(/^\.+/g, "").trim();
  return cleaned.slice(0, 60) || "file";
}

// 图片落盘：命名 img-<sid>-<时间戳>-<序号>.<魔数扩展名>（与 #54 逐字节一致，勿改——
// test-bridge 按前缀对账）。失败项跳过，返回成功写入的绝对路径
export function saveUploadImages(dataDir: string, sessionId: string, images: string[]): string[] {
  if (images.length === 0) return [];
  const dir = tmpUploadDir(dataDir);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const sidKey = sidKeyOf(sessionId);
  const stamp = Date.now();
  const saved: string[] = [];
  for (let i = 0; i < Math.min(images.length, 4); i++) {
    const b64 = images[i];
    const head = Buffer.from(b64.slice(0, 24), "base64");
    const ext = sniffImageExt(head);
    const p = path.join(dir, `img-${sidKey}-${stamp}-${i + 1}.${ext}`);
    try { writeFileSync(p, Buffer.from(b64, "base64")); saved.push(p); } catch {}
  }
  return saved;
}

// 文件落盘：命名 file-<sid>-<时间戳>-<序号>-<原始文件名>（扩展名以用户侧文件名为准，
// 不做魔数嗅探——文档/代码等文本类文件的类型由名字与内容共同决定，重命名反而误导）
export function saveUploadFiles(dataDir: string, sessionId: string, files: UploadBlob[]): string[] {
  if (files.length === 0) return [];
  const dir = tmpUploadDir(dataDir);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const sidKey = sidKeyOf(sessionId);
  const stamp = Date.now();
  const saved: string[] = [];
  for (let i = 0; i < Math.min(files.length, 2); i++) {
    const f = files[i];
    const p = path.join(dir, `file-${sidKey}-${stamp}-${i + 1}-${safeName(f.name)}`);
    try { writeFileSync(p, Buffer.from(f.b64, "base64")); saved.push(p); } catch {}
  }
  return saved;
}
