import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DARK, LIGHT, type ThemeColors } from "./theme";

type Mode = "dark" | "light";

interface ThemeCtx {
  c: ThemeColors;
  mode: Mode;
  toggle: () => void;
}

// #173 默认浅色：无已存偏好时 light；AsyncStorage 存过 light/dark 的照旧（用户偏好不动）
const Ctx = createContext<ThemeCtx>({ c: LIGHT, mode: "light", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("light");
  useEffect(() => {
    void AsyncStorage.getItem("ccr_theme").then((v) => {
      if (v === "light" || v === "dark") setMode(v);
    });
  }, []);
  const toggle = () => {
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      void AsyncStorage.setItem("ccr_theme", next);
      return next;
    });
  };
  const value = useMemo(() => ({ c: mode === "dark" ? DARK : LIGHT, mode, toggle }), [mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

// StyleSheet 工厂 -> 随主题重建的样式（factory 须为模块级稳定引用）
export function useThemeStyles<T>(factory: (c: ThemeColors) => T): T {
  const { c } = useTheme();
  return useMemo(() => factory(c), [c]);
}
