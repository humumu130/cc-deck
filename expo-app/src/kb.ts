import { useEffect, useState } from "react";
import { DeviceEventEmitter } from "react-native";

// edge-to-edge 下窗口不再 adjustResize，RN 的 keyboardDidShow 在
// bridgeless + Android 16 上不触发；MainActivity 原生监听 IME insets
// 并经 RCTDeviceEventEmitter 发 "kbInsets"（px→dp）。
export function useKbHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const nat = DeviceEventEmitter.addListener("kbInsets", (e: { height: number }) => setH(e.height));
    return () => nat.remove();
  }, []);
  return h;
}
