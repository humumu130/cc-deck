// 轻量 Markdown 渲染（时间线 assistant 文本用）：
// 覆盖标题/粗斜体/行内码/围栏码块/无序有序列表/引用/分割线/GFM 表格/链接（可点击浮窗复制/打开），零依赖子集实现，
// 截断产生的残缺标记按字面渲染（解析器对不匹配标记容错）。
import { useMemo, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View, type TextStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { withA, type ThemeColors } from "./theme";
import { useTheme, useThemeStyles } from "./theme-context";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; text: string }
  | { t: "li"; text: string; depth: number; ord?: string }
  | { t: "quote"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

// GFM 表格分隔行：|---|:--:| 等
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const splitRow = (l: string) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split(/\r?\n/);
  let para: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let tableBuf: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push({ t: "p", text: para.join("\n") });
      para = [];
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    if (tableBuf.length >= 2 && DELIM_RE.test(tableBuf[1])) {
      out.push({ t: "table", head: splitRow(tableBuf[0]), rows: tableBuf.slice(2).map(splitRow) });
    } else {
      out.push({ t: "p", text: tableBuf.join("\n") });
    }
    tableBuf = [];
  };
  for (const raw of lines) {
    if (inCode) {
      if (/^\s*```/.test(raw)) {
        out.push({ t: "code", text: code.join("\n") });
        code = [];
        inCode = false;
      } else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flush();
      inCode = true;
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      flush();
      tableBuf.push(raw);
      continue;
    }
    flushTable();
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(raw)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      flush();
      out.push({
        t: "li",
        depth: Math.min(2, Math.floor(li[1].length / 2)),
        ord: /\d/.test(li[2]) ? li[2].replace(/[.)]/, "") : undefined,
        text: li[3],
      });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(raw);
    if (q) {
      flush();
      out.push({ t: "quote", text: q[1] });
      continue;
    }
    if (!raw.trim()) flush();
    else para.push(raw);
  }
  if (inCode && code.length) out.push({ t: "code", text: code.join("\n") }); // 截断的码块兜底
  flushTable();
  flush();
  return out;
}

type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };

// 行内标记：**粗** / *斜* / __粗__ / _斜_ / `码` / [标题](url) / 裸 URL。
// 裸 URL 排除中日文标点与括号（markdown 链接整体 token 排在前，不会被拆开）
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s（）【】，。；、！？：""''《》<>()[\]{}]+)/g;

function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0];
    const i = m.index ?? 0;
    if (i > last) spans.push({ text: text.slice(last, i) });
    if (tok.startsWith("**") || tok.startsWith("__")) spans.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) spans.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("[")) {
      // [标题](url)：标题可点，URL 存 span.link 供浮窗复制/打开
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) spans.push({ text: mm[1], link: mm[2] });
      else spans.push({ text: tok });
    } else if (tok.startsWith("http")) spans.push({ text: tok, link: tok });
    else spans.push({ text: tok.slice(1, -1), italic: true });
    last = i + tok.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

function InlineText({ text, small, header, outer, onLink }: {
  text: string;
  small?: boolean;
  header?: boolean;
  outer?: TextStyle;
  onLink?: (url: string) => void;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  return (
    <Text style={[d.base, small ? d.cellT : null, header ? d.thT : null, outer]}>
      {parseInline(text).map((s, i) => (
        <Text
          key={i}
          onPress={s.link ? () => onLink?.(s.link!) : undefined}
          style={[
            s.code ? d.code : null,
            s.bold ? { fontWeight: "600" } : null,
            s.italic ? { fontStyle: "italic" } : null,
            s.code ? { color: c.brandA } : null,
            s.link ? d.linkT : null,
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

// 链接浮窗：点击链接弹出，可复制 URL 或用系统浏览器打开（复制不便的核心痛点）
function LinkSheet({ url, onClose }: { url: string; onClose: () => void }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={d.linkScrim} onPress={onClose}>
        <Pressable style={d.linkCard} onPress={() => undefined}>
          <Text style={d.linkUrlT} selectable>{url}</Text>
          <View style={d.linkBtns}>
            <Pressable
              style={d.linkBtn}
              android_ripple={{ color: withA(c.dim, 0.2), borderless: false, radius: 10 }}
              onPress={() => {
                void Clipboard.setStringAsync(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={d.linkBtnT}>{copied ? "已复制 ✓" : "复制链接"}</Text>
            </Pressable>
            <Pressable
              style={[d.linkBtn, d.linkBtnPri]}
              android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false, radius: 10 }}
              onPress={() => void Linking.openURL(url).catch(() => undefined)}
            >
              <Text style={d.linkBtnPriT}>打开</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function MdText({ src, style }: { src: string; style?: TextStyle }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const blocks = useMemo(() => parseBlocks(src), [src]);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const openLink = setLinkUrl;
  return (
    <View style={d.wrap}>
      {linkUrl ? <LinkSheet url={linkUrl} onClose={() => setLinkUrl(null)} /> : null}
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h":
            return (
              <Text key={i} style={[d.base, { fontWeight: "700", fontSize: 14.5 - b.level * 0.5, marginTop: i ? 6 : 0 }]}>
                {b.text}
              </Text>
            );
          case "code":
            return (
              <View key={i} style={d.codeBlock}>
                <Text style={[d.base, d.codeBlockT]} selectable>{b.text}</Text>
              </View>
            );
          case "li":
            return (
              <View key={i} style={[d.li, { paddingLeft: 14 + b.depth * 14 }]}>
                <Text style={[d.base, { color: c.dim }]}>{b.ord ? `${b.ord}. ` : "• "}</Text>
                <View style={{ flex: 1 }}>
                  <InlineText text={b.text} onLink={openLink} />
                </View>
              </View>
            );
          case "quote":
            return (
              <View key={i} style={d.quote}>
                <InlineText text={b.text} onLink={openLink} />
              </View>
            );
          case "table": {
            const n = Math.max(1, b.head.length);
            const w: number[] = [];
            for (let j = 0; j < n; j++) {
              w[j] = Math.min(20, Math.max(4, b.head[j]?.length ?? 0, ...b.rows.map((r) => r[j]?.length ?? 0)));
            }
            return (
              <View key={i} style={d.table}>
                <View style={d.trHead}>
                  {b.head.map((cell, j) => (
                    <View key={j} style={[d.td, { flex: w[j] }]}>
                      <InlineText text={cell} small header onLink={openLink} />
                    </View>
                  ))}
                </View>
                {b.rows.map((r, ri) => (
                  <View key={ri} style={ri ? d.trSep : d.tr}>
                    {b.head.map((_, j) => (
                      <View key={j} style={[d.td, { flex: w[j] }]}>
                        <InlineText text={r[j] ?? ""} small onLink={openLink} />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          }
          case "hr":
            return <View key={i} style={d.hr} />;
          default:
            return <InlineText key={i} text={b.text} outer={style} onLink={openLink} />;
        }
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: { gap: 6 },
  base: { color: c.text, fontSize: 14, lineHeight: 21 },
  code: { fontFamily: "monospace", fontSize: 12.5, backgroundColor: withA(c.dim, 0.12), borderRadius: 3 },
  codeBlock: { backgroundColor: withA(c.dim, 0.08), borderRadius: 8, padding: 10 },
  codeBlockT: { fontFamily: "monospace", fontSize: 12, lineHeight: 17, color: c.text },
  li: { flexDirection: "row" },
  quote: { borderLeftWidth: 3, borderLeftColor: withA(c.brandA, 0.5), paddingLeft: 10 },
  cellT: { fontSize: 12.5, lineHeight: 18 },
  thT: { fontWeight: "600", color: c.dim },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: 8, overflow: "hidden" },
  trHead: { flexDirection: "row", backgroundColor: withA(c.dim, 0.1), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  tr: { flexDirection: "row" },
  trSep: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withA(c.line, 0.6) },
  td: { paddingHorizontal: 6, paddingVertical: 5, justifyContent: "center" },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 },
  linkT: { color: c.brandA, textDecorationLine: "underline" },
  linkScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 28 },
  linkCard: { width: "100%", maxWidth: 340, backgroundColor: c.panel, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 14 },
  linkUrlT: { color: c.dim, fontSize: 12.5, lineHeight: 18, fontFamily: "monospace" },
  linkBtns: { flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: 12 },
  linkBtn: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line, overflow: "hidden",
  },
  linkBtnPri: { backgroundColor: c.brandA, borderColor: "transparent" },
  linkBtnT: { color: c.dim, fontSize: 13, fontWeight: "600" },
  linkBtnPriT: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
