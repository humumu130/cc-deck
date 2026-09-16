import { useEffect, useState } from "react";
import { DeviceEventEmitter, Keyboard } from "react-native";

// edge-to-edge 下窗口不再 adjustResize，RN 的 keyboardDidShow 在
// bridgeless + Android 16 上不触发；MainActivity 原生监听 IME insets
// 并经 RCTDeviceEventEmitter 发 "kbInsets"（px→dp）。
// 卡高度防御（2026-09-16 二版）：kbInsets 事件偶发丢失时 h 永久卡在旧键盘高度——
// 输入框被 translateY 平移出可视位，"点输入框没反应、必须杀 App 重开"。
// 兜底只留 keyboardDidHide 归零一途：RN keyboardDidShow / AppState+isVisible 在
// edge-to-edge 桥less下会误报（键盘开着报不可见），一版把抬升误清零反加重呼出
// 失败——宁可保守。抬升侧另有 +8px 余量兜 IME 欠账（DetailScreen 底部栈）。
export function useKbHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const nat = DeviceEventEmitter.addListener("kbInsets", (e: { height: number }) => setH(e.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setH(0));
    return () => {
      nat.remove();
      hide.remove();
    };
  }, []);
  return h;
}
