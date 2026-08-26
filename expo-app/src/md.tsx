// 轻量 Markdown 渲染（时间线 assistant 文本用）：
// 覆盖标题/粗斜体/行内码/围栏码块/无序有序列表/引用/分割线/链接标题，零依赖子集实现，
// 截断产生的残缺标记按字面渲染（解析器对不匹配标记容错）。
import { useMemo } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import { withA, type ThemeColors } from "./theme";
import { useTheme, useThemeStyles } from "./theme-context";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; text: string }
  | { t: "li"; text: string; depth: number; ord?: string }
  | { t: "quote"; text: string }
  | { t: "hr" };

function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split(/\r?\n/);
  let para: string[] = [];
  let inCode = false;
  let code: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push({ t: "p", text: para.join("\n") });
      para = [];
    }
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
  flush();
  return out;
}

type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

// 行内标记：**粗** / *斜* / __粗__ / _斜_ / `码` / [标题](url → 只渲染标题)
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g;

function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0];
    const i = m.index ?? 0;
    if (i > last) spans.push({ text: text.slice(last, i) });
    if (tok.startsWith("**") || tok.startsWith("__")) spans.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) spans.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("[")) spans.push({ text: /^\[([^\]]+)\]/.exec(tok)?.[1] ?? tok, bold: true });
    else spans.push({ text: tok.slice(1, -1), italic: true });
    last = i + tok.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

function InlineText({ text }: { text: string }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  return (
    <Text style={d.base}>
      {parseInline(text).map((s, i) => (
        <Text
          key={i}
          style={[
            s.code ? d.code : null,
            s.bold ? { fontWeight: "600" } : null,
            s.italic ? { fontStyle: "italic" } : null,
            s.code ? { color: c.brandA } : null,
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function MdText({ src, style }: { src: string; style?: TextStyle }) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const blocks = useMemo(() => parseBlocks(src), [src]);
  return (
    <View style={d.wrap}>
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
                  <InlineText text={b.text} />
                </View>
              </View>
            );
          case "quote":
            return (
              <View key={i} style={d.quote}>
                <InlineText text={b.text} />
              </View>
            );
          case "hr":
            return <View key={i} style={d.hr} />;
          default:
            return (
              <Text key={i} style={[d.base, style]}>
                {parseInline(b.text).map((s, j) => (
                  <Text
                    key={j}
                    style={[
                      s.code ? d.code : null,
                      s.bold ? { fontWeight: "600" } : null,
                      s.italic ? { fontStyle: "italic" } : null,
                      s.code ? { color: c.brandA } : null,
                    ]}
                  >
                    {s.text}
                  </Text>
                ))}
              </Text>
            );
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
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 },
});
