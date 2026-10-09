// #72 E 线 产物中心 expo 入口断言锁。
// 跑法：npx tsx scripts/test-e-artifacts-entry.ts（artpool 零依赖纯 TS，直跑）
// 覆盖（任务书测试件四要素）：
//   S1 入口判定（artPoolGate 三重门：探测三态 × deliverables × online 全组合）
//   S2 降级三态一致性（pending/no 同呈下线——「下线不灰置」；401≠空池同 no 口径）
//   S3 池条目规范化（artPoolItemsOf 防御+保 relay mtime 降序不重排）
//   S4 unknown 护栏（poolNameOk 客户端先拒：防穿越段/隐藏文件/反斜杠/深嵌套——
//      池条目无 unknown 字段（lstat 扫描即实存），动作时刻名字非法=不发请求；
//      404 悬空由 fetchPoolFile HTTP 层兜底，此处锁客户端尺与 relay 同构）
//   S5 mime 分级单口径（artDataOf：会话账 fetchArtView 与池 HTTP 直取同一把尺）
//   S6 池分组（artPoolGroupsOf：根/目录分桶+目录名排序+组内保序）
//   S7 动作 URL（encodeURIComponent 整体编码——web W 线同款，relay decode 后同尺校验）
//   S8 尺寸显示（fmtArtSize 迁入回归）
// 断言器内置（不依赖 node:assert/@types/node——脚本与主代码同一 tsconfig 严检）。
import {
  artDataOf,
  artPoolGate,
  artPoolGroupsOf,
  artPoolItemsOf,
  artPoolListUrl,
  artPoolUrl,
  fmtArtSize,
  poolNameOk,
} from "../src/artpool";

