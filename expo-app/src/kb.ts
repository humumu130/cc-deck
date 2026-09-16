import { useEffect, useState } from "react";
import { AppState, DeviceEventEmitter, Keyboard } from "react-native";

// edge-to-edge 下窗口不再 adjustResize，RN 的 keyboardDidShow 在
// bridgeless + Android 16 上不触发；MainActivity 原生监听 IME insets
// 并经 RCTDeviceEventEmitter 发 "kbInsets"（px→dp）。
// 卡高度防御（2026-09-16）：kbInsets 事件偶发丢失时 h 永久卡在旧键盘高度——
// 输入框被 translateY 平移出可视位，"点输入框没反应、必须杀 App 重开"。
// 三重兜底：RN keyboardDidHide 强制归零 + RN keyboardDidShow 兜底设高 +
// 回前台校验（h>0 而 RN 认为键盘不可见即复位）。
export function useKbHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const nat = DeviceEventEmitter.addListener("kbInsets", (e: { height: number }) => setH(e.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setH(0));
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      const kh = e?.endCoordinates?.height ?? 0;
      if (kh > 0) setH(kh);
    });
    const appSub = AppState.addEventListener("change", (st) => {
      if (st === "active" && h > 0 && !Keyboard.isVisible()) setH(0);
    });
    return () => {
      nat.remove();
      hide.remove();
      show.remove();
      appSub.remove();
    };
  }, [h]);
  return h;
}
