// #312 App 在线更新：GitHub Releases 查新版（24h 静默检查 + 关于弹窗手动检查，#313 迁入），
// 双源下载（ECS 镜像优先，GitHub asset 回落），安装交给系统安装器（APK 签名兜底）。
// 全链路静默容错：任何失败返回 null，不打扰用户。
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

const GH_LATEST = "https://api.github.com/repos/humumu130/cc-deck/releases/latest";
// ECS 镜像：无 TLS 但仅作下载源之一，APK 完整性/签名校验由系统安装器兜底；
// 镜像文件可能滞后于 GitHub Release，下载失败自然回落 ghUrl
const ECS_MIRROR = "http://8.133.211.170:8888/cc-deck.apk";

const KEY_LAST_CHECK = "cc_update_last_check";
const KEY_SKIPPED = "cc_update_skipped";
const CHECK_WINDOW_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// #313 本版特性摘要（关于弹窗逐条展示），随版本发布同步维护
export const VERSION_NOTES: string[] = [
  "多源聚合模式：同时连接多台 PC，会话合并展示",
  "待确认悬浮提醒：等待你确认的事项点开直达",
  "扫码添加服务器：扫 PC 终端二维码一步接入",
  "定时任务速览、任务号跳转（#NNN 直达任务卡）",
  "上下文水位：会话卡实时用量百分比",
  "在线更新：应用内检查新版、一键下载安装",
  "手表端增强：速览与状态同步",
];

export type UpdateInfo = {
  version: string; // 不带 v 前缀
  notes: string; // release body 前 500 字
  apkUrl: string; // ECS 镜像（下载首选）
  ghUrl: string; // GitHub asset（回落源）
};

// #301 同款版本链：原生 versionName 优先（build.gradle），expoConfig 兜底
export function currentVersion(): string {
  return (Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "").replace(/^v/, "");
}

// "v0.3.13" → [0,3,13]；非数字段按 0，预发布后缀（-beta 等）忽略
function parseSemver(v: string): number[] {
  const parts = v.replace(/^v/, "").split(/[.-]/).slice(0, 3);
  return parts.map((p) => Number(p.replace(/\D.*/, "")) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0);
  }
  return false;
}

// 上次检查时间距今满 24h 才允许静默检查（手动检查不受此限）
export async function shouldAutoCheck(): Promise<boolean> {
  try {
    const last = Number((await AsyncStorage.getItem(KEY_LAST_CHECK)) ?? 0);
    return Date.now() - last >= CHECK_WINDOW_MS;
  } catch {
    return false;
  }
}

// "忽略此版"：记版本号，静默检查发现同版不再弹横幅（抽屉手动检查照常回结果）
export async function getSkippedVersion(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY_SKIPPED);
  } catch {
    return null;
  }
}

export async function skipVersion(v: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SKIPPED, v);
  } catch {}
}

// 查 GitHub 最新 release。无新版 / 无网络 / 无 APK asset / 解析失败一律返回 null。
// 只要拿到了 HTTP 响应（含 4xx/5xx）就记检查时间——网络本身通，没必要下次启动再撞
export async function checkUpdate(): Promise<UpdateInfo | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(GH_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    void AsyncStorage.setItem(KEY_LAST_CHECK, String(Date.now())).catch(() => {});
    if (!res.ok) return null;
    const rel = (await res.json()) as {
      tag_name?: string;
      body?: string;
      assets?: { browser_download_url?: string }[];
    };
    const version = (rel.tag_name ?? "").replace(/^v/, "");
    if (!version || !isNewer(version, currentVersion())) return null;
    const apk = (rel.assets ?? []).find((a) => (a.browser_download_url ?? "").endsWith(".apk"));
    if (!apk?.browser_download_url) return null;
    return {
      version,
      notes: String(rel.body ?? "").slice(0, 500).trim(),
      apkUrl: ECS_MIRROR,
      ghUrl: apk.browser_download_url,
    };
  } catch {
    return null;
  }
}

// 轻量发布通道：抽屉手动检查发现新版 → 通知 Shell（App.tsx）弹更新横幅。
// Shell 挂载时订阅，卸载清空
let listener: ((info: UpdateInfo) => void) | null = null;

export function setUpdateListener(fn: ((info: UpdateInfo) => void) | null): void {
  listener = fn;
}

export function announceUpdate(info: UpdateInfo): void {
  listener?.(info);
}
