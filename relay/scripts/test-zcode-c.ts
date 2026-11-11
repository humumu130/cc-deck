// W-ZCODE-C（t-4107837d，1111 拍板 C）：zcode 引擎菜单产品化标注——纯 fs 断言件。
// 三端同源纪律：ZCODE_NOTE 常量三副本逐字节一致（web 两文件+expo）——防口径漂移
//（AUTO_MSG_PREFIXES 双端副本同惯例；本件把「同步」升格为断言）。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (p: string) => join(root, p);
let pass = 0, fail = 0;
function ok(cond: boolean, name: string, detail = "") {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "——" + detail : ""}`); }
}

console.log("# zcode-c：引擎菜单产品化标注（拍板 C）");

const sd = readFileSync(rel("web-console/js/session-domain.js"), "utf-8");
const st = readFileSync(rel("web-console/js/settings-domain.js"), "utf-8");
const nm = readFileSync(rel("expo-app/src/screens/NewSessionModal.tsx"), "utf-8");

// ---------- ① 常量三副本逐字节同源 ----------
const NOTE_RE = /ZCODE_NOTE = "([^"]+)"/g;
const notes: string[] = [];
for (const src of [sd, st, nm]) {
  const m = [...src.matchAll(NOTE_RE)].map((x) => x[1]);
  if (m.length) notes.push(...m);
}
ok(notes.length === 3, `ZCODE_NOTE 三副本齐（实得 ${notes.length}）`);
ok(new Set(notes).size === 1, "三副本逐字节同源（防口径漂移）", notes.length ? notes[0].slice(0, 40) : "");
ok(notes[0]?.includes("无官方 npm 分发") && notes[0]?.includes("zai-org/ZCode") && notes[0]?.includes("供应链审计") && notes[0]?.includes("claude 别名桥接"), "口径四要素：无官方分发/开源仓/社区包审计/桥接指引");

// ---------- ② web 引擎菜单（session-domain） ----------
ok(sd.includes('if (e.id === "zcode"') && sd.includes('return "未接入 · 无官方分发";'), "菜单短标升产品短句（engineStateText zcode 特判）");
ok(sd.includes('if (e.id === "zcode") return ZCODE_NOTE;'), "完整口径入 title 查询口（engineStateHint 特判——替代「枚举占位」运维原文）");
ok(sd.includes("官方 npm 分发出现时复评"), "复评触发器备案（文案内）");

// ---------- ③ web 设置引擎行（settings-domain） ----------
ok(st.includes('e.id === "zcode" ? "未接入 · 无官方分发"'), "引擎行 copy 特判（与菜单同口径）");
ok(st.includes('${!ok && !na && e.id === "zcode" ? " · " + ZCODE_NOTE : ""}') || st.includes('!ok && !na && e.id === "zcode"'), "引擎行 rowTitle 拼 ZCODE_NOTE（悬停全量）");

// ---------- ④ expo 引擎列表（NewSessionModal） ----------
ok(nm.includes('const isZcodeBlocked = e.id === "zcode" && !!block && !loginRow;'), "zcode 灰置行特判位");
ok(nm.includes('"无官方 npm 分发 · 开源可自装（见桌面端说明）"'), "副文案短句（capsText 位）");
ok(nm.includes("isZcodeBlocked ? `，${ZCODE_NOTE}`"), "a11y label 带完整口径（读屏可得）");
ok(/: block && !loginRow\s*\n\s*\? null/.test(nm) || nm.includes("block && !loginRow\n                      ? null"), "顺刀泛化：不可选行不显示能力短语（旧 capsText 给 unsupported 落「基础执行」误导）");

// ---------- ⑤ 现状不回归（disabled 骨架双端仍在） ----------
ok(st.includes('e.state === "unsupported" ? \'<span class="tag">未接入</span>\''), "设置行 unsupported tag 保持（其他 unsupported 引擎口径不变）");
ok(sd.includes('aria-disabled="true" role="text"'), "菜单不可用行 disabled 骨架保持（div 非 button）");
ok(nm.includes("disabled={!!block && !loginRow}"), "expo 行 disabled 骨架保持");

console.log(`\n== test-zcode-c：${pass} passed / ${fail} failed ==`);
if (fail > 0) process.exit(1);
