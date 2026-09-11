// 共享动效原语（#242 动效批次）：
// FadeIn —— 一次性入场 fade+上滑；PressScale —— CTA 按压缩放反馈（可选触觉）；
// Collapse —— 展开/收起高度动画（#248）。
// 约束：只用 opacity/transform（bridgeless 下原生驱动安全，见 0.2.26 闪退记录），
// 时长统一 120-200ms，宁少勿滥。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, Vibration, View, type StyleProp, type ViewStyle } from "react-native";

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

// 展开/收起（#248 → #54 重写）：关闭时内容不挂载（时间线可到 500 条，保性能）；
// 展开直接 auto 高度 + opacity 淡入。旧实现「0 高 overflow:hidden 容器内 onLayout
// 测自然高度→动画 0→H」在真机上 onLayout 报 0 高（#54 实锤：任务行点击箭头翻转
// 但内容永不渲染，四个展开点全受累）——放弃高度测量路径，高度直切保功能，
// 动效退化为原生驱动的 opacity（不依赖布局测量，无 JS 帧驱动负担）
export function Collapse({ open, children, dur = 180 }: { open: boolean; children: ReactNode; dur?: number }) {
  const [mounted, setMounted] = useState(false);
  const op = useRef(new Animated.Value(0)).current;
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) {
      if (!mounted) setMounted(true);
      op.setValue(0);
      Animated.timing(op, { toValue: 1, duration: dur, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(op, { toValue: 0, duration: Math.round(dur * 0.6), useNativeDriver: true }).start(({ finished }) => {
        // 快速关-开竞态：收起动画中 open 又翻 true——晚到的回调不得卸载
        if (finished && !openRef.current) setMounted(false);
      });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { op.stopAnimation(); }, [op]);
  if (!mounted) return null;
  return <Animated.View style={{ opacity: op }}>{children}</Animated.View>;
}
