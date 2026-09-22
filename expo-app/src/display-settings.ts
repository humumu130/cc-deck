// 显示设置（抽屉）：AsyncStorage 持久化 + 轻量订阅
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SessionState } from "./protocol";

export type ProcessFont = "compact" | "normal" | "hidden";

// 列表布局三档：标准 / 紧凑 / 极简（极简=状态灯+名称+水位百分比的单行卡）。
// 键沿用 cc.display.listCompact：旧版存布尔（"1"=紧凑 / "0"=标准），读取时迁移；
// 新值直接写 "std"/"compact"/"minimal"，老用户设置无损升级
export type ListDensity = "std" | "compact" | "minimal";

let processFont: ProcessFont = "compact";
let listDensity: ListDensity = "std";
let voiceInput = false;
// #121 空闲变灰阈值（分钟）：默认 30；负数 = 永不变灰（与 web-console ccd_idle_dim_min 同语义）
let idleDimMin = 30;
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

export function getListDensity(): ListDensity {
  return listDensity;
}

export function setListDensity(v: ListDensity): void {
  listDensity = v;
  void AsyncStorage.setItem("cc.display.listCompact", v);
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

// #129 回车键行为（会话输入框）：true = 回车发送（#68 多行化之前的旧习惯，默认
// 恢复）；false = 回车换行、发送靠 ➤ 按钮（长文本多行编辑场景）。未设置 = true
let enterSend = true;

export function getEnterSend(): boolean {
  return enterSend;
}

export function setEnterSend(v: boolean): void {
  enterSend = v;
  void AsyncStorage.setItem("cc.display.enterSend", v ? "1" : "0");
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

// #121 空闲变灰阈值（分钟）：调用方传整数；负数 = 永不变灰
export function getIdleDimMin(): number {
  return idleDimMin;
}

// #140 真闲置判定（变灰/折叠共用单一口径，防两处漂移）：DONE/ERROR 且无后台
// 子 Agent 在跑（#100 等孩子 ≠ 空闲）、静默超 idleDimMin 分钟；负数（永不变灰）
// → 恒 false（Infinity 让 > 恒假）——也即永不折叠。列表卡蒙层（#96/#121）与
// 「折叠空闲」（#140 联动，用户拍板：变灰才折叠）共用本函数
export function isIdleSession(
  s: Pick<SessionState, "status" | "updated_at" | "started_at" | "subagents">,
  min: number,
): boolean {
  if (s.status !== "DONE" && s.status !== "ERROR") return false;
  if ((s.subagents ?? []).some((a) => !a.ended_at)) return false;
  return Date.now() - (s.updated_at ?? s.started_at) > (min < 0 ? Infinity : min * 60_000);
}

export function setIdleDimMin(v: number): void {
  idleDimMin = v;
  void AsyncStorage.setItem("cc.display.idleDimMin", String(v));
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

export function useEnterSend(): boolean {
  const [v, setV] = useState(enterSend);
  useEffect(() => {
    const l = () => setV(enterSend);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export function useIdleDimMin(): number {
  const [v, setV] = useState(idleDimMin);
  useEffect(() => {
    const l = () => setV(idleDimMin);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export function useListDensity(): ListDensity {
  const [v, setV] = useState<ListDensity>(listDensity);
  useEffect(() => {
    const l = () => setV(listDensity);
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
    // 布局三档向后兼容：字符串新值直接用；旧布尔 "1"=紧凑、"0"/未设置=标准
    const ld = await AsyncStorage.getItem("cc.display.listCompact");
    if (ld === "std" || ld === "compact" || ld === "minimal") listDensity = ld;
    else listDensity = ld === "1" ? "compact" : "std";
    aggregate = (await AsyncStorage.getItem("cc.display.aggregate")) === "1";
    voiceInput = (await AsyncStorage.getItem("cc.display.voiceInput")) === "1";
    // #129 回车发送：未设置/读取异常均回落默认 true（≠ 其他布尔项的 "1" 才真）
    enterSend = (await AsyncStorage.getItem("cc.display.enterSend")) !== "0";
    // #121 空闲变灰阈值：字符串转数（旧版本未设置 = 保持默认 30）
    const idm = await AsyncStorage.getItem("cc.display.idleDimMin");
    if (idm != null) {
      const n = Number(idm);
      if (Number.isFinite(n)) idleDimMin = n;
    }
  } catch {}
  notify();
}
