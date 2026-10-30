// conn-page-v2 件③：以本机为源的客户端台账（已配对终端清单的数据底座）。
// 现状痛点（用户十病⑧）：「本设备与配对」模块只有静态两行（桌面 App 版本号=关于页
// 重复/「未下发清单」escape），无真实客户端数据。本模块=relay 连接面的最小台账：
//   - 每 WS 连接按 UA 族分类（手机 App/桌面 App/浏览器）+ 可选 dev_name 参数
//    （端上自愿上报的设备名——手机/桌面端后续批接入，缺省用 UA 族标签）
//   - last_seen 持久化 dataDir/relay-devices.json（原子写；cap 12 条 + 30d 剪尾，
//     防无限增长）；online 位由 ws-server 活连接集合注入（不落盘）
//   - SNAPSHOT.relay_devices 下发（设置页「客户端」模块渲染源；旧端无字段零影响）
// 台账是「连接观测」不是「配对身份」（配对身份=token 体系，互不越界）：设备被顶号/
// 换网络不影响身份语义，这里只回答「最近有哪些端连过这台 relay」。
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson } from "./fs-safe.js";

export interface RelayDevice {
  id: string;
  kind: "phone" | "desktop" | "browser";
  name: string;
  first_seen: number;
  last_seen: number;
  online?: boolean; // 活连接态（SNAPSHOT 注入，不落盘）
}

const MAX_DEVICES = 12;
const RETAIN_MS = 30 * 24 * 3600_000;

function devicesPath(dataDir: string): string {
  return join(dataDir, "relay-devices.json");
}

function readDevices(dataDir: string): RelayDevice[] {
  try {
    const raw = JSON.parse(readFileSync(devicesPath(dataDir), "utf-8")) as { devices?: RelayDevice[] };
    return Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === "string") : [];
  } catch {
    return [];
  }
}

/** UA 族分类（粗粒度自愿口径——无端上身份时的最大似然；dev_name 在场优先取用） */
export function classifyDevice(ua: string, devName?: string): { kind: RelayDevice["kind"]; label: string } {
  const u = String(ua || "").toLowerCase();
  if (/okhttp|dart|flutter|expo|cc-deck-mobile/.test(u)) return { kind: "phone", label: "手机 App" };
  if (/tauri|ccdeck\//.test(u)) return { kind: "desktop", label: "桌面 App" };
  if (/iphone|ipad|android/.test(u)) return { kind: "phone", label: /ipad|tablet/.test(u) ? "平板浏览器" : "手机浏览器" };
  if (/chrome|safari|firefox|edge/.test(u)) return { kind: "browser", label: /mac os x/.test(u) ? "Mac 浏览器" : /windows/.test(u) ? "Windows 浏览器" : "浏览器" };
  return { kind: "browser", label: "网页端" };
}

/** 连接触达：upsert（id=devName||UA 的稳定哈希前缀）+持久化（cap+剪尾）。返回台账行。 */
export function touchDevice(dataDir: string, ua: string, devName?: string): RelayDevice {
  const now = Date.now();
  const name = (devName && devName.trim().slice(0, 24)) || classifyDevice(ua).label;
  // id=UA 哈希（连接观测聚合键）：无端上唯一 ID 时 UA 是最稳聚合维度，dev_name 只是
  // 展示标签——改名=同设备换标签（upsert），不新建行；同款 UA 两台端聚合一行属
  // 可接受精度（台账语义=「最近哪些端连过」，非配对身份——见文件头注）
  const id = "dv-" + createHash("sha1").update(String(ua || "unknown")).digest("hex").slice(0, 8);
  const list = readDevices(dataDir);
  const cur = list.find((d) => d.id === id);
  if (cur) {
    cur.name = name;
    cur.last_seen = now;
  } else {
    list.push({ id, kind: classifyDevice(ua, devName).kind, name, first_seen: now, last_seen: now });
  }
  const kept = list
    .filter((d) => now - d.last_seen < RETAIN_MS)
    .sort((a, b) => b.last_seen - a.last_seen)
    .slice(0, MAX_DEVICES);
  try {
    mkdirSync(dataDir, { recursive: true });
    atomicWriteJson(devicesPath(dataDir), JSON.stringify({ devices: kept }, null, 2) + "\n");
  } catch { /* 台账尽力而为：写失败不炸连接主链 */ }
  return kept.find((d) => d.id === id) ?? { id, kind: classifyDevice(ua, devName).kind, name, first_seen: now, last_seen: now };
}

/** SNAPSHOT 下发面：近台账 + online 活连接标注（onlineIds=当前活连接的 device id 集） */
export function listDevices(dataDir: string, onlineIds?: Set<string>): RelayDevice[] {
  // 先按 onlineIds 标注、后排序——盘上行本无 online 位（不落盘），先排后标=置顶恒失效
  return readDevices(dataDir)
    .map((d) => ({ ...d, online: onlineIds ? onlineIds.has(d.id) : undefined }))
    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.last_seen - a.last_seen);
}
