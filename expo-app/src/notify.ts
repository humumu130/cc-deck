import { PermissionsAndroid, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

// 本地原生模块 relay-notify（仅 Android release/自有构建里有；Expo Go 中为 null）
const mod = Platform.OS === "android" ? requireOptionalNativeModule("RelayNotify") : null;

export function fgSupported(): boolean {
  return !!mod;
}

export function startForegroundService(): void {
  try {
    mod?.start();
  } catch {}
}

export function stopForegroundService(): void {
  try {
    mod?.stop();
  } catch {}
}

export function notifyAlert(title: string, body: string): void {
  try {
    mod?.notify(title, body);
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
