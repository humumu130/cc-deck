import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

// 语音输入 JS 封装：native SpeechRecognizer（modules/voice），无模块/无识别服务的设备可用性探测为 false。
// 事件流：partial（实时增量）→ final（stopListening 后的定稿）/ error。

export type VoiceEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: number };

interface VoiceNative {
  available(): Promise<boolean>;
  start(): void;
  stop(): void;
  cancel(): void;
  addListener(event: string, cb: (ev: VoiceEvent) => void): void;
}

const mod = Platform.OS === "android" ? requireOptionalNativeModule<VoiceNative>("Voice") : null;

export const voice = {
  available: () => (mod ? mod.available().catch(() => false) : Promise.resolve(false)),
  start: () => mod?.start(),
  stop: () => mod?.stop(),
  cancel: () => mod?.cancel(),
  subscribe: (fn: (e: VoiceEvent) => void): { remove: () => void } => {
    if (!mod) return { remove: () => undefined };
    mod.addListener("onVoiceEvent", fn);
    return { remove: () => undefined };
  },
};
