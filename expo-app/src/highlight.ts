// #141 代码块语法高亮共享 tokenizer（Typora 式着色，双端同构）：
// 本文件是事实源；web-console/index.html 内嵌的 synLangOf/synTokenize 是手工同步
// 副本（该处注释「移植自 expo-app/src/highlight.ts」）——改这里必须同步那边。
//
// 设计：纯函数、零依赖、处处可降级——
//   · synLangOf：fence 标注 → 语言族别名归一，未收录返回 null（渲染端降级纯文本）；
//   · synTokenize：返回 [s,e) 半开区间 token 列表（按起始位排序，相邻同类已合并）；
//     超长文本（>100KB）返回 null 防卡 UI；正文不落入任何规则的字符保持默认色；
//   · 配色：GitHub 风双主题色板（SYN_DARK/SYN_LIGHT）；add/del（diff 专用）不进
//     色板——两端渲染时映射主题已有的 done/waiting，与工具 diff 行同语言。
//
// 算法：每条规则用带 g 标志的正则对全文单趟 matchAll 收集候选，按（起始位, 规则
// 优先级）排序后从左到右吸收——被已消费区间覆盖的候选丢弃。规则顺序即同位优先级：
// 注释 → 字符串 → 标签/属性 → 关键字 → 数字（注释里的字符串、字符串里的关键字
// 天然不会被重复着色）。不用 sticky regex：Hermes/旧 WebView 兼容面更稳。

export type SynCls = "com" | "str" | "kw" | "num" | "tag" | "attr" | "add" | "del";
export interface SynTok {
  s: number;
  e: number;
  c: SynCls;
}

export type SynPalette = Record<Exclude<SynCls, "add" | "del">, string>;

// GitHub dark（码块底 ≈ #0A0F17 上对比充分）
export const SYN_DARK: SynPalette = {
  com: "#8B949E",
  kw: "#FF7B72",
  str: "#A5D6FF",
  num: "#79C0FF",
  tag: "#7EE787",
  attr: "#FFA657",
};

// GitHub light（浅色码块底 ≈ 近白）
export const SYN_LIGHT: SynPalette = {
  com: "#6E7781",
  kw: "#CF222E",
  str: "#0A3069",
  num: "#0550AE",
  tag: "#116329",
  attr: "#953800",
};

// 别名归一表：fence 标注（小写）→ 语言族；未收录 → null（降级纯文本）
const SYN_ALIAS: Record<string, string> = {
  xml: "xml", html: "xml", svg: "xml", vue: "xml", xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", axml: "xml",
  json: "json", jsonc: "json", json5: "json",
  py: "py", python: "py", python3: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh",
  sql: "sql", mysql: "sql", mariadb: "sql", plsql: "sql", psql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql",
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
  ts: "ts", typescript: "ts", tsx: "ts",
  css: "css", scss: "css", sass: "css", less: "css",
  yaml: "yaml", yml: "yaml",
  diff: "diff", patch: "diff",
  // clike 族：关键字并集（java/kotlin/swift/go/rust/c/cpp/cs/php/dart/scala…）
  java: "clike", kotlin: "clike", kt: "clike", swift: "clike", objectivec: "clike", objc: "clike",
  go: "clike", golang: "clike", rust: "clike", rs: "clike",
  c: "clike", cpp: "clike", "c++": "clike", cc: "clike", cxx: "clike", h: "clike", hpp: "clike", hh: "clike",
  cs: "clike", csharp: "clike", php: "clike", dart: "clike", scala: "clike",
};

export function synLangOf(tag: string): string | null {
  const k = (tag || "").trim().toLowerCase();
  return k && Object.prototype.hasOwnProperty.call(SYN_ALIAS, k) ? SYN_ALIAS[k] : null;
}

// —— 规则正则（与 web-console 内嵌副本逐字同步）——
const kwRe = (words: string, ci = false): RegExp =>
  new RegExp("\\b(?:" + words + ")\\b", ci ? "gi" : "g");

const SQL_KW =
  "select|from|where|insert|into|values|update|set|delete|create|drop|alter|rename|truncate|table|database|schema|view|index|key|join|left|right|full|inner|outer|cross|natural|straight_join|on|using|as|and|or|not|in|is|null|like|ilike|rlike|regexp|between|exists|union|all|distinct|case|when|then|else|end|primary|foreign|references|constraint|unique|check|default|auto_increment|on duplicate|engine|charset|character|collate|if|begin|commit|rollback|transaction|trigger|procedure|function|declare|return|call|grant|revoke|partition|over|window|order|group|by|having|limit|offset|asc|desc|with|recursive|interval|day|hour|minute|month|year|now|current_timestamp|count|sum|avg|min|max|cast|convert|dual";

const JS_KW =
  "var|let|const|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|as|null|undefined|true|false|void|delete|static|get|set";
const TS_KW = JS_KW +
  "|interface|type|enum|implements|private|public|protected|readonly|namespace|declare|abstract|keyof|infer|satisfies|is|string|number|boolean|any|unknown|never|symbol|bigint";

const PY_KW =
  "def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self|cls";

const SH_KW =
  "if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|local|export|source|alias|shift|read|declare|unset|set|trap|exec|eval|echo|printf|cd|pushd|popd|sudo";

