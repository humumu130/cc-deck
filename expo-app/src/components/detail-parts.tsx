// W-SPLIT-S1（docs/design-split-plan.md §3 阶段 1）：自 DetailScreen.tsx 机械抽离的自包含展示组件。
// 铁律「只搬不改」：函数体逐字未动，仅 import 接线。makeStyles 系组件（DiffBlock/
// StatRow/WaitCard 等）依赖 DetailScreen 私有样式工厂——深纠缠留原文件（见回执清单）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import { useThemeStyles } from "../theme-context";
import { isLiveLine, stripLiveMark } from "../fmt";
import type { GestureResponderEvent } from "react-native";
const PEND_PHASES = [0.35, 0.5, 0.65, 0.85, 0.65, 0.5];
const WAITBOX_READONLY = false; // W-SPLIT-S1C：WaitCard 只读口径随件（值原样——语义注释见 S1 首批回执）
import { makeStyles } from "./detail-styles";
import { View } from "react-native";
import { useTheme } from "../theme-context";

const DOCK_PHASES = [1, 0.72, 0.45, 0.72];

export function MicIcon({ color }: { color: string }) {
  return (
    <View style={{ width: 15, height: 21, alignItems: "center" }}>
      <View style={{ width: 8, height: 11, borderRadius: 4, backgroundColor: color }} />
      <View
        style={{
          position: "absolute", top: 0, width: 13, height: 12,
          borderRadius: 7.5, borderWidth: 1.5, borderBottomWidth: 0, borderColor: color,
        }}
      />
      <View style={{ width: 1.5, height: 3.5, backgroundColor: color, marginTop: 3.5 }} />
      <View style={{ width: 6, height: 1.5, borderRadius: 0.75, backgroundColor: color, marginTop: 1 }} />
    </View>
  );
}

export function DockDot({ color, breathe }: { color: string; breathe?: boolean }) {
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!breathe) return;
    const t = setInterval(() => setPh((n) => (n + 1) % DOCK_PHASES.length), 480);
    return () => clearInterval(t);
  }, [breathe]);
  return (
    <View
      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: breathe ? DOCK_PHASES[ph] : 1 }}
      accessibilityLabel={breathe ? "运行中" : undefined}
    />
  );
}

export function CtxSegMeter({ pct, tone, cells = 20, small }: { pct: number; tone: string; cells?: number; small?: boolean }) {
  const { c } = useTheme();
  const on = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
  // W-UIFIX 件二：small 档（标题行右端用）——段 2×5/gap 1，比副题行旧档小一号
  return (
    <View style={{ flexDirection: "row", gap: small ? 1 : 1.5, alignItems: "center" }}>
      {Array.from({ length: cells }, (_, i) => (
        <View key={i} style={{ width: small ? 2 : 3, height: small ? 5 : 6, borderRadius: 1, backgroundColor: i < on ? tone : c.ctxTrack }} />
      ))}
    </View>
  );
}

// ---- W-SPLIT-S1C 二批（六件，样式经 detail-styles 解锁——只搬不改）----
// 随件工具：tpPt（触点取坐标）+SPIN_FRAMES（状态行走帧）——原文件剪切原样
const tpPt = (e: GestureResponderEvent): { x: number; y: number } | undefined => {
  const t = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
  return t ? { x: t.pageX, y: t.pageY } : undefined;
};

export const SPIN_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✸"];


export function TaskRefText({ text, style, numberOfLines, suffix, suffixStyle, onTaskRef, onTaskRefOut }: { text: string; style: StyleProp<TextStyle>; numberOfLines?: number; suffix?: string; suffixStyle?: StyleProp<TextStyle>; onTaskRef?: (n: number, hold?: boolean, anchor?: { x: number; y: number }) => void; onTaskRefOut?: () => void }) {
  const { c } = useTheme();
  if (!onTaskRef || !/#\d{1,3}\b/.test(text)) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
        {suffix ? <Text style={suffixStyle}>{suffix}</Text> : null}
      </Text>
    );
  }
  const parts = text.split(/#(\d{1,3})\b/g);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text
            key={i}
            style={{ color: c.brandA, fontWeight: "700" }}
            onPress={(e) => onTaskRef(Number(p), false, tpPt(e))}
            onLongPress={(e) => onTaskRef(Number(p), true, tpPt(e))}
            onPressOut={onTaskRefOut}
          >
            #{p}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
      {suffix ? <Text style={suffixStyle}>{suffix}</Text> : null}
    </Text>
  );
}

export function DiffBlock({ lines }: { lines: string[] }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={d.diffBox}>
      {lines.map((l, i) => {
        const st = l.startsWith("@@")
          ? d.diffHunk
          : l.startsWith("+")
            ? d.diffAdd
            : l.startsWith("-")
              ? d.diffDel
              : d.diffCtx;
        return <Text key={i} style={st} selectable>{l || " "}</Text>;
      })}
    </View>
  );
}

export function LiveStatusLine({ summary, startedAt, color, tok }: { summary: string; startedAt?: number; color: string; tok?: string }) {
  const d = useThemeStyles(makeStyles);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const live = isLiveLine(summary);
  const text = stripLiveMark(summary);
  const secs = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  // 实时行照转动画星：CLI 行首星已在 relay 剥除，客户端星是唯一指示不重复；
  // 走秒保留（本回合时长与转轮行内活动时长语义不同）；ctx 已按反馈移除
  const frame = SPIN_FRAMES[Math.floor(Date.now() / 500) % SPIN_FRAMES.length];
  const m = Math.floor(secs / 60);
  const timeText = m > 0 ? `${m}m${secs % 60}s` : `${secs}s`;
  return (
    <View style={d.statusLine}>
      <Text style={[d.statusSpin, { color }]}>{frame}</Text>
      <Text style={[d.statusText, { color }]} numberOfLines={1}>{text || "思考中…"}</Text>
      {startedAt ? <Text style={d.statusTime}>· {timeText}</Text> : null}
      {tok && !live ? <Text style={d.statusTime}>· {tok}</Text> : null}
    </View>
  );
}

export function PendingRow({ text }: { text: string }) {
  const d = useThemeStyles(makeStyles);
  const [ph, setPh] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPh((n) => (n + 1) % PEND_PHASES.length), 600);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={[d.pendRow, { opacity: PEND_PHASES[ph] }]}>
      <Text style={d.pendT} numberOfLines={3}>{text}</Text>
    </View>
  );
}

export function WaitCard({ isAsk, children }: { isAsk: boolean; children: ReactNode }) {
  const d = useThemeStyles(makeStyles);
  return (
    <View style={[d.waitBanner, isAsk ? d.waitCardAsk : d.waitCardApprove]}>
      {children}
      {WAITBOX_READONLY ? (
        <View style={d.waitRO}>
          <Text style={d.waitROT}>请在电脑上处理</Text>
        </View>
      ) : null}
    </View>
  );
}

export function StatRow({ k, v, vc, copy }: { k: string; v: string; vc?: string; copy?: boolean }) {
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  return (
    <View style={d.statRow}>
      {/* W-EXPO 005 kv-row 形制：值左（粗体 text-strong，flexShrink 截断）、标签右（dim 10px） */}
      <Text
        style={[d.statRowV, vc ? { color: vc } : null]}
        numberOfLines={1}
        onLongPress={copy ? () => {
          void Clipboard.setStringAsync(v).then(() => {
            setCopied(true);
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          });
        } : undefined}
      >{copied ? "已复制 ✓" : v}</Text>
      <Text style={d.statRowK}>{k}</Text>
    </View>
  );
}

