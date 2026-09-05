// 共享动效原语（#242 动效批次）：
// FadeIn —— 一次性入场 fade+上滑；PressScale —— CTA 按压缩放反馈（可选触觉）。
// 约束：只用 opacity/transform（bridgeless 下原生驱动安全，见 0.2.26 闪退记录），
// 时长统一 120-200ms，宁少勿滥。
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, Vibration, type StyleProp, type ViewStyle } from "react-native";

export function FadeIn({ children, dy = 8, dur = 160 }: { children: ReactNode; dy?: number; dur?: number }) {
  const op = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(dy)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(op, { toValue: 1, duration: dur, useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: dur, useNativeDriver: true }),
    ]).start();
  }, [op, y, dur]);
  return <Animated.View style={{ opacity: op, transform: [{ translateY: y }] }}>{children}</Animated.View>;
}

export function PressScale({
  children, style, ripple, onPress, disabled, haptic = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  ripple?: string;
  onPress: () => void;
  disabled?: boolean;
  haptic?: boolean;
}) {
  const sc = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(sc, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 5 }).start();
  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => {
        to(0.96);
        if (haptic) {
          try { Vibration.vibrate(8); } catch {}
        }
      }}
      onPressOut={() => to(1)}
      onPress={onPress}
      android_ripple={ripple ? { color: ripple, borderless: false } : undefined}
      style={[style, { transform: [{ scale: sc }] }]}
    >
      {children}
    </Pressable>
  );
}
