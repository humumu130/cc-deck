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

// 展开/收起高度动画（#248）：关闭时内容不挂载（时间线可到 500 条，保性能）；
// 展开先在 0 高度 overflow:hidden 容器里挂载测出自然高度 → 动画 0→H → 全开后切
// auto 高度（流式追加内容可自然生长）；收起从实测高度动画回 0 再卸载。
// 新架构无 LayoutAnimation，高度也不能原生驱动——180ms 短时长保证 JS 驱动不卡
export function Collapse({ open, children, dur = 180 }: { open: boolean; children: ReactNode; dur?: number }) {
  const [mounted, setMounted] = useState(false);
  const [auto, setAuto] = useState(false);
  const [tick, setTick] = useState(0);
  const h = useRef(new Animated.Value(0)).current;
  const measured = useRef(0);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) {
      if (!mounted) {
        setMounted(true);
        setAuto(false);
        h.setValue(0);
      }
    } else if (mounted) {
      setAuto(false);
      // auto 阶段 h 里是陈旧目标值，从实测高度起跳（流式增长后测量值始终新鲜）
      h.setValue(measured.current);
      Animated.timing(h, { toValue: 0, duration: dur, useNativeDriver: false }).start(({ finished }) => {
        // 快速关-开竞态：动画进行中 open 又翻 true（effect2 会打断收起动画），
        // 回调若仍晚到不得卸载，否则 open=true 却空白
        if (finished && !openRef.current) setMounted(false);
      });
    }
  }, [open]);
  useEffect(() => {
    if (!open || !mounted || auto || measured.current <= 0) return;
    Animated.timing(h, { toValue: measured.current, duration: dur, useNativeDriver: false }).start(({ finished }) => {
      if (finished) setAuto(true);
    });
  }, [open, mounted, auto, tick]);
  useEffect(() => () => { h.stopAnimation(); }, [h]);
  if (!mounted) return null;
  return (
    <Animated.View style={{ height: auto ? undefined : h, overflow: "hidden" }}>
      <View
        onLayout={(e) => {
          measured.current = e.nativeEvent.layout.height;
          setTick((t) => t + 1);
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
}
