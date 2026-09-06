// 显示设置（抽屉）：AsyncStorage 持久化 + 轻量订阅
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ProcessFont = "compact" | "normal" | "hidden";

let processFont: ProcessFont = "compact";
let listCompact = false;
let voiceInput = false;
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

// 多源聚合（#294 批4）：开 = 同时连接全部已配置源、列表合并展示；关 = 只连活动源。
// 键名 cc.display.aggregate 与 store 启动读取（loadConfig）一致；连接行为切换由
// 抽屉开关同时调 store.setAggregate 完成，本模块只管持久化与订阅
let aggregate = false;

export function getAggregate(): boolean {
  return aggregate;
}

export function setAggregate(v: boolean): void {
  aggregate = v;
  void AsyncStorage.setItem("cc.display.aggregate", v ? "1" : "0");
  notify();
}

// 语音输入（按住说话）：识别服务在部分机型不可用，默认关闭，需要者自行开启
export function getVoiceInput(): boolean {
  return voiceInput;
}

export function setVoiceInput(v: boolean): void {
  voiceInput = v;
  void AsyncStorage.setItem("cc.display.voiceInput", v ? "1" : "0");
  notify();
}

export function useVoiceInput(): boolean {
  const [v, setV] = useState(voiceInput);
  useEffect(() => {
    const l = () => setV(voiceInput);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
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

export function useAggregate(): boolean {
  const [v, setV] = useState(aggregate);
  useEffect(() => {
    const l = () => setV(aggregate);
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
    aggregate = (await AsyncStorage.getItem("cc.display.aggregate")) === "1";
    voiceInput = (await AsyncStorage.getItem("cc.display.voiceInput")) === "1";
  } catch {}
  notify();
}
