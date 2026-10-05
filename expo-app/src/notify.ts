import { Linking, PermissionsAndroid, Platform } from "react-native";
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

// E4b 通知恢复链路（node 直测面）：S| 分布键 + title 组装从 App.tsx effect 抽纯——
// 同计数恒同键（fgText 去抖 → 重连快照/回前台重放同账时不重发原生、通知不闪跳）；
// 角标变化只增减「待办」位，其余位不动（018 §2.6 计数不跳变不清零的 UI 侧锁定）
export function fgStatsKey(working: number, waiting: number, error: number, done: number, badge: number): string {
  return `S|${working}|${waiting}|${error}|${done}|${badge}`;
}

export function fgStatsTitle(working: number, waiting: number, error: number, done: number, badge: number): string {
  const bits: string[] = [];
  if (badge) bits.push(`待办${badge}`);
  if (working) bits.push(`工作${working}`);
  if (waiting) bits.push(`等待${waiting}`);
  if (error) bits.push(`错误${error}`);
  return bits.length ? `${bits.join(" · ")}｜共${working + waiting + error + done}会话` : `空闲｜${done} 会话`;
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

// #85 拉电池豁免入口（三级兜底，2026-09-21）：主对话框（AOSP 标准，一键允许）→
// 电池优化列表页 → 应用详情页。返回实际打开的页面（dialog/list/details/none）——
// ColorOS 等部分 ROM 缺主对话框 activity，旧实现静默失败即用户实测的「点去优化
// 没反应」；调用方据此给手动路径引导
export function requestBatteryExempt(): string {
  try {
    return mod?.requestBatteryExempt?.() ?? "none";
  } catch {
    return "none";
  }
}

// ---------- 通知权限（API 33+）：E4b 拒绝不再静默 ----------

type NotifPermState = boolean | null; // true=已授予 false=被拒 null=未知/查询失败

function permGateNeeded(): boolean {
  return Platform.OS === "android" && !(Platform.Version < 33);
}

// 当前授权态（只查不弹框）：App 回前台（从系统设置返回）时复查，授予后提示消失
export async function notifPermissionState(): Promise<NotifPermState> {
  if (!permGateNeeded()) return true;
  try {
    return await PermissionsAndroid.check("android.permission.POST_NOTIFICATIONS" as never);
  } catch {
    return null;
  }
}

// API 33+ 运行时通知权限（拒绝则通知静默不显示，前台服务照常）。
// E4b：返回结果不再丢弃——true=授予 / false=拒绝 / null=未知（非 Android、低版本、
// 请求异常）。App 侧据此出一次性可见提示（「审批提醒不可见」）
export async function ensureNotifPermission(): Promise<NotifPermState> {
  if (!permGateNeeded()) return true;
  try {
    const res = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS", {
      title: "通知权限",
      message: "会话等待确认时向你发送提醒",
      buttonPositive: "允许",
      buttonNegative: "拒绝",
    } as never);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return null;
  }
}

// 会话级去重：每次冷启最多提示一次（重连周期反复 ensure 不重复弹横幅；用户点
// 「去设置」与关闭横幅不占额度——去设置是用户主动，关闭后本会话不再打扰）
let permHintShown = false;

/** 提示闸（node 直测）：仅「确认被拒 + 未关过 + 本会话还没提示过」时出提示 */
export function permHintActive(granted: NotifPermState, dismissed: boolean): boolean {
  if (granted !== false || dismissed || permHintShown) return false;
  return true;
}

export function markPermHintShown(): void {
  permHintShown = true;
}

// 仅测试用：复位会话级去重位
export function resetPermHintForTests(): void {
  permHintShown = false;
}

// 跳系统设置深链：Linking.openSettings = 本 App 的系统设置页（通知开关就在那里），
// 无需自拼 intent 参数（跨 ROM 稳定）；失败静默（横幅仍在，用户可手动前往）
export function openNotifSettings(): void {
  try {
    void Linking.openSettings();
  } catch {}
}
