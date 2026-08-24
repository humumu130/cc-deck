import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

// edge-to-edge 下窗口不再 adjustResize，KeyboardAvoidingView 的重叠数学
// 会算出 0；改用 insets 推导的键盘高度直接做 padding。
export function useKbHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => setH(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}
