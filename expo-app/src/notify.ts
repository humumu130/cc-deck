import { PermissionsAndroid, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

// 本地原生模块 relay-notify（仅 Android release/自有构建里有；Expo Go 中为 null）
const mod = Platform.OS === "android" ? requireOptionalNativeModule("RelayNotify") : null;

export function fgSupported(): boolean {
  return !!mod;
}

// #85 JS 侧去抖：start 挂在 connConnect（重连周期高频触达）——已运行不重复
// startService（省 IPC + 防 onStartCommand 抖动）；stop 后复位，下次连接周期
// 重新拉起（FGS 意外被 ROM 杀掉时靠这条自愈）
let fgRunning = false;

export function startForegroundService(): void {
  if (fgRunning) return;
  try {
    fgRunning = !!mod?.start();
  } catch {}
}

export function stopForegroundService(): void {
  fgRunning = false;
  try {
    mod?.stop();
  } catch {}
}

export function notifyAlert(title: string, body: string): void {
  try {
    mod?.notify(title, body);
  } catch {}
}

// #301 更新前台服务通知正文（原生同 id 覆盖 startForeground 的常驻通知）；
// 调用方需自行做变化比对，避免流式快照每秒重发
export function updateForeground(text: string): void {
  try {
    mod?.update(text);
  } catch {}
}

// #355/#364/#370 前台通知：emoji 彩点计数（低重要度渠道系统剥离文字着色）+ title=状态概览
// （展开态系统头部已显 App 名，自设软件名会双标题）
export function updateForegroundStats(working: number, waiting: number, error: number, done: number, title: string): void {
  try {
    mod?.updateStats?.(working, waiting, error, done, title);
  } catch {}
}

// #60 后台保活豁免：ColorOS 等国产 ROM 会以 cgroup freezer 冻结后台进程（FGS 也拦不住，
// 实测 freezer:/frozen + WS 静默死），电池优化豁免（doze 白名单）是实证有效的根治入口
//（豁免后后台保持 thaw、连接不断、系统通知照发）。查询失败按已豁免处理（不打扰用户）
export function batteryExempt(): boolean {
  try {
    return mod?.batteryExempt?.() ?? true;
  } catch {
    return true;
  }
}

// 拉起系统「忽略电池优化」确认对话框（部分 ROM 缺失则静默无反应）
export function requestBatteryExempt(): void {
  try {
    mod?.requestBatteryExempt?.();
  } catch {}
}

// API 33+ 运行时通知权限（拒绝则通知静默不显示，前台服务照常）
export async function ensureNotifPermission(): Promise<void> {
  if (Platform.OS !== "android" || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS", {
      title: "通知权限",
      message: "会话等待确认时向你发送提醒",
      buttonPositive: "允许",
      buttonNegative: "拒绝",
    } as never);
  } catch {}
}