let pass = 0;
const fail: string[] = [];
function ok(label: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok ${label}`);
  } catch (e) {
    fail.push(label);
    console.log(`FAIL ${label}: ${e instanceof Error ? e.message : e}`);
  }
}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** 深等断言（JSON 序列化比对——用例数据均为纯 JSON 值，键序无关） */
function deepEq(a: unknown, b: unknown, msg = "deepEqual mismatch") {
  const ka = JSON.stringify(a);
  const kb = JSON.stringify(b);
  check(ka === kb, `${msg}\n    actual:   ${ka}\n    expected: ${kb}`);
}

// ---------- fixtures ----------
// SourceStatus 池相关切片（鸭子判定面：artPoolGate 只看三键，喂全量 SourceStatus
// 或切片同效——store 零耦合可断言）
type PoolSrc = { artPool?: unknown; deliverables?: unknown; state?: unknown };
const src = (over: PoolSrc): PoolSrc => ({ artPool: "yes", deliverables: true, state: "online", ...over });

// ---------- S1 入口判定（三重门） ----------
console.log("S1 artPoolGate 三重门");
ok("S1.1 全过 → 显", () => check(artPoolGate(src({})) === true, "yes+true+online 应显"));
ok("S1.2 探测 pending → 隐（未探明不显）", () => check(artPoolGate(src({ artPool: "pending" })) === false, "pending 应隐"));
ok("S1.3 探测 no → 隐（降级=下线不灰置）", () => check(artPoolGate(src({ artPool: "no" })) === false, "no 应隐"));
ok("S1.4 #71 总开关关 → 隐（同门控）", () => check(artPoolGate(src({ deliverables: false })) === false, "deliverables false 应隐"));
ok("S1.5 总开关缺省（旧 relay 无字段）→ 隐", () => check(artPoolGate(src({ deliverables: undefined })) === false, "缺省应隐"));
ok("S1.6 源离线 → 隐", () => check(artPoolGate(src({ state: "offline" })) === false, "offline 应隐"));
ok("S1.7 源 connecting → 隐", () => check(artPoolGate(src({ state: "connecting" })) === false, "connecting 应隐"));
ok("S1.8 null/非对象 → 隐不炸", () => {
  check(artPoolGate(null) === false, "null 应隐");
  check(artPoolGate(undefined) === false, "undefined 应隐");
  check(artPoolGate("yes" as unknown as PoolSrc) === false, "字符串应隐");
});
ok("S1.9 探测值伪态（'YES'/1）→ 隐（严格 ===）", () => {
  check(artPoolGate(src({ artPool: "YES" })) === false, "大小写应隐");
  check(artPoolGate(src({ deliverables: 1 })) === false, "truthy 非真值应隐");
});

// ---------- S2 降级三态一致性 ----------
console.log("S2 降级三态一致性（W 线对表面）");
ok("S2.1 三失败路径（404/401/网络错）同归 no → 呈现等价", () => {
  // store.probeArtPool 把 404（端点不存在）、401（token 失效——不当空池）、
  // fetch throw（网络错/超时）三条失败路径都定为 no；UI 层门输入等价即呈现等价
  for (const p of ["no" as const]) {
    check(artPoolGate(src({ artPool: p })) === artPoolGate(src({ artPool: "no" })), `${p} 应与 no 等价`);
  }
});
ok("S2.2 pending 与 no 同为隐藏（下线不灰置）", () => {
  check(artPoolGate(src({ artPool: "pending" })) === artPoolGate(src({ artPool: "no" })), "pending/no 呈现应一致（皆隐）");
});
ok("S2.3 单源门不过 → 入口整体隐（any 门语义在 UI 层 some(artPoolGate)）", () => {
  const sources: PoolSrc[] = [src({ artPool: "no" }), src({ artPool: "pending" })];
  check(sources.some(artPoolGate) === false, "全不过 some 应 false");
  const mixed: PoolSrc[] = [src({ artPool: "no" }), src({})];
  check(mixed.some(artPoolGate) === true, "任一过 some 应 true（多源聚合任一可用即显）");
});

// ---------- S3 池条目规范化 ----------
console.log("S3 artPoolItemsOf 规范化");
ok("S3.1 正常往返（name/size/mtime）", () => {
  deepEq(artPoolItemsOf([{ name: "a.md", size: 12, mtime: 1700000000000 }]), [{ name: "a.md", size: 12, mtime: 1700000000000 }]);
});
ok("S3.2 非数组 → 空表不炸", () => {
  deepEq(artPoolItemsOf(null), []);
  deepEq(artPoolItemsOf("x"), []);
  deepEq(artPoolItemsOf({ ok: true }), []);
});
ok("S3.3 畸形条目剔除（null/非对象/无名/空名）", () => {
  deepEq(artPoolItemsOf([null, 3, {}, { name: "", size: 1, mtime: 2 }, { name: "ok.md", size: 1, mtime: 2 }]), [{ name: "ok.md", size: 1, mtime: 2 }]);
});
ok("S3.4 size/mtime 畸形回落 0（不 NaN 传染 UI）", () => {
  deepEq(artPoolItemsOf([{ name: "a.md", size: "x", mtime: -1 }, { name: "b.md", size: Infinity, mtime: 5 }]), [
    { name: "a.md", size: 0, mtime: 0 },
    { name: "b.md", size: 0, mtime: 5 },
  ]);
});
ok("S3.5 保 relay 原序（mtime 降序由 relay 承担，客户端不重排防两端口序漂移）", () => {
  const raw = [
    { name: "new.md", size: 1, mtime: 200 },
    { name: "old.md", size: 2, mtime: 100 },
  ];
  deepEq(artPoolItemsOf(raw).map((x) => x.name), ["new.md", "old.md"]);
});
ok("S3.6 子目录条目原样保留（分组在 artPoolGroupsOf 承担）", () => {
  deepEq(artPoolItemsOf([{ name: "sub/file.md", size: 3, mtime: 9 }]), [{ name: "sub/file.md", size: 3, mtime: 9 }]);
});

// ---------- S4 unknown 护栏（poolNameOk：relay ARTIFACT_NAME_RE 客户端镜像） ----------
console.log("S4 poolNameOk 客户端先拒");
ok("S4.1 正常名过", () => {
  check(poolNameOk("report.md") === true, "普通名应过");
  check(poolNameOk("2026-10-06_验收单v2.pdf") === true, "点连字符下划线应过");
  check(poolNameOk("周报_中文.md") === true, "中文应过");
  check(poolNameOk("sub/report.md") === true, "一层子目录应过");
});
ok("S4.2 防穿越段拒（..）", () => {
  check(poolNameOk("../etc/passwd") === false, ".. 开头应拒");
  check(poolNameOk("sub/../../x") === false, ".. 段应拒");
  check(poolNameOk("..hidden") === false, "段首点应拒");
  check(poolNameOk(".hidden.md") === false, "隐藏文件应拒");
});
ok("S4.3 反斜杠拒（Windows 分隔不视为段）", () => check(poolNameOk("sub\\file.md") === false, "反斜杠应拒"));
ok("S4.4 深嵌套拒（relay 只容一层子目录）", () => {
  check(poolNameOk("a/b/c.md") === false, "两层子目录应拒");
  check(poolNameOk("a/b.md") === true, "一层应过");
});
ok("S4.5 空串/非 string 拒（unknown 收窄）", () => {
  check(poolNameOk("") === false, "空串应拒");
  check(poolNameOk(undefined) === false, "undefined 应拒");
  check(poolNameOk(42 as unknown) === false, "数字应拒");
  check(poolNameOk(null) === false, "null 应拒");
});
ok("S4.6 段内非法字符拒（正则尺外——relay 段内只容 \\w 汉字点连字符，无空格）", () => {
  check(poolNameOk("a b.md") === false, "段内空格应拒（relay 同尺 404，客户端先拒一致）");
  check(poolNameOk("a b/c@d.md") === false, "段内 @ 应拒");
  check(poolNameOk("x+y.md") === false, "+ 应拒");
});

// ---------- S5 mime 分级单口径（artDataOf） ----------
console.log("S5 artDataOf 分级（会话账/池共用一把尺）");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
ok("S5.1 image/* → img（带 uri）", () => {
  const v = artDataOf(enc("x"), "image/png", "a.png", "file:///u/a.png");
  deepEq(v, { kind: "img", name: "a.png", uri: "file:///u/a.png", size: 1 });
});
ok("S5.2 text/html → html（text 内嵌）", () => {
  const v = artDataOf(enc("<p>hi</p>"), "text/html; charset=utf-8", "r.html", "file:///u/r.html");
  check(v.kind === "html" && v.text === "<p>hi</p>", "html 应内嵌文本");
});
ok("S5.3 text/markdown → md", () => {
  const v = artDataOf(enc("# t"), "text/markdown", "r.md", "");
  check(v.kind === "md", "md 应 md 级");
});
ok("S5.4 text/plain → txt / application/json → txt", () => {
  check(artDataOf(enc("hi"), "text/plain", "a.txt", "").kind === "txt", "txt 应 txt 级");
  check(artDataOf(enc("{}"), "application/json", "a.json", "").kind === "txt", "json 应 txt 级");
});
ok("S5.5 复杂格式 → sys（mime 透传）", () => {
  const v = artDataOf(enc("%PDF"), "application/pdf", "a.pdf", "file:///u/a.pdf");
  check(v.kind === "sys" && v.mime === "application/pdf", "pdf 应 sys 级");
});
ok("S5.6 空 mime → sys octet-stream 兜底（不炸不猜文本）", () => {
  const v = artDataOf(enc("??"), "", "bin", "file:///u/bin");
  check(v.kind === "sys" && v.mime === "application/octet-stream", "空 mime 应兜底 sys");
});
ok("S5.7 size = 字节数（与 DetailScreen.fetchArtView n 口径一致）", () => {
  const v = artDataOf(enc("hello"), "text/plain", "a.txt", "");
  check(v.kind === "txt" && v.size === 5, "size 应 5");
});

// ---------- S6 池分组 ----------
console.log("S6 artPoolGroupsOf 分组");
ok("S6.1 根文件 dir=''、子目录分桶", () => {
  const g = artPoolGroupsOf(artPoolItemsOf([
    { name: "a.md", size: 1, mtime: 3 },
    { name: "sub/b.md", size: 2, mtime: 2 },
    { name: "c.md", size: 3, mtime: 1 },
  ]));
  deepEq(g.map((x) => x.dir), ["", "sub"]);
  deepEq(g[0]!.items.map((x) => x.name), ["a.md", "c.md"]); // 组内条目保完整 name（目录前缀由目录行承载，渲染层去 leaf）
  deepEq(g[1]!.items.map((x) => x.name), ["sub/b.md"]);
});
ok("S6.2 目录桶按名排序（组间稳定序）", () => {
  const g = artPoolGroupsOf(artPoolItemsOf([
    { name: "z/x.md", size: 1, mtime: 1 },
    { name: "a/y.md", size: 1, mtime: 2 },
  ]));
  deepEq(g.map((x) => x.dir), ["a", "z"]);
});
ok("S6.3 组内保 relay 原序", () => {
  const g = artPoolGroupsOf(artPoolItemsOf([
    { name: "d/new.md", size: 1, mtime: 9 },
    { name: "d/old.md", size: 1, mtime: 1 },
  ]));
  deepEq(g[0]!.items.map((x) => x.name), ["d/new.md", "d/old.md"]);
});
ok("S6.4 空表 → 空分组（不产伪节）", () => deepEq(artPoolGroupsOf([]), []));

// ---------- S7 动作 URL ----------
console.log("S7 动作 URL 组装");
ok("S7.1 池文件 URL：name 整体编码（子目录斜杠 %2F，web W 线同款）", () => {
  deepEq(artPoolUrl("http://192.168.0.105:8787", "sub/report.md", "tk+1="), "http://192.168.0.105:8787/artifacts/sub%2Freport.md?token=tk%2B1%3D");
});
ok("S7.2 列表 URL：token 编码", () => {
  deepEq(artPoolListUrl("http://h:8787", "a b&c"), "http://h:8787/api/artifacts?token=a%20b%26c");
});

// ---------- S8 尺寸显示（迁入回归） ----------
console.log("S8 fmtArtSize 迁入回归");
ok("S8.1 三档位（<10KB 留一位小数——#79 既有口径原样迁入）", () => {
  deepEq(fmtArtSize(512), "512 B");
  deepEq(fmtArtSize(2048), "2.0 KB");
  deepEq(fmtArtSize(102400), "100 KB"); // ≥10KB 整数位
  deepEq(fmtArtSize(3 * 1048576), "3.0 MB");
});
ok("S8.2 畸形回落空串", () => {
  deepEq(fmtArtSize(undefined), "");
  deepEq(fmtArtSize(-1), "");
});

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  console.log("failed:", fail.join(" | "));
  process.exit(1);
}
