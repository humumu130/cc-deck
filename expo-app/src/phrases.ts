// 快捷短语（详情页 chips）：AsyncStorage 持久化 + 轻量订阅（display-settings 同款模式）
// 未设置过 → 默认短语；保存过则以存储为准（清空即详情页不显示短语条）
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_PHRASES = ["继续", "总结当前进展", "运行测试", "提交代码"];

let phrases: string[] = DEFAULT_PHRASES;
let customized = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function setPhrases(list: string[]): void {
  phrases = list;
  customized = true;
  void AsyncStorage.setItem("cc.phrases", JSON.stringify(list));
  notify();
}

export function resetPhrases(): void {
  phrases = DEFAULT_PHRASES;
  customized = false;
  void AsyncStorage.removeItem("cc.phrases");
  notify();
}

export function usePhraseState(): { list: string[]; customized: boolean } {
  const [v, setV] = useState({ list: phrases, customized });
  useEffect(() => {
    const l = () => setV({ list: phrases, customized });
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export async function loadPhrases(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem("cc.phrases");
    if (raw !== null) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        phrases = arr.filter((x): x is string => typeof x === "string");
        customized = true;
      }
    }
  } catch {}
  notify();
}
