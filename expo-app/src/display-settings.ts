// 显示设置（抽屉）：AsyncStorage 持久化 + 轻量订阅
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ProcessFont = "compact" | "normal" | "hidden";

let processFont: ProcessFont = "compact";
let listCompact = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function getProcessFont(): ProcessFont {
  return processFont;
}

export function setProcessFont(v: ProcessFont): void {
  processFont = v;
  void AsyncStorage.setItem("cc.display.processFont", v);
  notify();
}

export function getListCompact(): boolean {
  return listCompact;
}

export function setListCompact(v: boolean): void {
  listCompact = v;
  void AsyncStorage.setItem("cc.display.listCompact", v ? "1" : "0");
  notify();
}

export function useListCompact(): boolean {
  const [v, setV] = useState(listCompact);
  useEffect(() => {
    const l = () => setV(listCompact);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export function useProcessFont(): ProcessFont {
  const [v, setV] = useState<ProcessFont>(processFont);
  useEffect(() => {
    const l = () => setV(processFont);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export async function loadDisplaySettings(): Promise<void> {
  try {
    const v = (await AsyncStorage.getItem("cc.display.processFont")) as ProcessFont | null;
    if (v === "compact" || v === "normal" || v === "hidden") processFont = v;
    listCompact = (await AsyncStorage.getItem("cc.display.listCompact")) === "1";
  } catch {}
  notify();
}