const CLIKE_KW =
  "abstract|alias|and|as|assert|async|await|base|bool|boolean|break|byte|case|catch|chan|char|class|const|constructor|continue|crate|data|defer|default|delegate|delete|do|double|dyn|else|enum|event|explicit|extern|false|final|finally|fn|for|foreach|func|function|get|go|goto|if|impl|implements|import|in|include|init|inline|instanceof|int|interface|internal|is|let|lock|long|match|mod|module|mut|namespace|new|nil|null|nullptr|object|operator|or|override|package|private|protected|pub|public|raise|readonly|ref|register|require|return|sealed|self|set|short|signed|sizeof|static|str|string|struct|super|switch|synchronized|template|this|throw|throws|trait|transient|true|try|type|typedef|typename|typeof|union|unsafe|unsigned|use|using|val|var|virtual|void|volatile|when|where|while|with|yield";

interface SynRule {
  c: SynCls;
  re: RegExp;
}

const SYN_RULES: Record<string, SynRule[]> = {
  xml: [
    { c: "com", re: /<!--[\s\S]*?-->/g },
    { c: "tag", re: /<(?:\?[\w.:-]+|![A-Z][\w.:-]*|\/?[\w.:-]+)/g },
    { c: "attr", re: /[\w.:-]+(?==)/g },
    { c: "str", re: /"[^"]*"|'[^']*'/g },
  ],
  sql: [
    { c: "com", re: /--[^\n]*|\/\*[\s\S]*?\*\//g },
    { c: "str", re: /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|`[^`\n]*`/g },
    { c: "kw", re: kwRe(SQL_KW, true) },
    { c: "num", re: /\b\d+(?:\.\d+)?\b/g },
  ],
  js: [
    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
    { c: "str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
    { c: "kw", re: kwRe(JS_KW) },
    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
  ],
  ts: [
    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
    { c: "str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
    { c: "kw", re: kwRe(TS_KW) },
    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
  ],
  json: [
    { c: "attr", re: /"(?:[^"\\]|\\.)*"(?=\s*:)/g },
    { c: "str", re: /"(?:[^"\\]|\\.)*"/g },
    { c: "kw", re: /\b(?:true|false|null)\b/g },
    { c: "num", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
  ],
  py: [
    { c: "com", re: /#[^\n]*/g },
    { c: "str", re: /[rRfFbB]{0,2}(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g },
    { c: "kw", re: kwRe(PY_KW) },
    { c: "num", re: /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/g },
  ],
  sh: [
    // # 前须空白/行首（${#x} 长度语法不误伤）；前导空白计入 token（着色不可见）
    { c: "com", re: /(?:^|\s)#[^\n]*/g },
    { c: "str", re: /"(?:[^"\\]|\\.)*"|'[^']*'/g },
    { c: "kw", re: kwRe(SH_KW) },
    { c: "attr", re: /\$\{[^}\n]*\}|\$[\w@#?*!-]+/g },
    { c: "num", re: /\b\d+\b/g },
  ],
  clike: [
    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
    { c: "str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)'|`(?:[^`\\]|\\.)*`/g },
    // Rust 属性 #[derive(...)] / C# 特性 [Attr] 前者是 #，后者无前缀难辨只收 # 形
    { c: "attr", re: /#\[[^\]\n]*\]|@\w+|#\w+(?=[^\w(])/g },
    { c: "kw", re: kwRe(CLIKE_KW) },
    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]{0,3}\b/g },
  ],
  css: [
    { c: "com", re: /\/\*[\s\S]*?\*\//g },
    { c: "str", re: /"[^"\n]*"|'[^'\n]*'/g },
    { c: "kw", re: /@[\w-]+|!important\b/g },
    // 选择器：类/ID/伪类伪元素着 tag 色（元素选择器无状态难辨，保持默认）
    { c: "tag", re: /[.#][\w-]+|::?[\w-]+(?=[\s,{):>+~[])/g },
    { c: "attr", re: /[-a-zA-Z]+(?=[ \t]*:)/g },
    { c: "num", re: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|s|ms|fr|deg|ch|pt|%)?/g },
  ],
  yaml: [
    { c: "com", re: /(?:^|\s)#[^\n]*/g },
    // 行首键（含列表 - 前缀）：前导空白/横杠计入 token（着色不可见）
    { c: "attr", re: /^[ \t]*(?:- )?[ \t]*[\w.$-]+(?=[ \t]*:)/gm },
    { c: "str", re: /"(?:[^"\\]|\\.)*"|'[^']*'/g },
    { c: "kw", re: /\b(?:true|false|null|yes|no|on|off)\b/g },
    { c: "num", re: /\b\d+(?:\.\d+)?\b/g },
  ],
  diff: [
    { c: "add", re: /^\+[^\n]*/gm },
    { c: "del", re: /^-[^\n]*/gm },
    { c: "kw", re: /^@@[^\n]*/gm },
    { c: "attr", re: /^(?:diff |index |new file mode|deleted file mode|rename )/gim },
  ],
};

const SYN_MAX_BYTES = 100_000;

export function synTokenize(code: string, fam: string): SynTok[] | null {
  if (!code || code.length > SYN_MAX_BYTES) return null;
  const rules = SYN_RULES[fam];
  if (!rules) return null;
  // 各规则全文单趟收集候选：{s, e, 优先级}
  const cands: { s: number; e: number; c: SynCls; r: number }[] = [];
  for (let r = 0; r < rules.length; r++) {
    for (const m of code.matchAll(rules[r].re)) {
      if (m[0]) cands.push({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length, c: rules[r].c, r });
    }
  }
  cands.sort((a, b) => a.s - b.s || a.r - b.r);
  const toks: SynTok[] = [];
  let pos = 0;
  for (const t of cands) {
    if (t.s < pos) continue; // 落在已消费区间内：丢弃
    const last = toks[toks.length - 1];
    if (last && last.c === t.c && last.e === t.s) last.e = t.e; // 相邻同类合并
    else toks.push({ s: t.s, e: t.e, c: t.c });
    pos = t.e;
  }
  return toks;
}
